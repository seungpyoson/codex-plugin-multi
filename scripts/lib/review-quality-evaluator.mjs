function text(value) {
  return String(value ?? "");
}

function compact(value) {
  return text(value).replace(/\s+/g, " ").trim();
}

function finding(id, found) {
  return Object.freeze({ id, found: Boolean(found) });
}

function packet1Findings(output) {
  const squashed = compact(output);
  const totalSubtract = (
    /sum\s*-\s*item\.price/i.test(output)
    || (
      /\btotal\b/i.test(squashed)
      && /\b(subtract|subtracts|subtracted|minus|negative|negated)\b/i.test(squashed)
      && /\b(add|adds|adding|sum)\b/i.test(squashed)
    )
  );
  const hasDiscountAssignment = (
    /user\.plan\s*=\s*["']pro["']/i.test(output)
    || (
      /\b(hasDiscount|user\.plan|plan)\b/i.test(squashed)
      && /\b(assign|assignment|mutate|mutates|mutation|invalid[- ]?lhs|syntaxerror|comparison|===)\b/i.test(squashed)
    )
  );
  return [
    finding("total_subtracts_prices", totalSubtract),
    finding("has_discount_assignment", hasDiscountAssignment),
  ];
}

function packet2Findings(output) {
  const squashed = compact(output);
  const mentionsProtectedBranch = /broadProtectedAgentDirWrite/i.test(output)
    || /protected[- ](?:agent[- ])?dir(?:ectory)?/i.test(squashed)
    || /~\/\.(?:codex|claude)/i.test(output);
  const mentionsGateConfig = /codeMayConstructGateConfig/i.test(output)
    || /gate[-_ ]config(?:\.json)?/i.test(squashed);
  const mentionsOrdering = /\b(first|before|after|later|below|unreachable|never reaches|bypass|bypasses|skip|skips|control[- ]flow|branch ordering|returns? (?:early|immediately))\b/i.test(squashed);
  const mentionsApprovalStrength = /approvable\s*:\s*(?:true|false)/i.test(output)
    || /\bnon[- ]approvable\b/i.test(squashed)
    || /\bapproval (?:path|gate|branch)\b/i.test(squashed)
    || /\bprotected[- ]dir approval\b/i.test(squashed);
  return [
    finding(
      "gate_config_ordering_bypass",
      mentionsProtectedBranch && mentionsGateConfig && mentionsOrdering && mentionsApprovalStrength,
    ),
  ];
}

function normalizedHeading(line) {
  const trimmed = text(line).trim();
  const withoutMarkdown = trimmed.replace(/^#{1,6}\s+/, "");
  const withoutNumber = withoutMarkdown.replace(/^\d+[.)]\s*/, "");
  return withoutNumber.replace(/:$/, "").trim().toLowerCase();
}

const BLOCKING_SECTION_STOP_HEADINGS = new Set([
  "non-blocking",
  "non blocking",
  "non-blocking concerns",
  "non blocking concerns",
  "non-blocking findings",
  "non blocking findings",
  "suggestions",
  "minor issues",
  "checklist",
  "test gaps",
  "inspection status",
]);

function blockingSectionBody(output) {
  const lines = text(output).split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizedHeading(lines[index]) === "blocking findings") {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;

  const body = [];
  for (let index = start; index < lines.length; index += 1) {
    const heading = normalizedHeading(lines[index]);
    if (BLOCKING_SECTION_STOP_HEADINGS.has(heading)) {
      break;
    }
    body.push(lines[index]);
  }
  return body.join("\n");
}

function isBulletListItem(line) {
  const trimmed = text(line).trimStart();
  if (trimmed.length < 3) return false;
  if ((trimmed[0] === "-" || trimmed[0] === "*") && /\s/.test(trimmed[1])) {
    return trimmed.slice(2).trim().length > 0;
  }
  let index = 0;
  while (index < trimmed.length && trimmed.charCodeAt(index) >= 48 && trimmed.charCodeAt(index) <= 57) {
    index += 1;
  }
  if (index === 0 || (trimmed[index] !== "." && trimmed[index] !== ")")) return false;
  return /\s/.test(trimmed[index + 1] ?? "") && trimmed.slice(index + 2).trim().length > 0;
}

function hasBulletListItem(body) {
  return text(body).split(/\r?\n/).some((line) => isBulletListItem(line));
}

function blockingSectionSaysClean(body) {
  return /\b(none|no blocking|no blockers|no issues found|no significant issues|no actual problems|no real (?:concerns|issues)|nothing blocking)\b/i.test(body);
}

function cleanPacketFalsePositive(output) {
  const squashed = compact(output);
  if (/verdict\s*:\s*request changes/i.test(squashed)) return true;
  const body = blockingSectionBody(output);
  if (body === null) return false;
  if (blockingSectionSaysClean(body)) return false;
  return hasBulletListItem(body);
}

function packet3Findings(output) {
  return [
    finding("clean_packet_has_no_blockers", !cleanPacketFalsePositive(output)),
  ];
}

const PACKET_FINDERS = Object.freeze({
  packet1_correctness: packet1Findings,
  packet2_security: packet2Findings,
  packet3_clean: packet3Findings,
});

/**
 * Evaluates one A/B seeded review packet against its expected findings.
 *
 * Supported packet names are packet1_correctness, packet2_security, and
 * packet3_clean. The returned object reports found/missing seeded findings and
 * whether the clean packet received an invented blocking finding.
 */
export function evaluateSeededReviewPacket({ packet, output }) {
  if (!Object.hasOwn(PACKET_FINDERS, packet)) {
    throw new Error(`unsupported seeded packet: ${packet}`);
  }
  const normalizedOutput = text(output);
  const expectedFindings = PACKET_FINDERS[packet](normalizedOutput);
  const missing = expectedFindings.filter((item) => !item.found).map((item) => item.id);
  const falsePositive = packet === "packet3_clean" ? cleanPacketFalsePositive(normalizedOutput) : false;
  return Object.freeze({
    packet,
    expected_findings: Object.freeze(expectedFindings),
    expected_findings_found: missing.length === 0,
    missing_expected_findings: Object.freeze(missing),
    false_positive: falsePositive,
  });
}
