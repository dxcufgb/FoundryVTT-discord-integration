// Set the password of the administration page (written to <BOT_DATA_DIR>/admin.json).
// Usage: npm run admin-password [-- --env <file>]
// Asks for the password twice (input hidden); without a terminal it reads one line from
// stdin, or takes FOUNDRY_DISCORD_ADMIN_PASSWORD. The password is never printed.
// Run as root (sudo), the file is given to the owner of the data folder so the bot can
// still change it from the page. The page also needs ADMIN_PORT in .env and a restart.
import fs from "node:fs";
import readline from "node:readline";
import { loadConfig } from "../src/config.js";
import { adminFile, hashPassword, loadAdminSettings, passwordProblem, saveAdminSettings } from "../src/admin/settings.js";

/** Read one line without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readStdinLine() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0];
}

let config;
try {
  config = loadConfig({ requireDiscord: false });
} catch {
  // The problems can quote values from .env; check-config lists them.
  console.error("The configuration (.env) has problems; run npm run check-config to see them.");
  process.exit(2);
}

let password = process.env.FOUNDRY_DISCORD_ADMIN_PASSWORD;
if (!password) {
  if (process.stdin.isTTY) {
    password = await askHidden("New password for the administration page: ");
    const again = await askHidden("Repeat it: ");
    if (password !== again) {
      console.error("The passwords do not match; nothing changed.");
      process.exit(1);
    }
  } else {
    password = await readStdinLine();
  }
}
const problem = passwordProblem(password);
if (problem) {
  console.error(`Not saved: ${problem}.`);
  process.exit(1);
}

const file = adminFile(config.botDataDir);
let settings;
try {
  settings = loadAdminSettings(file);
} catch (err) {
  console.error(`${err.message}; fix or delete it first.`);
  process.exit(1);
}
saveAdminSettings(file, { ...settings, passwordHash: await hashPassword(password) });
// As root: the bot's account owns the data folder and must be able to rewrite the file.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  try {
    const { uid, gid } = fs.statSync(config.botDataDir);
    fs.chownSync(file, uid, gid);
  } catch (err) {
    console.error(`Warning: could not give ${file} to the bot's account (${err.message}).`);
  }
}
console.log(`Password saved to ${file}.`);
if (!config.admin) console.log("The page is still off: set ADMIN_PORT in .env (for example ADMIN_PORT=8486), then restart the bot.");
else console.log(`Restart the bot if it is running; the page is on port ${config.admin.port}.`);
