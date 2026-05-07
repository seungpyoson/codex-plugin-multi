#!/usr/bin/env node
// scripts/smoke-rerecord.mjs
//
// Records a real provider response and writes a sanitized fixture pair
// (<scenario>.response.json + <scenario>.provenance.json) under
// tests/smoke/fixtures/<plugin>/.
//
// Usage:
//   node scripts/smoke-rerecord.mjs --plugin <p> --scenario <s>
//
// Available <plugin>/<scenario> combinations are listed by:
//   node scripts/smoke-rerecord.mjs --list
//
// Required env per plugin (the script aborts loudly if missing):
//   claude:        existing ~/.claude OAuth OR ANTHROPIC_API_KEY
//   gemini:        existing gemini CLI auth OR GEMINI_API_KEY
//   kimi:          existing kimi CLI auth OR KIMI_CODE_API_KEY/KIMI_API_KEY/MOONSHOT_API_KEY
//   grok:          local grok2api tunnel running on http://127.0.0.1:8000/v1 with valid session
//   api-reviewers-deepseek:  DEEPSEEK_API_KEY
//   api-reviewers-glm:       ZAI_API_KEY or ZAI_GLM_API_KEY
//
// Companion auth: claude/happy-path-review uses --auth-mode auto, which
// selects api_key_env when ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is set
// in the environment, and falls back to subscription_oauth otherwise.
// On a CI runner with the secret wired, recordings use API-key auth;
// on a developer machine without those vars, OAuth is used. Setting
// either *_API_KEY env var on a developer machine that also has
// ~/.claude OAuth will silently switch the recording to API-key auth.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildProvenance,
  sanitize,
} from "./lib/fixture-sanitization.mjs";
import { checkAuthOrFile } from "./lib/smoke-rerecord-preflight.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tests/smoke/fixtures");

// Stable minimal prompt used across all happy-path recipes. Keeping the
// prompt fixed across recordings makes prompt_hash useful as a comparator.
const HAPPY_PATH_PROMPT =
  "Custom review: read scripts/lib/plugin-targets.mjs and reply only with the verdict 'PASS' on its own line. No other commentary.";

const NEGATIVE_PROMPT =
  "This prompt should not be sent because credentials are missing.";

