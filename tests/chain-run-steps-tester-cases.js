'use strict';
// Tester cells of p-codex-B1-c (the service steps under the conductor, the hook check, the outcome of the adapter), run
// by tests/chain-run-steps.test.js as a child (its own tally and exit code), so README keeps counting test files. The
// cells the programmer's guards do not hold:
//   T1 the cause of the outcomes refused and hook-untrusted is known, of hook-unverified unknown (with the stderr path);
//   T2 the hook check answering anything but 0/1/2 (exit 7, killed by a signal, no run home) never launches the role;
//   T3 a beforeLaunch that throws ends the call as crashed, no process;
//   T4 the hook check runs before every codex role, also after a failed one (no answer is kept between calls);
//   T5 checkTwice through exec: a failed service step is repeated once as <label>#retry, the run step with --reuse;
//   T6 a run step whose exit code is the environment (77) stops the task as the environment through exec as well;
//   T7 the prompt of every step names its argv word for word when the paths hold a space and a single quote (sq);
//   T8 a step whose program cannot start: noJson with "cannot run" (no throw, no hang);
//   T9 what the leftovers step removed (through exec) is named in the task result;
//   T10 noJson of the post step: every "$error" in the nested diff and left objects gets the error text;
//   T11 the real role-leftovers-check.js on its error path (a worktree that is no absolute directory) answers inside
//       the schema of the left step, so the end of the task names its own cause, not a schema refusal;
//   T12 the real env-check.js on a path that does not exist answers inside the env schema: its problems reach pre and
//       the task does not stop before pre as "no JSON";
//   T13 an output off its schema keeps its own error texts found inside lists too, each text once, and only non-empty
//       strings under the key "error".
// No model is called; the roles are a fake launch, the steps a fake exec or real node processes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = require('../scripts/chain-run.js');
const RE = require('../scripts/role-exec.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-steps-t-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });
const FAKE_CODEX = path.join(__dirname, 'fixtures', 'chain-run', 'bin', 'codex');

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: 'T', summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const ENV_OK = { ok: true, problems: [], notes: [] };
const LEFT_OK = { ok: true, found: [], removed: [], remaining: [] };
const POST = { ok: true, diff: { ok: true, offending: [] }, left: LEFT_OK };
const TASK = { key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' };

let nRun = 0;
async function chain(answers, steps, taskExtra, cfgExtra, rootName) {
  const base = path.join(W, rootName || `c${++nRun}`);
  const config = Object.assign({ sharedDir: path.join(base, 's'), worktreeRoot: path.join(base, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] }, cfgExtra || {});
  const task = Object.assign({}, TASK, taskExtra || {});
  const q = {}; for (const [k, v] of Object.entries(answers)) q[k] = v.slice();
  const launches = [], seen = [];
  const launch = async (plan) => {
    launches.push(plan);
    const list = q[plan.label.split(':')[0]] || [];
    return list.length ? { output: list.shift() } : { outcome: 'crashed', error: `no answer for ${plan.label}` };
  };
  const exec = async (step) => {
    seen.push(step);
    const a = steps && Object.prototype.hasOwnProperty.call(steps, step.kind) ? steps[step.kind] : undefined;
    const v = typeof a === 'function' ? a(step, seen.filter((s) => s.kind === step.kind).length) : a;
    return v && v.$error ? { error: v.$error } : { value: v === undefined ? null : v };
  };
  const x = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [task] }, launch, exec, note: () => {}, log: () => {} });
  return { r: x.results[0], launches, steps: seen, config };
}
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
const lineOf = (prompt, argv) => prompt.split('\n').map((l) => l.replace(/^\d\. Run(?: once)?: /, '').replace(/^\s+\(.*$/, '')).find((l) => same(words(l), argv));

(async () => {
  // ---- T1: the cause of refused, hook-untrusted (known) and hook-unverified (unknown) in the result field adapter
  for (const [oc, want] of [['refused', 'refused'], ['hook-untrusted', 'hook-untrusted'], ['hook-unverified', 'unknown']]) {
    const config = { sharedDir: path.join(W, `t1-${oc}`, 's'), worktreeRoot: path.join(W, `t1-${oc}`, 'r'), scriptsDir: '/p/scripts', testerWritable: ['-run\\.js$'] };
    const y = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [Object.assign({}, TASK)] },
      launch: async (p) => (p.label.startsWith('pre:') ? { output: PRE } : { outcome: oc, error: `observed ${oc}` }),
      exec: async (s) => ({ value: s.kind === 'env' ? ENV_OK : s.kind === 'left' ? LEFT_OK : null }), note: () => {}, log: () => {} });
    const a = ((y.results[0] || {}).adapter || [])[0] || {};
    ok(`T1 outcome ${oc}: cause ${want}${want === 'unknown' ? ' with the path of stderr.log' : ', no stderr path'}, no environment field`,
      a.outcome === oc && a.cause === want && (want === 'unknown' ? a.stderr === path.join(a.callDir, 'stderr.log') : a.stderr === undefined) && y.results[0].environment === undefined,
      JSON.stringify(y.results[0]));
  }

  // ---- T2: hookGate answers other than 0/1/2 never let the role run
  const plan = { label: 'pre:x', cwd: W };
  const mkScript = (name, body) => { const f = path.join(W, name); fs.writeFileSync(f, body); return f; };
  let g = await CR.hookGate({ home: W, bin: FAKE_CODEX, script: mkScript('exit7.js', 'process.stdout.write("odd"); process.exit(7)'), note: () => {} })(plan);
  ok('T2 the check exits 7: hook-unverified (not a launch, not untrusted)', g && g.outcome === 'hook-unverified' && /exit 7/.test(g.error) && /odd/.test(g.error), JSON.stringify(g));
  g = await CR.hookGate({ home: W, bin: FAKE_CODEX, script: mkScript('kill.js', 'process.kill(process.pid, "SIGKILL")'), note: () => {} })(plan);
  ok('T2 the check killed by a signal: hook-unverified naming the signal', g && g.outcome === 'hook-unverified' && /SIGKILL/.test(g.error), JSON.stringify(g));
  g = await CR.hookGate({ home: undefined, bin: FAKE_CODEX, note: () => {} })(plan);
  ok('T2 a gate without a run home never answers "launch"', g !== null && g && g.outcome !== undefined, JSON.stringify(g));

  // ---- T3, T4 through the adapter on codex
  const home0 = path.join(W, 'home0');
  fs.mkdirSync(home0);
  fs.writeFileSync(path.join(home0, RE.CATALOG_FILE), JSON.stringify({ models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: ['high'] }] }));
  const PRE_S = { type: 'object', properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } }, blockingQuestions: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'problems', 'blockingQuestions'] };
  const tdir = path.join(W, 'tdir');
  fs.mkdirSync(tdir);
  const mk = (home, beforeLaunch) => {
    const calls = [], recs = [];
    const ag = RE.createAgent({ host: 'codex', tasks: { x: { dir: tdir, wt: tdir } }, pluginRoot: ROOT, callsDir: tdir, codex: { home, bin: FAKE_CODEX }, preconditionsByConductor: true,
      beforeLaunch, launch: async (p) => { calls.push(p.label); return { output: JSON.stringify(PRE), rc: 0 }; }, onRecord: (r) => recs.push(r), log: () => {} });
    return { ag, calls, recs };
  };
  let m = mk(home0, async () => { throw new Error('gate broke'); });
  let rv = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  ok('T3 beforeLaunch throws: the call ends crashed with the error, the role is not launched', rv === null && !m.calls.length && m.recs[0] && m.recs[0].outcome === 'crashed' && /gate broke/.test(m.recs[0].error), JSON.stringify(m.recs));
  const fdir = path.join(W, 'trace');
  fs.mkdirSync(fdir);
  process.env.FAKE_CLI_DIR = fdir;
  const hk = path.join(W, 'home-flip');
  fs.mkdirSync(hk);
  fs.copyFileSync(path.join(home0, RE.CATALOG_FILE), path.join(hk, RE.CATALOG_FILE));
  fs.writeFileSync(path.join(hk, 'fake-hooks.json'), JSON.stringify({ trust: 'untrusted' }));
  m = mk(hk, CR.hookGate({ home: hk, bin: FAKE_CODEX, note: () => {} }));
  const r1 = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  fs.writeFileSync(path.join(hk, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
  const r2 = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  fs.writeFileSync(path.join(hk, 'fake-hooks.json'), JSON.stringify({ trust: 'untrusted' }));
  const r3 = await m.ag('check', { label: 'pre:x', schema: PRE_S, agentType: 'general-purpose' });
  const nHooks = fs.readFileSync(path.join(fdir, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ev === 'hooks').length;
  ok('T4 a check before every codex role: untrusted -> not run, trusted -> run, untrusted again -> not run (three checks, nothing kept between calls)',
    r1 === null && r2 && r2.ok === true && r3 === null && m.calls.join() === 'pre:x' && nHooks === 3 && m.recs.map((r) => r.outcome).join() === 'hook-untrusted,ok,hook-untrusted',
    `${nHooks} ${JSON.stringify(m.recs.map((r) => r.outcome))}`);

  // ---- T5: checkTwice through exec
  let x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: POST, diff: (s, n) => (n === 1 ? { $error: 'exit 1: boom' } : { ok: true, offending: [] }), left: LEFT_OK });
  const dl = x.steps.filter((s) => s.kind === 'diff').map((s) => s.label);
  ok('T5 a service step that failed is repeated once through exec as <label>#retry; the second answer decides (done)',
    x.r && x.r.status === 'done' && dl.join() === 'diff:x:reviewer,diff:x:reviewer#retry', dl.join() + ' ' + JSON.stringify(x.r));
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: LEFT_OK, sha: { sha: 'a'.repeat(40) },
      run: (s, n) => (n === 1 ? { $error: 'no JSON' } : { done: true, rc: 0, seconds: 1, log: '/l' }) },
    { base: 'arc' }, { guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}' });
  const runs = x.steps.filter((s) => s.kind === 'run');
  ok('T5 the run step repeated after no JSON: the repeat starts wait-step with --reuse, the first without',
    runs.length >= 2 && !runs[0].argv.includes('--reuse') && runs[1].argv.includes('--reuse') && runs[1].label === `${runs[0].label}#retry`,
    JSON.stringify(runs.map((s) => [s.label, s.argv.slice(2, 8)])));

  // ---- T6: an environment exit code of the run step through exec
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: LEFT_OK, sha: { sha: 'a'.repeat(40) }, run: { done: true, rc: 77, seconds: 1, log: '/l77' } },
    { base: 'arc' }, { guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}' });
  ok('T6 the selection exits 77 through exec: the task stops as the environment (no tester), the reason named',
    x.r && x.r.status !== 'done' && /slot queue refused/.test(JSON.stringify(x.r)) && !x.launches.some((p) => p.label.startsWith('test:')), JSON.stringify(x.r));

  // ---- T7: a space and a single quote in the paths
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: LEFT_OK, sha: { sha: 'a'.repeat(40) }, run: { done: true, rc: 0, seconds: 1, log: '/l' } },
    { base: 'arc' }, { guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}', testerWritable: ["it's a (re)gex$"] }, "q d'ir");
  const bad = x.steps.filter((s) => s.agent && !(lineOf(s.agent.prompt, s.argv) && (!s.wait || lineOf(s.agent.prompt, s.wait.argv))));
  const quoted = x.steps.filter((s) => s.argv.some((a) => a.includes("q d'ir")));
  ok("T7 paths with a space and a single quote: every step's prompt line splits into exactly its argv",
    x.steps.length >= 6 && quoted.length >= 5 && !bad.length, bad.map((s) => `${s.label}: ${JSON.stringify(s.argv)}\n${s.agent.prompt}`).join('\n---\n').slice(0, 2500));
  const envP = ((x.launches.find((p) => p.label.startsWith('pre:')) || {}).stdin || '');
  const envStep = x.steps.find((s) => s.kind === 'env');
  ok('T7 the env command named in the pre prompt is the argv the conductor ran, word for word',
    envStep && envP.split('\n').some((l) => { const i = l.indexOf('the conductor ran '); if (i < 0) return false; const rest = l.slice(i + 18); const j = rest.indexOf(' before you'); return j > 0 && same(words(rest.slice(0, j)), envStep.argv); }),
    envP.slice(-1500));

  // ---- T8: a program that does not exist
  const DS = { type: 'object', properties: { ok: { type: 'boolean' }, offending: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } }, required: ['ok', 'offending'] };
  let v = await CR.execStep({ kind: 'diff', label: 'diff:x:tester', effect: 'none', schema: DS, noJson: { ok: false, offending: [], error: '$error' }, argv: [path.join(W, 'no-such-program')] }, {});
  ok('T8 a step whose program cannot start: noJson with "cannot run"', v && v.ok === false && /cannot run/.test(v.error) && /ENOENT/.test(v.error), JSON.stringify(v));

  // ---- T9: removed leftovers through exec
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: ['container c1'], removed: ['container c1'], remaining: [] } },
      diff: { ok: true, offending: [] }, left: { ok: true, found: ['process 42'], removed: ['process 42'], remaining: [] } });
  ok('T9 what the leftovers steps removed through exec is named in the result', x.r && x.r.status === 'done' && (x.r.leftovers || []).some((l) => /container c1/.test(l)) && (x.r.leftovers || []).some((l) => /process 42/.test(l)),
    JSON.stringify(x.r));

  // ---- T10: the nested noJson of post
  const PS = { type: 'object', properties: { ok: { type: 'boolean' }, diff: { type: 'object' }, left: { type: 'object' }, error: { type: 'string' } }, required: ['diff', 'left'] };
  v = await CR.execStep({ kind: 'post', label: 'post:x:tester', effect: 'idempotent', schema: PS,
    noJson: { ok: false, error: '$error', diff: { ok: false, offending: [], error: '$error' }, left: { ok: false, found: [], removed: [], remaining: ['$error'], error: '$error' } },
    argv: [process.execPath, '-e', 'process.stderr.write("post broke"); process.exit(3)'] }, {});
  ok('T10 post without JSON: the error text in error, diff.error, left.error and left.remaining',
    v && /post broke/.test(v.error) && /post broke/.test(v.diff.error) && /post broke/.test(v.left.error) && /post broke/.test(v.left.remaining[0]) && v.diff.ok === false, JSON.stringify(v));

  // ---- T11..T12: real step scripts through the real schema check of the conductor (the runner spawns the argv)
  const cp = require('child_process');
  const real = (step) => {
    const p = cp.spawnSync(step.argv[0], step.argv.slice(1), { encoding: 'utf8' });
    const last = String(p.stdout || '').trim().split('\n').pop();
    try { return { value: JSON.parse(last) }; } catch { return { $error: `exit ${p.status}: ${String(p.stderr || '').trim()}` }; }
  };
  const realOf = (step) => { const r = real(step); return r.$error ? r : r.value; };
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: ENV_OK, post: POST, diff: { ok: true, offending: [] }, left: realOf }, { wt: 'relative-wt' }, { scriptsDir: path.join(ROOT, 'scripts') });
  ok('T11 the real leftovers check on its error path: the end names its own cause',
    x.r && x.r.status === 'stopped' && /leftovers the chain could not remove \(end\): --wt must be an existing absolute directory/.test(x.r.why || '') && !/schema/.test(x.r.why || ''),
    JSON.stringify(x.r && x.r.why));
  const missing = path.join(W, 'no such dir');
  x = await chain({ pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] },
    { env: realOf, post: POST, diff: { ok: true, offending: [] }, left: LEFT_OK }, { wt: missing }, { scriptsDir: path.join(ROOT, 'scripts') });
  const preIn = ((x.launches.find((p) => p.label.startsWith('pre:')) || {}).stdin || '');
  const envSeen = x.steps.find((s) => s.kind === 'env');
  ok('T12 the real env-check on a missing path: its problems reach pre (no stop before pre, no schema refusal)',
    envSeen && /the conductor ran /.test(preIn) && /"ok":false/.test(preIn) && /"problems":\["[^"]/.test(preIn) && !/does not pass the schema/.test(preIn),
    preIn.slice(-800) + ' | ' + JSON.stringify(x.r && x.r.why));

  // ---- T13: own error texts in lists, once each, only non-empty strings
  v = await CR.execStep({ kind: 'diff', label: 'diff:x:reviewer', effect: 'none', schema: DS, noJson: { ok: false, offending: [], error: '$error' },
    argv: [process.execPath, '-e', 'console.log(JSON.stringify({ok: false, items: [{error: "in a list"}, [{error: "in a list"}]], error: "", more: {error: 42}}))'] }, {});
  const tail = ((v && v.error) || '').split('its own error: ')[1] || '';
  ok('T13 own error texts inside lists are kept, once each; an empty or non-string error is not one',
    v && /schema/.test(v.error) && tail === 'in a list', JSON.stringify(v));
  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
