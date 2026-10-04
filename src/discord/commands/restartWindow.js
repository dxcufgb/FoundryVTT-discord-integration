import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { createWindow, describeWindow, parseDays, windowAt } from "../../restartWindow.js";
import { discordTime } from "../../messages.js";

export const data = new SlashCommandBuilder()
  .setName("restart-window")
  .setDescription("Tell the bot when Foundry is expected to restart (administrators only)")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the restart window")
      .addStringOption((o) => o.setName("start").setDescription("Start time, 24-hour HH:MM (e.g. 04:00)").setRequired(true))
      .addIntegerOption((o) => o.setName("duration").setDescription("Length in minutes").setRequired(true).setMinValue(1).setMaxValue(1440))
      .addStringOption((o) => o.setName("days").setDescription("daily, weekdays, weekends or e.g. mon,thu (default: daily)"))
      .addStringOption((o) => o.setName("timezone").setDescription("IANA timezone, e.g. Europe/Stockholm (default: the bot's TIMEZONE)"))
      .addIntegerOption((o) => o.setName("grace").setDescription("Minutes after the window before an alert is raised (default 5)").setMinValue(0).setMaxValue(1440))
      .addBooleanOption((o) => o.setName("announce").setDescription("Post a message when the window opens (default: no)")),
  )
  .addSubcommand((sub) => sub.setName("clear").setDescription("Remove the restart window"))
  .addSubcommand((sub) => sub.setName("show").setDescription("Show the restart window and when it next opens"));

export const adminOnly = true;

export async function execute(interaction, { state, config }) {
  const sub = interaction.options.getSubcommand();

  if (sub === "set") {
    let window;
    try {
      window = createWindow({
        start: interaction.options.getString("start", true),
        durationMinutes: interaction.options.getInteger("duration", true),
        days: parseDays(interaction.options.getString("days") ?? "daily"),
        timezone: interaction.options.getString("timezone") ?? config.timezone,
        graceMinutes: interaction.options.getInteger("grace") ?? 5,
        announceStart: interaction.options.getBoolean("announce") ?? false,
      });
    } catch (err) {
      return interaction.reply({ content: `That window is not valid: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    state.update((d) => {
      d.monitor.restartWindow = window;
    });
    return interaction.reply({ content: `Restart window set: ${describeWindow(window)}.\n${nextOpening(window)}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "clear") {
    const had = Boolean(state.data.monitor.restartWindow);
    state.update((d) => {
      d.monitor.restartWindow = null;
    });
    return interaction.reply({ content: had ? "Restart window removed. All downtime is now reported as unexpected." : "There was no restart window to remove.", flags: MessageFlags.Ephemeral });
  }

  const window = state.data.monitor.restartWindow;
  return interaction.reply({ content: window ? `${describeWindow(window)}.\n${nextOpening(window)}` : describeWindow(null), flags: MessageFlags.Ephemeral });
}

export function nextOpening(window, now = new Date()) {
  const at = windowAt(window, now);
  if (at.inside) return `The window is open right now (until ${discordTime(at.end, "t")}).`;
  if (!at.start) return "The window never opens with those days.";
  return `Next opening: ${discordTime(at.start, "F")} (${discordTime(at.start, "R")}).`;
}
