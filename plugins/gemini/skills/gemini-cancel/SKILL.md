---
name: gemini-cancel
description: Use when cancelling a running Gemini-plugin background job.
user-invocable: true
---

# Gemini Cancel

Use the Gemini companion cancel workflow. Current Codex builds expose it as `gemini:gemini-cancel` in the skill picker; its skill frontmatter name is `gemini-cancel`; the command contract is `plugins/gemini/commands/gemini-cancel.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" cancel --cwd "<workspace>" --job "<job-id>"
```

Confirm before cancelling unless the user already requested force. Foreground runs should be interrupted with Ctrl+C.
