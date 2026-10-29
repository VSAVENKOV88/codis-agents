#!/usr/bin/env node
'use strict';
// testerWritable has no JS default (coordinator decision U2b v.4): the paths the tester may change are the project's.
// - E1 no key -> config.js json gives null, no built-in list;
// - E2 no key (or an empty list) -> role-chain stops the task before any agent, with the reason;
// - E3 role-diff-check.js --role tester without --allow -> ok=false, error "no testerWritable", no built-in list;
// - E4 a project list (pytest) -> its guards pass, product code is offending;
// - E5 an explicit key (the example config, as a project that sets the key) -> unchanged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/config');
const D = require('../scripts/role-diff-check');
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };

// E1
const c0 = C.resolve(base);
ok('E1 no testerWritable -> null, no JS default', !c0.errors.length && c0.config.testerWritable === null, JSON.stringify(c0.config.testerWritable));
ok('E1 config.js exports no tester default', !('TESTER_DEFAULT' in C) && !('TESTER_DEFAULT' in D));
const src = ['scripts/config.js', 'scripts/role-diff-check.js', 'workflows/role-chain.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
ok('E1 no built-in tester list left in the code', !src.includes("'-run\\\\.(js|mjs|cjs)$'") && !/TESTER_DEFAULT/.test(src));
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'codis-agents.example.json'), 'utf8'));
const c5 = C.resolve(Object.assign({}, ex, { $schema: undefined }));
ok('E5 an explicit testerWritable is kept as given', JSON.stringify(c5.config.testerWritable) === JSON.stringify(ex.testerWritable) && ex.testerWritable.length === 2, JSON.stringify(c5.config.testerWritable));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
ok('README: testerWritable has no default and is required by the role chain', /\| `testerWritable` \|[^\n]*no default[^\n]*role chain/.test(readme) && !/\| `testerWritable` \|[^\n]*\(default:/.test(readme));

// E3, E4
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-writable-')));
const git = (...a) => spawnSync('git', ['-C', tmp, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
try {
  git('init', '-q'); fs.writeFileSync(path.join(tmp, 'app.py'), 'x = 1\n'); git('add', 'app.py'); git('commit', '-q', '-m', 'base');
  const since = git('rev-parse', 'HEAD').stdout.trim();
  fs.mkdirSync(path.join(tmp, 'tests'));
  fs.writeFileSync(path.join(tmp, 'tests', 'test_x.py'), 'def test_x(): pass\n');
  fs.writeFileSync(path.join(tmp, 'a-run.js'), '\n');
  git('add', 'tests/test_x.py', 'a-run.js'); git('commit', '-q', '-m', 'tester');
  let r = D.check({ wt: tmp, since, role: 'tester' });
  ok('E3 tester without --allow -> ok=false, error "no testerWritable"', r.ok === false && /no testerWritable/.test(r.error || ''), JSON.stringify(r));
  r = D.check({ wt: tmp, since, role: 'tester', allow: [] });
  ok('E3 tester with an empty allow list -> ok=false, error "no testerWritable"', r.ok === false && /no testerWritable/.test(r.error || ''), JSON.stringify(r));
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-diff-check.js'), '--wt', tmp, '--since', since, '--role', 'tester'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(cli.stdout); } catch { /* */ }
  ok('E3 CLI without --allow -> JSON with the error, exit 1', cli.status === 1 && j && /no testerWritable/.test(j.error || ''), cli.stdout + cli.stderr);
  const PY = ['(^|/)tests/test_[^/]*\\.py$'];
  r = D.check({ wt: tmp, since, role: 'tester', allow: PY });
  ok('E4 pytest list: tests/test_x.py allowed, a-run.js (not in the list) offending', !r.ok && JSON.stringify(r.offending) === '["a-run.js"]', JSON.stringify(r));
  fs.writeFileSync(path.join(tmp, 'app.py'), 'x = 2\n');
  r = D.check({ wt: tmp, since, role: 'tester', allow: PY.concat(['-run\\.js$']) });
  ok('E4 pytest list: a changed app.py is offending', !r.ok && JSON.stringify(r.offending) === '["app.py"]', JSON.stringify(r));
  r = D.check({ wt: tmp, since, role: 'reviewer' });
  ok('reviewer: still needs no list (changes nothing)', !r.ok && r.offending.length === 3 && !r.error, JSON.stringify(r));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// E2: role-chain with fake agents (as tests/role-chain.test.js)
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', protectedBranches: ['main'], slots: { lockDir: '/slots' } };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix' };
async function run(cfg, task = T) {
  const calls = [];
  const agent = async (prompt, opts) => { calls.push(opts.label); return opts.label.startsWith('pre:') ? { ok: true, problems: [], blockingQuestions: [] } : null; };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] });
  return { r: res[0], calls };
}
(async () => {
  for (const [name, cfg] of [['no key', CFG], ['null', Object.assign({}, CFG, { testerWritable: null })], ['an empty list', Object.assign({}, CFG, { testerWritable: [] })]]) {
    const x = await run(cfg);
    ok(`E2 testerWritable ${name} -> stopped before any agent, the reason names testerWritable`,
      x.r && x.r.status === 'stopped' && !x.calls.length && /testerWritable is not set: the paths the tester may change/.test(JSON.stringify(x.r.problems || [])), JSON.stringify(x));
  }
  const x = await run(CFG, Object.assign({}, T, { mode: 'light' }));
  ok('E2 light mode too (no tester, but fixes for docs are judged by the list) -> stopped before any agent', x.r.status === 'stopped' && !x.calls.length, JSON.stringify(x));
  let y;
  try { y = await run(Object.assign({}, CFG, { testerWritable: ['-run\\.js$'] })); } catch (e) { y = { err: e.message }; }
  ok('E5 with testerWritable the chain starts (the preconditions agent runs)', y.calls && y.calls[0] === 'pre:x', JSON.stringify(y));
  done();
})();
