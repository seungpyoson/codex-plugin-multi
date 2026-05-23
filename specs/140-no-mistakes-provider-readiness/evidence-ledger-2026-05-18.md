# Evidence Ledger: 2026-05-18 Provider Review Failures

Repo: `/Users/spson/Projects/Claude/codex-plugin-multi`
Head: `59e4c5d61e1d716cdf254ee6a06a3b985c0bd0b8`
Mode: evidence first; no implementation from this ledger alone.

## External Review Status

| Provider | Packet | Source state | Result |
|---|---|---|---|
| Claude | Full selected source, 10 files, 786740 bytes | sent | `REQUEST_CHANGES`; job `d66e3d47-4e28-47c0-8acc-dbbe20f7e7dc` |
| Gemini | Full selected source, 10 files, 786740 bytes | sent | failed quality due `NOT_REVIEWED` prose, raw substantive `REQUEST_CHANGES`; job `453de7c9-3795-46c4-985f-20b96c530a89` |
| Kimi | Full selected source, 10 files, 786740 bytes | sent | failed quality `missing_verdict`, raw substantive `REQUEST_CHANGES`; job `04bbeb57-cd62-4f50-bc93-1c9db05f5d5c` |
| DeepSeek | Full packet first, narrow `DESIGN.md` retry | first not sent, retry sent | full packet failed `prompt_too_large` around 795k chars over 600k cap; narrow retry `REQUEST_CHANGES`; job `job_5f7a0232-bb3a-4ffa-8e20-2194fffed636` |
| GLM | Full packet first, narrow `DESIGN.md` retry | first not sent, retry sent | full packet failed `prompt_too_large` around 795k chars over 600k cap; narrow retry failed quality but raw `REQUEST_CHANGES`; job `job_8dac231e-8e80-48a3-92fb-a19f06243cf2` |
| Grok | Earlier dogfood runs and source-free CLI probes | tunnel failure not sent; CLI probe source-free | Initial state: tunnel intermittent/unavailable; CLI source-free viable only after unsandboxed `--max-turns 8`; source-bearing CLI wrapper later proven by T034 |

## Root Failure Classes

| Class | Evidence | Required handling |
|---|---|---|
| Auth-mode default confusion | User clarified default must not be `auto`; explicit `--auth-mode auto` may fall back to API | Audit docs, skills, provider config, wrapper defaults; preserve explicit operator-selected auto only |
| Approval scope expansion | Gemini and Claude flagged current-turn approval reuse as unsafe if scope/source/provider changes | Approval reuse must be bound to unchanged provider and unchanged approved source intent; expanded source needs fresh human approval |
| Prompt-size overflow | DeepSeek/GLM full selected source attempts failed before source send at provider cap | Classify as pre-send `prompt_too_large`; require sharding/narrowing before source send |
| Result lookup cwd | Dogfood `result --job-id` and missing `--cwd` lookups failed, then succeeded with launch workspace | Keep `--job-id` alias and bounded workspace diagnostics |
| Review-quality false/missing verdict | Kimi and GLM returned substantive prose but failed quality; Gemini failed due `NOT_REVIEWED` wording | Treat slot as failed unless exact verdict contract is met; raw can inform diagnosis but not count as completed |
| CLI runtime failures | Grok CLI source-free probe hit sandbox `FS_PERMISSION_DENIED` when it wrote sessions under `~/.grok`; `--max-turns 1` failed; `--max-turns 8` passed | Failure class retained; Grok wrapper now runs with a private temp `GROK_HOME`, symlinks auth/config from the real Grok home, disables memory, and deletes temp session state after each source-free and source-bearing run |
| Grok tunnel failure | Dogfood showed tunnel unavailable before source send; later doctor ready did not prove stable default | Closed for default path: Grok CLI is now default; tunnel/grok2api requires explicit `--transport web` or `GROK_TRANSPORT=web` |
| Grok CLI default gap | CLI source-free and dummy source-bearing probes now pass through source and installed-cache wrappers; neutral cwd, private prompt file, temp `GROK_HOME`, auth/config symlink, JSON parse, cleanup, and no-source-persistence checks are covered | Closed for T034; remaining Grok work is future robustness only, not default tunnel dependency |
| Stale doctor evidence | Kimi and Claude reviewers flagged doctor success as insufficient later source-send proof | Immediate source-free preflight must run before source send or classify stale/missing readiness |
| Same-path repair ambiguity | Reviewers flagged undefined automatic vs approval-required vs forbidden repair. Focused proof now shows direct API approval tokens reject changed provider, source path, source bytes, and request timeout before source send; Claude/Gemini explicit `--auth-mode auto` re-preflight fallback before selected source can launch. | Closed as no-op implementation: current runtime already enforces the accepted same-path boundary. |
| Prompt sidecar/privacy | Kimi reviewer flagged prompt sidecars and launcher-crash persistence | Define redaction, cleanup, source persistence, lifecycle/review-panel disclosure |
| Installed-cache divergence | Claude/GLM flagged `doctor:cache` as insufficient proof by itself | Prove installed runtime path, generated docs, copied libs, and cache state together |
| Claude OAuth/401 | Dogfood had `oauth_inference_rejected`, 401 invalid auth before source send | Classify as auth/OAuth failure with next action, not generic provider failure |
| Direct API outage/rate limit | DeepSeek/GLM can fail by provider/API state independent of local code | Classify without blocking on extra permission prompts after approved source-send intent |
| Interrupted/concurrent jobs | Reviewers flagged resume after restart, state-root collision, lock timeout, partial transmission | Add explicit job-state and source-transmission terminal states |
| Lifecycle/panel ambiguity | Lifecycle-only output caused manual inference | Keep retrieve/panel rows; do not treat lifecycle status as review verdict |
| Visual-status gap | RED proof: markdown progress emitted raw `external_review_progress` JSONL because `renderLifecycleMarkdown` only rendered cards when `external_review` existed; smoke tests also protected raw JSONL progress. Wrapper evidence remains: one-off `node -e` plus `spawnSync` relays child lifecycle only after exit. | Closed for runtime lifecycle markdown in T039: launch, running/progress, blocked, failed, and completed states render as terminal-safe markdown cards while JSONL mode stays compatible. Do not use `spawnSync` wrappers when live streaming matters. |

## Evidence Closed After External Review

| Task | Evidence | Result |
|---|---|---|
| T026 auth/default audit | `rg` over generated commands/skills found no `--auth-mode auto`; Claude/Gemini wrapper defaults resolve missing auth mode to `subscription`; DeepSeek/GLM `providers.json` uses `api_key`; after T034, source and cached Grok help report `provider:"grok"`, `default_auth_mode:"subscription_cli"`, `default_transport:"cli"`, `legacy_transport:"web"` | Direct API, companion default-auto, and Grok default-transport concerns closed for current artifacts |
| T032 installed-runtime audit | Source/cache SHA comparison for runtime scripts and copied libs returned `all_match:true`; `npm run doctor:cache` returned `ok:true`; installed cached API/Grok help commands ran | Cache/source divergence concern closed for current artifacts |
| T048 approval scope safety | Synthetic direct-API probe: reused token with changed provider, changed scope path, and changed source bytes all failed `approval_required` with `source_content_transmission:"not_sent"` | Current-turn approval can be reused only with matching token/same payload |
| T053 Grok CLI evidence | `grok --version` returned `grok 0.1.211`; `grok models` reported logged in with grok.com and default model `grok-build`; sandboxed source-free CLI failed `FS_PERMISSION_DENIED`; wrapper fixed this with temp `GROK_HOME`; source and cached dummy source-bearing probes passed with `source_content_transmission:"sent"` and cleanup proof. | Grok CLI default is implemented and proven for current source/cache. Tunnel is explicit legacy fallback only. |
| T056 visual status evidence | Code inspection and RED tests proved raw JSONL progress in markdown mode; T039 fixed shared/API/Grok renderers so bare progress events synthesize `external_review` cards; JSONL shape remains unchanged. | Visual contract is implemented for lifecycle progress; review panel and manifest remain separate explicit surfaces. |
| T057 cancellation scope evidence | Claude smoke tests cover running background cancel, SIGTERM-trapping target, queued cancel, worker pre-spawn cancel, already-terminal, cancelled continuation. Gemini smoke tests cover running cancel, queued cancel, pre-spawn cancel, marker write failure, bad state, already-terminal, SIGTERM trap, ESRCH, not-found, cancelled continuation. Kimi smoke tests cover queued cancel, pre-spawn prompt-sidecar cleanup, SIGTERM trap, and blocked process inspection as unverifiable. | CHK008 is covered for Claude, Gemini, and Kimi cancellation/stuck-running surfaces; Grok has no cancel command and remains out of continuation-capable cancel scope |
| T035 same-path proof | Focused smoke: `node --test --test-name-pattern "approval token is bound to provider, source packet, and request settings\|auto auth re-preflights API-key fallback" tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/claude-companion.smoke.test.mjs tests/smoke/gemini-companion.smoke.test.mjs` -> 3 passed. | No runtime patch needed; existing code already preserves source-send truth and explicit-auto fallback semantics. |

