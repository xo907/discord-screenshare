#!/usr/bin/env bash
# Installs the bot as a systemd service for the current user and folder,
# so it starts on boot and restarts if it crashes.
#
#   npm run install-service
#   journalctl -u discord-screenshare -f      # view logs
set -euo pipefail

cd "$(dirname "$0")/.."
NODE_BIN="$(command -v node)"
RUN_USER="${SUDO_USER:-$USER}"

sudo tee /etc/systemd/system/discord-screenshare.service >/dev/null <<EOF
[Unit]
Description=Discord screenshare streamer
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$PWD
ExecStart=$NODE_BIN src/bot.js
Restart=on-failure
RestartSec=10
# Give ffmpeg priority over background tasks so playback never stutters.
Nice=-5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable discord-screenshare
sudo systemctl restart discord-screenshare
echo "Installed and started. Logs: journalctl -u discord-screenshare -f"
