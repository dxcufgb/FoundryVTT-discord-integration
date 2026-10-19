"use strict";
// Administration page of the FoundryVTT Discord integration. Plain DOM code, no libraries;
// every value from the server goes into the page with textContent, never as HTML. One HTML
// page with several views, chosen by the address's fragment: #/ (overview), #/monitoring,
// #/servers, #/session-summaries, #/password (the cogwheel menu links to them).

(() => {
  const $ = (sel) => document.querySelector(sel);
  let csrf = "";
  let state = null;
  const TITLE = "FoundryVTT Discord Bot";
  const PAGES = {
    overview: "Overview",
    monitoring: "Monitoring",
    servers: "Servers and campaigns",
    "session-summaries": "Session summaries",
    password: "Admin password",
  };
  const MESSAGE_TYPES = { default: "Default", status: "Up / down", world: "Worlds", updates: "Updates", restart: "Restart windows", session: "Sessions" };
  const ANNOUNCE = ["status", "world", "updates"];
  const TRACK = ["trackFoundry", "trackSystems", "trackModules", "announceNewPackages", "announceRemovedPackages"];

  function toast(message, bad = false) {
    const el = $("#toast");
    el.textContent = message;
    el.className = bad ? "bad" : "";
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3500);
  }

  async function call(method, path, body) {
    const headers = {};
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = csrf;
    }
    const res = await fetch(`/_admin/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // keep the empty object
    }
    if (res.status === 401 && path !== "login") {
      showLogin();
      throw new Error("Your session has ended; please log in again.");
    }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    if (data.csrf) csrf = data.csrf;
    return data;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const diff = Date.now() - Date.parse(iso);
    const abs = Math.abs(diff);
    const future = diff < 0;
    for (const [name, ms] of [["day", 86400000], ["hour", 3600000], ["minute", 60000]]) {
      if (abs >= ms) {
        const n = Math.floor(abs / ms);
        return future ? `in ${n} ${name}${n === 1 ? "" : "s"}` : `${n} ${name}${n === 1 ? "" : "s"} ago`;
      }
    }
    return future ? "in under a minute" : "just now";
  }
  const when = (iso) => (iso ? `${new Date(iso).toLocaleString()} (${relativeTime(iso)})` : "–");

  // --- views -------------------------------------------------------------------------

  function showLogin() {
    closeMenu();
    $("#app-view").hidden = true;
    $("#top-actions").hidden = true;
    $("#app-footer").hidden = false;
    $("#footer-version").hidden = true;
    $("#login-view").hidden = false;
    document.body.classList.add("logged-out");
    document.title = TITLE;
    $("#login-form").password.value = "";
    $("#login-form").password.focus();
  }

  function showApp(data) {
    document.body.classList.remove("logged-out");
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#top-actions").hidden = false;
    $("#app-footer").hidden = false;
    $("#footer-version").hidden = false;
    render(data);
    showPage();
  }

  function currentPage() {
    const name = location.hash.replace(/^#\/?/, "");
    return Object.hasOwn(PAGES, name) ? name : "overview";
  }

  function showPage() {
    const page = currentPage();
    for (const section of document.querySelectorAll(".page")) section.hidden = section.dataset.page !== page;
    for (const item of document.querySelectorAll("#settings-menu a")) {
      if (item.getAttribute("href") === (page === "overview" ? "#/" : `#/${page}`)) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    document.title = page === "overview" ? TITLE : `${PAGES[page]} – ${TITLE}`;
    closeMenu();
  }

  // The cogwheel menu: opens below the button, closes on Escape, a click outside or a choice.
  const menuItems = () => [...document.querySelectorAll('#settings-menu [role="menuitem"]')];
  function openMenu(focusIndex = 0) {
    $("#settings-menu").hidden = false;
    $("#settings-button").setAttribute("aria-expanded", "true");
    const items = menuItems();
    if (items[focusIndex]) items[focusIndex].focus();
  }
  function closeMenu(returnFocus = false) {
    if ($("#settings-menu").hidden) return;
    $("#settings-menu").hidden = true;
    $("#settings-button").setAttribute("aria-expanded", "false");
    if (returnFocus) $("#settings-button").focus();
  }
  function menuKeys(e) {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  }

  // --- rendering -----------------------------------------------------------------------

  function render(data) {
    state = data;
    renderOverview();
    renderMonitoring();
    renderGuilds();
    renderSummaries();
    $("#footer-version").textContent = `FoundryVTT Discord integration ${state.version || "(version unknown)"}`;
  }

  function badge(node, text, kind) {
    node.textContent = text;
    node.className = `badge ${kind}`;
  }

  function renderOverview() {
    const f = state.foundry;
    badge($("#foundry-badge"), f.status === "up" ? "Up" : f.status === "down" ? "Down" : "Unknown", f.status === "up" ? "good" : f.status === "down" ? "bad" : "off");
    $("#foundry-since").textContent = f.since ? `since ${when(f.since)}` : "not checked yet";
    $("#foundry-world").textContent = f.world ? (f.worldTitle ? `${f.worldTitle} (${f.world})` : f.world) : "none (setup screen)";
    $("#foundry-world-since").textContent = f.worldSince ? `since ${when(f.worldSince)}` : "";
    $("#foundry-version").textContent = f.version || "unknown";
    const d = state.discord;
    badge($("#discord-badge"), d.connected ? "Connected" : "Not connected", d.connected ? "good" : "bad");
    $("#discord-user").textContent = d.connected ? `${d.user} in ${d.servers} server${d.servers === 1 ? "" : "s"}` : "";

    const c = state.config;
    const rows = [
      ["Foundry address (FOUNDRY_URL)", c.foundryUrl],
      ["Foundry data folder (FOUNDRY_DATA_PATH)", c.dataPath || "not set: update tracking, world titles and session summaries are off"],
      ["Foundry install folder (FOUNDRY_APP_PATH)", c.appPath || "not set"],
      ["Foundry website (FOUNDRY_WEBSITE_URL)", c.websiteUrl],
      ["Session summary folder (SESSION_SUMMARY_DIR)", c.sessionSummaryDir || "default (session-summaries in the Data folder)"],
      ["Bot data folder (BOT_DATA_DIR)", c.botDataDir],
      ["Check Foundry every", `${c.pollIntervalSeconds} s, down after ${c.downAfterFailures} failed checks`],
      ["Timezone (TIMEZONE)", c.timezone],
      ["Log level (LOG_LEVEL)", c.logLevel],
      ["Update notices (UPDATE_NOTIFY)", c.updateNotify],
      ["Slash commands registered in", c.commandsGuild ? `server ${c.commandsGuild} only (DISCORD_GUILD_ID)` : "every server (global)"],
    ];
    $("#config-table tbody").replaceChildren(...rows.map(([k, v]) => el("tr", {}, [el("th", { text: k, scope: "row" }), el("td", { text: String(v) })])));
  }

  function renderMonitoring() {
    const form = $("#monitor-form");
    for (const k of ANNOUNCE) form[k].checked = Boolean(state.monitor.enabled[k]);
    for (const k of TRACK) form[k].checked = Boolean(state.monitor.updates[k]);
    $("#restart-window").textContent = state.monitor.restartWindow || "No restart window is set.";
  }

  const channelText = (c) => (c ? (c.name ? `#${c.name}` : `channel ${c.id} (not found)`) : "–");
  const roleText = (r) => (r ? (r.name ? `@${r.name}` : `role ${r.id} (not found)`) : "–");

  // A channel's name in a dropdown: #name, with its category, or marked as a thread / stage.
  function channelLabel(c) {
    const kind = c.thread ? " (thread)" : c.stage ? " (stage)" : "";
    return `#${c.name}${kind}${c.parent ? ` – ${c.parent}` : ""}`;
  }

  // A dropdown of channels or roles; a stored one that no longer exists stays selectable so saving keeps it.
  function picker(name, current, list, noneText, label) {
    const options = [el("option", { value: "", text: noneText })];
    if (current && !list.some((x) => x.id === current.id)) options.push(el("option", { value: current.id, text: `${current.id} (not found)` }));
    for (const x of list) options.push(el("option", { value: x.id, text: label(x) }));
    const select = el("select", { name, "aria-label": name }, options);
    select.value = current?.id ?? "";
    return select;
  }

  const roleLabel = (r) => `@${r.name}${r.managed ? " (bot role)" : ""}`;

  // Saved; any permission warnings stay on screen longer.
  function savedToast(data, what) {
    const warnings = data.warnings ?? [];
    toast(warnings.length ? `${what} saved, but: ${warnings.join(" ")}` : `${what} saved.`, warnings.length > 0);
  }

  function guildForm(g) {
    const o = g.options;
    const rows = Object.entries(MESSAGE_TYPES).map(([type, label]) => el("label", { text: `${label} ` }, [
      picker(`channel-${type}`, g.channels[type], o.textChannels, type === "default" ? "— not posted —" : "— the default channel —", channelLabel),
    ]));
    rows.push(el("label", { text: "Ping on unexpected downtime " }, [picker("mentionRole", g.mentionRole, o.roles, "— nobody —", roleLabel)]));
    rows.push(el("label", { text: "Game master role " }, [
      picker("gmRole", g.gmRole, o.roles, "— none —", roleLabel),
      el("small", { text: "Members with it may plan sessions with polls for every campaign." }),
    ]));
    const save = el("button", { type: "submit", text: "Save" });
    const form = el("form", { class: "guild-form" }, [el("div", { class: "grid" }, rows), el("div", { class: "buttons" }, [save])]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const channels = {};
      for (const type of Object.keys(MESSAGE_TYPES)) channels[type] = form.elements[`channel-${type}`].value || null;
      save.disabled = true;
      try {
        const data = await call("PUT", `guilds/${g.id}`, { channels, mentionRole: form.elements.mentionRole.value || null, gmRole: form.elements.gmRole.value || null });
        render(data);
        savedToast(data, `${g.name || "Server"} settings`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        save.disabled = false;
      }
    });
    return form;
  }

  function campaignRow(g, c) {
    const cells = [
      el("td", { text: c.name }),
      el("td", { text: c.worldTitle ? `${c.worldTitle} (${c.world})` : c.world }),
    ];
    if (!g.options) {
      cells.push(el("td", { text: channelText(c.channel) }), el("td", { text: channelText(c.voiceChannel) }));
    } else {
      const channel = picker("channel", c.channel, g.options.textChannels, "— session channel —", channelLabel);
      const voice = picker("voiceChannel", c.voiceChannel, g.options.voiceChannels, "— ask when planning —", channelLabel);
      const save = el("button", { type: "button", class: "secondary small", text: "Save" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const data = await call("PUT", `guilds/${g.id}/campaigns/${encodeURIComponent(c.id)}`, { channel: channel.value || null, voiceChannel: voice.value || null });
          render(data);
          savedToast(data, `Channels of ${c.name}`);
        } catch (err) {
          toast(err.message, true);
        } finally {
          save.disabled = false;
        }
      });
      cells.push(el("td", {}, [channel]), el("td", {}, [voice]));
      cells.push(el("td", { text: String(c.players) }), el("td", { text: c.nextSession ? when(c.nextSession) : "–" }), el("td", {}, [save]));
      return el("tr", {}, cells);
    }
    cells.push(el("td", { text: String(c.players) }), el("td", { text: c.nextSession ? when(c.nextSession) : "–" }), el("td", {}));
    return el("tr", {}, cells);
  }

  function renderGuilds() {
    const list = state.guilds;
    $("#no-guilds").hidden = list.length > 0;
    $("#guilds").replaceChildren(...list.map((g) => {
      let settings;
      if (g.options) {
        settings = guildForm(g);
      } else {
        const rows = Object.entries(MESSAGE_TYPES).map(([type, label]) => el("tr", {}, [el("th", { text: label, scope: "row" }), el("td", { text: channelText(g.channels[type]) })]));
        rows.push(el("tr", {}, [el("th", { text: "Mention role", scope: "row" }), el("td", { text: roleText(g.mentionRole) })]));
        rows.push(el("tr", {}, [el("th", { text: "GM role", scope: "row" }), el("td", { text: roleText(g.gmRole) })]));
        settings = el("div", { class: "table-wrap" }, [el("table", { class: "config" }, [el("tbody", {}, rows)])]);
      }
      const campaigns = g.campaigns.length
        ? el("div", { class: "table-wrap" }, [el("table", { class: "campaigns" }, [
            el("thead", {}, [el("tr", {}, ["Campaign", "World", "Channel", "Voice channel", "Players", "Next session", ""].map((h) => el("th", { text: h })))]),
            el("tbody", {}, g.campaigns.map((c) => campaignRow(g, c))),
          ])])
        : el("p", { class: "empty", text: "No campaigns." });
      const title = `${g.name || `Server ${g.id}`}${g.joined ? "" : " (the bot is no longer in it: nothing can be changed)"}`;
      return el("div", { class: "guild" }, [
        el("h3", { text: title }),
        g.healthIssue ? el("p", { class: "error", text: "The bot is missing permissions here; see its last message in the server." }) : "",
        settings,
        el("h4", { text: "Campaigns" }),
        campaigns,
      ]);
    }));
  }

  function renderSummaries() {
    const s = state.sessionSummaries;
    const folder = $("#summary-folder");
    if (!s.folder) folder.textContent = "Folder: none, because FOUNDRY_DATA_PATH is not set (or set SESSION_SUMMARY_DIR).";
    else folder.textContent = `Folder: ${s.folder} – ${s.exists ? "found" : "not there yet (fine while the module has not exported anything)"}`;
    const problems = $("#summary-problems");
    problems.hidden = !s.problems.length;
    problems.replaceChildren(...s.problems.map((p) => el("li", { class: "warn" }, [el("span", { class: "mark", text: "!" }), p])));

    const form = $("#summary-form");
    form.enabled.checked = s.enabled;
    form.maxAgeHours.value = String(s.maxAgeHours);
    form.maxAgeHours.min = String(s.limits.min);
    form.maxAgeHours.max = String(s.limits.max);

    const select = $("#summary-post-form").world;
    const keep = select.value;
    select.replaceChildren(...(s.worlds.length
      ? s.worlds.map((w) => el("option", { value: w.id, text: w.title ? `${w.title} (${w.id})` : w.id }))
      : [el("option", { value: "", text: "No campaign is bound to a world yet" })]));
    if (s.worlds.some((w) => w.id === keep)) select.value = keep;
    $("#summary-post-form").querySelector("button").disabled = !s.worlds.length || !s.enabled;

    $("#no-summaries").hidden = s.sessions.length > 0;
    $("#summaries").hidden = !s.sessions.length;
    $("#summaries tbody").replaceChildren(...s.sessions.map((x) => {
      const name = `${x.number !== null ? `#${x.number} ` : ""}${x.title || x.file}${x.inProgress ? " (in progress, not posted)" : ""}`;
      const posted = x.posted.length
        ? x.posted.map((p) => `${p.campaign}: ${p.at ? `posted ${relativeTime(p.at)}` : "not posted"}`).join("; ")
        : "no campaign channel for this world";
      return el("tr", {}, [el("td", { text: name }), el("td", { text: x.worldId || "?" }), el("td", { text: when(x.endedAt) }), el("td", { text: posted })]);
    }));
  }

  // --- actions -----------------------------------------------------------------------

  async function submit(e, method, path, body, message) {
    e.preventDefault();
    const button = e.currentTarget.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const data = await call(method, path, body());
      render(data);
      toast(typeof message === "function" ? message(data) : message);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function refresh() {
    try {
      render(await call("GET", "state"));
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.password.value !== form.repeat.value) {
      toast("The new passwords do not match.", true);
      return;
    }
    try {
      render(await call("PUT", "password", { current: form.current.value, password: form.password.value }));
      storeCredential(form.password.value);
      form.reset();
      toast("Password changed. Other sessions were logged out.");
    } catch (err) {
      toast(err.message, true);
    }
  }

  // The page has one fixed user name, "admin" (the hidden username fields).
  function storeCredential(password) {
    if (typeof window.PasswordCredential !== "function" || !navigator.credentials) return;
    try {
      navigator.credentials.store(new window.PasswordCredential({ id: "admin", password, name: document.title })).catch(() => {});
    } catch {
      // not offered: the browser's own form detection still works
    }
  }

  // The certificate is offered only when it is self-signed; then the login page explains how to trust it.
  async function showCertificateHint() {
    if (location.protocol !== "https:") return;
    try {
      const res = await fetch("/_admin/certificate.crt", { method: "HEAD", credentials: "same-origin", cache: "no-store" });
      $("#cert-hint").hidden = !res.ok;
    } catch {
      // no hint
    }
  }

  async function login(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const error = $("#login-error");
    error.hidden = true;
    try {
      const data = await call("POST", "login", { password: form.password.value });
      storeCredential(form.password.value);
      showApp(data);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  }

  // Only shows the login page once the server has ended the session (a 401 means it already had).
  async function logout() {
    try {
      await call("POST", "logout", {});
    } catch (err) {
      if (!$("#login-view").hidden) return;
      toast(`Logging out failed: ${err.message} Try again.`, true);
      return;
    }
    csrf = "";
    showLogin();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    $("#login-form").addEventListener("submit", login);
    showCertificateHint();
    $("#logout").addEventListener("click", logout);
    $("#refresh").addEventListener("click", refresh);
    $("#settings-button").addEventListener("click", () => ($("#settings-menu").hidden ? openMenu() : closeMenu()));
    $("#settings-button").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu(e.key === "ArrowDown" ? 0 : menuItems().length - 1);
      }
    });
    $("#settings-menu").addEventListener("keydown", menuKeys);
    $("#settings-menu").addEventListener("click", () => closeMenu());
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".menu-wrap")) closeMenu();
    });
    window.addEventListener("hashchange", () => {
      if (!$("#app-view").hidden) {
        showPage();
        window.scrollTo(0, 0);
      }
    });
    $("#monitor-form").addEventListener("submit", (e) => {
      const form = e.currentTarget;
      submit(e, "PUT", "monitor", () => ({
        enabled: Object.fromEntries(ANNOUNCE.map((k) => [k, form[k].checked])),
        updates: Object.fromEntries(TRACK.map((k) => [k, form[k].checked])),
      }), "Monitoring settings saved.");
    });
    $("#summary-form").addEventListener("submit", (e) => {
      const form = e.currentTarget;
      submit(e, "PUT", "session-summaries", () => ({ enabled: form.enabled.checked, maxAgeHours: Number(form.maxAgeHours.value) }), "Session summary settings saved.");
    });
    $("#summary-post-form").addEventListener("submit", (e) => {
      const form = e.currentTarget;
      submit(e, "POST", "session-summaries/post", () => ({ world: form.world.value }),
        (data) => (data.sent ? `Posted ${data.sent} message${data.sent === 1 ? "" : "s"}.` : "Nothing new to post (see the bot's log at debug level for why)."));
    });
    $("#password-form").addEventListener("submit", changePassword);
    try {
      showApp(await call("GET", "state"));
    } catch {
      showLogin();
    }
  });
})();
