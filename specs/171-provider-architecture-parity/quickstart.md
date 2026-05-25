# Quickstart: Provider Architecture Parity Audit

## Current Worktree

```sh
cd /Users/spson/Projects/Claude/codex-plugin-multi/.worktrees/provider-architecture-parity-171
git status --short --branch
```

Expected branch:

```text
## goal/provider-architecture-parity-171...origin/goal/provider-architecture-parity-171
```

## Current Gate

Implementation is blocked.

Before code changes resume, all six reviewers must approve the revised packet:

```text
specs/171-provider-architecture-parity/root-problems.md
specs/171-provider-architecture-parity/spec.md
specs/171-provider-architecture-parity/plan.md
specs/171-provider-architecture-parity/tasks.md
specs/171-provider-architecture-parity/evidence-map.md
specs/171-provider-architecture-parity/research.md
specs/171-provider-architecture-parity/data-model.md
specs/171-provider-architecture-parity/provider-parity-table.json
```

Reviewer prompt:

```text
Adversarial review of revised #171 provider architecture parity root-problem
definition and plan/tasks. The operator requires exact same policy treatment
for Claude, Gemini, Kimi, Grok, DeepSeek, and GLM. Differences are allowed only
as evidence-backed Adapter capability facts. Find any missing route ladder,
OpenRouter fallback, packet budget/resend policy, auth/readiness, status,
review-quality, issue-scope, task-order, or external-review gate problem.
Verdict must be APPROVE or REQUEST_CHANGES.
```

Required reviewers:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Do not count missing, timed-out, source-send failed, shallow, no-verdict, or
failed review slots as approval.

## Route Ladder Test Plan

Future RED tests should cover the same matrix for every provider:

- subscription available
- subscription unsupported
- subscription not authenticated
- subscription usage limited
- direct API available
- direct API missing credential
- direct API rejected
- OpenRouter available
- OpenRouter missing credential
- OpenRouter rejected
- source-bearing route requires approval
- billing path changes invalidate approval tuple

Expected fields:

```text
provider
attempted_route
selected_route
skipped_reason
fallback_reason
auth_path
billing_path
source_send_approval_required
source_send_approval_state
source_content_transmission
error_code
suggested_action
```

## Packet Policy Test Plan

Future RED tests should cover all providers and modes:

```text
review
adversarial-review
custom-review
rescue
```

Required behaviors:

- predictable over-budget packets fail before source send
- source surface changes are recorded
- full-source approval is not reused for diff/shard review
- failed source-bearing run is not retried automatically
- provider-specific prompt/step limits come from Adapter capability facts
- same-packet retry identity is stable across provider, mode, reviewed head,
  prompt, source packet, route, and scope
- third same-packet retry fails closed unless disposition is split/narrow,
  switch provider, waiver, or explicit override

## Review Slot Disposition Test Plan

For each provider family, verify one completed slot, one failed/no-result slot,
and one retry/disposition case.

Required fields:

```text
slot_id
attempt_id
parent_attempt_id
reviewed_head_sha
retry_fingerprint
retry_count
request_settings_hash
source_state
verdict
failed_slot_reason
disposition
not_counted_reason
waiver_artifact
override_artifact
```

No raw source, prompt, provider output, raw command args, or raw paths may be
stored in the disposition fields.

## Direct API / OpenRouter Approval Handling

Source-bearing direct API and OpenRouter routes require approval tuple metadata:

```text
provider
mode
source packet
prompt hash
request settings
auth path
billing path
selected route
fallback reason
approval scope
retry_fingerprint
retry_count
request_settings_hash
```

Fail closed if tuple changes or source-send truth cannot be proven.

## Planning Verification

```sh
git diff --check
node -e "JSON.parse(require('fs').readFileSync('specs/171-provider-architecture-parity/provider-parity-table.json','utf8'))"
```

## Implementation Verification After Approval

For each approved issue:

```sh
git diff --check
npm run lint:sync
node --test <focused test files>
npm test
npm run test:full
```

Run `npm run doctor:cache` if runtime scripts, generated docs/skills, shared
synced libs, or packaged plugin copies change.
