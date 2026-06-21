import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProviderPolicyContract } from "../../scripts/lib/provider-route-policy.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIRECT_API_RELAY_PROVIDERS = ["deepseek", "glm"];
const COMPANION_RELAY_PROVIDERS = ["claude", "gemini", "kimi"];

function readRepoFile(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function readRepoJson(rel) {
  return JSON.parse(readRepoFile(rel));
}

function relayPluginName(provider) {
  return `relay-${provider}`;
}

function directApiRelayDocPaths({ includeSetup = false } = {}) {
  const workflows = includeSetup
    ? ["review", "adversarial-review", "custom-review", "setup"]
    : ["review", "adversarial-review", "custom-review"];
  return DIRECT_API_RELAY_PROVIDERS.flatMap((provider) =>
    workflows.flatMap((workflow) => {
      const skillName = `${provider}-${workflow}`;
      const root = `plugins/${relayPluginName(provider)}`;
      return [
        `${root}/skills/${skillName}/SKILL.md`,
        `${root}/commands/${skillName}.md`,
      ];
    })
  );
}

function companionSourceReviewDocPaths() {
  return COMPANION_RELAY_PROVIDERS.flatMap((provider) => {
    const root = `plugins/${provider}`;
    return [
      `${root}/commands/${provider}-review.md`,
      `${root}/commands/${provider}-adversarial-review.md`,
      `${root}/commands/${provider}-rescue.md`,
      `${root}/skills/${provider}-review/SKILL.md`,
      `${root}/skills/${provider}-adversarial-review/SKILL.md`,
      `${root}/skills/${provider}-rescue/SKILL.md`,
      `${root}/skills/${provider}-delegation/SKILL.md`,
    ];
  });
}

function grokSourceReviewDocPaths() {
  return [
    "plugins/grok/commands/grok-review.md",
    "plugins/grok/commands/grok-adversarial-review.md",
    "plugins/grok/commands/grok-custom-review.md",
    "plugins/grok/skills/grok-review/SKILL.md",
    "plugins/grok/skills/grok-adversarial-review/SKILL.md",
    "plugins/grok/skills/grok-custom-review/SKILL.md",
    "plugins/grok/skills/grok-delegation/SKILL.md",
  ];
}

function assertRepoPathExists(rel, label) {
  if (/^https?:\/\//.test(rel) || rel.startsWith("/private/") || /^missing:/i.test(rel)) return;
  assert.equal(existsSync(path.join(REPO_ROOT, rel)), true, `${label} points at missing repo path ${rel}`);
}

function assertOnlyKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  assert.deepEqual(extra, [], `${label} has unsupported keys`);
}

function resolveSchemaRef(root, ref) {
  assert.equal(ref.startsWith("#/"), true, `unsupported local schema ref ${ref}`);
  return ref.slice(2).split("/").reduce((value, part) => value?.[part], root);
}

function schemaTypeMatches(schema, value) {
  if (!schema.type) return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some((type) => {
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "null") return value === null;
    return typeof value === type;
  });
}

function assertSchemaAllowsValue(root, schema, value, label) {
  const resolved = schema.$ref ? resolveSchemaRef(root, schema.$ref) : schema;
  if (resolved.oneOf || resolved.anyOf) {
    const branches = resolved.oneOf ?? resolved.anyOf;
    const errors = [];
    for (const branch of branches) {
      try {
        assertSchemaAllowsValue(root, branch, value, label);
        return;
      } catch (error) {
        errors.push(error.message);
      }
    }
    assert.fail(`${label} did not match any schema branch: ${errors.join("; ")}`);
  }

  assert.equal(schemaTypeMatches(resolved, value), true, `${label} has unsupported type`);
  if (Object.hasOwn(resolved, "const")) {
    assert.deepEqual(value, resolved.const, `${label} const mismatch`);
  }
  if (resolved.enum) {
    assert.equal(resolved.enum.includes(value), true, `${label} enum mismatch`);
  }
  if (resolved.additionalProperties === false && value && typeof value === "object" && !Array.isArray(value)) {
    assertOnlyKeys(value, Object.keys(resolved.properties ?? {}), label);
  }
  if (Array.isArray(resolved.required) && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of resolved.required) {
      assert.equal(Object.hasOwn(value, key), true, `${label} missing required key ${key}`);
    }
  }
  if (resolved.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, propertySchema] of Object.entries(resolved.properties)) {
      if (Object.hasOwn(value, key)) {
        assertSchemaAllowsValue(root, propertySchema, value[key], `${label}.${key}`);
      }
    }
  }
  if (resolved.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      assertSchemaAllowsValue(root, resolved.items, item, `${label}[${index}]`);
    });
  }
}

function sampleSessionApprovalGrantRecord() {
  const approvalHash = "a".repeat(64);
  const workspaceHash = "b".repeat(64);
  const promptHash = "c".repeat(64);
  const contentHash = "d".repeat(64);
  const expiresAt = "2026-05-29T12:05:00.000Z";
  return {
    schema_version: 1,
    grant_id: `grant_${approvalHash}`,
    created_at: "2026-05-29T12:00:00.000Z",
    expires_at: expiresAt,
    grant_session_id: `session_${approvalHash.slice(0, 32)}`,
    provider_allowlist: ["glm"],
    mode_allowlist: ["review"],
    workspace_root_hash: workspaceHash,
    path_constraints: {
      scope: "custom",
      scope_paths: ["README.md"],
    },
    max_files: 1,
    max_bytes: 42,
    max_ttl_ms: 600000,
    approval_fingerprint: approvalHash,
    approval_tuple: {
      provider: "GLM",
      mode: "review",
      selected_source: {
        files: [
          {
            path: "README.md",
            bytes: 42,
            lines: 1,
            content_hash: {
              algorithm: "sha256",
              value: contentHash,
            },
          },
        ],
        totals: {
          files: 1,
          bytes: 42,
          lines: 1,
        },
      },
      rendered_prompt_hash: {
        algorithm: "sha256",
        value: promptHash,
      },
      request: {
        provider: "GLM",
        model: "glm-4.5",
        timeout_ms: 900000,
        max_tokens: 4096,
        max_steps_per_turn: null,
        temperature: 0,
        stream: false,
      },
      scope_resolution: {
        scope: "custom",
        scope_base: null,
        scope_paths: ["README.md"],
        reason: "explicit_scope_paths",
      },
      auth_path: {
        auth_mode: "api_key",
        credential_ref: "ZAI_API_KEY",
        credential_source: "env",
      },
      billing_path: {
        endpoint: "https://api.example.test/v1",
        model: "glm-4.5",
      },
      selected_route: "direct_api",
      route_step: "glm",
      route_steps: [
        {
          route: "glm",
          supported: true,
          attempted: true,
          selected: true,
          skipped_reason: null,
          fallback_reason: null,
        },
      ],
      fallback_reason: null,
      approval_scope: "grant",
      grant_bounds: {
        provider_allowlist: ["glm"],
        mode_allowlist: ["review"],
        workspace_root_hash: workspaceHash,
        path_constraints: {
          scope: "custom",
          scope_paths: ["README.md"],
        },
        max_files: 1,
        max_bytes: 42,
        expires_at: expiresAt,
        max_ttl_ms: 600000,
        schema_version: 1,
      },
    },
    activation: {
      activated_at: "2026-05-29T12:00:01.000Z",
      source_content_transmission: "not_sent",
      approval_source: "grant_approval_token",
    },
  };
}

