import { createHash } from "node:crypto";

import {
  buildReviewSlotDisposition,
  evaluateReviewSlotRetryPolicy,
  evaluateSourcePacketPolicy,
  reviewSlotRequestSettingsHash,
  reviewSlotRetryFingerprint,
} from "./provider-route-policy.mjs";

export const REVIEW_PROMPT_CHECKLIST = Object.freeze([
  "Verify exact base/head refs and commits before judging the diff.",
  "Review only the declared scope and list any scope gaps as NOT REVIEWED.",
  "Evaluate correctness bugs, security risks, regressions, and missing tests.",
  "Check known review comments or residual threads when the prompt includes them.",
  "Separate blocking findings from non-blocking concerns.",
  "Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot.",
]);

export const REVIEW_PROMPT_CONTRACT_VERSION = 1;
export const REVIEW_PROMPT_CONTRACT_STYLES = Object.freeze(["standard", "compact"]);
export const REVIEW_AUDIT_MANIFEST_VERSION = 1;
const MAX_REVIEW_MARKUP_STRIPS = 10;
const MAX_CHECKLIST_NUMBER_DIGITS = 10;
const SELECTED_SOURCE_INSPECTION_VERBS = Object.freeze([
  "analyzed",
  "checked",
  "evaluated",
  "examined",
  "inspected",
  "reviewed",
]);

function contentBuffer(file) {
  const content = file?.content;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof file?.text === "string") return Buffer.from(file.text, "utf8");
  throw new Error(`scope_source_content_missing:${String(file?.path ?? "unknown")}`);
}

function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : String(value ?? "");
  return createHash("sha256").update(input).digest("hex");
}

function hashObject(value) {
  return Object.freeze({
    algorithm: "sha256",
    value: sha256(value),
  });
}

function lineCount(text) {
  const value = String(text ?? "");
  if (value.length === 0) return 0;
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (normalized.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === "\n") {
      lines += 1;
    } else if (normalized[index] === "\r") {
      lines += 1;
      if (normalized[index + 1] === "\n") index += 1;
    }
  }
  return lines;
}

function sourceManifest(sourceFiles = []) {
  const files = Array.isArray(sourceFiles) ? sourceFiles : [];
  const entries = files.map((file) => {
    const content = contentBuffer(file);
    const text = typeof file?.text === "string" ? file.text : content.toString("utf8");
    return Object.freeze({
      path: String(file?.path ?? "unknown"),
      bytes: content.length,
      lines: lineCount(text),
      content_hash: hashObject(content),
    });
  });
  return Object.freeze({
    files: Object.freeze(entries),
    totals: Object.freeze({
      files: entries.length,
      bytes: entries.reduce((sum, file) => sum + file.bytes, 0),
      lines: entries.reduce((sum, file) => sum + file.lines, 0),
    }),
  });
}

function isWordBoundary(char) {
  if (!char) return true;
  const code = char.charCodeAt(0);
  return !(
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === "_"
    || char === "-"
  );
}

function startsWithToken(line, token) {
  return line.startsWith(token) && isWordBoundary(line[token.length]);
}

function startsWithLabel(line, label) {
  if (!line.startsWith(label)) return false;
  return line.slice(label.length).trimStart().startsWith(":");
}

function startsWithFailVerdict(line) {
  if (!startsWithToken(line, "fail") && !startsWithToken(line, "failed")) return false;
  return /\b(blocking|do not approve|request changes|reject|rejected)\b/i.test(line);
}

function startsWithVerdictLabel(line, label) {
  if (!startsWithLabel(line, label)) return false;
  const delimiterIndex = line.indexOf(":");
  const value = delimiterIndex >= 0 ? line.slice(delimiterIndex + 1).trimStart() : "";
  return startsWithToken(value, "do not approve")
    || startsWithToken(value, "approve")
    || startsWithToken(value, "approved")
    || startsWithToken(value, "request changes")
    || startsWithFailVerdict(value)
    || startsWithToken(value, "reject")
    || startsWithToken(value, "rejected");
}

function isReviewMarkupSpace(char) {
  return char === undefined || char === " " || char === "\t";
}

function bulletText(line) {
  const marker = line[0];
  if (marker !== "-" && marker !== "*") return null;
  if (!isReviewMarkupSpace(line[1])) return null;
  return line.slice(1).trimStart();
}

function stripLeadingReviewMarkup(line) {
  let out = String(line ?? "").trimStart();
  for (let i = 0; i < MAX_REVIEW_MARKUP_STRIPS; i += 1) {
    const before = out;
    const checklist = checklistText(out);
    if (checklist) out = checklist;
    out = out.trimStart();
    while (out.startsWith(">")) out = out.slice(1).trimStart();
    const bullet = bulletText(out);
    if (bullet !== null) out = bullet;
    while (out.startsWith("**") || out.startsWith("__")) out = out.slice(2).trimStart();
    while (out.startsWith("`")) out = out.slice(1).trimStart();
    while (out.startsWith("#")) out = out.slice(1).trimStart();
    if (out === before) break;
  }
  return out;
}

function reviewLines(text) {
  return String(text ?? "").split("\n").map((line) => (
    line.endsWith("\r") ? line.slice(0, -1) : line
  ).trimStart());
}

function hasVerdict(text) {
  return reviewLines(text).some((rawLine) => {
    const line = unmarkReviewText(rawLine).toLowerCase();
    return startsWithLabel(line, "verdict")
      || startsWithLabel(line, "review verdict")
      || startsWithLabel(line, "code review verdict")
      || startsWithLabel(line, "overall verdict")
      || startsWithLabel(line, "final verdict")
      || startsWithVerdictLabel(line, "status")
      || startsWithVerdictLabel(line, "summary")
      || startsWithToken(line, "review verdict")
      || startsWithToken(line, "code review verdict")
      || startsWithToken(line, "overall verdict")
      || startsWithToken(line, "final verdict")
      || startsWithToken(line, "do not approve")
      || startsWithToken(line, "approve")
      || startsWithToken(line, "approved")
      || startsWithToken(line, "request changes")
      || startsWithFailVerdict(line)
      || startsWithToken(line, "reject")
      || startsWithToken(line, "rejected");
  });
}

