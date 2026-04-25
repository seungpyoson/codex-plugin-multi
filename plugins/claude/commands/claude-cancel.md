---
description: Cancel a running Claude-plugin background job. Use Ctrl+C for foreground runs.
argument-hint: "<job-id> [--force]"
---

## Workflow

1. Confirm with the user before canceling unless they passed `--force` (SIGKILL).
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" cancel --job "$ARGUMENTS"
   ```
3. Report the response JSON:
   - `status: "signaled"` → job received SIGTERM/SIGKILL.
   - `status: "already_terminal"` → nothing to do.
   - `status: "already_dead"` → PID gone; state will reconcile.

## Guardrails

- This command is for background jobs only. Foreground runs are owned by the active terminal; interrupt them with Ctrl+C.
- Default signal is SIGTERM (graceful). Only use SIGKILL with `--force`.
- PID-liveness check runs before signaling — guards against PID reuse.
