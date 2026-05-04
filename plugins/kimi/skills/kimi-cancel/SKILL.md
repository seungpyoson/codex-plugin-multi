---
name: kimi-cancel
description: Use when cancelling a running Kimi-plugin background job.
user-invocable: true
---

# Kimi Cancel

Use the Kimi companion cancel workflow. Current Codex builds expose it as `kimi:kimi-cancel` in the skill picker; its skill frontmatter name is `kimi-cancel`; the command contract is `plugins/kimi/commands/kimi-cancel.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the workspace where the job was launched; `<job-id>` is the identifier returned by a background launch or listed by the status workflow. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" cancel --cwd "<workspace>" --job "<job-id>"
```

Confirm before cancelling unless the user already requested force. Foreground runs should be interrupted with Ctrl+C.