## Map Re-Review Status

| Provider | Job | Source state | Verdict | Main finding |
|---|---|---|---|---|
| Claude | `3e8beaf3-5674-4c80-81e0-33875e1aeb14` | sent | `REQUEST_CHANGES` | T053/T034 circularity; Grok SC gap; FR-020 tuple mismatch; false-done checklist items |
| Gemini | `3d21cdb4-24fb-4b11-988e-02068c3e8077` | sent | `REQUEST_CHANGES` | T053/T034 circularity |
| Kimi | `c79c8913-3e17-4826-86c2-29b2c0307696` | sent | `REQUEST_CHANGES` | T053/T034 circularity; CHK022/CHK031 false done; interrupted-source mapping gap |
| GLM | `job_76588746-958e-4c25-b6d6-4b9b8d088dc7` | sent | `REQUEST_CHANGES` | T035/T037 stale blocked labels |
| DeepSeek | `job_10964494-fd1f-4b30-b76f-f5e68a1cf01a` | sent | `APPROVE` with concerns | Grok assumptions and T028 traceability need alignment |

## Map Re-Review V2 Status

| Provider | Job | Source state | Verdict | Main finding |
|---|---|---|---|---|
| Claude | `4c7f9313-7c0e-4869-a48b-8fc41dbd911f` | sent | `APPROVE` with nonblocking concerns | Approval tuple drift remains; CHK008 needs a closing task |
| Gemini | `70448904-aacb-4de0-90a5-de3c86f25530` | sent | `APPROVE` | T053/T034 cycle resolved; visual-status bug captured |
| Kimi | `55548c99-7359-4f29-bf39-a1c3ac03544a` | sent | failed quality `missing_verdict`; raw says approve | Official slot failed, so it cannot count as clean approval |
| GLM | `job_0edcf927-eef1-46b1-a7c6-b2a5e2376c80` | sent | `APPROVE` with nonblocking concerns | Approval tuple drift in data model; `transport` definition ambiguity |
| DeepSeek | `job_fd79697f-865b-4f6a-803d-4c13e6017a56` | sent | `APPROVE` with concerns | Historical V2 finding: visual-status checklist and T053 were not closed yet; both later closed by T039/T034 |

## Map Re-Review V3 Status

| Provider | Job | Source state | Verdict | Main finding |
|---|---|---|---|---|
| Claude | `9c9a2b40-b540-488f-892c-b8d5f7bdb625` | sent | `APPROVE` | No blocking findings; stale visual-checklist wording and Grok tier/version evidence were nonblocking |
| Gemini | `f9e37628-47ec-4d0f-b04b-da75733ec556` | sent | `APPROVE` | CHK022/CHK031/CHK032 can close after this review |
| Kimi | `5cce11df-00cc-4509-b918-e411f53d75fc` | sent | `APPROVE` | Clean quality gate; CHK022/CHK031 intentionally gated by review/T034 |
| GLM | `job_2449eaed-1b57-478e-b764-c67ad142aa1a` | sent | `APPROVE` | No missing classes or false-done tasks; noted Grok version gate and continuation/content-policy follow-up as nonblocking |
| DeepSeek | `job_383579f5-2112-4da3-867c-98483c0b25a6` | sent | `APPROVE` | No blocking findings; checklist sync needed after review |

## Current Decision

Map re-review V3 has no blocking findings. Implementation may start only from
the task list gates below; runtime code still needs TDD and focused proof.

- Grok CLI wrapper proof: implemented and verified. Full Grok smoke: `npm run smoke:grok` -> 133 passed. Source doctor: `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` -> `ready:true`, `transport:"cli"`, `grok_version:"grok 0.1.211 (2f2cd6d5c2)"`, `default_model:"grok-build"`, `prompt_cleanup:"deleted"`, `grok_home_cleanup:"deleted"`. Cached doctor returned the same readiness. Cached dummy source-bearing job `job_5144d6f1-3244-4d85-a0cc-5968b85429aa` completed with `source_content_transmission:"sent"` and temp-home cleanup.
- Grok legacy tunnel proof: policy implemented. Default help reports `provider:"grok"`, `default_auth_mode:"subscription_cli"`, `default_transport:"cli"`, `legacy_transport:"web"`; full Grok smoke still covers explicit web/tunnel behavior.
- Visual-status contract: raw JSONL progress in markdown mode was reproduced, then fixed in T039. Lifecycle markdown now renders running/progress cards; one-off `spawnSync` wrappers can still buffer child output and must not be used when live streaming matters.
- Approval tuple: canonical tuple is provider, mode, source packet, prompt hash, scope resolution, request settings, auth path, and billing path, plus a fresh matching approval token.
- Cancellation scope: Claude/Gemini/Kimi cancel and stuck-running surfaces are covered by T057; Grok has no cancel command.
- External re-review: V3 review completed with Claude, Gemini, Kimi, GLM, and DeepSeek all returning `APPROVE` with clean transport.

## T087 Kimi Mutation Prevention Design Reviews

T087 is not implementation-ready. Three design rounds were reviewed, and v3 was
still rejected by a majority of subscription/API reviewers.

| Round | Provider | Job | Source state | Verdict | Blocking result |
|---|---|---|---|---|---|
| v1 | Claude/Kimi/DeepSeek/GLM | mixed | sent | `REQUEST_CHANGES` majority | `exclude_tools`/`--plan` alone were rejected; Kimi needs native fully qualified `allowed_tools` proof. |
| v2 | Claude | `abe13574-8598-4949-85f3-e8636651680f` | sent | `REQUEST_CHANGES` | Plugin/MCP bypass, ping exclusion not justified, one sentinel too narrow, mutation detection must hard-fail. |
| v2 | Gemini | `e3e4f7a3-c7d4-483d-9d65-b5fce672abe5` | sent | `APPROVE` with caveat | Accepted only if plugin/MCP caveat is closed. |
| v2 | Kimi | `038c6e54-98e8-485a-8b3c-6878a9407961` | sent | `REQUEST_CHANGES` | Plugin/MCP likely bypass; empirical proof must precede implementation; `--plan` unspecified. |
| v2 | DeepSeek | `job_2837a29d-52fd-4c28-8cf3-7c4d14f5e88e` | sent | `APPROVE` with caveats | Requested careful proof around the same bypass surfaces. |
| v2 | GLM | `job_3c1e393b-13e9-487e-94a8-8c82d5f5f4f9` | sent | `REQUEST_CHANGES` | Agent-file silent fallback, MCP/plugin probe gap, `--plan` unresolved. |
| v3 | Claude | `309dcc63-145e-4f74-8fed-877c7474ee69` | sent | `REQUEST_CHANGES` | Credential lifecycle under per-job `KIMI_SHARE_DIR` undefined; ping/readiness conflict; ping with `--agent-file` unproved; telemetry/session/log/prompt/credential leak probe missing; temp-share cleanup ordering missing; dead `disallowed_tools` must be removed or converted. |
| v3 | Gemini | `ddf876ea-afd1-4346-99d4-a04c02b75022` | sent | `APPROVE` | Official quality passed, but output had suspicious preamble/tool-use noise; do not treat as overriding other blockers. |
| v3 | Kimi | `ab8423b6-7458-4b32-819a-bbe785934f53` | sent | `REQUEST_CHANGES` | Credential copies in temp `KIMI_SHARE_DIR` risk leftover OAuth material; `--print` may override `--agent-file`; `--skills-dir` semantics unverified. |
| v3 | DeepSeek | `job_a2867dcc-4fd2-44c0-afad-d621f5a21320` | sent | `APPROVE` | Accepted v3 with caveats around auth subset, empty MCP, skills dir, plan removal, and ping. |
| v3 | GLM | `job_c41ec925-ddf9-49a1-a038-df903bda9ea4` | sent | `REQUEST_CHANGES` | Ping through read-only agent may break readiness; agent-file silent-ignore needs runtime detection; `--plan` removal needs empirical variants; `--skills-dir` override must be proven or treated as defense-in-depth only. |

