export const REDACTED = "[REDACTED]";
export const REDACTED_SOURCE_EXCERPT = "[redacted_source_excerpt]";

const MIN_CONFIGURED_SECRET_REDACTION_LENGTH = 4;
const MIN_ENV_SECRET_REDACTION_LENGTH = 8;
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY|PASSWORD|COOKIE|SESSION|SSO)(?:_|$)/i;
const ACCOUNT_PAYMENT_TOKEN_PATTERNS = Object.freeze([
  /\bstripe-[^\s,;:)]+/gi,
  /\bcus_[A-Za-z0-9]{6,}/gi,
  /\bacct_test_[A-Za-z0-9]{5,}/gi,
  /\bacct_[A-Za-z0-9]{5,}/gi,
  /\bcs_test_[A-Za-z0-9]{6,}/gi,
  /\bcs_live_[A-Za-z0-9]{6,}/gi,
]);
const PAYMENT_PREFIXED_TOKEN_RE = /\b(?:pi|sub|in|ii|ch|seti|setp|price|prod|iv)_([A-Za-z0-9]{5,})/gi;
const JWT_SHAPED_TOKEN_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PLAN_ID_RE = /\bplan_id=[^\s,;|)]+/gi;
const BEARER_RE = /\bBearer\s+[^\s,;|)]+/gi;
const TOKEN_RE = /\bToken\s+[^\s,;|)]+/gi;
const AUTHORIZATION_HEADER = "authorization:";

const MIN_SOURCE_MATCH_CHARS = 16;
const MAX_SOURCE_CONTIGUOUS_CHARS = 200;
const MAX_SOURCE_AGGREGATE_CHARS = 800;

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function isAsciiWordChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "_"
  );
}

function isHorizontalWhitespace(ch) {
  return ch === " " || ch === "\t";
}

function isAuthorizationTokenTerminator(ch) {
  return !ch || ch === "\n" || ch === "\r" || isHorizontalWhitespace(ch) || ch === "," || ch === ";" || ch === "|" || ch === ")";
}

function scanAuthorizationTokenEnd(value, cursor) {
  let index = cursor;
  while (index < value.length && !isAuthorizationTokenTerminator(value[index])) {
    index += 1;
  }
  return index;
}

function redactAuthorizationHeaders(value) {
  const lower = value.toLowerCase();
  let out = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = lower.indexOf(AUTHORIZATION_HEADER, cursor);
    if (start === -1) break;
    if (isAsciiWordChar(value[start - 1])) {
      out += value.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }

    let tokenStart = start + AUTHORIZATION_HEADER.length;
    while (isHorizontalWhitespace(value[tokenStart])) tokenStart += 1;
    if (tokenStart >= value.length || isAuthorizationTokenTerminator(value[tokenStart])) {
      out += value.slice(cursor, tokenStart);
      cursor = tokenStart;
      continue;
    }

    let tokenEnd = scanAuthorizationTokenEnd(value, tokenStart);
    const scheme = value.slice(tokenStart, tokenEnd).toLowerCase();
    if ((scheme === "bearer" || scheme === "token") && isHorizontalWhitespace(value[tokenEnd])) {
      let credentialStart = tokenEnd;
      while (isHorizontalWhitespace(value[credentialStart])) credentialStart += 1;
      if (credentialStart < value.length && !isAuthorizationTokenTerminator(value[credentialStart])) {
        tokenEnd = scanAuthorizationTokenEnd(value, credentialStart);
      }
    }

    out += `${value.slice(cursor, start)}Authorization: ${REDACTED}`;
    cursor = tokenEnd;
  }
  return out + value.slice(cursor);
}

function redactPaymentPrefixedToken(match, body) {
  return /\d/.test(body) ? REDACTED : match;
}

