// Tiny leveled logger. Everything goes to stdout/stderr so systemd / Task
// Scheduler / a terminal can capture it.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;

export function setLogLevel(name) {
  const level = LEVELS[String(name ?? "").toLowerCase()];
  if (level === undefined) throw new Error(`Unknown log level "${name}" (use debug, info, warn or error)`);
  currentLevel = level;
}

function write(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}]`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(line, ...args);
}

export const log = {
  debug: (...args) => write("debug", args),
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
};
