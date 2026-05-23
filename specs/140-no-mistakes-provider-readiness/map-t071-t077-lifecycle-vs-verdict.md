# T071 / T077 Lifecycle-vs-Verdict Map

**Lane**: T071 (visual lifecycle gaps from wrapper buffering) + T077 (lifecycle-vs-verdict proof)
**Feature**: 140-no-mistakes-provider-readiness
**Mode**: Current-state design map and correction record — implementation evidence now lives in `tasks.md`
**Symptom rows in scope**: S14 (visual status appeared infrequently), S19 (lifecycle `completed` mistaken for verdict), S23 (Claude prose APPROVE but plugin audit failed)

Citations are historical lane anchors unless refreshed below. Treat the current repo worktree and `specs/140-no-mistakes-provider-readiness/tasks.md` as authoritative for shipped implementation and verification state.

---

## 0. Current status

This map's important correction is still valid: characterization tests that pass today are guardrails only, and the first true T077 RED slice is the review-panel state split (`completed_approved` vs `completed_request_changes`) unless the coordinator explicitly chooses a higher-churn `external_review_completed` lifecycle schema. Current worktree proof exists: `tests/unit/review-panel.test.mjs` contains `review panel splits completed audit state by review verdict`, and focused `node --test --test-name-pattern "review panel splits completed audit state by review verdict" tests/unit/review-panel.test.mjs` passes.

The implementation details in older sections were captured before later Grok CLI work. Do not reuse the older "no separate Grok CLI binary path" statement as current fact. Current Grok runtime supports subscription CLI as default and explicit web transport as legacy fallback; T070/T085/T090 in `tasks.md` carry the current transport evidence.

---

## 0a. Scope clarification

The task description names "Kimi, Grok (CLI + web)". Repo reality:

- Current Grok still has one wrapper entrypoint, `plugins/grok/scripts/grok-web-reviewer.mjs`.
- That wrapper now supports two explicit transports: subscription CLI (`transport:"cli"`, current default) and subscription web/tunnel (`transport:"web"`, explicit legacy fallback).
- For current work, "Grok (CLI + web)" means two transport seams inside one wrapper, not two unrelated providers.

DeepSeek and GLM share `plugins/api-reviewers/scripts/api-reviewer.mjs` and are differentiated only by `provider` flag and `cfg.display_name`. They are listed as separate rows in every table.

---

## 1. Provider-by-provider lifecycle event inventory

Lifecycle events are emitted to the wrapper's **own** `process.stdout` (not to the spawned target's stdout). For foreground runs the wrapper IS the host's child; the host (Claude / Codex) consumes the wrapper's stdout. The stream is JSONL when `--lifecycle-events jsonl`, or a mix of markdown cards + JSONL fallback when `--lifecycle-events markdown` (see §1.6 footnote).

