// Relay review-quality A/B harness — Tier 1 (deterministic mechanism isolation).
//
// Holds the input constant (seeded code + a known answer key) and varies ONE
// relay mechanism at a time, driving the REAL repo modules so every number is
// reproducible with no model nondeterminism and no API calls:
//
//   Arm A (blindfold)  — real scope packer (populateScope): what fraction of
//                        answer-key bugs are structurally VISIBLE per scope.
//   Arm B (discard)    — real classifier (buildReviewAuditManifest): how many
//                        known-correct reviews get failed_review_slot.
//   Arm C (garble)     — real redactor (buildPrivacyRedactor): how much
//                        non-secret review content gets corrupted.
//
// This measures CEILINGS and TRANSFORM DAMAGE, not realized end-to-end model
// quality. The realized gap is Tier 2 (live models) and is intentionally not
// here. Run: node scripts/ab/relay-quality-ab.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewAuditManifest } from "../lib/review-prompt.mjs";
import { buildPrivacyRedactor } from "../lib/privacy-redaction.mjs";
import { resolveProfile } from "../../plugins/gemini/scripts/lib/mode-profiles.mjs";
import { setupContainment } from "../../plugins/gemini/scripts/lib/containment.mjs";
import { populateScope } from "../../plugins/gemini/scripts/lib/scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function hr(title) {
  console.log("\n" + "=".repeat(78) + "\n" + title + "\n" + "=".repeat(78));
}
function pct(n, d) {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Arm A — blindfold: real scope packer, cross-file answer key.
// ---------------------------------------------------------------------------
function listSnapshotFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const r = rel ? `${rel}/${entry}` : entry;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out;
}

function gitInit(repo) {
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "ab", GIT_AUTHOR_EMAIL: "ab@ab", GIT_COMMITTER_NAME: "ab", GIT_COMMITTER_EMAIL: "ab@ab" },
  });
  g("init", "-q", "-b", "main");
  return g;
}

