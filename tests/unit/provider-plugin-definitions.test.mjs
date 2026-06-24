import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const HELPER_PATH = path.resolve("scripts/lib/provider-plugin-definitions.mjs");

async function loadDefinitions() {
  assert.equal(existsSync(HELPER_PATH), true, "shared provider metadata helper must exist");
  return import(pathToFileURL(HELPER_PATH).href);
}

test("shared provider metadata defines AGY as a companion provider for both host packages", async () => {
  const {
    providerDefinition,
    companionProviderDefinitions,
    directApiProviderDefinitions,
  } = await loadDefinitions();

  const agy = providerDefinition("agy");
  assert.equal(agy.id, "agy");
  assert.equal(agy.family, "companion");
  assert.equal(agy.displayName, "Google Antigravity CLI");
  assert.equal(agy.shortDisplayName, "AGY");
  assert.equal(agy.commandPrefix, "agy");
  assert.equal(agy.sourceProvider, "agy");
  assert.equal(agy.packageDirectory, "agy");
  assert.equal(agy.binary, "agy-companion.mjs");
  assert.equal(agy.pluginDataEnv, "AGY_PLUGIN_DATA");
  assert.equal(agy.sessionIdEnv, "AGY_COMPANION_SESSION_ID");
  assert.equal(agy.jobRecordSessionField, "agy_session_id");
  assert.deepEqual(agy.workflows, [
    "review",
    "adversarial-review",
    "custom-review",
    "setup",
    "status",
    "result",
    "cancel",
  ]);
  assert.deepEqual(agy.generatedSkills, ["delegation"]);
  assert.deepEqual(agy.codex, {
    manifestName: "relay-agy",
    packageDirectory: "agy",
    manifestCapabilities: ["Interactive", "Read"],
  });
  assert.deepEqual(agy.claude, {
    manifestName: "relay-agy",
    packageDirectory: "relay-agy",
    synthesizeCustomReview: false,
  });

  assert.ok(companionProviderDefinitions().some((provider) => provider.id === "agy"));
  assert.equal(directApiProviderDefinitions().some((provider) => provider.id === "agy"), false);
});

test("shared provider metadata keeps provider ids, command prefixes, and package targets unique", async () => {
  const { RELAY_PROVIDER_DEFINITIONS } = await loadDefinitions();
  const definitions = Object.values(RELAY_PROVIDER_DEFINITIONS);

  for (const selector of [
    (provider) => provider.id,
    (provider) => provider.commandPrefix,
    (provider) => provider.codex.manifestName,
    (provider) => provider.codex.packageDirectory,
    (provider) => provider.claude.manifestName,
    (provider) => provider.claude.packageDirectory,
  ]) {
    const values = definitions.map(selector);
    assert.deepEqual(values, [...new Set(values)], `duplicate provider metadata values: ${values.join(", ")}`);
  }
});
