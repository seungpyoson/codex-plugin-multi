// Validates every committed fixture under tests/smoke/fixtures/.
//
// This is the gate that catches sanitization regressions and fixture rot.
// If a future re-record leaks a credential, leaks a /Users/<actual-name>
// path, or drops a required provenance field, this test fails before the
// fixture lands.
//
// What it does NOT do: it does not replay the fixture against the wrapper
// (that's the smoke-replay layer, tracked in #106's follow-up). It only
// asserts the fixture is well-formed and sanitized.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ALWAYS_REDACT_STRING_FIELDS,
  COMPANION_SESSION_ID_FIELDS,
  PATH_SCRUB_PROBES,
  SECRET_PREFIX_PATTERNS,
} from "../../scripts/lib/fixture-sanitization.mjs";
import { RECIPES } from "../../scripts/smoke-rerecord.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE_ROOT = path.resolve(HERE, "..", "smoke", "fixtures");

// Required provenance keys per docs/contracts/api-reviewers-output.md.
const PROVENANCE_REQUIRED_KEYS = Object.freeze([
  "model_id",
  "recorded_at",
  "prompt_hash",
  "sanitization_notes",
  "recorded_by",
  "stale_after",
]);

// Architecture inferred from the parent directory name.
const PLUGIN_TO_ARCHITECTURE = Object.freeze({
  claude: "companion",
  gemini: "companion",
  kimi: "companion",
  grok: "grok",
  "api-reviewers-deepseek": "api-reviewers",
});

function listFixturePairs() {
  const pairs = [];
  if (!statSyncOrNull(FIXTURE_ROOT)) {
    // No fixtures directory yet — that's allowed pre-MVP.
    return pairs;
  }
  for (const plugin of readdirSync(FIXTURE_ROOT)) {
    const pluginDir = path.join(FIXTURE_ROOT, plugin);
    if (!statSync(pluginDir).isDirectory()) continue;
    const files = readdirSync(pluginDir);
    const responses = files.filter((f) => f.endsWith(".response.json"));
    for (const responseFile of responses) {
      const scenario = responseFile.replace(/\.response\.json$/, "");
      const provenanceFile = `${scenario}.provenance.json`;
      pairs.push({
        plugin,
        scenario,
        responsePath: path.join(pluginDir, responseFile),
        provenancePath: path.join(pluginDir, provenanceFile),
        architecture: PLUGIN_TO_ARCHITECTURE[plugin] ?? null,
      });
    }
  }
  return pairs;
}

function listOrphanedProvenanceFiles(
  root = FIXTURE_ROOT,
  statFn = statSyncOrNull,
  readDirFn = readdirSync,
) {
  const orphaned = [];
  if (!statFn(root)) return orphaned;
  for (const plugin of readDirFn(root)) {
    const pluginDir = path.join(root, plugin);
    const pluginStat = statFn(pluginDir);
    if (!pluginStat?.isDirectory()) continue;
    const files = readDirFn(pluginDir);
    for (const provenanceFile of files.filter((f) => f.endsWith(".provenance.json"))) {
      const responseFile = provenanceFile.replace(/\.provenance\.json$/, ".response.json");
      if (!files.includes(responseFile)) {
        orphaned.push(path.join(pluginDir, provenanceFile));
      }
    }
  }
  return orphaned;
}

