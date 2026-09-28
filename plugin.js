// pythonmaster — transpiler plugin (the sandboxed half of this package)
//
// This file is the ONLY part of pythonmaster that CDRCA's compiler ever
// loads. It runs inside the plugin host's sandbox (no require(), no fs,
// no child_process — same sandbox every other transpiler plugin runs in,
// see docs/PLUGIN-PERMISSIONS.md). That's why cdrca.json declares
// `"permissions": []` — this file never touches the filesystem or spawns
// anything. It only rewrites .cdrca syntax into JS, the same way
// cdrca-reactive-state and Quark do.
//
// Everything pythonmaster does that NEEDS real fs/child_process access
// (scaffolding a project, creating a venv, running uvicorn) is NOT in
// here — there is currently no transpiler hook for "before a project
// runs" or "when `cdrca new` is called" (see PLUGIN-PERMISSIONS.md's
// verified hook list: syntax/ast/exec/before-after-transpile-phases
// only). That work lives in bin/pythonmaster.js instead, a normal,
// unsandboxed Node script shipped alongside this plugin and run directly
// by the user — see README.md.
//
// WHAT THIS FILE ADDS TO THE LANGUAGE
//   pythonapi <name> = <METHOD> "<path>"
//
// Example:
//   pythonapi getUsers = GET "/api/users"
//   pythonapi createUser = POST "/api/users"
//
// Declares a typed shortcut to a route your PythonMaster backend serves.
// Compiles to a small fetch() wrapper hung off window.CDRCA.pythonmaster,
// so a JS { } block (or, later, a Reactive State watcher) can just call:
//
//   pythonmaster.getUsers().then(data => ...)
//   pythonmaster.createUser({ name: "Ada" }).then(data => ...)
//
// This is intentionally the smallest useful thing: it does not require a
// PythonMaster backend to exist, does not validate the route exists, and
// does not touch fs. It is pure syntax sugar over fetch(), registered
// through the exact same ("syntax","customRule") hook every other CDRCA
// plugin uses — so `require pythonmaster` in a .cdrca file, and this
// plugin coexisting with Quark / cdrca-reactive-state in the same
// project, works the normal way, with no special-casing anywhere else.

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isIdentifierLike(t) {
  return !!t && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.value);
}

function isNewlineToken(t) {
  return !!t && t.value === "\n";
}

function jsBlock(code, newPosition) {
  return { type: "JS_BLOCK", prams: { code }, newPosition };
}

// pythonapi <name> = <METHOD> "<path>"
function parsePythonApiDecl(tokens, pos) {
  let p = pos + 1;

  if (p >= tokens.length || !isIdentifierLike(tokens[p])) {
    throw new Error("PythonMaster: expected a name after 'pythonapi'");
  }
  const name = tokens[p].value;
  p++;

  if (!(tokens[p] && tokens[p].value === "=")) {
    throw new Error(`PythonMaster: expected '=' after 'pythonapi ${name}'`);
  }
  p++;

  if (!(tokens[p] && isIdentifierLike(tokens[p]) && HTTP_METHODS.has(tokens[p].value.toUpperCase()))) {
    throw new Error(
      `PythonMaster: expected an HTTP method (GET, POST, PUT, PATCH, DELETE) after 'pythonapi ${name} ='`
    );
  }
  const method = tokens[p].value.toUpperCase();
  p++;

  const pathToken = tokens[p];
  if (!pathToken || typeof pathToken.value !== "string" || !pathToken.value.startsWith('"')) {
    throw new Error(`PythonMaster: expected a quoted path after 'pythonapi ${name} = ${method}'`);
  }
  // Path arrives as a raw quoted token, e.g. `"/api/users"` — strip the
  // surrounding quotes CDRCA's tokenizer keeps on string literals.
  const routePath = pathToken.value.replace(/^"|"$/g, "");
  p++;

  // Consume to end of line/statement without requiring one — a trailing
  // newline just marks where this declaration ends, same convention
  // cdrca-reactive-state uses for `state`/`computed`/`watch`.
  let newPosition = p;
  while (newPosition < tokens.length && !isNewlineToken(tokens[newPosition])) {
    newPosition++;
  }

  const code =
    `window.CDRCA = window.CDRCA || {};\n` +
    `window.CDRCA.pythonmaster = window.CDRCA.pythonmaster || {};\n` +
    `window.CDRCA.pythonmaster[${JSON.stringify(name)}] = function (body) {\n` +
    `  return fetch(${JSON.stringify(routePath)}, {\n` +
    `    method: ${JSON.stringify(method)},\n` +
    `    headers: body !== undefined ? { "Content-Type": "application/json" } : {},\n` +
    `    body: body !== undefined ? JSON.stringify(body) : undefined\n` +
    `  }).then(function (r) {\n` +
    `    const ct = r.headers.get("content-type") || "";\n` +
    `    return ct.indexOf("application/json") !== -1 ? r.json() : r.text();\n` +
    `  });\n` +
    `};\n` +
    `const pythonmaster = window.CDRCA.pythonmaster;`;

  return jsBlock(code, newPosition);
}

function pythonMasterCustomRule(currentValue, ctx) {
  // Another plugin already produced a node for this statement — decline,
  // same coexistence convention cdrca-reactive-state uses.
  if (currentValue && currentValue.newPosition !== undefined) return undefined;

  const { tokens, pos, token } = ctx || {};
  if (!token) return undefined;

  if (token.value === "pythonapi") {
    return parsePythonApiDecl(tokens, pos);
  }
  return undefined;
}

module.exports = function (pluginAPI /*, hostAPI */) {
  pluginAPI.register(0, "syntax", "customRule", pythonMasterCustomRule);
};

module.exports.__internals = {
  pythonMasterCustomRule,
  parsePythonApiDecl,
};
