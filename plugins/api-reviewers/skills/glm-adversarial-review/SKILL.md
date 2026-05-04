---
name: glm-adversarial-review
description: Use when asking GLM direct API for an adversarial review.
user-invocable: true
---

# GLM Adversarial Review

Use the API reviewer GLM adversarial-review workflow. Current Codex builds expose it as `api-reviewers:glm-adversarial-review` in the skill picker; its skill frontmatter name is `glm-adversarial-review`; the command contract is `plugins/api-reviewers/commands/glm-adversarial-review.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode adversarial-review --scope branch-diff --prompt "<focus>"
```

If the user provides a base ref, add `--scope-base REF` before `--prompt`. `<focus>` is the user's review prompt or focus area.
Render the returned JobRecord, render `external_review` before the review result when present, and never print API-key values.
