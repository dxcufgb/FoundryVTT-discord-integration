// The administration page's listener: its own port (ADMIN_PORT), HTTPS unless
// ADMIN_TLS=off (for a reverse proxy that does HTTPS). A plain-HTTP request on the
// HTTPS port gets a redirect to https://, "/" leads to /_admin/, nothing else is served.
// The page stays off unless ADMIN_PORT is set and admin.json holds a password.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { createAdmin } from "./page.js";
import { adminFile, loadAdminSettings } from "./settings.js";
import { createSelfSigned, defaultNames } from "./selfsigned.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The certificate as PEM when it is self-signed, else null (a real CA's certificate is not offered for download). */
export function selfSignedPem(cert) {
  try {
    const x509 = new crypto.X509Certificate(cert);
    return x509.subject === x509.issuer && x509.verify(x509.publicKey) ? x509.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The certificate: ADMIN_TLS_CERT / ADMIN_TLS_KEY when set, else admin-tls.crt / .key in the
 * bot's data folder, made once (self-signed, ten years) when they do not exist yet.
 */
export function adminTls(config, { log = console } = {}) {
  const { admin } = config;
  if (admin.tlsCert || admin.tlsKey) {
    if (!admin.tlsCert || !admin.tlsKey) throw new Error("set both ADMIN_TLS_CERT and ADMIN_TLS_KEY");
    return { cert: fs.readFileSync(admin.tlsCert), key: fs.readFileSync(admin.tlsKey), note: `certificate ${admin.tlsCert}` };
  }
  const certFile = path.join(config.botDataDir, "admin-tls.crt");
  const keyFile = path.join(config.botDataDir, "admin-tls.key");
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), note: `certificate ${certFile}` };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const names = defaultNames(admin.hosts);
  const { cert, key } = createSelfSigned(names);
  fs.mkdirSync(config.botDataDir, { recursive: true });
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.writeFileSync(certFile, cert, { mode: 0o644 });
  log.info(`admin page: made a self-signed certificate for ${names.join(", ")} (${certFile})`);
  return { cert, key, note: `self-signed certificate ${certFile}` };
}

/** An HTTP(S) server for the handler of createAdmin. tls: { cert, key } or null for plain HTTP. */
export function createAdminServer(page, tls, { log = console } = {}) {
  const plain = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(body);
  };
  const route = (certificate) => (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://admin").pathname;
    } catch {
      return plain(res, 404, "not found");
    }
    if (pathname === "/") return plain(res, 302, "see /_admin/", { Location: "/_admin/" });
    if (!page.handles(pathname)) return plain(res, 404, "not found");
    page.handle(req, res, pathname, { certificate }).catch((err) => {
      log.error(`admin page: internal error: ${err?.message ?? err}`);
      if (!res.headersSent) plain(res, 500, "internal error");
      else res.end();
    });
  };
  if (!tls) return http.createServer(route(undefined));

  const secure = https.createServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, route(selfSignedPem(tls.cert) ?? undefined));
  const redirect = http.createServer((req, res) => {
    // Only to a host name the page accepts anyway (ADMIN_HOSTS, this machine's names): never an open redirect.
    const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || "") ? page.knownHost(req.headers.host) : null;
    if (!host) return plain(res, 400, "use https://");
    return plain(res, 301, "use https://", { Location: `https://${host}/_admin/` });
  });
  // A TLS connection starts with a handshake record (0x16); anything else is plain HTTP.
  const front = net.createServer((socket) => {
    socket.once("data", (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? secure : redirect).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30000, () => socket.destroy());
  });
  front.on("close", () => {
    secure.close();
    redirect.close();
  });
  return front;
}

/**
 * Starts the page when ADMIN_PORT is set and a password exists. Resolves to the listening
 * server, or null when the page is off. Throws when it cannot start (the bot logs it and goes on).
 */
export async function startAdmin(ctx, { version = null } = {}) {
  const { config, log } = ctx;
  if (!config.admin) return null;
  const file = adminFile(config.botDataDir);
  const settings = loadAdminSettings(file);
  if (!settings.passwordHash) {
    log.warn(`admin page: ADMIN_PORT is set but no password yet; set one with "npm run admin-password" and restart the bot`);
    return null;
  }
  const tls = config.admin.tls ? adminTls(config, { log }) : null;
  const page = createAdmin({ file, settings, ctx, version, extraHosts: config.admin.hosts, trustProxy: config.admin.trustProxy });
  const server = createAdminServer(page, tls, { log });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.admin.port, config.admin.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => log.warn(`admin page: ${err.message}`));
  const shown = config.admin.host === "0.0.0.0" || config.admin.host === "::" ? "localhost" : config.admin.host;
  log.info(`admin page: ${tls ? "https" : "http"}://${shown}:${config.admin.port}/ (${tls ? tls.note : "plain HTTP"})`);
  if (!tls && !LOOPBACK.has(config.admin.host) && !config.admin.trustProxy.length) {
    log.warn("admin page: ADMIN_TLS=off on a network address: the password crosses the network unencrypted");
  }
  return server;
}
