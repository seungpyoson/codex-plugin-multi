#!/usr/bin/env node
// Manifest linter — validates marketplace.json, plugin.json files, and plugin
// markdown frontmatter. Exits non-zero on any violation.
// Run in CI and locally via `npm run lint`.

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bare-name regex: lowercase identifier with optional *internal* hyphens.
// Rejects colons, slashes, whitespace, uppercase, leading/trailing hyphens —
// required per spec §4.13/§5.1.
const BARE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Codex recognizes these capability strings (verified in codex-rs
// core-plugins/src/marketplace_tests.rs:1168,1204,1296,1320).
const CAPABILITY_ENUM = ["Interactive", "Read", "Write"];

// Command frontmatter keys allowed by Codex (verified in openai/plugins:
// vercel/commands/*.md use `description`; cloudflare uses +`argument-hint` +
// `allowed-tools`. No other keys observed).
const COMMAND_FRONTMATTER_KEYS = new Set([
  "description",
  "argument-hint",
  "allowed-tools",
]);

const FORBIDDEN_PLUGIN_MANIFEST_KEYS = new Map([
  ["commands", "upstream Codex supports plugin command-file registration and dispatch (tracked in #13)"],
]);

const SKILL_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "user-invocable",
]);

const AGENT_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "model",
  "tools",
  "skills",
]);

// Allowed installation / authentication values per marketplace schema
// (verified 2026-04-23: "NEVER" is rejected; ON_INSTALL|ON_USE are the only
// accepted authentication values).
const INSTALLATION_ENUM = ["AVAILABLE", "DEFAULT", "HIDDEN"];
const AUTHENTICATION_ENUM = ["ON_INSTALL", "ON_USE"];

// Semver (simplified): MAJOR.MINOR.PATCH with optional prerelease.
const SEMVER = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/;

const errors = [];
function err(path, msg) {
  errors.push(`${path}: ${msg}`);
}

async function readJson(relPath) {
  try {
    return JSON.parse(await readFile(resolve(REPO_ROOT, relPath), "utf8"));
  } catch (e) {
    err(relPath, `could not read or parse JSON: ${e.message}`);
    return null;
  }
}

function checkType(obj, key, type, path) {
  if (obj == null || obj[key] === undefined) {
    err(path, `missing field "${key}"`);
    return false;
  }
  // typeof null === "object" — reject null explicitly so downstream
  // truthy-guards don't silently skip nested validation.
  if (obj[key] === null) {
    err(path, `field "${key}" is null; expected ${type}`);
    return false;
  }
  const actual = Array.isArray(obj[key]) ? "array" : typeof obj[key];
  if (actual !== type) {
    err(path, `field "${key}" expected ${type}, got ${actual}`);
    return false;
  }
  return true;
}

function oneOf(obj, key, allowed, path, { required = false } = {}) {
  if (obj == null || obj[key] === undefined) {
    if (required) err(path, `missing required field "${key}" (allowed: ${allowed.join("|")})`);
    return;
  }
  if (!allowed.includes(obj[key])) {
    err(path, `field "${key}" must be one of ${allowed.join("|")}, got "${obj[key]}"`);
  }
}

function checkBareName(name, path, label) {
  if (!BARE_NAME.test(name)) {
    err(path, `${label} "${name}" must match ${BARE_NAME} (lowercase + hyphens; no colons, slashes, whitespace, uppercase)`);
  }
}