Current T087 decision:

- v1, v2, and v3 are rejected.
- No Kimi mutation-prevention implementation may start from these designs.
- v4 must settle credential strategy, plugin/MCP/skills neutralization, ping
  inclusion/exclusion, cleanup/privacy hard-fail behavior, agent-file runtime
  validation, `--plan` behavior, and mutation override semantics.
- After v4 external approval, the first executable step is an isolated Kimi
  mutation-attempt proof, not source-workspace code changes.

## Grok CLI Wrapper Contract And T034 Proof

T034 implements and verifies this contract:

- Default transport is Grok CLI. Tunnel is explicit legacy fallback only.
- Source-free preflight runs from a neutral temp cwd with headless Grok CLI.
- Source-bearing review uses a private prompt file and records cleanup state.
- Wrapper records Grok version, cwd, parse mode, timeout, source hashes,
  source-send state, prompt hash, and selected paths.
- Wrapper uses JSON output when available and bounded plain text only through an
  explicit fallback parser.
- Wrapper does not allow accidental real-repo exploration or mutation.
- Wrapper preserves timeout, cancelled, parse, review-quality, auth, sandbox,
  privacy, and interrupted-source classifications.
- Wrapper never persists source bodies, full prompts, credentials, cookies,
  bearer tokens, or API keys.

T034 verification evidence:

- `node --test --test-name-pattern "custom-review defaults to Grok CLI" tests/smoke/grok-web.smoke.test.mjs` passed after RED failure proved the old default still used the tunnel.
- `npm run smoke:grok` passed: 133 tests, including default CLI, explicit legacy web, source-send state, result lookup, prompt cap, tunnel errors, replay fixtures, and session-sync timeout classification.
- `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` passed under Codex sandbox after temp `GROK_HOME` fix.
- `npm run doctor:cache` passed after installed Grok cache refresh.
- Cached real dummy source-bearing probe completed as job `job_5144d6f1-3244-4d85-a0cc-5968b85429aa` with `provider:"grok"`, `auth_mode:"subscription_cli"`, `source_content_transmission:"sent"`, `prompt_cleanup:"deleted"`, `neutral_cwd_cleanup:"deleted"`, and `grok_home_cleanup:"deleted"`.

## Visual Status Evidence Map

| Checklist | Evidence-backed requirement |
|---|---|
| Visual CHK001 | Per-job lifecycle card, review panel, and readiness manifest are separate surfaces. |
| Visual CHK002 | Lifecycle is automatic when markdown/jsonl is selected; review panel and manifest are explicit commands. |
| Visual CHK003 | Installed-plugin users must get lifecycle cards and panel commands from plugin copies, not repo-only scripts. |
| Visual CHK004 | Claude/Gemini/Kimi, Grok CLI, Grok legacy tunnel, DeepSeek, and GLM use one visual-status contract. |
| Visual CHK005 | Every visual surface shows source transmission before and after source-bearing review. |
| Visual CHK006 | Visually explicit means terminal-safe markdown rows/cards for launch, running/progress, blocked, failed, completed, and cancelled states. |
| Visual CHK007 | Accepted lifecycle modes are `jsonl` and `markdown`; invalid mode fails safely. |
| Visual CHK008 | Runtime renders lifecycle. Agent prose can summarize but cannot replace lifecycle/panel/manifest state. |
| Visual CHK009 | Required fields are provider, job, session, run kind, mode, scope, source state, status, retrieve, panel, error/message/summary/action, HTTP, disclosure. |
| Visual CHK010 | Review-ready, completed, approved, visually surfaced, and failed slot remain distinct. |
| Visual CHK011 | Manifest rows, panel rows, and lifecycle status share failure classes. |
| Visual CHK012 | Direct API approval status and source-send disclosure appear in lifecycle/panel/manifest. |
| Visual CHK013 | Generated command/skill docs must request markdown lifecycle for foreground/background review flows and preserve installed copies. |
| Visual CHK014 | no-mistakes, local runtime, GitHub CI, panel, and manifest are separate evidence surfaces. |
| Visual CHK015 | Source-free smoke must prove markdown progress without contacting external providers. |
| Visual CHK016 | Cache sync is required after shared renderer or generated docs/skills change. |
| Visual CHK017 | Invalid lifecycle mode fails with bounded bad-args output and no hidden source-send. |
| Visual CHK018 | Broken slots must show launch/waiting/failed/completed/cancelled state, not prose-only summaries. |
| Visual CHK019 | Foreground, background, status polling, result retrieval, and continuation lifecycle scenarios are required. |
| Visual CHK020 | Sandbox, auth, approval, provider, review-quality, prompt-size, tunnel, and visual-status failures must be visible. |
| Visual CHK021 | Recovery actions are same-path and explicit; no cross-provider fallback hidden by visual output. |
| Visual CHK022 | Visual output redacts secrets, full prompts, source bodies, cookies, API keys, and bearer values. |
| Visual CHK023 | Shared renderer ownership and plugin-copy sync are required. |
| Visual CHK024 | Markdown must be plain terminal-safe table/card output. |
| Visual CHK025 | JSONL consumers remain supported; markdown improves human visibility only. |

## Complete Policy Map

### Transport Defaults

| Provider | Default | Explicit fallback |
|---|---|---|
| Claude | subscription/OAuth CLI | same-provider API key only when operator selects `--auth-mode auto` or `api_key` |
| Gemini | subscription/OAuth CLI | same-provider API key only when operator selects `--auth-mode auto` or `api_key` |
| Kimi | Kimi Code CLI | no direct API fallback in current wrapper |
| Grok | Grok CLI after wrapper proof | Grok web/grok2api tunnel as explicit legacy fallback only |
| DeepSeek | direct API key | no cross-provider fallback |
| GLM | direct API key | no cross-provider fallback |

### Pre-Send Gate

Every source-bearing send needs immediate proof in the same run. Old doctor/setup proof is stale. If preflight fails, source stays `not_sent`.

| Path | Pre-send proof |
|---|---|
| Companion CLI | binary exists, auth/readiness check succeeds, source scope resolves, prompt budget passes |
| Grok CLI | source-free headless prompt from neutral cwd succeeds, output parseable, prompt sidecar private/cleanable |
| Grok tunnel | explicit tunnel selected, models ready, chat source-free preflight ready, runtime tokens valid |
| Direct API | env/config present, prompt under cap, approval-request `not_sent`, matching approval token |

### Repair Boundary

| Repair class | Allowed without approval? |
|---|---|
| Source-free validation, prompt budget check, scope validation, result lookup guidance | yes |
| Retry after no source was sent, same provider/auth/scope/source/prompt/request | yes |
| CLI login/reauth, browser/session sync, grok2api clone/bootstrap, cache install/upgrade, GitHub mutation, destructive cleanup, billing/tier action | no |
| Cross-provider fallback, paid Grok/xAI fallback, default auth-mode auto, source send after failed preflight or changed approval scope | forbidden |

### Privacy Boundary

Persist hashes, paths, byte/line counts, bounded diagnostics, source-send state, and result text. Do not persist full prompt, source bodies, credentials, cookies, bearer tokens, or API keys. Prompt sidecar cleanup must be proven or classified `privacy_persistence`.

## T039 Visual Runtime Proof

RED:

- `node --test --test-name-pattern "markdown progress card|lifecycle markdown emits launch and terminal cards" tests/unit/companion-common.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs`
- Failure showed launch markdown, raw `{"event":"external_review_progress"...}` lines, and terminal markdown.

GREEN:

- Shared/API/Grok lifecycle renderers synthesize `external_review` metadata for markdown progress.
- JSONL mode keeps the old `external_review_progress` shape.
- `node --test --test-name-pattern "markdown progress card|lifecycle markdown emits launch and terminal cards" tests/unit/companion-common.test.mjs tests/smoke/api-reviewers.smoke.test.mjs tests/smoke/grok-web.smoke.test.mjs` passed.
- `node --test tests/unit/companion-common.test.mjs` passed: 17 tests.
- `node --test tests/unit/review-panel.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/companion-common.test.mjs` passed: 51 tests.
- Provider smokes passed: API 134, Claude 108, Gemini 72, Grok 133, Kimi 67.
- `npm run lint:sync`, `git diff --check`, and `npm run doctor:cache` passed after cache refresh.

