// Guards against silent drift between plugins' copy-verbatim lib files. The
// files listed below MUST be byte-identical between every plugin in the
// matching provider set.
// If this test fails after a legitimate upstream re-sync, update BOTH copies.
//
// §21.5 requirement: only modules that are actually consumed in production
// ship. `job-control.mjs`, `prompts.mjs`, and `render.mjs` were removed in
// T7.5 because they had zero production consumers — the class of problem
// that makes byte-identity insufficient (both copies equally broken or
// equally dead). See tests/unit/lib-imports.test.mjs for the new contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_GEMINI_PLUGIN_TARGETS,
  CODEX_ENV_PLUGIN_TARGETS,
  COMPANION_PLUGIN_TARGETS,
  PROVIDER_ENV_PLUGIN_TARGETS,
  REVIEW_PROMPT_PLUGIN_TARGETS,
} from "../../scripts/lib/plugin-targets.mjs";
import { STRIPPED_GIT_ENV_KEYS as CLAUDE_STRIPPED_GIT_ENV_KEYS } from "../../plugins/claude/scripts/lib/git-env.mjs";
import { STRIPPED_GIT_ENV_KEYS as GROK_STRIPPED_GIT_ENV_KEYS } from "../../plugins/grok/scripts/lib/git-env.mjs";
import { STRIPPED_GIT_ENV_KEYS as KIMI_STRIPPED_GIT_ENV_KEYS } from "../../plugins/kimi/scripts/lib/git-env.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function functionBody(source, name) {
  const signature = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(signature, `missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  let quote = null;
  let comment = null;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment === "line") {
      if (char === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      comment = "line";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  assert.fail(`unterminated function ${name}`);
}

function indexOfRequired(source, needle, label) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `${label} missing ${needle}`);
  return index;
}

function allIndicesOf(source, needle) {
  const indices = [];
  let index = source.indexOf(needle);
  while (index !== -1) {
    indices.push(index);
    index = source.indexOf(needle, index + needle.length);
  }
  return indices;
}

function uniqueSortedStrings(values) {
  return [...new Set(values)].sort();
}

function numericEnvKeysParsedByFunction(source, name) {
  const body = functionBody(source, name);
  const keys = uniqueSortedStrings([...body.matchAll(/parsePositiveIntegerEnv\s*\(\s*env\s*,\s*"([^"]+)"/g)]
    .map((entry) => entry[1]));
  assert.ok(keys.length > 0, `${name} must parse at least one numeric env key`);
  return keys;
}

function envKeysStrippedByFallbackFunction(source, name) {
  const body = functionBody(source, name);
  const match = body.match(/envWithoutKeys\s*\(\s*env\s*,\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(match, `${name} must strip numeric env keys through envWithoutKeys(env, [...])`);
  const keys = uniqueSortedStrings([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
  assert.ok(keys.length > 0, `${name} must strip at least one numeric env key`);
  return keys;
}

function parseStringSetLiteral(source, name, label) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${label} missing ${name}`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
}

function readRepoJson(relPath) {
  return JSON.parse(readRepoFile(relPath));
}

