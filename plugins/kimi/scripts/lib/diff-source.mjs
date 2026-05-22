import { execFileSync } from "node:child_process";

const DEFAULT_BASE_REF = "main";
const DEFAULT_CONTEXT_LINES = 5;
const MAX_DIFF_BYTES = 512 * 1024;

function scrubGitEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("GIT_")) delete clean[key];
  }
  if (env.HOME) clean.HOME = env.HOME;
  if (env.PATH) clean.PATH = env.PATH;
  return clean;
}

function git(sourceCwd, args) {
  return execFileSync("git", ["-C", sourceCwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
    env: scrubGitEnv(process.env),
  });
}

function resolveMergeBase(sourceCwd, baseRef) {
  try {
    git(sourceCwd, ["rev-parse", "--verify", "--quiet", baseRef]);
    const mergeBase = git(sourceCwd, ["merge-base", baseRef, "HEAD"]).trim();
    return mergeBase || null;
  } catch {
    return null;
  }
}

function listChangedFiles(sourceCwd, mergeBase) {
  try {
    const raw = git(sourceCwd, ["diff", "--name-only", "-z", `${mergeBase}...HEAD`]);
    return raw.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function diffForFile(sourceCwd, mergeBase, filePath, contextLines) {
  try {
    try {
      const numstat = git(sourceCwd, ["diff", "--numstat", `${mergeBase}...HEAD`, "--", filePath]).trim();
      if (numstat.startsWith("-\t-\t")) {
        return `Binary file ${filePath} differs (not shown)`;
      }
    } catch {}
    const diff = git(sourceCwd, ["diff", `-U${contextLines}`, `${mergeBase}...HEAD`, "--", filePath]);
    if (!diff || diff.trim().length === 0) return null;
    return diff;
  } catch {
    return null;
  }
}

function statForFile(sourceCwd, mergeBase, filePath) {
  try {
    const stat = git(sourceCwd, ["diff", "--stat", `${mergeBase}...HEAD`, "--", filePath]).trim();
    const lines = stat.split("\n");
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

function matchGlob(rel, pattern) {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i += 1; if (pattern[i + 1] === "/") i += 1; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".^$+(){}|\\[]".includes(c)) re += "\\" + c;
    else re += c;
  }
  re += "$";
  return new RegExp(re).test(rel);
}

export function diffSourceFiles(sourceCwd, baseRef = DEFAULT_BASE_REF, opts = {}) {
  const { contextLines = DEFAULT_CONTEXT_LINES, scopePaths = null } = opts;
  const mergeBase = resolveMergeBase(sourceCwd, baseRef);
  if (!mergeBase) return [];
  let changedFiles = listChangedFiles(sourceCwd, mergeBase);
  if (changedFiles.length === 0) return [];
  if (Array.isArray(scopePaths) && scopePaths.length > 0) {
    changedFiles = changedFiles.filter((rel) => scopePaths.some((g) => matchGlob(rel, g)));
  }
  const files = [];
  for (const filePath of changedFiles) {
    const diff = diffForFile(sourceCwd, mergeBase, filePath, contextLines);
    if (!diff) continue;
    const stat = statForFile(sourceCwd, mergeBase, filePath);
    const header = stat ? `${stat}\n\n` : "";
    const content = Buffer.from(header + diff, "utf8");
    if (content.length > MAX_DIFF_BYTES) {
      files.push({ path: filePath, content: Buffer.from(`${stat || `diff for ${filePath}`}\n\n[Diff truncated: ${content.length} bytes exceeds ${MAX_DIFF_BYTES} byte cap. Review this file separately.]`, "utf8") });
      continue;
    }
    files.push({ path: filePath, content });
  }
  return files;
}
