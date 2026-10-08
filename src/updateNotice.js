// After the bot itself was updated: DM the server admins once, with the release's changelog.
// The running version (package.json) is compared with the one recorded in state.json when the
// client is ready. First run: just record. Newer: record first (at most once, even if a DM
// fails or the process dies half way), then DM everyone once, listing their servers. The text
// comes from data/update-notice.json (written by the auto-updater from the GitHub release) when
// it matches the version, else from the installed CHANGELOG.md.

import fs from "node:fs";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { buildUpdateNoticeMessage } from "./messages.js";
import { compareSemver, parseVersion } from "./selfUpdate.js";

export const UPDATE_NOTIFY_MODES = Object.freeze(["admins", "owner", "off"]);
export const NOTICE_FILE = "update-notice.json";
const DMS_CLOSED = 50007;

/** The `## [x.y.z]` section of a Keep a Changelog file, without its heading and link references; null if absent. */
export function extractChangelogSection(text, version) {
  const want = parseVersion(version)?.version;
  if (!want) return null;
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const m = /^##\s+\[?v?([^\]\s]+)\]?/.exec(l);
    return m && parseVersion(m[1])?.version === want;
  });
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\[[^\]]+\]:\s*https?:/.test(line)) continue;
    body.push(line);
  }
  return body.join("\n").trim() || null;
}

/** Read and delete the updater's notice file; returns it only when it is for `version`. */
export function takeNoticeFile(file, version, log = console) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`Could not read ${file}: ${err.message}`);
    return null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.warn(`Could not delete ${file}: ${err.message}`);
  }
  try {
    const notice = JSON.parse(raw);
    return parseVersion(notice?.version)?.version === parseVersion(version)?.version ? notice : null;
  } catch {
    log.warn(`${file} is not valid JSON; ignoring it`);
    return null;
  }
}

/**
 * Who gets the DM: Map(userId -> server names). Owners always; with mode "admins" also every
 * (non-bot) member with the Administrator permission (needs the Server Members intent).
 */
export async function collectRecipients(guilds, { mode = "admins", log = console } = {}) {
  const recipients = new Map();
  const add = (id, name) => {
    if (!id) return;
    const list = recipients.get(id) ?? [];
    if (!list.includes(name)) list.push(name);
    recipients.set(id, list);
  };
  for (const guild of guilds) {
    add(guild.ownerId, guild.name);
    if (mode !== "admins") continue;
    try {
      const members = await guild.members.fetch();
      for (const m of members.values()) if (!m.user?.bot && m.permissions?.has(PermissionFlagsBits.Administrator)) add(m.id, guild.name);
    } catch (err) {
      log.warn(`Could not list the members of server ${guild.id} (${err?.code ?? err?.message ?? err}); only its owner gets the update notice.`);
    }
  }
  return recipients;
}

/** Changelog text, release link and title source for a version. */
export function noticeContent({ version, noticeFile, changelogFile, log = console }) {
  const notice = noticeFile ? takeNoticeFile(noticeFile, version, log) : null;
  if (notice?.body) return { changelog: String(notice.body), url: notice.html_url ?? null };
  let changelog = null;
  try {
    changelog = extractChangelogSection(fs.readFileSync(changelogFile, "utf8"), version);
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`Could not read ${changelogFile}: ${err.message}`);
  }
  return { changelog, url: notice?.html_url ?? null };
}

/**
 * Run once when the client is ready. Never throws.
 * @returns {Promise<{status: string, sent?: number, failed?: number}>}
 */
export async function announceUpdate({ client, state, version, mode = "admins", botDataDir, projectRoot, repoUrl, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 1000 }) {
  try {
    const previous = state.data.botVersion;
    if (!parseVersion(version)) return { status: "unknown-version" };
    if (previous === version) return { status: "same" };
    state.update((d) => {
      d.botVersion = version;
    });
    if (!previous || !parseVersion(previous)) {
      log.info(`Recorded bot version ${version}; admins are messaged after future updates.`);
      return { status: "first-run" };
    }
    if (compareSemver(version, previous) <= 0) return { status: "not-newer" };
    const { changelog, url } = noticeContent({ version, noticeFile: path.join(botDataDir, NOTICE_FILE), changelogFile: path.join(projectRoot, "CHANGELOG.md"), log });
    if (mode === "off") {
      log.info(`Updated from ${previous} to ${version}; UPDATE_NOTIFY=off, so no messages are sent.`);
      return { status: "off" };
    }
    const recipients = await collectRecipients([...client.guilds.cache.values()], { mode, log });
    log.info(`Updated from ${previous} to ${version}; sending the update notice to ${recipients.size} server admin(s).`);
    let sent = 0;
    let failed = 0;
    const releaseUrl = url ?? (repoUrl ? `${repoUrl}/releases/tag/v${version}` : null);
    for (const [userId, servers] of recipients) {
      if (sent + failed > 0) await sleep(pauseMs);
      try {
        const user = await client.users.fetch(userId);
        await user.send(buildUpdateNoticeMessage({ version, changelog, url: releaseUrl, servers }));
        sent++;
      } catch (err) {
        failed++;
        if (err?.code === DMS_CLOSED) log.info(`User ${userId} does not accept direct messages from the bot; skipped.`);
        else log.warn(`Could not send the update notice to user ${userId}: ${err?.code ?? ""} ${err?.message ?? err}`.trim());
      }
    }
    log.info(`Update notice sent to ${sent} of ${recipients.size} admin(s).`);
    return { status: "announced", sent, failed };
  } catch (err) {
    log.error("Update notice failed:", err?.message ?? err);
    return { status: "error" };
  }
}
