---
name: kimi-status
description: Use when listing active or recent Kimi-plugin jobs for the current workspace.
user-invocable: true
---

# Kimi Status

Use the Kimi companion status workflow. Current Codex builds expose it as `kimi:kimi-status` in the skill picker; its skill frontmatter name is `kimi-status`; the command contract is `plugins/kimi/commands/kimi-status.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" status --cwd "<workspace>" --all
```

Render `job_id`, `status`, `mode`, `model`, `started_at`, and `ended_at`. Do not expose sidecar paths unless explicitly asked.
