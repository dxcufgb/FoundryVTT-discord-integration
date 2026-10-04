import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

const SETTINGS = Object.freeze({
  foundry: ["trackFoundry", "Announce Foundry VTT updates"],
  systems: ["trackSystems", "Announce system updates"],
  modules: ["trackModules", "Announce module updates"],
  installed: ["announceNewPackages", "Announce newly installed systems/modules"],
  removed: ["announceRemovedPackages", "Announce removed systems/modules"],
});

export const data = new SlashCommandBuilder()
  .setName("updates")
  .setDescription("Update tracking for Foundry, systems and modules")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("List installed systems and modules with their versions")
      .addStringOption((o) => o.setName("type").setDescription("Only systems or only modules").addChoices({ name: "systems", value: "system" }, { name: "modules", value: "module" })),
  )
  .addSubcommand((sub) => sub.setName("check").setDescription("Scan for updates right now (administrators only)"))
  .addSubcommand((sub) =>
    sub
      .setName("settings")
      .setDescription("Choose what counts as an update (administrators only)")
      .addStringOption((o) => o.setName("setting").setDescription("Setting").setRequired(true).addChoices(...Object.entries(SETTINGS).map(([k, [, label]]) => ({ name: `${k} – ${label}`, value: k }))))
      .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("reset").setDescription("Take the current versions as the new starting point, announcing nothing (admins only)"));

export const adminOnly = false;
export const adminSubcommands = new Set(["check", "settings", "reset"]);

export async function execute(interaction, { state, monitor }) {
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const filter = interaction.options.getString("type");
    const packages = Object.values(state.data.packages).filter((p) => !filter || p.type === filter);
    const f = state.data.foundry;
    const header = `**Foundry VTT** ${f.version ? `v${f.version}` : "(version unknown)"}`;
    if (!packages.length) return interaction.reply({ content: `${header}\nNo ${filter ? `${filter}s` : "systems or modules"} recorded yet. Is FOUNDRY_DATA_PATH set?`, flags: MessageFlags.Ephemeral });
    const lines = packages
      .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title))
      .map((p) => `• ${p.type === "system" ? "🎲" : "🧩"} **${p.title}** \`${p.id}\` – ${p.version ?? "?"}`);
    return interaction.reply({ content: truncate([header, ...lines].join("\n"), 1900), flags: MessageFlags.Ephemeral });
  }

  if (sub === "check") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await monitor.maybeScanPackages(true);
    return interaction.editReply({ content: `Scanned ${Object.keys(state.data.packages).length} installed systems/modules. Any new updates have been announced.` });
  }

  if (sub === "settings") {
    const [key, label] = SETTINGS[interaction.options.getString("setting", true)];
    const enabled = interaction.options.getBoolean("enabled", true);
    state.update((d) => {
      d.monitor.updates[key] = enabled;
    });
    return interaction.reply({ content: `${label}: **${enabled ? "on" : "off"}**.\n\n${describeUpdateSettings(state)}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "reset") {
    state.update((d) => {
      d.packages = {};
      d.packagesSeeded = false;
      d.notified = {};
    });
    await monitor.maybeScanPackages(true);
    return interaction.reply({ content: `Starting point reset: ${Object.keys(state.data.packages).length} installed systems/modules recorded, nothing announced.`, flags: MessageFlags.Ephemeral });
  }
}

export function describeUpdateSettings(state) {
  const u = state.data.monitor.updates;
  return Object.entries(SETTINGS).map(([k, [key, label]]) => `• **${k}** – ${label}: ${u[key] ? "on" : "off"}`).join("\n");
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
