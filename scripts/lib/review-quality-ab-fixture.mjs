export const COMMON_AB_REVIEW_PROMPT = `Adversarially review the selected files. Return:

1. Verdict: APPROVE or REQUEST CHANGES.
2. Blocking findings first, with file/function evidence.
3. Non-blocking concerns.
4. Test gaps.
5. State explicitly if you could not inspect the selected files.
   Do not invent findings. If no blocker exists, say so.
6. Record elapsed wall time if your runtime exposes it; otherwise say elapsed time was not available.`;

export const AB_REVIEW_PACKETS = Object.freeze([
  Object.freeze({
    id: "packet1_correctness",
    files: Object.freeze([
      Object.freeze({
        path: "packet1_correctness/cart.js",
        source: `export function total(items) {
  return items.reduce((sum, item) => sum - item.price, 0);
}

export function hasDiscount(user) {
  return user && user.plan = "pro";
}
`,
      }),
    ]),
    expected_findings: Object.freeze([
      "total subtracts prices instead of adding them.",
      'hasDiscount assigns "pro" instead of comparing.',
    ]),
    expected_result: "REQUEST CHANGES with both correctness blockers.",
  }),
  Object.freeze({
    id: "packet2_security",
    files: Object.freeze([
      Object.freeze({
        path: "packet2_security/gate.js",
        source: `import crypto from "node:crypto";
import fs from "node:fs";

function hasWriteIntent(command) {
  return /\\b(write|touch|mkdir|rm|mv|cp|python3\\s+-c)\\b/i.test(command);
}

function referencesProtectedAgentDir(command) {
  return command.includes("~/.codex") || command.includes("~/.claude");
}

function codeMayConstructGateConfig(command) {
  const decoded = command.replace(/chr\\((\\d+)\\)/g, (_, n) => String.fromCharCode(Number(n)));
  return decoded.includes("gate-config.json");
}

function consumeProtectedDirApproval(command) {
  const token = crypto.createHash("sha256").update(command).digest("hex").slice(0, 12);
  const marker = \`/tmp/approval-\${token}\`;
  if (fs.existsSync(marker)) {
    fs.unlinkSync(marker);
    return true;
  }
  return false;
}

export function shouldDeny(command) {
  const broadProtectedAgentDirWrite =
    hasWriteIntent(command) && referencesProtectedAgentDir(command);

  if (broadProtectedAgentDirWrite) {
    if (consumeProtectedDirApproval(command)) return false;
    return { deny: true, approvable: true };
  }

  if (codeMayConstructGateConfig(command)) {
    return { deny: true, approvable: false };
  }

  return false;
}
`,
      }),
    ]),
    expected_findings: Object.freeze([
      "The gate-config construction check must run before the approvable protected-dir branch; otherwise an overlapping command can bypass the non-approvable denial after approval.",
    ]),
    expected_result: "REQUEST CHANGES with the exact gate-config ordering bypass.",
  }),
  Object.freeze({
    id: "packet3_clean",
    files: Object.freeze([
      Object.freeze({
        path: "packet3_clean/safe.js",
        source: `export function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\s+/g, " ");
}

export function total(items) {
  return items.reduce((sum, item) => sum + Number(item.price || 0), 0);
}

export function canReadDocument(user, document) {
  if (!user || !document) return false;
  if (document.visibility === "public") return true;
  return document.ownerId === user.id || user.roles.includes("admin");
}
`,
      }),
    ]),
    expected_findings: Object.freeze([]),
    expected_result: "No blocking findings. Minor non-blocking concerns or test gaps are acceptable; invented blockers are false positives.",
  }),
]);

export const MANUAL_RELAY_JUDGE_CONTEXT = [
  "Expected seeded findings for judging only. Do not include this answer key in reviewer prompts.",
  ...AB_REVIEW_PACKETS.map((packet) => [
    `Packet: ${packet.id}`,
    `Expected result: ${packet.expected_result}`,
    packet.expected_findings.length
      ? `Expected seeded findings:\n${packet.expected_findings.map((finding) => `- ${finding}`).join("\n")}`
      : "Expected seeded findings: none",
  ].join("\n")),
].join("\n\n");

export function buildManualRelayPacketPrompt(packetId) {
  const packet = AB_REVIEW_PACKETS.find((entry) => entry.id === packetId);
  if (!packet) throw new Error(`unknown A/B review packet: ${packetId}`);
  const files = packet.files.map((file) => [
    `File: ${file.path}`,
    "```js",
    file.source.trimEnd(),
    "```",
  ].join("\n")).join("\n\n");
  return [
    COMMON_AB_REVIEW_PROMPT,
    "",
    files,
  ].join("\n");
}
