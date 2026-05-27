# Research: Bounded Session Approval for Direct API Reviewers

## Decision 1: Add a Real Grant Model, Not a Looser Token

**Decision**: Implement a persisted bounded grant that is separate from current per-request `approval_token.value`. Grant activation uses a grant-scoped proof emitted as `grant_approval_token.value`.

**Rationale**: Current `approval_scope:"session"` already allows the same deterministic token to be replayed for the same tuple, but the operator still needs to carry that token into each run. #147 asks for repeated matching runs to proceed without repeated manual approval. A persisted grant gives the runtime a safe lookup target while preserving the source-egress boundary.

**Alternatives considered**:
- Reuse existing `approval_scope:"session"` token silently: rejected because it has no grant id, expiry, max file/byte bounds, or audit source distinction.
- Add an env var bypass: rejected by issue non-goals.
- Store raw prompts/source for matching: rejected by privacy requirements.

## Decision 2: Source-Free Grant Request and Activation

**Decision**: Grant creation is a two-step source-free flow: request a grant tuple, then activate the grant with a matching approval proof. Neither step sends selected source.

**Rationale**: The existing approval-request pattern already proves selected source remains `not_sent` until explicit approval. Grant activation should reuse that safety shape instead of introducing a privileged write path.

**Alternatives considered**:
- Create grant directly on `approval-request`: rejected because merely asking for approval should not create durable permission.
- Create grant on first `run`: rejected because the first source-bearing run would blur approval and source-send boundaries.

## Decision 3: Matching Uses Existing Audit Tuple Plus Bounds

**Decision**: Grant matching must compare the same tuple already used for approval-token binding and add explicit grant bounds: workspace identity, expiry, max files, max bytes, provider allowlist, mode allowlist, and selected-scope constraints.

**Rationale**: Existing tests already protect provider, mode, source packet, prompt hash, request settings, auth path, billing path, selected route, route step, route steps, and fallback reason. #147 extends this from one token to a durable grant, so the same tuple should remain the core matching surface.

**Alternatives considered**:
- Match only selected-source hash: rejected because prompt/request/auth/billing route changes can materially change what is sent and billed.
- Match only paths/globs: rejected because content could change under the same path.

## Decision 4: Short TTL Is the Required Session Bound

**Decision**: Use a short expiry/TTL as the required session bound, and persist a grant session id when a stable session identifier is available or generated during activation.

**Rationale**: The CLI process is stateless across invocations and may not have a reliable Codex session id. A short TTL is explicit, testable, and satisfies #147's "short TTL or current session only" requirement without relying on host internals.

**Alternatives considered**:
- Require a Codex session env var: rejected because it would make local CLI/test flows brittle.
- No expiry when workspace matches: rejected as too broad.

## Decision 5: Fail Closed to Existing Approval Flow

**Decision**: Any grant miss, expiry, parse failure, unreadable grant file, or mismatch returns the existing approval-required failure shape and preserves `not_sent`.

**Rationale**: Operators already understand `approval_required` and `approval-request`. Keeping fallback behavior stable avoids introducing a second error taxonomy for the same safety gate.

**Alternatives considered**:
- Auto-run `approval-request` when a grant misses: rejected because it could obscure source-egress state and surprise operators.

## Decision 6: No Secret or Source Body Persistence

**Decision**: Persist hashes, relative paths, counts, route/auth/billing key names, request settings, grant id, expiry, and audit state only. Do not persist raw prompts, source bodies, approval token values, credentials, cookies, or raw provider payloads.

**Rationale**: Existing Direct API approval and JobRecord privacy rules must remain intact.

**Alternatives considered**:
- Persist rendered prompt text for easier debugging: rejected by FR-009 in the active readiness spec.
