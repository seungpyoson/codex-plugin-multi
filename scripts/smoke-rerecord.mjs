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
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildProvenance,
  sanitize,
} from "./lib/fixture-sanitization.mjs";
import {
  checkAuthOrFile,
  checkEnvAny,
  renderAuthOrFileHelp,
} from "./lib/smoke-rerecord-preflight.mjs";
import { CLAUDE_PROVIDER_API_KEY_ENV } from "../plugins/claude/scripts/lib/claude-provider-keys.mjs";
import {
  ARCHITECTURE_API_REVIEWERS,
  ARCHITECTURE_COMPANION,
  ARCHITECTURE_GROK,
  ARCHITECTURE_KINDS,
} from "./lib/recipe-architecture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "tests/smoke/fixtures");

// Stable minimal prompt used across all happy-path recipes. Keeping the
// prompt fixed across recordings makes prompt_hash useful as a comparator.
const HAPPY_PATH_PROMPT =
  "Custom review: read scripts/lib/plugin-targets.mjs and reply only with the verdict 'PASS' on its own line. No other commentary.";

const NEGATIVE_PROMPT =
  "This prompt should not be sent because credentials are missing.";

// Provider-key env names declared by api-reviewers recipes. Source of
// truth lives here (no plugin-side counterpart yet); validateRecipes
// asserts every api-reviewers/* recipe declares envAny matching the
// per-provider list below.
const API_REVIEWER_PROVIDER_KEYS = Object.freeze({
  deepseek: Object.freeze(["DEEPSEEK_API_KEY"]),
  glm: Object.freeze(["ZAI_API_KEY", "ZAI_GLM_API_KEY"]),
});

// Auth-rejected recipes inject this sentinel into every accepted
// provider key so the upstream provider returns 401/403 deterministically.
// Exported so tests can assert against the same literal — drift between
// recipe and test would silently turn a negative recipe into a decoy.
export const INVALID_PROVIDER_KEY_SENTINEL =
  "sk-this-is-a-deliberately-invalid-key-for-fixture-recording";

// Build an env-overlay that invalidates every accepted key for `provider`.
// Closing the C1-class drift one more step: the recipe-side override
// previously knew about one key while the plugin accepted multiple
// (#3199-class P1 — glm wiring with ZAI_GLM_API_KEY left intact would
// fall through to happy-path in a negative fixture). Iterating the
// canonical list means adding a new accepted key automatically
// invalidates it in every negative recipe; nothing else needs to change.
//
// Exported so tests/unit/smoke-rerecord-validator.test.mjs can pin the
// helper's behavior directly. The validator-side check (every
// canonical key is the sentinel) co-verifies this through recipe
// shape, but a refactor that changes the helper's signature without
// touching the recipes would slip past the validator while still
// breaking the invariant — direct tests catch that.
export function invalidateProviderKeys(provider) {
  const keys = API_REVIEWER_PROVIDER_KEYS[provider];
  if (!keys) {
    throw new Error(
      `invalidateProviderKeys: unknown provider ${JSON.stringify(provider)}`,
    );
  }
  return Object.fromEntries(keys.map((k) => [k, INVALID_PROVIDER_KEY_SENTINEL]));
}

export const RECIPES = Object.freeze({
  // ─── companion ──────────────────────────────────────────────────────
  "claude/happy-path-review": {
    architecture: ARCHITECTURE_COMPANION,
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
      requireEnvOrFile: {
        envAny: CLAUDE_PROVIDER_API_KEY_ENV,
        file: path.join(process.env.HOME ?? "", ".claude"),
      },
      expectExit: [0],
    }),
  },
  "claude/auth-failure": {
    architecture: ARCHITECTURE_COMPANION,
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
        ...scrubAuth(process.env, [...CLAUDE_PROVIDER_API_KEY_ENV, "CLAUDE_CONFIG_DIR"]),
        HOME: "/var/empty",
      },
      // Characterized by an actual smoke-rerecord workflow run on a
      // sterile GitHub runner: the companion's `ping` path hits the
      // "no provider key, structured pre-spawn auth rejection" branch
      // and exits with code 2 (matching the codebase's standard
      // "structured bad-args / preflight rejection" exit). Round-10's
      // local probe hit a different state (likely a partial ~/.claude
      // on the dev box leaking through) and saw exit 1; that
      // characterization was wrong and is replaced here with the
      // workflow-observed value cited in expectExitObservedRun.
      expectExit: [2],
      expectExitObservedRun: 25489163404,
    }),
  },

  // ─── grok ───────────────────────────────────────────────────────────
  "grok/happy-path-review": {
    architecture: ARCHITECTURE_GROK,
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
      expectExit: [0],
    }),
  },
  "grok/tunnel-error": {
    architecture: ARCHITECTURE_GROK,
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
      // CI-characterized via workflow_dispatch (round-14 follow-up to
      // round-13's class-of-problem fix): all negative recipes must cite
      // the run that observed their exit code, not a local probe.
      expectExit: [1],
      expectExitObservedRun: 25489291490,
    }),
  },

  // ─── api-reviewers ──────────────────────────────────────────────────
  "api-reviewers-deepseek/happy-path-review": {
    architecture: ARCHITECTURE_API_REVIEWERS,
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
      requireEnvAny: API_REVIEWER_PROVIDER_KEYS.deepseek,
      curatedEnvKeys: API_REVIEWER_PROVIDER_KEYS.deepseek,
      expectExit: [0],
    }),
  },
  "api-reviewers-deepseek/auth-rejected": {
    architecture: ARCHITECTURE_API_REVIEWERS,
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
      // Invalidate every accepted provider key so the request reaches the
      // provider and returns 401/403 → auth_rejected. Iterating the
      // canonical list (rather than naming one key) prevents the C1-class
      // drift where adding a new accepted key silently turns this negative
      // recipe into a happy-path decoy.
      env: { ...process.env, ...invalidateProviderKeys("deepseek") },
      curatedEnvKeys: API_REVIEWER_PROVIDER_KEYS.deepseek,
      expectExit: [1],
      expectExitObservedRun: 25489292659,
    }),
  },
});

