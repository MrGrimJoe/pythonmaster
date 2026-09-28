// Deploy tests that don't need a live remote server: clean failure when
// unconfigured, the interactive setup flow actually collecting all its
// answers (regression test — see comment below), key generation, and
// that generated remote artifacts are syntactically valid.
//
// The one thing this file does NOT cover is a real SSH round-trip to an
// actual server — see .github/workflows/test.yml's deploy-e2e job for
// that (it spins up a real local sshd + systemd on the CI runner and
// runs a genuine `pythonmaster deploy` against it — something this
// sandbox can't do, since it has no sshd and no systemd as PID 1).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { test, report, assert } = require("./harness");

const CLI = path.join(__dirname, "..", "bin", "pythonmaster.js");
const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pythonmaster-deploy-test-"));
process.on("exit", () => fs.rmSync(WORK_ROOT, { recursive: true, force: true }));

function haveBinary(name) {
  return !spawnSync(name, ["--version"], { stdio: "ignore" }).error;
}

// Set up a minimal python-runtime project to run deploy commands against.
const projectDir = path.join(WORK_ROOT, "proj");
fs.mkdirSync(projectDir);
fs.writeFileSync(
  path.join(projectDir, "cdrca.json"),
  JSON.stringify({ runtime: "python", entry: "main.py" })
);
fs.writeFileSync(path.join(projectDir, "main.py"), "# placeholder\n");

test("deploy without running setup first fails clearly, doesn't hang", () => {
  const result = spawnSync(process.execPath, [CLI, "deploy"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok(/deploy setup/.test(result.stderr));
});

if (!haveBinary("ssh") || !haveBinary("ssh-keygen")) {
  console.log("SKIPPED: ssh/ssh-keygen not on PATH — install an OpenSSH client to run the setup tests.");
  report();
} else {
  test("deploy setup: all four interactive prompts are actually consumed", () => {
    // Regression test for a real bug found while building this: creating
    // a fresh readline.Interface per question (rather than one shared
    // interface consumed via its async iterator) silently drops or hangs
    // on answers after the first when stdin is piped rather than a real
    // TTY. Feeding all four answers at once here is exactly the
    // condition that triggered it.
    //
    // Points at an address in TEST-NET-1 (RFC 5737, guaranteed
    // unreachable/non-routable) on an unused port so the SSH connection
    // fails fast and deterministically instead of depending on any real
    // network target.
    const input = "192.0.2.1\ntestuser\n1\n/tmp/pythonmaster-test-remote\n";
    const result = spawnSync(process.execPath, [CLI, "deploy", "setup"], {
      cwd: projectDir,
      input,
      encoding: "utf8",
      timeout: 20000,
    });

    // It's expected to ultimately fail (nothing is listening at
    // 192.0.2.1) — what matters is that all 4 prompts were shown, in
    // order, meaning none of the answers were dropped.
    const out = result.stdout;
    assert.ok(out.indexOf("Server hostname or IP") < out.indexOf("SSH username"), "prompt order/host");
    assert.ok(out.indexOf("SSH username") < out.indexOf("SSH port"), "prompt order/user");
    assert.ok(out.indexOf("SSH port") < out.indexOf("Remote directory"), "prompt order/port");
    assert.ok(!result.error, "process should exit, not hang/error");
  });

  test("deploy setup generates a real, correctly-permissioned ed25519 key even though the connection fails", () => {
    const keyPath = path.join(projectDir, ".pythonmaster", "deploy_key");
    assert.ok(fs.existsSync(keyPath), "deploy_key was not generated");
    const mode = fs.statSync(keyPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `deploy_key should be 0600, got ${mode.toString(8)}`);

    const check = spawnSync("ssh-keygen", ["-l", "-f", keyPath + ".pub"], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, "generated key should be a valid, well-formed key");
    assert.ok(/ED25519/.test(check.stdout));
  });

  test("deploy.json is NOT written when the connection never succeeded", () => {
    assert.ok(
      !fs.existsSync(path.join(projectDir, ".pythonmaster", "deploy.json")),
      "should not save deploy config after a failed connection"
    );
  });

  report();
}
