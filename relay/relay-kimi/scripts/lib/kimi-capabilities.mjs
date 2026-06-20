// Kimi CLI capability detection + command-surface contract guard (#222, #223).
//
// Relay drives kimi-code through its ACP (Agent Client Protocol) stdio server —
// `kimi acp` — because the one-shot `-p <prompt>` surface delivers the prompt as an
// argv argument, which Linux caps at MAX_ARG_STRLEN (128 KiB) and crashes large
// reviews with E2BIG (see acp-client.mjs). A different CLI generation (e.g. the
// legacy `kimi-cli`) does not advertise an `acp` command, so spawning it would fail
// cryptically. Rather than hardcode any generation's spelling, we read the installed
// CLI's own `--help` and fail with a clear, terminal `cli_contract_mismatch` when the
// `acp` command is not advertised.
//
// Detection is FAIL-OPEN: when we cannot confidently read the CLI's contract
// (e.g. `--help` errors, or its output is unrecognizable) we report ok:false and
// callers SKIP the guard, so a CLI we could not probe is never wrongly blocked.

import { realpathSync, statSync } from "node:fs";

import { runCommand } from "./process.mjs";

// Bound the capability probe. detectKimiCapabilities runs on every spawnKimi
// (ping, review, continue), so a `kimi` binary that hangs on `--help`/`--version`
// (wedged auth prompt, NFS stall, broken wrapper) must not block the review
// indefinitely. On timeout spawnSync sets result.error (ETIMEDOUT) → we report
// ok:false and callers SKIP the guard (fail-open), exactly like an unprobeable CLI.
export const KIMI_CAPABILITY_PROBE_TIMEOUT_MS = 5000;

// The command-surface relay requires: kimi-code must run as an ACP stdio server.
export const REQUIRED_KIMI_COMMANDS = Object.freeze(["acp"]);

export class KimiContractMismatchError extends Error {
  constructor(message, { missing = [], detectedVersion = null } = {}) {
    super(message);
    this.name = "KimiContractMismatchError";
    this.code = "cli_contract_mismatch";
    this.missing = missing;
    this.detectedVersion = detectedVersion;
  }
}

// Parse the option flag tokens advertised by a CLI --help screen. Only lines
// that look like an option entry (leading whitespace + a dash) are scanned, so
// prose, usage examples, and command descriptions don't introduce phantom flags.
// Used only to recognize that --help produced a genuine options screen.
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

// Parse the subcommand names advertised under the "Commands:" section of a
// commander-style --help screen. Only entries inside that section are scanned: an
// indented line whose first token is a bare word (not a dash). Stops at the next
// unindented header (e.g. "Documentation:") so prose never injects phantom commands.
export function parseKimiHelpCommands(helpText) {
  const commands = new Set();
  let inCommands = false;
  for (const line of String(helpText ?? "").split("\n")) {
    if (/^[A-Za-z].*:\s*$/.test(line)) {
      inCommands = /^commands:/i.test(line.trim());
      continue;
    }
    if (!inCommands) continue;
    const m = /^\s+([a-z][a-z0-9-]*)\b/.exec(line);
    if (m) commands.add(m[1]);
  }
  return commands;
}

// Per-process cache of successful capability probes. detectKimiCapabilities runs
// on every spawnKimi (ping, review, continue), so a single review would otherwise
// re-probe the same binary 2-3× (×2 spawnSync each). We cache only SUCCESSFUL
// probes: a failed/transient probe (timeout, non-zero --help) must stay
// re-tryable, never sticky for the process lifetime.
//
// The key is the executable's STAT IDENTITY (resolved real path + dev/ino + size +
// mtime + ctime), NOT the binary string. Keying by string is unsafe: the binary may
// be a bare name ("kimi") that resolves differently as env.PATH changes, and an
// in-place upgrade keeps the same path but changes the contract. Stat identity
// defeats both. When the path cannot be stat'd (a bare PATH name spawnSync resolves
// itself), we DO NOT cache. Only the real (default runImpl) path is cached; an
// injected runImpl (tests) always re-runs so fixtures stay isolated.
const capabilityCache = new Map();

