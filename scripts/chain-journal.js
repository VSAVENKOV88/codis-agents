#!/usr/bin/env node
'use strict';
// The journal of a task in a run of the conductor (scripts/chain-run.js) and the safe access to its service files.
//
// <sharedDir>/runs/<runId>/journal/<key>/seg-NNN.jsonl - the events, one JSON line each; the journal is the truth.
// <sharedDir>/runs/<runId>/journal/<key>/run-state.json - the snapshot, the fold of the journal up to its seq.
// A line: {v, runId, seq, at, key, type, ...}; seq counts from 1 across the segments, type is intent, launch, result,
// settled or end. A step has a stepId of its own (a label repeats between rounds).
//   intent   before a step runs: stepId, n, label, kind (agent|exec), stepKind, effect, gated, phase, waitId, gitHead, counts, head
//   launch   its process: pid, pgid, lstart, callDir, gated; {substitute: true} for a launcher of a test; started, attached,
//            reused, rc for a run of wait-step.js
//   result   its end: outcome, value, rc, signal, error, callDir, seconds
//   settled  stepIds, counts, head: the counters of the script after it took those results
//   end      the task is over: status, counts (open steps stay open: end closes nothing)
//
// Rules of the state (owner 2026-11-06, answer 12; 2026-11-07, the place of the journal):
// - a line is written and fsynced before the event may have an effect, and the snapshot only after its line;
// - a tail without its newline is no record, whatever it holds: a reader shows it (torn) and does not count it; the next
//   line goes to a new segment, and the torn file is never appended to;
// - damage inside (a line that does not parse and is not the tail, a seq gap, another runId, task, version or type, an
//   event of a step with no intent) is a refusal for the reader and for a writer;
// - the snapshot may lag (rebuilt from the journal in memory: a reader writes nothing), never lead: a snapshot ahead of
//   the journal, or without one, is a refusal. A writer puts a line, then its snapshot, and a reader or a writer that opens
//   takes the snapshot first and folds after it, so the fold holds every line the snapshot counts: for a healthy run
//   snapshot seq <= journal seq at any moment, beside a live writer too (this rests on read-after-write of the local disk
//   sharedDir lies on);
// - one writer per run folder (takeWriter); the conductor alone writes these events, and what a role answers is only the
//   value inside a result line, so a role's message never becomes an event.
//
// A service file is opened with no link followed (macOS O_NOFOLLOW_ANY, elsewhere O_NOFOLLOW) and without blocking
// (O_NONBLOCK), and its type and link count come from fstat of the open file: a check before the open proves nothing.
// A lock is the exception to the link count (readLock): it has two names for a moment, and it is only read and removed.
// Paths must be real ones (the conductor resolves the run folder once, before any role). A writer pins its folder at
// open: dev and inode, its real path; every line checks both, so a folder or a parent swapped for another folder or a
// link is refused and nothing is written behind it.
//
// Known gap: the guarantee rests on the sandbox of a role. chain-run.js refuses a state folder inside a write root of
// a role, and a role of the codex host cannot write outside its roots. A role of the claude host has no sandbox: it runs
// as the same user and can edit these files, so on that host a journal shows what happened, it does not withstand a
// role that attacks it.
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const C = fs.constants;
const NOFOLLOW = process.platform === 'darwin' ? 0x20000000 : C.O_NOFOLLOW; // macOS refuses both together (EINVAL)
const READ_FLAGS = C.O_RDONLY | C.O_NONBLOCK | NOFOLLOW;
const APPEND_FLAGS = C.O_WRONLY | C.O_APPEND | C.O_NONBLOCK | NOFOLLOW;
const TYPES = new Set(['intent', 'launch', 'result', 'settled', 'end']);
// A task key names files of the state: letters, digits and . _ - : # (":" and "#" are the adapter's to refuse), no
// separator, no leading dot. The conductor checks it before anything is written.
const KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._:#-]*$/;

