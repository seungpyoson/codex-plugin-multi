import { spawn } from "node:child_process";

import { capturePidInfo } from "./identity.mjs";

// Provider credential / routing scrub policy.
//
// We strip three categories before launching the target CLI:
//   1. *_API_KEY suffixes — covers ANTHROPIC_API_KEY, CLAUDE_API_KEY,
//      OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, etc.
//   2. Whole provider namespaces by prefix — every var that selects or
//      authenticates a provider region/project/profile.
//   3. A small list of explicit non-prefixed selectors that don't fit (1)
//      or (2) but still steer providers (e.g. GOOGLE_GENAI_USE_VERTEXAI).
//
// Anything not on this list — PATH, HOME, terminal vars, NODE_*, target
// CLI config dirs (CLAUDE_CONFIG_DIR, GEMINI_CONFIG_DIR), etc. — is passed
// through so OAuth / on-disk creds keep working.
const PROVIDER_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",   // CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX
  "OPENAI_",            // OPENAI_BASE_URL, OPENAI_PROJECT, OPENAI_ORG_ID, ...
  "AWS_",               // creds + AWS_REGION + AWS_PROFILE + AWS_SESSION_TOKEN
  "AZURE_",             // AZURE_CLIENT_*, AZURE_TENANT_ID
  "VERTEX_",            // VERTEX_PROJECT, VERTEX_LOCATION
  "GOOGLE_CLOUD_",      // GOOGLE_CLOUD_PROJECT*, GOOGLE_CLOUD_REGION, ...
];
const PROVIDER_ENV_DENYLIST = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUD_ML_REGION",
]);

function isDeniedEnvKey(key) {
  const upper = key.toUpperCase();
  if (upper.endsWith("_API_KEY")) return true;
  if (PROVIDER_ENV_DENYLIST.has(upper)) return true;
  for (const prefix of PROVIDER_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }
  return false;
}

function sanitizeTargetEnv(env) {
  const sanitized = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isDeniedEnvKey(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function assertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("buildGeminiArgs: first argument must be a mode profile object");
  }
  for (const field of ["name", "permission_mode", "add_dir", "schema_allowed"]) {
    if (!(field in profile)) {
      throw new Error(`buildGeminiArgs: profile is missing required field "${field}"`);
    }
  }
}

export function buildGeminiArgs(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const {
    model,
    policyPath = null,
    includeDirPath = null,
    resumeId = null,
  } = runtimeInputs;

  if (typeof model !== "string" || !model) {
    throw new Error("buildGeminiArgs: model is required (full ID, no aliases)");
  }

  const args = ["-p", "", "-m", model, "--output-format", "json"];
  if (resumeId) args.push("--resume", resumeId);

  if (profile.permission_mode === "acceptEdits") {
    args.push("--approval-mode", "auto_edit");
    args.push("--skip-trust");
  } else {
    if (!policyPath) throw new Error("buildGeminiArgs: policyPath is required for read-only modes");
    args.push("--policy", policyPath);
    args.push("--approval-mode", "plan");
    args.push("--skip-trust");
    args.push("-s");
  }

  if (profile.add_dir && includeDirPath) {
    args.push("--include-directories", includeDirPath);
  }

  return args;
}

function summarizeStderr(stderr) {
  const trimmed = String(stderr ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

export function parseGeminiResult(stdout, stderr = "") {
  const trimmed = stdout.trim();
  if (!trimmed) {
    const stderrSummary = summarizeStderr(stderr);
    if (stderrSummary) {
      return { ok: false, reason: "gemini_stderr", error: stderrSummary, raw: stdout };
    }
    return { ok: false, reason: "empty_stdout", raw: stdout };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    try {
      parsed = JSON.parse(trimmed.split("\n").filter(Boolean).pop());
    } catch {
      return { ok: false, reason: "json_parse_error", error: e.message, raw: stdout };
    }
  }
  const parsedError = parsed.error == null
    ? null
    : (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
  return {
    ok: parsed.error == null,
    sessionId: parsed.session_id ?? null,
    result: typeof parsed.response === "string" ? parsed.response : (typeof parsed.result === "string" ? parsed.result : null),
    structured: parsed.structured_output ?? null,
    denials: Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [],
    usage: parsed.stats ?? null,
    costUsd: parsed.total_cost_usd ?? null,
    error: parsedError,
    raw: parsed,
  };
}

export async function spawnGemini(profile, runtimeInputs = {}) {
  const {
    model,
    promptText,
    policyPath = null,
    includeDirPath = null,
    resumeId = null,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    binary = "gemini",
    onSpawn = null,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnGemini: promptText is required");
  }

  const args = buildGeminiArgs(profile, { model, policyPath, includeDirPath, resumeId });
  const targetEnv = sanitizeTargetEnv(env);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: targetEnv, stdio: ["pipe", "pipe", "pipe"] });
    let pidInfo;
    try {
      pidInfo = capturePidInfo(child.pid);
    } catch (e) {
      pidInfo = { pid: child.pid, starttime: null, argv0: null, capture_error: e.message };
    }
    if (typeof onSpawn === "function" && Number.isInteger(child.pid)) {
      try { onSpawn(pidInfo); } catch { /* status handoff is best-effort */ }
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    let settled = false;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolve(value);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000).unref();
      }, timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (e) => {
      finishReject(Object.assign(new Error(`spawn ${binary} failed: ${e.message}`), { code: e.code }));
    });
    child.on("close", (exitCode, signal) => {
      const parsed = parseGeminiResult(stdout, stderr);
      finishResolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        geminiSessionId: parsed.sessionId ?? null,
        pidInfo,
        parsed,
      });
    });
    child.stdin.on("error", (e) => {
      if (e?.code === "EPIPE") return;
      finishReject(Object.assign(new Error(`write to ${binary} stdin failed: ${e.message}`), { code: e.code }));
    });
    child.stdin.end(promptText);
  });
}
