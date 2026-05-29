# Feature Specification: Bounded Session Approval for Direct API Reviewers

**Feature Branch**: `goal/provider-reliability-147-session-approval-grants`
**Created**: 2026-05-27
**Issue**: #147 - P1: Add bounded session approval for direct API reviewer source sends
**Status**: Draft for pre-implementation review

## User Scenarios & Testing

### User Story 1 - Create a Bounded Grant (Priority: P1)

As an operator running repeated DeepSeek or GLM source-bearing reviews over a known safe scope, I can request and activate a short-lived approval grant that records exactly what source, provider, mode, workspace, route, and request settings are covered.

**Why this priority**: Without this, every repeated source-bearing Direct API run still requires a fresh approval-request and token pass even when the operator is intentionally repeating the same bounded workflow.

**Independent Test**: Run a grant request for DeepSeek custom-review on one explicit file, activate it with the matching approval proof, and inspect the stored grant metadata. No selected source is sent during grant request or activation.

**Acceptance Scenarios**:

1. **Given** a selected custom-review file and valid DeepSeek credential, **When** the operator requests a session grant, **Then** the command returns a source-free approval request with selected-source counts, content hashes, rendered prompt hash, route/auth/billing metadata, limits, expiry, and a grant approval token whose proof payload is scoped to grant activation.
2. **Given** that grant request, **When** the operator activates it with the matching token and unchanged request tuple, **Then** a grant file is persisted under plugin data with a grant id, expiry, bounds, and audit hashes, without sending selected source.

---

### User Story 2 - Reuse a Matching Grant (Priority: P1)

As an operator, I can run matching DeepSeek/GLM source-bearing review commands without repeating manual approval prompts while the grant remains valid.

**Why this priority**: This is the main friction reduction #147 asks for.

**Independent Test**: Activate one grant, then run the same source-bearing command without `--approval-token`. The run sends source and records that approval came from a session grant.

**Acceptance Scenarios**:

1. **Given** an active unexpired grant for an exact Direct API tuple, **When** a matching `run` starts without `--approval-token`, **Then** the runtime auto-approves before provider launch and persists `source_content_transmission:"sent"`.
2. **Given** a grant-approved run, **When** the JobRecord is inspected, **Then** its audit manifest names `approval_source:"session_grant"`, grant id, grant session id if available, selected files summary, content hashes, rendered prompt hash, and route/auth/billing/request fields.

---

### User Story 3 - Reject Mismatches and Expiry (Priority: P1)

As a safety reviewer, I can trust that a grant cannot authorize changed provider, mode, workspace, files, content, prompt, route, auth, billing, request settings, file count, byte count, or expired runs.

**Why this priority**: A reusable grant is only acceptable if it is narrower than repeated per-request approval, not a blanket Direct API bypass.

**Independent Test**: Activate a grant, mutate one boundary at a time, run without `--approval-token`, and verify the run fails before source send with `approval_required` and `source_content_transmission:"not_sent"`.

**Acceptance Scenarios**:

1. **Given** an active grant for DeepSeek, **When** the operator changes provider to GLM, **Then** the run fails before provider launch and no source is sent.
2. **Given** an active grant for one file, **When** the file content, selected path, prompt, mode, workspace, timeout, max tokens, auth path, billing path, selected route, route step, route steps, or fallback reason changes, **Then** the run fails before provider launch and no source is sent.
3. **Given** an expired grant, **When** the matching run starts without `--approval-token`, **Then** the run fails before provider launch and no source is sent.
4. **Given** no matching grant, **When** the operator passes a valid existing per-request `--approval-token`, **Then** the existing approval-request path still works.

---

### User Story 4 - Keep Operators and Reviewers Oriented (Priority: P2)

As an operator or reviewer, I can see from docs, help output, and tests how grants differ from one-time/session approval tokens and why they do not weaken source-egress controls.

**Why this priority**: This feature touches source egress. Ambiguous docs would be a safety regression.

**Independent Test**: Inspect CLI help, README, schema, and tests. They describe session grants, mismatch fallback, no secret/token printing, and no selected-source body persistence.