function redactAccountPaymentTokens(value) {
  let out = value;
  for (const pattern of ACCOUNT_PAYMENT_TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(PAYMENT_PREFIXED_TOKEN_RE, redactPaymentPrefixedToken);
}

function sourceText(file) {
  if (typeof file?.text === "string") return normalizeText(file.text);
  if (typeof file?.content === "string") return normalizeText(file.content);
  if (Buffer.isBuffer(file?.content)) return normalizeText(file.content.toString("utf8"));
  if (file?.content instanceof Uint8Array) return normalizeText(Buffer.from(file.content).toString("utf8"));
  return "";
}

function sourceExactVariants(sourceFiles = []) {
  const variants = new Set();
  for (const file of Array.isArray(sourceFiles) ? sourceFiles : []) {
    const text = sourceText(file);
    if (!text) continue;
    for (const candidate of [text, text.trimEnd()]) {
      if (candidate) variants.add(candidate);
    }
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

function sourceQuoteSources(sourceFiles = []) {
  const sources = [];
  const seen = new Set();
  for (const file of Array.isArray(sourceFiles) ? sourceFiles : []) {
    const text = sourceText(file);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    sources.push(text);
  }
  return sources;
}

function sourceMatchLength(text, cursor, source, minLength) {
  if (cursor + minLength > text.length || source.length < minLength) return 0;
  const seed = text.slice(cursor, cursor + minLength);
  let sourceIndex = source.indexOf(seed);
  if (sourceIndex === -1) return 0;
  let best = minLength;
  while (sourceIndex !== -1) {
    let length = minLength;
    while (
      cursor + length < text.length &&
      sourceIndex + length < source.length &&
      text[cursor + length] === source[sourceIndex + length]
    ) {
      length += 1;
    }
    best = Math.max(best, length);
    sourceIndex = source.indexOf(seed, sourceIndex + 1);
  }
  return best;
}

function sourceMatchLengthAcrossSources(text, cursor, sources) {
  let best = 0;
  for (const source of sources) {
    best = Math.max(best, sourceMatchLength(text, cursor, source, MIN_SOURCE_MATCH_CHARS));
  }
  return best;
}

function redactSourceExcerpts(text, sources, budget) {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const length = sourceMatchLengthAcrossSources(text, cursor, sources);
    if (length > MAX_SOURCE_CONTIGUOUS_CHARS) {
      out += REDACTED_SOURCE_EXCERPT;
      cursor += length;
    } else if (length > 0) {
      const quote = text.slice(cursor, cursor + length);
      if (budget.aggregateKept + length > MAX_SOURCE_AGGREGATE_CHARS) {
        out += REDACTED_SOURCE_EXCERPT;
      } else {
        out += quote;
        budget.aggregateKept += length;
      }
      cursor += length;
    } else {
      out += text[cursor];
      cursor += 1;
    }
  }
  return out;
}

function configuredSecrets(env, configuredSecretNames = []) {
  const names = new Set(Array.isArray(configuredSecretNames) ? configuredSecretNames : []);
  const values = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const isConfigured = names.has(key);
    if (!isConfigured && !SECRET_ENV_NAME.test(key)) continue;
    const minLength = isConfigured
      ? MIN_CONFIGURED_SECRET_REDACTION_LENGTH
      : MIN_ENV_SECRET_REDACTION_LENGTH;
    if (typeof value !== "string" || value.length < minLength) continue;
    values.push(value);
    if (value.includes(";")) {
      for (const part of value.split(";").map((item) => item.trim()).filter(Boolean)) {
        values.push(part);
        const [, cookieValue] = part.split("=");
        if (cookieValue) values.push(cookieValue.trim());
      }
    }
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function buildPrivacyRedactor({
  env = process.env,
  configuredSecretNames = [],
  sourceFiles = [],
} = {}) {
  const secrets = configuredSecrets(env, configuredSecretNames);
  const exactSourceVariants = sourceExactVariants(sourceFiles);
  const quoteSources = sourceQuoteSources(sourceFiles);
  const sourceBudget = { aggregateKept: 0 };

  function text(value) {
    let out = normalizeText(value);
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    out = redactAuthorizationHeaders(out);
    out = out.replace(BEARER_RE, "Bearer [REDACTED]");
    out = out.replace(TOKEN_RE, "Token [REDACTED]");
    out = out.replace(JWT_SHAPED_TOKEN_RE, REDACTED);
    out = redactAccountPaymentTokens(out);
    out = out.replace(PLAN_ID_RE, REDACTED);
    out = out.replace(EMAIL_RE, REDACTED);
    for (const source of exactSourceVariants) {
      out = out.split(source).join(REDACTED_SOURCE_EXCERPT);
    }
    return redactSourceExcerpts(out, quoteSources, sourceBudget);
  }

  function value(input) {
    if (input == null) return input;
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map((item) => value(item));
    if (typeof input === "object") {
      const out = {};
      for (const [key, sub] of Object.entries(input)) {
        Object.defineProperty(out, text(key), {
          value: value(sub),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    return input;
  }

  return Object.freeze({ text, value });
}