| Provider | Event | File:line | Mode | When emitted |
| --- | --- | --- | --- | --- |
| Claude | `external_review_launched` (helper) | `plugins/claude/scripts/lib/companion-common.mjs:74-82` | jsonl/markdown | Emitted by foreground run at `plugins/claude/scripts/claude-companion.mjs:896-901`, before `spawnClaude` |
| Claude | `external_review_progress` (helper) | `plugins/claude/scripts/lib/companion-common.mjs:84-95` | jsonl/markdown | Emitted by heartbeat `setInterval` (default 30000 ms) at `plugins/claude/scripts/lib/companion-common.mjs:128-150`; started at `plugins/claude/scripts/claude-companion.mjs:903`, cancelled in `finally` at `:915` |
| Claude | `launched` (background variant) | `plugins/claude/scripts/lib/companion-common.mjs:97-109` | jsonl/markdown | Emitted by background-launch path at `plugins/claude/scripts/claude-companion.mjs:831-836` after `spawnDetachedWorker` succeeds, then `process.exit(0)` at `:837` |
| Claude | terminal JobRecord (no `event` key) | n/a — full record printed verbatim | jsonl/markdown | `printLifecycleJson(finalRecord, lifecycleEvents)` at `plugins/claude/scripts/claude-companion.mjs:885`, `:937`, `:991`, `:1052`, `:1140`; always **after** `process.exit` is imminent (i.e., after child closed) |
| Claude | `preflight` (not part of run lifecycle) | `plugins/claude/scripts/claude-companion.mjs:640`, `:665`, `:684` | always JSON | Separate `preflight` subcommand only; not seen during `run` |
| Gemini | `external_review_launched` | `plugins/gemini/scripts/lib/companion-common.mjs:74-82` | jsonl/markdown | Emitted at `plugins/gemini/scripts/gemini-companion.mjs:718-723` |
| Gemini | `external_review_progress` | `plugins/gemini/scripts/lib/companion-common.mjs:84-95` | jsonl/markdown | Heartbeat started at `plugins/gemini/scripts/gemini-companion.mjs:725`, cancelled in `finally` at `:738` |
| Gemini | `launched` (background) | `plugins/gemini/scripts/lib/companion-common.mjs:97-109` | jsonl/markdown | `plugins/gemini/scripts/gemini-companion.mjs:655-660`, `:1233-1238` |
| Gemini | terminal JobRecord | n/a | jsonl/markdown | `plugins/gemini/scripts/gemini-companion.mjs:713`, `:758`, `:805`, `:847`, `:864`; always **after** spawn closed |
| Gemini | `preflight` (not part of run) | `plugins/gemini/scripts/gemini-companion.mjs:508`, `:533`, `:552` | always JSON | Separate subcommand |
| Kimi | `external_review_launched` | `plugins/kimi/scripts/lib/companion-common.mjs:74-82` | jsonl/markdown | Emitted at `plugins/kimi/scripts/kimi-companion.mjs:834-839` |
| Kimi | `external_review_progress` | `plugins/kimi/scripts/lib/companion-common.mjs:84-95` | jsonl/markdown | Heartbeat started at `plugins/kimi/scripts/kimi-companion.mjs:843`, cancelled in `finally` at `:897` |
| Kimi | `launched` (background) | `plugins/kimi/scripts/lib/companion-common.mjs:97-109` | jsonl/markdown | `plugins/kimi/scripts/kimi-companion.mjs:716-721`, `:1201-1206` |
| Kimi | terminal JobRecord | n/a | jsonl/markdown | `plugins/kimi/scripts/kimi-companion.mjs:264`, `:749`, `:799`, `:830`, `:894`, `:1005`; always **after** spawn closed |
| Kimi | `preflight` (not part of run) | `plugins/kimi/scripts/kimi-companion.mjs:567`, `:592`, `:611` | always JSON | Separate subcommand |
| Grok (web) | `external_review_launched` (inline) | `plugins/grok/scripts/grok-web-reviewer.mjs:3045-3052` | jsonl/markdown | Emitted only AFTER preflight readiness passes and BEFORE `callGrokTunnel`; if preflight fails, no launch event is emitted (`plugins/grok/scripts/grok-web-reviewer.mjs:3044`) |
| Grok (web) | `external_review_progress` (inline) | `plugins/grok/scripts/grok-web-reviewer.mjs:170-181` | jsonl/markdown | Heartbeat `startLifecycleHeartbeat` at `plugins/grok/scripts/grok-web-reviewer.mjs:3054`, cancelled in `finally` at `:3059` |
| Grok (web) | terminal record | n/a — full record | jsonl/markdown | `printLifecycleJson(printable, lifecycleEvents)` at `plugins/grok/scripts/grok-web-reviewer.mjs:3089`, after fetch resolves |
| Grok (web) | No background `launched` event | n/a | n/a | Grok web reviewer is single-shot foreground only; no background-detach path |
| DeepSeek (api-reviewers) | `external_review_launched` (inline) | `plugins/api-reviewers/scripts/api-reviewer.mjs:2347-2354` | jsonl/markdown | Emitted AFTER `validateDirectApiRunPreflight` returns ok and BEFORE `callProvider` HTTP fetch; if execution already set by preflight/scope failure, no launch event |
| DeepSeek | `external_review_progress` (inline) | `plugins/api-reviewers/scripts/api-reviewer.mjs:160-171` | jsonl/markdown | Heartbeat at `plugins/api-reviewers/scripts/api-reviewer.mjs:2356`, cancelled at `:2364` |
| DeepSeek | `external_review_approval_request` | `plugins/api-reviewers/scripts/api-reviewer.mjs:1916-1925` | always JSON | Approval-request subcommand; not part of `run` |
| DeepSeek | terminal record | n/a | jsonl/markdown | `plugins/api-reviewers/scripts/api-reviewer.mjs:2381`, after fetch resolves |
| GLM (api-reviewers) | identical to DeepSeek | same file | same | Same code path — only `provider` flag and `cfg.display_name` differ |

**Critical gap**: there is **no** `external_review_completed` event in the codebase (`grep -rn "external_review_completed" plugins` returns zero matches). The terminal signal is the JobRecord blob itself, which contains a `status` field. The host cannot tell from event name alone whether the run finished — it must parse the absence of an `event` key.

---

## 2. Wrapper buffering surface

The wrapper's own stdout is unbuffered to a pipe (Node default for `process.stdout` when stdout is a pipe — see Node `process.stdout.isTTY`/synchronous-write semantics; we did not exercise the pipe-vs-TTY branch). The buffering this section maps is wrapper-of-child buffering, not host-of-wrapper buffering.

