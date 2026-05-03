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

`custom-review` sends the exact `--scope-paths` file contents to the direct API
provider. It does not gitignore-filter explicitly selected files. Do not include
secrets, credentials, private keys, `.env` files, or other sensitive local-only
content.

If the command fails, report `error_code`, `error_message`, and `suggested_action` from the JobRecord. Do not expose API keys.
If `external_review` is present, render it before the review result.

Launch/result card:

```text
+---------------- EXTERNAL REVIEW ----------------+
| Provider  <external_review.provider>            |
| Job       <external_review.job_id>              |
| Session   <external_review.session_id|pending>  |
| Run       <external_review.run_kind>            |
| Scope     <external_review.scope>[, base=...]   |
+-------------------------------------------------+
Disclosure: <external_review.disclosure>
```

Wait/status rail:

```text
| EXTERNAL | <provider> - <job_id> - <status>
| EXTERNAL | <run_kind> - <scope>[, base=<scope_base>]
```

For multiple provider results, render one card/rail per `external_review`.
If `external_review.disclosure` is already rendered, do not repeat an
identical `disclosure_note` or a `disclosure_note` that restates a scope failure
was not sent before launch.
