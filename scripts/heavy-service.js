'use strict';
// The heavy channel of the role adapter (mechanism K-b): a programmer or tester on codex cannot take a
// memory slot inside its sandbox (the slot directory is not a write root), so it asks the adapter to run a heavy
// command (scripts/heavy-req.js); the adapter takes the slot outside the sandbox and runs the command in a sandbox of
// the role's rights. scripts/role-exec.js opens one service per prog/test call (cfg.heavy) and closes it when the role's
// process is gone.
//
// The box (<call folder>/heavy) is an untrusted source, read as the commit channel reads its box
// (scripts/commit-service.js readNoFollow: no link, no FIFO, a size limit): <32 hex>.json is a request {id, argv, kind?,
// cwd?} or a guard run {id, kind: "full"} / {id, kind: "select", base} (cwd? allowed) - no other field -, <32 hex>.cancel
// asks to stop that request. Answers <id>.json lie in the adapter's state folder
// (<stateDir>/<task>/heavy-calls/<call>/), rewritten on every change of state.
//
// One run at a time per call (owner decision 4): a second request waits in the adapter's queue, never with a second
// ticket. The class of a run: slots.kinds of the project config (decision 1; a kind not in it, or no kind, is heavy);
// an argv that is a guard marked guards:exclusive is heavy whatever its kind (only heavy.sh takes the exclusive lock).
// Refused before the queue: docker and the stand (decision 9), guards-all.sh in an argv (a guard run is a kind of its
// own, below: inside the executor guards-all.sh could only wait behind its own held slot).
//
// A run, every step journaled before it is taken (<stateDir>/<task>/heavy.jsonl, append + fsync, one writer):
//   queued -> holding: scripts/slot-hold.sh <class> outside the sandbox (its environment without CODIS_SLOT_HELD and
//   with CODIS_AGENTS_CONFIG = o.config, the run's project config, so it queues in the slot directory of that config
//   and the machine file, whatever a lookup from the worktree would find; SLOT_LABEL "codex <task> <role> <id>"); its lines "waiting for slot
//   ..." give the position and the reason; "acquired <slot> <t>" the slot; an exit before it is the queue's refusal.
//   -> acquired: the exclusive lock file (GUARDS_EXCLUSIVE_LOCK, else <slot dir>/exclusive.lock) is created if missing,
//   never truncated (the executor may only read it). -> running: the gate is spawned detached (its pid is the group G),
//   journaled with G and its start time, then the exec marker <slot>.exec.<G> is written (tmp + rename), and only then
//   "go" reaches the gate. The gate writes the file started, runs the executor as its child and writes its code into
//   the file rc. The executor is `codex sandbox -P codis-heavy -- zsh <scripts>/<class>.sh <argv>` with
//   CODIS_SLOT_HELD="<class> <slot>" and CODIS_AGENTS_CONFIG = o.config: a nested heavy.sh / medium.sh of the argv runs
//   without a second ticket, and a guard marked exclusive by the run's config takes its lock through heavy.sh, as for a
//   role of Claude.
//   The end: the gate exited -> members left in G are stopped; a stop (the role's cancel, the end of the call, a
//   signal of the adapter) -> stopping, TERM and CONT to G, killGraceMs, KILL, up to emptyWaitMs for G to be gone
//   (30 s each by default; polled every 100 ms, the period slot_run waits for its holder). G gone ->
//   group-empty, the marker removed, "release" to the holder, then done (the code from the file rc, also when a stop
//   came meanwhile: a result is never turned into a stop) or stopped. G not gone, or a signal refused with EPERM ->
//   undetermined: the marker stays and keeps the slot busy until G ends, the holder is released all the same.
// So the slot is busy while the holder's lock is held or the marker names a live G: kill -9 of the adapter ends the
// holder (EOF on its stdin) and the slot stays held by the marker; a waiter of the queue removes the marker of a dead
// group. A holder that dies before "go" closes the gate (exit 70, nothing ran): the run is queued again with a new
// holder. A holder that dies while the command runs changes nothing (a line holder-gone).
//
// The executor's profile (measured on codex 0.167.0 only, so the channel accepts that version only): write to the
// worktree and the task folder; <wt>/.git and <wt>/.codex read only; /tmp read only (":slash_tmp"); no ":tmpdir" line,
// so the system TMPDIR is not given and the run's own TMPDIR (inside the task folder) stays writable; the network
// limited to loopback with local binding (owner 2026-11-11 "a"). Its environment is built from a white list. Before
// the first run of a call a probe checks it in the same sandbox: its TMPDIR writable, /tmp, the system TMPDIR and a
// file outside the roots refused, listen and connect on 127.0.0.1 working, an outside address refused,
// CODEX_SANDBOX=seatbelt, no variable outside the list; anything else refuses every request "environment: no safe
// executor".
//
// A guard run (kind full, or kind select with base; the kinds are reserved, config.js refuses them in slots.kinds): the
// argv is the adapter's, never the role's - `zsh <scripts>/guards-all.sh --local --quarantine-read-only <wt>` or
// `... --local --select <base> <wt>`; refused before the queue: tracked changes in the worktree ("commit first"), a base
// that is not a plain ref name or not a commit. guards-all.sh runs outside the sandbox and takes a heavy slot of its own
// (its queue, worker budget, .jobs/.limit, exclusive lock, meta, log and read-only quarantine are those of any run), so
// the adapter takes no slot and writes no marker for it: queued -> the probe -> the executor spec
// <stateDir>/<task>/heavy-runs/<id>/exec.json ({bin, args, env, label}: codex, the profile below, the white list, its
// own TMPDIR) -> the gate with the environment of the holder plus CODIS_GUARDS_EXEC=<spec> -> running (G, no slot) ->
// go. Every command of the project inside the run goes into the executor through scripts/heavy-exec.js, in the group of
// the run's slot command. While guards-all.sh waits for its slot or workers, the last line of the gate's log that starts
// with "waiting for" is the why of the answer (read on the poll of the box). A stop: TERM and CONT to G, up to
// killGraceMs + emptyWaitMs for G to be gone (guards-all.sh's slot_run waits for its holder, which stops the runner with
// its own two pauses), KILL, emptyWaitMs. G gone -> group-empty, the spec and the run's TMPDIR removed (out.log stays),
// done or stopped. The answer adds base, where ("local full run" | "local selection") and guardsLog (the line "guards
// log: <path>" of guards-all.sh); a done run adds verdict (green | incomplete | red | environment) and notRun (the guards
// of guardNeeds it did not run, [{guard, needs, reason, newMarker?}]) from guards-result.js verdictOf: the meta of the
// guard log counts only when its exec is the spec of this run, so the meta an earlier run left (an exit before the
// slot: reuse, nothing selected, a refusal) never gives this run a verdict it did not have. An answer rebuilt for a run
// of an earlier call has no verdict.
//
// Recovery (a new call of the task, chain-run.js status and its start check): a run left without a final state is
// judged by its group: G alive -> "running without adapter" (the task waits for the coordinator: resolve --heavy ...
// stop); G gone and the file rc there -> done; started but no rc -> stopped, exit code lost; not started ->
// cancelled-before-start. A torn last line is cut off and kept beside the journal; a damaged line inside refuses.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { readNoFollow, CODEX_ADDED } = require('./commit-service');
const { verdictOf } = require('./guards-result');
const rolePlaces = require('./role-roots');

