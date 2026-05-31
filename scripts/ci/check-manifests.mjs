#!/usr/bin/env node
// Manifest linter — validates marketplace.json, plugin.json files, and plugin
// markdown frontmatter. Exits non-zero on any violation.
// Run in CI and locally via `npm run lint`.

import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_MARKETPLACE_AUTHENTICATION_POLICIES,
  CODEX_MARKETPLACE_INSTALLATION_POLICIES,
} from "../lib/codex-marketplace-schema.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bare-name regex: lowercase identifier with optional *internal* hyphens.
// Rejects colons, slashes, whitespace, uppercase, leading/trailing hyphens —
// required per spec §4.13/§5.1.
const BARE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Codex recognizes these capability strings (verified in codex-rs
// core-plugins/src/marketplace_tests.rs:1168,1204,1296,1320).
const CAPABILITY_ENUM = ["Interactive", "Read", "Write"];

// Command frontmatter keys allowed by Codex and upstream command contracts.
const COMMAND_FRONTMATTER_KEYS = new Set([
  "description",
  "argument-hint",
  "allowed-tools",
  "disable-model-invocation",
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
  if (!checkMarketplaceRoot(m, path)) return [];

  const declared = [];
  for (const [i, plugin] of m.plugins.entries()) {
    const declaration = checkMarketplacePlugin(plugin, path, i);
    if (declaration) declared.push(declaration);
  }
  return declared;
}

function checkMarketplaceRoot(m, path) {
  checkType(m, "name", "string", path);
  if (m.name) checkBareName(m.name, path, "marketplace name");
  checkType(m, "interface", "object", path);
  if (m.interface) checkType(m.interface, "displayName", "string", path);
  if (!checkType(m, "plugins", "array", path)) return false;
  if (m.plugins.length === 0) err(path, "plugins array is empty");
  return true;
}

function checkMarketplacePlugin(plugin, marketplacePath, index) {
  const path = `${marketplacePath}:plugins[${index}]`;
  const name = readMarketplacePluginName(plugin, path);
  const sourcePath = readMarketplacePluginSourcePath(plugin, path);
  checkMarketplacePluginPolicy(plugin, path);
  if (!name || !sourcePath) return null;
  return { name, sourcePath };
}

function readMarketplacePluginName(plugin, path) {
  if (!checkType(plugin, "name", "string", path)) return null;
  checkBareName(plugin.name, path, "plugin name");
  return plugin.name;
}

function readMarketplacePluginSourcePath(plugin, path) {
  checkType(plugin, "source", "object", path);
  if (!plugin.source) return null;
  checkType(plugin.source, "source", "string", path);
  oneOf(plugin.source, "source", ["local", "git"], path, { required: true });
  if (!checkType(plugin.source, "path", "string", path)) return null;
  return plugin.source.path;
}

function checkMarketplacePluginPolicy(plugin, path) {
  checkType(plugin, "policy", "object", path);
  if (!plugin.policy) return;
  oneOf(plugin.policy, "installation", CODEX_MARKETPLACE_INSTALLATION_POLICIES, path, {
    required: true,
  });
  oneOf(plugin.policy, "authentication", CODEX_MARKETPLACE_AUTHENTICATION_POLICIES, path, {
    required: true,
  });
}

function normalizeSourcePath(sourcePath) {
  let normalized = sourcePath;
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

async function checkPluginManifest({ name, sourcePath }) {
  const pluginRoot = normalizeSourcePath(sourcePath);
  const path = `${pluginRoot}/.codex-plugin/plugin.json`;
  const manifest = await readJson(path);
  if (!manifest) return null;
  checkForbiddenPluginManifestKeys(manifest, path);
  checkPluginManifestIdentity(manifest, name, path);
  checkPluginManifestVersion(manifest, path);
  checkType(manifest, "description", "string", path);
  checkType(manifest, "license", "string", path);
  checkType(manifest, "author", "object", path);
  if (manifest.author) checkType(manifest.author, "name", "string", path);
  checkPluginManifestSkills(manifest, path);
  checkPluginManifestInterface(manifest, path);
  return manifest;
}

function checkForbiddenPluginManifestKeys(manifest, path) {
  for (const [key, reason] of FORBIDDEN_PLUGIN_MANIFEST_KEYS) {
    if (key in manifest) {
      err(path, `field "${key}" is forbidden until ${reason}`);
    }
  }
}

function checkPluginManifestIdentity(manifest, name, path) {
  if (!checkType(manifest, "name", "string", path)) return;
  checkBareName(manifest.name, path, "plugin name");
  if (manifest.name !== name) {
    err(path, `name "${manifest.name}" does not match marketplace plugin "${name}"`);
  }
}

function checkPluginManifestVersion(manifest, path) {
  if (!checkType(manifest, "version", "string", path)) return;
  if (!SEMVER.test(manifest.version)) {
    err(path, `version "${manifest.version}" is not valid semver (MAJOR.MINOR.PATCH)`);
  }
}

function checkPluginManifestSkills(manifest, path) {
  if (manifest.skills === undefined) return;
  if (checkType(manifest, "skills", "string", path) && manifest.skills !== "./skills") {
    err(path, `field "skills" must be "./skills" when plugin skills are packaged`);
  }
}

function checkPluginManifestInterface(manifest, path) {
  if (!manifest.interface) return;
  checkType(manifest.interface, "displayName", "string", path);
  if (!Array.isArray(manifest.interface.capabilities)) return;
  for (const capability of manifest.interface.capabilities) {
    if (!CAPABILITY_ENUM.includes(capability)) {
      err(path, `capabilities contains unknown value "${capability}"; allowed: ${CAPABILITY_ENUM.join("|")}`);
    }
  }
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
  const rel = `${plugin}/commands/${filename}`;
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

async function checkCommandsDir(pluginRoot) {
  const dir = resolve(REPO_ROOT, pluginRoot, "commands");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    // No commands dir yet — acceptable at early milestones.
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    await checkCommandFile(pluginRoot, e);
  }
}

async function checkAgentsDir(pluginRoot) {
  const dir = resolve(REPO_ROOT, pluginRoot, "agents");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const rel = `${pluginRoot}/agents/${e}`;
    if (!e.endsWith(".md")) {
      err(rel, `agent file extension must be .md`);
      continue;
    }
    const stem = basename(e, ".md");
    checkBareName(stem, rel, "agent filename stem");
    await checkMarkdownFrontmatterFile(rel, AGENT_FRONTMATTER_KEYS);
  }
}

async function checkSkillsDir(pluginRoot) {
  const dir = resolve(REPO_ROOT, pluginRoot, "skills");
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
      err(`${pluginRoot}/skills/${e.name}`, "skill entry must be a directory containing SKILL.md");
      continue;
    }
    checkBareName(e.name, `${pluginRoot}/skills/${e.name}`, "skill directory name");
    const parsed = await checkMarkdownFrontmatterFile(
      `${pluginRoot}/skills/${e.name}/SKILL.md`,
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
for (const plugin of declaredPlugins) {
  const pluginRoot = normalizeSourcePath(plugin.sourcePath);
  const manifest = await checkPluginManifest(plugin);
  await checkCommandsDir(pluginRoot);
  const hasUserInvocableSkills = await checkSkillsDir(pluginRoot);
  if (hasUserInvocableSkills && manifest?.skills !== "./skills") {
    err(`${pluginRoot}/.codex-plugin/plugin.json`, `missing field "skills": "./skills" for user-invocable plugin skills`);
  }
  await checkAgentsDir(pluginRoot);
}

if (errors.length > 0) {
  process.stderr.write("Manifest lint FAILED:\n");
  for (const e of errors) process.stderr.write("  ✗ " + e + "\n");
  process.exit(1);
}
process.stdout.write("✓ All manifests + plugin markdown files valid\n");
