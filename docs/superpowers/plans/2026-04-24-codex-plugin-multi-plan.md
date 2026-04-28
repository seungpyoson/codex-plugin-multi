# codex-plugin-multi — Implementation Plan

- **Date:** 2026-04-24 (v1) / 2026-04-24 (v2 — invariants refactor inserted as M7)
- **Status:** Draft v2, post-M6 cross-model review
- **Tracks spec:** `docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md` (v5)
- **Branch:** `docs/006-spec-v5-invariants` (spec v5 + plan v2 land together)

## What changed in v2 (from v1)

After M6 a cross-model review surfaced a class of architectural gaps. Spec v5 §21 locks five new invariants. Plan v2 **inserts a new M7 — Invariants refactor** that brings the Claude path into compliance BEFORE the Gemini port starts. Gemini benefits directly (duplicates the corrected architecture, not the broken one); old M7–M10 shift to M8–M11. No task content changes in the shifted milestones beyond the renumber.

Sequence:

```
M0 … M6    (shipped)
M7  invariants refactor   ← NEW — makes §21.1–21.5 load-bearing in code
M8  Gemini port (was M7)
M9  Gemini background (was M8)
M10 Tests + CI (was M9)
M11 Release (was M10)
```

## Current branch state (2026-04-27)

This plan is the canonical roadmap. The spec preview in
`docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md` still uses the
old M7-M10 preview numbering; do not use that preview to choose the next task.

Current implementation state on `feat/012-t7-6-regression-matrix`:

- M7 Object-Pure/invariants refactor is complete.
- M8 Gemini foreground port is complete.
- M9 Gemini background + `continue --job` is complete through `fbf3937`.
- Gate-4 review disposition is recorded in `.autonomous/findings-gate-4.md`.
- T10.0 shared background lifecycle hardening is complete through `44e2f9b`.
- T10.1 coverage work is complete through `c122d6e`; the enforced 85% target
  gate passes with `COVERAGE_ENFORCE_TARGET=1 npm run test:coverage`.
- T10.2 smoke-test matrix is complete through `48787ac`; CI runs unit tests
  separately from per-target Claude/Gemini smoke jobs.
- T10.3 manual E2E runbook is complete through `f90bc20`; the opt-in harness is
  verified, while live maintainer execution remains an explicit manual step.
- T10.4 manifest + schema lint matrix is complete through `24c9b84`;
  `lint:self-test` covers malformed command, skill, and agent frontmatter.
- T10.5 README + install instructions is complete through `4303d63`; README
  now documents shipped install, first commands, command inventory, safety
  posture, and manual E2E pointers.
- T11.1 CHANGELOG + version bump is complete through `da616f6`; both plugin
  manifests are `0.1.0`, and `CHANGELOG.md` records shipped features, known
  limitations, and upstream attribution.
- T11.2 release-candidate review disposition is documented through `cc82850` in
  `docs/m10-review.md`; no blocker/high/medium findings remain open.
- T11.4 release-verification runbook is drafted as a preflight artifact in
  `docs/release-verification.md`; actual fresh-machine verification remains
  pending until after merge/install from the release source.
- Gemini `cancel` is intentionally not part of completed M9; treat it as an
  explicit lifecycle-parity slice if prioritized, not as hidden unfinished M9
  work.
- Next roadmap step is T11.3 merge to main, but this session is under an
  explicit no-PR/no-merge instruction. Do not perform it without renewed user
  approval.

Fresh-session rule: before changing code, read this section, `git log -8`, and
`docs/superpowers/plans/2026-04-26-m8-hardening-backlog.md`. Do not suggest PR,
release, or closeout while M10/M11 remain.

## How to use this plan

Each task is a single commit (or tight PR). A fresh session given **only this plan + the spec** should be able to pick up any task N and execute it without re-deriving decisions. Tasks are ordered by dependency. Spec section references use `§N` format.

**Per-task structure:**
- **Goal:** what done looks like.
- **Files:** what gets created/edited.
- **Acceptance:** observable, verifiable outcomes.
- **Spec ref:** link to spec section.
- **Depends on:** prerequisite task IDs.

**Adversarial-review gates** (⚠️) separate milestone clusters. Between gates, run `/codex:adversarial-review` against the branch; address findings before proceeding.

## Task DAG overview

```
M0 scaffold      → T0.1 → T0.2 → T0.3 → T0.4 → T0.5 → T0.6    (shipped)
                                                           ⚠️ gate-0
M1 shared-lib    → T1.1 → T1.2 → T1.3 → T1.4 → T1.5 → T1.6    (shipped)
                                                           ⚠️ gate-1
M2 claude fg     → T2.1 → T2.2 → T2.3 → T2.4 → T2.5           (shipped)
M3 claude cmds   → T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6    (shipped)
                                                           ⚠️ gate-2
M4 claude bg     → T4.1 → T4.2 → T4.3 → T4.4                  (shipped)
M5 claude iso    → T5.1 → T5.2 → T5.3 → T5.4                  (shipped)
M6 claude skill  → T6.1 → T6.2 → T6.3                         (shipped)
                                                           ⚠️ gate-3  (M6 cross-model review — spec v5 drafted here)
M7 invariants    → T8.1 → T8.2 → T8.3 → T8.4 → T8.5 → T8.6    (NEW)
                                                           ⚠️ gate-3.5  (invariants compliance re-audit)
M8 gemini port   → T9.1 → T9.2 → T9.3 → T9.4 → T9.5           (was M7)
M9 gemini bg     → T10.1 → T10.2 → T10.3                         (was M8)
                                                           ⚠️ gate-4
M10 tests + CI   → T11.1 → T11.2 → T11.3 → T11.4 → T11.5      (was M9)
M11 release      → T11.1 → T11.2 → T11.3 → T11.4              (was M10)
                                                           ⚠️ gate-5 (self-review)
```

---

## M0 — skeleton + install-path smoke

**Milestone goal:** install-path works end-to-end on a real machine before writing any runtime code.

### T0.1 — repo bootstrap

- **Goal:** Apache-2.0 licensed repo skeleton with NOTICE attribution to upstream MIT.
- **Files:**
  - `LICENSE` (Apache-2.0 text)
  - `NOTICE` (full MIT text of `openai/codex-plugin-cc` + attribution note: "This project ports portions of openai/codex-plugin-cc (MIT) to Apache-2.0 with modifications.")
  - `README.md` (overview, install instructions, safety disclosures per §10)
  - `package.json` with `{"workspaces": ["plugins/*"], "private": true, "engines": {"node": ">=20.0.0"}}`
  - `.gitignore` (node_modules, `.codex-plugin-*/jobs/`, `~/.cache/codex-plugin-*/`, OS cruft)
