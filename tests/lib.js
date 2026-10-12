'use strict';
// Tiny assertion helper shared by the tests: ok(name, condition, detail); done() prints the tally and sets the exit code.
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' - ' + d : '')); } };
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
module.exports = { ok, done };
