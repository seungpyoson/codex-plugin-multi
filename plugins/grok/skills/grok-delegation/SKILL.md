---
name: grok-delegation
description: Delegate review, adversarial review, custom review, and setup checks to Grok Web.
user-invocable: true
---

# Grok Delegation

Use this skill when the user wants Codex to ask Grok for a review through the
user's Grok subscription. This plugin uses a subscription-backed local Grok web
tunnel. It must not silently fall back to paid xAI API billing.

## Setup Check

Run:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs doctor
```

Render `summary`, `endpoint`, `auth_mode`, and `next_action`. Show credential
key names only. Never print cookie, token, or tunnel API-key values.
The setup check makes a live `GET /models` probe against the local tunnel.
Treat `ready: true` and `reachable: true` as evidence that the
subscription-backed tunnel is reachable. If it returns `tunnel_unavailable`,
tell the user to start the local Grok web tunnel and retry.

## Review

Run foreground reviews with:

```bash
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode review --scope branch-diff --foreground --prompt "<focus>"
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode adversarial-review --scope branch-diff --foreground --prompt "<focus>"
node plugins/grok/scripts/grok-web-reviewer.mjs run --mode custom-review --scope custom --scope-paths "<file1>,<file2>" --foreground --prompt "<focus>"
```

If the user provides a base ref for branch-diff review modes, add
`--scope-base REF` before `--prompt`. Use `<focus>` as the user's review prompt
or focus area. Replace `<file1>,<file2>` with comma- or newline-separated concrete relative paths; expand globs before running.

If the command fails, report `error_code`, `error_message`, and
`suggested_action` from the JobRecord. If present, render `external_review` before the review result.

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

Do not recommend direct xAI API keys as a fallback for Grok subscription mode. If the
local tunnel is unavailable, tell the user to start or repair the tunnel.