// Recipe-schema validator. Runs at module load (after RECIPES is
// defined) so any malformed recipe blows up at import, not at recording
// time. This is the round-10 systematic close for the "implicit recipe
// shape" contract — previously, omitting envAny / expectExit / a
// required field went undetected until the first recording hit the gap.
export function validateRecipes(recipes) {
  for (const [key, recipe] of Object.entries(recipes)) {
    const where = `recipe ${JSON.stringify(key)}`;
    if (!recipe || typeof recipe !== "object") {
      throw new TypeError(`${where}: must be an object`);
    }
    if (!ARCHITECTURE_KINDS.includes(recipe.architecture)) {
      throw new TypeError(
        `${where}: architecture ${JSON.stringify(recipe.architecture)} is not in ARCHITECTURE_KINDS (${ARCHITECTURE_KINDS.join(", ")})`,
      );
    }
    if (typeof recipe.plugin !== "string" || recipe.plugin.length === 0) {
      throw new TypeError(`${where}: plugin must be a non-empty string`);
    }
    if (typeof recipe.spawnArgs !== "function") {
      throw new TypeError(`${where}: spawnArgs must be a function`);
    }

    let spec;
    try {
      spec = recipe.spawnArgs();
    } catch (e) {
      throw new Error(`${where}: spawnArgs() threw: ${e.message ?? e}`);
    }
    if (!spec || typeof spec !== "object") {
      throw new TypeError(`${where}: spawnArgs() must return an object`);
    }
    if (typeof spec.script !== "string" || spec.script.length === 0) {
      throw new TypeError(`${where}: spawnArgs().script must be a non-empty string`);
    }
    if (!Array.isArray(spec.args)) {
      throw new TypeError(`${where}: spawnArgs().args must be an array`);
    }
    if (!spec.env || typeof spec.env !== "object") {
      throw new TypeError(`${where}: spawnArgs().env must be an object`);
    }
    if (!Array.isArray(spec.expectExit) || spec.expectExit.length === 0
        || !spec.expectExit.every((n) => Number.isInteger(n))) {
      throw new TypeError(
        `${where}: spawnArgs().expectExit must be a non-empty array of integers (got ${JSON.stringify(spec.expectExit)})`,
      );
    }
    if (spec.requireEnvAny !== undefined && (!Array.isArray(spec.requireEnvAny)
        || !spec.requireEnvAny.every((s) => typeof s === "string" && s.length > 0))) {
      throw new TypeError(`${where}: spawnArgs().requireEnvAny must be a non-empty array of strings if set`);
    }
    if (spec.requireEnvOrFile !== undefined) {
      if (!spec.requireEnvOrFile || typeof spec.requireEnvOrFile !== "object") {
        throw new TypeError(`${where}: spawnArgs().requireEnvOrFile must be an object if set`);
      }
      const eo = spec.requireEnvOrFile.envAny;
      if (eo !== undefined && (!Array.isArray(eo) || !eo.every((s) => typeof s === "string" && s.length > 0))) {
        throw new TypeError(`${where}: spawnArgs().requireEnvOrFile.envAny must be an array of strings if set`);
      }
      const fo = spec.requireEnvOrFile.file;
      if (fo !== undefined && typeof fo !== "string") {
        throw new TypeError(`${where}: spawnArgs().requireEnvOrFile.file must be a string if set`);
      }
    }
    if (spec.curatedEnvKeys !== undefined
        && (!Array.isArray(spec.curatedEnvKeys)
            || !spec.curatedEnvKeys.every((s) => typeof s === "string"))) {
      throw new TypeError(`${where}: spawnArgs().curatedEnvKeys must be an array of strings if set`);
    }

    // Round-14 finding B — auth-rejected naming convention is bound to
    // api-reviewers architecture only. Companion / grok recipes that
    // need to record an auth failure use the *-auth-failure naming
    // (claude/auth-failure is the canonical example). Without this
    // gate, a future companion recipe named "*/auth-rejected" would
    // bypass the invalidate-every-key validator below — which is
    // architecture-keyed — and silently ship a recipe whose negative
    // path could be a happy-path decoy on a wired runner.
    if (key.endsWith("/auth-rejected") && recipe.architecture !== ARCHITECTURE_API_REVIEWERS) {
      throw new TypeError(
        `${where}: only api-reviewers architecture may use the *-auth-rejected naming convention; `
        + `for ${recipe.architecture} architecture, use *-auth-failure instead `
        + `(claude/auth-failure is the canonical example)`,
      );
    }

    // Round-14 finding C — negative recipes (expectExit !== [0]) must
    // cite the workflow_dispatch run that observed their declared exit.
    // Round-13 caught one wrong locally-probed value (claude/auth-failure
    // declared [1], CI observed [2]); the bug pattern is "dev ~/.claude
    // state leaks through scrubAuth despite HOME=/var/empty." The fix
    // is process-level: a contributor either runs the workflow and cites
    // the run ID, or the recipe blows up at module load. Happy-path
    // recipes (expectExit: [0]) do not need this — any wrong value
    // fails the workflow obviously, no silent acceptance risk.
    const isNegativeRecipe = !spec.expectExit.includes(0);
    if (isNegativeRecipe) {
      const obs = spec.expectExitObservedRun;
      if (typeof obs !== "number" || !Number.isInteger(obs) || obs <= 0) {
        throw new TypeError(
          `${where}: negative recipes (expectExit ${JSON.stringify(spec.expectExit)}) must declare `
          + `spawnArgs().expectExitObservedRun as a positive integer (the GitHub Actions run ID that `
          + `observed the declared exit code on a sterile CI runner). Got ${JSON.stringify(obs)}. `
          + `Run smoke-rerecord.yml via workflow_dispatch and cite the run ID.`,
        );
      }
    }

    // Architecture-specific structural checks. Keep narrow — semantic
    // per-recipe checks live in tests/unit/smoke-rerecord-recipes.test.mjs.
    if (recipe.architecture === ARCHITECTURE_API_REVIEWERS) {
      const idx = spec.args.indexOf("--provider");
      if (idx === -1) {
        throw new TypeError(
          `${where}: api-reviewers recipe must include --provider in args`,
        );
      }
      const provider = spec.args[idx + 1];
      if (typeof provider !== "string" || provider.length === 0) {
        throw new TypeError(
          `${where}: --provider must be followed by a non-empty name`,
        );
      }
      const expected = API_REVIEWER_PROVIDER_KEYS[provider];
      if (!expected) {
        throw new TypeError(
          `${where}: --provider ${JSON.stringify(provider)} not in API_REVIEWER_PROVIDER_KEYS (${Object.keys(API_REVIEWER_PROVIDER_KEYS).join(", ")})`,
        );
      }
      // For happy-path recipes, requireEnvAny must match the provider's keys.
      if (key.endsWith("/happy-path-review")) {
        if (!spec.requireEnvAny || spec.requireEnvAny !== expected) {
          throw new TypeError(
            `${where}: happy-path requireEnvAny must reference API_REVIEWER_PROVIDER_KEYS.${provider} (drift = decoy preflight)`,
          );
        }
      }
      // For auth-rejected recipes, every canonical provider key must be
      // sentinelled. A recipe that names only the first key (the round-11
      // pattern) lets a runner with the second key wired record a
      // happy-path response into a negative fixture — the same C1-class
      // drift, in negative-recipe shape. Validator catches it at module
      // load instead of at recording time.
      if (key.endsWith("/auth-rejected")) {
        for (const k of expected) {
          if (spec.env[k] !== INVALID_PROVIDER_KEY_SENTINEL) {
            // Diagnostic intentionally omits the actual value — even in a
            // throw-path, a recipe-validator error must not serialize an
            // env value (Rule 10: no credential surfaces). The key name
            // and the expectation are enough to localize the fix.
            throw new TypeError(
              `${where}: auth-rejected must invalidate every key in API_REVIEWER_PROVIDER_KEYS.${provider}; `
              + `spec.env[${JSON.stringify(k)}] is not the sentinel (use invalidateProviderKeys(${JSON.stringify(provider)}))`,
            );
          }
        }
      }
    }
  }
}

