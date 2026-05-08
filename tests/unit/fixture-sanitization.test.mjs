// Tests for scripts/lib/fixture-sanitization.mjs.
//
// The sanitization library is the security floor for fixture recording —
// any leak here ships the leaked credential into a committed fixture file
// where it survives indefinitely. These tests exercise the patterns named
// in docs/contracts/redaction.md plus session-id removal for companion
// architectures.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEnvSecretRedactor,
  buildProvenance,
  PATH_SCRUB_PROBES,
  redactKnownPatterns,
  sanitize,
  sanitizeString,
  COMPANION_SESSION_ID_FIELDS,
  FIXTURE_SANITIZATION_REDACTED_TOKEN,
  FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR,
  FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR,
  SECRET_ENV_NAME_CORES,
} from "../../scripts/lib/fixture-sanitization.mjs";

const REDACTED = FIXTURE_SANITIZATION_REDACTED_TOKEN;

test("constants: thresholds match docs/contracts/redaction.md", () => {
  assert.equal(FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR, 8);
  assert.equal(FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR, 4);
  assert.equal(REDACTED, "[REDACTED]");
});

test("buildEnvSecretRedactor: redacts auto-detected secret-name env values >=8 chars", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-api03-very-secret-value",
    GITHUB_TOKEN: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    USER_HOME: "harmless-non-secret-value",   // env name doesn't match secret pattern
  };
  const redact = buildEnvSecretRedactor(env);
  const input = "the key is sk-ant-api03-very-secret-value and token is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA but harmless-non-secret-value stays";
  const out = redact(input);
  assert.match(out, /\[REDACTED\]/);
  assert.equal(out.includes("sk-ant-api03-very-secret-value"), false);
  assert.equal(out.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
  assert.equal(out.includes("harmless-non-secret-value"), true,
    "non-secret-shaped env name (USER_HOME) is not in the secret-name regex, so its value passes through");
});

test("buildEnvSecretRedactor: under 8-char threshold, auto-detected env values are NOT redacted", () => {
  const env = {
    ANTHROPIC_API_KEY: "abc",  // too short to redact safely (one-byte collision risk)
  };
  const redact = buildEnvSecretRedactor(env);
  const out = redact("the abc letters appear in many words including alphabet");
  assert.equal(out.includes("abc"), true,
    "short auto-detected secrets must NOT be redacted (one-byte collision protection)");
});

test("buildEnvSecretRedactor: curated env_keys redact at 4-char floor", () => {
  const env = {
    DEEPSEEK_CREDENTIAL: "abcd",  // not auto-detected (no _API_KEY suffix), but listed as curated
  };
  const redact = buildEnvSecretRedactor(env, {
    curatedEnvKeys: ["DEEPSEEK_CREDENTIAL"],
  });
  const out = redact("token=abcd-rest-of-string");
  assert.equal(out.includes("abcd-"), false,
    "curated env value at 4 chars must be redacted");
  assert.match(out, /\[REDACTED\]/);
});

test("buildEnvSecretRedactor: curated below 4 chars is NOT redacted", () => {
  const env = {
    DEEPSEEK_CREDENTIAL: "abc",  // 3 chars, below curated floor of 4
  };
  const redact = buildEnvSecretRedactor(env, {
    curatedEnvKeys: ["DEEPSEEK_CREDENTIAL"],
  });
  const out = redact("the alphabet abc def");
  assert.equal(out.includes("abc"), true,
    "even curated env value below 4-char floor must NOT redact");
});

test("buildEnvSecretRedactor: redacts case-insensitive (COOKIE, Cookie, cookie)", () => {
  const env = {
    SOMETHING_COOKIE: "session-cookie-value-1234567890",
    Other_Token: "another-token-value-abcdef-12345",
    SSO_TOKEN: "sso-token-value-zzzzzzzz",
  };
  const redact = buildEnvSecretRedactor(env);
  const out = redact("vals: session-cookie-value-1234567890 and another-token-value-abcdef-12345 and sso-token-value-zzzzzzzz");
  assert.equal(out.includes("session-cookie-value"), false);
  assert.equal(out.includes("another-token-value"), false);
  assert.equal(out.includes("sso-token-value"), false);
});

