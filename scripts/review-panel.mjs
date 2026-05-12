#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { collectReviewPanelRecords, renderReviewPanelMarkdown } from "./lib/review-panel.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/review-panel.mjs <records.json>",
    "  node scripts/review-panel.mjs --workspace <path>",
    "",
    "With a file argument, input must be a JobRecord object, a JSON array of",
    "JobRecords, or an object with a records array. Use '-' to read JSON from",
    "stdin.",
    "",
    "With --workspace, the panel auto-discovers live/recent JobRecords from all",
    "provider state roots (Claude, Gemini, Kimi, Grok, and API Reviewers records",
    "for DeepSeek/GLM) and filters by canonical workspace, so no input file is",
    "needed. Subdirectory matches require the recorded ancestor to be a real",
    "Git repository; non-Git workspaces match only by exact recorded path.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { input: null, workspace: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    if (token === "--workspace") {
      if (out.input) throw new Error("--workspace and a file argument are mutually exclusive");
      const value = argv[++i];
      if (!value) throw new Error("--workspace requires a value");
      out.workspace = value;
      continue;
    }
    if (out.workspace) throw new Error("--workspace and a file argument are mutually exclusive");
    if (out.input) throw new Error(`unexpected argument ${token}`);
    out.input = token;
  }
  return out;
}

function readInput(path) {
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.input && !args.workspace)) {
    console.log(usage());
    process.exit(0);
  }
  const records = args.workspace
    ? collectReviewPanelRecords({ cwd: args.workspace, env: process.env })
    : normalizeRecords(JSON.parse(readInput(args.input)));
  console.log(renderReviewPanelMarkdown(records));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error_code: "review_panel_failed",
    error_message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
