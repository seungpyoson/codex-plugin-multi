// Claude-specific dispatcher. Spawns `claude -p ...` per spec §7.2 / §10
// with the layered-defense flag stack for read-only review and the
// acceptEdits permission mode for rescue. Pure Claude concerns live here;
// job-store / workspace concerns live in state.mjs + tracked-jobs.mjs.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Tools Claude should never invoke in review mode (hard blocklist, most
// reliable layer per spec §4.5). `mcp__*` wildcard blocks every MCP tool.
const REVIEW_DISALLOWED = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash", "WebFetch", "Agent", "Task", "mcp__*",
].join(" ");

// Claude requires UUIDv4 for --session-id. We always pass one up-front so we
// know the session ID before the call returns and can --resume later.
function isUuidV4(s) {
  return typeof s === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
}

/**
 * Build the argv array for `claude -p ...`. Extracted for unit testing; the
 * actual spawn lives in spawnClaude() below.
 */
export function buildClaudeArgs({
  mode,                 // "review" | "adversarial-review" | "rescue"
  model,                // full model ID (e.g., claude-haiku-4-5-20251001)
  promptText,
  sessionId,
  resumeId = null,      // if set, uses --resume <uuid> instead of --session-id (for `continue`)
  addDir = null,        // workspace path to grant read access
  jsonSchema = null,    // optional JSON Schema string for structured output
  stripContext = true,  // false = keep CLAUDE.md (used by rescue when caller wants inherited context)
} = {}) {
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("buildClaudeArgs: promptText is required");
  }
  if (resumeId !== null && !isUuidV4(resumeId)) {
    throw new Error(`buildClaudeArgs: resumeId must be UUID v4; got ${JSON.stringify(resumeId)}`);
  }
  if (resumeId === null && !isUuidV4(sessionId)) {
    throw new Error(`buildClaudeArgs: sessionId must be UUID v4; got ${JSON.stringify(sessionId)}`);
  }
  if (typeof model !== "string" || !model) {
    throw new Error("buildClaudeArgs: model is required (full ID, no aliases)");
  }

  const args = [
    "-p", promptText,
    "--output-format", "json",
    "--no-session-persistence",
    "--model", model,
  ];
  if (resumeId) {
    // --resume continues a prior Claude session; a fresh --session-id must NOT
    // also be passed or Claude rejects the argv.
    args.push("--resume", resumeId);
  } else {
    args.push("--session-id", sessionId);
  }

  // Layer 1: strip CLAUDE.md bias. --setting-sources "" keeps OAuth working
  // (unlike --bare which disables OAuth). Verified spec §4.6.
  if (stripContext) args.push("--setting-sources", "");

  if (mode === "rescue") {
    // Writes allowed; model follows the plan. acceptEdits auto-approves
    // edits without prompting (headless mode).
    args.push("--permission-mode", "acceptEdits");
    if (addDir) args.push("--add-dir", addDir);
  } else if (mode === "review" || mode === "adversarial-review") {
    args.push("--permission-mode", "plan");           // soft layer
    args.push("--disallowedTools", REVIEW_DISALLOWED); // hard blocklist
    if (addDir) args.push("--add-dir", addDir);       // scoped read access
    if (jsonSchema) args.push("--json-schema", jsonSchema);
  } else {
    throw new Error(`buildClaudeArgs: unknown mode "${mode}"`);
  }

  return args;
}

/**
 * Parse Claude's JSON result. Prefers structured_output when present (schema
 * runs) with a text-parse fallback over result. Surfaces permission_denials
 * and apiKeySource for the caller to inspect.
 */
export function parseClaudeResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty_stdout", raw: stdout };
  }
  let parsed;
  try {
    // Claude emits a single JSON object on --output-format=json.
    parsed = JSON.parse(trimmed.split("\n").pop());
  } catch (e) {
    return { ok: false, reason: "json_parse_error", error: e.message, raw: stdout };
  }
  const structured = parsed.structured_output ?? null;
  const resultText = typeof parsed.result === "string" ? parsed.result : null;
  return {
    ok: !parsed.is_error,
    sessionId: parsed.session_id ?? null,
    result: resultText,
    structured,
    denials: Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [],
    apiKeySource: parsed.apiKeySource ?? null,
    usage: parsed.usage ?? null,
    costUsd: parsed.total_cost_usd ?? null,
    raw: parsed,
  };
}

/**
 * Spawn `claude -p` and return the parsed result. Single-shot (no streaming).
 * Timeouts and signal handling live here, not in the caller.
 */
export async function spawnClaude({
  mode,
  model,
  promptText,
  sessionId = randomUUID(),
  resumeId = null,
  addDir = null,
  jsonSchema = null,
  stripContext = true,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 0,                 // 0 = no timeout
  binary = "claude",
} = {}) {
  const args = buildClaudeArgs({ mode, model, promptText, sessionId, resumeId, addDir, jsonSchema, stripContext });
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error(`spawn ${binary} failed: ${e.message}`), { code: e.code }));
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const parsed = parseClaudeResult(stdout);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        sessionId,
        parsed,
      });
    });
  });
}

export const _internal = { REVIEW_DISALLOWED, isUuidV4 };
