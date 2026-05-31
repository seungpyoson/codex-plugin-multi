#!/usr/bin/env node
const candidates = [
  process.env.RELAY_API_REVIEWERS_ENTRYPOINT,
  new URL("../../relay-api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../../plugins/api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href,
  new URL("../../../relay-api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href,
].filter(Boolean);
const helper = await Promise.any(candidates.map((candidate) => import(candidate))).catch(() => null);
if (!helper) { console.error("api_reviewer_entrypoint_missing: install the shared api-reviewers runtime"); process.exit(1); }
helper.runRelayDirectApiEntrypoint({ provider: "deepseek", scriptUrl: import.meta.url });
