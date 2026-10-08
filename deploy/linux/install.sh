#!/usr/bin/env bash
# Interactive installer for the Foundry VTT Discord integration on Linux.
#
# Guided install (asks every question, with sensible defaults it detects):
#   sudo ./deploy/linux/install.sh
#
# One-liner that downloads the latest release first:
#   curl -fsSL https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest/download/install.sh | sudo bash
#
# Unattended (for scripts and CI):
#   sudo ./deploy/linux/install.sh --non-interactive --token <bot token> --client-id <id> \
#        --data-path /home/foundry/foundrydata [--user foundry] [--dir /opt/foundryvtt-discord-integration] \
#        [--url http://localhost:30000] [--guild-id <id>] [--timezone Europe/Stockholm] [--interval 30] [--no-start]
#        [--auto-update | --no-auto-update]
#
# Automatic updates (opt-in; a daily systemd timer installs new releases, see docs/INSTALL.md):
#   sudo ./deploy/linux/install.sh --enable-auto-update | --disable-auto-update [--dir <install folder>]
#   (re-running the installer keeps the current choice unless --auto-update/--no-auto-update is given)
#
# Remove again:
#   sudo ./deploy/linux/install.sh --uninstall [--purge]      (--purge also deletes the files, .env and data)
#
# What it does: checks for Node.js 20+ (offers to install it), finds the running
# Foundry server to suggest its user, port and data folder, asks for the Discord
# token and ids, writes .env, installs a systemd service and starts it.
set -euo pipefail

REPO="dxcufgb/FoundryVTT-discord-integration"
SERVICE="foundryvtt-discord-bot"
APP_NAME="foundryvtt-discord-integration"
UPDATER="$SERVICE-update"

# --- output helpers -------------------------------------------------------------------------------------------
if [[ -t 1 ]]; then BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'; else BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s  ✔ %s%s\n' "$GREEN" "$*" "$RESET"; }
warn() { printf '%s  ! %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die()  { printf '%s  ✖ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# --- arguments ------------------------------------------------------------------------------------------------
INTERACTIVE=1
START=1
UNINSTALL=0
PURGE=0
INSTALL_DIR=""
RUN_USER=""
TOKEN=""
CLIENT_ID=""
GUILD_ID=""
FOUNDRY_URL=""
DATA_PATH=""
APP_PATH=""
TIMEZONE=""
INTERVAL=""
VERSION="latest"
AUTO_UPDATE=""   # empty: keep the current choice (ask when interactive); 1 / 0: turn on / off
UPDATER_ONLY=0

usage() { sed -n '2,25p' "$0"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|-y) INTERACTIVE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-start) START=0; shift ;;
    --purge) PURGE=1; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --guild-id) GUILD_ID="$2"; shift 2 ;;
    --url) FOUNDRY_URL="$2"; shift 2 ;;
    --data-path) DATA_PATH="$2"; shift 2 ;;
    --app-path) APP_PATH="$2"; shift 2 ;;
    --timezone) TIMEZONE="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --auto-update) AUTO_UPDATE=1; shift ;;
    --no-auto-update) AUTO_UPDATE=0; shift ;;
    --enable-auto-update) AUTO_UPDATE=1; UPDATER_ONLY=1; shift ;;
    --disable-auto-update) AUTO_UPDATE=0; UPDATER_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run this installer with sudo: it installs a system service."

# Interactive input must come from the terminal even when the script is piped from curl.
TTY=""
if [[ $INTERACTIVE -eq 1 ]]; then
  if [[ -t 0 ]]; then TTY=/dev/stdin; elif [[ -r /dev/tty && -w /dev/tty ]]; then TTY=/dev/tty; else
    warn "No terminal available; switching to non-interactive mode."
    INTERACTIVE=0
  fi
fi

