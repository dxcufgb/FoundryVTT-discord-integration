import { test } from "node:test";
import assert from "node:assert/strict";
import { createWindow, describeWindow, formatDays, isInsideWindow, localMidnight, parseDays, parseTime, tzOffsetMs, windowAt } from "../src/restartWindow.js";

test("parseTime accepts HH:MM and rejects nonsense", () => {
  assert.equal(parseTime("04:30"), 270);
  assert.equal(parseTime("0:05"), 5);
  assert.equal(parseTime("23:59"), 23 * 60 + 59);
  assert.throws(() => parseTime("24:00"), /out of range/);
  assert.throws(() => parseTime("4am"), /HH:MM/);
});

test("parseDays understands names, groups and daily", () => {
  assert.equal(parseDays("daily"), null);
  assert.equal(parseDays(""), null);
  assert.deepEqual(parseDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays("weekends"), [0, 6]);
  assert.deepEqual(parseDays("Mon, thursday sun"), [0, 1, 4]);
  assert.throws(() => parseDays("funday"), /Unknown day/);
  assert.equal(formatDays(null), "every day");
  assert.equal(formatDays([1, 2, 3, 4, 5]), "weekdays");
  assert.equal(formatDays([2, 4]), "Tue, Thu");
});

test("createWindow validates and describes", () => {
  const w = createWindow({ start: "04:00", durationMinutes: 15, timezone: "Europe/Stockholm" });
  assert.equal(w.start, 240);
  assert.match(describeWindow(w), /04:00–04:15 \(15 min\) every day, timezone Europe\/Stockholm/);
  assert.throws(() => createWindow({ start: "04:00", durationMinutes: 0, timezone: "UTC" }), /Duration/);
  assert.throws(() => createWindow({ start: "04:00", durationMinutes: 10, timezone: "Nowhere/Land" }), /timezone/);
  assert.throws(() => createWindow({ start: "04:00", durationMinutes: 10, timezone: "UTC", graceMinutes: -1 }), /Grace/);
});

test("timezone offset and local midnight handle DST", () => {
  const tz = "Europe/Stockholm";
  assert.equal(tzOffsetMs(new Date("2026-07-10T12:00:00Z"), tz), 2 * 3600_000);
  assert.equal(tzOffsetMs(new Date("2026-01-10T12:00:00Z"), tz), 1 * 3600_000);
  assert.equal(localMidnight(new Date("2026-07-10T12:00:00Z"), tz).toISOString(), "2026-07-09T22:00:00.000Z");
  assert.equal(localMidnight(new Date("2026-01-10T12:00:00Z"), tz).toISOString(), "2026-01-09T23:00:00.000Z");
  // 00:30 local on July 10 is 22:30Z on July 9: still July 10 locally
  assert.equal(localMidnight(new Date("2026-07-09T22:30:00Z"), tz).toISOString(), "2026-07-09T22:00:00.000Z");
});

test("windowAt finds the current occurrence in summer and winter", () => {
  const w = createWindow({ start: "04:00", durationMinutes: 15, timezone: "Europe/Stockholm" });
  const summer = windowAt(w, new Date("2026-07-10T02:05:00Z")); // 04:05 CEST
  assert.equal(summer.inside, true);
  assert.equal(summer.start.toISOString(), "2026-07-10T02:00:00.000Z");
  assert.equal(summer.end.toISOString(), "2026-07-10T02:15:00.000Z");
  const winter = windowAt(w, new Date("2026-01-10T03:14:59Z")); // 04:14:59 CET
  assert.equal(winter.inside, true);
  assert.equal(windowAt(w, new Date("2026-01-10T03:15:00Z")).inside, false, "end is exclusive");
  const next = windowAt(w, new Date("2026-01-10T10:00:00Z"));
  assert.equal(next.inside, false);
  assert.equal(next.start.toISOString(), "2026-01-11T03:00:00.000Z");
});

test("windows crossing midnight and limited to some days", () => {
  const w = createWindow({ start: "23:50", durationMinutes: 30, days: [1], timezone: "UTC" }); // Mondays 23:50-00:20
  assert.equal(isInsideWindow(w, new Date("2026-03-02T23:55:00Z")), true, "Monday evening");
  assert.equal(isInsideWindow(w, new Date("2026-03-03T00:10:00Z")), true, "Tuesday just after midnight still counts");
  assert.equal(isInsideWindow(w, new Date("2026-03-03T23:55:00Z")), false, "Tuesday evening is not a Monday");
  const at = windowAt(w, new Date("2026-03-04T12:00:00Z"));
  assert.equal(at.start.toISOString(), "2026-03-09T23:50:00.000Z", "next Monday");
  assert.equal(isInsideWindow(null, new Date()), false);
});
