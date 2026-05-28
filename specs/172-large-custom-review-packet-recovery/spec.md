# Feature Specification: Large Custom-Review Packet Recovery

**Feature Branch**: `goal/provider-reliability-172-large-custom-packet-recovery`
**Created**: 2026-05-26
**Status**: Implemented; final review evidence recorded
**Input**: `/Users/spson/Downloads/prompts/codex-plugin-multi/2-provider-reliability-architecture-goal.md`
**Issue**: #172

## Clarified Requirement

When a large `custom-review` packet fails or cannot be sent safely, the plugin
must produce a deterministic, auditable recovery plan. Existing source-packet
budget gates, review-slot disposition, and Kimi scope-base normalization are
groundwork, not #172 completion.

Recovery must be provider-neutral. Provider adapters may expose capability
facts such as source byte caps, rendered prompt caps, step limits, timeout
support, and transport mechanics. Shared policy owns recovery semantics,
review-surface disclosure, approval boundaries, and status/audit fields.

## User Scenarios And Testing

### User Story 1 - Pre-Send Oversized Packets Produce Recovery Plan (Priority: P1)

An operator runs `custom-review` with selected files that exceed a provider's
known source or rendered prompt budget. The run fails before source send and
returns a structured recovery plan with exact safe next actions.

**Independent Test**: A fixture with multiple large custom-review files fails
before provider launch for Direct API and Grok, and the JobRecord contains
`packet_recovery` with shard and diff-packet actions.

**Acceptance Scenarios**:

1. Given selected source exceeds a known source-packet cap, when review runs,
   then source is `not_sent`, error is a packet budget failure, and
   `packet_recovery.actions` includes deterministic shard and explicit override
   options.
2. Given rendered prompt exceeds provider cap, when review runs, then source is
   `not_sent`, error is `prompt_too_large`, and `packet_recovery` includes shard
   tuples with content hashes and prompt hash metadata where available.
3. Given the workspace is git-backed and a `scope_base` can be supplied, when
   recovery is rendered, then diff-packet action is represented as a changed
   review surface, not as full-source approval.

### User Story 2 - Changed Review Surfaces Are Auditable (Priority: P1)

An operator follows a fallback from full custom-review to shard or diff packet.
The resulting audit metadata records that the review surface changed and cannot
silently count as full-source approval.

**Independent Test**: A narrowed packet after a prior failed source-bearing slot
sets `review_surface_changed:true` and carries `packet_recovery.review_surface`.

**Acceptance Scenarios**:

1. Given original packet hash differs from fallback packet hash, when fallback
   review starts, then audit metadata records original and current packet
   identity without storing source bodies.
2. Given fallback action is diff-only, when review completes, then status
   explains that approval is for the diff packet, not the original full-source
   packet.
3. Given operator wants full-source quorum, when only shard/diff approvals
   exist, then tooling cannot present them as one full-source approval unless
   the shard coverage contract proves equivalence.

### User Story 3 - Failed Runtime Slots Stay Failed (Priority: P1)

Gemini/Kimi/Grok/Direct API runtime failures after source send or preflight
failures before source send must remain failed review slots while still
offering recovery.

**Independent Test**: Existing failed-slot tests stay green and new recovery
tests assert `failed_review_slot:true` or source not sent as appropriate.

**Acceptance Scenarios**:

1. Given provider returns no verdict after source send, when JobRecord is built,
   then slot remains failed and recovery points to resume/shard/waiver paths
   without approval credit.
2. Given source was not sent, when retrying the same packet, then shared policy
   may reuse only the same current-session approval proof for the unchanged
   tuple; any tuple change requires a fresh approval-request and matching
   token.
3. Given source was sent and failed, when retrying the unchanged packet, then
   the failed slot stays failed and a resend action requires explicit resend
   confirmation plus any provider-specific approval proof.
4. Given source was sent and failed, when recovery suggests a changed packet,
   then direct API source sends require a fresh matching approval token for the
   changed tuple.

## Edge Cases

