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

function hasPermissionDenial(record) {
  const denials = valueAt(record, ["runtime_diagnostics", "permission_denials"], []);
  if (Array.isArray(denials) && denials.length > 0) return true;
  return /\b(permission denied|read denied|could not inspect|not reviewed)\b/i.test(String(record.result ?? ""));
}

function inspectionStatus(record) {
  if (hasPermissionDenial(record)) return "blocked";
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

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/**
 * Normalizes heterogeneous provider JobRecords into one provider-panel row.
 *
 * The row intentionally keeps product-state columns together: readiness,
 * transport status, source transmission, timing, semantic failure, inspection,
 * provider error code, HTTP status, and semantic reasons.
 */
export function buildReviewPanelRows(records = []) {
  return records.map((record) => {
    const semanticFailed = quality(record).failed_review_slot === true;
    return Object.freeze({
      provider: providerName(record),
      status: record.status ?? "",
      readiness: readiness(record),
      source_sent: sourceTransmission(record),
      elapsed_ms: elapsedMs(record),
      semantic_failed: semanticFailed,
      inspection: inspectionStatus(record),
      error_code: record.error_code ?? "",
      http_status: record.http_status ?? "",
      reasons: reasons(record),
    });
  });
}

export function renderReviewPanelMarkdown(records = []) {
  const rows = buildReviewPanelRows(records);
  const header = [
    "Provider",
    "Readiness",
    "Status",
    "Source Sent",
    "Elapsed ms",
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
      row.readiness,
      row.status,
      row.source_sent,
      row.elapsed_ms,
      row.semantic_failed,
      row.inspection,
      row.error_code,
      row.http_status,
      row.reasons,
    ].map(cell).join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}
