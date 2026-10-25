#!/usr/bin/env node
'use strict';
// Runs the tester's guard tests/fixtures/guards-remote-tester/checks-run.js as part of the suite: the remote full run
// end to end through a fake ssh. Cells: T-1 the guards the runner names for this machine never run here as code; T-2 a
// lock file held as a link in the commit is refused before the dependency cache gets its target; T-3 a worktree name
// with a space is 78 before ssh; T-4 .ENV.local in the donor copy is refused, a tracked .env.example is not; T-5 --local
// with the remote key runs here; T-6 a job that writes rc and exits between the poll's read of rc and its process check
// is done with that rc, not vanished.
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib'); // the fixture and its children never see the real machine file (machine.test.js H1)

const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'guards-remote-tester', 'checks-run.js')], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
