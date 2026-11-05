#!/usr/bin/env node
'use strict';
// Tester's guard of scripts/role-exec.js, part A1a (p-codex-A1a): the cells the programmer's guard
// (tests/role-exec.test.js) leaves to synthetic data or to its own tables.
// T1  the real answers of the API from the live check G6 (codex exec, gpt-6-astra, the strict forms of the twelve
//     schemas; tests/fixtures/role-exec/g6-answers) go through unstrict() and pass the original schema of the source;
//     RUN.rc: null stays; through agent() on codex they come back ok in the original shape.
// T2  the real call sites of workflows/role-chain.js: the kind of each label literal with its own agentType, effort and
//     schema (both agentTypePrefix "codis-agents:" and ""): on claude none is refused, on codex only analyst, usecases,
//     review and sec run; the role of agentType equals the role of the kind at every site.
// T3  strict() shares no object or array with its input at any depth (a change of the strict form never reaches the
//     shared schemas of role-chain.js).
// T4  the codex prompt byte for byte: only the body is trimmed, the prompt keeps its edges, CRLF, backticks, $, quotes
//     and non-ASCII; a "---" line inside the body stays; prompt.txt holds the same bytes.
// T5  the apiKeyFile mode in agent(): the key only in the child's CODEX_API_KEY, never in argv, the record, the call
//     folder or the log; chatgpt mode drops the parent's key variables; a key file wider than 600 is refused.
// T6  the run home on codex (review 1, owner decision 6): the parent's CODEX_HOME from process.env (no cfg.env) never
//     reaches the child and its cached catalog is never read; "~/.codex" (not absolute, not expanded) and the
//     apiKeyFile mode without codex.home are refused by createAgent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');
const RX = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const { createAgent, strict, unstrict, validate, KINDS } = RX;
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');

// ---- the twelve schemas out of the source, in order, in a vm (POST refers to DIFF and LEFT)
const S = (() => {
  const ctx = {}; vm.createContext(ctx);
  const re = /const ([A-Z_]+_SCHEMA) = \{/g; let m; const names = [];
  while ((m = re.exec(SRC))) {
    let i = m.index + m[0].length - 1, d = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
    vm.runInContext(SRC.slice(m.index, i + 1).replace(/^const /, 'var ') + ';', ctx);
    names.push(m[1]);
  }
  const out = {};
  for (const n of names) out[n] = JSON.parse(JSON.stringify(ctx[n]));
  out.POST_SCHEMA.properties.diff = out.DIFF_SCHEMA; out.POST_SCHEMA.properties.left = out.LEFT_SCHEMA;
  return out;
})();
const NAMES = Object.keys(S);
ok('the twelve schemas are cut out of role-chain.js', NAMES.length === 12, NAMES.join(','));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
Object.values(S).forEach(deepFreeze);

// ---- T1: real answers of the API (G6)
const G6 = {};
for (const n of NAMES) G6[n] = fs.readFileSync(path.join(FIX, 'g6-answers', `${n}.json`), 'utf8');
const U = {};
for (const n of NAMES) U[n] = unstrict(deepFreeze(JSON.parse(G6[n])), S[n]);
const badU = NAMES.filter((n) => validate(U[n], S[n]).length);
ok('T1 every real G6 answer passes the original schema after unstrict (all twelve)', !badU.length, badU.map((n) => `${n}: ${validate(U[n], S[n]).join('; ')}`).join(' | '));
const leftNull = (v, s) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).some(([k, x]) => {
  const p = s.properties && s.properties[k];
  return (x === null && p && !(s.required || []).includes(k) && ![].concat(p.type).includes('null')) || (p && leftNull(x, p));
});
ok('T1 no optional null is left in any real answer after unstrict', NAMES.every((n) => !leftNull(U[n], S[n])), NAMES.filter((n) => leftNull(U[n], S[n])).join(','));
ok("T1 real RUN answer: rc null stays (required, nullable), seconds/tail/alive/pid/error removed",
  'rc' in U.RUN_SCHEMA && U.RUN_SCHEMA.rc === null && ['seconds', 'tail', 'alive', 'pid', 'error'].every((k) => !(k in U.RUN_SCHEMA)), JSON.stringify(U.RUN_SCHEMA));
