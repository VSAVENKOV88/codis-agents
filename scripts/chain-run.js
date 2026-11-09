#!/usr/bin/env node
'use strict';
// The conductor: runs workflows/role-chain.js outside the Claude Workflow runtime, as a detached Node
// process, with every role run through the role adapter (scripts/role-exec.js createAgent) on the host CLI - claude or
// codex. The script is loaded as tests/role-chain.test.js loads it (`export const meta` -> `const meta`) with the
// globals agent, pipeline, parallel, log, phase, args, exec and checkpoint; under Workflow there is no exec and no
// checkpoint, and the script runs as before.
// Service steps (the post-checks, the sha of a head, the merge-only check, the wait steps of the selection and the train)
// come as data, exec(step) (owner 2026-11-06, answer 1): the conductor runs their argv itself (execStep), never as an
// agent, on both hosts. Before pre it runs env-check.js the same way and the script hands its result, stamped with the
// time of the check, to the pre prompt (answer 3).
// The outcome of the adapter stays apart from the verdict of a role (answer 4): every call that did not end ok is named
// in the field adapter of its task's result - {label, outcome, cause, error, callDir, rc, signal, stderr?}; cause is the
// outcome when the fields of the call establish it (CAUSE_KNOWN), otherwise "unknown"; the conductor never sets the
// field environment.
// On codex every role call that passes the adapter's static refusals first gets the check of the hook (owner answer 5,
// scripts/codex-hooks-check.js --codex-home <run home> --cwd <task dir> --codex <codex bin>, hookGate): exit 0 runs the
// role, 1 ends the call as hook-untrusted, 2 as refused, 3 or anything else as hook-unverified (cause unknown); the role
// is not started then. Checks of one run home run one after the other. pre runs on codex (preconditionsByConductor).
// prog and test on codex commit through the commit channel of the adapter (adapterCfg: cfg.commit): its state folder is
// <sharedDir>/runs/.commit, one per project (owner 2026-11-09), so the journal of a task survives its runs and every
// event carries the runId of its run; the commits go to the branch of the task, authored by commitAuthor of the config
// or else user.name/user.email of git. Before any role of a codex task the conductor stops it when there is no author
// (authorProblem) or, under the task's lock, when its commit journal is damaged or holds an undetermined step
// (commitJournalProblem): such a task waits for resolve --commits instead of running roles whose commits are refused.
// Every step of a task is journaled (owner 2026-11-06, answer 2; scripts/chain-journal.js, makeSteps): the intent with its
// stepId goes to disk before the step runs, then its launch, then its result, before the script gets the value; a role's
// launch comes through the gate of the adapter before the CLI does any work (cfg.onLaunch), a service step's right after
// its spawn (no gate: an intent without a launch does not prove such a step did not start), a wait step's from the answer
// of wait-step.js start. settled carries the counters of the script (checkpoint) after it took a result. A line or a
// snapshot that cannot be written stops the task ("journal/run-state not written"): what it announces does not run, and
// a result that is not on disk does not reach the script.
//
// usage:
//   chain-run.js start --host claude|codex --tasks <tasks.json> [--owner <file>] [--config <codis-agents.json>]
//                [--bin <host CLI>] [--codex-home <dir>] [--codex-auth chatgpt|apiKeyFile] [--codex-key-file <file>]
//     Checks the tasks file by its form (a JSON array of objects with a key; fields are strings, booleans, lists of
//     strings or a plain object), the config (scripts/config.js json) and the adapter's refusals (task keys, the run
//     home of codex) before anything is written; then makes the run folder <sharedDir>/runs/<run-id>/ and starts the
//     conductor detached, in a session of its own (Ctrl+C or the hang-up of this terminal does not reach it). It waits
//     for the conductor's "ready" over IPC (no timer), which comes after the locks of the tasks, and prints {runId,
//     runDir, pid, tasks: {<key>: "held" or why the task stopped before any role}}.
//     A state folder (<sharedDir>/runs, or <sharedDir>/runs/.commit through a link) inside a write root of a role
//     (stateRootProblem) and a task key that cannot name files of the state are refused here too. A codex task without
//     an author of its commits, or whose commit journal is undetermined or damaged, is named with that reason.
//     Exit: 0 started; 64 arguments, tasks file, owner file, a refusal of the adapter or the place of the state; 65 the
//     config is not found or invalid; 70 the conductor died before it was ready (the tail of its output on stderr).
//   chain-run.js status <run-id|run folder> [--wait <s>] [--config <file>]
//     Prints JSON {state: running|finished|dead, ...}; while the run is not finished each task has its open steps (open:
//     stepId, label, since, effect, pid, text as openStepText gives it) and journal {seq, snapshot, segments, torn, error}; a
//     dead run also its unrecordedCalls, and unrecordedCallsError when calls.jsonl cannot be read.
//     --wait blocks until the run ends or <s> seconds pass, at most
//     270 (the end of the wait means "still running", not an error); without --wait it answers at once. Ctrl+C ends
//     only the watch (exit 130), never the run. Exit: 0 finished (results.json is there; the verdicts are in it);
//     3 running; 4 dead (the conductor is gone without results.json); 64 unknown run or arguments.
//   chain-run.js stop <run-id|run folder> [--config <file>]
//     Sends SIGTERM to the conductor's own pid (never its group), only when run.json names a pid above 1 whose start
//     time (ps, spaces folded on both sides) is the recorded one; it waits for nothing (the end: status --wait). The first
//     check that fires decides. Exit: 0 sent ({sent, pid, runId}); 2 the run is over (results.json is there: {state:
//     finished, exitCode}); 4 the conductor is gone, also when its pid is another process now ({state: dead}); 6 the
//     identity cannot be established - no run.json yet, not readable, a pid that is no integer above 1, no start time,
//     ps or kill(pid, 0) not answering ({state: unknown, why}); 64 arguments or an unknown run. Ctrl+C or the hang-up of
//     the starter's terminal never reach the conductor: stop, or kill <pid> by hand, is the way to stop a run.
//   chain-run.js resolve ... | resolve --list ... | resolve --commits ...; chain-run.js status --commits <dir> --task <k>
//     The coordinator's decisions on what a dead run left (scripts/chain-resolve.js, its header and USAGE). status
//     prints per task its basis and its decisions; a refused start prints the basis of every run it names.
//   chain-run.js run <run folder>
//     The conductor itself (started by `start`; it reads <run folder>/request.json). Exit: 0 every task done; 3 a task
//     is not done; 4 the chain script threw, or results.json could not be written; 5 the run folder already has its writer;
//     128+n after its first SIGTERM, SIGINT or SIGHUP (143, 130, 129) that came before results.json, whatever the tasks
//     reached, also when results.json could not be written. On that signal no new step starts, the live roles get SIGTERM
//     and SIGKILL after the pause of the adapter, a running service step ends, a running wait step is left open, and every
//     task not ended gets the result stopped (signalled: <SIG>, signal, counts, head, open, untaken); a later signal changes
//     nothing.
//
// The run folder <sharedDir>/runs/<runId>/ (runId and every name in it come from the conductor; a task key is checked,
// KEY_RE): request.json (what start was given), writer.lock (the one writer of the folder), journal/<key>/ (the journal and
// its snapshot, scripts/chain-journal.js), run.json (runId, pid and start time of the conductor, host,
// task keys, argv, plugin version), log.txt (the conductor's lines: "agent <label> started" and "agent <label> ok|null
// <s> s" for every role call, "exec <label> started" and "exec <label> ok|no-json|null <s> s" for every service step -
// status names an open one with its start -, the hook checks, the script's log and phases, its own stderr),
// tasks/<key>.json (the record of a task registered in this run: running while the conductor holds it, ended with its
// result; reconcile: what the reconciliation found), steps/<key>/ (the files of the task's service steps: the wait steps
// wait-<step>.{json,log,rc}, the copy of a selection log, leftovers.md, the train's copies of its logs; the script gets
// the folder as the task field stepDir, which a tasks file cannot set), results.json ({runId, exitCode, results}: one
// result per task as the Workflow gives it, with the field adapter when a call did not end ok), resolved/<key>/ (the
// decisions of resolve, scripts/chain-resolve.js).
//
// All of it lies outside the write roots of the roles (owner 2026-11-07): no service file in a task folder, a role cannot
// rename the folder or its parents, and a service file is read and written with no link followed and without blocking.
// A new run never meets the step files of an earlier one: each run has its own steps folder, and inside a run a wait
// step id is started once (wait-step.js --once; its retry passes --reuse).
//
// Liveness has three answers (liveness): alive - the process with that pid started at the recorded time (`LC_ALL=C ps -o
// lstart=`), or its process group still has members, which are named; gone - neither; unknown - ps does not answer while
// a process with that pid exists, or a pid or start time that cannot name a process. unknown stops this start and
// writes nothing, so the next start asks again.
//
// The lock of a task, <sharedDir>/runs/.locks/<key>.lock: {pid, lstart, runId, takenAt}, created whole by a hard link (two
// conductors never both take it); one name per task, so conductors of different runs meet at it. It only excludes: the
// truth is the journal. Per task the order is lock -> reconciliation of every earlier run of the task -> registration
// (journal/<key>/, steps/<key>/, then tasks/<key>.json) -> steps (acquireTask). A lock held by a live conductor stops the
// task ("another conductor runs it"); a lock that cannot be read, or whose pid, start time or runId cannot name a run
// (runId by KEY_RE; its runDir field is never used), stops it and stays; unknown liveness stops it. A dead holder: the
// lock is read again (its holder may have released it in between), then taken over under the token
// <key>.lock.takeover (a hard link too): under it the lock is read once more, the reconciliation runs - a run named by the
// dead lock that has no folder refuses - and only then this conductor's lock is renamed onto the dead one; a refusal
// leaves the dead lock as it was. A token whose holder is alive means another conductor is taking over; a token that
// cannot be read or whose holder is dead stays and refuses, a technical cleanup by hand.
//
// The reconciliation (reconcile) reads every run folder but its own and returns data, the text is built apart. A run
// folder without a record of the task (a start that lost the lock, or a run of other tasks) does not count. A record
// that cannot be read, a run.json that cannot be read, a damaged journal or snapshot ahead of it, or no journal while
// the record says running refuses; a conductor alive with the task running refuses (its lock may have been removed by
// hand). Open steps by their class of effect: none never blocks; never blocks once its process was launched (a gate that
// never opened does not); idempotent and reuse block while their process is alive or unknown, and an idempotent step
// without a launch (its pid unknown) blocks; a reuse step without a launch reads the meta of its wait step in the steps
// folder of that run. A verdict the journal shows as not used by the chain (unaccounted, or a result after the end) and
// an intent with no known effect refuse. A decision of resolve on the step (or abort for the run) whose basis is the
// current one closes a reason (a live conductor never); then the start must follow the decisions of the newest run of
// the task (chain-resolve.js startCheck), and the conductor gives the task resumeSince from them, which a tasks file
// cannot set. No mark file is written: removing a lock by hand lifts nothing, the refusal is
// computed again from the run folders at every start. calls.jsonl and the call folders of a task folder are only named.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createAgent, validate, realish, overlap, procOf, stopAll } = require('./role-exec.js');
const RR = require('./role-roots.js');
const CJ = require('./chain-journal.js');
const RS = require('./chain-resolve.js');

