import { ARCHITECTURE_KINDS } from "./recipe-architecture.mjs";

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
//
// Trailing alternation `(?:_|$)` rather than just `$` so common rotated/
// scoped suffix names match too: AWS_ACCESS_KEY_ID, OPENAI_API_KEY_PROD,
// STRIPE_SECRET_KEY_LIVE, etc. False positives over-redact (a fixture
// echoing the env value gets `[REDACTED]` even if the var wasn't actually
// secret); false negatives leak. Conservative side.
// Single rule list: SECRET_ENV_NAME_CORES is the canonical set of
// env-var-name fragments that mark a secret. Both the SECRET_ENV_NAME
// regex (consumer here) and tests/property/sanitization-properties.test.mjs's
// I1 generator (consumer there) derive from this one list. Adding a
// new core fragment updates both via one edit; the round-5 mirroring
// class (regex anchor vs. generator core list) is now structurally
// closed.
export const SECRET_ENV_NAME_CORES = Object.freeze([
  "API_KEY",
  "TOKEN",
  "ACCESS_KEY",
  "PASSWORD",
  "SECRET",
  "ADMIN_KEY",
  "COOKIE",
  "SESSION",
  "SSO",
]);

const SECRET_ENV_NAME = new RegExp(
  `(?:^|_)(?:${SECRET_ENV_NAME_CORES.join("|")})(?:_|$)`,
  "i",
);

// Default minimum length thresholds (mirror api-reviewer.mjs).
const MIN_SECRET_REDACTION_LENGTH_AUTO = 8;        // auto-detected env names
const MIN_SECRET_REDACTION_LENGTH_CURATED = 4;     // operator-curated env_keys

// Common public-prefix shapes. Match-anywhere even if the env value isn't
// in process.env at sanitize time. Conservative default; lets us scrub
// echo-attacks where the provider response includes a hardcoded test key.
export const SECRET_PREFIX_PATTERNS = Object.freeze([
  /sk-[a-zA-Z\d]{20,}/g,                     // OpenAI / Anthropic style
  /sk-or-v\d+-[a-zA-Z\d]{20,}/g,             // OpenRouter
  /sk-ant-api\d+-[a-zA-Z\d_-]{20,}/g,        // Anthropic prefixed
  /AKIA[0-9A-Z]{16}/g,                       // AWS access key
  /AIza[0-9A-Za-z_-]{35}/g,                  // Google API key
  /glpat-[a-zA-Z0-9_-]{20,}/g,               // GitLab personal access token
  /gh[pousr]_[a-zA-Z0-9]{36}/g,              // GitHub token (PAT / OAuth / server / refresh)
  /github_pat_\w{20,}/g,                     // GitHub fine-grained PAT
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT
]);