| Provider | Spawn site | stdio | stdout handling | Streamed to lifecycle? | Classification |
| --- | --- | --- | --- | --- | --- |
| Claude | `plugins/claude/scripts/lib/claude.mjs:257` (`spawn(binary, args, {cwd, env: targetEnv, stdio: ["pipe","pipe","pipe"]})`) | piped | `collectChildOutput` at `plugins/claude/scripts/lib/claude.mjs:60-65` — `child.stdout.on("data", chunk => { output.stdout += chunk })` fully buffers into a single string; result returned only on `child.on("close", ...)` at `:266-291` | No. Claude child stdout is invisible to the lifecycle stream until close. Heartbeat is the ONLY mid-run lifecycle signal. | **buffered** |
| Gemini | `plugins/gemini/scripts/lib/gemini.mjs:147` (`spawn(binary, args, {cwd, env: targetEnv, stdio: ["pipe","pipe","pipe"]})`) | piped | `child.stdout.on("data", chunk => { stdout += chunk })` at `:177-178`; result returned only on `child.on("close", ...)` at `:182-196` | No. Same pattern as Claude. | **buffered** |
| Kimi | `plugins/kimi/scripts/lib/kimi.mjs:206` (`spawn(binary, args, {cwd, env: targetEnv, stdio: ["pipe","pipe","pipe"]})`) | piped | `child.stdout.on("data", chunk => { stdout += chunk })` at `:236-237`; result returned only on `child.on("close", ...)` at `:241-251` | No. Same pattern. | **buffered** |
| Grok (web) — tunnel subprocess | `plugins/grok/scripts/grok-web-reviewer.mjs:1683` (`spawn(command[0], command.slice(1), {cwd, env: uvExecutionEnv(env), detached: true, stdio: "ignore"})`) | ignored | Child stdout/stderr discarded entirely (`stdio: "ignore"`). | No. Tunnel child output is not piped at all. | **buffered** (effectively dropped) |
| Grok (web) — review HTTP call | `plugins/grok/scripts/grok-web-reviewer.mjs:1446` (`fetch(endpoint, {method:"POST", body:..., signal: controller.signal})`) | n/a (HTTP) | `stream: false` in request body (`:1435`); `await response.text()` at `:1452` buffers the entire response before parsing | No. Single round trip. Mid-call lifecycle signal is heartbeat only. | **buffered** |
| Grok (web) — `git clone --depth 1` preflight | `plugins/grok/scripts/grok-web-reviewer.mjs:564` (`spawnSync(gitBinary, ["clone", ...], {stdio: ["ignore","pipe","pipe"]})`) | piped sync | `spawnSync` returns when child closes; stdout collected as one buffer | No. | **buffered** |
| Grok (web) — `uv --version` probe | `plugins/grok/scripts/grok-web-reviewer.mjs:655` (`spawnSync(command, ["--version"], {stdio: ["ignore","pipe","pipe"]})`) | piped sync | Same as above | No. | **buffered** |
| Grok (web) — session sync helper | `plugins/grok/scripts/grok-web-reviewer.mjs:2890` (`spawnSync(process.execPath, [GROK_SESSION_SYNC_SCRIPT, ...])`) | piped sync | Same | No. | **buffered** |
| DeepSeek / GLM (api-reviewers) | `plugins/api-reviewers/scripts/api-reviewer.mjs:1518` (`fetch(endpoint, ...)`) | n/a (HTTP) | No `stream` flag set in request body (default OpenAI non-stream); `await response.text()` at `:1527` buffers entire response | No. | **buffered** |

**Conclusion**: every provider runtime is **fully buffered** — there is zero true streaming from the spawned/fetched target to the lifecycle stream. The only mid-run lifecycle signal is the heartbeat, default 30000 ms (`plugins/claude/scripts/lib/companion-common.mjs:121-126` and identical helpers in gemini/kimi; inlined at `plugins/grok/scripts/grok-web-reviewer.mjs:183-188` and `plugins/api-reviewers/scripts/api-reviewer.mjs:173-178`). For runs that complete in < 30 s, **no heartbeat fires at all** — the user sees only the launch card and then the terminal record, with nothing in between. This is the mechanical cause of symptom **S14**.

### 2a. Markdown-mode degradation

`printLifecycleJson(obj, "markdown", out)` (`plugins/claude/scripts/lib/companion-common.mjs:111-119`) renders markdown ONLY when `obj.external_review` exists. The heartbeat event built by `externalReviewProgressEvent` (`plugins/claude/scripts/lib/companion-common.mjs:84-95`) does **not** include an `external_review` field. Therefore in markdown mode, heartbeat lines fall through to `printJsonLine(obj, output)` (line 116) — they are emitted as raw `{"event":"external_review_progress",...}` JSONL even when the operator asked for markdown. The skill documents this as "render `external_review_progress` as a heartbeat for long foreground runs; keep the existing launch card visible and do not render it as a terminal result" (`plugins/claude/skills/claude-review/SKILL.md:36`), but does not require any visible "still running" markdown card. The visual gap is preserved by design and reinforces S14.

### 2b. Heartbeat is `unref`'d

The heartbeat timer is `unref`'d (`plugins/claude/scripts/lib/companion-common.mjs:148`). If the child closes between heartbeat ticks and the event loop drains, the timer can be GC'd without ever firing. A short successful run (< 30 s default) produces exactly zero `external_review_progress` events. There is no smoke test today asserting heartbeat fires for Claude / Gemini / Kimi at all (see §5).

