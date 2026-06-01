# Issue 144 Evidence Matrix

Live state verified on 2026-06-01 KST.

- Repository: `seungpyoson/relay`
- Worktree: `/Users/spson/Projects/Claude/relay/.worktrees/provider-reliability-144-api-rescue`
- Branch: `goal/provider-reliability-144-api-rescue`
- Base: `origin/main` at `cc55c289aa9590b773f4995421b5bafd82a55350`
- Open PRs at verification: none
- Prompt drift: the saved prompt still names `codex-plugin-multi` and `specs/140-no-mistakes-provider-readiness/`; relay has no `specs/` or `.specify/` directory after the rename/open-source cleanup. This goal therefore uses Speckit-style artifacts under `docs/issue-144-api-backed-rescue/`.

## Issue Matrix

| Issue | State | Evidence | Verdict | Smallest Valid Next Action | Wrong-Grouping Risk |
| --- | --- | --- | --- | --- | --- |
| #144 Add API-backed rescue workflow for direct API reviewers | OPEN | GitHub issue says DeepSeek/GLM currently support `doctor`, `ping`, `approval-request`, and review modes, but no write-capable rescue protocol. Current runtime allows only `review`, `adversarial-review`, `custom-review` in `plugins/api-reviewers/scripts/api-reviewer.mjs:47`; `run --mode rescue` is rejected at `plugins/api-reviewers/scripts/api-reviewer.mjs:4168`; smoke coverage asserts that rejection at `tests/smoke/api-reviewers.smoke.test.mjs:1461`. | Still open | Add a provider-capability-gated rescue proposal plus explicit source-free apply approval/apply protocol. | Reopening packet budget, stale env, or Grok transport work would mix completed reliability slices into a new write-capability feature. |
| #171 Provider architecture parity | CLOSED | GitHub issue closed 2026-05-25; PR #175 merged. Relay docs require provider differences to be Adapter capability facts in `docs/provider-parity-table.json`. | Groundwork only | Keep rescue support capability-gated for DeepSeek/GLM and keep shared policy in the direct API runtime. | Provider-specific one-off rescue paths would regress the #171 shared-policy rule. |
| #172 Large packet recovery | CLOSED | GitHub issue closed 2026-05-29; PR #185 merged. Runtime already has packet recovery and source-send approval metadata. | Groundwork only | Reuse approval and packet budget gates for `rescue`; do not rebuild packet recovery. | A new rescue approval path that bypasses packet gates would weaken #172. |
| #147 Bounded session approval | CLOSED | GitHub issue closed 2026-05-29; PR #186 merged. Runtime already binds source approval tuples and grants. | Groundwork only | Reuse source-send approval for rescue proposal generation. Add a separate apply approval token for local patch application. | Treating source-send approval as patch-apply approval would over-authorize local writes. |
| #159 Grok CLI-primary parity | CLOSED | GitHub issue closed 2026-05-29; PR #188 merged. Grok is not a direct API rescue target in #144. | Out of scope | Do not add Grok rescue behavior here. | Pulling Grok into this feature would broaden beyond direct API reviewers. |
| #160 Direct API stale env | CLOSED | GitHub issue closed 2026-05-29; PR #187 merged. Credential provenance is already represented in the direct API JobRecord. | Groundwork only | Preserve existing credential/auth/billing audit fields in rescue records. | Touching credential precedence for rescue would risk reopening stale-env behavior. |

## Current Runtime Evidence

- Direct API modes are review-only: `VALID_MODES` excludes `rescue`.
- Help exposes `doctor`, `ping`, `approval-request`, `approval-grant`, `run`, `result`, but no apply command.
- `buildRecord` always emits `mutations: []` for direct API runs, so direct API reviewers currently cannot represent applied edits.
- README command inventory exposes rescue only for Claude/Gemini/Kimi; DeepSeek/GLM expose review, adversarial-review, and custom-review only.
- Artifact cleanup docs explicitly scope DeepSeek/GLM to `review`, `adversarial-review`, and `custom-review`; rescue persistence must be documented if added.

## Deepening Candidates

1. **Module:** direct API rescue patch proposal/apply module.
   **Files:** `plugins/api-reviewers/scripts/lib/api-rescue-patch.mjs`, `plugins/api-reviewers/scripts/api-reviewer.mjs`, `tests/smoke/api-reviewers.smoke.test.mjs`.
   **Problem:** Putting patch parsing, patch hashing, apply approval tokens, `git apply` validation, and mutation snapshots directly into the 168 KB runtime would make the runtime interface as complex as the implementation.
   **Solution:** Add a deep Module with a small Interface: parse a provider rescue proposal, compute stable proposal/apply fingerprints, build apply approval metadata, validate/apply a unified diff, and report mutations.
   **Benefits:** Better Locality for the write-capable feature, higher Leverage for tests through the CLI, and fewer direct edits to the existing approval/source-send code.

2. **Module:** direct API workflow metadata generation.
   **Files:** `scripts/lib/external-model-contracts.mjs`, generated `plugins/relay-deepseek/*`, `plugins/relay-glm/*`, README command inventory.
   **Problem:** Rescue surface exposure spans skills, commands, README, and runtime help; hand-editing generated files would create drift.
   **Solution:** Extend the existing workflow generation Interface to include direct API rescue when provider capability metadata allows it, then run sync checks.
   **Benefits:** Maintains Locality for generated surfaces and keeps provider differences as Adapter capability facts.

3. **Module:** apply-result JobRecord builder.
   **Files:** `plugins/api-reviewers/scripts/api-reviewer.mjs`, optional helper in `api-rescue-patch.mjs`.
   **Problem:** Applying a patch is not a provider call, but it still needs the same audit shape and retained history as provider records.
   **Solution:** Build a source-free apply JobRecord with `parent_job_id` set to the rescue proposal job, `mode: rescue-apply`, `source_content_transmission: not_sent`, `structured_output.apply`, and before/after mutations.
   **Benefits:** Keeps proposed edits and applied edits distinguishable without overloading review records.

Selected design uses candidates 1, 2, and 3. No implementation code may start until external plan/task review approves this design.
