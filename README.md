# pythonmaster

Python/FastAPI backend integration for CDRCA. Write normal Python, get a
real running FastAPI app connected to a CDRCA-style project, deployed to
your own server — without hand-writing venv/uvicorn/systemd/nginx setup,
and without CDRCA restricting what Python itself can do.

This package is **plug-and-play with the base CDRCA repo/CLI as it
exists today** — it does not modify CDRCA's compiler, CLI, or any of its
existing plugins. It works alongside them.

## Why two pieces

CDRCA's real transpiler-plugin sandbox (`plugin.js`, loaded by
`cdrca install pythonmaster`) has no `fs` or `child_process` access, and
there is currently no plugin hook for "before `cdrca new`/`cdrca run`
runs" (verified against `docs/PLUGIN-PERMISSIONS.md`'s own list of real
hooks — they're all parse/transpile-phase hooks). So this package ships
as two cooperating things instead of pretending one sandboxed file can
do both jobs:

1. **`plugin.js`** — a normal CDRCA transpiler plugin (`type: "plugin"`,
   `uses: [["syntax","customRule"]]`, `permissions: []`). Installed the
   normal way: `cdrca install pythonmaster`. Adds one statement to the
   language — `pythonapi getUsers = GET "/api/users"` — which compiles
   to a `fetch()` wrapper on `window.CDRCA.pythonmaster`. It never
   touches the filesystem or spawns a process, which is why it's allowed
   to declare `permissions: []`.

2. **`bin/pythonmaster.js`** — a normal, unsandboxed Node CLI that does
   project scaffolding, running, dependency management, and deployment.
   Installed and run separately from the CDRCA binary, the same way
   CDRCA's own `npm/bin/cdrca.js` wrapper adds convenience commands in
   front of the real compiled CLI.

## Install

```
npm install -g ./pythonmaster
```

This gives you the `pythonmaster` command. If you also want `pythonapi`
syntax available inside a CDRCA project, additionally run
`cdrca install pythonmaster` inside that project.

## Local development

```
pythonmaster new myapp
cd myapp
pythonmaster run
```

`pythonmaster new myapp` creates:

```
myapp/
├── cdrca.json          { "runtime": "python", "entry": "main.py" }
├── main.py             FastAPI app — owns the whole server
├── db.py               SQLite helper (create/find/find_by_id/update/delete)
├── index.html          minimal frontend, calls /api/users
├── requirements.txt    fastapi + uvicorn
└── assets/
    └── style.css
```

`pythonmaster run`:
1. Creates a project-local `.venv/` the first time you run it.
2. Installs `requirements.txt` (auto-reinstalls if you edit it).
3. Picks a free port, prints it as `CDRCA_PORT=<port>`.
4. Starts `main.py` with **hot reload on by default** (uvicorn's
   `--reload`, watching your files). Run `pythonmaster run --prod` to
   start it without reload, the same way it'll run in production.

`main.py` *is* the server — no reverse proxy, no second process. It
serves `index.html`, `assets/`, and your API routes directly.

## Adding dependencies

```
pythonmaster add <package>
```

Installs the package into `.venv` and pins the resolved version into
`requirements.txt` (same format `pip freeze` uses), so re-running
`pythonmaster run` elsewhere reproduces the exact version. You can also
just edit `requirements.txt` by hand — `pythonmaster run` picks up
changes automatically.

## The database layer

`db.py` is deliberately not an ORM — `create` / `find` / `find_by_id` /
`update` / `delete` against plain SQL tables you define with
`db.init_db("CREATE TABLE IF NOT EXISTS ...")`. `main.py`'s example
`/api/users` routes use it, backed by a real SQLite file (`app.db`,
created next to `main.py`, not shipped to your server on deploy). Swap
it for Postgres/SQLAlchemy/anything else — nothing outside `db.py`
needs to change.

## Deployment

You provide the server (a VPS, a home server, anything reachable over
SSH). pythonmaster never provides hosting, domains, or DNS, and never
sends your credentials anywhere but that server.