// Test-only: clear the per-process capability cache.
export function __resetKimiCapabilityCache() {
  capabilityCache.clear();
}

// Stat-identity cache key for an executable path, or null when it cannot be
// resolved/stat'd — null means "do not cache", never "cache under the raw string".
//
// The key must change whenever the file's CONTENT could have changed, because a
// stale hit bypasses the contract guard — a security boundary deciding whether
// source is transmitted. mtime+size alone is forgeable: an in-place replacement
// with a byte-identical size and a backdated mtime (`utimes`) reuses stale
// capabilities. So we also key on ctimeMs (inode-change time — updated on any
// write, and NOT settable backwards from userland, unlike mtime) and dev+ino (a
// rename/replace lands a new inode → new key, even across devices).
function binaryCacheKey(binary) {
  try {
    const real = realpathSync(binary);
    const st = statSync(real);
    return `${real}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
}

// Probe the installed Kimi CLI's supported flags + commands via `--help`. Returns
// { ok, supportedFlags:Set, supportedCommands:Set, version, detail }. ok is true
// ONLY when --help clearly produced an options screen (exit 0 AND it lists its own
// --help/-h).
export function detectKimiCapabilities(binary, { env = process.env, runImpl = runCommand } = {}) {
  const cacheKey = runImpl === runCommand ? binaryCacheKey(binary) : null;
  if (cacheKey !== null && capabilityCache.has(cacheKey)) return capabilityCache.get(cacheKey);
  const result = probeKimiCapabilities(binary, { env, runImpl });
  if (cacheKey !== null && result.ok) capabilityCache.set(cacheKey, result);
  return result;
}

function probeKimiCapabilities(binary, { env, runImpl }) {
  const help = runImpl(binary, ["--help"], { env, timeout: KIMI_CAPABILITY_PROBE_TIMEOUT_MS });
  if (help.error || help.status !== 0) {
    return {
      ok: false,
      supportedFlags: new Set(),
      supportedCommands: new Set(),
      version: null,
      detail: String(help.stderr || help.error?.message || "kimi --help exited non-zero").trim().slice(0, 400),
    };
  }
  const supportedFlags = parseKimiHelpFlags(help.stdout);
  if (!supportedFlags.has("--help") && !supportedFlags.has("-h")) {
    // Output did not look like a genuine options screen — do not trust it.
    return { ok: false, supportedFlags: new Set(), supportedCommands: new Set(), version: null, detail: "kimi --help output not recognized" };
  }
  const supportedCommands = parseKimiHelpCommands(help.stdout);
  let version = null;
  const ver = runImpl(binary, ["--version"], { env, timeout: KIMI_CAPABILITY_PROBE_TIMEOUT_MS });
  if (!ver.error && ver.status === 0) {
    version = String(ver.stdout ?? "").trim().split("\n")[0] || null;
  }
  return { ok: true, supportedFlags, supportedCommands, version, detail: null };
}

// The required commands the installed CLI does not advertise. Empty when
// capabilities are unknown (detection failed) — never a false positive (fail-open).
export function missingKimiCommands(capabilities) {
  if (!capabilities?.ok) return [];
  return REQUIRED_KIMI_COMMANDS.filter((c) => !capabilities.supportedCommands.has(c));
}

// Throw a typed contract-mismatch error when the installed CLI does not advertise
// the `acp` command relay drives. No-op when capabilities are unknown (fail-open).
export function assertKimiContract(capabilities) {
  const missing = missingKimiCommands(capabilities);
  if (missing.length === 0) return;
  const ver = capabilities.version ? ` ${capabilities.version}` : "";
  throw new KimiContractMismatchError(
    `cli_contract_mismatch: installed Kimi CLI${ver} does not advertise the ${missing.join(", ")} command. ` +
    "Relay drives kimi-code through its ACP stdio server (`kimi acp`); the installed CLI advertises a different " +
    "command contract. Install or update to the kimi-code CLI (#222).",
    { missing, detectedVersion: capabilities.version },
  );
}
