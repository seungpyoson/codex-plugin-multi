// JobRecord schema (spec §21.3) — the ONE shape the companion durably
// persists, reads back, and returns to its callers.
//
// Historical defect: three different shapes existed.
//   1. baseRecord  — written at cmdRun entry (status: running/queued).
//   2. printJson   — foreground stdout, hand-assembled from execution vars.
//   3. finalRecord — persisted terminal meta, omitted result/denials/mutations.
//
// Consumers (cmdResult, result-handling skill) couldn't render a
// background job's result because the persisted record didn't carry it
// (finding #1/H1). The full prompt was persisted at 0644, leaking user
// context (finding #9). Skill docs described fields that never existed.
//
// This module replaces all three with ONE builder. Foreground and background
// paths converge through buildJobRecord. cmdResult reads the file verbatim.
//
// Design rules:
// - Frozen output — consumers cannot mutate in place.
// - No full `prompt` field, ever. `prompt_head` ≤200 chars is the only text.
// - Every EXPECTED_KEYS entry present on every record (nullable allowed).
// - Schema drift is a test failure (job-record.test.mjs asserts on keys AND
//   on claude-result-handling/SKILL.md mentioning each field).

export const SCHEMA_VERSION = 7;

/**
 * Canonical JobRecord field list. Exported so tests can reference it and
 * the skill can be verified against it. The ORDER here matches the spec
 * §21.3 table for readability; persisted JSON does not rely on order.
 */
export const EXPECTED_KEYS = Object.freeze([
  // Identity (§21.1)
  "id",                   // legacy alias for job_id; kept until T8 can drop
  "job_id",
  "target",
  "parent_job_id",
  "claude_session_id",
  "gemini_session_id",
  "resume_chain",
  "pid_info",

  // Invocation (§21.2)
  "mode",
  "mode_profile_name",
  "model",
  "cwd",
  "workspace_root",
  "containment",
  "scope",
  "dispose_effective",
  "scope_base",
  "scope_paths",
  "prompt_head",
  "schema_spec",
  "binary",

  // Lifecycle
  "status",
  "started_at",
  "ended_at",
  "exit_code",
  "error_code",
  "error_message",
  "error_summary",
  "error_cause",
  "suggested_action",
  "disclosure_note",

  // Result
  "result",
  "structured_output",
  "permission_denials",
  "mutations",
  "cost_usd",
  "usage",

  // Bookkeeping
  "schema_version",
]);

const EXPECTED_KEYS_SET = new Set(EXPECTED_KEYS);

/**
 * Infer lifecycle status + error classification from the execution tuple.
 *
 * Status derivation (spec §21.3):
 *   queued      — no execution yet (background launch, pre-worker).
 *   completed   — exitCode === 0 AND parsed.ok === true.
 *   failed      — anything else.
 *
 * error_code classification:
 *   null           — completed.
 *   scope_failed   — execution.errorMessage describes scope preparation refusal.
 *   spawn_failed   — execution.errorMessage set (spawn threw before Gemini ran).
 *   parse_error    — parsed.ok === false with reason starting "json_parse"/"empty_stdout".
 *   gemini_error   — exitCode !== 0 with parseable JSON from Gemini.
 *                    Also covers exitCode === 0 but parsed.ok === false with
 *                    is_error semantics.
 *   unknown_error  — catch-all; should be rare.
 */
