---
name: api-reviewers-delegation
description: Delegate review, adversarial review, custom review, and setup to DeepSeek/GLM.
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

Run reviews with:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode review --scope branch-diff --lifecycle-events jsonl --prompt "<focus>"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider glm --mode adversarial-review --scope branch-diff --lifecycle-events jsonl --prompt "<focus>"
node plugins/api-reviewers/scripts/api-reviewer.mjs run --provider deepseek --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --lifecycle-events jsonl --prompt "<focus>"
```

For branch-diff review or adversarial-review, add `--scope-base REF` before `--prompt` when the user provides a base ref. Use `<focus>` as the user's review prompt or focus area.
Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths for `--scope-paths`; expand globs before running.
If the command fails, report `error_code`, `error_message`, and `suggested_action` from the JobRecord. Do not expose API keys.
Render `external_review_launched` as soon as it appears. If `external_review` is present, render it before the review result.

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
Render `run_kind: "unknown"` verbatim if encountered; do not infer foreground
or background from lifecycle fields.
If `external_review.disclosure` is already rendered, do not repeat an
identical `disclosure_note` or a `disclosure_note` that restates a scope failure
was not sent before launch.
