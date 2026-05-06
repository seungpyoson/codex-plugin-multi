# JobRecord — companion-plugin output contract

**Applies to:** `claude`, `gemini`, `kimi` only. **Does not apply to** `grok` or `api-reviewers` — see [`grok-output.md`](./grok-output.md) and [`api-reviewers-output.md`](./api-reviewers-output.md).

**Canonical source:** `plugins/{claude,gemini,kimi}/scripts/lib/job-record.mjs` — three byte-identical copies, asserted by `tests/unit/job-record.test.mjs:150-153` ("provider EXPECTED_KEYS stay byte-for-byte aligned").

**Schema version:** `10` — exported as `SCHEMA_VERSION` from each plugin's `job-record.mjs`. All three are required to match (`tests/unit/job-record.test.mjs:71-75`).

**Spec reference:** §21.3 in repo design spec (referenced by source comments).

## Field list (`EXPECTED_KEYS`)

The JobRecord is a frozen object whose key set is exactly these 41 fields, in this order. Persisted JSON does not rely on order; order matters for the EXPECTED_KEYS array used by tests. Any addition or removal triggers a test failure (`tests/unit/job-record.test.mjs:133-148`, "EXPECTED_KEYS is the spec §21.3 canonical list").

### Identity

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (UUID-ish) | Legacy alias for `job_id`. To be dropped in T8 per source comment (`job-record.mjs:43`). |
| `job_id` | `string` | UUID or `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` (validated by `SAFE_JOB_ID` regex in `companion-common.mjs:93`). |
| `target` | `"claude" \| "gemini" \| "kimi"` | The plugin name. |
| `parent_job_id` | `string \| null` | For continued runs; `null` on initial run. |
| `claude_session_id` | `string \| null` | UUID; populated only when `target === "claude"` AND execution captured one. |
| `gemini_session_id` | `string \| null` | Same, for gemini. |
| `kimi_session_id` | `string \| null` | Same, for kimi. |
| `resume_chain` | `string[]` | Defaults to `[]` if not provided. Lineage of resumed jobs. |
| `pid_info` | `{ pid: number, starttime: string, argv0: string } \| null` | Captured when target spawns. Used by source-transmission classification. |

### Invocation

| Field | Type | Notes |
|---|---|---|
| `mode` | `string` | e.g. `"review"`, `"adversarial-review"`, `"custom-review"`, `"run"`. |
| `mode_profile_name` | `string` | Profile config key. |
| `model` | `string` | Resolved model id (e.g. `"claude-haiku-4-5-20251001"`). |
| `cwd` | `string` (absolute path) | Workspace cwd at invocation. |
| `workspace_root` | `string` (absolute path) | Repo root. |
| `containment` | `string` | e.g. `"worktree"`, `"none"`. |
| `scope` | `string` | e.g. `"branch-diff"`, `"working-tree"`, `"custom"`. |
| `dispose_effective` | `boolean` | Defaults to `false`. |
| `scope_base` | `string \| null` | git ref for branch-diff scope. |
| `scope_paths` | `string[] \| null` | For custom scope. |
| `prompt_head` | `string` | First ≤200 chars of prompt. **Full prompt MUST NOT be persisted** (§21.3.1; enforced by `assertInvocation` in `job-record.mjs:418-424`). Throws if invocation contains a `prompt` field. |
| `review_metadata` | `object \| null` | Set when `review_prompt_contract_version` provided. Sub-keys: `prompt_contract_version`, `prompt_provider`, `scope`, `scope_base`, `scope_paths`, `raw_output: { stdout_bytes, stderr_bytes, parsed_ok, result_chars }`, `audit_manifest`. |
| `schema_spec` | `object \| null` | For structured-output runs. |
| `binary` | `string` | Resolved binary path (e.g. `"claude"`, `"gemini"`, `"kimi"`). |

### Lifecycle