validateRecipes(RECIPES);

function scrubAuth(env, keys) {
  const out = { ...env };
  for (const key of keys) delete out[key];
  return out;
}

// Derive the prompt string used to compute the provenance promptHash.
//
// Earlier rounds layered four detectors (explicit `--prompt`,
// `--` separator, last non-flag positional, length>50 fallback). The
// last two were fragile: a flag VALUE that didn't start with `-`
// (e.g. `--auth-mode api_key` → `api_key`) was misclassified as a
// positional prompt by layer 3, and a long path arg slipped through
// layer 4. Both produced wrong promptHash values silently.
//
// Round-16 root fix: use ONLY explicit anchors. If neither
// `--prompt <value>` nor `-- <value>` is present, the recipe has no
// prompt and we hash the empty string. Honest "no prompt detected"
// beats a wrong heuristic.
//
// Live recipes audit at round-16 commit time:
//   - claude/happy-path-review     uses `-- HAPPY_PATH_PROMPT` ✓
//   - claude/auth-failure          no prompt anchor → "" (correct,
//                                   it's a `ping` doctor call)
//   - grok/*                       use `--prompt …` ✓
//   - api-reviewers-*/             use `--prompt …` ✓
// Only claude/auth-failure changes (was incorrectly hashing "api_key").
export function derivePromptForHash(args) {
  if (!Array.isArray(args)) return "";
  const promptIdx = args.indexOf("--prompt");
  if (promptIdx !== -1 && typeof args[promptIdx + 1] === "string") {
    return args[promptIdx + 1];
  }
  const ddIdx = args.indexOf("--");
  if (ddIdx !== -1 && typeof args[ddIdx + 1] === "string") {
    return args[ddIdx + 1];
  }
  return "";
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

export function preflightCheck(spec) {
  // Both branches consult spec.env (the env that recordResponse will
  // pass to the spawn), not process.env. Recipes that mutate env in
  // spawnArgs() (e.g. claude/auth-failure scrubs auth) need preflight
  // to validate against the post-mutation environment.
  if (spec.requireEnvAny) {
    const r = checkEnvAny({ envAny: spec.requireEnvAny }, { env: spec.env });
    if (!r.ok) {
      process.stderr.write(`smoke-rerecord: ${r.reason}\n`);
      process.stderr.write(`  Set ${spec.requireEnvAny.join(" or ")} in env.\n`);
      process.exit(2);
    }
  }
  if (spec.requireEnvOrFile) {
    const r = checkAuthOrFile(spec.requireEnvOrFile, {
      env: spec.env,
      fileExists: existsSync,
    });
    if (!r.ok) {
      process.stderr.write(`smoke-rerecord: ${r.reason}\n`);
      process.stderr.write(`  ${renderAuthOrFileHelp(r.missing)}\n`);
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

  // Exit-code gate. Every recipe declares expectExit (validateRecipes
  // enforces this at module load), so a recording that doesn't match
  // the recipe's intent is refused before any fixture is written.
  if (!spec.expectExit.includes(result.exitCode)) {
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
  const promptForHash = derivePromptForHash(spec.args);
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
      recipe.architecture === ARCHITECTURE_COMPANION ? "- companion session_id fields" : "",
    ].filter(Boolean).join("\n"),
    recordedBy: process.env.SMOKE_RERECORD_RUN_REF ?? "manual: scripts/smoke-rerecord.mjs",
  });

  writeFixture(recipe.plugin, scenario, sanitized, provenance);
  process.stderr.write("OK\n");
}

// Predicate for "this module is being invoked as the entry script".
// Exported so the wiring can be unit-tested with synthetic argv values
// (relative paths, symlinks, mismatching paths) — empirical proof of
// the npm/npx-shim guard rather than code-reading.
//
// Robust against:
//   - relative argv[1] (`node scripts/smoke-rerecord.mjs ...` from repo
//     root passes a relative path; pathToFileURL needs absolute)
//   - symlinks (npm/npx shims, /var/symlinks/, etc.) via realpathSync
export function isEntryScript(scriptUrl, argv1) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  let resolved;
  try {
    resolved = realpathSync(path.resolve(argv1));
  } catch {
    resolved = path.resolve(argv1);
  }
  return scriptUrl === pathToFileURL(resolved).href;
}

if (isEntryScript(import.meta.url, process.argv[1])) {
  main();
}
