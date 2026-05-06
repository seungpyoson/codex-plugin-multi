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
  if (Buffer.isBuffer(file?.content)) return file.content;
  if (file?.content instanceof Uint8Array) return Buffer.from(file.content);
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

function reviewLines(text) {
  return String(text ?? "").split("\n").map((line) => (
    line.endsWith("\r") ? line.slice(0, -1) : line
  ).trimStart());
}

function hasVerdict(text) {
  return reviewLines(text).some((rawLine) => {
    const line = rawLine.toLowerCase();
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

function isChecklistVerdict(line) {
  const text = checklistText(line);
  if (!text) return false;
  const lower = text.toLowerCase();
  return startsWithToken(lower, "pass")
    || startsWithToken(lower, "fail")
    || startsWithToken(lower, "not reviewed");
}

function includesAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function qualityFlags({ result = "", status = null, errorCode = null } = {}) {
  const text = String(result ?? "");
  const lowerText = text.toLowerCase();
  const checklistItemsSeen = reviewLines(text).filter((line) => isChecklistVerdict(line)).length;
  return Object.freeze({
    has_verdict: hasVerdict(text),
    has_blocking_section: includesAny(lowerText, [
      "blocking finding",
      "blocking findings",
      "blocker",
      "blockers",
    ]),
    has_non_blocking_section: includesAny(lowerText, [
      "non-blocking",
      "non blocking",
      "minor concern",
      "minor concerns",
      "residual risk",
      "residual risks",
    ]),
    checklist_items_seen: checklistItemsSeen,
    looks_shallow: text.trim().length > 0 && text.trim().length < 500,
    failed_review_slot: status !== "completed" || errorCode !== null,
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
  return Object.freeze({
    schema_version: REVIEW_AUDIT_MANIFEST_VERSION,
    rendered_prompt_hash: hashObject(prompt),
    selected_source: sourceManifest(sourceFiles),
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
    review_quality: qualityFlags({ result, status, errorCode }),
  });
}

function line(name, value) {
  return `${name}: ${value ?? "unknown"}`;
}

function listBlock(title, values) {
  const entries = Array.isArray(values) && values.length > 0 ? values : ["unknown"];
  return [title, ...entries.map((value) => `- ${value}`)].join("\n");
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
    "- For every checklist item, report PASS, FAIL, or NOT REVIEWED.",
    "- Blocking findings first, with concrete file/function/control-flow evidence.",
    "- Non-blocking concerns separately.",
    "- Timed out, truncated, interrupted, blocked, or shallow output is NOT an approval.",
    "- Do not edit files.",
    instructions.length ? ["Provider-specific instructions", ...instructions.map((value) => `- ${value}`)].join("\n") : null,
    userPrompt ? `User prompt:\n${userPrompt}` : null,
  ].filter((value) => value !== null).join("\n");
}
