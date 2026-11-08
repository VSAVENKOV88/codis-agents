#!/usr/bin/env node
'use strict';
// The coordinator's resolve of a step a dead conductor left (p-codex-B1-b2b; analysis p-codex-B1-b2b §3: R1-R18, P1,
// Z4, Q1, Q2): a decision is one JSON file per step (runs/<runId>/resolved/<key>/<n>.json, abort.json), written whole by
// a hard link under the lock of the task and bound to the basis of the run's journal; the reconciliation closes a
// reason by a decision whose basis is the current one; the start must follow the next of the decisions of the newest run
// (resumeAt, head, prior); the commits journal of the adapter gets its resolved and result lines. Run folders are built
// here with the real journal writer; no model is called, every process a check starts is killed in the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');
const CRM = require('../scripts/chain-run.js');
const R = require('../scripts/chain-resolve.js');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-resolve-')));
const SHARED = path.join(W, 's'), RUNS = path.join(SHARED, 'runs'), REPO = path.join(W, 'repo');
fs.mkdirSync(RUNS, { recursive: true });
const CFGF = path.join(W, 'codis-agents.json');
const CFG = { repoDir: REPO, sharedDir: SHARED, worktreeRoot: W, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] };
fs.writeFileSync(CFGF, JSON.stringify(CFG));
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
const H = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
fs.writeFileSync(path.join(REPO, 'a.js'), '2\n');
git('-C', REPO, 'commit', '-q', '-am', 'the role');
const B = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const procs = [];
const sleeper = () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); procs.push(c); return c.pid; };
const lstartOf = (pid) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).stdout.trim().replace(/\s+/g, ' ');
const deadPid = () => +spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
const DEAD = { pid: deadPid(), lstart: 'Mon Jan 1 00:00:00 2024' };

// A run folder of task key: request.json, run.json, tasks/<key>.json and the journal from events (steps are numbered by n).
let nRun = 0;
function mkRun(key, steps, o = {}) {
  const id = o.id || `2026${String(++nRun).padStart(4, '0')}-run`;
  const rd = path.join(RUNS, id);
  fs.mkdirSync(path.join(rd, 'tasks'), { recursive: true });
  const t = Object.assign({ key, title: key, wt: REPO, branch: 'main', accept: 'a', kind: 'tail', noAnalysis: 'x' }, o.task || {});
  CJ.writeAtomic(path.join(rd, 'request.json'), { runId: id, host: 'claude', args: { owner: '', config: Object.assign({}, CFG, o.config || {}), tasks: [t] }, adapter: {} });
  const cond = o.conductor || DEAD;
  CJ.writeAtomic(path.join(rd, 'run.json'), { runId: id, pid: cond.pid, lstart: cond.lstart, host: 'claude', tasks: [key] });
  CJ.writeAtomic(path.join(rd, 'tasks', `${key}.json`), o.ended ? { state: 'ended', result: { status: 'stopped' } } : { state: 'running' });
  const j = CJ.openJournal(rd, id, key);
  // o.parallel: every intent and launch before the results (review || sec)
  const result = (s) => { if (s.value !== undefined) j.append({ type: 'result', stepId: `${id}:${s.n}`, outcome: 'ok', value: s.value }); };
  for (const s of steps) {
    const stepId = `${id}:${s.n}`;
    j.append({ type: 'intent', stepId, n: s.n, kind: s.kind || 'agent', stepKind: s.stepKind, label: s.label, effect: s.effect || 'never', gated: s.kind !== 'exec', gitHead: s.gitHead || H, counts: s.counts || { testerReds: 0, trainReds: 0, rejections: 0 }, head: '' });
    if (s.launch !== false) j.append({ type: 'launch', stepId, gated: s.kind !== 'exec', pid: s.pid || DEAD.pid, pgid: null, lstart: s.lstart || DEAD.lstart });
    if (!o.parallel) result(s);
  }
  if (o.parallel) steps.forEach(result);
  if (o.end) j.append({ type: 'end', status: 'stopped', counts: o.end });
  return { id, rd };
}
const cli = (args) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8' });
const status = (rd) => JSON.parse(cli(['status', rd]).stdout);
const resolve = (rd, key, extra) => cli(['resolve', rd, '--task', key].concat(extra));
const fileOf = (rd, key, n) => path.join(rd, 'resolved', key, n === 'abort' ? 'abort.json' : `${n}.json`);
const readD = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ctx = (key) => ({ wt: REPO, dir: path.join(SHARED, key), key });
const reasons = (key, own = 'own') => CRM.reconcile(RUNS, key, own, ctx(key)).reasons;
const clean = (key) => { for (const n of fs.readdirSync(RUNS)) { if (n.startsWith('.')) continue; const rd = path.join(RUNS, n); try { if (fs.existsSync(path.join(rd, 'tasks', `${key}.json`))) fs.rmSync(rd, { recursive: true, force: true }); } catch { /* */ } } };
const PROG1 = (key, extra) => Object.assign({ n: 1, stepKind: 'prog', label: `prog:${key}#1` }, extra || {});

