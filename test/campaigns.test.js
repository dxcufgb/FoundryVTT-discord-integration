import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import {
  canManageCampaign, createCampaign, createSession, describeCampaign, isCurrentSession, parseEventLink, parseSessionTime, slugify, uniqueUsers, zonedToUtc,
} from "../src/campaigns.js";

const now = new Date("2026-03-01T12:00:00Z");

test("slugify and campaign creation", () => {
  assert.equal(slugify("The Lost Mines!"), "the-lost-mines");
  assert.equal(slugify("  Curse of Strahd  "), "curse-of-strahd");
  assert.equal(slugify("Åäö Éclair"), "aao-eclair");
  assert.throws(() => slugify("!!!"), /at least one letter/);

  const c = createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", players: ["p1", "p1", "dm1", "p2"] }, { now: () => now });
  assert.equal(c.id, "lost-mines");
  assert.equal(c.world, "lost-mines");
  assert.equal(c.dm, "dm1");
  assert.deepEqual(c.players, ["p1", "p2"], "de-duplicated, DM never a player");
  assert.equal(c.nextSession, null);
  assert.equal(c.createdAt, now.toISOString());

  assert.throws(() => createCampaign({ name: "", world: "w", dm: "d" }), /needs a name/);
  assert.throws(() => createCampaign({ name: "x", world: "", dm: "d" }), /needs a Foundry world/);
  assert.throws(() => createCampaign({ name: "x", world: "../etc", dm: "d" }), /does not look like a Foundry world id/);
  assert.throws(() => createCampaign({ name: "x", world: "w", dm: null }), /exactly one DM/);
  assert.deepEqual(uniqueUsers(["a", "b", "a"], "b"), ["a"]);
});

test("Discord event links and ids are recognised", () => {
  assert.deepEqual(parseEventLink("https://discord.com/events/123456789012345678/876543210987654321"), { guildId: "123456789012345678", eventId: "876543210987654321" });
  assert.deepEqual(parseEventLink("<https://ptb.discord.com/events/123456789012345678/876543210987654321?x=1>"), { guildId: "123456789012345678", eventId: "876543210987654321" });
  assert.deepEqual(parseEventLink("discordapp.com/events/123456789012345678/876543210987654321/"), { guildId: "123456789012345678", eventId: "876543210987654321" });
  assert.deepEqual(parseEventLink("876543210987654321"), { guildId: null, eventId: "876543210987654321" });
  assert.equal(parseEventLink("https://discord.com/channels/1/2"), null);
  assert.equal(parseEventLink("tomorrow"), null);
  assert.equal(parseEventLink(""), null);
});

test("session times: local wall clock in a timezone, DST, today/tomorrow, Discord timestamps", () => {
  const tz = "Europe/Stockholm";
  assert.equal(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 19, minute: 0 }, tz).toISOString(), "2026-07-01T17:00:00.000Z", "summer time");
  assert.equal(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 19, minute: 0 }, tz).toISOString(), "2026-12-01T18:00:00.000Z", "winter time");

  assert.equal(parseSessionTime("2026-07-01 19:00", tz, now).toISOString(), "2026-07-01T17:00:00.000Z");
  assert.equal(parseSessionTime("2026-07-01T19:00", tz, now).toISOString(), "2026-07-01T17:00:00.000Z");
  assert.equal(parseSessionTime("2026-07-01 at 19:00", tz, now).toISOString(), "2026-07-01T17:00:00.000Z");
  assert.equal(parseSessionTime("2026-07-01 19:00", "UTC", now).toISOString(), "2026-07-01T19:00:00.000Z");
  assert.equal(parseSessionTime("tomorrow 19:00", tz, now).toISOString(), "2026-03-02T18:00:00.000Z");
  assert.equal(parseSessionTime("today 20:30", tz, now).toISOString(), "2026-03-01T19:30:00.000Z");
  assert.equal(parseSessionTime("<t:1772391600:F>", tz, now).toISOString(), "2026-03-01T19:00:00.000Z");
  assert.equal(parseSessionTime("1772391600", tz, now).toISOString(), "2026-03-01T19:00:00.000Z");

  assert.throws(() => parseSessionTime("today 11:00", tz, now), /in the past/);
  assert.throws(() => parseSessionTime("2026-02-30 19:00", tz, now), /not a real date/);
  assert.throws(() => parseSessionTime("2026-03-05 25:00", tz, now), /out of range/);
  assert.throws(() => parseSessionTime("2028-03-05 19:00", tz, now), /more than a year/);
  assert.throws(() => parseSessionTime("next friday", tz, now), /Could not understand/);
  assert.throws(() => parseSessionTime("", tz, now), /No time given/);
  assert.throws(() => parseSessionTime("2026-07-01 19:00", "Mars/Olympus", now), /not a known IANA timezone/);
});

test("session records, currentness and permissions", () => {
  const s = createSession({ at: "2026-03-01T19:00:00Z", source: "event", eventId: "e1", eventUrl: "https://discord.com/events/g/e1", setBy: "dm" }, { now: () => now });
  assert.equal(s.at, "2026-03-01T19:00:00.000Z");
  assert.equal(s.setAt, now.toISOString());
  assert.equal(isCurrentSession(s, now), true);
  assert.equal(isCurrentSession(s, new Date("2026-03-01T22:59:00Z")), true, "a started session lingers");
  assert.equal(isCurrentSession(s, new Date("2026-03-01T23:00:00Z")), false);
  assert.equal(isCurrentSession(null, now), false);
  assert.throws(() => createSession({ at: "nope" }), /Invalid session time/);

  const campaign = createCampaign({ name: "C", world: "w", dm: "dm1" });
  const admin = { memberPermissions: { has: (f) => f === PermissionFlagsBits.Administrator }, user: { id: "someone" } };
  const dm = { memberPermissions: { has: () => false }, user: { id: "dm1" } };
  const player = { memberPermissions: { has: () => false }, user: { id: "p1" } };
  assert.equal(canManageCampaign(admin, campaign), true);
  assert.equal(canManageCampaign(dm, campaign), true);
  assert.equal(canManageCampaign(player, campaign), false);
  assert.equal(canManageCampaign(null, campaign), false);

  const text = describeCampaign({ ...campaign, players: ["p1"], nextSession: s, channel: "ch" }, { worldTitle: () => "World", now });
  assert.match(text, /\*\*World\*\* \(`w`\)/);
  assert.match(text, /DM: <@dm1>/);
  assert.match(text, /Players \(1\): <@p1>/);
  assert.match(text, /Next session <t:1772391600:F>.*\[Discord event\]/);
  assert.match(text, /<#ch>/);
});