- **Acceptance:** `git ls-files` shows the 5 files. `npm install` succeeds (no dependencies yet).
- **Spec ref:** §6 root layout.
- **Depends on:** (none)

### T0.2 — top-level marketplace.json

- **Goal:** Codex-valid marketplace manifest registering both plugins.
- **Files:** `.agents/plugins/marketplace.json` per §4.13:
  ```json
  {
    "name": "codex-plugin-multi",
    "interface": {"displayName": "Codex ↔ Claude/Gemini"},
    "plugins": [
      {"name": "claude", "source": {"source": "local", "path": "./plugins/claude"},
       "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
       "category": "Coding"},
      {"name": "gemini", "source": {"source": "local", "path": "./plugins/gemini"},
       "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
       "category": "Coding"}
    ]
  }
  ```
- **Acceptance:** `codex plugin marketplace add <repo-cwd>` returns `Added marketplace 'codex-plugin-multi' from ...`. `~/.codex/config.toml` contains `[marketplaces.codex-plugin-multi]`. Remove cleanly via `codex plugin marketplace remove codex-plugin-multi`.
- **Spec ref:** §4.13.
- **Depends on:** T0.1

### T0.3 — plugin manifests

- **Goal:** minimal `.codex-plugin/plugin.json` per plugin.
- **Files:**
  - `plugins/claude/.codex-plugin/plugin.json`: `{"name":"claude","version":"0.0.1","description":"Delegate to Claude Code from Codex.","author":{"name":"seungpyoson"},"repository":"https://github.com/seungpyoson/codex-plugin-multi","license":"Apache-2.0"}`
  - `plugins/gemini/.codex-plugin/plugin.json`: analogous.
  - Stub `plugins/claude/LICENSE` and `plugins/gemini/LICENSE` (Apache-2.0 copies).
- **Acceptance:** Both manifests validate as JSON. Marketplace install from T0.2 now resolves individual plugins (visible in Codex TUI `/plugins`).
- **Spec ref:** §4.13, §6.
- **Depends on:** T0.2

### T0.4 — smoke-ping command (both plugins)

> Superseded 2026-04-27: Codex CLI 0.125.0 does not register plugin
> `commands/*.md` files in the TUI slash-command dispatcher. Diagnostic ping
> command docs are deferred until upstream command registration exists; the
> local fallback is user-invocable delegation skills. Follow-up: #13.

- **Goal:** one trivial command per plugin to prove the dispatch path.
- **Files:**
  - `plugins/claude/commands/claude-ping.md`:
    ```markdown
    ---
    description: Diagnostic ping for the Claude plugin. Prints "ok".
    ---
    Reply with exactly: ok
    ```
  - `plugins/gemini/commands/gemini-ping.md`: analogous.
- **Acceptance:** After enabling both plugins in Codex TUI, `/claude-ping` and `/gemini-ping` appear in autocomplete. Invoking them replies "ok". (Manual TUI test — document in a `docs/m0-smoke.md` with timestamp + screenshot path.)
- **Spec ref:** §4.13, §5.1.
- **Depends on:** T0.3

### T0.5 — live github install smoke

- **Goal:** verify github clone + install path works on our real repo.
- **Files:** (none; procedural)
- **Acceptance:**
  1. Push `docs/1-design-spec` with T0.1–T0.4 committed.
  2. On a clean `$CODEX_HOME=/tmp/codex-m0` (so real config stays clean), run `CODEX_HOME=/tmp/codex-m0 codex plugin marketplace add seungpyoson/codex-plugin-multi@docs/1-design-spec`.
  3. Expected output: `Added marketplace 'codex-plugin-multi' from https://github.com/seungpyoson/codex-plugin-multi.git`. Clone lands in `/tmp/codex-m0/.tmp/marketplaces/codex-plugin-multi`.
  4. Verify both plugins enumerable: `grep -A 2 "^\[marketplaces.codex-plugin-multi\]" /tmp/codex-m0/config.toml`.
  5. Record the exact command + output in `docs/m0-smoke.md`.
- **Spec ref:** §4.13, §20.
- **Depends on:** T0.4

### T0.6 — minimal CI lint

- **Goal:** prevent obviously-broken commits.
- **Files:**
  - `.github/workflows/pull-request-ci.yml`: node-20 setup, `npm ci`, `npm run lint` (json schema + basic file-presence checks).
  - `scripts/ci/check-manifests.mjs`: validates `.agents/plugins/marketplace.json` and both `.codex-plugin/plugin.json` against the schema described in §4.13.
  - `package.json`: add `"scripts": {"lint": "node scripts/ci/check-manifests.mjs"}`.
- **Acceptance:** CI passes on the branch. Introducing a malformed manifest (test locally) fails lint.
- **Spec ref:** §17.
- **Depends on:** T0.5

⚠️ **gate-0:** Run `/codex:adversarial-review` against the branch. Address findings before M1.

---

## M1 — shared library port + parametrization

**Milestone goal:** port the 10 upstream lib files, parametrize the 4 coupled ones, achieve unit-test coverage of core primitives.

### T1.1 — vendor upstream attribution + copy-verbatim libs

- **Goal:** six target-neutral lib files copied per plugin, with upstream attribution.
- **Files (per plugin, so twice — claude/ and gemini/):**
  - `plugins/<target>/scripts/lib/workspace.mjs` (verbatim from upstream `plugins/codex/scripts/lib/workspace.mjs`, with a `// Ported from openai/codex-plugin-cc (MIT). Apache-2.0 modifications.` header)
  - Same header for: `process.mjs`, `args.mjs`, `git.mjs`, `job-control.mjs`, `prompts.mjs`.
  - `plugins/<target>/scripts/lib/UPSTREAM.md`: records source commit SHA + which files are copy-verbatim vs parametrized.
- **Acceptance:** `diff` of each copy-verbatim file against the vendored upstream source is header-only (single comment block at top). `UPSTREAM.md` cites the SHA.
- **Spec ref:** §4.14, §6.2.
- **Depends on:** T0.6

### T1.2 — parametrize `state.mjs`

- **Goal:** expose target-name hook points.
- **Files:**
  - `plugins/<target>/scripts/lib/state.mjs`: upstream code with top-level constants replaced by `createState({ tmpdirPrefix, sessionIdEnv })` factory returning the existing API.
- **Acceptance:** Calling `createState({tmpdirPrefix: "claude-companion", sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID"})` produces a state API whose tmpdir prefix is `claude-companion` (observable via a unit test).
- **Spec ref:** §4.14 table, §6.2.
- **Depends on:** T1.1

