# Quickstart: No-Mistakes Provider Readiness

## Current evidence loop

```sh
npm run doctor:cache

tmp=$(mktemp -d /private/tmp/cpm-perfect-smoke-XXXXXX)
mkdir -p "$tmp/fixtures" "$tmp/records" "$tmp/evidence"
printf 'export function add(a, b) {\n  return a + b;\n}\n' > "$tmp/fixtures/smoke.js"
git -C "$tmp" init
git -C "$tmp" add fixtures/smoke.js
git -C "$tmp" -c user.name='Codex Smoke' -c user.email='codex-smoke@example.invalid' commit -m 'add smoke fixture'
```

Run provider doctors and source-bearing reviews from installed plugin cache.
Write each JSON artifact to:

| Provider | Required evidence files |
| --- | --- |
| Claude | `claude-doctor.json`, `claude-review.json` |
| Gemini | `gemini-doctor.json`, `gemini-review.json` |
| Kimi | `kimi-doctor.json`, `kimi-review.json` |
| Grok | `grok-doctor.json`, `grok-review.json` when source-bearing review is allowed |
| DeepSeek | `deepseek-doctor.json`, `deepseek-approval.json`, `deepseek-review.json` only after approval |
| GLM | `glm-doctor.json`, `glm-approval.json`, `glm-review.json` only after approval |

For direct API providers, run `approval-request` first. Do not run a
source-bearing review until the approval artifact shows
`source_content_transmission: "not_sent"` and the operator has approved the
returned token.

Build the manifest:

```sh
npm run readiness:manifest -- \
  --fixture-root "$tmp" \
  --evidence-dir "$tmp/evidence" \
  --out "$tmp/manifest.json"
```

The manifest is a normalizer, not a provider runner. It classifies missing
direct-API approval as `approval_gate`, Grok runtime-token issues as
`session_tokens`, audit failures as `review_quality`, parse failures as
`parser`, continuation failures as `continuation`, and persisted full prompt
keys as `full_prompt_found`. Each row includes `next_action` so sandbox,
approval, cache-install, tunnel, session-token, provider, parser, continuation,
and review-quality failures remain operator-actionable.

## Continuation smoke

After initial source-bearing reviews pass, run continuation for providers that
support follow-up:

```sh
# Provider-specific installed commands; use the plugin runtime paths, not ad hoc
# direct provider calls.
claude continue --job <claude-parent-job-id>
gemini continue --job <gemini-parent-job-id>
kimi continue --job <kimi-parent-job-id>
```

For each continue JobRecord, inspect:

- `parent_job_id`
- provider session id field, such as `claude_session_id`
- `runtime_diagnostics.child_cwd`
- `raw_output.stdout_bytes` / `raw_output.stderr_bytes`
- `error_code` / `error_message`
- `review_quality.failed_review_slot`

Claude continuation is not proven by `--resume <id>` alone. The parent and
continue records must show that the provider session lookup context is reused.
`No conversation found with session ID` is a continuation failure even when the
initial review passed.

## Semantic replay probes

Run two different probe classes:

1. Classifier-only snippets: assert targeted semantic reasons, for example that
   passing prose containing `without permission blocks` does not emit
   `permission_blocked`.
2. Full review-audit samples: include review-shaped output with verdict and
   enough substance to satisfy `missing_verdict` and `shallow_output` gates.

Do not mark a classifier-only snippet as failed because it lacks a full review
verdict. Do mark it failed when the targeted classifier reason is wrong.

## Workflow mutation gate

Before merge, push, issue closure, GitHub comment, or destructive cleanup, record
explicit current operator approval. If approval is absent or ambiguous, stop and
ask. Do not normalize an unapproved mutation after it happens.

## no-mistakes status

```sh
git push no-mistakes
no-mistakes
```

Repo config runs:

```sh
npm ci && npm run lint && npm run test:full
```

Keep the gate configured, but do not use no-mistakes as authoritative readiness
evidence while `seungpyoson/claude-config#780` is open. That bug can leave the
review/fix loop non-deterministic after partial fixes. Use direct local
verification plus GitHub CI for merge readiness until the shared tooling issue
is fixed.
