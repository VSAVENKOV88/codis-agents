#!/usr/bin/env node
'use strict';
// The train dispatcher (p-train, part C1). Branches whose review is accepted wait in one queue per project; a train is
// one full guard run of a temporary commit "head of the arc branch + every ready branch", and a green train moves the
// arc branch to exactly the tree that ran. Trains go one at a time ("a train leaves as soon as the previous one is
// back and a branch is ready"); a branch that arrives while a train is in transit rides the next one.
//
// Interface (shared with the chain, p-train-c3), all under <sharedDir>/train/:
//   queue/<ms>-<task>.json   {task, branch, head, base, dir, enqueuedAt} - written through a temporary file + rename;
//                            the order of the names is the order of arrival. base = the arc branch, dir = the task folder.
//   result/<task>-<head>.json {verdict, task, branch, head, base, train, sha, ref, arc, log, passengers, merged?,
//                            reason?, files?}; verdict green | green-unmerged | conflict (red, seam and arc-red come
//                            with the attribution, part C2). A result is written before its queue entry is removed.
//   lock/                    the dispatcher's lock: mkdir is atomic (macOS has no flock(1)); lock/owner.json names the
//                            holder {pid, child, train, wt, since}. A holder whose pid and child are both gone is dead:
//                            the next dispatcher breaks its lock under lock.break (a second mkdir lock naming its pid in
//                            lock.break/owner.json, the holder rechecked inside, so a fresh lock is never removed; a break
//                            lock is removed by others only when its pid is gone, or it has no pid and is older than 60 s)
//                            by renaming it to lock.dead-<pid>-<ms>; then, under its own lock, it removes the dead train's
//                            worktree and that directory, and departs - the passengers were never taken out of the queue.
//   halt                     {reason, train, log, at}: the queue stands until the coordinator runs `resume`. Written on
//                            the environment (the run's exit 69, 124, 77, 78, 72, 73, 64, 66 or a signal; the worktree
//                            could not be made), on a git error while building the train, and on a red train (its
//                            attribution is part C2). The passengers stay in the queue without a verdict.
//   trains/<id>.json, logs/<id>.txt   the record and the log of every train.
// There is no daemon: the dispatcher is whoever takes the lock - the waiting step of a chain (`await`) or a `run`; after
// its train it releases the lock and the next waiter takes it.
//
// A train (one call that holds the lock):
//   1. The queue in the order of arrival, without the entries that already have a result; the arc branch is that of the
//      first entry (base), the passengers are the entries of that base. The arc head is read now (it may have moved
//      since the entries were queued).
//   2. Each passenger is merged into the chain without a worktree and without writing any branch:
//      git merge-tree --write-tree (rc 0: the tree; rc 1: a conflict, --name-only names the files) and git commit-tree
//      with the parents "chain so far" and "the head of the queue" - the head the review accepted, even when the branch
//      has moved since (that difference goes into the log). A conflicting passenger leaves with the result conflict and
//      its files; the others ride. Nobody left -> no train. Any other git failure (no common ancestor, a missing object)
//      -> no train, the halt with "git: ...".
//   3. The train commit gets refs/runs/train/<id> (never a branch or a tag) and a temporary worktree
//      <worktreeRoot>/train-<id> detached at it, with the ignored data cloned (wt-setup.sh --detach, never a symlink);
//      guards-all.sh runs there as it is - on the remote runner when the project has one, else in a heavy slot here,
//      with the rerun of new reds, the known reds and the quarantine of any full run. The worktree is removed afterwards,
//      only the one this train made, by its path.
//   4. Green: every passenger gets green with the train's log (the header names the arc head and each passenger's head;
//      a copy goes into the task folder), and the arc branch moves to the train commit - only if its head has not moved
//      since the departure:
//        not checked out anywhere -> git update-ref refs/heads/<arc> <train> <old> (compare-and-swap);
//        checked out in a worktree -> git -C <that worktree> merge --ff-only <train>, and only when that worktree has no
//          tracked changes (a bare update-ref there leaves its index at the old tree: its next commit would undo the
//          train); a refusal of ff-only, or tracked changes -> green-unmerged with the reason, for the coordinator, who
//          merges refs/runs/train/<id>.
//      The arc head moved during the run (or the compare-and-swap lost) -> nobody gets a verdict: the tree that ran is
//      not the one that would be merged, so the passengers ride the next train on the new head.
//
// usage: train.js enqueue --task <t> --branch <b> --head <sha> --base <arc> [--dir <task folder>]
//          -> the entry (same task and head already queued: kept; another head of the task: replaced; a result for this
//             task and head already there: printed, nothing queued)
//        train.js run                         -> one dispatch; JSON {departed, train?, sha?, verdict?, passengers?, ...}
//        train.js await --task <t> --head <sha> [--poll <s>]
//          -> waits for the result of this entry, dispatching trains while it waits; prints the result JSON, or
//             {verdict: environment, halted: true, reason} while the queue is halted (the entry stays); exit 0;
//             no entry and no result -> exit 66
//        train.js status                      -> the halt, the lock and the queue
//        train.js resume                      -> the coordinator: removes the halt
// The project config is found as config.js finds it (CODIS_AGENTS_CONFIG first); no config -> exit 78.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const C = require('./config');

