# Research: Provider Architecture Parity Audit

## Decision: #171 Is The Primary Scope

#171 directly names provider architecture parity across Claude, Gemini, Kimi,
Grok, DeepSeek, and GLM. #170 is broader repo topology and duplicated paths.
Current evidence shows shared policy and synced packaged copies, so #170 remains
input instead of becoming the implementation target.

Alternatives considered:

- Use #170 as the target: rejected because current evidence is provider-facing
  and does not prove repo-wide topology must split.
- Create a new issue during the initial #171 audit: rejected because #171/#170
  covered the known provider-parity concerns at that point. Later, after a
  separate operator request to investigate Claude usage-limit burn, a narrower
  Claude subscription CLI `custom-review` packet-budget root cause was proven
  and filed as #173 after non-Claude adversarial approval. #173 is recorded as
  a follow-up split, not as part of the initial #171 implementation scope.

## Decision: #173 Is A Post-Review Claude Packet-Budget Follow-Up

The initial #171 audit treated packet-budget parity as broad follow-up #172.
The later Claude usage-limit investigation found a more specific root cause:
Claude subscription CLI `custom-review` can fall back to full selected-source
bodies and launch without a pre-launch budget or resend-confirmation gate.
Grok adversarial review approved this narrowed problem definition in
`job_36627cf7-dfe5-40e8-8a5f-2567bdd318a2`, and issue #173 now tracks it.

Alternatives considered:

- Fold #173 into #171: rejected because #171's reviewed implementation is the
  provider parity audit/Grok fallback slice, while #173 is a focused Claude
  runtime budget gate.
- Leave #173 under #172 only: rejected because #172 is broader routing/chunking
  work and the reproduced Claude path is narrower, high-impact, and actionable.

## Decision: Current Shared Policy Is Mostly Compliant

Route/auth/source-send behavior is centralized in `provider-route-policy.mjs`
and `auth-selection.mjs`. Prompt/audit state is centralized in
`review-prompt.mjs`. Source-send disclosure is centralized in
`external-review.mjs`. Failure taxonomy and review-quality state are centralized
in `external-model-failure-core.mjs` and
`external-model-review-quality.mjs`. Review-panel normalization is centralized
in `review-panel.mjs`.

Alternatives considered:

- Treat provider entrypoints as duplicated policy: rejected for now because the
  current evidence shows provider entrypoints consume shared policy for core
  route/audit/status fields, while retaining adapter launch mechanics.

## Decision: Packaged Copies Are Distribution Artifacts

Package copies under `plugins/*/scripts/lib/` are guarded by sync scripts,
`tests/unit/plugin-copies-in-sync.test.mjs`, and `npm run lint:sync`. The current
sync gate passed. This supports the verdict "packaging copy with sync guard".

Alternatives considered:

- Delete packaged copies: rejected because plugin distribution requires
  self-contained package copies.
- Treat copies as independent implementation: rejected because canonical sources
  and sync guards own shared behavior.

## Decision: Grok Fallback Is Required Runtime Work After Review

Current code/docs/tests intentionally make Grok CLI the default and web tunnel
explicit-only. #159 comments now say Grok should offer audited CLI-to-web
fallback for approved CLI failure classes. First-pass Gemini and DeepSeek plan
review rejected docs-only handling as a substitution for required runtime
behavior. The revised plan therefore makes Grok auto fallback a TDD runtime
slice, still blocked by unanimous review before implementation.

Alternatives considered:

- Implement `--transport auto` immediately: rejected because the goal forbids
  implementation before revised plan/tasks and unanimous external review.
- Ignore #159: rejected because #171 explicitly asks for provider architecture
  parity and route/fallback is a visible symptom.

## Decision: MVP Is Parity JSON Plus Grok Auto Fallback

Evidence does not prove broad runtime shared-policy drift outside the Grok
fallback decision. The revised MVP is a canonical `provider-parity-table.json`,
tests that fail when provider coverage or required audit fields drift, and the
Grok `auto` fallback TDD slice required by review feedback.

Alternatives considered:

- Broad runtime refactor first: rejected; only Grok auto fallback is planned.
- No code/doc changes: rejected because #171 asks for a durable parity answer.
