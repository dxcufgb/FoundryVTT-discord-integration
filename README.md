# Foundry VTT Discord integration

<p align="center"><img src="assets/icon.png" alt="FoundryVTT Discord integration logo" width="128" height="128"></p>

[![Foundry v13](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-discord-integration?label=Foundry%20v13&logo=foundryvirtualtabletop&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dxcufgb/FoundryVTT-discord-integration/total?label=downloads&color=blue)](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases)
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

## License

[MIT](LICENSE)
