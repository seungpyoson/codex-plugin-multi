#!/usr/bin/env node
// Dependency-free coverage gate for Node/V8 coverage JSON.
//
// The companion smoke tests spawn child Node processes, so Node's
// --experimental-test-coverage report is not enough: it only reports the test
// runner process. NODE_V8_COVERAGE is inherited by child processes and gives us
// the complete raw coverage set without adding c8 as a dependency.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CODEX_ENV_PLUGIN_TARGETS, COMPANION_PLUGIN_TARGETS } from "../lib/plugin-targets.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "fixtures", ".git", "coverage"]);
const COVERAGE_TARGET = Number(process.env.COVERAGE_TARGET ?? 85);
const COVERAGE_TOLERANCE = Number(process.env.COVERAGE_TOLERANCE ?? 1);
const BASELINE_FILE = resolve(REPO_ROOT, "scripts/ci/coverage-baseline.json");

async function walk(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full, predicate)));
    else if (ent.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

async function discoverTestFiles() {
  const dirs = [
    resolve(REPO_ROOT, "tests/unit"),
    ...(process.env.CODEX_PLUGIN_SKIP_SMOKE ? [] : [resolve(REPO_ROOT, "tests/smoke")]),
  ];
  const files = [];
  for (const dir of dirs) {
    files.push(...await walk(dir, (f) => f.endsWith(".test.mjs")));
  }
  return files.sort();
}

async function discoverLibFiles() {
  const files = [];
  for (const plugin of new Set([...COMPANION_PLUGIN_TARGETS, ...CODEX_ENV_PLUGIN_TARGETS, "api-reviewers"])) {
    files.push(...await walk(
      resolve(REPO_ROOT, "plugins", plugin, "scripts", "lib"),
      (f) => f.endsWith(".mjs"),
    ));
  }
  return files.sort();
}

function toRepoRelative(file) {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

function percent(covered, total) {
  if (total === 0) return 100;
  return (covered / total) * 100;
}

function formatPercent(value) {
  return value.toFixed(2);
}

function lineSpans(source) {
  const spans = [];
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      spans.push({ start, end: i, text: source.slice(start, i) });
      start = i + 1;
    }
  }
  return spans;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function firstCodeOffset(span) {
  const match = /\S/.exec(span.text);
  if (!match) return null;
  const trimmed = span.text.trimStart();
  if (trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("export function ")) {
    return span.start + span.text.indexOf("function ");
  }
  return span.start + match.index;
}

function isModuleWrapper(source, fn) {
  if (fn.functionName !== "" || fn.ranges.length !== 1) return false;
  const root = fn.ranges[0];
  return root.startOffset === 0 && root.endOffset >= source.length - 1;
}

function isCatchHandlerRange(source, range) {
  return source.slice(range.startOffset, range.endOffset).trimStart().startsWith("catch");
}

function isExpressionSegmentRange(source, range) {
  return /^(?:\?\s|\?\?\s|\|\|\s|&&\s)/.test(source.slice(range.startOffset, range.endOffset).trimStart());
}

function isTerminalControlSegmentRange(source, range) {
  return /^(?:continue;|return;)/.test(source.slice(range.startOffset, range.endOffset).trimStart());
}

function isIgnoredBranchRange(source, range) {
  // Raw V8 block coverage includes expression tails and terminal control-flow
  // statement segments. They affect line coverage, but treating them as branch
  // decisions makes the branch gate mostly measure private defensive clutter.
  return (
    isCatchHandlerRange(source, range) ||
    isExpressionSegmentRange(source, range) ||
    isTerminalControlSegmentRange(source, range)
  );
}

function countAtOffset(ranges, offset) {
  let best = null;
  for (const range of ranges) {
    if (range.startOffset <= offset && offset < range.endOffset) {
      if (!best || (range.endOffset - range.startOffset) < (best.endOffset - best.startOffset)) {
        best = range;
      }
    }
  }
  return best?.count ?? 0;
}

function summarizeSourceCoverage(source, functions) {
  const spans = lineSpans(source);
  const executableLines = new Set();
  const coveredLines = new Set();
  const summary = {
    lines: { covered: 0, total: 0, percent: 100 },
    branches: { covered: 0, total: 0, percent: 100 },
    functions: { covered: 0, total: 0, percent: 100 },
  };

  for (const fn of functions) {
    if (!fn.ranges?.length || isModuleWrapper(source, fn)) continue;
    const root = fn.ranges[0];

    if (fn.functionName !== "") {
      summary.functions.total++;
      if (root.count > 0) summary.functions.covered++;
    }

    for (const range of fn.ranges.slice(1)) {
      if (isIgnoredBranchRange(source, range)) continue;
      summary.branches.total++;
      if (range.count > 0) summary.branches.covered++;
    }

    spans.forEach((span, index) => {
      const codeOffset = firstCodeOffset(span);
      if (codeOffset === null) return;
      if (!overlaps(span.start, span.end, root.startOffset, root.endOffset)) return;
      executableLines.add(index);
      if (countAtOffset(fn.ranges, codeOffset) > 0) coveredLines.add(index);
    });
  }

  summary.lines.total = executableLines.size;
  summary.lines.covered = [...executableLines].filter((line) => coveredLines.has(line)).length;
  summary.lines.percent = percent(summary.lines.covered, summary.lines.total);
  summary.branches.percent = percent(summary.branches.covered, summary.branches.total);
  summary.functions.percent = percent(summary.functions.covered, summary.functions.total);
  return summary;
}

function aggregateFunctions(functions) {
  const byFunction = new Map();
  for (const fn of functions) {
    if (!fn.ranges?.length) continue;
    const root = fn.ranges[0];
    const key = `${fn.functionName}:${root.startOffset}:${root.endOffset}`;
    if (!byFunction.has(key)) {
      byFunction.set(key, {
        functionName: fn.functionName,
        isBlockCoverage: fn.isBlockCoverage,
        shapes: new Map(),
      });
    }
    const aggregate = byFunction.get(key);
    const shapeKey = fn.ranges.map((range) => `${range.startOffset}:${range.endOffset}`).join("|");
    if (!aggregate.shapes.has(shapeKey)) {
      aggregate.shapes.set(shapeKey, new Map());
    }
    const rangeCounts = aggregate.shapes.get(shapeKey);
    for (const range of fn.ranges) {
      const rangeKey = `${range.startOffset}:${range.endOffset}`;
      const prev = rangeCounts.get(rangeKey) ?? {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        count: 0,
      };
      prev.count += range.count;
      rangeCounts.set(rangeKey, prev);
    }
  }

  function score(ranges) {
    const branchRanges = ranges.slice(1);
    const covered = branchRanges.filter((range) => range.count > 0).length;
    const total = branchRanges.length;
    return {
      branchPercent: total === 0 ? 100 : covered / total,
      covered,
      total,
      rootCount: ranges[0]?.count ?? 0,
    };
  }

  return [...byFunction.values()].map((fn) => {
    const candidates = [...fn.shapes.values()].map((rangeCounts) => (
      [...rangeCounts.values()].sort((a, b) => (
        a.startOffset - b.startOffset || b.endOffset - a.endOffset
      ))
    ));
    candidates.sort((left, right) => {
      const a = score(left);
      const b = score(right);
      if ((a.total > 0) !== (b.total > 0)) {
        return (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0);
      }
      return (
        b.branchPercent - a.branchPercent ||
        b.covered - a.covered ||
        b.rootCount - a.rootCount ||
        a.total - b.total
      );
    });
    return {
      functionName: fn.functionName,
      isBlockCoverage: fn.isBlockCoverage,
      ranges: candidates[0] ?? [],
    };
  });
}

async function readCoverageFunctions(coverageDir, libFiles) {
  const wanted = new Map(libFiles.map((file) => [resolve(file), []]));
  const jsonFiles = await walk(coverageDir, (f) => f.endsWith(".json"));
  for (const jsonFile of jsonFiles) {
    const data = JSON.parse(await readFile(jsonFile, "utf8"));
    for (const script of data.result ?? []) {
      if (!script.url?.startsWith("file://")) continue;
      const file = resolve(fileURLToPath(script.url));
      if (!wanted.has(file)) continue;
      wanted.get(file).push(...(script.functions ?? []));
    }
  }
  return wanted;
}

async function shareCoverageForVerbatimPairs(byFile, libFiles, readText = readFile) {
  const byRepoPath = new Map(libFiles.map((file) => [toRepoRelative(file), resolve(file)]));
  const filesByName = new Map();
  for (const [repoPath, file] of byRepoPath.entries()) {
    const match = /^plugins\/[^/]+\/scripts\/lib\/([^/]+)$/.exec(repoPath);
    if (!match) continue;
    const fileName = match[1];
    if (!filesByName.has(fileName)) filesByName.set(fileName, []);
    filesByName.get(fileName).push(file);
  }

  for (const files of filesByName.values()) {
    if (files.length < 2) continue;
    const sources = await Promise.all(files.map((file) => readText(file, "utf8")));
    const filesBySource = new Map();
    for (const [i, file] of files.entries()) {
      const source = String(sources[i]);
      if (!filesBySource.has(source)) filesBySource.set(source, []);
      filesBySource.get(source).push(file);
    }
    for (const identicalFiles of filesBySource.values()) {
      if (identicalFiles.length < 2) continue;
      const merged = identicalFiles.flatMap((file) => byFile.get(file) ?? []);
      for (const file of identicalFiles) byFile.set(file, merged);
    }
  }
  return byFile;
}

async function coverageSummaries(coverageDir, libFiles) {
  const byFile = await readCoverageFunctions(coverageDir, libFiles);
  await shareCoverageForVerbatimPairs(byFile, libFiles);
  const summaries = [];
  for (const file of libFiles) {
    const source = await readFile(file, "utf8");
    const functions = aggregateFunctions(byFile.get(resolve(file)) ?? []);
    summaries.push({
      file: toRepoRelative(file),
      ...summarizeSourceCoverage(source, functions),
    });
  }
  return summaries;
}

function coverageFailures(summaries, threshold = COVERAGE_TARGET) {
  const failures = [];
  for (const summary of summaries) {
    for (const [label, key] of [
      ["line", "lines"],
      ["branch", "branches"],
      ["function", "functions"],
    ]) {
      const value = summary[key].percent;
      if (value < threshold) {
        failures.push(`${summary.file}: ${label} coverage ${formatPercent(value)}% < ${formatPercent(threshold)}%`);
      }
    }
  }
  return failures;
}

async function readCoverageBaseline() {
  return JSON.parse(await readFile(BASELINE_FILE, "utf8"));
}

function baselineFailures(summaries, baseline) {
  const byFile = new Map(summaries.map((summary) => [summary.file, summary]));
  const failures = [];
  for (const [file, expected] of Object.entries(baseline.files ?? {})) {
    const actual = byFile.get(file);
    if (!actual) {
      failures.push(`${file}: missing from coverage report`);
      continue;
    }
    for (const key of ["lines", "branches", "functions"]) {
      const expectedPercent = Number(expected[key]);
      const actualPercent = actual[key].percent;
      if (actualPercent + COVERAGE_TOLERANCE < expectedPercent) {
        failures.push(`${file}: ${key} coverage ${formatPercent(actualPercent)}% < baseline ${formatPercent(expectedPercent)}%`);
      }
    }
  }
  return failures;
}

function printTable(summaries) {
  process.stdout.write("file | line % | branch % | function %\n");
  process.stdout.write("--- | ---: | ---: | ---:\n");
  for (const summary of summaries) {
    process.stdout.write([
      summary.file,
      formatPercent(summary.lines.percent),
      formatPercent(summary.branches.percent),
      formatPercent(summary.functions.percent),
    ].join(" | ") + "\n");
  }
}

async function main() {
  const testFiles = await discoverTestFiles();
  if (testFiles.length === 0) {
    process.stdout.write("(no test files yet — skipping coverage.)\n");
    return;
  }

  const coverageDir = resolve(tmpdir(), `codex-plugin-multi-v8-coverage-${process.pid}`);
  await rm(coverageDir, { recursive: true, force: true });
  await mkdir(coverageDir, { recursive: true });
  try {
    const relTests = testFiles.map((file) => toRepoRelative(file));
    const res = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...relTests], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, CODEX_PLUGIN_COVERAGE: "1", NODE_V8_COVERAGE: coverageDir },
    });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

    const libFiles = await discoverLibFiles();
    const summaries = await coverageSummaries(coverageDir, libFiles);
    printTable(summaries);
    const targetFailures = coverageFailures(summaries, COVERAGE_TARGET);
    const baseline = await readCoverageBaseline();
    const regressions = baselineFailures(summaries, baseline);
    if (regressions.length > 0) {
      for (const failure of regressions) process.stderr.write(`coverage regression: ${failure}\n`);
      process.exit(1);
    }
    if (process.env.COVERAGE_ENFORCE_TARGET === "1" && targetFailures.length > 0) {
      for (const failure of targetFailures) process.stderr.write(`coverage target: ${failure}\n`);
      process.exit(1);
    }
    if (targetFailures.length > 0) {
      process.stdout.write(`coverage target not yet met: ${targetFailures.length} metric(s) below ${formatPercent(COVERAGE_TARGET)}%\n`);
      process.stdout.write("✓ coverage baseline met; CI will fail on regressions\n");
    } else {
      process.stdout.write(`✓ coverage target met (${formatPercent(COVERAGE_TARGET)}%)\n`);
    }
  } finally {
    await rm(coverageDir, { recursive: true, force: true });
  }
}

export const _internal = {
  aggregateFunctions,
  baselineFailures,
  coverageFailures,
  coverageSummaries,
  discoverLibFiles,
  discoverTestFiles,
  shareCoverageForVerbatimPairs,
  summarizeSourceCoverage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
