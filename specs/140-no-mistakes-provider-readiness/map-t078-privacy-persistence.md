# T078 Privacy Persistence Policy Map

Status: implementation input. This map pins policy decisions for T078 before
runtime privacy tests are added.

Reviewed input: `/private/tmp/cpm-t078-privacy-map` accepted enough policy
direction for implementation. This canonical copy records the decisions needed
by the repo tests and future runtime work.

## Policy Decisions

### Source Quote Threshold

Secrets, credentials, env-named values, auth headers, bearer tokens, and high
entropy generated test sentinels have a zero-byte threshold. They must not
persist in `result`, `error_message`, `stdout.log`, `stderr.log`, lifecycle
JSONL/markdown, review panels, or persisted `meta.json`.

Full prompt bodies and full selected source bodies also have a zero-byte
threshold. T078 sentinel strings such as
`PROMPT_BODY_SENTINEL_DO_NOT_PERSIST` and
`SOURCE_BODY_SENTINEL_DO_NOT_PERSIST` must not appear after the prompt/source
handoff window closes.

Short reviewer evidence is allowed only within bounded quote limits:

- max 200 contiguous characters copied from any selected source file
- max 800 aggregate copied source characters per persisted JobRecord,
  terminal lifecycle projection, or review panel output

Copied source spans over those limits must be replaced with
`[redacted_source_excerpt]`. Enforcement must be deterministic before
persistence or lifecycle projection: scan candidate text fields against the
selected source bodies while those bodies are still in memory, then discard the
bodies and persist only hashes, counts, and redaction metrics. If selected
source bodies are unavailable for a required scan, fail closed instead of
treating the text as safe.

Paths, byte counts, line counts, hashes, provider ids, job ids, and verdict
keywords are metadata, not source body.

### Terminal Lifecycle JSONL And Markdown

Terminal lifecycle JSONL must be a separate redacted projection, not the full
persisted JobRecord. `--lifecycle-events markdown` follows the same redacted
projection rule.

Allowed projection fields: provider, job id, session id, mode, scope,
source-send state, status, elapsed time, error code, verdict keyword, review
quality failed-slot state, selected-source totals, prompt/source hashes, and
disclosure text. `prompt_head` may appear only as bounded metadata after secret
and selected-source redaction, with max 200 characters.

Terminal lifecycle projections must not include `result`, raw `stdout.log`,
raw `stderr.log`, full prompt body, selected source body, or full
`runtime_diagnostics`. Persisted `meta.json` still needs provider-appropriate
redaction; lifecycle projection is an additional boundary, not a substitute for
record redaction.

### Runtime Options Cleanup

`runtime-options.json` is settings-only today. Normal companion worker pickup
must consume and delete `runtime-options.json` for Claude, Gemini, and Kimi.

Failure to delete `runtime-options.json` after successful read records
`cleanup_warning: "runtime_options_persisted"` and the path, but does not
change review verdict status while the file remains settings-only.

Failure to delete body-bearing artifacts hard-fails before source send when
detected pre-send, or marks the terminal slot failed after source send with
privacy-persistence failure semantics. Body-bearing artifacts include
`prompt.txt`, selected-source copies, prompt/source-bearing stdout or stderr
sidecars, temp prompt/source files, credentials, auth tokens, and secrets.

If `runtime-options.json` ever grows a prompt body, source body, credential,
auth token, or secret-bearing field, it becomes body-bearing and inherits the
hard-fail rule. Schema regression tests must fail if a new field is added
without explicit classification as settings-only or body-bearing.

## RED Test Surface

T078 implementation should add vertical RED/GREEN slices, not one broad
horizontal matrix:

- no full prompt body persists in plugin-owned artifacts
- no full selected source body persists in plugin-owned artifacts
- over-threshold source quotes redact to `[redacted_source_excerpt]` while
  bounded evidence survives
- no env-named secret persists in plugin-owned artifacts
- terminal lifecycle JSONL and markdown emit redacted projection only
- review panels do not include prompt or source bodies
- cleanup uncertainty fails closed for body-bearing artifacts or records a
  waiver when policy permits one

Provider process matrix tests should live behind `CODEX_PLUGIN_PRIVACY_TESTS=1`
and the full-test command path, not every local smoke run.

## Scope Notes

T078 covers plugin-owned artifacts and operator-facing plugin output. External
provider caches such as Kimi share/cache dirs or Grok auth homes are disclosed
as provider-local state unless a later integration test gives direct cleanup
proof without contaminating user auth state.
