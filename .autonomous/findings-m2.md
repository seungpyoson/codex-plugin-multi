# M2 audit findings + disposition

Files audited during M2 gate (6 code files + configs/fixtures).

| File | First-run verdict | Notes |
|---|---|---|
| `plugins/claude/scripts/lib/claude.mjs` | PASS | Clean on first audit. |
| `plugins/claude/scripts/claude-companion.mjs` | FAIL → PASS | **Real HIGH + MEDIUM fixed** (see below). |
| `tests/smoke/claude-mock.mjs` | FAIL → PASS | Value-flag-at-end-of-argv fix applied. |
| `tests/unit/claude-dispatcher.test.mjs` | FAIL → PASS | Auditor model variance (qwen3.5 hallucinated "unknown models"); PASS with gpt-5.1-codex-mini. |
| `tests/smoke/claude-companion.smoke.test.mjs` | PASS | |
| `scripts/ci/run-tests.mjs` | PASS | |

## Real fixes applied

### HIGH — command injection in `tryGit`

`execSync` with the `cwd` argument interpolated into a shell string was
exploitable via `--cwd "$(whoami)"` or shell metacharacters. Rewrote to
`execFileSync("git", ["-C", cwd, ...args], {shell: false})` which bypasses
the shell entirely.

### MEDIUM — broken mutation detection

`gitStatusBefore.includes(afterLine)` was a substring check, not a line-set
check. A new modified file could be skipped if its status line happened to
appear as a substring anywhere in the before-snapshot. Fixed with a
`Set<trimmedLine>` membership test.

## False-positive auditor findings (DISPROVEN)

### `claude-dispatcher.test.mjs` — qwen3.5 "hallucinated Anthropic models"

The auditor flagged `claude-haiku-4-5-20251001`, `claude-opus-4-7`,
`claude-sonnet-4-6` as "hallucinated model identifiers [that] do not exist
in the public API."

**Disposition: DISPROVEN.** These are real model IDs, verified live in spec
§4.2 on 2026-04-23:

- `claude --version` reports `2.1.118`
- `claude -p "hi" --model claude-haiku-4-5-20251001 --output-format json`
  returned valid JSON with `modelUsage.claude-haiku-4-5-20251001` populated
- Same verification for `claude-sonnet-4-6` and `claude-opus-4-7`

The auditor's training cutoff predates these releases. Re-audit with
`gpt-5.1-codex-mini` (newer cutoff) returned PASS.

### `claude-dispatcher.test.mjs` — qwen3.5 "hallucinated project structure"

The auditor flagged `../../plugins/claude/scripts/lib/claude.mjs` import
paths as "likely hallucinated."

**Disposition: DISPROVEN.** Path exists in this repo at the cited location
(`git ls-files plugins/claude/scripts/lib/claude.mjs` returns the file).
The auditor has no repo context and extrapolated from typical AI-generated
code patterns. Re-audit with a model that inspects the actual filesystem
(gpt-5.1-codex-mini) returned PASS.

## Accepted low-severity findings

- `claude-companion.mjs`: `writeSidecar` may stringify `undefined` (guarded
  by `?? ""` in the function body — defense in depth).
- `claude-companion.mjs`: `e.message` may be undefined for non-Error throwables
  — rare in practice; acceptable.
- `claude-companion.mjs`: `--cwd` is user-controlled by design (user invokes
  the companion; they choose the target workspace).
- `claude-dispatcher.test.mjs`: `_internal` export is intentional for tests;
  this is a documented pattern.
- `claude-mock.mjs`: `parseCli` edge cases for values flags — addressed.
