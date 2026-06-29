import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCTOR = path.join(REPO_ROOT, "scripts", "codex-plugin-cache-doctor.mjs");
const MARKETPLACE = "relay-for-codex";
const CACHE_NAMESPACE = MARKETPLACE;
const CORE_MARKETPLACE_PLUGINS = [
  "relay-claude",
  "relay-gemini",
  "relay-kimi",
  "relay-grok",
  "relay-glm",
  "relay-deepseek",
  "api-reviewers",
];

function writeSkill(root, plugin, skill) {
  const dir = path.join(root, plugin, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
}

function writeCachedSkill(home, plugin, skill, version = "0.1.0") {
  const dir = path.join(home, "plugins", "cache", CACHE_NAMESPACE, plugin, version, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
}

function writePluginFile(root, plugin, rel, content) {
  const file = path.join(root, plugin, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function writeCachedPluginFile(home, plugin, rel, content, version = "0.1.0") {
  const file = path.join(home, "plugins", "cache", CACHE_NAMESPACE, plugin, version, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function writeConfig(home, plugin, enabled = true) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    `[plugins."${plugin}@${MARKETPLACE}"]\nenabled = ${enabled ? "true" : "false"}\n`,
    "utf8",
  );
}

function writeConfigEntries(home, entries) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    entries.map(([plugin, enabled]) => (
      `[plugins."${plugin}@${MARKETPLACE}"]\nenabled = ${enabled ? "true" : "false"}\n`
    )).join("\n"),
    "utf8",
  );
}

function writeMarketplaceManifest(root, plugins) {
  const file = path.join(root, ".agents", "plugins", "marketplace.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({
      name: MARKETPLACE,
      plugins: plugins.map(([name, sourcePath, version, installation = "AVAILABLE"]) => {
        const entry = {
          name,
          source: { source: "local", path: sourcePath },
          policy: { installation, authentication: "ON_USE" },
        };
        if (version) entry.version = version;
        return entry;
      }),
    }, null, 2)}\n`,
    "utf8",
  );
}

test("codex plugin cache doctor does not fail default profile for disabled uninstalled marketplace plugins", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-disabled-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-disabled-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = CORE_MARKETPLACE_PLUGINS;
  const activePlugins = plugins.filter((plugin) => plugin !== "relay-gemini");

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") {
      writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
      writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
    }
  }
  for (const plugin of activePlugins) {
    writeCachedPluginFile(primary, plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") writeCachedSkill(primary, plugin, `${plugin}-review`);
  }
  writeConfigEntries(primary, activePlugins
    .filter((plugin) => plugin !== "api-reviewers")
    .map((plugin) => [plugin, true]));

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.ok, true);
  assert.equal(profile.plugins["relay-gemini"].enabled, false);
  assert.equal(profile.plugins["relay-gemini"].required_for_ok, false);
  assert.equal(profile.plugins["relay-gemini"].cache_in_sync, false);
  assert.equal(profile.plugins["relay-gemini"].repo_cache_in_sync, false);
  assert.equal(profile.plugins["relay-grok"].required_for_ok, true);
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, true);
  assert.doesNotMatch(report.next_actions.join("\n"), /enable missing plugins/i);
  assert.doesNotMatch(report.next_actions.join("\n"), /Enable required disabled plugins/i);
});

test("codex plugin cache doctor flags stale enabled plugins marked not available", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-unavailable-enabled-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-unavailable-enabled-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = [["relay-gemini", "./plugins/relay-gemini", null, "NOT_AVAILABLE"]];

  writeMarketplaceManifest(repo, plugins);
  writeMarketplaceManifest(marketplaceRoot, plugins);
  writePluginFile(path.join(repo, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-gemini", "relay-gemini-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-gemini", "relay-gemini-review");
  writeCachedPluginFile(primary, "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-gemini", "relay-gemini-review");
  writeConfig(primary, "relay-gemini", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;
  const gemini = profile.plugins["relay-gemini"];
  const nextActions = report.next_actions.join("\n");

  assert.equal(report.ok, false);
  assert.equal(profile.ok, false);
  assert.equal(gemini.marketplace_installation, "NOT_AVAILABLE");
  assert.equal(gemini.available_for_install, false);
  assert.equal(gemini.configured_enabled, true);
  assert.equal(gemini.unavailable_configured_enabled, true);
  assert.equal(gemini.required_for_ok, false);
  assert.equal(gemini.cache_in_sync, true);
  assert.match(nextActions, /Disable unavailable plugins .*relay-gemini/i);
  assert.doesNotMatch(nextActions, /Enable required disabled plugins .*relay-gemini/i);
});

test("codex plugin cache doctor treats repo not-available policy as authoritative over stale installed marketplace", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-stale-installed-policy-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-stale-installed-policy-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const repoPlugins = [["relay-gemini", "./plugins/relay-gemini", null, "NOT_AVAILABLE"]];
  const staleInstalledPlugins = [["relay-gemini", "./plugins/relay-gemini", null, "AVAILABLE"]];

  writeMarketplaceManifest(repo, repoPlugins);
  writeMarketplaceManifest(marketplaceRoot, staleInstalledPlugins);
  writePluginFile(path.join(repo, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-gemini", "relay-gemini-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-gemini", "relay-gemini-review");
  writeCachedPluginFile(primary, "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-gemini", "relay-gemini-review");
  writeConfig(primary, "relay-gemini", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const gemini = report.profiles.primary.plugins["relay-gemini"];
  const nextActions = report.next_actions.join("\n");

  assert.equal(report.ok, false);
  assert.equal(gemini.marketplace_installation, "NOT_AVAILABLE");
  assert.equal(gemini.repo_marketplace_installation, "NOT_AVAILABLE");
  assert.equal(gemini.available_for_install, false);
  assert.equal(gemini.configured_enabled, true);
  assert.equal(gemini.unavailable_configured_enabled, true);
  assert.equal(gemini.required_for_ok, false);
  assert.equal(gemini.cache_in_sync, true);
  assert.match(nextActions, /Disable unavailable plugins .*relay-gemini/i);
  assert.doesNotMatch(nextActions, /Enable required disabled plugins .*relay-gemini/i);
});

test("codex plugin cache doctor explains explicitly requested unavailable disabled plugins without failing", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-unavailable-explicit-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-unavailable-explicit-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = [["relay-gemini", "./plugins/relay-gemini", null, "NOT_AVAILABLE"]];

  writeMarketplaceManifest(repo, plugins);
  writeMarketplaceManifest(marketplaceRoot, plugins);
  writePluginFile(path.join(repo, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-gemini", "relay-gemini-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-gemini", "relay-gemini-review");
  writeCachedPluginFile(primary, "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-gemini", "relay-gemini-review");
  writeConfig(primary, "relay-gemini", false);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-gemini",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const gemini = report.profiles.primary.plugins["relay-gemini"];
  const nextActions = report.next_actions.join("\n");

  assert.equal(report.ok, true);
  assert.equal(gemini.available_for_install, false);
  assert.equal(gemini.configured_enabled, false);
  assert.equal(gemini.explicitly_requested_unavailable, true);
  assert.equal(gemini.required_for_ok, false);
  assert.match(nextActions, /Omit unavailable plugins .*relay-gemini/i);
  assert.doesNotMatch(nextActions, /Enable required disabled plugins .*relay-gemini/i);
  assert.doesNotMatch(nextActions, /Disable unavailable plugins .*relay-gemini/i);
});

test("codex plugin cache doctor requires api-reviewers only when direct API reviewers are enabled", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-optional-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-optional-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = CORE_MARKETPLACE_PLUGINS;

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") {
      writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
      writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
    }
  }
  writeCachedPluginFile(primary, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-claude", "relay-claude-review");
  writeConfig(primary, "relay-claude", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.ok, true);
  assert.equal(profile.plugins["relay-claude"].required_for_ok, true);
  assert.equal(profile.plugins["relay-deepseek"].enabled, false);
  assert.equal(profile.plugins["relay-glm"].enabled, false);
  assert.equal(profile.plugins["api-reviewers"].enabled, true);
  assert.equal(profile.plugins["api-reviewers"].configured_enabled, false);
  assert.equal(profile.plugins["api-reviewers"].required_by_enabled_plugin, false);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, false);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, false);
  assert.doesNotMatch(report.next_actions.join("\n"), /enable missing plugins/i);
  assert.doesNotMatch(report.next_actions.join("\n"), /Enable required disabled plugins/i);
});

test("codex plugin cache doctor default profile includes enabled marketplace plugins outside the core list", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-marketplace-derived-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-marketplace-derived-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = ["relay-claude", "relay-agy"];

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
    writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
  }
  writeCachedPluginFile(primary, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-claude", "relay-claude-review");
  writeConfigEntries(primary, [
    ["relay-claude", true],
    ["relay-agy", true],
  ]);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-agy"].enabled, true);
  assert.equal(profile.plugins["relay-agy"].required_for_ok, true);
  assert.equal(profile.plugins["relay-agy"].cache_in_sync, false);
});

test("codex plugin cache doctor default profile includes repo-manifest plugins missing from a stale marketplace clone", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-stale-clone-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-stale-clone-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [
    ["relay-claude", "./plugins/relay-claude"],
    ["relay-agy", "./plugins/relay-agy"],
  ]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-claude", "./plugins/relay-claude"]]);
  for (const plugin of ["relay-claude", "relay-agy"]) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
  }
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-claude", "relay-claude-review");
  writeCachedPluginFile(primary, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-claude", "relay-claude-review");
  writeConfigEntries(primary, [
    ["relay-claude", true],
    ["relay-agy", true],
  ]);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-agy"].enabled, true);
  assert.equal(profile.plugins["relay-agy"].required_for_ok, true);
  assert.equal(profile.plugins["relay-agy"].cache_in_sync, false);
});

test("codex plugin cache doctor fails required plugins missing from the active marketplace manifest", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-manifest-membership-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-manifest-membership-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [
    ["relay-claude", "./plugins/relay-claude"],
    ["relay-agy", "./plugins/agy"],
  ]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-claude", "./plugins/relay-claude"]]);
  writePluginFile(path.join(repo, "plugins"), "agy", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "agy", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "agy", "relay-agy-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "agy", "relay-agy-review");
  writeCachedPluginFile(primary, "relay-agy", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-agy", "relay-agy-review");
  writeConfig(primary, "relay-agy", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-agy"].enabled, true);
  assert.equal(profile.plugins["relay-agy"].required_for_ok, true);
  assert.equal(profile.plugins["relay-agy"].cache_in_sync, true);
  assert.equal(profile.plugins["relay-agy"].repo_cache_in_sync, true);
  assert.equal(profile.plugins["relay-agy"].listed_in_marketplace_manifest, false);
  assert.match(report.next_actions.join("\n"), /required plugins appear in the installed marketplace manifest: relay-agy/);
});

test("codex plugin cache doctor default profile includes config-enabled plugins absent from manifests", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-config-enabled-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-config-enabled-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-claude", "./plugins/relay-claude"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-claude", "./plugins/relay-claude"]]);
  writePluginFile(path.join(repo, "plugins"), "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(repo, "plugins"), "relay-deepseek", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(repo, "plugins"), "api-reviewers", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-claude", "relay-claude-review");
  writeSkill(path.join(repo, "plugins"), "relay-deepseek", "deepseek-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-claude", "relay-claude-review");
  writeCachedPluginFile(primary, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-claude", "relay-claude-review");
  writeCachedPluginFile(primary, "relay-deepseek", "scripts/runtime.mjs", "export const version = 'stale';\n");
  writeCachedSkill(primary, "relay-deepseek", "deepseek-review");
  writeConfigEntries(primary, [
    ["relay-claude", true],
    ["relay-deepseek", true],
  ]);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-deepseek"].enabled, true);
  assert.equal(profile.plugins["relay-deepseek"].required_for_ok, true);
  assert.equal(profile.plugins["relay-deepseek"].cache_in_sync, false);
  assert.equal(profile.plugins["api-reviewers"].required_by_enabled_plugin, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
});

test("codex plugin cache doctor ignores commented enabled values and accepts spaced section headers", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-config-comments-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-config-comments-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "grok", "relay-grok-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "grok", "relay-grok-review");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'stale';\n");
  writeCachedSkill(primary, "relay-grok", "relay-grok-review");
  mkdirSync(primary, { recursive: true });
  writeFileSync(
    path.join(primary, "config.toml"),
    `  [ plugins . "relay-grok@${MARKETPLACE}" ]\n# enabled = true\nenabled = false\n`,
    "utf8",
  );

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.plugins["relay-grok"].configured_enabled, false);
  assert.equal(profile.plugins["relay-grok"].enabled, false);
  assert.equal(profile.plugins["relay-grok"].required_for_ok, false);
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, false);
});

