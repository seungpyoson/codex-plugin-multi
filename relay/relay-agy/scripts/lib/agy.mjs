import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

import { attachPidCapture } from "./identity.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";

function assertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("buildAgyArgs: first argument must be a mode profile object");
  }
  if (typeof profile.name !== "string" || !profile.name) {
    throw new Error("buildAgyArgs: profile is missing required field \"name\"");
  }
}

function formatPrintTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  if (timeoutMs % 1000 === 0) return `${timeoutMs / 1000}s`;
  return `${Math.ceil(timeoutMs)}ms`;
}

export function buildAgyArgs(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const {
    model = null,
    promptText,
    timeoutMs = 0,
    includeDirPath = null,
    resumeId = null,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("buildAgyArgs: promptText is required");
  }

  const args = [];
  const printTimeout = formatPrintTimeout(timeoutMs);
  if (printTimeout) args.push("--print-timeout", printTimeout);
  if (typeof model === "string" && model) args.push("--model", model);
  if (profile.add_dir && includeDirPath) args.push("--add-dir", includeDirPath);
  if (resumeId) args.push("--conversation", resumeId);
  if (profile.sandbox) args.push("--sandbox");
  args.push("--print", promptText);
  return args;
}

function summarizeStderr(stderr) {
  const trimmed = String(stderr ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

function isAuthFailure(stderr) {
  return /\b(auth(?:enticat\w*)?|login|required|credential\w*|oauth2?|unauthenticated|signin|sign-in)\b/i
    .test(String(stderr ?? ""));
}

export function parseAgyResult(stdout = "", stderr = "", options = {}) {
  const stderrSummary = summarizeStderr(stderr);
  if (options.timedOut) {
    return { ok: false, reason: "timeout", error: "AGY timed out", raw: stdout, stderr: stderrSummary };
  }

  if (String(stdout).length > 0) {
    return {
      ok: true,
      result: stdout,
      sessionId: null,
      structured: null,
      denials: [],
      usage: null,
      costUsd: null,
      error: null,
      raw: stdout,
      stderr: stderrSummary,
    };
  }

  const usageLimited = usageLimitMessage(stderr);
  if (usageLimited) {
    return { ok: false, reason: "usage_limited", error: usageLimited, raw: stdout, stderr: stderrSummary };
  }
  if (isAuthFailure(stderr)) {
    return { ok: false, reason: "not_authed", error: "AGY authentication is required", raw: stdout, stderr: stderrSummary };
  }
  if (stderrSummary) {
    return { ok: false, reason: "agy_stderr", error: stderrSummary, raw: stdout, stderr: stderrSummary };
  }
  return { ok: false, reason: "empty_stdout", raw: stdout, stderr: null };
}

function childPwdForCwd(cwd) {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function agyTargetEnv(env, cwd) {
  const targetEnv = sanitizeTargetEnv(env);
  delete targetEnv.RELAY_RUNTIME_DIR;
  delete targetEnv.AGY_PLUGIN_DATA;
  targetEnv.PWD = childPwdForCwd(cwd);
  return targetEnv;
}

export async function spawnAgy(profile, runtimeInputs = {}) {
  const {
    promptText,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    binary = "agy",
    onSpawn = null,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnAgy: promptText is required");
  }

  const args = buildAgyArgs(profile, runtimeInputs);
  const targetEnv = agyTargetEnv(env, cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: targetEnv, stdio: ["ignore", "pipe", "pipe"] });
    const getPidInfo = attachPidCapture(child, onSpawn);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killFallbackTimer = null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (killFallbackTimer) clearTimeout(killFallbackTimer);
      killFallbackTimer = null;
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
        killFallbackTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
        killFallbackTimer.unref();
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (e) => {
      finishReject(Object.assign(new Error(`spawn ${binary} failed: ${e.message}`), { code: e.code }));
    });
    child.on("close", (exitCode, signal) => {
      const endedAt = new Date().toISOString();
      const parsed = parseAgyResult(stdout, stderr, { timedOut });
      finishResolve({
        exitCode,
        signal,
        timedOut,
        endedAt,
        stdout,
        stderr,
        agySessionId: parsed.sessionId ?? null,
        pidInfo: getPidInfo(),
        parsed,
        retryCount: 0,
      });
    });
  });
}