ok('T1 real POST answer: ok, error, diff.error, left.error removed, nested levels kept',
  !('ok' in U.POST_SCHEMA) && !('error' in U.POST_SCHEMA) && U.POST_SCHEMA.diff && !('error' in U.POST_SCHEMA.diff)
  && U.POST_SCHEMA.left && !('error' in U.POST_SCHEMA.left) && Array.isArray(U.POST_SCHEMA.left.remaining), JSON.stringify(U.POST_SCHEMA));
ok('T1 real ANALYST answer: mechanismSection and mechanismOrCells removed', !('mechanismSection' in U.ANALYST_SCHEMA) && !('mechanismOrCells' in U.ANALYST_SCHEMA) && U.ANALYST_SCHEMA.ready === false);
ok('T1 real MERGE / PROG / REVIEW answers: reason, files, acceptance, fixBehaviourUnchanged removed; required values kept',
  !('reason' in U.MERGE_SCHEMA) && !('files' in U.MERGE_SCHEMA) && U.MERGE_SCHEMA.mergeOnly === false && !('acceptance' in U.PROG_SCHEMA)
  && U.PROG_SCHEMA.status === 'ready' && !('fixBehaviourUnchanged' in U.REVIEW_SCHEMA) && U.REVIEW_SCHEMA.verdict === 'done');
ok('T1 a real TEST answer keeps its optional non-null environment', U.TEST_SCHEMA.environment === 'Commands prohibited; verification unavailable.');
// raw answers fail the original schema (so unstrict is what makes them pass, not a lax validate)
ok('T1 the raw answers with optional nulls do not pass the original schema (validate is not lax)',
  ['REVIEW_SCHEMA', 'POST_SCHEMA', 'MERGE_SCHEMA', 'ANALYST_SCHEMA'].every((n) => validate(JSON.parse(G6[n]), S[n]).length > 0));

// ---- the call sites of role-chain.js: kind, agentType, effort, schema
const defCheck = /const checkOpts = [^\n]*/.exec(SRC)[0];
const SITES = [];
for (const line of SRC.split('\n')) {
  let m = /label: `([a-z]+):\$\{t\.key\}[^`]*`/.exec(line);
  if (m && !/const checkOpts/.test(line)) {
    const at = /agentType: (?:roleType\('([a-z-]+)'\)|'(general-purpose)')/.exec(line);
    const ef = /effort: '([a-z]+)'/.exec(line);
    const sc = /schema: ([A-Z_]+_SCHEMA)/.exec(line);
    SITES.push({ kind: m[1], role: at && at[1], gp: !!(at && at[2]), effort: ef ? ef[1] : undefined, schema: sc && sc[1], line: line.trim().slice(0, 80) });
  }
  m = /checkOpts\(`([a-z]+):\$\{t\.key\}[^`]*`, [^,]+, ([A-Z_]+_SCHEMA), retry\)/.exec(line);
  if (m) SITES.push({ kind: m[1], role: null, gp: /agentType: 'general-purpose'/.test(defCheck), effort: (/effort: '([a-z]+)'/.exec(defCheck) || [])[1], schema: m[2], line: line.trim().slice(0, 80), check: true });
}
ok('T2 the call sites of role-chain.js are found (14: 8 role labels with prog twice, 6 service labels), each with its agentType and schema',
  SITES.length === 14 && SITES.every((s) => (s.role || s.gp) && S[s.schema]), JSON.stringify(SITES));
ok('T2 the role of agentType equals the role of the kind of the label at every role site (roleType(r) with r = KINDS[kind])',
  SITES.filter((s) => s.role).every((s) => KINDS[s.kind] === s.role), JSON.stringify(SITES.filter((s) => s.role && KINDS[s.kind] !== s.role)));
