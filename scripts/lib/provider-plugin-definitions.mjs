const COMPANION_REVIEW_WORKFLOWS = Object.freeze([
  "review",
  "adversarial-review",
  "rescue",
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

export const RELAY_PROVIDER_DEFINITIONS = Object.freeze({
  claude: freezeProvider({
    id: "claude",
    family: "companion",
    plugin: "claude",
    displayName: "Claude Code",
    display: "Claude Code",
    shortDisplayName: "Claude",
    shortDisplay: "Claude",
    commandPrefix: "claude",
    sourceProvider: "claude",
    packageDirectory: "claude",
    binary: "claude-companion.mjs",
    authFlag: "--auth-mode subscription",
    homeDir: "~/.claude",
    pluginDataEnv: "CLAUDE_PLUGIN_DATA",
    sessionIdEnv: "CLAUDE_COMPANION_SESSION_ID",
    jobRecordSessionField: "claude_session_id",
    reviewTimeoutEnv: "CLAUDE_REVIEW_TIMEOUT_MS",
    reviewTimeoutDefaultMs: 900000,
    workflows: COMPANION_REVIEW_WORKFLOWS,
    generatedSkills: ["delegation"],
    reviewDescription: "Use when asking Claude Code to review the current diff, files, or focus area.",
    adversarialDescription: "Use when asking Claude Code to challenge a design or diff adversarially.",
    rescueDescription: "Use when delegating investigation, fixes, or follow-up rescue work to Claude Code.",
    setupDescription: "Use when checking Claude Code installation and OAuth readiness.",
    statusDescription: "Use when listing active or recent Claude-plugin jobs.",
    resultDescription: "Use when showing the stored result of a finished Claude-plugin job.",
    cancelDescription: "Use when cancelling a running Claude-plugin background job.",
    delegationDescription: "Use when delegating review, adversarial review, rescue, and setup to Claude Code.",
    codex: {
      manifestName: "relay-claude",
      packageDirectory: "claude",
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: "relay-claude",
      packageDirectory: "relay-claude",
      synthesizeCustomReview: false,
    },
  }),
  gemini: freezeProvider({
    id: "gemini",
    family: "companion",
    plugin: "gemini",
    displayName: "Gemini CLI",
    display: "Gemini CLI",
    shortDisplayName: "Gemini",
    shortDisplay: "Gemini",
    commandPrefix: "gemini",
    sourceProvider: "gemini",
    packageDirectory: "gemini",
    binary: "gemini-companion.mjs",
    authFlag: "",
    homeDir: "~/.gemini",
    pluginDataEnv: "GEMINI_PLUGIN_DATA",
    sessionIdEnv: "GEMINI_COMPANION_SESSION_ID",
    jobRecordSessionField: "gemini_session_id",
    reviewTimeoutEnv: "GEMINI_REVIEW_TIMEOUT_MS",
    reviewTimeoutDefaultMs: 900000,
    workflows: COMPANION_REVIEW_WORKFLOWS,
    generatedSkills: ["delegation"],
    reviewDescription: "Use when asking Gemini CLI to review the current diff, files, or focus area.",
    adversarialDescription: "Use when asking Gemini CLI to challenge a design or diff adversarially.",
    rescueDescription: "Use when delegating investigation, fixes, or follow-up rescue work to Gemini CLI.",
    setupDescription: "Use when checking Gemini CLI availability and OAuth readiness.",
    statusDescription: "Use when listing active or recent Gemini-plugin jobs.",
    resultDescription: "Use when showing the persisted result for a Gemini-plugin job.",
    cancelDescription: "Use when cancelling a running Gemini-plugin background job.",
    delegationDescription: "Use when delegating review, adversarial review, rescue, and setup to Gemini CLI.",
    codex: {
      manifestName: "relay-gemini",
      packageDirectory: "gemini",
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: "relay-gemini",
      packageDirectory: "relay-gemini",
      synthesizeCustomReview: true,
    },
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
  kimi: freezeProvider({
    id: "kimi",
    family: "companion",
    plugin: "kimi",
    displayName: "Kimi Code CLI",
    display: "Kimi Code CLI",
    shortDisplayName: "Kimi",
    shortDisplay: "Kimi",
    commandPrefix: "kimi",
    sourceProvider: "kimi",
    packageDirectory: "kimi",
    binary: "kimi-companion.mjs",
    authFlag: "",
    homeDir: "~/.kimi",
    hasMaxSteps: true,
    pluginDataEnv: "KIMI_PLUGIN_DATA",
    sessionIdEnv: "KIMI_COMPANION_SESSION_ID",
    jobRecordSessionField: "kimi_session_id",
    reviewTimeoutEnv: "KIMI_REVIEW_TIMEOUT_MS",
    reviewTimeoutDefaultMs: 900000,
    workflows: COMPANION_REVIEW_WORKFLOWS,
    generatedSkills: ["delegation"],
    reviewDescription: "Use when asking Kimi Code CLI to review the current diff, files, or focus area.",
    adversarialDescription: "Use when asking Kimi Code CLI to challenge a design or diff adversarially.",
    rescueDescription: "Use when delegating investigation, fixes, or follow-up rescue work to Kimi Code CLI.",
    setupDescription: "Use when checking Kimi Code CLI availability and OAuth readiness.",
    statusDescription: "Use when listing active or recent Kimi-plugin jobs.",
    resultDescription: "Use when showing the persisted result for a Kimi-plugin job.",
    cancelDescription: "Use when cancelling a running Kimi-plugin background job.",
    delegationDescription: "Use when delegating review, adversarial review, rescue, and setup to Kimi Code CLI.",
    codex: {
      manifestName: "relay-kimi",
      packageDirectory: "kimi",
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: "relay-kimi",
      packageDirectory: "relay-kimi",
      synthesizeCustomReview: true,
    },
  }),
  agy: freezeProvider({
    id: "agy",
    family: "companion",
    plugin: "agy",
    displayName: "Google Antigravity CLI",
    display: "Google Antigravity CLI",
    shortDisplayName: "AGY",
    shortDisplay: "AGY",
    commandPrefix: "agy",
    sourceProvider: "agy",
    packageDirectory: "agy",
    binary: "agy-companion.mjs",
    authFlag: "",
    homeDir: "~/.antigravity",
    pluginDataEnv: "AGY_PLUGIN_DATA",
    sessionIdEnv: "AGY_COMPANION_SESSION_ID",
    jobRecordSessionField: "agy_session_id",
    reviewTimeoutEnv: "AGY_REVIEW_TIMEOUT_MS",
    reviewTimeoutDefaultMs: 900000,
    workflows: ["review", "adversarial-review", "custom-review", "setup", "status", "result", "cancel"],
    generatedSkills: ["delegation"],
    reviewDescription: "Use when asking Google Antigravity CLI to review the current diff, files, or focus area.",
    adversarialDescription: "Use when asking Google Antigravity CLI to challenge a design or diff adversarially.",
    customReviewDescription: "Use when asking Google Antigravity CLI to review explicit files.",
    setupDescription: "Use when checking Google Antigravity CLI installation and authentication readiness.",
    statusDescription: "Use when listing active or recent AGY-plugin jobs.",
    resultDescription: "Use when showing the persisted result for an AGY-plugin job.",
    cancelDescription: "Use when cancelling a running AGY-plugin background job.",
    delegationDescription: "Use when delegating review, adversarial review, custom review, and setup to Google Antigravity CLI.",
    codex: {
      manifestName: "relay-agy",
      packageDirectory: "agy",
      manifestCapabilities: ["Interactive", "Read"],
    },
    claude: {
      manifestName: "relay-agy",
      packageDirectory: "relay-agy",
      synthesizeCustomReview: false,
    },
  }),
  glm: freezeProvider({
    id: "glm",
    provider: "glm",
    family: "direct-api",
    displayName: "GLM",
    display: "GLM",
    shortDisplayName: "GLM",
    shortDisplay: "GLM",
    commandPrefix: "glm",
    sourceProvider: "relay-glm",
    packageDirectory: "relay-glm",
    binary: "api-reviewer.mjs",
    pluginDataEnv: "API_REVIEWERS_PLUGIN_DATA",
    sessionIdEnv: null,
    jobRecordSessionField: null,
    workflows: REVIEWER_WORKFLOWS,
    generatedSkills: [],
    codex: {
      manifestName: "relay-glm",
      packageDirectory: "relay-glm",
      manifestCapabilities: ["Read"],
    },
    claude: {
      manifestName: "relay-glm",
      packageDirectory: "relay-glm",
      synthesizeCustomReview: false,
      description: "Delegate code reviews to GLM direct API from within Claude Code.",
    },
  }),
  deepseek: freezeProvider({
    id: "deepseek",
    provider: "deepseek",
    family: "direct-api",
    displayName: "DeepSeek",
    display: "DeepSeek",
    shortDisplayName: "DeepSeek",
    shortDisplay: "DeepSeek",
    commandPrefix: "deepseek",
    sourceProvider: "relay-deepseek",
    packageDirectory: "relay-deepseek",
    binary: "api-reviewer.mjs",
    pluginDataEnv: "API_REVIEWERS_PLUGIN_DATA",
    sessionIdEnv: null,
    jobRecordSessionField: null,
    workflows: REVIEWER_WORKFLOWS,
    generatedSkills: [],
    codex: {
      manifestName: "relay-deepseek",
      packageDirectory: "relay-deepseek",
      manifestCapabilities: ["Read"],
    },
    claude: {
      manifestName: "relay-deepseek",
      packageDirectory: "relay-deepseek",
      synthesizeCustomReview: false,
      description: "Delegate code reviews to DeepSeek direct API from within Claude Code.",
    },
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
