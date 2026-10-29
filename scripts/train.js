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
//                            reason?, files?, guards?, attribution?, partner?, partnerBranch?, pair?}; verdict green |
//                            green-unmerged | conflict | red | seam (the attribution of a red train, below). A result is
//                            written before its queue entry is removed.
//   lock/                    the dispatcher's lock: mkdir is atomic (macOS has no flock(1)); lock/owner.json names the
//                            holder {pid, child, pgid, train, wt, since}. A holder whose pid, child and process group (any
//                            process of it, unless it is the waiter's own group) are all gone is dead:
//                            the next dispatcher breaks its lock under lock.break (a second mkdir lock naming its pid in
//                            lock.break/owner.json, the holder rechecked inside, so a fresh lock is never removed; a break
//                            lock is removed by others only when its pid is gone, or it has no pid and is older than 60 s)
//                            by renaming it to lock.dead-<pid>-<ms>; then, under its own lock, it removes the dead train's
//                            worktree, its attribution refs refs/runs/train/<id>-<label> and that directory, and departs -
//                            the passengers were never taken out of the queue.
//   halt                     {reason, train, log, at, verdict?, guards?, attribution?}: the queue stands until the
//                            coordinator runs `resume`. Written on the environment (the run's exit 69, 124, 77, 78, 72,
//                            73, 64, 66, or a signal: no code or 128+n; a red exit whose log has no tally; the worktree
//                            could not be made; an attribution run that could not run), on a git error while building
//                            the train, on arc-red (verdict arc-red: `await` prints it), and on a red train the
//                            attribution cannot decide (verdict coordinator: several red pairs, a guard now red now green,
//                            more than three passengers, one passenger green alone, no repeated red named). The passengers without a result stay in the queue.
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
//   5. Red: the attribution and the seam (redTrain below, p-train-c2).
//
// usage: train.js enqueue --task <t> --branch <b> --head <sha> --base <arc> [--dir <task folder>]
//          -> the entry (same task and head already queued: kept; another head of the task: replaced; a result for this
//             task and head already there: printed, nothing queued); refused before the queue (exit 65) when base is a
//             protected branch or not a branch of the repository; a queue that cannot be written -> exit 74
//        train.js ride (the same arguments)     -> the chain after the review (p-train-c3): enqueue + await, the exit code is
//             the verdict: 0 green, 10 green-unmerged, 11 red, 12 seam (after the partner's own result: the fix starts on
//             the arc head that holds it), 13 conflict, 14 arc-red, 15 coordinator, 75 the queue halted (environment)
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
const GR = require('./guards-result');

