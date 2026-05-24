# Feature Specification: Provider Architecture Parity Audit

**Feature Branch**: `goal/provider-architecture-parity-171`
**Created**: 2026-05-24
**Status**: Revised after operator correction
**Input**: `/Users/spson/Downloads/prompts/1-provider-neutral-shared-policy-audit-goal.md`
**Root Problems**: `specs/171-provider-architecture-parity/root-problems.md`

## Clarified Requirement

#171 must solve provider policy parity for Claude, Gemini, Kimi, Grok,
DeepSeek, and GLM. Same policy means same shared Module/Interface, same route
ladder, same packet budget policy, same resend/retry semantics, same
auth/readiness taxonomy, same audit fields, same review-quality gate, same
status/UX contract, and same mode coverage.

Provider-specific behavior is allowed only as an Adapter capability fact with a
clear evidence-backed reason. Capability facts include unavailable subscription
Adapter, missing API key, missing OpenRouter config, different prompt/step
limits, or different launch mechanics. Capability facts do not justify separate
policy paths.

The required route ladder for every provider is:

1. Subscription.
2. Direct API.
3. OpenRouter.

Unsupported route steps must be recorded by the same Interface and then the
policy must evaluate the next route. Do not launch fake subscription commands
for providers that have no subscription Adapter.

The current #175 implementation and prior external reviews are stale for this
clarified requirement. They are evidence only, not completion proof.

## User Scenarios & Testing

### User Story 1 - Shared Route Ladder Covers All Six Providers (Priority: P1)

A maintainer can run or inspect one provider-neutral route policy and see the
same subscription -> direct API -> OpenRouter decision ladder for Claude,
Gemini, Kimi, Grok, DeepSeek, and GLM.

**Why this priority**: Route/fallback asymmetry is the clearest operator-visible
symptom. Without one route Interface, every other policy area drifts.

**Independent Test**: A route-state matrix test exercises all six providers for
subscription available, subscription unsupported, subscription failed before
source send, direct API available, direct API unavailable, OpenRouter available,
OpenRouter unavailable, and source-bearing approval required.

**Acceptance Scenarios**:

1. **Given** DeepSeek or GLM has no subscription Adapter today, **When** route
   policy runs, **Then** it records subscription as unsupported through the same
   Interface, evaluates direct API, and can evaluate OpenRouter if configured.
2. **Given** Kimi subscription fails before source send and a direct API or
   OpenRouter capability is configured, **When** route policy runs, **Then** it
   evaluates the next route with the same approval and billing metadata used by
   every other provider.
3. **Given** Grok CLI fails before source send, **When** route policy runs,
   **Then** any web-tunnel or API/OpenRouter decision is represented by the same
   route/fallback/audit contract and never silently switches to paid billing.
4. **Given** any provider changes route, **When** source-bearing review is
   requested, **Then** approval tuple fields change and source cannot be sent
   until the new tuple is approved.

---

### User Story 2 - Shared Source Packet Policy Covers All Modes And Providers (Priority: P1)

A maintainer can rely on one packet budget, retry, and resend policy for all
six providers across `review`, `adversarial-review`, `custom-review`, and
`rescue`.

**Why this priority**: Claude usage burn, Kimi `step_limit_exceeded`, and
Gemini/Kimi source-sent failures are not separate problems. They show missing
source packet policy parity.

**Independent Test**: One over-budget selected-source fixture produces
provider-neutral pre-send budget decisions for every provider, with
provider-specific limits supplied only by Adapter capabilities.

**Acceptance Scenarios**:

1. **Given** a selected-source packet exceeds a known provider limit, **When**
   any provider review mode runs, **Then** the shared packet policy fails before
   source send with `source_content_transmission: "not_sent"`.
2. **Given** a packet changes from full source to diff/shard, **When** review
   continues, **Then** the audit manifest records the changed review surface and
   the result cannot count as approval for the original surface.
3. **Given** source was sent and a provider fails, **When** retry is requested,
   **Then** the tool does not auto-resend source without an explicit policy
   decision and matching approval.

---

### User Story 3 - Shared Readiness, Failure, Status, And Review Quality Are Exact (Priority: P1)

A maintainer sees the same fields and meanings for readiness, auth, billing,
source transmission, failure class, suggested action, status panel, and review
quality across all six providers.

**Why this priority**: If the operator cannot compare states across providers,
provider parity is not real even if individual paths work.

**Independent Test**: Contract tests fail when any provider omits required
fields or uses different meanings for the same state.

**Acceptance Scenarios**:

1. **Given** a provider is not authenticated, **When** readiness or review fails,
   **Then** the same failure taxonomy and suggested-action contract is used.
2. **Given** Kimi returns `step_limit_exceeded`, **When** the JobRecord is built,
   **Then** it is a failed review slot with capacity/budget semantics shared by
   the other providers.
3. **Given** Grok repeatedly requires login, **When** readiness runs, **Then**
   the result identifies which shared auth/readiness layer failed and whether a
   separate Grok persistence issue is proven.

---

### User Story 4 - Root Problems Are Reviewed Before Implementation (Priority: P1)

A maintainer can inspect `root-problems.md`, `spec.md`, `plan.md`, and
`tasks.md` and see six usable external approvals before implementation resumes.