ok('T2 pre and the service sites are general-purpose', SITES.filter((s) => s.kind === 'pre' || s.check).every((s) => s.gp));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'role-exec-tester-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const TASKS = { K: { wt: path.join(TMP, 'wt'), dir: path.join(TMP, 'dirK') } };
const CALLS = path.join(TMP, 'calls');
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));
const launched = [];
let answer = null;
const launch = async (plan) => { launched.push(plan); return typeof answer === 'function' ? answer(plan) : answer; };
const logs = [];
const mk = (host, extra = {}) => createAgent(Object.assign({ host, tasks: TASKS, pluginRoot: ROOT, callsDir: CALLS, launch, log: (m) => logs.push(m),
  codex: Object.assign({ bin: '/fake/codex', home: path.join(TMP, 'home'), catalog: CATALOG }, extra.codex || {}), claude: { bin: '/fake/claude' } }, extra.top || {}));
const records = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const labelOf = (s) => (s.check ? `${s.kind}:K:x` : ['prog', 'test', 'review', 'sec'].includes(s.kind) ? `${s.kind}:K#1` : `${s.kind}:K`);
const CODEX_RUNS = new Set(['analyst', 'usecases', 'review', 'sec']);

// ---- T3: strict() shares nothing with its input
const nodes = (x, set = new Set()) => { if (x && typeof x === 'object' && !set.has(x)) { set.add(x); Object.values(x).forEach((v) => nodes(v, set)); } return set; };
const shared = NAMES.filter((n) => { const a = nodes(S[n]); return [...nodes(strict(S[n]))].some((o) => a.has(o)); });
ok('T3 strict(): no object or array of the output is an object of the input, at any depth (twelve schemas)', !shared.length, shared.join(','));

