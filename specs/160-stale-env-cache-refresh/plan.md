# Implementation Plan: Refresh-Aware Direct API Credentials

**Branch**: `goal/provider-reliability-160-stale-env`
**Date**: 2026-05-27
**Spec**: `specs/160-stale-env-cache-refresh/spec.md`

## Summary

#160 is about stale credentials in long-lived Codex sessions. The current code
already reads an owner-only env cache, but only for configured keys missing from
`process.env`. That means a stale non-empty env value blocks the refreshed cache
from being considered. The implementation will make credential resolution return
both the effective value and its source, with owner-only cache values overriding
stale process env values for configured credential keys.

During the final Grok-readiness investigation, the same provider-reliability
class exposed an adjacent Grok CLI session issue: a copied temporary Grok home
could refresh `auth.json`, then discard that refreshed token state during
cleanup. This branch includes a narrowly scoped Grok repair that syncs only a
refreshed regular-file `auth.json` back to the durable Grok home while keeping
source artifacts and session files isolated.

The final Claude review retry also exposed an adjacent cost/quota guard issue:
Claude Code reports subscription exhaustion as "session limit", while the shared
usage-limit classifier only recognized "usage limit", quota, billing, and
credit wording. That caused the permission-mode ladder to treat the failure as a
generic `claude_error` and retry the same source packet. This branch extends the
shared usage-limit classifier so session-limit responses fail once as
`usage_limited` instead of multiplying attempts.

The deeper Claude RCA found a second guard gap: source-bearing reviews for the
same provider could run at the same time. Local records for the 2026-05-27
12:00Z-15:00Z window showed Claude companion jobs sending 6.78 MB of selected
source with up to three concurrent source-bearing Claude jobs and two active
Claude source-bearing jobs at the recorded session-limit failure. This branch
adds a provider-neutral workload lease so same-provider source-bearing reviews
fail before target launch as `provider_workload_blocked`; source-free readiness
probes are not blocked.

The RCA also found an observability root cause: historical Claude JobRecords did
not record which OAuth account was used. Claude `auth status --json` exposes
identity fields, but `safeClaudeOAuthStatus` intentionally dropped raw
user/email/org/account fields, so the session-limit event cannot be
retroactively tied to one browser account with hard evidence. This branch keeps
raw identity fields out of records and adds a provider-neutral one-way account
fingerprint to future OAuth status and runtime diagnostics.

## Speckit Note

This repo has no `.specify/` scripts in the active worktree. Speckit artifacts
are maintained manually under `specs/160-stale-env-cache-refresh/`.

## Architecture

Introduce one provider-neutral credential resolution path inside
`plugins/api-reviewers/scripts/api-reviewer.mjs`:

- Input: provider config `env_keys` and process env.
- Cache: existing `credentialEnvCachePath`, owner-only file check, env parsing,
  and `API_REVIEWERS_DISABLE_ENV_CACHE` behavior.
- Output: effective env overlay plus per-key source metadata.
- Source values: `env_cache`, `env`, or `null`.

No provider-specific branch is needed. No credential value is written to output.

For Grok CLI auth refresh, `plugins/grok/scripts/grok-web-reviewer.mjs` records
an auth-sync status and copies back only `auth.json` after both source and
runtime paths are proven to be regular, non-symlink files. The sync uses a
temporary file with `0600` permissions followed by atomic rename, and never
copies prompt, source, session, or config artifacts from the runtime home.

For provider usage limits, `scripts/lib/usage-limit.mjs` remains the canonical
classifier and is synced into each packaged reviewer runtime. The session-limit
case is handled there so Claude, Gemini, Grok, Kimi, and direct API records keep
one shared cost/quota vocabulary.

For provider workload admission, `scripts/lib/review-workload.mjs` is the
canonical lease helper and is synced into every reviewer package. The lease is
keyed by provider, process id, host, and job id; it reclaims dead same-host
holders, leaves active other-host holders alone, and emits a structured
pre-target failure with `payload_sent:false`.

For provider account identity, `scripts/lib/provider-identity.mjs` is the
canonical privacy helper and is synced into every reviewer package. It accepts
provider auth-status fields, emits only `identity_fields` plus a SHA-256 account
fingerprint, and never stores raw email, account, user, or org identifiers.

## TDD Slices

1. RED doctor test: stale env value plus refreshed cache value results in the
   cache value being used and `credential_source: "env_cache"`.
2. GREEN credential resolution: cache entries are read for all configured keys
   and override process env only for those keys.
3. RED fallback/source tests: no cache keeps `env`, disabled cache keeps `env`,
   and approval auth path includes `credential_source`.
4. GREEN source projection: doctor/run records/auth path include source without
   leaking secrets.
5. RED redaction regression: if the env cache changes after a provider request,
   provider echoes of the credential selected for that request are still
   redacted from stdout and persisted records.
6. RED workload-admission tests: same-provider source-bearing runs collide
   before launch, while source-free readiness probes and cross-provider runs
   remain allowed.
7. RED identity-observability tests: Claude OAuth status and source-bearing
   JobRecords include a provider account fingerprint while raw email/org/account
   values remain absent.

## Verification

- Focused `node --test --test-name-pattern "env cache|credential source|cache-sourced provider echoes|approval token is bound to credential source" tests/smoke/api-reviewers.smoke.test.mjs`
- `npm run smoke:api-reviewers`
- `npm test`
- `npm run lint`
- `git diff --check`
- `npm run smoke:grok`
- `npm run smoke:claude`
- Focused `node --test tests/unit/provider-identity.test.mjs tests/unit/job-record.test.mjs tests/unit/plugin-copies-in-sync.test.mjs tests/unit/ci-workflow.test.mjs --test-name-pattern "provider identity|provider account identity|provider-identity|pull-request CI runs shared-copy sync checks|Sonar CPD"`
- Focused `node --test --test-name-pattern "OAuth status success but non-interactive inference 401|records privacy-safe Claude OAuth account identity" tests/smoke/claude-companion.smoke.test.mjs`
- Live `node plugins/grok/scripts/grok-companion.mjs doctor`
- Claude and Grok latest-head review over a narrowed review bundle containing
  the tracked patch plus new spec artifacts.

## External Review Gate

Planning artifacts are reviewed before runtime code:

- `spec.md`
- `plan.md`
- `research.md`
- `data-model.md`
- `quickstart.md`
- `tasks.md`
- `contracts/credential-resolution.schema.json`

Missing, timed-out, shallow, failed, or no-verdict review slots are not
approval.