test("buildEnvSecretRedactor: longer secret containing shorter secret as prefix is fully redacted", () => {
  // Regression test for the partial-redaction edge case: if env has both
  // a short secret and a longer secret that contains the short one as a
  // prefix, iterate-shortest-first would replace the prefix and leave the
  // tail of the longer secret exposed. Sort-by-length-desc fixes it.
  // Both env keys end in _TOKEN so auto-detect picks up both values.
  const env = {
    SHORT_TOKEN: "abc12345_secret",                  // 15 chars, auto-detected
    LONG_TOKEN:  "abc12345_secret_extra_tail",       // 26 chars, auto-detected
  };
  const redact = buildEnvSecretRedactor(env);
  const out = redact("the long token is abc12345_secret_extra_tail and the short one is abc12345_secret");
  assert.equal(out.includes("abc12345_secret"), false, "neither secret should appear in output");
  assert.equal(out.includes("_extra_tail"), false, "longer secret's tail must not leak past the shorter secret's redaction");
});

test("redactKnownPatterns: redacts OpenAI/Anthropic-style sk- keys", () => {
  const out = redactKnownPatterns("the value is sk-1234567890abcdefghijklmno and also sk-ant-api03-abcdef-ghijkl-1234567");
  assert.equal(out.includes("sk-1234567890"), false);
  assert.equal(out.includes("sk-ant-api03"), false);
  assert.match(out, /\[REDACTED\]/);
});

test("redactKnownPatterns: redacts OpenRouter sk-or-v* keys", () => {
  const out = redactKnownPatterns("OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.equal(out.includes("sk-or-v1-abcde"), false);
  assert.match(out, /\[REDACTED\]/);
});

test("redactKnownPatterns: redacts AWS access keys", () => {
  // AWS access keys are AKIA + 16 chars = 20 total.
  const out = redactKnownPatterns("AWS_ACCESS_KEY_ID=AKIAEXAMPLE12345678Q");
  assert.equal(out.includes("AKIAEXAMPLE12345678Q"), false);
  assert.match(out, /\[REDACTED\]/);
});

test("redactKnownPatterns: redacts Google AIza keys", () => {
  const out = redactKnownPatterns("GOOGLE_API_KEY=AIzaSyA-1234567890abcdefghijk_1234567890ZZ");
  assert.equal(out.includes("AIzaSyA-1234567890"), false);
  assert.match(out, /\[REDACTED\]/);
});

test("redactKnownPatterns: redacts GitHub PATs (ghp_, ghs_, github_pat_)", () => {
  const out = redactKnownPatterns([
    "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "github_pat_aaaaaaaaaaaaaaaaaaaa",
    "github_pat_aaaaaaaaaaaaaaaaaaaaaa",
  ].join(" "));
  assert.equal(out.includes("ghp_AAAA"), false);
  assert.equal(out.includes("ghs_BBBB"), false);
  assert.equal(out.includes("github_pat_aaaa"), false);
});

test("redactKnownPatterns: redacts JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const shortJwt = "eyJa.b.c";
  const out = redactKnownPatterns(`Bearer-style JWT: ${jwt} short ${shortJwt}`);
  assert.equal(out.includes("eyJhbGciOiJIUzI1NiIs"), false);
  assert.equal(out.includes(shortJwt), false);
});

test("sanitize: redacts percent-encoded public-prefix tokens in strings", () => {
  const encoded = `%73%6B-${"a".repeat(22)}`;
  const out = sanitize(
    `prefix ${encoded} suffix`,
    { architecture: "api-reviewers", env: {}, curatedEnvKeys: [] },
  );
  assert.equal(out.includes(encoded), false);
  assert.equal(out, `prefix ${REDACTED} suffix`);
});

