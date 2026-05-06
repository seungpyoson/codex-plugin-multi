# Companion-architecture path map

Scope: end-to-end path map of every subcommand entry point in the three companion plugins (`claude`, `gemini`, `kimi`) and the shared lib code that lives behind them. For contracts on the persisted output (`JobRecord`, `external_review`, lifecycle events, redaction) this doc cross-references `docs/contracts/` instead of restating them. For closed-issue archaeology and test references it cross-references `docs/closed-issue-failure-modes.md` (Layer 2).

## Architecture-level facts

- Three companion plugins. Source at `plugins/{claude,gemini,kimi}/scripts/{claude,gemini,kimi}-companion.mjs`. Per-plugin libs at `plugins/<p>/scripts/lib/`. Shared sources at `scripts/lib/` (synced into each plugin via `scripts/ci/sync-*.mjs`).
- Subcommands are identical across the three plugins:
  `preflight`, `run`, `_run-worker`, `continue`, `ping` (alias `doctor`), `status`, `result`, `cancel`. Dispatch table at `plugins/claude/scripts/claude-companion.mjs:1541-1557`, `plugins/gemini/scripts/gemini-companion.mjs:1430-1446`, `plugins/kimi/scripts/kimi-companion.mjs:1462-1478`.
- There is **no** separate `cmdReview` / `cmdCustomReview` / `cmdAdversarialReview`. Review modes (`review`, `adversarial-review`, `custom-review`, `rescue`) all flow through `cmdRun --mode <X>`. Mode → profile resolution happens once at entry via `resolveProfile(mode)` (`plugins/claude/scripts/lib/mode-profiles.mjs`); every downstream branch reads the profile, never the mode string.
- `RUN_MODES` includes `rescue` (foreground/background `cmdRun`); `PREFLIGHT_MODES` does not (`claude-companion.mjs:82-83`, `gemini-companion.mjs:52-53`, `kimi-companion.mjs:46-47`).
- `doctor` is a literal alias for `cmdPing` in all three (`claude-companion.mjs:1550`, `gemini-companion.mjs:1439`, `kimi-companion.mjs:1471`). There is no separate doctor implementation.
- Output contract for run/continue: a single `JobRecord` per run — see [`docs/contracts/job-record.md`](../contracts/job-record.md) for the 41-field schema, `status` enum and `error_code` enum.
- Output contract for sub-record: `external_review` 12-key sub-record — see [`docs/contracts/external-review.md`](../contracts/external-review.md) for the `source_content_transmission` enum and disclosure templates.
- Lifecycle events: `external_review_launched` (foreground) and `launched` (background) — see [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md).
- Redaction surface: env-strip pre-spawn via `sanitizeTargetEnv` — see [`docs/contracts/redaction.md`](../contracts/redaction.md). No post-hoc string scrub of stdout/stderr.

## Provider-specific divergences (used inline below)

