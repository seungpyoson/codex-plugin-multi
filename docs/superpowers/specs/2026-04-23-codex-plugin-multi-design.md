# codex-plugin-multi — Design

- **Date:** 2026-04-23 (v3) / 2026-04-24 (v4 — full empirical re-verification) / **2026-04-24 (v5 — architectural invariants)**
- **Status:** Draft v5, post-M6 cross-model review
- **Repo:** [`seungpyoson/codex-plugin-multi`](https://github.com/seungpyoson/codex-plugin-multi)
- **License:** Apache-2.0 (mirrors upstream)
- **Reference:** [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) (MIT — Claude Code plugin calling Codex); [`openai/plugins`](https://github.com/openai/plugins) (canonical Codex monorepo pattern)

## What changed in v5 (from v4)

After M6 a cross-model review (Codex + Gemini + Claude) surfaced eight merge-blocker-class defects in the Claude path. Each was individually small, but they collapsed to four structural gaps where the v4 spec left invariants **implicit**. v5 makes those invariants **explicit** and load-bearing — the same code cannot be written twice and drift apart, because the type/contract names the rule.

Four new invariants, §§21.1–21.4 below:

- **§21.1 — Identity types are distinct.** `job_id`, `claude_session_id`, `resume_chain`, and `pid_info` are four different things; the code has one field per identity, never conflated.
- **§21.2 — Mode is the only source of mode-specific defaults.** All mode-correlated knobs (model tier, stripContext, permission mode, disallowed tools, containment, scope, dispose default) live in a single `ModeProfile` table. `spawnClaude` / `spawnGemini` take a profile, not individual knobs with defaults.
- **§21.3 — One `JobRecord` shape, persisted and returned.** The file `cmdResult` reads is the same shape the foreground stdout prints and the skill documentation describes. No per-path hand-assembled blobs.
- **§21.4 — Containment and scope are orthogonal.** `containment` ∈ {none, worktree} answers "where does Claude write." `scope` ∈ {working-tree, staged, branch-diff, head, custom} answers "what does Claude see." Each mode picks both; a review of a dirty working tree actually reviews the dirty working tree.

Plus one operational invariant:

- **§21.5 — Shared-lib contract is importability + behavior, not byte-identity.** Byte-identity catches drift but misses dead modules with broken imports (v4 shipped one). v5 requires every shared lib to pass `await import(…)` plus a per-module smoke.

§§21.1–21.5 are what the M7+ code is judged against. Existing §§4, 6, 9, 10, 11, 16 remain authoritative for CLI mechanics; §21 governs architecture.

---

## What changed in v4 (from v3)

Every load-bearing assertion was re-verified empirically or against codex-rs source. 17 corrections / additions, summarized at the end of this section. Key reversals:

- **Slash commands are BARE, not namespaced.** `/claude-rescue`, not `/claude:rescue`. Source: `openai/plugins` ships 100+ plugins using bare command names (`/implement-from-figma`, `/deploy`).
- **`--bare` is incompatible with OAuth.** Per Claude `--help`: "OAuth and keychain are never read." Replaced with `--setting-sources ""` which strips CLAUDE.md while preserving OAuth.
- **Gemini read-only enforcement requires TOML `--policy` files.** Plan mode auto-escalates to YOLO in non-interactive mode (per Gemini docs `plan-mode.md:487-495`). Policy files are the only reliable layer.
- **Supported Codex hook events are exactly 5**: `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit`. No `SessionEnd`. Source: `codex-rs/core/config.schema.json:868-896`.
- **`allowed-tools` command-frontmatter is advisory**, not enforced. Enforcement lives in the target CLI (Claude `--disallowedTools`, Gemini `--policy`).
- **Plugin commands are TUI-only.** `codex exec "/claude-rescue ..."` sends the string as literal prompt text, not a command invocation. Verified empirically.

---

## 1. Context & goal

Upstream `openai/codex-plugin-cc` is a **Claude Code plugin** that lets Claude Code delegate to Codex (e.g., `/codex:rescue`). This project is the symmetric inverse: **two Codex plugins** that let Codex delegate to Claude Code and Gemini CLI, feature-parity with upstream's command set.

**Why two plugins (not one):**

1. **Parity:** upstream is one plugin per target. Mirroring that gives minimum structural deviation.
2. **Empirical safety:** Gemini in `--approval-mode plan` autonomously rewrote 20+ files during a supposed read-only ping (§4.5 / 4.17). Separate plugins = separate trust boundaries + independent disable.
3. **Independent release cadence:** Claude and Gemini CLIs evolve independently; breaking one shouldn't force retesting the other.
4. **Codex natively supports multi-plugin monorepos** (§4.13): `openai/plugins` ships 100+ plugins from one repo via `.agents/plugins/marketplace.json`.

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Packaging | Two plugins (`plugins/claude/`, `plugins/gemini/`) in one monorepo. Each is standalone. Registered via a single `.agents/plugins/marketplace.json` at repo root. |
| 2 | Slash-command naming | **Bare names, not namespaced:** `/claude-rescue`, `/gemini-review`, etc. Avoid collisions with Codex builtins (`stop`, `plan`, `clear`, `fast`, `settings`, `apps`, `plugins`, `collab`, `personality`, `realtime`). |
| 3 | Repo | `seungpyoson/codex-plugin-multi`, Apache-2.0, public GitHub. |
| 4 | Prompting skills | One per plugin: `plugins/<target>/skills/<target>-prompting/`. Mirrors upstream's `gpt-5-4-prompting` structure. |
| 5 | Auth | OAuth / subscription only. Plugin never reads or writes `*_API_KEY` env vars. |
| 6 | Primary user-facing surface | Native `commands/*.md` slash commands via Codex TUI. `codex exec` cannot invoke them (TUI-only; verified §4.18). |
| 7 | Shared-lib port strategy | Parametrize upstream's 10 lib files for target-neutrality; duplicate per plugin (two physical copies; content-identical except for target name). See §6.2 + §21.5. |
| 8 | Architectural invariants | §21 (v5) is load-bearing. All five invariants (21.1–21.5) MUST hold; a PR that violates one is a spec defect, not a code defect. |

## 3. Non-goals (v1)

- **No MCP server.**
- **No API-key management.** No cost tracking, quota, batch API, or model-pricing optimization.
- **No droid / other CLI targets.** Claude Code + Gemini CLI only.
- **No cross-target handoff chains.**
- **No ACP mode.** v1 uses process-level `spawn`. Defer to v2.
- **No OS-level sandbox.** Neither target CLI exposes one. Layered defense + post-hoc detection is best-effort (§10).
- **No user-level `~/.codex/prompts/` shims.** Commands live in the plugin's `commands/`.
- **No hook-based review gate (v1).** Upstream's stop-review-gate hook is deferred; hook timeout is enforced (default 5 s, verified §4.19) and makes a gated workflow fragile.

## 4. Empirical evidence

Every design choice below is anchored to a source citation or live test. Environment 2026-04-23 / 2026-04-24: **Claude Code 2.1.118**, **Gemini CLI 0.39.0** (docs), **Codex CLI 0.123.0**, codex-rs source inspected at `github.com/openai/codex@main`.

### 4.1 Binaries and flag surface

**Claude `-p|--print`:** `--model <id>`, `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`, `--session-id <uuid>` (up-front client-generated), `--resume <uuid>`, `--fork-session`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--bare` ⚠️ breaks OAuth, `--setting-sources <user,project,local|"">`, `--add-dir <dirs...>`, `--allowedTools <tools...>`, `--disallowedTools <tools...>`, `--no-session-persistence`, `--append-system-prompt`, `--json-schema <schema>`, `--verbose`, `--include-hook-events`, `--include-partial-messages`.

**Gemini `-p|--prompt`:** `-m|--model <id>`, `--approval-mode default|auto_edit|yolo|plan` ⚠️ auto-escalates to YOLO non-interactively, `-s|--sandbox`, `-r|--resume <latest|index|uuid>`, `--output-format text|json|stream-json`, `--include-directories`, `--policy <files>` (TOML), `--admin-policy`, `--acp`, `-y|--yolo`, `--list-sessions`, `--delete-session`, `--allowed-tools` (deprecated — use `--policy`).

### 4.2 Model availability (OAuth subscription, 2026-04-23)

| Tier | Claude | Gemini |
|---|---|---|
| cheap (pings/doctor) | `claude-haiku-4-5-20251001` | `gemini-3-flash-preview` |
| medium | `claude-sonnet-4-6` | `gemini-3.1-pro-preview` |
| default (smartest) | `claude-opus-4-7` | `gemini-3.1-pro-preview` |

Aliases silently substitute (`claude --model haiku` → `claude-sonnet-4-6`). **Full model IDs only.**

### 4.3 Unknown model IDs fail cleanly

- Claude: plaintext error, non-zero exit.
- Gemini: `ModelNotFoundError` + error-report dumped to `/tmp/gemini-client-error-*.json`.

Companion detects via JSON-parse failure OR non-zero exit.

### 4.4 Session continuation — verified live

- **Claude:** client generates UUID → passes `--session-id <uuid>` up-front → result echoes same UUID → next call uses `--resume <same-uuid>` and recalls prior turn. Verified end-to-end 2026-04-24.
- **Gemini:** server mints UUID returned in JSON `session_id`. `--resume latest` and `--resume <index>` confirmed. `--resume <uuid>` works but JSON output schema varies — prefer `latest`/index for programmatic reliability.

### 4.5 Read-only enforcement — layered

**Claude (target CLI):**
- `--permission-mode plan` — model-compliance-based; haiku tier occasionally writes.
- `--disallowedTools "Write Edit MultiEdit NotebookEdit Bash WebFetch Agent Task mcp__*"` — hard blocklist, most reliable layer.
- `--allowedTools "Read Glob Grep"` — safer inversion.
- `permission_denials[]` in result reports tool-call rejections. Model-pre-emption (plan-mode refusal before attempting tool) does NOT appear here — only actual tool calls that got denied.

**Gemini (target CLI):**
- `--approval-mode plan` alone is **not sufficient** — docs (`plan-mode.md:487-495`) confirm it auto-switches to YOLO in non-interactive mode.
- `--policy <toml-file>` with `[[rule]] decision = "deny"` rules is the **real enforcement layer**. Verified 2026-04-24: deny rules for `write_file`, `replace`, `run_shell_command` blocked direct tool calls AND subagent fallback (`LocalAgentExecutor] Blocked call: Unauthorized tool call`). No file created.

**Codex plugin command frontmatter** (`allowed-tools: [...]`) is **advisory to the model, NOT enforced.** No enforcement code exists in `codex-rs`; the field is only referenced in `core/templates/memories/consolidation.md:688`. Enforcement lives at the target-CLI layer.

### 4.6 Context isolation — what strips CLAUDE.md vs what doesn't

Live test 2026-04-24 with `/tmp/bare-test/CLAUDE.md` containing a unique secret + user-level `~/.claude/CLAUDE.md`:

| Option | Project CLAUDE.md | User CLAUDE.md | OAuth |
|---|---|---|---|
| `--bare` | stripped | stripped | **❌ breaks** |
| `--setting-sources ""` | stripped | stripped | ✅ works |
| `--setting-sources user` | stripped | loaded | ✅ works |
| cwd without CLAUDE.md | n/a | loaded | ✅ works |
| `--add-dir <dir>` | not auto-loaded | loaded | ✅ works |

**Decision:** use `--setting-sources ""` as the drop-in replacement for `--bare`. OAuth preserved; all CLAUDE.md context stripped.

For Gemini: no equivalent flag. Run from `/tmp` (neutral cwd) + scoped `--include-directories` to re-grant access to needed files.

### 4.7 Structured output

- **Claude `--output-format json`:** fields include `result` (text), `session_id`, `total_cost_usd`, `usage.*`, `permission_denials[]`, `is_error`, `terminal_reason`, `apiKeySource`, **`structured_output`** (when `--json-schema` is passed — schema-compliant JSON lands HERE, not in `result`).
- **Gemini `--output-format json`:** `session_id`, `response`, `stats.models.<id>.{api.*, tokens.*}`.

### 4.8 `--json-schema` — soft contract

Claude accepts `--json-schema <schema>`. When used, schema-compliant JSON lands in `structured_output`, `result` is empty. Verified 2026-04-24 with sonnet-4-6 + a realistic review schema. **Consumers must read `structured_output`, not `result`.** Treat as soft contract — model may still produce non-conforming output; code must tolerate and fall back to text parsing or retry.

### 4.9 stream-json output

Claude `--output-format stream-json --verbose` emits events: `{"type":"system","subtype":"init"}` (carries `session_id`, tools, model, plugins, agents, skills), `{"type":"assistant","message":{content:[thinking|text]}}` events, final `{"type":"result",...}`. Design uses `--output-format json` (single final object) for most cases; stream-json reserved for long-running background rescues that want progressive UI.

### 4.10 Concurrency

Two parallel `claude -p` calls from same cwd — distinct `session_id`s, both complete, no contention. Gemini concurrent calls run to completion at the process layer but can both semantically fail (both wrote files during a supposed read-only test, §4.17).

### 4.11 Prompt transport — per-target (verified live)

- **Claude:** stdin-text is NOT read with `-p` + positional; stdin only read via `--input-format stream-json`. **Use argv** — `child_process.spawn('claude', [..., promptText])` never invokes shell, safe at 100 KB (verified).
- **Gemini:** `-p '' + stdin` works; stdin is appended to (empty) `-p` positional. Verified: `echo "READY prompt" | gemini -p ""` returned "READY". **Use stdin.**

### 4.12 Hooks non-interference

`claude -p` / `gemini -p` invoked from within a Claude Code session do NOT trigger that host session's hooks. 15+ CLI spawns across verification without host-hook interference.

### 4.13 Codex plugin surface — verified from `openai/plugins` monorepo

Codex plugins support:

- **`plugin-root/.codex-plugin/plugin.json`** — per-plugin manifest. Fields: `name` (kebab-case), `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `skills` (pointer), `apps` (pointer to `.app.json`), `interface.{displayName, shortDescription, longDescription, developerName, category, capabilities, websiteURL, privacyPolicyURL, termsOfServiceURL, defaultPrompt, brandColor, composerIcon, logo, screenshots}`. `apps` and `.mcp.json` are optional — we ship neither.
- **`plugin-root/commands/<name>.md`** — slash commands. Frontmatter is **optional**; when present, recognized keys are `description`, `argument-hint`, `allowed-tools` (advisory). `$ARGUMENTS` in body text is substituted with user's arg string (model-side — not shell substitution, no injection risk at transport). Figma commands use no frontmatter; Vercel/Cloudflare use minimal.
- **`plugin-root/agents/<name>.md`** — plugin-level subagents. Frontmatter: `name`, `description`, `model: inherit | <id>`, `tools: <comma-separated>`, `skills: <list>`. Verified from `plugins/superpowers/agents/code-reviewer.md` and upstream `plugins/codex/agents/codex-rescue.md`.
- **`plugin-root/skills/<name>/SKILL.md`** — description-triggered skills. Frontmatter: `name`, `description`, `disable-model-invocation` (optional), `user-invocable` (optional).
- **`plugin-root/hooks/hooks.json` or `plugin-root/hooks.json`** — either location works; both observed in `openai/plugins`. Supported events (authoritative from `codex-rs/core/config.schema.json:868-896`): **`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit`**. NOT supported: `SessionEnd`, `Notification`, `SubagentStop`, `PreCompact`. Hooks run with **cwd = plugin root** (observed: figma uses relative `./scripts/foo.sh`). **No `${CODEX_PLUGIN_ROOT}` env var is exposed.**
- **`plugin-root/prompts/<name>.md`** — canonical system prompts retrieved by commands/agents.
- **`plugin-root/schemas/*.schema.json`** — JSON schemas. Not consumed by Codex directly; used by our runtime for `--json-schema` validation.

**Slash command namespace (verified):** Codex exposes **bare** command names (`/deploy`, `/implement-from-figma`). No `plugin:command` namespacing. Names that collide with Codex builtins are shadowed by the builtin. Source: `codex-rs/tui/src/bottom_pane/slash_commands.rs`.

**Multi-plugin registration (verified live):** `<repo-root>/.agents/plugins/marketplace.json`:

```json
{
  "name": "<marketplace-name>",
  "interface": { "displayName": "<display>" },
  "plugins": [
    {
      "name": "<plugin-name>",
      "source": { "source": "local", "path": "./plugins/<name>" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_USE" },
      "category": "Coding"
    }
  ]
}
```

**`authentication` accepts only `"ON_INSTALL"` or `"ON_USE"`.** `"NEVER"` rejected at install. Use `ON_USE` for plugins that require no auth.

**Install:** `codex plugin marketplace add seungpyoson/codex-plugin-multi` (owner/repo shorthand resolves to `https://github.com/owner/repo.git`). Registered name comes from the `name` field of the marketplace.json, NOT the URL — important for scripting `remove`. Verified live 2026-04-24.

`--sparse <path>` flag **only works for git sources**, not local paths. Users install the whole marketplace and enable individual plugins via Codex TUI (`/plugins` command — Space to toggle, Enter for details). Config-based enable also works: `-c 'plugins."name@marketplace".enabled=true'`.

### 4.14 Upstream reference — files to port (Apache-2.0 port of MIT)

`openai/codex-plugin-cc` structure (note: it's a **Claude Code** plugin, uses `.claude-plugin/plugin.json`):

```
plugins/codex/
  commands/{rescue,review,adversarial-review,status,result,cancel,setup}.md
  agents/codex-rescue.md
  scripts/
    codex-companion.mjs
    session-lifecycle-hook.mjs
    stop-review-gate-hook.mjs
    lib/
      workspace.mjs tracked-jobs.mjs state.mjs render.mjs
      process.mjs args.mjs fs.mjs git.mjs job-control.mjs prompts.mjs
      codex.mjs                                  # REPLACE → claude.mjs / gemini.mjs
      app-server-broker.mjs broker-endpoint.mjs broker-lifecycle.mjs
      app-server.mjs app-server-protocol.d.ts    # DROP (no ACP analog for Claude/Gemini v1)
  prompts/{adversarial-review,stop-review-gate}.md
  hooks/hooks.json
  schemas/review-output.schema.json
  skills/{codex-cli-runtime,codex-result-handling,gpt-5-4-prompting}/
```

**Shared-lib target-agnostic audit (grep results 2026-04-24):**

| File | Codex refs | Action |
|---|---|---|
| `workspace.mjs` | 0 | copy verbatim |
| `process.mjs` | 0 | copy verbatim |
| `args.mjs` | 0 | copy verbatim |
| `git.mjs` | 0 | copy verbatim |
| `job-control.mjs` | 0 | copy verbatim |
| `prompts.mjs` | 0 | copy verbatim |
| `state.mjs` | 2 (`FALLBACK_STATE_ROOT_DIR = "codex-companion"`, `SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"`) | parametrize: accept `{tmpdirPrefix, sessionIdEnv}` at module init |
| `tracked-jobs.mjs` | 1 (stderr prefix `[codex]`) | parametrize: accept `{stderrPrefix}` |
| `fs.mjs` | 1 (`createTempDir(prefix = "codex-plugin-")`) | parametrize: accept `{tmpPrefix}` |
| `render.mjs` | 22 (display strings like `"# Codex Setup"`, `"# Codex Status"`, `"codex resume"`) | per-plugin copy with target-specific strings |

**Plugin-root self-resolution:** `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` in `codex-companion.mjs:65`. ES-modules locate themselves; no env var needed. This works because no `${CODEX_PLUGIN_ROOT}` is exposed (§4.13).

### 4.15 User-message wire format (verified live via session jsonl)

Codex sends user messages as:

```json
{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}
```

`AGENTS.md` gets prepended as a separate user message. In TUI, command `.md` body text is injected into `input_text` on each invocation. **Command bodies are consumed in full per invocation** → keep them concise; push detail to skills that get retrieved on demand.

### 4.16 `$ARGUMENTS` substitution

Only documented reference in codex-rs source is `core/templates/memories/consolidation.md:693`: "Use `$ARGUMENTS`, `$ARGUMENTS[N]`, or `$N` for user-provided arguments." **No shell substitution.** The model sees the placeholder text + user args in-turn and interpolates from context. No shell-injection surface at transport (our stdin/argv safety holds). Normal LLM prompt-injection surface remains.

### 4.17 Gemini plan-mode escalation (documented)

Per `~/.npm-global/lib/node_modules/@google/gemini-cli/bundle/docs/cli/plan-mode.md:487-495`:

> "Automated implementation: When exiting Plan Mode to execute the plan, Gemini CLI automatically switches to YOLO mode instead of the standard Default mode. This allows the CLI to execute the implementation steps automatically without hanging on interactive tool approvals."

This explains the v3 "20 files rewritten" incident. Plan mode is **not** a sandbox headlessly. The real safety layer is `--policy` TOML deny rules.

### 4.18 TUI-only command invocation (verified)

`codex exec "/claude-rescue investigate X"` sent the literal string as user prompt; no command dispatch occurred. Session jsonl confirms: user message was `{"text":"reply ok"}` verbatim (I passed `"reply ok"` in the retest). Plugin commands are **TUI-only**. Implication: our commands are invoked by users via Codex TUI, and there's no programmatic path for Codex-CI-style invocation.

### 4.19 Hook timeout — enforced

Live probe 2026-04-24 with `$CODEX_HOME/hooks.json` defining UserPromptSubmit hook = `sleep 8`, `timeout: 2`:
- Hook fired (start-of-run timestamp logged).
- Process killed at 2 s (no end timestamp).
- Codex turn completed successfully despite hook kill.

**Consequence:** hooks are given a budget; killed hooks produce no output (e.g., `{"decision":"block"}` emitted after timeout is lost). Set generous timeouts for any gate that does real work (upstream's stop-review-gate used 900 s).

### 4.20 Cost attribution under OAuth

Claude call with OAuth: `apiKeySource: None`, `total_cost_usd: 0.011` reported. The cost figure under OAuth is the equivalent API cost, **not** a billing line — calls count against the subscription's quota. For our design, this means the plugin never surfaces a billing number; cost is visible only as the `total_cost_usd` field in debug output.

---

## 5. Plugin surface

### 5.1 Native slash commands (bare names)

Each plugin ships `commands/<name>.md` files; Codex exposes them as bare slash commands (§4.13). **14 total:**

| Claude | Gemini |
|---|---|
| `/claude-rescue` | `/gemini-rescue` |
| `/claude-review` | `/gemini-review` |
| `/claude-adversarial-review` | `/gemini-adversarial-review` |
| `/claude-setup` | `/gemini-setup` |
| `/claude-status` | `/gemini-status` |
| `/claude-result` | `/gemini-result` |
| `/claude-cancel` | `/gemini-cancel` |

Names verified non-colliding with Codex builtins. Avoided: `stop`, `plan`, `clear`, `fast`, `settings`, `apps`, `plugins`, `collab`, `personality`, `realtime`.

### 5.2 Description-triggered skills (internal, per plugin)

- `<target>-cli-runtime` — companion-CLI invocation contract retrieved by commands.
- `<target>-result-handling` — how to render companion output back to Codex.
- `<target>-prompting` — target-specific prompting guidance (parity with upstream `gpt-5-4-prompting`).

All marked `user-invocable: false` (internal only; retrieved by commands/agents).

### 5.3 Subagents (one per plugin)

- `agents/claude-rescue.md` — long-running rescue subagent.
- `agents/gemini-rescue.md` — long-running rescue subagent.

Review and adversarial-review run single-turn in the calling Codex session (no subagent).

## 6. File layout

```
codex-plugin-multi/
  README.md
  LICENSE                                        # Apache-2.0
  NOTICE                                         # attribution to upstream (MIT)
  CHANGELOG.md
  package.json                                   # workspaces: ["plugins/*"]
  .agents/
    plugins/
      marketplace.json                           # §4.13 schema, auth: ON_USE
  plugins/
    claude/
      .codex-plugin/plugin.json                  # name="claude"
      LICENSE NOTICE CHANGELOG.md
      commands/
        rescue.md review.md adversarial-review.md
        setup.md status.md result.md cancel.md   # 7 files; bare names via frontmatter
      agents/
        claude-rescue.md
      skills/
        claude-cli-runtime/SKILL.md
        claude-result-handling/SKILL.md
        claude-prompting/
          SKILL.md
          references/{claude-prompt-antipatterns.md,claude-prompt-blocks.md}
      scripts/
        claude-companion.mjs                     # entry
        session-lifecycle-hook.mjs               # ported (if adopted; v1 may skip)
        lib/
          workspace.mjs tracked-jobs.mjs state.mjs render.mjs
          args.mjs fs.mjs git.mjs job-control.mjs prompts.mjs process.mjs
          claude.mjs                             # replaces upstream codex.mjs
      prompts/
        rescue.md review.md adversarial-review.md
      hooks/hooks.json                           # optional; v1 ships with no hooks
      schemas/review-output.schema.json
      config/
        models.json                              # tiered IDs
        min-versions.json                        # CLI version floor
    gemini/                                      # symmetric
      .codex-plugin/plugin.json                  # name="gemini"
      commands/ agents/ skills/ scripts/ prompts/ hooks/ schemas/ config/
      policies/
        read-only.toml                           # deny write_file/replace/run_shell_command
  tests/
    unit/ smoke/ e2e/
  .github/workflows/pull-request-ci.yml          # lint + unit + smoke
```

**Counts:** 2 plugins. 14 commands. 2 subagents. 6 skills. 1 top-level marketplace.json.

### 6.2 Shared-lib port strategy

10 upstream lib files are copied per plugin (two physical copies — one under `plugins/claude/scripts/lib/`, one under `plugins/gemini/scripts/lib/`). Six are copy-verbatim (target-neutral); four require parametrization at module init (§4.14):

```js
// lib/state.mjs becomes:
export function createState({ tmpdirPrefix, sessionIdEnv }) { ... }
// plugins/claude/scripts/claude-companion.mjs:
import { createState } from './lib/state.mjs';
const state = createState({ tmpdirPrefix: 'claude-companion', sessionIdEnv: 'CLAUDE_COMPANION_SESSION_ID' });
```

Same pattern for `tracked-jobs.mjs` (`stderrPrefix`), `fs.mjs` (`tmpPrefix`). `render.mjs` is the most divergent — per-plugin copies with target-specific display strings ("# Claude Setup" vs "# Gemini Setup").

Upstream files explicitly dropped: `app-server*.mjs`, `broker*.mjs` (Codex's ACP transport has no analog for Claude/Gemini in v1).

## 7. Runtime — `<target>-companion.mjs`

### 7.1 Subcommand surface

```
<target>-companion.mjs run \
  --mode=rescue|review|adversarial-review \
  [--background | --foreground] \
  [--model <full-id>] \
  [--cwd <path>] \
  [--scope-base <ref>] [--scope-paths <glob,...>] \
  [--override-dispose <bool>] \
  <prompt-source: argv for Claude, stdin for Gemini>

<target>-companion.mjs continue --job <job-id> <prompt>
<target>-companion.mjs status [--job <id>]
<target>-companion.mjs result --job <id>
<target>-companion.mjs cancel --job <id> [--force]
<target>-companion.mjs ping
<target>-companion.mjs doctor
```

### 7.2 Dispatch — Claude (argv transport)

```js
const jobId = crypto.randomUUID();
const args = [
  '-p', promptText,                          // argv — safe via spawn (no shell)
  '--output-format', 'json',
  '--no-session-persistence',
  '--session-id', jobId,
  '--model', resolvedModel,
  '--setting-sources', '',                   // strips CLAUDE.md; OAuth preserved (§4.6)
];
if (mode === 'rescue') {
  args.push('--permission-mode', 'acceptEdits');
  if (addDir) args.push('--add-dir', addDir);
} else {
  // review / adversarial-review
  args.push('--permission-mode', 'plan');
  args.push('--disallowedTools',
            'Write Edit MultiEdit NotebookEdit Bash WebFetch Agent Task mcp__*');
  if (reviewSchema) args.push('--json-schema', JSON.stringify(reviewSchema));
}
spawn('claude', args, { cwd: isolated ? '/tmp' : cwd, stdio: ['ignore', 'pipe', 'pipe'] });
```

Parse `result` for text output; if `--json-schema` was used, parse `structured_output` for the schema-compliant JSON (§4.8). Check `permission_denials[]` for tool rejections.

### 7.3 Dispatch — Gemini (stdin transport + TOML policy)

```js
const args = [
  '-p', '',                                  // empty; prompt appended on stdin
  '-m', resolvedModel,
  '--output-format', 'json',
];
if (mode === 'rescue') {
  args.push('--approval-mode', 'auto_edit');
} else {
  // review / adversarial-review — policy file is THE enforcement
  args.push('--policy', `${pluginRoot}/policies/read-only.toml`);
  args.push('--approval-mode', 'plan');       // soft second layer
  args.push('-s');                            // sandbox flag (best available)
}
if (resume) args.push('--resume', sessionId);  // prefer 'latest' or captured UUID (§4.4)
const child = spawn('gemini', args, {
  cwd: isolated ? '/tmp' : cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.write(promptText); child.stdin.end();
```

**`plugins/gemini/policies/read-only.toml`:**

```toml
[[rule]]
toolName = "write_file"
decision = "deny"
priority = 100

[[rule]]
toolName = "replace"
decision = "deny"
priority = 100

[[rule]]
toolName = "run_shell_command"
decision = "deny"
priority = 100

[[rule]]
toolName = "edit"
decision = "deny"
priority = 100
```

Verified live 2026-04-24: blocks direct tool calls AND subagent fallback attempts.

### 7.4 Background job lifecycle

Identical to upstream: parent fork-execs target CLI, stdio redirected to `<workspace>/.codex-plugin-<target>/jobs/<id>/{stdout,stderr}.log`, returns `{event: "launched", job_id, pid}`, exits. Detached wrapper waits on child and writes terminal `meta.json`. No daemon, no IPC beyond files.

### 7.5 OAuth health probe — `ping`

- `ok` — JSON parsed, `is_error:false` / `response` non-empty.
- `not_authed` — non-zero exit + non-JSON stdout + stderr content. Surface stderr verbatim + "run `<target>` interactively to complete OAuth."
- `not_found` — `ENOENT`. Print install URL.
- `rate_limited` — 429 in stderr. Gemini-specific retry guidance.
- `error:<raw>` — anything else.

## 8. Model selection policy

Three tiers, full IDs only (§4.2). Config file `config/models.json`:

```json
{"cheap": "<id>", "medium": "<id>", "default": "<id>"}
```

- Rescue / review / adversarial-review default to `default` tier; user overrides via `--model=<id>`.
- Ping / doctor use `cheap`.
- Unknown IDs fail with raw error; no fallback (`claude-haiku-4-5-20251001` is the canonical haiku, not the `haiku` alias).

## 9. Context isolation

| Target | Rescue | Review / adversarial-review |
|---|---|---|
| Claude | cwd inherited, `--add-dir <cwd>` | `--setting-sources ""` (strips CLAUDE.md; OAuth preserved). Optionally `cwd = disposable worktree`. |
| Gemini | cwd inherited | `cwd = /tmp` + `--include-directories <scoped-files>` + TOML `--policy` (real enforcement) |

## 10. Read-only enforcement — layered defense

Upstream had Codex OS-level sandbox; we don't. Layering per target (§4.5):

**Claude review:**
```
claude -p <prompt>
  --setting-sources ""                           # Layer 1: strip CLAUDE.md bias
  --permission-mode plan                         # Layer 2: soft
  --disallowedTools "Write Edit MultiEdit NotebookEdit Bash WebFetch Agent Task mcp__*"
                                                 # Layer 3: hard blocklist
  --add-dir <worktree>                           # Layer 4: scoped read
  --session-id <job-uuid>
  --model <id>
  --no-session-persistence
  --output-format json [--json-schema <schema>]
```

**Gemini review:**
```
gemini -p ''
  --policy <plugin-root>/policies/read-only.toml # Layer 1 — REAL enforcement
  --approval-mode plan                           # Layer 2 — soft (auto-escalates to YOLO; do not trust alone)
  -s                                             # Layer 3 — sandbox flag
  --include-directories <scoped-files>           # Layer 4 — scoped access
  cwd = /tmp                                     # Layer 5 — neutral cwd
  -m <id>
  --output-format json
  prompt via stdin
```

**Post-hoc detection (both):** `git status -s --untracked-files=all` before + after; diff non-empty → warn user prominently, do not auto-revert.

**Profile-driven disposal (default ON for review paths):** create a fresh tempdir and populate it according to `scope`. Target CLI runs against the disposable copy; mutations happen on throwaway. Verified 2026-04-24: probe.txt written to disposable containment, main tree `git status` clean.

**README disclosure:** "Reviews are best-effort read-only. Gemini's only reliable enforcement layer is the TOML policy. Plan mode alone is NOT a sandbox (Gemini docs confirm auto-escalation to YOLO in non-interactive mode). Review profiles use disposable containment by default; commit changes before review to make mutation detection easier to interpret."

## 11. Session continuation

- **Claude:** client generates UUID via `crypto.randomUUID()`. `run` passes `--session-id <uuid>`. `continue --job <id>` runs `claude --resume <uuid> -p <followup>`. Verified round-trip §4.4.
- **Gemini:** server mints UUID, captured from result JSON `session_id` into `meta.json`. `continue` prefers `--resume latest` within the same cwd; falls back to `--resume <captured-uuid>` if available. Never `--resume <index>` (not stable across sessions).
- If session_id missing: `continue` fails closed with `SESSION_UNAVAILABLE`.

## 12. Job store — per-target, workspace-scoped

**Location:** `<workspace-root>/.codex-plugin-<target>/jobs/<job-id>/`

`workspace-root` = `resolveWorkspaceRoot(cwd)` from ported `lib/workspace.mjs` (git-repo root if in git, else cwd). Per-target subtree — Claude can't corrupt Gemini.

```
<workspace>/.codex-plugin-claude/jobs/<uuid>/
  meta.json stdout.log stderr.log session.json
  git-status-before.txt git-status-after.txt     # review only
  dispose-path.txt                               # disposable containment only
```

**`meta.json`:**
```json
{
  "id": "<uuid>", "target": "claude", "mode": "rescue|review|adversarial-review",
  "status": "running|done|failed|canceled", "pid": 12345, "exit_code": null,
  "started_at": "...", "ended_at": null, "cwd": "...", "workspace_root": "...",
  "isolated": true, "disposed": true, "dispose_path": "...",
  "model": "claude-opus-4-7", "session_id": "<uuid>", "parent_job": null,
  "prompt_head": "...", "schema_version": 1
}
```

UUID v4 IDs. Atomic writes via `rename()` (POSIX). Port upstream's `tracked-jobs.mjs` (parametrized per §6.2). PID liveness check (PID alive + cmdline matches binary) guards against PID reuse.

No auto-GC in v1.

## 13. Slash commands — command-file structure

Each `commands/<name>.md` uses this frontmatter (based on `openai/plugins` convention):

```yaml
---
description: One-line user-visible description.
argument-hint: "[--flag] [subject]"
---
```

No `allowed-tools` (advisory only, §4.13). No `disable-model-invocation` (CC-only field).

**Body structure (kept concise — bodies are consumed in full per invocation, §4.15):**

```markdown
Brief purpose line.

## Arguments
`$ARGUMENTS` — <what the user passed>

## Workflow
1. Retrieve the `<target>-cli-runtime` skill for invocation contract.
2. Call `node "<plugin-root>/scripts/<target>-companion.mjs" <subcommand> ...`
3. Render result via the `<target>-result-handling` skill.

## Guardrails
- <mode-specific no-go conditions>
```

**Inventory (per plugin, `claude` shown):**

| Command | Mode | Subagent? | Typical duration |
|---|---|---|---|
| `/claude-rescue <task>` | rescue | claude-rescue | minutes (background) |
| `/claude-review [<focus>]` | review | — | <60 s foreground |
| `/claude-adversarial-review [<focus>]` | adversarial-review | — | <90 s foreground |
| `/claude-setup` | — | — | <10 s |
| `/claude-status [<id>]` | — | — | <1 s |
| `/claude-result <id>` | — | — | <1 s |
| `/claude-cancel <id>` | — | — | <1 s |

## 14. Subagents — `claude-rescue`, `gemini-rescue`

`agents/<target>-rescue.md`:

```yaml
---
name: claude-rescue
description: Delegate investigation or follow-up rescue work to Claude Code through the plugin runtime.
model: inherit
tools: Bash
skills:
  - claude-cli-runtime
  - claude-result-handling
  - claude-prompting
---
```

Body: selection guidance, forwarding rules, response style. Parity with upstream `codex-rescue.md`. Review and adversarial-review do NOT use a subagent (single-turn in calling session).

## 15. Setup — `/<target>-setup`

1. **Binary check** — `which <target>`. Missing → install URL, stop.
2. **OAuth ping** — `<target>-companion ping` (cheap tier). Not authed → instruct user to run `<target>` interactively; stop.
3. **Version floor** — `<target> --version` vs `config/min-versions.json`. Below floor → warn, continue.
4. **Gemini-only rate-limit probe** — ping cheap + default tiers, report serving.
5. **Smoke-test hint** — print a one-liner the user can paste (e.g., `/claude-review`).

**Hard rules:** never read/write any `*_API_KEY`; never programmatic auth; never persist tokens.

## 16. Data contracts

### 16.1 Companion invocation from commands

`commands/*.md` body retrieves `<target>-cli-runtime` skill, which contains the invocation snippet. Per-target:

**Claude (argv):**
```bash
node "<plugin-root>/scripts/claude-companion.mjs" run --mode=review -- "$ARGUMENTS"
```

**Gemini (stdin):**
```bash
printf '%s' "$ARGUMENTS" | node "<plugin-root>/scripts/gemini-companion.mjs" run --mode=review
```

`<plugin-root>` resolved inside the companion via `path.resolve(fileURLToPath(new URL("..", import.meta.url)))`. Commands and subagents never compute plugin-root.

### 16.2 Companion stdout

- **Foreground:** single JSON with target-native fields + added `{job_id, workspace_root, git_status_diff}`. For schema runs, include parsed `structured_output`.
- **Background:** `{event:"launched", job_id, target, mode, pid, started_at}` + exit.
- **status / result / cancel:** JSON default; `--human` flag for table output.

### 16.3 Prompt templates per mode

`plugins/<target>/prompts/`:
- `rescue.md` — tool access granted, investigate/fix.
- `review.md` — read-only, find correctness/safety/subtle-logic issues. Structured output.
- `adversarial-review.md` — challenge the design; no style nits.

User text appended. Review output (when `--json-schema` supplied) validated against `schemas/review-output.schema.json`.

### 16.4 Prompting skill content

`plugins/<target>/skills/<target>-prompting/SKILL.md` + references:
- Model-tier rationale per mode.
- Target-specific caveats: Claude (aliases unreliable, `-c` forbidden, session-UUID pattern), Gemini (plan-mode auto-escalates to YOLO, policy files are the real layer, `--resume` prefer latest).
- No SDK/API/batch content (irrelevant under OAuth).

## 17. Testing

### 17.1 Unit (`tests/unit/`)
- `jobs.test.mjs` — workspace scoping (git/non-git), atomic meta, status transitions, PID-liveness + cmdline.
- `process.test.mjs` — argv vs stdin transport, timeout, SIGTERM→SIGKILL.
- `workspace.test.mjs` — `resolveWorkspaceRoot` on git root, subdir, worktree, non-git, symlinks.
- `render.test.mjs` — table formatting, terminal-width truncation, git-diff prominence.
- `args.test.mjs` — parsing, unknown-flag rejection, mutex enforcement.
- `policy.test.mjs` — Gemini policy TOML syntax validation.

### 17.2 Smoke (`tests/smoke/`)
`claude-mock.mjs`, `gemini-mock.mjs` — deterministic JSON fixtures keyed on model + prompt. `PATH=tests/smoke:$PATH`. Per plugin: 7 commands × 2 = **14 smoke tests**.

### 17.3 E2E (`tests/e2e/`)
Real CLIs. Live OAuth required. Not in CI. `npm run e2e:claude` / `npm run e2e:gemini`.

### 17.4 Self adversarial review
Before v0.1.0: run upstream `/codex:adversarial-review` against this repo. Address findings.

## 18. Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Gemini plan mode is actively unsafe (auto-escalates to YOLO headlessly). | TOML `--policy` deny rules (verified real). Disposable containment default. README disclosure. |
| R2 | Claude plan mode is soft; haiku tier occasionally ignores. | `--disallowedTools` blocklist; disposable containment default; pre/post git-status diff. Default to `medium` or `default` tier for reviews. |
| R3 | Model aliases silently substitute. | Full IDs only; `config/models.json` allowlist. |
| R4 | Gemini 429 intermittent on 2.5-series models. | Retry + report serving tiers in `setup`. |
| R5 | Plugin-root resolution on hash-versioned installs. | `path.resolve(fileURLToPath(new URL("..", import.meta.url)))` (upstream pattern). |
| R6 | Concurrent Gemini at semantic layer. | Disposable containment default + policy file. Serialize per workspace via lockfile if observed in practice. |
| R7 | Command name collision with Codex builtins (`stop`, `plan`, …). | Bare names enumerated §5.1; none collide. Spec pins the list. |
| R8 | Multi-plugin install UX. | Verified live: `codex plugin marketplace add owner/repo` resolves to git clone; `.agents/plugins/marketplace.json` schema validated; user enables per-plugin in TUI. |
| R9 | Apache-2.0 port of MIT upstream. | `NOTICE` includes full MIT text + attribution. Our deltas Apache-2.0. |
| R10 | `--bare` OAuth incompatibility would have broken Claude calls in v3. | Resolved in v4: `--setting-sources ""`. |
| R11 | Hook timeout enforcement means gate hooks with real work will silently fail. | v1 ships no hooks. Review-gate feature deferred. |
| R12 | `--json-schema` is soft contract. | Parse `structured_output`; fall back to text-parse + retry once. |
| R13 | Plugin commands are TUI-only; no programmatic `codex exec` invocation. | Documented. Consumers invoke via Codex TUI. CI/automation use companion directly (`node companion.mjs run ...`). |
| R14 | Shared-lib parametrization introduces upstream-drift risk. | Minimal surface (4 files need init-arg; 6 copy-verbatim). Upstream tracking via a `UPSTREAM.md` noting last-synced commit. |

## 19. Milestones (preview — writing-plans will expand)

- **M0 — skeleton + install-path smoke.** Two plugins + `.agents/plugins/marketplace.json`. Single `/<target>-ping` command that prints "ok". Live-install from github, enable in TUI, invoke command, see "ok".
- **M1 — shared-lib port + parametrization.** Port 10 upstream lib files per plugin; parametrize the 4 coupled ones. Unit tests for `workspace`, `process`, `jobs`, `args`, `render`.
- **M2 — Claude foreground runtime (review mode).** `claude-companion run --mode=review --foreground` with `--setting-sources ""` + `--disallowedTools`. Foreground flow end-to-end with a mock CLI. `/claude-review` command invokes it.
- **M3 — Claude commands + rescue subagent.** Port `commands/*.md`, `agents/claude-rescue.md`. Status/result/cancel commands. Foreground review + adversarial-review + setup work.
- **M4 — Claude background + continue.** `run --background`, detached lifecycle, `continue --job`. Session-id roundtrip.
- **M5 — Claude containment + dispose.** `containment=worktree`, profile-driven disposal, pre/post git-status capture.
- **M6 — Claude prompting skill.** `skills/claude-prompting/SKILL.md` + references.
- **M7 — Gemini port (policy-first).** `plugins/gemini/`. `policies/read-only.toml`. stdin transport. `/tmp` cwd for isolation.
- **M8 — Gemini rescue + background.**
- **M9 — Tests.** Full unit + smoke (mock CLIs) + CI (lint + unit + smoke). E2E manual.
- **M10 — Docs, CHANGELOG, v0.1.0.** Self adversarial review. Tag release.

Adversarial-review gate between milestones where risk warrants.

## 20. Success criteria

- `codex plugin marketplace add seungpyoson/codex-plugin-multi` installs the marketplace. User enables each plugin via TUI. Bare slash commands (`/claude-rescue`, `/gemini-review`, …) appear in the palette.
- `/claude-rescue <task>` launches a background Claude job, returns job ID, `/claude-result <id>` renders usable output. User never sees companion internals.
- `/gemini-review` returns a review under `--policy` + disposable containment. Any file mutation in the user's working tree is reported as WARNING, never auto-reverted.
- All 7 actions × 2 targets work.
- Passes self adversarial review.
- No API keys touched; no `*_API_KEY` env var read or written.

---

## 21. Architectural invariants (v5)

These are the rules M7+ code is judged against. Each invariant names a class of mistake that the M6 cross-model review surfaced. Violating one is a spec defect, not a code bug — fix the spec or fix the code to match it. Do not patch around it.

### 21.1 Identity types are distinct

**Rule:** every durable record names four identities separately:

| Field | Owner | Lifetime | Source |
|---|---|---|---|
| `job_id` | companion | per invocation | `randomUUID()` in companion |
| `claude_session_id` (or `gemini_session_id`) | target CLI | per CLI session | **read from CLI stdout `parsed.session_id`**, not minted by companion |
| `resume_chain[]` | companion | across `continue` calls | list of prior `*_session_id`s, newest-last |
| `pid_info = {pid, starttime, argv0}` | OS | while process lives | `ps`/`/proc` at spawn time |

**Forbidden patterns:**

- Using `randomUUID()` as both `job_id` and `session_id` on the same record.
- Storing `session_id: newSessionId` on a resume job when the new UUID was never passed to the CLI.
- Using `pid` alone as a signal target or ownership proof.

**Required patterns:**

- On `run`: companion generates `job_id`, passes `job_id` to Claude as `--session-id` for a new session, then records `claude_session_id = parsed.session_id` (Claude echoes it back). When Claude creates its own session ID without input, the record stores what Claude returned — never what the companion sent.
- On `continue`: companion generates a fresh `job_id`, looks up the prior job's `resume_chain[-1]` (or `claude_session_id`) as the `--resume` UUID, appends it to the new record's `resume_chain`, records the new `claude_session_id` from stdout after the run.
- On `cancel`: read `pid_info` tuple, re-verify `starttime` + `argv0` match before signaling. Mismatch → refuse with `stale_pid` error.

**Why:** Finding #6 (chained continue breaks), #7 (PID-reuse kill), parts of #3 (result lost) all trace to identity conflation. The type rule makes the mistake unrepresentable.

---

### 21.2 Mode is the only source of mode-specific defaults

**Rule:** every knob whose correct value is determined by mode lives in exactly one `ModeProfile` table. Dispatcher libraries (`lib/claude.mjs`, `lib/gemini.mjs`) accept a profile; they do **not** take individual flag knobs with defaults.

**The table** (one row per mode, sourced from §4.5, §9, §8):

```
ModeProfile {
  name:            "review" | "adversarial-review" | "rescue" | "ping"
  model_tier:      "cheap" | "medium" | "default"        // §8
  permission_mode: "plan" | "acceptEdits"                // §4.5
  strip_context:   boolean                               // §4.6 — strip CLAUDE.md?
  disallowed_tools: string[]                             // §4.5 hard blocklist
  containment:     "none" | "worktree"                   // §21.4
  scope:           "working-tree" | "staged" | "branch-diff" | "head" | "custom"  // §21.4
  dispose_default: boolean                               // §10
  add_dir:         boolean                               // pass --add-dir at all?
  schema_allowed:  boolean                               // is --json-schema meaningful?
}
```

**Canonical values (v5):**

| Mode | tier | perm | strip | containment | scope | dispose | add_dir |
|---|---|---|---|---|---|---|---|
| review | cheap | plan | true | worktree | working-tree | true | yes |
| adversarial-review | medium | plan | true | worktree | branch-diff | true | yes |
| rescue | default | acceptEdits | **false** | none | working-tree | false | yes |
| ping | cheap | plan | true | none | head (no setup) | false | no |

**Forbidden patterns:**

- `const stripContext = true` as a default in `buildClaudeArgs` or `spawnClaude` signature.
- `models[mode === "rescue" ? "default" : "default"]` — any model resolution that branches on mode outside the profile table.
- `--dispose` default resolved in the companion's argv parser ("review mode ⇒ dispose"); it belongs in the profile.

**Required patterns:**

- `cmdRun` resolves `mode → profile` exactly once at entry. No downstream code branches on `mode` to pick a flag.
- `spawnClaude(profile, runtimeInputs)` — where `runtimeInputs = {prompt, cwd, addDir, sessionId, resumeId, jsonSchema?}`. Everything else comes from the profile.
- Adding a new mode is adding one row to the table. Nothing else changes.

**Why:** Finding C2 (silent Opus billing) and the Gemini review's "Rescue mode strips CLAUDE.md" are both symptoms of defaults outside the profile winning on omission. The table centralizes the truth.

---

### 21.3 One `JobRecord` shape, persisted and returned

**Rule:** exactly one schema describes everything the companion durably persists about one invocation. The same schema is what `cmdResult` returns, what the `run --foreground` stdout prints (success path), and what the `claude-result-handling` / `gemini-result-handling` skills describe.

**The schema (v6):**

```
JobRecord {
  // Identity (§21.1) — required
  job_id, target, claude_session_id | gemini_session_id
  parent_job_id?, resume_chain[]?
  pid_info? = { pid, starttime, argv0 }

  // Invocation (§21.2) — required
  mode_profile_name, model, cwd, workspace_root
  isolation = { containment, scope, dispose }
  prompt_head               // first 200 chars — see §21.3.1 below
  schema_spec?              // --json-schema value if used
  binary                    // claude | gemini | <override>

  // Lifecycle — required
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "stale"
  started_at, ended_at?, exit_code?
  error_code?, error_message?      // failed | stale only

  // Result (was missing in v4) — required when status = completed or failed
  result?: string
  structured_output?: object
  permission_denials[]
  mutations[]               // { path, status } entries from post-hoc git diff
  cost_usd?, usage?

  // Bookkeeping — required
  schema_version: 6
}
```

#### 21.3.1 — `prompt_head` only, no full prompt persisted

The full prompt MUST NOT be persisted to `JobRecord`. `prompt_head` (≤200 chars) is sufficient for human display. Reasons:

- Prompts routinely contain credentials, private incident context, full file contents pasted by the user.
- The full prompt is never needed for `continue` (that path uses `resume_id`, not the original text).
- The full prompt is never needed for display (`result` is the answer; the prompt is input).

If a later feature legitimately needs the original prompt text (e.g., reproducible rerun), it lives in a **private sidecar** (`<job>/prompt.txt`, mode `0600`) and is an explicit opt-in flag, not the default.

#### 21.3.2 — Foreground and background paths converge

- **Foreground:** `executeRun` writes the complete `JobRecord` to `<job>.json`, then `cmdRun` reads it back and prints it. Stdout blob is NOT hand-assembled from in-memory execution vars.
- **Background:** `_run-worker` writes the complete `JobRecord` on exit. `cmdResult` reads the same file.

**Forbidden patterns:**

- `printJson({ok, result, structured_output, …})` assembled from `execution.parsed.*` in-memory, diverging from what goes to disk.
- A `finalRecord` that omits `result`/`structured_output`/`denials`/`mutations`.
- A `prompt` field on the record (distinct from `prompt_head`).

**Required patterns:**

- One `buildJobRecord(baseRecord, execution, mutations)` helper; both paths call it.
- The `*-result-handling` skill's "success path" section renders the fields of `JobRecord` verbatim — no fields present in the skill that aren't in the schema, no fields in the schema that the skill fails to mention.

**Why:** Finding #1/H1 (background result lost), #9 (full prompt persisted), and docs drift (H1) collapse to one problem: three different places hand-assemble three different shapes. One schema, one helper, no drift.

---

### 21.4 Containment and scope are orthogonal

**Rule:** two separate decisions, two separate fields in `ModeProfile`:

- **`containment`** answers "where does Claude write, and what gets cleaned up?"
  - `none` — Claude runs directly in the user's `cwd`. Writes land in the user's tree. (Rescue default.)
  - `worktree` — a fresh temp dir is created; Claude runs there; dir is deleted on dispose. (Review default.)

- **`scope`** answers "what content does Claude see?"
  - `working-tree` — everything in the user's live tree, including tracked, untracked, ignored, and locally smudged files. Symlinks are materialized as regular files when safe.
  - `staged` — stage-0 index entries under `sourceCwd`. Regular blobs are copied byte-for-byte from the INDEX, executable mode is preserved from git mode, and symlink blobs are resolved structurally against INDEX metadata only.
  - `branch-diff` — files changed between the merge-base of HEAD and some base ref (default `main`), materialized from raw HEAD object content. Deletions and gitlinks are not copied.
  - `head` — raw HEAD tree entries under `sourceCwd`, using the same object-pure materialization rules as `staged`.
  - `custom` — caller passes `--scope-paths <glob>…`; only matching files are populated.

Git-derived scopes (`staged`, `branch-diff`, `head`) are **object-pure snapshots**. They do not run `git checkout`, `git checkout-index`, checkout filters, clean/smudge/process filters, LFS smudge, textconv, hooks, `.gitattributes` transformations, replace refs, grafts, or config-defined shell commands during scope population. They represent canonical git object bytes, not post-filter working-tree bytes. Use `working-tree` or `custom` when the target must see the user's live filesystem representation.

**Setup pipeline:**

1. If `containment = worktree`, create an empty tempdir.
2. Populate it according to `scope` (or if `containment = none`, skip populate).
3. Pass `--add-dir <containment-path>` to Claude.
4. On completion, if `dispose`, remove the tempdir.

**Forbidden patterns:**

- A single `--isolated` flag that means "containment=worktree AND scope=head." The two decisions must be settable independently.
- Hard-coding `git worktree add --detach HEAD` as the only population method.

**Required patterns:**

- `setupContainment(profile, cwd)` returns `{path, populate, cleanup}`. `populate` takes the scope and fills the path. The two functions are testable in isolation.
- `review` with dirty working tree is reviewable, because `scope: working-tree` copies the dirty state. This is the default, not an escape hatch.

**Why:** Finding #4 (review can't see uncommitted changes) is not a bug in `--isolated`; it's the spec-level conflation of two orthogonal concerns. Splitting them makes review-of-dirty-tree the default.

---

### 21.5 Shared-lib contract is importability + behavior

**Rule:** each file under `plugins/<target>/scripts/lib/` MUST:

1. Import cleanly when loaded in isolation (`await import(lib_url)` succeeds without side effects).
2. Pass a per-module smoke test exercising its public exports.
3. Be byte-identical to its sibling (per `plugin-copies-in-sync.test.mjs`).

**Rules (2) and (3) together catch what v4 missed:** `job-control.mjs` passed byte-identity (both copies equally broken), but would have failed importability (depends on a missing `./codex.mjs`).

**Forbidden patterns:**

- Shared libs that are shipped but not imported by any entry point. If nothing uses it, it gets deleted; no "staging" state.
- Relying on byte-identity as the sole portability guarantee.

**Required patterns:**

- `tests/unit/lib-imports.test.mjs` iterates every `plugins/*/scripts/lib/*.mjs`, `await import()`s each, asserts every declared export is a function/value (not `undefined`).
- Each public export has at least one behavioral test. If the export has no downstream caller and no test, it's dead — delete it before shipping.

**Why:** Finding #10 (broken `job-control.mjs` duplicated). The test that CI ran (byte-identity) cannot catch "both copies broken the same way."

---

## Appendix: v4 change log (v3 → v4)

1. Slash commands: **bare names** (v4) vs namespaced `/target:command` (v3).
2. Marketplace `authentication: "ON_USE"` (v4) vs `"ON_INSTALL"` (v3).
3. Claude isolation: **`--setting-sources ""`** (v4) vs `--bare` (v3 — breaks OAuth).
4. Gemini isolation: **TOML `--policy` deny rules** (v4) vs `--approval-mode plan` alone (v3).
5. Hook events enumerated (5 supported).
6. `allowed-tools` frontmatter documented as advisory.
7. `--json-schema` → `structured_output` field (soft contract).
8. Command bodies kept concise (consumed per invocation).
9. Shared-lib parametrization strategy specified (§6.2).
10. Hooks use relative paths; no `${CODEX_PLUGIN_ROOT}` exists.
11. `--sparse` limited to git sources.
12. Removed `@skill-name` retrieval syntax (doesn't exist in Codex).
13. `--resume` strategy: Gemini prefers `latest`/captured-UUID; never ordinal index.
14. Denial detection parses both `permission_denials[]` and result text (plan-mode pre-emption not in denials array).
15. Hook timeout enforced; v1 ships no hooks.
16. Cost attribution: OAuth reports `apiKeySource: None`; quota-based.
17. TUI-only command invocation documented (no `codex exec` path).

## Appendix: v5 change log (v4 → v5)

Triggered by the M6 cross-model review (Codex + Gemini + Claude). v5 adds no new CLI empirical facts; it adds architectural invariants that the v4 code silently violated.

1. **§21.1 — Identity types.** `job_id`, `claude_session_id`, `resume_chain`, `pid_info` are four distinct identities with four distinct sources. `randomUUID()` is never used for anything except a fresh `job_id`. `session_id` is **read back** from the CLI's stdout, not minted by the companion.
2. **§21.2 — `ModeProfile`.** All mode-correlated knobs (model tier, strip_context, permission_mode, disallowed_tools, containment, scope, dispose_default, add_dir) live in one table. Dispatcher libraries take a profile, not individual knob-defaults.
3. **§21.3 — One `JobRecord` shape.** The persisted record is the contract surface for foreground stdout, `cmdResult`, and skill docs. No hand-assembled shapes per path. `prompt_head` only; no full `prompt` field.
4. **§21.4 — Containment ⊥ Scope.** `--isolated` is retired as an atomic flag. `containment ∈ {none, worktree}` and `scope ∈ {working-tree, staged, branch-diff, head, custom}` are independent. `review` defaults to `{worktree, working-tree}` so dirty trees are reviewable.
5. **§21.5 — Shared-lib contract.** Byte-identity + importability + behavioral smoke, not just byte-identity.

M6 code violated 1–4. M7 code must comply with all five; v5 is the judge.