export const RECIPES = Object.freeze({
  // ─── companion ──────────────────────────────────────────────────────
  "claude/happy-path-review": {
    architecture: "companion",
    plugin: "claude",
    spawnArgs: () => ({
      script: "plugins/claude/scripts/claude-companion.mjs",
      args: [
        "run",
        "--mode=custom-review",
        "--foreground",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        // Without --auth-mode auto, the run subcommand defaults to
        // subscription, which sets allowed_env_credentials=[] and
        // strips API keys via sanitizeTargetEnv before exec — making
        // envAny preflight a decoy on env-only CI runners. Auto mode
        // selects api_key_env when a provider key is present and
        // falls back to subscription_oauth otherwise, exactly mirroring
        // the recipe's "OAuth OR API key" semantics.
        "--auth-mode", "auto",
        "--", HAPPY_PATH_PROMPT,
      ],
      env: { ...process.env },
      // Either an existing claude-cli OAuth dir at ~/.claude OR a wired
      // ANTHROPIC_API_KEY / CLAUDE_API_KEY env var is sufficient. The
      // workflow (smoke-rerecord.yml) wires both secrets so a fresh CI
      // runner without ~/.claude can still record. (Greptile P1
      // #3199437297 — file-only check rejected secret-only runners.)
      requireEnvOrFile: {
        envAny: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
        file: path.join(process.env.HOME ?? "", ".claude"),
      },
      // Refuse to write a fixture if the spawned claude exits non-zero.
      // A happy-path recording that auth-fails or hits a transient 5xx
      // would otherwise parse the error JSON and commit it as if it
      // were a real review (silent fixture corruption).
      expectExit: [0],
    }),
  },
  "claude/auth-failure": {
    architecture: "companion",
    plugin: "claude",
    spawnArgs: () => ({
      script: "plugins/claude/scripts/claude-companion.mjs",
      args: ["ping", "--auth-mode", "api_key"],
      // Force explicit API-key mode with keys scrubbed so local OAuth
      // state cannot turn this negative recipe into a successful doctor
      // response. Also override HOME to a sterile path: claude-cli reads
      // OAuth tokens / project config from ~ (~/.claude/), and just
      // scrubbing the env vars leaves on-disk state intact. Pointing
      // HOME at /var/empty (always exists, always empty on macOS/Linux)
      // ensures any home-directory lookup misses. (Gemini #3198727893.)
      env: {
        ...scrubAuth(process.env, ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDE_CONFIG_DIR"]),
        HOME: "/var/empty",
      },
    }),
  },

  // ─── grok ───────────────────────────────────────────────────────────
  "grok/happy-path-review": {
    architecture: "grok",
    plugin: "grok",
    spawnArgs: () => ({
      script: "plugins/grok/scripts/grok-web-reviewer.mjs",
      args: [
        "run",
        "--mode=custom-review",
        "--scope=custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--foreground",
        "--prompt", HAPPY_PATH_PROMPT,
      ],
      env: { ...process.env },
      requireTunnel: { url: process.env.GROK_WEB_BASE_URL ?? "http://127.0.0.1:8000/v1" },
    }),
  },
  "grok/tunnel-error": {
    architecture: "grok",
    plugin: "grok",
    spawnArgs: () => ({
      script: "plugins/grok/scripts/grok-web-reviewer.mjs",
      args: [
        "run",
        "--mode=custom-review",
        "--scope=custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--foreground",
        "--prompt", NEGATIVE_PROMPT,
      ],
      // Force tunnel-unavailable by pointing at a port nothing listens on.
      env: { ...process.env, GROK_WEB_BASE_URL: "http://127.0.0.1:1/v1" },
    }),
  },

  // ─── api-reviewers ──────────────────────────────────────────────────
  "api-reviewers-deepseek/happy-path-review": {
    architecture: "api-reviewers",
    plugin: "api-reviewers-deepseek",
    spawnArgs: () => ({
      script: "plugins/api-reviewers/scripts/api-reviewer.mjs",
      args: [
        "run",
        "--provider", "deepseek",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--prompt", HAPPY_PATH_PROMPT,
      ],
      env: { ...process.env },
      requireEnvAny: ["DEEPSEEK_API_KEY"],
      curatedEnvKeys: ["DEEPSEEK_API_KEY"],
    }),
  },
  "api-reviewers-deepseek/auth-rejected": {
    architecture: "api-reviewers",
    plugin: "api-reviewers-deepseek",
    spawnArgs: () => ({
      script: "plugins/api-reviewers/scripts/api-reviewer.mjs",
      args: [
        "run",
        "--provider", "deepseek",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--prompt", NEGATIVE_PROMPT,
      ],
      // Inject a known-bad key — provider returns 401/403 → auth_rejected.
      env: { ...process.env, DEEPSEEK_API_KEY: "sk-this-is-a-deliberately-invalid-key-for-fixture-recording" },
      curatedEnvKeys: ["DEEPSEEK_API_KEY"],
    }),
  },
  "api-reviewers-glm/happy-path-review": {
    architecture: "api-reviewers",
    plugin: "api-reviewers-glm",
    spawnArgs: () => ({
      script: "plugins/api-reviewers/scripts/api-reviewer.mjs",
      args: [
        "run",
        "--provider", "glm",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--prompt", HAPPY_PATH_PROMPT,
      ],
      env: { ...process.env },
      requireEnvAny: ["ZAI_API_KEY", "ZAI_GLM_API_KEY"],
      curatedEnvKeys: ["ZAI_API_KEY", "ZAI_GLM_API_KEY"],
    }),
  },
  "api-reviewers-glm/auth-rejected": {
    architecture: "api-reviewers",
    plugin: "api-reviewers-glm",
    spawnArgs: () => ({
      script: "plugins/api-reviewers/scripts/api-reviewer.mjs",
      args: [
        "run",
        "--provider", "glm",
        "--mode", "custom-review",
        "--scope", "custom",
        "--scope-paths", "scripts/lib/plugin-targets.mjs",
        "--prompt", NEGATIVE_PROMPT,
      ],
      // Inject a known-bad key — provider returns 401/403 → auth_rejected.
      env: { ...process.env, ZAI_API_KEY: "sk-this-is-a-deliberately-invalid-key-for-fixture-recording" },
      curatedEnvKeys: ["ZAI_API_KEY", "ZAI_GLM_API_KEY"],
    }),
  },
});

function scrubAuth(env, keys) {
  const out = { ...env };
  for (const key of keys) delete out[key];
  return out;
}

function parseArgs(argv) {
  const out = { plugin: null, scenario: null, list: false, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") { out.list = true; continue; }
    if (arg === "--dry-run") { out.dry = true; continue; }
    if (arg === "--plugin") { out.plugin = argv[++i]; continue; }
    if (arg === "--scenario") { out.scenario = argv[++i]; continue; }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    }
    process.stderr.write(`smoke-rerecord: unknown arg: ${arg}\n`);
    printHelpAndExit(2);
  }
  return out;
}

