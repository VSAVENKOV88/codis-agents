#!/usr/bin/env node
'use strict';
// p-codex-B1-c: the service steps of workflows/role-chain.js under the conductor (scripts/chain-run.js), its
// preconditions, the check of the hook before a codex role, and the outcome of the adapter apart from the role's verdict.
// Cells of p-codex-B/analyst.md with the check of run 2 (G14-G17, G20, G21):
//   E1  with the global exec every service step goes through exec(step), none through agent();
//   E3  the command line of the Workflow prompt of a step is its argv, word for word by shell splitting (G14);
//   G20 every step declares its class of effect: sha, diff, merge, env none; left, post idempotent; run reuse;
//   E4  a step whose command prints no JSON (or JSON off its schema) gets the step's own noJson object with the error;
//       the run step starts wait-step.js once and waits with wait-step.js wait until done; a text step (sha);
//   E4r the real role-diff-check.js and role-post-check.js on their error paths answer inside their step schema, so the
//       stop text names their own cause;
//   E7  the conductor runs env-check.js before pre (paths, floors) and the pre prompt carries its result with the time
//       of the check and its scope (the host, not the role's sandbox); pre runs no env-check itself (G21: a fake exec);
//   E8  env-check exit 1 - its problems go to pre; env-check that prints no JSON - the task stops before pre;
//   E10 (G15) exec steps write start and end lines into the conductor's log, and status names an open step;
//   A2/A3 the outcome of the adapter in the result field adapter, the cause known or "unknown", never environment;
//   A5  the record reaches the conductor when calls.jsonl cannot be written;
//   A12 pre on codex under preconditionsByConductor; A13 prog/test stay refused, A13' with no hook check;
//   A7-A10, A7p, G17 the hook check before each codex role: its home, cwd and binary, 0 runs the role, 1 untrusted,
//       3 not checked (unknown), 2 refused; two roles at once on one home - two checks, one after the other;
//   A11 no hook check on the claude host.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = require('../scripts/chain-run.js');
const RE = require('../scripts/role-exec.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-steps-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });
const FAKE_CODEX = path.join(__dirname, 'fixtures', 'chain-run', 'bin', 'codex');

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const SHA = 'abcd1234'.padEnd(40, '0');
const SHA2 = 'ef01'.padEnd(40, '9');
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: 'T', summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const ENV_OK = { ok: true, problems: [], notes: ['swap 8000 MB'] };
const POST = { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
const EFFECT = { sha: 'none', diff: 'none', merge: 'none', env: 'none', left: 'idempotent', post: 'idempotent', run: 'reuse' };

let nRun = 0;
// One chain in process: answers {pre: [..], prog: [..], ...} by the kind of the label for the roles (fake launch), and
// steps {env, diff, left, post, sha, merge, run: value or (step) => value} for exec. Returns what both saw.
async function chain(answers, steps, taskExtra, cfgExtra) {
  const base = path.join(W, `c${++nRun}`);
  const config = Object.assign({ sharedDir: path.join(base, 's'), worktreeRoot: path.join(base, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] }, cfgExtra || {});
  const task = Object.assign({ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, taskExtra || {});
  const q = {}; for (const [k, v] of Object.entries(answers)) q[k] = v.slice();
  const launches = [], seen = [], notes = [];
  const launch = async (plan) => {
    launches.push(plan);
    const kind = plan.label.split(':')[0];
    const list = q[kind] || [];
    return list.length ? { output: list.shift() } : { outcome: 'crashed', error: `no answer for ${plan.label}` };
  };
  const exec = async (step) => {
    seen.push(step);
    const a = steps && Object.prototype.hasOwnProperty.call(steps, step.kind) ? steps[step.kind] : undefined;
    const v = typeof a === 'function' ? a(step) : a;
    return v && v.$error ? { error: v.$error } : { value: v === undefined ? null : v };
  };
  const x = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [task] }, launch, exec, note: (m) => notes.push(m), log: () => {} });
  return { r: x.results[0], threw: x.threw, launches, steps: seen, notes, dir: path.join(config.sharedDir, task.key), config };
}

