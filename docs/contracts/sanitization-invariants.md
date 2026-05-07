# Fixture sanitization invariants

Formal contract for `scripts/lib/fixture-sanitization.mjs`. The unit and
smoke test suites contain *example* tests; this document defines the
*property* tests that gate merge.

This is a different surface from `docs/contracts/redaction.md`. That
document describes the three runtime redaction surfaces (companion env
strip, grok output redaction, api-reviewers output redaction). This
document describes the offline sanitization library that runs once over
*recorded* fixtures before they are committed to the repo.

If a property test in `tests/property/sanitization-properties.test.mjs`
fails, the invariant — not the test — is wrong. Either the library is
broken or the contract is incomplete. Adding a hand-crafted example test
to paper over a property failure is forbidden.

## Surface

```
sanitize(record, { architecture, env, curatedEnvKeys }) -> sanitized
```

- `record`: a **JSON-compatible** JS value. Allowed: plain object, array,
  string, finite number, boolean, null. **Disallowed** (out of scope —
  library MUST throw or be documented as undefined behavior; see I16):
  `undefined`, cyclic references, `Map`, `Set`, `Date`, `RegExp`,
  `Buffer`/typed arrays, `Symbol`, `BigInt`, functions, getters/proxies,
  prototype-polluted objects.
- `architecture`: `"companion" | "grok" | "api-reviewers"`. Required.
  Selects which architecture-specific rules apply (currently only the
  companion `*_session_id` field treatment).
- `env`: object of env-name → env-value strings. **Required** — no
  default to `process.env`. (See I11. Callers that want process.env must
  pass it explicitly. This makes the function pure.)
- `curatedEnvKeys`: array of env names operator marked as
  credential-bearing. Lower length floor (4 chars vs 8 chars).

The function returns a deep-cloned, sanitized copy of `record`. It must
not mutate `record` (see I9b).

### Redaction marker

The literal string `"[REDACTED]"` is the sole marker. It is reserved:
no env-secret value, curated key value, or matched substring in input
may equal or contain it (see I12). Redaction must replace exactly the
matched span; the marker MUST NOT cause additional matches when any
invariant is re-applied (see I8).

## Invariants

### I1 — Env-secret values do not appear in output

**Statement.** For every input record `R`, every env mapping `E`, and
every env entry `(k, v) ∈ E` such that:

- `k` matches `/(?:^|_)(?:API_KEY|TOKEN|ACCESS_KEY|SECRET|ADMIN_KEY|COOKIE|SESSION|SSO)$/i` AND `len(v) >= 8`, OR
- `k ∈ curatedEnvKeys` AND `len(v) >= 4`,

the JSON serialization of `sanitize(R, {env: E, curatedEnvKeys})` does
not contain `v` as a substring.

**Coverage proof:** the partial-redaction edge case (Gemini Code Assist
finding, fixed in `50c21a0`) is a special case where two env values
overlapped. A property generator that emits envs with overlapping values
would have caught this without being told.

**Generator.**
```
fc.dictionary(
  fc.oneof(secretEnvName, fc.string()),     // mix of secret + non-secret names
  fc.string({ minLength: 1, maxLength: 50 }),
)
```

### I2 — Public-prefix-shaped tokens do not appear in output

**Statement.** For every input record `R`, the JSON serialization of
`sanitize(R, ...)` contains zero substrings matching any of:

- `/sk-[a-zA-Z\d]{20,}/`
- `/sk-or-v\d+-[a-zA-Z\d]{20,}/`
- `/sk-ant-api\d+-[a-zA-Z\d_-]{20,}/`
- `/AKIA[0-9A-Z]{16}/`
- `/AIza[0-9A-Za-z_-]{35}/`
- `/glpat-[a-zA-Z0-9_-]{20,}/`
- `/gh[ps]_[a-zA-Z0-9]{36}/`
- `/github_pat_\w{20,}/`
- `/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/` (JWT)

**Generator.** Inject random instances of each prefix shape into random
positions in random strings, recurse via random JS values.

### I3 — Authorization values are redacted across all container shapes

I3 is a family of sub-invariants, one per container shape. The unified
"any scheme/any form" claim is rejected as too broad to test. Each
sub-invariant is its own property test.