## Functional Requirements

- **FR-001**: The Direct API reviewer CLI MUST expose an explicit way to request a bounded session approval grant without sending selected source.
- **FR-002**: Grant request output MUST include selected-source summary, file content hashes, rendered prompt hash, provider, mode, workspace identity, scope resolution, route/auth/billing metadata, request settings, max file and byte bounds, expiry, and source transmission `not_sent`.
- **FR-003**: Activating a grant MUST require a matching grant approval proof derived from a canonical payload containing the approval tuple plus all grant bounds: provider allowlist, mode allowlist, workspace root hash, path constraints, max files, max bytes, expiry, maximum TTL, and grant schema version. Existing source-bearing `approval-request` tokens and `approval_scope:"once"` tokens MUST be rejected for grant activation.
- **FR-004**: An active grant MUST only auto-approve source-bearing Direct API runs matching provider, mode, workspace, selected files, selected-source hashes, rendered prompt hash, scope resolution, selected route, route step, route steps, fallback reason, auth/billing metadata, request settings, max files, max bytes, and expiry.
- **FR-005**: A matching grant-approved run MUST persist audit evidence with grant id, grant session id if available, approval source `session_grant`, selected files summary, content hashes, rendered prompt hash, request settings, and `source_content_transmission:"sent"`.
- **FR-006**: Any non-matching, malformed, unreadable, schema-invalid, tampered, expired, duplicate-ambiguous, or multi-match grant state MUST fail closed before source send with `approval_required` and `source_content_transmission:"not_sent"`.
- **FR-007**: Existing per-request approval-token behavior MUST keep working for runs outside grants.
- **FR-008**: One-time approval tokens MUST remain single-use and MUST NOT become reusable grants.
- **FR-009**: Persisted grant files, JobRecords, lifecycle output after request emission, docs examples, and errors MUST NOT print approval token values, API keys, secrets, cookies, or selected-source bodies. The source-free `approval-grant request` response MAY print `grant_approval_token.value` exactly once for operator use and MUST NOT persist it.
- **FR-010**: Grant activation and grant-approved runs MUST be covered by smoke tests for DeepSeek and GLM or provider-parametric Direct API fixtures.
- **FR-011**: The implementation MUST remain provider-neutral for Direct API reviewers; provider-specific code may expose capability facts only.
- **FR-012**: Requested grant TTL MUST be bounded by the configured session-approval maximum; requests above the configured maximum MUST be rejected before any grant token is accepted or persisted.

## Non-Goals

- No blanket `always allow DeepSeek/GLM` setting.
- No env-only silent source egress.
- No weakening of existing `approval-request` output or approval-token matching.
- No rescue/write-capable Direct API workflow; that remains #144.
- No Grok transport architecture work; that remains #159.
- No stale credential-cache acceptance change; that remains #160 unless a direct dependency is proven.

## Success Criteria

- **SC-001**: A matching grant-approved DeepSeek/GLM run succeeds without a per-run `--approval-token`.
- **SC-002**: Provider, mode, workspace, file path, file content, prompt, request setting, auth path, billing path, selected route, route step, route steps, fallback reason, max file, max byte, expiry, schema, fingerprint, and multiple-match mismatches fail before source send.
- **SC-003**: Every grant-approved JobRecord says `approval_source:"session_grant"` and records grant id plus the same selected-source and prompt hashes used for matching.
- **SC-004**: `npm run smoke:api-reviewers`, `npm test`, `npm run lint`, and `git diff --check` pass before PR.
- **SC-005**: Pre-implementation and final review gates record usable verdicts; missing, shallow, failed, or source-sent-without-verdict slots are not counted.

## Dependencies and Ordering

- #172 PR #185 is not required for this implementation because #147 builds on current-main Direct API approval-token behavior.
- If #172 merges during this work, rebase and re-run the Direct API grant tests because #172 may extend shard/approval tuple metadata.
- #147 must not be collapsed into #159, #160, #144, #178, or #179.
