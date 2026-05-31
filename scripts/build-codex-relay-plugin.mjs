#!/usr/bin/env node
import { buildCodexDirectApiSuite } from "./lib/codex-relay-build.mjs";

for (const pluginRoot of buildCodexDirectApiSuite()) {
  process.stdout.write(`${pluginRoot}\n`);
}
