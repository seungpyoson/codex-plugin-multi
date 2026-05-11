import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCTOR = path.join(REPO_ROOT, "scripts", "codex-plugin-cache-doctor.mjs");

function writeSkill(root, plugin, skill) {
  const dir = path.join(root, plugin, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
}

function writeCachedSkill(home, plugin, skill) {
  const dir = path.join(home, "plugins", "cache", "codex-plugin-multi", plugin, "0.1.0", "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
}

function writePluginFile(root, plugin, rel, content) {
  const file = path.join(root, plugin, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function writeCachedPluginFile(home, plugin, rel, content) {
  const file = path.join(home, "plugins", "cache", "codex-plugin-multi", plugin, "0.1.0", rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function writeConfig(home, plugin, enabled = true) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(home, "config.toml"),
    `[plugins."${plugin}@codex-plugin-multi"]\nenabled = ${enabled ? "true" : "false"}\n`,
    "utf8",
  );
}

test("codex plugin cache doctor reports stale cache, enablement, and restart guidance", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-primary-"));
  const second = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-second-"));
  const marketplace = path.join(primary, ".tmp", "marketplaces", "codex-plugin-multi", "plugins");

  writeSkill(path.join(repo, "plugins"), "grok", "grok-review");
  writeSkill(marketplace, "grok", "grok-review");
  writeCachedSkill(primary, "grok", "grok-delegation");
  writeCachedSkill(second, "grok", "grok-review");
  writeConfig(primary, "grok", true);
  writeConfig(second, "grok", false);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--second-codex-home", second,
    "--plugin", "grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);

  assert.equal(report.ok, false);
  assert.equal(report.marketplace.present, true);
  assert.equal(report.profiles.primary.enabled, true);
  assert.equal(report.profiles.primary.cache_in_sync, false);
  assert.deepEqual(report.profiles.primary.missing_skills, ["grok-review"]);
  assert.equal(report.profiles.second.enabled, false);
  assert.equal(report.profiles.second.cache_in_sync, true);
  assert.match(report.next_actions.join("\n"), /codex plugin marketplace upgrade codex-plugin-multi/);
  assert.match(report.next_actions.join("\n"), /restart/i);
  assert.match(report.next_actions.join("\n"), /codex debug prompt-input 'list skills'/);
});

test("codex plugin cache doctor reports stale runtime files even when skill names match", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-runtime-home-"));

  writeSkill(path.join(repo, "plugins"), "grok", "grok-review");
  writeCachedSkill(primary, "grok", "grok-review");
  writePluginFile(path.join(repo, "plugins"), "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'source';\n");
  writeCachedPluginFile(primary, "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'stale-cache';\n");
  writeConfig(primary, "grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "grok",
  ], { encoding: "utf8" });
  const report = JSON.parse(stdout);
  const profile = report.profiles.primary;

  assert.equal(report.ok, false);
  assert.equal(profile.enabled, true);
  assert.equal(profile.cache_in_sync, false);
  assert.deepEqual(profile.missing_skills, []);
  assert.deepEqual(profile.changed_files, ["scripts/grok-web-reviewer.mjs"]);
});

test("codex plugin cache doctor flags repo changes even when marketplace cache is in sync", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-dirty-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-dirty-home-"));
  const marketplace = path.join(primary, ".tmp", "marketplaces", "codex-plugin-multi", "plugins");

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

test("codex plugin cache doctor does not fail repo-cache check when repo plugin source is absent", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-no-repo-"));
  const primary = mkdtempSync(path.join(tmpdir(), "plugin-cache-doctor-no-repo-home-"));
  const marketplace = path.join(primary, ".tmp", "marketplaces", "codex-plugin-multi", "plugins");

  writeSkill(marketplace, "grok", "grok-review");
  writeCachedSkill(primary, "grok", "grok-review");
  writePluginFile(marketplace, "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'marketplace';\n");
  writeCachedPluginFile(primary, "grok", "scripts/grok-web-reviewer.mjs", "export const version = 'marketplace';\n");
  writeConfig(primary, "grok", true);

  const stdout = execFileSync(process.execPath, [
    DOCTOR,
    "--repo", repo,
    "--codex-home", primary,
    "--plugin", "grok",
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
