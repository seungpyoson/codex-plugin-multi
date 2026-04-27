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
3. Report the response JSON:
   - `status: "signaled"` → job received SIGTERM/SIGKILL.
   - `status: "already_terminal"` → nothing to do.
   - `status: "already_dead"` → PID gone; state will reconcile.
   - `status: "no_pid_info"` → job lacks complete PID ownership proof; do not signal manually unless the operator accepts that risk.
   - `status: "stale_pid"` → PID ownership proof changed; refuse to signal because the PID may have been reused.
   - `status: "signal_failed"` → OS signal attempt failed; surface the returned error details.

## Guardrails

- This command is for background jobs only. Foreground runs are owned by the active terminal; interrupt them with Ctrl+C.
- Default signal is SIGTERM (graceful). Only use SIGKILL with `--force`.
- PID-liveness check runs before signaling — guards against PID reuse.
