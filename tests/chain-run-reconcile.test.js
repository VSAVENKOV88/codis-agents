#!/usr/bin/env node
'use strict';
// The conductor knows what an earlier run left and refuses by it (p-codex-B1-b2a; analysis p-codex-B1-b2 §1, cells V1-V3,
// L1-L4a, C1-C8, X2 as the steps folder, X7, K0): liveness has three answers (alive with the members of its group, gone,
// unknown when ps does not answer); the lock of a task is taken over from a dead conductor only under a token, after
// the reconciliation of every run folder of the task; the reconciliation reads the journals (open steps by their class of
// effect and liveness, a verdict whose use by the chain is not proven, damage) and no mark file; the files of the service
// steps live in <runDir>/steps/<key>/, which the tasks file cannot name. Roles go to the fake CLIs of
// tests/fixtures/chain-run/bin; no model is called. Every process a check starts is killed in the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');
const CRM = require('../scripts/chain-run.js');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-rc-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RUNS = path.join(SHARED, 'runs');
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
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = (c, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = c(); if (v) return v; sleepMs(50); } return c(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lstartOf = (pid) => { const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return p.status === 0 ? p.stdout.trim() : null; };
const groups = new Set();

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: SHA0, summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const task = (key, extra) => {
  const t = Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
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
const envOf = (fd, extra) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd }, extra || {});
const tasksFile = (tasks) => { const f = path.join(W, `tasks${++nTasks}.json`); fs.writeFileSync(f, JSON.stringify(tasks)); return f; };
const cr = (args, env) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 120000 });
function start(tasks, fd, env) {
  const p = cr(['start', '--host', 'claude', '--tasks', tasksFile(tasks), '--owner', OWNER, '--config', CFG], env || envOf(fd));
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  if (j && j.pid) groups.add(j.pid);
  return { p, j };
}
const finished = (j) => { const p = cr(['status', j.runDir, '--config', CFG, '--wait', '120']); try { return JSON.parse(p.stdout); } catch { return null; } };
const resultOf = (s) => (s.j ? ((finished(s.j) || {}).results || [])[0] : null);
const lockOf = (key) => path.join(RUNS, '.locks', `${key}.lock`);
const registered = (key) => fs.readdirSync(RUNS).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(RUNS, n, 'tasks', `${key}.json`)));
// Mark files of the earlier design, anywhere in the test folder (the shared folder and the fabricated runs).
const marks = () => { const out = []; const walk = (d) => { let ns = []; try { ns = fs.readdirSync(d); } catch { return; } for (const n of ns) { const p = path.join(d, n); if (n === 'undetermined.json') out.push(p); else if (fs.lstatSync(p).isDirectory()) walk(p); } }; walk(W); return out; };
function cleanup() {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } try { process.kill(g, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of fs.readdirSync(W).filter((x) => /^fake\d+$/.test(x))) for (const e of traceOf(path.join(W, d))) if (e.ev === 'start') { try { process.kill(-e.pid, 'SIGKILL'); } catch { /* gone */ } }
}

// ---- fabricated runs for the reconciliation
const ME = { pid: process.pid, lstart: lstartOf(process.pid) };
const DEAD = spawnSync('true').pid;
const RD = path.join(W, 'rc');
let nRun = 0;
// A run folder of key k under its own runs/: run.json, tasks/<k>.json and journal lines; any of them may be text (garbage).
function mkRun(o) {
  const runs = path.join(RD, `case${++nRun}`, 'runs');
  const id = o.id || `R${nRun}`;
  const rd = path.join(runs, id);
  fs.mkdirSync(path.join(rd, 'tasks'), { recursive: true });
  if (o.run !== null) fs.writeFileSync(path.join(rd, 'run.json'), typeof o.run === 'string' ? o.run : JSON.stringify(Object.assign({ runId: id }, o.run || { pid: DEAD, lstart: 'Mon Jan  1 00:00:00 2001' })));
  if (o.rec !== null) fs.writeFileSync(path.join(rd, 'tasks', 'k.json'), typeof o.rec === 'string' ? o.rec : JSON.stringify(o.rec || { state: 'running' }));
  if (o.events) { const j = CJ.openJournal(rd, id, 'k'); for (const e of o.events) j.append(e); }
  if (o.after) o.after(rd);
  return { runs, rd, id, rc: () => CRM.reconcile(runs, 'k', 'own', { wt: null, dir: path.join(RD, 'taskdir') }) };
}
const I = (n, effect, extra) => Object.assign({ type: 'intent', stepId: `R:${n}`, n, label: `x:k:${n}`, kind: effect === 'never' ? 'agent' : 'exec', effect, gated: effect === 'never' }, extra || {});
const L = (n, extra) => Object.assign({ type: 'launch', stepId: `R:${n}` }, extra);
const Rs = (n, value) => ({ type: 'result', stepId: `R:${n}`, outcome: 'ok', value: value === undefined ? { verdict: 'green' } : value });
const END = { type: 'end', status: 'done' };
const blocks = (c) => c.reasons.length > 0;
const text = (c) => c.reasons.map((r) => r.why).join(' | ') + ' || ' + c.notes.join(' | ');