const H = __dirname;
const STALE_MS = 60000;
// Exit codes of guards-all.sh that are the environment, not the product (role-chain.js ENV_RC, guards-remote.js 69),
// plus its usage and missing-worktree codes, which here mean the dispatcher's own setup failed.
const ENV_RC = new Set([69, 124, 77, 78, 72, 73, 64, 66]);
// A run ended by a signal: node reports no code (rc null), and a shell that dies by signal n, or the slot trap of
// guards-all.sh (slots.zsh: INT/TERM/HUP -> exit 143), exits 128+n (POSIX: the status of a command killed by a signal
// is above 128). Either way the run was cut off before its tally: the environment, never a red train (D19).
const SIGNAL_NAME = Object.fromEntries(Object.entries(os.constants.signals).map(([k, v]) => [v, k]));
const bySignal = (rc) => rc === null || (Number.isInteger(rc) && !!SIGNAL_NAME[rc - 128]);

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
// The process group of a pid (ps -o pgid=; node has no getpgid), or 0.
const pgidOf = (pid) => { const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }); const n = Number((r.stdout || '').trim()); return Number.isInteger(n) && n > 1 ? n : 0; };
const OWN_PGID = pgidOf(process.pid);
// A group lives while any of its processes does (kill(-pgid, 0)). The guard run of a dispatcher is not detached, so it
// stays in the dispatcher's group: when the dispatcher and its zsh are killed, an orphaned guard worker still holds the
// lock (coordinator's decision for c3). A group that is our own is no evidence: a waiter started from the same shell job
// (a test, one terminal) shares it with the dead holder, and it would never let go.
const groupAlive = (g) => { if (!Number.isInteger(g) || g <= 1 || g === OWN_PGID) return false; try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const holderAlive = (o) => !!o && (alive(o.pid) || alive(o.child) || groupAlive(o.pgid));
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
  const o = Object.assign(readJ(ownerFile(P)) || Object.assign({ pid: process.pid, host: os.hostname(), since: new Date().toISOString() }, OWN_PGID ? { pgid: OWN_PGID } : {}), extra);
  writeAtomic(ownerFile(P), o);
}
function lockTake(P) {
  fs.mkdirSync(P.D, { recursive: true });
  const brk = `${P.LOCK}.break`, brkOwner = path.join(brk, 'owner.json');
  for (let i = 0; i < 3; i++) {
    try { fs.mkdirSync(P.LOCK); setOwner(P, {}); return { ok: true }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const o = readJ(ownerFile(P));
    if (holderAlive(o)) return { busy: o };
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
      const sameDead = o2 ? (o && o2.pid === o.pid && !holderAlive(o2)) : (!o && ageMs(P.LOCK) >= STALE_MS);
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
    // the attribution refs refs/runs/train/<id>-<label> the dead train left (its own refs/runs/train/<id> is the record
    // of the commit that ran and stays, as for every train)
    if (o && typeof o.train === 'string' && TASK.test(o.train)) {
      const refs = git(P, P.c.repoDir, ['for-each-ref', '--format=%(refname)', `refs/runs/train/${o.train}-*`]).out.split('\n').filter(Boolean);
      for (const ref of refs) git(P, P.c.repoDir, ['update-ref', '-d', ref]);
    }
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

const runGuards = (P, wt, extra = []) => new Promise((res) => {
  const ch = spawn('zsh', [path.join(H, 'guards-all.sh'), ...extra, wt], { cwd: P.c.repoDir, env: P.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  if (!run || bySignal(run.rc) || ENV_RC.has(run.rc)) {
    const why = !run ? `the worktree could not be made (wt-setup.sh exit ${ws.status})`
      : run.rc === null ? 'guards-all.sh exit by a signal'
        : bySignal(run.rc) ? `guards-all.sh exit ${run.rc} by a signal (${SIGNAL_NAME[run.rc - 128]}), cut off before its tally` : `guards-all.sh exit ${run.rc}`;
    const reason = `environment: ${why} on train ${id} - not counted, the passengers stay in the queue; log ${logFile}`;
    lines.push(reason); writeLog(body());
    halt(P, reason, { train: id, log: logFile });
    record(Object.assign({ verdict: 'environment', reason }, base0));
    return Object.assign({ departed: true, verdict: 'environment', halted: true, reason }, base0);
  }
  if (run.rc !== 0) return redTrain(P, { id, base, arc, riders, lines, logFile, rc: run.rc, text: read(guardsLog) || '', base0, record, writeLog: () => writeLog(body()) });

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

// ---- a red train: the attribution and the seam (p-train-c2, UC-8 and UC-9) ----
// The repeated new reds R of the train's log (the rerun's "new red, red again alone") run again, only for the
// attribution and never for a verdict of their own, in the selection mode of guards-all.sh (--guards: guardSubsetCommand
// with {onlyArgs} = R; the rerun of new reds, the known reds, the quarantine read only, the remote runner as for any
// selection), each in a temporary worktree train-<id>-<label> detached at a commit built like the train's:
//   1. the bare arc head. A guard of R red there -> arc-red: the arc itself is red, the passengers are not to blame;
//      the train does not count, they stay in the queue, the queue halts (verdict arc-red) until the coordinator.
//   2. "arc head + X" for every passenger X. A guard of R red there -> X gets red (the train's log, the attribution log
//      and the guards; copies in its task folder) and leaves; the others get no verdict and ride the next train by the
//      departure rule (the train came back, a train leaves with what is ready), with no halt.
//   3. Green on every X alone -> a seam: two passengers -> the earlier by arrival stays in the queue and rides the next
//      train, the later gets seam naming it (partner); three -> R on the three pairs, at most three runs: one red pair ->
//      that pair is the seam (its later one gets seam, its earlier one and the passenger outside the pair ride); no red
//      pair -> the seam of the three: the earliest rides, the other two get seam with it. More than three passengers,
//      several red pairs, a guard of R flaky on a passenger or a pair (now red, now green), or one passenger green alone
//      on the tree that was red in the train -> no automatic decision: the halt for the coordinator, nobody gets a verdict.
// An attribution run that could not run R (the environment codes or a signal, a log without its tally, no repeated red
// named for a red exit, the worktree or the commit not made) -> that passenger stays in the queue without a verdict and
// the queue halts with the reason ("environment: ..."); the others keep the verdicts of their own results.
// Before any of that, coordinator's decision for p-train-c2: the train's log without its tally (guardRerun.tallyPattern)
// is the environment, not a red train - the run was cut off before it ended.
async function redTrain(P, t) {
  const { id, base, arc, riders, lines, logFile, rc, base0, record } = t;
  const rr = P.c.guardRerun;
  const alog = path.join(P.LOGS, `train-${id}.attribution.txt`), al = [], given = [];
  const writeA = () => writeAtomic(alog, al.join('\n') + '\n');
  const copy = (e) => {
    if (!e.dir || !fs.existsSync(e.dir)) return;
    try { fs.writeFileSync(path.join(e.dir, `train-${id}.txt`), read(logFile) || ''); fs.writeFileSync(path.join(e.dir, path.basename(alog)), read(alog) || ''); } catch { /* the shared logs stay */ }
  };
  // the copies go into the task folders once the logs are complete (copyAll before every return)
  const copyAll = () => { for (const e of given) copy(e); };
  const stop = (verdict, reason, extra = {}) => {
    lines.push(reason); t.writeLog();
    if (al.length) { al.push(reason); writeA(); }
    copyAll();
    const x = Object.assign(al.length ? { attribution: alog } : {}, extra);
    halt(P, reason, Object.assign({ train: id, log: logFile }, verdict === 'arc-red' || verdict === 'coordinator' ? { verdict } : {}, x));
    record(Object.assign({ verdict, reason }, base0, x));
    return Object.assign({ departed: true, verdict, halted: true, reason }, base0, x);
  };
  const where = `the passengers stay in the queue; log ${logFile}`;
  if (rr && rr.tallyPattern && !GR.newReds(t.text, rr).tally) {
    return stop('environment', `environment: guards-all.sh exit ${rc} without the tally of its log (cut off before it) on train ${id} - not counted, ${where}`);
  }
  const R = GR.repeatedInLog(t.text);
  const why = !rr ? 'the project config has no guardRerun, so no repeated new red is named'
    : !R.length ? 'no repeated new red is named in its log (no "new red, red again alone")'
      : !P.c.guardSubsetCommand ? `the attribution of ${R.join(', ')} needs guardSubsetCommand (its selection mode)` : '';
  if (why) return stop('coordinator', `red train ${id} (guards-all.sh exit ${rc}): ${why} - not attributed, the coordinator decides; ${where}`);

  const names = path.join(P.TR, `${id}.guards.json`);
  writeAtomic(names, R);
  al.push(`attribution of train ${id}: the repeated new reds ${R.join(', ')}, each alone in the selection mode (guards-all.sh --guards)`, `arc ${base} ${arc}`);
  lines.push(`red train ${id}: the repeated new reds ${R.join(', ')}; attribution ${alog}`);
  const idEnv = identity(P);
  // one attribution run: the arc head plus `heads` in that order -> {state: ok | cannot, red, flaky, why}
  const attempt = async (label, ps) => {
    const desc = ps.length ? `arc + ${ps.map((e) => e.task).join(' + ')}` : 'the bare arc head';
    const cannot = (w) => { al.push(`==== ${desc}: could not run: ${w}`); writeA(); return { state: 'cannot', red: [], flaky: [], why: `${desc}: ${w}`, desc }; };
    let cur = arc;
    for (const e of ps) {
      const m = git(P, P.c.repoDir, ['merge-tree', '--write-tree', '--no-messages', cur, e.head]);
      if (m.rc !== 0) return cannot(`git merge-tree ${e.task} (${e.head}): exit ${m.rc}`);
      const cm = git(P, P.c.repoDir, ['commit-tree', m.out.split('\n')[0], '-p', cur, '-p', e.head, '-m', `train ${id} attribution: ${e.task}`], { env: idEnv });
      if (cm.rc !== 0 || !SHA.test(cm.out)) return cannot(`git commit-tree for ${e.task}: exit ${cm.rc}: ${cm.err}`);
      cur = cm.out;
    }
    const ref = `refs/runs/train/${id}-${label}`;
    if (ps.length && git(P, P.c.repoDir, ['update-ref', ref, cur]).rc !== 0) return cannot(`git update-ref ${ref}`);
    const name = `train-${id}-${label}`, wt = path.join(P.c.worktreeRoot, name);
    setOwner(P, { wt });
    const ws = spawnSync('zsh', [path.join(H, 'wt-setup.sh'), '--detach', name, cur], { cwd: P.c.repoDir, env: P.env, encoding: 'utf8' });
    const run = ws.status === 0 ? await runGuards(P, wt, ['--guards', names]) : null;
    const rm = removeTrainWt(P, wt);
    if (ps.length) git(P, P.c.repoDir, ['update-ref', '-d', ref]);
    if (!run) return cannot(`wt-setup.sh exit ${ws.status}: ${(ws.stderr || ws.stdout || '').trim()}`);
    const slog = read(path.join(P.c.sharedDir, `guards-${name}.select.txt`)) || '';
    al.push(`==== ${desc}: commit ${cur}: guards-all.sh --guards exit ${run.rc}${rm ? ` (worktree not removed: ${rm})` : ''}`, slog.trimEnd());
    writeA();
    if (bySignal(run.rc) || ENV_RC.has(run.rc)) return cannot(run.rc === null ? 'guards-all.sh exit by a signal' : `guards-all.sh exit ${run.rc}${bySignal(run.rc) ? ` by a signal (${SIGNAL_NAME[run.rc - 128]})` : ''}`);
    const flaky = GR.flakyInLog(slog).filter((n) => R.includes(n));
    if (run.rc === 0) return { state: 'ok', red: [], flaky, desc };
    if (rr.tallyPattern && !GR.newReds(slog, rr).tally) return cannot(`guards-all.sh exit ${run.rc} without the tally of its log`);
    const red = GR.repeatedInLog(slog).filter((n) => R.includes(n));
    if (!red.length) return cannot(`guards-all.sh exit ${run.rc}, but none of ${R.join(', ')} is named red again alone`);
    return { state: 'ok', red, flaky, desc };
  };
  const give = (e, res) => { al.push(`${e.task}: ${res.verdict}${res.partner ? ` with ${res.partner}` : ''} (${res.guards.join(', ')})`); writeA(); given.push(e); finish(P, e, Object.assign(res, base0, { attribution: alog })); };

  // 1. the bare arc head
  const A = await attempt('arc', []);
  if (A.state !== 'ok') return stop('environment', `environment: the attribution of train ${id} could not run on ${A.why} - not counted, ${where}; attribution ${alog}`);
  if (A.red.length) return stop('arc-red', `arc-red: ${A.red.join(', ')} red on the bare arc head ${base} ${arc} alone - train ${id} not counted, the passengers are not to blame and stay in the queue; the coordinator fixes ${base} and runs train.js resume; log ${logFile}; attribution ${alog}`, { guards: A.red });

  // 2. every passenger alone on the arc head
  const per = [];
  for (const [i, e] of riders.entries()) per.push({ e, a: await attempt(`p${i + 1}`, [e]) });
  const reds = per.filter((p) => p.a.state === 'ok' && p.a.red.length), cannot = per.filter((p) => p.a.state !== 'ok');
  for (const p of reds) give(p.e, { verdict: 'red', guards: p.a.red, reason: `${p.a.red.join(', ')} red on arc ${base} + ${p.e.branch} alone (train ${id}): fix it on the branch; the others ride the next train` });
  if (cannot.length) {
    return stop('environment', `environment: the attribution of train ${id} could not run on ${cannot.map((p) => p.a.why).join('; ')} - ${cannot.map((p) => p.e.task).join(', ')} stay in the queue without a verdict${reds.length ? `; red: ${reds.map((p) => p.e.task).join(', ')}` : ''}; the coordinator decides; log ${logFile}; attribution ${alog}`, { red: reds.map((p) => p.e.task) });
  }
  if (reds.length) {
    const red = reds.map((p) => p.e.task), note = `red train ${id}: red alone on the arc head: ${red.join(', ')}; the others ride the next train`;
    lines.push(note); al.push(note); writeA(); t.writeLog(); copyAll();
    record(Object.assign({ verdict: 'red', reason: note, red, attribution: alog }, base0));
    return Object.assign({ departed: true, verdict: 'red', reason: note, red, attribution: alog }, base0);
  }

  // 3. green on every passenger alone: a seam
  const coord = (w) => stop('coordinator', `red train ${id}: ${R.join(', ')} ${w} - no automatic decision, the coordinator decides; ${where}; attribution ${alog}`, { guards: R });
  const unstable = (list) => list.filter((p) => p.a.flaky.length).map((p) => `${p.a.flaky.join(', ')} flaky (red, then green alone) on ${p.a.desc}`);
  if (riders.length === 1) return coord(`red in the train and on its rerun alone, but green alone on the same tree (arc + ${riders[0].task})`);
  if (riders.length > 3) return coord(`seam red, passengers {${riders.map((e) => e.task).join(', ')}}: green on each alone; a seam among more than three passengers is not searched`);
  const u1 = unstable(per);
  if (u1.length) return coord(`now red, now green: ${u1.join('; ')}`);
  const seam = (earlier, laters, group, guards) => {
    const g = group.map((e) => e.task);
    for (const e of laters) {
      give(e, { verdict: 'seam', partner: earlier.task, partnerBranch: earlier.branch, partnerHead: earlier.head, pair: g, guards,
        reason: `seam red: ${guards.join(', ')} red on arc ${base} + ${g.join(' + ')} together, green on each alone (train ${id}): ${earlier.task} arrived first and rides the next train; fix the seam with ${earlier.branch} on the arc head once it is merged` });
    }
    const note = `seam train ${id}: ${guards.join(', ')} on {${g.join(', ')}}; ${earlier.task} rides the next train, seam: ${laters.map((e) => e.task).join(', ')}`;
    lines.push(note); al.push(note); writeA(); t.writeLog(); copyAll();
    const o = { seam: laters.map((e) => e.task), partner: earlier.task, pair: g, guards, attribution: alog };
    record(Object.assign({ verdict: 'seam', reason: note }, base0, o));
    return Object.assign({ departed: true, verdict: 'seam', reason: note }, base0, o);
  };
  if (riders.length === 2) return seam(riders[0], [riders[1]], riders, R);
  const pairs = [];
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) pairs.push({ ps: [riders[i], riders[j]], a: await attempt(`p${i + 1}p${j + 1}`, [riders[i], riders[j]]) });
  const pc = pairs.filter((p) => p.a.state !== 'ok');
  if (pc.length) return stop('environment', `environment: the attribution of train ${id} could not run on ${pc.map((p) => p.a.why).join('; ')} - the seam is not named, the passengers stay in the queue; the coordinator decides; log ${logFile}; attribution ${alog}`);
  const u2 = unstable(pairs);
  if (u2.length) return coord(`now red, now green on a pair: ${u2.join('; ')}`);
  const redPairs = pairs.filter((p) => p.a.red.length);
  if (redPairs.length > 1) return coord(`red on several pairs (${redPairs.map((p) => p.a.desc).join('; ')}): no one seam pair`);
  if (redPairs.length === 1) { const [a, b] = redPairs[0].ps; return seam(a, [b], [a, b], redPairs[0].a.red); }
  return seam(riders[0], [riders[1], riders[2]], riders, R);
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

// The verdict of a result or a halt as the exit code of `ride` (the chain's wait step returns only the exit code; the
// workflow reads no files, so the code is the verdict and the details stay in the result file).
const RIDE_RC = { green: 0, 'green-unmerged': 10, red: 11, seam: 12, conflict: 13, 'arc-red': 14, coordinator: 15 };
const RC_ENV = 75, RC_QUEUE = 74, RC_REFUSED = 65;
const rideRc = (o) => (o && Object.prototype.hasOwnProperty.call(RIDE_RC, o.verdict) && !(o.halted && !['arc-red', 'coordinator'].includes(o.verdict)) ? RIDE_RC[o.verdict] : RC_ENV);

// enqueue: {decided, result} | {queued, existing?}; exits on a refusal (65) or a queue that cannot be written (74).
function enqueue(P, a, USAGE) {
  if (!TASK.test(a.task || '') || !SHA.test(a.head || '') || !branchOk(a.branch) || !branchOk(a.base)) die(64, `${USAGE}\n  (task: letters, digits . _ -; head: a full sha; branch and base: branch names)`);
  // Refused before the queue (coordinator's decisions for c3): the dispatcher moves the arc branch, so the base is a
  // branch of the repository (a commit cannot be moved) and never a protected one (rule push: merges into a protected
  // branch are the owner's call).
  const prot = Array.isArray(P.c.protectedBranches) ? P.c.protectedBranches : [];
  if (prot.includes(a.base)) die(RC_REFUSED, `refused before the queue: base ${a.base} is a protected branch (protectedBranches: ${prot.join(', ')}) - the train moves only the branch of the arc`);
  if (!rev(P, `refs/heads/${a.base}`)) die(RC_REFUSED, `refused before the queue: base ${a.base} is not a branch of ${P.c.repoDir} (refs/heads/${a.base}) - the train needs the branch of the arc, not a commit`);
  const done = readJ(resultFile(P, a.task, a.head));
  if (done) return { decided: true, result: done };
  try {
    for (const e of entries(P).filter((x) => x.task === a.task)) {
      if (e.head === a.head) return { queued: e.file, existing: true };
      fs.rmSync(e.file, { force: true });
    }
    const f = path.join(P.Q, `${String(Date.now()).padStart(13, '0')}-${a.task}.json`);
    writeAtomic(f, { task: a.task, branch: a.branch, head: a.head, base: a.base, dir: a.dir ? path.resolve(a.dir) : '', enqueuedAt: new Date().toISOString() });
    return { queued: f };
  } catch (e) {
    die(RC_QUEUE, `the train queue ${P.Q} is unavailable (${e.code || e.message}): ${a.task} ${a.branch} head ${a.head} is not queued - the review accepted it, the coordinator queues it by hand`);
  }
}

// await: the result of the entry, or the halt as {verdict: environment | arc-red | coordinator, halted: true, ...};
// null when there is neither an entry nor a result.
async function awaitEntry(P, task, head, poll) {
  for (;;) {
    const r = readJ(resultFile(P, task, head));
    if (r) return r;
    const h = readJ(P.HALT);
    if (h) return Object.assign({ verdict: 'environment', halted: true, task, head }, h);
    if (!entries(P).some((e) => e.task === task && e.head === head)) {
      // finish() writes the result before it removes the entry: read the result again, it may have come in between
      return readJ(resultFile(P, task, head));
    }
    const d = await dispatch(P);
    if (!d.departed) await sleep(poll);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const USAGE = 'usage: train.js enqueue --task <t> --branch <b> --head <sha> --base <arc> [--dir <folder>] | ride (the same) | run | await --task <t> --head <sha> [--poll <s>] | status | resume';
  if (!['enqueue', 'ride', 'run', 'await', 'status', 'resume'].includes(cmd)) die(64, USAGE);
  const a = args(rest);
  const P = project();
  const poll = 1000 * (Number(a.poll || process.env.CODIS_TRAIN_POLL) || 10);
  if (cmd === 'enqueue') { out(enqueue(P, a, USAGE)); return 0; }
  if (cmd === 'ride') {
    // the chain after the review (p-train-c3): enqueue, then await; the exit code is the verdict (RIDE_RC)
    const q = enqueue(P, a, USAGE);
    out(q);
    let r = q.decided ? q.result : await awaitEntry(P, a.task, a.head, poll);
    if (!r) die(66, `no queue entry and no result for ${a.task} ${a.head}`);
    // a seam is fixed on the arc head that holds the earlier branch: wait for the partner's result first (it rides the
    // next train), so the fix round starts after it
    if (!r.halted && r.verdict === 'seam' && r.partner && TASK.test(r.partner) && SHA.test(r.partnerHead || '')) {
      const pr = await awaitEntry(P, r.partner, r.partnerHead, poll);
      if (pr && pr.halted) { out(Object.assign({}, r, { partnerResult: pr })); return RC_ENV; }
      r = Object.assign({}, r, { partnerResult: pr || { verdict: 'none', reason: `no queue entry and no result for ${r.partner} ${r.partnerHead}` } });
    }
    out(r);
    return rideRc(r);
  }
  if (cmd === 'run') { out(await dispatch(P)); return 0; }
  if (cmd === 'await') {
    if (!TASK.test(a.task || '') || !SHA.test(a.head || '')) die(64, USAGE);
    const r = await awaitEntry(P, a.task, a.head, poll);
    if (!r) die(66, `no queue entry and no result for ${a.task} ${a.head}`);
    out(r); return 0;
  }
  if (cmd === 'status') {
    const h = readJ(P.HALT), o = readJ(ownerFile(P));
    console.log(h ? `halt: ${h.reason} (since ${h.at}); the coordinator lifts it with train.js resume` : 'halt: none');
    console.log(o ? `lock: train ${o.train || '-'} by pid ${o.pid} (${holderAlive(o) ? 'alive' : 'dead'}) since ${o.since}` : 'lock: free');
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
