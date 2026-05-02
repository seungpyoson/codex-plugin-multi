// Shared git-env scrub. ONE source of truth for every callsite that spawns
// git on behalf of the plugin or the test harness.
//
// Why this exists: prior to #16 follow-up Item 9 there were FIVE independent
// strip lists drifting independently:
//   - claude-companion.mjs / gemini-companion.mjs: 5 keys each
//   - scope.mjs (byte-identical pair): 14 keys + KEY/VALUE pattern
//   - tests/helpers/fixture-git.mjs: 15 keys + KEY/VALUE pattern
//   - scripts/ci/run-tests.mjs: 15 keys + KEY/VALUE pattern
//
// Adversarial review of PR #21 caught GIT_CONFIG_GLOBAL leaks through 4 of
// the 5 callsites (test fixtures got their default branch hijacked into
// "injected-master"; companion git invocations would inherit safe.directory
// from a malicious parent env). Folding everything onto this module makes
// adding a new key a one-place change.
//
// Byte-identical between plugins/claude/scripts/lib/ and
// plugins/gemini/scripts/lib/ — listed in VERBATIM_FILES.

// Comprehensive list of GIT_* env vars whose presence in a parent env can
// silently hijack a git subprocess into reading the wrong repository,
// inheriting wrong configuration, or polluting stdout with trace output.
//
// Categories (loose grouping):
//   1. Location overrides — point git at a different repo entirely.
//   2. Config injection — make git apply unexpected configuration.
//   3. Trace family — pollute stdout/stderr with diagnostic output.
//   4. Behavior overrides — change protocol/lock/prompt semantics.
//
// The KEY_n / VALUE_n indexed config vars (companion to GIT_CONFIG_COUNT)
// are stripped by pattern in cleanGitEnv() since their indices are unbounded.
export const STRIPPED_GIT_ENV_KEYS = Object.freeze([
  // 1. Location overrides
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ATTR_SOURCE",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",

  // 2. Config injection
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",

  // 3. Trace family — could break stdout parsing or leak telemetry
  "GIT_TRACE",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_PACK_ACCESS",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_REFS",
  "GIT_TRACE_CURL",
  "GIT_TRACE_CURL_NO_DATA",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE2_PERF_BRIEF",
  "GIT_TRACE2_BRIEF",

  // 4. Behavior overrides
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "GIT_PROTOCOL",
  "GIT_AUTO_GC",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PAGER_IN_USE",
  "PAGER",
]);

const INDEXED_GIT_CONFIG_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/**
 * Return a clone of `baseEnv` with every entry in STRIPPED_GIT_ENV_KEYS
 * removed and every GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> removed by
 * pattern. Caller may merge their own additions into the result.
 *
 * Defaults to process.env so the common form `cleanGitEnv()` works, but
 * any caller can pass an explicit env object — useful for tests.
 */
export function cleanGitEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const k of STRIPPED_GIT_ENV_KEYS) delete env[k];
  for (const k of Object.keys(env)) {
    if (INDEXED_GIT_CONFIG_RE.test(k)) delete env[k];
  }
  return env;
}
