# grok plugin — end-to-end path map

**Scope:** every command path through `plugins/grok/scripts/grok-web-reviewer.mjs` (the review entrypoint) and `plugins/grok/scripts/grok-sync-browser-session.mjs` (the credential-import entrypoint).

**Architecture:** single-process, synchronous. The reviewer talks directly to a local `grok2api` HTTP tunnel (default `http://127.0.0.1:8000/v1`) which forwards to grok.com using browser-session cookies imported by the sync helper. **No spawned worker, no companion-common, no background mode.**

**Cross-references:**
- Output schema: [`docs/contracts/grok-output.md`](../contracts/grok-output.md)
- `external_review` sub-record: [`docs/contracts/external-review.md`](../contracts/external-review.md)
- Lifecycle event: [`docs/contracts/lifecycle-events.md`](../contracts/lifecycle-events.md)
- Redaction surface: [`docs/contracts/redaction.md`](../contracts/redaction.md)
- Closed-issue archaeology: [`docs/closed-issue-failure-modes.md`](../closed-issue-failure-modes.md)

---

## Top-level dispatch

- Entry: `grok-web-reviewer.mjs:1494-1515` (`main()`).
- Command parsing: `parseArgs()` `:104-130`. Strips `__proto__`/`prototype`/`constructor` keys via `assertSafeOptionKey()` `:132-136`.
- Recognized commands (`:1497-1513`): `doctor`, `ping` (alias of doctor), `run`, `result`, `list`, `help` / `--help` / `-h`.
- **Not present**: `status`, `cancel`, `background`, `resume` — see "What grok does NOT have" section.
- Unknown command throws `unknown_command:<cmd>` (`:1514`); top-level `runCli()` `:1517-1529` catches, prints `{ ok:false, error: ... }` redacted, exits 1.
- All argument-validation `bad_args:` thrown errors are caught at `:1521-1523`, printed as `{ ok:false, error_code: "bad_args", error_message: <redacted> }`.

---

## Constants and config (referenced by every flow)

