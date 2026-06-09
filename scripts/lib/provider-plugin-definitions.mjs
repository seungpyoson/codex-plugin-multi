const COMPANION_REVIEW_WORKFLOWS = Object.freeze([
  "review",
  "adversarial-review",
  "rescue",
  "setup",
  "status",
  "result",
  "cancel",
]);

const COMPANION_CUSTOM_REVIEW_WORKFLOWS = Object.freeze([
  "review",
  "adversarial-review",
  "custom-review",
  "setup",
  "status",
  "result",
  "cancel",
]);

const REVIEWER_WORKFLOWS = Object.freeze([
  "review",
  "adversarial-review",
  "custom-review",
  "setup",
]);

function freezeProvider(definition) {
  return Object.freeze({
    ...definition,
    workflows: Object.freeze([...definition.workflows]),
    generatedSkills: Object.freeze([...(definition.generatedSkills ?? [])]),
    codex: Object.freeze({
      ...definition.codex,
      manifestCapabilities: Object.freeze([...(definition.codex.manifestCapabilities ?? [])]),
    }),
    claude: Object.freeze({ ...definition.claude }),
  });
}

function envPrefix(providerId) {
  return providerId.toUpperCase().replaceAll("-", "_");
}

function articleFor(value) {
  return /^[AEIOU]/i.test(value) ? "an" : "a";
}

function companionProvider({
  id,
  displayName,
  shortDisplayName,
  homeDir,
  authFlag = "",
  hasMaxSteps = false,
  workflows = COMPANION_REVIEW_WORKFLOWS,
  setupReadiness,
  resultDescription,
  synthesizeCustomReview,
}) {
  const prefix = envPrefix(id);
  const generatedResultDescription =
    resultDescription ??
    `Use when showing the persisted result for ${articleFor(shortDisplayName)} ${shortDisplayName}-plugin job.`;
  const descriptionFields = {
    reviewDescription: `Use when asking ${displayName} to review the current diff, files, or focus area.`,
    adversarialDescription: `Use when asking ${displayName} to challenge a design or diff adversarially.`,
    setupDescription: `Use when checking ${displayName} ${setupReadiness}.`,
    statusDescription: `Use when listing active or recent ${shortDisplayName}-plugin jobs.`,
    resultDescription: generatedResultDescription,
    cancelDescription: `Use when cancelling a running ${shortDisplayName}-plugin background job.`,
  };

  if (workflows.includes("rescue")) {
    descriptionFields.rescueDescription =
      `Use when delegating investigation, fixes, or follow-up rescue work to ${displayName}.`;
    descriptionFields.delegationDescription =
      `Use when delegating review, adversarial review, rescue, and setup to ${displayName}.`;
  }

  if (workflows.includes("custom-review")) {
    descriptionFields.customReviewDescription = `Use when asking ${displayName} to review explicit files.`;
    descriptionFields.delegationDescription =
      `Use when delegating review, adversarial review, custom review, and setup to ${displayName}.`;
  }

  return freezeProvider({
    id,
    family: "companion",
    plugin: id,
    displayName,
    display: displayName,
    shortDisplayName,
    shortDisplay: shortDisplayName,
    commandPrefix: id,
    sourceProvider: id,
    packageDirectory: id,
    binary: `${id}-companion.mjs`,
    authFlag,
    homeDir,
    ...(hasMaxSteps ? { hasMaxSteps } : {}),
    pluginDataEnv: `${prefix}_PLUGIN_DATA`,
    sessionIdEnv: `${prefix}_COMPANION_SESSION_ID`,
    jobRecordSessionField: `${id}_session_id`,
    reviewTimeoutEnv: `${prefix}_REVIEW_TIMEOUT_MS`,
    reviewTimeoutDefaultMs: 900000,
    workflows,
    generatedSkills: ["delegation"],
    ...descriptionFields,
    codex: {
      manifestName: `relay-${id}`,
      packageDirectory: id,
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: `relay-${id}`,
      packageDirectory: `relay-${id}`,
      synthesizeCustomReview,
    },
  });
}

