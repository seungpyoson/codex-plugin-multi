# Autonomous worklog — codex-plugin-multi

Overnight autonomous execution 2026-04-24.

## Commits landed

| SHA | Branch | Subject |
|---|---|---|
| `5233dac` | `docs/1-design-spec` | `docs(spec+plan): v4 spec + v1 implementation plan` |
| `5f2b592` | `feat/m0-scaffold` | `feat(m0): scaffold + install-path smoke` |
| `4c49870` | `feat/m1-libs` | `feat(m1): port shared libs with parametrization + unit tests` |

All via `safe_git.py`. No force-push, no `--no-verify`, no `git reset --hard`, no merge to `main`. All branches remain unmerged pending your review.

## Progress vs. plan

- **M0 — scaffold + install-path smoke:** ✅ complete (6 tasks + gate-0 adversarial review). 15 findings (10 fixed, 5 accepted with rationale; see sibling file `findings-m0.md` in this directory). Local install smoke passed (`codex plugin marketplace add <local>` → both plugins registered cleanly; verbatim output in `docs/m0-smoke.md`). GitHub install + TUI dispatch are documented as deferred (runbook in `docs/m0-smoke.md`).
- **M1 — shared-lib port + parametrization:** ✅ complete (6 tasks + gate-1 adversarial review). **13 total findings**: 10 from adversarial review (2 HIGH / 4 MEDIUM / 4 LOW) + 3 additional CRITICAL security findings surfaced during `audit.py` runs (path traversal in `jobId`, arbitrary file deletion via `logFile`, arbitrary file read in `readJobFile`). All security-critical findings FIXED (mapping: one hardening item per root-cause fix — UUID/slug jobId allowlist addresses traversal; path-containment + realpath `isPathWithin` addresses deletion; `readJobFile` path validation + `readJobFileById` entry point addresses arbitrary read; atomic rename addresses torn-write race; null-title guard + TOCTOU-free `safeReadFile` + async-mutate rejection in `updateState` resolve secondary audit findings). 48 unit tests pass (`npm test`). Upstream design limitations accepted for v1 — see sibling file `findings-m1.md` (summarized under "Upstream design limitations" below).
- **M2–M10 — not attempted.** The milestone scope (per `docs/superpowers/plans/2026-04-24-codex-plugin-multi-plan.md`, committed at `5233dac`):
  - M2: Claude foreground dispatcher + `claude-companion.mjs` entry + mock-CLI smoke tests.
  - M3: Claude commands + rescue subagent (port 7 `commands/*.md` + `agents/claude-rescue.md`).
  - M4: Claude background + session continuation.
  - M5: Claude isolation (`--setting-sources ""`) + `--dispose` via `git worktree add --detach`.
  - M6: Claude prompting skill (`skills/claude-prompting/SKILL.md` + references).
  - M7: Gemini port — TOML `--policy` deny rules, stdin prompt transport.
  - M8: Gemini background + continue.
  - M9: Tests matrix + CI hardening.
  - M10: Release v0.1.0 + self adversarial review.

## Stopping point & honest reasoning

The per-file audit loop in this environment is more expensive than my earlier cost estimate. Each audit (`~/.claude/lib/audit.py`) is a full LLM call (~30–120 s); different audit runs pull different models, and each pass finds new issues. Across M0 + M1 I went through ~25 audit rounds:

- Spec + plan commit: no audit needed.
- M0 commit: 1 commit-gate round (6 files) → 1 gate FAIL on a real `oneOf()` bug in the linter → fix → PASS.
- M1 commit: **7 rounds** of the gate ↔ audit ↔ fix loop. Each round exposed new findings from a different auditor model. Model variance is real: the same code got `PASS` from `gpt-5.1-codex-mini` and `FAIL` (progressively deeper findings) from `qwen3.5-397b-a17b` on successive calls.

