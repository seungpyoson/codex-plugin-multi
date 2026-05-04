---
name: kimi-result
description: Use when showing the persisted result for a Kimi-plugin job.
user-invocable: true
---

# Kimi Result

Use the Kimi companion result workflow. Current Codex builds expose it as `kimi:kimi-result` in the skill picker; its skill frontmatter name is `kimi-result`; the command contract is `plugins/kimi/commands/kimi-result.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
```

Render the returned JobRecord. Do not expose sidecar paths unless explicitly asked.
