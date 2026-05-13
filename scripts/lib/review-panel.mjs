import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

const PROVIDER_ORDER = ["claude", "gemini", "kimi", "grok", "grok-web", "deepseek", "glm"];
const VERDICT_RE = /\bVerdict:\s*(APPROVE|REQUEST CHANGES|FAIL|REJECT)\b/i;
const PROVIDER_UNAVAILABLE_CODES = new Set(["provider_unavailable", "spawn_failed", "claude_error", "gemini_error", "kimi_error", "tunnel_unavailable"]);
const AUTH_FAILURE_CODES = new Set(["not_authed", "oauth_inference_rejected", "auth_not_configured", "session_expired"]);
const COMPANION_PROVIDERS = [
  { provider: "claude", env: "CLAUDE_PLUGIN_DATA", fallback: "claude-companion" },
  { provider: "gemini", env: "GEMINI_PLUGIN_DATA", fallback: "gemini-companion" },
  { provider: "kimi", env: "KIMI_PLUGIN_DATA", fallback: "kimi-companion" },
];
const DIRECT_ROOTS = [
  { env: "GROK_PLUGIN_DATA", plugin: "grok" },
  { env: "API_REVIEWERS_PLUGIN_DATA", plugin: "api-reviewers" },
];

function valueAt(record, path, fallback = null) {
  let current = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) {
      return fallback;
    }
    current = current[key];
  }
  return current ?? fallback;
}

function isRecordObject(record) {
  return record && typeof record === "object" && !Array.isArray(record);
}

function providerName(record) {
  return record.provider
    ?? record.target
    ?? valueAt(record, ["external_review", "provider"])
    ?? "unknown";
}

function sourceTransmission(record) {
  return valueAt(record, ["external_review", "source_content_transmission"], "unknown");
}

function quality(record) {
  return valueAt(record, ["review_metadata", "audit_manifest", "review_quality"], {});
}

function reasons(record) {
  const raw = quality(record).semantic_failure_reasons;
  return Array.isArray(raw) ? raw.join(",") : "";
}

function isActiveStatus(status) {
  return status === "running" || status === "queued";
}

