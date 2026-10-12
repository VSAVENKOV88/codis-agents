#!/usr/bin/env node
'use strict';
// Runs every test: tests/*.test.js with node, tests/*.test.sh with zsh; each is judged by its exit code.
// usage: node tests/run.js [substring...]   (filter by file name)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filters = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter((f) => /\.test\.(js|sh)$/.test(f))
  .filter((f) => !filters.length || filters.some((s) => f.includes(s))).sort();
const failed = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(f.endsWith('.sh') ? 'zsh' : process.execPath, [path.join(__dirname, f)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) console.log(`pass ${f} (${s} s) - ${(r.stdout.trim().split('\n').pop() || '').trim()}`);
  else { failed.push(f); console.log(`FAIL ${f} (${s} s, exit ${r.status})\n${r.stdout}${r.stderr}`); }
}
console.log(`\n${files.length - failed.length} of ${files.length} test files passed${failed.length ? '; failed: ' + failed.join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
