import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";

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

test("coverage threshold checker can enforce only an explicit file set", () => {
  const failures = _internal.coverageFailures([
    {
      file: "plugins/claude/scripts/lib/ok.mjs",
      lines: { percent: 100 },
      branches: { percent: 100 },
      functions: { percent: 100 },
    },
    {
      file: "plugins/kimi/scripts/lib/newly-visible.mjs",
      lines: { percent: 0 },
      branches: { percent: 100 },
      functions: { percent: 0 },
    },
  ], 85, new Set(["plugins/claude/scripts/lib/ok.mjs"]));

  assert.deepEqual(failures, []);
});

test("coverage target enforcement set is read explicitly from the baseline", () => {
  const files = _internal.targetEnforcedFilesFromBaseline({
    target_enforced_files: ["plugins/claude/scripts/lib/old-surface.mjs"],
    files: {
      "plugins/kimi/scripts/lib/newly-visible.mjs": {
        lines: 100,
        branches: 100,
        functions: 100,
      },
    },
  }, 85);

  assert.deepEqual([...files], ["plugins/claude/scripts/lib/old-surface.mjs"]);
});

test("coverage target enforcement falls back to fully covered baseline entries", () => {
  const files = _internal.targetEnforcedFilesFromBaseline({
    files: {
      "plugins/claude/scripts/lib/enforced.mjs": {
        lines: 85,
        branches: 90,
        functions: 100,
      },
      "plugins/kimi/scripts/lib/baseline-only.mjs": {
        lines: 0,
        branches: 100,
        functions: 0,
      },
    },
  }, 85);

  assert.deepEqual([...files], ["plugins/claude/scripts/lib/enforced.mjs"]);
});

test("coverage function metric ignores anonymous callback helpers", () => {
  const source = [
    "export function validate(xs) {",
    "  const bad = xs.filter((x) => x < 0);",
    "  return bad.length === 0;",
    "}",
    "",
  ].join("\n");
  const callbackStart = source.indexOf("(x) =>");
  const functions = [
    {
      functionName: "validate",
      ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
      isBlockCoverage: true,
    },
    {
      functionName: "",
      ranges: [{ startOffset: callbackStart, endOffset: callbackStart + "(x) => x < 0".length, count: 0 }],
      isBlockCoverage: true,
    },
  ];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.functions.total, 1);
  assert.equal(summary.functions.covered, 1);
});

test("coverage aggregator does not let alternate zero-count range shapes lower branch totals", () => {
  const source = [
    "export function choose(flag) {",
    "  if (flag) return 1;",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const fullStart = source.indexOf("return 0");
  const alternateStart = source.indexOf("if (flag)");
  const functions = [
    {
      functionName: "choose",
      ranges: [
        { startOffset: 0, endOffset: source.length, count: 2 },
        { startOffset: fullStart, endOffset: fullStart + "return 0".length, count: 1 },
      ],
      isBlockCoverage: true,
    },
    {
      functionName: "choose",
      ranges: [
        { startOffset: 0, endOffset: source.length, count: 1 },
        { startOffset: alternateStart, endOffset: alternateStart + "if (flag) return 1;".length, count: 0 },
        { startOffset: fullStart, endOffset: fullStart + "return 0".length, count: 0 },
      ],
      isBlockCoverage: true,
    },
  ];

  const summary = _internal.summarizeSourceCoverage(
    source,
    _internal.aggregateFunctions(functions),
  );

  assert.equal(summary.branches.total, 1);
  assert.equal(summary.branches.covered, 1);
});

test("coverage line metric treats export function declarations as executable function lines", () => {
  const source = [
    "export function named() {",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  const functionStart = source.indexOf("function named");
  const functions = [{
    functionName: "named",
    ranges: [{ startOffset: functionStart, endOffset: source.length, count: 1 }],
    isBlockCoverage: true,
  }];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.lines.covered, summary.lines.total);
});

test("coverage branch metric ignores catch-handler ranges", () => {
  const source = [
    "export function guarded() {",
    "  try {",
    "    return 1;",
    "  } catch (e) {",
    "    return 0;",
    "  }",
    "}",
    "",
  ].join("\n");
  const functionStart = source.indexOf("function guarded");
  const catchStart = source.indexOf("catch");
  const functions = [{
    functionName: "guarded",
    ranges: [
      { startOffset: functionStart, endOffset: source.length, count: 1 },
      { startOffset: catchStart, endOffset: source.indexOf("  }", catchStart), count: 0 },
    ],
    isBlockCoverage: true,
  }];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.branches.total, 0);
  assert.equal(summary.branches.covered, 0);
});

test("coverage branch metric ignores V8 expression segment ranges", () => {
  const source = [
    "export function pick(flag, fallback) {",
    "  return flag ? \"yes\" : fallback || \"no\";",
    "}",
    "",
  ].join("\n");
  const functionStart = source.indexOf("function pick");
  const ternaryStart = source.indexOf("? \"yes\"");
  const orStart = source.indexOf("|| \"no\"");
  const functions = [{
    functionName: "pick",
    ranges: [
      { startOffset: functionStart, endOffset: source.length, count: 1 },
      { startOffset: ternaryStart, endOffset: ternaryStart + "? \"yes\"".length, count: 0 },
      { startOffset: orStart, endOffset: orStart + "|| \"no\"".length, count: 0 },
    ],
    isBlockCoverage: true,
  }];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.branches.total, 0);
  assert.equal(summary.branches.covered, 0);
});