(async () => {
  // ---- T1 through agent() on codex: the real answer text of the -o file comes back ok in the original shape
  const X = mk('codex'), C = mk('claude');
  for (const [kind, n] of [['analyst', 'ANALYST_SCHEMA'], ['usecases', 'USECASES_SCHEMA'], ['review', 'REVIEW_SCHEMA'], ['sec', 'REVIEW_SCHEMA']]) {
    answer = { rc: 0, output: G6[n] };
    const at = `codis-agents:${KINDS[kind]}`;
    const r = await X('task\n', { label: `${kind}:K#1`, schema: S[n], agentType: at, model: 'opus' });
    ok(`T1 X ${kind}: the real G6 answer comes back ok, equal to unstrict of it`, r && JSON.stringify(r) === JSON.stringify(U[n]), JSON.stringify(r));
  }

  // ---- T2: every real call site on both hosts with both prefixes
  for (const prefix of ['codis-agents:', '']) {
    for (const s of SITES) {
      const agentType = s.gp ? 'general-purpose' : prefix ? prefix + s.role : 'general-purpose';
      const opts = { label: labelOf(s), phase: 'P', schema: S[s.schema], agentType, model: 'opus' };
      if (s.effort) opts.effort = s.effort;
      const n0 = launched.length;
      answer = { rc: 0, output: U[s.schema] };
      const rc = await C('task\n', opts);
      const pc = launched.slice(n0);
      ok(`T2 C prefix "${prefix}" ${opts.label} (${agentType}): launched and ok`, pc.length === 1 && rc && validate(rc, S[s.schema]).length === 0
        && (agentType === 'general-purpose' ? !pc[0].argv.includes('--agent') : pc[0].argv[pc[0].argv.indexOf('--agent') + 1] === agentType), JSON.stringify({ rc, logs: logs.slice(-1) }));
      const n1 = launched.length;
      answer = { rc: 0, output: G6[s.schema] };
      const rx = await X('task\n', opts);
      const px = launched.slice(n1);
      if (CODEX_RUNS.has(s.kind)) {
        ok(`T2 X prefix "${prefix}" ${opts.label}: launched and ok (${px[0] ? px[0].argv.join(' ').slice(0, 60) : 'not launched'})`,
          px.length === 1 && rx && validate(rx, S[s.schema]).length === 0 && px[0].stdin.startsWith(agentType === 'general-purpose' ? 'task' : fs.readFileSync(path.join(ROOT, 'agents', `${s.role}.md`), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim()),
          JSON.stringify({ rx, logs: logs.slice(-1) }));
      } else {
        ok(`T2 X prefix "${prefix}" ${opts.label}: refused, nothing launched`, px.length === 0 && rx === null && records(TASKS.K.dir).slice(-1)[0].outcome === 'refused');
      }
    }
  }

  // ---- T4: the prompt byte for byte
  const PR = path.join(TMP, 'plugin');
  fs.mkdirSync(path.join(PR, 'agents'), { recursive: true });
  const body = '\n\n  # reviewer\n\nRead the diff.\n\n---\n\nA rule after a horizontal line.\n   \n';
  fs.writeFileSync(path.join(PR, 'agents', 'reviewer.md'), `---\nname: reviewer\ndescription: x\n---\n${body}`);
  const prompt = '\n  ' + String.fromCharCode(0x417, 0x430, 0x434, 0x430, 0x447, 0x430) + ': `x` $HOME \'q\' "d"\r\nline\t \n\n';
  const XP = mk('codex', { top: { pluginRoot: PR } });
  answer = { rc: 0, output: G6.REVIEW_SCHEMA };
  const n0 = launched.length;
  await XP(prompt, { label: 'review:K#1', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
  const p4 = launched[n0];
  const want = body.trim() + '\n\n' + prompt;
  ok('T4 X stdin = body.trim() + "\\n\\n" + prompt: the prompt keeps its edges, CRLF, tab, non-ASCII; the body keeps its "---" line',
    p4 && p4.stdin === want && p4.stdin.includes('\n---\n\nA rule after'), p4 && JSON.stringify(p4.stdin));
  ok('T4 prompt.txt holds exactly the UTF-8 bytes of stdin', p4 && fs.readFileSync(path.join(p4.callDir, 'prompt.txt')).equals(Buffer.from(want, 'utf8')));
  const CP = mk('claude', { top: { pluginRoot: PR } });
  answer = { rc: 0, output: U.REVIEW_SCHEMA };
  const n2 = launched.length;
  await CP(prompt, { label: 'review:K#1', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
  const p5 = launched[n2];
  ok('T4 C stdin and prompt.txt = the prompt alone, byte for byte', p5 && p5.stdin === prompt && fs.readFileSync(path.join(p5.callDir, 'prompt.txt')).equals(Buffer.from(prompt, 'utf8')));

  // ---- T5: the key of the apiKeyFile mode and the parent's key variables
  const KEY = path.join(TMP, 'openai.key');
  const SECRET = 'sk-tester-secret-777';
  fs.writeFileSync(KEY, SECRET + '\n'); fs.chmodSync(KEY, 0o600);
  const PARENT = { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-parent-openai', CODEX_API_KEY: 'sk-parent-codex' };
  const XK = mk('codex', { codex: { auth: 'apiKeyFile', keyFile: KEY }, top: { env: PARENT } });
  answer = { rc: 0, output: G6.REVIEW_SCHEMA };
  const l0 = logs.length, n3 = launched.length;
  const rk = await XK('task\n', { label: 'review:K#5', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
  const pk = launched[n3];
  ok('T5 apiKeyFile 600: CODEX_API_KEY of the child = the key, the parent\'s OPENAI_API_KEY dropped, CODEX_HOME = the run home',
    rk && pk && pk.env.CODEX_API_KEY === SECRET && !('OPENAI_API_KEY' in pk.env) && pk.env.CODEX_HOME === path.join(TMP, 'home'), pk && JSON.stringify(pk.env));
  const filesText = (d) => fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
  ok('T5 the key is in no argv, record line, call folder file or log line',
    pk && !pk.argv.join(' ').includes(SECRET) && !fs.readFileSync(path.join(TASKS.K.dir, 'calls.jsonl'), 'utf8').includes(SECRET)
    && !filesText(pk.callDir).includes(SECRET) && !logs.slice(l0).join('\n').includes(SECRET));
  const XG = mk('codex', { top: { env: PARENT } });
  const n4 = launched.length;
  await XG('task\n', { label: 'review:K#6', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
  const pg = launched[n4];
  ok('T5 chatgpt mode: neither OPENAI_API_KEY nor CODEX_API_KEY of the parent reaches the child', pg && !('OPENAI_API_KEY' in pg.env) && !('CODEX_API_KEY' in pg.env), pg && JSON.stringify(pg.env));
  fs.chmodSync(KEY, 0o640);
  const n5 = launched.length, r0 = records(TASKS.K.dir).length;
  const r644 = await XK('task\n', { label: 'review:K#7', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
  const rr = records(TASKS.K.dir).slice(r0);
  ok('T5 key file 640: refused, nothing launched, one record naming mode 600, without the key',
    r644 === null && launched.length === n5 && rr.length === 1 && rr[0].outcome === 'refused' && /600/.test(rr[0].error) && !JSON.stringify(rr).includes(SECRET), JSON.stringify(rr));

  // ---- T6: the run home on codex - the parent's CODEX_HOME through process.env, the catalog of the run home only
  {
    const PH = path.join(TMP, 'parent-home'), RH = path.join(TMP, 'run-home-t6'), EMPTY = path.join(TMP, 'run-home-empty');
    [PH, RH, EMPTY].forEach((d) => fs.mkdirSync(d, { recursive: true }));
    fs.writeFileSync(path.join(PH, RX.CATALOG_FILE), JSON.stringify(CATALOG));
    fs.writeFileSync(path.join(RH, RX.CATALOG_FILE), JSON.stringify(CATALOG));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = PH;
    try {
      const base6 = { host: 'codex', tasks: TASKS, pluginRoot: ROOT, callsDir: CALLS, launch, log: (m) => logs.push(m) };
      const A = createAgent(Object.assign({}, base6, { codex: { bin: '/fake/codex', home: RH } }));
      answer = { rc: 0, output: G6.REVIEW_SCHEMA };
      const n6 = launched.length;
      const ra = await A('task\n', { label: 'review:K#8', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
      const pa = launched[n6];
      ok('T6 no cfg.env, parent CODEX_HOME in process.env: the child\'s CODEX_HOME is codex.home', ra && pa && pa.env.CODEX_HOME === RH, pa && pa.env.CODEX_HOME);
      const B = createAgent(Object.assign({}, base6, { codex: { bin: '/fake/codex', home: EMPTY } }));
      const n7 = launched.length, r7 = records(TASKS.K.dir).length;
      const rb = await B('task\n', { label: 'review:K#9', schema: S.REVIEW_SCHEMA, agentType: 'codis-agents:reviewer' });
      const rr7 = records(TASKS.K.dir).slice(r7);
      ok('T6 the run home has no cached catalog: refused, nothing launched - the catalog of the parent\'s CODEX_HOME is not read',
        rb === null && launched.length === n7 && rr7.length === 1 && rr7[0].outcome === 'refused' && /catalog/.test(rr7[0].error), JSON.stringify(rr7));
      const ca6 = (codex) => { try { createAgent(Object.assign({}, base6, { codex })); return ''; } catch (e) { return e.message; } };
      ok('T6 codex.home "~/.codex" (not absolute, never expanded) is refused by createAgent', /codex\.home/.test(ca6({ catalog: CATALOG, home: '~/.codex' })));
      ok('T6 apiKeyFile mode without codex.home is refused by createAgent (the parent\'s CODEX_HOME does not stand in)',
        /codex\.home/.test(ca6({ catalog: CATALOG, auth: 'apiKeyFile', keyFile: KEY })));
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    }
  }

  done();
})().catch((e) => { ok('no exception in the test', false, e.stack); done(); });