### T1.3 — parametrize `tracked-jobs.mjs` and `fs.mjs`

- **Goal:** remove the two remaining hardcoded strings.
- **Files:**
  - `plugins/<target>/scripts/lib/tracked-jobs.mjs`: accept `{stderrPrefix}` at init.
  - `plugins/<target>/scripts/lib/fs.mjs`: `createTempDir(prefix?)` — default param driven by caller, not hardcoded `"codex-plugin-"`.
- **Acceptance:** Grep both files for `codex`/`Codex`/`CODEX` → zero matches.
- **Spec ref:** §4.14 table, §6.2.
- **Depends on:** T1.2

### T1.4 — per-plugin `render.mjs` (target-specific strings)

- **Goal:** duplicate render.mjs into two files with target-specific display strings.
- **Files:**
  - `plugins/claude/scripts/lib/render.mjs`: upstream render.mjs with every "Codex" → "Claude", "codex resume" → "claude --resume", section titles adjusted (e.g., `# Claude Setup`).
  - `plugins/gemini/scripts/lib/render.mjs`: same substitution for Gemini.
- **Acceptance:** Snapshot test: render a fixture `{status: "done", exit_code: 0, ...}` through both, verify Claude copy says "Claude" and Gemini copy says "Gemini".
- **Spec ref:** §4.14 table.
- **Depends on:** T1.3

### T1.5 — unit tests for primitives

- **Goal:** baseline coverage of pure logic.
- **Files:**
  - `tests/unit/workspace.test.mjs`: `resolveWorkspaceRoot` on git root, subdir, detached worktree, non-git cwd, symlink cwd.
  - `tests/unit/process.test.mjs`: spawn-argv safety (metachar prompt passed intact), stdin transport (for Gemini), timeout kill, SIGTERM→SIGKILL escalation.
  - `tests/unit/args.test.mjs`: parsing `--mode=X`, unknown-flag rejection, mutex enforcement (`--foreground` vs `--background`).
  - `tests/unit/jobs.test.mjs`: atomic `meta.json` write via `rename()`, PID-alive + cmdline-match check.
  - `package.json`: add `"test": "node --test tests/unit/**/*.test.mjs"`.
- **Acceptance:** `npm test` green; `.nyc` or c8 coverage reports >80 % on `lib/workspace.mjs`, `args.mjs`, `process.mjs`, `tracked-jobs.mjs`.
- **Spec ref:** §17.1.
- **Depends on:** T1.4

### T1.6 — manifest schema unit tests

- **Goal:** lock in the two manifest schemas so accidental regressions fail fast.
- **Files:**
  - `tests/unit/manifests.test.mjs`: JSON-schema validation for `.agents/plugins/marketplace.json` (required fields, `authentication` enum), and each `.codex-plugin/plugin.json`.
- **Acceptance:** `npm test` still green. Introducing `"authentication": "NEVER"` (test case) fails.
- **Spec ref:** §4.13.
- **Depends on:** T1.5

⚠️ **gate-1:** Adversarial review. Focus: lib parametrization correctness, upstream-drift risk.

---

## M2 — Claude foreground runtime (review mode)

**Milestone goal:** end-to-end review via mocked Claude CLI.

### T2.1 — `claude-mock.mjs` fixture CLI

- **Goal:** deterministic `claude -p` substitute for tests.
- **Files:**
  - `tests/smoke/claude-mock.mjs`: accepts the real Claude flag surface, routes on model + prompt hash to fixture JSON responses (`tests/smoke/fixtures/claude/<sha>.json`).
  - `tests/smoke/fixtures/claude/README.md`: how to regenerate fixtures from a real run.
- **Acceptance:** `PATH=tests/smoke:$PATH tests/smoke/claude-mock.mjs -p "hello" --output-format json --model claude-haiku-4-5-20251001` returns a valid fixture. Unknown prompt → exit 1 with a readable "no fixture" error.
- **Spec ref:** §17.2.
- **Depends on:** T1.6

### T2.2 — `lib/claude.mjs` (dispatcher)

- **Goal:** the Claude-specific process invocation layer.
- **Files:**
  - `plugins/claude/scripts/lib/claude.mjs`: exports `spawnClaude({mode, model, promptText, cwd, sessionId, isolated, schema})` returning `{stdout, stderr, exitCode, parsed}`. Uses flag stack per spec §7.2: `--setting-sources ""`, `--permission-mode plan`/`acceptEdits`, `--disallowedTools`, `--session-id`, `--no-session-persistence`, `--output-format json`, optional `--json-schema`, optional `--add-dir`.
  - Parses `result` or `structured_output` (when schema given) per §4.8.
- **Acceptance:** Unit tests (`tests/unit/claude-dispatcher.test.mjs`) with `claude-mock.mjs` on PATH verify: (a) review mode passes `--disallowedTools`, (b) rescue mode passes `--permission-mode acceptEdits`, (c) `--json-schema` invocation reads `structured_output`, (d) model denials in `permission_denials[]` are surfaced.
- **Spec ref:** §7.2, §4.8.
- **Depends on:** T2.1

### T2.3 — `claude-companion.mjs` entry + `run --mode=review --foreground`

