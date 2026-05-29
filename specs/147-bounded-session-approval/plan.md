# Implementation Plan: Bounded Session Approval for Direct API Reviewers

**Branch**: `goal/provider-reliability-147-session-approval-grants`
**Spec**: `specs/147-bounded-session-approval/spec.md`
**Issue**: #147
**Base at plan creation**: `origin/main` at `119183e7663b262773482aa76b5d836d13ac94da`
**Head at plan creation**: `goal/provider-reliability-147-session-approval-grants` at `119183e7663b262773482aa76b5d836d13ac94da`

## Summary

Add a persisted, short-lived, bounded session grant for Direct API reviewers. The grant is created through source-free request/activation steps, then matching DeepSeek/GLM `run` invocations can proceed without a repeated per-run approval token. Any mismatch fails closed before source send and falls back to the existing approval-request/token workflow.

## Technical Context

- Runtime: Node.js ESM, no new dependencies.
- Target runtime file: `plugins/api-reviewers/scripts/api-reviewer.mjs`.
- Existing approval tests: `tests/smoke/api-reviewers.smoke.test.mjs`.
- Existing shared contracts/docs may need updates: `README.md`, `scripts/lib/external-model-contracts.mjs`, generated API reviewer skills/commands if help text or command contract changes.
- Current Direct API commands: `doctor`, `ping`, `approval-request`, `run`, `result`.
- Current approval model: deterministic approval token bound to provider, mode, selected source, rendered prompt hash, request, scope resolution, auth path, billing path, selected route, route step, route steps, fallback reason, and approval scope.

## Constitution / Safety Check

- Source-bearing Direct API sends require explicit approval evidence.
- Grant request and activation must be source-free.
- Existing per-request approval-token path must not be weakened.
- No selected-source bodies, raw rendered prompts, approval token values, API keys, cookies, or raw env values may be persisted.
- Provider-neutral shared behavior belongs in Direct API runtime helpers; provider ids should only supply capability facts.
- Merge, issue closure, cache refresh, destructive cleanup, and source-bearing external review remain separate explicit approval points.

## Scope

### In Scope

- CLI flow for requesting and activating a bounded session grant.
- Persisted grant files under API reviewer plugin data.
- Run-time matching against active grant files before provider launch.
- Audit manifest fields that distinguish `session_grant` from `approval_token`.
- Mismatch, expiry, malformed grant, and fallback tests.
- README/help/schema docs for operator behavior.

### Out of Scope

