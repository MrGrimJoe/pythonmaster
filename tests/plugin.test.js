// Unit tests for plugin.js's pythonapi customRule.
//
// Runs two ways:
//   1. Always: against a hand-built fake token stream (no dependency on
//      any CDRCA checkout — this is what runs on a bare `npm install`).
//   2. If CDRCA_RUNTIME_PATH is set (CI sets this to a checkout of
//      github.com/MrGrimJoe/cdrca-ready-for-the-real-world): the SAME
//      assertions again, but tokenized by the real
//      Back-end/Transpiler/Tokenizer.js. This is worth doing separately
//      from the hand-built tokens: cdrca-reactive-state's own tests
//      document a real tokenizer bug (single-character tokens getting
//      their `.type` corrupted by whatever token follows them) that a
//      hand-rolled fake tokenizer would never surface.

const path = require("path");
const { test, report, assert } = require("./harness");
const plugin = require("../plugin.js");
const { pythonMasterCustomRule } = plugin.__internals;

function fakeTok(value) {
  return { value };
}

function parseWithFakeTokenizer(source) {
  // Mirrors the real tokenizer closely enough for this plugin's own
  // parsing (it only ever looks at .value): split on whitespace, keep
  // quoted strings intact.
  const tokens = [];
  const re = /"[^"]*"|\S+/g;
  let m;
  while ((m = re.exec(source))) tokens.push(fakeTok(m[0]));
  tokens.push(fakeTok("\n"));
  return pythonMasterCustomRule(undefined, { tokens, pos: 0, token: tokens[0] });
}

function runSharedAssertions(parseFn, label) {
  test(`${label}: pythonapi GET compiles to a JS_BLOCK`, () => {
    const result = parseFn('pythonapi getUsers = GET "/api/users"');
    assert.ok(result, "expected a result");
    assert.strictEqual(result.type, "JS_BLOCK");
    assert.ok(result.prams.code.includes('window.CDRCA.pythonmaster["getUsers"]'));
    assert.ok(result.prams.code.includes('method: "GET"'));
    assert.ok(result.prams.code.includes('fetch("/api/users"'));
  });

  test(`${label}: pythonapi POST compiles correctly`, () => {
    const result = parseFn('pythonapi createUser = POST "/api/users"');
    assert.ok(result.prams.code.includes('method: "POST"'));
    assert.ok(result.prams.code.includes('window.CDRCA.pythonmaster["createUser"]'));
  });

  test(`${label}: lowercase method is upcased`, () => {
    const result = parseFn('pythonapi deleteUser = delete "/api/users/1"');
    assert.ok(result.prams.code.includes('method: "DELETE"'));
  });

  test(`${label}: unrelated statements are declined (return undefined)`, () => {
    const result = parseFn("state count = 0");
    assert.strictEqual(result, undefined);
  });

  test(`${label}: a node already produced by another plugin is left alone`, () => {
    const tokens = [fakeTok("pythonapi"), fakeTok("x"), fakeTok("="), fakeTok("GET"), fakeTok('"/x"'), fakeTok("\n")];
    const existing = { type: "JS_BLOCK", prams: { code: "already handled" }, newPosition: 3 };
    const result = pythonMasterCustomRule(existing, { tokens, pos: 0, token: tokens[0] });
    assert.strictEqual(result, undefined, "should decline when currentValue is already a resolved node");
  });
}

runSharedAssertions(parseWithFakeTokenizer, "fake tokenizer");

test("bad syntax: missing '=' throws a clear error", () => {
  assert.throws(() => parseWithFakeTokenizer("pythonapi getUsers GET /api/users"), /expected '='/);
});

test("bad syntax: unknown HTTP method throws a clear error", () => {
  assert.throws(() => parseWithFakeTokenizer('pythonapi getUsers = FETCH "/api/users"'), /expected an HTTP method/);
});

test("bad syntax: missing quoted path throws a clear error", () => {
  assert.throws(() => parseWithFakeTokenizer("pythonapi getUsers = GET api/users"), /expected a quoted path/);
});

const RUNTIME_PATH = process.env.CDRCA_RUNTIME_PATH;

if (!RUNTIME_PATH) {
  console.log(
    "\n(Skipping the real-tokenizer pass — set CDRCA_RUNTIME_PATH to a checkout of " +
      "github.com/MrGrimJoe/cdrca-ready-for-the-real-world to also run these assertions " +
      "through the real Tokenizer.js, not just the hand-built fake one.)"
  );
  report();
} else {
  let defaultTokenizer;
  try {
    defaultTokenizer = require(path.join(RUNTIME_PATH, "Back-end", "Transpiler", "Tokenizer.js")).defaultTokenizer;
  } catch (e) {
    console.log(`\nCould not load the real Tokenizer.js from CDRCA_RUNTIME_PATH: ${e.message}`);
    report();
    process.exit(process.exitCode || 0);
  }

  function parseWithRealTokenizer(source) {
    const tokens = defaultTokenizer(source);
    return pythonMasterCustomRule(undefined, { tokens, pos: 0, token: tokens[0] });
  }

  runSharedAssertions(parseWithRealTokenizer, "real Tokenizer.js");
  report();
}
