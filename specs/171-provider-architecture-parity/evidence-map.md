# Provider Architecture Parity Evidence Map

Date: 2026-05-24
Branch: `goal/provider-architecture-parity-171`
Worktree: `.worktrees/provider-architecture-parity-171`
Primary issue: #171
Topology input issue: #170

## Baseline Evidence

- Current worktree head inspected: `5e4878e1dd6cc8fc72f06e1b4af6923659e46ca5`.
- PR #175 is open/draft and claims `Closes #171`, but the claim is stale after
  operator clarification.
- `.specify/` is absent in the linked worktree, so Speckit artifacts are
  maintained manually under `specs/171-provider-architecture-parity/`.
- `root-problems.md` now supersedes the older evidence conclusion.

## Issue Evidence

- #171 requires one shared provider architecture contract unless a provider has
  a documented, tested reason to differ. It explicitly includes Claude, Gemini,
  Kimi, Grok, DeepSeek, GLM, route/fallback behavior, JobRecord/status/lifecycle
  semantics, provider readiness, source-send approval state, billing path,
  failure class, next action, generated docs, and packaged copies.
- #170 is topology evidence input only.
- #159 says Grok auto/web fallback is only one slice of broader Grok provider
  architecture parity.
- #172 shows large custom-review packets fail inconsistently: DeepSeek/Grok
  reject before send, Gemini/Kimi fail after send, Kimi can return
  `step_limit_exceeded`.
- #173 was opened from Claude evidence, but the corrected root problem is not
  Claude-only. It is shared source-packet budget/resend policy for all six.

## Current Architecture Evidence

| Policy Area | Current Evidence | Verdict |
| --- | --- | --- |
| Route ladder | `scripts/lib/provider-route-policy.mjs` supports only `subscription` and `api`. It has no first-class OpenRouter route step and no ordered route-attempt ledger. | `accidental_provider_specific_policy` |
| DeepSeek/GLM routing | `plugins/api-reviewers/scripts/api-reviewer.mjs` calls `selectProviderRoute({ requestedRoute: "subscription" })` with only API capabilities. This records `subscription_not_supported`, then direct API. It does not prove a full subscription -> direct API -> OpenRouter ladder. | `unknown_needs_research` |
| Kimi routing | `plugins/kimi/scripts/kimi-companion.mjs` declares subscription capability only, rejects `--auth-mode`, and reports Kimi/Moonshot API env names as ignored. This does not satisfy the same route ladder as Claude/Gemini. | `accidental_provider_specific_policy` |
| Claude/Gemini routing | `scripts/lib/auth-selection.mjs` wraps shared route selection for subscription and explicit API-key modes. This is closer to desired policy, but OpenRouter route and exact fallback parity are not proven. | `unknown_needs_research` |
| Grok routing | Grok has CLI/web subscription transports and PR #175 adds `auto`. This is an Adapter transport-candidate fact inside the `subscription` route, not a separate provider policy. Guardrails now require shared source-transmission policy usage and preserved CLI diagnostics on auto fallback. | `documented_adapter_capability_fact` |
| OpenRouter fallback | Repo docs/contracts mention OpenRouter approval semantics, but runtime/provider config evidence does not show OpenRouter as third route step for all six. | `unknown_needs_research` |
| Packet budget/resend | #172/#173 prove inconsistent behavior. Current PR treats packet budget as follow-up/split instead of #171 shared policy. | `accidental_provider_specific_policy` |
| Failure taxonomy/status/review quality | Shared libs exist for failure classification, review panel, external review, and review prompt. Need matrix proof that all six use same field meanings for the corrected policy states. | `unknown_needs_research` |
| Packaged copies/sync | Sync scripts and copy tests exist. This is necessary but not sufficient; copied shared libs can still encode wrong policy. | `packaging_copy_with_sync_guard` |

## Provider Route Capability Snapshot

