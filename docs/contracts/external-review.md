# external_review sub-record + source-transmission disclosure

**Canonical source:** `scripts/lib/external-review.mjs` — synced into every plugin's `lib/external-review.mjs` via `scripts/ci/sync-external-review.mjs`. The repo-root copy is the source of truth.

**Applies to:** every plugin that calls `buildExternalReview` — minimally claude/gemini/kimi (companion). grok and api-reviewers also import from `lib/external-review.mjs` (verified by file presence under `plugins/grok/scripts/lib/` and `plugins/api-reviewers/scripts/lib/`); whether they actually invoke `buildExternalReview` and with what arguments is documented in [`grok-output.md`](./grok-output.md) and [`api-reviewers-output.md`](./api-reviewers-output.md).

## `external_review` keys

The `external_review` sub-record on a JobRecord (or equivalent output object) has exactly these 12 keys in this order, asserted by `tests/unit/job-record.test.mjs:117` (`EXTERNAL_REVIEW_KEYS`). Any drift throws (`external-review.mjs:144-148`).

| Key | Type | Notes |
|---|---|---|
| `marker` | literal `"EXTERNAL REVIEW"` | Constant identifier — operators grep on this. |
| `provider` | `string` | Display name from `PROVIDER_NAMES` map (`external-review.mjs:1-9`): `"Claude Code"`, `"Gemini CLI"`, `"Kimi Code CLI"`, or the raw target string for others. |
| `run_kind` | `"foreground" \| "background"` | Defaults to `"foreground"` (`external-review.mjs:133`). |
| `job_id` | `string` | Inherited from invocation. |
| `session_id` | `string \| null` | Provider-specific session id when captured. |
| `parent_job_id` | `string \| null` | For continued runs. |
| `mode` | `string` | Inherited from invocation. |
| `scope` | `string` | Inherited from invocation. |
| `scope_base` | `string \| null` | Inherited from invocation. |
| `scope_paths` | `string[] \| null` | Inherited from invocation. |
| `source_content_transmission` | enum | See below. |
| `disclosure` | `string` | Human-readable. See disclosure mapping. |

The output is `Object.freeze`d so consumers cannot mutate it.

## `source_content_transmission` enum

**Four values**, exported as `SOURCE_CONTENT_TRANSMISSION` (`external-review.mjs:11-16`):

| Value | Meaning |
|---|---|
| `not_sent` | Selected source bytes were definitively not delivered to the provider. |
| `may_be_sent` | Selected source bytes might have been delivered (race window or pre-spawn state). |
| `sent` | Selected source bytes were delivered to the provider. |
| `unknown` | Cannot determine — race window where the running-record handoff after spawn was best-effort and may have failed. |

Validation: `buildExternalReview` throws `invalid sourceContentTransmission` if a value outside this set is passed (`external-review.mjs:126-128`).

## Classification rules — `sourceContentTransmissionForExecution(...)`

Deterministic mapping from `(status, errorCode, pidInfo)` → enum value. Source: `external-review.mjs:93-119`.

| Input | Output |
|---|---|
| `status === "queued"` | `may_be_sent` |
| `status === "running"` AND `pidInfo` present | `sent` |
| `status === "running"` AND no `pidInfo` | `may_be_sent` |
| `status === "stale"` AND `pidInfo` present | `sent` |
| `status === "stale"` AND no `pidInfo` | `unknown` (intentionally conservative — see source comment 100-107) |
| `errorCode === "scope_failed"` | `not_sent` |
| `errorCode === "spawn_failed"` | `not_sent` |
| `status === "cancelled"` AND `pidInfo` present | `sent` |
| `status === "cancelled"` AND no `pidInfo` | `not_sent` |
| `status === "completed"` | `sent` |
| `errorCode in CONTENT_RECEIVED_ERROR_CODES` (see below) | `sent` |
| anything else | `unknown` |

### `CONTENT_RECEIVED_ERROR_CODES`

The set of error codes that imply the target process *did* receive the source bytes before failing (`external-review.mjs:35-44`):

```
claude_error
gemini_error
kimi_error
parse_error
step_limit_exceeded
usage_limited
finalization_failed
timeout
```

These are post-spawn failures — the bytes already crossed the boundary.

## Disclosure templates

`externalReviewDisclosure(provider, status, sourceContentTransmission, errorCode)` (`external-review.mjs:66-79`) maps the four enum values × the lifecycle status × the error code to a human-readable disclosure string.

### `may_be_sent`

> `Selected source content may be sent to ${provider} for external review.`

### `sent` — by status

| Status | Disclosure |
|---|---|
| `completed` | `Selected source content was sent to ${provider} for external review.` |
| `running` | `... was sent to ${provider} for external review; the run is in progress.` |
| `cancelled` | `... was sent to ${provider} for external review; the operator cancelled the run before it completed.` |
| `stale` | `... was sent to ${provider} for external review; the run became stale before completion.` |
| anything else | `... was sent to ${provider} for external review, but the run ended before a clean result was produced.` |

### `not_sent` — by status, then by error code

| Match | Disclosure |
|---|---|
| `status === "cancelled"` | `... was not sent to ${provider}; the operator cancelled the run before the target process was started.` |
| `errorCode === "scope_failed"` | `... was not sent to ${provider}; the review scope was rejected before the target process was started.` |
| `errorCode === "spawn_failed"` | `... was not sent to ${provider}; the target process was not spawned.` |
| else | `... was not sent to ${provider}; the target process was not started.` |

### `unknown` — by status

| Status | Disclosure |
|---|---|
| `stale` | `Selected source content may have been sent to ${provider}; the run became stale before completion.` |
| else | `Selected source content may have been sent to ${provider}; the run ended before a clean result was produced.` |

## Test surface

The disclosure templates are exhaustively tested in `tests/unit/job-record.test.mjs` — every status × every relevant error code path has a named test:

- `tests/unit/job-record.test.mjs:109-123` — key-set + transmission enum validation
- `tests/unit/job-record.test.mjs:125-131` — post-spawn failure codes treated as sent
- `tests/unit/job-record.test.mjs:163-222` — completed sent path
- `tests/unit/job-record.test.mjs:280-317` — cancelled sent vs not-sent (post- vs pre-spawn)
- `tests/unit/job-record.test.mjs:605-621` — claude_error sent
- `tests/unit/job-record.test.mjs:642-688` — scope_failed not-sent (multiple sub-codes)
- `tests/unit/job-record.test.mjs:919-933` — spawn_failed not-sent
- `tests/unit/job-record.test.mjs:935-967` — finalization_failed sent
- `tests/unit/job-record.test.mjs:989-1022` — timeout sent
- `tests/unit/job-record.test.mjs:1024-1069` — Kimi step_limit_exceeded / usage_limited diagnostics
- `tests/unit/job-record.test.mjs:1367-1389` — SKILL.md ASCII box alignment for external_review across all five plugin skill docs

## Why this matters for #103

`source_content_transmission` is the most safety-critical contract in the repo: it answers "did selected source bytes leave my workstation." Every test that asserts on this field is a regression test for *the* scenario users care about — was their code sent to a third-party provider. Spec §21.3 makes this an explicit `Object.freeze`d sub-record so callers cannot rebuild it incorrectly.

Property-based tests over this contract should treat the deterministic `sourceContentTransmissionForExecution(status, errorCode, pidInfo)` mapping as the property — for all valid (status, errorCode, pidInfo) tuples, the output must equal the table above. Any deviation is a security regression.