// Shell words of a command line as sh splits them: bare words, '...' (no escapes inside) and \x outside quotes.
function words(line) {
  const out = []; let cur = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) return null; cur = (cur || '') + line.slice(i + 1, j); i = j; }
    else if (c === '\\') { cur = (cur || '') + line[++i]; }
    else if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; }
    else cur = (cur || '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
// The line of the prompt whose shell words are argv (a "1. Run once: " / "2. Run: " prefix aside).
const lineOf = (prompt, argv) => prompt.split('\n').map((l) => l.replace(/^\d\. Run(?: once)?: /, '').replace(/^\s+\(.*$/, '')).find((l) => same(words(l), argv));

(async () => {
  // ---- E1, E7, G20, E3: a green chain on claude with exec
  let x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] }, { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } });
  ok('E1 a green chain under the conductor with exec: done', x.r && x.r.status === 'done', JSON.stringify(x.r));
  ok('E1 only the roles reach the adapter; every service step goes through exec', x.launches.map((p) => p.label.split(':')[0]).join('>') === 'pre>prog>test>review'
    && x.steps.map((s) => s.kind).join('>') === 'env>post>diff>left', x.launches.map((p) => p.label).join('>') + ' | ' + x.steps.map((s) => s.label).join('>'));
  const env = x.steps[0];
  const cdir = x.dir, cwt = path.join(x.config.worktreeRoot, 'w');
  ok('E7 the env step: env-check.js on the worktree and the task folder, the worktree check and the default floors, before pre',
    env && env.kind === 'env' && same(env.argv, ['node', '/p/scripts/env-check.js', '--path', cwt, '--path', cdir, '--worktree', cwt, '--min-disk-gb', '10', '--min-swap-mb', '4000']),
    JSON.stringify(env && env.argv));
  const preP = (x.launches[0] || {}).stdin || '';
  ok('E7 the pre prompt carries the result of the conductor\'s check: problems, notes, the time of the check, its scope and the sandbox caveat',
    /checkedAt/.test(preP) && /"swap 8000 MB"/.test(preP) && /outside the sandbox of the role/.test(preP) && /does not mean/.test(preP) && /\d{4}-\d\d-\d\dT\d\d:\d\d/.test(preP), preP.slice(-1200));
  ok('E7 pre runs no env-check itself', !/run node \S*env-check\.js/.test(preP), preP.slice(-800));

  // ---- the train path: sha, selection, train, merge-only
  const runAns = { 'select-1': { done: true, rc: 0, seconds: 1, log: '/l1' }, 'train-1': { done: true, rc: 13, seconds: 1, log: '/l2' }, 'train-2': { done: true, rc: 0, seconds: 1, log: '/l3' } };
  x = await chain({ pre: [PRE], prog: [Object.assign({}, PROG, { head: 'abcd1234' }), Object.assign({}, PROG, { head: SHA2, changedFiles: ['docs/a.md'] })], test: [GREEN], review: [DONE, DONE] },
    { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] }, sha: { sha: SHA },
      merge: { mergeOnly: true, reason: 'docs', files: ['docs/a.md'] }, run: (s) => runAns[s.label.split(':')[2]] },
    { base: 'arc' }, { guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}', mergeOnlyFiles: ['docs/**'] });
  const kinds = [...new Set(x.steps.map((s) => s.kind))].sort();
  ok('G20 the train path runs every kind of step through exec (env, sha, run, post, diff, merge, left), the task done',
    x.r && x.r.status === 'done' && kinds.join(',') === 'diff,env,left,merge,post,run,sha', kinds.join(',') + ' ' + JSON.stringify(x.r && x.r.why));
  const badFx = x.steps.filter((s) => EFFECT[s.kind] === undefined || s.effect !== EFFECT[s.kind] || s.label.split(':')[0] !== s.kind);
  ok('G20 every step declares its class of effect by its kind: sha, diff, merge, env none; left, post idempotent; run reuse', x.steps.length >= 8 && !badFx.length,
    badFx.map((s) => `${s.label} ${s.effect}`).join(' '));
  const noForm = x.steps.filter((s) => !Array.isArray(s.argv) || !s.argv.every((a) => typeof a === 'string') || !s.schema || !s.noJson);
  ok('E3 every step is data: argv of strings, the schema of its answer, its noJson object', x.steps.length >= 8 && !noForm.length, noForm.map((s) => s.label).join(' '));
  const unmatched = x.steps.filter((s) => s.agent && !(lineOf(s.agent.prompt, s.argv) && (!s.wait || lineOf(s.agent.prompt, s.wait.argv))));
  ok('E3 the Workflow prompt of each step names exactly its argv (and the wait command of a run step), word for word', x.steps.filter((s) => s.agent).length >= 6 && !unmatched.length,
    unmatched.map((s) => `${s.label}: ${JSON.stringify(s.argv)}\n${s.agent.prompt}`).join('\n---\n').slice(0, 3000));
  const rs = x.steps.find((s) => s.kind === 'run');
  ok('E5 the run step: wait-step.js start with its id and the command, then wait-step.js wait --max 270 on the same id',
    rs && rs.argv[1] === '/p/scripts/wait-step.js' && rs.argv[2] === 'start' && rs.argv.includes('--id') && rs.wait && same(rs.wait.argv.slice(1, 5), ['/p/scripts/wait-step.js', 'wait', '--id', rs.argv[rs.argv.indexOf('--id') + 1]])
      && rs.wait.argv.slice(-2).join(' ') === '--max 270', JSON.stringify(rs && [rs.argv, rs.wait]));

  // ---- E8: env-check fails / reports problems
  x = await chain({ pre: [PRE] }, { env: { $error: 'usage: env-check.js --path <dir>' } });
  ok('E8 env-check that prints no JSON: the task stops before pre with the error, no role', x.r && x.r.status === 'stopped' && /environment check/.test(x.r.why)
    && /usage: env-check\.js/.test(JSON.stringify(x.r)) && !x.launches.length, JSON.stringify(x.r));
  x = await chain({ pre: [{ ok: false, problems: ['disk /w: 2 GB free, below 10 GB'], blockingQuestions: [] }] }, { env: { ok: false, problems: ['disk /w: 2 GB free, below 10 GB'], notes: [] } });
  ok('E8 env-check exit 1: its problems reach pre, which stops the task (preconditions)', x.r && x.r.status === 'stopped' && x.r.why === 'preconditions'
    && /2 GB free/.test((x.launches[0] || {}).stdin || '') && x.launches.length === 1, JSON.stringify(x.r));

  // ---- E4: execStep with real commands
  const notes = [];
  const DIFF_S = { type: 'object', properties: { ok: { type: 'boolean' }, offending: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } }, required: ['ok', 'offending'] };
  const node = (code) => [process.execPath, '-e', code];
  const step = (o) => Object.assign({ kind: 'diff', label: 'diff:x:tester', phase: 'Tester', effect: 'none', schema: DIFF_S, noJson: { ok: false, offending: [], error: '$error' } }, o);
  let v = await CR.execStep(step({ argv: node('process.stdout.write("not json"); process.stderr.write("boom"); process.exit(2)') }), { note: (m) => notes.push(m) });
  ok('E4 a command without JSON: the noJson object of the step with the error (exit code, stderr)', v && v.ok === false && Array.isArray(v.offending) && /exit 2/.test(v.error) && /boom/.test(v.error), JSON.stringify(v));
  v = await CR.execStep(step({ argv: node('console.log(JSON.stringify({ok: "yes"}))') }), { note: (m) => notes.push(m) });
  ok('E4 JSON off the schema of the step: noJson with the schema errors', v && v.ok === false && /schema/.test(v.error), JSON.stringify(v));
  v = await CR.execStep(step({ argv: node('console.log(JSON.stringify({ok: false, nested: {error: "deep cause"}, error: "own cause"})); process.exit(1)') }), {});
  ok('E4 JSON off the schema that carries its own error texts: noJson keeps them next to the schema errors', v && v.ok === false && /schema/.test(v.error) && /own cause/.test(v.error) && /deep cause/.test(v.error), JSON.stringify(v));
  v = await CR.execStep(step({ argv: node('console.log(JSON.stringify({ok: false, offending: ["a.js"]})); process.exit(1)') }), { note: (m) => notes.push(m) });
  ok('E4 JSON on a non-zero exit is the answer (the scripts print JSON with exit 1)', v && v.ok === false && v.offending[0] === 'a.js' && v.error === undefined, JSON.stringify(v));
  v = await CR.execStep(step({ kind: 'sha', label: 'sha:x:programmer', schema: { type: 'object', properties: { sha: { type: 'string' }, error: { type: 'string' } }, required: ['sha'] },
    noJson: { sha: '', error: '$error' }, stdoutField: 'sha', argv: node('console.log("' + SHA + '")') }), {});
  ok('E4 a text step: the printed line is the field', v && v.sha === SHA, JSON.stringify(v));
  v = await CR.execStep(step({ kind: 'sha', label: 'sha:x:programmer', schema: { type: 'object', properties: { sha: { type: 'string' }, error: { type: 'string' } }, required: ['sha'] },
    noJson: { sha: '', error: '$error' }, stdoutField: 'sha', argv: node('process.exit(1)') }), {});
  ok('E4 a text step that prints nothing: sha empty with the error', v && v.sha === '' && /exit 1/.test(v.error), JSON.stringify(v));
  v = await CR.execStep(step({ kind: 'env', label: 'env:x', stampAt: 'checkedAt', argv: node('console.log(JSON.stringify({ok: true, offending: []}))') }), {});
  ok('E7 stampAt: the conductor stamps the time the command ended', v && /^\d{4}-\d\d-\d\dT/.test(v.checkedAt || ''), JSON.stringify(v));
  ok('E10 execStep writes the start and the end of a step into the conductor\'s lines', notes.some((m) => /^exec diff:x:tester started$/.test(m)) && notes.some((m) => /^exec diff:x:tester no-json [\d.]+ s$/.test(m))
    && notes.some((m) => /^exec diff:x:tester ok [\d.]+ s$/.test(m)), notes.join(' | '));
  const WS = path.join(ROOT, 'scripts', 'wait-step.js');
  const id = path.join(W, 'wait-run-1');
  const RUN_S = { type: 'object', properties: { done: { type: 'boolean' }, rc: { type: ['number', 'null'] }, log: { type: 'string' } }, required: ['done', 'rc', 'log'] };
  v = await CR.execStep({ kind: 'run', label: 'run:x:select-1', effect: 'reuse', schema: RUN_S, noJson: { done: false, rc: null, log: `${id}.log`, error: '$error' },
    argv: [process.execPath, WS, 'start', '--id', id, '--cwd', W, '--', 'sleep 1; echo hi; exit 3'], wait: { argv: [process.execPath, WS, 'wait', '--id', id, '--max', '0'] } }, {});
  ok('E5 a run step through exec: started once, waited in slices until done, the exit code of the command', v && v.done === true && v.rc === 3 && /hi/.test(fs.readFileSync(`${id}.log`, 'utf8')), JSON.stringify(v));
  v = await CR.execStep({ kind: 'run', label: 'run:x:select-2', effect: 'reuse', schema: RUN_S, noJson: { done: false, rc: null, log: '/nowhere.log', error: '$error' },
    argv: [process.execPath, WS, 'start', '--id', path.join(W, 'wait-run-2')], wait: { argv: [process.execPath, WS, 'wait', '--id', path.join(W, 'wait-run-2'), '--max', '1'] } }, {});
  ok('E4 a run step whose start prints no JSON: noJson, no wait', v && v.done === false && v.rc === null && /exit 64/.test(v.error) && /no command/.test(v.error), JSON.stringify(v));

  // ---- E10: status names an open exec step
  const rd = path.join(W, 'run-e10');
  fs.mkdirSync(rd);
  fs.writeFileSync(path.join(rd, 'log.txt'), ['2026-11-06T10:00:00.000Z agent review:x#1 started', '2026-11-06T10:00:05.000Z agent review:x#1 ok 5.0 s',
    '2026-11-06T10:00:06.000Z exec run:x:train-1 started', ''].join('\n'));
  const ls = CR.logState(rd);
  ok('E10 status: an exec step that started and did not end is open, with its start', ls.open.x && ls.open.x['run:x:train-1'] === '2026-11-06T10:00:06.000Z' && /review:x#1 ok/.test(ls.last.x || ''), JSON.stringify(ls));

  // ---- A2, A3: the outcome of the adapter apart from the verdict
  const KNOWN = ['rate-limited', 'auth', 'schema-refused', 'ceiling', 'signalled'];
  const UNKNOWN = ['crashed', 'killed', 'no-result', 'invalid-result'];
  for (const oc of KNOWN.concat(UNKNOWN)) {
    const base = path.join(W, `a-${oc}`);
    const config = { sharedDir: path.join(base, 's'), worktreeRoot: path.join(base, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] };
    const y = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [{ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'a', kind: 'tail', noAnalysis: 'n' }] },
      launch: async (p) => (p.label.startsWith('pre:') ? { output: PRE } : { outcome: oc, error: `observed ${oc}`, rc: oc === 'killed' ? null : 1, signal: oc === 'killed' ? 'SIGKILL' : null }),
      exec: async (s) => ({ value: s.kind === 'env' ? ENV_OK : s.kind === 'left' ? { ok: true, found: [], removed: [], remaining: [] } : null }), note: () => {}, log: () => {} });
    const r = y.results[0];
    const a = (r && r.adapter) || [];
    const want = KNOWN.includes(oc) ? oc : 'unknown';
    ok(`A${KNOWN.includes(oc) ? 2 : 3} adapter outcome ${oc}: the result keeps the script's why, adapter names the call with cause ${want}, no environment field`,
      r && r.status === 'stopped' && /programmer returned no result/.test(r.why) && a.length === 1 && a[0].label === 'prog:x#1' && a[0].outcome === oc && a[0].cause === want
        && a[0].error === `observed ${oc}` && typeof a[0].callDir === 'string' && fs.existsSync(a[0].callDir) && ('rc' in a[0]) && ('signal' in a[0]) && r.environment === undefined, JSON.stringify(r));
    if (!KNOWN.includes(oc)) ok(`A3 ${oc}: the observed diagnostics - the path of stderr.log of the call`, a[0] && a[0].stderr === path.join(a[0].callDir, 'stderr.log'), JSON.stringify(a[0]));
  }
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] }, { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } });
  ok('A1 a chain whose calls all ended ok has no adapter field', x.r && x.r.status === 'done' && x.r.adapter === undefined, JSON.stringify(x.r));

  // ---- A5: calls.jsonl cannot be written (a folder in its place) - the record still reaches the conductor
  {
    const base = path.join(W, 'a5');
    const config = { sharedDir: path.join(base, 's'), worktreeRoot: path.join(base, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] };
    fs.mkdirSync(path.join(config.sharedDir, 'x', 'calls.jsonl'), { recursive: true });
    const nn = [];
    const y = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [{ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'a', kind: 'tail', noAnalysis: 'n' }] },
      launch: async (p) => (p.label.startsWith('pre:') ? { output: PRE } : { outcome: 'auth', error: 'log in' }),
      exec: async (s) => ({ value: s.kind === 'env' ? ENV_OK : { ok: true, found: [], removed: [], remaining: [] } }), note: (m) => nn.push(m), log: () => {} });
    const r = y.results[0];
    ok('A5 calls.jsonl refused: the adapter field is filled from the record all the same, the log names the lost line',
      r && r.adapter && r.adapter.length === 1 && r.adapter[0].outcome === 'auth' && r.adapter[0].cause === 'auth' && nn.some((m) => /could not be written/.test(m)), JSON.stringify(r) + ' ' + nn.join(' | '));
  }

  // ---- A12, A13: pre on codex under the conductor's flag; prog and test without cfg.commit are refused
  const home = path.join(W, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, RE.CATALOG_FILE), JSON.stringify({ models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: ['high'] }] }));
  const PRE_S = { type: 'object', properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } }, blockingQuestions: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'problems', 'blockingQuestions'] };
  const tdir = path.join(W, 'tdir');
  fs.mkdirSync(tdir);
  const mk = (extra) => {
    const calls = [], recs = [];
    const ag = RE.createAgent(Object.assign({ host: 'codex', tasks: { x: { dir: tdir, wt: tdir } }, pluginRoot: ROOT, callsDir: tdir, codex: { home, bin: FAKE_CODEX },
      launch: async (p) => { calls.push(p.label); return { output: JSON.stringify(PRE), rc: 0 }; }, onRecord: (r) => recs.push(r), log: () => {} }, extra || {}));
    return { ag, calls, recs };
  };
  let m = mk();
  let rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A12 pre on codex without preconditionsByConductor: refused as before, no launch', rv === null && !m.calls.length && m.recs[0] && m.recs[0].outcome === 'refused', JSON.stringify(m.recs));
  m = mk({ preconditionsByConductor: true });
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A12 pre on codex with preconditionsByConductor: it runs', rv && rv.ok === true && m.calls.join() === 'pre:x', JSON.stringify(m.recs));
  rv = await m.ag('prog', { label: 'prog:x#1', schema: PRE_S, agentType: 'general-purpose' });
  ok('A13 prog on codex without cfg.commit is refused under the flag: it needs the commit channel', rv === null && m.calls.length === 1 && /the programmer on codex needs the commit channel \(cfg\.commit\)/.test((m.recs[1] || {}).error || ''), JSON.stringify(m.recs[1]));

  // ---- A7-A10, A13', A7p, G17: the hook check before each codex role
  const fdir = path.join(W, 'fake-trace');
  fs.mkdirSync(fdir);
  process.env.FAKE_CLI_DIR = fdir;
  const hooksSeen = () => { try { return fs.readFileSync(path.join(fdir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => /^hooks/.test(e.ev)); } catch { return []; } };
  const withHome = (name, sc) => { const h = path.join(W, name); fs.mkdirSync(h); fs.copyFileSync(path.join(home, RE.CATALOG_FILE), path.join(h, RE.CATALOG_FILE)); if (sc) fs.writeFileSync(path.join(h, 'fake-hooks.json'), JSON.stringify(sc)); return h; };
  const gated = (h, gateExtra) => mk({ preconditionsByConductor: true, codex: { home: h, bin: FAKE_CODEX }, beforeLaunch: CR.hookGate(Object.assign({ home: h, bin: FAKE_CODEX, note: () => {} }, gateExtra || {})) });
  let h = withHome('h-trusted', { trust: 'trusted' });
  m = gated(h);
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  let hs = hooksSeen().filter((e) => e.ev === 'hooks');
  ok('A7 hook trusted (exit 0): the role runs', rv && rv.ok === true && m.calls.join() === 'pre:x' && m.recs[0].outcome === 'ok', JSON.stringify(m.recs));
  ok('G17 the check asks the run home, the task folder as cwd and the codex binary of the config', hs.length === 1 && hs[0].home === fs.realpathSync(h) && hs[0].cwd === tdir, JSON.stringify(hs));
  rv = await m.ag('prog', { label: 'prog:x#1', schema: PRE_S, agentType: 'general-purpose' });
  ok("A13' a kind the adapter refuses statically gets no hook check: refused, no app-server", rv === null && m.recs[1].outcome === 'refused' && hooksSeen().filter((e) => e.ev === 'hooks').length === 1, JSON.stringify(m.recs[1]));
  h = withHome('h-untrusted', { trust: 'untrusted' });
  m = gated(h);
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A8 hook untrusted (exit 1): the role is not started, outcome hook-untrusted with the text of the check and the way to trust it',
    rv === null && !m.calls.length && m.recs[0] && m.recs[0].outcome === 'hook-untrusted' && /\/hooks/.test(m.recs[0].error) && m.recs[0].error.includes(fs.realpathSync(h)), JSON.stringify(m.recs));
  h = withHome('h-disabled', { trust: 'trusted', enabled: false });
  m = gated(h);
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A8 hook disabled (exit 1): not started, hook-untrusted', rv === null && !m.calls.length && m.recs[0].outcome === 'hook-untrusted', JSON.stringify(m.recs));
  h = withHome('h-exit', { mode: 'exit' });
  m = gated(h);
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A9 not checked (exit 3: the app-server exits before its answer): not started, outcome hook-unverified', rv === null && !m.calls.length && m.recs[0].outcome === 'hook-unverified' && /not checked/.test(m.recs[0].error), JSON.stringify(m.recs));
  const two = path.join(W, 'exit2.js');
  fs.writeFileSync(two, "console.error('codex-hooks-check: --codex-home is the personal ~/.codex'); process.exit(2);\n");
  h = withHome('h-two', { trust: 'trusted' });
  m = gated(h, { script: two });
  rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('A10 the check refuses (exit 2): not started, outcome refused with its text', rv === null && !m.calls.length && m.recs[0].outcome === 'refused' && /personal/.test(m.recs[0].error), JSON.stringify(m.recs));
  // A7p: the review and the security review at once on one home - two checks, one after the other.
  h = withHome('h-par', { trust: 'trusted', delayMs: 400 });
  m = gated(h);
  const n0 = hooksSeen().length;
  const RV_S = { type: 'object', properties: { verdict: { type: 'string' }, docsOnly: { type: 'boolean' }, summary: { type: 'string' } }, required: ['verdict', 'docsOnly', 'summary'] };
  await Promise.all([m.ag('r', { label: 'review:x#1', schema: RV_S, agentType: 'general-purpose' }), m.ag('s', { label: 'sec:x#1', schema: RV_S, agentType: 'general-purpose' })]);
  const par = hooksSeen().slice(n0);
  const evs = par.map((e) => e.ev).join(',');
  ok('A7p two codex roles at once on one home: two checks, the second starts after the first ended, both roles ran',
    evs === 'hooks,hooks-end,hooks,hooks-end' && par[2].ms >= par[1].ms && m.calls.sort().join() === 'review:x#1,sec:x#1', evs + ' ' + m.calls.join());

  // ---- A11: no check on claude; the codex config of the conductor carries the gate and the flag
  const args = { config: { sharedDir: path.join(W, 'a11') }, tasks: [{ key: 'x', wt: '/w' }] };
  const cc = CR.adapterCfg('claude', args, {}, W, () => {});
  const cx = CR.adapterCfg('codex', args, { codexHome: home }, W, () => {});
  ok('A11 claude: no hook check, no preconditions flag; codex: the gate before each launch and preconditionsByConductor',
    cc.beforeLaunch === undefined && !cc.preconditionsByConductor && typeof cx.beforeLaunch === 'function' && cx.preconditionsByConductor === true, JSON.stringify(Object.keys(cx)));

  // ---- E4r: the real role-diff-check.js and role-post-check.js on their error paths (the since of the role is not an
  // ancestor of HEAD) answer inside the schema of their step, so the stop text names their cause, as under Workflow.
  {
    const cp = require('child_process');
    const repo = path.join(W, 'e4r');
    fs.mkdirSync(repo);
    const g = (...a) => cp.execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const real = (step) => {
      const p = cp.spawnSync(step.argv[0], step.argv.slice(1), { encoding: 'utf8' });
      try { return JSON.parse(String(p.stdout).trim().split('\n').pop()); } catch { return { $error: `exit ${p.status}` }; }
    };
    const ghost = '8fee981'.padEnd(40, '0');
    let x = await chain({ pre: [PRE], prog: [Object.assign({}, PROG, { head: ghost })], test: [Object.assign({}, GREEN, { head: ghost })] },
      { env: ENV_OK, post: real, left: POST.left }, { wt: repo }, { scriptsDir: path.join(ROOT, 'scripts') });
    ok('E4r post: the real script\'s own error is the stop text, not a schema refusal', x.r && x.r.status === 'stopped'
      && x.r.why === `the tester changed what the role may not: ${ghost} is not an ancestor of HEAD in ${repo}`, JSON.stringify(x.r && x.r.why));
    x = await chain({ pre: [PRE], prog: [PROG], test: [Object.assign({}, GREEN, { head: ghost })], review: [DONE] },
      { env: ENV_OK, post: POST, diff: real, left: POST.left }, { wt: repo }, { scriptsDir: path.join(ROOT, 'scripts') });
    ok('E4r diff: the reviewer\'s real diff step stops with its own cause', x.r && x.r.status === 'stopped'
      && x.r.why === `the reviewer changed what the role may not: ${ghost} is not an ancestor of HEAD in ${repo}`, JSON.stringify(x.r && x.r.why));
    for (const [what, a] of [['no --allow for the tester', ['--role', 'tester']], ['an unknown role', ['--role', 'nobody']], ['since not in the repo', ['--role', 'reviewer']], ['a --allow that is no regular expression (the check throws)', ['--role', 'tester', '--allow', '(']]]) {
      const p = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-diff-check.js'), '--wt', repo, '--since', ghost, ...a], { encoding: 'utf8' });
      let j; try { j = JSON.parse(p.stdout); } catch { j = null; }
      ok(`E4r role-diff-check.js with ${what}: ok false, offending [] and its error`, j && j.ok === false && Array.isArray(j.offending) && j.offending.length === 0 && typeof j.error === 'string', p.stdout);
    }
  }

  // ---- the tester cells (p-codex-B1-c): tests/chain-run-steps-tester-cases.js, a child with its own tally, so README
  // keeps counting test files
  {
    const tc = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'chain-run-steps-tester-cases.js')], { encoding: 'utf8', timeout: 120000 });
    ok('the tester cells of the steps (tests/chain-run-steps-tester-cases.js) pass', tc.status === 0, `${tc.status} ${tc.signal || ''}\n${(tc.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n')}${(tc.stderr || '').slice(-800)}`);
  }
  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
