# Relay Approval False Negatives: Root Cause Analysis

This document consolidates the investigation behind PR #214 and the remaining
follow-up work. It exists because the original analysis was spread across
session transcript discussion, external reviewer outputs, PR review comments,
and follow-up issues.

## Executive Summary

The original relay false-negative class was not caused by one provider being
special, and it was not fundamentally a route-ladder bug. The main root cause
was that source-bearing relay runs could cause the calling agent to ask for
broader local execution access before sending source. That made the host
approval layer reject or block a run that should have proceeded in the normal
execution environment, or should have failed closed as `sandbox_blocked` with
`source_content_transmission: "not_sent"`.

The minimal policy is:

- Use the normal/current execution environment for source-bearing review sends.
- Do not broaden local execution access for a normal source send.
- If normal execution cannot read auth, state, temp files, workspace source, or
  network, stop before source send and report `sandbox_blocked` with
  `source_content_transmission: "not_sent"`.
- Broader local access is only for source-free setup or access repair after a
  blocked result.
- Provider routing must stay provider-agnostic and capability-driven. Provider
  differences belong in Adapter capability facts, not special route code.

PR #214 fixed the load-bearing approval guidance for the main source-send
surfaces and added tests that pin the host-neutral/fail-closed behavior.
Remaining work is tracked separately in #215 for runtime diagnostics outside
`recommended_tool_justification`.

## Terms

### False Negative

In this investigation, a false negative means relay reports or behaves as if an
external review cannot proceed even though the selected provider route is
valid and the safe next action is either:

- run in the normal execution environment, or
- fail closed before source transmission with `sandbox_blocked` and
  `source_content_transmission: "not_sent"`.

This is different from a true provider failure such as missing credentials,
quota exhaustion, CLI not installed, invalid OAuth session, source packet too
large, or a resend safety gate.

### Source-Bearing Run

A run is source-bearing when selected repository or workspace source will be
sent to an external provider or provider CLI. Source-bearing operations need
source-send approval and must record `source_content_transmission`.

Source-free setup/access repair is different. Setup may need broader local
access to provider home directories, but it must not be conflated with the
source-bearing review send itself.

### Route Ladder

The shared route model in the current code is:

```text
subscription -> direct_api -> openrouter
```

That ladder is provider-agnostic. A provider without subscription support still
enters the ladder; the subscription step records a capability-based unsupported
state and the policy continues to direct API if available. DeepSeek and GLM are
the current direct-API-only examples.

Grok local web is not a fourth shared route step in the current model. It is a
Grok subscription transport implementation detail used inside the subscription
route when `--transport auto` or `GROK_TRANSPORT=auto` is selected. That is an
Adapter capability fact, not a separate provider-policy exception.

Evidence:

- `docs/provider-parity-table.json` documents the shared
  `subscription -> direct_api -> openrouter` route ladder.
- `scripts/lib/provider-route-policy.mjs` records `route_steps`,
  `selected_route`, `subscription_not_supported`, and source-packet policy.
- `docs/provider-parity-table.json` documents Grok CLI/local-web auto as
  subscription transport behavior.

## Original Symptoms By Provider

### DeepSeek And GLM

Observed behavior:

- DeepSeek and GLM do not have subscription routes.
- They should still flow through the same route ladder:
  `subscription` unsupported by capability, then `direct_api` selected.
- They should not be treated specially, and they should not silently skip the
  ladder.

Root cause for the false-negative class:

- The direct API path emits a source-send approval packet before selected source
  is sent.
- Before PR #214, the packet did not give sufficiently explicit sandbox-first
  / fail-closed guidance at the exact decision point.
- Agents could ask for broad local execution access for a normal source send,
  causing the host approval layer to block the run.

Fix in PR #214:

- Added source-send sandbox guidance to direct API `approval-request` and
  `approval-grant` packets.
- Made the runtime packet host-aware:
  - Codex host: mention the default Codex sandbox and
    `sandbox_permissions: "require_escalated"`.
  - Non-Codex / Claude relay host: use host-neutral wording and avoid Codex
    host tokens.
- Added tests for both host branches and the fail-closed tail.

Evidence anchors:

- `plugins/api-reviewers/scripts/api-reviewer.mjs:65` contains the Codex
  packet guidance.
- `plugins/api-reviewers/scripts/api-reviewer.mjs:66` contains the host-neutral
  packet guidance.
- `plugins/api-reviewers/scripts/api-reviewer.mjs:2568` selects guidance using
  `isCodexSandbox(env)`.
- `plugins/api-reviewers/scripts/api-reviewer.mjs:3435` appends guidance to
  `approval-request`.
- `plugins/api-reviewers/scripts/api-reviewer.mjs:3529` appends guidance to
  `approval-grant`.
- `tests/smoke/api-reviewers.smoke.test.mjs` asserts non-Codex host-neutral
  packets, Codex packets, and the `sandbox_blocked` / `not_sent` tail.

### Claude

Observed behavior:

- Claude has a subscription route.
- It should use subscription when available; direct API should not be selected
  merely because another provider has direct API.
- Claude should not receive provider-specific route treatment.

Root cause for the false-negative class:

- The same source-send guidance problem applied to companion approval packets:
  static docs were not enough; the immediate `recommended_tool_justification`
  seen by the calling agent was load-bearing.

Fix in PR #214:

- Added host-neutral source-send guidance to Claude companion approval-request
  packets.
- Static docs also carry the sandbox-first/fail-closed source-send contract.

Evidence anchors:

- `plugins/claude/scripts/claude-companion.mjs:117` defines the host-neutral
  source-send guidance.
- `plugins/claude/scripts/claude-companion.mjs:1257` appends it to
  `recommended_tool_justification`.
- `tests/smoke/claude-companion.smoke.test.mjs` asserts absence of Codex host
  tokens in the packet and presence of the fail-closed tail.

Remaining issue:

- Some `sandbox_blocked` remediation diagnostics outside the approval packet
  still mention Codex-specific setup text on non-Codex hosts. That is #215.

### Gemini

Observed behavior:

- Gemini has a subscription route.
- Like Claude, it should not be forced into direct API unless policy and
  capability facts select that route.

Root cause and fix:

- Same source-send approval packet problem as Claude.
- PR #214 added host-neutral packet guidance to Gemini companion
  `approval-request`.

Evidence anchors:

- `plugins/gemini/scripts/gemini-companion.mjs:86` defines host-neutral
  guidance.
- `plugins/gemini/scripts/gemini-companion.mjs:1169` appends it to
  `recommended_tool_justification`.
- `tests/smoke/gemini-companion.smoke.test.mjs` asserts host-neutral
  fail-closed packet behavior.

Remaining issue:

- `plugins/gemini/scripts/gemini-companion.mjs:2323` still has
  `pingSandboxBlockedFields()` text that mentions Codex-specific remediation.
  That is tracked by #215.

### Kimi

Observed behavior:

- Kimi failures were a different class and should not be folded into the same
  root cause.
- Kimi has a measured smaller source-packet capacity and different step-limit
  behavior.
- A large source packet should be narrowed or decomposed before source send; the
  runtime should not auto-resend source after a failed source-sent attempt.

Root cause class:

- Kimi is primarily a source-packet capacity / continuation / decomposition
  problem, not the same direct API approval false-negative class.
- Kimi does not have the same structured source-send approval packet surface as
  Claude/Gemini in the current runtime. Its source-send safety contract is
  carried by docs and shared policy.

Policy decision:

- Relay should not silently decompose source and send multiple requests on its
  own.
- Cleaner behavior is to tell the consumer that decomposition/narrowing is
  required, and provide concrete decomposition guidance.
- Resending after a source-sent failure requires explicit resend confirmation or
  a narrowed packet.

Evidence anchors:

- `docs/provider-parity-table.json` documents Kimi source-packet capacity and
  no-source repair limits.
- `scripts/lib/provider-route-policy.mjs` emits `source_packet_too_large`,
  `resend_confirmation_required`, `send_narrowed_source_packet`, and
  `send_after_resend_confirmation` actions.
- `docs/contracts/packet-recovery.schema.json` captures packet recovery and
  resend gate fields.

### Grok

Observed behavior:

- Grok was the provider that appeared to work in a path where others failed.
- That did not prove Grok had a separate route policy or that other providers
  should mimic Grok-specific transport mechanics.

Root cause distinction:

- Grok has two subscription-backed transports: CLI and local web tunnel.
- Auto transport can fall back from CLI readiness/login/model-unavailable
  failures to local web while remaining inside the subscription route.
- This is why Grok can appear to succeed when another provider's single
  subscription transport fails.

Policy boundary:

- Grok local web fallback is allowed only as a Grok Adapter capability fact
  inside subscription routing.
- It must not become silent paid xAI API fallback.
- It must preserve source disclosure and route metadata.

Evidence anchors:

- `docs/grok-subscription-tunnel.md` documents local web transport.
- `docs/provider-parity-table.json` documents Grok CLI/web auto as a
  subscription transport capability.
- `tests/smoke/grok-web.smoke.test.mjs` covers CLI success, local web fallback,
  selected route metadata, resend confirmation, and source-packet gates.

### Grok `resend_confirmation_required`

Observed behavior:

- In one review attempt, Grok failed because the relay returned
  `resend_confirmation_required`.
- The source was not sent in that blocked attempt.

Interpretation:

- This is not the same false-negative root cause.
- It is an intentional safety gate: after a failed source-sent slot, relay must
  not automatically resend selected source without explicit confirmation or a
  narrowed source packet.

Evidence anchors:

- `scripts/lib/provider-route-policy.mjs` emits `resend_confirmation_required`
  when previous source-sent state makes an automatic resend unsafe.
- `docs/contracts/packet-recovery.schema.json` models resend confirmation
  actions.
- `tests/smoke/grok-web.smoke.test.mjs` asserts
  `resend_confirmation_required` and `send_after_resend_confirmation`.

## What PR #214 Fixed

PR #214's durable fix was to make the approval/sandbox contract explicit in all
load-bearing places:

1. Static source-bearing docs
   - `scripts/lib/external-model-contracts.mjs:305` defines
     `sandboxFirstSourceSendContract()`.
   - The contract is inserted into review, adversarial-review, custom-review,
     rescue, and delegation surfaces where source-bearing behavior exists.

