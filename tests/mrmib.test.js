// Checks the committed CDRCA package, pythonmaster-<version>.mrmib, in the repo
// root -- with nothing but Node, no cdrca binary needed.
//
// A .mrmib is a gzip'd tar (format: cli/src/mrmib.rs in the main CDRCA repo).
// The first entry is .mrmib-meta.json; its payloadSha256 covers every byte of
// the tar stream after that entry. These tests fail if plugin.js or cdrca.json
// changed without the .mrmib being rebuilt, and if the archive is corrupted.
//
// To rebuild it (from the repo root):   cdrca pack --out pythonmaster-<version>.mrmib

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { test, report, assert } = require("./harness");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "cdrca.json"), "utf8"));
const file = path.join(root, `${manifest.name}-${manifest.version}.mrmib`);

// Minimal tar reader: returns [{ name, data, end }] where `end` is the offset
// just past the entry (data padded to 512).
function readTar(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
    const dataStart = off + 512;
    const end = dataStart + Math.ceil(size / 512) * 512;
    entries.push({ name, data: buf.subarray(dataStart, dataStart + size), end });
    off = end;
  }
  return entries;
}

test(`${path.basename(file)} exists for the version in cdrca.json`, () => {
  assert.ok(
    fs.existsSync(file),
    `missing ${path.basename(file)} -- run \`cdrca pack --out ${path.basename(file)}\` from the repo root`
  );
});

const tar = fs.existsSync(file) ? zlib.gunzipSync(fs.readFileSync(file)) : Buffer.alloc(0);
const entries = readTar(tar);
const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

test("first entry is .mrmib-meta.json, and it names this package and version", () => {
  assert.strictEqual(entries[0] && entries[0].name, ".mrmib-meta.json");
  const meta = JSON.parse(entries[0].data.toString("utf8"));
  assert.strictEqual(meta.mrmibFormatVersion, 1);
  assert.strictEqual(meta.manifest.name, manifest.name);
  assert.strictEqual(meta.manifest.version, manifest.version);
});

test("payloadSha256 matches every byte after the meta entry (archive is intact)", () => {
  const meta = JSON.parse(entries[0].data.toString("utf8"));
  const actual = "sha256-" + crypto.createHash("sha256").update(tar.subarray(entries[0].end)).digest("hex");
  assert.strictEqual(actual, meta.payloadSha256);
});

test("packs exactly cdrca.json and plugin.js, byte-identical to the repo's copies", () => {
  const payload = entries.slice(1).map((e) => e.name).sort();
  assert.deepStrictEqual(payload, ["cdrca.json", "plugin.js"]);
  assert.ok(
    byName["plugin.js"].data.equals(fs.readFileSync(path.join(root, "plugin.js"))),
    "plugin.js changed since the .mrmib was built -- rebuild it with `cdrca pack`"
  );
  assert.ok(
    byName["cdrca.json"].data.equals(fs.readFileSync(path.join(root, "cdrca.json"))),
    "cdrca.json changed since the .mrmib was built -- rebuild it with `cdrca pack`"
  );
});

report();
