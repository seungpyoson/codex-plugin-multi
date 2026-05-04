# Artifact Cleanup Inventory

Issue #61 requires cleanup to be rooted in an explicit artifact and ownership map.

## Companion Providers

Applies to Claude, Gemini, and Kimi `review`, `adversarial-review`, `custom-review`, and `rescue`, in foreground, background, and continue flows.

| Artifact | Root | Contents | Needed for | Safe deletion point | Owner |
| --- | --- | --- | --- | --- | --- |
| `state.json` | `<stateRoot>/<workspaceSlug-hash>/` | Retained job summaries, config | `status`, retained history | Never as per-job cleanup | `state.mjs` |
| `<jobId>.json` | `<stateDir>/jobs/` | Canonical JobRecord, result metadata, target/session IDs | `status --job`, `result --job`, `continue`, history | When terminal job is pruned from retained history | `state.mjs` |
| `<jobId>.json.*.tmp` | `<stateDir>/jobs/` | Partial atomic write for JobRecord | Nothing after interrupted write | When matching terminal job is pruned | `state.mjs` |
| `<jobId>.log` | `<stateDir>/jobs/` | Legacy/safe log path if present in state | Debugging only | When terminal job is pruned, if path is inside jobs root | `state.mjs` |
| `<jobId>/prompt.txt` | `<stateDir>/jobs/` | Full background prompt handoff | Background worker startup | Worker consumes it; any leftover is deleted with pruned terminal job | companion + `state.mjs` |
| `<jobId>/runtime-options.json` | `<stateDir>/jobs/` | Kimi private runtime options, for example max step budget | Kimi background/continue | With containing sidecar directory when terminal job is pruned | Kimi companion + `state.mjs` |
| `<jobId>/cancel-requested.flag` | `<stateDir>/jobs/` | Cancel intent marker | Running/queued cancellation finalization | Consumed by worker; leftover is deleted with pruned terminal job | cancel marker + `state.mjs` |
| `<jobId>/git-status-before.txt` and `git-status-after.txt` | `<stateDir>/jobs/` | Mutation-detection snapshots | Operator diagnostics/result interpretation | With containing sidecar directory when terminal job is pruned | companion + `state.mjs` |
| `<jobId>/stdout.log` and `stderr.log` | `<stateDir>/jobs/` | Target CLI diagnostics and raw output | Debugging only; JobRecord remains canonical | With containing sidecar directory when terminal job is pruned | companion + `state.mjs` |
| Containment worktree | `os.tmpdir()/<provider>-worktree-*` | Scoped copied review material and target writes | Target execution only | End of foreground/background worker execution, including scope/spawn/finalization failures | `containment.mjs` caller |
| Neutral cwd | `os.tmpdir()/gemini-neutral-cwd-*`, `kimi-neutral-cwd-*` | Empty target cwd for policy isolation | Target execution only | End of execution/failure path | companion |

Safety proof for deletion: derive paths only from `assertSafeJobId(job.id)` and provider-owned roots. Active `queued` and `running` jobs are retained and their sidecar directories are not pruned. State-provided arbitrary paths are ignored except `logFile`, which is deleted only after containment under the provider jobs root is verified.

Process policy: retained-history pruning does not signal processes. Companion process termination remains owned by `cancel`, which requires `pid_info` verification through `starttime` and `argv0`. Orphan reconciliation only marks active records `stale` when PID proof says the process is gone/reused, or when old queued/running records lack usable ownership proof; it does not kill.

## API Reviewers

Applies to DeepSeek and GLM `review`, `adversarial-review`, and `custom-review` direct API runs.

| Artifact | Root | Contents | Needed for | Safe deletion point | Owner |
| --- | --- | --- | --- | --- | --- |
| `state.json` | `API_REVIEWERS_PLUGIN_DATA` or `.codex-plugin-data/api-reviewers` | Retained API reviewer job summaries | Retained history/pruning | Never as per-job cleanup | `api-reviewer.mjs` |
| `jobs/<jobId>/meta.json` | API reviewer data root | Canonical direct API JobRecord | Returned result and retained diagnostics | When terminal API reviewer job is pruned from retained history | `api-reviewer.mjs` |
| `jobs/<jobId>/meta.json.*.tmp` | API reviewer job dir | Partial atomic write | Nothing after interrupted write | Removed on write failure; containing job dir removed on prune | `api-reviewer.mjs` |