const H = __dirname;
const STALE_MS = 60000;
// Exit codes of guards-all.sh that are the environment, not the product (role-chain.js ENV_RC, guards-remote.js 69),
// plus its usage and missing-worktree codes, which here mean the dispatcher's own setup failed.
const ENV_RC = new Set([69, 124, 77, 78, 72, 73, 64, 66]);

const die = (rc, m) => { process.stderr.write(`train: ${m}\n`); process.exit(rc); };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const writeAtomic = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(t, f);
};
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const ageMs = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return 0; } };
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function project() {
  const file = C.find();
  if (!file) die(78, 'no project config (.claude/codis-agents.json) found');
  const r = C.load(file);
  if (!r.config || r.errors.length) die(78, `project config ${file}: ${r.errors.join('; ')}`);
  const c = r.config, D = path.join(c.sharedDir, 'train');
  return { c, D, Q: path.join(D, 'queue'), RES: path.join(D, 'result'), LOGS: path.join(D, 'logs'), TR: path.join(D, 'trains'),
    LOCK: path.join(D, 'lock'), HALT: path.join(D, 'halt'), env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: c.configPath }) };
}

const git = (P, cwd, args, opts = {}) => {
  const r = spawnSync('git', ['-C', cwd, ...args], Object.assign({ encoding: 'utf8', env: P.env, maxBuffer: 64 * 1024 * 1024 }, opts));
  return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || (r.error ? r.error.message : '') };
};
const rev = (P, ref) => { const r = git(P, P.c.repoDir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.rc === 0 ? r.out : ''; };

const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const branchOk = (b) => typeof b === 'string' && !b.startsWith('-') && spawnSync('git', ['check-ref-format', `refs/heads/${b}`]).status === 0;
const resultFile = (P, task, head) => path.join(P.RES, `${task}-${head}.json`);

function entries(P) {
  let names = [];
  try { names = fs.readdirSync(P.Q).filter((f) => f.endsWith('.json')).sort(); } catch { /* no queue yet */ }
  const list = [];
  for (const n of names) {
    const e = readJ(path.join(P.Q, n));
    if (e && TASK.test(e.task || '') && SHA.test(e.head || '') && e.branch && e.base) list.push(Object.assign(e, { file: path.join(P.Q, n) }));
  }
  return list;
}

// ---- the lock ----
const ownerFile = (P) => path.join(P.LOCK, 'owner.json');
function setOwner(P, extra) {
  const o = Object.assign(readJ(ownerFile(P)) || { pid: process.pid, host: os.hostname(), since: new Date().toISOString() }, extra);
  writeAtomic(ownerFile(P), o);
}
function lockTake(P) {
  fs.mkdirSync(P.D, { recursive: true });
  const brk = `${P.LOCK}.break`, brkOwner = path.join(brk, 'owner.json');
  for (let i = 0; i < 3; i++) {
    try { fs.mkdirSync(P.LOCK); setOwner(P, {}); return { ok: true }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const o = readJ(ownerFile(P));
    if (o && (alive(o.pid) || alive(o.child))) return { busy: o };
    if (!o && ageMs(P.LOCK) < STALE_MS) return { busy: { pid: null, note: 'a lock without its owner file yet' } };
    try { fs.mkdirSync(brk); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // a break lock is left behind only by a dead breaker: its pid is gone (or it never wrote one and is old)
      const bo = readJ(brkOwner);
      if (bo ? !alive(bo.pid) : ageMs(brk) > STALE_MS) { try { fs.rmSync(brk, { recursive: true, force: true }); } catch { /* gone */ } }
      return { busy: o || {} };
    }
    try {
      writeAtomic(brkOwner, { pid: process.pid, since: new Date().toISOString() });
      const o2 = readJ(ownerFile(P));
      const sameDead = o2 ? (o && o2.pid === o.pid && !alive(o2.pid) && !alive(o2.child)) : (!o && ageMs(P.LOCK) >= STALE_MS);
      if (sameDead) {
        // a rename, not the removal of the dead train's worktree: that worktree (a cloned corpus) is removed by reapDead
        // under the breaker's own lock, so the break lock is held for milliseconds and nobody can break again meanwhile
        fs.renameSync(P.LOCK, `${P.LOCK}.dead-${process.pid}-${Date.now()}`);
        process.stderr.write(`train: broke the lock of a dead dispatcher (pid ${o2 ? o2.pid : '?'}, train ${o2 && o2.train || '?'})\n`);
      }
    } finally {
      const bo = readJ(brkOwner);
      if (bo && bo.pid === process.pid) { try { fs.rmSync(brk, { recursive: true, force: true }); } catch { /* gone */ } }
    }
  }
  return { busy: readJ(ownerFile(P)) || {} };
}
// Under our own lock: the broken locks of dead dispatchers (lock.dead-*) - their train worktrees are removed, then the lock
// directory itself; a worktree that cannot be removed keeps its lock.dead-* for the next train to retry.
function reapDead(P) {
  let names = [];
  try { names = fs.readdirSync(P.D).filter((n) => n.startsWith(`${path.basename(P.LOCK)}.dead-`)); } catch { /* none */ }
  for (const n of names) {
    const dir = path.join(P.D, n), o = readJ(path.join(dir, 'owner.json'));
    const why = o && o.wt ? removeTrainWt(P, o.wt) : '';
    if (why && !why.startsWith('not a train worktree')) { process.stderr.write(`train: the dead train's worktree stays: ${why}\n`); continue; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function lockRelease(P) {
  const o = readJ(ownerFile(P));
  if (o && o.pid === process.pid) fs.rmSync(P.LOCK, { recursive: true, force: true });
}

// Removes a temporary train worktree: only a registered worktree of the repository, directly under worktreeRoot, named
// train-*. Returns '' or the reason it was not removed.
function removeTrainWt(P, wt) {
  const abs = path.resolve(wt);
  if (path.dirname(abs) !== path.resolve(P.c.worktreeRoot) || !path.basename(abs).startsWith('train-')) return `not a train worktree: ${abs}`;
  const list = git(P, P.c.repoDir, ['worktree', 'list', '--porcelain']).out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
  let real = abs; try { real = fs.realpathSync(abs); } catch { /* gone */ }
  if (!list.includes(abs) && !list.includes(real)) { git(P, P.c.repoDir, ['worktree', 'prune']); return fs.existsSync(abs) ? `not a registered worktree: ${abs}` : ''; }
  const r = git(P, P.c.repoDir, ['worktree', 'remove', '--force', abs]);
  git(P, P.c.repoDir, ['worktree', 'prune']);
  return r.rc === 0 ? '' : `git worktree remove ${abs}: ${r.err}`;
}

// ---- results ----
function halt(P, reason, extra = {}) {
  writeAtomic(P.HALT, Object.assign({ reason, at: new Date().toISOString() }, extra));
}
function finish(P, e, res) {
  writeAtomic(resultFile(P, e.task, e.head), Object.assign({ task: e.task, branch: e.branch, head: e.head, base: e.base }, res));
  fs.rmSync(e.file, { force: true });
}

// The worktree where the branch is checked out, or ''.
function checkedOut(P, branch) {
  const blocks = git(P, P.c.repoDir, ['worktree', 'list', '--porcelain']).out.split(/\n\n+/);
  for (const b of blocks) {
    const ls = b.split('\n');
    if (ls.includes(`branch refs/heads/${branch}`)) return (ls.find((l) => l.startsWith('worktree ')) || '').slice(9);
  }
  return '';
}

function trainId() {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}-${process.pid}`;
}

// The identity of the train's merge commits: the repository's own when it has one, else a neutral one.
function identity(P) {
  if (git(P, P.c.repoDir, ['var', 'GIT_COMMITTER_IDENT']).rc === 0) return P.env;
  return Object.assign({}, P.env, { GIT_AUTHOR_NAME: 'codis-agents train', GIT_AUTHOR_EMAIL: 'train@example.com', GIT_COMMITTER_NAME: 'codis-agents train', GIT_COMMITTER_EMAIL: 'train@example.com' });
}

const runGuards = (P, wt) => new Promise((res) => {
  const ch = spawn('zsh', [path.join(H, 'guards-all.sh'), wt], { cwd: P.c.repoDir, env: P.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let s = '';
  ch.stdout.on('data', (x) => { s += x; }); ch.stderr.on('data', (x) => { s += x; });
  try { setOwner(P, { child: ch.pid }); } catch { /* the lock is ours; a failed note only weakens the liveness check */ }
  ch.on('error', (e) => { s += `\n${e.message}\n`; });
  ch.on('close', (code) => res({ rc: code, out: s }));
});

async function departure(P) {
  const id = trainId();
  const all = entries(P);
  for (const e of all) if (fs.existsSync(resultFile(P, e.task, e.head))) fs.rmSync(e.file, { force: true });
  const waiting = all.filter((e) => !fs.existsSync(resultFile(P, e.task, e.head)));
  if (!waiting.length) return { departed: false, empty: true, note: 'the queue is empty: nothing leaves' };
  const base = waiting[0].base;
  const pass = waiting.filter((e) => e.base === base);
  const lines = [];
  const record = (o) => writeAtomic(path.join(P.TR, `${id}.json`), Object.assign({ id, base, at: new Date().toISOString() }, o));
  const gitError = (why) => {
    const reason = `git: ${why} - train ${id} not built, the passengers stay in the queue`;
    halt(P, reason, { train: id });
    record({ verdict: 'git-error', reason, passengers: pass.map((e) => e.task) });
    return { departed: false, halted: true, train: id, verdict: 'git-error', reason };
  };
  const arc = rev(P, `refs/heads/${base}`);
  if (!arc) return gitError(`the arc branch ${base} is not a branch of ${P.c.repoDir}`);
  lines.push(`train ${id}: ${pass.length} in the queue for arc ${base}`, `arc ${base} ${arc}`);
  const idEnv = identity(P);
  let cur = arc;
  const riders = [], excluded = [];
  for (const e of pass) {
    const bh = rev(P, `refs/heads/${e.branch}`);
    const note = !bh ? ' (no such branch now: the head of the queue rides)' : bh !== e.head ? ` (branch head ${bh} differs: the head of the queue rides, the one the review accepted)` : '';
    if (git(P, P.c.repoDir, ['cat-file', '-e', `${e.head}^{commit}`]).rc !== 0) return gitError(`the head ${e.head} of ${e.task} is not a commit of the repository`);
    const m = git(P, P.c.repoDir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', cur, e.head]);
    if (m.rc === 1) {
      const ls = m.out.split('\n');
      const files = [...new Set(ls.slice(1).filter(Boolean))];
      lines.push(`excluded ${e.task} ${e.branch} ${e.head}${note}: conflict in ${files.join(', ')}`);
      excluded.push({ e, files });
      continue;
    }
    if (m.rc !== 0) return gitError(`git merge-tree ${e.task} (${e.head}): exit ${m.rc}: ${m.err || m.out}`);
    const tree = m.out.split('\n')[0];
    const cm = git(P, P.c.repoDir, ['commit-tree', tree, '-p', cur, '-p', e.head, '-m', `train ${id}: ${e.task} (${e.branch})`], { env: idEnv });
    if (cm.rc !== 0 || !SHA.test(cm.out)) return gitError(`git commit-tree for ${e.task}: exit ${cm.rc}: ${cm.err}`);
    cur = cm.out;
    riders.push(e);
    lines.push(`passenger ${e.task} ${e.branch} ${e.head}${note}`);
  }
  const logFile = path.join(P.LOGS, `${id}.txt`);
  const writeLog = (extra) => writeAtomic(logFile, lines.join('\n') + '\n' + (extra || ''));
  for (const { e, files } of excluded) {
    writeLog();
    finish(P, e, { verdict: 'conflict', train: id, arc, files, log: logFile, reason: `merging ${e.branch} into the train conflicts in ${files.join(', ')}: merge the head of ${base} into the branch and resolve` });
  }
  if (!riders.length) {
    record({ verdict: 'empty', arc, excluded: excluded.map((x) => x.e.task), log: logFile });
    return { departed: false, empty: true, train: id, excluded: excluded.map((x) => x.e.task), note: 'every passenger was excluded: no train' };
  }
  const ref = `refs/runs/train/${id}`;
  const u = git(P, P.c.repoDir, ['update-ref', ref, cur]);
  if (u.rc !== 0) return gitError(`git update-ref ${ref}: ${u.err}`);
  lines.push(`train commit ${cur} (${ref})`);
  const base0 = { train: id, sha: cur, ref, arc, log: logFile, passengers: riders.map((e) => e.task) };

  // the temporary worktree, the run, the removal
  const name = `train-${id}`, wt = path.join(P.c.worktreeRoot, name);
  setOwner(P, { train: id, wt });
  const ws = spawnSync('zsh', [path.join(H, 'wt-setup.sh'), '--detach', name, cur], { cwd: P.c.repoDir, env: P.env, encoding: 'utf8' });
  let run = null;
  if (ws.status === 0) {
    lines.push(`worktree ${wt} (detached, ignored data cloned)`);
    run = await runGuards(P, wt);
  } else lines.push(`worktree ${wt}: wt-setup.sh exit ${ws.status}: ${(ws.stderr || ws.stdout || '').trim()}`);
  const rm = removeTrainWt(P, wt);
  lines.push(rm ? `worktree not removed: ${rm}` : `worktree ${wt} removed`);
  const guardsLog = path.join(P.c.sharedDir, `guards-${name}.txt`);
  const body = () => (run ? `\n==== guards-all.sh ${wt}: exit ${run.rc} ====\n${run.out}\n==== ${guardsLog} ====\n${read(guardsLog) || '(no log)\n'}` : '');

  if (!run || run.rc === null || ENV_RC.has(run.rc)) {
    const why = !run ? `the worktree could not be made (wt-setup.sh exit ${ws.status})` : `guards-all.sh exit ${run.rc === null ? 'by a signal' : run.rc}`;
    const reason = `environment: ${why} on train ${id} - not counted, the passengers stay in the queue; log ${logFile}`;
    lines.push(reason); writeLog(body());
    halt(P, reason, { train: id, log: logFile });
    record(Object.assign({ verdict: 'environment', reason }, base0));
    return Object.assign({ departed: true, verdict: 'environment', halted: true, reason }, base0);
  }
  if (run.rc !== 0) {
    const reason = `red train ${id} (guards-all.sh exit ${run.rc}): the attribution to the passengers is not in this version (p-train-c2); the passengers stay in the queue; log ${logFile}`;
    lines.push(reason); writeLog(body());
    halt(P, reason, { train: id, log: logFile });
    record(Object.assign({ verdict: 'red', reason }, base0));
    return Object.assign({ departed: true, verdict: 'red', halted: true, reason }, base0);
  }

  // green: move the arc branch only onto the tree that ran
  let verdict = 'green', reason = '', moved = '';
  const now = rev(P, `refs/heads/${base}`);
  if (now !== arc) moved = `the head of ${base} moved during the run (${arc} -> ${now || 'gone'})`;
  else {
    const w = checkedOut(P, base);
    if (!w) {
      const r = git(P, P.c.repoDir, ['update-ref', `refs/heads/${base}`, cur, arc]);
      if (r.rc !== 0) moved = `the compare-and-swap of ${base} failed (${r.err})`;
      else lines.push(`merged: ${base} ${arc} -> ${cur} (update-ref, compare-and-swap; ${base} is checked out nowhere)`);
    } else {
      const st = git(P, w, ['status', '--porcelain', '--untracked-files=no']);
      const wh = git(P, w, ['rev-parse', 'HEAD']).out;
      if (st.rc !== 0 || st.out) { verdict = 'green-unmerged'; reason = `the worktree ${w} of ${base} has tracked changes: not merged there; the coordinator merges ${ref}`; }
      else if (wh !== arc) moved = `the worktree ${w} of ${base} is at ${wh}, not at ${arc}`;
      else {
        const f = git(P, w, ['merge', '--ff-only', '-q', cur]);
        if (f.rc === 0) lines.push(`merged: ${base} ${arc} -> ${cur} (git -C ${w} merge --ff-only)`);
        else { verdict = 'green-unmerged'; reason = `git -C ${w} merge --ff-only ${cur} refused (exit ${f.rc}: ${f.err || f.out}); the coordinator merges ${ref}`; }
      }
    }
  }
  if (moved) {
    const note = `${moved}: the tree that ran is not the one that would be merged - no verdict, the passengers ride the next train`;
    lines.push(note); writeLog(body());
    record(Object.assign({ verdict: 'arc-moved', reason: note }, base0));
    return Object.assign({ departed: true, verdict: 'arc-moved', reason: note }, base0);
  }
  if (reason) lines.push(`green-unmerged: ${reason}`);
  writeLog(body());
  const text = read(logFile);
  for (const e of riders) {
    if (e.dir && fs.existsSync(e.dir)) { try { fs.writeFileSync(path.join(e.dir, `train-${id}.txt`), text); } catch { /* the shared log stays */ } }
    finish(P, e, Object.assign({ verdict }, base0, verdict === 'green' ? { merged: cur } : { reason }));
  }
  record(Object.assign({ verdict, reason: reason || undefined }, base0));
  return Object.assign({ departed: true, verdict, reason: reason || undefined }, base0);
}

async function dispatch(P) {
  const h = readJ(P.HALT);
  if (h) return { departed: false, halted: true, reason: h.reason };
  const lk = lockTake(P);
  if (!lk.ok) return { departed: false, busy: true, note: 'a train is in transit', holder: lk.busy };
  try {
    reapDead(P);
    const h2 = readJ(P.HALT);
    if (h2) return { departed: false, halted: true, reason: h2.reason };
    return await departure(P);
  } finally { lockRelease(P); }
}

function args(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith('--')) die(64, `unexpected argument ${list[i]}`);
    o[list[i].slice(2)] = list[i + 1]; i++;
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const USAGE = 'usage: train.js enqueue --task <t> --branch <b> --head <sha> --base <arc> [--dir <folder>] | run | await --task <t> --head <sha> [--poll <s>] | status | resume';
  if (!['enqueue', 'run', 'await', 'status', 'resume'].includes(cmd)) die(64, USAGE);
  const a = args(rest);
  const P = project();
  if (cmd === 'enqueue') {
    if (!TASK.test(a.task || '') || !SHA.test(a.head || '') || !branchOk(a.branch) || !branchOk(a.base)) die(64, `${USAGE}\n  (task: letters, digits . _ -; head: a full sha; branch and base: branch names)`);
    const done = readJ(resultFile(P, a.task, a.head));
    if (done) { out({ decided: true, result: done }); return 0; }
    for (const e of entries(P).filter((x) => x.task === a.task)) {
      if (e.head === a.head) { out({ queued: e.file, existing: true }); return 0; }
      fs.rmSync(e.file, { force: true });
    }
    const f = path.join(P.Q, `${String(Date.now()).padStart(13, '0')}-${a.task}.json`);
    writeAtomic(f, { task: a.task, branch: a.branch, head: a.head, base: a.base, dir: a.dir ? path.resolve(a.dir) : '', enqueuedAt: new Date().toISOString() });
    out({ queued: f });
    return 0;
  }
  if (cmd === 'run') { out(await dispatch(P)); return 0; }
  if (cmd === 'await') {
    if (!TASK.test(a.task || '') || !SHA.test(a.head || '')) die(64, USAGE);
    const poll = 1000 * (Number(a.poll || process.env.CODIS_TRAIN_POLL) || 10);
    for (;;) {
      const r = readJ(resultFile(P, a.task, a.head));
      if (r) { out(r); return 0; }
      const h = readJ(P.HALT);
      if (h) { out(Object.assign({ verdict: 'environment', halted: true, task: a.task, head: a.head }, h)); return 0; }
      if (!entries(P).some((e) => e.task === a.task && e.head === a.head)) {
        // finish() writes the result before it removes the entry: read the result again, it may have come in between
        const r2 = readJ(resultFile(P, a.task, a.head));
        if (r2) { out(r2); return 0; }
        die(66, `no queue entry and no result for ${a.task} ${a.head}`);
      }
      const d = await dispatch(P);
      if (!d.departed) await sleep(poll);
    }
  }
  if (cmd === 'status') {
    const h = readJ(P.HALT), o = readJ(ownerFile(P));
    console.log(h ? `halt: ${h.reason} (since ${h.at}); the coordinator lifts it with train.js resume` : 'halt: none');
    console.log(o ? `lock: train ${o.train || '-'} by pid ${o.pid} (${alive(o.pid) || alive(o.child) ? 'alive' : 'dead'}) since ${o.since}` : 'lock: free');
    const q = entries(P);
    console.log(`queue: ${q.length}`);
    for (const e of q) console.log(`  ${e.task} ${e.branch} ${e.head} -> ${e.base} (since ${e.enqueuedAt})`);
    return 0;
  }
  if (cmd === 'resume') {
    const h = readJ(P.HALT);
    fs.rmSync(P.HALT, { force: true });
    console.log(h ? `halt removed (it was: ${h.reason})` : 'no halt');
    return 0;
  }
  return 64;
}

main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`train: ${e && e.stack || e}\n`); process.exit(70); });