See [the `status` enum](#status-enum) and [the `error_code` enum](#error_code-enum) below.

| Field | Type | Notes |
|---|---|---|
| `status` | enum | One of `queued`, `running`, `completed`, `cancelled`, `failed`, `stale`. See enum table. |
| `started_at` | ISO-8601 string | Captured at cmdRun entry. |
| `ended_at` | ISO-8601 string \| `null` | Set when execution terminal AND status !== "running". |
| `exit_code` | `number \| null` | Target CLI exit code. |
| `error_code` | enum \| `null` | See `error_code` enum table. `null` only when `status` is `completed` or `cancelled` or `queued` or `running`. |
| `error_message` | `string \| null` | Human-readable raw error. |
| `error_summary` | `string \| null` | One-line operator summary (only populated for some failure modes). |
| `error_cause` | `string \| null` | Operator-facing cause text. |
| `suggested_action` | `string \| null` | Operator-facing remediation. |
| `external_review` | `object` (frozen) | The external_review sub-record. See [`external-review.md`](./external-review.md). |
| `disclosure_note` | `string \| null` | Source-transmission disclosure note (only set when `error_code === "scope_failed"`). |
| `runtime_diagnostics` | `object \| null` | When provided: `{ add_dir, child_cwd, scope_path_mappings: [{original, contained, relative, inside_add_dir}], permission_denials: [{tool, target, inside_add_dir, relative_to_add_dir}] }`. |

### Result

| Field | Type | Notes |
|---|---|---|
| `result` | `string \| null` | Target CLI result text. May be present even on failure (`job-record.mjs:617`, "Readable stdout can still ride along on a failure"). |
| `structured_output` | `object \| null` | Parsed structured output when schema run. |
| `permission_denials` | `array` | Verbatim from `parsed.denials`; empty array when not provided. |
| `mutations` | `string[]` | Git-status lines or `mutation_detection_failed:...` entries from T7.2 detection. |
| `cost_usd` | `number \| null` | When provider reports it. |
| `usage` | `object \| null` | Provider-specific shape (`{ input_tokens, ... }` for claude; `{ totalTokenCount, ... }` for gemini). |

### Bookkeeping

| Field | Type | Notes |
|---|---|---|
| `schema_version` | `10` | Bumped when fields are added/removed. |

## `status` enum

Six values, classified deterministically by `classifyExecution(execution)` in `job-record.mjs:161-258`:

| Value | When | Notes |
|---|---|---|
| `queued` | `execution === null` | Pre-execution / pre-worker (background launch). |
| `running` | `execution.status === "running"` | Target spawned but not terminal. `pid_info` populated. |
| `completed` | `exitCode === 0 AND parsed.ok === true` | Happy path. `error_code === null`. |
| `cancelled` | `execution.status === "cancelled"` (forced override) OR signal in `{SIGTERM, SIGKILL, SIGINT, SIGHUP}` AND `timedOut === false` | Operator cancel intent (issue #22 sub-task 2). `error_code === null`. **`exit_code` and `result` are preserved** even when forced (a target that traps SIGTERM and exits 0 with valid JSON still classifies as `cancelled`). |
| `stale` | `execution.status === "stale"` | Orphan reconciliation produced a terminal record (#16 follow-up 3). `error_code === "stale_active_job"`. |
| `failed` | Anything else | See `error_code` enum below. |

**Status precedence rules:**

- `running` overrides any other input.
- `cancelled` (forced) overrides `exitCode` and `parsed` — a target that handles SIGTERM and exits 0 still classifies as `cancelled` (`tests/unit/job-record.test.mjs:280-304`).
- `stale` overrides `errorMessage` (orphan recon path).
- `errorMessage` triggers `failed` with classification by message prefix.
- `timedOut === true` forces `failed/timeout` regardless of signal (`tests/unit/job-record.test.mjs:989-1003`).
- `signal in CANCEL_SIGNALS` AND `timedOut === false` triggers `cancelled` (`tests/unit/job-record.test.mjs:970-987`).

## `error_code` enum

| Value | When | Plugins |
|---|---|---|
| `null` | `status` is `completed`, `cancelled`, `queued`, or `running` | all |
| `scope_failed` | `errorMessage` starts with one of `unsafe_symlink:`, `scope_population_failed:`, `scope_base_invalid:`, `scope_base_missing:`, `scope_requires_git:`, `scope_requires_head:`, `scope_paths_required:`, `scope_empty:`, `invalid_profile:` (see `SCOPE_FAILURE_PREFIXES` in `job-record.mjs:260-270`) | all companion |
| `spawn_failed` | `errorMessage` set AND not a scope failure AND not a finalization failure | all companion |
| `finalization_failed` | `errorMessage` starts with `finalization_failed:` | all companion. Distinguished from `spawn_failed` so monitoring routing on error_code doesn't conflate disk-full / lock-timeout with missing-binary (PR #21 review HIGH 1). |
| `timeout` | `execution.timedOut === true` (wall-clock kill) | all companion |
| `parse_error` | `parsed.ok === false` AND `parsed.reason in {json_parse_error, empty_stdout}` | all companion |
| `claude_error` | `target === "claude"` AND parsed/exit indicates target failure | claude only |
| `gemini_error` | `target === "gemini"` AND parsed/exit indicates target failure | gemini only |
| `kimi_error` | `target === "kimi"` AND parsed/exit indicates target failure | kimi only |
| `step_limit_exceeded` | Kimi parsed.reason === "step_limit_exceeded" | kimi only (issue #41 / #52) |
| `usage_limited` | Kimi parsed.reason === "usage_limited" | kimi only |
| `stale_active_job` | `execution.status === "stale"` | all companion (orphan recon) |

Note: `*_error` is the catch-all per plugin — emitted when the target exited non-zero but no other classification matched.

**Targeted operator diagnostics** (the `error_summary`, `error_cause`, `suggested_action`, `disclosure_note` fields) are populated by `buildErrorDiagnostic` in `job-record.mjs:276-406` only for `scope_failed` codes today; other failures leave these fields null. Kimi adds plugin-specific diagnostics for `timeout`, `step_limit_exceeded`, and `usage_limited` (per `tests/unit/job-record.test.mjs:1005-1069`).

## `external_review` sub-record

See [`external-review.md`](./external-review.md) for the full contract — keys, source-transmission classification, disclosure templates. The 12-key sub-record is built by `externalReviewForInvocation` (`job-record.mjs:115-129`) and frozen.

## Defense in depth

1. **No full `prompt` field** — `assertInvocation` throws if invocation carries a `prompt` field (`job-record.mjs:418-424`). §21.3.1 forbids persisting prompt text. Tests at `tests/unit/job-record.test.mjs:1189-1199`.
2. **Frozen output** — every JobRecord is `Object.freeze`d so consumers cannot mutate fields (`tests/unit/job-record.test.mjs:1183-1187`).
3. **Key-set drift detection** — `buildJobRecord` verifies the constructed key set against `EXPECTED_KEYS` and throws on extras or missing fields (`job-record.mjs:588-596`).
4. **Schema-version aligned** across providers — three plugins must match (`tests/unit/job-record.test.mjs:71-75`).
5. **Skill doc parity** — `tests/unit/job-record.test.mjs:1354-1365` requires every `EXPECTED_KEYS` entry to be mentioned in `plugins/claude/skills/claude-result-handling/SKILL.md` so docs cannot drift from schema.

## Test surface

`tests/unit/job-record.test.mjs` (1391 lines) covers:

- Key-set parity across claude/gemini/kimi
- Every `status` value path
- Every `error_code` classification path
- Pre-spawn cancel vs post-spawn cancel (different transmission disclosure)
- Signal-driven exit (SIGTERM/SIGKILL/SIGINT/SIGHUP) classification
- `timedOut === true` precedence over signal
- Runtime diagnostics population including malformed-input normalization
- Frozen-output guarantee
- Defense-in-depth `prompt` rejection
- Skill doc parity scan
- External-review SKILL ASCII box alignment

This is the de-facto contract test. Any new property-based test for JobRecord shape duplicates this surface and should reference it.