// The link count guards a write through a hard link to the outside.
function regularFd(file, flags, mode) {
  const fd = fs.openSync(file, flags, mode);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.nlink !== 1) throw new Error(`${file} has ${st.nlink} links`);
    return { fd, st };
  } catch (e) { fs.closeSync(fd); throw e; }
}
function readBytes(file) {
  const { fd } = regularFd(file, READ_FLAGS);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
const readText = (file) => readBytes(file).toString('utf8');
function readJsonSafe(file) {
  try { return JSON.parse(readText(file)); } catch { return null; }
}
// One line appended to a service file (the log of a run); created when missing.
function appendLine(file, text) {
  const { fd } = regularFd(file, APPEND_FLAGS | C.O_CREAT, 0o644);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, C.O_RDONLY | C.O_DIRECTORY | NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// tmp -> fsync -> rename -> fsync of the folder. The temporary file is created new (O_EXCL, no link followed), and the
// rename replaces whatever stands at the name without following it.
function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch { /* none */ }
  const fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o644);
  try { fs.writeSync(fd, JSON.stringify(obj, null, 1) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

// A lock read with exactly one of three answers: {data}, its JSON object; {gone}, no file; {unreadable}, a link, a FIFO, a
// folder or garbage. No link count here: a lock taken by a hard link has two names until its taker removes the temporary
// one, for good if the taker dies between the two, and a lock is never written to, so a hard link leads nowhere.
function readLock(file) {
  let fd;
  try { fd = fs.openSync(file, READ_FLAGS); } catch (e) { return e.code === 'ENOENT' ? { gone: true } : { unreadable: e.message }; }
  try {
    if (!fs.fstatSync(fd).isFile()) return { unreadable: `${file} is not a regular file` };
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { unreadable: `${file} holds no lock` };
  } catch (e) { return { unreadable: e.message }; } finally { fs.closeSync(fd); }
}
// Takes the lock by a hard link, whole: {ok}, or the answer of readLock for the lock that holds the name. A lock gone after
// EEXIST was released, so the name is free again: the loop has no timer, every turn means another conductor moved on.
function linkLock(tmp, file) {
  for (;;) {
    try { fs.linkSync(tmp, file); return { ok: true }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const held = readLock(file);
    if (!held.gone) return held;
  }
}
// The one writer of a run folder: writer.lock, kept with the folder, so a folder gets one conductor in its life. {ok} or
// {held: <what the lock says>}.
function takeWriter(runDir, me) {
  const file = path.join(runDir, 'writer.lock');
  const tmp = `${file}.${process.pid}.new`;
  writeAtomic(tmp, Object.assign({ takenAt: new Date().toISOString() }, me));
  try {
    const r = linkLock(tmp, file);
    return r.ok ? { ok: true } : { ok: false, held: r.data || {} };
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

// ---- the fold
// seen: every stepId with an intent. Not enumerable, so it stays out of the snapshot, which names only what a reader shows.
const emptyState = () => Object.defineProperty({ open: {}, last: null, counts: null, head: null, ended: null, unsettled: [], steps: 0 }, 'seen', { value: new Set() });
// Why a line cannot follow the ones before it, or null. A step has one intent and one launch: a repeat would erase the
// launch, and a step that started would read as one that never did.
function damageOf(s, e) {
  if (e.type === 'intent') {
    if (typeof e.stepId !== 'string' || !e.stepId) return 'an intent with no stepId';
    if (s.seen.has(e.stepId)) return `a second intent of step ${e.stepId}`;
  }
  if (e.type === 'launch') {
    if (!s.open[e.stepId]) return `a launch of step ${e.stepId}, which is not open`;
    if (s.open[e.stepId].launch) return `a second launch of step ${e.stepId}`;
  }
  if (e.type === 'result' && !s.open[e.stepId]) return `a result of step ${e.stepId}, which is not open`;
  if (e.type === 'settled') {
    if (!Array.isArray(e.stepIds)) return 'a settled with no list of steps';
    const unknown = e.stepIds.find((x) => !s.seen.has(x));
    if (unknown !== undefined) return `a settled of step ${unknown}, which has no intent`;
  }
  return null;
}
// The state after a line that damageOf let pass.
function apply(s, e) {
  if (e.counts) s.counts = e.counts;
  if (typeof e.head === 'string') s.head = e.head;
  if (e.type === 'intent') {
    s.seen.add(e.stepId);
    s.open[e.stepId] = { stepId: e.stepId, n: e.n, label: e.label, kind: e.kind, stepKind: e.stepKind, effect: e.effect, gated: e.gated, phase: e.phase, waitId: e.waitId, at: e.at, gitHead: e.gitHead, launch: null };
    s.steps++;
  } else if (e.type === 'launch') {
    const { pid, pgid, lstart, callDir, gated, substitute, started, attached, reused, rc } = e;
    s.open[e.stepId].launch = { pid, pgid, lstart, callDir, gated, substitute, started, attached, reused, rc, at: e.at };
  } else if (e.type === 'result') {
    s.last = { stepId: e.stepId, label: s.open[e.stepId].label, outcome: e.outcome, at: e.at };
    delete s.open[e.stepId];
    s.unsettled.push(e.stepId);
  } else if (e.type === 'settled') {
    s.unsettled = s.unsettled.filter((x) => !e.stepIds.includes(x));
  } else if (e.type === 'end') {
    s.ended = { status: e.status, at: e.at, counts: e.counts };
  }
}

// ---- reading
const jdir = (runDir, key) => path.join(runDir, 'journal', key);
const segName = (n) => `seg-${String(n).padStart(3, '0')}.jsonl`;
const segNumber = (name) => +/\d+/.exec(name)[0];
// By number: a name grows past three digits (seg-1000 comes after seg-999).
const segments = (dir) => fs.readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort((a, b) => segNumber(a) - segNumber(b));

// The journal of a task: {none} when there is none, {error} on damage, else {runId, key, seq, state, torn, segments, tailOfLast}.
function foldSegments(dir, key) {
  const state = emptyState();
  const torn = [];
  const names = segments(dir);
  let seq = 0, runId = null, tailOfLast = false, sizeOfLast = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const bytes = readBytes(file);
    const parts = bytes.toString('utf8').split('\n');
    const tail = parts.pop();
    tailOfLast = tail !== '';
    sizeOfLast = bytes.length;
    // In bytes of the file: the tail may end inside a character.
    if (tailOfLast) torn.push({ file, bytes: bytes.length - bytes.lastIndexOf(0x0a) - 1, text: tail.slice(0, 300) });
    for (const [i, line] of parts.entries()) {
      const at = `${file}:${i + 1}`;
      let e;
      try { e = JSON.parse(line); } catch { return { error: `journal corrupt at ${at}: the line does not parse` }; }
      if (!e || typeof e !== 'object') return { error: `journal corrupt at ${at}: not an object` };
      if (e.v !== VERSION) return { error: `journal corrupt at ${at}: format version ${e.v}, this code reads ${VERSION}` };
      if (runId === null) runId = e.runId;
      if (e.runId !== runId) return { error: `journal corrupt at ${at}: runId ${e.runId} in a journal of ${runId}` };
      if (e.key !== key) return { error: `journal corrupt at ${at}: task ${e.key} in the journal of ${key}` };
      if (e.seq !== seq + 1) return { error: `journal corrupt at ${at}: seq ${e.seq} after ${seq}` };
      if (!TYPES.has(e.type)) return { error: `journal corrupt at ${at}: unknown event type ${e.type}` };
      const bad = damageOf(state, e);
      if (bad) return { error: `journal corrupt at ${at}: ${bad}` };
      apply(state, e);
      seq = e.seq;
    }
  }
  return { runId, seq, state, torn, segments: names.length, last: names.length ? names[names.length - 1] : null, tailOfLast, sizeOfLast };
}
// The snapshot as it stands: {has: something stands at the name, snap: its parsed text, or null when it cannot be read or is
// not a regular file, which a rebuild replaces}. Taken before the fold (the rule of the state above).
function readSnapshot(snapFile) {
  try { return { has: true, snap: JSON.parse(readText(snapFile)) }; } catch (e) { return { has: e.code !== 'ENOENT', snap: null }; }
}
// The refusal of a snapshot against the fold made after it, or null: ahead of the journal, or without one. Reader and writer alike.
function snapshotRefusal(snapFile, read, f) {
  if (!f.segments && read.has) return `run-state ${snapFile} exists but there is no journal`;
  const { snap } = read;
  if (snap && typeof snap.seq === 'number' && snap.seq > f.seq) return `run-state ${snapFile} is ahead of the journal: seq ${snap.seq} against ${f.seq}`;
  return null;
}
// The state of a task for a reader, who writes nothing. snapshot: current, differs (same seq, another state: the journal
// wins), rebuilt (missing, older, unreadable or not a regular file).
function readJournal(runDir, key) {
  const dir = jdir(runDir, key);
  const snapFile = path.join(dir, 'run-state.json');
  let f, read;
  try {
    if (!fs.existsSync(dir)) return { none: true, state: null, seq: 0, torn: [] };
    read = readSnapshot(snapFile);
    f = foldSegments(dir, key);
  } catch (e) { return { error: `journal unreadable: ${e.message}`, state: null, torn: [] }; }
  if (f.error) return { error: f.error, state: null, torn: [] };
  const error = snapshotRefusal(snapFile, read, f);
  if (error) return { error, state: null, torn: f.torn };
  const { snap } = read;
  if (!f.segments) return { none: true, state: null, seq: 0, torn: [] };
  const out = { runId: f.runId, seq: f.seq, state: f.state, torn: f.torn, segments: f.segments };
  if (!snap || snap.seq !== f.seq) out.snapshot = 'rebuilt';
  else {
    const same = ['open', 'last', 'counts', 'head', 'ended', 'unsettled'].every((k) => JSON.stringify(snap[k]) === JSON.stringify(f.state[k]));
    out.snapshot = same ? 'current' : 'differs';
  }
  return out;
}

// ---- writing
// The writer of a task's journal. o.io: {writeSync, fsyncSync} (tests: a write that fails or is cut). append(fields) throws
// when the line is not on disk or the snapshot not written: the caller must not start what the line announces.
function openJournal(runDir, runId, key, o) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes(':') || key.includes('#')) throw new Error(`the task key ${JSON.stringify(key)} cannot name a journal`);
  const io = Object.assign({ writeSync: fs.writeSync, fsyncSync: fs.fsyncSync }, (o && o.io) || {});
  const dir = jdir(runDir, key);
  // One level at a time: mkdir with recursive would walk through a link in place of journal/.
  for (const d of [path.join(runDir, 'journal'), dir]) {
    try { fs.mkdirSync(d, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.lstatSync(d).isDirectory()) throw new Error(`${d} is not a folder`);
  }
  if (fs.realpathSync(dir) !== dir) throw new Error(`the journal folder ${dir} goes through a link`);
  const pinDir = () => {
    const fd = fs.openSync(dir, C.O_RDONLY | C.O_DIRECTORY | NOFOLLOW);
    try { const s = fs.fstatSync(fd); return { dev: s.dev, ino: s.ino }; } finally { fs.closeSync(fd); }
  };
  const pin = pinDir();
  const assertDir = () => {
    let same = false;
    try { const p = pinDir(); same = p.dev === pin.dev && p.ino === pin.ino && fs.realpathSync(dir) === dir; } catch { /* below */ }
    if (!same) throw new Error(`the journal folder ${dir} was replaced`);
  };
  const snapFile = path.join(dir, 'run-state.json');
  const read = readSnapshot(snapFile);
  const f = foldSegments(dir, key);
  if (f.error) throw new Error(f.error);
  if (f.segments && f.runId !== null && f.runId !== runId) throw new Error(`the journal in ${dir} belongs to run ${f.runId}`);
  const refused = snapshotRefusal(snapFile, read, f);
  if (refused) throw new Error(refused);
  let state = f.state, seq = f.seq;
  // A torn tail in the last segment: that file is closed for good, the next line opens the next one.
  let segNo = f.last ? segNumber(f.last) + (f.tailOfLast ? 1 : 0) : 0;
  let size = f.last && !f.tailOfLast ? f.sizeOfLast : 0;
  let fresh = !(f.last && !f.tailOfLast);
  const writeSnapshot = () => writeAtomic(snapFile, Object.assign({ v: VERSION, runId, key, seq }, state));

  function append(fields) {
    const line = Object.assign({ v: VERSION, runId, seq: seq + 1, at: new Date().toISOString(), key }, fields);
    // Before the disk: a line of the journal that cannot follow would make the whole journal refused.
    const bad = damageOf(state, line);
    if (bad) throw new Error(`the conductor asked for an impossible event: ${bad}`);
    const text = JSON.stringify(line) + '\n';
    const len = Buffer.byteLength(text);
    assertDir();
    const file = path.join(dir, segName(segNo));
    const { fd, st } = regularFd(file, APPEND_FLAGS | (fresh ? C.O_CREAT | C.O_EXCL : 0), 0o600);
    let failure = null;
    try {
      if (st.size !== size) throw new Error(`${file} changed under its writer: ${st.size} bytes, expected ${size}`);
      if (fresh) { fresh = false; fsyncDir(dir); }
      try {
        const n = io.writeSync(fd, text);
        if (n !== len) throw new Error(`a short write to ${file}: ${n} of ${len} bytes`);
        io.fsyncSync(fd);
      } catch (e) { failure = e; }
      if (failure) {
        // What the file now holds decides: nothing - the line is not there; the whole line - it counts; a part - a torn
        // tail, so this file is closed.
        const now = fs.fstatSync(fd).size;
        if (now !== size && now !== size + len) { segNo++; size = 0; fresh = true; failure.message = `${failure.message}; ${file} has a torn tail`; throw failure; }
        if (now === size) throw failure;
      }
    } finally { fs.closeSync(fd); }
    seq++;
    size += len;
    apply(state, line);
    writeSnapshot();
    if (failure) throw failure;
    return line;
  }
  if (f.segments) writeSnapshot();
  return { append, dir, get seq() { return seq; }, get state() { return state; } };
}

module.exports = { VERSION, KEY_RE, openJournal, readJournal, readText, readJsonSafe, readLock, linkLock, appendLine, writeAtomic, takeWriter };
