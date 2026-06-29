#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const MARKETPLACE = "relay-for-codex";
const MARKETPLACE_REPOSITORY = "relay-org/relay";
const CACHE_NAMESPACE = MARKETPLACE;
const INTERNAL_RUNTIME_PLUGINS = new Set(["api-reviewers"]);
const PLUGIN_DEPENDENCIES = new Map([
  ["relay-deepseek", ["api-reviewers"]],
  ["relay-glm", ["api-reviewers"]],
]);
const FALLBACK_SOURCE_PATHS = new Map([
  ["relay-claude", "plugins/claude"],
  ["relay-gemini", "plugins/gemini"],
  ["relay-kimi", "plugins/kimi"],
  ["relay-agy", "plugins/agy"],
  ["relay-grok", "plugins/grok"],
  ["relay-glm", "plugins/relay-glm"],
  ["relay-deepseek", "plugins/relay-deepseek"],
  ["api-reviewers", "plugins/api-reviewers"],
]);
const FALLBACK_DEFAULT_PLUGINS = [
  "relay-claude",
  "relay-kimi",
  "relay-agy",
  "relay-grok",
  "relay-glm",
  "relay-deepseek",
  "api-reviewers",
];

function usage() {
  return `Usage: codex-plugin-cache-doctor [options]

Options:
  --repo <path>                Repository root to compare against
  --codex-home <path>          Primary Codex home, defaults to CODEX_HOME or ~/.codex
  --second-codex-home <path>   Optional second Codex home to inspect
  --plugin <name>              Plugin to inspect; repeatable
  -h, --help                   Print this help text
`;
}

function comparePathStrings(a, b) {
  return a.localeCompare(b);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const out = Object.create(null);
  out.plugins = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      out.help = true;
    } else if (token === "--plugin") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--plugin requires a value");
      out.plugins.push(value);
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[++i];
      if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`unsupported option ${token}`);
      }
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      out[key] = value;
    }
  }
  return out;
}

