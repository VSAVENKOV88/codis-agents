#!/usr/bin/env node
'use strict';
// `chain-run.js stop` and the gates of a stopping conductor, without a conductor run (p-codex-B1-b2b-2, analysis
// p-codex-B1-b2b §11.2, §11.5): the order of the checks of stop on run folders the test writes, whose run.json names a
// `sleep` of the test, and the gates of the adapter and of the conductor's script in processes of their own (the stop
// state of a process is set once and never lifted). Cells:
//   S1  identity matches: exit 0, {sent, pid, runId}, one SIGTERM line in KILL_LOG with that pid (> 1), the process gets it;
//   S1b the start time with two spaces (days 1-9): a ps that doubles the spaces of its output, and a run.json that holds
//       the doubled form with the real ps - both match (normL on both sides);
//   S2  results.json there: exit 2, {state: finished, exitCode}, no signal;
//   S3  the pid of a live process that started at another time, the pid of an ended process: exit 4, dead, no signal;
//   S4  no run.json, not JSON, pid 1, 0, -1, "7", lstart null, ps refusing for a live pid: exit 6, the reason, no signal;
//   S5  no argument: 64 with a usage that names stop; an unknown run: 64, "no run <id>";
//   S9  a signal while the adapter's beforeLaunch runs (the hook check): the role is not launched, the call is signalled;
//   S10 the second hook check of one run home waits in the queue when the conductor stops: its process never starts;
//   S11 stopAll of the adapter with no live role: the next call is refused as signalled with no process; a role process
//       that enters after it is stopped at once;
//   S12/S16 (gates) a stopping conductor's script starts no role and no service step: every task ends stopped, signalled.
// Every stop runs under tests/fixtures/chain-run/kill-hook.js: a signal reaches only the pid of a line =<pid>.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CRP = path.join(ROOT, 'scripts', 'chain-run.js');
const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');

