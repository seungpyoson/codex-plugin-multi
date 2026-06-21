// Mock kimi-code ACP server for tests. Speaks the NDJSON JSON-RPC 2.0 surface
// validated live against kimi-code 0.18.0 (see acp-client.mjs header). Spawned as
// `node kimi-acp-mock.mjs` in place of `kimi acp`. Behaviour is env-configurable so
// one mock covers the happy path, large prompts, auth/contract/model failures,
// tool-permission round-trips, and multi-message transcripts.
//
// Env knobs:
//   MOCK_ACP_REPLY                 assistant text to stream back (default canned verdict)
//   MOCK_ACP_CHUNKS                split the reply into N agent_message_chunk messages (default 1)
//   MOCK_ACP_STOP_REASON           stopReason for session/prompt (default "end_turn")
//   MOCK_ACP_ASSERT_PROMPT_INCLUDES  fail the prompt turn unless the text contains this
//   MOCK_ACP_PROMPT_LEN_FILE       write the received prompt byte length here (proves stdin delivery)
//   MOCK_ACP_AUTH_REQUIRED=1       session/new returns JSON-RPC error -32000 (authRequired)
//   MOCK_ACP_PROMPT_AUTH_REQUIRED=1  session/PROMPT returns -32000 AFTER the prompt is received (token expiry mid-session; source WAS sent)
//   MOCK_ACP_INIT_GARBAGE=1        emit a non-JSON banner line first (simulate the wrong CLI)
//   MOCK_ACP_PROTOCOL_VERSION      protocolVersion the initialize response advertises (numeric, default 1)
//   MOCK_ACP_PROTOCOL_VERSION_RAW  protocolVersion emitted VERBATIM (e.g. the string "1"); overrides the numeric form
//   MOCK_ACP_NO_MODEL=1            omit the "model" configOption (forces model_unavailable)
//   MOCK_ACP_REQUEST_PERMISSION=1  send a session/request_permission before finishing the turn
//   MOCK_ACP_PERMISSION_OUTCOME_FILE  write the client's selected permission outcome (JSON) here
//   MOCK_ACP_PROMPT_DELAY_MS       delay the session/prompt response (to exercise client timeout)
//   MOCK_ACP_HANDSHAKE_DELAY_MS    delay the initialize response (to land an external signal PRE-prompt)
//   MOCK_ACP_POST_PROMPT_GARBAGE_STDOUT=1  after RECEIVING the prompt, emit a non-JSON stdout line and exit (source WAS sent)
//   MOCK_ACP_SESSION_ERROR=1       session/new returns a non-auth JSON-RPC error (forces acp_protocol_error; source NOT sent)
//   MOCK_ACP_SESSION_ERROR_MESSAGE the message for the MOCK_ACP_SESSION_ERROR rejection (default "internal: session unavailable"; set quota text to model a PRE-prompt usage-limit error)
//   MOCK_ACP_HANG_ON_EOF=1         ignore stdin EOF so the client's graceful-close fallback kill fires (slow-close path)
//   MOCK_ACP_NO_TRAILING_NEWLINE=1 emit the terminal session/prompt frame without a trailing newline, then EOF
//   MOCK_ACP_END_STDOUT_NO_EXIT=1  emit a newline-less terminal frame and END stdout but stay alive (isolates the 'end' flush; no process-'close' backstop)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run the mock ACP server loop reading the given env for behaviour knobs. Exported
// so a fake `kimi` binary (fake-kimi.mjs) can serve `kimi acp` with the same wire
// behaviour the standalone mock provides.
export function serveAcp(env = process.env) {
const REPLY = env.MOCK_ACP_REPLY ?? "VERDICT: PASS\nNo blocking findings.";
const CHUNKS = Math.max(1, Number(env.MOCK_ACP_CHUNKS ?? "1") || 1);

// Keep the event loop alive so the process does NOT exit on its own after stdin
// EOF; combined with MOCK_ACP_HANG_ON_EOF this forces the client's graceful-close
// fallback kill to fire, exercising the slow-server-close path. Only the client's
// SIGTERM ends us.
if (env.MOCK_ACP_HANG_ON_EOF === "1") setInterval(() => {}, 60000);

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (env.MOCK_ACP_INIT_GARBAGE === "1") {
  // Simulate a CLI that is NOT an ACP server: print a banner and exit without
  // ever answering initialize. The client must fail clean (source NOT sent).
  process.stdout.write("kimi-cli legacy banner: this is not an ACP server\n");
  process.exit(1);
}

let pendingPermissionId = null;
let permissionResolved = null;

function configOptions() {
  const opts = [];
  if (env.MOCK_ACP_NO_MODEL !== "1") {
    opts.push({
      type: "select", id: "model", name: "Model", category: "model",
      currentValue: "kimi-code/kimi-for-coding",
      options: [{ value: "kimi-code/kimi-for-coding", name: "K2.7 Code High Speed" }],
    });
  }
  opts.push({
    type: "select", id: "mode", name: "Mode", category: "mode", currentValue: "default",
    options: [
      { value: "default", name: "Default" }, { value: "plan", name: "Plan" },
      { value: "auto", name: "Auto" }, { value: "yolo", name: "YOLO" },
    ],
  });
  return opts;
}

async function finishPromptTurn(reqId, promptText) {
  if (env.MOCK_ACP_PROMPT_LEN_FILE) {
    try { writeFileSync(env.MOCK_ACP_PROMPT_LEN_FILE, String(Buffer.byteLength(promptText, "utf8"))); } catch { /* best effort */ }
  }
  if (env.MOCK_ACP_PROMPT_AUTH_REQUIRED === "1") {
    // The prompt (source) was already received and its byte length recorded above;
    // now reject session/prompt with the in-protocol authRequired code (-32000),
    // modelling token expiry / per-operation auth that lands AFTER the source was
    // sent. The client MUST disclose SENT — not reuse the pre-prompt not_authed
    // NOT_SENT path, which would falsely claim the transmitted source was not sent.
    send({ jsonrpc: "2.0", id: reqId, error: { code: -32000, message: "authRequired: token expired mid-session" } });
    return;
  }
  const assertSub = env.MOCK_ACP_ASSERT_PROMPT_INCLUDES;
  if (assertSub && !promptText.includes(assertSub)) {
    send({ jsonrpc: "2.0", id: reqId, error: { code: -32602, message: `prompt missing required substring: ${assertSub}` } });
    return;
  }
  if (env.MOCK_ACP_POST_PROMPT_GARBAGE_STDOUT === "1") {
    // The prompt (source) was already received above; now leak a NON-JSON line to
    // stdout and exit WITHOUT a finish frame. The source WAS sent, so the client
    // must disclose SENT — not let the post-prompt protocolError force NOT_SENT.
    process.stdout.write("kimi: warning: diagnostic leaked to stdout\n");
    process.exit(7);
  }
  if (env.MOCK_ACP_REQUEST_PERMISSION === "1") {
    pendingPermissionId = 9001;
    await new Promise((resolve) => {
      permissionResolved = resolve;
      send({
        jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission",
        params: { sessionId: "session_mock", toolCall: { title: "edit file" }, options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ] },
      });
    });
  }
  const parts = [];
  const per = Math.ceil(REPLY.length / CHUNKS) || REPLY.length;
  for (let i = 0; i < CHUNKS; i += 1) parts.push(REPLY.slice(i * per, (i + 1) * per));
  for (let i = 0; i < parts.length; i += 1) {
    send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "session_mock", update: {
        sessionUpdate: "agent_message_chunk", messageId: `msg_${i}`, content: { type: "text", text: parts[i] },
      } },
    });
  }
  const finishFrame = { jsonrpc: "2.0", id: reqId, result: { stopReason: env.MOCK_ACP_STOP_REASON ?? "end_turn" } };
  const finish = () => {
    if (env.MOCK_ACP_END_STDOUT_NO_EXIT === "1") {
      // Emit the terminal frame WITHOUT a trailing newline and END stdout but DO NOT
      // exit (stay alive on stdin). Only the client's stdout 'end' handler can flush
      // the buffered frame — the process-'close' backstop never fires — so this
      // isolates the 'end'-driven flush. The mock exits later on stdin EOF.
      process.stdout.write(JSON.stringify(finishFrame), () => process.stdout.end());
      return;
    }
    if (env.MOCK_ACP_NO_TRAILING_NEWLINE === "1") {
      // Emit the terminal frame WITHOUT a trailing newline, then EOF stdout — the
      // client must still flush and dispatch it.
      process.stdout.write(JSON.stringify(finishFrame), () => process.exit(0));
      return;
    }
    send(finishFrame);
  };
  const delay = Number(env.MOCK_ACP_PROMPT_DELAY_MS ?? "0") || 0;
  if (delay > 0) setTimeout(finish, delay); else finish();
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => { if (env.MOCK_ACP_HANG_ON_EOF === "1") return; process.exit(0); });

