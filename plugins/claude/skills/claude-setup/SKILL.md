---
name: claude-setup
description: Use when checking Claude Code installation and OAuth readiness for the Claude plugin.
user-invocable: true
---

# Claude Setup

Use the Claude companion setup workflow. Current Codex builds expose it as `claude:claude-setup` in the skill picker; its skill frontmatter name is `claude-setup`; the command contract is `plugins/claude/commands/claude-setup.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" doctor
```

Show `summary`, `ready`, and `next_action` exactly. If `status` is `oauth_inference_rejected`, report that Claude OAuth status is present but non-interactive `claude -p` inference failed, so Claude review slots are not ready. If `status` is `sandbox_blocked`, report that `~/.claude` must be added to Codex `writable_roots` and a fresh Codex session is required. Never print secret values or suggest Claude API keys for subscription/OAuth setup.
