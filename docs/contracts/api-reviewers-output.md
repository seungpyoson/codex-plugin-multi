# api-reviewer output contract

**Applies to:** `api-reviewers` plugin only — both `deepseek-*` and `glm-*` commands. **Different schema** from the companion JobRecord — extra direct-API fields. Some sub-records (notably `external_review`) are conceptually shared but constructed locally rather than via the shared library.

**Canonical source:** `plugins/api-reviewers/scripts/api-reviewer.mjs`. Single-process direct-HTTP architecture: `fetch()` to provider's OpenAI-compatible `/chat/completions` endpoint. No spawned worker.

## Output shape

The reviewer builds a frozen record via `buildRecord()` (`api-reviewer.mjs:1634-1664`). Output keys (`api-reviewer.mjs:39-85`):

```
id, job_id, target, provider, parent_job_id,
claude_session_id, gemini_session_id, kimi_session_id, resume_chain, pid_info,
mode, mode_profile_name, model, cwd, workspace_root, containment, scope,
dispose_effective, scope_base, scope_paths, prompt_head, review_metadata,
schema_spec, binary,
status, started_at, ended_at, exit_code, error_code, error_message,
error_summary, error_cause, suggested_action,
external_review, disclosure_note, runtime_diagnostics,
result, structured_output, permission_denials, mutations, cost_usd, usage,
auth_mode, credential_ref, endpoint, http_status, raw_model,
schema_version
```

**Notable extras** beyond the companion 41-key JobRecord:

- `provider` — `"deepseek"` or `"glm"`.
- `auth_mode` — credential type (`api_key`, etc.).
- `credential_ref` — name of the env var the credential came from (the value is never persisted).
- `endpoint` — provider base URL.
- `http_status` — HTTP status code from the provider call.
- `raw_model` — the model string sent in the request (vs the resolved `model` field).

Frozen via `freezeRecord()` (`api-reviewer.mjs:1472`). Printed via `printJson()` (`:93`) or `printJsonLine()` (`:97`).

## Status enum

Two values only, set at `api-reviewer.mjs:1571`:

| Value | When |
|---|---|
| `completed` | `execution.exitCode === 0 AND execution.parsed?.ok === true` |
| `failed` | anything else |

No `queued`/`running`/`cancelled`/`stale`. The reviewer is synchronous and does not run a background worker.

## error_code enum

Set at `api-reviewer.mjs:1642` as `execution.parsed?.reason ?? "provider_error"`. Distinct values:

| Value | Source | Trigger |
|---|---|---|
| `bad_args` | `:1241, 1749, 1766` | invalid args or malformed request |
| `config_error` | `:1695` | unreadable `providers.json` |
| `missing_key` | `:1276` | configured credential not in env |
| `auth_rejected` | `:1374` | HTTP 401/403 |
| `rate_limited` | `:1375` | HTTP 429 |
| `provider_unavailable` | `:1376-1378` | HTTP 408/409/425/5xx + capacity/resource/overload/unavailable signals; also `ENOTFOUND`/`ECONNREFUSED`/`ETIMEDOUT` |
| `provider_error` | `:1380` | other HTTP errors not classified above |
| `malformed_response` | `:1288, 1298` | invalid JSON or missing `choices[0].message.content` |
| `mock_assertion_failed` | `:1206, 1215, 1227` | mock-mode validation fail (test infra) |
| `scope_failed` | `:1749, 1766` | scope resolution refused |
| `timeout` | `:1318` | fetch AbortError (exceeded provider timeout) |

## DeepSeek vs GLM

**Identical output shape and error vocabulary.** Differences are configuration-only, in `plugins/api-reviewers/config/providers.json`:

| Field | DeepSeek | GLM |
|---|---|---|
| `base_url` | `https://api.deepseek.com` | `https://api.z.ai/api/coding/paas/v4` |
| `model` | `deepseek-v4-pro` | `glm-5.1` |
| `env_keys` | `["DEEPSEEK_API_KEY"]` | `["ZAI_API_KEY", "ZAI_GLM_API_KEY"]` |
| `reasoning_effort` | `"max"` | (unset by default) |
| `max_tokens` | `65536` | `131072` |

Both support `thinking.type: enabled`. `callProvider()` at `api-reviewer.mjs:1234` treats both identically via the OpenAI-compatible contract.

