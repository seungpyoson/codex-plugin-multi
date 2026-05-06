# grok-web-reviewer output contract

**Applies to:** `grok` plugin only. **Different schema** from the companion JobRecord — separate `GROK_EXPECTED_KEYS` list. Some sub-records (notably `external_review`) are shared with the companion stack.

**Canonical source:** `plugins/grok/scripts/grok-web-reviewer.mjs`. Single-process architecture: no spawned worker, no companion-common, no provider-env. The reviewer talks directly to a local `grok2api` HTTP tunnel, which forwards to grok.com.

## Output shape

The reviewer builds a frozen record via `buildRecord()` (`grok-web-reviewer.mjs:1000-1066`). The canonical key list is `GROK_EXPECTED_KEYS` (`grok-web-reviewer.mjs:34-83`).

**Printers:**
- `printJson()` (`grok-web-reviewer.mjs:85-87`) — pretty.
- `printJsonLine()` (`grok-web-reviewer.mjs:89-91`) — compact JSONL.
- `printLifecycleJson()` (`grok-web-reviewer.mjs:93-96`) — dispatches based on `--lifecycle-events`.

**Success vs failure:**
- Success: `status === "completed"`, `exit_code === 0`, all fields populated (`grok-web-reviewer.mjs:1039-1066`).
- Failure: same record shape, `status === "failed"`, non-zero `exit_code`, `error_code` populated, `result === null` (`grok-web-reviewer.mjs:1007-1043`).

The full key list is enumerated at `grok-web-reviewer.mjs:34-83`. To compare against companion JobRecord fields, run `diff <(extract grok keys) <(extract companion EXPECTED_KEYS)`. Notable additions on grok: `http_status` (line 1060), tunnel-specific fields. Notable absences: provider session ids (no `claude_session_id`/`gemini_session_id`/`kimi_session_id`).

## Status enum

Two values only:

| Value | When |
|---|---|
| `completed` | `exitCode === 0 AND parsed.ok === true` (`grok-web-reviewer.mjs:986`) |
| `failed` | anything else |

No `queued`, `running`, `cancelled`, or `stale` — grok is synchronous, no background worker, no operator cancel during a single-process tunnel call.

## error_code enum

20+ distinct values. Grouped by source:

### CLI argument validation
- `bad_args` (`grok-web-reviewer.mjs:101, 134, 1439, 1451, 1455`) — malformed flags or argument parsing.

### Scope resolution
- `scope_failed` (`grok-web-reviewer.mjs:356, 359, 378, 382, ...`) — generic scope refusal.
- `scope_empty` (`:356, 359, 452, 481`) — branch-diff or custom-review selected zero files.
- `scope_base_invalid` (`:337`) — `--scope-base` ref unsafe for git branch-diff.
- `scope_file_too_large` (`:378, 404, 412, 419, 443`) — individual file ≥ `MAX_SCOPE_FILE_BYTES` (256 KiB).
- `scope_total_too_large` (`:382`) — total scope ≥ `MAX_SCOPE_TOTAL_BYTES` (1 MiB).
- `unsafe_scope_path` (`:364, 369, 393, 401, 470, 475`) — symlink, TOCTOU, or relative-escape.
- `git_failed` (`:254, 259, 270, 275`) — `git branch-diff` or `git show` exited non-zero.

### Tunnel / network
- `tunnel_timeout` (`:782, 833`) — fetch AbortError (exceeded `GROK_WEB_TIMEOUT_MS` or `GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS`).
- `tunnel_unavailable` (`:782, 833`) — network error, `ECONNREFUSED`, fetch failure.
- `tunnel_error` (`:738, 1472`) — HTTP 5xx from tunnel.
- `session_expired` (`:592`) — HTTP 401/403 from tunnel.
- `usage_limited` (`:593`) — HTTP 429.

### Response handling
- `malformed_response` (`:689, 702, 767, 819`) — JSON missing `ok` flag or malformed content.
- `grok_chat_timeout` (`:833`) — chat readiness probe exceeded `GROK_WEB_CHAT_DOCTOR_TIMEOUT_MS`.
- `grok_chat_model_rejected` (`:617`) — chat probe: model not in tunnel's model list.
- `models_ok_chat_400` (`:622`) — chat probe: 400 but model exists (unknown 400 reason).

### State / persistence
- `state_lock_timeout` (`:1362`) — stale state lock (>60s).
- `malformed_record` (`:1328`) — persisted record unparseable.
- `not_found` (`:1324`) — job id not found in state during `list`.

## Source-transmission disclosure

Grok uses the **shared `external-review.mjs`** types but builds the record itself rather than calling the shared `buildExternalReview` directly. Two builders:

- `buildLaunchExternalReview()` (`grok-web-reviewer.mjs:912-926`) — emitted with the `external_review_launched` event; sets `source_content_transmission: SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT`.
- `buildTerminalExternalReview()` (`grok-web-reviewer.mjs:929-946`) — included in the final record; receives a transmission value computed by `sourceTransmission()` (`:1012`) based on whether the request payload was sent and the tunnel returned a clean result.

Disclosure note generation: `disclosure()` (`grok-web-reviewer.mjs:849-862`).

## Lifecycle event

Grok emits exactly **one event** before launching the tunnel call (`grok-web-reviewer.mjs:1459-1464`), then the final JobRecord:

```json
{
  "event": "external_review_launched",
  "job_id": "...",
  "target": "grok-web",
  "status": "launched",
  "external_review": { /* buildLaunchExternalReview output */ }
}
```

Emitted only when `--lifecycle-events jsonl` is passed AND scope validation succeeds.

## Redaction

Output-time redaction via `redactor()` (`grok-web-reviewer.mjs:190-223`) and `redactValue()` (`:225-231`). See [`redaction.md`](./redaction.md) for the full surface.

## Auxiliary entrypoint — grok-sync-browser-session

`plugins/grok/scripts/grok-sync-browser-session.mjs` is a separate ~349-line script for managing Grok session credentials. It extracts cookies from the browser keychain or a JSON source, imports them into the local `grok2api` admin pool. **Not** part of the review-output contract — it's a credential-injection tool with its own output shape and 5 error codes (`grok2api_unreachable`, `cookie_extract_failed`, `cookie_not_found`, `grok2api_import_failed`, `unexpected_error`).

## What's UNIQUE to grok

- **No JobRecord wrapper** in the companion sense — the reviewer builds output directly.
- **No companion-common state machine** — no shared persistence layer, no orphan reconciliation, no `stale` status.
- **No provider-env** — all grok config comes from `GROK_WEB_*` env vars read directly.
- **HTTP tunnel architecture** — failures partition into tunnel/network/response categories that don't exist for spawned-CLI plugins.
- **Browser-session import flow** — separate auxiliary entrypoint not present in any other plugin.

## Implications for the matrix

The Cartesian "(plugin, flow, mode, case)" assumption breaks for grok in two places:

1. **No `background` mode** — grok runs synchronously. Background-mode rows for grok are categorically uncoverable.
2. **Status/error vocabulary is plugin-specific** — `step_limit_exceeded`, `usage_limited` (companion variant), `claude_error`/`gemini_error`/`kimi_error` are not applicable. Conversely, `tunnel_*`, `grok_chat_*` cases are not applicable to companion plugins.

The matrix needs per-plugin case lists, not one global case enum.
