# Root Problems: Provider Architecture Parity

Date: 2026-05-24
Branch: `goal/provider-architecture-parity-171`
Primary issue: #171

## Current Verdict

#171 is not solved by the current PR shape.

The root problem is not Claude usage, Kimi step limits, Grok login, or
DeepSeek/GLM being API-backed. Those are symptoms of one deeper architecture
failure:

> Provider policy is not one shared Interface with provider Adapters exposing
> only capability facts and launch mechanics.

Same policy parity means every supported provider goes through the same policy
Module and returns the same fields, failure classes, approval semantics, source
transmission truth, and operator next action. Provider-specific differences are
allowed only when there is a clear evidence-backed reason, and only behind an
Adapter/capability boundary.

## Clear Reason Standard

Different treatment is acceptable only when all of these are true:

1. The provider Adapter exposes the difference as a capability fact.
2. The shared policy Interface consumes that fact and returns the same field
   names and field meanings as every other provider.
3. The reason is documented and tested.
4. The difference does not create a provider-specific approval, billing,
   source-send, retry, or status policy branch.

Examples of acceptable differences:

- DeepSeek/GLM currently have no subscription Adapter. That can record
  `subscription_not_supported`, but it cannot skip the shared route ledger.
- Grok must not silently fall back to paid xAI API billing. That is a real
  billing/safety constraint, but it still belongs in the shared route/fallback
  policy as an unavailable or disallowed route reason.
- Kimi may have a provider-specific step budget. That is a capacity fact for
  packet policy, not a reason to bypass shared pre-send budget and retry rules.

## Required Shared Policy Ladder

Every provider must use the same route ladder:

1. Subscription capability/probe.
2. Direct API capability/probe.
3. OpenRouter capability/probe.

Unsupported is not a provider-specific policy. Unsupported is a capability
result from the same Interface.

Examples:

- DeepSeek/GLM: if no subscription Adapter exists today, the shared Interface
  records `subscription_not_supported`, then evaluates direct API, then
  OpenRouter if configured.
- Kimi: if subscription fails and direct API/OpenRouter capability exists, the
  shared Interface must evaluate those next steps with the same approval and
  billing metadata. If no capability exists, that absence must be explicit and
  tested.
- Grok: CLI, web tunnel, direct API, and OpenRouter decisions must be expressed
  through the same route/fallback/audit contract. No silent paid xAI fallback.
- Claude/Gemini: subscription-first remains normal, but direct API/OpenRouter
  fallback semantics must match the same ladder and approval tuple.

Do not run fake subscription commands for providers that have no subscription
Adapter. The efficient architecture is capability-driven: ask the Adapter for
facts, record the unsupported step, then move to the next route.

## Root Problems

### RP1: Route Ladder Is Shallow, Not Shared End-To-End

Evidence:

- `scripts/lib/provider-route-policy.mjs` supports only `subscription` and
  `api`, not an ordered `subscription -> direct_api -> openrouter` ladder.
- `scripts/lib/provider-route-policy.mjs` rejects every route except
  `subscription` and `api`; there is no `openrouter` route mode, no attempted
  route list, and no first-class skipped-route reason.
- `plugins/api-reviewers/scripts/api-reviewer.mjs` passes
  `requestedRoute: "subscription"` with only API capabilities for DeepSeek/GLM.
  That records `subscription_not_supported`, but does not prove a real shared
  route ladder or OpenRouter fallback.
- `plugins/kimi/scripts/kimi-companion.mjs` declares subscription capability
  only and rejects `--auth-mode`, while API-looking env names are reported as
  ignored.
- README says Kimi is subscription-only and DeepSeek/GLM are separate direct API
  reviewers.

Required fix:

- Create one route policy Interface for all six providers.
- Route order must be subscription, direct API, OpenRouter.
- Every route decision must record attempted route, selected route, skipped
  reason, fallback reason, auth path, billing path, approval state, source-send
  state, and suggested action.
- Tests must cover every provider against the same route-state matrix.

### RP2: Packet Budget / Resend Policy Is Not Shared Across All Six

Evidence:

- #172 shows large custom-review packets fail differently across providers:
  DeepSeek/Grok reject before send, Gemini/Kimi fail after source send, and Kimi
  returns `step_limit_exceeded`.
- Local Kimi artifacts from `/private/tmp/cpm-171-plan-review/kimi-result.json`
  and `/private/tmp/cpm-171-final-review/kimi-final2.json` show
  `custom-review`, `scope_base:null`, `source_content_transmission:"sent"`, and
  `step_limit_exceeded` at 96/120 steps.
- #173 was opened from Claude evidence, but the root problem is provider-neutral:
  source-bearing review packets need one budget/resend policy for all six.
- Current #175 text treats packet budgeting as follow-up/split work, which does
  not satisfy #171 if policy parity is the goal.

Required fix:

- One source packet policy Interface for all modes and all providers:
  `review`, `adversarial-review`, `custom-review`, and `rescue`.
- Same pre-send budget decision fields for all six.
- Same retry/resend rules: no automatic resend after source-bearing failure; no
  silent full-source to diff downgrade; any changed review surface must be
  recorded.
- Provider limits are Adapter capability facts, not separate policy.

### RP3: Grok Login Failure Is A Shared Readiness/Auth-State Problem

Evidence:

- Grok `grok_cli_login_required` blocks reviews even when the operator expects
  a recoverable route.
- Current live source-free checks in this environment show the global Grok CLI
  is not logged out: `grok models` reports a grok.com login and `grok-build`,
  and `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` reports
  `ready:true`, `logged_in:true`, and `model_ready:true`.
- Historical readiness notes under spec 140 show Grok CLI was previously
  `logged_in:false` while Grok web was ready. That means repeated
  `grok_cli_login_required` cannot be assumed to be a universal current logout;
  it is either execution-context-specific auth state, session expiry, stale job
  state, or a provider-specific readiness branch.
- The Grok parser treats `grok models` as the CLI login source of truth and
  requires the output phrase `logged in with grok.com`. If that probe runs in a
  different auth home or if the CLI output changes, the plugin can fail before
  source send even when another shell appears logged in.
- #159 says Grok must move toward the same provider framework shape, not just
  add `--transport auto`.
- Current PR handles a Grok-specific auto transport slice. That is acceptable
  only as a Grok Adapter capability fact because Grok has two
  subscription-backed transport candidates in this repo (`cli` and local
  `web`). It is not a separate provider policy and does not mean other
  providers should grow a fake `--transport auto` flag when they have only one
  subscription transport.

5 Whys:

1. Why can Grok report login-required while the operator expects it to work?
   Because the review path treats Grok CLI login as a provider-local readiness
   decision instead of a shared auth-state decision with comparable fallback
   semantics. Evidence: `plugins/grok/scripts/grok-web-reviewer.mjs` maps
   `grok_cli_login_required` to Grok-specific next action and diagnostics, while
   `scripts/lib/provider-route-policy.mjs` only returns route fields.
2. Why is this provider-local?
   Because Grok owns CLI/web transport mechanics and readiness layers inside its
   Adapter. Evidence: Grok doctor reports `transport:"cli"`, binary, model,
   `logged_in:true`, and `readiness_layers` from Grok-specific code. The
   provider-neutral policy layer still sees that as the `subscription` route.
3. Why can the same machine show ready now but fail in another job?
   Because the failed job may have used a different runtime auth home, copied
   auth state, binary, or session snapshot. Evidence: current live doctor passes,
   while historical spec-140 evidence recorded `logged_in:false`.
4. Why is this not a standalone Grok login issue yet?
   Because no current failed JobRecord/environment proves persistence failure.
   Evidence: local search found no current `grok_cli_login_required` JobRecord,
   and live source-free doctor passes.
5. Root cause:
   Grok login is currently diagnosable only through a Grok-specific readiness
   branch. #171 must provide shared readiness/auth-state semantics first; a
   separate Grok issue needs exact failed-job evidence.

Required fix:

- Investigate any future `grok_cli_login_required` against the exact job
  environment: `GROK_CLI_AUTH_HOME`, `GROK_HOME`, selected binary, `grok models`
  output, runtime-home copy behavior, token/session expiry, binary trust, and
  transport request.
