import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PROVIDER_ORDER = ["claude", "gemini", "kimi", "grok", "deepseek", "glm"];
const COMPANION_PROVIDERS = [
  { provider: "claude", env: "CLAUDE_PLUGIN_DATA", fallback: "claude-companion" },
  { provider: "gemini", env: "GEMINI_PLUGIN_DATA", fallback: "gemini-companion" },
  { provider: "kimi", env: "KIMI_PLUGIN_DATA", fallback: "kimi-companion" },
];
const DIRECT_ROOTS = [
  { provider: "grok", env: "GROK_PLUGIN_DATA", plugin: "grok" },
  { provider: "api-reviewers", env: "API_REVIEWERS_PLUGIN_DATA", plugin: "api-reviewers" },
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
  if (errorCode === "models_ok_chat_400" || errorCode.startsWith("grok_session_")) {
    return "not review-ready";
  }
  if (record.status === "completed" && quality(record).failed_review_slot !== true) {
    return "review-ready";
  }
  if (record.status === "failed") return "review failed";
  return "unknown";
}

function jobId(record) {
  return record.job_id ?? record.id ?? "";
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
 * quota_usage_limited, or the raw status as a fallback.
 */
function operatorState(record) {
  const status = String(record.status ?? "");
  const sent = sourceTransmission(record);
  const code = String(record.error_code ?? "");
  if (code === "approval_required" && status === "failed") return "approval_required";
  if (status === "completed" && quality(record).failed_review_slot === true) return "completed_failed_review_slot";
  if (status === "completed") return "completed";
  if ((status === "running" || status === "queued") && sent === "sent") return "source_sent_waiting";
  if (status === "running" || status === "queued") return "running";
  if (status === "failed" && code === "timeout" && sent === "sent") return "source_sent_timeout";
  if (status === "failed" && sent === "not_sent") return "failed_before_source_send";
  if (status === "failed" && ["provider_unavailable", "spawn_failed", "claude_error", "gemini_error", "kimi_error", "tunnel_unavailable"].includes(code)) {
    return "provider_unavailable";
  }
  if (status === "failed" && ["not_authed", "oauth_inference_rejected", "auth_not_configured", "session_expired"].includes(code)) {
    return "auth_session_failure";
  }
  if (status === "failed" && ["usage_limited", "rate_limited"].includes(code)) return "quota_usage_limited";
  return status || "unknown";
}

/**
 * Returns a compact summary of the job outcome.
 *
 * Active jobs (running/queued) return "-" before any other check so that stale
 * failed_review_slot metadata from a prior run never leaks into an in-flight
 * row. After the active guard, priority order is: failed_review_slot, explicit
 * error_code on failure, parsed Verdict keyword, or empty string.
 */
function resultSummary(record) {
  if (record.status === "running" || record.status === "queued") return "-";
  if (quality(record).failed_review_slot === true) return "failed_review_slot";
  if (record.status === "failed" && record.error_code) return record.error_code;
  const verdict = /\bVerdict:\s*(APPROVE|REQUEST CHANGES|FAIL|REJECT)\b/i.exec(String(record.result ?? ""));
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
  return records.map((record) => {
    const semanticFailed = quality(record).failed_review_slot === true;
    return Object.freeze({
      provider: providerName(record),
      job_id: jobId(record),
      state: operatorState(record),
      status: record.status ?? "",
      readiness: readiness(record),
      sent: sourceTransmission(record),
      source_sent: sourceTransmission(record),
      elapsed_ms: elapsedMs(record),
      timeout_ms: timeoutMs(record),
      result: resultSummary(record),
      semantic_failed: semanticFailed,
      inspection: inspectionStatus(record),
      error_code: record.error_code ?? "",
      http_status: record.http_status ?? "",
      reasons: reasons(record),
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

function trimHyphens(value) {
  return value.replace(/^-+|-+$/g, "");
}

function companionStateId(cwd) {
  const workspaceRoot = resolve(cwd);
  const canonical = canonicalWorkspace(workspaceRoot);
  const slug = trimHyphens((basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-")) || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

function defaultDataRoot(pluginName, cwd) {
  const workspace = resolve(cwd);
  const slug = basename(workspace).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspace(workspace)).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "codex-plugin-multi", pluginName, `${slug}-${hash}`);
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordsFromJobsDir(jobsDir) {
  if (!existsSync(jobsDir)) return [];
  const out = [];
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(join(jobsDir, entry.name, "meta.json"));
    if (record) out.push(record);
  }
  return out;
}

function recordsFromCompanionProvider({ env, fallback }, cwd, processEnv) {
  const pluginData = processEnv[env];
  if (!pluginData) {
    return recordsFromJobsDir(join(tmpdir(), fallback, companionStateId(cwd), "jobs"));
  }
  const stateRoot = join(pluginData, "state");
  if (!existsSync(stateRoot)) return [];
  return readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => recordsFromJobsDir(join(stateRoot, entry.name, "jobs")));
}

function recordsFromDirectProvider({ env, plugin }, cwd, processEnv) {
  const root = processEnv[env] ? resolve(processEnv[env]) : defaultDataRoot(plugin, cwd);
  return recordsFromJobsDir(join(root, "jobs"));
}

function recordWorkspaceMatches(record, canonicalCwd) {
  const recordWorkspace = record.workspace_root ?? record.workspaceRoot ?? null;
  if (!recordWorkspace) return false;
  return canonicalWorkspace(recordWorkspace) === canonicalCwd;
}

function timestamp(record) {
  const raw = record.updatedAt ?? record.ended_at ?? record.endedAt ?? record.started_at ?? record.startedAt ?? "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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
    ...COMPANION_PROVIDERS.flatMap((provider) => recordsFromCompanionProvider(provider, cwd, env)),
    ...DIRECT_ROOTS.flatMap((provider) => recordsFromDirectProvider(provider, cwd, env)),
  ].filter((record) => recordWorkspaceMatches(record, workspaceCanonical));
  return records.sort((left, right) => {
    const providerDiff = PROVIDER_ORDER.indexOf(providerName(left)) - PROVIDER_ORDER.indexOf(providerName(right));
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
