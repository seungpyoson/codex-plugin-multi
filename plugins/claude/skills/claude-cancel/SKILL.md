---
name: claude-cancel
description: Use when cancelling a running Claude-plugin background job.
user-invocable: true
---

# Claude Cancel

Use the Claude companion cancel workflow. Current Codex builds expose it as `claude:claude-cancel` in the skill picker; its skill frontmatter name is `claude-cancel`; the command contract is `plugins/claude/commands/claude-cancel.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" cancel --cwd "<workspace>" --job "<job-id>"
```

Confirm before cancelling unless the user already requested force. Foreground runs should be interrupted with Ctrl+C.