// ---- R1, R2, R3: a decision on an open prog step; basis from status; a stale basis; a second decision
{
  const key = 'r1';
  const { rd } = mkRun(key, [PROG1(key)]);
  const st = status(rd);
  const basis = st.tasks && st.tasks[key] && st.tasks[key].basis;
  ok('R2: status prints the basis of the task\'s journal', /^\d+:[0-9a-f]{64}$/.test(basis || ''), JSON.stringify(st.tasks && st.tasks[key]));
  ok('R2: the basis is computed by one function (basisOf)', basis === R.basisOf(rd, key));
  let r = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'the commit B is the role\'s']);
  ok('R2: resolve without --basis is refused and prints the current basis', r.status !== 0 && r.stderr.includes(basis) && !fs.existsSync(fileOf(rd, key, 1)), r.stderr);
  r = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'n', '--basis', `${basis.split(':')[0]}:${'0'.repeat(64)}`]);
  ok('R2: a stale basis is refused, no file, the current basis named', r.status !== 0 && r.stderr.includes(basis) && !fs.existsSync(fileOf(rd, key, 1)), r.stderr);
  ok('R4: refused before any decision: the reason stays', reasons(key).length === 1);
  r = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'the commit B is the role\'s', '--basis', basis]);
  const d = readD(fileOf(rd, key, 1));
  ok('R1: ran on prog writes <n>.json with exit 0', r.status === 0 && !!d, r.stderr);
  ok('R1: the decision carries its fields', d && d.v === 1 && d.n === 1 && d.as === 'ran' && d.basis === basis && d.label === `prog:${key}#1` && d.note && d.facts && d.facts.conductor && d.facts.executor && typeof d.facts.decidedAt === 'string', JSON.stringify(d));
  ok('R6: prog ran -> next {resumeAt tester, head B}', d && d.next && d.next.resumeAt === 'tester' && d.next.head === B, JSON.stringify(d && d.next));
  ok('R11: the lock of the task is released after the decision', !fs.existsSync(path.join(RUNS, '.locks', `${key}.lock`)));
  const before = fs.readFileSync(fileOf(rd, key, 1), 'utf8');
  r = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', basis]);
  ok('R3: a second decision on the step is refused and names the first', r.status !== 0 && r.stderr.includes(fileOf(rd, key, 1)) && fs.readFileSync(fileOf(rd, key, 1), 'utf8') === before, r.stderr);
  ok('R8: the decision closes the reason of the reconciliation', reasons(key).length === 0, JSON.stringify(reasons(key)));
  const t0 = { key, wt: REPO };
  let sc = R.startCheck(RUNS, key, t0, 'own', ctx(key));
  ok('R8: a start without resumeAt is refused (next of the decision)', !!sc.why && /resumeAt/.test(sc.why), JSON.stringify(sc));
  sc = R.startCheck(RUNS, key, Object.assign({}, t0, { resumeAt: 'tester', head: B }), 'own', ctx(key));
  ok('R8: a start with resumeAt tester and head B goes', !sc.why, sc.why);
  sc = R.startCheck(RUNS, key, Object.assign({}, t0, { resumeAt: 'tester', head: H }), 'own', ctx(key));
  ok('R8: another head is refused', !!sc.why, JSON.stringify(sc));
  // a torn tail appended to the segment after the decision: another state of the journal
  const seg = path.join(rd, 'journal', key, 'seg-000.jsonl');
  fs.appendFileSync(seg, '{"torn');
  const rs = reasons(key);
  ok('R2: a decision for another state does not close the reason, and says so', rs.length === 1 && /another state|basis/.test(rs[0].why), JSON.stringify(rs));
  clean(key);
}

