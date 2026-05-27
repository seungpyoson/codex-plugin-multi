# Research: Refresh-Aware Direct API Credentials

## Decision: Owner-Only Env Cache Overrides Process Env For Configured Keys

**Rationale**: The issue is specifically that `process.env` is snapshotted for
the long-running Codex app-server. The env cache is refreshed by `load-env`
after key rotation, so it is the more current source when present and
owner-only.

**Alternatives considered**:

- `process.env` first, cache only when missing: current behavior; fails #160.
- Always use `op run`: fresher but much slower and more operationally invasive.
- Doctor-only stale-env banner: symptom mitigation, not a fix.

## Decision: Report Credential Source, Not Credential Value

**Rationale**: Operators need to know whether auth came from env or cache, but
secret values must never appear in stdout, stderr, JobRecords, or audit
metadata.

**Alternatives considered**:

- Report only `credential_ref`: insufficient to diagnose stale env/cache drift.
- Report cache path: not required for acceptance and leaks local filesystem
  details into persisted records.

## Decision: Include Source In Approval Auth Path

**Rationale**: Source-bearing approval is tied to the auth path. If the effective
credential source changes from env to cache, the approval tuple should change
without exposing the secret.

**Alternatives considered**:

- Keep auth path as `credential_ref` only: hides a real auth source change.
- Hash credential values into auth path: unnecessary and increases secret
  handling risk.

## Decision: Classify Claude "session limit" As A Usage Limit

**Rationale**: The historical Claude failure text was "You've hit your session
limit", but the shared classifier recognized "usage limit" and related
quota/billing terms only. The permission-mode ladder therefore retried the same
source packet three times as `claude_error`. Treating the wording as
`usage_limited` stops retry amplification and keeps the failure category shared
across providers.

**Alternatives considered**:

- Claude-only special case in the adapter: rejected because usage limits are a
  provider-neutral failure class.
- Disable the permission-mode ladder: rejected because it fixes unrelated
  recoverable permission-mode failures by design.

## Decision: Serialize Same-Provider Source-Bearing Reviewer Workloads

**Rationale**: The RCA found overlapping source-bearing Claude review jobs in
the local evidence window. Concurrent source-bearing reviews can burn the same
provider/account quota faster and make failure attribution harder. A
provider-neutral lease blocks only same-provider source-bearing work before
target launch; source-free probes and cross-provider reviews remain allowed.

**Alternatives considered**:

- Claude-only throttling: rejected because the same class can affect any
  subscription-backed or quota-limited provider.
- Global single-review lock: rejected because it would unnecessarily block
  cross-provider review parallelism.
- Hardcoded provider limits: rejected because the issue is workload admission,
  not a provider-specific numeric budget.

## Decision: Record Pseudonymous Provider Account Identity

**Rationale**: Historical Claude records cannot prove which authenticated
account consumed the session limit. Raw email, account, user, or org fields must
not be persisted, but future records need a stable way to compare "same account
or different account" during RCA. A provider-neutral SHA-256 fingerprint plus
field-name list gives that evidence without storing raw account values.

**Alternatives considered**:

- Store raw email/org/account fields: rejected for privacy and log-sharing
  safety.
- Store no identity: current behavior; blocks hard-evidence RCA for account
  mismatch or account rotation.
- Masked email hints: rejected for now because a fingerprint is enough for
  same/different account proof without displaying partial account text.