test("sanitize: redacts percent-encoded public-prefix tokens without replacing whole URL", () => {
  const encoded = `%73%6B-${"a".repeat(22)}`;
  const out = sanitize(
    `http://example.com/path?q=foo%20bar&token=${encoded}&ok=1`,
    { architecture: "api-reviewers", env: {}, curatedEnvKeys: [] },
  );
  assert.equal(out, `http://example.com/path?q=foo%20bar&token=${REDACTED}&ok=1`);
});

test("sanitize: redacts percent-encoded public-prefix tokens in object keys", () => {
  const encoded = `%73%6B-${"a".repeat(22)}`;
  const out = sanitize(
    { [encoded]: "rate_limited" },
    { architecture: "api-reviewers", env: {}, curatedEnvKeys: [] },
  );
  assert.deepEqual(out, { [REDACTED]: "rate_limited" });
});

test("sanitize: rejects multiple redacted object keys instead of silently dropping entries", () => {
  assert.throws(
    () => sanitize(
      {
        "sk-abcdefghijklmnopqrstuvwxyz": "first",
        "sk-zyxwvutsrqponmlkjihgfedcba": "second",
      },
      { architecture: "api-reviewers", env: {}, curatedEnvKeys: [] },
    ),
    /redacted object key collision/i,
  );
});

test("redactKnownPatterns: redacts Authorization headers (any case)", () => {
  const out1 = redactKnownPatterns("Authorization: Bearer some-token-here-1234");
  const out2 = redactKnownPatterns("authorization: Basic dXNlcjpwYXNz");
  assert.match(out1, /Authorization: \[REDACTED\]/);
  assert.match(out2, /authorization: \[REDACTED\]/i);
});

test("redactKnownPatterns: redacts Bearer tokens (any case)", () => {
  const out = redactKnownPatterns("Sent header bearer eyJhBcDeF and also Bearer some-other-thing-here");
  assert.equal(out.includes("eyJhBcDeF"), false);
  assert.equal(out.includes("some-other-thing"), false);
});

test("redactKnownPatterns: scrubs macOS user-home leak", () => {
  const out = redactKnownPatterns("config at /Users/alice/.config/llm/secrets.json on /Users/bob/Projects/foo");
  assert.equal(out.includes("/Users/alice/"), false);
  assert.equal(out.includes("/Users/bob/"), false);
  assert.match(out, /\/Users\/<user>\/.config/);
});

test("sanitize: bare session_id field redacts across all architectures", () => {
  // Doctor/ping output uses bare "session_id" rather than provider-prefixed
  // claude_session_id/etc. These are still user-identity-linked and must
  // sanitize to [REDACTED] regardless of architecture.
  for (const arch of ["companion", "grok", "api-reviewers"]) {
    const record = {
      session_id: "b22d36b8-c2c4-4b6c-b386-67e9a3fdc8bc",
      ready: true,
    };
    const out = sanitize(record, { architecture: arch, env: {} });
    assert.equal(out.session_id, REDACTED,
      `${arch}: bare session_id must redact to [REDACTED]`);
    assert.equal(out.ready, true, `${arch}: non-secret fields preserved`);
  }
});

test("sanitize: bare request_id field redacts across all architectures", () => {
  const out = sanitize(
    { request_id: "req_abc-1234-5678", other: "fine" },
    { architecture: "api-reviewers", env: {} },
  );
  assert.equal(out.request_id, REDACTED);
  assert.equal(out.other, "fine");
});

test("sanitize: null session_id stays null", () => {
  const out = sanitize(
    { session_id: null, request_id: null },
    { architecture: "grok", env: {} },
  );
  assert.equal(out.session_id, null);
  assert.equal(out.request_id, null);
});

