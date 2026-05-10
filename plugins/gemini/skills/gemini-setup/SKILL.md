---
name: gemini-setup
description: Use when checking Gemini CLI availability and OAuth readiness.
user-invocable: true
---

# Gemini Setup

Use the Gemini companion setup workflow. Current Codex builds expose it as `gemini:gemini-setup` in the skill picker; its skill frontmatter name is `gemini-setup`; the command contract is `plugins/gemini/commands/gemini-setup.md`.

`<plugin-root>` is `plugins/gemini` or an absolute path to that plugin directory. Run:

```bash
node "<plugin-root>/scripts/gemini-companion.mjs" doctor
```

Show `summary`, `ready`, `next_action`, and any model fallback diagnostics. If `status` is `sandbox_blocked`, report that `~/.gemini` must be added to Codex `writable_roots` and a fresh Codex session is required. Never print secret values.
