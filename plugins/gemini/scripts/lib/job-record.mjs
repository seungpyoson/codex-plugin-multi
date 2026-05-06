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

import {
  buildExternalReview,
  sourceContentTransmissionForExecution,
} from "./external-review.mjs";
import path from "node:path";

export const SCHEMA_VERSION = 10;

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
  "kimi_session_id",
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
  "review_metadata",
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
  "external_review",
  "disclosure_note",
  "runtime_diagnostics",

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

function stringBytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function buildReviewMetadata(invocation, execution = null, parsed = null) {
  if (!invocation.review_prompt_contract_version) return null;
  return Object.freeze({
    prompt_contract_version: invocation.review_prompt_contract_version,
    prompt_provider: invocation.review_prompt_provider ?? invocation.target,
    scope: invocation.scope,
    scope_base: invocation.scope_base ?? null,
    scope_paths: invocation.scope_paths ?? null,
    raw_output: execution ? Object.freeze({
      stdout_bytes: stringBytes(execution.stdout),
      stderr_bytes: stringBytes(execution.stderr),
      parsed_ok: parsed?.ok ?? null,
      result_chars: typeof parsed?.result === "string" ? parsed.result.length : null,
    }) : null,
    audit_manifest: execution?.reviewAuditManifest ?? null,
  });
}

export function externalReviewForInvocation(invocation, execution = null) {
  const { status, error_code } = classifyExecution(execution);
  const sourceContentTransmission = sourceContentTransmissionForExecution({
    status,
    errorCode: error_code,
    pidInfo: execution?.pidInfo ?? null,
  });
  return buildExternalReview({
    invocation,
    sessionId: execution?.geminiSessionId ?? null,
    status,
    errorCode: error_code,
    sourceContentTransmission,
  });
}

/**
 * Infer lifecycle status + error classification from the execution tuple.
 *
 * Status derivation (spec §21.3):
 *   queued      — no execution yet (background launch, pre-worker).
 *   completed   — exitCode === 0 AND parsed.ok === true.
 *   cancelled   — target CLI exited via SIGTERM/SIGKILL from an operator
 *                 cancel (#16 follow-up 2). timedOut runs are NOT cancelled.
 *   failed      — anything else.
 *
 * error_code classification:
 *   null            — completed or cancelled.
 *   scope_failed    — execution.errorMessage describes scope preparation refusal.
 *   spawn_failed    — execution.errorMessage set (spawn threw before Gemini ran).
 *   finalization_failed — errorMessage starts "finalization_failed:" — the
 *                         companion's executeRun fallback path (#16 follow-up 1).
 *                         Distinguished from spawn_failed so monitoring/automation
 *                         routing on error_code doesn't conflate disk/lock failures
 *                         with missing-binary errors. PR #21 review HIGH 1.
 *   parse_error     — parsed.ok === false with reason starting "json_parse"/"empty_stdout".
 *   timeout         — execution.timedOut === true (companion's wall-clock kill).
 *   gemini_error    — exitCode !== 0 with parseable JSON from Gemini.
 *                     Also covers exitCode === 0 but parsed.ok === false with
 *                     is_error semantics.
 *   gemini_error    — catch-all target failure; should be rare when no
 *                     parsed diagnostic is available.
 */
