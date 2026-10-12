import { test } from "node:test";
import assert from "node:assert/strict";
import { SlashCommandBuilder } from "discord.js";
import { commandsHash, commandsRoute, registerCommands, syncCommands } from "../src/discord/registerCommands.js";
import { quietLog, tmpState } from "./helpers.js";

const commands = [{ data: new SlashCommandBuilder().setName("ping").setDescription("Pong") }, { data: new SlashCommandBuilder().setName("status").setDescription("Status") }];
const config = (guildId) => ({ discord: { token: "t", clientId: "app1", guildId } });

/** A fake discord.js REST client: records every PUT and fails the first `failures` registrations. */
function fakeRest({ failures = 0 } = {}) {
  const puts = [];
  return {
    puts,
    async put(route, { body }) {
      puts.push({ route, body });
      if (body.length && failures-- > 0) throw new Error("503 Service Unavailable");
      return body;
    },
  };
}
const noSleep = async () => {};

test("commandsRoute picks the guild route with a guild id and the global route without", () => {
  assert.equal(commandsRoute("app1", "g1"), "/applications/app1/guilds/g1/commands");
  assert.equal(commandsRoute("app1", undefined), "/applications/app1/commands");
  assert.equal(commandsRoute("app1", null), "/applications/app1/commands");
});

test("registerCommands puts the command JSON on the configured route", async () => {
  const rest = fakeRest();
  await registerCommands(config("g1"), commands, { rest, log: quietLog });
  assert.equal(rest.puts.length, 1);
  assert.equal(rest.puts[0].route, "/applications/app1/guilds/g1/commands");
  assert.deepEqual(rest.puts[0].body.map((c) => c.name), ["ping", "status"]);
});

test("syncCommands registers, records the registration and reports a change on the first run", async () => {
  const state = tmpState();
  const rest = fakeRest();
  const result = await syncCommands({ config: config(undefined), commands, state, version: "1.3.0", rest, log: quietLog, sleep: noSleep });
  assert.deepEqual(result, { status: "registered", count: 2, changed: true, movedFrom: null });
  assert.equal(rest.puts.length, 1, "nothing to remove on the first registration");
  assert.equal(rest.puts[0].route, "/applications/app1/commands");
  const body = commands.map((c) => c.data.toJSON());
  assert.equal(state.data.commands.guildId, null);
  assert.equal(state.data.commands.hash, commandsHash(body));
  assert.equal(state.data.commands.version, "1.3.0");
  assert.ok(Date.parse(state.data.commands.at) > 0);

  // Same commands again (a plain restart): registered again, but unchanged.
  const again = await syncCommands({ config: config(undefined), commands, state, version: "1.3.0", rest, log: quietLog, sleep: noSleep });
  assert.equal(again.changed, false);
  assert.equal(rest.puts.length, 2);
});

test("syncCommands reports changed definitions after an update and the new version is recorded", async () => {
  const state = tmpState();
  await syncCommands({ config: config("g1"), commands, state, version: "1.3.0", rest: fakeRest(), log: quietLog, sleep: noSleep });
  const more = [...commands, { data: new SlashCommandBuilder().setName("campaign").setDescription("Campaigns") }];
  const result = await syncCommands({ config: config("g1"), commands: more, state, version: "1.4.0", rest: fakeRest(), log: quietLog, sleep: noSleep });
  assert.equal(result.changed, true);
  assert.equal(result.count, 3);
  assert.equal(state.data.commands.version, "1.4.0");
});

