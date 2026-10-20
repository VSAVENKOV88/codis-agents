#!/usr/bin/env node
'use strict';
// Tester guard of task U1a (slot locks without lockf): runs tests/fixtures/slots-u1a/checks.zsh with zsh and is judged
// by its exit code. Cases: kill -9 of a holder hands the slot to the waiter, the exclusive lock is seen by the project
// runner's flock(2) probe, standard input reaches the command, the command's own 75 is not a lost race, no temporary
// file is a refusal (73). usage: node tests/slots-u1a-run.js
const path = require('path');
const { spawnSync } = require('child_process');
const { has } = require('./lib');

if (!has('zsh')) { console.log('skipped: zsh not found'); process.exit(0); }
const r = spawnSync('zsh', [path.join(__dirname, 'fixtures', 'slots-u1a', 'checks.zsh')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.error) console.log(`FAIL: ${r.error.message}`);
process.exit(r.status === 0 ? 0 : 1);
