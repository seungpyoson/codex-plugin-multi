#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  AB_REVIEW_PACKETS,
  MANUAL_RELAY_JUDGE_CONTEXT,
  buildManualRelayPacketPrompt,
} from "./lib/review-quality-ab-fixture.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/review-quality-ab-fixture.mjs --packet <packet-id>",
    "  node scripts/review-quality-ab-fixture.mjs --judge-context",
    "  node scripts/review-quality-ab-fixture.mjs --list",
  ].join("\n");
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

export function render(argv = process.argv.slice(2)) {
  if (argv.includes("--list")) {
    return `${AB_REVIEW_PACKETS.map((packet) => packet.id).join("\n")}\n`;
  }
  if (argv.includes("--judge-context")) {
    return `${MANUAL_RELAY_JUDGE_CONTEXT}\n`;
  }
  const packet = argValue(argv, "--packet");
  if (packet) {
    return `${buildManualRelayPacketPrompt(packet)}\n`;
  }
  throw new Error(usage());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(render());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
