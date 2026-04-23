// Guards against silent drift between the two plugins' copy-verbatim lib
// files. The 6 files listed below MUST be byte-identical between
// plugins/claude/scripts/lib/ and plugins/gemini/scripts/lib/.
// If this test fails after a legitimate upstream re-sync, update BOTH copies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const VERBATIM_FILES = [
  "workspace.mjs",
  "process.mjs",
  "args.mjs",
  "git.mjs",
  "job-control.mjs",
  "prompts.mjs",
];

for (const file of VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{claude,gemini}`, () => {
    const claude = readFileSync(
      path.join(REPO_ROOT, "plugins/claude/scripts/lib", file),
      "utf8"
    );
    const gemini = readFileSync(
      path.join(REPO_ROOT, "plugins/gemini/scripts/lib", file),
      "utf8"
    );
    assert.equal(claude, gemini, `${file} drift between claude and gemini`);
  });
}

test("render.mjs: no surviving Codex refs outside upstream attribution", () => {
  for (const plugin of ["claude", "gemini"]) {
    const text = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/render.mjs`),
      "utf8"
    );
    // Allow Codex refs inside lines that cite upstream (header comments).
    const offenders = text
      .split("\n")
      .filter((ln) => /\b[Cc]odex\b/.test(ln))
      .filter(
        (ln) =>
          !ln.includes("codex-plugin-cc") &&
          !ln.includes("codex-rs") &&
          !ln.includes("openai/codex") &&
          // Our port-header block explicitly documents the substitutions
          // ("Codex → Claude", "/codex:NAME → /<target>-NAME"). Those lines
          // are instructional, not actual display strings.
          !ln.includes("Codex → ") &&
          !ln.includes("/codex:NAME") &&
          !ln.includes("codex resume →") &&
          !ln.includes(".codex. →")
      );
    assert.equal(
      offenders.length,
      0,
      `${plugin} render.mjs still references Codex:\n${offenders.slice(0, 3).join("\n")}`
    );
  }
});
