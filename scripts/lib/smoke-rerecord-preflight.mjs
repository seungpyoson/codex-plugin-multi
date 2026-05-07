// scripts/lib/smoke-rerecord-preflight.mjs
//
// Preflight predicates shared between scripts/smoke-rerecord.mjs and its
// unit tests. Pure functions only — no process.exit, no I/O — so callers
// (CLI vs. test) can render diagnostics and decide on exit codes.

import { existsSync as fsExistsSync } from "node:fs";

/**
 * Check that a recipe's auth prerequisites are satisfied.
 *
 * Used for the `requireEnvOrFile` branch of preflight: a recipe needs
 * EITHER a non-empty entry from `envAny` in env, OR `file` to exist on
 * disk. Either branch is sufficient. If both are absent the call returns
 * `{ ok: false, reason }`.
 *
 * Empty-string env values are treated as unset to match shells that
 * export blank vars (`FOO=` from a missing secret in CI) without
 * silently accepting them as authentication.
 *
 * @param {{ envAny?: string[], file?: string }} spec
 * @param {{ env?: NodeJS.ProcessEnv, fileExists?: (p: string) => boolean }} [opts]
 * @returns {{ ok: true, source: "env" | "file", key?: string, file?: string }
 *          | { ok: false, reason: string }}
 */
export function checkAuthOrFile(spec, opts = {}) {
  const env = opts.env ?? process.env;
  const fileExists = opts.fileExists ?? fsExistsSync;
  const envAny = Array.isArray(spec?.envAny) ? spec.envAny : [];
  const file = typeof spec?.file === "string" && spec.file.length > 0 ? spec.file : null;

  for (const key of envAny) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      return { ok: true, source: "env", key };
    }
  }

  if (file && fileExists(file)) {
    return { ok: true, source: "file", file };
  }

  const envPart = envAny.length > 0
    ? `one of ${envAny.join(" / ")} in env`
    : "(no env keys configured)";
  const filePart = file ? `${file} on disk` : "(no file path configured)";
  return {
    ok: false,
    reason: `no auth available: need ${envPart} or ${filePart}`,
  };
}