For all sub-invariants below, "any scheme S" means S is any non-empty
string of letters (Bearer, Basic, ApiKey, Token, Digest, Negotiate,
arbitrary unknown schemes including all-numeric or mixed). "Any value
V" means V is any non-empty printable ASCII sequence not containing
the surrounding delimiter (or correctly escaping it).

**I3a — Bare HTTP header form.** For every input string `s` containing
a substring matching `/^Authorization:\s*<S>\s+<V>\s*$/im` (multiline,
case-insensitive), the output replaces `<S>\s+<V>` with `[REDACTED]`
and preserves leading/trailing whitespace and the line terminator.

**I3b — JSON double-quoted form, with JSON escapes.** For every input
string `s` containing `"Authorization"\s*:\s*"<body>"` where `<body>`
matches `(?:[^"\\]|\\.)*` (escape-aware), the output replaces `<body>`
with `[REDACTED]`, preserving the closing `"` and any character
immediately following (`,`, `}`, `]`, whitespace, newline).

**I3c — JSON single-quoted / pseudo-JSON form.** For every input string
`s` containing `'Authorization'\s*:\s*'<body>'` where `<body>` matches
`(?:[^'\\]|\\.)*`, output replaces `<body>` with `[REDACTED]`
preserving the closing `'`.

**I3d — Lowercase / mixed-case key.** I3a–I3c hold with the literal key
matched case-insensitively (`authorization`, `AUTHORIZATION`, etc.).

**Out of scope (documented limitations):**

- Multi-line header continuations (RFC 2616 §4.2 obsoleted form).
- Unicode-escaped key spellings (`Authorization`).
- HTTP/2 binary header frames (text-only contract).

**Coverage proof:**

- Bare form: covered by I3a (regression: pre-MVP redactor).
- JSON form: covered by I3b (regression: external review round 2,
  fixed in `82c5499`).
- JSON escapes: covered by I3b's escape-aware body
  (regression: internal review round 3, fixed in `cf56d4c`).
- Single-quoted form: covered by I3c (raised by GLM/DeepSeek panel
  round 4 — no current code path, but contract gates future use).
- Lowercase: covered by I3d (raised by GLM/DeepSeek panel round 4).

**Generator.** Shape-biased: a JSON-record generator that places an
`Authorization`/`authorization` key (random case) in random nested
positions, with value = `<S> <V>` where `<S>` is `fc.stringMatching(/[A-Za-z]+/)` and `<V>` is `fc.string()` post-processed to include
random JSON-escape sequences (`\"`, `\\`, `\n`). Pure unbiased
`fc.string()` is forbidden — probability of generating the required
shape is ~0.

### I4 — Bearer tokens are redacted; surrounding syntax is preserved