const HEAVY_CODEX_VERSIONS = Object.freeze(['0.167.0']);
// The variables codex sandbox 0.167.0 adds with --enable network_proxy (measured 2026-11-11), next to CODEX_ADDED.
const PROXY_ADDED = ['ALL_PROXY', 'BUNDLE_HTTPS_PROXY', 'BUNDLE_HTTP_PROXY', 'BUNDLE_NO_PROXY', 'BUNDLE_SSL_CA_CERT', 'CARGO_HTTP_CAINFO', 'CODEX_CA_CERTIFICATE',
  'CODEX_NETWORK_ALLOW_LOCAL_BINDING', 'CODEX_NETWORK_PROXY_ACTIVE', 'CURL_CA_BUNDLE', 'DOCKER_HTTPS_PROXY', 'DOCKER_HTTP_PROXY', 'ELECTRON_GET_USE_PROXY', 'FTP_PROXY',
  'GIT_SSH_COMMAND', 'GIT_SSL_CAINFO', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NO_PROXY', 'NPM_CONFIG_CAFILE', 'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_NOPROXY', 'NPM_CONFIG_PROXY', 'PIP_CERT', 'PIP_PROXY', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'WSS_PROXY', 'WS_PROXY', 'YARN_HTTPS_PROXY',
  'YARN_HTTP_PROXY', 'all_proxy', 'ftp_proxy', 'http_proxy', 'https_proxy', 'no_proxy', 'npm_config_cafile', 'npm_config_http_proxy', 'npm_config_https_proxy',
  'npm_config_noproxy', 'npm_config_proxy', 'ws_proxy', 'wss_proxy'];
const KILL_GRACE_MS = 30 * 1000;
const EMPTY_WAIT_MS = 30 * 1000;
const GROUP_POLL_MS = 100;
const POLL_MS = 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ARGV = 1000;
const TAIL_CHARS = 4000;
const JOURNAL_VERSION = 1;
const PROFILE = 'codis-heavy';
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const NAME_RE = /^([0-9a-f]{32})\.json$/;
const CANCEL_RE = /^([0-9a-f]{32})\.cancel$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// the kinds of a guard run; a base is a plain ref name, never an option of git (no leading dash)
const GUARD_KINDS = new Set(['full', 'select']);
const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const FINAL = new Set(['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused']);
// The gate: waits for one line "go" on stdin (EOF -> 70, another line -> 71), writes the file started, runs the
// executor as its child (never exec: the code must reach the file rc) and writes its code, published by a rename.
const GATE = 'IFS= read -r go || exit 70; [ "$go" = go ] || exit 71; s=$1 r=$2; shift 2; : > "$s"; "$@" </dev/null; c=$?; echo $c > "$r.tmp" && mv "$r.tmp" "$r"; exit $c';
// The probe, run as the executor: argv own-temp, system temp, canary outside the roots, outside address.
const PROBE_JS = "const fs=require('fs'),net=require('net'),path=require('path');const [own,sys,canary,ext]=process.argv.slice(1);const o={};"
  + "const w=(k,d)=>{try{const f=path.join(d,'.codis-probe-'+process.pid);fs.writeFileSync(f,'x');fs.unlinkSync(f);o[k]='ok';}catch(e){o[k]=e.code||'error';}};"
  + "w('own',own);w('slashTmp','/tmp');if(sys)w('sys',sys);try{fs.writeFileSync(canary,'x');o.canary='written';}catch(e){o.canary=e.code||'error';}"
  + "o.sandbox=process.env.CODEX_SANDBOX||null;o.names=Object.keys(process.env);"
  + "const out=()=>{process.stdout.write(JSON.stringify(o)+'\\n');process.exit(0);};"
  + "const srv=net.createServer((s)=>s.destroy()).listen(0,'127.0.0.1',()=>{const c=net.connect(srv.address().port,'127.0.0.1');"
  + "c.on('connect',()=>{o.loopback='connected';c.destroy();srv.close();const x=net.connect(443,ext);x.setTimeout(3000,()=>{o.outside='timeout';out();});"
  + "x.on('connect',()=>{o.outside='connected';out();});x.on('error',(e)=>{o.outside=e.code||'error';out();});});"
  + "c.on('error',(e)=>{o.loopback=e.code||'error';out();});});srv.on('error',(e)=>{o.loopback=e.code||'error';out();});";
