# Feature Specification: Grok CLI-Primary Transport Parity

**Feature Branch**: `goal/provider-reliability-159-grok-cli-primary-parity`
**Created**: 2026-05-28
**Status**: Planning gate
**Issue**: #159
**Input**: `/Users/spson/Downloads/prompts/codex-plugin-multi/2-provider-reliability-architecture-goal.md`

## Clarified Requirement

#159 is not a request to add Grok CLI primary behavior from scratch. Current
`main` already defaults Grok to the subscription-backed CLI, supports explicit
legacy web transport, and supports `--transport auto` fallback from pre-source
CLI readiness failures to the subscription-backed web tunnel. #176 closed the
Grok CLI login readiness and auto-doctor fallback slice.

The remaining #159 work is architecture parity: Grok's CLI and web transports
must be represented as transport Adapter capability facts behind one Grok
transport Module Interface. Policy remains shared and provider-neutral. The
Adapter seam must concentrate transport selection, config, prompt-budget names,
fallback eligibility, and fallback diagnostics so future Grok runtime changes do
not require editing scattered transport policy inside the large reviewer
implementation.

No paid xAI API fallback is introduced by this feature. Direct API credentials
remain ignored by default subscription-backed Grok CLI and web paths unless a
separate explicit policy approves a paid billing route.

## User Scenarios & Testing

### User Story 1 - Maintainer Can Inspect One Grok Transport Module (Priority: P1)

A maintainer can find the Grok transport decision model in one Module and see
the same Interface used for CLI and web transport facts.

**Why this priority**: The current behavior is mostly correct, but transport
knowledge is spread across config, doctor, run, fallback, diagnostics, and prompt
budget code. Without a clear Module seam, Grok stays harder to reason about than
Claude, Gemini, and Kimi.

**Independent Test**: Unit or smoke coverage can import or exercise the transport
Module and prove `cli`, `web`, and `auto` resolve to the expected provider,
auth mode, selected route, prompt budget cap, and fallback metadata without
launching a real Grok binary or web tunnel.

**Acceptance Scenarios**:

1. **Given** no transport option is passed, **When** Grok config is resolved,
   **Then** the selected Adapter is CLI with `auth_mode:"subscription_cli"`.
2. **Given** `--transport web`, **When** Grok config is resolved, **Then** the
   selected Adapter is web with `auth_mode:"subscription_web"` and the legacy
   web tunnel stays explicit.
3. **Given** `--transport auto`, **When** the CLI pre-source readiness path fails
   with an eligible CLI auth/readiness reason, **Then** the fallback Adapter is
   web and the CLI failure remains visible in fallback diagnostics.

---

### User Story 2 - Operator Sees The Same CLI/Web Runtime Truth After The Refactor (Priority: P1)

An operator running Grok review, custom-review, setup, doctor, result, and list
commands sees the same route, source-transmission, and suggested-action behavior
as before the architecture change.

**Why this priority**: This issue is an architecture deepening slice, not a
behavior reset. The refactor must preserve the source-send and no-paid-fallback
policy already proven by #171 and #176.

**Independent Test**: Existing Grok smoke tests for explicit CLI, explicit web,
auto CLI success, auto web fallback, prompt-budget failure, doctor, and help
continue to pass after the transport Module is introduced.

**Acceptance Scenarios**:

1. **Given** CLI transport succeeds, **When** a source-bearing Grok review runs,
   **Then** source goes through `subscription_cli`, web is not contacted, and
   direct xAI API credentials are not used.
2. **Given** explicit web transport is selected, **When** CLI auth is absent,
   **Then** CLI state is ignored and the web tunnel path remains isolated.
3. **Given** auto transport falls back to web, **When** the JobRecord is built,
   **Then** `fallback_from:"cli"`, `fallback_reason`, selected route,
   source-transmission state, and CLI request diagnostics are preserved.

---

### User Story 3 - Reviewers Can Verify The Scope Before Code Changes (Priority: P1)

A reviewer can inspect this spec, plan, tasks, data model, contract, quickstart,
and evidence map and approve the #159 implementation scope before runtime code
changes start.

**Why this priority**: The saved goal requires Speckit planning and unanimous
external adversarial plan review before implementation. Coding without this gate
would repeat the earlier class of problem: patching symptoms before agreeing on
the root problem.

**Independent Test**: The task list keeps all runtime implementation unchecked
until Claude, Gemini, Grok, GLM, DeepSeek, and Kimi produce usable approvals or
the operator records explicit waivers.

**Acceptance Scenarios**:

1. **Given** any reviewer says the plan changes behavior, weakens source-send
   policy, or introduces paid billing fallback, **When** the gate is evaluated,
   **Then** implementation remains blocked.
2. **Given** all required plan reviewers approve, **When** implementation starts,
   **Then** work proceeds by TDD vertical slices only.

## Edge Cases

- `GROK_TRANSPORT=legacy`, `tunnel`, or `grok-web` must continue to normalize to
  explicit web transport.
- `--transport auto` may fallback only from pre-source CLI auth/readiness/model
  failures that are already classified as eligible. It must not fallback after
  source was sent.
- Prompt-budget errors must name the selected transport's budget variable:
  `GROK_CLI_MAX_PROMPT_CHARS` or `GROK_WEB_MAX_PROMPT_CHARS`.
- Browser-session repair and web tunnel bootstrap remain explicit web transport
  behavior and must not run implicitly for default CLI transport.
- Direct xAI API credentials must not alter the default subscription-backed
  Grok path.
- Existing generated skills and commands must keep using the generic
  `grok-companion.mjs` entrypoint, not the legacy `grok-web-reviewer.mjs` name.

## Functional Requirements

- **FR-001**: Grok MUST keep CLI as the default transport.
- **FR-002**: Grok MUST keep explicit web transport available for the local
  subscription-backed web tunnel.
- **FR-003**: Grok MUST keep `auto` as a CLI-primary fallback mode that can use
  web only after eligible pre-source CLI readiness failures.
- **FR-004**: Transport selection, transport config, selected route, auth mode,
  prompt-budget cap name, fallback eligibility, and fallback diagnostics MUST be
  concentrated behind one Grok transport Module Interface.
- **FR-005**: CLI and web MUST be represented as transport Adapters with
  capability facts, not provider-specific policy branches.
- **FR-006**: The implementation MUST preserve existing shared source-send,
  source-transmission, review-quality, JobRecord, lifecycle, and audit policy.
- **FR-007**: The implementation MUST NOT introduce paid xAI API fallback,
  direct API billing route selection, browser repair, cache sync, push, merge,
  or issue closure.
- **FR-008**: Tests MUST prove no source reaches web fallback after CLI source
  send and no direct API credentials reach default Grok subscription transports.
- **FR-009**: Plan/tasks MUST receive usable external approvals from Claude,
  Gemini, Grok, GLM, DeepSeek, and Kimi, or explicit operator waivers, before
  runtime implementation starts.
- **FR-010**: Final implementation MUST receive latest-head external review
  approval before merge-readiness is claimed.

## Success Criteria

- **SC-001**: A reviewer can identify the Grok transport Module Interface and
  both CLI/web Adapters without reading the entire reviewer runtime.
- **SC-002**: Existing Grok CLI, web, and auto transport smoke tests pass without
  loosening assertions.
- **SC-003**: Focused tests prove transport config and fallback metadata are
  produced by the Module Interface, not duplicated in run/doctor branches.
- **SC-004**: `npm run smoke:grok`, `npm run lint:sync`, and `npm test` pass
  after implementation.
- **SC-005**: The final PR states that #176 behavior was preserved and #159
  architecture parity was the implemented scope.
