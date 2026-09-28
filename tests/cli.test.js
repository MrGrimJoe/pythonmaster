// End-to-end test of the local-dev loop: `pythonmaster new`, `pythonmaster
// run --prod`, real HTTP requests against the running FastAPI app (GET
// and POST /api/users, backed by real SQLite), and `pythonmaster add`.
//
// Needs Python 3 with venv+pip on PATH. Runs in a throwaway temp
// directory; never touches the repo it's run from.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync, spawn } = require("child_process");
const { test, report, assert } = require("./harness");

const CLI = path.join(__dirname, "..", "bin", "pythonmaster.js");
const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pythonmaster-cli-test-"));
process.on("exit", () => fs.rmSync(WORK_ROOT, { recursive: true, force: true }));

function httpJson(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...options }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForPort(getLog, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = /CDRCA_PORT=(\d+)/.exec(getLog());
      if (match) return resolve(Number(match[1]));
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for CDRCA_PORT"));
      setTimeout(check, 250);
    };
    check();
  });
}

function waitUntilListening(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = require("net").connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error("server never started accepting connections"));
        setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

test("pythonmaster new scaffolds the expected files", () => {
  const result = spawnSync(process.execPath, [CLI, "new", "demo"], { cwd: WORK_ROOT, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  const projectDir = path.join(WORK_ROOT, "demo");
  for (const f of ["cdrca.json", "main.py", "db.py", "index.html", "requirements.txt", "assets/style.css"]) {
    assert.ok(fs.existsSync(path.join(projectDir, f)), `missing ${f}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "cdrca.json"), "utf8"));
  assert.strictEqual(manifest.runtime, "python");
  assert.strictEqual(manifest.entry, "main.py");
});

test("pythonmaster new refuses to overwrite an existing directory", () => {
  const result = spawnSync(process.execPath, [CLI, "new", "demo"], { cwd: WORK_ROOT, encoding: "utf8" });
  assert.notStrictEqual(result.status, 0);
  assert.ok(/already exists/.test(result.stderr));
});

let child;
let port;
let log = "";

test("pythonmaster run starts a real server (venv + pip install + uvicorn)", async () => {
  const projectDir = path.join(WORK_ROOT, "demo");
  child = spawn(process.execPath, [CLI, "run", "--prod"], { cwd: projectDir });
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  port = await waitForPort(() => log, 120000); // first run: venv + pip install, be generous
  await waitUntilListening(port, 15000);
  assert.ok(port > 0);
});

test("GET /api/users returns the two seeded users", async () => {
  const res = await httpJson(port, { path: "/api/users", method: "GET" });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.users.length, 2);
  assert.strictEqual(res.body.users[0].name, "Ada");
});

test("POST /api/users creates a user, persisted via db.py/SQLite", async () => {
  const res = await httpJson(
    port,
    { path: "/api/users", method: "POST", headers: { "Content-Type": "application/json" } },
    { name: "Hopper" }
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, "Hopper");

  const after = await httpJson(port, { path: "/api/users", method: "GET" });
  assert.strictEqual(after.body.users.length, 3);
  assert.ok(after.body.users.some((u) => u.name === "Hopper"));
});

test("/ serves index.html and /assets/style.css serves the static asset", async () => {
  const index = await httpJson(port, { path: "/", method: "GET" });
  assert.strictEqual(index.status, 200);
  const asset = await httpJson(port, { path: "/assets/style.css", method: "GET" });
  assert.strictEqual(asset.status, 200);
});

test("stop the server", () => {
  child.kill("SIGTERM");
});

test("pythonmaster add installs a package and pins it in requirements.txt", () => {
  const projectDir = path.join(WORK_ROOT, "demo");
  const result = spawnSync(process.execPath, [CLI, "add", "requests"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const reqs = fs.readFileSync(path.join(projectDir, "requirements.txt"), "utf8");
  assert.ok(/^requests==/m.test(reqs), `requirements.txt should pin requests, got:\n${reqs}`);
});

test("pythonmaster run outside a python-runtime project fails clearly", () => {
  const emptyDir = path.join(WORK_ROOT, "not-a-project");
  fs.mkdirSync(emptyDir);
  const result = spawnSync(process.execPath, [CLI, "run"], { cwd: emptyDir, encoding: "utf8" });
  assert.notStrictEqual(result.status, 0);
  assert.ok(/no cdrca\.json/.test(result.stderr));
});

report();
