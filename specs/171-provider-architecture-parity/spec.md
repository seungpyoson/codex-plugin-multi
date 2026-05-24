# Feature Specification: Provider Architecture Parity Audit

**Feature Branch**: `goal/provider-architecture-parity-171`  
**Created**: 2026-05-24  
**Status**: Draft  
**Input**: `/Users/spson/Downloads/prompts/1-provider-neutral-shared-policy-audit-goal.md`

## User Scenarios & Testing

### User Story 1 - Provider Parity Is Inspectable (Priority: P1)

A maintainer can open one provider parity artifact and see whether Claude,
Gemini, Kimi, Grok, DeepSeek, and GLM use shared provider-neutral policy or a
documented/tested adapter exception for every provider-facing policy area.

**Why this priority**: #171 asks for an architecture-level answer, not a narrow
route fix. Without a table, future work can add provider-specific policy by
accident.

**Independent Test**: Inspect the parity artifact and verify every required
provider and policy area is present with evidence paths, verdicts, sync guards,
and residual issue links.

**Acceptance Scenarios**:

1. **Given** a reader starts from #171, **When** they open the parity artifact,
   **Then** they can identify each shared Module, Interface, Implementation,
   Adapter, packaged copy, sync guard, and test for each policy area.
2. **Given** a provider differs, **When** the row is inspected, **Then** the row
   states whether this is an intentional adapter exception, accidental
   provider-specific policy, or unknown requiring research.
3. **Given** #170 is related, **When** topology evidence is needed, **Then** the
   artifact links only the topology evidence that informs #171 and does not
   expand implementation scope without proof.

---

### User Story 2 - Shared Policy Guardrails Prevent Drift (Priority: P1)

A maintainer changing provider runtime, docs, generated contracts, or packaged
copies gets a failing check when shared provider-neutral policy drifts.

**Why this priority**: Existing shared modules are only safe if tests and sync
guards prove providers consume them instead of recreating policy branches.

**Independent Test**: Run focused tests and sync lint after intentionally
breaking one shared-policy copy or omitting a provider from the parity contract.

**Acceptance Scenarios**:

1. **Given** a provider copy of shared policy drifts, **When** `npm run
   lint:sync` or copy tests run, **Then** the drift is detected.
2. **Given** a provider-facing contract omits `selected_route`,
   `fallback_reason`, `auth_path`, `billing_path`, source-send approval state,
   or review-quality state, **When** contract tests run, **Then** they fail.
3. **Given** a new provider adapter is added, **When** parity tests run, **Then**
   missing capability facts or missing parity-table coverage fail before merge.

---

### User Story 3 - Grok Audited Fallback Is Implemented (Priority: P1)

A maintainer can run Grok in explicit auto transport mode and get CLI-primary
behavior with audited web-tunnel fallback for approved CLI readiness/login/model
failure classes.

**Why this priority**: #159 now says Grok should have audited CLI-to-web fallback,
while current code/docs/tests intentionally keep the web tunnel explicit-only. A
first external review rejected a docs-only classification as substituting
documentation for required runtime behavior.

**Independent Test**: Grok smoke tests prove `--transport auto` /
`GROK_TRANSPORT=auto` accepts auto mode, keeps CLI happy path unchanged, falls
back to the existing local web tunnel only for approved CLI failure classes,
records fallback metadata, and never falls back to paid xAI API credentials.

**Acceptance Scenarios**:

1. **Given** Grok CLI succeeds in auto mode, **When** review runs, **Then** the
   JobRecord records `transport: "cli"`, `auth_mode: "subscription_cli"`, and
   no web/tunnel contact.
2. **Given** Grok CLI fails with an approved fallback class and the web tunnel
   is ready, **When** auto mode runs, **Then** the JobRecord records
   `transport: "web"`, `fallback_from: "cli"`, `selected_route:
   "subscription_web"`, `auth_path: "subscription_web"`, and source-send
   disclosure for the actual web transport.
3. **Given** xAI direct API env vars exist, **When** Grok subscription paths run,
   **Then** docs/tests continue to prohibit silent paid API fallback.

## Edge Cases

- `.specify/` scripts are absent, so Speckit artifacts are generated manually
  using the installed skill workflow and the existing `specs/*` shape.