- API-backed rescue (#144).
- Grok provider architecture (#159).
- Credential rotation acceptance changes (#160), unless needed for tests.
- Provider parity analyzer/mode inventory (#178/#179).
- PR #185/#172 large-packet recovery changes unless that branch merges and creates a rebase conflict.

## Design

### Grant Commands

Implement one explicit Direct API command surface:

- `approval-grant request ...`: builds the same source-free approval tuple as `approval-request`, adds grant bounds, sets `approval_scope:"grant"`, and emits `external_review_session_approval_request` with `grant_bounds.expires_at` and `grant_approval_token.value`.
- `approval-grant activate ... --grant-expires-at <request.grant_bounds.expires_at> --approval-token <value>`: recomputes the same grant approval tuple using the exact request expiry timestamp, validates a grant-scoped token, writes or returns the matching grant file, and emits `external_review_session_approval_grant`.

The command names are intentionally explicit. A grant is not created by merely running `approval-request`.
Activation MUST reject normal source-bearing `approval-request` tokens, `approval_scope:"session"` tokens, and `approval_scope:"once"` tokens. Only the grant-scoped token emitted by `approval-grant request` can create a grant.

### Grant Bounds

Initial required bounds:

- provider allowlist: current provider by default
- mode allowlist: current mode by default
- workspace root hash
- selected paths and selected-source hashes
- scope resolution
- rendered prompt hash
- request settings
- auth path
- billing path
- selected route
- route step
- route steps
- fallback reason
- max files
- max bytes
- expiry / TTL
- maximum TTL

The first implementation requires the operator to pass `--grant-ttl-ms` and uses the configured `plugins/api-reviewers/config/session-approval.json` `max_ttl_ms` value as the grant TTL maximum. Any missing, invalid, or over-maximum TTL fails before token validation or grant persistence. Request output includes the concrete `grant_bounds.expires_at` timestamp computed from the accepted TTL. Activation must use that exact timestamp through `--grant-expires-at`; it must not recompute expiry from the current activation time because that would change the canonical grant proof.

### Canonical Grant Proof

`approval_fingerprint` is `sha256` over a stable canonical JSON object named `approval_tuple`.

`approval_tuple` MUST contain:

- provider
- mode
- selected source summary and content hashes
- rendered prompt hash
- request settings
- scope resolution
- auth path
- billing path
- selected route
- route step
- route steps
- fallback reason
- approval scope `grant`
- grant bounds

`grant_bounds` MUST contain the provider allowlist, mode allowlist, workspace root hash, path constraints, max files, max bytes, expiry, maximum TTL, and grant schema version. Persisted top-level grant fields are indexes/projections of `approval_tuple.grant_bounds`; runtime load must verify they match the nested canonical tuple.

Canonical JSON is implementation-defined as `canonicalJson(value)`:

- Inputs are JSON primitives, arrays, and plain objects only.
- Objects are serialized as `{}` with property names sorted by ascending UTF-16 code unit order. All current tuple keys are ASCII, so this is deterministic across supported Node versions.
- Arrays preserve their existing order. Tuple construction must build arrays deterministically before serialization; `selected_source.files` and `path_constraints.scope_paths` are sorted by path/string value before they enter `approval_tuple`.
- Strings, numbers, booleans, and null use `JSON.stringify` scalar encoding. Non-finite numbers are invalid.
- No insignificant whitespace is emitted.
- The SHA-256 digest is computed over UTF-8 bytes of that canonical string.

The fingerprint is not a signature or MAC. It detects accidental corruption and inconsistent local edits inside the existing plugin-data trust boundary; it does not protect against a malicious local filesystem writer who can rewrite both tuple and digest.

### Grant Store

Store grants under:

`<apiReviewerDataRoot>/approval-grants/<grant_id>.json`

Rules:

- Use safe deterministic grant ids derived from `approval_fingerprint` so duplicate activation of the same request is idempotent.
- Use `grant_session_id` as an audit identifier only. It is generated as a UUID-style safe token when no host session id is available and is never used as a filesystem path component.
- Use exclusive create for new grant files; if the same fingerprint already exists and still validates, return that grant rather than creating a duplicate.
- Write with owner-only file mode where supported.
- Ignore unreadable/malformed/schema-invalid/expired grants.
- Recompute `approval_fingerprint` on every load and reject mismatches.
- Never store activation token values.

### Runtime Matching

Before existing approval-token rejection:

1. Build current grant approval tuple using the same canonical shape as activation.
2. If `--approval-token` is present, keep existing behavior.
3. If no token is present, scan active grants for the current workspace.
4. Reject any grant whose schema, top-level bound projections, or recomputed fingerprint do not match.
5. A grant matches only when provider/mode allowlists include the current run, workspace hash matches, selected source and rendered prompt hashes match exactly, route/auth/billing/request/scope fields match exactly, current file and byte totals are within bounds, and the grant is unexpired.
6. `path_constraints.scope_paths:null` is literal, not a wildcard. It only matches a later run whose resolved scope paths are also null and whose selected-source hash summary matches exactly. Smaller subsets do not match unless their full selected-source summary is identical to the grant tuple.
7. If exactly one grant matches, treat source-send approval as granted by `session_grant`.
8. If none match, return existing `approval_required` failure.
9. If multiple active grants match, fail closed with `approval_required`; do not choose newest.

### Audit Fields

For grant-approved runs, add:

```json
{
  "approval_source": "session_grant",
  "approval_grant": {
    "grant_id": "...",
    "grant_session_id": "...",
    "created_at": "...",
    "expires_at": "...",
    "matched_at": "...",
    "max_files": 1,
    "max_bytes": 26
  }
}
```

For per-request token runs, add or preserve:

```json
{
  "approval_source": "approval_token"
}
```

Do not persist token values.

## Test Plan

Use TDD in `tests/smoke/api-reviewers.smoke.test.mjs`.

RED/GREEN slices:

1. Grant request emits source-free bounded request and no selected-source body.
2. Grant activation persists a grant with no token/source/secret body.
3. Matching grant-approved run succeeds without `--approval-token` and records `approval_source:"session_grant"`.
4. Normal session tokens and one-time tokens cannot activate grants.
5. Grant-scoped tokens cannot be used as normal run `--approval-token` values.
6. Provider mismatch fails before source send.
7. Scope path/content/max-file/max-byte mismatch fails before source send.
8. Prompt/request/auth/billing/route mismatch fails before source send.
9. Expired, malformed, schema-invalid, fingerprint-tampered, unreadable, duplicate-ambiguous, and multiple-match grants fail before source send.
10. Existing per-request approval token still works outside grant.
11. Grant files are owner-only where supported.

Verification commands:

- `node --test --test-name-pattern "<focused #147 pattern>" tests/smoke/api-reviewers.smoke.test.mjs`
- `npm run smoke:api-reviewers`
- `npm test`
- `npm run lint`
- `git diff --check`

## Implementation Steps

1. Add tests for the first grant request behavior and verify RED.
2. Add minimal request command code and verify GREEN.
3. Add activation persistence test and code.
4. Add matching run test and code.
5. Add mismatch/expiry/fallback tests one by one.
6. Update README/help/contracts after behavior is green.
7. Run focused and broad verification.
8. Request final review and address findings.

## Review Gate

Before implementation, send spec/plan/tasks/contracts for adversarial review to:

- Claude
- Gemini
- Grok
- GLM
- DeepSeek
- Kimi

Unusable verdicts do not count. If a reviewer cannot produce a usable verdict, stop for operator decision rather than treating the gate as passed.

## Residual Risks

- Current CLI has no guaranteed host Codex session id, so the first implementation uses TTL/workspace bounds as the hard session control.
- Grant storage shares the same local trust boundary as existing plugin data. Tests must verify malformed/tampered grant files fail closed and strict schema/fingerprint checks are applied on every load.
- If #172 merges before #147, rebase and verify approval tuple compatibility.
