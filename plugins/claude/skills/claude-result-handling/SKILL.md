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

## Success path — JobRecord schema (v10)

```json
{
  "id":                  "<uuid>",          // legacy alias for job_id
  "job_id":              "<uuid>",          // companion-minted per invocation
  "target":              "claude",
  "parent_job_id":       null | "<uuid>",   // set by `continue`; null on fresh runs
  "claude_session_id":   null | "<uuid>",   // from Claude's stdout, not minted
  "gemini_session_id":   null,              // present for schema parity; Gemini uses it
  "kimi_session_id":     null,              // present for schema parity; Kimi uses it
  "resume_chain":        ["<uuid>", ...],   // newest-last; [] on first run
  "pid_info":            null | { "pid": N, "starttime": "...", "argv0": "..." },

  "mode":                "review|adversarial-review|custom-review|rescue|ping",
  "mode_profile_name":   "review|adversarial-review|custom-review|rescue|ping",
  "model":               "<full-id>",
  "cwd":                 "<abs-path>",
  "workspace_root":      "<abs-path>",
  "containment":         "none|worktree",
  "scope":               "working-tree|branch-diff|staged|head|custom",
  "dispose_effective":   true | false,      // whether containment was disposed
  "scope_base":          null | "<ref>",    // e.g., "main" for branch-diff
  "scope_paths":         null | ["<glob>"], // custom scope globs if any

  "prompt_head":         "<first 200 chars>", // spec §21.3.1 — no full prompt persisted
  "review_metadata":     null | {
    "prompt_contract_version": 1,
    "prompt_provider":  "Claude Code|Gemini CLI|Kimi",
    "scope":            "working-tree|branch-diff|staged|head|custom",
    "scope_base":       null | "<ref>",
    "scope_paths":      null | ["<glob>"],
    "raw_output":       null | {
      "stdout_bytes":   0,
      "stderr_bytes":   0,
      "parsed_ok":      null | true | false,
      "result_chars":   null | 0
    }
  },
  "schema_spec":         null | "<json-schema-string>",
  "binary":              "claude",

  "status":              "queued|running|completed|failed|cancelled|stale",
  "started_at":          "<iso-8601>",
  "ended_at":            null | "<iso-8601>",
  "exit_code":           null | 0 | 1 | 2,
  "error_code":          null | "scope_failed" | "spawn_failed" | "claude_error" | "gemini_error" | "kimi_error" | "parse_error" | "oauth_inference_rejected" | "step_limit_exceeded" | "usage_limited" | "finalization_failed" | "timeout" | "stale_active_job",
  "error_message":       null | "<human>",
  "error_summary":       null | "<short operator-facing summary>",
  "error_cause":         null | "<why this happened>",
  "suggested_action":    null | "<what to do next>",
  "external_review":     {
    "marker":            "EXTERNAL REVIEW",
    "provider":          "Claude Code",
    "run_kind":          "foreground|background|unknown",
    "job_id":            "<uuid>",
    "session_id":        null | "<provider session id>",
    "parent_job_id":     null | "<uuid>",
    "mode":              "review|adversarial-review|custom-review|rescue|ping",
    "scope":             "working-tree|branch-diff|staged|head|custom",
    "scope_base":        null | "<ref>",
    "scope_paths":       null | ["<glob>"],
    "source_content_transmission": "not_sent|may_be_sent|sent|unknown",
    "disclosure":        "<external disclosure statement>"
  },
  "disclosure_note":     null | "<what was or was not sent externally>",
  "runtime_diagnostics": null | {
    "add_dir":           null | "<exact --add-dir path>",
    "child_cwd":         null | "<exact child process cwd>",
    "scope_path_mappings": [
      {
        "original":      "<source repo path>",
        "contained":     "<contained copied path>",
        "relative":      "<relative selected path>",
        "inside_add_dir": true | false
      }
    ],
    "permission_denials": [
      {
        "tool":          null | "<tool>",
        "target":        null | "<path or denied target>",
        "inside_add_dir": null | true | false,
        "relative_to_add_dir": null | "<relative path>"
      }
    ]
  },

  "result":              null | "<text from Claude>",  // null on queued; "" allowed on schema runs
  "structured_output":   null | { ... },                // populated on --json-schema runs
  "permission_denials":  [{ "tool": "Bash", ... }, ...],
  "mutations":           ["M path", "?? path", "mutation_detection_failed: ...", ...],
  "cost_usd":            null | 0.001,
  "usage":               null | { "input_tokens": N, ... },

  "schema_version":      10
}
```

