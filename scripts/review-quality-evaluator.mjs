#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { evaluateSeededReviewPacket } from "./lib/review-quality-evaluator.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/review-quality-evaluator.mjs --packet <packet-id> --output-file <review-output.txt>",
    "  node scripts/review-quality-evaluator.mjs --packet <packet-id> < review-output.txt",
  ].join("\n");
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function reviewOutput(argv) {
  const outputFile = argValue(argv, "--output-file");
  if (outputFile) return readFileSync(outputFile, "utf8");
  return readFileSync(0, "utf8");
}

export function evaluateCli(argv = process.argv.slice(2)) {
  const packet = argValue(argv, "--packet");
  if (!packet || argv.includes("--help")) {
    throw new Error(usage());
  }
  return evaluateSeededReviewPacket({
    packet,
    output: reviewOutput(argv),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = evaluateCli();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.expected_findings_found && !result.false_positive ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
