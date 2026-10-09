// Converts videos into a "stream-ready" copy the bot can send without
// re-encoding (near-zero CPU on the Pi during playback).
//
//   npm run prepare-video -- <file-or-folder> [--hw] [--replace]
//
//   --hw       use the Pi's hardware encoder (faster, slightly lower quality)
//   --replace  delete the original once the converted copy is written
//
// Output goes next to the input as "<name>.stream.mp4".

import { spawn } from "node:child_process";
import { readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { checkPassthrough, probe } from "../src/probe.js";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".ts", ".flv", ".wmv"]);

const defaults = { height: 720, fps: 30, bitrateKbps: 3000, maxBitrateKbps: 4500, ffprobePath: "ffprobe" };
let config = defaults;
try {
  config = { ...defaults, ...JSON.parse(await readFile(new URL("../config.json", import.meta.url), "utf8")) };
} catch {}

const args = process.argv.slice(2);
const useHw = args.includes("--hw");
const replace = args.includes("--replace");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.log("Usage: npm run prepare-video -- <file-or-folder> [--hw] [--replace]");
  process.exit(1);
}

async function collect(p) {
  const s = await stat(p);
  if (s.isFile()) return [p];
  const out = [];
  for (const e of await readdir(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...(await collect(full)));
    else if (VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith(".stream.mp4")) out.push(full);
  }
  return out;
}

function ffmpeg(argv, duration) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", argv, { stdio: ["ignore", "ignore", "pipe"] });
    let last = "";
    proc.stderr.on("data", (chunk) => {
      last = chunk.toString();
      const m = last.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && duration) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        process.stdout.write(`\r  ${Math.min(100, (t / duration) * 100).toFixed(1)}%   `);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      process.stdout.write("\n");
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${last.trim().split("\n").pop()}`));
    });
  });
}

async function convert(file) {
  console.log(`\n${file}`);
  const check = await checkPassthrough(file, config).catch((err) => ({ ok: false, reason: err.message }));
  if (check.ok) {
    console.log("  already stream-ready, skipping");
    return;
  }
  console.log(`  needs converting: ${check.reason}`);

  const info = check.info ?? (await probe(file, config.ffprobePath));
  const fps = Math.min(config.fps, Math.round(info.video?.fps || config.fps));
  const out = path.join(path.dirname(file), path.basename(file, path.extname(file)) + ".stream.mp4");
  const tmp = out + ".part.mp4";

  const video = useHw
    ? ["-c:v", "h264_v4l2m2m", "-b:v", `${config.bitrateKbps}k`, "-num_capture_buffers", "16"]
    : [
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "film", "-profile:v", "high",
        "-crf", "21", "-maxrate", `${config.maxBitrateKbps}k`, "-bufsize", `${config.maxBitrateKbps * 2}k`,
        "-sc_threshold", "0", "-keyint_min", String(fps),
      ];

  await ffmpeg([
    "-hide_banner", "-y",
    "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?",
    // Only ever scale down, keep aspect ratio, even dimensions.
    "-vf", `scale=-2:'min(${config.height},ih)':flags=bicubic,fps=${fps},format=yuv420p`,
    ...video,
    "-g", String(fps), "-bf", "0",
    "-force_key_frames", "expr:gte(t,n_forced*1)",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000",
    "-movflags", "+faststart",
    tmp,
  ], info.duration);

  await rename(tmp, out);
  if (replace) await rm(file);
  console.log(`  wrote ${out}`);
}

const files = await collect(path.resolve(target));
if (!files.length) console.log("No videos found.");
let failed = 0;
for (const f of files) {
  try {
    await convert(f);
  } catch (err) {
    failed++;
    console.error(`  failed: ${err.message}`);
    await rm(path.join(path.dirname(f), path.basename(f, path.extname(f)) + ".stream.mp4.part.mp4"), { force: true });
  }
}
process.exit(failed ? 1 : 0);