# ask VAR "Question" "default"  -> sets VAR (keeps a preset value and only confirms it interactively)
ask() {
  local -n _out="$1"; local prompt="$2" default="${3-}"
  if [[ $INTERACTIVE -eq 0 ]]; then _out="${_out:-$default}"; return; fi
  local current="${_out:-$default}" answer
  if [[ -n "$current" ]]; then printf '%s [%s]: ' "$prompt" "$current"; else printf '%s: ' "$prompt"; fi
  IFS= read -r answer < "$TTY" || answer=""
  _out="${answer:-$current}"
  return 0
}
ask_secret() {
  local -n _out="$1"; local prompt="$2" answer
  if [[ $INTERACTIVE -eq 0 ]]; then return; fi
  if [[ -n "$_out" ]]; then printf '%s [keep current]: ' "$prompt"; else printf '%s: ' "$prompt"; fi
  IFS= read -r -s answer < "$TTY" || answer=""
  printf '\n'
  # An empty answer keeps the current value. (Must not end in a failing test: set -e would stop the script.)
  if [[ -n "$answer" ]]; then _out="$answer"; fi
  return 0
}
ask_yn() { # ask_yn "Question" default(y|n) -> returns 0 for yes
  local prompt="$1" default="$2" answer
  if [[ $INTERACTIVE -eq 0 ]]; then [[ "$default" == y ]]; return; fi
  if [[ "$default" == y ]]; then printf '%s [Y/n]: ' "$prompt"; else printf '%s [y/N]: ' "$prompt"; fi
  IFS= read -r answer < "$TTY" || answer=""
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

# --- automatic updates (systemd timer + oneshot service running deploy/linux/auto-update.sh) ---------------------
auto_update_on() { systemctl is-enabled --quiet "$UPDATER.timer" 2>/dev/null; }
# Prints the first path in <install dir> (or a parent folder) that someone other than root could change, if any.
# The updater runs these files as root, so such a path would let that account run code as root.
unsafe_path() { # unsafe_path <install dir>
  local p="$1" bad
  bad="$(find "$1" \( -path "$1/data" -o -path "$1/.env" \) -prune -o ! -type l \( ! -user root -o -perm -o+w -o \( -perm -g+w ! -group root \) \) -print -quit 2>/dev/null)"
  if [[ -n "$bad" ]]; then echo "$bad"; return 0; fi
  while p="$(dirname "$p")"; [[ "$p" != / ]]; do
    if [[ -n "$(find "$p" -maxdepth 0 \( ! -user root -o -perm -o+w -o \( -perm -g+w ! -group root \) \) -print 2>/dev/null)" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 0
}
enable_auto_update() { # enable_auto_update <install dir>
  [[ -f "$1/deploy/linux/auto-update.sh" && -f "$1/scripts/self-update.js" ]] || die "$1 has no auto-updater (install a newer version first)."
  local bad
  bad="$(unsafe_path "$1")"
  [[ -z "$bad" ]] || die "$bad can be changed by an account other than root, and the auto-updater runs as root. Install to a folder only root can write (the installer's default /opt/$APP_NAME), not in place from a checkout."
  sed -e "s|__INSTALL_DIR__|$1|g" "$1/deploy/linux/$UPDATER.service" > "/etc/systemd/system/$UPDATER.service"
  cp "$1/deploy/linux/$UPDATER.timer" "/etc/systemd/system/$UPDATER.timer"
  chmod 644 "/etc/systemd/system/$UPDATER.service" "/etc/systemd/system/$UPDATER.timer"
  systemctl daemon-reload
  systemctl enable --now "$UPDATER.timer" >/dev/null 2>&1 || systemctl enable --now "$UPDATER.timer"
  ok "Automatic updates on: new releases are installed daily (log: journalctl -u $UPDATER)"
}
disable_auto_update() {
  systemctl disable --now "$UPDATER.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UPDATER.service" "/etc/systemd/system/$UPDATER.timer"
  systemctl daemon-reload
  ok "Automatic updates off"
}
dir_from_unit() { sed -n 's/^WorkingDirectory=//p' "/etc/systemd/system/$SERVICE.service" 2>/dev/null || true; }

if [[ $UPDATER_ONLY -eq 1 ]]; then
  INSTALL_DIR="${INSTALL_DIR:-$(dir_from_unit)}"
  INSTALL_DIR="${INSTALL_DIR:-/opt/$APP_NAME}"
  if [[ $AUTO_UPDATE -eq 1 ]]; then enable_auto_update "${INSTALL_DIR%/}"; else disable_auto_update; fi
  exit 0
fi

# --- uninstall ------------------------------------------------------------------------------------------------
if [[ $UNINSTALL -eq 1 ]]; then
  step "Removing the $SERVICE service"
  UNIT=/etc/systemd/system/$SERVICE.service
  DIR_FROM_UNIT="$(dir_from_unit)"
  INSTALL_DIR="${INSTALL_DIR:-${DIR_FROM_UNIT:-/opt/$APP_NAME}}"
  if [[ -f "/etc/systemd/system/$UPDATER.timer" ]]; then disable_auto_update; fi
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  ok "Service removed"
  if [[ -d "$INSTALL_DIR" ]]; then
    if [[ $PURGE -eq 1 ]] || ask_yn "Also delete $INSTALL_DIR (including .env and the data folder)?" n; then
      rm -rf "$INSTALL_DIR" "/etc/${APP_NAME:?}"; ok "Deleted $INSTALL_DIR"
    else
      say "  Files kept in $INSTALL_DIR"
    fi
  fi
  exit 0
fi

printf '\n%sFoundry VTT Discord integration — installer%s\n' "$BOLD" "$RESET"
say "${DIM}Press Enter to accept the value in [brackets].${RESET}"

# --- 1. where do the files come from? -------------------------------------------------------------------------
step "Locating the bot files"
if ! HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"; then HERE="$PWD"; fi
SOURCE=""
for candidate in "$HERE/../.." "$HERE" "$PWD"; do
  if [[ -f "$candidate/package.json" && -f "$candidate/src/index.js" ]]; then SOURCE="$(cd "$candidate" && pwd)"; break; fi
done
TMP=""
if [[ -z "$SOURCE" ]]; then
  command -v curl >/dev/null || die "curl is needed to download the release."
  if [[ "$VERSION" == "latest" ]]; then API="https://api.github.com/repos/$REPO/releases/latest"; else API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"; fi
  URL="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*-linux\.tar\.gz"' | head -n1 | sed 's/.*"\(http[^"]*\)"/\1/')"
  [[ -n "$URL" ]] || die "Could not find a Linux release bundle for $VERSION at https://github.com/$REPO/releases"
  say "  Downloading ${URL##*/}"
  TMP="$(mktemp -d)"; trap '[[ -n "$TMP" ]] && rm -rf "$TMP"' EXIT
  curl -fsSL "$URL" | tar -xz -C "$TMP"
  SOURCE="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  ok "Downloaded to a temporary folder"
else
  ok "Using the files in $SOURCE"
fi
BUNDLE_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SOURCE/package.json" | head -n1)"
say "  Version $BUNDLE_VERSION"

# --- 2. Node.js -------------------------------------------------------------------------------------------------
step "Checking Node.js"
node_ok() { command -v node >/dev/null && (( $(node -p 'process.versions.node.split(".")[0]') >= 20 )); }
if node_ok; then
  ok "Node.js $(node --version) found at $(command -v node)"
else
  if command -v node >/dev/null; then warn "Node.js $(node --version) is too old; version 20 or newer is required."; else warn "Node.js was not found."; fi
  if ask_yn "Install Node.js 22 (LTS) now from nodesource.com?" y; then
    if command -v apt-get >/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
    elif command -v dnf >/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs
    elif command -v yum >/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && yum install -y nodejs
    elif command -v pacman >/dev/null; then
      pacman -Sy --noconfirm nodejs npm
    elif command -v zypper >/dev/null; then
      zypper install -y nodejs22
    else
      die "No supported package manager found. Install Node.js 20+ from https://nodejs.org and run this installer again."
    fi
    node_ok || die "Node.js is still missing or too old after the installation."
    ok "Node.js $(node --version) installed"
  else
    die "Install Node.js 20 or newer (https://nodejs.org) and run this installer again."
  fi
fi
NODE="$(command -v node)"

# --- 3. find Foundry --------------------------------------------------------------------------------------------
step "Looking for a running Foundry VTT server"
FOUNDRY_PID="$(pgrep -f 'resources/app/main\.js' | head -n1 || true)"
DETECTED_USER=""; DETECTED_DATA=""; DETECTED_PORT=""; DETECTED_APP=""
if [[ -n "$FOUNDRY_PID" ]]; then
  DETECTED_USER="$(ps -o user= -p "$FOUNDRY_PID" | tr -d ' ')"
  CMDLINE="$(tr '\0' ' ' < "/proc/$FOUNDRY_PID/cmdline" 2>/dev/null || ps -o args= -p "$FOUNDRY_PID")"
  DETECTED_DATA="$(sed -n 's/.*--dataPath[= ]\([^ ]*\).*/\1/p' <<<"$CMDLINE")"
  DETECTED_PORT="$(sed -n 's/.*--port[= ]\([0-9]*\).*/\1/p' <<<"$CMDLINE")"
  MAIN_JS="$(grep -o '[^ ]*resources/app/main\.js' <<<"$CMDLINE" | head -n1)"
  if [[ -n "$MAIN_JS" ]]; then DETECTED_APP="$(cd "$(dirname "$MAIN_JS")/../.." 2>/dev/null && pwd)" || DETECTED_APP=""; fi
  ok "Foundry is running as user '$DETECTED_USER' (pid $FOUNDRY_PID)"
else
  warn "No running Foundry process found; you will be asked for its settings."
fi
if [[ -z "$DETECTED_DATA" ]]; then
  for d in /home/*/foundrydata /home/*/.local/share/FoundryVTT /root/.local/share/FoundryVTT /opt/foundrydata /foundrydata /data /srv/foundry/data; do
    if [[ -d "$d/Data" && -d "$d/Config" ]]; then DETECTED_DATA="$d"; break; fi
  done
fi
if [[ -n "$DETECTED_DATA" && -z "$DETECTED_PORT" && -f "$DETECTED_DATA/Config/options.json" ]]; then
  DETECTED_PORT="$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$DETECTED_DATA/Config/options.json" | head -n1)"
