---
name: gemini-status
description: Use when listing active or recent Gemini-plugin jobs for the current workspace.
user-invocable: true
---

# Gemini Status

Use the Gemini companion status workflow. Current Codex builds expose it as `gemini:gemini-status` in the skill picker; its skill frontmatter name is `gemini-status`; the command contract is `plugins/gemini/commands/gemini-status.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" status --cwd "<workspace>" --all
```

Render `job_id`, `status`, `mode`, `model`, `started_at`, and `ended_at`. Do not expose sidecar paths unless explicitly asked.
