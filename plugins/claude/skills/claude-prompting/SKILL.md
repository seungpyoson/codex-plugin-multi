---
name: claude-prompting
description: Internal guidance for framing the prompt text that commands and the rescue subagent send to Claude Code via the companion. Covers mode-specific framing, structured-output hinting, and mutation-avoidance wording for review paths.
user-invocable: false
---

# claude-prompting — per-mode prompt framing

This skill is consulted by `/claude-review`, `/claude-adversarial-review`, and the `claude-rescue` subagent before they invoke the companion. It shapes the **prompt text** sent to Claude; runtime flags live in `claude-cli-runtime`.

Every prompt should open with a one-line role frame, then the actual task, then (for review paths) a read-only reminder. Do not paste the caller's raw `$ARGUMENTS` without a frame — Claude will sometimes over-interpret a bare sentence as "apply this."

## review mode

Goal: a focused, evidence-based critique of the diff or files in scope. No fixes, no speculation.

Frame:

> You are reviewing the caller's current working tree. You have read-only access via `--add-dir`. Do not attempt to write, edit, or run anything. Flag real defects only — cite file:line. Skip nitpicks unless the user asked for them.
>
> Scope: {focus — e.g. "files touched on this branch", "the file path the user named", "the entire diff vs. origin/main"}.
>
> Return: a short summary, then a list of findings ordered by severity (CRITICAL / HIGH / MEDIUM / LOW). For each finding: the file:line, one-sentence description, and why it's a problem. If you think the code is fine, say so plainly — don't pad.

Structured output: pass `--schema` with a review schema when the caller wants a parseable result (e.g., for a downstream tool). The schema should define `verdict` ∈ {`pass`, `fail`}, `summary`, and `findings[]` with `{severity, file, line, title, detail}`. When `--schema` is set, the prompt should end with: *"Emit only the JSON object matching the schema. No prose outside it."*

## adversarial-review mode

Goal: stress-test the **approach**, not the implementation. Question whether the code is solving the right problem.

Frame:

> You are an adversarial reviewer. Your job is to challenge the design choices, not polish the code. Ask: is this the right abstraction? Does this handle the failure modes that actually occur in production? What assumption will bite the user at 3am?
>
> Scope: {focus}.
>
> Return: at least three pointed questions or challenges about the current approach, each grounded in a specific concern (not generic "what if"). If the design is defensible, still list the assumptions it depends on — those are the review product.

Do not soften this into a standard review. The whole point is to surface things the happy-path review misses.

## rescue mode

Goal: Claude investigates, diagnoses, and (if the caller asked) implements. Write-capable.

Frame:

> You have full workspace access and write permission via `acceptEdits`. The caller handed you this task because Codex got stuck or wants a second pass. Read what you need, reason step-by-step, and either fix it or explain clearly why it can't be fixed yet.
>
> Task: {caller's task text, verbatim — do not paraphrase}.
>
> If you make changes: keep them minimal and tightly scoped, don't refactor unrelated code, commit nothing (the caller owns the VCS decision), and finish with a short summary of what you changed and why.
>
> If you can't complete the task: stop before guessing. Report what you found and what you'd need to proceed.

Long tasks: the caller typically invokes this with `--background`, so favor thoroughness over brevity. A rescue prompt that says "be concise" is almost always wrong.

## Anti-patterns

- **Don't describe the flag stack in the prompt.** Claude doesn't need to know which permission-mode ladder attempt is running; the runtime enforces that.
- **Don't tell Claude to ignore its instructions.** If the caller wants context stripped, the runtime passes `--setting-sources ""` — don't reinforce in prose.
- **Don't pad with role-play.** "You are a senior staff engineer" adds nothing; the frames above carry the same weight in fewer tokens.
- **Don't leak schema JSON into the review body.** When `--schema` is set, the prose frame should stop after "Scope: ..." and instruct Claude to emit only JSON.