- A provider can be API-only without becoming second-class; the shared route
  policy should record `subscription_not_supported`.
- A packaged copy can be required for distribution and still safe when canonical
  source, sync script, and drift tests exist.
- A route/fallback issue can be real without implying a repo-wide topology split.
- External adversarial review must not count missing, timed-out, shallow, or
  failed slots as approval.
- Direct API approval for DeepSeek/GLM is standing-approved for this goal, but
  approval-request artifacts and audit metadata remain required.
- No GitHub issue creation/closure, push, merge, deploy, destructive cleanup,
  browser/session repair, or billing/tier action is allowed without separate
  explicit operator approval.
- A post-review issue-link metadata update is allowed only after separate
  operator approval and hard evidence proves a distinct follow-up. The
  2026-05-24 Claude custom-review packet-budget investigation meets this bar
  and is tracked as #173.

## Requirements

### Functional Requirements

- **FR-001**: The audit MUST produce a provider parity table for Claude, Gemini,
  Kimi, Grok, DeepSeek, and GLM.
- **FR-002**: The parity table MUST cover route/auth/source-send approval,
  packet budgets, fallback semantics, failure taxonomy, suggested actions, audit
  fields, review-quality gates, status/UX normalization, generated contracts,
  docs, packaged copies, and sync rules.
- **FR-003**: Every policy area MUST name its canonical Module, Interface,
  Implementation, provider Adapters, packaged copies, sync guard, tests, verdict,
  and residual risk.
- **FR-004**: Every provider-specific exception MUST include hard evidence,
  issue linkage, tests or missing-test task, and a verdict of intentional
  adapter exception, accidental provider-specific policy, or unknown.
- **FR-005**: The audit MUST use #171 as the primary issue and #170 only as
  topology evidence unless current evidence proves repo-wide topology must split.
- **FR-006**: The audit MUST NOT create a new GitHub issue unless the operator
  separately approves it after hard evidence proves a distinct concern that
  should not be buried inside #171/#170. The post-review #173 split is the
  current approved exception.
- **FR-007**: Speckit plan/tasks artifacts MUST exist before implementation.
- **FR-008**: External adversarial review of plan/tasks MUST be unanimous across
  Claude, Gemini, Grok, GLM, DeepSeek, and Kimi before implementation.
- **FR-009**: Implementation MUST include the Grok audited CLI-to-web fallback
  runtime slice if the revised plan/tasks review approves it, because the first
  review identified docs-only handling as insufficient.
- **FR-010**: If implementation proceeds, it MUST use TDD vertical slices: RED
  characterization/guard test, GREEN minimal change, repeat.
- **FR-011**: Final review MUST cover the whole completed audit/implementation,
  not fragments, and again require unanimous approval before any PR/merge-ready
  claim.

### Key Entities

- **Provider Parity Table**: The durable architecture map for #171.
- **Policy Area**: One shared behavior surface, such as route policy or review
  panel state normalization.
- **Adapter Exception**: A provider-specific difference backed by provider
  limitation evidence and tests.
- **Guardrail Test**: Unit/smoke/sync check proving shared-policy parity.
- **External Review Gate**: Six-provider adversarial approval state for plan/tasks
  and final implementation.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The parity table covers all six providers and all required policy
  areas.
- **SC-002**: `npm test`, `npm run test:full`, and `npm run lint:sync` pass
  before any PR/merge-readiness claim.
- **SC-003**: A focused guard test fails if any provider disappears from the
  parity table or any required shared audit field disappears from generated
  contracts.
- **SC-004**: Grok `auto` transport behavior is TDD-covered and records
  CLI-primary/web-fallback metadata without paid direct API fallback.
- **SC-005**: External plan/tasks review returns usable approval from all six
  required reviewers before implementation starts.
- **SC-006**: If code/docs/tests change, final external review returns usable
  approval from all six required reviewers and all local verification gates pass.

## Assumptions

- Existing shared modules are the intended canonical policy seams unless current
  source evidence proves otherwise.
- Issue bodies/comments fetched on 2026-05-24 are authoritative for issue scope.
- Current local worktree and `origin/main` at `89b3336` are the audit baseline.
- `npm test` default subset is acceptable as baseline; broader gates are required
  only if implementation touches shared/runtime surfaces.