- `VALID_MODES` `:16` — `{"review", "adversarial-review", "custom-review"}`.
- `DEFAULT_BASE_URL` `:17` — `http://127.0.0.1:8000/v1`.
- `DEFAULT_MODEL` `:18` — `grok-4.20-fast`.
- `DEFAULT_TIMEOUT_MS` `:19` — 600000 (10 min); env override `GROK_WEB_TIMEOUT_MS` (#86, see `closed-issue-failure-modes.md` row #86 — naming asymmetry vs companion `*_REVIEW_TIMEOUT_MS`).
- `DEFAULT_DOCTOR_TIMEOUT_MS` `:20` — 2000 ms; env `GROK_WEB_DOCTOR_TIMEOUT_MS` (models probe).
- `DEFAULT_CHAT_DOCTOR_TIMEOUT_MS` `:21` — 10000 ms; env `GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS` (chat probe).
- `DEFAULT_MAX_PROMPT_CHARS` `:22` — 400000; env `GROK_WEB_MAX_PROMPT_CHARS`.
- **`MAX_SCOPE_FILE_BYTES` `:23` — 256 KiB per file (#83).**
- **`MAX_SCOPE_TOTAL_BYTES` `:24` — 1 MiB total (#83).**
- `GIT_SHOW_MAX_BUFFER_BYTES` `:25` — 16 MiB ceiling on `git show` stdout.
- `MAX_STATE_JOBS` `:26` — 50 (state.json index cap).
- `STATE_LOCK_STALE_MS` `:27` — 60 s (lock reclamation threshold).
- `SCHEMA_VERSION` `:28` — `10`.
- `MIN_SECRET_REDACTION_LENGTH` `:29` — 8 chars (echo-attack threshold).
- `GIT_BINARY` / `GIT_SAFE_PATH` `:30-31` — fixed `/usr/bin/git` and `/usr/bin:/bin` for spawned git.
- `config(env)` `:144-162` — loads runtime config; positive-integer env validation via `parsePositiveIntegerEnv()` `:180-188` raises `bad_args:` for non-integer or non-positive values.
- `fallbackConfig(env)` `:164-178` — used in `cmdRun` when full `config()` itself raised `bad_args:` from a malformed env var, so a record can still be built. Same shape but uses constant defaults.

---

## Flow: `run` (review / adversarial-review / custom-review)

### Entry
- `cmdRun(options)` `:1415-1492`. Single function — no fork, no spawn.
- `mode = options.mode ?? "review"` `:1416`.
- `jobId = "job_" + randomUUID()` `:1420` (so `^job_[0-9a-f-]{36}$` per `safeJobId()` `:1309-1314`).
- `startedAt = new Date().toISOString()` `:1418`.

### 1. Argument validation
- `parseLifecycleEventsMode(options["lifecycle-events"])` `:98-102, 1425` — accepts `null`/`false`/`"jsonl"`; any other value throws `bad_args: --lifecycle-events must be jsonl`.
- `cfg = config()` `:1426` — env-var validation can raise `bad_args:` (e.g., `GROK_WEB_TIMEOUT_MS=foo`).
- `VALID_MODES.has(mode)` `:1427` — unsupported mode raises `bad_args: unsupported --mode <mode>`.
- Prompt presence: `hasPromptText()` `:559-561`, checked at `:1442-1444`. Missing/blank `--prompt` → `bad_args` with message `"prompt is required (pass --prompt <focus>)"`.
- Failure path: caught at `:1429-1440` — `cfg ??= fallbackConfig()`, `scopeInfo` reconstructed from raw flags, `execution = providerFailure("bad_args" | "scope_failed", ...)` (whichever the message starts with).
- `scope-base` shape check: `safeScopeBase()` `:334-340` — rejects empty, non-string, or `-`-prefixed values with `scope_base_invalid:`.
- `scope-paths` shape check (custom-review): `selectedScopePaths()` `:343-346` — empty list throws `scope_paths_required: custom-review requires --scope-paths`. (Internally classifies as `scope_failed` — message starts with neither `bad_args:` nor a recognised prefix; falls through to `scope_failed` at `:1455`.)

### 2. Scope resolution
- `collectScope(options)` `:505-526` — invoked at `:1428`.
- `cwd = resolve(options.cwd ?? process.cwd())` `:506`.
- `workspaceRoot = git rev-parse --show-toplevel` `:507`, falls back to `cwd` if not a git repo.
- `scopeName(options)` `:330-332` — picks `"custom"` when `mode === "custom-review"`, else `"branch-diff"`.
- **branch-diff path** (`:348-357`):
  - `safeScopeBase(options["scope-base"] ?? "main")` `:349`.
  - `git diff -z --name-only <base>...HEAD --` `:350` (NUL-separated to survive odd filenames).
  - `splitGitPathList()` `:302-304` then optional glob filter via `matchGlob()` `:306-328` against `--scope-paths` (treated as include patterns).
  - Empty list → `scope_empty: branch-diff selected no files` `:356`.
  - File reads via `readGitScopeFiles()` `:430-454` — uses `git cat-file -s <ref>:<path>` for size pre-check, then `git show` (capped at 16 MiB stdout buffer). Skips missing blobs (`allowFailure: true`). Empty list after read → `scope_empty: selected files are missing or empty` `:452`.
- **custom-review path** (`:343-347`):
  - `splitScopePaths(options["scope-paths"])` `:344` — comma- or newline-separated; trimmed.
  - File reads via `readFilesystemScopeFiles()` `:456-483`:
    - `lstat()` then reject symbolic links `:469-471`.
    - `realpath()` re-validation against `realWorkspaceRoot` `:472-476` (TOCTOU containment).
    - `readUtf8ScopeFileWithinLimit()` `:387-428` opens with `O_RDONLY | O_NOFOLLOW` `:33`, re-`stat`s the open fd, compares device+inode via `sameFileIdentity()` `:1139-1141` (defends a window between `lstat` and `open`).
- **Per-file size limit** `:377-379, 403-405, 411-413, 418-420, 442-444` — exceeding `MAX_SCOPE_FILE_BYTES` (256 KiB) throws `scope_file_too_large:<path>: <bytes> bytes exceeds <limit> byte limit` (#83).
- **Total size limit** `:380-383` — running total accumulator in `addScopeFile()`; exceeding `MAX_SCOPE_TOTAL_BYTES` (1 MiB) throws `scope_total_too_large:<bytes> bytes exceeds <limit> byte limit` (#83).
- Path safety: `validateScopePath()` `:362-372` rejects `..`, absolute paths, backslash, control chars, and any post-resolve path that escapes the workspace root. Symlink also rejected at `:469-471`.
- `repositoryIdentity()` `:528-533` — runs `git remote get-url origin`, regex-extracts `owner/repo`; falls back to workspace root if no remote.
- Error handling: any thrown `scope_*`, `unsafe_scope_path:`, `scope_invalid_git_blob_size:`, `git_failed:`, or `unsupported_scope:` falls into the `catch` at `:1429`. Message-prefix match decides between `bad_args` (only if literally starts `bad_args:`) and `scope_failed` (everything else; the original sub-code is preserved inside the message but the reason field is normalised to `scope_failed`).

### 3. Prompt construction & budget gate
- `promptFor(mode, options.prompt ?? "", scopeInfo)` `:535-557, 1449`.
  - Adversarial vs review modeline `:536-538`.
  - Files concatenated as `BEGIN GROK FILE N: <path>` / `END ...` blocks via `promptFileBlock()` `:496-503`. Delimiter collision-resolved by `fileContentDelimiter()` `:485-494` (appends `#` up to 100 attempts; throws `scope_delimiter_collision:<path>` if collision can't be resolved).
  - Wrapped through shared `buildReviewPrompt()` (synced from `scripts/lib/review-prompt.mjs`) with `provider: "Grok Web"` and a `subscription_web` disclosure note in `extraInstructions`.
- **Prompt budget** `:1450-1453` — if `prompt.length > cfg.max_prompt_chars`, set `execution = providerFailure("scope_failed", "prompt_too_large:<chars> chars exceeds GROK_WEB_MAX_PROMPT_CHARS=<budget>", null, null, false)` and attach `execution.prompt = prompt` so `audit_manifest` can still be rendered.
- Suggested action for `prompt_too_large` is matched by message regex in `suggestedAction()` `:872-874`.

### 4. Lifecycle event emission
- Conditional on `lifecycleEvents === "jsonl"` AND scope success AND prompt within budget (`:1457-1466`).
- Builder: `buildLaunchExternalReview({ cfg, mode, options, scopeInfo })` `:912-926` — keys validated against `EXTERNAL_REVIEW_KEYS` by `freezeExternalReview()` `:894-901` and frozen.
- `source_content_transmission: SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT` `:924` (race window: bytes haven't crossed the wire yet).
- Event shape: `{ event: "external_review_launched", job_id, target: "grok-web", status: "launched", external_review: <12 keys> }` `:1459-1465`.
- Printer: `printLifecycleJson(obj, lifecycleEvents)` `:93-96` → `printJsonLine` (`:89-91`) when mode is `"jsonl"`.
- **Negative-emission cases** (no event emitted): `bad_args` (any cause), any `scope_failed` (including `prompt_too_large`), any `cfg ??= fallbackConfig()` path. See [`lifecycle-events.md`](../contracts/lifecycle-events.md) "Negative-emission conditions".
- Verified emit site documented at `lifecycle-events.md:43`.

### 5. HTTP call to local tunnel
- `callGrokTunnel(cfg, prompt, env)` `:648-746`, invoked at `:1467`.
- Endpoint: `${cfg.base_url}/chat/completions` `:649`.
- Request body `:650-655`: `{ model, stream: false, messages: [{role:"user", content: prompt}], temperature: 0 }`. **No `max_tokens` set** — `null` propagated through diagnostics.
- Headers `:656-657`: `content-type: application/json`; `authorization: Bearer <cfg.credential_value>` only when `GROK_WEB_TUNNEL_API_KEY` is set in env (`config()` `:159-160`).
- `AbortController` + `setTimeout(controller.abort, cfg.timeout_ms)` `:659-660` (clears in `finally` `:743-745`).
- `fetch(endpoint, {method:"POST", headers, body, signal})` `:663-668`.
- Response always `await response.text()` then `parseJson(text)` `:567-573, 669-670`.

### 6. Response parsing
Outcome decision tree in `callGrokTunnel`:
- **HTTP non-OK** `:671-687` — returns `providerFailureWithDiagnostic()` with reason from `classifyHttpFailure(response.status)` `:591-596`:
  - 401, 403 → `session_expired`.
  - 429 → `usage_limited`.
  - ≥500 → `tunnel_error`.
  - other (e.g., 400 in `callGrokTunnel`, but see chat-doctor for 400 special-casing) → `tunnel_error`.
  - `payload_sent: true` (bytes did reach tunnel; got a status code back).
  - Diagnostics include `configured_timeout_ms`, `elapsed_ms`, `endpoint_class: "chat_completions"`, `model`, `stream`, `message_count`, `prompt_chars`.
- **HTTP OK but JSON parse fail** `:689-696` → `malformed_response` with `parsed.error` as message; `payload_sent: true`.
- **HTTP OK + JSON OK but no `choices[0].message.content` string** `:697-712` → `malformed_response` with literal message `"response did not include choices[0].message.content"`; `payload_sent: true`.
- **Success** `:714-733` — returns `{ exitCode: 0, parsed: {ok:true, result, usage, raw_model}, session_id: safeSessionId(parsed.value?.id), http_status, credential_ref, endpoint, diagnostics }`.
  - `safeSessionId()` `:643-646` — only accepts `^[A-Za-z0-9._:/=+@-]{1,200}$`; otherwise `null`. Defends against control-char or quote injection in `external_review.session_id`.
- **Fetch threw** `:734-742`:
  - `e.name === "AbortError"` → `tunnel_timeout`.
  - else → `tunnel_unavailable`.
  - `payload_sent` computed by `payloadSentForFetchError()` `:625-631`:
    - AbortError → `null` (unknown — request may have started transmission).
    - `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `EAI_AGAIN` → `false` (definitively not sent).
    - `bad port` (regex on message + cause) → `false`.
    - else → `null`.
  - Error message wrapped by `tunnelTransportMessage()` `:633-641` which appends a hint when caller has `GROK_API_KEY`/`XAI_API_KEY`/`XAI_KEY` set without `GROK_WEB_TUNNEL_API_KEY` (those vars are ignored by subscription_web mode).
- **Outer-catch in cmdRun** `:1469-1478` — only fires if `callGrokTunnel` itself throws synchronously (it shouldn't — it always resolves), or the `printLifecycleJson` line throws. Maps to `bad_args` if message starts that way, else `tunnel_error`. Diagnostic carries only `configured_timeout_ms`.

### 7. Persistence
- `persistRecordBestEffort(record)` `:1291-1307, 1489`. Wraps `persistRecord()` `:1250-1289`:
  - Per-job meta first: `writeJsonFile(<root>/jobs/<jobId>/meta.json, record)` `:1253` via atomic temp+rename `:1070-1080` (mode 0o600, parent dir 0o700).
  - State index inside `withStateLock()` `:1184-1217`:
    - Lock dir: `<root>/state.json.lock` `:1185`. `mkdir({mode: 0o700})` is the lock primitive.
    - `owner.json` written with `{pid, host, startedAt}` for ownership identification.
    - Stale-lock recovery: `maybeRecoverStateLock()` `:1143-1166` → `staleLockReason()` `:1111-1137`:
      - Lock owned by current host with a now-dead pid → reclaim immediately (`reason: "dead_owner"`).
      - Lock older than `STATE_LOCK_STALE_MS` (60 s) → reclaim (`reason: "stale_age"`).
      - Otherwise hold and retry (sleep `min(5+attempt, 50)` ms, up to 200 attempts ≈ 10 s).
    - After 200 failed attempts → throws `state_lock_timeout: could not acquire Grok state lock` `:1216`.
  - Reads existing `state.json` (`:1259-1263`); if missing or `SyntaxError`, sets `needsRebuild=true`. Rebuild via `discoverJobSummaries()` `:1228-1248` walks `<root>/jobs/job_*/meta.json`.
  - Dedupes by `job_id`, sorts by `updatedAt` (parsed by `sortTimestamp()` `:1219-1222`), truncates to `MAX_STATE_JOBS` (50) — this is the **pruning logic**.
  - On `persistRecord` failure: `persistRecordBestEffort` rewrites the per-job meta with an appended `disclosure_note` describing the persistence failure (`:1296-1305`); state.json is left as-is. This is best-effort — if both writes fail, the in-memory record is still printed.
- Data root: `dataRoot(env)` `:1066-1068` = `resolve(env.GROK_PLUGIN_DATA ?? ".codex-plugin-data/grok")`.

### 8. Output
- Final record built by `buildRecord()` `:1005-1064`, validated against `GROK_EXPECTED_KEYS` (`:34-83`) by `freezeRecord()` `:903-910` (drift throws `Grok JobRecord keys drifted: ...`).
- Walked through `redactValue(record, redactor())` `:1480-1488, 225-231`. Redactor (`:190-210`):
  - Collects env-value secrets where key matches `/(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/i` and value length ≥ `MIN_SECRET_REDACTION_LENGTH` (8). Cookie-shaped `;`-separated values are split into part-level and value-only candidates `:194-201`.
  - Substitutes literal occurrences with `[REDACTED]`.
  - Also blanket regex: `Authorization: <…>` and `Bearer <≥8>` → `[REDACTED]`.
- Printed via `printLifecycleJson(printable, lifecycleEvents)` `:1490`:
  - `lifecycleEvents === "jsonl"` → compact one-line JSON.
  - else → pretty-printed JSON.
- **Exit code** `:1491` — `record.status === "completed" ? 0 : 1`. `status` is set at `:1039` from `completed = execution.exitCode === 0 && execution.parsed?.ok === true` `:1006`.

### 9. State mutations summary

| Step | Mutation |
|---|---|
| Entry | None (pure compute). |
| Argument validation success | None. |
| Argument validation failure | Skips scope, lifecycle, fetch; sets in-memory `execution`; falls through to persist+print. |
| `collectScope` success | Reads filesystem / spawns `git`. No writes. |
| `collectScope` failure | Same. |
| Lifecycle event print | stdout JSON line. **No persistence yet.** |
| `callGrokTunnel` | HTTP egress (only mutation external to repo). Sets `payload_sent: true` on any HTTP response received. |
| `buildRecord` | None — pure. Frozen object. |
| `persistRecordBestEffort` | Writes `<root>/jobs/<jobId>/meta.json` (atomic), then under lock writes `<root>/state.json` (atomic). Locks `<root>/state.json.lock`. |
| `printLifecycleJson` (final) | stdout. |
| `process.exit` | Exit code 0 (completed) or 1 (failed). |

### 10. Failure modes (`error_code` enum) for `run`

| `error_code` | Source | Site (file:line) | Closed-issue link |
|---|---|---|---|
| `bad_args` | malformed flags, env-var parse failure, missing prompt, unsupported mode | `:101, 134, 1427, 1439, 1443, 1451, 1455, 1471` | — |
| `scope_failed` | umbrella for any non-`bad_args` thrown during scope build, including `prompt_too_large` | `:1439, 1451, 1455` | #83 (oversized scope) |
| `scope_empty` (sub-message under `scope_failed`) | branch-diff selected zero files; or read returned zero non-empty files | `:356, 452, 481` | — |
| `scope_base_invalid` (sub-message) | `--scope-base` unsafe | `:337` | — |
| `scope_file_too_large` (sub-message) | per-file ≥ 256 KiB | `:378, 404, 412, 419, 443` | #83 |
| `scope_total_too_large` (sub-message) | total ≥ 1 MiB | `:382` | #83 |
| `unsafe_scope_path` (sub-message) | symlink/TOCTOU/escape | `:364, 369, 393, 401, 470, 475` | — |
| `git_failed` (sub-message) | git exec failure | `:254, 259, 270, 275` | — |
| `tunnel_timeout` | fetch AbortError on chat call | `:735` | #86 (timeout config) |
| `tunnel_unavailable` | network error | `:735, 736` | — |
| `tunnel_error` | HTTP 5xx, or any other non-OK status that isn't 401/403/429 | `:594-595, 1471` | — |
| `session_expired` | HTTP 401 / 403 | `:592` | — |
| `usage_limited` | HTTP 429 | `:593` | — |
| `malformed_response` | JSON parse fail or missing `choices[0].message.content` | `:689, 700` | — |

`run` cannot raise `grok_chat_*` (those are doctor-only).

### 11. Source-transmission classification
- `sourceTransmission(completed, payloadSent)` `:843-847`:
  - `completed === true` → `SENT`.
  - `payloadSent === true` → `SENT`.
  - `payloadSent === false` → `NOT_SENT`.
  - else (`payloadSent === null`) → `UNKNOWN`.
- Differs from companion `sourceContentTransmissionForExecution()` (see [`external-review.md`](../contracts/external-review.md)) because grok has no spawn/pid concept — there's no `running` or `cancelled` lifecycle and no `pidInfo`.
- `payload_sent` flips:
  - `false` from `bad_args`/`scope_failed` paths (`:1439, 1451, 1455`).
  - `false` from `payloadSentForFetchError()` for `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, `EAI_AGAIN`, `bad port` (`:625-631`).
  - `null` from `AbortError`, generic fetch errors, top-level outer-catch (`:626, 1471-1477`).
  - `true` from any HTTP response received (whether OK or non-OK, `:677, 689, 704`).
- `disclosure(cfg, completed, payloadSent)` `:849-861` — composed string distinct from companion `externalReviewDisclosure`. Mentions "subscription-backed web session" verbatim. Not generated by `external-review.mjs`'s shared template.
- `buildLaunchExternalReview` (`:912-926`) always sets `MAY_BE_SENT` (race window before fetch).
- `buildTerminalExternalReview` (`:929-944`) receives the computed `transmission` and the bespoke `disclosure` string.

### 12. Test references (Layer 2)
- #77 archaeology row (closed-issue-failure-modes.md:45) — `tests/smoke/grok-web.smoke.test.mjs` covers `runtime_diagnostics`, `permission_denials`, `usage_limited`, `tunnel_unavailable`, `tunnel_timeout`. **No test references `models_ok_chat_400`** — gap surfaced (see Doctor section below).
- #83 archaeology row (`closed-issue-failure-modes.md:46`) — `tests/smoke/grok-web.smoke.test.mjs` semantic match on `scope_total_too_large`. Layer-2 finding: no test asserts that a "split plan" recommendation appears in `error_message` — only that the error code fires.
- #86 archaeology row (`closed-issue-failure-modes.md:47`) — `GROK_WEB_TIMEOUT_MS` is exercised by `tests/smoke/grok-web.smoke.test.mjs`; naming asymmetry vs companion `*_REVIEW_TIMEOUT_MS` is documented but not regression-tested.

---

## Flow: `doctor` (alias `ping`) — readiness probe

### Entry
- `main()` `:1497-1500` dispatches both `doctor` and `ping` to `doctorFields()` `:1373-1413`. Output `redactValue(..., redactor())` then `printJson()`. Always exits 0 (no `process.exit`); errors propagate to top-level `runCli` and exit 1 there.

### Two-stage probe
**Stage 1 — `probeGrokTunnel(cfg, env)`** `:748-790`:
- GET `${cfg.base_url}/models` `:749, 756-760`.
- Optional `Authorization: Bearer <cred>` if `GROK_WEB_TUNNEL_API_KEY` set.
- Timeout: `cfg.doctor_timeout_ms` (default 2 s).
- HTTP non-OK → `{reachable:false, error_code: classifyHttpFailure(status), error_message, http_status, probe_endpoint}` `:763-770`.
- Fetch threw → `tunnel_timeout` (AbortError) or `tunnel_unavailable` `:779-786`.

**Stage 2 — `probeGrokChat(cfg, env)`** `:792-841`, **only if stage 1 succeeded** (`:1376`):
- POST `${cfg.base_url}/chat/completions` `:793, 806-811` with `{model, stream:false, messages:[{role:"user", content:"Return exactly: ok"}], temperature:0}` `:797-802`.
- Timeout: `cfg.chat_doctor_timeout_ms` (default 10 s).
- HTTP non-OK `:814-822`:
  - **400 → `chatBadRequestCode(parsed, text)` `:605-623`**:
    - If JSON `error.code` or `error.type` matches `\bmodel_not_found|invalid_model|unknown_model\b` → `grok_chat_model_rejected`.
    - If body text matches `model|model id|model name … not found|unknown|unsupported|does not exist|not accepted` → `grok_chat_model_rejected`.
    - **Otherwise → `models_ok_chat_400`** (`:622`). This is the gap from #77.
  - Other status → `classifyHttpFailure(status)` (401/403/429/5xx).
- Fetch threw `:830-837`:
  - AbortError → `grok_chat_timeout` (note: distinct from stage-1 `tunnel_timeout`).
  - else → `tunnel_unavailable`.

### Stage-1-failed short-circuit
- `:1376-1382` — when stage 1 fails, stage-2 result is fabricated as `{chat_ready:false, error_code: probe.error_code, ...}` so the chat probe is never attempted against an unreachable tunnel.

### Output shape
- `:1385-1412`: `provider`, `status: "ok"` (literal — the field reflects "doctor command itself didn't crash"; readiness is in `ready`/`reachable`/`chat_ready`), `ready = reachable && chat_ready`, `summary` (3-way: ready / reachable-but-not-chat-ready / unreachable), `next_action` from `suggestedAction(errorCode)`, plus `auth_mode`, `credential_ref`, `endpoint`, `probe_endpoint`, `chat_probe_endpoint`, `model`, all three timeout knobs, `error_code`, `error_message`, `http_status` (stage 1), `chat_http_status` (stage 2).
- Error_code precedence `:1384`: `chatProbe.error_code ?? probe.error_code` — chat-probe failures take precedence over models-probe failures when both surfaces exist.

### State mutations
- None. No persistence, no lifecycle event.

### Failure modes
- `tunnel_unavailable`, `tunnel_timeout` (stage 1 or 2), `session_expired`, `usage_limited`, `tunnel_error`, `grok_chat_model_rejected`, `grok_chat_timeout`, **`models_ok_chat_400`**.

### #77 gap — `models_ok_chat_400`
- **Where it would fire**: `:622`, returned by `chatBadRequestCode()` `:605-623`, propagated through stage-2 result, surfaced as `error_code` in doctor output via `:1384`.
- **Layer 2 finding** (`closed-issue-failure-modes.md:45-46, 109, 130`): semantic search shows the literal string `models_ok_chat_400` in `grok-web-reviewer.mjs:622` but **no test references it**. The two-stage doctor classifies the case correctly in code, but the classifier has no regression test. Concretely: a mock tunnel that returns 200 from `/v1/models` and 400 from `/v1/chat/completions` with an error body that doesn't match the model-rejection regex would hit this branch — no smoke test currently constructs that mock.
- The `suggestedAction()` text for this code is at `:883`: "The tunnel lists models but chat is not review-capable; refresh the Grok web session, inspect tunnel logs and rate-limit endpoint health, then retry."
- Also #77's other items (`runtime_diagnostics`, `permission_denials`, `usage_limited`) ARE covered by `tests/smoke/grok-web.smoke.test.mjs` per the archaeology row.

### Test references (Layer 2)
- #77 row — see above. `tests/smoke/grok-web.smoke.test.mjs` covers stage-1 failures and the non-400 paths.
- General doctor coverage: archaeology row #86 — same file exercises `GROK_WEB_TIMEOUT_MS` interaction.

---

## Flow: `result` (fetch persisted record)

### Entry
- `cmdResult(options, env)` `:1316-1333`, dispatched at `:1502`.
- Required flag: `--job-id <id>` (or `--job <id>`) `:1317`. Validated by `safeJobId()` `:1309-1314` — must match `^job_[0-9a-f-]{36}$`. Mismatch throws `bad_args: --job-id must be a Grok job id` (caught at top-level → bad_args output).

### Read path
- Reads `<dataRoot>/jobs/<jobId>/meta.json` synchronously `:1320`.
- Parses JSON, redacts via `redactValue(parsed, redactor(env))`, prints pretty `:1321`.

### Failure modes
- `ENOENT` → `printJson({ ok:false, error_code:"not_found", job_id })` and `process.exit(1)` `:1323-1326`.
- `SyntaxError` (malformed meta.json) → `printJson({ ok:false, error_code:"malformed_record", job_id })` and `process.exit(1)` `:1327-1330`.
- Any other error rethrows to top-level → `{ ok:false, error: <redacted> }` exit 1.

### State mutations
- None. Read-only.

### Test references
- General coverage in `tests/smoke/grok-web.smoke.test.mjs`. No specific archaeology row.

---

## Flow: `list` (job listing with self-repair)

### Entry
- `cmdList(env)` `:1335-1371`, dispatched at `:1503`. No required flags.

### Read path
- Reads `<dataRoot>/state.json` `:1339`.
- `parsed.jobs` (defaulting to `[]` if missing) `:1340`.
- Output: `printJson(redactValue({ ok:true, jobs }, redactor(env)))` `:1341`.

### Failure modes & repair
- `ENOENT` → `printJson({ ok:true, jobs: [] })` and return (success) `:1343-1346`.
- `SyntaxError` (corrupt state.json) `:1347-1368`:
  - Acquires `withStateLock(root, ...)` and rebuilds via `discoverJobSummaries(root)` `:1228-1248`:
    - `readdir(<root>/jobs)` for entries matching `^job_[0-9a-f-]{36}$`.
    - Per-entry `readFile(<root>/jobs/<id>/meta.json)`, parse, validate `record.job_id === entry.name`, push summary.
    - Malformed/unreadable meta files silently dropped (best-effort).
  - Sorts (`sortJobSummaries()` `:1224-1226`) and truncates to `MAX_STATE_JOBS`.
  - Persists fresh `state.json` `:1352`.
  - Output: `{ ok:true, jobs, repaired_from_disk: true }` `:1354`.
  - **Repair-failure path** `:1356-1367`:
    - If repair throws `state_lock_timeout` (substring match on message) → `error_code: "state_lock_timeout"`.
    - Else → `error_code: "malformed_state"`.
    - `process.exit(1)`.
- Any other error rethrows to top-level → `{ ok:false, error: ... }` exit 1.

### State mutations
- Happy path: none.
- Repair path: writes `<root>/state.json` under `withStateLock` (atomic temp+rename); locks `<root>/state.json.lock`; reclaims stale locks per `staleLockReason()` `:1111-1137`.

### Failure modes (output `error_code`)
- `state_lock_timeout` `:1358-1359` — couldn't acquire lock for state-rebuild.
- `malformed_state` `:1360` — state.json was corrupt and rebuild itself failed for some other reason.

### Test references
- `tests/smoke/grok-web.smoke.test.mjs` semantic match on `repaired_from_disk`. No specific archaeology row.

---

## Flow: `status` and `cancel`

- **Not implemented.** `main()` dispatch `:1497-1513` accepts only `doctor`/`ping`/`run`/`result`/`list`/`help`.
- `unknown_command:status` and `unknown_command:cancel` thrown at `:1514`, caught by `runCli()` `:1517-1529`, printed as `{ ok:false, error: "unknown_command:..." }` exit 1.
- **Architectural reason:** grok runs a single foreground HTTP request inside `cmdRun`. There is no background worker to inspect, no PID to signal, no queued state. The `status` enum in [`grok-output.md`](../contracts/grok-output.md) only contains `completed` and `failed`. There is no `running`, `queued`, `cancelled`, or `stale` state to report on.

---

## Flow: `help`

- `main()` `:1504-1513`. Prints a fixed JSON shape: `{ ok:true, commands:[doctor,ping,run,result,list], provider:"grok-web", default_auth_mode:"subscription_web", default_endpoint: DEFAULT_BASE_URL }`.
- No state mutations, no flags consumed.

---

## Flow: `background`

- **Not implemented.** No equivalent to companion plugins' `--background` flag, no `runBackground` mode, no `launched` lifecycle event (only `external_review_launched`).
- See `lifecycle-events.md:72`: "grok | not applicable (no background mode per current architecture)".

---

# Auxiliary entrypoint: `grok-sync-browser-session.mjs`

**Purpose:** import grok.com browser-session cookies (`sso`/`sso-rw`) into the local `grok2api` admin token pool so that `grok-web-reviewer` can route requests through them. **Not** part of the review-output contract — separate output schema, separate error-code set, never invoked by `grok-web-reviewer`.

**Entry:** `main(argv)` `:321-391`, gated at `:393-399`. Top-level catch maps to `error_code: "unexpected_error"` `:397`.

## Top-level dispatch

- Single command. `parseArgs()` `:47-69` is the same shape as the reviewer's. No `assertSafeOptionKey` guard (relies on later string handling).
- Recognized flags (read at `:322-327, 341-352`):
  - `--grok2api-base-url` (env `GROK2API_BASE_URL`, default `http://127.0.0.1:8000`).
  - `--admin-key` (env `GROK2API_ADMIN_KEY`, default `"grok2api"` — emits stderr warning when default `:329-331`).
  - `--admin-timeout-ms` (env `GROK2API_ADMIN_TIMEOUT_MS`, default 10 s).
  - `--pool` (env `GROK2API_POOL`, default `"super"`, lowercased).
  - `--append` (boolean — when true, retains existing pool tokens).
  - `--cookie-source-json <path>` (alternative to browser extraction).
  - `--browser` / `--profile` / `--cookie-db` (used in browser-extraction path).
- Output: `printJson()` `:43-45` always pretty.

## Cookie sources (mutually exclusive)

### Source 1 — explicit JSON (`--cookie-source-json`)
- `cookiesFromJson(filePath)` `:299-306`. `readFileSync` + `JSON.parse`; non-array → throws `cookie source json must be an array`.
- Each entry sanitized via `sanitizeToken()` `:77-83` (strips `sso=` / `sso-rw=` prefixes, semicolons, whitespace).
- Source flag set to `"cookie_source_json"` `:344`.

### Source 2 — browser keychain extraction (default)
- `cookiesFromBrowser(options)` `:308-319`.
- Browser registry: `BROWSERS` `:16-41` — supports `chrome`, `brave`, `edge`, `arc`. Unknown name → `unsupported_browser:<key>` from `browserConfig()` `:207-214`.
- Cookie DB path resolution: `cookieDbPathFor(browser, profile)` `:216-223` — checks `<root>/<profile>/Network/Cookies` then `<root>/<profile>/Cookies`.
- Stderr disclosure note before extraction: `"Reading Grok session cookies from <browser> profile … Token values will not be printed."` `:312`.
- Keychain unlock via `keychainPassword(browser)` `:239-251`:
  - `/usr/bin/security find-generic-password -w -a <account> -s <service>` (then fallback without `-a`).
  - All retrieval via `spawnSync` (`:246`); never echoed.
- DB read via `sqliteCookieRows(dbPath)` `:253-271`:
  - Copies DB to a `mkdtempSync` temp dir.
  - Spawns `python3 -c "<inline sqlite reader>"` to query `host_key, name, value, hex(encrypted_value)` for `host_key LIKE '%grok.com'` AND `name IN ('sso','sso-rw')`.
  - Cleans temp dir in `finally`.
- Decryption via `chromeDecrypt(encryptedHex, password)` `:273-289`:
  - Recognizes `v10`, `v11` prefixes (`aes-128-cbc`, PBKDF2 SHA-1 1003 iterations, salt `"saltysalt"`, iv 16 spaces).
  - **`v20` rejected** with explicit guidance to use `--cookie-source-json` `:278-280`.
  - Other prefix → `unsupported encrypted cookie format` `:282`.
- Source flag set to `"browser_cookie_store"` `:351`.

## Selection
- `selectCookie(cookies)` `:291-297` — first match in `COOKIE_NAMES = ["sso-rw", "sso"]` (`:13`) with non-empty sanitized value wins.
- Empty selection → `fail("cookie_not_found", "No usable sso-rw or sso cookie was found for grok.com.", { source })` `:357-360`.

## grok2api admin pool import

### Pre-flight — current pool snapshot
- `checkGrok2Api(baseUrl, adminKey, timeoutMs)` `:197-205` — calls `api(..., "/tokens", {GET})`.
- On any failure: stderr-redacted message + returns `null` (signal to caller that admin API is unreachable). `:202-204`.
- Caller `:333-336`: `null` → `fail("grok2api_unreachable", ...)`.

### Token mutations under `api()` `:152-195`
- All requests to `${baseUrl}/admin/api${pathName}` with `Authorization: Bearer <adminKey>`.
- Per-request `AbortController` with `timeoutMs` (default 10 s). AbortError → `grok2api_timeout` (custom error `code` set, surfaced via `error.code` in `fail` at `:383`).
- Non-OK HTTP throws `Error` with `.status` and `.body` for downstream attribution.

### Mutation sequence `:362-381`
1. `tokensToReplace(existingTokens, selectedValue, pool, append)` `:113-119`:
   - When `append` is true, returns `[]` (keep all existing).
   - Otherwise returns the existing tokens in the same `pool` other than the one being added — they will be deleted as stale.
2. POST `/tokens/add` with `{pool, tokens: [selected.value]}` — register the new cookie.
3. POST `/batch/refresh` with `{tokens: [selected.value]}` — refresh quota/state for the new cookie.
4. If `toDelete.length > 0`: DELETE `/tokens` with `toDelete` body — purge stale cookies.
5. GET `/tokens` again — read post-state for output.
6. Print success record (see "Output schema" below) and `process.exit(0)`.

### Output schema (success)
`:370-380`:
- `ok: true`
- `source: "cookie_source_json" | "browser_cookie_store"`
- `browser`, `profile` — flag/env values, or `null` when JSON-source.
- `selected_cookie: "sso" | "sso-rw"`.
- `pool` (lowercased).
- `append` (boolean).
- `deleted_count` — number of stale tokens purged.
- `tokens` — `(after.tokens || []).map(sanitizeAccount)`. `sanitizeAccount()` `:102-111` strips raw token values, retains only `pool`, `status`, `quota`, `use_count`, `last_used_at`, `tags`. **Token values never appear in stdout.**

### Output schema (failure) — `fail(errorCode, message, extra)` `:121-129`
- `{ ok:false, error_code, error_message: <≤1000 chars>, ...extra }`, exit 1.

### Failure modes (5 error codes, per [`grok-output.md`](../contracts/grok-output.md):98)

| `error_code` | Site (file:line) | Trigger |
|---|---|---|
| `grok2api_unreachable` | `:335` | `checkGrok2Api()` returned `null` (admin API GET `/tokens` failed pre-flight). |
| `cookie_extract_failed` | `:354` | Any throw from JSON read, browser-config lookup, keychain read, sqlite extraction, or `chromeDecrypt` (incl. `v20` rejection). Message redacted via `redactCookieExtractError()` `:140-150`. |
| `cookie_not_found` | `:359` | Sources returned cookies but none were `sso`/`sso-rw` with non-empty value. |
| `grok2api_import_failed` | `:383` | Any throw from `/tokens/add`, `/batch/refresh`, `/tokens` DELETE, or final `/tokens` GET. `error.code` (e.g., `grok2api_timeout`) preferred when set. Extra fields: `source`, `selected_cookie`, `previous_pool_count`, `pool_emptied: false`, `stale_token_count`. |
| `unexpected_error` | `:397` | Top-level catch in the `if (process.argv[1] === ...)` block. Message redacted via `redactUnexpectedError()` `:131-138`. |

### Redaction (separate from reviewer's redactor)
- `redactMessage(message, secrets)` `:92-100`:
  - `MIN_SECRET_REDACTION_LENGTH = 4` (`:14`) — **lower threshold than reviewer's 8** because admin keys can be short tokens.
  - Substitutes literal occurrences of each secret with `[REDACTED]`.
  - Blanket regex: `Authorization: <…>` and `Bearer <≥8>` → `[REDACTED]`.
- `redactUnexpectedError(error, argv, env)` `:131-138` — passes `args["admin-key"]`, `env.GROK2API_ADMIN_KEY`, `DEFAULT_ADMIN_KEY` as candidate secrets. **Crucially, NOT `cookie-source-json` or `cookie-db`** — those are paths, not secrets, but if a JSON path leak is concerning, see the next function.
- `redactCookieExtractError(error, argv, env)` `:140-150` — used only on the cookie-extraction failure path. Adds `args["cookie-source-json"]`, `args["cookie-db"]`, and `homedir()` to the secret list. This is why filesystem paths get redacted in `cookie_extract_failed` errors but not in `unexpected_error` errors.
- `grok2api_import_failed` redaction `:383`: passes `[selected.value, adminKey, ...toDelete]` — meaning the actual cookie value (which never appeared in stdout success output) is also stripped from any error message.
- Stderr disclosure messages are intentional, not redacted (`:312, 330, 342`) — they describe what the tool is about to do without revealing token contents.

### State mutations summary (sync-browser-session)

| Step | Mutation |
|---|---|
| Argument parse | None. |
| Pre-flight `/tokens` GET | None (read-only on grok2api). |
| Cookie extraction (browser path) | Creates+removes a temp dir in `mkdtempSync`. Spawns `/usr/bin/security`, `python3`. No writes to user data. |
| Cookie extraction (JSON path) | Reads file. No writes. |
| `tokens/add` POST | grok2api server-side: appends new token to pool. |
| `batch/refresh` POST | grok2api server-side: triggers refresh. |
| `tokens` DELETE | grok2api server-side: removes stale tokens. |
| `tokens` GET | None. |
| Output | stdout JSON. |
| Exit | 0 on success, 1 on any `fail(...)`. |

### Test references
- `tests/smoke/grok-session-sync.smoke.test.mjs` per archaeology row #70 (`closed-issue-failure-modes.md:86`).
- No archaeology entries indicate gaps in the sync flow.

---

# What grok does NOT have vs companion / api-reviewers

| Feature | claude / gemini / kimi (companion) | api-reviewers | grok |
|---|---|---|---|
| `JobRecord` uniformity (single `EXPECTED_KEYS` from `lib/job-record.mjs`) | yes — shared schema | partial (api-reviewers has its own) | **no — grok defines its own `GROK_EXPECTED_KEYS` `:34-83`, builds frozen records via `freezeRecord()` `:903-910`** |
| Background mode (`--background`, `launched` event, separate worker process) | yes | no (synchronous direct-HTTP) | **no — single-process synchronous tunnel call only**; only `external_review_launched` event ever emitted (`:1459-1465`) |
| Companion-common state machine (`queued` → `running` → terminal, orphan reconciliation, `stale` status) | yes — see `scripts/lib/companion-common.mjs` | no | **no — `status ∈ {completed, failed}` only**; no PID tracking, no orphan detection |
| `cancel` command / operator interruption | yes (signals worker PID) | no | **no — `unknown_command:cancel` falls through to error** |
| `status` command (per-job query) | yes | yes | **no — only `result` (read-only fetch of persisted record) and `list`** |
| Env-strip pre-launch via `sanitizeTargetEnv()` (drops `*_API_KEY`, `ANTHROPIC_*`, `OPENAI_*`, etc.) | yes — `provider-env.mjs` | n/a (no spawned target) | **no — uses output-time JSON-tree redaction via `redactor()` `:190-210` instead, applied at print time to the final record AND error messages**. See [`redaction.md`](../contracts/redaction.md). |
| Provider session-id capture (`claude_session_id` etc.) populated | yes | n/a | **fields exist in record (`:40-42`) but always `null`** — grok has no provider-side session id; `external_review.session_id` uses `safeSessionId(parsed.value?.id)` (the per-call response id, not a session) `:643-646, 935` |
| `pid_info` populated | yes (when worker spawned) | no | **always `null` `:1024`** — no spawned process to track |
| `containment` non-trivial value | varies | n/a | **always `"none"` `:1030`** |
| `permission_denials` / `mutations` populated | yes | yes | **always `[]` `:1053-1054`** — single HTTP call has no filesystem-mutation surface |
| `cost_usd` populated | varies | yes | **always `null` `:1055`** — subscription-backed, no per-call billing |
| Shared `buildExternalReview` from `lib/external-review.mjs` | yes | yes | **no — grok imports `EXTERNAL_REVIEW_KEYS` and `SOURCE_CONTENT_TRANSMISSION` only `:11-14`, then builds via its own `buildLaunchExternalReview` `:912-926` and `buildTerminalExternalReview` `:929-944` to be able to use the bespoke `disclosure()` text mentioning "subscription-backed web session"** |
| Shared `sourceContentTransmissionForExecution` mapping (status × errorCode × pidInfo) | yes — `external-review.mjs:93-119` | yes | **no — grok uses its own `sourceTransmission(completed, payloadSent)` `:843-847`**, a smaller two-input function (no status, no pidInfo) because grok lacks the lifecycle states those inputs encode |
| Auxiliary credential-import entrypoint | none | none | **`grok-sync-browser-session.mjs` — unique** |
| Two-stage doctor (independent transport vs application probes) | n/a | basic readiness | **yes — `/v1/models` (transport) AND `/v1/chat/completions` (application). Surfaces `models_ok_chat_400` distinct from `tunnel_unavailable`. Test gap on `models_ok_chat_400` per #77.** |
| Hard scope byte cap | no — companion relies on target CLI's own limits | preflight estimate | **yes — 256 KiB/file, 1 MiB total, hard-rejected before tunnel call. Per #83.** |
| Timeout env var naming | `*_REVIEW_TIMEOUT_MS` (claude/gemini/kimi/api-reviewers) | `API_REVIEWERS_TIMEOUT_MS` | **`GROK_WEB_TIMEOUT_MS` (asymmetry per #86 archaeology). Plus `GROK_WEB_DOCTOR_TIMEOUT_MS` and `GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS` — neither has companion equivalents.** |

The matrix consequence (echoing [`grok-output.md`](../contracts/grok-output.md):108-116): per-plugin case lists are required. The companion-only enums (`step_limit_exceeded`, the per-CLI `*_error` codes, `cancelled`, `stale`, `queued`) and the grok-only enums (`tunnel_*`, `grok_chat_*`, `models_ok_chat_400`, `state_lock_timeout`, `malformed_state`, `not_found`, `malformed_record`) are non-overlapping.
