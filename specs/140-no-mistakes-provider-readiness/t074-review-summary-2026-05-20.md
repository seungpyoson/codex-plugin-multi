# T074 Review Evidence

Status: complete for current source-reviewed implementation. T074 and T084 are checked; no canonical spec-140 task remains open.

## 2026-05-22 Current Re-Anchor

This file preserves the Historical 2026-05-20 sharded run below, but current completion is based on the later R3/R4 follow-up reviews, source-free readiness checks, and local gates recorded here.

Current repo shape:

- `git diff --stat`: 138 tracked diff files, 16227 insertions, 2013 deletions.
- `git status --short`: 191 `git status --short` entries.
- `git ls-files --others --exclude-standard`: 54 untracked files.
- Canonical open tasks: none.

Current source-free readiness:

- Claude subscription doctor returned `ready:true`, `selected_route:"subscription_oauth"`, ignored `ANTHROPIC_API_KEY`, and source was not sent.
- Gemini subscription doctor returned `ready:true`, `selected_route:"subscription_oauth"`, ignored `GEMINI_API_KEY`, and source was not sent.
- Grok default CLI doctor returned `ready:false`, `auth_mode:"subscription_cli"`, `error_code:"grok_cli_login_required"`, ignored `XAI_API_KEY`, and source was not sent.
- Grok explicit web doctor returned `ready:true`, `auth_mode:"subscription_web"`, HTTP `200`, chat HTTP `200`, and source was not sent.
- DeepSeek direct API doctor returned `ready:true`, `credential_ref:"DEEPSEEK_API_KEY"`, HTTP `200`, and source was not sent.
- GLM direct API doctor returned `ready:true`, canonical `credential_ref:"ZAI_API_KEY"`, HTTP `200`, and source was not sent.
- Kimi source-free doctor returned `status:"transient_timeout"`, `ready:false`, `selected_route:"subscription_oauth"`, ignored `KIMI_CODE_API_KEY` and `MOONSHOT_API_KEY`, and source was not sent; Kimi remains skipped per operator instruction when it does not work.

Current follow-up review closure:

- R3 current follow-up covered 11 files / 533326 bytes / 14204 lines. Gemini `953a8f29-70d6-41e4-b1d9-d72aefb28ab0` returned `APPROVE`, `source_content_transmission:"sent"`, `review_quality.failed_review_slot:false`. GLM `job_cd68826c-f8ac-4cb5-bea6-9af1a63b5283` returned `APPROVE`, `source_content_transmission:"sent"`, `review_quality.failed_review_slot:false`. DeepSeek `job_458fe967-eab4-4520-86ae-d8993524bcc4` returned approve prose but was failed by the audit as `review_not_completed` / `semantic_failure_reasons:["not_reviewed"]`; local RED/GREEN review-quality work proved this was a false positive caused by an out-of-scope fixture caveat and fixed the classifier.
- R4 review-quality follow-up covered 7 files / 361249 bytes / 10064 lines. Gemini `3b86fa40-23d3-435b-ae2e-70cde04c4e8b`, Grok web `job_a476718e-a139-4ca2-bb74-730cec65845d`, DeepSeek `job_e7f193c5-4dd1-4f1f-9f99-3a7365bbd4a0`, GLM `job_225ff36e-a2e9-4b62-a69c-b754dc8b737b`, and Claude explicit API `debc5d27-93b4-4288-aaff-72229d10b09b` all returned `APPROVE`, `source_content_transmission:"sent"`, and `review_quality.failed_review_slot:false`.
- R5 closure-doc follow-up covered the 4 edited closure files / 206772 bytes / 1476 lines. Claude explicit API `7b4b4f01-5066-4f30-aa51-a6895ec22eb9`, Gemini `8668a51a-8ae2-41e6-96f1-039f7a26e2c5`, Grok web `job_6e66339a-3ec3-42d1-a09b-db0b9f65a97c`, DeepSeek recheck `job_65d9a0c5-886d-419d-b8b2-fa228ee2f16e`, and GLM `job_114b05d7-a6f2-497b-bfec-b8e0ea7e6fbc` returned `APPROVE`, `source_content_transmission:"sent"`, and `review_quality.failed_review_slot:false`. The initial DeepSeek R5 job `job_1a8779ab-3451-41e2-94c2-e89b432dc109` returned `REQUEST_CHANGES` based on a misread S26 assertion; the recheck explicitly verified that the `shared failure catalog` assertion targets S24, not S26.
- Direct API and Claude API terminal audit manifests record `source_send_approval_required:true`, `source_send_approval_state:"approved"`, `approval_scope:"session"`, and the selected direct API route. Grok used explicit `--transport web`; no default CLI-to-web fallback was used.
- Local verification after this closure passed `node --test --test-name-pattern "concurrent Grok runs preserve every completed job in the state index" tests/smoke/grok-web.smoke.test.mjs`, then full `npm test` passed 2032 tests with 2026 pass, 6 skipped, and 0 failures.
- S11 installed-cache closure was verified on 2026-05-23 after explicit cache-sync approval. `npm run doctor:cache` returned `ok:true`; all five plugins reported `cache_in_sync:true` and `repo_cache_in_sync:true` with no missing, extra, or changed repo-cache files. Installed-cache source-free probes from `/private/tmp` then verified `~/.codex/plugins/cache/relay/api-reviewers/0.1.0/bin/api-reviewer --help`, DeepSeek doctor HTTP `200`, and GLM doctor HTTP `200`; both provider doctors reported `source_content_transmission:"not_sent"`, and GLM used the single canonical `credential_ref:"ZAI_API_KEY"`.