### One-time setup

```
pythonmaster deploy setup
```

Asks for the server's host, SSH username, port, and a remote directory.
Then:

1. Generates a dedicated ed25519 keypair for **this project only**
   (`.pythonmaster/deploy_key`).
2. Connects once with your normal login (password or existing key) —
   this is the only time your password is used, and it's typed directly
   into SSH's own prompt. **pythonmaster's code never sees or stores
   it.** That connection appends the new dedicated public key to the
   server's `~/.ssh/authorized_keys`.
3. Verifies the new key works on its own.
4. Saves the non-secret connection details to `.pythonmaster/deploy.json`.

Add `.pythonmaster/` to `.gitignore` — it holds a private key.

To revoke access later, remove the matching line from
`~/.ssh/authorized_keys` on the server; nothing central to reset.

### Deploying

```
pythonmaster deploy
```

1. Uploads the project (via `rsync` if you have it installed, otherwise
   falling back to `tar` + `scp`) — excluding `.venv`, `.pythonmaster`,
   `__pycache__`, `.git`, and `app.db`.
2. Resolves your remote directory to an absolute path on the server
   (needed because `systemd` unit files require absolute paths).
3. Creates/updates a venv on the server and installs `requirements.txt`.
4. Picks a free internal port the first time (persisted in
   `.pythonmaster-port` on the server so redeploys reuse it — this is
   how multiple apps on one server end up on different ports without
   you managing that by hand).
5. Writes and enables a **systemd `--user` service** (`Restart=always`,
   starts on boot via `loginctl enable-linger`) so the app survives
   crashes and reboots without needing root.
6. Optionally writes an nginx reverse-proxy config for a domain you
   give it, to `.pythonmaster/<service>.nginx.conf`. **This file is not
   installed automatically** — installing it means writing to
   `/etc/nginx/`, which needs root on your server, and pythonmaster
   doesn't assume passwordless sudo. The file's own header comment has
   the exact 3 commands to run once. After that, DNS is yours to point
   at the server the normal way.

Re-running `pythonmaster deploy` later just updates and restarts the
same service.

### What this deliberately doesn't do

- No isolation stronger than a plain Linux user account and a systemd
  service — fine for "my own server, my own apps," not yet meant for
  hosting untrusted third-party code on shared infrastructure. If you
  need that later, put each deploy in a container; the upload/systemd
  steps here would need to change accordingly.
- No automatic root/sudo actions on your server, ever — deliberately,
  even where it costs a manual step (the nginx install command).
- No central pythonmaster/CDRCA service in the loop anywhere. Every
  command in this section talks directly, over SSH, to the one server
  you configured.

## What's still not built

- **Mixing a full `.cdrca`-compiled frontend (Quark / Reactive State)
  with this backend in one running process** — that needs a real proxy
  layer between CDRCA's own dev server and a running FastAPI process.
  The current design deliberately keeps the frontend plain HTML/JS so
  Python can own the whole server with zero extra moving parts.
- **A `runtime: "python"` branch inside CDRCA's own `cdrca run`/
  `cdrca deploy`** — not built here on purpose, since this package
  doesn't modify CDRCA's CLI. `pythonmaster run`/`deploy` are the
  equivalent commands until/unless that's added upstream.
- Container-based isolation for multi-tenant deploys (see above).

## Tests

```
node tests/run.js
```

Runs, always, with no external checkout needed:
- `plugin.test.js` — unit tests for `pythonapi`, against a hand-built fake token stream
- `cli.test.js` — real end-to-end local dev: scaffolds a project, runs it for real, hits `GET`/`POST /api/users` and static assets over real HTTP, runs `add`
- `deploy.test.js` — deploy fails cleanly (no hang) without config; the interactive setup prompts are correctly consumed end to end; a real ed25519 key gets generated with the right permissions

