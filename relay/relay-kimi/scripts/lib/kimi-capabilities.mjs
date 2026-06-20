// Kimi CLI capability detection + command-surface contract guard (#222, #223).
//
// Relay targets the kimi-code prompt-mode surface (`-p/--prompt`,
// `--output-format`, `--session`). A different CLI generation (e.g. the legacy
// `kimi-cli` `--print` surface) advertises a different contract, so spawning it
// with relay's flags dies on the first unknown option with a cryptic "unknown
// option" error before auth is ever reached. Rather than hardcode any
// generation's flag spellings, we read the installed CLI's own `--help` and
// fail with a clear, terminal `cli_contract_mismatch` when relay's emitted
// flags are not supported.
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

// Per-process cache of successful capability probes. detectKimiCapabilities runs
// on every spawnKimi (ping, review, continue), so a single review would otherwise
// re-probe the same binary 2-3× (×2 spawnSync each). We cache only SUCCESSFUL
// probes: a failed/transient probe (timeout, non-zero --help) must stay
// re-tryable, never sticky for the process lifetime.
//
// The key is the executable's STAT IDENTITY (resolved real path + mtime + size),
// NOT the binary string. Keying by string is unsafe: the binary may be a bare
// name ("kimi") that resolves differently as env.PATH changes (two builds share
// one entry — wrong surface reused), and an in-place upgrade keeps the same path
// but changes the contract (stale flags reused). Stat identity defeats both: a
// different executable has a different realpath, and an upgrade changes the
// mtime, so either yields a fresh key and a re-probe. When the path cannot be
// stat'd (a bare PATH name spawnSync resolves itself), we DO NOT cache — we never
// reimplement PATH resolution, which could diverge from what spawnSync runs and
// cache a different file's facts. Only the real (default runImpl) path is cached;
// an injected runImpl (tests) always re-runs so fixtures stay isolated.
const capabilityCache = new Map();

// Test-only: clear the per-process capability cache.
export function __resetKimiCapabilityCache() {
  capabilityCache.clear();
}

// Stat-identity cache key for an executable path, or null when it cannot be
// resolved/stat'd (e.g. a bare name resolved off env.PATH) — null means "do not
// cache", never "cache under the raw string".
//
// The key must change whenever the file's CONTENT could have changed, because a
// stale hit bypasses the contract guard — a security boundary deciding whether
// source is transmitted. mtime+size alone is forgeable: an in-place replacement
// with a byte-identical size and a backdated mtime (`utimes`) reuses stale
// capabilities and could send the prompt argv to a swapped-in legacy CLI. So we
// also key on ctimeMs (inode-change time — updated on any write, and NOT
// settable backwards from userland, unlike mtime) and dev+ino (a rename/replace
// lands a new inode → new key, even across devices).
function binaryCacheKey(binary) {
  try {
    const real = realpathSync(binary);
    const st = statSync(real);
    return `${real}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return null;
  }
}

// Probe the installed Kimi CLI's supported flags via `--help`. Returns
// { ok, supportedFlags:Set, version, detail }. ok is true ONLY when --help
// clearly produced an options screen (exit 0 AND it lists its own --help/-h).
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
  const ver = runImpl(binary, ["--version"], { env, timeout: KIMI_CAPABILITY_PROBE_TIMEOUT_MS });
  if (!ver.error && ver.status === 0) {
    version = String(ver.stdout ?? "").trim().split("\n")[0] || null;
  }
  return { ok: true, supportedFlags, version, detail: null };
}

// The value-taking flags relay's adapter emits (see buildKimiCodeArgs in kimi.mjs:
// `-p <prompt>`, `--output-format <fmt>`, `-m <model>`, `--session <id>`). Their
// VALUE is arbitrary user/runtime text that can itself start with "-" (a prompt
// like "-v: fix this", a dash-prefixed model alias, `--output-format -json`).
// The contract guard must scan flag positions only, never value positions, or a
// dash-leading value is misread as an unsupported flag and throws a false
// cli_contract_mismatch — the exact false-negative class this guard exists to
// kill. This set MUST mirror the value flags buildKimiCodeArgs can emit; the unit
// suite (kimi-capabilities.test.mjs) and contract tests pin both ends.
const KIMI_VALUE_FLAGS = new Set([
  "-p", "--prompt", "-m", "--model", "--output-format", "-S", "--session",
]);

// The distinct adapter-owned flag tokens an argv array uses. Parsed with flag
// arity: a token starting with "-" is a flag, and the token following a known
// value-taking flag is its VALUE (skipped), never inspected as a flag. The
// `--flag=value` form carries its own value, so it is normalized to the bare
// `--flag` and its next token is NOT skipped. Detection failure stays a no-op
// upstream (missingKimiFlags returns [] when capabilities are unknown).
export function argFlags(args) {
  const flags = new Set();
  const argv = args ?? [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("-")) continue;
    const flag = token.split("=", 1)[0];
    flags.add(flag);
    // A bare value flag (no attached `=value`) consumes the next token as its
    // value — skip it so a dash-leading value is never scanned as a flag.
    if (KIMI_VALUE_FLAGS.has(flag) && !token.includes("=")) i += 1;
  }
  return [...flags];
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
