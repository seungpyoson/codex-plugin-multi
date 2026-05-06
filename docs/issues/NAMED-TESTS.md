# Named regression tests (drop-in for any branch)

**Parent epic:** EPIC-103
**Effort:** ~75 min combined
**Blocked on:** nothing
**Why this exists:** Layer 2 archaeology surfaced exactly two genuine test gaps — every other high-signal closed bug already has direct semantic-match coverage. These two tests close those specific gaps.

These can ship in:
- A standalone tiny PR before any letter-issue.
- Bundled with issue A's fixture MVP (the Grok one would benefit from a recorded fixture).
- Bundled with issue F2 (since the doctor-output contract doc covers the same surface).

Choose at land time.

## Test 1 — Grok `models_ok_chat_400` doctor 2-stage probe

**Test name:** `doctor classifies models_ok_chat_400 when /models returns 200 but /chat/completions returns 400 with non-rejection body`

**File:** `tests/smoke/grok-web.smoke.test.mjs`

**Code under test:** `chatBadRequestCode()` at `plugins/grok/scripts/grok-web-reviewer.mjs:622`

**Setup:**
- Mock the local tunnel to return:
  - `GET /v1/models` → HTTP 200, body matching the existing healthy-models response shape.
  - `POST /v1/chat/completions` → HTTP 400, body with an error message that does NOT match the model-rejection pattern.

**Assertion:**
- `doctor` exit code is non-zero.
- doctor JSON output has `error_code === "models_ok_chat_400"`.
- The output's `chat_probe` (or equivalent field) is captured.

**Why this matters:** Layer 2 found that `chatBadRequestCode()` exists in code but no smoke test exercises the (200/models, 400/chat) path. A future change that breaks this classifier ships with no regression signal.

**Effort:** ~30 min.

## Test 2 — `scope_total_too_large` includes file-size manifest in error_message

**This is a feature add + test, not just a test.** Layer 2's #83 spec_gap was that the recommendation/manifest behavior exists in operator docs but isn't asserted (and arguably wasn't fully implemented).

**Implementation step:**
- Modify `plugins/grok/scripts/grok-web-reviewer.mjs`'s scope-total-too-large error path to append a deterministic, sorted file-size manifest to `error_message`.
- Manifest format: top N (default 5) largest contributors, lines like `<bytes> <path>`, sorted descending by bytes, ties broken by path string sort.

**Test name:** `scope_total_too_large includes file-size manifest in error_message`

**File:** `tests/smoke/grok-web.smoke.test.mjs`

**Setup:** construct a custom-review scope with multiple files totaling ≥1 MiB. The largest file is uniquely largest.

**Assertion:**
- JobRecord-shaped output has `error_code === "scope_total_too_large"`.
- `error_message` contains a manifest section (e.g., starts with `\n  files:` or follows a known marker).
- The first file in the manifest has the largest byte count.
- The manifest contains exactly N entries (the top-N).
- The order is deterministic — running the test twice produces the same string.

**Why this matters:** #83's acceptance criterion was "Grok oversized scope failures include an actionable split/narrowing recommendation, not just `scope_total_too_large`." Without the manifest, operators see the error and have to manually inspect their diff to know which file is the culprit. With the manifest, the actionable next step is in the error itself.

**Effort:** ~45 min.

## How to land

These do not need to be a single PR. Either:
- One PR for both (smaller, atomic).
- Two PRs (cleaner separation of concerns; test 2 is a feature, test 1 is purely test).

Either way, both must:
- Pass `npm test`, `npm run test:full`, `npm run lint`, `npm run lint:sync`.
- Reference Layer 2 archaeology in the PR body.
- Include an entry in `tests/regression-coverage-cache.yml` (issue C bootstrap) with the failure signature.
