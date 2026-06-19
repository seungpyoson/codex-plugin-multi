import { spawn } from "node:child_process";

import { attachPidCapture } from "./identity.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";
import { detectKimiCapabilities, assertKimiContract, selectKimiSurface } from "./kimi-capabilities.mjs";

// kimi-code delivers the prompt as a `-p` argv argument (not stdin), so the
// rendered prompt is bounded by the OS argv limit. macOS ARG_MAX (1048576 bytes)
// bounds the ENTIRE argv+envp block — all args plus the serialized environment —
// not just the prompt, so we hold a wide ~148KB margin. This is an OS-level
// ceiling and is NOT relaxed by --allow-large-source-packet (that flag only
// governs the selected-source-packet policy, a separate budget). An oversized
// prompt fails clean as `prompt_too_large` (NOT_SENT) rather than crashing the
// spawn with E2BIG.
export const KIMI_CODE_PROMPT_MAX_BYTES = 900000;

export function kimiCodePromptExceedsArgLimit(promptText) {
  return Buffer.byteLength(String(promptText ?? ""), "utf8") > KIMI_CODE_PROMPT_MAX_BYTES;
}

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
    agentFilePath = null,
    mcpConfigFile = null,
    skillsDir = null,
  } = runtimeInputs;

  if ((typeof model !== "string" || !model) && profile.name !== "ping") {
    throw new Error("buildKimiArgs: model is required (full ID, no aliases)");
  }
  if (!Number.isInteger(maxStepsPerTurn) || maxStepsPerTurn <= 0) {
    throw new Error("buildKimiArgs: maxStepsPerTurn must be a positive integer");
  }
  const requiresReadOnlyFiles = Array.isArray(profile.allowed_tools);
  if (requiresReadOnlyFiles) {
    const missing = [
      typeof agentFilePath === "string" && agentFilePath ? null : "agentFilePath",
      typeof mcpConfigFile === "string" && mcpConfigFile ? null : "mcpConfigFile",
      typeof skillsDir === "string" && skillsDir ? null : "skillsDir",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`buildKimiArgs: missing Kimi read-only launch file inputs: ${missing.join(", ")}`);
    }
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
  if (requiresReadOnlyFiles) {
    args.push("--agent-file", agentFilePath);
    args.push("--mcp-config-file", mcpConfigFile);
    args.push("--skills-dir", skillsDir);
  }

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

// Single source of truth for which profiles may use the kimi-code `-p` surface.
// Post-migration that is EVERY mode. The kimi-code prompt embeds the selected
// source and instructs the model not to call tools, so review-family runs
// complete tools-on without any per-invocation enforcement (live-proven on
// 0.18.0: zero tool calls, correct verdict), and rescue runs tools-on in the
// working tree (proven to edit files). The legacy `--agent-file` zero-tool
// mechanism no longer exists and is no longer needed. A null/unknown profile is
// rejected; assertProfile (via buildKimiCodeArgs) is the structural guard for
// malformed profiles. Both spawnKimi (routing) and buildKimiCodeArgs consult this.
export function kimiCodeSurfaceEligible(profile) {
  return Boolean(profile && typeof profile === "object" && typeof profile.name === "string");
}

// Build the argv for the rewritten kimi-code CLI's non-interactive prompt mode
// (`-p/--prompt`). Unlike the legacy surface, the prompt is an ARG (not stdin),
// and `-p` mode forbids `--yolo`/`--auto`/`--plan` (it forces `auto` permission
// with static deny rules). We therefore emit none of the legacy flags and none
// of the permission flags.
export function buildKimiCodeArgs(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const { model, promptText, resumeId = null } = runtimeInputs;
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("buildKimiCodeArgs: promptText is required (kimi-code delivers the prompt as a -p arg)");
  }
  // Backstop for the OS argv limit. spawnKimi pre-checks this and fails clean
  // with a `prompt_too_large` result before reaching here; this typed throw
  // protects any other caller that bypasses that pre-check.
  if (kimiCodePromptExceedsArgLimit(promptText)) {
    throw Object.assign(
      new Error(
        `prompt_too_large: rendered prompt is ${Buffer.byteLength(promptText, "utf8")} bytes, ` +
        `exceeding the ${KIMI_CODE_PROMPT_MAX_BYTES}-byte kimi-code -p argv ceiling`,
      ),
      { code: "prompt_too_large", reason: "prompt_too_large" },
    );
  }
  const args = ["-p", promptText, "--output-format", "stream-json"];
  if (typeof model === "string" && model) args.push("-m", model);
  if (resumeId) args.push("--session", resumeId);
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

