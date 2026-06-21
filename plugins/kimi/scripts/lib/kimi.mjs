// Kimi adapter: drives kimi-code through its ACP (Agent Client Protocol) stdio
// server (#222/#223). The prompt — with the selected source embedded — is streamed
// over stdin as JSON-RPC, NOT passed as a `-p <argv>` argument, so it is immune to
// the Linux MAX_ARG_STRLEN (128 KiB single-arg) cap that crashed large reviews with
// E2BIG. See acp-client.mjs for the wire protocol (validated live against 0.18.0).

import { runAcpPrompt } from "./acp-client.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";
import { detectKimiCapabilities, assertKimiContract } from "./kimi-capabilities.mjs";
import { PRE_TARGET_NOT_SENT_ERROR_CODES } from "./external-review.mjs";

function assertProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("assertProfile: first argument must be a mode profile object");
  }
  for (const field of ["name", "permission_mode", "add_dir", "schema_allowed"]) {
    if (!(field in profile)) {
      throw new Error(`assertProfile: profile is missing required field "${field}"`);
    }
  }
}

// Map a relay mode profile onto the ACP tool-permission mode. Review-family runs
// (permission_mode "plan") need no tools — the source is embedded in the prompt —
// so we leave the agent's default mode and DENY any stray permission request,
// keeping the source-packet audit exact (no out-of-packet file reads). Rescue
// (permission_mode "acceptEdits") runs tools-on to apply edits, so it gets YOLO
// (auto-approve) and we approve any permission request the agent does raise.
function acpModeForProfile(profile) {
  const editing = profile?.permission_mode === "acceptEdits" || profile?.permission_mode === "bypassPermissions";
  return editing
    ? { acpMode: "yolo", approveToolCalls: true }
    : { acpMode: null, approveToolCalls: false };
}

// Translate the ACP client's failure reason into relay's shared failure vocabulary
// so source-content-transmission classification (external-review.mjs) buckets it
// correctly. Pre-prompt failures map to NOT_SENT codes; post-prompt failures map to
// content-received codes.
const ACP_REASON_TO_CODE = Object.freeze({
  auth_required: "not_authed",
  kimi_refused: "review_not_completed",
  kimi_cancelled: "review_not_completed",
  review_incomplete: "review_not_completed",
  // model_unavailable, acp_protocol_error, cli_contract_mismatch, spawn_failed,
  // kimi_error, timeout, empty_stdout pass through unchanged.
});

function acpResultToParsed(acp) {
  if (acp.ok) {
    return {
      ok: true,
      sessionId: acp.sessionId,
      result: acp.result,
      structured: null,
      denials: [],
      usage: null,
      costUsd: null,
      error: null,
      raw: acp.rawTranscript,
    };
  }
  // Collect the raw failure reason + detail from every signal, then enforce the
  // source-transmission disclosure invariant at ONE chokepoint below (both
  // directions), keyed on acp.sourceSent — the adapter's single source of truth for
  // whether the prompt (the user's selected source) was written.
  //
  // A quota/billing failure surfaces in the ACP error or stderr (scanned only on the
  // error/stderr channels, never successful review text). It carries a SPECIFIC
  // pre/post code so the disclosure names the quota cause: post-send usage_limited
  // (content-received -> SENT), pre-send usage_limited_preflight (pre-target ->
  // NOT_SENT).
  let reason;
  let error;
  const usageLimited = usageLimitMessage(acp.error ?? "", acp.stderr ?? "");
  if (usageLimited) {
    reason = acp.sourceSent === true ? "usage_limited" : "usage_limited_preflight";
    error = usageLimited;
  } else {
    reason = ACP_REASON_TO_CODE[acp.reason] ?? acp.reason ?? "kimi_error";
    error = acp.error;
  }

  // Disclosure invariant — closed SYMMETRICALLY at this one chokepoint so neither
  // direction depends on each upstream branch remembering the sourceSent gate.
  //
  // Under-disclosure (sourceSent === true): the prompt was written, so the source HAS
  // been transmitted and the code MUST classify content-received. A pre-target code
  // here (e.g. a -32000 authRequired returned by session/prompt -> auth_required ->
  // not_authed, a member of PRE_TARGET_NOT_SENT_ERROR_CODES) would disclose
  // transmitted source as NOT_SENT — the dangerous direction. Coerce any post-send
  // pre-target code to the generic content-received kimi_error.
  //
  // Over-disclosure (sourceSent === false): the prompt was never written, so the
  // source did NOT leave the machine and the disclosure MUST be NOT_SENT. Allow only
  // pre-target codes (which already disclose NOT_SENT) to pass; coerce ANYTHING that
  // would classify content-received -> SENT (a lifecycle code OR a future un-gated
  // text-scan like the quota matcher above) to the generic pre-target
  // acp_protocol_error. This makes the over-disclosure class structurally unreachable
  // — the mirror of the under-disclosure guard — instead of trusting each text-scan
  // to remember the gate. EXCEPTION: timeout is the deliberately-deferred #228
  // cross-provider behavior (a pre-prompt handshake timeout discloses SENT by design)
  // and is left untouched until #228 distinguishes pre/post-send timeouts. The raw
  // detail is preserved in error.
  if (acp.sourceSent === true) {
    if (PRE_TARGET_NOT_SENT_ERROR_CODES.has(reason)) reason = "kimi_error";
  } else if (reason !== "timeout" && !PRE_TARGET_NOT_SENT_ERROR_CODES.has(reason)) {
    reason = "acp_protocol_error";
  }
  return { ok: false, reason, error, sessionId: acp.sessionId, raw: acp.rawTranscript };
}