test("coverage branch metric ignores terminal control-only segment ranges", () => {
  const source = [
    "export function scan(items, stop) {",
    "  for (const item of items) {",
    "    if (item === stop) return;",
    "    if (item === null) continue;",
    "  }",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  const functionStart = source.indexOf("function scan");
  const returnStart = source.indexOf("return;");
  const continueStart = source.indexOf("continue;");
  const functions = [{
    functionName: "scan",
    ranges: [
      { startOffset: functionStart, endOffset: source.length, count: 1 },
      { startOffset: returnStart, endOffset: returnStart + "return;".length, count: 0 },
      { startOffset: continueStart, endOffset: continueStart + "continue;".length, count: 0 },
    ],
    isBlockCoverage: true,
  }];

  const summary = _internal.summarizeSourceCoverage(source, functions);

  assert.equal(summary.branches.total, 0);
  assert.equal(summary.branches.covered, 0);
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

test("coverage gate discovers every packaged plugin lib directory", async () => {
  const files = (await _internal.discoverLibFiles()).map((file) =>
    path.relative(resolve("."), file).split(path.sep).join("/")
  );

  for (const plugin of ["claude", "gemini", "kimi", "api-reviewers"]) {
    assert.ok(
      files.some((file) => file.startsWith(`plugins/${plugin}/scripts/lib/`)),
      `coverage gate must walk plugins/${plugin}/scripts/lib`,
    );
  }
});

test("coverage baseline tracks every discovered plugin lib file", async () => {
  const baseline = JSON.parse(readFileSync(resolve("scripts/ci/coverage-baseline.json"), "utf8"));
  const baselineFiles = new Set(Object.keys(baseline.files ?? {}));
  const files = (await _internal.discoverLibFiles()).map((file) =>
    path.relative(resolve("."), file).split(path.sep).join("/")
  );

  assert.deepEqual(files.filter((file) => !baselineFiles.has(file)), []);
});

test("coverage merger discovers byte-identical lib pairs instead of requiring duplicate tests", async () => {
  const claudeMarker = resolve("plugins/claude/scripts/lib/cancel-marker.mjs");
  const geminiMarker = resolve("plugins/gemini/scripts/lib/cancel-marker.mjs");
  const claudeFn = { functionName: "writeCancelMarker", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] };
  const byFile = new Map([
    [claudeMarker, [claudeFn]],
    [geminiMarker, []],
  ]);

  await _internal.shareCoverageForVerbatimPairs(byFile, [claudeMarker, geminiMarker], async () => "same source");

  assert.deepEqual(
    byFile.get(geminiMarker),
    [claudeFn],
    "byte-identical gemini helper should inherit claude-side coverage without a gemini-only exercise test",
  );
});

test("coverage merger shares coverage across all byte-identical companion-common copies", async () => {
  const claudeCommon = resolve("plugins/claude/scripts/lib/companion-common.mjs");
  const geminiCommon = resolve("plugins/gemini/scripts/lib/companion-common.mjs");
  const kimiCommon = resolve("plugins/kimi/scripts/lib/companion-common.mjs");
  const coveredFn = { functionName: "printJson", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] };
  const byFile = new Map([
    [claudeCommon, [coveredFn]],
    [geminiCommon, []],
    [kimiCommon, []],
  ]);

  await _internal.shareCoverageForVerbatimPairs(
    byFile,
    [claudeCommon, geminiCommon, kimiCommon],
    async () => "same source",
  );

  assert.deepEqual(byFile.get(geminiCommon), [coveredFn]);
  assert.deepEqual(byFile.get(kimiCommon), [coveredFn]);
});

test("coverage merger keeps sharing identical subsets when same-named plugin files diverge", async () => {
  const claudeReconcile = resolve("plugins/claude/scripts/lib/reconcile.mjs");
  const geminiReconcile = resolve("plugins/gemini/scripts/lib/reconcile.mjs");
  const kimiReconcile = resolve("plugins/kimi/scripts/lib/reconcile.mjs");
  const coveredFn = { functionName: "reconcileActiveJobs", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] };
  const byFile = new Map([
    [claudeReconcile, [coveredFn]],
    [geminiReconcile, []],
    [kimiReconcile, []],
  ]);
  const sources = new Map([
    [claudeReconcile, "shared source"],
    [geminiReconcile, "shared source"],
    [kimiReconcile, "kimi source"],
  ]);

  await _internal.shareCoverageForVerbatimPairs(
    byFile,
    [claudeReconcile, geminiReconcile, kimiReconcile],
    async (file) => sources.get(file),
  );

  assert.deepEqual(byFile.get(geminiReconcile), [coveredFn]);
  assert.deepEqual(byFile.get(kimiReconcile), []);
});
