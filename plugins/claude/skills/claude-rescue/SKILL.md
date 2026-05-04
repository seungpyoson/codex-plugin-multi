---
name: claude-rescue
description: Use when delegating investigation, fixes, or follow-up rescue work to Claude Code.
user-invocable: true
---

# Claude Rescue

Use the Claude companion rescue workflow. Current Codex builds expose it as `claude:claude-rescue` in the skill picker; its skill frontmatter name is `claude-rescue`; the command contract is `plugins/claude/commands/claude-rescue.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the repository where the rescue task should run. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" run --mode=rescue --background --cwd "<workspace>" -- "<task>"
```

Rescue is write-capable by design. Prefer review skills for read-only critique. Do not claim `/claude-rescue` is available in Codex builds that do not register plugin command files.
