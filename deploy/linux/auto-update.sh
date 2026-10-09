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

REPO_URL="https://github.com/dxcufgb/FoundryVTT-discord-integration"
KEEP_WORK=0

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
  # Check and run the real folder, not a symlink that could lead somewhere another account can write.
  dir="$(realpath -e "$dir" 2>/dev/null)" || die "Install folder not found."
  [[ -f "$dir/package.json" && -f "$dir/scripts/self-update.js" ]] || die "No bot installation with the updater found in $dir."
  # Runs as root: refuse program files (or their folders) that another account could have changed.
  local bad
  bad="$(find "$dir" \( -path "$dir/data" -o -path "$dir/.env" \) -prune -o ! -type l \( ! -user root -o -perm -o+w -o \( -perm -g+w ! -group root \) \) -print -quit 2>/dev/null)"
  local parent="$dir"
  while [[ -z "$bad" ]] && parent="$(dirname "$parent")" && [[ "$parent" != / ]]; do
    bad="$(find "$parent" -maxdepth 0 \( ! -user root -o -perm -o+w -o \( -perm -g+w ! -group root \) \) -print 2>/dev/null)"
  done
  [[ -z "$bad" ]] || die "$bad can be changed by an account other than root; refusing to run it as root. Reinstall with deploy/linux/install.sh (it makes the program files root-owned)."
  local node
  node="$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "$unit" 2>/dev/null || true)"
  [[ -x "$node" ]] || node="$(command -v node || true)"
  [[ -n "$node" ]] || die "Node.js not found."
  # Node.js runs as root here too: refuse one that (or whose folders) another account can change, such as nvm's.
  node="$(realpath -e "$node" 2>/dev/null)" || die "Node.js not found."
  parent="$node"
  while [[ "$parent" != / ]]; do
    if [[ -n "$(find "$parent" -maxdepth 0 \( ! -user root -o -perm -o+w -o \( -perm -g+w ! -group root \) \) -print 2>/dev/null)" ]]; then
      die "$parent can be changed by an account other than root, so its Node.js must not run as root. Install Node.js system-wide (from your distribution or NodeSource)."
    fi
    parent="$(dirname "$parent")"
  done
  # Under systemd PATH is minimal; the installer looks for node on PATH, so put this one first.
  PATH="$(dirname "$node"):$PATH"

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then log "Another update is already running; nothing to do."; return 0; fi

  WORK="$(mktemp -d /var/tmp/$SERVICE-update.XXXXXX)"
  # The work folder holds the download and the backup; it is kept when a rollback failed (the backup is then needed by hand).
  trap 'if [[ $KEEP_WORK -eq 0 ]]; then rm -rf "$WORK"; fi' EXIT
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
  local was_active=0 previous
  systemctl is-active --quiet "$SERVICE" && was_active=1
  previous="$(sed -n 's/^current=//p' <<<"$out")"
  previous="${previous:-unknown}"

  log "Installing version $latest"
  if ! bash "$src/deploy/linux/install.sh" --non-interactive --no-start --dir "$dir" </dev/null; then
    if rollback "$dir" "$unit" "$was_active" "$previous"; then die "The installer failed; the previous version was restored."; fi
    die "The installer failed, and restoring version $previous failed too (see ROLLBACK FAILED above)."
  fi
  # The installer rewrites .env from the values it knows; put back the exact file (comments, extra settings).
  [[ -f "$WORK/env.bak" ]] && cp -p "$WORK/env.bak" "$dir/.env"
  # Release notes for the bot's "updated" DM to server admins (read and deleted by the bot).
  local notice
  notice="$(sed -n 's/^notice=//p' <<<"$out")"
  if [[ -f "$notice" && -d "$dir/data" ]]; then
    install -m 644 -o "$(stat -c %U "$dir/data")" "$notice" "$dir/data/update-notice.json" || true
  fi
  systemctl daemon-reload || true
  if [[ $was_active -eq 1 ]]; then
    if ! restart_and_check; then
      journalctl -u "$SERVICE" -n 20 --no-pager -o cat || true
      if rollback "$dir" "$unit" "$was_active" "$previous"; then die "Version $latest did not stay running; the previous version was restored."; fi
      die "Version $latest did not stay running, and restoring version $previous failed too (see ROLLBACK FAILED above)."
    fi
    log "Updated to version $latest; $SERVICE restarted."
  else
    log "Updated to version $latest. $SERVICE was not running before and was not started."
  fi
}

# Restart the bot and report whether it is still running 15 seconds later.
restart_and_check() {
  systemctl restart "$SERVICE" || true
  sleep 15
  systemctl is-active --quiet "$SERVICE"
}

# rollback <dir> <unit> <was_active> <previous version>: put the backup back and check that it worked.
# Returns 0 when the previous version is back (and running again, if it was running). Otherwise logs
# ROLLBACK FAILED with the manual recovery steps, keeps the backup and returns 1. Every step is
# checked on its own, so a failing command cannot end the script (set -e) before the verdict is logged.
rollback() {
  local failed=""
  log "Restoring the previous version ($4)"
  find "$1" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} + || failed+=" removing the new files failed;"
  tar -C "$1" -xpf "$WORK/backup.tar" || failed+=" extracting the backup failed;"
  if [[ -f "$WORK/env.bak" ]]; then cp -p "$WORK/env.bak" "$1/.env" || failed+=" restoring .env failed;"; fi
  cp -p "$WORK/unit.bak" "$2" || failed+=" restoring $2 failed;"
  systemctl daemon-reload || failed+=" systemctl daemon-reload failed;"
  if [[ $3 -eq 1 ]] && ! restart_and_check; then
    journalctl -u "$SERVICE" -n 20 --no-pager -o cat || true
    failed+=" $SERVICE is not running after the restore;"
  fi
  if [[ -z "$failed" ]]; then return 0; fi
  KEEP_WORK=1
  local env_step=""
  if [[ -f "$WORK/env.bak" ]]; then env_step="sudo cp -p $WORK/env.bak $1/.env; "; fi
  {
    printf 'ROLLBACK FAILED: version %s could not be restored;%s\n' "$4" "${failed%;}"
    printf 'The backup is kept in %s (backup.tar = program files without data/, env.bak = .env, unit.bak = the systemd unit).\n' "$WORK"
    printf 'To restore it by hand: sudo systemctl stop %s; sudo find %s -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +; ' "$SERVICE" "$1"
    printf 'sudo tar -C %s -xpf %s/backup.tar; %ssudo cp -p %s/unit.bak %s; sudo systemctl daemon-reload; sudo systemctl start %s\n' "$1" "$WORK" "$env_step" "$WORK" "$2" "$SERVICE"
    printf 'Or download foundryvtt-discord-integration-%s-linux.tar.gz from %s/releases/tag/v%s and run its deploy/linux/install.sh (it keeps .env and data/).\n' "$4" "$REPO_URL" "$4"
    printf 'Then check: systemctl status %s; journalctl -u %s\n' "$SERVICE" "$SERVICE"
  } >&2
  return 1
}

main "$@"; exit $?
