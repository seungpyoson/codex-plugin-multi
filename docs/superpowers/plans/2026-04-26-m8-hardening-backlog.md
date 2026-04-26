# M8 Hardening Backlog

This note records PASS_M8_GEMINI_BACKGROUND_CONTINUE LOW/NIT findings that were evaluated after `3bf78d4`.

## Fixed in the M8 hardening pass

- `_run-worker` terminal re-entry now fails before consuming sidecars or overwriting a terminal JobRecord.
- Gemini smoke coverage directly exercises the queued missing-prompt-sidecar worker path.
- Gemini continue smoke coverage now uses a mock that rotates `gemini_session_id` on resumed runs.
- Gemini command and roadmap docs now state that background `run` and `continue --job` are implemented, while `cancel` remains deferred.
- Gemini smoke polling uses `GEMINI_SMOKE_POLL_TIMEOUT_MS` so CI can raise the deadline without changing tests.

## Resolved in T10.0

- Detached worker spawn error handling: valid shared lifecycle defect. The
  worker executable is the current `process.execPath`, but the detached child
  also uses caller-provided `--cwd` as its process cwd. A nonexistent or
  otherwise unusable `--cwd` can produce a child `error` after the queued
  JobRecord and prompt sidecar are written but before a worker is running.
  Claude and Gemini now wait for child `spawn` before emitting `launched`; on
  `error`, both write a failed JobRecord, remove the prompt sidecar, and return
  `spawn_failed`. Covered by target-specific companion smoke tests.

## Deferred

- Gemini cancel: separate lifecycle milestone. Owner/milestone: M10
  lifecycle-parity slice before M11 if prioritized. Rationale: implementing it
  requires PID ownership semantics, status/result contract decisions, command
  docs, and smoke coverage analogous to Claude cancel.
