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
//
// The checks (owner 2026-11-06, answers 1 to 6 and G7; owner 2026-11-07 on the walk): the hooks of a check (pre-commit,
// prepare-commit-msg, commit-msg) are taken from the folder the user's git would use - the last core.hooksPath (a
// relative one from the worktree root, ~ from the user's HOME), else <common git dir>/hooks; a hook.* key is refused.
// Without such hooks the request is committed as above and nothing of the worktree outside it is looked at.
// On both paths the named paths are checked against the recorded tip H0 and the file system: a path inside a gitlink or
// under a tracked file is refused, so is another spelling of a tracked entry (the same dev and inode, and one name in
// the listing of the folder: a hard link has two names and is another path), and an untracked ignored path.
// With hooks, before any hook:
// - U0, the walk of the worktree (scripts/commit-walk.js, a process of its own under limits; any limit refuses and the
//   hooks do not run): every non-folder entry outside the tracked paths and the request, with (type, dev, ino, size,
//   mode, mtime, ctime) - any write changes ctime - and its class by the ignore rules (a mirror of every .gitignore and
//   git check-ignore, no git command reads the worktree), and every folder it cannot look into, with (dev, ino, mode,
//   mtime, ctime) and no class. untrackedInputs lists the files not ignored and every untracked .gitignore, whose rules
//   could hide the rest.
// - G7: every tracked path of H0 outside the request is compared by Node (an O_NOFOLLOW_ANY read, the bytes hashed as
//   a blob) and the real index against H0 (diff-index --cached); any difference refuses the request with the whole
//   list (modified, deleted, typechange, mode, staged). A deleted path whose blob equals an untracked file (not
//   empty, same size, same kind) is named renamed, with every such file; an ignored one is only a note on deleted. A
//   gitlink outside the request is not compared. A path with raw bytes different from its blob and a conversion by the
//   attributes of H0 (check-attr --source=H0) or core.autocrlf is hashed through git's conversion inside the sandbox,
//   so a filter of the repository never runs outside it; codex is verified and probed before that first launch, and
//   the keys of the user's config that conversion reads go there as -c arguments, not through the environment.
// - A named path with a conversion is refused with its path: the commit stores the bytes Node read (--no-filters).
// Each hook runs as `codex sandbox` with a profile of the role's rights - write to the worktree, the task folder
// and a message folder of the adapter (owner c4), read only <wt>/.git and <wt>/.codex, the network of the role given
// explicitly - in a process group of its own (spawn, never spawnSync: the adapter's loop goes on), cwd the worktree,
// GIT_INDEX_FILE the private index (outside every root: a hook cannot change it), an environment built from a white
// list (PATH with the adapter's node and git, a new empty home per launch as HOME and CODEX_HOME - outside the write
// roots, so a tool that keeps its state there, such as the slot directory of heavy.sh, fails -, the role's TMPDIR,
// LANG, LC_ALL, npm_config_cache of the call, which must resolve inside the worktree or the task folder and never
// adds a root of its own), its output into a file of the answers. The end of a hook is the exit of
// its leader; the rest of its group is killed then. Before the first launch of a call, once: codex of a verified version
// (VERIFIED_CODEX_VERSIONS) and a probe of the sandbox with the same command (a write outside the roots refused, the
// npm cache writable, the network as the role's, CODEX_SANDBOX=seatbelt and no variable outside the white list);
// anything else refuses with "no safe check path" and nothing runs outside the sandbox.
// After the hooks of a pass: the tree of the private index, the git dir, HEAD and the tip are as recorded, the tracked
// paths outside the request and the real index are compared with H0 again, and the walk is compared with the walk
// before the pass, each path classed by the ignore rules before the pass (a hook cannot hide its writes with a new
// .gitignore, and a changed untracked .gitignore is a change whatever its class). Any of that refuses; changes of
// ignored files are only listed (ignoredChanged). A named path or the message that changed (the message compared after
// git stripspace) gives one re-check (owner answer 1): a new snapshot, and the hooks again on it; a tree equal to the
// parent's is "nothing"; a second change refuses "the check is not stable". An empty message after a pass refuses.
// Nothing is rolled back or added after a refusal: the worktree stays as the check left it. The commit gets the tree
// and the message of the last pass. Lists in an answer are cut to the first LIST_SHOWN entries with a count, and the
// notes of those entries to LIST_SHOWN paths in all; the whole lists go to <id>.changes.json in the answers, and the
// journal holds only the counts. The JSON of the rename pairs and of the whole lists is bounded by the volume of results
// (commit.walkMaxResultBytes): pairs above it refuse "no safe check path" before they are built; lists above it, or a
// file that cannot be written, leave no file and a changesFileError in the answer, and change no status: the status is
// decided by the step that got it, and a request has one result, so a request whose branch moved is always committed.
// An answer that cannot be written (a full disk) waits for the poll of the box, which writes it from the result while
// the request lies there, and the same id in a later call gets it from the journal. Untracked and ignored files of
// the worktree, and any file outside it, can influence a check and are not part of the commit (README, Known gaps).
//
// The journal of the task (<stateDir>/<task>/commits.jsonl, owner B 2026-11-06 answers 12, 13): one writer (a lock
// with the pid), version 1, an event number per line, every line written and fsynced before the action it announces:
// intent (tree and parent) before commit-tree, intent-commit (sha and old tip) before update-ref, then the result. A
// torn last line is cut off, kept beside the journal and named in the notes, and its step is not taken as done; a
// damaged line inside refuses every request. On open, an intent without a result is settled by the tip of the branch:
// the intended sha -> committed; the old tip or no sha yet -> refused "interrupted"; anything else -> undetermined,
// and every request of the task is refused until the coordinator resolves it. A line that cannot be written whole is
// cut back, so the journal keeps ending on a whole line. A result line that cannot be written leaves its status in the
// memory of the call, where the same id still gets it; if the request has an intent, the rest of the call is refused,
// because a later commit would move the tip past that intent and the next open could not settle it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const O_NOFOLLOW_ANY = 0x20000000; // macOS <sys/fcntl.h>: no symbolic link in any component of the path
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW_ANY;
// the same open of a named path that may itself be a link: the link opens as itself (measured on macOS: fstat says link)
const READ_ENTRY_FLAGS = READ_FLAGS | (fs.constants.O_SYMLINK || 0);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PATHS = 1000;
const POLL_MS = 1000;
const JOURNAL_VERSION = 1;
// git versions on which the recipe was checked against a hostile config (hooks, fsmonitor, filters, signing, include,
// a promisor remote, inherited variables); another version refuses until it is checked (cfg.commit.gitVersions).
const VERIFIED_GIT_VERSIONS = ['2.50.0'];
const CHECK_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];
// codex versions whose sandbox was checked for the profile of a check (cfg.commit.codexVersions)
const VERIFIED_CODEX_VERSIONS = ['0.166.0'];
const CHECK_PROFILE = 'codis-check';
// the pause between SIGTERM and SIGKILL of a check's group when the call ends (owner answer 2 of part A1)
const KILL_GRACE_MS = 30 * 1000;
const TAIL_CHARS = 4000;
// the variables codex sandbox 0.166.0 adds to the white list of the adapter (experiment E-A4)
const CODEX_ADDED = ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'];
const CONVERSION_ATTRS = ['text', 'eol', 'filter', 'crlf', 'ident', 'working-tree-encoding'];
// The keys of the user's config that git's conversion reads: a check has an empty home, so they go as -c arguments.
const CONVERSION_CONFIG = '^(filter\\.|core\\.(autocrlf|eol|safecrlf|attributesfile)$)';
const WALKER = path.join(__dirname, 'commit-walk.js');
// The limits of one walk process (owner 2026-11-07: 200 000 entries visited, 15 s; commit.walk* keys). Measured on the
// owner's worktree (48 250 entries, 1.3 s, RSS 163 MB): 231 bytes of answer per file, so 200 000 files fit into the
// volume of results, and 4 KiB of ignore files; the volumes bound what a role can make the walk hold, the heap
// stops a walk they miss.
const WALK_LIMITS = { entries: 200000, timeoutMs: 15000, resultBytes: 64 * 1024 * 1024, ignoreBytes: 16 * 1024 * 1024, readBytes: 1024 * 1024 * 1024 };
const WALK_HEAP_MB = 1024;
const LIST_SHOWN = 200;
// The entries of a list of changes with the ignored copies of a deleted file as a note. The notes share an allowance of
// paths, so the size of an answer does not grow with the number of copies.
const withCopyNotes = (list, allowance) => {
  let room = allowance;
  return list.map(({ ignoredCopies: copies, ...c }) => {
    if (!copies) return c;
    const n = Math.min(copies.length, room);
    room -= n;
    const shown = copies.slice(0, n).join(', ');
    const note = n === copies.length ? `the same content at the ignored path ${shown}`
      : n ? `the same content at the ignored path ${shown} and ${copies.length - n} more (the whole list in changesFile)`
        : `the same content at ${copies.length} ignored paths (the whole list in changesFile)`;
    return Object.assign(c, { note });
  });
};
const LIST_KEYS = ['changed', 'untrackedInputs', 'ignoredChanged', 'walkNotes'];
const jsonBytes = (x) => Buffer.byteLength(JSON.stringify(x));
const sumJsonBytes = (paths) => paths.reduce((n, p) => n + jsonBytes(p), 0);
// The JSON of one entry of a list and its comma, without the paths: a path counts by its own JSON, whose quotes also
// cover the separator of a path inside a note.
const PAIR_BYTES = jsonBytes({ kind: 'renamed', from: '', path: '' }) - 4 + 1;
const NOTE_BYTES = jsonBytes({ path: '', kind: 'deleted', note: 'the same content at the ignored path ' }) - 2 + 1;
const isIgnoreFile = (p) => /(^|\/)\.gitignore$/i.test(p);
// The probe of the sandbox, run inside it: argv canary, npm cache, port of the adapter's listener; one JSON line.
const PROBE_JS = "const fs=require('fs'),net=require('net');const [canary,cache,port]=process.argv.slice(1);const o={};"
  + "try{fs.writeFileSync(canary,'x');o.canary='written';}catch(e){o.canary=e.code||'error';}"
  + "try{fs.mkdirSync(cache,{recursive:true});const f=cache+'/.codis-probe';fs.writeFileSync(f,'x');fs.unlinkSync(f);o.cache='ok';}catch(e){o.cache=e.code||'error';}"
  + "o.sandbox=process.env.CODEX_SANDBOX||null;o.names=Object.keys(process.env);"
  + "const out=()=>process.stdout.write(JSON.stringify(o)+'\\n');"
  + "const s=net.connect(+port,'127.0.0.1');s.on('connect',()=>{o.net='connected';s.destroy();out();});s.on('error',(e)=>{o.net=e.code||'error';out();});";
