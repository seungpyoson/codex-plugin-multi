export const USAGE_LIMIT_SAFE_MESSAGE = "Provider reported a quota, usage-tier, billing, or credit limit.";

const USAGE_LIMIT_DETAIL_RES = [
  /\b(?:insufficient_quota|payment_required)\b/i,
  /\busage limit\b/i,
  /\bquota\b/i,
  /\bbilling[_ -]?(?:cycle|account|limit|hard[_ -]?limit|quota)\b/i,
  /\bcredit limit\b/i,
  /\binsufficient credits\b/i,
];

export function isUsageLimitDetail(detail) {
  const text = String(detail ?? "");
  return USAGE_LIMIT_DETAIL_RES.some((pattern) => pattern.test(text));
}

export function usageLimitMessage(...values) {
  const text = values.filter((value) => value != null).map((value) => (
    typeof value === "string" ? value : JSON.stringify(value)
  )).join("\n").trim();
  if (!text || !isUsageLimitDetail(text)) return null;
  return USAGE_LIMIT_SAFE_MESSAGE;
}
