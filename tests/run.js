// Runs every test file in this directory as its own process.
// Usage: node tests/run.js
//
// Set CDRCA_RUNTIME_PATH to <checkout of MrGrimJoe/cdrca-ready-for-the-
// real-world>/cli/src/templates/cdrca-runtime to also run the real-
// tokenizer assertions in plugin.test.js and the full pipeline test in
// integration.test.js. Without it, those two print what they skipped
// and why, and everything else still runs.
const { execFileSync } = require("child_process");
const path = require("path");

const files = ["plugin.test.js", "cli.test.js", "deploy.test.js", "integration.test.js"];
let anyFailed = false;

for (const file of files) {
  console.log(`\n--- ${file} ---`);
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, file)], {
      encoding: "utf8",
      env: process.env,
    });
    process.stdout.write(output);
  } catch (err) {
    anyFailed = true;
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
  }
}

if (anyFailed) {
  console.log("\nSome test files reported failures — see above.");
  process.exitCode = 1;
} else {
  console.log("\nAll test files passed.");
}
