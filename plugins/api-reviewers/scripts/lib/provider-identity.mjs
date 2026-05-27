import { createHash } from "node:crypto";

const HASH_VERSION = 1;
const FIELD_ORDER = Object.freeze([
  Object.freeze({ name: "account_id", keys: ["account_id", "accountId"] }),
  Object.freeze({ name: "email", keys: ["email"] }),
  Object.freeze({ name: "org_id", keys: ["org_id", "orgId"] }),
  Object.freeze({ name: "user_id", keys: ["user_id", "userId"] }),
]);

function providerSlug(provider) {
  const slug = String(provider ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function normalizedString(value, fieldName) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return fieldName === "email" ? trimmed.toLowerCase() : trimmed;
}

function fieldValue(fields, spec) {
  for (const key of spec.keys) {
    const value = normalizedString(fields?.[key], spec.name);
    if (value) return value;
  }
  return null;
}

function accountFingerprint(provider, identifiers) {
  const payload = JSON.stringify({
    version: HASH_VERSION,
    provider,
    identifiers,
  });
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(payload).digest("hex"),
  };
}

export function buildProviderAccountIdentity(provider, fields = {}) {
  const normalizedProvider = providerSlug(provider);
  const identifiers = [];

  for (const spec of FIELD_ORDER) {
    const value = fieldValue(fields, spec);
    if (value) identifiers.push([spec.name, value]);
  }

  if (identifiers.length === 0) return null;

  return Object.freeze({
    provider: normalizedProvider,
    identity_source: "provider_auth_status",
    identity_fields: Object.freeze(identifiers.map(([name]) => name)),
    account_fingerprint: Object.freeze(accountFingerprint(normalizedProvider, identifiers)),
  });
}
