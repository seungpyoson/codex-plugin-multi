---
description: Delegate investigation, a fix, or follow-up rescue work to Claude Code. Background by default.
argument-hint: "[--model <id>] [--foreground] [what Claude should investigate or fix]"
---

Delegate long-running investigation or fix work to the `claude-rescue` subagent.

## Arguments

`$ARGUMENTS` — task description + optional flags. Passed as-is to the subagent.

## Workflow

1. Consult the `claude-prompting` skill for rescue-specific prompt framing.
2. Activate the `claude-rescue` subagent with the user's task. The subagent owns the full lifecycle:
   - Launches `claude-companion.mjs run --mode=rescue --background` (or `--foreground` if the user asked).
   - Returns the job ID immediately for background runs; for foreground, waits and renders.
   - On failure, surfaces stderr verbatim.
3. If the subagent returns a job_id, suggest the user run `/claude-status` and `/claude-result <id>` for progress + output.

## Guardrails

- Rescue runs with `--permission-mode acceptEdits` — writes are allowed. This is intentional.
- Rescue's profile sets `containment=none` (writes land in the user's tree by design, spec §21.4). There is no flag to "sandbox" rescue — that would be a different mode.
- Only escalate to SIGKILL on user request via `/claude-cancel <id> --force`.