// ---- R4: refusals
{
  const key = 'r4';
  const kid = sleeper();
  let { rd } = mkRun(key, [PROG1(key, { pid: kid, lstart: lstartOf(kid) })]);
  let b = R.basisOf(rd, key);
  let r = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'n', '--basis', b]);
  ok('R4: the executor alive -> refused', r.status !== 0 && /alive/.test(r.stderr) && !fs.existsSync(path.join(rd, 'resolved', key, '1.json')), r.stderr);
  r = resolve(rd, key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R7: abort with an open step of a live executor -> refused', r.status !== 0 && !fs.existsSync(fileOf(rd, key, 'abort')), r.stderr);
  clean(key);
  ({ rd } = mkRun(key, [PROG1(key)], { conductor: { pid: process.pid, lstart: lstartOf(process.pid) }, ended: true }));
  b = R.basisOf(rd, key);
  r = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'n', '--basis', b]);
  ok('R4/K1: the conductor of the run alive -> refused: wait for the end of the run', r.status !== 0 && /wait for the end of the run/.test(r.stderr), r.stderr);
  clean(key);
  ({ rd } = mkRun(key, [PROG1(key), { n: 2, kind: 'exec', stepKind: 'post', label: `post:${key}:tester`, effect: 'none', value: { ok: true } }]));
  b = R.basisOf(rd, key);
  const cases = [
    [['--as', 'ran', '--step', '1', '--head', B, '--basis', b], 'no --note'],
    [['--as', 'ran', '--step', '1', '--head', B, '--note', ' ', '--basis', b], 'an empty --note'],
    [['--as', 'ran', '--step', '9', '--head', B, '--note', 'n', '--basis', b], 'no step 9'],
    [['--as', 'ran', '--step', '2', '--note', 'n', '--basis', b], 'a step that does not block (closed)'],
    [['--as', 'done', '--step', '1', '--note', 'n', '--basis', b], '--as unknown'],
    [['--as', 'ran', '--head', B, '--note', 'n', '--basis', b], 'ran without --step'],
    [['--as', 'abort', '--step', '1', '--note', 'n', '--basis', b], 'abort with --step'],
    [['--as', 'ran', '--step', '1', '--note', 'n', '--basis', b, '--verdict', 'green', '--head', B], '--verdict on prog'],
    [['--as', 'ran', '--step', '1', '--note', 'n', '--basis', b], 'prog ran without --head'],
    [['--as', 'ran', '--step', '1', '--note', 'n', '--basis', b, '--head', H], '--head not a descendant of H... equal to H is allowed? no: H itself made nothing'],
    [['--as', 'ran', '--step', '1', '--note', 'n', '--basis', b, '--head', B.slice(0, 10)], '--head abbreviated'],
  ];
  for (const [a, what] of cases) {
    const x = resolve(rd, key, a);
    ok(`R4/R5/R6: refused - ${what}`, x.status !== 0 && !fs.existsSync(path.join(rd, 'resolved', key, '1.json')) && !fs.existsSync(path.join(rd, 'resolved', key, '2.json')), `${x.status} ${x.stderr}`);
  }
  let x = resolve(path.join(RUNS, 'no-such-run'), key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R4: no run folder -> refused', x.status !== 0);
  x = resolve(rd, 'other', ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R4: the task is not registered in the run -> refused', x.status !== 0 && !fs.existsSync(path.join(rd, 'resolved', 'other')), x.stderr);
  // damage inside: ran refused, abort allowed and closes the run's reasons
  const seg = path.join(rd, 'journal', key, 'seg-000.jsonl');
  fs.writeFileSync(seg, fs.readFileSync(seg, 'utf8').replace(/"seq":2,/, '"seq":7,'));
  b = R.basisOf(rd, key);
  ok('R7: a damaged journal has seq 0 in its basis', b.startsWith('0:'), b);
  x = resolve(rd, key, ['--as', 'ran', '--step', '1', '--head', B, '--note', 'n', '--basis', b]);
  ok('R4: damage -> ran refused (only abort)', x.status !== 0 && /abort/.test(x.stderr), x.stderr);
  ok('R7: before abort the damage refuses the start', reasons(key).length === 1);
  x = resolve(rd, key, ['--as', 'abort', '--note', 'the journal is damaged', '--basis', b]);
  ok('R7: abort on damage writes abort.json', x.status === 0 && !!readD(fileOf(rd, key, 'abort')), x.stderr);
  ok('R7: abort closes the reasons of the run', reasons(key).length === 0, JSON.stringify(reasons(key)));
  let sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('R7/P1: a start after abort without priorReason is refused', !!sc.why && /priorReason/.test(sc.why), JSON.stringify(sc));
  sc = R.startCheck(RUNS, key, { key, priorReason: 'the run was aborted, its counts are not proven' }, 'own', ctx(key));
  ok('R7: a start after abort with priorReason goes', !sc.why, sc.why);
  sc = R.startCheck(RUNS, key, { key, priorReason: 'x', resumeAt: 'tester', head: B }, 'own', ctx(key));
  ok('Z3: resumeAt after abort is refused', !!sc.why, JSON.stringify(sc));
  x = resolve(rd, key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R3: a second abort is refused', x.status !== 0);
  clean(key);
  ({ rd } = mkRun(key, [PROG1(key)]));
  b = R.basisOf(rd, key);
  x = resolve(rd, key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  const x2 = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', b]);
  ok('R3: a step decision after abort is refused', x.status === 0 && x2.status !== 0 && !fs.existsSync(fileOf(rd, key, 1)), x2.stderr);
  clean(key);
}

// ---- R5, R14, R18: the verdict of a step from the full result line of the segment
{
  const key = 'r5';
  const long = 'x'.repeat(1000);
  const { rd } = mkRun(key, [PROG1(key, { value: { status: 'ready', head: B } }), { n: 2, stepKind: 'test', label: `test:${key}#1`, gitHead: B, value: { summary: long, verdict: 'red', head: B } }]);
  const b = R.basisOf(rd, key);
  ok('R14: an unaccounted verdict is a reason', reasons(key).length >= 1);
  let x = resolve(rd, key, ['--as', 'ran', '--step', '2', '--note', 'n', '--basis', b]);
  ok('R5: test ran without --verdict -> refused', x.status !== 0, x.stderr);
  x = resolve(rd, key, ['--as', 'ran', '--step', '2', '--verdict', 'blue', '--note', 'n', '--basis', b]);
  ok('R5: a verdict outside the kind -> refused', x.status !== 0, x.stderr);
  x = resolve(rd, key, ['--as', 'ran', '--step', '2', '--verdict', 'green', '--head', B, '--note', 'n', '--basis', b]);
  ok('R18: --verdict green against the recorded red (summary of 1000 before verdict) -> refused', x.status !== 0 && /red/.test(x.stderr), x.stderr);
  x = resolve(rd, key, ['--as', 'ran', '--step', '2', '--verdict', 'red', '--note', 'n', '--basis', b]);
  const d = readD(fileOf(rd, key, 2));
  ok('R14/R6: ran with the recorded verdict red -> next from the programmer, testerReds +1', x.status === 0 && d && d.verdict === 'red' && d.next && d.next.resumeAt === null && d.next.counts.testerReds === 1, `${x.stderr} ${JSON.stringify(d)}`);
  ok('R18: the verdict source is one function', R.recordedOf(rd, key, 2).verdict === 'red');
  ok('R14: the reason is closed', reasons(key).length === 0, JSON.stringify(reasons(key)));
  clean(key);
}

// ---- R15: the threshold of the analyst, the same predicate as the chain
{
  const key = 'r15';
  let { rd } = mkRun(key, [{ n: 1, stepKind: 'review', label: `review:${key}#1`, counts: { testerReds: 0, trainReds: 0, rejections: 1 }, value: { verdict: 'rejected', docsOnly: false, summary: 'y'.repeat(600) } }]);
  let b = R.basisOf(rd, key);
  let x = resolve(rd, key, ['--as', 'ran', '--step', '1', '--verdict', 'rejected', '--note', 'n', '--basis', b]);
  ok('R15: rejected with prior rejections 1 -> refused, route analyst, counts named', x.status !== 0 && /analyst/.test(x.stderr) && /rejections/.test(x.stderr) && /abort/.test(x.stderr) && !fs.existsSync(fileOf(rd, key, 1)), x.stderr);
  x = resolve(rd, key, ['--as', 'abort', '--note', 'review rejected the second time', '--basis', b]);
  ok('R15: the way out is abort', x.status === 0, x.stderr);
  clean(key);
  ({ rd } = mkRun(key, [{ n: 1, stepKind: 'test', label: `test:${key}#1`, counts: { testerReds: 1, trainReds: 0, rejections: 0, analyst: 'rejection' }, value: { verdict: 'red', head: B, summary: '' } }]));
  b = R.basisOf(rd, key);
  x = resolve(rd, key, ['--as', 'ran', '--step', '1', '--verdict', 'red', '--note', 'n', '--basis', b]);
  ok('R15: test red after the analyst of a rejection is no threshold -> written', x.status === 0 && readD(fileOf(rd, key, 1)).next.counts.testerReds === 2, x.stderr);
  clean(key);
  ({ rd } = mkRun(key, [{ n: 1, kind: 'exec', stepKind: 'run', label: `run:${key}:train-1`, effect: 'reuse', counts: { testerReds: 0, trainReds: 1, rejections: 0 }, value: { done: true, rc: 11, log: '/l' } }], { config: { guardSubsetCommand: 'true {wt}' } }));
  b = R.basisOf(rd, key);
  x = resolve(rd, key, ['--as', 'ran', '--step', '1', '--verdict', 'red', '--note', 'n', '--basis', b]);
  ok('R15: the second red train -> refused, route analyst', x.status !== 0 && /analyst/.test(x.stderr) && /train-red/.test(x.stderr), x.stderr);
  clean(key);
}

// ---- R16 (G13, G14): the context of a step by mode and label; R6 the table
{
  const C = { testerReds: 0, trainReds: 0, rejections: 0 };
  const step = (label, stepKind, extra) => Object.assign({ label, stepKind, n: 1, gitHead: H, counts: C }, extra || {});
  const nx = (s, as, verdict, head, form) => R.nextOf({ step: s, as, verdict, head, form: Object.assign({ light: false, oneRun: true }, form || {}), wt: REPO });
  let v = nx(step('run:k:select-1', 'run'), 'ran', 'green');
  ok('R6: select green -> tester, head H', v.next && v.next.resumeAt === 'tester' && v.next.head === H, JSON.stringify(v));
  v = nx(step('run:k:select-1f', 'run'), 'ran', 'green');
  ok('R16/G14: select-1f is the main path', v.next && v.next.resumeAt === 'tester', JSON.stringify(v));
  v = nx(step('prog:k#1m', 'prog'), 'ran', undefined, B);
  ok('R16/G14: prog#1m is the main path', v.next && v.next.resumeAt === 'tester', JSON.stringify(v));
  v = nx(step('review:k#T1', 'review'), 'ran', 'done');
  ok('R16/G14: review#T1 is the main path -> train', v.next && v.next.resumeAt === 'train' && v.next.since === H, JSON.stringify(v));
  v = nx(step('run:k:select-r', 'run'), 'ran', 'green');
  ok('R16: select-r (after the review) ran -> only retry or abort', !!v.error && /only retry or abort/.test(v.error), JSON.stringify(v));
  v = nx(step('run:k:select-r', 'run'), 'retry');
  ok('R16: retry after the review -> from the beginning with the counts', v.next && v.next.resumeAt === null && v.next.counts === C, JSON.stringify(v));
  v = nx(step('prog:k#t1', 'prog'), 'ran', undefined, B);
  ok('R16: a round after the train ran -> refused', !!v.error, JSON.stringify(v));
  v = nx(step('review:k#2', 'review'), 'ran', 'done');
  ok('R16: the second review ran -> refused', !!v.error, JSON.stringify(v));
  v = nx(step('prog:k#zz', 'prog'), 'ran', undefined, B);
  ok('R16/G14: an unknown label -> refused', !!v.error && /only retry or abort/.test(v.error), JSON.stringify(v));
  v = nx(step('prog:k#1', 'prog'), 'ran', undefined, B, { light: true });
  ok('R16: light prog ran -> review, head B', v.next && v.next.resumeAt === 'review' && v.next.head === B && !v.next.since, JSON.stringify(v));
  v = nx(step('run:k:select-1', 'run'), 'ran', 'green', undefined, { light: true });
  ok('R16/G13: light select green -> review, head H', v.next && v.next.resumeAt === 'review' && v.next.head === H, JSON.stringify(v));
  v = nx(step('review:k#1', 'review'), 'ran', 'done', undefined, { light: true });
  ok('R16: light review ran -> refused', !!v.error, JSON.stringify(v));
  v = nx(step('test:k#1', 'test'), 'ran', 'green', B);
  ok('R6/Z5: test green -> review, head of the tester, since H', v.next && v.next.resumeAt === 'review' && v.next.head === B && v.next.since === H, JSON.stringify(v));
  v = nx(step('review:k#1', 'review'), 'ran', 'done', undefined, { oneRun: false });
  ok('R6: review done without ONE_RUN -> done', v.next === 'done', JSON.stringify(v));
  v = nx(step('run:k:train-1', 'run'), 'ran', 'green');
  ok('R6: train green -> done', v.next === 'done', JSON.stringify(v));
  v = nx(step('run:k:train-1', 'run'), 'ran', 'arc-red');
  ok('R6: train arc-red -> train, head H', v.next && v.next.resumeAt === 'train' && v.next.head === H, JSON.stringify(v));
  v = nx(step('analyst:k', 'analyst'), 'ran');
  ok('R6: analyst ran -> from the beginning without analystFirst', v.next && v.next.resumeAt === null && v.next.noAnalystFirst === true, JSON.stringify(v));
  v = nx(step('post:k:tester', 'post'), 'ran');
  ok('R6: a service step gives no next', v.next === null && !v.error, JSON.stringify(v));
}

// ---- R9, R17: what counts as a decision; the temporary name
{
  const key = 'r9';
  const { id, rd } = mkRun(key, [PROG1(key)]);
  const b = R.basisOf(rd, key);
  const dir = path.join(rd, 'resolved', key);
  fs.mkdirSync(dir, { recursive: true });
  const good = { v: 1, runId: id, key, n: 1, as: 'retry', basis: b, next: { resumeAt: null, head: null, counts: {} } };
  const bad = [
    ['garbage', () => fs.writeFileSync(path.join(dir, '1.json'), 'not json')],
    ['another v', () => fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(Object.assign({}, good, { v: 9 })))],
    ['another runId', () => fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(Object.assign({}, good, { runId: 'x' })))],
    ['another n', () => fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(Object.assign({}, good, { n: 2 })))],
    ['a link', () => { fs.writeFileSync(path.join(W, 'outside.json'), JSON.stringify(good)); fs.symlinkSync(path.join(W, 'outside.json'), path.join(dir, '1.json')); }],
    ['a FIFO', () => spawnSync('mkfifo', [path.join(dir, '1.json')])],
  ];
  for (const [what, make] of bad) {
    fs.rmSync(path.join(dir, '1.json'), { force: true });
    make();
    ok(`R9: ${what} in place of the decision is no decision, the reason stays`, R.decisionsOf(rd, key).list.length === 0 && reasons(key).length === 1);
  }
  fs.rmSync(path.join(dir, '1.json'), { force: true });
  // a leftover temporary name of a resolve killed before link: the next resolve of the step removes it and writes
  fs.writeFileSync(path.join(dir, '1.json.tmp'), 'half');
  ok('R17: a temporary name is no decision', R.decisionsOf(rd, key).list.length === 0);
  let x = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', b]);
  ok('R17: the next resolve removes the orphan tmp and writes', x.status === 0 && !fs.existsSync(path.join(dir, '1.json.tmp')) && !!readD(path.join(dir, '1.json')), x.stderr);
  // killed between link and unlink: two names of one file
  fs.linkSync(path.join(dir, '1.json'), path.join(dir, '1.json.tmp'));
  ok('R17: a decision with two links (killed between link and unlink) is a decision', R.decisionsOf(rd, key).list.length === 1);
  x = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', b]);
  ok('R17: a repeat on the step -> "second decision", no dead end', x.status !== 0 && /second decision/.test(x.stderr), x.stderr);
  x = resolve(rd, key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R17: a resolve of another decision of the task removes the orphan tmp', x.status === 0 && !fs.existsSync(path.join(dir, '1.json.tmp')), x.stderr);
  clean(key);
  const r2 = mkRun(key, [PROG1(key)]);
  fs.mkdirSync(path.join(r2.rd, 'resolved'));
  fs.writeFileSync(path.join(r2.rd, 'resolved', key), 'a file');
  x = resolve(r2.rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', R.basisOf(r2.rd, key)]);
  ok('R9: resolved/<key> is a file -> resolve refuses', x.status !== 0 && fs.readFileSync(path.join(r2.rd, 'resolved', key), 'utf8') === 'a file', x.stderr);
  clean(key);
}

// ---- R11, R12: the lock
{
  const key = 'r11';
  const { id, rd } = mkRun(key, [PROG1(key)]);
  const b = R.basisOf(rd, key);
  const lock = path.join(RUNS, '.locks', `${key}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, lstart: lstartOf(process.pid), runId: 'zz-live', takenAt: 'x' }));
  let x = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', b]);
  ok('R11: a live conductor holds the lock -> refused', x.status !== 0 && /another conductor/.test(x.stderr), x.stderr);
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD.pid, lstart: DEAD.lstart, runId: id, takenAt: 'x' }));
  x = resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', b]);
  ok('R11: the dead lock of the target run is taken over and released', x.status === 0 && !fs.existsSync(lock), x.stderr);
  ok('R11: the lock of resolve names the target run (lockData by resolve)', CRM.lockData({ pid: 5, lstart: 'l', runId: id, by: 'resolve' }).runId === id && CRM.lockData({ pid: 5, lstart: 'l', runId: id, by: 'resolve' }).by === 'resolve');
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD.pid, lstart: DEAD.lstart, runId: 'gone-run', takenAt: 'x' }));
  x = resolve(rd, key, ['--as', 'abort', '--note', 'n', '--basis', b]);
  ok('R12: a dead lock of a run without its folder -> refused, cleanup by hand', x.status !== 0 && /by hand/.test(x.stderr) && fs.existsSync(lock), x.stderr);
  fs.rmSync(lock);
  clean(key);
}

// ---- R13: review || sec
{
  const key = 'r13';
  const C = { testerReds: 0, trainReds: 0, rejections: 0 };
  const { rd } = mkRun(key, [{ n: 1, stepKind: 'review', label: `review:${key}#1`, counts: C, value: { verdict: 'done', docsOnly: false, summary: '' } },
    { n: 2, stepKind: 'sec', label: `sec:${key}#1`, counts: C, value: { verdict: 'rejected', docsOnly: false, summary: '' } }], { parallel: true });
  const b = R.basisOf(rd, key);
  let x = resolve(rd, key, ['--as', 'ran', '--step', '1', '--verdict', 'done', '--note', 'n', '--basis', b]);
  let sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('R13: one of review || sec decided, the other open -> the start is refused', x.status === 0 && !!(reasons(key).length || sc.why));
  x = resolve(rd, key, ['--as', 'ran', '--step', '2', '--verdict', 'rejected', '--note', 'n', '--basis', b]);
  sc = R.startCheck(RUNS, key, { key, prior: { rejections: 1 } }, 'own', ctx(key));
  ok('R13: done + rejected fold to rejected, one increment: a start from the programmer with rejections 1 goes', x.status === 0 && reasons(key).length === 0 && !sc.why, `${x.stderr} ${sc.why}`);
  sc = R.startCheck(RUNS, key, { key, resumeAt: 'train', head: H }, 'own', ctx(key));
  ok('R13: not the train after a rejection', !!sc.why);
  clean(key);
}

// ---- P1, Z4: prior against the counts; the worktree after a decision
{
  const key = 'p1';
  mkRun(key, [], { ended: true, end: { testerReds: 1, trainReds: 0, rejections: 0 } });
  let sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('P1: no prior while the newest journal counts testerReds 1 -> refused, both sets named', !!sc.why && /testerReds/.test(sc.why) && /priorReason/.test(sc.why), JSON.stringify(sc));
  sc = R.startCheck(RUNS, key, { key, prior: { testerReds: 1 } }, 'own', ctx(key));
  ok('P1: prior equal to the counts goes', !sc.why, sc.why);
  sc = R.startCheck(RUNS, key, { key, prior: { testerReds: 2 }, priorReason: 'a Workflow run in between' }, 'own', ctx(key));
  ok('P1: prior differs with priorReason -> goes, the difference and the reason kept', !sc.why && sc.priorNote && /testerReds/.test(sc.priorNote) && /Workflow/.test(sc.priorNote), JSON.stringify(sc));
  clean(key);
  mkRun(key, [], { ended: true, end: { testerReds: 0, trainReds: 0, rejections: 0 } });
  sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('P1: no prior at zero counts goes', !sc.why, sc.why);
  clean(key);
  const { rd } = mkRun(key, [PROG1(key)]);
  resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'n', '--basis', R.basisOf(rd, key)]);
  fs.writeFileSync(path.join(REPO, 'a.js'), 'dirty\n');
  sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('Z4: a tracked change after a decision -> refused with the file', !!sc.why && /a\.js/.test(sc.why), JSON.stringify(sc));
  git('-C', REPO, 'checkout', '-q', 'a.js');
  fs.writeFileSync(path.join(REPO, 'new.txt'), 'u');
  sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('Z4: only untracked files -> goes', !sc.why, sc.why);
  fs.rmSync(path.join(REPO, 'new.txt'));
  clean(key);
  // next done
  const d2 = mkRun(key, [{ n: 1, kind: 'exec', stepKind: 'run', label: `run:${key}:train-1`, effect: 'reuse', value: { done: true, rc: 0, log: '/l' } }], { config: { guardSubsetCommand: 'true {wt}' } });
  const x = resolve(d2.rd, key, ['--as', 'ran', '--step', '1', '--verdict', 'green', '--note', 'n', '--basis', R.basisOf(d2.rd, key)]);
  sc = R.startCheck(RUNS, key, { key }, 'own', ctx(key));
  ok('R8: next done -> the start is refused: the task is over by a decision', x.status === 0 && !!sc.why && /over/.test(sc.why), `${x.stderr} ${JSON.stringify(sc)}`);
  clean(key);
}