function handle(msg) {
  // Client response to our session/request_permission. Capture WHICH option the
  // client selected so a test can prove rescue approves (allow) and review denies
  // (reject) — not merely that some reply arrived.
  if (msg.id != null && msg.method == null && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    if (env.MOCK_ACP_PERMISSION_OUTCOME_FILE) {
      try { writeFileSync(env.MOCK_ACP_PERMISSION_OUTCOME_FILE, JSON.stringify(msg.result?.outcome ?? null)); } catch { /* best effort */ }
    }
    permissionResolved?.();
    return;
  }
  if (msg.method === "initialize") {
    // RAW override lets a test emit the version verbatim (e.g. a JSON string "1")
    // to exercise the client's tolerant Number() coercion; otherwise numeric.
    const protocolVersion = env.MOCK_ACP_PROTOCOL_VERSION_RAW !== undefined
      ? env.MOCK_ACP_PROTOCOL_VERSION_RAW
      : (Number(env.MOCK_ACP_PROTOCOL_VERSION ?? "1") || 1);
    const sendInit = () => send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
      authMethods: [{ id: "login", type: "terminal", name: "Login with Kimi account" }],
      agentInfo: { name: "Kimi Code CLI", version: "0.18.0" },
    } });
    // Delaying the handshake lets a test land an external signal while the client
    // is still pre-prompt (source NOT yet sent).
    const handshakeDelay = Number(env.MOCK_ACP_HANDSHAKE_DELAY_MS ?? "0") || 0;
    if (handshakeDelay > 0) setTimeout(sendInit, handshakeDelay); else sendInit();
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/load") {
    if (env.MOCK_ACP_AUTH_REQUIRED === "1") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "authRequired: run kimi login" } });
      return;
    }
    if (env.MOCK_ACP_SESSION_ERROR === "1") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: env.MOCK_ACP_SESSION_ERROR_MESSAGE ?? "internal: session unavailable" } });
      return;
    }
    const sessionId = msg.method === "session/load" ? (msg.params?.sessionId ?? "session_mock") : "session_mock";
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: configOptions() } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = (msg.params?.prompt ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");
    finishPromptTurn(msg.id, text);
    return;
  }
  // Unknown method with an id -> method-not-found so the peer never hangs.
  if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `mock: unknown method ${msg.method}` } });
}
}

// Auto-run as a standalone `node kimi-acp-mock.mjs` server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serveAcp(process.env);
}