const URL_ENCODED_CANDIDATE = /(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9._~!$'()*+,;-]){8,}/g;

function tryDecodeURIComponent(value) {
  if (typeof value !== "string" || !value.includes("%")) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function tryDecodeFormComponent(value) {
  if (typeof value !== "string" || !value.includes("+")) return null;
  try {
    return decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return null;
  }
}

function matchesSecretPrefix(value) {
  if (typeof value !== "string" || !value) return false;
  for (const pattern of SECRET_PREFIX_PATTERNS) {
    // Reset lastIndex; SECRET_PREFIX_PATTERNS use the /g flag.
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

function isMaskedTailChar(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === "_" ||
    char === "-"
  );
}

function isAsciiWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function skipAsciiWhitespace(value, cursor) {
  let next = cursor;
  while (next < value.length && isAsciiWhitespace(value[next])) next += 1;
  return next;
}

function scanRepeatedChar(value, cursor, char) {
  let next = cursor;
  while (value[next] === char) next += 1;
  return next;
}

function scanMaskedTail(value, cursor) {
  let next = cursor;
  while (isMaskedTailChar(value[next])) next += 1;
  return next;
}

function findMaskedApiKeySpan(value, label, searchFrom) {
  const index = value.toLowerCase().indexOf(label, searchFrom);
  if (index === -1) return null;

  const start = skipAsciiWhitespace(value, index + label.length);
  const starsEnd = scanRepeatedChar(value, start, "*");
  if (starsEnd - start < 2) return { index, redact: false, next: Math.max(start + 1, starsEnd) };

  const end = scanMaskedTail(value, starsEnd);
  if (end - starsEnd < 2) return { index, redact: false, next: Math.max(starsEnd + 1, end) };

  return { start, end, redact: true };
}

function redactMaskedApiKeyTails(input) {
  let out = String(input ?? "");
  for (const label of MASKED_API_KEY_LABELS) {
    let searchFrom = 0;
    while (searchFrom < out.length) {
      const span = findMaskedApiKeySpan(out, label, searchFrom);
      if (span == null) break;
      if (!span.redact) {
        searchFrom = span.next;
        continue;
      }
      out = `${out.slice(0, span.start)}${REDACTED}${out.slice(span.end)}`;
      searchFrom = span.start + REDACTED.length;
    }
  }
  return out;
}

function redactUrlEncodedCandidates(input, shouldRedactDecoded) {
  if (!input.includes("%") && !input.includes("+")) return input;
  return input.replaceAll(URL_ENCODED_CANDIDATE, (candidate) => {
    const decoded = tryDecodeURIComponent(candidate);
    if (decoded != null && shouldRedactDecoded(decoded)) return REDACTED;
    const formDecoded = tryDecodeFormComponent(candidate);
    if (formDecoded != null && shouldRedactDecoded(formDecoded)) return REDACTED;
    return candidate;
  });
}

// Authorization-header patterns. Two surfaces:
//   1. Bare HTTP form: "Authorization: Bearer xyz" (stderr / log lines).
//   2. JSON-quoted form: "\"Authorization\":\"Bearer xyz\"" (provider error
//      bodies that echo the original request as JSON).
// Without the JSON-quoted form, non-Bearer schemes (Basic, ApiKey, Token,
// Digest) embedded in echoed request bodies leak past sanitization because
// the literal "Authorization:" substring never appears — the JSON form is
// "Authorization":, with a quote before the colon.
//
// The JSON value pattern allows JSON escape sequences inside the value
// (e.g. `\"` in Digest's `realm=\"example\"`). A naive `[^"]*` would stop
// at the first escaped quote and leak everything after it.
const AUTHORIZATION_HEADER_BARE = /Authorization:\s*\S.*$/gim;
const AUTHORIZATION_HEADER_JSON = /"Authorization"\s*:\s*"(?:[^"\\]|\\.)*"/gi;
const AUTHORIZATION_HEADER_SINGLE_QUOTED = /'Authorization'\s*:\s*'(?:[^'\\]|\\.)*'/gi;
const MASKED_API_KEY_LABELS = Object.freeze(["api key:", "api_key:", "api-key:"]);
// Bearer-token match stops at JSON syntax so a token embedded in a JSON
// string ('{"auth":"Bearer xyz"}') doesn't have its closing quote/brace
// consumed by a greedy \S+. Excludes whitespace, ASCII quotes, JSON
// delimiters, and backslash.
const BEARER_TOKEN = /Bearer\s+[^\s"',;:()<>}\]\\]+/gi;

// Companion session-id field names. Both snake_case and camelCase variants —
// providers vary. Replaced wholesale with REDACTED when architecture is
// "companion".
export const COMPANION_SESSION_ID_FIELDS = Object.freeze([
  "claude_session_id",
  "gemini_session_id",
  "kimi_session_id",
  "claudeSessionId",
  "geminiSessionId",
  "kimiSessionId",
]);

// Field names that ALWAYS get redacted when present, regardless of
// architecture and value type. snake_case + camelCase.
export const ALWAYS_REDACT_STRING_FIELDS = Object.freeze([
  "session_id",
  "request_id",
  "sessionId",
  "requestId",
]);

// Fields that are sanitized as strings (path scrub, env-secret redaction)
// but kept rather than replaced wholesale.
const ALWAYS_SANITIZE_FIELDS = Object.freeze([
  "cwd",          // absolute paths reveal /Users/<name>
  "workspace_root",
  "endpoint",     // api-reviewers: contains base URL; defensively sanitized
]);

// User-home path patterns. macOS, Linux, Windows. Matched values are
// replaced with the literal "<user>" placeholder so fixture diffs stay
// stable across CI hosts.
//
// Username segment allows internal spaces (real macOS usernames can
// contain them — e.g., "John Doe"). The character class stops at:
//   /  — next path segment
//   "  '  — JSON / quoted-string boundary
//   \  — Windows path separator and JSON escape
//   \n \r \t  — line terminator / tab (these end log lines or
//                indicate the username segment is over even without
//                a closing /)
// Allowing only spaces inside the segment keeps the regex bounded
// while still scrubbing space-containing usernames in full.
// Single rule table: both PATH_SCRUB_PATTERNS (used by the redactor)
// and PATH_SCRUB_PROBES (used by tests/unit/fixture-validity.test.mjs to
// detect path leaks in committed fixtures) derive from this one list.
// Adding a new platform requires editing one row; the redactor and the
// validity test both pick up the change automatically. (Round-9
// systematic fix: prevents the cross-module-contract drift class.)
//
// Each rule's prefixSource and userClass are regex-source strings. The
// prefixLiteral is the literal form used in test diagnostics.
const PATH_SCRUB_RULES = Object.freeze([
  {
    prefixSource: "\\/Users\\/",
    prefixLiteral: "/Users/",
    userClass: "[^/\"'\\\\\\n\\r\\t]+",
    replacement: "/Users/<user>",
  },
  {
    prefixSource: "\\/home\\/",
    prefixLiteral: "/home/",
    userClass: "[^/\"'\\\\\\n\\r\\t]+",
    replacement: "/home/<user>",
  },
  {
    prefixSource: "\\/root\\/",
    prefixLiteral: "/root/",
    userClass: "[^/\"'\\\\\\n\\r\\t]+",
    replacement: "/root/<user>",
  },
  {
    prefixSource: "\\/var\\/folders\\/[A-Za-z0-9]{2}\\/",
    prefixLiteral: "/var/folders/",
    userClass: "[^/\"'\\\\\\n\\r\\t]+",
    replacement: "/var/folders/<user>",
  },
  {
    prefixSource: "[A-Za-z]:\\\\Users\\\\",
    prefixLiteral: "C:\\Users\\",
    userClass: "[^\\\\\"'/\\n\\r\\t]+",
    replacement: "C:\\Users\\<user>",
  },
]);

const PATH_SCRUB_PATTERNS = Object.freeze(
  PATH_SCRUB_RULES.map((rule) => ({
    regex: new RegExp(rule.prefixSource + rule.userClass, "g"),
    replacement: rule.replacement,
  })),
);

// Probes carry a capture group around the userClass so callers can
// extract the leaked username for diagnostic messages.
export const PATH_SCRUB_PROBES = Object.freeze(
  PATH_SCRUB_RULES.map((rule) => ({
    regex: new RegExp(rule.prefixSource + "(" + rule.userClass + ")", "g"),
    prefix: rule.prefixLiteral,
  })),
);

// Cookie-style env value sub-extraction (I17). For env keys ending in
// COOKIE/SESSION/SSO, the value typically contains semicolon-delimited
// attributes ("sso=eyJ...; Domain=x.com; Path=/"). Each '=' RHS at
// least 4 chars long is added to the redaction set so a fixture echoing
// just the inner SSO token without the surrounding cookie syntax still
// gets scrubbed.
const COOKIE_LIKE_ENV_NAME = /(?:^|_)(?:COOKIE|SESSION|SSO)$/i;
const COOKIE_LIKE_SECRET_ATTR_NAME = /(?:^|[_-])(?:AUTH|BEARER|COOKIE|KEY|SECRET|SESSION|SSO|TOKEN)(?:[_-]|$)/i;

class SanitizeMarkerCollision extends Error {
  constructor(detail) {
    super(`fixture-sanitization: input contains the redaction marker — ${detail}`);
    this.name = "SanitizeMarkerCollision";
  }
}

class SanitizeUnsupportedInput extends Error {
  constructor(detail) {
    super(`fixture-sanitization: input is not JSON-compatible — ${detail}`);
    this.name = "SanitizeUnsupportedInput";
  }
}

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

  function addSecret(value, minLen) {
    if (!value || value.length < minLen) return;
    if (value.includes(REDACTED)) {
      throw new SanitizeMarkerCollision(
        `env-secret value contains the literal "${REDACTED}" sentinel`,
      );
    }
    secrets.add(value);
    // I14 — also redact percent-encoded form. Skipped if encoding is
    // identity (no special chars) since duplicate entries don't harm
    // correctness but waste set capacity.
    let encoded;
    try {
      encoded = encodeURIComponent(value);
    } catch {
      encoded = value;
    }
    if (encoded !== value && !encoded.includes(REDACTED)) {
      secrets.add(encoded);
    }
    const formEncoded = encoded.replaceAll("%20", "+");
    if (formEncoded !== value && !formEncoded.includes(REDACTED)) {
      secrets.add(formEncoded);
    }
  }

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
    addSecret(value, minLen);
    // I17 — sub-extraction for cookie/SSO/SESSION values. Whole-value
    // redaction is preserved; we additionally extract semicolon/equals
    // sub-values so a fixture echoing only "sso=<token>" gets caught.
    if (COOKIE_LIKE_ENV_NAME.test(upperKey)) {
      for (const segment of value.split(";")) {
        const trimmed = segment.trim();
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const lhs = trimmed.slice(0, eq).trim();
        if (!COOKIE_LIKE_SECRET_ATTR_NAME.test(lhs)) continue;
        const rhs = trimmed.slice(eq + 1).trim();
        addSecret(rhs, MIN_SECRET_REDACTION_LENGTH_CURATED);
      }
    }
  }

  // Sort by length descending so longer secrets are replaced first. Without
  // this, if env had MY_TOKEN=abc123 and MY_TOKEN_LONG=abc123_extra, replacing
  // abc123 first would leave the trailing _extra of the longer token exposed.
  const sortedSecrets = [...secrets].sort((a, b) => b.length - a.length);

  return function redactEnvSecrets(input) {
    let out = String(input ?? "");
    for (const secret of sortedSecrets) {
      // Use split/join for literal replacement (no regex injection risk).
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    out = redactUrlEncodedCandidates(out, (decoded) => sortedSecrets.some((secret) => decoded.includes(secret)));
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
    out = out.replaceAll(pattern, REDACTED);
  }
  out = redactUrlEncodedCandidates(out, matchesSecretPrefix);
  out = out.replaceAll(AUTHORIZATION_HEADER_BARE, `Authorization: ${REDACTED}`);
  out = out.replaceAll(AUTHORIZATION_HEADER_JSON, `"Authorization":"${REDACTED}"`);
  out = out.replaceAll(AUTHORIZATION_HEADER_SINGLE_QUOTED, `'Authorization':'${REDACTED}'`);
  out = redactMaskedApiKeyTails(out);
  out = out.replaceAll(BEARER_TOKEN, `Bearer ${REDACTED}`);
  for (const { regex, replacement } of PATH_SCRUB_PATTERNS) {
    out = out.replaceAll(regex, replacement);
  }
  return out;
}