**Every field above is ALWAYS present** (nullable fields hold `null`, not
`undefined`). If a field you see in this doc is missing from a record you
received, the companion has a bug — don't paper over it.

`staged`, `head`, and `branch-diff` scopes are git object-pure snapshots:
checkout filters, LFS smudge, EOL conversion, textconv, hooks, and
config-defined shell commands are not applied, and replace refs and grafts are
ignored. `working-tree` reflects live filesystem content for **tracked +
untracked-non-ignored** files only — gitignored files (e.g. `.env`) are
excluded by default to avoid exposing secrets to the target model. Use
`custom` with explicit globs when a caller deliberately needs to include
ignored files.

**Privacy contract scope.** The gitignored-file filter only applies when the
source directory is inside a git worktree. In a non-git folder, `working-tree`
runs an unfiltered live filesystem walk with symlink/path safety only — there
is no `.gitignore` to consult, so secrets in `.env`-style files in non-git
directories will be visible to the target model unless the caller switches to
`custom` with a curated glob list. Inside a git worktree, `git ls-files
--others --ignored --exclude-standard` is retried briefly on transient
failures (concurrent `git gc` / `index.lock` race) before the run fails
closed — operators should not see spurious `scope_population_failed` reports
from short-lived index contention.

## Rendering order

1. **External review banner.** If `external_review_launched` is present, render it immediately from that lifecycle line's
   `external_review` field. If `external_review` is present on the terminal JobRecord, render it before findings or status prose.
   Background runs keep the legacy `event: "launched"` envelope, but render the same banner from its `external_review` field.
   Use the boxed card for launch/result:

   ```text
   +---------------------------- EXTERNAL REVIEW ---------------------------+
   | Provider  <external_review.provider>                                   |
   | Job       <external_review.job_id>                                     |
   | Session   <external_review.session_id|pending>                         |
   | Run       <external_review.run_kind>                                   |
   | Scope     <external_review.scope>[, base=<external_review.scope_base>] |
   +------------------------------------------------------------------------+
   Disclosure: <external_review.disclosure>
   ```

   For wait/status summaries, keep a persistent left rail:

   ```text
   | EXTERNAL | <external_review.provider> · <external_review.job_id> · <status>
   | EXTERNAL | <external_review.run_kind> · <external_review.scope>[, base=<external_review.scope_base>]
   ```

   For multiple providers, use one panel with one row per provider. Do not
   replace this marker with ordinary prose.
   Render `run_kind: "unknown"` verbatim. Do not infer foreground or
   background from `pid_info`, stale status, or historical fields.

2. **Mutation warning (derived — not a top-level field).** If
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

3. **Structured output.** If `structured_output` is non-null: render its
   fields. Treat `verdict`, `summary`, `findings[]` as primary if present
   (review/adversarial schema).

4. **Text result.** Else render `result` as Markdown. When `status ===
   "completed"`, `result` may be an empty string on schema-only runs — that
   is not an error, it means the model's output lived in `structured_output`.

5. **Permission denials.** If `permission_denials.length > 0` and there is no
   substantive `result` or `structured_output`, render **review blocked / no
   findings produced** and list the denied tools or paths. If findings are
   present, render a small "Tools denied" footnote — informational, not
   alarming (some tool attempts are expected for review mode).