const ROOT = path.join(__dirname, '..');
const MAX_WAIT = 270;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const USAGE = 'usage: chain-run.js start --host claude|codex --tasks <file> [--owner <file>] [--config <file>] [--bin <cli>] [--codex-home <dir>] [--codex-auth chatgpt|apiKeyFile] [--codex-key-file <file>]\n'
  + '       chain-run.js status <run-id|run folder> [--wait <s>] [--config <file>]\n'
  + '       chain-run.js stop <run-id|run folder> [--config <file>]\n'
  + '       chain-run.js resolve <run-id|run folder> --task <key> --as ran|retry|abort [--step <n>] [--verdict <v>] [--head <sha>] --basis <seq:sha256> --note <text>\n'
  + '       chain-run.js resolve --list [--task <key>] [--config <file>]; resolve --commits ...; status --commits <dir> --task <key>';

const readJson = CJ.readJsonSafe;
const writeJsonAtomic = CJ.writeAtomic;

// ---- the stop of a run (UC-6): one per process, set by the first of SIGTERM, SIGINT, SIGHUP the conductor gets and
// never lifted. From then on no role, service step, hook check or wait client starts (the gates throw StopError before
// the intent of a step), a running role gets SIGTERM through the adapter, a running service step without a wait ends with
// its result, and a running wait step is left open (its detached run lives on, its client is not awaited).
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
class StopError extends Error {
  constructor(sig) { super(`signalled: ${sig}`); this.name = 'StopError'; this.signal = sig; }
}
const STOP = { sig: null };
let wakeStop = null;
const stopped$ = new Promise((r) => { wakeStop = r; });
// Sets the stop once: true for the first call, false for every later one.
function beginStop(sig) {
  if (STOP.sig) return false;
  STOP.sig = sig;
  wakeStop(sig);
  stopAll(sig);
  return true;
}
const gate = () => { if (STOP.sig) throw new StopError(STOP.sig); };
// A signal is handled only in the poll phase of the event loop: after the exit of a child, an IPC disconnect or an fs
// callback one setImmediate runs before that phase, two always pass it (experiment of the analysis, Node 22.20).
const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
const signalCode = (sig) => 128 + os.constants.signals[sig];
// The start time of a process as ps prints it in the C locale, or null when there is no such process (or ps fails).
function lstartOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
  const s = p.status === 0 ? String(p.stdout).trim() : '';
  return s || null;
}
const normL = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);
// Every process as {pid, pgid, lstart, command}, or null when ps does not answer.
function psTable() {
  const p = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,lstart=,command='], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }), maxBuffer: 64 * 1024 * 1024 });
  if (p.status !== 0 || p.error) return null;
  const rows = [];
  for (const l of String(p.stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s?(.*)$/.exec(l);
    if (m) rows.push({ pid: +m[1], pgid: +m[2], lstart: normL(m[3]), command: m[4].slice(0, 200) });
  }
  return rows;
}
// kill(pid, 0) as an answer: true exists, false no such process, null cannot tell. Only for an integer above 1 or below -1.
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : e.code === 'ESRCH' ? false : null; }
}
// Whether a recorded process lives: {state: alive|gone|unknown, members?, why?} (the header of this file). pgid: the
// group the process led, when it was recorded.
function liveness(p) {
  const pid = p && p.pid, lstart = normL(p && p.lstart);
  const pgid = p && Number.isInteger(p.pgid) && p.pgid > 1 ? p.pgid : null;
  if (!Number.isInteger(pid) || pid <= 1) return { state: 'unknown', why: `no process can be named by pid ${JSON.stringify(pid)}` };
  const there = exists(pid);
  const table = psTable();
  if (!table) {
    if (there === false) {
      const g = pgid ? exists(-pgid) : false;
      if (g === false) return { state: 'gone' };
      if (g === true) return { state: 'alive', members: [], why: `its group ${pgid} has members (ps did not answer to name them)` };
    }
    return { state: 'unknown', why: `ps does not answer and pid ${pid} ${there ? 'exists' : 'cannot be checked'}` };
  }
  const row = table.find((r) => r.pid === pid);
  const members = pgid ? table.filter((r) => r.pgid === pgid) : [];
  if (row && lstart && row.lstart === lstart) return { state: 'alive', members: members.length ? members : [row] };
  if (members.length) return { state: 'alive', members, why: `its group ${pgid} has members` };
  if (row && !lstart) return { state: 'unknown', why: `pid ${pid} exists and no start time was recorded, so whose process it is cannot be told` };
  return { state: 'gone' };
}
const liveText = (v) => (v.state === 'alive' ? `alive${(v.members || []).length ? ` (group: ${v.members.slice(0, 8).map((m) => `${m.pid} ${m.command || ''}`.trim()).join('; ')})` : ''}`
  : v.state === 'gone' ? 'gone' : `unknown: ${v.why}`);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const labelKey = (label) => (/^[a-z]+:([^:#]+)/.exec(String(label)) || [])[1] || null;

// The task table of the adapter: the same normalization as workflows/role-chain.js (TASKS: dir by default
// <sharedDir>/<key>, a relative wt under worktreeRoot), so a role runs in the folder the script names in its prompts;
// branch is the branch the commit channel commits to (role-exec.js refuses prog/test of a task without it).
function taskTable(args) {
  const c = args.config || {};
  const abs = (p) => (String(p).startsWith('/') ? p : `${c.worktreeRoot}/${p}`);
  const out = {};
  for (const t of args.tasks || []) {
    out[t.key] = { dir: t.dir || `${c.sharedDir}/${t.key}`, wt: typeof t.wt === 'string' ? abs(t.wt) : t.wt };
    if (typeof t.branch === 'string') out[t.key].branch = t.branch;
  }
  return out;
}
// The state folder of the commit channel (scripts/commit-service.js): one per project, so the journal of a task,
// <stateDir>/<key>/commits.jsonl, is the same in every run and an undetermined step of one run blocks the next (owner
// 2026-11-09). Its name starts with a dot: the reconciliation and every listing of the runs skip it.
const commitStateDir = (config) => path.join(config.sharedDir, 'runs', '.commit');

// The form of the tasks file, not its meaning (role-chain.js judges the fields): {tasks} or {error}.
function parseTasks(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { return { error: `the tasks file is not JSON: ${e.message}` }; }
  if (!Array.isArray(v)) return { error: 'the tasks file is not a JSON array of tasks' };
  if (!v.length) return { error: 'the tasks file has no task' };
  const keys = new Set();
  for (const [i, t] of v.entries()) {
    if (!isPlain(t)) return { error: `task ${i + 1} is not an object` };
    if (typeof t.key !== 'string' || !t.key.trim()) return { error: `task ${i + 1} has no key` };
    if (!CJ.KEY_RE.test(t.key)) return { error: `task ${i + 1}: the key ${JSON.stringify(t.key)} cannot name files of the state (letters, digits, . _ - and no leading dot)` };
    // one name on a case-insensitive disk
    if (keys.has(t.key.toLowerCase())) return { error: `two tasks have the key ${t.key}` };
    keys.add(t.key.toLowerCase());
    if (Object.prototype.hasOwnProperty.call(t, 'stepDir')) return { error: `task ${t.key}: the field stepDir is the conductor's (the steps folder of a run), a tasks file cannot set it` };
    if (Object.prototype.hasOwnProperty.call(t, 'resumeSince')) return { error: `task ${t.key}: the field resumeSince is the conductor's (from the decision of resolve), a tasks file cannot set it` };
    for (const [k, x] of Object.entries(t)) {
      const fine = typeof x === 'string' || typeof x === 'boolean' || (Array.isArray(x) && x.every((y) => typeof y === 'string'))
        || (isPlain(x) && Object.values(x).every((y) => ['string', 'number', 'boolean'].includes(typeof y)));
      if (!fine) return { error: `task ${t.key}: field ${k} is not a string, a boolean, a list of strings or a plain object` };
    }
  }
  return { tasks: v };
}

// The state of the runs, and in it the state folder of the commit channel, must lie outside the write roots of the
// roles (owner 2026-11-07): the places scripts/role-roots.js gives - on codex every folder a role reaches (the worktree,
// the task folder, /tmp, the role's TMPDIR), on claude the worktree and the task folder. <sharedDir>/runs/.commit is
// resolved apart, since a link there would carry the journal into a role's reach. Text of the overlap, or null.
function stateRootProblem(args, host, env) {
  const states = [['the state folder', '<sharedDir>/runs', realish(path.join(args.config.sharedDir, 'runs'))],
    ['the commit state folder', '<sharedDir>/runs/.commit', realish(commitStateDir(args.config))]];
  for (const [k, t] of Object.entries(taskTable(args))) {
    // a task without a worktree path still has its task folder as a root
    const r = RR.roleRoots({ wt: typeof t.wt === 'string' ? t.wt : t.dir, tdir: t.dir, tmpdir: env && env.TMPDIR });
    for (const root of host === 'codex' ? r.reach : r.check) {
      for (const [what, name, state] of states) {
        if (overlap(state, root)) return `${what} ${state} (${name}) overlaps ${root}, a write root of a role of task ${k}: put sharedDir outside it`;
      }
    }
  }
  return null;
}

// The author of the commit channel on codex: commitAuthor of the config, else user.name and user.email of git as the
// adapter reads them (the user's config sources seen from the worktree; no GIT_* of this process but GIT_CONFIG_*).
// Text of the refusal, or null: there is no silent default author, the owner sees the author in git log.
const AUTHOR_MISSING = 'the commit channel needs an author: set commitAuthor in the project config or user.name/user.email in git';
function authorProblem(config, wt) {
  if (config.commitAuthor) return null;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k) || /^GIT_CONFIG_/.test(k)) env[k] = v;
  let cwd;
  try { if (typeof wt === 'string' && fs.statSync(wt).isDirectory()) cwd = wt; } catch { /* outside a worktree: the user's own config only */ }
  const get = (k) => { const p = spawnSync('git', ['-c', 'core.fsmonitor=false', 'config', '--get', k], { cwd, env, encoding: 'utf8' }); return p.status === 0 ? p.stdout.trim() : ''; };
  return get('user.name') && get('user.email') ? null : AUTHOR_MISSING;
}
// The commit journal of a task before its roles: a damaged journal or an undetermined step makes the adapter refuse
// every request of the task, so the task waits for the coordinator instead of running a programmer whose commits are
// all refused. Text of the refusal, or null. An intent without a result is settled by the adapter at its next open.
function commitJournalProblem(config, key) {
  const dir = commitStateDir(config);
  const file = path.join(dir, key, 'commits.jsonl');
  const st = RS.commitsState(file);
  if (st.damage) return `the commit journal ${file}: ${st.damage}; the commit channel refuses every request of the task until it is repaired by hand (resolve --commits refuses damage)`;
  if (st.undetermined.length) {
    return `the commit journal ${file} has an undetermined commit step (request ${st.undetermined.join(', ')}): the task waits for the coordinator - chain-run.js status --commits ${dir} --task ${key} gives the basis, chain-run.js resolve --commits ${dir} --task ${key} --request <id> --wt <worktree> --as committed|refused --basis <basis> --note <text> decides`;
  }
  return null;
}

// config.js json as the role-chain skill runs it: {config} or {error}.
function loadConfig(file) {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'config.js'), 'json'].concat(file ? [file] : []), { encoding: 'utf8' });
  if (p.status !== 0) return { error: (p.stderr || p.stdout || `config.js exit ${p.status}`).trim() };
  try { return { config: JSON.parse(p.stdout) }; } catch (e) { return { error: `config.js json printed no JSON: ${e.message}` }; }
}