## Latest Dirty-Diff External Review And Claude Remediation

Reviewed source bundle: `/private/tmp/cpm-current-dirty-diff-review-bundle-part1.md` plus `/private/tmp/cpm-current-dirty-diff-review-bundle-part2.md`, covering HEAD `59e4c5d61e1d716cdf254ee6a06a3b985c0bd0b8` dirty diff.

| Provider | Job | Source | Verdict | Blocking result |
|---|---|---|---|---|
| Claude | `de32b721-2101-487a-8f69-35f75e28f9d5` | sent | `REQUEST_CHANGES` | B1 valid: launched-but-failed Grok CLI source-bearing run over-reported `sent`; B2 downgraded after live Grok CLI proof below |
| Gemini | `0bd82824-f7a3-4c0e-b7c2-b1bd05d4cda2` | sent | `APPROVE` | No blockers; invalid transport crash noted nonblocking |
| Kimi | `7581cea8-2f5f-4d63-9c2d-fa6f104576ac` | sent | `APPROVE` | No blockers; minor docs/test gaps noted |
| Grok CLI | `job_8f2659be-8709-491d-8391-265674fa029b` | sent | `APPROVE` | No blockers |
| DeepSeek | `job_eaac6096-c65f-4958-9697-8edb7d7c1e68` | sent | `APPROVE` | No blockers |
| GLM | `job_71067d39-ab71-4220-b5de-275d7a3f7fca` | sent | `APPROVE` | No blockers |

T058 RED/GREEN:

- RED: `node --test --test-name-pattern "marks failed source-bearing Grok CLI" tests/smoke/grok-web.smoke.test.mjs` failed with `actual: "sent"`, `expected: "may_be_sent"`.
- GREEN: same command passed after `plugins/grok/scripts/grok-web-reviewer.mjs` made source-bearing nonzero CLI exits report `SOURCE_CONTENT_TRANSMISSION.MAY_BE_SENT`.
- Full Grok smoke: `npm run smoke:grok` -> 134 passed.
- Installed-runtime proof: `npm run doctor:cache` first failed with `repo_changed_files:["scripts/grok-web-reviewer.mjs"]`; after syncing the patched Grok runtime into marketplace/cache, `npm run doctor:cache` returned `ok:true`.

T059 current real Grok CLI proof:

- Latest real Grok CLI source-bearing review job `job_8f2659be-8709-491d-8391-265674fa029b` completed with `source_content_transmission:"sent"`, `auth_mode:"subscription_cli"`, `grok_version:"grok 0.1.211 (2f2cd6d5c2)"`, `default_model:"grok-build"`, `model_ready:true`, `prompt_cleanup:"deleted"`, and `grok_home_cleanup:"deleted"`.
- Runtime diagnostics recorded `transport:"cli"`, `parse_mode:"json"`, `source_free_parse_mode:"json"`, `prompt_chars:309175`, neutral cwd cleanup, temporary `GROK_HOME` cleanup, and linked `auth.json`/`config.toml` only inside the temporary home.

T060/T061 residual hardening:

- RED: `node --test --test-name-pattern "cleanup errors as may-be-sent|missing Grok CLI binary as not sent" tests/smoke/grok-web.smoke.test.mjs` failed for the compound privacy-persistence path with `actual: "sent"`, `expected: "may_be_sent"`. The missing-binary/prelaunch path already passed as `not_sent`.
- GREEN: `plugins/grok/scripts/grok-web-reviewer.mjs` now uses one `grokCliSourceTransmissionForResult()` helper for source-bearing nonzero exits and privacy-persistence exits. Source-bearing cleanup diagnostics now report the source-bearing runtime home cleanup result instead of being overwritten by source-free preflight diagnostics.
- Focused GREEN: `node --test --test-name-pattern "defaults to Grok CLI|failed source-bearing Grok CLI launches|cleanup errors as may-be-sent|missing Grok CLI binary as not sent" tests/smoke/grok-web.smoke.test.mjs` -> 4 passed.
- Full GREEN: `npm run smoke:grok` -> 136 passed; `git diff --check` passed; `npm run lint:sync` passed; `[DEBUG-...]` grep found no debug instrumentation; `npm run doctor:cache` returned `ok:true` after syncing the patched Grok runtime into marketplace/cache.

T062 focused re-review cleanup:

- Focused Claude re-review `a186b213-6462-4b7c-a50b-01efaceb89a0` and Grok CLI re-review `job_69669b0a-03a9-4163-8668-a35437439fb0` both returned `APPROVE`.
- Claude nonblocking concern: T060 test cleanup read nonexistent `runtime_diagnostics.cli_request.grok_home`; fixed by reading the fake CLI log's source-bearing `grokHome` and removing the temp home after restoring blocked-dir permissions.
- Claude nonblocking concern: `privacy_persistence`/`grok_cli_*` fell through to tunnel cause/action; fixed by returning `error_cause:"privacy_persistence"` or `error_cause:"grok_cli"` with CLI-specific suggested action text.
- Focused GREEN after fix: `node --test --test-name-pattern "cleanup errors as may-be-sent|missing Grok CLI binary as not sent" tests/smoke/grok-web.smoke.test.mjs` -> 2 passed.

T063/T064 final focused hardening:

- Final focused Grok CLI re-review `job_84bc130a-a228-4a3b-8e9d-699ce8f9c973` returned `APPROVE`; source was sent through subscription-backed Grok CLI.
- Final focused Claude re-review `8ebb4a4e-42b6-4fc7-86f3-f23a4291c52b` returned `APPROVE`; source was sent to Claude Code. Claude raised nonblocking NB2/NB3: prompt sidecar cleanup persistence was observable but did not fail closed, and source-free `GROK_HOME` cleanup was captured internally but omitted from JobRecord.
- RED: `node --test --test-name-pattern "defaults to Grok CLI|prompt cleanup is not verified" tests/smoke/grok-web.smoke.test.mjs` failed with `source_free_grok_home_cleanup` undefined and a source-bearing prompt cleanup failure completing successfully with `prompt_cleanup:"file_deleted"`.
- GREEN: `plugins/grok/scripts/grok-web-reviewer.mjs` now treats any unverified prompt/runtime cleanup as `privacy_persistence`, uses runtime/prompt cleanup guidance, and includes `source_free_grok_home_cleanup` in `runtime_diagnostics.cli_request`.
- Focused GREEN: `node --test --test-name-pattern "defaults to Grok CLI|prompt cleanup is not verified|cleanup errors as may-be-sent|missing Grok CLI binary as not sent" tests/smoke/grok-web.smoke.test.mjs` -> 4 passed.
- Full GREEN: `npm run smoke:grok` -> 137 passed; `git diff --check` passed; `npm run lint:sync` passed; `[DEBUG-...]` grep found no debug instrumentation.

T065-T068 final Claude nonblocking hardening:

- Final focused Grok CLI re-review `job_72d37b36-7a55-4def-b5dc-571d9b1518bc` returned `APPROVE`; source was sent through subscription-backed Grok CLI.
- Final focused Claude re-review `9092414a-bfeb-4a2b-8837-cf8288442342` returned `APPROVE`; source was sent to Claude Code. Claude raised nonblocking NB1-NB4: failed source-free preflight cleanup diagnostics were asymmetric, direct API env vars were visible to the CLI subprocess, compound privacy-persistence masked CLI stderr/status, and happy-path test did not assert source-free prompt cleanup.
- RED: `node --test --test-name-pattern "defaults to Grok CLI|source-free Grok CLI preflight cleanup|cleanup errors as may-be-sent" tests/smoke/grok-web.smoke.test.mjs` failed with API env vars reaching fake Grok CLI, `exit_status` undefined, and `source_free_grok_home_cleanup:null`.
- GREEN: `plugins/grok/scripts/grok-web-reviewer.mjs` now deletes `GROK_API_KEY`, `XAI_API_KEY`, and `XAI_KEY` from Grok CLI subprocess env; relabels failed source-free preflight cleanup into `source_free_*` diagnostics with source-bearing fields null; and records redacted `exit_status`, `exit_signal`, and `stderr_head` in CLI diagnostics.
- Focused GREEN: `node --test --test-name-pattern "defaults to Grok CLI|source-free Grok CLI preflight cleanup|cleanup errors as may-be-sent" tests/smoke/grok-web.smoke.test.mjs` -> 3 passed.
- Full GREEN: `npm run smoke:grok` -> 138 passed; `git diff --check` passed; `npm run lint:sync` passed; `[DEBUG-...]` grep found no debug instrumentation.
- Cache GREEN: `npm run doctor:cache` -> `ok:true` after syncing the patched Grok runtime into marketplace/cache.
- Final latest-head external review: Claude `cbbb6adb-390d-4847-a287-621f70cb73fb` returned `APPROVE` with no blocking findings; source sent. Grok all-file latest-head attempt `job_01d39189-0160-4b9a-bf09-34a33dfe2eb9` failed before source send with `source_content_transmission:"not_sent"` because rendered prompt exceeded `GROK_CLI_MAX_PROMPT_CHARS=400000`. Split Grok shards passed: code/test shard `job_230ec3ff-a92a-4c67-89ff-3afd5aa027a3` `APPROVE`, docs/evidence shard `job_ad2482f7-20cf-4235-848e-7a2d0602c614` `APPROVE`; both source sent through subscription-backed Grok CLI.