---

## 3. Lifecycle vs verdict semantics

### 3.1 Where status is set

For Claude / Gemini / Kimi the JobRecord builder is shared in shape and the verdict-gating happens in `classifyExecution`. For Grok-web and api-reviewers the builder is inline.

| Provider | JobRecord status set at | Verdict parsed at | Conflation risk |
| --- | --- | --- | --- |
| Claude | `plugins/claude/scripts/lib/job-record.mjs:311-357` (`classifyExecution`); `status: "completed"` returned at `:346` only when `exitCode === 0 && parsed.ok === true && execution.reviewAuditManifest?.review_quality?.failed_review_slot !== true`; otherwise demoted to `error_code: "review_not_completed"` at `:336-345`. | Panel renderer regex `VERDICT_RE` at `plugins/claude/scripts/lib/review-panel.mjs:6` accepts `Verdict: APPROVE\|REQUEST CHANGES\|FAIL\|REJECT` and is consumed by `resultSummary` at `:148-155`. It does **not** accept the prompt-contract underscore form `Verdict: REQUEST_CHANGES` from `plugins/claude/scripts/lib/review-prompt.mjs:699`. Verdict is NOT in JobRecord directly — it lives in `record.result` text. | Persisted record correctly gates `completed` on audit. **Risk**: skill renders `Status: <status>` in the lifecycle card (`plugins/claude/skills/claude-result-handling/SKILL.md:94`) without any explicit "completed does not mean approved" guard. Host could announce "completed" as "approved". |
| Gemini | `plugins/gemini/scripts/lib/job-record.mjs:172` (`classifyExecution`); `failed_review_slot` demotion at `:264-273`; clean `completed` at `:274`. | Same `VERDICT_RE` in shared panel (`plugins/gemini/scripts/lib/review-panel.mjs:6`). | Identical pattern. Same risk. |
| Kimi | `plugins/kimi/scripts/lib/job-record.mjs:173` (`classifyExecution`); `failed_review_slot` demotion at `:264-273`; clean `completed` at `:274`. | Same `VERDICT_RE`. | Identical pattern. Same risk. |
| Grok-web | `plugins/grok/scripts/grok-web-reviewer.mjs:2192-2271` (`buildRecord`); `processCompleted = exitCode===0 && parsed.ok===true` at `:2194`; `completed = processCompleted && !reviewQualityFailed` at `:2197`; `status: completed ? "completed" : "failed"` at `:2252`. | Same `VERDICT_RE` regex inside shared panel (`plugins/grok/scripts/lib/review-panel.mjs:6`). | Inline duplication of the same gating logic — diverges if shared helpers change. Same skill-level conflation risk. |
| DeepSeek / GLM (api-reviewers) | `plugins/api-reviewers/scripts/api-reviewer.mjs:2057-2153` (`buildRecord`); `processCompleted` at `:2059`; `reviewQualityFailed` at `:2060`; `completed` at `:2061`; `status: completed ? "completed" : "failed"` at `:2124`. | Same `VERDICT_RE`. | Same. |

### 3.2 Where conflation can happen

1. **Lifecycle-event stream**: there is no terminal `external_review_completed` event. The terminal lifecycle line is the full JobRecord, which carries `status: "completed"` only when the audit gate passes. So an audit-aware host parsing the final JSONL line will not be misled by `status: "completed"` — it implies `failed_review_slot !== true` (see §3.1 column "JobRecord status set at"). However, `status: "completed"` does NOT imply `verdict: APPROVE`. A clean `Verdict: REQUEST CHANGES` review with all checklist items and non-blocking findings is also `status: "completed"`.

2. **Skill rendering**: the skill markdown for `claude-review` (`plugins/claude/skills/claude-review/SKILL.md:25-58`) and `claude-result-handling` (`plugins/claude/skills/claude-result-handling/SKILL.md:73-99`) tells the host to render `Status: <status>` in the lifecycle card. There is no contract clause that says "Status: completed is not a verdict" — the host (Claude) could verbally summarize "completed" as "approved", which is symptom **S19**. The skill DOES say "Render findings first" (`plugins/claude/skills/claude-result-handling/SKILL.md:62`) and "Critical review findings are a STOP signal" (`:64`), but those depend on the host actually parsing `record.result` for findings. If the host renders only the lifecycle card and not the result body, it will announce a misleading "completed" verdict.

3. **Panel renderer**: `readiness()` at `plugins/claude/scripts/lib/review-panel.mjs:81-96` correctly returns `"review-ready"` only when `status === "completed" && failed_review_slot !== true`, and `"review failed"` when `status === "completed" && failed_review_slot === true`. `operatorState()` at `:128-138` returns one of `approval_required`, `completed_failed_review_slot`, `completed`, `source_sent_waiting`, `running`, `source_sent_timeout`, `failed_before_source_send`, `provider_unavailable`, `auth_session_failure`, `rate_limited`, `usage_limited`. Panel is correct.

