#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { renderReviewPanelMarkdown } from "./lib/review-panel.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/review-panel.mjs <records.json>",
    "",
    "Input must be a JobRecord object, a JSON array of JobRecords, or an object",
    "with a records array. Use '-' to read JSON from stdin.",
  ].join("\n");
}

function readInput(path) {
  if (!path || path === "--help" || path === "-h") {
    return null;
  }
  if (path === "-") return readFileSync(0, "utf8");
  return readFileSync(path, "utf8");
}

function normalizeRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.records)) return parsed.records;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error("input must be a JobRecord object, a JSON array, or { records: [...] }");
}

try {
  const input = readInput(process.argv[2]);
  if (input === null) {
    console.log(usage());
    process.exit(0);
  }
  const records = normalizeRecords(JSON.parse(input));
  console.log(renderReviewPanelMarkdown(records));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error_code: "review_panel_failed",
    error_message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
