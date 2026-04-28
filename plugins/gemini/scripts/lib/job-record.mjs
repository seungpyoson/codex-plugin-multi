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

export const SCHEMA_VERSION = 6;

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
 *   cancelled   — target CLI exited via SIGTERM/SIGKILL from an operator
 *                 cancel (#16 follow-up 2). timedOut runs are NOT cancelled.
 *   failed      — anything else.
 *
 * error_code classification:
 *   null            — completed or cancelled.
 *   spawn_failed    — execution.errorMessage set (spawn threw before Gemini ran).
 *   parse_error     — parsed.ok === false with reason starting "json_parse"/"empty_stdout".
 *   timeout         — execution.timedOut === true (companion's wall-clock kill).
 *   gemini_error    — exitCode !== 0 with parseable JSON from Gemini.
 *                     Also covers exitCode === 0 but parsed.ok === false with
 *                     is_error semantics.
 *   unknown_error   — catch-all; should be rare.
 */
const CANCEL_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

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
  if (execution.errorMessage) {
    return {
      status: "failed",
      error_code: "spawn_failed",
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