fi
[[ -n "$DETECTED_DATA" ]] && ok "Foundry data folder: $DETECTED_DATA"
[[ -n "$DETECTED_PORT" ]] && ok "Foundry port: $DETECTED_PORT"

# --- 4. settings ------------------------------------------------------------------------------------------------
step "Settings"
INSTALL_DIR="${INSTALL_DIR:-/opt/$APP_NAME}"
ask INSTALL_DIR "Install folder" "$INSTALL_DIR"
INSTALL_DIR="${INSTALL_DIR%/}"

# Existing configuration (upgrade): keep its values as defaults.
if [[ -f "$INSTALL_DIR/.env" ]]; then
  ok "Found an existing configuration in $INSTALL_DIR/.env; its values are the defaults below"
  read_env() { sed -n "s/^$1=\(.*\)$/\1/p" "$INSTALL_DIR/.env" | head -n1 | sed 's/^"\(.*\)"$/\1/'; }
  TOKEN="${TOKEN:-$(read_env DISCORD_TOKEN)}"
  CLIENT_ID="${CLIENT_ID:-$(read_env DISCORD_CLIENT_ID)}"
  GUILD_ID="${GUILD_ID:-$(read_env DISCORD_GUILD_ID)}"
  FOUNDRY_URL="${FOUNDRY_URL:-$(read_env FOUNDRY_URL)}"
  DATA_PATH="${DATA_PATH:-$(read_env FOUNDRY_DATA_PATH)}"
  APP_PATH="${APP_PATH:-$(read_env FOUNDRY_APP_PATH)}"
  TIMEZONE="${TIMEZONE:-$(read_env TIMEZONE)}"
  INTERVAL="${INTERVAL:-$(read_env POLL_INTERVAL_SECONDS)}"
  EXISTING_USER="$(sed -n 's/^User=//p' /etc/systemd/system/$SERVICE.service 2>/dev/null || true)"
  RUN_USER="${RUN_USER:-$EXISTING_USER}"
