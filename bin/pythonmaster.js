#!/usr/bin/env node
"use strict";

// pythonmaster CLI — the unsandboxed half of this package.
//
// WHY THIS IS A SEPARATE BINARY AND NOT PART OF plugin.js:
// CDRCA's transpiler plugin sandbox (see plugin.js's header comment, and
// docs/PLUGIN-PERMISSIONS.md) has no hook for "before `cdrca new` runs"
// or "before `cdrca run`/`cdrca deploy` runs" — the only hooks that
// exist fire during parsing/transpiling a .cdrca file. So project
// scaffolding, running a Python process, and deployment cannot be
// transpiler-plugin hooks today without changes to CDRCA's own CLI,
// which this package intentionally does not make. Instead, this file is
// a normal, unsandboxed Node script — the same pattern CDRCA's own
// npm/bin/cdrca.js wrapper uses to add convenience commands in front of
// the real compiled binary.
//
// Usage:
//   pythonmaster new <project-name>   scaffold a new Python/FastAPI project
//   pythonmaster run [--prod]         install deps and start it (reload on by default)
//   pythonmaster add <package>        pip install + save to requirements.txt
//   pythonmaster deploy setup         one-time: connect to your server, save deploy config
//   pythonmaster deploy               ship the current project to that server
//   pythonmaster help

const fs = require("fs");
const path = require("path");
const net = require("net");
const readline = require("readline");
const { spawnSync, spawn } = require("child_process");

const TEMPLATE_DIR = path.join(__dirname, "..", "templates", "python-project");
const IS_WINDOWS = process.platform === "win32";

function log(msg) {
  process.stdout.write(msg + "\n");
}

function fail(msg) {
  process.stderr.write("pythonmaster: " + msg + "\n");
  process.exit(1);
}

// One shared readline interface per interactive flow, consumed via its
// async iterator rather than repeated .question() calls. Repeated
// .question() calls (the more obvious way to write this) drop or hang
// on later answers when stdin is piped rather than a real TTY, because
// readline can emit 'line' for buffered input before the next
// .question() has attached its listener. The async-iterator form
// queues lines correctly regardless of listener timing.
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async ask(question, defaultValue) {
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      process.stdout.write(`${question}${suffix}: `);
      const { value, done } = await iterator.next();
      if (done) return defaultValue || "";
      return value.trim() || defaultValue || "";
    },
    close() {
      rl.close();
    },
  };
}

// --------------------------------------------------------------- new

function copyTemplate(srcDir, destDir, replacements) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(srcPath, destPath, replacements);
    } else {
      let contents = fs.readFileSync(srcPath, "utf8");
      for (const [needle, value] of Object.entries(replacements)) {
        contents = contents.split(needle).join(value);
      }
      fs.writeFileSync(destPath, contents);
    }
  }
}

function cmdNew(projectName) {
  if (!projectName) {
    fail("usage: pythonmaster new <project-name>");
  }
  const destDir = path.resolve(process.cwd(), projectName);
  if (fs.existsSync(destDir)) {
    fail(`'${projectName}' already exists`);
  }
  if (!fs.existsSync(TEMPLATE_DIR)) {
    fail("template directory is missing from this install (templates/python-project)");
  }

  copyTemplate(TEMPLATE_DIR, destDir, { __PROJECT_NAME__: projectName });

  log(`Created ${projectName}/`);
  log("  cdrca.json   (runtime: python)");
  log("  main.py");
  log("  db.py        (SQLite — smallest useful data layer)");
  log("  index.html");
  log("  requirements.txt");
  log("  assets/style.css");
  log("");
  log("Next:");
  log(`  cd ${projectName}`);
  log("  pythonmaster run");
}

// --------------------------------------------------------------- run / add

function readProjectManifest() {
  const manifestPath = path.join(process.cwd(), "cdrca.json");
  if (!fs.existsSync(manifestPath)) {
    fail("no cdrca.json in this directory. Run this inside a project created with 'pythonmaster new'.");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`cdrca.json is not valid JSON (${e.message})`);
  }
  if (manifest.runtime !== "python") {
    fail(`cdrca.json's "runtime" is not "python" (got: ${JSON.stringify(manifest.runtime)}). pythonmaster only runs python-runtime projects.`);
  }
  if (!manifest.entry) {
    fail('cdrca.json is missing an "entry" field (e.g. "main.py")');
  }
  const entryPath = path.join(process.cwd(), manifest.entry);
  if (!fs.existsSync(entryPath)) {
    fail(`entry file not found: ${manifest.entry}`);
  }
  return { manifest, entryPath };
}

