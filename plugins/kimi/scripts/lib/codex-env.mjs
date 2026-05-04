// Shared Codex host-environment detection.
// Edit scripts/lib/codex-env.mjs, then run
// `node scripts/ci/sync-codex-env.mjs` to update plugin packaging copies.

const CODEX_SANDBOX_FALSE_VALUES = new Set([
  "",
  "false",
  "0",
  "no",
  "off",
  "null",
  "undefined",
  "nil",
]);

export function isCodexSandbox(env) {
  const value = env?.CODEX_SANDBOX;
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  return !CODEX_SANDBOX_FALSE_VALUES.has(normalized);
}
