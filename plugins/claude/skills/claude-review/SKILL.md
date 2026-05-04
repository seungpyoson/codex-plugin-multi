---
name: claude-review
description: Use when asking Claude Code to review the current diff, files, or focus area.
user-invocable: true
---

# Claude Review

Use the Claude companion review workflow. Current Codex builds expose it as `claude:claude-review` in the skill picker; its skill frontmatter name is `claude-review`; the command contract is `plugins/claude/commands/claude-review.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review --foreground --cwd "<workspace>" -- "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--`.

Render companion JSON according to `claude-result-handling`; render `external_review` before normal prose when present. Do not claim `/claude-review` is available in Codex builds that do not register plugin command files.
