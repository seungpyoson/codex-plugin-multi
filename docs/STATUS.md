# Branch status — `feat/103-robustness-spec`

**Issue:** [#103 — Strengthen CI smoke-test robustness across reviewer plugins](https://github.com/seungpyoson/codex-plugin-multi/issues/103)
**Stage:** Planning complete. Implementation starts in follow-up branches.
**Last updated:** 2026-05-06

## What this branch contains

This branch is the **audit + plan**, not the implementation. It produces:

1. Source-of-truth documentation of the existing contract surface (Layer 1).
2. A regression-test archaeology of all 48 closed issues (Layer 2).
3. End-to-end path maps for every plugin × flow (Layer 3).
4. A canonical implementation plan with a sequenced epic + follow-up issues (Layer 4).
5. Two superseded design specs (v1 and v2) and four panel reviews, kept as historical context.

Implementation does **not** happen on this branch. Each follow-up issue spawns its own branch from `main`.

## Reading order for any new session

1. **`docs/IMPLEMENTATION-PLAN.md`** — start here. Canonical front-door. Single source of "what's decided, what's open, what's next."
2. **`docs/issues/EPIC-103.md`** — the epic that anchors all follow-up work. Same content lives on GitHub once filed.
3. **`docs/contracts/README.md`** — index of canonical contracts. Read the specific contract doc for whichever flow you're touching.
4. **`docs/closed-issue-failure-modes.md`** — Layer 2 archaeology. Has a "How to use this" section at top with the operational rules.
5. **`docs/path-maps/README.md`** — Layer 3 path-map index with navigation + how-to-use.
6. **`docs/issues/<letter>-*.md`** — individual follow-up drafts.

The two specs `docs/superpowers/specs/2026-05-06-ci-robustness-design.md` and `…-v2.md` are **historical**. Do not implement against them. Use IMPLEMENTATION-PLAN.md.

## What is NOT done on this branch

- No code changes to plugins, scripts, or tests. Audit only.
- No GitHub issue creation yet — the epic and follow-ups are drafted in `docs/issues/` first; opened on GitHub via `gh issue create` after user confirmation.
- No fixture recording (requires user secrets + deliberate workflow_dispatch run).

## Why we stopped at v2 spec instead of writing v3

Spec iteration hit diminishing returns. v1 internal review found 12 critical issues; v2 panel review (4 models: gpt-5.5-pro / grok-4.3 / gemini-3.1-pro-preview / qwen3.6-max-preview) found ~20 mostly-different critical issues. Each round surfaces new concerns rather than converging on a stable design — meta-evidence that the design space has too many degrees of freedom for review-driven refinement. Implementation reality is the next signal source.

The 4 panel reviews are saved as `docs/issues/EPIC-103.md` § "Panel signal."
