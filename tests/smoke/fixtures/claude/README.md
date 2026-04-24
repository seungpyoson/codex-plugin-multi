# Claude mock fixtures

Fixture JSON files consumed by `tests/smoke/claude-mock.mjs`.

**Lookup order** (mock picks the first match):

1. `<model>-<promptSha>.json` — where `<model>` is the arg passed via `--model` and `<promptSha>` is the first 16 hex chars of SHA-256 over the prompt text.
2. `<model>-default.json` — any prompt from that model.
3. `default.json` — catch-all.

**Adding a fixture from a real run:**

```
claude -p "your prompt" --output-format json --model claude-haiku-4-5-20251001 \
  > tests/smoke/fixtures/claude/claude-haiku-4-5-20251001-$(printf 'your prompt' | shasum -a 256 | cut -c1-16).json
```

Each fixture must be a single JSON object matching the shape Claude emits with `--output-format=json`. At minimum: `type`, `is_error`, `result`, `session_id` (auto-stamped by the mock). Omitting `session_id` is fine — the mock fills it from the `--session-id` flag the caller passed.
