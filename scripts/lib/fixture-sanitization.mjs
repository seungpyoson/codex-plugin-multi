// Fixture sanitization library. Used by scripts/smoke-rerecord.mjs and the
// .github/workflows/smoke-rerecord.yml workflow_dispatch path to sanitize
// real provider responses before committing them as smoke fixtures.
//
// Three architectures, three different redaction needs (per
// docs/contracts/redaction.md):
//
//   1. Companion (claude/gemini/kimi): the runtime defense is pre-spawn
//      env-strip via sanitizeTargetEnv. Fixture sanitization here is
//      defense-in-depth — strips session ids and any literal credential
//      values that ended up in the captured stdout.
//   2. grok: runtime redaction scans process.env for env-key NAMES matching
//      /(?:API_KEY|TOKEN|COOKIE|SESSION|SSO)/i, redacts those values from
//      output when length >= 8.
//   3. api-reviewers: runtime redaction matches both configured env_keys
//      values (>=4 chars, lower threshold for operator-curated names) and
//      auto-detected env-name patterns (>=8 chars). Plus Authorization
//      headers and Bearer tokens.
//
// This library unifies all three. It applies the union of patterns to a
// recorded response, returning a deep-cloned sanitized copy. Conservative
// by default — better to over-redact a fixture than to leak.

const REDACTED = "[REDACTED]";

// Union of grok's and api-reviewers' env-name patterns. Either matches → the
// env value is treated as a secret.
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY|COOKIE|SESSION|SSO)$/i;

// Default minimum length thresholds (mirror api-reviewer.mjs).
const MIN_SECRET_REDACTION_LENGTH_AUTO = 8;        // auto-detected env names
const MIN_SECRET_REDACTION_LENGTH_CURATED = 4;     // operator-curated env_keys

// Common public-prefix shapes. Match-anywhere even if the env value isn't
// in process.env at sanitize time. Conservative default; lets us scrub
// echo-attacks where the provider response includes a hardcoded test key.
const SECRET_PREFIX_PATTERNS = Object.freeze([
  /sk-[a-zA-Z0-9]{20,}/g,                    // OpenAI / Anthropic style
  /sk-or-v[0-9]+-[a-zA-Z0-9]{20,}/g,         // OpenRouter
  /sk-ant-api[0-9]+-[a-zA-Z0-9_-]{20,}/g,    // Anthropic prefixed
  /AKIA[0-9A-Z]{16}/g,                       // AWS access key
  /AIza[0-9A-Za-z_-]{35}/g,                  // Google API key
  /glpat-[a-zA-Z0-9_-]{20,}/g,               // GitLab personal access token
  /gh[ps]_[a-zA-Z0-9]{36}/g,                 // GitHub token (pat / server)
  /github_pat_[a-zA-Z0-9_]{20,}/g,           // GitHub fine-grained PAT
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT
]);

// Authorization-header and Bearer-token patterns from api-reviewer.mjs:646-651.
const AUTHORIZATION_HEADER = /Authorization:\s*\S.*$/gim;
const BEARER_TOKEN = /Bearer\s+\S+/gi;

// Companion session-id field names. Removed (replaced with REDACTED) when
// architecture is "companion" — these are user-identity-linked.
const COMPANION_SESSION_ID_FIELDS = Object.freeze([
  "claude_session_id",
  "gemini_session_id",
  "kimi_session_id",
]);

// Other fields that always sanitize (across architectures): present on
// JobRecord-shaped output and tied to local user identity.
const ALWAYS_SANITIZE_FIELDS = Object.freeze([
  "cwd",          // absolute paths reveal /Users/<name>
  "workspace_root",
  "endpoint",     // api-reviewers: contains base URL; safe to keep; here defensively kept
]);

const PATH_SCRUB = /\/Users\/[^/\s]+/g;  // macOS user-home leak

/**
 * Build a redactor function that scans process.env for secret-shaped
 * names + a configured set of env-key names. Returns a function that
 * substitutes any matched value with REDACTED.
 *
 * @param {object} env  Typically process.env.
 * @param {object} options
 * @param {string[]} [options.curatedEnvKeys]  Names operator marked as
 *   credential-bearing (api-reviewers cfg.env_keys). Lower length floor.
 * @returns {(value: string) => string}
 */
