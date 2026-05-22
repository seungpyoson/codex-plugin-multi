# DeepSeek/GLM readiness evidence — 2026-05-21

Initial readiness/root-cause proof was source-free. A later T077 follow-up sent the approved 8-file lifecycle-vs-verdict packet to DeepSeek and GLM after source-free approval-request artifacts were generated.

## Observed failure modes

- `api-reviewer doctor --provider deepseek` / `glm` can fail as `command not found` when the installed package does not expose an `api-reviewer` bin shim.
- Repo-root-relative docs such as `node plugins/api-reviewers/scripts/api-reviewer.mjs ...` fail outside the repo root. Direct proof from `/private/tmp`: Node resolved `/private/tmp/plugins/api-reviewers/scripts/api-reviewer.mjs` and exited `MODULE_NOT_FOUND`.
- `missing_key` means the current process cannot see any non-empty configured credential env var. It is not evidence of provider outage by itself.
- Follow-up root cause: direct API key visibility was cwd/session-env dependent. In this session, `node -e` showed `DEEPSEEK_API_KEY` and `ZAI_API_KEY` present from `/Users/spson/Projects/Claude/codex-plugin-multi`, but absent from `/private/tmp`, `/private/tmp/bolt-v2-433-review-fix`, `/Users/spson/Projects/Claude/bolt-v2`, and `/Users/spson/Projects/Claude/bolt-v2/.worktrees/023-plan-whole-review`. The prior failed session launched installed-cache doctors from `/private/tmp/bolt-v2-433-review-fix`, matching the reproduced absent-env surface. GLM has one supported credential path: `ZAI_API_KEY`.
- The documented owner-only 1Password env cache exists at `~/.cache/op/env.sh`, mode `600`, and contains the required key names. Values were not printed.

## Local RED/GREEN proof

- RED `node --test --test-name-pattern "external model contract docs are generated" tests/unit/external-model-contracts.test.mjs` failed because generated API reviewer docs still required caller cwd to be the `codex-plugin-multi` repo root.
- GREEN generated command docs now use `../scripts/api-reviewer.mjs`; generated skill docs now use `../../scripts/api-reviewer.mjs`.
- RED `node --test --test-name-pattern "api-reviewers package exposes" tests/unit/manifests.test.mjs` failed because `plugins/api-reviewers/package.json` had no `bin`.
- GREEN `plugins/api-reviewers/package.json` exposes `api-reviewer`, with executable shim `plugins/api-reviewers/bin/api-reviewer`.
- RED `node --test --test-name-pattern "doctor missing key diagnoses" tests/smoke/api-reviewers.smoke.test.mjs` failed because `missing_key` did not expose process-env presence diagnostics.
- GREEN `doctor` now returns `present_credential_env_keys: []` and a `next_action` explaining that this Codex process cannot see a non-empty credential env var.
- RED `node --test --test-name-pattern "stale packaged bin" tests/unit/plugin-cache-doctor.test.mjs` failed because `npm run doctor:cache` did not compare packaged `bin/` files.
- GREEN cache doctor now includes `bin/` files and reports stale/missing installed shims.
- RED `node --test --test-name-pattern "prints help" tests/unit/plugin-cache-doctor.test.mjs` failed because `node scripts/codex-plugin-cache-doctor.mjs --help` exited nonzero with `--help requires a value`.
- GREEN cache doctor now prints usage for `--help` and `-h` without running a cache comparison.
- RED `node --test --test-name-pattern "op env cache" tests/smoke/api-reviewers.smoke.test.mjs` failed because `doctor` returned `missing_key` when `process.env` lacked the key even though owner-only `~/.cache/op/env.sh` had the configured credential name.
- GREEN direct API reviewer credential selection now fills only missing configured credential names from an owner-only parsed `~/.cache/op/env.sh` file. It does not execute the file; `process.env` still takes precedence; `API_REVIEWERS_DISABLE_ENV_CACHE=1` disables the fallback.
- Follow-up GREEN `node --test --test-name-pattern "run launch gate uses direct API credential" tests/smoke/api-reviewers.smoke.test.mjs` proves source-bearing `run` launch gating also accepts the owner-only env cache before selected source is sent.
- RED `node --test --test-name-pattern "packaged direct API providers expose one canonical credential env key each|doctor missing key diagnoses current process env|doctor ignores GLM legacy alias without leaking value|GLM direct API custom-review uses coding endpoint" tests/smoke/api-reviewers.smoke.test.mjs` failed because packaged GLM config still advertised two credential env names.
- RED `node --test --test-name-pattern "invalidateProviderKeys" tests/unit/smoke-rerecord-validator.test.mjs` failed because smoke-rerecord maintained its own two-key GLM table.
- GREEN `plugins/api-reviewers/config/providers.json` now exposes only `ZAI_API_KEY` for GLM, `scripts/smoke-rerecord.mjs` derives provider credential names from that config, and the GLM legacy alias is ignored before provider launch/source send.

