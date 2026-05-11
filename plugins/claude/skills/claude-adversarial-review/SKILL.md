---
name: claude-adversarial-review
description: Use when asking Claude Code to challenge a design or diff adversarially.
user-invocable: true
---

# Claude Adversarial Review

Use the Claude companion adversarial-review workflow. Current Codex builds expose it as `claude:claude-adversarial-review` in the skill picker; its skill frontmatter name is `claude-adversarial-review`; the command contract is `plugins/claude/commands/claude-adversarial-review.md`.

`<plugin-root>` is `plugins/claude` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" run --mode=adversarial-review --foreground --auth-mode subscription --lifecycle-events jsonl --cwd "<workspace>" -- "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--`.

Render findings by severity, render `external_review_launched` as soon as it appears, then render `external_review` before normal prose when present, and surface any `mutations`. Do not claim `/claude-adversarial-review` is available in Codex builds that do not register plugin command files.
