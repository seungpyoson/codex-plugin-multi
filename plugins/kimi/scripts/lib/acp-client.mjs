// ACP (Agent Client Protocol) stdio client for kimi-code (#222/#223).
//
// WHY THIS EXISTS. kimi-code 0.18.x delivers a one-shot prompt only as the value
// of `-p/--prompt <prompt>` — an argv argument. On Linux a single argv string is
// capped at MAX_ARG_STRLEN (32 pages = 131072 bytes); relay's reviews inline the
// selected source into the prompt and the source-packet budget is 512 KiB, so any
// non-trivial review overruns the cap and the spawn dies with E2BIG. macOS's far
// larger single-arg limit hid this locally; Linux CI surfaced it. `kimi acp` runs
// kimi-code as an Agent Client Protocol server speaking JSON-RPC 2.0 over stdio, so
// the prompt (with embedded source, ANY size) streams over stdin with no argv
// limit — the same structural immunity the Claude adapter gets from its stdin path.
//
// WIRE FORMAT (validated live against the installed kimi-code 0.18.0 server):
//  - Framing: NDJSON — exactly one JSON-RPC 2.0 message per line on stdin/stdout.
//    Diagnostic logs go to stderr, so stdout carries only protocol traffic.
//  - initialize  {protocolVersion:1, clientCapabilities}
//      -> {protocolVersion:1, agentCapabilities, authMethods:[{id:"login",...}], agentInfo}
//  - session/new {cwd, mcpServers:[]}
//      -> {sessionId:"session_<uuid>", configOptions:[{id:"model"|"thinking"|"mode", ...}]}
//    (A logged-in user needs NO authenticate step; session/new just succeeds.)
//  - session/set_config_option {sessionId, configId, value}  -> {} (select model / mode)
//  - session/prompt {sessionId, prompt:[{type:"text", text}]}  -> {stopReason}
//  - session/update notification carries
//      {sessionId, update:{sessionUpdate:"agent_message_chunk", messageId?, content:{type:"text", text}}}
//
// The session/prompt REQUEST resolves with {stopReason} only when the turn ends, so
// all agent_message_chunk notifications have arrived by then — no separate "done"
// signal is needed.

import { spawn } from "node:child_process";

import { attachPidCapture } from "./identity.mjs";
import { sanitizeTargetEnv } from "./provider-env.mjs";

export const ACP_PROTOCOL_VERSION = 1;

// JSON-RPC error code the agent returns when a session operation needs auth that
// is not present (documented: authenticate "returns authRequired (-32000) if token
// is missing"). Mapped to a clean, source-NOT-sent readiness failure.
export const ACP_AUTH_REQUIRED_CODE = -32000;

// Map a kimi-code stopReason to relay's {ok, reason}. end_turn is the only clean
// completion; everything else is a non-clean turn that downstream review-quality
// gates must not treat as a verdict.
function classifyStopReason(stopReason, hasText) {
  switch (stopReason) {
    case "end_turn":
      return hasText ? { ok: true, reason: null } : { ok: false, reason: "empty_stdout" };
    case "refusal":
      return { ok: false, reason: "kimi_refused" };
    case "cancelled":
      return { ok: false, reason: "kimi_cancelled" };
    case "max_tokens":
    case "max_turn_requests":
      return { ok: false, reason: "review_incomplete" };
    default:
      return { ok: false, reason: "kimi_error" };
  }
}

// A line-delimited JSON-RPC 2.0 peer over a child process's stdio. Correlates
// responses by id, dispatches notifications, and answers agent->client requests so
// the agent never hangs waiting on the client.
class AcpPeer {
  constructor(child, { onNotification, onServerRequest }) {
    this.child = child;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.protocolError = null;
    child.stdout.on("data", (chunk) => this._ingest(chunk.toString("utf8")));
    // A well-behaved NDJSON server newline-terminates every frame, but a final frame
    // emitted without a trailing newline at EOF would otherwise sit unparsed in the
    // buffer and the turn would be misread as incomplete. Flush it on stream end.
    child.stdout.on("end", () => this._flushTail());
  }