**Statement.** For every input string `s` and every position where
`Bearer <token>` appears (where `<token>` is any non-whitespace string
not containing JSON delimiters `"`, `'`, `}`, `]`, `,`, `\`), the output:

1. Does not contain `<token>`.
2. Preserves all characters in `s` immediately surrounding `Bearer <token>`,
   including JSON delimiters `"`, `}`, `]`, `,` that follow the token.

**Coverage proof:** GLM/DeepSeek round 2 finding — greedy `\S+` ate
trailing `"}` etc. Property test on `s = "Bearer xyz" + suffix` for
arbitrary `suffix` that starts with a JSON delimiter would catch this
without being told.

**Generator.** Random `Bearer <token>` instances spliced into random
JSON-shaped strings.

### I5 — User-home paths are scrubbed (cross-platform)

**Statement.** For every input string at any depth, the following
patterns are replaced with the literal `<user>`:

- `/Users/<name>/` (macOS) → `/Users/<user>/`
- `/home/<name>/` (Linux) → `/home/<user>/`
- `C:\Users\<name>\` (Windows, case-insensitive on drive letter) →
  `C:\Users\<user>\`

`<name>` is any non-empty identifier matching `[^/\\]+` (path
separators terminate the match). `<user>` is the literal four-character
string.

**Generator.** Shape-biased: `fc.constantFrom("/Users/", "/home/", "C:\\Users\\")` × `fc.string({ minLength: 1 })` (no path separators)
× `fc.string()` for suffix.

**Coverage proof:** macOS-only original (current code) leaks Linux/CI
home paths in fixtures recorded under `/home/runner/`. Raised by
panel round 4 (Kimi).

### I6 — Companion session-id fields are wholesale-redacted

**Statement.** When `architecture === "companion"`, for every input
record `R` and every key `k` matching the case-insensitive set:
`{claude_session_id, gemini_session_id, kimi_session_id, claudeSessionId, geminiSessionId, kimiSessionId}` (snake_case and camelCase
variants), at any object depth:

- If `R[...][k]` is `null`, output is `null`.
- Otherwise, output is the literal string `"[REDACTED]"`,
  regardless of the type of `R[...][k]` (string, number, boolean,
  array, object, etc.).

**Coverage proof:** internal review round 2 finding — original code
flattened only strings, recursed for objects (preserving structure).
camelCase variants raised by panel round 4 (Kimi).

**Generator.** Shape-biased: a JSON-record generator that places one
of the named keys (random case-style) at a random object depth, with
value drawn from `fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(...), fc.dictionary(...), fc.constant(null))`.

### I7 — Bare `session_id`/`request_id` are wholesale-redacted at any object depth

**Statement (scope: object keys only).** For every input record `R`
and every key `k` matching the case-insensitive set
`{session_id, request_id, sessionId, requestId}` appearing as an
**object key** at any depth, regardless of `architecture`:

- If `R[...][k]` is `null`, the corresponding output is `null`.
- Otherwise, the corresponding output is the literal string
  `"[REDACTED]"`.

**Explicitly out of scope (I7):** the substring `"session_id"` or
`"request_id"` appearing **inside a string value** (e.g., a stringified
JSON blob, a log line, a prose error message). Such strings pass
through I7 untouched. Embedded-secret coverage in stringified JSON is
deferred — see I7b.

**I7b — Stringified-JSON parse-and-redact (deferred, OUT OF SCOPE for v1).**
Strings whose content parses as valid JSON and contains keys covered
by I6/I7 are not parsed-and-redacted in v1. Documented limitation.
Promote to in-scope only when a fixture is observed exercising it.

**Coverage proof (I7):** internal review round 2 finding — original
code recursed into structured `session_id` values, leaking PII like
`{ user_id, trace_id }`. camelCase variants raised by panel round 4
(Kimi).

**Generator.** Shape-biased: JSON-record generator that places
`session_id`/`request_id` (random case-style) at a random object depth
with mixed-type values.

### I8 — Idempotence

**Statement.** For all `(R, opts)` (a record `R` and a sanitization
context `opts = {env, architecture, curatedEnvKeys, ...}`):
`sanitize(sanitize(R, opts), opts) === sanitize(R, opts)` (deep-equal).

**Why.** A second sanitization pass must not introduce new redactions or
corrupt previously-sanitized output. This invariant catches
self-interference bugs (e.g., a regex matching the literal `[REDACTED]`
token).

**Generator.** Apply any input from any other property test, run
`sanitize` twice, deep-equal compare.

### I9 — Type and structure preservation for non-redacted values

**Statement.** For every input record `R` containing values that match
no redaction rule, those values appear in the output with the same
JavaScript type and structure: objects keep their key set in the same
order, arrays keep their length and per-index types, primitives keep
their type (number stays number, boolean stays boolean), and `null`
stays `null`.

**Why.** Catches accidental coercion (e.g., redacting a number to a
string when no rule applies) and accidental reordering.

### I9b — Input is not mutated

**Statement.** After `sanitize(R, opts)` returns, `R` is byte-identical
to its pre-call serialization, AND every nested object/array within
`R` is reference-identical to its pre-call self (deep-clone path was
internal, no mutation of `R`'s graph).

**Why.** Callers may inspect `R` after sanitization. A mutation here
silently corrupts the recorded fixture before it is written to disk.

**Generator.** Apply any input from any other property, snapshot
`JSON.stringify(R)` before, run `sanitize`, assert the post-call
serialization equals the snapshot.

### I10 — Surrounding-syntax preservation per pattern (instance set)

**Statement.** Single-property generalization of "syntax preservation"
is rejected as untestable. I10 is a coverage set: each named pattern
has its own per-pattern property test asserting that the character(s)
immediately before and after each match survive verbatim.

**Minimum coverage set (each is its own property test):**

1. **I10/I3a** — bare HTTP `Authorization` line: trailing `\r\n` or
   `\n` survives.
2. **I10/I3b** — JSON-quoted `"Authorization":"…"` body: closing `"`
   AND the next character (`,`, `}`, `]`, or whitespace) survive.
