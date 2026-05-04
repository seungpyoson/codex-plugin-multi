---
name: deepseek-setup
description: Use when checking DeepSeek direct API reviewer readiness.
user-invocable: true
---

# DeepSeek Setup

Use the API reviewer DeepSeek setup workflow. Current Codex builds expose it as `api-reviewers:deepseek-setup` in the skill picker; its skill frontmatter name is `deepseek-setup`; the command contract is `plugins/api-reviewers/commands/deepseek-setup.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek
```

Show `summary`, `ready`, `next_action`, and credential key names only.
