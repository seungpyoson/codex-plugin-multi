---
name: claude-status
description: Use when listing active or recent Claude-plugin jobs for the current workspace.
user-invocable: true
---

# Claude Status

Use the Claude companion status workflow. Current Codex builds expose it as `claude:claude-status` in the skill picker; its skill frontmatter name is `claude-status`; the command contract is `plugins/claude/commands/claude-status.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" status --cwd "<workspace>" --all
```

Render `job_id`, `status`, `mode`, `model`, `started_at`, and `ended_at`. Do not expose sidecar paths unless explicitly asked.
