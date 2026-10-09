import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Longest gap between keyframes that still counts as "stream-ready".
// Discord copes fine with ~2s; much longer makes viewers wait to see a picture.
const MAX_KEYFRAME_GAP_SECONDS = 2.1;

function parseRate(rate) {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
}

export async function probe(file, ffprobePath = "ffprobe") {
  const { stdout } = await run(ffprobePath, [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    file,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = info.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(info.format?.duration) || 0,
    bitrateKbps: Math.round((Number(info.format?.bit_rate) || 0) / 1000),
    video: video && {
      codec: video.codec_name,
      profile: video.profile,
      pixFmt: video.pix_fmt,
      width: video.width,
      height: video.height,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      hasBFrames: Number(video.has_b_frames) > 0,
    },
    audio: audio && { codec: audio.codec_name },
  };
}

// Reads packet flags (no decoding, so it's cheap even on a Pi) for the first
// 30 seconds and returns the biggest gap between keyframes.
async function maxKeyframeGap(file, ffprobePath) {
  const { stdout } = await run(ffprobePath, [
    "-v", "error",
    "-select_streams", "v:0",
    "-read_intervals", "%+30",
    "-show_entries", "packet=pts_time,flags",
    "-of", "csv=p=0",
    file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const times = stdout
    .split("\n")
    .filter((line) => line.includes("K"))
    .map((line) => Number(line.split(",")[0]))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return Infinity;
  let gap = 0;
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
  return gap;
}

// Decides whether a file can be sent as-is (no re-encoding = almost no CPU).
// Returns { ok: true } or { ok: false, reason }.
export async function checkPassthrough(file, config) {
  const info = await probe(file, config.ffprobePath);
  const v = info.video;
  if (!v) return { ok: false, reason: "no video stream", info };
  if (v.codec !== "h264") return { ok: false, reason: `video is ${v.codec}, not h264`, info };
  if (v.pixFmt !== "yuv420p") return { ok: false, reason: `pixel format is ${v.pixFmt}`, info };
  if (v.hasBFrames) return { ok: false, reason: "video has B-frames", info };
  if (v.height > config.height) return { ok: false, reason: `${v.height}p is above the ${config.height}p limit`, info };
  if (v.fps > config.fps + 1) return { ok: false, reason: `${v.fps.toFixed(2)}fps is above ${config.fps}fps`, info };
  if (info.bitrateKbps > config.maxBitrateKbps * 1.25) {
    return { ok: false, reason: `bitrate ${info.bitrateKbps}kbps is too high`, info };
  }
  const gap = await maxKeyframeGap(file, config.ffprobePath);
  if (gap > MAX_KEYFRAME_GAP_SECONDS) {
    return { ok: false, reason: `keyframes are ${gap.toFixed(1)}s apart`, info };
  }
  return { ok: true, info };
}
