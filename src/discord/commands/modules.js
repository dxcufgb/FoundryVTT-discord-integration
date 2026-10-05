import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { moduleUsage } from "../../foundry/worlds.js";
import { truncate } from "./updates.js";

export const data = new SlashCommandBuilder()
  .setName("modules")
  .setDescription("Which installed modules the worlds on this server actually use")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName("unused").setDescription("Modules that are not active in any world"))
  .addSubcommand((sub) =>
    sub
      .setName("usage")
      .setDescription("Active modules per world, or the worlds that use one module")
      .addStringOption((o) => o.setName("module").setDescription("Module id (as in /updates list), for example lib-wrapper")),
  );

export const adminOnly = false;

export async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  const modules = ctx.scanPackages().filter((p) => p.type === "module");
  const worlds = ctx.worldsWithModules();
  if (!worlds.length || !modules.length) {
    return interaction.reply({ content: `No ${!worlds.length ? "worlds" : "modules"} found in Foundry's data folder. Is FOUNDRY_DATA_PATH set?`, flags: MessageFlags.Ephemeral });
  }
  const result = moduleUsage(modules, worlds);
  const content = sub === "unused" ? describeUnused(result, modules.length) : describeUsage(result, interaction.options.getString("module"));
  return interaction.reply({ content: truncate(content, 1900), flags: MessageFlags.Ephemeral });
}

function worldLabel(w) {
  return w.title && w.title !== w.id ? `${w.title} (\`${w.id}\`)` : `\`${w.id}\``;
}

function unreadableNote(result) {
  if (!result.unreadable.length) return "";
  return `\n\n⚠️ Could not read the module settings of ${result.unreadable.map((w) => `\`${w.id}\` (${w.reason})`).join(", ")}; modules used only there may be listed as unused.`;
}

/** @param {ReturnType<typeof moduleUsage>} result */
export function describeUnused(result, installedCount) {
  const checked = result.worlds.length - result.unreadable.length;
  const header = `🧩 **Modules not active in any world** – ${result.unused.length} of ${installedCount} installed (${checked} of ${result.worlds.length} worlds checked)`;
  if (!result.unused.length) return `${header}\nEvery installed module is active in, or required by, at least one world.${unreadableNote(result)}`;
  const lines = result.unused.map((m) => `• **${m.title}** \`${m.id}\` – ${m.version ?? "?"}`);
  return `${header}\n${lines.join("\n")}\n\nA module counts as used when it is enabled in a world or listed as a requirement in a world's manifest.${unreadableNote(result)}`;
}

/** @param {ReturnType<typeof moduleUsage>} result */
export function describeUsage(result, moduleId) {
  if (moduleId) {
    const id = moduleId.trim();
    const u = result.usage.find((m) => m.id === id) ?? result.usage.find((m) => m.title.toLowerCase() === id.toLowerCase());
    if (!u) return `No installed module with the id \`${id}\`. Use \`/updates list type:modules\` to see the ids.`;
    const byId = Object.fromEntries(result.worlds.map((w) => [w.id, w]));
    const active = u.activeIn.map((w) => worldLabel(byId[w] ?? { id: w }));
    const required = u.requiredBy.map((w) => worldLabel(byId[w] ?? { id: w }));
    const lines = [`🧩 **${u.title}** \`${u.id}\` – ${u.version ?? "?"}`];
    lines.push(active.length ? `Active in ${active.length} world${active.length === 1 ? "" : "s"}: ${active.join(", ")}` : "Not active in any world.");
    if (required.length) lines.push(`Required by the manifest of: ${required.join(", ")}`);
    return lines.join("\n") + unreadableNote(result);
  }
  const lines = result.worlds.map((w) => `• 🌍 **${w.title}** \`${w.id}\`${w.system ? ` – ${w.system}` : ""}: ${w.activeModules === null ? "settings unreadable" : `${w.activeModules} active module${w.activeModules === 1 ? "" : "s"}`}`);
  return `🌍 **Worlds on this server** (${result.worlds.length})\n${lines.join("\n")}\n\nUnused modules: ${result.unused.length} (see \`/modules unused\`). \`/modules usage module:<id>\` shows where one module is used.${unreadableNote(result)}`;
}
