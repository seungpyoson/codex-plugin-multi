---
name: gemini-result
description: Use when showing the persisted result for a Gemini-plugin job.
user-invocable: true
---

# Gemini Result

Use the Gemini companion result workflow. Current Codex builds expose it as `gemini:gemini-result` in the skill picker; its skill frontmatter name is `gemini-result`; the command contract is `plugins/gemini/commands/gemini-result.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" result --cwd "<workspace>" --job "<job-id>"
```

Render the returned JobRecord. Do not expose sidecar paths unless explicitly asked.