## Source-free live proof

DeepSeek doctor:

- Command: `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek`
- Status: `ok`
- Ready: `true`
- Credential ref: `DEEPSEEK_API_KEY`
- HTTP status: `200`
- Model: `deepseek-v4-pro`
- Source content transmission: `not_sent`
- Prompt chars: `18`

GLM doctor:

- Command: `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm`
- Status: `ok`
- Ready: `true`
- Credential ref: `ZAI_API_KEY`
- HTTP status: `200`
- Model: `glm-5.1`
- Source content transmission: `not_sent`
- Prompt chars: `18`

Post one-path GLM proof:

- Command: `node plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm`
- Status: `ok`
- Ready: `true`
- Credential ref: `ZAI_API_KEY`
- HTTP status: `200`
- Source content transmission: `not_sent`

Patched cwd-independent proof:

- Command from `/private/tmp`: `node /Users/spson/Projects/Claude/codex-plugin-multi/plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider deepseek`
- Result: `ready:true`, HTTP `200`, `credential_ref:"DEEPSEEK_API_KEY"`, `source_content_transmission:"not_sent"`.
- Command from `/private/tmp`: `node /Users/spson/Projects/Claude/codex-plugin-multi/plugins/api-reviewers/scripts/api-reviewer.mjs doctor --provider glm`
- Result: `ready:true`, HTTP `200`, `credential_ref:"ZAI_API_KEY"`, `source_content_transmission:"not_sent"`.
- Commands from `/Users/spson/Projects/Claude/bolt-v2/.worktrees/023-plan-whole-review` using the patched repo script also returned DeepSeek and GLM `ready:true`, HTTP `200`, and `source_content_transmission:"not_sent"`.

## T077 source-bearing review proof

Result directory: `/private/tmp/cpm-lane-review-results/t077-20260521-direct-api`

- Approval gate: DeepSeek and GLM `approval-request` completed first with `source_content_transmission:"not_sent"`, `selected_route:"direct_api"`, `fallback_reason:"subscription_not_supported"`, `approval_scope:"session"`, and 8 selected files.
- DeepSeek: `job_a5004c3d-dda1-4eca-8450-a416794cc06e`, `status:"completed"`, `source_content_transmission:"sent"`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- GLM: `job_c60b6c17-91d6-447f-8400-4782b552fe64`, `status:"completed"`, `source_content_transmission:"sent"`, `review_quality.failed_review_slot:false`, `Verdict: APPROVE`.
- This proves the patched direct API reviewer can discover credentials, pass source-free preflight, preserve approval gating, send selected source only after the matching approval token, and retrieve terminal review records from the same session.

## Verification

- `node --test tests/unit/external-model-contracts.test.mjs` passed 6/6.
- `node --test tests/unit/manifests.test.mjs` passed 20/20.
- `node --test tests/unit/plugin-cache-doctor.test.mjs` passed 8/8.
- `node scripts/codex-plugin-cache-doctor.mjs --help` printed usage and exited 0.
- `node --test --test-name-pattern "op env cache" tests/smoke/api-reviewers.smoke.test.mjs` passed.
- `node --test --test-name-pattern "run launch gate uses direct API credential" tests/smoke/api-reviewers.smoke.test.mjs` passed.
- `node --test --test-name-pattern "doctor missing key diagnoses" tests/smoke/api-reviewers.smoke.test.mjs` passed.
- `npm run smoke:api-reviewers` passed 144/144.
- `npm run lint:sync` passed.
- `git diff --check` passed.

## Installed cache caveat

`npm run doctor:cache -- --plugin api-reviewers` currently reports `ok:false` and `repo_cache_in_sync:false`.
The installed cache is still in sync with the old marketplace copy, but not with this repo working tree.
It now explicitly reports missing repo-cache files: `bin/api-reviewer`, `scripts/lib/external-model-failure-catalog.mjs`, `scripts/lib/external-model-failure-core.mjs`, `scripts/lib/external-model-review-quality.mjs`, and `scripts/lib/provider-route-policy.mjs`.
Open Codex sessions will not see this shim/docs/runtime hardening until the marketplace/cache is refreshed and sessions are restarted.