async function checkMarketplace() {
  const path = ".agents/plugins/marketplace.json";
  const m = await readJson(path);
  if (!m) return [];
  checkType(m, "name", "string", path);
  if (m.name) checkBareName(m.name, path, "marketplace name");
  checkType(m, "interface", "object", path);
  if (m.interface) checkType(m.interface, "displayName", "string", path);
  if (!checkType(m, "plugins", "array", path)) return [];
  if (m.plugins.length === 0) err(path, "plugins array is empty");
  const declared = [];
  for (const [i, p] of m.plugins.entries()) {
    const pp = `${path}:plugins[${i}]`;
    if (checkType(p, "name", "string", pp) && p.name) {
      checkBareName(p.name, pp, "plugin name");
      declared.push(p.name);
    }
    checkType(p, "source", "object", pp);
    if (p.source) {
      checkType(p.source, "source", "string", pp);
      oneOf(p.source, "source", ["local", "git"], pp, { required: true });
      checkType(p.source, "path", "string", pp);
    }
    checkType(p, "policy", "object", pp);
    if (p.policy) {
      oneOf(p.policy, "installation", INSTALLATION_ENUM, pp, { required: true });
      oneOf(p.policy, "authentication", AUTHENTICATION_ENUM, pp, { required: true });
    }
  }
  return declared;
}

async function checkPluginManifest(name) {
  const path = `plugins/${name}/.codex-plugin/plugin.json`;
  const m = await readJson(path);
  if (!m) return null;
  for (const [key, reason] of FORBIDDEN_PLUGIN_MANIFEST_KEYS) {
    if (key in m) {
      err(path, `field "${key}" is forbidden until ${reason}`);
    }
  }
  if (checkType(m, "name", "string", path)) {
    checkBareName(m.name, path, "plugin name");
    if (m.name !== name) err(path, `name "${m.name}" does not match directory "${name}"`);
  }
  if (checkType(m, "version", "string", path)) {
    if (!SEMVER.test(m.version)) err(path, `version "${m.version}" is not valid semver (MAJOR.MINOR.PATCH)`);
  }
  checkType(m, "description", "string", path);
  checkType(m, "license", "string", path);
  checkType(m, "author", "object", path);
  if (m.author) checkType(m.author, "name", "string", path);
  if (m.skills !== undefined) {
    if (checkType(m, "skills", "string", path) && m.skills !== "./skills") {
      err(path, `field "skills" must be "./skills" when plugin skills are packaged`);
    }
  }
  if (m.interface) {
    checkType(m.interface, "displayName", "string", path);
    if (Array.isArray(m.interface.capabilities)) {
      for (const cap of m.interface.capabilities) {
        if (!CAPABILITY_ENUM.includes(cap)) {
          err(path, `capabilities contains unknown value "${cap}"; allowed: ${CAPABILITY_ENUM.join("|")}`);
        }
      }
    }
  }
  return m;
}

function parseFrontmatter(text, path) {
  // Returns { fm, bodyStart } on success, null on malformed frontmatter.
  // Frontmatter is optional per §4.13; absence yields { fm: {}, bodyStart: 0 }.
  let openLen;
  if (text.startsWith("---\n")) openLen = 4;
  else if (text.startsWith("---\r\n")) openLen = 5;
  else return { fm: {}, bodyStart: 0 };

  const afterOpen = text.slice(openLen);

  // Handle empty frontmatter: opening `---\n` immediately followed by `---`.
  if (afterOpen.startsWith("---\n") || afterOpen.startsWith("---\r\n") || afterOpen === "---") {
    const closeLen = afterOpen.startsWith("---\r\n") ? 5 : (afterOpen === "---" ? 3 : 4);
    return { fm: {}, bodyStart: openLen + closeLen };
  }

  // Closing delimiter: "\n---" must be followed by \n, \r\n, or EOF.
  // Rejects content lines like "---something" that happen to include "\n---".
  const closeRegex = /\n---(\r?\n|$)/;
  const match = closeRegex.exec(afterOpen);
  if (!match) {
    err(path, "frontmatter opening --- without closing ---");
    return null;
  }
  const block = afterOpen.slice(0, match.index);
  const fm = {};
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      err(path, `frontmatter line missing ":" → ${JSON.stringify(line)}`);
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }
  const bodyStart = openLen + match.index + match[0].length;
  return { fm, bodyStart };
}