/**
 * Apply both env-secret redaction and pattern redaction to a string.
 */
export function sanitizeString(input, redactEnvSecrets) {
  const original = String(input ?? "");
  if (!redactEnvSecrets) return redactKnownPatterns(original);
  const envThenKnown = redactKnownPatterns(redactEnvSecrets(original));
  const knownThenEnv = redactEnvSecrets(redactKnownPatterns(original));
  return knownThenEnv.length <= envThenKnown.length ? knownThenEnv : envThenKnown;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// I16(b) — input-domain enforcement. Throws on any value the redactor
// cannot reason about. Called before walking each branch.
function assertJsonCompatible(value, ctx, path) {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new SanitizeUnsupportedInput(
        `non-finite number at ${path || "(root)"}`,
      );
    }
    return;
  }
  if (t === "undefined") {
    throw new SanitizeUnsupportedInput(`undefined at ${path || "(root)"}`);
  }
  if (t === "bigint" || t === "symbol" || t === "function") {
    throw new SanitizeUnsupportedInput(`${t} at ${path || "(root)"}`);
  }
  if (ctx.seen.has(value)) {
    throw new SanitizeUnsupportedInput(`circular reference at ${path || "(root)"}`);
  }
  if (Array.isArray(value)) return;
  if (!isPlainObject(value)) {
    const ctorName = value && value.constructor ? value.constructor.name : "object";
    throw new SanitizeUnsupportedInput(
      `non-plain object (${ctorName}) at ${path || "(root)"}`,
    );
  }
}

