---
name: kimi-adversarial-review
description: Use when asking Kimi Code CLI to challenge a design or diff adversarially.
user-invocable: true
---

# Kimi Adversarial Review

Use the Kimi companion adversarial-review workflow. Current Codex builds expose it as `kimi:kimi-adversarial-review` in the skill picker; its skill frontmatter name is `kimi-adversarial-review`; the command contract is `plugins/kimi/commands/kimi-adversarial-review.md`.

`<plugin-root>` is `plugins/kimi` or an absolute path to that plugin directory; `<workspace>` is the repository or bundle directory to review; `<focus>` is the user's review prompt or focus area. Run:

```bash
node "<plugin-root>/scripts/kimi-companion.mjs" run --mode=adversarial-review --foreground --cwd "<workspace>" -- "<focus>"
```

If the user provides them, add `--scope-base REF` and/or
`--max-steps-per-turn N` before `--`; `N` must be a positive integer.

Render findings by severity, render `external_review` before normal prose when present, and surface any `mutations`. Do not claim `/kimi-adversarial-review` is available in Codex builds that do not register plugin command files.
