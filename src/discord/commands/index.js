import * as channel from "./channel.js";
import * as modules from "./modules.js";
import * as monitor from "./monitor.js";
import * as restartWindow from "./restartWindow.js";
import * as updates from "./updates.js";
import * as status from "./status.js";
import * as testMessage from "./testMessage.js";
import * as campaign from "./campaign.js";
import * as session from "./session.js";
import * as planningPoll from "./planningPoll.js";
import * as gmRole from "./gmRole.js";

export const commands = [status, channel, monitor, restartWindow, updates, modules, testMessage, campaign, session, planningPoll, gmRole];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/** Does this (command, subcommand) need the Administrator permission? */
export function requiresAdmin(command, subcommand) {
  if (command.adminOnly) return true;
  return Boolean(subcommand && command.adminSubcommands?.has(subcommand));
}
