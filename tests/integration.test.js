// Full-pipeline integration test: our plugin.js, staged exactly the way
// `cdrca install` stages an ecosystem plugin (Plugins/<name>/plugin.js +
// plugins.json), loaded through CDRCA's REAL plugin.js host and run
// through the REAL Transpiler/index.js — not a mock of either.
//
// This is a close copy of cdrca-reactive-state's own
// tests/integration.test.js (same repo, same patches, same staging
// mechanism) — see that file's comments for the full rationale behind
// each patch. It's copied rather than shared because the two plugins are
// meant to be independently distributable; duplicating ~5 small,
// well-commented patches is cheaper than adding a cross-plugin
// dependency for it.
//
// Needs a local checkout of github.com/MrGrimJoe/cdrca-ready-for-the-real-world.
// Point CDRCA_RUNTIME_PATH at <checkout>/cli/src/templates/cdrca-runtime
// (the directory that directly contains Back-end/) to run this test;
// otherwise it prints why it's skipping and exits 0.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { test, report, assert } = require("./harness");

const RUNTIME_PATH = process.env.CDRCA_RUNTIME_PATH;

if (!RUNTIME_PATH) {
  console.log(
    "SKIPPED: set CDRCA_RUNTIME_PATH to <checkout of MrGrimJoe/cdrca-ready-for-the-real-world>" +
      "/cli/src/templates/cdrca-runtime to run the full pipeline integration test."
  );
  report();
  process.exit(0);
}

// Never touches CDRCA_RUNTIME_PATH itself — works on a throwaway copy,
// same precaution cdrca-reactive-state's test takes (see its comment on
// why: this used to rewrite plugins.json and drop a stray plugin file
// into whatever real tree was pointed at it).
const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pythonmaster-integration-"));
fs.cpSync(path.join(RUNTIME_PATH, "Back-end"), path.join(WORK_ROOT, "Back-end"), {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes("node_modules"),
});
if (fs.existsSync(path.join(RUNTIME_PATH, "node_modules"))) {
  fs.symlinkSync(path.join(RUNTIME_PATH, "node_modules"), path.join(WORK_ROOT, "node_modules"), "dir");
}
process.on("exit", () => fs.rmSync(WORK_ROOT, { recursive: true, force: true }));

const transpilerDir = path.join(WORK_ROOT, "Back-end", "Transpiler");
const pluginHostPath = path.join(transpilerDir, "plugin.js");
const pluginsDir = path.join(transpilerDir, "Plugins");

function ensurePatched(filePath, checks) {
  let src = fs.readFileSync(filePath, "utf8");
  for (const { find, replace, alreadyDoneMarker, alsoDoneMarker } of checks) {
    if (src.includes(alreadyDoneMarker)) continue;
    if (alsoDoneMarker && src.includes(alsoDoneMarker)) continue;
    if (!src.includes(find)) {
      throw new Error(`integration test setup: expected snippet not found in ${filePath}: ${find}`);
    }
    src = src.replace(find, replace);
  }
  fs.writeFileSync(filePath, src);
}

// These five patches make JS_BLOCK statements (what our pythonapi rule
// emits) reach the final output at all, and reach it uncorrupted. They
// are not specific to reactive-state — any plugin emitting JS_BLOCK
// needs them, which is exactly why pythonapi needs them too.
ensurePatched(path.join(transpilerDir, "FullTranspiler.js"), [
  {
    find: "      errorsLOGS: [],\n      scenes: [],\n    };",
    replace: "      errorsLOGS: [],\n      scenes: [],\n      JS_BLOCK: [],\n    };",
    alreadyDoneMarker: "JS_BLOCK: []",
  },
  {
    find:
      'placeholder: ["ACTION_DEF", "PROP_DEF", "PROP_USE", "ACTION_USE"],\n      toString: general3DastToSTRplaceholder,',
    replace:
      'placeholder: ["ACTION_DEF", "PROP_DEF", "PROP_USE", "ACTION_USE", "JS_BLOCK"],\n      toString: general3DastToSTRplaceholder,',
    alreadyDoneMarker: '"ACTION_DEF", "PROP_DEF", "PROP_USE", "ACTION_USE", "JS_BLOCK"',
    alsoDoneMarker: 'placeholder: ["JS_BLOCK"],',
  },
]);

