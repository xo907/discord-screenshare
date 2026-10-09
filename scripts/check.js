// Sanity-checks the machine before you run the bot: npm run check
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
let problems = 0;

function ok(msg) {
  console.log(`  ✔ ${msg}`);
}
function bad(msg) {
  problems++;
  console.log(`  ✘ ${msg}`);
}
function warn(msg) {
  console.log(`  ! ${msg}`);
}

console.log("Checking setup…");

const [major, minor] = process.versions.node.split(".").map(Number);
major > 22 || (major === 22 && minor >= 4) ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old, need 22.4+`);

let config = null;
try {
  config = JSON.parse(await readFile(new URL("../config.json", import.meta.url), "utf8"));
  ok("config.json found");
  if (!config.token || config.token.startsWith("PASTE_")) bad("config.json: token not set");
  if (!config.allowedUsers?.length || config.allowedUsers.some((u) => !/^\d+$/.test(u))) bad("config.json: allowedUsers must be your numeric Discord user ID(s)");
} catch {
  bad("config.json missing or not valid JSON (copy config.example.json)");
}

try {
  await run(config?.ffprobePath ?? "ffprobe", ["-version"]);
  ok("ffprobe installed");
} catch {
  bad("ffprobe not found (sudo apt install ffmpeg)");
}

try {
  const { stdout: encoders } = await run("ffmpeg", ["-hide_banner", "-encoders"]);
  ok("ffmpeg installed");
  const { stdout: filters } = await run("ffmpeg", ["-hide_banner", "-filters"]);
  const enc = config?.encoder ?? "v4l2m2m";
  const needed = { v4l2m2m: "h264_v4l2m2m", software: "libx264", nvenc: "h264_nvenc", vaapi: "h264_vaapi" }[enc];
  if (needed && encoders.includes(needed)) ok(`encoder ${needed} available`);
  else bad(`encoder ${needed ?? enc} not available in this ffmpeg build`);
  if (!encoders.includes("libopus")) bad("ffmpeg lacks libopus (needed for audio)");
  if (filters.includes("azmq")) ok("azmq filter available (live volume control)");
  else warn("ffmpeg lacks the azmq filter: streaming works but !volume won't");
} catch {
  bad("ffmpeg not found (sudo apt install ffmpeg)");
}

if (process.platform === "linux") {
  try {
    const { stdout } = await run("vcgencmd", ["get_throttled"]);
    const flags = parseInt(stdout.split("=")[1], 16);
    if (flags === 0) ok("Pi has not been throttled (power + temperature OK)");
    else warn(`Pi reports throttling (${stdout.trim()}): check the power supply and cooling`);
  } catch {}
}

console.log(problems ? `\n${problems} problem(s) to fix.` : "\nAll good. Start with: npm start");
process.exit(problems ? 1 : 0);
