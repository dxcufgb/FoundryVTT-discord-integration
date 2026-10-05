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
| `session` | Campaign messages: the world is ready to join (tags the players); the world is not up 15 minutes before a planned session (tags the DM). A campaign can override this with its own channel. |

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

## `/campaign`

A campaign belongs to this server and binds **exactly one Foundry world** (the folder name under `Data/worlds`) to **exactly one DM** and any number of players. Within a server a world can belong to only one campaign, so "the DM of that world" is unambiguous; a member can be in any number of campaigns. The `campaign` option of every subcommand autocompletes with the campaigns of the server; `world` autocompletes with the worlds found under `FOUNDRY_DATA_PATH` (without it, any well-formed world id is accepted).

- `/campaign create name:<name> world:<world id> dm:@user [channel:#channel]` — **admin.** Create a campaign. `channel` is where this campaign's `session` messages go (default: the server's `session` channel, or `default`). Bots cannot be DMs.
- `/campaign edit campaign:<name> [name:<new name>] [world:<world id>] [dm:@user] [channel:#channel] [clear-channel:true]` — **admin.** Change the campaign. A new DM who was a player stops being one.
- `/campaign delete campaign:<name>` — **admin.**
- `/campaign add-player campaign:<name> user:@user` / `/campaign remove-player …` — **DM of that campaign or admin.**
- `/campaign join campaign:<name>` / `/campaign leave campaign:<name>` — **everyone.** Join or leave as a player.
- `/campaign list` — **everyone.** Campaigns with world, DM, player count and next session; marks the ones you are in.
- `/campaign show campaign:<name>` — **everyone.** World, DM, players, next session and channel.

When the monitor reports that a campaign's world has started (🌍 *World started* in the `world` channel), the bot also posts 🎲 *The world is ready to join* in the campaign's `session` channel, tagging the players, with the planned session time if there is one. This follows the `world` monitor: with `/monitor disable what:world` nothing is posted.

## `/session`

Plan a campaign's next session. `set`, `event` and `clear` are for the **campaign's DM or an administrator**; `show` is for everyone.

- `/session set campaign:<name> when:<time> [timezone:<IANA>]` — `when` is local time in `timezone` (default: the bot's `TIMEZONE`): `2026-10-12 19:00`, `2026-10-12T19:00`, `today 19:00`, `tomorrow 19:00`, or a Discord timestamp such as `<t:1760295600:F>`. Must be in the future and at most a year away.
- `/session event campaign:<name> link:<event link>` — paste the link of a Discord **scheduled event** in this server (*Copy Event Link*: `https://discord.com/events/<server>/<event>`) or its id. The event's start time becomes the next session time. Run it again after moving the event.
- `/session clear campaign:<name>` — remove the planned session (and its pending reminder).
- `/session show [campaign:<name>]` — the next session of one campaign, or of every campaign in the server.

**15 minutes before** the planned time the bot checks (on its normal poll) whether Foundry is up *and* running the campaign's world. If not, it posts ⏰ *Session in 15 minutes, but the world is not up* to the campaign's `session` channel, tagging the DM and saying what is running instead (Foundry down, setup screen, another world). This is sent **once per planned time**; setting a new time arms it again. If the bot was offline at the 15-minute mark it still warns when it comes back before the session starts; after the start nothing is sent. A session stays visible as "started" for four hours and is then cleared, ready for the next one.

## `/test-message type:<type>` — admin

Posts a grey test message to the channel the given type resolves to, so you can check routing and permissions.
