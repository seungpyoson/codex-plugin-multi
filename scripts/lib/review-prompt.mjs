import { createHash } from "node:crypto";

export const REVIEW_PROMPT_CHECKLIST = Object.freeze([
  "Verify exact base/head refs and commits before judging the diff.",
  "Review only the declared scope and list any scope gaps as NOT REVIEWED.",
  "Evaluate correctness bugs, security risks, regressions, and missing tests.",
  "Check known review comments or residual threads when the prompt includes them.",
  "Separate blocking findings from non-blocking concerns.",
  "Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot.",
]);

export const REVIEW_PROMPT_CONTRACT_VERSION = 1;
export const REVIEW_AUDIT_MANIFEST_VERSION = 1;

function contentBuffer(file) {
  const content = file?.content;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(String(file?.text ?? ""), "utf8");
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

function stripLeadingReviewMarkup(line) {
  let out = String(line ?? "").trimStart();
  for (let i = 0; i < 10; i += 1) {
    const before = out;
    const checklist = checklistText(out);
    if (checklist) out = checklist;
    out = out.trimStart();
    while (out.startsWith(">")) out = out.slice(1).trimStart();
    while (out.startsWith("-") || out.startsWith("*")) out = out.slice(1).trimStart();
    while (out.startsWith("**") || out.startsWith("__")) out = out.slice(2).trimStart();
    while (out.startsWith("`")) out = out.slice(1).trimStart();
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
      || startsWithLabel(line, "summary")
      || startsWithToken(line, "approve")
      || startsWithToken(line, "approved")
      || startsWithToken(line, "request changes")
      || startsWithToken(line, "reject")
      || startsWithToken(line, "rejected");
  });
}

function checklistText(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("-") || trimmed.startsWith("*")) return trimmed.slice(1).trimStart();
  let index = 0;
  while (index < trimmed.length) {
    const code = trimmed.charCodeAt(index);
    if (code < 48 || code > 57) break;
    index += 1;
  }
  if (index === 0 || (trimmed[index] !== "." && trimmed[index] !== ")")) return null;
  return trimmed.slice(index + 1).trimStart();
}

function unmarkReviewText(text) {
  return stripLeadingReviewMarkup(text).replace(/[*_`]/g, "");
}

function checklistStatus(line) {
  const text = checklistText(line);
  if (!text) return null;
  const lower = unmarkReviewText(text).toLowerCase();
  if (startsWithToken(lower, "pass")) return "pass";
  if (startsWithToken(lower, "fail")) return "fail";
  if (startsWithToken(lower, "not reviewed")) return "not_reviewed";
  const statusMatch = lower.match(/(?:^|[:\-.\u2013\u2014|])\s*(pass|fail|not reviewed)\b/);
  if (!statusMatch) return null;
  return statusMatch[1].replace(" ", "_");
}

function isChecklistVerdict(line) {
  return checklistStatus(line) !== null;
}

function isPassingChecklistLine(line) {
  return checklistStatus(line) === "pass";
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
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

function isTokenWhitespace(char) {
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
      if (after === "." && (afterIndex + 1 === value.length || isTokenWhitespace(value[afterIndex + 1]))) {
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

function lineDeniesSelectedSourceInspection(line, selectedSource) {
  const lower = stripLeadingReviewMarkup(line).toLowerCase();
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

function semanticFailureReasons(text, looksShallow, selectedSource = null) {
  const reasons = [];
  const hasNotReviewedVerdict = reviewLines(text).some((rawLine) => {
    const line = unmarkReviewText(rawLine).toLowerCase();
    return startsWithLabel(line, "verdict") && line.includes("not reviewed");
  });
  const semanticLines = reviewLines(text).filter((line) => !isPassingChecklistLine(line));
  const semanticText = semanticLines.join("\n").toLowerCase();
  if (hasNotReviewedVerdict || includesAny(semanticText, [
    "failed review slot",
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
  ]) || semanticLines.some((line) => lineDeniesSelectedSourceInspection(line, selectedSource))) {
    reasons.push("not_reviewed");
  }
  if (includesAny(semanticText, [
    "permission denied",
    "permission block",
    "permission-denied",
    "read denied",
    "read-denied",
    "access denied",
    "tool denied",
  ])) {
    reasons.push("permission_blocked");
  }
  if (looksShallow) {
    reasons.push("shallow_output");
  }
  return Object.freeze([...new Set(reasons)]);
}

function mentionsSelectedSourceInspection(lowerText, selectedSource) {
  if (!includesAny(lowerText, ["inspected", "reviewed"])) return false;
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
  const terminalReviewStatus = !["approval_request", "preflight_failed"].includes(status);
  const failureReasons = [...semanticFailureReasons(text, looksShallow, selectedSource)];
  if (terminalReviewStatus && status === "completed" && !hasVerdictFlag) {
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
    failed_review_slot: terminalReviewStatus && (status !== "completed" || errorCode !== null || semanticReasons.length > 0),
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
  result = "",
  status = null,
  errorCode = null,
} = {}) {
  const selectedSource = sourceManifest(sourceFiles);
  return Object.freeze({
    schema_version: REVIEW_AUDIT_MANIFEST_VERSION,
    rendered_prompt_hash: hashObject(prompt),
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
    error_code: errorCode,
    review_quality: qualityFlags({ result, status, errorCode, selectedSource }),
  });
}

function line(name, value) {
  return `${name}: ${value ?? "unknown"}`;
}

function listBlock(title, values) {
  const entries = Array.isArray(values) && values.length > 0 ? values : ["unknown"];
  return [title, ...entries.map((value) => `- ${value}`)].join("\n");
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
} = {}) {
  const checklist = REVIEW_PROMPT_CHECKLIST.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const instructions = Array.isArray(extraInstructions) ? extraInstructions.filter(Boolean) : [];
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
    "- A usable review must name the selected file path(s) inspected; bare numbered answers or section bodies such as only 'None' are shallow and invalid.",
    "- If a section has no findings, write a complete sentence that names the relevant selected file or scope and explains why no finding applies.",
    "- For control-flow and security code, explicitly inspect overlapping predicates, early returns, and branch ordering before concluding no blocker exists.",
    "- Do not upgrade speculative input-validation hardening into a blocking finding when the code is acceptable under the stated caller contract; use non-blocking concerns or test gaps instead.",
    "- APPROVE with non-blocking concerns or test gaps when code is acceptable and no concrete blocker is present.",
    "- Non-blocking concerns separately.",
    "- Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval.",
    "- Do not edit files.",
    instructions.length ? ["Provider-specific instructions", ...instructions.map((value) => `- ${value}`)].join("\n") : null,
    userPrompt ? `User prompt:\n${userPrompt}` : null,
  ].filter((value) => value !== null).join("\n");
}
