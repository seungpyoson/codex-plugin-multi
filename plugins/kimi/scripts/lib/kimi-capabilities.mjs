// Kimi CLI capability detection + command-surface contract guard (#222, #223).
//
// Relay's `buildKimiArgs` emits the legacy `kimi-cli` flag surface (e.g.
// `--print`, `--input-format`, `--max-steps-per-turn`). The rewritten
// `kimi-code` CLI uses a different contract (e.g. `-p/--prompt`, no
// `--input-format`), so spawning it with the legacy flags dies on the first
// unknown option with a cryptic "unknown option" error before auth is ever
// reached. Rather than hardcode either generation's flag spellings, we read the
// installed CLI's own `--help` and fail with a clear, terminal
// `cli_contract_mismatch` when relay's emitted flags are not supported.
//
// Detection is FAIL-OPEN: when we cannot confidently read the CLI's contract
// (e.g. `--help` errors, or its output is unrecognizable) we report ok:false and
// callers SKIP the guard, so a CLI we could not probe is never wrongly blocked.

import { runCommand } from "./process.mjs";

export class KimiContractMismatchError extends Error {
  constructor(message, { missingFlags = [], detectedVersion = null } = {}) {
    super(message);
    this.name = "KimiContractMismatchError";
    this.code = "cli_contract_mismatch";
    this.missingFlags = missingFlags;
    this.detectedVersion = detectedVersion;
  }
}

// Parse the option flag tokens advertised by a CLI --help screen. Only lines
// that look like an option entry (leading whitespace + a dash) are scanned, so
// prose, usage examples, and command descriptions don't introduce phantom flags.
export function parseKimiHelpFlags(helpText) {
  const flags = new Set();
  const tokenRe = /(--[a-zA-Z0-9][a-zA-Z0-9-]*|-[a-zA-Z])(?=[\s,=]|$)/g;
  for (const line of String(helpText ?? "").split("\n")) {
    if (!/^\s+-/.test(line)) continue;
    let m;
    while ((m = tokenRe.exec(line)) !== null) flags.add(m[1]);
  }
  return flags;
}

// Probe the installed Kimi CLI's supported flags via `--help`. Returns
// { ok, supportedFlags:Set, version, detail }. ok is true ONLY when --help
// clearly produced an options screen (exit 0 AND it lists its own --help/-h).
export function detectKimiCapabilities(binary, { env = process.env, runImpl = runCommand } = {}) {
  const help = runImpl(binary, ["--help"], { env });
  if (help.error || help.status !== 0) {
    return {
      ok: false,
      supportedFlags: new Set(),
      version: null,
      detail: String(help.stderr || help.error?.message || "kimi --help exited non-zero").trim().slice(0, 400),
    };
  }
  const supportedFlags = parseKimiHelpFlags(help.stdout);
  if (!supportedFlags.has("--help") && !supportedFlags.has("-h")) {
    // Output did not look like a genuine options screen — do not trust it.
    return { ok: false, supportedFlags: new Set(), version: null, detail: "kimi --help output not recognized" };
  }
  let version = null;
  const ver = runImpl(binary, ["--version"], { env });
  if (!ver.error && ver.status === 0) {
    version = String(ver.stdout ?? "").trim().split("\n")[0] || null;
  }
  return { ok: true, supportedFlags, version, detail: null };
}

// Decide which command surface the installed CLI exposes, from detected
// capabilities. "kimi-code" = the rewritten -p/--prompt CLI (no --print);
// "legacy" = the original kimi-cli --print surface; null = unknown — either
// detection failed or the surface is unrecognized, so callers keep the legacy
// default + assertKimiContract guard rather than guessing. Routing on the
// advertised flag set (not a version string) keeps this a class-level decision:
// a future CLI generation is classified by what it supports, not by a hardcoded
// version match (#222).
export function selectKimiSurface(capabilities) {
  if (!capabilities?.ok) return null;
  const flags = capabilities.supportedFlags;
  if ((flags.has("--prompt") || flags.has("-p")) && !flags.has("--print")) return "kimi-code";
  if (flags.has("--print")) return "legacy";
  return null;
}

// The distinct flag tokens an argv array uses (entries starting with "-").
// `--flag=value` is normalized to the bare `--flag`: a CLI --help screen
// advertises bare flag names, so comparing an attached-value token verbatim
// would wrongly report a supported flag as missing (false cli_contract_mismatch).
export function argFlags(args) {
  return [...new Set(
    (args ?? [])
      .filter((a) => typeof a === "string" && a.startsWith("-"))
      .map((a) => a.split("=", 1)[0]),
  )];
}

// Flags the built argv uses that the installed CLI does not advertise. Empty
// when capabilities are unknown (detection failed) — never a false positive.
export function missingKimiFlags(args, capabilities) {
  if (!capabilities?.ok) return [];
  return argFlags(args).filter((f) => !capabilities.supportedFlags.has(f));
}

// Throw a typed contract-mismatch error when the installed CLI does not support
// the flag surface relay is about to emit. No-op when capabilities are unknown.
export function assertKimiContract(args, capabilities) {
  const missing = missingKimiFlags(args, capabilities);
  if (missing.length === 0) return;
  const ver = capabilities.version ? ` ${capabilities.version}` : "";
  throw new KimiContractMismatchError(
    `cli_contract_mismatch: installed Kimi CLI${ver} does not support ${missing.join(", ")}. ` +
    "Relay's adapter targets the kimi-code prompt-mode surface (-p/--prompt, --output-format, --session); " +
    "the installed CLI advertises a different command contract. Install or update to the kimi-code CLI (#222).",
    { missingFlags: missing, detectedVersion: capabilities.version },
  );
}
