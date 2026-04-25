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
  assert.equal(m.license, "Apache-2.0");
  assert.ok(m.interface.capabilities.every((c) => ["Interactive", "Read", "Write"].includes(c)));
});

test("gemini plugin.json: valid schema", () => {
  const m = readJson("plugins/gemini/.codex-plugin/plugin.json");
  assert.equal(m.name, "gemini");
  assert.ok(/^\d+\.\d+\.\d+/.test(m.version));
  assert.equal(m.license, "Apache-2.0");
});

test("both plugins declared in marketplace match filesystem layout", () => {
  const m = readJson(".agents/plugins/marketplace.json");
  for (const p of m.plugins) {
    const manifest = readJson(`plugins/${p.name}/.codex-plugin/plugin.json`);
    assert.equal(manifest.name, p.name, `${p.name} directory plugin.json name mismatch`);
  }
});

test("claude and gemini expose the full v0.1 command surface", () => {
  const commands = [
    "ping", "review", "adversarial-review", "rescue",
    "setup", "status", "result", "cancel",
  ];
  for (const plugin of ["claude", "gemini"]) {
    for (const command of commands) {
      const rel = `plugins/${plugin}/commands/${plugin}-${command}.md`;
      assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${rel} missing`);
    }
  }
});
