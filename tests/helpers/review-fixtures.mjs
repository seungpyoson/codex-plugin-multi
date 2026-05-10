export function substantiveReviewFixture(extra = "") {
  return [
    "1. Verdict: APPROVE",
    "2. Blocking findings",
    "- None. I inspected the selected file content supplied in the prompt and found no blocking correctness or security issue for this fixture.",
    "3. Non-blocking concerns",
    "- None for this fixture.",
    "4. Test gaps",
    "- Existing test coverage is sufficient for the fixture path being exercised here.",
    "5. Inspection status",
    "- I inspected the selected files and did not encounter a read denial, permission denial, timeout, truncated output, or placeholder response.",
    "Checklist:",
    "- PASS selected source was inspectable.",
    "- PASS the response is not a shallow placeholder.",
    "- PASS no blocking finding is invented for the fixture.",
    extra,
  ].filter(Boolean).join("\n");
}
