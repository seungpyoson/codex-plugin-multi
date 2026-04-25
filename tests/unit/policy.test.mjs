import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = path.join(REPO_ROOT, "plugins/gemini/policies/read-only.toml");

function parseRules(text) {
  return text.split(/\[\[rule\]\]\n?/).slice(1).map((block) => {
    const rule = {};
    for (const line of block.split("\n")) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]+)"|(\d+))\s*$/.exec(line);
      if (m) rule[m[1]] = m[2] ?? Number(m[3]);
    }
    return rule;
  });
}

test("Gemini read-only policy denies write, replace, edit, and shell tools", () => {
  const rules = parseRules(readFileSync(POLICY, "utf8"));
  const byTool = new Map(rules.map((rule) => [rule.toolName, rule]));

  for (const toolName of ["write_file", "replace", "edit", "run_shell_command"]) {
    assert.ok(byTool.has(toolName), `missing deny rule for ${toolName}`);
    assert.equal(byTool.get(toolName).decision, "deny");
    assert.equal(byTool.get(toolName).priority, 100);
  }
});