function statSyncOrNull(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function assertNoUnredactedAuthorizationText(text, fixtureLabel) {
  // Bare HTTP form: "Authorization: <value>".
  const bareAuthMatches = [...text.matchAll(/Authorization:\s*([^\s"]+)/gi)];
  for (const match of bareAuthMatches) {
    assert.equal(
      match[1],
      "[REDACTED]",
      `${fixtureLabel}: Authorization value not redacted: ${match[0].slice(0, 60)}...`,
    );
  }
  // JSON-quoted form: "\"Authorization\": \"<value>\"". The bare regex
  // misses this because the literal substring is "Authorization":, not
  // "Authorization:". Without this scan, non-Bearer schemes (Basic,
  // ApiKey, Token, Digest) embedded in echoed request bodies leak past
  // the gate. The value pattern allows JSON escape sequences (e.g. `\"`
  // in Digest's `realm=\"example\"`); a naive `[^"]*` would stop at the
  // first escaped quote and miss everything after it.
  const jsonAuthMatches = [...text.matchAll(/"Authorization"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)];
  for (const match of jsonAuthMatches) {
    assert.equal(
      match[1],
      "[REDACTED]",
      `${fixtureLabel}: JSON-quoted Authorization value not redacted: ${match[0].slice(0, 80)}...`,
    );
  }
  const singleAuthMatches = [...text.matchAll(/'Authorization'\s*:\s*'((?:[^'\\]|\\.)*)'/gi)];
  for (const match of singleAuthMatches) {
    assert.equal(
      match[1],
      "[REDACTED]",
      `${fixtureLabel}: single-quoted Authorization value not redacted: ${match[0].slice(0, 80)}...`,
    );
  }
  const bearerMatches = [...text.matchAll(/Bearer\s+(\[REDACTED\]|[^\s"',;:()<>}\]\\]+)/gi)];
  for (const match of bearerMatches) {
    assert.equal(
      match[1],
      "[REDACTED]",
      `${fixtureLabel}: Bearer token not redacted: ${match[0].slice(0, 60)}...`,
    );
  }
}

function assertNoPublicPrefixTokensText(text, fixtureLabel) {
  for (const pattern of SECRET_PREFIX_PATTERNS) {
    pattern.lastIndex = 0;
    const m = text.match(pattern);
    if (m && m.length > 0) {
      assert.fail(
        `${fixtureLabel}: public-prefix token pattern leaked: ${m[0].slice(0, 30)}...`,
      );
    }
  }
}

// PR-scoped sweep: when SMOKE_FIXTURE_CHANGED is set (newline-separated list
// of repo-root-relative paths), the gate runs only over fixtures the PR
// actually changed. Without it, the gate sweeps every committed fixture
// (default for nightly + main runs). This avoids the trap where tightening
// a sanitization rule retroactively breaks unrelated PRs by failing on
// stale fixtures the PR didn't touch.
//
// Three states the env can be in, each with a distinct meaning:
//
//   - unset (null/undefined): full-sweep fallback. The caller (CI on main,
//     nightly, or any path that couldn't determine the diff) wants every
//     fixture validated.
//   - empty string (or whitespace-only): PR-scoped no-op. The caller
//     determined the PR touched no fixtures.
//   - non-empty: PR-scoped to the listed paths.
//
// CI MUST distinguish "couldn't compute the diff" (leave env unset) from
// "computed an empty diff" (set env to ""). Conflating them would either
// bypass the gate on infrastructure failure (silent no-op) or revive the
// retroactive-blocking trap on benign no-fixture PRs.
export function filterFixturesByChangedEnv(allFixtures, changedEnv, repoRoot) {
  if (changedEnv == null) return allFixtures;
  const trimmed = String(changedEnv).trim();
  if (trimmed === "") return [];
  const changed = new Set(
    trimmed.split("\n").map((line) => toGitPath(line.trim())).filter(Boolean),
  );
  return allFixtures.filter((f) =>
    changed.has(toGitPath(path.relative(repoRoot, f.responsePath)))
    || changed.has(toGitPath(path.relative(repoRoot, f.provenancePath))),
  );
}

function toGitPath(p) {
  return p.split(path.sep).join("/").replaceAll("\\", "/");
}

function isPrScopedRun() {
  // Any env-set state (including empty) is PR-scoped. Only a missing env
  // means the caller wants a full sweep.
  return process.env.SMOKE_FIXTURE_CHANGED != null;
}

const FIXTURES = filterFixturesByChangedEnv(
  listFixturePairs(),
  process.env.SMOKE_FIXTURE_CHANGED,
  REPO_ROOT,
);

test("fixtures: at least one fixture pair exists (MVP scope)", () => {
  if (isPrScopedRun()) {
    // PR-scoped run; an empty changed-fixture set is the normal case for
    // PRs that don't touch fixtures. The full-sweep nightly run still
    // asserts MVP-scope.
    return;
  }
  assert.ok(
    FIXTURES.length > 0,
    "expected at least one fixture pair under tests/smoke/fixtures/<plugin>/",
  );
});

test("fixtures: every smoke-rerecord recipe has a committed fixture pair", () => {
  if (isPrScopedRun()) return;
  const committedPairs = new Set(FIXTURES.map((f) => `${f.plugin}/${f.scenario}`));
  const missing = Object.keys(RECIPES).filter((key) => !committedPairs.has(key));
  assert.deepEqual(
    missing,
    [],
    "every smoke-rerecord recipe must have paired committed fixtures; "
    + "remove out-of-scope recipes or commit their response/provenance pair",
  );
});

test("fixtures: every committed rerecord fixture pair has a live recipe", () => {
  if (isPrScopedRun()) return;
  const liveRecipes = new Set(Object.keys(RECIPES));
  const orphaned = FIXTURES
    .map((f) => `${f.plugin}/${f.scenario}`)
    .filter((key) => !liveRecipes.has(key));
  assert.deepEqual(
    orphaned,
    [],
    "committed rerecord fixtures must not outlive their recipe; remove stale pairs or restore the recipe",
  );
});

test("fixtures: every provenance file has a paired response", () => {
  assert.deepEqual(
    listOrphanedProvenanceFiles().map((p) => path.relative(REPO_ROOT, p)),
    [],
    "committed provenance files must not exist without a matching response fixture",
  );
});

test("listOrphanedProvenanceFiles detects provenance files without responses", () => {
  const root = path.join("/repo", "fixtures");
  const fakeFiles = new Map([
    [root, ["claude"]],
    [path.join(root, "claude"), ["orphan.provenance.json", "paired.response.json", "paired.provenance.json"]],
  ]);
  const fakeStat = (p) => fakeFiles.has(p) ? { isDirectory: () => true } : null;
  const fakeReadDir = (p) => fakeFiles.get(p) ?? [];
  assert.deepEqual(
    listOrphanedProvenanceFiles(root, fakeStat, fakeReadDir)
      .map((p) => p.replace(root, "")),
    ["/claude/orphan.provenance.json"],
  );
});

test("fixtures: committed rerecord fixture exit codes match recipe expectExit", () => {
  if (isPrScopedRun()) return;
  const mismatches = [];
  for (const f of FIXTURES) {
    const key = `${f.plugin}/${f.scenario}`;
    const recipe = RECIPES[key];
    if (!recipe) continue;
    const response = readJson(f.responsePath);
    if (!Object.prototype.hasOwnProperty.call(response, "exit_code")) continue;
    const spec = recipe.spawnArgs();
    if (!spec.expectExit.includes(response.exit_code)) {
      mismatches.push(`${key}: fixture exit_code ${response.exit_code} not in expectExit ${JSON.stringify(spec.expectExit)}`);
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    "committed fixture exit_code must be reproducible by the live rerecord recipe",
  );
});

test("filterFixturesByChangedEnv: undefined env returns all (full sweep)", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/a.json", provenancePath: "/repo/a.prov.json" },
    { plugin: "b", responsePath: "/repo/b.json", provenancePath: "/repo/b.prov.json" },
  ];
  const out = filterFixturesByChangedEnv(all, undefined, "/repo");
  assert.equal(out.length, 2);
});

test("filterFixturesByChangedEnv: empty env is a PR-scoped no-op (PR touched no fixtures)", () => {
  // The CI workflow MUST set env="" only when it computed a diff and the
  // diff was empty. CI failure to compute the diff (merge-base failed,
  // shallow fetch, etc.) MUST leave env unset. Conflating these would
  // either bypass the gate on infrastructure failure (silent no-op) or
  // revive the retroactive-blocking trap on benign no-fixture PRs. See
  // .github/workflows/pull-request-ci.yml for the CI side of the contract.
  const all = [
    { plugin: "a", responsePath: "/repo/a.json", provenancePath: "/repo/a.prov.json" },
  ];
  assert.equal(filterFixturesByChangedEnv(all, "", "/repo").length, 0);
  assert.equal(filterFixturesByChangedEnv(all, "   \n  \n", "/repo").length, 0,
    "whitespace-only env trims to empty and stays a PR-scoped no-op");
});

test("filterFixturesByChangedEnv: env scopes to listed response paths", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/tests/smoke/fixtures/a/x.response.json", provenancePath: "/repo/tests/smoke/fixtures/a/x.provenance.json" },
    { plugin: "b", responsePath: "/repo/tests/smoke/fixtures/b/y.response.json", provenancePath: "/repo/tests/smoke/fixtures/b/y.provenance.json" },
  ];
  const out = filterFixturesByChangedEnv(
    all,
    "tests/smoke/fixtures/a/x.response.json",
    "/repo",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].plugin, "a");
});

test("filterFixturesByChangedEnv: env matches by provenance path too", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/tests/smoke/fixtures/a/x.response.json", provenancePath: "/repo/tests/smoke/fixtures/a/x.provenance.json" },
  ];
  const out = filterFixturesByChangedEnv(
    all,
    "tests/smoke/fixtures/a/x.provenance.json",
    "/repo",
  );
  assert.equal(out.length, 1, "provenance-path match must select the pair");
});

test("filterFixturesByChangedEnv: normalizes path separators before matching", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/tests/smoke/fixtures/a/x.response.json", provenancePath: "/repo/tests/smoke/fixtures/a/x.provenance.json" },
  ];
  const out = filterFixturesByChangedEnv(
    all,
    "tests\\smoke\\fixtures\\a\\x.response.json",
    "/repo",
  );
  assert.equal(out.length, 1, "git-style and platform-style relative paths must match");
});