2. Claude relay generated docs
   - `scripts/lib/relay-build.mjs:379` defines `renderClaudeCommandDoc()`.
   - `scripts/lib/relay-build.mjs:427` and nearby replacements convert Codex
     host wording to host-neutral Claude relay wording.
   - Generated relay docs are tested for both presence of host-neutral guidance
     and absence of `Codex`, `sandbox_permissions`, and `require_escalated`.

3. Runtime approval packets
   - Direct API runtime packets are host-aware.
   - Claude/Gemini companion packets emit host-neutral guidance.
   - Tests assert both the start of the guidance and the fail-closed tail:
     `sandbox_blocked` plus `source_content_transmission: "not_sent"`.

4. Regression tests for generated and runtime surfaces
   - `tests/unit/docs-contracts.test.mjs` covers Codex-side docs.
   - `tests/unit/relay-build-contracts.test.mjs:518` checks generated relay
     docs do not leak Codex host contracts.
   - `tests/unit/relay-build-contracts.test.mjs:537` checks source-bearing
     relay commands keep host-neutral sandbox guidance.
   - Runtime smoke tests cover API reviewers, Claude companion, and Gemini
     companion packet behavior.

## Why Static Docs Were Not Enough

The key lesson from PR #214 is that the runtime approval packet is load-bearing.
The calling agent often decides whether to broaden local execution access based
on the immediate `recommended_tool_justification`, not from a full reread of
the command documentation.

That is why the original static-doc-only direction was insufficient:

- Generated docs could be host-neutral while runtime JSON still said
  "default Codex sandbox" on a Claude relay host.
- Tests could pass by checking markdown while missing the packet actually
  rendered to the operator.
- A correct fix needed runtime packet assertions and host-branch tests.

## False-Negative Failure Matrix

| Failure case | Before/bug risk | Correct behavior | Current status |
| --- | --- | --- | --- |
| Normal source send asks for broad local access | Host approval may block a valid run | Use current/default environment; fail closed as `sandbox_blocked` / `not_sent` if blocked | Fixed by #214 for main packet/doc surfaces |
| Direct API packet says Codex-specific guidance on Claude host | Confusing/unusable Claude relay remediation | Host-aware guidance based on `isCodexSandbox(env)` | Fixed by #214 for `recommended_tool_justification` |
| Static relay docs lose the sandbox-first contract | Agent may regress to broad escalation | Generated docs must contain host-neutral contract | Fixed/tested by #214 |
| Generated relay docs leak `sandbox_permissions` / `require_escalated` | Claude relay host sees Codex-only controls | Build transform and tests ban these terms | Fixed/tested by #214 |
| Runtime packet tail changes from fail-closed to fail-open | Agent may retry with broader access after block | Tests must assert `sandbox_blocked` and `not_sent` in packet | Fixed/tested by #214 revision |
| `sandbox_blocked` diagnostics outside packet leak Codex terms | Claude relay users see `~/.codex/config.toml`, `writable_roots`, or "fresh Codex session" | Host-neutral diagnostics outside Codex; preserve Codex details inside Codex | Open: #215 |
| DeepSeek/GLM no subscription | Could be misread as route failure | Record subscription unsupported by capability, then select direct API | Existing route model; not #214 root cause |
| Kimi packet too large / step limit | Repeated source resend or poor result quality | Tell consumer to narrow/decompose; do not auto-resend without confirmation | Existing shared policy; needs better consumer guidance |
| Grok CLI unavailable but web ready | Could be misread as provider-policy exception | Auto fallback inside subscription route, with route metadata and no paid API fallback | Existing Grok transport behavior |
| `resend_confirmation_required` | Could be misread as nagging/false negative | Block automatic source resend until explicit confirmation or narrowed packet | Existing safety gate |
| Relay output lower quality than manual relay | Standard prompt may under-specify desired decomposition/review shape | Improve prompt/decomposition guidance separately from approval routing | Not fixed by #214; should be tracked separately if still observed |

## Policy Decisions From The Investigation

### Keep Routing Provider-Agnostic

Do not add "Claude special treatment" or "DeepSeek/GLM special treatment."
The policy should ask the same questions for every provider:

- Is subscription capability available?
- If subscription is unavailable or unavailable under current state, is direct
  API capability available?
- If direct API is unavailable, is OpenRouter capability available?
- If no route is available, report provider unavailable under current route
  policy with route-step diagnostics.

Provider-specific facts are allowed only as Adapter capabilities:

- DeepSeek/GLM: direct API capability, no subscription.
- Grok: subscription CLI and subscription local-web transports.
- Kimi: subscription route with smaller source-packet capacity and limited
  no-source repair support.

### Do Not Use API Merely Because Subscription Has A Recoverable Problem

For providers with subscription routes, direct API is not a generic workaround
for local sandbox, setup, or source-send approval false negatives. The normal
first response is:

- fix source-free setup/access,
- narrow/decompose source packet,
- or fail closed before source send.

Direct API may be selected only when the shared route policy and provider
capability facts say it is the selected route.

