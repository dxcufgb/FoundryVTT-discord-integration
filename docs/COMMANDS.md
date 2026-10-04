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
- `/updates check` — **admin.** Scan the data folder now.
- `/updates settings setting:<…> enabled:<true|false>` — **admin.** What counts as an update:
  - `foundry` — Foundry VTT version changes (default on)
  - `systems` — system version changes (default on)
  - `modules` — module version changes (default on)
  - `installed` — newly installed systems/modules (default on)
  - `removed` — removed systems/modules (default on)
- `/updates reset` — **admin.** Forget what has been announced and take the currently installed versions as the new starting point (nothing is posted).

Each update (a given package at a given version) is announced **once**. If Discord could not be reached, the announcement is retried on the next scan.

## `/test-message type:<type>` — admin

Posts a grey test message to the channel the given type resolves to, so you can check routing and permissions.
