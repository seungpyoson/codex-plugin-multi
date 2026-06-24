# Relay review/rescue output quality — pinned root-cause analysis

Status: **PINNED.** Every mechanism below was confirmed by an executable reproduction
re-run at HEAD (`scripts/ab/verify/*.mjs`, all exit 0) and cross-validated by two
independent engines (a Codex adversarial review and a Claude multi-agent completeness
sweep). The only un-pinned item is *magnitude* (which root dominates the felt gap),
which by nature needs a live model A/B, not more code analysis.

## Observation
Running a code review (or rescue) *through relay* yields worse results than asking the
same external model manually. Relay relays to external CLIs (`*-companion.mjs run
--mode=review|rescue`); shared libs in `scripts/lib/*` are CI-synced byte-identical into
every `relay/relay-*/`. Reproductions live in `scripts/ab/` (Tier-1 A/B harness) and
`scripts/ab/verify/` (per-claim reproductions).

## Five roots + one cross-cutting mechanism (all pinned)

### Root 1 — Blindfold (static-packet formatter, not an agent)
- Prompt forbids tool use (`scripts/lib/review-prompt.mjs:1746-1750`) and buries user
  intent last (`:1764`).
- **Enforcement is provider-specific** (corrected from "prompt-only"): Claude blocks
  tools at launch via `--disallowedTools` (`mode-profiles.mjs` `REVIEW_DISALLOWED` +
  `claude.mjs:158-159`); Kimi via a restricted allowlist + `add_dir:false`; Gemini's
  blocklist is inert, so Gemini is prompt-only. → relaxing the prompt alone is a partial
  fix; Claude/Kimi need mode-profile/launch changes (overlaps #231).

### Root 2 — Silent lossy transforms (instead of fail-loud + preserve)
- **Discard** classifier nulls correct reviews — 5/7, controls pass (`scripts/ab/relay-quality-ab.mjs`, Arm B).
- **Garble** redactor corrupts findings — 5/7, incl. the rescue deliverable (Arm C; `privacy-redaction.mjs`).
- **Silent diff truncation** 512KB→256KB (`diff-source.mjs:108-111`).
- **Timeout-discard race** — a COMPLETE valid review with `timedOut:true` is dropped as
  `timeout` (`external-model-failure-core.mjs:222` runs before the success branch at `:240`;
  `gemini.mjs:198` parses without threading `timedOut`). PINNED + control arm: `P1`.
- **`usage_limited` mislabel** — bare `/\bquota\b/i` (`usage-limit.mjs:7`) + ordering in
  `gemini.mjs:91-96` relabels benign/timeout failures as billing, hiding the real cause.
  PINNED: `P2`.
- Retry blocked after a discarded slot (`review-prompt.mjs:1405-1411`).

### Root 3 — No single source of truth (duplicated, drifting policy/gates)
- Scope policy drift — 3 drifted `mode-profiles` clones + grok/agy inline `resolveReviewScope`
  (tracked as **#231**).
- **Verdict-grammar asymmetry** — the prompt allows `Verdict: NOT_REVIEWED` but parsers
  reject it: `provider-route-policy.mjs:647` → `missing`; AGY substantive gate → drop +
  `result:null`; APPROVE/REQUEST_CHANGES preserved. PINNED: `P3` (resolves the Codex-vs-
  workflow disagreement — **Codex was right**).
- **AGY substantive-gate substring** — AGY-only `hasSubstantiveReview` requires the literal
  `/Blocking findings/i`; valid reviews phrased "Blockers:"/"Must fix:" that the shared
  contract accepts are nulled (`review_not_completed`). PINNED: `P4`.
- **AGY hardcoded `sourceRedactionRequired:true` + non-atomic persist** — empty-source
  completed reviews throw in `buildJobRecord` and never persist (siblings compute it);
  `persistRecord` splits meta+state with no try/catch (kimi uses atomic `commitJobRecord`).
  PINNED: `P5`.

### Root 4 — Render/contract boundary drops findings (ORCH-1) — **highest leverage**
- On a completed `--foreground --lifecycle-events markdown` run, the orchestrator's only
  stdout is a metadata card with **no `result` row** (`companion-common.mjs:143-160`);
  `printLifecycleJson` (:331-332) writes only the card and never falls through to the
  findings-bearing path. Findings sit on `record.result`, reachable only via `result --job`,
  which no contract mandates — so a real review can be reported "no findings produced."
  PINNED end-to-end through the real AGY emission code: `ORCH1-render-boundary-e2e.mjs`
  (observed stdout = `Status: completed` card, findings absent).
- **Raw-output loss is AGY-specific** (corrected): AGY nulls `parsed.result` before record
  build and writes no stdout sidecar; gemini/kimi/claude retain `result` + write `stdout.log`.
  PINNED: `P7`.

### Root 5 — Pre-launch availability defect (WL-1)
- A stale **cross-host** workload lease blocks all source-bearing reviews indefinitely —
  `review-workload.mjs:81` returns `true` for a foreign-host holder with no PID/mtime/timeout
  fallback (unlike `gateOwnerActive:150-152`). LOUD, and **dormant on single-host** (default
  lock dir is local `tmpdir()`). PINNED + control arm: `P8`.

### Cross-cutting — Post-run mutation invalidation (P6)
- A good review is failed because the provider wrote cache/session/generated files during the
  run: `withMutationReviewFailure` turns any new non-diagnostic `git status` line into
  `source_mutation_detected` + `failed_review_slot`. PINNED with controls (benign cache files
  force failure; diagnostic-only does not): `P6`. Distinct *trigger* (workspace mutation, not
  review content); Codex argued a 6th root, folded here under the discard family.

## Corrections made during verification
- Root 1 blindfold is launch-enforced for Claude/Kimi, not prompt-only.
- Raw-output loss is AGY-specific, not a shared job-record behavior (gemini/kimi/claude keep
  sidecars).
- `NOT_REVIEWED` verdict-grammar drift is real and high (Codex), not "contract-symmetric".

## Refuted (checked and ruled out)
Weaker/cheaper model or downgrade; single-shot vs agentic loop; missing reasoning/temperature
flags; lifecycle metadata cards degrading the review (rendered after model return, reach only
the orchestrator).

## Remaining open (not a mechanism gap)
- **Magnitude / ranking** — which root contributes most to the *felt* gap. Mechanisms are
  pinned; relative weight needs a live A/B (on AGY, since Gemini is retired).
- ORCH-1's *render-side* loss is now byte-level observed; the downstream "orchestrator
  verbally says no findings" is the contract-driven consequence (`SKILL.md:24`).

## Reproductions
- `scripts/ab/relay-quality-ab.mjs` — Tier-1 deterministic A/B (blindfold ceiling / discard / garble).
- `scripts/ab/verify/P1..P8`, `ORCH1-render-boundary-e2e.mjs` — per-claim reproductions, all exit 0.
