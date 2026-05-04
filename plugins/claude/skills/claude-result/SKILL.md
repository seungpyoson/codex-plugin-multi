---
name: claude-result
description: Use when showing the stored result of a finished Claude-plugin job.
user-invocable: true
---

# Claude Result

Use the Claude companion result workflow. Current Codex builds expose it as `claude:claude-result` in the skill picker; its skill frontmatter name is `claude-result`; the command contract is `plugins/claude/commands/claude-result.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
```

Render companion JSON according to `claude-result-handling`. Do not re-run the job.