// The adapter's config of a run: host, the task table, the host CLI options from start; on codex the hook check before
// each launch, pre allowed (the conductor checks the environment itself) and the commit channel of prog and test:
// the state folder of the project, the runId every event of a task's journal carries, and commitAuthor of the config
// as author (left out: the adapter takes user.name/user.email of git; the conductor stops a task without either).
function adapterCfg(host, args, ad, callsDir, log, runId) {
  const cfg = { host, tasks: taskTable(args), pluginRoot: ROOT, callsDir, log };
  if (host === 'codex') {
    const config = args.config || {};
    cfg.commit = { stateDir: commitStateDir(config) };
    if (runId !== undefined) cfg.commit.runId = runId;
    if (config.commitAuthor) cfg.commit.author = { name: config.commitAuthor.name, email: config.commitAuthor.email };
    cfg.codex = { home: ad.codexHome };
    if (ad.bin) cfg.codex.bin = ad.bin;
    if (ad.codexAuth) cfg.codex.auth = ad.codexAuth;
    if (ad.codexKeyFile) cfg.codex.keyFile = ad.codexKeyFile;
    cfg.preconditionsByConductor = true;
    cfg.beforeLaunch = hookGate({ home: ad.codexHome, bin: ad.bin || 'codex', note: log });
  } else if (ad.bin) cfg.claude = { bin: ad.bin };
  return cfg;
}

// ---- processes of the conductor: {rc, signal, stdout, stderr, error}; never rejects.
function runProcess(argv, o) {
  return new Promise((resolve) => {
    let child, out = '', err = '';
    try { child = spawn(argv[0], argv.slice(1), { cwd: o && o.cwd, env: (o && o.env) || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ rc: null, signal: null, stdout: '', stderr: '', error: e.message }); return; }
    if (o && o.onSpawn && child.pid) o.onSpawn(child.pid);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', (e) => resolve({ rc: null, signal: null, stdout: out, stderr: err, error: e.code || e.message }));
    child.on('close', (rc, signal) => resolve({ rc, signal, stdout: out, stderr: err, error: null }));
  });
}
const failText = (p) => [p.error ? `cannot run: ${p.error}` : p.signal ? `killed by ${p.signal}` : `exit ${p.rc}`, (p.stderr || '').trim().slice(-600) || (p.stdout || '').trim().slice(-300)]
  .filter(Boolean).join(': ');
// The JSON a command printed: the whole output, else its last line; undefined when there is none.
function jsonOf(text) {
  const t = String(text || '').trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { /* the last line */ }
  try { return JSON.parse(t.split('\n').pop()); } catch { return undefined; }
}

// One service step as processes: {value} or {error}. A step with wait: argv once (its JSON says the run started,
// attached or was reused), then wait.argv again and again until its JSON says done - each call of wait-step.js blocks at
// most its --max, and wait-step.js ends a hung run at its own deadline. A stop ends the wait (StopError): the run is left. hooks.onLaunch registers the process: a step with
// wait by the answer of its start (the detached run in a group of its own; a reused run has ended, so its pid may be
// another process by now and gets no start time), any other step right after its spawn (a child of the conductor, in the
// conductor's group: pgid null).
async function realStep(step, hooks) {
  const onLaunch = (hooks && hooks.onLaunch) || (() => {});
  const p = await runProcess(step.argv, { cwd: step.cwd, onSpawn: step.wait ? null : (pid) => onLaunch({ pid, pgid: null, lstart: lstartOf(pid) }) });
  if (step.stdoutField) {
    const line = String(p.stdout || '').trim();
    return p.rc === 0 && line ? { value: { [step.stdoutField]: line } } : { error: `${failText(p)}${line ? '' : ' (nothing printed)'}` };
  }
  const j = jsonOf(p.stdout);
  if (j === undefined) return { error: failText(p) };
  if (!step.wait) return { value: j };
  if (j && Number.isInteger(j.pid)) {
    const proc = j.reused ? null : procOf(j.pid);
    onLaunch({ pid: j.pid, pgid: proc ? proc.pgid : null, lstart: proc ? proc.lstart : null, started: j.started, attached: j.attached, reused: j.reused, rc: j.rc });
  }
  for (;;) {
    gate();
    // a stop does not wait for a running client: it is left behind (it only reads, at most its --max)
    const w = await Promise.race([runProcess(step.wait.argv, { cwd: step.cwd }), stopped$.then(() => null)]);
    if (w === null) throw new StopError(STOP.sig);
    const wj = jsonOf(w.stdout);
    if (wj === undefined || wj === null || typeof wj !== 'object') return { error: failText(w) };
    if (wj.done === true) return { value: wj };
  }
}
// noJson of a step with every "$error" (a string or an item of a list) replaced by the error text.
// The error texts an output carries itself (every string field "error", nested too): a refusal by the schema keeps them,
// so the cause the script named reaches the stop text.
const ownErrors = (v) => (Array.isArray(v) ? v.flatMap(ownErrors)
  : isPlain(v) ? Object.entries(v).flatMap(([k, x]) => (k === 'error' && typeof x === 'string' && x ? [x] : ownErrors(x))) : [])
const fillError = (v, e) => (v === '$error' ? e : Array.isArray(v) ? v.map((x) => fillError(x, e))
  : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillError(x, e)])) : v);