function classifyExecution(execution) {
  if (!execution) {
    return {
      status: "queued",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.status === "running") {
    return {
      status: "running",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.status === "cancelled") {
    // Issue #22 sub-task 2: see claude-side counterpart for rationale.
    return {
      status: "cancelled",
      error_code: null,
      error_message: null,
    };
  }
  if (execution.errorMessage) {
    if (isScopeFailure(execution.errorMessage)) {
      return {
        status: "failed",
        error_code: "scope_failed",
        error_message: execution.errorMessage,
      };
    }
    return {
      status: "failed",
      error_code: "spawn_failed",
      error_message: execution.errorMessage,
    };
  }
  const parsed = execution.parsed ?? null;
  if (execution.exitCode === 0 && parsed && parsed.ok === true) {
    return { status: "completed", error_code: null, error_message: null };
  }
  if (parsed && parsed.ok === false) {
    const reason = parsed.reason ?? null;
    if (reason === "json_parse_error" || reason === "empty_stdout") {
      return {
        status: "failed",
        error_code: "parse_error",
        error_message: parsed.error ?? reason,
      };
    }
    return {
      status: "failed",
      error_code: "gemini_error",
      error_message: parsed.error ?? null,
    };
  }
  // Non-zero exit with no parsed JSON diagnostic — treat as gemini_error.
  return {
    status: "failed",
    error_code: "gemini_error",
    error_message: null,
  };
}

const SCOPE_FAILURE_PREFIXES = [
  "unsafe_symlink:",
  "scope_population_failed:",
  "scope_base_missing:",
  "scope_requires_git:",
  "scope_requires_head:",
  "scope_paths_required:",
  "scope_empty:",
  "invalid_profile:",
];

function isScopeFailure(message) {
  return SCOPE_FAILURE_PREFIXES.some((prefix) => String(message ?? "").startsWith(prefix));
}

function buildErrorDiagnostic(invocation, status, error_code, error_message) {
  const empty = {
    error_summary: null,
    error_cause: null,
    suggested_action: null,
    disclosure_note: null,
  };
  if (status !== "failed" || error_code !== "scope_failed" || !error_message) {
    return empty;
  }

  const message = String(error_message);
  const target = invocation.target === "claude" ? "Claude" : "Gemini";
  const disclosure =
    `Scope preparation failed before ${target} launch. The target CLI was not spawned, ` +
    "so rejected scope content was not sent to the target CLI or external provider. " +
    "Branch-diff reduces scope, but any successful external review still sends selected source content to the target provider.";

  if (message.startsWith("unsafe_symlink:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "A symlink in the selected review scope resolves outside the source root, " +
        "so the companion refused to copy it into disposable containment.",
      suggested_action:
        "For committed branch changes, retry with adversarial-review/branch-diff and an explicit --scope-base <ref>. " +
        "For live working-tree review, remove or relocate the symlink, or use custom scope paths that exclude it.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_population_failed:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The companion could not safely prepare the selected review scope. " +
        "For working-tree scope this often means gitignored files could not be evaluated or filesystem copying failed.",
      suggested_action:
        "Fix the working-tree/index issue and retry. For committed branch changes, retry with adversarial-review/branch-diff and an explicit --scope-base <ref>.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_base_missing:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "A missing base ref or unresolvable git ref prevented scope preparation. " +
        "Branch-diff scopes require a valid, fetchable base ref.",
      suggested_action:
        "To fix this, choose a valid base ref (a branch name, tag, or commit SHA) and " +
        "pass it via `--scope-base <ref>`. Alternatively, use working-tree scope which " +
        "does not require a base ref.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_requires_git:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The selected scope requires a git repository, but the workspace root is not " +
        "inside a git worktree.",
      suggested_action:
        "To resolve this: run from a git worktree or use a scope that supports " +
        "non-git directories (such as passing explicit --scope-paths).",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_requires_head:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The selected scope requires at least one commit (HEAD), but the repository " +
        "has no commits yet.",
      suggested_action:
        "To fix this, create an initial commit before running git-object scopes such " +
        "as branch-diff. Use `git commit` to create the first commit.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_paths_required:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "The custom scope requires explicit paths; no scope paths were provided.",
      suggested_action:
        "To fix this: pass explicit --scope-paths <path> [<path> ...] before `--`. " +
        "For automatic scope detection, use working-tree or branch-diff scope instead.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("scope_empty:")) {
    return {
      error_summary: "Review scope was empty before target launch.",
      error_cause:
        "The selected scope was empty and resolved to no reviewable files. Launching the target " +
        "would produce a misleading completed review with no useful source context.",
      suggested_action:
        "For pinned bundles or selected files, retry with `--mode=custom-review` " +
        "and explicit `--scope-paths <glob,...>`. For branch diffs, check the " +
        "`--scope-base <ref>` value and run preflight before launching the provider.",
      disclosure_note: disclosure,
    };
  }

  if (message.startsWith("invalid_profile:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "This is an internal plugin or profile bug, not a user input error. " +
        "The review profile or plugin configuration is internally inconsistent.",
      suggested_action:
        "Please report this as a bug and include the raw error_message value " +
        "to help diagnose the misconfigured profile field.",
      disclosure_note: disclosure,
    };
  }

  return {
    error_summary: "Review scope was rejected before target launch.",
    error_cause: "The selected review scope could not be prepared safely.",
    suggested_action:
      "Check the raw error_message, fix the scope input, and retry. For committed branch changes, prefer branch-diff with an explicit --scope-base <ref>.",
    disclosure_note: disclosure,
  };
}

/**
 * Assert the invocation object carries the fields buildJobRecord needs.
 * Catches legacy call sites that still pass a full `prompt` (§21.3.1
 * defense in depth — persisting a prompt must be impossible, not merely
 * "the builder happens not to read it").
 */
function assertInvocation(invocation) {
  if (!invocation || typeof invocation !== "object") {
    throw new Error("buildJobRecord: invocation object required");
  }
  if ("prompt" in invocation) {
    throw new Error(
      "buildJobRecord: invocation must not carry a full `prompt` field; " +
      "spec §21.3.1 forbids persisting prompt text. Pass only prompt_head."
    );
  }
  for (const f of [
    "job_id", "target", "mode", "mode_profile_name", "model",
    "cwd", "workspace_root", "containment", "scope",
    "prompt_head", "binary", "started_at",
  ]) {
    if (!(f in invocation)) {
      throw new Error(`buildJobRecord: invocation missing required field "${f}"`);
    }
  }
}

/**
 * Build the single canonical JobRecord.
 *
 * Arguments:
 *   invocation — captured at cmdRun/cmdContinue entry BEFORE the run. Carries
 *                identity + invocation + prompt_head fields. Shape:
 *                  { job_id, target, parent_job_id?, resume_chain?,
 *                    mode_profile_name, mode, model, cwd, workspace_root,
 *                    containment, scope, dispose_effective?,
 *                    scope_base?, scope_paths?, prompt_head, schema_spec?,
 *                    binary, started_at }
 *
 *   execution  — null when writing the pre-run/queued record. Otherwise:
 *                  { exitCode, parsed: {ok, result?, structured?, denials?,
 *                                        costUsd?, usage?, reason?, error?},
 *                    claudeSessionId?, geminiSessionId?, pidInfo,
 *                    errorMessage?, stdout?, stderr? }
 *
 *   mutations  — array of git-status line strings or
 *                mutation_detection_failed entries from T7.2's mutation
 *                detection. Empty array when not applicable.
 *
 * Returns a frozen object whose keys === EXPECTED_KEYS exactly.
 */
export function buildJobRecord(invocation, execution, mutations) {
  assertInvocation(invocation);
  if (!Array.isArray(mutations)) {
    throw new Error("buildJobRecord: mutations must be an array (empty ok)");
  }
  const { status, error_code, error_message } = classifyExecution(execution);
  const diagnostic = buildErrorDiagnostic(invocation, status, error_code, error_message);

  const parsed = execution?.parsed ?? null;
  const record = {
    // Identity
    id: invocation.job_id,
    job_id: invocation.job_id,
    target: invocation.target,
    parent_job_id: invocation.parent_job_id ?? null,
    claude_session_id: execution?.claudeSessionId ?? null,
    gemini_session_id: execution?.geminiSessionId ?? null,
    resume_chain: Array.isArray(invocation.resume_chain)
      ? [...invocation.resume_chain]
      : [],
    pid_info: execution?.pidInfo ?? null,

    // Invocation
    mode: invocation.mode,
    mode_profile_name: invocation.mode_profile_name,
    model: invocation.model,
    cwd: invocation.cwd,
    workspace_root: invocation.workspace_root,
    containment: invocation.containment,
    scope: invocation.scope,
    dispose_effective: invocation.dispose_effective ?? false,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    prompt_head: invocation.prompt_head,
    schema_spec: invocation.schema_spec ?? null,
    binary: invocation.binary,

    // Lifecycle
    status,
    started_at: invocation.started_at,
    ended_at: execution && status !== "running" ? new Date().toISOString() : null,
    exit_code: execution?.exitCode ?? null,
    error_code,
    error_message,
    error_summary: diagnostic.error_summary,
    error_cause: diagnostic.error_cause,
    suggested_action: diagnostic.suggested_action,
    disclosure_note: diagnostic.disclosure_note,

    // Result
    result: parsed?.result ?? null,
    structured_output: parsed?.structured ?? null,
    permission_denials: Array.isArray(parsed?.denials) ? parsed.denials : [],
    mutations: [...mutations],
    cost_usd: parsed?.costUsd ?? null,
    usage: parsed?.usage ?? null,

    // Bookkeeping
    schema_version: SCHEMA_VERSION,
  };

  // Defensive: verify EXACT key set before returning. If future callers add a
  // stray field, this catches it early rather than silently drifting.
  const keys = Object.keys(record);
  if (keys.length !== EXPECTED_KEYS.length) {
    const extras = keys.filter((k) => !EXPECTED_KEYS_SET.has(k));
    const missing = EXPECTED_KEYS.filter((k) => !keys.includes(k));
    throw new Error(
      `buildJobRecord: key set drift. extras=${JSON.stringify(extras)} ` +
      `missing=${JSON.stringify(missing)}`
    );
  }
  return Object.freeze(record);
}
