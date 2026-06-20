// Kimi adapter: drives kimi-code through its ACP (Agent Client Protocol) stdio
// server (#222/#223). The prompt — with the selected source embedded — is streamed
// over stdin as JSON-RPC, NOT passed as a `-p <argv>` argument, so it is immune to
// the Linux MAX_ARG_STRLEN (128 KiB single-arg) cap that crashed large reviews with
// E2BIG. See acp-client.mjs for the wire protocol (validated live against 0.18.0).

import { runAcpPrompt } from "./acp-client.mjs";
import { usageLimitMessage } from "./usage-limit.mjs";
import { detectKimiCapabilities, assertKimiContract } from "./kimi-capabilities.mjs";

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

// Single source of truth for which profiles may use the kimi-code ACP surface.
// Post-migration that is EVERY mode: the prompt embeds the selected source, so
// review-family runs complete with no tool calls and rescue runs tools-on in the
// working tree. A null/unknown profile is rejected.
export function kimiCodeSurfaceEligible(profile) {
  return Boolean(profile && typeof profile === "object" && typeof profile.name === "string");
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
  // A quota/billing failure surfaces in the ACP error or stderr — preserve the
  // legacy usage_limited classification (scanned only on the error/stderr channels,
  // never successful review text).
  const usageLimited = usageLimitMessage(acp.error ?? "", acp.stderr ?? "");
  if (usageLimited) {
    return { ok: false, reason: "usage_limited", error: usageLimited, sessionId: acp.sessionId, raw: acp.rawTranscript };
  }
  const reason = ACP_REASON_TO_CODE[acp.reason] ?? acp.reason ?? "kimi_error";
  return { ok: false, reason, error: acp.error, sessionId: acp.sessionId, raw: acp.rawTranscript };
}

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
