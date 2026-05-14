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

**Why this priority**: Current default Grok path dies before tunnel startup because `uv` tries the operator's home cache directory (for example `$HOME/.cache/uv`), which is blocked in Codex sandbox.

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

---

### User Story 4 - Reviewer Continuation Uses The Right External Session Context (Priority: P1)

An operator runs a source-bearing review and then asks the same provider to continue from that result. The plugin resumes the real provider conversation in the same external session/project context, or fails with a precise, evidence-backed classification.

**Why this priority**: A source-bearing review can pass while follow-up review fails if the plugin stores the right-looking session id but resumes it from a different runtime project context. That makes continuation untrustworthy even when the initial review, cache doctor, and source selection are clean.

**Independent Test**: Run the installed Claude review and `continue --job` path against a synthetic git fixture, then inspect both persisted JobRecords for provider session id, parent job id, runtime child cwd, stdout/stderr diagnostics, and review-quality fields.

**Acceptance Scenarios**:

1. **Given** an initial Claude review completes with a persisted provider session id, **When** `continue --job <parent>` runs, **Then** the continue invocation resumes in the same Claude project/session lookup context and does not fail with `No conversation found with session ID`.
2. **Given** a provider stores conversations by runtime project/cwd, **When** the plugin creates neutral working directories for source safety, **Then** the provider session lookup cwd remains stable across parent and continue jobs while throwaway worktrees may differ.
3. **Given** a continue run emits empty stdout and actionable stderr, **When** the JobRecord is built, **Then** the top-level error message exposes the bounded stderr cause and preserves `failed_review_slot: true`.
4. **Given** a provider cannot support continuation with the available evidence, **When** `continue --job` is requested, **Then** the failure class and next action state the missing provider/session evidence instead of treating plausible prose as success.

## Edge Cases

- Fresh Codex session cannot run `codex debug prompt-input` inside sandbox.
- Direct API providers require approval before source-bearing runs.
- Grok has reachable `/models` but no runtime session tokens.
- Provider prose says approve but audit fields fail.
- Review record contains no full rendered prompt even when source was sent.
- Provider conversation ids equal plugin job ids but are only resolvable inside the original provider project/cwd.
- Continuation uses a new neutral cwd and the external CLI cannot find a persisted conversation.
- Tiny semantic replay prose proves a classifier branch but is too short to satisfy full review-quality gates.
- A merge, cleanup, issue closure, or remote mutation is requested without explicit current-turn approval.

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
- **FR-010**: Continuation-capable providers MUST persist the provider conversation/session id separately from plugin job linkage fields whenever the provider exposes a distinct id.
- **FR-011**: Continuation-capable providers MUST persist enough runtime context to resolve the provider session on follow-up, including provider project/cwd when the external runtime scopes session lookup by cwd.
- **FR-012**: `continue --job` MUST reuse provider session lookup context from the parent record while preserving fixture/source safety and avoiding real project source send.
- **FR-013**: Empty-stdout failures with actionable stderr MUST promote a bounded stderr message into operator-visible JobRecord diagnostics without masking parser or audit fields.
- **FR-014**: Semantic replay checks MUST distinguish narrow classifier probes from full review-quality audits; non-review-shaped snippets MUST NOT be expected to satisfy verdict or shallow-output gates.
- **FR-015**: Live smoke criteria MUST include initial review and continuation for every supported continuation provider, not only initial source-bearing review.
- **FR-016**: Merge, issue closure, destructive cleanup, and remote mutation steps MUST require explicit operator approval in the current workflow before execution.
- **FR-017**: Review-quality audit MUST recognize provider checklist formats used by live reviewers, including bold `Checklist item N` labels, without counting ordinary item-prefixed prose as checklist evidence.
- **FR-018**: Review-quality audit MUST distinguish negated passing language such as `without permission blocks` from concrete permission denial or source-inspection failure language on the same line.

### Key Entities

- **Provider Row**: One provider result with status, failure class, source-send state, quality gate, mutation and persistence checks.
- **Readiness Manifest**: Complete evidence object for one synthetic-fixture run.
- **Synthetic Fixture**: Git-backed `/private/tmp` repository used for live smoke without real project source.
- **Continuation Record**: Pair of parent and follow-up JobRecords with provider session id, parent job id, runtime project/cwd evidence, stdout/stderr diagnostics, and review-quality result.
- **Semantic Replay Probe**: Synthetic provider prose replayed through the audit/parser layer with an explicit mode: classifier-only or full-review-audit.
- **Operator Approval Gate**: Evidence that merge, remote mutation, destructive cleanup, or source-send was explicitly approved before execution.

## Success Criteria

### Measurable Outcomes

- **SC-001**: One command or documented sequence produces a complete six-provider manifest.
- **SC-002**: Grok default auto-start smoke proves no inherited sandbox-blocked uv cache path is required.
- **SC-003**: Direct API approval-request rows show `source_content_transmission: "not_sent"` before approved runs.
- **SC-004**: Every completed source-bearing row has `failed_review_slot=false`, no tracked fixture mutation, and no persisted full prompt key.
- **SC-005**: Failure classes are explicit: `sandbox`, `auth`, `provider`, `tunnel`, `session_tokens`, `review_quality`, `approval_gate`, `cache_install`, `parser`, `transport`, `continuation`, `workflow_gate`, or `missing_evidence`.
- **SC-006**: Claude initial review plus `continue --job` passes on a git-backed synthetic fixture without `No conversation found with session ID`, with stable provider session lookup cwd across parent and continue records.
- **SC-007**: Semantic permission-block probes prove no `permission_blocked` false positive for passing or negated prose, while full-audit pass expectations are limited to review-shaped outputs with verdict and sufficient substance.
- **SC-008**: Regression tests fail if continuation only asserts `--resume` argv but does not model provider session lookup context.
- **SC-009**: Workflow evidence distinguishes approved merges/remote mutations from unapproved operations; unapproved operations are blocked, not normalized after the fact.

## Assumptions

- Synthetic fixture source can be sent to live providers after explicit approval for direct APIs.
- Real secrets remain in existing runtime stores and are never printed.
- External reviewer CLIs may scope conversation persistence by provider project/cwd, not only by session id.
- Plugin job ids may look identical to provider session ids in some providers; correctness still depends on where and how that id is resolved.
- Semantic replay of short snippets is valid for classifier branch testing, not for proving full reviewer output quality.
- `.no-mistakes.yaml` remains configured with `npm ci && npm run lint && npm run test:full`, but no-mistakes is not authoritative merge evidence until `seungpyoson/claude-config#780` is fixed.
- Direct local verification and GitHub CI are authoritative for this slice while no-mistakes has the review/fix-loop defect.