// I12 — sentinel safety. Called for every input string-leaf and every
// object key. Throws if the literal redaction marker appears.
function assertNoMarker(str, where) {
  if (typeof str === "string" && str.includes(REDACTED)) {
    throw new SanitizeMarkerCollision(
      `${where} contains the literal "${REDACTED}" sentinel`,
    );
  }
}

/**
 * Recursively walk a value, applying string sanitization and
 * field-level scrubs based on architecture.
 *
 * @param {*} value
 * @param {object} ctx
 * @param {(s: string) => string} ctx.redactEnvSecrets
 * @param {"companion"|"grok"|"api-reviewers"} ctx.architecture
 * @param {WeakSet}   ctx.seen   Cycle-detection set.
 * @param {(value: string) => boolean} ctx.matchesPrefixShape
 * @param {(value: string) => boolean} ctx.matchesEnvSecret
 */
function sanitizeValue(value, ctx, path) {
  assertJsonCompatible(value, ctx, path);
  if (value === null) return value;
  if (typeof value === "string") {
    assertNoMarker(value, `string at ${path || "(root)"}`);
    return sanitizeString(value, ctx.redactEnvSecrets);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    ctx.seen.add(value);
    try {
      return value.map((item, i) => sanitizeValue(item, ctx, `${path}[${i}]`));
    } finally {
      ctx.seen.delete(value);
    }
  }
  // Plain object.
  ctx.seen.add(value);
  try {
    return sanitizeObject(value, ctx, path);
  } finally {
    ctx.seen.delete(value);
  }
}