3. **I10/I3c** — single-quoted `'Authorization':'…'`: closing `'`
   survives.
4. **I10/I4** — `Bearer <token>`: the next character (any of
   `"`, `'`, `}`, `]`, `,`, whitespace, `\\`) survives. **Specific
   regression** (GLM/DeepSeek round 2): greedy `\S+` ate trailing `"}`.
5. **I10/I2** — public-prefix tokens (`sk-…`, `AIza…`, `ghp_…`, etc.):
   character immediately before and after the matched prefix survives.
6. **I10/I1** — env-secret literal substring: characters immediately
   surrounding the redacted span survive (also exercises I13 ordering
   when overlapping secrets are present).
7. **I10/I5** — user-home path: characters before `/Users/` /
   `/home/` / `C:\Users\` and after the `<name>` segment survive.

Each property: random-shape host string, splice in one instance of the
pattern at a random position with a random delimiter immediately
adjacent, assert delimiter byte-equals in output.

**Why.** Single-property catch-all is unfalsifiable without
re-implementing the redactor in the test. Per-pattern set is small
enough to enumerate, large enough to catch greedy-match bugs.

### I11 — Purity

**Statement.** `sanitize(R, opts)` is a pure function of `(R, opts)`:

1. Repeated invocations with the same `(R, opts)` produce deep-equal
   outputs (determinism).
2. Output does not depend on `process.env` (the surface contract
   forbids defaulting; this property test additionally asserts that
   mutating `process.env` between calls does not change output).
3. Output does not depend on `Date.now()`, `Math.random()`, or any
   other time/RNG source (no time tokens in output, repeated calls
   with frozen-clock-mocked output identical).
4. Output does not depend on file-system state or network.

**Why.** Recorded fixtures must be reproducible across machines and
across days. A non-pure sanitize() means the same recorded response
gets different redaction in CI vs. local.

**Generator.** Call `sanitize(R, opts)` 5×, mutating `process.env`,
advancing a mocked clock, and reseeding `Math.random` between calls.
Assert all 5 outputs are deep-equal.

### I12 — Sentinel / marker safety

**Statement.** The marker string `"[REDACTED]"` is reserved. For all
inputs:

1. **Input precondition** (caller-enforced — `sanitize` validates and
   throws on violation): no env-secret value, no curated key value,
   and no input string-fragment shall equal `"[REDACTED]"` or contain
   it as a substring. If the precondition is violated, `sanitize`
   SHALL throw a typed error (`SanitizeMarkerCollision`) rather than
   silently produce ambiguous output.
2. **Output postcondition:** every occurrence of `"[REDACTED]"` in
   output corresponds to a redaction event (a value or substring that
   matched I1/I2/I3/I4/I5/I6/I7/I15). Count of marker occurrences in
   `JSON.stringify(output)` ≤ count of redaction events.
3. **No-self-match:** no regex pattern in the redactor matches the
   marker string itself.

**Why.** Without (1), an attacker who controls input can plant the
marker to make their secret appear pre-redacted. Without (2), the
marker becomes meaningless as proof of redaction. Without (3), a
second pass corrupts a first pass's output (idempotence violation).

**Generator.** Splice the marker as a literal substring into random
positions in random JSON shapes; assert sanitize throws.

**Coverage proof:** raised by all 5 panel models (round 4) — Gemini,
GPT, GLM, DeepSeek, Kimi.

### I13 — Overlap-safe redaction ordering

**Statement.** For any input record `R`, any env mapping `E`, and any
permutation `E'` of `E`, `sanitize(R, {env: E, ...})` is deep-equal to
`sanitize(R, {env: E', ...})`.

**Implementation requirement (informative, not testable directly):**
to satisfy this when env entries contain overlapping values (one is a
substring of another), the implementation must apply replacements in
descending length order. The property test catches the bug
(permutation-dependent output) without naming the implementation.

