#!/usr/bin/env node
'use strict';
// Runs the tester's guard tests/fixtures/corpus-sync-rsync/checks-run.js as part of the suite: scripts/corpus-sync.js
// with the real rsync at both ends, only ssh faked. Cells: T-1 (C-4, C-13) a file changed with the same size and mtime
// reaches the donor and the donor ends complete (rsync's quick check must not skip it); T-2 odd names; T-4 a link
// outside; T-5 (C-10) copy <name> over an existing copy equals the donor.
const path = require('path');
const { spawnSync } = require('child_process');

const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'corpus-sync-rsync', 'checks-run.js')], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