- **Goal:** the top-level CLI entry, supporting the review subcommand foreground.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs`: arg parsing via `lib/args.mjs`; plugin-root resolution via `path.resolve(fileURLToPath(new URL("..", import.meta.url)))`; dispatches to `lib/claude.mjs`. Only `run` subcommand implemented at this task.
- **Acceptance:** `node plugins/claude/scripts/claude-companion.mjs run --mode=review --foreground --model claude-haiku-4-5-20251001 -- "review this snippet: x=1"` (with `PATH` prepended for mock) returns a JSON object with `{job_id, workspace_root, result, ...}`. Exit 0 on success; non-zero on CLI spawn failure.
- **Spec ref:** §7.1, §7.2.
- **Depends on:** T2.2

### T2.4 — job-store write path

- **Goal:** review run persists `meta.json` + `stdout.log` under `<workspace>/.codex-plugin-claude/jobs/<uuid>/`.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): integrate `lib/tracked-jobs.mjs`, write `meta.json` with fields per §12.
- **Acceptance:** After `run --mode=review --foreground`, `<cwd>/.codex-plugin-claude/jobs/<uuid>/meta.json` exists with `status: "done"`, `exit_code: 0`, `session_id`, `target: "claude"`, `mode: "review"`. UUID matches the one passed to `--session-id`.
- **Spec ref:** §12.
- **Depends on:** T2.3

### T2.5 — pre/post `git status` capture (review only)

- **Goal:** detect mutations during supposedly read-only review.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): in review mode, snapshot `git status -s --untracked-files=all` before, run, snapshot after, write both to job dir. If non-empty diff, emit `{"warning": "mutation_detected", "files": [...]}` in result.
- **Acceptance:** Smoke test: review run in a dirty cwd reports `mutation_detected` with the correct file list. Clean cwd run reports no warning. Log files present in job dir.
- **Spec ref:** §10 post-hoc detection.
- **Depends on:** T2.4

---

## M3 — Claude commands + rescue subagent

**Milestone goal:** user-facing slash commands work end-to-end (foreground paths + status/result/cancel + setup + rescue subagent).

### T3.1 — port `commands/review.md`, `commands/adversarial-review.md`, `commands/setup.md`

- **Goal:** three user-facing commands wired to the companion.
- **Files:**
  - `plugins/claude/commands/claude-review.md`: concise body per spec §13 template, invokes `node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --isolated --dispose -- "$ARGUMENTS"`.
  - `plugins/claude/commands/claude-adversarial-review.md`: mode `adversarial-review`.
  - `plugins/claude/commands/claude-setup.md`: invokes `ping`, `doctor`, prints results.
  - Frontmatter: `description` + `argument-hint`. No `allowed-tools` (advisory only, per §4.13).
- **Acceptance:** Manual TUI invocation of `/claude-review` passes an args string to companion and renders output. `docs/m3-smoke.md` records timestamp + captured session jsonl path.
- **Spec ref:** §13, §16.1.
- **Depends on:** T2.5

### T3.2 — `ping` subcommand + `/claude-setup` wiring

- **Goal:** OAuth health probe per §7.5.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): `ping` subcommand runs cheap-tier model with 15 s timeout, returns `{status: "ok"|"not_authed"|"not_found"|"rate_limited"|"error", detail}`.
  - `plugins/claude/config/models.json`: `{"cheap":"claude-haiku-4-5-20251001","medium":"claude-sonnet-4-6","default":"claude-opus-4-7"}`.
  - `plugins/claude/config/min-versions.json`: `{"claude":"2.1.118"}`.
- **Acceptance:** `ping` returns `status: "ok"` with the mock; fake `ENOENT` (PATH manipulation) returns `status: "not_found"`.
- **Spec ref:** §7.5, §15.
- **Depends on:** T3.1

### T3.3 — `status`, `result`, `cancel` subcommands

- **Goal:** job-management surface per §13.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): subcommands read `meta.json`, list/filter jobs, send SIGTERM/SIGKILL for cancel (with PID liveness + cmdline match per §12).
  - `plugins/claude/commands/claude-status.md`, `commands/claude-result.md`, `commands/claude-cancel.md`.
- **Acceptance:** After a foreground review, `claude-companion status` shows the job as `done`. `result --job <id>` prints the stdout log. `cancel --job <id>` on a completed job returns `already_terminal`.
- **Spec ref:** §13, §16.2.
- **Depends on:** T3.2

### T3.4 — `agents/claude-rescue.md` subagent

- **Goal:** rescue long-running invocation via subagent (for later background use, scaffolded now).
- **Files:**
  - `plugins/claude/agents/claude-rescue.md` with frontmatter per §14: `name`, `description`, `model: inherit`, `tools: Bash`, `skills: [claude-cli-runtime, claude-result-handling, claude-prompting]`. Body mirrors upstream `codex-rescue.md` (selection guidance, forwarding rules, response style) — substitute "Codex" → "Claude".
- **Acceptance:** YAML frontmatter parses. Codex TUI lists the subagent under the plugin. No runtime test yet (wired in M4).
- **Spec ref:** §14.
- **Depends on:** T3.3

### T3.5 — `commands/claude-rescue.md` + stub skills

- **Goal:** user command that delegates to the subagent.
- **Files:**
  - `plugins/claude/commands/claude-rescue.md`: concise body that activates the `claude-rescue` subagent with `$ARGUMENTS`.
  - `plugins/claude/skills/claude-cli-runtime/SKILL.md`: `user-invocable: false`; body contains the verbatim invocation snippet for the companion (Claude-argv form per §16.1).
  - `plugins/claude/skills/claude-result-handling/SKILL.md`: `user-invocable: false`; body describes rendering conventions.
- **Acceptance:** Manual TUI invocation of `/claude-rescue foo` activates the subagent (visible in session jsonl as a subagent turn).
- **Spec ref:** §5.2, §14, §16.1.
- **Depends on:** T3.4

### T3.6 — smoke-tests for foreground path

- **Goal:** 3 smoke tests per command using `claude-mock.mjs`.
- **Files:**
  - `tests/smoke/claude-companion.smoke.test.mjs`: covers review, adversarial-review, setup, status, result, cancel (7 scenarios). Uses mock CLI; asserts exit codes, JSON shape, meta.json contents.
- **Acceptance:** `npm run smoke:claude` green. All 7 scenarios pass.
- **Spec ref:** §17.2.
- **Depends on:** T3.5

⚠️ **gate-2:** Adversarial review. Focus: security of review-mode flag stack (`--setting-sources ""`, `--disallowedTools` completeness), `$ARGUMENTS` handling, subagent tool restrictions.

---

## M4 — Claude background + continue

**Milestone goal:** rescue works as detached long-running job.

### T4.1 — `run --background` with detached wrapper

- **Goal:** fork-exec target CLI detached, stdio to files, parent returns `{event, job_id, pid}` + exits.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): `--background` branch uses `child_process.spawn` with `detached: true, stdio: ['ignore', fs.openSync(stdoutLog, 'a'), fs.openSync(stderrLog, 'a')]`; `child.unref()`.
- **Acceptance:** `run --mode=rescue --background -- "fix bug X"` returns within 500 ms with `{event: "launched", job_id, pid}`. Parent exits 0; child continues running.
- **Spec ref:** §7.4.
- **Depends on:** T3.6

### T4.2 — terminal-state meta writer

- **Goal:** detached wrapper writes final `meta.json` on child exit.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): the child spawn uses a small wrapper script (inline via `node -e` or a sibling `lib/detached-wrapper.mjs`) that `waitpid`s the real CLI and writes `status: "done"|"failed"`, `exit_code`, `ended_at`.
- **Acceptance:** After `run --background`, poll for `status != "running"` within 60 s. Final meta has `exit_code` integer, `ended_at` ISO timestamp.
- **Spec ref:** §7.4.
- **Depends on:** T4.1

### T4.3 — `continue --job <id>` with `--resume <uuid>`

- **Goal:** resume a completed rescue by session UUID.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): `continue` reads `meta.json.session_id`, spawns `claude --resume <uuid> -p <new-prompt> ...`. If `session_id` missing/empty, exits with `SESSION_UNAVAILABLE`.
- **Acceptance:** After a rescue completes, `continue --job <id> -- "follow-up question"` starts a new child, session persists (verified via fixture-matching in mock).
- **Spec ref:** §11.
- **Depends on:** T4.2

### T4.4 — background smoke tests

- **Goal:** regression coverage.
- **Files:**
  - `tests/smoke/claude-companion.smoke.test.mjs` (extend): background launch returns `launched` event, terminal meta appears within timeout, `continue` resumes session.
- **Acceptance:** smoke green. Running the test 10× has zero flakes.
- **Spec ref:** §17.2.
- **Depends on:** T4.3

---

## M5 — Claude isolation + dispose

**Milestone goal:** `--isolated` strips CLAUDE.md; `--dispose` routes mutations to a throwaway tree.

### T5.1 — `--isolated` flag (adds `--setting-sources ""` + neutral cwd)

- **Goal:** review paths run context-free.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): when `--isolated`, set child cwd = `/tmp` (or `os.tmpdir()`), add `--setting-sources ""`, add `--add-dir <original-cwd>` only for explicit file references.
- **Acceptance:** Live E2E (gated behind `npm run e2e:claude`): isolated review cannot reference the current project's CLAUDE.md content; non-isolated can.
- **Spec ref:** §9, §10.
- **Depends on:** T4.4

### T5.2 — `--dispose` via git worktree

- **Goal:** review runs against detached worktree; main tree stays clean.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): `--dispose` default-ON for review/adversarial-review. If cwd in git: `git worktree add --detach <cache>/<job-id>`. Else: `cp -a cwd <cache>/<job-id>`. Child cwd = disposable path. On job terminal: `git worktree remove <path>` or `rm -rf <path>` (gate guarded). Record path in `meta.json.dispose_path`.
- **Acceptance:** After a review with `--dispose`: disposable path exists during run, removed after. Main tree `git status` returns empty (verified in test).
- **Spec ref:** §10, verified §4 (worktree isolation test 2026-04-24).
- **Depends on:** T5.1

### T5.3 — pre/post git-status integration for dispose path

- **Goal:** capture mutations inside the disposable tree (for user awareness).
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs` (extend): run pre/post snapshot against `dispose_path` not `cwd`. Render both in result with a clear note that mutations were contained.
- **Acceptance:** A rescue-with-writes test under `--dispose` shows mutations in `git-status-after.txt` but main tree unchanged.
- **Spec ref:** §10.
- **Depends on:** T5.2