// ---- R10: the list
{
  const key = 'r10';
  const { id, rd } = mkRun(key, [PROG1(key)]);
  resolve(rd, key, ['--as', 'retry', '--step', '1', '--note', 'line one\nline "two"', '--basis', R.basisOf(rd, key)]);
  const x = cli(['resolve', '--list', '--task', key, '--config', CFGF]);
  const lines = x.stdout.split('\n').filter(Boolean);
  ok('R10: resolve --list gives one line per decision: run, task, step, label, as, next, the note in one line', x.status === 0 && lines.length === 1 && lines[0].includes(id) && lines[0].includes(`prog:${key}#1`) && lines[0].includes('retry') && lines[0].includes('line one') && lines[0].includes('two'), x.stdout + x.stderr);
  const st = status(rd);
  ok('R10: status shows the decisions of the task', st.tasks[key] && Array.isArray(st.tasks[key].resolved) && st.tasks[key].resolved.length === 1, JSON.stringify(st.tasks && st.tasks[key]));
  clean(key);
}

// ---- Q1, Q2: the commits journal of the adapter
{
  const SD = path.join(W, 'commit-state'), TD = path.join(SD, 'q1');
  fs.mkdirSync(TD, { recursive: true });
  const J = path.join(TD, 'commits.jsonl');
  const line = (n, e) => JSON.stringify(Object.assign({ v: 1, n, ts: 't', call: 'c' }, e)) + '\n';
  const write = (sha) => fs.writeFileSync(J, line(1, { ev: 'intent', id: 'r1', hash: 'h1', paths: ['a.js'], parent: H, tree: 't', ref: 'refs/heads/main', entries: [] })
    + line(2, { ev: 'intent-commit', id: 'r1', sha, old: H }) + line(3, { ev: 'undetermined', id: 'r1', sha, old: H, tip: 'x' }));
  write(B);
  let x = cli(['status', '--commits', SD, '--task', 'q1']);
  let s = JSON.parse(x.stdout || '{}');
  ok('Q2: status --commits prints the basis and the undetermined ids', /^3:[0-9a-f]{64}$/.test(s.commitsBasis || '') && (s.undetermined || []).includes('r1'), x.stdout + x.stderr);
  const qb = s.commitsBasis;
  const rc = (as, basis, extra) => cli(['resolve', '--commits', SD, '--task', 'q1', '--request', 'r1', '--wt', REPO, '--as', as, '--note', 'checked by hand'].concat(basis ? ['--basis', basis] : [], extra || []));
  x = rc('committed');
  ok('Q2: resolve --commits without --basis -> refused with the current basis', x.status !== 0 && x.stderr.includes(qb), x.stderr);
  x = rc('refused', qb);
  ok('Q1: refused while the sha is an ancestor of the branch -> refused', x.status !== 0, x.stderr);
  fs.writeFileSync(path.join(TD, 'journal.lock'), JSON.stringify({ pid: process.pid, token: 't', call: 'c' }));
  x = rc('committed', qb);
  ok('Q1: a live adapter holds the journal -> refused', x.status !== 0 && /adapter/.test(x.stderr), x.stderr);
  fs.rmSync(path.join(TD, 'journal.lock'));
  x = rc('committed', qb);
  const st = R.commitsState(J);
  ok('Q1: committed (an ancestor) -> resolved and result lines, nothing undetermined after', x.status === 0 && st.undetermined.length === 0 && st.ids.r1 && st.ids.r1.result && st.ids.r1.result.status === 'committed' && st.ids.r1.result.sha === B, `${x.stderr} ${JSON.stringify(st)}`);
  ok('Q1: the journal lock is released', !fs.existsSync(path.join(TD, 'journal.lock')));
  x = rc('committed', R.commitsBasis(J));
  ok('Q1: a second resolve of the id -> refused (not undetermined)', x.status !== 0, x.stderr);
  write('f'.repeat(40));
  x = rc('committed', R.commitsBasis(J));
  ok('Q1: committed for a sha that is no ancestor -> refused', x.status !== 0, x.stderr);
  const b0 = R.commitsBasis(J);
  fs.writeFileSync(J, fs.readFileSync(J, 'utf8').slice(0, -1).replace('"tip":"x"', '"tip":"y"') + '\n');
  ok('Q2: the basis covers the bytes, not only the count of lines', R.commitsBasis(J) !== b0 && R.commitsBasis(J).split(':')[0] === b0.split(':')[0]);
  x = rc('refused', b0);
  ok('Q1: a stale --basis -> refused', x.status !== 0, x.stderr);
  fs.appendFileSync(J, '{"torn');
  x = rc('refused', R.commitsBasis(J));
  ok('Q1: a torn tail -> refused', x.status !== 0 && /torn|damage/.test(x.stderr), x.stderr);
  fs.writeFileSync(J, fs.readFileSync(J, 'utf8').replace(/\{"torn$/, ''));
  x = rc('refused', R.commitsBasis(J));
  ok('Q1: refused for a sha that is no ancestor -> written', x.status === 0 && R.commitsState(J).ids.r1.result.status === 'refused', x.stderr);
  // killed between the two lines: resolved without result reads undetermined again (the intent has no result)
  write(B);
  fs.appendFileSync(J, line(4, { ev: 'resolved', id: 'r1', as: 'committed', note: 'n' }));
  ok('Q1: resolved without result -> the id is open again (the safe side)', R.commitsState(J).open.includes('r1'));
  x = cli(['status', '--commits', path.join(W, 'none'), '--task', 'q1']);
  ok('Q2: no journal -> basis 0:-', (JSON.parse(x.stdout || '{}').commitsBasis) === '0:-', x.stdout + x.stderr);
}

for (const c of procs) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
done();
