# Lifecycle events

**Scope:** the discrete JSON events emitted to stdout when `--lifecycle-events jsonl` is passed. **Not** the same as the JobRecord `status` field — that's the persistent state machine; lifecycle events are the small set of named launch markers.

**Canonical source:** `scripts/lib/companion-common.mjs:25-51` (the shared builders), synced into every companion plugin.

## Mode flag

`parseLifecycleEventsMode(value)` (`scripts/lib/companion-common.mjs:19-23`):

- Accepts `null`, `false`, or the literal string `"jsonl"`.
- Throws on any other value.
- When `null`/`false`, lifecycle events are not separately printed (the final JobRecord is still printed pretty).
- When `"jsonl"`, each event is printed as a single line of compact JSON, terminated with `\n`.

## Event types

There are exactly **two named launch events** plus the **terminal JobRecord**. No general state-transition stream.

### 1. `external_review_launched` — foreground launch marker

Builder: `externalReviewLaunchedEvent(invocation, externalReview)` (`companion-common.mjs:25-33`).

Shape:

```json
{
  "event": "external_review_launched",
  "job_id": "<uuid>",
  "target": "<plugin>",
  "status": "launched",
  "external_review": { /* 12-key external_review sub-record */ }
}
```

Emitted by every plugin that supports lifecycle events:

| Plugin | Emit site |
|---|---|
| claude | `plugins/claude/scripts/claude-companion.mjs` (foreground review path) |
| gemini | `plugins/gemini/scripts/gemini-companion.mjs` (foreground review path) |
| kimi | `plugins/kimi/scripts/kimi-companion.mjs` (foreground review path) |
| grok | `plugins/grok/scripts/grok-web-reviewer.mjs:1459-1464` (before tunnel call) |
| api-reviewers | `plugins/api-reviewers/scripts/api-reviewer.mjs:1757-1764` (after preflight, before fetch) |

### 2. `launched` — background launch marker

Builder: `externalReviewBackgroundLaunchedEvent(invocation, pid, externalReview)` (`companion-common.mjs:35-46`).

Shape:

```json
{
  "event": "launched",
  "job_id": "<uuid>",
  "target": "<plugin>",
  "parent_job_id": "<uuid> | null (omitted when null)",
  "mode": "<mode>",
  "pid": 12345,
  "workspace_root": "/abs/path",
  "external_review": { /* 12-key external_review sub-record */ }
}
```

Emitted by companion plugins only when launching a background worker:

| Plugin | Emit site |
|---|---|
| claude | `plugins/claude/scripts/claude-companion.mjs` (background launch path) |
| gemini | `plugins/gemini/scripts/gemini-companion.mjs` (background launch path) |
| kimi | `plugins/kimi/scripts/kimi-companion.mjs` (background launch path) |
| grok | not applicable (no background mode per current architecture) |
| api-reviewers | not applicable (synchronous direct-HTTP; persists state but does not emit `launched`) |

### Final JobRecord

After the launched-event (if any), the final JobRecord is printed once on terminal completion. In `jsonl` mode it's still a single JSON object on its own line; in default mode it's pretty-printed.

## Negative-emission conditions

Lifecycle events are NOT emitted when the run aborts before launch:

- `bad_args` — argument parsing fails before invocation is built.
- `config_error` — config file unreadable.
- `missing_key` — credential not found (api-reviewers).
- `scope_failed` — scope resolution refuses bytes (any plugin).

Verified for api-reviewers at `tests/smoke/api-reviewers.smoke.test.mjs:2534-2548`. Companion plugins follow the same pattern: scope failures emit a final `failed` JobRecord but no `external_review_launched`.

## What lifecycle events do NOT do

- They are **not** a state-transition stream. There is no `running`, no `cancelled`, no `completed` event.
- The lifecycle of a job (queued → running → terminal) lives on the JobRecord's `status` field, not in events.
- Property tests asserting "events are strictly ordered by `at` timestamp" or "no event after a terminal event" do not match what the code emits — the code emits at most 2 events per run, both before any work completes.

## Test surface

- `tests/smoke/api-reviewers.smoke.test.mjs:2209-2234` — JSONL stream parse + event ordering for api-reviewers.
- `tests/smoke/api-reviewers.smoke.test.mjs:2534-2548` — no `external_review_launched` event on prelaunch failures.
- Companion plugins exercise the `launched` event throughout their smoke files (search `event.*launched` in `tests/smoke/{claude,gemini,kimi}-companion.smoke.test.mjs`).
