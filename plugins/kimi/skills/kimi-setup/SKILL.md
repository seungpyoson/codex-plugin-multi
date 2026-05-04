---
name: kimi-setup
description: Use when checking Kimi Code CLI availability and OAuth readiness.
user-invocable: true
---

# Kimi Setup

Use the Kimi companion setup workflow. Current Codex builds expose it as `kimi:kimi-setup` in the skill picker; its skill frontmatter name is `kimi-setup`; the command contract is `plugins/kimi/commands/kimi-setup.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" doctor
```

Show `summary`, `ready`, `next_action`, and any model fallback diagnostics. Never print secret values.