### T5.4 — smoke + E2E for isolation

- **Goal:** both isolation layers regression-tested.
- **Files:**
  - `tests/smoke/claude-isolation.smoke.test.mjs`: mock CLI asserts child received `--setting-sources ""` for isolated runs and correct cwd.
  - `tests/e2e/claude-isolation.e2e.test.mjs`: real-CLI live test, skipped in CI, recorded in `docs/m5-e2e.md`.
- **Acceptance:** smoke green. E2E documented with run timestamp.
- **Spec ref:** §17.
- **Depends on:** T5.3

---

## M6 — Claude prompting skill

**Milestone goal:** `claude-prompting` skill documents the canonical prompting guidance, retrievable by commands.

### T6.1 — `SKILL.md` + references

- **Files:**
  - `plugins/claude/skills/claude-prompting/SKILL.md`: frontmatter `name`, `description`, `user-invocable: false`. Body covers model-tier rationale, aliases-are-unreliable rule, session-UUID pattern, `-c` forbidden, extended-thinking notes.
  - `plugins/claude/skills/claude-prompting/references/claude-prompt-antipatterns.md`: common mistakes (e.g., trusting plan-mode, alias substitution).
  - `plugins/claude/skills/claude-prompting/references/claude-prompt-blocks.md`: reusable prompt blocks per mode.
- **Acceptance:** Skill is loadable by Codex (no load error in TUI). Command bodies cross-reference by name (e.g., `/claude-review` body says "retrieve the `claude-prompting` skill for tier selection").
- **Spec ref:** §5.2, §16.4.
- **Depends on:** T5.4

### T6.2 — wire skill retrieval from commands

- **Goal:** command bodies explicitly mention the skill so Codex's model retrieves it.
- **Files:**
  - Edit `plugins/claude/commands/claude-review.md`, `claude-adversarial-review.md`, `claude-rescue.md`: add "Before invoking, consult the `claude-prompting` skill for model-tier selection."
- **Acceptance:** Manual TUI invocation shows skill activation in session jsonl (`"type":"skill_activated","name":"claude-prompting"`).
- **Spec ref:** §5.2.
- **Depends on:** T6.1

### T6.3 — skill content validation

- **Files:**
  - `tests/unit/skills.test.mjs`: each SKILL.md has required frontmatter fields; `user-invocable: false` set on all three internal skills.
- **Acceptance:** `npm test` green. Adding a malformed SKILL.md (test) fails.
- **Spec ref:** §5.2.
- **Depends on:** T6.2

⚠️ **gate-3:** M6 cross-model review ran here (Codex + Gemini + Claude). Output drove spec v5 §21 — four architectural gaps + one operational gap. **DO NOT start M8 (Gemini port) before M7 lands.** Gemini's dispatcher will byte-copy from Claude's; porting before the refactor duplicates the defects.

---

## M7 — Architectural invariants refactor (v5 §21)

**Goal:** bring the Claude path into compliance with spec v5 §21.1–21.5 before the Gemini port forks the code. Every merge-blocker from the M6 review is addressed as a structural change, not a patch — the type/contract makes the mistake unrepresentable rather than checked.

**Scope:** `plugins/claude/` only. Gemini plugin stubs are untouched; M8 will duplicate the refactored shape.

**Guiding principle:** each task lands one invariant completely. Partial compliance on one invariant is worse than zero compliance — it gives a false sense of coverage.

### T7.1 — `ModeProfile` table (§21.2)

- **Goal:** every mode-correlated flag (model tier, strip_context, permission_mode, disallowed_tools, containment, scope, dispose_default, add_dir, schema_allowed) lives in exactly one place; `buildClaudeArgs` / `spawnClaude` take a profile, not individual knobs-with-defaults.
- **Files:**
  - new `plugins/claude/scripts/lib/mode-profiles.mjs` — exports `MODE_PROFILES` constant + `resolveProfile(name)` helper.
  - edit `plugins/claude/scripts/lib/claude.mjs` — signature of `buildClaudeArgs(profile, runtimeInputs)` and `spawnClaude(profile, runtimeInputs)`. Delete `stripContext` / `model-tier` defaults.
  - edit `plugins/claude/scripts/claude-companion.mjs` — `cmdRun` resolves mode → profile exactly once at entry.