// exec(step) of the script: the answer of the step (its schema), or its noJson with the error (for an output off the
// schema: the schema errors and the error texts the output carries). o.runner replaces
// realStep (tests: a fake runtime answers {value} or {error}; its value null passes through as "no result", as an agent of
// the Workflow may give). o.note gets "exec <label> started" and "exec <label> ok|no-json|null <s> s" (status reads them);
// o.onLaunch registers the process (o.runner: a substitute, marked as such), o.onEnd(how, seconds) gets the outcome.
async function execStep(step, o) {
  const note = (o && o.note) || (() => {});
  const runner = (o && o.runner) || realStep;
  note(`exec ${step.label} started`);
  const t0 = Date.now();
  let r;
  if (o && o.runner && o.onLaunch) o.onLaunch({ pid: null, pgid: null, lstart: null, substitute: true });
  try { r = await runner(step, { onLaunch: o && o.onLaunch }); } catch (e) {
    if (e instanceof StopError) { note(`exec ${step.label} left open: stopping ${e.signal}`); throw e; }
    r = { error: `the conductor could not run the step: ${e.message}` };
  }
  let v, how = 'ok';
  if (r && r.value === null && !('error' in r)) { v = null; how = 'null'; }
  else if (r && r.value !== undefined && !r.error) {
    const errs = validate(r.value, step.schema);
    if (errs.length) {
      const own = [...new Set(ownErrors(r.value))];
      v = fillError(step.noJson, `the output does not pass the schema of the step: ${errs.join('; ')}${own.length ? `; its own error: ${own.join('; ')}` : ''}`);
      how = 'no-json';
    }
    else v = r.value;
  } else { v = fillError(step.noJson, (r && r.error) || 'no output'); how = 'no-json'; }
  if (v && how === 'ok' && step.stampAt) v = Object.assign({}, v, { [step.stampAt]: new Date().toISOString() });
  note(`exec ${step.label} ${how} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (o && o.onEnd) o.onEnd(how, (Date.now() - t0) / 1000);
  return v;
}

// ---- the journal of the steps
const gitOf = (wt, args) => {
  if (typeof wt !== 'string') return null;
  const p = spawnSync('git', ['-C', wt].concat(args), { encoding: 'utf8', timeout: 10000 });
  return p.status === 0 ? String(p.stdout).trim() : null;
};
const gitHeadOf = (wt) => gitOf(wt, ['rev-parse', '--verify', '-q', 'HEAD']);

// The journal lines of a run's steps. o: {runId, journals: {<key>: writer of chain-journal.js}, table: {<key>: {wt}}, note}.
// A step number is unique in the run, so stepId = <runId>:<n> names one step whatever its label. Every write that fails
// throws "journal/run-state not written", which ends the chain of the task (pipeline): nothing runs after it.
// settled: a result waits for the script to take it. The script goes on in microtasks up to its next step, so setImmediate
// runs after that; the next step of the task writes it first, so an intent never comes before the settled it depends on.
function makeSteps(o) {
  const getters = {}, pend = {}, left = {};
  let n = 0;
  const write = (key, fields) => {
    try { return o.journals[key].append(fields); } catch (e) { throw new Error(`journal/run-state not written: ${e.message}`); }
  };
  const vals = (key) => { try { return getters[key] ? getters[key]() : {}; } catch { return {}; } };
  const settle = (key) => {
    if (!pend[key] || !pend[key].length) return;
    write(key, Object.assign({ type: 'settled', stepIds: pend[key].slice() }, vals(key)));
    pend[key] = [];
  };
  return {
    has: (key) => !!key && !!o.journals[key],
    register: (key, getter) => { getters[key] = getter; },
    begin(key, fields) {
      settle(key);
      const stepId = `${o.runId}:${++n}`;
      write(key, Object.assign({ type: 'intent', stepId, n, gitHead: gitHeadOf(o.table[key] && o.table[key].wt) }, fields, vals(key)));
      return stepId;
    },
    launch(key, stepId, info) { write(key, Object.assign({ type: 'launch', stepId }, info)); },
    end(key, stepId, fields) {
      write(key, Object.assign({ type: 'result', stepId }, fields));
      (pend[key] = pend[key] || []).push(stepId);
      setImmediate(() => { try { settle(key); } catch (e) { o.note(`[${key}] ${e.message}`); } });
    },
    // A wait step left open by a stop (no result), named in the task's stopped result.
    abandon(key, info) { (left[key] = left[key] || []).push(info); },
    // The fields of a task stopped by a signal: counts and head of the script's getter (those of its end line), the wait
    // steps left open, and the verdicts recorded that the chain had not used yet (the end line clears them).
    stopFields(key) {
      const v = vals(key);
      const j = o.journals[key];
      const un = j && j.state ? j.state.unaccounted || [] : [];
      return { counts: v.counts, head: v.head, open: (left[key] || []).slice(), untaken: un.map((u) => ({ stepId: u.stepId, label: u.label, outcome: u.outcome, value: u.value })) };
    },
    finish(key, r) {
      settle(key);
      write(key, Object.assign({ type: 'end', status: r ? r.status : null }, vals(key), r && r.counts ? { counts: r.counts } : {}));
    },
  };
}
// exec(step) with its journal lines around it; without steps, the step alone (a fake runtime of a test). A stop throws
// StopError before the intent; a wait step it leaves gets no result.
async function stepExec(steps, step, o) {
  gate();
  if (!steps) return execStep(step, o);
  const key = labelKey(step.label);
  if (!steps.has(key)) throw new Error(`the step ${step.label} names no task of this run: a step does not run without its intent`);
  const stepId = steps.begin(key, { kind: 'exec', stepKind: step.kind, label: step.label, phase: step.phase, effect: step.effect, gated: false, waitId: step.wait ? step.wait.id : undefined });
  let lost = null, how = null, seconds = null;
  // The process is already running when its registration fails: the step ends, and then the task stops.
  const onLaunch = (info) => { try { steps.launch(key, stepId, Object.assign({ gated: false }, info)); } catch (e) { lost = e; } };
  let v;
  try { v = await execStep(step, Object.assign({}, o, { onLaunch, onEnd: (h, s) => { how = h; seconds = s; } })); } catch (e) {
    if (e instanceof StopError) steps.abandon(key, { stepId, label: step.label, waitId: step.wait ? step.wait.id : undefined });
    throw e;
  }
  steps.end(key, stepId, { outcome: how, value: v, seconds });
  if (lost) throw lost;
  return v;
}
// An open step as one text (status and the refusal of a restart): the run, the step, the time and the HEAD of its
// intent, its process and its liveness (live: the answer of liveness, else it is asked here), that no result is
// recorded, the HEAD now with the commits since, the call folder and the adapter's record of it. ctx: {runId, wt, dir}.
function openStepText(step, ctx, live) {
  const l = step.launch;
  let proc;
  if (l && l.substitute) proc = 'a substitute launcher, no process';
  else if (l && l.reused) proc = `an ended run reused, pid ${l.pid}, rc ${l.rc}`;
  else if (l) proc = `pid ${l.pid}, group ${l.pgid === null || l.pgid === undefined ? 'of the conductor' : l.pgid}, started ${l.lstart || 'unknown'}: ${liveText(live || liveness(l))}`;
  else if (live) proc = `no launch recorded; the meta of its wait step: ${liveText(live)}`;
  else if (step.gated) proc = 'no launch recorded: the gate never opened, the role did not start';
  else proc = 'no launch recorded: pid unknown, the step may have started';
  const wait = step.waitId ? `; wait step ${step.waitId}` : '';
  const a = step.gitHead || null;
  const b = gitHeadOf(ctx.wt);
  const since = a && b && a !== b ? `; commits since the intent: ${(gitOf(ctx.wt, ['log', '--format=%h %s', '-n', '20', `${a}..${b}`]) || 'unknown').split('\n').join(' | ')}` : '';
  let call = '';
  const cd = l && l.callDir;
  if (cd) {
    const { records, error } = callRecords(ctx.dir);
    const rec = records.find((x) => x.callDir === cd);
    call = `; call folder ${cd}; the adapter's record: ${error ? `unreadable (${error})` : rec ? rec.outcome : 'none'}`;
  }
  return `run ${ctx.runId}, step ${step.n} ${step.label} (${step.effect}): intent at ${step.at}, HEAD then ${a || 'unknown'}; ${proc}${wait}; no result recorded; HEAD now ${b || 'unknown'}${since}${call}`;
}