test("filterFixturesByChangedEnv: env with whitespace-only blank lines is filtered", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/a.json", provenancePath: "/repo/a.prov.json" },
    { plugin: "b", responsePath: "/repo/b.json", provenancePath: "/repo/b.prov.json" },
  ];
  const out = filterFixturesByChangedEnv(all, "a.json\n\n   \nb.json", "/repo");
  assert.equal(out.length, 2);
});

test("filterFixturesByChangedEnv: env with no matches returns empty (genuine PR-scoped no-op)", () => {
  const all = [
    { plugin: "a", responsePath: "/repo/a.json", provenancePath: "/repo/a.prov.json" },
  ];
  const out = filterFixturesByChangedEnv(all, "tests/something/else.json", "/repo");
  assert.equal(out.length, 0,
    "a non-empty env that matches no fixtures is a real PR-scoped no-op (PR didn't touch any fixture)");
});

test("companion session-id validity check catches nested camelCase leaks", () => {
  assert.throws(
    () => assertCompanionSessionIdFieldsRedacted(
      { plugin: "claude", scenario: "synthetic-nested-leak" },
      { metadata: { claudeSessionId: "live-session-id" } },
    ),
    /metadata\.claudeSessionId must be null or \[REDACTED\]/,
  );
});

function assertCompanionSessionIdFieldsRedacted(f, response) {
  walk(response, []);
  function walk(value, fieldPath) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...fieldPath, i]));
      return;
    }
    if (typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      const currentPath = [...fieldPath, k];
      if (COMPANION_SESSION_ID_FIELDS.includes(k) && v != null) {
        assert.equal(
          v,
          "[REDACTED]",
          `${f.plugin}/${f.scenario}: ${currentPath.join(".")} must be null or [REDACTED]; got ${JSON.stringify(v)}`,
        );
      }
      walk(v, currentPath);
    }
  }
}

