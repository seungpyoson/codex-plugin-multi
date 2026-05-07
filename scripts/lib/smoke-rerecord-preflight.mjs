// scripts/lib/smoke-rerecord-preflight.mjs
//
// Preflight predicates shared between scripts/smoke-rerecord.mjs and its
// unit tests. Pure functions only — no process.exit, no I/O, no default
// fs imports. Callers must pass `env` and (where applicable) `fileExists`
// explicitly; this module can be imported into any test or non-Node
// runtime without dragging the filesystem into scope.

const isEnvValueSet = (env, key) =>
  typeof env[key] === "string" && env[key].length > 0;

/**
 * Check that one of `spec.envAny` is set to a non-empty string in `env`.
 *
 * Unifies the predicate used by both `requireEnvAny` and the env branch
 * of `requireEnvOrFile`. Empty-string env values are treated as unset
 * (CI exports unset secret refs as `""`).
 *
 * @param {{ envAny?: string[] }} spec
 * @param {{ env: Record<string, string | undefined> }} opts
 * @returns {{ ok: true, source: "env", key: string }
 *          | { ok: false, missing: { envAny: string[] }, reason: string }}
 */
export function checkEnvAny(spec, opts) {
  if (!opts || typeof opts.env !== "object" || opts.env === null) {
    throw new TypeError("checkEnvAny: opts.env is required");
  }
  const envAny = Array.isArray(spec?.envAny) ? spec.envAny : [];
  for (const key of envAny) {
    if (isEnvValueSet(opts.env, key)) {
      return { ok: true, source: "env", key };
    }
  }
  return {
    ok: false,
    missing: { envAny: [...envAny] },
    reason: envAny.length > 0
      ? `no auth available: need one of ${envAny.join(" / ")} in env`
      : "no auth available: spec has no envAny entries",
  };
}

/**
 * Check that a recipe's auth prerequisites are satisfied: EITHER an
 * entry from `envAny` is set in env, OR `file` exists on disk.
 *
 * Failure responses are structured (`missing.envAny` and `missing.file`)
 * so callers can render conditional help (env-only, file-only, both)
 * instead of a one-size-fits-all message that misleads on CI runners.
 *
 * @param {{ envAny?: string[], file?: string }} spec
 * @param {{ env: Record<string, string | undefined>, fileExists: (p: string) => boolean }} opts
 * @returns {{ ok: true, source: "env" | "file", key?: string, file?: string }
 *          | { ok: false, missing: { envAny: string[], file: string | null }, reason: string }}
 */
export function checkAuthOrFile(spec, opts) {
  if (!opts || typeof opts.env !== "object" || opts.env === null) {
    throw new TypeError("checkAuthOrFile: opts.env is required");
  }
  if (typeof opts.fileExists !== "function") {
    throw new TypeError("checkAuthOrFile: opts.fileExists is required");
  }
  const envAny = Array.isArray(spec?.envAny) ? spec.envAny : [];
  const file = typeof spec?.file === "string" && spec.file.length > 0
    ? spec.file
    : null;

  for (const key of envAny) {
    if (isEnvValueSet(opts.env, key)) {
      return { ok: true, source: "env", key };
    }
  }

  if (file && opts.fileExists(file)) {
    return { ok: true, source: "file", file };
  }

  const envPart = envAny.length > 0
    ? `one of ${envAny.join(" / ")} in env`
    : "(no env keys configured)";
  const filePart = file ? `${file} on disk` : "(no file path configured)";
  return {
    ok: false,
    missing: { envAny: [...envAny], file },
    reason: `no auth available: need ${envPart} or ${filePart}`,
  };
}

/**
 * Render conditional remediation help from a `checkAuthOrFile` failure.
 * Replaces the previous unconditional "Sign in to the CLI first or
 * set the relevant *_API_KEY env var" tail, which was misleading on
 * CI runners where the file path is irrelevant.
 *
 * @param {{ envAny: string[], file: string | null }} missing
 * @returns {string}
 */
export function renderAuthOrFileHelp(missing) {
  const hasEnv = Array.isArray(missing?.envAny) && missing.envAny.length > 0;
  const hasFile = typeof missing?.file === "string" && missing.file.length > 0;
  if (hasEnv && hasFile) {
    return `Set ${missing.envAny.join(" or ")} in env, or sign in to populate ${missing.file}.`;
  }
  if (hasEnv) {
    return `Set ${missing.envAny.join(" or ")} in env.`;
  }
  if (hasFile) {
    return `Sign in to the CLI to populate ${missing.file}.`;
  }
  return "(spec has no auth requirements configured)";
}
