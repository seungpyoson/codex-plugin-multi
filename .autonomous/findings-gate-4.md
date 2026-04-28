# Gate-4 Gemini background/continue findings + disposition

Scope: Gemini background + `continue --job` lifecycle after M9, with shared
Claude/Gemini lifecycle follow-up before M10 coverage/CI work.

Review inputs: Claude, GPT, Gemini, GLM, and DeepSeek red-team reviews all
returned `PASS_M8_GEMINI_BACKGROUND_CONTINUE` / no blocking findings.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | LOW | Gemini `_run-worker` could overwrite a terminal JobRecord if manually re-run. | **FIXED in `fbf3937`** — Gemini worker now refuses terminal records before consuming sidecars or rebuilding terminal metadata. Covered by `gemini _run-worker refuses terminal JobRecord without overwriting it`. |
| 2 | LOW | Missing prompt-sidecar worker path lacked a direct Gemini smoke test. | **FIXED in `fbf3937`** — added queued missing-sidecar smoke. Worker writes a failed JobRecord and does not persist the full prompt. |
| 3 | NIT | Continue tests used a fixed mock `gemini_session_id`. | **FIXED in `fbf3937`** — mock now returns a distinct resumed session id; foreground and background continue tests assert resume flag input and final session capture. |
| 4 | NIT | Gemini smoke polling deadlines were hardcoded. | **FIXED in `fbf3937`** — Gemini smoke uses `GEMINI_SMOKE_POLL_TIMEOUT_MS` with the existing 5s default. |
| 5 | DOC | Roadmap/command docs drifted after Gemini background + continue shipped. | **FIXED in `52c501d` and `fbf3937`** — shipped docs now state `run --background` and `continue --job` work, while `cancel` remains deferred. |
| 6 | LOW | Detached worker spawn had no `child.on("error")` path. Initial review framed this as unlikely because the worker executable is `process.execPath`, but T10.0 found another reachable input: user-supplied `--cwd` can be unusable as the child cwd after the queued JobRecord and prompt sidecar are created. | **FIXED in T10.0** — both Claude and Gemini now wait for the child `spawn` event before emitting `launched`; on `error`, they write a failed JobRecord, remove the prompt sidecar, and return `spawn_failed`. Covered by companion smoke tests for both targets. |
| 7 | Lifecycle parity | Gemini `cancel` remains unimplemented. | **DEFERRED** — not required for background/continue correctness and explicitly excluded from completed M9. Owner/milestone: M10 lifecycle-parity slice before M11 if prioritized. Rationale: porting cancel requires PID ownership semantics, command docs, and smoke parity with Claude, not just a local background/continue fix. |

## Gate-4 result

Gate-4 is clear for M10 coverage/CI work after the T10.0 shared spawn-failure
fix is committed. No Object-Pure scope behavior was reviewed or changed here.
