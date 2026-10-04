// Turns monitor events into Discord message payloads (plain objects: discord.js
// accepts raw embed JSON, which keeps this file free of Discord dependencies
// and easy to test). Also decides which message *type* an event belongs to,
// which the notifier maps to a channel per server.

export const COLORS = Object.freeze({
  red: 0xe74c3c,
  green: 0x2ecc71,
  orange: 0xf39c12,
  blue: 0x3498db,
  purple: 0x9b59b6,
  grey: 0x95a5a6,
});

/** Which message type (and so which channel) each event goes to. */
export const EVENT_MESSAGE_TYPE = Object.freeze({
  up: "status",
  down: "status",
  worldStarted: "world",
  worldStopped: "world",
  foundryUpdated: "updates",
  packageUpdated: "updates",
  packageInstalled: "updates",
  packageRemoved: "updates",
  restartWindowStarted: "restart",
  restartOverdue: "restart",
});

/** Events that should ping the configured alert role. */
export const MENTION_EVENTS = Object.freeze(new Set(["down", "restartOverdue"]));

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown";
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length || (!d && !h)) parts.push(`${s}s`);
  return parts.join(" ");
}

/** Discord's dynamic timestamp markup (renders in each reader's own timezone). */
export function discordTime(date, style = "f") {
  const d = date instanceof Date ? date : new Date(date);
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

function packageLabel(pkg) {
  const kind = pkg.type === "system" ? "System" : pkg.type === "module" ? "Module" : "Package";
  return `${kind} **${pkg.title}** (\`${pkg.id}\`)`;
}

function packageLinks(pkg) {
  const links = [];
  if (pkg.changelog) links.push(`[Changelog](${pkg.changelog})`);
  if (pkg.url) links.push(`[Project page](${pkg.url})`);
  return links.join(" · ");
}

/**
 * Build the Discord payload for an event.
 * @param {object} event  from FoundryMonitor
 * @param {{ now?: () => Date, worldTitle?: (id:string) => string|null, mentionRole?: string|null }} [ctx]
 * @returns {{ messageType: string, content?: string, embeds: object[] }}
 */
export function buildMessage(event, ctx = {}) {
  const now = (ctx.now ?? (() => new Date()))();
  const messageType = EVENT_MESSAGE_TYPE[event.type];
  if (!messageType) throw new Error(`No message defined for event type "${event.type}"`);
  const worldName = (id) => {
    const title = id ? ctx.worldTitle?.(id) : null;
    return title && title !== id ? `**${title}** (\`${id}\`)` : `**${id}**`;
  };
  let embed;

  switch (event.type) {
    case "down":
      embed = event.expected
        ? {
            title: "🔁 Foundry is restarting",
            description: `Foundry stopped answering inside the restart window (${discordTime(event.window.start, "t")}–${discordTime(event.window.end, "t")}). This is expected; you will be told when it is back.`,
            color: COLORS.blue,
          }
        : {
            title: "🔴 Foundry is down",
            description: "Foundry stopped answering and no restart was scheduled.",
            color: COLORS.red,
            fields: [{ name: "Reason", value: `\`${event.error ?? "no response"}\``, inline: false }],
          };
      break;

    case "up": {
      const status = event.status ?? {};
      const fields = [];
      if (event.downtimeMs !== null && event.downtimeMs !== undefined) fields.push({ name: "Downtime", value: formatDuration(event.downtimeMs), inline: true });
      if (status.version) fields.push({ name: "Foundry", value: `v${status.version}`, inline: true });
      fields.push({ name: "World", value: status.active && status.world ? worldName(status.world) : "none (setup screen)", inline: true });
      embed = {
        title: event.expected ? "🟢 Foundry is back after the scheduled restart" : "🟢 Foundry is back up",
        color: COLORS.green,
        fields,
      };
      break;
    }

    case "worldStarted": {
      const status = event.status ?? {};
      const fields = [];
      if (status.system) fields.push({ name: "System", value: status.systemVersion ? `${status.system} v${status.systemVersion}` : status.system, inline: true });
      if (status.version) fields.push({ name: "Foundry", value: `v${status.version}`, inline: true });
      embed = {
        title: "🌍 World started",
        description: event.previousWorld ? `Switched from ${worldName(event.previousWorld)} to ${worldName(event.world)}.` : `${worldName(event.world)} is now running.`,
        color: COLORS.purple,
        fields,
      };
      break;
    }

    case "worldStopped":
      embed = {
        title: "🌑 World shut down",
        description: `${worldName(event.world)} was returned to the setup screen.`,
        color: COLORS.grey,
      };
      break;

    case "foundryUpdated":
      embed = {
        title: "⬆️ Foundry VTT updated",
        description: event.previousVersion ? `Foundry was updated from **v${event.previousVersion}** to **v${event.version}**.` : `Foundry is now at **v${event.version}**.`,
        color: COLORS.orange,
      };
      break;

    case "packageUpdated": {
      const pkg = event.pkg;
      const links = packageLinks(pkg);
      embed = {
        title: pkg.type === "system" ? "⬆️ System updated" : "⬆️ Module updated",
        description: `${packageLabel(pkg)} was updated from **${pkg.previousVersion ?? "?"}** to **${pkg.version ?? "?"}**.${links ? `\n${links}` : ""}`,
        color: COLORS.orange,
        fields: pkg.compatibility ? [{ name: "Verified for Foundry", value: String(pkg.compatibility), inline: true }] : [],
      };
      break;
    }

    case "packageInstalled": {
      const pkg = event.pkg;
      const links = packageLinks(pkg);
      embed = {
        title: pkg.type === "system" ? "📦 System installed" : "📦 Module installed",
        description: `${packageLabel(pkg)} version **${pkg.version ?? "?"}** was installed.${links ? `\n${links}` : ""}`,
        color: COLORS.blue,
      };
      break;
    }

    case "packageRemoved":
      embed = {
        title: event.pkg.type === "system" ? "🗑️ System removed" : "🗑️ Module removed",
        description: `${packageLabel(event.pkg)} (was **${event.pkg.version ?? "?"}**) is no longer installed.`,
        color: COLORS.grey,
      };
      break;

    case "restartWindowStarted":
      embed = {
        title: "🕒 Restart window open",
        description: `Foundry may restart between ${discordTime(event.window.start, "t")} and ${discordTime(event.window.end, "t")}.`,
        color: COLORS.blue,
      };
      break;

    case "restartOverdue":
      embed = {
        title: "⚠️ Foundry did not come back after its restart window",
        description: `Foundry went down ${discordTime(event.downSince, "R")} during the restart window ending ${discordTime(event.window.end, "t")} and is still not answering.`,
        color: COLORS.red,
      };
      break;
  }

  embed.timestamp = now.toISOString();
  const payload = { messageType, embeds: [embed] };
  if (ctx.mentionRole && MENTION_EVENTS.has(event.type)) payload.content = `<@&${ctx.mentionRole}>`;
  return payload;
}
