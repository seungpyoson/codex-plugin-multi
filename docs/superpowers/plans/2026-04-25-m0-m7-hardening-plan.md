# M0-M7 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every behavior change is TDD: write the failing test, run it and confirm the expected failure, implement the minimal fix, then rerun focused tests before moving on.

**Goal:** Close all known M0-M7 audit findings without creating a new architecture detour.

**Architecture:** Shared safety behavior comes first and applies to both plugins: scope snapshots must be safe copies, mutation detection must inspect the real filesystem, and review-mode uncertainty must fail closed. Target-specific code remains limited to actual CLI differences: Claude argv/session/schema behavior versus Gemini stdin/policy/trust/auth behavior.

**Tech Stack:** Node.js ESM, `node:test`, mock CLIs in `tests/smoke`, local companions in `plugins/<target>/scripts`, safe commits through `python3 ~/.claude/lib/safe_git.py commit`.

---

## Execution Protocol

- Use one fresh worker subagent per task, sequentially.
- Each worker owns only the files listed in that task.
- Workers are not alone in the codebase; they must not revert edits from other workers.
- Each worker must report: files changed, failing tests observed before implementation, focused tests passed after implementation, concerns.
- After each worker returns, run a spec-compliance review subagent, then a code-quality review subagent for that task before marking it complete.
- No implementation subagents run in parallel because the shared foundation touches mirrored plugin files.
- Do not run `git commit` directly. Use `python3 ~/.claude/lib/safe_git.py commit -m "..."` only after the task's verification passes.

---

## Task 1: Safe Scope Snapshots

**Purpose:** Make `containment=worktree` a real copy boundary for both plugins.

**Files:**
- Modify: `plugins/claude/scripts/lib/scope.mjs`
- Modify: `plugins/gemini/scripts/lib/scope.mjs`
- Modify: `tests/unit/scope.test.mjs`
- Modify if needed: `tests/unit/plugin-copies-in-sync.test.mjs`

**Behavior Contract:**
- `working-tree` must support normal non-git folders by walking the live filesystem.
- In git repos, `working-tree` must include tracked files and untracked non-ignored files; use `custom` for deliberate ignored-file inclusion.
- Snapshot population must never leave a symlink in the disposable target tree.
- A symlink to a regular file inside `sourceCwd` is materialized as a regular file copy.
- A symlink to a directory, a dangling symlink, a symlink loop, or any symlink resolving outside `sourceCwd` throws `unsafe_symlink`.
- After any scope population, walking the target snapshot must find no symlinks except git metadata skipped under `.git`.
- Git-derived scopes (`branch-diff`, `staged`, `head`) may still require git, but failures must be clear and must not run the target CLI.

**TDD Steps:**
- [ ] Add a failing unit test: `populateScope scope=working-tree: materializes in-tree file symlinks as regular files`.
- [ ] Run `npm test -- tests/unit/scope.test.mjs` and confirm the new test fails because the target contains a symlink.
- [ ] Add a failing unit test: `populateScope scope=working-tree: rejects symlink escaping source root`.
- [ ] Run `npm test -- tests/unit/scope.test.mjs` and confirm it fails because current code recreates the symlink.
- [ ] Add a failing unit test: `populateScope scope=working-tree: supports non-git folders`.
- [ ] Run `npm test -- tests/unit/scope.test.mjs` and confirm it fails on `git ls-files`.
- [ ] Implement the minimal shared `scope.mjs` changes in both plugin copies.
- [ ] Run `npm test -- tests/unit/scope.test.mjs`.
- [ ] Run `npm test -- tests/unit/plugin-copies-in-sync.test.mjs`.

**Implementation Notes:**
- Keep `scope.mjs` target-neutral in both copies; only comments may differ if existing tests allow it.
- Use `realpathSync(sourceCwd)` for boundary checks.
- Use `lstatSync` to identify symlinks and `realpathSync(src)` to resolve safe targets.
- Use a path boundary helper that accepts only `resolved === root` or `resolved.startsWith(root + path.sep)`.
- Do not preserve symlinks in the target snapshot.
- Do not add a new dependency.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Harden shared scope snapshots"`