const PROBE_OUTSIDE = '1.1.1.1';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const which = (bin, envPath) => {
  for (const d of String(envPath || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
};
// kill(-g, 0): true while the group lives (EPERM counts as alive: a group of another user, or zombies only).
const groupLives = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const signalGroup = (g, sig) => { try { process.kill(-g, sig); return 'ok'; } catch (e) { return e.code || 'error'; } };
// The start time of a process (ps in the C locale), or null.
const lstartOf = (pid) => {
  const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
  const s = p.status === 0 ? String(p.stdout).trim() : '';
  return s || null;
};
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
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

// TERM and CONT to the group (CONT: a stopped member gets the TERM), up to grace ms for it to be gone, KILL, up to wait
// ms more. 'empty' | 'not-empty' | 'eperm' (a signal refused: the group is not ours to stop).
async function stopGroup(g, graceMs, waitMs, alive) {
  const gone = async (ms) => { const end = Date.now() + ms; for (;;) { if (!alive(g)) return true; if (Date.now() >= end) return false; await sleep(GROUP_POLL_MS); } };
  if (signalGroup(g, 'SIGTERM') === 'EPERM') return 'eperm';
  signalGroup(g, 'SIGCONT');
  if (await gone(graceMs)) return 'empty';
  if (signalGroup(g, 'SIGKILL') === 'EPERM') return 'eperm';
  return (await gone(waitMs)) ? 'empty' : 'not-empty';
}

// ---- the journal
// {runs: Map id -> run, damage, torn, lastN}: a run carries every field its lines gave and state, the state of its
// last line that has one (a line holder-gone, group-empty or refused-reuse changes none). Nothing is changed on disk.
const EV_STATE = { queued: 'queued', requeued: 'queued', holding: 'holding', acquired: 'acquired', running: 'running', stopping: 'stopping',
  done: 'done', stopped: 'stopped', 'cancelled-before-start': 'cancelled-before-start', undetermined: 'undetermined', refused: 'refused' };
function readHeavyJournal(file) {
  const out = { runs: new Map(), damage: null, torn: null, lastN: 0 };
  const text = readText(file);
  if (text === null) return out;
  const lines = text.split('\n');
  const tail = lines.pop();
  if (tail) out.torn = tail;
  for (let i = 0; i < lines.length; i++) {
    let e = null;
    try { e = JSON.parse(lines[i]); } catch { /* below */ }
    if (!e || typeof e !== 'object' || e.v !== JOURNAL_VERSION || e.n !== i + 1 || typeof e.ev !== 'string' || typeof e.id !== 'string') {
      out.damage = `damaged at line ${i + 1}`;
      return out;
    }
    out.lastN = e.n;
    const r = out.runs.get(e.id) || { id: e.id };
    const { v, n, ev, ...rest } = e;
    if (own(EV_STATE, ev)) Object.assign(r, rest, { state: EV_STATE[ev] });
    else if (ev === 'holder-gone' || ev === 'group-empty' || ev === 'refused-reuse') r[ev] = true;
    else Object.assign(r, rest);
    if (ev === 'refused-reuse') r.reusedHash = e.hash;
    out.runs.set(e.id, r);
  }
  return out;
}
// The state of a run without a final state, judged by its group: {state, why?, rc?, leaderMatch?}.
function judge(r, alive) {
  if (FINAL.has(r.state)) return { state: r.state, why: r.why, rc: r.rc };
  if (!Number.isInteger(r.pgid)) return { state: 'cancelled-before-start', why: 'the adapter ended before the run started' };
  if ((alive || groupLives)(r.pgid)) {
    const leaderMatch = !!r.lstart && lstartOf(r.pgid) === r.lstart;
    return { state: 'running without adapter', leaderMatch, why: `the group ${r.pgid} lives without its adapter${leaderMatch ? '' : ' (its leader is gone or another process)'}` };
  }
  const rc = readText(r.rcFile || '');
  if (rc !== null && /^\d+\s*$/.test(rc)) return { state: 'done', rc: +rc, why: 'recovered: the group ended without its adapter' };
  if (r.started && fs.existsSync(r.started)) return { state: 'stopped', why: 'exit code lost: the group ended without its adapter and without the file rc' };
  return { state: 'cancelled-before-start', why: 'the adapter ended before the gate started the command' };
}
const stateOfFile = (file) => ({ stateDir: path.dirname(path.dirname(file)), task: path.basename(path.dirname(file)) });
// The reason a task may not start its roles, or null: a damaged journal, an undetermined run, a run whose group lives
// without its adapter (scripts/chain-run.js, the start check of a codex task).
function journalProblem(file) {
  const j = readHeavyJournal(file);
  const { stateDir, task } = stateOfFile(file);
  if (j.damage) return `the heavy journal ${file} is ${j.damage}: the heavy channel refuses every request of the task until it is repaired by hand`;
  const how = (id) => `chain-run.js status --heavy ${stateDir} --task ${task} shows it, chain-run.js resolve --heavy ${stateDir} --task ${task} --run ${id} stop decides`;
  for (const r of j.runs.values()) {
    if (r.state === 'undetermined') return `the heavy journal ${file} has an undetermined run ${r.id} (its group ${r.pgid} was not confirmed gone): ${how(r.id)}`;
    const s = judge(r);
    if (s.state === 'running without adapter') return `the heavy journal ${file}: run ${r.id} is running without adapter (${s.why}): ${how(r.id)}`;
  }
  return null;
}

// One writer of a task's journal: a lock file with the pid (a dead writer's lock is taken over), numbered lines,
// fsync before the action a line announces; a line that cannot be written whole is cut back.
function openJournal(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dir, 'heavy.lock');
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token }) + '\n', { flag: 'wx', mode: 0o600 }); break; } catch (e) {
      if (e.code !== 'EEXIST') return { error: `the heavy journal lock ${lockFile}: ${e.code || e.message}` };
      let held = null;
      try { held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* unreadable: taken as dead */ }
      if (held && Number.isInteger(held.pid) && held.pid !== process.pid) {
        try { process.kill(held.pid, 0); return { error: `another adapter (pid ${held.pid}) writes the heavy journal ${file}` }; } catch (k) { if (k.code === 'EPERM') return { error: `another adapter (pid ${held.pid}) writes the heavy journal ${file}` }; }
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
  const notes = [];
  const text = readText(file);
  if (text) {
    const tail = text.split('\n').pop();
    if (tail) {
      const kept = path.join(dir, `heavy.torn-${Date.now()}.txt`);
      fs.writeFileSync(kept, tail);
      fs.truncateSync(file, Buffer.byteLength(text) - Buffer.byteLength(tail));
      notes.push(`the last line of the heavy journal was torn: cut off and kept in ${kept}`);
    }
  }
  const j = readHeavyJournal(file);
  const fd = fs.openSync(file, 'a', 0o600);
  let lastN = j.lastN;
  return {
    j, notes,
    append(ev, extra) {
      const line = JSON.stringify(Object.assign({ v: JOURNAL_VERSION, n: lastN + 1, ts: new Date().toISOString() }, extra || {}, ev)) + '\n';
      const size = fs.fstatSync(fd).size;
      try {
        if (fs.writeSync(fd, line) !== Buffer.byteLength(line)) throw Object.assign(new Error('ENOSPC: the line was written in part'), { code: 'ENOSPC' });
        fs.fsyncSync(fd);
      } catch (e) { try { fs.ftruncateSync(fd, size); } catch { /* the open cuts it */ } throw e; }
      lastN++;
    },
    close() {
      try { fs.closeSync(fd); } catch { /* closed */ }
      try { const held = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (held.token === token) fs.rmSync(lockFile, { force: true }); } catch { /* gone */ }
    },
  };
}

// The request: exactly {id, argv, kind?, cwd?}, argv a non-empty array of strings; or a guard run {id, kind: "full",
// cwd?} / {id, kind: "select", base, cwd?} without argv. The reason, or null.
function requestProblem(r, id) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'the request is not a JSON object';
  const extra = Object.keys(r).filter((k) => !['id', 'argv', 'kind', 'cwd', 'base'].includes(k));
  if (extra.length) return `fields other than id, argv, kind, cwd and base: ${extra.slice(0, 5).join(', ')}`;
  if (r.id !== id) return 'the id differs from the name of the request file';
  if (r.cwd !== undefined && r.cwd !== null && typeof r.cwd !== 'string') return 'cwd is not a string';
  if (GUARD_KINDS.has(r.kind)) {
    if (r.argv !== undefined) return `argv is not given with kind ${r.kind}: the adapter runs guards-all.sh itself`;
    if (r.kind === 'full' && r.base !== undefined) return 'base belongs to kind select only';
    if (r.kind === 'select' && (typeof r.base !== 'string' || !BASE_RE.test(r.base))) return 'kind select needs base, a branch name or a commit (letters, digits, . _ / -, not starting with -)';
    return null;
  }
  if (r.base !== undefined) return 'base belongs to kind select only';
  if (!Array.isArray(r.argv) || !r.argv.length) return 'argv is not a non-empty array';
  if (r.argv.length > MAX_ARGV) return `more than ${MAX_ARGV} arguments`;
  if (r.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) return 'an argument that is not a string or holds a NUL';
  if (!r.argv[0]) return 'an empty command';
  if (r.kind !== undefined && r.kind !== null && (typeof r.kind !== 'string' || !KIND_RE.test(r.kind))) return 'kind is not a plain name (a-z, 0-9, _ and -)';
  if (r.cwd !== undefined && r.cwd !== null && typeof r.cwd !== 'string') return 'cwd is not a string';
  return null;
}
// Out of the channel before the queue: docker and the stand (owner decision 9); guards-all.sh in an argv (a guard run
// is the kind full or select, with the adapter's argv).
function scopeProblem(argv, kind) {
  const names = argv.map((a) => path.basename(a));
  if (kind === 'docker' || names[0] === 'docker' || names[0] === 'docker-compose' || names.includes('stand.sh')) return 'environment: Docker and the stand are outside A2b';
  if (names.includes('guards-all.sh')) return 'environment: guards-all.sh runs through the channel: heavy-req.js --kind select --base <ref> | --kind full';
  return null;
}