function checklistText(line) {
  const trimmed = line.trimStart();
  const bullet = bulletText(trimmed);
  if (bullet !== null) return bullet;
  const unmarked = trimmed.replace(/[*_`]/g, "");
  const checklistItem = checklistItemText(unmarked);
  if (checklistItem !== null) return checklistItem;
  let index = 0;
  while (index < trimmed.length && index < MAX_CHECKLIST_NUMBER_DIGITS) {
    const code = trimmed.charCodeAt(index);
    if (code < 48 || code > 57) break;
    index += 1;
  }
  if (index === 0 || (trimmed[index] !== "." && trimmed[index] !== ")")) return null;
  return trimmed.slice(index + 1).trimStart();
}

function checklistItemText(line) {
  const lower = line.toLowerCase();
  if (lower.startsWith("checklist item ")) {
    return checklistItemWithDescriptionText(line, "checklist item ".length);
  }
  if (lower.startsWith("item ")) {
    return bareItemText(line, "item ".length);
  }
  return null;
}

function checklistItemWithDescriptionText(line, index) {
  const afterDigits = scanChecklistDigits(line, index);
  if (afterDigits === null) return null;
  const colon = line.indexOf(":", afterDigits);
  if (colon === -1) return null;
  return line.slice(colon + 1).trimStart();
}

function bareItemText(line, index) {
  const afterDigits = scanChecklistDigits(line, index);
  if (afterDigits === null) return null;
  let cursor = afterDigits;
  while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  if (line[cursor] !== ":") return null;
  return line.slice(cursor + 1).trimStart();
}

function scanChecklistDigits(line, index) {
  let cursor = index;
  while (cursor < line.length && cursor - index < MAX_CHECKLIST_NUMBER_DIGITS) {
    const code = line.charCodeAt(cursor);
    if (code < 48 || code > 57) break;
    cursor += 1;
  }
  if (cursor === index) return null;
  const nextCode = line.charCodeAt(cursor);
  if (
    Number.isFinite(nextCode) &&
    ((nextCode >= 48 && nextCode <= 57) || (nextCode >= 65 && nextCode <= 90) || (nextCode >= 97 && nextCode <= 122))
  ) return null;
  return cursor;
}

function unmarkReviewText(text) {
  return stripLeadingReviewMarkup(text).replace(/[*_`]/g, "");
}

function checklistStatus(line) {
  const tableStatus = markdownTableChecklistStatus(line);
  if (tableStatus) return tableStatus;
  const text = checklistText(line);
  if (!text) return null;
  const lower = unmarkReviewText(text).toLowerCase();
  if (startsWithToken(lower, "pass")) return "pass";
  if (startsWithToken(lower, "fail")) return "fail";
  if (startsWithToken(lower, "not reviewed")) return "not_reviewed";
  if (startsWithToken(lower, "n/a")) return "n_a";
  if (startsWithToken(lower, "not applicable")) return "n_a";
  const statusMatch = lower.match(/(?:^|[\u2013\u2014|]|(?:^|\s)-)\s*(pass|fail|not reviewed|n\/a|not applicable)\b/)
    ?? lower.match(/:\s*(not reviewed)\b/)
    ?? lower.match(/:\s*(pass|fail|n\/a|not applicable)\b(?=\s*(?:$|[().;,\u2013\u2014]))/);
  if (!statusMatch) return null;
  return normalizeChecklistStatus(statusMatch[1]);
}

function markdownTableChecklistStatus(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1)
    .split("|")
    .map((cell) => unmarkReviewText(cell).trim().toLowerCase())
    .filter(Boolean);
  if (cells.length < 3) return null;
  for (const cell of cells.slice(2)) {
    if (startsWithToken(cell, "pass")) return "pass";
    if (startsWithToken(cell, "fail")) return "fail";
    if (startsWithToken(cell, "not reviewed")) return "not_reviewed";
    if (startsWithToken(cell, "n/a")) return "n_a";
    if (startsWithToken(cell, "not applicable")) return "n_a";
  }
  return null;
}

function normalizeChecklistStatus(status) {
  const normalized = String(status ?? "").toLowerCase().replace(/\s+/g, "_").replace("/", "_");
  return normalized === "not_applicable" ? "n_a" : normalized;
}

function isChecklistVerdict(line) {
  return checklistStatus(line) !== null;
}