// The hook check of a codex run home before a role (owner 2026-11-06, answer 5, translated: "before every Codex role; on a
// failure the role is not started"): the beforeLaunch of the adapter. It answers null (the hook runs: launch the role) or the outcome
// that ends the call. One check at a time per gate (one run home): an app-server of each check writes its state files into
// that home; a check whose turn comes after a stop does not start. o: {home, bin, script? (the check; tests), note}.
function hookGate(o) {
  let tail = Promise.resolve();
  const script = o.script || path.join(__dirname, 'codex-hooks-check.js');
  const check = async (plan) => {
    if (STOP.sig) return { outcome: 'signalled', error: `the conductor got ${STOP.sig}: the hook check did not start` };
    const p = await runProcess([process.execPath, script, '--codex-home', o.home, '--cwd', plan.cwd, '--codex', o.bin]);
    const text = `${(p.stdout || '').trim()}${p.stderr && p.stderr.trim() ? ` ${p.stderr.trim()}` : ''}`.slice(-1500);
    if (o.note) o.note(`hook check ${plan.label}: ${p.signal ? p.signal : `exit ${p.rc}`}`);
    if (p.rc === 0) return null;
    if (p.rc === 1) return { outcome: 'hook-untrusted', error: `codex-hooks-check.js exit 1, the hook of codis-agents does not run in CODEX_HOME=${o.home}: ${text}` };
    if (p.rc === 2) return { outcome: 'refused', error: `codex-hooks-check.js exit 2 (refused before any start): ${text}` };
    return { outcome: 'hook-unverified', error: `codex-hooks-check.js ${p.signal ? `killed by ${p.signal}` : `exit ${p.rc}`}${p.error ? ` (${p.error})` : ''}: ${text || 'no output'}` };
  };
  return (plan) => {
    const run = tail.then(() => check(plan));
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// The cause of an adapter outcome (owner 2026-11-06, answer 4, translated: "an unknown cause is called unknown"): the outcome
// itself when the fields of the call establish it - an API status (rate-limited, auth, schema-refused), a refusal of the
// adapter or of the check (refused), the ceiling of 3 h, a signal the adapter got (signalled), the answer of the hook check
// (hook-untrusted), a launch the conductor could not register (not-registered) - otherwise unknown: an exit code, a signal
// from outside, no result, an answer off the schema, a hook check that could not answer.
const CAUSE_KNOWN = new Set(['rate-limited', 'auth', 'schema-refused', 'refused', 'ceiling', 'signalled', 'hook-untrusted', 'not-registered']);
function adapterEntry(rec) {
  const e = { label: rec.label, outcome: rec.outcome, cause: CAUSE_KNOWN.has(rec.outcome) ? rec.outcome : 'unknown', error: rec.error, callDir: rec.callDir, rc: rec.rc, signal: rec.signal };
  if (e.cause === 'unknown' && rec.callDir) e.stderr = path.join(rec.callDir, 'stderr.log');
  return e;
}

// The lines of a task folder's calls.jsonl, a torn line left out: {records} with no such file, {records: [], error} when it
// cannot be read. The folder's path may go through a link (a task folder or a sharedDir linked by its owner), so it is
// resolved first; only the file itself is opened with no link followed. role-exec.js writes this file the same way.
function callRecords(dir) {
  let text;
  try { text = CJ.readText(path.join(realish(dir), 'calls.jsonl')); } catch (e) { return { records: [], error: e.code === 'ENOENT' ? null : e.message }; }
  const records = [];
  for (const l of text.split('\n')) {
    try { const r = JSON.parse(l); if (r && typeof r === 'object') records.push(r); } catch { /* a torn line */ }
  }
  return { records, error: null };
}

// Call folders of a task dir that hold a prompt and have no line in calls.jsonl: started, their end not recorded (the
// role may still be alive). {calls, error}: with error set, what records them cannot be read, so calls is every call folder
// it could list and nothing is known about their ends.
function unrecordedCalls(dir) {
  const parent = path.join(dir, 'calls');
  let names = [];
  try { names = fs.readdirSync(parent); } catch (e) { return { calls: [], error: e.code === 'ENOENT' ? null : `${parent} cannot be read: ${e.message}` }; }
  const { records, error } = callRecords(dir);
  const recorded = new Set(records.map((r) => r.callDir));
  return { calls: names.map((n) => path.join(parent, n)).filter((d) => fs.existsSync(path.join(d, 'prompt.txt')) && !recorded.has(d)).sort(),
    error: error ? `calls.jsonl cannot be read: ${error}` : null };
}
const unrecordedText = (u) => (u.error ? `${u.error}, so nothing is known about the end of the calls ${u.calls.join(', ') || '(none)'}`
  : `calls started without a line in calls.jsonl: ${u.calls.join(', ') || 'none'}`);

// ---- the lock of a task (the header of this file)
const lockFileOf = (runsDir, key) => path.join(runsDir, '.locks', `${key}.lock`);
const stepDirOf = (runDir, key) => path.join(runDir, 'steps', key);
const RUN_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const lockData = (me) => Object.assign({ pid: me.pid, lstart: me.lstart, runId: me.runId, takenAt: new Date().toISOString() }, me.by ? { by: me.by } : {});
// What keeps a lock from naming a run, or null.
function lockProblem(d) {
  if (!isPlain(d)) return 'holds no lock';
  if (!Number.isInteger(d.pid) || d.pid <= 1) return `names no process (pid ${JSON.stringify(d.pid)})`;
  if (!normL(d.lstart)) return `names no start time of pid ${d.pid}`;
  if (typeof d.runId !== 'string' || !RUN_ID_RE.test(d.runId)) return `names no run (runId ${JSON.stringify(d.runId)})`;
  return null;
}
const sameLock = (a, b) => ['pid', 'lstart', 'runId', 'takenAt'].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
// One link of the lock: {ok}, or {held: its data ({} when unreadable), unreadable?, live: liveness of the holder, alive}.
function takeLock(file, me) {
  try { fs.mkdirSync(path.dirname(file)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!fs.lstatSync(path.dirname(file)).isDirectory()) throw new Error(`${path.dirname(file)} is not a folder`);
  const tmp = `${file}.${me.runId}.${process.pid}.new`;
  writeJsonAtomic(tmp, lockData(me));
  try {
    const r = CJ.linkLock(tmp, file);
    if (r.ok) return { ok: true };
    if (!r.data) return { held: {}, unreadable: r.unreadable, live: { state: 'unknown', why: 'the lock cannot be read' }, alive: false };
    const live = lockProblem(r.data) ? { state: 'unknown', why: `the lock ${lockProblem(r.data)}` } : liveness({ pid: r.data.pid, lstart: r.data.lstart });
    return { held: r.data, live, alive: live.state === 'alive' };
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}
function releaseLock(file, me) {
  const { data } = CJ.readLock(file);
  if (data && data.runId === me.runId && data.pid === me.pid) fs.unlinkSync(file);
}
// The refusal text of a reconciliation: undetermined, every reason, the notes, and what the task folder's calls say.
function refusalText(rc, ctx) {
  const u = ctx && ctx.dir ? unrecordedCalls(ctx.dir) : null;
  const runs = ctx && ctx.key ? [...new Set(rc.reasons.filter((r) => r.runDir).map((r) => r.runDir))] : [];
  const basis = runs.length ? `; the basis to resolve on: ${runs.map((d) => `run ${path.basename(d)} ${RS.basisOf(d, ctx.key)}`).join(', ')}` : '';
  return `undetermined: ${rc.reasons.map((r) => (r.runId && !r.why.startsWith(`run ${r.runId},`) ? `run ${r.runId}: ${r.why}` : r.why)).join('; ')}${rc.notes.length ? `; also: ${rc.notes.join('; ')}` : ''}${u ? `; ${unrecordedText(u)}` : ''}${basis}`;
}
// The takeover of a dead lock under its token: {ok, rc} | {why} | {retry} (the lock moved: take it again).
function takeover(file, dead, me, check) {
  const tok = `${file}.takeover`;
  const tmp = `${tok}.${me.runId}.${process.pid}.new`;
  writeJsonAtomic(tmp, lockData(me));
  let t;
  try { t = CJ.linkLock(tmp, tok); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  if (!t.ok) {
    if (!t.data) return { why: `undetermined: the takeover token ${tok} cannot be read (${t.unreadable}); it stays - remove it by hand after checking the processes` };
    const lv = lockProblem(t.data) ? { state: 'gone' } : liveness({ pid: t.data.pid, lstart: t.data.lstart });
    if (lv.state === 'alive') return { why: `another conductor runs it: pid ${t.data.pid}, run ${t.data.runId} is taking over the dead lock (${tok})` };
    return { why: `undetermined: the takeover token ${tok} of conductor run ${t.data.runId || '?'} (pid ${t.data.pid || '?'}) is ${lv.state === 'unknown' ? `of unknown liveness (${lv.why})` : 'not alive'}; it stays - remove it by hand after checking the processes` };
  }
  try {
    const cur = CJ.readLock(file);
    if (!cur.data || !sameLock(cur.data, dead)) return { retry: true };
    // The run a dead lock names must have its folder: without it what that conductor did cannot be read (lockProblem
    // already refused a runId that is no plain name).
    const deadDir = path.join(path.dirname(path.dirname(file)), dead.runId);
    let isDir = false;
    try { isDir = fs.lstatSync(deadDir).isDirectory(); } catch { /* gone */ }
    if (!isDir) return { why: `undetermined: the dead lock ${file} names conductor run ${dead.runId} (pid ${dead.pid}, started ${dead.lstart}), whose folder ${deadDir} is gone, so what it did cannot be read; the lock stays` };
    const rc = check(dead);
    if (rc.reasons.length) return { why: rc.text };
    const own = `${file}.${me.runId}.${process.pid}.own`;
    writeJsonAtomic(own, lockData(me));
    fs.renameSync(own, file);
    return { ok: true, rc, took: dead };
  } finally {
    const mine = CJ.readLock(tok);
    if (mine.data && mine.data.runId === me.runId && mine.data.pid === me.pid) { try { fs.unlinkSync(tok); } catch { /* gone */ } }
  }
}
// Lock -> reconciliation of the task: {ok, rc} with the lock held, or {why} with nothing of this conductor left at the lock.
// check(deadLock | null) -> {reasons, notes, text}: the reconciliation, run while the lock (or its token) is held.
function acquireTask(runsDir, key, me, check) {
  const file = lockFileOf(runsDir, key);
  const checked = (dead) => { const rc = check(dead); return Object.assign({ text: rc.reasons.length ? rc.text || refusalText(rc) : null }, rc); };
  for (;;) {
    const l = takeLock(file, me);
    if (l.ok) {
      const rc = checked(null);
      if (rc.reasons.length) { releaseLock(file, me); return { why: rc.text }; }
      return { ok: true, rc };
    }
    const h = l.held;
    if (l.unreadable) return { why: `undetermined: the lock ${file} cannot be read (${l.unreadable}), so it names no conductor (pid ?); it stays` };
    const bad = lockProblem(h);
    if (bad) return { why: `undetermined: the lock ${file} ${bad}, pid ${h.pid === undefined ? '?' : h.pid}; it stays and nothing is written by what it names` };
    if (l.live.state === 'alive') return { why: `another conductor runs it: pid ${h.pid}, run ${h.runId}` };
    if (l.live.state === 'unknown') return { why: `undetermined: cannot tell whether conductor run ${h.runId} (pid ${h.pid}) holding the lock ${file} lives - ${l.live.why}; nothing written, the next start asks again` };
    const again = CJ.readLock(file);
    if (again.gone || !again.data || !sameLock(again.data, h)) continue;
    const t = takeover(file, h, me, checked);
    if (t.retry) continue;
    return t;
  }
}

// ---- the reconciliation (the header of this file)
const EFFECTS = new Set(['never', 'none', 'idempotent', 'reuse']);
// {data} | {none} | {unreadable}: a service file read with no link followed and without blocking.
function read3(file) {
  let text;
  try { text = CJ.readText(file); } catch (e) { return e.code === 'ENOENT' ? { none: true } : { unreadable: e.message }; }
  try { return { data: JSON.parse(text) }; } catch (e) { return { unreadable: `${file} does not parse: ${e.message}` }; }
}
// An open step of run folder rd: {block, text}.
function openStepVerdict(step, rd, key, ctx) {
  const eff = step.effect;
  const l = step.launch;
  if (!EFFECTS.has(eff)) return { block: true, text: `step ${step.n} ${step.label} has no known class of effect (${JSON.stringify(eff)}), so what a repeat would do is not known` };
  let live = null;
  if (l && (l.substitute || l.reused)) live = { state: 'gone' };
  else if (l) live = liveness(l);
  else if (eff === 'reuse') {
    const sd = path.join(rd, 'steps', key);
    if (typeof step.waitId !== 'string' || path.dirname(step.waitId) !== sd) return { block: true, text: `${openStepText(step, ctx, null)}; its wait step ${step.waitId || '?'} lies outside the steps folder ${sd} of its run, so its process is not known` };
    const m = read3(`${step.waitId}.json`);
    if (!m.data) return { block: true, text: `${openStepText(step, ctx, null)}; the meta of its wait step ${m.none ? 'is not there' : `cannot be read (${m.unreadable})`}, so whether it started is not known` };
    live = liveness({ pid: m.data.pid, lstart: m.data.lstart, pgid: m.data.pid });
  }
  const t = openStepText(step, ctx, live);
  if (eff === 'none') return { block: false, text: t };
  if (eff === 'never') return l || !step.gated ? { block: true, text: t } : { block: false, text: t };
  if (!live) return { block: true, text: `${t}; its process is not known` };
  return { block: live.state !== 'gone', text: t };
}
// Every earlier run of task key, but ownRunId: {reasons: [{runId, runDir, why}], notes: [text]}. ctx: {wt, dir} of the
// task, for the texts.
function reconcile(runsDir, key, ownRunId, ctx) {
  const reasons = [], notes = [];
  let ids;
  try { ids = fs.readdirSync(runsDir).filter((n) => !n.startsWith('.')).sort(); } catch (e) {
    return { reasons: [{ why: `the runs folder ${runsDir} cannot be read: ${e.message}` }], notes };
  }
  for (const id of ids) {
    if (id === ownRunId) continue;
    const rd = path.join(runsDir, id);
    const R = (why, meta) => reasons.push(Object.assign({ runId: id, runDir: rd, why, kind: 'run' }, meta || {}));
    let st;
    try { st = fs.lstatSync(rd); } catch (e) { if (e.code !== 'ENOENT') R(`${rd} cannot be read: ${e.message}`); continue; }
    if (!st.isDirectory()) { notes.push(`${rd} is not a run folder`); continue; }
    const rec = read3(path.join(rd, 'tasks', `${key}.json`));
    if (rec.none) continue;
    if (!rec.data || !isPlain(rec.data) || !['running', 'ended'].includes(rec.data.state)) { R(`tasks/${key}.json cannot be read (${rec.unreadable || 'no state'}), see ${path.join(rd, 'run.json')}`); continue; }
    const running = rec.data.state === 'running';
    const run = read3(path.join(rd, 'run.json'));
    if (!run.data || !isPlain(run.data)) { R(`run.json cannot be read (${run.unreadable || 'not there'}) while the task is registered in it`); continue; }
    const c = { runId: id, wt: ctx && ctx.wt, dir: ctx && ctx.dir };
    if (running) {
      const cl = liveness({ pid: run.data.pid, lstart: run.data.lstart });
      if (cl.state === 'alive') { R(`another conductor runs it: pid ${run.data.pid}, run ${id}, and its task is running (the lock of the task was removed by hand?)`, { kind: 'live' }); continue; }
      if (cl.state === 'unknown') { R(`cannot tell whether conductor run ${id} (pid ${run.data.pid}) with the task running lives - ${cl.why}`, { kind: 'live' }); continue; }
    }
    const jr = CJ.readJournal(rd, key);
    if (jr.error) { R(`${jr.error}; see ${path.join(rd, 'run.json')}`); continue; }
    if (jr.none) {
      if (running) R(`no journal of the task while tasks/${key}.json says running; see ${path.join(rd, 'run.json')}`);
      else notes.push(`run ${id}: the task ended without a journal (a run of an older version)`);
      continue;
    }
    for (const tn of jr.torn) notes.push(`run ${id}: a torn tail of ${tn.bytes} bytes in ${tn.file} (no record)`);
    for (const step of Object.values(jr.state.open)) {
      const v = openStepVerdict(step, rd, key, c);
      if (v.block) R(`${v.text}; see ${path.join(rd, 'run.json')}`, { kind: 'open', n: step.n }); else notes.push(v.text);
    }
    for (const v of jr.state.unaccounted || []) R(`the verdict of step ${v.n} ${v.label} is recorded (${v.outcome}: ${v.value}), but its use by the chain is not proven: no later step that carries a verdict and no end follow it`, { kind: 'unaccounted', n: v.n });
    for (const v of jr.state.afterEnd || []) R(`the verdict of step ${v.n} ${v.label} came after its end (${v.outcome}: ${v.value}): the chain did not take it`, { kind: 'afterEnd', n: v.n });
  }
  return { reasons: RS.closeReasons(reasons, key, notes), notes };
}

const stopped = (key, why) => ({ task: key, status: 'stopped', why });
// The result of a task stopped by a signal (the README, "Stopping a run"): fields from the steps when there are any.
const signalledResult = (key, sig, fields) => Object.assign(stopped(key, `signalled: ${sig} (chain-run.js stop or kill)`), { signal: sig }, fields || { open: [], untaken: [] });

// pipeline(items, fn) of the script: every chain at once; a chain that throws gets its own stopped result with the text
// of the exception, a chain stopped by a signal (StopError) the result of signalled(key, sig); onTaskEnd(key, result)
// runs when a chain is over, whatever its end.
function makePipeline(note, onTaskEnd, signalled) {
  return (items, fn) => Promise.all(items.map(async (it) => {
    let r;
    try { r = await fn(it); } catch (e) {
      if (e instanceof StopError) {
        note(`[${it.key}] stopped by ${e.signal}`);
        r = signalled ? signalled(it.key, e.signal) : stopped(it.key, `signalled: ${e.signal}`);
      } else {
        note(`[${it.key}] the chain crashed: ${(e && e.stack) || e}`);
        r = stopped(it.key, `the chain crashed: ${(e && e.message) || e}`);
      }
    }
    try { if (onTaskEnd) onTaskEnd(it.key, r); } catch (e) { note(`[${it.key}] the end of the task: ${e.message}`); }
    return r;
  }));
}

// Runs workflows/role-chain.js with args over the adapter: {results, threw}. o: {host, args, pluginRoot?, launch?
// (the adapter's launcher, tests), exec? (a fake runner of service steps, tests), adapter? (host CLI options), callsDir?,
// steps? (makeSteps: the journal of the steps), log (the script's log), note (the conductor's own lines), onTaskEnd?}.
async function runScript(o) {
  const note = o.note || (() => {});
  const args = o.args;
  const ended = new Set();
  const onTaskEnd = (key, r) => { if (ended.has(key)) return; ended.add(key); if (o.onTaskEnd) o.onTaskEnd(key, r); };
  const keys = (args.tasks || []).map((t) => t.key);
  // The calls of each task that did not end ok, from the adapter's records (onRecord), never read back from calls.jsonl.
  const failed = {};
  const withAdapter = (key, r) => (r && failed[key] && failed[key].length ? Object.assign({}, r, { adapter: failed[key].slice() }) : r);
  const threw = (e) => {
    note(`the chain script threw: ${(e && e.stack) || e}`);
    const results = keys.map((k) => withAdapter(k, stopped(k, `the chain script threw: ${(e && e.message) || e}`)));
    results.forEach((r) => onTaskEnd(r.task, r));
    return { results, threw: e };
  };
  try {
    const sharedDir = (args.config && args.config.sharedDir) || os.tmpdir();
    const cfg = adapterCfg(o.host, args, o.adapter || {}, o.callsDir || path.join(sharedDir, 'calls'), note, o.runId);
    if (o.launch) cfg.launch = o.launch;
    const steps = o.steps || null;
    const recs = {};
    cfg.onRecord = (rec) => {
      if (rec.stepId) recs[rec.stepId] = rec;
      if (rec.outcome !== 'ok' && rec.task) (failed[rec.task] = failed[rec.task] || []).push(adapterEntry(rec));
    };
    if (steps) cfg.onLaunch = (i) => steps.launch(i.key, i.stepId, { gated: !i.substitute, pid: i.pid, pgid: i.pgid, lstart: i.lstart, callDir: i.callDir, substitute: i.substitute });
    const run = createAgent(cfg);
    const exec = (step) => stepExec(steps, step, { runner: o.exec, note });
    const checkpoint = (key, getter) => { if (steps) steps.register(key, getter); };
    // The role calls of each task in flight (one settle promise per call). Two calls of a task run at once (review and
    // security review, Promise.all of role-chain.js), and Promise.all gives up on the first exception: so a role call
    // throws StopError only once no other call of its task is in flight, i.e. every role of the task has ended and its
    // step is closed in the journal. The end of the task, its lock and the exit of the conductor then never come while
    // a role of the task lives. A call leaves the set right after its own steps.end, before it waits for the others.
    // Service steps (exec) never run beside a role call of their task and are not in the set.
    const inflight = {};
    const othersSettled = async (key) => { while (key && inflight[key] && inflight[key].size) await Promise.allSettled([...inflight[key]]); };
    const agent = async (prompt, opts) => {
      const label = opts && opts.label;
      // A label that names no task of the run: the adapter refuses it with no process, so it needs no intent.
      const key = steps && steps.has(labelKey(label)) ? labelKey(label) : null;
      if (STOP.sig) { const sig = STOP.sig; await othersSettled(key); throw new StopError(sig); }
      const stepId = key ? steps.begin(key, { kind: 'agent', stepKind: String(label).split(':')[0], label, phase: opts.phase, effect: 'never', gated: true }) : undefined;
      let settled;
      const mine = new Promise((r) => { settled = r; });
      const leave = () => { if (key) inflight[key].delete(mine); settled(); };
      if (key) (inflight[key] = inflight[key] || new Set()).add(mine);
      try {
        note(`agent ${label} started`);
        const t0 = Date.now();
        const v = await run(prompt, key ? Object.assign({}, opts, { stepId }) : opts);
        const seconds = (Date.now() - t0) / 1000;
        note(`agent ${label} ${v === null ? 'null' : 'ok'} ${seconds.toFixed(1)} s`);
        if (key) {
          const r = recs[stepId] || {};
          steps.end(key, stepId, { outcome: r.outcome || null, value: v, rc: r.rc, signal: r.signal, error: r.error, callDir: r.callDir, seconds });
          leave();
          if (r.outcome === 'not-registered') throw new Error(`journal/run-state not written: ${r.error}`);
        }
        // A role that gives no answer while the conductor stops was interrupted by the stop: the chain gets StopError,
        // not null, so no path of role-chain.js turns the interrupt into a product outcome ("... returned no result")
        // before its next gate. The step is already closed in the journal with its outcome.
        if (v === null && STOP.sig) { const sig = STOP.sig; await othersSettled(key); throw new StopError(sig); }
        return v;
      } finally { leave(); }
    };
    const src = fs.readFileSync(path.join(o.pluginRoot || ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
    const parallel = (fns) => Promise.all(fns.map((f) => f()));
    const log = (m) => (o.log || note)(m);
    const phase = (title) => note(`phase ${title}`);
    const raw = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'exec', 'checkpoint', src)(
      agent, makePipeline(note, (k, r) => onTaskEnd(k, withAdapter(k, r)), (k, sig) => signalledResult(k, sig, steps && steps.has(k) ? steps.stopFields(k) : null)),
      parallel, log, phase, args, exec, checkpoint);
    const results = raw.map((r, i) => withAdapter(keys[i], r));
    keys.forEach((k, i) => onTaskEnd(k, results[i]));
    return { results, threw: null };
  } catch (e) { return threw(e); }
}

// ---- start
function flagsOf(argv, names) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(names, argv[i]) || argv[i + 1] === undefined) return { bad: `unknown or empty flag ${argv[i]}` };
    a[names[argv[i]]] = argv[++i];
  }
  return { a };
}
function usage(msg) { process.stderr.write(`chain-run: ${msg}\n${USAGE}\n`); process.exit(64); }

// The version of the installed plugin, for the record of a run. Its package.json is no service file of a run, so it is read
// plainly; null when it cannot be read: a run does not depend on it.
function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; }
}
function start(argv) {
  const { a, bad } = flagsOf(argv, { '--host': 'host', '--tasks': 'tasks', '--owner': 'owner', '--config': 'config', '--bin': 'bin',
    '--codex-home': 'codexHome', '--codex-auth': 'codexAuth', '--codex-key-file': 'codexKeyFile' });
  if (bad) usage(bad);
  if (a.host !== 'claude' && a.host !== 'codex') usage(`--host claude|codex, got ${JSON.stringify(a.host)}`);
  if (!a.tasks) usage('--tasks <file> is required');
  let text;
  try { text = fs.readFileSync(a.tasks, 'utf8'); } catch (e) { usage(`the tasks file ${a.tasks}: ${e.code || e.message}`); }
  const pt = parseTasks(text);
  if (pt.error) usage(pt.error);
  let owner = '';
  if (a.owner !== undefined) { try { owner = fs.readFileSync(a.owner, 'utf8'); } catch (e) { usage(`the owner file ${a.owner}: ${e.code || e.message}`); } }
  const lc = loadConfig(a.config);
  if (lc.error) { process.stderr.write(`${lc.error}\n`); process.exit(65); }
  const args = { owner, config: lc.config, tasks: pt.tasks };
  const ad = { bin: a.bin, codexHome: a.codexHome, codexAuth: a.codexAuth, codexKeyFile: a.codexKeyFile };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runId = `${stamp}-${require('crypto').randomBytes(3).toString('hex')}`;
  const runDir = path.join(realish(lc.config.sharedDir), 'runs', runId);
  try { createAgent(adapterCfg(a.host, args, ad, runDir, () => {}, runId)); } catch (e) { process.stderr.write(`chain-run: ${e.message}\n`); process.exit(64); }
  const where = stateRootProblem(args, a.host, process.env);
  if (where) { process.stderr.write(`chain-run: ${where}\n`); process.exit(64); }
  const logFile = path.join(runDir, 'log.txt');
  let fd;
  try {
    fs.mkdirSync(path.dirname(runDir), { recursive: true });
    fs.mkdirSync(runDir);
    writeJsonAtomic(path.join(runDir, 'request.json'), { runId, host: a.host, args, adapter: ad, argv: process.argv.slice(2),
      pluginVersion: pluginVersion(), requestedAt: new Date().toISOString() });
    fd = fs.openSync(logFile, 'a');
  } catch (e) { process.stderr.write(`chain-run: the state folder ${path.dirname(runDir)} (<sharedDir>/runs) cannot be written: ${e.message}\n`); process.exit(64); }
  const child = spawn(process.execPath, [__filename, 'run', runDir], { detached: true, stdio: ['ignore', fd, fd, 'ipc'], env: process.env });
  fs.closeSync(fd);
  let ready = false;
  child.on('message', (m) => {
    if (!m || m.type !== 'ready' || ready) return;
    ready = true;
    process.stdout.write(JSON.stringify({ runId, runDir, pid: child.pid, tasks: m.tasks }) + '\n');
    child.disconnect();
    child.unref();
    process.exit(0);
  });
  child.on('exit', (code, sig) => {
    if (ready) return;
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').slice(-3000); } catch { /* none */ }
    process.stderr.write(`chain-run: the conductor died before it was ready (${code === null ? sig : `exit ${code}`}); run folder ${runDir}\n${tail}\n`);
    process.exit(70);
  });
}

// ---- the conductor
async function conduct(runDirArg) {
  // The handlers of a stop come first, before run.json names this process (stop answers 6 until then) and stay until the
  // exit: the first signal starts the stop, a later one is only named. Lines before log.txt is known wait in early.
  let say = null;
  const early = [];
  const line = (m) => (say ? say(m) : early.push(m));
  for (const sig of SIGNALS) {
    process.on(sig, () => {
      if (STOP.sig) { line(`signal ${sig} ignored: stopping since ${STOP.sig}`); return; }
      line(`stopping ${sig}`);
      beginStop(sig);
    });
  }
  // The one resolution of the path: from here on every open follows no link.
  let runDir;
  try { runDir = fs.realpathSync(runDirArg); } catch (e) { process.stderr.write(`chain-run: ${e.message}\n`); process.exit(64); }
  const req = readJson(path.join(runDir, 'request.json'));
  if (!req) { process.stderr.write(`chain-run: no request.json in ${runDir}\n`); process.exit(64); }
  const writer = CJ.takeWriter(runDir, { pid: process.pid, lstart: lstartOf(process.pid), runId: req.runId });
  if (!writer.ok) { process.stderr.write(`chain-run: the run folder ${runDir} already has its writer (pid ${writer.held.pid || '?'}): one writer per run\n`); process.exit(5); }
  const note = (m) => { try { CJ.appendLine(path.join(runDir, 'log.txt'), `${new Date().toISOString()} ${m}\n`); } catch { /* the log is best effort */ } };
  say = note;
  for (const m of early.splice(0)) note(m);
  const args = req.args;
  const keys = args.tasks.map((t) => t.key);
  const me = { runId: req.runId, runDir, pid: process.pid, lstart: lstartOf(process.pid) };
  writeJsonAtomic(path.join(runDir, 'run.json'), { runId: req.runId, pid: me.pid, lstart: me.lstart, host: req.host, tasks: keys, argv: req.argv,
    pluginVersion: req.pluginVersion, startedAt: new Date().toISOString(), runDir });
  note(`conductor ${req.runId} pid ${me.pid} host ${req.host} tasks ${keys.join(', ')}`);
  const table = taskTable(args);
  const stateDir = path.join(runDir, 'tasks');
  fs.mkdirSync(stateDir, { recursive: true });
  const runsDir = path.dirname(runDir);
  const journals = {};
  const blocked = {};
  const held = new Set();
  const found = {};
  const block = (key, why) => { blocked[key] = stopped(key, why); note(`[${key}] stopped before any role: ${why}`); };
  for (const t of args.tasks) {
    const dir = table[t.key].dir;
    const lockFile = lockFileOf(runsDir, t.key);
    if (!me.lstart) { block(t.key, 'the conductor cannot read its own start time (ps -o lstart): the lock of the task cannot name it'); continue; }
    const noAuthor = req.host === 'codex' ? authorProblem(args.config, table[t.key].wt) : null;
    if (noAuthor) { block(t.key, noAuthor); continue; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ctx = { wt: table[t.key].wt, dir, key: t.key };
      let sc = null;
      const got = acquireTask(runsDir, t.key, me, () => {
        const rc = reconcile(runsDir, t.key, req.runId, ctx);
        // The decisions of resolve: the start follows their next (resumeAt, head, prior) - scripts/chain-resolve.js.
        if (!rc.reasons.length) { sc = RS.startCheck(runsDir, t.key, t, req.runId, ctx); if (sc.why) rc.reasons.push({ why: `undetermined: ${sc.why}`, kind: 'start' }); }
        // the commit journal of the task, read under its lock: no other conductor runs the task meanwhile
        const cj = !rc.reasons.length && req.host === 'codex' ? commitJournalProblem(args.config, t.key) : null;
        if (cj) rc.reasons.push({ why: cj, kind: 'commits' });
        return Object.assign(rc, { text: rc.reasons.length ? refusalText(rc, ctx) : null });
      });
      if (!got.ok) { block(t.key, got.why); continue; }
      held.add(t.key);
      found[t.key] = { notes: got.rc.notes };
      if (sc && sc.resumeSince) found[t.key].resumeSince = sc.resumeSince;
      if (sc && sc.priorNote) { found[t.key].prior = sc.priorNote; note(`[${t.key}] prior: ${sc.priorNote}`); }
      if (got.took) note(`[${t.key}] took over the lock of dead conductor run ${got.took.runId} (pid ${got.took.pid})`);
      for (const n of got.rc.notes) note(`[${t.key}] reconcile: ${n}`);
      // The registration: the journal and the steps folder, then the record that makes the task part of this run.
      try {
        journals[t.key] = CJ.openJournal(runDir, req.runId, t.key);
        for (const d of [path.join(runDir, 'steps'), stepDirOf(runDir, t.key)]) {
          try { fs.mkdirSync(d, { mode: 0o755 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          if (!fs.lstatSync(d).isDirectory()) throw new Error(`${d} is not a folder`);
        }
      } catch (e) {
        releaseLock(lockFile, me);
        held.delete(t.key);
        block(t.key, `journal/run-state not written: ${e.message}`);
        continue;
      }
      writeJsonAtomic(path.join(stateDir, `${t.key}.json`), { state: 'running', since: new Date().toISOString(), reconcile: found[t.key] });
    } catch (e) {
      if (held.has(t.key)) { try { releaseLock(lockFile, me); } catch { /* below */ } held.delete(t.key); }
      block(t.key, `the lock of the task could not be taken: ${e.message}`);
    }
  }
  if (process.send && process.connected) {
    const gone = new Promise((r) => process.once('disconnect', r));
    process.send({ type: 'ready', runId: req.runId, pid: process.pid, tasks: Object.fromEntries(keys.map((k) => [k, held.has(k) ? 'held' : blocked[k].why])) });
    await gone;
  }

  const runnable = args.tasks.filter((t) => held.has(t.key));
  const steps = makeSteps({ runId: req.runId, journals, table, note });
  // A stop before the script: every held task ends stopped with its prior as counts, nothing of it ran.
  const stopBeforeRoles = () => {
    for (const t of runnable) {
      byKey[t.key] = Object.assign(stopped(t.key, `signalled before any role: ${STOP.sig}`), { signal: STOP.sig, counts: RS.normCounts(t.prior), open: [], untaken: [] });
      endTask(t.key, byKey[t.key]);
    }
  };
  const endTask = (key, r) => {
    if (!held.has(key)) return;
    try { steps.finish(key, r); } catch (e) { note(`[${key}] ${e.message}`); }
    try { writeJsonAtomic(path.join(stateDir, `${key}.json`), { state: 'ended', endedAt: new Date().toISOString(), result: r || null, reconcile: found[key] }); } catch (e) { note(`[${key}] tasks/${key}.json could not be written: ${e.message}`); }
    try { releaseLock(lockFileOf(runsDir, key), me); } catch (e) { note(`[${key}] the lock could not be removed: ${e.message}`); }
    held.delete(key);
    note(`[${key}] ended: ${r ? r.status : 'no result'}`);
  };
  const byKey = {};
  let threw = null;
  // (a) a signal that came during the registration or the wait for the starter is seen here
  await settle();
  if (STOP.sig) stopBeforeRoles();
  else if (runnable.length) {
    const flags = ['check', '--host', req.host].concat(req.adapter.bin ? ['--bin', req.adapter.bin] : [],
      req.host === 'codex' ? [].concat(req.adapter.codexHome ? ['--home', req.adapter.codexHome] : [], req.adapter.codexAuth ? ['--auth', req.adapter.codexAuth] : [],
        req.adapter.codexKeyFile ? ['--key-file', req.adapter.codexKeyFile] : []) : ['--plugin-root', ROOT]);
    const ck = spawnSync(process.execPath, [path.join(__dirname, 'role-exec.js')].concat(flags), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let cj = null;
    try { cj = JSON.parse(ck.stdout); } catch { /* below */ }
    // (b) a signal that came during the host check
    await settle();
    if (STOP.sig) stopBeforeRoles();
    else if (!cj || !cj.ok) {
      const why = `the host check failed (role-exec.js check --host ${req.host}): ${cj ? cj.problems.join('; ') : (ck.stderr || ck.stdout || `exit ${ck.status}`).trim()}`;
      note(why);
      for (const t of runnable) { byKey[t.key] = stopped(t.key, why); endTask(t.key, byKey[t.key]); }
    } else {
      const x = await runScript({ host: req.host, runId: req.runId, args: Object.assign({}, args, { tasks: runnable.map((t) => Object.assign({}, t, { stepDir: stepDirOf(runDir, t.key) }, found[t.key].resumeSince ? { resumeSince: found[t.key].resumeSince } : {})) }), adapter: req.adapter, callsDir: runDir,
        steps, note, log: (m) => note(`log ${m}`), onTaskEnd: endTask });
      threw = x.threw;
      runnable.forEach((t, i) => { byKey[t.key] = x.results[i] || stopped(t.key, 'the chain gave no result'); });
    }
  }
  for (const k of [...held]) endTask(k, byKey[k] || null);
  // (c) a signal before results.json makes the exit 128+n, whatever the tasks reached; one after it is never handled
  // (nothing below yields to the event loop), so the exit is the code results.json holds.
  await settle();
  const results = keys.map((k) => blocked[k] || byKey[k]);
  let exitCode = STOP.sig ? signalCode(STOP.sig) : threw ? 4 : results.every((r) => r && r.status === 'done') ? 0 : 3;
  try { writeJsonAtomic(path.join(runDir, 'results.json'), { runId: req.runId, exitCode, finishedAt: new Date().toISOString(), results }); } catch (e) {
    if (!STOP.sig) exitCode = 4;
    note(`results.json could not be written: ${e.message}`);
    process.stderr.write(`chain-run: results.json could not be written: ${e.message}\n`);
  }
  note(`conductor exit ${exitCode}`);
  process.exit(exitCode);
}

// ---- stop: SIGTERM to the conductor of a run, only to its own pid and only when it is the process run.json names
// (owner 2026-11-07, p-codex-threat-scope.md). The first check that fires decides (the README, "Stopping a run").
function stopCmd(argv) {
  const id = argv[0];
  if (!id || id.startsWith('--')) usage('stop <run-id|run folder> [--config <file>]');
  const { a, bad } = flagsOf(argv.slice(1), { '--config': 'config' });
  if (bad) usage(bad);
  const r = runDirOf(id, a.config);
  if (r.error || !fs.existsSync(path.join(r.dir, 'request.json'))) { process.stderr.write(`chain-run: ${r.error || `no run in ${r.dir}`}\n`); process.exit(64); }
  const dir = fs.realpathSync(r.dir);
  const answer = (code, obj) => {
    if (obj.why) process.stderr.write(`chain-run: ${obj.why}\n`);
    process.stdout.write(JSON.stringify(obj) + '\n');
    process.exit(code);
  };
  const res = read3(path.join(dir, 'results.json'));
  if (!res.none) answer(2, { state: 'finished', exitCode: res.data && isPlain(res.data) ? res.data.exitCode : null });
  const unknown = (why) => answer(6, { state: 'unknown', why: `${why}: no signal sent` });
  const run = read3(path.join(dir, 'run.json'));
  if (run.none) unknown(`${dir}/run.json is not there (the conductor has not written it yet)`);
  if (!run.data || !isPlain(run.data)) unknown(`${dir}/run.json cannot be read (${run.unreadable || 'not an object'})`);
  const pid = run.data.pid;
  if (!Number.isInteger(pid) || pid <= 1) unknown(`run.json names no process (pid ${JSON.stringify(pid)})`);
  const recorded = normL(run.data.lstart);
  if (!recorded) unknown(`run.json names no start time of pid ${pid}`);
  const there = exists(pid);
  if (there === false) answer(4, { state: 'dead', why: `the conductor (pid ${pid}) is gone without results.json, see chain-run.js status` });
  if (there === null) unknown(`whether pid ${pid} exists cannot be told`);
  const now = lstartOf(pid);
  if (!now) unknown(`ps does not answer for pid ${pid}`);
  if (normL(now) !== recorded) answer(4, { state: 'dead', why: `pid ${pid} is another process (started ${normL(now)}, the conductor ${recorded}): the conductor is gone without results.json` });
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    if (e.code === 'ESRCH') answer(4, { state: 'dead', why: `the conductor (pid ${pid}) ended just now` });
    unknown(`kill ${pid} SIGTERM failed (${e.code || e.message})`);
  }
  answer(0, { sent: 'SIGTERM', pid, runId: run.data.runId || path.basename(dir) });
}

// ---- status
function runDirOf(arg, configFile) {
  if (arg.includes('/')) return { dir: path.resolve(arg) };
  const lc = loadConfig(configFile);
  if (lc.error) return { error: lc.error };
  const runs = path.join(lc.config.sharedDir, 'runs');
  const dir = path.join(runs, arg);
  if (fs.existsSync(path.join(dir, 'request.json'))) return { dir };
  let ids = [];
  try { ids = fs.readdirSync(runs).filter((n) => !n.startsWith('.')).sort(); } catch { /* none */ }
  return { error: `no run ${arg} in ${runs}; runs: ${ids.join(', ') || 'none'}` };
}
function logState(runDir) {
  let text = '';
  try { text = CJ.readText(path.join(runDir, 'log.txt')); } catch { /* none yet */ }
  const open = {}, last = {};
  let phase = null;
  for (const l of text.split('\n')) {
    const m = /^(\S+) (?:agent|exec) (\S+) (started|ok|null|no-json)(?: ([\d.]+) s)?$/.exec(l);
    if (m) {
      const k = (/^[a-z]+:([^:#]+)/.exec(m[2]) || [])[1] || '?';
      open[k] = open[k] || {};
      if (m[3] === 'started') open[k][m[2]] = m[1];
      else { delete open[k][m[2]]; last[k] = `${m[2]} ${m[3]} ${m[4]} s at ${m[1]}`; }
      continue;
    }
    const p = /^\S+ phase (.*)$/.exec(l);
    if (p) phase = p[1];
  }
  return { open, last, phase };
}
function snapshot(runDir) {
  const res = () => { const r = readJson(path.join(runDir, 'results.json')); return r && Array.isArray(r.results) ? r : null; };
  const req = readJson(path.join(runDir, 'request.json')) || {};
  const done = res();
  const decided = (k) => ({ basis: RS.basisOf(runDir, k), resolved: (() => { const d = RS.decisionsOf(runDir, k); return d.list.concat(d.abort ? [d.abort] : []).map(RS.decisionLine); })() });
  const keys0 = ((req.args && req.args.tasks) || []).map((t) => t.key);
  if (done) return { state: 'finished', runId: done.runId, exitCode: done.exitCode, results: done.results, tasks: Object.fromEntries(keys0.map((k) => [k, decided(k)])) };
  const run = readJson(path.join(runDir, 'run.json'));
  // unknown counts as running: a conductor that cannot be told dead is not declared dead.
  const live = !!run && liveness({ pid: run.pid, lstart: run.lstart }).state !== 'gone';
  const again = live ? null : res();
  if (again) return { state: 'finished', runId: again.runId, exitCode: again.exitCode, results: again.results, tasks: Object.fromEntries(keys0.map((k) => [k, decided(k)])) };
  const ls = logState(runDir);
  const keys = ((req.args && req.args.tasks) || []).map((t) => t.key);
  const table = req.args ? taskTable(req.args) : {};
  const tasks = {};
  for (const k of keys) {
    const st = readJson(path.join(runDir, 'tasks', `${k}.json`));
    const jr = CJ.readJournal(runDir, k);
    const ctx = { runId: req.runId || path.basename(runDir), wt: table[k] && table[k].wt, dir: table[k] && table[k].dir };
    // The open steps come from the journal; without one (a run of an older version, damage), from the lines of the log.
    const open = jr.state ? Object.values(jr.state.open).map((x) => ({ stepId: x.stepId, label: x.label, since: x.at, effect: x.effect, pid: x.launch ? x.launch.pid : null, text: openStepText(x, ctx) }))
      : Object.entries(ls.open[k] || {}).map(([label, since]) => ({ label, since }));
    tasks[k] = Object.assign({ state: st ? st.state : 'not taken', open, last: ls.last[k] || null }, decided(k));
    if (!jr.none) tasks[k].journal = { seq: jr.seq, snapshot: jr.snapshot, segments: jr.segments, torn: jr.torn, error: jr.error };
    if (!live && table[k]) {
      const u = unrecordedCalls(table[k].dir);
      tasks[k].unrecordedCalls = u.calls;
      if (u.error) tasks[k].unrecordedCallsError = u.error;
    }
  }
  const base = { runId: req.runId || path.basename(runDir), pid: run ? run.pid : null, startedAt: run ? run.startedAt : null, phase: ls.phase, tasks };
  return live ? Object.assign({ state: 'running' }, base)
    : Object.assign({ state: 'dead', note: 'the conductor is gone without results.json: its locks stay, and a start of its tasks is refused while the reconciliation finds an open step of a live or unknown process, a launched role without a result, a verdict whose use is not proven or damage' }, base);
}
function status(argv) {
  const id = argv[0];
  if (id === '--commits') return RS.statusCommits(argv);
  if (!id || id.startsWith('--')) usage('status <run-id|run folder>');
  const { a, bad } = flagsOf(argv.slice(1), { '--wait': 'wait', '--config': 'config' });
  if (bad) usage(bad);
  if (a.wait !== undefined && !/^\d+$/.test(a.wait)) usage(`--wait <seconds>, got ${JSON.stringify(a.wait)}`);
  const max = a.wait === undefined ? 0 : Math.min(MAX_WAIT, +a.wait);
  const r = runDirOf(id, a.config);
  if (r.error || !fs.existsSync(path.join(r.dir, 'request.json'))) { process.stderr.write(`chain-run: ${r.error || `no run in ${r.dir}`}\n`); process.exit(64); }
  r.dir = fs.realpathSync(r.dir);
  process.on('SIGINT', () => process.exit(130));
  const t0 = Date.now();
  const CODES = { finished: 0, running: 3, dead: 4 };
  (function tick() {
    const s = snapshot(r.dir);
    const waited = Math.round((Date.now() - t0) / 1000);
    if (s.state !== 'running' || Date.now() - t0 >= max * 1000) {
      process.stdout.write(JSON.stringify(Object.assign({ max, waited }, s)) + '\n');
      process.exit(CODES[s.state]);
    }
    setTimeout(tick, Math.min(1000, Math.max(50, max * 1000 - (Date.now() - t0))));
  })();
}

// Before the command line: resolve (scripts/chain-resolve.js) takes these functions at call time.
module.exports = { authorProblem, commitJournalProblem, commitStateDir, beginStop, StopError, lockData, liveText, read3, openStepVerdict, lockFileOf, loadConfig, runDirOf, refusalText, makeSteps, stepExec, openStepText, stateRootProblem, runScript, makePipeline, taskTable, parseTasks, lstartOf, liveness, reconcile, acquireTask, unrecordedCalls, takeLock, releaseLock, execStep, hookGate, adapterCfg, logState, CAUSE_KNOWN, MAX_WAIT };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'start') start(rest);
  else if (cmd === 'status') status(rest);
  else if (cmd === 'stop') stopCmd(rest);
  else if (cmd === 'resolve') RS.main(rest);
  else if (cmd === 'run' && rest.length === 1) conduct(path.resolve(rest[0])).catch((e) => { process.stderr.write(`chain-run: the conductor failed: ${e.stack}\n`); process.exit(4); });
  else usage(`unknown command ${JSON.stringify(cmd)}`);
}
