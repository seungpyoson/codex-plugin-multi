---
name: grok-setup
description: Use when checking Grok Web local tunnel readiness.
user-invocable: true
---

# Grok Setup

Use the Grok Web setup workflow. Current Codex builds expose it as
`grok:grok-setup` in the skill picker; its skill frontmatter name is
`grok-setup`; the command contract is `plugins/grok/commands/grok-setup.md`.

Run from the repository root:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs doctor
```

Show `summary`, `ready`, `next_action`, and credential key names only. Never
print session cookies, tunnel API-key values, or bearer token values. If the
tunnel is unavailable, tell the user to start or repair the local Grok web
tunnel rather than adding direct xAI API keys.