test("codex plugin cache doctor fallback default list includes relay-agy with its canonical source path", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-fallback-agy-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-fallback-agy-home-"));

  writePluginFile(path.join(repo, "plugins"), "agy", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "agy", "relay-agy-review");
  writeCachedPluginFile(primary, "relay-agy", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-agy", "relay-agy-review");
  writeConfig(primary, "relay-agy", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.plugins["relay-agy"].enabled, true);
  assert.equal(profile.plugins["relay-agy"].required_for_ok, true);
  assert.equal(profile.plugins["relay-agy"].source_path, "plugins/agy");
  assert.equal(profile.plugins["relay-agy"].cache_in_sync, true);
});

test("codex plugin cache doctor falls back to repo source when marketplace directory has no manifest", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-empty-marketplace-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-empty-marketplace-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  mkdirSync(marketplaceRoot, { recursive: true });

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "grok", "relay-grok-review");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-grok", "relay-grok-review");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.marketplace.present, false);
  assert.equal(report.ok, true);
  assert.equal(profile.plugins["relay-grok"].source_path, "plugins/grok");
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
});

test("codex plugin cache doctor reads non-default cache version from source metadata", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-source-version-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-source-version-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const pluginJson = `{"name":"relay-grok","version":"0.2.0"}\n`;

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", ".codex-plugin/plugin.json", pluginJson);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", ".codex-plugin/plugin.json", pluginJson);
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedPluginFile(primary, "relay-grok", ".codex-plugin/plugin.json", pluginJson, "0.2.0");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'source';\n", "0.2.0");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.plugins["relay-grok"].cache_version, "0.2.0");
  assert.match(profile.plugins["relay-grok"].cache_path, /relay-grok\/0\.2\.0$/);
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
});