## T080 current closure follow-up - 2026-05-22

Source-free pre-send matrix for the current T080 closure passed before selected source was sent:

- Claude subscription doctor returned `ready:true`, `selected_route:"subscription_oauth"`, model `claude-opus-4-7`, session `5538dec6-158a-4420-b513-fc587205ac0d`, and source was not provided.
- Gemini subscription doctor returned `ready:true`, `selected_route:"subscription_oauth"`, and source was not provided.
- Kimi subscription doctor returned `ready:true`, `selected_route:"subscription_oauth"`, and source was not provided.
- Grok web doctor returned `ready:true`, `selected_route:"subscription_web"`, endpoint `http://127.0.0.1:8000/v1`, chat HTTP 200, and source was not provided.
- DeepSeek direct API doctor returned `ready:true`, HTTP 200, credential `DEEPSEEK_API_KEY`, and source was not sent.
- GLM direct API doctor returned `ready:true`, HTTP 200, canonical credential `ZAI_API_KEY`, and source was not sent.

Current Shard A covered 10 files / 348356 bytes / 9031 lines:

- `plugins/api-reviewers/package.json`
- `plugins/api-reviewers/bin/api-reviewer`
- `plugins/api-reviewers/config/providers.json`
- `plugins/api-reviewers/scripts/api-reviewer.mjs`
- `scripts/lib/provider-env.mjs`
- `plugins/claude/scripts/lib/provider-env.mjs`
- `plugins/gemini/scripts/lib/provider-env.mjs`
- `plugins/kimi/scripts/lib/provider-env.mjs`
- `tests/smoke/api-reviewers.smoke.test.mjs`
- `specs/140-no-mistakes-provider-readiness/deepseek-glm-readiness-2026-05-21.md`

DeepSeek and GLM approval-request artifacts were generated before source send for that exact shard tuple:

- DeepSeek approval-request recorded `source_content_transmission:"not_sent"`, rendered prompt hash `71d20564...`, and 10 files / 348356 bytes / 9031 lines.
- GLM approval-request recorded `source_content_transmission:"not_sent"`, rendered prompt hash `347a99be...`, and 10 files / 348356 bytes / 9031 lines.

Current source-bearing Shard A results:

- Claude `36860b1c-d351-4c03-932c-a8c14a193e58`: completed, source sent, `review_quality.failed_review_slot:false`, usable `APPROVE`.
- Gemini `5120fb1d-03d5-4fd0-af34-2bd83ec2a28c`: completed, source sent, `review_quality.failed_review_slot:false`, usable `APPROVE`.
- Grok Web `job_dc78d6ff-c02c-4ddb-855c-e5907657d5bc`: completed, source sent, `review_quality.failed_review_slot:false`, usable `APPROVE`.
- DeepSeek `job_040b2d18-6e87-470c-8517-e4838022ec59`: completed, source sent, `review_quality.failed_review_slot:false`, usable `APPROVE`.
- GLM `job_74305b5b-227e-4b6a-8a6d-2dd78a4458e0`: completed, source sent, `review_quality.failed_review_slot:false`, usable `APPROVE`.

Kimi did not produce a usable approval and is bounded by `specs/140-no-mistakes-provider-readiness/t080-kimi-reviewer-waiver-2026-05-22.json`:

- Kimi `b205524e-99e9-4bb4-9396-536c7473ac94`: source sent, failed closed as `step_limit_exceeded`, `review_quality.failed_review_slot:true`, not counted.
- Kimi `b5086c7f-8d9f-4b11-9757-ce2f95647759`: source sent, failed closed as `timeout` after the 96-step retry, `review_quality.failed_review_slot:true`, not counted.

DeepSeek non-blocking feedback asked for dedicated packaged-shim coverage. The follow-up guard `api-reviewers bin shim resolves from non-repo cwd` in `tests/unit/manifests.test.mjs` runs `node <absolute shim> --help` from `tmpdir()` and asserts the shim prints commands/providers usage with exit 0.

Post-closure local verification passed:

- `node --test --test-name-pattern "T080 Kimi waiver|T084 completion audit manifest" tests/unit/docs-contracts.test.mjs`
- `node --test tests/unit/docs-contracts.test.mjs` passed 33/33.
- `node --test tests/unit/manifests.test.mjs` passed 21/21.
- `npm run lint:sync` passed.
- `git diff --check` passed.
