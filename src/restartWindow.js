// Scheduled restart windows. A window is a daily (or some-days-of-the-week)
// span of local time in a given IANA timezone during which Foundry is expected
// to go down and come back up. Downtime inside a window is reported as an
// expected restart; downtime that outlasts the window raises an alert.

export const DAY_NAMES = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

/** "04:30" -> 270 minutes. Throws on anything that is not HH:MM. */
export function parseTime(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ""));
  if (!m) throw new Error(`Time "${text}" must be written as HH:MM (24-hour), for example 04:30`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Time "${text}" is out of range (00:00 to 23:59)`);
  return h * 60 + min;
}

/** "mon,wed,fri" / "daily" / "weekdays" / "weekends" -> array of weekday numbers (0 = Sunday) or null for every day. */
export function parseDays(text) {
  const t = String(text ?? "daily").trim().toLowerCase();
  if (t === "" || t === "daily" || t === "every day" || t === "everyday" || t === "all") return null;
  if (t === "weekdays") return [1, 2, 3, 4, 5];
  if (t === "weekends" || t === "weekend") return [0, 6];
  const days = new Set();
  for (const part of t.split(/[\s,]+/).filter(Boolean)) {
    const idx = DAY_NAMES.findIndex((d) => part.startsWith(d));
    if (idx === -1) throw new Error(`Unknown day "${part}" (use mon, tue, wed, thu, fri, sat, sun, daily, weekdays or weekends)`);
    days.add(idx);
  }
  return [...days].sort();
}

export function formatDays(days) {
  if (!days || days.length === 7) return "every day";
  if (days.join() === "1,2,3,4,5") return "weekdays";
  if (days.join() === "0,6") return "weekends";
  return days.map((d) => DAY_NAMES[d][0].toUpperCase() + DAY_NAMES[d].slice(1)).join(", ");
}

export function formatMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Build and validate a window definition.
 * @returns {{start:number, durationMinutes:number, days:number[]|null, timezone:string, announceStart:boolean, graceMinutes:number}}
 */
export function createWindow({ start, durationMinutes, days = null, timezone, announceStart = false, graceMinutes = 5 }) {
  const startMinutes = typeof start === "number" ? start : parseTime(start);
  const duration = Number(durationMinutes);
  if (!Number.isInteger(duration) || duration < 1 || duration > 24 * 60) throw new Error("Duration must be a whole number of minutes between 1 and 1440");
  const grace = Number(graceMinutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 24 * 60) throw new Error("Grace must be a whole number of minutes between 0 and 1440");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`"${timezone}" is not a known IANA timezone (example: Europe/Stockholm)`);
  }
  return { start: startMinutes, durationMinutes: duration, days: Array.isArray(days) ? [...days] : null, timezone, announceStart: Boolean(announceStart), graceMinutes: grace };
}

/** Wall-clock parts of `date` in `timezone`. */
export function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: DAY_NAMES.indexOf(parts.weekday.slice(0, 3).toLowerCase()),
  };
}

/** Milliseconds the timezone is ahead of UTC at `date` (e.g. +7_200_000 for CEST). */
export function tzOffsetMs(date, timezone) {
  const p = localParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight (local, in `timezone`) of the calendar day that contains `date`, shifted by `dayOffset` days, as a UTC Date. */
export function localMidnight(date, timezone, dayOffset = 0) {
  const p = localParts(date, timezone);
  // Approximate with the UTC calendar, then correct using the offset in force at that moment.
  const guess = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset, 0, 0, 0));
  const corrected = new Date(guess.getTime() - tzOffsetMs(guess, timezone));
  // DST transitions can move the offset between guess and corrected; one more pass settles it.
  return new Date(guess.getTime() - tzOffsetMs(corrected, timezone));
}

/**
 * Find the window occurrence that contains `date`, or the next one coming up.
 * @returns {{inside:boolean, start:Date, end:Date}} start/end of the current occurrence when inside, otherwise of the next one
 */
export function windowAt(window, date = new Date()) {
  const occurrences = [];
  for (const offset of [-1, 0, 1, 2, 3, 4, 5, 6, 7]) {
    const midnight = localMidnight(date, window.timezone, offset);
    const weekday = localParts(new Date(midnight.getTime() + 12 * 3600 * 1000), window.timezone).weekday;
    if (window.days && !window.days.includes(weekday)) continue;
    const start = new Date(midnight.getTime() + window.start * 60_000);
    const end = new Date(start.getTime() + window.durationMinutes * 60_000);
    occurrences.push({ start, end });
  }
  const t = date.getTime();
  const current = occurrences.find((o) => o.start.getTime() <= t && t < o.end.getTime());
  if (current) return { inside: true, ...current };
  const next = occurrences.find((o) => o.start.getTime() > t) ?? null;
  return { inside: false, start: next?.start ?? null, end: next?.end ?? null };
}

export function isInsideWindow(window, date = new Date()) {
  return Boolean(window) && windowAt(window, date).inside;
}

export function describeWindow(window) {
  if (!window) return "No restart window is set.";
  const end = (window.start + window.durationMinutes) % (24 * 60);
  return `${formatMinutes(window.start)}–${formatMinutes(end)} (${window.durationMinutes} min) ${formatDays(window.days)}, timezone ${window.timezone}` +
    `, grace ${window.graceMinutes} min, announce start: ${window.announceStart ? "yes" : "no"}`;
}