function findSystemPython() {
  const candidates = IS_WINDOWS ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) return candidate;
  }
  fail("no Python interpreter found on PATH (tried python3, python). Install Python 3 first.");
}

function venvPaths(projectDir) {
  const venvDir = path.join(projectDir, ".venv");
  const pythonBin = IS_WINDOWS
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
  return { venvDir, pythonBin };
}

function ensureVenv(projectDir) {
  const { venvDir, pythonBin } = venvPaths(projectDir);
  if (fs.existsSync(pythonBin)) return pythonBin;

  log("Setting up a local virtual environment (.venv) — first run only...");
  const systemPython = findSystemPython();
  const result = spawnSync(systemPython, ["-m", "venv", venvDir], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("failed to create the virtual environment");
  }
  return pythonBin;
}

function installedMarkerStale(projectDir) {
  const reqPath = path.join(projectDir, "requirements.txt");
  const markerPath = path.join(projectDir, ".venv", ".pythonmaster-installed");
  if (!fs.existsSync(reqPath)) return false; // nothing to install
  if (!fs.existsSync(markerPath)) return true;
  return fs.statSync(reqPath).mtimeMs > fs.statSync(markerPath).mtimeMs;
}

function touchInstalledMarker(projectDir) {
  fs.writeFileSync(path.join(projectDir, ".venv", ".pythonmaster-installed"), String(Date.now()));
}