## Final Changed File Map

| File(s) | Task/checklist | Verification | Residual |
|---|---|---|---|
| `plugins/api-reviewers/commands/deepseek-adversarial-review.md`; `plugins/api-reviewers/commands/deepseek-custom-review.md`; `plugins/api-reviewers/commands/deepseek-review.md`; `plugins/api-reviewers/commands/glm-adversarial-review.md`; `plugins/api-reviewers/commands/glm-custom-review.md`; `plugins/api-reviewers/commands/glm-review.md` | T037, CHK002, CHK011, CHK016, CHK030, CHK039, Visual CHK013 | `npm run lint:sync`; `npm run doctor:cache` | None for docs; source send still requires matching token. |
| `plugins/api-reviewers/skills/api-reviewers-delegation/SKILL.md`; `plugins/api-reviewers/skills/deepseek-adversarial-review/SKILL.md`; `plugins/api-reviewers/skills/deepseek-custom-review/SKILL.md`; `plugins/api-reviewers/skills/deepseek-review/SKILL.md`; `plugins/api-reviewers/skills/glm-adversarial-review/SKILL.md`; `plugins/api-reviewers/skills/glm-custom-review/SKILL.md`; `plugins/api-reviewers/skills/glm-review/SKILL.md` | T037, CHK011, CHK016, CHK030, CHK039, Visual CHK013 | `npm run lint:sync`; `npm run doctor:cache` | None for docs; direct API approval remains source-packet scoped. |
| `plugins/api-reviewers/scripts/api-reviewer.mjs`; `tests/smoke/api-reviewers.smoke.test.mjs` | T035, T039, T048, Visual CHK005, CHK006, CHK012, CHK015, CHK020, CHK025 | RED/GREEN visual lifecycle tests; focused T035 tuple test; `npm run smoke:api-reviewers` -> 134 passed | None. |
| `scripts/lib/companion-common.mjs`; `plugins/claude/scripts/lib/companion-common.mjs`; `plugins/gemini/scripts/lib/companion-common.mjs`; `plugins/kimi/scripts/lib/companion-common.mjs`; `tests/unit/companion-common.test.mjs` | T039, Visual CHK006, CHK015, CHK019, CHK023, CHK025 | `node --test tests/unit/companion-common.test.mjs` -> 17 passed; sync lint passed | `spawnSync` wrappers can still buffer output outside runtime. |
| `plugins/grok/scripts/grok-web-reviewer.mjs`; `tests/smoke/grok-web.smoke.test.mjs`; `tests/smoke/grok-session-sync.smoke.test.mjs` | T034, T039, T053, T058, T059, T060, T061, T062, T063, T064, T065, T066, T067, T068, Visual CHK004, CHK006, CHK015, CHK020, CHK021, CHK041, CHK042, CHK043, CHK044, CHK045, CHK046, CHK047, CHK048, CHK049, CHK050, CHK051 | `npm run smoke:grok` -> 138 passed; focused T058-T068 RED/GREEN tests passed; `npm run doctor:cache` -> `ok:true` after runtime sync | Legacy tunnel remains explicit fallback and can still fail when selected. |
| `plugins/grok/commands/grok-adversarial-review.md`; `plugins/grok/commands/grok-custom-review.md`; `plugins/grok/commands/grok-review.md`; `plugins/grok/commands/grok-setup.md`; `plugins/grok/skills/grok-adversarial-review/SKILL.md`; `plugins/grok/skills/grok-custom-review/SKILL.md`; `plugins/grok/skills/grok-delegation/SKILL.md`; `plugins/grok/skills/grok-review/SKILL.md`; `plugins/grok/skills/grok-setup/SKILL.md` | T034, T037, T053, CHK004, CHK005, CHK015, CHK026, CHK031 | `npm run smoke:grok`; `npm run lint:sync`; `npm run doctor:cache` | None for default path; explicit web path needs session repair approval when broken. |
| `plugins/claude/scripts/claude-companion.mjs`; `plugins/gemini/scripts/gemini-companion.mjs`; `plugins/kimi/scripts/kimi-companion.mjs` | T057, CHK008, CHK021, CHK029 | `npm run smoke:claude` -> 108 passed; `npm run smoke:gemini` -> 72 passed; `npm run smoke:kimi` -> 67 passed | Grok has no cancel command and is out of continuation-cancel scope. |
| `tests/smoke/claude-companion.smoke.test.mjs`; `tests/smoke/gemini-companion.smoke.test.mjs`; `tests/smoke/kimi-companion.smoke.test.mjs` | T057, CHK008, CHK021, CHK029, Visual CHK019 | Provider smokes above | None for Claude/Gemini/Kimi cancel fixtures. |
| `scripts/lib/review-panel.mjs`; `plugins/api-reviewers/scripts/lib/review-panel.mjs`; `plugins/claude/scripts/lib/review-panel.mjs`; `plugins/gemini/scripts/lib/review-panel.mjs`; `plugins/grok/scripts/lib/review-panel.mjs`; `plugins/kimi/scripts/lib/review-panel.mjs`; `tests/unit/review-panel.test.mjs` | T018, T021, Visual CHK010, CHK011, CHK020 | `node --test tests/unit/review-panel.test.mjs tests/unit/external-model-contracts.test.mjs tests/unit/companion-common.test.mjs` -> 51 passed; sync lint passed | Review panel remains explicit command, not automatic lifecycle. |
| `scripts/lib/external-model-contracts.mjs`; `tests/unit/external-model-contracts.test.mjs` | T037, T049, T053, Visual CHK013 | Unit test command above; `npm run lint:sync` | None. |
| `specs/140-no-mistakes-provider-readiness/spec.md`; `specs/140-no-mistakes-provider-readiness/plan.md`; `specs/140-no-mistakes-provider-readiness/research.md`; `specs/140-no-mistakes-provider-readiness/data-model.md`; `specs/140-no-mistakes-provider-readiness/quickstart.md`; `specs/140-no-mistakes-provider-readiness/checklists/visual-status.md`; `specs/140-no-mistakes-provider-readiness/checklists/task-clarity.md` | T038, T056, T058, T059, T060, T061, T062, T063, T064, T065, T066, T067, T068, Visual CHK001-CHK025, CHK041, CHK042, CHK043, CHK044, CHK045, CHK046, CHK047, CHK048, CHK049, CHK050, CHK051 | External V3 map review approved before implementation; latest dirty-diff review produced one Claude blocker now tracked by CHK041/CHK042; focused re-review residuals now tracked by CHK043-CHK051; `git diff --check` passed | None for known root-cause map. |
| `specs/140-no-mistakes-provider-readiness/tasks.md`; `specs/140-no-mistakes-provider-readiness/evidence-ledger-2026-05-18.md` | T045, T058, T059, T060, T061, T062, T063, T064, T065, T066, T067, T068, T040-T046 | `git diff --check`; all verification commands listed above; T046 audit found no unapproved push, merge, issue closure, browser/session repair, destructive cleanup, or direct API source send | Standing process rule remains: future push/merge/mutation/source-bearing direct API needs explicit approval. |

## 100 Percent Confidence Gate

This table supersedes any prior broad completion language. Implementation must not start on a residual until its symptom, root cause, reproduction surface, and acceptance gate are fully evidenced or explicitly waived by the operator.