function elapsedMs(record) {
  const value = valueAt(record, ["review_metadata", "raw_output", "elapsed_ms"], null);
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function timeoutMs(record) {
  const value = valueAt(record, ["review_metadata", "audit_manifest", "request", "timeout_ms"], null);
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function hasPermissionDenial(record) {
  const denials = valueAt(record, ["runtime_diagnostics", "permission_denials"], []);
  if (Array.isArray(denials) && denials.length > 0) return true;
  return /\b(permission denied|read denied|could not inspect)\b/i.test(String(record.result ?? ""));
}

function inspectionStatus(record) {
  if (hasPermissionDenial(record)) return "blocked";
  if (/\bnot reviewed\b/i.test(String(record.result ?? ""))) return "unknown";
  if (/\b(inspected|reviewed|read)\b/i.test(String(record.result ?? ""))) return "inspected";
  return "unknown";
}

function readiness(record) {
  const errorCode = record.error_code ?? "";
  if (record.status === "completed" && quality(record).failed_review_slot !== true) {
    return "review-ready";
  }
  if (record.status === "completed" && quality(record).failed_review_slot === true) {
    return "review failed";
  }
  if (record.status === "failed") {
    if (errorCode === "models_ok_chat_400" || errorCode.startsWith("grok_session_")) {
      return "not review-ready";
    }
    return "review failed";
  }
  return "unknown";
}

function jobId(record) {
  return record.job_id ?? record.id ?? "";
}

/**
 * Resolves the sub-state of a failed job from its transmission state and error
 * code.  Called only when record.status === "failed".
 */
function failedState(sent, code) {
  if (code === "approval_required") return "approval_required";
  if (code === "timeout" && sent === "sent") return "source_sent_timeout";
  if (PROVIDER_UNAVAILABLE_CODES.has(code)) return "provider_unavailable";
  if (AUTH_FAILURE_CODES.has(code)) return "auth_session_failure";
  if (code === "rate_limited") return "rate_limited";
  if (code === "usage_limited") return "usage_limited";
  if (sent === "not_sent") return "failed_before_source_send";
  return "failed";
}

/**
 * Classifies a job record into a priority-ordered operational state.
 *
 * The state machine checks conditions in load-bearing order: approval_required
 * is only surfaced when status is strictly "failed" (never for running/queued
 * jobs, even with a stale approval_required error code). Returns one of:
 * approval_required, completed_failed_review_slot, completed,
 * source_sent_waiting, running, source_sent_timeout,
 * failed_before_source_send, provider_unavailable, auth_session_failure,
 * rate_limited, usage_limited, or the raw status as a fallback.
 */
function operatorState(record) {
  const status = String(record.status ?? "");
  const sent = sourceTransmission(record);
  const code = String(record.error_code ?? "");
  if (status === "failed") return failedState(sent, code);
  if (status === "completed" && quality(record).failed_review_slot === true) return "completed_failed_review_slot";
  if (status === "completed") return "completed";
  if ((status === "running" || status === "queued") && sent === "sent") return "source_sent_waiting";
  if (status === "running" || status === "queued") return "running";
  return status || "unknown";
}

/**
 * Returns a compact summary of the job outcome.
 *
 * Active jobs (running/queued) return "-" before any other check so that stale
 * failed_review_slot metadata from a prior run never leaks into an in-flight
 * row. After the active guard, priority order is: explicit error_code on
 * failure, failed_review_slot, parsed Verdict keyword, or empty string.
 */
function resultSummary(record) {
  if (isActiveStatus(record.status)) return "-";
  if (record.status === "failed" && record.error_code) return record.error_code;
  if (quality(record).failed_review_slot === true) return "failed_review_slot";
  const verdict = VERDICT_RE.exec(String(record.result ?? ""));
  if (!verdict) return "";
  return verdict[1].toLowerCase().replace(/\s+/g, "_");
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/**
 * Normalizes heterogeneous provider JobRecords into one provider-panel row.
 *
 * The row exposes per-job identity and operational columns (Job ID, operator
 * State, Sent, Elapsed ms, Timeout ms, Result) alongside product-state columns
 * (readiness, terminal status, semantic failure, inspection, provider error
 * code, HTTP status, and semantic reasons).
 */
export function buildReviewPanelRows(records = []) {
  return records.filter(isRecordObject).map((record) => {
    const showReviewQuality = !isActiveStatus(record.status);
    const semanticFailed = showReviewQuality && quality(record).failed_review_slot === true;
    return Object.freeze({
      provider: providerName(record),
      job_id: jobId(record),
      state: operatorState(record),
      status: record.status ?? "",
      readiness: readiness(record),
      sent: sourceTransmission(record),
      // Backward-compatible alias for consumers that still read the old field.
      source_sent: sourceTransmission(record),
      elapsed_ms: elapsedMs(record),
      timeout_ms: timeoutMs(record),
      result: resultSummary(record),
      semantic_failed: semanticFailed,
      inspection: inspectionStatus(record),
      error_code: record.status === "failed" ? (record.error_code ?? "") : "",
      http_status: record.http_status ?? "",
      reasons: showReviewQuality ? reasons(record) : "",
    });
  });
}

function canonicalWorkspace(cwd) {
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isRecordObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordsFromJobsDir(jobsDir) {
  if (!existsSync(jobsDir)) return [];
  try {
    const jobsDirStat = lstatSync(jobsDir);
    if (!jobsDirStat.isDirectory() || jobsDirStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const out = [];
  let entries;
  try {
    entries = readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const flatJobIds = new Set(
    entries
      .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length)),
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    let record = null;
    if (entry.isDirectory()) {
      if (flatJobIds.has(entry.name)) continue;
      record = readRecord(join(jobsDir, entry.name, "meta.json"));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      record = readRecord(join(jobsDir, entry.name));
    }
    if (record) out.push(record);
  }
  return out;
}

function recordsFromStateRoot(stateRoot) {
  if (!existsSync(stateRoot)) return [];
  let stateEntries;
  try {
    stateEntries = readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return stateEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry) => recordsFromJobsDir(join(stateRoot, entry.name, "jobs")));
}

function recordsFromCompanionProvider({ env, fallback }, processEnv) {
  const pluginData = processEnv[env];
  const stateRoot = pluginData ? join(pluginData, "state") : join(tmpdir(), fallback);
  return recordsFromStateRoot(stateRoot);
}

function directFallbackStateRoot(plugin) {
  return resolve(tmpdir(), "codex-plugin-multi", plugin);
}

function recordsFromDirectProvider({ env, plugin }, processEnv) {
  if (processEnv[env] != null) return recordsFromJobsDir(join(resolve(processEnv[env]), "jobs"));
  return recordsFromStateRoot(directFallbackStateRoot(plugin));
}

function isPathWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function isUnsafeWorkspaceAncestor(recordCanonical, canonicalCwd) {
  if (recordCanonical === canonicalCwd) return false;
  if (recordCanonical === parse(recordCanonical).root) return true;
  if (recordCanonical === canonicalTmpdir()) return true;
  return false;
}

let canonicalTmpdirValue = null;
function canonicalTmpdir() {
  canonicalTmpdirValue ??= canonicalWorkspace(tmpdir());
  return canonicalTmpdirValue;
}

function isGitRepositoryRoot(workspace) {
  const gitPath = join(workspace, ".git");
  let gitStat;
  try {
    gitStat = lstatSync(gitPath);
  } catch {
    return false;
  }
  if (gitStat.isDirectory()) return existsSync(join(gitPath, "HEAD"));
  if (!gitStat.isFile()) return false;

  let firstLine;
  try {
    [firstLine = ""] = readFileSync(gitPath, "utf8").split(/\r?\n/, 1);
  } catch {
    return false;
  }
  if (!firstLine.startsWith("gitdir:")) return false;
  const rawGitDir = firstLine.slice("gitdir:".length).trim();
  if (!rawGitDir) return false;
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(workspace, rawGitDir);
  try {
    return lstatSync(gitDir).isDirectory() && existsSync(join(gitDir, "HEAD"));
  } catch {
    return false;
  }
}

function recordWorkspaceMatches(record, canonicalCwd) {
  const recordWorkspace = record.workspace_root ?? record.workspaceRoot ?? null;
  if (typeof recordWorkspace !== "string" || recordWorkspace.length === 0) return false;
  const recordCanonical = canonicalWorkspace(recordWorkspace);
  if (!isPathWithin(recordCanonical, canonicalCwd)) return false;
  if (recordCanonical === canonicalCwd) return true;
  if (isUnsafeWorkspaceAncestor(recordCanonical, canonicalCwd)) return false;
  return isGitRepositoryRoot(recordCanonical);
}

function timestamp(record) {
  const raw = record.updatedAt ?? record.ended_at ?? record.endedAt ?? record.started_at ?? record.startedAt ?? "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function providerOrderIndex(provider) {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

/**
 * Aggregates live/recent JobRecords across companion and direct provider state
 * roots, filters to the canonical workspace, and returns them sorted by
 * provider order then timestamp.
 *
 * Providers scanned: Claude, Gemini, Kimi (companion), Grok, and
 * api-reviewers (direct). Records without workspace metadata are excluded.
 *
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {object[]} workspace-matched JobRecords sorted by provider order,
 *   then descending timestamp, then job_id.
 */
export function collectReviewPanelRecords({ cwd = process.cwd(), env = process.env } = {}) {
  const workspaceCanonical = canonicalWorkspace(cwd);
  const records = [
    ...COMPANION_PROVIDERS.flatMap((provider) => recordsFromCompanionProvider(provider, env)),
    ...DIRECT_ROOTS.flatMap((provider) => recordsFromDirectProvider(provider, env)),
  ].filter((record) => recordWorkspaceMatches(record, workspaceCanonical));
  return records.sort((left, right) => {
    const providerDiff = providerOrderIndex(providerName(left)) - providerOrderIndex(providerName(right));
    if (providerDiff !== 0) return providerDiff;
    return timestamp(right) - timestamp(left) || String(jobId(left)).localeCompare(String(jobId(right)));
  });
}

export function renderReviewPanelMarkdown(records = []) {
  const rows = buildReviewPanelRows(records);
  const header = [
    "Provider",
    "Job ID",
    "State",
    "Sent",
    "Elapsed ms",
    "Timeout ms",
    "Result",
    "Readiness",
    "Status",
    "Semantic Failed",
    "Inspection",
    "Error Code",
    "HTTP",
    "Reasons",
  ];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => [
      row.provider,
      row.job_id,
      row.state,
      row.sent,
      row.elapsed_ms,
      row.timeout_ms,
      row.result,
      row.readiness,
      row.status,
      row.semantic_failed,
      row.inspection,
      row.error_code,
      row.http_status,
      row.reasons,
    ].map(cell).join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}
