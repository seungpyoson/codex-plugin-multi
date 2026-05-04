#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_GROK2API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_ADMIN_KEY = "grok2api";
const DEFAULT_POOL = "super";
const COOKIE_NAMES = ["sso-rw", "sso"];

const BROWSERS = {
  chrome: {
    label: "Google Chrome",
    root: ["Library", "Application Support", "Google", "Chrome"],
    service: "Chrome Safe Storage",
    account: "Chrome",
  },
  brave: {
    label: "Brave Browser",
    root: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
    service: "Brave Safe Storage",
    account: "Brave",
  },
  edge: {
    label: "Microsoft Edge",
    root: ["Library", "Application Support", "Microsoft Edge"],
    service: "Microsoft Edge Safe Storage",
    account: "Microsoft Edge",
  },
  arc: {
    label: "Arc",
    root: ["Library", "Application Support", "Arc", "User Data"],
    service: "Arc Safe Storage",
    account: "Arc",
  },
};

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function normalizeBaseUrl(value) {
  let out = String(value || DEFAULT_GROK2API_BASE_URL);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function sanitizeToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^sso-rw=/i, "")
    .replace(/^sso=/i, "")
    .replace(/;.*/, "")
    .replaceAll(/\s+/g, "");
}

function sanitizeAccount(entry) {
  return {
    pool: entry?.pool ?? null,
    status: entry?.status ?? null,
    quota: entry?.quota ?? null,
    use_count: entry?.use_count ?? null,
    last_used_at: entry?.last_used_at ?? null,
    tags: Array.isArray(entry?.tags) ? entry.tags : [],
  };
}

function fail(errorCode, message, extra = {}) {
  printJson({
    ok: false,
    error_code: errorCode,
    error_message: message,
    ...extra,
  });
  process.exit(1);
}

