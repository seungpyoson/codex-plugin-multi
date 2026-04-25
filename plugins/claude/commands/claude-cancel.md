---
description: Cancel a running Claude-plugin background job. Use --force for SIGKILL.
argument-hint: "<job-id> [--force]"
---

## Workflow

1. Confirm with the user before canceling unless they passed `--force` (SIGTERM-then-SIGKILL).
2. Run:
   ```
   node "<plugin-root>/scripts/claude-companion.mjs" cancel --job "$ARGUMENTS"
   ```
3. Report the response JSON:
   - `status: "signaled"` → job received SIGTERM/SIGKILL.
   - `status: "already_terminal"` → nothing to do.
   - `status: "already_dead"` → PID gone; state will reconcile.

## Guardrails

- Default signal is SIGTERM (graceful). Only escalate to SIGKILL with `--force`.
- PID-liveness check runs before signaling — guards against PID reuse.
