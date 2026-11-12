#!/usr/bin/env node
'use strict';
// The role adapter (p-codex-A): runs a role of workflows/role-chain.js on a host CLI - codex (Codex CLI) or claude
// (Claude Code) - with the same contract as the Workflow global agent(): agent(prompt, {schema, model?, effort?, label,
// phase?, agentType}) -> the object of the schema, or null (never an exception). role-chain.js does not change.
//
// createAgent(cfg) checks the config; each call is prepared here (the task from the label, the role from the kind of the
// label, the body of the role, model and effort, the strict schema, the argv of the host), its prompt is saved in a call
// folder of its own, the plan is run by the launcher, and the answer is checked against the original schema. The
// launcher is the real process of the host CLI (spawnRole: the launch gate, then the CLI in its own process group, the
// prompt on stdin, the JSONL stream parsed line by line, the outcome by the fields of the terminal event, the exit code
// and the signal, the ceiling of 3 h on the monotonic clock, SIGTERM/SIGINT/SIGHUP of the adapter, or stopAll(sig) of a
// host with its own handlers, passed to every live group); cfg.launch replaces it (tests, chain-cost). One line of <task dir>/calls.jsonl per call, whatever its outcome (never written through a
// link, FIFO or hard link the role left in place of the file: appendRecord).
// The launch gate (GATE): the process starts as /bin/sh that waits for one line "go" on stdin and then execs the CLI, so
// its pid, process group and start time are the CLI's own, and the CLI does no work before the line comes. With
// cfg.onLaunch the adapter reads the group and the start time (ps) and calls onLaunch({label, key, stepId, callDir, host,
// pid, pgid, lstart}) synchronously before "go": a registration that fails (it throws, ps gives nothing) closes stdin, the
// gate exits 70 without starting the CLI, and the call ends as not-registered. A launcher of the caller (cfg.launch) calls
// onLaunch({..., substitute: true, pid: null}) before it runs. There is no timer in the gate: a direct wait on the
// stdin of claude -p would end after 3 s (experiment E2 of the analysis).
// Hooks of a caller that runs the adapter (scripts/chain-run.js): cfg.beforeLaunch(plan) runs after a call passed every
// static refusal and before its launch; it resolves null to launch, or {outcome, error} to end the call with that
// outcome and no process (the hook check of a codex role). cfg.onRecord(rec) gets the record of every call before it is
// appended to calls.jsonl, also when the file refuses it. cfg.preconditionsByConductor lets pre run on codex: the
// conductor ran env-check.js on the host and the prompt carries its result, so pre needs no ps or sysctl of its own.
// prog and test on codex need cfg.commit and get the commit channel (scripts/commit-service.js): a box in its call
// folder, the answers in commit.stateDir, CODIS_COMMIT_BOX and CODIS_COMMIT_ANSWERS in its environment, the service
// open while the launcher runs and until a check it runs is stopped (its hooks run in codex sandbox with the rights of
// the role); the record carries its summary. Their sandbox is the legacy workspace-write with the worktree as the
// workspace root (-C, cwd) and the task folder as the one extra writable root, the network only for test
// (scripts/role-roots.js), and npm_config_cache the npm cache of the call. With cfg.heavy they also get the heavy channel
// (scripts/heavy-service.js): a box "heavy" in the call folder, CODIS_HEAVY_BOX and CODIS_HEAVY_ANSWERS,
// the service open as long as the commit channel, its runs stopped when the call ends or the adapter is signalled; the
// record carries its summary (heavy). Every role on codex gets the host section at
// the end of its prompt (hostSection). An ok answer of prog/test is compared with the adapter's commits (compareAnswer):
// a head or a commit the adapter did not make, or a branch moved behind it, ends the call as invalid-result.
//
// usage: node role-exec.js check --host codex [--bin <codex>] --home <run home> [--auth chatgpt|apiKeyFile]
//          [--key-file <file>] [--model <slug>] [--effort <level>] [--versions <a,b>]
//        node role-exec.js check --host claude [--bin <claude>] [--plugin-root <dir>]
// check calls no model: it prints JSON {ok, host, version, binKind?, problems} and exits 0 (ok), 1 (problems), 2 (usage).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { openCommitService, VERIFIED_CODEX_VERSIONS } = require('./commit-service');
const { openHeavyService } = require('./heavy-service');
const { realish, inside, overlap, roleRoots } = require('./role-roots');