test("codex plugin cache doctor reads cache version from marketplace manifest when source metadata is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-manifest-version-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-manifest-version-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok", "0.2.0"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'repo-new';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'marketplace';\n");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'marketplace';\n", "0.2.0");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'stale';\n", "0.1.0");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-grok"].marketplace_manifest_version, "0.2.0");
  assert.equal(profile.plugins["relay-grok"].cache_version, "0.2.0");
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
  assert.equal(profile.plugins["relay-grok"].repo_cache_in_sync, false);
  assert.deepEqual(profile.plugins["relay-grok"].repo_changed_files, ["scripts/runtime.mjs"]);
});

test("codex plugin cache doctor uses installed cache version when active source lacks version metadata", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-cache-version-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-cache-version-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", ".codex-plugin/plugin.json", `{"name":"relay-grok","version":"0.2.0"}\n`);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'repo-new';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'marketplace';\n");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'marketplace';\n", "0.1.0");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-grok"].cache_version, "0.1.0");
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
  assert.equal(profile.plugins["relay-grok"].repo_cache_in_sync, false);
  assert.deepEqual(profile.plugins["relay-grok"].repo_changed_files, ["scripts/runtime.mjs"]);
});

test("codex plugin cache doctor matches active source when version metadata is absent and multiple cache dirs exist", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-cache-match-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-cache-match-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(repo, "plugins"), "grok", ".codex-plugin/plugin.json", `{"name":"relay-grok","version":"0.1.0"}\n`);
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'repo-old';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'marketplace-new';\n");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'repo-old';\n", "0.1.0");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'marketplace-new';\n", "0.2.0");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-grok"].cache_version, "0.2.0");
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, true);
  assert.equal(profile.plugins["relay-grok"].repo_cache_in_sync, false);
  assert.deepEqual(profile.plugins["relay-grok"].repo_changed_files, ["scripts/runtime.mjs"]);
});

