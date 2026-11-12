'use strict';
// The tester cells of the heavy channel (p-codex A2b-1b), a child of tests/heavy-channel.test.js with its own tally:
//   TB1 resolve --heavy on an undetermined run whose group is gone: the run is closed (done with the code of its file
//       rc), its marker removed, and the start check passes again - resolve is the only way out of undetermined (UC-4 2a);
//   TB2 resolve --heavy on an undetermined run whose group lives with the leader of its record: the group is stopped;
//   TB3 the conductor itself: a codex task whose heavy journal holds an undetermined run stops before any role, naming
//       resolve --heavy (chain-run.js conduct, not only the function heavyJournalProblem);
//   TB4 a signal of the adapter (cancel 'signalled'): the running command is stopped with "the adapter got a signal",
//       its group gone and its marker removed; the request waiting behind it never starts;
//   TB5 cwd through a link inside the worktree that leads outside, and --cwd .. of the client: refused, no holder;
//   TB6 a new call after a dead adapter whose command ended (rc file there): the run is closed as done (recovered),
//       the stale marker removed, and the new call runs requests;
//   TB7 the probe fails: every request refused "environment: no safe executor", no holder in the slot queue;
//   TB8 an id of an earlier call sent again in a new call: no second run, the answer names its state;
//   TB9-TB12 the run's config (o.config) against the worktree's and the environment's: the holder and the nested heavy.sh
//       use the run's slot directory (TB9), the conductor passes an absolute configPath (TB10), the exclusive check reads
//       the run's guardExclusive (TB11), and the nested heavy.sh takes the exclusive lock by it (TB12, B'12).
//   TB13 kind tsc (medium) with the run's config at a path with a blank: the medium slot of the run's directory and
//       CODIS_AGENTS_CONFIG of the command = the run's config.
// Like the parent: real slot-hold.sh and heavy.sh on a slot directory of the test, the executor outside codex sandbox,
// the pauses at 2 s, a fake machine; the conductor with the fake codex of tests/fixtures/chain-run/bin (no model).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const CHAIN = path.join(S, 'chain-run.js');
const FAKE_BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');