function isPassingChecklistLine(line) {
  return ["pass", "n_a"].includes(checklistStatus(line));
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function includesAnyToken(text, tokens) {
  return tokens.some((token) => includesToken(text, token));
}

function includesToken(text, token) {
  const value = String(text ?? "");
  const needle = String(token ?? "");
  if (!needle) return false;
  let index = value.indexOf(needle);
  while (index !== -1) {
    if (isWordBoundary(value[index - 1]) && isWordBoundary(value[index + needle.length])) {
      return true;
    }
    index = value.indexOf(needle, index + 1);
  }
  return false;
}

function includesPermissionFailureLiteral(lower) {
  return includesAny(lower, [
    "permission denied",
    "permission-denied",
    "read denied",
    "read-denied",
    "operation not permitted",
  ]) || includesAnyToken(lower, [
    "permissionerror",
    "eacces",
    "eperm",
  ]);
}

function permissionFailureCodeTokenCount(lower) {
  return [
    "permissionerror",
    "eacces",
    "eperm",
  ].filter((token) => includesToken(lower, token)).length;
}

function lineHasConcretePermissionFailure(line) {
  const lower = unmarkReviewText(line).toLowerCase();
  if (isPermissionFailureExampleLine(lower)) return false;
  if (includesPermissionFailureLiteral(lower)) {
    return true;
  }
  return lower.includes("permission block") && (
    includesAny(lower, [
      "could not inspect",
      "cannot inspect",
      "can't inspect",
      "unable to inspect",
      "could not read",
      "cannot read",
      "can't read",
      "unable to read",
      "could not access",
      "cannot access",
      "can't access",
      "unable to access",
      "permission block prevented",
      "permission blocks prevented",
    ])
  );
}

function isPermissionFailureExampleLine(lower) {
  if (isMockedPermissionLiteralLine(lower)) return true;
  if (isInjectedPermissionTestProofLine(lower)) return true;
  if (isPermissionExceptionExampleLine(lower)) return true;
  if (isOutOfScopePermissionNoteLine(lower)) return true;
  if (isPermissionLiteralListLine(lower)) return true;
  if (isPermissionBoundaryExampleLine(lower)) return true;
  if (isPermissionLiteralDiscussionLine(lower)) return true;
  if (isPermissionMechanicsDiscussionLine(lower)) return true;
  if (includesAny(lower, [
    "linehasconcretepermissionfailure",
    "permission detection requires",
    "test suite",
    "still flags",
    "correctly flagged",
    "still detected",
    "are still detected",
    "real failures",
  ]) && (includesPermissionFailureLiteral(lower) || includesAny(lower, [
    "permission block",
    "permission_blocked",
  ])) && !hasConcretePermissionActionPhrase(lower)) {
    return true;
  }
  if (includesAny(lower, [
    "classifier should flag",
    "should flag",
    "meta-discussion",
  ]) && includesAny(lower, [
    "permission denied",
    "read denied",
    "permission block",
    "permission_blocked",
  ]) && !hasConcretePermissionActionPhrase(lower)) {
    return true;
  }
  return includesAny(lower, [
    "phrases such as",
    "patterns such as",
    "terms such as",
    "examples such as",
  ]) && includesAny(lower, [
    "permission denied",
    "read denied",
    "permission block",
    "operation not permitted",
    "permissionerror",
    "eacces",
    "eperm",
    "could not inspect",
    "unable to inspect",
  ]);
}

function isPermissionExceptionExampleLine(lower) {
  return includesPermissionFailureLiteral(lower)
    && !hasConcretePermissionActionPhrase(lower)
    && includesAny(lower, [
      "e.g.",
      "for example",
      "such as",
    ])
    && includesAny(lower, [
      "exception",
      "throws",
      "thrown",
      "spawn",
      "retry",
      "fallback",
    ]);
}

function isInjectedPermissionTestProofLine(lower) {
  return includesPermissionFailureLiteral(lower)
    && !hasConcretePermissionActionPhrase(lower)
    && includesAny(lower, [
      "test",
      "fixture",
      "helper",
    ])
    && includesAny(lower, [
      "injects",
      "injected",
      "injecting",
      "simulates",
      "simulated",
      "forces",
      "forced",
    ])
    && includesAny(lower, [
      "cleanup",
      "failure path",
      "coverage",
      "rename",
      "mock",
      "proof",
    ]);
}

function isPermissionLiteralListLine(lower) {
  return (permissionFailureCodeTokenCount(lower) >= 2 || isQuotedPermissionLiteralListLine(lower))
    && !hasConcretePermissionActionPhrase(lower)
    && includesAny(lower, [
      "\"",
      "'",
      ",",
      "token-bound",
      "token bound",
      "literal",
    ]);
}

function isQuotedPermissionLiteralListLine(lower) {
  return includesPermissionFailureLiteral(lower)
    && (lower.startsWith("\"") || lower.startsWith("'"))
    && (lower.includes("\",") || lower.includes("',"));
}

function isPermissionBoundaryExampleLine(lower) {
  return includesPermissionFailureLiteral(lower)
    && !hasConcretePermissionActionPhrase(lower)
    && includesAny(lower, [
      "correctly does not match",
      "not a boundary",
      "space before and after",
      "boundary at both ends",
      "standalone word",
      "lowered ",
    ]);
}

function isMockedPermissionLiteralLine(lower) {
  return includesAny(lower, [
    "mocked eacces",
    "mock eacces",
    "mocked eperm",
    "mock eperm",
    "mocked permissionerror",
    "mock permissionerror",
    "mocked permission denied",
    "mock permission denied",
  ]) && includesAny(lower, [
    "test",
    "failure path",
    "fixture",
    "warning recorded",
  ]);
}

function isOutOfScopePermissionNoteLine(lower) {
  if (!lower.includes("out-of-scope")) return false;
  if (!(includesPermissionFailureLiteral(lower) || lower.includes("permission block"))) {
    return false;
  }
  return includesAny(lower, [
    "authoritative file contents were fully supplied and reviewed",
    "authoritative file contents were fully supplied",
    "supplied file contents were fully reviewed",
    "supplied source was fully reviewed",
    "declared scope was fully reviewed",
    "declared scope fully reviewed",
  ]);
}

function isPermissionLiteralDiscussionLine(lower) {
  if (!includesPermissionFailureLiteral(lower)) {
    return false;
  }
  if (!includesAny(lower, [
    "regex breadth",
    "regex literal",
    "regex/pattern",
    "regular expression",
    "pattern term",
    "pattern discussion",
    "sandbox detection uses",
    "detection uses",
    "token-bound",
    "token bound",
    "tokenize",
    "matched via",
    "includespermissionfailureliteral",
    "includesanytoken",
    "includestoken",
    "iswordboundary",
    "uses /",
    "`/",
    "/operation not permitted",
    "/permission denied",
    "/permissionerror",
    "/eacces",
    "/eperm",
  ])) {
    return false;
  }
  return !hasConcretePermissionActionPhrase(lower);
}

function hasConcretePermissionActionPhrase(lower) {
  return includesAny(lower, [
    "prevented file access",
    "prevented access",
    "while reading",
    "while inspecting",
    "could not inspect",
    "cannot inspect",
    "can't inspect",
    "unable to inspect",
    "could not read",
    "cannot read",
    "can't read",
    "unable to read",
  ]);
}

function isPermissionMechanicsDiscussionLine(lower) {
  if (!(includesPermissionFailureLiteral(lower) || includesAny(lower, [
    "permission block",
    "could not inspect",
    "unable to inspect",
  ]))) {
    return false;
  }
  if (lower.includes("|") && includesAny(lower, [
    "flagged",
    "not flagged",
    "input text",
  ])) {
    return true;
  }
  if (!(includesAny(lower, [
    "linehasconcretepermissionfailure",
    "ispermissionliteraldiscussionline",
    "ispermissionfailureexampleline",
    "semanticfailurereasons",
    "semantic-reason extraction",
    "predicate",
    "branch ordering",
    "control-flow",
    "exclusion phrase",
    "exclusion list",
    "line contains",
    "counterexample",
    "test case",
    "test suite",
    "test coverage",
    "test verifies",
    "test assertion",
    "test asserts",
    "test confirms",
    "line is flagged",
    "is flagged",
    "permission detection",
    "review-quality audit",
    "mechanics-discussion",
    "token-bound",
    "token bound",
    "tokenize",
    "false positive",
    "inside words",
    "standalone word",
    "boundary",
    "includespermissionfailureliteral",
    "includesanytoken",
    "includestoken",
    "iswordboundary",
    "concrete action phrase",
    "reviewer prose incidentally contains",
    "required shape",
    "real-failure shape",
    "real selected-source/read-denial failures",
    "fail-closed verification",
  ]) && includesAny(lower, [
    "guard",
    "function",
    "predicate",
    "branch",
    "filter",
    "binding",
    "checklist row",
    "surfaced",
    "test",
    "flagged",
    "not flagged",
    "suppress",
    "literal",
    "exclusion",
    "match",
    "matches",
    "matching",
    "token",
    "boundary",
    "detect",
    "detection",
    "parser",
    "fixture",
    "example",
    "counterexample",
  ]))) {
    return false;
  }
  if (!hasConcretePermissionActionPhrase(lower)) return true;
  return includesAny(lower, [
    "e.g.",
    "example",
    "examples such as",
    "counterexample",
    "fixture",
    "input text",
    "such as",
    "line does not contain",
    "does not contain a concrete-action",
    "requires both",
    "fail-closed verification",
    "control-flow verification",
    "preserves real permission failures",
    "passing checklist row",
    "still flags",
    "correctly flagged",
    "still detected",
    "are still detected",
  ]);
}

function isPathTokenBoundary(char) {
  if (!char) return true;
  const code = char.charCodeAt(0);
  return !(
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === "_"
    || char === "."
    || char === "/"
    || char === "-"
  );
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function includesPathToken(text, path) {
  const value = String(text ?? "");
  const needle = String(path ?? "");
  if (!needle) return false;
  let index = value.indexOf(needle);
  while (index !== -1) {
    if (isPathTokenBoundary(value[index - 1])) {
      const afterIndex = index + needle.length;
      const after = value[afterIndex];
      if (isPathTokenBoundary(after)) return true;
      // A path token can end a sentence: match "a.js." without making "."
      // a general boundary, which would also match inside "data.js".
      if (after === "." && (afterIndex + 1 === value.length || isWhitespace(value[afterIndex + 1]))) {
        return true;
      }
    }
    index = value.indexOf(needle, index + 1);
  }
  return false;
}

function mentionsSelectedSourcePath(lowerLine, selectedSource) {
  const files = selectedSource?.files;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.some((file) => {
    const path = String(file?.path ?? "").toLowerCase();
    return path && includesPathToken(lowerLine, path);
  });
}

function isLocalFileScopeBoundaryLine(lower) {
  if (!includesAny(lower, [
    "did not inspect local files",
    "did not inspect the local files",
    "did not inspect repository files",
    "did not inspect any other repository files",
    "did not inspect out-of-scope files",
  ])) return false;
  return includesAny(lower, [
    "scope inspected",
    "supplied packet",
    "supplied source packet",
    "fully reviewed",
    "selected file was evaluated",
    "selected source was evaluated",
  ]);
}

function lineDeniesSelectedSourceInspection(line, selectedSource) {
  const lower = stripLeadingReviewMarkup(line).toLowerCase();
  if (isPermissionMechanicsDiscussionLine(lower)) return false;
  if (isSelectedSourceInspectionMechanicsDiscussionLine(lower)) return false;
  if (isLocalFileScopeBoundaryLine(lower)) return false;
  if (isOutOfScopeInspectionGapLine(lower) && !mentionsSelectedSourceGeneric(lower)) return false;
  if (!includesAny(lower, ["did not inspect", "not inspected", "could not inspect", "unable to inspect"])) {
    return false;
  }
  if (mentionsSelectedSourcePath(lower, selectedSource)) return true;
  return includesAny(lower, [
    "selected file",
    "selected files",
    "selected source",
    "source file",
    "source files",
    "target file",
    "target files",
  ]);
}

function mentionsSelectedSourceGeneric(lower) {
  return includesAny(lower, [
    "selected file",
    "selected files",
    "selected source",
    "supplied file",
    "supplied files",
    "supplied source",
    "source file",
    "source files",
    "target file",
    "target files",
  ]);
}

function isSelectedSourceInspectionMechanicsDiscussionLine(lower) {
  return includesAny(lower, [
    "linedeniesselectedsourceinspection",
    "selected source inspection predicate",
  ]) && includesAny(lower, [
    "did not inspect",
    "selected files",
    "selected source",
    "would be flagged",
    "could be flagged",
  ]);
}

function isOutOfScopeInspectionGapLine(lower) {
  if (!includesAny(lower, ["could not inspect", "unable to inspect", "not inspected", "not reviewed"])) return false;
  return includesAny(lower, [
    "out of scope",
    "outside the review packet",
    "outside this packet",
    "outside the supplied packet",
    "outside the supplied source packet",
    "not part of this packet",
    "not supplied",
    "not included in the prompt",
  ]);
}

function isNegatedTruncationLine(lower) {
  if (lower.includes("did not encounter") && includesAny(lower, ["truncated", "truncation"])) return true;
  return includesAny(lower, [
    "no truncation",
    "without truncation",
    "untruncated",
    "not truncated",
    "full file contents supplied",
    "source was complete",
  ]);
}

function lineClaimsSelectedSourceTruncation(line, selectedSource) {
  const lower = stripLeadingReviewMarkup(line).toLowerCase();
  if (isPromptPolicyEchoLine(line)) return false;
  if (!includesAny(lower, ["truncated", "truncation", "unsupplied remainder"])) return false;
  if (isNegatedTruncationLine(lower)) return false;
  if (mentionsSelectedSourcePath(lower, selectedSource)) return true;
  return includesAny(lower, [
    "supplied file",
    "supplied source",
    "selected file",
    "selected source",
    "unsupplied remainder",
  ]);
}

function semanticFailureReasons(text, looksShallow, selectedSource = null) {
  const reasons = [];
  const hasNotReviewedVerdict = reviewLines(text).some((rawLine) => {
    const line = stripLeadingReviewMarkup(rawLine).replace(/[*`]/g, "").replace(/_/g, " ").toLowerCase();
    return startsWithLabel(line, "verdict") && line.includes("not reviewed");
  });
  const semanticLines = reviewLines(text).filter((line) => {
    const hasPermissionFailure = lineHasConcretePermissionFailure(line);
    const unmarkedLower = unmarkReviewText(line).toLowerCase();
    return (
      !(isPassingChecklistLine(line) && !hasPermissionFailure)
        && !isPromptPolicyEchoLine(line)
        && !isNegatedPermissionBlockLine(line)
        && !isPermissionFailureExampleLine(unmarkedLower)
    );
  });
  const semanticText = semanticLines
    .filter((line) => !isOutOfScopeInspectionGapLine(unmarkReviewText(line).toLowerCase()))
    .join("\n")
    .toLowerCase();
  if (hasNotReviewedVerdict || semanticLines.some((line) => lineClaimsFailedReviewSlot(line)) || includesAny(semanticText, [
    "this is not an approval",
    "no file content examined",
    "no files examined",
    "no source inspected",
    "selected file inspection failed",
    "selected source inspection failed",
    "selected files were not inspected",
    "selected source was not inspected",
    "could not inspect",
    "unable to inspect",
    "scope is unreachable",
    "target file not present",
    "target file was not present",
  ]) || semanticLines.some((line) => lineDeniesSelectedSourceInspection(line, selectedSource))
    || semanticLines.some((line) => lineClaimsSelectedSourceTruncation(line, selectedSource))) {
    reasons.push("not_reviewed");
  }
  if (semanticLines.some((line) => lineHasConcretePermissionFailure(line))) {
    reasons.push("permission_blocked");
  }
  if (looksShallow) {
    reasons.push("shallow_output");
  }
  return Object.freeze([...new Set(reasons)]);
}

function lineClaimsFailedReviewSlot(line) {
  const lower = unmarkReviewText(line).toLowerCase();
  if (!lower.includes("failed review slot")) return false;
  if (isPromptPolicyEchoLine(line) || isReviewQualityMechanicsExplanationLine(line)) return false;
  return includesAny(lower, [
    "this is a failed review slot",
    "this slot is a failed review slot",
    "review is a failed review slot",
    "treat this as a failed review slot",
    "treat this slot as a failed review slot",
    "should be treated as a failed review slot",
    "must be treated as a failed review slot",
    "failed review slot because",
    "failed review slot:",
  ]);
}

function isReviewQualityMechanicsExplanationLine(line) {
  const lower = unmarkReviewText(line).toLowerCase();
  return lower.includes("failed review slot") && includesAny(lower, [
    "echo",
    "future prose",
    "not a defect",
    "policy text",
    "failure trigger",
    "review-quality",
    "review quality",
    "semanticfailure",
    "qualityflags",
    "ispassingchecklistline",
    "lineclaimsfailedreviewslot",
    "must fail closed",
    "still do so",
    "requiring explicit phrases",
  ]);
}

function isPromptPolicyEchoLine(line) {
  const lower = unmarkReviewText(line).toLowerCase();
  return (
    lower.includes("treat timeout, truncation, interruption, permission block")
    && lower.includes("failed review slot")
  ) || (
    lower.includes("timed out, truncated, interrupted")
    && lower.includes("not an approval")
    && lower.includes("shallow")
  );
}

function isNegatedPermissionBlockLine(line) {
  const lower = unmarkReviewText(line).toLowerCase();
  if (lineHasConcretePermissionFailure(line)) return false;
  if (/\bwithout\b[^\n.]*\bpermission blocks?\b/.test(lower)) return true;
  return (
    lower.includes("permission block")
    && (
      lower.includes("no timeout")
      || lower.includes("no such failure")
      || lower.includes("without timeout")
      || lower.includes("review completed without")
      || lower.includes("no truncation")
    )
    && (
      lower.includes("occurred")
      || lower.includes("completed")
      || lower.includes("without")
    )
  );
}

function mentionsSelectedSourceInspection(lowerText, selectedSource) {
  if (!includesAny(lowerText, SELECTED_SOURCE_INSPECTION_VERBS)) return false;
  return mentionsSelectedSourcePath(lowerText, selectedSource);
}

const TINY_SOURCE_MAX_FILES = 1;
const TINY_SOURCE_MAX_BYTES = 512;
const TINY_SOURCE_MAX_LINES = 5;

function isTinySelectedSource(selectedSource) {
  const totals = selectedSource?.totals;
  return Number.isInteger(totals?.files)
    && Number.isInteger(totals?.bytes)
    && Number.isInteger(totals?.lines)
    && totals.files > 0
    && totals.files <= TINY_SOURCE_MAX_FILES
    && totals.bytes <= TINY_SOURCE_MAX_BYTES
    && totals.lines <= TINY_SOURCE_MAX_LINES;
}

function qualityFlags({
  result = "",
  status = null,
  errorCode = null,
  selectedSource = null,
} = {}) {
  const text = String(result ?? "");
  const lowerText = text.toLowerCase();
  const checklistItemsSeen = reviewLines(text).filter((line) => isChecklistVerdict(line)).length;
  const hasVerdictFlag = hasVerdict(text);
  const hasBlockingSection = includesAny(lowerText, [
    "blocking finding",
    "blocking findings",
    "blocker",
    "blockers",
  ]);
  const hasNonBlockingSection = includesAny(lowerText, [
    "non-blocking",
    "non blocking",
    "minor concern",
    "minor concerns",
    "residual risk",
    "residual risks",
  ]);
  const conciseTinyReview = isTinySelectedSource(selectedSource)
    && hasVerdictFlag
    && hasBlockingSection
    && hasNonBlockingSection
    && mentionsSelectedSourceInspection(lowerText, selectedSource);
  const looksShallow = text.trim().length > 0
    && text.trim().length < 500
    && !conciseTinyReview;
  const isFinalReviewAttempt = !["approval_request", "preflight_failed", "queued", "running"].includes(status);
  const failureReasons = [...semanticFailureReasons(text, looksShallow, selectedSource)];
  if (isFinalReviewAttempt && status === "completed" && !hasVerdictFlag) {
    failureReasons.push("missing_verdict");
  }
  const semanticReasons = Object.freeze([...new Set(failureReasons)]);
  return Object.freeze({
    has_verdict: hasVerdictFlag,
    has_blocking_section: hasBlockingSection,
    has_non_blocking_section: hasNonBlockingSection,
    checklist_items_seen: checklistItemsSeen,
    looks_shallow: looksShallow,
    semantic_failure_reasons: semanticReasons,
    failed_review_slot: isFinalReviewAttempt && (status !== "completed" || errorCode !== null || semanticReasons.length > 0),
  });
}

export function scopeResolutionReason(scopeInfo = {}) {
  const paths = scopeInfo.scope_paths ?? scopeInfo.paths;
  if (scopeInfo.scope === "branch-diff" || scopeInfo.name === "branch-diff") {
    const base = scopeInfo.scope_base ?? scopeInfo.base ?? "main";
    if (Array.isArray(paths) && paths.length > 0) {
      return `git diff -z --name-only ${base}...HEAD -- filtered by explicit --scope-paths`;
    }
    return `git diff -z --name-only ${base}...HEAD --`;
  }
  if (Array.isArray(paths) && paths.length > 0) {
    return "explicit --scope-paths";
  }
  return scopeInfo.scope ?? scopeInfo.name ?? null;
}

export function buildReviewAuditManifest({
  prompt = "",
  sourceFiles = [],
  git = {},
  promptBuilder = {},
  request = {},
  truncation = {},
  providerIds = {},
  scope = {},
  route = {},
  result = "",
  status = null,
  errorCode = null,
} = {}) {
  const selectedSource = sourceManifest(sourceFiles);
  const renderedPromptHash = hashObject(prompt);
  const routeStep = route.routeStep ?? null;
  const routeSteps = Array.isArray(route.routeSteps)
    ? Object.freeze(route.routeSteps.map((step) => Object.freeze({ ...step })))
    : null;
  const sourceBearing = route.sourceBearing ?? (
    selectedSource.totals.files > 0 || selectedSource.totals.bytes > 0
  );
  const sourcePacketPolicy = route.sourcePacketPolicy ?? evaluateSourcePacketPolicy({
    provider: request.provider ?? null,
    mode: route.mode ?? null,
    routeStep,
    providerCapabilities: route.providerCapabilities ?? {},
    selectedSource,
    sourceBearing,
    previousAttempt: route.previousAttempt ?? null,
    resendConfirmationApproved: route.resendConfirmationApproved === true,
    resumeWithoutSourceResend: route.resumeWithoutSourceResend === true,
    sourcePacketOverrideApproved: route.sourcePacketOverrideApproved === true,
    sourcePacketOverrideSource: route.sourcePacketOverrideSource ?? null,
  });
  const requestSettingsHash = reviewSlotRequestSettingsHash(request);
  const retryFingerprint = reviewSlotRetryFingerprint({
    provider: request.provider ?? null,
    mode: route.mode ?? scope.name ?? null,
    renderedPromptHash,
    selectedSource,
    reviewedHeadSha: git.headCommit ?? null,
    routeStep,
    scope: {
      name: scope.name ?? null,
      base: scope.base ?? null,
      paths: scope.paths ?? null,
    },
  });
  const priorAttempts = Array.isArray(route.reviewSlot?.priorAttempts)
    ? route.reviewSlot.priorAttempts
    : [
      route.previousAttempt?.review_slot ??
      route.previousAttempt?.review_metadata?.audit_manifest?.review_slot ??
      null,
    ].filter(Boolean);
  const retryPolicy = evaluateReviewSlotRetryPolicy({
    retryFingerprint,
    priorAttempts,
    disposition: route.reviewSlot?.disposition ?? "none",
    waiverArtifact: route.reviewSlot?.waiverArtifact ?? null,
    overrideArtifact: route.reviewSlot?.overrideArtifact ?? null,
  });
  const effectiveSourcePacketPolicy = retryPolicy.source_send_allowed === false
    ? Object.freeze({
      ...sourcePacketPolicy,
      source_send_allowed: false,
      source_packet_action: "review_slot_retry_blocked",
      source_content_transmission: "not_sent",
      source_packet_policy_error_code:
        retryPolicy.fail_closed_reason ?? "review_slot_retry_blocked",
      suggested_action:
        "Do not launch another same-packet review until the packet is split, the provider is switched, the slot is waived, or an explicit override artifact is recorded.",
    })
    : sourcePacketPolicy;
  const reviewQuality = qualityFlags({ result, status, errorCode, selectedSource });
  const sourceContentTransmission =
    effectiveSourcePacketPolicy.source_send_allowed === false
      ? (effectiveSourcePacketPolicy.source_content_transmission ?? "not_sent")
      : (route.sourceContentTransmission ?? effectiveSourcePacketPolicy.source_content_transmission ?? null);
  const reviewSlot = buildReviewSlotDisposition({
    provider: request.provider ?? null,
    mode: route.mode ?? scope.name ?? null,
    stage: route.reviewSlot?.stage ?? "final",
    slotId: route.reviewSlot?.slotId ?? null,
    attemptId: route.reviewSlot?.attemptId ?? providerIds.requestId ?? providerIds.sessionId ?? null,
    parentAttemptId: route.reviewSlot?.parentAttemptId ?? route.previousAttempt?.attempt_id ?? null,
    reviewedHeadSha: git.headCommit ?? null,
    currentHeadSha: route.reviewSlot?.currentHeadSha ?? git.headCommit ?? null,
    retryFingerprint,
    retryCount: retryPolicy.retry_count,
    retryDispositionRequired: retryPolicy.retry_disposition_required,
    requestSettingsHash,
    sourceState: sourceContentTransmission,
    status,
    errorCode,
    result,
    reviewQuality,
    disposition: route.reviewSlot?.disposition ?? retryPolicy.disposition,
    waiverArtifact: route.reviewSlot?.waiverArtifact ?? null,
    overrideArtifact: route.reviewSlot?.overrideArtifact ?? null,
  });
  return Object.freeze({
    schema_version: REVIEW_AUDIT_MANIFEST_VERSION,
    rendered_prompt_hash: renderedPromptHash,
    selected_source: selectedSource,
    git_identity: Object.freeze({
      remote: git.remote ?? null,
      branch: git.branch ?? null,
      base_ref: git.baseRef ?? null,
      base_sha: git.baseCommit ?? null,
      head_ref: git.headRef ?? null,
      head_sha: git.headCommit ?? null,
      diff_stat: git.diffStat ?? null,
    }),
    prompt_builder: Object.freeze({
      contract_version: promptBuilder.contractVersion ?? null,
      plugin_version: promptBuilder.pluginVersion ?? null,
      plugin_commit: promptBuilder.pluginCommit ?? null,
    }),
    request: Object.freeze({
      provider: request.provider ?? null,
      model: request.model ?? null,
      timeout_ms: request.timeoutMs ?? null,
      max_tokens: request.maxTokens ?? null,
      max_steps_per_turn: request.maxStepsPerTurn ?? null,
      temperature: request.temperature ?? null,
      stream: request.stream ?? null,
    }),
    truncation: Object.freeze({
      prompt: truncation.prompt ?? null,
      prompt_at_chars: truncation.promptAtChars ?? null,
      source: truncation.source ?? null,
      source_at_bytes: truncation.sourceAtBytes ?? null,
      output: truncation.output ?? null,
      output_at_chars: truncation.outputAtChars ?? null,
    }),
    provider_ids: Object.freeze({
      request_id: providerIds.requestId ?? null,
      session_id: providerIds.sessionId ?? null,
    }),
    scope_resolution: Object.freeze({
      scope: scope.name ?? null,
      scope_base: scope.base ?? null,
      scope_paths: Array.isArray(scope.paths) ? Object.freeze([...scope.paths]) : null,
      reason: scope.reason ?? null,
    }),
    selected_route: route.selectedRoute ?? null,
    route_step: routeStep,
    route_steps: routeSteps,
    fallback_reason: route.fallbackReason ?? null,
    approval_scope: route.approvalScope ?? null,
    auth_path: route.authPath ?? null,
    billing_path: route.billingPath ?? null,
    source_bearing: sourceBearing,
    source_content_transmission: sourceContentTransmission,
    source_send_approval_required: route.sourceSendApprovalRequired ?? null,
    source_send_approval_state: route.sourceSendApprovalState ?? null,
    source_packet_policy: Object.freeze({ ...effectiveSourcePacketPolicy }),
    review_slot_retry_policy: Object.freeze({ ...retryPolicy }),
    review_slot: reviewSlot,
    error_code: errorCode,
    review_quality: reviewQuality,
  });
}

function line(name, value) {
  return `${name}: ${value ?? "unknown"}`;
}

function listBlock(title, values) {
  const entries = Array.isArray(values) && values.length > 0 ? values : ["unknown"];
  return [title, ...entries.map((value) => `- ${value}`)].join("\n");
}

function normalizeReviewPromptContractStyle(contractStyle) {
  const style = contractStyle ?? "standard";
  if (REVIEW_PROMPT_CONTRACT_STYLES.includes(style)) return style;
  throw new Error(`unsupported_review_prompt_contract_style:${String(style)}`);
}

function providerInstructionsBlock(instructions) {
  return instructions.length
    ? ["Provider-specific instructions", ...instructions.map((value) => `- ${value}`)].join("\n")
    : null;
}

function buildCompactReviewPrompt({
  provider,
  mode,
  repository,
  baseRef,
  baseCommit,
  headRef,
  headCommit,
  scope,
  scopePaths,
  userPrompt,
  instructions,
}) {
  return [
    "Delegated compact review contract",
    line("Provider", provider),
    line("Mode", mode),
    line("Repository", repository),
    line("Base ref", baseRef),
    line("Base commit", baseCommit),
    line("Head ref", headRef),
    line("Head commit", headCommit),
    line("Scope", scope),
    listBlock("Scope paths", scopePaths),
    "",
    "Output requirements",
    "- First line exactly one verdict marker: \"Verdict: APPROVE\", \"Verdict: REQUEST_CHANGES\", or \"Verdict: NOT_REVIEWED\".",
    "- Review only supplied selected source, refs, commits, scope paths, and audit metadata. Missing outside tools are NOT REVIEWED, not code blockers.",
    "- Name inspected selected file path(s). Bare numbered answers or only 'None' are invalid.",
    "- Blocking findings first with concrete file/function/control-flow evidence.",
    "- Non-blocking concerns separately.",
    "- Checklist: include PASS/FAIL/NOT REVIEWED for refs, scope, correctness, review comments, finding separation, and runtime completeness.",
    "- If a section has no findings, write a complete sentence naming the relevant selected file or scope.",
    "- Timed out, truncated, interrupted, blocked, or shallow output is NOT approval.",
    "- Do not edit files.",
    providerInstructionsBlock(instructions),
    userPrompt ? `User prompt:\n${userPrompt}` : null,
  ].filter((value) => value !== null).join("\n");
}

function sourceBlockDelimiter(file, index, delimiterPrefix, delimiterCorpus) {
  let delimiter = `${delimiterPrefix} ${index}: ${file.path}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!delimiterCorpus.includes(`BEGIN ${delimiter}`) && !delimiterCorpus.includes(`END ${delimiter}`)) {
      return delimiter;
    }
    delimiter = `${delimiter} #`;
  }
  throw new Error(`scope_delimiter_collision:${file.path}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourcePathFromDelimiter(delimiter, delimiterPrefix) {
  const match = new RegExp(`^${escapeRegExp(delimiterPrefix)}\\s+\\d+:\\s+(.+?)(?: #)*$`, "u").exec(delimiter);
  return match?.[1] ?? null;
}

/**
 * Builds a delimiter-guarded source block for review prompts.
 *
 * Each selected file is wrapped in BEGIN/END markers that are escalated when
 * the marker text already appears in any selected source file. Returns null
 * when no source files are selected.
 */
export function buildSelectedSourcePromptBlock(sourceFiles = [], {
  title = "Selected files",
  delimiterPrefix = "REVIEW FILE",
} = {}) {
  const files = Array.isArray(sourceFiles) ? sourceFiles : [];
  if (files.length === 0) return null;
  // Prompt rendering materializes text independently from audit metadata so
  // either artifact can be built by callers without sharing mutable state.
  const entries = files.map((file) => ({
    file,
    text: contentBuffer(file).toString("utf8"),
  }));
  const delimiterCorpus = entries.map((entry) => entry.text).join("\n");
  const blocks = entries.map(({ file, text }, index) => {
    const delimiter = sourceBlockDelimiter(file, index + 1, delimiterPrefix, delimiterCorpus);
    return [
      `BEGIN ${delimiter}`,
      text,
      `END ${delimiter}`,
    ].join("\n");
  });
  return [title, ...blocks].join("\n");
}

export function selectedSourceFilesFromPrompt(prompt = "", {
  delimiterPrefix = "REVIEW FILE",
} = {}) {
  const lines = String(prompt ?? "").split(/\r?\n/u);
  const files = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const beginPrefix = `BEGIN ${delimiterPrefix} `;
    if (!lineText.startsWith(beginPrefix)) continue;
    const delimiter = lineText.slice("BEGIN ".length);
    const path = sourcePathFromDelimiter(delimiter, delimiterPrefix);
    if (!path) continue;
    const endLine = `END ${delimiter}`;
    const body = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor] === endLine) break;
      body.push(lines[cursor]);
    }
    if (cursor >= lines.length) continue;
    files.push({ path, text: body.join("\n") });
    index = cursor;
  }
  return files.length > 0 ? files : null;
}

export function buildReviewPrompt({
  provider,
  mode,
  repository = null,
  baseRef = null,
  baseCommit = null,
  headRef = null,
  headCommit = null,
  scope,
  scopePaths = [],
  userPrompt = "",
  extraInstructions = [],
  contractStyle = "standard",
} = {}) {
  const checklist = REVIEW_PROMPT_CHECKLIST.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const instructions = Array.isArray(extraInstructions) ? extraInstructions.filter(Boolean) : [];
  const normalizedContractStyle = normalizeReviewPromptContractStyle(contractStyle);
  if (normalizedContractStyle === "compact") {
    return buildCompactReviewPrompt({
      provider,
      mode,
      repository,
      baseRef,
      baseCommit,
      headRef,
      headCommit,
      scope,
      scopePaths,
      userPrompt,
      instructions,
    });
  }
  return [
    "Delegated review quality contract",
    line("Provider", provider),
    line("Mode", mode),
    line("Repository", repository),
    line("Base ref", baseRef),
    line("Base commit", baseCommit),
    line("Head ref", headRef),
    line("Head commit", headCommit),
    line("Scope", scope),
    listBlock("Scope paths", scopePaths),
    "",
    "Checklist",
    checklist,
    "",
    "Output requirements",
    "- Treat the repository, refs, commits, scope paths, selected source, and audit metadata supplied in this prompt as the authoritative review evidence.",
    "- If git, GitHub, network, filesystem, or tool access is unavailable, mark only that check as NOT REVIEWED unless the required evidence is supplied here.",
    "- Do not report missing external tool access as a blocking code finding by itself.",
    "- Distinguish real blocking code findings from missing supplied evidence, runtime/tool limitations, and stale or unavailable external comments.",
    "- For every checklist item, report PASS, FAIL, or NOT REVIEWED.",
    "- Blocking findings first, with concrete file/function/control-flow evidence.",
    "- Start the first line with exactly one verdict marker: \"Verdict: APPROVE\", \"Verdict: REQUEST_CHANGES\", or \"Verdict: NOT_REVIEWED\".",
    "- A usable review must name the selected file path(s) inspected; bare numbered answers or section bodies such as only 'None' are shallow and invalid.",
    "- If a section has no findings, write a complete sentence that names the relevant selected file or scope and explains why no finding applies.",
    "- For control-flow and security code, explicitly inspect overlapping predicates, early returns, and branch ordering before concluding no blocker exists.",
    "- Do not upgrade speculative input-validation hardening into a blocking finding when the code is acceptable under the stated caller contract; use non-blocking concerns or test gaps instead.",
    "- APPROVE with non-blocking concerns or test gaps when code is acceptable and no concrete blocker is present.",
    "- Non-blocking concerns separately.",
    "- Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval.",
    "- Do not edit files.",
    providerInstructionsBlock(instructions),
    userPrompt ? `User prompt:\n${userPrompt}` : null,
  ].filter((value) => value !== null).join("\n");
}