---

## Task 2: Shared Filesystem Mutation Manifest

**Purpose:** Replace git-status-only mutation detection with a shared filesystem manifest that catches ignored-file changes and works outside git.

**Files:**
- Create: `plugins/claude/scripts/lib/mutation-manifest.mjs`
- Create: `plugins/gemini/scripts/lib/mutation-manifest.mjs`
- Modify: `tests/unit/plugin-copies-in-sync.test.mjs`
- Create or modify: `tests/unit/mutation-manifest.test.mjs`

**Behavior Contract:**
- Manifest walk includes regular files, directories, and symlinks under the source cwd.
- Manifest walk skips any `.git` directory at any depth.
- Regular files are identified by SHA-256 content hash, size, and mode.
- Symlinks are recorded by link target text and are not followed by the manifest walker.
- Unreadable paths, disappearing paths during walk, or stat/read errors throw `mutation_manifest_failed`.
- Diff output remains a `string[]` for JobRecord compatibility:
  - `A path` for added paths.
  - `D path` for deleted paths.
  - `M path` for changed file content or symlink target.
  - `T path` for path type changes.
- Paths are relative slash-separated paths, sorted for stable output.

**TDD Steps:**
- [ ] Add a failing test: ignored file content changes produce `["M ignored.txt"]`.
- [ ] Add a failing test: added ignored file produces `["A ignored.txt"]`.
- [ ] Add a failing test: deleted file produces `["D file.txt"]`.
- [ ] Add a failing test: regular file replaced by symlink produces `["T file.txt"]`.
- [ ] Add a failing test: nested `.git` metadata is skipped.
- [ ] Run `npm test -- tests/unit/mutation-manifest.test.mjs` and confirm the tests fail because the module does not exist.
- [ ] Implement the manifest module in both plugin copies.
- [ ] Add `mutation-manifest.mjs` to the byte-identity list if that test uses an explicit allowlist.
- [ ] Run `npm test -- tests/unit/mutation-manifest.test.mjs`.
- [ ] Run `npm test -- tests/unit/plugin-copies-in-sync.test.mjs`.

**Implementation Notes:**
- Export `buildMutationManifest(root)` and `diffMutationManifests(before, after)`.
- Return plain JSON-serializable objects so companions can write sidecars directly.
- Do not use `git` in this module.
- Do not follow symlinks; source mutation detection checks the source tree itself, not external files a symlink might point to.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Add shared mutation manifest"`

---

## Task 3: Wire Fail-Closed Mutation Detection Into Both Companions

**Purpose:** Use the shared manifest in both run paths and make mutation detection failure visible, not silent.

**Files:**
- Modify: `plugins/claude/scripts/claude-companion.mjs`
- Modify: `plugins/gemini/scripts/gemini-companion.mjs`
- Modify: `plugins/claude/scripts/lib/job-record.mjs`
- Modify: `plugins/gemini/scripts/lib/job-record.mjs`
- Modify: `tests/smoke/invariants.test.mjs`
- Modify: `tests/smoke/gemini-companion.smoke.test.mjs`
- Modify: `tests/unit/job-record.test.mjs`

**Behavior Contract:**
- For `profile.permission_mode === "plan"`, both companions take a filesystem manifest before target execution and after target execution.
- If the pre-run manifest fails, the target CLI must not run and the JobRecord must fail closed.
- If the post-run manifest fails, the JobRecord must fail closed but preserve the execution tuple already obtained: exit code, parsed result, pid info, and target session id.
- `error_code` for mutation detection failure is `mutation_detection_failed`, not `spawn_failed`.
- If manifest diff is non-empty, the final JobRecord can still be `completed`, with `mutations[]` carrying the diff strings.
- Sidecars become `mutation-manifest-before.json` and `mutation-manifest-after.json`; git-status sidecars are removed from this path.
- Claude and Gemini behavior must match except for target-specific session id field names.

