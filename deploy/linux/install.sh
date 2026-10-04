#!/usr/bin/env bash
# Installs the bot as a systemd service on Linux.
#
#   sudo ./deploy/linux/install.sh [--user <user>] [--dir <install dir>]
#
# --user  The Linux user the bot runs as. Use the user that runs Foundry so the
#         bot can read Foundry's data folder (default: the user who ran sudo).
# --dir   Where the bot lives (default: the folder this release was extracted to).
#
# Needs: Node.js 20 or newer on the PATH (https://nodejs.org), a filled-in .env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
INSTALL_DIR="$HERE"
SERVICE=foundryvtt-discord-bot

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) RUN_USER="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Run with sudo (systemd units are installed system-wide)." >&2; exit 1; fi
if ! id "$RUN_USER" >/dev/null 2>&1; then echo "User '$RUN_USER' does not exist." >&2; exit 1; fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then echo "Node.js was not found on the PATH. Install Node.js 20 or newer first." >&2; exit 1; fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then echo "Node.js 20 or newer is required (found $("$NODE" --version))." >&2; exit 1; fi

if [[ "$INSTALL_DIR" != "$HERE" ]]; then
  echo "Copying files to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$HERE"/. "$INSTALL_DIR"/
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo
  echo "Created $INSTALL_DIR/.env from the example. Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and FOUNDRY_DATA_PATH,"
  echo "then run this script again."
  chown "$RUN_USER" "$INSTALL_DIR/.env"; chmod 600 "$INSTALL_DIR/.env"
  exit 0
fi

if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  echo "Installing dependencies"
  (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund)
fi

mkdir -p "$INSTALL_DIR/data"
chown -R "$RUN_USER" "$INSTALL_DIR/data" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"

echo "Checking configuration as $RUN_USER"
(cd "$INSTALL_DIR" && sudo -u "$RUN_USER" "$NODE" scripts/check-config.js)

sed -e "s|__USER__|$RUN_USER|g" -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__NODE__|$NODE|g" \
  "$INSTALL_DIR/deploy/linux/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 2
systemctl --no-pager --lines=5 status "$SERVICE" || true
echo
echo "Installed. Useful commands:"
echo "  sudo systemctl status $SERVICE      # is it running?"
echo "  sudo journalctl -u $SERVICE -f      # follow the log"
echo "  sudo systemctl restart $SERVICE     # after editing .env"
