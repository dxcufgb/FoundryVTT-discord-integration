import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { MONITORS } from "../../state.js";
import { describeWindow } from "../../restartWindow.js";

const MONITOR_DESCRIPTIONS = Object.freeze({
  status: "Foundry going down and coming back up",
  world: "Worlds being started or shut down",
  updates: "Updates to Foundry, systems and modules",
});

const monitorChoices = [...MONITORS.map((m) => ({ name: `${m} – ${MONITOR_DESCRIPTIONS[m]}`, value: m })), { name: "all", value: "all" }];

export const data = new SlashCommandBuilder()
  .setName("monitor")
  .setDescription("Turn the monitoring functions on or off (administrators only)")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName("enable").setDescription("Turn a monitor on").addStringOption((o) => o.setName("what").setDescription("Monitor").setRequired(true).addChoices(...monitorChoices)),
  )
  .addSubcommand((sub) =>
    sub.setName("disable").setDescription("Turn a monitor off").addStringOption((o) => o.setName("what").setDescription("Monitor").setRequired(true).addChoices(...monitorChoices)),
  )
  .addSubcommand((sub) => sub.setName("show").setDescription("Show which monitors are on"))
  .addSubcommand((sub) => sub.setName("check").setDescription("Check Foundry right now instead of waiting for the next poll"));

export const adminOnly = true;

export async function execute(interaction, { state, monitor }) {
  const sub = interaction.options.getSubcommand();

  if (sub === "enable" || sub === "disable") {
    const what = interaction.options.getString("what", true);
    const value = sub === "enable";
    const targets = what === "all" ? MONITORS : [what];
    state.update((d) => {
      for (const t of targets) d.monitor.enabled[t] = value;
    });
    return interaction.reply({ content: `${targets.map((t) => `**${t}**`).join(", ")} monitoring is now **${value ? "on" : "off"}**.\n\n${describeMonitors(state)}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "check") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await monitor.tick();
    await monitor.maybeScanPackages(true);
    const f = state.data.foundry;
    return interaction.editReply({ content: `Checked. Foundry is **${f.status ?? "unknown"}**${f.version ? ` (v${f.version})` : ""}, world: **${f.world ?? "none"}**. Any changes have been announced.` });
  }

  return interaction.reply({ content: describeMonitors(state), flags: MessageFlags.Ephemeral });
}

export function describeMonitors(state) {
  const m = state.data.monitor;
  const lines = MONITORS.map((t) => `• **${t}** – ${MONITOR_DESCRIPTIONS[t]}: ${m.enabled[t] ? "on" : "off"}`);
  lines.push(`• Restart window: ${describeWindow(m.restartWindow)}`);
  return lines.join("\n");
}