// o: {task, callId, role, wt, tdir, box, stateDir, config?, runId?, kinds?, userEnv?, codex?, codexVersions?, killGraceMs?,
// emptyWaitMs?, pollMs?, npmCache?, inject?, log?}. config: the absolute path of the run's project config, given as
// CODIS_AGENTS_CONFIG to every process the service starts that reads the project config - the holder, the exclusive
// check and the executor with its nested <class>.sh (role-exec.js requires it; without it they look the config up from
// the worktree, as heavy.sh does). inject (tests): probe() -> {} | {error}; executor(spec) -> spec;
// alive(g) -> boolean | undefined (undefined: the real answer); beforeGo(run).
// Returns {box, answers, cancel(reason), close()}: cancel stops every run of the call (the queued ones never start);
// close() does the same with "the call ended" and resolves, once every run is final, to {runs: [{id, state, rc}]}.
function openHeavyService(o) {
  const bad = (m) => { throw new Error(`heavy-service: ${m}`); };
  for (const k of ['task', 'callId']) if (typeof o[k] !== 'string' || !/^[A-Za-z0-9._-]+$/.test(o[k]) || o[k] === '.' || o[k] === '..') bad(`${k} must be a plain name`);
  for (const k of ['wt', 'tdir', 'box', 'stateDir']) if (typeof o[k] !== 'string' || !path.isAbsolute(o[k])) bad(`${k} must be an absolute path`);
  if (o.config !== undefined && (typeof o.config !== 'string' || !path.isAbsolute(o.config))) bad('config must be an absolute path');
  const userEnv = o.userEnv || process.env;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const inject = o.inject || {};
  const kinds = o.kinds && typeof o.kinds === 'object' ? o.kinds : {};
  const graceMs = Number.isFinite(o.killGraceMs) && o.killGraceMs > 0 ? o.killGraceMs : KILL_GRACE_MS;
  const waitMs = Number.isFinite(o.emptyWaitMs) && o.emptyWaitMs > 0 ? o.emptyWaitMs : EMPTY_WAIT_MS;
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : POLL_MS;
  const codexVersions = Array.isArray(o.codexVersions) ? o.codexVersions : HEAVY_CODEX_VERSIONS;
  const alive = (g) => { const v = inject.alive ? inject.alive(g) : undefined; return typeof v === 'boolean' ? v : groupLives(g); };
  const role = typeof o.role === 'string' ? o.role : 'role';
  const notes = [];
  const note = (m) => { if (notes.length < 50) notes.push(m); log(`heavy-service ${o.task}/${o.callId}: ${m}`); };

  const taskDir = path.join(path.resolve(o.stateDir), o.task);
  const answers = path.join(taskDir, 'heavy-calls', o.callId);
  const runsDir = path.join(taskDir, 'heavy-runs');
  fs.mkdirSync(answers, { recursive: true, mode: 0o755 });
  try { fs.mkdirSync(o.box, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!fs.lstatSync(o.box).isDirectory()) bad(`the box ${o.box} is not a folder`);
  const boxReal = fs.realpathSync(o.box);
  const wtReal = rolePlaces.realish(o.wt);
  const tdirReal = rolePlaces.realish(o.tdir);
  // the files of a guard run that live as long as its group: the executor spec and the run's TMPDIR
  const guardFiles = (r) => [path.join(runsDir, r.id, 'exec.json')].concat(r.call ? [path.join(tdirReal, 'heavy-tmp', r.call, r.id)] : []);

  // ---- the journal and the recovery of earlier calls
  let broken = null;
  if (process.platform !== 'darwin') broken = `environment: the box cannot be read safely on ${process.platform} (O_NOFOLLOW_ANY is macOS only)`;
  const jFile = path.join(taskDir, 'heavy.jsonl');
  const J = broken ? { error: broken } : openJournal(jFile);
  if (J.error) broken = broken || `environment: ${J.error}`;
  const ids = new Map(); // id -> {hash, state}
  const base = Object.assign({ call: o.callId }, o.runId ? { runId: o.runId } : {});
  const append = (ev) => J.append(ev, base);
  if (!J.error) {
    for (const n of J.notes) note(n);
    if (J.j.damage) broken = `environment: the heavy journal ${jFile} is ${J.j.damage}: the coordinator repairs it`;
    else {
      for (const r of J.j.runs.values()) {
        const s = judge(r, alive);
        if (!FINAL.has(r.state) && s.state !== 'running without adapter') {
          append(Object.assign({ ev: s.state, id: r.id, why: s.why, recovered: true }, s.rc !== undefined ? { rc: s.rc } : {}));
          if (Number.isInteger(r.pgid) && r.slot) fs.rmSync(`${r.slot}.exec.${r.pgid}`, { force: true });
          r.state = s.state;
        }
        // the executor spec and TMPDIR of a guard run live only as long as its group: gone once the run is final
        if (GUARD_KINDS.has(r.kind) && FINAL.has(r.state) && r.state !== 'undetermined') guardFiles(r).forEach((f) => fs.rmSync(f, { recursive: true, force: true }));
        if (s.state === 'running without adapter') broken = broken || `environment: run ${r.id} of an earlier call is running without adapter (${s.why}): the task waits for the coordinator (chain-run.js resolve --heavy)`;
        else if (r.state === 'undetermined') broken = broken || `environment: run ${r.id} of an earlier call is undetermined: the task waits for the coordinator (chain-run.js resolve --heavy)`;
        ids.set(r.id, { hash: r.hash, state: r.state });
      }
    }
  }

  // ---- answers: one file per request, published by a rename; never thrown
  const writeAnswer = (id, a) => {
    const tmp = path.join(answers, `.${id}.${process.pid}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, a)) + '\n'); fs.renameSync(tmp, path.join(answers, `${id}.json`)); } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* clutter */ }
      note(`request ${id}: the answer could not be written (${e.code || e.message})`);
    }
  };
  const publicOf = (r) => {
    const a = { state: r.state, kind: r.kind || null, cls: r.cls || null };
    for (const k of ['position', 'why', 'slot', 'pgid', 'log', 'rc', 'base', 'where', 'verdict', 'notRun']) if (r[k] !== undefined && r[k] !== null) a[k] = r[k];
    if (FINAL.has(r.state) && r.log) {
      a.tail = tailOf(r.log);
      const g = r.guard ? /^guards log: (.+)$/m.exec(readText(r.log) || '') : null;
      if (g) a.guardsLog = g[1];
    }
    return a;
  };
  const show = (r) => writeAnswer(r.id, publicOf(r));
  const runs = new Map(); // id -> run of this call
  const queue = [];
  let active = null;
  let closing = null; // the reason every run of the call stops with
  const finals = [];
  // the final state of a run, once (owner decision 5); journaled unless the line was written already (a refusal)
  const finalize = (r, state, extra, journaled) => {
    if (FINAL.has(r.state)) return;
    Object.assign(r, extra || {});
    r.state = state;
    if (!journaled && !J.error) {
      try { append(Object.assign({ ev: state, id: r.id }, r.why ? { why: r.why } : {}, state === 'done' ? { rc: r.rc } : {})); } catch (e) { note(`request ${r.id}: its final state ${state} is not in the journal (${e.code || e.message})`); }
    }
    const k = ids.get(r.id);
    if (k) k.state = state;
    show(r);
    for (const f of r.waiters.splice(0)) f();
  };
  const refuse = (id, hash, why) => {
    const r = { id, hash, state: 'queued', waiters: [] };
    runs.set(id, r);
    ids.set(id, { hash, state: 'refused' });
    let journaled = !!J.error;
    if (!journaled) { try { append({ ev: 'refused', id, hash, why }); journaled = true; } catch { /* the answer below stands */ } }
    finalize(r, 'refused', { why }, true);
  };

  // ---- the class of a run
  const holderEnv = () => {
    const e = Object.assign({}, userEnv);
    for (const k of ['CODIS_SLOT_HELD', 'SLOT_EXEC_NOTE', 'SLOT_PATH', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'CODIS_HEAVY_BOX', 'CODIS_HEAVY_ANSWERS', 'CODIS_GUARDS_EXEC']) delete e[k];
    if (o.config) e.CODIS_AGENTS_CONFIG = o.config;
    return e;
  };
  const exclusive = (argv, cwd) => {
    if (inject.exclusive) return inject.exclusive(argv, cwd);
    const p = spawnSync('zsh', ['-c', 'source "$1" || exit 2; shift; slot_is_exclusive_guard "$@"', 'excl', path.join(__dirname, 'slots.zsh')].concat(argv),
      { cwd, env: holderEnv(), stdio: 'ignore', timeout: 60000 });
    return p.status === 0;
  };

  // ---- the executor
  const codexBin = (() => {
    const c = o.codex === undefined ? 'codex' : o.codex;
    if (typeof c !== 'string' || !c) return null;
    if (path.isAbsolute(c)) return fs.existsSync(c) ? c : null;
    return which(c, userEnv.PATH);
  })();
  const gitDir = (() => { const g = which('git', userEnv.PATH); return g ? path.dirname(g) : null; })();
  const locale = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.@-]+$/.test(v) ? v : 'C');
  // x.slot left out (the spec of a guard run): heavy-exec.js adds SLOTS_DIR, CODIS_SLOT_HELD and GUARDS_EXCLUSIVE_LOCK
  // from the slot guards-all.sh holds
  const execEnv = (x) => {
    const dirs = [path.dirname(process.execPath)].concat(gitDir ? [gitDir] : [], SAFE_PATH.split(':'));
    // TMPPREFIX: zsh writes the temporary file of a here-doc and of =(...) there, not under /tmp, read only in the sandbox
    const e = { PATH: [...new Set(dirs)].join(':'), HOME: typeof userEnv.HOME === 'string' ? userEnv.HOME : '/', CODEX_HOME: x.codexHome, TMPDIR: x.tmpdir,
      TMPPREFIX: path.join(x.tmpdir, 'zsh'), LANG: locale(userEnv.LANG), LC_ALL: locale(userEnv.LC_ALL || userEnv.LANG) };
    if (x.slot) Object.assign(e, { SLOTS_DIR: path.dirname(x.slot), CODIS_SLOT_HELD: `${x.cls} ${x.slot}`, GUARDS_EXCLUSIVE_LOCK: x.lock });
    // the nested <class>.sh and every heavy.sh / medium.sh of the argv read the run's config, as the holder and the
    // exclusive check do: its guardExclusive decides which guard takes the exclusive lock, whatever the worktree holds
    if (o.config) e.CODIS_AGENTS_CONFIG = o.config;
    if (typeof o.npmCache === 'string' && path.isAbsolute(o.npmCache)) e.npm_config_cache = o.npmCache;
    return e;
  };
  const profileText = () => {
    const fsx = [wtReal, tdirReal].map((r) => `${JSON.stringify(r)}="write"`)
      .concat([path.join(wtReal, '.git'), path.join(wtReal, '.codex')].map((r) => `${JSON.stringify(r)}="read"`), ['":slash_tmp"="read"']);
    return `permissions.${PROFILE}={extends=":workspace",filesystem={${fsx.join(',')}},network={enabled=true,mode="limited",allow_local_binding=true}}`;
  };
  // codex sandbox with the profile of the role's rights, up to -C <cwd> -- <argv> (heavy-exec.js adds those for a guard run)
  const sandboxArgs = () => ['sandbox', '--enable', 'network_proxy', '-c', `default_permissions=${JSON.stringify(PROFILE)}`, '-c', profileText(), '-P', PROFILE];
  const specOf = (inner, env, cwd) => {
    let spec = { bin: codexBin, args: sandboxArgs().concat(['-C', cwd, '--'], inner), inner, env, cwd };
    if (inject.executor) spec = inject.executor(spec) || spec;
    return spec;
  };
  // codex of the channel's list and the probe of the profile, once per call: {} or {error}
  let ready = null;
  const probe = async () => {
    if (inject.probe) return inject.probe();
    if (!codexBin) return { error: 'codex not found' };
    const v = spawnSync(codexBin, ['--version'], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:${SAFE_PATH}`, HOME: userEnv.HOME || '/' }, timeout: 60000 });
    const ver = (/(\d+\.\d+\.\d+)/.exec(`${v.stdout || ''}`) || [])[1];
    if (!ver) return { error: `codex --version failed (rc ${v.status})` };
    if (!codexVersions.includes(ver)) return { error: `codex ${ver} is not among the versions of the heavy channel (${codexVersions.join(', ')}): its profile was measured there` };
    const dir = path.join(runsDir, `probe-${o.callId}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const tmpdir = path.join(tdirReal, 'heavy-tmp', o.callId, 'probe');
    for (const d of [dir, path.join(dir, 'codex-home'), tmpdir]) fs.mkdirSync(d, { recursive: true });
    const canary = path.join(dir, 'canary');
    const sys = (spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout || '').trim();
    const env = execEnv({ codexHome: path.join(dir, 'codex-home'), tmpdir, slot: path.join(dir, 'probe.0.lock'), cls: 'heavy', lock: path.join(dir, 'exclusive.lock') });
    const spec = specOf([process.execPath, '-e', PROBE_JS, tmpdir, sys, canary, PROBE_OUTSIDE], env, wtReal);
    const p = await new Promise((resolve) => {
      let out = '', err = '';
      let c;
      try { c = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ error: e.code || e.message }); return; }
      c.stdout.on('data', (b) => { if (out.length < 1e6) out += b; });
      c.stderr.on('data', (b) => { if (err.length < 1e5) err += b; });
      c.on('error', (e) => resolve({ error: e.code || e.message }));
      c.on('close', (rc) => resolve({ rc, out, err }));
    });
    const wrote = fs.existsSync(canary);
    fs.rmSync(tmpdir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    if (p.error) return { error: `codex sandbox could not be launched (${p.error})` };
    let j = null;
    try { j = JSON.parse(p.out.trim().split('\n').pop()); } catch { /* below */ }
    if (!j) return { error: `the probe gave no answer (rc ${p.rc}): ${String(p.err).trim().slice(-300)}` };
    if (wrote || j.canary === 'written') return { error: 'the probe wrote outside the roots' };
    if (j.own !== 'ok') return { error: `its own TMPDIR is not writable (${j.own})` };
    if (j.slashTmp === 'ok') return { error: '/tmp is writable' };
    if (j.sys === 'ok') return { error: 'the system TMPDIR is writable' };
    if (j.loopback !== 'connected') return { error: `listen and connect on 127.0.0.1 failed (${j.loopback})` };
    if (j.outside === 'connected') return { error: `an outside address (${PROBE_OUTSIDE}) was reached` };
    if (j.sandbox !== 'seatbelt') return { error: `CODEX_SANDBOX=${j.sandbox}` };
    // the variables of the adapter's side of the channel never reach the executor, whatever the white list says
    const side = (j.names || []).filter((n) => ['CODIS_GUARDS_EXEC', 'CODIS_HEAVY_BOX', 'CODIS_HEAVY_ANSWERS'].includes(n));
    if (side.length) return { error: `variables of the channel in the executor: ${side.join(', ')}` };
    const allowed = new Set(Object.keys(env).concat(CODEX_ADDED, PROXY_ADDED));
    const extra = (j.names || []).filter((n) => !allowed.has(n));
    if (extra.length) return { error: `variables outside the white list: ${extra.slice(0, 5).join(', ')}` };
    return {};
  };

  // ---- the holder: resolves {slot} | {exit: {rc, sig, err}} | {cancelled}
  const hold = (r) => new Promise((resolve) => {
    const env = holderEnv();
    env.SLOT_LABEL = `codex ${o.task} ${role} ${r.id}`;
    let h;
    try { h = spawn('zsh', [path.join(__dirname, 'slot-hold.sh'), r.cls], { cwd: wtReal, env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) {
      resolve({ exit: { rc: null, sig: null, err: e.code || e.message } });
      return;
    }
    r.holder = h; r.holderPid = h.pid; r.holderGone = false;
    let out = '', err = '', got = false;
    h.stdin.on('error', () => { /* EPIPE: the holder is gone */ });
    try { append({ ev: 'holding', id: r.id, pid: h.pid }); } catch (e) { note(`request ${r.id}: holding not journaled (${e.code || e.message})`); }
    r.state = 'holding'; show(r);
    h.stdout.on('data', (b) => {
      out += b;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const l = out.slice(0, i); out = out.slice(i + 1);
        const w = /^waiting for slot \S+, position (\d+) in queue \([^)]*\): (.*)$/.exec(l);
        if (w && !got) { r.position = +w[1]; r.why = w[2]; show(r); continue; }
        const a = /^acquired (.+) (\d+\.\d+)$/.exec(l);
        if (a && !got) { got = true; r.position = null; r.why = null; resolve({ slot: a[1] }); }
      }
    });
    h.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    h.on('exit', (rc, sig) => {
      r.holderGone = true;
      if (r.holderExitWaiters) for (const f of r.holderExitWaiters.splice(0)) f();
      if (got) {
        if (r.state === 'running' && !r.released) { try { append({ ev: 'holder-gone', id: r.id, rc, sig }); } catch { /* the state stands */ } }
        return;
      }
      resolve(r.cancel ? { cancelled: true } : { exit: { rc, sig, err } });
    });
  });
  // slot-hold.sh lives: not gone, not a zombie (a killed child stays one until Node reaps it)
  const holderLives = (r) => {
    if (r.holderGone) return false;
    const p = spawnSync('ps', ['-o', 'stat=', '-p', String(r.holderPid)], { encoding: 'utf8' });
    const st = p.status === 0 ? String(p.stdout).trim() : '';
    return !!st && !st.startsWith('Z');
  };
  const holderExit = (r) => (r.holderGone ? Promise.resolve() : new Promise((f) => { (r.holderExitWaiters = r.holderExitWaiters || []).push(f); }));
  const release = async (r) => {
    r.released = true;
    // "release" reaches the holding loop through the pipe even when slot-hold.sh itself is gone (the loop inherited it)
    if (r.holder) { try { r.holder.stdin.end('release\n'); } catch { /* gone */ } await holderExit(r); }
  };

  // ---- one run, from the holder to its final state
  const execute = async (r) => {
    if (closing && !r.cancel) r.cancel = closing;
    if (r.cancel) return finalize(r, 'cancelled-before-start', { why: r.cancel });
    if (!ready) ready = await probe();
    if (ready.error) return finalize(r, 'refused', { why: `environment: no safe executor: ${ready.error}` });
    if (r.guard) return executeGuards(r);
    let gate = null, slot = null;
    for (;;) {
      if (r.cancel) return finalize(r, 'cancelled-before-start', { why: r.cancel });
      const h = await hold(r);
      if (h.cancelled) return finalize(r, 'cancelled-before-start', { why: r.cancel });
      if (h.exit) return finalize(r, 'cancelled-before-start', { why: `environment: the slot queue refused (slot-hold.sh exit ${h.exit.rc === null ? h.exit.sig : h.exit.rc}): ${String(h.exit.err).trim().slice(-500)}` });
      slot = h.slot;
      r.slot = slot;
      append({ ev: 'acquired', id: r.id, slot });
      r.state = 'acquired'; show(r);
      const lock = typeof userEnv.GUARDS_EXCLUSIVE_LOCK === 'string' && userEnv.GUARDS_EXCLUSIVE_LOCK ? userEnv.GUARDS_EXCLUSIVE_LOCK : path.join(path.dirname(slot), 'exclusive.lock');
      try { fs.closeSync(fs.openSync(lock, 'a', 0o644)); } catch (e) {
        await release(r);
        return finalize(r, 'cancelled-before-start', { why: `environment: the exclusive lock file ${lock} cannot be created (${e.code || e.message})` });
      }
      if (r.cancel) { await release(r); return finalize(r, 'cancelled-before-start', { why: r.cancel }); }
      const dir = path.join(runsDir, r.id);
      fs.rmSync(dir, { recursive: true, force: true });
      const tmpdir = path.join(tdirReal, 'heavy-tmp', o.callId, r.id);
      for (const d of [dir, path.join(dir, 'codex-home'), tmpdir]) fs.mkdirSync(d, { recursive: true });
      Object.assign(r, { log: path.join(dir, 'out.log'), started: path.join(dir, 'started'), rcFile: path.join(dir, 'rc') });
      const inner = ['zsh', path.join(__dirname, `${r.cls}.sh`)].concat(r.argv);
      const spec = specOf(inner, execEnv({ codexHome: path.join(dir, 'codex-home'), tmpdir, slot, cls: r.cls, lock }), r.cwd);
      let logFd;
      try {
        logFd = fs.openSync(r.log, 'w', 0o644);
        gate = spawn('/bin/sh', ['-c', GATE, 'gate', r.started, r.rcFile, spec.bin].concat(spec.args), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['pipe', logFd, logFd] });
      } catch (e) {
        if (logFd !== undefined) fs.closeSync(logFd);
        await release(r);
        return finalize(r, 'cancelled-before-start', { why: `environment: the gate could not be started (${e.code || e.message})` });
      }
      fs.closeSync(logFd);
      gate.stdin.on('error', () => { /* the gate is gone */ });
      gate.exited = new Promise((f) => gate.on('exit', (rc, sig) => f({ rc, sig })));
      gate.on('error', () => { /* the exit event follows */ });
      r.pgid = gate.pid;
      const lstart = lstartOf(gate.pid);
      append({ ev: 'running', id: r.id, pgid: gate.pid, lstart, slot, log: r.log, started: r.started, rcFile: r.rcFile });
      const tmp = `${slot}.exectmp.${gate.pid}`, mark = `${slot}.exec.${gate.pid}`;
      try { fs.writeFileSync(tmp, `${gate.pid}\n`); fs.renameSync(tmp, mark); } catch (e) {
        fs.rmSync(tmp, { force: true });
        gate.stdin.end();
        await gate.exited;
        await release(r);
        return finalize(r, 'cancelled-before-start', { why: `environment: the exec marker ${mark} cannot be written (${e.code || e.message})` });
      }
      r.marker = mark;
      if (inject.beforeGo) inject.beforeGo(r);
      if (!holderLives(r)) {
        // the holder died before "go": the slot is no longer known to be held, so nothing runs - the gate ends with 70,
        // the holding loop gets EOF, and the run waits for a new holder
        gate.stdin.end();
        try { r.holder.stdin.end(); } catch { /* gone */ }
        await gate.exited;
        for (let i = 0; i < 50 && alive(gate.pid); i++) await sleep(GROUP_POLL_MS);
        fs.rmSync(mark, { force: true });
        append({ ev: 'requeued', id: r.id, why: 'the holder died before the command started' });
        r.state = 'queued'; r.pgid = null; show(r);
        await holderExit(r);
        continue;
      }
      gate.stdin.end('go\n');
      r.state = 'running'; show(r);
      break;
    }
    // ---- the end of the run
    const how = await Promise.race([gate.exited.then((x) => ({ exit: x })), r.stopP.then((reason) => ({ stop: reason }))]);
    let res = 'empty';
    if (how.stop) {
      append({ ev: 'stopping', id: r.id, reason: how.stop });
      r.state = 'stopping'; show(r);
      res = await stopGroup(r.pgid, graceMs, waitMs, alive);
    } else if (alive(r.pgid)) res = await stopGroup(r.pgid, graceMs, waitMs, alive);
    if (res !== 'empty') {
      await release(r);
      return finalize(r, 'undetermined', { why: `environment: run undetermined: the group ${r.pgid} ${res === 'eperm' ? 'refused a signal (EPERM)' : 'was not gone after KILL'}; its marker keeps the slot busy until it ends` });
    }
    append({ ev: 'group-empty', id: r.id });
    fs.rmSync(r.marker, { force: true });
    await release(r);
    const rc = readText(r.rcFile);
    if (rc !== null && /^\d+\s*$/.test(rc)) return finalize(r, 'done', { rc: +rc, why: null });
    const g = await gate.exited;
    return finalize(r, 'stopped', { why: how.stop || `exit code lost: the gate ended ${g.sig ? `by ${g.sig}` : `with ${g.rc}`}` });
  };
  // ---- a guard run: guards-all.sh in the gate, its own slot; the executor through heavy-exec.js
  const executeGuards = async (r) => {
    const dir = path.join(runsDir, r.id);
    fs.rmSync(dir, { recursive: true, force: true });
    const tmpdir = path.join(tdirReal, 'heavy-tmp', o.callId, r.id);
    for (const d of [dir, path.join(dir, 'codex-home'), tmpdir]) fs.mkdirSync(d, { recursive: true });
    Object.assign(r, { log: path.join(dir, 'out.log'), started: path.join(dir, 'started'), rcFile: path.join(dir, 'rc'), call: o.callId });
    const clean = () => { for (const f of guardFiles(r)) fs.rmSync(f, { recursive: true, force: true }); };
    const spec = { bin: codexBin, args: sandboxArgs(), env: execEnv({ codexHome: path.join(dir, 'codex-home'), tmpdir }), label: `codex ${o.task} ${role} ${r.id}` };
    const specFile = path.join(dir, 'exec.json');
    let logFd, gate;
    try {
      fs.writeFileSync(specFile, JSON.stringify(spec) + '\n', { mode: 0o600 });
      if (r.cancel) { clean(); return finalize(r, 'cancelled-before-start', { why: r.cancel }); }
      const env = Object.assign(holderEnv(), { CODIS_GUARDS_EXEC: specFile });
      logFd = fs.openSync(r.log, 'w', 0o644);
      gate = spawn('/bin/sh', ['-c', GATE, 'gate', r.started, r.rcFile].concat(r.argv), { cwd: wtReal, env, detached: true, stdio: ['pipe', logFd, logFd] });
    } catch (e) {
      if (logFd !== undefined) fs.closeSync(logFd);
      clean();
      return finalize(r, 'cancelled-before-start', { why: `environment: the gate could not be started (${e.code || e.message})` });
    }
    fs.closeSync(logFd);
    gate.stdin.on('error', () => { /* the gate is gone */ });
    gate.exited = new Promise((f) => gate.on('exit', (rc, sig) => f({ rc, sig })));
    gate.on('error', () => { /* the exit event follows */ });
    r.pgid = gate.pid;
    append({ ev: 'running', id: r.id, pgid: gate.pid, lstart: lstartOf(gate.pid), log: r.log, started: r.started, rcFile: r.rcFile });
    if (inject.beforeGo) inject.beforeGo(r);
    gate.stdin.end('go\n');
    r.state = 'running'; show(r);
    const how = await Promise.race([gate.exited.then((x) => ({ exit: x })), r.stopP.then((reason) => ({ stop: reason }))]);
    let res = 'empty';
    if (how.stop) {
      append({ ev: 'stopping', id: r.id, reason: how.stop });
      r.state = 'stopping'; show(r);
      res = await stopGroup(r.pgid, graceMs + waitMs, waitMs, alive);
    } else if (alive(r.pgid)) res = await stopGroup(r.pgid, graceMs + waitMs, waitMs, alive);
    if (res !== 'empty') return finalize(r, 'undetermined', { why: `environment: run undetermined: the group ${r.pgid} ${res === 'eperm' ? 'refused a signal (EPERM)' : 'was not gone after KILL'}` });
    append({ ev: 'group-empty', id: r.id });
    clean();
    r.why = null;
    const rc = readText(r.rcFile);
    if (rc !== null && /^\d+\s*$/.test(rc)) {
      const gl = /^guards log: (.+)$/m.exec(readText(r.log) || '');
      let meta = null;
      try { meta = gl ? JSON.parse(fs.readFileSync(`${gl[1]}.meta.json`, 'utf8')) : null; } catch { /* no meta: not this run's */ }
      return finalize(r, 'done', Object.assign({ rc: +rc }, verdictOf(+rc, meta, specFile)));
    }
    const g = await gate.exited;
    return finalize(r, 'stopped', { why: how.stop || `exit code lost: the gate ended ${g.sig ? `by ${g.sig}` : `with ${g.rc}`}` });
  };
  // the why of a guard run while guards-all.sh waits: the last line of the gate's log, when it starts with "waiting for"
  const guardWhy = (r) => {
    const last = tailOf(r.log).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    const why = /^waiting for /.test(last) ? last : null;
    if (why !== r.why) { r.why = why; show(r); }
  };
  const pump = () => {
    if (active || !queue.length) return;
    active = queue.shift();
    const r = active;
    execute(r).catch((e) => { note(`request ${r.id}: ${e.stack || e.message}`); finalize(r, 'stopped', { why: `the adapter failed: ${e.message}` }); })
      .then(() => { active = null; pump(); });
    behind();
  };
  // the reason of every request waiting in the adapter's queue (one run at a time per call)
  const behind = () => { for (const [i, q] of queue.entries()) { q.why = `behind run ${i ? queue[i - 1].id : active.id} of this call`; show(q); } };
  // a stop of a run in any state; a run past its start gets one stop only (a second one changes nothing)
  const stopRun = (r, reason) => {
    if (FINAL.has(r.state)) return;
    if (!r.cancel) r.cancel = reason;
    if (r.state === 'queued' && active !== r) {
      const i = queue.indexOf(r);
      if (i >= 0) queue.splice(i, 1);
      finalize(r, 'cancelled-before-start', { why: reason });
      return;
    }
    if (r.state === 'holding' && r.holder && !r.holderGone) { try { process.kill(r.holderPid, 'SIGTERM'); } catch { /* gone */ } }
    r.stopF(reason);
  };

  // ---- the box: a scan reads new requests and cancels; fs.watch is only a signal, the poll goes on
  const reusedSeen = new Set();
  // a guard run tests the committed HEAD: tracked changes refuse it; a base must name a commit. The reason, or null.
  const guardProblem = (q) => {
    const git = (...a) => spawnSync(gitDir ? path.join(gitDir, 'git') : 'git', ['-C', wtReal].concat(a), { encoding: 'utf8', env: holderEnv(), timeout: 60000 });
    const st = git('status', '--porcelain', '--untracked-files=no');
    if (st.status !== 0) return `environment: git status in the worktree failed (${String(st.stderr || st.error || '').trim().slice(0, 300)})`;
    if (String(st.stdout).trim()) return 'tracked changes in the worktree: commit first (a guard run tests the committed HEAD)';
    if (q.kind === 'select' && git('rev-parse', '--verify', '--quiet', `${q.base}^{commit}`).status !== 0) return `unknown base ${q.base}: not a commit of the worktree's repository`;
    return null;
  };
  const handle = (id, rd) => {
    const hash = rd.bytes ? sha256(rd.bytes) : `error:${rd.code}`;
    const known = ids.get(id);
    if (known) {
      if (known.hash !== hash && !reusedSeen.has(id + hash)) {
        reusedSeen.add(id + hash);
        if (!J.error) { try { append({ ev: 'refused-reuse', id, hash }); } catch { /* noted below */ } }
        note(`request ${id}: the same id with other content: refused, its first state stands`);
      }
      if (!fs.existsSync(path.join(answers, `${id}.json`))) writeAnswer(id, { state: known.state, why: 'a run of an earlier call: chain-run.js status --heavy' });
      return;
    }
    if (rd.error) return refuse(id, hash, `the request file: ${rd.error}`);
    if (broken) return refuse(id, hash, broken);
    let q = null;
    try { q = JSON.parse(rd.bytes.toString('utf8')); } catch { return refuse(id, hash, 'the request is not JSON'); }
    const why = requestProblem(q, id);
    if (why) return refuse(id, hash, why);
    const guard = GUARD_KINDS.has(q.kind);
    const sp = guard ? null : scopeProblem(q.argv, q.kind);
    if (sp) return refuse(id, hash, sp);
    const cwd = rolePlaces.realish(q.cwd ? path.resolve(wtReal, q.cwd) : wtReal);
    if (!rolePlaces.within(cwd, wtReal)) return refuse(id, hash, `cwd ${q.cwd} resolves to ${cwd}, outside the worktree`);
    if (!fs.existsSync(cwd)) return refuse(id, hash, `cwd ${q.cwd} does not exist`);
    if (closing) return refuse(id, hash, closing);
    const kind = q.kind || null;
    let cls = !guard && kind && own(kinds, kind) && kinds[kind] === 'medium' ? 'medium' : 'heavy';
    if (cls === 'medium' && exclusive(q.argv, cwd)) cls = 'heavy';
    let argv = q.argv;
    if (guard) {
      const gp = guardProblem(q);
      if (gp) return refuse(id, hash, gp);
      argv = ['zsh', path.join(__dirname, 'guards-all.sh'), '--local'].concat(kind === 'select' ? ['--select', q.base] : ['--quarantine-read-only'], [wtReal]);
    }
    const r = Object.assign({ id, hash, kind, cls, argv, cwd: guard ? wtReal : cwd, state: 'queued', why: null, waiters: [] },
      guard ? { guard: true, where: kind === 'select' ? 'local selection' : 'local full run' } : {}, kind === 'select' ? { base: q.base } : {});
    r.stopP = new Promise((f) => { r.stopF = f; });
    runs.set(id, r);
    ids.set(id, { hash, state: 'queued' });
    try { append(Object.assign({ ev: 'queued', id, hash, kind, cls, argv, cwd: r.cwd }, r.base ? { base: r.base } : {})); } catch (e) { return finalize(r, 'refused', { why: `environment: the heavy journal cannot be written (${e.code || e.message})` }, true); }
    queue.push(r);
    show(r);
    if (active) behind();
    pump();
  };
  const scan = () => {
    let names;
    try { if (!fs.lstatSync(o.box).isDirectory()) return; names = fs.readdirSync(boxReal); } catch { return; }
    const reqs = [];
    for (const name of names) {
      const m = NAME_RE.exec(name);
      if (m) { reqs.push({ id: m[1], rd: readNoFollow(path.join(boxReal, name), MAX_REQUEST_BYTES) }); continue; }
      const c = CANCEL_RE.exec(name);
      if (c && runs.get(c[1]) && runs.get(c[1]).stopF) stopRun(runs.get(c[1]), 'cancelled by the role');
    }
    if (active && active.guard && active.state === 'running' && active.log) guardWhy(active);
    reqs.sort((a, b) => ((a.rd.st ? a.rd.st.birthtimeMs : 0) - (b.rd.st ? b.rd.st.birthtimeMs : 0)) || (a.id < b.id ? -1 : 1));
    for (const x of reqs) { try { handle(x.id, x.rd); } catch (e) { note(`request ${x.id}: ${e.message}`); } }
  };
  let kicked = false;
  const kick = () => { if (kicked) return; kicked = true; setImmediate(() => { kicked = false; scan(); }); };
  let watcher = null;
  try { watcher = fs.watch(boxReal, () => kick()); watcher.on('error', () => { try { watcher.close(); } catch { /* closed */ } watcher = null; }); } catch { watcher = null; }
  const timer = setInterval(scan, pollMs);
  scan();

  const stopAll = (reason) => {
    if (!closing) closing = reason;
    for (const r of runs.values()) if (r.stopF) stopRun(r, reason);
  };
  let closeP = null;
  return {
    box: o.box,
    answers,
    notes: () => notes.slice(),
    cancel(reason) { stopAll(reason === 'signalled' ? 'the adapter got a signal' : String(reason || 'cancelled')); },
    close() {
      if (closeP) return closeP;
      closeP = (async () => {
        scan();
        clearInterval(timer);
        if (watcher) { try { watcher.close(); } catch { /* closed */ } }
        stopAll(closing || 'the call ended');
        const live = [...runs.values()].filter((r) => !FINAL.has(r.state));
        await Promise.all(live.map((r) => new Promise((f) => r.waiters.push(f))));
        if (!J.error) J.close();
        return { runs: [...runs.values()].map((r) => ({ id: r.id, state: r.state, rc: r.rc === undefined ? null : r.rc })), notes: notes.slice() };
      })();
      return closeP;
    },
  };
}

