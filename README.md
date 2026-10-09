# Discord Screenshare

Streams a video file from the machine it runs on into a Discord voice channel using Go Live, so everyone in the call can watch. It's designed to run on a Raspberry Pi 4.

> ⚠️ This logs in as a **user account** (a "selfbot"), because Discord bot accounts can't stream video. Selfbots break Discord's Terms of Service. Use a spare account you're OK with losing, never your main.

## How it stays lag-free on a Pi

When you `!play` a file, the bot checks it first. This check doesn't decode anything, so it takes milliseconds.

- **If the file is already stream-ready** (H.264, no B-frames, a keyframe at least every ~2s, within your resolution, fps and bitrate limits), it's sent **as-is**. FFmpeg just copies it, so CPU use is close to zero.
- **Otherwise** it's re-encoded live with the Pi's **hardware** H.264 encoder (`h264_v4l2m2m`). That's fine for 720p30 and OK for 1080p30.

For the smoothest result, convert your videos ahead of time with `npm run prepare-video` (see below). Every playback is then a direct copy.

## Setup on the Pi

1. Flash **Raspberry Pi OS 64-bit (Bookworm or later)**. Use **wired Ethernet** if you can.
2. Install FFmpeg and Node.js 22+:
   ```bash
   sudo apt update && sudo apt install -y ffmpeg git
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
3. Download the bot and install it:
   ```bash
   git clone https://github.com/xo907/discord-screenshare.git ~/discord-screenshare
   cd ~/discord-screenshare
   npm install
   cp config.example.json config.json
   nano config.json
   ```
4. Fill in `config.json`:
   - `token`: the spare account's token. Log into the spare account at discord.com in a browser, open DevTools → Network, and copy the `Authorization` header from any request to `/api/`. **Treat it like a password.**
   - `allowedUsers`: **your own** user ID. In Discord, go to Settings → Advanced → turn on Developer Mode, then right-click yourself → Copy User ID. Only these users can control the bot.
   - `mediaDir`: the folder your videos live in. Relative paths in `!play` resolve from here.
5. Check everything:
   ```bash
   npm run check
   ```
   If it says **node-datachannel needs compiling** (older OSes such as Raspberry Pi OS Bookworm or Ubuntu 22.04, whose system libraries are older than the prebuilt module expects), build it on the Pi once. This takes about 10–20 minutes:
   ```bash
   sudo apt install -y cmake build-essential libssl-dev
   npm run build-native
   ```
   It skips itself if a working build already exists, and cancelling halfway is safe. After an `npm install` that updates the streaming library, run `npm run build-native -- --force`. On Raspberry Pi OS Trixie or Ubuntu 24.04+ this step isn't needed.
6. Try it in the foreground first with `npm start` (Ctrl+C to stop). Once it works, install it as a service so it starts on boot and restarts if it crashes:
   ```bash
   npm run install-service
   ```
   Logs: `journalctl -u discord-screenshare -f`. Don't run `npm start` while the service is running, or you'll have two copies fighting over the account.

## Using it

Make sure the spare account is a member of the server. Join a voice channel yourself, then type in any channel the spare account can see, or DM it:

| Command | What it does |
| --- | --- |
| `!play <path>` | Joins your voice channel and streams the file. Absolute paths work; relative ones resolve from `mediaDir`. Quotes around paths with spaces are optional. |
| `!stop` | Stops the video but stays in the call |
| `!leave` | Stops and leaves |
| `!now` | Shows what's playing and how far in |
| `!volume <0-200>` | Changes the stream's volume live (100 = normal) |
| `!list [folder]` | Lists videos in the media folder |
| `!help` | Shows the command list |

Starting a new `!play` while something is playing replaces it.

## Pre-converting videos (recommended)

```bash
npm run prepare-video -- /home/pi/videos            # whole folder (recursive)
npm run prepare-video -- "/home/pi/videos/Movie.mkv"
npm run prepare-video -- /home/pi/videos --hw       # use the Pi's hardware encoder (much faster)
npm run prepare-video -- /home/pi/videos --replace  # delete originals afterwards
```

This writes `<name>.stream.mp4` next to each file and skips files that are already stream-ready. It also works on a Windows/Mac PC with FFmpeg installed, which is much faster than the Pi. Convert there, then copy the `.stream.mp4` files over.

## Settings (`config.json`)

| Key | Default | Notes |
| --- | --- | --- |
| `width` / `height` / `fps` | 1280 / 720 / 30 | Max output size. Without Nitro, Go Live viewers are capped at 720p30 anyway. With Nitro, 1920/1080/30 works if files are pre-converted. |
| `bitrateKbps` / `maxBitrateKbps` | 3000 / 4500 | Video bitrate. Needs about this much **upload** speed. |
| `encoder` | `auto` | `auto` (Pi hardware encoder if present, otherwise software), `v4l2m2m` (Pi hardware), `software` (x264), `nvenc` (NVIDIA), `vaapi` (Intel/AMD on Linux). Falls back to `software` if the chosen one isn't usable. |
| `hardwareDecoding` | `true` | Lets FFmpeg use hardware decoding when re-encoding |
| `restrictToMediaDir` | `false` | If `true`, `!play` refuses files outside `mediaDir` |
| `leaveWhenDone` | `false` | Leave the call when a video finishes |

## Troubleshooting

- **Stuttering when re-encoding:** pre-convert the file, or lower `height` / `bitrateKbps`. Run `vcgencmd get_throttled`: anything other than `0x0` means the Pi is underpowered or overheating. Use the official 5V/3A PSU and a heatsink or fan.
- **Stuttering on direct playback:** almost always network. Use Ethernet and check your upload speed.
- **Logs:** `journalctl -u discord-screenshare -f` when running as a service. For very detailed library logs, start with `DEBUG=* npm start`.
- **Subtitles** aren't shown. If you need them, burn them in when converting, e.g. with ffmpeg's `subtitles=` filter.