const CANCEL_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const FINALIZATION_FAILED_PREFIX = "finalization_failed:";

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
  if (execution.status === "stale") {
    // #16 follow-up 3: orphan reconciliation produces a terminal stale
    // record so an operator can `continue --job` it instead of having
    // active history grow forever. errorMessage is the reason text.
    return {
      status: "stale",
      error_code: "stale_active_job",
      error_message: execution.errorMessage ?? "stale_active_job",
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
    // Distinguish finalization_failed (post-target persistence failure) from
    // spawn_failed (target never ran). The companion's executeRun fallback
    // synthesizes the former with a fixed prefix; everything else is a true
    // pre-spawn failure. PR #21 review HIGH 1.
    const isFinalization = String(execution.errorMessage).startsWith(FINALIZATION_FAILED_PREFIX);
    return {
      status: "failed",
      error_code: isFinalization ? "finalization_failed" : "spawn_failed",
      error_message: execution.errorMessage,
    };
  }
  // #16 follow-up 1 / 2: a wall-clock timeout fires SIGTERM too, so check
  // timedOut FIRST. Only signal-driven exits without timedOut are cancels.
  if (execution.timedOut === true) {
    return {
      status: "failed",
      error_code: "timeout",
      error_message: "target CLI exceeded the configured timeoutMs",
    };
  }
  if (CANCEL_SIGNALS.has(execution.signal ?? "")) {
    return {
      status: "cancelled",
      error_code: null,
      error_message: null,
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
  "scope_base_invalid:",
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

  if (message.startsWith("scope_base_invalid:") || message.startsWith("scope_base_missing:")) {
    return {
      error_summary: "Review scope was rejected before target launch.",
      error_cause:
        "A missing, unsafe, or unresolvable git base ref prevented scope preparation. " +
        "Branch-diff scopes require a valid, fetchable base ref.",
      suggested_action:
        "To fix this, choose a valid base ref (a branch name, tag, remote ref, or commit SHA) and " +
        "pass it via `--scope-base <ref>`. Alternatively, use working-tree scope which " +
        "does not require a base ref. Option-shaped values beginning with '-' are rejected before git branch-diff runs.",
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
        "Branch-diff reviews committed HEAD-vs-base changes only; it does not include dirty working-tree edits. " +
        "For branch diffs, choose a different --scope-base <ref> if this branch should have committed changes, " +
        "or retry with --scope-base HEAD~1 to review the last commit. For uncommitted, already-merged, or no-diff branches, " +
        "retry with `--mode=custom-review` and explicit `--scope-paths <glob,...>` so source selection stays explicit.",
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
    "prompt_head", "binary", "started_at", "run_kind",
  ]) {
    if (!(f in invocation)) {
      throw new Error(`buildJobRecord: invocation missing required field "${f}"`);
    }
  }
}

function targetFromDenial(denial) {
  if (typeof denial === "string") return denial;
  if (!denial || typeof denial !== "object") return null;
  return denial.target ?? denial.path ?? denial.file_path ?? denial.file ?? null;
}

function toolFromDenial(denial) {
  if (!denial || typeof denial !== "object") return null;
  return denial.tool ?? denial.name ?? null;
}

function pathInside(base, target) {
  if (!base || !target || !path.isAbsolute(target)) {
    return { inside: null, relative: null };
  }
  const relative = path.relative(base, target);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return {
    inside,
    relative: inside ? (relative || ".") : null,
  };
}

function normalizeRuntimeDiagnostics(input, denials) {
  if (!input || typeof input !== "object") return null;

  const addDir = typeof input.add_dir === "string" ? input.add_dir : null;
  const childCwd = typeof input.child_cwd === "string" ? input.child_cwd : null;
  const scopePathMappings = Array.isArray(input.scope_path_mappings)
    ? input.scope_path_mappings.map((mapping) => ({
      original: typeof mapping?.original === "string" ? mapping.original : null,
      contained: typeof mapping?.contained === "string" ? mapping.contained : null,
      relative: typeof mapping?.relative === "string" ? mapping.relative : null,
      inside_add_dir: mapping?.inside_add_dir === true,
    }))
    : [];
  const permissionDenials = Array.isArray(denials)
    ? denials.map((denial) => {
      const target = targetFromDenial(denial);
      const { inside, relative } = pathInside(addDir, target);
      return {
        tool: toolFromDenial(denial),
        target,
        inside_add_dir: inside,
        relative_to_add_dir: relative,
      };
    })
    : [];

  return {
    add_dir: addDir,
    child_cwd: childCwd,
    scope_path_mappings: scopePathMappings,
    permission_denials: permissionDenials,
  };
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
 *                    claudeSessionId?, geminiSessionId?, kimiSessionId?, pidInfo,
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
  const permissionDenials = Array.isArray(parsed?.denials) ? parsed.denials : [];
  const runtimeDiagnostics = normalizeRuntimeDiagnostics(
    execution?.runtimeDiagnostics ?? null,
    permissionDenials,
  );
  const record = {
    // Identity
    id: invocation.job_id,
    job_id: invocation.job_id,
    target: invocation.target,
    parent_job_id: invocation.parent_job_id ?? null,
    claude_session_id: execution?.claudeSessionId ?? null,
    gemini_session_id: execution?.geminiSessionId ?? null,
    kimi_session_id: execution?.kimiSessionId ?? null,
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
    review_metadata: buildReviewMetadata(invocation, execution, parsed),
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
    external_review: externalReviewForInvocation(invocation, execution),
    disclosure_note: diagnostic.disclosure_note,
    runtime_diagnostics: runtimeDiagnostics,

    // Result
    result: parsed?.result ?? null,
    structured_output: parsed?.structured ?? null,
    permission_denials: permissionDenials,
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
