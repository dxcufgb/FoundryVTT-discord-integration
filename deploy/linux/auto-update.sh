#!/usr/bin/env bash
# Opt-in auto-updater for the Foundry VTT Discord integration on Linux.
#
# Normally run once a day by foundryvtt-discord-bot-update.timer (enable it with
# `sudo deploy/linux/install.sh --enable-auto-update`). By hand:
#   sudo /opt/foundryvtt-discord-integration/deploy/linux/auto-update.sh --check   only report whether a newer release exists
#   sudo /opt/foundryvtt-discord-integration/deploy/linux/auto-update.sh           update now if a newer release exists
#   [--dir <install folder>]                                                      default: the service's WorkingDirectory
#
# It asks GitHub for the latest release, and only if that is a newer version downloads the Linux
# bundle, verifies its SHA-256 against the release's SHA256SUMS.txt, and installs it with the
# bundle's own installer (--non-interactive --no-start, the same upgrade as a manual run). .env is
# restored byte for byte afterwards and data/ is never touched. If anything fails, or the bot does
# not come back up, the previous version is put back. Logs go to the journal:
#   journalctl -u foundryvtt-discord-bot-update
# Optional GitHub token (only needed for a private fork): /etc/foundryvtt-discord-integration/github-token (root, mode 600).
set -euo pipefail

SERVICE="foundryvtt-discord-bot"
APP_NAME="foundryvtt-discord-integration"
TOKEN_FILE="/etc/$APP_NAME/github-token"
LOCK_FILE="/run/lock/$SERVICE-update.lock"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Everything runs inside main(): bash reads the whole function before running it, so the upgrade
# may replace this file on disk while it runs.
main() {
  local mode=update dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check) mode=check; shift ;;
      --now) mode=update; shift ;;
      --dir) dir="${2:?--dir needs a folder}"; shift 2 ;;
      -h|--help) sed -n '2,19p' "$0"; return 0 ;;
      *) die "Unknown option: $1 (try --help)" ;;
    esac
  done
  [[ $EUID -eq 0 ]] || die "Run as root (sudo): the update runs the installer."

  local unit="/etc/systemd/system/$SERVICE.service"
  dir="${dir:-$(sed -n 's/^WorkingDirectory=//p' "$unit" 2>/dev/null || true)}"
  dir="${dir:-/opt/$APP_NAME}"
  dir="${dir%/}"
  [[ -f "$dir/package.json" && -f "$dir/scripts/self-update.js" ]] || die "No bot installation with the updater found in $dir."
  local node
  node="$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "$unit" 2>/dev/null || true)"
  [[ -x "$node" ]] || node="$(command -v node || true)"
  [[ -n "$node" ]] || die "Node.js not found."
  # Under systemd PATH is minimal; the installer looks for node on PATH, so put this one first.
  PATH="$(dirname "$node"):$PATH"

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then log "Another update is already running; nothing to do."; return 0; fi

  WORK="$(mktemp -d /var/tmp/$SERVICE-update.XXXXXX)"
  trap 'rm -rf "$WORK"' EXIT
  local args=(--platform linux --dir "$dir")
  [[ -f "$TOKEN_FILE" ]] && args+=(--token-file "$TOKEN_FILE")
  local out
  if [[ $mode == check ]]; then
    out="$("$node" "$dir/scripts/self-update.js" check "${args[@]}")" || die "The update check failed."
  else
    out="$("$node" "$dir/scripts/self-update.js" download "${args[@]}" --out "$WORK")" || die "The update check or download failed; nothing was changed."
  fi
  local status latest file
  status="$(sed -n 's/^status=//p' <<<"$out")"
  latest="$(sed -n 's/^latest=//p' <<<"$out")"
  file="$(sed -n 's/^file=//p' <<<"$out")"
  if [[ $status != update || $mode == check ]]; then
    [[ $status == update ]] && log "Version $latest is available. Install it with: sudo $dir/deploy/linux/auto-update.sh"
    return 0
  fi
  [[ -f "$file" ]] || die "The downloaded bundle is missing."

  log "Extracting $(basename "$file")"
  mkdir "$WORK/new"
  tar -xzf "$file" -C "$WORK/new" --no-same-owner
  local src
  src="$(find "$WORK/new" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [[ -n "$src" && -f "$src/package.json" && -f "$src/deploy/linux/install.sh" ]] || die "The bundle does not look like a bot release; nothing was changed."

  # Back up everything the installer may change: the program files (not data/), .env and the unit.
  log "Backing up the current version"
  tar -C "$dir" --exclude=./data -cf "$WORK/backup.tar" .
  [[ -f "$dir/.env" ]] && cp -p "$dir/.env" "$WORK/env.bak"
  cp -p "$unit" "$WORK/unit.bak"
  local was_active=0
  systemctl is-active --quiet "$SERVICE" && was_active=1

  log "Installing version $latest"
  if ! bash "$src/deploy/linux/install.sh" --non-interactive --no-start --dir "$dir" </dev/null; then
    rollback "$dir" "$unit" "$was_active"
    die "The installer failed; the previous version was restored."
  fi
  # The installer rewrites .env from the values it knows; put back the exact file (comments, extra settings).
  [[ -f "$WORK/env.bak" ]] && cp -p "$WORK/env.bak" "$dir/.env"
  # Release notes for the bot's "updated" DM to server admins (read and deleted by the bot).
  local notice
  notice="$(sed -n 's/^notice=//p' <<<"$out")"
  if [[ -f "$notice" && -d "$dir/data" ]]; then
    install -m 644 -o "$(stat -c %U "$dir/data")" "$notice" "$dir/data/update-notice.json" || true
  fi
  systemctl daemon-reload
  if [[ $was_active -eq 1 ]]; then
    systemctl restart "$SERVICE"
    sleep 15
    if ! systemctl is-active --quiet "$SERVICE"; then
      journalctl -u "$SERVICE" -n 20 --no-pager -o cat || true
      rollback "$dir" "$unit" "$was_active"
      die "Version $latest did not stay running; the previous version was restored."
    fi
    log "Updated to version $latest; $SERVICE restarted."
  else
    log "Updated to version $latest. $SERVICE was not running before and was not started."
  fi
}

rollback() { # rollback <dir> <unit> <was_active>
  log "Restoring the previous version"
  find "$1" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
  tar -C "$1" -xpf "$WORK/backup.tar"
  [[ -f "$WORK/env.bak" ]] && cp -p "$WORK/env.bak" "$1/.env"
  cp -p "$WORK/unit.bak" "$2"
  systemctl daemon-reload
  if [[ $3 -eq 1 ]]; then systemctl restart "$SERVICE" || true; fi
}

main "$@"; exit $?