**Why.** Naive `split(secret).join("[REDACTED]")` iterating env in
insertion order leaks: if env has `A="abc"` and `B="abcd"`, redacting
`A` first turns `"abcd"` into `"[REDACTED]d"` — leaking `d`.

**Generator.** `fc.dictionary` of env entries where some values share
prefix/suffix with others; shuffle the entries; compare outputs.

**Coverage proof:** raised by GPT, GLM, DeepSeek, Kimi (round 4). Not
present in any prior finding because no example test exercised
overlapping env values. Real bug class in current code.

### I14 — URL-encoded secrets in scope

**Statement.** For every input string at any depth, every substring
that, after `decodeURIComponent`, matches an I1 env-secret value or an
I2 prefix-shaped pattern, is redacted. Implementation: apply I1/I2
matchers to both the raw form and the percent-decoded form of each
string-leaf, taking the union of matched spans. Decoder errors
(`URIError`) on malformed `%XX` pass the string through untouched.

**Why.** Connection strings, OAuth state, query parameters routinely
URL-encode credentials inside response bodies. Promoted from
out-of-scope per panel round 4 consensus.

**Generator.** Random secret-shaped values, percent-encode random
subsets of bytes, splice into random JSON strings.

**Coverage proof:** raised by Gemini, GPT, GLM, DeepSeek, Kimi (round 4).

### I15 — Secrets in object keys

**Statement.** I1 and I2 apply to object keys at any depth, not only
to values. A key matching an env-secret literal (under I1 thresholds)
or an I2 prefix-shaped pattern is replaced with `"[REDACTED]"`. The
associated value is preserved (subject to other invariants applied to
it independently).

**Edge case:** if multiple keys in the same object collide on
`"[REDACTED]"` after redaction, all but one are dropped (this is
acceptable because the original keys were secrets and the resulting
object cannot represent them anyway). The test must NOT assert key
count preservation in the secret-key case.

**Why.** API error payloads sometimes echo the offending API key as
the object key (`{"sk-ant-…": "rate_limited"}`). I9's structure
preservation specifically does NOT cover this case (the redaction is
the desired structural change).

**Generator.** Random objects whose keys are drawn from a mix of
benign strings, env-secret literals, and I2-prefix-shaped strings.

**Coverage proof:** raised by Gemini and GPT (round 4).

### I16 — Termination and input-domain enforcement

**Statement.**

1. For every JSON-compatible input (per the Surface section), `sanitize`
   terminates in time bounded by `O(n)` in input size, without
   throwing, at any nesting depth up to 10³ (1,000).
   Higher depths are untested and out of contract: the recursive
   walker would risk a Node.js stack overflow at depths approaching
   10⁴, and no real fixture exercises that range. If the contract
   needs to extend to 10⁴+, the implementation must move from
   recursion to an explicit-stack iterative walk.
2. For inputs containing cycles, `Map`, `Set`, `Date`, `RegExp`,
   `Buffer`/typed arrays, `Symbol`, `BigInt`, functions, getters,
   proxies, or non-plain prototypes, `sanitize` SHALL throw a typed
   error (`SanitizeUnsupportedInput`) before walking. Silent
   stringification, mutation, or stack-overflow is forbidden.

**Why.** The contract claims "JSON-compatible" — enforcing it
explicitly prevents silent corruption when callers accidentally pass
domain values (Buffers, Dates) the redactor can't reason about.
Cycles cause stack overflow on the recursive walker; failing fast is
correct.

**Generator.** Two properties:

- (a) Random JSON-compatible values up to depth 1000 → must not throw.
- (b) Random non-JSON-compatible values (cycles via `obj.self = obj`,
  Maps, Buffers) → must throw `SanitizeUnsupportedInput`.

**Coverage proof:** raised by GPT, DeepSeek, Kimi (round 4).

### I17 — Cookie/SSO sub-value extraction

**Statement.** When an env entry `(k, v)` has a key matching
`/(?:^|_)(?:COOKIE|SESSION|SSO)$/i`, in addition to redacting `v` as a
whole substring (per I1), the redaction set additionally includes
every sub-value extracted from `v` by:

1. Splitting `v` on `;` (semicolon, with surrounding whitespace).
2. For each segment, splitting on the first `=` and taking the
   right-hand side.
3. Including each right-hand side that is at least 4 characters as a
   substring to redact.