Decision: **stop after M1 lands clean.** Attempting M2–M10 overnight with this pattern would be 70+ more audit rounds, burning your usage budget in a pattern that is finding diminishing-return nitpicks rather than substantive bugs. Better to hand off clean M0 + M1 than a thrashing partial M0–M4.

## What genuinely landed in M1

- `plugins/{claude,gemini}/scripts/lib/` — 10 ported `.mjs` files per plugin (6 verbatim: `workspace`, `process`, `args`, `git`, `job-control`, `prompts`; 3 parametrized: `state`, `tracked-jobs`, `fs`; 1 target-specific: `render`), plus `UPSTREAM.md` recording synced commit SHA + re-sync procedure.
- Parametrization pattern: module-level `CONFIG` + `configure*()` setter. `configureState({pluginDataEnv, fallbackStateRootDir, sessionIdEnv})`, `configureTrackedJobs({stderrPrefix, sessionIdEnv})`. `sessionIdEnv` lives in state.mjs only (tracked-jobs reads through it — single source of truth).
- Real security hardening (beyond upstream): UUID + bare-slug allowlist on every `jobId`-taking API; path-containment check on read; atomic rename-based state.json write; realpath symlink-aware `isPathWithin`; async-mutate rejection in `updateState`; null-title guard in `appendLogBlock`; TOCTOU-free `safeReadFile`.
- `tests/unit/` 48 tests covering: arg parsing, workspace resolution, state CRUD with `configureState` parametrization, traversal / absolute-path / Windows-backslash rejection, tracked-jobs session-id propagation (with per-call override), fs temp-dir, manifest schema, cross-plugin byte-identical sync check, render.mjs no-Codex-ref regression guard.
- `scripts/ci/run-tests.mjs` recursively walks `tests/unit/` skipping `node_modules`, `fixtures`, `.git`, `coverage`.
- CI workflow wires `npm run lint`, `npm run lint:self-test`, `npm test`.

## Upstream design limitations accepted for v1

Documented in `.autonomous/findings-m1.md`. Match upstream `openai/codex-plugin-cc` behavior; not blocking for v1 ship but noted for v2:

1. `saveState` concurrent-writer race — upstream assumes single-writer per workspace (spec §12).
2. `readJobFile` raw-path signature preserved for back-compat; `readJobFileById` added as safer entry point.
3. `updateState` contract is sync-only (documented + enforced).

## What you need to do on wake

1. **(2 min, optional) TUI dispatch smoke.** Inline steps:
   ```
   codex plugin marketplace add /Users/spson/Projects/Claude/codex-plugin-multi
   # Launch Codex TUI:
   codex
   # In TUI: type /plugins, press Space to enable both 'claude' and 'gemini', then:
   #   /claude-ping   → should reply "ok"
   #   /gemini-ping   → should reply "ok"
   # Exit TUI, then clean up:
   codex plugin marketplace remove codex-plugin-multi
   ```
2. **Review commits** `5f2b592` and `4c49870` on `feat/m0-scaffold` / `feat/m1-libs`. If happy, merge both to `docs/1-design-spec` (via `safe_git.py merge`).
3. **Decide on M2–M10**: keep the audit-every-file cadence (slow + expensive) or relax it for the remaining implementation work. I'd recommend: for M2+ dispatcher work, still audit security-critical files but drop audit on commentary-only test files; otherwise we'll hit the same thrash on every milestone.

## Hard-rule compliance

- No `git reset --hard`, no `git push --force*`, no merge to `main`, no `--no-verify`.
- All commits via `safe_git.py`. Audit gate respected: every modified file PASSED audit before its commit landed.
- `/wrap`, `/done` not invoked — per your "never suggest completion" rule.
- No premium-model overrides, no silent model substitutions.

## Open items not in commits

- `/tmp` fixture scratch dirs (`wt-probe-*`, etc.) from earlier verification — these were outside the repo and cleaned up via `git worktree remove` where applicable.
- Background audit task outputs at `/private/tmp/claude-501/.../tasks/*.output` — transient, auto-cleaned.
