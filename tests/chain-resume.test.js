#!/usr/bin/env node
'use strict';
// The entry of the chain from the middle (p-codex-B1-b2b; analysis §3 Z1-Z3, Z5): a task with resumeAt (tester, review,
// train) and head starts there under the conductor (exec present), never under the Workflow runtime; the form is refused
// before any agent with the counts of prior; resumeAt review first runs the tester's post-check from resumeSince (the
// conductor sets it from the decision), resumeAt train the reviewer's post-check; a red post-check stops the task.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'English', testerWritable: ['-run\\.js$'] };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'true {wt}' });
const HB = 'b'.repeat(40), HP = 'a'.repeat(40);
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: HP, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };

async function run(script, task, cfg = CFG, withExec = true) {
  const trace = [], since = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const answer = (opts) => {
    const role = opts.label.split(':')[0];
    if (['diff', 'post', 'left', 'run', 'sha'].includes(role)) trace.push(opts.label.replace(/#retry$/, ''));
    else trace.push(role);
    if (q[role] && q[role].length) return q[role].shift();
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/l', tail: '' };
    throw new Error(`extra call ${role} after ${trace.join('>')}`);
  };
  const agent = async (prompt, opts) => answer(opts);
  const exec = async (step) => {
    const i = step.argv.indexOf('--since');
    if (i >= 0) since.push(`${step.kind}:${step.argv[i + 1]}`);
    if (!step.agent) return { ok: true, problems: [], notes: [] };
    return answer(step.agent.opts);
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const a = { owner: 'o', config: cfg, tasks: [task] };
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'exec', 'checkpoint', SRC)(
    agent, pipeline, null, () => {}, () => {}, a, withExec ? exec : undefined, withExec ? () => {} : undefined);
  return { r: res[0], trace: trace.join('>'), since };
}

(async () => {
  let x = await run({ pre: [PRE], test: [{ verdict: 'green', head: HB, summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] },
    Object.assign({}, T, { resumeAt: 'tester', head: HP }));
  ok('Z1: resumeAt tester -> no programmer, tester then review, done', x.r.status === 'done' && !/prog/.test(x.trace) && /test.*review/.test(x.trace), x.trace);
  ok('Z1: the tester post-check runs from the head given', x.since.includes(`post:${HP}`), JSON.stringify(x.since));

  x = await run({ pre: [PRE], test: [{ verdict: 'red', head: HB, summary: 'r' }, { verdict: 'green', head: HB, summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }], prog: [PROG], analyst: [{ ready: true, cells: 1, subsystems: 1, split: [], questions: [], summary: 'a', mechanismOrCells: 'cells' }] },
    Object.assign({}, T, { resumeAt: 'tester', head: HP, prior: { testerReds: 1 } }));
  ok('Z1: the second red tester round after the entry goes to the analyst (prior counted)', /test>(post:x:tester>)?analyst/.test(x.trace) && !/prog.*test>(post:x:tester>)?analyst/.test(x.trace), x.trace);

  x = await run({ pre: [PRE], review: [{ verdict: 'done', docsOnly: false, summary: '' }] },
    Object.assign({}, T, { resumeAt: 'review', head: HB, resumeSince: HP }));
  ok('Z2/Z5: resumeAt review -> the tester post-check from resumeSince, then review, no tester', x.r.status === 'done' && !/(^|>)test(>|$)/.test(x.trace) && /review/.test(x.trace) && x.since.includes(`post:${HP}`), `${x.trace} ${JSON.stringify(x.since)}`);

  x = await run({ pre: [PRE], post: [{ ok: false, diff: { ok: false, offending: ['src/a.js'] }, left: { ok: true, found: [], removed: [], remaining: [] } }, { ok: false, diff: { ok: false, offending: ['src/a.js'] }, left: { ok: true, found: [], removed: [], remaining: [] } }] },
    Object.assign({}, T, { resumeAt: 'review', head: HB, resumeSince: HP }));
  ok('Z5: a red tester post-check at the entry -> stopped, no review', x.r.status === 'stopped' && !/review/.test(x.trace) && /src\/a\.js/.test(x.r.why), `${x.trace} ${x.r.why}`);

  x = await run({ pre: [PRE], review: [{ verdict: 'done', docsOnly: false, summary: '' }] },
    Object.assign({}, T, { resumeAt: 'review', head: HB, mode: 'light', base: 'arc' }), ONE);
  ok('Z5/R16: light resumeAt review -> review without the tester post-check, then the train', x.r.status === 'done' && !/post:/.test(x.trace) && /review>.*run:x:train-1/.test(x.trace), x.trace);

  x = await run({ pre: [PRE] }, Object.assign({}, T, { resumeAt: 'train', head: HB, resumeSince: HB, base: 'arc' }), ONE);
  ok('Z2/Z5: resumeAt train -> the reviewer post-check, then the ride, done', x.r.status === 'done' && /diff:x:reviewer>run:x:train-1/.test(x.trace) && !/(^|>)(review|prog|test)(>|$)/.test(x.trace) && x.since.includes(`diff:${HB}`), `${x.trace} ${JSON.stringify(x.since)}`);

  x = await run({ pre: [PRE], diff: [{ ok: false, offending: ['src/a.js'] }, { ok: false, offending: ['src/a.js'] }] }, Object.assign({}, T, { resumeAt: 'train', head: HB, resumeSince: HB, base: 'arc' }), ONE);
  ok('Z5: a red reviewer post-check at the train entry -> stopped, no ride', x.r.status === 'stopped' && !/train-1/.test(x.trace), x.trace);

  const refused = [
    [{ resumeAt: 'analyst', head: HP }, CFG, 'an unknown resumeAt'],
    [{ resumeAt: 'tester' }, CFG, 'no head'],
    [{ resumeAt: 'tester', head: 'abc1234' }, CFG, 'an abbreviated head'],
    [{ head: HP }, CFG, 'head without resumeAt'],
    [{ resumeAt: 'tester', head: HP, analystFirst: true, noAnalysis: undefined }, CFG, 'with analystFirst'],
    [{ resumeAt: 'tester', head: HP, mode: 'light', base: 'arc' }, ONE, 'light + tester'],
    [{ resumeAt: 'train', head: HP, mode: 'light', base: 'arc' }, ONE, 'light + train'],
    [{ resumeAt: 'train', head: HP }, CFG, 'train without guardSubsetCommand'],
  ];
  for (const [extra, cfg, what] of refused) {
    const t = Object.assign({}, T, extra, { prior: { rejections: 1 } });
    if (extra.noAnalysis === undefined && 'noAnalysis' in extra) delete t.noAnalysis;
    x = await run({}, t, cfg);
    ok(`Z3: refused before any agent - ${what}, counts from prior`, x.r.status === 'stopped' && x.trace === '' && x.r.counts && x.r.counts.rejections === 1, `${x.trace} ${JSON.stringify(x.r)}`);
  }
  x = await run({}, Object.assign({}, T, { resumeAt: 'tester', head: HP }), CFG, false);
  ok('Z3: resumeAt under the Workflow runtime (no exec) -> refused before any agent', x.r.status === 'stopped' && x.trace === '' && /conductor/.test(JSON.stringify(x.r)), `${x.trace} ${JSON.stringify(x.r)}`);
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] }, T);
  ok('Z3: a task without the fields runs as before', x.r.status === 'done' && x.trace.startsWith('pre>prog'), x.trace);
  done();
})().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack)); process.exit(1); });
