#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const MARKETPLACE = "codex-plugin-multi";
const DEFAULT_PLUGINS = ["api-reviewers", "claude", "gemini", "grok", "kimi"];

function comparePathStrings(a, b) {
  return a.localeCompare(b);
}

function parseArgs(argv) {
  const out = Object.create(null);
  out.plugins = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--plugin") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--plugin requires a value");
      out.plugins.push(value);
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[++i];
      if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`unsupported option ${token}`);
      }
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      out[key] = value;
    }
  }
  return out;
}

function listSkills(root, plugin) {
  const dir = join(root, plugin, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort(comparePathStrings);
}

function comparablePluginFile(rel) {
  if (rel === "package.json" || rel === ".codex-plugin/plugin.json") return true;
  return rel.startsWith("commands/")
    || rel.startsWith("skills/")
    || rel.startsWith("scripts/")
    || rel.startsWith("config/");
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listComparableFiles(pluginRoot) {
  const files = new Map();
  if (!existsSync(pluginRoot)) return files;
  const stack = [pluginRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => comparePathStrings(a.name, b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(pluginRoot, full);
      if (comparablePluginFile(rel)) files.set(rel, fileHash(full));
    }
  }
  return files;
}

function compareFileHashes(expected, cached) {
  const expectedNames = [...expected.keys()].sort(comparePathStrings);
  const cachedNames = [...cached.keys()].sort(comparePathStrings);
  return {
    expected_files: expectedNames,
    cached_files: cachedNames,
    missing_files: expectedNames.filter((file) => !cached.has(file)),
    extra_files: cachedNames.filter((file) => !expected.has(file)),
    changed_files: expectedNames.filter((file) => cached.has(file) && cached.get(file) !== expected.get(file)),
  };
}

function enabledInConfig(home, plugin) {
  const config = join(home, "config.toml");
  if (!existsSync(config)) return false;
  const text = readFileSync(config, "utf8");
  const escaped = `${plugin}@${MARKETPLACE}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\[plugins\\."${escaped}"\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text);
  return match ? /\benabled\s*=\s*true\b/.test(match[1]) : false;
}

function profileReport(name, home, plugins, sourceRoot) {
  const pluginReports = {};
  let ok = true;
  for (const plugin of plugins) {
    const expected = listSkills(sourceRoot, plugin);
    const sourcePluginRoot = join(sourceRoot, plugin);
    const cacheRoot = join(home, "plugins", "cache", MARKETPLACE, plugin, "0.1.0");
    const cached = listSkills(cacheRoot, ".");
    const missing = expected.filter((skill) => !cached.includes(skill));
    const extra = cached.filter((skill) => !expected.includes(skill));
    const fileComparison = compareFileHashes(listComparableFiles(sourcePluginRoot), listComparableFiles(cacheRoot));
    const filesInSync = fileComparison.missing_files.length === 0
      && fileComparison.extra_files.length === 0
      && fileComparison.changed_files.length === 0
      && fileComparison.expected_files.length > 0;
    const inSync = missing.length === 0 && extra.length === 0 && expected.length > 0 && filesInSync;
    const enabled = enabledInConfig(home, plugin);
    if (!inSync || !enabled) ok = false;
    pluginReports[plugin] = {
      enabled,
      cache_path: cacheRoot,
      cache_in_sync: inSync,
      expected_skills: expected,
      cached_skills: cached,
      missing_skills: missing,
      extra_skills: extra,
      ...fileComparison,
    };
  }
  return {
    name,
    home,
    enabled: plugins.length === 1 ? pluginReports[plugins[0]].enabled : undefined,
    cache_in_sync: plugins.length === 1 ? pluginReports[plugins[0]].cache_in_sync : undefined,
    missing_skills: plugins.length === 1 ? pluginReports[plugins[0]].missing_skills : undefined,
    missing_files: plugins.length === 1 ? pluginReports[plugins[0]].missing_files : undefined,
    extra_files: plugins.length === 1 ? pluginReports[plugins[0]].extra_files : undefined,
    changed_files: plugins.length === 1 ? pluginReports[plugins[0]].changed_files : undefined,
    plugins: pluginReports,
    ok,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(args.repo ?? process.cwd());
  const primaryHome = resolve(args["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const secondHome = args["second-codex-home"] ? resolve(args["second-codex-home"]) : null;
  const plugins = args.plugins.length > 0 ? args.plugins : DEFAULT_PLUGINS;
  const repoPlugins = join(repo, "plugins");
  const marketplaceRoot = join(primaryHome, ".tmp", "marketplaces", MARKETPLACE);
  const marketplacePlugins = join(marketplaceRoot, "plugins");
  const sourceRoot = existsSync(marketplacePlugins) ? marketplacePlugins : repoPlugins;

  const profiles = {
    primary: profileReport("primary", primaryHome, plugins, sourceRoot),
  };
  if (secondHome) profiles.second = profileReport("second", secondHome, plugins, sourceRoot);

  const ok = Object.values(profiles).every((profile) => profile.ok);
  const nextActions = [];
  if (!existsSync(marketplaceRoot)) {
    nextActions.push("Add the marketplace with `codex plugin marketplace add seungpyoson/codex-plugin-multi`.");
  } else {
    nextActions.push("Refresh Git marketplace installs with `codex plugin marketplace upgrade codex-plugin-multi`.");
  }
  nextActions.push("If upgrade reports `not configured as a Git marketplace`, remove and re-add the marketplace from GitHub.");
  nextActions.push("Enable missing plugins in `/plugins` or config.toml for the Codex profile that will run reviews.");
  nextActions.push("Restart already-open Codex TUI sessions; skill picker inventory is loaded in memory.");
  nextActions.push("Verify with `codex debug prompt-input 'list skills'` from the target CODEX_HOME.");

  process.stdout.write(`${JSON.stringify({
    ok,
    repo,
    marketplace: {
      name: MARKETPLACE,
      root: marketplaceRoot,
      present: existsSync(marketplaceRoot),
      source_root: sourceRoot,
    },
    profiles,
    next_actions: nextActions,
  }, null, 2)}\n`);
}

main();
