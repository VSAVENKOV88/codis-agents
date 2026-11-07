'use strict';
// Tester cells of p-codex-B1-b2a (the steps folder of a run, liveness, the lock, the reconciliation), run by
// tests/chain-run-reconcile.test.js as a child (its own tally and exit code), so README keeps counting test files. The
// cells the programmer's guards do not hold:
//   T1 files left in the task folder under the names of the wait steps (a meta with pid 1, an exit code file, a log and
//      leftovers.md as dangling links) do not reach the conductor: through the real `chain-run.js start` and the real
//      wait-step.js, the selection command runs, its own exit code is the verdict, nothing is written through the links,
//      no signal reaches pid 1, 0 or -1 (every process under tests/fixtures/chain-run/kill-hook.js, brief G1);
//   T2 SIGKILL of the conductor after the programmer role committed, before its result: `status` says dead with the
//      open step; the next start is refused by the reconciliation while the role lives and after it ended, the role is
//      not called again and no second commit appears;
//   T3 two starts of one task at once over a free lock: exactly one registered run, the other "another conductor"; the
//      next start after the winner ended goes;
//   T4 `status` of a run whose conductor's liveness is unknown (a live pid without a start time; ps failing while the pid
//      exists) says running, never dead.
// No model is called: roles go to the fake CLI of tests/fixtures/chain-run/bin (T2 through the wrapper bin-commit). The
// selection runner and the train of T1 are stubs in a copy of the plugin's scripts; wait-step.js, chain-run.js and
// role-chain.js are the ones of this tree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const BIN_COMMIT = path.join(__dirname, 'fixtures', 'chain-run', 'bin-commit', 'claude');
const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-rc-t-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RUNS = path.join(SHARED, 'runs');
const KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow.txt');
fs.writeFileSync(ALLOW, '');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
git('-C', REPO, 'branch', 'arc');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const worktree = (name) => { const p = path.join(WTR, name); if (!fs.existsSync(p)) git('-C', REPO, 'worktree', 'add', '-q', '-b', `b-${name}`, p, SHA0); return p; };
const OWNER = path.join(W, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test tasks');
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = (c, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = c(); if (v) return v; sleepMs(50); } return c(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lstartOf = (pid) => { const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return p.status === 0 ? p.stdout.trim() : null; };
const groups = new Set();
const kills = () => { try { return fs.readFileSync(KLOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// A copy of the plugin whose guards-all.sh and train.js are stubs: the selection touches a mark and prints a line, the
// ride prints a line; both exit 0. Everything else is this tree's code.
const PLUG = path.join(W, 'plugin');
for (const d of ['scripts', 'workflows', 'agents', 'rules', 'schemas', 'skills', 'hooks', '.claude-plugin']) {
  if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(PLUG, d), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(PLUG, 'package.json'));
const SEL_MARK = path.join(W, 'selection-ran');
fs.writeFileSync(path.join(PLUG, 'scripts', 'guards-all.sh'), `#!/bin/sh\necho "stub selection $*"\necho x >> '${SEL_MARK}'\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(PLUG, 'scripts', 'train.js'), `console.log('stub train ' + process.argv.slice(2).join(' '));\nprocess.exit(0);\n`);

function config(name, extra) {
  const f = path.join(W, `cfg-${name}.json`);
  fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }, extra || {})));
  return f;
}
const CFG = config('plain');
const CFG_SEL = config('select', { guardSubsetCommand: 'true {wt} {onlyArgs} {jobs} {limitFile}', guardRerun: { command: 'true {wt} {name}', newRedPattern: '^FAIL (\\S+) ', tallyPattern: '^TOTAL: .* (\\d+) total$' } });

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: SHA0, summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const task = (key, extra) => {
  const t = Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-w-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
  worktree(t.wt);
  return t;
};
let nFake = 0, nTasks = 0;
function fake(answers) {
  const d = path.join(W, `fake${++nFake}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(Object.assign({ default: { 'gp:blockingQuestions,ok,problems': PRE } }, answers)));
  return d;
}
const traceOf = (d) => { try { return fs.readFileSync(path.join(d, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const starts = (d, key) => traceOf(d).filter((e) => e.ev === 'start' && (!key || e.key === key));
// Every process of a conductor runs under the kill hook (G1): no real signal but to an allowed group.
const envOf = (fd, extra) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd,
  NODE_OPTIONS: `-r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW }, extra || {});
const tasksFile = (tasks) => { const f = path.join(W, `tasks${++nTasks}.json`); fs.writeFileSync(f, JSON.stringify(tasks)); return f; };
const crOf = (cr) => (args, env) => spawnSync(process.execPath, [cr].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 200000 });
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const CR_PLUG = path.join(PLUG, 'scripts', 'chain-run.js');
function start(tasks, fd, o = {}) {
  const p = crOf(o.cr || CR)(['start', '--host', 'claude', '--tasks', tasksFile(tasks), '--owner', OWNER, '--config', o.cfg || CFG].concat(o.flags || []), envOf(fd, o.env));
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  if (j && j.pid) groups.add(j.pid);
  return { p, j };
}
const statusOf = (dir, wait) => { const p = crOf(CR)(['status', dir, '--config', CFG].concat(wait ? ['--wait', String(wait)] : [])); let j = null; try { j = JSON.parse(p.stdout); } catch { /* none */ } return { p, j }; };
const resultOf = (s) => (s.j ? ((statusOf(s.j.runDir, 180).j || {}).results || [])[0] : null);
const registered = (key) => fs.readdirSync(RUNS).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(RUNS, n, 'tasks', `${key}.json`)));
function cleanup() {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } try { process.kill(g, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of fs.readdirSync(W).filter((x) => /^fake\d+$/.test(x))) for (const e of traceOf(path.join(W, d))) if (e.ev === 'start') { try { process.kill(-e.pid, 'SIGKILL'); } catch { /* gone */ } }
}

(async () => {
  try {
    // ---- T1: files left in the task folder under the names of the wait steps
    {
      const t = task('p1', { base: 'arc' });
      const dir = path.join(SHARED, 'p1');
      fs.mkdirSync(dir, { recursive: true });
      const OUT = path.join(W, 'outside');
      fs.mkdirSync(OUT);
      fs.writeFileSync(path.join(dir, 'wait-select-1.json'), JSON.stringify({ pid: 1, started: 1, cmd: 'x', cwd: dir }));
      fs.writeFileSync(path.join(dir, 'wait-select-1.rc'), '1\n');
      fs.symlinkSync(path.join(OUT, 'select.log'), path.join(dir, 'wait-select-1.log'));
      fs.writeFileSync(path.join(dir, 'wait-train-1.json'), JSON.stringify({ pid: 1, started: 1, cmd: 'x', cwd: dir }));
      fs.writeFileSync(path.join(dir, 'wait-train-1.rc'), '11\n');
      fs.symlinkSync(path.join(OUT, 'train.log'), path.join(dir, 'wait-train-1.log'));
      fs.symlinkSync(path.join(OUT, 'leftovers.md'), path.join(dir, 'leftovers.md'));
      fs.writeFileSync(KLOG, '');
      const fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
      const s = start([t], fd, { cr: CR_PLUG, cfg: CFG_SEL });
      const r = resultOf(s);
      const sd = s.j && path.join(s.j.runDir, 'steps', 'p1');
      const selLog = (() => { try { return fs.readFileSync(path.join(sd, 'wait-select-1.log'), 'utf8'); } catch { return ''; } })();
      ok('T1 the chain with a selection and a train runs under the conductor and ends done (the planted exit codes 1 and 11 are not its verdicts)',
        !!r && r.status === 'done', JSON.stringify(r) + ' ' + (s.p.stderr || '').slice(-600));
      ok('T1 the selection command ran (its mark), its log is in the steps folder of the run', fs.existsSync(SEL_MARK) && /stub selection --select/.test(selLog), selLog);
      ok('T1 the train ran as its own wait step in the steps folder', (() => { try { return /stub train ride/.test(fs.readFileSync(path.join(sd, 'wait-train-1.log'), 'utf8')); } catch { return false; } })());
      ok('T1 nothing was written through the links of the task folder', !fs.readdirSync(OUT).length, fs.readdirSync(OUT).join());
      ok('T1 the planted files of the task folder are as they were', fs.readFileSync(path.join(dir, 'wait-select-1.rc'), 'utf8') === '1\n' && fs.readFileSync(path.join(dir, 'wait-train-1.rc'), 'utf8') === '11\n'
        && fs.lstatSync(path.join(dir, 'wait-select-1.log')).isSymbolicLink() && !fs.existsSync(path.join(dir, 'wait-select-1.prev.json')));
      const bad = kills().filter((k) => [1, 0, -1].includes(k.pid) && k.sig !== 0 && k.sig !== '0');
      ok('T1 no signal to pid 1, 0 or -1 from any process of the run', !bad.length, JSON.stringify(bad));
      // leftovers.md is written only when something was left (role-leftovers-check.js); its path is held by the
      // programmer's X2 cell, and the link of the task folder above stayed untouched.
    }

    // ---- T2: SIGKILL of the conductor after the programmer committed, before its result
    {
      const t = task('k2');
      const wt = path.join(WTR, t.wt);
      const A = git('-C', wt, 'rev-parse', 'HEAD').stdout.trim();
      const fd = fake({ programmer: [{ $sleep: 120, then: PROG }, PROG], tester: [GREEN], reviewer: [DONE] });
      const s = start([t], fd, { flags: ['--bin', BIN_COMMIT], env: { COMMIT_WT: wt } });
      const moved = until(() => git('-C', wt, 'rev-parse', `refs/heads/${t.branch}`).stdout.trim() !== A, 60000);
      const role = until(() => starts(fd, 'programmer')[0]);
      if (s.j) process.kill(s.j.pid, 'SIGKILL');
      until(() => !s.j || !alive(s.j.pid), 5000);
      const B = git('-C', wt, 'rev-parse', 'HEAD').stdout.trim();
      ok('T2 the programmer committed, then the conductor got SIGKILL', moved && !!role && B !== A && !!s.j && !alive(s.j.pid), `${A} ${B}`);
      const st = statusOf(s.j.runDir);
      const open = st.j && st.j.tasks && JSON.stringify(st.j.tasks);
      ok('T2 status of the killed run: dead (exit 4), the programmer step open', st.p.status === 4 && st.j && st.j.state === 'dead' && /prog:k2#1/.test(open || ''), st.p.stdout);
      const s2 = start([t], fd, { flags: ['--bin', BIN_COMMIT], env: { COMMIT_WT: wt } });
      const why2 = (s2.j && s2.j.tasks && s2.j.tasks.k2) || '';
      resultOf(s2);
      ok('T2 the next start while the role lives: refused by the reconciliation, "alive", the step and its run named',
        /^undetermined/.test(why2) && /alive/.test(why2) && why2.includes(s.j.runId) && /prog:k2#1/.test(why2), why2);
      ok('T2 ... the programmer is not called again and no second commit', starts(fd, 'programmer').length === 1 && git('-C', wt, 'rev-list', '--count', `${A}..HEAD`).stdout.trim() === '1');
      // the role is the group of the wrapper (the fake CLI is its child)
      const pg = +String(spawnSync('ps', ['-o', 'pgid=', '-p', String(role.pid)], { encoding: 'utf8' }).stdout).trim();
      if (pg > 1) { try { process.kill(-pg, 'SIGKILL'); } catch { /* gone */ } }
      until(() => !alive(role.pid) && !(pg > 1 && alive(pg)), 5000);
      const s3 = start([t], fd, { flags: ['--bin', BIN_COMMIT], env: { COMMIT_WT: wt } });
      const why3 = (s3.j && s3.j.tasks && s3.j.tasks.k2) || '';
      resultOf(s3);
      ok('T2 after the role ended: still refused, "gone", "no result recorded"; no role, no commit', /^undetermined/.test(why3) && /gone/.test(why3) && /no result recorded/.test(why3)
        && starts(fd, 'programmer').length === 1 && git('-C', wt, 'rev-list', '--count', `${A}..HEAD`).stdout.trim() === '1', why3);
      ok('T2 only the killed run is registered for the task', registered('k2').length === 1, registered('k2').join());
    }

    // ---- T3: two starts at once over a free lock
    {
      const t = task('f3');
      const fd = fake({ programmer: [{ $sleep: 4, then: PROG }, PROG], tester: [GREEN, GREEN], reviewer: [DONE, DONE] });
      const tf = tasksFile([t]);
      const both = await Promise.all([0, 1].map(() => new Promise((res) => {
        const c = spawn(process.execPath, [CR, 'start', '--host', 'claude', '--tasks', tf, '--owner', OWNER, '--config', CFG], { env: envOf(fd), stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        c.stdout.on('data', (d) => { o += d; });
        c.on('close', () => { try { const j = JSON.parse(o); groups.add(j.pid); res(j); } catch { res(null); } });
      })));
      const rs = both.map((j) => (j ? ((statusOf(j.runDir, 180).j || {}).results || [])[0] : null));
      ok('T3 two starts of one task at once over a free lock: one registered run, one done, the other "another conductor"',
        registered('f3').length === 1 && rs.filter((x) => x && x.status === 'done').length === 1 && rs.filter((x) => x && x.status === 'stopped' && /another conductor/.test(x.why)).length === 1
        && starts(fd, 'programmer').length === 1, JSON.stringify(rs) + ' ' + registered('f3').join());
      const s = start([t], fd);
      const r = resultOf(s);
      ok('T3 the next start after the winner ended goes and ends done', s.j && s.j.tasks.f3 === 'held' && r && r.status === 'done' && registered('f3').length === 2, JSON.stringify(r) + ' ' + JSON.stringify(s.j && s.j.tasks));
    }

    // ---- T4: status of a run whose conductor's liveness is unknown
    {
      const sl = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      groups.add(sl.pid);
      until(() => lstartOf(sl.pid));
      const rd = path.join(W, 'st', 'runs', 'U1');
      fs.mkdirSync(rd, { recursive: true });
      fs.writeFileSync(path.join(rd, 'request.json'), JSON.stringify({ runId: 'U1' }));
      fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ runId: 'U1', pid: sl.pid }));
      let st = statusOf(rd);
      ok('T4 a live pid without a start time: running (exit 3), not dead', st.p.status === 3 && st.j && st.j.state === 'running', st.p.stdout + st.p.stderr);
      fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ runId: 'U1', pid: sl.pid, lstart: lstartOf(sl.pid) }));
      const NOPS = path.join(W, 'nops');
      fs.mkdirSync(NOPS);
      fs.writeFileSync(path.join(NOPS, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const p = spawnSync(process.execPath, [CR, 'status', rd, '--config', CFG], { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: `${NOPS}${path.delimiter}${process.env.PATH}` }) });
      let j = null; try { j = JSON.parse(p.stdout); } catch { /* none */ }
      ok('T4 ps failing while the pid exists: running (exit 3), not dead', p.status === 3 && j && j.state === 'running', p.stdout + p.stderr);
      const gone = new Promise((res) => sl.on('exit', res));
      process.kill(-sl.pid, 'SIGKILL');
      await gone;
      st = statusOf(rd);
      ok('T4 ... the pid gone: dead (exit 4)', st.p.status === 4 && st.j && st.j.state === 'dead', st.p.stdout);
    }
  } finally {
    cleanup();
  }
  sleepMs(300);
  const left = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(W) && !l.includes(' ps '));
  ok('T no process of these cells remains', !left.length, left.join('\n'));
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  done();
})().catch((e) => { cleanup(); console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
