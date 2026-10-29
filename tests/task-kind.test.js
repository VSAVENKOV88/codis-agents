#!/usr/bin/env node
'use strict';
// The kind of a task at the entry of workflows/role-chain.js (p-train-a1, cells K1-K7; rules: "Use cases before the
// matrix"): every task carries exactly one `kind` - feature, defect or tail. Without it, or with any other value, the
// task stops on "preconditions" before any agent, with no guess from its other fields. A feature starts only with use
// cases: useCasesFirst (with analystFirst: the analyst writes them) or useCases (a path in the task's or feature's
// folder); without either it stops before any agent. A defect or a tail needs no use cases (and may carry them).
// The script runs with fake agent()/pipeline()/log() and scripted role verdicts, as in role-chain.test.js.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'] };
// A task without any marker: each cell adds its own kind, analysis marker and use cases.
const BASE = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc' };
const task = (extra) => Object.assign({}, BASE, extra);
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };
const UC = { ready: true, useCases: 3, questions: ['Q1'], summary: 'u' };
const GREEN = { pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] };

async function run(script, t) {
  const trace = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' };
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it).catch((e) => ({ crashed: e.message }))));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [t] });
  return { r: res[0], trace: trace.join('>'), prompts };
}
const J = (x) => JSON.stringify(x.r);
const KIND_ERR = /exactly one kind: feature \| defect \| tail/;
const NO_UC_ERR = /feature without use cases: add useCasesFirst \(the analyst writes them\) or useCases \(a path\)/;
// Stopped on "preconditions" before any agent (not even the precondition agent or a post-check), with the reason.
const refusedBefore = (x, re) => x.r.status === 'stopped' && x.r.why === 'preconditions' && x.prompts.length === 0
  && re.test(JSON.stringify(x.r.problems)) && re.test(JSON.stringify(x.r.questions));