function assertAlwaysRedactedFieldsRedacted(f, response) {
  walk(response, []);
  function walk(value, fieldPath) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...fieldPath, i]));
      return;
    }
    if (typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      const currentPath = [...fieldPath, k];
      if (ALWAYS_REDACT_STRING_FIELDS.includes(k) && v != null) {
        assert.equal(
          v,
          "[REDACTED]",
          `${f.plugin}/${f.scenario}: ${currentPath.join(".")} must be [REDACTED]; got ${JSON.stringify(v)}`,
        );
      }
      walk(v, currentPath);
    }
  }
}

test("fixtures: every response has a paired provenance", () => {
  for (const f of FIXTURES) {
    assert.ok(
      statSyncOrNull(f.provenancePath),
      `${f.plugin}/${f.scenario}: missing provenance at ${f.provenancePath}`,
    );
  }
});

test("fixtures: every plugin has a known architecture mapping", () => {
  for (const f of FIXTURES) {
    assert.ok(
      f.architecture,
      `${f.plugin}: no architecture mapping. Add to PLUGIN_TO_ARCHITECTURE in tests/unit/fixture-validity.test.mjs.`,
    );
  }
});

test("fixtures: provenance has all required keys", () => {
  for (const f of FIXTURES) {
    const provenance = readJson(f.provenancePath);
    for (const key of PROVENANCE_REQUIRED_KEYS) {
      assert.ok(
        provenance[key] != null && provenance[key] !== "",
        `${f.plugin}/${f.scenario}: provenance missing or empty: ${key}`,
      );
    }
    assert.match(
      provenance.prompt_hash,
      /^sha256:[0-9a-f]{64}$/,
      `${f.plugin}/${f.scenario}: prompt_hash must be sha256:<64 hex>`,
    );
    assert.match(
      provenance.recorded_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      `${f.plugin}/${f.scenario}: recorded_at must be ISO 8601 UTC`,
    );
    assert.match(
      provenance.stale_after,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      `${f.plugin}/${f.scenario}: stale_after must be ISO 8601 UTC`,
    );
    const recordedAt = new Date(provenance.recorded_at).getTime();
    const staleAfter = new Date(provenance.stale_after).getTime();
    assert.ok(
      staleAfter > recordedAt,
      `${f.plugin}/${f.scenario}: stale_after must be after recorded_at`,
    );
  }
});