  _ingest(text) {
    this.buffer += text;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout means the surface is not a clean ACP server
        // (e.g. a banner from the wrong CLI). Record it; the lifecycle maps it.
        this.protocolError = `non-JSON line on ACP stdout: ${line.slice(0, 200)}`;
        continue;
      }
      this._dispatch(msg);
    }
  }

  // Dispatch a buffered final frame that arrived without a trailing newline before
  // EOF. Idempotent: clears the buffer, so a second call is a no-op.
  _flushTail() {
    const line = this.buffer.trim();
    this.buffer = "";
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.protocolError = `non-JSON trailing line on ACP stdout: ${line.slice(0, 200)}`;
      return;
    }
    this._dispatch(msg);
  }

  _dispatch(msg) {
    if (msg == null || typeof msg !== "object") return;
    const isRequest = msg.method != null && msg.id != null;
    const isNotification = msg.method != null && msg.id == null;
    const isResponse = msg.method == null && msg.id != null;
    if (isResponse) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(Object.assign(new Error(msg.error.message || "acp error"), { acpError: msg.error }));
      else entry.resolve(msg.result ?? {});
      return;
    }
    if (isNotification) {
      try { this.onNotification?.(msg.method, msg.params ?? {}); } catch { /* non-fatal */ }
      return;
    }
    if (isRequest) {
      let result;
      try {
        result = this.onServerRequest?.(msg.method, msg.params ?? {});
      } catch {
        result = { __acpError: { code: -32603, message: "client handler failed" } };
      }
      if (result && result.__acpError) this._writeError(msg.id, result.__acpError);
      else this._write({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    }
  }

  _write(obj) {
    try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* stdin gone — lifecycle will settle */ }
  }

  _writeError(id, { code, message }) {
    this._write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  rejectAllPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

// Resolve relay's model name against the model configOption the agent advertised.
// Advertised values look like "kimi-code/kimi-for-coding"; relay may pass the bare
// suffix, so we normalize to the advertised value when it matches. When the agent
// advertises a model selector but not this exact model, we pass relay's EXACT model
// through and let the agent accept or reject it on set_config_option — that is not a
// silent substitution (we never swap in a DIFFERENT model). Returns null ONLY when
// the agent advertises no model selector at all, so the caller fails clean.
function resolveModelValue(configOptions, model) {
  const opt = (configOptions ?? []).find((o) => o?.id === "model");
  if (!opt) return null;
  const want = String(model);
  for (const choice of Array.isArray(opt.options) ? opt.options : []) {
    const value = choice?.value;
    if (typeof value !== "string") continue;
    if (value === want || value.endsWith(`/${want}`) || value.split("/").pop() === want) return value;
  }
  return want;
}

function hasConfigOption(configOptions, id) {
  return (configOptions ?? []).some((o) => o?.id === id);
}

// Run one kimi-code review/rescue turn over ACP. Resolves to a normalized result;
// the caller (spawnKimi) maps it onto the legacy spawn contract. Never rejects for
// expected failures (auth, protocol, timeout) — those become {ok:false, reason}.
export async function runAcpPrompt({
  command,
  args = ["acp"],
  cwd = process.cwd(),
  env = process.env,
  model = null,
  acpMode = null,
  approveToolCalls = false,
  promptText,
  resumeId = null,
  timeoutMs = 0,
  onSpawn = null,
  spawnImpl = spawn,
  finalMessageOnly = true,
}) {
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("runAcpPrompt: promptText is required");
  }

  const targetEnv = sanitizeTargetEnv(env);
  const child = spawnImpl(command, args, { cwd, env: targetEnv, stdio: ["pipe", "pipe", "pipe"] });
  const getPidInfo = attachPidCapture(child, onSpawn);

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  // Assistant text, grouped by messageId so review (final message only) and rescue
  // (full transcript) can both be served. Chunks with no messageId fold into one
  // implicit message so a server that omits messageId still works.
  const messages = new Map();
  const messageOrder = [];
  const recordChunk = (messageId, text) => {
    const key = messageId ?? "__default__";
    if (!messages.has(key)) { messages.set(key, ""); messageOrder.push(key); }
    messages.set(key, messages.get(key) + text);
  };

  let sourceSent = false;
  let timedOut = false;
  let timer = null;
  // The adapter owns the child's lifecycle and tears it down with SIGTERM on every
  // failure/teardown path. That teardown signal is NOT an operator cancel, so it
  // must not be reported to the companion classifier (which would otherwise read it
  // as a cancelled run and mis-disclose a pre-prompt failure as "source sent").
  let adapterInitiatedKill = false;
  const peer = new AcpPeer(child, {
    onNotification: (method, params) => {
      if (method !== "session/update") return;
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
        recordChunk(update.messageId, String(update.content.text ?? ""));
      }
    },
    onServerRequest: (method, params) => {
      // The agent asks the client to run a tool. Review prompts forbid tools, so
      // this should not fire; rescue uses YOLO mode and the agent runs its own
      // tools without asking. Answer defensively either way so the turn never hangs.
      if (method === "session/request_permission") {
        const options = params?.options ?? [];
        if (approveToolCalls) {
          const allow = options.find((o) => /allow|approve|yes/i.test(`${o?.optionId ?? ""}${o?.kind ?? ""}${o?.name ?? ""}`));
          return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
        }
        const reject = options.find((o) => /reject|deny|no/i.test(`${o?.optionId ?? ""}${o?.kind ?? ""}${o?.name ?? ""}`));
        return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
      }
      // We advertise no fs/terminal client capability; the agent must use its own
      // tools. Anything else routed to us is unsupported.
      return { __acpError: { code: -32601, message: `client does not support ${method}` } };
    },
  });

  const collectText = () => {
    if (messageOrder.length === 0) return "";
    if (finalMessageOnly) return messages.get(messageOrder[messageOrder.length - 1]) ?? "";
    return messageOrder.map((k) => messages.get(k)).join("\n");
  };

  const result = (over) => ({
    ok: false,
    reason: null,
    error: null,
    result: "",
    rawTranscript: messageOrder.map((k) => messages.get(k)).join("\n"),
    sessionId: null,
    stopReason: null,
    sourceSent,
    pidInfo: getPidInfo(),
    exitCode: child.exitCode,
    // Suppress an adapter-initiated teardown SIGTERM so the companion does not
    // misread it as an operator cancel. A genuine external signal (not our kill)
    // still propagates.
    signal: adapterInitiatedKill ? null : child.signalCode,
    timedOut,
    stderr,
    ...over,
  });

  const kill = () => {
    adapterInitiatedKill = true;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref?.();
  };

  // Graceful teardown after a clean turn: close stdin (EOF) so the ACP server exits
  // 0 on its own — a SIGTERM here would make the companion read the run as
  // cancelled. Force-kill only if the server does not exit on EOF promptly.
  const gracefulClose = () => {
    try { child.stdin.end(); } catch { /* already gone */ }
    const fallback = setTimeout(() => kill(), 2000);
    fallback.unref?.();
    return closed.finally(() => clearTimeout(fallback));
  };

  // A process-exit before the turn finishes is a terminal failure; reject any
  // in-flight request so the lifecycle settles instead of hanging until timeout
  // (e.g. a non-ACP CLI that prints a banner and exits).
  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      // Defensive: dispatch any newline-less final frame before deciding the turn
      // failed, regardless of stdout 'end' vs process 'close' ordering.
      peer._flushTail();
      if (peer.pending.size > 0) {
        peer.rejectAllPending(Object.assign(new Error(`kimi acp exited (code=${code}) before completing the turn`), { acpClosed: true, exitCode: code }));
      }
      resolve({ code, signal });
    });
    child.on("error", (e) => {
      peer.rejectAllPending(Object.assign(new Error(`spawn ${command} failed: ${e.message}`), { code: e.code, spawnError: true }));
      resolve({ code: null, signal: null, spawnError: e });
    });
  });

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      peer.rejectAllPending(Object.assign(new Error("acp turn timed out"), { acpTimeout: true }));
      kill();
    }, timeoutMs);
  }
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };

  try {
    // 1. initialize — declare no fs/terminal client capability (the agent reviews
    //    from the embedded source and, for rescue, uses its own tools in cwd).
    //    initialize is a version negotiation: if the server cannot speak our
    //    protocol version, fail loud and clean (source NOT sent) instead of driving
    //    session/* against an unknown protocol.
    const initResult = await peer.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const negotiatedVersion = initResult?.protocolVersion;
    if (negotiatedVersion !== ACP_PROTOCOL_VERSION) {
      clearTimer(); kill(); await closed;
      return result({
        reason: "cli_contract_mismatch",
        error: `kimi-code ACP negotiated protocolVersion ${negotiatedVersion ?? "(missing)"}, expected ${ACP_PROTOCOL_VERSION}`,
        sourceSent: false,
      });
    }

    // 2. session/new (or session/load when resuming a prior session).
    const sessionResult = resumeId
      ? await peer.request("session/load", { sessionId: resumeId, cwd, mcpServers: [] })
      : await peer.request("session/new", { cwd, mcpServers: [] });
    const sessionId = sessionResult?.sessionId ?? resumeId ?? null;
    const configOptions = sessionResult?.configOptions ?? [];

    // 3. Select the requested model exactly (no silent substitution) and the
    //    tool-permission mode for this profile.
    if (model) {
      const value = resolveModelValue(configOptions, model);
      if (value == null) {
        clearTimer(); kill(); await closed;
        return result({ reason: "model_unavailable", error: `kimi-code ACP did not offer model "${model}"`, sessionId, sourceSent: false });
      }
      await peer.request("session/set_config_option", { sessionId, configId: "model", value });
    }
    if (acpMode && hasConfigOption(configOptions, "mode")) {
      await peer.request("session/set_config_option", { sessionId, configId: "mode", value: acpMode });
    }

    // 4. session/prompt — the prompt (with embedded source, any size) goes over
    //    stdin here. From this write on, source HAS been transmitted.
    sourceSent = true;
    const promptResult = await peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    const stopReason = promptResult?.stopReason ?? null;
    clearTimer();
    // Close stdin so the server exits 0 cleanly; wait for close so pidInfo and the
    // final exitCode/signal are populated before we read them.
    await gracefulClose();

    const text = collectText();
    const { ok, reason } = classifyStopReason(stopReason, text.length > 0);
    return result({
      ok,
      reason,
      error: ok ? null : (peer.protocolError ?? `kimi-code ACP turn ended with stopReason=${stopReason}`),
      result: text,
      sessionId,
      stopReason,
      sourceSent: true,
      // A clean turn is defined by stopReason, not the child's exit code: if the
      // server was slow to release stdin and the graceful-close fallback killed it,
      // child.exitCode is null. Report 0 so the companion classifies it completed
      // and preserves the verdict instead of discarding it.
      exitCode: ok ? 0 : child.exitCode,
    });
  } catch (e) {
    clearTimer();
    kill();
    await closed;
    if (timedOut || e?.acpTimeout) return result({ reason: "timeout", error: "kimi-code ACP turn timed out", timedOut: true });
    if (e?.spawnError || e?.code === "ENOENT") {
      // The binary could not be executed (missing / not executable). Mark it so
      // spawnKimi can re-throw with the original code, preserving the legacy
      // ENOENT->not_found readiness contract.
      return result({ reason: "spawn_failed", error: e.message, sourceSent: false, spawnFailed: true, spawnErrorCode: e.code ?? null });
    }
    if (e?.acpError?.code === ACP_AUTH_REQUIRED_CODE) {
      return result({ reason: "auth_required", error: e.acpError.message || "kimi-code ACP requires login", sourceSent: false });
    }
    if (peer.protocolError) return result({ reason: "cli_contract_mismatch", error: peer.protocolError, sourceSent: false });
    // An ACP error AFTER the prompt was sent is a real review failure (source sent);
    // before it, the target was never reached.
    return result({ reason: sourceSent ? "kimi_error" : "acp_protocol_error", error: e?.message ?? String(e) });
  }
}
