import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { COLORS } from "../../messages.js";
import { buildOf, describeCompatibility, findAvailableUpdates, generationOf, majorUpgradeReport, summariseReleases } from "../../foundry/releases.js";
import { compareVersions } from "../../foundry/updates.js";

const SETTINGS = Object.freeze({
  foundry: ["trackFoundry", "Announce Foundry VTT updates"],
  systems: ["trackSystems", "Announce system updates"],
  modules: ["trackModules", "Announce module updates"],
  installed: ["announceNewPackages", "Announce newly installed systems/modules"],
  removed: ["announceRemovedPackages", "Announce removed systems/modules"],
});

export const data = new SlashCommandBuilder()
  .setName("updates")
  .setDescription("Update tracking for Foundry, systems and modules")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("List installed systems and modules with their versions")
      .addStringOption((o) => o.setName("type").setDescription("Only systems or only modules").addChoices({ name: "systems", value: "system" }, { name: "modules", value: "module" })),
  )
  .addSubcommand((sub) =>
    sub
      .setName("available")
      .setDescription("Updates on foundryvtt.com that fit the installed Foundry version (and newer Foundry builds)")
      .addStringOption((o) => o.setName("type").setDescription("Only Foundry itself, only systems or only modules").addChoices({ name: "foundry", value: "foundry" }, { name: "systems", value: "system" }, { name: "modules", value: "module" }))
      .addBooleanOption((o) => o.setName("changes").setDescription("One message per update, with the changelogs of every version between installed and latest")),
  )
  .addSubcommand((sub) =>
    sub
      .setName("compatibility")
      .setDescription("Would the installed systems and modules work on the next major Foundry version?")
      .addIntegerOption((o) => o.setName("generation").setDescription("Foundry major version to check against (default: the newest released one)").setMinValue(1).setMaxValue(99)),
  )
  .addSubcommand((sub) => sub.setName("check").setDescription("Scan for updates right now (administrators only)"))
  .addSubcommand((sub) =>
    sub
      .setName("settings")
      .setDescription("Choose what counts as an update (administrators only)")
      .addStringOption((o) => o.setName("setting").setDescription("Setting").setRequired(true).addChoices(...Object.entries(SETTINGS).map(([k, [, label]]) => ({ name: `${k} – ${label}`, value: k }))))
      .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("reset").setDescription("Take the current versions as the new starting point, announcing nothing (admins only)"));

export const adminOnly = false;
export const adminSubcommands = new Set(["check", "settings", "reset"]);

