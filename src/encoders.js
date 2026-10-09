import { Encoders } from "@dank074/discord-video-stream";

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

export function makeEncoder(config) {
  switch (config.encoder) {
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
    default:
      throw new Error(`Unknown encoder "${config.encoder}" (use v4l2m2m, software, nvenc or vaapi)`);
  }
}
