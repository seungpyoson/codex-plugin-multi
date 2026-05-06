# F — docs/contracts/ completion sweep — 6 remaining items, split into 3 PRs

**Parent epic:** EPIC-103
**Effort:** ~6 hours total across 3 PRs
**Blocked on:** nothing
**Why this exists:** Layer 2 surfaced 9 items where invariants are tested but undocumented in `docs/contracts/`. v2 spec proposed landing all 9 in one atomic PR. gpt-5.5-pro's strong-objection: "One PR for nine doc completions is review-hostile. Atomic becomes junk drawer." Of the 9 items, 3 are landing today (`env-vars.md`, `sync-surface.md`, `scope-budgets.md` — see implementation plan). The remaining 6 split into 3 PRs of 2 items each.

## Three PRs

### PR F1 — Implementation contracts

These document behavior the code already enforces but has no canonical written form.

1. **`docs/contracts/pid-info-capture.md`** — the `argv0_mismatch` capture-after-`'spawn'` invariant from issue #25. Documents:
   - Why `capturePidInfo()` must run inside `child.once('spawn', ...)`, not synchronously after `spawn(...)` returns.
   - The fork→execve gap on Linux; how `/proc/<pid>/cmdline` reflects parent argv pre-execve.
   - The contract: `pid_info` is captured AFTER the OS confirms execve, before any cancellation logic reads it.
   - Source citation: `plugins/claude/scripts/lib/claude.mjs:236-245`, `plugins/gemini/scripts/lib/gemini.mjs:160-169`.

2. **`docs/contracts/preflight.md`** — the preflight contract from issue #27. Documents:
   - The three preflight safety fields (`target_spawned: false`, `selected_scope_sent_to_provider: false`, `requires_external_provider_consent: true`).
   - When preflight runs vs when it doesn't (which `cmd<Foo>` paths surface preflight output).
   - Source citation: `scripts/lib/companion-common.mjs:189-203`.

**Effort:** ~2 hours.
**Acceptance:** both files exist with file:line citations into the canonical libs; both files mentioned in `docs/contracts/README.md`'s index; `lint:contracts-doc-coverage` (after issue E) recognizes both as valid `@contract` doc targets.

### PR F2 — Operational reference

These document operational concerns that are implicit in code but tribal.

3. **`docs/contracts/doctor-output.md`** — the setup-check command shape from issue #20 + grok's two-stage probe from issue #77. Documents:
   - Companion `cmdPing` (a.k.a. `doctor`) output: `status`, `ready`, `summary`, `detail` schema.
   - Grok `doctor` output: includes both `/v1/models` probe AND `/v1/chat/completions` probe; the `models_ok_chat_400` classification.
   - api-reviewers `cmdDoctor` output: per-provider readiness fields.
   - Cross-architecture: when `ready: true` is fully trustworthy (api-reviewers) vs needs additional probe (grok).

4. **`docs/contracts/sandbox-interactions.md`** — Codex-sandbox interaction matrix from issue #56. Documents:
   - `network_access` and `writable_roots` per provider.
   - Why Gemini needs `--no-native-sandbox` under outer Codex sandbox.
   - Why Kimi needs `~/.kimi/logs` writable.
   - Diagnostic patterns for distinguishing nested-sandbox failures from network/credential failures.

**Effort:** ~2 hours.
**Acceptance:** both files exist with citations; both files mentioned in `docs/contracts/README.md`; `lint:contracts-doc-coverage` recognizes them.

### PR F3 — Test infrastructure reference

These document test-helper invariants that have broken before.

5. **`tests/helpers/README.md`** — test-helper invariants from issue #30. Documents:
   - The `makeGitRepo` invariant: must isolate `GIT_DIR`/`GIT_WORK_TREE` from inherited env; must use `git init -b main`.
   - Why the global pre-commit hook reproduces failure that isolated test runs don't.
   - The "5 times in a row" determinism rule.

6. **Doctor-output extension to `docs/contracts/grok-output.md`** — re-organize the existing grok-output.md to add an explicit § Doctor output section that the `lint:contracts-doc-coverage` (issue E) can recognize as a structured-docstring target. Cite `chatBadRequestCode()` at `grok-web-reviewer.mjs:622`.

**Effort:** ~2 hours.
**Acceptance:** both files updated; `tests/helpers/README.md` exists; `docs/contracts/grok-output.md` has a `### Doctor output` section.

## Why split

- gpt-5.5-pro: "Docs that define contracts, schemas, CI policy, regression semantics, and plugin exceptions deserve separate review surfaces."
- Each PR is review-able in <30 minutes by a single reviewer.
- Each PR closes one logical unit; reviewers don't need to context-switch between unrelated concerns.
- If one PR is blocked on a question, the other two can land independently.