- Provider has source byte cap but no prompt cap.
- Provider has prompt cap but source packet is below byte budget.
- One file exceeds per-file secure read cap.
- Aggregate selected source exceeds shared source cap.
- Grok auto transport falls back from CLI to web before source send.
- Kimi has a lower packet cap and unsupported no-source repair after
  source-bearing step-limit failure.
- A source-bearing background job is reconciled as `stale_active_job` after the
  target process stalls or the worker disappears.
- Direct API approval request fails before approval token is created.
- `--allow-large-source-packet` is explicitly provided but resend confirmation
  is still required by #180.
- `.specify/` scripts are absent; Speckit-style artifacts are manual under
  `specs/172-large-custom-review-packet-recovery/`.

## Functional Requirements

- **FR-001**: Oversized source-packet and prompt-budget failures MUST emit a
  structured `packet_recovery` object in persisted/audited output.
- **FR-002**: `packet_recovery` MUST include provider, mode, failure reason,
  source transmission truth, original/current review-surface metadata, and
  deterministic next actions.
- **FR-003**: Recovery actions MUST distinguish full-source retry, shard,
  diff-packet, explicit large-packet override, no-source resume, waiver, and
  provider switch where applicable.
- **FR-004**: Any action that changes selected source or rendered prompt hash
  MUST be marked as a changed review surface and MUST NOT count as approval for
  the original surface unless a complete shard coverage proof exists.
- **FR-005**: Direct API recovery actions that send source MUST preserve an
  approval tuple/fingerprint for provider, mode, source packet, prompt hash,
  scope resolution, request settings, auth path, billing path, selected route,
  fallback reason, and approval scope. The runtime may require a matching
  current-session approval token, but persisted recovery output MUST NOT store
  the approval token value.
- **FR-006**: Failed review slots, missing verdicts, provider-unavailable
  failures, timeouts, stale active jobs, runtime crashes, prompt-limit failures,
  and source-packet failures MUST NOT count as approval.
- **FR-007**: Provider-specific caps MUST enter through Adapter capability facts
  and shared policy helpers, not copied product-policy branches.
- **FR-008**: Output MUST NOT persist full prompt, selected source bodies,
  secrets, approval tokens, cookies, or bearer values.
- **FR-009**: Packaged plugin copies and generated docs/skills MUST stay in sync
  with canonical shared policy when touched.
- **FR-010**: External review of `spec.md`, `plan.md`, `tasks.md`,
  `data-model.md`, `quickstart.md`, `evidence-map.md`,
  `plan-review-results.md`, and `contracts/packet-recovery.schema.json` MUST
  be unanimous across Claude, Gemini, Grok, GLM, DeepSeek, and Kimi before
  runtime code.
- **FR-011**: Claude, Gemini, Kimi, Grok, and Direct API providers MUST expose
  compatible recovery field meanings when their adapter facts can produce or
  project packet recovery metadata. Unsupported recovery paths MUST be modeled
  explicitly through provider capabilities; for Kimi source-bearing step-limit
  failures, `provider_capabilities.supports_no_source_resume:false` MUST omit
  any `resume_without_source_resend` action.
- **FR-012**: When a JobRecord has both top-level `error_code` and
  `packet_recovery.reason`, the values MUST match for packet recovery failures.

## Success Criteria

- **SC-001**: Focused source-packet/prompt-cap tests show `packet_recovery` for
  Direct API and Grok pre-send failures, with companion conformance tests for
  Claude/Gemini/Kimi field projection.
- **SC-002**: Shared policy tests prove changed review surfaces are surfaced and
  not counted as original full-source approval.
- **SC-003**: Existing over-budget and failed-slot tests remain green.
- **SC-004**: `npm run lint:sync`, targeted tests, and final broad verification
  pass for touched surfaces.
- **SC-005**: Final external whole-issue review follows the operator-approved
  gate for the implementation pass. Planning artifacts retained all-six review
  approval; final implementation review was narrowed by the operator to Claude
  and Grok and is recorded in `final-review-results.md`.