- Session-id field name: `claude_session_id` / `gemini_session_id` / `kimi_session_id` — separate persisted fields on the JobRecord per [`docs/contracts/job-record.md`](../contracts/job-record.md).
- Spawn binary defaults: `claude` / `gemini` / `kimi`. Override via `--binary`, then `CLAUDE_BINARY` / `GEMINI_BINARY` / `KIMI_BINARY`.
- Spawn args differ — see [Provider call](#provider-call-detail) section below.
- Kimi-only invocation field: `max_steps_per_turn` (CLI flag `--max-steps-per-turn`, runtime-options sidecar key, profile default 8). Source: `kimi-companion.mjs:514`, `plugins/kimi/scripts/lib/kimi.mjs:23-44`.
- Kimi-only failure modes: `step_limit_exceeded`, `usage_limited` (parsed in `plugins/kimi/scripts/lib/kimi.mjs:103-189`; classified by `error_code` in [`docs/contracts/job-record.md`](../contracts/job-record.md)).
- Kimi-only ping classification: `sandbox_blocked` (`kimi-companion.mjs:1183-1188`, `1222-1232`); also `transient_timeout` (`kimi-companion.mjs:1289-1292`).
- Gemini- and Kimi-only: model-fallback chain across capacity-limited candidates — `gemini-companion.mjs:702-724`, `kimi-companion.mjs:687-728`. Claude does not retry on capacity (single-call).
- Auth modes: claude/gemini accept `--auth-mode` and resolve via `resolveAuthSelection` returning `subscription` / `api_key_env` / `api_key_env_missing`. Kimi does **not** accept `--auth-mode` (subscription only); `KIMI_CODE_API_KEY` / `KIMI_API_KEY` / `MOONSHOT_API_KEY` env vars are surfaced as `ignored_env_credentials` via `credentialNameDiagnostics` (`scripts/lib/companion-common.mjs:205-212`, `kimi-companion.mjs:1124-1129`).
- Per-plugin review timeout: claude/gemini default 600000ms (env `CLAUDE_REVIEW_TIMEOUT_MS` / `GEMINI_REVIEW_TIMEOUT_MS`); kimi default 600000ms (env `KIMI_REVIEW_TIMEOUT_MS`). Tracked under #86 — see Layer 2.

## State surface

Persistence layout (per workspace, per plugin):

- `state.json` — `{ version, config, jobs[] }` at `resolveStateFile(cwd)` (`plugins/claude/scripts/lib/state.mjs:94-96`). `jobs[]` is a pruned summary (max 50 terminal entries) with newest-first ordering (`state.mjs:137-157`).
- `jobs/<job-id>.json` — full JobRecord meta (`state.mjs:705-718` `writeJobFile`, `state.mjs:764-768` `resolveJobFile`).
- `jobs/<job-id>/prompt.txt` — private 0600 prompt sidecar; written by background launcher, read+unlink-ed by worker (`scripts/lib/companion-common.mjs:146-187`). Full prompt **never** lives on the JobRecord (§21.3.1).
- `jobs/<job-id>/runtime-options.json` — 0600 sidecar carrying `timeout_ms` and (kimi only) `max_steps_per_turn` for background workers; written by launcher (`claude-companion.mjs:332-350`, `gemini-companion.mjs:273-291`, `kimi-companion.mjs:281-303`); read by worker (`claude-companion.mjs:352-363`, etc.).
- `jobs/<job-id>/stdout.log`, `stderr.log` — diagnostic sidecars written post-run (`claude-companion.mjs:892-899`, `gemini-companion.mjs:802-809`, `kimi-companion.mjs:789-797`). Best-effort: write failures emit a stderr warning, never change terminal status.
- `jobs/<job-id>/git-status-before.txt`, `git-status-after.txt` — mutation-detection sidecars when profile permission_mode === "plan".
- `.state.lock` / `.state.lock.gate` — file-lock dirs serializing `state.json` writers (`state.mjs:418-512`).
- `.cancel/<job-id>` — cancel-marker file written by `cmdCancel` before signaling (`plugins/claude/scripts/lib/cancel-marker.mjs`).

`commitJobRecord` is the one atomic commit point: it folds `writeJobFile + applyJobUpsertToState` under one `state.lock` acquisition (`state.mjs:639-652`). Returns `{ metaError, stateError }` — callers handle each side independently. This was BLOCKER 1+2 from PR #21 review (#16 follow-up; see source comments at `state.mjs:617-638`).

---

## Flow: `preflight` (synchronous, no background)

- Entry: `cmdPreflight` — `claude-companion.mjs:480`, `gemini-companion.mjs:403`, `kimi-companion.mjs:442`.
- Argument validation:
  - `valueOptions: ["mode", "cwd", "scope-base", "scope-paths", "binary"]`. Cited at the entry lines above.
  - `--mode` required; must be in `PREFLIGHT_MODES` = `["review", "adversarial-review", "custom-review"]` (no `rescue`). Failure → `bad_args` with the invocation echoed plus `preflightSafetyFields()` and `preflightDisclosure()` (companion-common.mjs:189-203).
- Prelaunch checks:
  - `resolveProfile(mode)` — `mode-profiles.mjs`.
  - `resolveWorkspaceRoot(cwd)` — `lib/workspace.mjs`.
  - `parseScopePathsOption` — `companion-common.mjs:53-57`.
- Provider call: **none.** Preflight never spawns the target CLI. The point of preflight is to assert scope is buildable while emitting `target_spawned: false`, `selected_scope_sent_to_provider: false`, `requires_external_provider_consent: true`.
- Persistence: **none.** No JobRecord written, no state.json mutation. Containment is set up in a temp dir and torn down in the `finally` block.
- Output:
  - On success: `printJson({ ok: true, event: "preflight", target, mode, mode_profile_name, cwd, workspace_root, containment, scope, scope_base, scope_paths, ...summarizeScopeDirectory(containment.path), ...preflightSafetyFields(), disclosure_note })`. Exit 0.
  - On scope build failure: `printJson({ ok: false, error: "scope_failed", error_message, ... })`. Exit 2.
- State mutations: containment temp directory created via `setupContainment(profile, cwd)` (`plugins/claude/scripts/lib/containment.mjs`); deleted in `finally`. No persistent state.
- Failure modes:
  - `bad_args` — invalid `--mode`.
  - `scope_failed` — scope population threw. The error_code in this preflight context is the literal string `scope_failed` in the JSON; not a JobRecord (no JobRecord exists for preflight).
  - The "preflight contract" (`target_spawned`, `selected_scope_sent_to_provider`, `requires_external_provider_consent`) is documented in code at `scripts/lib/companion-common.mjs:189-203` but not yet in `docs/contracts/`. See spec_gap row for issue #27 in `docs/closed-issue-failure-modes.md`.
- Test refs:
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — preflight scenarios (search for `event.*preflight`, `requires_external_provider_consent`).
  - `tests/unit/companion-common.test.mjs` — preflight safety fields + disclosure (semantic match per Layer 2 #27).

---

## Flow: `run` (foreground)

Modes that route here: `review`, `adversarial-review`, `custom-review`, `rescue` (the "review" family is differentiated only by `--mode`, which selects a profile).

- Entry: `cmdRun` — `claude-companion.mjs:553`, `gemini-companion.mjs:473`, `kimi-companion.mjs:512`.
- Argument validation:
  - `valueOptions: ["mode", "model", "cwd", "schema", "binary", "scope-base", "scope-paths", "override-dispose", "auth-mode", "timeout-ms", "lifecycle-events"]` (claude). Gemini omits `schema`. Kimi omits `auth-mode`/`schema`, adds `max-steps-per-turn`. Cited at the entry lines.
  - `booleanOptions: ["background", "foreground"]`. Mutually exclusive — fails `bad_args` if both set (`claude-companion.mjs:564-566`).
  - `--mode` required; must be in `RUN_MODES` = `["review", "adversarial-review", "custom-review", "rescue"]` (`claude-companion.mjs:561-563`).
  - Prompt required after `--` separator; positionals.join(" ").trim() must be non-empty (`claude-companion.mjs:601-604`).
  - `--lifecycle-events` parsed by `parseLifecycleEventsMode`; only `null`/`false`/`"jsonl"` accepted (`scripts/lib/companion-common.mjs:19-23`). Failure → `bad_args`.
  - `--timeout-ms` parsed by `parseReviewTimeoutMs` (claude/gemini) or `parsePositiveTimeoutMs` (kimi). Must be a positive `Number.isSafeInteger`; non-string types or non-positive values → `bad_args`.
  - Kimi only: `--max-steps-per-turn` parsed by `parsePositiveMaxStepsPerTurn` (`kimi-companion.mjs:368-375`).
- Prelaunch checks:
  - `resolveProfile(mode)` — `lib/mode-profiles.mjs`.
  - `resolveModelForProfile(profile, loadModels())` returns `null` → `no_model` (`claude-companion.mjs:577-579`). `--model` override always wins over profile resolution.
  - `resolveWorkspaceRoot(cwd)` — `lib/workspace.mjs`.
  - `disposeEffective` resolution: `--override-dispose` wins; otherwise `profile.dispose_default` (`claude-companion.mjs:585-591`).
  - `resolveAuthSelection(--auth-mode)` (claude/gemini only): returns `{ auth_mode, selected_auth_path, allowed_env_credentials }`. If `selected_auth_path === "api_key_env_missing"` → `not_authed` failure (`claude-companion.mjs:605-608`, `gemini-companion.mjs:509-512`). Auth selection logic in `plugins/{claude,gemini}/scripts/lib/auth-selection.mjs`. Kimi has no auth-mode; provider api-key envs surface as `ignored_env_credentials` only.
  - Sandbox detection: `lib/codex-env.mjs::isCodexSandbox(env)` is consulted by gemini (in `buildGeminiArgs` to suppress `-s` flag — `plugins/gemini/scripts/lib/gemini.mjs:45`) and by kimi ping (for sandbox-blocked classification — `kimi-companion.mjs:1222-1232`). Claude does not branch on sandbox detection.
- Frozen invocation built (`claude-companion.mjs:616-640`, `gemini-companion.mjs:515-539`, `kimi-companion.mjs:556-580`). Field set follows `EXPECTED_KEYS` per [`docs/contracts/job-record.md`](../contracts/job-record.md). `prompt_head` = `prompt.slice(0, 200)` — full prompt is **not** persisted (assertInvocation defense at `lib/job-record.mjs:418-424`).
- Persistence (queued):
  - `buildJobRecord(invocation, null, [])` → `status: "queued"`.
  - `writeJobFile(workspaceRoot, jobId, queuedRecord)` — full meta to disk.
  - `upsertJob(workspaceRoot, queuedRecord)` — state.json summary entry.
  - Cited: `claude-companion.mjs:644-646`, `gemini-companion.mjs:541-543`, `kimi-companion.mjs:582-585`.
  - Kimi additionally writes the runtime-options sidecar at this step (`kimi-companion.mjs:583`), since max_steps_per_turn must survive into a foreground continue. Claude/gemini do this ONLY on the background path (next section).
- Target prompt construction: `targetPromptFor(invocation, prompt)` — review modes get the contract-version review prompt (`buildReviewPrompt` in `lib/review-prompt.mjs`); rescue mode passes the user prompt through. Kimi additionally injects mode-specific instructions plus a "Live verification context" block (`kimi-companion.mjs:68-96`).
- Foreground branches into `executeRun(invocation, targetPrompt, { foreground: true, lifecycleEvents })` — see [executeRun](#executerun-shared-body).
- Output: pretty `printJson(finalRecord)` on terminal, or `printJsonLine(finalRecord)` when `lifecycleEvents === "jsonl"` (via `printLifecycleJson`, `companion-common.mjs:48-51`). Exit code is 0 when `status` is `completed` or `cancelled`, else 2 (`claude-companion.mjs:731`, `gemini-companion.mjs:611`, `kimi-companion.mjs:845`).
- State mutations:
  1. `jobs/<job-id>.json` queued meta (pre-spawn).
  2. `state.json` queued summary.
  3. (kimi) `jobs/<job-id>/runtime-options.json`.
  4. Containment scope dir created at `setupContainment(profile, cwd).path`.
  5. (when profile.permission_mode === "plan") neutral cwd `mkdtempSync(joinPath(tmpdir(), "<plugin>-neutral-cwd-"))` and `git-status-before.txt` sidecar.
  6. running record written from inside `onSpawn` callback (see [executeRun](#executerun-shared-body)).
  7. terminal record committed via `commitJobRecord` (atomic meta+state under lock).
  8. `stdout.log`, `stderr.log` sidecars (best-effort).
  9. (when plan) `git-status-after.txt` sidecar.
  10. (when `disposeEffective === true`) containment cleanup.
- Failure modes (all routed via the `error_code` enum on the JobRecord — see [`docs/contracts/job-record.md`](../contracts/job-record.md)):
  - `bad_args` — at parse stage. No JobRecord is written for these (`fail()` exits before `buildJobRecord`).
  - `no_model` — pre-build; no JobRecord.
  - `not_authed` — `api_key_env_missing` from auth selection; no JobRecord.
  - `scope_failed` — thrown by `setupExecutionScopeOrExit` if `setupContainment` or `populateScope` throws. Errored JobRecord written with `errorMessage` matching one of `SCOPE_FAILURE_PREFIXES` (`lib/job-record.mjs:260-270`). See Layer 2 #56 (Codex sandbox-related scope failures), #83 (oversized scopes — though companion has no cap; the 1MiB cap is grok-only).
  - `spawn_failed` — `spawnClaudeOrExit` / `spawnGeminiOrExit` / kimi inline catch — when the dispatcher throws from `child.on("error", ...)`. `transmission` resolves to `not_sent` per [`docs/contracts/external-review.md`](../contracts/external-review.md).
  - `claude_error` / `gemini_error` / `kimi_error` — target exited non-zero with no other classification.
  - `parse_error` — JSON parse failed or stdout empty (`parseClaudeResult` / `parseGeminiResult` / `parseKimiResult`).
  - `timeout` — wall-clock kill via the `timeoutMs` setTimeout in each dispatcher (`lib/claude.mjs:193-199`, `lib/gemini.mjs:142-148`, `lib/kimi.mjs:236-242`).
  - `step_limit_exceeded` — kimi only — `Max number of steps reached: N` matched by `STEP_LIMIT_RE` (`lib/kimi.mjs:70`). Layer 2 #52.
  - `usage_limited` — kimi only — 403 / quota / billing-cycle pattern in stdout/stderr (`lib/kimi.mjs:71`). Layer 2 #41.
  - `finalization_failed` — `commitJobRecord` returned `{ metaError, stateError }`. Per-side fallback at `claude-companion.mjs:915-936`, `gemini-companion.mjs:825-846`, `kimi-companion.mjs:799-840`. PR #21 review BLOCKER 1+2.
- Test refs:
  - `tests/smoke/claude-companion.smoke.test.mjs` — `run --mode review`, `run --mode rescue`, `--background`, `--lifecycle-events jsonl` paths (Layer 2 #3 confirms broad coverage).
  - `tests/smoke/gemini-companion.smoke.test.mjs` — same, plus model-capacity fallback path (`tests/smoke/gemini-companion.smoke.test.mjs` searched semantic for `MODEL_CAPACITY_EXHAUSTED` — Layer 2 #56).
  - `tests/smoke/kimi-companion.smoke.test.mjs` — same, plus `step_limit_exceeded` and `usage_limited` (Layer 2 #41/#52).
  - `tests/unit/{claude,gemini,kimi}-dispatcher.test.mjs` — argv shape per profile (Layer 2 #25 cites the dispatcher tests).
  - `tests/unit/job-record.test.mjs` — every classification path; Layer 1 cites individual tests.

---

## Flow: `run` (background)

Same `cmdRun` entry as foreground; branch taken when `--background` is set (`claude-companion.mjs:649-671`, `gemini-companion.mjs:546-563`, `kimi-companion.mjs:588-604`).

- Background-only validation: `validateBackgroundExecutionScopeOrExit(invocation, lifecycleEvents)` runs `setupContainment + populateScope` once, eagerly, then tears down. The point is to surface `scope_failed` synchronously to the launcher rather than in the detached worker (`claude-companion.mjs:761-768`, `gemini-companion.mjs:636-643`, `kimi-companion.mjs:848-872`). On failure, the launcher writes the errored JobRecord and exits 2.
- Persistence delta vs foreground:
  - `writePromptSidecar(jobsDir, jobId, targetPrompt)` — 0600 sidecar at `jobs/<job-id>/prompt.txt`. Write failure → `failBackgroundPromptSidecarWrite` writes an errored JobRecord and exits with `sidecar_failed` (`claude-companion.mjs:465-477`, `gemini-companion.mjs:389-401`, `kimi-companion.mjs:428-440`).
  - `writeRuntimeOptionsSidecar(workspaceRoot, jobId, { timeout_ms })` (claude/gemini) / `{ timeout_ms, max_steps_per_turn }` (kimi already wrote this earlier — kimi writes once, claude/gemini write only on the background path).
- Provider call: **launcher does not spawn the target.** Instead it spawns a detached node process re-entering `_run-worker` (see next flow). `spawnDetachedWorker(cwd, jobId, authMode)` at `claude-companion.mjs:413-448`, `gemini-companion.mjs:337-372`, `kimi-companion.mjs:377-411`.
  - Spawn uses `process.execPath` + `import.meta.url` + `["_run-worker", "--cwd", cwd, "--job", jobId, "--auth-mode", authMode]` (kimi omits `--auth-mode`).
  - `detached: true`, `stdio: "ignore"`, `windowsHide: true`. Launcher waits on `child.once("spawn")` and `child.once("error")` to know whether the spawn itself succeeded; on success, `child.unref()`.
- Output: launcher emits the `launched` lifecycle event via `externalReviewBackgroundLaunchedEvent(invocation, child.pid, externalReviewForInvocation(invocation))` (`scripts/lib/companion-common.mjs:35-46`) and exits 0. The terminal JobRecord is produced by the worker, not the launcher. See [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md).
- State mutations on the launcher side:
  1. queued JobRecord meta + state.json summary.
  2. validateBackgroundExecutionScopeOrExit — containment created and torn down once.
  3. `prompt.txt` sidecar (0600).
  4. `runtime-options.json` sidecar (0600).
  5. detached worker spawned.
  6. `launched` lifecycle JSON to stdout.
  7. (on spawn failure) errored JobRecord overwriting queued; prompt sidecar consumed (best-effort).
- Failure modes specific to the launcher:
  - `bad_args` / `no_model` / `not_authed` — same as foreground, no JobRecord.
  - `scope_failed` — emitted by `validateBackgroundExecutionScopeOrExit`. JobRecord written, exit 2.
  - `sidecar_failed` — `writePromptSidecar` or `writeRuntimeOptionsSidecar` threw. JobRecord written via `failBackgroundPromptSidecarWrite`, exit 1.
  - `spawn_failed` — `spawnDetachedWorker` settled with an error. JobRecord written via `failBackgroundWorkerSpawn` (`claude-companion.mjs:450-463`, `gemini-companion.mjs:374-387`, `kimi-companion.mjs:413-426`). Prompt sidecar best-effort cleanup.
- Test refs:
  - `tests/smoke/claude-companion.smoke.test.mjs` — `run --background` path; lifecycle event shape; sidecar leak protection.
  - `tests/smoke/{gemini,kimi}-companion.smoke.test.mjs` — same.

---

## Flow: `_run-worker` (background worker entry, hidden)

- Entry: `cmdRunWorker` — `claude-companion.mjs:951`, `gemini-companion.mjs:876`, `kimi-companion.mjs:893`.
- Argument validation:
  - `valueOptions: ["cwd", "job", "auth-mode"]` (kimi omits `auth-mode`).
  - `--cwd` and `--job` required → `bad_args` if missing.
- Prelaunch checks:
  - `resolveJobFile(workspaceRoot, options.job)` + `existsSync` → `not_found` if no meta.json (worker lost its meta).
  - JSON parse meta — failure caught with `fail("bad_args", e.message)`.
  - Terminal-state guard: if `meta.status` ∈ `{completed, failed, cancelled, stale}` → `bad_state` (`claude-companion.mjs:968-970`). Refusing worker re-entry on terminal jobs prevents a re-spawn from clobbering a finalized record.
  - **Cancel-marker preemption** (the safety net for the queued-cancel race): `consumeCancelMarker(workspaceRoot, options.job)` at `claude-companion.mjs:976-985`, `gemini-companion.mjs:903-912`, `kimi-companion.mjs:922-931`. If marker present:
    - Best-effort `consumePromptSidecar` (privacy cleanup so the prompt does not linger on disk for a job that will not run).
    - Build cancelled JobRecord with `status: "cancelled"`, write meta + upsert state.
    - Exit 0.
  - Prompt sidecar consume (`consumePromptSidecar`, `companion-common.mjs:167-187`): reads `jobs/<job-id>/prompt.txt`, then `unlinkSync`s it (the prompt does not stay on disk for the duration of the run). Missing → `bad_state` errored JobRecord. Throw → `bad_state` errored JobRecord.
  - Runtime-options sidecar read: `readRuntimeOptionsSidecar(workspaceRoot, options.job)` — picks up `timeout_ms` (claude/gemini/kimi) and `max_steps_per_turn` (kimi).
  - `invocation = invocationFromRecord(meta, options["auth-mode"], runtimeOptions)` — re-derives the frozen invocation from the persisted meta + sidecar (`claude-companion.mjs:365-394`, `gemini-companion.mjs:306-335`, `kimi-companion.mjs:322-349`). Lifecycle/result fields are intentionally NOT carried; they will be re-computed from the fresh execution.
  - Auth re-resolution (claude/gemini): `resolveAuthSelection(invocation.auth_mode)`; on `api_key_env_missing` write a `not_authed` errored JobRecord (the prompt sidecar was already consumed above — privacy preserved) and exit 1.
- Provider call & terminal-state production: `executeRun(invocation, prompt, { foreground: false })`. See [executeRun](#executerun-shared-body).
- Output: worker is detached with `stdio: "ignore"` — output to stdout/stderr is irrelevant. Worker writes JobRecord meta + state.json + sidecars and exits. There is no `lifecycleEvents` printing on the worker path (the launcher already emitted the `launched` event).
- State mutations: same as foreground `executeRun` — running record on spawn, terminal record on close, mutation sidecars when applicable.
- Failure modes:
  - `bad_args` — missing `--cwd` / `--job`.
  - `not_found` — meta.json gone.
  - `bad_state` — meta is terminal; or prompt sidecar missing/throw.
  - `not_authed` — auth re-resolved to `api_key_env_missing`.
  - All `executeRun` failure modes — propagated through the JobRecord but worker exits 0/2 the same way.
- Test refs:
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — search for `_run-worker`, `prompt sidecar`, cancel-while-queued cases. Layer 2 cites these under #16 follow-ups (#16 row in Table 2; reconcile + cancel-marker work).
  - `tests/unit/cancel-marker.test.mjs` — Layer 2 #22 sub-task 2.

---

## executeRun (shared body)

Called from foreground `cmdRun` / `cmdContinue` and from `_run-worker`. Source: `claude-companion.mjs:679-732`, `gemini-companion.mjs:568-612`, `kimi-companion.mjs:609-846`.

The kimi version inlines the body; claude/gemini factor it into helpers (`setupExecutionScopeOrExit`, `prepareMutationContext`, `exitIfCancelledBeforeSpawn`, `spawnClaudeOrExit` / `spawnGeminiOrExit`, `recordPostRunMutations`, `buildClaudeFinalRecord` / `buildGeminiFinalRecord`, `writeExecutionSidecars`, `exitIfFinalizationFailed`, `cleanupExecutionResources`).

Steps:

1. **Containment + scope setup**: `setupContainment(profile, cwd)` → ephemeral worktree for review modes, no-op for rescue. `populateScope(profile, cwd, containment.path, { scopeBase, scopePaths }, containment)`. On throw → errored JobRecord (scope_failed family), state.json upsert, foreground prints lifecycle, exit 2. State change: containment dir created.
2. **Mutation context**: when `profile.permission_mode === "plan"`, mkdtemp neutral cwd, snapshot `git status -s --untracked-files=all`, write `git-status-before.txt` sidecar. Failures push `mutation_detection_failed: <stderr first line>` entries onto `mutations[]` rather than failing the run.
3. **Runtime diagnostics** (claude only): `buildRuntimeDiagnostics(invocation, addDir, childCwd)` — captures `add_dir`, `child_cwd`, `scope_path_mappings`. Persisted on the JobRecord (`runtime_diagnostics` field, see [`docs/contracts/job-record.md`](../contracts/job-record.md)). Layer 2 #77 covers this contract.
4. **Pre-spawn cancel-marker check** — second consume site (the worker's preempt was the first). Guards the race window between worker preempt and dispatcher spawn. State change: cancelled JobRecord written, exit 0.
5. **Lifecycle emit (foreground only, when `lifecycleEvents === "jsonl"`)**: `externalReviewLaunchedEvent` printed via `printLifecycleJson` (`companion-common.mjs:25-33`). Background path emitted `launched` from the launcher already.
6. **Spawn target**: `spawnClaude(profile, runtimeInputs)` / `spawnGemini` / `spawnKimi`. Each:
   - Builds argv from profile + runtime inputs (see next section).
   - `sanitizeTargetEnv(env, { allowedApiKeyEnv })` strips provider env per [`docs/contracts/redaction.md`](../contracts/redaction.md).
   - `spawn(binary, args, { cwd, env: targetEnv, stdio })`. claude uses `["ignore", "pipe", "pipe"]` (prompt via `-p` argv). gemini and kimi use `["pipe", "pipe", "pipe"]` and `child.stdin.end(promptText)`.
   - `attachPidCapture(child, onSpawn)` — `lib/identity.mjs` — captures `{pid, starttime, argv0}` after `'spawn'` event. The `onSpawn` callback writes the running JobRecord (status=running, pid_info populated). Layer 2 #25 — `argv0_mismatch` race fix.
   - Wall-clock timer fires `SIGTERM` then 2s later `SIGKILL`, sets `timedOut = true`.
   - `child.on("close")` parses stdout via `parseClaudeResult` / `parseGeminiResult` / `parseKimiResult`, returns `{ exitCode, signal, timedOut, stdout, stderr, claudeSessionId|geminiSessionId|kimiSessionId, pidInfo, parsed }`.
   - **Variants of step 6**: gemini and kimi additionally loop over `modelCandidatesForInvocation` retrying capacity-limited failures (`gemini-companion.mjs:702-724`, `kimi-companion.mjs:687-728`); claude does not.
7. **Post-run mutation snapshot**: when plan, `git status -s --untracked-files=all` again, diff the lines, push deltas onto `mutations[]`, write `git-status-after.txt` sidecar. Failures append `mutation_detection_failed:`.
8. **Cancel-marker post-run check**: `consumeCancelMarker` returns true when `cmdCancel` wrote the marker before signaling. If true, the final JobRecord is forced to `status: "cancelled"` even when `exitCode === 0` (the SIGTERM-trap case — Layer 2 #22 sub-task 2; `lib/cancel-marker.mjs`).
9. **Build review audit manifest** (when invocation has `review_prompt_contract_version` and not rescue): `reviewAuditManifest(invocation, prompt, containmentPath, execution)` builds the persisted `review_metadata.audit_manifest` per [`docs/contracts/job-record.md`](../contracts/job-record.md) (Layer 2 #79).
10. **Build final JobRecord**: `buildJobRecord(invocation, executionTuple, mutations)` runs `classifyExecution` (`lib/job-record.mjs:161-258`) and emits the frozen 41-field record. Cancel-marker forces `status: "cancelled"` regardless of execution.
11. **Atomic commit**: `commitJobRecord(workspaceRoot, jobId, finalRecord)` — meta+state under one lock. Returns `{ metaError, stateError }`.
12. **Sidecars**: `stdout.log` and `stderr.log` (best-effort).
13. **Finalization-failure handling**: when `metaError` or `stateError`, `persistFinalizationFallback` writes a fallback errored record (with `errorMessage: "finalization_failed: <detail>"`) targeting only the side that failed (BLOCKER 1: don't clobber a successful meta with a state lock-timeout fallback). Then `cleanupExecutionResources` and `fail("finalization_failed", detail, { error_code })` exit 1.
14. **Cleanup**: `cleanupExecutionResources(executionScope, mutationContext)` removes neutral cwd; if `disposeEffective`, calls `containment.cleanup()`.
15. **Foreground print**: `printLifecycleJson(finalRecord, lifecycleEvents)`.
16. **Exit code**: 0 when `status` ∈ `{completed, cancelled}`, else 2.

---

## Provider call detail

argv assembly is the most variant step. The contract per provider:

### Claude (`plugins/claude/scripts/lib/claude.mjs:53-118` `buildClaudeArgs`)

- `-p <promptText>` — prompt is in argv (claude ignores stdin).
- `--output-format json` (always).
- `--no-session-persistence` (always).
- `--model <id> --effort max` when model present.
- `--resume <UUIDv4>` OR `--session-id <UUIDv4>` (mutex — passing both is rejected by claude).
- `--setting-sources ""` when `profile.strip_context` (review modes; rescue keeps user CLAUDE.md).
- `--permission-mode <plan|acceptEdits|...>` from profile.
- `--disallowedTools <space-joined>` when profile blocklist non-empty.
- `--add-dir <containmentPath>` when `profile.add_dir` AND `addDirPath` (review modes).
- `--json-schema <schema>` when `profile.schema_allowed` AND `jsonSchema` provided.
- session-id contract: claude requires UUID v4 — `isUuidV4` regex enforced at `lib/claude.mjs:18-20`.

### Gemini (`plugins/gemini/scripts/lib/gemini.mjs:18-53` `buildGeminiArgs`)

- `-p ""` (gemini takes prompt via stdin; argv carries an empty `-p` placeholder).
- `-m <id>` when model present.
- `--output-format json`.
- `--resume <id>` when resuming.
- For `permission_mode === "acceptEdits"`: `--approval-mode auto_edit --skip-trust`.
- Else (plan mode): `--policy <READ_ONLY_POLICY> --approval-mode plan --skip-trust`, AND `-s` only when **not** running inside Codex sandbox (`isCodexSandbox(env)`).
- `--include-directories <containmentPath>` when `profile.add_dir` AND `includeDirPath`.
- gemini does NOT support `--add-dir`.
- Layer 2 #56: nested-sandbox interaction matrix lives here.

### Kimi (`plugins/kimi/scripts/lib/kimi.mjs:17-58` `buildKimiArgs`)

- `--print --final-message-only --output-format stream-json --input-format text` (always — single-shot stream-json invocation).
- `--max-steps-per-turn <N>` (always; default 8 from profile, validated > 0).
- `-m <id>` when model present.
- `--thinking` (always).
- `--session <id>` when resuming.
- For `permission_mode === "acceptEdits"`: `--yolo`. Else: `--plan`.
- `--add-dir <containmentPath>` when `profile.add_dir` AND `includeDirPath`.

All three dispatchers call `sanitizeTargetEnv` per [`docs/contracts/redaction.md`](../contracts/redaction.md) before spawn. The `allowedApiKeyEnv` value comes from auth selection (claude/gemini); kimi passes nothing (no api-key allowance — subscription only).

Parsed-result shape per provider: see `parseClaudeResult` / `parseGeminiResult` / `parseKimiResult` (cited above). Differences feed `error_code` classification:
- claude `parsed.is_error` → `claude_error`.
- gemini `parsed.error != null` → `gemini_error`.
- kimi has special-case parsing for `step_limit_exceeded` (`STEP_LIMIT_RE` match) and `usage_limited` (regex over combined stdout/stderr), with `findStepLimitLine` for the case where the sentinel is mixed with other text (kimi.mjs:88-94, 137-148, 157-168). Layer 2 #41 / #52.

---

## Flow: `continue` (foreground or background)

- Entry: `cmdContinue` — `claude-companion.mjs:1030`, `gemini-companion.mjs:953`, `kimi-companion.mjs:960`.
- Argument validation:
  - `valueOptions: ["job", "cwd", "model", "binary", "auth-mode", "timeout-ms", "lifecycle-events"]` (kimi adds `max-steps-per-turn`; kimi omits `auth-mode`).
  - `booleanOptions: ["background", "foreground"]` mutex.
  - `--job` required → `bad_args`.
  - prompt required (positionals after `--`) → `bad_args`.
- Prelaunch checks:
  - `resolveJobFile` + read prior meta → `not_found` if missing, `bad_args` if parse fails.
  - `prior.status` must be in `CONTINUABLE_STATUSES` = `{completed, failed, cancelled, stale}` → `bad_state` otherwise.
  - **Provider session-id check** — variance: claude reads `prior.claude_session_id` falling back to legacy `prior.session_id`; gemini reads `prior.gemini_session_id` (no fallback); kimi reads `prior.kimi_session_id` (no fallback). Missing → `no_session_to_resume` with an actionable suggestion (re-run from scratch) when `prior.status === "stale"` (PR #21 review HIGH 4). Source: `claude-companion.mjs:1063-1077`, `gemini-companion.mjs:987-1000`, `kimi-companion.mjs:994-1007`.
  - Profile resolution: re-resolved via `resolveProfile(prior.mode_profile_name ?? prior.mode)`. The mode lineage carries through; you cannot continue a `review` job into `rescue` mode. `dispose_effective` carries from prior (so a one-shot `--override-dispose` persists across the chain).
  - `resume_chain = [...priorResumeChain, priorSessionId]` — newest-last. The LAST entry is what `executeRun` passes to spawnX as `resumeId`.
  - Auth re-resolution + timeout re-derivation (sidecar + audit-manifest fallback). Kimi additionally re-derives `max_steps_per_turn`.
- New invocation built with new `job_id` and `parent_job_id = options.job`. Frozen.
- Persistence (queued): same as `cmdRun`. Kimi additionally writes runtime-options sidecar here.
- Foreground branch: `executeRun(invocation, targetPrompt, { foreground: true, lifecycleEvents })`.
- Background branch: `validateBackgroundExecutionScopeOrExit` → `writePromptSidecar` + `writeRuntimeOptionsSidecar` → `spawnDetachedWorker` → `launched` event. Same shape as `cmdRun --background`.
- State mutations: identical to `cmdRun` plus the prior job's record is unaffected (the new job_id gets its own `jobs/<id>.json` directory and state.json entry).
- Failure modes:
  - `bad_args` / `bad_state` / `not_found` — at parse stage.
  - `no_session_to_resume` — pre-spawn; no JobRecord. Layer 2 #16 follow-up 4 covers stale-job continuability.
  - `not_authed` — pre-spawn, no JobRecord.
  - All `executeRun` failure modes for the new job.
- Test refs:
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — `continue` paths, including stale → continue, cancelled → continue (Layer 2 #16 follow-ups).

---

## Flow: `ping` (synonym `doctor`)

- Entry: `cmdPing` — `claude-companion.mjs:1265`, `gemini-companion.mjs:1208`, `kimi-companion.mjs:1234`. `case "doctor": return cmdPing(rest);` at `claude-companion.mjs:1550`, `gemini-companion.mjs:1439`, `kimi-companion.mjs:1471`.
- Argument validation:
  - `valueOptions: ["model", "binary", "timeout-ms", "auth-mode"]` (kimi omits `auth-mode`).
- Prelaunch checks:
  - `resolveProfile("ping")` — special profile, `add_dir: false`, `schema_allowed: false`, `strip_context: true`.
  - Model resolution: `--model` override OR `resolveModelForProfile(profile, loadModels())`. Gemini/kimi additionally compute `modelCandidates` for fallback.
  - Auth selection (claude/gemini). Kimi: no auth-mode handling, but `credentialNameDiagnostics(PING_PROVIDER_API_KEY_ENV, env)` exposes `ignored_env_credentials` and `auth_policy: "api_key_env_ignored"`.
  - `PING_PROVIDER_API_KEY_ENV`:
    - claude: `["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]` (`claude-companion.mjs:1177`).
    - gemini: `["GEMINI_API_KEY", "GOOGLE_API_KEY"]` (`gemini-companion.mjs:1118`).
    - kimi: `["KIMI_CODE_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]` (`kimi-companion.mjs:1125`).
- Provider call: `spawnClaude(profile, { model, promptText: PING_PROMPT, sessionId: newJobId(), cwd: process.cwd(), binary, timeoutMs, allowedApiKeyEnv })` (claude). Gemini/kimi loop over candidates with capacity-limited retry. `PING_PROMPT` literal: `"reply with exactly: pong. Do not use any tools, do not read files, and do not explore the workspace."` (`scripts/lib/companion-common.mjs:8-9`).
- Persistence: **none.** Ping is ephemeral; no JobRecord, no state.json entry, no sidecars. The synthetic `sessionId` from `newJobId()` is used purely to satisfy claude's UUIDv4 `--session-id` requirement.
- Output classification (claude reference, `claude-companion.mjs:1304-1334`):
  - Success (`parsed.ok && (parsed.result || parsed.structured)`) → `status: "ok"` JSON with `pingOkFields`, `model`, `session_id` (`claudeSessionId ?? sessionIdSent`), `cost_usd`, `usage`. Exit 0.
  - exit code != 0:
    - `/rate limit|429|overloaded/i` → `status: "rate_limited"` exit 2.
    - `PING_AUTH_RE` match → `status: "not_authed"` with hint differentiated by auth path. Exit 2.
    - else → `status: "error"`, `pingErrorFields`. Exit 2.
  - parsed result missing → `status: "error"`. Exit 2.
- Variance:
  - Gemini: tracks `modelFallback.hops` across the candidate loop and includes them in the `ok` payload when fallback occurred. `pingRateLimitedFields` updated to "every configured model candidate is currently rate-limited".
  - Kimi: extra classification statuses — `transient_timeout` (`execution.timedOut === true`, `kimi-companion.mjs:1289-1292`) and `sandbox_blocked` (`isKimiCodexSandboxBlocked(detail)` matched against `Operation not permitted|Permission denied|EACCES|EPERM` near `~/.kimi`, `kimi-companion.mjs:1183-1188`, `1222-1232`). Layer 2 #56.
  - All three: ENOENT on spawn → `status: "not_found"` with `pingNotFoundFields` and an `install_url`.
- State mutations: none.
- Failure modes (no JobRecord — these are ping-specific status strings):
  - `not_authed` (api_key_env_missing, or auth-pattern in detail).
  - `not_found` (binary missing).
  - `rate_limited`.
  - `error` (catch-all).
  - `transient_timeout` (kimi only).
  - `sandbox_blocked` (kimi only).
  - Layer 2 #77 — non-approval failure runtime diagnostics. The `models_ok_chat_400` failure mode mentioned in Layer 2 is grok-only, not companion.
- Test refs:
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — ping happy-path, not-authed, rate-limited; semantic match on the status strings. Layer 2 #20 covers the doctor-shape contract gap.
  - `tests/unit/auth-selection.test.mjs` — Layer 2 #27, #35.

---

## Flow: `status`

- Entry: `cmdStatus` — `claude-companion.mjs:1337`, `gemini-companion.mjs:1070`, `kimi-companion.mjs:1077`.
- Argument validation:
  - `valueOptions: ["job", "cwd"]`, `booleanOptions: ["all"]`.
  - No required positional. `--job` optional (single-job lookup).
- Prelaunch checks: `resolveWorkspaceRoot(cwd)`.
- **Reconciliation step**: `reconcileActiveJobs(workspaceRoot)` — `plugins/<plugin>/scripts/lib/reconcile.mjs:118-152`. Walks active records (queued/running), classifies orphans:
  - pid_info present + valid → `verifyPidInfo`. `process_gone` / `starttime_mismatch` / `argv0_mismatch` → stale.
  - pid_info missing/incomplete AND `started_at` older than `DEFAULT_ORPHAN_AGE_MS` (1h) → stale.
  - The `commitJobRecordsIfActive` CAS (`state.mjs:658-686`) holds the state lock around the read+classify+write so a worker's terminal commit landing mid-reconcile is detected (CAS rejects the builder call). Worker after reconcile simply overwrites the stale record with its terminal record. Layer 2 #16 follow-up 3.
  - `error_code === "stale_active_job"` (per [`docs/contracts/job-record.md`](../contracts/job-record.md)).
- Provider call: none.
- Output:
  - `--job <id>` form: print the matching record or `not_found`. State change: reconcile may have promoted the record to stale.
  - default form: `printJson({ workspace_root, jobs: filtered })` where `DEFAULT_STATUSES = {running, completed, failed, cancelled, stale}`. `--all` includes queued. `cancelled` and `stale` are continuable terminal states (#16 follow-ups 2/4) so they appear in the default view.
- State mutations: reconcile may write stale terminal records.
- Failure modes:
  - `not_found` — `--job` form, no match.
- Test refs:
  - `tests/unit/reconcile.test.mjs` — Layer 2 #25, #16.
  - `tests/unit/state.test.mjs` — Layer 2 #61 (stale-record cleanup).

---

## Flow: `result`

- Entry: `cmdResult` — `claude-companion.mjs:1367`, `gemini-companion.mjs:1094`, `kimi-companion.mjs:1101`.
- Argument validation: `--job` required → `bad_args`.
- Prelaunch checks: `resolveJobFile(workspaceRoot, options.job)` (assertSafeJobId guards the path); `existsSync` → `not_found`.
- Provider call: none.
- Persistence: read-only.
- Output: full meta JSON via `printJson(meta)`.
- Failure modes:
  - `bad_args` — missing `--job` or invalid jobId shape.
  - `not_found` — meta.json missing.
  - `read_failed` — `_readFileSync` threw (e.g., EISDIR when meta path was clobbered to a directory). PR #21 review MED 1. Source: `claude-companion.mjs:1387-1394`, `gemini-companion.mjs:1106-1113`, `kimi-companion.mjs:1113-1120`.
- Test refs:
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — `result` paths.

---

## Flow: `cancel`

- Entry: `cmdCancel` — `claude-companion.mjs:1405`, `gemini-companion.mjs:1307`, `kimi-companion.mjs:1339`. The architecture is the same across all three (Layer 2 #22 sub-task 1: gemini and kimi previously routed to `not_implemented`; the bodies are now mirrors).
- Argument validation:
  - `valueOptions: ["job", "cwd"]`, `booleanOptions: ["force"]`.
  - `--job` required → `bad_args`.
- Prelaunch checks:
  - `resolveWorkspaceRoot(cwd)`. `listJobs(workspaceRoot)`. Find by id → `not_found` if missing.
  - **Status branch**:
    - `completed/failed/cancelled/stale` → `already_terminal`, exit 0 (no-op, idempotent).
    - `queued` → `writeCancelMarker`. Marker IS the cancel mechanism; write failure must not report `cancel_pending` — exits with `cancel_failed` (`claude-companion.mjs:1433-1439`).
    - `running` → enter the signal path.
    - any other status → `bad_state`.
  - **Running path safety checks**:
    - `pidInfo` must exist with integer `pid`. Else `no_pid_info`, exit 2.
    - `pidInfo.starttime` and `pidInfo.argv0` must be present and `capture_error` falsy. Else `no_pid_info`, exit 2.
    - `verifyPidInfo(pidInfo)` (`lib/identity.mjs`) checks `{starttime, argv0}` against the live process via `ps` / `/proc`. Layer 2 #25 (the `argv0_mismatch` flake).
      - `match: true` → proceed.
      - `process_gone` → `already_dead`, exit 0.
      - `capture_error` → `unverifiable`, exit 2 (Issue #22 sub-task 3 — sandbox-denied / hidepid case).
      - `starttime_mismatch` / `argv0_mismatch` / `invalid` → `stale_pid`, exit 2.
- **Cancel-marker write before signal**: `writeCancelMarker(workspaceRoot, options.job)` — Issue #22 sub-task 2. The marker tells `executeRun`'s post-run consumer to override the JobRecord status to `cancelled` even when the target traps SIGTERM and exits 0. Marker write failure is best-effort here (the SIGTERM still goes through; we only lose the lifecycle override).
- Signal: `process.kill(pidInfo.pid, options.force ? "SIGKILL" : "SIGTERM")`. `ESRCH` → `already_dead` exit 0.
- Output: `{ ok: true, status: "signaled", signal, job_id, pid }` on success.
- Persistence: cancel marker file under the state dir's `.cancel/` subdir (`lib/cancel-marker.mjs`); no JobRecord write directly (`executeRun` will write the cancelled record on close).
- Failure modes:
  - `bad_args` / `not_found` / `bad_state` / `already_terminal` / `cancel_pending` / `cancel_failed`.
  - Running path: `no_pid_info` / `unverifiable` / `stale_pid` / `already_dead` / `signaled` / `signal_failed`.
- Test refs:
  - `tests/unit/cancel-marker.test.mjs` — Layer 2 #22, #16 follow-up 2.
  - `tests/unit/identity.test.mjs`, `tests/unit/identity-capture-error.test.mjs` — Layer 2 #25 (`argv0_mismatch` regression).
  - `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs` — search for `signaled`, `stale_pid`, `unverifiable`.

---

## What this architecture does NOT have

- **No tunnel.** There is no grok-style subscription tunnel. Each plugin spawns its provider's local CLI directly (`claude`, `gemini`, `kimi`). See [`docs/grok-subscription-tunnel.md`](../grok-subscription-tunnel.md) for the grok-specific tunnel; it does not apply here.
- **No direct HTTP.** Companion plugins never call provider APIs over HTTP from the companion process. That is api-reviewers' architecture (`plugins/api-reviewers/scripts/api-reviewer.mjs`); see [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md).
- **No output redaction.** Stdout/stderr from the spawned target are captured verbatim into `stdout.log`/`stderr.log` sidecars and into the JobRecord's `result` field. The defense is upstream: env-strip prevents secret-shaped values from reaching the child process. See [`docs/contracts/redaction.md`](../contracts/redaction.md) §1.
- **No state-transition event stream.** Lifecycle events are 0–2 named launch markers per run (`external_review_launched`, `launched`), plus the final JobRecord. There is no `running` event, no `cancelled` event. See [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md).
- **No prompt persistence.** `prompt_head` is the first 200 chars; the full prompt lives only in the worker handoff sidecar `jobs/<id>/prompt.txt` (mode 0600), which is unlinked on first read. Defense in depth: `assertInvocation` (`lib/job-record.mjs:418-424`) throws if a `prompt` field is passed into `buildJobRecord`. §21.3.1.
- **No separate review/custom-review/adversarial-review/rescue subcommands.** All flow through `cmdRun --mode <X>` with profile-driven divergence; there are no `cmdReview` / `cmdAdversarialReview` / `cmdCustomReview` / `cmdRescue` functions.
- **No scope byte cap.** Companion plugins do not refuse a scope based on size. The 1 MiB cap from #83 is grok-only; api-reviewers has its own preflight estimate. Layer 2 #83.
- **No api-key fallback for kimi.** kimi is subscription-only; api-key env vars are surfaced as `ignored_env_credentials` only. Compare with claude/gemini, which accept `--auth-mode subscription|api_key_env`.
- **No `--isolated` / `--dispose` / `--no-dispose` flags.** These were retired (`claude-companion.mjs:21-24`). Containment and scope are per-profile decisions in `lib/mode-profiles.mjs`. The only escape hatch is `--override-dispose <bool>`, intentionally undocumented.
- **No `cmdReview` / `cmdAdversarialReview` / `cmdCustomReview` / `cmdRescue` aliases at the dispatch table** — only the eight subcommands listed at the top of this doc.
