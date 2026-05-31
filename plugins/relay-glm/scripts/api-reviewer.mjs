#!/usr/bin/env node
async function importRelayEntrypoint() {
  const candidates = [
    process.env.RELAY_API_REVIEWERS_ENTRYPOINT,
    new URL("../../api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
    new URL("../../relay-api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
    new URL("../../../plugins/api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
    new URL("../../../api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href,
    new URL("../../../../codex-plugin-multi/api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch {
      // Try the next known install layout.
    }
  }
  console.error("api_reviewer_entrypoint_missing: install the shared api-reviewers runtime");
  process.exit(1);
}

const helper = await importRelayEntrypoint();

helper.runRelayDirectApiEntrypoint({ provider: "glm", scriptUrl: import.meta.url });
