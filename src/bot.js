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
  encoder: "auto",
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

const { name: encoderName, encoder } = await makeEncoder(config, log);
log(`video encoder: ${encoderName}`);

// WSL has no usable GPU decode path for ffmpeg; "-hwaccel auto" there is at
// best wasted effort and at worst a failed stream.
const isWsl = await readFile("/proc/version", "utf8")
  .then((v) => /microsoft/i.test(v))
  .catch(() => false);
const hardwareDecoding = config.hardwareDecoding && !isWsl;
if (config.hardwareDecoding && isWsl) log("running under WSL: hardware decoding disabled");
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

// Network/FUSE drives can hang on stat(); give up after a few seconds.
async function isFile(p) {
  try {
    return (await withTimeout(stat(p), 10_000, "timeout")).isFile();
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
  for (const c of candidates) {
    const match = await fuzzyResolve(path.resolve(base, c));
    if (match) return match;
  }
  return candidates[1];
}

// Makes names comparable despite things you can't see when typing them:
// non-breaking/double spaces, fancy dashes and quotes, letter case.
function looseName(name) {
  return name
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Walks the path one folder at a time. Where a part doesn't exist exactly,
// picks the single entry whose name matches loosely, or the single entry
// that starts with what was typed (so "!play movies/Salmokji" works).
async function fuzzyResolve(full) {
  let current = path.parse(full).root;
  const parts = full.slice(current.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    const exact = path.join(current, part);
    try {
      await withTimeout(stat(exact), 10_000, "timeout");
      current = exact;
      continue;
    } catch {}
    let entries;
    try {
      entries = await withTimeout(readdir(current), 10_000, "timeout");
    } catch {
      return null;
    }
    const want = looseName(part);
    let found = entries.filter((e) => looseName(e) === want);
    if (found.length !== 1) found = entries.filter((e) => looseName(e).startsWith(want));
    if (found.length !== 1) return null;
    current = path.join(current, found[0]);
  }
  return (await isFile(current)) ? current : null;
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
    info = await withTimeout(stat(full), 10_000, "timeout");
  } catch (err) {
    if (err.message === "timeout") throw new Error(`The drive holding \`${full}\` isn't responding.`);
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

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
  log(`found file ${file}, user is in ${channel.guild.name} / ${channel.name}`);
  const loading = msg.reply(`⏳ Loading **${path.basename(file)}**…`).catch(() => null);

  // Join the call and inspect the file at the same time.
  // The check is cheap (no decoding) and decides whether we can skip re-encoding.
  const probing = checkPassthrough(file, config)
    .then((check) => {
      log(check.ok ? "passthrough:" : `transcoding (${check.reason}):`, file);
      return { passthrough: check.ok, duration: check.info?.duration ?? 0 };
    })
    .catch((err) => {
      log("ffprobe failed, falling back to transcoding:", err.message);
      return { passthrough: false, duration: 0 };
    });

  stopCurrent();

  if (streamer.voiceConnection?.channelId !== channel.id) {
    log(`joining ${channel.guild.name} / ${channel.name}`);
    try {
      await withTimeout(streamer.joinVoice(channel.guild.id, channel.id), 20_000, "timeout");
    } catch (err) {
      if (err.message !== "timeout") throw err;
      const s = streamer.voiceConnection?.status ?? {};
      log("join timed out, voice status:", JSON.stringify(s));
      streamer.leaveVoice();
      if (!s.hasSession && !s.hasToken) {
        throw new Error("Discord never let me into the channel. Check that this account has the **Connect** permission there and the channel isn't full.");
      }
      if (!s.hasSession || !s.hasToken) {
        throw new Error(`Discord only half-answered the join (session: ${!!s.hasSession}, server: ${!!s.hasToken}). Try again in a moment.`);
      }
      throw new Error("Got into the channel but couldn't connect to Discord's voice server. Usually a firewall/VPN blocking it; see the terminal.");
    }
    if (channel instanceof StageChannel) {
      await streamer.client.user.voice.setSuppressed(false);
    }
    log("joined voice");
  }

  const { passthrough, duration } = await probing;
  (await loading)?.delete().catch(() => {});

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
    hardwareAcceleratedDecoding: !passthrough && hardwareDecoding,
    videoCodec: Utils.normalizeVideoCodec("H264"),
    logLevel: "error",
  }, controller.signal);

  // ffmpeg's own error is the useful one; the stream error that follows it is
  // just "no data". Keep it so the Discord message can show the real cause.
  let ffmpegError = null;
  command.on("error", (err) => {
    if (controller.signal.aborted) return;
    ffmpegError = err.message;
    log("ffmpeg error:", err.message);
  });

  const entry = { file, controller, audio, startedAt: Date.now(), duration, passthrough };
  current = entry;

  const mode = passthrough ? "direct, no re-encode" : `re-encoding with ${encoderName}`;
  await msg.reply(`▶️ Streaming **${path.basename(file)}** (${formatTime(duration)}, ${mode})`).catch(() => {});
  log(`starting stream (${mode})`);

  playStream(output, streamer, { type: "go-live" }, controller.signal)
    .then(async () => {
      if (current !== entry) return;
      current = null;
      log("finished:", file);
      await msg.channel.send(`⏹️ Finished **${path.basename(file)}**`).catch(() => {});
      if (config.leaveWhenDone) streamer.leaveVoice();
    })
    .catch(async (err) => {
      if (controller.signal.aborted) return; // stopped on purpose
      log("stream error:", err?.message ?? err);
      if (current === entry) current = null;
      // Give ffmpeg's error event a moment to arrive if it hasn't yet.
      if (!ffmpegError) await new Promise((r) => setTimeout(r, 500));
      controller.abort();
      const reason = (ffmpegError ?? err?.message ?? String(err)).slice(0, 1500);
      msg.channel.send(`⚠️ Stream failed: ${reason}`).catch(() => {});
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

// Voice handshake progress, so join problems show where they stall.
streamer.client.on("raw", (packet) => {
  if (packet.t === "VOICE_STATE_UPDATE" && packet.d?.user_id === streamer.client.user?.id) {
    log(`voice state: channel=${packet.d.channel_id ?? "none"}`);
  } else if (packet.t === "VOICE_SERVER_UPDATE") {
    log(`voice server: ${packet.d?.endpoint ?? "none"}`);
  }
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
            (current.passthrough ? " (direct)" : ` (re-encoding with ${encoderName})`),
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