4. **Symptom S23** (Claude prose APPROVE but plugin audit failed): the audit catches this via `qualityFlags` at `plugins/claude/scripts/lib/review-prompt.mjs:480-530`. `hasVerdictFlag` is set only when the result text contains the literal `Verdict:` marker (regex on `:480`-ish; actual scan in `looksShallow` & verdict gating). If Claude prose says "I APPROVE this" without the verdict marker, `missing_verdict` is added to `semantic_failure_reasons` at `:517-518`, which makes `failed_review_slot = true` at `:528`. So the audit field IS the source of truth — but only if the host renders findings/`failed_review_slot` rather than just the lifecycle status. **Risk**: if the lifecycle stream emits `status: "completed"` for a run where audit later flags `failed_review_slot=true`, the host could announce APPROVE before audit landed. Today the lifecycle terminal line IS the audited record (audit runs inside `buildJobRecord`), so this race cannot occur for the persisted record. But there is no test asserting that no intermediate `status: "completed"` is ever emitted before audit completes.

---

## 4. Failure-slot vs source-state distinction (panel renderer)

The panel renderer at `plugins/claude/scripts/lib/review-panel.mjs` (and identical synced copies in every provider — confirmed by `wc -l` showing all five copies are 404 lines) defines `operatorState()` at `:128-138`. Mapping the four states named in the brief:

| Brief state name | Panel renderer value | Where computed | Currently distinguishable? |
| --- | --- | --- | --- |
| `completed` (clean audit) | `"completed"` | `plugins/claude/scripts/lib/review-panel.mjs:134` (`status === "completed"` AND `failed_review_slot !== true`) | **Yes**, but too coarse for T077. A clean `APPROVE` and a clean `REQUEST CHANGES` both collapse to `completed`. |
| `approved` (clean + APPROVE verdict) | Pre-GREEN, this was not modeled as a separate state and only surfaced through `resultSummary()`. Current worktree maps clean `APPROVE` to `completed_approved`. | `plugins/claude/scripts/lib/review-panel.mjs` and synced copies | **Current state: distinguishable** via `completed_approved`; see `tasks.md` T077 evidence. |
| `failed_slot` | `"completed_failed_review_slot"` | `plugins/claude/scripts/lib/review-panel.mjs:133` (`status === "completed"` AND `failed_review_slot === true`) | **Yes** |
| `source_state` | Surfaces as `sent` column (`source_content_transmission`) and the `state` values `source_sent_waiting` / `source_sent_timeout` / `failed_before_source_send` | `plugins/claude/scripts/lib/review-panel.mjs:135-137`, `:108-115` | **Yes** for the source-transmission axis; per-provider parity is preserved because `lib/review-panel.mjs` is byte-identical across all five plugins (sync enforced — see `wc -l` above and `scripts/ci/sync-companion-common.mjs`-style scripts). |

**Per-provider parity**:

| Provider | Panel renderer file | States distinguishable |
| --- | --- | --- |
| Claude | `plugins/claude/scripts/lib/review-panel.mjs` | Source state, failed-slot state, and clean verdict states are distinguishable. |
| Gemini | `plugins/gemini/scripts/lib/review-panel.mjs` | Same synced state machine. |
| Kimi | `plugins/kimi/scripts/lib/review-panel.mjs` | Same synced state machine. |
| Grok | `plugins/grok/scripts/lib/review-panel.mjs` | Same synced state machine. |
| api-reviewers (DeepSeek+GLM) | `plugins/api-reviewers/scripts/lib/review-panel.mjs` | Same synced state machine. |

**Historical gap fixed by T077**: before the T077 GREEN slice, there was no separate `completed_approved` or `completed_request_changes` state. A clean completed run with `Verdict: REQUEST CHANGES` rendered panel-state `completed` with `result: request_changes`. The T077 RED test asserted `completed_approved` for a clean APPROVE result and `completed_request_changes` for a clean request-changes result, then GREEN changed the shared state machine and synced provider copies.

**Adjacent parser mismatch fixed after T077**: prompt contracts tell reviewers to emit `Verdict: REQUEST_CHANGES` with an underscore (`plugins/claude/scripts/lib/review-prompt.mjs:699` and synced copies). Current synced `review-panel.mjs` copies parse both `REQUEST CHANGES` and `REQUEST_CHANGES` via `REQUEST[ _]CHANGES`. Focused proof exists in `tests/unit/review-panel.test.mjs`: `review panel normalizes underscore request-changes verdicts`.

```text
REQUEST CHANGES -> state=completed_request_changes, result=request_changes
REQUEST_CHANGES -> state=completed_request_changes, result=request_changes
```

Do not use the historical underscore/space mismatch as current RED proof. It is now regression coverage only. The T077 true RED surface remains the pre-GREEN panel-state split from generic `completed` into `completed_approved` / `completed_request_changes`.

---