### Relay Should Not Silently Decompose Source

Automatic decomposition can change the review surface and source disclosure. It
is cleaner for relay to:

- report `source_packet_too_large` or equivalent,
- explain how to split the request,
- preserve `source_content_transmission: "not_sent"` before the split is
  approved, and
- require the consumer/operator to choose the decomposition.

### Runtime JSON Needs Tests, Not Just Markdown

Any future guidance that influences approval, routing, source disclosure, or
retry behavior must be tested at the artifact boundary actually consumed by
the calling agent:

- command docs,
- generated relay docs,
- approval-request JSON,
- approval-grant JSON,
- JobRecord diagnostics,
- route/recovery metadata.

## Remaining Follow-Up Work

### #215: Host-Neutral Runtime Diagnostics

Issue #215 tracks the remaining known host-neutrality gap outside
`recommended_tool_justification`.

Known examples:

- `plugins/api-reviewers/scripts/api-reviewer.mjs:2628`
  mentions "Codex workspace" and "fresh Codex session" for `sandbox_blocked`.
- `plugins/claude/scripts/claude-companion.mjs:2589`
  has Codex-specific `pingSandboxBlockedFields()`.
- `plugins/gemini/scripts/gemini-companion.mjs:2323`
  has Codex-specific `pingSandboxBlockedFields()`.
- `plugins/kimi/scripts/kimi-companion.mjs:1999`
  has Codex-specific `pingSandboxBlockedFields()`.
- `plugins/*/scripts/lib/job-record.mjs` diagnostics can mention "Codex
  session", "Codex sandbox", `writable_roots`, or `~/.codex/config.toml`.

The fix should use the same pattern as PR #214:

- `isCodexSandbox(env)` gates Codex-specific remediation.
- non-Codex hosts get neutral wording.
- tests cover both host branches.

### Decomposition Guidance

Kimi and other source-packet failures need clearer consumer-facing
decomposition instructions. The policy should not auto-split and send source,
but it can tell the caller:

- why the packet is too large,
- the provider's packet budget,
- whether retry without source is supported,
- whether explicit resend confirmation is required,
- how to split by files, directory, or diff range.

### Review Quality Gap Between Manual Relay And Plugin Relay

Manual relay outputs were reported as better than plugin-relay outputs. That is
not the same as approval false negatives, but it is a real product signal.

Likely causes to investigate:

- manual prompts include richer task framing and decomposition expectations,
- plugin prompts may optimize too heavily for generic review contract shape,
- reviewer outputs may need a stricter result schema or "review quality" gate,
- large source packets may need an explicit "ask consumer to decompose" response
  instead of trying to force one oversized review.

This should be tracked separately from #215 unless the same tests and files are
being edited.

### Concurrent Reviewer Slots

The investigation also surfaced that one concurrent external reviewer slot is
too tight for multi-provider review. This is orthogonal to false-negative root
cause, but it affects operator experience and should be tracked separately if
not already filed.

## How To Re-Investigate Without Repeating The Same Work

For any future provider failure:

1. Identify the route step and selected route from route metadata.
2. Identify whether source was sent:
   `source_content_transmission` must be `not_sent`, `sent`, or explicitly
   explain uncertainty.
3. If source was not sent, classify the failure:
   - source packet too large,
   - resend confirmation required,
   - sandbox blocked,
   - auth/session unavailable,
   - provider unavailable under route policy,
   - generated-doc or runtime-packet guidance gap.
4. Check the exact artifact the caller saw:
   - static command doc,
   - generated relay command doc,
   - approval packet,
   - JobRecord,
   - failure diagnostic.
5. Decide whether the failure is:
   - true provider unavailability,
   - expected safety gate,
   - source-packet/decomposition requirement,
   - host-neutrality bug,
   - approval false negative.
6. Add or update a test at the artifact boundary that failed.

## Evidence Dossier

This section is intentionally more literal than the RCA sections above. It
records the hard evidence used to derive the conclusions, including verbatim
transcript excerpts, PR text, code excerpts, test assertions, and confidence per
claim.

### Evidence Sources

| ID | Source | What It Proves | Verification Method |
| --- | --- | --- | --- |
| S1 | `/Users/spson/.codex/sessions/2026/06/06/rollout-2026-06-06T02-22-22-019e98ce-ade3-79e3-8586-919135671a46.jsonl` | Original session symptom: provider split, policy denial class, source not sent for blocked providers | `jq` extraction of user/assistant messages matching relay/policy terms |
| S2 | PR #214 body | Intended fix, validation commands, mutation check, final merged head | GitHub PR fetch for `seungpyoson/relay#214` |
| S3 | PR #214 diff/current `main` | Actual code-level fix in direct API and companion approval packets | `sed` / `rg` on current files at `main` |
| S4 | PR #214 tests/current `main` | Regression coverage for host-neutrality and fail-closed tails | `sed` / `rg` on tests |
| S5 | `docs/provider-parity-table.json` and `scripts/lib/provider-route-policy.mjs` | Route ladder and provider capability facts | targeted file reads |
| S6 | Issue #215 | Remaining non-packet runtime diagnostic leak | GitHub issue fetch |
| S7 | Issue #144 and `origin/goal/provider-reliability-144-api-rescue` | Separate API-backed rescue work; not the same RCA | GitHub issue fetch and branch inspection |

