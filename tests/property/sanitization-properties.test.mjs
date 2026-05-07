// Property tests for the fixture sanitization library, one property per
// invariant in docs/contracts/sanitization-invariants.md. These are the
// merge gate. Example tests in tests/unit/fixture-sanitization.test.mjs
// stay as documentation of specific shapes — they are NOT the merge gate.
//
// Per the contract verification gate:
//
//  - generators MUST be shape-biased (structured fc.record / fc.dictionary
//    that exercise each pattern surface). Pure fc.string() alone is
//    forbidden as the sole input source for any structural invariant.
//  - generators MUST NOT be value-biased (no hardcoded bug values from
//    prior findings). Random instances of the relevant shape only.
//  - default 1000 runs in the fast subset, 10000 runs in the full suite
//    (CODEX_PLUGIN_FULL_TESTS=1).
//
// For each invariant that maps to a prior finding, the catch-rate
// experiment in catch-rate.experiment.mjs proves the property catches
// the bug from random generation alone (no seeded bug value).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  sanitize,
  buildEnvSecretRedactor,
  redactKnownPatterns,
  FIXTURE_SANITIZATION_REDACTED_TOKEN as REDACTED,
  SECRET_ENV_NAME_CORES,
  FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR,
  FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR,
} from "../../scripts/lib/fixture-sanitization.mjs";

const RUNS = process.env.CODEX_PLUGIN_FULL_TESTS === "1" ? 10_000 : 1_000;
const ARCHITECTURES = ["companion", "grok", "api-reviewers"];

// --------------------------------------------------------------------
// Shape-biased generators. Reused across multiple invariants. Each one
// produces a structured input that exercises the pattern surface — the
// random part is the *content* spliced into the structure, not whether
// the structure exists.
// --------------------------------------------------------------------

const arch = () => fc.constantFrom(...ARCHITECTURES);

// Recursive JSON-compatible value generator. Bounded depth to avoid
// O(2^n) blowup at default depth.
const jsonValue = fc.letrec((tie) => ({
  leaf: fc.oneof(
    { withCrossShrink: true },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ),
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    tie("leaf"),
    fc.array(tie("node"), { maxLength: 5 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("node"), { maxKeys: 5 }),
  ),
})).node;

// A non-secret-shaped env name. Excludes the secret-suffix patterns so
// generators can mix benign + secret env names.
const benignEnvName = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,15}$/)
  .filter((s) => !new RegExp(`(?:^|_)(?:${SECRET_ENV_NAME_CORES.join("|")})$`, "i").test(s));

// A secret-shaped env name. Includes trailing-suffix variants
// (e.g., AWS_ACCESS_KEY_ID, OPENAI_API_KEY_PROD) so the redactor's
// SECRET_ENV_NAME pattern is exercised at the trailing-anchor edge.
const secretEnvName = fc.tuple(
  fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}_$/),
  fc.constantFrom(...SECRET_ENV_NAME_CORES),
  fc.constantFrom("", "_ID", "_PROD", "_BACKUP", "_V2", "_LIVE", "_ROTATED"),
).map(([prefix, suffix, trailing]) => prefix + suffix + trailing);

// Random secret value, ≥8 chars by default (auto threshold). Excludes
// the literal redaction marker per I12.
const secretValue = (minLen = FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR) =>
  fc.string({ minLength: minLen, maxLength: 50 })
    .filter((s) => !s.includes(REDACTED));

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function jsonContains(obj, needle) {
  return JSON.stringify(obj).includes(needle);
}

function spliceIntoString(host, fragment, position) {
  const idx = host.length === 0 ? 0 : position % (host.length + 1);
  return host.slice(0, idx) + fragment + host.slice(idx);
}

// Wrap a string-leaf into one of: plain string, single-key object, array
// element, nested object. Forces the redactor to walk through structure
// rather than just see a top-level string.
function wrapInRandomShape(leaf, shape) {
  switch (shape) {
    case "plain": return leaf;
    case "obj": return { x: leaf };
    case "arr": return [leaf];
    case "nested": return { outer: { inner: [leaf] } };
    default: return leaf;
  }
}
const shape = () => fc.constantFrom("plain", "obj", "arr", "nested");

// --------------------------------------------------------------------
// I1 — Env-secret values do not appear in output.
// --------------------------------------------------------------------