(async () => {
  try {
    // ---- V1, V2: liveness with three answers
    {
      const lead = spawn('/bin/sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
      groups.add(lead.pid);
      until(() => lstartOf(lead.pid));
      const ll = lstartOf(lead.pid);
      let v = CRM.liveness({ pid: lead.pid, lstart: ll, pgid: lead.pid });
      ok('V1 the leader alive by pid and start time: alive, with the members of its group', v.state === 'alive' && (v.members || []).length >= 2, JSON.stringify(v));
      const orphan = spawn('/bin/sh', ['-c', 'sleep 60 & exit 0'], { detached: true, stdio: 'ignore' });
      groups.add(orphan.pid);
      const ol = until(() => lstartOf(orphan.pid));
      until(() => !alive(orphan.pid), 5000);
      v = CRM.liveness({ pid: orphan.pid, lstart: ol, pgid: orphan.pid });
      ok('V1 the leader gone, its group alive: alive, a member named', v.state === 'alive' && (v.members || []).length >= 1 && (v.members || []).every((m) => m.pgid === orphan.pid), JSON.stringify(v));
      v = CRM.liveness({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 1970', pgid: null });
      ok('V1 the pid now another process, no group: gone', v.state === 'gone', JSON.stringify(v));
      v = CRM.liveness({ pid: DEAD, lstart: 'Thu Jan  1 00:00:00 1970', pgid: DEAD });
      ok('V1 a dead pid with an empty group: gone', v.state === 'gone', JSON.stringify(v));
      v = CRM.liveness({ pid: process.pid, lstart: null, pgid: null });
      ok('G5 a live pid without a start time: unknown (whose process it is cannot be told)', v.state === 'unknown', JSON.stringify(v));
      for (const pid of [1, 0, -1, 1.5, '7', null]) {
        v = CRM.liveness({ pid, lstart: 'x', pgid: null });
        ok(`V1 pid ${JSON.stringify(pid)}: never alive, never a signal (unknown)`, v.state === 'unknown', JSON.stringify(v));
      }
      // V2 (G4): a ps that answers only for the pid of its caller and refuses another pid and ps -A
      const fps = path.join(W, 'fake-ps');
      fs.mkdirSync(fps);
      fs.writeFileSync(path.join(fps, 'ps'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-A" ] && exit 1; done\nlast=""; for a in "$@"; do last="$a"; done\n[ "$last" = "$PPID" ] && exec /bin/ps "$@"\nexit 1\n', { mode: 0o755 });
      const PATH0 = process.env.PATH;
      process.env.PATH = `${fps}${path.delimiter}${PATH0}`;
      try {
        v = CRM.liveness({ pid: lead.pid, lstart: ll, pgid: lead.pid });
        ok('V2 ps does not answer while the process exists: unknown, not gone', v.state === 'unknown', JSON.stringify(v));
        v = CRM.liveness({ pid: DEAD, lstart: 'x', pgid: null });
        ok('V2 ... and a pid that does not exist is gone without ps', v.state === 'gone', JSON.stringify(v));
      } finally { process.env.PATH = PATH0; }
      try { process.kill(-lead.pid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(-orphan.pid, 'SIGKILL'); } catch { /* gone */ }
    }

    // ---- C2 (I-S2): an open step by effect x launch x liveness
    {
      const cell = (name, events, expectBlock, extraAfter) => {
        const c = mkRun({ events, after: extraAfter }).rc();
        ok(`C2 ${name}: ${expectBlock ? 'refused' : 'goes on, named'}`, blocks(c) === expectBlock && (expectBlock || c.notes.length > 0), text(c));
        return c;
      };
      cell('never, the gate never opened', [I(1, 'never')], false);
      cell('never, launched, gone', [I(1, 'never'), L(1, { pid: DEAD, pgid: DEAD, lstart: 'x', gated: true })], true);
      const cA = cell('never, launched, alive', [I(1, 'never'), L(1, { pid: ME.pid, pgid: null, lstart: ME.lstart, gated: true })], true);
      ok('C2 ... the refusal names the step, its pid and "alive"', /step 1 x:k:1/.test(text(cA)) && text(cA).includes(`pid ${ME.pid}`) && /alive/.test(text(cA)), text(cA));
      cell('never, no launch, not gated (pid unknown)', [I(1, 'never', { gated: false })], true);
      cell('none, launched, alive', [I(1, 'none'), L(1, { pid: ME.pid, pgid: null, lstart: ME.lstart })], false);
      cell('idempotent, launched, gone', [I(1, 'idempotent'), L(1, { pid: DEAD, pgid: null, lstart: 'x' })], false);
      cell('idempotent, launched, alive', [I(1, 'idempotent'), L(1, { pid: ME.pid, pgid: null, lstart: ME.lstart })], true);
      cell('idempotent, no launch', [I(1, 'idempotent')], true);
      cell('reuse, launched reused (an ended run): gone, rc named', [I(1, 'reuse'), L(1, { pid: ME.pid, pgid: null, lstart: null, reused: true, rc: 0 })], false);
      cell('G5 a launch with a live pid and no start time, not reused: unknown', [I(1, 'idempotent'), L(1, { pid: ME.pid, pgid: null, lstart: null })], true);
      const meta = (pid) => (rd) => { const sd = path.join(rd, 'steps', 'k'); fs.mkdirSync(sd, { recursive: true }); fs.writeFileSync(path.join(sd, 'wait-x.json'), JSON.stringify({ pid, lstart: 'Mon Jan  1 00:00:00 2001', started: 1 })); };
      const waitIn = (rdOf) => ({ waitId: rdOf });
      // The waitId of a reuse step names <runDir>/steps/<key>/wait-x; the run folder is known only after mkRun, so the
      // intent is written by the after hook.
      const reuseCell = (name, withMeta, inside, expectBlock) => {
        const c = mkRun({ events: [], after: (rd) => {
          if (withMeta) meta(withMeta)(rd);
          const j = CJ.openJournal(rd, path.basename(rd), 'k');
          j.append(I(1, 'reuse', waitIn(inside ? path.join(rd, 'steps', 'k', 'wait-x') : path.join(W, 'elsewhere', 'wait-x'))));
        } }).rc();
        ok(`C2 reuse without a launch, ${name}: ${expectBlock ? 'refused' : 'goes on'}`, blocks(c) === expectBlock, text(c));
      };
      reuseCell('the meta of its steps folder names a dead pid', DEAD, true, false);
      reuseCell('the meta names a live pid that started at another time', process.pid, true, false);
      reuseCell('no meta', null, true, true);
      reuseCell('a wait id outside the steps folder of its run', DEAD, false, true);
      cell('G5 an intent without an effect', [Object.assign(I(1, 'none'), { effect: undefined })], true);
      cell('G5 an unknown effect', [I(1, 'sometimes')], true);
    }

    // ---- C4 (I-S3): a verdict is used only when an intent of another verdict step or the end follows it
    {
      const T = Rs(1, { verdict: 'red', summary: 'tester said red' });
      let c = mkRun({ events: [I(1, 'never'), L(1, { pid: DEAD, pgid: DEAD, lstart: 'x', gated: true }), T, I(2, 'idempotent'), L(2, { pid: DEAD, pgid: null, lstart: 'x' })] }).rc();
      ok('C4 dead after the tester\'s result with the post-check open: refused, the verdict shown', blocks(c) && /verdict/.test(text(c)) && /tester said red/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never'), L(1, { pid: DEAD, gated: true }), Rs(1), { type: 'settled', stepIds: ['R:1'], counts: { testerReds: 0 } }] }).rc();
      ok('C4 settled written after the result proves nothing: refused', blocks(c) && /verdict/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never'), I(2, 'never'), L(1, { pid: DEAD, gated: true }), L(2, { pid: DEAD, gated: true }), Rs(1), Rs(2), I(3, 'none')] }).rc();
      ok('C4 both reviews returned, the diff step open: refused, both verdicts named', blocks(c) && /x:k:1/.test(text(c)) && /x:k:2/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'reuse'), L(1, { pid: DEAD, pgid: DEAD, lstart: 'x' }), Rs(1, { done: true, rc: 11 })] }).rc();
      ok('C4 dead after the run of the train: refused with its verdict', blocks(c) && /"rc":11/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never'), L(1, { pid: DEAD, gated: true }), Rs(1), I(2, 'none'), Rs(2, {}), I(3, 'never')] }).rc();
      ok('C4 the next never intent follows: the verdict is used, the gate of the next never opened -> goes on', !blocks(c), text(c));
      c = mkRun({ events: [I(1, 'never'), L(1, { pid: DEAD, gated: true }), Rs(1), END], rec: { state: 'ended' } }).rc();
      ok('C6 every step ended and the end written: goes on', !blocks(c), text(c));
      c = mkRun({ events: [I(1, 'never'), I(2, 'never'), L(1, { pid: DEAD, gated: true }), L(2, { pid: DEAD, gated: true }), Rs(1), END, Rs(2)], rec: { state: 'ended' } }).rc();
      ok('C7 G5 a result after the end is no damage, but its verdict is not used: refused, "after end"', blocks(c) && /after (its|the) end/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never'), I(2, 'never'), L(1, { pid: DEAD, gated: true }), L(2, { pid: ME.pid, pgid: null, lstart: ME.lstart, gated: true }), Rs(1), END], rec: { state: 'ended' } }).rc();
      ok('C7 the chain ended while the second role still lives: refused by that live step', blocks(c) && /alive/.test(text(c)), text(c));
    }

    // ---- C5, C6, C8, I-S1: damage, records, conductors
    {
      let c = mkRun({ events: [I(1, 'never')], after: (rd) => fs.appendFileSync(path.join(rd, 'journal', 'k', 'seg-000.jsonl'), '{"v":1,"to') }).rc();
      ok('C5 a torn tail: named, the steps go by the table (the gate never opened -> goes on)', !blocks(c) && /torn/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never'), I(2, 'never')], after: (rd) => { const f = path.join(rd, 'journal', 'k', 'seg-000.jsonl'); const ls = fs.readFileSync(f, 'utf8').split('\n'); ls[0] = 'garbage'; fs.writeFileSync(f, ls.join('\n')); } }).rc();
      ok('C5 damage inside the journal: refused', blocks(c) && /corrupt/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never')], after: (rd) => { const f = path.join(rd, 'journal', 'k', 'run-state.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.seq = 9; fs.writeFileSync(f, JSON.stringify(s)); } }).rc();
      ok('C5 a snapshot ahead of the journal: refused', blocks(c) && /ahead/.test(text(c)), text(c));
      c = mkRun({ events: [I(1, 'never')], after: (rd) => { const f = path.join(rd, 'journal', 'k', 'run-state.json'); fs.writeFileSync(f, JSON.stringify({ seq: 0 })); } }).rc();
      ok('C6 a snapshot behind the journal: goes on', !blocks(c), text(c));
      c = mkRun({ rec: { state: 'running' } }).rc();
      ok('C6 running with no journal: refused', blocks(c) && /no journal/.test(text(c)), text(c));
      c = mkRun({ rec: { state: 'ended' } }).rc();
      ok('C6 ended with no journal (a run of an older version): goes on, named', !blocks(c) && c.notes.length > 0, text(c));
      c = mkRun({ rec: 'garbage', events: [I(1, 'never')] }).rc();
      ok('C6 tasks/<key>.json cannot be read: refused', blocks(c) && /tasks\/k\.json/.test(text(c)), text(c));
      c = mkRun({ run: 'garbage', events: [I(1, 'never')] }).rc();
      ok('C6 run.json cannot be read while the task is registered: refused', blocks(c) && /run\.json/.test(text(c)), text(c));
      c = mkRun({ rec: null, run: { pid: ME.pid, lstart: ME.lstart } }).rc();
      ok('C8 a run folder without a record of the task (a lost start, a live conductor of other tasks): goes on', !blocks(c), text(c));
      c = mkRun({ rec: null, run: 'garbage' }).rc();
      ok('C8 a run folder without a record and with garbage for run.json: goes on', !blocks(c), text(c));
      c = mkRun({ run: { pid: ME.pid, lstart: ME.lstart }, events: [I(1, 'never')] }).rc();
      ok('I-S1 L3 a live conductor whose task is running (its lock removed by hand): refused, "another conductor"', blocks(c) && /another conductor/.test(text(c)), text(c));
      const empty = path.join(RD, 'empty-runs');
      fs.mkdirSync(empty, { recursive: true });
      c = CRM.reconcile(empty, 'k', 'own', { dir: path.join(RD, 'taskdir') });
      ok('C6 nothing there: goes on', !blocks(c), text(c));
      const notDir = path.join(RD, 'runs-file');
      fs.writeFileSync(notDir, 'x');
      c = CRM.reconcile(notDir, 'k', 'own', { dir: path.join(RD, 'taskdir') });
      ok('C6 the runs folder cannot be read: refused', blocks(c), text(c));
      ok('C1 the reconciliation leaves no mark file anywhere', !marks().length, marks().join());
    }

    // ---- L1-L3, G6, V3: the lock and its takeover
    {
      fs.mkdirSync(path.join(RUNS, '.locks'), { recursive: true });
      const me = { pid: process.pid, lstart: ME.lstart, runId: 'mine', runDir: path.join(RUNS, 'mine') };
      const pass = () => ({ reasons: [], notes: [] });
      let checks = 0;
      const counted = () => { checks++; return pass(); };
      const deadLock = (runId) => ({ pid: DEAD, lstart: 'Mon Jan  1 00:00:00 2001', runId, runDir: '/somewhere/else', takenAt: 't' });
      fs.mkdirSync(path.join(RUNS, 'dead-run'), { recursive: true });
      fs.writeFileSync(lockOf('t1'), JSON.stringify(deadLock('dead-run')));
      let a = CRM.acquireTask(RUNS, 't1', me, counted);
      ok('L1 a dead lock, the state determined: taken over under the token, the lock now names this run', a.ok === true && checks >= 1 && CJ.readJsonSafe(lockOf('t1')).runId === 'mine' && !fs.existsSync(`${lockOf('t1')}.takeover`), JSON.stringify(a));
      CRM.releaseLock(lockOf('t1'), me);
      fs.writeFileSync(lockOf('t2'), JSON.stringify(deadLock('dead-run')));
      const before = fs.readFileSync(lockOf('t2'), 'utf8');
      a = CRM.acquireTask(RUNS, 't2', me, () => ({ reasons: [{ why: 'an open step' }], notes: [] }));
      ok('L1 a dead lock, the state refused: the dead lock stays as it was, no token left', !a.ok && /an open step/.test(a.why) && fs.readFileSync(lockOf('t2'), 'utf8') === before && !fs.existsSync(`${lockOf('t2')}.takeover`), JSON.stringify(a));
      fs.writeFileSync(lockOf('g6'), JSON.stringify(deadLock('no-such-run')));
      const g6 = fs.readFileSync(lockOf('g6'), 'utf8');
      a = CRM.acquireTask(RUNS, 'g6', me, pass);
      ok('G6 a dead lock naming a run without a folder: refused, the lock intact', !a.ok && /no-such-run/.test(a.why) && fs.readFileSync(lockOf('g6'), 'utf8') === g6, JSON.stringify(a));
      for (const [name, data] of [['garbage', 'not json'], ['a runId with ../', JSON.stringify(deadLock('../evil'))], ['pid 1', JSON.stringify(Object.assign(deadLock('dead-run'), { pid: 1 }))], ['no start time', JSON.stringify(Object.assign(deadLock('dead-run'), { lstart: null }))]]) {
        fs.writeFileSync(lockOf('l2'), data);
        a = CRM.acquireTask(RUNS, 'l2', me, pass);
        ok(`L2 a lock with ${name}: refused, named, the lock as it was, nothing written by its path`, !a.ok && /undetermined/.test(a.why) && fs.readFileSync(lockOf('l2'), 'utf8') === data && !fs.existsSync(path.join(RUNS, '..', 'evil')), JSON.stringify(a));
      }
      fs.writeFileSync(lockOf('l2t'), JSON.stringify(deadLock('dead-run')));
      fs.writeFileSync(`${lockOf('l2t')}.takeover`, JSON.stringify({ pid: DEAD, lstart: 'x', runId: 'crashed' }));
      a = CRM.acquireTask(RUNS, 'l2t', me, pass);
      ok('L2 a takeover token of a dead conductor: refused, named, the token and the lock stay', !a.ok && /takeover/.test(a.why) && /crashed/.test(a.why) && fs.existsSync(`${lockOf('l2t')}.takeover`) && CJ.readJsonSafe(lockOf('l2t')).runId === 'dead-run', JSON.stringify(a));
      fs.writeFileSync(`${lockOf('l2t')}.takeover`, '');
      a = CRM.acquireTask(RUNS, 'l2t', me, pass);
      ok('L2 an unreadable takeover token: refused', !a.ok && /takeover/.test(a.why), JSON.stringify(a));
      const holder = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
      groups.add(holder.pid);
      const hl = until(() => lstartOf(holder.pid));
      fs.writeFileSync(lockOf('l2t'), JSON.stringify(deadLock('dead-run')));
      fs.writeFileSync(`${lockOf('l2t')}.takeover`, JSON.stringify({ pid: holder.pid, lstart: hl, runId: 'taker' }));
      a = CRM.acquireTask(RUNS, 'l2t', me, pass);
      ok('L1 a live conductor holds the token: "another conductor", nothing changed', !a.ok && /another conductor/.test(a.why) && CJ.readJsonSafe(lockOf('l2t')).runId === 'dead-run', JSON.stringify(a));
      // V3: the holder released the lock between the read and ps -> the next link takes it, no takeover
      fs.writeFileSync(lockOf('v3'), JSON.stringify(deadLock('dead-run')));
      const open0 = fs.openSync;
      let opens = 0;
      fs.openSync = (p, ...r) => { if (String(p) === lockOf('v3') && ++opens === 2) { fs.openSync = open0; fs.unlinkSync(lockOf('v3')); } return open0(p, ...r); };
      const link0 = fs.linkSync;
      const tokens = [];
      fs.linkSync = (from, to) => { if (String(to).endsWith('.takeover')) tokens.push(String(to)); return link0(from, to); };
      try { a = CRM.acquireTask(RUNS, 'v3', me, pass); } finally { fs.openSync = open0; fs.linkSync = link0; }
      ok('V3 the holder gone between the read and ps: the lock read again is gone, taken by a link, no token ever made', a.ok === true && CJ.readJsonSafe(lockOf('v3')).runId === 'mine' && !tokens.length, JSON.stringify(a) + ' ' + tokens.join());
      CRM.releaseLock(lockOf('v3'), me);
      // V2 through the lock: the holder exists and ps cannot answer -> unknown, nothing written, the next start asks again
      const fps = path.join(W, 'fake-ps');
      fs.writeFileSync(lockOf('v2'), JSON.stringify({ pid: holder.pid, lstart: hl, runId: 'dead-run', takenAt: 't' }));
      const v2 = fs.readFileSync(lockOf('v2'), 'utf8');
      const PATH0 = process.env.PATH;
      process.env.PATH = `${fps}${path.delimiter}${PATH0}`;
      try { a = CRM.acquireTask(RUNS, 'v2', me, pass); } finally { process.env.PATH = PATH0; }
      ok('V2 the holder of the lock exists, ps does not answer: refused as unknown, the lock as it was, no token', !a.ok && /cannot tell|unknown/.test(a.why) && fs.readFileSync(lockOf('v2'), 'utf8') === v2 && !fs.existsSync(`${lockOf('v2')}.takeover`), JSON.stringify(a));
      a = CRM.acquireTask(RUNS, 'v2', me, pass);
      ok('V2 ... the next try with a working ps: "another conductor runs it"', !a.ok && /another conductor/.test(a.why), JSON.stringify(a));
      try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ }
    }

    // ---- X2, X7: the steps folder of a run, given by the conductor only
    {
      const pt = CRM.parseTasks(JSON.stringify([{ key: 'a', stepDir: '/tmp/x' }]));
      ok('X2 the tasks file cannot name stepDir: parseTasks refuses it', !!pt.error && /stepDir/.test(pt.error), JSON.stringify(pt));
      const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
      const sd = path.join(W, 'run-x', 'steps', 'x');
      const seen = [], launches = [];
      const q = { pre: [PRE], prog: [Object.assign({}, PROG, { head: SHA }), Object.assign({}, PROG, { head: SHA2 })], test: [GREEN], review: [DONE, DONE] };
      const runAns = { 'select-1': { done: true, rc: 0, log: `${sd}/wait-select-1.log` }, 'select-t1': { done: true, rc: 0, log: `${sd}/wait-select-t1.log` }, 'train-1': { done: true, rc: 11, log: `${sd}/wait-train-1.log` }, 'train-2': { done: true, rc: 0, log: `${sd}/wait-train-2.log` } };
      const ans = { env: { ok: true, problems: [], notes: [] }, post: { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } }, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] }, run: (s) => runAns[s.label.split(':')[2]] };
      const config = { sharedDir: path.join(W, 'sx'), worktreeRoot: WTR, scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'], guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}' };
      const t = { key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'a test task', base: 'arc', stepDir: sd };
      const x = await CRM.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [t] },
        launch: async (plan) => { launches.push(plan); const list = q[plan.label.split(':')[0]] || []; return list.length ? { output: list.shift() } : { outcome: 'crashed', error: 'no answer' }; },
        exec: async (step) => { seen.push(step); const a = ans[step.kind]; const v = typeof a === 'function' ? a(step) : a; return { value: v === undefined ? null : v }; }, note: () => {}, log: () => {} });
      const runs = seen.filter((s) => s.kind === 'run');
      const idOf = (s) => s.argv[s.argv.indexOf('--id') + 1];
      ok('X2 the wait steps have their ids in the steps folder the conductor gave, and start them with --once', runs.length >= 3 && runs.every((s) => path.dirname(idOf(s)) === sd && s.argv.includes('--once') && s.wait.id === idOf(s)),
        JSON.stringify(runs.map((s) => s.argv)) + ' ' + JSON.stringify(x.results[0]));
      const sel = runs.find((s) => /select/.test(s.label));
      ok('X2 the copy of the selection log goes into the steps folder', !!sel && sel.argv.join(' ').includes(`${sd}/wait-select-1.guards.txt`), sel && sel.argv.join(' '));
      const tr = runs.find((s) => /train/.test(s.label));
      ok('X2 the train copies its logs into the steps folder (ride --dir)', !!tr && / --dir /.test(tr.argv.join(' ')) && tr.argv.join(' ').includes(`--dir '${sd}'`), tr && tr.argv.join(' '));
      const lefts = seen.filter((s) => s.kind === 'left' || s.kind === 'post');
      ok('X2 the leftovers post-checks write leftovers.md into the steps folder', lefts.length >= 1 && lefts.every((s) => s.argv.includes(`${sd}/leftovers.md`)), JSON.stringify(lefts.map((s) => s.argv)));
      const fixP = (launches.filter((p) => p.label.startsWith('prog:'))[1] || {}).stdin || '';
      ok('X2 the programmer after a red train is told the copies of the logs are in the steps folder', fixP.includes(`copies of the logs are in ${sd}`), fixP.slice(0, 800));
    }

    // ---- through the conductor: the steps folder, SIGKILL, the reconciliation, a lock removed by hand
    {
      let fd = fake({ programmer: [PROG], tester: [GREEN], reviewer: [DONE] });
      let s = start([task('g1')], fd);
      const sd = s.j && path.join(s.j.runDir, 'steps', 'g1');
      // checked at once: "ready" comes after the registration, before any step could make the folder itself
      const made = !!sd && (() => { try { return fs.lstatSync(sd).isDirectory(); } catch { return false; } })();
      let r = resultOf(s);
      ok('X2 the conductor makes <runDir>/steps/<key>/ for a held task when it registers it, a folder, no link', r && r.status === 'done' && made, JSON.stringify(r));
      const rec = CJ.readJsonSafe(path.join(s.j.runDir, 'tasks', 'g1.json')) || {};
      ok('C6 the record of a task carries what the reconciliation found', Array.isArray((rec.reconcile || {}).notes), JSON.stringify(rec));

      fd = fake({ programmer: [{ $sleep: 120, then: PROG }, PROG], tester: [GREEN], reviewer: [DONE] });
      s = start([task('d1')], fd);
      const role = until(() => starts(fd, 'programmer')[0]);
      process.kill(s.j.pid, 'SIGKILL');
      until(() => !alive(s.j.pid), 5000);
      const lock1 = fs.readFileSync(lockOf('d1'), 'utf8');
      const s2 = start([task('d1')], fd);
      const why2 = (s2.j && s2.j.tasks && s2.j.tasks.d1) || '';
      ok('C1 SIGKILL of the conductor in the middle of a role: the next start is refused by the reconciliation - run, step, pid alive, no result recorded',
        /^undetermined/.test(why2) && why2.includes(s.j.runId) && /prog:d1#1/.test(why2) && why2.includes(`pid ${role.pid}`) && /alive/.test(why2) && /no result recorded/.test(why2), why2);
      resultOf(s2);
      ok('C1 ... no role ran again, the dead lock stays as it was, no mark file', starts(fd, 'programmer').length === 1 && fs.readFileSync(lockOf('d1'), 'utf8') === lock1 && !marks().length, starts(fd).map((e) => e.key).join('>'));
      try { process.kill(-role.pid, 'SIGKILL'); } catch { /* gone */ }
      until(() => !alive(role.pid), 5000);
      const s3 = start([task('d1')], fd);
      const why3 = (s3.j && s3.j.tasks && s3.j.tasks.d1) || '';
      ok('C1 the role ended: still refused (a launched never step without a result), now "gone"', /^undetermined/.test(why3) && /gone/.test(why3), why3);
      resultOf(s3);
      fs.unlinkSync(lockOf('d1'));
      const s4 = start([task('d1')], fd);
      const why4 = (s4.j && s4.j.tasks && s4.j.tasks.d1) || '';
      resultOf(s4);
      ok('L3 the lock removed by hand does not lift the refusal, and the refusing run takes no lock of its own', /^undetermined/.test(why4) && !fs.existsSync(lockOf('d1')) && starts(fd, 'programmer').length === 1, why4);
      ok('C8 the refused starts registered nothing: one run of d1 holds a record', registered('d1').length === 1, registered('d1').join());

      // L3: a live conductor's lock removed by hand
      fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
      s = start([task('h1')], fd);
      const roleH = until(() => starts(fd, 'programmer')[0]);
      fs.unlinkSync(lockOf('h1'));
      const sh = start([task('h1')], fd);
      const whyH = (sh.j && sh.j.tasks && sh.j.tasks.h1) || '';
      ok('L3 I-S1 the lock of a live conductor removed by hand: "another conductor", no second writer', /another conductor/.test(whyH) && starts(fd, 'programmer').length === 1, whyH);
      resultOf(sh);
      process.kill(s.j.pid, 'SIGKILL');
      try { process.kill(-roleH.pid, 'SIGKILL'); } catch { /* gone */ }

      // L4a: two starts at once over a dead lock whose run registered nothing: one registered run; then the next start goes
      fs.mkdirSync(path.join(RUNS, 'lost-run'), { recursive: true });
      fs.writeFileSync(lockOf('two'), JSON.stringify({ pid: DEAD, lstart: 'Mon Jan  1 00:00:00 2001', runId: 'lost-run', takenAt: 't' }));
      fd = fake({ programmer: [{ $sleep: 3, then: PROG }, PROG], tester: [GREEN, GREEN], reviewer: [DONE, DONE] });
      const tf = tasksFile([task('two')]);
      const both = await Promise.all([0, 1].map(() => new Promise((res) => {
        const c = spawn(process.execPath, [CR, 'start', '--host', 'claude', '--tasks', tf, '--owner', OWNER, '--config', CFG], { env: envOf(fd), stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        c.stdout.on('data', (d) => { o += d; });
        c.on('close', () => { try { const j = JSON.parse(o); groups.add(j.pid); res(j); } catch { res(null); } });
      })));
      const fins = both.map((j) => (j ? finished(j) : null));
      const rs = fins.map((f) => f && f.results && f.results[0]);
      ok('L4a two starts of one task at once over a dead lock: exactly one registered run, the other "another conductor" (or refused by the live token)',
        registered('two').length === 1 && rs.filter((x) => x && x.status === 'done').length === 1 && rs.filter((x) => x && x.status === 'stopped' && /another conductor/.test(x.why)).length === 1 && starts(fd, 'programmer').length === 1,
        JSON.stringify(rs) + ' ' + registered('two').join());
      s = start([task('two')], fd);
      r = resultOf(s);
      ok('L4a C8 the next start after the winner ended is not blocked by the loser\'s folder', s.j && s.j.tasks.two === 'held' && r && r.status === 'done', JSON.stringify(r) + ' ' + JSON.stringify(s.j && s.j.tasks));
    }
  } finally {
    cleanup();
  }
  sleepMs(300);
  const left = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(W) && !l.includes(' ps '));
  ok('no process of this test remains', !left.length, left.join('\n'));
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  // the tester cells: tests/chain-run-reconcile-tester-cases.js, a child with its own tally, so README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'chain-run-reconcile-tester-cases.js')], { encoding: 'utf8', timeout: 280000 });
    ok('the tester cells of the reconciliation (tests/chain-run-reconcile-tester-cases.js) pass', tc.status === 0,
      `${tc.status} ${tc.signal || ''} ${String(tc.stdout).split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 3000)}${(tc.stderr || '').slice(-500)}`);
  }
  done();
})().catch((e) => { cleanup(); console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
