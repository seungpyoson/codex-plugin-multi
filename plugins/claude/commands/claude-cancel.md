---
description: Cancel a running Claude-plugin background job. Use Ctrl+C for foreground runs.
argument-hint: "<job-id> [--force]"
---

## Workflow

1. Confirm with the user before canceling unless they passed `--force` (SIGKILL).
2. Parse `$ARGUMENTS` as `<job-id> [--force]`, then run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" cancel --job <job-id> [--force]
   ```
3. Report the response JSON. The exit code is the coarse-grained outcome; the JSON `status` field is the fine-grained reason.

### Statuses and exit codes

Exit `0` — cancel post-condition holds (process gone, never running, or signal sent):
- `status: "signaled"` — SIGTERM (or SIGKILL with `--force`) delivered to the verified pid.
- `status: "already_terminal"` — job is already `completed` / `failed` / `cancelled` / `stale`; nothing to do.
- `status: "already_dead"` — pid is gone; no signal was sent.
- `status: "cancel_pending"` — job was queued (worker not yet spawned target). A marker was written; the worker will refuse to spawn on pickup and finalize as `cancelled`.

Exit `1` — operational error (cancel could not be performed):
- `error: "bad_args"` — invalid arguments (missing `--job`, conflicting flags).
- `error: "not_found"` — no job with that id in this workspace.
- `error: "bad_state"` — job has an unrecognized `status` (state corruption); refuse to act on it.
- `error: "signal_failed"` — OS signal attempt failed; surface the returned `message`, `pid`, and `signal`.
- `status: "cancel_failed"` — job is queued but the cancel marker write threw (disk full, permissions, parent dir vanished). The cancel intent is NOT durably recorded; the worker may still spawn the target.

Exit `2` — refused for safety (process may still be running, ownership unverifiable):
- `status: "no_pid_info"` — running job has no pid_info, or pid_info is missing `starttime` / `argv0` (legacy record, spawn race, or `ps`/`/proc` was unavailable at spawn). Operator must investigate.
- `status: "unverifiable"` — could not re-verify pid ownership at cancel time (`ps`/`/proc` unavailable). Operator must investigate.
- `status: "stale_pid"` — recorded `starttime` or `argv0` no longer matches the live process at that pid; the pid was reused. Refused to avoid signaling an unrelated process.

## Guardrails

- This command is for background jobs only. Foreground runs are owned by the active terminal; interrupt them with Ctrl+C.
- Default signal is SIGTERM (graceful). Only use SIGKILL with `--force`.
- PID-liveness AND ownership check (`{starttime, argv0}` tuple) runs before signaling — a bare pid match is not sufficient to authorize a kill.
- For shell pipelines that want best-effort cancel: append `|| true` to absorb exit 2 (refused-for-safety) when ps/proc is unavailable.
