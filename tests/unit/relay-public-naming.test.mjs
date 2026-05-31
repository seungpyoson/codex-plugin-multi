import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

function readJson(relPath) {
  return JSON.parse(readFileSync(relPath, "utf8"));
}

test("repo package and marketplace expose Relay public names", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "relay");
  assert.equal(pkg.repository.url, "https://github.com/seungpyoson/relay.git");

  const marketplace = readJson(".agents/plugins/marketplace.json");
  const publicPlugins = marketplace.plugins.filter((plugin) => plugin.policy.installation === "AVAILABLE");
  assert.equal(marketplace.name, "relay-for-codex");
  assert.equal(marketplace.interface.displayName, "Relay for Codex");
  assert.deepEqual(
    publicPlugins.map((plugin) => plugin.name),
    [
      "relay-claude",
      "relay-gemini",
      "relay-kimi",
      "relay-grok",
      "relay-glm",
      "relay-deepseek",
    ],
  );
  assert.equal(publicPlugins.some((plugin) => plugin.name === "api-reviewers"), false);
  assert.equal(
    marketplace.plugins.some((plugin) =>
      plugin.name === "api-reviewers" && plugin.policy.installation === "NOT_AVAILABLE"
    ),
    true,
  );
});

test("marketplace plugin IDs match their source manifests", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  for (const plugin of marketplace.plugins) {
    const sourcePath = plugin.source.path.replace(/^\.\//, "");
    const manifestPath = path.join(sourcePath, ".codex-plugin", "plugin.json");
    assert.equal(existsSync(manifestPath), true, `${plugin.name} manifest exists`);
    const manifest = readJson(manifestPath);
    assert.equal(manifest.name, plugin.name, `${plugin.name} manifest name matches marketplace ID`);
    assert.equal(manifest.repository, "https://github.com/seungpyoson/relay", plugin.name);
    assert.equal(manifest.homepage, "https://github.com/seungpyoson/relay", plugin.name);
  }
});

test("Codex direct API reviewers are split into relay-glm and relay-deepseek plugins", () => {
  for (const provider of ["glm", "deepseek"]) {
    const pluginName = `relay-${provider}`;
    const pluginRoot = path.join("plugins", pluginName);
    assert.equal(existsSync(pluginRoot), true, `${pluginName} plugin root exists`);
    assert.equal(readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json")).skills, "./skills");

    const providers = readJson(path.join(pluginRoot, "config", "providers.json"));
    assert.deepEqual(Object.keys(providers), [provider], `${pluginName} config contains only ${provider}`);

    const commands = [
      `${provider}-review.md`,
      `${provider}-adversarial-review.md`,
      `${provider}-custom-review.md`,
      `${provider}-setup.md`,
    ];
    for (const command of commands) {
      assert.equal(existsSync(path.join(pluginRoot, "commands", command)), true, `${pluginName}/${command}`);
    }
  }
});

test("Claude relay marketplace exposes relay-for-claude suite over relay provider plugins", () => {
  const marketplace = readJson("relay/.claude-plugin/marketplace.json");
  const publicPlugins = marketplace.plugins.filter((plugin) => plugin.policy?.installation !== "HIDDEN");
  const hiddenPlugins = marketplace.plugins.filter((plugin) => plugin.policy?.installation === "HIDDEN");
  assert.equal(marketplace.name, "relay-for-claude");
  assert.deepEqual(
    publicPlugins.map((plugin) => plugin.name),
    [
      "relay-gemini",
      "relay-grok",
      "relay-kimi",
      "relay-glm",
      "relay-deepseek",
    ],
  );
  assert.deepEqual(hiddenPlugins.map((plugin) => plugin.name), ["relay-api-reviewers"]);
  assert.equal(hiddenPlugins[0].source, "../plugins/api-reviewers");
  assert.equal(publicPlugins.some((plugin) => plugin.name === "relay-claude"), false);
  for (const plugin of marketplace.plugins) {
    if (plugin.policy?.installation !== "HIDDEN") {
      assert.equal(plugin.source, `./${plugin.name}`);
    }
    const manifestPath = path.join("relay", plugin.source, ".claude-plugin", "plugin.json");
    assert.equal(existsSync(manifestPath), true);
    assert.equal(readJson(manifestPath).name, plugin.name);
  }
});

test("release verification guide uses Relay marketplace commands in active instructions", () => {
  const releaseGuide = readFileSync("docs/release-verification.md", "utf8");
  const activeInstructions = releaseGuide.split("## Evidence log")[0];

  assert.match(activeInstructions, /codex plugin marketplace remove relay-for-codex/);
  assert.match(activeInstructions, /codex plugin marketplace add seungpyoson\/relay/);
  assert.match(activeInstructions, /marketplace `relay-for-codex` was added/);
  assert.doesNotMatch(activeInstructions, /codex-plugin-multi/);
});
