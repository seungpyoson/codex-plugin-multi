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

export function badVerdictReviewFixture(extra = "") {
  return [
    "I inspected the selected source supplied in the prompt and found no blocking correctness or security issue for this fixture.",
    "I would approve this change if this were an approval workflow, but this line is not the required verdict marker.",
    "Blocking findings",
    "- None. The selected file content was available and inspected.",
    "Non-blocking concerns",
    "- None for this fixture.",
    "Test gaps",
    "- Existing smoke coverage is sufficient for the fixture path being exercised here.",
    "Inspection status",
    "- I inspected the selected files and did not encounter a read denial, permission denial, timeout, truncated output, or placeholder response.",
    "Checklist:",
    "- PASS selected source was inspectable.",
    "- PASS the response is substantive, not a shallow placeholder.",
    "- PASS no blocking finding is invented for the fixture.",
    extra,
  ].filter(Boolean).join("\n");
}
