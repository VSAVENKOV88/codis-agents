#!/usr/bin/env node
'use strict';
// The coordinator's way out of a refusal of the conductor (scripts/chain-run.js): `resolve` writes a decision about a
// step a dead conductor left open or whose verdict the chain did not take, and the next start follows it.
//
// A decision is one JSON file per step, <sharedDir>/runs/<runId>/resolved/<key>/<n>.json (<n>: the step number of the
// journal), or abort.json for the task in that run as a whole. Fields: v, runId, key, n, stepId, label, stepKind, effect,
// as (ran|retry|abort), verdict, basis, note, next ({resumeAt, head, since, counts, noAnalystFirst?}, "done", or null:
// no constraint), facts (liveness of the conductor and of the executor, the HEAD of the worktree, the commits since the
// intent, the time, the pid of resolve).
// - It exists when a regular file stands at that name (opened with no link followed), parses, has this v, runId, key and
//   n; anything else at the name is no decision and the refusal stays. The link count is not checked: a resolve killed
//   between its link and the removal of its temporary name leaves two names of one written file.
// - It is written only by resolve, under the lock of the task (the lock names the target run and by: "resolve", so a
//   resolve killed with the lock leaves a dead lock on an existing run folder), while the conductor of the run and the
//   executor of the step are not alive, with a basis equal to the current one: <name>.tmp is created new, written and
//   fsynced, then hard-linked to the name (an existing name refuses: one decision per step, a second one is a refusal)
//   and removed. A resolve of the task first removes leftover *.json.tmp of the task's folder. Nothing in the plugin
//   changes or removes a decision.
// - The basis "<seq>:<sha256>" binds a decision to the state of the journal it was taken on: seq is the last whole event
//   of the fold (0 on damage or with no journal), sha256 covers tasks/<key>.json, run.json and every segment by number
//   (name, NUL, length, NUL, bytes; a missing file "-", an unreadable one "!<code>"). The snapshot run-state.json is
//   derived and left out. status and the refusal of a start print it; resolve requires it and refuses another one; the
//   reconciliation closes a reason only by a decision whose basis is the current one.
// - next comes from the table of continuations (nextOf), after two filters in this order: the context of the step by
//   the mode of its run and its label (only the main path of a full run, and the programmer or the selection of a light
//   run, continue in the middle; elsewhere only retry or abort), then the threshold of the analyst (the same predicate as
//   testerRed, reviewLoop, light and ride of workflows/role-chain.js: at the threshold resolve refuses and names the
//   route). The verdict of a step is read from its whole result line in the segments (recordedOf), never from the fold,
//   which cuts a value at 400 characters.
// The start (startCheck, called by the conductor under the lock after the reconciliation passed): when the newest run of
// the task has decisions, the task must carry their next - resumeAt, head, prior equal to next.counts - or, after abort,
// priorReason and no resumeAt; a next "done" refuses. Without decisions prior must equal the counts of the newest
// journal. A prior that differs passes only with priorReason, which is kept with both sets. After a decision ran or
// retry the worktree has no tracked change and the head of next is an ancestor of HEAD; after abort neither is checked.
//
// The commits journal of the adapter (scripts/commit-service.js, <commit.stateDir>/<task>/commits.jsonl): an
// undetermined request is closed by two lines under journal.lock, {ev: resolved} and {ev: result, resolved: true};
// committed only when the sha of the intent is an ancestor of its branch, refused only when not. Its basis is
// "<whole lines>:<sha256 of the file>".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const CJ = require('./chain-journal.js');

// chain-run.js requires this module, so its functions are taken at call time.
const CR = () => require('./chain-run.js');
const V = 1;
const C = fs.constants;
const NOFOLLOW = process.platform === 'darwin' ? 0x20000000 : C.O_NOFOLLOW;
const READ = C.O_RDONLY | C.O_NONBLOCK | NOFOLLOW;
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';

// {bytes} | {none} | {error: code}: a regular file read with no link followed and without blocking.
function readSafe(file) {
  let fd;
  try { fd = fs.openSync(file, READ); } catch (e) { return e.code === 'ENOENT' ? { none: true } : { error: e.code || e.message }; }
  try { return fs.fstatSync(fd).isFile() ? { bytes: fs.readFileSync(fd) } : { error: 'ENOTREG' }; } catch (e) { return { error: e.code || e.message }; } finally { fs.closeSync(fd); }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, C.O_RDONLY | C.O_DIRECTORY | NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const segNames = (dir) => { try { return fs.readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort((a, b) => +/\d+/.exec(a)[0] - +/\d+/.exec(b)[0]); } catch { return []; } };
const git = (wt, args) => spawnSync('git', ['-C', wt].concat(args), { encoding: 'utf8', timeout: 10000 });
const isAncestor = (wt, a, b) => typeof wt === 'string' && git(wt, ['merge-base', '--is-ancestor', a, b]).status === 0;
const headOf = (wt) => { const p = typeof wt === 'string' ? git(wt, ['rev-parse', '--verify', '-q', 'HEAD']) : null; return p && p.status === 0 ? p.stdout.trim() : null; };

// ---- the basis
function basisOf(runDir, key) {
  const jr = CJ.readJournal(runDir, key);
  const seq = jr.state ? jr.seq : 0;
  const h = crypto.createHash('sha256');
  const jd = path.join('journal', key);
  const rels = [path.join('tasks', `${key}.json`), 'run.json'].concat(segNames(path.join(runDir, jd)).map((s) => path.join(jd, s)));
  for (const rel of rels) {
    const r = readSafe(path.join(runDir, rel));
    h.update(`${rel}\0`);
    if (r.bytes) { h.update(`${r.bytes.length}\0`); h.update(r.bytes); } else h.update(r.none ? '-' : `!${r.error}`);
    h.update('\0');
  }
  return `${seq}:${h.digest('hex')}`;
}

// ---- the lines of one step, from the segments as they are (a line that does not parse is skipped): {intent, launch, result}
function stepLines(runDir, key, n) {
  const out = {};
  const dir = path.join(runDir, 'journal', key);
  let stepId = null;
  for (const s of segNames(dir)) {
    const r = readSafe(path.join(dir, s));
    if (!r.bytes) continue;
    for (const l of r.bytes.toString('utf8').split('\n')) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (!isPlain(e)) continue;
      if (e.type === 'intent' && e.n === n) { out.intent = e; stepId = e.stepId; } else if (stepId && e.stepId === stepId && (e.type === 'launch' || e.type === 'result')) out[e.type] = e;
    }
  }
  return out;
}