const CANCEL_STATUSES = [
  "signaled",
  "already_terminal",
  "already_dead",
  "cancel_pending",
  "no_pid_info",
  "unverifiable",
  "stale_pid",
];

const CANCEL_ERRORS = [
  "bad_args",
  "not_found",
  "bad_state",
  "signal_failed",
  "cancel_failed",
];

function quotedValuesForField(markdown, field) {
  const values = new Set();
  const pattern = new RegExp(String.raw`${field}:\s*"([^"]+)"`, "g");
  for (const match of markdown.matchAll(pattern)) {
    values.add(match[1]);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

test("claude cancel docs reject foreground cancel and direct users to Ctrl+C", () => {
  const command = readRepoFile("plugins/claude/commands/claude-cancel.md");
  const runtime = readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md");
  const combined = `${command}\n${runtime}`;

  assert.match(combined, /background job/i);
  assert.match(combined, /foreground/i);
  assert.match(combined, /Ctrl\+C/i);
  assert.doesNotMatch(combined, /foreground[^.\n]*(SIGTERM|SIGKILL|cancel)/i,
    "foreground cancellation must not be documented as companion signaling");
  assert.match(command, /error:\s*"signal_failed"/,
    "signal_failed is emitted through the error envelope, not a status envelope");
  assert.doesNotMatch(command, /status:\s*"signal_failed"/,
    "signal_failed docs must not imply a status field");
});

test("cancel command docs enumerate the runtime status and error contracts", () => {
  for (const target of ["claude", "gemini"]) {
    const command = readRepoFile(`plugins/${target}/commands/${target}-cancel.md`);

    assert.deepEqual(
      quotedValuesForField(command, "status"),
      [...CANCEL_STATUSES].sort((a, b) => a.localeCompare(b)),
      `${target}-cancel.md must enumerate exactly the status values cmdCancel emits`,
    );
    assert.deepEqual(
      quotedValuesForField(command, "error"),
      [...CANCEL_ERRORS].sort((a, b) => a.localeCompare(b)),
      `${target}-cancel.md must enumerate exactly the error values cmdCancel emits`,
    );
    assert.match(command, /Exit `0`[\s\S]*signaled[\s\S]*already_terminal[\s\S]*already_dead[\s\S]*cancel_pending/);
    assert.match(command, /Exit `1`[\s\S]*bad_args[\s\S]*not_found[\s\S]*bad_state[\s\S]*signal_failed[\s\S]*cancel_failed/);
    assert.match(command, /Exit `2`[\s\S]*no_pid_info[\s\S]*unverifiable[\s\S]*stale_pid/);
    assert.doesNotMatch(command, /state will reconcile/i,
      "already_dead must not promise a reconcile path the runtime does not implement");
  }
});

test("artifact cleanup inventory covers every provider, review mode, and owned artifact class", () => {
  const doc = readRepoFile("docs/artifact-cleanup-inventory.md");

  for (const provider of ["Claude", "Gemini", "Kimi", "DeepSeek", "GLM", "Grok Web"]) {
    assert.match(doc, new RegExp(`\\b${provider}\\b`), `missing provider ${provider}`);
  }
  for (const mode of ["review", "adversarial-review", "custom-review", "rescue", "foreground", "background", "continue"]) {
    assert.match(doc, new RegExp(`\\b${mode}\\b`), `missing mode ${mode}`);
  }
  for (const artifact of [
    "state.json",
    "<jobId>.json",
    "<jobId>.json.*.tmp",
    "<jobId>.log",
    "prompt.txt",
    "runtime-options.json",
    "cancel-requested.flag",
    "git-status-before.txt",
    "git-status-after.txt",
    "stdout.log",
    "stderr.log",
    "Containment worktree",
    "Neutral cwd",
    "jobs/<jobId>/meta.json",
    "jobs/<jobId>/meta.json.*.tmp",
  ]) {
    assert.match(doc, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing artifact ${artifact}`);
  }
  assert.match(doc, /does not persist prompt sidecars, copied review bundles, branch-diff files, stdout\/stderr logs, PID records, cancel markers, or subprocess state/);
  assert.match(doc, /retained-history pruning does not signal processes/);
  assert.match(doc, /starttime.*argv0/s);
});

test("README documents cache doctor automation for stale plugin skill discovery", () => {
  const readme = readRepoFile("README.md");
  const pkg = JSON.parse(readRepoFile("package.json"));

  assert.match(pkg.scripts["doctor:cache"] ?? "", /codex-plugin-cache-doctor\.mjs/);
  assert.match(readme, /npm run doctor:cache/);
  assert.match(readme, /codex plugin marketplace upgrade relay-for-codex/);
  assert.match(readme, /second-codex/i);
  assert.match(readme, /restart/i);
  assert.match(readme, /codex debug prompt-input 'list skills'/);
});



test("README keeps operator-facing auth-mode auto rejected", () => {
  const readme = readRepoFile("README.md");

  assert.doesNotMatch(readme, /--auth-mode subscription\|api_key\|auto/);
  assert.doesNotMatch(readme, /compatibility mode that tries OAuth\/subscription first/i);
  assert.match(readme, /ambiguous automatic auth selector is\s+rejected on operator-facing paths/);
});

test("Grok operator docs expose generic companion entrypoint", () => {
  const docs = [
    "plugins/grok/commands/grok-review.md",
    "plugins/grok/commands/grok-adversarial-review.md",
    "plugins/grok/commands/grok-custom-review.md",
    "plugins/grok/commands/grok-setup.md",
    "plugins/grok/skills/grok-review/SKILL.md",
    "plugins/grok/skills/grok-adversarial-review/SKILL.md",
    "plugins/grok/skills/grok-custom-review/SKILL.md",
    "plugins/grok/skills/grok-delegation/SKILL.md",
    "plugins/grok/skills/grok-setup/SKILL.md",
  ];

  for (const rel of docs) {
    const text = readRepoFile(rel);
    assert.equal(text.includes("plugins/grok/scripts/grok-companion.mjs"), true, `${rel} missing generic Grok companion`);
    assert.equal(text.includes("plugins/grok/scripts/grok-web-reviewer.mjs"), false, `${rel} exposes legacy web-named Grok script`);
  }
});

test("provider readiness waiver artifact contract names required approval and residual-risk fields", () => {
  const schema = JSON.parse(readRepoFile("docs/contracts/waiver.schema.json"));
  const example = JSON.parse(readRepoFile("docs/contracts/waiver.example.json"));
  const required = [
    "schema_version",
    "symptom_id",
    "task_id",
    "evidence_reviewed",
    "operator_approval_text",
    "expires_at",
    "residual_risk",
  ];

  assert.deepEqual(schema.required, required);
  assert.deepEqual(Object.keys(schema.properties.residual_risk.properties), [
    "source_send",
    "api",
    "auth",
    "local_state",
  ]);
  for (const field of required) {
    assert.ok(Object.hasOwn(example, field), `example missing ${field}`);
  }
  assert.equal(example.symptom_id, "S09");
  assert.match(example.task_id, /^T\d{3}$/);
  assert.ok(example.evidence_reviewed.length > 0);
  assert.ok(example.operator_approval_text.length > 0);
  assert.match(example.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(example.residual_risk), [
    "source_send",
    "api",
    "auth",
    "local_state",
  ]);
  for (const risk of Object.values(example.residual_risk)) {
    assert.equal(typeof risk.remains, "boolean");
    assert.equal(typeof risk.notes, "string");
  }
});




test("direct API docs describe bounded session grants without blanket bypass", () => {
  const readme = readRepoFile("README.md");
  const contracts = readRepoFile("scripts/lib/external-model-contracts.mjs");

  for (const doc of [readme, contracts]) {
    assert.match(doc, /approval-grant request/);
    assert.match(doc, /approval-grant activate/);
    assert.match(doc, /grant_bounds\.expires_at|expiry/);
    assert.match(doc, /source-free|do not send selected source|without sending selected source/i);
    assert.match(doc, /provider, mode, workspace/);
    assert.match(doc, /approval_required/);
    assert.doesNotMatch(doc, /always allow DeepSeek|always allow GLM|blanket/i);
  }
});





test("README documents no-mistakes as non-authoritative while issue 780 is open", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /no-mistakes/i);
  assert.match(readme, /claude-config\/issues\/780/);
  assert.match(readme, /not authoritative/i);
});

test("claude review command docs use current mutation schema fields", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /mutations/i);
  assert.doesNotMatch(docs, /warning:\s*"mutation_detected"/);
  assert.doesNotMatch(docs, /mutated_files/);
});

test("review command docs advertise --scope-base, not legacy --base", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /--scope-base REF/);
  assert.doesNotMatch(docs, /--base REF/);
});

test("review command docs route --scope-base as a companion flag", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
  ].join("\n");

  assert.match(docs, /pass `--scope-base REF` before `--`/i);
  assert.doesNotMatch(docs, /Passed as-is to the companion prompt/i);
});

test("review docs expose custom-review, preflight, and blocked-review wording", () => {
  const docs = [
    readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md"),
    readRepoFile("plugins/claude/commands/claude-review.md"),
    readRepoFile("plugins/claude/commands/claude-adversarial-review.md"),
    readRepoFile("plugins/gemini/skills/gemini-delegation/SKILL.md"),
    readRepoFile("plugins/gemini/commands/gemini-review.md"),
    readRepoFile("plugins/gemini/commands/gemini-adversarial-review.md"),
    readRepoFile("plugins/claude/skills/claude-result-handling/SKILL.md"),
  ].join("\n");

  assert.match(docs, /custom-review/);
  assert.match(docs, /preflight/);
  assert.match(docs, /approval-request/);
  assert.match(docs, /approval_token\.value/);
  assert.match(docs, /review blocked\s*\/\s*no findings produced/i);
  assert.match(docs, /relative paths/i);
  assert.doesNotMatch(docs, /policy decision rather than a plugin\/runtime failure/i);
});

test("companion reviewer docs require sandbox-first source-send execution", () => {
  for (const docPath of companionSourceReviewDocPaths()) {
    const doc = readRepoFile(docPath);
    assert.match(
      doc,
      /default Codex sandbox[\s\S]*source-bearing `run`/i,
      `${docPath} must tell agents to use the default sandbox for normal source sends`,
    );
    assert.match(
      doc,
      /do not request `sandbox_permissions: "require_escalated"`[\s\S]*normal source send/i,
      `${docPath} must forbid broad escalation for normal source sends`,
    );
    assert.match(
      doc,
      /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/i,
      `${docPath} must fail closed with sandbox_blocked/not_sent when default sandbox is insufficient`,
    );
  }
});

test("grok reviewer docs require sandbox-first source-send execution", () => {
  for (const docPath of grokSourceReviewDocPaths()) {
    const doc = readRepoFile(docPath);
    assert.match(
      doc,
      /default Codex sandbox[\s\S]*source-bearing `run`/i,
      `${docPath} must tell agents to use the default sandbox for normal source sends`,
    );
    assert.match(
      doc,
      /do not request `sandbox_permissions: "require_escalated"`[\s\S]*normal source send/i,
      `${docPath} must forbid broad escalation for normal source sends`,
    );
    assert.match(
      doc,
      /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/i,
      `${docPath} must fail closed with sandbox_blocked/not_sent when default sandbox is insufficient`,
    );
  }
});

test("setup docs do not claim unimplemented target version-floor checks", () => {
  const docs = [
    readRepoFile("plugins/claude/commands/claude-setup.md"),
    readRepoFile("plugins/claude/skills/claude-setup/SKILL.md"),
    readRepoFile("plugins/gemini/commands/gemini-setup.md"),
    readRepoFile("plugins/gemini/skills/gemini-setup/SKILL.md"),
  ].join("\n");

  assert.doesNotMatch(docs, /min-versions\.json/);
  assert.doesNotMatch(docs, /version is below floor/i);
  assert.match(docs, /sandbox_blocked[\s\S]*~\/\.claude/);
  assert.match(docs, /sandbox_blocked[\s\S]*~\/\.gemini/);
  assert.match(docs, /fresh Codex session/i);
});

test("gemini command docs match background/continue runtime and wired cancel", () => {
  const rescue = readRepoFile("plugins/gemini/commands/gemini-rescue.md");
  const cancel = readRepoFile("plugins/gemini/commands/gemini-cancel.md");

  assert.match(rescue, /--background/);
  assert.match(rescue, /--foreground/);
  assert.doesNotMatch(rescue, /foreground only/i);
  assert.doesNotMatch(rescue, /background support lands/i);

  // Gemini cancel is wired (PR #22 / commit 01f4282) — docs must NOT claim
  // it returns not_implemented or that it's deferred.
  assert.doesNotMatch(cancel, /not_implemented/,
    "gemini cancel is wired; docs must not claim not_implemented");
  assert.doesNotMatch(cancel, /\bdeferred\b/i,
    "gemini cancel is wired; docs must not claim it's deferred");
  assert.doesNotMatch(cancel, /M8 wires background cancel/i);
  // Must enumerate the canonical signaled-success status so operators
  // know cancel is operational.
  assert.match(cancel, /\bsignaled\b/);
});

test("gemini-delegation/SKILL.md describes cancel --job flow (not deferred/not_implemented)", () => {
  const skill = readRepoFile("plugins/gemini/skills/gemini-delegation/SKILL.md");

  assert.doesNotMatch(skill, /not_implemented/,
    "gemini-delegation/SKILL.md must not claim cancel returns not_implemented");
  assert.doesNotMatch(skill, /cancel is deferred/i,
    "gemini-delegation/SKILL.md must not say cancel is deferred");
  assert.doesNotMatch(skill, /cancel.*deferred|deferred.*cancel/i,
    "gemini-delegation/SKILL.md must not describe cancel as deferred");
  assert.match(skill, /cancel.*--job/i,
    "gemini-delegation/SKILL.md must document the `cancel --job` workflow");
});

test("companion preflight file sorting uses an explicit comparator", () => {
  const common = readRepoFile("scripts/lib/companion-common.mjs");
  assert.doesNotMatch(common, /\.sort\(\)/,
    "shared companion scope summary must not rely on default Array#sort ordering");
  assert.match(common, /files\.sort\(comparePathStrings\)/,
    "shared companion scope summary must sort preflight files with an explicit comparator");

  for (const target of ["claude", "gemini", "kimi"]) {
    const companion = readRepoFile(`plugins/${target}/scripts/${target}-companion.mjs`);

    assert.doesNotMatch(companion, /\.sort\(\)/,
      `${target} companion must not rely on default Array#sort ordering`);
    assert.match(companion, /summarizeScopeDirectory/,
      `${target} companion must use the shared explicit-sort scope summary`);
  }
});

test("architecture record does not reference an unshipped Gemini result-handling skill", () => {
  const arch = readRepoFile("docs/architecture-record.md");

  assert.doesNotMatch(arch, /gemini-result-handling/);
});

test("working-tree privacy docs distinguish git worktree from non-git directories", () => {
  // #16 follow-up 6: the gitignored-file filter only applies inside a git
  // worktree. Make sure operator-facing docs say so explicitly so callers
  // do not assume `.env` is hidden in arbitrary non-git directories.
  const docs = [
    readRepoFile("plugins/claude/skills/claude-cli-runtime/SKILL.md"),
    readRepoFile("plugins/claude/skills/claude-result-handling/SKILL.md"),
    readRepoFile("plugins/gemini/commands/gemini-result.md"),
  ];
  for (const doc of docs) {
    assert.match(
      doc,
      /non-git|inside a git worktree/i,
      "privacy docs must distinguish git from non-git source directories",
    );
  }
});

test("README documents shipped install path, first commands, and safety posture", () => {
  const readme = readRepoFile("README.md");

  assert.doesNotMatch(readme, /M0|M2\+|Planned surface/i);
  assert.match(readme, /codex plugin marketplace add relay-org\/relay/);
  assert.match(readme, /relay-for-claude:relay-gemini/);
  assert.match(readme, /relay-gemini@relay-for-claude/);
  assert.match(readme, /\/relay-gemini:review/);
  assert.match(readme, /\/plugins/);
  assert.match(readme, /user-invocable skill fallback/);
  assert.match(readme, /Claude, Gemini, Kimi, and\s+Grok delegation skills/);
  assert.match(readme, /DeepSeek and GLM are intentionally split/);
  assert.doesNotMatch(readme, /Diagnostic plugin dispatch check/);
  assert.doesNotMatch(readme, /\/claude-ping/);
  assert.doesNotMatch(readme, /\/gemini-ping/);
  assert.match(readme, /\/claude-review/);
  assert.match(readme, /\/gemini-review/);
  assert.match(readme, /\/claude-rescue/);
  assert.match(readme, /\/gemini-rescue/);
  assert.match(readme, /Gemini plan-mode is NOT a sandbox/);
  assert.match(readme, /read-only\.toml/);
  assert.match(readme, /--dispose/);
  assert.doesNotMatch(readme, /Gemini `cancel`.*deferred/i,
    "gemini cancel is wired (PR #22); README must not claim it's deferred");
  assert.match(readme, /docs\/e2e\.md/);
});

test("README documents host-owned pre-launch provider denials as outside companion control", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /pre-launch/i);
  assert.match(readme, /host-owned/i);
  assert.match(readme, /cannot emit a JobRecord/i);
  assert.match(readme, /approved provider/i);
  assert.match(readme, /local\/Codex-only review/i);
  assert.match(readme, /https:\/\/github\.com\/relay-org\/relay\/issues\/13/);
});

test("direct API reviewer docs require explicit approval for external source transmission", () => {
  for (const docPath of directApiRelayDocPaths()) {
    const doc = readRepoFile(docPath);
    assert.match(doc, /approval-request/, docPath);
    assert.match(doc, /explicit approval/i, docPath);
    assert.match(doc, /selected source content/i, docPath);
    assert.match(doc, /external provider|external API/i, docPath);
    assert.match(doc, /recommended_tool_justification/, docPath);
    assert.match(doc, /approval_token\.value/, docPath);
    assert.match(doc, /--approval-token/, docPath);
    assert.match(doc, /denial_action/, docPath);
    assert.match(doc, /relay prompt/i, docPath);
    assert.match(doc, /approval is denied/i, docPath);
  }
});

test("direct API reviewer docs require sandbox-first source-send execution", () => {
  for (const docPath of directApiRelayDocPaths()) {
    const doc = readRepoFile(docPath);
    assert.match(
      doc,
      /default Codex sandbox[\s\S]*source-bearing `run`/i,
      `${docPath} must tell agents to use the default sandbox for normal source sends`,
    );
    assert.match(
      doc,
      /do not request `sandbox_permissions: "require_escalated"`[\s\S]*normal source send/i,
      `${docPath} must forbid broad escalation for normal source sends`,
    );
    assert.match(
      doc,
      /sandbox_blocked[\s\S]*source_content_transmission: "not_sent"/i,
      `${docPath} must fail closed with sandbox_blocked/not_sent when default sandbox is insufficient`,
    );
  }
});

test("direct API reviewer skill and command docs use global installed script entrypoints", () => {
  for (const docPath of directApiRelayDocPaths({ includeSetup: true })) {
    const doc = readRepoFile(docPath);
    const provider = DIRECT_API_RELAY_PROVIDERS.find((item) => docPath.includes(`relay-${item}`));
    assert.ok(provider, `provider missing from ${docPath}`);
    const pluginName = relayPluginName(provider);
    const apiPluginVersion = readRepoJson(`plugins/${pluginName}/.codex-plugin/plugin.json`).version;
    const escapedVersion = apiPluginVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const installedEntrypoint = new RegExp(
      `node "\\$\\{CODEX_HOME:-\\$HOME/\\.codex\\}/plugins/cache/relay-for-codex/${pluginName}/${escapedVersion}/scripts/api-reviewer\\.mjs"`,
    );
    assert.match(doc, /## Entrypoint Contract/, docPath);
    assert.match(doc, installedEntrypoint, docPath);
    assert.match(doc, /global installed entrypoint/i, docPath);
    assert.match(doc, /do not run bare `api-reviewer`/i, docPath);
    assert.match(doc, /do not rely on `PATH`/i, docPath);
    assert.match(doc, /do not use repository-relative paths/i, docPath);
    assert.match(doc, /api_reviewer_entrypoint_missing/, docPath);
    assert.doesNotMatch(doc, /Run `api-reviewer\b/, docPath);
    assert.doesNotMatch(doc, /Bash\(api-reviewer:\*\)/, docPath);
    assert.doesNotMatch(doc, /node "<plugin-root>\/scripts\/api-reviewer\.mjs"/, docPath);
    assert.doesNotMatch(doc, /node plugins\/(?:api-reviewers|relay-(?:deepseek|glm))\/scripts\/api-reviewer\.mjs/, docPath);
  }
});

test("architecture record documents the full review quality audit shape", () => {
  const arch = readRepoFile("docs/architecture-record.md");
  const requiredFields = [
    "failed_review_slot",
  ];

  for (const field of requiredFields) {
    assert.match(arch, new RegExp(field), `missing review_quality field ${field}`);
  }
});

test("README documents Codex sandbox setup and provider-specific failure modes", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /\[sandbox_workspace_write\]/);
  assert.match(readme, /network_access = true/);
  assert.match(readme, /writable_roots/);
  assert.match(readme, /\/Users\/<you>\/\.claude/);
  assert.match(readme, /\/Users\/<you>\/\.gemini/);
  assert.match(readme, /\/Users\/<you>\/\.kimi-code\/logs/);
  assert.match(readme, /\/Users\/<you>\/\.kimi-code/);
  assert.match(readme, /sandbox_blocked[\s\S]*\.claude/);
  assert.match(readme, /sandbox_blocked[\s\S]*\.gemini/);
  assert.match(readme, /one-off escalation/i);
  assert.match(readme, /approve only that command/i);
  assert.match(readme, /danger-full-access|dangerously-bypass-approvals-and-sandbox/i);
  assert.match(readme, /do not make[\s\S]*default/i);
  assert.match(readme, /Gemini CLI.*native.*sandbox|native.*Gemini.*sandbox/i);
  assert.match(readme, /Kimi.*\.kimi-code/i);
  assert.match(readme, /Direct API reviewers|DeepSeek.*GLM/i);
  assert.match(readme, /selected source content[\s\S]*sent/i);
});

test("README documents Grok subscription-backed default and no paid API fallback", () => {
  const readme = readRepoFile("README.md");

  assert.match(readme, /Grok subscription/i);
  assert.match(readme, /local tunnel/i);
  assert.match(readme, /GROK_WEB_BASE_URL/);
  assert.match(readme, /subscription-backed Grok CLI transport/i);
  assert.match(readme, /legacy local web tunnel/i);
  assert.match(readme, /--transport auto[\s\S]*GROK_TRANSPORT=auto[\s\S]*CLI-primary fallback/i);
  assert.match(readme, /pre-source CLI readiness, login, auth-timeout, or\s+model-unavailable failure/i);
  assert.match(readme, /not.*api\.x\.ai/i);
  assert.match(readme, /does not silently\s+fall back/i);
});

test("cost and quota docs require safe diagnostics and explicit billing action", () => {
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("docs/e2e.md"),
    readRepoFile("docs/grok-subscription-tunnel.md"),
    readRepoFile("plugins/claude/skills/claude-result-handling/SKILL.md"),
  ].join("\n");

  assert.match(docs, /runtime_diagnostics\.cost_quota/);
  assert.match(docs, /usage_limited/);
  assert.match(docs, /quota|usage-tier|billing|credit-limit/i);
  assert.match(docs, /does not purchase credits|never purchases credits/i);
  assert.match(docs, /upgrade.*tiers|changes.*subscription tiers/i);
  assert.match(docs, /separate explicit user-approved action/i);
  assert.match(docs, /must not include[\s\S]*payment details/i);
  assert.match(docs, /full prompts|source bundles|raw provider payloads/i);
});

test("direct API e2e docs use the global installed script entrypoint and canonical GLM key", () => {
  const doc = readRepoFile("docs/e2e.md");

  assert.match(doc, /DEEPSEEK_RELAY_VERSION="\$\(node -p 'require\("\.\/plugins\/relay-deepseek\/\.codex-plugin\/plugin\.json"\)\.version'\)"/);
  assert.match(doc, /DEEPSEEK_REVIEWER="\$\{CODEX_HOME:-\$HOME\/\.codex\}\/plugins\/cache\/relay-for-codex\/relay-deepseek\/\$\{DEEPSEEK_RELAY_VERSION\}\/scripts\/api-reviewer\.mjs"/);
  assert.match(doc, /GLM_RELAY_VERSION="\$\(node -p 'require\("\.\/plugins\/relay-glm\/\.codex-plugin\/plugin\.json"\)\.version'\)"/);
  assert.match(doc, /GLM_REVIEWER="\$\{CODEX_HOME:-\$HOME\/\.codex\}\/plugins\/cache\/relay-for-codex\/relay-glm\/\$\{GLM_RELAY_VERSION\}\/scripts\/api-reviewer\.mjs"/);
  assert.match(doc, /node "\$DEEPSEEK_REVIEWER" doctor --provider deepseek/);
  assert.match(doc, /node "\$GLM_REVIEWER" doctor --provider glm/);
  assert.doesNotMatch(doc, /^api-reviewer /m);
  assert.doesNotMatch(doc, /node plugins\/(?:api-reviewers|relay-(?:deepseek|glm))\/scripts\/api-reviewer\.mjs/);
  assert.doesNotMatch(doc, /ZAI_GLM_API_KEY/);
  assert.match(doc, /ZAI_API_KEY/);
});

test("Grok setup docs describe a live local tunnel probe", () => {
  const docs = [
    readRepoFile("README.md"),
    readRepoFile("plugins/grok/commands/grok-setup.md"),
    readRepoFile("plugins/grok/skills/grok-delegation/SKILL.md"),
  ].join("\n");

  assert.match(docs, /\/api\/models|\/models/);
  assert.match(docs, /reachable/i);
  assert.match(docs, /tunnel_unavailable/);
  assert.match(docs, /auto-start|GROK2API_HOME/i);
});

test("Grok subscription tunnel runbook documents compatible setup without exposing cookies", () => {
  const readme = readRepoFile("README.md");
  const runbook = readRepoFile("docs/grok-subscription-tunnel.md");
  const docs = `${readme}\n${runbook}`;

  assert.match(readme, /docs\/grok-subscription-tunnel\.md/);
  assert.match(runbook, /grok2api/);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:8000\/v1/);
  assert.match(runbook, /Grok3-Tunnel/);
  assert.match(runbook, /swift-grok/i);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:11435\/api/);
  assert.match(runbook, /GROK_WEB_TUNNEL_API_KEY/);
  assert.match(runbook, /grok-companion\.mjs doctor --transport web/);
  assert.match(runbook, /grok-companion\.mjs list/);
  assert.match(runbook, /grok-companion\.mjs result --job-id <job_id>/);
  assert.match(runbook, /sso/);
  assert.match(runbook, /sso-rw/);
  assert.match(runbook, /Do not paste/i);
  assert.match(docs, /GROK_LIVE_E2E=1 npm run e2e:grok/);
  assert.doesNotMatch(runbook, /api\.x\.ai/i);
});

test("architecture record treats Grok web as separate from direct API reviewers", () => {
  const doc = readRepoFile("docs/architecture-record.md");

  assert.match(doc, /Grok Web/i);
  assert.match(doc, /subscription-backed/i);
  assert.match(doc, /local tunnel/i);
  assert.match(doc, /separate from `relay-deepseek` and `relay-glm`/i);
  assert.match(doc, /session cookies/i);
});


test("provider architecture parity table is machine-validatable and complete", () => {
  const schema = readRepoJson("docs/contracts/provider-parity-table.schema.json");
  const table = readRepoJson("docs/provider-parity-table.json");

  assertOnlyKeys(table, Object.keys(schema.properties), "provider parity table");
  for (const required of schema.required) {
    assert.ok(Object.hasOwn(table, required), `missing required top-level field ${required}`);
  }

  assert.equal(Number.isInteger(table.schema_version), true);
  assert.equal(table.schema_version >= 1, true);
  assert.equal(table.feature, "provider-architecture-parity");
  assert.deepEqual([...table.providers].sort(), ["claude", "deepseek", "gemini", "glm", "grok", "kimi"]);

  const providerPolicyContract = buildProviderPolicyContract();
  assert.deepEqual(table.providers, providerPolicyContract.providers);

  const semanticPolicy = table.semantic_drift_policy;
  assert.ok(semanticPolicy, "provider parity table must define semantic drift policy");
  assert.match(semanticPolicy.standard, /clear reason/i);
  assert.match(semanticPolicy.standard, /fake parity/i);
  assert.deepEqual(
    [...semanticPolicy.allowed_intentional_difference_types].sort(),
    ["adapter_capability_fact", "documented_policy_exception"],
  );
  assert.deepEqual(
    [...semanticPolicy.tracked_noncompliance_types].sort(),
    ["known_accidental_drift", "research_gap"],
  );
  for (const required of schema.$defs.semantic_drift_policy.required) {
    assert.ok(Object.hasOwn(semanticPolicy, required), `semantic drift policy missing ${required}`);
  }

  const requiredPolicyAreas = [
    "route/auth/source-send approval",
    "packet budgets",
    "review prompt contracts",
    "fallback semantics",
    "failure taxonomy",
    "suggested actions",
    "audit fields",
    "review-quality gates",
    "review-slot disposition",
    "status/UX normalization",
    "generated contracts",
    "docs",
    "packaged copies",
    "sync rules",
  ];
  const policyNames = new Set(table.policy_areas.map((area) => area.name));
  const expectedProviders = [...table.providers].sort();
  for (const name of requiredPolicyAreas) {
    assert.equal(policyNames.has(name), true, `missing policy area ${name}`);
  }

  const policySurfaceGuardrail = table.guardrail_tests.find((entry) => entry.name === "full provider policy surface");
  assert.ok(policySurfaceGuardrail, "provider parity table must define full provider policy surface guardrail");
  assert.deepEqual(
    [...policySurfaceGuardrail.required_fields].sort(),
    [...providerPolicyContract.domains.map((domain) => domain.name)].sort(),
  );

  const policyAllowedKeys = Object.keys(schema.$defs.policy_area.properties);
  for (const area of table.policy_areas) {
    assertOnlyKeys(area, policyAllowedKeys, `policy area ${area.name}`);
    for (const required of schema.$defs.policy_area.required) {
      assert.ok(Object.hasOwn(area, required), `policy area ${area.name} missing ${required}`);
    }
    assert.equal(Array.isArray(area.tests), true, `policy area ${area.name} tests must be an array`);
    assert.equal(area.tests.length > 0, true, `policy area ${area.name} must name at least one test`);
    assert.deepEqual(
      [...area.adapters].sort(),
      expectedProviders,
      `policy area ${area.name} must inventory all providers; narrower behavior belongs in classified exceptions`,
    );
    for (const testPath of area.tests) {
      assertRepoPathExists(testPath, `policy area ${area.name} test`);
    }
  }

  assert.deepEqual(
    {
      primary_issue: table.issue_fit.primary_issue,
      evidence_issue: table.issue_fit.evidence_issue,
      new_issue_required: table.issue_fit.new_issue_required,
    },
    { primary_issue: 171, evidence_issue: 170, new_issue_required: true },
  );
  for (const related of [144, 146, 147, 159, 160, 162, 167, 172, 173]) {
    assert.ok(table.issue_fit.related_issues.includes(related), `missing related issue ${related}`);
  }

  const exceptionAllowedKeys = Object.keys(schema.$defs.adapter_exception.properties);
  const exceptionRequiredKeys = schema.$defs.adapter_exception.required;
  const allowedIntentionalTypes = new Set(semanticPolicy.allowed_intentional_difference_types);
  const trackedNoncomplianceTypes = new Set(semanticPolicy.tracked_noncompliance_types);
  const providers = new Set(table.providers);
  for (const field of exceptionRequiredKeys) {
    assert.ok(
      semanticPolicy.required_exception_fields.includes(field),
      `semantic drift policy must require exception field ${field}`,
    );
  }

  for (const exception of table.exceptions ?? []) {
    assertOnlyKeys(exception, exceptionAllowedKeys, `exception ${exception.provider}/${exception.policy_area}`);
    for (const required of exceptionRequiredKeys) {
      assert.ok(
        Object.hasOwn(exception, required),
        `exception ${exception.provider}/${exception.policy_area} missing ${required}`,
      );
    }
    assert.ok(providers.has(exception.provider), `exception provider ${exception.provider} must be in provider list`);
    assert.ok(policyNames.has(exception.policy_area), `exception policy area ${exception.policy_area} must be in policy areas`);
    assert.equal(typeof exception.clear_reason, "string", `exception ${exception.policy_area} must include clear_reason`);
    assert.match(exception.shared_policy_boundary, /shared|adapter|route|policy|capability/i);
    assert.equal(Array.isArray(exception.evidence), true, `exception ${exception.policy_area} must include evidence`);
    assert.equal(exception.evidence.length > 0, true, `exception ${exception.policy_area} evidence must not be empty`);
    assert.equal(Array.isArray(exception.tests), true, `exception ${exception.policy_area} tests must be an array`);
    assert.equal(exception.tests.length > 0, true, `exception ${exception.policy_area} tests must not be empty`);
    for (const testPath of exception.tests) {
      assertRepoPathExists(testPath, `exception ${exception.provider}/${exception.policy_area} test`);
    }
    assert.ok(
      exception.follow_up_issue === null || Number.isInteger(exception.follow_up_issue),
      `exception ${exception.policy_area} must make follow-up issue state explicit`,
    );
    if (exception.verdict === "intentional") {
      assert.ok(
        allowedIntentionalTypes.has(exception.difference_type),
        `intentional exception ${exception.provider}/${exception.policy_area} must use an allowed difference type`,
      );
      if (exception.difference_type === "adapter_capability_fact") {
        assert.equal(typeof exception.capability_fact, "string");
        assert.notEqual(exception.capability_fact.trim(), "");
      }
      assert.doesNotMatch(exception.tests.join("\n"), /^missing\b/i);
    } else {
      assert.ok(
        trackedNoncomplianceTypes.has(exception.difference_type),
        `non-intentional exception ${exception.provider}/${exception.policy_area} must be tracked as drift or research gap`,
      );
      assert.ok(
        Number.isInteger(exception.follow_up_issue),
        `non-intentional exception ${exception.provider}/${exception.policy_area} must name a follow-up issue`,
      );
    }
  }

  const semanticGuardrail = table.guardrail_tests.find((entry) => entry.name === "provider semantic drift classification");
  assert.ok(semanticGuardrail, "provider parity table must define semantic drift classification guardrail");
  assert.deepEqual(
    [...semanticGuardrail.required_fields].sort(),
    [...semanticPolicy.required_exception_fields].sort(),
  );
  const grokAuto = table.exceptions.find(
    (entry) => entry.provider === "grok" && entry.policy_area === "fallback semantics",
  );
  assert.ok(grokAuto, "Grok auto transport capability must be documented as an exception");
  assert.equal(grokAuto.verdict, "intentional");
  assert.equal(grokAuto.difference_type, "adapter_capability_fact");
  assert.match(grokAuto.capability_fact, /two subscription-backed transports/i);
  assert.match(grokAuto.shared_policy_boundary, /subscription/i);
  const claudeAuth = table.exceptions.find(
    (entry) => entry.provider === "claude" && entry.policy_area === "route/auth/source-send approval",
  );
  assert.ok(claudeAuth, "Claude auth command capability must be documented as an exception");
  assert.equal(claudeAuth.verdict, "intentional");
  assert.equal(claudeAuth.difference_type, "adapter_capability_fact");
  assert.match(claudeAuth.capability_fact, /claude auth login/i);
  assert.match(claudeAuth.current_behavior, /oauth_inference_rejected/i);
});




test("packet-recovery schema keeps the no-source resume capability guard", () => {
  const schema = readRepoJson("docs/contracts/packet-recovery.schema.json");

  assert.equal(schema.title, "PacketRecovery");
  assert.ok(schema.required.includes("provider_capabilities"));
  assert.ok(schema.required.includes("review_surface"));
  assert.ok(schema.required.includes("actions"));
  assert.deepEqual(
    schema.$defs.providerRecoveryCapabilities.required,
    [
      "provider",
      "canonical_provider",
      "route_step",
      "source_packet_budget_bytes",
      "rendered_prompt_budget_chars",
      "per_file_secure_read_cap_bytes",
      "supports_diff_packet",
      "supports_shard_plan",
      "supports_no_source_resume",
      "requires_source_send_approval",
      "requires_resend_confirmation_after_source_sent_failure",
      "local_source_packet_policy_pre_send",
      "source_sent_runtime_failures_failed_slot",
      "transport_fallbacks",
    ],
  );
  assert.equal(
    schema.$defs.providerRecoveryCapabilities.properties.local_source_packet_policy_pre_send.type,
    "boolean",
  );
  assert.equal(
    schema.$defs.providerRecoveryCapabilities.properties.source_sent_runtime_failures_failed_slot.type,
    "boolean",
  );

  const noSourceResumeGuard = schema.allOf.find((entry) => (
    entry?.if?.properties?.provider_capabilities?.properties?.supports_no_source_resume?.const === false
  ));
  assert.ok(noSourceResumeGuard, "schema must guard supports_no_source_resume:false");
  assert.equal(
    noSourceResumeGuard.then.properties.actions.not.contains.properties.type.const,
    "resume_without_source_resend",
  );
  assert.ok(
    schema.$defs.recoveryAction.properties.type.enum.includes("resume_without_source_resend"),
    "resume_without_source_resend remains valid only when provider capabilities allow it",
  );
  assert.ok(
    schema.properties.reason.enum.includes("resend_confirmation_required"),
    "schema must allow resend-confirmation recovery reasons emitted by runtime policy",
  );
  assert.ok(
    schema.properties.reason.enum.includes("stale_active_job"),
    "schema must allow reconciled stale-job recovery reasons emitted by runtime policy",
  );
  assert.ok(
    schema.properties.reason.enum.includes("provider_unavailable"),
    "schema must allow source-bearing provider-unavailable recovery reasons emitted by direct API runtime policy",
  );
  assert.ok(
    schema.properties.source_content_transmission.enum.includes("unknown"),
    "schema must allow stale-job recovery when source transmission is conservative unknown",
  );
});

test("packet-recovery schema matches runtime shard approval tuple shape", () => {
  const schema = readRepoJson("docs/contracts/packet-recovery.schema.json");
  const tuple = schema.$defs.approvalTuple;

  assert.deepEqual(
    tuple.required,
    [
      "provider",
      "mode",
      "rendered_prompt_hash",
      "source_packet",
      "scope_resolution",
      "scope_paths",
      "request_settings",
      "auth_path",
      "billing_path",
      "selected_route",
      "route_step",
      "route_steps",
      "fallback_reason",
      "approval_scope",
      "approval_tuple_fingerprint",
    ],
  );
  assert.equal(tuple.properties.rendered_prompt_hash.$ref, "#/$defs/hexSha256");
  assert.equal(schema.$defs.hexSha256.type, "string");
  assert.equal(schema.$defs.hexSha256.pattern, "^[a-f0-9]{64}$");
  assert.ok(tuple.properties.source_packet, "runtime shard tuples carry the selected source packet summary");
  assert.ok(tuple.properties.scope_resolution, "runtime shard tuples carry scope resolution details");
  assert.ok(tuple.properties.scope_paths, "runtime shard tuples carry explicit scope paths");
  assert.ok(tuple.properties.request_settings, "runtime shard tuples carry request settings");
  assert.ok(tuple.properties.route_step, "runtime shard tuples carry the selected route step");
  assert.ok(tuple.properties.route_steps, "runtime shard tuples carry route-step audit details");
  assert.equal(
    tuple.properties.approval_tuple_fingerprint.$ref,
    "#/$defs/approvalTupleFingerprint",
    "runtime shard tuples carry the structured non-token fingerprint emitted by sourceSendApprovalTupleFingerprint",
  );
  assert.deepEqual(schema.$defs.approvalTupleFingerprint.required, ["algorithm", "value", "ingredients"]);
  assert.equal(schema.$defs.approvalTupleFingerprint.properties.algorithm.const, "sha256");
  assert.equal(schema.$defs.approvalTupleFingerprint.properties.value.$ref, "#/$defs/sha256");
  assert.ok(
    schema.$defs.approvalTupleFingerprint.properties.ingredients.properties.auth_path.anyOf
      .some((entry) => entry.$ref === "#/$defs/safeText"),
    "fingerprint ingredients must allow string auth paths accepted by sourceSendApprovalTupleFingerprint",
  );
  assert.equal(
    schema.$defs.sourcePacketSummary.required.includes("packet_hash"),
    false,
    "runtime selected_source summaries do not include a packet_hash field",
  );
});

test("packet-recovery schema allows runtime retry fail-closed reasons", () => {
  const schema = readRepoJson("docs/contracts/packet-recovery.schema.json");
  for (const reason of [
    "review_slot_waiver_artifact_required",
    "review_slot_override_artifact_required",
    "retry_disposition_not_valid_for_third_attempt",
    "third_same_packet_retry_requires_disposition",
    "review_slot_disposition_required",
  ]) {
    assert.ok(schema.properties.reason.enum.includes(reason), `schema must allow runtime retry guard reason ${reason}`);
  }
});

test("session-approval-grant schema is strict and token-free", () => {
  const schema = readRepoJson("docs/contracts/session-approval-grant.schema.json");
  const policy = readRepoJson("plugins/relay-deepseek/config/session-approval.json");

  assert.deepEqual(Object.keys(policy), ["schema_version", "max_ttl_ms"]);
  assert.equal(policy.schema_version, 1);
  assert.equal(Number.isSafeInteger(policy.max_ttl_ms), true);
  assert.equal(policy.max_ttl_ms > 0, true);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schema_version",
    "grant_id",
    "created_at",
    "expires_at",
    "grant_session_id",
    "provider_allowlist",
    "mode_allowlist",
    "workspace_root_hash",
    "path_constraints",
    "max_files",
    "max_bytes",
    "max_ttl_ms",
    "approval_fingerprint",
    "approval_tuple",
    "activation",
  ]);
  assert.equal(schema.properties.approval_token, undefined);
  assert.equal(schema.properties.grant_approval_token, undefined);
  assert.equal(schema.properties.approval_tuple.additionalProperties, false);
  assert.equal(schema.$defs.grant_bounds.additionalProperties, false);
  assert.equal(schema.properties.max_ttl_ms.maximum, undefined);
  assert.equal(schema.$defs.grant_bounds.properties.max_ttl_ms.maximum, undefined);
  assert.match(schema.properties.approval_fingerprint.description, /canonicalJson/);
});

test("session-approval-grant schema accepts runtime persisted record shape", () => {
  const schema = readRepoJson("docs/contracts/session-approval-grant.schema.json");

  assertSchemaAllowsValue(schema, schema, sampleSessionApprovalGrantRecord(), "$");
});