test("syncCommands empties the set registered before when DISCORD_GUILD_ID changes", async () => {
  const state = tmpState();
  await syncCommands({ config: config(undefined), commands, state, rest: fakeRest(), log: quietLog, sleep: noSleep });

  // global -> guild: the global set is emptied first.
  let rest = fakeRest();
  let result = await syncCommands({ config: config("g1"), commands, state, rest, log: quietLog, sleep: noSleep });
  assert.equal(result.movedFrom, "global");
  assert.equal(result.changed, true);
  assert.deepEqual(rest.puts.map((p) => [p.route, p.body.length]), [["/applications/app1/commands", 0], ["/applications/app1/guilds/g1/commands", 2]]);
  assert.equal(state.data.commands.guildId, "g1");

  // guild -> another guild.
  rest = fakeRest();
  result = await syncCommands({ config: config("g2"), commands, state, rest, log: quietLog, sleep: noSleep });
  assert.equal(result.movedFrom, "g1");
  assert.deepEqual(rest.puts.map((p) => [p.route, p.body.length]), [["/applications/app1/guilds/g1/commands", 0], ["/applications/app1/guilds/g2/commands", 2]]);

  // guild -> global.
  rest = fakeRest();
  result = await syncCommands({ config: config(undefined), commands, state, rest, log: quietLog, sleep: noSleep });
  assert.equal(result.movedFrom, "g2");
  assert.deepEqual(rest.puts.map((p) => [p.route, p.body.length]), [["/applications/app1/guilds/g2/commands", 0], ["/applications/app1/commands", 2]]);
  assert.equal(state.data.commands.guildId, null);
});

test("syncCommands still registers when emptying the old set fails", async () => {
  const state = tmpState();
  await syncCommands({ config: config("g1"), commands, state, rest: fakeRest(), log: quietLog, sleep: noSleep });
  const rest = {
    puts: [],
    async put(route, { body }) {
      rest.puts.push(route);
      if (!body.length) throw new Error("Missing Access");
      return body;
    },
  };
  const warnings = [];
  const result = await syncCommands({ config: config(undefined), commands, state, rest, log: { ...quietLog, warn: (m) => warnings.push(m) }, sleep: noSleep });
  assert.equal(result.status, "registered");
  assert.equal(result.movedFrom, null);
  assert.equal(rest.puts.length, 2);
  assert.match(warnings[0], /Could not remove the slash commands registered in server g1/);
  assert.equal(state.data.commands.guildId, null);
});

test("syncCommands retries a failed registration with the configured delays", async () => {
  const state = tmpState();
  const rest = fakeRest({ failures: 2 });
  const slept = [];
  const result = await syncCommands({ config: config("g1"), commands, state, rest, log: quietLog, delays: [1, 2, 3], sleep: async (ms) => slept.push(ms) });
  assert.equal(result.status, "registered");
  assert.deepEqual(slept, [1, 2]);
  assert.equal(rest.puts.length, 3);
  assert.equal(state.data.commands.guildId, "g1");
});

test("syncCommands gives up after the last retry, keeps the previous record and never throws", async () => {
  const state = tmpState();
  await syncCommands({ config: config("g1"), commands, state, version: "1.3.0", rest: fakeRest(), log: quietLog, sleep: noSleep });
  const before = { ...state.data.commands };
  const errors = [];
  const result = await syncCommands({ config: config("g1"), commands, state, version: "1.4.0", rest: fakeRest({ failures: 10 }), log: { ...quietLog, error: (m) => errors.push(m) }, delays: [1, 1], sleep: noSleep });
  assert.deepEqual(result, { status: "failed" });
  assert.deepEqual(state.data.commands, before, "the failed registration is not recorded");
  assert.match(errors[0], /after 3 attempts/);
  assert.match(errors[0], /npm run register-commands/);

  // An unexpected error (here: a broken state store) is caught too.
  const broken = { data: {}, update: () => { throw new Error("disk full"); } };
  const r2 = await syncCommands({ config: config("g1"), commands, state: broken, rest: fakeRest(), log: { ...quietLog, error: (...m) => errors.push(m.join(" ")) }, sleep: noSleep });
  assert.deepEqual(r2, { status: "failed" });
  assert.match(String(errors.at(-1)), /disk full/);
});
