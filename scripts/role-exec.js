#!/usr/bin/env node
'use strict';
// The role adapter (p-codex-A): runs a role of workflows/role-chain.js on a host CLI - codex (Codex CLI) or claude
// (Claude Code) - with the same contract as the Workflow global agent(): agent(prompt, {schema, model?, effort?, label,
// phase?, agentType}) -> the object of the schema, or null (never an exception). role-chain.js does not change.
//
// createAgent(cfg) checks the config; each call is prepared here (the task from the label, the role from the kind of the
// label, the body of the role, model and effort, the strict schema, the argv of the host), its prompt is saved in a call
// folder of its own, the plan is run by the launcher, and the answer is checked against the original schema. The
// launcher is the real process of the host CLI (spawnRole: no shell, its own process group, the prompt on stdin, the
// JSONL stream parsed line by line, the outcome by the fields of the terminal event, the exit code and the signal, the
// ceiling of 3 h on the monotonic clock, SIGTERM/SIGINT/SIGHUP of the adapter passed to every live group); cfg.launch
// replaces it (tests, chain-cost). One line of <task dir>/calls.jsonl per call, whatever its outcome (never written through a
// link, FIFO or hard link the role left in place of the file: appendRecord).
// With cfg.commit a prog or test call on codex gets the commit channel (scripts/commit-service.js): a box in its call
// folder, the answers in commit.stateDir, CODIS_COMMIT_BOX and CODIS_COMMIT_ANSWERS in its environment, the service
// open while the launcher runs and until a check it runs is stopped (its hooks run in codex sandbox with the rights of
// the role); the record carries its summary.
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
const { openCommitService } = require('./commit-service');

// The JSON Schema keywords the twelve schemas of role-chain.js use. Strict mode of the OpenAI API supports a subset of
// JSON Schema; only these words are converted, and any other one is refused before a call, never guessed (A1-04).
const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description']);
// The model table of codex: the Claude alias of the role (role-chain.js modelOf) -> the codex model; "default" for a call
// without a model. Owner 2026-11-05 (question 8): every role on codex runs gpt-6-astra with effort high.
const DEFAULT_CODEX_MODELS = Object.freeze({ opus: 'gpt-6-astra', default: 'gpt-6-astra' });
const DEFAULT_CODEX_EFFORT = 'high';
const DEFAULT_CODEX_VERSIONS = ['0.166.0'];
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
// Refusals of the codex host by the kind of the label; the claude host runs every kind.
const CODEX_REFUSED = (kind) => (KINDS[kind] === 'service'
  ? `service step "${kind}" on codex: the conductor runs it as a child process (part B)`
  : kind === 'pre' ? 'the preconditions run on the coordinator\'s host, outside the codex sandbox (slots and swap need ps and sysctl; the conductor in part B)'
    : kind === 'prog' || kind === 'test' ? `the ${KINDS[kind]} on codex waits for part A2 (the sandbox for code writes and the wait for heavy commands)` : '');

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
  delete env.CODIS_COMMIT_BOX; delete env.CODIS_COMMIT_ANSWERS;
  env.CODEX_HOME = home;
  if (auth === 'apiKeyFile' && key) env.CODEX_API_KEY = key;
  return env;
}

