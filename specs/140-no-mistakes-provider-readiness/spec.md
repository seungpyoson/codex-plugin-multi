# Feature Specification: No-Mistakes Provider Readiness

**Feature Branch**: `140-no-mistakes-provider-readiness`
**Created**: 2026-05-11
**Status**: Draft
**Input**: User description: "Create a GitHub follow-up issue and execute. Use no-mistakes, TDD, and Spec Kit. Make every model usage perfect."

## User Scenarios & Testing

### User Story 1 - Fresh Reviewer Readiness Is Trustworthy (Priority: P1)

An operator runs installed reviewer setup or smoke checks from a fresh Codex session and gets a deterministic provider-by-provider result: ready, blocked by sandbox, blocked by auth, blocked by tunnel/session, or failed review quality.

**Why this priority**: Reviewers are unsafe to trust when readiness, auth, tunnel, and review-quality failures collapse into prose.

**Independent Test**: Run the readiness/smoke harness against a synthetic git fixture and inspect the manifest rows for all providers.

**Acceptance Scenarios**:

1. **Given** installed plugin cache is in sync, **When** the harness runs doctors for Claude, Gemini, Kimi, Grok, DeepSeek, and GLM, **Then** every provider row has a status, failure class, and next action.
2. **Given** a provider cannot run because of sandbox limits, **When** skill or runtime probes fail, **Then** the result says sandbox, not install failure.
3. **Given** a source-bearing review completes, **When** the manifest is built, **Then** it records `source_content_transmission`, review-quality gate, mutation status, prompt-persistence status, and elapsed time.

---

### User Story 2 - Grok Default Startup Does Not Fail On Sandbox UV Cache (Priority: P1)

An operator runs Grok setup without pre-setting `UV_CACHE_DIR`; the plugin starts `uv` with a sandbox-writable cache or reports a session-token problem after the tunnel becomes reachable.

**Why this priority**: Current default Grok path dies before tunnel startup because `uv` tries `/Users/spson/.cache/uv`, which is blocked in Codex sandbox.

**Independent Test**: Run Grok smoke with fake `uv` that records env and assert the plugin injects a writable `UV_CACHE_DIR` when caller did not provide one, while preserving explicit caller values.

**Acceptance Scenarios**:

1. **Given** no `UV_CACHE_DIR` env var, **When** Grok auto-start spawns `uv`, **Then** the child receives a cache dir under the default plugin runtime area.
2. **Given** caller sets `UV_CACHE_DIR`, **When** Grok auto-start spawns `uv`, **Then** the caller value is preserved.
3. **Given** tunnel starts but runtime has zero active tokens, **When** doctor runs, **Then** it reports `grok_session_no_runtime_tokens` with sync/import guidance, not generic tunnel failure.

---

### User Story 3 - Review Quality Failures Are Reproducible Or Classified (Priority: P2)

Maintainers can distinguish model/provider defects from operator prompt-shape mistakes and old-run noise.

**Why this priority**: Kimi had one old `review_not_completed` result, but current corrected prompt runs passed twice.

**Independent Test**: Run current prompt-shape smoke twice for Kimi against synthetic fixture and inspect both audit gates; keep old malformed-output class covered by tests.

**Acceptance Scenarios**:

1. **Given** Kimi output is shallow or lacks verdict, **When** JobRecord is built, **Then** result fails with `review_not_completed`.
2. **Given** current prompt shape is used, **When** Kimi reviews the synthetic fixture, **Then** review quality gate can pass and the manifest does not treat old malformed output as current readiness failure.

## Edge Cases

- Fresh Codex session cannot run `codex debug prompt-input` inside sandbox.
- Direct API providers require approval before source-bearing runs.
- Grok has reachable `/models` but no runtime session tokens.
- Provider prose says approve but audit fields fail.
- Review record contains no full rendered prompt even when source was sent.

## Requirements

### Functional Requirements

- **FR-001**: System MUST produce a MECE provider readiness/smoke manifest for Claude, Gemini, Kimi, Grok, DeepSeek, and GLM.
- **FR-002**: Manifest rows MUST include doctor result, review result where allowed, approval/no-send result for direct APIs, source transmission, review-quality result, mutation result, prompt-persistence result, elapsed time, and failure class.
- **FR-003**: Grok auto-start MUST provide a sandbox-writable `UV_CACHE_DIR` to `uv` when caller did not set one.
- **FR-004**: Grok auto-start MUST preserve explicit caller `UV_CACHE_DIR`.
- **FR-005**: Grok readiness MUST distinguish tunnel startup failure from no active runtime session tokens.
- **FR-006**: Direct API source-bearing runs MUST require approval-request proof before sending source.
- **FR-007**: Skill visibility failure inside sandbox MUST be classifiable as sandbox failure when outside-sandbox probe succeeds.
- **FR-008**: Review-quality audit fields MUST be source of truth over provider prose.
- **FR-009**: Full rendered prompts MUST NOT be persisted in records or manifests.

### Key Entities

- **Provider Row**: One provider result with status, failure class, source-send state, quality gate, mutation and persistence checks.
- **Readiness Manifest**: Complete evidence object for one synthetic-fixture run.
- **Synthetic Fixture**: Git-backed `/private/tmp` repository used for live smoke without real project source.

## Success Criteria

### Measurable Outcomes

- **SC-001**: One command or documented sequence produces a complete six-provider manifest.
- **SC-002**: Grok default auto-start smoke proves no inherited sandbox-blocked uv cache path is required.
- **SC-003**: Direct API approval-request rows show `source_content_transmission: "not_sent"` before approved runs.
- **SC-004**: Every completed source-bearing row has `failed_review_slot=false`, no tracked fixture mutation, and no persisted full prompt key.
- **SC-005**: Failure classes are explicit: `sandbox`, `auth`, `provider`, `tunnel`, `session_tokens`, `review_quality`, `approval_gate`, or `cache/install`.

## Assumptions

- Synthetic fixture source can be sent to live providers after explicit approval for direct APIs.
- Real secrets remain in existing runtime stores and are never printed.
- no-mistakes remains the PR gate and runs `npm ci && npm run lint && npm run test:full`.
- This slice can fix Grok uv-cache behavior before building the full live manifest CLI.