function printHelpAndExit(code) {
  process.stdout.write([
    "Usage: node scripts/smoke-rerecord.mjs --plugin <name> --scenario <name>",
    "       node scripts/smoke-rerecord.mjs --list",
    "       node scripts/smoke-rerecord.mjs --plugin <name> --scenario <name> --dry-run",
    "",
    "Records and sanitizes a real provider response into",
    "tests/smoke/fixtures/<plugin>/<scenario>.{response,provenance}.json.",
    "",
  ].join("\n"));
  process.exit(code);
}

function listRecipes() {
  process.stdout.write("Available recipes:\n");
  for (const key of Object.keys(RECIPES)) {
    const [plugin, scenario] = key.split("/");
    process.stdout.write(`  --plugin ${plugin} --scenario ${scenario}\n`);
  }
}

function preflightCheck(spec) {
  if (spec.requireEnvAny) {
    const found = spec.requireEnvAny.find((key) => process.env[key]);
    if (!found) {
      process.stderr.write(
        `smoke-rerecord: required env not set. One of: ${spec.requireEnvAny.join(", ")}\n`,
      );
      process.exit(2);
    }
  }
  if (spec.requireEnvOrFile) {
    const result = checkAuthOrFile(spec.requireEnvOrFile);
    if (!result.ok) {
      process.stderr.write(
        `smoke-rerecord: ${result.reason}. Sign in to the CLI first or set the relevant *_API_KEY env var.\n`,
      );
      process.exit(2);
    }
  }
  // requireTunnel is informational — the actual reachability check happens
  // when the spawned plugin issues its HTTP request.
}

