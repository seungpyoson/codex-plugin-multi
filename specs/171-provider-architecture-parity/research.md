# Research: Provider Architecture Parity Audit

## Decision: #171 Is The Umbrella

#171 remains the primary scope because it explicitly asks for provider
architecture parity across Claude, Gemini, Kimi, Grok, DeepSeek, and GLM. #170
is topology evidence input only.

Rationale: the observed symptoms are provider-facing policy drift: route
fallback, auth/readiness, source packet handling, status, failure taxonomy, and
review-quality semantics.

Alternatives considered:

- Use #170 as target: rejected because current evidence is provider-facing, not
  repo-wide topology proof.
- Split Claude, Kimi, Grok, DeepSeek, and GLM immediately: rejected because
  provider-specific issues before shared policy analysis create patch churn.

## Decision: Exact Policy Parity Is Required

Every provider must use the same policy Interface. Differences are allowed only
as Adapter capability facts with evidence and tests.

Rationale: separate treatment is the likely source of the current failure
pattern. Kimi failing after source send, DeepSeek/GLM being API-only, and Grok
login/fallback oddities should not become one-off patches.

Alternatives considered:

- Keep DeepSeek/GLM as separate direct API reviewers: rejected as a policy model.
  Direct API can remain their current Adapter capability, but route selection
  must still go through the same ladder.
- Keep Kimi subscription-only because current code says so: rejected unless
  evidence proves no direct API/OpenRouter capability is possible or intended.

## Decision: Route Ladder Is Subscription -> Direct API -> OpenRouter

The shared route policy must evaluate the same three route steps for every
provider. Unsupported steps are recorded and skipped, not implemented as fake
launches.

Rationale: this satisfies the operator requirement while staying efficient.
DeepSeek/GLM do not need fake subscription subprocesses. They need a shared
route decision showing subscription unsupported, direct API evaluated, and
OpenRouter evaluated if configured.

Alternatives considered:

- Literal subscription launch for API-only providers: rejected as wasteful and
  misleading.
- Two-step subscription/API policy: rejected because OpenRouter is already part
  of the expected route/fallback contract but is not consistently modeled.

## Decision: Packet Budget Work Belongs Under #171

#172 and #173 are evidence, but #171 must own the shared source packet policy
Interface. Claude usage burn, Kimi `step_limit_exceeded`, Gemini source-sent
failure, and DeepSeek/Grok preflight rejection are all manifestations of
inconsistent packet policy.

Alternatives considered:

- Treat #173 as Claude-only: rejected after operator correction.
- Treat #172 as separate from #171: rejected for policy design. #172 may remain
  a bug/evidence issue, but #171 owns architecture parity.

## Decision: Prior #175 Reviews Are Stale

The prior plan/final reviews approved a narrower packet: parity table, guard
tests, and Grok auto fallback. That does not prove exact shared policy parity.

Rationale: review approval is tied to reviewed scope. The operator clarified a
broader/harder requirement after those reviews.

Alternatives considered:

- Reuse previous approvals: rejected because they reviewed the wrong problem.
- Continue patching current implementation: rejected until revised
  root-problem/spec/plan/tasks packet gets all six approvals.
