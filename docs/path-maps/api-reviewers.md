# api-reviewers — end-to-end path map

**Plugin:** `plugins/api-reviewers/` — single Node script `scripts/api-reviewer.mjs` (1830 lines).
**Architecture:** synchronous, single-process, direct-HTTP via `fetch()` to an OpenAI-compatible `/chat/completions` endpoint. **No subprocess spawn**, **no background mode**, **no separate worker**.
**Providers covered:** `deepseek` and `glm` — same code path, configuration-only divergence (see [§ Provider divergence](#provider-divergence)).

Cross-references:

- Output schema and error_code enum: [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md)
- `external_review` sub-record + `source_content_transmission`: [`docs/contracts/external-review.md`](../contracts/external-review.md)
- `external_review_launched` event: [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md)
- Output-time redaction: [`docs/contracts/redaction.md`](../contracts/redaction.md)
- Test archaeology and closed-issue regression coverage: [`docs/closed-issue-failure-modes.md`](../closed-issue-failure-modes.md)

> **Line-number caveat.** The contract docs cite line numbers from the originating commit. The numbers below were re-verified against `plugins/api-reviewers/scripts/api-reviewer.mjs` at the spec branch; where they differ from the contract docs, the path-map number is what the file actually has today.

---

## Top-level dispatch

- **Entry point:** `plugins/api-reviewers/scripts/api-reviewer.mjs:1801` (`main()`).
- Argv parsed via `parseArgs()` (`:514`) with `assertSafeOptionKey()` (`:542`) blocking `__proto__` / `prototype` / `constructor`.
- Dispatch (`:1804-1822`):
  - `doctor` or `ping` → `cmdDoctor` (`:1687`).
  - `run` → `cmdRun` (`:1701`).
  - `help`, `--help`, `-h` → loads `providers.json`, prints `{ ok, commands: ["doctor","ping","run"], providers: [...] }` (`:1806-1820`).
  - Anything else → throws `unknown_command:<cmd>`; outer `try/catch` (`:1825-1830`) prints `{ ok: false, error }` and exits 1.
- **Commands NOT present:** `status`, `result`, `cancel`, `list`. The plugin persists state to disk (`~/.codex-plugin-data/api-reviewers/` by default — see [§ Persistence](#persistence)) but exposes no CLI surface to inspect, list, or cancel jobs. Operators read `meta.json` directly.

---

## Provider divergence

Source: `plugins/api-reviewers/config/providers.json`. Same `cmdRun` / `callProvider` path serves both.

| Field | DeepSeek | GLM |
|---|---|---|
| `display_name` | `DeepSeek` | `GLM` |
| `auth_mode` | `api_key` | `api_key` |
| `env_keys` | `["DEEPSEEK_API_KEY"]` | `["ZAI_API_KEY", "ZAI_GLM_API_KEY"]` (first match wins via `selectedCredential` `:605-612`) |
| `base_url` | `https://api.deepseek.com` | `https://api.z.ai/api/coding/paas/v4` |
| `model` | `deepseek-v4-pro` | `glm-5.1` |
| `max_prompt_chars` | `600000` | `600000` |
| `request_defaults.thinking` | `{ type: "enabled" }` | `{ type: "enabled" }` |
| `request_defaults.reasoning_effort` | `"max"` | (unset) |
| `request_defaults.max_tokens` | `65536` | `131072` |

Both endpoints are appended with `/chat/completions` at `:1230` — `baseUrlFor()` (`:760`) strips trailing slashes from `base_url` first.

---

## Flow: `run` (`review` / `custom-review` / `adversarial-review`)

`cmdRun` (`:1701-1799`) is the single entry for every `--mode` value. The mode string only changes the system-line in the rendered prompt.

### 1. Argument parsing and validation

- `parseLifecycleEventsMode(options["lifecycle-events"])` (`:106`) — accepts `null` / `false` / literal `"jsonl"`, throws `runBadArgs("--lifecycle-events must be jsonl")` otherwise (`:109`). Called inside `cmdRun` try-block at `:1713`.
- `--provider` required: missing → `runBadArgs("bad_args: --provider is required")` (`:1714`).
- `--mode` validated against `VALID_MODES = {"review","adversarial-review","custom-review"}` (`:21`); unknown → `runBadArgs("bad_args: unsupported --mode <mode>")` (`:1715`).
- `--prompt` required: empty/whitespace-only → `providerFailure("bad_args", "prompt is required (pass --prompt <focus>)", null, null, false)` (`:1750`). Note: this fires **after** scope is collected (the `prompt` text is bundled into the rendered prompt via `promptFor()` `:1112`). Cited in CLAUDE.md and PR #91 (closed: reject valueless reviewer prompts).
- Argv keys with reserved names → `parseArgs` throws (`:542-546`) — uncaught in `cmdRun`'s try-block, surfaces to outer `try/catch` as a generic `{ok:false, error}` rather than a JobRecord. (Edge case; happy-path arg keys never trigger.)

**State at this stage:** `jobId = job_<uuid>` already minted at `:1706`; `startedAt` ISO timestamp captured (`:1705`).

### 2. Config resolution

- `loadProviders()` (`:548`) reads `PROVIDERS_PATH = <plugin_root>/config/providers.json` (resolved at `:20`) and `JSON.parse`s it.
- Read or parse failure → wrapped via `runConfigError` (`:1718-1720`), `error_code = "config_error"`. Suggested action at `:1429` ("Reinstall or repair plugins/api-reviewers/config/providers.json and retry.").
- `providerConfig(providers, name)` (`:552`) looks up the provider:
  - Unknown provider → `Error("unknown_provider:<name>")` (`:554`); rethrown via `runBadArgs` (`:1723`), so `error_code = "bad_args"`.
  - Unsupported `auth_mode` → `Error("unsupported_auth_mode:<mode>")` (`:556`); same `runBadArgs` wrapping. (Both providers ship with `api_key`, so this is a misconfiguration safeguard.)
- `fallbackProviderConfig(provider)` (`:561-570`) provides a stub config when scope/preflight fails before `cfg` is bound (used at `:1733` to keep the JobRecord shape stable).

### 3. Preflight (`validateDirectApiRunPreflight` `:653`)

Run twice — once eagerly at `:1726` to fail fast with a uniform error path, then again inside `callProvider` (`:1227`) just before fetch.

Validates, in order:
1. `auth_mode` is `api_key` or `auto` (`:654`) → else `bad_args`.
2. `parseMaxTokensOverride(env)` from `API_REVIEWERS_MAX_TOKENS` (`:627`) → `bad_args` if non-positive integer.
3. `parseMaxPromptCharsOverride(env)` from `API_REVIEWERS_MAX_PROMPT_CHARS` (`:631`) → `bad_args` if invalid.
4. `parseProviderTimeoutMs(env)` from `API_REVIEWERS_TIMEOUT_MS` (`:635`) — **default 600000 ms (10 minutes)** when env var is absent. Note: contract docs cite "120s default"; the actual default in this file is `600000` at `:637`. Issue #86 unified the per-plugin timeout; #88 made it configurable. → `bad_args` if invalid.
5. **Credential resolution** via `selectedCredential(cfg, env)` (`:605`) — iterates `cfg.env_keys` in order, returns the first env var with non-empty string value. **Only the env-key name is passed forward** at the JobRecord level (`credential_ref`); the value flows into the request only.
   - No matching env var with non-empty value → `{ ok: false, reason: "missing_key", error: "<display_name> API key is not available" }` (`:674-679`).
   - In `cmdRun`, if reason is not `bad_args`, this is rethrown via `runProviderFailure` (`:1728`), bypassing the scope step entirely.
6. `applyRequestDefaults` probe (`:681-688`) — checks every key in `cfg.request_defaults` against `ALLOWED_REQUEST_DEFAULT_KEYS = {"thinking","reasoning_effort","max_tokens","top_p","stop"}` (`:89`). Disallowed key → `bad_args:disallowed_request_default:<key>`.

Pre-PR-#88 behaviour: timeout was hardcoded; the unified `*_REVIEW_TIMEOUT_MS` naming asymmetry is documented in the contract docs as a spec gap.

### 4. Scope resolution (`collectScope` `:1053`)

Only invoked when preflight passes. Produces:

- `cwd` — resolved from `options.cwd` or `process.cwd()` (`:1054`).
- `workspaceRoot` — `git rev-parse --show-toplevel` via `git()` helper (`:828`); falls back to `cwd` (`:1055`).
- `scope` from `scopeName(options)` (`:954`) — `--scope` value, or `"custom"` if `mode === "custom-review"`, else `"branch-diff"`.
- `selectedScopePaths(scope, options, cwd)` (`:966`):
  - **`custom`**: requires `--scope-paths`; throws `scope_paths_required` (`:969`) → `error_code = "scope_failed"` via the catch at `:1762`.
  - **`branch-diff`**: `safeScopeBase()` (`:958`) rejects empty / whitespace / leading-`-` base refs as `scope_base_invalid:` (`:961`) — that's the "option-shaped --scope-base" defense from PR #95. Then `git diff -z --name-only <base>...HEAD --` (`:974`) is filtered through `--scope-paths` glob patterns via `matchGlob()` (`:873`). Empty selection → `scope_empty: branch-diff selected no files` (`:980`); suggested action at `:1416` calls out HEAD-vs-base committed-only semantics.
  - Other scope name → `unsupported_scope:<scope>` (`:983`).

Per-file reading:

- `branch-diff` reads from git history via `readGitScopeFiles()` (`:998`):
  - `git cat-file -s HEAD:<path>` (`:1004`) reports blob bytes; > `MAX_SCOPE_FILE_BYTES = 256 KiB` (`:35`) → `scope_file_too_large:<path>:<n> bytes exceeds 262144 byte limit` (`:1011`).
  - `git show HEAD:<path>` retrieves content (`:1013`).
- `custom` reads from filesystem via `readFilesystemScopeFiles()` (`:1024`):
  - `validateScopePath()` (`:986`) rejects `..`, absolute paths, backslashes, control chars, and any path that escapes the workspace via `realpath()` round-trip (`:1029-1043`) — `unsafe_scope_path:<rel>`.
  - Symlinks rejected outright (`:1037`).
  - `readUtf8ScopeFileWithinLimit()` (`:897`) opens with `O_NOFOLLOW`, verifies `dev/ino` identity match against pre-open `lstat` (`:910` — TOCTOU defense), and bails at `MAX_SCOPE_FILE_BYTES` (`:913, 925`).
- `addScopeFile()` (`:941`) accumulates totals and enforces `MAX_SCOPE_TOTAL_BYTES = 1 MiB` (`:36`) → `scope_total_too_large:<n> bytes exceeds 1048576 byte limit` (`:949`). Issue #83 ("oversized branch-diff scopes before provider launch") landed this preflight byte-count.
- Empty selection after reads → `scope_empty: selected files are missing or empty` (`:1020, :1049`).

Any throw inside `collectScope` is caught in `cmdRun` at `:1730`. The catch sets `cfg = fallbackProviderConfig(provider)` (`:1733`) if not yet bound, and assembles a degenerate `scopeInfo` from the raw options, then synthesizes `execution = { exitCode: 1, parsed: { ok:false, reason, error: redact(e.message) }, payload_sent: false }` (`:1742`). This is the source of `error_code = "scope_failed"` for non-`bad_args` / non-`config_error` paths (`error.apiReviewersReason ?? "scope_failed"` at `:1732`).

### 5. Prompt rendering and budget

Only reached when scope succeeded. At `:1754-1764`:

- `promptFor(mode, options.prompt ?? "", scopeInfo, cfg.display_name)` (`:1112`):
  - Picks adversarial vs standard system line (`:1113-1115`).
  - Bundles the live-context paragraph (`:1116-1121`) — explicitly tells the model not to reject `deepseek-v4-pro` / `glm-5.1` because those IDs may not be in its public-doc training set.
  - Wraps each scope file with collision-resistant `BEGIN ... / END ...` delimiters via `fileContentDelimiter()` (`:1092`) — appends `#` until unique up to 100 attempts, else `scope_delimiter_collision:<path>` (`:1100`).
  - Calls shared `buildReviewPrompt()` (`scripts/lib/review-prompt.mjs:252`) which appends the 6-item `REVIEW_PROMPT_CHECKLIST` (`:3`) and output-requirements block.
- `validateRenderedPromptBudget()` (`:710`) compares `prompt.length` against `maxPromptCharsFor(cfg, env)` (`:692`). Order: env override `API_REVIEWERS_MAX_PROMPT_CHARS` > `cfg.max_prompt_chars` (600000 for both providers) > `DEFAULT_MAX_PROMPT_CHARS = 600000` (`:37`). Over-budget → `scope_failed: prompt_too_large:<n> chars exceeds <display_name> max_prompt_chars=<m>` (`:719`). Suggested action at `:1421` recommends narrower scope or sharded `custom-review`.
- Throws inside `promptFor` (delimiter collision) → wrapped as `scope_failed` (`:1763`).

### 6. `external_review_launched` event emission

Only when `lifecycleEvents === "jsonl"` AND scope+budget passed AND no synthetic execution was set above. At `:1768-1776`:

- `buildLaunchExternalReview({ cfg, mode, options: runOptions, scopeInfo })` (`:1477`):
  - Builds the 12-key `external_review` per `EXTERNAL_REVIEW_KEYS` (shared `lib/external-review.mjs:20`).
  - `source_content_transmission: SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT` (`:1490`).
  - `disclosure: "Selected source content may be sent to <display_name> for external review."` (`:1491`).
  - `freezeExternalReview()` (`:1459`) asserts key drift before `Object.freeze`.
- Printed via `printLifecycleJson({event, job_id, target, status:"launched", external_review}, "jsonl")` (`:1768-1775`).
- **Negative emission**: never emitted on `bad_args`, `config_error`, `missing_key`, `scope_failed`, or any prompt-budget failure — control flow at `:1748-1766` skips the launch event when `execution` is already populated. Verified per [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md) and the smoke citation in api-reviewers-output.md (no-launch-on-prelaunch-failure).

### 7. Provider call (`callProvider` `:1226`)

Re-runs `validateDirectApiRunPreflight` at `:1227` (defense in depth — a stale env between top-of-`cmdRun` and here would now classify properly).

Builds the request:

```
POST <base_url>/chat/completions
Content-Type: application/json
Authorization: Bearer <credential.value>     // :1268-1271
{
  "model": cfg.model,
  "messages": [{ "role": "user", "content": prompt }],
  "temperature": 0,
  ...applyRequestDefaults(cfg.request_defaults),   // :1236
  "max_tokens": <override or cfg default or 4096>  // :1246-1250
}
```

- `applyRequestDefaults` enforces the `ALLOWED_REQUEST_DEFAULT_KEYS` whitelist (`:89`) — disallowed key → `bad_args:disallowed_request_default:<key>` (`:1238`). DeepSeek's `reasoning_effort: "max"`, GLM's larger `max_tokens`, and both providers' `thinking: { type: "enabled" }` flow through this whitelist.
- Timeout enforced via `AbortController` + `setTimeout(controller.abort, timeoutMs.value)` (`:1261-1262`), cleared in `finally` (`:1329`).
- **Mock branch:** `env.API_REVIEWERS_MOCK_RESPONSE` short-circuits to `mockProviderExecution` (`:1170`) before any fetch — used by smoke tests; produces `mock_assertion_failed` (`:1180, 1184, 1188-1199`) and `malformed_response` (`:1205, 1208`) without a network round-trip.
- Real fetch at `:1266`. Response body read as text (`:1275`) then `parseJson()` (`:1356`).

### 8. Response parsing and HTTP failure classification

- `!response.ok` → `classifyHttpFailure(response.status, parsed)` (`:1372`) wrapped in `providerFailureWithDiagnostics`:

  | Condition | `error_code` |
  |---|---|
  | `status === 401 \|\| 403` (`:1374`) | `auth_rejected` |
  | `status === 429` (`:1375`) | `rate_limited` |
  | `status ∈ {408,409,425,500,502,503,504}` OR error JSON matches `/capacity\|resource\|overload\|unavailable/i` (`:1376-1378`) | `provider_unavailable` |
  | Anything else | `provider_error` (`:1379`) |

- `parseJson` failure on a 2xx body → `malformed_response` with the parse-error message (`:1287-1288`).
- `parsed.value?.choices?.[0]?.message?.content` not a string → `malformed_response: response did not include choices[0].message.content` (`:1290-1299`).
- Network/abort exceptions caught at `:1315`:
  - `e.name === "AbortError"` → `timeout` (`:1316`); `payload_sent: true` because the request body was already on the wire (`payloadSentForProviderException` at `:1346-1347` returns `true` for AbortError).
  - Else → `provider_unavailable` with `payloadSentForProviderException` returning `false` for `ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`/`EHOSTUNREACH`/`ENETUNREACH` (`:1349-1351`), or `null` otherwise (`:1353`).
  - The diagnostics object includes `elapsed_ms` for the timeout case (`:1325`).
- **Suggested-action mapping:**
  - `provider_unavailable` + Codex sandbox + network-shaped error → `providerUnavailableSuggestedAction` (`:1403`) returns the `network_access = true` instructions including a fresh-session retry.
  - `timeout` → "Retry later, increase API_REVIEWERS_TIMEOUT_MS, or switch reviewer provider." (`:1433`).
  - `scope_failed` → branch-specific guidance via `scopeFailedSuggestedAction` (`:1414`).

Issue #77 (reviewer runtime logs / repros for non-approval failures) drove the `runtime_diagnostics`-style content embedded in `error_summary` and `review_metadata.raw_output`.

Successful path:
```js
return {
  exitCode: 0,
  parsed: { ok: true, result: content, usage, raw_model },
  session_id: safeProviderSessionId(parsed.value?.id),  // :1341 — strict /^[A-Za-z0-9._:/=+@-]{1,200}$/
  http_status,
  credential_ref: credential.keyName,                   // env-key NAME, never the value
  endpoint: baseUrlFor(cfg),
  diagnostics: { ... },
}
```
(`:1301-1314`)

### 9. Output redaction (CRITICAL — echo-attack defense)

- `redactor(env, configuredSecretNames)` (`:725`) and `redactValue(value, redact)` (`:745`).
- Patterns matched:
  1. **Configured secrets** — values of env vars in `cfg.env_keys`, when length ≥ 4 chars (note: `MIN_SECRET_REDACTION_LENGTH = 8` is the auto-detected threshold; configured names use a lower 4-char floor — see `:731`). Replaced with literal `[REDACTED]`.
  2. **Auto-detected secret env vars** — names matching `/(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY)$/` (`:732`) with values ≥ `MIN_SECRET_REDACTION_LENGTH = 8` (`:91`) — so a one-char `DEEPSEEK_CREDENTIAL="a"` does not corrupt structured fields by replacing every `a`.
  3. **`Authorization:` headers** — `/Authorization:\s*\S.*$/gim` → `Authorization: [REDACTED]` (`:739`).
  4. **`Bearer` tokens** — `/Bearer\s+\S+/gi` → `Bearer [REDACTED]` (`:740`).
- **Where applied:**
  - `result` and `error_message` redacted in `buildRecord` (`:1592-1594`).
  - Whole record redacted via `redactRecord(buildRecord(...), process.env, cfg.env_keys)` (`:1786-1795`) **before** stdout print **and** before `meta.json` write — guarantees the persisted artifact does not contain secrets.
  - `providerErrorMessage` (`:1364`) redacts both parsed-error JSON and raw error-body text (truncated to 800 chars).
  - Network exception messages redacted at `:1319`.
  - Persistence-failure detail redacted at `:1679` so a failed `meta.json` write cannot leak via `disclosure_note`.
- **Echo-attack semantics:** there is **no separate `error_code` for an echo-attack**. If a malicious provider returns a response containing the caller's API key, the redactor strips it from `result` (and from any error message body) before either stdout or disk persistence. The threshold of 8 chars (auto-detected) / 4 chars (configured) is the only knob — there is no out-of-band signaling. See [`docs/contracts/redaction.md`](../contracts/redaction.md) §3.
- **Why this is the only defense:** unlike companion plugins (which use `sanitizeTargetEnv` to drop matching keys from the spawned child's env block before the subprocess starts), api-reviewers makes the request in-process. The credential is in `Authorization: Bearer <key>` on the wire. Output-time redaction is the **sole** mechanism preventing a provider response from leaking the caller's key into stdout/JobRecord/`meta.json`.

### 10. Persistence (`persistRecord` `:1665` and `persistRecordBestEffort` `:1674`)

State directory layout:
- Root: `apiReviewerDataRoot(env) = env.API_REVIEWERS_PLUGIN_DATA ?? ".codex-plugin-data/api-reviewers"` (`:124`). Note: contract docs cite `~/.codex/api-reviewers/`; the actual default path on this branch is `.codex-plugin-data/api-reviewers/` resolved relative to `cwd`.
- `<root>/state.json` — index file (`apiReviewerStateFile()` `:132`).
- `<root>/jobs/<job_id>/meta.json` — per-job record (`:266-268`).
- `<root>/.state.lock/owner.json` — primary lock (`API_REVIEWER_STATE_LOCK_DIR` `:27`).
- `<root>/.state.lock.gate/owner.json` — second-stage gate to serialize stale-reclaim (`:28`).

#### Lock acquisition (`withApiReviewerStateLock` `:390`)

Two-stage lock with cross-host owner detection:

1. **Acquire gate** via `acquireApiReviewerStateLockGate(root, deadline)` (`:358`):
   - `mkdir(.state.lock.gate)` is the atomic claim. EEXIST → call `tryReclaimStaleApiReviewerStateLock` (`:313`) and retry.
   - On success, write owner JSON `{ pid, hostname, startedAt, token }` (`:366-371`).
2. **Acquire primary lock**:
   - `mkdir(.state.lock)` (`:402`). EEXIST → reclaim; on failure, release gate and retry-loop (`:404-422`).
   - On success, write owner JSON to `.state.lock/owner.json` (`:424-429`).
   - Release the gate while still holding the primary lock (`:430`).
3. Run `fn()` under the primary lock; release in `finally` via `releaseApiReviewerStateLock` (`:351`).
4. Configurable timeout via `API_REVIEWERS_STATE_LOCK_TIMEOUT_MS` (default 5000ms — `:30, :303-306`).

#### Cross-host owner check (`tryReclaimStaleApiReviewerStateLock` `:313`)

Refuses to reclaim a lock held by **another host** (`:325`). Same-host reclaim path:
- Reads `owner.json`. If the owner's PID is alive on this host (`isProcessAlive` `:140`) → not reclaimable (`:329`).
- If the owner's PID is dead OR the lock age exceeds `API_REVIEWERS_STATE_LOCK_STALE_MS` (default 30000ms `:31, :308-311`) → safe to reclaim.
- Reclaim is a `rename(lockDir, lockDir.orphaned-<pid>-<ts>-<uuid>)` (`:337`), then a re-read of the orphan's `owner.json` content. If the bytes don't match what was read pre-rename, another reclaimer raced — put the orphan back via `rename` (`:340`) and bail. Otherwise `rm -r` the orphan (`:343`).

This three-step (read raw → rename → re-read) sequence is the live-host vs dead-host vs racing-reclaimer disambiguation. Smoke tests assert it heavily ("direct API reviewer persistence" / "lock" titles per [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md)).

#### Job pruning (`pruneJobs` `:149`)

- Sort jobs descending by `updatedAt` / `ended_at` / `endedAt`, with original-index as tiebreak (`:151-156`).
- Active jobs (`status ∈ {"queued","running"}` per `ACTIVE_JOB_STATUSES` `:26`) are **always retained** (`:160`).
- Terminal jobs are kept only up to `MAX_RETAINED_API_REVIEWER_JOBS = 50` (`:25, :161`). Anything beyond is deleted via `removeApiReviewerJobDir` (`:449`) and `removeApiReviewerJobTmpFiles` (`:468`) in `updateApiReviewerStateForRecord` (`:493-512`).
- The pruning explicitly **does not delete active jobs**, so a stuck running record is never silently garbage-collected.

#### Atomic writes

- `writeApiReviewerState` (`:251`) and `writeApiReviewerMetaRecord` (`:264`) use `<file>.<pid>.<ts>[.<uuid>].tmp` + `rename` for crash-consistency. The meta.json write opens with `mode: 0o600` (`:271`) so the persisted artifact is owner-only readable.

#### `persistRecordBestEffort` semantics

`cmdRun` calls `persistRecordBestEffort` (`:1674-1685, :1796`). If `persistRecord` throws (lock timeout, disk error, etc.), the function **does not** alter `error_code` or `status`; it appends a redacted persistence-failure note to `disclosure_note` and returns the (in-memory) record so the operator still sees their review result. Persistence is best-effort relative to the print path.

### 11. Final record assembly (`buildRecord` `:1590`)

- `completed = execution.exitCode === 0 && execution.parsed?.ok === true` (`:1591`).
- `redact = redactor(process.env, cfg.env_keys)` (`:1592`).
- `result = completed ? redact(execution.parsed.result) : null` (`:1593`).
- `error_message = completed ? null : redact(execution.parsed?.error ?? "")` (`:1594`).
- `error_code = completed ? null : (execution.parsed?.reason ?? "provider_error")` (`:1595`) — this is the canonical fallback when an exception path didn't set a reason.
- `external_review` rebuilt with `directApiTransmission(completed, payload_sent)` (`:1453`) and `directApiDisclosure(...)` (`:1439`):
  - `completed === true` OR `payloadSent === true` → `SENT`.
  - `payloadSent === false` → `NOT_SENT`.
  - Else → `UNKNOWN`.
- `freezeRecord(record)` (`:1468`) asserts the 47-key order against `API_REVIEWER_EXPECTED_KEYS` (`:39-88`) and `Object.freeze`s the result. **Any drift throws** — caught only by the outer `try/catch` (`:1825`), which emits a degenerate `{ok:false, error}` (no JobRecord shape) — operationally a hard failure. `SCHEMA_VERSION = 10` (`:23`).
- `error_summary` for `timeout` is enriched with diagnostics (`diagnosticErrorSummary` `:1513`): `timeout after <ms>ms configured_timeout_ms=<m> selected_files=<n> selected_bytes=<n> selected_chars=<n> prompt_chars=<n> estimated_tokens=<n> max_tokens=<n>`.
- `review_metadata` includes the full `audit_manifest` from `buildReviewAuditManifest` (`scripts/lib/review-prompt.mjs:181`) — content-hashed source files, `request.timeout_ms`, `request.max_tokens`, prompt-builder `contract_version`/`plugin_commit`, and `review_quality.{has_verdict,has_blocking_section,has_non_blocking_section,checklist_items_seen,looks_shallow,failed_review_slot}` (`review-prompt.mjs:140-164`). Issues #74/#79 drove this.

### 12. Output and exit

- `printLifecycleJson(printableRecord, lifecycleEvents)` (`:1797`) — pretty-print when `lifecycleEvents` is `null`/`false`, single-line JSON when `"jsonl"`.
- `process.exit(record.status === "completed" ? 0 : 1)` (`:1798`).
- The exit status is observable; smoke tests parse stdout for the JobRecord rather than relying on the exit code alone.

### 13. Failure-mode index for `run`

| `error_code` | Source line(s) | Closed-issue cross-ref |
|---|---|---|
| `bad_args` | `:1714, 1715, 1727, 1750`, request-defaults probe `:1238`, lifecycle parse `:109`, `parseArgs` reserved keys `:544` | #91 (reject valueless reviewer prompts) |
| `config_error` | `:1719` | (general — see redaction docs for providers.json error path) |
| `missing_key` | preflight `:677`, surfaced at `cmdRun:1728` | (lifecycle: doctor surfaces same condition) |
| `scope_failed` | `:1732` (catch), `:1759` (prompt budget), `:1763` (prompt-rendering throw) | #83 (oversized branch-diff scopes), #95 (option-shaped `--scope-base`) |
| `auth_rejected` | `classifyHttpFailure :1374` | n/a (issued #94/#100 reverted Claude OAuth classification — DeepSeek/GLM use API-key auth so 401/403 maps directly) |
| `rate_limited` | `:1375` | n/a |
| `provider_unavailable` | `:1376-1378`, network exception `:1316` | #56 (sandbox network-access guidance baked into suggested action) |
| `provider_error` | `:1379, :1595` (fallback) | n/a |
| `malformed_response` | `:1208, 1288, 1298` | n/a |
| `timeout` | exception path `:1316`; suggested action `:1433` | #41 (Kimi timeout diagnostics — same diagnostic-format pattern), #86 (unified timeout config), #88 (`API_REVIEWERS_TIMEOUT_MS`) |
| `mock_assertion_failed` | `:1180, 1184, 1193` | (test infra only — never produced in production) |

---

## Flow: `doctor` (and alias `ping`)

`cmdDoctor(options)` (`:1687-1699`).

### 1. Argument validation

- No `parseArgs` validation beyond reserved-key check; `--provider` extracted from `options.provider`.

### 2. Config resolution

- `loadProviders()` at `:1691` — read failure → `printJson(providersConfigErrorFields(e, provider ?? null))` and `process.exit(1)` (`:1693-1695`). The error fields include `status: "config_error"`, `ready: false`, plus the redacted error message via `providersConfigErrorMessage` (`:590`).
- `--provider` missing → throws `Error("bad_args: --provider is required")` (`:1696`); caught by outer handler (`:1825`), emitted as plain `{ok:false,error}` rather than a doctor record.
- Unknown provider → `providerConfig` throws `unknown_provider:<name>` (`:554`); same outer-catch treatment.

### 3. Doctor record (`doctorFields` `:766`)

Pure function over `(provider, cfg, env)`:

- Calls `selectedCredential(cfg, env)` (`:767`) — looks up env-key NAMES, never returns or persists the value beyond a length check.
- `endpoint = baseUrlFor(cfg)` (`:768`).
- Branches:
  - `auth_mode` not in `VALID_AUTH_MODES` → `{ status: "config_error", ready: false, summary: "<display> direct API auth mode is unsupported.", next_action, auth_mode, endpoint }` (`:769-779`).
  - No credential → `{ status: "missing_key", ready: false, summary: "<display> direct API key is not available.", next_action: "Expose one of these key names to Codex: <env_keys>.", auth_mode, credential_candidates: cfg.env_keys, endpoint }` (`:780-790`).
  - Otherwise → `{ status: "ok", ready: true, summary: "<display> direct API reviewer is ready using <env_key_name>.", next_action: "Run a direct API review.", auth_mode, credential_ref: credential.keyName, endpoint, model: cfg.model }` (`:792-802`).

### 4. Credential-value policy

- `selectedCredential` returns `{ keyName, value }` but `doctorFields` only ever reads `credential.value` for the truthiness check (`:780`) and `credential.keyName` for output (`:799`). The credential **value** is never printed, never persisted, and never echoed.
- No HTTP probe is performed. Doctor is purely a local readiness check — issue #20's "setup-check should be bounded and not exploratory" is satisfied structurally.

### 5. Output and exit

- `printJson(doctorFields(provider, cfg))` (`:1698`).
- Exit code is whatever `process.exit` was called with — `0` on `ok`, `1` only when `loadProviders()` failed (`:1694`). `missing_key` and `config_error` (auth_mode) produce a `ready:false` record but exit `0` since `process.exit` isn't called on those branches. (Operationally: the JSON `status` field is the contract, not the exit code.)

### 6. Per-provider divergence

Identical path; only `cfg.display_name`, `cfg.env_keys`, `cfg.base_url`, and `cfg.model` differ. A doctor run for `glm` reports both `ZAI_API_KEY` and `ZAI_GLM_API_KEY` as `credential_candidates`; a `deepseek` doctor reports `DEEPSEEK_API_KEY` only.

---

## Flows: `status`, `result`, `cancel`, `list`

**These commands do not exist in api-reviewers.**

- `main()` dispatch (`:1801-1822`) only routes `doctor` / `ping` / `run` / `help`. Anything else → `unknown_command:<cmd>` (`:1822`) → outer catch (`:1825`) prints `{ok:false, error:"unknown_command:<cmd>"}` and exits 1.
- The plugin **does** maintain a job index at `<root>/state.json` and per-job `meta.json` artifacts (see [§ Persistence](#persistence)), so the building blocks for status/result/cancel/list exist on disk — but no CLI surface exposes them.
- Operators inspecting past jobs read `<root>/jobs/<job_id>/meta.json` directly, or scan `<root>/state.json` for the summary list. There is no concept of cancelling an in-flight `run` — the process is synchronous, so `Ctrl-C` aborts it locally and the on-disk record is whatever survived the lock window.
- This is consistent with the plugin's "no background mode" architecture: there is no separate worker to query, signal, or list.

---

## Flow: background mode

**Not supported.** Explicit per [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md) §"Implications for the matrix":

> No `background` mode — api-reviewers is synchronous. Background-mode rows are categorically uncoverable.

`cmdRun` does the entire fetch in the foreground process (`:1778`) and exits when the JobRecord is printed. The persistence layer is for crash-consistency and reconciliation across concurrent foreground runs, not for handing work to a worker.

---

## Persistence — full reference {#persistence}

Recapping the locking + pruning surface from § Run step 10 in one place.

### State files

| Path | Writer | Format |
|---|---|---|
| `<root>/state.json` | `writeApiReviewerState` (`:251`) | `{ version: 1, jobs: [<summary>...] }` — pruned to ≤50 terminal entries. |
| `<root>/jobs/<job_id>/meta.json` | `writeApiReviewerMetaRecord` (`:264`) | Full 47-key JobRecord, mode 0600. |
| `<root>/.state.lock/owner.json` | gate-and-primary lock (`:424`) | `{ pid, hostname, startedAt, token }` |
| `<root>/.state.lock.gate/owner.json` | gate stage (`:366`) | same shape |
| `<root>/.state.lock.orphaned-<pid>-<ts>-<uuid>` | reclaim transient (`:335`) | renamed orphan; deleted on success or renamed back on race |

### Lifecycle of a successful run

1. `loadApiReviewerState` (`:168`) merges `state.json` with on-disk `jobs/*/meta.json` discovered via `discoverApiReviewerDiskJobs` (`:223`) — recovers from a missing/corrupt `state.json`.
2. `summarizeApiReviewerJobRecord` (`:186`) projects the JobRecord to the 9-field summary stored in `state.json`. Drops records that fail `assertSafeJobId` (`:118`) or whose `job_id`/`id` mismatch the directory.
3. `mergeApiReviewerJobs` (`:209`) deduplicates by job id, preferring the in-state-file copy.
4. `persistRecord` (`:1665`) writes `meta.json` first **without** the lock (so a successful review's artifact is durable even if state-lock acquisition times out), then re-writes meta and updates `state.json` under the lock.

### Concurrent-run safety

- Two `run` invocations on the same machine race for the gate; whichever wins the `mkdir(.state.lock.gate)` proceeds, the other polls every `API_REVIEWER_STATE_LOCK_POLL_MS = 25` (`:29`) until `deadline`.
- Two `run` invocations on different machines using a shared mount: `tryReclaimStaleApiReviewerStateLock` refuses to reclaim a lock whose `owner.hostname` differs from `os.hostname()` (`:325`). The remote host's lock is honored until it ages past `API_REVIEWERS_STATE_LOCK_STALE_MS` (default 30s).
- A dead local owner (`isProcessAlive(owner.pid) === false`) is reclaimed without waiting for the stale window (`:331-333`).

### Pruning interactions

- Pruning runs every successful `persistRecord` (via `updateApiReviewerStateForRecord` `:493`), comparing the new merged set against the previous on-disk job dirs.
- A stale `queued`/`running` record cannot be pruned by another `run` — `isActiveJob` (`:112`) gates retention. (api-reviewers itself never persists `queued`/`running`; those statuses appear only if a future writer adopts them. The retention rule is forward-compatible.)

### Issue #49 — installed-plugin layout

The contract for path resolution is at the top of `api-reviewer.mjs`:

```js
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));   // :18
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");                 // :19
const PROVIDERS_PATH = resolve(PLUGIN_ROOT, "config/providers.json");  // :20
```

All sibling-helper imports go through `./lib/*.mjs` (`:10-16`) which are synced **into the installed plugin**, not imported from a sibling repo path. That's the resolution issue #49 fixed: api-reviewers must be self-contained when installed. See [`docs/closed-issue-failure-modes.md`](../closed-issue-failure-modes.md) Table 1 for the regression-test path (`tests/unit/plugin-copies-in-sync.test.mjs` and the smoke "installed package layout" cases).

---

## Cross-cutting state mutations summary

| Step | Mutation |
|---|---|
| Argv parse | `options` populated; `jobId` minted; `startedAt` captured (`:1705-1707`). |
| Preflight ok | `cfg`, `credential` (in-memory only), `timeoutMs`, override values bound. |
| Scope ok | `scopeInfo` populated with cwd, workspaceRoot, scope, file blobs. |
| Prompt rendered | `renderedPrompt` string. Budget violation overwrites `execution`. |
| Lifecycle event | stdout JSON line emitted; no on-disk side effect. |
| Provider call ok | `execution = { exitCode:0, parsed:{ok,result,usage,raw_model}, session_id, http_status, credential_ref, endpoint, diagnostics }`. |
| Provider call failed | `execution = { exitCode:1, parsed:{ok:false,reason,error,raw}, http_status, payload_sent, diagnostics }`. |
| Record built | 47-key frozen object; redacted whole-record. |
| Persist | `<root>/jobs/<job_id>/meta.json` written (mode 0600); under lock, `<root>/state.json` rewritten. Pruning may delete other terminal job dirs. Lock files created/released. |
| Output | Final JobRecord (or lifecycle line) printed; `process.exit(0|1)`. |

---

## Test-archaeology references

(Per [`docs/closed-issue-failure-modes.md`](../closed-issue-failure-modes.md) — do not duplicate test paths; consult the source.)

- **#39** — full smoke surface for both providers (`tests/smoke/api-reviewers.smoke.test.mjs`, ~2.6k lines).
- **#49** — installed-plugin layout: `tests/smoke/api-reviewers.smoke.test.mjs` "installed package layout" cases + `tests/unit/plugin-copies-in-sync.test.mjs`.
- **#77** — runtime diagnostics & non-approval failures: shared diagnostics surface across smoke + `tests/unit/job-record.test.mjs`.
- **#83** — oversized branch-diff scopes: smoke "scope_total_too_large" cases + `tests/unit/scope.test.mjs`.
- **#86 / PR #88** — unified timeout configuration: `API_REVIEWERS_TIMEOUT_MS` exercised in smoke.
- Lifecycle-event negative emission (no `external_review_launched` on prelaunch failures): smoke citation per [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md) §"Test surface".
- Echo-attack redaction + one-byte collision protection: smoke citations per [`docs/contracts/redaction.md`](../contracts/redaction.md) §"Test surface".

---

## What api-reviewers does NOT have vs companion / grok

- **No JobRecord uniformity with companion plugins.** The 47-key shape (`API_REVIEWER_EXPECTED_KEYS` `:39-88`) extends the 41-key companion JobRecord with `provider`, `auth_mode`, `credential_ref`, `endpoint`, `http_status`, `raw_model`. A single shared schema check across all five plugins is therefore not possible — the contract is "shape-compatible, key-set divergent." See [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md).
- **No `background` mode.** Synchronous fetch only; no spawned worker; no `launched` background-event variant; no `pid_info` (always `null` at `:1623`); no `running`/`queued`/`stale`/`cancelled` status values reachable from `cmdRun` (`status` is always `completed` or `failed` at `:1638` per [`docs/contracts/api-reviewers-output.md`](../contracts/api-reviewers-output.md) §"Status enum").
- **No env-strip pre-launch (`sanitizeTargetEnv`).** Companion plugins drop matching keys from the spawned child's env; api-reviewers has no child. The `ANTHROPIC_*` / `CLAUDE_CODE_USE_*` / `OPENAI_*` strip surface is **categorically inapplicable** here.
- **No subprocess spawn for the provider call.** `git` and `git rev-parse` shell out for scope resolution (`:828`) but the provider request is in-process `fetch()` (`:1266`). Result: no env-isolation boundary between the calling process and the credential. Output-time redaction is the only defense.
- **No `claude_session_id`/`gemini_session_id`/`kimi_session_id` semantics.** Those keys exist in the schema (`:46-48`) but are always `null` in api-reviewers output (`:1619-1621`) — they are present for shape compatibility with the companion JobRecord, not because api-reviewers consumes companion sessions.
- **No `pid_info` capture.** Always `null` (`:1623`). The `argv0_mismatch` class of failures (issue #25) is companion-only.
- **No `containment`/`dispose_effective`/`schema_spec`/`binary` semantics.** Set to `"none"` / `false` / `null` / `null` (`:1629-1637`) — present for shape compatibility only. There is no worktree, no dispose, no binary path.
- **No CLI commands beyond `run`/`doctor`/`ping`/`help`.** No `status`, `result`, `cancel`, `list`, `cleanup`, `reconcile`. Operators read `meta.json` directly.
- **No structured-output, no permission_denials, no mutations, no cost_usd.** All set to `null` / `[]` (`:1651-1654`) — these are companion-CLI artifacts (claude/gemini/kimi parsing), not direct-HTTP artifacts.