// ---- labels: the grammar of workflows/role-chain.js
// prog:<k>#<tag>, test:<k>#<tag>, review|sec:<k>#<tag>, run:<k>:select-<tag>, run:<k>:train-<n>; pre, analyst, usecases,
// env:<k>; the service steps post, diff, left, sha, merge. A check repeated by checkTwice ends with #retry.
// Tags: buildAndTest rounds <1..n> with the prefix A (after the analyst of a rejection or a red train) or T (after the
// analyst of a red tester round); m - the repeat after a pass of the mechanism; f - the fix round of a red selection;
// r, after-review, the second review - the round after a rejection; t<n>, t<n>-<k> - the rounds after a train.
function labelInfo(label) {
  const base = String(label || '').replace(/#retry$/, '');
  let m = /^(prog|test|review|sec):[^:#]+#(.+)$/.exec(base);
  if (m) return { role: m[1], tag: m[2] };
  m = /^run:[^:#]+:(select|train)-(.+)$/.exec(base);
  if (m) return { role: m[1], tag: m[2] };
  if (/^(pre|analyst|usecases|env):[^:#]+$/.test(base)) return { role: base.split(':')[0], tag: '' };
  if (/^(post|diff|left|sha|merge):/.test(base)) return { role: base.split(':')[0], service: true };
  return { role: null };
}
const MAIN = { prog: /^[AT]?\d+[mf]*$/, test: /^[AT]?\d+$/, review: /^[AT]?1$/, sec: /^[AT]?1$/, select: /^[AT]?\d+[mf]*$/, train: /^\d+$/ };
// 'main' | 'after-review' | 'after-train' | 'unknown'
function contextOf(info) {
  if (['pre', 'analyst', 'usecases', 'env'].includes(info.role)) return 'main';
  if (!info.role || info.service) return 'unknown';
  if (MAIN[info.role] && MAIN[info.role].test(info.tag)) return 'main';
  if (/^t\d+(-\d+)?[mf]*$/.test(info.tag)) return 'after-train';
  if (/^[AT]?(r[mf]*|after-review|2)$/.test(info.tag)) return 'after-review';
  return 'unknown';
}

// ---- the recorded verdict of a step (its whole result line)
const TRAIN_RC = { 0: 'green', 10: 'green-unmerged', 11: 'red', 12: 'seam', 13: 'conflict', 14: 'arc-red', 15: 'coordinator' };
const SELECT_ENV = new Set([124, 77, 78, 72, 73, 65, 69]); // ENV_RC of role-chain.js
const VERDICTS = { test: ['green', 'red', 'environment'], review: ['done', 'rejected'], sec: ['done', 'rejected'], select: ['green', 'red'],
  train: ['green', 'green-unmerged', 'red', 'seam', 'conflict', 'arc-red', 'coordinator', 'environment'] };
// {has, verdict?, head?, docsOnly?}: has false when the step has no result line or its value carries no verdict.
function recordedOf(runDir, key, n) {
  const l = stepLines(runDir, key, n);
  const info = labelInfo(l.intent && l.intent.label);
  const v = l.result && l.result.value;
  if (!isPlain(v) || !VERDICTS[info.role]) return { has: false };
  if (info.role === 'select' || info.role === 'train') {
    if (typeof v.rc !== 'number') return { has: false };
    const verdict = info.role === 'train' ? TRAIN_RC[v.rc] || 'environment' : v.rc === 0 ? 'green' : SELECT_ENV.has(v.rc) ? 'environment' : 'red';
    return { has: true, verdict };
  }
  return typeof v.verdict === 'string' ? { has: true, verdict: v.verdict, head: typeof v.head === 'string' ? v.head : undefined, docsOnly: v.docsOnly } : { has: false };
}

// ---- the threshold of the analyst: null, or the refusal with the route the chain would take
function threshold(role, verdict, Cn, docsOnly, light) {
  const c = Object.assign({ testerReds: 0, trainReds: 0, rejections: 0 }, Cn || {});
  const say = (route, counts) => `at the threshold of the analyst: the chain, given the verdict ${verdict} with the counts ${JSON.stringify(Cn || {})}, would ${route}; the counts it would set: ${JSON.stringify(counts)}. resolve writes no continuation here: write abort with a note of the verdict (resolve --as abort), then relaunch the task ${route.includes('analyst') ? 'with analystFirst' : 'as the coordinator decides'}, with priorReason and prior ${JSON.stringify(counts)}`;
  if (role === 'test' && verdict === 'red') {
    const counts = Object.assign({}, c, { testerReds: c.testerReds + 1 });
    if (c.analyst === 'tester-red') return say('stop for the coordinator (tester red after the analyst)', counts);
    if (!c.analyst && counts.testerReds >= 2) return say('send the task to the analyst (the second red tester round)', Object.assign(counts, { analyst: 'tester-red', rejections: 0 }));
  }
  if ((role === 'review' || role === 'sec') && verdict === 'rejected' && c.rejections + 1 >= 2) {
    const counts = Object.assign({}, c, { rejections: c.rejections + 1 });
    if (c.analyst || light || docsOnly === true) return say('stop for the coordinator (the second review rejection)', counts);
    if (docsOnly !== false) return say(`send the task to the analyst if the rejection is for code, or stop for the coordinator if it is for docs only (the recorded result does not say; read review.md)`, Object.assign({}, counts, { analyst: 'rejection', rejections: 0 }));
    return say('send the task to the analyst (the second review rejection for code)', Object.assign(counts, { analyst: 'rejection', rejections: 0 }));
  }
  if (role === 'train' && verdict === 'red') {
    const counts = Object.assign({}, c, { trainReds: c.trainReds + 1 });
    if (c.analyst === 'train-red') return say('stop for the coordinator (train red after the analyst)', counts);
    if (!c.analyst && counts.trainReds >= 2) return say('send the task to the analyst (the second red train)', Object.assign(counts, { analyst: 'train-red', rejections: 0 }));
  }
  return null;
}

// ---- the table of continuations. o: {step: {label, gitHead, counts}, as, verdict, head, form: {light, oneRun}, wt,
// recorded}. {next} | {error}.
function nextOf(o) {
  const s = o.step, Cn = s.counts || {}, H = s.gitHead || null;
  const info = labelInfo(s.label);
  const role = info.role;
  const err = (e) => ({ error: e });
  const begin = (counts) => ({ next: { resumeAt: null, head: null, since: null, counts: counts || Cn } });
  const at = (resumeAt, head, since) => ({ next: { resumeAt, head, since: since || null, counts: Cn } });
  const plus = (k) => Object.assign({}, Cn, { [k]: (Cn[k] || 0) + 1 });
  const vset = VERDICTS[role];
  if (o.as === 'retry' && (o.verdict !== undefined || o.head !== undefined)) return err('--verdict and --head go with ran only');
  if (o.as === 'ran' && vset) {
    if (o.verdict === undefined) return err(`ran on a ${role} step needs --verdict, one of ${vset.join(', ')} (the outcome the coordinator read, e.g. from the log or the report)`);
    if (!vset.includes(o.verdict)) return err(`--verdict ${o.verdict} is not a verdict of a ${role} step: ${vset.join(', ')}`);
    if (o.recorded && o.recorded.has && o.recorded.verdict !== o.verdict) return err(`the journal records the verdict ${o.recorded.verdict} of this step: --verdict ${o.verdict} contradicts it`);
  } else if (o.verdict !== undefined) return err(`a ${role || 'service'} step carries no verdict: no --verdict`);
  const needHead = o.as === 'ran' && (role === 'prog' || (role === 'test' && o.verdict === 'green'));
  if (o.head !== undefined && !needHead) return err('--head goes only with ran on a programmer step or a green tester step');
  const headOk = (h, from) => {
    if (typeof h !== 'string' || !FULL_SHA.test(h)) return `--head must be a full sha, got ${JSON.stringify(h)}`;
    if (from && (h === from || !isAncestor(o.wt, from, h))) return `--head ${h} is not a descendant of the HEAD of the step's intent ${from}`;
    if (!isAncestor(o.wt, h, 'HEAD')) return `--head ${h} is not an ancestor of the HEAD of the worktree ${o.wt}`;
    return null;
  };
  if (info.service) return { next: null };
  if (o.as === 'retry' && o.form.light) return begin();
  if (o.form.light) {
    if (role === 'prog' && MAIN.prog.test(info.tag)) { const e = headOk(o.head, H); return e ? err(e) : at('review', o.head); }
    if (role === 'select' && MAIN.select.test(info.tag) && o.verdict === 'green') return at('review', H);
    return err(`only retry or abort in this round: step ${s.label} of a light run (only the programmer, or a green selection, continues to the review)`);
  }
  const cx = contextOf(info);
  if (cx !== 'main') return o.as === 'retry' ? begin() : err(`only retry or abort in this round: step ${s.label} is ${cx === 'unknown' ? 'of no known round of the chain' : `in the round ${cx}`}, where the chain has no entry in the middle`);
  if (o.as === 'retry') {
    if (role === 'test' || role === 'select') return at('tester', H);
    if (role === 'review' || role === 'sec') return at('review', H);
    if (role === 'train') return at('train', H, H);
    return begin();
  }
  if (role === 'pre' || role === 'env') return begin();
  if (role === 'analyst' || role === 'usecases') return { next: Object.assign(begin().next, { noAnalystFirst: true }) };
  const t = threshold(role, o.verdict, Cn, o.recorded && o.recorded.docsOnly, false);
  if (t) return err(t);
  if (role === 'prog') { const e = headOk(o.head, H); return e ? err(e) : at('tester', o.head); }
  if (role === 'test') {
    if (o.verdict === 'red') return begin(plus('testerReds'));
    if (o.verdict === 'environment') return at('tester', H);
    const h = o.head !== undefined ? o.head : o.recorded && o.recorded.head;
    if (o.recorded && o.recorded.head && o.head !== undefined && o.recorded.head !== o.head) return err(`the journal records the tester's head ${o.recorded.head}: --head ${o.head} contradicts it`);
    const e = headOk(h, null);
    return e ? err(`${e} (the tester's head: --head, or its result line)`) : at('review', h, H);
  }
  if (role === 'review' || role === 'sec') {
    if (o.verdict === 'rejected') return begin(plus('rejections'));
    return o.form.oneRun ? at('train', H, H) : { next: 'done' };
  }
  if (role === 'select') return o.verdict === 'green' ? at('tester', H) : begin();
  if (role === 'train') {
    if (o.verdict === 'green' || o.verdict === 'green-unmerged') return { next: 'done' };
    if (o.verdict === 'red') return begin(plus('trainReds'));
    if (o.verdict === 'seam' || o.verdict === 'conflict') return begin();
    return at('train', H, H);
  }
  return err(`only retry or abort: step ${s.label} is of no known kind`);
}

// ---- decisions
const keyDir = (runDir, key) => path.join(runDir, 'resolved', key);
// {list, abort, notes, bad?}: the valid decisions of a task in a run (the invariant in the header).
function decisionsOf(runDir, key) {
  const out = { list: [], abort: null, notes: [] };
  const dir = keyDir(runDir, key);
  for (const d of [path.dirname(dir), dir]) {
    let st;
    try { st = fs.lstatSync(d); } catch { return out; }
    if (!st.isDirectory()) { out.notes.push(`${d} is not a folder: no decision is read from it`); out.bad = `${d} is not a folder`; return out; }
  }
  const runId = path.basename(runDir);
  for (const name of fs.readdirSync(dir).sort()) {
    const m = /^(\d+|abort)\.json$/.exec(name);
    if (!m) continue;
    const r = readSafe(path.join(dir, name));
    let d = null;
    try { d = r.bytes ? JSON.parse(r.bytes.toString('utf8')) : null; } catch { /* below */ }
    const n = m[1] === 'abort' ? null : +m[1];
    const good = isPlain(d) && d.v === V && d.runId === runId && d.key === key && typeof d.basis === 'string' && (n === null ? d.as === 'abort' : d.n === n && d.as !== 'abort');
    if (!good) { out.notes.push(`${path.join(dir, name)} is no decision (${r.error || (d ? 'its fields do not name this run, task and step' : 'it does not parse')})`); continue; }
    d.file = path.join(dir, name);
    if (n === null) out.abort = d; else out.list.push(d);
  }
  out.list.sort((a, b) => a.n - b.n);
  return out;
}
// The folders resolved/ and resolved/<key>/, one level at a time, never through a link: {dir} | {error}.
function ensureDir(runDir, key) {
  for (const d of [path.join(runDir, 'resolved'), keyDir(runDir, key)]) {
    try { fs.mkdirSync(d, { mode: 0o755 }); } catch (e) { if (e.code !== 'EEXIST') return { error: `${d}: ${e.message}` }; }
    if (!fs.lstatSync(d).isDirectory()) return { error: `${d} is not a folder: resolve writes nothing into it` };
  }
  return { dir: keyDir(runDir, key) };
}
function writeDecision(dir, name, obj) {
  const file = path.join(dir, name);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.json\.tmp$/.test(f)) continue;
    const p = path.join(dir, f);
    if (fs.lstatSync(p).isDirectory()) return { error: `${p} is a folder in place of a temporary name: remove it by hand` };
    fs.unlinkSync(p);
  }
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o644);
  try { fs.writeSync(fd, JSON.stringify(obj, null, 1) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, file); } catch (e) {
    fs.unlinkSync(tmp);
    if (e.code === 'EEXIST') return { error: `a second decision: ${file} exists, one decision per step` };
    throw e;
  }
  fs.unlinkSync(tmp);
  fsyncDir(dir);
  return { file };
}

// The liveness of the executor of an open step: {state, text}.
function executorOf(step, runDir, key) {
  const cr = CR();
  const l = step.launch;
  if (l && (l.substitute || l.reused)) return { state: 'gone', text: l.substitute ? 'a substitute launcher' : `an ended run reused, rc ${l.rc}` };
  let live = null;
  if (l) live = cr.liveness(l);
  else if (step.effect === 'reuse' && typeof step.waitId === 'string') {
    const m = cr.read3(`${step.waitId}.json`);
    live = m.data ? cr.liveness({ pid: m.data.pid, lstart: m.data.lstart, pgid: m.data.pid }) : { state: 'unknown', why: `the meta of its wait step ${m.none ? 'is not there' : 'cannot be read'}` };
  } else return { state: 'gone', text: step.gated ? 'no launch: the gate never opened' : 'no launch recorded: pid unknown' };
  return { state: live.state, text: cr.liveText(live) };
}

// resolve on a run folder: {ok, file, decision} | {error}. o: {runDir, key, as, n, verdict, head, basis, note}.
function resolveRun(o) {
  const cr = CR();
  const fail = (e) => ({ error: e });
  if (!['ran', 'retry', 'abort'].includes(o.as)) return fail(`--as ran|retry|abort, got ${JSON.stringify(o.as)}`);
  if (!nonBlank(o.note)) return fail('--note <text> is required: what the coordinator checked (a commit, a log, a report)');
  if (o.as === 'abort' && (o.n !== undefined || o.verdict !== undefined || o.head !== undefined)) return fail('abort is a decision on the task in the run as a whole: no --step, --verdict or --head');
  if (o.as !== 'abort' && !Number.isInteger(o.n)) return fail(`${o.as} needs --step <n>, the number of the step in the journal (status names it)`);
  if (!nonBlank(o.key) || !CJ.KEY_RE.test(o.key)) return fail(`--task ${JSON.stringify(o.key)} names no task`);
  const runDir = o.runDir, key = o.key, runId = path.basename(runDir);
  if (!RUN_ID_RE.test(runId)) return fail(`${runDir} names no run`);
  let st;
  try { st = fs.lstatSync(runDir); } catch { return fail(`no run folder ${runDir}`); }
  if (!st.isDirectory()) return fail(`${runDir} is not a run folder`);
  if (cr.read3(path.join(runDir, 'tasks', `${key}.json`)).none) return fail(`task ${key} is not registered in run ${runId} (no tasks/${key}.json): nothing of it to decide there`);
  const me = { pid: process.pid, lstart: cr.lstartOf(process.pid), runId, by: 'resolve' };
  if (!me.lstart) return fail('resolve cannot read its own start time (ps -o lstart): the lock of the task cannot name it');
  const runsDir = path.dirname(runDir);
  const got = cr.acquireTask(runsDir, key, me, () => ({ reasons: [], notes: [] }));
  if (!got.ok) return fail(/^undetermined/.test(got.why) ? `${got.why}; resolve does not clear it: a technical cleanup by hand, after checking the processes` : got.why);
  try { return underLock(o, runDir, key, runId); } finally { try { cr.releaseLock(cr.lockFileOf(runsDir, key), me); } catch { /* the next start reads a dead lock */ } }
}
function underLock(o, runDir, key, runId) {
  const cr = CR();
  const fail = (e) => ({ error: e });
  const cur = basisOf(runDir, key);
  if (o.basis !== cur) return fail(`the basis ${o.basis === undefined ? '(none: --basis <seq:sha256> is required)' : o.basis} is not the current basis ${cur} of task ${key} in run ${runId}: decide on the state status prints now`);
  const run = cr.read3(path.join(runDir, 'run.json'));
  let cond = { state: 'unknown', text: `run.json cannot be read (${run.unreadable || 'not there'})` };
  if (run.data) { const l = cr.liveness({ pid: run.data.pid, lstart: run.data.lstart }); cond = { state: l.state, text: cr.liveText(l) }; }
  if (cond.state === 'alive') return fail(`the conductor of run ${runId} is alive (${cond.text}): wait for the end of the run, then decide on what it left`);
  if (cond.state === 'unknown' && (run.data || o.as !== 'abort')) return fail(`the liveness of the conductor of run ${runId} is not known (${cond.text})${run.data ? '' : ': only abort'}`);
  const dec = decisionsOf(runDir, key);
  if (dec.bad) return fail(dec.bad);
  if (dec.abort) return fail(`the task is aborted in run ${runId} by ${dec.abort.file}: no decision after it`);
  const req = cr.read3(path.join(runDir, 'request.json'));
  const args = req.data && req.data.args;
  const task = args && Array.isArray(args.tasks) ? args.tasks.find((t) => t && t.key === key) : null;
  const wt = task ? cr.taskTable({ config: args.config, tasks: [task] })[key].wt : null;
  const jr = CJ.readJournal(runDir, key);
  const facts = (step, exe) => {
    const now = headOf(wt);
    const since = step && step.gitHead && now && now !== step.gitHead ? (git(wt, ['log', '--format=%h %s', '-n', '20', `${step.gitHead}..${now}`]).stdout || '').trim().split('\n').filter(Boolean) : [];
    return { conductor: cond.text, executor: exe ? exe.text : null, gitHead: now, commitsSince: since, decidedAt: new Date().toISOString(), pid: process.pid };
  };
  const base = { v: V, runId, key, basis: cur, note: o.note.trim() };
  const ed = ensureDir(runDir, key);
  if (ed.error) return fail(ed.error);
  if (o.as === 'abort') {
    for (const s of jr.state ? Object.values(jr.state.open) : []) {
      const exe = executorOf(s, runDir, key);
      if (exe.state !== 'gone') return fail(`step ${s.n} ${s.label} is open and its executor is ${exe.text}: abort only after it ended`);
    }
    const d = Object.assign({}, base, { as: 'abort', next: null, facts: facts(null, null) });
    const w = writeDecision(ed.dir, 'abort.json', d);
    return w.error ? fail(w.error) : { ok: true, file: w.file, decision: d };
  }
  if (!jr.state) return fail(`the journal of task ${key} in run ${runId} ${jr.error ? `is damaged (${jr.error})` : 'is not there'}: only abort`);
  const n = o.n;
  const open = Object.values(jr.state.open).find((s) => s.n === n);
  const verdictReason = (jr.state.unaccounted || []).concat(jr.state.afterEnd || []).find((v) => v.n === n);
  const lines = stepLines(runDir, key, n);
  if (!lines.intent) return fail(`run ${runId} has no step ${n} of task ${key}`);
  const existing = dec.list.find((d) => d.n === n);
  if (existing) return fail(`a second decision: ${existing.file} exists, one decision per step`);
  let exe = null;
  if (open) {
    exe = executorOf(open, runDir, key);
    if (exe.state !== 'gone') return fail(`the executor of step ${n} ${open.label} is ${exe.text}: decide after it ended`);
    const v = cr.openStepVerdict(open, runDir, key, { runId, wt, dir: null });
    if (!v.block && !(CJ.VERDICT_EFFECTS.has(open.effect) && (open.launch || open.effect === 'reuse'))) return fail(`step ${n} ${open.label} does not block a start (${open.effect}): there is nothing to decide`);
  } else if (!verdictReason) return fail(`step ${n} ${lines.intent.label} does not block a start: it is closed and its verdict, if any, was taken by the chain`);
  const recorded = open ? { has: false } : recordedOf(runDir, key, n);
  const cfg = (args && args.config) || {};
  const form = { light: !!(task && task.mode === 'light'), oneRun: nonBlank(cfg.guardSubsetCommand) };
  const step = { label: lines.intent.label, gitHead: lines.intent.gitHead, counts: lines.intent.counts };
  const nx = nextOf({ step, as: o.as, verdict: o.verdict, head: o.head, form, wt, recorded });
  if (nx.error) return fail(nx.error);
  const d = Object.assign({}, base, { n, stepId: lines.intent.stepId, label: lines.intent.label, stepKind: lines.intent.stepKind, effect: lines.intent.effect,
    as: o.as, verdict: o.verdict === undefined ? null : o.verdict, next: nx.next, facts: facts(lines.intent, exe) });
  const w = writeDecision(ed.dir, `${n}.json`, d);
  return w.error ? fail(w.error) : { ok: true, file: w.file, decision: d };
}

// ---- the reconciliation: reasons a current decision closes. reasons: [{runId, runDir, why, kind, n?}]; kind live (a
// conductor alive or unknown) is never closed; a reason with n by a decision on that step, any reason of the run by abort.
function closeReasons(reasons, key, notes) {
  const byRun = new Map();
  const out = [];
  for (const r of reasons) {
    if (!r.runDir || r.kind === 'live') { out.push(r); continue; }
    let c = byRun.get(r.runDir);
    if (!c) { c = { dec: decisionsOf(r.runDir, key), basis: null }; byRun.set(r.runDir, c); }
    const d = c.dec.abort || (r.n !== undefined ? c.dec.list.find((x) => x.n === r.n) : null);
    if (!d) { out.push(r); continue; }
    if (c.basis === null) c.basis = basisOf(r.runDir, key);
    if (d.basis !== c.basis) { out.push(Object.assign({}, r, { why: `${r.why}; the decision ${d.file} was taken on another state of the journal (basis ${d.basis}, now ${c.basis}): resolve on the current state` })); continue; }
    notes.push(`run ${r.runId}: closed by the decision ${d.file} (${d.as}${d.verdict ? ` ${d.verdict}` : ''}): ${r.why.slice(0, 200)}`);
  }
  for (const c of byRun.values()) notes.push(...c.dec.notes);
  return out;
}

// ---- the start
const COUNT_KEYS = ['testerReds', 'trainReds', 'rejections', 'analyst', 'mechanism'];
// prior and counts in one form: zeros, empty and false left out.
const normCounts = (c) => (isPlain(c) ? Object.fromEntries(COUNT_KEYS.filter((k) => c[k] !== undefined && c[k] !== 0 && c[k] !== '' && c[k] !== false && c[k] !== null).map((k) => [k, c[k]])) : {});
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// {ok, resumeSince, priorNote} | {why}. t: the task of the start; ctx {wt}.
function startCheck(runsDir, key, t, ownRunId, ctx) {
  const cr = CR();
  let ids = [];
  try { ids = fs.readdirSync(runsDir).filter((n) => !n.startsWith('.') && n !== ownRunId).sort(); } catch { /* none */ }
  let rd = null;
  for (let i = ids.length - 1; i >= 0 && !rd; i--) { const d = path.join(runsDir, ids[i]); if (!cr.read3(path.join(d, 'tasks', `${key}.json`)).none) rd = d; }
  const reason = nonBlank(t.priorReason) ? t.priorReason.trim() : '';
  const given = normCounts(t.prior);
  const has = (k) => t[k] !== undefined;
  const dec = rd ? decisionsOf(rd, key) : { list: [], abort: null };
  const runId = rd ? path.basename(rd) : null;
  if (dec.abort) {
    if (has('resumeAt') || has('head')) return { why: `the task was aborted in run ${runId} (${dec.abort.file}): it starts from its beginning, no resumeAt or head` };
    if (!reason) return { why: `the task was aborted in run ${runId} (${dec.abort.file}): its counts are not proven, so the start needs priorReason (why the given prior ${JSON.stringify(given)} holds)` };
    return { ok: true, resumeSince: null, priorNote: `after the abort of run ${runId}: prior ${JSON.stringify(given)}, priorReason: ${reason}` };
  }
  let nexts = dec.list.filter((d) => d.next !== null && d.next !== undefined);
  // review || sec of one round fold as reviewChecked: any rejected makes the round rejected, one increment.
  const rv = nexts.filter((d) => ['review', 'sec'].includes(labelInfo(d.label).role));
  if (rv.length > 1 && rv.some((d) => d.verdict === 'rejected')) { const keep = rv.find((d) => d.verdict === 'rejected'); nexts = nexts.filter((d) => !rv.includes(d) || d === keep); }
  if (nexts.some((d) => d.next === 'done')) return { why: `the task is over by a decision of run ${runId} (${nexts.find((d) => d.next === 'done').file}): nothing is started; the coordinator records its result` };
  const shape = (n) => ({ resumeAt: n.resumeAt || null, head: n.head || null, since: n.since || null, counts: normCounts(n.counts), noAnalystFirst: !!n.noAnalystFirst });
  const distinct = nexts.filter((d, i) => nexts.findIndex((e) => sameJson(shape(e.next), shape(d.next))) === i);
  if (distinct.length > 1) return { why: `the decisions of run ${runId} give different continuations: ${distinct.map((d) => `${d.file} -> ${JSON.stringify(shape(d.next))}`).join('; ')}` };
  const nx = distinct.length ? shape(distinct[0].next) : null;
  if (nx) {
    if ((t.resumeAt || null) !== nx.resumeAt || (t.head || null) !== nx.head) return { why: `the decision ${distinct[0].file} continues the task with resumeAt ${nx.resumeAt || '(none: from its beginning)'}${nx.head ? ` and head ${nx.head}` : ''}; the task gives resumeAt ${t.resumeAt || '(none)'}${has('head') ? ` and head ${t.head}` : ''}` };
    if (nx.noAnalystFirst && (t.analystFirst === true || t.useCasesFirst === true)) return { why: `the decision ${distinct[0].file} records that the analyst ran: start without analystFirst and useCasesFirst` };
  } else if (has('resumeAt') || has('head')) return { why: `resumeAt and head come only from a decision of resolve, and the newest run of the task${runId ? ` (${runId})` : ''} has none that continues it` };
  if (dec.list.length) {
    const wt = ctx && ctx.wt;
    const st = typeof wt === 'string' ? git(wt, ['status', '--porcelain', '--untracked-files=no']) : null;
    if (!st || st.status !== 0) return { why: `the worktree ${wt} cannot be checked after the decisions of run ${runId}` };
    const changed = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
    if (changed.length) return { why: `the worktree ${wt} has tracked changes after the decisions of run ${runId} (a killed role left them?): ${changed.join(', ')} - commit or restore them, then start` };
    if (nx && nx.head && !isAncestor(wt, nx.head, 'HEAD')) return { why: `the head ${nx.head} of the decision is not an ancestor of the HEAD of ${wt}` };
  }
  let expected = nx ? nx.counts : null;
  if (!nx && rd) {
    const jr = CJ.readJournal(rd, key);
    if (jr.state) expected = normCounts(jr.state.ended ? jr.state.ended.counts : jr.state.counts);
  }
  let priorNote = null;
  if (expected && !sameJson(given, expected)) {
    if (!reason) return { why: `prior ${JSON.stringify(given)} differs from the counts of run ${runId} ${JSON.stringify(expected)}${nx ? ' (next of its decision)' : ' (its journal)'}: give prior equal to them, or priorReason when the difference is meant` };
    priorNote = `prior ${JSON.stringify(given)} differs from the counts of run ${runId} ${JSON.stringify(expected)}; priorReason: ${reason}`;
  }
  return { ok: true, resumeSince: nx ? nx.since : null, priorNote };
}

// ---- the list (resolve --list) and the lines status shows
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const decisionLine = (d) => `${d.runId}\t${d.key}\tstep ${d.n === undefined || d.n === null ? '-' : d.n}\t${d.label || (d.as === 'abort' ? 'abort' : '-')}\t${d.as}${d.verdict ? ` ${d.verdict}` : ''}\tnext ${JSON.stringify(d.next === undefined ? null : d.next)}\tnote ${oneLine(d.note)}`;
function listDecisions(runsDir, keyFilter) {
  const lines = [];
  let ids = [];
  try { ids = fs.readdirSync(runsDir).filter((n) => !n.startsWith('.')).sort(); } catch { return lines; }
  for (const id of ids) {
    const rdir = path.join(runsDir, id, 'resolved');
    let keys = [];
    try { if (fs.lstatSync(rdir).isDirectory()) keys = fs.readdirSync(rdir).sort(); } catch { continue; }
    for (const k of keys) {
      if (keyFilter && k !== keyFilter) continue;
      const dec = decisionsOf(path.join(runsDir, id), k);
      for (const d of dec.list.concat(dec.abort ? [dec.abort] : [])) lines.push(decisionLine(d));
    }
  }
  return lines;
}

// ---- the commits journal
const commitsFile = (dir, task) => path.join(dir, task, 'commits.jsonl');
function commitsBasis(file) {
  const r = readSafe(file);
  if (r.none) return '0:-';
  if (!r.bytes) return `0:!${r.error}`;
  let whole = 0;
  for (const b of r.bytes) if (b === 0x0a) whole++;
  return `${whole}:${crypto.createHash('sha256').update(r.bytes).digest('hex')}`;
}
// The reader of commit-service.js replayed: {ids: {<id>: {hash, intent, intentCommit, result, undetermined}}, undetermined:
// [id], open: [id] (an intent without a result: undetermined or recovered at the next open), lastN, torn, damage}.
function commitsState(file) {
  const out = { ids: {}, undetermined: [], open: [], lastN: 0, torn: false, damage: null };
  const r = readSafe(file);
  if (!r.bytes) return Object.assign(out, r.none ? {} : { damage: `the journal cannot be read (${r.error})` });
  const text = r.bytes.toString('utf8');
  const lines = text.split('\n');
  out.torn = lines.pop() !== '';
  for (const [i, l] of lines.entries()) {
    let e = null;
    try { e = JSON.parse(l); } catch { /* below */ }
    if (!isPlain(e) || e.v !== 1 || e.n !== i + 1 || typeof e.ev !== 'string') { out.damage = `the journal ${file} is damaged at line ${i + 1}`; return out; }
    out.lastN = e.n;
    if (!e.id) continue;
    const s = out.ids[e.id] = out.ids[e.id] || {};
    if (e.ev === 'intent') { s.hash = e.hash; s.intent = e; } else if (e.ev === 'intent-commit') s.intentCommit = e;
    else if (e.ev === 'result') { s.result = e; if (s.hash === undefined) s.hash = e.hash; } else if (e.ev === 'undetermined') s.undetermined = e;
    else if (e.ev === 'resolved') s.undetermined = null;
  }
  for (const [id, s] of Object.entries(out.ids)) { if (s.undetermined) out.undetermined.push(id); if (s.intent && !s.result) out.open.push(id); }
  return out;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// o: {dir, task, request, wt, as, basis, note}: {ok, lines} | {error}.
function resolveCommits(o) {
  const fail = (e) => ({ error: e });
  if (!['committed', 'refused'].includes(o.as)) return fail(`--as committed|refused, got ${JSON.stringify(o.as)}`);
  if (!nonBlank(o.note)) return fail('--note <text> is required');
  if (!nonBlank(o.task) || !CJ.KEY_RE.test(o.task) || !nonBlank(o.request)) return fail('--task <key> and --request <id> are required');
  if (!nonBlank(o.wt)) return fail('--wt <worktree> is required: the branch of the request is checked there');
  const file = commitsFile(o.dir, o.task);
  const check = () => {
    const cur = commitsBasis(file);
    if (o.basis !== cur) return `the basis ${o.basis === undefined ? '(none: --basis is required)' : o.basis} is not the current basis ${cur} of ${file}`;
    const st = commitsState(file);
    if (st.torn || st.damage) return `${st.damage || `a torn tail of ${file}`}: damage, resolve refuses (the adapter cuts a torn tail at its next open)`;
    return null;
  };
  const pre = check();
  if (pre) return fail(pre);
  const lockFile = path.join(o.dir, o.task, 'journal.lock');
  const token = crypto.randomBytes(8).toString('hex');
  let mine = false;
  for (let i = 0; i < 2 && !mine; i++) {
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, call: 'resolve' }) + '\n', { flag: 'wx', mode: 0o600 }); mine = true; } catch (e) {
      if (e.code !== 'EEXIST') return fail(`the journal lock ${lockFile}: ${e.code || e.message}`);
      let held = null;
      try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* dead */ }
      if (held && Number.isInteger(held.pid) && pidAlive(held.pid)) return fail(`another adapter (pid ${held.pid}) writes the journal of task ${o.task}: decide after it ended`);
      fs.rmSync(lockFile, { force: true });
    }
  }
  if (!mine) return fail(`the journal lock ${lockFile} could not be taken`);
  try {
    const again = check();
    if (again) return fail(again);
    const st = commitsState(file);
    const s = st.ids[o.request];
    if (!s || !st.undetermined.includes(o.request)) return fail(`request ${o.request} is not undetermined in ${file}: nothing to resolve`);
    const ic = s.intentCommit, ref = s.intent && s.intent.ref;
    if (!ic || !ref) return fail(`request ${o.request} has no commit intent with its branch in ${file}`);
    const anc = isAncestor(o.wt, ic.sha, ref);
    if (o.as === 'committed' && !anc) return fail(`committed needs the sha ${ic.sha} of the intent to be an ancestor of ${ref} in ${o.wt}; it is not`);
    if (o.as === 'refused' && anc) return fail(`refused needs the sha ${ic.sha} of the intent not to be an ancestor of ${ref}; it is one, the commit is on the branch`);
    const ts = new Date().toISOString();
    const lines = [{ v: 1, n: st.lastN + 1, ts, call: 'resolve', ev: 'resolved', id: o.request, as: o.as, note: o.note.trim(), basis: o.basis },
      Object.assign({ v: 1, n: st.lastN + 2, ts, call: 'resolve', ev: 'result', id: o.request, hash: s.hash, status: o.as, resolved: true },
        o.as === 'committed' ? { sha: ic.sha, paths: s.intent.paths } : { why: `resolved by the coordinator: ${o.note.trim()}` })];
    const fd = fs.openSync(file, 'a', 0o600);
    try { for (const l of lines) { fs.writeSync(fd, JSON.stringify(l) + '\n'); fs.fsyncSync(fd); } } finally { fs.closeSync(fd); }
    return { ok: true, lines };
  } finally {
    try { const h = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (h.token === token) fs.unlinkSync(lockFile); } catch { /* gone */ }
  }
}