ensurePatched(path.join(transpilerDir, "Parser.js"), [
  {
    find: "const parserConstructor = function (defaultTokenizer, pluginAPI) {",
    replace:
      "function joinTokenValues(tokens) {\n" +
      "  const isWordChar = (c) => !!c && /[A-Za-z0-9_$]/.test(c);\n" +
      "  const endsInBareDigits = (s) => /(?:^|[^0-9A-Za-z_$])[0-9]+$/.test(s);\n" +
      "  const isHexContinuation = (s) => /^[xX][0-9a-fA-F]*$/.test(s);\n" +
      "  return tokens.reduce((acc, t) => {\n" +
      "    const value = String(t.value);\n" +
      "    const prevChar = acc[acc.length - 1];\n" +
      "    if (\n" +
      "      acc.length > 0 &&\n" +
      "      isWordChar(prevChar) &&\n" +
      "      isWordChar(value[0]) &&\n" +
      "      !(endsInBareDigits(acc) && isHexContinuation(value))\n" +
      "    ) {\n" +
      '      return acc + " " + value;\n' +
      "    }\n" +
      "    return acc + value;\n" +
      '  }, "");\n' +
      "}\n\n" +
      "const parserConstructor = function (defaultTokenizer, pluginAPI) {",
    alreadyDoneMarker: "function joinTokenValues(tokens) {",
  },
  {
    find: 'const body = bodyTokens.map((t) => t.value).join("");',
    replace: "const body = joinTokenValues(bodyTokens);",
    alreadyDoneMarker: "const body = joinTokenValues(bodyTokens);",
  },
  {
    find: 'const prams = pramsTokens.map((t) => t.value).join("");',
    replace: "const prams = joinTokenValues(pramsTokens);",
    alreadyDoneMarker: "const prams = joinTokenValues(pramsTokens);",
  },
  {
    find: 'const value = valueTokens.map((t) => t.value).join("");',
    replace: "const value = joinTokenValues(valueTokens);",
    alreadyDoneMarker: "const value = joinTokenValues(valueTokens);",
  },
  {
    find: 'const value = commentTokens.map((t) => t.value).join("");',
    replace: "const value = joinTokenValues(commentTokens);",
    alreadyDoneMarker: "const value = joinTokenValues(commentTokens);",
  },
]);
(function patchCodeTokensSites() {
  let src = fs.readFileSync(path.join(transpilerDir, "Parser.js"), "utf8");
  const find = 'const code = codeTokens.map((t) => t.value).join("");';
  const replace = "const code = joinTokenValues(codeTokens);";
  if (src.includes(find)) {
    src = src.split(find).join(replace);
    fs.writeFileSync(path.join(transpilerDir, "Parser.js"), src);
  }
})();
ensurePatched(path.join(transpilerDir, "Partial_transpiler.js"), [
  {
    find: 'return { value: `(()=>{${statement.prams.code}})()`, type: "JS_BLOCK" };',
    replace: 'return { value: `(()=>{${statement.prams.code}})();`, type: "JS_BLOCK" };',
    alreadyDoneMarker: '})();`, type: "JS_BLOCK" };',
  },
]);

// Stage pythonmaster exactly the way `cdrca install pythonmaster` would.
fs.mkdirSync(path.join(pluginsDir, "pythonmaster"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "..", "plugin.js"), path.join(pluginsDir, "pythonmaster", "plugin.js"));
fs.writeFileSync(
  path.join(pluginsDir, "plugins.json"),
  JSON.stringify([
    {
      name: "pythonmaster",
      path: "pythonmaster/plugin.js",
      uses: [["syntax", "customRule"]],
      permissions: [],
    },
  ])
);

delete require.cache[require.resolve(path.join(transpilerDir, "index.js"))];
delete require.cache[require.resolve(pluginHostPath)];
const T = require(path.join(transpilerDir, "index.js"));

function transpile(body) {
  const src = `!--- SCENE Main :: t ---\n\n${body}\n\n!---END---`;
  return T.transpile({ "index.cdrca": src }, {});
}

test("pythonapi directive reaches the final generated output", () => {
  const out = transpile('pythonapi getUsers = GET "/api/users"');
  assert.ok(out.includes('window.CDRCA.pythonmaster["getUsers"]'), "pythonapi declaration missing from output");
  assert.ok(out.includes('fetch("/api/users"'), "fetch call missing from output");
  assert.ok(out.includes('method: "GET"'), "HTTP method missing from output");
});

test("two pythonapi directives in the same scene don't get glued together by ASI", () => {
  // Regression coverage for the exact bug the Partial_transpiler.js patch
  // above fixes (docs/REACTIVE-STATE.md bug #6): two consecutive JS_BLOCK
  // statements with no trailing ';' get parsed as one IIFE's result being
  // called with the second IIFE as an argument — invalid/wrong JS.
  const out = transpile(
    ['pythonapi getUsers = GET "/api/users"', 'pythonapi createUser = POST "/api/users"'].join("\n\n")
  );
  assert.ok(out.includes('window.CDRCA.pythonmaster["getUsers"]'));
  assert.ok(out.includes('window.CDRCA.pythonmaster["createUser"]'));
  // The output should contain two separate IIFE statements, not one
  // nested inside a call to the other.
  const iifeCount = (out.match(/\}\)\(\);/g) || []).length;
  assert.ok(iifeCount >= 2, `expected at least 2 terminated IIFEs, found ${iifeCount}`);
});

test("a plain scene with no pythonapi directives is unaffected", () => {
  const out = transpile("JS { /* unrelated */ }");
  assert.ok(!out.includes("pythonmaster"), "unrelated scene should not reference pythonmaster at all");
});

test("the generated code actually runs: calling the declared function fetches the right URL", () => {
  let JSDOM;
  try {
    JSDOM = require("jsdom").JSDOM;
  } catch (e) {
    console.log("(skipping — npm install jsdom to run this one)");
    return;
  }

  const out = transpile('pythonapi getUsers = GET "/api/users"');

  const dom = new JSDOM("<div></div>", { runScripts: "outside-only" });
  global.window = dom.window;
  global.document = dom.window.document;

  const calls = [];
  dom.window.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ users: [] }),
    });
  };
  // The full transpiled scene references the 3D/animation runtime
  // regardless of which plugin's JS_BLOCK is present — stub the same way
  // cdrca-reactive-state's integration test does.
  dom.window.THREE = {
    DataTexture: function () {
      return {};
    },
    RGBFormat: 1,
  };
  dom.window.ObjectAnimationSystem_INS = { main: () => ({ init: () => ({}) }) };

  dom.window.eval(out);

  assert.ok(typeof dom.window.CDRCA.pythonmaster.getUsers === "function", "getUsers was not defined");
  return dom.window.CDRCA.pythonmaster.getUsers().then(() => {
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "/api/users");
    assert.strictEqual(calls[0].opts.method, "GET");
  });
});

report();