- **Acceptance:**
  - Spec's §21.2 table is the object literal in `mode-profiles.mjs` — verbatim copy, no drift.
  - `grep "stripContext\s*=\s*true" lib/claude.mjs` returns nothing.
  - `grep 'mode === "rescue" ? "default" : "default"' claude-companion.mjs` returns nothing.
  - New unit test `tests/unit/mode-profiles.test.mjs`: for each mode, `buildClaudeArgs(resolveProfile(name), {…})` produces exactly the flag stack documented in spec §4.5/§9.
  - All 82 existing tests pass unchanged (semantic equivalence for the already-correct modes).
- **Spec ref:** §21.2, §4.5, §4.6, §8, §9, §10.
- **Depends on:** M6 (shipped).

### T7.2 — Containment + scope split (§21.4)

- **Goal:** `--isolated` is retired. `containment` and `scope` become independent per-profile fields; `review` default becomes `{worktree, working-tree}` so dirty-tree review is the default.
- **Files:**
  - new `plugins/claude/scripts/lib/containment.mjs` — `setupContainment(profile, cwd)` returns `{path, cleanup}`, internally dispatches on `profile.containment`.
  - new `plugins/claude/scripts/lib/scope.mjs` — `populateScope(profile, sourceCwd, targetPath)` populates according to `profile.scope`. Implements: `working-tree` (checkout-index -a + copy untracked), `staged`, `branch-diff`, `head`, `custom`. Pure functions; no spawn from caller.
  - edit `plugins/claude/scripts/claude-companion.mjs` — `executeRun` calls `setupContainment` then `populateScope` then `spawnClaude`; removes `setupWorktree` / `--isolated` / `--no-dispose` legacy handling.
  - edit `plugins/claude/commands/claude-review.md` etc. — drop `--isolated --dispose` from invocation snippets; the profile carries these.
- **Acceptance:**
  - New smoke test: `/claude-review` against a git repo with uncommitted changes sees those changes in Claude's `--add-dir` path.
  - New smoke test: `/claude-adversarial-review` sees only `branch-diff` scope (verified by populating the path then `find`-ing only those files).
  - Rescue mode runs directly in `cwd` with no worktree (verified by mock that checks `process.cwd()` equals sourceCwd).
  - The word "isolated" does not appear as a flag in any command file or argparse definition.
- **Spec ref:** §21.4, §9, §10.
- **Depends on:** T7.1.

### T7.3 — Identity types distinct (§21.1)

- **Goal:** `job_id`, `claude_session_id`, `resume_chain`, `pid_info` are four separate concepts in code and on disk. `randomUUID()` is only used for `job_id`; `claude_session_id` is read from `parsed.session_id` after execution; `pid_info = {pid, starttime, argv0}` is captured at spawn.
- **Files:**
  - new `plugins/claude/scripts/lib/identity.mjs` — `newJobId()`, `capturePidInfo(pid)`, `verifyPidInfo(saved)` (re-reads starttime, compares). Linux: `/proc/<pid>/stat`. Darwin: `ps -o lstart= -p <pid>`.
  - edit `plugins/claude/scripts/lib/claude.mjs` — `spawnClaude` returns `{claude_session_id, pid_info, …}` alongside parsed result.
  - edit `plugins/claude/scripts/claude-companion.mjs` — `cmdRun` generates `job_id` with `newJobId()`, passes `--session-id` = `job_id` on first run (by convention), records `claude_session_id` from stdout; `cmdContinue` reads prior `claude_session_id` and pushes to `resume_chain`.
  - edit `cmdCancel` — calls `verifyPidInfo(saved)`; mismatch → `stale_pid` error with no signal sent.
- **Acceptance:**
  - Unit test: `cmdContinue` twice on the same chain resumes the most recent session, not a dead intermediate ID.
  - Smoke test: `cmdCancel` refuses with `stale_pid` when `pid_info.argv0` no longer matches (simulated by manually writing a crafted meta).
  - No field named `session_id` that aliases `job_id` anywhere in persisted records.
- **Spec ref:** §21.1.
- **Depends on:** T7.1.

### T7.4 — `JobRecord` shape (§21.3)

- **Goal:** one schema, one builder, one consumer. Foreground `cmdRun` and `cmdResult` both read the persisted record; neither hand-assembles a blob.
- **Files:**
  - new `plugins/claude/scripts/lib/job-record.mjs` — exports `buildJobRecord(invocation, execution, mutations)` returning the exact shape from §21.3. Schema-version-tagged.
  - edit `plugins/claude/scripts/claude-companion.mjs` — `executeRun` calls `buildJobRecord(…)` and persists it; foreground `cmdRun` reads it back from disk and prints; `cmdResult` reads and prints.
  - edit `plugins/claude/skills/claude-result-handling/SKILL.md` — rewrite "Success path" to describe the `JobRecord` fields directly, in the same order as the schema.
- **Acceptance:**
  - `prompt` field does not exist on any persisted record; only `prompt_head`.
  - Background result path: `cmdResult` returns non-null `result` / `structured_output` / `permission_denials` fields populated from Claude's stdout (prior gap was that these fields were missing from the terminal meta).
  - Foreground stdout and `cmdResult` stdout are byte-identical for the same job.
  - `tests/unit/job-record.test.mjs`: contract test that the schema keys match the skill's documented fields 1:1.
- **Spec ref:** §21.3.
- **Depends on:** T7.3.

### T7.5 — Shared-lib importability + dead-code deletion (§21.5)

- **Goal:** every `plugins/*/scripts/lib/*.mjs` imports cleanly and has a live consumer. `job-control.mjs` + `render.mjs` are either wired or deleted.
- **Files:**
  - new `tests/unit/lib-imports.test.mjs` — iterates `plugins/claude/scripts/lib/*.mjs` + `plugins/gemini/scripts/lib/*.mjs`, `await import()`s each, asserts every declared export is defined.
  - edit `plugins/claude/scripts/lib/UPSTREAM.md` — remove entries for deleted files.
  - if unused: delete `plugins/{claude,gemini}/scripts/lib/job-control.mjs` and `render.mjs` + their byte-identity test entries.
  - if used: fix their broken imports (stale `./codex.mjs`, missing `SESSION_ID_ENV`).
- **Acceptance:**
  - `tests/unit/lib-imports.test.mjs` passes on both plugins.
  - No `.mjs` file in `lib/` has zero importers (checked by grep: every file appears as an `import … from "./<name>.mjs"` somewhere in the plugin).
  - `plugin-copies-in-sync.test.mjs` is updated to match the new lib list.