// ---- the conductor's side (scripts/chain-run.js): status and resolve of a task's runs
// status: {task, runs: [{id, kind, cls, state, why?, rc?, slot?, pgid?, log?, call?, position?}], notes}
function status(stateDir, task) {
  const file = path.join(stateDir, task, 'heavy.jsonl');
  const j = readHeavyJournal(file);
  const notes = [];
  if (j.torn) notes.push(`the last line of ${file} is torn (cut off by the next writer)`);
  if (j.damage) notes.push(`${file} is ${j.damage}`);
  const runs = [];
  for (const r of j.runs.values()) {
    const s = judge(r);
    const e = { id: r.id, kind: r.kind || null, cls: r.cls || null, state: s.state };
    for (const [k, v] of [['why', s.why], ['rc', s.rc], ['base', r.base], ['slot', r.slot], ['pgid', r.pgid], ['log', r.log], ['call', r.call]]) if (v !== undefined && v !== null) e[k] = v;
    if (!FINAL.has(s.state) && r.call) {
      try { const a = JSON.parse(fs.readFileSync(path.join(stateDir, task, 'heavy-calls', r.call, `${r.id}.json`), 'utf8')); if (a.position) e.position = a.position; if (a.why && !e.why) e.why = a.why; } catch { /* no answer */ }
    }
    runs.push(e);
  }
  return { task, file, runs, notes };
}
// resolve --heavy ... --run <id> stop: the group of a run left without its adapter is stopped when its leader is the
// process of the record (pid = pgid and the same start time); a group already gone is recorded as stopped. Never a
// signal to a group whose leader is gone or another process: its slot stays held by the marker until the group ends.
// -> {ok, state?, why}
async function resolveStop(stateDir, task, id, o) {
  const x = o || {};
  const file = path.join(stateDir, task, 'heavy.jsonl');
  const J = openJournal(file);
  if (J.error) return { ok: false, why: J.error };
  try {
    if (J.j.damage) return { ok: false, why: `${file} is ${J.j.damage}: repair it by hand` };
    const r = J.j.runs.get(id);
    if (!r) return { ok: false, why: `no run ${id} in ${file}` };
    if (FINAL.has(r.state) && r.state !== 'undetermined') return { ok: false, why: `run ${id} is ${r.state}: nothing to stop` };
    const app = (ev) => J.append(Object.assign({ id, by: 'resolve' }, x.note ? { note: x.note } : {}, ev));
    const rmMark = () => { if (r.slot && Number.isInteger(r.pgid)) fs.rmSync(`${r.slot}.exec.${r.pgid}`, { force: true }); };
    if (!Number.isInteger(r.pgid) || !groupLives(r.pgid)) {
      rmMark();
      const s = judge(Object.assign({}, r, { state: 'running' }));
      app(Object.assign({ ev: s.state === 'done' ? 'done' : 'stopped', why: `stopped by resolve: ${s.why}` }, s.state === 'done' ? { rc: s.rc } : {}));
      return { ok: true, state: s.state === 'done' ? 'done' : 'stopped', why: s.why };
    }
    if (!r.lstart || lstartOf(r.pgid) !== r.lstart) return { ok: false, why: `leader gone: the slot stays held by the marker until the group ends (group ${r.pgid}, its leader is not the process of the record)` };
    app({ ev: 'stopping', reason: 'resolve' });
    // a guard run: the holder of its slot stops the runner with its own two pauses, so the group gets both before KILL
    const grace = x.graceMs || (GUARD_KINDS.has(r.kind) ? KILL_GRACE_MS + EMPTY_WAIT_MS : KILL_GRACE_MS);
    const res = await stopGroup(r.pgid, grace, x.waitMs || EMPTY_WAIT_MS, groupLives);
    if (res !== 'empty') { app({ ev: 'undetermined', why: `resolve: the group ${r.pgid} ${res === 'eperm' ? 'refused a signal (EPERM)' : 'was not gone after KILL'}` }); return { ok: false, state: 'undetermined', why: 'the group was not confirmed gone' }; }
    rmMark();
    app({ ev: 'stopped', why: 'stopped by resolve' });
    return { ok: true, state: 'stopped', why: 'stopped by resolve' };
  } finally { J.close(); }
}

module.exports = { GUARD_KINDS, openHeavyService, readHeavyJournal, journalProblem, status, resolveStop, requestProblem, scopeProblem, stopGroup, HEAVY_CODEX_VERSIONS, PROXY_ADDED, KILL_GRACE_MS, EMPTY_WAIT_MS, MAX_REQUEST_BYTES, PROFILE };