| Provider | Subscription Evidence | Direct API Evidence | OpenRouter Evidence | Current Gap |
| --- | --- | --- | --- | --- |
| Claude | Companion uses subscription OAuth default through `auth-selection.mjs`. | Explicit `api_key` route exists with approval flow. | Mentioned in generated contracts, not proven as route step. | No all-provider route ladder with OpenRouter. |
| Gemini | Companion uses subscription OAuth default through `auth-selection.mjs`. | Explicit `api_key` route exists with approval/fallback helper. | Mentioned in generated contracts, not proven as route step. | No all-provider route ladder with OpenRouter. |
| Kimi | Companion declares subscription capability only. | API env names are listed as ignored; `--auth-mode` rejected. | Not proven. | Breaks subscription -> direct API -> OpenRouter parity. |
| Grok | CLI/web subscription transport candidates exist; `--transport auto` arbitrates only those candidates. | Paid xAI API fallback intentionally forbidden and remains an Adapter/billing capability fact. | Not proven. | Must keep Grok transport auto documented/tested as Adapter internals while shared policy records `subscription` route metadata. |
| DeepSeek | No subscription Adapter found. | Direct API config exists in `plugins/api-reviewers/config/providers.json`. | Not proven. | API-only shortcut is shallow shared helper usage, not full ladder. |
| GLM | No subscription Adapter found. | Direct API config exists in `plugins/api-reviewers/config/providers.json`. | Not proven. | API-only shortcut is shallow shared helper usage, not full ladder. |

## Symptom Root-Cause Evidence

### Kimi `step_limit_exceeded`

- `/private/tmp/cpm-171-plan-review/kimi-result.json` failed as
  `custom-review` with `scope_base:null`, nine explicit `scope_paths`,
  `source_content_transmission:"sent"`, and `step_limit_exceeded` at 96 steps.
- `/private/tmp/cpm-171-final-review/kimi-final2.json` and
  `kimi-final4.json` failed as `custom-review` with source sent and
  `step_limit_exceeded` at 120 steps.
- The latest minimal packet attempt
  `abdc226d-d5b1-4b12-b19a-f7cf9eb6cb69` reviewed only
  `provider-parity-table.json` (21,565 bytes, one file), sent source, and
  failed with `timeout` after 257,212 ms without stdout, stderr, or verdict.
- Later Kimi single-file retries prove the behavior is not purely byte-size
  driven: `root-problems.md` (12,881 bytes), `spec.md` (11,554 bytes), and
  compact `plan.md` (5,694 bytes) completed with usable APPROVE verdicts, while
  old `plan.md` (7,696 bytes) timed out after source send and old `tasks.md`
  became stale after source send with no stdout, stderr, or verdict
  (`3c39881a-2875-4ba8-a785-ae3bcca4c2f8`,
  `c14df593-ce72-4a5a-ba3e-0a1e20b80227`).
- Kimi job `4ad59213-96b4-40a4-9f03-6f7e04ab3504` then approved compact
  `tasks.md` (5,192 bytes). That makes the compact task list usable, but it
  does not prove a final current-packet six-reviewer gate.
- Kimi job `ea4c9156-8a96-449f-ac99-2c87ad52d57b` sent the four-file current
  planning packet (35,495 bytes) and failed with wall-clock `timeout` after
  907,148 ms without a verdict.
- Kimi job `0ef067c5-d9be-4820-a7d4-034b337c54b6` used the compact prompt
  contract on current PR #175 delta `50c954c..29832ae`, sent 21 files / 63,197
  bytes / 1,304 lines, and failed with `step_limit_exceeded` at
  `--max-steps-per-turn 128`.
- Raw no-tool continuation of Kimi session
  `73ab07c5-7c8a-4661-a271-632e13a5143d` sent no source and returned
  `Verdict: NOT_REVIEWED` because the prior selected source was not present in
  the resumed context. Companion no-source continuation with file tools would
  have made `source_content_transmission:not_sent` misleading if Kimi read files
  through tool calls, so Kimi no-source repair is now an unsupported adapter
  capability.
- Kimi job `08d2f957-bb06-4222-a15c-651691be8655` re-ran the same broad packet
  after the adapter capacity fact and failed before launch as
  `source_packet_too_large`, with `source_packet_budget_bytes:32768`,
  `selected_source_bytes:63197`, and `source_content_transmission:not_sent`.