function listSkills(root, plugin) {
  const dir = join(root, plugin, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort(comparePathStrings);
}

function normalizeSourcePath(sourcePath) {
  let normalized = sourcePath.replaceAll("\\", "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized || ".";
}

function fallbackSourcePath(plugin) {
  return FALLBACK_SOURCE_PATHS.get(plugin) ?? join("plugins", plugin);
}

function marketplaceManifestPath(root) {
  return join(root, ".agents", "plugins", "marketplace.json");
}

function readMarketplaceEntries(root) {
  const file = marketplaceManifestPath(root);
  const entries = new Map();
  if (!existsSync(file)) return entries;

  const marketplace = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(marketplace.plugins)) return entries;
  for (const plugin of marketplace.plugins) {
    if (typeof plugin?.name !== "string") continue;
    const sourcePath = typeof plugin.source?.path === "string" ? plugin.source.path : fallbackSourcePath(plugin.name);
    entries.set(plugin.name, {
      sourcePath: normalizeSourcePath(sourcePath),
      version: typeof plugin.version === "string" && plugin.version.length > 0 ? plugin.version : null,
      installation: typeof plugin.policy?.installation === "string" ? plugin.policy.installation : null,
    });
  }
  return entries;
}

function sourcePathsFromMarketplaceEntries(entries) {
  return new Map(Array.from(entries, ([plugin, entry]) => [plugin, entry.sourcePath]));
}

function pluginSourcePath(paths, plugin, fallbackPaths = new Map()) {
  return paths.get(plugin) ?? fallbackPaths.get(plugin) ?? fallbackSourcePath(plugin);
}

function comparablePluginFile(rel) {
  if (rel === "package.json" || rel === ".codex-plugin/plugin.json") return true;
  return rel.startsWith("bin/")
    || rel.startsWith("commands/")
    || rel.startsWith("skills/")
    || rel.startsWith("scripts/")
    || rel.startsWith("config/");
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listComparableFiles(pluginRoot) {
  const files = new Map();
  if (!existsSync(pluginRoot)) return files;
  const stack = [pluginRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => comparePathStrings(a.name, b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(pluginRoot, full);
      if (comparablePluginFile(rel)) files.set(rel, fileHash(full));
    }
  }
  return files;
}

function compareFileHashes(expected, cached) {
  const expectedNames = [...expected.keys()].sort(comparePathStrings);
  const cachedNames = [...cached.keys()].sort(comparePathStrings);
  return {
    expected_files: expectedNames,
    cached_files: cachedNames,
    missing_files: expectedNames.filter((file) => !cached.has(file)),
    extra_files: cachedNames.filter((file) => !expected.has(file)),
    changed_files: expectedNames.filter((file) => cached.has(file) && cached.get(file) !== expected.get(file)),
  };
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === "\"" && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function pluginConfigEntries(home) {
  const config = join(home, "config.toml");
  const entries = new Map();
  if (!existsSync(config)) return entries;
  const text = readFileSync(config, "utf8");
  const escapedMarketplace = escapeRegExp(MARKETPLACE);
  const sectionPattern = new RegExp(`^\\[\\s*plugins\\s*\\.\\s*"([^"\\n]+)@${escapedMarketplace}"\\s*\\]\\s*$`);
  let currentPlugin = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    const section = sectionPattern.exec(line);
    if (section) {
      currentPlugin = section[1];
      if (!entries.has(currentPlugin)) entries.set(currentPlugin, false);
      continue;
    }
    if (/^\[.*\]$/.test(line)) {
      currentPlugin = null;
      continue;
    }
    if (!currentPlugin) continue;
    const enabled = /^enabled\s*=\s*(true|false)\s*$/.exec(line);
    if (enabled) entries.set(currentPlugin, enabled[1] === "true");
  }
  return entries;
}

function expandPluginsWithDependencies(plugins) {
  const seen = new Set();
  const expanded = [];
  function visit(plugin) {
    if (seen.has(plugin)) return;
    seen.add(plugin);
    expanded.push(plugin);
    for (const dependency of PLUGIN_DEPENDENCIES.get(plugin) ?? []) visit(dependency);
  }
  for (const plugin of plugins) visit(plugin);
  return expanded;
}

function enabledPluginNamesFromConfig(home) {
  return Array.from(pluginConfigEntries(home).entries())
    .filter(([, enabled]) => enabled)
    .map(([plugin]) => plugin);
}

function installedCachePluginNames(home) {
  const root = join(home, "plugins", "cache", CACHE_NAMESPACE);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function cacheVersionNames(home, plugin) {
  const root = join(home, "plugins", "cache", CACHE_NAMESPACE, plugin);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(comparePathStrings);
}

function readPluginVersion(pluginRoot) {
  for (const rel of [".codex-plugin/plugin.json", "package.json"]) {
    const file = join(pluginRoot, rel);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      continue;
    }
  }
  return null;
}

function cacheFilesForVersion(home, plugin, version) {
  return listComparableFiles(join(home, "plugins", "cache", CACHE_NAMESPACE, plugin, version));
}

function pluginCacheVersion(home, plugin, sourcePluginRoot, repoPluginRoot, manifestVersion, sourceFiles) {
  const sourceVersion = readPluginVersion(sourcePluginRoot);
  if (sourceVersion) return sourceVersion;
  if (manifestVersion) return manifestVersion;
  const versions = cacheVersionNames(home, plugin);
  const repoVersion = readPluginVersion(repoPluginRoot);
  if (versions.length === 1) return versions[0];
  if (versions.length > 1 && sourceFiles.size > 0) {
    const matchingVersions = versions.filter((version) => {
      const comparison = compareFileHashes(sourceFiles, cacheFilesForVersion(home, plugin, version));
      return comparison.missing_files.length === 0
        && comparison.extra_files.length === 0
        && comparison.changed_files.length === 0;
    });
    if (matchingVersions.length === 1) return matchingVersions[0];
    if (repoVersion && matchingVersions.includes(repoVersion)) return repoVersion;
  }
  if (repoVersion && versions.includes(repoVersion)) return repoVersion;
  if (versions.includes("0.1.0")) return "0.1.0";
  return repoVersion ?? versions[0] ?? "0.1.0";
}

function defaultPluginNames(...nameLists) {
  const names = new Set(FALLBACK_DEFAULT_PLUGINS);
  for (const nameList of nameLists) {
    for (const plugin of nameList ?? []) names.add(plugin);
  }
  return Array.from(names).sort(comparePathStrings);
}

function requiredByEnabledPlugin(configEntries, plugin) {
  for (const [dependent, dependencies] of PLUGIN_DEPENDENCIES.entries()) {
    if (dependencies.includes(plugin) && configEntries.get(dependent) === true) return true;
  }
  return false;
}

function sourceInfoForHome(home, repo, repoSourcePaths) {
  const marketplaceRoot = join(home, ".tmp", "marketplaces", MARKETPLACE);
  const manifestPath = marketplaceManifestPath(marketplaceRoot);
  const marketplacePresent = existsSync(manifestPath);
  const marketplaceEntries = marketplacePresent ? readMarketplaceEntries(marketplaceRoot) : new Map();
  const marketplaceSourcePaths = sourcePathsFromMarketplaceEntries(marketplaceEntries);
  const repoEntries = readMarketplaceEntries(repo);
  return {
    marketplaceRoot,
    marketplaceManifestPath: manifestPath,
    marketplacePresent,
    marketplaceEntries,
    marketplaceSourcePaths,
    repoEntries,
    sourceEntries: marketplacePresent ? marketplaceEntries : repoEntries,
    sourceBaseRoot: marketplacePresent ? marketplaceRoot : repo,
    sourcePaths: marketplacePresent ? marketplaceSourcePaths : repoSourcePaths,
  };
}

function profileReport(name, home, plugins, { sourceInfo, repoBaseRoot, repoSourcePaths, requireAllPlugins, summaryPlugin }) {
  const pluginReports = {};
  const configEntries = pluginConfigEntries(home);
  let ok = true;
  for (const plugin of plugins) {
    const sourcePath = pluginSourcePath(sourceInfo.sourcePaths, plugin, repoSourcePaths);
    const repoSourcePath = pluginSourcePath(repoSourcePaths, plugin);
    const sourcePluginRoot = join(sourceInfo.sourceBaseRoot, sourcePath);
    const repoPluginRoot = join(repoBaseRoot, repoSourcePath);
    const expected = listSkills(sourcePluginRoot, ".");
    const repoPluginPresent = existsSync(repoPluginRoot);
    const sourcePluginPresent = existsSync(sourcePluginRoot);
    const listedInMarketplaceManifest = sourceInfo.marketplacePresent ? sourceInfo.marketplaceSourcePaths.has(plugin) : null;
    const sourceFiles = listComparableFiles(sourcePluginRoot);
    const sourceEntry = sourceInfo.sourceEntries.get(plugin) ?? null;
    const repoEntry = sourceInfo.repoEntries.get(plugin) ?? null;
    const marketplaceInstallation = repoEntry?.installation ?? sourceEntry?.installation ?? null;
    const availableForInstall = marketplaceInstallation !== "NOT_AVAILABLE";
    const manifestVersion = sourceInfo.marketplaceEntries.get(plugin)?.version ?? sourceEntry?.version ?? null;
    const cacheVersion = pluginCacheVersion(home, plugin, sourcePluginRoot, repoPluginRoot, manifestVersion, sourceFiles);
    const cacheRoot = join(home, "plugins", "cache", CACHE_NAMESPACE, plugin, cacheVersion);
    const cached = listSkills(cacheRoot, ".");
    const missing = expected.filter((skill) => !cached.includes(skill));
    const extra = cached.filter((skill) => !expected.includes(skill));
    const fileComparison = compareFileHashes(sourceFiles, listComparableFiles(cacheRoot));
    const repoFileComparison = compareFileHashes(listComparableFiles(repoPluginRoot), listComparableFiles(cacheRoot));
    const filesInSync = fileComparison.missing_files.length === 0
      && fileComparison.extra_files.length === 0
      && fileComparison.changed_files.length === 0
      && fileComparison.expected_files.length > 0;
    const repoFilesInSync = repoFileComparison.missing_files.length === 0
      && repoFileComparison.extra_files.length === 0
      && repoFileComparison.changed_files.length === 0
      && repoFileComparison.expected_files.length > 0;
    const hasExpectedSurface = expected.length > 0 || fileComparison.expected_files.length > 0;
    const inSync = missing.length === 0 && extra.length === 0 && hasExpectedSurface && filesInSync;
    const repoInSync = repoPluginPresent ? repoFilesInSync : null;
    const internalRuntime = INTERNAL_RUNTIME_PLUGINS.has(plugin);
    const configuredEnabled = configEntries.get(plugin) === true;
    const requiredByDependency = requiredByEnabledPlugin(configEntries, plugin);
    const enabled = internalRuntime ? true : configuredEnabled;
    const unavailableConfiguredEnabled = configuredEnabled && !availableForInstall;
    const explicitlyRequestedUnavailable = requireAllPlugins && !availableForInstall;
    const requiredForOk = internalRuntime
      ? ((configuredEnabled || requiredByDependency) && availableForInstall) || (requireAllPlugins && availableForInstall)
      : (configuredEnabled && availableForInstall) || (requireAllPlugins && availableForInstall);
    const missingFromMarketplaceManifest = sourceInfo.marketplacePresent && !listedInMarketplaceManifest;
    if (unavailableConfiguredEnabled) ok = false;
    if (requiredForOk && (!inSync || repoInSync === false || missingFromMarketplaceManifest || (!internalRuntime && !enabled))) ok = false;
    pluginReports[plugin] = {
      internal_runtime: internalRuntime,
      marketplace_installation: marketplaceInstallation,
      repo_marketplace_installation: repoEntry?.installation ?? null,
      available_for_install: availableForInstall,
      configured_enabled: configuredEnabled,
      unavailable_configured_enabled: unavailableConfiguredEnabled,
      explicitly_requested_unavailable: explicitlyRequestedUnavailable,
      required_by_enabled_plugin: requiredByDependency,
      required_for_ok: requiredForOk,
      enabled,
      source_path: sourcePath,
      source_present: sourcePluginPresent,
      source_manifest_present: sourceInfo.marketplacePresent,
      listed_in_marketplace_manifest: listedInMarketplaceManifest,
      repo_source_path: repoSourcePath,
      marketplace_manifest_version: manifestVersion,
      cache_version: cacheVersion,
      cache_path: cacheRoot,
      cache_in_sync: inSync,
      repo_present: repoPluginPresent,
      repo_cache_in_sync: repoInSync,
      expected_skills: expected,
      cached_skills: cached,
      missing_skills: missing,
      extra_skills: extra,
      ...fileComparison,
      repo_expected_files: repoFileComparison.expected_files,
      repo_missing_files: repoFileComparison.missing_files,
      repo_extra_files: repoFileComparison.extra_files,
      repo_changed_files: repoFileComparison.changed_files,
    };
  }
  const summary = summaryPlugin && pluginReports[summaryPlugin]
    ? pluginReports[summaryPlugin]
    : (plugins.length === 1 ? pluginReports[plugins[0]] : null);
  return {
    name,
    home,
    summary_plugin: summary ? (summaryPlugin ?? plugins[0]) : undefined,
    enabled: summary?.enabled,
    cache_in_sync: summary?.cache_in_sync,
    repo_present: summary?.repo_present,
    repo_cache_in_sync: summary?.repo_cache_in_sync,
    missing_skills: summary?.missing_skills,
    missing_files: summary?.missing_files,
    extra_files: summary?.extra_files,
    changed_files: summary?.changed_files,
    repo_changed_files: summary?.repo_changed_files,
    plugins: pluginReports,
    ok,
  };
}

function disabledRequiredPluginNames(profiles) {
  const names = new Set();
  for (const profile of Object.values(profiles)) {
    for (const [plugin, report] of Object.entries(profile.plugins)) {
      if (report.required_for_ok && report.available_for_install !== false && !report.internal_runtime && !report.enabled) names.add(plugin);
    }
  }
  return Array.from(names).sort(comparePathStrings);
}

function unavailableEnabledPluginNames(profiles) {
  const names = new Set();
  for (const profile of Object.values(profiles)) {
    for (const [plugin, report] of Object.entries(profile.plugins)) {
      if (report.unavailable_configured_enabled) names.add(plugin);
    }
  }
  return Array.from(names).sort(comparePathStrings);
}

function unavailableRequestedPluginNames(profiles) {
  const names = new Set();
  for (const profile of Object.values(profiles)) {
    for (const [plugin, report] of Object.entries(profile.plugins)) {
      if (report.explicitly_requested_unavailable) names.add(plugin);
    }
  }
  return Array.from(names).sort(comparePathStrings);
}

function unlistedRequiredPluginNames(profiles) {
  const names = new Set();
  for (const profile of Object.values(profiles)) {
    for (const [plugin, report] of Object.entries(profile.plugins)) {
      if (report.required_for_ok && report.listed_in_marketplace_manifest === false) names.add(plugin);
    }
  }
  return Array.from(names).sort(comparePathStrings);
}

function unhealthyRequiredInternalRuntimeNames(profiles) {
  const names = new Set();
  for (const profile of Object.values(profiles)) {
    for (const [plugin, report] of Object.entries(profile.plugins)) {
      if (!report.required_for_ok || !report.internal_runtime) continue;
      if (!report.cache_in_sync || report.repo_cache_in_sync === false) names.add(plugin);
    }
  }
  return Array.from(names).sort(comparePathStrings);
}

function marketplaceReport(info) {
  return {
    root: info.marketplaceRoot,
    manifest_path: info.marketplaceManifestPath,
    present: info.marketplacePresent,
    source_root: info.sourceBaseRoot,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const repo = resolve(args.repo ?? process.cwd());
  const primaryHome = resolve(args["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const secondHome = args["second-codex-home"] ? resolve(args["second-codex-home"]) : null;
  const repoSourcePaths = sourcePathsFromMarketplaceEntries(readMarketplaceEntries(repo));
  const primarySourceInfo = sourceInfoForHome(primaryHome, repo, repoSourcePaths);
  const secondSourceInfo = secondHome ? sourceInfoForHome(secondHome, repo, repoSourcePaths) : null;
  const defaultPlugins = defaultPluginNames(
    primarySourceInfo.marketplaceSourcePaths.keys(),
    secondSourceInfo?.marketplaceSourcePaths.keys(),
    repoSourcePaths.keys(),
    enabledPluginNamesFromConfig(primaryHome),
    secondHome ? enabledPluginNamesFromConfig(secondHome) : [],
    installedCachePluginNames(primaryHome),
    secondHome ? installedCachePluginNames(secondHome) : [],
  );
  const requestedPlugins = args.plugins.length > 0 ? args.plugins : defaultPlugins;
  const plugins = expandPluginsWithDependencies(requestedPlugins);
  const sharedProfileOptions = {
    repoBaseRoot: repo,
    repoSourcePaths,
    requireAllPlugins: args.plugins.length > 0,
    summaryPlugin: args.plugins.length === 1 ? args.plugins[0] : null,
  };

  const profiles = {
    primary: profileReport("primary", primaryHome, plugins, {
      ...sharedProfileOptions,
      sourceInfo: primarySourceInfo,
    }),
  };
  if (secondHome) {
    profiles.second = profileReport("second", secondHome, plugins, {
      ...sharedProfileOptions,
      sourceInfo: secondSourceInfo,
    });
  }

  const ok = Object.values(profiles).every((profile) => profile.ok);
  const nextActions = [];
  const profileSourceInfos = [primarySourceInfo, secondSourceInfo].filter(Boolean);
  if (profileSourceInfos.some((info) => !info.marketplacePresent)) {
    nextActions.push(`Add the marketplace with \`codex plugin marketplace add ${MARKETPLACE_REPOSITORY}\`.`);
  }
  if (profileSourceInfos.some((info) => info.marketplacePresent)) {
    nextActions.push(`Refresh Git marketplace installs with \`codex plugin marketplace upgrade ${MARKETPLACE}\`.`);
  }
  nextActions.push("If repo working tree differs from installed plugin cache, commit/publish or refresh marketplace/cache before opening new Codex sessions.");
  nextActions.push("If upgrade reports `not configured as a Git marketplace`, remove and re-add the marketplace from GitHub.");
  const disabledRequired = disabledRequiredPluginNames(profiles);
  if (disabledRequired.length > 0) {
    nextActions.push(`Enable required disabled plugins (${disabledRequired.join(", ")}) in \`/plugins\` or config.toml for the Codex profile that will run reviews.`);
  }
  const unavailableEnabled = unavailableEnabledPluginNames(profiles);
  if (unavailableEnabled.length > 0) {
    nextActions.push(`Disable unavailable plugins (${unavailableEnabled.join(", ")}) in \`/plugins\` or config.toml; they are no longer installable from ${MARKETPLACE}.`);
  }
  const unavailableRequested = unavailableRequestedPluginNames(profiles);
  if (unavailableRequested.length > 0) {
    nextActions.push(`Omit unavailable plugins (${unavailableRequested.join(", ")}) from explicit cache-doctor checks; they are no longer installable from ${MARKETPLACE}.`);
  }
  const unlistedRequired = unlistedRequiredPluginNames(profiles);
  if (unlistedRequired.length > 0) {
    nextActions.push(`Refresh ${MARKETPLACE} so required plugins appear in the installed marketplace manifest: ${unlistedRequired.join(", ")}.`);
  }
  const unhealthyInternalRuntimes = unhealthyRequiredInternalRuntimeNames(profiles);
  if (unhealthyInternalRuntimes.length > 0) {
    nextActions.push(`Refresh required internal runtime caches (${unhealthyInternalRuntimes.join(", ")}) by upgrading ${MARKETPLACE} before running direct API reviews.`);
  }
  nextActions.push("Restart already-open Codex TUI sessions; skill picker inventory is loaded in memory.");
  nextActions.push("Verify with `codex debug prompt-input 'list skills'` from the target CODEX_HOME.");

  process.stdout.write(`${JSON.stringify({
    ok,
    repo,
    marketplace: {
      name: MARKETPLACE,
      cache_namespace: CACHE_NAMESPACE,
      ...marketplaceReport(primarySourceInfo),
    },
    marketplaces: Object.fromEntries([
      ["primary", marketplaceReport(primarySourceInfo)],
      ...(secondSourceInfo ? [["second", marketplaceReport(secondSourceInfo)]] : []),
    ]),
    profiles,
    next_actions: nextActions,
  }, null, 2)}\n`);
}

main();