function runArmA() {
  hr("ARM A — blindfold (real scope packer): which answer-key bugs are VISIBLE per scope");

  const repo = mkdtempSync(path.join(tmpdir(), "ab-armA-"));
  const g = gitInit(repo);

  // BASE commit: correct baseline with a caller and an auth helper.
  const write = (rel, body) => {
    mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  write("src/auth.js", `export function requireRole(user, role) {\n  return user && user.roles.includes(role);\n}\n`);
  write("src/routes.js", `import { requireRole } from "./auth.js";\nexport function adminOnly(currentUser) {\n  // caller relies on requireRole(user, role) ordering\n  return requireRole(currentUser, "admin");\n}\n`);
  write("src/cart.js", `export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n`);
  g("add", "-A");
  g("commit", "-q", "-m", "base");

  // HEAD commit: introduce bugs of three evidence-locality classes.
  //  bug1 (in-diff):     cart.total now subtracts — evidence wholly in cart.js (changed).
  //  bug2 (cross-file):  auth.requireRole arg order swapped to (role, user); every
  //                      UNCHANGED caller in routes.js is now broken. Evidence needs routes.js.
  //  bug3 (history):     a constant silently changed; only `git log -p` reveals the regression.
  write("src/cart.js", `export function total(items) {\n  return items.reduce((sum, item) => sum - item.price, 0);\n}\n`);
  write("src/auth.js", `export function requireRole(role, user) {\n  return user && user.roles.includes(role);\n}\n`);
  write("src/config.js", `export const MAX_RETRIES = 0;\n`); // was implicitly 3 elsewhere historically
  g("add", "-A");
  g("commit", "-q", "-m", "head");

  // Answer key: each bug + the files a reviewer MUST be able to read to find it.
  const answerKey = [
    { id: "cart_total_subtracts", locality: "in-diff", evidenceFiles: ["src/cart.js"] },
    { id: "requireRole_argswap_breaks_callers", locality: "cross-file", evidenceFiles: ["src/auth.js", "src/routes.js"] },
    { id: "max_retries_silent_regression", locality: "history", evidenceFiles: ["src/config.js"], needsHistory: true },
  ];

  const scopes = [
    { skill: "review", scopeBase: null },                 // working-tree
    { skill: "adversarial-review", scopeBase: "main~1" }, // branch-diff vs base
  ];

  const rows = [];
  for (const { skill, scopeBase } of scopes) {
    const profile = resolveProfile(skill);
    const containment = setupContainment(profile, repo);
    let snapshotRoot = containment.path;
    try {
      populateScope(profile, repo, containment.path, { scopeBase, scopePaths: [], workspaceRoot: repo }, containment);
      const present = new Set(listSnapshotFiles(snapshotRoot).map((p) => p.replace(/\\/g, "/")));
      const visible = answerKey.filter((bug) => bug.evidenceFiles.every((f) => [...present].some((p) => p.endsWith(f))));
      // History-class bugs: the file may be present but the regression needs git
      // history, which neither static snapshot ships. Mark visible-but-not-provable.
      const provable = visible.filter((bug) => !bug.needsHistory);
      rows.push({
        skill,
        scope: profile.scope,
        files: [...present].filter((p) => p.endsWith(".js")).length,
        provable,
        visible,
      });
      console.log(`\n[${skill}]  scope=${profile.scope}  files_in_packet=${[...present].filter((p) => p.endsWith(".js")).length}`);
      console.log(`  packet js files: ${[...present].filter((p) => p.endsWith(".js")).sort().join(", ") || "(none)"}`);
      for (const bug of answerKey) {
        const seen = bug.evidenceFiles.every((f) => [...present].some((p) => p.endsWith(f)));
        const status = !seen ? "STRUCTURALLY INVISIBLE" : bug.needsHistory ? "file present, but needs git history (not in snapshot)" : "visible";
        console.log(`    - ${bug.id} (${bug.locality}): ${status}`);
      }
      console.log(`  recall ceiling (provable bugs): ${provable.length}/${answerKey.length} = ${pct(provable.length, answerKey.length)}`);
    } finally {
      try { containment.cleanup?.(); } catch { /* best effort */ }
    }
  }
  rmSync(repo, { recursive: true, force: true });
  return rows;
}

// ---------------------------------------------------------------------------
// Arm B — discard: real classifier on a corpus of KNOWN-CORRECT reviews.
// ---------------------------------------------------------------------------
function runArmB() {
  hr("ARM B — discard (real classifier): how many KNOWN-CORRECT reviews are nulled");

  // A non-tiny selected source so the conciseTinyReview escape does not apply.
  const sourceFiles = [
    { path: "src/auth.js", text: "export function requireRole(role, user) {\n  return user && user.roles.includes(role);\n}\n// padding to exceed the tiny-source threshold ".padEnd(700, "x") },
  ];

  // Each review below is CORRECT and substantive — a human would accept it.
  // To ISOLATE the prose heuristics from the <500-char shallow floor, the first
  // five are deliberately written past 500 chars (the length of a real review);
  // the last two are short, to measure the shallow floor on its own.
  // `expect` documents which single defect (if any) each is designed to probe.
  const pad = " The reasoning above is based solely on the supplied selected source; no external tools were needed to reach it, and the file paths cited are the ones inspected.";
  const corpus = [
    {
      id: "long_control_request_changes",
      note: "CONTROL (>500ch, marker, real bug) — should PASS",
      expect: "pass",
      text: "Verdict: REQUEST CHANGES\n\nBlocking findings\n- src/auth.js: requireRole(role, user) reversed the parameter order relative to the previous (user, role) contract. Every caller in the codebase that still passes (user, role) — e.g. routes.js adminOnly — now evaluates user.roles.includes(user) against the wrong operand and silently denies access. This is a concrete authentication regression with a clear control-flow path from the changed signature to the broken caller.\n\nNon-blocking concerns\n- Consider a typed wrapper to make the argument order compiler-checked.\n\nChecklist\n- refs: PASS\n- correctness: FAIL\n- security: FAIL" + pad,
    },
    {
      id: "long_honest_hedge_caveat",
      note: "correct verdict + honest scope caveat, NO 'out of scope' marker",
      expect: "not_reviewed",
      text: "Verdict: APPROVE\n\nBlocking findings\n- None. The change in src/cart.js correctly switches the reduce back to sum + item.price, so totals add rather than subtract, and the empty-items path still returns 0 via the seed value.\n\nNon-blocking concerns\n- I could not inspect the upstream caller in routes.js, but the supplied diff is internally consistent and the arithmetic is correct as written. A follow-up that includes the caller would let me confirm the integration end to end." + pad,
    },
    {
      id: "long_describes_eacces_handling",
      note: "correctly REVIEWS code that handles EACCES (describing the reviewed code)",
      expect: "permission_blocked",
      text: "Verdict: APPROVE\n\nBlocking findings\n- None. The control flow in src/config.js is sound.\n\nNon-blocking concerns\n- The new code correctly handles EACCES when it cannot read the config file: it catches the error, logs a warning, and falls back to the documented defaults instead of crashing. permission denied on the optional override file is the expected, well-handled case here, so this is the right behavior and not a blocker." + pad,
    },
    {
      id: "long_prose_verdict_no_marker",
      note: "correct & substantive, but verdict phrased as prose (no recognized label)",
      expect: "missing_verdict",
      text: "Conclusion — this change looks good and is safe to ship. I read src/cart.js end to end: total() now adds item.price across the reduce, the seed of 0 covers the empty-items case, and there is no coercion bug because the inputs are already numbers per the caller contract. I also checked that nothing else in the diff depends on the previous subtracting behavior. No blockers; the only thing I would suggest later is a unit test for the empty list." + pad,
    },
    {
      id: "long_control_approve",
      note: "CONTROL (>500ch, marker, clean) — should PASS",
      expect: "pass",
      text: "Verdict: APPROVE\n\nBlocking findings\n- None. I inspected src/auth.js and src/cart.js. The reduce in total() adds Number-typed prices with a 0 seed, and requireRole evaluates membership correctly for the (role, user) signature as written within this packet's contract.\n\nNon-blocking concerns\n- Minor: add a unit test for the empty-items case and for a user with no roles array.\n\nChecklist\n- refs: PASS\n- correctness: PASS" + pad,
    },
    {
      id: "terse_but_correct",
      note: "SHORT (<500ch), correct verdict + the one real bug — probes shallow floor",
      expect: "shallow_output",
      text: "Verdict: REQUEST CHANGES. src/cart.js total() subtracts item.price instead of adding; the reduce should use sum + item.price. That is the only blocker.",
    },
    {
      id: "terse_control_approve",
      note: "SHORT (<500ch), complete marker-compliant approve — probes shallow floor",
      expect: "shallow_output",
      text: "Verdict: APPROVE\n\nBlocking findings\n- None in src/cart.js.\n\nNon-blocking concerns\n- Add a test for empty items.",
    },
  ];

  const rows = corpus.map((r) => {
    const manifest = buildReviewAuditManifest({
      result: r.text,
      status: "completed",
      errorCode: null,
      sourceFiles,
      scope: { name: "review" },
    });
    const q = manifest.review_quality;
    return { ...r, len: r.text.length, failed: q.failed_review_slot, reasons: q.semantic_failure_reasons, shallow: q.looks_shallow, hasVerdict: q.has_verdict };
  });

  for (const r of rows) {
    console.log(`\n[${r.id}] ${r.note}  (${r.len} chars)`);
    console.log(`  failed_review_slot=${r.failed}  reasons=[${r.reasons.join(", ")}]  has_verdict=${r.hasVerdict}  expect=${r.expect}`);
  }

  const controls = rows.filter((r) => r.expect === "pass");
  const controlsNulled = controls.filter((r) => r.failed);
  const probes = rows.filter((r) => r.expect !== "pass");
  const probesNulled = probes.filter((r) => r.failed);
  const failed = rows.filter((r) => r.failed);

  console.log(`\n  isolation:`);
  console.log(`    long marker-compliant CONTROLS nulled: ${controlsNulled.length}/${controls.length}  (expect 0 — proves the gate isn't nuking everything)`);
  for (const r of probes) {
    const fired = r.reasons.includes(r.expect);
    console.log(`    ${r.id}: expected '${r.expect}' -> ${fired ? "FIRED" : "not fired"}; failed_slot=${r.failed}`);
  }
  console.log(`\n  overall false-failure rate (correct reviews nulled): ${failed.length}/${rows.length} = ${pct(failed.length, rows.length)}`);
  console.log(`  nulled: ${failed.map((r) => r.id).join(", ") || "(none)"}`);
  return { rows, controls, controlsNulled, probes, probesNulled };
}

// ---------------------------------------------------------------------------
// Arm C — garble: real redactor on a corpus of realistic findings.
// ---------------------------------------------------------------------------
function runArmC() {
  hr("ARM C — garble (real redactor): how much NON-SECRET review content is corrupted");

  const redactor = buildPrivacyRedactor({});
  // containsRealSecret=false → ANY change is corruption of real content.
  const corpus = [
    { id: "bearer_codepath", secret: false, text: 'The handler does `if (header.startsWith("Bearer ")) { const token = header.slice(7); }` which is correct.' },
    { id: "bearer_prose", secret: false, text: 'BUG: assumes Bearer prefix length is fixed; multi-space "Bearer  x" breaks slice(7).' },
    { id: "dotted_identifier", secret: false, text: "Route core_dispatch.request_router.dispatch never validates the prod_config9 flag that disables TLS." },
    { id: "actor_handle", secret: false, text: "Notifications go to handler@v2.service even on failure." },
    { id: "token_var", secret: false, text: "The variable Token expiry is computed wrong; Token refresh never fires." },
    { id: "plain_finding", secret: false, text: "src/cart.js total() subtracts item.price instead of adding; the reduce operator is wrong." },
    { id: "control_flow", secret: false, text: "The gate-config check at line 73 runs after the approvable branch at line 68, so an overlapping command bypasses it." },
    // A genuine secret-shaped value — redaction here is CORRECT, shown for contrast.
    { id: "real_bearer_token", secret: true, text: "The log leaks Authorization: Bearer ey7Jh9Kk2Lm4Nn6Pq8Rs0Tu2Vw4Xy6Za8Bc0De into stdout." },
  ];

  const rows = corpus.map((c) => {
    const out = redactor.value(c.text);
    const changed = out !== c.text;
    const corrupted = changed && !c.secret; // corrupting real content
    return { ...c, out, changed, corrupted };
  });

  for (const r of rows) {
    const tag = r.secret ? (r.changed ? "OK (real secret redacted)" : "MISS (secret not redacted)") : (r.corrupted ? "CORRUPTED" : "clean");
    console.log(`\n[${r.id}] ${tag}`);
    if (r.changed) {
      console.log(`  in : ${r.text}`);
      console.log(`  out: ${r.out}`);
    }
  }
  const nonSecret = rows.filter((r) => !r.secret);
  const corrupted = nonSecret.filter((r) => r.corrupted);
  console.log(`\n  garble rate (non-secret findings corrupted): ${corrupted.length}/${nonSecret.length} = ${pct(corrupted.length, nonSecret.length)}`);
  console.log(`  corrupted: ${corrupted.map((r) => r.id).join(", ") || "(none)"}`);
  return rows;
}

// ---------------------------------------------------------------------------
function main() {
  const a = runArmA();
  const b = runArmB();
  const c = runArmC();

  hr("SUMMARY — measured mechanism damage (Tier 1, deterministic)");
  const adv = a.find((r) => r.skill === "adversarial-review");
  const rev = a.find((r) => r.skill === "review");
  const bFailed = b.rows.filter((r) => r.failed).length;
  const cNonSecret = c.filter((r) => !r.secret);
  const cCorrupt = cNonSecret.filter((r) => r.corrupted).length;

  console.log(`
  Arm A  blindfold        review(working-tree) recall ceiling      ${rev.provable.length}/3 (${pct(rev.provable.length, 3)})
                          adversarial(branch-diff) recall ceiling  ${adv.provable.length}/3 (${pct(adv.provable.length, 3)})
                          -> the cross-file bug is structurally invisible to adversarial-review

  Arm B  discard          correct reviews nulled by classifier     ${bFailed}/${b.rows.length} (${pct(bFailed, b.rows.length)})
                          long marker-compliant controls nulled    ${b.controlsNulled.length}/${b.controls.length} (expect 0)
                          honest-hedge / EACCES / prose / terse    each nulled by its own heuristic (see isolation)

  Arm C  garble           non-secret findings corrupted            ${cCorrupt}/${cNonSecret.length} (${pct(cCorrupt, cNonSecret.length)})
`);
  console.log("  NOTE: Tier 1 measures structural ceilings + deterministic transform damage,");
  console.log("        not realized model quality. Tier 2 (live gemini vs relay) validates the");
  console.log("        realized gap and captures A2 (prompt-prohibition effect).");
}

main();
