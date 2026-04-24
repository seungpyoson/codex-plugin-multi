// Claude-specific dispatcher. Spawns `claude -p ...` per spec §7.2 / §10
// with the layered-defense flag stack for read-only review and the
// acceptEdits permission mode for rescue. Pure Claude concerns live here;
// job-store / workspace concerns live in state.mjs + tracked-jobs.mjs.
//
// Post-M7 (spec §21.2): `buildClaudeArgs` and `spawnClaude` take a PROFILE
// object as their first argument and a `runtimeInputs` object as their
// second. No mode-specific knob-with-default lives on these signatures —
// the profile is the only source of those. See lib/mode-profiles.mjs.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Claude requires UUIDv4 for --session-id. We always pass one up-front so we
// know the session ID before the call returns and can --resume later.
function isUuidV4(s) {
  return typeof s === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
}

// Shape-check a profile value. Protects callers from silently getting a raw
// mode-name string or a legacy `{mode, ...}` options bag routed into arg-1.
function assertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("buildClaudeArgs: first argument must be a mode profile object (see lib/mode-profiles.mjs)");
  }
  for (const field of ["name", "permission_mode", "strip_context", "disallowed_tools", "add_dir", "schema_allowed"]) {
    if (!(field in profile)) {
      throw new Error(`buildClaudeArgs: profile is missing required field "${field}"`);
    }
  }
}

/**
 * Build the argv array for `claude -p ...` from a mode profile and the
 * per-invocation runtime inputs. Extracted for unit testing; the actual
 * spawn lives in spawnClaude() below.
 *
 *   profile        — frozen object from MODE_PROFILES (resolveProfile(mode))
 *   runtimeInputs  — {
 *     model,          // full model ID (e.g., claude-haiku-4-5-20251001)
 *     promptText,     // non-empty string
 *     sessionId?,     // UUIDv4 (required unless resumeId is set)
 *     resumeId?,      // UUIDv4 — emits --resume instead of --session-id
 *     addDirPath?,    // workspace path. Passed only when profile.add_dir=true.
 *     jsonSchema?,    // JSON Schema string. Passed only when profile.schema_allowed=true.
 *   }
 *
 * Unknown fields in runtimeInputs are ignored — legacy callers passing
 * `stripContext`, `addDir`, or `mode` get no silent effect.
 */
export function buildClaudeArgs(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const {
    model,
    promptText,
    sessionId,
    resumeId = null,
    addDirPath = null,
    jsonSchema = null,
  } = runtimeInputs;

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

  // Layer 1 — strip CLAUDE.md bias (§4.6). --setting-sources "" keeps OAuth
  // working (unlike --bare which disables OAuth). Rescue profile sets this
  // false so the user's CLAUDE.md context is preserved (§9).
  if (profile.strip_context) args.push("--setting-sources", "");

  // Permission mode is directly from the profile — no mode-branching here.
  args.push("--permission-mode", profile.permission_mode);

  // Hard blocklist (§4.5). Empty array means don't pass the flag at all;
  // rescue profile has an empty list so `--disallowedTools` is absent.
  if (Array.isArray(profile.disallowed_tools) && profile.disallowed_tools.length > 0) {
    args.push("--disallowedTools", profile.disallowed_tools.join(" "));
  }

  // Scoped read access. Suppressed entirely when the profile disables add_dir
  // (e.g., ping — it's a bare OAuth probe, no directory is granted).
  if (profile.add_dir && addDirPath) {
    args.push("--add-dir", addDirPath);
  }

  // Structured output. Suppressed when the profile marks schemas meaningless
  // (e.g., rescue — the model's output is code, not a schema-compliant blob).
  if (profile.schema_allowed && jsonSchema) {
    args.push("--json-schema", jsonSchema);
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
 *
 *   profile        — mode profile (see buildClaudeArgs)
 *   runtimeInputs  — same shape as buildClaudeArgs runtimeInputs, plus:
 *     cwd?          (default: process.cwd())
 *     env?          (default: process.env)
 *     timeoutMs?    (default: 0 = no timeout)
 *     binary?       (default: "claude")
 */
export async function spawnClaude(profile, runtimeInputs = {}) {
  const {
    model,
    promptText,
    sessionId = randomUUID(),
    resumeId = null,
    addDirPath = null,
    jsonSchema = null,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    binary = "claude",
  } = runtimeInputs;

  const args = buildClaudeArgs(profile, {
    model, promptText, sessionId, resumeId, addDirPath, jsonSchema,
  });

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

export const _internal = { isUuidV4 };
