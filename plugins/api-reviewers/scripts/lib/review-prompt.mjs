export const REVIEW_PROMPT_CHECKLIST = Object.freeze([
  "Verify exact base/head refs and commits before judging the diff.",
  "Review only the declared scope and list any scope gaps as NOT REVIEWED.",
  "Evaluate correctness bugs, security risks, regressions, and missing tests.",
  "Check known review comments or residual threads when the prompt includes them.",
  "Separate blocking findings from non-blocking concerns.",
  "Treat timeout, truncation, interruption, permission block, or shallow output as a failed review slot.",
]);

export const REVIEW_PROMPT_CONTRACT_VERSION = 1;

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
