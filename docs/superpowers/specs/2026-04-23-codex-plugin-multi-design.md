# codex-plugin-multi — Design

- **Date:** 2026-04-23
- **Status:** Draft v2 (post-empirical-verification), pending user review
- **Repo:** [`seungpyoson/codex-plugin-multi`](https://github.com/seungpyoson/codex-plugin-multi)
- **License:** Apache-2.0 (mirrors upstream)
- **Reference:** [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (Apache-2.0)

---

## 1. Context & goal

Upstream `openai/codex-plugin-cc` lets Claude Code delegate to Codex CLI via `/codex:rescue`, `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`. This project is the symmetric inverse: **two Codex plugins that let Codex delegate to Claude Code and Gemini CLI**, with feature parity to upstream.

**Why two plugins, not one:**

- Parity: upstream is one plugin per target. Doing one per target mirrors the structural shape of the reference implementation (minimum-delta parity).
- Empirical safety: smoke tests (see §4) showed a Gemini CLI call in `--approval-mode plan` autonomously rewrote 20+ files in our repo during a supposed read-only ping. Separate plugins give each target its own trust boundary — a Claude failure can't touch Gemini's job store and vice-versa.
- Independent release cadence: CLIs evolve independently. Claude breaking a flag shouldn't force us to re-test Gemini.

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Packaging | Two plugins (`plugins/claude/`, `plugins/gemini/`) in one monorepo. Each is a standalone Codex plugin. |
| 2 | Command namespacing | Per-target: `/claude:rescue`, `/gemini:review`, etc. Each plugin has its own `status`/`result`/`cancel`. Mirrors upstream's per-plugin namespace (not a shared `/jobs:*`). |
| 3 | Repo | `seungpyoson/codex-plugin-multi`, Apache-2.0, single GitHub origin. |
| 4 | Prompting skills | One per plugin: `plugins/claude/skills/claude-prompting/`, `plugins/gemini/skills/gemini-prompting/`. Each mirrors upstream's `gpt-5-4-prompting` structure. |
| 5 | Auth | OAuth / subscription only. Plugin never reads or writes `*_API_KEY` env vars. |

## 3. Non-goals (v1)

- **No MCP server.** Hard user constraint.
- **No API-key management.** No cost tracking, quota, or model-pricing optimization. Irrelevant to subscription workflows.
- **No droid / other CLI targets.** Claude Code + Gemini CLI only.
- **No first-class plugin slash commands.** Codex plugins expose skills (description-triggered). Opt-in user-level `~/.codex/prompts/` shims installed by `<target>-setup` are the secondary surface.
- **No cross-target handoff chains** (Claude → Gemini → Claude). Simple one-target-per-job in v1.
- **No ACP (Agent Client Protocol) mode.** Gemini supports `--acp` for JSON-RPC orchestration but requires protocolVersion negotiation (verified by probe). Defer to v2.
- **No OS-level sandbox.** Neither target CLI exposes one; achieving process-level read-only isolation would require container/chroot/jail. Documented trade-off — see §10.

## 4. Empirical evidence

Every design choice below is anchored to one of these smoke tests. Tests ran 2026-04-23 on `spson@local`, CLI versions: **Claude Code 2.1.118**, **Gemini CLI 0.39.0**, **Codex CLI 0.123.0**.

### 4.1 Binaries and flag surface

- `claude -p|--print` for headless; rich `--help` with `--model`, `--permission-mode <acceptEdits|auto|bypassPermissions|default|dontAsk|plan>`, `--session-id <uuid>`, `--resume <uuid>`, `--fork-session`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--bare`, `--allowedTools`, `--disallowedTools`, `--no-session-persistence`, `--verbose`, `--append-system-prompt`, `--add-dir`.
- `gemini -p|--prompt` for headless; `-m|--model`, `--approval-mode default|auto_edit|yolo|plan`, `-s|--sandbox` (boolean), `-r|--resume <latest|index|uuid>`, `--output-format text|json|stream-json`, `--include-directories`, `--list-sessions`, `--delete-session`, `--policy`, `--acp`, `-y|--yolo`.

### 4.2 Model availability (this user's OAuth plan, 2026-04-23)

| Tier | Claude | Gemini |
|---|---|---|
| cheap (pings) | `claude-haiku-4-5` (~$0.02 / trivial ping) | `gemini-3-flash-preview` |
| medium | `claude-sonnet-4-6` | `gemini-3.1-pro-preview` (only available mid-tier) |
| default (smartest) | `claude-opus-4-7` (~$0.26 / trivial ping) | `gemini-3.1-pro-preview` |

Not available: `gemini-2.5-flash`, `gemini-2.5-pro` (both return HTTP 429 "No capacity available"); `gemini-3-flash`, `gemini-3.1-flash`, `gemini-3-pro`, `gemini-3.1-flash-preview` (ModelNotFoundError).

**Aliases are unreliable.** `claude --model haiku` silently resolved to `claude-sonnet-4-6` under subscription. Design uses full model IDs only.

### 4.3 Unknown model IDs fail cleanly

- Claude: plaintext error `"There's an issue with the selected model (<id>). It may not exist or you may not have access to it."`, non-zero exit, no JSON.
- Gemini: `ModelNotFoundError: Requested entity was not found.` plus error-report file dumped to `/var/folders/.../T/gemini-client-error-*.json`.

Companion detects by JSON-parse failure OR non-zero exit — both surfaced to user with the raw error.

### 4.4 Session continuation

- Claude: `--session-id <uuid>` sets up front, `--resume <uuid>` resumes. Verified end-to-end: resumed a session from one invocation in another, context preserved.
- Gemini: no `--session-id` equivalent; server mints a UUID returned in JSON (`response.session_id`). `--resume <uuid>` works despite help-text claiming ordinal-only. Verified: resumed by UUID, context preserved.

### 4.5 Read-only enforcement — ⚠️ soft on both, CRITICAL on Gemini

- `claude --permission-mode plan`: **model-compliance based**, not sandbox.
  - `claude-opus`-ish models: typically decline writes verbally ("I'm in plan mode...").
  - `claude-haiku-4-5`: observed to IGNORE plan mode once when prompt emphasized tool use, and WROTE the target file. Plan mode alone is insufficient.
  - `--allowedTools ""` (empty string, docs claim "disable all tools"): observed to FAIL to block writes — file still created.
  - `--disallowedTools "Write Edit Bash NotebookEdit MultiEdit"`: observed to block in one test (file not written). Most reliable layer found.
- `gemini --approval-mode plan`: **far worse than soft**.
  - During a concurrent smoke test, two separate `gemini -p "Reply: GEM_X"` calls in `--approval-mode plan` mode ignored the prompt entirely, inherited project context, and autonomously invoked `write_file` / `invoke_agent` tools. Wrote 20+ files to the working tree. One call logged 43 API requests / 1.76M prompt tokens over 263 s.
  - Plan mode is **not a guarantee** on Gemini. Not even close.
- Design consequence (§10): layered defense with multiple independent mechanisms + post-hoc detection, plus a clear README warning that review paths are **best-effort read-only**, not hard-enforced.

### 4.6 Context inheritance

- `claude -p` (default): inherits cwd's `CLAUDE.md`, memory/`MEMORY.md`, installed skills. Verified by prompt-probe — returned first rule from current project's CLAUDE.md verbatim.
- `claude --bare -p`: strips CLAUDE.md auto-discovery, hooks, plugin sync, auto-memory, keychain reads. Verified — responded "No, there is no CLAUDE.md file in the current system context."
- `gemini -p` (default from project dir): inherits project context fully. Observed to read and act on our in-progress work.
- `gemini -p` from `/tmp` neutral cwd: verified — responded "no" when asked about CLAUDE.md / project files. No `--bare` flag exists for Gemini; neutral-cwd is the only in-CLI mechanism.

### 4.7 Structured output (JSON)

Claude `--output-format json` fields: `result`, `session_id`, `model` (via `modelUsage` keys), `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, `permission_denials`, `is_error`, `terminal_reason`.

Gemini `--output-format json` fields: `session_id`, `response`, `stats.models.<id>.{api.totalLatencyMs, tokens.{input,prompt,candidates,total,cached,thoughts,tool}, roles.main.*}`.

Both reliable. Companion reads these directly — no stdout scraping.

### 4.8 stream-json output

Claude `--output-format stream-json --verbose` emits `{"type":"system","subtype":"hook_started"|"hook_response"|...}` events for every hook fire, then `{"type":"assistant",...}` message events, then a final `{"type":"result",...}` event. Observed 80+ KB of events for a trivial prompt due to many hooks. **Design:** companion uses `--output-format json` (single result object) for most cases; only uses `stream-json` for rescue background jobs that want progressive UI updates. Filter to `type=assistant` / `type=result` events.

### 4.9 Concurrency

- Claude: two parallel `claude -p` calls from same cwd worked cleanly — two distinct `session_id`s, both returned results, no contention.
- Gemini: concurrent `gemini -p` calls both ran to completion without locking errors, but **both were broken runs** that ignored prompts and wrote tool calls. Concurrency itself didn't fail at the process level; semantic safety failed.

### 4.10 argv length

`claude --model claude-haiku-4-5 -p "<100 000-byte string> What was the first character?"` — worked fine, response "The first character in your message was A", `input_tokens: 10` (cache dedup). argv > 100 KB is viable on macOS for both targets. Design doesn't need `--prompt-file` or stdin-only transport for normal use; it does use **stdin transport as the default** (see §16) because it's safer and avoids argv-length debugging entirely.

### 4.11 stdin piping

Gemini `-p` explicitly "Appended to input on stdin" per `--help`. Verified — with `echo "EXTRA_SECRET: banana42" | gemini -p "What word followed 'EXTRA_SECRET:'?"`, Gemini responded "banana42". Companion uses stdin for all prompts.

Claude: stdin with `--input-format stream-json` requires a structured event (`{"type":"user","message":{"role":"user","content":[...]}}`). Plain stdin text is NOT prepended to the `-p` prompt (verified partially — stream-json produced valid output). For Claude we pass prompts via argv (100 KB+ works) or use `stream-json`.

### 4.12 Hooks do not interfere with child CLI calls

`claude -p` invoked from within this Claude Code session did not trigger this session's hooks (block-credential-leaks.js, safe-rm.js, audit gates). Verified implicitly — ran 10+ `claude -p` calls without any hook interference. Companion can invoke child CLIs freely.

### 4.13 Codex plugin surface

- Plugin discovery via `~/.codex/plugins/cache/<namespace>/<repo>/<hash>/`.
- Plugin manifest: `.codex-plugin/plugin.json` with fields `name`, `version`, `description`, `author`, `license`, `keywords`, `skills: "./skills/"`, `interface: {displayName, shortDescription, ..., category, capabilities, composerIcon, logo, defaultPrompt, ...}`.
- Plugin install: `codex plugin marketplace add <git-url>` then `codex plugin marketplace upgrade`.
- Skills: `skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`), body markdown. Optional `agents/` and `scripts/` subdirectories.
- **No `commands/` directory support.** Skills activate by description match. Slash commands come from user-level `~/.codex/prompts/*.md` only.

### 4.14 Apache-2.0 upstream runtime (reference for this design)

Upstream `openai/codex-plugin-cc` source provides the implementation pattern we mirror. Relevant files (all MIT in upstream — we port them under Apache-2.0 with attribution in NOTICE):

```
plugins/codex/
  scripts/
    codex-companion.mjs                  # entry
    app-server-broker.mjs                # [DROP] Codex app-server client — no equivalent for claude/gemini
    broker-endpoint.mjs                  # [DROP]
    broker-lifecycle.mjs                 # [DROP]
    app-server.mjs                       # [DROP]
    app-server-protocol.d.ts             # [DROP]
    session-lifecycle-hook.mjs           # [PORT]
    stop-review-gate-hook.mjs            # [PORT]
    lib/
      workspace.mjs                      # [COPY-VERBATIM] resolveWorkspaceRoot(cwd), ensureGitRepository
      tracked-jobs.mjs                   # [COPY-VERBATIM] createJobLogFile, writeJobFile, upsertJob, etc.
      state.mjs, render.mjs, args.mjs, fs.mjs, git.mjs, job-control.mjs, prompts.mjs, process.mjs  # [COPY-VERBATIM]
      codex.mjs                          # [REPLACE] per-target: claude.mjs / gemini.mjs (spawn argv, no app-server)
```

## 5. Codex plugin surface

Neither plugin contributes `/plugin:command` slash commands natively. Each contributes skills. Codex activates a skill by matching the user's utterance against the skill's `description:` frontmatter. Skill descriptions are tuned with target- and mode-specific vocabulary.

**Example triggers (for `plugins/claude/`):**
- "rescue this with Claude" / "have Claude investigate" → `claude-rescue`
- "Claude review the diff" / "get Claude's feedback on the changes" → `claude-review`
- "challenge this with Claude" / "have Claude push back on the approach" → `claude-adversarial-review`
- "show Claude jobs" / "what Claude work is running" → `claude-status`
- "cancel the Claude job" → `claude-cancel`
- "show the result of Claude job X" → `claude-result`

Symmetric for `plugins/gemini/`.

**Secondary surface (opt-in, installed by `<target>-setup`):** `~/.codex/prompts/claude-rescue.md`, `~/.codex/prompts/gemini-review.md`, etc. — one-line prompt files that the user can invoke via literal `/claude-rescue ...` slash commands in Codex. Shim contents are canonical (no target-inference). Install prompts the user Y/N per shim group during setup.

## 6. Plugin file layout

```
codex-plugin-multi/                      # monorepo
  README.md                              # (tracked, hand-edited)
  LICENSE                                # Apache-2.0
  NOTICE                                 # attribution to upstream
  CHANGELOG.md                           # monorepo-level
  package.json                           # workspaces: ["plugins/*"]
  plugins/
    claude/                              # STANDALONE CODEX PLUGIN
      .codex-plugin/
        plugin.json                      # name="claude", version, description, skills pointer, interface (displayName="Claude")
      LICENSE  NOTICE  CHANGELOG.md
      skills/
        claude-rescue/
          SKILL.md
          agents/
            claude-rescue-agent.md       # subagent (parity with upstream codex-rescue.md)
        claude-review/
          SKILL.md
        claude-adversarial-review/
          SKILL.md
        claude-setup/
          SKILL.md
        claude-status/
          SKILL.md
        claude-result/
          SKILL.md
        claude-cancel/
          SKILL.md
        claude-cli-runtime/              # internal: companion-CLI contract, retrieved by user-facing skills
          SKILL.md
        claude-result-handling/          # internal: how to format target output back to Codex
          SKILL.md
        claude-prompting/                # internal: Claude-specific prompting guidance
          SKILL.md
          references/
            claude-prompt-antipatterns.md
            claude-prompt-blocks.md
      scripts/
        claude-companion.mjs             # entry point (port of codex-companion.mjs)
        session-lifecycle-hook.mjs       # port from upstream
        stop-review-gate-hook.mjs        # port from upstream
        lib/
          workspace.mjs                  # COPY-VERBATIM from upstream
          tracked-jobs.mjs               # COPY-VERBATIM
          state.mjs                      # COPY-VERBATIM
          render.mjs                     # COPY-VERBATIM
          args.mjs                       # COPY-VERBATIM
          fs.mjs                         # COPY-VERBATIM
          git.mjs                        # COPY-VERBATIM
          job-control.mjs                # COPY-VERBATIM
          prompts.mjs                    # COPY-VERBATIM
          process.mjs                    # COPY-VERBATIM
          claude.mjs                     # REPLACES upstream's codex.mjs; spawns `claude -p` over argv/stdin
      prompts/                           # subagent system prompts (parity)
        adversarial-review.md
        stop-review-gate.md
      hooks/
        hooks.json                       # parity copy
      schemas/
        review-output.schema.json        # parity copy
      prompts-shims/                     # opt-in user-level shims installed by claude-setup
        claude-rescue.md
        claude-review.md
        claude-adversarial-review.md
        claude-status.md
        claude-result.md
        claude-cancel.md
    gemini/                              # STANDALONE CODEX PLUGIN — symmetric, s/claude/gemini/g
      .codex-plugin/plugin.json
      LICENSE  NOTICE  CHANGELOG.md
      skills/
        gemini-rescue/  SKILL.md + agents/gemini-rescue-agent.md
        gemini-review/  SKILL.md
        gemini-adversarial-review/  SKILL.md
        gemini-setup/  SKILL.md
        gemini-status/  SKILL.md
        gemini-result/  SKILL.md
        gemini-cancel/  SKILL.md
        gemini-cli-runtime/  SKILL.md
        gemini-result-handling/  SKILL.md
        gemini-prompting/  SKILL.md  + references/*.md
      scripts/
        gemini-companion.mjs
        session-lifecycle-hook.mjs
        stop-review-gate-hook.mjs
        lib/
          workspace.mjs tracked-jobs.mjs state.mjs render.mjs args.mjs fs.mjs git.mjs job-control.mjs prompts.mjs process.mjs
          gemini.mjs                     # spawns `gemini -p` from neutral cwd for reviews
      prompts/ hooks/ schemas/ prompts-shims/
  tests/
    unit/
      jobs.test.mjs                      # workspace scoping, job-store atomic writes, PID liveness, meta schema
      process.test.mjs                   # spawn argv safety, stdin transport, timeout, signal handling
      render.test.mjs                    # output formatting, truncation
      workspace.test.mjs                 # resolveWorkspaceRoot edge cases (non-git cwd, worktree, etc.)
    smoke/                               # env-var-gated mock CLI to exercise end-to-end without real API spend
      claude-mock.mjs
      gemini-mock.mjs
      claude-companion.smoke.test.mjs
      gemini-companion.smoke.test.mjs
    e2e/                                 # real CLI, runs locally only (skipped in CI)
      claude.e2e.test.mjs                # one rescue, one review, one adversarial-review, one setup
      gemini.e2e.test.mjs                # same
  .github/
    workflows/
      pull-request-ci.yml                # lint + unit + smoke (no e2e)
```

**Plugin count: 2.** Each has its own manifest and is individually installable.

**Skill count: 10 per plugin × 2 = 20.** (7 user-facing: rescue, review, adversarial-review, setup, status, result, cancel. 3 internal: cli-runtime, result-handling, prompting.)

## 7. Runtime — `<target>-companion.mjs`

Each plugin ships its own companion entry point. Structure mirrors upstream `codex-companion.mjs` 1:1 with target-specific branches in `lib/<target>.mjs`.

### 7.1 CLI surface (both companions, identical)

```
node <plugin-root>/scripts/<target>-companion.mjs run \
  --mode=rescue|review|adversarial-review \
  [--background | --foreground] \
  [--model <full-id>] \
  [--cwd <path>] \
  [--isolated]                           # review default; forces neutral cwd
  < prompt-on-stdin

node <plugin-root>/scripts/<target>-companion.mjs continue \
  --job <job-id> \
  < follow-up-prompt-on-stdin

node <plugin-root>/scripts/<target>-companion.mjs status [--job <id>]
node <plugin-root>/scripts/<target>-companion.mjs result --job <id>
node <plugin-root>/scripts/<target>-companion.mjs cancel --job <id> [--force]
node <plugin-root>/scripts/<target>-companion.mjs ping               # OAuth health probe, uses cheap-tier model
node <plugin-root>/scripts/<target>-companion.mjs doctor             # verbose diagnostics for setup
```

**No `--prompt` flag.** Prompt always enters via stdin. See §16 for rationale.

### 7.2 Dispatch (per target)

**Claude (`lib/claude.mjs`):**
```js
spawn('claude', [
  '-p',                                   // headless print
  '--output-format', 'json',
  '--no-session-persistence',             // we manage session state
  '--session-id', jobId,                  // set UUID up front; job ID === claude session ID
  '--model', resolvedModel,
  '--permission-mode', modeToPolicy(mode),// 'plan' for review*, 'acceptEdits' for rescue
  '--disallowedTools', 'Write Edit Bash NotebookEdit MultiEdit',  // only for review*; omit for rescue
  ...(isolated ? ['--bare'] : []),        // neutral context for reviews
  ...(isolated ? [] : ['--add-dir', cwd]),// explicit workspace for rescue
], { cwd: isolated ? '/tmp' : cwd, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(promptText); child.stdin.end();
```

**Gemini (`lib/gemini.mjs`):**
```js
spawn('gemini', [
  '-p', '',                               // empty prompt triggers stdin append
  '-m', resolvedModel,
  '--approval-mode', modeToApproval(mode),// 'plan' for review*, 'auto_edit' for rescue
  '--output-format', 'json',
  ...(resume ? ['--resume', sessionId] : []),
  ...(sandbox ? ['-s'] : []),             // sandbox only for review* — hardening layer
], { cwd: isolated ? '/tmp' : cwd, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(promptText); child.stdin.end();
```

### 7.3 Background job lifecycle

1. `run --background` forks the target CLI with stdio redirected to `<workspace>/.codex-plugin-<target>/jobs/<id>/{stdout.log,stderr.log}`.
2. Parent writes `meta.json` with status `running`, PID, mode, started_at, cwd, isolated flag, model, prompt-head (first 200 chars).
3. Parent returns `{event: "launched", job_id, target, pid}` JSON on stdout and exits.
4. A tiny detached wrapper (inline in the companion, via `detached: true` + `child.unref()`) waits on the child, then writes terminal `meta.json` (status `done`/`failed`/`canceled`, exit_code, ended_at).

No daemon. No IPC beyond files. Stateless between invocations. Mirrors upstream.

### 7.4 OAuth health probe (`ping`)

`cli-companion ping` runs `<target> -p` with a 15 s timeout, using the **cheap-tier model** (Claude haiku, Gemini flash-preview) to avoid charging opus/pro for every health check. Result categories:

- `ok` — JSON parsed, `is_error:false`/`response` non-empty → OAuth alive.
- `not_authed` — non-zero exit code + non-JSON stdout with stderr content. Companion surfaces raw stderr verbatim to the user plus a generic hint: "run `<target>` interactively to complete OAuth." We do NOT hard-code specific error-string patterns — they change across CLI versions; raw surface is more robust.
- `not_found` — `ENOENT` spawning the binary → print install URL.
- `rate_limited` — 429 status detected in stderr → print retry guidance.
- `error:<raw>` — anything else; pass the raw stderr to the user.

## 8. Model selection policy

- **Full model IDs only.** Aliases silently substitute — evidence §4.2.
- **Three tiers:**

| Tier | Claude | Gemini |
|---|---|---|
| `cheap` (ping, doctor) | `claude-haiku-4-5` | `gemini-3-flash-preview` |
| `medium` | `claude-sonnet-4-6` | `gemini-3.1-pro-preview` |
| `default` | `claude-opus-4-7` | `gemini-3.1-pro-preview` |

- **Default for rescue / review / adversarial-review:** `default` tier.
- **Default for ping / doctor:** `cheap` tier.
- **User override:** every skill accepts `model=<id>` in its argument text; the subagent / skill passes this to the companion `--model <id>`.
- **Unknown model IDs:** companion detects (non-JSON output + non-zero exit) and surfaces the raw error. No fallback.
- **Model-tier config file:** `<plugin-root>/config/models.json` — easy to update as model availability changes. Companion reads it at each invocation.

## 9. Context isolation strategy

Two distinct needs:

- **Rescue** wants project context: Claude/Gemini should know the cwd, the CLAUDE.md rules, the skills, the memory. Inheriting context is a feature.
- **Review / adversarial-review** wants neutrality: the reviewer should not be biased by the project's rules (e.g., "my CLAUDE.md says never raise this kind of finding").

| Target | Rescue | Review / adversarial-review |
|---|---|---|
| Claude | default (no `--bare`), `--add-dir <cwd>` explicit | `--bare` (strips CLAUDE.md, memory, skills, hooks, plugin sync, keychain) ✓ verified |
| Gemini | default cwd | **run from `/tmp` neutral cwd** (no `--bare` equivalent) ✓ verified; optionally `--include-directories <target-cwd>` to re-include specific files |

When `--isolated` is passed (review default), the companion:

1. Spawns the child with `cwd: /tmp` (or an ephemeral tempdir we create per-call).
2. Passes specific files via `--add-dir <file>` (Claude) or `--include-directories <file>` (Gemini), scoped to what the user asked to review.
3. Captures the target's output via JSON, decoupled from the neutral cwd.
4. Does NOT write reports back into the target-cwd unless explicitly asked.

## 10. Read-only enforcement — layered defense

Upstream has Codex's OS-level sandbox (`sandbox: "read-only"`). We have no such thing. Instead, we layer mechanisms. Each layer can fail; the combination reduces (not eliminates) the chance of unintended mutation.

**Claude review paths — full arg list:**
```
claude -p
  --bare                                 # layer 1: strip context (removes CLAUDE.md incitement to use tools)
  --permission-mode plan                 # layer 2: soft system-instruction
  --disallowedTools "Write Edit Bash NotebookEdit MultiEdit"  # layer 3: hard allowlist exclusion
  --no-session-persistence
  --output-format json
  --session-id <job-id>
  --model <id>
```

**Gemini review paths — full arg list:**
```
gemini -p ''
  -s                                     # layer 1: --sandbox flag (OS-level, untested thoroughness but best available)
  --approval-mode plan                   # layer 2: soft instruction (proven unreliable alone)
  -m <id>
  --output-format json
  # cwd=/tmp for layer 3 (context-stripping)
  # gemini skills disable '*' pre-call for layer 4 (NOT DONE in v1 — it mutates global state and we avoid side effects)
```

**Post-hoc detection (both targets):**

Before each review-path call, companion snapshots `git status -s --untracked-files=all` of the target cwd into `meta.json`. After the call, re-snapshots and diffs. If the diff is non-empty:

1. Surface prominently in the result: `⚠️ <N> file(s) were modified during a read-only review.`
2. List the changed files.
3. Do not auto-revert. Let the user decide (`git checkout -- .` or keep the changes).

**README disclosure:** "Reviews are best-effort read-only. Gemini CLI does not currently expose a hard sandbox; plan-mode is model-compliance-based. Always run reviews on changes you've committed, and use `git status` to detect unexpected mutations."

**Escape hatch for strict users:** `--dispose` mode in `run` — clones the target cwd into `~/.cache/codex-plugin-<target>/disposable/<job-id>/` and runs the review there, so any mutation happens on a throwaway copy. Uses `git worktree add --detach` if cwd is a git repo, else `cp -a` for non-git dirs. Enabled by default on review paths; user can opt out with `--no-dispose` for live-tree review when they trust the model.

## 11. Session continuation

- **Claude:** companion sets `--session-id <job-id>` on first launch (job-id is a ULID we mint; valid UUID format required — we use UUID v4, not ULID). `continue --job <id>` runs `claude --resume <job-id> -p < stdin`. No `-c` (most-recent) fallback, ever.
- **Gemini:** server mints session UUID on first call; companion captures it from JSON response and stores in `meta.json > session.claude_session_id` (or gemini-equivalent field). `continue --job <id>` runs `gemini --resume <captured-uuid> -p < stdin`. No ordinal-index fallback, no `latest` fallback.
- If `meta.json.session_id` is missing or empty, `continue` fails closed with `SESSION_UNAVAILABLE` error. User must start a new job.

## 12. Job store (per-target, workspace-scoped)

**Location:** `<workspace-root>/.codex-plugin-<target>/jobs/<job-id>/`

- `workspace-root` = `resolveWorkspaceRoot(cwd)` from ported upstream `lib/workspace.mjs`. Returns the git-repo root if cwd is in a git repo, else `cwd` itself.
- Each target (claude, gemini) has an independent job-store subtree so failures in one can't corrupt the other.

**Layout:**
```
<workspace>/.codex-plugin-claude/jobs/
  <uuid>/
    meta.json
    stdout.log
    stderr.log
    session.json                         # UUID + target-specific session metadata
    git-status-before.txt                # for review paths — pre-snapshot
    git-status-after.txt                 # for review paths — post-snapshot
```

**`meta.json` schema:**
```json
{
  "id": "ae1df79e-9cec-4213-a0db-0b367ee16345",
  "target": "claude",
  "mode": "rescue|review|adversarial-review",
  "status": "running|done|failed|canceled",
  "pid": 12345,
  "exit_code": null,
  "started_at": "2026-04-23T14:22:00Z",
  "ended_at": null,
  "cwd": "/absolute/path",
  "workspace_root": "/absolute/git-root",
  "isolated": true,
  "dispose_path": null,
  "model": "claude-opus-4-7",
  "session_id": "ae1df79e-9cec-4213-a0db-0b367ee16345",
  "parent_job": null,
  "prompt_head": "First 200 chars...",
  "schema_version": 1
}
```

**ID format:** UUID v4 (required by Claude's `--session-id`). Companion mints `crypto.randomUUID()`. One namespace per target plugin per workspace.

**Atomic writes:** write `meta.json.tmp` then `rename()` (POSIX atomic). Port upstream's `tracked-jobs.mjs` verbatim — it already does this.

**PID liveness:** `status` / `cancel` verify PID is alive AND its command-line matches the expected target binary before trusting or signaling. Defends against PID reuse. (Parity with upstream's `process.mjs`.)

**Retention:** no auto-GC in v1. Add `cli-companion prune --older-than 30d` later if needed.

## 13. Skills inventory (per plugin; `claude` shown, `gemini` is symmetric)

### User-facing (7)

| Skill | Trigger vocabulary (sample) | Behavior |
|---|---|---|
| `claude-rescue` | "rescue with Claude", "have Claude investigate/fix", "send to Claude" | Activates `claude-rescue-agent` subagent. Subagent runs `cli-companion run --mode=rescue --background` (foreground for short rescues when user says "quickly"). Captures output, polls status, returns result. |
| `claude-review` | "have Claude review", "get Claude's feedback on", "Claude check the diff" | Foreground `cli-companion run --mode=review --isolated --dispose`. |
| `claude-adversarial-review` | "challenge with Claude", "have Claude push back", "Claude find flaws" | Foreground `cli-companion run --mode=adversarial-review --isolated --dispose`. Prompt tuned for dissent (see §16.3). |
| `claude-setup` | "set up Claude", "check Claude integration", "is Claude ready" | (1) `which claude`. (2) `cli-companion ping` using cheap model. (3) Version-floor check. (4) Prompt Y/N to install shims from `prompts-shims/` into `~/.codex/prompts/`. (5) Print a smoke-test one-liner. |
| `claude-status` | "show Claude jobs", "Claude work in flight" | `cli-companion status` — table view. Defaults to current workspace. |
| `claude-result` | "show result of Claude job X", "what did Claude say for job X" | `cli-companion result --job <id>` — stdout + metadata + git-status diff if review mode. |
| `claude-cancel` | "cancel Claude job X", "stop the Claude job" | `cli-companion cancel --job <id>`. Confirms before SIGTERM. `--force` for SIGKILL. |

### Internal (3)

| Skill | Purpose |
|---|---|
| `claude-cli-runtime` | Documents companion-script CLI contract (subcommands, flags, stdin prompt convention). Retrieved by user-facing skills so they emit correct invocations. Parity with upstream `codex-cli-runtime`. |
| `claude-result-handling` | How to render companion JSON output back to the Codex session: truncation rules for long results, git-status-diff highlighting, session-id surfacing, linking to `claude-result` for full output. Parity with upstream `codex-result-handling`. |
| `claude-prompting` | Claude-specific prompting guidance: model-choice rationale per mode, extended-thinking triggers, cache-friendly prompt structure, session-continuation patterns, subscription caveats. Parity with upstream `gpt-5-4-prompting` (re-authored for Claude). |

## 14. Subagents — `claude-rescue-agent`, `gemini-rescue-agent`

One per plugin. Context-isolated. Only rescue uses a subagent (review and adversarial-review are single-turn in the calling Codex session — mirrors upstream which only has `codex-rescue.md`).

### `claude-rescue-agent` (pattern)

- **Model:** Codex's default worker model (configurable).
- **Tools:** `Bash` only. Nothing else. Subagent's job: formulate the prompt, invoke `cli-companion run --mode=rescue`, poll status, return result.
- **System prompt:** Retrieves `claude-cli-runtime`, `claude-result-handling`, `claude-prompting` skills. Enforces:
  - Default to `--background` for rescues expected > 3 min; foreground for quick ones.
  - Surface job ID immediately on launch.
  - Poll with `status` at increasing intervals (5 s, 15 s, 45 s, 120 s, …).
  - Report via `result` when `done`.
  - On `failed`: pass raw stderr + last 50 log lines to user.
- **No file system access.** All information flows through Claude Code (the rescue target) via companion.

`gemini-rescue-agent` is symmetric, loading `gemini-prompting` instead.

## 15. Setup & OAuth

`<target>-setup` skill steps (no API keys, never):

1. **Binary check** — `which <target>`. Missing → print install URL, stop.
2. **OAuth ping** — `cli-companion ping`. If not authed → print `<target> ` (bare interactive command) and instruction to complete OAuth, stop.
3. **Version floor check** — `<target> --version` against minimum in `config/min-versions.json`. Below floor → warn, continue.
4. **Rate-limit / capacity probe** (Gemini only) — try `cheap` and `default` model pings; report which tiers are currently serving (helps debug 429 intermittents).
5. **Shim install (opt-in)** — ask Y/N per group:
   - "Install Claude-rescue / review / adversarial-review shims? (Y/n)"
   - "Install Claude-status / result / cancel shims? (Y/n)"
6. **Smoke-test suggestion** — print a one-liner the user can paste (e.g., "say to Codex: 'have Claude summarize README.md in this repo'") to validate E2E.

**Hard rules:**

- Never read or write `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or any `*_API_KEY`.
- Never attempt programmatic auth; always instruct the user to run the target CLI interactively.
- Never persist tokens or credentials.

## 16. Data contracts

### 16.1 Skill → companion invocation

Skills include a canonical shell invocation retrieved from `<target>-cli-runtime`. Prompt text goes on stdin — never argv:

```bash
cat <<'PROMPT_EOF' | node "$CODEX_PLUGIN_CLAUDE_ROOT/scripts/claude-companion.mjs" run --mode=review --isolated --dispose
<the actual prompt text, including any multi-line file contents>
PROMPT_EOF
```

Plugin root is self-resolved inside the companion via `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` (upstream pattern, verified in `codex-companion.mjs:65`). Skills reference the companion via an absolute path written into the SKILL.md at `<target>-setup` time by `setup-skill-renderer.mjs` — the renderer sees the same `import.meta.url` at plugin-install and bakes the resolved path into each SKILL.md body.

**Rationale for stdin prompt transport (not argv `--prompt`):**

- No shell-escaping concerns. argv works too (verified at 100 KB) but stdin is strictly safer.
- Matches how `gemini -p` appends stdin.
- Unlimited prompt size; no argv-limit debugging.
- No log surface exposure (argv shows in `ps`; stdin doesn't).

### 16.2 Companion stdout

**Foreground mode:** one-line JSON object per event, closed with a final `result` event matching the target's JSON format with added fields (`job_id`, `workspace_root`, `git_status_diff`).

**Background mode:** single launch event JSON, then exit:
```json
{"event":"launched","job_id":"ae1df79e-...","target":"claude","mode":"rescue","pid":12345,"started_at":"2026-04-23T14:22:00Z"}
```

**status/result/cancel:** JSON default; `--human` flag produces table output (used by `<target>-status` skill's default rendering).

### 16.3 Prompt templates per mode

Canonical templates in `<plugin-root>/prompts/` — parity with upstream:

- **rescue.md:** "You are on a rescue mission. The user's Codex session hit a wall. Investigate / fix. You have tool access."
- **review.md:** "You are reviewing a diff / file. Read-only. Find correctness, safety, and subtle-logic issues. Return structured findings."
- **adversarial-review.md:** "Challenge the design or implementation. Assume the author is wrong; find failure modes, assumption violations, and missing edge cases. Do NOT look for style nits."

User's text is appended after the template. Reviewer output is validated against `schemas/review-output.schema.json` (parity copy from upstream).

### 16.4 Subscription-scoped prompting (claude-prompting, gemini-prompting)

Skills include references on:

- Claude: model tier choice per mode; extended-thinking patterns; prompt-cache-friendly structure; `-c` forbidden; session-UUID patterns.
- Gemini: model tier choice per mode; `--approval-mode` semantics (with explicit "plan mode is NOT a sandbox, don't rely on it"); `--resume` UUID support; context-inheritance caveat.

Both exclude SDK / API / batch API content — irrelevant under subscription.

## 17. Testing strategy

### 17.1 Unit (`tests/unit/`)

- `jobs.test.mjs` — workspace scoping correctness on git and non-git dirs, atomic meta-writes, status transitions (running→done/failed/canceled), PID-liveness + command-line verification.
- `process.test.mjs` — spawn argv vector isolation (no shell), stdin prompt transport, timeout handling, signal delivery (SIGTERM → SIGKILL escalation).
- `workspace.test.mjs` — `resolveWorkspaceRoot` on git root, git subdir, worktree, non-git cwd, symlinked paths.
- `render.test.mjs` — table formatting, truncation at terminal width, git-status-diff prominence.
- `args.test.mjs` — argument parsing, unknown-flag rejection, mutual-exclusion enforcement.

### 17.2 Smoke (`tests/smoke/`)

Mock CLI binaries (`claude-mock.mjs`, `gemini-mock.mjs`) installed via `PATH=tests/smoke:$PATH`. Mock responds with deterministic JSON based on `--model` + prompt. Smoke tests exercise the companion end-to-end without real API spend.

Each user-facing skill has one smoke test: rescue / review / adversarial-review / setup / status / result / cancel × 2 plugins = 14 smoke tests.

### 17.3 E2E (`tests/e2e/`)

Runs real `claude -p` and `gemini -p`. Requires live OAuth. **Not in CI.** Documented in README with `npm run e2e:claude` / `npm run e2e:gemini`.

Each E2E test is one full cycle: ping → rescue (foreground) → review → adversarial-review → setup shim install → status → result → cancel a live background job.

### 17.4 Adversarial-review self-test

Before tagging any release, run `codex-plugin-multi` on itself via `/codex:adversarial-review` (or the target plugin's adversarial-review equivalent once wired) and respond to findings. Process parity with upstream.

## 18. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Gemini plan mode is actively unsafe (§4.5). | Belt+suspenders: `-s`, neutral cwd (`/tmp`), `--approval-mode plan`, `--dispose` (worktree/copy). README warns. |
| R2 | Claude plan mode is merely soft. Model may ignore. | `--bare`, `--disallowedTools` explicit list, `--dispose` by default on review paths, pre/post `git status` diff. |
| R3 | Model aliases silently substitute. | Full model IDs only; validate against `config/models.json` allowlist; reject unknown IDs with clear error. |
| R4 | Gemini 429 intermittent (observed on 2.5 models). | Companion wraps retry-with-backoff; clear error surface; ping-time probe in setup reports serving tiers. |
| R5 | Skill description triggers may fuzzy-match the wrong target skill (e.g., "review with Claude" activates `claude-adversarial-review` instead of `claude-review`). | Carefully tuned description vocabulary in each SKILL.md; manual trigger testing in M7. |
| R6 | Plugin-root path resolution at runtime — Codex plugin install paths are hash-versioned. | Resolved: use `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` in the companion entry point — same pattern as upstream (`codex-companion.mjs:65`). No env var needed; ES-modules locate themselves. |
| R7 | Concurrent Gemini from same cwd may still collide (semantic-level, not process-level). | Strongly recommend `--dispose` for any concurrent Gemini usage; document. |
| R8 | ACP mode deferred — may prove necessary for robust background / cancel semantics. | v2 item. v1 uses process signals + file-based polling (upstream pattern). |
| R9 | Apache-2.0 port of MIT upstream. Attribution in `NOTICE`. | Include full MIT text of upstream in NOTICE per MIT terms. Re-license our deltas under Apache-2.0. |

## 19. Milestones (preview — `writing-plans` will expand)

- **M0 — skeleton + install-path verification:** two-plugin monorepo, `plugin.json` per plugin, empty companions, `claude-setup` skill with ping only. Verify `codex plugin marketplace add github:seungpyoson/codex-plugin-multi` installs both plugins cleanly. Verify `CODEX_PLUGIN_<TARGET>_ROOT` resolution.
- **M1 — Claude foreground runtime:** port `workspace.mjs`, `tracked-jobs.mjs`, `state.mjs`, `render.mjs`, `args.mjs`, `fs.mjs`, `git.mjs`, `job-control.mjs`, `prompts.mjs`, `process.mjs` verbatim. Implement `claude.mjs` (spawn + stdin + JSON parse). `run --mode=review --foreground`, `status`, `result`, `cancel` working.
- **M2 — Claude rescue + background:** `run --background`, detached lifecycle, subagent `claude-rescue-agent`, `continue` with session-id resume.
- **M3 — Claude review isolation:** `--isolated` (`--bare`), `--dispose` (git worktree copy), pre/post `git status` diff capture, finding surfacing.
- **M4 — Claude prompting + adversarial-review:** `claude-prompting` skill content, `adversarial-review` mode tuned.
- **M5 — Gemini port:** `plugins/gemini/` mirrors `plugins/claude/` with target-specific swaps (`gemini.mjs`, stdin-based prompt, `/tmp` neutral cwd for isolation, `-s` sandbox flag).
- **M6 — Gemini rescue + background.**
- **M7 — prompts-shims + setup polish:** shim install flow, version floor, rate-limit probe in setup. Manual trigger testing (R5).
- **M8 — tests: unit + smoke + E2E.** CI pipeline (lint + unit + smoke only).
- **M9 — docs, CHANGELOG, first release tag `v0.1.0`.**

Each milestone has an adversarial-review gate before the next begins.

## 20. Success criteria

- From a fresh Codex session on an OAuth'd machine with both plugins installed, `"have Claude rescue the failing test"` launches a background Claude job, returns an ID, and renders a usable result when done — with no knowledge of the companion script.
- `"Gemini review the diff"` returns a review in `--isolated` `--dispose` mode; any file mutations detected in the user's working tree are reported prominently as a WARNING, never auto-reverted.
- All 7 user-facing actions from upstream (`rescue`, `review`, `adversarial-review`, `status`, `result`, `cancel`, `setup`) work for both targets.
- `/claude-rescue` and `/gemini-review` literal slash commands work after user opts into shims during setup.
- `codex plugin marketplace add github:seungpyoson/codex-plugin-multi` installs both plugins cleanly on a fresh machine.
- Passes the plugin's own adversarial review on itself (findings addressed or justified).
- No API keys touched. No env vars read or written. OAuth-only contract honored.