## 5. Proposed RED test surface (per provider, no code yet)

Two test families per provider:

**Family A — wrapper-level streaming** (T071 historical RED surface). Proves the launch card / mid-run heartbeat is observed BEFORE the wrapper terminates. The current worktree has T071 implementation evidence in `tasks.md`; this section records the original failure shape.
- Run the wrapper in `--lifecycle-events markdown` mode with a fake target that sleeps long enough to force at least one heartbeat tick (set `CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS=50`).
- Read wrapper stdout line-by-line while it is still running (using a `child.stdout.on("data", ...)` consumer in the test, not `spawnSync`).
- Assert that an `### EXTERNAL REVIEW` markdown card (or a JSONL `external_review_launched` line in jsonl mode) is observed within e.g. 100 ms of spawn, and BEFORE the child closes.
- Assert that at least one `external_review_progress` line is observed during the run (heartbeat).
- Pre-GREEN failure reason: tests used `spawnSync` and only asserted on collected stdout (`tests/smoke/claude-companion.smoke.test.mjs:24-38` and `:652-689`); there was no temporal assertion. Furthermore, in markdown mode heartbeat events had no `external_review` field and silently fell back to JSONL (`plugins/claude/scripts/lib/companion-common.mjs:111-119`), so a "markdown card visible during run" assertion failed even with heartbeat enabled.

**Family B — lifecycle vs verdict** (T077). Split this family into **characterization** vs **true RED**. DeepSeek's review caught a real defect in the prior map: several "RED" assertions below pass today, so they cannot drive implementation.

Characterization tests that probably pass today and should be kept only as guardrails:
- Fake result with prose `"I think this code is fine. APPROVE."` but no literal `Verdict:` marker -> final JobRecord should be `status: "failed"`, `error_code: "review_not_completed"`, and `failed_review_slot === true`.
- Fake result with `Verdict: REQUEST CHANGES` and complete blocking/non-blocking sections -> final JobRecord should be `status: "completed"` and `resultSummary()` should be `"request_changes"`, not `"approve"`. This is a characterization test of current behavior.
- Fake result with prompt-contract form `Verdict: REQUEST_CHANGES` -> final JobRecord may still be `status: "completed"`, but current `resultSummary()` returns `request_changes` and panel state returns `completed_request_changes`. Keep this as parser-contract regression coverage, not as T077's completed-vs-approved RED proof.
- Wrapper stdout should not contain `status: "completed"` before the terminal audited JobRecord. This may already be true because the only terminal line is the audited JobRecord; it is still useful as temporal regression coverage.

Actual RED tests that failed before T077 GREEN:
- **Preferred no-new-event path**: assert the review-panel `State` column / `operatorState()` returns `completed_approved` for clean `Verdict: APPROVE` records, and `completed_request_changes` for clean request-changes records. Current code accepts both `Verdict: REQUEST CHANGES` and `Verdict: REQUEST_CHANGES`; before T077 GREEN, `operatorState()` returned `completed` for clean verdicts, so this was a real RED.
- **Alternative lifecycle-schema path**: assert an explicit terminal lifecycle event exists, e.g. `external_review_completed`, with audited fields `{status:"completed", verdict:"approve"|"request_changes", approval_state:"approved"|"request_changes", failed_review_slot:false}`. Today `grep -rn "external_review_completed" plugins` returns zero matches and the terminal signal is a bare JobRecord with no `event` key, so this is a real RED.

Coordinator recommendation: choose the preferred no-new-event path first. It satisfies T077 with less schema churn: completed audit state remains separate from approval verdict, and the panel gains explicit `completed_approved` / `completed_request_changes` states. The `external_review_completed` path remains a schema decision for a later lifecycle-contract task unless the host integration requires event-name terminal detection.

Test file paths chosen to sit next to existing per-provider smoke and unit tests:

| Provider | Family A RED test (file path) | Assertion shape | Seam under test | Why it failed before GREEN |
| --- | --- | --- | --- | --- |
| Claude | `tests/smoke/claude-companion-streaming.smoke.test.mjs` (new) | `assert.ok(launchedAt - spawnedAt < 100, "launch card must appear within 100ms"); assert.ok(progressEvents.length >= 1, "heartbeat must fire mid-run"); assert.ok(progressMarkdownVisible, "progress must render as visible markdown, not raw JSONL")` | `plugins/claude/scripts/claude-companion.mjs:896-903` (launch + heartbeat); `plugins/claude/scripts/lib/companion-common.mjs:111-119` (markdown fallback) | `spawnSync`-based smoke did not observe mid-run state; heartbeat fell back to raw JSONL in markdown mode because `externalReviewProgressEvent` omitted `external_review`. |
| Gemini | `tests/smoke/gemini-companion-streaming.smoke.test.mjs` (new) | Same shape, against `gemini-companion`. | `plugins/gemini/scripts/gemini-companion.mjs:718-725`; `plugins/gemini/scripts/lib/companion-common.mjs:111-119` | Same root cause as Claude. |
| Kimi | `tests/smoke/kimi-companion-streaming.smoke.test.mjs` (new) | Same shape. | `plugins/kimi/scripts/kimi-companion.mjs:834-843`; `plugins/kimi/scripts/lib/companion-common.mjs:111-119` | Same root cause. |
| Grok (web) | `tests/smoke/grok-web-streaming.smoke.test.mjs` (extension of existing `tests/smoke/grok-web.smoke.test.mjs:2237-2255` which only asserted heartbeat fires, not mid-run visibility) | `assert.ok(launchedAt - spawnedAt < 100); assert.ok(progressEvents.length >= 1); assert.ok(progressMarkdownVisible)` | `plugins/grok/scripts/grok-web-reviewer.mjs:3044-3054`; `plugins/grok/scripts/grok-web-reviewer.mjs:155-168` (inlined `printLifecycleJson`) | Existing heartbeat test used `spawnSync` (collected stdout); it did not assert temporal ordering or markdown visibility. |
| DeepSeek | `tests/smoke/api-reviewers-streaming.smoke.test.mjs` (extension of `tests/smoke/api-reviewers.smoke.test.mjs:3524-3541` which already asserted a heartbeat fires) | Same shape. | `plugins/api-reviewers/scripts/api-reviewer.mjs:2347-2364`; `plugins/api-reviewers/scripts/api-reviewer.mjs:150-158` | Existing heartbeat test used `spawnSync`; it did not assert temporal ordering or markdown visibility. |
| GLM | Same file as DeepSeek (`tests/smoke/api-reviewers-streaming.smoke.test.mjs`), parameterized by `--provider glm`. | Same shape. | Same code path as DeepSeek. | Same root cause; existing tests cover only DeepSeek-as-provider. |

| Provider | Family B RED test (file path) | Assertion shape | Seam under test | Why it failed before GREEN |
| --- | --- | --- | --- | --- |
| Claude | `tests/unit/review-panel.test.mjs` (extend shared panel tests first) plus provider sync check | Build two clean completed records: one `Verdict: APPROVE`, one `Verdict: REQUEST CHANGES` (or underscore form only if parser mismatch is intentionally in scope). Expect `operatorState()`/rendered state `completed_approved` and `completed_request_changes` respectively. Keep characterization asserts for audit-failed prose as separate non-RED guardrails. | `plugins/claude/scripts/lib/review-panel.mjs` and synced copies | Pre-GREEN, `operatorState()` returned `completed` for both clean verdicts. |
| Gemini | Same shared panel test + sync copies | Same shape. | `plugins/gemini/scripts/lib/review-panel.mjs` | Same pre-GREEN synced state-machine reason. |
| Kimi | Same shared panel test + sync copies | Same shape. | `plugins/kimi/scripts/lib/review-panel.mjs` | Same pre-GREEN synced state-machine reason. |
| Grok (web) | Same shared panel test + sync copies | Same shape. | `plugins/grok/scripts/lib/review-panel.mjs` | Same pre-GREEN synced state-machine reason. |
| DeepSeek | Same shared panel test, provider row `deepseek` | Same shape. | `plugins/api-reviewers/scripts/lib/review-panel.mjs` | Same pre-GREEN synced state-machine reason. |
| GLM | Same shared panel test, provider row `glm` | Same shape. | `plugins/api-reviewers/scripts/lib/review-panel.mjs` | Same pre-GREEN synced state-machine reason. |

If the coordinator chooses the alternative explicit lifecycle terminal event instead, use provider smoke tests rather than panel-only unit tests:

| Provider family | Alternative true RED test | Why it fails today |
| --- | --- | --- |
| Claude/Gemini/Kimi | Foreground lifecycle JSONL test expects one `external_review_completed` event after audit with `approval_state:"approved"` or `"request_changes"` and no earlier terminal approval event. | No `external_review_completed` event exists. |
| Grok (web) | Same shape in `tests/smoke/grok-web.smoke.test.mjs`. | No `external_review_completed` event exists. |
| DeepSeek/GLM | Same shape in `tests/smoke/api-reviewers.smoke.test.mjs`, provider-parameterized. | No `external_review_completed` event exists. |

Heartbeat env override (`CODEX_PLUGIN_EXTERNAL_REVIEW_HEARTBEAT_MS=50`) is already wired in `plugins/claude/scripts/lib/companion-common.mjs:121-126` (and equivalents); the Family A tests should use it to force at least one heartbeat during a short mocked run.

---

## 6. Risks and contradictions

1. **T071 vs T077 direct conflict — streaming implies approval**. The cleanest T071 fix would be to render the spawned target's stdout to the lifecycle stream live (or at minimum emit periodic `external_review_chunk` events with partial output). But streaming partial review prose to a markdown card would let the host see "APPROVE" mid-stream before the audit completes. That would trigger the exact S23 / S19 conflation T077 is trying to lock out. Mitigation: any live-streaming surface must label content as `partial`, must NOT carry a `status` field, and must NOT surface the parsed verdict until audit has signed off — basically: the lifecycle stream can stream content for visibility but the verdict/approval signal must remain monotonic and ONLY appear in the terminal audited record.

