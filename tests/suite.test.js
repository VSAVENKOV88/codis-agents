#!/usr/bin/env node
'use strict';
// Every check in tests/ is part of the suite: a file with a #! line (an entry point) other than the runner itself is
// named *.test.js or *.test.sh, the pattern tests/run.js picks up. Why: a tester guard named slots-u1a-run.js (the
// guard name of a project) was never run by `npm test`, so its cells (kill -9 of a holder, the reverse direction of
// the exclusive lock, stdin, the command's own 75, refusal 73) were guarded by a test nobody ran.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const RUN = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
ok('tests/run.js picks up *.test.js and *.test.sh', RUN.includes(String.raw`/\.test\.(js|sh)$/`));
const loose = fs.readdirSync(__dirname).filter((f) => f !== 'run.js' && fs.statSync(path.join(__dirname, f)).isFile())
  .filter((f) => fs.readFileSync(path.join(__dirname, f), 'utf8').startsWith('#!'))
  .filter((f) => !/\.test\.(js|sh)$/.test(f));
ok('every entry point in tests/ is run by tests/run.js', loose.length === 0, 'not run: ' + loose.join(' '));
done();