**TDD Steps:**
- [ ] Add a failing Claude smoke test reproducing the symlink-to-ignored-file escape and expecting either pre-run `unsafe_symlink` failure or a non-empty mutation report; after Task 1 the expected result is pre-run failure before target execution.
- [ ] Add a failing Gemini smoke test with the same symlink escape expectation.
- [ ] Add a failing Claude smoke test where a mock writes directly to an ignored source file by absolute path and expects `mutations[]` to include that file.
- [ ] Add a failing Gemini smoke test with the same ignored-file mutation expectation.
- [ ] Add a failing JobRecord unit test for `error_code: "mutation_detection_failed"` when `execution.errorCode` or equivalent explicit field is passed.
- [ ] Run the focused tests and confirm failures against current git-status behavior.
- [ ] Wire manifest snapshots into both companions.
- [ ] Update `buildJobRecord` classification in both plugin copies so mutation detection failure has a distinct error code.
- [ ] Preserve execution data on post-run mutation detection failure.
- [ ] Run `npm test -- tests/unit/job-record.test.mjs tests/unit/mutation-manifest.test.mjs tests/smoke/invariants.test.mjs tests/smoke/gemini-companion.smoke.test.mjs`.

**Implementation Notes:**
- Prefer adding an explicit `errorCode` field to the execution object consumed by `buildJobRecord` over parsing text prefixes.
- Keep terminal record construction through `buildJobRecord`; do not hand-assemble foreground JSON.
- Use existing atomic `writeSidecar` helpers.
- Ensure temporary Gemini neutral cwd cleanup still happens on every failure path.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Use shared manifest mutation detection"`

---

## Task 4: Shared Command and Schema Contract Cleanup

**Purpose:** Remove contract drift that keeps audits rediscovering docs/test mismatches.

**Files:**
- Modify: `plugins/claude/commands/claude-review.md`
- Modify: `plugins/claude/commands/claude-adversarial-review.md`
- Modify: `plugins/gemini/commands/gemini-review.md`
- Modify: `plugins/gemini/commands/gemini-adversarial-review.md`
- Modify: `plugins/claude/commands/claude-result.md`
- Modify: `plugins/gemini/commands/gemini-result.md`
- Modify: `plugins/claude/skills/claude-result-handling/SKILL.md`
- Create: `plugins/gemini/skills/gemini-result-handling/SKILL.md`
- Modify: `docs/superpowers/specs/2026-04-23-codex-plugin-multi-design.md`
- Modify: `tests/unit/docs-contracts.test.mjs`
- Modify: `tests/unit/job-record.test.mjs`
- Modify: `tests/unit/manifests.test.mjs`

**Behavior Contract:**
- Review command argument hints use `--scope-base <ref>`, not `--base <ref>`.
- Command docs derive mutation warnings from `mutations.length > 0`; no docs imply a top-level `warning` or `mutated_files`.
- Spec §21.3 describes schema version 6 and the real flat fields: `containment`, `scope`, `dispose_effective`.
- Spec §21.3 describes `mutations[]` as git-status-like strings produced by filesystem mutation detection.
- Claude result skill error enum includes `mutation_detection_failed` and removes `timeout` unless code actually emits it.
- Gemini has a result-handling skill covering the same JobRecord fields and Gemini-specific `gemini_error`.
- Docs tests cover both Claude and Gemini command markdown.

**TDD Steps:**
- [ ] Add failing docs-contract tests proving all four review/adversarial command docs mention `--scope-base` and do not mention `--base`.
- [ ] Add failing docs-contract tests proving both result docs use `mutations[]` wording and not generic "mutation warning exists".
- [ ] Add failing JobRecord docs parity tests for the Gemini result-handling skill.
- [ ] Run `npm test -- tests/unit/docs-contracts.test.mjs tests/unit/job-record.test.mjs` and confirm failures.
- [ ] Update docs, spec, and skills.
- [ ] Run `npm test -- tests/unit/docs-contracts.test.mjs tests/unit/job-record.test.mjs tests/unit/manifests.test.mjs`.