// The personal ~/.codex of the user is never the run home of the chains (owner decision 6: a separate home with its own
// login); compared by realpath, so a link to it is the same home.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// realpath of the longest existing prefix plus the rest: a folder that does not exist yet compares like the real one
const realish = (p) => {
  const abs = path.resolve(p);
  let head = abs, rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync(head), rest); } catch { /* go up */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    rest = path.join(path.basename(head), rest);
    head = up;
  }
};
const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
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
function gotSignal(sig) {
  if (!stopping) stopping = sig;
  for (const stop of LIVE) stop('signalled');
  if (!LIVE.size) finishStop();
}
// The handlers are on while a role process lives; after a signal, when the last one is gone, they are removed and
// process.exitCode is 128+n: the host exits by itself, and no new call starts.
function enter(stop) {
  LIVE.add(stop);
  if (!stopping) for (const s of SIGNALS) if (!handlers[s]) { handlers[s] = () => gotSignal(s); process.on(s, handlers[s]); }
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

// The process of one call: plan {host, bin, argv, stdin, env, cwd, callDir, home?, auth?, keyFile?}; o {ceilingMs,
// graceMs}. Resolves {outcome?, error?, output?, rc, signal, pid, usage, costUSD, notes, sessionId, cliVersion,
// credentialExpiresAt}; an outcome is set for everything but a run whose answer settle() still checks. Never rejects.
function spawnRole(plan, o) {
  return new Promise((resolve) => {
    const notes = [DESCENDANTS_NOTE];
    const note = (m) => { if (notes.length < NOTES_MAX) notes.push(m); else if (notes.length === NOTES_MAX) notes.push('later notes dropped'); };
    const st = { turns: 0, usage: null, failed: null, errors: [], result: null, sessionId: null, cliVersion: null, line: 0, limited: null };
    const events = fs.createWriteStream(path.join(plan.callDir, 'events.jsonl'));
    const errlog = fs.createWriteStream(path.join(plan.callDir, 'stderr.log'));
    let child = null, tail = '', why = null, exited = null, graceT = null, finished = false, spawnErr = null, heldOpen = false;
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
      if (spawnErr) return Object.assign(r, { outcome: 'crashed', error: `spawn ${plan.bin}: ${spawnErr.code || spawnErr.message}` });
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
      child = spawn(plan.bin, plan.argv, { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { spawnErr = e; finish(); return; }
    enter(stop);
    child.on('error', (e) => { if (!child.pid) { spawnErr = e; finish(); } else note(`process error: ${e.message}`); });
    child.stdin.on('error', (e) => note(`stdin: ${e.code || e.message}`));
    child.stdin.end(plan.stdin);
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
  const posMs = (v, d, name) => (v === undefined ? d : Number.isFinite(v) && v > 0 ? v : no(`${name} must be a positive number of ms`));
  const ceilingMs = posMs(c.ceilingMs, CEILING_MS, 'ceilingMs'), graceMs = posMs(c.killGraceMs, KILL_GRACE_MS, 'killGraceMs');
  const launch = c.launch || ((plan) => spawnRole(plan, { ceilingMs, graceMs }));
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
  // adapter keeps its answers, journal and private index in commit.stateDir, which no role may write: not under a task
  // folder or worktree (or holding one), not under /tmp or the TMPDIR a role gets (the codex sandbox lets a role write
  // both). The claude host gets the channel in part A2c.
  const cm = c.commit === undefined || c.commit === null ? null : c.commit;
  if (cm) {
    if (typeof cm !== 'object') no('commit must be an object {stateDir, git?, gitVersions?, author?, codexVersions?, walkMaxEntries?, walkTimeoutMs?, walkMaxResultBytes?, walkMaxIgnoreBytes?, walkMaxReadBytes?}');
    for (const k of ['walkMaxEntries', 'walkTimeoutMs', 'walkMaxResultBytes', 'walkMaxIgnoreBytes', 'walkMaxReadBytes']) if (cm[k] !== undefined && !(Number.isFinite(cm[k]) && cm[k] > 0)) no(`commit.${k} must be a positive number, got ${JSON.stringify(cm[k])}`);
    if (c.host !== 'codex') no('commit on the claude host: the commit channel of claude -p comes with part A2c');
    if (typeof cm.stateDir !== 'string' || !path.isAbsolute(cm.stateDir)) no(`commit.stateDir is required and absolute, got ${JSON.stringify(cm.stateDir)}`);
    const sd = realish(cm.stateDir);
    const roleTmp = (c.env || process.env).TMPDIR;
    const roots = [].concat(...Object.values(tasks).map((t) => [t.dir, t.wt]), ['/tmp'], roleTmp ? [roleTmp] : []).map(realish);
    for (const r of roots) {
      if (inside(sd, r) || inside(r, sd)) no(`commit.stateDir ${cm.stateDir} overlaps ${r}, a folder a role writes: the adapter's answers and journal must be out of the role's reach`);
    }
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
    // prog and test on the real codex CLI wait for the sandbox profile of code writes (part A2a-3); a launcher of the
    // caller with the commit channel runs them (the acceptance of the channel under codex sandbox)
    if (c.host === 'codex' && CODEX_REFUSED(lb.kind) && !(channel && c.launch)) return refuse(CODEX_REFUSED(lb.kind));
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
    const plan = Object.assign(base, { host: c.host, kind: lb.kind, phase: o.phase, schema: o.schema, cwd: t.dir, channel });
    if (c.host === 'codex') {
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
        stdin: body === null ? prompt : body.trim() + '\n\n' + prompt,
        env: codexEnv(c.env || process.env, cx.home, cx.auth, key),
        // project_doc_max_bytes=0: Codex reads no project AGENTS.md at any -C, and the flag beats a trusted
        // .codex/config.toml of the project (measured on codex 0.166.0), so a role gets the project rules only from its
        // prompt. The instructions of the run home are not covered by it: check keeps them out of the home.
        argv: (callDir) => ['exec', '--json', '--ephemeral', '--output-schema', path.join(callDir, 'schema.json'), '-o', path.join(callDir, 'last.json'),
          '-m', slug, '-c', `model_reasoning_effort=${effort}`, '-c', 'project_doc_max_bytes=0', '-s', 'workspace-write', '-C', t.dir, '--skip-git-repo-check', '-'],
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
    let plan, fin, res = null, svc = null, commitSum = null, svcStop = null;
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
      } catch (e) { fin = { outcome: 'crashed', error: `the call folder: ${e.message}` }; }
      if (!fin && plan.channel) {
        // the box in the call folder (a new one per call: a request of an earlier call is never read), the answers in
        // the adapter's state folder; the service lives exactly as long as the role's process
        try {
          // the checks of a commit run in codex sandbox with the rights of the role: its write roots, its network (only
          // the tester has one), an npm cache of the call (owner answers 4-6); stopping them is a live stop of the adapter
          svc = openCommitService({ task: plan.key, callId: path.basename(plan.callDir), wt: plan.t.wt, branch: plan.t.branch,
            box: path.join(plan.callDir, 'commit'), stateDir: cm.stateDir, git: cm.git, gitVersions: cm.gitVersions, author: cm.author,
            userEnv: c.env || process.env, inject: cm.inject, log, codex: cx.bin, codexVersions: cm.codexVersions, network: plan.kind === 'test',
            tdir: plan.t.dir, npmCache: path.join(plan.callDir, 'npm-cache'), killGraceMs: graceMs, walkMaxEntries: cm.walkMaxEntries, walkTimeoutMs: cm.walkTimeoutMs,
            walkMaxResultBytes: cm.walkMaxResultBytes, walkMaxIgnoreBytes: cm.walkMaxIgnoreBytes, walkMaxReadBytes: cm.walkMaxReadBytes });
          svcStop = () => svc.cancel();
          enter(svcStop);
          plan.commit = { box: svc.box, answers: svc.answers, client: COMMIT_CLIENT };
          plan.env = Object.assign({}, plan.env, { CODIS_COMMIT_BOX: svc.box, CODIS_COMMIT_ANSWERS: svc.answers });
        } catch (e) { fin = { outcome: 'crashed', error: `the commit channel: ${e.message}` }; }
      }
      if (!fin) {
        try { res = await launch(plan); fin = settle(plan, res); } catch (e) { fin = { outcome: 'crashed', error: `the launcher threw: ${e.message}` }; }
      }
      // close() waits for a running check: SIGTERM to its group, SIGKILL after killGraceMs; the signal handlers stay
      // on until then (svcStop is live), so a second signal does not kill the adapter with the check orphaned
      if (svc) { try { commitSum = await svc.close(); } catch (e) { commitSum = { error: e.message }; } }
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
      notes: Array.isArray(r.notes) ? r.notes : [], sessionId: r.sessionId || null, credentialExpiresAt: r.credentialExpiresAt || null,
      callDir: plan.callDir || null,
    };
    if (commitSum) rec.commit = Object.assign({ box: svc.box, answers: svc.answers }, commitSum);
    try {
      const dir = plan.t ? plan.t.dir : c.callsDir;
      fs.mkdirSync(dir, { recursive: true });
      appendRecord(path.join(fs.realpathSync(dir), 'calls.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { log(`role-exec: ${rec.label}: the record of the call could not be written: ${e.message}`); }
    if (fin.outcome !== 'ok') log(`role-exec: ${rec.label} ${fin.outcome}: ${rec.error || ''}`);
    if (svcStop) leave(svcStop); // after the record: a signal that came meanwhile ends the adapter only now
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
// 0.166.0): AGENTS.md and AGENTS.override.md of the home, an empty one too, and the skills in skills/. A person puts
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

module.exports = { createAgent, spawnRole, CEILING_MS, KILL_GRACE_MS, CLAUDE_DISALLOWED, strict, unstrict, validate, schemaProblems, parseLabel, check, KINDS, KEYWORDS, DEFAULT_CODEX_MODELS, CATALOG_FILE };
