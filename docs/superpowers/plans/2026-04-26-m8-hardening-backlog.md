# M8 Hardening Backlog

This note records PASS_M8_GEMINI_BACKGROUND_CONTINUE LOW/NIT findings that were evaluated after `3bf78d4`.

## Fixed in the M8 hardening pass

- `_run-worker` terminal re-entry now fails before consuming sidecars or overwriting a terminal JobRecord.
- Gemini smoke coverage directly exercises the queued missing-prompt-sidecar worker path.
- Gemini continue smoke coverage now uses a mock that rotates `gemini_session_id` on resumed runs.
- Gemini command and roadmap docs now state that background `run` and `continue --job` are implemented, while `cancel` remains deferred.

## Deferred

- Detached spawn `child.on("error")` handling: deferred because the launcher uses `process.execPath` and this changes the shared Claude/Gemini lifecycle contract for how queued jobs and prompt sidecars are cleaned up when a detached worker cannot start.
- Poll deadline configurability: deferred until there is CI flake evidence. Current mock-based tests pass with the existing fixed deadline.
- Gemini cancel: deferred to its own lifecycle milestone. It requires PID ownership semantics, status/result contract decisions, command docs, and smoke coverage analogous to Claude cancel.