export function buildEnvSecretRedactor(env, { curatedEnvKeys = [] } = {}) {
  const secrets = new Set();
  const curated = new Set(curatedEnvKeys.map((k) => String(k).toUpperCase()));

  for (const [key, rawValue] of Object.entries(env ?? {})) {
    const value = String(rawValue ?? "");
    if (!value) continue;
    const upperKey = key.toUpperCase();
    const isCurated = curated.has(upperKey);
    const matchesAuto = SECRET_ENV_NAME.test(upperKey);
    if (!isCurated && !matchesAuto) continue;
    const minLen = isCurated
      ? MIN_SECRET_REDACTION_LENGTH_CURATED
      : MIN_SECRET_REDACTION_LENGTH_AUTO;
    if (value.length < minLen) continue;
    secrets.add(value);
  }

  return function redactEnvSecrets(input) {
    let out = String(input ?? "");
    for (const secret of secrets) {
      // Use split/join for literal replacement (no regex injection risk).
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    return out;
  };
}

/**
 * Apply the public-prefix patterns and Authorization/Bearer regexes to a
 * string. Pure: input is not mutated.
 */
export function redactKnownPatterns(input) {
  let out = String(input ?? "");
  for (const pattern of SECRET_PREFIX_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  out = out.replace(AUTHORIZATION_HEADER, `Authorization: ${REDACTED}`);
  out = out.replace(BEARER_TOKEN, `Bearer ${REDACTED}`);
  out = out.replace(PATH_SCRUB, "/Users/<user>");
  return out;
}

/**
 * Apply both env-secret redaction and pattern redaction to a string.
 */
export function sanitizeString(input, redactEnvSecrets) {
  const afterEnv = redactEnvSecrets ? redactEnvSecrets(input) : String(input ?? "");
  return redactKnownPatterns(afterEnv);
}

/**
 * Recursively walk a value, applying string sanitization and
 * field-level scrubs based on architecture.
 *
 * @param {*} value
 * @param {object} ctx
 * @param {(s: string) => string} ctx.redactEnvSecrets
 * @param {"companion"|"grok"|"api-reviewers"} ctx.architecture
 */
function sanitizeValue(value, ctx) {
  if (value == null) return value;
  if (typeof value === "string") {
    return sanitizeString(value, ctx.redactEnvSecrets);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, ctx));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, sub] of Object.entries(value)) {
      if (ctx.architecture === "companion" && COMPANION_SESSION_ID_FIELDS.includes(key)) {
        out[key] = sub == null ? null : REDACTED;
        continue;
      }
      if (ALWAYS_SANITIZE_FIELDS.includes(key) && typeof sub === "string") {
        out[key] = sanitizeString(sub, ctx.redactEnvSecrets);
        continue;
      }
      out[key] = sanitizeValue(sub, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize a recorded provider response for fixture commit.
 *
 * @param {*} record  The recorded response object (will be deep-cloned).
 * @param {object} options
 * @param {"companion"|"grok"|"api-reviewers"} options.architecture
 * @param {object} [options.env]            Defaults to process.env.
 * @param {string[]} [options.curatedEnvKeys]  api-reviewers cfg.env_keys list.
 * @returns {*}  A deep-cloned, sanitized copy of `record`.
 */
export function sanitize(record, options = {}) {
  const architecture = options.architecture;
  if (!architecture || !["companion", "grok", "api-reviewers"].includes(architecture)) {
    throw new Error(
      "fixture-sanitization: options.architecture must be one of "
      + "\"companion\", \"grok\", \"api-reviewers\"",
    );
  }
  const env = options.env ?? process.env;
  const redactEnvSecrets = buildEnvSecretRedactor(env, {
    curatedEnvKeys: options.curatedEnvKeys ?? [],
  });
  return sanitizeValue(record, {
    redactEnvSecrets,
    architecture,
  });
}

/**
 * Build a provenance object for the recorded fixture per
 * docs/contracts/api-reviewers-output.md schema.
 *
 * @param {object} options
 * @param {string} options.modelId
 * @param {string} [options.recordedAt]      Defaults to now ISO 8601.
 * @param {string} options.promptHash        SHA-256 hex of the prompt.
 * @param {string} options.sanitizationNotes Human-readable notes.
 * @param {string} options.recordedBy        e.g., "manual: workflow_dispatch run #42".
 * @param {number} [options.staleAfterDays]  Default 90.
 */
export function buildProvenance({
  modelId,
  recordedAt,
  promptHash,
  sanitizationNotes,
  recordedBy,
  staleAfterDays = 90,
}) {
  if (!modelId) throw new Error("buildProvenance: modelId is required");
  if (!promptHash) throw new Error("buildProvenance: promptHash is required");
  if (!sanitizationNotes) throw new Error("buildProvenance: sanitizationNotes is required");
  if (!recordedBy) throw new Error("buildProvenance: recordedBy is required");
  const now = recordedAt ?? new Date().toISOString();
  const staleAfter = new Date(
    new Date(now).getTime() + staleAfterDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return Object.freeze({
    model_id: modelId,
    recorded_at: now,
    prompt_hash: promptHash.startsWith("sha256:") ? promptHash : `sha256:${promptHash}`,
    sanitization_notes: sanitizationNotes,
    recorded_by: recordedBy,
    stale_after: staleAfter,
  });
}

// Re-export constants so tests and the rerecord script can reference them
// without re-deriving.
export const FIXTURE_SANITIZATION_REDACTED_TOKEN = REDACTED;
export const FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR = MIN_SECRET_REDACTION_LENGTH_AUTO;
export const FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR = MIN_SECRET_REDACTION_LENGTH_CURATED;