- **Spec ref:** §21.5.
- **Depends on:** T7.1 (so deletions happen after the new modules are in).

### T7.6 — Regression + review-coverage tests

- **Goal:** the eight cross-model-review findings each have a regression test. Failing-then-passing is documented.
- **Files:**
  - `tests/smoke/invariants.test.mjs` with one test per finding:
    - default-model-ternary: `cmdRun --mode=review` without `--model` resolves to `cheap` tier (haiku), not `default` (opus).
    - rescue strip-context: `cmdRun --mode=rescue` omits `--setting-sources ""` from argv.
    - continue cwd drift: `cmdContinue` inherits `prior.cwd` when caller omits `--cwd`.
    - continue session chain: second `cmdContinue` off a continued job resolves to the last real claude_session_id, not the companion's minted UUID.
    - cancel PID ownership: fabricated `pid_info` (wrong starttime) → `stale_pid` error, no kill.
    - background result populated: `/claude-result <id>` after background job returns `result` field populated.
    - review sees dirty tree: write uncommitted change, run review, assert Claude's `--add-dir` path contains the dirty file.
    - dead-lib import: importing `lib/job-control.mjs` (if still present) succeeds.
  - Mock CLI (`claude-mock.mjs`) gets two new trigger flags: `--mock-delay <ms>` for timeout tests, `--mock-mutate <path>` for mutation-detection tests (both MEDIUM-severity gaps flagged by the review).
- **Acceptance:** `npm test` green with invariants.test.mjs active. Each test name maps 1:1 to one finding in the M6 review.
- **Spec ref:** §21 (all).
- **Depends on:** T7.1, T7.2, T7.3, T7.4, T7.5.

⚠️ **gate-3.5:** After T7.6, rerun the M6 cross-model review against the M7 branch. All eight merge-blocker findings must be resolved. If any survive, the relevant invariant is incomplete — fix the spec or fix the code until it complies.

---

## M8 — Gemini port (policy-first)

**Milestone goal:** symmetric Gemini plugin with TOML policy as the real enforcement.

### T8.1 — `gemini-mock.mjs` fixture CLI

- **Files:**
  - `tests/smoke/gemini-mock.mjs`: mirrors the `claude-mock.mjs` contract. Additionally validates `--policy <file>` path exists and the TOML parses; if any `[[rule]] decision = "deny"` matches a fixture's intended tool call, mock emits `Tool "X" not found` error text (matches real Gemini behavior observed §4.5).
  - `tests/smoke/fixtures/gemini/`: JSON fixtures.
- **Acceptance:** Mock accepts `-p '' + stdin` transport; policy-file presence triggers deny path.
- **Spec ref:** §17.2, §4.5.
- **Depends on:** T6.3

### T8.2 — `policies/read-only.toml`

- **Files:**
  - `plugins/gemini/policies/read-only.toml`: deny rules for `write_file`, `replace`, `edit`, `run_shell_command` (verbatim from spec §7.3).
  - `tests/unit/policy.test.mjs`: TOML parses; each rule has `toolName`, `decision`, `priority`.
- **Acceptance:** Unit test green. File is loaded by `gemini-mock.mjs` in T8.1 without errors.
- **Spec ref:** §7.3, verified §4.5.
- **Depends on:** T8.1

### T8.3 — `lib/gemini.mjs` + `gemini-companion.mjs` entry

- **Files:**
  - `plugins/gemini/scripts/lib/gemini.mjs`: exports `spawnGemini({mode, model, promptText, cwd, isolated, resume})`. Uses stdin transport, `-p ''`, `--policy <plugin-root>/policies/read-only.toml` for review/adversarial paths, `--approval-mode plan`, `-s`, `--output-format json`, optional `--include-directories`, optional `--resume`.
  - `plugins/gemini/scripts/gemini-companion.mjs`: same subcommand surface as claude-companion.mjs. All seven subcommands (`run`, `continue`, `status`, `result`, `cancel`, `ping`, `doctor`) scaffolded.
  - Model config: `plugins/gemini/config/models.json` per §8, `config/min-versions.json`.
- **Acceptance:** Unit test: review-mode invocation passes `--policy` pointing at the bundled TOML; rescue-mode does NOT pass `--policy` but passes `--approval-mode auto_edit`. Mock captures these flags and asserts.
- **Spec ref:** §7.3, §8.
- **Depends on:** T8.2

### T8.4 — Gemini commands

- **Files:**
  - `plugins/gemini/commands/gemini-review.md`, `gemini-adversarial-review.md`, `gemini-rescue.md`, `gemini-setup.md`, `gemini-status.md`, `gemini-result.md`, `gemini-cancel.md`. Symmetric to Claude counterparts, with stdin invocation line per §16.1.
  - `plugins/gemini/agents/gemini-rescue.md`: subagent, analogous to claude-rescue.md.
- **Acceptance:** All seven commands invoke the companion with correct mode and transport. TUI smoke recorded in `docs/m7-smoke.md`.
- **Spec ref:** §13, §14, §16.1.
- **Depends on:** T8.3

### T8.5 — Gemini smoke tests (foreground)

- **Files:**
  - `tests/smoke/gemini-companion.smoke.test.mjs`: 7 scenarios mirroring claude. Review scenario explicitly asserts `--policy` flag present.
- **Acceptance:** `npm run smoke:gemini` green.
- **Spec ref:** §17.2.
- **Depends on:** T8.4

---

## M9 — Gemini background + continue

**Milestone goal:** Gemini rescue works detached with session continuation.

**Runtime alignment:** As of `3bf78d4`, Gemini `run --background` plus foreground/background `continue --job` are implemented. Gemini `cancel` remains deferred.

### T9.1 — Gemini `run --background` + detached wrapper

- **Files:**
  - `plugins/gemini/scripts/gemini-companion.mjs` (extend): same lifecycle as Claude (§7.4). Gemini-specific: capture server-minted session UUID from result JSON into `gemini_session_id`.
- **Acceptance:** Background rescue returns `launched` event, terminal meta appears with valid `gemini_session_id` captured.
- **Spec ref:** §7.4, §11.
- **Depends on:** T8.5

### T9.2 — `continue --job <id>` with captured UUID

- **Files:**
  - `plugins/gemini/scripts/gemini-companion.mjs` (extend): `continue` reads the prior JobRecord's `gemini_session_id`, appends it to `resume_chain`, and passes the newest chain entry as `--resume <uuid>`. Never use ordinal indexes.
- **Acceptance:** After rescue, `continue` resumes the prior session in fixture-based foreground and background tests. Missing `gemini_session_id` fails closed.
- **Spec ref:** §11, §4.4.
- **Depends on:** T9.1