test("fixtures: response is parseable JSON object (not array, not primitive)", () => {
  for (const f of FIXTURES) {
    const response = readJson(f.responsePath);
    assert.equal(
      typeof response,
      "object",
      `${f.plugin}/${f.scenario}: response must be an object`,
    );
    assert.equal(
      Array.isArray(response),
      false,
      `${f.plugin}/${f.scenario}: response must be an object, not an array`,
    );
  }
});

test("fixtures: no user-home path leaks (macOS, Linux, Windows; only <user>)", () => {
  // Cross-platform path-leak detector. Reuses PATH_SCRUB_PROBES from
  // scripts/lib/fixture-sanitization.mjs — both the redactor and this
  // detector derive from the same PATH_SCRUB_RULES table, so adding a
  // new platform updates both via one edit.
  for (const f of FIXTURES) {
    const text = readFileSync(f.responsePath, "utf8");
    for (const probe of PATH_SCRUB_PROBES) {
      for (const match of [...text.matchAll(probe.regex)]) {
        assert.equal(
          match[1],
          "<user>",
          `${f.plugin}/${f.scenario}: path leak detected: ${probe.prefix}${match[1]} (must be ${probe.prefix}<user>)`,
        );
      }
    }
  }
});

test("fixtures: no unredacted Authorization or Bearer values", () => {
  for (const f of FIXTURES) {
    const text = readFileSync(f.responsePath, "utf8");
    assertNoUnredactedAuthorizationText(text, `${f.plugin}/${f.scenario}`);
  }
});

