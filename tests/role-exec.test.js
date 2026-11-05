#!/usr/bin/env node
'use strict';
// scripts/role-exec.js, part A1a of the role adapter (p-codex-A): the contract and the data, no role process and no
// model. Cells: strict/unstrict/validate on the twelve schemas of workflows/role-chain.js taken from its source (A1-01,
// A1-02, A1-03, A1-04, A1-30, A1-36, A1-36'), the role from the kind of the label (A1-12, A1-31, A1-32), the body of the
// role and the argv of each host (A1-05, A1-07, A1-08, A1-09, A1-10, A1-11), the result against the original schema
// (A1-06), prompt.txt (A1-38), one line of calls.jsonl per call, and `role-exec.js check` on fake CLIs (A1-29).
// The process of a role is the launcher's (cfg.launch, part A1b): here a fake launcher records the plan it gets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');
const SCRIPT = path.join(ROOT, 'scripts', 'role-exec.js');
let RX = {};
try { RX = require(SCRIPT); } catch (e) { ok('scripts/role-exec.js loads', false, e.message); }
const { createAgent, strict, unstrict, validate, schemaProblems, parseLabel } = RX;
const fnOk = (f) => typeof f === 'function';
ok('role-exec exports createAgent, strict, unstrict, validate, schemaProblems, parseLabel',
  [createAgent, strict, unstrict, validate, schemaProblems, parseLabel].every(fnOk), Object.keys(RX).join(','));
const safe = (f) => (...a) => { try { return f(...a); } catch (e) { return { thrown: e.message }; } };

// ---- the twelve schemas, cut out of the source of role-chain.js and run in order in a vm (POST refers to DIFF, LEFT)
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
const NAMES = ['PRE', 'ANALYST', 'USECASES', 'PROG', 'TEST', 'DIFF', 'REVIEW', 'SHA', 'LEFT', 'POST', 'RUN', 'MERGE'].map((n) => n + '_SCHEMA');
const S = (() => {
  const ctx = {}; vm.createContext(ctx);
  const re = /const ([A-Z_]+_SCHEMA) = \{/g; let m; const found = [];
  while ((m = re.exec(SRC))) {
    let i = m.index + m[0].length - 1, d = 0;
    for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
    vm.runInContext(SRC.slice(m.index, i + 1).replace(/^const /, 'var ') + ';', ctx);
    found.push(m[1]);
  }
  ok('A1-01 the twelve schemas of role-chain.js are found in its source', JSON.stringify(found.slice().sort()) === JSON.stringify(NAMES.slice().sort()), found.join(','));
  // A plain copy out of the vm realm, then frozen deeply: an adapter that changes a shared schema in place throws (A1-30).
  const out = {};
  for (const n of NAMES) out[n] = JSON.parse(JSON.stringify(ctx[n]));
  // POST refers to the same DIFF and LEFT objects as in role-chain.js
  out.POST_SCHEMA.properties.diff = out.DIFF_SCHEMA; out.POST_SCHEMA.properties.left = out.LEFT_SCHEMA;
  return out;
})();
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const BEFORE = JSON.stringify(S);
Object.values(S).forEach(deepFreeze);
const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const noDesc = (x) => (Array.isArray(x) ? x.map(noDesc) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'description').map(([k, v]) => [k, noDesc(v)])) : x);
const types = (n) => [].concat(n.type || []);

// ---- strict (A1-01, A1-02, A1-30, A1-36)
const ST = {};
for (const n of NAMES) ST[n] = fnOk(strict) ? safe(strict)(S[n]) : { thrown: 'no strict' };
ok('A1-30 strict() takes the frozen schemas without throwing', NAMES.every((n) => !ST[n].thrown), NAMES.filter((n) => ST[n].thrown).map((n) => n + ': ' + ST[n].thrown).join('; '));
ok('A1-30 strict() leaves its input unchanged (POST with the shared DIFF and LEFT included)', JSON.stringify(S) === BEFORE);
ok('A1-30 strict() returns a new object, not its input', NAMES.every((n) => ST[n] !== S[n] && ST[n].properties !== S[n].properties));
const levels = (orig, st, p, out) => {
  // every object level of the original against the same level of the strict form
  if (!orig || !st) return out;
  if (types(orig).includes('object') && orig.properties) {
    const keys = Object.keys(orig.properties); const req = new Set(orig.required || []);
    if (!same(st.required, keys)) out.push(`${p}: required ${JSON.stringify(st.required)}`);
    if (st.additionalProperties !== false) out.push(`${p}: additionalProperties`);
    for (const k of keys) {
      const o = orig.properties[k], s = (st.properties || {})[k] || {};
      const nullable = types(o).includes('null');
      if (!req.has(k) && !nullable) {
        if (!same(types(s), types(o).concat('null'))) out.push(`${p}.${k}: type ${JSON.stringify(s.type)}`);
        if (o.enum && !same(s.enum, o.enum.concat(null))) out.push(`${p}.${k}: enum ${JSON.stringify(s.enum)}`);
      } else if (!same(types(s), types(o)) || (o.enum && !same(s.enum, o.enum))) out.push(`${p}.${k}: changed ${JSON.stringify(s.type)}`);
      levels(o, s, `${p}.${k}`, out);
    }
  }
  if (orig.items) levels(orig.items, st.items, p + '[]', out);
  return out;
};
const bad = NAMES.flatMap((n) => (ST[n].thrown ? [] : levels(S[n], ST[n], n, [])));
ok('A1-01 strict: on every object level all keys required, optional fields admit null (enum too), additionalProperties false', !bad.length, bad.slice(0, 6).join('; '));
ok('A1-01 strict: POST is strict on its nested levels (diff, left)', ST.POST_SCHEMA.properties && ST.POST_SCHEMA.properties.diff.additionalProperties === false
  && same(ST.POST_SCHEMA.properties.left.required, Object.keys(S.LEFT_SCHEMA.properties)) && same(ST.POST_SCHEMA.properties.diff.properties.error.type, ['string', 'null']));
ok('A1-01 strict: ANALYST.mechanismOrCells has null in its type and its enum', ST.ANALYST_SCHEMA.properties
  && same(ST.ANALYST_SCHEMA.properties.mechanismOrCells.enum, ['mechanism', 'cells', null]) && same(ST.ANALYST_SCHEMA.properties.mechanismOrCells.type, ['string', 'null']));
ok('A1-01 strict(REVIEW_SCHEMA) equals the strict schema of experiment X0 (review.strict.json)',
  same(ST.REVIEW_SCHEMA, JSON.parse(fs.readFileSync(path.join(FIX, 'review.strict.x0.json'), 'utf8'))), JSON.stringify(ST.REVIEW_SCHEMA));