test("sanitize: companion architecture redacts session-id fields", () => {
  const record = {
    job_id: "11111111-2222-4333-8444-555555555555",
    target: "claude",
    claude_session_id: "real-session-uuid",
    gemini_session_id: null,
    kimi_session_id: null,
    result: "review verdict approved",
    cwd: "/Users/spson/Projects/foo",
  };
  const out = sanitize(record, { architecture: "companion", env: {} });
  assert.equal(out.claude_session_id, REDACTED,
    "non-null session id must be replaced");
  assert.equal(out.gemini_session_id, null,
    "null session id stays null");
  assert.equal(out.kimi_session_id, null);
  assert.equal(out.result, "review verdict approved",
    "non-secret content survives");
  assert.equal(out.cwd, "/Users/<user>/Projects/foo",
    "absolute home path scrubbed");
  assert.equal(out.job_id, "11111111-2222-4333-8444-555555555555",
    "non-secret job_id survives");
});

test("sanitize: companion session-id field contract includes snake_case and camelCase names", () => {
  assert.deepEqual(COMPANION_SESSION_ID_FIELDS, Object.freeze([
    "claude_session_id",
    "gemini_session_id",
    "kimi_session_id",
    "claudeSessionId",
    "geminiSessionId",
    "kimiSessionId",
  ]));
  const out = sanitize({
    claudeSessionId: "camel-claude-session",
    geminiSessionId: "camel-gemini-session",
    kimiSessionId: "camel-kimi-session",
  }, { architecture: "companion", env: {} });
  assert.equal(out.claudeSessionId, REDACTED);
  assert.equal(out.geminiSessionId, REDACTED);
  assert.equal(out.kimiSessionId, REDACTED);
});

test("sanitize: grok architecture preserves session-id fields (not present in grok records)", () => {
  const record = {
    job_id: "11111111-2222-4333-8444-555555555555",
    target: "grok-web",
    status: "completed",
    result: "ok",
  };
  const out = sanitize(record, { architecture: "grok", env: {} });
  assert.equal(out.job_id, record.job_id);
  assert.equal(out.result, "ok");
});

test("sanitize: api-reviewers architecture honors curatedEnvKeys", () => {
  const record = {
    job_id: "11111111-2222-4333-8444-555555555555",
    target: "deepseek",
    result: "the user gave their key=abcd and also a longer-curated-token-12345",
  };
  const out = sanitize(record, {
    architecture: "api-reviewers",
    env: {
      DEEPSEEK_API_KEY: "abcd",                               // 4 chars curated
      DEEPSEEK_OTHER_NAME: "longer-curated-token-12345",      // not auto-detected
    },
    curatedEnvKeys: ["DEEPSEEK_API_KEY", "DEEPSEEK_OTHER_NAME"],
  });
  assert.equal(out.result.includes("key=abcd"), false,
    "curated 4-char key redacted");
  assert.equal(out.result.includes("longer-curated-token-12345"), false,
    "curated longer key redacted");
});

test("sanitize: deeply nested objects and arrays are recursively sanitized", () => {
  const record = {
    nested: {
      array: [
        { jwt: "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" },
        "Authorization: Bearer xyz-secret-123",
      ],
      authorization_field: "Bearer some-deeply-nested-token-9999",
    },
  };
  const out = sanitize(record, { architecture: "grok", env: {} });
  const json = JSON.stringify(out);
  assert.equal(json.includes("eyJhbGciOiJIUzI1NiIs"), false);
  assert.equal(json.includes("xyz-secret-123"), false);
  assert.equal(json.includes("some-deeply-nested-token"), false);
});

test("sanitize: rejects unknown architecture", () => {
  assert.throws(
    () => sanitize({}, { architecture: "frontend", env: {} }),
    /architecture must be one of/,
  );
});

test("sanitize: requires explicit env map", () => {
  assert.throws(
    () => sanitize({}, { architecture: "companion" }),
    /options\.env is required/,
  );
  assert.throws(
    () => sanitize({}, { architecture: "companion", env: null }),
    /options\.env is required/,
  );
});