function sanitizeObject(value, ctx, path) {
  const out = {};
  for (const [key, sub] of Object.entries(value)) {
    assertNoMarker(key, `object key at ${path || "(root)"}`);
    const keyPath = `${path}.${key}`;
    // I15 — secret-shaped keys are redacted to the marker. Match the
    // SAME conditions used for values: prefix-shaped tokens, or env-
    // secret literals at the appropriate length threshold.
    const sanitizedKey = ctx.shouldRedactKey(key) ? REDACTED : key;
    if (Object.prototype.hasOwnProperty.call(out, sanitizedKey)) {
      throw new Error(
        `fixture-sanitization: redacted object key collision at ${path || "(root)"}; `
        + "multiple input keys sanitize to the same output key",
      );
    }
    out[sanitizedKey] = sanitizeObjectField(key, sub, ctx, keyPath);
  }
  return out;
}

function sanitizeObjectField(key, sub, ctx, path) {
  if (
    (ctx.architecture === "companion" && COMPANION_SESSION_ID_FIELDS.includes(key))
    || ALWAYS_REDACT_STRING_FIELDS.includes(key)
  ) {
    // wholesaleRedact still walks structure to enforce I12/I16, but
    // discards the result. We need to validate the input domain even
    // when redacting wholesale, otherwise a Date/Map/cycle planted under
    // a redacted key would slip past I16.
    if (sub && typeof sub === "object") sanitizeValue(sub, ctx, path);
    else if (typeof sub === "string") assertNoMarker(sub, `string at ${path}`);
    return wholesaleRedact(sub);
  }
  if (ALWAYS_SANITIZE_FIELDS.includes(key) && typeof sub === "string") {
    assertNoMarker(sub, `string at ${path}`);
    return sanitizeString(sub, ctx.redactEnvSecrets);
  }
  return sanitizeValue(sub, ctx, path);
}

