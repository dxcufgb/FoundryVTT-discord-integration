import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { COLORS, discordTime, formatDuration } from "../../messages.js";
import { windowAt } from "../../restartWindow.js";

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("How Foundry is doing right now")
  .setContexts(InteractionContextType.Guild);

export const adminOnly = false;

export async function execute(interaction, ctx) {
  await interaction.deferReply();
  const result = await ctx.fetchStatus();
  return interaction.editReply({ embeds: [buildStatusEmbed(result, ctx)] });
}

export function buildStatusEmbed(result, { state, worldTitle = () => null, now = () => new Date(), config }) {
  const f = state.data.foundry;
  const m = state.data.monitor;
  const fields = [];
  let title;
  let color;

  if (result.ok) {
    const s = result.status;
    title = "🟢 Foundry is up";
    color = COLORS.green;
    if (s.version) fields.push({ name: "Foundry", value: `v${s.version}`, inline: true });
    if (s.active && s.world) {
      const t = worldTitle(s.world);
      fields.push({ name: "World", value: t && t !== s.world ? `${t} (\`${s.world}\`)` : `\`${s.world}\``, inline: true });
      if (s.system) fields.push({ name: "System", value: s.systemVersion ? `${s.system} v${s.systemVersion}` : s.system, inline: true });
      if (s.users !== null) fields.push({ name: "Users online", value: String(s.users), inline: true });
    } else {
      fields.push({ name: "World", value: "none (setup screen)", inline: true });
    }
    if (s.uptime !== null) fields.push({ name: "Uptime", value: formatDuration(s.uptime * 1000), inline: true });
    else if (f.status === "up" && f.since) fields.push({ name: "Up since", value: discordTime(f.since, "f"), inline: true });
  } else {
    title = "🔴 Foundry is down";
    color = COLORS.red;
    fields.push({ name: "Reason", value: `\`${result.error}\``, inline: true });
    if (f.status === "down" && f.since) fields.push({ name: "Down since", value: `${discordTime(f.since, "f")} (${discordTime(f.since, "R")})`, inline: true });
    if (f.version) fields.push({ name: "Last known version", value: `v${f.version}`, inline: true });
  }

  if (m.restartWindow) {
    const at = windowAt(m.restartWindow, now());
    fields.push({ name: "Restart window", value: at.inside ? `open now, until ${discordTime(at.end, "t")}` : at.start ? `next ${discordTime(at.start, "F")}` : "never", inline: false });
  }
  const monitors = Object.entries(m.enabled).filter(([, on]) => on).map(([k]) => k);
  fields.push({ name: "Monitoring", value: monitors.length ? monitors.join(", ") : "everything off", inline: false });

  return { title, color, fields, footer: { text: config?.foundry?.url ?? "" }, timestamp: now().toISOString() };
}
