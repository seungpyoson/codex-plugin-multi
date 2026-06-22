import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

import { attachPidCapture } from "./identity.mjs";
import { terminateProcessTree } from "./process.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";

// Default to 8 MiB per stream: large enough for normal AGY review output, bounded
// enough to prevent runaway stdout/stderr from exhausting the companion process.
const DEFAULT_AGY_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

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

function truncationFlags(options) {
  const flags = options.truncated && typeof options.truncated === "object" ? options.truncated : {};
  return {
    stdout: flags.stdout === true,
    stderr: flags.stderr === true,
  };
}

function withTruncationInfo(result, options) {
  const truncated = truncationFlags(options);
  if (!truncated.stdout && !truncated.stderr) return result;
  const streams = [];
  if (truncated.stdout) streams.push("stdout");
  if (truncated.stderr) streams.push("stderr");
  return {
    ...result,
    truncated,
    truncation_note: `AGY ${streams.join(" and ")} exceeded the ${options.maxCaptureBytes} byte capture cap; output was truncated.`,
  };
}

export function parseAgyResult(stdout = "", stderr = "", options = {}) {
  const stderrSummary = summarizeStderr(stderr);
  if (options.timedOut) {
    return withTruncationInfo(
      { ok: false, reason: "timeout", error: "AGY timed out", raw: stdout, stderr: stderrSummary },
      options,
    );
  }

  if (String(stdout).length > 0) {
    return withTruncationInfo({
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
    }, options);
  }

  const usageLimited = usageLimitMessage(stderr);
  if (usageLimited) {
    return withTruncationInfo(
      { ok: false, reason: "usage_limited", error: usageLimited, raw: stdout, stderr: stderrSummary },
      options,
    );
  }
  if (isAuthFailure(stderr)) {
    return withTruncationInfo(
      { ok: false, reason: "not_authed", error: "AGY authentication is required", raw: stdout, stderr: stderrSummary },
      options,
    );
  }
  if (stderrSummary) {
    return withTruncationInfo(
      { ok: false, reason: "agy_stderr", error: stderrSummary, raw: stdout, stderr: stderrSummary },
      options,
    );
  }
  return withTruncationInfo({ ok: false, reason: "empty_stdout", raw: stdout, stderr: null }, options);
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
  // The AGY_ namespace is reserved for companion-internal control state
  // (plugin data dir, session id, packet caps, binary path). None of it is
  // target-CLI config, so strip the namespace instead of enumerating vars.
  for (const key of Object.keys(targetEnv)) {
    if (key.startsWith("AGY_")) delete targetEnv[key];
  }
  targetEnv.PWD = childPwdForCwd(cwd);
  return targetEnv;
}

function maxCaptureBytesFromEnv(env) {
  const raw = env?.AGY_MAX_CAPTURE_BYTES;
  if (raw == null || raw === "") return DEFAULT_AGY_MAX_CAPTURE_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_MAX_CAPTURE_BYTES;
}

function createCapture(streamName, maxBytes) {
  return {
    streamName,
    maxBytes,
    bytes: 0,
    chunks: [],
    truncated: false,
  };
}

function truncationMarker(streamName, maxBytes) {
  return Buffer.from(`\n[relay: AGY ${streamName} truncated after ${maxBytes} bytes]\n`, "utf8");
}

function appendCapturedChunk(capture, chunk) {
  if (capture.truncated) return false;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  const remaining = capture.maxBytes - capture.bytes;
  if (remaining <= 0) {
    capture.chunks.push(truncationMarker(capture.streamName, capture.maxBytes));
    capture.truncated = true;
    return true;
  }
  if (buffer.length <= remaining) {
    capture.chunks.push(buffer);
    capture.bytes += buffer.length;
    return false;
  }
  capture.chunks.push(buffer.subarray(0, remaining));
  capture.bytes += remaining;
  capture.chunks.push(truncationMarker(capture.streamName, capture.maxBytes));
  capture.truncated = true;
  return true;
}

function captureToString(capture) {
  return Buffer.concat(capture.chunks).toString("utf8");
}

function forceKillProcessGroup(pid) {
  if (!Number.isFinite(pid) || process.platform === "win32") return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
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
  const maxCaptureBytes = maxCaptureBytesFromEnv(env);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: targetEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const getPidInfo = attachPidCapture(child, onSpawn);
    const stdoutCapture = createCapture("stdout", maxCaptureBytes);
    const stderrCapture = createCapture("stderr", maxCaptureBytes);
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
    const terminateChildTree = () => {
      if (!Number.isFinite(child.pid)) return;
      try { terminateProcessTree(child.pid); } catch { /* already gone */ }
      if (!killFallbackTimer) {
        killFallbackTimer = setTimeout(() => { forceKillProcessGroup(child.pid); }, 2000);
        killFallbackTimer.unref();
      }
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
        terminateChildTree();
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      if (appendCapturedChunk(stdoutCapture, chunk)) terminateChildTree();
    });
    child.stderr.on("data", (chunk) => {
      if (appendCapturedChunk(stderrCapture, chunk)) terminateChildTree();
    });
    child.on("error", (e) => {
      terminateChildTree();
      finishReject(Object.assign(new Error(`spawn ${binary} failed: ${e.message}`), { code: e.code }));
    });
    child.on("close", (exitCode, signal) => {
      const endedAt = new Date().toISOString();
      const stdout = captureToString(stdoutCapture);
      const stderr = captureToString(stderrCapture);
      const truncated = {
        stdout: stdoutCapture.truncated,
        stderr: stderrCapture.truncated,
      };
      const parsed = parseAgyResult(stdout, stderr, { timedOut, truncated, maxCaptureBytes });
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
        truncated,
        runtimeDiagnostics: truncated.stdout || truncated.stderr
          ? {
            output_capture: {
              max_bytes: maxCaptureBytes,
              stdout_truncated: truncated.stdout,
              stderr_truncated: truncated.stderr,
            },
          }
          : null,
        retryCount: 0,
      });
    });
  });
}