| Symptom ID | Confidence | Evidence | Gap before implementation |
|---|---:|---|---|
| S01 default auth confusion | 100% for current docs/runtime audit only | Generated command/skill audit found no default `--auth-mode auto`; Claude/Gemini defaults are subscription; explicit auto fallback is covered by focused smoke tests. | Add persistent regression guard in T081. |
| S02 direct API approval friction | Not 100% | Approval token tests prove changed provider, prompt, source path, source bytes, and timeout are rejected before source send. | Need UX proof that same approved tuple does not re-prompt while still producing per-run approval artifact and matching token. |
| S03 prompt cap failure | Problem-definition-only 100%, not fixed | DeepSeek/GLM dogfood full packets failed pre-send around provider cap; API smoke covers `prompt_too_large` and no source send. | Need T069 auto-shard/narrowing behavior before calling problem fixed. |
| S04 result lookup/cwd failure | 100% for tested aliases/workspaces only | Result command aliases and wrong-workspace diagnostics are covered by provider smoke tests; dogfood showed `--cwd` was required for Claude/Gemini result fetch. | T084 must re-audit Grok and direct API result aliases before final completion. |
| S05 missing verdict/bad verdict | Problem-definition-only 100%, partial fix | Kimi replay test proves substantive missing-verdict prose becomes failed `review_not_completed`; review-quality parser tests cover missing verdict and `NOT_REVIEWED` semantics. | Need all-provider rescue/retry behavior and current live proof for Kimi/Gemini/GLM. |
| S06 Grok CLI runtime failures | 100% for non-auth CLI path only | Dogfood reproduced sandbox `FS_PERMISSION_DENIED`; wrapper uses private temp `GROK_HOME`; Grok smoke and earlier real source-bearing CLI jobs proved the non-auth CLI path. | Current auth/session expiry is split into S20 and blocks any full-confidence claim. |
| S07 Grok tunnel reliability | Not 100% | Smoke tests prove `tunnel_unavailable`, runtime-status unavailable, and explicit web diagnostics; dogfood saw tunnel unavailable before source send. | Need T070 live/fixture end-to-end for explicit web/tunnel readiness and repair diagnostics. |
| S08 stale doctor proof | Not 100% | Quickstart and ledger require immediate pre-send proof; CLI path has current proof. | Need per-provider tests proving stale setup/doctor cannot authorize later source send. |
| S09 same-path repair ambiguity | Not 100% | Policy is documented; direct API approval tuple proof exists; Grok repair requires approval before browser/session sync. | Need end-to-end UX proof across API and subscription repair paths. |
| S10 prompt/source privacy | Not 100% | Grok CLI sidecar/temp-home cleanup has RED/GREEN proof; prompt cap tests assert source bodies and secrets are not persisted. | Need same privacy proof across Claude/Gemini/Kimi/API paths and interrupted runs. |
| S11 installed cache drift | 100% current proof only | `npm run doctor:cache` caught stale cache, then passed after sync; source/cache SHA audit matched. | Re-audit before final completion. |
| S12 Claude OAuth/401 | Problem-definition-only 100%, not live-fixed | Claude smoke tests classify `oauth_inference_rejected` with source `not_sent`; dogfood saw 401 before source send. | Need current live readiness proof or accepted classification that auth repair is external/operator action. |
| S13 DeepSeek/GLM outage/rate/token | Problem-definition-only 100%, not live-fixed | API failure classes exist; direct API approval and prompt cap tests prove pre-send paths. | Need current live provider failure classification evidence for outage/rate/token cases, or accepted external-provider residual. |
| S14 visual status infrequent | 100% root cause for runtime gap, partial overall | RED proof showed raw `external_review_progress` JSONL in markdown mode; runtime renderers now emit cards; ledger notes `spawnSync` wrappers can still buffer child output. | Need T071 wrapper-level streaming proof if "always visually explicit" includes one-off wrapper commands. |
| S15 cancel/stuck ambiguity | 100% for Claude/Gemini/Kimi synthetic scope | Claude/Gemini/Kimi smoke tests cover running, queued, pre-spawn, SIGTERM, unverifiable process, and cancelled continuation states. | Re-audit before final completion; Grok has no cancel command. |
| S16 latest dirty diff all-model review | Not 100% | Latest Claude approved; Grok full attempt failed pre-send due cap; split Grok shards approved. | Need T074 full current-head review with Claude, Gemini, Kimi, DeepSeek, GLM, and Grok sharded when capped. |
| S17 Grok web session repair | Not 100% | Code requires explicit approval before browser/session sync; smoke covers approval-required branch. | Need T070 end-to-end repair diagnostics and accepted boundary for local provider-state mutation. |
| S18 interrupted/concurrent jobs | Not 100% | Root failure class lists interrupted source transmission, cross-conversation resume, state-root collision, lock timeout masking corruption, and concurrent scope modification. | Need T076 RED/GREEN runtime/state tests or explicit operator waiver. |
| S19 lifecycle-vs-verdict confusion | Not 100% | Lifecycle cards now render, but lifecycle status is not a persisted review verdict and can be overread. | Need T077 proof that completed lifecycle cannot count as approval without result quality/panel verdict. |
| S20 Grok CLI auth/session expiry | 100% complete | Dogfood `job_4efe8b81-b282-4c7e-a0d5-3d383ea9b6ce` reproduced the old failure. T085 RED/GREEN proves `logged_in:false` and source-free auth timeout fail before source send with CLI repair guidance and no fallback. Before login, live doctor reported `logged_in:false`, `model_ready:true`, `grok_cli_login_required`, source-free skipped. After operator `grok login`, live doctor reported `logged_in:true`, `model_ready:true`, `source_free_prompt.status:"ready"`, cleanup `deleted`; Grok source-bearing self-review `job_61d1224e-8191-47ec-94bf-5ae7ad119589` sent source and returned `APPROVE`. | None for T085. |
| S21 provider runtime budget exhaustion | Problem-definition-only 100%, not fixed | Kimi T081 design-review job `f6cbbe7c-7cd9-431a-875a-303605ad896f` sent 8 scoped files, then failed with `error_code:"step_limit_exceeded"`, `error_message:"Max number of steps reached: 12"`, `failed_review_slot:true`, no verdict, and `source_content_transmission:"sent"`. Source inspection shows existing Kimi sentinel parsing and actionable JobRecord tests already cover the Kimi parser path. | Need T086 closure tests proving budget exhaustion keeps source-send truth, cannot count as approval, gives deterministic retry/narrowing guidance, and never auto-resends source without valid current approval. Need companion timeout and API provider budget/timeout parity. |
| S22 Kimi review-only source mutation | Problem-definition-only 100%, not fixed | Kimi T081 retry job `c649f141-62cc-4ddb-9e97-a51110c3cdcc` source sent, then failed `review_not_completed:missing_verdict` and reported mutations: `M package.json`, `M tests/unit/ci-workflow.test.mjs`, `?? scripts/ci/check-default-auth.mjs`, `?? tests/unit/default-auth-regression.test.mjs`. Local `git status` confirmed those files exist/changed. Source inspection shows review profiles define `disallowed_tools`, but `buildKimiArgs` only passes `--plan`, `--add-dir`, and not any supported read-only agent constraint. Local `kimi --help` shows no `--disallowedTools` flag; official Kimi docs say `--print` implicitly enables AFK auto-approval and custom agents can define/exclude tools via `--agent-file`. | Need T087 RED/GREEN proof that review modes use a supported Kimi read-only agent mechanism and that mutation detection remains a failed-slot safety net. Existing T081 implementation files are untrusted until reviewed/accepted. |
| S23 Claude permission-blocked/stuck review slots | Problem-definition-only from operator evidence, not fixed | Operator reported a Claude review slot that produced `APPROVE` prose but failed plugin audit due permission-blocked live-worktree reads, plus another Claude slot that stuck and was terminated after the stuck process was verified. Source inspection shows the review audit classifier already marks concrete permission failures as `permission_blocked`, review-panel states distinguish timeouts, and Claude smoke tests cover timeout/cancel paths. | Need current job-record evidence for this exact failure class, then T076/T077/T079 coverage proving source-send truth, failed-slot audit semantics, and stuck/terminated process classification. Prose `APPROVE` cannot count without persisted quality passing. |

Current implementation gate: per-task. No residual implementation starts until that symptom has 100% problem-definition confidence, RED test design, and external review. A task stays open until its live/operator gate is satisfied or explicitly waived.

## Problem Map External Review 2026-05-19

Reviewed files:
- `specs/140-no-mistakes-provider-readiness/tasks.md`
- `specs/140-no-mistakes-provider-readiness/evidence-ledger-2026-05-18.md`
- `specs/140-no-mistakes-provider-readiness/quickstart.md`

