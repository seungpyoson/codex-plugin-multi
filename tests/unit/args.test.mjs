import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../../plugins/claude/scripts/lib/args.mjs";

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

test("parseArgs: alias maps short to long", () => {
  const { options } = parseArgs(["-m", "X"], {
    valueOptions: ["model"],
    aliasMap: { m: "model" },
  });
  assert.equal(options.model, "X");
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
