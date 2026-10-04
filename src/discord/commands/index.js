import * as channel from "./channel.js";
import * as monitor from "./monitor.js";
import * as restartWindow from "./restartWindow.js";
import * as updates from "./updates.js";
import * as status from "./status.js";
import * as testMessage from "./testMessage.js";

export const commands = [status, channel, monitor, restartWindow, updates, testMessage];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/** Does this (command, subcommand) need the Administrator permission? */
export function requiresAdmin(command, subcommand) {
  if (command.adminOnly) return true;
  return Boolean(subcommand && command.adminSubcommands?.has(subcommand));
}