| Provider | Job | Source | Verdict | Action taken |
|---|---|---|---|---|
| Claude | `8cb3566b-9724-488f-919a-f25a7885a8f5` | sent | `REQUEST_CHANGES` | Added S18/S19; split T075 into T075-T084; downgraded overclaims; added waiver/default-auth/quickstart drift tasks. |
| Gemini | `c1e39abb-c0bf-40b2-9ec8-ed934c0e07f0` | sent | `APPROVE` | Accepted nonblocking split of overloaded T075 through T075-T084. |
| Kimi | `3760f726-bc2b-4ce0-96e4-cd1ad290c495` | sent | `APPROVE` | Added shard approval tuple text to T069 and no-auto-retransmission text to T072. |
| DeepSeek | `job_35799dba-bff8-4c53-aa56-e9ab12d538a4` | sent | `APPROVE` | Added explicit tasks for S08/S10/S12/S13 instead of catch-all audit. |
| GLM | `job_2b74ce00-c7ce-47a0-b5c4-726c8d97b7a2` | sent | `APPROVE` | Added S18 for interrupted/concurrent job-state failures. Rejected per-task implementation gate suggestion because operator requires full end-to-end 100% before implementation. |

Focused re-review after checklist fixes:

| Provider | Job | Source | Verdict | Result |
|---|---|---|---|---|
| Claude | `77ae5f2b-9193-47db-bb51-e4259397026a` | sent | `APPROVE` | Nonblocking: align confidence wording, make T079/T080 depend on waiver format, restate direct-API approval on T074, keep quickstart tuple text synced. |
| Gemini | `89686e56-7c1c-47b4-804d-871821a03036` | sent | `APPROVE` | No blockers. |
| Kimi | `f4ed7ac6-b4cc-43e5-9c86-3660f12561ea` | sent | `APPROVE` | No blockers; confirmed many symptoms remain intentionally not 100%. |
| GLM | `job_0e461914-c61e-42c4-a337-b8ff8082415c` | sent | `APPROVE` | No blockers; nonblocking standardize confidence terms and add waiver template. |
| DeepSeek | `job_f371f791-60b4-4704-8583-4724dc25b086` | sent | failed slot | Official result failed `review_not_completed` due shallow output; not counted. |
| DeepSeek retry | `job_f72558a2-2f4f-4504-a534-e2daa3b6bd7e` | sent | `APPROVE` | No blockers; `review_quality.failed_review_slot:false`; `http_status:200`; `raw_model:"deepseek-v4-pro"`. |
| Grok CLI | `job_4efe8b81-b282-4c7e-a0d5-3d383ea9b6ce` | not_sent | failed pre-send | `grok_cli_failed`; `logged_in:false`; `model_ready:true`; default-browser OSStatus `-10661`; auth timed out after 10 minutes. Added S20/T085. |

Remaining status after review: implementation gate still closed. No code implementation is authorized until the updated S01-S20 problem map has 100% problem-definition confidence, accepted waivers, and matching current-head external review evidence.

Final delta re-review after nonblocking cleanup:

| Provider | Job | Source | Verdict | Result |
|---|---|---|---|---|
| Claude | `275602eb-8c89-4e82-ada6-e971cf1e95b6` | sent | `APPROVE` | No blockers; confirmed S01/T081, S04/T084, S06/S20/T085, T079/T080/T082, Grok auth-expiry quickstart text, failed-slot retry rule, and closed implementation gate. Nonblocking: repeat T034 non-auth qualifier on the task line if desired. |
| Gemini | `b1143660-ac01-432c-b081-9d1949b7ac99` | sent | `APPROVE` | No blockers, no nonblocking concerns, no missing symptoms, no overclaimed confidence. |
| Kimi | `649c6fb7-b884-4bd1-99bc-b6996022c8f2` | sent | `APPROVE` | No blockers; confirmed S20/T085 is visible enough and implementation gate remains closed. Nonblocking: cross-reference S06/S20 in the confidence gate if desired. |
| DeepSeek | `job_c621a851-b082-4169-81e7-039e03aff394` | sent | `APPROVE` | Clean retry after prior shallow slot; no blockers, no nonblocking concerns, no missing symptoms, no overclaimed confidence. |
| GLM | `job_9cf0c1b9-9782-4742-a0e9-6e8551ad8cb4` | sent | `APPROVE` | No blockers; confirmed all 20 symptoms have rows and T069-T085 tasks. Nonblocking: list T074->T085 in dependencies if desired. |
| Grok CLI | `job_4efe8b81-b282-4c7e-a0d5-3d383ea9b6ce` | not_sent | failed pre-send | Not retried because S20/T085 now requires current CLI auth/session readiness before source send. |

Current decision: problem-definition map is externally accepted by Claude, Gemini, Kimi, DeepSeek, and GLM. Implementation gate remains closed for code because S02/S03/S05/S07/S08/S09/S10/S12/S13/S14/S16/S17/S18/S19/S20 still require RED/GREEN proof, live evidence, or explicit waiver before any fix can be marked complete.

## T085 Grok CLI Auth/Session Readiness Implementation 2026-05-19

Changed files:
- `plugins/grok/scripts/grok-web-reviewer.mjs`
- `tests/smoke/grok-web.smoke.test.mjs`

Behavior fixed:
- `grok models` exit 0 with `model_ready:true` and `logged_in:false` now fails closed as `grok_cli_login_required` before source send.
- Source-free CLI auth/default-browser timeout now fails closed as `grok_cli_auth_timeout` with `source_content_transmission:not_sent`.
- Default CLI path does not silently fall back to web/tunnel/API.
- Explicit `--transport web` remains explicit and unaffected by CLI auth state.
- `repair` returns `cli_auth_required` for CLI auth failures, does not run browser/session sync, and labels CLI ready/non-auth failures as provider `grok`.
- Removed two source-text structural smoke tests and kept observable behavior tests.

Verification:
- Initial focused RED: 6/7 failed before production fix.
- Post-fix focused GREEN: `node --test --test-name-pattern "Grok CLI model is ready but login is false|Grok CLI unauthenticated|Grok CLI auth timeout|explicit web transport ignores unauthenticated|login-required as actionable|ready Grok CLI state|non-auth Grok CLI failures|login-required from models command failure" tests/smoke/grok-web.smoke.test.mjs` -> 9 passed.
- Full Grok smoke: `npm run smoke:grok` -> 145 passed.
- `git diff --check` -> passed.
- Live source-free doctor: `node plugins/grok/scripts/grok-web-reviewer.mjs doctor` -> provider `grok`, `ready:false`, `grok_version:"grok 0.1.211 (2f2cd6d5c2)"`, `default_model:"grok-build"`, `logged_in:false`, `model_ready:true`, `error_code:"grok_cli_login_required"`, `readiness_layers.source_free_prompt.status:"skipped"`.

Final post-fix external review:

| Provider | Job | Source | Verdict | Result |
|---|---|---|---|---|
| Claude | `2e98ecca-79b6-41fb-b88e-13533fe6e7bf` | sent | `APPROVE` | No blockers. |
| Gemini | `205f6f13-f233-4829-bd96-47e3a223c8f6` | sent | `APPROVE` | No blockers. Nonblocking: action text names default model `grok-build`; safe but could say configured model. |
| Kimi | `fa05a309-1e4a-4bfd-a133-86dae4b4f214` | sent | `APPROVE` | No blockers. Nonblocking: CLI output format drift would fail closed but may confuse already logged-in users. |
| DeepSeek | `job_2cc0677c-8695-4ec6-b2e8-6cbd249327ee` | sent | `APPROVE` | No blockers. |
| GLM | `job_98b5654c-fd0e-439f-85f2-4c6ea3d1d623` | sent | `APPROVE` | No blockers. |

Grok post-login closure:

| Provider | Job | Source | Verdict | Result |
|---|---|---|---|---|
| Grok CLI | `job_61d1224e-8191-47ec-94bf-5ae7ad119589` | sent | `APPROVE` | Source-bearing self-review after operator `grok login`; `review_quality.failed_review_slot:false`; `runtime_diagnostics.cli_request.logged_in:true`; `model_ready:true`; prompt/runtime cleanup `deleted`; no hidden fallback to web/API. |

T085 status: complete.

## S21 Kimi Runtime Budget Exhaustion Evidence 2026-05-19

Dogfood trigger: T081 default-auth RED-design review with Kimi.

