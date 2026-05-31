// Codex marketplace policy values accepted by the current marketplace parser
// (verified 2026-05-31: Codex rejects "HIDDEN"; ON_INSTALL|ON_USE are the only
// accepted authentication values).
export const CODEX_MARKETPLACE_INSTALLATION_POLICIES = [
  "AVAILABLE",
  "NOT_AVAILABLE",
  "INSTALLED_BY_DEFAULT",
];

export const CODEX_MARKETPLACE_AUTHENTICATION_POLICIES = ["ON_INSTALL", "ON_USE"];
