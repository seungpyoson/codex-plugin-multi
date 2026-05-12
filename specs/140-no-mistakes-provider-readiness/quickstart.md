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
`session_tokens`, audit failures as `review_quality`, and persisted full prompt
keys as `full_prompt_found`. Each row includes `next_action` so sandbox,
approval, cache-install, tunnel, session-token, provider, and review-quality
failures remain operator-actionable.

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