// ---- the command line (chain-run.js resolve ..., chain-run.js status --commits ...)
function flags(argv, names) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(names, argv[i]) || argv[i + 1] === undefined) return { bad: `unknown or empty flag ${argv[i]}` };
    a[names[argv[i]]] = argv[++i];
  }
  return { a };
}
const USAGE = 'usage: chain-run.js resolve <run-id|run folder> --task <key> --as ran|retry|abort [--step <n>] [--verdict <v>] [--head <sha>] --basis <seq:sha256> --note <text> [--config <file>]\n'
  + '       chain-run.js resolve --list [--task <key>] [--config <file>]\n'
  + '       chain-run.js resolve --commits <commit.stateDir> --task <key> --request <id> --wt <worktree> --as committed|refused --basis <n:sha256> --note <text>\n'
  + '       chain-run.js status --commits <commit.stateDir> --task <key>';
function main(argv) {
  const usage = (m) => { process.stderr.write(`chain-run: ${m}\n${USAGE}\n`); process.exit(64); };
  const refused = (e) => { process.stderr.write(`chain-run: resolve refused: ${e}\n`); process.exit(3); };
  const cr = CR();
  if (argv[0] === '--list') {
    const { a, bad } = flags(argv.slice(1), { '--task': 'task', '--config': 'config' });
    if (bad) usage(bad);
    const lc = cr.loadConfig(a.config);
    if (lc.error) { process.stderr.write(`${lc.error}\n`); process.exit(65); }
    const lines = listDecisions(path.join(lc.config.sharedDir, 'runs'), a.task);
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : '');
    process.exit(0);
  }
  if (argv[0] === '--commits') {
    const { a, bad } = flags(argv, { '--commits': 'dir', '--task': 'task', '--request': 'request', '--wt': 'wt', '--as': 'as', '--basis': 'basis', '--note': 'note' });
    if (bad) usage(bad);
    const r = resolveCommits(a);
    if (r.error) refused(r.error.includes('the basis') ? r.error : r.error);
    process.stdout.write(JSON.stringify({ ok: true, lines: r.lines }) + '\n');
    process.exit(0);
  }
  const id = argv[0];
  if (!id || id.startsWith('--')) usage('resolve <run-id|run folder> ...');
  const { a, bad } = flags(argv.slice(1), { '--task': 'key', '--as': 'as', '--step': 'step', '--verdict': 'verdict', '--head': 'head', '--basis': 'basis', '--note': 'note', '--config': 'config' });
  if (bad) usage(bad);
  if (a.step !== undefined && !/^\d+$/.test(a.step)) usage(`--step <n>, got ${JSON.stringify(a.step)}`);
  const rd = cr.runDirOf(id, a.config);
  if (rd.error) refused(rd.error);
  let real = path.resolve(rd.dir);
  try { real = fs.realpathSync(real); } catch { /* resolveRun names it */ }
  const r = resolveRun({ runDir: real, key: a.key, as: a.as, n: a.step === undefined ? undefined : +a.step, verdict: a.verdict, head: a.head, basis: a.basis, note: a.note });
  if (r.error) refused(r.error);
  process.stdout.write(JSON.stringify({ ok: true, file: r.file, decision: r.decision }) + '\n');
  process.exit(0);
}
function statusCommits(argv) {
  const { a, bad } = flags(argv, { '--commits': 'dir', '--task': 'task' });
  if (bad || !a.dir || !nonBlank(a.task)) { process.stderr.write(`chain-run: ${bad || 'status --commits <dir> --task <key>'}\n${USAGE}\n`); process.exit(64); }
  const file = commitsFile(a.dir, a.task);
  const st = commitsState(file);
  process.stdout.write(JSON.stringify({ file, commitsBasis: commitsBasis(file), undetermined: st.undetermined, torn: st.torn, damage: st.damage }) + '\n');
  process.exit(0);
}

module.exports = { basisOf, stepLines, labelInfo, contextOf, recordedOf, threshold, nextOf, decisionsOf, writeDecision, resolveRun, closeReasons,
  startCheck, normCounts, listDecisions, decisionLine, commitsBasis, commitsState, resolveCommits, main, statusCommits };