| Provider | Job | Source | Status | Evidence |
|---|---|---|---|---|
| Kimi | `f6cbbe7c-7cd9-431a-875a-303605ad896f` | sent | failed slot | `error_code:"step_limit_exceeded"`; `error_message:"Max number of steps reached: 12"`; `error_summary:"Kimi Code CLI exhausted its configured step limit before returning a review result."`; `review_quality.failed_review_slot:true`; `has_verdict:false`; suggested action: retry with higher `--max-steps-per-turn` or narrower scope. |

Source-level evidence:
- `plugins/kimi/scripts/lib/kimi.mjs` parses `Max number of steps reached: N` as `reason:"step_limit_exceeded"`.
- `plugins/kimi/scripts/lib/job-record.mjs` maps that parsed reason to `status:"failed"`, `error_code:"step_limit_exceeded"`, and retry/narrowing guidance.
- `tests/smoke/kimi-companion.smoke.test.mjs` and `tests/unit/job-record.test.mjs` already cover Kimi step-limit parsing and actionable JobRecord output.

Current decision: S21 is now in scope as T086. It is not fixed because existing Kimi coverage does not close the whole provider-runtime-budget class: source-send truth, no approval counting, no automatic source resend, companion wall-clock timeout parity, and API provider budget/timeout parity still need RED/GREEN proof. The failed Kimi job must not count as approval, but raw JobRecord evidence is valid for defining the failure class. Any retry after source was already sent must use a still-valid explicit approval tuple or a fresh matching approval, and must record the new job id separately.

## S22 Kimi Review-Only Mutation Evidence 2026-05-19

Dogfood trigger: Kimi retry of T081 default-auth RED-design review.

| Provider | Job | Source | Status | Evidence |
|---|---|---|---|---|
| Kimi | `c649f141-62cc-4ddb-9e97-a51110c3cdcc` | sent | failed slot | `error_code:"review_not_completed"`; `error_message:"review_quality_failed:missing_verdict"`; `review_quality.failed_review_slot:true`; `mutations:[" M package.json"," M tests/unit/ci-workflow.test.mjs","?? scripts/ci/check-default-auth.mjs","?? tests/unit/default-auth-regression.test.mjs"]`; raw output claimed implementation instead of review. |

Source-level evidence:
- `plugins/kimi/scripts/lib/mode-profiles.mjs` declares review-mode `disallowed_tools` including `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `WebFetch`, `Agent`, `Task`, and `mcp__*`.
- `plugins/kimi/scripts/lib/kimi.mjs` `buildKimiArgs` currently passes `--print`, `--plan`, and `--add-dir`, but does not pass any supported read-only agent file or tool-exclusion config to the Kimi CLI.
- Local `kimi --help` has `--agent-file`, `--plan`, and `--print`, but no `--disallowedTools` or equivalent CLI flag. Help text says `--print` auto-approves tool calls for the invocation.
- Installed Kimi source applies `agent_spec.allowed_tools` as an allowlist before loading built-in tools, then applies `exclude_tools` only to that built-in list; plugin and MCP tools are loaded afterward.
- Installed built-in Kimi agent YAMLs use fully qualified tool paths such as `kimi_cli.tools.file:ReadFile`, `kimi_cli.tools.file:Glob`, `kimi_cli.tools.file:Grep`, `kimi_cli.tools.file:WriteFile`, `kimi_cli.tools.file:StrReplaceFile`, `kimi_cli.tools.shell:Shell`, `kimi_cli.tools.agent:Agent`, `kimi_cli.tools.plan:ExitPlanMode`, and `kimi_cli.tools.plan.enter:EnterPlanMode`.
- Mutation detection caught the file changes after the run, but did not prevent source-workspace edits.

T087 v1 design review:

| Provider | Job | Source | Verdict | Blocking finding |
|---|---|---|---|---|
| Claude | `96e5d11d-7ea2-4b71-9717-b11a90d8af22` | sent | `REQUEST_CHANGES` | Need empirical proof that Kimi honors `--agent-file` restrictions under `--print`; short tool names and `--plan` are insufficient; missing/malformed/rejected agent files must fail closed before source send; mutation detection must remain a hard failed-slot safety net. |
| Gemini | `310823eb-c5ee-43a2-87ef-61b49cbea738` | sent | `APPROVE` | Caveats: align to Kimi-native tool names, account for MCP/plugin tools, and define agent-file lifecycle. |
| Kimi | `ead84f2f-5b75-4d71-becc-4676f253624f` | sent | `REQUEST_CHANGES` | Use fully qualified `allowed_tools`, not `exclude_tools`; omit `ExitPlanMode` because `--print` can auto-approve leaving plan mode; `exclude_tools` does not filter plugin/MCP tools loaded afterward. |
| DeepSeek | `job_00cd74a0-090f-43be-88af-a087c3971b13` | sent | `REQUEST_CHANGES` | Mutation detection alone is damage assessment, not prevention; must add hard tool restrictions. |
| GLM | `job_86867bea-0e42-4f9b-aa9a-8754b2947802` | sent | `REQUEST_CHANGES` | `disallowed_tools` is dead data unless mapped to a supported Kimi mechanism; `--plan` alone is insufficient. |

T087 v2 design review:

| Provider | Job | Source | Verdict | Blocking finding |
|---|---|---|---|---|
| Claude | `abe13574-8598-4949-85f3-e8636651680f` | sent | `REQUEST_CHANGES` | Plugin/MCP tools still bypass the read-only allowlist unless Kimi config/home or plugin/MCP discovery is neutralized; ping exclusion is not justified; one sentinel mutation probe is too narrow; mutation detection must become hard failed-slot if it fires. |
| Gemini | `e3e4f7a3-c7d4-483d-9d65-b5fce672abe5` | sent | `APPROVE` | Nonblocking concern: global MCP/plugin leakage may require sterile Kimi config dir or empty MCP config. |
| Kimi | `038c6e54-98e8-485a-8b3c-6878a9407961` | sent | `REQUEST_CHANGES` | Plugin/MCP loading likely bypasses the built-in allowlist; empirical mutation proof must precede implementation; `--plan` interaction with `--print --agent-file` is unspecified. |
| DeepSeek | `job_2837a29d-52fd-4c28-8cf3-7c4d14f5e88e` | sent | `APPROVE` | Nonblocking: prove `--plan` harmless or drop it; failed mutation detection should mark failed slot. |
| GLM | `job_3c1e393b-13e9-487e-94a8-8c82d5f5f4f9` | sent | `REQUEST_CHANGES` | Agent-file silent fallback is unspecified; MCP/plugin bypass not empirically covered; `--plan --agent-file` interaction unresolved. |

Current decision: S22 blocks trusting Kimi review-only runs as non-mutating until T087 is fixed or waived. T087 v1 and v2 are rejected. T087 v3 must name the concrete sterile Kimi config/home or plugin/MCP-disable mechanism, include a real pre-implementation `--print --agent-file` mutation-attempt proof covering built-in write, shell, subagent/plan, plugin, and MCP vectors, fail closed before source send if the agent file cannot be created/validated or Kimi silently ignores it, drop `--plan` unless proven safe, include ping or prove ping cannot mutate state, and keep post-run mutation detection as a hard failed-slot safety net. The T081 files created by the failed Kimi slot are treated as untrusted implementation artifacts; they are not proof of T081 completion.

## S23 Claude Permission-Blocked And Stuck Slot Evidence 2026-05-19

Dogfood trigger: operator report from bolt-v2 PR `#398` and claude-config PR `#794` review quorum.

Reported symptoms:
- Claude review slot produced `APPROVE` text but failed plugin audit due permission-blocked live-worktree reads.
- Another Claude review slot got stuck and was terminated after the stuck process was verified.
- The reported quorum excluded Claude and relied on Gemini/GLM/DeepSeek approvals.

Source-level evidence:
- `scripts/lib/review-prompt.mjs` marks concrete permission failure lines as `permission_blocked`.
- `scripts/lib/review-panel.mjs` has distinct timeout/source-sent states; `tests/unit/review-panel.test.mjs` covers `source_sent_timeout`.
- `tests/smoke/claude-companion.smoke.test.mjs` covers timeout, SIGTERM-trapping cancel, cancelled continuation, and `oauth_inference_rejected` paths.

Current decision: S23 is in scope but not fixed. Existing classifiers/tests prove partial coverage only. Need the exact current Claude job records or a reproduced fixture showing permission-blocked live-worktree read after source send and stuck/terminated process classification. T076 owns interrupted/stuck state truth, T077 owns lifecycle/prose-verdict versus persisted audit truth, and T079 owns current Claude auth/readiness proof.