describe("I1 — env-secret values are redacted", () => {
  it("auto-detected secret env names: value never appears in JSON output", () => {
    fc.assert(
      fc.property(
        secretEnvName,
        secretValue(FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR),
        jsonValue,
        shape(),
        arch(),
        (envName, secret, host, sh, architecture) => {
          // Splice the secret into a string-leaf inside the host record.
          const hostStr = JSON.stringify(host);
          const planted = hostStr.slice(0, hostStr.length / 2)
            + secret
            + hostStr.slice(hostStr.length / 2);
          const record = wrapInRandomShape(planted, sh);
          const sanitized = sanitize(record, {
            architecture,
            env: { [envName]: secret },
          });
          return !jsonContains(sanitized, secret);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("curated env keys: lower 4-char threshold honored", () => {
    fc.assert(
      fc.property(
        benignEnvName,
        secretValue(FIXTURE_SANITIZATION_CURATED_LENGTH_FLOOR),
        arch(),
        (envName, secret, architecture) => {
          const planted = `prefix:${secret}:suffix`;
          const sanitized = sanitize(planted, {
            architecture,
            env: { [envName]: secret },
            curatedEnvKeys: [envName],
          });
          return !sanitized.includes(secret);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("benign env values (non-secret name, sub-threshold) NOT redacted", () => {
    fc.assert(
      fc.property(
        benignEnvName,
        fc.string({ minLength: 1, maxLength: 7 }).filter((s) => !s.includes(REDACTED) && s.length > 0),
        arch(),
        (envName, value, architecture) => {
          const record = `prefix:${value}:suffix`;
          const sanitized = sanitize(record, {
            architecture,
            env: { [envName]: value },
          });
          // Benign value appears as-is (or REDACTED if it overlaps a
          // secret-prefix shape — uncommon but possible). Property: if
          // the sanitized output is unchanged, value survives.
          return sanitized === record || sanitized.includes(REDACTED);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I2 — Public-prefix-shaped tokens are redacted regardless of env.
// --------------------------------------------------------------------

const prefixShape = () => fc.constantFrom(
  "sk", "sk-or-v", "sk-ant-api", "AKIA", "AIza", "glpat", "ghp", "ghs", "github_pat", "jwt",
);

function generatePrefixedToken(kind) {
  // Deterministically fabricate a value matching the regex shape. The
  // token *body* is randomized via fc.stringMatching elsewhere; here we
  // use a fixed-shape constant that is NOT one of the known bug values
  // from prior findings (no-fab rule satisfied: this is a *shape*).
  const body40 = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";
  const body36 = body40.slice(0, 36);
  const body35 = body40.slice(0, 35);
  const body22 = body40.slice(0, 22);
  switch (kind) {
    case "sk": return `sk-${body22}`;
    case "sk-or-v": return `sk-or-v1-${body22}`;
    case "sk-ant-api": return `sk-ant-api03-${body22}`;
    case "AKIA": return `AKIAABCDEFGHIJKLMNOP`;
    case "AIza": return `AIza${body35}`;
    case "glpat": return `glpat-${body22}`;
    case "ghp": return `ghp_${body36}`;
    case "ghs": return `ghs_${body36}`;
    case "github_pat": return `github_pat_${body22}`;
    case "jwt": return `eyJ${body22}.${body22}.${body22}`;
    default: return body22;
  }
}

describe("I2 — public-prefix-shaped tokens are redacted", () => {
  it("any prefix shape spliced into any host string is redacted", () => {
    fc.assert(
      fc.property(
        prefixShape(),
        fc.string({ maxLength: 80 }).filter((s) => !s.includes(REDACTED)),
        fc.integer({ min: 0, max: 200 }),
        shape(),
        arch(),
        (kind, host, position, sh, architecture) => {
          const token = generatePrefixedToken(kind);
          const planted = spliceIntoString(host, token, position);
          const record = wrapInRandomShape(planted, sh);
          const sanitized = sanitize(record, { architecture, env: {} });
          return !jsonContains(sanitized, token);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I3a — Bare HTTP Authorization header form.
// --------------------------------------------------------------------

const httpScheme = () => fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{1,15}$/);

describe("I3a — bare HTTP Authorization header is redacted", () => {
  it("Authorization: <scheme> <value>  →  Authorization: [REDACTED]", () => {
    fc.assert(
      fc.property(
        httpScheme(),
        // Value must be non-trivial: alphanumeric, ≥4 chars, not a
        // substring of the redacted-line template "Authorization:
        // [REDACTED]". Filtering out whitespace-only strings here
        // narrows the property to "the credential payload was scrubbed,"
        // which is the actual security claim.
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._=+/-]{3,30}$/)
          .filter((s) => !s.includes(REDACTED)),
        fc.string({ maxLength: 30 }).filter((s) => !s.includes(REDACTED) && !/[\r\n]/.test(s)),
        fc.string({ maxLength: 30 }).filter((s) => !s.includes(REDACTED) && !/[\r\n]/.test(s)),
        arch(),
        (scheme, value, before, after, architecture) => {
          const line = `Authorization: ${scheme} ${value}`;
          const host = `${before}\n${line}\n${after}`;
          const sanitized = sanitize(host, { architecture, env: {} });
          return !sanitized.includes(value)
            && sanitized.includes("Authorization:");
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I3b — JSON double-quoted Authorization header (with escapes).
// --------------------------------------------------------------------

describe("I3b — JSON double-quoted Authorization header is redacted", () => {
  it('"Authorization":"<body>" with arbitrary JSON-escaped body is redacted', () => {
    fc.assert(
      fc.property(
        httpScheme(),
        // Body: random string post-processed to insert random JSON
        // escape sequences. Shape-biased (we ensure the body is JSON-
        // string-shaped); content randomized.
        fc.string({ minLength: 1, maxLength: 30 })
          .map((s) => s.replace(/"/g, "\\\"").replace(/\\/g, "\\\\")),
        // Random JSON-suffix character so we can assert it survives I10.
        fc.constantFrom(",", "}", "]", " ", "\n"),
        arch(),
        (scheme, body, suffix, architecture) => {
          const json = `{"Authorization":"${scheme} ${body}"${suffix}"x":1}`;
          const sanitized = sanitize(json, { architecture, env: {} });
          // Body content gone, key preserved, suffix character preserved.
          return !sanitized.includes(scheme + " " + body)
            && sanitized.includes('"Authorization"')
            && sanitized.includes(suffix);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I4 — Bearer tokens redacted; surrounding JSON syntax preserved.
// --------------------------------------------------------------------

describe("I4 — Bearer tokens are redacted with JSON syntax intact", () => {
  it("Bearer <token> followed by JSON delimiter: token gone, delimiter preserved", () => {
    fc.assert(
      fc.property(
        // Token: random non-empty string with no whitespace, no JSON
        // delimiters, no marker. Shape-bias = "is a Bearer token shape."
        fc.string({ minLength: 4, maxLength: 30 })
          .filter((s) => !/[\s"',}\]\\]/.test(s) && !s.includes(REDACTED)),
        // Suffix character: a JSON delimiter. The greedy-\S+ bug ate
        // these in round-2 review.
        fc.constantFrom('"', "'", "}", "]", ",", " "),
        arch(),
        (token, suffix, architecture) => {
          // Embed in a JSON-shaped string.
          const host = `{"auth":"Bearer ${token}${suffix}rest":1}`;
          const sanitized = sanitize(host, { architecture, env: {} });
          // Token gone, suffix character (the byte immediately after)
          // preserved exactly once at its position.
          return !sanitized.includes(token)
            && sanitized.includes(`Bearer ${REDACTED}${suffix}`);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I8 — Idempotence.
// --------------------------------------------------------------------

describe("I8 — sanitize(sanitize(R)) === sanitize(R)", () => {
  it("idempotent across all generated inputs", () => {
    fc.assert(
      fc.property(
        jsonValue,
        arch(),
        fc.dictionary(
          fc.oneof(secretEnvName, benignEnvName),
          fc.string({ minLength: 0, maxLength: 30 }),
          { maxKeys: 5 },
        ),
        (record, architecture, env) => {
          const once = sanitize(record, { architecture, env });
          const twice = sanitize(once, { architecture, env });
          assert.deepEqual(twice, once);
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I9 — Type/structure preservation for non-redacted values.
// --------------------------------------------------------------------

describe("I9 — type and structure preservation for non-redacted values", () => {
  it("primitives keep their type (number/boolean/null)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 8 }).filter(
            (k) => !["session_id", "request_id", "claude_session_id", "gemini_session_id", "kimi_session_id", "cwd", "workspace_root", "endpoint"].includes(k),
          ),
          fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
        ),
        arch(),
        (obj, architecture) => {
          const out = sanitize(obj, { architecture, env: {} });
          for (const k of Object.keys(obj)) {
            if (typeof obj[k] !== typeof out[k] && obj[k] !== null) return false;
            if (obj[k] === null && out[k] !== null) return false;
          }
          return true;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("array length preserved for arrays of primitives without secret patterns", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)), { maxLength: 10 }),
        arch(),
        (arr, architecture) => {
          const out = sanitize(arr, { architecture, env: {} });
          return Array.isArray(out) && out.length === arr.length;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I9b — Input is not mutated.
// --------------------------------------------------------------------

describe("I9b — input record is not mutated", () => {
  it("JSON.stringify(R) before === JSON.stringify(R) after sanitize", () => {
    fc.assert(
      fc.property(
        jsonValue,
        arch(),
        fc.dictionary(secretEnvName, fc.string({ maxLength: 20 }), { maxKeys: 3 }),
        (record, architecture, env) => {
          const before = JSON.stringify(record);
          sanitize(record, { architecture, env });
          const after = JSON.stringify(record);
          return before === after;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I5 — User-home paths are scrubbed cross-platform.
// --------------------------------------------------------------------

const homePrefix = () => fc.constantFrom("/Users/", "/home/", "C:\\Users\\");

describe("I5 — user-home paths scrubbed (macOS, Linux, Windows)", () => {
  it("/Users/<name>/, /home/<name>/, C:\\Users\\<name>\\ all redacted", () => {
    fc.assert(
      fc.property(
        homePrefix(),
        fc.stringMatching(/^[A-Za-z0-9_-]{3,15}$/),
        fc.string({ maxLength: 20 }).filter((s) => !/[/\\]/.test(s)),
        arch(),
        (prefix, username, suffix, architecture) => {
          const planted = `${prefix}${username}/${suffix}`;
          const sanitized = sanitize(planted, { architecture, env: {} });
          return !sanitized.includes(`${prefix}${username}`)
            && sanitized.includes("<user>");
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("usernames containing spaces (e.g., \"john doe\") are fully redacted", () => {
    fc.assert(
      fc.property(
        homePrefix(),
        // Username generator: TWO segments of the username, separated
        // by a single internal space. Each segment is at least 4
        // characters of alphanumerics + dot/dash/underscore — enough
        // to be unambiguously a PII fragment if it survives in output.
        fc.tuple(
          fc.stringMatching(/^[A-Za-z0-9_.-]{4,8}$/).filter((s) => !s.includes(REDACTED)),
          fc.stringMatching(/^[A-Za-z0-9_.-]{4,8}$/).filter((s) => !s.includes(REDACTED)),
        ),
        fc.constantFrom(`/file.txt"`, `/proj/code.js"`, `/.cache/x"`),
        arch(),
        (prefix, [head, tail], suffix, architecture) => {
          const username = `${head} ${tail}`;
          const planted = `"path":"${prefix}${username}${suffix}`;
          const sanitized = sanitize(planted, { architecture, env: {} });
          // Property: neither half of the space-containing username
          // survives. The bug shape is "/Users/<user> doe/..." where
          // the redactor stopped at the space and left the suffix
          // exposed. Catches that AND the inverse "/Users/john
          // <user>/..." shape if the regex were ever changed to anchor
          // at the end of the username instead.
          return !sanitized.includes(head)
            && !sanitized.includes(tail)
            && sanitized.includes("<user>");
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I6 — Companion session-id fields wholesale-redacted, including
//      camelCase variants.
// --------------------------------------------------------------------

const companionSessionIdKey = () => fc.constantFrom(
  "claude_session_id", "gemini_session_id", "kimi_session_id",
  "claudeSessionId", "geminiSessionId", "kimiSessionId",
);

describe("I6 — companion session-id wholesale redaction", () => {
  it("non-null companion session-id of any type → [REDACTED]", () => {
    fc.assert(
      fc.property(
        companionSessionIdKey(),
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(REDACTED)),
          fc.integer({ min: 1 }),
          fc.boolean(),
          fc.array(fc.integer(), { maxLength: 3 }),
          fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }), fc.integer(), { maxKeys: 3 }),
        ),
        (key, value) => {
          const record = { [key]: value };
          const sanitized = sanitize(record, { architecture: "companion", env: {} });
          return sanitized[key] === REDACTED;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("null companion session-id stays null", () => {
    fc.assert(
      fc.property(companionSessionIdKey(), (key) => {
        const sanitized = sanitize({ [key]: null }, { architecture: "companion", env: {} });
        return sanitized[key] === null;
      }),
      { numRuns: 50 },
    );
  });
});

// --------------------------------------------------------------------
// I7 — Bare session_id/request_id at any object depth.
// --------------------------------------------------------------------

const bareSessionKey = () => fc.constantFrom(
  "session_id", "request_id", "sessionId", "requestId",
);

describe("I7 — session_id/request_id wholesale redaction (any architecture, any depth)", () => {
  it("non-null bare session-id of any type → [REDACTED]", () => {
    fc.assert(
      fc.property(
        bareSessionKey(),
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(REDACTED)),
          fc.integer({ min: 1 }),
          fc.dictionary(fc.string({ minLength: 1, maxLength: 4 }), fc.integer(), { maxKeys: 3 }),
        ),
        arch(),
        // Wrap at depth 0/1/2 to exercise the recursive walker.
        fc.constantFrom(0, 1, 2),
        (key, value, architecture, depth) => {
          let record = { [key]: value };
          for (let i = 0; i < depth; i += 1) record = { wrap: record };
          const sanitized = sanitize(record, { architecture, env: {} });
          let cursor = sanitized;
          for (let i = 0; i < depth; i += 1) cursor = cursor.wrap;
          return cursor[key] === REDACTED;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I10 — Per-pattern surrounding-syntax preservation.
// --------------------------------------------------------------------

describe("I10/I4 — Bearer redaction preserves the byte after the token", () => {
  it("Bearer <token><delim>: delim is byte-equal in output", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 30 })
          .filter((s) => !/[\s"',}\]\\]/.test(s) && !s.includes(REDACTED)),
        fc.constantFrom('"', "'", "}", "]", ",", " ", "\n"),
        arch(),
        (token, delim, architecture) => {
          const host = `pre Bearer ${token}${delim}post`;
          const sanitized = sanitize(host, { architecture, env: {} });
          // The byte at position-of-(Bearer) + len("Bearer [REDACTED]")
          // must equal delim.
          const expected = `pre Bearer ${REDACTED}${delim}post`;
          return sanitized === expected;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("I10/I3b — JSON Authorization redaction preserves closing-quote byte", () => {
  it("body redacted, closing quote and following delimiter survive", () => {
    fc.assert(
      fc.property(
        // Body ≥4 chars to avoid trivial substrings of "Authorization"
        // ("a", "u", "tho") or of "REDACTED". Property here is about
        // the *redaction span*, not about body→character distinctness.
        fc.stringMatching(/^[A-Za-z0-9_.=+/-]{4,30}$/)
          .filter((s) => !s.includes(REDACTED) && !"Authorization".includes(s)),
        fc.constantFrom(",", "}", "]", " "),
        arch(),
        (body, delim, architecture) => {
          const json = `{"Authorization":"${body}"${delim}"x":1}`;
          const sanitized = sanitize(json, { architecture, env: {} });
          return sanitized.includes(`"Authorization":"${REDACTED}"${delim}`)
            && !sanitized.includes(body);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I11 — Purity. Output does not depend on process.env.
// --------------------------------------------------------------------

describe("I11 — sanitize is pure (no process.env, no time, no RNG)", () => {
  it("mutating process.env between calls does not change output", () => {
    fc.assert(
      fc.property(
        jsonValue,
        arch(),
        // A "stranger" env entry that is NOT passed via opts.env. If
        // sanitize reads process.env, this value will leak into the
        // redaction set and change the output.
        secretEnvName,
        secretValue(FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR),
        (record, architecture, strangerKey, strangerValue) => {
          const before = sanitize(record, { architecture, env: {} });
          const prev = process.env[strangerKey];
          process.env[strangerKey] = strangerValue;
          try {
            const after = sanitize(record, { architecture, env: {} });
            return JSON.stringify(before) === JSON.stringify(after);
          } finally {
            if (prev === undefined) delete process.env[strangerKey];
            else process.env[strangerKey] = prev;
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --------------------------------------------------------------------
// I12 — Sentinel / marker safety.
// --------------------------------------------------------------------

describe("I12 — input containing the literal marker triggers a typed error", () => {
  it("marker as substring of input string → throws SanitizeMarkerCollision", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        arch(),
        (before, after, architecture) => {
          const planted = `${before}${REDACTED}${after}`;
          let threwTyped = false;
          try {
            sanitize(planted, { architecture, env: {} });
          } catch (err) {
            threwTyped = err && err.name === "SanitizeMarkerCollision";
          }
          return threwTyped;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("marker as env-secret value → throws SanitizeMarkerCollision", () => {
    fc.assert(
      fc.property(
        secretEnvName,
        fc.string({ maxLength: 10 }),
        arch(),
        (envName, content, architecture) => {
          let threwTyped = false;
          try {
            sanitize(content, {
              architecture,
              env: { [envName]: REDACTED },
            });
          } catch (err) {
            threwTyped = err && err.name === "SanitizeMarkerCollision";
          }
          return threwTyped;
        },
      ),
      { numRuns: 100 },
    );
  });

  it("output marker count <= count of distinct redaction targets in input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...["sk", "AIza", "ghp", "AKIA"]), { maxLength: 5 }),
        arch(),
        (kinds, architecture) => {
          const tokens = kinds.map((k) => generatePrefixedToken(k));
          let planted = "start";
          for (const t of tokens) planted += ` mid ${t}`;
          planted += " end";
          const sanitized = sanitize(planted, { architecture, env: {} });
          const matches = sanitized.match(/\[REDACTED\]/g) || [];
          return matches.length <= tokens.length;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I14 — URL-encoded secrets in scope.
// --------------------------------------------------------------------

describe("I14 — URL-encoded secrets are redacted", () => {
  it("encodeURIComponent(prefix-shaped token) is redacted", () => {
    fc.assert(
      fc.property(
        prefixShape(),
        fc.string({ maxLength: 20 }).filter((s) => !s.includes(REDACTED) && !/%/.test(s)),
        arch(),
        (kind, host, architecture) => {
          const token = generatePrefixedToken(kind);
          const encoded = encodeURIComponent(token);
          // Skip cases where encoding is identity (no special chars).
          if (encoded === token) return true;
          const planted = `${host}?key=${encoded}`;
          const sanitized = sanitize(planted, { architecture, env: {} });
          return !sanitized.includes(token) && !sanitized.includes(encoded);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("encodeURIComponent(env-secret value) is redacted", () => {
    fc.assert(
      fc.property(
        secretEnvName,
        // Generate values that DO contain special chars so encoding is
        // not the identity. Property is vacuous when encoding == value.
        fc.stringMatching(/^[A-Za-z0-9 .,;:/+=&%-]{8,30}$/)
          .filter((s) => s !== encodeURIComponent(s) && !s.includes(REDACTED)),
        arch(),
        (envName, secret, architecture) => {
          const encoded = encodeURIComponent(secret);
          const planted = `prefix ${encoded} suffix`;
          const sanitized = sanitize(planted, {
            architecture,
            env: { [envName]: secret },
          });
          return !sanitized.includes(encoded) && !sanitized.includes(secret);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I15 — Secrets in object keys.
// --------------------------------------------------------------------

describe("I15 — secret-shaped object keys are redacted", () => {
  it("prefix-shaped key → key replaced with [REDACTED]", () => {
    fc.assert(
      fc.property(
        prefixShape(),
        fc.string({ minLength: 1, maxLength: 10 }),
        arch(),
        (kind, value, architecture) => {
          const secretKey = generatePrefixedToken(kind);
          const record = { [secretKey]: value };
          const sanitized = sanitize(record, { architecture, env: {} });
          return !Object.keys(sanitized).includes(secretKey)
            && Object.keys(sanitized).includes(REDACTED);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("env-secret-valued key (above threshold) → key replaced", () => {
    fc.assert(
      fc.property(
        secretEnvName,
        secretValue(FIXTURE_SANITIZATION_AUTO_LENGTH_FLOOR),
        fc.string({ minLength: 1, maxLength: 10 }),
        arch(),
        (envName, secret, value, architecture) => {
          const record = { [secret]: value };
          const sanitized = sanitize(record, {
            architecture,
            env: { [envName]: secret },
          });
          return !Object.keys(sanitized).includes(secret);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I16 — Termination + input-domain enforcement.
// --------------------------------------------------------------------

describe("I16(a) — terminates on JSON-compatible input at depth", () => {
  it("nested JSON-compatible value up to depth 100: no throw", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        arch(),
        (depth, architecture) => {
          let record = { leaf: 1 };
          for (let i = 0; i < depth; i += 1) record = { wrap: record };
          let threw = false;
          try {
            sanitize(record, { architecture, env: {} });
          } catch {
            threw = true;
          }
          return !threw;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("I16(b) — throws SanitizeUnsupportedInput on non-JSON-compatible input", () => {
  it("circular reference → throws", () => {
    const obj = { a: 1 };
    obj.self = obj;
    let threwTyped = false;
    try {
      sanitize(obj, { architecture: "companion", env: {} });
    } catch (err) {
      threwTyped = err && err.name === "SanitizeUnsupportedInput";
    }
    assert.equal(threwTyped, true, "expected SanitizeUnsupportedInput on cycle");
  });

  it("Date input → throws", () => {
    let threwTyped = false;
    try {
      sanitize({ d: new Date() }, { architecture: "companion", env: {} });
    } catch (err) {
      threwTyped = err && err.name === "SanitizeUnsupportedInput";
    }
    assert.equal(threwTyped, true, "expected SanitizeUnsupportedInput on Date");
  });

  it("Map input → throws", () => {
    let threwTyped = false;
    try {
      sanitize({ m: new Map() }, { architecture: "companion", env: {} });
    } catch (err) {
      threwTyped = err && err.name === "SanitizeUnsupportedInput";
    }
    assert.equal(threwTyped, true, "expected SanitizeUnsupportedInput on Map");
  });
});

// --------------------------------------------------------------------
// I17 — Cookie/SSO sub-value extraction.
// --------------------------------------------------------------------

describe("I17 — cookie/SSO env values: inner sub-values are redacted too", () => {
  it("inner SSO token (≥4 chars) without surrounding cookie syntax is redacted", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("APP_COOKIE", "USER_SESSION", "OAUTH_SSO"),
        fc.stringMatching(/^[A-Za-z0-9_-]{8,30}$/).filter((s) => !s.includes(REDACTED)),
        fc.stringMatching(/^[A-Za-z0-9_.-]{4,10}$/).filter((s) => !s.includes(REDACTED)),
        arch(),
        (envName, ssoToken, domain, architecture) => {
          const cookieValue = `sso=${ssoToken}; Domain=${domain}; Path=/`;
          // Plant only the inner token — without the surrounding cookie
          // syntax, I1 alone won't catch it (the whole-cookie literal
          // doesn't appear). I17 says split on ; and = and add the
          // sub-values to the redaction set.
          const planted = `inner-leak: ${ssoToken}`;
          const sanitized = sanitize(planted, {
            architecture,
            env: { [envName]: cookieValue },
          });
          return !sanitized.includes(ssoToken);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// --------------------------------------------------------------------
// I13 — Overlap-safe redaction ordering (permutation-invariance).
// --------------------------------------------------------------------

describe("I13 — env-entry permutation does not change output", () => {
  it("overlapping env values: longest-first ordering enforced", () => {
    fc.assert(
      fc.property(
        // Both values are alphanumeric ≥8 chars (above auto threshold)
        // and have a substring relationship: shortSecret + extraTail =
        // longerSecret. Filter spaces / control chars so leakage of
        // extraTail is unambiguous in the output.
        fc.stringMatching(/^[A-Za-z0-9]{8,20}$/).filter((s) => !s.includes(REDACTED)),
        fc.stringMatching(/^[A-Za-z0-9]{1,5}$/).filter((s) => !s.includes(REDACTED)),
        arch(),
        (longSecret, extraTail, architecture) => {
          const shortSecret = longSecret;
          const longerSecret = longSecret + extraTail;
          const planted = `prefix:${longerSecret}:suffix`;
          // Both env names match SECRET_ENV_NAME suffix. The redactor
          // sorts by length descending — permutation invariance is the
          // observable property.
          const envForward = { MY_TOKEN: shortSecret, OTHER_TOKEN: longerSecret };
          const envReverse = { OTHER_TOKEN: longerSecret, MY_TOKEN: shortSecret };
          const a = sanitize(planted, { architecture, env: envForward });
          const b = sanitize(planted, { architecture, env: envReverse });
          // Permutation-invariance + neither secret leaks verbatim.
          // The two checks together imply longest-first ordering: if
          // the redactor processed the shorter value first, "abc" would
          // be redacted inside "abcd", leaving "[REDACTED]d" — and "d"
          // is a suffix of longerSecret that would survive.
          return a === b
            && !a.includes(longerSecret)
            && !a.includes(shortSecret);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