function directApiProvider({ id, displayName }) {
  const packageName = `relay-${id}`;
  return freezeProvider({
    id,
    provider: id,
    family: "direct-api",
    displayName,
    display: displayName,
    shortDisplayName: displayName,
    shortDisplay: displayName,
    commandPrefix: id,
    sourceProvider: packageName,
    packageDirectory: packageName,
    binary: "api-reviewer.mjs",
    pluginDataEnv: "API_REVIEWERS_PLUGIN_DATA",
    sessionIdEnv: null,
    jobRecordSessionField: null,
    workflows: REVIEWER_WORKFLOWS,
    generatedSkills: [],
    codex: {
      manifestName: packageName,
      packageDirectory: packageName,
      manifestCapabilities: ["Read"],
    },
    claude: {
      manifestName: packageName,
      packageDirectory: packageName,
      synthesizeCustomReview: false,
      description: `Delegate code reviews to ${displayName} direct API from within Claude Code.`,
    },
  });
}

export const RELAY_PROVIDER_DEFINITIONS = Object.freeze({
  claude: companionProvider({
    id: "claude",
    displayName: "Claude Code",
    shortDisplayName: "Claude",
    authFlag: "--auth-mode subscription",
    homeDir: "~/.claude",
    setupReadiness: "installation and OAuth readiness",
    resultDescription: "Use when showing the stored result of a finished Claude-plugin job.",
    synthesizeCustomReview: false,
  }),
  gemini: companionProvider({
    id: "gemini",
    displayName: "Gemini CLI",
    shortDisplayName: "Gemini",
    homeDir: "~/.gemini",
    setupReadiness: "availability and OAuth readiness",
    synthesizeCustomReview: true,
  }),
  grok: freezeProvider({
    id: "grok",
    family: "grok",
    plugin: "grok",
    displayName: "Grok",
    display: "Grok",
    shortDisplayName: "Grok",
    shortDisplay: "Grok",
    commandPrefix: "grok",
    sourceProvider: "grok",
    packageDirectory: "grok",
    binary: "grok-companion.mjs",
    pluginDataEnv: "GROK_PLUGIN_DATA",
    sessionIdEnv: null,
    jobRecordSessionField: null,
    workflows: REVIEWER_WORKFLOWS,
    generatedSkills: ["delegation"],
    codex: {
      manifestName: "relay-grok",
      packageDirectory: "grok",
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: "relay-grok",
      packageDirectory: "relay-grok",
      synthesizeCustomReview: false,
    },
  }),
  kimi: companionProvider({
    id: "kimi",
    displayName: "Kimi Code CLI",
    shortDisplayName: "Kimi",
    homeDir: "~/.kimi",
    hasMaxSteps: true,
    setupReadiness: "availability and OAuth readiness",
    synthesizeCustomReview: true,
  }),
  agy: companionProvider({
    id: "agy",
    displayName: "Google Antigravity CLI",
    shortDisplayName: "AGY",
    homeDir: "~/.antigravity",
    workflows: COMPANION_CUSTOM_REVIEW_WORKFLOWS,
    setupReadiness: "installation and authentication readiness",
    synthesizeCustomReview: false,
  }),
  glm: directApiProvider({
    id: "glm",
    displayName: "GLM",
  }),
  deepseek: directApiProvider({
    id: "deepseek",
    displayName: "DeepSeek",
  }),
});

export const RELAY_PROVIDER_ORDER = Object.freeze(["gemini", "grok", "kimi", "agy", "glm", "deepseek"]);

export function providerDefinition(providerId) {
  const definition = RELAY_PROVIDER_DEFINITIONS[providerId];
  if (!definition) throw new Error(`unknown relay provider: ${providerId}`);
  return definition;
}

export function companionProviderDefinitions() {
  return Object.freeze(
    Object.values(RELAY_PROVIDER_DEFINITIONS).filter((definition) => definition.family === "companion"),
  );
}

export function directApiProviderDefinitions() {
  return Object.freeze(
    ["deepseek", "glm"].map((providerId) => RELAY_PROVIDER_DEFINITIONS[providerId]),
  );
}

export function claudeRelayProviderDefinitions() {
  return Object.freeze(RELAY_PROVIDER_ORDER.map((providerId) => providerDefinition(providerId)));
}

export function providerPackageName(providerId, host = "codex") {
  const definition = providerDefinition(providerId);
  const hostDefinition = definition[host];
  if (!hostDefinition?.manifestName) throw new Error(`unknown host package target: ${host}`);
  return hostDefinition.manifestName;
}

export function codexPackageManifest(definition) {
  return {
    name: definition.codex.manifestName,
    capabilities: [...definition.codex.manifestCapabilities],
  };
}

export function claudePackageManifest(definition, codexManifest) {
  return {
    ...codexManifest,
    name: definition.claude.manifestName,
  };
}