// kimi-code session ids are underscore-prefixed UUIDs (e.g.
// session_eeee19b6-5926-4180-a880-1d7d33dfc227), so the legacy hex-with-dashes
// resume regex misses them and the char class must include "_". Read the
// structured `role:"meta"` session.resume_hint line first; fall back to the
// human "kimi -r <id>" hint text (which appears on stderr in text mode).
function parseKimiCodeResumeHint(text) {
  return /\bkimi\s+-r\s+([0-9A-Za-z][0-9A-Za-z_-]{9,})/.exec(String(text ?? ""))?.[1] ?? null;
}

// Parse the kimi-code `--output-format stream-json` transcript: one JSON object
// per stdout line. Assistant turns are `{"role":"assistant","content":"..."}`;
// the session id arrives on a `{"role":"meta","type":"session.resume_hint",
// "session_id":"..."}` line. Thinking/tool progress go to stderr, not the JSONL.
function parseKimiCodeStreamJson(stdout, stderr = "", options = {}) {
  const objects = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { objects.push(JSON.parse(trimmed)); } catch { /* tolerate non-JSON transcript noise */ }
  }
  const assistantTurns = objects
    .filter((o) => o && o.role === "assistant" && typeof o.content === "string")
    .map((o) => o.content);
  // Review-family parses take ONLY the final assistant text turn: the review
  // contract requires the verdict marker on line 1, and kimi-code has no
  // --final-message-only flag, so any interim "thinking out loud" turn must not
  // be prepended to the verdict. Rescue keeps the full transcript joined (its
  // result is a summary of the work done across turns).
  const assistantText = options?.finalMessageOnly
    ? (assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : "")
    : assistantTurns.join("\n");
  const metaSession = objects.find((o) => o && o.role === "meta" && o.session_id)?.session_id ?? null;
  const sessionId = metaSession ?? parseKimiCodeResumeHint(`${stdout}\n${stderr}`);
  const errorObject = objects.find((o) => o && (o.is_error === true || o.role === "error" || o.error != null));
  const errorText = errorObject
    ? (typeof errorObject.error === "string" ? errorObject.error : JSON.stringify(errorObject.error ?? errorObject))
    : null;
  const usageObject = objects.find((o) => o && (o.usage != null || o.role === "usage")) ?? null;
  const failedByExit =
    (Number.isInteger(options?.exitCode) && options.exitCode !== 0) || options?.signal != null;

  // Match the legacy parser: usage-limit detection scans only the error/stderr
  // channels, never successful assistant content — otherwise a legitimate reply
  // that merely mentions "quota"/"billing cycle" would be misclassified as
  // usage_limited (cf. the "preserves successful review text that mentions quota"
  // invariant on the legacy path).
  const usageLimited = usageLimitMessage(errorText ?? "", stderr);
  if (usageLimited) {
    return { ok: false, reason: "usage_limited", error: usageLimited, sessionId, raw: stdout };
  }
  if (errorText) {
    return { ok: false, reason: "kimi_error", error: errorText, sessionId, raw: stdout };
  }
  if (!assistantText) {
    const stderrSummary = summarizeStderr(stderr);
    if (stderrSummary) return { ok: false, reason: "kimi_stderr", error: stderrSummary, sessionId, raw: stdout };
    return { ok: false, reason: "empty_stdout", sessionId, raw: stdout };
  }
  if (failedByExit) {
    return { ok: false, reason: "kimi_nonzero_exit", error: assistantText, sessionId, raw: stdout };
  }
  return {
    ok: true,
    sessionId,
    result: assistantText,
    structured: null,
    denials: [],
    usage: usageObject?.usage ?? null,
    costUsd: usageObject?.total_cost_usd ?? null,
    error: null,
    raw: objects,
  };
}