**Why this priority**: The previous PR implemented against the wrong problem
shape. More code before root-problem agreement is patch churn.

**Independent Test**: Gate records show implementation remains blocked until
Claude, Gemini, Grok, GLM, DeepSeek, and Kimi all approve the revised problem
definition and plan/tasks packet with usable verdicts.

**Acceptance Scenarios**:

1. **Given** any reviewer requests changes or fails without a usable verdict,
   **When** the gate is evaluated, **Then** implementation remains blocked.
2. **Given** all six approve, **When** implementation starts, **Then** work is
   scoped to one approved issue at a time.

## Edge Cases

- A provider can lack a subscription Adapter today. That is a capability fact,
  not different policy treatment.
- A provider can lack direct API or OpenRouter config. That is a capability
  fact, not different policy treatment.
- OpenRouter must be modeled as a first-class route step if it is a supported
  fallback target. Documentation-only mention is not parity.
- No fallback may silently switch billing path.
- No fallback may happen after source was sent unless the shared resend policy
  explicitly permits it and the approval tuple still matches.
- Failed review slots, source-sent runtime failures, missing verdicts, and
  timeouts are not approvals.
- `.specify/` scripts are absent in this worktree, so Speckit artifacts are
  maintained manually in the existing `specs/*` shape.
- No GitHub issue creation/closure, push, merge, deploy, destructive cleanup,
  browser/session repair, or billing/tier action is allowed without explicit
  operator approval.

## Requirements

### Functional Requirements

- **FR-001**: #171 MUST define and enforce one provider policy Interface for
  Claude, Gemini, Kimi, Grok, DeepSeek, and GLM.
- **FR-002**: The route policy MUST evaluate the same ladder for every provider:
  subscription, direct API, OpenRouter.
- **FR-003**: Each route step MUST emit same field meanings: `attempted` and
  `selected` booleans, attempted route name, selected route name, skipped
  reason, fallback reason, auth path, billing path, source-send approval
  required/state, source transmission truth, error code, and suggested action.
- **FR-004**: Unsupported route steps MUST be represented as Adapter capability
  facts and MUST not bypass the shared route Interface.
- **FR-005**: Source packet budget, retry, resend, and review-surface-change
  policy MUST be shared across all six providers and all review modes.
- **FR-006**: Provider-specific prompt, byte, step, timeout, model, transport, or
  auth limits MUST live behind Adapter capability facts.
- **FR-007**: Status, lifecycle, JobRecord, review panel, review-quality, failure
  taxonomy, suggested action, generated contract, docs, and sync rules MUST use
  same names and meanings across all six providers.
- **FR-008**: Grok login persistence plus Kimi `step_limit_exceeded` and
  minimal-packet timeout symptoms MUST be investigated as evidence under #171
  before creating separate issues.
- **FR-009**: New issues MAY be created only after root cause is defined and the
  issue is proven not to duplicate #171/#159/#172/#173.
- **FR-010**: Speckit plan/tasks artifacts MUST be updated before any further
  implementation.
- **FR-011**: External adversarial review of revised `root-problems.md`,
  `spec.md`, `plan.md`, and `tasks.md` MUST be unanimous across Claude, Gemini,
  Grok, GLM, DeepSeek, and Kimi before implementation resumes.
- **FR-012**: Implementation MUST proceed one issue at a time, using TDD
  vertical slices and no provider-specific patches unless backed by clear
  capability evidence.
- **FR-013**: Final review MUST cover the latest head for the implemented issue
  and require all six approvals before merge-readiness is claimed.

### Key Entities

- **Provider Policy Interface**: Shared contract owning route ladder, source
  packet policy, failure/status/review-quality semantics, audit fields, docs,
  and sync rules.
- **Provider Adapter**: Provider-specific implementation exposing capability
  facts and launch mechanics only.
- **Route Ladder**: Ordered route decision: subscription, direct API,
  OpenRouter.
- **Capability Fact**: Evidence-backed provider fact such as unsupported
  subscription Adapter, missing API key, prompt limit, model limit, or transport
  availability.
- **Source Packet Policy**: Shared pre-send budget, retry, resend, and review
  surface contract.
- **External Review Gate**: Six-reviewer approval state for root problems,
  plan/tasks, and final implementation.

## Success Criteria

- **SC-001**: Route ladder tests cover all six providers and all three route
  steps.
- **SC-002**: Packet budget/resend tests cover all six providers and all review
  modes.
- **SC-003**: Contract tests fail if required audit/status/failure/review-quality
  fields disappear or diverge for any provider.
- **SC-004**: OpenRouter is either implemented as the third route step or
  explicitly recorded as unsupported by capability for each provider.
- **SC-005**: Grok login and Kimi step-limit root causes are either covered by
  #171 shared policy work or split into separate issues with evidence.
- **SC-006**: All six external reviewers approve revised root problems and
  plan/tasks before implementation.
- **SC-007**: Final latest-head review receives all six approvals before
  merge-readiness is claimed.

## Assumptions

- Issue #171 is the umbrella for policy parity unless evidence proves a symptom
  needs a separate, non-duplicative issue.
- Issue #170 remains topology evidence input, not the implementation target.
- The existing #175 implementation is available as evidence but is not accepted
  as complete under this revised spec.
