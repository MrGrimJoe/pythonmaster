// Tiny, dependency-free test harness (copied from cdrca-reactive-state's
// tests/harness.js -- same convention, kept identical on purpose so
// anyone familiar with one CDRCA plugin's tests recognizes the other).
// Run with:
//   node tests/run.js
//
// test() also accepts an async fn. Tests run strictly SEQUENTIALLY, each
// chained onto the end of the previous one, not fired in parallel --
// cli.test.js and deploy.test.js spawn real child processes and touch
// real files on disk, and running them concurrently would let one
// test's setup/teardown race another's. Call sites are unchanged
// (`test("name", () => { ... })`, no `await` needed) -- report() awaits
// the full chain before printing.

const assert = require("assert");

let pass = 0;
let fail = 0;
const failures = [];
let chain = Promise.resolve();

function test(name, fn) {
  chain = chain.then(fn).then(
    () => {
      pass++;
    },
    (err) => {
      fail++;
      failures.push({ name, err });
    }
  );
}

async function report() {
  await chain;
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (failures.length) {
    for (const { name, err } of failures) {
      console.log(`\nFAIL: ${name}`);
      console.log(err && err.stack ? err.stack : err);
    }
    process.exitCode = 1;
  }
}

module.exports = { test, report, assert };
