#!/usr/bin/env node
'use strict';
// The walk of a worktree for the checks of a commit (scripts/commit-service.js), a process of its own that the adapter
// can remove with a signal: a synchronous file call that hangs stops this process, never the adapter's loop (owner
// 2026-11-07). usage: node commit-walk.js <job.json>; one JSON object on stdout, written whole at the end, exit 0.
//
// Modes of the job:
// - walk: the non-folder entries of the worktree outside the tracked paths of job.h0 and outside job.named, with
//   (type, dev, ino, size, mode, mtime, ctime) and their class by the ignore rules; every .gitignore is copied into the
//   mirror (job.mirror), and git check-ignore answers against the mirror, so no git command reads the worktree. With
//   job.previous (the mirror of the walk before) each file also gets its class by those rules.
// - named: only the .gitignore files of the parents of job.named, and which of those paths are ignored.
// - hash: the blob ids of job.paths (a link: of its text).
// The worktree is an untrusted source: nothing of it is followed or executed.
// - An entry is looked at with lstat; a folder is listed in portions after an open with O_NOFOLLOW_ANY, and its inode is
//   compared after the listing: a folder replaced during the walk stops it. Node has no listing by descriptor, so a
//   folder replaced and put back between the open and the listing is seen only by this compare (README, Known gaps).
// - A .gitignore is read with O_NOFOLLOW_ANY | O_NONBLOCK and fstat: a link counts as absent (as git 2.50 reads it);
//   a FIFO, socket, device or folder stops the walk with kind "gitignore".
// - An entry named .git in any case is not entered; a tracked folder is a gitlink, not entered either.
// Limits (job.limits), all of them answered with {limit, visited}, never with a partial list: entries visited (folders
// and ignored ones too), the volume of results, the total of ignore files, the bytes read for hashes, a deadline of its
// own (the adapter's timer removes this process in any case; the deadline ends an orphan). The answer of a stop is
// {problem: {kind, text}, visited}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const O_NOFOLLOW_ANY = 0x20000000; // macOS <sys/fcntl.h>
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW_ANY;
const DIR_FLAGS = READ_FLAGS | fs.constants.O_DIRECTORY;
const PORTION = 256; // entries of one read of a folder
const PROGRESS_EVERY = 1000;

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const L = job.limits;
const started = Date.now();
let visited = 0, resultBytes = 0, ignoreBytes = 0;

const answer = (o) => {
  const b = Buffer.from(JSON.stringify(Object.assign({ visited }, o)) + '\n');
  for (let off = 0; off < b.length;) off += fs.writeSync(1, b, off);
  process.exit(0);
};
const stop = (kind, text) => answer({ problem: { kind, text } });
const limit = (name) => answer({ limit: name });
const progressFd = job.progress ? fs.openSync(job.progress, 'w', 0o600) : null;
const countEntry = () => {
  visited++;
  if (visited > L.entries) limit('entries');
  if (visited % PROGRESS_EVERY === 0) {
    if (progressFd !== null) fs.writeSync(progressFd, `${String(visited).padEnd(12)}\n`, 0);
    if (Date.now() - started > L.timeoutMs) limit('timeout');
  }
};
const addResult = (n) => { resultBytes += n; if (resultBytes > L.resultBytes) limit('results'); };
const gitRun = (args, input, x) => spawnSync(job.git, job.gitArgs.concat(args), Object.assign({ env: job.gitEnv, input, maxBuffer: L.resultBytes * 4 + (1 << 20),
  timeout: Math.max(1, L.timeoutMs - (Date.now() - started)) }, x));

// A copy of the .gitignore of the folder rel in the mirror; a link or nothing: no copy.
function copyIgnore(rel, name) {
  const inWt = path.join(job.wt, rel, name);
  let fd;
  try { fd = fs.openSync(inWt, READ_FLAGS); } catch (e) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes(e.code)) return;
    if (e.code === 'ENAMETOOLONG') stop('deep', `a path too long to walk: ${path.join(rel, name).slice(0, 200)}`);
    stop('walk', `${path.join(rel, name)}: ${e.code}`);
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile()) stop('gitignore', `a .gitignore that is not a regular file: ${path.join(rel, name)}`);
  ignoreBytes += st.size;
  if (ignoreBytes > L.ignoreBytes) limit('ignore');
  const b = Buffer.alloc(st.size);
  let got = 0;
  while (got < b.length) { const n = fs.readSync(fd, b, got, b.length - got, null); if (!n) break; got += n; }
  fs.closeSync(fd);
  const dir = path.join(job.mirror, rel);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), b.subarray(0, got));
  } catch (e) {
    if (e.code === 'ENAMETOOLONG') stop('deep', `a path too long to walk: ${rel.slice(0, 200)}`);
    stop('walk', `the copy of ${path.join(rel, name)}: ${e.code}`);
  }
}

// The paths git check-ignore finds ignored by the rules of a mirror. check-ignore reads its input as pathspecs and
// refuses the literal magic, so a name that starts with ":" would be parsed as magic (":(top)build/x" is classed as
// build/x, ":(glob)y" fails); every path goes with the prefix "./", which leaves the name as it is, and git echoes the
// input, so the answer loses the prefix again.
function ignoredBy(mirror, paths) {
  if (!paths.length) return new Set();
  fs.mkdirSync(mirror, { recursive: true });
  const p = gitRun(['check-ignore', '--no-index', '-z', '--stdin'], Buffer.from(paths.map((x) => `./${x}\0`).join('')), { cwd: mirror, env: Object.assign({}, job.gitEnv, { GIT_WORK_TREE: mirror }) });
  if (p.error && p.error.code === 'ETIMEDOUT') limit('timeout');
  if (p.status !== 0 && p.status !== 1) stop('walk', `git check-ignore failed (rc ${p.status}): ${String(p.stderr || p.error || '').slice(0, 300)}`);
  return new Set(p.stdout.toString('utf8').split('\0').filter(Boolean).map((x) => x.slice(2)));
}

