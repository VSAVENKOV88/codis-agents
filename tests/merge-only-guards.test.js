#!/usr/bin/env node
'use strict';
// p-0414, a tail of the review of p-merge-docs ("what is not in the diff", 1): a file that matches mergeOnlyFiles and
// guardFiles at once (docs/** with guards under docs/) is a guard, not docs: a conflict, a hand resolution or a hand
// edit of it keeps the selection. scripts/merge-only.js takes the project's guardFiles as --guards <glob>... (the
// workflow passes them); without --guards it uses the default of the config key (*-run.js, *-run.mjs, *-run.cjs).
// usage: node tests/merge-only-guards.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-only.js');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-merge-only-guards-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

let n = 0;
// The arc and the task both change `file`; the programmer merges the arc and resolves it by hand (or edits `extra`).
function scene(file, { conflict = true, extra = null } = {}) {
  const d = path.join(tmp, `r${++n}`);
  fs.mkdirSync(d);
  const g = (...a) => { const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: ENV }); if (r.status !== 0 && a[0] !== 'merge') throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return (r.stdout || '').trim(); };
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  const commit = (files, msg) => { for (const [f, s] of Object.entries(files)) w(f, s); g('add', '--', ...Object.keys(files)); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  g('init', '-q', '-b', 'main');
  commit({ [file]: 'one\ntwo\nthree\n', 'docs/a.md': 'a\n' }, 'base');
  g('checkout', '-q', '-b', 'arc');
  commit({ [file]: 'one\nARC\nthree\n' }, 'arc');
  g('checkout', '-q', '-b', 'task', 'main');
  const before = commit(conflict ? { [file]: 'one\nTASK\nthree\n' } : { 'docs/a.md': 'task\n' }, 'task');
  g('merge', '-q', '--no-commit', '--no-ff', 'arc');
  const res = {};
  if (conflict) res[file] = 'one\nTASK and ARC\nthree\n';
  if (extra) res[extra] = 'edited by hand\n';
  for (const [f, s] of Object.entries(res)) w(f, s);
  if (Object.keys(res).length) g('add', '--', ...Object.keys(res));
  g('commit', '-q', '--no-edit');
  return { d, before, head: g('rev-parse', 'HEAD') };
}
function run(s, extra) {
  const x = spawnSync(process.execPath, [SCRIPT, s.before, s.head, '--base', 'arc', '--wt', s.d, '--files', 'docs/**', ...extra], { encoding: 'utf8', env: ENV });
  let j = null; try { j = JSON.parse(x.stdout); } catch { /* not JSON */ }
  return { rc: x.status, j, out: `${x.status} ${x.stdout} ${x.stderr}` };
}

// G1: a docs-only conflict still skips (the control)
let s = scene('docs/guide.md');
let x = run(s, []);
ok('G1. conflict in docs/guide.md (docs/**, not a guard) -> exit 0, merge only', x.rc === 0 && x.j && x.j.mergeOnly === true, x.out);

// G2: a conflict in a guard under docs/ that matches docs/** and the default guardFiles (*-run.js) -> the selection
s = scene('docs/checks/links-run.js');
x = run(s, []);
ok('G2. conflict in docs/checks/links-run.js (docs/** and the default *-run.js) -> exit 1, not merge only',
  x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);
ok('G2. the reason names the guard and guardFiles', x.j && /docs\/checks\/links-run\.js/.test(x.j.reason || '') && /guardFiles/.test(x.j.reason || ''), x.out);
for (const ext of ['mjs', 'cjs']) {
  s = scene(`docs/t-run.${ext}`);
  x = run(s, []);
  ok(`G2. the default guardFiles covers *-run.${ext} too -> exit 1`, x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);
}

// G3: the project's own guardFiles (--guards) replace the default
s = scene('docs/spec/cases.md');
x = run(s, ['--guards', 'docs/spec/*.md']);
ok('G3. --guards docs/spec/*.md: a conflict in docs/spec/cases.md is a guard -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false && /guardFiles/.test(x.j.reason || ''), x.out);
s = scene('docs/checks/links-run.js');
x = run(s, ['--guards', 'test_*.py']);
ok('G3. --guards test_*.py replaces the default: docs/checks/links-run.js is docs again -> exit 0', x.rc === 0 && x.j && x.j.mergeOnly === true, x.out);
x = run(s, ['--guards']);
ok('G3. --guards without a value -> exit 2', x.rc === 2 && x.j && !!x.j.error, x.out);

// G4: a hand edit (no conflict) of a guard under docs/ in the merge commit -> the selection
s = scene('docs/guide.md', { extra: 'docs/checks/links-run.js' });
x = run(s, []);
ok('G4. docs conflict + a hand edit of docs/checks/links-run.js in the merge -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);
// a clean merge (nothing by hand) stays merge only: a guard the arc brought is the arc's
s = scene('docs/checks/links-run.js', { conflict: false });
x = run(s, []);
ok('G4. a clean merge whose arc changed docs/checks/links-run.js -> exit 0 (the arc\'s, not by hand)', x.rc === 0 && x.j && x.j.mergeOnly === true, x.out);

// W: the workflow passes the project's guardFiles to merge-only.js
const src = read('workflows/role-chain.js');
const m = /const mergeCmd = [^\n]*/.exec(src);
ok('W. mergeCmd passes guardFiles as --guards', !!m && /--guards/.test(m[0]) && /guardFiles|GUARD_GLOBS/.test(m[0]), m && m[0]);

// R: the README names it
const flat = read('README.md').replace(/\s+/g, ' ');
ok('R. README: merge-only.js treats a file of guardFiles as a guard, not docs', /merge-only\.js` \| `<before>[^|]*--guards/.test(flat) && /guardFiles[^|]*not docs|guard, not docs/.test(flat));
done();