fi

DEFAULT_USER="${DETECTED_USER:-${SUDO_USER:-root}}"
hint() { if [[ $INTERACTIVE -eq 1 ]]; then say "$@"; fi; }
hint
hint "  The bot runs as a Linux user that must be able to read Foundry's data folder."
hint "  Using the same user as Foundry is the simplest choice."
ask RUN_USER "Run the bot as user" "$DEFAULT_USER"
id "$RUN_USER" >/dev/null 2>&1 || die "User '$RUN_USER' does not exist."

hint
hint "  Discord: create an application at https://discord.com/developers/applications,"
hint "  copy the Application ID (General Information) and the bot token (Bot → Reset Token), and turn on"
hint "  Server Members Intent under Bot → Privileged Gateway Intents (Discord refuses the bot without it)."
ask_secret TOKEN "Discord bot token (input hidden)"
[[ -n "$TOKEN" ]] || die "A Discord bot token is required (--token in non-interactive mode)."
ask CLIENT_ID "Discord application (client) ID"
[[ "$CLIENT_ID" =~ ^[0-9]{15,22}$ ]] || die "The application ID should be a number with 17–20 digits (got '$CLIENT_ID')."
hint "  ${DIM}Optional: your server's ID makes the slash commands appear instantly instead of within an hour.${RESET}"
ask GUILD_ID "Discord server ID (leave empty for all servers)" ""
[[ -z "$GUILD_ID" || "$GUILD_ID" =~ ^[0-9]{15,22}$ ]] || die "The server ID should be a number (got '$GUILD_ID')."

