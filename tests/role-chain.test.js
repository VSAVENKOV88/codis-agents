#!/usr/bin/env node
'use strict';
// Logic of workflows/role-chain.js: the script runs with fake agent()/pipeline()/log() and scripted role verdicts; the
// test checks the order of roles and the outcome (rules/multi-agent.md: a red tester goes back to the programmer
// without a review; a rejection for docs gets a second review of the diff without the tester (docs and guard paths, or
// the review confirms fixBehaviourUnchanged); a tester red from the environment stops the task; a second
// rejection for code, or the second red tester round for the product, brings the analyst into the same run; preconditions or open questions stop before the
// programmer; git post-check of tester and reviewer from the HEAD of the previous role; lines of
// rules/multi-agent.md marked <!-- role:<id> --> are in RULE_LIST and in the prompt of every role).
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: { programmer: 'rebuild the bundle' }, threatModel: 'ACCESS.md' };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', noAnalysis: 'one-line fix' };
// T without the analysis marker (exactly one of analystFirst, analysis, noAnalysis is required).
const bare = (extra) => { const t = Object.assign({}, T, extra); delete t.noAnalysis; return Object.assign(t, extra); };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const DOCS = Object.assign({}, PROG, { changedFiles: ['docs/GAPS.md'] });
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };

// script: a queue of answers per role; trace - the order of calls.
// A tester verdict without head gets head 'T'; the post-check (diff), the leftovers check, the combined post-check of
// the tester (post: its diff part from the diff queue, its left part from the left queue) and the wait step of the full
// guard run (run, green by default) are not in trace (their order is in full).
async function run(script, task = T, extra = {}) {
  const trace = [], full = [], prompts = [], logs = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    const nextDiff = () => (q.diff && q.diff.length ? q.diff.shift() : { ok: true, offending: [] });
    const nextLeft = () => (q.left && q.left.length ? q.left.shift() : { ok: true, found: [], removed: [], remaining: [] });
    if (role === 'diff') return nextDiff();
    if (role === 'left') return nextLeft();
    if (role === 'post') { const d = nextDiff(), l = nextLeft(); return d === null && l === null ? null : { ok: !!(d && d.ok && l && l.ok), diff: d, left: l }; }
    if (role === 'run') { const v = q.run && q.run.length ? q.run.shift() : { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' }; return v; }
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it).catch(() => null)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, (m) => logs.push(m), () => {}, Object.assign({ owner: 'o', config: CFG, tasks: [task] }, extra));
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts, logs };
}

