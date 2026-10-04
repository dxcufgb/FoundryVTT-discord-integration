#!/usr/bin/env bash
# Stops and removes the systemd service. Files, .env and data/ are left in place.
set -euo pipefail
SERVICE=foundryvtt-discord-bot
if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
echo "Service $SERVICE removed."
