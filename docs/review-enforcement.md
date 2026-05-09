# Review Enforcement

This repository treats plugin-generated external reviews as untrusted until
manual external adversarial reviews are recorded for the exact pull-request
head SHA.

## Manual Relay Evidence

Post one PR comment or PR review body per external reviewer with this marker
and fields:

```text
<!-- codex-plugin-multi:manual-external-adversarial-review -->
Head: <40-char head SHA>
Reviewer: Claude
Verdict: APPROVE
```

Allowed reviewers are `Claude`, `Gemini`, `Kimi`, `DeepSeek`, and `GLM`.
`Verdict: REQUEST CHANGES` blocks the gate. Evidence for an older head SHA is
reported as stale and does not approve the current head.

The `manual-review-gate` workflow runs `node scripts/ci/check-manual-review-gate.mjs`
on pull-request updates, PR review updates, and PR comment changes. It also
posts a `manual-review-gate` commit status for the exact head SHA so a comment
or review update can refresh a branch-protectable status without requiring a
new source commit.

## Required Branch Protection

Repo settings must configure these as required status checks on `main`. The
active `CI gates` ruleset uses the raw check/status context names below:

- `manual-review-gate`
- `lint`
- `test`
- `smoke (api-reviewers)`
- `smoke (claude)`
- `smoke (gemini)`
- `smoke (grok)`
- `smoke (kimi)`
- `SonarCloud Code Analysis`

Repo settings must also set:

- required approving review count: 1
- require conversation resolution: true
- dismiss stale reviews on push: true
- require last push approval: true, when the repository plan supports it

Without those GitHub settings, the workflow is visible but not a hard merge
gate.

Bot reviews such as Greptile are useful advisory signals, but they are not the
hard external-review gate. The hard gate is `manual-review-gate`, because it
requires manual relay evidence for the exact head SHA from all required
external reviewers and can be refreshed by PR comment or review updates.