for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-tc-')));
const kids = new Set();
process.on('exit', () => { for (const p of kids) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(T, { recursive: true, force: true }); });
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const id32 = () => crypto.randomBytes(16).toString('hex');
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
let caseN = 0;
function setup() {
  const c = path.join(T, `c${++caseN}`);
  const d = { root: c, slots: path.join(c, 'slots'), wt: path.join(c, 'wt'), tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.slots, d.wt, d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: d.slots, SLOT_JOURNAL: path.join(d.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' });
  return d;
}
const boxOf = (d, call) => path.join(d.tdir, 'calls', call, 'heavy');
function open(d, call, inject) {
  return HS.openHeavyService({ task: 'K', callId: call, role: 'prog', wt: d.wt, tdir: d.tdir, box: boxOf(d, call), stateDir: d.state,
    kinds: {}, userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200,
    inject: Object.assign({ probe: async () => ({}), executor: (spec) => Object.assign({}, spec, { bin: spec.inner[0], args: spec.inner.slice(1) }) }, inject || {}) });
}
const answersOf = (d, call) => path.join(d.state, 'K', 'heavy-calls', call);
const answer = (d, call, id) => { try { return JSON.parse(fs.readFileSync(path.join(answersOf(d, call), `${id}.json`), 'utf8')); } catch { return null; } };
const FINAL = ['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused'];
const final = (d, call, id, ms) => until(() => { const a = answer(d, call, id); return a && FINAL.includes(a.state) ? a : null; }, ms);
const put = (d, call, id, body) => {
  const tmp = path.join(boxOf(d, call), `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(boxOf(d, call), `${id}.json`));
};
const jfOf = (d) => path.join(d.state, 'K', 'heavy.jsonl');
const journal = (d) => { try { return fs.readFileSync(jfOf(d), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const evs = (d, id) => journal(d).filter((e) => e.id === id).map((e) => e.ev);
const slotLines = (d) => { try { return fs.readFileSync(path.join(d.slots, 'journal.tsv'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const markers = (d) => fs.readdirSync(d.slots).filter((f) => /\.exec(tmp)?\./.test(f));
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const req = (d, call, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: boxOf(d, call), CODIS_HEAVY_ANSWERS: answersOf(d, call) }) });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* null */ } resolve({ status: rc, j, out }); });
});
const lstart = (pid) => { const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return String(p.stdout).trim(); };
// a journal of an earlier call: queued + running of one id, then extra lines
const writeJournal = (d, id, run, extra) => {
  fs.mkdirSync(path.dirname(jfOf(d)), { recursive: true });
  let n = 0;
  const line = (o) => JSON.stringify(Object.assign({ v: 1, n: ++n, ts: 'x', call: 'old' }, o));
  const lines = [line({ ev: 'queued', id, hash: 'h-old', kind: null, cls: 'heavy', argv: ['x'], cwd: d.wt }), line(Object.assign({ ev: 'running', id }, run))].concat((extra || []).map(line));
  fs.writeFileSync(jfOf(d), lines.join('\n') + '\n');
};

(async () => {
  // ---- TB1: undetermined, group gone, rc 4 there -> resolve closes it as done 4, the marker removed, start check passes
  {
    const d = setup();
    const dead = +spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    const rd = path.join(d.state, 'K', 'heavy-runs', 'u1');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'started'), ''); fs.writeFileSync(path.join(rd, 'rc'), '4\n');
    const slot = path.join(d.slots, 'heavy.1.lock');
    fs.writeFileSync(`${slot}.exec.${dead}`, `${dead}\n`);
    const id = id32();
    writeJournal(d, id, { pgid: dead, lstart: 'x', slot, log: path.join(rd, 'out.log'), started: path.join(rd, 'started'), rcFile: path.join(rd, 'rc') }, [{ ev: 'undetermined', id, why: 'environment: run undetermined' }]);
    const before = HS.journalProblem(jfOf(d));
    const rv = spawnSync(process.execPath, [CHAIN, 'resolve', '--heavy', d.state, '--task', 'K', '--run', id, 'stop'], { encoding: 'utf8' });
    const r = HS.readHeavyJournal(jfOf(d)).runs.get(id);
    ok('TB1 resolve --heavy on an undetermined run whose group is gone: exit 0, closed as done with the rc of its file',
      /undetermined/.test(before || '') && rv.status === 0 && r && r.state === 'done' && r.rc === 4, `${before} | ${rv.status} ${rv.stdout} ${rv.stderr} | ${J(r)}`);
    ok('TB1 its marker is removed and the start check passes again', !fs.existsSync(`${slot}.exec.${dead}`) && HS.journalProblem(jfOf(d)) === null, `${markers(d)} ${HS.journalProblem(jfOf(d))}`);
    const rv2 = spawnSync(process.execPath, [CHAIN, 'resolve', '--heavy', d.state, '--task', 'K', '--run', id, 'stop'], { encoding: 'utf8' });
    ok('TB1 a second resolve of the closed run is refused "nothing to stop"', rv2.status === 1 && /nothing to stop/.test(rv2.stdout + rv2.stderr), rv2.stdout + rv2.stderr);
  }

  // ---- TB2: undetermined, the group lives with the leader of its record -> resolve stops it
  {
    const d = setup();
    // a group of its own whose parent is gone (as the gate of a dead adapter): launchd reaps it, so no zombie of this
    // test keeps the group alive while spawnSync blocks the loop; its leader ignores TERM, so only KILL ends it
    const g = { pid: +spawnSync('/bin/sh', ['-c', 'perl -e \'setpgrp(0,0); $SIG{TERM}="IGNORE"; exec @ARGV\' sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim() };
    kids.add(g.pid);
    await sleep(300);
    const id = id32();
    writeJournal(d, id, { pgid: g.pid, lstart: lstart(g.pid), slot: path.join(d.slots, 'heavy.1.lock'), log: '/x', started: '/x', rcFile: path.join(d.root, 'no-rc') }, [{ ev: 'undetermined', id, why: 'x' }]);
    const rv = spawnSync(process.execPath, [CHAIN, 'resolve', '--heavy', d.state, '--task', 'K', '--run', id, 'stop'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_HEAVY_KILL_GRACE_MS: '1000', CODIS_HEAVY_EMPTY_WAIT_MS: '2000' }) });
    const r = HS.readHeavyJournal(jfOf(d)).runs.get(id);
    ok('TB2 resolve --heavy on an undetermined run whose group lives (leader matches): the group is stopped (KILL after the pause), stopped by resolve',
      rv.status === 0 && !groupAlive(g.pid) && r && r.state === 'stopped' && HS.journalProblem(jfOf(d)) === null, `${rv.status} ${rv.stdout} ${rv.stderr} ${J(r)}`);
  }

  // ---- TB4: a signal of the adapter stops the running command; the request behind it never starts
  {
    const d = setup();
    const svc = open(d, 'prog-1');
    const p1 = req(d, 'prog-1', ['--max', '30', '--', 'zsh', '-c', 'trap "" TERM; echo started > started.txt; sleep 60']);
    const run = await until(() => journal(d).find((e) => e.ev === 'running'));
    await until(() => fs.existsSync(path.join(d.wt, 'started.txt')));
    const p2 = req(d, 'prog-1', ['--max', '30', '--', 'zsh', '-c', 'echo x > second.txt']);
    await until(() => journal(d).filter((e) => e.ev === 'queued').length === 2);
    const t0 = Date.now();
    svc.cancel('signalled');
    const [a1, a2] = [(await p1).j, (await p2).j];
    ok('TB4 the running command: stopped "the adapter got a signal", after TERM, the pause and KILL; its group gone, no marker',
      a1 && a1.state === 'stopped' && /the adapter got a signal/.test(a1.why || '') && !!run && !groupAlive(run.pgid) && markers(d).length === 0 && Date.now() - t0 >= 1800, `${J(a1)} ${markers(d)} ${Date.now() - t0}`);
    ok('TB4 the request behind it: cancelled-before-start, never held, its command never ran', a2 && a2.state === 'cancelled-before-start' && !evs(d, a2.id).includes('holding') && !fs.existsSync(path.join(d.wt, 'second.txt')), J(a2));
    await svc.close();
  }

  // ---- TB5: cwd through a link out of the worktree; --cwd ..
  {
    const d = setup();
    const outside = path.join(d.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(d.wt, 'link-out'));
    const svc = open(d, 'prog-1');
    const before = slotLines(d).length;
    const i1 = id32();
    put(d, 'prog-1', i1, { argv: ['zsh', '-c', 'echo x > ran.txt'], cwd: path.join(d.wt, 'link-out') });
    const a1 = await final(d, 'prog-1', i1, 5000);
    const a2 = (await req(d, 'prog-1', ['--cwd', '..', '--max', '5', '--', 'zsh', '-c', 'echo x > ran.txt'])).j;
    ok('TB5 cwd through a link inside the worktree that leads outside: refused "outside the worktree"', a1 && a1.state === 'refused' && /outside the worktree/.test(a1.why || ''), J(a1));
    ok('TB5 heavy-req --cwd ..: refused "outside the worktree"', a2 && a2.state === 'refused' && /outside the worktree/.test(a2.why || ''), J(a2));
    ok('TB5 nothing ran, no holder', !fs.existsSync(path.join(outside, 'ran.txt')) && !fs.existsSync(path.join(d.root, 'ran.txt')) && slotLines(d).length === before, `${slotLines(d).length - before}`);
    await svc.close();
  }

  // ---- TB6 and TB8: a new call after a dead adapter whose command ended
  {
    const d = setup();
    const dead = +spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
    const rd = path.join(d.state, 'K', 'heavy-runs', 'old');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'started'), ''); fs.writeFileSync(path.join(rd, 'rc'), '0\n');
    const slot = path.join(d.slots, 'heavy.1.lock');
    fs.writeFileSync(`${slot}.exec.${dead}`, `${dead}\n`);
    const id = id32();
    writeJournal(d, id, { pgid: dead, lstart: 'x', slot, log: path.join(rd, 'out.log'), started: path.join(rd, 'started'), rcFile: path.join(rd, 'rc') });
    fs.mkdirSync(boxOf(d, 'prog-2'), { recursive: true });
    // TB8: the id of the earlier call, sent again in the new call
    put(d, 'prog-2', id, { argv: ['zsh', '-c', 'echo again >> again.txt'] });
    const svc = open(d, 'prog-2');
    const rec = journal(d).find((e) => e.id === id && e.recovered);
    ok('TB6 the new call closes the earlier run as done (recovered) and removes its stale marker', !!rec && rec.ev === 'done' && rec.rc === 0 && !fs.existsSync(`${slot}.exec.${dead}`), `${J(rec)} ${markers(d)}`);
    const a = (await req(d, 'prog-2', ['--max', '20', '--', 'zsh', '-c', 'echo new > new.txt'])).j;
    ok('TB6 the new call runs a new request (the recovered run does not block the task)', a && a.state === 'done' && a.rc === 0 && fs.existsSync(path.join(d.wt, 'new.txt')), J(a));
    const old = await until(() => answer(d, 'prog-2', id), 3000);
    ok('TB8 the id of the earlier call: no second run, the answer names its state', !fs.existsSync(path.join(d.wt, 'again.txt')) && old && old.state === 'done' && evs(d, id).filter((e) => e === 'running').length === 1, J(old));
    await svc.close();
  }

  // ---- TB7: the probe fails -> refused "environment: no safe executor", no holder
  {
    const d = setup();
    const svc = open(d, 'prog-1', { probe: async () => ({ error: 'the system TMPDIR is writable' }) });
    const a = (await req(d, 'prog-1', ['--max', '10', '--', 'zsh', '-c', 'echo x > ran.txt'])).j;
    ok('TB7 the probe failed: refused "environment: no safe executor: <why>", the command never ran, no holder in the slot queue',
      a && a.state === 'refused' && /^environment: no safe executor: the system TMPDIR is writable/.test(a.why || '') && !fs.existsSync(path.join(d.wt, 'ran.txt')) && slotLines(d).length === 0 && !evs(d, a.id).includes('holding'), `${J(a)} ${slotLines(d).length}`);
    await svc.close();
  }

  // ---- TB3: the conductor refuses a codex task whose heavy journal holds an undetermined run, before any role
  if (spawnSync('git', ['--version']).status === 0) {
    const W = path.join(T, 'conduct');
    const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RTMP = path.join(W, 'rtmp'), HOME = path.join(W, 'home');
    for (const x of [REPO, RTMP, HOME, WTR]) fs.mkdirSync(x, { recursive: true });
    const GENV = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@s' });
    const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null'].concat(a), { cwd, encoding: 'utf8', env: GENV });
    git(REPO, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
    git(REPO, 'add', 'a.js');
    git(REPO, 'commit', '-q', '-m', 'base');
    git(REPO, 'worktree', 'add', '-q', '-b', 'b-h1', path.join(WTR, 'w-h1'), 'HEAD');
    const cfg = path.join(W, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'], commitAuthor: { name: 'a', email: 'a@example.com' }, slots: { kinds: { tsc: 'medium' } } }));
    const owner = path.join(W, 'owner.txt');
    fs.writeFileSync(owner, 'the owner asked for the test task');
    const hj = path.join(SHARED, 'runs', '.commit', 'h1');
    fs.mkdirSync(hj, { recursive: true });
    const id = id32();
    fs.writeFileSync(path.join(hj, 'heavy.jsonl'), [{ v: 1, n: 1, ts: 'x', call: 'c1', ev: 'queued', id, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] },
      { v: 1, n: 2, ts: 'x', call: 'c1', ev: 'undetermined', id, why: 'x' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const before = fs.readFileSync(path.join(hj, 'heavy.jsonl'), 'utf8');
    const fd = path.join(W, 'fake');
    fs.mkdirSync(fd);
    fs.writeFileSync(path.join(fd, 'answers.json'), JSON.stringify({}));
    const chome = path.join(W, 'codex-home');
    fs.mkdirSync(chome);
    fs.writeFileSync(path.join(chome, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
    const tf = path.join(W, 'tasks.json');
    fs.writeFileSync(tf, JSON.stringify([{ key: 'h1', title: 'H1', wt: 'w-h1', branch: 'b-h1', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }]));
    const env = Object.assign({}, process.env, { PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd, TMPDIR: RTMP, HOME, GIT_CONFIG_NOSYSTEM: '1' });
    const p = spawnSync(process.execPath, [CHAIN, 'start', '--host', 'codex', '--codex-home', chome, '--tasks', tf, '--owner', owner, '--config', cfg], { encoding: 'utf8', env, timeout: 180000 });
    let j = null;
    try { j = JSON.parse(p.stdout); kids.add(j.pid); } catch { /* below */ }
    let st = null;
    if (j) { const s = spawnSync(process.execPath, [CHAIN, 'status', j.runDir, '--config', cfg, '--wait', '170'], { encoding: 'utf8', env, timeout: 200000 }); try { st = JSON.parse(s.stdout); } catch { /* below */ } }
    const trace = (() => { try { return fs.readFileSync(path.join(fd, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const why = String(j && j.tasks && j.tasks.h1);
    const r = st && st.results && st.results[0];
    ok('TB3 the conductor: a codex task with an undetermined run in its heavy journal stops before any role, naming the journal, the run and resolve --heavy',
      why.includes(path.join(hj, 'heavy.jsonl')) && why.includes(id) && /resolve --heavy/.test(why) && !trace.some((e) => e.ev === 'start'), `${why} | ${p.stdout} ${p.stderr}`.slice(0, 2000));
    ok('TB3 the result is stopped with that reason; the heavy journal is not changed', !!r && r.status === 'stopped' && /resolve --heavy/.test(String(r.why)) && fs.readFileSync(path.join(hj, 'heavy.jsonl'), 'utf8') === before, J(r));
  } else ok('TB3 needs git', false, 'git not found');

  // ---- TB9-TB12: the run's config (o.config) against what a lookup from the worktree or the adapter's environment finds
  // A case of its own: no SLOTS_DIR / SLOT_JOURNAL in the adapter's environment, CODIS_AGENTS_CONFIG names another config,
  // HOME is the case's own (no machine file), the run's config has its own guardExclusive (glob *.guard.sh, marker #).
  const cfgCase = (wtCfg) => {
    const d = setup();
    for (const k of ['SLOTS_DIR', 'SLOT_JOURNAL', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR', 'CODIS_AGENTS_MACHINE']) delete d.env[k];
    d.env.HOME = path.join(d.root, 'home');
    fs.mkdirSync(d.env.HOME);
    const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: d.root, worktreeRoot: d.root, sharedDir: d.root }, o))); return f; };
    const c = { run: path.join(d.root, 'run-slots'), other: path.join(d.root, 'other-slots'), wtSlots: path.join(d.root, 'wt-slots') };
    c.runCfg = write(path.join(d.root, 'run-cfg', 'codis-agents.json'), { slots: { lockDir: c.run, kinds: { tsc: 'medium' } }, guardExclusive: { glob: ['*.guard.sh'], marker: '#' } });
    d.env.CODIS_AGENTS_CONFIG = write(path.join(d.root, 'other-cfg', 'codis-agents.json'), { slots: { lockDir: c.other } });
    if (wtCfg) write(path.join(d.wt, '.claude', 'codis-agents.json'), Object.assign({ slots: { lockDir: c.wtSlots } }, wtCfg === true ? {} : wtCfg));
    const holds = (dir) => { try { return fs.readFileSync(path.join(dir, 'journal.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')).filter((l) => l[6] === 'hold'); } catch { return []; } };
    c.counts = () => ({ run: holds(c.run).length, other: holds(c.other).length, wt: holds(c.wtSlots).length, fallback: holds(path.join(d.env.HOME, '.cache', 'codis-agents', 'slots')).length });
    // an exclusive guard of the run's config: it reports whether the exclusive lock is held while it runs
    fs.writeFileSync(path.join(d.wt, 'port.guard.sh'), '# guards:exclusive — a fixed port\nif /usr/bin/lockf -t 0 "$GUARDS_EXCLUSIVE_LOCK" true; then echo LOCK-FREE; else echo LOCK-HELD; fi\n');
    return { d, c };
  };
  const openCfg = (d, call, config, kinds) => HS.openHeavyService({ task: 'K', callId: call, role: 'prog', wt: d.wt, tdir: d.tdir, box: boxOf(d, call), stateDir: d.state,
    config, kinds: kinds || {}, userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200,
    inject: { probe: async () => ({}), executor: (spec) => Object.assign({}, spec, { bin: spec.inner[0], args: spec.inner.slice(1) }) } });
  const logOf = (d, id) => { const r = journal(d).find((e) => e.id === id && e.ev === 'running'); try { return r ? fs.readFileSync(r.log, 'utf8') : ''; } catch { return ''; } };
  const clsOf = (d, id) => { const q = journal(d).find((e) => e.id === id && e.ev === 'queued'); return q ? q.cls : null; };

  // TB9: the worktree has a config of its own (another lockDir): the holder and the nested heavy.sh of the executor both
  // use the slot of the run's config; nothing queues in the worktree's or the environment's directory
  {
    const { d, c } = cfgCase(true);
    const svc = openCfg(d, 'prog-1', c.runCfg);
    const a = (await req(d, 'prog-1', ['--max', '20', '--', 'node', '-e', 'console.log("SP " + process.env.SLOT_PATH)'])).j;
    const sp = (/SP (\S+)/.exec(logOf(d, a && a.id)) || [])[1] || '';
    ok('TB9 the worktree names another lockDir: the hold line is in the lockDir of the run\'s config, none in the worktree\'s, the environment\'s or <HOME>/.cache',
      a && a.state === 'done' && c.counts().run === 1 && !c.counts().wt && !c.counts().other && !c.counts().fallback, `${J(a)} ${J(c.counts())}`);
    ok('TB9 the nested heavy.sh of the executor runs in the held slot of the run\'s directory (SLOT_PATH), not in a slot of the worktree\'s config',
      path.dirname(sp) === c.run && !fs.existsSync(c.wtSlots), `${sp} | ${logOf(d, a && a.id).slice(0, 400)}`);
    await svc.close();
  }

  // TB10: the conductor's config path: config.js json of a relative --config, and of CODIS_AGENTS_CONFIG, gives an absolute
  // configPath, and adapterCfg passes exactly it as cfg.heavy.config
  {
    const CR = require(CHAIN);
    const W = path.join(T, 'cfgpath');
    fs.mkdirSync(path.join(W, 'sub'), { recursive: true });
    const f = path.join(W, 'sub', 'codis-agents.json');
    fs.writeFileSync(f, JSON.stringify({ repoDir: W, worktreeRoot: W, sharedDir: W, slots: { kinds: { tsc: 'medium' } } }));
    const cwd0 = process.cwd();
    process.chdir(W);
    const rel = CR.loadConfig(path.join('sub', 'codis-agents.json'));
    process.chdir(cwd0);
    const saved = process.env.CODIS_AGENTS_CONFIG;
    process.env.CODIS_AGENTS_CONFIG = f;
    const viaEnv = CR.loadConfig();
    if (saved === undefined) delete process.env.CODIS_AGENTS_CONFIG; else process.env.CODIS_AGENTS_CONFIG = saved;
    const hv = (r) => (r && r.config ? (CR.adapterCfg('codex', { config: r.config, tasks: [] }, { codexHome: path.join(W, 'ch') }, path.join(W, 'calls'), () => {}).heavy || null) : null);
    ok('TB10 a relative --config and CODIS_AGENTS_CONFIG: configPath is the absolute file, and cfg.heavy.config of the adapter is that path with the kinds',
      !!hv(rel) && hv(rel).config === f && hv(rel).kinds.tsc === 'medium' && !!hv(viaEnv) && hv(viaEnv).config === f, J([rel.error, viaEnv.error, hv(rel), hv(viaEnv)]));
  }

  // TB11: the exclusive check before the queue reads the run's config: a guard marked by its guardExclusive is heavy
  // with a kind mapped to medium, while the environment's config (default guardExclusive) would not mark it
  {
    const { d, c } = cfgCase(false);
    const svc = openCfg(d, 'prog-1', c.runCfg, { tsc: 'medium' });
    const a = (await req(d, 'prog-1', ['--kind', 'tsc', '--max', '20', '--', 'zsh', 'port.guard.sh'])).j;
    ok('TB11 a guard marked exclusive by the run\'s config, kind tsc (medium): its class is heavy', a && a.state === 'done' && clsOf(d, a.id) === 'heavy', `${J(a)} cls ${clsOf(d, a && a.id)}`);
    const b = (await req(d, 'prog-1', ['--kind', 'tsc', '--max', '20', '--', 'true'])).j;
    ok('TB11 ... and an unmarked command of kind tsc stays medium', b && b.state === 'done' && clsOf(d, b.id) === 'medium', `${J(b)} cls ${clsOf(d, b && b.id)}`);
    await svc.close();
  }

  // TB12: the executor's nested heavy.sh takes the exclusive lock for a guard marked by the run's config, also when the
  // worktree holds no config (the case of B'10: the run's config lies elsewhere); control - a worktree with the same config
  for (const [name, wtCfg] of [['the worktree has no config', false], ['the worktree has the same guardExclusive', { guardExclusive: { glob: ['*.guard.sh'], marker: '#' } }]]) {
    const { d, c } = cfgCase(wtCfg);
    const svc = openCfg(d, 'prog-1', c.runCfg);
    const a = (await req(d, 'prog-1', ['--max', '20', '--', 'zsh', 'port.guard.sh'])).j;
    const out = logOf(d, a && a.id);
    ok(`TB12 ${name}: the exclusive guard of the run's config runs under the exclusive lock (B'12)`, a && a.state === 'done' && /LOCK-HELD/.test(out), `${J(a)} | ${out.slice(0, 400)}`);
    await svc.close();
  }

  // TB13: kind tsc -> medium, the run's config at a path with a blank, the worktree and the environment naming other
  // configs: the nested medium.sh of the executor runs in the medium slot of the run's directory, and the command (with
  // every heavy.sh / medium.sh it calls) sees CODIS_AGENTS_CONFIG = the run's config, not the worktree's or the adapter's
  {
    const { d, c } = cfgCase(true);
    const spaced = path.join(d.root, 'run cfg', 'codis-agents.json');
    fs.mkdirSync(path.dirname(spaced));
    fs.copyFileSync(c.runCfg, spaced);
    const svc = openCfg(d, 'prog-1', spaced, { tsc: 'medium' });
    const a = (await req(d, 'prog-1', ['--kind', 'tsc', '--max', '20', '--', 'node', '-e', 'console.log("SP " + process.env.SLOT_PATH); console.log("CFG=" + process.env.CODIS_AGENTS_CONFIG + "=")'])).j;
    const out = logOf(d, a && a.id);
    const sp = (/SP (\S+)/.exec(out) || [])[1] || '';
    ok('TB13 kind tsc (medium) with the run\'s config at a path with a blank: the nested medium.sh runs in a medium slot of the run\'s directory',
      a && a.state === 'done' && a.rc === 0 && clsOf(d, a.id) === 'medium' && path.dirname(sp) === c.run && /^medium\.\d+\.lock$/.test(path.basename(sp)) && !c.counts().wt && !c.counts().other,
      `${J(a)} sp ${sp} ${J(c.counts())} | ${out.slice(0, 400)}`);
    ok('TB13 ... and the command sees CODIS_AGENTS_CONFIG = the run\'s config (not the worktree\'s, not the adapter\'s)',
      out.includes(`CFG=${spaced}=`), out.slice(0, 400));
    await svc.close();
  }
  done();
})().catch((e) => { ok('the tester cases ran to their end', false, e.stack); done(); });