// A1-36: the twelve strict forms the API accepted in the live check G6 (codex exec with gpt-6-astra, 12/12 without a
// 400). Descriptions are free text and not compared, so a reworded description keeps this green; a changed structure
// (a new field, type, enum, keyword) turns it red: run the live check again and refresh tests/fixtures/role-exec.
const api = NAMES.filter((n) => !same(noDesc(ST[n]), noDesc(JSON.parse(fs.readFileSync(path.join(FIX, `strict-${n}.json`), 'utf8')))));
ok('A1-36 strict() of each of the twelve schemas equals the form the API accepted (G6), descriptions aside', !api.length, api.join(','));
ok('A1-02 strict: RUN.rc, required and already nullable, is unchanged', ST.RUN_SCHEMA.properties && same(ST.RUN_SCHEMA.properties.rc.type, ['number', 'null']));

// ---- A1-04 keywords outside type/properties/required/items/enum/description
const kw = (extra) => ({ type: 'object', properties: { a: Object.assign({ type: 'string' }, extra) }, required: ['a'] });
ok('A1-04 schemaProblems: none on the twelve schemas', NAMES.every((n) => fnOk(schemaProblems) && schemaProblems(S[n]).length === 0));
ok('A1-04 schemaProblems names an unknown keyword with its path (minLength, nested pattern, additionalProperties)',
  fnOk(schemaProblems) && /minLength/.test(schemaProblems(kw({ minLength: 1 })).join(' '))
  && /pattern/.test(schemaProblems({ type: 'object', properties: { o: { type: 'array', items: { type: 'string', pattern: 'x' } } }, required: [] }).join(' '))
  && /additionalProperties/.test(schemaProblems(Object.assign(kw({}), { additionalProperties: false })).join(' ')));
ok('A1-04 strict() throws on an unknown keyword (never guesses its strict form)', fnOk(strict) && !!safe(strict)(kw({ format: 'date' })).thrown);

// ---- sample answers from a schema (required fields filled; optional ones null, as Codex answers in strict mode)
const sample = (s, optNull) => {
  const t = types(s).filter((x) => x !== 'null')[0];
  if (s.enum) return s.enum.find((v) => v !== null);
  if (t === 'object') {
    const req = new Set(s.required || []); const o = {};
    for (const [k, p] of Object.entries(s.properties || {})) o[k] = !req.has(k) && optNull ? null : sample(p, optNull);
    return o;
  }
  return t === 'array' ? [sample(s.items, optNull)] : t === 'number' ? 1 : t === 'boolean' ? true : 'x';
};
const hasOptNull = (v, s) => {
  if (!v || typeof v !== 'object' || !s.properties) return false;
  const req = new Set(s.required || []);
  return Object.entries(v).some(([k, x]) => (x === null && !req.has(k) && !types(s.properties[k] || {}).includes('null'))
    || (s.properties[k] && hasOptNull(x, s.properties[k])));
};
// A1-03: Codex answers null in every optional field of the strict form; unstrict removes them, keeps the rest.
const un = {};
for (const n of NAMES) { const v = deepFreeze(sample(S[n], true)); un[n] = { v, r: fnOk(unstrict) ? safe(unstrict)(v, S[n]) : { thrown: 'no unstrict' } }; }
ok('A1-30 unstrict() takes a frozen answer and frozen schema without throwing', NAMES.every((n) => !un[n].r.thrown), NAMES.filter((n) => un[n].r.thrown).join(','));
ok('A1-03 unstrict: no optional null is left and the answer passes the original schema (all twelve)',
  NAMES.every((n) => !un[n].r.thrown && !hasOptNull(un[n].r, S[n]) && fnOk(validate) && validate(un[n].r, S[n]).length === 0),
  NAMES.filter((n) => un[n].r.thrown || hasOptNull(un[n].r, S[n]) || !fnOk(validate) || validate(un[n].r, S[n]).length).join(','));
const R = un.REVIEW_SCHEMA.r, P = un.POST_SCHEMA.r, A = un.ANALYST_SCHEMA.r, M = un.MERGE_SCHEMA.r;
ok('A1-03 unstrict: the listed optional fields are removed (fixBehaviourUnchanged, mechanismOrCells, mechanismSection, POST.ok, POST.diff.error, POST.left.error, MERGE.reason/files)',
  R && !('fixBehaviourUnchanged' in R) && R.verdict === 'done' && R.docsOnly === true && A && !('mechanismOrCells' in A) && !('mechanismSection' in A)
  && P && !('ok' in P) && P.diff && !('error' in P.diff) && P.left && !('error' in P.left) && M && !('reason' in M) && !('files' in M), JSON.stringify({ R, P, A, M }));
ok('A1-30 unstrict() leaves its input unchanged', JSON.stringify(un.POST_SCHEMA.v.diff) === JSON.stringify({ ok: true, offending: ['x'], error: null }));
// A1-36' / A1-02: RUN.rc is required and nullable: null stays (G6 found that removing every null breaks it).
const run0 = fnOk(unstrict) ? safe(unstrict)(Object.freeze({ done: true, rc: null, log: '/l', seconds: null, tail: 'x', alive: null, pid: null, error: null }), S.RUN_SCHEMA) : {};
ok("A1-36' unstrict keeps RUN.rc: null (required, nullable) and removes only the optional nulls",
  run0 && run0.rc === null && 'rc' in run0 && !('seconds' in run0) && !('alive' in run0) && !('pid' in run0) && !('error' in run0) && run0.tail === 'x', JSON.stringify(run0));
ok("A1-36' the answer with rc: null passes RUN_SCHEMA", fnOk(validate) && validate(run0, S.RUN_SCHEMA).length === 0);
const nullOpt = { type: 'object', properties: { a: { type: ['string', 'null'] }, b: { type: 'string' } }, required: ['b'] };
ok('A1-02 an optional field that admitted null already keeps its null', fnOk(unstrict) && 'a' in unstrict({ a: null, b: 'x' }, nullOpt));