// The JSON Schema keywords the twelve schemas of role-chain.js use. Strict mode of the OpenAI API supports a subset of
// JSON Schema; only these words are converted, and any other one is refused before a call, never guessed (A1-04).
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description']);
// The model table of codex: the Claude alias of the role (role-chain.js modelOf) -> the codex model; "default" for a call
// without a model. Owner 2026-11-05 (question 8): every role on codex runs gpt-6-astra with effort high.
const DEFAULT_CODEX_MODELS = Object.freeze({ opus: 'gpt-6-astra', default: 'gpt-6-astra' });
const DEFAULT_CODEX_EFFORT = 'high';
// The allowed codex versions of `check`: the verified list of the commit channel itself (one list, never a copy).
const DEFAULT_CODEX_VERSIONS = VERIFIED_CODEX_VERSIONS;
// The catalog of codex models (`codex debug models`), cached by `check` in the run home and read by the adapter.
const CATALOG_FILE = 'codis-agents-models.json';
const AGENT_PREFIX = 'codis-agents:';
// The only timer of a role (owner decision 2: no silence timer, a ceiling of 3 h). Node timers run on the monotonic
// clock, which stands still while the Mac sleeps (owner answer 9); the record keeps the wall seconds as well.
const CEILING_MS = 3 * 60 * 60 * 1000;
// The pause between SIGTERM and SIGKILL of a role's group, at the ceiling and on a signal (owner answer 2).
const KILL_GRACE_MS = 30 * 1000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// Tools of `claude -p` that a Workflow agent lacks: subagents, schedules and notifications. Names as the init event of
// claude 2.1.318 lists them in its tools (experiment X0 E1c); MCP servers are off by --strict-mcp-config.
const CLAUDE_DISALLOWED = ['Task', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification'];
const NOTES_MAX = 50;
// argv of the gate: sh -c GATE gate <bin> <argv...>; 70 stdin ended before the line, 71 another line. The shell reads
// stdin byte by byte, so the prompt behind the line stays for the CLI.
const GATE = 'IFS= read -r go || exit 70; [ "$go" = go ] || exit 71; exec "$@"';
const DESCENDANTS_NOTE = 'descendants outside the process group are not tracked';
const ROLE_FILES = ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer'];
// The role is the kind of the label (role-chain.js labels are "<kind>:<task key>..."), not the agentType: agentType only
// picks the body (with agentTypePrefix "" every role is general-purpose).
const KINDS = {
  pre: 'preconditions', analyst: 'analyst', usecases: 'analyst', prog: 'programmer', test: 'tester', review: 'reviewer',
  sec: 'security-reviewer', sha: 'service', diff: 'service', left: 'service', post: 'service', run: 'service', merge: 'service',
};
// The kinds of label that get the commit channel (cfg.commit): the roles that commit code or guards.
const COMMIT_KINDS = new Set(['prog', 'test']);
const COMMIT_CLIENT = path.join(__dirname, 'commit-req.js');
const HEAVY_CLIENT = path.join(__dirname, 'heavy-req.js');
const WAIT_STEP = path.join(__dirname, 'wait-step.js');
// Refusals of the codex host by the kind of the label ('' when the kind runs); the claude host runs every kind. pre runs
// only when the conductor checked the environment itself (preByConductor: cfg.preconditionsByConductor). prog and test
// run, with the commit channel (createAgent refuses them without cfg.commit).
const CODEX_REFUSED = (kind, preByConductor) => (KINDS[kind] === 'service'
  ? `service step "${kind}" on codex: the conductor runs it as a child process (scripts/chain-run.js exec)`
  : kind === 'pre' && !preByConductor ? 'the preconditions run on the coordinator\'s host, outside the codex sandbox (slots and swap need ps and sysctl): run the chain through scripts/chain-run.js, which checks the environment itself'
    : '');

// The host section: the end of the prompt of every role on codex. It replaces the rules of the Workflow prompt that name
// tools this host does not have (Bash run_in_background, Monitor, a blocking Bash loop) and, for prog and test, says how
// a commit is made (the sandbox refuses git add and git commit) and what head and commits of the answer must name
// (compareAnswer checks them). With the heavy channel (o.heavy: cfg.heavy, scripts/heavy-service.js) prog and test are
// told how to run a heavy command through it; without it a slot refusal is the environment.
const HOST_HEADING = '## On this host (codex)';
function hostSection(kind, t, o) {
  const heavy = !!(o && o.heavy);
  const id = path.join(t.dir, 'wait-<name>');
  const lines = [HOST_HEADING, '',
    'This section replaces the rules about pauses, slots and git add above: this host has no Bash run_in_background, no Monitor and no blocking Bash loop.',
    `- Waiting. Start a command that runs longer than 25 s with \`node ${WAIT_STEP} start --id ${id} -- <command>\`, then wait for it with \`node ${WAIT_STEP} wait --id ${id} --max 25\` and repeat the wait until it prints "done":true. 25 s is the longest single wait (the shell tool of this host answers "still running" after about 30 s, and a command still attached to a turn dies with the turn), not a required interval: a wait that returns earlier is not the end of your role (the command ended, or it is still alive and you wait again). A turn that ends without a tool call ends your role: never end a turn with text like "Waiting.".`];
  if (COMMIT_KINDS.has(kind)) {
    lines.push(
      `- Commits. The sandbox refuses git add, git commit and every write into the git folder: never run them. Commit only through \`node ${COMMIT_CLIENT} -m "<message>" -- <path>...\` (paths relative to the worktree): it prints one JSON line with the sha or the reason of a refusal; exit 3 is pending, then wait with \`node ${COMMIT_CLIENT} wait --id <id>\`. Wait for the sha of each commit before the next step: the red guard committed before the fix, the fix committed before any mutation. Restore a mutated file with \`git show HEAD:<path> > <path>\` (git checkout and git restore are refused here).`,
      '- Your answer: `head` is the last sha the adapter gave you in this call (no commit in this call: `git rev-parse HEAD` at its start); `commits`, where your answer has it, names only the shas the adapter gave you in this call, never commits of an earlier call.',
      heavy ? `- Heavy commands (tsc, a bundler, a guard with vite, anything that takes a memory slot): never run heavy.sh or medium.sh yourself (inside this sandbox they cannot take a slot). Ask the adapter: \`node ${HEAVY_CLIENT} [--kind <kind>] -- <argv>\` (cwd: the current folder, inside the worktree) runs <argv> in a memory slot, in a sandbox with your write roots and only the loopback network, and prints one JSON line {id, state, rc, log, tail}; while state is not final wait with \`node ${HEAVY_CLIENT} wait --id <id> --max 25\`, stop it with \`node ${HEAVY_CLIENT} cancel --id <id>\`. rc is the code of the command, log its whole output. One run at a time: a second request waits behind the first. A state refused, cancelled-before-start or undetermined whose why starts with "environment:" is the environment, answered as environment with that cause. Guard runs: where the rules above say guards-all.sh (a full run, or --select <ref>), ask \`node ${HEAVY_CLIENT} --kind full\` or \`node ${HEAVY_CLIENT} --kind select --base <ref>\` instead (no argv: the adapter runs guards-all.sh outside this sandbox with the run's project config, in a slot of its own, and every command of the project in this sandbox) and wait for it as above; rc is the code of guards-all.sh, guardsLog the guard log in the shared folder (cite it in your report), where says "local full run" or "local selection" (the remote runner is not used for a codex role); verdict is green, red, incomplete or environment, and notRun lists the guards the run did not run, each with its need and reason. incomplete: guards not run in this sandbox (their files declare a \`guards:needs\` marker: a browser, a file watcher, ps, Docker...) - name each under Incomplete in your report with its need and reason; never call the run green; not a red of the product. An answer without verdict is not green: read guardsLog. guards-all.sh in an argv is refused; Docker and the stand too. A guard without a marker that is red only because this sandbox lacks what it needs (a browser, a file watcher, ps, a nested sandbox, Docker) is a red of the run, named with the guard and the line of its log as a candidate for a \`guards:needs\` marker, never a red of the product.`
        : '- Heavy commands. heavy.sh, medium.sh and guards-all.sh cannot take a memory slot inside this sandbox: their exit 77, 72 or 78 is the environment, answered as environment with the cause "needs the heavy channel (A2b)"; never run the work around the slot.',
      '- An acceptance this sandbox cannot run (it needs the network, Docker or a stand) is the environment with its cause: never green or ready without it.',
      '- A merge of the arc (a conflict round of the train) is impossible on this host (the git folder is read only): answer with status blocked and the cause.');
  }
  return lines.join('\n') + '\n';
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
// A read-only git command in the worktree for the compare of an answer: git of cfg.commit (else the PATH), no fsmonitor,
// none of the caller's GIT_* variables. The trimmed stdout, or null.
function gitRead(bin, env, wt, args) {
  const e = {};
  for (const [k, v] of Object.entries(env || {})) if (!/^GIT_/.test(k)) e[k] = v;
  e.LC_ALL = 'C';
  const p = spawnSync(bin, ['-c', 'core.fsmonitor=false', '-C', wt].concat(args), { encoding: 'utf8', env: e, timeout: 60000 });
  return p.status === 0 ? String(p.stdout).trim() : null;
}
// The ok answer v of prog/test against the adapter's commits of this call (sum.commits), the tip at its start and at its
// end: head must be a prefix (7 hex digits or more) of the last sha the adapter committed, else of the start tip; every
// sha of commits a prefix of one of them, or an ancestor of the start tip (a commit of an earlier call: a note); the tip
// at the end equal to that same sha. head is compared when the schema has it, commits when the answer has the array.
// An unknown start tip (the worktree has no readable HEAD) leaves only commits to compare: it must be empty.
// -> {problems, notes}
function compareAnswer(schema, v, sum, startTip, endTip, isAncestor) {
  const problems = [], notes = [];
  const shas = (sum.commits || []).map((c) => c.sha);
  const last = shas.length ? shas[shas.length - 1] : startTip;
  const prefixOf = (x, full) => typeof x === 'string' && SHA_RE.test(x) && !!full && full.startsWith(x.toLowerCase());
  const commits = Array.isArray(v.commits) ? v.commits : [];
  if (!last) {
    notes.push('start tip unknown: head and the tip at the end of the call are not compared');
    if (commits.length) problems.push(`commits names ${commits.map((c) => JSON.stringify(c)).join(', ')} but the start tip unknown: no commit of this call or an earlier one can be told`);
    return { problems, notes };
  }
  const props = (schema && schema.properties) || {};
  if (own(props, 'head') && !prefixOf(v.head, last)) {
    problems.push(`head ${JSON.stringify(v.head)} is not the adapter's last commit ${last}${shas.length ? '' : ' (no commit in this call: the tip at its start)'}`);
  }
  for (const c of commits) {
    if (shas.some((s) => prefixOf(c, s))) continue;
    if (startTip && typeof c === 'string' && SHA_RE.test(c) && isAncestor(c, startTip)) { notes.push(`commits names ${c}, a commit of an earlier call (an ancestor of the start tip ${startTip})`); continue; }
    problems.push(`commits names ${JSON.stringify(c)}: not a commit of the adapter in this call and not an ancestor of the start tip ${startTip}`);
  }
  if (endTip !== last) problems.push(`the branch tip at the end of the call is ${endTip || 'unreadable'}, not ${last}: the branch moved outside the adapter`);
  return { problems, notes };
}

const types = (n) => [].concat(n && n.type !== undefined ? n.type : []);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// What keeps a schema from its strict form: unknown keywords, a node without a type, an object without properties, a
// required key that is not a property. [] for each of the twelve schemas of role-chain.js.
function schemaProblems(s, p = '$', out = []) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) { out.push(`${p}: not a schema object`); return out; }
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) out.push(`${p}: keyword ${k}`);
  if (!types(s).length) out.push(`${p}: no type`);
  if (types(s).includes('object')) {
    if (!s.properties || typeof s.properties !== 'object') out.push(`${p}: object without properties`);
    for (const r of s.required || []) if (!s.properties || !own(s.properties, r)) out.push(`${p}: required ${r} is not a property`);
  }
  if (s.properties && typeof s.properties === 'object') for (const [k, v] of Object.entries(s.properties)) schemaProblems(v, `${p}.${k}`, out);
  if (s.items) schemaProblems(s.items, `${p}[]`, out);
  return out;
}

