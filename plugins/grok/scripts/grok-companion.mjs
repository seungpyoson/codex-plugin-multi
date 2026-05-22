#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { runCli } from "./grok-web-reviewer.mjs";

export * from "./grok-web-reviewer.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