- Cross-repo bolt-v2 PR #479 job `b465418e-913a-42c2-9c84-6befb9c789bb`
  used the cached installed Kimi plugin, sent two docs files / 44,870 bytes /
  218 lines at `--max-steps-per-turn 128`, and failed with
  `step_limit_exceeded` with no verdict. This strengthens the source-bearing
  capacity evidence but is not evidence against the PR #175 compact prompt
  branch because it used the cached plugin.
- Current PR #175 narrowed shard job `6cecf19f-2145-48d2-84b5-cd77bc09c835`
  stayed under the Kimi adapter cap, sent four files / 13,062 bytes / 309
  lines, and became `stale_active_job` after 586,979 ms with zero stdout/stderr,
  no session id, no verdict, and no findings sections. This is failed-slot
  evidence for residual Kimi runtime/job-lifecycle reliability under #177.
- `plugins/kimi/scripts/lib/kimi.mjs` parses `Max number of steps reached: N`
  as `step_limit_exceeded`.
- `tests/unit/job-record.test.mjs` asserts this failure is not a parse error and
  produces retry guidance for a higher step budget or narrower scope after
  source was sent.

Diagnosis: Kimi is showing both the shared capacity/budget gap and a residual
adapter runtime reliability gap. The provider has a step budget capability,
lower practical source-packet capacity, unreliable session source retention, and
can still fail under the 32 KiB cap with stale/empty output. Shared policy now
preflights Kimi's adapter source capacity before source send and blocks Kimi
no-source repair; retries must use an explicitly narrowed source packet or an
explicit resend confirmation. Under-cap execution reliability remains tracked in
#177 and must not be counted as #171 approval.

### Grok `grok_cli_login_required`

- Current live source-free checks in this environment pass: `grok models`
  reports grok.com login plus `grok-build`, and
  `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` returns
  `ready:true`, `logged_in:true`, `model_ready:true`.
- Existing local Grok job records in this repo did not contain
  `grok_cli_login_required`.
- Historical spec-140 readiness evidence records Grok CLI as
  `logged_in:false` while Grok web was ready, so the symptom has occurred in
  other execution contexts.
- `plugins/grok/scripts/grok-web-reviewer.mjs` treats `grok models` output as
  login truth and requires the phrase `logged in with grok.com`. The runtime
  path also copies a limited auth home into a temporary home before prompt
  launch.

Diagnosis: the current evidence does not prove a global Grok logout or a
distinct persistence bug. It proves Grok readiness/auth is still expressed as a
provider-specific transport branch. A separate Grok issue needs the exact failed
job environment before filing.

## Exceptions And Unknowns

1. No current evidence justifies different policy treatment. Current differences
   are either capability facts or unproven policy drift.
2. DeepSeek/GLM API-first behavior can be efficient only if represented as the
   same shared route Interface with `subscription_not_supported` and a later
   OpenRouter step.
3. Kimi subscription-only behavior is not acceptable as policy parity unless
   direct API/OpenRouter absence is proven as a capability fact and tested.
4. Grok web/CLI transport mechanics are Adapter facts. Grok fallback policy must
   still use the shared route/fallback/audit contract.
5. Grok's no silent paid xAI fallback rule is a valid safety/billing constraint,
   but it must be recorded by the same shared route policy as a route that is
   unavailable or disallowed without explicit approval.
6. Packet budget work belongs under #171 shared policy. #172/#173 remain
   symptom/evidence issues unless final triage proves separate scope.
7. Grok repeated login and Kimi step limit need investigation before separate
   GitHub issues are created.

## Current #171 Fit

#171 remains the correct umbrella issue. #170 should not absorb it. The correct
MVP is not Grok auto transport; it is one shared policy Interface and evidence
that every provider Adapter consumes it.

## Next Evidence Needed

- Route matrix source evidence for all six providers and all three route steps.
- OpenRouter runtime/config evidence.
- Packet budget/resend behavior for all six providers and all modes.
- Exact failed Grok job environment for any new `grok_cli_login_required`
  occurrence.
- Kimi route capability facts for direct API/OpenRouter, if any.
- Six-reviewer approval of revised root problems/spec/plan/tasks.
