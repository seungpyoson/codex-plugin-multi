---
name: glm-setup
description: Use when checking GLM direct API reviewer readiness.
user-invocable: true
---

# GLM Setup

Use the API reviewer GLM setup workflow. Current Codex builds expose it as `api-reviewers:glm-setup` in the skill picker; its skill frontmatter name is `glm-setup`; the command contract is `plugins/api-reviewers/commands/glm-setup.md`.

Run from the repository root:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm
```

Show `summary`, `ready`, `next_action`, and credential key names only.