// ---- validate against the original schema (A1-06)
const vErr = (v, s) => (fnOk(validate) ? validate(v, s) : ['no validate']);
ok('A1-06 validate: an enum value outside the enum', vErr({ verdict: 'maybe', docsOnly: false, summary: '' }, S.REVIEW_SCHEMA).some((e) => /verdict/.test(e)));
ok('A1-06 validate: a wrong type', vErr({ verdict: 'done', docsOnly: 'no', summary: '' }, S.REVIEW_SCHEMA).some((e) => /docsOnly/.test(e)));
ok('A1-06 validate: a missing required field', vErr({ verdict: 'done', docsOnly: false }, S.REVIEW_SCHEMA).some((e) => /summary/.test(e)));
ok('A1-06 validate: a nested object (POST.diff.ok a string)', vErr({ diff: { ok: 'yes', offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } }, S.POST_SCHEMA).some((e) => /diff.*ok/.test(e)));
ok('A1-06 validate: array items (PROG.commits with a number)', vErr(Object.assign(sample(S.PROG_SCHEMA, false), { commits: [1] }), S.PROG_SCHEMA).some((e) => /commits/.test(e)));
ok('A1-06 validate: a null in an optional field that does not admit null', vErr({ verdict: 'done', docsOnly: false, summary: '', fixBehaviourUnchanged: null }, S.REVIEW_SCHEMA).length > 0);
ok('A1-06 validate: a valid answer has no errors', vErr({ verdict: 'done', docsOnly: false, summary: '' }, S.REVIEW_SCHEMA).length === 0);

// ---- labels (A1-12)
const LABELS = [['pre:K', 'pre'], ['analyst:K', 'analyst'], ['usecases:K', 'usecases'], ['prog:K#2', 'prog'], ['test:K#1', 'test'],
  ['review:K#1', 'review'], ['sec:K#3', 'sec'], ['sha:K:programmer', 'sha'], ['diff:K:tester', 'diff'], ['left:K:end', 'left'],
  ['post:K:tester', 'post'], ['run:K:select-1', 'run'], ['merge:K:2', 'merge'], ['diff:K:reviewer#retry', 'diff'], ['post:K:tester#retry', 'post']];
const pl = (l) => (fnOk(parseLabel) ? safe(parseLabel)(l) : {});
ok('A1-12 parseLabel: every kind of label (13 + #retry) gives its kind and the key K',
  LABELS.every(([l, k]) => pl(l) && pl(l).kind === k && pl(l).key === 'K'), JSON.stringify(LABELS.map(([l]) => pl(l))));
ok('A1-12 parseLabel: no kind, an empty key or an unknown kind gives null', [':K', 'K', 'review:', 'review:#1', 'foo:K', ''].every((l) => pl(l) === null || (pl(l) && pl(l).kind === undefined)));
// The guard over the source of role-chain.js: every label literal starts with "<kind>:${t.key}" and parses.
const lits = [...SRC.matchAll(/(?:label: |checkOpts\()`([^`]*)`/g)].map((m) => m[1]);
const parsedLits = lits.map((l) => [l, pl(l.replace(/\$\{t\.key\}/g, 'K').replace(/\$\{[^}]*\}/g, 'v1'))]);
const kindsInSrc = new Set(parsedLits.map(([, p]) => p && p.kind));
ok('A1-12 role-chain.js: every label literal is "<kind>:${t.key}..." and parses to the key', lits.length >= 14
  && lits.every((l) => /^[a-z]+:\$\{t\.key\}/.test(l)) && parsedLits.every(([, p]) => p && p.key === 'K'), JSON.stringify(parsedLits));
ok('A1-12 role-chain.js: its label kinds are exactly the thirteen the adapter knows',
  same([...kindsInSrc].sort(), ['analyst', 'diff', 'left', 'merge', 'post', 'pre', 'prog', 'review', 'run', 'sec', 'sha', 'test', 'usecases']), [...kindsInSrc].join(','));
ok('A1-12 role-chain.js: the retry label is "<label>#retry"', /label: retry \? `\$\{label\}#retry` : label/.test(SRC));

// ---- agent(): a plugin root with role bodies, two task folders, a fake launcher
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'role-exec-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const PR = path.join(TMP, 'plugin');
fs.mkdirSync(path.join(PR, 'agents'), { recursive: true });
const BODY = {};
for (const r of ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer']) {
  BODY[r] = `\n# ${r}\n\nBody of the ${r}.\n\n`;
  fs.writeFileSync(path.join(PR, 'agents', `${r}.md`), `---\nname: ${r}\ndescription: the ${r}\ndisallowedTools: Monitor\n---\n${BODY[r]}`);
}
const TASKS = { K: { wt: path.join(TMP, 'wt'), dir: path.join(TMP, 'dirK') }, L: { wt: path.join(TMP, 'wt2'), dir: path.join(TMP, 'dirL') } };
const CALLS = path.join(TMP, 'calls');
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));
const launched = [];
let answer = null;
const fake = async (plan) => { launched.push(plan); return typeof answer === 'function' ? answer(plan) : answer; };
const logs = [];
const mk = (host, extra = {}) => createAgent({
  host, tasks: TASKS, pluginRoot: PR, callsDir: CALLS, launch: fake, log: (m) => logs.push(m),
  codex: Object.assign({ bin: '/fake/codex', home: path.join(TMP, 'chome'), catalog: CATALOG }, extra.codex || {}),
  claude: { bin: '/fake/claude' },
});
const records = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const ROLE = { pre: 'general-purpose', analyst: 'codis-agents:analyst', usecases: 'codis-agents:analyst', prog: 'codis-agents:programmer',
  test: 'codis-agents:tester', review: 'codis-agents:reviewer', sec: 'codis-agents:security-reviewer' };
const SCH = { pre: S.PRE_SCHEMA, analyst: S.ANALYST_SCHEMA, usecases: S.USECASES_SCHEMA, prog: S.PROG_SCHEMA, test: S.TEST_SCHEMA, review: S.REVIEW_SCHEMA, sec: S.REVIEW_SCHEMA };
const call = async (ag, label, extra = {}) => {
  const kind = label.split(':')[0];
  const n0 = launched.length;
  let res;
  try { res = await ag(extra.prompt || `Task text for ${label}.\n`, Object.assign({ label, phase: 'P', schema: SCH[kind] || S.SHA_SCHEMA, agentType: ROLE[kind] || 'general-purpose' }, extra.opts || {})); }
  catch (e) { res = { threw: e.message }; }
  return { res, plan: launched.slice(n0).reverse().find((x) => x.label === label) || null };
};
const argOf = (plan, flag) => { const i = plan ? plan.argv.indexOf(flag) : -1; return i < 0 ? undefined : plan.argv[i + 1]; };
const readCall = (plan, f) => { try { return fs.readFileSync(path.join(plan.callDir, f), 'utf8'); } catch { return null; } };

