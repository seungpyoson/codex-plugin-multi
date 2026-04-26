# M8 Hardening Backlog

This note records PASS_M8_GEMINI_BACKGROUND_CONTINUE LOW/NIT findings that were evaluated after `3bf78d4`.

## Fixed in the M8 hardening pass

- `_run-worker` terminal re-entry now fails before consuming sidecars or overwriting a terminal JobRecord.
- Gemini smoke coverage directly exercises the queued missing-prompt-sidecar worker path.
- Gemini continue smoke coverage now uses a mock that rotates `gemini_session_id` on resumed runs.
- Gemini command and roadmap docs now state that background `run` and `continue --job` are implemented, while `cancel` remains deferred.
- Gemini smoke polling uses `GEMINI_SMOKE_POLL_TIMEOUT_MS` so CI can raise the deadline without changing tests.

## Deferred

- Detached spawn `child.on("error")` handling: not a valid M8 defect as implemented because the launcher uses the current `process.execPath`, not a user-supplied worker binary. Handling impossible worker-spawn failures would require shared Claude/Gemini lifecycle cleanup semantics for queued jobs and prompt sidecars.
- Gemini cancel: separate lifecycle milestone. It requires PID ownership semantics, status/result contract decisions, command docs, and smoke coverage analogous to Claude cancel.