test("functionBody ignores braces inside strings and comments", () => {
  const source = `
function target() {
  // }
  return cliConfig(options, env);
}
function next() {
  return webConfig(options, env);
}
`;

  const body = functionBody(source, "target");
  assert.match(body, /\breturn\s+cliConfig\(/);
  assert.doesNotMatch(body, /\breturn\s+webConfig\(/);
});

test("Grok fallback configs strip every numeric env key parsed by their delegate", () => {
  const adapterSource = readRepoFile("plugins/grok/scripts/lib/grok-transport-adapters.mjs");
  assert.deepEqual(
    numericEnvKeysParsedByFunction(adapterSource, "cliConfig"),
    envKeysStrippedByFallbackFunction(adapterSource, "cliFallbackConfig"),
    "cliFallbackConfig must strip every numeric env key parsed by cliConfig",
  );
  assert.deepEqual(
    numericEnvKeysParsedByFunction(adapterSource, "webConfig"),
    envKeysStrippedByFallbackFunction(adapterSource, "webFallbackConfig"),
    "webFallbackConfig must strip every numeric env key parsed by webConfig",
  );
});

const PROVIDER_RUNTIME_POLICY_ENTRYPOINTS = Object.freeze([
  Object.freeze({
    provider: "claude",
    runtimePath: "plugins/claude/scripts/claude-companion.mjs",
    routeSelector: /\bresolveAuthSelectionForProvider\b/,
  }),
  Object.freeze({
    provider: "gemini",
    runtimePath: "plugins/gemini/scripts/gemini-companion.mjs",
    routeSelector: /\bresolveAuthSelectionForProvider\b/,
  }),
  Object.freeze({
    provider: "kimi",
    runtimePath: "plugins/kimi/scripts/kimi-companion.mjs",
    routeSelector: /\bselectProviderRoute\s*\(/,
  }),
  Object.freeze({
    provider: "grok",
    runtimePath: "plugins/grok/scripts/grok-web-reviewer.mjs",
    routeSelector: /\bselectProviderRoute\s*\(/,
  }),
  Object.freeze({
    provider: "deepseek",
    runtimePath: "plugins/api-reviewers/scripts/api-reviewer.mjs",
    routeSelector: /\bselectProviderRoute\s*\(/,
  }),
  Object.freeze({
    provider: "glm",
    runtimePath: "plugins/api-reviewers/scripts/api-reviewer.mjs",
    routeSelector: /\bselectProviderRoute\s*\(/,
  }),
]);

function providerRuntimeEntryPointId(entry) {
  return `${entry.provider}:${entry.runtimePath}`;
}

const VERBATIM_FILES = [
  "workspace.mjs",
  "process.mjs",
  "args.mjs",
  "git.mjs",
  "git-binary.mjs",
  "scope.mjs",
  "cancel-marker.mjs",
  "companion-common.mjs",
  "external-model-failure-catalog.mjs",
  "external-model-failure-core.mjs",
  "external-review.mjs",
  "time.mjs",
  "usage-limit.mjs",
  // identity.mjs is now a thin re-export shim (capturePidInfo lives in the
  // shared process-identity.mjs); newJobId/attachPidCapture/verifyPidInfo carry
  // no provider-specific logic, so all three companions must stay byte-identical.
  // Guarded across the full companion set (claude/gemini/kimi) — previously this
  // file was only guarded across claude/gemini, which let Task 1 (#234) diverge
  // the kimi copy undetected.
  "identity.mjs",
];

const CLAUDE_GEMINI_VERBATIM_FILES = [
  "auth-selection.mjs",
  "provider-env.mjs",
  "reconcile.mjs",
  "git-env.mjs",
];

test("lib/companion-common.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/companion-common.mjs"), "utf8");
  for (const plugin of COMPANION_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/companion-common.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `companion-common.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/external-review.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/external-review.mjs"), "utf8");
  for (const plugin of [...COMPANION_PLUGIN_TARGETS, "api-reviewers", "grok"]) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/external-review.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `external-review.mjs packaging copy drifted in ${plugin}`);
  }
});

for (const sharedFile of ["external-model-failure-catalog.mjs", "external-model-failure-core.mjs"]) {
  test(`lib/${sharedFile}: reviewer packaging copies match the canonical shared source`, () => {
    const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib", sharedFile), "utf8");
    for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
      const copy = readFileSync(
        path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/${sharedFile}`),
        "utf8"
      );
      assert.equal(copy, canonical, `${sharedFile} packaging copy drifted in ${plugin}`);
    }
  });
}

test("lib/external-model-review-quality.mjs: all reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/external-model-review-quality.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/external-model-review-quality.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `external-model-review-quality.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/privacy-redaction.mjs: all reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/privacy-redaction.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/privacy-redaction.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `privacy-redaction.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lint:sync includes a fixer for the privacy redaction shared file", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const lintSync = packageJson.scripts?.["lint:sync"] ?? "";
  assert.match(lintSync, /sync-privacy-redaction\.mjs --check/);
});

test("lib/provider-route-policy.mjs: all reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/provider-route-policy.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/provider-route-policy.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `provider-route-policy.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lint:sync includes a fixer for provider route policy shared file", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const lintSync = packageJson.scripts?.["lint:sync"] ?? "";
  assert.match(lintSync, /sync-provider-route-policy\.mjs --check/);
});

test("lint:sync includes a fixer for companion failure classification shared files", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const lintSync = packageJson.scripts?.["lint:sync"] ?? "";
  assert.match(lintSync, /sync-external-model-failure-classification\.mjs --check/);

  const script = readFileSync(
    path.join(REPO_ROOT, "scripts/ci/sync-external-model-failure-classification.mjs"),
    "utf8"
  );
  assert.match(script, /external-model-failure-core\.mjs/);
  assert.match(script, /external-model-failure-catalog\.mjs/);
});

test("lib/time.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/time.mjs"), "utf8");
  for (const plugin of [...COMPANION_PLUGIN_TARGETS, "api-reviewers", "grok"]) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/time.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `time.mjs packaging copy drifted in ${plugin}`);
  }
});

test("review-panel.mjs: plugin packaging CLIs match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/review-panel.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/review-panel.mjs`), "utf8");
    assert.equal(copy, canonical, `review-panel.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/review-panel.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/review-panel.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/review-panel.mjs`), "utf8");
    assert.equal(copy, canonical, `lib/review-panel.mjs packaging copy drifted in ${plugin}`);
  }
});