function ensureDependencies(projectDir, pythonBin) {
  const reqPath = path.join(projectDir, "requirements.txt");
  if (!fs.existsSync(reqPath)) return;
  if (!installedMarkerStale(projectDir)) return;

  log("Installing dependencies from requirements.txt...");
  const result = spawnSync(pythonBin, ["-m", "pip", "install", "-q", "-r", reqPath], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("pip install failed");
  }
  touchInstalledMarker(projectDir);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function cmdRun(flags) {
  const projectDir = process.cwd();
  const { manifest, entryPath } = readProjectManifest();

  const pythonBin = ensureVenv(projectDir);
  ensureDependencies(projectDir, pythonBin);

  const port = await findFreePort();
  const reload = !flags.includes("--prod");

  log(`CDRCA_PORT=${port}`);
  log(`Starting ${manifest.entry} on http://127.0.0.1:${port} ...${reload ? " (reload on — use --prod to disable)" : ""}`);

  const child = spawn(pythonBin, [entryPath], {
    cwd: projectDir,
    stdio: "inherit",
    env: Object.assign({}, process.env, {
      PORT: String(port),
      PYTHONMASTER_RELOAD: reload ? "1" : "0",
    }),
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code) => process.exit(code === null ? 1 : code));
}

function cmdAdd(packageName) {
  if (!packageName) {
    fail("usage: pythonmaster add <package>");
  }
  const projectDir = process.cwd();
  readProjectManifest(); // validates we're in a pythonmaster project
  const { pythonBin } = venvPaths(projectDir);
  if (!fs.existsSync(pythonBin)) {
    fail("no .venv yet — run 'pythonmaster run' once first");
  }

  log(`Installing ${packageName}...`);
  const result = spawnSync(pythonBin, ["-m", "pip", "install", "-q", packageName], { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`pip could not install '${packageName}'`);
  }

  // Record the installed (resolved) version in requirements.txt, same
  // format `pip freeze` uses, so a fresh 'pythonmaster run' elsewhere
  // reproduces this exact version.
  const freeze = spawnSync(pythonBin, ["-m", "pip", "freeze"], { encoding: "utf8" });
  const line = freeze.stdout
    .split("\n")
    .find((l) => l.toLowerCase().startsWith(packageName.toLowerCase() + "=="));

  const reqPath = path.join(projectDir, "requirements.txt");
  let lines = fs.existsSync(reqPath)
    ? fs.readFileSync(reqPath, "utf8").split("\n").filter(Boolean)
    : [];
  lines = lines.filter((l) => !l.toLowerCase().startsWith(packageName.toLowerCase()));
  lines.push(line || packageName);
  fs.writeFileSync(reqPath, lines.join("\n") + "\n");
  touchInstalledMarker(projectDir); // we just installed it; don't reinstall on next run

  log(`Added to requirements.txt: ${line || packageName}`);
}

// --------------------------------------------------------------- deploy

const DEPLOY_DIR = () => path.join(process.cwd(), ".pythonmaster");
const DEPLOY_CONFIG = () => path.join(DEPLOY_DIR(), "deploy.json");
const DEPLOY_KEY = () => path.join(DEPLOY_DIR(), "deploy_key");

function loadDeployConfig() {
  if (!fs.existsSync(DEPLOY_CONFIG())) {
    fail("no deploy config found. Run 'pythonmaster deploy setup' first.");
  }
  return JSON.parse(fs.readFileSync(DEPLOY_CONFIG(), "utf8"));
}

function sshBaseArgs(cfg, extra) {
  return [
    "-i", cfg.keyPath,
    "-p", String(cfg.port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    `${cfg.user}@${cfg.host}`,
  ].concat(extra || []);
}

function haveBinary(name) {
  const result = spawnSync(name, ["--version"], { stdio: "ignore" });
  return !result.error;
}

async function cmdDeploySetup() {
  const projectDir = process.cwd();
  readProjectManifest(); // must be a pythonmaster project
  const projectName = path.basename(projectDir);

  if (!haveBinary("ssh") || !haveBinary("ssh-keygen")) {
    fail("this needs an OpenSSH client (ssh, ssh-keygen, scp) installed on your machine.");
  }

  log("--- PythonMaster deploy setup ---");
  log("This only talks to the server you specify, directly over SSH.");
  log("Your password is never seen or stored by this tool — SSH prompts");
  log("you for it directly, once, to install a dedicated deploy key.\n");

  const prompter = makePrompter();
  const host = await prompter.ask("Server hostname or IP");
  if (!host) {
    prompter.close();
    fail("a server hostname/IP is required");
  }
  const user = await prompter.ask("SSH username", "root");
  const port = (await prompter.ask("SSH port", "22")).trim();
  const remotePath = await prompter.ask("Remote directory for this app", `pythonmaster-apps/${projectName}`);
  prompter.close();

  fs.mkdirSync(DEPLOY_DIR(), { recursive: true });
  const keyPath = DEPLOY_KEY();

  if (!fs.existsSync(keyPath)) {
    log("\nGenerating a dedicated deploy key for this project...");
    const kg = spawnSync("ssh-keygen", [
      "-t", "ed25519",
      "-f", keyPath,
      "-N", "",
      "-C", `pythonmaster-deploy-${projectName}`,
    ]);
    if (kg.status !== 0) fail("ssh-keygen failed");
  } else {
    log("\nReusing existing deploy key at .pythonmaster/deploy_key");
  }
  fs.chmodSync(keyPath, 0o600);

  const pubKey = fs.readFileSync(keyPath + ".pub", "utf8").trim();

  log("\nConnecting once with your normal login to install the deploy key.");
  log("You may be prompted for your password or passphrase now:\n");

  const installKey = spawn(
    "ssh",
    [
      "-p", port,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=15",
      `${user}@${host}`,
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
    ],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  installKey.stdin.write(pubKey + "\n");
  installKey.stdin.end();

  const installExit = await new Promise((resolve) => installKey.on("exit", resolve));
  if (installExit !== 0) {
    fail("could not install the deploy key on the server (see output above)");
  }

  const cfg = { host, user, port, remotePath, keyPath: path.relative(projectDir, keyPath) };

  log("\nVerifying the new key works...");
  const verify = spawnSync("ssh", sshBaseArgs(cfg, ["echo pythonmaster-ok"]));
  if (verify.status !== 0 || !String(verify.stdout).includes("pythonmaster-ok")) {
    fail("key-based login didn't work after setup. Run 'deploy setup' again.");
  }

  fs.writeFileSync(DEPLOY_CONFIG(), JSON.stringify(cfg, null, 2));
  log("\nSaved .pythonmaster/deploy.json — add .pythonmaster/ to .gitignore.");
  log("Setup complete. Run 'pythonmaster deploy' to ship this project.");
}

function transferProject(cfg, projectDir, remoteFullPath) {
  const excludes = [".venv", ".pythonmaster", "__pycache__", ".git", "app.db"];

  if (haveBinary("rsync")) {
    log("Uploading with rsync...");
    const args = [
      "-az", "--delete",
      "-e", `ssh -i ${cfg.keyPath} -p ${cfg.port} -o StrictHostKeyChecking=accept-new`,
      ...excludes.flatMap((e) => ["--exclude", e]),
      projectDir + "/",
      `${cfg.user}@${cfg.host}:${remoteFullPath}/`,
    ];
    const result = spawnSync("rsync", args, { stdio: "inherit" });
    if (result.status !== 0) fail("rsync upload failed");
    return;
  }

  // Fallback: tar the project locally (excluding dev-only paths), scp
  // the archive over, extract it remotely. Less efficient than rsync
  // (no delta/delete of removed files) but needs nothing beyond
  // standard `tar` + `scp`.
  log("rsync not found — falling back to tar + scp...");
  const tmpTar = path.join(require("os").tmpdir(), `pythonmaster-${Date.now()}.tar.gz`);
  const tarArgs = ["-czf", tmpTar, ...excludes.flatMap((e) => ["--exclude", e]), "-C", projectDir, "."];
  const tarResult = spawnSync("tar", tarArgs);
  if (tarResult.status !== 0) fail("tar failed to package the project");

  const scpArgs = [
    "-i", cfg.keyPath,
    "-P", String(cfg.port),
    "-o", "StrictHostKeyChecking=accept-new",
    tmpTar,
    `${cfg.user}@${cfg.host}:/tmp/pythonmaster-upload.tar.gz`,
  ];
  const scpResult = spawnSync("scp", scpArgs, { stdio: "inherit" });
  fs.unlinkSync(tmpTar);
  if (scpResult.status !== 0) fail("scp upload failed");

  const extractCmd =
    `rm -rf ${remoteFullPath} && mkdir -p ${remoteFullPath} && ` +
    `tar -xzf /tmp/pythonmaster-upload.tar.gz -C ${remoteFullPath} && ` +
    `rm -f /tmp/pythonmaster-upload.tar.gz`;
  const extractResult = spawnSync("ssh", sshBaseArgs(cfg, [extractCmd]), { stdio: "inherit" });
  if (extractResult.status !== 0) fail("failed to extract the project on the server");
}

function remoteBootstrapScript(remoteFullPath, serviceName) {
  // One heredoc'd bash script run over ssh — sets up the venv, installs
  // deps, picks (or reuses) a port, and runs the app.
  //
  // Prefers systemd --user (survives reboots, restarts on crash, no
  // root needed). Falls back to a plain nohup'd process if systemd
  // --user isn't usable on this server (confirmed to happen for real —
  // not every SSH target has a systemd user session/session bus
  // available, e.g. some minimal or container-based hosts). The
  // fallback's pidfile lives in ~/.pythonmaster/, NOT inside
  // remoteFullPath, specifically because transferProject wipes/replaces
  // remoteFullPath's contents on every deploy — a pidfile stored inside
  // it would be deleted before this script could use it to stop the
  // previous run, orphaning it.
  // .pythonmaster-port also deliberately lives in ~/.pythonmaster/, not
  // remoteFullPath, for the same reason as the pidfile above: both
  // transfer methods (rsync --delete, and the tar fallback's rm -rf)
  // make remoteFullPath's contents mirror the local project exactly on
  // every deploy, silently discarding any server-only file stored
  // inside it. A first version of this stored the port file inside
  // remoteFullPath, which quietly broke port persistence across every
  // redeploy — caught by actually running two deploys back to back
  // against a real local server and diffing the reported port.
  return `
set -e
mkdir -p ~/.pythonmaster
cd "${remoteFullPath}"
test -d .venv || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

PORT_FILE=~/.pythonmaster/${serviceName}.port
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
else
  PORT=$(.venv/bin/python -c "import socket;s=socket.socket();s.bind(('',0));print(s.getsockname()[1])")
  echo "$PORT" > "$PORT_FILE"
fi

if systemctl --user daemon-reload >/dev/null 2>&1; then
  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/${serviceName}.service <<UNIT
[Unit]
Description=PythonMaster app: ${serviceName}
After=network.target

[Service]
WorkingDirectory=${remoteFullPath}
Environment=PORT=$PORT
ExecStart=${remoteFullPath}/.venv/bin/python ${remoteFullPath}/main.py
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now ${serviceName}.service
  systemctl --user restart ${serviceName}.service
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
  echo "PYTHONMASTER_MODE=systemd"
else
  echo "systemd --user isn't usable on this server (no session bus) -- falling back to a plain background process."
  PIDFILE=~/.pythonmaster/${serviceName}.pid
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  nohup env PORT=$PORT "${remoteFullPath}/.venv/bin/python" "${remoteFullPath}/main.py" \
    > ~/.pythonmaster/${serviceName}.log 2>&1 < /dev/null &
  disown
  echo $! > "$PIDFILE"
  echo "PYTHONMASTER_MODE=nohup (won't restart on crash or reboot -- fix systemd --user on this server for that; see ~/.pythonmaster/${serviceName}.log)"
fi

sleep 1
echo "PYTHONMASTER_DEPLOYED_PORT=$PORT"
`.trim();
}

function nginxSnippet(domain, port, serviceName) {
  return [
    `# Generated by pythonmaster deploy — NOT installed automatically.`,
    `# Review it, then on the server:`,
    `#   sudo cp ${serviceName}.nginx.conf /etc/nginx/sites-available/${serviceName}`,
    `#   sudo ln -s /etc/nginx/sites-available/${serviceName} /etc/nginx/sites-enabled/`,
    `#   sudo nginx -t && sudo systemctl reload nginx`,
    ``,
    `server {`,
    `    listen 80;`,
    `    server_name ${domain};`,
    ``,
    `    location / {`,
    `        proxy_pass http://127.0.0.1:${port};`,
    `        proxy_set_header Host $host;`,
    `        proxy_set_header X-Real-IP $remote_addr;`,
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `        proxy_set_header X-Forwarded-Proto $scheme;`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

async function cmdDeploy() {
  const projectDir = process.cwd();
  readProjectManifest();
  const cfg = loadDeployConfig();
  cfg.keyPath = path.resolve(projectDir, cfg.keyPath);
  const projectName = path.basename(projectDir);
  const serviceName = `pythonmaster-${projectName}`;

  log(`Deploying to ${cfg.user}@${cfg.host}:${cfg.remotePath} ...`);

  log("Building...");
  log("Project packaged (Python needs no build step beyond its own files).");

  // Resolve remotePath (which may be relative, e.g. "pythonmaster-apps/x")
  // to an absolute path on the server. systemd's WorkingDirectory/ExecStart
  // require absolute paths, so everything downstream uses this, not the
  // raw string the user typed at 'deploy setup' time.
  const resolvePath = spawnSync(
    "ssh",
    sshBaseArgs(cfg, [`mkdir -p ${cfg.remotePath} && cd ${cfg.remotePath} && pwd`]),
    { encoding: "utf8" }
  );
  if (resolvePath.status !== 0) fail("could not create/resolve the remote directory");
  const remoteFullPath = resolvePath.stdout.trim();

  transferProject(cfg, projectDir, remoteFullPath);
  log("Uploaded.");

  log("Installing dependencies and starting the app...");
  const bootstrap = remoteBootstrapScript(remoteFullPath, serviceName);
  const runResult = spawnSync("ssh", sshBaseArgs(cfg, ["bash -s"]), {
    input: bootstrap,
    encoding: "utf8",
  });
  if (runResult.status !== 0) {
    process.stderr.write(runResult.stderr || "");
    fail("remote setup/start failed");
  }

  const portMatch = /PYTHONMASTER_DEPLOYED_PORT=(\d+)/.exec(runResult.stdout || "");
  const port = portMatch ? portMatch[1] : "(unknown — check the server)";

  log("Dependencies updated.");
  log("Application started.");
  log("Deployment complete.\n");

  log(`App is running on the server at 127.0.0.1:${port} (internal only).`);

  const prompter = makePrompter();
  const domain = await prompter.ask("Domain to point at this app (blank to skip nginx config)", "");
  prompter.close();
  if (domain) {
    const conf = nginxSnippet(domain, port, serviceName);
    const confPath = path.join(DEPLOY_DIR(), `${serviceName}.nginx.conf`);
    fs.writeFileSync(confPath, conf);
    log(`\nWrote an nginx reverse-proxy config to .pythonmaster/${serviceName}.nginx.conf`);
    log("It is NOT installed automatically (that needs root on your server).");
    log("The file itself contains the exact commands to install it.");
  }

  log("\nTo redeploy later, just run: pythonmaster deploy");
}

// --------------------------------------------------------------- main

function printHelp() {
  log("pythonmaster — Python/FastAPI backends for CDRCA");
  log("");
  log("  pythonmaster new <name>     scaffold a new python-runtime project");
  log("  pythonmaster run [--prod]   install deps and start it (reload on by default)");
  log("  pythonmaster add <package>  pip install + save to requirements.txt");
  log("  pythonmaster deploy setup   one-time: connect to your server, save config");
  log("  pythonmaster deploy         ship the current project to that server");
  log("  pythonmaster help           show this message");
}

function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "new":
      cmdNew(rest[0]);
      break;
    case "run":
      cmdRun(rest).catch((e) => fail(e.message));
      break;
    case "add":
      cmdAdd(rest[0]);
      break;
    case "deploy":
      if (rest[0] === "setup") {
        cmdDeploySetup().catch((e) => fail(e.message));
      } else {
        cmdDeploy().catch((e) => fail(e.message));
      }
      break;
    case "help":
    case undefined:
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      fail(`unknown command '${command}'. Try 'pythonmaster help'.`);
  }
}

main();
