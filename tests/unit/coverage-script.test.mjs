import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { _internal } from "../../scripts/ci/check-coverage.mjs";

test("coverage summarizer counts uncovered V8 block ranges as branch misses", () => {
  const source = [
    "export function choose(flag) {",
    "  if (flag) return 1;",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const uncoveredStart = source.indexOf("return 0");
  const functions = [{
    functionName: "choose",
    ranges: [
      { startOffset: 0, endOffset: source.length, count: 1 },
      { startOffset: uncoveredStart, endOffset: uncoveredStart + "return 0".length, count: 0 },
    ],
    isBlockCoverage: true,
  }];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.functions.total, 1);
  assert.equal(summary.functions.covered, 1);
  assert.equal(summary.branches.total, 1);
  assert.equal(summary.branches.covered, 0);
  assert.ok(summary.lines.covered < summary.lines.total);
});

test("coverage threshold checker fails any lib file below the configured floor", () => {
  const failures = _internal.coverageFailures([
    {
      file: "plugins/claude/scripts/lib/ok.mjs",
      lines: { percent: 100 },
      branches: { percent: 100 },
      functions: { percent: 100 },
    },
    {
      file: "plugins/gemini/scripts/lib/low.mjs",
      lines: { percent: 90 },
      branches: { percent: 84.9 },
      functions: { percent: 100 },
    },
  ], 85);

  assert.deepEqual(failures, [
    "plugins/gemini/scripts/lib/low.mjs: branch coverage 84.90% < 85.00%",
  ]);
});

test("coverage baseline checker fails regressions below stored values", () => {
  const regressions = _internal.baselineFailures([
    {
      file: "plugins/claude/scripts/lib/ok.mjs",
      lines: { percent: 90 },
      branches: { percent: 86.9 },
      functions: { percent: 100 },
    },
  ], {
    files: {
      "plugins/claude/scripts/lib/ok.mjs": {
        lines: 90,
        branches: 88,
        functions: 100,
      },
      "plugins/gemini/scripts/lib/missing.mjs": {
        lines: 1,
        branches: 1,
        functions: 1,
      },
    },
  });

  assert.deepEqual(regressions, [
    "plugins/claude/scripts/lib/ok.mjs: branches coverage 86.90% < baseline 88.00%",
    "plugins/gemini/scripts/lib/missing.mjs: missing from coverage report",
  ]);
});

test("coverage merger shares raw V8 functions for byte-identical shared lib pairs", async () => {
  const claudeArgs = resolve("plugins/claude/scripts/lib/args.mjs");
  const geminiArgs = resolve("plugins/gemini/scripts/lib/args.mjs");
  const claudeFn = { functionName: "parseArgs", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] };
  const geminiFn = { functionName: "parseArgs", ranges: [{ startOffset: 0, endOffset: 10, count: 0 }] };
  const byFile = new Map([
    [claudeArgs, [claudeFn]],
    [geminiArgs, [geminiFn]],
  ]);

  await _internal.shareCoverageForVerbatimPairs(byFile, [claudeArgs, geminiArgs], async () => "same source");

  assert.deepEqual(byFile.get(claudeArgs), [claudeFn, geminiFn]);
  assert.deepEqual(byFile.get(geminiArgs), [claudeFn, geminiFn]);
});