test("codex plugin cache doctor checks api-reviewers when an explicit direct API reviewer is requested", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-explicit-direct-api-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-explicit-direct-api-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = ["relay-deepseek", "api-reviewers"];

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
  }
  writeSkill(path.join(repo, "plugins"), "relay-deepseek", "deepseek-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-deepseek", "deepseek-review");
  writeCachedPluginFile(primary, "relay-deepseek", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-deepseek", "deepseek-review");
  writeConfig(primary, "relay-deepseek", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-deepseek",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.enabled, true);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.plugins["relay-deepseek"].required_for_ok, true);
  assert.equal(profile.plugins["relay-deepseek"].cache_in_sync, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, false);
  assert.deepEqual(profile.plugins["api-reviewers"].missing_files, ["scripts/runtime.mjs"]);
});

test("codex plugin cache doctor checks api-reviewers when explicit glm reviewer is requested", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-explicit-glm-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-explicit-glm-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = ["relay-glm", "api-reviewers"];

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
  }
  writeSkill(path.join(repo, "plugins"), "relay-glm", "glm-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-glm", "glm-review");
  writeCachedPluginFile(primary, "relay-glm", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-glm", "glm-review");
  writeConfig(primary, "relay-glm", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-glm",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.summary_plugin, "relay-glm");
  assert.equal(profile.enabled, true);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.plugins["relay-glm"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, false);
});