## Historical 2026-05-20 Sharded Run

Source approval: operator approved T074 source send for 14 shards to Claude, Gemini, Kimi, Grok, DeepSeek, and GLM.
Shard manifest: `/private/tmp/cpm-t074-review/shards.json`. Direct API approval requests: `/private/tmp/cpm-t074-review/approval-requests.json`.

## Provider Summary

| Provider | Shards with records | Completed approvals | Request changes | Failed slots / failed runs | Source states |
|---|---:|---:|---:|---:|---|
| deepseek | 14 | 13 | 1 | 0 | sent |
| glm | 14 | 14 | 0 | 0 | sent |
| claude | 14 | 2 | 0 | 12 | sent, not_sent |
| gemini | 14 | 14 | 0 | 0 | sent |
| grok | 14 | 14 | 0 | 0 | sent |
| kimi | 2 | 1 | 0 | 1 | sent |

## Blocking Evidence

- DeepSeek shard 7 (`gemini-runtime-docs`) returned `REQUEST_CHANGES`, job `job_96ef19ac-51ac-4b4b-8a32-be91e83b9b74`, source `sent`: claims Gemini readiness/preflight timeout or parse failures can be misclassified as source `sent` even when the review target never launched. Local adjudication below disproves this on current code; no runtime change made for this finding.
- Claude shard 3 failed after source `sent`, job `248ae0eb-9ff8-4ed7-b09b-46ab4a9a4593`, error `oauth_inference_rejected`: `401 Invalid authentication credentials`. Claude shards 4-14 failed pre-send `not_sent` with the same error.
- Kimi shard 2 failed after source `sent`, job `6ee5863e-8e44-456e-9c11-46e2c1963542`, error `timeout`: `target CLI exceeded the configured timeoutMs`. Remaining Kimi shards were intentionally stopped after this failed source-bearing slot.

## Local Adjudication Probes

