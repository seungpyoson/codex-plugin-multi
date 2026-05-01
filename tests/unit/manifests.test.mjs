import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

test("marketplace.json: valid schema", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.interface.displayName, "string");
  assert.ok(Array.isArray(m.plugins));
  assert.ok(m.plugins.length >= 1);
  for (const p of m.plugins) {
    assert.equal(typeof p.name, "string");
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name), `${p.name} not bare`);
    assert.ok(["AVAILABLE", "DEFAULT", "HIDDEN"].includes(p.policy.installation));
    assert.ok(["ON_INSTALL", "ON_USE"].includes(p.policy.authentication));
    assert.ok(["local", "git"].includes(p.source.source));
  }
});

test("claude plugin.json: valid schema", () => {
  const m = readJson("plugins/claude/.codex-plugin/plugin.json");
  assert.equal(m.name, "claude");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
  assert.ok(m.interface.capabilities.every((c) => ["Interactive", "Read", "Write"].includes(c)));
});

test("gemini plugin.json: valid schema", () => {
  const m = readJson("plugins/gemini/.codex-plugin/plugin.json");
  assert.equal(m.name, "gemini");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "AGPL-3.0-only");
  assert.equal(m.skills, "./skills");
});

test("both plugins declared in marketplace match filesystem layout", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  for (const p of m.plugins) {
    const manifest = readJson(`plugins/${p.name}/.codex-plugin/plugin.json`);
    assert.equal(manifest.name, p.name, `${p.name} directory plugin.json name mismatch`);
  }
});

test("claude and gemini package non-ping command docs until upstream slash support lands", () => {
  const commands = [
    "review", "adversarial-review", "rescue",
    "setup", "status", "result", "cancel",
  ];
  for (const plugin of ["claude", "gemini"]) {
    for (const command of commands) {
      const rel = `plugins/${plugin}/commands/${plugin}-${command}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${rel} missing`);
    }
    const pingRel = `plugins/${plugin}/commands/${plugin}-ping.md`;
    assert.equal(existsSync(path.join(REPO_ROOT, pingRel)), false, `${pingRel} must stay deferred`);
  }
});

test("claude and gemini expose user-invocable skill fallbacks", () => {
  for (const plugin of ["claude", "gemini"]) {
    const rel = `plugins/${plugin}/skills/${plugin}-delegation/SKILL.md`;
    const skill = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.match(skill, new RegExp(`name: ${plugin}-delegation`));
    assert.match(skill, /user-invocable: true/);
    assert.match(skill, new RegExp(`${plugin}-companion\\.mjs`));
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    assert.ok(description.length > 0, `${rel} missing description`);
    assert.ok(description.length <= 88, `${rel} description too long for picker: ${description.length}`);
  }
});

test("README documents install verification for discoverable delegation skills", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  assert.match(readme, /Verify skill discovery after installation/);
  assert.match(readme, /claude-delegation/);
  assert.match(readme, /gemini-delegation/);
});

test("release docs disclose current Codex slash-command limitation", () => {
  const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const releaseVerification = readFileSync(path.join(REPO_ROOT, "docs/release-verification.md"), "utf8");

  const limitation = /Codex CLI 0\.125\.0 does not currently expose plugin `commands\/\*\.md` files as TUI slash commands/;
  assert.match(readme, limitation);
  assert.match(readme, /user-invocable skill fallback/);
  assert.match(changelog, limitation);
  assert.match(releaseVerification, /Root cause confirmed/);
  assert.match(releaseVerification, /find_builtin_command/);
});

test("release metadata documents v0.1.0 for both plugins", () => {
  const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const rootPackage = readJson("package.json");
  assert.equal(rootPackage.version, "0.1.0");
  for (const plugin of ["claude", "gemini"]) {
    const manifest = readJson(`plugins/${plugin}/.codex-plugin/plugin.json`);
    const workspacePackage = readJson(`plugins/${plugin}/package.json`);
    assert.equal(manifest.version, "0.1.0");
    assert.equal(workspacePackage.version, manifest.version);
  }

  assert.match(changelog, /## 0\.1\.0/);
  assert.match(changelog, /Features shipped/i);
  assert.match(changelog, /Known limitations/i);
  assert.match(changelog, /Upstream attribution/i);
  assert.match(changelog, /openai\/codex-plugin-cc/);
});
