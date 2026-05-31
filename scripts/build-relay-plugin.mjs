#!/usr/bin/env node
import { buildRelayPlugin, buildRelaySuite } from "./lib/relay-build.mjs";

const args = process.argv.slice(2);
let provider = "all";
let outRoot;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--provider") {
    provider = args[index + 1];
    index += 1;
  } else if (arg === "--out-root") {
    outRoot = args[index + 1];
    index += 1;
  } else if (!arg.startsWith("-")) {
    provider = arg;
  } else {
    throw new Error(`unknown option: ${arg}`);
  }
}

const buildOptions = { ...(outRoot ? { outRoot } : {}) };
const pluginRoots = provider === "all"
  ? buildRelaySuite(buildOptions)
  : [buildRelayPlugin({ provider, ...buildOptions })];

process.stdout.write(`${pluginRoots.join("\n")}\n`);
