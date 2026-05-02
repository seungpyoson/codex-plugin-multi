---
name: api-reviewers-delegation
description: Delegate review, adversarial review, custom review, setup checks, and result rendering to direct API-backed DeepSeek and GLM reviewers.
user-invocable: true
---

# API Reviewers Delegation

Use this skill when the user wants Codex to ask DeepSeek or GLM for a review without manually relaying prompts.

The providers are API-key backed by policy. Do not suggest that API keys are a fallback for Claude, Gemini, or Kimi subscription/OAuth providers.

## Setup Check

Run one of:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek
node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm
```

Render the JSON fields directly:

- Always show `summary`.
- If `ready: true`, report ready.
- If `ready: false`, show `next_action` exactly.
- If `credential_ref` is present, show the key name only.
- Never print or ask for secret values.

## Review

Run foreground reviews with:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode review --scope branch-diff --foreground --prompt "$PROMPT"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode adversarial-review --scope branch-diff --foreground --prompt "$PROMPT"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "$FILES" --foreground --prompt "$PROMPT"
```

If the command fails, report `error_code`, `error_message`, and `suggested_action` from the JobRecord. Do not expose API keys.
If `external_review` is present, render an EXTERNAL REVIEW box before the
review result and preserve the provider name, job ID, run kind, scope, and
disclosure text.