API reviewer cleanup backfills the retained-history index by discovering existing safe `jobs/<jobId>/meta.json` directories before pruning. This covers installs that created per-job API reviewer records before `state.json` existed, while malformed metadata and unsafe directory names remain ignored for deletion. Direct API reviewer `meta.json` writes are per-job atomic writes that complete before the retained-history index lock is acquired, so the canonical JobRecord remains durable even if `state.json` indexing times out. Direct API reviewer `state.json` updates are serialized by a per-data-root advisory lock so parallel DeepSeek/GLM runs cannot publish stale retained-history snapshots over each other. Lock acquisition uses a gate directory while reclaiming or creating the main lock, so no third writer can enter during orphan restore. Lock release verifies the on-disk owner token before removing the lock, and stale reclaim refuses to steal cross-host locks, unreadable-owner locks, or same-host locks while the recorded owner PID is still alive.

DeepSeek/GLM branch-diff and custom-review material is read from the workspace into memory and sent in the HTTP request body. The API reviewer path does not persist prompt sidecars, copied review bundles, branch-diff files, stdout/stderr logs, PID records, cancel markers, or subprocess state. Git scope discovery uses synchronous child processes that complete before the JobRecord is built; provider execution uses `fetch` in the current process. There is no live provider-owned subprocess to terminate on prune.

Safety proof for deletion: API reviewer pruning only removes directories derived from validated safe job IDs under the API reviewer `jobs/` root. Tampered unsafe state entries are ignored for deletion. Active-looking records are retained and not pruned.

## Grok Web

Applies to Grok Web `review`, `adversarial-review`, and `custom-review`
foreground subscription-tunnel runs.

| Artifact | Root | Contents | Needed for | Safe deletion point | Owner |
| --- | --- | --- | --- | --- | --- |
| `state.json` | `GROK_PLUGIN_DATA` or `.codex-plugin-data/grok` | Latest Grok job summary | `grok-web-reviewer.mjs list` and latest local diagnostics | Never as per-job cleanup | `grok-web-reviewer.mjs` |
| `jobs/<jobId>/meta.json` | Grok data root | Canonical Grok Web JobRecord | `grok-web-reviewer.mjs result --job-id <jobId>` and retained diagnostics | Manual cleanup or future retained-history pruning | `grok-web-reviewer.mjs` |
| `jobs/<jobId>/meta.json.*.tmp` | Grok job dir | Partial atomic write | Nothing after interrupted write | Removed on write failure; containing job dir may be manually deleted with the JobRecord | `grok-web-reviewer.mjs` |

Grok branch-diff and custom-review material is read from the workspace into
memory and sent through the local subscription-backed tunnel. The Grok path
does not persist prompt sidecars, copied review bundles, branch-diff files,
stdout/stderr logs, PID records, cancel markers, or subprocess state. Git scope
discovery uses synchronous child processes with Git environment overrides
scrubbed before the JobRecord is built; provider execution uses `fetch` in the
current process. There is no live provider-owned subprocess to terminate on
prune.

Safety proof for deletion: Grok writes per-job records only under the
provider-owned Grok data root with validated generated job IDs. Its current
`state.json` is a latest-job summary, not a retained-history index.

## Failure Paths

- Bad args, unsupported provider/mode, malformed provider config, missing keys, auth failure, scope failure, HTTP failure, timeout, and malformed provider response all produce terminal JobRecords and enter the same retained-history cleanup path.
- Companion scope/spawn/finalization failures clean execution temp roots best-effort at the execution site; any retained per-job sidecars are removed later when terminal history is pruned.
- Sidecar write failures remain diagnostic warnings and do not change the canonical terminal JobRecord.
