#!/usr/bin/env node
'use strict';
// The role adapter (p-codex-A): runs a role of workflows/role-chain.js on a host CLI - codex (Codex CLI) or claude
// (Claude Code) - with the same contract as the Workflow global agent(): agent(prompt, {schema, model?, effort?, label,
// phase?, agentType}) -> the object of the schema, or null (never an exception). role-chain.js does not change.
//
// This file holds part A1a: the contract and the data. createAgent(cfg) checks the config; each call is prepared here
// (the task from the label, the role from the kind of the label, the body of the role, model and effort, the strict
// schema, the argv of the host), its prompt is saved, the prepared plan is handed to cfg.launch(plan), and the answer is
// checked against the original schema. The process of the role (spawn, the event stream, outcomes, the ceiling) is part
// A1b: until then the caller passes launch. One line of <task dir>/calls.jsonl per call, whatever its outcome.
//
// usage: node role-exec.js check --host codex [--bin <codex>] --home <run home> [--auth chatgpt|apiKeyFile]
//          [--key-file <file>] [--model <slug>] [--effort <level>] [--versions <a,b>]
//        node role-exec.js check --host claude [--bin <claude>] [--plugin-root <dir>]
// check calls no model: it prints JSON {ok, host, version, binKind?, problems} and exits 0 (ok), 1 (problems), 2 (usage).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
const ROLE_FILES = ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer'];
// The role is the kind of the label (role-chain.js labels are "<kind>:<task key>..."), not the agentType: agentType only
// picks the body (with agentTypePrefix "" every role is general-purpose).
const KINDS = {
  pre: 'preconditions', analyst: 'analyst', usecases: 'analyst', prog: 'programmer', test: 'tester', review: 'reviewer',
  sec: 'security-reviewer', sha: 'service', diff: 'service', left: 'service', post: 'service', run: 'service', merge: 'service',
};
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
  env.CODEX_HOME = home;
  if (auth === 'apiKeyFile' && key) env.CODEX_API_KEY = key;
  return env;
}

function createAgent(cfg) {
  const c = cfg || {};
  const no = (why) => { throw new Error(`role-exec: refused: ${why}`); };
  if (c.host !== 'codex' && c.host !== 'claude') no(`unknown host ${JSON.stringify(c.host)} (codex or claude)`);
  if (typeof c.callsDir !== 'string' || !c.callsDir) no('callsDir is required (the record of a call whose task is unknown)');
  if (typeof c.launch !== 'function') no('launch is required: the process of a role is part A1b');
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
  const cl = Object.assign({ bin: 'claude', permissionMode: 'auto' }, c.claude || {});
  let seq = 0;

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
    if (c.host === 'codex' && CODEX_REFUSED(lb.kind)) return refuse(CODEX_REFUSED(lb.kind));
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
    const plan = Object.assign(base, { host: c.host, kind: lb.kind, phase: o.phase, schema: o.schema, cwd: t.dir });
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
        model: slug, effort, bin: cx.bin, strictSchema: strict(o.schema),
        stdin: body === null ? prompt : body.trim() + '\n\n' + prompt,
        env: codexEnv(c.env || process.env, cx.home, cx.auth, key),
        argv: (callDir) => ['exec', '--json', '--ephemeral', '--output-schema', path.join(callDir, 'schema.json'), '-o', path.join(callDir, 'last.json'),
          '-m', slug, '-c', `model_reasoning_effort=${effort}`, '-s', 'workspace-write', '-C', t.dir, '--skip-git-repo-check', '-'],
      });
    }
    return Object.assign(plan, {
      model: o.model === undefined ? null : o.model, effort: o.effort === undefined ? null : o.effort, bin: cl.bin, stdin: prompt,
      env: Object.assign({}, c.env || process.env),
      argv: () => ['-p', '--output-format', 'stream-json', '--verbose'].concat(bodyRole ? ['--agent', at] : [], ['--json-schema', JSON.stringify(o.schema)],
        o.model === undefined ? [] : ['--model', o.model], o.effort === undefined ? [] : ['--effort', o.effort],
        ['--plugin-dir', c.pluginRoot, '--permission-mode', cl.permissionMode, '--no-session-persistence']),
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
    let plan, fin, res = null;
    try { plan = prepare(prompt, opts); } catch (e) { plan = { label: opts && opts.label, refused: `internal error: ${e.message}` }; }
    if (plan.refused) fin = { outcome: 'refused', error: plan.refused };
    else {
      try {
        const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        plan.callDir = path.join(plan.t.dir, 'calls', `${String(plan.label).replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}-${process.pid}-${++seq}`);
        fs.mkdirSync(plan.callDir, { recursive: true });
        fs.writeFileSync(path.join(plan.callDir, 'prompt.txt'), plan.stdin);
        if (plan.strictSchema) fs.writeFileSync(path.join(plan.callDir, 'schema.json'), JSON.stringify(plan.strictSchema, null, 1) + '\n');
        plan.argv = plan.argv(plan.callDir);
      } catch (e) { fin = { outcome: 'crashed', error: `the call folder: ${e.message}` }; }
      if (!fin) {
        try { res = await c.launch(plan); fin = settle(plan, res); } catch (e) { fin = { outcome: 'crashed', error: `the launcher threw: ${e.message}` }; }
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
      notes: Array.isArray(r.notes) ? r.notes : [], sessionId: r.sessionId || null, credentialExpiresAt: r.credentialExpiresAt || null,
      callDir: plan.callDir || null,
    };
    try {
      const dir = plan.t ? plan.t.dir : c.callsDir;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { log(`role-exec: ${rec.label}: the record of the call could not be written: ${e.message}`); }
    if (fin.outcome !== 'ok') log(`role-exec: ${rec.label} ${fin.outcome}: ${rec.error || ''}`);
    return fin.outcome === 'ok' ? fin.value : null;
  };
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

function check(a) {
  const problems = [];
  const out = { ok: false, host: a.host, version: null, problems };
  if (a.host === 'codex') {
    const bin = which(a.bin || 'codex');
    if (!bin) { problems.push(`codex binary not found: ${a.bin || 'codex'}`); return out; }
    out.bin = bin;
    const home = a.home || process.env.CODEX_HOME;
    if (!home) { problems.push('no run home: --home <dir> (CODEX_HOME of the chain)'); return out; }
    try { fs.accessSync(home, fs.constants.W_OK); } catch { problems.push(`the run home ${home} is not writable (every codex command writes into it)`); return out; }
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

module.exports = { createAgent, strict, unstrict, validate, schemaProblems, parseLabel, check, KINDS, KEYWORDS, DEFAULT_CODEX_MODELS, CATALOG_FILE };