test("codex plugin cache doctor honors explicit api-reviewers config enablement", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-config-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-config-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = CORE_MARKETPLACE_PLUGINS;

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") {
      writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
      writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
    }
  }
  writeCachedPluginFile(primary, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-claude", "relay-claude-review");
  writeConfigEntries(primary, [
    ["relay-claude", true],
    ["relay-deepseek", false],
    ["relay-glm", false],
    ["api-reviewers", true],
  ]);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-claude"].required_for_ok, true);
  assert.equal(profile.plugins["relay-deepseek"].enabled, false);
  assert.equal(profile.plugins["relay-glm"].enabled, false);
  assert.equal(profile.plugins["api-reviewers"].enabled, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, false);
});

test("codex plugin cache doctor fails default profile when enabled direct API reviewer has stale api-reviewers runtime", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-default-direct-api-stale-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-default-direct-api-stale-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = CORE_MARKETPLACE_PLUGINS;

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") {
      writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
      writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
    }
  }
  writeCachedPluginFile(primary, "relay-deepseek", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-deepseek", "relay-deepseek-review");
  writeCachedPluginFile(primary, "api-reviewers", "scripts/runtime.mjs", "export const version = 'stale';\n");
  writeConfig(primary, "relay-deepseek", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-deepseek"].required_for_ok, true);
  assert.equal(profile.plugins["relay-deepseek"].cache_in_sync, true);
  assert.equal(profile.plugins["api-reviewers"].configured_enabled, false);
  assert.equal(profile.plugins["api-reviewers"].required_by_enabled_plugin, true);
  assert.equal(profile.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(profile.plugins["api-reviewers"].cache_in_sync, false);
  assert.deepEqual(profile.plugins["api-reviewers"].changed_files, ["scripts/runtime.mjs"]);
});

test("codex plugin cache doctor applies api-reviewers dependency per Codex home", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-home-split-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-home-split-primary-"));
  const second = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-api-runtime-home-split-second-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = CORE_MARKETPLACE_PLUGINS;

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  for (const plugin of plugins) {
    writePluginFile(path.join(repo, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    writePluginFile(path.join(marketplaceRoot, "plugins"), plugin, "scripts/runtime.mjs", "export const version = 'source';\n");
    if (plugin !== "api-reviewers") {
      writeSkill(path.join(repo, "plugins"), plugin, `${plugin}-review`);
      writeSkill(path.join(marketplaceRoot, "plugins"), plugin, `${plugin}-review`);
    }
  }
  writeCachedPluginFile(primary, "relay-deepseek", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-deepseek", "relay-deepseek-review");
  writeCachedPluginFile(primary, "api-reviewers", "scripts/runtime.mjs", "export const version = 'stale';\n");
  writeCachedPluginFile(second, "relay-claude", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(second, "relay-claude", "relay-claude-review");
  writeConfig(primary, "relay-deepseek", true);
  writeConfig(second, "relay-claude", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--second-codex-home", second,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, false);
  assert.equal(report.profiles.primary.ok, false);
  assert.equal(report.profiles.primary.plugins["api-reviewers"].required_by_enabled_plugin, true);
  assert.equal(report.profiles.primary.plugins["api-reviewers"].required_for_ok, true);
  assert.equal(report.profiles.primary.plugins["api-reviewers"].cache_in_sync, false);
  assert.equal(report.profiles.second.ok, true);
  assert.equal(report.profiles.second.plugins["api-reviewers"].required_by_enabled_plugin, false);
  assert.equal(report.profiles.second.plugins["api-reviewers"].required_for_ok, false);
});

test("codex plugin cache doctor compares each Codex home against its own marketplace clone", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-home-source-split-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-home-source-split-primary-"));
  const second = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-home-source-split-second-"));
  const primaryMarketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const secondMarketplaceRoot = path.join(second, ".tmp", "marketplaces", MARKETPLACE);
  mkdirSync(primaryMarketplaceRoot, { recursive: true });

  writeMarketplaceManifest(secondMarketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writePluginFile(path.join(secondMarketplaceRoot, "plugins"), "grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(secondMarketplaceRoot, "plugins"), "grok", "relay-grok-review");
  writeCachedPluginFile(second, "relay-grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(second, "relay-grok", "relay-grok-review");
  writeConfig(second, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--second-codex-home", second,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, true);
  assert.equal(report.marketplace.present, false);
  assert.equal(report.marketplaces.primary.present, false);
  assert.equal(report.marketplaces.second.present, true);
  assert.equal(report.marketplaces.second.source_root, secondMarketplaceRoot);
  assert.equal(report.profiles.primary.ok, true);
  assert.equal(report.profiles.second.ok, true);
  assert.equal(report.profiles.second.plugins["relay-grok"].enabled, true);
  assert.equal(report.profiles.second.plugins["relay-grok"].required_for_ok, true);
  assert.equal(report.profiles.second.plugins["relay-grok"].source_path, "plugins/grok");
  assert.equal(report.profiles.second.plugins["relay-grok"].cache_in_sync, true);
});

test("codex plugin cache doctor fails default profile when an enabled regular plugin is stale", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-default-regular-stale-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-default-regular-stale-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = ["relay-grok"];

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writePluginFile(path.join(repo, "plugins"), "relay-grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-grok", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-grok", "grok-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-grok", "grok-review");
  writeCachedPluginFile(primary, "relay-grok", "scripts/runtime.mjs", "export const version = 'stale';\n");
  writeCachedSkill(primary, "relay-grok", "grok-review");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.plugins["relay-grok"].enabled, true);
  assert.equal(profile.plugins["relay-grok"].required_for_ok, true);
  assert.equal(profile.plugins["relay-grok"].cache_in_sync, false);
});

test("codex plugin cache doctor names explicitly required disabled plugins in next actions", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-disabled-required-action-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-disabled-required-action-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const plugins = ["relay-gemini"];

  writeMarketplaceManifest(repo, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writeMarketplaceManifest(marketplaceRoot, plugins.map((plugin) => [plugin, `./plugins/${plugin}`]));
  writePluginFile(path.join(repo, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeSkill(path.join(repo, "plugins"), "relay-gemini", "gemini-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "relay-gemini", "gemini-review");
  writeCachedPluginFile(primary, "relay-gemini", "scripts/runtime.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-gemini", "gemini-review");
  writeConfig(primary, "relay-gemini", false);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-gemini",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const nextActions = report.next_actions.join("\n");

  assert.equal(report.ok, false);
  assert.match(nextActions, /Enable required disabled plugins/i);
  assert.match(nextActions, /relay-gemini/);
});

test("codex plugin cache doctor follows marketplace source.path for public plugin names", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-mapped-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-mapped-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/grok"]]);
  writeSkill(path.join(repo, "plugins"), "grok", "grok-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "grok", "grok-review");
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-grok", "grok-review");
  writeCachedPluginFile(primary, "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.repo_present, true);
  assert.equal(profile.repo_cache_in_sync, true);
  assert.deepEqual(profile.plugins["relay-grok"].expected_skills, ["grok-review"]);
  assert.deepEqual(profile.changed_files, []);
  assert.deepEqual(profile.repo_changed_files, []);
});

test("codex plugin cache doctor falls back to repo source.path when marketplace manifest is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-fallback-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-fallback-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);

  mkdirSync(marketplaceRoot, { recursive: true });
  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/grok"]]);
  writeSkill(path.join(repo, "plugins"), "grok", "grok-review");
  writeSkill(path.join(marketplaceRoot, "plugins"), "grok", "grok-review");
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writePluginFile(path.join(marketplaceRoot, "plugins"), "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeCachedSkill(primary, "relay-grok", "grok-review");
  writeCachedPluginFile(primary, "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.plugins["relay-grok"].source_path, "plugins/grok");
  assert.equal(profile.repo_cache_in_sync, true);
});

test("codex plugin cache doctor reports stale cache, enablement, and restart guidance", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-primary-"));
  const second = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-second-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const marketplace = path.join(marketplaceRoot, "plugins");

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/relay-grok"]]);
  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/relay-grok"]]);
  writeSkill(path.join(repo, "plugins"), "relay-grok", "grok-review");
  writeSkill(marketplace, "relay-grok", "grok-review");
  writeCachedSkill(primary, "relay-grok", "grok-delegation");
  writeCachedSkill(second, "relay-grok", "grok-review");
  writeConfig(primary, "relay-grok", true);
  writeConfig(second, "relay-grok", false);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--second-codex-home", second,
    "--plugin", "relay-grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, false);
  assert.equal(report.marketplace.present, true);
  assert.equal(report.profiles.primary.enabled, true);
  assert.equal(report.profiles.primary.plugins["relay-grok"].required_for_ok, true);
  assert.equal(report.profiles.primary.cache_in_sync, false);
  assert.deepEqual(report.profiles.primary.missing_skills, ["grok-review"]);
  assert.equal(report.profiles.second.enabled, false);
  assert.equal(report.profiles.second.plugins["relay-grok"].required_for_ok, true);
  assert.equal(report.profiles.second.cache_in_sync, true);
  assert.equal(report.marketplace.name, MARKETPLACE);
  assert.equal(report.marketplace.cache_namespace, CACHE_NAMESPACE);
  assert.match(report.next_actions.join("\n"), /codex plugin marketplace upgrade relay-for-codex/);
  assert.match(report.next_actions.join("\n"), /restart/i);
  assert.match(report.next_actions.join("\n"), /codex debug prompt-input 'list skills'/);
});

test("codex plugin cache doctor reports stale runtime files even when skill names match", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-home-"));

  writeMarketplaceManifest(repo, [["relay-grok", "./plugins/relay-grok"]]);
  writeSkill(path.join(repo, "plugins"), "relay-grok", "grok-review");
  writeCachedSkill(primary, "relay-grok", "grok-review");
  writePluginFile(path.join(repo, "plugins"), "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeCachedPluginFile(primary, "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'stale-cache';\n");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.enabled, true);
  assert.equal(profile.cache_in_sync, false);
  assert.deepEqual(profile.missing_skills, []);
  assert.deepEqual(profile.changed_files, ["scripts/grok-web-reviewer.mjs"]);
});

test("codex plugin cache doctor reports stale packaged bin shims", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-bin-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-bin-home-"));

  writeSkill(path.join(repo, "plugins"), "api-reviewers", "deepseek-setup");
  writeCachedSkill(primary, "api-reviewers", "deepseek-setup");
  writePluginFile(path.join(repo, "plugins"), "api-reviewers", "bin/api-reviewer", "source shim\n");
  writeCachedPluginFile(primary, "api-reviewers", "bin/api-reviewer", "stale shim\n");
  writeConfig(primary, "api-reviewers", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "api-reviewers",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.repo_cache_in_sync, false);
  assert.deepEqual(profile.repo_changed_files, ["bin/api-reviewer"]);
});

test("codex plugin cache doctor flags repo changes even when marketplace cache is in sync", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-dirty-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-dirty-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const marketplace = path.join(marketplaceRoot, "plugins");

  writeMarketplaceManifest(repo, [["api-reviewers", "./plugins/api-reviewers"]]);
  writeMarketplaceManifest(marketplaceRoot, [["api-reviewers", "./plugins/api-reviewers"]]);
  writeSkill(path.join(repo, "plugins"), "api-reviewers", "deepseek-setup");
  writeSkill(marketplace, "api-reviewers", "deepseek-setup");
  writeCachedSkill(primary, "api-reviewers", "deepseek-setup");
  writePluginFile(path.join(repo, "plugins"), "api-reviewers", "scripts/api-reviewer.mjs", "export const version = 'repo-new';\n");
  writePluginFile(marketplace, "api-reviewers", "scripts/api-reviewer.mjs", "export const version = 'marketplace-old';\n");
  writeCachedPluginFile(primary, "api-reviewers", "scripts/api-reviewer.mjs", "export const version = 'marketplace-old';\n");
  writeConfig(primary, "api-reviewers", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "api-reviewers",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.repo_cache_in_sync, false);
  assert.deepEqual(profile.repo_changed_files, ["scripts/api-reviewer.mjs"]);
  assert.match(report.next_actions.join("\n"), /repo working tree differs from installed plugin cache/i);
});

test("codex plugin cache doctor checks internal api-reviewers runtime without requiring enablement", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const marketplace = path.join(marketplaceRoot, "plugins");

  writeMarketplaceManifest(repo, [["api-reviewers", "./plugins/api-reviewers"]]);
  writeMarketplaceManifest(marketplaceRoot, [["api-reviewers", "./plugins/api-reviewers"]]);
  writePluginFile(path.join(repo, "plugins"), "api-reviewers", "scripts/api-reviewer.mjs", "source runtime\n");
  writePluginFile(marketplace, "api-reviewers", "scripts/api-reviewer.mjs", "source runtime\n");
  writeCachedPluginFile(primary, "api-reviewers", "scripts/api-reviewer.mjs", "source runtime\n");

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "api-reviewers",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.enabled, true);
  assert.equal(profile.plugins["api-reviewers"].internal_runtime, true);
  assert.equal(profile.cache_in_sync, true);
  assert.deepEqual(profile.plugins["api-reviewers"].expected_skills, []);
  assert.deepEqual(profile.changed_files, []);
});

test("codex plugin cache doctor does not fail repo-cache check when repo plugin source is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-no-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-no-repo-home-"));
  const marketplaceRoot = path.join(primary, ".tmp", "marketplaces", MARKETPLACE);
  const marketplace = path.join(marketplaceRoot, "plugins");

  writeMarketplaceManifest(marketplaceRoot, [["relay-grok", "./plugins/relay-grok"]]);
  writeSkill(marketplace, "relay-grok", "grok-review");
  writeCachedSkill(primary, "relay-grok", "grok-review");
  writePluginFile(marketplace, "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'marketplace';\n");
  writeCachedPluginFile(primary, "relay-grok", "scripts/grok-web-reviewer.mjs", "export const version = 'marketplace';\n");
  writeConfig(primary, "relay-grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "relay-grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, true);
  assert.equal(profile.enabled, true);
  assert.equal(profile.cache_in_sync, true);
  assert.equal(profile.repo_present, false);
  assert.equal(profile.repo_cache_in_sync, null);
});

test("codex plugin cache doctor sorts file lists with explicit comparators", () => {
  const source = readFileSync(DOCTOR, "utf8");

  assert.doesNotMatch(source, /\[\.\.\.(?:expected|cached)\.keys\(\)\]\.sort\(\)/);
});

test("codex plugin cache doctor prints help without requiring an option value", () => {
  for (const args of [["--help"], ["-h"]]) {
    const result = spawnSync(process.execPath, [DOCTOR, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")} must succeed`);
    assert.match(result.stdout, /Usage: codex-plugin-cache-doctor/);
    assert.match(result.stdout, /--plugin <name>/);
    assert.equal(result.stderr, "");
  }
});

test("codex plugin cache doctor rejects unsafe or missing option values", () => {
  for (const args of [
    ["--__proto__", "polluted"],
    ["--constructor", "polluted"],
    ["--repo"],
    ["--plugin"],
  ]) {
    const result = spawnSync(process.execPath, [DOCTOR, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `${args.join(" ")} must fail`);
    assert.equal({}.polluted, undefined);
  }
});