This means: for the matrix, a single `api-reviewers` plugin row can fan out to two providers, but the case vocabulary is identical. Either two rows (`api-reviewers-deepseek`, `api-reviewers-glm`) with duplicated coverage cells, or one row with a sub-axis. Choose explicitly when constructing the matrix; do not implicitly conflate.

## Source-transmission disclosure

api-reviewers does **NOT** call the shared `buildExternalReview`. It constructs `external_review` locally:

- `buildLaunchExternalReview()` (`api-reviewer.mjs:1492-1506`) — emitted with the `external_review_launched` event; sets `source_content_transmission: "may_be_sent"` (`:1504`).
- `directApiTransmission()` (`api-reviewer.mjs:1456-1459`) — terminal classification:
  - `sent` if `completed === true` OR `payloadSent === true`.
  - `not_sent` if `payloadSent === false`.
  - `unknown` otherwise.
- `directApiDisclosure()` (`api-reviewer.mjs:1429-1451`) — disclosure text.

The 12 `external_review` keys still match `EXTERNAL_REVIEW_KEYS` from the shared module — the shape is preserved, only the construction differs. Tests assert this alignment (see `tests/unit/job-record.test.mjs:1367-1389` for the cross-plugin SKILL-doc box-alignment test).

## Lifecycle event

Emits `external_review_launched` only when `--lifecycle-events jsonl` is set AND execution proceeds past preflight + scope (`api-reviewer.mjs:1757-1764`). NOT emitted on `bad_args`, `config_error`, `missing_key`, or scope errors (verified `tests/smoke/api-reviewers.smoke.test.mjs:2534-2548`).

## Redaction

Output-time redaction via `redactor()` (`api-reviewer.mjs:632-652`) and `redactValue()` (`:654-663`). See [`redaction.md`](./redaction.md) for full pattern list, threshold, and substitution.

Critically: redaction is applied to the **persisted record on disk**, not just stdout. `redactRecord()` runs at `api-reviewer.mjs:1668` before both stdout print and `meta.json` write. Echo-attacks are handled here, not by a separate error code.

## Persistence — direct API job state

Unlike companion plugins (which delegate state to companion-common), api-reviewers persists job state directly:

- State directory: **`.codex-plugin-data/api-reviewers/`** (resolved relative to `cwd` via `apiReviewerDataRoot()` at `api-reviewer.mjs:124`). Override with the `API_REVIEWERS_PLUGIN_DATA` env var.
- Per-job: `jobs/<job_id>/meta.json`
- Index: `state.json`
- Two-stage locking via `.state.lock.gate` then `.state.lock`, with explicit cross-host hostname refusal (locks owned by a different host are not reclaimed) and rename-and-re-read race detection. See `tryReclaimStaleApiReviewerStateLock` and surrounding code at `api-reviewer.mjs:251-449`.

This introduces a separate failure surface (lock timeout, pruning, cross-host owner detection) tested in `tests/smoke/api-reviewers.smoke.test.mjs` (extensive coverage under "direct API reviewer persistence" / "lock" titles).

## What's UNIQUE to api-reviewers

- **Direct HTTP via `fetch()`** — introduces network-native errors (`ENOTFOUND`/`ECONNREFUSED`/`ETIMEDOUT`) classified at `api-reviewer.mjs:1349-1351`.
- **Built-in job persistence** to `.codex-plugin-data/api-reviewers/` (cwd-relative; override via `API_REVIEWERS_PLUGIN_DATA`) with two-stage locking + pruning.
- **No subprocess env isolation** — credentials passed directly as `Authorization: Bearer <key>` headers (`api-reviewer.mjs:1271`). Output redaction is the only defense against echo-attacks.
- **Configuration-driven providers** — `providers.json` defines the providers; same code serves DeepSeek + GLM + future providers.
- **Two providers under one plugin** — DeepSeek and GLM share output shape but have separate config, separate credentials, and distinct provider-side failure modes.

## Implications for the matrix

- **No `background` mode** — api-reviewers is synchronous. Background-mode rows are categorically uncoverable.
- **No `claude_error`/`gemini_error`/`kimi_error`/`step_limit_exceeded`/`usage_limited`** — different vocabulary. Conversely, `auth_rejected`, `rate_limited`, `missing_key`, `mock_assertion_failed` are not applicable to companion plugins.
- **DeepSeek and GLM are conceptually two providers under one plugin.** Treat them as separate matrix rows (or a sub-axis) — collapsing them hides per-provider coverage gaps (auth, rate limits, model availability).