- DeepSeek shard 7 preflight-parse claim is not reproduced on current code. A synthetic Gemini readiness preflight with unparseable output emitted one terminal record with `error_code:"spawn_failed"`, `source_content_transmission:"not_sent"`, `pid_info:null`, and no selected-source sentinel leak.
- DeepSeek shard 7 preflight-timeout claim is not reproduced on current code. `geminiReadinessPreflight()` always returns a non-empty `errorMessage` for failed preflight records before `executeRun()` calls `buildJobRecord()`. `classifyCompanionExecution()` classifies that preflight `errorMessage` before the generic `timedOut` branch, so `buildJobRecord()` returns `error_code:"spawn_failed"` and `source_content_transmission:"not_sent"` for the actual preflight timeout shape. Direct proof command: `node --input-type=module -e 'import { buildJobRecord } from "./plugins/gemini/scripts/lib/job-record.mjs"; ...'` returned `{"status":"failed","error_code":"spawn_failed","source_content_transmission":"not_sent"}`.
- Refreshed source-free Claude ping still fails with `status:"oauth_inference_rejected"`, `ready:false`, OAuth login present, `auth_method:"oauth"`, `subscription_type:"subscription"`, and `detail:"Failed to authenticate. API Error: 401 Invalid authentication credentials"`. Required operator action: refresh Claude OAuth with `claude auth login` in a normal terminal, then prove non-interactive `claude -p` inference works before retrying source-bearing T074 Claude shards.
- Refreshed source-free Kimi ping passed with `status:"ok"`, `ready:true`, first-party CLI auth, and session `637847e0-12d6-4b55-a3e7-e15b1c14a7fe`; the T074 Kimi blocker remains source-bearing review timeout, not basic auth readiness.

## Completed Review Records