// The strict form for codex --output-schema: on every object level all keys required, additionalProperties false, an
// optional field admits null (its enum too); a field that admits null already is unchanged. A new object: the input is
// never changed (role-chain.js shares DIFF_SCHEMA and LEFT_SCHEMA with POST_SCHEMA, and two calls run at once).
function strict(s) {
  const probs = schemaProblems(s);
  if (probs.length) throw new Error(`the schema has no strict form: ${probs.join('; ')}`);
  return toStrict(s);
}
function toStrict(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'properties' && k !== 'items' && k !== 'required') out[k] = Array.isArray(v) ? v.slice() : v;
  if (s.items) out.items = toStrict(s.items);
  if (s.properties) {
    const req = new Set(s.required || []);
    out.properties = {};
    for (const [k, p] of Object.entries(s.properties)) {
      const q = toStrict(p);
      if (!req.has(k) && !types(p).includes('null')) {
        q.type = types(p).concat('null');
        if (p.enum) q.enum = p.enum.concat(null);
      }
      out.properties[k] = q;
    }
    out.required = Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
}

// Back to the shape of the original schema: a null in a field that strict() made nullable (optional in the original and
// not nullable there) is removed; a field that admitted null in the original keeps it, required or not (RUN_SCHEMA.rc:
// required and nullable, live check G6). A new value; the input is not changed.
function unstrict(v, s) {
  if (Array.isArray(v)) return v.map((x) => (s && s.items ? unstrict(x, s.items) : x));
  if (!v || typeof v !== 'object') return v;
  const props = (s && s.properties) || {};
  const req = new Set((s && s.required) || []);
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    const p = own(props, k) ? props[k] : null;
    if (x === null && p && !req.has(k) && !types(p).includes('null')) continue;
    o[k] = p ? unstrict(x, p) : x;
  }
  return o;
}