### Verbatim Transcript Evidence: Original Session Failure

The original session transcript records that the observed failure was not a
relay runtime crash. It was an approval-policy rejection before source-bearing
commands launched.

Verbatim excerpt from S1:

```text
It is not Relay failing. It is this Codex session's escalation reviewer.

What happened:
- I asked the tool runner to launch Claude/GLM/DeepSeek with the approved A6 packet.
- The command was intercepted before Relay could run.
- The rejection came from `approvals_reviewer=auto_review`, with wording like "tenant policy forbids private repo source exfiltration even with explicit user approval."
- Gemini and Grok were allowed, so the Relay plugin itself is functional in this session.
```

Same transcript, observed provider split:

```text
Observed behavior:
- Gemini Relay: launched, source sent, completed `APPROVE`
- Grok Relay: launched, source sent, completed `APPROVE`
- Kimi Relay: skipped by user after pre-send packet-budget failure
- Claude Relay: rejected before launch/source send
- GLM Relay direct API: rejected before launch/source send
- DeepSeek direct API: first blocked by active provider lock; after lock cleared, rejected before launch/source send
```

Same transcript, exact policy wording class:

```text
Policy rejection wording class:
- "tenant policy forbids private repo source exfiltration even with explicit user approval"
- "untrusted external Relay/Claude service"
- "external direct-API review service"
- "The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention"
```

Same transcript, local policy facts:

```text
Session policy:
- `sandbox_mode=workspace-write`
- `approvals_reviewer=auto_review`
- Source-bearing external review commands require `sandbox_permissions=require_escalated`
```

Same transcript, initial conclusion:

```text
Likely root cause:
This is not a Relay plugin failure. It is a session-specific `auto_review` approval-policy denial for certain source-bearing provider routes. The allowed/blocked split suggests provider/route classification differs:
- Allowed: Gemini subscription route, Grok subscription CLI route
- Blocked: Claude Relay route, GLM direct API, DeepSeek direct API
```

Confidence: HIGH for the original session boundary. The transcript explicitly
states source was sent for Gemini/Grok and not sent for Claude/GLM/DeepSeek,
and it records the policy-review wording class.

Important distinction: S1 proves the original session was blocked by the
managed approval reviewer. It does not by itself prove the repository-level fix
in PR #214. PR #214 addressed the adjacent relay-plugin false-negative class:
agents requesting broad escalation for normal source sends because the load-
bearing approval guidance was missing, incomplete, or host-specific.

### Verbatim PR Evidence: What PR #214 Claimed To Fix

PR #214 body, summary excerpt:

```text
- Add sandbox-first source-send guidance to Relay review docs across companion, Grok, direct API, generated custom-review, and source-bearing rescue entry points.
- Gate direct API approval-request/session-grant runtime wording by host: Codex keeps Codex-specific sandbox guidance; non-Codex/Claude-host execution receives host-neutral guidance.
- Add the same immediate host-neutral guidance to Claude and Gemini companion approval-request packets.
- Strengthen tests so generated relay command docs must keep host-neutral guidance and must not leak `Codex`, `sandbox_permissions`, or `require_escalated` in source-bearing command docs.
- Pin the runtime fail-closed tail (`sandbox_blocked` + `source_content_transmission: "not_sent"`) in approval packet smoke tests.
```

PR #214 body, why excerpt:

```text
Codex approval false negatives were triggered when normal source-bearing review launches requested broad escalation. Relay now instructs consumers to use the default/current execution environment for normal source sends and to fail closed as `sandbox_blocked` / `source_content_transmission: "not_sent"` when default access is insufficient. The follow-up commits also close reviewed host-neutrality and fail-closed test-robustness gaps where runtime approval packets could contradict the generated relay docs or silently drift toward fail-open guidance.
```

PR #214 body, validation excerpt:

```text
- `npm test` at c660de1 before the final test-only/doc-format follow-up (2504 pass, 12 skipped, 0 fail)
- Mutation check: temporarily replaced runtime guidance tails with fail-open wording; the new approval packet assertions failed on all direct API, Claude companion, and Gemini companion focused tests.
- `npm run lint`
- `node --test tests/unit/docs-contracts.test.mjs`
- `node --test tests/unit/relay-build-contracts.test.mjs`
- `node --test --test-name-pattern "direct API reviewers approval-request describes external source transmission without sending source|direct API reviewers approval-request emits Codex sandbox guidance inside Codex|direct API reviewers approval-grant request emits source-free bounded grant proof" tests/smoke/api-reviewers.smoke.test.mjs`
- `node --test --test-name-pattern "approval-request: explicit api_key source-bearing review token unlocks matching Claude run" tests/smoke/claude-companion.smoke.test.mjs`
- `node --test --test-name-pattern "gemini approval-request explicit api_key source-bearing review token unlocks matching run" tests/smoke/gemini-companion.smoke.test.mjs`
```

Gemini Code Assist review on PR #214, verbatim excerpt:

```text
This pull request introduces a new sandbox-first source-send execution contract across multiple plugins (including Claude, Gemini, Grok, Kimi, DeepSeek, and GLM). It defines standard guidance requiring the use of the default Codex sandbox (or Claude Code execution environment for relay commands) for normal source-bearing runs, explicitly forbidding escalated permissions unless repairing access after a block, and failing closed with a `sandbox_blocked` status if the default environment is insufficient. These rules are integrated into the API reviewer scripts, markdown documentation templates, build scripts, and validated with new unit and smoke tests.
```

PR metadata:

```text
PR: https://github.com/seungpyoson/relay/pull/214
Title: [codex] Reduce relay approval false negatives
Base SHA: 72c6b2faccd20c6e4d32e6d5c5946da3bc1b2b90
Head SHA: 49ad1af3ab2bd528c6080554e1aedf09dd79f027
Merge commit: 0d71b2980567cc7e163894630e63a7579d86b7a0
Merged: true
```

Confidence: HIGH that PR #214's intended fix was the sandbox-first,
fail-closed approval guidance, because the PR body, merged diff, and review
comment say the same thing.

### Verbatim Code Evidence: Runtime Packet Fix

Current `plugins/api-reviewers/scripts/api-reviewer.mjs` defines two explicit
runtime guidance strings:

```js
const CODEX_SOURCE_SEND_SANDBOX_GUIDANCE = "Use the default Codex sandbox for the matching source-bearing run. Do not request `sandbox_permissions: \"require_escalated\"` for a normal source send; if the default sandbox blocks provider auth, job state, temp files, or network, stop and report `sandbox_blocked` with `source_content_transmission: \"not_sent\"`.";
const HOST_NEUTRAL_SOURCE_SEND_SANDBOX_GUIDANCE = "Use the current execution environment for the matching source-bearing run. Do not broaden local execution access for a normal source send; if local execution blocks provider auth, job state, temp files, or network, stop and report `sandbox_blocked` with `source_content_transmission: \"not_sent\"`.";
```

Current host-gating function:

```js
function sourceSendSandboxGuidance(env = process.env) {
  return isCodexSandbox(env)
    ? CODEX_SOURCE_SEND_SANDBOX_GUIDANCE
    : HOST_NEUTRAL_SOURCE_SEND_SANDBOX_GUIDANCE;
}
```

Current `approval-request` packet construction appends that guidance to
`recommended_tool_justification` while keeping source unsent:

```js
source_content_transmission: SOURCE_CONTENT_TRANSMISSION.NOT_SENT,
disclosure,
approval_question: approvalQuestion,
recommended_tool_justification: `${disclosure} ${approvalQuestion} If approved, pass approval_token.value with --approval-token before running the external API command. ${sourceSendSandboxGuidance()}`,
approval_token: approvalToken,
```

Confidence: HIGH that direct API approval packets now carry host-aware
sandbox-first/fail-closed guidance at the decision point.

### Verbatim Test Evidence: Non-Codex Direct API Packet

Current `tests/smoke/api-reviewers.smoke.test.mjs` asserts that a non-Codex
direct API approval packet is host-neutral and fail-closed:

```js
assert.match(request.recommended_tool_justification, /Selected source content has not been sent to GLM/);
assert.match(request.recommended_tool_justification, /current execution environment/);
assert.match(request.recommended_tool_justification, /Do not broaden local execution access for a normal source send/);
assert.match(request.recommended_tool_justification, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/);
assert.doesNotMatch(request.recommended_tool_justification, /retry with broader access|broader access until|until the source send succeeds/i);
assert.doesNotMatch(request.recommended_tool_justification, /\bCodex\b|sandbox_permissions|require_escalated/);
```

Confidence: HIGH that the non-Codex direct API runtime packet is tested for:

- source not sent,
- host-neutral wording,
- fail-closed tail,
- absence of Codex-only host tokens,
- absence of fail-open retry wording.

### Verbatim Test Evidence: Codex Direct API Packet

Current `tests/smoke/api-reviewers.smoke.test.mjs` separately asserts that
inside Codex the direct API approval packet still contains Codex-specific
guidance:

```js
assert.match(request.recommended_tool_justification, /default Codex sandbox/);
assert.match(request.recommended_tool_justification, /Do not request `sandbox_permissions: "require_escalated"` for a normal source send/);
assert.match(request.recommended_tool_justification, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/);
assert.doesNotMatch(request.recommended_tool_justification, /retry with broader access|broader access until|until the source send succeeds/i);
```

Confidence: HIGH that PR #214 did not simply erase Codex-specific remediation;
it gates it by host context.

### Verbatim Test Evidence: Generated Relay Docs

Current `tests/unit/relay-build-contracts.test.mjs` asserts generated Claude
relay command docs contain host-neutral guidance and ban Codex-only terms:

```js
test("buildRelaySuite: source-bearing relay commands keep host-neutral sandbox guidance", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "relay-source-guidance-"));
  const outRoot = path.join(tmpRoot, "relay");
  const sourceBearingCommands = new Set(["review.md", "adversarial-review.md", "custom-review.md", "rescue.md"]);
  try {
    for (const pluginRoot of buildRelaySuite({ repoRoot: process.cwd(), outRoot })) {
      for (const fileName of readdirSync(path.join(pluginRoot, "commands"))) {
        if (!sourceBearingCommands.has(fileName)) continue;
        const commandDoc = readFileSync(path.join(pluginRoot, "commands", fileName), "utf8");
        const label = `${path.basename(pluginRoot)}/commands/${fileName}`;
        assert.match(commandDoc, /current Claude Code execution environment/, label);
        assert.match(commandDoc, /Do not broaden local execution access for a normal source send/, label);
        assert.match(commandDoc, /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/, label);
        assert.doesNotMatch(commandDoc, /\bCodex\b|sandbox_permissions|require_escalated/, label);
```

Confidence: HIGH that generated relay command docs are regression-tested for
host-neutrality and fail-closed guidance.

### Verbatim Route Evidence: Shared Ladder And Provider Capabilities

Current `scripts/lib/provider-route-policy.mjs` includes
`subscription_not_supported` in the route/failure vocabulary and exposes shared
route steps:

```js
"subscription_not_supported",
```

```js
export function buildProviderPolicyContract() {
  return {
    providers: [...PROVIDER_POLICY_PROVIDERS],
    route_steps: [...PROVIDER_ROUTE_STEPS],
```

Current `docs/provider-parity-table.json` records DeepSeek as direct-API-only
while still using the shared ladder:

```json
"current_behavior": "DeepSeek uses the API reviewer path with direct API capability only. Shared route_steps records subscription_not_supported, direct_api selected, and openrouter unsupported/not_needed state.",
"capability_fact": "The current DeepSeek Adapter implements direct API auth and does not implement subscription CLI or OpenRouter routes.",
"shared_policy_boundary": "DeepSeek selects direct_api today through the same shared subscription -> direct_api -> openrouter route_steps ledger that explains subscription_not_supported and OpenRouter skip/fallback state.",
"clear_reason": "This is not fake parity: DeepSeek should not pretend to have a subscription CLI, but it must still enter the same shared route ladder and fall through by capability facts.",
```

Current `docs/provider-parity-table.json` records the same boundary for GLM:

```json
"current_behavior": "GLM uses the API reviewer path with direct API capability only. Shared route_steps records subscription_not_supported, direct_api selected, and openrouter unsupported/not_needed state.",
"capability_fact": "The current GLM Adapter implements direct API auth and does not implement subscription CLI or OpenRouter routes.",
"shared_policy_boundary": "GLM selects direct_api today through the same shared subscription -> direct_api -> openrouter route_steps ledger that explains subscription_not_supported and OpenRouter skip/fallback state.",
```

Confidence: HIGH that DeepSeek/GLM should not be specially treated; they use
the same route ladder with different Adapter capability facts.

### Verbatim Grok Evidence: Local Web Is Subscription Transport

Current `docs/provider-parity-table.json` records Grok auto transport as a
Grok-specific subscription transport fact:

```json
"current_behavior": "Grok has CLI/web subscription transports and local web fallback mechanics. The user-facing --transport auto flag is Grok-only because no other current provider Adapter has two subscription-backed transports to arbitrate between.",
"capability_fact": "Grok is the only current Adapter with two subscription-backed transports: CLI and local web tunnel.",
"shared_policy_boundary": "Shared policy records route_step=subscription, route_steps, selected_route, fallback_reason, auth_path, source_content_transmission, and runtime diagnostics; Grok transport auto only chooses between subscription transports and never changes the shared provider route ladder.",
"clear_reason": "This is an Adapter capability fact, not a provider-policy exception: shared route policy still treats Grok CLI and local web as subscription-route candidates, records route/fallback/source metadata, and forbids silent paid xAI API fallback. Providers with one subscription transport do not need a fake --transport auto flag; DeepSeek/GLM without subscription still enter the same subscription -> direct API -> OpenRouter ladder through capability facts.",
```

Confidence: HIGH that "local web" is not represented as a fourth shared route
step in the current policy model.

### Verbatim Resend Gate Evidence

Current `scripts/lib/provider-route-policy.mjs` blocks automatic source resend
after source-sent failures unless the operator confirms or narrows the packet:

```js
if (
  previousSourceWasSent(previousAttempt)
  && previousFailureRequiresResendGate(previousAttempt)
  && !resendConfirmationApproved
  && !narrowedSourcePacket
) {
  const action = "resend_confirmation_required";
  return Object.freeze({
    ...base,
    source_send_allowed: false,
    source_packet_action: action,
    source_content_transmission: "not_sent",
    resend_confirmation_required: true,
    source_packet_policy_error_code: action,
    suggested_action: sourcePacketSuggestedAction(action, provider),
```

Confidence: HIGH that `resend_confirmation_required` is an intentional safety
gate, not a relay false-negative bug by itself.

### Verbatim Kimi Evidence

Current `docs/provider-parity-table.json` records Kimi's packet-capacity
behavior as an Adapter capability fact:

```json
"current_behavior": "Kimi subscription review declares a 32768-byte source-packet capacity and disables no-source repair after source-bearing step-limit failures. The shared policy still evaluates the same source_packet fields for every provider; Kimi's route capability makes over-capacity packets fail before launch with source_content_transmission:not_sent, and Kimi step-limit continuations fail before relaunch unless the retry sends an explicitly narrowed packet or has explicit resend confirmation.",
"capability_fact": "Kimi Code CLI 1.43 did not produce a verdict for a compact 63197-byte source-bearing review at --max-steps-per-turn 128, and a raw no-tool continuation of that session returned NOT_REVIEWED because prior selected source was not retained in the current context. Kimi therefore cannot currently prove reliable same-session no-source source retention for review approvals.",
"shared_policy_boundary": "Kimi capacity is represented only as Adapter capability data consumed by the shared source-packet policy. The policy shape, resend gate, narrow-packet path, source_content_transmission audit fields, and pre-send enforcement remain shared across Claude, Gemini, Kimi, Grok, DeepSeek, and GLM.",
```

Confidence: HIGH that Kimi's known failure class is source-packet capacity and
no-source repair reliability, not the same direct API approval-packet false
negative.

### Verbatim Remaining-Gap Evidence: Issue #215

Issue #215 records the remaining non-packet runtime diagnostic leak:

```text
Some runtime diagnostics outside `recommended_tool_justification` still emit Codex-specific remediation text on Claude relay hosts.
```

Confirmed examples from #215:

```text
- `plugins/api-reviewers/scripts/api-reviewer.mjs:2628`
  - `sandbox_blocked` suggested action mentions "Codex workspace" and "fresh Codex session".
  - Affects relay DeepSeek/GLM because they use the shared API reviewer runtime.
- `plugins/gemini/scripts/gemini-companion.mjs:2323`
  - `pingSandboxBlockedFields()` mentions "Codex sandbox" and `~/.codex/config.toml`.
  - Copied into `relay/relay-gemini`.
- `plugins/kimi/scripts/kimi-companion.mjs:1999`
  - Same class for Kimi.
  - Copied into `relay/relay-kimi`.
- `plugins/*/scripts/lib/job-record.mjs`
  - `sandbox_blocked` / `not_authed` diagnostics mention "Codex session", "Codex sandbox", `writable_roots`, or `~/.codex/config.toml`.
```

Confidence: HIGH that #215 is a real remaining host-neutrality gap. It is
outside PR #214's `recommended_tool_justification` fix.

### Claim Confidence Table

| Claim | Evidence | Confidence | Notes |
| --- | --- | --- | --- |
| Original session failed before Relay launched for Claude/GLM/DeepSeek | S1 transcript says commands were intercepted before Relay could run and source was not sent | HIGH | This is session-policy behavior, not a repo-code proof |
| Gemini and Grok worked in that session | S1 transcript says both launched, source sent, completed `APPROVE` | HIGH | Proves Relay was functional for allowed routes |
| Kimi failure should be separated | S1 says Kimi skipped after pre-send packet-budget failure; S5 documents Kimi capacity facts | HIGH | Separate source-packet class |
| PR #214 fixed approval false-negative guidance | S2 PR body, S3 code, S4 tests | HIGH | Directly merged and tested |
| Direct API packet is host-aware | S3 code `sourceSendSandboxGuidance(env)` | HIGH | Tests cover Codex and non-Codex |
| Generated relay docs are host-neutral | S4 `buildRelaySuite` test | HIGH | Tests execute generated output |
| DeepSeek/GLM should not receive special route treatment | S5 route/parity docs | HIGH | Capability facts drive route |
| Grok local web is not a fourth shared route | S5 parity docs | HIGH | It is documented as subscription transport capability |
| `resend_confirmation_required` is an expected safety gate | S5 route-policy code | HIGH | Code blocks automatic resend |
| #215 remains open and necessary | S6 issue body | HIGH | Confirmed examples are listed |
| Manual relay output quality is lower/higher than plugin relay | User report in conversation, not reproduced locally | MEDIUM | Needs a separate controlled prompt/output comparison |
| Concurrent reviewer slots are too tight | User report in conversation, not checked in current repo state | MEDIUM | Needs issue/test/queue-policy evidence |

### What The Evidence Does Not Prove

- It does not prove every external provider failure is a relay false negative.
- It does not prove Kimi should get the same runtime packet surface as
  Claude/Gemini.
- It does not prove Grok local web should be generalized into a fourth route.
- It does not prove PR #214 fixed all host-neutrality text. #215 explicitly
  records remaining diagnostics outside the packet.
- It does not prove manual relay and plugin relay output quality are equivalent.
  That requires a separate comparison using the same source packet and prompt.

## Related Work

- PR #214: Reduce relay approval false negatives.
- Issue #215: Host-neutralize sandbox_blocked and auth remediation diagnostics
  in relay runtimes.
- Issue #144: API-backed rescue workflow for direct API reviewers. This is
  separate from the approval false-negative root cause.
- `docs/provider-parity-table.json`: provider-agnostic route/capability model.
- `docs/contracts/packet-recovery.schema.json`: source-packet and resend
  recovery schema.
- `docs/grok-subscription-tunnel.md`: Grok local web tunnel as subscription
  transport.