(async () => {
  let x;
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  ok('green path: pre>prog>test>review -> done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', x.trace);

  x = await run({ pre: [{ ok: true, problems: [], blockingQuestions: ['q'] }] });
  ok('open question to the owner -> stop before the programmer', x.r.status === 'stopped' && x.trace === 'pre', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'red', summary: '' }, { verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  ok('red tester -> programmer without review', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review', x.trace);

  // A red from the environment (cut-off full run, no slot, disk, swap, Docker) stops for the coordinator, no programmer.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'environment', environment: 'full run killed at 40 %, disk 100 %', summary: 's' }] });
  ok('tester environment -> stopped with the cause, no second programmer, no review',
    x.r.status === 'stopped' && x.trace === 'pre>prog>test' && /environment/.test(x.r.why) && /disk 100 %/.test(x.r.why) && x.r.environment === 'full run killed at 40 %, disk 100 %', JSON.stringify(x.r));
  ok('tester environment: the post-checks still ran (cleanup)', x.full === 'pre>prog>test>post:x:tester>left:x:end', x.full);
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'environment', environment: 'docker daemon down', summary: '' }],
    review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }] });
  ok('tester environment after the review fix -> stopped with the cause, no second review',
    x.r.status === 'stopped' && x.trace === 'pre>prog>test>review>prog>test' && /docker daemon down/.test(x.r.why), JSON.stringify(x.r));
  const tp0 = x.prompts.find((p) => p.role === 'test');
  ok('tester prompt: the environment verdict, its causes and env-check with the floors',
    /environment - red that the product did not cause/.test(tp0.prompt) && tp0.prompt.includes("node /p/scripts/env-check.js --path '/w' --min-disk-gb 10 --min-swap-mb 4000")
      && (tp0.opts.schema.properties.verdict.enum || []).includes('environment'), tp0.prompt);
  ok('preconditions run env-check on the worktree and the task folder with the default floors, and refuse a main working copy (--worktree)',
    x.prompts[0].prompt.includes("node /p/scripts/env-check.js --path '/w' --path '/d' --worktree '/w' --min-disk-gb 10 --min-swap-mb 4000"), x.prompts[0].prompt);
  x = await run({ pre: [{ ok: false, problems: ['disk /w: 2 GB free, below 10 GB'], blockingQuestions: [] }] }, T,
    { config: Object.assign({}, CFG, { preconditions: { minFreeDiskGB: 25, swapMinMB: 6000 } }) });
  ok('E1. preconditions: floors from config.preconditions (swapMinMB in MB); a full disk stops before the programmer',
    x.prompts[0].prompt.includes('--min-disk-gb 25 --min-swap-mb 6000') && x.r.status === 'stopped' && x.trace === 'pre' && /2 GB free/.test(JSON.stringify(x.r.problems)), JSON.stringify(x.r));
  x = await run({ pre: [{ ok: false, problems: ['x'], blockingQuestions: [] }] }, T, { config: Object.assign({}, CFG, { preconditions: { minFreeDiskGB: 25, minSwapGB: 6 } }) });
  ok('E1. preconditions: a config resolved before the machine file (minSwapGB in GB) -> --min-swap-mb x 1024',
    x.prompts[0].prompt.includes('--min-disk-gb 25 --min-swap-mb 6144'), x.prompts[0].prompt);

  // Red tester rounds for the product are counted per task (cvm-xy-1, 2026-10-23): the second one sends the task to the
  // analyst in the same run (a matrix from test.md and prog.md), then one round prog -> test -> review; a red after that
  // analyst stops the task (why 'tester red after analyst'); a red of the environment does not count.
  const RED = (s) => ({ verdict: 'red', summary: s || '' }), GREEN = { verdict: 'green', summary: '' }, DONE = { verdict: 'done', docsOnly: false, summary: '' };
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: [RED('r1'), RED('r2'), GREEN], analyst: [AN], review: [DONE] });
  ok('R1. second red tester round -> analyst in the same run -> prog -> test -> review -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>analyst>prog>test>review', x.trace);
  const anP = (x.prompts.find((p) => p.role === 'analyst') || {}).prompt || '';
  ok('R1. the analyst reads test.md and prog.md and writes a matrix from the tester\'s findings',
    anP.includes('/d/test.md') && anP.includes('/d/prog.md') && /matrix of cases/.test(anP) && anP.includes('r2'), anP);
  ok('R1. the analyst runs in the Analyst phase with the analyst label', (x.prompts.find((p) => p.role === 'analyst') || { opts: {} }).opts.phase === 'Analyst'
    && (x.prompts.find((p) => p.role === 'analyst') || { opts: {} }).opts.label === 'analyst:x');
  ok('R1. the programmer after the analyst follows analyst.md and test.md', /analyst\.md - a matrix of cases from the tester's findings/.test(x.prompts.filter((p) => p.role === 'prog')[2].prompt));
  ok('R1. logged "the second red tester round for the product - analyst"', x.logs.some((m) => /the second red tester round for the product - analyst/.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: [RED(), RED(), RED('r3')], analyst: [AN] });
  ok('R2. third red tester round after the analyst -> stopped "tester red after analyst", no review',
    x.r.status === 'stopped' && x.r.why === 'tester red after analyst' && x.trace === 'pre>prog>test>prog>test>analyst>prog>test' && x.r.test === 'r3', JSON.stringify(x.r) + ' ' + x.trace);
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [RED(), { verdict: 'environment', environment: 'docker down', summary: '' }] });
  ok('R3. red, then environment -> stopped for the environment, no analyst (environment does not count)',
    x.r.status === 'stopped' && !x.trace.includes('analyst') && /environment/.test(x.r.why), JSON.stringify(x.r) + ' ' + x.trace);
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG, PROG], test: [RED(), GREEN, RED('after fix'), GREEN], analyst: [AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }, DONE] });
  ok('R4. red, green, rejection, red after the review fix (the second product red) -> analyst -> prog -> test -> review -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review>prog>test>analyst>prog>test>review', x.trace);
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG, PROG], test: [GREEN, GREEN, RED(), RED()], analyst: [AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }] });
  ok('R5. after the analyst of the second rejection the tester rounds stay as before (one analyst per run)',
    x.r.status === 'stopped' && x.trace === 'pre>prog>test>review>prog>test>review>analyst>prog>test>prog>test' && /2 red tester rounds/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG, DOCS], test: [{ verdict: 'green', summary: '' }],
    review: [{ verdict: 'rejected', docsOnly: true, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('rejection for docs, fix only .md -> second review without the tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }],
    review: [{ verdict: 'rejected', docsOnly: true, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('rejection "for docs", the fix touches code and the review does not confirm "no behaviour" -> tester after the second review',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review>test', x.trace);

  // A rejection for docs only: programmer -> second review of the diff, without the tester (4 of 5 went through the
  // tester because a comment in a .js/.html file or a guard file did not count as docs).
  const DOCS_REJ = { verdict: 'rejected', docsOnly: true, summary: 'stale comment' };
  const D1 = { verdict: 'done', docsOnly: false, summary: '' }, D = D1;
  const fixOf = (files, head) => Object.assign({}, PROG, { changedFiles: files, head: head || 'P2' });
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['server/x-run.js', 'docs/GAPS.md'])], test: [{ verdict: 'green', summary: '' }], review: [DOCS_REJ, D1] });
  ok('docs rejection, the fix touches only guard files and docs -> second review without the tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', x.trace);
  const rv2 = x.prompts.filter((p) => p.role === 'review')[1].prompt;
  ok('docs rejection: the second review reads only the diff of the fix, from the HEAD before it', /only the diff of the fix after review 1 \(git diff T\.\.P2\)/.test(rv2) && !/fixBehaviourUnchanged/.test(rv2), rv2);
  ok('docs rejection: the programmer is told to change no behaviour', /rejected for docs only: [^.]*change no behaviour/.test(x.prompts.filter((p) => p.role === 'prog')[1].prompt));
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['plugin/ui.html', 'ACCESS.md'])], test: [{ verdict: 'green', summary: '' }],
    review: [DOCS_REJ, Object.assign({}, D1, { fixBehaviourUnchanged: true })] });
  ok('docs rejection, a comment in product code, the review confirms no behaviour change -> done without the tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', x.trace);
  ok('docs rejection outside docs: the second review is asked to confirm fixBehaviourUnchanged for the named files',
    /fixBehaviourUnchanged=true only if[^\n]*/.test(x.prompts.filter((p) => p.role === 'review')[1].prompt) && x.prompts.filter((p) => p.role === 'review')[1].prompt.includes('(plugin/ui.html)')
      && x.prompts.filter((p) => p.role === 'review')[1].opts.schema.properties.fixBehaviourUnchanged, x.prompts.filter((p) => p.role === 'review')[1].prompt);
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['src/a.js'])], test: [{ verdict: 'green', summary: '' }, { verdict: 'red', summary: 'broke' }],
    review: [DOCS_REJ, Object.assign({}, D1, { fixBehaviourUnchanged: false })] });
  ok('docs rejection, the review says the fix changes behaviour -> tester; red -> stopped', x.r.status === 'stopped' && x.trace === 'pre>prog>test>review>prog>review>test' && /tester after the review fix/.test(x.r.why), JSON.stringify(x.r));
  ok('docs rejection with a code fix is logged', x.logs.some((m) => /did not confirm it changes no behaviour - tester round/.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG, fixOf([])], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }], review: [DOCS_REJ, D1] });
  ok('docs rejection, the programmer reports no changed files and the review does not confirm -> tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review>test', x.trace);
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['src/a.js'])], test: [{ verdict: 'green', summary: '' }], review: [DOCS_REJ, { verdict: 'rejected', docsOnly: true, summary: 'again' }] });
  ok('docs rejection twice -> stopped for the coordinator, no analyst, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog>test>review>prog>review', x.trace);
  const TSD = Object.assign({}, T, { security: true });
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['src/a.js'])], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }],
    review: [D1, Object.assign({}, D1, { fixBehaviourUnchanged: true })], sec: [DOCS_REJ, D1] }, TSD);
  ok('security: a docs rejection needs both reviewers to confirm no behaviour change, else the tester runs', x.r.status === 'done' && x.trace === 'pre>prog>test>review>sec>prog>review>sec>test', x.trace);
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['src/a.js'])], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }],
    review: [D1, D1], sec: [DOCS_REJ, Object.assign({}, D1, { fixBehaviourUnchanged: true })] }, TSD);
  ok('security: only the security reviewer confirms -> the tester runs', x.r.status === 'done' && x.trace === 'pre>prog>test>review>sec>prog>review>sec>test', x.trace);
  x = await run({ pre: [PRE], prog: [PROG, fixOf(['src/a.js'])], test: [{ verdict: 'green', summary: '' }],
    review: [D1, Object.assign({}, D1, { fixBehaviourUnchanged: true })], sec: [DOCS_REJ, Object.assign({}, D1, { fixBehaviourUnchanged: true })] }, TSD);
  ok('security: both confirm -> done without the tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>sec>prog>review>sec', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: Array(3).fill({ verdict: 'green', summary: '' }), analyst: [AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('second rejection for code -> analyst in the same run -> round -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review>analyst>prog>test>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: Array(2).fill({ verdict: 'green', summary: '' }), analyst: [Object.assign({}, AN, { split: ['a', 'b'] })],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }] });
  ok('analyst proposes a split -> stop for the coordinator', x.r.status === 'stopped' && x.r.split && x.r.split.length === 2, JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [Object.assign({}, PROG, { status: 'blocked', questions: ['q'] })] });
  ok('programmer blocked -> stop with the question, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog', x.trace);

  x = await run({ pre: [PRE], analyst: [Object.assign({}, AN, { cells: 40, split: ['a'] })] }, bare({ analystFirst: true }));
  ok('analystFirst: split -> stop before the programmer', x.r.status === 'stopped' && x.trace === 'pre>analyst', x.trace);

  // Analysis marker: every task carries exactly one of analystFirst, analysis (a reused report), noAnalysis (a reason).
  const G = { pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D1] };
  const progOf = (x) => (x.prompts.find((p) => p.role === 'prog') || {}).prompt || '';
  x = await run({}, bare({}));
  ok('no analysis marker -> stopped before any agent, the question names the three fields',
    x.r.status === 'stopped' && x.trace === '' && /preconditions/.test(x.r.why) && /analystFirst/.test(JSON.stringify(x.r.questions || []))
      && /noAnalysis/.test(JSON.stringify(x.r.questions || [])) && /`?analysis`?/.test(JSON.stringify(x.r.questions || [])), JSON.stringify(x.r));
  x = await run({}, bare({ analystFirst: true, noAnalysis: 'r' }));
  ok('two analysis markers -> stopped before any agent', x.r.status === 'stopped' && x.trace === '' && /analystFirst/.test(JSON.stringify(x.r)) && /noAnalysis/.test(JSON.stringify(x.r)), JSON.stringify(x.r));
  x = await run({}, bare({ analysis: '' }));
  ok('an empty analysis path is no marker -> stopped', x.r.status === 'stopped' && x.trace === '', JSON.stringify(x.r));
  x = await run({}, bare({ noAnalysis: '  ' }));
  ok('a blank noAnalysis reason is no marker -> stopped', x.r.status === 'stopped' && x.trace === '', JSON.stringify(x.r));
  x = await run({}, bare({ analystFirst: 'yes' }));
  ok('analystFirst must be true, not any truthy value -> stopped', x.r.status === 'stopped' && x.trace === '', JSON.stringify(x.r));

  x = await run(Object.assign({}, G, { pre: [PRE] }), bare({ analysis: '/s/old/analyst.md', feature: 'old' }));
  ok('analysis: no analyst agent, the chain runs to done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', x.trace);
  ok('analysis: logged "<title>: analyst reused - <path>"', x.logs.includes('X: analyst reused - /s/old/analyst.md'), x.logs.join(' | '));
  ok('analysis: the preconditions check the file exists and is non-empty',
    /\/s\/old\/analyst\.md/.test(x.prompts[0].prompt) && /exists, is non-empty/.test(x.prompts[0].prompt), x.prompts[0].prompt);
  ok('analysis: the programmer prompt names it explicitly', progOf(x).includes('The analysis to follow: /s/old/analyst.md'), progOf(x));
  ok('analysis: the result carries {mode: reused, path}', JSON.stringify(x.r.analysis) === JSON.stringify({ mode: 'reused', path: '/s/old/analyst.md' }), JSON.stringify(x.r));
  x = await run({ pre: [{ ok: false, problems: ['/s/old/analyst.md is missing'], blockingQuestions: [] }] }, bare({ analysis: '/s/old/analyst.md', feature: 'old' }));
  ok('analysis: a missing file stops at the preconditions, the result still names the analysis',
    x.r.status === 'stopped' && x.trace === 'pre' && x.r.analysis && x.r.analysis.mode === 'reused', JSON.stringify(x.r));

  // A feature gets its own analysis: analysis lies in the task's folder or its feature's folder; the arc spec is `spec`.
  const SPEC = '/s/arc/spec.md';
  for (const [name, t] of [['outside the task and feature folders', { analysis: SPEC }],
    ['equal to the arc specification', { analysis: '/d/spec.md', spec: ['/d/spec.md'] }],
    ['a relative path', { analysis: 'd/analyst.md' }], ['a path with ..', { analysis: '/d/../s/arc/spec.md' }],
    ['in another task\'s folder without feature', { analysis: '/s/old/analyst.md' }],
    ['feature in a folder that is only a prefix', { analysis: '/s/oldx/analyst.md', feature: 'old' }]]) {
    x = await run({}, bare(t));
    ok(`analysis ${name} -> stopped before any agent, the question names spec`, x.r.status === 'stopped' && x.trace === '' && /`spec`/.test(JSON.stringify(x.r.questions || [])), JSON.stringify(x.r));
  }
  x = await run({}, bare({ noAnalysis: 'tail', feature: ' ' }));
  ok('a blank feature -> stopped before any agent', x.r.status === 'stopped' && x.trace === '' && /feature/.test(x.r.problems[0]), JSON.stringify(x.r));
  x = await run({}, bare({ noAnalysis: 'tail', spec: ['/s/a.md', ''] }));
  ok('a blank spec path -> stopped before any agent', x.r.status === 'stopped' && x.trace === '' && /spec/.test(x.r.problems[0]), JSON.stringify(x.r));
  x = await run(G, bare({ analysis: '/d/diagnosis.md', spec: SPEC }));
  ok('analysis inside the task folder with a separate spec -> done', x.r.status === 'done' && x.trace === 'pre>prog>test>review' && x.r.analysis.path === '/d/diagnosis.md', JSON.stringify(x.r));
  ok('spec: every role prompt names the arc specification as context, not the analysis',
    x.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).every((p) => p.prompt.includes(`Arc specification (context of the surface; it is not this task's analysis): ${SPEC}.`)), x.full);
  ok('spec: the preconditions check it exists', x.prompts[0].prompt.includes(`the arc specification ${SPEC} exists`), x.prompts[0].prompt);
  ok('analysis: the preconditions check it is a matrix or diagnosis of this task, not an arc specification',
    /\/d\/diagnosis\.md exists, is non-empty and is a matrix of cases or a diagnosis written for this task[^;]*not a specification of the whole arc/.test(x.prompts[0].prompt), x.prompts[0].prompt);
  x = await run(G, bare({ analysis: '/s/q3/analyst.md', feature: ' q3 ' }));
  ok('analysis in the folder of the feature -> done', x.r.status === 'done' && x.r.analysis.path === '/s/q3/analyst.md', JSON.stringify(x.r));
  ok('the result carries the feature (chain-cost sums parts by it)', x.r.feature === 'q3', JSON.stringify(x.r));
  x = await run(G, bare({ noAnalysis: 'tail: a renamed label' }));
  ok('noAnalysis: the preconditions refuse "the arc specification covers it" as a reason',
    /noAnalysis reason "tail: a renamed label".*"the arc specification covers it" is not such a reason/.test(x.prompts[0].prompt), x.prompts[0].prompt);
  ok('without spec no arc specification line', !x.prompts.some((p) => /Arc specification/.test(p.prompt)));

  x = await run(G, bare({ noAnalysis: 'rename only' }));
  ok('noAnalysis: no analyst agent, done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', x.trace);
  ok('noAnalysis: logged "<title>: no analyst - <reason>"', x.logs.includes('X: no analyst - rename only'), x.logs.join(' | '));
  ok('noAnalysis: the programmer prompt carries the reason', progOf(x).includes('No analysis: rename only'), progOf(x));
  ok('noAnalysis: the result carries {mode: none, reason}', JSON.stringify(x.r.analysis) === JSON.stringify({ mode: 'none', reason: 'rename only' }), JSON.stringify(x.r));

  x = await run(Object.assign({}, G, { analyst: [AN] }), bare({ analystFirst: true }));
  ok('analystFirst: analyst runs, the result carries {mode: run, path: <dir>/analyst.md}',
    x.r.status === 'done' && x.trace === 'pre>analyst>prog>test>review' && JSON.stringify(x.r.analysis) === JSON.stringify({ mode: 'run', path: '/d/analyst.md' }), JSON.stringify(x.r));
  ok('analystFirst: the programmer prompt names analyst.md', progOf(x).includes('The analysis to follow: /d/analyst.md'), progOf(x));

  // Use cases before the feature (owner 2026-10-20: "use cases ... pilot on e2g3"): useCasesFirst -> the analyst writes
  // only use-cases.md and the task stops for the review with the owner; useCases -> every role gets the path as context.
  const UC = { ready: true, useCases: 4, questions: ['Q1: who may resend?'], summary: 'u' };
  const roleP = (x, r) => (x.prompts.find((p) => p.role === r) || {}).prompt || '';
  x = await run({ pre: [PRE], usecases: [UC] }, bare({ analystFirst: true, useCasesFirst: true }));
  ok('useCasesFirst: pre > use cases analyst only, then stopped for the owner review (no matrix, no programmer)',
    x.r.status === 'use-cases-review' && x.trace === 'pre>usecases' && /review the use cases with the owner/i.test(x.r.why), JSON.stringify(x.r));
  ok('useCasesFirst: the result names the file, its questions and how to relaunch',
    x.r.useCases === '/d/use-cases.md' && JSON.stringify(x.r.questions) === JSON.stringify(UC.questions) && /useCases[^.]*analystFirst/.test(x.r.why), JSON.stringify(x.r));
  const ucp = roleP(x, 'usecases');
  ok('useCasesFirst: the analyst writes only <dir>/use-cases.md from the template (actor, trigger, main flow, alternative flows, errors, out of scope)',
    /you write only \/d\/use-cases\.md/.test(ucp) && ['actor', 'trigger', 'main flow', 'alternative flows', 'errors', 'out of scope'].every((w) => ucp.toLowerCase().includes(w)) && !/matrix of cases \(every dimension/.test(ucp), ucp);
  ok('useCasesFirst: the analyst runs as the analyst agent, in the Analyst phase', (x.prompts.find((p) => p.role === 'usecases') || { opts: {} }).opts.agentType === 'codis-agents:analyst'
    && x.prompts.find((p) => p.role === 'usecases').opts.phase === 'Analyst');
  ok('useCasesFirst: the leftovers post-check still runs at the end', x.full === 'pre>usecases>left:x:end', x.full);
  x = await run({ pre: [PRE], usecases: [null] }, bare({ analystFirst: true, useCasesFirst: true }));
  ok('useCasesFirst: no result -> stopped', x.r.status === 'stopped' && /returned no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], usecases: [Object.assign({}, UC, { ready: false })] }, bare({ analystFirst: true, useCasesFirst: true }));
  ok('useCasesFirst: not ready -> stopped, not offered for review', x.r.status === 'stopped' && x.trace === 'pre>usecases', JSON.stringify(x.r));
  for (const [name, t] of [['without analystFirst', { noAnalysis: 'tail', useCasesFirst: true }], ['with analysis', { analysis: '/d/a.md', useCasesFirst: true }],
    ['not true', { analystFirst: true, useCasesFirst: 'yes' }], ['together with useCases', { analystFirst: true, useCasesFirst: true, useCases: '/d/use-cases.md' }]]) {
    x = await run({}, bare(t));
    ok(`useCasesFirst ${name} -> stopped before any agent`, x.r.status === 'stopped' && x.trace === '' && /useCases/.test(JSON.stringify(x.r.problems)), JSON.stringify(x.r));
  }
  for (const [name, t] of [['relative', { useCases: 'd/use-cases.md' }], ['with ..', { useCases: '/d/../s/u.md' }], ['outside the task and feature folders', { useCases: '/s/arc/use-cases.md' }],
    ['blank', { useCases: ' ' }], ['equal to the arc specification', { useCases: '/d/spec.md', spec: ['/d/spec.md'] }]]) {
    x = await run({}, bare(Object.assign({ analystFirst: true }, t)));
    ok(`useCases ${name} -> stopped before any agent`, x.r.status === 'stopped' && x.trace === '' && /useCases/.test(JSON.stringify(x.r.problems)), JSON.stringify(x.r));
  }
  const UCP = '/s/feat/use-cases.md';
  x = await run(Object.assign({}, G, { analyst: [AN] }), bare({ analystFirst: true, useCases: UCP, feature: 'feat' }));
  ok('useCases in the feature folder + analystFirst -> analyst (matrix) > prog > test > review, done', x.r.status === 'done' && x.trace === 'pre>analyst>prog>test>review' && x.r.useCases === UCP, JSON.stringify(x.r));
  ok('useCases: every role prompt names the use cases as context',
    x.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).every((p) => p.prompt.includes(`Use cases of the feature (actors, flows, alternative flows, errors): ${UCP}.`)), x.full);
  ok('useCases: the preconditions check the file exists and has no open questions to the owner', new RegExp(`the use cases ${UCP} exist[^;]*no open questions`).test(roleP(x, 'pre')), roleP(x, 'pre'));
  ok('useCases: every cell of the analyst matrix cites its use case', /every cell cites its use case/.test(roleP(x, 'analyst')), roleP(x, 'analyst'));
  ok('useCases: the tester builds the acceptance along the flows', /acceptance along the flows of the use cases[^.]*main[^.]*alternative[^.]*errors/.test(roleP(x, 'test')), roleP(x, 'test'));
  ok('useCases: the reviewer checks alternative flows and errors are closed', /alternative flows and errors of the use cases/.test(roleP(x, 'review')), roleP(x, 'review'));
  x = await run(G, bare({ noAnalysis: 'tail' }));
  ok('without useCases no use cases line in any prompt', !x.prompts.some((p) => /Use cases of the feature|use cases/.test(p.prompt)), x.full);
  // The analyst agent carries the template.
  const ag = fs.readFileSync(path.join(ROOT, 'agents', 'analyst.md'), 'utf8');
  ok('agents/analyst.md: the use case template and "before the matrix"', /use-cases\.md/.test(ag) && ['Actor', 'Trigger', 'Main flow', 'Alternative flows', 'Errors', 'Out of scope'].every((w) => ag.includes(w)) && /before the matrix/.test(ag));

  // Git post-check: after every tester and reviewer, from the HEAD of the previous committing role.
  const D0 = { verdict: 'done', docsOnly: false, summary: '' };
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  const dp = x.prompts.filter((p) => p.role === 'post' || p.role === 'diff');
  ok('post-check after the tester and the reviewer', x.full === 'pre>prog>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  ok('tester checked from the programmer HEAD, reviewer from the tester HEAD',
    dp.length === 2 && / --since P --role tester/.test(dp[0].prompt) && / --since T --role reviewer( |\n|$)/.test(dp[1].prompt), dp.map((p) => p.prompt).join(' | '));
  ok('post-check runs the plugin script with the tester allow-list from the config',
    dp[0].prompt.includes("node /p/scripts/role-post-check.js --wt /w ") && dp[0].prompt.includes("--allow '-run\\.js$'")
      && dp[1].prompt.includes("node /p/scripts/role-diff-check.js --wt /w ") && !dp[1].prompt.includes('--allow'), dp[0].prompt);

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], diff: [{ ok: false, offending: ['src/a.ts'] }, { ok: false, offending: ['src/a.ts'] }] });
  ok('tester changed product code -> stop, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /src\/a\.ts/.test(x.r.why), JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }],
    diff: [{ ok: true, offending: [] }, { ok: false, offending: ['src/b.ts'] }, { ok: false, offending: ['src/b.ts'] }] });
  ok('reviewer changed code -> not done', x.r.status === 'stopped' && /src\/b\.ts/.test(x.r.why), JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }], diff: [null, null] });
  ok('post-check without a result -> stop (not a silent ok)', x.r.status === 'stopped' && /returned no result/.test(x.r.why) && !x.trace.includes('review'), JSON.stringify(x.r));

  // Leftovers post-check (scripts/role-leftovers-check.js --fix): after every tester and at the end of the task.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0] }, Object.assign({}, T, { stack: 'k-test' }));
  const lp = x.prompts.filter((p) => p.role === 'left' || p.role === 'post');
  ok('leftovers: runs the plugin script with --fix, the stack, the owner stack, the slots dir and the task log (after the tester inside role-post-check.js)',
    lp.length === 2 && lp[0].prompt.includes('node /p/scripts/role-post-check.js --wt /w ') && lp[1].prompt.includes('node /p/scripts/role-leftovers-check.js --wt /w ') && lp.every((p) => p.prompt.includes("--stack 'k-test'")
      && p.prompt.includes("--owner-stack 'own'") && p.prompt.includes("--slots-dir '/slots'") && p.prompt.includes('--fix') && p.prompt.includes("--log '/d/leftovers.md'")), lp.map((p) => p.prompt).join(' | '));
  ok('leftovers: a cheap agent like the git post-check', lp.every((p) => p.opts.agentType === 'general-purpose' && p.opts.model === 'haiku'));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0],
    left: [{ ok: true, found: ['container c1'], removed: ['container c1'], remaining: [] }] });
  ok('leftovers removed after the tester -> the chain goes on, the result names them', x.r.status === 'done' && x.trace.includes('review') && JSON.stringify(x.r.leftovers || {}).includes('container c1'), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }],
    left: [{ ok: false, found: ['process 7'], removed: [], remaining: ['process 7'] }, { ok: false, found: ['process 7'], removed: [], remaining: ['process 7'] }] });
  ok('leftovers that could not be removed after the tester -> stop, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /process 7/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], left: [null, null] });
  ok('leftovers check without a result -> stop (not a silent ok)', x.r.status === 'stopped' && /leftovers[^"]*no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0],
    left: [{ ok: true, found: [], removed: [], remaining: [] }, { ok: false, found: ['slot heavy.1.lock'], removed: [], remaining: ['slot heavy.1.lock'] },
      { ok: false, found: ['slot heavy.1.lock'], removed: [], remaining: ['slot heavy.1.lock'] }] });
  ok('leftovers remaining at the end of the task -> stopped with them', x.r.status === 'stopped' && /heavy\.1\.lock/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [{ ok: false, problems: ['no brief'], blockingQuestions: [] }] });
  ok('stopped at the preconditions -> no leftovers check (nothing started)', !x.prompts.some((p) => p.role === 'left'), x.full);

  // A failed post-check (ok=false or no result) is repeated once by the default model, labelled #retry: a cheap agent
  // sometimes returns ok=false without running the command. The scripts are deterministic: the second answer decides.
  const NOTRUN = { ok: false, offending: [], error: 'the command was not run' };
  const LNOTRUN = { ok: false, found: [], removed: [], remaining: ['the command was not run'], error: 'the command was not run' };
  const LOK = { ok: true, found: [], removed: [], remaining: [] };
  const retries = (x) => x.prompts.filter((p) => /#retry$/.test(p.label));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], diff: [NOTRUN, { ok: true, offending: [] }] });
  ok('diff post-check: ok=false then ok=true on the repeat -> the chain goes on to done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', JSON.stringify(x.r));
  ok('diff post-check repeat: label #retry, same command, default model',
    x.full === 'pre>prog>test>post:x:tester>post:x:tester#retry>review>diff:x:reviewer>left:x:end'
      && retries(x).length === 1 && retries(x)[0].opts.model === undefined && retries(x)[0].prompt === x.prompts.find((p) => p.label === 'post:x:tester').prompt, x.full);
  ok('diff post-check repeat is logged', x.logs.some((m) => /X: .*tester.*post-check.*repeat/i.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], diff: [null, { ok: true, offending: [] }] });
  ok('diff post-check: no result then ok=true -> done', x.r.status === 'done', JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], diff: [{ ok: true, offending: [] }, NOTRUN, { ok: true, offending: [] }] });
  ok('reviewer post-check: ok=false then ok=true -> done', x.r.status === 'done' && retries(x).length === 1 && retries(x)[0].label === 'diff:x:reviewer#retry', x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], diff: [NOTRUN, { ok: false, offending: ['src/c.ts'] }] });
  ok('diff post-check failing twice -> stop with the second answer, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /src\/c\.ts/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], left: [LNOTRUN, LOK] });
  ok('leftovers post-check: ok=false then ok=true on the repeat -> the chain goes on to done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', JSON.stringify(x.r));
  ok('leftovers post-check repeat: label #retry, same command, default model',
    x.full === 'pre>prog>test>post:x:tester>post:x:tester#retry>review>diff:x:reviewer>left:x:end'
      && retries(x).length === 1 && retries(x)[0].opts.model === undefined && retries(x)[0].prompt === x.prompts.find((p) => p.label === 'post:x:tester').prompt, x.full);
  ok('leftovers post-check repeat is logged', x.logs.some((m) => /X: .*leftovers.*post-check.*repeat/i.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], left: [LOK, null, LOK] });
  ok('leftovers at the end: no result then ok=true -> done', x.r.status === 'done' && retries(x).length === 1 && retries(x)[0].label === 'left:x:end#retry', x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], left: [LNOTRUN, { ok: false, found: ['process 9'], removed: [], remaining: ['process 9'] }] });
  ok('leftovers post-check failing twice -> stop with the second answer, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /process 9/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0] });
  ok('passing post-checks are not repeated', !retries(x).length, x.full);

  // Security reviewer (t.security): together with the reviewer (p-review P3), one post-check after both; done only if both are done.
  const TS = Object.assign({}, T, { security: true });
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, TS);
  ok('security: review and sec together, one post-check after both -> done', x.r.status === 'done' && x.full === 'pre>prog>test>post:x:tester>review>sec>diff:x:reviewer>left:x:end', x.full);
  ok('security reviewer reads the threat model from the config', x.prompts.some((p) => p.role === 'sec' && p.prompt.includes('/w/ACCESS.md')));
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }],
    review: [D, D], sec: [{ verdict: 'rejected', docsOnly: false, summary: 'leak' }, D] }, TS);
  ok('security: security rejects while the reviewer is done -> fix, tester, second review', x.r.status === 'done' && x.trace === 'pre>prog>test>review>sec>prog>test>review>sec', x.trace);
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] });
  ok('without security there is no security reviewer', x.r.status === 'done' && !x.trace.includes('sec'), x.trace);

  // Agent types: roles run as plugin agents; pre and diff as general-purpose; the prefix can be switched off.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, TS);
  const types = Object.fromEntries(x.prompts.map((p) => [p.role, p.opts.agentType]));
  ok('agent types: codis-agents:<role> for roles, general-purpose for pre and diff',
    types.prog === 'codis-agents:programmer' && types.test === 'codis-agents:tester' && types.review === 'codis-agents:reviewer'
    && types.sec === 'codis-agents:security-reviewer' && types.pre === 'general-purpose' && types.diff === 'general-purpose' && types.post === 'general-purpose', JSON.stringify(types));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, T, { agentTypePrefix: '' });
  ok('agentTypePrefix "" -> every role general-purpose', x.prompts.every((p) => p.opts.agentType === 'general-purpose'));

  // Config and task defaults.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, { key: 'k', title: 'K', wt: 'k-wt', branch: 'b', accept: 'a', noAnalysis: 'n' });
  const pp = x.prompts.find((p) => p.role === 'prog').prompt;
  ok('task defaults: dir = <sharedDir>/<key>, wt under worktreeRoot, guards-all gets wt', pp.includes('/s/k/prog.md') && pp.includes('Worktree /r/k-wt') && pp.includes('/p/scripts/guards-all.sh k-wt'), pp);
  ok('project notes reach only their role', pp.includes('rebuild the bundle') && !x.prompts.find((p) => p.role === 'test').prompt.includes('rebuild the bundle'));
  ok('reports in the configured language', pp.includes('in Russian'));
  let threw = '';
  try { await run({}, T, { config: { sharedDir: '/s' } }); } catch (e) { threw = e.message; }
  ok('missing config -> clear error before any agent', /args\.config\.worktreeRoot is missing/.test(threw), threw);

  // A tester with its own stack tears it down with its images and volumes; the owner's stack and shared images stay.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, Object.assign({}, T, { stack: 'k-test' }));
  const tp = x.prompts.find((p) => p.role === 'test').prompt;
  ok('tester prompt: own stack torn down with images and volumes (docker compose -p <stack> down -v --rmi all)', tp.includes('docker compose -p k-test down -v --rmi all'), tp);
  ok('every role prompt: the owner\'s stack images are never removed, nor other images or the build cache', x.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).every((p) => /[Nn]ever remove[^.]*owner's stack[^.]*other images[^.]*build cache/.test(p.prompt)));
  // The project's shared stand: the tester checks image-diff, takes the ticket in the background, deploys, releases.
  const STANDCFG = Object.assign({}, CFG, { stand: { project: 'p-dev', ports: [3101] } });
  const xst = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, T, { config: STANDCFG });
  const tst = xst.prompts.find((p) => p.role === 'test').prompt;
  ok('tester prompt with a stand: image-diff, take in the background, deploy, release', /stand\.sh image-diff --wt '[^']+' --base /.test(tst) && /stand\.sh take --wt '[^']+' with run_in_background/.test(tst)
    && /stand\.sh deploy '/.test(tst) && /stand\.sh release --wt '/.test(tst) && tst.includes('p-dev'), tst);
  ok('tester prompt with a stand: every stand command from one directory (its config is found there, not in the worktree)', /Call every stand\.sh command from one directory/.test(tst), tst);
  ok('tester prompt with a stand: release also after a red; a refused take is an environment red', /also after a red/.test(tst) && /environment red/.test(tst), tst);
  ok('tester prompt with a stand and no stack: changed image files -> a question to the coordinator', /❓ coordinator: own stack needed/.test(tst), tst);
  const xst2 = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, Object.assign({}, T, { stack: 'k-test' }), { config: STANDCFG });
  const tst2 = xst2.prompts.find((p) => p.role === 'test').prompt;
  ok('tester prompt with a stand and a stack: own stack only when the stand does not fit', /Only when the stand does not fit, your own stack: docker compose -p k-test/.test(tst2), tst2);
  ok('tester prompt without a stand: no stand steps', !/stand\.sh/.test(tp));
  ok('every role prompt with a stand names it in the stand rule', xst.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).every((p) => /Shared stand: acceptance in Docker goes to the project's stand p-dev/.test(p.prompt)));
  // One full guard run per task (owner 2026-10-20: "yes, we make both changes"): with guardSubsetCommand in the config
  // the programmer runs only the selected guards (scripts/guards-select.js), the workflow runs ONE full run on its last
  // HEAD as a wait step (scripts/wait-step.js, a cheap agent), a red run goes back to the programmer with its log, the
  // tester reuses the log and runs no full run. Without the key the chain is as before (the programmer's own full run).
  // p-train-a2 (2026-10-29): the full run step became the selection step (guards-all.sh --select <base>), and with the
  // key the task needs base (the branch of the arc): TB below.
  const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'cd {wt}/server && npm run guards -- --all {onlyArgs}' });
  const TB = Object.assign({}, T, { base: 'arc' });
  const G1 = () => ({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] });
  const RUN_RED = { done: true, rc: 1, seconds: 900, log: '/d/wait-select-1.log', tail: 'FAIL x-run.js' };
  const RUN_OK = { done: true, rc: 0, seconds: 900, log: '/d/wait-select-1f.log', tail: 'ok' };
  const runsOf = (x) => x.prompts.filter((p) => p.role === 'run');
  const pOf = (x, role, i = 0) => (x.prompts.filter((p) => p.role === role)[i] || {}).prompt || '';
  x = await run(G1(), TB, { config: ONE });
  ok('one run: pre > prog > the full run step > tester > review, done',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  const rp = runsOf(x)[0];
  ok('the full run step: a cheap agent runs wait-step.js start with guards-all.sh on the worktree, then waits in slices of at most 270 s',
    rp && rp.opts.model === 'haiku' && rp.opts.agentType === 'general-purpose' && rp.prompt.includes("node /p/scripts/wait-step.js start --id '/d/wait-select-1' --cwd '/w'")
      && rp.prompt.includes('/p/scripts/guards-all.sh') && rp.prompt.includes('wait-step.js wait') && /--max 270/.test(rp.prompt), rp && rp.prompt);
  // C1 (p-wait, form 1): the full run of the wait step includes the selection (guardSubsetCommand narrows guardCommand),
  // so the programmer runs no selection after its mutations: no guards-select, no heavy.sh for it in its Order line.
  const orderOf = (pr) => (pr.match(/^Order:.*$/m) || [''])[0];
  ok('C1. programmer prompt (one run): no selection of its own and no full run - the workflow runs the full run, which includes the selection',
    orderOf(pOf(x, 'prog')) && !/guards-select/.test(orderOf(pOf(x, 'prog'))) && !/heavy\.sh zsh -c/.test(orderOf(pOf(x, 'prog')))
      && /there is no full guard run in the task/.test(orderOf(pOf(x, 'prog'))) && /the workflow runs the selection/.test(orderOf(pOf(x, 'prog')))
      && !/full run \/p\/scripts\/guards-all\.sh w in the background/.test(pOf(x, 'prog')), orderOf(pOf(x, 'prog')));
  ok('C7. the full run step is one guards-all.sh, without guards-select', runsOf(x).length === 1 && !/guards-select/.test(runsOf(x)[0].prompt), runsOf(x)[0].prompt);
  ok('C4. programmer schema (one run): fullRun is not "the selected guards\' result"',
    !/selected guards/.test(x.prompts.find((p) => p.role === 'prog').opts.schema.properties.fullRun.description), x.prompts.find((p) => p.role === 'prog').opts.schema.properties.fullRun.description);
  // W5 (p-wait D1): the waiter of the full run never gives up while the run is alive; only done:true returns the schema.
  ok('W5. the wait step prompt: keep waiting while done:false whatever the tail or the time; return only on done:true',
    /an unchanged tail[^.]*not a reason to stop/.test(rp.prompt) && /[Rr]eturn the schema only once [^.]*"done":true/.test(rp.prompt)
      && /[Nn]ever return "done":false/.test(rp.prompt) && /"alive":true/.test(rp.prompt), rp.prompt);
  ok('W1. the wait step schema carries alive and pid', !!(rp.opts.schema.properties.alive && rp.opts.schema.properties.pid), JSON.stringify(rp.opts.schema.properties));
  // W14 (p-wait D1): a long slot queue is not the environment; a refusal of the queue (77/78) or a vanished waiter is.
  ok('W14. tester prompt: no "no memory slot within your time"; the environment is a refused queue (77, 78) or a vanished waiter; a live queue is waited for',
    !/within your time/.test(pOf(x, 'test')) && /77/.test(pOf(x, 'test')) && /78/.test(pOf(x, 'test')) && /alive in the queue/.test(pOf(x, 'test')), pOf(x, 'test'));
  ok('W14. programmer schema: status environment names the refused queue (77, 78), not "no slot"',
    /77/.test(x.prompts.find((p) => p.role === 'prog').opts.schema.properties.status.description) && !/no slot/.test(x.prompts.find((p) => p.role === 'prog').opts.schema.properties.status.description));
  // H2 (p-wait D2): every sentence of every prompt that names heavy.sh says run_in_background.
  const heavyBlocking = (ps) => ps.flatMap((p) => p.prompt.split(/(?<=[.:])\s+(?=[A-Z0-9])|\n/).filter((sen) => /heavy\.sh/.test(sen) && !/run_in_background/.test(sen)).map((sen) => p.label + ': ' + sen));
  ok('H2. one run: every sentence that names heavy.sh says run_in_background', !heavyBlocking(x.prompts).length, heavyBlocking(x.prompts).join(' | '));
  ok('tester prompt (one run): reuses the workflow full run log, runs no full run itself',
    pOf(x, 'test').includes('exit 0; summary /d/wait.log') && /no full guard run in the task/i.test(pOf(x, 'test')) && !/a full run only after your own commits/.test(pOf(x, 'test')), pOf(x, 'test'));
  ok('the task base reaches the selection when given', /--select 'origin-x'/.test(pOf(await run(G1(), Object.assign({}, TB, { base: 'origin-x' }), { config: ONE }), 'prog')));
  x = await run(G1());
  ok('without guardSubsetCommand: no full run step, the programmer runs the full run itself as before',
    !runsOf(x).length && /full run \/p\/scripts\/guards-all\.sh w in the background/.test(pOf(x, 'prog')) && /a full run only after your own commits/.test(pOf(x, 'test')), x.full);
  ok('H2. without guardSubsetCommand: every sentence that names heavy.sh says run_in_background', !heavyBlocking(x.prompts).length, heavyBlocking(x.prompts).join(' | '));

  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], run: [RUN_RED, RUN_OK], test: [{ verdict: 'green', summary: '' }], review: [D] }, TB, { config: ONE });
  ok('a red full run -> a programmer round with its log -> the full run again -> tester',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>prog>run:x:select-1f>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  ok('the fix round gets the exit code, the summary and the copied full log', /exited 1/.test(pOf(x, 'prog', 1)) && pOf(x, 'prog', 1).includes('/d/wait-select-1.log') && pOf(x, 'prog', 1).includes('/d/wait-select-1.guards.txt') && /selection log/.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));
  const nfLine = (pOf(x, 'prog', 1).match(/^The selection of the task's guards the workflow ran.*$/m) || [''])[0];
  ok('C3. the fix round after a red full run: no "selected guards" (the workflow runs the full run again)', nfLine && !/selected guards/.test(nfLine) && /mutations after the commit/.test(nfLine), nfLine);
  ok('W14. the fix round: the environment is a refused queue (77, 78), not "no slot"', !/no slot/.test(pOf(x, 'prog', 1)) && /77/.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));
  ok('the tester post-check starts from the HEAD of the fix', / --since P2 --role tester/.test(pOf(x, 'post')), pOf(x, 'post'));
  x = await run({ pre: [PRE], prog: [PROG, PROG], run: [RUN_RED], test: [{ verdict: 'green', summary: '' }], review: [D] }, TB, { config: ONE });
  ok('a red full run the programmer explains without a commit -> no second run, the tester gets the red log',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>prog>test>post:x:tester>review>diff:x:reviewer>left:x:end' && /exit 1/.test(pOf(x, 'test')), x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' }), Object.assign({}, PROG, { head: 'P3' })], run: [RUN_RED, RUN_RED, RUN_RED] }, TB, { config: ONE });
  ok('the full run still red after two fix rounds -> stopped for the coordinator, no tester',
    x.r.status === 'stopped' && !x.trace.includes('test') && /selection.*still red/.test(x.r.why) && runsOf(x).length === 3, JSON.stringify(x.r) + ' ' + x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { status: 'environment', questions: [], summary: 'the run was cut off at 40 %' })], run: [RUN_RED] }, TB, { config: ONE });
  ok('the programmer names the red of the full run an environment red -> stopped for the coordinator, no tester',
    x.r.status === 'stopped' && !x.trace.includes('test') && /environment/.test(x.r.why) && /cut off at 40 %/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [Object.assign({}, PROG, { status: 'environment', summary: 'no heavy slot for 2 h' })] });
  ok('the first programmer round says environment -> stopped for the coordinator, no full run, no tester',
    x.r.status === 'stopped' && x.trace === 'pre>prog' && /no heavy slot for 2 h/.test(x.r.why) && !runsOf(x).length, JSON.stringify(x.r));
  ok('programmer schema: status environment exists', (x.prompts.find((p) => p.role === 'prog').opts.schema.properties.status.enum || []).includes('environment'));

  // "Could not run" only without a numeric exit code (a red run is a step that ran; e2g2, 2026-10-19).
  x = await run({ pre: [PRE], prog: [PROG, PROG], run: [Object.assign({}, RUN_RED, { error: 'two guards failed' })], test: [{ verdict: 'green', summary: '' }], review: [D] }, TB, { config: ONE });
  ok('a red run whose agent wrote an error text is still a step that ran: its log goes to the programmer', x.r.status === 'done' && x.trace === 'pre>prog>prog>test>review', x.full);
  x = await run(Object.assign(G1(), { run: [{ done: false, rc: null, log: '/d/wait-select-1.log', error: 'no JSON' }, RUN_OK] }), TB, { config: ONE });
  ok('a step without an exit code is repeated once by the default model with --reuse; ok on the repeat -> the chain goes on',
    x.r.status === 'done' && runsOf(x).length === 2 && runsOf(x)[1].label === 'run:x:select-1#retry' && runsOf(x)[1].opts.model === undefined && /--reuse/.test(runsOf(x)[1].prompt) && !/--reuse/.test(runsOf(x)[0].prompt), x.full);
  x = await run({ pre: [PRE], prog: [PROG], run: [{ done: true, rc: null, log: '/d/l', error: 'the process ended without an exit code' }, { done: true, rc: null, log: '/d/l', error: 'the process ended without an exit code' }] }, TB, { config: ONE });
  ok('no exit code twice -> stopped for the coordinator (could not run), no programmer round', x.r.status === 'stopped' && /could not run/.test(x.r.why) && x.trace === 'pre>prog', JSON.stringify(x.r));
  // W6-W8 (p-wait D1): the deadline of the wait step (124) and a refusal of the slot queue before the run (77 slot
  // directory, 78 config/swap/main checkout, 72/73 no ps/pgrep or mktemp - coordinator, BRIEF 2026-10-24) are the
  // environment: the task stops for the coordinator, no programmer round #nf, no tester, no repeat of the step.
  for (const rc of [124, 77, 78, 72, 73]) {
    x = await run({ pre: [PRE], prog: [PROG], run: [{ done: true, rc, seconds: 14401, log: '/d/wait-select-1.log', tail: 'position 3', error: rc === 124 ? 'deadline of 14400 s passed' : '' }] }, TB, { config: ONE });
    ok(`W6-8. full run exit ${rc} -> stopped with environment, the log in the reason, no programmer round, no tester`,
      x.r.status === 'stopped' && x.trace === 'pre>prog' && runsOf(x).length === 1 && /environment/.test(x.r.why) && new RegExp(`exit ${rc}`).test(x.r.why)
        && x.r.why.includes('/d/wait-select-1.log') && !!x.r.environment, JSON.stringify(x.r) + ' ' + x.full);
  }
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], run: [RUN_RED, { done: true, rc: 124, seconds: 14401, log: '/d/wait-select-1f.log', tail: '', error: 'deadline' }] }, TB, { config: ONE });
  ok('W6. the deadline on the run after a fix round -> stopped with environment, no third programmer round',
    x.r.status === 'stopped' && x.trace === 'pre>prog>prog' && /environment/.test(x.r.why), JSON.stringify(x.r) + ' ' + x.full);
  x = await run({ pre: [PRE], prog: [PROG, PROG], run: [Object.assign({}, RUN_RED, { rc: 2 })], test: [{ verdict: 'green', summary: '' }], review: [D] }, TB, { config: ONE });
  ok('W9. any other non-zero exit (2) is the product: a programmer round with the log', x.r.status === 'done' && x.trace === 'pre>prog>prog>test>review', x.full);
  x = await run({ pre: [PRE], prog: [PROG], run: [{ done: true, rc: 77, seconds: 3, log: '/d/l', tail: '' }] }, Object.assign({}, TB, { mode: 'light' }), { config: ONE });
  ok('W7. light mode: a refused queue -> stopped with environment, no review', x.r.status === 'stopped' && x.trace === 'pre>prog' && /environment/.test(x.r.why), JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }], review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }, D] }, TB, { config: ONE });
  ok('a review fix on the HEAD whose full run is done (no new commit) -> no second full run', runsOf(x).length === 1 && x.r.status === 'done', x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }], review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }, D] }, TB, { config: ONE });
  ok('a review fix for code with a new commit -> one full run on it before the tester', runsOf(x).length === 2 && x.full.includes('review>diff:x:reviewer>prog>run:x:select-r>test'), x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, DOCS, { head: 'P2' })], test: [{ verdict: 'green', summary: '' }], review: [DOCS_REJ, D] }, TB, { config: ONE });
  ok('S8. a docs-only fix (docs and guard files) with a new commit -> the selection on its HEAD, second review', runsOf(x).length === 2 && x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', head: 'T2', summary: '' }], review: [D] }, TB, { config: ONE });
  ok('the tester commits guards -> no full run after the tester', runsOf(x).length === 1, x.full);

  // Light mode (owner 2026-10-20): one programmer-checker, the full run step, one reviewer; no tester role.
  const L = Object.assign({}, TB, { mode: 'light' });
  x = await run({ pre: [PRE], prog: [PROG], review: [D] }, L, { config: ONE });
  ok('light: pre > programmer-checker > full run > review > done, no tester and no tester post-checks',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>left:x:end' && x.r.mode === 'light', x.full + ' ' + JSON.stringify(x.r));
  const lp0 = pOf(x, 'prog');
  ok('light: the programmer-checker prompt - red guard, code, mutations after the commit, own acceptance with evidence in test.md',
    /PROGRAMMER-CHECKER/.test(lp0) && /red guard/.test(lp0) && /mutations AFTER the commit/.test(lp0) && lp0.includes('/d/test.md') && lp0.includes('acc') && /evidence/.test(lp0), lp0);
  ok('light: the reviewer is told there is no tester role and checks the evidence in test.md', /light mode/.test(pOf(x, 'review')) && pOf(x, 'review').includes('test.md'), pOf(x, 'review'));
  ok('light: the reviewer post-check starts from the programmer HEAD', / --since P --role reviewer/.test(pOf(x, 'diff')), pOf(x, 'diff'));
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }, D] }, L, { config: ONE });
  ok('light: rejection -> programmer round -> full run -> second review -> done',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>prog>run:x:select-r>review>diff:x:reviewer>left:x:end', x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], review: [{ verdict: 'rejected', docsOnly: false, summary: 'r1' }, { verdict: 'rejected', docsOnly: false, summary: 'r2' }] }, L, { config: ONE });
  ok('light: second rejection -> stopped for the coordinator with the proposal to relaunch in the full mode, no analyst',
    x.r.status === 'stopped' && !x.trace.includes('analyst') && /full mode/.test(x.r.why) && /r2/.test(x.r.review || ''), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], run: [RUN_RED, RUN_OK], review: [D] }, L, { config: ONE });
  ok('light: a red full run -> programmer round with the log -> full run -> review', x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>prog>run:x:select-1f>review>diff:x:reviewer>left:x:end', x.full);
  ok('C2. light (one run): the Order line runs no selection and no full run, then the own acceptance',
    !/guards-select/.test(orderOf(lp0)) && !/heavy\.sh zsh -c/.test(orderOf(lp0)) && /the workflow runs the selection/.test(orderOf(lp0)) && /your own acceptance/.test(orderOf(lp0)), orderOf(lp0));
  x = await run({ pre: [PRE], prog: [PROG], review: [D] }, L);
  ok('light without guardSubsetCommand: no run step, the programmer-checker runs the full run itself',
    x.r.status === 'done' && !runsOf(x).length && /full run \/p\/scripts\/guards-all\.sh w in the background/.test(pOf(x, 'prog')), x.full);
  for (const [name, t] of [['an unknown mode', { mode: 'fast' }], ['light with security', { mode: 'light', security: true }], ['light with a stack', { mode: 'light', stack: 'k-test' }]]) {
    x = await run({}, Object.assign({}, TB, t), { config: ONE });
    ok(`${name} -> stopped before any agent`, x.r.status === 'stopped' && x.trace === '' && /mode/.test(JSON.stringify(x.r.problems)), JSON.stringify(x.r));
  }
  x = await run(G1(), Object.assign({}, TB, { mode: 'full' }), { config: ONE });
  ok('mode full is the default chain', x.r.status === 'done' && x.trace === 'pre>prog>test>review', x.trace);

  // One source of role rules: markers in rules/multi-agent.md <-> RULE_LIST <-> the prompt of every role.
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  const marked = [...rules.matchAll(/<!-- role:([\w-]+) -->/g)].map((m) => m[1]);
  const ruleList = await new AsyncFunction('args', SRC.slice(0, SRC.indexOf('const PRE_SCHEMA')) + '\nreturn RULE_LIST(TASKS[0])')({ owner: 'o', config: CFG, tasks: [T] });
  const ids = ruleList.map((r) => r[0]);
  ok('rules/multi-agent.md has marked lines', marked.length >= 5, String(marked.length));
  const missing = marked.filter((m) => !ids.includes(m));
  ok('every marked line of rules/multi-agent.md is in RULE_LIST', !missing.length, missing.join(','));
  const orphan = ids.filter((i) => !i.startsWith('local-') && !marked.includes(i));
  ok('every rule (except local-*) has a marker in rules/multi-agent.md', !orphan.length, orphan.join(','));
  const ruleOf = (id) => (ruleList.find((r) => r[0] === id) || ['', ''])[1];
  // H1 (p-wait D2): heavy.sh and guards-all.sh only through Bash run_in_background - the Bash timeout kills a blocking
  // waiter, its ticket is dropped by the trap and it rejoins the queue at the end (24 heavy single jobs with rc 143).
  ok('H1. rule slots: heavy.sh and guards-all.sh only through Bash run_in_background, Monitor slices, never a blocking Bash call',
    /run_in_background/.test(ruleOf('slots')) && /never (as )?a blocking Bash call/.test(ruleOf('slots')) && /270 s/.test(ruleOf('slots')), ruleOf('slots'));
  // P3 (p-wait D3): the pause rule says what the chain accepts: a role does not end its work to wait.
  ok('P3. rule pauses: no "finish" for a long wait; a role keeps waiting while its process is alive and does not end its work to wait',
    !/finish/.test(ruleOf('pauses')) && /while your (own )?process is alive/.test(ruleOf('pauses')) && /do not end your work to wait/.test(ruleOf('pauses')) && /270 s/.test(ruleOf('pauses')), ruleOf('pauses'));
  const ruleListOne = await new AsyncFunction('args', SRC.slice(0, SRC.indexOf('const PRE_SCHEMA')) + '\nreturn RULE_LIST(TASKS[0])')({ owner: 'o', config: ONE, tasks: [T] });
  const onerunOne = (ruleListOne.find((r) => r[0] === 'onerun') || ['', ''])[1];
  ok('C5. rule onerun (one run): the programmer runs no selection, the tester runs it after its own commits',
    /programmer runs only its new guards and mutations/.test(onerunOne) && /tester, after its own commits, runs[^.]*selection/.test(onerunOne), onerunOne);
  ok('C6. meta phases: the programmer runs no selected guards', !/selected guards/.test(SRC.match(/title: 'Programmer', detail: '([^']*)'/)[1]), SRC.match(/title: 'Programmer', detail: '([^']*)'/)[1]);
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: Array(3).fill({ verdict: 'green', summary: '' }), analyst: [AN, AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] },
    bare({ analystFirst: true }));
  const roles = new Set(x.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).map((p) => p.role));
  const xs = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, TS);
  const secLack = xs.prompts.filter((p) => p.role === 'sec').flatMap((p) => ruleList.filter((r) => !p.prompt.includes(r[1])).map((r) => p.label + ':' + r[0]));
  ok('the security reviewer prompt carries every rule', xs.prompts.some((p) => p.role === 'sec') && !secLack.length, secLack.join(','));
  const lacking = x.prompts.filter((p) => !['diff', 'left', 'post'].includes(p.role)).flatMap((p) => ruleList.filter((r) => !p.prompt.includes(r[1])).map((r) => p.label + ':' + r[0]));
  ok('the prompt of every role (pre, analyst, prog, test, review) carries every rule', roles.size === 5 && !lacking.length, [...roles].join(',') + ' ' + lacking.join(','));

  // roleModel / roleModels (owner 2026-10-22: the coordinator on one model, the role agents no higher than the one the
  // config names): roleModel is passed as opts.model of every role agent; roleModels overrides it per role; the cheap
  // checks keep 'haiku' on their first attempt, and their repeat gets the model of 'wait'; without the keys no role
  // agent gets a model (it inherits the main session's, as before).
  const ROLE_LABELS = ['pre', 'analyst', 'usecases', 'prog', 'test', 'review', 'sec'];
  const SERVICE = ['post', 'diff', 'left', 'run'];
  // Every kind of agent in one task: analyst first, a security review, the one-run step and a repeat of each check.
  const allAgents = async (cfgExtra, task) => {
    const cfg = Object.assign({}, CFG, { guardSubsetCommand: 'cd {wt}/server && npm run guards -- --all {onlyArgs}' }, cfgExtra);
    const y = await run({ pre: [PRE], analyst: [AN], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D],
      run: [{ done: false, rc: null, log: '/d/l', error: 'no JSON' }, { done: true, rc: 0, seconds: 1, log: '/d/l', tail: 'ok' }],
      // the tester's post (diff + left, then its repeat), the reviewers' diff and its repeat, the end's left and its repeat
      diff: [{ ok: false, offending: [], error: 'not run' }, { ok: true, offending: [] }, { ok: false, offending: [], error: 'not run' }, { ok: true, offending: [] }],
      left: [{ ok: false, found: [], removed: [], remaining: ['x'], error: 'not run' }, { ok: true, found: [], removed: [], remaining: [] },
        { ok: false, found: [], removed: [], remaining: ['x'], error: 'not run' }, { ok: true, found: [], removed: [], remaining: [] }] },
    task || bare({ analystFirst: true, security: true, base: 'arc' }), { config: cfg });
    const uc = await run({ pre: [PRE], usecases: [{ ready: true, useCases: 1, questions: [], summary: 'u' }] },
      bare({ analystFirst: true, useCasesFirst: true, base: 'arc' }), { config: cfg });
    return y.prompts.concat(uc.prompts);
  };
  const rolesOf = (ps) => ps.filter((p) => ROLE_LABELS.includes(p.role));
  const firstChecks = (ps) => ps.filter((p) => SERVICE.includes(p.role) && !/#retry$/.test(p.label));
  const retryChecks = (ps) => ps.filter((p) => SERVICE.includes(p.role) && /#retry$/.test(p.label));
  const models = (ps) => ps.map((p) => `${p.label}=${p.opts.model}`).join(' ');
  let ap = await allAgents({ roleModel: 'opus' });
  ok('roleModel: the scenario reaches every role agent (pre, analyst, use cases, programmer, tester, reviewer, security reviewer)',
    ROLE_LABELS.every((r) => rolesOf(ap).some((p) => p.role === r)), [...new Set(rolesOf(ap).map((p) => p.role))].join());
  ok('roleModel "opus": every role agent gets model opus', rolesOf(ap).every((p) => p.opts.model === 'opus'), models(rolesOf(ap)));
  ok('roleModel "opus": the first attempt of every check and wait step stays haiku', firstChecks(ap).length >= 3 && firstChecks(ap).every((p) => p.opts.model === 'haiku'), models(firstChecks(ap)));
  ok('roleModel "opus": the repeat of a check or wait step gets opus, not the main session model',
    SERVICE.every((r) => retryChecks(ap).some((p) => p.role === r)) && retryChecks(ap).every((p) => p.opts.model === 'opus'), models(retryChecks(ap)));
  ap = await allAgents({ roleModel: 'fable' }, Object.assign({}, T, { mode: 'light', base: 'arc' }));
  ok('roleModel: the light-mode programmer-checker gets it too', ap.filter((p) => p.role === 'prog').every((p) => p.opts.model === 'fable') && ap.some((p) => p.role === 'prog' && /PROGRAMMER-CHECKER/.test(p.prompt)), models(ap));
  ap = await allAgents({ roleModel: 'opus', roleModels: { reviewer: 'sonnet', 'security-reviewer': 'fable', programmer: 'haiku', analyst: 'sonnet', tester: 'sonnet', preconditions: 'haiku', wait: 'sonnet' } });
  const want = { pre: 'haiku', analyst: 'sonnet', usecases: 'sonnet', prog: 'haiku', test: 'sonnet', review: 'sonnet', sec: 'fable' };
  ok('roleModels overrides roleModel per role', rolesOf(ap).every((p) => p.opts.model === want[p.role]), models(rolesOf(ap)));
  ok('roleModels.wait: the repeat of a check or wait step', retryChecks(ap).length >= 3 && retryChecks(ap).every((p) => p.opts.model === 'sonnet'), models(retryChecks(ap)));
  ap = await allAgents({ roleModels: { reviewer: 'sonnet' } });
  ok('roleModels without roleModel: only the named role gets a model', rolesOf(ap).every((p) => (p.role === 'review' ? p.opts.model === 'sonnet' : !('model' in p.opts))) && retryChecks(ap).every((p) => !('model' in p.opts)), models(rolesOf(ap)));
  ap = await allAgents({});
  ok('no roleModel: no role agent and no repeat gets a model (inherited, as before)', rolesOf(ap).concat(retryChecks(ap)).every((p) => !('model' in p.opts)), models(rolesOf(ap).concat(retryChecks(ap))));
  ok('no roleModel: the first attempts of the checks stay haiku', firstChecks(ap).every((p) => p.opts.model === 'haiku'), models(firstChecks(ap)));

  // B8: the push rule names the project's protected branches (derived from git by config.js), never a literal main.
  const pushLine = async (cfg) => {
    const y = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, T, { config: Object.assign({}, CFG, cfg) });
    const pp = y.prompts.find((p) => p.role === 'prog');
    return ((pp && pp.prompt) || '').split('\n').find((l) => /^Do not push/.test(l)) || '';
  };
  let pl = await pushLine({ protectedBranches: ['master'] });
  ok('B8 protectedBranches [master] -> "do not merge into master", no main', /do not merge into master\b/.test(pl) && !/\bmain\b/.test(pl), pl);
  pl = await pushLine({ protectedBranches: null, defaultBranch: null, defaultBranchUnknown: 'refs/remotes/origin/HEAD is not set' });
  ok('B8 protected branches unknown -> no main, the rule says every branch push is refused and why', !/\bmain\b/.test(pl)
    && /unknown/.test(pl) && /origin\/HEAD is not set/.test(pl), pl);
  pl = await pushLine({ protectedBranches: [], defaultBranch: 'master', defaultBranchUnknown: '' });
  ok('B8 explicit protectedBranches [] -> no branch is protected, the rule does not claim every branch push is refused',
    !/unknown|refuse every branch push/.test(pl) && /no branch is protected/.test(pl) && /do not create tags/.test(pl), pl);

  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