// Identity-linked fields are redacted in full regardless of value type. A
// provider that returns session_id or claude_session_id as an object instead
// of a string must not leak structure or content. null stays null so the
// fixture's "field-was-absent" semantics survive.
function wholesaleRedact(value) {
  return value == null ? null : REDACTED;
}

/**
 * Sanitize a recorded provider response for fixture commit.
 *
 * @param {*} record  The recorded response object (will be deep-cloned).
 * @param {object} options
 * @param {"companion"|"grok"|"api-reviewers"} options.architecture
 * @param {object} options.env              Explicit env-name/value map.
 * @param {string[]} [options.curatedEnvKeys]  api-reviewers cfg.env_keys list.
 * @returns {*}  A deep-cloned, sanitized copy of `record`.
 */
export function sanitize(record, options = {}) {
  const architecture = options.architecture;
  if (!architecture || !ARCHITECTURE_KINDS.includes(architecture)) {
    throw new Error(
      "fixture-sanitization: options.architecture must be one of "
      + ARCHITECTURE_KINDS.map((kind) => JSON.stringify(kind)).join(", "),
    );
  }
  if (!Object.prototype.hasOwnProperty.call(options, "env")
      || !options.env
      || typeof options.env !== "object") {
    throw new Error("fixture-sanitization: options.env is required");
  }
  const env = options.env;
  const curatedEnvKeys = options.curatedEnvKeys ?? [];
  const redactEnvSecrets = buildEnvSecretRedactor(env, { curatedEnvKeys });

  // Build the key-redaction predicate. A key is redacted if it matches a
  // public-prefix-shaped token (I2 applied to keys) OR is itself a literal
  // env-secret value at the appropriate threshold (I1 applied to keys).
  const envSecretSet = new Set();
  const curatedSet = new Set(curatedEnvKeys.map((k) => String(k).toUpperCase()));
  for (const [k, rawV] of Object.entries(env ?? {})) {
    const v = String(rawV ?? "");
    if (!v) continue;
    const upper = k.toUpperCase();
    const isCurated = curatedSet.has(upper);
    const matchesAuto = SECRET_ENV_NAME.test(upper);
    if (!isCurated && !matchesAuto) continue;
    const minLen = isCurated
      ? MIN_SECRET_REDACTION_LENGTH_CURATED
      : MIN_SECRET_REDACTION_LENGTH_AUTO;
    if (v.length >= minLen) envSecretSet.add(v);
  }
  function shouldRedactKey(key) {
    if (typeof key !== "string" || !key) return false;
    if (envSecretSet.has(key)) return true;
    if (matchesSecretPrefix(key)) return true;
    const decoded = tryDecodeURIComponent(key);
    if (decoded != null) {
      if (envSecretSet.has(decoded)) return true;
      if (matchesSecretPrefix(decoded)) return true;
    }
    return false;
  }

  return sanitizeValue(record, {
    redactEnvSecrets,
    architecture,
    seen: new WeakSet(),
    shouldRedactKey,
  }, "");
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
    sanitization_notes: redactKnownPatterns(sanitizationNotes),
    recorded_by: redactKnownPatterns(recordedBy),
    stale_after: staleAfter,
  });
}

// Re-export constants so tests and the rerecord script can reference them
// without re-deriving.
export const FIXTURE_SANITIZATION_REDACTED_TOKEN = REDACTED;
export const FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR = MIN_SECRET_REDACTION_LENGTH_AUTO;
export const FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR = MIN_SECRET_REDACTION_LENGTH_CURATED;
