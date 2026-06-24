export function elapsedMs(startedAt, endedAt) {
  const start = Date.parse(String(startedAt ?? ""));
  const end = Date.parse(String(endedAt ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}
