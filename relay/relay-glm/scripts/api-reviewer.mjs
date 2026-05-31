#!/usr/bin/env node
const helper = await import(process.env.RELAY_API_REVIEWERS_ENTRYPOINT || new URL("../../api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href)
  .catch(() => import(new URL("../../../plugins/api-reviewers/scripts/relay-entrypoint.mjs", import.meta.url).href))
  .catch(() => import(new URL("../../../api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href))
  .catch(() => import(new URL("../../../../codex-plugin-multi/api-reviewers/0.1.0/scripts/relay-entrypoint.mjs", import.meta.url).href));

helper.runRelayDirectApiEntrypoint({ provider: "glm", scriptUrl: import.meta.url });
