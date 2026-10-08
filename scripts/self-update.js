// Is there a newer release of the bot? Used by the auto-updaters in deploy/linux and deploy/windows.
//
//   node scripts/self-update.js check    --platform <linux|windows-zip|windows-setup> [--dir <install dir>] [--token-file <file>]
//   node scripts/self-update.js download --platform <...> --out <empty dir> [--dir <install dir>] [--token-file <file>]
//
// Progress goes to stderr. The result goes to stdout as key=value lines for the calling script:
//   status=current|update|newer-installed, current=, latest=, tag=, asset=, and after a verified download file=<path>.
// Exit code 0 on success (whatever the status), 1 on any error.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO, readToken, runUpdate } from "../src/selfUpdate.js";

const [mode, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith("--") || rest[i + 1] === undefined) {
    console.error(`Bad argument: ${rest[i]}`);
    process.exit(1);
  }
  opts[rest[i].slice(2)] = rest[i + 1];
}
if (!["check", "download"].includes(mode) || !opts.platform || (mode === "download" && !opts.out)) {
  console.error("Usage: node scripts/self-update.js check|download --platform <linux|windows-zip|windows-setup> [--out <dir>] [--dir <install dir>] [--token-file <file>]");
  process.exit(1);
}
const log = { info: (m) => console.error(m), warn: (m) => console.error(`warning: ${m}`) };
try {
  const result = await runUpdate({
    dir: opts.dir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    platform: opts.platform,
    outDir: opts.out,
    checkOnly: mode === "check",
    repo: opts.repo ?? DEFAULT_REPO,
    token: readToken(opts["token-file"], log),
    log,
  });
  for (const [k, v] of Object.entries(result)) if (v !== undefined) console.log(`${k}=${v}`);
} catch (err) {
  console.error(`Update check failed: ${err.message}`);
  process.exit(1);
}
