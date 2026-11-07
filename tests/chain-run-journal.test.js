#!/usr/bin/env node
'use strict';
// The conductor with its journal, as processes (p-codex-B1-b1): cells S1, S2, S12a, S14, S23, E13, G30 and the place of the
// state (owner 2026-11-07): <sharedDir>/runs/<runId>/ holds the journal, the snapshot and the writer lock, the task lock
// lies in <sharedDir>/runs/.locks/, nothing of it in the task folder; a sharedDir inside a write root of a role refuses
// the start; a second writer of a run folder is refused; a role's answer never becomes an event. Roles go to the fake CLIs
// of tests/fixtures/chain-run/bin, no model is called. Every process a check starts is killed in the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');
const CRM = require('../scripts/chain-run.js');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-j-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo');
const CFG = path.join(W, 'codis-agents.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const worktree = (name) => { const p = path.join(WTR, name); if (!fs.existsSync(p)) git('-C', REPO, 'worktree', 'add', '-q', '--detach', p, SHA0); return p; };
const OWNER = path.join(W, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test tasks');
const groups = new Set();
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: SHA0, summary: '' };
const RED = { verdict: 'red', head: SHA0, summary: 'a red case' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const task = (key, extra) => {
  const t = Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
  if (typeof t.wt === 'string' && !t.wt.startsWith('/')) worktree(t.wt);
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
const envOf = (fd, extra) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd }, extra || {});
const tasksFile = (tasks) => { const f = path.join(W, `tasks${++nTasks}.json`); fs.writeFileSync(f, JSON.stringify(tasks)); return f; };
const cr = (args, env, timeout) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: timeout || 120000 });
function start(tasks, fd, cfg) {
  const p = cr(['start', '--host', 'claude', '--tasks', tasksFile(tasks), '--owner', OWNER, '--config', cfg || CFG], envOf(fd));
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  if (j && j.pid) groups.add(j.pid);
  return { p, j };
}
const status = (run, wait, timeout) => {
  const p = cr(['status', run, '--config', CFG].concat(wait === undefined ? [] : ['--wait', String(wait)]), undefined, timeout);
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  return { p, j };
};
const finished = (j) => status(j.runDir, 120);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function until(cond, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = cond(); if (v) return v; sleepMs(50); } return cond(); }
const events = (runDir, key) => {
  const d = path.join(runDir, 'journal', key);
  return fs.readdirSync(d).filter((f) => /^seg-/.test(f)).sort().flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const ofStep = (ev, label) => { const i = ev.find((e) => e.type === 'intent' && e.label === label); return i ? ev.filter((e) => e.stepId === i.stepId) : []; };
const mkfifo = (f) => spawnSync('mkfifo', [f]).status === 0;
const threwNot = (f) => { try { f(); return true; } catch { return false; } };
const cleanup = () => {
  for (const g of groups) { try { process.kill(g, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of fs.readdirSync(W).filter((x) => /^fake\d+$/.test(x))) for (const e of traceOf(path.join(W, d))) if (e.ev === 'start') { try { process.kill(-e.pid, 'SIGKILL'); } catch { /* gone */ } }
};

(async () => {
  try {
    // ---- S1, E11 through the conductor: the place, the order, the registration before the role runs
    let fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
    let s = start([task('g1')], fd);
    let st = finished(s.j);
    ok('the run ends done', st.j && st.j.state === 'finished' && st.j.results[0].status === 'done', JSON.stringify(st.j));
    const rd = s.j.runDir;
    ok('the place: journal and snapshot under <sharedDir>/runs/<runId>/journal/<key>/', rd.startsWith(path.join(SHARED, 'runs') + path.sep) && fs.existsSync(path.join(rd, 'journal', 'g1', 'seg-000.jsonl')) && fs.existsSync(path.join(rd, 'journal', 'g1', 'run-state.json')));
    const tdir = path.join(SHARED, 'g1');
    ok('the place: no journal, snapshot or lock in the task folder', !fs.readdirSync(tdir).some((f) => /journal|run-state|\.lock/.test(f)), fs.readdirSync(tdir).join(' '));
    let ev = events(rd, 'g1');
    ok('S1 consecutive seq, version and runId on every line', ev.every((e, i) => e.seq === i + 1 && e.v === CJ.VERSION && e.runId === s.j.runId), JSON.stringify(ev[0]));
    const prog = ofStep(ev, 'prog:g1#1');
    ok('S1 a role: intent, launch, result, in that order, one stepId', prog.map((e) => e.type).join('>') === 'intent>launch>result' && prog[0].effect === 'never' && prog[0].gated === true, JSON.stringify(prog));
    const tr = starts(fd, 'programmer')[0];
    ok('E11 the launch of the role is its real process: pid, group, start time, registered before the CLI ran', prog[1] && prog[1].pid === tr.pid && prog[1].pgid === tr.pid && typeof prog[1].lstart === 'string' && Date.parse(prog[1].at) <= tr.ms && !!prog[1].callDir, JSON.stringify([prog[1], tr.ms]));
    ok('S1 the intent carries the git HEAD of the worktree at that moment', prog[0].gitHead === SHA0, prog[0].gitHead);
    ok('S1 the result carries the outcome of the adapter and the object of the step', prog[2].outcome === 'ok' && prog[2].value && prog[2].value.status === 'ready', JSON.stringify(prog[2]));
    ok('S1 every role of the run has its three lines', ['pre:g1', 'test:g1#1', 'review:g1#1'].every((l) => ofStep(ev, l).map((e) => e.type).join('>') === 'intent>launch>result'), ev.map((e) => e.label || e.type).join(' '));
    const steps = ev.filter((e) => e.type === 'intent').map((e) => e.stepId);
    ok('G25 a stepId is unique in the run and is not the label', new Set(steps).size === steps.length && steps.every((x) => x.startsWith(`${s.j.runId}:`)), steps.join(' '));
    ok('S1 the last line is the end of the task, with its status and counts', ev[ev.length - 1].type === 'end' && ev[ev.length - 1].status === 'done' && !!ev[ev.length - 1].counts, JSON.stringify(ev[ev.length - 1]));
    const snap = CJ.readJsonSafe(path.join(rd, 'journal', 'g1', 'run-state.json'));
    ok('S1 S13 the snapshot on disk is the fold of the journal: same seq, nothing open', snap.seq === ev.length && !Object.keys(snap.open).length && snap.ended.status === 'done', JSON.stringify(snap));
    ok('the task lock is gone after the end; the writer lock stays with the folder', !fs.existsSync(path.join(SHARED, 'runs', '.locks', 'g1.lock')) && fs.existsSync(path.join(rd, 'writer.lock')));
    st = status(rd);
    ok('status of a finished run: as before, results first', st.p.status === 0 && st.j.state === 'finished', st.p.stdout);

    // ---- G30: exec steps without a gate
    const env1 = ofStep(ev, 'env:g1');
    ok('G30 a service step: intent, launch, result; not gated, its own process right after the spawn, no group of its own, effect of the step',
      env1.map((e) => e.type).join('>') === 'intent>launch>result' && env1[0].gated === false && env1[0].effect === 'none' && env1[1].pid > 0 && env1[1].gated === false && env1[1].pgid === null, JSON.stringify(env1));
    const post = ofStep(ev, 'post:g1:tester');
    ok('G30 post is idempotent, with its pid', post[0] && post[0].effect === 'idempotent' && post[1].pid > 0, JSON.stringify(post));
    ok('S1 a service step has its result: outcome and object', env1[2].outcome === 'ok' && env1[2].value && env1[2].value.ok !== undefined, JSON.stringify(env1[2]));

    // ---- S2: settled with the counters after the verdict
    fd = fake({ programmer: [PROG, PROG], tester: [RED, GREEN], reviewer: [DONE] });
    s = start([task('c1')], fd);
    st = finished(s.j);
    ev = events(s.j.runDir, 'c1');
    const iRes = ev.findIndex((e) => e.type === 'result' && e.stepId === ofStep(ev, 'test:c1#1')[0].stepId);
    const nextProg = ofStep(ev, 'prog:c1#2')[0];
    const firstSettled = ev.slice(iRes + 1).find((e) => e.type === 'settled');
    ok('S2 the result of the tester is settled before the next intent of the task', firstSettled && firstSettled.stepIds.includes(ev[iRes].stepId) && firstSettled.seq < ev.slice(iRes + 1).find((e) => e.type === 'intent').seq, JSON.stringify(firstSettled));
    // The script counts a red verdict after the tester's post-check, the last step before it takes the verdict.
    const counted = ev.find((e) => e.type === 'settled' && e.counts.testerReds === 1);
    ok('S2 settled carries the counter once the script took the verdict, before the next role starts', counted && counted.seq > ev[iRes].seq && counted.seq < nextProg.seq, JSON.stringify(counted));
    ok('S2 the next intent carries the same counters', nextProg.counts.testerReds === 1, JSON.stringify(nextProg));
    const intentBefore = ofStep(ev, 'test:c1#1')[0];
    ok('S2 the intent before the verdict carries the counters before it', intentBefore.counts.testerReds === 0, JSON.stringify(intentBefore));
    ok('S2 the head of the chain is in the settled line', typeof counted.head === 'string' && counted.head.length > 0, JSON.stringify(counted));
    const posts = ev.filter((e) => e.type === 'intent' && e.label === 'post:c1:tester');
    ok('G25 the same label in two rounds has two stepIds', posts.length === 2 && posts[0].stepId !== posts[1].stepId, JSON.stringify(posts.map((e) => e.stepId)));
    ok('S2 at the end nothing is unsettled', CJ.readJsonSafe(path.join(s.j.runDir, 'journal', 'c1', 'run-state.json')).unsettled.length === 0);

    // ---- S23: status with open steps, and the torn tail in its diagnosis
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
    const wtS = worktree('w-s1');
    s = start([task('s1')], fd);
    const role = until(() => starts(fd, 'programmer')[0]);
    st = status(s.j.runId);
    let o = st.j && st.j.tasks && st.j.tasks.s1 && st.j.tasks.s1.open && st.j.tasks.s1.open[0];
    ok('S23 status of a live run: running, the open step of the journal with its label, stepId and start', st.p.status === 3 && st.j.state === 'running' && o && o.label === 'prog:s1#1' && o.stepId && !!o.since && o.pid === role.pid, st.p.stdout);
    ok('S23 the text names the run, the step, the time, the HEAD at the intent, the process and its state, that there is no result, the call folder',
      o && o.text.includes(s.j.runId) && o.text.includes('prog:s1#1') && o.text.includes(o.since) && o.text.includes(SHA0) && o.text.includes(String(role.pid)) && /alive/.test(o.text) && /no result/.test(o.text) && /prog_s1_1-/.test(o.text), o && o.text);
    ok('S23 the journal summary: seq and the snapshot current', st.j.tasks.s1.journal && st.j.tasks.s1.journal.snapshot === 'current' && st.j.tasks.s1.journal.seq > 0, JSON.stringify(st.j.tasks.s1.journal));
    fs.writeFileSync(path.join(wtS, 'b.js'), '2\n');
    git('-C', wtS, 'add', 'b.js');
    git('-C', wtS, 'commit', '-q', '-m', 'the commit of the role');
    process.kill(s.j.pid, 'SIGKILL');
    until(() => !alive(s.j.pid), 5000);
    const whole = JSON.stringify({ type: 'result', stepId: o.stepId, outcome: 'ok' });
    fs.appendFileSync(path.join(s.j.runDir, 'journal', 's1', 'seg-000.jsonl'), whole.slice(0, 30));
    st = status(s.j.runId);
    o = st.j.tasks.s1.open[0];
    ok('S23 after the conductor died: dead, the step still open, HEAD now and the commits since the intent named', st.p.status === 4 && st.j.state === 'dead' && o && /the commit of the role/.test(o.text) && o.text.includes(git('-C', wtS, 'rev-parse', 'HEAD').stdout.trim()), o && o.text);
    ok('S12a the torn tail is in the diagnosis of status, and the step stays open', st.j.tasks.s1.journal.torn.length === 1 && st.j.tasks.s1.journal.torn[0].bytes === 30 && o.stepId === st.j.tasks.s1.open[0].stepId, JSON.stringify(st.j.tasks.s1.journal));
    process.kill(-role.pid, 'SIGKILL');
    until(() => !alive(role.pid), 5000);
    sleepMs(100);
    st = status(s.j.runId);
    ok('S23 the process gone: said so', /gone/.test(st.j.tasks.s1.open[0].text), st.j.tasks.s1.open[0].text);
    const seg0 = path.join(s.j.runDir, 'journal', 's1', 'seg-000.jsonl');
    fs.writeFileSync(seg0, 'garbage\n' + fs.readFileSync(seg0, 'utf8'));
    st = status(s.j.runId);
    ok('S12b damage inside: status names it, shows no step as read from it', /corrupt/.test(st.j.tasks.s1.journal.error || '') && !st.j.tasks.s1.open.some((x) => x.stepId), JSON.stringify(st.j.tasks.s1));

    // ---- S14 through the conductor: the result cannot be written -> the script does not go on
    fd = fake({ programmer: [{ $sleep: 3, then: PROG }], tester: [GREEN], reviewer: [DONE] });
    s = start([task('w1')], fd);
    until(() => starts(fd, 'programmer')[0]);
    const jd = path.join(s.j.runDir, 'journal', 'w1');
    fs.renameSync(jd, `${jd}.moved`);
    fs.symlinkSync(`${jd}.moved`, jd);
    st = finished(s.j);
    ok('S14 the folder of the journal swapped while the role runs: the task stops with "journal/run-state not written", the tester never runs', st.j && st.j.results[0].status === 'stopped' && /journal\/run-state not written/.test(st.j.results[0].why) && !starts(fd, 'tester').length, JSON.stringify(st.j && st.j.results));

    // S14 at the intent and at the launch, with a fake launcher: nothing runs after the journal refuses.
    {
      const mkRun = () => { const d = path.join(W, `direct${++nFake}`); fs.mkdirSync(d); return d; };
      const config = { sharedDir: path.join(W, 'sd'), worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'], scriptsDir: path.join(ROOT, 'scripts') };
      const runDirect = async (key, failAt, onlyThat) => {
        const dirR = mkRun();
        let n = 0;
        const io = { writeSync: (...a) => { n++; if (failAt && (onlyThat ? n === failAt : n >= failAt)) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(...a); }, fsyncSync: fs.fsyncSync };
        const j = CJ.openJournal(dirR, 'RX', key, { io });
        const steps = CRM.makeSteps({ runId: 'RX', journals: { [key]: j }, table: { [key]: { wt: worktree(`w-${key}`) } }, note: () => {} });
        const launches = [];
        const execs = [];
        const x = await CRM.runScript({ host: 'claude', args: { owner: 'o', config, tasks: [task(key)] }, launch: async (plan) => { launches.push(plan.label); return { output: PRE }; },
          exec: async (step) => { execs.push(step.label); return { value: { ok: true, problems: [], notes: [] } }; }, steps, callsDir: dirR, note: () => {}, log: () => {} });
        return { x, launches, execs, ev: events(dirR, key), dirR };
      };
      let r = await runDirect('i1', 1);
      ok('S14 the very first intent cannot be written: no step runs, the task stops with the cause', !r.execs.length && !r.launches.length && r.x.results[0].status === 'stopped' && /journal\/run-state not written/.test(r.x.results[0].why), JSON.stringify(r.x.results));
      r = await runDirect('i2', 4);
      const it = r.ev.filter((e) => e.type === 'intent');
      ok('S14 a later intent (the role after the env step) cannot be written: its launcher never runs', r.execs.length === 1 && !r.launches.length && /journal\/run-state not written/.test(r.x.results[0].why), JSON.stringify([r.execs, r.launches, r.ev.map((e) => e.type), r.x.results]));
      ok('S14 ... and there is no intent of it in the journal', it.length === 1, JSON.stringify(it));
      r = await runDirect('i3', 6);
      ok('S14 the intent is there, the registration cannot be written: the fake launcher never runs (E13), the task stops', !r.launches.length && ofStep(r.ev, 'pre:i3').map((e) => e.type).join() === 'intent' && /journal\/run-state not written/.test(r.x.results[0].why), JSON.stringify([r.ev.map((e) => e.type), r.x.results]));
      r = await runDirect('i5', 6, true);
      const i5 = r.x.results[0];
      ok('E13 only the registration fails, the result is written: the launcher never runs, the task stops, the adapter names the known cause', !r.launches.length && ofStep(r.ev, 'pre:i5').map((e) => e.type).join() === 'intent,result' && ofStep(r.ev, 'pre:i5')[1].outcome === 'not-registered'
        && /journal\/run-state not written/.test(i5.why) && i5.adapter && i5.adapter[0].outcome === 'not-registered' && i5.adapter[0].cause === 'not-registered', JSON.stringify(i5));
      r = await runDirect('i4');
      const pre = ofStep(r.ev, 'pre:i4');
      ok('E13 a fake launcher and a fake exec are marked in the journal as substitutes, so the launch is not read as "not started"', pre[1] && pre[1].type === 'launch' && pre[1].substitute === true && pre[1].pid === null && ofStep(r.ev, 'env:i4')[1].substitute === true, JSON.stringify(pre));
    }

    // ---- G30: a step of wait-step.js: the launch comes from its answer
    {
      const dirR = path.join(W, `direct${++nFake}`);
      fs.mkdirSync(dirR);
      const j = CJ.openJournal(dirR, 'RW', 'k');
      const steps = CRM.makeSteps({ runId: 'RW', journals: { k: j }, table: { k: { wt: dirR } }, note: () => {} });
      const id = path.join(dirR, 'wait-x');
      const WS = path.join(ROOT, 'scripts', 'wait-step.js');
      const mkStep = (reuse) => ({ kind: 'run', label: 'run:k:x', phase: 'Selection', effect: 'reuse', argv: [process.execPath, WS, 'start', '--id', id, '--cwd', dirR].concat(reuse ? ['--reuse'] : [], ['--', 'sleep 1; echo done']),
        wait: { id, argv: [process.execPath, WS, 'wait', '--id', id, '--max', '30'] }, schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] }, noJson: { done: false, error: '$error' } });
      const v = await CRM.stepExec(steps, mkStep(false), { note: () => {} });
      const e1 = events(dirR, 'k');
      ok('G30 run: the intent names the id of the wait step; the launch is the detached run from the answer of start, not the starter', e1[0].waitId === id && e1[1].type === 'launch' && e1[1].pid === CJ.readJsonSafe(`${id}.json`).pid && e1[1].pgid === e1[1].pid && e1[1].started === true && e1[2].type === 'result' && v.done === true, JSON.stringify(e1));
      await CRM.stepExec(steps, mkStep(true), { note: () => {} });
      const e2 = events(dirR, 'k').filter((e) => e.type === 'launch')[1];
      ok('G30 run reused: the answer gives the pid of the ended run, marked reused, without a start time (the pid may be another process now)', e2 && e2.reused === true && e2.pid === e1[1].pid && e2.lstart === null, JSON.stringify(e2));
      // settled comes by itself once the script took the result: it reads the counters after the microtasks of the script.
      {
        const dS = path.join(W, `direct${++nFake}`);
        fs.mkdirSync(dS);
        const stp = CRM.makeSteps({ runId: 'RS', journals: { k: CJ.openJournal(dS, 'RS', 'k') }, table: { k: {} }, note: () => {} });
        let reds = 0;
        stp.register('k', () => ({ counts: { testerReds: reds }, head: 'h' }));
        const id1 = stp.begin('k', { kind: 'agent', label: 'test:k#1', effect: 'never', gated: true });
        stp.end('k', id1, { outcome: 'ok' });
        await Promise.resolve();
        reds = 1;
        const before = events(dS, 'k').map((e) => e.type).join();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const last = events(dS, 'k').pop();
        ok('S2 with no next step settled is written by itself, after the script took the verdict (the counter it changed in a microtask)', before === 'intent,result' && last.type === 'settled' && last.stepIds[0] === id1 && last.counts.testerReds === 1, JSON.stringify(last));
      }
      // The process of a service step already runs when its registration cannot be written: the step ends, then the task stops.
      {
        const dL = path.join(W, `direct${++nFake}`);
        fs.mkdirSync(dL);
        let w = 0;
        const io = { writeSync: (...a) => { if (++w === 2) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(...a); }, fsyncSync: fs.fsyncSync };
        const stp = CRM.makeSteps({ runId: 'RL', journals: { k: CJ.openJournal(dL, 'RL', 'k', { io }) }, table: { k: {} }, note: () => {} });
        const mark = path.join(dL, 'ran');
        const er = await (async () => { try { await CRM.stepExec(stp, { kind: 'left', label: 'left:k:x', effect: 'idempotent', argv: ['/bin/sh', '-c', `touch ${mark}; echo '{}'`], schema: { type: 'object' }, noJson: {} }, { note: () => {} }); return null; } catch (e) { return e; } })();
        const evs = events(dL, 'k').map((e) => e.type).join();
        ok('G30 a service step whose launch cannot be written: it ends, its result is written, and the chain stops', er && /journal\/run-state not written/.test(er.message) && fs.existsSync(mark) && evs === 'intent,result', `${er} ${evs}`);
      }
      const noLaunch = await CRM.stepExec(steps, { kind: 'diff', label: 'diff:k:x', effect: 'none', argv: [path.join(W, 'no-such-program')], schema: { type: 'object', properties: {}, required: [] }, noJson: { ok: false, error: '$error' } }, { note: () => {} });
      const e3 = events(dirR, 'k').filter((e) => e.label === 'diff:k:x' || e.stepId === events(dirR, 'k').filter((x) => x.label === 'diff:k:x')[0].stepId);
      ok('G30 a command that cannot start: intent, no launch, result no-json', noLaunch.ok === false && e3.map((e) => e.type).join('>') === 'intent>result' && e3[1].outcome === 'no-json', JSON.stringify(e3));
      const eStranger = await (async () => { try { await CRM.stepExec(steps, { kind: 'diff', label: 'diff:zz:x', effect: 'none', argv: ['true'], schema: { type: 'object' }, noJson: {} }, { note: () => {} }); return null; } catch (e) { return e; } })();
      ok('S1 a step whose label names no task of the run does not run without an intent', eStranger && /names no task/.test(eStranger.message), String(eStranger));
      const text = CRM.openStepText({ stepId: 'RW:9', n: 9, label: 'left:k:end', effect: 'idempotent', gated: false, at: 'T', gitHead: null, launch: null }, { runId: 'RW', wt: null, dir: dirR });
      ok('G30 an open step that is not gated, without a launch: the pid is unknown and it may have started', /pid unknown/.test(text) && /may have started/.test(text), text);
      const text2 = CRM.openStepText({ stepId: 'RW:8', n: 8, label: 'prog:k#1', effect: 'never', gated: true, at: 'T', gitHead: null, launch: null }, { runId: 'RW', wt: null, dir: dirR });
      ok('E11 a gated role without a launch: the gate never opened, the role did not start', /did not start/.test(text2), text2);
      const text3 = CRM.openStepText({ stepId: 'RW:7', n: 7, label: 'run:k:x', effect: 'reuse', gated: false, at: 'T', waitId: id, launch: null }, { runId: 'RW', wt: null, dir: dirR });
      ok('G30 an open run without a launch names the id of its wait step', text3.includes(id) && /pid unknown/.test(text3), text3);
    }

    // ---- the place: a sharedDir inside a write root refuses the start, before anything is written
    const refused = (name, tasks, cfgObj, host, extraEnv) => {
      const cfg = path.join(W, `cfg${++nTasks}.json`);
      fs.writeFileSync(cfg, JSON.stringify(Object.assign({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }, cfgObj || {})));
      const sd = (cfgObj && cfgObj.sharedDir) || SHARED;
      const runs = path.join(sd, 'runs');
      const n0 = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
      const args = ['start', '--host', host || 'claude', '--tasks', tasksFile(tasks), '--owner', OWNER, '--config', cfg].concat(host === 'codex' ? ['--codex-home', path.join(W, 'nohome')] : []);
      const p = cr(args, envOf(fake({}), extraEnv));
      const n1 = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
      ok(`${name}: exit 64, the reason names the state, no run folder`, p.status === 64 && /write root|state/.test(p.stderr) && n1 === n0, `${p.status} ${p.stderr} ${p.stdout}`);
    };
    const wtI = worktree('w-inside');
    refused('sharedDir inside the worktree of a task', [task('ri', { wt: wtI, dir: path.join(W, 'td-ri') })], { sharedDir: path.join(wtI, 'shared') });
    refused('the task folder holds sharedDir', [task('rj', { dir: W })]);
    refused('the task folder is sharedDir itself', [task('rk', { dir: SHARED })]);
    refused('the key "runs": the default task folder is the state folder', [task('runs')]);
    refused('the worktree lies inside the state folder', [task('rl', { wt: path.join(SHARED, 'runs', 'x'), dir: path.join(W, 'td-rl') })]);
    const lnk = path.join(W, 'shared-link');
    fs.symlinkSync(SHARED, lnk);
    refused('the same through a link: the task folder is a link to the state folder', [task('rm', { dir: path.join(lnk, 'runs') })]);
    const lnkWt = path.join(W, 'wt-link');
    fs.symlinkSync(wtI, lnkWt);
    refused('sharedDir through a link into the worktree', [task('rn', { wt: wtI, dir: path.join(W, 'td-rn') })], { sharedDir: path.join(lnkWt, 'shared2') });
    refused('codex: sharedDir inside the TMPDIR of the role (the sandbox lets a role write it)', [task('ro')], {}, 'codex', { TMPDIR: W });
    const rootsFor = CRM.stateRootProblem({ config: { sharedDir: SHARED }, tasks: [{ key: 'x', wt: WTR + '/w-x' }] }, 'claude', { TMPDIR: W });
    ok('claude: the TMPDIR of a role is no write root (no sandbox, Known gaps), the worktree and the task folder are', rootsFor === null, String(rootsFor));
    // The folders of a first run do not exist yet, so no disk can name them: the comparison itself ignores case.
    const firstRun = path.join(W, 'first-run');
    fs.mkdirSync(firstRun);
    const pRuns = CRM.stateRootProblem({ config: { sharedDir: firstRun }, tasks: [{ key: 'RUNS', wt: WTR + '/w-x' }] }, 'claude', {});
    ok('a task named RUNS, its default folder not there yet: the state folder of another case', /overlaps/.test(String(pRuns)), String(pRuns));
    const pNew = CRM.stateRootProblem({ config: { sharedDir: path.join(W, 'NOT-YET', 'shared') }, tasks: [{ key: 'x', wt: WTR + '/w-x', dir: path.join(W, 'not-yet') }] }, 'claude', {});
    ok('sharedDir inside a task folder that does not exist yet, by another case', /overlaps/.test(String(pNew)), String(pNew));
    // ---- S23: the record of the adapter, read through a link in the path of the task folder, refused when the file is a link
    {
      const rd = path.join(W, 'rec-real'), ln = path.join(W, 'rec-link');
      fs.mkdirSync(path.join(rd, 'calls', 'c1'), { recursive: true });
      fs.symlinkSync(rd, ln);
      const cd = path.join(ln, 'calls', 'c1');
      fs.writeFileSync(path.join(cd, 'prompt.txt'), 'p');
      const stepOf = (callDir) => ({ stepId: 'r:1', n: 1, label: 'prog:k#1', effect: 'never', gated: true, at: 'T', gitHead: null, launch: { pid: 1, pgid: 1, lstart: null, callDir } });
      const textOf = () => CRM.openStepText(stepOf(cd), { runId: 'r', wt: null, dir: ln });
      const noFolder = path.join(W, 'calls-is-a-file');
      fs.mkdirSync(noFolder);
      fs.writeFileSync(path.join(noFolder, 'calls'), 'x');
      ok('D1 a calls folder that cannot be read is named, not "no calls"', /calls/.test(CRM.unrecordedCalls(noFolder).error || ''), JSON.stringify(CRM.unrecordedCalls(noFolder)));
      ok('D1 no calls folder yet: no calls, no error', !CRM.unrecordedCalls(path.join(W, 'no-such-folder')).error && !CRM.unrecordedCalls(path.join(W, 'no-such-folder')).calls.length);
      ok('S23 no calls.jsonl yet: the record is none, the call unrecorded', /the adapter's record: none/.test(textOf()) && CRM.unrecordedCalls(ln).calls.length === 1, textOf());
      fs.writeFileSync(path.join(rd, 'calls.jsonl'), `${JSON.stringify({ label: 'prog:k#1', callDir: cd, outcome: 'ok' })}\n{torn`);
      ok('S23 through a link in the path: the record is found past a torn last line', /the adapter's record: ok/.test(textOf()) && !CRM.unrecordedCalls(ln).calls.length, textOf());
      fs.renameSync(path.join(rd, 'calls.jsonl'), path.join(rd, 'moved.jsonl'));
      fs.symlinkSync(path.join(rd, 'moved.jsonl'), path.join(rd, 'calls.jsonl'));
      ok('S23 calls.jsonl itself a link: not followed, and named unreadable, not "none"', /the adapter's record: unreadable/.test(textOf()), textOf());
    }
    // ... and end to end: a sharedDir linked by its owner, the conductor dead in the middle of a role
    {
      const realS = path.join(W, 'linked-real'), linkS = path.join(W, 'linked-shared');
      fs.mkdirSync(realS);
      fs.symlinkSync(realS, linkS);
      const cfgL = path.join(W, 'cfg-linked.json');
      fs.writeFileSync(cfgL, JSON.stringify({ repoDir: REPO, sharedDir: linkS, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
      const fdL = fake({ programmer: [{ $sleep: 120, then: PROG }] });
      const sL = start([task('l1')], fdL, cfgL);
      until(() => starts(fdL, 'programmer')[0]);
      process.kill(sL.j.pid, 'SIGKILL');
      until(() => !alive(sL.j.pid), 5000);
      const stL = status(sL.j.runDir);
      const tL = stL.j && stL.j.tasks && stL.j.tasks.l1;
      const unrec = (tL && tL.unrecordedCalls) || [];
      const openL = tL && tL.open && tL.open[0];
      ok('S23 a linked sharedDir: the role in the air is the only unrecorded call, the recorded pre is not named', unrec.length === 1 && /prog_l1_1-/.test(unrec[0]) && !tL.unrecordedCallsError, JSON.stringify(tL));
      ok('S23 a linked sharedDir: pre has its record, so the file was read through the link', /"label":"pre:l1"/.test(fs.readFileSync(path.join(linkS, 'l1', 'calls.jsonl'), 'utf8')) && !!openL && /the adapter's record: none/.test(openL.text), JSON.stringify(openL));
    }
    ok('codex: /tmp is a write root', /\/tmp/.test(String(CRM.stateRootProblem({ config: { sharedDir: '/tmp/x' }, tasks: [{ key: 'x', wt: WTR + '/w-x', dir: W + '/d' }] }, 'codex', {}))));

    // ---- the key is no path
    for (const bad of ['../up', 'a/b', '.', '..', '.locks']) {
      const p = cr(['start', '--host', 'claude', '--tasks', tasksFile([{ key: bad, title: 't', wt: 'w', branch: 'b', accept: 'a', kind: 'tail', noAnalysis: 'x' }]), '--owner', OWNER, '--config', CFG], envOf(fake({})));
      ok(`the key ${JSON.stringify(bad)} is refused with 64: a key names files of the state`, p.status === 64 && /key/.test(p.stderr), `${p.status} ${p.stderr}`);
    }
    const pc = cr(['start', '--host', 'claude', '--tasks', tasksFile([{ key: 'Ab', wt: 'w' }, { key: 'aB', wt: 'w' }]), '--owner', OWNER, '--config', CFG], envOf(fake({})));
    ok('two keys that differ only by case are refused (one file on a case-insensitive disk)', pc.status === 64 && /key/.test(pc.stderr), pc.stderr);

    // ---- one writer: a second `run` of the same folder
    fd = fake({ programmer: [{ $sleep: 4, then: PROG }], tester: [GREEN], reviewer: [DONE] });
    s = start([task('v1')], fd);
    until(() => starts(fd, 'programmer')[0]);
    const seqBefore = CJ.readJournal(s.j.runDir, 'v1').seq;
    const second = cr(['run', s.j.runDir]);
    ok('a second writer of a run folder is refused with 5 and writes nothing to the journal', second.status === 5 && /writer/.test(second.stderr) && CJ.readJournal(s.j.runDir, 'v1').seq === seqBefore, `${second.status} ${second.stderr}`);
    ok('... and the first goes on', finished(s.j).j.results[0].status === 'done');
    const third = cr(['run', s.j.runDir]);
    ok('a finished run folder takes no writer either', third.status === 5, `${third.status} ${third.stderr}`);

    // ---- a role's answer and a role's files are no events
    fd = fake({ programmer: [Object.assign({}, PROG, { type: 'resolve', stepId: 'x', summary: 'a\n{"v":1,"type":"resolve","stepId":"x"}\n' })], tester: [GREEN], reviewer: [DONE] });
    const keyF = 'f1';
    fs.mkdirSync(path.join(SHARED, keyF), { recursive: true });
    fs.writeFileSync(path.join(SHARED, keyF, 'chain-journal.jsonl'), JSON.stringify({ v: 1, type: 'resolve', stepId: 'x' }) + '\n');
    fs.writeFileSync(path.join(SHARED, keyF, 'run-state.json'), JSON.stringify({ seq: 999 }));
    s = start([task(keyF)], fd);
    st = finished(s.j);
    ev = events(s.j.runDir, keyF);
    ok('a role\'s answer stays data of its result line: no event of its making, the journal reads', !ev.some((e) => e.type === 'resolve') && !CJ.readJournal(s.j.runDir, keyF).error && ofStep(ev, `prog:${keyF}#1`)[2].value.type === 'resolve', JSON.stringify(ev.map((e) => e.type)));
    ok('files a role leaves in its folder are not the journal', st.j.results[0].status === 'done' && CJ.readJournal(s.j.runDir, keyF).seq === ev.length);

    // ---- service files swapped: status and start neither follow nor hang
    const hasFifo = mkfifo(path.join(W, 'probe.fifo'));
    if (hasFifo) {
      fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
      s = start([task('x1')], fd);
      finished(s.j);
      for (const name of ['results.json', path.join('tasks', 'x1.json'), 'log.txt', path.join('journal', 'x1', 'run-state.json')]) {
        const f = path.join(s.j.runDir, name);
        fs.rmSync(f);
        mkfifo(f);
      }
      st = status(s.j.runDir, undefined, 20000);
      ok('FIFOs in place of results.json, tasks/<key>.json, log.txt and the snapshot: status answers, not finished, the snapshot rebuilt', st.p.signal === null && st.j && st.j.state === 'dead' && st.j.tasks.x1.journal.snapshot === 'rebuilt', `${st.p.signal} ${st.p.stdout}`);
      fs.rmSync(path.join(s.j.runDir, 'run.json'));
      mkfifo(path.join(s.j.runDir, 'run.json'));
      st = status(s.j.runDir, undefined, 20000);
      ok('a FIFO in place of run.json: status answers dead', st.p.signal === null && st.j && st.j.state === 'dead', `${st.p.signal} ${st.p.stdout}`);
      fs.rmSync(path.join(s.j.runDir, 'request.json'));
      mkfifo(path.join(s.j.runDir, 'request.json'));
      st = status(s.j.runDir, undefined, 20000);
      ok('a FIFO in place of request.json: status does not block', st.p.signal === null, `${st.p.signal} ${st.p.stdout}`);

      fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
      s = start([task('x2')], fd);
      const r2 = until(() => starts(fd, 'programmer')[0]);
      process.kill(s.j.pid, 'SIGKILL');
      until(() => !alive(s.j.pid), 5000);
      process.kill(-r2.pid, 'SIGKILL');
      const cj = path.join(SHARED, 'x2', 'calls.jsonl');
      try { fs.rmSync(cj); } catch { /* none yet */ }
      mkfifo(cj);
      st = status(s.j.runDir, undefined, 20000);
      ok('a FIFO a role left in place of calls.jsonl: status of a dead run does not block', st.p.signal === null && st.j && st.j.state === 'dead', `${st.p.signal} ${st.p.stdout}`);
      const tx2 = st.j && st.j.tasks && st.j.tasks.x2;
      ok('D1 calls.jsonl cannot be read: status names the cause next to the call folders', !!tx2 && /calls\.jsonl/.test(tx2.unrecordedCallsError || '') && tx2.unrecordedCalls.length >= 1, JSON.stringify(tx2));
      fd = fake({});
      s = start([task('x2')], fd);
      const whyX2 = (s.j && s.j.tasks && s.j.tasks.x2) || '';
      ok('D1 ... the refusal of a restart says the records cannot be read, not "started without a line"', /undetermined/.test(whyX2) && /calls\.jsonl cannot be read/.test(whyX2) && !/calls started without a line/.test(whyX2), whyX2);
      const runsX2 = fs.readdirSync(path.join(SHARED, 'runs')).filter((n) => !n.startsWith('.')).map((n) => CJ.readJsonSafe(path.join(SHARED, 'runs', n, 'undetermined.json'))).filter((m) => m && m.tasks && m.tasks.x2);
      ok('D1 ... and its mark keeps the cause', runsX2.length === 1 && /calls\.jsonl/.test(runsX2[0].tasks.x2.unrecordedCallsError || ''), JSON.stringify(runsX2));
      if (s.j) until(() => fs.existsSync(path.join(s.j.runDir, 'results.json')), 20000);
      fs.unlinkSync(path.join(SHARED, 'runs', '.locks', 'x2.lock'));
      s = start([task('x2')], fake({}));
      const whyAgain = (s.j && s.j.tasks && s.j.tasks.x2) || '';
      ok('D1 ... the same in the refusal by a mark, once the lock was removed by hand', /undetermined/.test(whyAgain) && /calls\.jsonl cannot be read/.test(whyAgain) && !/calls started without a line/.test(whyAgain), whyAgain);
      if (s.j) until(() => fs.existsSync(path.join(s.j.runDir, 'results.json')), 20000);

      const lockDir = path.join(SHARED, 'runs', '.locks');
      fs.mkdirSync(lockDir, { recursive: true });
      mkfifo(path.join(lockDir, 'x3.lock'));
      fd = fake({});
      s = start([task('x3')], fd);
      const r3 = s.j ? ((finished(s.j).j || {}).results || [])[0] : null;
      ok('a FIFO in place of the task lock: start does not block, the task is refused, no role', r3 && r3.status === 'stopped' && !starts(fd).length, JSON.stringify(r3));
    }
    const out = path.join(W, 'forged-results.json');
    fs.writeFileSync(out, JSON.stringify({ runId: 'forged', exitCode: 0, results: [{ task: 'l1', status: 'done' }] }));
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
    s = start([task('l1')], fd);
    const r4 = until(() => starts(fd, 'programmer')[0]);
    fs.symlinkSync(out, path.join(s.j.runDir, 'results.json'));
    st = status(s.j.runDir);
    ok('a link in place of results.json is not read as the result of the run', st.j && st.j.state === 'running', st.p.stdout);
    process.kill(s.j.pid, 'SIGKILL');
    process.kill(-r4.pid, 'SIGKILL');

    // ---- the lock of a task: three answers of a read (the part on locks in the header of chain-run.js)
    {
      const locks = path.join(SHARED, 'runs', '.locks');
      fs.mkdirSync(locks, { recursive: true });
      const lockOf = (k) => path.join(locks, `${k}.lock`);
      const lstartMe = CRM.lstartOf(process.pid);
      const me = { runId: 'mine', runDir: path.join(W, 'mine'), pid: process.pid, lstart: lstartMe };
      const onFirst = (method, target, act, fn) => {
        const orig = fs[method];
        let fired = false;
        fs[method] = (p, ...a) => { if (!fired && String(p) === target) { fired = true; fs[method] = orig; act(); } return orig(p, ...a); };
        try { return { out: fn(), fired }; } finally { fs[method] = orig; }
      };
      const dead = spawnSync('true').pid;
      const deadLock = { pid: dead, lstart: 'Mon Jan  1 00:00:00 2001', runId: 'gone-run', runDir: path.join(SHARED, 'runs', 'gone-run') };

      // L2: a holder killed between link and unlink: two names for good, and it is named all the same
      fs.writeFileSync(lockOf('l2'), JSON.stringify(deadLock));
      fs.linkSync(lockOf('l2'), `${lockOf('l2')}.gone-run.${dead}.new`);
      fd = fake({});
      s = start([task('l2')], fd);
      const whyL2 = (s.j && s.j.tasks && s.j.tasks.l2) || '';
      if (s.j) until(() => fs.existsSync(path.join(s.j.runDir, 'results.json')), 20000);
      ok('L2 a dead holder, two names: undetermined with its pid and run named, not "pid ?"', /^undetermined/.test(whyL2) && whyL2.includes(`pid ${dead}`) && whyL2.includes('gone-run') && !/pid \?/.test(whyL2), whyL2);
      ok('L2 ... the mark is there, the lock stays', !!s.j && fs.existsSync(path.join(s.j.runDir, 'undetermined.json')) && fs.existsSync(lockOf('l2')) && !starts(fd).length);

      // L5: the holder removes the lock between EEXIST and the read
      fs.writeFileSync(lockOf('l5'), JSON.stringify({ pid: process.pid, lstart: lstartMe, runId: 'other' }));
      const g5 = onFirst('openSync', lockOf('l5'), () => fs.unlinkSync(lockOf('l5')), () => CRM.takeLock(lockOf('l5'), me));
      ok('L5 the lock gone between EEXIST and the read: the second conductor takes it', g5.fired && g5.out.ok === true && !g5.out.held && CJ.readJsonSafe(lockOf('l5')).runId === 'mine', JSON.stringify(g5));
      ok('L5 ... and leaves no temporary name', !fs.readdirSync(locks).some((n) => n.startsWith('l5.lock.')), fs.readdirSync(locks).join());
      // ... and a third conductor takes it first: the loop reads its lock
      fs.writeFileSync(lockOf('l5b'), JSON.stringify({ pid: dead, runId: 'other' }));
      const third = { pid: process.pid, lstart: lstartMe, runId: 'third' };
      const g5b = onFirst('openSync', lockOf('l5b'), () => { fs.unlinkSync(lockOf('l5b')); fs.writeFileSync(`${lockOf('l5b')}.third`, JSON.stringify(third)); }, () => {
        const link = fs.linkSync;
        let links = 0;
        fs.linkSync = (a, b) => { if (String(b) === lockOf('l5b') && ++links === 2) { fs.renameSync(`${lockOf('l5b')}.third`, lockOf('l5b')); fs.linkSync = link; } return link(a, b); };
        try { return CRM.takeLock(lockOf('l5b'), me); } finally { fs.linkSync = link; }
      });
      ok('L5 a third conductor takes it first: held by the third, alive, no retry forever', g5b.out.held && g5b.out.held.runId === 'third' && g5b.out.alive === true, JSON.stringify(g5b));

      // L6: not a lock at all
      const target = path.join(W, 'lock-target.json');
      fs.writeFileSync(target, JSON.stringify({ pid: process.pid, lstart: lstartMe, runId: 'behind-a-link' }));
      fs.symlinkSync(target, lockOf('l6a'));
      fs.writeFileSync(lockOf('l6b'), 'not json');
      fs.mkdirSync(lockOf('l6c'));
      fs.writeFileSync(lockOf('l6d'), '5');
      for (const [k, name] of [['l6a', 'a link'], ['l6b', 'garbage'], ['l6c', 'a folder'], ['l6d', 'JSON that is no lock']]) {
        const r = CRM.takeLock(lockOf(k), me);
        ok(`L6 ${name} in place of the lock: not taken, nothing named, not alive`, !r.ok && !!r.held && r.held.pid === undefined && r.alive === false, JSON.stringify(r));
      }
      ok('L6 ... the link is not followed and stays', fs.lstatSync(lockOf('l6a')).isSymbolicLink() && JSON.parse(fs.readFileSync(target, 'utf8')).runId === 'behind-a-link');
      fd = fake({});
      s = start([task('l6a')], fd);
      const whyL6 = (s.j && s.j.tasks && s.j.tasks.l6a) || '';
      if (s.j) until(() => fs.existsSync(path.join(s.j.runDir, 'results.json')), 20000);
      ok('L6 through start: a link in place of the lock is an undetermined state, pid ?, no role', /^undetermined/.test(whyL6) && /pid \?/.test(whyL6) && !starts(fd).length, whyL6);

      // L7, L8: the lock when it is released
      fs.writeFileSync(lockOf('l7'), JSON.stringify(me));
      fs.linkSync(lockOf('l7'), `${lockOf('l7')}.mine.1.new`);
      CRM.releaseLock(lockOf('l7'), me);
      ok('L7 the own lock with two names is released', !fs.existsSync(lockOf('l7')));
      ok('L7 ... and a next take is no undetermined state', CRM.takeLock(lockOf('l7'), me).ok === true);
      CRM.releaseLock(lockOf('l7'), me);
      for (const [name, held] of [['another run', { runId: 'other', pid: process.pid }], ['another pid', { runId: 'mine', pid: process.pid + 1 }]]) {
        fs.writeFileSync(lockOf('l8'), JSON.stringify(held));
        CRM.releaseLock(lockOf('l8'), me);
        ok(`L8 a lock of ${name} is not released`, fs.existsSync(lockOf('l8')));
      }
      fs.writeFileSync(lockOf('l8'), 'not json');
      CRM.releaseLock(lockOf('l8'), me);
      ok('L8 a lock that cannot be read is not released', fs.existsSync(lockOf('l8')));
      fs.unlinkSync(lockOf('l8'));
      ok('L8 a lock that is gone: releasing it is no error', threwNot(() => CRM.releaseLock(lockOf('l8'), me)));

      // L9: the writer lock of a run folder, through the process
      const writerCase = (name, make, check) => {
        const d = path.join(W, `writer-${name}`);
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'request.json'), JSON.stringify({ runId: 'w', host: 'claude', args: { tasks: [] }, adapter: {} }));
        make(path.join(d, 'writer.lock'));
        const p = cr(['run', d], undefined, 20000);
        ok(`L9 ${name} in place of the writer lock: exit 5, no hang`, p.status === 5 && p.signal === null && check(p.stderr), `${p.status} ${p.signal} ${p.stderr}`);
      };
      writerCase('two names', (f) => { fs.writeFileSync(f, JSON.stringify({ pid: 4243 })); fs.linkSync(f, `${f}.1.new`); }, (e) => /pid 4243/.test(e));
      writerCase('a link', (f) => { fs.writeFileSync(`${f}.t`, JSON.stringify({ pid: 4243 })); fs.symlinkSync(`${f}.t`, f); }, (e) => /pid \?/.test(e));
      if (mkfifo(path.join(W, 'probe2.fifo'))) writerCase('a FIFO', (f) => { mkfifo(f); }, (e) => /pid \?/.test(e));
    }

    // ---- C1: the package.json of the plugin is no service file: its link count stops nothing
    {
      const copy = path.join(W, 'plugin-copy');
      for (const n of ['scripts', 'workflows', 'agents', 'schemas', 'hooks', 'rules', 'skills']) fs.cpSync(path.join(ROOT, n), path.join(copy, n), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(copy, 'package.json'));
      fs.linkSync(path.join(copy, 'package.json'), path.join(copy, 'package-second-name.json'));
      fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
      const pv = spawnSync(process.execPath, [path.join(copy, 'scripts', 'chain-run.js'), 'start', '--host', 'claude', '--tasks', tasksFile([task('c1p')]), '--owner', OWNER, '--config', CFG], { encoding: 'utf8', env: envOf(fd), timeout: 120000 });
      let jv = null;
      try { jv = JSON.parse(pv.stdout); } catch { /* below */ }
      if (jv && jv.pid) groups.add(jv.pid);
      ok('C1 a package.json with two names: the start goes on', pv.status === 0 && !!jv && jv.tasks.c1p === 'held', `${pv.status} ${pv.stdout} ${pv.stderr}`);
      if (jv) {
        const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
        ok('C1 ... and the run names the version of the plugin', JSON.parse(fs.readFileSync(path.join(jv.runDir, 'request.json'), 'utf8')).pluginVersion === version);
        finished(jv);
      }
    }

    // ---- C2: a sharedDir that cannot hold the state is refused by name
    {
      const asFile = path.join(W, 'shared-is-a-file');
      fs.writeFileSync(asFile, 'x');
      const cfgs = [['a plain file', asFile]];
      if (process.getuid && process.getuid() !== 0) {
        const ro = path.join(W, 'shared-read-only');
        fs.mkdirSync(ro, { mode: 0o500 });
        cfgs.push(['a folder with no write access', ro]);
      }
      for (const [name, shared] of cfgs) {
        const cf = path.join(W, `cfg-c2-${name.length}.json`);
        fs.writeFileSync(cf, JSON.stringify({ repoDir: REPO, sharedDir: shared, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
        fd = fake({});
        const p = cr(['start', '--host', 'claude', '--tasks', tasksFile([task('c2', { dir: path.join(W, 'c2-dir') })]), '--owner', OWNER, '--config', cf], envOf(fd));
        ok(`C2 sharedDir ${name}: exit 64 with the cause, no stack, no role`, p.status === 64 && /chain-run: .*state folder/.test(p.stderr) && !/\n\s+at /.test(p.stderr) && !starts(fd).length, `${p.status} ${p.stderr}`);
      }
    }

    // ---- the static part: one line for the counters, an id for the wait step, no change without the conductor
    const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
    // ---- the tester cells: tests/chain-run-journal-tester-cases.js, a child with its own tally, so README keeps counting test files
    {
      const tc = spawnSync(process.execPath, [path.join(__dirname, 'chain-run-journal-tester-cases.js')], { encoding: 'utf8', timeout: 280000 });
      ok('the tester cells of the journal (tests/chain-run-journal-tester-cases.js) pass', tc.status === 0, `${tc.status} ${tc.signal} ${String(tc.stdout).split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 3000)}`);
    }
    ok('role-chain.js registers the getter of the counters only when the runtime has checkpoint', /if \(typeof checkpoint === 'function'\) checkpoint\(t\.key, /.test(SRC));
    ok('role-chain.js: the run step carries the id of its wait step', /wait: \{ id, argv: argvOf\(wait\) \}/.test(SRC));
  } finally {
    cleanup();
  }
  sleepMs(300);
  const left = spawnSync('pgrep', ['-f', W], { encoding: 'utf8' }).stdout.trim();
  ok('no process of this test is left', !left, left);
  if (!process.env.CHAIN_RUN_KEEP) fs.rmSync(W, { recursive: true, force: true });
  done();
})();