test("reviewer runtimes use the shared elapsedMs helper", () => {
  const runtimePaths = [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/claude/scripts/lib/job-record.mjs",
    "plugins/gemini/scripts/lib/job-record.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/kimi/scripts/lib/job-record.mjs",
  ];
  for (const runtimePath of runtimePaths) {
    const text = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(text, /import\s+\{\s*elapsedMs\s*\}\s+from\s+["']\.\/lib\/time\.mjs["']|import\s+\{\s*elapsedMs\s*\}\s+from\s+["']\.\/time\.mjs["']/);
    assert.doesNotMatch(text, /\nfunction\s+elapsedMs\s*\(/, `${runtimePath} defines elapsedMs locally`);
  }
});

test("companion job-record runtimes delegate execution classification to the shared companion classifier", () => {
  const runtimePaths = [
    "plugins/claude/scripts/lib/job-record.mjs",
    "plugins/gemini/scripts/lib/job-record.mjs",
    "plugins/kimi/scripts/lib/job-record.mjs",
  ];
  for (const runtimePath of runtimePaths) {
    const text = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(
      text,
      /import\s+\{[^}]*classifyCompanionExecution[^}]*\}\s+from\s+["']\.\/external-model-failure-core\.mjs["']/s,
      `${runtimePath} does not import classifyCompanionExecution`
    );
    assert.match(
      text,
      /export\s+function\s+classifyExecution\s*\([^)]*\)\s*\{[\s\S]{0,400}classifyCompanionExecution\s*\(/,
      `${runtimePath} classifyExecution does not delegate to classifyCompanionExecution`
    );
  }
});

test("Grok and API reviewer runtimes use the shared review-quality failure helper", () => {
  const runtimePaths = [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ];
  for (const runtimePath of runtimePaths) {
    const text = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(
      text,
      /import\s+\{[^}]*\breviewQualityFailureState\b[^}]*\}\s+from\s+["']\.\/lib\/external-model-review-quality\.mjs["']/,
      `${runtimePath} does not import reviewQualityFailureState`
    );
    assert.match(
      text,
      /reviewQualityFailureState\s*\(/,
      `${runtimePath} does not call reviewQualityFailureState`
    );
  }
});

test("Grok and API reviewer runtimes use the shared failure diagnostic builder", () => {
  const runtimePaths = [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
  ];
  for (const runtimePath of runtimePaths) {
    const text = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(
      text,
      /import\s+\{[^}]*\bbuildExternalModelFailureDiagnostic\b[^}]*\}\s+from\s+["']\.\/lib\/external-model-failure-core\.mjs["']/,
      `${runtimePath} does not import buildExternalModelFailureDiagnostic`
    );
    assert.match(
      text,
      /buildExternalModelFailureDiagnostic\s*\(/,
      `${runtimePath} does not call buildExternalModelFailureDiagnostic`
    );
  }
});

test("provider-facing policy interfaces are inventoried and wired through shared sources", () => {
  const table = readRepoJson("docs/provider-parity-table.json");
  const guardrail = table.guardrail_tests.find((entry) => entry.name === "shared policy interface usage");
  assert.ok(guardrail, "provider parity table must define shared policy interface usage guardrail");

  const requiredInterfaces = [
    "buildProviderPolicyContract",
    "evaluateSourcePacketPolicy",
    "latestSourcePacketPreviousAttempt",
    "packetRecoveryReviewSurface",
    "PROVIDER_POLICY_DOMAINS",
    "PROVIDER_ROUTE_STEPS",
    "reviewQualityPacketRecoveryErrorCode",
    "selectProviderRoute",
    "sourcePacketCanResumeWithoutResendFromJobRecord",
    "sourcePacketCanResumeWithoutResendFromPreviousAttempt",
    "sourcePacketPreviousAttemptFromJobRecord",
    "sourcePacketPreviousAttemptForContinuation",
    "sourceSentPacketRecoveryReason",
    "buildReviewAuditManifest",
    "SOURCE_CONTENT_TRANSMISSION",
    "sourceContentTransmissionForExecution",
    "buildExternalModelFailureDiagnostic",
    "reviewQualityFailureState",
    "hasSubstantiveInvalidVerdictReason",
    "diffSourceFiles",
  ];
  assert.deepEqual([...guardrail.required_interfaces].sort(), [...requiredInterfaces].sort());

  const sourceFiles = [
    "scripts/lib/auth-selection.mjs",
    "scripts/lib/provider-route-policy.mjs",
    "scripts/lib/review-prompt.mjs",
    "scripts/lib/external-review.mjs",
    "scripts/lib/diff-source.mjs",
    "scripts/lib/external-model-failure-core.mjs",
    "scripts/lib/external-model-review-quality.mjs",
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/claude/scripts/lib/job-record.mjs",
    "plugins/gemini/scripts/lib/job-record.mjs",
    "plugins/kimi/scripts/lib/job-record.mjs",
  ];
  const combined = sourceFiles.map((relPath) => readRepoFile(relPath)).join("\n");

  for (const iface of requiredInterfaces) {
    assert.match(combined, new RegExp(`\\b${iface}\\b`), `${iface} is not wired through provider-facing source`);
  }
});

test("provider runtime policy wiring is checked per adapter", () => {
  const table = readRepoJson("docs/provider-parity-table.json");
  const guardrail = table.guardrail_tests.find((entry) => entry.name === "provider runtime policy wiring");
  assert.ok(guardrail, "provider parity table must define provider runtime policy wiring guardrail");
  assert.deepEqual(
    [...guardrail.required_entrypoints].sort(),
    PROVIDER_RUNTIME_POLICY_ENTRYPOINTS.map(providerRuntimeEntryPointId).sort(),
  );

  const providers = new Set(table.providers);
  for (const entry of PROVIDER_RUNTIME_POLICY_ENTRYPOINTS) {
    assert.ok(providers.has(entry.provider), `${entry.provider} must be listed in provider parity table`);
    const source = readRepoFile(entry.runtimePath);
    assert.match(source, entry.routeSelector, `${entry.provider} runtime must use shared route selection policy`);
    assert.match(
      source,
      /buildReviewAuditManifest\s*\(/,
      `${entry.provider} runtime must build the shared review audit manifest`,
    );
    assert.match(
      source,
      /source_packet_policy/,
      `${entry.provider} runtime must inspect shared source packet policy`,
    );
    assert.match(
      source,
      /source_send_allowed\s*!==\s*false/,
      `${entry.provider} runtime must gate provider launch on source_send_allowed`,
    );
  }
});

test("source-bearing launch paths enforce shared source packet policy before provider launch", () => {
  const runtimePaths = [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
  ];

  for (const runtimePath of runtimePaths) {
    const source = readRepoFile(runtimePath);
    assert.match(source, /buildReviewAuditManifest\s*\(/, `${runtimePath} must build the shared audit manifest`);
    assert.match(source, /source_packet_policy/, `${runtimePath} must inspect the shared source packet policy`);
    assert.match(source, /source_send_allowed\s*!==\s*false/, `${runtimePath} must branch on source_send_allowed`);
    assert.match(source, /source_packet_policy_error_code/, `${runtimePath} must preserve the shared packet-policy error code`);
    assert.match(source, /allow-large-source-packet/, `${runtimePath} must expose the shared large source-packet override`);
    assert.match(source, /sourcePacketOverrideApproved/, `${runtimePath} must pass override state into the shared source packet policy`);
  }

  for (const runtimePath of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(runtimePath);
    const backgroundPreflights = source.match(/sourcePacketPolicyPreflight\s*\(\s*invocation\s*,\s*targetPrompt\s*,\s*null\s*\)/g) ?? [];
    const backgroundPreflightIndices = allIndicesOf(
      source,
      "sourcePacketPolicyPreflight(invocation, targetPrompt, null)",
    );
    const sidecarWriteIndices = allIndicesOf(
      source,
      "writePromptSidecar(resolveJobsDir(workspaceRoot)",
    );
    assert.equal(
      backgroundPreflights.length >= 2,
      true,
      `${runtimePath} must preflight source packets before background run and continue prompt sidecars`,
    );
    assert.equal(
      backgroundPreflightIndices.length,
      sidecarWriteIndices.length,
      `${runtimePath} must have one background source packet preflight for each prompt sidecar write`,
    );
    for (let i = 0; i < sidecarWriteIndices.length; i += 1) {
      assert.equal(
        backgroundPreflightIndices[i] < sidecarWriteIndices[i],
        true,
        `${runtimePath} must run source packet preflight before background prompt sidecar write ${i + 1}`,
      );
    }
  }

  const foregroundLaunchChecks = [
    {
      runtimePath: "plugins/claude/scripts/claude-companion.mjs",
      preflight: "const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, prompt, executionScope.addDir);",
      launch: "execution = await spawnClaudeOrExit(",
    },
    {
      runtimePath: "plugins/gemini/scripts/gemini-companion.mjs",
      preflight: "const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, prompt, executionScope.containment.path);",
      launch: "({ execution, executedInvocation } = await spawnGeminiOrExit(",
    },
    {
      runtimePath: "plugins/kimi/scripts/kimi-companion.mjs",
      preflight: "const sourcePacketPreflight = sourcePacketPolicyPreflight(invocation, prompt, containment.path);",
      launch: "const preflightExecution = await kimiReadinessPreflight(invocation, profile);",
    },
    {
      runtimePath: "plugins/api-reviewers/scripts/api-reviewer.mjs",
      preflight: "execution = sourcePacketPolicyFailureFromManifest(auditManifest);",
      launch: "execution = await callProvider(provider, cfg, renderedPrompt);",
    },
    {
      runtimePath: "plugins/grok/scripts/grok-web-reviewer.mjs",
      preflight: "execution = sourcePacketPolicyPreflight({ cfg, mode, prompt, scopeInfo, options: runOptions });",
      launch: "execution = await callGrokCli(cfg, prompt, {",
    },
  ];

  for (const { runtimePath, preflight, launch } of foregroundLaunchChecks) {
    const source = readRepoFile(runtimePath);
    assert.equal(
      indexOfRequired(source, preflight, runtimePath) < indexOfRequired(source, launch, runtimePath),
      true,
      `${runtimePath} must run source packet preflight before foreground provider launch`,
    );
  }
});

test("source-packet no-resend failures stay explicitly resend-gated in every packaged policy copy", () => {
  for (const runtimePath of [
    "scripts/lib/provider-route-policy.mjs",
    "plugins/claude/scripts/lib/provider-route-policy.mjs",
    "plugins/gemini/scripts/lib/provider-route-policy.mjs",
    "plugins/kimi/scripts/lib/provider-route-policy.mjs",
    "plugins/grok/scripts/lib/provider-route-policy.mjs",
    "plugins/api-reviewers/scripts/lib/provider-route-policy.mjs",
  ]) {
    const source = readRepoFile(runtimePath);
    const blockingFailures = parseStringSetLiteral(source, "SOURCE_SEND_BLOCKING_FAILURES", runtimePath);
    const resumeWithoutResendFailures = parseStringSetLiteral(
      source,
      "SOURCE_RESUME_WITHOUT_RESEND_FAILURES",
      runtimePath,
    );
    assert.equal(
      resumeWithoutResendFailures.has("step_limit_exceeded"),
      true,
      `${runtimePath} must document step_limit_exceeded as an explicit no-resend resume exception`,
    );
    assert.match(
      source,
      /hasSubstantiveInvalidVerdictReason/,
      `${runtimePath} must route substantive invalid-verdict repairs through shared review-quality classification`,
    );
    assert.match(
      source,
      /sourcePacketPreviousAttemptForContinuation/,
      `${runtimePath} must expose a continuation helper that can carry the original source attempt through no-source repair chains`,
    );
    for (const failure of resumeWithoutResendFailures) {
      assert.equal(
        blockingFailures.has(failure),
        true,
        `${runtimePath} must keep no-resend failure ${failure} in SOURCE_SEND_BLOCKING_FAILURES`,
      );
    }
  }
});

test("Grok and direct API branch-diff use shared diff packets instead of full file bodies", () => {
  const apiSource = readRepoFile("plugins/api-reviewers/scripts/api-reviewer.mjs");
  const grokSource = readRepoFile("plugins/grok/scripts/grok-web-reviewer.mjs");
  assert.match(
    apiSource,
    /import \{ diffSourceFiles \} from "\.\/lib\/diff-source\.mjs";/,
    "api-reviewer branch-diff must share the diff-packet collector used by companion reviewers",
  );
  assert.match(
    apiSource,
    /scope === "branch-diff"\s*\?\s*await readGitDiffScopeFiles\(cwd,\s*workspaceRoot,\s*scopeBase,\s*relPaths\)/,
    "api-reviewer branch-diff must render git diff packets instead of HEAD file bodies",
  );
  assert.match(
    grokSource,
    /import \{ diffSourceFiles \} from "\.\/lib\/diff-source\.mjs";/,
    "Grok branch-diff must share the diff-packet collector used by companion reviewers",
  );
  assert.match(
    grokSource,
    /scope === "branch-diff"\s*\?\s*await readGitDiffScopeFiles\(cwd,\s*workspaceRoot,\s*scopeBase,\s*relPaths\)/,
    "Grok branch-diff must render git diff packets instead of HEAD file bodies",
  );
});

test("companion continue paths carry original source attempts through no-source repairs", () => {
  for (const runtimePath of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(runtimePath);
    assert.match(
      source,
      /sourcePacketPreviousAttemptForContinuation\(prior,\s*priorRuntimeOptions\)/,
      `${runtimePath} must consider the previous runtime sidecar when continuing a failed no-source repair`,
    );
    assert.match(
      source,
      /sourcePacketCanResumeWithoutResendFromPreviousAttempt\(previousSourceAttempt\)/,
      `${runtimePath} must allow resume-without-resend from the carried original source attempt`,
    );
  }
});

test("companion JobRecord metadata preserves resume-without-source-resend as not sent", () => {
  for (const runtimePath of [
    "plugins/claude/scripts/lib/job-record.mjs",
    "plugins/gemini/scripts/lib/job-record.mjs",
    "plugins/kimi/scripts/lib/job-record.mjs",
  ]) {
    const source = readRepoFile(runtimePath);
    assert.match(source, /SOURCE_CONTENT_TRANSMISSION/);
    assert.match(source, /invocation\.resume_without_source_resend === true/);
    assert.match(source, /SOURCE_CONTENT_TRANSMISSION\.NOT_SENT/);
  }
});

test("Grok auto transport stays an adapter capability and uses shared source-transmission policy", () => {
  const source = readRepoFile("plugins/grok/scripts/grok-web-reviewer.mjs");
  assert.match(
    source,
    /function\s+modeSendsSelectedSource\s*\(/,
    "Grok runtime must make source-bearing semantics mode-derived, not hardcoded",
  );
  assert.match(
    source,
    /sourceBearing:\s*modeSendsSelectedSource\(mode\)/,
    "Grok source packet policy must use mode-derived source-bearing semantics",
  );
  assert.match(
    source,
    /sourceContentTransmissionForExecution\s*,?\s*\}\s+from\s+["']\.\/lib\/external-review\.mjs["']/,
    "Grok runtime must consume shared sourceContentTransmissionForExecution",
  );
  assert.doesNotMatch(
    source,
    /function\s+sourceTransmission\s*\(/,
    "Grok must not keep a separate sourceTransmission policy helper",
  );
  assert.match(source, /requested_transport/);
  assert.match(source, /canAutoFallbackFromCliExecution/);
  assert.match(source, /cliRequestDiagnosticsForFallback/);
  assert.match(
    source,
    /\}\s+from\s+["']\.\/lib\/grok-transport-adapters\.mjs["']/,
    "Grok runtime must import transport decisions from the shared Grok transport adapter module",
  );
  for (const exportedHelper of [
    "resolveGrokConfig",
    "resolveGrokFallbackConfig",
    "webAutoFallbackConfig",
    "promptBudgetEnvName",
    "canAutoFallbackFromCliExecution",
    "cliRequestDiagnosticsForFallback",
  ]) {
    assert.match(
      source,
      new RegExp(`\\b${exportedHelper}\\b`),
      `Grok runtime must consume ${exportedHelper} from the transport adapter module`,
    );
  }
  for (const localTransportHelper of [
    "transportMode",
    "cliConfig",
    "webConfig",
    "config",
    "fallbackConfig",
    "webAutoFallbackConfig",
    "canAutoFallbackFromCliExecution",
    "cliRequestDiagnosticsForFallback",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`function\\s+${localTransportHelper}\\s*\\(`),
      `Grok runtime must not keep local transport helper ${localTransportHelper}`,
    );
  }
  assert.doesNotMatch(
    source,
    /const\s+GROK_CLI_AUTO_FALLBACK_CODES\s*=/,
    "Grok CLI auto fallback code taxonomy must live in the transport adapter module",
  );
  assert.doesNotMatch(
    source,
    /cfg\.provider\s*===\s*["']grok-web["']\s*\?\s*["']grok["']/,
    "Grok packet recovery must not hardcode transport-provider aliases",
  );
  assert.doesNotMatch(
    source,
    /chars exceeds GROK_(?:CLI|WEB)_MAX_PROMPT_CHARS=/,
    "Grok prompt budget diagnostics must use promptBudgetEnvName(cfg), not hardcoded transport env names",
  );
  const adapterSource = readRepoFile("plugins/grok/scripts/lib/grok-transport-adapters.mjs");
  assert.match(
    adapterSource,
    /canonical_provider/,
    "Grok packet recovery must derive the canonical provider from config metadata",
  );
  assert.match(
    adapterSource,
    /providerApiCapability\(GROK_CANONICAL_PROVIDER\)/,
    "Grok transport adapter must derive direct API credential names from canonical provider metadata",
  );
  const cliFallbackBody = functionBody(adapterSource, "cliFallbackConfig");
  const webFallbackBody = functionBody(adapterSource, "webFallbackConfig");
  assert.match(
    cliFallbackBody,
    /\breturn\s+cliConfig\(/,
    "Grok CLI fallback config must delegate to cliConfig instead of copying transport facts",
  );
  assert.match(
    webFallbackBody,
    /\breturn\s+webConfig\(/,
    "Grok web fallback config must delegate to webConfig instead of copying transport facts",
  );
  assert.doesNotMatch(
    adapterSource,
    /providerApiCapability\(["']grok["']\)/,
    "Grok transport adapter must not hardcode direct API credential aliases",
  );
});

test("subscription rescue modes are source-bearing even though they are not review slots", () => {
  for (const runtimePath of [
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readRepoFile(runtimePath);
    assert.match(
      source,
      /modeSendsSelectedSource\(mode\)\s*\{[\s\S]*mode\s*===\s*"rescue"/,
      `${runtimePath} must classify rescue as source-bearing for shared source-send policy`,
    );
    assert.match(
      source,
      /mode_profile_name\s*===\s*"rescue"[\s\S]*return null/,
      `${runtimePath} must keep rescue out of review-quality audit semantics`,
    );
  }
});

test("reviewer runtimes use the shared privacy redactor", () => {
  const runtimePaths = [
    ["plugins/api-reviewers/scripts/api-reviewer.mjs", "./lib/privacy-redaction.mjs"],
    ["plugins/claude/scripts/lib/job-record.mjs", "./privacy-redaction.mjs"],
    ["plugins/gemini/scripts/lib/job-record.mjs", "./privacy-redaction.mjs"],
    ["plugins/grok/scripts/grok-web-reviewer.mjs", "./lib/privacy-redaction.mjs"],
    ["plugins/kimi/scripts/lib/job-record.mjs", "./privacy-redaction.mjs"],
  ];
  for (const [runtimePath, importPath] of runtimePaths) {
    const text = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(
      text,
      new RegExp(`import\\s+\\{[^}]*\\bbuildPrivacyRedactor\\b[^}]*\\}\\s+from\\s+["']${importPath.replaceAll(".", "\\.").replaceAll("/", "\\/")}["']`, "s"),
      `${runtimePath} does not import buildPrivacyRedactor`
    );
    assert.doesNotMatch(text, /\nfunction\s+secretValueRedactor\s*\(/, `${runtimePath} defines secretValueRedactor locally`);
    assert.doesNotMatch(text, /\nfunction\s+selectedSourceBodyRedactor\s*\(/, `${runtimePath} defines selectedSourceBodyRedactor locally`);
  }
});

test("lib/auth-selection.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/auth-selection.mjs"), "utf8");
  for (const plugin of CLAUDE_GEMINI_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/auth-selection.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `auth-selection.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/provider-env.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/provider-env.mjs"), "utf8");
  for (const plugin of PROVIDER_ENV_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/provider-env.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `provider-env.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/codex-env.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/codex-env.mjs"), "utf8");
  for (const plugin of CODEX_ENV_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/codex-env.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `codex-env.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/git-env.mjs: api-reviewers packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "plugins/claude/scripts/lib/git-env.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/api-reviewers/scripts/lib/git-env.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "git-env.mjs packaging copy drifted in api-reviewers");
});

test("lib/git-env.mjs: grok packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "plugins/claude/scripts/lib/git-env.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/grok/scripts/lib/git-env.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "git-env.mjs packaging copy drifted in grok");
});

test("lib/git-binary.mjs: api-reviewers packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "plugins/claude/scripts/lib/git-binary.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/api-reviewers/scripts/lib/git-binary.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "git-binary.mjs packaging copy drifted in api-reviewers");
});

test("lib/git-binary.mjs: grok packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "plugins/claude/scripts/lib/git-binary.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/grok/scripts/lib/git-binary.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "git-binary.mjs packaging copy drifted in grok");
});

test("lib/usage-limit.mjs: api-reviewers packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/usage-limit.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/api-reviewers/scripts/lib/usage-limit.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "usage-limit.mjs packaging copy drifted in api-reviewers");
});

test("lib/usage-limit.mjs: grok packaging copy matches the companion shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/usage-limit.mjs"), "utf8");
  const copy = readFileSync(
    path.join(REPO_ROOT, "plugins/grok/scripts/lib/usage-limit.mjs"),
    "utf8"
  );
  assert.equal(copy, canonical, "usage-limit.mjs packaging copy drifted in grok");
});

test("lib/usage-limit.mjs: companion packaging copies match the top-level shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/usage-limit.mjs"), "utf8");
  for (const plugin of COMPANION_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/usage-limit.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `usage-limit.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/review-workload.mjs: reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/review-workload.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/review-workload.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `review-workload.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/process-identity.mjs: reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/process-identity.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/process-identity.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `process-identity.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lib/provider-identity.mjs: reviewer packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/provider-identity.mjs"), "utf8");
  for (const plugin of REVIEW_PROMPT_PLUGIN_TARGETS) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/provider-identity.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `provider-identity.mjs packaging copy drifted in ${plugin}`);
  }
});

test("lint:sync includes fixers for provider reliability shared files", () => {
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts["lint:sync"], /sync-review-workload\.mjs --check/);
  assert.match(packageJson.scripts["lint:sync"], /sync-process-identity\.mjs --check/);
  assert.match(packageJson.scripts["lint:sync"], /sync-provider-identity\.mjs --check/);
});

test("source-bearing launch paths enforce provider workload admission before provider launch", () => {
  for (const runtimePath of [
    "plugins/api-reviewers/scripts/api-reviewer.mjs",
    "plugins/claude/scripts/claude-companion.mjs",
    "plugins/gemini/scripts/gemini-companion.mjs",
    "plugins/grok/scripts/grok-web-reviewer.mjs",
    "plugins/kimi/scripts/kimi-companion.mjs",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, runtimePath), "utf8");
    assert.match(
      source,
      /acquireProviderWorkloadLease/,
      `${runtimePath} must acquire the provider workload lease before source-bearing launch`,
    );
    assert.match(
      source,
      /releaseProviderWorkloadLease/,
      `${runtimePath} must release the provider workload lease after launch completion`,
    );
  }
});

test("claude OAuth preflight releases provider workload lease before exit-capable finalization", () => {
  const source = readFileSync(path.join(REPO_ROOT, "plugins/claude/scripts/claude-companion.mjs"), "utf8");
  const branch = source.match(/if \(preflightExecution\) \{(?<body>[\s\S]*?)\n  \}\n\n  exitIfCancelledBeforeSpawn/u);
  assert.ok(branch?.groups?.body, "Claude OAuth preflight branch not found");
  const releaseIndex = branch.groups.body.indexOf("releaseProviderWorkloadLease(workloadLease)");
  const finalizeIndex = branch.groups.body.indexOf("exitIfFinalizationFailed(invocation, preflightExecution");
  assert.notEqual(releaseIndex, -1, "Claude OAuth preflight branch must release provider workload lease");
  assert.notEqual(finalizeIndex, -1, "Claude OAuth preflight branch must finalize the preflight JobRecord");
  assert.ok(
    releaseIndex < finalizeIndex,
    "Claude OAuth preflight branch must release provider workload lease before exitIfFinalizationFailed can process.exit",
  );
});

test("lib/git-env.mjs: kimi stripped key list matches the companion shared source", () => {
  const sortKeys = (keys) => [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    sortKeys(KIMI_STRIPPED_GIT_ENV_KEYS),
    sortKeys(CLAUDE_STRIPPED_GIT_ENV_KEYS),
    "git-env.mjs stripped key list drifted in kimi"
  );
  assert.deepEqual(
    sortKeys(GROK_STRIPPED_GIT_ENV_KEYS),
    sortKeys(CLAUDE_STRIPPED_GIT_ENV_KEYS),
    "git-env.mjs stripped key list drifted in grok"
  );
});

test("companion plugin target list matches packaged companion-common copies", () => {
  const pluginsWithCompanionCopy = readdirSync(path.join(REPO_ROOT, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((plugin) =>
      existsSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/companion-common.mjs`))
    )
    .sort();

  assert.deepEqual([...COMPANION_PLUGIN_TARGETS].sort(), pluginsWithCompanionCopy);
});

test("codex-env plugin target list matches packaged codex-env copies", () => {
  const pluginsWithCodexEnvCopy = readdirSync(path.join(REPO_ROOT, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((plugin) =>
      existsSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/codex-env.mjs`))
    )
    .sort();

  assert.deepEqual([...CODEX_ENV_PLUGIN_TARGETS].sort(), pluginsWithCodexEnvCopy);
});

for (const file of VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{${COMPANION_PLUGIN_TARGETS.join(",")}}`, () => {
    const copies = COMPANION_PLUGIN_TARGETS.map((plugin) => [
      plugin,
      readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib`, file), "utf8"),
    ]);
    for (const [plugin, text] of copies.slice(1)) {
      assert.equal(text, copies[0][1], `${file} drift between claude and ${plugin}`);
    }
  });
}

for (const file of CLAUDE_GEMINI_VERBATIM_FILES) {
  test(`lib/${file}: byte-identical across plugins/{${CLAUDE_GEMINI_PLUGIN_TARGETS.join(",")}}`, () => {
    const copies = CLAUDE_GEMINI_PLUGIN_TARGETS.map((plugin) => [
      plugin,
      readFileSync(path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib`, file), "utf8"),
    ]);
    for (const [plugin, text] of copies.slice(1)) {
      assert.equal(text, copies[0][1], `${file} drift between claude and ${plugin}`);
    }
  });
}

// The previous render.mjs guard ("no surviving Codex refs") was removed
// together with render.mjs itself in T7.5 — see header comment above.

test("lib/diff-source.mjs: plugin packaging copies match the canonical shared source", () => {
  const canonical = readFileSync(path.join(REPO_ROOT, "scripts/lib/diff-source.mjs"), "utf8");
  for (const plugin of [...COMPANION_PLUGIN_TARGETS, "api-reviewers", "grok"]) {
    const copy = readFileSync(
      path.join(REPO_ROOT, `plugins/${plugin}/scripts/lib/diff-source.mjs`),
      "utf8"
    );
    assert.equal(copy, canonical, `diff-source.mjs packaging copy drifted in ${plugin}`);
  }
});