Additionally, if `CDRCA_RUNTIME_PATH` is set to
`<checkout of MrGrimJoe/cdrca-ready-for-the-real-world>/cli/src/templates/cdrca-runtime`:
- `plugin.test.js` re-runs its assertions through the **real** `Tokenizer.js` (not just the hand-built fake one) — this is how `cdrca-reactive-state`'s own tests caught a real tokenizer bug, so it's worth the extra pass here too
- `integration.test.js` stages `pythonmaster/plugin.js` exactly the way `cdrca install` would (`Plugins/pythonmaster/plugin.js` + `plugins.json`), loads it through the **real** plugin host and transpiler (not a mock), and — using `jsdom` if installed — actually `eval`s the generated output and confirms `pythonmaster.getUsers()` really calls `fetch("/api/users", { method: "GET" })`. This test is a close copy of `cdrca-reactive-state`'s own `tests/integration.test.js`, including the same small set of transpiler patches (JS_BLOCK support, a token-joining fix, an ASI/semicolon fix) that any JS_BLOCK-emitting plugin needs — see that file's comments for why each one exists.

### GitHub Actions

`.github/workflows/test.yml` has two jobs:

- **`test`** — checks out this repo and, separately,
  `MrGrimJoe/cdrca-ready-for-the-real-world`, then runs `tests/run.js`
  with `CDRCA_RUNTIME_PATH` pointed at the second checkout — so CI runs
  the real integration test against the real transpiler, not a mock.
- **`deploy-e2e`** — a genuine SSH deploy, start to finish, against a
  throwaway local user on the runner (`deploytest@127.0.0.1`): installs
  a real `sshd`, uses `sshpass` to stand in for a human typing a
  password once (the same one-time bootstrap real usage requires — the
  password is never seen by pythonmaster's own code either way), runs
  the real `deploy setup` and `deploy`, then curls the deployed app to
  confirm it actually responds, and redeploys once more to confirm the
  port is reused. On any failure it dumps `sshd`'s log, the deployed
  service's full status/journal, `loginctl show-user`, and the generated
  remote files — everything needed to diagnose a CI failure without
  re-running it. This job needs a real VM with `systemd`, which is why
  it's a GitHub Actions job and not something this package can verify
  during local development (see the note below).

### What was actually run, not just written, while building this

Everything above was genuinely executed while building this package —
including a full local reproduction of the `deploy-e2e` job's core idea
(a real local `sshd`, a throwaway user, `sshpass` standing in for a
typed password, a real `deploy setup` + `deploy` against
`127.0.0.1`) — and it caught two real bugs before they shipped:

1. **The interactive setup prompts silently dropped input.** Creating a
   fresh `readline.Interface` per question loses sync when stdin is
   piped rather than a real TTY — only the first answer survived; later
   ones hung or came back empty. Fixed by consuming the interface via
   its async iterator instead. `deploy.test.js` now regression-tests
   this directly.
2. **Port "persistence" across redeploys was actually broken**, because
   both transfer methods (`rsync --delete`, and the `tar` fallback's
   `rm -rf`) make the remote project directory mirror the local one
   exactly on every deploy — silently deleting any server-only file
   stored inside it, including the port file. Fixed by moving both the
   port file and the fallback pidfile to `~/.pythonmaster/`, outside the
   directory that gets wiped/resynced. Verified by actually redeploying
   twice against a real local server and diffing the reported port.

The one thing that genuinely could not be verified locally: this
sandbox has no `systemd` running as PID 1 and no `logind`, so
`systemctl --user` fails here with "Failed to connect to bus" —
discovered by actually hitting it, not by inspection. Real,
non-containerized servers (and GitHub's own `ubuntu-latest` runners)
are full VMs that do have this, which is exactly why `deploy` now
**detects this and falls back automatically** to a plain background
process (logged clearly as `PYTHONMASTER_MODE=nohup`, with a note that
it won't survive a crash or reboot the way the `systemd` path does) —
and why `deploy-e2e` runs specifically on a GitHub-hosted runner, to get
one real confirmation that the `systemd` path itself works somewhere
this sandbox can't provide.
