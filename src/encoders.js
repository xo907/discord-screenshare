import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { Encoders } from "@dank074/discord-video-stream";

const run = promisify(execFile);

// Raspberry Pi 4 hardware H.264 encoder (good up to 1080p30).
// -g sets the keyframe interval to one second, which Discord needs so new
// viewers get a picture quickly.
function v4l2m2m(fps) {
  return () => ({
    H264: {
      name: "h264_v4l2m2m",
      options: [`-g ${fps}`, "-num_capture_buffers 16"],
      outFilters: ["format=yuv420p"],
    },
  });
}

const FFMPEG_NAMES = { v4l2m2m: "h264_v4l2m2m", software: "libx264", nvenc: "h264_nvenc", vaapi: "h264_vaapi" };

function build(name, config) {
  switch (name) {
    case "v4l2m2m":
      return v4l2m2m(config.fps);
    case "software":
      // ultrafast keeps CPU use as low as x264 allows. Fine on a PC; on a Pi
      // only use it for 720p or below.
      return Encoders.software({ x264: { preset: "ultrafast", tune: "film" } });
    case "nvenc":
      return Encoders.nvenc();
    case "vaapi":
      return Encoders.vaapi();
  }
}

// Whether the hardware behind an encoder is actually present, not just
// compiled into ffmpeg (Debian's ffmpeg lists v4l2m2m/nvenc/vaapi everywhere).
function hardwarePresent(name) {
  if (name === "v4l2m2m") return existsSync("/dev/video11"); // Pi's H.264 encoder device
  if (name === "vaapi") return existsSync("/dev/dri/renderD128");
  return true;
}

// Picks the configured encoder if it will work on this machine, otherwise
// falls back to software x264. "auto" prefers the Pi's hardware encoder.
export async function makeEncoder(config, log = console.log) {
  let wanted = config.encoder ?? "auto";
  if (wanted === "auto") wanted = hardwarePresent("v4l2m2m") ? "v4l2m2m" : "software";
  if (!FFMPEG_NAMES[wanted]) {
    throw new Error(`Unknown encoder "${config.encoder}" (use auto, v4l2m2m, software, nvenc or vaapi)`);
  }

  let available = "";
  try {
    ({ stdout: available } = await run("ffmpeg", ["-hide_banner", "-encoders"]));
  } catch {
    log("couldn't run ffmpeg to list encoders; is it installed?");
  }
  if (wanted !== "software" && !(available.includes(FFMPEG_NAMES[wanted]) && hardwarePresent(wanted))) {
    log(`encoder "${wanted}" isn't usable on this machine, using "software" instead`);
    wanted = "software";
  }
  return { name: wanted, encoder: build(wanted, config) };
}