test("authorization validity patterns match sanitizer redaction boundaries", () => {
  const text = [
    "Bearer [REDACTED])",
    "{'Authorization':'[REDACTED]'}",
  ].join("\n");
  const bearerMatches = [...text.matchAll(/Bearer\s+(\[REDACTED\]|[^\s"',;:()<>}\]\\]+)/gi)];
  assert.equal(bearerMatches[0][1], "[REDACTED]");
  const singleAuthMatches = [...text.matchAll(/'Authorization'\s*:\s*'((?:[^'\\]|\\.)*)'/gi)];
  assert.equal(singleAuthMatches[0][1], "[REDACTED]");
});

test("authorization validity gate rejects single-quoted Authorization leaks", () => {
  assert.throws(
    () => assertNoUnredactedAuthorizationText(
      "{'Authorization':'Basic dGVzdA=='}",
      "synthetic/single-quoted-auth",
    ),
    /single-quoted Authorization value not redacted/,
  );
});

test("fixtures: no obvious public-prefix tokens leak (sk-, AKIA, GitHub gh*_ prefixes, github_pat_, AIza, glpat-, JWT)", () => {
  for (const f of FIXTURES) {
    assertNoPublicPrefixTokensText(
      readFileSync(f.responsePath, "utf8"),
      `${f.plugin}/${f.scenario} response`,
    );
    assertNoPublicPrefixTokensText(
      readFileSync(f.provenancePath, "utf8"),
      `${f.plugin}/${f.scenario} provenance`,
    );
  }
});

test("public-prefix validity gate rejects provenance leaks", () => {
  assert.throws(
    () => assertNoPublicPrefixTokensText(
      "recorded_by: gho_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      "synthetic/provenance",
    ),
    /public-prefix token pattern leaked/,
  );
});

test("fixtures: companion fixtures have session_id fields nulled or [REDACTED]", () => {
  const companionFixtures = FIXTURES.filter((f) => f.architecture === "companion");
  for (const f of companionFixtures) {
    const response = readJson(f.responsePath);
    assertCompanionSessionIdFieldsRedacted(f, response);
  }
});

test("fixtures: always-redacted session/request id fields are nulled or [REDACTED] (any arch)", () => {
  // Catches the doctor/ping output shape where the field is just "session_id",
  // and the camelCase variants the sanitizer also treats as always-redacted.
  // Import the shared field list so the committed-fixture gate stays in sync
  // with the sanitizer if new always-redacted field variants are added.
  for (const f of FIXTURES) {
    const response = readJson(f.responsePath);
    assertAlwaysRedactedFieldsRedacted(f, response);
  }
});

test("always-redacted field validity check catches nested camelCase leaks", () => {
  assert.throws(
    () => assertAlwaysRedactedFieldsRedacted(
      { plugin: "synthetic", scenario: "session-id-leak" },
      { metadata: { sessionId: "live-session-id" } },
    ),
    /metadata\.sessionId must be \[REDACTED\]/,
  );
});

test("fixtures: always-redacted field gate covers snake_case and camelCase variants", () => {
  for (const field of ["session_id", "request_id", "sessionId", "requestId"]) {
    assert.ok(
      ALWAYS_REDACT_STRING_FIELDS.includes(field),
      `ALWAYS_REDACT_STRING_FIELDS must include ${field}`,
    );
  }
});

test("fixtures: JobRecord-shaped responses carry schema_version", () => {
  // Some fixtures (doctor/ping output) are NOT JobRecord-shaped — they have
  // their own structure (status/ready/summary/...). Only require
  // schema_version when the response looks like a JobRecord (has the
  // characteristic external_review sub-record).
  for (const f of FIXTURES) {
    const response = readJson(f.responsePath);
    const looksLikeJobRecord = response
      && typeof response === "object"
      && "external_review" in response;
    if (!looksLikeJobRecord) continue;
    assert.ok(
      typeof response.schema_version === "number" && response.schema_version > 0,
      `${f.plugin}/${f.scenario}: JobRecord-shaped response missing schema_version`,
    );
  }
});

test("fixtures: every architecture has at least one success and one negative fixture covered", () => {
  // The MVP shipping criterion. Allows extra fixtures; only fails if any
  // architecture has zero coverage on either side.
  //
  // Greptile P1 (#3198731228): the coverage check must run against the
  // FULL fixture inventory, not the PR-scoped FIXTURES list. Otherwise
  // a future PR that touches only one architecture's fixtures sees
  // byArch missing the other two and fails CI with a false "no fixtures
  // recorded yet" — even though the unchanged-on-disk fixtures still
  // satisfy the criterion. listFixturePairs() is the source of truth
  // for the inventory; FIXTURES is the PR-scoped subset for sanitization
  // gating only.
  const byArch = new Map();
  for (const f of listFixturePairs()) {
    if (!byArch.has(f.architecture)) byArch.set(f.architecture, new Set());
    const response = readJson(f.responsePath);
    const side = response.exit_code === 0 && response.status === "completed"
      ? "success"
      : "negative";
    byArch.get(f.architecture).add(side);
  }
  const expectedArchitectures = ["companion", "grok", "api-reviewers"];
  for (const arch of expectedArchitectures) {
    const sides = byArch.get(arch);
    assert.ok(
      sides && sides.size > 0,
      `architecture ${arch}: no fixtures recorded yet`,
    );
    assert.ok(
      sides.has("success"),
      `architecture ${arch}: no successful fixture (must include at least one completed fixture with exit_code 0)`,
    );
    assert.ok(
      sides.has("negative"),
      `architecture ${arch}: no negative-path fixture (must include at least one non-completed or non-zero fixture)`,
    );
  }
});