**Implementation Notes:**
- Keep the spec changes factual; do not add new §21 invariants.
- If a doc mentions version floors, either implement version checking in Task 5 or remove the claim here. Do not leave dead-data claims.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Align shared command and schema contracts"`

---

## Task 5: Gemini Runtime Hardening

**Purpose:** Fix valid Gemini-only runtime findings without changing the shared safety design.

**Files:**
- Modify: `plugins/gemini/scripts/lib/gemini.mjs`
- Modify: `plugins/gemini/scripts/gemini-companion.mjs`
- Modify: `plugins/gemini/scripts/lib/mode-profiles.mjs`
- Modify: `tests/unit/gemini-dispatcher.test.mjs`
- Modify: `tests/smoke/gemini-companion.smoke.test.mjs`
- Modify: `tests/smoke/gemini-mock.mjs`

**Behavior Contract:**
- `parseGeminiResult` parses:
  - compact JSON,
  - pure pretty-printed JSON,
  - leading stdout noise followed by one pretty-printed JSON object.
- If no JSON object can be parsed, parser returns `json_parse_error` with raw stdout preserved.
- Gemini child process env is sanitized per-run only; parent env is untouched.
- Sanitized child env removes billing/API selectors: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_VERTEX_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_CLI_USE_COMPUTE_ADC`, `CLOUD_SHELL`.
- Do not remove OAuth/session variables or `HOME`; the Gemini CLI must still see the user's installed OAuth login.
- Gemini ping uses a fresh neutral temp cwd under `/tmp`, not literal `/tmp`, and cleans it up.
- Gemini ping classifies auth and rate-limit stderr as `not_authed` and `rate_limited`.
- Gemini status honors `--all` with Claude parity: default shows `running`, `completed`, and `failed`; `--all` includes queued/cancelled/stale.
- Gemini mode-profile comments no longer claim Claude tool blocklists enforce Gemini policy.

**TDD Steps:**
- [ ] Add a failing parser unit test for stdout noise followed by pretty JSON.
- [ ] Add a failing unit test that `sanitizeGeminiEnv` strips billing/API vars but preserves `HOME`.
- [ ] Add a failing smoke test where `gemini-mock.mjs` records whether API env vars reached the child.
- [ ] Add a failing ping smoke test proving ping cwd is a temp dir under `/tmp`, not `/tmp`, and is cleaned up.
- [ ] Add failing ping classification tests for auth and rate-limit mock stderr.
- [ ] Update the existing Gemini status smoke test to expect Claude-parity filtering by default and all statuses with `--all`.
- [ ] Run `npm test -- tests/unit/gemini-dispatcher.test.mjs tests/smoke/gemini-companion.smoke.test.mjs` and confirm failures.
- [ ] Implement the minimal Gemini runtime changes.
- [ ] Run `npm test -- tests/unit/gemini-dispatcher.test.mjs tests/smoke/gemini-companion.smoke.test.mjs`.

**Implementation Notes:**
- Use a balanced-brace JSON object extractor, not first-brace/last-brace if a smaller valid object can be found.
- Keep env sanitization in `gemini.mjs` so every Gemini spawn path uses it.
- Do not sanitize Claude env in this task; no equivalent Claude billing-switch path has been proved.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Harden Gemini runtime behavior"`

---

## Task 6: Shared Importability and Coverage Closure

**Purpose:** Close test coverage gaps that allowed shared duplicated files and docs drift to escape.

**Files:**
- Modify: `tests/unit/lib-imports.test.mjs`
- Modify: `tests/unit/policy.test.mjs`
- Modify: `tests/smoke/gemini-companion.smoke.test.mjs`
- Modify: `tests/smoke/claude-companion.smoke.test.mjs` if parity requires it

