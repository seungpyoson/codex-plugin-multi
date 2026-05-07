export const USAGE_LIMIT_DETAIL_RE = /(?:\b(?:insufficient_quota|payment_required)\b|\busage limit\b|\bquota\b|\bbilling[_ -]?(?:cycle|account|limit|hard[_ -]?limit|quota)\b|\bcredit limit\b|\binsufficient credits\b|Error code:\s*403\b)/i;
export const USAGE_LIMIT_SAFE_MESSAGE = "Provider reported a quota, usage-tier, billing, or credit limit.";

export function isUsageLimitDetail(detail) {
  return USAGE_LIMIT_DETAIL_RE.test(String(detail ?? ""));
}

export function usageLimitMessage(...values) {
  return usageLimitMessageWithMaxLength(800, ...values);
}

export function usageLimitMessageWithMaxLength(maxLength, ...values) {
  const text = values.filter((value) => value != null).map((value) => (
    typeof value === "string" ? value : JSON.stringify(value)
  )).join("\n").trim();
  if (!text || !isUsageLimitDetail(text)) return null;
  return USAGE_LIMIT_SAFE_MESSAGE;
}