// Exported for focused bridge tests: proves the post-send pre-target coercion holds
// for the whole CLASS of pre-target reasons, not just the auth_required instance.
export { acpResultToParsed };

// Run one kimi-code turn (ping / review / rescue) over ACP and return the legacy
// spawn contract the companion consumes:
//   { exitCode, signal, timedOut, endedAt, stdout, stderr, kimiSessionId, pidInfo,
//     parsed: { ok, reason?, error?, result?, sessionId, raw, ... } }
export async function spawnKimi(profile, runtimeInputs = {}) {
  assertProfile(profile);
  const {
    model = null,
    promptText,
    resumeId = null,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 0,
    binary = "kimi",
    onSpawn = null,
  } = runtimeInputs;

  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("spawnKimi: promptText is required");
  }

  // Contract guard: the installed CLI must advertise the `acp` command relay
  // drives. Throw a clear cli_contract_mismatch (source NOT sent) instead of
  // spawning a CLI generation that can't speak ACP. No-op when the contract cannot
  // be probed (fail-open). The companion catch maps the throw to status=failed /
  // error_code=cli_contract_mismatch / source_content_transmission=not_sent.
  const capabilities = detectKimiCapabilities(binary, { env });
  assertKimiContract(capabilities);

  const { acpMode, approveToolCalls } = acpModeForProfile(profile);
  // Review-family runs report only the final verdict turn; rescue keeps the full
  // multi-turn transcript.
  const finalMessageOnly = profile?.name !== "rescue";

  const acp = await runAcpPrompt({
    command: binary,
    args: ["acp"],
    cwd,
    env,
    model,
    acpMode,
    approveToolCalls,
    promptText,
    resumeId,
    timeoutMs,
    onSpawn,
    finalMessageOnly,
  });

  // A spawn-level failure (binary not found / not executable) re-throws with the
  // original code, preserving the legacy throw contract the companion relies on
  // (ENOENT -> not_found readiness; generic spawn failure -> error).
  if (acp.spawnFailed) {
    throw Object.assign(new Error(acp.error ?? `spawn ${binary} failed`), { code: acp.spawnErrorCode ?? "spawn_failed" });
  }

  return {
    exitCode: acp.exitCode,
    signal: acp.signal,
    timedOut: acp.timedOut,
    endedAt: new Date().toISOString(),
    stdout: acp.result,
    stderr: acp.stderr,
    kimiSessionId: acp.sessionId,
    pidInfo: acp.pidInfo,
    parsed: acpResultToParsed(acp),
  };
}