### T9.3 — Gemini background smoke

- **Files:**
  - `tests/smoke/gemini-companion.smoke.test.mjs` (extend): background + continue scenarios; 10× flake run.
- **Acceptance:** Smoke green, zero flakes.
- **Spec ref:** §17.2.
- **Depends on:** T9.2

⚠️ **gate-4:** Adversarial review. Focus: Gemini policy-file enforcement (is the deny list complete?), subagent fallback paths, session-UUID capture edge cases.

---

## M10 — Tests + CI

**Milestone goal:** comprehensive test surface; CI blocks regressions.

### T10.0 — shared background lifecycle hardening triage

- **Goal:** Resolve cross-target lifecycle findings before final CI hardening.
  This is where shared launcher reliability issues belong, not inside Gemini M9
  unless the defect is Gemini-only.
- **Files:**
  - `plugins/claude/scripts/claude-companion.mjs`
  - `plugins/gemini/scripts/gemini-companion.mjs`
  - shared smoke/unit tests as needed
  - `docs/superpowers/plans/2026-04-26-m8-hardening-backlog.md`
- **Acceptance:** Each open shared lifecycle finding is either fixed for both
  targets with tests, or explicitly documented as not applicable with evidence.
  In particular, revisit detached worker `child.on("error")` handling only if
  the launcher can fail after a queued JobRecord/prompt sidecar is created but
  before the worker is running. A proper fix must define the JobRecord contract,
  prompt-sidecar cleanup, and whether users see a launched event.
- **Spec ref:** §7.4, §21.3.2.
- **Depends on:** T9.3 and gate-4.

### T10.1 — unit-test coverage floor

- **Files:**
  - Extend existing unit tests to hit >85 % branch coverage on all `lib/*.mjs` files (both plugins).
  - `scripts/ci/check-coverage.mjs`: parses raw V8 coverage output, fails CI below threshold.
- **Acceptance:** `npm run test:coverage` reports >85 %. CI fails on regression.
- **Progress note (2026-04-27):** `npm run test:coverage` now exists as a
  dependency-free V8 coverage gate because `c8` is not available in the
  sandbox. `COVERAGE_ENFORCE_TARGET=1 npm run test:coverage` passes as of
  `c122d6e`.
- **Spec ref:** §17.1.
- **Depends on:** T9.3

### T10.2 — smoke-test matrix in CI

- **Files:**
  - `.github/workflows/pull-request-ci.yml` (extend): add `smoke:claude` and `smoke:gemini` steps. Total 14+ smoke scenarios.
- **Acceptance:** CI green on `main`. A red-path test (deliberately-wrong fixture) fails CI visibly.
- **Spec ref:** §17.2.
- **Depends on:** T10.1

### T10.3 — E2E runbook (manual)

- **Files:**
  - `docs/e2e.md`: exact commands to run real-CLI E2E tests on a machine with Claude + Gemini OAuth. Expected outputs. Cleanup steps.
  - `tests/e2e/claude.e2e.test.mjs`, `tests/e2e/gemini.e2e.test.mjs`: `npm run e2e:claude` / `npm run e2e:gemini` targets; not in CI.
- **Acceptance:** Running the documented E2E on maintainer's machine passes for both targets. Record timestamps + session file paths in `docs/e2e.md`.
- **Spec ref:** §17.3.
- **Depends on:** T10.2

### T10.4 — manifest + schema lint matrix

- **Files:**
  - `scripts/ci/check-manifests.mjs` (extend): validate every `SKILL.md`, every `commands/*.md` frontmatter, every `agents/*.md` frontmatter. Fail on unknown keys.
- **Acceptance:** Adding an unknown key (test) fails lint.
- **Spec ref:** §4.13.
- **Depends on:** T10.3

### T10.5 — README + install instructions

- **Files:**
  - `README.md` (rewrite): install path, command inventory, safety disclosures per §10 (Gemini plan-mode NOT a sandbox; policy files are; `--dispose` default), E2E pointers.
- **Acceptance:** Reading the README alone, a new user can install, enable, and invoke a first command successfully.
- **Spec ref:** §20.
- **Depends on:** T10.4

---

## M11 — Release

### T11.1 — CHANGELOG + version bump

- **Files:**
  - `CHANGELOG.md`: v0.1.0 entry — features shipped, known limitations, upstream attribution.
  - Both `.codex-plugin/plugin.json`: `"version": "0.1.0"`.
- **Acceptance:** `git tag v0.1.0` cleanly.
- **Spec ref:** §20.
- **Depends on:** T10.5

### T11.2 — self adversarial review

- **Goal:** external-eye check on the release candidate.
- **Files:** (procedural; findings documented in `docs/m10-review.md`)
- **Acceptance:** Run `/codex:adversarial-review` against the branch. Every finding either fixed (code diff referenced) or justified in writing. No open findings of severity > low.
- **Spec ref:** §17.4, §20.
- **Depends on:** T11.1

### T11.3 — merge to main

- **Files:** (procedural)
- **Acceptance:** Single PR for `docs/1-design-spec` → `main`, bundled spec + plan + implementation. Passes CI. Reviewed.
- **Spec ref:** §20.
- **Depends on:** T11.2

### T11.4 — install verification on fresh machine

- **Files:** `docs/release-verification.md`
- **Acceptance:** On a machine that has never installed this plugin: `codex plugin marketplace add seungpyoson/codex-plugin-multi` → enable both → run one smoke command per plugin → all pass. Recorded.
- **Spec ref:** §20.
- **Depends on:** T11.3

⚠️ **gate-5 (final):** all success criteria from spec §20 met, documented, and observable.

---

## Cross-cutting conventions

- **Commits:** conventional-commits (`feat(claude): …`, `fix(gemini): …`, `docs(plan): …`, `test: …`).
- **Branching:** spec + plan co-live on `docs/1-design-spec`. Implementation tasks may spin per-milestone branches (`feat/m0-skeleton`, `feat/m1-libs`, …) that merge into `docs/1-design-spec`, then final merge to `main` at T11.3.
- **Task completion marker:** each task's commit message ends with `Plan-task: T<ID>`. Makes `git log --grep` fast.
- **Adversarial-review gates:** blocking. Create an `m<N>-review.md` with findings + disposition before opening the next milestone's first task.
- **No skipping acceptance:** if a task's acceptance criterion can't be met, the task is revised before proceeding (not deferred "to a later milestone").
- **Upstream sync cadence:** at the start of M7 (Gemini port), re-sync upstream `openai/codex-plugin-cc` lib files; record SHA in `UPSTREAM.md`.