function trackedOf() {
  const p = gitRun(['ls-tree', '-r', '-z', '--name-only', '--full-tree', job.h0], undefined, { cwd: job.emptyWt, maxBuffer: 1 << 30 });
  if (p.status !== 0) stop('walk', `ls-tree failed (rc ${p.status}): ${String(p.stderr || '').slice(0, 300)}`);
  return new Set(p.stdout.toString('utf8').split('\0').filter(Boolean));
}

const typeOf = (st) => (st.isFile() ? 'f' : st.isSymbolicLink() ? 'l' : st.isFIFO() ? 'p' : st.isSocket() ? 's' : 'o');

function walk() {
  const tracked = trackedOf();
  const named = new Set(job.named);
  const files = [], notes = [];
  const stack = [''];
  const deep = (p) => stop('deep', `a path too long to walk: ${p.slice(0, 200)}`);
  while (stack.length) {
    const rel = stack.pop();
    const full = rel ? path.join(job.wt, rel) : job.wt;
    const shown = rel || '.';
    let fd, dir, st;
    try {
      fd = fs.openSync(full, DIR_FLAGS);
      st = fs.fstatSync(fd, { bigint: true });
      dir = fs.opendirSync(full, { bufferSize: PORTION });
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      if (e.code === 'ENOENT') continue;
      if (e.code === 'ENAMETOOLONG') deep(shown);
      if (e.code === 'EACCES' || e.code === 'EPERM') { notes.push(`${shown}: not listed (${e.code}), its contents are not compared`); addResult(shown.length + 60); continue; }
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR') stop('replaced', `the folder ${shown} was replaced during the walk`);
      stop('walk', `${shown}: ${e.code}`);
    }
    for (;;) {
      let e;
      try { e = dir.readSync(); } catch (x) { stop('walk', `${shown}: ${x.code}`); }
      if (!e) break;
      countEntry();
      const name = e.name;
      const low = name.toLowerCase();
      if (low === '.git') continue;
      const child = rel ? `${rel}/${name}` : name;
      if (Date.now() - started > L.timeoutMs) limit('timeout');
      let ls;
      try { ls = fs.lstatSync(path.join(job.wt, child), { bigint: true }); } catch (x) {
        if (x.code === 'ENOENT') continue;
        if (x.code === 'ENAMETOOLONG') deep(child);
        notes.push(`${child}: not read (${x.code}), not compared`);
        addResult(child.length + 60);
        continue;
      }
      if (low === '.gitignore') copyIgnore(rel, name);
      if (ls.isDirectory()) { if (!tracked.has(child)) stack.push(child); continue; }
      if (tracked.has(child) || named.has(child)) continue;
      addResult(Buffer.byteLength(child) + 140);
      files.push({ p: child, t: typeOf(ls), s: Number(ls.size), k: [typeOf(ls), ls.dev, ls.ino, ls.size, ls.mode, ls.mtimeNs, ls.ctimeNs].join(':') });
    }
    dir.closeSync();
    fs.closeSync(fd);
    let after = null;
    try { after = fs.lstatSync(full, { bigint: true }); } catch { /* below */ }
    if (!after || !after.isDirectory() || after.ino !== st.ino || after.dev !== st.dev) stop('replaced', `the folder ${shown} was replaced during the walk`);
  }
  const paths = files.map((f) => f.p);
  const own = ignoredBy(job.mirror, paths);
  const prev = job.previous ? ignoredBy(job.previous, paths) : null;
  for (const f of files) {
    f.i = own.has(f.p);
    if (prev) f.c = prev.has(f.p);
  }
  answer({ ok: true, files, notes });
}

function named() {
  const seen = new Set();
  for (const p of job.named) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(0, i).join('/');
      if (seen.has(rel)) continue;
      seen.add(rel);
      countEntry();
      copyIgnore(rel, '.gitignore');
    }
  }
  answer({ ok: true, ignored: [...ignoredBy(job.mirror, job.named)] });
}

function hash() {
  const O_SYMLINK = fs.constants.O_SYMLINK;
  const ids = {};
  let read = 0;
  for (const p of job.paths) {
    countEntry();
    const full = path.join(job.wt, p);
    let fd;
    try { fd = fs.openSync(full, READ_FLAGS | O_SYMLINK); } catch { continue; }
    const st = fs.fstatSync(fd);
    const h = crypto.createHash(job.objFormat);
    if (st.isSymbolicLink()) {
      let text;
      try { text = Buffer.from(fs.readlinkSync(full)); } catch { fs.closeSync(fd); continue; }
      h.update(`blob ${text.length}\0`).update(text);
      ids[p] = h.digest('hex');
    } else if (st.isFile()) {
      read += st.size;
      if (read > L.readBytes) limit('read');
      h.update(`blob ${st.size}\0`);
      const b = Buffer.alloc(1 << 20);
      for (;;) {
        const n = fs.readSync(fd, b, 0, b.length, null);
        if (!n) break;
        h.update(b.subarray(0, n));
      }
      ids[p] = h.digest('hex');
    }
    fs.closeSync(fd);
    if (Date.now() - started > L.timeoutMs) limit('timeout');
  }
  answer({ ok: true, ids });
}

({ walk, named, hash })[job.mode]();
