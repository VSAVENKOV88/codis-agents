'use strict';
// Tester cells of p-codex-B1-b2b-2 (the stop of a conductor, UC-6), run by tests/chain-run-stop.test.js as a child (its
// own tally and exit code), so README keeps counting test files. The cells the programmer's guards do not hold:
//   T1 a stop while the precondition role (pre) runs: the role ends signalled, the task ends with the result of a signal
//      (why "signalled: <SIG>", the field signal), never with the result of a failed check ("the precondition check
//      returned no result" would name a product outcome for an interrupt of the environment, UC-6 step 2);
//   T2 a signal at the intent of the environment step (env, a service step without wait): it ends with its result, the
//      precondition role never starts, the task ends signalled;
//   T3 a stop of a light-mode task while its programmer-checker runs: the result of a signal;
//   T4 stop by its run id with --config (not by the folder): exit 0, the conductor stops;
//   T5 a SIGINT after the first SIGTERM: the exit stays 143, the second one is named ignored.
// Everywhere: after the log line "stopping <SIG>" no "started" line and no intent; end is the last line of the journal.
// No model is called (the fake claude of tests/fixtures/chain-run/bin); every process runs under
// tests/fixtures/chain-run/kill-hook.js, a signal reaches only the pid of the conductor a test names (=<pid>) and the
// groups of the fake roles (FAKE_CLI_ALLOW_SELF).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');
const SIGAT = path.join(__dirname, 'fixtures', 'chain-run', 'signal-at.js');
const CRP = path.join(ROOT, 'scripts', 'chain-run.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-stop-t-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RUNS = path.join(SHARED, 'runs');
const KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow');
fs.writeFileSync(ALLOW, '');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = cond(); if (v) return v; await wait(100); } return cond(); }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const F = (n) => path.join(W, n);
const pids = new Set();

fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const CFG = F('cfg.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
const config = JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'json', CFG], { encoding: 'utf8' }).stdout);

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const LIGHT = Object.assign({}, PROG, { acceptance: 'a' });
const task = (key, extra) => {
  const wt = path.join(WTR, `w-${key}`);
  if (!fs.existsSync(wt)) git('-C', REPO, 'worktree', 'add', '-q', '-b', `b-${key}`, wt, SHA0);
  return Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
};
let nFake = 0;
function fake(answers) {
  const d = F(`fake${++nFake}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(Object.assign({ default: { 'gp:blockingQuestions,ok,problems': PRE, programmer: PROG,
    tester: { verdict: 'green', head: SHA0, summary: '' }, reviewer: DONE, 'security-reviewer': DONE } }, answers)));
  return d;
}
const trace = (d) => text(path.join(d, 'trace.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const starts = (d, role) => trace(d).filter((e) => e.ev === 'start' && e.key === role);

let nRun = 0;
// One conductor as `start` runs it (detached, IPC, the starter disconnects on ready).
function conduct(tasks, o) {
  const runId = `20261108T130000Z-t${String(++nRun).padStart(2, '0')}`;
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ runId, host: 'claude', args: { owner: 'the owner asked for the test tasks', config, tasks },
    adapter: {}, argv: [], pluginVersion: '0.0.0-test', requestedAt: new Date().toISOString() }));
  const fd = fs.openSync(path.join(dir, 'log.txt'), 'a');
  const env = Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: o.fd, FAKE_CLI_ALLOW_SELF: '1',
    NODE_OPTIONS: `-r ${SIGAT} -r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW }, o.env || {});
  const child = spawn(process.execPath, [CRP, 'run', dir], { detached: true, stdio: ['ignore', fd, fd, 'ipc'], env });
  fs.closeSync(fd);
  pids.add(child.pid);
  const r = { runId, dir, pid: child.pid, ready: null };
  child.on('message', (m) => { if (m && m.type === 'ready') { r.ready = m.tasks; child.disconnect(); } });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  r.exit = Promise.race([exited, wait(150000).then(() => ({ code: 'still running', signal: null }))]);
  return r;
}
const cli = (args) => {
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `-r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW });
  const p = spawnSync(process.execPath, [CRP].concat(args), { encoding: 'utf8', env, timeout: 60000 });
  let j = null;
  try { j = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { /* below */ }
  return { code: p.status, j, err: p.stderr };
};
const allow = (r) => fs.appendFileSync(ALLOW, `=${r.pid}\n`);
const jlines = (r, key) => {
  const d = path.join(r.dir, 'journal', key);
  let names = [];
  try { names = fs.readdirSync(d).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort(); } catch { /* none */ }
  return names.flatMap((n) => text(path.join(d, n)).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const logLines = (r) => text(path.join(r.dir, 'log.txt')).split('\n').filter(Boolean);
function invariant(r, key, sig) {
  const ls = logLines(r);
  const i = ls.findIndex((l) => new RegExp(`^\\S+ stopping ${sig}$`).test(l));
  if (i < 0) return `no line "stopping ${sig}" in log.txt`;
  const after = ls.slice(i + 1).filter((l) => /^\S+ (agent|exec) \S+ started$/.test(l));
  if (after.length) return `started after stopping: ${after.join(' | ')}`;
  const at = ls[i].split(' ')[0];
  const js = jlines(r, key);
  const late = js.filter((l) => l.type === 'intent' && l.at > at);
  if (late.length) return `an intent after stopping: ${late.map((l) => l.label).join(', ')}`;
  if (js.length && js[js.length - 1].type !== 'end') return `the last journal line is ${js[js.length - 1].type}, not end`;
  return '';
}
const resultOf = (r, key) => (((readJson(path.join(r.dir, 'results.json')) || {}).results) || []).find((x) => x && x.task === key) || {};
const signalled = (res, sig) => res.status === 'stopped' && res.signal === sig && new RegExp(`^signalled: ${sig}`).test(res.why || '');

(async () => {
  try {
    // ---- T1: stop while pre runs
    let fd = fake({ 'gp:blockingQuestions,ok,problems': [{ $sleep: 120, then: PRE }] });
    let A = conduct([task('t1')], { fd });
    await until(() => starts(fd, 'gp:blockingQuestions,ok,problems').length, 60000);
    allow(A);
    let s = cli(['stop', A.dir]);
    let x = await A.exit;
    let res = resultOf(A, 't1');
    ok('T1 stop while the precondition role runs: exit 0, the conductor exits 143', s.code === 0 && x.code === 143, JSON.stringify(s) + JSON.stringify(x));
    ok('T1 the task ends with the result of a signal (why signalled: SIGTERM, signal), not "the precondition check returned no result"', signalled(res, 'SIGTERM'), JSON.stringify(res));
    ok('T1 the pre call is signalled in its result line, the programmer never started', (jlines(A, 't1').filter((l) => l.type === 'result').pop() || {}).outcome === 'signalled' && !starts(fd, 'programmer').length);
    let inv = invariant(A, 't1', 'SIGTERM');
    ok('T1 invariant', !inv, inv);

    // ---- T2: a signal at the intent of env
    fd = fake({});
    A = conduct([task('t2')], { fd, env: { SIGNAL_AT_WRITE: '"type":"intent".*"label":"env:' } });
    x = await A.exit;
    res = resultOf(A, 't2');
    const je = jlines(A, 't2');
    const envI = je.find((l) => l.type === 'intent' && /^env:/.test(l.label)) || {};
    ok('T2 a signal at the intent of env: env ends with its result, pre never starts, exit 143', x.code === 143 && je.some((l) => l.type === 'result' && l.stepId === envI.stepId)
      && !starts(fd, 'gp:blockingQuestions,ok,problems').length, JSON.stringify(x) + JSON.stringify(je.map((l) => `${l.type}:${l.label || ''}`)));
    ok('T2 the task ends with the result of a signal', signalled(res, 'SIGTERM'), JSON.stringify(res));
    inv = invariant(A, 't2', 'SIGTERM');
    ok('T2 invariant', !inv, inv);

    // ---- T3: a light task, stop while its programmer-checker runs
    fd = fake({ programmer: [{ $sleep: 120, then: LIGHT }] });
    A = conduct([task('t3', { mode: 'light' })], { fd });
    await until(() => starts(fd, 'programmer').length, 60000);
    allow(A);
    s = cli(['stop', A.dir]);
    x = await A.exit;
    res = resultOf(A, 't3');
    ok('T3 light: stop while the programmer-checker runs: exit 143, the result of a signal, no reviewer', s.code === 0 && x.code === 143 && signalled(res, 'SIGTERM') && !starts(fd, 'reviewer').length,
      JSON.stringify(x) + JSON.stringify(res));
    inv = invariant(A, 't3', 'SIGTERM');
    ok('T3 invariant', !inv, inv);

    // ---- T4 + T5: stop by run id with --config; a SIGINT after it
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
    A = conduct([task('t4')], { fd });
    await until(() => starts(fd, 'programmer').length, 60000);
    allow(A);
    s = cli(['stop', A.runId, '--config', CFG]);
    ok('T4 stop <run-id> --config: exit 0, the pid of the conductor', s.code === 0 && s.j && s.j.sent === 'SIGTERM' && s.j.pid === A.pid, JSON.stringify(s));
    await until(() => logLines(A).some((l) => / stopping SIGTERM$/.test(l)), 10000);
    try { process.kill(A.pid, 'SIGINT'); } catch { /* gone already */ }
    x = await A.exit;
    res = resultOf(A, 't4');
    ok('T5 a SIGINT after SIGTERM: the exit stays 143, results.json 143, the SIGINT named ignored', x.code === 143 && (readJson(path.join(A.dir, 'results.json')) || {}).exitCode === 143
      && signalled(res, 'SIGTERM') && logLines(A).some((l) => / signal SIGINT ignored: stopping since SIGTERM$/.test(l)), JSON.stringify(x) + logLines(A).slice(-6).join(' | '));
  } catch (e) {
    ok('the tester cells ran to their end', false, e.stack);
  } finally {
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    for (const l of text(ALLOW).split('\n').filter((v) => /^\d+$/.test(v))) { try { process.kill(-+l, 'SIGKILL'); } catch { /* gone */ } }
    await wait(1000);
    try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  done();
})();
