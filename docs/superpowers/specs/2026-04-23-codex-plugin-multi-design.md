# codex-plugin-multi — Design

- **Date:** 2026-04-23
- **Status:** Draft v3 (post-empirical-verification), pending user review
- **Repo:** [`seungpyoson/codex-plugin-multi`](https://github.com/seungpyoson/codex-plugin-multi)
- **License:** Apache-2.0 (mirrors upstream)
- **Reference:** [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (Apache-2.0); [`openai/plugins`](https://github.com/openai/plugins) (canonical Codex monorepo pattern)

---

## 1. Context & goal

Upstream `openai/codex-plugin-cc` lets Claude Code delegate to Codex via `/codex:rescue`, `/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`. This project is the symmetric inverse: **two Codex plugins that let Codex delegate to Claude Code and Gemini CLI**, feature-parity with upstream.

**Why two plugins (not one):**

1. **Parity:** upstream is one plugin per target. Mirroring that gives minimum structural deviation.
2. **Empirical safety:** a Gemini call in `--approval-mode plan` autonomously rewrote 20+ files in our repo during a supposed read-only ping (§4.5). Separate plugins = separate trust boundaries.
3. **Independent release cadence:** Claude and Gemini CLIs evolve independently; breaking one shouldn't force retesting the other.
4. **Codex natively supports monorepos of multiple plugins** (§4.13): `openai/plugins` ships 100+ plugins from one repo via `.agents/plugins/marketplace.json`.

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Packaging | Two plugins (`plugins/claude/`, `plugins/gemini/`) in one monorepo. Each is standalone. Registered via a single `.agents/plugins/marketplace.json` at repo root. |
| 2 | Command namespacing | Per-target `/claude:rescue`, `/gemini:review`, etc. Each plugin has its own `status`/`result`/`cancel`. Mirrors upstream. |
| 3 | Repo | `seungpyoson/codex-plugin-multi`, Apache-2.0, public GitHub. |
| 4 | Prompting skills | One per plugin: `plugins/<target>/skills/<target>-prompting/`. Each mirrors upstream's `gpt-5-4-prompting` structure. |
| 5 | Auth | OAuth / subscription only. Plugin never reads or writes `*_API_KEY` env vars. |
| 6 | Primary user-facing surface | Native `commands/*.md` slash commands (`/claude:rescue`, `/gemini:review`, …) — NOT user-level `~/.codex/prompts/` shims. Codex plugins natively support `commands/` (§4.13). |

## 3. Non-goals (v1)

- **No MCP server.**
- **No API-key management.** No cost tracking, quota, batch API, or model-pricing optimization.
- **No droid / other CLI targets.** Claude Code + Gemini CLI only.
- **No cross-target handoff chains** (Claude → Gemini → Claude).
- **No ACP (Agent Client Protocol) mode.** Verified Gemini exposes JSON-RPC via `--acp` but it requires `protocolVersion` negotiation; v1 uses process-level `spawn`. Defer to v2.
- **No OS-level sandbox.** Neither target CLI exposes one. Layered defense + post-hoc detection is best-effort (§10).
- **No user-level `~/.codex/prompts/` shims.** Commands live inside the plugin's `commands/` directory. Dropped from v1 as unnecessary.

## 4. Empirical evidence

Every design choice below is anchored to a smoke test or inspected source. Tests ran 2026-04-23 on `spson@local`, versions: **Claude Code 2.1.118**, **Gemini CLI 0.39.0**, **Codex CLI 0.123.0**.

### 4.1 Binaries and flag surface

- `claude -p|--print` headless. Flags: `--model <id>`, `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`, `--session-id <uuid>` (UP-FRONT), `--resume <uuid>`, `--fork-session`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--bare`, `--add-dir <dirs...>`, `--allowedTools`, `--disallowedTools`, `--no-session-persistence`, `--append-system-prompt`, `--verbose`.
- `gemini -p|--prompt` headless. Flags: `-m|--model`, `--approval-mode default|auto_edit|yolo|plan`, `-s|--sandbox` (bool), `-r|--resume <latest|index|uuid>`, `--output-format text|json|stream-json`, `--include-directories`, `--list-sessions`, `--delete-session`, `--policy`, `--acp`, `-y|--yolo`.

### 4.2 Model availability (this user's OAuth plan, 2026-04-23)

| Tier | Claude | Gemini |
|---|---|---|
| cheap (pings) | `claude-haiku-4-5` (~$0.02 / trivial ping) | `gemini-3-flash-preview` |
| medium | `claude-sonnet-4-6` | `gemini-3.1-pro-preview` (only available mid-tier) |
| default (smartest) | `claude-opus-4-7` (~$0.26 / trivial ping) | `gemini-3.1-pro-preview` |

Unavailable: `gemini-2.5-flash`, `gemini-2.5-pro` (HTTP 429 "No capacity"); `gemini-3-flash`, `gemini-3.1-flash`, `gemini-3-pro`, `gemini-3.1-flash-preview` (ModelNotFoundError).

**Aliases unreliable.** `claude --model haiku` silently resolved to `claude-sonnet-4-6` under subscription. **Design uses full model IDs only.**

### 4.3 Unknown model IDs fail cleanly

- Claude: plaintext error `"There's an issue with the selected model (<id>). It may not exist or you may not have access to it."`, non-zero exit.
- Gemini: `ModelNotFoundError: Requested entity was not found.` + error-report dumped to `/var/folders/.../T/gemini-client-error-*.json`.

Companion detects by JSON-parse failure OR non-zero exit.

### 4.4 Session continuation

- Claude: `--session-id <uuid>` sets ID up front, `--resume <uuid>` resumes. Verified — context preserved across invocations.
- Gemini: no `--session-id`; server mints UUID returned in JSON (`response.session_id`). `--resume <uuid>` works despite help text claiming ordinal-only. Verified end-to-end.

### 4.5 Read-only enforcement — ⚠️ SOFT on Claude, BROKEN on Gemini

- `claude --permission-mode plan`: model-compliance based, not a sandbox.
  - Opus-class models: typically decline writes verbally.
  - `claude-haiku-4-5`: observed to IGNORE plan mode and WRITE the target file when prompt emphasized tools.
  - `--allowedTools ""` (docs: "disable all tools"): observed FAIL — file still written.
  - `--disallowedTools "Write Edit Bash NotebookEdit MultiEdit"`: observed to block in one test. Most reliable layer found.
- `gemini --approval-mode plan`: **actively unsafe**.
  - During concurrent smoke test, two `gemini -p "Reply: GEM_X"` calls in plan mode ignored the prompt, inherited project context, and autonomously invoked `write_file`/`invoke_agent`. Created 20+ files. One call: 43 API requests / 1.76M prompt tokens / 263 s.
  - Plan mode is NOT a guarantee on Gemini.
- Design consequence (§10): layered defense with multiple independent mechanisms + post-hoc detection + `--dispose` (worktree/copy isolation).

### 4.6 Context inheritance

- `claude -p` default: inherits cwd's `CLAUDE.md`, memory, skills. Verified — returned first rule of current project's CLAUDE.md verbatim.
- `claude --bare -p`: strips CLAUDE.md auto-discovery, hooks, plugin sync, auto-memory, keychain reads. Verified — "No, there is no CLAUDE.md file in the current system context."
- `gemini -p` (default from project dir): inherits project context fully.
- `gemini -p` from `/tmp`: verified — "no" when asked about project files. No `--bare` flag; neutral-cwd is the in-CLI mechanism.

### 4.7 Structured output (JSON)

Claude `--output-format json` fields: `result`, `session_id`, `model` (via `modelUsage` keys), `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage.*`, `permission_denials`, `is_error`, `terminal_reason`, `uuid`.

Gemini `--output-format json` fields: `session_id`, `response`, `stats.models.<id>.{api.*, tokens.*, roles.main.*}`.

### 4.8 stream-json output

Claude `--output-format stream-json --verbose` emits `{"type":"system","subtype":"hook_started"|"hook_response"|...}` for every hook, then assistant-message events, then final `{"type":"result",...}`. Observed 80+ KB of events for a trivial prompt due to many user hooks. **Design:** companion uses `--output-format json` (single final object) for most cases; only uses `stream-json` for rescue background jobs that want progressive UI. Filter to `type=assistant`/`type=result`.

### 4.9 Concurrency

- Claude: two parallel `claude -p` calls from same cwd — two distinct `session_id`s, both completed, no contention. ✓
- Gemini: concurrent calls ran to completion at the process level, but **both semantically failed** — ignored prompts, used tools destructively. Concurrency is safe at process layer; unsafe at semantic layer.

### 4.10 argv length

Claude with 100 000-byte argv prompt + "What was the first character?" — worked, `result: "The first character in your message was A"`, `input_tokens: 10` (cache dedup). argv at 100 KB is viable.

### 4.11 Prompt transport — per-target

- **Claude:** stdin-text is NOT read when `-p` lacks an argument (error: "Input must be provided either through stdin or as a prompt argument"). Stdin IS read only via `--input-format stream-json` (which requires `--output-format stream-json` — verbose event stream). **Decision: pass prompts via argv.** Verified safe at 100 KB; `child_process.spawn(cmd, [..., prompt])` never invokes shell.
- **Gemini:** `-p` explicitly "Appended to input on stdin" per `--help`. Verified — `echo "EXTRA: banana42" | gemini -p "what word followed 'EXTRA'?"` returned "banana42". **Decision: pass prompts via stdin** (empty `-p ''` positional, full prompt piped on stdin).

### 4.12 Hooks non-interference

`claude -p` / `gemini -p` invoked from this Claude Code session did NOT trigger this session's hooks. Verified implicitly — 15+ CLI spawns without hook blockage. Companion can invoke child CLIs freely.

### 4.13 Codex plugin surface — fuller than I initially thought

Verified by inspecting `openai/plugins` (canonical monorepo, 100+ plugins). Codex plugins support ALL of:

- **`plugin-root/.codex-plugin/plugin.json`** — per-plugin manifest. Fields: `name` (kebab-case), `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `skills` (pointer), `mcpServers`, `apps`, `interface.{displayName, shortDescription, longDescription, category, capabilities, URLs, defaultPrompt, brandColor, composerIcon, logo, screenshots}`.
- **`plugin-root/commands/<name>.md`** — slash commands. Verified in `plugins/build-macos-apps/commands/`, `plugins/vercel/commands/`, `plugins/figma/commands/`, `plugins/cloudflare/commands/`, `plugins/expo/commands/`. YAML frontmatter optional (`description`); body is Markdown instructions; `$ARGUMENTS` variable for user args; first-line heading (`# /name`) identifies the command.
- **`plugin-root/agents/<name>.md`** — plugin-level subagents. Verified in `plugins/superpowers/agents/code-reviewer.md`: YAML frontmatter (`name`, `description`, `model: inherit | <id>`) + Markdown system prompt. Other plugins use `agents/openai.yaml` (OpenAI-specific config). Our choice: `.md` + frontmatter (Claude-Code-style), parity with upstream.
- **`plugin-root/skills/<name>/SKILL.md`** — description-triggered skills (internal or opt-in).
- **`plugin-root/hooks/hooks.json`** — lifecycle hooks.
- **`plugin-root/prompts/<name>.md`** — canonical subagent/command system prompts retrieved by skills/commands.
- **`plugin-root/schemas/*.schema.json`** — JSON schemas for validating output.
- **`plugin-root/.app.json`, `plugin-root/.mcp.json`** — optional integration configs.

**Slash-command namespace:** Codex exposes `/<plugin-name>:<command-name>`. So `plugins/claude/commands/rescue.md` → `/claude:rescue ...`. No shim needed.

**Multi-plugin repo registration** — canonical file is `<repo-root>/.agents/plugins/marketplace.json`. Verified from `~/.codex/.tmp/plugins/.agents/plugins/marketplace.json` (the openai/plugins monorepo). Schema:

```json
{
  "name": "<marketplace-name>",
  "interface": { "displayName": "<display>" },
  "plugins": [
    {
      "name": "<plugin-name>",
      "source": { "source": "local", "path": "./plugins/<name>" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Install command: `codex plugin marketplace add github:seungpyoson/codex-plugin-multi` — loads the marketplace, exposes both plugins. User installs each via Codex's plugin UI or `codex plugin marketplace add <url> --sparse plugins/<name>` for individual install.

### 4.14 Apache-2.0 upstream runtime (reference for port)

Relevant files in upstream `openai/codex-plugin-cc` (MIT; we port under Apache-2.0 with attribution):

```
plugins/codex/
  commands/{rescue,review,adversarial-review,status,result,cancel,setup}.md
  agents/codex-rescue.md
  scripts/
    codex-companion.mjs                          # entry
    session-lifecycle-hook.mjs                   # [PORT]
    stop-review-gate-hook.mjs                    # [PORT]
    lib/
      workspace.mjs tracked-jobs.mjs state.mjs render.mjs
      process.mjs args.mjs fs.mjs git.mjs job-control.mjs prompts.mjs  # [COPY-VERBATIM]
      codex.mjs                                  # [REPLACE] → claude.mjs / gemini.mjs
      app-server-broker.mjs broker-endpoint.mjs broker-lifecycle.mjs
      app-server.mjs app-server-protocol.d.ts    # [DROP] — no equivalent transport for Claude/Gemini
  prompts/{adversarial-review,stop-review-gate}.md
  hooks/hooks.json
  schemas/review-output.schema.json
  skills/{codex-cli-runtime,codex-result-handling,gpt-5-4-prompting}/
```

**Plugin-root self-resolution:** `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` in `codex-companion.mjs:65`. ES-modules locate themselves; no env var needed.

## 5. Plugin surface

### Primary: native slash commands

Each plugin's `commands/<name>.md` exposes a slash command namespaced by plugin name:

- `plugins/claude/commands/rescue.md` → `/claude:rescue <args>`
- `plugins/claude/commands/review.md` → `/claude:review <args>`
- `plugins/claude/commands/adversarial-review.md` → `/claude:adversarial-review <args>`
- `plugins/claude/commands/setup.md` → `/claude:setup`
- `plugins/claude/commands/status.md` → `/claude:status`
- `plugins/claude/commands/result.md` → `/claude:result <job-id>`
- `plugins/claude/commands/cancel.md` → `/claude:cancel <job-id>`

Symmetric for `plugins/gemini/`. 14 slash commands total.

### Secondary: description-triggered skills (internal)

Skills are retrieved by the command files (via `@skill-name` references in body) or activate when a natural-language trigger matches. Three internal skills per plugin:

- `<target>-cli-runtime` — documents the companion-CLI contract for commands/agents to reference.
- `<target>-result-handling` — how to render companion output back to Codex.
- `<target>-prompting` — target-specific prompting guidance. Parity with upstream `gpt-5-4-prompting`.

User-facing skill triggers are also tuned for natural-language invocation (e.g., "rescue this with Claude" → command equivalent), but the slash commands are canonical.

## 6. File layout

```
codex-plugin-multi/                      # monorepo
  README.md
  LICENSE                                # Apache-2.0
  NOTICE                                 # attribution to upstream (MIT)
  CHANGELOG.md                           # monorepo-level
  package.json                           # workspaces: ["plugins/*"]
  .agents/
    plugins/
      marketplace.json                   # registers both plugins; see §4.13 schema
  plugins/
    claude/
      .codex-plugin/plugin.json          # name="claude", version, description, interface.displayName="Claude"
      LICENSE NOTICE CHANGELOG.md
      commands/                          # native slash commands
        rescue.md                        # /claude:rescue
        review.md                        # /claude:review
        adversarial-review.md            # /claude:adversarial-review
        setup.md                         # /claude:setup
        status.md                        # /claude:status
        result.md                        # /claude:result
        cancel.md                        # /claude:cancel
      agents/
        claude-rescue.md                 # subagent for rescue; mirror of upstream codex-rescue.md
      skills/
        claude-cli-runtime/SKILL.md      # internal — companion-CLI contract
        claude-result-handling/SKILL.md  # internal — output formatting
        claude-prompting/SKILL.md        # internal — prompting guidance
          references/
            claude-prompt-antipatterns.md
            claude-prompt-blocks.md
      scripts/
        claude-companion.mjs             # entry; path.resolve(fileURLToPath(new URL("..", import.meta.url)))
        session-lifecycle-hook.mjs       # port from upstream
        stop-review-gate-hook.mjs        # port from upstream
        lib/
          workspace.mjs tracked-jobs.mjs state.mjs render.mjs
          args.mjs fs.mjs git.mjs job-control.mjs prompts.mjs process.mjs   # COPY-VERBATIM
          claude.mjs                     # replaces upstream codex.mjs; spawns `claude -p` via argv
      prompts/
        rescue.md                        # canonical rescue system prompt
        review.md
        adversarial-review.md
        stop-review-gate.md
      hooks/hooks.json
      schemas/review-output.schema.json
    gemini/                              # symmetric — s/claude/gemini/g; lib/gemini.mjs spawns via stdin
      .codex-plugin/plugin.json          # name="gemini"
      commands/…  agents/gemini-rescue.md  skills/…  scripts/…  prompts/…  hooks/  schemas/
  tests/
    unit/
      jobs.test.mjs                      # workspace scoping, atomic writes, PID checks
      process.test.mjs                   # spawn argv safety, stdin transport, timeout, signals
      render.test.mjs                    # output formatting
      workspace.test.mjs                 # resolveWorkspaceRoot edge cases
      args.test.mjs                      # arg parsing, mutual-exclusion
    smoke/                               # CLI_COMPANION_MOCK=1 with fixture binaries
      claude-mock.mjs gemini-mock.mjs
      claude-companion.smoke.test.mjs gemini-companion.smoke.test.mjs
    e2e/                                 # real CLIs, local-only (skipped in CI)
      claude.e2e.test.mjs gemini.e2e.test.mjs
  .github/workflows/pull-request-ci.yml  # lint + unit + smoke (no e2e)
```

**Counts:** 2 plugins. 7 slash commands × 2 = **14 commands**. 1 rescue subagent × 2 = **2 agents**. 3 internal skills × 2 = **6 skills**. Plus `.agents/plugins/marketplace.json` at repo root registers both.

## 7. Runtime — `<target>-companion.mjs`

Each plugin has its own companion entry, structurally parallel to upstream `codex-companion.mjs`. Target-specific branches live in `lib/<target>.mjs`.

### 7.1 Subcommand surface (identical across both companions)

```
<target>-companion.mjs run \
  --mode=rescue|review|adversarial-review \
  [--background | --foreground] \
  [--model <full-id>] \
  [--cwd <path>] \
  [--isolated] [--dispose] \
  <prompt-source-varies-by-target>        # argv for Claude, stdin for Gemini

<target>-companion.mjs continue \
  --job <job-id> \
  <prompt-source-varies-by-target>

<target>-companion.mjs status [--job <id>]
<target>-companion.mjs result --job <id>
<target>-companion.mjs cancel --job <id> [--force]
<target>-companion.mjs ping                # OAuth health probe, cheap-tier model
<target>-companion.mjs doctor              # verbose diagnostics
```

### 7.2 Dispatch — per-target

**Claude (`lib/claude.mjs`) — prompt via argv:**

```js
// Transport: prompt is the last positional argument (argv). Verified safe at 100 KB.
spawn('claude', [
  '-p', promptText,                      // positional prompt — safe because spawn bypasses shell
  '--output-format', 'json',
  '--no-session-persistence',            // companion manages session state
  '--session-id', jobId,                 // UUID up front
  '--model', resolvedModel,
  '--permission-mode', modeToPolicy(mode),  // 'plan' for review*, 'acceptEdits' for rescue
  ...(isReview(mode)
    ? ['--disallowedTools', 'Write Edit Bash NotebookEdit MultiEdit']
    : []),
  ...(isolated ? ['--bare'] : ['--add-dir', cwd]),
], { cwd: isolated ? '/tmp' : cwd, stdio: ['ignore', 'pipe', 'pipe'] });
```

**Gemini (`lib/gemini.mjs`) — prompt via stdin:**

```js
// Transport: `-p ''` empty positional, prompt on stdin. Verified (§4.11).
const child = spawn('gemini', [
  '-p', '',
  '-m', resolvedModel,
  '--approval-mode', modeToApproval(mode),  // 'plan' for review*, 'auto_edit' for rescue
  '--output-format', 'json',
  ...(resume ? ['--resume', sessionId] : []),
  ...(isReview(mode) ? ['-s'] : []),       // sandbox flag for reviews
], { cwd: isolated ? '/tmp' : cwd, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(promptText); child.stdin.end();
```

### 7.3 Background job lifecycle

1. `run --background` fork-execs the target CLI with stdio redirected to `<workspace>/.codex-plugin-<target>/jobs/<id>/{stdout,stderr}.log`.
2. Parent writes initial `meta.json`, returns `{event: "launched", job_id, pid}` JSON on stdout, exits.
3. A detached wrapper (`detached: true` + `child.unref()`, inline in companion) waits on child, writes terminal `meta.json` (status, exit_code, ended_at).

No daemon, no IPC beyond files. Mirrors upstream.

### 7.4 OAuth health probe — `ping`

`<target>-companion.mjs ping` runs a minimal prompt with **cheap-tier model** (haiku / flash-preview) with 15 s timeout. Result categories:

- `ok` — JSON parsed, `is_error:false`/`response` non-empty.
- `not_authed` — non-zero exit + non-JSON stdout + stderr content. Companion surfaces stderr verbatim + hint: "run `<target>` interactively to complete OAuth." No hard-coded patterns (they change per version).
- `not_found` — `ENOENT` spawning. Print install URL.
- `rate_limited` — 429 in stderr. Gemini-specific retry guidance.
- `error:<raw>` — anything else, raw stderr shown.

## 8. Model selection policy

Three tiers, full IDs only (aliases unreliable — §4.2):

| Tier | Claude | Gemini |
|---|---|---|
| cheap (ping, doctor) | `claude-haiku-4-5` | `gemini-3-flash-preview` |
| medium | `claude-sonnet-4-6` | `gemini-3.1-pro-preview` |
| default (smartest) | `claude-opus-4-7` | `gemini-3.1-pro-preview` |

- **Rescue, review, adversarial-review:** `default` tier unless user overrides.
- **Ping, doctor:** `cheap` tier.
- **User override:** every command accepts `--model=<id>` argument.
- **Unknown IDs:** companion detects (JSON-parse failure OR non-zero exit) and surfaces raw error. No fallback.
- **Config file:** `plugins/<target>/config/models.json` — easy to update as availability changes.

## 9. Context isolation strategy

Two needs:

- **Rescue** wants project context (Claude/Gemini should know the cwd).
- **Review / adversarial-review** wants neutrality (reviewer unbiased by project-local rules).

| Target | Rescue | Review / adversarial-review |
|---|---|---|
| Claude | default cwd, `--add-dir <cwd>` | `--bare` (strips CLAUDE.md, memory, skills, hooks) ✓ verified |
| Gemini | default cwd | run from `/tmp` neutral cwd ✓ verified; no `--bare` equivalent exists. Optionally `--include-directories <specific-files>` to re-include scoped files |

When `--isolated` flag is passed (default for review paths), companion:

1. Spawns child with `cwd: /tmp` (or ephemeral tempdir).
2. Passes specific files via `--add-dir <file>` (Claude) or `--include-directories <file>` (Gemini).
3. Output captured via JSON.
4. Never writes back into target-cwd unless rescue mode with explicit ask.

## 10. Read-only enforcement — layered defense

Upstream has Codex's OS-level sandbox (`sandbox: "read-only"`). We have no equivalent. We layer mechanisms.

**Claude review/adversarial-review:**
```
claude -p <prompt>
  --bare                                 # Layer 1: strip cwd context (no CLAUDE.md bias)
  --permission-mode plan                 # Layer 2: soft system-instruction
  --disallowedTools "Write Edit Bash NotebookEdit MultiEdit"  # Layer 3: tool allowlist exclusion (most reliable)
  --no-session-persistence
  --output-format json
  --session-id <job-id>
  --model <id>
```

**Gemini review/adversarial-review:**
```
gemini -p ''
  -s                                     # Layer 1: --sandbox flag (best available — not process-level sandbox)
  --approval-mode plan                   # Layer 2: soft instruction (proven unreliable alone)
  -m <id>
  --output-format json
  cwd = /tmp                             # Layer 3: neutral cwd — no project context
  prompt via stdin
```

**Post-hoc detection (both targets):**

- Before review call: snapshot `git status -s --untracked-files=all` of target cwd → `<job>/git-status-before.txt`.
- After: re-snapshot → `git-status-after.txt`.
- If diff non-empty:
  1. Surface prominently in result: `⚠️ <N> file(s) modified during a read-only review.`
  2. List changed files.
  3. Do not auto-revert; user decides (`git checkout -- .` or keep).

**Escape hatch — `--dispose` (review paths, default-ON):** clones target cwd into `~/.cache/codex-plugin-<target>/disposable/<job-id>/`. Uses `git worktree add --detach` if git repo, else `cp -a`. Target CLI runs against the disposable copy; any mutation happens on throwaway. Opt-out with `--no-dispose` when user explicitly trusts the review run.

**README disclosure:** "Reviews are best-effort read-only. Gemini CLI does not expose a hard sandbox; plan-mode is model-compliance-based. Use `--dispose` (default) or commit changes before review to detect mutations."

## 11. Session continuation

- **Claude:** companion sets `--session-id <job-id>` on first launch (UUID v4 via `crypto.randomUUID()`). `continue --job <id>` runs `claude --resume <job-id> -p <followup>`. **No `-c` / last-session fallback ever.**
- **Gemini:** server mints session UUID returned in JSON; companion captures to `meta.json > session_id`. `continue --job <id>` runs `gemini --resume <captured-uuid> -p '' < stdin`. **No ordinal-index or `latest` fallback.**
- If `meta.json.session_id` missing/empty: `continue` fails closed with `SESSION_UNAVAILABLE`. User must start new job.

## 12. Job store — per-target, workspace-scoped

**Location:** `<workspace-root>/.codex-plugin-<target>/jobs/<job-id>/`

- `workspace-root` = `resolveWorkspaceRoot(cwd)` from ported upstream `lib/workspace.mjs`. Git-repo root if in git, else cwd.
- Each target has independent subtree; Claude failure can't corrupt Gemini's.

**Layout:**
```
<workspace>/.codex-plugin-claude/jobs/<uuid>/
  meta.json
  stdout.log
  stderr.log
  session.json                           # UUID + target-specific session metadata
  git-status-before.txt                  # review paths only
  git-status-after.txt                   # review paths only
  dispose-path.txt                       # --dispose path if used
```

**`meta.json`:**
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
  "disposed": true,
  "dispose_path": "/Users/spson/.cache/codex-plugin-claude/disposable/ae1df79e-...",
  "model": "claude-opus-4-7",
  "session_id": "ae1df79e-9cec-4213-a0db-0b367ee16345",
  "parent_job": null,
  "prompt_head": "First 200 chars...",
  "schema_version": 1
}
```

**ID format:** UUID v4 (required for Claude `--session-id`). Minted via `crypto.randomUUID()`.

**Atomic writes:** `meta.json.tmp` then `rename()` (POSIX atomic). Port upstream's `tracked-jobs.mjs` verbatim.

**PID liveness:** `status`/`cancel` verify PID alive AND its cmdline matches expected target binary before trust/signal. Defends against PID reuse.

**Retention:** no auto-GC in v1. `cli-companion prune --older-than 30d` can be added later.

## 13. Slash commands — inventory (per plugin; `claude` shown)

Each commands/*.md file mirrors upstream's `commands/<name>.md` structure: YAML frontmatter with `description:`, then Markdown body with instructions, `$ARGUMENTS` for user args, and references to skills/subagents.

| Command | Purpose | Behavior |
|---|---|---|
| `/claude:rescue` | Investigate/fix via Claude Code | Invokes `claude-rescue` subagent (in `agents/claude-rescue.md`). Subagent runs `claude-companion run --mode=rescue`. `--background` by default for rescues expected >3 min. |
| `/claude:review` | Get Claude's review of current diff | Foreground `claude-companion run --mode=review --isolated --dispose`. |
| `/claude:adversarial-review` | Force Claude to challenge design | Foreground `claude-companion run --mode=adversarial-review --isolated --dispose`. |
| `/claude:setup` | Check Claude readiness, no shims | (1) `which claude` (2) `claude-companion ping` cheap model (3) version floor (4) suggest smoke test. No shim install — commands are native. |
| `/claude:status` | List running/recent Claude jobs | `claude-companion status` — table. Defaults to current workspace. |
| `/claude:result` | Show result of job by ID | `claude-companion result --job <id>` — stdout + meta + git-status diff if review mode. |
| `/claude:cancel` | Cancel a background Claude job | `claude-companion cancel --job <id>`. Confirms before SIGTERM. `--force` for SIGKILL. |

Symmetric for `plugins/gemini/`.

**Command file body structure (parity with upstream):**
- Brief purpose line
- `## Arguments` (if any)
- `## Workflow` (numbered steps — each step may call `claude-companion` or retrieve an internal skill)
- `## Guardrails` (no-go conditions)

## 14. Subagents — `claude-rescue`, `gemini-rescue` (one per plugin)

Plugin-level `agents/<target>-rescue.md`. YAML frontmatter + Markdown system prompt. Parity with upstream `agents/codex-rescue.md`.

```
---
name: claude-rescue
description: Delegate investigation, an explicit fix request, or follow-up rescue work to Claude Code through the shared plugin runtime.
model: inherit
---

[System prompt: retrieve claude-cli-runtime, claude-result-handling, claude-prompting skills. Enforces: background for long rescues, surface job ID, poll status, report via result, pass stderr on failure. Bash-only tool access.]
```

Only rescue uses a subagent. Review and adversarial-review run in calling Codex session (single-turn). Mirrors upstream.

## 15. Setup — `/claude:setup`, `/gemini:setup`

Steps (no API keys, ever):

1. **Binary check** — `which <target>`. Missing → print install URL, stop.
2. **OAuth ping** — `<target>-companion ping` (cheap model). If not authed → print `<target>` (bare interactive command), stop.
3. **Version floor check** — `<target> --version` vs `plugins/<target>/config/min-versions.json`. Below floor → warn, continue.
4. **Rate-limit probe (Gemini only)** — ping cheap and default tiers, report which are currently serving (helps debug 429 intermittents).
5. **Smoke-test suggestion** — print a one-liner the user can paste (e.g., `/claude:review`) to validate E2E.

**Hard rules:**

- Never read/write `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or any `*_API_KEY` env var.
- Never programmatic auth; always instruct user to run CLI interactively.
- Never persist tokens/credentials.
- **No user-level `~/.codex/prompts/` shim install — commands are native via `commands/*.md`.**

## 16. Data contracts

### 16.1 Command → companion invocation

Each `commands/*.md` file includes an invocation snippet (retrieved content from `<target>-cli-runtime` skill). Per-target transport:

**Claude (argv):**
```bash
node "$PLUGIN_ROOT/scripts/claude-companion.mjs" run --mode=review --isolated --dispose -- "$PROMPT_TEXT"
```

Prompt text is the last argv positional. No shell concat risk — `spawn(cmd, [args])` in JS passes argv as separate C-strings; shell metacharacters are just bytes. Verified safe at 100 KB.

**Gemini (stdin):**
```bash
printf '%s' "$PROMPT_TEXT" | node "$PLUGIN_ROOT/scripts/gemini-companion.mjs" run --mode=review --isolated --dispose
```

Prompt text on stdin. `gemini -p ''` empty positional forces stdin-append mode.

`$PLUGIN_ROOT` resolved inside companion via `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` (upstream pattern). Commands and subagents never need to know the plugin-root path.

### 16.2 Companion stdout

**Foreground:** single JSON object (per target's native `--output-format json`) with added fields (`job_id`, `workspace_root`, `git_status_diff` if review).

**Background mode:** single launch event JSON, then exit:
```json
{"event":"launched","job_id":"ae1df79e-...","target":"claude","mode":"rescue","pid":12345,"started_at":"..."}
```

**status/result/cancel:** JSON default; `--human` flag for table output (used by `commands/status.md` default rendering).

### 16.3 Prompt templates per mode

Canonical templates in `plugins/<target>/prompts/` — parity with upstream:

- `rescue.md` — "You are on a rescue mission. Investigate / fix. Tool access granted."
- `review.md` — "You are reviewing a diff / file. Read-only. Find correctness, safety, subtle-logic issues. Return structured findings."
- `adversarial-review.md` — "Challenge the design. Assume the author is wrong; find failure modes, assumption violations, missing edge cases. No style nits."

User text appended after template. Output validated against `schemas/review-output.schema.json`.

### 16.4 Subscription-scoped prompting skills

`plugins/<target>/skills/<target>-prompting/SKILL.md`:

- **Claude:** model-tier rationale per mode, extended-thinking patterns, prompt-cache-friendly structure, `-c` forbidden, session-UUID patterns.
- **Gemini:** model-tier rationale, `--approval-mode` semantics ("plan is NOT a sandbox, never trust it"), `--resume` UUID support (undocumented but works), context-inheritance caveat.
- **Both** exclude SDK/API/batch-API content — irrelevant under subscription.

## 17. Testing strategy

### 17.1 Unit (`tests/unit/`)

- `jobs.test.mjs` — workspace scoping on git/non-git dirs, atomic meta-writes, status transitions, PID-liveness + cmdline verification.
- `process.test.mjs` — spawn argv isolation (no shell), Claude-argv vs Gemini-stdin transport, timeout, SIGTERM→SIGKILL escalation.
- `workspace.test.mjs` — `resolveWorkspaceRoot` on git root, subdir, worktree, non-git cwd, symlinks.
- `render.test.mjs` — table formatting, truncation at terminal width, git-status-diff prominence.
- `args.test.mjs` — parsing, unknown-flag rejection, mutex enforcement.

### 17.2 Smoke (`tests/smoke/`)

`claude-mock.mjs`, `gemini-mock.mjs` — deterministic JSON fixtures keyed on `--model` + prompt. Installed via `PATH=tests/smoke:$PATH`. Smoke tests exercise the companion E2E without real API spend.

Per-plugin: 7 smoke tests (one per command). 2 plugins × 7 = 14 smoke tests.

### 17.3 E2E (`tests/e2e/`)

Real `claude -p` / `gemini -p`. Requires live OAuth. **Not in CI.** `npm run e2e:claude` / `npm run e2e:gemini`.

### 17.4 Self-adversarial-review

Before any release, run `/codex:adversarial-review` (upstream) against our spec and code. Respond to findings.

## 18. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Gemini plan mode is actively unsafe (§4.5). | Belt+suspenders: `-s`, neutral cwd, plan mode, `--dispose` copy. README warns. |
| R2 | Claude plan mode is soft — model may ignore. | `--bare`, `--disallowedTools`, `--dispose` default, pre/post `git status` diff. |
| R3 | Model aliases silently substitute. | Full IDs only; allowlist in `config/models.json`; reject unknown with clear error. |
| R4 | Gemini 429 intermittent on 2.5 models. | Companion retries with backoff; setup probes and reports serving tiers. |
| R5 | Plugin-root path resolution on hash-versioned installs. | Resolved — use `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` (upstream pattern, `codex-companion.mjs:65`). |
| R6 | Concurrent Gemini at semantic layer (both runs wrote files during a supposed read-only test). | `--dispose` default for reviews + strong README warning. Serialize Gemini jobs per workspace via simple lockfile if observed to matter in practice. |
| R7 | `commands/*.md` description triggers may fuzzy-match (e.g., "review" activates adversarial-review). | Tuned descriptions; slash-command invocation (`/claude:review`) is canonical and unambiguous; natural-language as fallback only. |
| R8 | Multi-plugin repo install: does `codex plugin marketplace add github:<url>` install both from one repo? | Resolved — verified via `openai/plugins` (100+ plugins in one repo, uses `.agents/plugins/marketplace.json`). Our marketplace.json follows the same schema. |
| R9 | Apache-2.0 port of MIT upstream. | `NOTICE` includes full MIT text of upstream + attribution. Our deltas Apache-2.0. |
| R10 | ACP mode deferred to v2. Background/cancel may prove flaky. | v1 uses process signals + file-polling (upstream pattern). Revisit if cancel reliability is insufficient. |

## 19. Milestones (preview — `writing-plans` will expand)

- **M0 — skeleton + install-path verification:** two-plugin monorepo, `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json` per plugin (manifests only), empty `<target>-companion.mjs` entries, one trivial `commands/setup.md` per plugin. Verify `codex plugin marketplace add github:seungpyoson/codex-plugin-multi` installs BOTH plugins cleanly. Verify `import.meta.url` plugin-root resolution.
- **M1 — shared lib port:** copy-verbatim `workspace.mjs`, `tracked-jobs.mjs`, `state.mjs`, `render.mjs`, `args.mjs`, `fs.mjs`, `git.mjs`, `job-control.mjs`, `prompts.mjs`, `process.mjs` from upstream. Duplicated per plugin directory (symmetric monorepo structure, 100% identical copies).
- **M2 — Claude foreground runtime:** implement `claude.mjs` (spawn argv, JSON parse, session-id set). `run --mode=review --foreground`, `status`, `result`, `cancel` working.
- **M3 — Claude commands + agent:** port `commands/{rescue,review,adversarial-review,status,result,cancel,setup}.md` from upstream structure. Implement `agents/claude-rescue.md` subagent. Foreground flow end-to-end.
- **M4 — Claude background + continue:** `run --background`, detached lifecycle, `continue --job <id>`, session-id resume.
- **M5 — Claude review isolation:** `--isolated` (`--bare`), `--dispose` (git worktree / cp -a), pre/post `git status` diff capture.
- **M6 — Claude prompting skill:** write `skills/claude-prompting/SKILL.md` + references.
- **M7 — Gemini port:** `plugins/gemini/` mirrors `plugins/claude/` with target-specific swaps in `gemini.mjs` (stdin transport, `/tmp` cwd for isolation, `-s`).
- **M8 — Gemini rescue + background.**
- **M9 — tests: unit + smoke (mock CLIs) + E2E.** CI pipeline (lint + unit + smoke).
- **M10 — docs, CHANGELOG, v0.1.0 release tag.** Run upstream `/codex:adversarial-review` on this repo; respond to findings.

Each milestone has an adversarial-review gate before the next begins.

## 20. Success criteria

- `codex plugin marketplace add github:seungpyoson/codex-plugin-multi` installs both plugins on a fresh machine. Codex surfaces `/claude:*` and `/gemini:*` slash commands.
- `/claude:rescue investigate why the test is failing` launches a background Claude job, returns job ID, and `/claude:result <id>` eventually renders a usable result — no knowledge of companion script required.
- `/gemini:review` returns a review in `--isolated --dispose` mode. If the run causes any file mutation in the user's working tree, it's reported prominently as WARNING, never auto-reverted.
- All 7 actions (rescue, review, adversarial-review, status, result, cancel, setup) work for both targets.
- Passes its own adversarial review on itself (findings addressed or justified).
- No API keys touched. No `*_API_KEY` env vars read or written.