const HASH_BATCH = 200; // paths of one launch of a hash inside the sandbox
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

// A named path: {bytes, st} of a regular file or {link, st} of a symbolic link (its text, never its target), else
// {error, code}. A link in a parent fails the open; the link read by path is compared with the one opened.
function readEntry(file, max) {
  let fd;
  try { fd = fs.openSync(file, READ_ENTRY_FLAGS); } catch (e) {
    if (e.code === 'ELOOP') return { code: 'ELOOP', error: 'a component of the path is a symbolic link' };
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { code: 'ENOENT', error: 'missing' };
    return { code: e.code || 'EOPEN', error: `cannot open (${e.code || e.message})` };
  }
  let st;
  try { st = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
  if (!st.isSymbolicLink()) return readNoFollow(file, max);
  try {
    const link = fs.readlinkSync(file, 'buffer');
    const again = fs.lstatSync(file);
    if (!again.isSymbolicLink() || again.ino !== st.ino || again.dev !== st.dev) return { code: 'RACE', error: 'replaced while it was read' };
    return { link, st };
  } catch (e) { return { code: e.code || 'EREAD', error: `cannot read (${e.code || e.message})` }; }
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

// o: {task, callId, wt, branch, box, stateDir, git?, gitVersions?, author?, userEnv?, pollMs?, watch?, inject?, log?,
// codex?, codexVersions?, network?, tdir?, npmCache?, killGraceMs?} - codex: the binary (a name looked up in the
// PATH of userEnv, default "codex"); network: the network of the role, given to its checks; tdir: the task folder,
// a write root of the role and of its checks; npmCache: the npm cache of the call (default <folder of the box>/npm-cache),
// which must resolve inside the worktree or the task folder when a check runs (else the request is refused);
// walkMaxEntries, walkTimeoutMs, walkMaxResultBytes, walkMaxIgnoreBytes, walkMaxReadBytes: the limits of a walk process.
// Returns {box, answers, notes(), cancel(), close()}. Requests run one at a time; cancel() stops a running check
// (SIGTERM to its group, SIGKILL after killGraceMs) and starts no new one; close() ends the call: it cancels the
// running check, waits for it, cancels the requests still queued or in the box, and resolves to the summary
// {commits, refused, nothing, cancelled, notes}. A request past its checks is carried through to its result first.
// Throws on arguments of the caller and when the adapter's own folders or journal cannot be set up (a full disk).
function openCommitService(o) {
  const bad = (m) => { throw new Error(`commit-service: ${m}`); };
  for (const k of ['task', 'callId']) if (typeof o[k] !== 'string' || !SEGMENT_RE.test(o[k]) || o[k] === '.' || o[k] === '..') bad(`${k} must be a plain name, got ${q(o[k])}`);
  for (const k of ['wt', 'box', 'stateDir']) if (typeof o[k] !== 'string' || !path.isAbsolute(o[k])) bad(`${k} must be an absolute path`);
  if (typeof o.branch !== 'string' || !o.branch || /[\0\n]/.test(o.branch)) bad('branch is required');
  const userEnv = o.userEnv || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const inject = o.inject || {};
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : POLL_MS;
  const graceMs = Number.isFinite(o.killGraceMs) && o.killGraceMs > 0 ? o.killGraceMs : KILL_GRACE_MS;
  const network = o.network === true;
  const codexVersions = Array.isArray(o.codexVersions) ? o.codexVersions : VERIFIED_CODEX_VERSIONS;
  for (const k of ['tdir', 'npmCache']) if (o[k] !== undefined && (typeof o[k] !== 'string' || !path.isAbsolute(o[k]))) bad(`${k} must be an absolute path`);
  const walkLimits = Object.assign({}, WALK_LIMITS);
  for (const [k, l] of [['walkMaxEntries', 'entries'], ['walkTimeoutMs', 'timeoutMs'], ['walkMaxResultBytes', 'resultBytes'], ['walkMaxIgnoreBytes', 'ignoreBytes'], ['walkMaxReadBytes', 'readBytes']]) {
    if (o[k] === undefined) continue;
    if (!Number.isFinite(o[k]) || o[k] <= 0) bad(`${k} must be a positive number`);
    walkLimits[l] = o[k];
  }
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
  // the checks: a home per launch, the message file, the probe's canary - in the adapter's folder of the call
  const checkHomes = path.join(callDir, 'check-home');
  const msgRoot = path.join(callDir, 'msg');
  const probeDir = path.join(callDir, 'probe');
  const walkRoot = path.join(callDir, 'walk');
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
  const local = new Map(); // id -> result, when the journal may not or cannot take it
  const journalFailed = (e) => `the journal ${jFile} cannot be written (${e.code || e.message}): requests are refused until the next call, which settles this one from the journal`;
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
    const size = fs.fstatSync(jfd).size;
    try {
      // a write on a full disk may take part of the line without an error
      if (fs.writeSync(jfd, line) !== Buffer.byteLength(line)) throw Object.assign(new Error('ENOSPC: the line was written in part'), { code: 'ENOSPC' });
      fs.fsyncSync(jfd);
    } catch (e) {
      // a later line after a torn one would damage the journal inside; a torn last line is what an open cuts off
      try { fs.ftruncateSync(jfd, size); } catch { breakWith(journalFailed(e)); }
      throw e;
    }
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
    const settle = (id, res) => {
      try { append(Object.assign({ ev: 'result', id }, res)); } catch (e) {
        local.set(id, res);
        breakWith(journalFailed(e));
      }
    };
    for (const [id, s] of ids) {
      if (s.undetermined) { breakWith(`the commit step of request ${id} is undetermined (the tip ${s.undetermined.tip} is neither ${s.undetermined.sha} nor ${s.undetermined.old}): only the coordinator's resolve clears it`); continue; }
      if (!s.intent || s.result) continue;
      const ic = s.intentCommit;
      if (ic && tip === ic.sha) {
        const why = syncRealIndex(s.intent.entries || []);
        settle(id, { hash: s.hash, status: 'committed', sha: ic.sha, paths: s.intent.paths, recovered: true, indexSync: why ? 'failed' : 'ok' });
        note(`request ${id}: the adapter died after update-ref; the tip is its commit ${ic.sha}: committed${why ? `, the index sync failed: ${why}` : ''}`);
      } else if (!ic || tip === ic.old) {
        settle(id, { hash: s.hash, status: 'refused', why: 'interrupted: the adapter died before the branch moved; nothing was committed', recovered: true });
        note(`request ${id}: interrupted before the branch moved: refused`);
      } else {
        // without this line the next open finds the same tip and writes it then
        try { append({ ev: 'undetermined', id, sha: ic.sha, old: ic.old, tip }); } catch { /* the refusal below stands */ }
        breakWith(`the commit step of request ${id} is undetermined (the tip ${tip} is neither ${ic.sha} nor ${ic.old}): only the coordinator's resolve clears it`);
      }
    }
  }
  let expected = broken ? null : tipNow();
  if (!broken && !expected) breakWith(`branch ${o.branch} does not exist in the worktree's repository`);

  // ---- requests
  // Nothing is thrown: the status is decided already, and handle() writes the answer again while the file is missing.
  const writeAnswer = (id, res) => {
    const tmp = path.join(answers, `.${id}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, res)) + '\n', { mode: 0o644 });
      fs.renameSync(tmp, path.join(answers, `${id}.json`));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* only clutter of the adapter */ }
      noteOnce(`answer:${id}`, `request ${id}: the answer ${res.status} could not be written yet (${e.code || e.message}): it is written on a later poll of the box`);
    }
  };
  const publicOf = (r) => {
    const a = { status: r.status };
    for (const k of ['sha', 'why', 'paths', 'indexSync', 'rechecked', 'changesFile', 'changesFileError', 'checks', 'environment']) if (r[k] !== undefined) a[k] = r[k];
    for (const k of LIST_KEYS) for (const n of [k, `${k}Count`]) if (r[n] !== undefined) a[n] = r[n];
    return a;
  };
  // The whole lists in a file of the adapter, at most walkLimits.resultBytes of entries (a string of that size stays below
  // the limit of a string in Node). Published by a rename, so no partial file carries the name. Nothing is thrown: the
  // status of the result is decided already.
  const writeWhole = (id, whole) => {
    const L = walkLimits.resultBytes;
    let bytes = 0;
    for (const list of Object.values(whole)) {
      for (const entry of list) {
        bytes += jsonBytes(entry) + 1;
        if (bytes > L) return { changesFileError: `the whole lists take above ${L} bytes: not written` };
      }
    }
    const file = path.join(answers, `${id}.changes.json`);
    const tmp = path.join(answers, `.${id}.changes.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(whole) + '\n', { mode: 0o644 });
      fs.renameSync(tmp, file);
      return { changesFile: file };
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* only clutter of the adapter */ }
      return { changesFileError: `the whole lists could not be written: ${e.code || e.message}` };
    }
  };
  const finish = (id, hash, res) => {
    const r = Object.assign({ status: res.status }, res);
    // a long list: the first entries and a count in the answer, the whole of it in a file of the adapter; the same for
    // the paths in the notes of the entries shown
    const raw = r.changed;
    if (Array.isArray(raw)) r.changed = withCopyNotes(raw, Infinity);
    const whole = {};
    let cut = false;
    for (const k of LIST_KEYS) {
      if (!Array.isArray(r[k])) continue;
      whole[k] = r[k];
      r[`${k}Count`] = r[k].length;
      if (r[k].length > LIST_SHOWN) { cut = true; r[k] = r[k].slice(0, LIST_SHOWN); }
    }
    if (Array.isArray(raw)) {
      const first = raw.slice(0, LIST_SHOWN);
      r.changed = withCopyNotes(first, LIST_SHOWN);
      if (first.reduce((n, c) => n + (c.ignoredCopies ? c.ignoredCopies.length : 0), 0) > LIST_SHOWN) cut = true;
    }
    if (cut) Object.assign(r, writeWhole(id, whole));
    const line = Object.assign({}, r);
    for (const k of LIST_KEYS) delete line[k];
    if (writer && !broken) {
      try { append(Object.assign({ ev: 'result', id, hash }, line)); } catch (e) {
        local.set(id, Object.assign({ hash }, r));
        const s = ids.get(id);
        if (s && s.intent) breakWith(journalFailed(e));
        else noteOnce(`result:${id}`, `request ${id}: its result ${r.status} is not in the journal (${e.code || e.message}): nothing was committed, a later call takes the id as new`);
      }
    } else local.set(id, Object.assign({ hash }, r));
    if (r.status === 'committed') sum.commits.push({ id, sha: r.sha, paths: r.paths });
    else if (r.status === 'refused') sum.refused.push({ id, why: r.why });
    else if (r.status === 'nothing') sum.nothing.push(id);
    else if (r.status === 'cancelled') sum.cancelled.push(id);
    writeAnswer(id, publicOf(r));
  };
  // HEAD of the worktree on the branch at the expected tip; withIndex: the real index equals the tip too (the path
  // without checks; with checks a staged entry is a line of the G7 list instead)
  const preflight = (withIndex) => {
    const d = discover();
    if (d.error) return `the git dir of the worktree cannot be found: ${d.error}`;
    if (d.gitDir !== gitDir) return `the git dir of the worktree changed (${d.gitDir}, was ${gitDir} at the start of the call)`;
    if (exists(path.join(gitDir, 'index.lock'))) return `index.lock exists in ${gitDir}: another git process holds the index`;
    const h = g(['symbolic-ref', '-q', 'HEAD']);
    if (h.rc !== 0 || h.out.trim() !== ref) return `HEAD of the worktree is not ${ref} (${h.rc === 0 ? h.out.trim() : 'detached'})`;
    const tip = tipNow();
    if (tip !== expected) return `branch moved outside the adapter: expected ${expected}, found ${tip}`;
    if (!withIndex) return null;
    const ix = g(['diff-index', '--cached', '--quiet', tip, '--'], { index: path.join(gitDir, 'index') });
    if (ix.rc === 1) return 'the index of the worktree differs from HEAD (changed outside the adapter)';
    if (ix.rc !== 0) return `the index of the worktree cannot be compared with HEAD: ${errText(ix)}`;
    return null;
  };
  // the hooks folder the user's git would use for a commit and the hooks of a check in it: {dir, hooks} or {error}
  const checkHooks = () => {
    const named = userConfig(['--get-regexp', '^hook\\.']);
    if (named.rc === 0 && named.out.trim()) return { error: `hooks named in the git config (${named.out.trim().split('\n')[0].split(' ')[0]})` };
    const hp = userConfig(['--get-all', 'core.hooksPath']);
    if (hp.rc !== 0 && hp.rc !== 1) return { error: `core.hooksPath cannot be read: ${errText(hp)}` };
    const vals = hp.out.split('\n').map((x) => x.trim()).filter(Boolean);
    let dir = path.join(commonDir, 'hooks');
    if (vals.length) {
      const v = vals[vals.length - 1];
      if (v === '~' || v.startsWith('~/')) dir = path.join(userEnv.HOME || '/nonexistent', v.slice(1));
      else if (v.startsWith('~')) return { error: `core.hooksPath ${q(v)} cannot be resolved` };
      else dir = path.resolve(wtReal, v);
    }
    const hooks = CHECK_HOOKS.filter((h) => {
      const f = path.join(dir, h);
      try { if (!fs.statSync(f).isFile()) return false; fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } // git skips it
    });
    return { dir, hooks };
  };

  // ---- the tree of the recorded tip and the named paths against it
  let treeCache = null;
  // {map: path -> {mode, type, oid}, kids: folder -> names} of a commit, or {error}
  const treeOf = (h0) => {
    if (treeCache && treeCache.h0 === h0) return treeCache;
    const ls = g(['ls-tree', '-r', '-t', '-z', '--full-tree', h0]);
    if (ls.rc !== 0) return { error: `ls-tree: ${errText(ls)}` };
    const map = new Map(), kids = new Map();
    for (const rec of ls.out.split('\0').filter(Boolean)) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
      if (!m) continue;
      map.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
      const cut = m[4].lastIndexOf('/');
      const dir = cut < 0 ? '' : m[4].slice(0, cut);
      if (!kids.has(dir)) kids.set(dir, []);
      kids.get(dir).push(m[4].slice(cut + 1));
    }
    return (treeCache = { h0, map, kids });
  };
  // The reason a named path may not be committed against the tree: a parent that is a gitlink or a tracked file (the
  // commit would drop it from the tree), or another spelling of a tracked entry. The spelling is by the file system,
  // not by folding names: the same dev and inode as a tracked entry of the folder and only one of the two names in the
  // listing of the folder (a hard link has both).
  const namedProblem = (paths, tree) => {
    const inodes = new Map();
    const inodesOf = (dir) => {
      if (inodes.has(dir)) return inodes.get(dir);
      const m = new Map();
      for (const n of tree.kids.get(dir) || []) {
        try { const st = fs.lstatSync(path.join(wtReal, dir, n)); m.set(`${st.dev}:${st.ino}`, n); } catch { /* not in the worktree */ }
      }
      inodes.set(dir, m);
      return m;
    };
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const anc = parts.slice(0, i).join('/');
        const e = tree.map.get(anc);
        if (e && e.type === 'commit') return `${q(p)}: inside the submodule ${anc}`;
        if (e && e.type === 'blob') return `${q(p)}: its parent ${q(anc)} is a tracked file in HEAD`;
      }
      let dir = '';
      for (const name of parts) {
        const spelled = dir ? `${dir}/${name}` : name;
        if (tree.map.has(spelled)) { dir = spelled; continue; }
        let st;
        try { st = fs.lstatSync(path.join(wtReal, spelled)); } catch { break; }
        const twin = inodesOf(dir).get(`${st.dev}:${st.ino}`);
        if (twin) {
          let listed = [];
          try { listed = fs.readdirSync(path.join(wtReal, dir)); } catch { /* as one name */ }
          if (!(listed.includes(name) && listed.includes(twin))) return `${q(p)}: the worktree entry is tracked as ${q(dir ? `${dir}/${twin}` : twin)}`;
        }
        break;
      }
    }
    return null;
  };

  // ---- the walk: a process of its own, removed by a signal; the adapter's loop never waits on a file call of the worktree
  let walkN = 0;
  const excludesFile = () => {
    const v = userConfig(['--path', '--get', 'core.excludesFile']).out.trim();
    if (v) return v;
    const xdg = userEnv.XDG_CONFIG_HOME || path.join(userEnv.HOME || '/nonexistent', '.config');
    return path.join(xdg, 'git', 'ignore');
  };
  // {ok, ...the answer of commit-walk.js} | {limit, visited} | {problem, visited} | {failed} | {cancelled}
  const walkRun = (id, job) => new Promise((resolve) => {
    if (cancelling) { resolve({ cancelled: true }); return; }
    const dir = path.join(walkRoot, id, String(++walkN));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gitEnv = Object.assign(baseEnv(), { GIT_DIR: gitDir, GIT_WORK_TREE: emptyWt });
    delete gitEnv.GIT_LITERAL_PATHSPECS; // check-ignore refuses the literal magic
    const progress = path.join(dir, 'progress');
    const jobFile = path.join(dir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify(Object.assign({ wt: wtReal, git: gitBin, gitArgs: SAFE_C.concat(['-c', `core.excludesFile=${excludesFile()}`]), gitEnv, emptyWt, progress, limits: walkLimits }, job)), { mode: 0o600 });
    let spec = { kind: 'walk', bin: process.execPath, args: [`--max-old-space-size=${WALK_HEAP_MB}`, WALKER, jobFile], env: { PATH: SAFE_PATH, HOME: gitHome, LANG: 'C', LC_ALL: 'C' }, cwd: emptyWt };
    if (inject.walkLaunch) spec = inject.walkLaunch(spec) || spec;
    const outFile = path.join(dir, 'out.json'), errFile = path.join(dir, 'err.log');
    const out = fs.openSync(outFile, 'w', 0o600), err = fs.openSync(errFile, 'w', 0o600);
    let child;
    try { child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', out, err] }); } catch (e) {
      fs.closeSync(out); fs.closeSync(err);
      resolve({ failed: e.code || e.message });
      return;
    }
    fs.closeSync(out); fs.closeSync(err);
    const r = { pgid: child.pid, done: false };
    const visited = () => { try { return parseInt(fs.readFileSync(progress, 'utf8'), 10) || 0; } catch { return 0; } };
    const end = (v) => { if (r.done) return; r.done = true; clearTimeout(timer); if (running === r) running = null; resolve(v); };
    // a walk holds nothing: SIGKILL at once. The promise does not wait for its exit, a call stuck in the kernel keeps
    // the process only until that call returns.
    const remove = () => { if (r.pgid) killGroup(r.pgid, 'SIGKILL'); child.unref(); };
    const timer = setTimeout(() => { remove(); end({ limit: 'timeout', visited: visited() }); }, walkLimits.timeoutMs);
    r.cancel = () => { remove(); end({ cancelled: true }); };
    running = r;
    child.on('error', (e) => end({ failed: e.code || e.message }));
    child.on('exit', (rc, signal) => {
      if (r.done) return;
      if (r.pgid) killGroup(r.pgid, 'SIGKILL');
      if (rc !== 0 || signal) { end({ failed: `${signal ? `signal ${signal}` : `rc ${rc}`}: ${tailOf(errFile).slice(-300)}`, visited: visited() }); return; }
      const f = readNoFollow(outFile, walkLimits.resultBytes * 2 + 1024 * 1024);
      if (f.error) { end({ failed: `its output: ${f.error}`, visited: visited() }); return; }
      try { end(JSON.parse(f.bytes.toString('utf8'))); } catch { end({ failed: 'its output is not JSON', visited: visited() }); }
    });
    if (cancelling) r.cancel();
  });
  const walkWhy = (w) => {
    if (w.problem && w.problem.kind === 'gitignore') return w.problem.text;
    const L = walkLimits;
    const text = w.limit ? { entries: `the worktree has more than ${L.entries} entries`, timeout: `the walk took longer than ${L.timeoutMs} ms`, results: `results above ${L.resultBytes} bytes`,
      ignore: `ignore files above ${L.ignoreBytes} bytes in total`, read: `files to hash above ${L.readBytes} bytes` }[w.limit] || w.limit
      : w.problem ? w.problem.text : `the walk process failed (${w.failed})`;
    return `no safe check path: ${text}; walked ${w.visited || 0} entries, the walk did not finish`;
  };
  let mirrorN = 0;
  // The walk of the worktree against the tip h0; previous: the walk before, whose ignore rules class the changes.
  const fullWalk = async (id, named, h0, previous) => {
    const mirror = path.join(walkRoot, id, `m${++mirrorN}`);
    const w = await walkRun(id, { mode: 'walk', named: [...named], h0, mirror, previous: previous ? previous.mirror : null });
    if (!w.ok) return w;
    if (!Array.isArray(w.files)) return { failed: 'its output has no files' };
    w.mirror = mirror;
    w.map = new Map(w.files.map((f) => [f.p, f]));
    return w;
  };
  // a folder the walk could not look into is no input: nothing of it was seen; it counts only in the difference below
  const inputsOf = (u) => u.files.filter((f) => f.t !== 'd' && (!f.i || isIgnoreFile(f.p))).map((f) => f.p).sort();
  // The difference of two walks: {changed, ignored}. A new or changed path is classed by the rules before the pass, a
  // removed one by its own walk; a .gitignore outside the request is a change whatever its class.
  const untrackedDiff = (before, after) => {
    const changed = [], ignored = [];
    const sort = (hidden, p, kind) => { if (hidden && !isIgnoreFile(p)) ignored.push(p); else changed.push({ path: p, kind }); };
    for (const f of after.files) {
      const b = before.map.get(f.p);
      if (!b || b.k !== f.k) sort(f.c, f.p, b ? 'modified' : 'created');
    }
    for (const b of before.files) if (!after.map.has(b.p)) sort(b.i, b.p, 'deleted');
    return { changed, ignored };
  };

  // ---- the compare in Node (no git command reads the worktree)
  let objFormat = null;
  const objectFormat = () => {
    if (!objFormat) objFormat = g(['rev-parse', '--show-object-format']).out.trim() === 'sha256' ? 'sha256' : 'sha1';
    return objFormat;
  };
  const blobId = (bytes) => crypto.createHash(objectFormat()).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  // the state of one worktree path against a blob of mode m: null when equal, else the kinds that differ
  const pathDiff = (p, mode, oid) => {
    const f = readEntry(path.join(wtReal, p), MAX_FILE_BYTES);
    if (f.code === 'ENOENT') return mode === '0' ? null : ['deleted'];
    if (mode === '0') return ['created'];
    if (f.code === 'ELOOP' || f.code === 'NOTFILE') return ['typechange'];
    if (f.error) return [`unreadable (${f.error})`];
    if (f.link) return mode !== '120000' ? ['typechange'] : blobId(f.link) === oid ? null : ['modified'];
    if (mode === '120000') return ['typechange'];
    const kinds = [];
    if (blobId(f.bytes) !== oid) kinds.push('modified');
    if ((f.st.mode & 0o100 ? '100755' : '100644') !== mode) kinds.push('mode');
    return kinds.length ? kinds : null;
  };
  const userGitEnv = () => {
    const env = { PATH: SAFE_PATH, LANG: 'C', LC_ALL: 'C', GIT_DIR: gitDir, GIT_WORK_TREE: emptyWt, GIT_INDEX_FILE: privIndex, GIT_NO_LAZY_FETCH: '1' };
    for (const [k, v] of Object.entries(userEnv)) if (USER_CONFIG_KEYS.test(k) && typeof v === 'string') env[k] = v;
    return env;
  };
  // path -> {attribute: value}, or {error}. source: a commit (its .gitattributes), or null for the private index.
  const attrsOf = (paths, source) => {
    const res = new Map();
    if (!paths.length) return res;
    const ca = run(['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooksOff}`, 'check-attr'].concat(source ? [`--source=${source}`] : ['--cached'], ['-z', '--stdin'], CONVERSION_ATTRS),
      { env: userGitEnv(), input: Buffer.from(paths.join('\0') + '\0', 'utf8'), noSafe: true });
    if (ca.rc !== 0) return { error: `check-attr: ${errText(ca)}` };
    const t = ca.out.split('\0');
    for (let i = 0; i + 2 < t.length; i += 3) {
      if (!res.has(t[i])) res.set(t[i], {});
      res.get(t[i])[t[i + 1]] = t[i + 2];
    }
    return res;
  };
  // What converts a path with these attributes (gitattributes(5): autocrlf applies unless text or crlf is unset), or
  // null. core.eol alone converts nothing: it applies to paths that have the text attribute.
  const conversionIn = (attrs) => {
    for (const a of CONVERSION_ATTRS) if (attrs[a] && attrs[a] !== 'unspecified' && attrs[a] !== 'unset') return `the attribute ${a}=${attrs[a]}`;
    const ac = userConfig(['--get', 'core.autocrlf']).out.trim().toLowerCase();
    if (ac && !['false', 'no', 'off', '0'].includes(ac) && attrs.text !== 'unset' && attrs.crlf !== 'unset') return `core.autocrlf ${ac}`;
    return null;
  };
  // the keys of the user's config that conversion reads, as -c arguments of a command inside the sandbox
  const conversionArgs = () => {
    const c = userConfig(['--null', '--get-regexp', CONVERSION_CONFIG]);
    const args = [];
    let attrFile = false;
    for (const rec of c.out.split('\0').filter(Boolean)) {
      const nl = rec.indexOf('\n');
      const key = nl < 0 ? rec : rec.slice(0, nl);
      let val = nl < 0 ? null : rec.slice(nl + 1);
      if (key === 'core.attributesfile' && val !== null) {
        attrFile = true;
        if (val === '~' || val.startsWith('~/')) val = path.join(userEnv.HOME || '/nonexistent', val.slice(1));
      }
      args.push('-c', val === null ? key : `${key}=${val}`);
    }
    if (!attrFile) {
      const def = path.join(userEnv.XDG_CONFIG_HOME || path.join(userEnv.HOME || '/nonexistent', '.config'), 'git', 'attributes');
      if (exists(def)) args.push('-c', `core.attributesFile=${def}`);
    }
    return args;
  };
  // Blob ids through git's conversion, inside the sandbox, with the attributes of h0 (a .gitattributes the role put in
  // the worktree has no say): {ids: Map} | {error} | {cancelled}. The paths go after "--": hash-object on a closed stdin
  // answers nothing with rc 0 (measured); stdout apart from stderr, so a filter cannot print an id into the answer.
  const hashInSandbox = async (id, paths, h0) => {
    const nc = cacheOutside();
    if (nc) return { error: `no safe check path: ${nc}` };
    const rd = await sandboxReady();
    if (rd.cancelled || cancelling) return { cancelled: true };
    if (rd.error) return { error: `no safe check path: ${rd.error}` };
    const dir = path.join(walkRoot, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ids = new Map();
    const conv = conversionArgs();
    for (let i = 0; i < paths.length; i += HASH_BATCH) {
      const batch = paths.slice(i, i + HASH_BATCH);
      const home = newHome(`${id}-hash`);
      const log = path.join(dir, `hash-${i}.out`), errLog = path.join(dir, `hash-${i}.err`);
      const res = await launchCheck('hash', [gitBin, `--attr-source=${h0}`, '-c', 'core.fsmonitor=false'].concat(conv, ['hash-object', '--'], batch), { home, log, errLog, profile: profileOf(null) });
      fs.rmSync(home, { recursive: true, force: true });
      if (res.cancelled || cancelling) return { cancelled: true };
      if (res.error) return { error: `no safe check path: the hash of a path with a conversion could not be launched (${res.error})` };
      if (res.rc !== 0 || res.signal) return { error: `no safe check path: the hash of a path with a conversion failed (${res.signal || `rc ${res.rc}`}): ${tailOf(errLog).slice(-300)}` };
      const f = readNoFollow(log, 1024 * 1024);
      const got = f.bytes ? f.bytes.toString('utf8').split('\n').filter(Boolean) : [];
      if (got.length !== batch.length || !got.every((x) => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(x))) return { error: `no safe check path: the hash of a path with a conversion gave no answer (rc 0, ${got.length} of ${batch.length} ids)` };
      batch.forEach((p, k) => ids.set(p, got[k]));
    }
    return { ids };
  };
  // Replaces each deleted entry of the list whose blob equals an untracked file by renamed pairs, one per such file: no
  // first candidate is chosen. An empty blob has no pair (it equals every empty file); a file the ignore rules hide
  // is only a note on deleted. Deleted files and candidates are grouped by blob and link or file, and the JSON of all
  // pairs and notes is summed over the groups: time and memory are linear until the sum is within walkLimits.resultBytes,
  // and only then are the pairs built, so the product of two lists the walk bounds one by one stays bounded (G1).
  const pairRenames = async (id, list, tree, u, named) => {
    const gone = list.filter((c) => c.kind === 'deleted');
    if (!gone.length) return { list };
    const oids = gone.map((c) => tree.map.get(c.path).oid);
    const bc = g(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: Buffer.from(oids.join('\n') + '\n') });
    if (bc.rc !== 0) return { error: `cat-file: ${errText(bc)}` };
    const sizes = new Set();
    for (const l of bc.out.split('\n')) { const n = +l.split(' ')[1]; if (n > 0) sizes.add(n); }
    const cands = u.files.filter((f) => sizes.has(f.s) && (f.t === 'f' || f.t === 'l')).map((f) => ({ p: f.p, t: f.t, i: f.i }));
    for (const p of named) {
      if (tree.map.has(p)) continue;
      try { const st = fs.lstatSync(path.join(wtReal, p)); if (sizes.has(st.size) && (st.isFile() || st.isSymbolicLink())) cands.push({ p, t: st.isFile() ? 'f' : 'l', i: false }); } catch { /* missing */ }
    }
    if (!cands.length) return { list };
    const w = await walkRun(id, { mode: 'hash', paths: cands.map((c) => c.p), objFormat: objectFormat() });
    if (w.cancelled) return { cancelled: true };
    if (!w.ok) return { error: walkWhy(w) };
    const groupKey = (oid, link) => `${oid} ${link ? 'link' : 'file'}`;
    const groupOf = (c) => { const e = tree.map.get(c.path); return groupKey(e.oid, e.mode === '120000'); };
    const groups = new Map();
    for (const c of gone) {
      const k = groupOf(c);
      if (!groups.has(k)) groups.set(k, { gone: [], plain: [], ignored: [] });
      groups.get(k).gone.push(c.path);
    }
    for (const x of cands) {
      const group = groups.get(groupKey(w.ids[x.p], x.t === 'l'));
      if (group) (x.i ? group.ignored : group.plain).push(x.p);
    }
    let bytes = 0, deleted = 0, copies = 0;
    for (const group of groups.values()) {
      const to = group.plain.length ? group.plain : group.ignored;
      if (!to.length) continue;
      const D = group.gone.length, C = to.length;
      const fromBytes = sumJsonBytes(group.gone), toBytes = sumJsonBytes(to);
      deleted += D;
      copies += C;
      bytes += group.plain.length ? D * toBytes + C * fromBytes + D * C * PAIR_BYTES : fromBytes + D * (toBytes + NOTE_BYTES);
    }
    if (bytes > walkLimits.resultBytes) return { error: `no safe check path: the rename pairs of ${deleted} deleted files and ${copies} files with the same content take ${bytes} bytes, above the ${walkLimits.resultBytes} of results; the walk finished, the pairs are not listed` };
    const out = [];
    for (const c of list) {
      if (c.kind !== 'deleted') { out.push(c); continue; }
      const group = groups.get(groupOf(c));
      if (group.plain.length) { for (const p of group.plain) out.push({ kind: 'renamed', from: c.path, path: p }); continue; }
      out.push(group.ignored.length ? Object.assign({}, c, { ignoredCopies: group.ignored }) : c);
    }
    return { list: out };
  };
  // G7: tracked paths of h0 outside the request that differ in the worktree, renames against the walk u, and every
  // entry of the real index that differs from h0; {list} | {error} | {cancelled}
  const outsideChanges = async (id, named, h0, u) => {
    const tree = treeOf(h0);
    if (tree.error) return tree;
    let list = [];
    const raw = [];
    for (const [p, e] of tree.map) {
      if (e.type !== 'blob' || named.has(p)) continue;
      for (const kind of pathDiff(p, e.mode, e.oid) || []) {
        if (kind === 'modified' && e.mode !== '120000') raw.push(p);
        list.push({ path: p, kind });
      }
    }
    if (raw.length) {
      const attrs = attrsOf(raw, h0);
      if (attrs.error) return attrs;
      const conv = raw.filter((p) => conversionIn(attrs.get(p) || {}));
      if (conv.length) {
        const h = await hashInSandbox(id, conv, h0);
        if (h.cancelled || h.error) return h;
        const same = new Set(conv.filter((p) => h.ids.get(p) === tree.map.get(p).oid));
        list = list.filter((c) => !(c.kind === 'modified' && same.has(c.path)));
      }
    }
    const paired = await pairRenames(id, list, tree, u, named);
    if (paired.error || paired.cancelled) return paired;
    list = paired.list;
    const ix = g(['diff-index', '--cached', '--name-status', '-z', '--no-renames', h0, '--'], { index: path.join(gitDir, 'index') });
    if (ix.rc !== 0) return { error: `the index of the worktree cannot be compared with HEAD: ${errText(ix)}` };
    const t = ix.out.split('\0');
    for (let i = 0; i + 1 < t.length; i += 2) if (t[i]) list.push({ path: t[i + 1], kind: 'staged', status: t[i] });
    return { list };
  };
  const listText = (list) => list.slice(0, 20).map((c) => (c.from ? `renamed ${c.from} -> ${c.path}` : `${c.kind}${c.status ? ` ${c.status}` : ''}${c.path ? ` ${c.path}` : ''}`)).join(', ')
    + (list.length > 20 ? `, and ${list.length - 20} more` : '');
  // A named file with a conversion, by the attributes of H0 and of the snapshot (a .gitattributes named in the same
  // request counts), or null: the commit stores the bytes Node read, and git add would store others.
  const namedConversion = (entries, h0) => {
    const files = entries.filter((e) => e.mode !== '0' && e.mode !== '120000').map((e) => e.path);
    for (const source of [h0, null]) {
      const attrs = attrsOf(files, source);
      if (attrs.error) return attrs.error;
      for (const p of files) {
        const c = conversionIn(attrs.get(p) || {});
        if (c) return `a named path with a conversion is refused: ${q(p)}: ${c}`;
      }
    }
    return null;
  };
  // The snapshot of the named paths on the parent: the blobs written, the private index, its tree. {entries, tree} or {why}.
  const takeSnapshot = (id, r, parent, tree) => {
    const np = namedProblem(r.paths, tree);
    if (np) return { why: np };
    const entries = [];
    for (const p of r.paths) {
      const h = tree.map.get(p);
      if (h && h.type !== 'blob') return { why: `${q(p)}: a ${h.type === 'commit' ? 'submodule' : 'folder'} in HEAD (name its files)` };
      const f = readEntry(path.join(wtReal, p), MAX_FILE_BYTES);
      if (f.code === 'ENOENT') {
        if (!h) return { why: `${q(p)}: not tracked and missing` };
        entries.push({ mode: '0', blob: ZERO, path: p });
        continue;
      }
      if (f.error) return { why: `${q(p)}: ${f.error}` };
      const b = g(['hash-object', '-w', '--stdin', '--no-filters'], { input: f.link || f.bytes });
      if (b.rc !== 0) return { why: `hash-object ${q(p)}: ${errText(b)}` };
      entries.push({ mode: f.link ? '120000' : f.st.mode & 0o100 ? '100755' : '100644', blob: b.out.trim(), path: p });
    }
    if (inject.afterSnapshot) inject.afterSnapshot({ id, entries });
    fs.rmSync(privIndex, { force: true });
    const rt = g(['read-tree', parent]);
    if (rt.rc !== 0) return { why: `read-tree: ${errText(rt)}` };
    const ui = g(['update-index', '-z', '--index-info'], { input: indexLines(entries) });
    if (ui.rc !== 0) return { why: `update-index: ${errText(ui)}` };
    const wtree = g(['write-tree']);
    if (wtree.rc !== 0) return { why: `write-tree: ${errText(wtree)}` };
    return { entries, tree: wtree.out.trim() };
  };

  // ---- the process of a check: codex sandbox in a group of its own, never spawnSync
  const codexBin = (() => {
    const c = o.codex === undefined ? 'codex' : o.codex;
    if (typeof c !== 'string' || !c) return null;
    if (path.isAbsolute(c)) { try { fs.accessSync(c, fs.constants.X_OK); return fs.statSync(c).isFile() ? c : null; } catch { return null; } }
    return which(c, userEnv.PATH);
  })();
  const tdirReal = o.tdir ? (() => { try { return fs.realpathSync(o.tdir); } catch { return path.resolve(o.tdir); } })() : null;
  const npmCache = o.npmCache || path.join(path.dirname(o.box), 'npm-cache');
  const locale = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.@-]+$/.test(v) ? v : 'C');
  const checkEnv = (home) => {
    const dirs = [path.dirname(process.execPath), path.dirname(gitBin)].concat(SAFE_PATH.split(':'));
    const e = { PATH: [...new Set(dirs)].join(':'), HOME: home, CODEX_HOME: home, LANG: locale(userEnv.LANG), LC_ALL: locale(userEnv.LC_ALL || userEnv.LANG),
      GIT_INDEX_FILE: privIndex, npm_config_cache: npmCache };
    if (typeof userEnv.TMPDIR === 'string' && path.isAbsolute(userEnv.TMPDIR)) e.TMPDIR = userEnv.TMPDIR;
    return e;
  };
  // the profile: the role's write roots (the worktree, the task folder) and the message folder; .git and .codex of the
  // worktree read only. The npm cache never adds a root: its path lies in the call folder, which the role can replace
  // by a link at any time, so a root taken from it would be a folder of the role's choosing.
  const roleRoots = () => [wtReal].concat(tdirReal ? [tdirReal] : []);
  // the npm cache must resolve (through its nearest existing folder) inside a root of the role; checked per request,
  // before the probe and the hooks: a cache elsewhere is refused instead of failing inside the sandbox
  const cacheOutside = () => {
    let d = path.resolve(npmCache);
    const rest = [];
    for (;;) {
      try { d = path.join(fs.realpathSync(d), ...rest); break; } catch {
        if (path.dirname(d) === d) return `${npmCache} does not resolve`;
        rest.unshift(path.basename(d)); d = path.dirname(d);
      }
    }
    return roleRoots().some((x) => d === x || d.startsWith(x + path.sep)) ? null : `the npm cache ${npmCache} resolves to ${d}, outside the worktree and the task folder`;
  };
  const profileOf = (msgDir) => {
    const p = { roots: roleRoots().concat(msgDir ? [msgDir] : []), network };
    if (inject.profile) inject.profile(p);
    const fsx = p.roots.map((r) => `${JSON.stringify(r)}="write"`)
      .concat([path.join(wtReal, '.git'), path.join(wtReal, '.codex')].map((r) => `${JSON.stringify(r)}="read"`));
    return { text: `permissions.${CHECK_PROFILE}={extends=":workspace",filesystem={${fsx.join(',')}},network={enabled=${p.network === true}}}`, roots: p.roots, network: p.network === true };
  };
  let homeN = 0;
  const newHome = (tag) => {
    const h = path.join(checkHomes, `${tag}-${++homeN}`);
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    if (fs.readdirSync(h).length) throw new Error(`the home of a check ${h} is not empty`);
    return h;
  };
  const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const killGroup = (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* the group is gone */ } };
  let running = null; // the run of the check in progress
  let cancelling = false;
  // one launch: {rc, signal, error?, cancelled?}; output into the file log (stderr into errLog when given)
  const launchCheck = (kind, inner, x) => new Promise((resolve) => {
    let spec = { kind, bin: codexBin, args: ['sandbox', '-c', `default_permissions=${JSON.stringify(CHECK_PROFILE)}`, '-c', x.profile.text, '-P', CHECK_PROFILE, '-C', wtReal, '--'].concat(inner),
      inner, env: checkEnv(x.home), cwd: wtReal };
    if (inject.checkLaunch) spec = inject.checkLaunch(spec) || spec;
    let out, err;
    try { out = fs.openSync(x.log, 'w', 0o644); err = x.errLog ? fs.openSync(x.errLog, 'w', 0o644) : out; } catch (e) { resolve({ rc: null, signal: null, error: `the log ${x.log}: ${e.code || e.message}` }); return; }
    const closeLogs = () => { fs.closeSync(out); if (err !== out) fs.closeSync(err); };
    let child;
    try { child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', out, err] }); } catch (e) {
      closeLogs();
      resolve({ rc: null, signal: null, error: e.code || e.message });
      return;
    }
    closeLogs(); // the child holds its own copies
    const r = { pgid: child.pid, cancelled: false, graceT: null, graced: false, exit: null, done: false };
    const end = (v) => { if (r.done) return; r.done = true; clearTimeout(r.graceT); if (running === r) running = null; resolve(v); };
    r.cancel = () => {
      if (r.done || r.cancelled) return;
      r.cancelled = true;
      killGroup(r.pgid, 'SIGTERM');
      r.graceT = setTimeout(() => { r.graced = true; killGroup(r.pgid, 'SIGKILL'); if (r.exit) end(Object.assign({ cancelled: true }, r.exit)); }, graceMs);
    };
    running = r;
    child.on('error', (e) => { if (!child.pid || !r.exit) end({ rc: null, signal: null, error: e.code || e.message }); });
    child.on('exit', (rc, signal) => {
      r.exit = { rc, signal };
      // a finished check: the rest of its group goes with its leader; a cancelled one keeps its grace while it lives
      if (!r.cancelled) { killGroup(r.pgid, 'SIGKILL'); end({ rc, signal }); } else if (r.graced || !groupAlive(r.pgid)) end(Object.assign({ cancelled: true }, r.exit));
    });
    if (cancelling) r.cancel();
  });
  const tailOf = (log) => {
    try {
      const fd = fs.openSync(log, 'r');
      try {
        const size = fs.fstatSync(fd).size, n = Math.min(size, TAIL_CHARS * 4);
        const b = Buffer.alloc(n);
        fs.readSync(fd, b, 0, n, size - n);
        return b.toString('utf8').slice(-TAIL_CHARS);
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  };
  // codex of a verified version and the probe of the sandbox, once per call: {} or {error}
  let ready = null;
  const versionOf = () => new Promise((resolve) => {
    const home = newHome('version');
    const fin = (v) => { fs.rmSync(home, { recursive: true, force: true }); resolve(v); };
    let spec = { kind: 'version', bin: codexBin, args: ['--version'], inner: null, env: checkEnv(home), cwd: emptyWt };
    if (inject.checkLaunch) spec = inject.checkLaunch(spec) || spec;
    let text = '', c;
    try { c = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { fin({ error: e.code || e.message }); return; }
    c.stdout.on('data', (d) => { if (text.length < 4096) text += d; });
    c.on('error', (e) => fin({ error: e.code || e.message }));
    c.on('close', (rc) => fin({ rc, version: (/(\d+\.\d+\.\d+)/.exec(text) || [])[1] || null }));
  });
  const probe = async () => {
    fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 });
    const canary = path.join(probeDir, 'canary');
    fs.rmSync(canary, { force: true });
    let hits = 0;
    const srv = net.createServer((s) => { hits++; s.destroy(); });
    const port = await new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
    const home = newHome('probe');
    const log = path.join(probeDir, 'probe.log');
    const res = await launchCheck('probe', [process.execPath, '-e', PROBE_JS, canary, npmCache, String(port)], { home, log, profile: profileOf(null) });
    await new Promise((ok) => srv.close(() => ok()));
    fs.rmSync(home, { recursive: true, force: true });
    const wrote = exists(canary);
    fs.rmSync(canary, { force: true });
    if (res.cancelled) return { cancelled: true };
    let j = null;
    try { j = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop()); } catch { /* below */ }
    const failed = (m) => ({ error: `the sandbox probe failed: ${m}` });
    if (res.error) return failed(`codex sandbox could not be launched (${res.error})`);
    if (wrote || (j && j.canary === 'written')) return failed('write outside the roots');
    if (!j) return failed(`no answer (rc ${res.rc}): ${tailOf(log).slice(-300)}`);
    if (network ? j.net !== 'connected' || !hits : j.net === 'connected' || hits) return failed(`network (the role's network is ${network ? 'on' : 'off'}, the probe got ${j.net})`);
    if (j.cache !== 'ok') return failed(`the npm cache of the call is not writable (${j.cache})`);
    if (j.sandbox !== 'seatbelt') return failed(`sandbox marker (CODEX_SANDBOX=${j.sandbox})`);
    const allowed = new Set(Object.keys(checkEnv('/')).concat(CODEX_ADDED));
    const extra = (j.names || []).filter((n) => !allowed.has(n));
    if (extra.length) return failed(`variables outside the white list: ${extra.slice(0, 5).join(', ')}`);
    return {};
  };
  const sandboxReady = async () => {
    if (ready) return ready;
    if (!codexBin) return (ready = { error: `codex not found (${q(o.codex === undefined ? 'codex' : o.codex)})` });
    const v = await versionOf();
    if (v.error || !v.version) return (ready = { error: v.error === 'ENOENT' ? 'codex not found' : `codex --version failed (${v.error || `rc ${v.rc}`})` });
    if (!codexVersions.includes(v.version)) return (ready = { error: `codex ${v.version} is not among the verified versions (${codexVersions.join(', ')})` });
    const p = await probe();
    if (p.cancelled) return p;
    return (ready = p);
  };

  // The passes of the hooks on the snapshot first {entries, tree, message}: at most two (owner answer 1). st collects what
  // the answer reports. {snap} when the last pass changed nothing, {nothing} when a new snapshot equals the parent,
  // {why, changed?} when refused, {cancelled}. A hook that fails ends the request without a compare: its changes stay
  // visible in the worktree.
  const runChecks = async (id, r, first, hk, h0, ptree, u0, st) => {
    const fail = (why, changed) => ({ why, changed });
    if (cancelling) return { cancelled: true };
    const nc = cacheOutside();
    if (nc) return fail(`no safe check path: ${nc}`);
    const rd = await sandboxReady();
    if (rd.cancelled || cancelling) return { cancelled: true };
    if (rd.error) return fail(`no safe check path: ${rd.error}`);
    const named = new Set(r.paths);
    let snap = first, u = u0;
    for (let pass = 1; ; pass++) {
      const msgDir = path.join(msgRoot, `${id}-${pass}`);
      st.msgDir = msgDir;
      fs.rmSync(msgDir, { recursive: true, force: true });
      fs.mkdirSync(msgDir, { recursive: true, mode: 0o700 });
      const msgFile = path.join(msgDir, 'COMMIT_EDITMSG');
      fs.writeFileSync(msgFile, snap.message);
      const profile = profileOf(msgDir);
      for (const h of hk.hooks) {
        const home = newHome(`${id}-${pass}`);
        const log = path.join(answers, `${id}.${pass}.${h}.log`);
        const inner = [gitBin, '-c', `core.hooksPath=${hk.dir}`, 'hook', 'run', '--ignore-missing', h]
          .concat(h === 'pre-commit' ? [] : ['--', msgFile].concat(h === 'prepare-commit-msg' ? ['message'] : []));
        const t0 = Date.now();
        const res = await launchCheck('hook', inner, { home, log, profile });
        const ms = Date.now() - t0;
        fs.rmSync(home, { recursive: true, force: true });
        st.checks.push({ hook: h, pass, rc: res.rc, signal: res.signal || null, ms, log, tail: tailOf(log),
          launch: { codex: codexBin, profile: profile.text, network: profile.network, writeRoots: profile.roots, home } });
        if (res.cancelled || cancelling) return { cancelled: true };
        if (res.error) return fail(`no safe check path: ${h} could not be launched under codex sandbox (${res.error})`);
        // codex sandbox gives a hook killed by a signal as its exit code (137, 143): named as it comes
        if (res.rc !== 0 || res.signal) return fail(`${h} failed (${res.signal ? `signal ${res.signal}` : `rc ${res.rc}`})`);
      }
      if (inject.afterChecks) inject.afterChecks({ id, privIndex });
      // the compare after the pass, against what was recorded before it
      const wt2 = g(['write-tree']);
      if (wt2.rc !== 0 || wt2.out.trim() !== snap.tree) return fail('index changes are an adapter operation: the tree of the private index changed during the check');
      const d = discover();
      if (d.error || d.gitDir !== gitDir) return fail(`the git dir of the worktree changed during the check (${d.error || d.gitDir})`);
      const hd = g(['symbolic-ref', '-q', 'HEAD']);
      if (hd.rc !== 0 || hd.out.trim() !== ref) return fail(`HEAD of the worktree is not ${ref} (${hd.rc === 0 ? hd.out.trim() : 'detached'}) after the check`);
      const tip = tipNow();
      if (tip !== h0) return fail(`HEAD changed during the operation (recorded ${h0}): the branch is at ${tip}`);
      const cur = await fullWalk(id, named, h0, u);
      if (cur.cancelled) return { cancelled: true };
      if (!cur.ok) return fail(walkWhy(cur));
      st.walkNotes = cur.notes;
      const out = await outsideChanges(id, named, h0, cur);
      if (out.cancelled) return { cancelled: true };
      if (out.error) return fail(out.error);
      const un = untrackedDiff(u, cur);
      for (const p of un.ignored) st.ignored.add(p);
      const targets = new Set(out.list.filter((c) => c.kind === 'renamed').map((c) => c.path));
      const outside = out.list.concat(un.changed.filter((c) => !(c.kind === 'created' && targets.has(c.path))));
      if (outside.length) {
        const staged = outside.some((c) => c.kind === 'staged');
        return fail(`${staged ? 'the index of the worktree differs from HEAD; ' : ''}changed outside the request during the check (by the check or the role): ${listText(outside)}`, outside);
      }
      const changes = [];
      for (const e of snap.entries) for (const kind of pathDiff(e.path, e.mode, e.blob) || []) changes.push({ path: e.path, kind });
      const mm = readNoFollow(msgFile, MAX_REQUEST_BYTES);
      if (mm.error) return fail(`the message file after the check: ${mm.error}`);
      const ss = run(['stripspace'], { env: baseEnv(), input: mm.bytes });
      if (ss.rc !== 0) return fail(`stripspace: ${errText(ss)}`);
      const msg = Buffer.from(ss.out, 'utf8');
      if (!msg.length) return fail('the message is empty after the check');
      if (!msg.equals(snap.message)) changes.push({ kind: 'message' });
      if (!changes.length) return { snap };
      if (pass === 2) return fail(`the check is not stable: the second pass changed the snapshot again: ${listText(changes)}`, changes);
      st.rechecked = true;
      st.changed = changes;
      const tree = treeOf(h0);
      if (tree.error) return fail(tree.error);
      const next = takeSnapshot(id, r, h0, tree);
      if (next.why) return fail(next.why);
      const conv = namedConversion(next.entries, h0);
      if (conv) return fail(conv);
      if (next.tree === ptree) return { nothing: true };
      snap = Object.assign(next, { message: msg });
      u = cur;
    }
  };

  const processRequest = async (id, hash, r) => {
    let intentCommit = null;
    const done = (res) => finish(id, hash, res);
    const cancelled = (extra) => done(Object.assign({ status: 'cancelled', why: 'the call ended during the check' }, extra));
    try {
      const hk = checkHooks();
      if (hk.error) return done({ status: 'refused', why: `no safe check path: ${hk.error}` });
      const checking = hk.hooks.length > 0;
      const pre = preflight(!checking);
      if (pre) return done({ status: 'refused', why: pre });
      const parent = expected;
      const named = new Set(r.paths);
      const tree = treeOf(parent);
      if (tree.error) return done({ status: 'refused', why: tree.error });
      const np = namedProblem(r.paths, tree);
      if (np) return done({ status: 'refused', why: np });
      // an untracked named path that the ignore rules hide: git add would refuse it too (no walk of the worktree here)
      const fresh = r.paths.filter((p) => !tree.map.has(p) && exists(path.join(wtReal, p)));
      if (fresh.length) {
        const w = await walkRun(id, { mode: 'named', named: fresh, mirror: path.join(walkRoot, id, 'named') });
        if (w.cancelled) return cancelled();
        if (!w.ok) return done({ status: 'refused', why: walkWhy(w) });
        if ((w.ignored || []).length) return done({ status: 'refused', why: `${q(w.ignored[0])}: ignored (name it with git add -f semantics is not supported)` });
      }
      let u0 = null, inputs = {};
      if (checking) {
        u0 = await fullWalk(id, named, parent, null);
        if (u0.cancelled) return cancelled();
        if (!u0.ok) return done({ status: 'refused', why: walkWhy(u0) });
        inputs = { untrackedInputs: inputsOf(u0), walkNotes: u0.notes };
        const out = await outsideChanges(id, named, parent, u0);
        if (out.cancelled) return cancelled();
        if (out.error) return done({ status: 'refused', why: out.error });
        if (out.list.length) return done(Object.assign({ status: 'refused', why: `tracked changes outside the request: ${listText(out.list)}`, changed: out.list, checks: [] }, inputs));
      }
      const first = takeSnapshot(id, r, parent, tree);
      if (first.why) return done({ status: 'refused', why: first.why });
      let { entries, tree: treeId } = first;
      const ptree = g(['rev-parse', `${parent}^{tree}`]).out.trim();
      if (treeId === ptree) return done({ status: 'nothing' });
      let message = Buffer.from(r.message, 'utf8');
      let extra = {};
      if (checking) {
        const conv = namedConversion(entries, parent);
        if (conv) return done({ status: 'refused', why: conv });
        const ss = run(['stripspace'], { env: baseEnv(), input: message });
        if (ss.rc !== 0) return done({ status: 'refused', why: `stripspace: ${errText(ss)}` });
        message = Buffer.from(ss.out, 'utf8');
        const st = { checks: [], changed: null, rechecked: false, ignored: new Set(), msgDir: null, walkNotes: null };
        const res = await runChecks(id, r, Object.assign(first, { message }), hk, parent, ptree, u0, st);
        extra = Object.assign({ checks: st.checks, rechecked: st.rechecked,
          environment: { writeRoots: roleRoots().concat(st.msgDir ? [st.msgDir] : []), network, reads: 'the whole disk except profile denials', untracked: 'not part of the commit' } },
        inputs, st.walkNotes ? { walkNotes: st.walkNotes } : {}, st.ignored.size ? { ignoredChanged: [...st.ignored].sort() } : {}, st.changed ? { changed: st.changed } : {});
        if (res.cancelled) return done(Object.assign({ status: 'cancelled', why: 'the call ended during the check' }, extra));
        if (res.why) return done(Object.assign({ status: 'refused', why: res.why }, extra, res.changed ? { changed: res.changed } : {}));
        if (res.nothing) return done(Object.assign({ status: 'nothing' }, extra));
        ({ entries, tree: treeId, message } = res.snap);
        if (inject.afterFinalCompare) inject.afterFinalCompare({ id });
      }
      // from here to the result nothing awaits: a call that ends now waits for the result (close)
      append({ ev: 'intent', id, hash, paths: r.paths, parent, tree: treeId, ref, entries });
      const ct = g(['commit-tree', '--no-gpg-sign', treeId, '-p', parent, '-F', '-'], { input: message });
      if (ct.rc !== 0) return done(Object.assign({ status: 'refused', why: `commit-tree: ${errText(ct)}` }, extra));
      const sha = ct.out.trim();
      append({ ev: 'intent-commit', id, sha, old: parent });
      intentCommit = { sha, old: parent };
      if (inject.beforeUpdateRef) inject.beforeUpdateRef({ id, sha, old: parent });
      const ur = g(['update-ref', '-m', `codis-agents commit ${id}`, ref, sha, parent]);
      if (ur.rc !== 0) {
        intentCommit = null;
        return done(Object.assign({ status: 'refused', why: `branch moved outside the adapter (update-ref with the old value failed): ${errText(ur)}` }, extra));
      }
      if (inject.afterUpdateRef) inject.afterUpdateRef({ id, sha, old: parent });
      expected = sha;
      if (inject.beforeIndexSync) inject.beforeIndexSync({ id, sha });
      const why = syncRealIndex(entries);
      if (why) note(`request ${id}: committed ${sha}, the index sync failed: ${why}`);
      return done(Object.assign({ status: 'committed', sha, paths: r.paths }, why ? { indexSync: 'failed' } : {}, extra));
    } catch (e) {
      // a step threw after commit-tree, before the result: the tip tells whether the branch moved
      if (intentCommit) {
        const tip = tipNow();
        if (tip === intentCommit.sha) { expected = tip; return done({ status: 'committed', sha: tip, paths: r.paths, indexSync: 'failed' }); }
      }
      return done({ status: 'refused', why: `internal error: ${String(e && e.message).slice(0, 300)}` });
    } finally {
      try { fs.rmSync(path.join(walkRoot, id), { recursive: true, force: true }); } catch { /* the walk folders of a call are only clutter */ }
    }
  };

  // ---- the queue: a scan only reads the box and queues new ids; one worker takes them in order
  const reused = new Set();
  const queue = [];
  const queued = new Map(); // id -> hash of the content queued
  let busyId = null;
  const idleWaiters = [];
  let closing = false, closed = false;
  const handle = (c) => {
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
    if (busyId === c.id || queued.has(c.id)) return; // the content first read stands
    if (closing) { finish(c.id, hash, { status: 'cancelled', why: 'the call ended before the request was processed' }); return; }
    queue.push(Object.assign({ hash }, c));
    queued.set(c.id, hash);
  };
  const work = async (c) => {
    if (c.r.error) return finish(c.id, c.hash, { status: 'refused', why: `the request file: ${c.r.error}` });
    if (broken) return finish(c.id, c.hash, { status: 'refused', why: broken });
    let r = null;
    try { r = JSON.parse(c.r.bytes.toString('utf8')); } catch { return finish(c.id, c.hash, { status: 'refused', why: 'the request is not JSON' }); }
    const why = requestProblem(r, c.id);
    if (why) return finish(c.id, c.hash, { status: 'refused', why });
    return processRequest(c.id, c.hash, r);
  };
  const pump = () => {
    while (!busyId && queue.length) {
      const c = queue.shift();
      queued.delete(c.id);
      if (closing) { finish(c.id, c.hash, { status: 'cancelled', why: 'the call ended before the request was processed' }); continue; }
      busyId = c.id;
      (async () => {
        try { await work(c); } catch (e) { note(`request ${c.id}: ${String(e && e.message).slice(0, 300)}`); }
        busyId = null;
        for (const w of idleWaiters.splice(0)) w();
        if (!closed) pump();
      })();
    }
  };

  const scan = () => {
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
      if (busyId === m[1] || queued.has(m[1])) continue;
      const r = readNoFollow(path.join(boxReal, name), MAX_REQUEST_BYTES);
      cands.push({ id: m[1], r, birth: r.st ? r.st.birthtimeMs : 0 });
    }
    cands.sort((a, b) => a.birth - b.birth || (a.id < b.id ? -1 : 1));
    for (const c of cands) {
      try { handle(c); } catch (e) { note(`request ${c.id}: ${String(e && e.message).slice(0, 300)}`); }
    }
    pump();
  };
  let kicked = false;
  const kick = () => { if (kicked || closing) return; kicked = true; setImmediate(() => { kicked = false; scan(); }); };
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
  const timer = setInterval(() => scan(), pollMs);
  if (timer.unref) timer.unref();
  scan();

  const cancel = () => { cancelling = true; if (running) running.cancel(); };
  let closingP = null;
  const summary = () => Object.assign({}, sum, { notes: notes.slice() });
  return {
    box: o.box,
    answers,
    notes: () => notes.slice(),
    cancel,
    close() {
      if (closingP) return closingP;
      closingP = (async () => {
        closing = true;
        clearInterval(timer);
        if (watcher) { try { watcher.close(); } catch { /* closed */ } }
        cancel();
        if (busyId) await new Promise((ok) => idleWaiters.push(ok));
        scan();
        pump();
        closed = true;
        if (jfd !== null) { try { fs.closeSync(jfd); } catch { /* closed */ } }
        if (writer) {
          try { const held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (held.token === token) fs.rmSync(lockFile, { force: true }); } catch { /* gone */ }
        }
        return summary();
      })();
      return closingP;
    },
  };
}

module.exports = { openCommitService, readNoFollow, pathProblem, requestProblem, VERIFIED_GIT_VERSIONS, VERIFIED_CODEX_VERSIONS, KILL_GRACE_MS, MAX_REQUEST_BYTES, POLL_MS, JOURNAL_VERSION };
