import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../../plugins/claude/scripts/lib/args.mjs";
import { parseArgs as parseAgyArgs } from "../../plugins/agy/scripts/lib/args.mjs";

test("parseArgs: long value option via --key value", () => {
  const { options, positionals } = parseArgs(
    ["--model", "claude-opus-4-7", "subject"],
    { valueOptions: ["model"] }
  );
  assert.equal(options.model, "claude-opus-4-7");
  assert.deepEqual(positionals, ["subject"]);
});

test("parseArgs: long value option via --key=value", () => {
  const { options } = parseArgs(["--model=claude-opus-4-7"], {
    valueOptions: ["model"],
  });
  assert.equal(options.model, "claude-opus-4-7");
});

test("parseArgs: inline value keeps equals after the first separator", () => {
  const { options } = parseArgs(["--env=FOO=bar=baz"], {
    valueOptions: ["env"],
  });
  assert.equal(options.env, "FOO=bar=baz");
});

test("parseArgs: boolean flag defaults to true when present", () => {
  const { options } = parseArgs(["--isolated"], { booleanOptions: ["isolated"] });
  assert.equal(options.isolated, true);
});

test("parseArgs: --key=false sets boolean to false", () => {
  const { options } = parseArgs(["--isolated=false"], {
    booleanOptions: ["isolated"],
  });
  assert.equal(options.isolated, false);
});

test("parseArgs: rejects ambiguous space-separated false after boolean flags", () => {
  assert.throws(
    () => parseArgs(["--resend-confirmation-approved", "no"], {
      booleanOptions: ["resend-confirmation-approved"],
    }),
    /Ambiguous boolean: use --resend-confirmation-approved=no to set false/,
  );

  const nextOption = parseArgs(["--resend-confirmation-approved", "--dry-run"], {
    booleanOptions: ["resend-confirmation-approved"],
  });
  assert.equal(nextOption.options["resend-confirmation-approved"], true);
  assert.deepEqual(nextOption.positionals, ["--dry-run"]);
});

test("AGY parseArgs: inline safety boolean false values disable the option", () => {
  const falsyValues = ["false", "FALSE", "0", "no", "NO", "off", "OFF", ""];
  for (const value of falsyValues) {
    const { options } = parseAgyArgs([`--allow-large-source-packet=${value}`], {
      booleanOptions: ["allow-large-source-packet"],
    });
    assert.equal(options["allow-large-source-packet"], false, `value ${JSON.stringify(value)} must parse false`);
  }

  for (const value of ["true", "TRUE", "1"]) {
    const { options } = parseAgyArgs([`--allow-large-source-packet=${value}`], {
      booleanOptions: ["allow-large-source-packet"],
    });
    assert.equal(options["allow-large-source-packet"], true, `value ${JSON.stringify(value)} must parse true`);
  }

  const { options } = parseAgyArgs(["--allow-large-source-packet"], {
    booleanOptions: ["allow-large-source-packet"],
  });
  assert.equal(options["allow-large-source-packet"], true, "bare safety override remains explicit approval");
});

test("AGY parseArgs: rejects ambiguous space-separated false after safety boolean", () => {
  assert.throws(
    () => parseAgyArgs(["--resend-confirmation-approved", "no"], {
      booleanOptions: ["resend-confirmation-approved"],
    }),
    /Ambiguous boolean: use --resend-confirmation-approved=no to set false/,
  );

  const inline = parseAgyArgs(["--resend-confirmation-approved=no"], {
    booleanOptions: ["resend-confirmation-approved"],
  });
  assert.equal(inline.options["resend-confirmation-approved"], false);

  const bare = parseAgyArgs(["--resend-confirmation-approved"], {
    booleanOptions: ["resend-confirmation-approved"],
  });
  assert.equal(bare.options["resend-confirmation-approved"], true);

  const positional = parseAgyArgs(["--resend-confirmation-approved", "review-now"], {
    booleanOptions: ["resend-confirmation-approved"],
  });
  assert.equal(positional.options["resend-confirmation-approved"], true);
  assert.deepEqual(positional.positionals, ["review-now"]);

  const nextOption = parseAgyArgs(["--resend-confirmation-approved", "--dry-run"], {
    booleanOptions: ["resend-confirmation-approved"],
  });
  assert.equal(nextOption.options["resend-confirmation-approved"], true);
  assert.deepEqual(nextOption.positionals, ["--dry-run"]);
});

test("parseArgs: alias maps short to long", () => {
  const { options } = parseArgs(["-m", "X"], {
    valueOptions: ["model"],
    aliasMap: { m: "model" },
  });
  assert.equal(options.model, "X");
});

test("parseArgs: short boolean, fallback key, and missing short value branches", () => {
  const { options } = parseArgs(["-v"], {
    booleanOptions: ["verbose"],
    aliasMap: { v: "verbose" },
  });
  assert.equal(options.verbose, true);

  const { positionals } = parseArgs(["-z"], {});
  assert.deepEqual(positionals, ["-z"]);

  assert.throws(
    () => parseArgs(["-m"], { valueOptions: ["model"], aliasMap: { m: "model" } }),
    /Missing value for -m/,
  );
});

test("parseArgs: throws on missing value", () => {
  assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value/);
});

test("parseArgs: passthrough after --", () => {
  const { positionals } = parseArgs(["--", "--not-a-flag", "anything"], {});
  assert.deepEqual(positionals, ["--not-a-flag", "anything"]);
});

test("parseArgs: unknown long flag becomes positional", () => {
  const { positionals } = parseArgs(["--unknown", "value"], {});
  assert.deepEqual(positionals, ["--unknown", "value"]);
});

test("splitRawArgumentString: basic tokens", () => {
  assert.deepEqual(splitRawArgumentString("one two three"), ["one", "two", "three"]);
});

test("splitRawArgumentString: quoted tokens preserve whitespace", () => {
  assert.deepEqual(
    splitRawArgumentString('one "two three" four'),
    ["one", "two three", "four"]
  );
});

test("splitRawArgumentString: backslash escapes next char", () => {
  assert.deepEqual(splitRawArgumentString("a\\ b c"), ["a b", "c"]);
});

test("splitRawArgumentString: trailing backslash preserved as literal", () => {
  assert.deepEqual(splitRawArgumentString("end\\"), ["end\\"]);
});