2. **T071 vs T078 (privacy) conflict**. Spec FR-009 requires "Full rendered prompts MUST NOT be persisted in records or manifests" (`specs/140-no-mistakes-provider-readiness/spec.md:96`). If T071 streams target stdout live, that stdout may contain quoted source snippets from the selected scope (Claude's review output frequently quotes the code under review). A naive "render child stdout to lifecycle" implementation would leak source into the lifecycle stream, which the host may then persist as part of the transcript — duplicating source content into a surface that wasn't auditing for it. Mitigation: streaming must apply the same redactor used in `plugins/grok/scripts/grok-web-reviewer.mjs:1441` (`redactor()`) and the api-reviewer equivalent, and must explicitly avoid copying the rendered prompt body. The reviewer never sees the prompt body, but it does see source as part of `--add-dir` inspection — that path needs separate handling.

3. **Markdown vs JSONL inconsistency**. The skill says "Render lifecycle markdown cards directly" (`plugins/claude/skills/claude-review/SKILL.md:34`) but the heartbeat event has no `external_review` field so it silently degrades to raw JSON (`plugins/claude/scripts/lib/companion-common.mjs:113-117`). A T071 implementation that adds `external_review` to the progress event for markdown rendering will change every downstream consumer's parser expectations. Existing test `tests/unit/companion-common.test.mjs:93` asserts `lifecycleMarkdownProgress` matches `/^\{"event":"external_review_progress"/` — i.e., it asserts the CURRENT degraded behavior. Adding the field would break that assertion; the test must be updated as part of T071.

4. **Heartbeat default 30000 ms vs runs < 30 s**. Default heartbeat at `plugins/claude/scripts/lib/companion-common.mjs:123` is 30 s. Many smoke / replay runs complete in 5–25 s. With the `unref` at `:148`, those runs may produce zero progress events. Symptom S14 is the direct consequence. T071 must either drop the default to something like 2–5 s or emit at least one immediate "running" event right after the launch card. Lowering the default could spam long runs — likely the right shape is: one "running" event immediately after launch (T+0), then periodic heartbeats every N seconds.

5. **No `external_review_completed` event**. The terminal lifecycle line is the full JobRecord blob, distinguishable from `external_review_launched`/`external_review_progress` only by the *absence* of an `event` key (or by the presence of a `status` field at the top level). A poorly-written host parser that filters by `event === ...` would never see the terminal record at all. There is no contract assertion in `EXTERNAL_MODEL_CONTRACT_VERSION=1` (`plugins/claude/skills/claude-review/SKILL.md:10`) that requires the host to handle the no-`event`-key case. T071 might add an explicit `external_review_completed` (or `external_review_failed`) event wrapping the JobRecord — but doing so would either duplicate the record on stdout or change the contract semantics. Either way, this is a non-trivial schema decision the coordinator should resolve before implementation.

6. **Per-provider duplication of gating logic**. Claude / Gemini / Kimi share `classifyExecution` SHAPE but each has its own copy (`plugins/{claude,gemini,kimi}/scripts/lib/job-record.mjs:311+`). Grok-web (`plugins/grok/scripts/grok-web-reviewer.mjs:2192-2271`) and api-reviewers (`plugins/api-reviewers/scripts/api-reviewer.mjs:2057-2153`) inline the same `processCompleted && !reviewQualityFailed` logic separately. Any T077 invariant added to one provider must be added to all five — there is no shared helper. T071/T077 implementation lanes should consider whether to extract a shared `audit-gated-status.mjs` helper before adding the invariant to every provider.

7. **T077 RED test for verdict-aware completed states was structural**. The pre-GREEN panel did not distinguish `completed_approved` from `completed_request_changes` in the `state` column. Current worktree now does. If the coordinator later chooses `external_review_completed`, treat that as a lifecycle schema change and write provider smoke tests first; do not count characterization tests in §5 as T077 RED proof.

---

## Appendix — file:line index of all `printLifecycleJson` call sites

- `plugins/claude/scripts/claude-companion.mjs`: `836`, `885`, `897-900`, `937`, `991`, `1052`, `1140`, `1556`
- `plugins/gemini/scripts/gemini-companion.mjs`: `660`, `713`, `719-722`, `758`, `805`, `847`, `864`, `1238`
- `plugins/kimi/scripts/kimi-companion.mjs`: `264`, `721`, `749`, `799`, `830`, `835-838`, `894`, `1005`, `1206`
- `plugins/grok/scripts/grok-web-reviewer.mjs`: `3045-3051` (launched), `3054` (heartbeat start), `3089` (terminal record)
- `plugins/api-reviewers/scripts/api-reviewer.mjs`: `2348-2354` (launched), `2356` (heartbeat start), `2381` (terminal record)