// ---- the cases that set the stop state of their process: node chain-run-stop.test.js --case <name> prints JSON
if (process.argv[2] === '--case') {
  const RE = require('../scripts/role-exec.js');
  const CR = require('../scripts/chain-run.js');
  const W = process.argv[4];
  const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
  const t = { key: 'T1', dir: path.join(W, 'T1'), wt: path.join(W, 'T1') };
  fs.mkdirSync(t.dir, { recursive: true });
  const records = () => { try { return fs.readFileSync(path.join(t.dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const launched = [];
  const mk = (extra) => RE.createAgent(Object.assign({ host: 'claude', tasks: { [t.key]: { dir: t.dir, wt: t.wt } }, pluginRoot: ROOT, callsDir: path.join(W, 'calls'), log: () => {},
    launch: async (plan) => { launched.push(plan.label); return { output: { verdict: 'done' } }; } }, extra || {}));
  const call = (ag) => ag('the prompt', { label: `review:${t.key}#1`, schema: SCHEMA, agentType: 'general-purpose' });
  const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
  (async () => {
    const name = process.argv[3];
    if (name === 'S9') {
      const v = await call(mk({ beforeLaunch: async () => { RE.stopAll('SIGTERM'); return null; } }));
      const r = records()[0] || {};
      out({ v, launched, outcome: r.outcome, pid: r.pid });
    } else if (name === 'S10') {
      const counter = path.join(W, 'checks.log');
      const script = path.join(W, 'check.js');
      fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(counter)}, process.pid + '\\n'); require('child_process').spawnSync('sleep', ['1']); process.exit(0);\n`);
      const g = CR.hookGate({ home: W, bin: 'codex', script, note: () => {} });
      const p1 = g({ label: 'prog:T1#1', cwd: W }), p2 = g({ label: 'prog:T2#1', cwd: W });
      await new Promise((r) => setTimeout(r, 300));
      CR.beginStop('SIGTERM');
      const [r1, r2] = await Promise.all([p1, p2]);
      let n = 0;
      try { n = fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length; } catch { /* none */ }
      out({ r1, r2, checks: n });
    } else if (name === 'S11') {
      RE.stopAll('SIGTERM');
      const v = await call(mk());
      const r = records()[0] || {};
      const callDir = path.join(W, 'call1');
      fs.mkdirSync(callDir);
      const t0 = Date.now();
      const sr = await RE.spawnRole({ host: 'claude', bin: 'sleep', argv: ['30'], stdin: '', env: process.env, cwd: W, callDir, label: 'review:T1#2' }, { ceilingMs: 60000, graceMs: 500 });
      out({ v, launched, outcome: r.outcome, pid: r.pid, role: sr.outcome, ms: Date.now() - t0 });
    } else if (name === 'gates') {
      CR.beginStop('SIGTERM');
      const execs = [];
      const config = { sharedDir: path.join(W, 's'), worktreeRoot: path.join(W, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] };
      const args = { owner: 'the owner', config, tasks: [{ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }] };
      const x = await CR.runScript({ host: 'claude', args, launch: async (plan) => { launched.push(plan.label); return { output: {} }; },
        exec: async (step) => { execs.push(step.label); return { value: null }; }, callsDir: path.join(W, 'calls') });
      out({ results: x.results, threw: x.threw ? String(x.threw) : null, launched, execs });
    }
  })().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.stack) }) + '\n'); process.exit(1); });
  return;
}

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-stop-')));
const SHARED = path.join(W, 's'), RUNS = path.join(SHARED, 'runs');
const CFG = path.join(W, 'codis-agents.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: W, sharedDir: SHARED, worktreeRoot: path.join(W, 'r'), guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }));
const KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow');
const sleeps = [];
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && !!r.stdout.trim() && !/^Z/.test(r.stdout.trim()); };
const lstart = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).stdout.trim();
const sleep = () => { const c = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' }); sleeps.push(c.pid); return c.pid; };
const klog = () => { try { return fs.readFileSync(KLOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const signals = () => klog().filter((l) => l.sig !== 0 && l.sig !== '0');
// Fake ps folders: one doubles every space of the real output, one refuses.
const PSD = path.join(W, 'ps-double'), PSN = path.join(W, 'ps-none');
for (const [d, body] of [[PSD, '#!/bin/sh\n/bin/ps "$@" | sed \'s/ /  /g\'\n'], [PSN, '#!/bin/sh\nexit 1\n']]) {
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'ps'), body, { mode: 0o755 });
}
let nRun = 0;
// A run folder: request.json and the given run.json (an object, a text, or null for none), results.json when given.
function runFolder(run, results) {
  const id = `20261108T000000Z-t${++nRun}`;
  const d = path.join(RUNS, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'request.json'), JSON.stringify({ runId: id, host: 'claude', args: { tasks: [] } }));
  if (run !== null) fs.writeFileSync(path.join(d, 'run.json'), typeof run === 'string' ? run : JSON.stringify(Object.assign({ runId: id }, run)));
  if (results) fs.writeFileSync(path.join(d, 'results.json'), JSON.stringify(results));
  return { id, d };
}
function stop(args, o) {
  for (const f of [KLOG]) try { fs.unlinkSync(f); } catch { /* none */ }
  fs.writeFileSync(ALLOW, (o && o.allow) || '');
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `-r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW }, o && o.ps ? { PATH: `${o.ps}${path.delimiter}${process.env.PATH}` } : {});
  const p = spawnSync(process.execPath, [CRP, 'stop'].concat(args), { encoding: 'utf8', env, timeout: 30000 });
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  return { code: p.status, j, err: p.stderr, out: p.stdout };
}
const caseOf = (name) => {
  const cw = fs.mkdtempSync(path.join(W, `case-${name}-`));
  const p = spawnSync(process.execPath, [__filename, '--case', name, cw], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { NODE_OPTIONS: '' }) });
  try { return JSON.parse(p.stdout.trim().split('\n').pop()); } catch { return { error: `${p.status} ${p.stdout} ${p.stderr}`.slice(0, 1500) }; }
};

try {
  // ---- S1: the identity of the conductor matches
  let P = sleep();
  sleepMs(200);
  let f = runFolder({ pid: P, lstart: lstart(P) });
  let r = stop([f.d], { allow: `=${P}\n` });
  ok('S1 identity matches: exit 0, {sent: SIGTERM, pid, runId}', r.code === 0 && r.j && r.j.sent === 'SIGTERM' && r.j.pid === P && r.j.runId === f.id, JSON.stringify(r));
  const s1 = signals();
  ok('S1 KILL_LOG: one SIGTERM line, to the pid (> 1) of the conductor, never to its group', s1.length === 1 && s1[0].pid === P && s1[0].sig === 'SIGTERM', JSON.stringify(klog()));
  sleepMs(300);
  ok('S1 the process got the signal', !alive(P));

  // ---- S1b: two spaces in the start time
  P = sleep();
  sleepMs(200);
  f = runFolder({ pid: P, lstart: lstart(P) });
  r = stop([f.d], { allow: `=${P}\n`, ps: PSD });
  ok('S1b a ps whose lstart has doubled spaces still matches run.json: exit 0, the signal sent', r.code === 0 && r.j && r.j.sent === 'SIGTERM' && signals().length === 1, JSON.stringify(r) + JSON.stringify(klog()));
  P = sleep();
  sleepMs(200);
  f = runFolder({ pid: P, lstart: lstart(P).replace(/ /g, '  ') });
  r = stop([f.d], { allow: `=${P}\n` });
  ok('S1b a run.json whose lstart has doubled spaces matches the real ps: exit 0, the signal sent', r.code === 0 && r.j && r.j.sent === 'SIGTERM' && signals().length === 1, JSON.stringify(r) + JSON.stringify(klog()));

  // ---- S2: the run has its results.json
  P = sleep();
  sleepMs(200);
  f = runFolder({ pid: P, lstart: lstart(P) }, { runId: 'x', exitCode: 143, results: [] });
  r = stop([f.d], { allow: `=${P}\n` });
  ok('S2 results.json there: exit 2, {state: finished, exitCode}, no signal', r.code === 2 && r.j && r.j.state === 'finished' && r.j.exitCode === 143 && signals().length === 0 && alive(P), JSON.stringify(r));

  // ---- S3: the pid is another process, or no process
  f = runFolder({ pid: P, lstart: 'Mon Jan  1 00:00:00 2001' });
  r = stop([f.d], { allow: `=${P}\n` });
  ok('S3 the pid of a live process that started at another time: exit 4, dead, no signal', r.code === 4 && r.j && r.j.state === 'dead' && signals().length === 0 && alive(P), JSON.stringify(r));
  const ended = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
  f = runFolder({ pid: +ended, lstart: 'Mon Jan  1 00:00:00 2001' });
  r = stop([f.d], { allow: `=${ended}\n` });
  ok('S3 the pid of an ended process: exit 4, dead, no signal', r.code === 4 && r.j && r.j.state === 'dead' && signals().length === 0, JSON.stringify(r));

  // ---- S4: the identity cannot be established
  const L = lstart(P);
  const s4 = [['no run.json', null], ['run.json not JSON', '{nope'], ['pid 1', { pid: 1, lstart: L }], ['pid 0', { pid: 0, lstart: L }], ['pid -1', { pid: -1, lstart: L }],
    ['pid "7"', { pid: String(P), lstart: L }], ['lstart null', { pid: P, lstart: null }], ['ps refuses for a live pid', { pid: P, lstart: L }, PSN]];
  for (const [name, run, ps] of s4) {
    f = runFolder(run);
    r = stop([f.d], { allow: `=${P}\n=1\n1\n`, ps });
    ok(`S4 ${name}: exit 6, unknown with its reason, no signal`, r.code === 6 && r.j && r.j.state === 'unknown' && typeof r.j.why === 'string' && r.j.why.length > 5 && r.err.includes(r.j.why)
      && signals().length === 0 && alive(P), JSON.stringify(r));
  }

  // ---- S5: arguments
  r = stop([]);
  ok('S5 no argument: 64, the usage names stop', r.code === 64 && /chain-run\.js stop <run-id\|run folder>/.test(r.err), r.err);
  r = stop(['nope-run', '--config', CFG]);
  ok('S5 an unknown run: 64, "no run nope-run in"', r.code === 64 && /no run nope-run in /.test(r.err), r.err);
  r = stop([runFolder({ pid: P, lstart: L }).d, '--bogus', 'x']);
  ok('S5 an unknown flag: 64', r.code === 64 && signals().length === 0, r.err);

  // ---- S9-S11, gates: in processes of their own
  let c = caseOf('S9');
  ok('S9 a signal during beforeLaunch: the role is not launched, the call ends signalled with no pid', !c.error && c.v === null && c.launched.length === 0 && c.outcome === 'signalled' && c.pid === null, JSON.stringify(c));
  c = caseOf('S10');
  ok('S10 the second hook check in the queue never starts once the conductor stops: one check process, the second call signalled',
    !c.error && c.checks === 1 && c.r1 === null && c.r2 && c.r2.outcome === 'signalled', JSON.stringify(c));
  c = caseOf('S11');
  ok('S11 stopAll with no live role: the next call is refused signalled, no launch, no pid', !c.error && c.v === null && c.launched.length === 0 && c.outcome === 'signalled' && c.pid === null, JSON.stringify(c));
  ok('S11 a role process that enters after stopAll is stopped at once (signalled, long before its 30 s)', !c.error && c.role === 'signalled' && c.ms < 10000, JSON.stringify(c));
  c = caseOf('gates');
  const g = (c.results || [])[0] || {};
  ok('gates a stopping conductor: no role and no service step starts, the task ends stopped with its signal', !c.error && !c.threw && c.launched.length === 0 && c.execs.length === 0
    && g.status === 'stopped' && g.signal === 'SIGTERM' && /^signalled: SIGTERM/.test(g.why || ''), JSON.stringify(c));
} finally {
  for (const s of sleeps) { try { process.kill(s, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
}
done();