(async () => {
  if (!fnOk(createAgent)) { done(); return; }
  const X = mk('codex'), C = mk('claude');
  let r;

  // A1-07 X: the body of the role from pluginRoot without frontmatter, an empty line, then the prompt; prompt.txt (A1-38)
  answer = { rc: 0, output: JSON.stringify({ verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' }) };
  for (const [kind, role] of [['analyst', 'analyst'], ['usecases', 'analyst'], ['review', 'reviewer'], ['sec', 'security-reviewer']]) {
    answer = { rc: 0, output: JSON.stringify(sample(ST[kind === 'analyst' ? 'ANALYST_SCHEMA' : kind === 'usecases' ? 'USECASES_SCHEMA' : 'REVIEW_SCHEMA'], true)) };
    r = await call(X, `${kind}:K#1`);
    const want = BODY[role].trim() + '\n\n' + `Task text for ${kind}:K#1.\n`;
    ok(`A1-07 X ${kind}: stdin = body of agents/${role}.md (no frontmatter, trimmed) + "\\n\\n" + prompt`, r.plan && r.plan.stdin === want, r.plan && JSON.stringify(r.plan.stdin));
    ok(`A1-38 X ${kind}: prompt.txt holds exactly the stdin bytes`, r.plan && readCall(r.plan, 'prompt.txt') === r.plan.stdin);
    ok(`A1-07 X ${kind}: the call ends ok with the object of the original schema`, r.res && typeof r.res === 'object' && !r.res.threw, JSON.stringify(r.res));
  }
  // the real reviewer body of this plugin, as in experiment X0 (make-prompts.js: body.trim() + "\n\n" + task)
  const XR = createAgent({ host: 'codex', tasks: TASKS, pluginRoot: ROOT, callsDir: CALLS, launch: fake, log: () => {}, codex: { bin: '/fake/codex', home: path.join(TMP, 'chome'), catalog: CATALOG } });
  answer = { rc: 0, output: JSON.stringify({ verdict: 'rejected', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' }) };
  r = await call(XR, 'review:K#1', { prompt: 'You are the REVIEWER.\nline 2\n' });
  const realBody = fs.readFileSync(path.join(ROOT, 'agents', 'reviewer.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim();
  ok('A1-07 X review with the plugin\'s own agents/reviewer.md: stdin = body.trim() + "\\n\\n" + prompt, byte for byte',
    r.plan && r.plan.stdin === realBody + '\n\nYou are the REVIEWER.\nline 2\n' && readCall(r.plan, 'prompt.txt') === r.plan.stdin);
  ok('A1-03 X review: the answer comes back without fixBehaviourUnchanged: null', r.res && r.res.verdict === 'rejected' && !('fixBehaviourUnchanged' in r.res), JSON.stringify(r.res));

  // X argv: codex exec ... -m <model> -c model_reasoning_effort=<e> --output-schema <call>/schema.json -o <call>/last.json; schema = strict form
  answer = { rc: 0, output: JSON.stringify({ verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' }) };
  r = await call(X, 'review:K#1');
  ok('X argv: exec --json --ephemeral, -m gpt-6-astra (opus by the default table), effort high (default), stdin "-"',
    r.plan && r.plan.bin === '/fake/codex' && r.plan.argv[0] === 'exec' && r.plan.argv.includes('--json') && r.plan.argv.includes('--ephemeral')
    && argOf(r.plan, '-m') === 'gpt-6-astra' && argOf(r.plan, '-c') === 'model_reasoning_effort=high' && r.plan.argv[r.plan.argv.length - 1] === '-', r.plan && r.plan.argv.join(' '));
  ok('X argv: --output-schema is <call dir>/schema.json holding strict(schema); -o is <call dir>/last.json',
    r.plan && argOf(r.plan, '--output-schema') === path.join(r.plan.callDir, 'schema.json') && argOf(r.plan, '-o') === path.join(r.plan.callDir, 'last.json')
    && same(JSON.parse(readCall(r.plan, 'schema.json')), ST.REVIEW_SCHEMA));
  ok('A1-12 X: the call folder lies in the task folder of the key (calls/), the root -C is that task folder',
    r.plan && path.dirname(r.plan.callDir) === path.join(TASKS.K.dir, 'calls') && argOf(r.plan, '-C') === TASKS.K.dir && r.plan.cwd === TASKS.K.dir, r.plan && r.plan.callDir);
  r = await call(X, 'review:L#1');
  ok('A1-12 X: another key, another task folder', r.plan && path.dirname(r.plan.callDir) === path.join(TASKS.L.dir, 'calls'));

  // A1-30: two calls at once (review and sec) on the same frozen REVIEW_SCHEMA give the same schema file; the input is untouched
  answer = (plan) => new Promise((res) => setTimeout(() => res({ rc: 0, output: JSON.stringify({ verdict: 'done', docsOnly: true, fixBehaviourUnchanged: null, summary: plan.label }) }), 20));
  const [a1, a2] = await Promise.all([call(X, 'review:K#2'), call(X, 'sec:K#2')]);
  ok('A1-30 X review || sec: two call folders, the same strict schema file, results not mixed up',
    a1.plan && a2.plan && a1.plan.callDir !== a2.plan.callDir && readCall(a1.plan, 'schema.json') === readCall(a2.plan, 'schema.json')
    && a1.res && a1.res.summary === 'review:K#2' && a2.res && a2.res.summary === 'sec:K#2', JSON.stringify([a1.res, a2.res]));
  ok('A1-30 X: the shared schemas are unchanged after the calls', JSON.stringify(S) === BEFORE);

  // A1-05 / A1-07 C: the original schema as is, --agent and --plugin-dir; the prompt alone in stdin and prompt.txt (A1-38)
  answer = { rc: 0, output: { verdict: 'done', docsOnly: false, summary: 's' } };
  for (const kind of ['analyst', 'usecases', 'prog', 'test', 'review', 'sec']) {
    const role = ROLE[kind].split(':')[1];
    answer = { rc: 0, output: sample(SCH[kind], false) };
    r = await call(C, `${kind}:K#1`);
    ok(`A1-07 C ${kind}: --agent codis-agents:${role} --plugin-dir <pluginRoot>; stdin and prompt.txt = the prompt alone`,
      r.plan && argOf(r.plan, '--agent') === `codis-agents:${role}` && argOf(r.plan, '--plugin-dir') === PR
      && r.plan.stdin === `Task text for ${kind}:K#1.\n` && readCall(r.plan, 'prompt.txt') === r.plan.stdin, r.plan && r.plan.argv.join(' '));
    ok(`A1-05 C ${kind}: --json-schema is the original schema, not the strict form`, r.plan && argOf(r.plan, '--json-schema') === JSON.stringify(SCH[kind]));
    ok(`A1-07 C ${kind}: ok with the object`, r.res && !r.res.threw && typeof r.res === 'object', JSON.stringify(r.res));
  }
  ok('C argv: -p --output-format stream-json --verbose --permission-mode auto (owner 5) --no-session-persistence; cwd the task folder',
    r.plan && r.plan.bin === '/fake/claude' && r.plan.argv[0] === '-p' && argOf(r.plan, '--output-format') === 'stream-json' && r.plan.argv.includes('--verbose')
    && argOf(r.plan, '--permission-mode') === 'auto' && r.plan.argv.includes('--no-session-persistence') && r.plan.cwd === TASKS.K.dir, r.plan && r.plan.argv.join(' '));
  ok('A1-30 C: no schema file is written (the host takes the original schema)', r.plan && readCall(r.plan, 'schema.json') === null);

  // A1-08 general-purpose: C without --agent; X (review with agentTypePrefix "") without a body
  answer = { rc: 0, output: sample(S.PRE_SCHEMA, false) };
  r = await call(C, 'pre:K');
  ok('A1-08 C pre (general-purpose): no --agent, the prompt alone', r.plan && !r.plan.argv.includes('--agent') && r.plan.stdin === 'Task text for pre:K.\n' && r.res && r.res.ok === true);
  answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)) };
  r = await call(X, 'review:K#1', { opts: { agentType: 'general-purpose' } });
  ok('A1-31(1) X review with general-purpose (agentTypePrefix ""): reviewer sandbox, no body, the prompt alone',
    r.plan && r.plan.stdin === 'Task text for review:K#1.\n' && r.plan.role === 'reviewer' && r.res && r.res.verdict === 'done');

  // refusals: nothing launched, null, one record line with outcome refused and the reason
  const refused = async (ag, label, why, extra, name) => {
    const dir = TASKS[(pl(label) || {}).key] ? TASKS[pl(label).key].dir : CALLS;
    const n0 = records(dir).length, l0 = logs.length;
    const x = await call(ag, label, extra);
    const rec = records(dir).slice(n0);
    ok(`${name}: refused - nothing launched, null, one record (outcome refused, reason), reason in the log`,
      x.res === null && !x.plan && rec.length === 1 && rec[0].outcome === 'refused' && why.test(rec[0].error || '') && logs.slice(l0).some((m) => why.test(m)),
      JSON.stringify({ res: x.res, launched: !!x.plan, rec }));
  };
  for (const k of ['sha', 'diff', 'left', 'post', 'run', 'merge']) {
    await refused(X, `${k}:K:x`, /service step/, {}, `A1-09 X ${k}`);
  }
  await refused(X, 'diff:K:tester#retry', /service step/, {}, 'A1-09 X diff #retry');
  await refused(X, 'pre:K', /preconditions/, {}, 'A1-32 X pre');
  await refused(X, 'prog:K#1', /A2/, {}, 'A1-31 X prog');
  await refused(X, 'test:K#1', /A2/, {}, 'A1-31 X test');
  await refused(X, 'prog:K#1', /A2/, { opts: { agentType: 'general-purpose' } }, 'A1-31(1) X prog with general-purpose');
  await refused(X, 'test:K#1', /A2/, { opts: { agentType: 'general-purpose' } }, 'A1-31(1) X test with general-purpose');
  for (const H of [['X', X], ['C', C]]) {
    await refused(H[1], 'review:K#1', /agentType/, { opts: { agentType: 'foo:reviewer' } }, `A1-31(2) ${H[0]} foreign prefix`);
    await refused(H[1], 'review:K#1', /agentType/, { opts: { agentType: '' } }, `A1-31(2) ${H[0]} empty agentType`);
    await refused(H[1], 'review:K#1', /agentType/, { opts: { agentType: ':reviewer' } }, `A1-31(2) ${H[0]} empty prefix`);
    await refused(H[1], 'review:K#1', /does not match/, { opts: { agentType: 'codis-agents:programmer' } }, `A1-31(3) ${H[0]} role of agentType != role of the label`);
    await refused(H[1], 'review:Z#1', /unknown task/, {}, `A1-12 ${H[0]} unknown key`);
    await refused(H[1], 'foo:K#1', /label/, {}, `A1-12 ${H[0]} unknown kind of label`);
    await refused(H[1], 'review:K#1', /schema/, { opts: { schema: kw({ minLength: 1 }) } }, `A1-04 ${H[0]} unknown keyword`);
  }
  // A1-09: a role without its file
  const PR2 = path.join(TMP, 'plugin2'); fs.mkdirSync(path.join(PR2, 'agents'), { recursive: true });
  const base2 = { tasks: TASKS, pluginRoot: PR2, callsDir: CALLS, launch: fake, log: (m) => logs.push(m), codex: { bin: '/b', home: TMP, catalog: CATALOG }, claude: { bin: '/c' } };
  await refused(createAgent(Object.assign({ host: 'codex' }, base2)), 'review:K#1', /agents\/reviewer\.md/, {}, 'A1-09 X role without its file');
  await refused(createAgent(Object.assign({ host: 'claude' }, base2)), 'review:K#1', /agents\/reviewer\.md/, {}, 'A1-09 C role without its file');
  // A1-09 C: service labels run (general-purpose, no body)
  answer = { rc: 0, output: { sha: 'abc' } };
  r = await call(C, 'sha:K:programmer', { opts: { schema: S.SHA_SCHEMA, model: 'haiku', effort: 'low' } });
  ok('A1-09 C service label sha: launched, general-purpose, ok', r.plan && !r.plan.argv.includes('--agent') && r.res && r.res.sha === 'abc');
  answer = { rc: 0, output: { done: true, rc: null, log: '/l' } };
  r = await call(C, 'run:K:select-1', { opts: { schema: S.RUN_SCHEMA } });
  ok('A1-09 C service label run: rc null passes (no unstrict on claude)', r.res && r.res.rc === null && 'rc' in r.res, JSON.stringify(r.res));
  await refused(C, 'prog:K#1', /agentType/, { opts: { agentType: 'other:programmer' } }, 'A1-31(2) C prog foreign prefix');

  // A1-10 models
  answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)) };
  r = await call(X, 'review:K#1', { opts: { model: 'opus' } });
  ok('A1-10 X opus -> gpt-6-astra', argOf(r.plan, '-m') === 'gpt-6-astra');
  r = await call(X, 'review:K#1', { opts: { model: undefined } });
  ok('A1-10 X no model -> the default of the table', argOf(r.plan, '-m') === 'gpt-6-astra');
  const XH = mk('codex', { codex: { models: { opus: 'gpt-6-astra', haiku: 'gpt-6-luna', default: 'gpt-6.1-sol' } } });
  r = await call(XH, 'review:K#1', { opts: { model: 'haiku' } });
  ok('A1-10 X haiku by a configured table', argOf(r.plan, '-m') === 'gpt-6-luna');
  r = await call(XH, 'review:K#1', { opts: { model: undefined } });
  ok('A1-10 X no model -> default of a configured table', argOf(r.plan, '-m') === 'gpt-6.1-sol');
  await refused(X, 'review:K#1', /model/, { opts: { model: 'haiku' } }, 'A1-10 X haiku not in the default table');
  await refused(X, 'review:K#1', /model/, { opts: { model: 'sonnet' } }, 'A1-10 X unknown model');
  await refused(mk('codex', { codex: { models: { opus: 'gpt-9' } } }), 'review:K#1', /catalog/, { opts: { model: 'opus' } }, 'A1-10 X model of the table not in the catalog');
  answer = { rc: 0, output: { verdict: 'done', docsOnly: false, summary: 's' } };
  r = await call(C, 'review:K#1', { opts: { model: 'opus' } });
  ok('A1-10 C --model as given', argOf(r.plan, '--model') === 'opus');
  r = await call(C, 'review:K#1', { opts: { model: undefined } });
  ok('A1-10 C no model -> no --model', r.plan && !r.plan.argv.includes('--model'));

  // A1-11 effort
  answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)) };
  r = await call(X, 'review:K#1', { opts: { effort: 'low' } });
  ok('A1-11 X effort low', argOf(r.plan, '-c') === 'model_reasoning_effort=low');
  r = await call(mk('codex', { codex: { effort: 'medium' } }), 'review:K#1', { opts: { effort: undefined } });
  ok('A1-11 X no effort -> cfg.codex.effort', argOf(r.plan, '-c') === 'model_reasoning_effort=medium');
  r = await call(X, 'review:K#1', { opts: { effort: 'max' } });
  ok('A1-11 X max is in the catalog of gpt-6-astra -> passed as is (by the catalog, not by a list)', argOf(r.plan, '-c') === 'model_reasoning_effort=max');
  await refused(mk('codex', { codex: { models: { opus: 'gpt-6-luna', default: 'gpt-6-luna' } } }), 'review:K#1', /effort/, { opts: { effort: 'ultra' } }, 'A1-11 X effort not supported by the model');
  await refused(X, 'review:K#1', /effort/, { opts: { effort: 'turbo' } }, 'A1-11 X unknown effort');
  await refused(mk('codex', { codex: { catalog: null, home: path.join(TMP, 'empty-home') } }), 'review:K#1', /catalog/, {}, 'X no model catalog (no check run)');
  answer = { rc: 0, output: { verdict: 'done', docsOnly: false, summary: 's' } };
  r = await call(C, 'review:K#1', { opts: { effort: 'low' } });
  ok('A1-11 C --effort low', argOf(r.plan, '--effort') === 'low');
  r = await call(C, 'review:K#1', { opts: { effort: undefined } });
  ok('A1-11 C no effort -> no --effort', r.plan && !r.plan.argv.includes('--effort'));
  r = await call(C, 'review:K#1', { opts: { effort: 'max' } });
  ok('A1-11 C --effort max', argOf(r.plan, '--effort') === 'max');

  // A1-06 invalid result on both hosts; no-result; a launcher outcome other than ok
  const inval = async (ag, out, name) => {
    answer = { rc: 0, output: out };
    const n0 = records(TASKS.K.dir).length;
    const x = await call(ag, 'review:K#1');
    const rec = records(TASKS.K.dir).slice(n0);
    ok(`A1-06 ${name}: invalid-result, null, the reason in the record`, x.res === null && rec.length === 1 && rec[0].outcome === 'invalid-result' && /verdict|docsOnly|summary|fixBehaviourUnchanged/.test(rec[0].error || ''), JSON.stringify(rec));
  };
  await inval(X, JSON.stringify({ verdict: 'maybe', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' }), 'X enum');
  await inval(X, JSON.stringify({ verdict: 'done', docsOnly: 'no', fixBehaviourUnchanged: null, summary: 's' }), 'X type');
  await inval(X, JSON.stringify({ verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null }), 'X missing required');
  await inval(C, { verdict: 'maybe', docsOnly: false, summary: 's' }, 'C enum');
  await inval(C, { verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' }, 'C null in an optional field (no unstrict on claude)');
  await inval(C, { verdict: 'done', summary: 's' }, 'C missing required');
  answer = { rc: 0, output: { diff: { ok: 'yes', offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } } };
  r = await call(C, 'post:K:tester', { opts: { schema: S.POST_SCHEMA } });
  const recP = records(TASKS.K.dir).slice(-1)[0];
  ok('A1-06 C nested object (POST.diff.ok): invalid-result', r.res === null && recP.outcome === 'invalid-result' && /diff/.test(recP.error), JSON.stringify(recP));
  for (const [out, name] of [[undefined, 'no output'], ['', 'empty'], ['{not json', 'not JSON']]) {
    answer = { rc: 0, output: out };
    r = await call(X, 'review:K#1');
    ok(`X ${name} -> no-result, null`, r.res === null && records(TASKS.K.dir).slice(-1)[0].outcome === 'no-result');
  }
  answer = { outcome: 'schema-refused', rc: 1, error: 'invalid_json_schema' };
  r = await call(X, 'review:K#1');
  ok('a launcher outcome other than ok is recorded as it is, null', r.res === null && records(TASKS.K.dir).slice(-1)[0].outcome === 'schema-refused');
  answer = () => { throw new Error('boom'); };
  r = await call(X, 'review:K#1');
  ok('a launcher that throws -> crashed, null, never an exception', r.res === null && records(TASKS.K.dir).slice(-1)[0].outcome === 'crashed' && /boom/.test(records(TASKS.K.dir).slice(-1)[0].error));

  // the record line (format read by task C): the fields of analyst.md 5.2
  answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)), usage: { input: 5, cachedInput: 1, cacheWrite: 0, output: 2, reasoning: 1 }, sessionId: 's1', pid: 42, cliVersion: '0.166.0' };
  const n0 = records(TASKS.K.dir).length;
  r = await call(X, 'review:K#7', { opts: { phase: 'Reviewer' } });
  const rec = records(TASKS.K.dir).slice(n0);
  const FIELDS = ['ts', 'host', 'cliVersion', 'label', 'task', 'role', 'phase', 'model', 'effort', 'startedAt', 'endedAt', 'seconds', 'awakeSeconds', 'pid',
    'outcome', 'rc', 'signal', 'error', 'usage', 'costUSD', 'notes', 'sessionId', 'credentialExpiresAt', 'callDir'];
  ok('record: one line per call with every field (ts, host, label, task, role, phase, model, effort, times, outcome, usage, ...)',
    rec.length === 1 && FIELDS.every((f) => f in rec[0]) && rec[0].host === 'codex' && rec[0].label === 'review:K#7' && rec[0].task === 'K' && rec[0].role === 'reviewer'
    && rec[0].phase === 'Reviewer' && rec[0].model === 'gpt-6-astra' && rec[0].effort === 'high' && rec[0].outcome === 'ok' && rec[0].usage.input === 5 && rec[0].pid === 42
    && rec[0].sessionId === 's1' && rec[0].callDir === r.plan.callDir, JSON.stringify(rec));
  // a refusal for an unknown key goes to callsDir (G7)
  const nc = records(CALLS).length;
  await call(X, 'review:Q#1');
  ok('record: an unknown key writes its refusal into callsDir/calls.jsonl', records(CALLS).length === nc + 1 && records(CALLS).slice(-1)[0].task === 'Q');

  // A1-31(4), createAgent refusals
  const ca = (cfg) => { try { createAgent(cfg); return ''; } catch (e) { return e.message; } };
  const baseC = { host: 'codex', pluginRoot: PR, callsDir: CALLS, launch: fake, codex: { catalog: CATALOG, home: path.join(TMP, 'chome') } };
  ok('A1-31(4) createAgent refuses a task key with ":" or "#"', /key/.test(ca(Object.assign({}, baseC, { tasks: { 'a:b': TASKS.K } }))) && /key/.test(ca(Object.assign({}, baseC, { tasks: { 'a#b': TASKS.K } }))));
  // launch is optional since part A1b (the default is the real process of the host CLI); a launch that is given must be a function.
  ok('createAgent refuses an unknown host, a missing callsDir, a launch that is not a function; a missing launch is the real process', /host/.test(ca(Object.assign({}, baseC, { tasks: TASKS, host: 'gpt' })))
    && /callsDir/.test(ca(Object.assign({}, baseC, { tasks: TASKS, callsDir: undefined }))) && /launch/.test(ca(Object.assign({}, baseC, { tasks: TASKS, launch: 'x' })))
    && ca(Object.assign({}, baseC, { tasks: TASKS, launch: undefined })) === '');
  ok('createAgent accepts a valid config', ca(Object.assign({}, baseC, { tasks: TASKS })) === '');
  // Review 1: on codex the run home is required (owner decision 6, analysis 2.4): without it the child would run in the
  // parent's CODEX_HOME or the personal ~/.codex, even when the catalog comes from cfg.codex.catalog.
  const noHome = (home, env) => ca(Object.assign({}, baseC, { tasks: TASKS, env, codex: home === 'absent' ? { catalog: CATALOG } : { catalog: CATALOG, home } }));
  ok('codex.home: createAgent on codex refuses a config without codex.home (catalog given)', /codex\.home/.test(noHome('absent')), noHome('absent'));
  ok('codex.home: createAgent on codex refuses an empty or non-string codex.home', /codex\.home/.test(noHome('')) && /codex\.home/.test(noHome(7)) && /codex\.home/.test(noHome(null)));
  ok('codex.home: the parent\'s CODEX_HOME does not stand in for codex.home', /codex\.home/.test(noHome('absent', { CODEX_HOME: path.join(TMP, 'parent-home') })));
  ok('codex.home: createAgent on codex refuses a relative codex.home (the child runs with cwd = task dir)', /codex\.home/.test(noHome('rel/home')));
  ok('codex.home: claude needs no codex.home', ca(Object.assign({}, baseC, { tasks: TASKS, host: 'claude', codex: undefined })) === '');
  {
    const HX = path.join(TMP, 'chome-x');
    const XE = createAgent(Object.assign({}, baseC, { tasks: TASKS, log: () => {}, env: { CODEX_HOME: path.join(TMP, 'parent-home'), PATH: '/bin' }, codex: { catalog: CATALOG, home: HX } }));
    answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)) };
    const re = await call(XE, 'review:K#1');
    ok('codex.home: the child\'s CODEX_HOME is codex.home, never the parent\'s', re.plan && re.plan.env.CODEX_HOME === HX, re.plan && re.plan.env.CODEX_HOME);
  }

  // ---- A1-29 check on fake CLIs (no model): codex --version, login status (by rc), debug models, effort of the model
  const BIN = path.join(TMP, 'bin'); fs.mkdirSync(BIN);
  const fakeJs = path.join(BIN, 'fake-codex.js');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const a = process.argv.slice(2).join(' '); const S = JSON.parse(process.env.FAKE || '{}');
if (S.trace) fs.appendFileSync(S.trace, JSON.stringify({ a, home: process.env.CODEX_HOME || null, key: process.env.CODEX_API_KEY || null, okey: process.env.OPENAI_API_KEY || null }) + '\\n');
if (a === '--version' && process.env.FAKE_HOST === 'claude') { console.log('2.1.318 (Claude Code)'); process.exit(0); }
if (a === '--version') { console.log(S.version || 'codex-cli 0.166.0'); process.exit(0); }
if (a === 'login status') { if (S.loggedOut) { console.error('Not logged in'); process.exit(1); } console.log('Logged in using ChatGPT'); process.exit(0); }
if (a === 'debug models') { process.stdout.write(fs.readFileSync(S.models, 'utf8')); process.exit(0); }
console.error('unexpected ' + a); process.exit(9);\n`);
  const sh = (name, body) => { const f = path.join(BIN, name); fs.writeFileSync(f, body); fs.chmodSync(f, 0o755); return f; };
  const codexBin = sh('codex', `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  const claudeBin = sh('claude', `#!/bin/sh\nFAKE_HOST=claude exec "${process.execPath}" "${fakeJs}" "$@"\n`);
  const HOME = path.join(TMP, 'run-home'); fs.mkdirSync(HOME);
  const trace = path.join(TMP, 'trace.jsonl');
  const check = (args, fake, env = {}) => {
    const p = spawnSync(process.execPath, [SCRIPT, 'check', ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { FAKE: JSON.stringify(Object.assign({ models: path.join(FIX, 'codex-models.json'), trace }, fake)) }, env) });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* none */ }
    return { rc: p.status, j, out: p.stdout + p.stderr };
  };
  const cx = ['--host', 'codex', '--bin', codexBin, '--home', HOME];
  let c = check(cx, {}, { OPENAI_API_KEY: 'sk-parent', CODEX_API_KEY: 'sk-parent2' });
  ok('A1-29 check codex: all in order -> exit 0, ok true, the version and the kind of the binary', c.rc === 0 && c.j && c.j.ok === true && /0\.166\.0/.test(c.j.version) && c.j.binKind === 'executable', c.out);
  const tr = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('A1-29 check codex: every command runs with CODEX_HOME of the run home; chatgpt mode drops the parent\'s key variables',
    tr.length >= 3 && tr.every((x) => x.home === HOME && x.key === null && x.okey === null), JSON.stringify(tr));
  ok('A1-29 check codex: the catalog is cached in the run home, and an adapter without cfg.codex.catalog reads it',
    fs.existsSync(path.join(HOME, 'codis-agents-models.json')));
  answer = { rc: 0, output: JSON.stringify(sample(ST.REVIEW_SCHEMA, true)) };
  r = await call(mk('codex', { codex: { catalog: undefined, home: HOME } }), 'review:K#1');
  ok('A1-29 the adapter reads the catalog that check cached', argOf(r.plan, '-m') === 'gpt-6-astra' && r.res && r.res.verdict === 'done', JSON.stringify(r.res));
  c = check(cx, { version: 'codex-cli 0.150.0' });
  ok('A1-29 check codex: a version outside the list -> red with the reason', c.rc === 1 && c.j && c.j.ok === false && c.j.problems.some((p) => /version/.test(p)), c.out);
  c = check(cx, { loggedOut: true });
  ok('A1-29 check codex: login status rc 1 -> red, the login command for this home in the reason', c.rc === 1 && c.j && c.j.problems.some((p) => /login/.test(p) && p.includes(HOME)), c.out);
  c = check(cx.concat(['--model', 'gpt-9']), {});
  ok('A1-29 check codex: the model of the table is not in the catalog -> red', c.rc === 1 && c.j && c.j.problems.some((p) => /gpt-9/.test(p)), c.out);
  c = check(cx.concat(['--model', 'gpt-6-luna', '--effort', 'ultra']), {});
  ok('A1-29 check codex: the default effort is not supported by the model -> red', c.rc === 1 && c.j && c.j.problems.some((p) => /ultra/.test(p)), c.out);
  c = check(cx.concat(['--versions', '0.150.0,0.166.0']), {});
  ok('A1-29 check codex: --versions widens the list', c.rc === 0 && c.j && c.j.ok, c.out);
  // key file mode: 600 -> the key goes only to the child; 644 or empty -> red; login status is not asked
  const KEY = path.join(TMP, 'openai.key'); fs.writeFileSync(KEY, 'sk-test-123\n'); fs.chmodSync(KEY, 0o600);
  fs.writeFileSync(trace, '');
  c = check(cx.concat(['--auth', 'apiKeyFile', '--key-file', KEY]), {});
  const tr2 = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('A1-29 check codex apiKeyFile 600: green, the key only in CODEX_API_KEY of the child, never in the output',
    c.rc === 0 && c.j && c.j.ok && tr2.some((x) => x.a === 'debug models' && x.key === 'sk-test-123') && !c.out.includes('sk-test-123') && !tr2.some((x) => x.a === 'login status'), c.out);
  fs.chmodSync(KEY, 0o644);
  c = check(cx.concat(['--auth', 'apiKeyFile', '--key-file', KEY]), {});
  ok('A1-29 check codex apiKeyFile 644 -> red', c.rc === 1 && c.j && c.j.problems.some((p) => /600/.test(p)), c.out);
  fs.writeFileSync(KEY, ''); fs.chmodSync(KEY, 0o600);
  c = check(cx.concat(['--auth', 'apiKeyFile', '--key-file', KEY]), {});
  ok('A1-29 check codex apiKeyFile empty -> red', c.rc === 1 && c.j && c.j.problems.some((p) => /empty/.test(p)), c.out);
  // the kind of the binary (G5 to A1-29): a Node wrapper needs process.execve in its Node, or SIGKILL kills only the wrapper
  const nodeWrap = sh('codex-wrap', `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeJs)});\n`);
  const FAKENODE = path.join(TMP, 'fakenode'); fs.mkdirSync(FAKENODE);
  const realNodeDir = path.dirname(process.execPath);
  fs.writeFileSync(path.join(FAKENODE, 'node'), `#!/bin/sh\nif [ "$1" = "-e" ] && [ -n "$NO_EXECVE" ]; then exit 1; fi\nexec "${process.execPath}" "$@"\n`); fs.chmodSync(path.join(FAKENODE, 'node'), 0o755);
  const PATHN = FAKENODE + path.delimiter + realNodeDir + path.delimiter + process.env.PATH;
  c = check(['--host', 'codex', '--bin', nodeWrap, '--home', HOME], {}, { PATH: PATHN });
  ok('A1-29 check codex: a Node wrapper whose Node has process.execve -> green, binKind node-wrapper', c.rc === 0 && c.j && c.j.binKind === 'node-wrapper', c.out);
  c = check(['--host', 'codex', '--bin', nodeWrap, '--home', HOME], {}, { PATH: PATHN, NO_EXECVE: '1' });
  ok('A1-29 check codex: a Node wrapper without process.execve -> red with the advice to name the native binary', c.rc === 1 && c.j && c.j.problems.some((p) => /execve/.test(p) && /native/.test(p)), c.out);
  c = check(['--host', 'codex', '--bin', path.join(BIN, 'nope'), '--home', HOME], {});
  ok('A1-29 check codex: a missing binary -> red, no exception', c.rc === 1 && c.j && c.j.ok === false, c.out);
  // claude: --version and the role files in the plugin root
  c = check(['--host', 'claude', '--bin', claudeBin, '--plugin-root', ROOT], {});
  ok('A1-29 check claude: version and agents/<role>.md of the plugin root -> green', c.rc === 0 && c.j && c.j.ok === true && /2\.1\.318/.test(c.j.version), c.out);
  c = check(['--host', 'claude', '--bin', claudeBin, '--plugin-root', PR2], {});
  ok('A1-29 check claude: a role file missing in the plugin root -> red', c.rc === 1 && c.j && c.j.problems.some((p) => /reviewer\.md/.test(p)), c.out);
  c = check(['--host', 'gpt'], {});
  ok('A1-29 check: an unknown host -> exit 2', c.rc === 2, c.out);
  ok('A1-29 check calls no model (no exec, no -p with a prompt)', !fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).some((l) => /"a":"(exec|-p)/.test(l)));

  done();
})().catch((e) => { ok('no exception in the test', false, e.stack); done(); });