(async () => {
  let x;
  // K1: no kind -> stopped before any agent, whatever the other fields say (no guess: useCasesFirst does not make it a
  // feature, noAnalysis does not make it a tail).
  for (const [name, t] of [['with noAnalysis', { noAnalysis: 'one-line fix' }], ['with analystFirst', { analystFirst: true }],
    ['with useCasesFirst + analystFirst', { analystFirst: true, useCasesFirst: true }], ['with useCases + analysis', { analysis: '/d/analyst.md', useCases: '/d/use-cases.md' }],
    ['with feature', { feature: 'feat', analysis: '/s/feat/analyst.md' }], ['kind: undefined', { kind: undefined, noAnalysis: 'n' }]]) {
    x = await run({}, task(t));
    ok(`K1 no kind (${name}) -> stopped on preconditions before any agent: exactly one kind`, refusedBefore(x, KIND_ERR), J(x));
  }
  // K2: a kind not one of the three -> the same refusal.
  for (const k of ['bug', 'Feature', 'DEFECT', ' tail', 'feature ', '', ' ', 'feature|defect', ['feature'], ['feature', 'defect'], [], null, true, 1, {}]) {
    x = await run({}, task({ kind: k, noAnalysis: 'n' }));
    ok(`K2 kind ${JSON.stringify(k)} -> stopped before any agent: exactly one kind`, refusedBefore(x, KIND_ERR), J(x));
  }
  // The kind is checked first: a bad kind with a bad analysis marker still names the kind.
  x = await run({}, task({ kind: 'bug' }));
  ok('K2 a bad kind and no analysis marker -> the kind is named', refusedBefore(x, KIND_ERR), J(x));

  // K3: feature + useCases in the task folder -> passes to pre and the roles; the result carries the kind.
  x = await run(GREEN, task({ kind: 'feature', analysis: '/d/analyst.md', useCases: '/d/use-cases.md' }));
  ok('K3 feature + useCases (task folder) -> pre > prog > test > review, done', x.r.status === 'done' && x.trace === 'pre>prog>test>review' && x.r.useCases === '/d/use-cases.md', J(x));
  ok('K3 the result carries kind feature', x.r.kind === 'feature', J(x));
  x = await run(Object.assign({}, GREEN, { analyst: [AN] }), task({ kind: 'feature', analystFirst: true, useCases: '/d/use-cases.md' }));
  ok('K3 feature + useCases + analystFirst -> pre > analyst > prog > test > review', x.r.status === 'done' && x.trace === 'pre>analyst>prog>test>review', J(x));

  // K4: feature + useCasesFirst + analystFirst -> the use cases analyst, status use-cases-review.
  x = await run({ pre: [PRE], usecases: [UC] }, task({ kind: 'feature', analystFirst: true, useCasesFirst: true }));
  ok('K4 feature + useCasesFirst + analystFirst -> pre > usecases, use-cases-review', x.r.status === 'use-cases-review' && x.trace === 'pre>usecases' && x.r.useCases === '/d/use-cases.md', J(x));
  ok('K4 the result carries kind feature', x.r.kind === 'feature', J(x));
  // useCasesFirst keeps its own refusals for a feature too.
  x = await run({}, task({ kind: 'feature', noAnalysis: 'n', useCasesFirst: true }));
  ok('K4 feature + useCasesFirst without analystFirst -> the useCasesFirst refusal, before any agent', refusedBefore(x, /useCasesFirst goes with analystFirst alone/), J(x));

  // K5: feature without useCases and without useCasesFirst -> stopped before any agent, with the reason.
  for (const [name, t] of [['analystFirst', { analystFirst: true }], ['analysis', { analysis: '/d/analyst.md' }], ['noAnalysis', { noAnalysis: 'a tail' }],
    ['a feature part', { feature: 'feat', analysis: '/s/feat/analyst.md' }]]) {
    x = await run({}, task(Object.assign({ kind: 'feature' }, t)));
    ok(`K5 feature without use cases (${name}) -> stopped before any agent: feature without use cases`, refusedBefore(x, NO_UC_ERR), J(x));
  }
  ok('K5 the refusal carries the kind', x.r.kind === 'feature', J(x));

  // K6: a defect or a tail needs no use cases; with them it passes too and every role gets them.
  for (const k of ['defect', 'tail']) {
    x = await run(GREEN, task({ kind: k, noAnalysis: 'one-line fix' }));
    ok(`K6 ${k} without useCases -> done, no use cases in any prompt`, x.r.status === 'done' && x.trace === 'pre>prog>test>review' && x.r.kind === k
      && !x.prompts.some((p) => /Use cases of the feature/.test(p.prompt)), J(x));
    x = await run(Object.assign({}, GREEN, { analyst: [AN] }), task({ kind: k, analystFirst: true, useCases: '/d/use-cases.md' }));
    ok(`K6 ${k} with useCases -> done, the use cases reach the roles`, x.r.status === 'done' && x.r.useCases === '/d/use-cases.md'
      && x.prompts.filter((p) => p.role === 'prog').every((p) => p.prompt.includes('Use cases of the feature (actors, flows, alternative flows, errors): /d/use-cases.md.')), J(x));
    // A bad useCases path is refused for every kind, as before.
    x = await run({}, task({ kind: k, noAnalysis: 'n', useCases: '/elsewhere/use-cases.md' }));
    ok(`K6 ${k} with useCases outside the folders -> the old refusal`, refusedBefore(x, /useCases \/elsewhere\/use-cases\.md is not an absolute path inside/), J(x));
  }

  // K7: a feature part with useCases in the feature folder passes; outside the folders or equal to spec - old refusal.
  x = await run(GREEN, task({ kind: 'feature', feature: 'feat', analysis: '/s/feat/analyst.md', useCases: '/s/feat/use-cases.md' }));
  ok('K7 feature part + useCases in the feature folder -> done', x.r.status === 'done' && x.trace === 'pre>prog>test>review' && x.r.useCases === '/s/feat/use-cases.md' && x.r.feature === 'feat', J(x));
  x = await run({}, task({ kind: 'feature', feature: 'feat', analysis: '/s/feat/analyst.md', useCases: '/s/other/use-cases.md' }));
  ok('K7 feature part + useCases outside the task and feature folders -> refused before any agent', refusedBefore(x, /useCases \/s\/other\/use-cases\.md is not an absolute path inside \/d\/ or \/s\/feat\//), J(x));
  x = await run({}, task({ kind: 'feature', feature: 'feat', analysis: '/s/feat/analyst.md', useCases: '/s/feat/spec.md', spec: '/s/feat/spec.md' }));
  ok('K7 feature part + useCases equal to spec -> refused before any agent', refusedBefore(x, /useCases \/s\/feat\/spec\.md is the arc specification/), J(x));
  for (const u of [' ', '']) {
    x = await run({}, task({ kind: 'feature', feature: 'feat', analysis: '/s/feat/analyst.md', useCases: u }));
    ok(`K7 feature + useCases ${JSON.stringify(u)} -> the blank refusal, not "without use cases"`, refusedBefore(x, /useCases must be a non-empty path/), J(x));
  }

  // The documented interface: meta.whenToUse and the header name the field.
  const src = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
  ok('role-chain meta.whenToUse names kind: feature | defect | tail', /whenToUse:[^\n]*kind: feature \| defect \| tail/.test(src));
  ok('role-chain header explains the kind', /^\/\/ Kind of the task[^\n]*exactly one `kind`/m.test(src));

  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
