---
name: claude-result-handling
description: Internal guidance for rendering Claude-companion JobRecord JSON output back to the user. Describes the canonical JobRecord schema (§21.3), what to surface, what to suppress, and how to handle mutation warnings, permission denials, and schema-structured output.
user-invocable: false
---

# claude-result-handling — output rendering rules

This skill tells commands and subagents how to present companion JSON to the user.

The companion returns the SAME JSON shape from three entry points — foreground
`run`, `status --job`, and `result --job`. That one shape is the **JobRecord**
(spec §21.3). Nothing is hand-assembled in memory; what goes to disk is what
comes back to you.

## Success path — JobRecord schema (v6)

```json
{
  "id":                  "<uuid>",          // legacy alias for job_id
  "job_id":              "<uuid>",          // companion-minted per invocation
  "target":              "claude",
  "parent_job_id":       null | "<uuid>",   // set by `continue`; null on fresh runs
  "claude_session_id":   null | "<uuid>",   // from Claude's stdout, not minted
  "gemini_session_id":   null,              // present for schema parity; Gemini uses it
  "resume_chain":        ["<uuid>", ...],   // newest-last; [] on first run
  "pid_info":            null | { "pid": N, "starttime": "...", "argv0": "..." },

  "mode":                "review|adversarial-review|rescue|ping",
  "mode_profile_name":   "review|adversarial-review|rescue|ping",
  "model":               "<full-id>",
  "cwd":                 "<abs-path>",
  "workspace_root":      "<abs-path>",
  "containment":         "none|worktree",
  "scope":               "working-tree|branch-diff|staged|head|custom",
  "dispose_effective":   true | false,      // whether containment was disposed
  "scope_base":          null | "<ref>",    // e.g., "main" for branch-diff
  "scope_paths":         null | ["<glob>"], // custom scope globs if any

  "prompt_head":         "<first 200 chars>", // spec §21.3.1 — no full prompt persisted
  "schema_spec":         null | "<json-schema-string>",
  "binary":              "claude",

  "status":              "queued|running|completed|failed|cancelled|stale",
  "started_at":          "<iso-8601>",
  "ended_at":            null | "<iso-8601>",
  "exit_code":           null | 0 | 1 | 2,
  "error_code":          null | "spawn_failed" | "claude_error" | "parse_error" | "timeout",
  "error_message":       null | "<human>",

  "result":              null | "<text from Claude>",  // null on queued; "" allowed on schema runs
  "structured_output":   null | { ... },                // populated on --json-schema runs
  "permission_denials":  [{ "tool": "Bash", ... }, ...],
  "mutations":           ["M path", "?? path", "mutation_detection_failed: ...", ...],
  "cost_usd":            null | 0.001,
  "usage":               null | { "input_tokens": N, ... },

  "schema_version":      6
}
```

**Every field above is ALWAYS present** (nullable fields hold `null`, not
`undefined`). If a field you see in this doc is missing from a record you
received, the companion has a bug — don't paper over it.

`staged`, `head`, and `branch-diff` scopes are git object-pure snapshots:
checkout filters, LFS smudge, EOL conversion, textconv, hooks, and
config-defined shell commands are not applied, and replace refs and grafts are
ignored. `working-tree` and `custom` reflect live filesystem content.

## Rendering order

1. **Mutation warning (derived — not a top-level field).** If
   `mutations.length > 0`: render a **prominent** warning block. Partition
   entries beginning with `mutation_detection_failed:` from ordinary git-status
   entries:
   > ⚠️ Mutation detection could not be verified during a read-only review:
   > - `mutation_detection_failed: <reason>`
   >
   > ⚠️ Mutation status changed during a read-only review:
   > - `M path`
   > Do NOT auto-revert. The user decides.

   There is NO `warning` field on the JobRecord. The `mutations` array IS
   the signal; its length is the severity.

2. **Structured output.** If `structured_output` is non-null: render its
   fields. Treat `verdict`, `summary`, `findings[]` as primary if present
   (review/adversarial schema).

3. **Text result.** Else render `result` as Markdown. When `status ===
   "completed"`, `result` may be an empty string on schema-only runs — that
   is not an error, it means the model's output lived in `structured_output`.

4. **Permission denials.** If `permission_denials.length > 0`: render a small
   "Tools denied" footnote — informational, not alarming (this is expected
   for review mode).

5. **Cost/usage.** Include `cost_usd` and `usage` in a small footer ONLY
   when the user asked about cost; otherwise suppress. Under OAuth
   subscription the figure is the equivalent API cost (not a billing line).

## Failure path

`status === "failed"` records carry the same shape; inspect `error_code`:

- `spawn_failed` — `claude` binary not found or crashed before JSON output.
  Tell the user to run `/claude-setup`. `error_message` has the spawn detail.
- `claude_error` — Claude ran but returned `is_error: true`. `result` may
  still contain partial text worth showing.
- `parse_error` — Claude's stdout wasn't valid JSON. Rare; usually a CLI
  upgrade mismatch. `error_message` has the parser error.
- `timeout` — the companion's watchdog killed the child. No partial output.
- `not_found` — (only from `result --job` / `status --job`) the `job_id`
  doesn't exist in this workspace. Suggest `/claude-status --all`.

Render `error_message` verbatim when present. Do NOT reinterpret.

## Background-launch response

`run --background` is the only entry point that does NOT return a JobRecord.
It returns a launch envelope:

```json
{ "event": "launched", "job_id": "<uuid>", "target": "claude", "mode": "...",
  "pid": 12345, "workspace_root": "<abs-path>" }
```

Render as:

> Started Claude rescue job `<uuid>`. Check progress with `/claude-status
> <uuid>`; retrieve final output with `/claude-result <uuid>`.

When the user runs `/claude-result <uuid>`, they receive the full JobRecord —
same schema as foreground — with `result`, `structured_output`,
`permission_denials`, `mutations`, `cost_usd`, and `usage` populated. That
symmetry is the point of the schema (§21.3.2).
