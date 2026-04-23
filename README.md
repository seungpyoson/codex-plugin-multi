# codex-plugin-multi

Symmetric delegation for Codex. Port of upstream `openai/codex-plugin-cc` (which targets Codex from Claude Code) to let Codex delegate work to **Claude Code** and **Gemini CLI**.

## Overview
This repository contains two standalone Codex plugins:
- `plugins/claude/`: Standalone Codex plugin for Claude Code integration.
- `plugins/gemini/`: Standalone Codex plugin for Gemini CLI integration.

Each plugin provides feature parity with upstream:
- `rescue`: Investigate or fix complex issues with a subagent (background).
- `review`: Rapid diff/file review.
- `adversarial-review`: Forced-dissent review to find flaws.
- `status`/`result`/`cancel`: Job management.
- `setup`: Environment check and prompt shim installation.

## Security & Architecture
- **Safe Transport:** Prompts are passed via `stdin` to prevent shell injection.
- **Read-Only Reviews:** Review modes default to read-only/no-edit to prevent unintended mutations.
- **Workspace Isolation:** Job store is namespaced by workspace root; results are scoped to the current project by default.
- **Explicit Sessions:** Robust session continuation using captured session IDs (no fallback to risky last-session heuristics).
- **Zero API Keys:** Relies entirely on the target CLI's local authentication (OAuth).

## Installation

```bash
# In Codex:
/plugin marketplace add github:seungpyoson/codex-plugin-multi
```

Once installed, run the setup for your preferred target:
- "set up claude integration"
- "set up gemini integration"

Setup will offer to install prompt shims (`~/.codex/prompts/*.md`) so you can use `/claude-rescue` and `/gemini-review` as literal slash commands.

## License
Apache-2.0 (mirrors upstream)
