import { spawn } from "node:child_process";

import { attachPidCapture } from "./identity.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";

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
    env = process.env,
  } = runtimeInputs;

  if ((typeof model !== "string" || !model) && profile.name !== "ping") {
    throw new Error("buildGeminiArgs: model is required (full ID, no aliases)");
  }

  const args = ["-p", ""];
  if (typeof model === "string" && model) args.push("-m", model);
  args.push("--output-format", "json");
  if (resumeId) args.push("--resume", resumeId);

  if (profile.permission_mode === "acceptEdits") {
    args.push("--approval-mode", "auto_edit");
    args.push("--skip-trust");
  } else {
    if (!policyPath) throw new Error("buildGeminiArgs: policyPath is required for read-only modes");
    args.push("--policy", policyPath);
    args.push("--approval-mode", "plan");
    args.push("--skip-trust");
    if (!isCodexSandbox(env)) args.push("-s");
  }

  if (profile.add_dir && includeDirPath) {
    args.push("--include-directories", includeDirPath);
  }

  return args;
}

function isCodexSandbox(env) {
  const value = env?.CODEX_SANDBOX;
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return !["", "false", "0", "no", "off", "null", "undefined", "nil"].includes(normalized);
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
    allowedApiKeyEnv = [],
    onSpawn = null,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnGemini: promptText is required");
  }

  const args = buildGeminiArgs(profile, { model, policyPath, includeDirPath, resumeId, env });
  const targetEnv = sanitizeTargetEnv(env, { allowedApiKeyEnv });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: targetEnv, stdio: ["pipe", "pipe", "pipe"] });
    const getPidInfo = attachPidCapture(child, onSpawn);
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
        pidInfo: getPidInfo(),
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
