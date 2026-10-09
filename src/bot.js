import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Client, StageChannel } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { checkPassthrough } from "./probe.js";
import { makeEncoder } from "./encoders.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".ts", ".flv", ".wmv"]);

const configPath = new URL("../config.json", import.meta.url);
const config = {
  prefix: "!",
  allowedUsers: [],
  mediaDir: "",
  restrictToMediaDir: false,
  encoder: "v4l2m2m",
  hardwareDecoding: true,
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 3000,
  maxBitrateKbps: 4500,
  audioBitrateKbps: 128,
  leaveWhenDone: false,
  ffprobePath: "ffprobe",
  ...JSON.parse(await readFile(configPath, "utf8")),
};

const encoder = makeEncoder(config);
const streamer = new Streamer(new Client());

// State of whatever is currently playing.
let current = null; // { file, controller, volume, startedAt, duration, passthrough }

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "?";
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// Accepts paths typed the way a shell would want them: wrapped in quotes,
// quoted per folder ('a b'/'c d.mkv'), or with backslash-escaped spaces.
// Tries the literal text first so names containing real quotes still work.
async function unquotePath(input, base) {
  const raw = input.trim();
  const candidates = [
    raw.replace(/^(["'])(.*)\1$/, "$2"),
    raw.replace(/(^|\/)(["'])(.*?)\2(?=\/|$)/g, "$1$3").replace(/\\(.)/g, "$1"),
    raw.replace(/["']/g, "").replace(/\\(.)/g, "$1"),
  ];
  for (const c of candidates) {
    if (await isFile(path.resolve(base, c))) return c;
  }
  return candidates[1];
}

// Turns what the user typed into an absolute path, or throws a friendly error.
async function resolveMedia(input) {
  if (!input.trim()) throw new Error("Give me a file path, e.g. `" + config.prefix + "play movie.mp4`");
  const base = config.mediaDir || process.cwd();
  const full = path.resolve(base, await unquotePath(input, base));
  if (config.restrictToMediaDir && config.mediaDir) {
    const rel = path.relative(path.resolve(config.mediaDir), full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("That file is outside the media folder.");
    }
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new Error(`File not found: \`${full}\``);
  }
  if (!info.isFile()) throw new Error(`Not a file: \`${full}\``);
  return full;
}

// Finds the voice channel the user is in, across every server the account is in.
// This means commands also work from DMs.
function findUserVoiceChannel(msg) {
  const direct = msg.member?.voice?.channel;
  if (direct) return direct;
  for (const guild of streamer.client.guilds.cache.values()) {
    const state = guild.voiceStates.cache.get(msg.author.id);
    if (state?.channel) return state.channel;
  }
  return null;
}

function stopCurrent() {
  if (!current) return false;
  current.controller.abort();
  current = null;
  return true;
}

async function play(msg, input) {
  const file = await resolveMedia(input);
  const channel = findUserVoiceChannel(msg);
  if (!channel) throw new Error("Join a voice channel first, then run the command again.");

  // Cheap check (no decoding) for whether the file can be sent without re-encoding.
  let passthrough = false;
  let duration = 0;
  try {
    const check = await checkPassthrough(file, config);
    passthrough = check.ok;
    duration = check.info?.duration ?? 0;
    log(passthrough ? "passthrough:" : `transcoding (${check.reason}):`, file);
  } catch (err) {
    log("ffprobe failed, falling back to transcoding:", err.message);
  }

  stopCurrent();

  if (streamer.voiceConnection?.channelId !== channel.id) {
    log(`joining ${channel.guild.name} / ${channel.name}`);
    await streamer.joinVoice(channel.guild.id, channel.id);
    if (channel instanceof StageChannel) {
      await streamer.client.user.voice.setSuppressed(false);
    }
  }

  const controller = new AbortController();
  const { command, output, controller: audio } = prepareStream(file, {
    noTranscoding: passthrough,
    encoder,
    width: config.width,
    height: config.height,
    frameRate: config.fps,
    bitrateVideo: config.bitrateKbps,
    bitrateVideoMax: config.maxBitrateKbps,
    bitrateAudio: config.audioBitrateKbps,
    hardwareAcceleratedDecoding: !passthrough && config.hardwareDecoding,
    videoCodec: Utils.normalizeVideoCodec("H264"),
    logLevel: "error",
  }, controller.signal);

  command.on("error", (err) => {
    if (!controller.signal.aborted) log("ffmpeg error:", err.message);
  });

  const entry = { file, controller, audio, startedAt: Date.now(), duration, passthrough };
  current = entry;

  const mode = passthrough ? "direct, no re-encode" : `re-encoding with ${config.encoder}`;
  await msg.reply(`▶️ Streaming **${path.basename(file)}** (${formatTime(duration)}, ${mode})`).catch(() => {});

  playStream(output, streamer, { type: "go-live" }, controller.signal)
    .then(async () => {
      if (current !== entry) return;
      current = null;
      log("finished:", file);
      await msg.channel.send(`⏹️ Finished **${path.basename(file)}**`).catch(() => {});
      if (config.leaveWhenDone) streamer.leaveVoice();
    })
    .catch((err) => {
      if (controller.signal.aborted) return; // stopped on purpose
      log("stream error:", err?.message ?? err);
      if (current === entry) current = null;
      controller.abort();
      msg.channel.send(`⚠️ Stream failed: ${err?.message ?? err}`).catch(() => {});
    });
}

async function listMedia(sub = "") {
  if (!config.mediaDir) return "No `mediaDir` is set in config.json.";
  const dir = path.resolve(config.mediaDir, sub.trim());
  const entries = await readdir(dir, { withFileTypes: true });
  const lines = entries
    .filter((e) => e.isDirectory() || VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `🎞️ ${e.name}`));
  if (!lines.length) return "No videos found there.";
  // Discord messages cap at 2000 characters.
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 20 > 1900) {
      out += `…and ${lines.length - out.split("\n").length + 1} more`;
      break;
    }
    out += line + "\n";
  }
  return "```\n" + out + "```";
}

const HELP = (p) => [
  "**Commands**",
  `\`${p}play <path>\` – stream a video into your voice channel (path can be relative to the media folder)`,
  `\`${p}stop\` – stop the video but stay in the call`,
  `\`${p}leave\` – stop and leave the call`,
  `\`${p}now\` – what's playing`,
  `\`${p}volume <0-200>\` – change stream volume (100 = normal)`,
  `\`${p}list [folder]\` – list videos in the media folder`,
].join("\n");

const COMMANDS = new Set(["play", "stop", "leave", "now", "volume", "list", "help"]);

streamer.client.on("ready", () => {
  log(`logged in as ${streamer.client.user.tag}`);
  log(`listening for "${config.prefix}" commands from: ${config.allowedUsers.join(", ") || "(nobody: allowedUsers is empty)"}`);
});

streamer.client.on("messageCreate", async (msg) => {
  if (!msg.content?.startsWith(config.prefix)) return;

  const body = msg.content.slice(config.prefix.length);
  const [name] = body.split(/\s+/, 1);
  const args = body.slice(name.length).trim();
  if (!COMMANDS.has(name.toLowerCase())) return;

  if (!config.allowedUsers.includes(msg.author.id)) {
    log(`ignored "${config.prefix}${name}" from ${msg.author.tag} (${msg.author.id}): not in allowedUsers`);
    return;
  }
  log(`command from ${msg.author.tag}: ${msg.content}`);

  try {
    switch (name.toLowerCase()) {
      case "play":
        await play(msg, args);
        break;
      case "stop":
        await msg.reply(stopCurrent() ? "⏹️ Stopped." : "Nothing is playing.");
        break;
      case "leave":
        stopCurrent();
        streamer.leaveVoice();
        await msg.reply("👋 Left the call.");
        break;
      case "now": {
        if (!current) {
          await msg.reply("Nothing is playing.");
          break;
        }
        const elapsed = (Date.now() - current.startedAt) / 1000;
        await msg.reply(
          `▶️ **${path.basename(current.file)}** – ${formatTime(elapsed)} / ${formatTime(current.duration)}` +
            (current.passthrough ? " (direct)" : ` (re-encoding with ${config.encoder})`),
        );
        break;
      }
      case "volume": {
        if (!current) {
          await msg.reply("Nothing is playing.");
          break;
        }
        const pct = Number(args);
        if (!Number.isFinite(pct) || pct < 0 || pct > 200) {
          await msg.reply(`Volume is ${Math.round(current.audio.volume * 100)}. Use a number from 0 to 200.`);
          break;
        }
        await current.audio.setVolume(pct / 100);
        await msg.reply(`🔊 Volume set to ${pct}.`);
        break;
      }
      case "list":
        await msg.reply(await listMedia(args));
        break;
      case "help":
        await msg.reply(HELP(config.prefix));
        break;
    }
  } catch (err) {
    log(`command "${name}" failed:`, err.message);
    await msg.reply(`⚠️ ${err.message}`).catch(() => {});
  }
});

function shutdown() {
  log("shutting down");
  stopCurrent();
  try {
    streamer.leaveVoice();
  } catch {}
  streamer.client.destroy();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => log("unhandled:", err?.message ?? err));

if (!config.token || config.token.startsWith("PASTE_")) {
  console.error("Put the spare account's token in config.json first.");
  process.exit(1);
}
await streamer.client.login(config.token);