test("sanitize: returns deep-cloned object (caller can't mutate input via output)", () => {
  const record = {
    job_id: "abc",
    nested: { x: 1 },
  };
  const out = sanitize(record, { architecture: "grok", env: {} });
  out.nested.x = 999;
  assert.equal(record.nested.x, 1, "input must not be mutated by output mutation");
});

test("sanitize: preserves null and primitive values", () => {
  const record = {
    null_field: null,
    bool_field: true,
    num_field: 42,
    string_field: "ordinary text",
  };
  const out = sanitize(record, { architecture: "companion", env: {} });
  assert.equal(out.null_field, null);
  assert.equal(out.bool_field, true);
  assert.equal(out.num_field, 42);
  assert.equal(out.string_field, "ordinary text");
});

test("sanitizeString: applies env-redactor + known-patterns", () => {
  const env = { GROK_SESSION: "the-secret-grok-session-value" };
  const redact = buildEnvSecretRedactor(env);
  const out = sanitizeString(
    "session=the-secret-grok-session-value and apiKey=sk-1234567890abcdefghijklmno",
    redact,
  );
  assert.equal(out.includes("the-secret-grok-session-value"), false);
  assert.equal(out.includes("sk-1234567890"), false);
});

test("buildProvenance: generates schema-conformant record", () => {
  const out = buildProvenance({
    modelId: "claude-opus-4-7",
    promptHash: "abc123def456",
    sanitizationNotes: "redacted: api_key, oauth_token, session-id",
    recordedBy: "manual: workflow_dispatch run #42",
    recordedAt: "2026-05-06T12:00:00.000Z",
    staleAfterDays: 90,
  });
  assert.equal(out.model_id, "claude-opus-4-7");
  assert.equal(out.prompt_hash, "sha256:abc123def456");
  assert.equal(out.recorded_at, "2026-05-06T12:00:00.000Z");
  assert.equal(out.stale_after, "2026-08-04T12:00:00.000Z",
    "stale_after = recorded_at + 90 days");
  assert.equal(out.recorded_by, "manual: workflow_dispatch run #42");
  assert.equal(Object.isFrozen(out), true);
});

test("buildProvenance: prompt_hash already prefixed sha256: is not double-prefixed", () => {
  const out = buildProvenance({
    modelId: "x",
    promptHash: "sha256:already-prefixed",
    sanitizationNotes: "n",
    recordedBy: "r",
  });
  assert.equal(out.prompt_hash, "sha256:already-prefixed");
});

test("buildProvenance: requires all mandatory fields", () => {
  assert.throws(() => buildProvenance({}), /modelId is required/);
  assert.throws(
    () => buildProvenance({ modelId: "x" }),
    /promptHash is required/,
  );
  assert.throws(
    () => buildProvenance({ modelId: "x", promptHash: "y" }),
    /sanitizationNotes is required/,
  );
  assert.throws(
    () => buildProvenance({ modelId: "x", promptHash: "y", sanitizationNotes: "n" }),
    /recordedBy is required/,
  );
});

// Regression: the original AUTHORIZATION_HEADER regex required a literal
// "Authorization:" substring. JSON serialization of headers produces
// "Authorization":, with a quote between the field name and the colon, so
// non-Bearer auth schemes (Basic, ApiKey, Token) embedded in echoed request
// bodies leaked past sanitize(). The Bearer regex caught its own scheme via
// a separate pattern but missed the rest. The fix scans both the bare HTTP
// form and the JSON-quoted form.
test("redactKnownPatterns: redacts JSON-quoted Authorization (Basic, ApiKey, Token)", () => {
  const cases = [
    { input: '{"headers":{"Authorization":"Basic dGVzdDp0ZXN0"}}', leak: "dGVzdDp0ZXN0" },
    { input: '{"headers":{"Authorization":"ApiKey abcd1234567890"}}', leak: "abcd1234567890" },
    { input: '{"headers":{"Authorization":"Token deadbeef-9876"}}', leak: "deadbeef-9876" },
    { input: '{"Authorization":"Negotiate YII..."}',                  leak: "YII..." },
  ];
  for (const c of cases) {
    const out = redactKnownPatterns(c.input);
    assert.equal(out.includes(c.leak), false,
      `JSON-quoted Authorization must redact value; input=${c.input} output=${out}`);
    assert.match(out, /"Authorization":"\[REDACTED\]"/i);
  }
});

