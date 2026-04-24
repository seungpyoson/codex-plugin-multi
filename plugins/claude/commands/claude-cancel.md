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
   - `status: "cancelled"` → job received SIGTERM (and SIGKILL with `--force`); cmdCancel wrote the authoritative cancelled JobRecord.
   - `status: "already_terminal"` → job already reached completed / failed / cancelled / stale; nothing to do.
   - `status: "already_dead"` → PID gone; the companion wrote a `status=stale` record so observers reconcile.
   - `status: "stale_pid"` → PID reused by an unrelated process (starttime / argv0 drift). Refused signaling; record set to `status=stale`.

## Guardrails

- Default signal is SIGTERM (graceful). Only escalate to SIGKILL with `--force`.
- PID-liveness check runs before signaling — guards against PID reuse.