- Express the outcome through the shared readiness/auth Interface.
- Create a dedicated issue only if evidence proves a distinct Grok persistence
  bug not already covered by #171/#159.

### RP4: Kimi Step Limit Is A Shared Capacity/Budget Failure

Evidence:

- #172 records Kimi `step_limit_exceeded` after source was sent.
- Kimi companion parses the CLI sentinel `Max number of steps reached: N` into
  `step_limit_exceeded`, and tests intentionally classify that as an actionable
  failed review slot after source was sent.
- Kimi accepts `--max-steps-per-turn`, but current policy does not use rendered
  source size, mode, prompt hash, or provider capacity to stop an over-budget
  packet before launch.
- Kimi currently has subscription-only route behavior and ignored API env
  diagnostics, so fallback parity is not proven.

Additional current evidence:

- Kimi job `abdc226d-d5b1-4b12-b19a-f7cf9eb6cb69` sent a one-file
  `provider-parity-table.json` packet of 21,565 bytes and failed with
  `timeout` after 257,212 ms, with no stdout, stderr, or verdict.
- `scripts/lib/provider-route-policy.mjs` accepts only `subscription` and `api`
  route modes; OpenRouter is not modeled as a first-class route.
- `plugins/kimi/scripts/kimi-companion.mjs` declares only
  `ROUTE_CAPABILITIES.subscription`.
- `plugins/kimi/scripts/lib/kimi.mjs` always passes
  `--max-steps-per-turn`, parses `Max number of steps reached: N`, and records
  `step_limit_exceeded`.
- `scripts/lib/external-model-failure-core.mjs` classifies both
  `step_limit_exceeded` and wall-clock `timeout` as failed review slots.

5 Whys:

1. Why does Kimi fail the review gate?
   Because Kimi can receive selected source and then return no usable verdict:
   `step_limit_exceeded` for larger packets and `timeout` for the latest minimal
   packet. Evidence: #172 JobRecords and
   `abdc226d-d5b1-4b12-b19a-f7cf9eb6cb69`.
2. Why is source sent before this failure?
   Because the current policy records failure after launch, but does not use
   provider capacity, mode, rendered packet size, timeout budget, and route
   alternatives to make a pre-send decision. Evidence: the JobRecord has
   `source_content_transmission:"sent"` and the shared failure classifier only
   classifies after execution state exists.
3. Why is Kimi more exposed than other routes?
   Because Kimi currently advertises subscription capability only and has no
   direct API/OpenRouter route Adapter in the shared ladder. Evidence:
   `ROUTE_CAPABILITIES` contains only `subscription`.
4. Why is this not just a Kimi-only step-budget issue?
   Because #172 shows the same policy class across reviewers: some reject before
   source send, while Gemini/Kimi fail after source send. Evidence: #172
   provider outcomes.
5. Root cause:
   Shared policy lacks a provider-neutral pre-send packet/capacity/timeout
   decision and route ladder for source-bearing review. Kimi supplies the
   strongest failure evidence, but the fix belongs in #171/#172/#173 unless a
   post-policy Kimi-only transport bug remains.

Required fix:

- Treat `step_limit_exceeded` as a provider capacity fact consumed by shared
  packet budget and retry policy.
- Prevent predictable over-budget sends before source transmission where
  possible.
- Offer the same sharding/narrowing/route-ladder next actions as other
  providers.
- Create a dedicated Kimi issue only if evidence proves Kimi-specific behavior
  remains after shared policy is designed.

### RP5: Prior Review/Implementation Evidence Is Stale

Evidence:

- PR #175 says "Closes #171" and claims provider parity complete.
- Its artifacts classify DeepSeek/GLM API-only behavior as compliant and split
  Claude packet budgeting into #173.
- Operator correction changed the requirement: exact same policy treatment for
  all six, with exceptions only for clear capability reasons.

Required fix:

- Treat #175 implementation as evidence, not accepted final work.
- Revise spec/plan/tasks.
- Re-run all six external adversarial reviews on revised root-problem
  definition before implementation resumes.
