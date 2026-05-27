# Feature Specification: Refresh-Aware Direct API Credentials

**Feature Branch**: `goal/provider-reliability-160-stale-env`
**Created**: 2026-05-27
**Issue**: `#160`
**Status**: In Progress

## Clarified Requirement

Direct API reviewers must resolve provider credentials at invocation time from a
refresh-aware credential cache when that cache is present and owner-only. A
long-running Codex session may have stale `process.env` values after a user
rotates a key and refreshes the local env cache. In that case, the refreshed
cache value must win over the snapshotted process env value.

This is provider-neutral. Credential env names must come from provider config
(`env_keys`), not provider-specific branches or hardcoded provider values.

The branch also covers adjacent provider-reliability symptoms found during
end-to-end review of the same work: retry amplification on provider usage
limits, same-provider source-bearing workload overlap, and missing account
identity evidence for OAuth-backed reviewer runs.

## User Stories & Testing

### User Story 1 - Rotated Cache Overrides Stale Process Env (Priority: P1)

A maintainer rotates a direct API key, refreshes the owner-only env cache, and
then runs `api-reviewer doctor` or `api-reviewer run` from an existing Codex
session without restarting Codex.

**Independent Test**: With `process.env.DEEPSEEK_API_KEY=old` and an owner-only
cache containing `DEEPSEEK_API_KEY=new`, the next provider call uses `new`.

**Acceptance Scenarios**:

1. **Given** process env has an old non-empty configured credential and the
   owner-only cache has a new non-empty value for the same configured key,
   **When** doctor probes the provider, **Then** the authorization header uses
   the cache value.
2. **Given** the same stale-env/cache setup for `run`, **When** source send is
   approved and the provider call executes, **Then** the provider call uses the
   cache value and no secret appears in stdout, stderr, or persisted records.

### User Story 2 - No Cache Still Falls Back To Process Env (Priority: P1)

A user who does not use the local env cache must keep the current behavior.

**Independent Test**: With no readable cache file and a non-empty configured env
credential, doctor/run uses the process env credential.

### User Story 3 - Credential Source Is Reported Without Leaking Secrets (Priority: P1)

Doctor and persisted direct API records identify whether the effective key came
from `env` or `env_cache`.

**Independent Test**: JSON outputs include `credential_source` while never
including the credential value.

## Edge Cases

- Missing cache file falls through to `process.env`.
- Disabled cache (`API_REVIEWERS_DISABLE_ENV_CACHE`) falls through to
  `process.env`.
- Non-owner-only cache on non-Windows platforms is ignored.
- Empty cache values are ignored.
- If the cache changes after provider send but before record rendering,
  redaction still covers the selected credential value used for the request.
- Multiple configured env keys retain provider config order; the first
  configured key with an effective value wins.
- The approval auth path must include the credential source so approvals cannot
  silently carry over when the effective auth source changes.
- Provider usage-limit wording such as "session limit" must stop retry ladders
  instead of being retried as a generic provider error.
- Concurrent source-bearing jobs for the same provider must be blocked before
  target launch, but source-free readiness probes and cross-provider reviews
  must remain allowed.
- OAuth-backed reviewer records must include a privacy-safe account fingerprint
  when the provider exposes account fields, and must not include raw email,
  account, user, or org values.

## Requirements

- **FR-001**: Credential resolution MUST read all configured credential env keys
  from the owner-only cache on every invocation when cache use is enabled.
- **FR-002**: A non-empty cache value for a configured key MUST override a
  non-empty process env value for the same key.
- **FR-003**: If no usable cache value exists, resolution MUST preserve fallback
  to `process.env`.
- **FR-004**: Doctor output, run records, and provider execution metadata MUST
  report `credential_source` as `env`, `env_cache`, or `null`.
- **FR-005**: Approval auth paths MUST include `credential_source` alongside
  `credential_ref`.
- **FR-006**: No implementation may hardcode provider IDs, concrete secret
  values, or new fixed cache paths; provider keys come from `env_keys` and cache
  path behavior remains `API_REVIEWERS_ENV_CACHE` or `~/.cache/op/env.sh`.
- **FR-007**: Secret redaction MUST include the effective credential source and
  the selected credential snapshot used for the provider request so cache-sourced
  values cannot leak even if the cache changes before record rendering.
- **FR-008**: Provider usage-limit classification MUST include `session limit`
  wording and MUST prevent permission-mode or equivalent retry ladders from
  replaying the same source packet.
- **FR-009**: Reviewer runtimes MUST use a shared provider workload admission
  helper that blocks only same-provider source-bearing runs before target launch
  and records `provider_workload_blocked` with `payload_sent:false`.
- **FR-010**: Reviewer runtimes MUST provide a provider-neutral account identity
  helper that emits only a one-way fingerprint and source field names; raw
  account identifiers MUST NOT be persisted or printed.