test("redactKnownPatterns: redacts single-quoted Authorization echo bodies", () => {
  const out = redactKnownPatterns("{'Authorization':'Basic dGVzdDp0ZXN0','x':1}");
  assert.equal(out, "{'Authorization':'[REDACTED]','x':1}");
  assert.doesNotMatch(out, /dGVzdDp0ZXN0/);
});

test("redactKnownPatterns: preserves closing paren after Bearer token redaction", () => {
  const out = redactKnownPatterns("(Bearer abc123xyz) next");
  assert.equal(out, "(Bearer [REDACTED]) next");
});

test("redactKnownPatterns: scrubs root and macOS per-user temp paths", () => {
  const out = redactKnownPatterns([
    "/root/worktree/foo",
    "/var/folders/y5/syb9vj4n3l10028h1jst4_tm0000gn/T/claude-worktree-JAc2KX",
  ].join("\n"));
  assert.match(out, /\/root\/<user>\/foo/);
  assert.match(out, /\/var\/folders\/<user>\/T\/claude-worktree-JAc2KX/);
  assert.doesNotMatch(out, /syb9vj4n3l10028h1jst4_tm0000gn/);
});

test("PATH_SCRUB_PROBES include root and macOS per-user temp paths", () => {
  const probes = PATH_SCRUB_PROBES.map((probe) => probe.prefix);
  assert.ok(probes.includes("/root/"));
  assert.ok(probes.includes("/var/folders/"));
});

test("buildEnvSecretRedactor: PASSWORD env names are auto-redacted", () => {
  assert.ok(SECRET_ENV_NAME_CORES.includes("PASSWORD"));
  const redact = buildEnvSecretRedactor({ DB_PASSWORD: "hunter2secret" });
  assert.equal(redact("hello hunter2secret"), "hello [REDACTED]");
});

test("buildEnvSecretRedactor: cookie sub-extraction ignores non-secret attributes", () => {
  const redact = buildEnvSecretRedactor({
    APP_COOKIE: "theme=dark; Path=/; session=abcdef123456",
  });
  assert.equal(redact("theme dark path / session abcdef123456"), "theme dark path / session [REDACTED]");
});

test("buildEnvSecretRedactor: cookie sub-extraction redacts hyphenated secret attributes", () => {
  const redact = buildEnvSecretRedactor({
    APP_COOKIE: "session-id=abcdef123456; auth-token=ghijkl789012; theme=dark",
  });
  assert.equal(redact("abcdef123456 ghijkl789012 dark"), "[REDACTED] [REDACTED] dark");
});

test("sanitize: JSON-quoted Authorization in echoed error body redacts non-Bearer schemes", () => {
  const record = {
    error_body: '{"error":"unauthorized","echoed_request":{"headers":{"Authorization":"Basic dGVzdDp0ZXN0"}}}',
  };
  const out = sanitize(record, { architecture: "api-reviewers", env: {} });
  assert.equal(out.error_body.includes("dGVzdDp0ZXN0"), false,
    "Basic auth credential embedded in echoed JSON body must not leak past sanitize()");
  assert.match(out.error_body, /"Authorization":"\[REDACTED\]"/);
});

