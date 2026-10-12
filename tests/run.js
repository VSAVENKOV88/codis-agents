#!/usr/bin/env node
'use strict';
// Runs every test: tests/*.test.js with node, tests/*.test.sh with zsh; each is judged by its exit code.
// Without zsh in PATH (a Linux box, a CI image) the *.test.sh files are skipped and the *.test.js files skip their zsh
// checks; every skip is shown in the file's line and in the final tally, never silently.
// usage: node tests/run.js [substring...]   (filter by file name)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { has } = require('./lib');

const filters = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter((f) => /\.test\.(js|sh)$/.test(f))
  .filter((f) => !filters.length || filters.some((s) => f.includes(s))).sort();
const failed = [], skipped = [], partial = [];
const zsh = has('zsh');
for (const f of files) {
  if (f.endsWith('.sh') && !zsh) { skipped.push(f); console.log(`skip ${f} (0.0 s) - skipped: zsh not found`); continue; }
  const t0 = Date.now();
  const r = spawnSync(f.endsWith('.sh') ? 'zsh' : process.execPath, [path.join(__dirname, f)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  const last = (r.stdout.trim().split('\n').pop() || '').trim();
  if (r.status === 0 && /skipped: /.test(last)) partial.push(f);
  if (r.status === 0) console.log(`pass ${f} (${s} s) - ${last}`);
  else { failed.push(f); console.log(`FAIL ${f} (${s} s, exit ${r.status})\n${r.stdout}${r.stderr}`); }
}
console.log(`\n${files.length - failed.length - skipped.length} of ${files.length} test files passed`
  + (skipped.length ? `; ${skipped.length} skipped: zsh not found (${skipped.join(', ')})` : '')
  + (partial.length ? `; some checks skipped in ${partial.join(', ')}${zsh ? '' : ' (skipped: zsh not found)'}` : '')
  + (failed.length ? '; failed: ' + failed.join(', ') : ''));
process.exit(failed.length ? 1 : 0);