| Provider | Shard | Name | Job | Source | Status | Verdict | Failed slot |
|---|---:|---|---|---|---|---|---|
| deepseek | 1 | api-runtime-docs | job_ddb4cb25-0625-4d04-85d5-800a1efc02d8 | sent | completed | APPROVE | false |
| deepseek | 2 | api-tests | job_3803874c-e61c-4617-a6e7-f403e01d1c68 | sent | completed | APPROVE | false |
| deepseek | 3 | grok-runtime-docs | job_8b28b2d1-a4d9-43f5-b96b-feb66089800e | sent | completed | APPROVE | false |
| deepseek | 4 | grok-tests | job_2954e519-eca2-438a-aeac-7a649f5d8304 | sent | completed | APPROVE | false |
| deepseek | 5 | claude-runtime-docs | job_c05f8041-e12d-4c53-aa7a-55c5d0b0ba25 | sent | completed | APPROVE | false |
| deepseek | 6 | claude-tests | job_edf2e277-991f-4e2b-927e-134c435372d0 | sent | completed | APPROVE | false |
| deepseek | 7 | gemini-runtime-docs | job_96ef19ac-51ac-4b4b-8a32-be91e83b9b74 | sent | completed | REQUEST_CHANGES | false |
| deepseek | 8 | gemini-tests | job_2057689b-db5e-47ba-99b0-1214781f6130 | sent | completed | APPROVE | false |
| deepseek | 9 | kimi-runtime-docs | job_449facfb-7b71-4790-8a34-4d030d1a6f58 | sent | completed | APPROVE | false |
| deepseek | 10 | kimi-tests | job_0c4170d6-002f-40e1-8e44-22b8bef893d8 | sent | completed | APPROVE | false |
| deepseek | 11 | shared-runtime-ci | job_e46242c8-12eb-44ee-bddc-095aa0ef6a71 | sent | completed | APPROVE | false |
| deepseek | 12 | shared-tests-a | job_da44cad9-30b1-4ccc-83c5-95b082537df0 | sent | completed | APPROVE | false |
| deepseek | 13 | shared-tests-b | job_7c1546e1-1339-4698-a584-41d470e7b861 | sent | completed | APPROVE | false |
| deepseek | 14 | specs-contracts-evidence | job_5a373f14-81bd-4361-9a4e-95b29179efea | sent | completed | APPROVE | false |
| glm | 1 | api-runtime-docs | job_6d3741d1-3bda-4157-8857-ca0c7fd6b2ca | sent | completed | APPROVE | false |
| glm | 2 | api-tests | job_a87d8b12-56ca-468f-896a-a7f267b49234 | sent | completed | APPROVE | false |
| glm | 3 | grok-runtime-docs | job_a4f3f9c0-2146-4210-88cc-a9a2985ea00d | sent | completed | APPROVE | false |
| glm | 4 | grok-tests | job_59d9da11-e96c-441e-8d88-651f015a84e7 | sent | completed | APPROVE | false |
| glm | 5 | claude-runtime-docs | job_801e410a-6e5b-46fa-9e98-8eb61a3ca144 | sent | completed | APPROVE | false |
| glm | 6 | claude-tests | job_c95d0198-cb35-43c9-99d3-59b2243356e5 | sent | completed | APPROVE | false |
| glm | 7 | gemini-runtime-docs | job_d0f19ea5-271f-4de4-9a62-d1bd54fc447e | sent | completed | APPROVE | false |
| glm | 8 | gemini-tests | job_2177d82d-8532-43a5-b304-ebcf8521b3b4 | sent | completed | APPROVE | false |
| glm | 9 | kimi-runtime-docs | job_78d356c3-9991-44df-bca9-7c49234d6583 | sent | completed | APPROVE | false |
| glm | 10 | kimi-tests | job_3613a071-682e-4043-9bd0-3c46355edfd7 | sent | completed | APPROVE | false |
| glm | 11 | shared-runtime-ci | job_dff2a260-312c-486a-a762-e7e32453846e | sent | completed | APPROVE | false |
| glm | 12 | shared-tests-a | job_1b27aa15-113a-4ac3-9835-731fb15de2fc | sent | completed | APPROVE | false |
| glm | 13 | shared-tests-b | job_2810201d-dabe-41c9-86e9-d75dccd2367d | sent | completed | APPROVE | false |
| glm | 14 | specs-contracts-evidence | job_6b3831f8-3794-473e-b20e-a9a5ec8d2c7a | sent | completed | APPROVE | false |
| claude | 1 | api-runtime-docs | ab2ca95b-9b14-4881-a814-e892e8796feb | sent | completed | APPROVE | false |
| claude | 2 | api-tests | ee1dd11c-b100-4191-9d21-a8a2fb5005fb | sent | completed | APPROVE | false |
| claude | 3 | grok-runtime-docs | 248ae0eb-9ff8-4ed7-b09b-46ab4a9a4593 | sent | failed |  | true |
| claude | 4 | grok-tests | de8319be-8cd5-4d24-b2c6-0b0b33ae9588 | not_sent | failed |  | false |
| claude | 5 | claude-runtime-docs | 25b82a91-7265-4fb3-aa8a-dfa56ec9b469 | not_sent | failed |  | false |
| claude | 6 | claude-tests | c201ea2b-0dea-45a3-876c-f5660d52d9e2 | not_sent | failed |  | false |
| claude | 7 | gemini-runtime-docs | 29166d9f-dd75-446c-b2d0-9000d81f51bc | not_sent | failed |  | false |
| claude | 8 | gemini-tests | 428c540d-a7ff-485d-941f-e23d4de31bbe | not_sent | failed |  | false |
| claude | 9 | kimi-runtime-docs | 00b3f473-fa9a-436a-aefd-410500934268 | not_sent | failed |  | false |
| claude | 10 | kimi-tests | 713438b4-af01-48f1-a2ed-c2a84622c90c | not_sent | failed |  | false |
| claude | 11 | shared-runtime-ci | a6168914-0186-44d1-ac20-5ab5d1fb7902 | not_sent | failed |  | false |
| claude | 12 | shared-tests-a | 9100e0b2-ee23-47b7-8e7f-1e43f6a818f6 | not_sent | failed |  | false |
| claude | 13 | shared-tests-b | ebb17fec-f9c8-4ee3-bb22-f6b345719d15 | not_sent | failed |  | false |
| claude | 14 | specs-contracts-evidence | d1a0fbd3-22c7-47ad-944b-7afc5081f872 | not_sent | failed |  | false |
| gemini | 1 | api-runtime-docs | b9bd8f84-8d06-401d-8922-1e773040d928 | sent | completed | APPROVE | false |
| gemini | 2 | api-tests | 72bded92-2be4-40f5-b089-c024b088f013 | sent | completed | APPROVE | false |
| gemini | 3 | grok-runtime-docs | 3dab0833-6553-4b2e-9b5f-a4059d6912ae | sent | completed | APPROVE | false |
| gemini | 4 | grok-tests | 3e61a1e1-4f90-4a72-abd1-c41fc3ce4f12 | sent | completed | APPROVE | false |
| gemini | 5 | claude-runtime-docs | 75be2bf3-7dad-4321-8de0-2f11145f7ab8 | sent | completed | APPROVE | false |
| gemini | 6 | claude-tests | de0a14db-e88c-496c-9721-696d205fab58 | sent | completed | APPROVE | false |
| gemini | 7 | gemini-runtime-docs | 69fbed39-e87b-4057-bc19-b77e30db9e51 | sent | completed | APPROVE | false |
| gemini | 8 | gemini-tests | ba5b395d-59a5-4a57-b0ff-a15e6f59f33a | sent | completed | APPROVE | false |
| gemini | 9 | kimi-runtime-docs | 7ab872ef-390a-4a4d-9972-efca070016e7 | sent | completed | APPROVE | false |
| gemini | 10 | kimi-tests | 9315b402-658c-46d2-854e-2f2ab08db054 | sent | completed | APPROVE | false |
| gemini | 11 | shared-runtime-ci | 766d6df9-0010-4be5-aa13-2ed4e892385d | sent | completed | APPROVE | false |
| gemini | 12 | shared-tests-a | d2df145b-f472-4cbb-833a-3041239160fb | sent | completed | APPROVE | false |
| gemini | 13 | shared-tests-b | d7e6f757-aae9-42ce-a311-fbc9a2e0a7e1 | sent | completed | APPROVE | false |
| gemini | 14 | specs-contracts-evidence | c88adbd4-c2b7-4a34-a0a9-0cc4dea67064 | sent | completed | APPROVE | false |
| grok | 1 | api-runtime-docs | job_7fbd0108-19a8-4e31-989c-5c7d8592d8d4 | sent | completed | APPROVE | false |
| grok | 2 | api-tests | job_b33073db-96fd-40d2-9901-3ff1da2fb4ee | sent | completed | APPROVE | false |
| grok | 3 | grok-runtime-docs | job_4167be98-9f2d-4a73-af6a-5e3c1bb7a259 | sent | completed | APPROVE | false |
| grok | 4 | grok-tests | job_d1f4bfd9-9eb4-4cba-9d31-04dc3c0474b7 | sent | completed | APPROVE | false |
| grok | 5 | claude-runtime-docs | job_e6c168b9-4333-4293-aee6-1aadf6378f10 | sent | completed | APPROVE | false |
| grok | 6 | claude-tests | job_ab5844f8-5b6b-4ebc-a4d0-b98fcb1ca4c3 | sent | completed | APPROVE | false |
| grok | 7 | gemini-runtime-docs | job_cc83501e-476d-4cac-a775-0a486004a671 | sent | completed | APPROVE | false |
| grok | 8 | gemini-tests | job_3bf99edf-c0f7-4d31-98a3-3b939ca0231d | sent | completed | APPROVE | false |
| grok | 9 | kimi-runtime-docs | job_9fd6aea6-86f9-433c-9612-f7624ba9f133 | sent | completed | APPROVE | false |
| grok | 10 | kimi-tests | job_9d382883-5a5a-450d-8bbd-bbdbc2b4f405 | sent | completed | APPROVE | false |
| grok | 11 | shared-runtime-ci | job_2f529512-a787-409c-8f1e-a833eea22a61 | sent | completed | APPROVE | false |
| grok | 12 | shared-tests-a | job_37ecf8d5-2e19-474d-bafd-d017a67bba7e | sent | completed | APPROVE | false |
| grok | 13 | shared-tests-b | job_a6f93048-2599-4209-b0b2-7e4ee8269c19 | sent | completed | APPROVE | false |
| grok | 14 | specs-contracts-evidence | job_e7b5bb1d-9e3f-4dcc-b56d-d37f581268ce | sent | completed | APPROVE | false |
| kimi | 1 | api-runtime-docs | 677b6b76-0436-446a-9759-e00313d09145 | sent | completed | APPROVE | false |
| kimi | 2 | api-tests | 6ee5863e-8e44-456e-9c11-46e2c1963542 | sent | failed |  | true |