export function parseKimiResult(stdout, stderr = "", options = {}) {
  if (options?.surface === "kimi-code") {
    return parseKimiCodeStreamJson(stdout, stderr, options);
  }
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
    agentFilePath,
    mcpConfigFile,
    skillsDir,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnKimi: promptText is required");
  }

  // Detect the installed CLI's command surface once and route accordingly.
  // kimi-code's `-p` prompt mode is used only for enforcement-free probes (ping):
  // it delivers the prompt as an arg and cannot express the legacy
  // `--agent-file`/`--mcp-config-file` tool restriction that review profiles
  // depend on. Every other profile stays on the legacy surface, where
  // assertKimiContract fail-cleans with cli_contract_mismatch if the installed
  // CLI is actually kimi-code (#222, #223).
  const capabilities = detectKimiCapabilities(binary, { env });
  const useKimiCode = kimiCodeSurfaceEligible(profile) && selectKimiSurface(capabilities) === "kimi-code";
  const surface = useKimiCode ? "kimi-code" : "legacy";

  // OS argv-limit guard for the kimi-code -p path (the prompt is an argv arg, not
  // stdin). Fail clean as a pre-spawn `prompt_too_large` result — no child is
  // spawned, pidInfo stays null, so source_content_transmission resolves NOT_SENT
  // — instead of crashing the spawn with E2BIG. The legacy stdin path is exempt
  // (no argv limit there).
  if (useKimiCode && kimiCodePromptExceedsArgLimit(promptText)) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      endedAt: new Date().toISOString(),
      stdout: "",
      stderr: "",
      kimiSessionId: null,
      pidInfo: null,
      parsed: {
        ok: false,
        reason: "prompt_too_large",
        error: `rendered prompt is ${Buffer.byteLength(promptText, "utf8")} bytes, ` +
          `exceeding the ${KIMI_CODE_PROMPT_MAX_BYTES}-byte kimi-code -p argv ceiling (ARG_MAX)`,
        sessionId: null,
        raw: "",
      },
    };
  }

  let args;
  let stdinText;
  if (useKimiCode) {
    args = buildKimiCodeArgs(profile, { model, promptText, resumeId });
    // Symmetric guard: if a future kimi-code generation advertises -p but drops
    // a flag we emit (--output-format/--session), fail with a clear
    // cli_contract_mismatch instead of a raw "unknown option" (#222, #223).
    assertKimiContract(args, capabilities);
    stdinText = null;
  } else {
    args = buildKimiArgs(profile, {
      model,
      includeDirPath,
      resumeId,
      maxStepsPerTurn,
      agentFilePath,
      mcpConfigFile,
      skillsDir,
    });
    // Fail fast with a clear cli_contract_mismatch if the installed CLI does not
    // support the flag surface we are about to emit, instead of dying on a cryptic
    // "unknown option" before auth (#222, #223). No-op when the contract cannot be
    // probed (fail-open).
    assertKimiContract(args, capabilities);
    stdinText = promptText;
  }
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
      const parsed = parseKimiResult(stdout, stderr, {
        exitCode,
        signal,
        surface,
        // Review-family runs must report only the final verdict turn; rescue keeps
        // the full multi-turn transcript. Only meaningful on the kimi-code surface.
        finalMessageOnly: surface === "kimi-code" && profile?.name !== "rescue",
      });
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
    // Legacy surface delivers the prompt on stdin; kimi-code's -p arg carries it,
    // so close stdin empty to signal EOF without a second prompt copy.
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}
