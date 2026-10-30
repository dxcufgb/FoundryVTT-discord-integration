# Foundry VTT Discord integration

<p align="center"><img src="assets/icon.png" alt="FoundryVTT Discord integration logo" width="128" height="128"></p>

[![Foundry v13](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-discord-integration?label=Foundry%20v13&logo=foundryvirtualtabletop&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/dxcufgb)\
[![CI](https://img.shields.io/github/actions/workflow/status/dxcufgb/FoundryVTT-discord-integration/ci.yml?branch=main&label=CI)](https://github.com/dxcufgb/FoundryVTT-discord-integration/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/dxcufgb/FoundryVTT-discord-integration)](LICENSE)

<a href="https://dxcufgb.github.io/FVTT-dev-showcase/"><img src="https://dxcufgb.github.io/FVTT-dev-showcase/assets/img/workshop-badge.png" alt="Dxcufgb's Workshop: every Foundry VTT project, video and changelog in one place" width="650"></a>

A small Discord bot that watches a [Foundry VTT](https://foundryvtt.com) **v13** server running on the same machine and tells your Discord server what is going on.

**Foundry VTT:** v13 · **Node.js:** 20 or newer · **Discord:** slash commands, no message content access needed

## Installation

You need a Discord application and bot first; see [Discord Application Setup](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Discord-Application-Setup).

On Linux, on the machine that runs Foundry:

```
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundryvtt-discord-integration
```

On Windows, run `foundryvtt-discord-integration-setup.exe` from the [latest release](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest).

Installer options, the manual download and automatic updates: [Install on Linux](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Install-on-Linux) and [Install on Windows](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Install-on-Windows) in the wiki. Running from source: [Configuration Reference](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Configuration-Reference#running-from-source).

## Documentation

The full guide is in the [wiki](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki):

- [Discord Application Setup](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Discord-Application-Setup): the application, bot token and intent
- [Install on Linux](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Install-on-Linux) and [Install on Windows](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Install-on-Windows): installers and their options
- [Messages and Channels](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Messages-and-Channels): what is posted, where, and restart windows
- [Commands](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Commands): every slash command and who may use it
- [Campaigns and Sessions](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Campaigns-and-Sessions): campaigns, players, DMs and session reminders
- [Session Summaries](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Session-Summaries): posting the summaries of the [Session Summary module](https://github.com/dxcufgb/FoundryVTT-session-summary)
- [Package Updates and Modules](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Package-Updates-and-Modules): update announcements, compatibility, unused modules
- [Admin Page](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Admin-Page): the optional web page, and the icon / bot avatar
- [Automatic Updates](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Automatic-Updates): opt-in daily updates and the changelog message
- [Configuration Reference](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/Configuration-Reference): every `.env` setting
- [How It Works](https://github.com/dxcufgb/FoundryVTT-discord-integration/wiki/How-It-Works): polling, update scans and the state file

## Development

```
npm ci
npm test            # unit tests (node:test, no extra tooling)
npm start           # run the bot with the .env in this folder
```

Security scans (`.github/workflows/security.yml`: on pushes to `main`, pull requests and weekly; all three are required checks) can be run locally the same way:

```
gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .
semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash
npm audit --omit=dev --audit-level=low
```

A Semgrep false positive gets a `// nosemgrep: <rule-id>` comment (`# nosemgrep: <rule-id>` in shell, YAML and PowerShell) with a reason, on the matched line or the line before it; a gitleaks false positive goes into `.gitleaks.toml`, which must keep `[extend]` `useDefault = true`. GitHub's CodeQL and secret scanning also run on this repository.

Tests cover the configuration loader, the state store, restart-window maths (including DST and windows that cross midnight), update detection and the announce-once guarantee, the up/down state machine, message routing, the administrator check on commands, the LevelDB reader (against databases written by Foundry's own LevelDB binding, see `scripts/make-leveldb-fixtures.js`), world/module usage, the compatibility and update logic (with a fake foundryvtt.com), campaigns and the session reminders (time parsing in a timezone, Discord event links, the 15-minute world check, world-ready pings), session summaries (missing, empty and broken files, which summaries are due, posting once per channel, retries), the administration page (login, lockout, CSRF and host checks, settings, HTTPS) and the self-updater's release check (semantic version order, asset choice, checksum parsing and verification, the token staying on api.github.com, with a fake GitHub). CI runs them on Linux and Windows with Node 20 and 22, runs the Linux installer against a real systemd (including an automatic update to the latest release through the systemd timer's service), and compiles, silently installs, auto-updates and uninstalls the Windows setup.

### Releasing

**Actions → Release → Run workflow → type the version** (e.g. `1.2.3`; `1.2.3-rc.1` makes a pre-release). Fallback: publish a release `vX.Y.Z` on GitHub, the files are attached afterwards. No version bump in the code: the version comes from the tag. Details: **[docs/RELEASING.md](docs/RELEASING.md)**.

## License

[MIT](LICENSE)
