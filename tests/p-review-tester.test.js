#!/usr/bin/env node
'use strict';
// Task p-review, the tester's cells (what tests/p-review.test.js leaves open):
//   T1. With security the reviewers' git post-check starts only after BOTH reviewers have finished: a security reviewer
//       that finishes later than the reviewer (and could still change the worktree) is never outrun by the post-check.
//   T2. With security a failed reviewers' post-check is repeated once (diff:<key>:reviewer#retry) and the repeat decides.
//   T3. scripts/role-post-check.js for real (git repository, a real process in the worktree, a fake docker CLI on PATH):
//       the tester changed a product file AND left a process and a container of its stack -> exit 1, diff names the
//       file, the leftovers are really removed (process dead, container gone, the owner's stack untouched) and written
//       into the --log file (leftovers.md) under "removed".
//   T4. role-post-check.js with a --since that is not an ancestor of HEAD -> diff.ok false with the error, the leftovers
//       part still present and ok.
// usage: node tests/p-review-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const TS = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'n', security: true };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const D = { verdict: 'done', docsOnly: false, summary: 'ok' };
const DOK = { ok: true, offending: [] }, LOK = { ok: true, found: [], removed: [], remaining: [] };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// delays: ms each reviewer role takes; events: start:<label> / end:<label> in time order.
async function run(script, delays) {
  const events = [], full = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    events.push('start:' + opts.label.replace(/#.*$/, ''));
    let v;
    if (role === 'diff') v = q.diff && q.diff.length ? q.diff.shift() : DOK;
    else if (role === 'left') v = LOK;
    else if (role === 'post') v = { ok: true, diff: DOK, left: LOK };
    else if (role === 'run') v = { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'ok' };
    else {
      if (!q[role] || !q[role].length) throw new Error('extra call ' + role);
      v = q[role].shift();
      if (delays[role]) await tick(delays[role]);
      if (role === 'test' && v && !v.head) v = Object.assign({ head: 'T' }, v);
    }
    events.push('end:' + opts.label.replace(/#.*$/, ''));
    return v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [TS] });
  return { r: res[0], events, full: full.join('>') };
}

(async () => {
  let x;
  // T1: the security reviewer finishes well after the reviewer; the post-check must start after its end.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, { review: 10, sec: 250 });
  const ev = x.events;
  const iSecEnd = ev.findIndex((e) => /^end:sec:/.test(e)), iRevEnd = ev.findIndex((e) => /^end:review:/.test(e));
  const iDiff = ev.findIndex((e) => e === 'start:diff:x:reviewer');
  ok('T1. security, the security reviewer finishes last: the reviewers\' post-check starts after both ended',
    x.r.status === 'done' && iDiff > iSecEnd && iDiff > iRevEnd && iSecEnd >= 0, ev.join(' '));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, { review: 250, sec: 10 });
  const ev2 = x.events;
  ok('T1. security, the reviewer finishes last: the post-check starts after both ended',
    x.r.status === 'done' && ev2.findIndex((e) => e === 'start:diff:x:reviewer') > ev2.findIndex((e) => /^end:review:/.test(e)), ev2.join(' '));
  ok('T1. the security reviewer starts before the slow reviewer ends',
    ev2.findIndex((e) => /^start:sec:/.test(e)) < ev2.findIndex((e) => /^end:review:/.test(e)), ev2.join(' '));

  // T2: one failed reviewers' post-check, then ok on the repeat -> done, two diff agents (#retry).
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D], diff: [{ ok: false, offending: [], error: 'not run' }, DOK] }, {});
  ok('T2. security: a failed reviewers\' post-check is repeated once and the repeat decides',
    x.r.status === 'done' && /review>sec>diff:x:reviewer>diff:x:reviewer#retry>left:x:end$/.test(x.full), x.full + ' ' + JSON.stringify(x.r));

  // T3, T4: the script for real.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p-review-t-')));
  const wt = path.join(dir, 'wt'), bin = path.join(dir, 'bin'), state = path.join(dir, 'docker.json');
  for (const d of [wt, bin]) fs.mkdirSync(d);
  // Fake docker CLI (the same contract as in role-leftovers-check.test.js): ps/images/volume ls/network ls by label, rm.
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('fs');
const S = ${JSON.stringify(state)};
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(S, 'utf8'));
const kind = a[0] === 'ps' || a[0] === 'rm' ? 'containers' : a[0] === 'images' || a[0] === 'rmi' ? 'images'
  : a[0] === 'volume' ? 'volumes' : a[0] === 'network' ? 'networks' : null;