const isType = (t, v) => (t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isInteger(v)
  : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : typeof v === t);
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
// The errors of a value against a schema of the known keywords; [] when it passes.
function validate(v, s, p = '$', out = []) {
  const ts = types(s);
  if (ts.length && !ts.some((t) => isType(t, v))) { out.push(`${p}: expected ${ts.join('|')}, got ${kindOf(v)}`); return out; }
  if (s.enum && !s.enum.some((e) => e === v)) out.push(`${p}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if (isType('object', v) && s.properties) {
    for (const r of s.required || []) if (!own(v, r)) out.push(`${p}.${r}: required`);
    for (const [k, ps] of Object.entries(s.properties)) if (own(v, k)) validate(v[k], ps, `${p}.${k}`, out);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => validate(x, s.items, `${p}[${i}]`, out));
  return out;
}

// "<kind>:<key>" with an optional tail ":<x>" or "#<n>" (and "#retry"): {kind, key, role}; null when the kind is unknown
// or the key is empty. A task key with ":" or "#" is refused by createAgent, so the key is the second segment.
function parseLabel(label) {
  const m = typeof label === 'string' ? /^([a-z]+):([^:#]+)(?:[:#].*)?$/.exec(label) : null;
  return m && own(KINDS, m[1]) ? { kind: m[1], key: m[2], role: KINDS[m[1]] } : null;
}

const readCatalog = (home) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, CATALOG_FILE), 'utf8')); } catch { return null; }
};
const levelsOf = (entry) => (entry.supported_reasoning_levels || []).map((l) => (l && typeof l === 'object' ? l.effort : l));
// The key file of the apiKeyFile mode: {key} or {error}; the value never goes into a message.
function readKey(file) {
  if (!file) return { error: 'codex.keyFile is not set (auth apiKeyFile)' };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { error: `key file ${file}: ${e.code || e.message}` }; }
  if (st.mode & 0o077) return { error: `key file ${file} has mode ${(st.mode & 0o777).toString(8)}: it must be 600` };
  const key = fs.readFileSync(file, 'utf8').trim();
  return key ? { key } : { error: `key file ${file} is empty` };
}
// The environment of a codex child: the run home; chatgpt mode drops inherited key variables (Codex would take them
// silently), apiKeyFile mode sets CODEX_API_KEY for this child only.
function codexEnv(base, home, auth, key) {
  const env = Object.assign({}, base);
  delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY;
  // the commit channel is given per call (prog and test with cfg.commit); an inherited one never reaches a role
  delete env.CODIS_COMMIT_BOX; delete env.CODIS_COMMIT_ANSWERS; delete env.CODIS_HEAVY_BOX; delete env.CODIS_HEAVY_ANSWERS;
  env.CODEX_HOME = home;
  if (auth === 'apiKeyFile' && key) env.CODEX_API_KEY = key;
  return env;
}

// The personal ~/.codex of the user is never the run home of the chains (owner decision 6: a separate home with its own
// login); compared by the real path, so a link to it or another case of its name is the same home. realpathSync.native,
// because the JS realpathSync keeps the case it was given: on a case-insensitive disk two spellings of one folder would
// compare as two folders.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const isPersonalCodex = (home) => real(home) === real(path.join(os.homedir(), '.codex'));
const personalNo = (home) => `codex.home ${home} is the personal ~/.codex: the chains run in a separate home with its own login (CODEX_HOME=<home> codex login)`;

// ---- signals of the adapter (UC-5): every live role process of this Node process, of any adapter
const LIVE = new Set();
const handlers = {};
let stopping = null;
function finishStop() {
  for (const s of Object.keys(handlers)) { process.removeListener(s, handlers[s]); delete handlers[s]; }
  process.exitCode = 128 + os.constants.signals[stopping];
}
// A signal of the adapter's handlers, or stopAll(sig) of a host that handles its own signals (scripts/chain-run.js): the
// first one is kept, every live role and check gets stop('signalled') (a repeat changes nothing: the pause of a stop runs
// from its first SIGTERM), and from then on no call starts.
function gotSignal(sig) {
  if (!stopping) stopping = sig;
  for (const stop of LIVE) stop('signalled');
  if (!LIVE.size) finishStop();
}
// The handlers are on while a role process lives; after a signal, when the last one is gone, they are removed and
// process.exitCode is 128+n: the host exits by itself, and no new call starts. A process that enters after the stop is
// stopped at once.
function enter(stop) {
  LIVE.add(stop);
  if (stopping) { stop('signalled'); return; }
  for (const s of SIGNALS) if (!handlers[s]) { handlers[s] = () => gotSignal(s); process.on(s, handlers[s]); }
}
function leave(stop) {
  LIVE.delete(stop);
  if (LIVE.size) return;
  if (stopping) finishStop();
  else for (const s of Object.keys(handlers)) { process.removeListener(s, handlers[s]); delete handlers[s]; }
}

// {status, code} of an API error message of codex: a JSON string {"type":"error","error":{..,"code"},"status":n} (the
// form of the 400 seen live). The error events of exec --json carry only a message; a plain-text message (the plan
// limit of a subscription among them) has no status and ends as crashed, never matched by words.
function apiStatus(msg) {
  try { const j = JSON.parse(msg); return { status: typeof j.status === 'number' ? j.status : null, code: (j.error && j.error.code) || null }; } catch { return { status: null, code: null }; }
}
// The outcome of an API status: by the fields, never by the words of the message.
const byStatus = (s, schemaCode) => (s.status === 400 && schemaCode && s.code === 'invalid_json_schema' ? 'schema-refused'
  : s.status === 429 ? 'rate-limited' : s.status === 401 || s.status === 403 ? 'auth' : 'crashed');
const addUsage = (a, b) => { const o = Object.assign({}, a); for (const [k, v] of Object.entries(b)) o[k] = (o[k] || 0) + (Number(v) || 0); return o; };

// The group and the start time of a process (ps in the C locale: lstart depends on the locale), or null.
function procOf(pid) {
  const p = spawnSync('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
  const m = p.status === 0 ? /^\s*(\d+)\s+(.+?)\s*$/.exec(String(p.stdout)) : null;
  return m ? { pgid: +m[1], lstart: m[2] } : null;
}

// The process of one call: plan {host, bin, argv, stdin, env, cwd, callDir, home?, auth?, keyFile?}; o {ceilingMs,
// graceMs, onLaunch?}. Resolves {outcome?, error?, output?, rc, signal, pid, usage, costUSD, notes, sessionId, cliVersion,
// credentialExpiresAt}; an outcome is set for everything but a run whose answer settle() still checks. Never rejects.
function spawnRole(plan, o) {
  return new Promise((resolve) => {
    const notes = [DESCENDANTS_NOTE];
    const note = (m) => { if (notes.length < NOTES_MAX) notes.push(m); else if (notes.length === NOTES_MAX) notes.push('later notes dropped'); };
    const st = { turns: 0, usage: null, failed: null, errors: [], result: null, sessionId: null, cliVersion: null, line: 0, limited: null };
    const events = fs.createWriteStream(path.join(plan.callDir, 'events.jsonl'));
    const errlog = fs.createWriteStream(path.join(plan.callDir, 'stderr.log'));
    let child = null, tail = '', why = null, exited = null, graceT = null, finished = false, spawnErr = null, heldOpen = false, notRegistered = null;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* the group is gone */ } };
    const stop = (reason) => {
      if (why || exited) return;
      why = reason;
      kill('SIGTERM');
      graceT = setTimeout(() => kill('SIGKILL'), o.graceMs);
    };
    // The ceiling; after the leader's exit it only bounds a stdout held open by a process outside the group.
    const ceilT = setTimeout(() => { if (exited) { heldOpen = true; finish(); } else stop('ceiling'); }, o.ceilingMs);

    const onEvent = (e) => {
      if (plan.host === 'codex') {
        if (e.type === 'thread.started') st.sessionId = e.thread_id || null;
        else if (e.type === 'turn.completed') {
          st.turns++;
          const u = e.usage || {};
          st.usage = addUsage(st.usage || {}, { input: u.input_tokens, cachedInput: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens });
        } else if (e.type === 'turn.failed') st.failed = e.error || {};
        else if (e.type === 'error') { st.errors.push(String(e.message)); note(`error event: ${String(e.message).slice(0, 300)}`); }
        return;
      }
      if (e.type === 'system' && e.subtype === 'init') {
        st.sessionId = e.session_id || st.sessionId;
        st.cliVersion = e.claude_code_version || null;
        for (const p of e.plugins || []) if (p && p.name === 'codis-agents') note(`init plugin codis-agents: ${p.path} ${p.version || ''}`.trim());
        const off = (e.tools || []).filter((t) => (plan.disallowed || []).includes(t) || /^mcp__/.test(t));
        if (off.length) note(`init.tools has tools a Workflow agent lacks: ${off.join(',')}`);
      } else if (e.type === 'rate_limit_event') {
        const r = e.rate_limit_info || {};
        note(`rate_limit_event ${r.status} (${r.rateLimitType || '?'})`);
        // UC-2 Errors 5: a status other than "allowed", followed by an error, makes the error rate-limited.
        if (r.status !== 'allowed') st.limited = `rate_limit_event ${r.status} (${r.rateLimitType || '?'})`;
      } else if (e.type === 'result') st.result = e;
    };
    const onLine = (l) => {
      st.line++;
      if (!l.trim()) return;
      let e;
      try { e = JSON.parse(l); } catch { note(`line ${st.line} is not JSON: ${l.slice(0, 80)}`); return; }
      if (e && typeof e === 'object') onEvent(e);
    };

    const verdict = () => {
      const r = { pid: (child && child.pid) || null, rc: exited ? exited.rc : null, signal: exited ? exited.sig : null, notes,
        sessionId: st.sessionId, cliVersion: st.cliVersion, usage: null, costUSD: null, credentialExpiresAt: null };
      if (heldOpen) note('stdout stayed open after the exit until the ceiling (held by a process outside the group)');
      if (spawnErr) return Object.assign(r, { outcome: 'crashed', error: `spawn of the gate for ${plan.bin}: ${spawnErr.code || spawnErr.message}` });
      if (notRegistered) return Object.assign(r, { outcome: 'not-registered', error: `the launch could not be registered, the CLI did not start: ${notRegistered}` });
      const stderrTail = tail.trim() ? `; stderr: ${tail.trim().slice(-300)}` : '';
      if (plan.host === 'codex') {
        r.usage = st.usage;
        note(`turn.completed events: ${st.turns}`);
      } else if (st.result) {
        const x = st.result, u = x.usage;
        if (u) r.usage = { input: u.input_tokens || 0, cachedInput: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
          output: u.output_tokens || 0, reasoning: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0 };
        r.costUSD = typeof x.total_cost_usd === 'number' ? x.total_cost_usd : null;
        r.credentialExpiresAt = x.credential_expires_at || null;
        r.sessionId = x.session_id || r.sessionId;
        if (Array.isArray(x.permission_denials) && x.permission_denials.length) note(`permission_denials: ${x.permission_denials.map((p) => p.tool_name).join(',')}`);
        if (x.modelUsage && u) {
          const m = Object.values(x.modelUsage).reduce((a, v) => addUsage(a, { input: v.inputTokens, output: v.outputTokens, cachedInput: v.cacheReadInputTokens, cacheWrite: v.cacheCreationInputTokens }), {});
          const same = ['input', 'output', 'cachedInput', 'cacheWrite'].every((k) => (m[k] || 0) === (r.usage[k] || 0));
          note(same ? `modelUsage matches result.usage (${Object.keys(x.modelUsage).length} model)`
            : `modelUsage differs from result.usage: models ${Object.keys(x.modelUsage).join(',')}, modelUsage ${JSON.stringify(m)}`);
        }
      }
      if (why === 'signalled') return Object.assign(r, { outcome: 'signalled', error: `the adapter got ${stopping}: SIGTERM to the group, SIGKILL after ${o.graceMs} ms` });
      if (why === 'ceiling') return Object.assign(r, { outcome: 'ceiling', error: `the ceiling of ${o.ceilingMs} ms: SIGTERM to the group, SIGKILL after ${o.graceMs} ms` });
      if (r.signal) return Object.assign(r, { outcome: 'killed', error: `killed by ${r.signal}${stderrTail}` });
      const hint = plan.host === 'claude' ? 'log in to claude (claude, then /login)'
        : plan.auth === 'apiKeyFile' ? `check the key file ${plan.keyFile}` : `log in to the run home: CODEX_HOME=${plan.home} codex login`;
      const failed = (outcome, msg) => Object.assign(r, { outcome, error: outcome === 'auth' ? `${hint}: ${msg}` : msg });
      if (plan.host === 'codex') {
        if (st.failed) {
          const msg = typeof st.failed.message === 'string' ? st.failed.message : JSON.stringify(st.failed);
          return failed(byStatus(apiStatus(msg), true), `turn.failed: ${msg}`);
        }
        if (r.rc !== 0) {
          const e = st.errors.slice().reverse().find((m) => apiStatus(m).status !== null);
          if (e) return failed(byStatus(apiStatus(e), true), `exit ${r.rc} after the error event: ${e}`);
          return failed('crashed', `exit ${r.rc} without turn.failed${stderrTail}`);
        }
        if (!st.turns) return failed('no-result', `exit 0 without turn.completed${stderrTail}`);
        try { r.output = fs.readFileSync(path.join(plan.callDir, 'last.json'), 'utf8'); } catch { r.output = undefined; }
        return r;
      }
      const x = st.result;
      const limited = (msg) => failed('rate-limited', `${msg}, after ${st.limited}`);
      if (x) {
        if (x.is_error || x.subtype !== 'success' || x.api_error_status != null) {
          const msg = `result ${x.subtype}, api_error_status ${x.api_error_status}: ${String(x.result || '').slice(0, 300)}`;
          return st.limited ? limited(msg) : failed(byStatus({ status: x.api_error_status }, false), msg);
        }
        if (x.structured_output === undefined || x.structured_output === null) return failed('no-result', 'result success without structured_output');
        r.output = x.structured_output;
        return r;
      }
      if (r.rc !== 0) return st.limited ? limited(`exit ${r.rc} without a result event${stderrTail}`) : failed('crashed', `exit ${r.rc} without a result event${stderrTail}`);
      return failed('no-result', `exit 0 without a result event${stderrTail}`);
    };
    const flush = (w) => new Promise((ok) => w.end(ok));
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(ceilT); clearTimeout(graceT);
      leave(stop);
      if (child) { for (const s of [child.stdout, child.stderr]) if (s) s.destroy(); }
      await Promise.all([flush(events), flush(errlog)]);
      resolve(verdict());
    };

    try {
      child = spawn('/bin/sh', ['-c', GATE, 'gate', plan.bin].concat(plan.argv), { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { spawnErr = e; finish(); return; }
    enter(stop);
    child.on('error', (e) => { if (!child.pid) { spawnErr = e; finish(); } else note(`process error: ${e.message}`); });
    child.stdin.on('error', (e) => note(`stdin: ${e.code || e.message}`));
    if (o.onLaunch && child.pid) {
      try {
        const p = procOf(child.pid);
        if (!p) throw new Error(`ps gives no process group and start time of pid ${child.pid}`);
        o.onLaunch({ label: plan.label, key: plan.key, stepId: plan.stepId, callDir: plan.callDir, host: plan.host, pid: child.pid, pgid: p.pgid, lstart: p.lstart });
      } catch (e) { notRegistered = e.message; }
    }
    // The gate reads the line before the CLI exists; without it stdin ends and the gate exits.
    if (notRegistered) child.stdin.end();
    else child.stdin.end(`go\n${plan.stdin}`);
    const dec = new StringDecoder('utf8');
    let buf = '';
    child.stdout.on('data', (d) => {
      events.write(d);
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stdout.on('end', () => { buf += dec.end(); if (buf) onLine(buf); buf = ''; });
    child.stderr.on('data', (d) => { errlog.write(d); tail = (tail + d.toString('utf8')).slice(-2000); });
    // After the leader's exit its group is killed: no process of the role's group outlives the call (a process the role
    // moved into a session of its own does, see DESCENDANTS_NOTE).
    child.on('exit', (rc, sig) => { exited = { rc, sig }; clearTimeout(graceT); kill('SIGKILL'); });
    child.on('close', (rc, sig) => { if (!exited) exited = { rc, sig }; finish(); });
  });
}

function createAgent(cfg) {
  const c = cfg || {};
  const no = (why) => { throw new Error(`role-exec: refused: ${why}`); };
  if (c.host !== 'codex' && c.host !== 'claude') no(`unknown host ${JSON.stringify(c.host)} (codex or claude)`);
  if (typeof c.callsDir !== 'string' || !c.callsDir) no('callsDir is required (the record of a call whose task is unknown)');
  if (c.launch !== undefined && typeof c.launch !== 'function') no('launch must be a function (without it the adapter runs the host CLI)');
  for (const k of ['beforeLaunch', 'onRecord', 'onLaunch']) if (c[k] !== undefined && typeof c[k] !== 'function') no(`${k} must be a function`);
  if (c.preconditionsByConductor !== undefined && typeof c.preconditionsByConductor !== 'boolean') no('preconditionsByConductor must be a boolean');
  const posMs = (v, d, name) => (v === undefined ? d : Number.isFinite(v) && v > 0 ? v : no(`${name} must be a positive number of ms`));
  const ceilingMs = posMs(c.ceilingMs, CEILING_MS, 'ceilingMs'), graceMs = posMs(c.killGraceMs, KILL_GRACE_MS, 'killGraceMs');
  const launch = c.launch || ((plan) => spawnRole(plan, { ceilingMs, graceMs, onLaunch: c.onLaunch }));
  if (typeof c.pluginRoot !== 'string' || !c.pluginRoot) no('pluginRoot is required');
  const tasks = c.tasks && typeof c.tasks === 'object' ? c.tasks : no('tasks is required');
  for (const [k, t] of Object.entries(tasks)) {
    if (!k || /[:#]/.test(k)) no(`task key ${JSON.stringify(k)}: a key with ":" or "#" makes the label ambiguous`);
    if (!t || typeof t.dir !== 'string' || typeof t.wt !== 'string') no(`task ${k}: wt and dir are required`);
  }
  const log = typeof c.log === 'function' ? c.log : (m) => process.stderr.write(m + '\n');
  const cx = Object.assign({ bin: 'codex', auth: 'chatgpt', effort: DEFAULT_CODEX_EFFORT, models: DEFAULT_CODEX_MODELS }, c.codex || {});
  if (!cx.models) cx.models = DEFAULT_CODEX_MODELS;
  if (!cx.effort) cx.effort = DEFAULT_CODEX_EFFORT;
  // The run home of the chains (owner decision 6, analysis 2.4): never the parent's CODEX_HOME or the personal ~/.codex,
  // also when the catalog comes from cfg.codex.catalog; absolute, since the child runs with cwd = the task dir.
  if (c.host === 'codex' && (typeof cx.home !== 'string' || !path.isAbsolute(cx.home))) {
    no(`codex.home is required and absolute on the host codex (the run home with its own login), got ${JSON.stringify(cx.home)}`);
  }
  if (c.host === 'codex' && isPersonalCodex(cx.home)) no(personalNo(cx.home));
  const cl = Object.assign({ bin: 'claude', permissionMode: 'auto', disallowedTools: CLAUDE_DISALLOWED }, c.claude || {});
  // The commit channel (p-codex A2a-1): prog and test on codex ask the adapter to commit (scripts/commit-req.js); the
  // adapter keeps its answers, journal and private index in commit.stateDir, which no role may write: it may neither lie
  // in nor hold any place a role reaches (roleRoots().reach of every task: the worktree, the task folder, /tmp and the
  // TMPDIR a role gets). The claude host gets the channel in part A2c.
  const roleTmp = (c.env || process.env).TMPDIR;
  const rootsOf = (t) => roleRoots({ wt: t.wt, tdir: t.dir, tmpdir: roleTmp });
  const cm = c.commit === undefined || c.commit === null ? null : c.commit;
  // git of the compare of an answer: commit.git, else the PATH (commit-service refuses a commit.git that is not absolute)
  const gitBin = cm && typeof cm.git === 'string' && path.isAbsolute(cm.git) ? cm.git : 'git';
  if (cm) {
    if (typeof cm !== 'object') no('commit must be an object {stateDir, runId?, git?, gitVersions?, author?, codexVersions?, walkMaxEntries?, walkTimeoutMs?, walkMaxResultBytes?, walkMaxIgnoreBytes?, walkMaxReadBytes?}');
    for (const k of ['walkMaxEntries', 'walkTimeoutMs', 'walkMaxResultBytes', 'walkMaxIgnoreBytes', 'walkMaxReadBytes']) if (cm[k] !== undefined && !(Number.isFinite(cm[k]) && cm[k] > 0)) no(`commit.${k} must be a positive number, got ${JSON.stringify(cm[k])}`);
    if (c.host !== 'codex') no('commit on the claude host: the commit channel of claude -p comes with part A2c');
    if (typeof cm.stateDir !== 'string' || !path.isAbsolute(cm.stateDir)) no(`commit.stateDir is required and absolute, got ${JSON.stringify(cm.stateDir)}`);
    // the run of the conductor, written into every event of the journal (letters, digits, . _ -)
    if (cm.runId !== undefined && (typeof cm.runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(cm.runId))) no(`commit.runId must be a plain name, got ${JSON.stringify(cm.runId)}`);
    const sd = realish(cm.stateDir);
    const roots = [...new Set([].concat(...Object.values(tasks).map((t) => rootsOf(t).reach)))];
    for (const r of roots) {
      if (overlap(sd, r)) no(`commit.stateDir ${cm.stateDir} overlaps ${r}, a folder a role writes: the adapter's answers and journal must be out of the role's reach`);
    }
  }

  // The heavy channel (scripts/heavy-service.js): prog and test on codex with the commit channel ask the
  // adapter to run heavy commands in a memory slot. cfg.heavy {config, kinds?: {<kind>: medium | heavy}} turns it on
  // (config: the run's project config, whose slot directory the holder queues in); its
  // journal lies in commit.stateDir, out of the role's reach like the commit journal.
  const hv = c.heavy === undefined || c.heavy === null ? null : c.heavy;
  if (hv) {
    if (typeof hv !== 'object' || Array.isArray(hv)) no('heavy must be an object {config, kinds?}');
    if (c.host !== 'codex') no('heavy on the claude host: a role of Claude takes its slots with heavy.sh itself');
    if (!cm) no('heavy needs commit: the journal of the heavy channel lies in commit.stateDir');
    const k = hv.kinds === undefined ? {} : hv.kinds;
    if (!k || typeof k !== 'object' || Array.isArray(k) || Object.values(k).some((v) => v !== 'medium' && v !== 'heavy')) no('heavy.kinds must map a kind to "medium" or "heavy"');
    if (typeof hv.config !== 'string' || !path.isAbsolute(hv.config)) no('heavy.config must be the absolute path of the run\'s project config: the slot holder queues by it, not by a lookup from the worktree');
  }

  // {refused} or the plan of the call.
  function prepare(prompt, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const lb = parseLabel(o.label);
    const loose = typeof o.label === 'string' ? /^[^:]*:([^:#]*)/.exec(o.label) : null;
    const base = { label: o.label, key: lb ? lb.key : loose ? loose[1] : null, role: lb ? lb.role : null };
    const refuse = (why) => Object.assign(base, { refused: why });
    if (!lb) return refuse(`label ${JSON.stringify(o.label)} is not "<kind>:<task key>..." with a known kind (${Object.keys(KINDS).join(', ')})`);
    const t = own(tasks, lb.key) ? tasks[lb.key] : null;
    if (!t) return refuse(`unknown task ${lb.key} (label ${o.label})`);
    base.t = t;
    if (typeof prompt !== 'string') return refuse('the prompt is not a string');
    const channel = !!cm && COMMIT_KINDS.has(lb.kind);
    const refusal = CODEX_REFUSED(lb.kind, c.preconditionsByConductor === true);
    if (c.host === 'codex' && refusal) return refuse(refusal);
    // a role on codex commits only through the adapter (its sandbox refuses git commit), so without the channel it
    // could not hand over its work
    if (c.host === 'codex' && COMMIT_KINDS.has(lb.kind) && !cm) return refuse(`the ${lb.role} on codex needs the commit channel (cfg.commit)`);
    if (channel && (typeof t.branch !== 'string' || !t.branch)) return refuse(`task ${lb.key} has no branch: the commit channel needs tasks[k].branch`);
    const at = o.agentType;
    let bodyRole = null;
    if (at !== 'general-purpose') {
      const r = typeof at === 'string' && at.startsWith(AGENT_PREFIX) ? at.slice(AGENT_PREFIX.length) : null;
      if (!r) return refuse(`agentType ${JSON.stringify(at)}: only general-purpose or ${AGENT_PREFIX}<role>`);
      if (r !== lb.role) return refuse(`agentType ${at} does not match the role of label ${o.label} (${lb.role})`);
      bodyRole = r;
    }
    const roleFile = bodyRole && path.join(c.pluginRoot, 'agents', `${bodyRole}.md`);
    if (roleFile && !fs.existsSync(roleFile)) return refuse(`no role file agents/${bodyRole}.md in ${c.pluginRoot}`);
    const probs = schemaProblems(o.schema);
    if (probs.length) return refuse(`schema: ${probs.join('; ')}`);
    const plan = Object.assign(base, { host: c.host, kind: lb.kind, phase: o.phase, schema: o.schema, cwd: t.dir, channel, stepId: o.stepId });
    if (c.host === 'codex') {
      // prog/test: the worktree is the workspace root and the cwd, the task folder the one extra writable root, the
      // network only for test; every other kind keeps -C <task folder> with no extra root and no network key
      let sandbox = ['-s', 'workspace-write', '-C', t.dir];
      if (channel) {
        const r = rootsOf(t);
        plan.cwd = r.cwd;
        sandbox = ['-s', 'workspace-write', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(r.extra)}`,
          '-c', `sandbox_workspace_write.network_access=${lb.kind === 'test'}`, '-C', r.cwd];
      }
      const alias = o.model === undefined ? 'default' : o.model;
      const slug = cx.models && own(cx.models, alias) ? cx.models[alias] : null;
      if (!slug) return refuse(`model ${alias} is not in the codex model table (codex.models: ${Object.keys(cx.models || {}).join(', ')})`);
      const catalog = cx.catalog || (cx.home ? readCatalog(cx.home) : null);
      if (!catalog || !Array.isArray(catalog.models)) return refuse('no codex model catalog: run role-exec.js check --host codex (it caches the catalog in the run home)');
      const entry = catalog.models.find((m) => m && m.slug === slug);
      if (!entry) return refuse(`model ${slug} (${alias}) is not in the codex catalog`);
      const effort = o.effort === undefined ? cx.effort : o.effort;
      if (!levelsOf(entry).includes(effort)) return refuse(`effort ${effort} is not supported by ${slug} (${levelsOf(entry).join(', ')})`);
      let key = null;
      if (cx.auth === 'apiKeyFile') { const k = readKey(cx.keyFile); if (k.error) return refuse(k.error); key = k.key; }
      const body = roleFile ? fs.readFileSync(roleFile, 'utf8').replace(/^---[\s\S]*?\n---\n/, '') : null;
      return Object.assign(plan, {
        model: slug, effort, bin: cx.bin, strictSchema: strict(o.schema), home: cx.home, auth: cx.auth, keyFile: cx.keyFile,
        stdin: (body === null ? prompt : body.trim() + '\n\n' + prompt) + '\n\n' + hostSection(lb.kind, t, { heavy: !!hv && channel }),
        env: codexEnv(c.env || process.env, cx.home, cx.auth, key),
        // project_doc_max_bytes=0: Codex reads no project AGENTS.md at any -C, and the flag beats a trusted
        // .codex/config.toml of the project (measured on codex 0.166.0 and 0.167.0), so a role gets the project rules only from its
        // prompt. The instructions of the run home are not covered by it: check keeps them out of the home.
        argv: (callDir) => ['exec', '--json', '--ephemeral', '--output-schema', path.join(callDir, 'schema.json'), '-o', path.join(callDir, 'last.json'),
          '-m', slug, '-c', `model_reasoning_effort=${effort}`, '-c', 'project_doc_max_bytes=0'].concat(sandbox, ['--skip-git-repo-check', '-']),
      });
    }
    return Object.assign(plan, {
      model: o.model === undefined ? null : o.model, effort: o.effort === undefined ? null : o.effort, bin: cl.bin, stdin: prompt,
      env: Object.assign({}, c.env || process.env), disallowed: cl.disallowedTools,
      argv: () => ['-p', '--output-format', 'stream-json', '--verbose'].concat(bodyRole ? ['--agent', at] : [], ['--json-schema', JSON.stringify(o.schema)],
        o.model === undefined ? [] : ['--model', o.model], o.effort === undefined ? [] : ['--effort', o.effort],
        ['--plugin-dir', c.pluginRoot, '--permission-mode', cl.permissionMode, '--no-session-persistence', '--strict-mcp-config'],
        cl.disallowedTools.length ? ['--disallowedTools', cl.disallowedTools.join(',')] : []),
    });
  }

  // The answer of the launcher -> {outcome, value?, error?}.
  function settle(plan, res) {
    if (!res || typeof res !== 'object') return { outcome: 'crashed', error: 'the launcher returned no result' };
    if (res.outcome && res.outcome !== 'ok') return { outcome: res.outcome, error: res.error || null };
    let v = res.output;
    if (c.host === 'codex') {
      if (typeof v !== 'string' || !v.trim()) return { outcome: 'no-result', error: 'the -o file is missing or empty' };
      try { v = JSON.parse(v); } catch (e) { return { outcome: 'no-result', error: `the -o file is not JSON: ${e.message}` }; }
      v = unstrict(v, plan.schema);
    } else if (v === undefined || v === null) return { outcome: 'no-result', error: 'no structured_output in the result' };
    const errs = validate(v, plan.schema);
    return errs.length ? { outcome: 'invalid-result', error: `the answer does not pass the schema: ${errs.join('; ')}` } : { outcome: 'ok', value: v };
  }

  return async function agent(prompt, opts) {
    const started = new Date();
    const t0 = process.hrtime.bigint();
    let plan, fin, res = null, svc = null, commitSum = null, svcStop = null, heavy = null, heavySum = null, heavyStop = null;
    const callNotes = []; // the adapter's own notes of the call (the compare of the answer)
    try { plan = prepare(prompt, opts); } catch (e) { plan = { label: opts && opts.label, refused: `internal error: ${e.message}` }; }
    if (plan.refused) fin = { outcome: 'refused', error: plan.refused };
    else if (stopping) fin = { outcome: 'signalled', error: `the adapter got ${stopping}: no new call starts` };
    else {
      try {
        // the last level by mkdtemp: two calls never share a folder (two adapters, one label, one second)
        const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const parent = path.join(plan.t.dir, 'calls');
        fs.mkdirSync(parent, { recursive: true });
        plan.callDir = fs.mkdtempSync(path.join(parent, `${String(plan.label).replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}-`));
        fs.writeFileSync(path.join(plan.callDir, 'prompt.txt'), plan.stdin);
        if (plan.strictSchema) fs.writeFileSync(path.join(plan.callDir, 'schema.json'), JSON.stringify(plan.strictSchema, null, 1) + '\n');
        plan.argv = plan.argv(plan.callDir);
        // the npm cache of the call, the folder the checks of its commits use too; an inherited one (any case of the
        // name) never reaches the role
        if (plan.channel) {
          plan.env = Object.assign({}, plan.env);
          for (const k of Object.keys(plan.env)) if (k.toLowerCase() === 'npm_config_cache') delete plan.env[k];
          plan.env.npm_config_cache = path.join(plan.callDir, 'npm-cache');
        }
      } catch (e) { fin = { outcome: 'crashed', error: `the call folder: ${e.message}` }; }
      if (!fin && c.beforeLaunch) {
        try {
          const g = await c.beforeLaunch(plan);
          if (g) fin = { outcome: String(g.outcome || 'crashed'), error: g.error || null };
        } catch (e) { fin = { outcome: 'crashed', error: `beforeLaunch threw: ${e.message}` }; }
      }
      // A signal that came while beforeLaunch ran: no await stands between here and the launch, so this one check keeps
      // the role from starting.
      if (!fin && stopping) fin = { outcome: 'signalled', error: `the adapter got ${stopping}: the role was not started` };
      if (!fin && plan.channel) {
        // the box in the call folder (a new one per call: a request of an earlier call is never read), the answers in
        // the adapter's state folder; the service lives exactly as long as the role's process
        try {
          // the checks of a commit run in codex sandbox with the rights of the role: its write roots, its network (only
          // the tester has one), an npm cache of the call (owner answers 4-6); stopping them is a live stop of the adapter
          svc = openCommitService({ task: plan.key, callId: path.basename(plan.callDir), wt: plan.t.wt, branch: plan.t.branch,
            box: path.join(plan.callDir, 'commit'), stateDir: cm.stateDir, runId: cm.runId, git: cm.git, gitVersions: cm.gitVersions, author: cm.author,
            userEnv: c.env || process.env, inject: cm.inject, log, codex: cx.bin, codexVersions: cm.codexVersions, network: plan.kind === 'test',
            tdir: plan.t.dir, npmCache: path.join(plan.callDir, 'npm-cache'), killGraceMs: graceMs, walkMaxEntries: cm.walkMaxEntries, walkTimeoutMs: cm.walkTimeoutMs,
            walkMaxResultBytes: cm.walkMaxResultBytes, walkMaxIgnoreBytes: cm.walkMaxIgnoreBytes, walkMaxReadBytes: cm.walkMaxReadBytes });
          svcStop = () => svc.cancel();
          enter(svcStop);
          plan.commit = { box: svc.box, answers: svc.answers, client: COMMIT_CLIENT };
          plan.env = Object.assign({}, plan.env, { CODIS_COMMIT_BOX: svc.box, CODIS_COMMIT_ANSWERS: svc.answers });
          // the tip at the start of the call: the service's (its branch) or, when the service refuses every request (a
          // journal held or undetermined, no identity, no branch), the HEAD of the worktree read here before the launch
          if (svc.startTip) { plan.startTip = svc.startTip; plan.startTipBy = 'service'; } else {
            plan.startTip = gitRead(gitBin, c.env || process.env, plan.t.wt, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
            plan.startTipBy = plan.startTip ? 'adapter' : null;
          }
        } catch (e) { fin = { outcome: 'crashed', error: `the commit channel: ${e.message}` }; }
      }
      if (!fin && plan.channel && hv) {
        // the heavy channel lives as long as the role's process; a signal of the adapter stops its runs (TERM, the pause,
        // KILL) and the call waits for them in close()
        try {
          heavy = openHeavyService({ task: plan.key, callId: path.basename(plan.callDir), role: plan.kind, wt: plan.t.wt, tdir: plan.t.dir,
            box: path.join(plan.callDir, 'heavy'), stateDir: cm.stateDir, config: hv.config, runId: cm.runId, kinds: hv.kinds || {}, userEnv: c.env || process.env,
            codex: cx.bin, codexVersions: hv.codexVersions, killGraceMs: graceMs, emptyWaitMs: graceMs, npmCache: path.join(plan.callDir, 'npm-cache'), inject: hv.inject, log });
          heavyStop = () => heavy.cancel('signalled');
          enter(heavyStop);
          plan.env = Object.assign({}, plan.env, { CODIS_HEAVY_BOX: heavy.box, CODIS_HEAVY_ANSWERS: heavy.answers });
        } catch (e) { fin = { outcome: 'crashed', error: `the heavy channel: ${e.message}` }; }
      }
      if (!fin && c.launch && c.onLaunch) {
        try { c.onLaunch({ label: plan.label, key: plan.key, stepId: plan.stepId, callDir: plan.callDir, host: plan.host, pid: null, pgid: null, lstart: null, substitute: true }); } catch (e) {
          fin = { outcome: 'not-registered', error: `the launch could not be registered, the launcher was not run: ${e.message}` };
        }
      }
      if (!fin) {
        try { res = await launch(plan); fin = settle(plan, res); } catch (e) { fin = { outcome: 'crashed', error: `the launcher threw: ${e.message}` }; }
      }
      // the heavy runs of the call end with it (a run still going is stopped: "the call ended")
      if (heavy) { try { heavySum = await heavy.close(); } catch (e) { heavySum = { error: e.message }; } }
      // close() waits for a running check: SIGTERM to its group, SIGKILL after killGraceMs; the signal handlers stay
      // on until then (svcStop is live), so a second signal does not kill the adapter with the check orphaned
      if (svc) {
        try { commitSum = await svc.close(); } catch (e) { commitSum = { error: e.message }; }
        commitSum.startTip = plan.startTip || null;
        commitSum.startTipBy = plan.startTipBy || null;
        if (plan.startTipBy !== 'service') commitSum.endTip = plan.startTipBy === 'adapter' ? gitRead(gitBin, c.env || process.env, plan.t.wt, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']) : null;
        // the answer of a role that ended ok against what the adapter committed (no compare after any other outcome)
        if (fin.outcome === 'ok') {
          if (commitSum.error || !Array.isArray(commitSum.commits)) fin = { outcome: 'invalid-result', error: `the answer cannot be compared: the summary of the commit channel is missing (${commitSum.error || 'no commits'})` };
          else {
            const isAncestor = (a, b) => gitRead(gitBin, c.env || process.env, plan.t.wt, ['merge-base', '--is-ancestor', a, b]) !== null;
            const cmp = compareAnswer(plan.schema, fin.value, commitSum, commitSum.startTip, commitSum.endTip, isAncestor);
            callNotes.push(...cmp.notes);
            if (cmp.problems.length) fin = { outcome: 'invalid-result', error: `the answer does not match the adapter's commits: ${cmp.problems.join('; ')}` };
          }
        }
      }
    }
    const ended = new Date();
    const r = res && typeof res === 'object' ? res : {};
    const rec = {
      ts: ended.toISOString(), host: c.host, cliVersion: r.cliVersion || (c[c.host] && c[c.host].version) || null,
      label: plan.label === undefined ? null : plan.label, task: plan.key || null, role: plan.role || null, phase: (opts && opts.phase) || null,
      model: plan.refused ? null : plan.model, effort: plan.refused ? null : plan.effort,
      startedAt: started.toISOString(), endedAt: ended.toISOString(), seconds: (ended - started) / 1000,
      awakeSeconds: Number(process.hrtime.bigint() - t0) / 1e9, pid: r.pid === undefined ? null : r.pid,
      outcome: fin.outcome, rc: r.rc === undefined ? null : r.rc, signal: r.signal || null,
      error: fin.error ? String(fin.error).slice(0, 500) : null, usage: r.usage || null, costUSD: r.costUSD === undefined ? null : r.costUSD,
      notes: (Array.isArray(r.notes) ? r.notes : []).concat(callNotes), sessionId: r.sessionId || null, credentialExpiresAt: r.credentialExpiresAt || null,
      callDir: plan.callDir || null,
    };
    if (opts && opts.stepId) rec.stepId = opts.stepId;
    if (commitSum) rec.commit = Object.assign({ box: svc.box, answers: svc.answers }, commitSum);
    if (heavySum) rec.heavy = Object.assign({ box: heavy.box, answers: heavy.answers }, heavySum);
    if (c.onRecord) { try { c.onRecord(rec); } catch (e) { log(`role-exec: ${rec.label}: onRecord threw: ${e.message}`); } }
    try {
      const dir = plan.t ? plan.t.dir : c.callsDir;
      fs.mkdirSync(dir, { recursive: true });
      appendRecord(path.join(fs.realpathSync(dir), 'calls.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { log(`role-exec: ${rec.label}: the record of the call could not be written: ${e.message}`); }
    if (fin.outcome !== 'ok') log(`role-exec: ${rec.label} ${fin.outcome}: ${rec.error || ''}`);
    if (svcStop) leave(svcStop); // after the record: a signal that came meanwhile ends the adapter only now
    if (heavyStop) leave(heavyStop);
    return fin.outcome === 'ok' ? fin.value : null;
  };
}

// The record of a call goes to <task dir>/calls.jsonl, a folder the role writes (owner 2026-11-06, answer to G2: the
// role's folder is an untrusted source). The adapter runs outside the sandbox, so it never writes through what the role
// left there. The folder's own path is resolved first (it is the adapter's; the role writes only inside it), then the
// open follows no symbolic link (macOS O_NOFOLLOW_ANY, elsewhere O_NOFOLLOW; a dangling link is not created either),
// never blocks (O_NONBLOCK: a FIFO without a reader fails with ENXIO), and fstat must show a regular file with one link
// (a FIFO with a reader, a device or a hard link to a file outside the roots is refused). A refused record is lost and
// the reason goes to log().
const RECORD_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NONBLOCK
  | (process.platform === 'darwin' ? 0x20000000 : fs.constants.O_NOFOLLOW); // macOS refuses both together (EINVAL)
function appendRecord(file, line) {
  const fd = fs.openSync(file, RECORD_FLAGS, 0o644);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.nlink !== 1) throw new Error(`${file} has ${st.nlink} links`);
    fs.writeSync(fd, line);
  } finally { fs.closeSync(fd); }
}

// ---- check (A1-29): the host CLI is ready, without a model
const which = (bin) => {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
};
const run = (bin, args, env) => spawnSync(bin, args, { encoding: 'utf8', env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
const versionOf = (p) => { const m = /(\d+\.\d+\.\d+)/.exec(`${p.stdout || ''}`); return m ? m[1] : null; };
// A Node wrapper (codex.js of the npm package) keeps the group of the native process only when its Node has
// process.execve; without it a SIGKILL to the group kills the wrapper alone.
function binKind(file, env, problems) {
  let head = '';
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(256); const n = fs.readSync(fd, b, 0, 256, 0); fs.closeSync(fd); head = b.slice(0, n).toString('utf8'); } catch { /* unreadable */ }
  const line = head.startsWith('#!') ? head.slice(2).split('\n')[0].trim() : '';
  if (!/(^|[\s/])node(\s|$)/.test(line)) return 'executable';
  const [interp, ...rest] = line.split(/\s+/);
  const p = spawnSync(interp, rest.concat(['-e', 'process.exit(typeof process.execve === "function" ? 0 : 1)']), { env, timeout: 30000 });
  if (p.status !== 0) problems.push(`${file} is a Node wrapper whose Node has no process.execve: a SIGKILL to the group would kill only the wrapper - name the native binary in codex.bin`);
  return 'node-wrapper';
}

// The instruction channels of a run home that reach the model even with project_doc_max_bytes=0 (measured on codex
// 0.166.0 and 0.167.0): AGENTS.md and AGENTS.override.md of the home, an empty one too, and the skills in skills/. A person puts
// them there; Codex itself puts only skills/.system with its marker file. Every other entry is the state of Codex and
// of the prepared home and is neither listed nor read: the home grows with use, so a list of allowed entries would turn
// red after the first session. Instruction keys of config.toml, installed plugins and memories are not looked at
// (README, Known gaps). One lstat per name: a file, a link or a folder of that name counts alike.
const HOME_RULE_FILES = ['AGENTS.md', 'AGENTS.override.md'];
const SYSTEM_SKILLS = '.system';
const SYSTEM_SKILLS_MARKER = '.codex-system-skills.marker';
function homeChannels(home) {
  const found = [];
  const lst = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  try {
    for (const name of HOME_RULE_FILES) {
      if (lst(path.join(home, name))) found.push(`the run home ${home} has ${name}: Codex gives it to every role ahead of the prompt; remove it`);
    }
    const dir = path.join(home, 'skills');
    const st = lst(dir);
    if (st && !st.isDirectory()) found.push(`the run home ${home} has skills that is not a folder: Codex reads the skills of its home for every role; remove it`);
    else if (st) {
      for (const e of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, e);
        if (e === SYSTEM_SKILLS) {
          const s = lst(p), m = s && s.isDirectory() ? lst(path.join(p, SYSTEM_SKILLS_MARKER)) : null;
          if (!m || !m.isFile()) found.push(`the run home ${home} has skills/${SYSTEM_SKILLS} without ${SYSTEM_SKILLS_MARKER}: not the system skills Codex installs; remove it`);
        } else found.push(`the run home ${home} has skills/${e}: Codex gives the skills of its home to every role; remove it`);
      }
    }
  } catch (e) { found.push(`the run home ${home} cannot be read for its instruction files: ${e.message}`); }
  return found;
}

function check(a) {
  const problems = [];
  const out = { ok: false, host: a.host, version: null, problems };
  if (a.host === 'codex') {
    const bin = which(a.bin || 'codex');
    if (!bin) { problems.push(`codex binary not found: ${a.bin || 'codex'}`); return out; }
    out.bin = bin;
    const home = a.home || process.env.CODEX_HOME;
    if (!home) { problems.push('no run home: --home <dir> (CODEX_HOME of the chain)'); return out; }
    if (isPersonalCodex(home)) { problems.push(personalNo(home)); return out; }
    try { fs.accessSync(home, fs.constants.W_OK); } catch { problems.push(`the run home ${home} is not writable (every codex command writes into it)`); return out; }
    problems.push(...homeChannels(home));
    const auth = a.auth || 'chatgpt';
    let key = null;
    if (auth === 'apiKeyFile') { const k = readKey(a.keyFile); if (k.error) problems.push(k.error); else key = k.key; }
    else if (auth !== 'chatgpt') { problems.push(`unknown auth ${auth} (chatgpt or apiKeyFile)`); return out; }
    const env = codexEnv(process.env, home, auth, key);
    out.binKind = binKind(bin, env, problems);
    const versions = a.versions ? a.versions.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CODEX_VERSIONS;
    const pv = run(bin, ['--version'], env);
    out.version = versionOf(pv);
    if (pv.status !== 0 || !out.version) problems.push(`codex --version failed (rc ${pv.status})`);
    else if (!versions.includes(out.version)) problems.push(`codex version ${out.version} is not in the allowed list (${versions.join(', ')})`);
    if (auth === 'chatgpt') {
      const pl = run(bin, ['login', 'status'], env);
      if (pl.status !== 0) problems.push(`not logged in to the run home (login status rc ${pl.status}): CODEX_HOME=${home} codex login`);
    }
    const pm = run(bin, ['debug', 'models'], env);
    let catalog = null;
    try { catalog = JSON.parse(pm.stdout); } catch { /* below */ }
    if (pm.status !== 0 || !catalog || !Array.isArray(catalog.models)) problems.push(`codex debug models gave no catalog (rc ${pm.status})`);
    else {
      const slim = { models: catalog.models.map((m) => ({ slug: m.slug, default_reasoning_level: m.default_reasoning_level, supported_reasoning_levels: levelsOf(m) })) };
      fs.writeFileSync(path.join(home, CATALOG_FILE), JSON.stringify(slim, null, 1) + '\n');
      const effort = a.effort || DEFAULT_CODEX_EFFORT;
      const slugs = a.model ? [a.model] : [...new Set(Object.values(DEFAULT_CODEX_MODELS))];
      for (const s of slugs) {
        const e = slim.models.find((m) => m.slug === s);
        if (!e) problems.push(`model ${s} is not in the codex catalog (codex debug models)`);
        else if (!e.supported_reasoning_levels.includes(effort)) problems.push(`effort ${effort} is not supported by ${s} (${e.supported_reasoning_levels.join(', ')})`);
      }
    }
  } else {
    const bin = which(a.bin || 'claude');
    if (!bin) { problems.push(`claude binary not found: ${a.bin || 'claude'}`); return out; }
    out.bin = bin;
    const pv = run(bin, ['--version'], process.env);
    out.version = versionOf(pv);
    if (pv.status !== 0 || !out.version) problems.push(`claude --version failed (rc ${pv.status})`);
    const root = a.pluginRoot || path.join(__dirname, '..');
    for (const r of ROLE_FILES) if (!fs.existsSync(path.join(root, 'agents', `${r}.md`))) problems.push(`agents/${r}.md is missing in ${root} (--agent ${AGENT_PREFIX}${r})`);
  }
  out.ok = !problems.length;
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const FLAGS = { '--host': 'host', '--bin': 'bin', '--home': 'home', '--auth': 'auth', '--key-file': 'keyFile', '--model': 'model',
    '--effort': 'effort', '--versions': 'versions', '--plugin-root': 'pluginRoot' };
  const a = {};
  let bad = argv[0] !== 'check' ? `unknown command ${JSON.stringify(argv[0])}` : '';
  for (let i = 1; i < argv.length && !bad; i++) {
    if (!own(FLAGS, argv[i]) || argv[i + 1] === undefined) bad = `unknown or empty flag ${argv[i]}`;
    else a[FLAGS[argv[i]]] = argv[++i];
  }
  if (!bad && a.host !== 'codex' && a.host !== 'claude') bad = `--host codex|claude, got ${JSON.stringify(a.host)}`;
  if (bad) { process.stderr.write(`role-exec: ${bad}\nusage: role-exec.js check --host codex|claude [flags]\n`); process.exit(2); }
  const r = check(a);
  process.stdout.write(JSON.stringify(r, null, 1) + '\n');
  process.exit(r.ok ? 0 : 1);
}

module.exports = { realish, inside, overlap, procOf, createAgent, hostSection, spawnRole, stopAll: gotSignal, CODEX_REFUSED, CEILING_MS, KILL_GRACE_MS, CLAUDE_DISALLOWED, strict, unstrict, validate, schemaProblems, parseLabel, check, KINDS, KEYWORDS, DEFAULT_CODEX_MODELS, DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_VERSIONS, CATALOG_FILE };
