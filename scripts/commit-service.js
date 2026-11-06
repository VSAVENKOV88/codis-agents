'use strict';
// The commit service of the role adapter (p-codex A2a-1): a role inside its sandbox asks for a commit of named paths,
// and the adapter commits them outside the sandbox. scripts/role-exec.js opens one service per prog/test call and
// closes it when the role's process is gone; the role runs scripts/commit-req.js.
//
// The box (a folder in the role's call folder) is an untrusted source (owner 2026-11-06, answer to G2):
// - the adapter only reads it: it never renames, removes or writes anything there;
// - a request is read with open(O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY) and fstat: a symbolic link in any component of
//   the path fails the open itself (ELOOP), so no check-then-read race; a FIFO, socket, device or folder opens without
//   blocking and is refused by fstat; a request above MAX_REQUEST_BYTES is refused. O_NOFOLLOW_ANY is macOS only;
//   elsewhere the flag means nothing, so a request is still opened and hashed (for its id in the journal) but never
//   parsed or committed: the service refuses every request;
// - only names <32 hex>.json are requests (the client publishes a request by renaming a finished temporary file);
//   every other name is ignored and no file of that name is made;
// - answers, the journal and the private index live in the adapter's state folder, outside the roots the role writes;
//   the adapter names every file it writes; a request cannot name a path of its own (any field but id, paths and
//   message is refused).
// How a request is noticed (owner 2026-11-06, answer 6): fs.watch on the box is only a signal to scan it again; the
// first scan runs at once, and a rescan runs every pollMs (1000 ms: the interval of the fallback poll, the latency is
// not bounded by it - a busy adapter and the scheduler add to it). Scans never overlap: a scan and the processing of
// its requests are synchronous, in the order the requests were created (birth time, then name). When fs.watch is
// unavailable or fails, the notes say so and the poll goes on. Missed or repeated events change nothing: the journal
// binds each id to its result, so a request read again is never committed again, and the same id with other content is
// refused.
//
// The commit (owner 2026-11-06, answer 4): plumbing only - hash-object -w --stdin --no-filters of the bytes Node read,
// read-tree and update-index --index-info into a private index, write-tree, commit-tree --no-gpg-sign, update-ref with
// the old value - never add, commit or reset. git is an absolute path found once, of a verified version
// (VERIFIED_GIT_VERSIONS); its environment is built from nothing (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null, a
// home of the adapter, GIT_NO_LAZY_FETCH=1 so a promisor remote of the repository is never run), and every command
// carries -c core.hooksPath=<an empty folder of the adapter> -c core.fsmonitor=false -c commit.gpgSign=false (a -c
// value wins over include.path). GIT_WORK_TREE is an empty folder of the adapter: no command of the commit reads the
// role's worktree. The bytes of a named file are read by Node with the same O_NOFOLLOW_ANY open.
// A repository whose user config names hooks of a check (pre-commit, prepare-commit-msg, commit-msg in any
// core.hooksPath of any config source or in <common git dir>/hooks, executable; or any hook.* key) is refused with "no
// safe check path": the checks inside the role's sandbox are part A2a-2, and without them the safe path is a refusal.
//
// The journal of the task (<stateDir>/<task>/commits.jsonl, owner B 2026-11-06 answers 12, 13): one writer (a lock
// with the pid), version 1, an event number per line, every line written and fsynced before the action it announces:
// intent (tree and parent) before commit-tree, intent-commit (sha and old tip) before update-ref, then the result. A
// torn last line is cut off, kept beside the journal and named in the notes, and its step is not taken as done; a
// damaged line inside refuses every request. On open, an intent without a result is settled by the tip of the branch:
// the intended sha -> committed; the old tip or no sha yet -> refused "interrupted"; anything else -> undetermined,
// and every request of the task is refused until the coordinator resolves it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const O_NOFOLLOW_ANY = 0x20000000; // macOS <sys/fcntl.h>: no symbolic link in any component of the path
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW_ANY;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PATHS = 1000;
const POLL_MS = 1000;
const JOURNAL_VERSION = 1;
// git versions on which the recipe was checked against a hostile config (hooks, fsmonitor, filters, signing, include,
// a promisor remote, inherited variables); another version refuses until it is checked (cfg.commit.gitVersions).
const VERIFIED_GIT_VERSIONS = ['2.50.0'];
const CHECK_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const ZERO = '0'.repeat(40);
const NAME_RE = /^([0-9a-f]{32})\.json$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const NOTES_MAX = 50;
// The config sources of the user's own git: read to find hooks and the identity, never used by the commit.
const USER_CONFIG_KEYS = /^(HOME|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const q = (s) => JSON.stringify(String(s)).slice(0, 200);

// {bytes, st} of a regular file, or {error, code}; never follows a symbolic link, never blocks on a FIFO.
function readNoFollow(file, max) {
  let fd;
  try { fd = fs.openSync(file, READ_FLAGS); } catch (e) {
    if (e.code === 'ELOOP') return { code: 'ELOOP', error: 'a component of the path is a symbolic link' };
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { code: 'ENOENT', error: 'missing' };
    return { code: e.code || 'EOPEN', error: `cannot open (${e.code || e.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { code: 'NOTFILE', error: `not a regular file (${st.isDirectory() ? 'a folder' : st.isFIFO() ? 'a FIFO' : st.isSocket() ? 'a socket' : 'a device or other'})` };
    if (st.size > max) return { code: 'SIZE', error: `size ${st.size} above the limit of ${max} bytes` };
    const chunks = [];
    let total = 0;
    for (;;) {
      const b = Buffer.alloc(Math.min(1 << 20, max + 1 - total) || 1);
      const n = fs.readSync(fd, b, 0, b.length, null);
      if (!n) break;
      chunks.push(b.subarray(0, n));
      total += n;
      if (total > max) return { code: 'SIZE', error: `size above the limit of ${max} bytes` };
    }
    return { bytes: Buffer.concat(chunks), st };
  } catch (e) {
    return { code: e.code || 'EREAD', error: `cannot read (${e.code || e.message})` };
  } finally { fs.closeSync(fd); }
}

// The reason a path of a request is refused, or null. Relative to the worktree root, no "." or ".." component, no
// .git component in any case (APFS is case-insensitive), no leading "-", no NUL or line break.
function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'an empty path';
  if (/[\0\n\r]/.test(p)) return 'a NUL or a line break in a path';
  if (p.length > 4096) return 'a path above 4096 characters';
  if (p.startsWith('-')) return `${q(p)}: a path may not start with "-"`;
  if (p.startsWith('/')) return `${q(p)}: an absolute path (paths are relative to the worktree root)`;
  for (const c of p.split('/')) {
    if (c === '') return `${q(p)}: an empty component`;
    if (c === '.' || c === '..') return `${q(p)}: a "." or ".." component`;
    if (c.toLowerCase() === '.git') return `${q(p)}: a .git component`;
  }
  return null;
}

// The form of a request: exactly {id, paths, message}. The reason, or null.
function requestProblem(r, id) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'the request is not a JSON object';
  const extra = Object.keys(r).filter((k) => !['id', 'paths', 'message'].includes(k));
  if (extra.length) return `fields other than id, paths and message: ${extra.slice(0, 5).map(q).join(', ')}`;
  if (r.id !== id) return 'the id differs from the name of the request file';
  if (typeof r.message !== 'string' || !r.message.trim()) return 'message is not a non-empty string';
  if (r.message.includes('\0')) return 'a NUL in the message';
  if (!Array.isArray(r.paths)) return 'paths is not an array';
  if (!r.paths.length) return 'paths is empty';
  if (r.paths.length > MAX_PATHS) return `more than ${MAX_PATHS} paths`;
  const seen = new Set();
  for (const p of r.paths) {
    const why = pathProblem(p);
    if (why) return why;
    const k = p.toLowerCase();
    if (seen.has(k)) return `${q(p)}: a duplicate path`;
    seen.add(k);
  }
  return null;
}

const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const which = (bin, envPath) => {
  for (const d of String(envPath || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
};

// o: {task, callId, wt, branch, box, stateDir, git?, gitVersions?, author?, userEnv?, pollMs?, watch?, inject?, log?}.
// Returns {box, answers, notes(), close()}; close() ends the call: the requests still in the box are cancelled, and
// it returns the summary {commits, refused, nothing, cancelled, notes}. Throws only on arguments of the caller.
function openCommitService(o) {
  const bad = (m) => { throw new Error(`commit-service: ${m}`); };
  for (const k of ['task', 'callId']) if (typeof o[k] !== 'string' || !SEGMENT_RE.test(o[k]) || o[k] === '.' || o[k] === '..') bad(`${k} must be a plain name, got ${q(o[k])}`);
  for (const k of ['wt', 'box', 'stateDir']) if (typeof o[k] !== 'string' || !path.isAbsolute(o[k])) bad(`${k} must be an absolute path`);
  if (typeof o.branch !== 'string' || !o.branch || /[\0\n]/.test(o.branch)) bad('branch is required');
  const userEnv = o.userEnv || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const inject = o.inject || {};
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : POLL_MS;
  const notes = [];
  const note = (m) => { if (notes.length < NOTES_MAX) notes.push(m); else if (notes.length === NOTES_MAX) notes.push('later notes dropped'); log(`commit-service ${o.task}/${o.callId}: ${m}`); };
  const once = new Set();
  const noteOnce = (k, m) => { if (!once.has(k)) { once.add(k); note(m); } };
  const sum = { commits: [], refused: [], nothing: [], cancelled: [] };

  // ---- the adapter's folders (outside the role's roots: role-exec.js refuses a stateDir under them)
  const stateDir = path.resolve(o.stateDir);
  const taskDir = path.join(stateDir, o.task);
  const callDir = path.join(taskDir, 'calls', o.callId);
  const answers = path.join(callDir, 'answers');
  const privIndex = path.join(callDir, 'index');
  const hooksOff = path.join(stateDir, '.adapter', 'hooks-off');
  const gitHome = path.join(stateDir, '.adapter', 'home');
  const emptyWt = path.join(stateDir, '.adapter', 'worktree');
  for (const d of [answers, hooksOff, gitHome, emptyWt]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(hooksOff)) fs.rmSync(path.join(hooksOff, n), { recursive: true, force: true });
  for (const n of fs.readdirSync(emptyWt)) fs.rmSync(path.join(emptyWt, n), { recursive: true, force: true });
  // the box: made by the adapter at the start of the call; the role writes requests into it
  try { fs.mkdirSync(o.box); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!fs.lstatSync(o.box).isDirectory()) bad(`the box ${o.box} is not a folder`);
  const boxReal = fs.realpathSync(o.box);

  let broken = null; // the reason every request is refused with
  const breakWith = (why) => { if (!broken) { broken = why; note(why); } };
  if (process.platform !== 'darwin') breakWith(`the box cannot be read safely on ${process.platform} (O_NOFOLLOW_ANY is macOS only): the commit channel is closed`);

  // ---- git: the binary, its version, the environment of the commit
  let gitBin = null;
  if (o.git !== undefined) { if (typeof o.git === 'string' && path.isAbsolute(o.git)) gitBin = o.git; else breakWith('commit.git must be an absolute path'); }
  else gitBin = which('git', userEnv.PATH);
  if (!gitBin) breakWith('git not found in the PATH of the adapter');
  let gitDir = null, commonDir = null, wtReal = null, ident = null;
  try { wtReal = fs.realpathSync(o.wt); } catch (e) { breakWith(`the worktree ${o.wt}: ${e.code || e.message}`); }
  const SAFE_C = ['-c', `core.hooksPath=${hooksOff}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false', '-c', 'core.splitIndex=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never'];
  const baseEnv = () => ({ PATH: SAFE_PATH, HOME: gitHome, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' });
  const run = (args, x) => {
    const e = x || {};
    const p = spawnSync(gitBin, (e.noSafe ? [] : SAFE_C).concat(args), { cwd: e.cwd || emptyWt, env: e.env, input: e.input, maxBuffer: 1024 * 1024 * 1024, timeout: 120000 });
    return { rc: p.status, out: p.stdout ? p.stdout.toString('utf8') : '', err: (p.stderr ? p.stderr.toString('utf8') : '') + (p.error ? ` ${p.error.code || p.error.message}` : '') };
  };
  // a command of the commit: GIT_DIR of the worktree, the empty work tree of the adapter, an index of its choice
  const g = (args, x) => {
    const e = Object.assign({}, x || {});
    e.env = Object.assign(baseEnv(), { GIT_DIR: gitDir, GIT_WORK_TREE: emptyWt, GIT_INDEX_FILE: e.index || privIndex }, ident || {});
    return run(args, e);
  };
  // a read of the user's config as the user's own git sees it (hooks, identity); git config runs nothing
  const userConfig = (args) => {
    const env = { PATH: SAFE_PATH, LANG: 'C', LC_ALL: 'C', GIT_DIR: gitDir, GIT_WORK_TREE: wtReal, GIT_NO_LAZY_FETCH: '1' };
    for (const [k, v] of Object.entries(userEnv)) if (USER_CONFIG_KEYS.test(k) && typeof v === 'string') env[k] = v;
    return run(['-c', 'core.fsmonitor=false', 'config'].concat(args), { env, cwd: wtReal, noSafe: true });
  };
  const errText = (r) => r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
  // the git dir of the worktree as its .git names it, by the git of the adapter
  const discover = () => {
    const env = baseEnv();
    const a = run(['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'], { cwd: wtReal, env });
    if (a.rc !== 0) return { error: errText(a) || `rev-parse rc ${a.rc}` };
    const [gd, cd] = a.out.trim().split('\n');
    return { gitDir: gd, commonDir: cd };
  };
  if (!broken) {
    const v = run(['--version'], { env: baseEnv(), noSafe: true });
    const ver = (/(\d+\.\d+\.\d+)/.exec(v.out) || [])[1];
    const allowed = Array.isArray(o.gitVersions) ? o.gitVersions : VERIFIED_GIT_VERSIONS;
    if (v.rc !== 0 || !ver) breakWith(`git --version failed (rc ${v.rc})`);
    else if (!allowed.includes(ver)) breakWith(`git ${ver} is not among the verified versions (${allowed.join(', ')}): the recipe of the safe commit is checked per version`);
  }
  if (!broken) {
    const d = discover();
    if (d.error) breakWith(`the worktree ${o.wt} is not a git worktree: ${d.error}`);
    else { gitDir = d.gitDir; commonDir = d.commonDir; }
  }
  if (!broken) {
    // the identity: commit.author of the config, else user.name and user.email of the user's config (G8)
    if (o.author && typeof o.author.name === 'string' && o.author.name && typeof o.author.email === 'string' && o.author.email) {
      ident = { GIT_AUTHOR_NAME: o.author.name, GIT_AUTHOR_EMAIL: o.author.email, GIT_COMMITTER_NAME: o.author.name, GIT_COMMITTER_EMAIL: o.author.email };
    } else {
      const nm = userConfig(['--get', 'user.name']).out.trim(), em = userConfig(['--get', 'user.email']).out.trim();
      if (!nm || !em) breakWith('no identity: user.name and user.email are not in the user\'s git config (or set commit.author)');
      else ident = { GIT_AUTHOR_NAME: nm, GIT_AUTHOR_EMAIL: em, GIT_COMMITTER_NAME: nm, GIT_COMMITTER_EMAIL: em };
    }
  }
  const ref = `refs/heads/${o.branch}`;
  if (!broken && g(['check-ref-format', ref]).rc !== 0) breakWith(`branch ${q(o.branch)} is not a valid branch name`);
  const tipNow = () => { const r = g(['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.rc === 0 ? r.out.trim() : null; };

  // ---- the journal: one writer, numbered lines, fsync before every action
  fs.mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const jFile = path.join(taskDir, 'commits.jsonl');
  const lockFile = path.join(taskDir, 'journal.lock');
  const token = crypto.randomBytes(8).toString('hex');
  let writer = false, jfd = null, lastN = 0;
  const ids = new Map(); // id -> {hash, result?, intent?, intentCommit?}
  if (!broken) {
    for (let i = 0; i < 2 && !writer; i++) {
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, call: o.callId }) + '\n', { flag: 'wx', mode: 0o600 });
        writer = true;
      } catch (e) {
        if (e.code !== 'EEXIST') { breakWith(`the journal lock ${lockFile}: ${e.code || e.message}`); break; }
        let held = null;
        try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* unreadable: taken as dead */ }
        if (held && Number.isInteger(held.pid) && pidAlive(held.pid)) { breakWith(`another adapter (pid ${held.pid}, call ${q(held.call)}) writes the journal of task ${o.task}`); break; }
        note(`the journal lock of a dead adapter (${held ? `pid ${held.pid}` : 'unreadable'}) is taken over`);
        fs.rmSync(lockFile, { force: true });
      }
    }
  }
  if (writer) {
    let text = '';
    try { text = fs.readFileSync(jFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') breakWith(`the journal ${jFile}: ${e.code}`); }
    const lines = text.split('\n');
    const tail = lines.pop();
    if (tail) {
      const kept = path.join(taskDir, `commits.torn-${Date.now()}.txt`);
      fs.writeFileSync(kept, tail);
      fs.truncateSync(jFile, Buffer.byteLength(text) - Buffer.byteLength(tail));
      note(`the last line of the journal was torn (no line end): cut off and kept in ${kept}; its step is not taken as done`);
    }
    for (let i = 0; i < lines.length && !broken; i++) {
      let e = null;
      try { e = JSON.parse(lines[i]); } catch { /* below */ }
      if (!e || typeof e !== 'object' || e.v !== JOURNAL_VERSION || e.n !== i + 1 || typeof e.ev !== 'string') { breakWith(`the journal ${jFile} is damaged at line ${i + 1}: recovery refused (the coordinator decides)`); break; }
      lastN = e.n;
      if (!e.id) continue;
      const s = ids.get(e.id) || {};
      if (e.ev === 'intent') { s.hash = e.hash; s.intent = e; }
      else if (e.ev === 'intent-commit') s.intentCommit = e;
      else if (e.ev === 'result') { s.result = e; if (s.hash === undefined) s.hash = e.hash; }
      else if (e.ev === 'undetermined') s.undetermined = e;
      else if (e.ev === 'resolved') s.undetermined = null;
      ids.set(e.id, s);
    }
    if (!broken) { try { jfd = fs.openSync(jFile, 'a', 0o600); } catch (e) { breakWith(`the journal ${jFile}: ${e.code || e.message}`); } }
  }
  const append = (ev) => {
    if (!jfd) throw new Error('the journal is not open');
    const line = JSON.stringify(Object.assign({ v: JOURNAL_VERSION, n: lastN + 1, ts: new Date().toISOString(), call: o.callId }, ev)) + '\n';
    fs.writeSync(jfd, line);
    fs.fsyncSync(jfd);
    lastN++;
    const s = ids.get(ev.id) || {};
    if (ev.ev === 'intent') { s.hash = ev.hash; s.intent = ev; }
    else if (ev.ev === 'intent-commit') s.intentCommit = ev;
    else if (ev.ev === 'result') { s.result = ev; if (s.hash === undefined) s.hash = ev.hash; }
    else if (ev.ev === 'undetermined') s.undetermined = ev;
    if (ev.id) ids.set(ev.id, s);
  };
  const indexLines = (entries) => Buffer.from(entries.map((x) => `${x.mode} ${x.blob}\t${x.path}\0`).join(''), 'utf8');
  const syncRealIndex = (entries) => {
    const r = g(['update-index', '-z', '--index-info'], { index: path.join(gitDir, 'index'), input: indexLines(entries) });
    return r.rc === 0 ? null : errText(r) || `rc ${r.rc}`;
  };
  // recovery of an intent without a result (the adapter died between the steps)
  if (writer && !broken) {
    const tip = tipNow();
    for (const [id, s] of ids) {
      if (s.undetermined) { breakWith(`the commit step of request ${id} is undetermined (the tip ${s.undetermined.tip} is neither ${s.undetermined.sha} nor ${s.undetermined.old}): only the coordinator's resolve clears it`); continue; }
      if (!s.intent || s.result) continue;
      const ic = s.intentCommit;
      if (ic && tip === ic.sha) {
        const why = syncRealIndex(s.intent.entries || []);
        append({ ev: 'result', id, hash: s.hash, status: 'committed', sha: ic.sha, paths: s.intent.paths, recovered: true, indexSync: why ? 'failed' : 'ok' });
        note(`request ${id}: the adapter died after update-ref; the tip is its commit ${ic.sha}: committed${why ? `, the index sync failed: ${why}` : ''}`);
      } else if (!ic || tip === ic.old) {
        append({ ev: 'result', id, hash: s.hash, status: 'refused', why: 'interrupted: the adapter died before the branch moved; nothing was committed', recovered: true });
        note(`request ${id}: interrupted before the branch moved: refused`);
      } else {
        append({ ev: 'undetermined', id, sha: ic.sha, old: ic.old, tip });
        breakWith(`the commit step of request ${id} is undetermined (the tip ${tip} is neither ${ic.sha} nor ${ic.old}): only the coordinator's resolve clears it`);
      }
    }
  }
  let expected = broken ? null : tipNow();
  if (!broken && !expected) breakWith(`branch ${o.branch} does not exist in the worktree's repository`);

  // ---- requests
  const writeAnswer = (id, res) => {
    const tmp = path.join(answers, `.${id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, res)) + '\n', { mode: 0o644 });
    fs.renameSync(tmp, path.join(answers, `${id}.json`));
  };
  const publicOf = (r) => {
    const a = { status: r.status };
    for (const k of ['sha', 'why', 'paths', 'indexSync']) if (r[k] !== undefined) a[k] = r[k];
    return a;
  };
  const local = new Map(); // id -> result, for the calls that may not write the journal
  const finish = (id, hash, res) => {
    const r = Object.assign({ status: res.status }, res);
    if (writer && !broken) append(Object.assign({ ev: 'result', id, hash }, r));
    else local.set(id, Object.assign({ hash }, r));
    if (r.status === 'committed') sum.commits.push({ id, sha: r.sha, paths: r.paths });
    else if (r.status === 'refused') sum.refused.push({ id, why: r.why });
    else if (r.status === 'nothing') sum.nothing.push(id);
    else if (r.status === 'cancelled') sum.cancelled.push(id);
    writeAnswer(id, publicOf(r));
  };
  const preflight = () => {
    const d = discover();
    if (d.error) return `the git dir of the worktree cannot be found: ${d.error}`;
    if (d.gitDir !== gitDir) return `the git dir of the worktree changed (${d.gitDir}, was ${gitDir} at the start of the call)`;
    if (exists(path.join(gitDir, 'index.lock'))) return `index.lock exists in ${gitDir}: another git process holds the index`;
    const h = g(['symbolic-ref', '-q', 'HEAD']);
    if (h.rc !== 0 || h.out.trim() !== ref) return `HEAD of the worktree is not ${ref} (${h.rc === 0 ? h.out.trim() : 'detached'})`;
    const tip = tipNow();
    if (tip !== expected) return `branch moved outside the adapter: expected ${expected}, found ${tip}`;
    const ix = g(['diff-index', '--cached', '--quiet', tip, '--'], { index: path.join(gitDir, 'index') });
    if (ix.rc === 1) return 'the index of the worktree differs from HEAD (changed outside the adapter)';
    if (ix.rc !== 0) return `the index of the worktree cannot be compared with HEAD: ${errText(ix)}`;
    return null;
  };
  // hooks of a check that the user's git would run for a commit; null when there are none
  const hooksProblem = () => {
    const named = userConfig(['--get-regexp', '^hook\\.']);
    if (named.rc === 0 && named.out.trim()) return `hooks named in the git config (${named.out.trim().split('\n')[0].split(' ')[0]})`;
    const hp = userConfig(['--get-all', 'core.hooksPath']);
    if (hp.rc !== 0 && hp.rc !== 1) return `core.hooksPath cannot be read: ${errText(hp)}`;
    const dirs = [path.join(commonDir, 'hooks')];
    for (const v of hp.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (v === '~' || v.startsWith('~/')) dirs.push(path.join(userEnv.HOME || '/nonexistent', v.slice(1)));
      else if (v.startsWith('~')) return `core.hooksPath ${q(v)} cannot be resolved`;
      else dirs.push(path.resolve(wtReal, v));
    }
    const found = [];
    for (const d of dirs) for (const h of CHECK_HOOKS) {
      const f = path.join(d, h);
      try { if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); found.push(f); } } catch { /* absent or not executable: git skips it */ }
    }
    return found.length ? `the repository has hooks of a check (${found.slice(0, 3).join(', ')})` : null;
  };

  const processRequest = (id, hash, r) => {
    let intentCommit = null;
    try {
      const pre = preflight();
      if (pre) return finish(id, hash, { status: 'refused', why: pre });
      const hk = hooksProblem();
      if (hk) return finish(id, hash, { status: 'refused', why: `no safe check path: ${hk}; checks inside the role's sandbox come with part A2a-2` });
      const parent = expected;
      const head = new Map();
      const ls = g(['ls-tree', '-z', parent, '--'].concat(r.paths));
      if (ls.rc !== 0) return finish(id, hash, { status: 'refused', why: `ls-tree: ${errText(ls)}` });
      for (const rec of ls.out.split('\0').filter(Boolean)) {
        const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
        if (m) head.set(m[4], { mode: m[1], type: m[2] });
      }
      const entries = [];
      for (const p of r.paths) {
        const h = head.get(p);
        if (h && h.type !== 'blob') return finish(id, hash, { status: 'refused', why: `${q(p)}: a ${h.type === 'commit' ? 'submodule' : 'folder'} in HEAD (name its files)` });
        const f = readNoFollow(path.join(wtReal, p), MAX_FILE_BYTES);
        if (f.code === 'ENOENT') {
          if (!h) return finish(id, hash, { status: 'refused', why: `${q(p)}: not tracked and missing` });
          entries.push({ mode: '0', blob: ZERO, path: p });
          continue;
        }
        if (f.error) return finish(id, hash, { status: 'refused', why: `${q(p)}: ${f.error}` });
        const b = g(['hash-object', '-w', '--stdin', '--no-filters'], { input: f.bytes });
        if (b.rc !== 0) return finish(id, hash, { status: 'refused', why: `hash-object ${q(p)}: ${errText(b)}` });
        entries.push({ mode: f.st.mode & 0o100 ? '100755' : '100644', blob: b.out.trim(), path: p });
      }
      if (inject.afterSnapshot) inject.afterSnapshot({ id, entries });
      fs.rmSync(privIndex, { force: true });
      const rt = g(['read-tree', parent]);
      if (rt.rc !== 0) return finish(id, hash, { status: 'refused', why: `read-tree: ${errText(rt)}` });
      const ui = g(['update-index', '-z', '--index-info'], { input: indexLines(entries) });
      if (ui.rc !== 0) return finish(id, hash, { status: 'refused', why: `update-index: ${errText(ui)}` });
      const wtree = g(['write-tree']);
      if (wtree.rc !== 0) return finish(id, hash, { status: 'refused', why: `write-tree: ${errText(wtree)}` });
      const tree = wtree.out.trim();
      const ptree = g(['rev-parse', `${parent}^{tree}`]).out.trim();
      if (tree === ptree) return finish(id, hash, { status: 'nothing' });
      append({ ev: 'intent', id, hash, paths: r.paths, parent, tree, ref, entries });
      const ct = g(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-F', '-'], { input: Buffer.from(r.message, 'utf8') });
      if (ct.rc !== 0) return finish(id, hash, { status: 'refused', why: `commit-tree: ${errText(ct)}` });
      const sha = ct.out.trim();
      append({ ev: 'intent-commit', id, sha, old: parent });
      intentCommit = { sha, old: parent };
      if (inject.beforeUpdateRef) inject.beforeUpdateRef({ id, sha, old: parent });
      const ur = g(['update-ref', '-m', `codis-agents commit ${id}`, ref, sha, parent]);
      if (ur.rc !== 0) {
        intentCommit = null;
        return finish(id, hash, { status: 'refused', why: `branch moved outside the adapter (update-ref with the old value failed): ${errText(ur)}` });
      }
      if (inject.afterUpdateRef) inject.afterUpdateRef({ id, sha, old: parent });
      expected = sha;
      intentCommit = null;
      if (inject.beforeIndexSync) inject.beforeIndexSync({ id, sha });
      const why = syncRealIndex(entries);
      if (why) note(`request ${id}: committed ${sha}, the index sync failed: ${why}`);
      return finish(id, hash, Object.assign({ status: 'committed', sha, paths: r.paths }, why ? { indexSync: 'failed' } : {}));
    } catch (e) {
      // a step threw after commit-tree: the tip tells whether the branch moved
      if (intentCommit) {
        const tip = tipNow();
        if (tip === intentCommit.sha) { expected = tip; return finish(id, hash, { status: 'committed', sha: tip, paths: r.paths, indexSync: 'failed' }); }
      }
      return finish(id, hash, { status: 'refused', why: `internal error: ${String(e && e.message).slice(0, 300)}` });
    }
  };

  const reused = new Set();
  const handle = (c, closing) => {
    const hash = c.r.bytes ? sha256(c.r.bytes) : `error:${c.r.code}`;
    const known = ids.get(c.id);
    const done = (known && known.result) || local.get(c.id);
    if (done) {
      const h = known && known.result ? known.hash : done.hash;
      if (h !== hash && !reused.has(c.id + hash)) {
        reused.add(c.id + hash);
        if (writer && !broken) append({ ev: 'refused-reuse', id: c.id, hash });
        note(`request ${c.id}: the same id with other content: refused, its first result stands`);
      }
      if (!exists(path.join(answers, `${c.id}.json`))) writeAnswer(c.id, publicOf(done));
      return;
    }
    if (closing) return finish(c.id, hash, { status: 'cancelled', why: 'the call ended before the request was processed' });
    if (c.r.error) return finish(c.id, hash, { status: 'refused', why: `the request file: ${c.r.error}` });
    if (broken) return finish(c.id, hash, { status: 'refused', why: broken });
    let r = null;
    try { r = JSON.parse(c.r.bytes.toString('utf8')); } catch { return finish(c.id, hash, { status: 'refused', why: 'the request is not JSON' }); }
    const why = requestProblem(r, c.id);
    if (why) return finish(c.id, hash, { status: 'refused', why });
    return processRequest(c.id, hash, r);
  };

  let closed = false;
  const scan = (closing) => {
    if (closed) return;
    let names;
    try {
      if (!fs.lstatSync(o.box).isDirectory()) { noteOnce('box', `the box ${o.box} is no longer a folder: its requests are not read`); return; }
      names = fs.readdirSync(boxReal);
    } catch (e) { noteOnce('box', `the box ${o.box} cannot be listed (${e.code || e.message})`); return; }
    const cands = [];
    for (const name of names) {
      const m = NAME_RE.exec(name);
      if (!m) {
        if (!name.startsWith('.') && !name.endsWith('.tmp')) noteOnce(`n:${name}`, `ignored in the box (not <32 hex>.json): ${q(name)}`);
        continue;
      }
      const r = readNoFollow(path.join(boxReal, name), MAX_REQUEST_BYTES);
      cands.push({ id: m[1], r, birth: r.st ? r.st.birthtimeMs : 0 });
    }
    cands.sort((a, b) => a.birth - b.birth || (a.id < b.id ? -1 : 1));
    for (const c of cands) {
      try { handle(c, closing); } catch (e) { note(`request ${c.id}: ${String(e && e.message).slice(0, 300)}`); }
    }
  };
  let kicked = false;
  const kick = () => { if (kicked || closed) return; kicked = true; setImmediate(() => { kicked = false; scan(false); }); };
  let watcher = null;
  try {
    watcher = (o.watch || fs.watch)(boxReal, () => kick());
    if (watcher && typeof watcher.on === 'function') {
      watcher.on('error', (e) => {
        note(`fs.watch of the box failed (${e.code || e.message}): polling the box every ${pollMs} ms`);
        try { watcher.close(); } catch { /* closed */ }
        watcher = null;
      });
    }
  } catch (e) {
    note(`fs.watch unavailable (${e.code || e.message}): polling the box every ${pollMs} ms`);
    watcher = null;
  }
  const timer = setInterval(() => scan(false), pollMs);
  if (timer.unref) timer.unref();
  scan(false);

  return {
    box: o.box,
    answers,
    notes: () => notes.slice(),
    close() {
      if (closed) return Object.assign({}, sum, { notes: notes.slice() });
      clearInterval(timer);
      if (watcher) { try { watcher.close(); } catch { /* closed */ } }
      scan(true);
      closed = true;
      if (jfd !== null) { try { fs.closeSync(jfd); } catch { /* closed */ } }
      if (writer) {
        try { const held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (held.token === token) fs.rmSync(lockFile, { force: true }); } catch { /* gone */ }
      }
      return Object.assign({}, sum, { notes: notes.slice() });
    },
  };
}

module.exports = { openCommitService, readNoFollow, pathProblem, requestProblem, VERIFIED_GIT_VERSIONS, MAX_REQUEST_BYTES, POLL_MS, JOURNAL_VERSION };
