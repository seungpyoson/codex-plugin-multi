# Architecture Record

This project is the Codex-side inverse of `openai/codex-plugin-cc`: Codex can
delegate to Claude Code, Gemini CLI, Kimi Code CLI, Grok Web, and direct
API-backed reviewers. The implementation intentionally differs from a simple upstream port
in a few places because the review/rescue lifecycle has different failure modes
when Codex is the caller.

## Core Improvement: Containment And Scope Are Separate

The most important architectural choice is that containment and scope are
orthogonal.

- `containment` answers: where may the target CLI write?
- `scope` answers: what source context may the target CLI see?

This avoids the common but unsafe shortcut of treating "isolated" as one
combined flag. A review can see the dirty working tree while still running in a
disposable target directory. That is the default shape for review profiles:
the model sees the relevant source state, but writes are contained and mutation
detection records any unexpected changes.

This split fixed the earlier design gap where a "safe" review could miss
uncommitted changes because isolation and visibility were conflated.

## Other Load-Bearing Invariants

### ModeProfile Is The Source Of Mode Defaults

Every mode-correlated setting lives in the `ModeProfile` table: model tier,
permission mode, disallowed tools, containment, scope, dispose default,
context-stripping, and add-dir behavior. Dispatcher libraries receive a profile
instead of taking scattered flag defaults.

This prevents review, adversarial-review, rescue, continue, and ping behavior
from drifting apart across Claude and Gemini.

### One JobRecord Shape

Foreground output, background result files, `status`, `result`, and the result
handling docs all use the same `JobRecord` schema. The code should not assemble
different per-path response blobs.

This makes job lifecycle behavior auditable and keeps status/result semantics
consistent across foreground and background runs.

### Review Quality Gate

Reviewer transport success is not enough. A slot that exits cleanly can still be
failed when the answer is shallow, permission-blocked, missing a verdict, or says
it could not inspect the selected source. Those cases produce
`error_code: "review_not_completed"` with `error_cause: "review_quality"` and
`review_metadata.audit_manifest.review_quality.semantic_failure_reasons`.

The raw `result` remains in the failed `JobRecord` for diagnosis, but consumers
must use `status`, `error_code`, and `review_quality.failed_review_slot` to
decide whether the reviewer completed the task. This prevents placeholder output
from being treated as a successful external review.

The seeded A/B quality fixture is source-controlled in
`scripts/lib/review-quality-ab-fixture.mjs` and exposed through
`scripts/review-quality-ab-fixture.mjs`. Reviewer prompts and judge-only answer
keys are deliberately separate so manual relay and plugin runs can use the same
review contract without leaking expected findings into the model prompt.

Provider panels are rendered from JobRecords with `scripts/review-panel.mjs`.
The panel row is the user-facing reliability surface: provider, Job ID,
operator State, source transmission (Sent), elapsed/configured timeout,
verdict/error Result, readiness, terminal status, semantic failed-slot state,
inspection state, error code, HTTP status, and semantic failure reasons must be
visible together so broken review slots are not hidden behind result prose.
The `--workspace` discovery path scans companion state directories and filters
by stored workspace root, while direct-provider fallback records stay
provider-data-root scoped to match the paths each writer uses when no explicit
plugin data root is configured.

### Identity Types Stay Distinct

`job_id`, target session IDs, resume chains, and PID ownership tuples are
different identities with different sources:

- `job_id` is minted by this companion.
- `claude_session_id` / `gemini_session_id` are read from target CLI output.
- `resume_chain` records target session continuity.
- `pid_info` records process ownership for safe cancellation.

Keeping these separate prevents resuming the wrong session and prevents sending
signals to a reused PID.

### Shared Libraries Need Behavior Checks, Not Only Byte Identity

Claude, Gemini, and Kimi share many library copies. Byte identity is useful, but
it is not sufficient: two copies can be equally broken. Shared-library checks
also require clean imports, production consumers, and behavior tests.

The repo keeps plugin packages self-contained, so some shared code remains
copied instead of imported from a cross-plugin runtime package. That duplication
is intentional only when it is either byte-identical and guarded by
`tests/unit/plugin-copies-in-sync.test.mjs`, or provider-specific enough that
centralizing it would hide auth, process, or output-contract differences. Direct
API-backed reviewers use a separate, smaller runtime because their failure
surface is HTTP/auth-policy based rather than CLI/process based.

### Grok Web Is Subscription-Backed And Separate From Direct API

Grok Web is intentionally separate from `api-reviewers`. Its default mode is a
subscription-backed local tunnel that talks to a Grok web session managed by the
user. It is not a paid direct API provider, and it must not silently fall back
to xAI API billing when the tunnel is unavailable.

The local tunnel may itself rely on session cookies or other browser-session
state. Those values are sensitive: the Grok plugin may pass an optional bearer
value from `GROK_WEB_TUNNEL_API_KEY`, but JobRecords, diagnostics, and docs must
only show the credential key name. Failure modes should distinguish local tunnel
unavailable, expired or rejected web session, usage limits, malformed tunnel
responses, and scope failures where possible.

Common companion primitives that are mechanical across Claude, Gemini, and Kimi
belong in the canonical repo-level `scripts/lib/companion-common.mjs` source.
Codex installs each marketplace plugin as a self-contained root, so the Claude,
Gemini, and Kimi plugin directories also carry generated packaging copies at
`plugins/<target>/scripts/lib/companion-common.mjs`. Edit the canonical source,
then run `node scripts/ci/sync-companion-common.mjs`; the sync test rejects
stale packaging copies. Keep provider-specific ping/auth wording and runtime
classification in each companion when centralizing it would obscure target
behavior.

## Upstream Relationship

Upstream `openai/codex-plugin-cc` remains the reference for the delegation
shape and several helper patterns. This repository keeps upstream attribution in
`NOTICE`, tracks provenance in each `UPSTREAM.md`, and preserves compatible
patterns where they fit. The differences above are intentional local
architecture, not accidental drift.
