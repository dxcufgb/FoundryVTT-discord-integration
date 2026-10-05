# Slash commands

All commands only work inside a server (not in DMs). Commands marked **admin** require the Discord **Administrator** permission in that server; Discord hides them from other members and the bot refuses them as well. Replies to configuration commands are only visible to the person who ran them.

## `/status` — everyone

Checks Foundry right now and shows: up or down (with the reason when down), Foundry version, active world (title and id), game system, users online, uptime, the next restart window and which monitors are on.

## `/channel` — admin

Where each **message type** is posted. Types:

| Type | Messages |
| --- | --- |
| `default` | Fallback for any type without its own channel. |
| `status` | Foundry down / back up. |
| `world` | World started, switched or shut down. |
| `updates` | Foundry, system and module updates (and installs/removals). |
| `restart` | Restart window opened; Foundry did not come back after the window. |

- `/channel set type:<type> [channel:#channel]` — post that type in the channel (defaults to the channel you are in). Text channels, announcement channels and threads are allowed.
- `/channel clear type:<type>` — stop posting that type (it falls back to `default` if set).
- `/channel list` — show the routing for this server.
- `/channel mention [role:@role]` — ping this role on unexpected downtime and when Foundry does not come back after a restart window. Without a role: stop pinging.

## `/monitor` — admin

- `/monitor enable what:<status|world|updates|all>` / `/monitor disable what:…` — turn a monitoring function on or off. With `status` off the bot keeps tracking Foundry (for `/status`) but posts nothing about downtime; with `updates` off version changes are recorded silently so they are not announced later either.
- `/monitor show` — current monitor settings and restart window.
- `/monitor check` — poll Foundry and scan for updates immediately.

## `/restart-window` — admin

Tell the bot when Foundry is *expected* to restart.

- `/restart-window set start:<HH:MM> duration:<minutes> [days:<daily|weekdays|weekends|mon,tue,…>] [timezone:<IANA>] [grace:<minutes>] [announce:<true|false>]`
  - `start` is local time in `timezone` (defaults to the bot's `TIMEZONE`). Daylight saving time is handled.
  - Downtime that starts inside the window is posted to the `restart` channel as 🔁 *Foundry is restarting*, and the return as 🟢 *Foundry is back after the scheduled restart*.
  - If Foundry is still down `grace` minutes (default 5) after the window ends, ⚠️ *Foundry did not come back after its restart window* is posted (pings the mention role).
  - `announce:true` posts 🕒 *Restart window open* when the window starts.
  - Windows may cross midnight (`start:23:50 duration:30`); the day filter applies to the day the window starts.
- `/restart-window show` — the window and when it next opens.
- `/restart-window clear` — remove it; all downtime is then reported as unexpected.

## `/updates`

- `/updates list [type:<systems|modules>]` — **everyone.** Installed systems and modules with their versions, plus the Foundry version.
- `/updates available [type:<foundry|systems|modules>]` — **everyone.** What is new on foundryvtt.com that fits the installed Foundry:
  - **Foundry VTT:** the latest build of the installed major version (for example 13.346 → 13.351) *and*, when one is out, the latest build of a newer major version (for example v14), each with a link to its release notes.
  - **Systems and modules:** for each package, the installed version → the newest published version that is compatible with the installed Foundry major version (versions that need a newer or older Foundry are ignored). Packages without such an update are not listed; a summary line names those whose newer releases need a different Foundry and those that could not be looked up. A version that the author has not *verified* for the installed major version, but that nothing rules out, is shown with ⚠️.
  - Package information comes from foundryvtt.com's package API, with the package's own `manifest` URL as a fallback; answers are cached for 30 minutes. The reply is only visible to you.
- `/updates compatibility [generation:<number>]` — **everyone.** Checks every installed system and module against a major Foundry version — by default the newest released one (so, on v13, against v14), or the one given — using the compatibility the packages declare (installed manifest and published versions):
  - ✅ **ready** — the installed version is verified for it
  - 🔼 **update first** — a newer release is (shows which version)
  - ⚠️ **untested** — nothing rules it out, but no version was verified for it
  - ❌ **not ready** — every release excludes it
  - ❔ **unknown** — no compatibility information anywhere
- `/updates check` — **admin.** Scan the data folder now.
- `/updates settings setting:<…> enabled:<true|false>` — **admin.** What counts as an update:
  - `foundry` — Foundry VTT version changes (default on)
  - `systems` — system version changes (default on)
  - `modules` — module version changes (default on)
  - `installed` — newly installed systems/modules (default on)
  - `removed` — removed systems/modules (default on)
- `/updates reset` — **admin.** Forget what has been announced and take the currently installed versions as the new starting point (nothing is posted).

Each update (a given package at a given version) is announced **once**. If Discord could not be reached, the announcement is retried on the next scan.

## `/modules` — everyone

Which installed modules the worlds on the server actually use. The bot reads each world's active-module list (`core.moduleConfiguration`) from the world's settings database (Foundry v11+ LevelDB, or the older NeDB file) without going through Foundry, so it works while Foundry is running. A module counts as **used** when it is enabled in at least one world or listed as a requirement in a world's manifest.

- `/modules unused` — installed modules that no world uses, with their versions. Worlds whose settings could not be read (for example a world that was never launched) are named, since modules used only there would be missed.
- `/modules usage` — every world with its system and number of active modules.
- `/modules usage module:<id>` — the worlds in which that module is active or required.

Replies are only visible to you.

## `/test-message type:<type>` — admin

Posts a grey test message to the channel the given type resolves to, so you can check routing and permissions.