async function api(baseUrl, pathName, { method = "GET", body = null, adminKey = DEFAULT_ADMIN_KEY } = {}) {
  const response = await fetch(`${baseUrl}/admin/api${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${adminKey}`,
      ...(body == null ? {} : { "content-type": "application/json" }),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (!response.ok) {
    const err = new Error(`${pathName} HTTP ${response.status}`);
    err.status = response.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function checkGrok2Api(baseUrl, adminKey) {
  try {
    const current = await api(baseUrl, "/tokens", { adminKey });
    return Array.isArray(current?.tokens) ? current.tokens : [];
  } catch (error) {
    process.stderr.write(`Could not reach local grok2api admin API: ${error.message}\n`);
    return null;
  }
}

function browserConfig(name) {
  const key = String(name || "chrome").toLowerCase();
  const cfg = BROWSERS[key];
  if (!cfg) {
    throw new Error(`unsupported_browser:${key}`);
  }
  return { key, ...cfg };
}

function cookieDbPathFor(browser, profile) {
  const root = path.join(homedir(), ...browser.root, profile || "Default");
  const candidates = [
    path.join(root, "Network", "Cookies"),
    path.join(root, "Cookies"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (res.status !== 0 || res.error) {
    const detail = res.error?.message || res.stderr || res.stdout || `${command} exited ${res.status}`;
    throw new Error(String(detail).trim());
  }
  return res.stdout ?? "";
}

function keychainPassword(browser) {
  const attempts = [
    ["find-generic-password", "-w", "-a", browser.account, "-s", browser.service],
    ["find-generic-password", "-w", "-s", browser.service],
  ];
  const errors = [];
  for (const args of attempts) {
    const res = spawnSync("/usr/bin/security", args, { encoding: "utf8", windowsHide: true });
    if (res.status === 0 && res.stdout) return res.stdout.trimEnd();
    errors.push((res.stderr || res.stdout || `security exited ${res.status}`).trim());
  }
  throw new Error(errors.filter(Boolean).join("; ") || "keychain password not found");
}

function sqliteCookieRows(dbPath) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "grok-cookie-db-"));
  const tempDb = path.join(tempDir, "Cookies");
  try {
    copyFileSync(dbPath, tempDb);
    const script = [
      "import json, sqlite3, sys",
      "db = sys.argv[1]",
      "con = sqlite3.connect(db)",
      "con.row_factory = sqlite3.Row",
      "rows = con.execute(\"SELECT host_key, name, value, hex(encrypted_value) AS encrypted_hex FROM cookies WHERE host_key LIKE '%grok.com' AND name IN ('sso','sso-rw')\").fetchall()",
      "print(json.dumps([dict(r) for r in rows]))",
    ].join("\n");
    const stdout = run("python3", ["-c", script, tempDb]);
    return JSON.parse(stdout || "[]");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function chromeDecrypt(encryptedHex, password) {
  if (!encryptedHex) return "";
  const encrypted = Buffer.from(encryptedHex, "hex");
  if (!encrypted.length) return "";
  if (!(encrypted.subarray(0, 3).toString("utf8") === "v10" || encrypted.subarray(0, 3).toString("utf8") === "v11")) {
    throw new Error("unsupported encrypted cookie format");
  }
  const payload = encrypted.subarray(3);
  const key = pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from("saltysalt"), 1003, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

function selectCookie(cookies) {
  for (const name of COOKIE_NAMES) {
    const match = cookies.find((cookie) => cookie.name === name && sanitizeToken(cookie.value));
    if (match) return { name, value: sanitizeToken(match.value) };
  }
  return null;
}

function cookiesFromJson(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) throw new Error("cookie source json must be an array");
  return raw.map((entry) => ({
    name: String(entry?.name ?? ""),
    value: sanitizeToken(entry?.value ?? ""),
  }));
}

function cookiesFromBrowser(options) {
  const browser = browserConfig(options.browser);
  const profile = String(options.profile || "Default");
  const dbPath = options.cookieDb || cookieDbPathFor(browser, profile);
  process.stderr.write(`Reading Grok session cookies from ${browser.label} profile "${profile}" at ${dbPath}. Token values will not be printed.\n`);
  const password = keychainPassword(browser);
  const rows = sqliteCookieRows(dbPath);
  return rows.map((row) => ({
    name: row.name,
    value: sanitizeToken(row.value || chromeDecrypt(row.encrypted_hex, password)),
  }));
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const baseUrl = normalizeBaseUrl(args["grok2api-base-url"] || process.env.GROK2API_BASE_URL);
  const adminKey = String(args["admin-key"] || process.env.GROK2API_ADMIN_KEY || DEFAULT_ADMIN_KEY);
  const pool = String(args.pool || process.env.GROK2API_POOL || DEFAULT_POOL).toLowerCase();

  const existingTokens = await checkGrok2Api(baseUrl, adminKey);
  if (existingTokens === null) {
    fail("grok2api_unreachable", `Could not reach local grok2api admin API at ${baseUrl}/admin/api/tokens.`);
  }

  let cookies;
  let source;
  try {
    if (args["cookie-source-json"]) {
      process.stderr.write(`Reading Grok session cookies from explicit cookie source JSON. Token values will not be printed.\n`);
      cookies = cookiesFromJson(args["cookie-source-json"]);
      source = "cookie_source_json";
    } else {
      cookies = cookiesFromBrowser({
        browser: args.browser || process.env.GROK_BROWSER || "chrome",
        profile: args.profile || process.env.GROK_BROWSER_PROFILE || "Default",
        cookieDb: args["cookie-db"],
      });
      source = "browser_cookie_store";
    }
  } catch (error) {
    fail("cookie_extract_failed", error.message);
  }

  const selected = selectCookie(cookies);
  if (!selected) {
    fail("cookie_not_found", "No usable sso-rw or sso cookie was found for grok.com.", { source });
  }

  const toDelete = existingTokens.map((entry) => entry.token).filter(Boolean);
  try {
    if (toDelete.length) {
      await api(baseUrl, "/tokens", { method: "DELETE", body: toDelete, adminKey });
    }
    await api(baseUrl, "/tokens/add", { method: "POST", body: { pool, tokens: [selected.value] }, adminKey });
    await api(baseUrl, "/batch/refresh", { method: "POST", body: { tokens: [selected.value] }, adminKey });
    const after = await api(baseUrl, "/tokens", { adminKey });
    printJson({
      ok: true,
      source,
      browser: args.browser || process.env.GROK_BROWSER || (args["cookie-source-json"] ? null : "chrome"),
      profile: args.profile || process.env.GROK_BROWSER_PROFILE || (args["cookie-source-json"] ? null : "Default"),
      selected_cookie: selected.name,
      pool,
      deleted_count: toDelete.length,
      tokens: (after.tokens || []).map(sanitizeAccount),
    });
    process.exit(0);
  } catch (error) {
    fail("grok2api_import_failed", error.message, { source, selected_cookie: selected.name });
  }
}

try {
  await main();
} catch (error) {
  fail("unexpected_error", error?.message || String(error));
}