async function checkCommandFile(plugin, filename) {
  const rel = `plugins/${plugin}/commands/${filename}`;
  const path = resolve(REPO_ROOT, rel);
  // Filename: bare name + .md
  if (!filename.endsWith(".md")) {
    err(rel, `command file extension must be .md`);
    return;
  }
  const stem = basename(filename, ".md");
  checkBareName(stem, rel, "command filename stem");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    err(rel, `could not read: ${e.message}`);
    return;
  }
  const parsed = parseFrontmatter(text, rel);
  if (parsed == null) return;
  for (const key of Object.keys(parsed.fm)) {
    if (!COMMAND_FRONTMATTER_KEYS.has(key)) {
      err(rel, `unknown frontmatter key "${key}"; allowed: ${[...COMMAND_FRONTMATTER_KEYS].join("|")}`);
    }
  }
  const body = text.slice(parsed.bodyStart).trim();
  if (!body) err(rel, `command body is empty`);
}

async function checkMarkdownFrontmatterFile(rel, allowedKeys) {
  let text;
  try {
    text = await readFile(resolve(REPO_ROOT, rel), "utf8");
  } catch (e) {
    err(rel, `could not read: ${e.message}`);
    return null;
  }
  const parsed = parseFrontmatter(text, rel);
  if (parsed == null) return null;
  for (const key of Object.keys(parsed.fm)) {
    if (!allowedKeys.has(key)) {
      err(rel, `unknown frontmatter key "${key}"; allowed: ${[...allowedKeys].join("|")}`);
    }
  }
  const body = text.slice(parsed.bodyStart).trim();
  if (!body) err(rel, `body is empty`);
  return parsed;
}

async function checkCommandsDir(plugin) {
  const dir = resolve(REPO_ROOT, `plugins/${plugin}/commands`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    // No commands dir yet — acceptable at early milestones.
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    await checkCommandFile(plugin, e);
  }
}

async function checkAgentsDir(plugin) {
  const dir = resolve(REPO_ROOT, `plugins/${plugin}/agents`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const rel = `plugins/${plugin}/agents/${e}`;
    if (!e.endsWith(".md")) {
      err(rel, `agent file extension must be .md`);
      continue;
    }
    const stem = basename(e, ".md");
    checkBareName(stem, rel, "agent filename stem");
    await checkMarkdownFrontmatterFile(rel, AGENT_FRONTMATTER_KEYS);
  }
}

async function checkSkillsDir(plugin) {
  const dir = resolve(REPO_ROOT, `plugins/${plugin}/skills`);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let hasUserInvocableSkill = false;
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory()) {
      err(`plugins/${plugin}/skills/${e.name}`, "skill entry must be a directory containing SKILL.md");
      continue;
    }
    checkBareName(e.name, `plugins/${plugin}/skills/${e.name}`, "skill directory name");
    const parsed = await checkMarkdownFrontmatterFile(
      `plugins/${plugin}/skills/${e.name}/SKILL.md`,
      SKILL_FRONTMATTER_KEYS
    );
    if (parsed?.fm?.["user-invocable"] === "true") {
      hasUserInvocableSkill = true;
    }
  }
  return hasUserInvocableSkill;
}

// Discover plugins from marketplace.json rather than hardcoding names.
// This way, adding a new plugin to the marketplace automatically subjects
// it to manifest + command-file validation without touching the linter.
const declaredPlugins = await checkMarketplace();
for (const name of declaredPlugins) {
  const manifest = await checkPluginManifest(name);
  await checkCommandsDir(name);
  const hasUserInvocableSkills = await checkSkillsDir(name);
  if (hasUserInvocableSkills && manifest?.skills !== "./skills") {
    err(`plugins/${name}/.codex-plugin/plugin.json`, `missing field "skills": "./skills" for user-invocable plugin skills`);
  }
  await checkAgentsDir(name);
}

if (errors.length > 0) {
  process.stderr.write("Manifest lint FAILED:\n");
  for (const e of errors) process.stderr.write("  ✗ " + e + "\n");
  process.exit(1);
}
process.stdout.write("✓ All manifests + plugin markdown files valid\n");
