# Quickstart: Bounded Session Approval

## Operator Flow

1. Request a source-free grant:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-grant request \
  --provider deepseek \
  --mode custom-review \
  --scope custom \
  --scope-paths seed.txt \
  --prompt "Review seed file only." \
  --grant-ttl-ms 900000
```

Expected:

- `event:"external_review_session_approval_request"`
- `source_content_transmission:"not_sent"`
- selected files summary and hashes
- rendered prompt hash
- grant bounds
- `grant_approval_token.value` for this exact grant request
- `approval_scope:"grant"`
- no source body, prompt body, API key, cookie, or raw env value

2. Activate the grant after explicit approval:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-grant activate \
  --provider deepseek \
  --mode custom-review \
  --scope custom \
  --scope-paths seed.txt \
  --prompt "Review seed file only." \
  --grant-expires-at "<grant_bounds.expires_at from request>" \
  --approval-token "<grant_approval_token.value from request>"
```

Expected:

- `event:"external_review_session_approval_grant"`
- grant id
- expiry
- source still not sent
- no persisted approval token value
- normal `approval-request` tokens and one-time tokens are rejected for activation
- grant request tokens are rejected if passed to a normal `run --approval-token`

3. Run the matching review without a per-run token:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs run \
  --provider deepseek \
  --mode custom-review \
  --scope custom \
  --scope-paths seed.txt \
  --foreground \
  --prompt "Review seed file only."
```

Expected:

- source is sent only after grant match
- JobRecord has `source_content_transmission:"sent"`
- audit manifest has `approval_source:"session_grant"` and `approval_grant.grant_id`

## Safety Checks

The run must fail before source send when any of these change:

- provider
- mode
- workspace root
- selected path
- selected file content
- rendered prompt hash
- scope resolution
- request timeout/max token/default settings
- auth key name
- billing endpoint/model
- selected route
- route step
- route steps
- fallback reason
- file count or byte count over grant bounds
- grant TTL over the configured maximum
- multiple active matching grants
- inconsistent schema or fingerprint tampering
- expiry

Expected failure:

- `error_code:"approval_required"`
- `source_content_transmission:"not_sent"`
- no provider launch lifecycle event

## Fallback

The existing per-request flow remains valid:

```bash
node plugins/api-reviewers/scripts/api-reviewer.mjs approval-request ...
node plugins/api-reviewers/scripts/api-reviewer.mjs run ... --approval-token "<approval_token.value>"
```

Use this when no grant exists or when the operator wants a one-off source send.

## Local Verification

```bash
node --test --test-name-pattern "session approval grant" tests/smoke/api-reviewers.smoke.test.mjs
npm run smoke:api-reviewers
npm test
npm run lint
git diff --check
```
