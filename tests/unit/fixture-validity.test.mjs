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
  COMPANION_SESSION_ID_FIELDS,
  PATH_SCRUB_PROBES,
} from "../../scripts/lib/fixture-sanitization.mjs";

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
  "api-reviewers-glm": "api-reviewers",
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
    trimmed.split("\n").map((line) => line.trim()).filter(Boolean),
  );
  return allFixtures.filter((f) =>
    changed.has(path.relative(repoRoot, f.responsePath))
    || changed.has(path.relative(repoRoot, f.provenancePath)),
  );
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
    // Bare HTTP form: "Authorization: <value>".
    const bareAuthMatches = [...text.matchAll(/Authorization:\s*([^\s"]+)/gi)];
    for (const match of bareAuthMatches) {
      assert.equal(
        match[1],
        "[REDACTED]",
        `${f.plugin}/${f.scenario}: Authorization value not redacted: ${match[0].slice(0, 60)}...`,
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
        `${f.plugin}/${f.scenario}: JSON-quoted Authorization value not redacted: ${match[0].slice(0, 80)}...`,
      );
    }
    const bearerMatches = [...text.matchAll(/Bearer\s+([^\s"]+)/gi)];
    for (const match of bearerMatches) {
      assert.equal(
        match[1],
        "[REDACTED]",
        `${f.plugin}/${f.scenario}: Bearer token not redacted: ${match[0].slice(0, 60)}...`,
      );
    }
  }
});

test("fixtures: no obvious public-prefix tokens leak (sk-, AKIA, ghp_, ghs_, github_pat_, AIza, glpat-, JWT)", () => {
  for (const f of FIXTURES) {
    const text = readFileSync(f.responsePath, "utf8");
    const patterns = [
      { name: "OpenAI/Anthropic sk-", re: /sk-[a-zA-Z\d]{20,}/g },
      { name: "OpenRouter sk-or-v*", re: /sk-or-v\d+-[a-zA-Z\d]{20,}/g },
      { name: "Anthropic sk-ant-api*", re: /sk-ant-api\d+-[a-zA-Z\d_-]{20,}/g },
      { name: "AWS AKIA", re: /AKIA[0-9A-Z]{16}/g },
      { name: "Google AIza", re: /AIza[0-9A-Za-z_-]{35}/g },
      { name: "GitLab glpat-", re: /glpat-[a-zA-Z0-9_-]{20,}/g },
      { name: "GitHub PAT", re: /gh[ps]_[a-zA-Z0-9]{36}/g },
      { name: "GitHub fine-grained PAT", re: /github_pat_\w{20,}/g },
      {
        name: "JWT",
        re: /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      },
    ];
    for (const { name, re } of patterns) {
      const m = text.match(re);
      if (m && m.length > 0) {
        assert.fail(
          `${f.plugin}/${f.scenario}: ${name} pattern leaked: ${m[0].slice(0, 30)}...`,
        );
      }
    }
  }
});

test("fixtures: companion fixtures have session_id fields nulled or [REDACTED]", () => {
  const companionFixtures = FIXTURES.filter((f) => f.architecture === "companion");
  for (const f of companionFixtures) {
    const response = readJson(f.responsePath);
    assertCompanionSessionIdFieldsRedacted(f, response);
  }
});

test("fixtures: bare session_id and request_id fields are nulled or [REDACTED] (any arch)", () => {
  // Catches the doctor/ping output shape where the field is just "session_id".
  for (const f of FIXTURES) {
    const response = readJson(f.responsePath);
    walk(response, []);
    function walk(value, path) {
      if (value == null) return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, [...path, i]));
        return;
      }
      if (typeof value !== "object") return;
      for (const [k, v] of Object.entries(value)) {
        if ((k === "session_id" || k === "request_id") && v != null) {
          assert.equal(
            v,
            "[REDACTED]",
            `${f.plugin}/${f.scenario}: ${[...path, k].join(".")} must be null or [REDACTED]; got ${JSON.stringify(v)}`,
          );
        }
        walk(v, [...path, k]);
      }
    }
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
    byArch.get(f.architecture).add(f.scenario);
  }
  const expectedArchitectures = ["companion", "grok", "api-reviewers"];
  for (const arch of expectedArchitectures) {
    const scenarios = byArch.get(arch);
    assert.ok(
      scenarios && scenarios.size > 0,
      `architecture ${arch}: no fixtures recorded yet`,
    );
    const hasHappy = [...scenarios].some((s) => s.includes("happy") || s === "ok" || s === "success");
    const hasNegative = [...scenarios].some((s) => !s.includes("happy") && s !== "ok" && s !== "success");
    assert.ok(
      hasHappy,
      `architecture ${arch}: no happy-path fixture (must include at least one with "happy" in the name)`,
    );
    assert.ok(
      hasNegative,
      `architecture ${arch}: no negative-path fixture (must include at least one fixture without "happy" in the name)`,
    );
  }
});