function recordResponse(scriptPath, args, env) {
  const fullScript = path.join(REPO_ROOT, scriptPath);
  if (!existsSync(fullScript)) {
    process.stderr.write(`smoke-rerecord: script not found: ${fullScript}\n`);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [fullScript, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    process.stderr.write(`smoke-rerecord: spawn error: ${result.error.message}\n`);
    process.exit(2);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
    signal: result.signal,
  };
}

function tryParseJson(stdout) {
  // The plugin entry points emit JSON either as a single object or as
  // JSONL with a final terminal record. Take the LAST JSON object on a
  // line by itself; fall back to the whole stdout.
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch { /* try next */ }
  }
  // Fallback: whole stdout
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function writeFixture(plugin, scenario, sanitizedRecord, provenance) {
  const dir = path.join(FIXTURE_ROOT, plugin);
  mkdirSync(dir, { recursive: true });
  const responsePath = path.join(dir, `${scenario}.response.json`);
  const provenancePath = path.join(dir, `${scenario}.provenance.json`);
  writeFileSync(responsePath, `${JSON.stringify(sanitizedRecord, null, 2)}\n`, "utf8");
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${path.relative(REPO_ROOT, responsePath)}\n`);
  process.stdout.write(`Wrote ${path.relative(REPO_ROOT, provenancePath)}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) printHelpAndExit(2);
  const { plugin, scenario, list, dry } = parseArgs(argv);

  if (list) {
    listRecipes();
    return;
  }
  if (!plugin || !scenario) {
    process.stderr.write("smoke-rerecord: --plugin and --scenario are required\n");
    printHelpAndExit(2);
  }

  const key = `${plugin}/${scenario}`;
  const recipe = RECIPES[key];
  if (!recipe) {
    process.stderr.write(`smoke-rerecord: unknown recipe: ${key}\n`);
    process.stderr.write("Run with --list for available recipes.\n");
    process.exit(2);
  }

  const spec = recipe.spawnArgs();
  preflightCheck(spec);

  if (dry) {
    process.stdout.write(`DRY RUN: would spawn ${spec.script} with args:\n`);
    process.stdout.write(`  ${spec.args.join(" ")}\n`);
    process.stdout.write("Env keys passed (values redacted):\n");
    for (const k of Object.keys(spec.env)) {
      process.stdout.write(`  ${k}\n`);
    }
    return;
  }

  process.stderr.write(`Recording ${key}...\n`);
  const result = recordResponse(spec.script, spec.args, spec.env);

  process.stderr.write(`Exit code: ${result.exitCode}\n`);
  if (result.signal) process.stderr.write(`Signal: ${result.signal}\n`);

  // Exit-code gate: a recipe may declare `expectExit: number[]` to refuse
  // fixture writes when the spawned plugin's status doesn't match. Without
  // this, a happy-path recording that auth-fails (or hits a transient 5xx)
  // would parse the error JSON and write it as if it were a real review —
  // silent fixture corruption. Recipes that omit expectExit accept any
  // exit code (preserving the prior behavior for negative recipes whose
  // exit codes haven't been characterized yet).
  if (Array.isArray(spec.expectExit) && !spec.expectExit.includes(result.exitCode)) {
    process.stderr.write(
      `smoke-rerecord: child exit ${result.exitCode} not in expectExit ${JSON.stringify(spec.expectExit)} - refusing to write fixture.\n`,
    );
    process.stderr.write("First 500 chars of stdout:\n");
    process.stderr.write(`${result.stdout.slice(0, 500)}\n`);
    process.stderr.write("stderr (first 500 chars):\n");
    process.stderr.write(`${result.stderr.slice(0, 500)}\n`);
    process.exit(4);
  }

  const parsed = tryParseJson(result.stdout);
  if (!parsed) {
    process.stderr.write("smoke-rerecord: could not parse stdout as JSON.\n");
    process.stderr.write("First 500 chars of stdout:\n");
    process.stderr.write(result.stdout.slice(0, 500));
    process.stderr.write("\nstderr (first 500 chars):\n");
    process.stderr.write(result.stderr.slice(0, 500));
    process.stderr.write("\n");
    process.exit(3);
  }

  // Build sanitization context.
  //
  // Prompt-for-hash detection. Layered: (1) explicit `--prompt <value>`
  // anchor; (2) trailing positional after `--` separator; (3) last
  // non-flag positional arg; (4) length>50 fallback for legacy. The
  // length-only heuristic was fragile per Gemini code-review (#116
  // bot comments 3198445563 / 3198672662 / 3198727895) — `--scope-paths`
  // values and other long file paths could be misidentified as prompts.
  const promptForHash = (() => {
    const args = spec.args ?? [];
    const promptIdx = args.indexOf("--prompt");
    if (promptIdx !== -1 && args[promptIdx + 1]) return args[promptIdx + 1];
    const ddIdx = args.indexOf("--");
    if (ddIdx !== -1 && args[ddIdx + 1]) return args[ddIdx + 1];
    if (args.length > 0) {
      const last = args[args.length - 1];
      if (typeof last === "string" && !last.startsWith("-")) return last;
    }
    return args.find((arg) => typeof arg === "string" && arg.length > 50) ?? "";
  })();
  const promptHash = createHash("sha256").update(promptForHash).digest("hex");

  const sanitizationOptions = {
    architecture: recipe.architecture,
    env: spec.env,
    curatedEnvKeys: spec.curatedEnvKeys ?? [],
  };
  const sanitized = sanitize(parsed, sanitizationOptions);

  // Determine a reasonable model_id from the sanitized record (best-effort).
  const modelId = sanitized?.model
    ?? sanitized?.raw_model
    ?? sanitized?.target
    ?? recipe.plugin;

  const provenance = buildProvenance({
    modelId,
    promptHash,
    sanitizationNotes: [
      "redacted per scripts/lib/fixture-sanitization.mjs:",
      "- env-secret values for keys matching auto-detected pattern (>=8 chars)",
      `- curated env_keys: ${(spec.curatedEnvKeys ?? []).join(",") || "(none)"}`,
      "- public-prefix tokens (sk-, AKIA, AIza, ghp_, eyJ-, ...)",
      "- Authorization headers and Bearer tokens",
      "- macOS user-home paths (/Users/<user>)",
      recipe.architecture === "companion" ? "- companion session_id fields" : "",
    ].filter(Boolean).join("\n"),
    recordedBy: process.env.SMOKE_RERECORD_RUN_REF ?? "manual: scripts/smoke-rerecord.mjs",
  });

  writeFixture(recipe.plugin, scenario, sanitized, provenance);
  process.stderr.write("OK\n");
}

// Run main() only when invoked as the entry script. Importers (e.g.
// recipe-shape tests) get the module exports without triggering arg
// parsing or process.exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