if (!kind) process.exit(1);
const f = a.indexOf('--filter'), lab = f >= 0 ? a[f + 1].replace(/^label=/, '') : null;
if (a[0] === 'ps' || a[0] === 'images' || a[1] === 'ls') {
  const [k, v] = lab.split('=');
  for (const x of st[kind]) if (k === 'com.docker.compose.project' && x.project === v) console.log(x.id);
} else {
  const ids = a.slice(a[0] === 'volume' || a[0] === 'network' ? 2 : 1).filter((x) => !x.startsWith('-'));
  st[kind] = st[kind].filter((x) => !ids.includes(x.id));
  fs.writeFileSync(S, JSON.stringify(st));
}
`, { mode: 0o755 });
  fs.writeFileSync(state, JSON.stringify({ containers: [{ id: 'c1', project: 'k-test' }, { id: 'c9', project: 'own' }], images: [], volumes: [], networks: [] }));
  const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH });
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(wt, 'a.js'), '1\n'); git('add', 'a.js'); git('commit', '-qm', 'a');
  const since = git('rev-parse', 'HEAD').trim();
  const logf = path.join(dir, 'task', 'leftovers.md');
  const bg = (cwd, ...cmd) => parseInt(execFileSync('sh', ['-c', 'cd "$1" || exit 1; shift; nohup "$@" >/dev/null 2>&1 </dev/null & echo $!', 'sh', cwd, ...cmd], { encoding: 'utf8' }), 10);
  const alive = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() && !r.stdout.trim().startsWith('Z'); };
  const post = (s) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-post-check.js'), '--wt', wt, '--since', s, '--role', 'tester', '--allow', '-run\\.js$',
      '--stack', 'k-test', '--owner-stack', 'own', '--slots-dir', path.join(dir, 'slots'), '--fix', '--log', logf], { encoding: 'utf8', env });
    let j = null; try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
    return { r, j };
  };
  const pid = bg(wt, 'sleep', '300');
  try {
    fs.writeFileSync(path.join(wt, 'a.js'), '2\n');
    fs.writeFileSync(path.join(wt, 'b-run.js'), 'guard\n'); git('add', 'b-run.js');
    const { r, j } = post(since);
    ok('T3. product file changed + leftovers -> exit 1, diff names only the product file',
      r.status === 1 && j && j.ok === false && j.diff && j.diff.ok === false && JSON.stringify(j.diff.offending) === '["a.js"]', r.stdout + r.stderr);
    const removed = (j && j.left && j.left.removed) || [];
    ok('T3. the process in the worktree is removed and reported', !alive(pid) && removed.some((x) => x.includes(`process ${pid}`)), JSON.stringify(j && j.left));
    const st = JSON.parse(fs.readFileSync(state, 'utf8'));
    ok('T3. the container of the task stack is removed, the owner\'s stack kept', removed.some((x) => /c1/.test(x)) && !st.containers.some((c) => c.id === 'c1') && st.containers.some((c) => c.id === 'c9'), JSON.stringify(st) + ' ' + JSON.stringify(removed));
    ok('T3. the leftovers part is ok (nothing remains)', j && j.left && j.left.ok === true && !(j.left.remaining || []).length, JSON.stringify(j && j.left));
    const md = fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8') : '';
    ok('T3. leftovers.md names what was removed', /removed:\n(- .*\n)*- process \d+/.test(md) && new RegExp(`process ${pid}`).test(md) && /c1/.test(md), md);
    const t4 = post('0000000000000000000000000000000000000000');
    ok('T4. --since not an ancestor -> diff.ok false with the error, the leftovers part still ran and is ok',
      t4.r.status === 1 && t4.j && t4.j.diff.ok === false && /not an ancestor/.test(t4.j.diff.error || '') && t4.j.left && t4.j.left.ok === true && t4.j.left.wt === wt, t4.r.stdout + t4.r.stderr);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