6. **Cost/usage.** Include `cost_usd` and `usage` in a small footer ONLY
   when the user asked about cost; otherwise suppress. Under OAuth
   subscription the figure is the equivalent API cost (not a billing line).

## Failure path

`status === "failed"` records carry the same shape; inspect `error_code`:

- `spawn_failed` — `claude` binary not found or crashed before JSON output.
  Tell the user to run `/claude-setup`. `error_message` has the spawn detail.
- `scope_failed` — the companion refused to prepare the selected review scope
  before launching the target CLI. Render `error_summary`, `error_cause`,
  `suggested_action`, and `disclosure_note` before the raw `error_message`;
  if `external_review.disclosure` is already rendered, do not repeat an
  identical `disclosure_note` or a `disclosure_note` that restates a scope
  failure was not sent before launch.
  These failures are protective; rejected scope content was not sent to the
  target CLI or external provider.
- `claude_error` — Claude ran but returned `is_error: true`. `result` may
  still contain partial text worth showing.
- `oauth_inference_rejected` — Claude Code returned an HTTP 401 authentication
  rejection from non-interactive inference while the companion was using
  subscription/OAuth mode. Treat this as a failed review slot, not a model
  verdict or approval. Tell the user to run `/claude-setup`; `claude auth
  status` may be a false positive for review readiness.
- `gemini_error` / `kimi_error` — the corresponding external CLI ran but
  returned a target-level failure. `result` may contain partial text worth
  showing if present; otherwise use the structured diagnostic fields.
- `parse_error` — Claude's stdout wasn't valid JSON. Rare; usually a CLI
  upgrade mismatch. `error_message` has the parser error.
- `step_limit_exceeded` — Kimi exhausted its configured step budget after
  launch. Selected source content was sent; render the diagnostic fields and
  suggest continuing/resuming the job if a provider session id is available.
- `usage_limited` — Kimi reported a quota, usage-limit, billing-cycle, or
  credit-limit failure before returning JSON. Selected source content may have
  been sent; render `error_summary`, `error_cause`, and `suggested_action`.
- `finalization_failed` — the target ran, but the companion failed while
  writing the terminal record or state. Render the structured diagnostic
  fields and preserve `error_message`; this is an operator/storage failure,
  not a missing-binary or scope-preparation failure.
- `timeout` — the companion's watchdog killed the child. No partial output.
- `stale_active_job` — reconciliation promoted an orphaned queued/running
  record to stale because the worker process disappeared or never produced a
  terminal record. Render the record as continuable history; do not infer a
  more specific lifecycle from legacy fields.
- `not_found` — (only from `result --job` / `status --job`) the `job_id`
  doesn't exist in this workspace. Suggest `/claude-status --all`.

Render `error_message` verbatim when present. Do NOT reinterpret it; use the
structured diagnostic fields when present for the human explanation.

## Background-launch response

`run --background` is the only entry point that does NOT return a JobRecord.
It returns a launch envelope:

```json
{ "event": "launched", "job_id": "<uuid>", "target": "claude", "mode": "...",
  "pid": 12345, "workspace_root": "<abs-path>",
  "external_review": { "marker": "EXTERNAL REVIEW", "...": "..." } }
```

Render as:

```text
+---------------- EXTERNAL REVIEW ----------------+
| Provider  Claude Code                           |
| Job       <uuid>                                |
| Session   pending                               |
| Run       background                            |
| Scope     <scope>[, base=<scope_base>]          |
+-------------------------------------------------+
Disclosure: <external_review.disclosure>

Check progress with `/claude-status <uuid>`; retrieve final output with
`/claude-result <uuid>`.
```

When the user runs `/claude-result <uuid>`, they receive the full JobRecord —
same schema as foreground — with `result`, `structured_output`,
`permission_denials`, `mutations`, `cost_usd`, and `usage` populated. That
symmetry is the point of the schema (§21.3.2).
