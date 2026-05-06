# A — Fixture-recording MVP

**Parent epic:** EPIC-103
**Effort:** ~6-8 hours engineering + a deliberate workflow_dispatch run with secrets to record real fixtures
**Blocked on:** repo-level secrets for at least one provider per architecture (Anthropic, Gemini, Kimi, Grok tunnel session, DeepSeek, GLM)
**Why this exists:** Three of four panel reviewers attacked the v2 deferral of fixture recording. gpt-5.5-pro called it "the central #103 concern." The current state (hand-written mocks) lets smoke tests pass while real provider behavior diverges undetected.

## Acceptance criteria

The branch is mergeable when ALL of the following are true:

1. `scripts/lib/fixture-sanitization.mjs` exists. Pure-function library that takes an arbitrary provider response object and returns a sanitized copy with API keys, OAuth tokens, session-id-shaped strings, and configured-secret values redacted. Unit tests cover the api-reviewers redaction patterns from `docs/contracts/redaction.md` (configured ≥4-char and auto-detected ≥8-char thresholds, Authorization headers, Bearer tokens) plus the secret-key shapes from `docs/contracts/redaction.md` § 1 (companion env-strip patterns).

2. `tests/smoke/fixtures/<plugin>/<scenario>.response.json` directory structure exists. Per-fixture provenance file at `<scenario>.provenance.json` with the schema from `docs/contracts/api-reviewers-output.md` (`model_id`, `recorded_at`, `prompt_hash`, `sanitization_notes`, `recorded_by`, `stale_after`).

3. **Three fixtures recorded** (one per architecture, minimum):
   - `tests/smoke/fixtures/claude/happy-path-review.{response,provenance}.json`
   - `tests/smoke/fixtures/grok/happy-path-review.{response,provenance}.json`
   - `tests/smoke/fixtures/api-reviewers-deepseek/happy-path-review.{response,provenance}.json`

4. **Three negative fixtures recorded** (one per architecture):
   - `tests/smoke/fixtures/claude/auth-failure.{response,provenance}.json`
   - `tests/smoke/fixtures/grok/tunnel-error.{response,provenance}.json`
   - `tests/smoke/fixtures/api-reviewers-deepseek/auth-rejected.{response,provenance}.json`

5. `scripts/smoke-rerecord.mjs` exists. CLI script: takes `--plugin <name> --scenario <name>`, runs the relevant smoke flow against the real provider with credentials from env, sanitizes, writes the `.response.json` and `.provenance.json` pair. Aborts loudly if any required env var is missing.

6. `.github/workflows/smoke-rerecord.yml` exists. `on: workflow_dispatch:` only — never runs on PR. Requires per-plugin secrets. Calls `scripts/smoke-rerecord.mjs` for the plugin/scenario the user selects from workflow_dispatch inputs. On success, opens a PR with the diff.

7. Existing smoke tests in `tests/smoke/{claude,grok,api-reviewers}*.smoke.test.mjs` updated to **replay** from the recorded fixtures for the 6 covered scenarios. Hand-written mocks remain for scenarios without fixtures yet.

8. Smoke tests assert the replayed response is consumed correctly and the resulting JobRecord-shaped output matches the schema for that architecture (per `docs/contracts/`).

9. `npm test`, `npm run test:full`, `npm run lint`, `npm run lint:sync` all pass on the branch.

## Code references

- Sanitization patterns: `docs/contracts/redaction.md` § 3 (api-reviewers regex + thresholds) and § 1 (companion env-strip).
- Fixture provenance schema source: `docs/contracts/api-reviewers-output.md` § Persistence (state path) and the originally-proposed schema at v2 spec § 11.
- Existing mock files this MVP partially replaces: `tests/smoke/{claude-mock,gemini-mock,kimi-mock}.mjs`.

## Out of scope (future follow-ups)

- Recording for Gemini, Kimi, GLM — needed eventually but not for MVP. Track in a child issue once MVP lands.
- Fully automated re-record on a schedule. Currently manual via workflow_dispatch.
- Diff-alert pipeline when a re-record produces a different response shape. Issue H handles bot-status alert side.

## Why this is the high-leverage MVP

- 1 success + 1 negative per architecture covers the dominant failure-shape variance per architecture without combinatorial blowup.
- workflow_dispatch + secrets keeps real provider quota out of PR CI (per #103 hard rule).
- Sanitization library is independently useful — issues E (structured docstrings) and G (honesty banner) both reference it.