// Regression: a naive `[^"]*` body would stop at the first JSON-escaped
// quote, leaving Digest auth values (which contain `\"realm=\"example\"\"`
// after JSON serialization) partially exposed. The fix uses
// `(?:[^"\\]|\\.)*` so escape sequences are consumed.
test("redactKnownPatterns: JSON-quoted Authorization with internal escaped quotes (Digest auth)", () => {
  const inputs = [
    // Digest auth typical shape after JSON serialization
    '{"Authorization":"Digest username=\\"alice\\", realm=\\"example.com\\", nonce=\\"abc123\\""}',
    // Bearer with JWT containing an internal escaped quote inside an inner
    // structure (rare but possible in echoed payloads)
    '{"Authorization":"Bearer eyJhbGciOi.\\"escaped\\".sig"}',
  ];
  for (const input of inputs) {
    const out = redactKnownPatterns(input);
    assert.equal(out.includes("alice"), false, `Digest username must not leak; out=${out}`);
    assert.equal(out.includes("example.com"), false, `Digest realm must not leak; out=${out}`);
    assert.equal(out.includes("abc123"), false, `Digest nonce must not leak; out=${out}`);
    assert.equal(out.includes("eyJhbGciOi"), false, `Bearer JWT must not leak; out=${out}`);
    assert.match(out, /"Authorization":"\[REDACTED\]"/,
      `redacted form must replace the entire JSON-quoted value; out=${out}`);
  }
});

// Regression: Bearer\s+\S+ greedily ate trailing JSON syntax (closing quote,
// brace, bracket, comma) when the token was embedded in a JSON-stringified
// blob. Secret was redacted but the surrounding structure was corrupted.
test("redactKnownPatterns: Bearer match stops at JSON syntax (does not eat closing tokens)", () => {
  const cases = [
    {
      input: 'request was: {"auth":"Bearer sk-abc1234567890"} - failed',
      preserve: '"} - failed',
      leak: "sk-abc1234567890",
    },
    {
      input: '["Bearer xyz-abc-12345","next-element"]',
      preserve: '","next-element"]',
      leak: "xyz-abc-12345",
    },
    {
      input: '{"a":"Bearer one-two-three","b":"two"}',
      preserve: '","b":"two"}',
      leak: "one-two-three",
    },
  ];
  for (const c of cases) {
    const out = redactKnownPatterns(c.input);
    assert.equal(out.includes(c.preserve), true,
      `Bearer redactor must preserve trailing JSON syntax; input=${c.input} output=${out}`);
    assert.equal(out.includes(c.leak), false,
      `Bearer redactor must still remove the secret; input=${c.input}`);
  }
});

// Regression: companion *_session_id fields previously coerced any non-null
// value to the literal string "[REDACTED]", flattening object/array shape.
// The bare ALWAYS_REDACT_STRING_FIELDS path went the opposite direction —
// recursing into non-strings and leaving structured PII intact. Both paths
// now redact wholesale: any non-null value becomes "[REDACTED]".
test("sanitize: companion session_id with non-string value redacts wholesale", () => {
  const cases = [
    { field: "claude_session_id", value: { id: "abc", trace_id: "deadbeef" }, label: "object" },
    { field: "gemini_session_id", value: ["a-1", "b-2"], label: "array" },
    { field: "kimi_session_id", value: 42, label: "number" },
    { field: "claude_session_id", value: true, label: "boolean" },
  ];
  for (const c of cases) {
    const out = sanitize(
      { [c.field]: c.value },
      { architecture: "companion", env: {} },
    );
    assert.equal(out[c.field], REDACTED,
      `companion ${c.field} with ${c.label} value must redact wholesale`);
  }
});

test("sanitize: bare session_id and request_id redact wholesale even when value is structured", () => {
  const cases = [
    { field: "session_id", value: { user_id: "alice", trace_id: "deadbeef" }, label: "object" },
    { field: "request_id", value: ["req-a", "req-b"], label: "array" },
    { field: "session_id", value: 42, label: "number" },
  ];
  for (const c of cases) {
    const out = sanitize(
      { [c.field]: c.value },
      { architecture: "api-reviewers", env: {} },
    );
    assert.equal(out[c.field], REDACTED,
      `${c.field} with ${c.label} value must redact wholesale (no structure passthrough)`);
  }
});