export async function execute(interaction, ctx) {
  const { state, monitor } = ctx;
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const filter = interaction.options.getString("type");
    const packages = Object.values(state.data.packages).filter((p) => !filter || p.type === filter);
    const f = state.data.foundry;
    const header = `**Foundry VTT** ${f.version ? `v${f.version}` : "(version unknown)"}`;
    if (!packages.length) return interaction.reply({ content: `${header}\nNo ${filter ? `${filter}s` : "systems or modules"} recorded yet. Is FOUNDRY_DATA_PATH set?`, flags: MessageFlags.Ephemeral });
    const lines = packages
      .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title))
      .map((p) => `• ${p.type === "system" ? "🎲" : "🧩"} **${p.title}** \`${p.id}\` – ${p.version ?? "?"}`);
    return interaction.reply({ content: truncate([header, ...lines].join("\n"), 1900), flags: MessageFlags.Ephemeral });
  }

  if (sub === "available") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const filter = interaction.options.getString("type");
    if (interaction.options.getBoolean("changes")) {
      const embeds = await buildUpdateChangesEmbeds(ctx, filter);
      const [first, ...rest] = embeds;
      await interaction.editReply({ embeds: [first] });
      for (const embed of rest) await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = await buildAvailableUpdatesEmbed(ctx, filter);
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "compatibility") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = await buildCompatibilityEmbed(ctx, interaction.options.getInteger("generation"));
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === "check") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await monitor.maybeScanPackages(true);
    return interaction.editReply({ content: `Scanned ${Object.keys(state.data.packages).length} installed systems/modules. Any new updates have been announced.` });
  }

  if (sub === "settings") {
    const [key, label] = SETTINGS[interaction.options.getString("setting", true)];
    const enabled = interaction.options.getBoolean("enabled", true);
    state.update((d) => {
      d.monitor.updates[key] = enabled;
    });
    return interaction.reply({ content: `${label}: **${enabled ? "on" : "off"}**.\n\n${describeUpdateSettings(state)}`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "reset") {
    state.update((d) => {
      d.packages = {};
      d.packagesSeeded = false;
      d.notified = {};
    });
    await monitor.maybeScanPackages(true);
    return interaction.reply({ content: `Starting point reset: ${Object.keys(state.data.packages).length} installed systems/modules recorded, nothing announced.`, flags: MessageFlags.Ephemeral });
  }
}

// --- /updates available -----------------------------------------------------------------

/** The Foundry version the bot believes is installed: from the last status answer, else the install folder. */
export function installedFoundryVersion(ctx) {
  return ctx.state.data.foundry.version ?? ctx.readFoundryVersion?.() ?? null;
}

const icon = (pkg) => (pkg.type === "system" ? "🎲" : "🧩");
const names = (entries, max = 12) => {
  const list = entries.map((e) => `\`${e.pkg.id}\``);
  return list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
};

/**
 * Foundry's own line(s): newer build in the installed generation, and newer generation.
 * @returns {Promise<{lines:string[], summary:object|null}>}
 */
export async function describeFoundryReleases(ctx, installed) {
  const site = ctx.website;
  const result = await site.getReleases();
  const label = `**Foundry VTT** ${installed ? `v${installed}` : "(installed version unknown)"}`;
  if (!result.ok) return { lines: [`${label} – could not check ${site.releasesUrl()} (${result.error}).`], summary: null };
  const s = summariseReleases(result.releases, installed);
  const lines = [];
  if (s.generation === null) {
    lines.push(`${label} – newest release: **v${result.releases[0].version}** ([release notes](${site.releaseNotesUrl(result.releases[0].version)})).`);
  } else if (s.buildUpdate) {
    lines.push(`${label} → **v${s.buildUpdate.version}** is the latest v${s.generation} build ([release notes](${site.releaseNotesUrl(s.buildUpdate.version)})).`);
  } else if (s.latestInGeneration) {
    lines.push(`${label} is the latest v${s.generation} build.`);
  } else {
    lines.push(`${label} – no v${s.generation} release listed on foundryvtt.com.`);
  }
  if (s.majorUpdate) {
    const others = s.newerGenerations.length > 1 ? ` (also v${s.newerGenerations.slice(0, -1).map((r) => r.generation).join(", v")})` : "";
    lines.push(`⬆️ **New major version:** Foundry **v${s.majorUpdate.generation}** is out, latest build v${s.majorUpdate.version}${others} ([release notes](${site.releaseNotesUrl(s.majorUpdate.version)})). Run \`/updates compatibility\` to see whether your systems and modules are ready for it.`);
  }
  if (!s.channelKnown) lines.push("ℹ️ Could not tell stable from testing builds on the releases page; the versions above may include testing builds.");
  return { lines, summary: s };
}

export function formatUpdateLine(u, generation) {
  const tag = u.latest.status === "verified" ? "" : ` ${describeCompatibility(u.latest.status, generation)}`;
  const link = u.url ? ` · [page](${u.url})` : "";
  return `• ${icon(u.pkg)} **${u.pkg.title}** \`${u.pkg.id}\` ${u.installedVersion ?? "?"} → **${u.latest.version}**${tag}${link}`;
}

/**
 * @param {object} ctx
 * @param {"foundry"|"system"|"module"|null} filter
 */
export async function buildAvailableUpdatesEmbed(ctx, filter = null) {
  const installed = installedFoundryVersion(ctx);
  const generation = generationOf(installed);
  const sections = [];
  let color = COLORS.green;
  let count = 0;

  if (!filter || filter === "foundry") {
    const { lines, summary } = await describeFoundryReleases(ctx, installed);
    sections.push(lines.join("\n"));
    if (summary?.buildUpdate || summary?.majorUpdate) color = COLORS.orange;
    if (summary?.buildUpdate) count += 1;
  }

  if (filter !== "foundry") {
    const packages = ctx.scanPackages().filter((p) => !filter || p.type === filter);
    if (!packages.length) {
      sections.push(`No ${filter ? `${filter}s` : "systems or modules"} found. Is FOUNDRY_DATA_PATH set?`);
    } else if (generation === null) {
      sections.push("The installed Foundry version is not known yet, so updates cannot be filtered for it. Try again after the next check of Foundry, or set FOUNDRY_APP_PATH.");
    } else {
      const infos = await ctx.website.getPackageInfos(packages);
      const r = findAvailableUpdates(packages, infos, generation);
      for (const type of ["system", "module"]) {
        const updates = r.updates.filter((u) => u.pkg.type === type);
        const total = packages.filter((p) => p.type === type).length;
        if (!total) continue;
        const title = type === "system" ? "Systems" : "Modules";
        if (!updates.length) sections.push(`**${title}** – all ${total} are up to date for v${generation}.`);
        else sections.push(`**${title} – ${updates.length} update${updates.length === 1 ? "" : "s"} for v${generation}**\n${updates.map((u) => formatUpdateLine(u, generation)).join("\n")}`);
        count += updates.length;
      }
      if (r.updates.length) color = COLORS.orange;
      const notes = [];
      if (r.heldBack.length) notes.push(`${r.heldBack.length} with newer releases that need a different Foundry version: ${names(r.heldBack)}`);
      if (r.unknown.length) notes.push(`${r.unknown.length} not found on foundryvtt.com or via their manifest: ${names(r.unknown)}`);
      if (notes.length) sections.push(`ℹ️ ${notes.join("\nℹ️ ")}`);
    }
  }

  return {
    title: count ? `🔎 ${count} update${count === 1 ? "" : "s"} available` : "🔎 Everything is up to date",
    description: truncate(sections.join("\n\n"), 4000),
    color,
    footer: { text: `Compatibility as declared by the packages for Foundry v${generation ?? "?"} · source: ${ctx.website.baseUrl}` },
    timestamp: ctx.now().toISOString(),
  };
}

// --- /updates available changes:true -------------------------------------------------------

export const EMBED_DESCRIPTION_LIMIT = 4000;
export const MAX_CHANGE_MESSAGES = 25;
const MAX_FOUNDRY_NOTE_LINKS = 15;

/** Notes of a version record: free text, or just a link to a changelog page. */
function noteText(record) {
  const n = record.notes?.trim();
  if (!n) return null;
  return /^https?:\/\/\S+$/i.test(n) ? `[Changelog](${n})` : n;
}

/**
 * The changelog entries for every published version above `installed` up to `latest` (newest first).
 * @returns {Array<{version:string, text:string|null}>}
 */
export function changelogBetween(versions, installed, latest) {
  return (versions ?? [])
    .filter((v) => (installed === null || compareVersions(v.version, installed) > 0) && compareVersions(v.version, latest) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((v) => ({ version: v.version, text: noteText(v) }));
}

/**
 * Lay out version changelogs inside `limit` characters. Newest versions come first; when
 * everything does not fit, each entry gets an equal share (entries needing less give theirs
 * back), and versions that cannot fit at all are summarised in one closing line.
 */
export function fitChangelog(entries, limit = EMBED_DESCRIPTION_LIMIT) {
  const block = (e, text) => `**${e.version}**${text ? `\n${text}` : "\n_no changelog published_"}`;
  const join = (blocks) => blocks.join("\n\n");
  const full = join(entries.map((e) => block(e, e.text)));
  if (full.length <= limit) return full;
  const MIN = 120;
  const reserve = 60; // room for the "and N older versions" line
  let kept = entries.slice();
  while (kept.length > 1 && (limit - reserve) / kept.length < MIN) kept = kept.slice(0, -1);
  const omitted = entries.length - kept.length;
  const tail = omitted ? `\n\n_…and ${omitted} older version${omitted === 1 ? "" : "s"} (${entries[entries.length - 1].version}–${entries[kept.length].version}); see the package page._` : "";
  const budget = limit - tail.length;
  // water-filling: short entries keep their full text, the rest share what is left
  const sizes = kept.map((e) => block(e, e.text).length + 2);
  const caps = new Array(kept.length).fill(0);
  let remaining = budget;
  let open = kept.map((_, i) => i);
  while (open.length) {
    const share = Math.floor(remaining / open.length);
    const fits = open.filter((i) => sizes[i] <= share);
    if (!fits.length) {
      for (const i of open) caps[i] = share;
      break;
    }
    for (const i of fits) {
      caps[i] = sizes[i];
      remaining -= sizes[i];
    }
    open = open.filter((i) => !fits.includes(i));
  }
  const blocks = kept.map((e, i) => {
    const head = `**${e.version}**\n`;
    if (!e.text) return block(e, null);
    const room = Math.max(0, caps[i] - head.length - 2);
    return `${head}${truncate(e.text, room)}`;
  });
  return truncate(join(blocks) + tail, limit);
}

/**
 * Like buildAvailableUpdatesEmbed, but one embed per update; every embed carries the
 * changelogs of the versions between the installed and the latest one.
 * @returns {Promise<object[]>} at least one embed
 */
export async function buildUpdateChangesEmbeds(ctx, filter = null) {
  const installed = installedFoundryVersion(ctx);
  const generation = generationOf(installed);
  const timestamp = ctx.now().toISOString();
  const footer = { text: `Compatibility as declared by the packages for Foundry v${generation ?? "?"} · source: ${ctx.website.baseUrl}` };
  const embeds = [];
  const notes = [];

  if (!filter || filter === "foundry") {
    const site = ctx.website;
    const result = await site.getReleases();
    if (!result.ok) {
      notes.push(`**Foundry VTT** – could not check ${site.releasesUrl()} (${result.error}).`);
    } else {
      const s = summariseReleases(result.releases, installed);
      const channelOk = (r) => !s.channelKnown || r.channel === "stable";
      const stable = result.releases.filter(channelOk);
      const targets = [];
      if (s.buildUpdate) targets.push({ latest: s.buildUpdate, between: stable.filter((r) => r.generation === s.generation && r.build > (buildOf(installed) ?? 0) && r.build <= s.buildUpdate.build), label: `v${s.generation} build` });
      if (s.majorUpdate) targets.push({ latest: s.majorUpdate, between: stable.filter((r) => r.generation === s.majorUpdate.generation), label: `major version v${s.majorUpdate.generation}` });
      for (const t of targets) {
        const between = t.between.sort((a, b) => b.generation - a.generation || b.build - a.build);
        const shown = between.slice(0, MAX_FOUNDRY_NOTE_LINKS);
        const lines = shown.map((r) => `• [${r.version}](${site.releaseNotesUrl(r.version)})`);
        if (between.length > shown.length) lines.push(`…and ${between.length - shown.length} more`);
        embeds.push({
          title: `🏰 Foundry VTT ${installed ? `v${installed}` : "(version unknown)"} → v${t.latest.version}`,
          description: truncate(`Latest ${t.label}: **v${t.latest.version}** ([release notes](${site.releaseNotesUrl(t.latest.version)})).\n\n**Release notes per version**\n${lines.join("\n")}`, EMBED_DESCRIPTION_LIMIT),
          color: COLORS.orange,
          footer,
          timestamp,
        });
      }
    }
  }

  if (filter !== "foundry") {
    const packages = ctx.scanPackages().filter((p) => !filter || p.type === filter);
    if (!packages.length) {
      notes.push(`No ${filter ? `${filter}s` : "systems or modules"} found. Is FOUNDRY_DATA_PATH set?`);
    } else if (generation === null) {
      notes.push("The installed Foundry version is not known yet, so updates cannot be filtered for it. Try again after the next check of Foundry, or set FOUNDRY_APP_PATH.");
    } else {
      const infos = await ctx.website.getPackageInfos(packages);
      const r = findAvailableUpdates(packages, infos, generation);
      for (const u of r.updates) {
        const info = infos.get(`${u.pkg.type}:${u.pkg.id}`);
        const entries = changelogBetween(info?.versions, u.installedVersion, u.latest.version);
        const tag = u.latest.status === "verified" ? "" : ` ${describeCompatibility(u.latest.status, generation)}`;
        const link = u.url ? ` · [page](${u.url})` : "";
        const head = `${u.installedVersion ?? "?"} → **${u.latest.version}**${tag}${link}`;
        const fallback = entries.every((e) => !e.text) && u.pkg.changelog ? `\n\n[Changelog](${u.pkg.changelog})` : "";
        const body = entries.length ? fitChangelog(entries, EMBED_DESCRIPTION_LIMIT - head.length - 2 - fallback.length) : "_no changelog published_";
        embeds.push({ title: truncate(`${icon(u.pkg)} ${u.pkg.title} (${u.pkg.id})`, 256), description: `${head}\n\n${body}${fallback}`, color: COLORS.orange, footer, timestamp });
      }
      if (r.heldBack.length) notes.push(`${r.heldBack.length} with newer releases that need a different Foundry version: ${names(r.heldBack)}`);
      if (r.unknown.length) notes.push(`${r.unknown.length} not found on foundryvtt.com or via their manifest: ${names(r.unknown)}`);
    }
  }

  let shown = embeds;
  if (embeds.length > MAX_CHANGE_MESSAGES) {
    shown = embeds.slice(0, MAX_CHANGE_MESSAGES);
    notes.push(`Showing the first ${MAX_CHANGE_MESSAGES} of ${embeds.length} updates; use \`type\` to narrow the list.`);
  }
  const summary = {
    title: shown.length ? `🔎 ${embeds.length} update${embeds.length === 1 ? "" : "s"} available` : "🔎 Everything is up to date",
    description: truncate(notes.map((n) => (n.startsWith("**") || n.startsWith("The ") || n.startsWith("No ") ? n : `ℹ️ ${n}`)).join("\n") || (shown.length ? "Changelogs of the versions between installed and latest follow, one message per update." : "Nothing new for the installed Foundry version."), EMBED_DESCRIPTION_LIMIT),
    color: shown.length ? COLORS.orange : COLORS.green,
    footer,
    timestamp,
  };
  return [summary, ...shown];
}

// --- /updates compatibility ----------------------------------------------------------------

function compatLine(e, target) {
  const link = e.url ? ` · [page](${e.url})` : "";
  const base = `• ${icon(e.pkg)} **${e.pkg.title}** \`${e.pkg.id}\` ${e.pkg.version ?? "?"}`;
  if (e.published && e.pkg.version !== null && e.published.version !== e.pkg.version) {
    return `${base} → **${e.published.version}** ${describeCompatibility(e.published.status, target)}${link}`;
  }
  const detail = e.newest && e.newest.version !== e.pkg.version ? ` (newest release ${e.newest.version} does not support v${target} either)` : "";
  return `${base} ${describeCompatibility(e.installedStatus, target)}${detail}${link}`;
}

/**
 * @param {object} ctx
 * @param {number|null} requestedGeneration  null: the newest released generation, or installed + 1
 */
export async function buildCompatibilityEmbed(ctx, requestedGeneration = null) {
  const installed = installedFoundryVersion(ctx);
  const generation = generationOf(installed);
  let target = requestedGeneration ?? null;
  let releaseNote = "";
  if (target === null) {
    const releases = await ctx.website.getReleases();
    const s = releases.ok ? summariseReleases(releases.releases, installed) : null;
    if (s?.majorUpdate) {
      target = s.majorUpdate.generation;
      releaseNote = `Newest release of v${target}: ${s.majorUpdate.version} ([release notes](${ctx.website.releaseNotesUrl(s.majorUpdate.version)})).`;
    } else if (generation !== null) {
      target = generation + 1;
      releaseNote = releases.ok ? `No newer major version than v${generation} is released yet; checking what the packages declare about v${target}.` : `Could not check foundryvtt.com for releases (${releases.error}); checking what the packages declare about v${target}.`;
    }
  }
  if (target === null) {
    return { title: "🧭 Compatibility check", description: "The installed Foundry version is not known yet. Give the major version to check against: `/updates compatibility generation:14`.", color: COLORS.grey, timestamp: ctx.now().toISOString() };
  }

  const packages = ctx.scanPackages();
  if (!packages.length) {
    return { title: `🧭 Compatibility with Foundry v${target}`, description: "No systems or modules found. Is FOUNDRY_DATA_PATH set?", color: COLORS.grey, timestamp: ctx.now().toISOString() };
  }
  const infos = await ctx.website.getPackageInfos(packages);
  const r = majorUpgradeReport(packages, infos, target);
  const sections = [];
  if (releaseNote) sections.push(releaseNote);
  const counts = `✅ ready ${r.ready.length} · 🔼 update first ${r.updateFirst.length} · ⚠️ untested ${r.untested.length} · ❌ not ready ${r.notReady.length} · ❔ unknown ${r.unknown.length}`;
  sections.push(`**${packages.length} systems and modules installed on ${installed ? `v${installed}` : "an unknown version"}:** ${counts}`);
  if (r.notReady.length) sections.push(`**❌ Not ready – no release supports v${target}**\n${r.notReady.map((e) => compatLine(e, target)).join("\n")}`);
  if (r.updateFirst.length) sections.push(`**🔼 Update first – a newer release supports v${target}**\n${r.updateFirst.map((e) => compatLine(e, target)).join("\n")}`);
  if (r.untested.length) sections.push(`**⚠️ Untested – nothing rules v${target} out, but no version was verified for it**\n${r.untested.map((e) => compatLine(e, target)).join("\n")}`);
  if (r.unknown.length) sections.push(`**❔ Unknown – no compatibility information found**\n${r.unknown.map((e) => compatLine(e, target)).join("\n")}`);
  if (r.ready.length) sections.push(`**✅ Ready – the installed version is verified for v${target}**\n${names(r.ready, 40)}`);

  const blocking = r.notReady.length + r.updateFirst.length;
  return {
    title: blocking ? `🧭 Foundry v${target}: ${blocking} package${blocking === 1 ? "" : "s"} need${blocking === 1 ? "s" : ""} attention before upgrading` : `🧭 Foundry v${target}: ready to upgrade${r.untested.length + r.unknown.length ? " (with caveats)" : ""}`,
    description: truncate(sections.join("\n\n"), 4000),
    color: r.notReady.length ? COLORS.red : blocking || r.untested.length ? COLORS.orange : COLORS.green,
    footer: { text: `Based on what each package declares (installed manifest and ${ctx.website.baseUrl})` },
    timestamp: ctx.now().toISOString(),
  };
}

export function describeUpdateSettings(state) {
  const u = state.data.monitor.updates;
  return Object.entries(SETTINGS).map(([k, [key, label]]) => `• **${k}** – ${label}: ${u[key] ? "on" : "off"}`).join("\n");
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
