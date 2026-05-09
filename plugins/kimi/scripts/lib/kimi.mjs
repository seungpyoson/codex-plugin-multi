import { spawn } from "node:child_process";

import { attachPidCapture } from "./identity.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";

function assertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("buildKimiArgs: first argument must be a mode profile object");
  }
  for (const field of ["name", "permission_mode", "add_dir", "schema_allowed"]) {
    if (!(field in profile)) {
      throw new Error(`buildKimiArgs: profile is missing required field "${field}"`);
    }
  }
}

export function buildKimiArgs(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const {
    model,
    includeDirPath = null,
    resumeId = null,
    maxStepsPerTurn = profile.max_steps_per_turn ?? 8,
  } = runtimeInputs;

  if ((typeof model !== "string" || !model) && profile.name !== "ping") {
    throw new Error("buildKimiArgs: model is required (full ID, no aliases)");
  }
  if (!Number.isInteger(maxStepsPerTurn) || maxStepsPerTurn <= 0) {
    throw new Error("buildKimiArgs: maxStepsPerTurn must be a positive integer");
  }

  const args = [
    "--print",
    "--final-message-only",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--max-steps-per-turn",
    String(maxStepsPerTurn),
  ];
  if (typeof model === "string" && model) args.push("-m", model);
  args.push("--thinking");
  if (resumeId) args.push("--session", resumeId);

  if (profile.permission_mode === "acceptEdits") {
    args.push("--yolo");
  } else {
    args.push("--plan");
  }

  if (profile.add_dir && includeDirPath) {
    args.push("--add-dir", includeDirPath);
  }

  return args;
}

function summarizeStderr(stderr) {
  const trimmed = String(stderr ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

function parseResumeSessionId(text) {
  return /\bTo resume this session:\s+kimi\s+-r\s+([0-9a-fA-F-]+)/.exec(text)?.[1] ?? null;
}

const STEP_LIMIT_RE = /^Max number of steps reached:\s*(\d+)\s*$/;

function parseJsonLineSessionId(text) {
  for (const line of String(text ?? "").split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const sessionId = parsed.session_id ?? parsed.sessionId ?? null;
      if (sessionId) return sessionId;
    } catch {
      // Keep scanning older stream-json lines.
    }
  }
  return null;
}

function findStepLimitLine(stdout) {
  for (const line of String(stdout ?? "").split("\n").reverse()) {
    const match = STEP_LIMIT_RE.exec(line.trim());
    if (match) return match;
  }
  return null;
}

function stepLimitResult(match, stdout, stderr) {
  const error = match[0].trim();
  return {
    ok: false,
    reason: "step_limit_exceeded",
    error,
    stepLimit: Number(match[1]),
    sessionId:
      parseResumeSessionId(`${stdout}\n${stderr}`) ??
      parseJsonLineSessionId(stdout) ??
      parseJsonLineSessionId(stderr),
    raw: stdout,
  };
}

export function parseKimiResult(stdout, stderr = "", options = {}) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    const usageLimited = usageLimitMessage("", stderr);
    if (usageLimited) {
      return {
        ok: false,
        reason: "usage_limited",
        error: usageLimited,
        raw: stdout,
        sessionId: parseResumeSessionId(stderr) ?? parseJsonLineSessionId(stderr),
      };
    }
    const stderrSummary = summarizeStderr(stderr);
    if (stderrSummary) {
      return { ok: false, reason: "kimi_stderr", error: stderrSummary, raw: stdout };
    }
    return { ok: false, reason: "empty_stdout", raw: stdout };
  }
  const stepLimitMatch = STEP_LIMIT_RE.exec(trimmed);
  if (stepLimitMatch) {
    return stepLimitResult(stepLimitMatch, stdout, stderr);
  }
  if ((Number.isInteger(options?.exitCode) && options.exitCode !== 0) || options?.signal != null) {
    const failedStepLimitMatch = findStepLimitLine(stdout);
    if (failedStepLimitMatch) {
      return stepLimitResult(failedStepLimitMatch, stdout, stderr);
    }
  }
  let parsed;
  const resumeMatch = parseResumeSessionId(`${stdout}\n${stderr}`);
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    try {
      parsed = JSON.parse(trimmed.split("\n").filter((line) => line.trim().startsWith("{")).pop());
    } catch {
      const usageLimited = usageLimitMessage(stdout, stderr);
      if (usageLimited) {
        return {
          ok: false,
          reason: "usage_limited",
          error: usageLimited,
          raw: stdout,
          sessionId:
            parseResumeSessionId(`${stdout}\n${stderr}`) ??
            parseJsonLineSessionId(stdout) ??
            parseJsonLineSessionId(stderr),
        };
      }
      return { ok: false, reason: "json_parse_error", error: e.message, raw: stdout };
    }
  }
  const parsedError = parsed.error == null
    ? null
    : (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
  const usageLimited = parsed.error == null ? null : usageLimitMessage(parsedError, stderr);
  return {
    ok: parsed.error == null,
    reason: usageLimited ? "usage_limited" : undefined,
    sessionId: parsed.session_id ?? parsed.sessionId ?? resumeMatch ?? null,
    result: typeof parsed.content === "string"
      ? parsed.content
      : (typeof parsed.response === "string" ? parsed.response : (typeof parsed.result === "string" ? parsed.result : null)),
    structured: parsed.structured_output ?? null,
    denials: Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [],
    usage: parsed.stats ?? null,
    costUsd: parsed.total_cost_usd ?? null,
    error: usageLimited ?? parsedError,
    raw: parsed,
  };
}

export async function spawnKimi(profile, runtimeInputs = {}) {
  const {
    model,
    promptText,
    includeDirPath = null,
    resumeId = null,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    binary = "kimi",
    onSpawn = null,
    maxStepsPerTurn,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnKimi: promptText is required");
  }

  const args = buildKimiArgs(profile, { model, includeDirPath, resumeId, maxStepsPerTurn });
  const targetEnv = sanitizeTargetEnv(env);

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
      const endedAt = new Date().toISOString();
      const parsed = parseKimiResult(stdout, stderr, { exitCode, signal });
      finishResolve({
        exitCode,
        signal,
        timedOut,
        endedAt,
        stdout,
        stderr,
        kimiSessionId: parsed.sessionId ?? null,
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
