// T7.7 C1 / B5 — command docs must reference fields that actually exist on
// the JobRecord (§21.3). Pre-T7.7, claude-review.md and claude-adversarial-review.md
// instructed callers to render `warning: "mutation_detected"` and
// `mutated_files`. Neither field exists in EXPECTED_KEYS — the real mutation
// signal is `mutations[]` (array of git-status line strings).
//
// Class-level invariant: no command doc should instruct rendering of a
// non-existent JobRecord field. We start with the two known offending
// tokens (tight regression); the test can be generalized later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = resolvePath(HERE, "..", "..", "plugins/claude/commands");

test("T7.7 B5: command docs do not reference removed `mutation_detected` warning or `mutated_files` field", () => {
  const offenders = [];
  const mdFiles = readdirSync(COMMANDS_DIR).filter((n) => n.endsWith(".md"));
  assert.ok(mdFiles.length > 0, "commands/ has at least one .md file");
  for (const name of mdFiles) {
    const text = readFileSync(resolvePath(COMMANDS_DIR, name), "utf8");
    // `warning: "mutation_detected"` — legacy rendering instruction.
    if (/mutation_detected/.test(text)) {
      offenders.push(`${name}: references "mutation_detected" (not a JobRecord field)`);
    }
    // `mutated_files` — legacy field name; the real array is `mutations`.
    if (/mutated_files/.test(text)) {
      offenders.push(`${name}: references "mutated_files" (real field is "mutations")`);
    }
  }
  assert.deepEqual(offenders, [],
    "command docs must render `mutations[]` (array of git-status lines), not the removed " +
    "`warning: \"mutation_detected\"` / `mutated_files` shape. Offenders:\n  " +
    offenders.join("\n  "));
});