**Behavior Contract:**
- `lib-imports.test.mjs` enforces production-consumer checks for both Claude and Gemini lib files.
- Gemini policy test asserts the deny list contains every currently known destructive tool in `read-only.toml`.
- Gemini smoke coverage includes `review`, `adversarial-review`, `rescue`, `ping`, `status`, and `result` where M7 supports them.
- Historical M7 boundary: Gemini background and cancel remained documented as
  not implemented. Runtime after `3bf78d4`: Gemini background and continue
  were implemented while Gemini cancel remained deferred. PR #23 follow-up
  work wires Gemini cancel; current operator contract lives in
  `plugins/gemini/commands/gemini-cancel.md`.

**TDD Steps:**
- [ ] Add a failing lib-imports test for Gemini production consumers.
- [ ] Run `npm test -- tests/unit/lib-imports.test.mjs` and confirm it fails on current disabled Gemini check.
- [ ] Update production-consumer traversal so both plugin companions and lib-to-lib imports are handled per target.
- [ ] Add policy completeness assertions for every deny rule present in `plugins/gemini/policies/read-only.toml`.
- [ ] Add Gemini smoke cases for adversarial-review and rescue with the mock CLI.
- [x] Superseded by PR #23 follow-up work: Gemini cancel is now implemented and
  covered by smoke/docs-contract tests.
- [ ] Run `npm test -- tests/unit/lib-imports.test.mjs tests/unit/policy.test.mjs tests/smoke/gemini-companion.smoke.test.mjs`.

**Implementation Notes:**
- Historical scope boundary: do not add cancel behavior in this M0-M7 hardening
  pass. Gemini cancel was implemented later in PR #23 follow-up work.
- Keep smoke tests mock-based; live Gemini OAuth verification is Task 7.

**Commit:**
- [ ] Commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Close M7 coverage gaps"`

---

## Task 7: Full Verification and Live Gemini OAuth Checks

**Purpose:** Verify the hardened branch end to end before external M0-M7 audit.

**Files:**
- Modify only if verification exposes a test fixture bug: `tests/smoke/*`
- No production code changes in this task unless a preceding task is reopened through TDD.

**Verification Commands:**
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run a live Gemini `ping` through the plugin with the real `gemini` binary.
- [ ] Run a live Gemini `review` in a temp repo containing a normal file and no symlink.
- [ ] Run a live Gemini `adversarial-review` in a temp repo with a branch diff.
- [ ] Run a live Gemini `rescue` in a temp repo and confirm it remains write-capable by design.
- [ ] Confirm live Gemini runs succeed while parent env has API-key vars by name, proving child env sanitization did not break OAuth login.
- [ ] Run the local symlink escape repro for both Claude and Gemini and confirm the target CLI is not executed or the command fails closed before mutation.
- [ ] Run `git status --short`.

**Expected Evidence:**
- `npm run lint` passes.
- `npm test` passes.
- Live Gemini JobRecords have `target: "gemini"`, real `gemini_session_id`, expected status, and no unexpected mutations.
- Symlink escape repro fails closed and source ignored file remains unchanged.
- Worktree is clean except intentional committed changes.

**Commit:**
- [ ] If Task 7 required no code changes, do not commit.
- [ ] If Task 7 required test-fixture changes, commit with: `python3 ~/.claude/lib/safe_git.py commit -m "Verify M0-M7 hardening"`

---

## Final External Audit Prompt

After Task 7 passes, generate one self-contained M0-M7 adversarial audit prompt for the user to relay to the five reviewers. The prompt must include:

- Full branch SHA.
- Diff scope since `8df9f3ecf54ecc7d7021b0a5a311ad57637b05c4`.
- Explicit prior blockers: symlink escape, git-status ignored-file blind spot, noisy Gemini JSON, Gemini env billing selectors, `--base` docs drift, ping cwd/classification, stale schema docs.
- Objective criteria for Claude and Gemini separately plus shared criteria.
- Request for `PASS_M0_M7` or `BLOCK_M0_M7` with concrete file:line evidence.
- Instruction to list every non-blocker, including nit/cosmetic/low findings.

Do not propose merging after this audit prompt. The user decides when external review is complete and when merge is appropriate.
