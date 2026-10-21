'use strict';
// Tiny assertion helper shared by the tests: ok(name, condition, detail); skip(name, reason) for a check the machine
// cannot run (shown, never silent); done() prints the tally and sets the exit code. has(cmd) - cmd is an executable in PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
// No test reads the real machine file (scripts/config.js, U2a-1 H1): every test, and every child it starts with this
// environment, sees an empty XDG_CONFIG_HOME of its own and no CODIS_AGENTS_MACHINE; a test that wants a machine file
// names a temporary one. tests/run.js requires this file too, so the *.test.sh it starts inherit the same.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-xdg-'));
process.env.XDG_CONFIG_HOME = XDG;
delete process.env.CODIS_AGENTS_MACHINE;
process.on('exit', () => { try { fs.rmSync(XDG, { recursive: true, force: true }); } catch { /* best effort */ } });
let pass = 0, fail = 0;
const skips = new Map();
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' - ' + d : '')); } };
const skip = (n, reason) => { skips.set(reason, (skips.get(reason) || 0) + 1); console.log('  skip ' + n + ' - skipped: ' + reason); };
const has = (cmd) => (process.env.PATH || '').split(path.delimiter).filter(Boolean).some((d) => {
  try { const f = path.join(d, cmd); fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
});
const done = () => {
  const s = [...skips].map(([r, k]) => `${k} skipped: ${r}`).join(', ');
  console.log(`\n${pass} passed, ${fail} failed${s ? ', ' + s : ''}`);
  process.exit(fail ? 1 : 0);
};
module.exports = { ok, skip, has, done };
