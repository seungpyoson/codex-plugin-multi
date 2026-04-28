---
name: claude-cli-runtime
description: Internal contract for invoking the claude-companion runtime from plugin commands and subagents. Describes subcommand surface, argv conventions, and the exact invocation snippets for review, adversarial-review, and rescue.
user-invocable: false
---

# claude-cli-runtime — invocation contract

This skill documents the exact way commands and the rescue subagent should invoke `claude-companion.mjs`. Commands retrieve this skill so they never need to embed the companion path or flag surface directly in their body text.

## Plugin root

Commands resolve the companion via the `<plugin-root>` placeholder. In practice, Codex expands this to the directory containing `.codex-plugin/plugin.json`. The companion itself re-resolves its root via `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` — callers do not need to compute the path.

## Subcommand surface

```
claude-companion.mjs run     --mode=review|adversarial-review|rescue
                             [--foreground|--background]
                             [--model <full-id>] [--cwd <path>]
                             [--scope-base <ref>] [--scope-paths <g1,g2,…>]
                             [--override-dispose <true|false>]
                             [--schema <json>] [--binary <path>]
                             -- <prompt>

claude-companion.mjs ping    [--model <id>] [--binary <path>] [--timeout-ms <ms>]
claude-companion.mjs status  [--job <id>] [--cwd <path>] [--all]
claude-companion.mjs result  --job <id> [--cwd <path>]
claude-companion.mjs cancel  --job <id> [--cwd <path>] [--force]
```

## Invocation conventions

- **Argv transport** (Claude-specific): the prompt text is the last argv positional after `--`. No shell interpolation — `child_process.spawn` passes argv bytes verbatim. Verified safe at 100 KB (spec §4.10).
- **No aliases**: pass full model IDs (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). Aliases silently substitute (spec §4.2).
- **Git-derived scopes**: `staged`, `head`, and `branch-diff` are object-pure; checkout filters, replace refs, and grafts are ignored. `working-tree` reflects live filesystem content for tracked + untracked-non-ignored files only — gitignored files (e.g. `.env`) are excluded by default for privacy; use `custom` with explicit globs when ignored files must be included. **Privacy contract:** the gitignored-file filter only applies inside a git worktree (where `git ls-files --others --ignored --exclude-standard` can answer the question). In non-git source directories, `working-tree` falls back to an unfiltered live filesystem walk with symlink/path safety only — there is no `.gitignore` to honor, so callers must not rely on it for secret hiding outside a git repo. Inside a git worktree, transient `git ls-files` failures (e.g., `index.lock` contention during a concurrent `git gc`) retry with a short backoff before the run fails closed.
- **Session IDs**: the companion mints a UUID v4 `job_id`, passes it to fresh Claude runs as `--session-id`, then persists `claude_session_id` from Claude's JSON stdout. Callers do not supply session IDs.
- **Timeouts**: companion does not enforce a wall-clock timeout by default. Tests pass `--timeout-ms` to the process wrapper directly.
- **Cancel scope**: `cancel` is for background jobs only. Foreground runs stay attached to the active terminal and should be interrupted with Ctrl+C.

## Flag-stack per mode (enforced by `lib/claude.mjs`)

Callers do not pass the inner flags — the companion adds them. This is documentation of what the child `claude -p` actually receives.

- **review / adversarial-review**: `--setting-sources "" --permission-mode plan --disallowedTools "Write Edit MultiEdit NotebookEdit Bash WebFetch Agent Task mcp__*" --no-session-persistence --output-format json --session-id <uuid> --model <id>`. Optionally `--add-dir <cwd>` + `--json-schema <schema>`.
- **rescue**: `--permission-mode acceptEdits --no-session-persistence --output-format json --session-id <uuid> --model <id> --add-dir <cwd>`. No disallowed-tools blocklist and no `--setting-sources ""` — rescue is write-capable and keeps project context by design.

## Output contract

Companion stdout is always a single JSON object:

- `run`/`ping`/`status`/`result`/`cancel`: well-formed JSON per the subcommand's documented shape.
- Exit 0 on success; 2 on operational failure (spawn failed, not-authed, etc.); 1 on bad arguments.

## Guardrails

- Do NOT set `ANTHROPIC_API_KEY` or any `*_API_KEY` env var. The companion explicitly relies on OAuth via the `claude` binary.
- Do NOT call `claude` directly from command bodies. Everything goes through the companion so the job store, mutation detection, and session ID roundtrip work.
- Do NOT pass `--override-dispose false` without explicit user ask on review paths — containment/scope/dispose are per-profile decisions (spec §21.4) and the default should only be overridden for operator debugging.