**Why.** Real cookie env values look like
`"sso=eyJhbGciOiJI…; Domain=example.com; Path=/"`. The whole-string
≥8-char threshold protects against I1 missing it, but if a fixture
echoes only the inner SSO token (without the surrounding cookie
syntax), I1 alone won't redact it. Existing grok runtime redactor
already implements this logic — codifying it as a sanitize-library
invariant unifies the two surfaces.

**Generator.** Random cookie-shaped strings (semicolon-delimited,
key=value), splice random subsets into random JSON shapes.

**Coverage proof:** raised by DeepSeek (round 4).

## Explicitly out of scope

The library does NOT promise:

- **Base64-encoded secrets that don't match a known prefix shape.**
  Pattern-based redaction can't detect arbitrary base64-encoded tokens.
  False-positive rate of broad base64 matching is unacceptable.
- **Secrets shorter than the threshold.** 8-char auto-detect, 4-char
  curated. Lowering thresholds further trades false negatives for false
  positives on common short strings (`true`, `null`, `1234`).
- **Stringified-JSON parse-and-redact (I7b).** Strings whose content
  parses as valid JSON containing I6/I7 keys are NOT recursively
  parsed-and-redacted in v1. Promote to in-scope only when an actual
  fixture is observed exercising it.
- **HTTP/2 binary header frames.** Text-only contract.
- **Multi-line header continuations** (RFC 2616 §4.2 obsoleted form).
- **Unicode-escaped key spellings** (e.g., `Authorization`).
- **Prototype-polluted objects, Map, Set, Date, Buffer, Symbol, BigInt,
  cycles.** Out of input domain — sanitize throws (I16).
- **Ambient `process.env` access.** Caller MUST pass `env` explicitly.
  Sanitize does not read `process.env` (I11).
- **Echo-resistance for schemes with non-JSON-escape encodings.** If a
  provider response double-encodes Authorization headers in a
  non-standard way, the regex won't match.

These limitations are deliberate. Closing them by extending the regex
surface trades real false-positives (corrupting benign data) for
hypothetical leaks. Document, don't extend.

## Verification gate

A property test in `tests/property/sanitization-properties.test.mjs`
must exist for each invariant `I1`, `I2`, `I3a–I3d`, `I4`, `I5`, `I6`,
`I7`, `I8`, `I9`, `I9b`, `I10/{I3a,I3b,I3c,I4,I2,I1,I5}`, `I11`, `I12`,
`I13`, `I14`, `I15`, `I16(a)`, `I16(b)`, `I17`. Each property must:

1. Use **shape-biased** generators: structured `fc.record` /
   `fc.dictionary` constructions that exercise the pattern surface
   (e.g., for I3b, a generator that places an `Authorization` key in
   a random JSON shape with random escaped-string body). Pure
   `fc.string({ minLength: 1, maxLength: 50 })` is **forbidden** as
   the sole input source for any structural invariant — the
   probability of randomly generating a JSON-quoted Authorization
   header is effectively zero, and such tests are theater.
2. **Forbid value-biased** generators: no hardcoded bug values from
   prior findings (e.g., the specific 11-character env value from the
   Gemini Code Assist round-2 finding). Generators must produce
   random instances of the relevant **shape**, including the known
   bug shape as one element of the generated space.
3. Use a default of **1000 runs** in the fast subset, **10000 runs**
   in nightly full suite (`CODEX_PLUGIN_FULL_TESTS=1`).
4. Pass on the post-implementation codebase.

For each prior finding (named in the "Coverage proof" sections), the
implementation PR must include a **catch-rate experiment**: run the
property test with a deliberately-broken sanitizer that reproduces
the prior bug (e.g., revert the I3b escape-aware regex), and
demonstrate that the property test fails within ≤1000 runs without
seeding the specific bug value. If the property test cannot reliably
catch the prior bug from random generation, the generator is wrong
and must be tightened.

If a property test fails on the post-implementation codebase, the
codebase is wrong. If a property test cannot be written for an
invariant, the invariant is wrong. If a known finding is not in any
generator's space, the contract is incomplete and gets tightened.

Example tests in `tests/unit/fixture-sanitization.test.mjs` remain as
documentation of specific named shapes. They are NOT the merge gate.
