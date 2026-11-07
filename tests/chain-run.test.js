#!/usr/bin/env node
'use strict';
// The conductor scripts/chain-run.js (p-codex-B1-a) as processes: `start` leaves a detached conductor in a session of
// its own, `status` watches its run folder, the conductor runs workflows/role-chain.js with the role adapter on fake
// claude and codex CLIs in PATH (tests/fixtures/chain-run/bin; no model is called), and the lock of a task refuses a
// second conductor and the restart after a conductor died. Cells R1-R15, L1-L5, A1, A4, P1, P2, P5 of the analysis,
// with G1 (a dead conductor's lock: undetermined, refused, kept), G2 (the session by ps stat and pgid) and G5 (the task
// table of the adapter, refusals before the run folder). Every process a check starts is killed in the end, and none
// with the temporary folder in its command line may remain. Since p-codex-B1-c the service steps are commands the
// conductor runs itself (exec): every task gets a real git worktree at one commit, and the fake roles answer with that
// commit as their head, so the real post-checks (role-post-check.js, role-diff-check.js, role-leftovers-check.js) and
// env-check.js run on them; only the roles go to the fake CLIs. On codex the hook check (codex-hooks-check.js) asks the
// fake codex app-server of the run home before each role (A7-A9, A12, A13).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-t-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r');
const CFG = path.join(W, 'codis-agents.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: path.join(W, 'repo'), sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
// One repository; every task's worktree is a detached worktree of its one commit (SHA0), which the fake roles name as head.
const REPO = path.join(W, 'repo');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const worktree = (name) => { const p = path.join(WTR, name); if (!fs.existsSync(p)) git('-C', REPO, 'worktree', 'add', '-q', '--detach', p, SHA0); return p; };
// The TMPDIR of a codex role is one of its write roots, so it must not hold the state of the runs.
const RTMP = path.join(W, 'rtmp');
fs.mkdirSync(RTMP);
const OWNER = path.join(W, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test tasks');
const groups = new Set();
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: SHA0, summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const DEFAULTS = { 'gp:blockingQuestions,ok,problems': PRE };
const task = (key, extra) => {
  const t = Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
  if (!/[:#]/.test(key)) worktree(t.wt);
  return t;
};

let nFake = 0;
// A fake CLI folder with its answers: {programmer: [..], tester: [..], reviewer: [..]}.
function fake(answers) {
  const d = path.join(W, `fake${++nFake}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(Object.assign({ default: DEFAULTS }, answers)));
  return d;
}
const traceOf = (d) => { try { return fs.readFileSync(path.join(d, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const starts = (d, key) => traceOf(d).filter((e) => e.ev === 'start' && (!key || e.key === key));
const envOf = (fd, extra) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd }, extra || {});
let nTasks = 0;
const tasksFile = (tasks) => { const f = path.join(W, `tasks${++nTasks}.json`); fs.writeFileSync(f, typeof tasks === 'string' ? tasks : JSON.stringify(tasks)); return f; };

const cr = (args, env) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 120000 });
function start(tasks, fd, more, env) {
  const p = cr(['start', '--host', 'claude', '--tasks', tasksFile(tasks), '--owner', OWNER, '--config', CFG].concat(more || []), env || envOf(fd));
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  if (j && j.pid) groups.add(j.pid);
  return { p, j };
}
const status = (run, wait, env) => {
  const p = cr(['status', run, '--config', CFG].concat(wait === undefined ? [] : ['--wait', String(wait)]), env);
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  return { p, j };
};
const finished = (j) => status(j.runDir, 120);
const ps = (pid, field) => { const p = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return p.status === 0 ? p.stdout.trim() : null; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function until(cond, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = cond(); if (v) return v; sleepMs(50); } return cond(); }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const runsCount = () => { try { return fs.readdirSync(path.join(SHARED, 'runs')).length; } catch { return 0; } };
const lockOf = (key) => path.join(SHARED, 'runs', '.locks', `${key}.lock`);

function cleanup() {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } try { process.kill(g, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of fs.readdirSync(W).filter((x) => /^fake\d+$/.test(x))) {
    for (const e of traceOf(path.join(W, d))) if (e.ev === 'start') { try { process.kill(-e.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

(async () => {
  try {
    // ---- R1, P5, A1, G5, R7, R15, L5: the green path through processes
    let fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
    let s = start([task('g1', { wt: 'w1' })], fd);
    ok('R1 start prints {runId, runDir, pid} and exits 0', s.p.status === 0 && s.j && s.j.runId && s.j.runDir === path.join(SHARED, 'runs', s.j.runId) && s.j.pid > 0, s.p.stdout + s.p.stderr);
    const rj = readJson(path.join(s.j.runDir, 'run.json')) || {};
    ok('R1 run.json: runId, pid, lstart, host, tasks, argv, plugin version', rj.runId === s.j.runId && rj.pid === s.j.pid && typeof rj.lstart === 'string' && rj.lstart.length > 10
      && rj.host === 'claude' && JSON.stringify(rj.tasks) === '["g1"]' && Array.isArray(rj.argv) && rj.pluginVersion === require('../package.json').version, JSON.stringify(rj));
    let st = finished(s.j);
    ok('R7 status after the end: finished, exit 0, results from results.json', st.p.status === 0 && st.j && st.j.state === 'finished' && st.j.results[0].task === 'g1' && st.j.results[0].status === 'done', st.p.stdout + st.p.stderr);
    const res = readJson(path.join(s.j.runDir, 'results.json')) || {};
    ok('R15 results.json: exit code 0 when every task is done, the results as the Workflow gives them', res.exitCode === 0 && res.results && res.results[0].status === 'done' && res.results[0].counts, JSON.stringify(res));
    const tr = starts(fd);
    ok('P5 E1 the roles ran as processes of the fake claude: pre, programmer, tester, reviewer - no service step reached it',
      tr.map((e) => e.key).join('>') === 'gp:blockingQuestions,ok,problems>programmer>tester>reviewer', tr.map((e) => e.key).join('>'));
    ok('G5 every role runs in the task folder of role-chain.js (dir by default <sharedDir>/<key>)', tr.length && tr.every((e) => e.cwd === path.join(SHARED, 'g1')), tr.map((e) => e.cwd).join(' '));
    const pp = (tr.find((e) => e.key === 'programmer') || {}).prompt || '';
    ok('G5 the prompt names the same task folder and the worktree under worktreeRoot (a relative wt)', pp.includes(path.join(SHARED, 'g1') + '/') && pp.includes(path.join(WTR, 'w1')), pp.slice(0, 300));
    const calls = fs.readFileSync(path.join(SHARED, 'g1', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok('P5 one line of <task dir>/calls.jsonl per call, each with its call folder', calls.length === tr.length && calls.every((c) => c.outcome === 'ok' && c.callDir && c.callDir.startsWith(path.join(SHARED, 'g1', 'calls'))), calls.length + ' ' + tr.length);
    const log = fs.readFileSync(path.join(s.j.runDir, 'log.txt'), 'utf8');
    ok('A1 log.txt: a line per call with its label, ok, seconds', /agent prog:g1#1 ok [\d.]+ s/.test(log) && /agent review:g1#1 ok [\d.]+ s/.test(log), log.slice(0, 1500));
    ok('L5 the lock of a finished task is removed', !fs.existsSync(lockOf('g1')));
    ok('E1 E10 the service steps ran as commands of the conductor, each with its start and end line: env, the tester post-check, the reviewers\' diff check, the end leftovers check',
      ['env:g1', 'post:g1:tester', 'diff:g1:reviewer', 'left:g1:end'].every((l) => log.includes(` exec ${l} started`) && new RegExp(` exec ${l} ok [\\d.]+ s`).test(log)), log.slice(0, 2500));
    const pre1 = (tr.find((e) => e.key === 'gp:blockingQuestions,ok,problems') || {}).prompt || '';
    ok('E7 the pre prompt carries the env-check result of the conductor (checkedAt, the host scope), pre runs no env-check', /checkedAt/.test(pre1) && /outside the sandbox of the role/.test(pre1)
      && !/run node \S*env-check\.js/.test(pre1), pre1.slice(-900));

    // ---- R4, G2, R6, P2, R10: Ctrl+C and the hang-up of the starter's terminal, status while it runs
    fd = fake({ programmer: [{ $sleep: 6, then: PROG }], tester: [GREEN], reviewer: [DONE] });
    const tf = tasksFile([task('h1')]);
    const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" "${CR}" start --host claude --tasks "${tf}" --owner "${OWNER}" --config "${CFG}"; sleep 60`],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: envOf(fd) });
    groups.add(sh.pid);
    let out = '';
    sh.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => { const t = setInterval(() => { if (/\}\s*$/.test(out)) { clearInterval(t); r(); } }, 50); setTimeout(() => { clearInterval(t); r(); }, 30000); });
    let hj = null;
    try { hj = JSON.parse(out); } catch { /* below */ }
    ok('R4 start under a shell group prints the run', hj && hj.pid > 0, out);
    if (hj) {
      groups.add(hj.pid);
      const stat = ps(hj.pid, 'stat') || '', pgid = ps(hj.pid, 'pgid');
      ok('G2 the conductor leads a session of its own (ps stat has s) and its own group (pgid = pid)', /s/.test(stat) && String(pgid) === String(hj.pid), `stat ${stat}, pgid ${pgid}, pid ${hj.pid}`);
      until(() => starts(fd, 'programmer').length);
      const lst = ps(hj.pid, 'lstart');
      process.kill(-sh.pid, 'SIGINT');
      process.kill(-sh.pid, 'SIGHUP');
      sleepMs(500);
      ok('R4 SIGINT and SIGHUP to the group of the starter do not reach the conductor', alive(hj.pid) && ps(hj.pid, 'lstart') === lst, `alive ${alive(hj.pid)}`);
      st = status(hj.runId, 1);
      ok('R6 status --wait 1 while it runs: state running, its own exit code 3, not an error', st.p.status === 3 && st.j && st.j.state === 'running', st.p.stdout + st.p.stderr);
      ok('P2 status names for each task what it waits for (the open call and since when)', st.j && st.j.tasks && st.j.tasks.h1 && (st.j.tasks.h1.open || []).some((o) => o.label === 'prog:h1#1' && o.since),
        JSON.stringify(st.j && st.j.tasks));
      const w = spawn(process.execPath, [CR, 'status', hj.runId, '--config', CFG, '--wait', '270'], { stdio: 'ignore' });
      sleepMs(700);
      const t0 = Date.now();
      w.kill('SIGINT');
      const code = await new Promise((r) => w.on('close', (c, sg) => r(c === null ? sg : c)));
      ok('R10 Ctrl+C at status --wait ends only the watch (130), the conductor lives on', code === 130 && Date.now() - t0 < 5000 && alive(hj.pid) && ps(hj.pid, 'lstart') === lst, `code ${code}`);
      st = finished(hj);
      ok('R4 the run goes on to its end after the signals', st.j && st.j.state === 'finished' && st.j.results[0].status === 'done', st.p.stdout);
    }
    try { process.kill(-sh.pid, 'SIGKILL'); } catch { /* gone */ }

    // ---- P5 null and a killed role, R15, P1 (two tasks: one result each)
    fd = fake({ programmer: [{ $error: 'the plan limit' }, { $sleep: 60, then: PROG }] });
    s = start([task('n1'), task('k1')], fd);
    const killed = until(() => starts(fd, 'programmer').length === 2 && starts(fd, 'programmer').find((e) => !traceOf(fd).some((x) => x.ev === 'end' && x.pid === e.pid)));
    if (killed) { try { process.kill(-killed.pid, 'SIGKILL'); } catch { /* gone */ } }
    st = finished(s.j);
    const byKey = (r) => Object.fromEntries(((r && r.results) || []).map((x) => [x.task, x]));
    let rk = byKey(st.j);
    ok('P5 an error result and a killed role: null to the script, each task stopped with its own why', rk.n1 && rk.n1.status === 'stopped' && rk.k1 && rk.k1.status === 'stopped'
      && /programmer/.test(rk.n1.why) && /programmer/.test(rk.k1.why), JSON.stringify(st.j && st.j.results));
    const outs = ['n1', 'k1'].map((k) => fs.readFileSync(path.join(SHARED, k, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.role === 'programmer'));
    ok('P5 the adapter records both outcomes (crashed by the error result, killed by SIGKILL)', outs[0] && outs[1] && [outs[0].outcome, outs[1].outcome].sort().join(',') === 'crashed,killed', JSON.stringify(outs.map((c) => c && c.outcome)));
    ok('R15 results.json exit code 3 when a task is not done', (readJson(path.join(s.j.runDir, 'results.json')) || {}).exitCode === 3);

    // ---- A4: review and security review at once, each with its own call folder
    fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [{ $sleep: 1.5, then: DONE }], 'security-reviewer': [{ $sleep: 1.5, then: DONE }] });
    s = start([task('a4', { security: true })], fd);
    st = finished(s.j);
    const rv = starts(fd, 'reviewer')[0], sc = starts(fd, 'security-reviewer')[0];
    const endOf = (e) => (traceOf(fd).find((x) => x.ev === 'end' && x.pid === e.pid) || {}).ms;
    ok('A4 the reviewer and the security reviewer run at once (each started before the other ended)', rv && sc && rv.ms < endOf(sc) && sc.ms < endOf(rv) && st.j.results[0].status === 'done', JSON.stringify(st.j && st.j.results));
    const c4 = fs.readFileSync(path.join(SHARED, 'a4', 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rc4 = c4.filter((c) => /^(review|sec):/.test(c.label));
    ok('A4 two calls, two call folders', rc4.length === 2 && rc4[0].callDir !== rc4[1].callDir, JSON.stringify(rc4.map((c) => c.callDir)));

    // ---- G1 (L3 replaced), R8 replaced: SIGKILL of the conductor in the middle of a role
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }, PROG], tester: [GREEN], reviewer: [DONE] });
    s = start([task('d1')], fd);
    const role = until(() => starts(fd, 'programmer')[0]);
    process.kill(s.j.pid, 'SIGKILL');
    until(() => !alive(s.j.pid), 5000);
    const lockF = lockOf('d1');
    const lock1 = fs.existsSync(lockF) ? fs.readFileSync(lockF, 'utf8') : null;
    st = status(s.j.runId);
    const cd = role && fs.readdirSync(path.join(SHARED, 'd1', 'calls')).map((x) => path.join(SHARED, 'd1', 'calls', x)).find((x) => /^prog_d1_1-/.test(path.basename(x)));
    ok('R8 status of a conductor gone without results.json: dead, its own exit code 4, the call started without a line in calls.jsonl',
      st.p.status === 4 && st.j && st.j.state === 'dead' && st.j.tasks && st.j.tasks.d1 && (st.j.tasks.d1.unrecordedCalls || []).includes(cd), st.p.stdout + ' ' + cd);
    const s2 = start([task('d1')], fd);
    const st2 = s2.j ? finished(s2.j) : { j: null };
    const r2 = st2.j && st2.j.results && st2.j.results[0];
    ok('G1 a restart after the conductor died is refused: stopped, undetermined, names run.json and the call started without a record',
      r2 && r2.status === 'stopped' && /undetermined/.test(r2.why) && r2.why.includes(path.join(s.j.runDir, 'run.json')) && r2.why.includes(cd), JSON.stringify(r2));
    ok('G1 no role of the task ran again (one programmer, one preconditions call in all)', starts(fd, 'programmer').length === 1 && starts(fd, 'gp:blockingQuestions,ok,problems').length === 1,
      starts(fd).map((e) => e.key).join('>'));
    ok('G1 the lock stays as it was', lock1 && fs.existsSync(lockF) && fs.readFileSync(lockF, 'utf8') === lock1);
    ok('G1 the role of the dead conductor is still alive (named, not killed)', role && alive(role.pid));
    const mark = readJson(path.join(s.j.runDir, 'undetermined.json')) || {};
    ok('G1 the run folder of the dead conductor carries the mark "undetermined": runId, the reason, the calls started without a record',
      mark.runId === s.j.runId && mark.tasks && mark.tasks.d1 && /undetermined/.test(mark.tasks.d1.reason) && (mark.tasks.d1.unrecordedCalls || []).includes(cd), JSON.stringify(mark));
    if (role) { try { process.kill(-role.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.unlinkSync(lockF);
    const s3 = start([task('d1')], fd);
    const st3 = s3.j ? finished(s3.j) : { j: null };
    const r3 = st3.j && st3.j.results && st3.j.results[0];
    ok('G1 the lock removed by hand (a technical cleanup) does not lift the refusal: the mark still stops the task, no role',
      r3 && r3.status === 'stopped' && /undetermined/.test(r3.why) && r3.why.includes(path.join(s.j.runDir, 'undetermined.json')) && starts(fd).length === 2,
      JSON.stringify(r3) + ' ' + starts(fd).map((e) => e.key).join('>'));
    ok('G1 the refusing run takes no lock of its own', !fs.existsSync(lockF));
    // The lock removed before any restart saw it: the run folder of the dead conductor still names the task as running.
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
    s = start([task('d2')], fd);
    const role2 = until(() => starts(fd, 'programmer')[0]);
    process.kill(s.j.pid, 'SIGKILL');
    until(() => !alive(s.j.pid), 5000);
    if (role2) { try { process.kill(-role2.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.unlinkSync(lockOf('d2'));
    const s4 = start([task('d2')], fd);
    const r4 = s4.j ? (finished(s4.j).j || {}).results : null;
    ok('G1 a lock removed before any restart: the dead run still names the task as running -> undetermined, refused, marked, no role',
      r4 && r4[0].status === 'stopped' && /undetermined/.test(r4[0].why) && starts(fd).length === 2
        && ((readJson(path.join(s.j.runDir, 'undetermined.json')) || { tasks: {} }).tasks.d2 || null) !== null, JSON.stringify(r4) + ' ' + starts(fd).map((e) => e.key).join('>'));

    // ---- L4: the pid of the lock is alive, but another process (another start time)
    fs.mkdirSync(path.join(SHARED, 'l4'), { recursive: true });
    fs.mkdirSync(path.dirname(lockOf('l4')), { recursive: true });
    fs.writeFileSync(lockOf('l4'), JSON.stringify({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 1970', runId: 'old', runDir: path.join(SHARED, 'runs', 'old') }));
    fd = fake({});
    s = start([task('l4')], fd);
    st = finished(s.j);
    ok('L4 a lock whose pid now belongs to another process: undetermined, refused, no role', st.j.results[0].status === 'stopped' && /undetermined/.test(st.j.results[0].why) && !starts(fd).length, JSON.stringify(st.j.results));

    // ---- L1: a live conductor holds the lock; L2: two conductors take one task at once
    const holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    groups.add(holder.pid);
    const hl = until(() => ps(holder.pid, 'lstart'));
    fs.mkdirSync(path.join(SHARED, 'l1'), { recursive: true });
    fs.writeFileSync(lockOf('l1'), JSON.stringify({ pid: holder.pid, lstart: hl, runId: 'other-run', runDir: path.join(SHARED, 'runs', 'other-run') }));
    fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
    s = start([task('l1'), task('o1')], fd);
    ok('L1 start already names what each task got when it prints: the lock held, or why not', s.j && s.j.tasks && s.j.tasks.o1 === 'held'
      && /another conductor runs it/.test(s.j.tasks.l1 || ''), s.p.stdout);
    st = finished(s.j);
    rk = byKey(st.j);
    ok('L1 a task whose lock a live conductor holds: stopped "another conductor runs it" with its pid and run, the other task goes on',
      rk.l1 && rk.l1.status === 'stopped' && /another conductor runs it/.test(rk.l1.why) && rk.l1.why.includes(String(holder.pid)) && rk.l1.why.includes('other-run') && rk.o1 && rk.o1.status === 'done',
      JSON.stringify(st.j.results));
    ok('L1 the lock of the live conductor is untouched', (readJson(lockOf('l1')) || {}).pid === holder.pid);
    fd = fake({ programmer: [{ $sleep: 3, then: PROG }, { $sleep: 3, then: PROG }], tester: [GREEN, GREEN], reviewer: [DONE, DONE] });
    const tf2 = tasksFile([task('l2')]);
    const two = await Promise.all([0, 1].map(() => new Promise((r) => {
      const c = spawn(process.execPath, [CR, 'start', '--host', 'claude', '--tasks', tf2, '--owner', OWNER, '--config', CFG], { env: envOf(fd), stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.on('close', () => { try { const j = JSON.parse(o); groups.add(j.pid); r(j); } catch { r(null); } });
    })));
    const fin = two.map((j) => (j ? finished(j).j : null));
    const rs = fin.map((j) => j && j.results && j.results[0]);
    ok('L2 two conductors take one task at once: exactly one runs it, the other stops it as held by a live conductor',
      rs.filter((r) => r && r.status === 'done').length === 1 && rs.filter((r) => r && r.status === 'stopped' && /another conductor runs it/.test(r.why)).length === 1
        && starts(fd, 'programmer').length === 1, JSON.stringify(rs));

    // ---- R12: the host check is red -> every task stopped before any role, results.json written
    fd = fake({});
    s = start([task('c1'), task('c2')], fd, ['--bin', path.join(W, 'no-such-claude')]);
    st = finished(s.j);
    ok('R12 role-exec.js check red: every task stopped with the problems of the check, no role, the locks removed',
      st.j && st.j.results.length === 2 && st.j.results.every((r) => r.status === 'stopped' && /host check/.test(r.why) && /claude binary not found/.test(r.why)) && !starts(fd).length
        && !fs.existsSync(lockOf('c1')), JSON.stringify(st.j && st.j.results));

    // ---- R14: results.json cannot be written
    fd = fake({ programmer: [{ $sleep: 2, then: PROG }], tester: [GREEN], reviewer: [DONE] });
    s = start([task('w14')], fd);
    fs.mkdirSync(path.join(s.j.runDir, 'results.json'));
    until(() => !alive(s.j.pid), 60000);
    const log14 = fs.readFileSync(path.join(s.j.runDir, 'log.txt'), 'utf8');
    ok('R14 results.json not written: the error in log.txt, a non-zero exit, the lock removed', /results\.json could not be written/.test(log14) && /exit 4/.test(log14)
      && !fs.existsSync(lockOf('w14')), log14.slice(-600));

    // ---- P5 on codex, A7-A9, A12, A13: the hook check of the run home before each codex role
    const codexRun = (key, scenario) => {
      const fdc = fake({});
      const home = path.join(W, `codex-home-${key}`);
      fs.mkdirSync(home);
      if (scenario) fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify(scenario));
      const pc = cr(['start', '--host', 'codex', '--codex-home', home, '--tasks', tasksFile([task(key)]), '--owner', OWNER, '--config', CFG], envOf(fdc, { TMPDIR: RTMP }));
      let cj = null;
      try { cj = JSON.parse(pc.stdout); groups.add(cj.pid); } catch { /* below */ }
      const sj = cj ? finished(cj).j : null;
      const recs = (fs.existsSync(path.join(SHARED, key, 'calls.jsonl')) ? fs.readFileSync(path.join(SHARED, key, 'calls.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ev = traceOf(fdc);
      return { r: sj && sj.results && sj.results[0], recs, hooks: ev.filter((e) => e.ev === 'hooks'), execs: ev.filter((e) => e.ev === 'start'), home: fs.realpathSync(home), out: pc.stdout + pc.stderr };
    };
    let c = codexRun('x1', null);
    ok('A8 codex, no hook of the plugin in the run home: the check (exit 1) keeps pre from starting, no codex exec; the result names the outcome of the adapter',
      c.r && c.r.status === 'stopped' && c.recs.length === 1 && c.recs[0].outcome === 'hook-untrusted' && c.recs[0].host === 'codex' && !c.execs.length && c.hooks.length === 1
        && c.r.adapter && c.r.adapter[0].outcome === 'hook-untrusted' && c.r.adapter[0].cause === 'hook-untrusted' && c.r.environment === undefined, JSON.stringify(c.r) + JSON.stringify(c.recs) + c.out);
    c = codexRun('x2', { trust: 'trusted' });
    ok('A7 A12 codex, the hook trusted: one check before pre (the run home, the task folder), pre runs as a codex exec in the task folder',
      c.hooks.length === 1 && c.hooks[0].home === c.home && c.hooks[0].cwd === path.join(SHARED, 'x2') && c.execs.length === 1 && c.execs[0].key === 'gp:blockingQuestions,ok,problems'
        && c.execs[0].cwd === path.join(SHARED, 'x2'), JSON.stringify(c.hooks) + JSON.stringify(c.execs.map((e) => [e.key, e.cwd])));
    ok("A13 A13' then the programmer on codex is refused by the adapter (part A2) without a hook check: stopped, adapter names it with cause refused",
      c.r && c.r.status === 'stopped' && /programmer returned no result/.test(c.r.why) && c.r.adapter && c.r.adapter.length === 1 && c.r.adapter[0].label === 'prog:x2#1'
        && c.r.adapter[0].outcome === 'refused' && c.r.adapter[0].cause === 'refused', JSON.stringify(c.r));
    c = codexRun('x3', { mode: 'exit' });
    ok('A9 codex, the check could not run (exit 3): pre not started, outcome hook-unverified, cause unknown',
      c.r && c.r.status === 'stopped' && !c.execs.length && c.r.adapter && c.r.adapter[0].outcome === 'hook-unverified' && c.r.adapter[0].cause === 'unknown', JSON.stringify(c.r));

    // ---- R5: the conductor dies before it is ready
    const crash = path.join(W, 'crash.js');
    fs.writeFileSync(crash, "if (process.argv[2] === 'run') throw new Error('boom before ready');\n");
    fd = fake({});
    const p5 = cr(['start', '--host', 'claude', '--tasks', tasksFile([task('r5')]), '--owner', OWNER, '--config', CFG], envOf(fd, { NODE_OPTIONS: `--require ${crash}` }));
    const rd5 = (/run folder (\S+)/.exec(p5.stderr) || [])[1];
    ok('R5 the conductor died before "ready": start exits 70 with the tail of its output', p5.status === 70 && /boom before ready/.test(p5.stderr), `${p5.status} ${p5.stderr.slice(-400)}`);
    st = rd5 ? status(rd5) : { p: {}, j: null };
    ok('R5 status of that run: dead', st.p.status === 4 && st.j && st.j.state === 'dead', `${rd5} ${st.p.stdout}`);
    ok('R5 no role ran', !starts(fd).length);

    // ---- R2, R3, G5: refusals before the run folder
    const n0 = runsCount();
    let p = cr(['start', '--host', 'claude', '--tasks', tasksFile([task('q')]), '--owner', OWNER, '--config', path.join(W, 'none.json')]);
    ok('R2 config not found: the error of config.js, exit 65, no run folder', p.status === 65 && /codis-agents config/.test(p.stderr) && runsCount() === n0, `${p.status} ${p.stderr}`);
    const bad = { 'not JSON': '{', 'not an array': '{"key":"a"}', empty: '[]', 'a number field': JSON.stringify([task('q', { title: 5 })]),
      'a task without a key': JSON.stringify([{ title: 'x' }]), 'two tasks with one key': JSON.stringify([task('q'), task('q')]) };
    for (const [name, text] of Object.entries(bad)) {
      p = cr(['start', '--host', 'claude', '--tasks', tasksFile(text), '--owner', OWNER, '--config', CFG]);
      ok(`R3 tasks file ${name}: exit 64 before the run folder`, p.status === 64 && runsCount() === n0, `${p.status} ${p.stderr}`);
    }
    p = cr(['start', '--host', 'claude', '--tasks', tasksFile([task('a:b')]), '--owner', OWNER, '--config', CFG]);
    ok('G5 a task key the adapter refuses (":"): exit 64 with the refusal, before the run folder and the locks', p.status === 64 && /role-exec: refused/.test(p.stderr) && runsCount() === n0, `${p.status} ${p.stderr}`);
    p = cr(['start', '--host', 'codex', '--tasks', tasksFile([task('q')]), '--owner', OWNER, '--config', CFG]);
    ok('G5 codex without a run home: exit 64 with the refusal of the adapter, before the run folder', p.status === 64 && /codex\.home is required/.test(p.stderr) && runsCount() === n0, `${p.status} ${p.stderr}`);
    p = cr(['start', '--host', 'gpt', '--tasks', tasksFile([task('q')]), '--config', CFG]);
    ok('R3 an unknown host: exit 64', p.status === 64 && runsCount() === n0, p.stderr);
    p = cr(['start', '--host', 'claude', '--tasks', tasksFile([task('q')]), '--owner', path.join(W, 'no-owner.txt'), '--config', CFG]);
    ok('R3 an owner file that does not exist: exit 64', p.status === 64 && runsCount() === n0, p.stderr);

    // ---- R9, R11
    st = status('no-such-run');
    ok('R9 status of an unknown run: exit 64, the error and the list of runs', st.p.status === 64 && /no run no-such-run/.test(st.p.stderr) && st.p.stderr.includes(s3.j.runId), st.p.stderr.slice(0, 400));
    st = status(s3.j.runId, 600);
    ok('R11 --wait 600 is cut to 270', st.j && st.j.max === 270 && st.j.state === 'finished', st.p.stdout);
    st = status(s3.j.runId);
    ok('R11 without --wait: the answer at once', st.j && st.j.max === 0 && st.j.state === 'finished', st.p.stdout);
    p = cr(['frobnicate']);
    ok('usage: an unknown command -> 64', p.status === 64 && /usage/.test(p.stderr), p.stderr);

    // ---- R13, P1 in process: the script throws at load; one chain of a pipeline throws
    const CRm = require('../scripts/chain-run.js');
    const ended = [];
    const x13 = await CRm.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config: { sharedDir: SHARED, worktreeRoot: WTR }, tasks: [task('t13'), task('u13')] },
      launch: async () => ({ output: PRE }), log: () => {}, note: () => {}, onTaskEnd: (k) => ended.push(k) });
    ok('R13 the chain script throws at load: every task stopped "the chain script threw: ..."', x13.threw && x13.results.length === 2
      && x13.results.every((r) => r.status === 'stopped' && /^the chain script threw: role-chain: args\.config\.scriptsDir is missing/.test(r.why)) && ended.sort().join() === 't13,u13', JSON.stringify(x13.results));
    const notes = [], ended1 = [];
    const pl = CRm.makePipeline((m) => notes.push(m), (k) => ended1.push(k));
    const rp = await pl([{ key: 'p1' }, { key: 'p2' }], async (t) => { if (t.key === 'p1') throw new Error('kaput'); return { task: t.key, status: 'done' }; });
    ok('P1 one chain throws: its result stopped "the chain crashed: <text>", the other goes to its end, both locks released',
      rp[0].status === 'stopped' && rp[0].task === 'p1' && rp[0].why === 'the chain crashed: kaput' && rp[1].status === 'done' && ended1.sort().join() === 'p1,p2' && notes.some((m) => /kaput/.test(m)), JSON.stringify(rp));

    // ---- tester (p-codex-B1-a round 1): T1-T4
    // T1 (L5, UC-4): a task that ended while its neighbour still runs has its lock removed at once, and a start of it
    // alone runs while the first conductor lives on. T4 (R8 by start time): a live pid whose start time is not the one
    // run.json names is not the conductor -> dead. T2 (UC-5): the conductor killed with one task ended and the other in
    // the middle of a role -> the ended task starts again, the other is refused, its role not called again.
    // T3 (L3'): a lock that does not parse is neither taken nor removed -> undetermined, no role.
    fd = fake({ 'programmer@ts': [{ $sleep: 90, then: PROG }], default: Object.assign({}, DEFAULTS, { programmer: PROG, tester: GREEN, reviewer: DONE }) });
    s = start([task('tf'), task('ts')], fd);
    const tfState = path.join(s.j.runDir, 'tasks', 'tf.json');
    until(() => (readJson(tfState) || {}).state === 'ended', 60000);
    const tsRole = until(() => starts(fd, 'programmer').find((e) => e.cwd === path.join(SHARED, 'ts')));
    ok('T1 a task ended while its neighbour runs: its lock is removed at once, the neighbour keeps its lock, the conductor lives',
      (readJson(tfState) || {}).state === 'ended' && !fs.existsSync(lockOf('tf')) && fs.existsSync(lockOf('ts'))
        && alive(s.j.pid) && tsRole && alive(tsRole.pid), JSON.stringify(readJson(tfState)));
    const runJ = path.join(s.j.runDir, 'run.json');
    const runOrig = fs.readFileSync(runJ, 'utf8');
    fs.writeFileSync(runJ, JSON.stringify(Object.assign(JSON.parse(runOrig), { lstart: 'Thu Jan  1 00:00:00 1970' })));
    st = status(s.j.runId);
    ok('T4 status: the pid of run.json is alive but started at another time -> dead, exit 4', st.p.status === 4 && st.j && st.j.state === 'dead', st.p.stdout);
    fs.writeFileSync(runJ, runOrig);
    st = status(s.j.runId);
    ok('T4 status: the same pid and start time -> running, exit 3', st.p.status === 3 && st.j && st.j.state === 'running', st.p.stdout);
    const t1 = start([task('tf')], fd);
    const t1r = t1.j ? ((finished(t1.j).j || {}).results || [])[0] : null;
    ok('T1 the ended task started alone while the first conductor still runs its neighbour: it runs to done',
      t1.j && t1.j.tasks && t1.j.tasks.tf === 'held' && t1r && t1r.status === 'done' && alive(s.j.pid), JSON.stringify(t1r) + ' ' + t1.p.stdout + t1.p.stderr);
    process.kill(s.j.pid, 'SIGKILL');
    until(() => !alive(s.j.pid), 5000);
    const tsCalls = starts(fd, 'programmer').filter((e) => e.cwd === path.join(SHARED, 'ts')).length;
    const t2a = start([task('tf')], fd);
    const t2ar = t2a.j ? ((finished(t2a.j).j || {}).results || [])[0] : null;
    ok('T2 after the conductor died: its task that had ended starts again and runs to done (not undetermined)',
      t2ar && t2ar.status === 'done', JSON.stringify(t2ar) + ' ' + t2a.p.stdout + t2a.p.stderr);
    const t2b = start([task('ts')], fd);
    const t2br = t2b.j ? ((finished(t2b.j).j || {}).results || [])[0] : null;
    ok('T2 its task that was in the middle of a role is refused as undetermined, its role not called again',
      t2br && t2br.status === 'stopped' && /undetermined/.test(t2br.why) && starts(fd, 'programmer').filter((e) => e.cwd === path.join(SHARED, 'ts')).length === tsCalls,
      JSON.stringify(t2br));
    if (tsRole) { try { process.kill(-tsRole.pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.mkdirSync(path.join(SHARED, 't3'), { recursive: true });
    fs.writeFileSync(lockOf('t3'), '');
    fd = fake({});
    s = start([task('t3')], fd);
    const t3r = s.j ? ((finished(s.j).j || {}).results || [])[0] : null;
    ok('T3 a lock that does not parse: undetermined, refused, no role, the lock as it was', t3r && t3r.status === 'stopped' && /undetermined/.test(t3r.why) && !starts(fd).length
      && fs.existsSync(lockOf('t3')) && fs.readFileSync(lockOf('t3'), 'utf8') === '', JSON.stringify(t3r));
  } finally {
    cleanup();
  }
  sleepMs(300);
  const left = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(W) && !l.includes(' ps '));
  ok('G9 no process of this test remains (its temporary folder in a command line)', !left.length, left.join('\n'));
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  done();
})().catch((e) => { cleanup(); console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
