---
name: claude-result-handling
description: Internal guidance for rendering Claude-companion JSON output back to the user. Describes what to surface, what to suppress, and how to handle mutation warnings, permission denials, and schema-structured output.
user-invocable: false
---

# claude-result-handling — output rendering rules

This skill tells commands and subagents how to present companion JSON to the user.

## Success path

The companion's `run` result has this shape:

```json
{
  "ok": true,
  "job_id": "<uuid>",
  "mode": "review|adversarial-review|rescue",
  "model": "<full-id>",
  "workspace_root": "<abs-path>",
  "result": "<text from Claude — may be empty if --json-schema was used>",
  "structured_output": null | { ... },
  "permission_denials": [],
  "warning": "mutation_detected",          // only when mutations occurred
  "mutated_files": ["M path", ...]          // only with warning
}
```

Render in this order:

1. If `warning === "mutation_detected"`: render a **prominent** warning block:
   > ⚠️ <N> file(s) mutated during a read-only review:
   > - `<path>`
   > Do NOT auto-revert. The user decides.
2. If `structured_output` is non-null: render its fields. Treat `verdict`, `summary`, `findings[]` as primary if present (review/adversarial schema).
3. Else render `result` as Markdown.
4. If `permission_denials.length > 0`: render a small "Tools denied" footnote — informational, not alarming (this is expected for review mode).

## Failure path

When the companion exits non-zero OR `ok: false`:

```json
{ "ok": false, "error": "<code>", "message": "<human>" }
```

Render the `message` verbatim. Do NOT reinterpret. Common error codes:

- `bad_args` — user passed invalid flags. Echo the message.
- `no_model` — `config/models.json` is empty and `--model` missing. Tell the user to run `/claude-setup`.
- `spawn_failed` — `claude` binary not found or crashed. Tell the user to run `/claude-setup`.
- `not_implemented` — subcommand isn't wired yet. Cite the message.
- `not_found` — job_id doesn't exist in this workspace. Suggest `/claude-status --all`.

## Long-running jobs

When `run` was invoked with `--background`, the response is:

```json
{ "event": "launched", "job_id": "<uuid>", "target": "claude", "mode": "...", "pid": 12345 }
```

Render as:

> Started Claude rescue job `<uuid>`. Check progress with `/claude-status <uuid>`; retrieve final output with `/claude-result <uuid>`.

## Cost/usage

Companion includes `cost_usd` and `usage` on successful runs. Under OAuth subscription, `apiKeySource` is `None` and the cost figure is the equivalent API cost (not a billing line). Render in a small footer ONLY when the user asked about cost; otherwise suppress.