hint
ask FOUNDRY_URL "Foundry URL as seen from this machine" "http://localhost:${DETECTED_PORT:-30000}"
[[ "$FOUNDRY_URL" =~ ^https?:// ]] || die "The Foundry URL must start with http:// or https://"
ask DATA_PATH "Foundry user data folder (contains Config, Data, Logs)" "$DETECTED_DATA"
if [[ -n "$DATA_PATH" ]]; then
  DATA_PATH="${DATA_PATH%/}"
  [[ -d "$DATA_PATH" ]] || die "$DATA_PATH does not exist."
  [[ -d "$DATA_PATH/Data" || -d "$DATA_PATH/modules" ]] || warn "$DATA_PATH has no Data folder; update tracking will find nothing."
else
  warn "Without a data folder, system/module update tracking and world titles are off."
fi
ask APP_PATH "Foundry install folder (optional, shows the version while Foundry is down)" "$DETECTED_APP"

DEFAULT_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true)"
ask TIMEZONE "Timezone for restart windows (IANA name)" "${DEFAULT_TZ:-UTC}"
[[ -e "/usr/share/zoneinfo/$TIMEZONE" ]] || "$NODE" -e "new Intl.DateTimeFormat('en',{timeZone:process.argv[1]})" "$TIMEZONE" 2>/dev/null || die "Unknown timezone '$TIMEZONE' (example: Europe/Stockholm)."
ask INTERVAL "Check Foundry every N seconds" "30"
[[ "$INTERVAL" =~ ^[0-9]+$ && $INTERVAL -ge 5 ]] || die "The interval must be a whole number of at least 5 seconds."

if [[ -z "$AUTO_UPDATE" ]]; then
  if auto_update_on; then AUTO_DEFAULT=y; else AUTO_DEFAULT=n; fi
  if [[ $INTERACTIVE -eq 1 ]]; then
    hint
    hint "  Automatic updates check GitHub once a day and install a newer release the same way as"
    hint "  running this installer again (.env and data/ are kept; it rolls back if the update fails)."
    if ask_yn "Install new releases automatically?" "$AUTO_DEFAULT"; then AUTO_UPDATE=1; else AUTO_UPDATE=0; fi
  elif [[ $AUTO_DEFAULT == y ]]; then
    AUTO_UPDATE=1
  fi
fi

# --- 5. install files ----------------------------------------------------------------------------------------------
step "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ "$(cd "$SOURCE" && pwd)" != "$(cd "$INSTALL_DIR" && pwd)" ]]; then
  # Copy everything except local configuration and state, which are kept on upgrades.
  tar -C "$SOURCE" --exclude=./.env --exclude=./data --exclude=./.git -cf - . | tar -C "$INSTALL_DIR" --no-same-owner -xf -
  COPIED=1
  ok "Files copied"
else
  COPIED=0
  ok "Installing in place"
fi
umask 022
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  command -v npm >/dev/null || die "npm is needed to install dependencies (it comes with Node.js)."
  (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund)
  ok "Dependencies installed"
fi
if [[ $COPIED -eq 1 ]]; then
  # Program files belong to root (npm may hand node_modules to another owner): the auto-updater runs them as root,
  # so the bot's account must not be able to change them.
  chown root:root "$INSTALL_DIR"
  chmod go-w "$INSTALL_DIR"
  find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec chown -R root:root {} + -exec chmod -R go-w {} +
fi

umask 077
{
  echo "# Written by deploy/linux/install.sh on $(date -Is). Edit and run: sudo systemctl restart $SERVICE"
  echo "DISCORD_TOKEN=$TOKEN"
  echo "DISCORD_CLIENT_ID=$CLIENT_ID"
  echo "DISCORD_GUILD_ID=$GUILD_ID"
  echo "FOUNDRY_URL=$FOUNDRY_URL"
  echo "FOUNDRY_DATA_PATH=$DATA_PATH"
  echo "FOUNDRY_APP_PATH=$APP_PATH"
  echo "BOT_DATA_DIR=./data"
  echo "POLL_INTERVAL_SECONDS=$INTERVAL"
  echo "DOWN_AFTER_FAILURES=2"
  echo "TIMEZONE=$TIMEZONE"
  echo "LOG_LEVEL=info"
} > "$INSTALL_DIR/.env"
umask 022
mkdir -p "$INSTALL_DIR/data"
chown -R "$RUN_USER" "$INSTALL_DIR/data" "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"
ok "Configuration written to $INSTALL_DIR/.env"

step "Checking the configuration as $RUN_USER"
if (cd "$INSTALL_DIR" && sudo -u "$RUN_USER" "$NODE" scripts/check-config.js); then :; else die "The configuration check failed; fix the problem above and run the installer again."; fi
if ! curl -fsS -m 5 "${FOUNDRY_URL%/}/api/status" >/dev/null 2>&1; then
  warn "Foundry did not answer at $FOUNDRY_URL. The bot will report it as down until it does."
  ask_yn "Continue anyway?" y || die "Stopped. Check FOUNDRY_URL and run the installer again."
fi

# --- 6. systemd ----------------------------------------------------------------------------------------------------
step "Installing the systemd service"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__NODE__|$NODE|g" \
  "$INSTALL_DIR/deploy/linux/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || systemctl enable "$SERVICE"
ok "Service $SERVICE installed and enabled at boot"
if [[ $START -eq 1 ]]; then
  systemctl restart "$SERVICE"
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    ok "Service $SERVICE is running"
  else
    warn "The service is not running. Recent log:"
    journalctl -u "$SERVICE" -n 20 --no-pager || true
    die "Fix the problem (usually the Discord token) and run: sudo systemctl restart $SERVICE"
  fi
else
  say "  Not started (--no-start). Start it with: sudo systemctl start $SERVICE"
fi
if [[ $AUTO_UPDATE == 1 ]]; then
  enable_auto_update "$INSTALL_DIR"
elif [[ $AUTO_UPDATE == 0 && -f "/etc/systemd/system/$UPDATER.timer" ]]; then
  disable_auto_update
fi

# --- 7. done ---------------------------------------------------------------------------------------------------------
printf '\n%sInstalled.%s\n\n' "$GREEN$BOLD" "$RESET"
say "  Invite the bot to your Discord server (if you have not yet):"
say "    https://discord.com/oauth2/authorize?client_id=$CLIENT_ID&scope=bot+applications.commands&permissions=274878057472"
say
say "  Then, in Discord as a server administrator:"
say "    /channel set type:default              in the channel for messages"
say "    /channel set type:updates channel:#…   (optional) other channels per message type"
say "    /restart-window set start:04:00 duration:15   if Foundry restarts on a schedule"
say "    /test-message type:status              to check it can post"
say
say "  Useful commands:"
say "    sudo journalctl -u $SERVICE -f     follow the log"
say "    sudo systemctl restart $SERVICE    after editing $INSTALL_DIR/.env"
if [[ $AUTO_UPDATE == 1 ]]; then
  say "    sudo $INSTALL_DIR/deploy/linux/auto-update.sh --check     is there a newer release? (updates run daily)"
  say "    sudo $INSTALL_DIR/deploy/linux/install.sh --disable-auto-update"
else
  say "    sudo $INSTALL_DIR/deploy/linux/install.sh --enable-auto-update   install new releases automatically"
fi
say "    sudo $INSTALL_DIR/deploy/linux/install.sh --uninstall"
