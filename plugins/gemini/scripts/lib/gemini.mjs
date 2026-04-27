import { spawn } from "node:child_process";

import { capturePidInfo } from "./identity.mjs";

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

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error(`spawn ${binary} failed: ${e.message}`), { code: e.code }));
    });
    child.on("close", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      const parsed = parseGeminiResult(stdout, stderr);
      resolve({
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
    child.stdin.write(promptText);
    child.stdin.end();
  });
}
