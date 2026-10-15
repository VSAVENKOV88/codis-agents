#!/usr/bin/env node
'use strict';
// Logic of workflows/role-chain.js: the script runs with fake agent()/pipeline()/log() and scripted role verdicts; the
// test checks the order of roles and the outcome (rules/multi-agent.md: a red tester goes back to the programmer
// without a review; a rejection for docs (confirmed by changedFiles) gets a second review without the tester; a second
// rejection for code brings the analyst into the same run; preconditions or open questions stop before the
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
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const DOCS = Object.assign({}, PROG, { changedFiles: ['docs/GAPS.md'] });
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };

// script: a queue of answers per role; trace - the order of calls.
// A tester verdict without head gets head 'T'; the post-check (diff) is ok by default and not in trace (its order is in full).
async function run(script, task = T, extra = {}) {
  const trace = [], full = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(role === 'diff' || role === 'left' ? opts.label : role);
    if (role === 'diff') return q.diff && q.diff.length ? q.diff.shift() : { ok: true, offending: [] };
    if (role === 'left') return q.left && q.left.length ? q.left.shift() : { ok: true, found: [], removed: [], remaining: [] };
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it).catch(() => null)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, () => {}, () => {}, Object.assign({ owner: 'o', config: CFG, tasks: [task] }, extra));
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts };
}

(async () => {
  let x;
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  ok('green path: pre>prog>test>review -> done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', x.trace);

  x = await run({ pre: [{ ok: true, problems: [], blockingQuestions: ['q'] }] });
  ok('open question to the owner -> stop before the programmer', x.r.status === 'stopped' && x.trace === 'pre', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'red', summary: '' }, { verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  ok('red tester -> programmer without review', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: [{ verdict: 'red' }, { verdict: 'red' }, { verdict: 'red', summary: '' }].map((v) => Object.assign({ summary: '' }, v)) });
  ok('three red testers -> stop, no review', x.r.status === 'stopped' && !x.trace.includes('review'), x.trace);

  x = await run({ pre: [PRE], prog: [PROG, DOCS], test: [{ verdict: 'green', summary: '' }],
    review: [{ verdict: 'rejected', docsOnly: true, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('rejection for docs, fix only .md -> second review without the tester', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }],
    review: [{ verdict: 'rejected', docsOnly: true, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('rejection "for docs" but the fix touches code -> tester before the second review', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: Array(3).fill({ verdict: 'green', summary: '' }), analyst: [AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] });
  ok('second rejection for code -> analyst in the same run -> round -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review>analyst>prog>test>review', x.trace);

  x = await run({ pre: [PRE], prog: [PROG, PROG], test: Array(2).fill({ verdict: 'green', summary: '' }), analyst: [Object.assign({}, AN, { split: ['a', 'b'] })],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }] });
  ok('analyst proposes a split -> stop for the coordinator', x.r.status === 'stopped' && x.r.split && x.r.split.length === 2, JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [Object.assign({}, PROG, { status: 'blocked', questions: ['q'] })] });
  ok('programmer blocked -> stop with the question, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog', x.trace);

  x = await run({ pre: [PRE], analyst: [Object.assign({}, AN, { cells: 40, split: ['a'] })] }, Object.assign({}, T, { analystFirst: true }));
  ok('analystFirst: split -> stop before the programmer', x.r.status === 'stopped' && x.trace === 'pre>analyst', x.trace);

  // Git post-check: after every tester and reviewer, from the HEAD of the previous committing role.
  const D0 = { verdict: 'done', docsOnly: false, summary: '' };
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }] });
  const dp = x.prompts.filter((p) => p.role === 'diff');
  ok('post-check after the tester and the reviewer', x.full === 'pre>prog>test>diff:x:tester>left:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  ok('tester checked from the programmer HEAD, reviewer from the tester HEAD',
    dp.length === 2 && / --since P --role tester/.test(dp[0].prompt) && / --since T --role reviewer( |\n|$)/.test(dp[1].prompt), dp.map((p) => p.prompt).join(' | '));
  ok('post-check runs the plugin script with the tester allow-list from the config',
    dp[0].prompt.includes("node /p/scripts/role-diff-check.js --wt /w ") && dp[0].prompt.includes("--allow '-run\\.js$'") && !dp[1].prompt.includes('--allow'), dp[0].prompt);

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], diff: [{ ok: false, offending: ['src/a.ts'] }] });
  ok('tester changed product code -> stop, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /src\/a\.ts/.test(x.r.why), JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }],
    diff: [{ ok: true, offending: [] }, { ok: false, offending: ['src/b.ts'] }] });
  ok('reviewer changed code -> not done', x.r.status === 'stopped' && /src\/b\.ts/.test(x.r.why), JSON.stringify(x.r));

  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [{ verdict: 'done', docsOnly: false, summary: '' }], diff: [null] });
  ok('post-check without a result -> stop (not a silent ok)', x.r.status === 'stopped' && /returned no result/.test(x.r.why) && !x.trace.includes('review'), JSON.stringify(x.r));

  // Leftovers post-check (scripts/role-leftovers-check.js --fix): after every tester and at the end of the task.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0] }, Object.assign({}, T, { stack: 'k-test' }));
  const lp = x.prompts.filter((p) => p.role === 'left');
  ok('leftovers: runs the plugin script with --fix, the stack, the owner stack, the slots dir and the task log',
    lp.length === 2 && lp.every((p) => p.prompt.includes('node /p/scripts/role-leftovers-check.js --wt /w ') && p.prompt.includes("--stack 'k-test'")
      && p.prompt.includes("--owner-stack 'own'") && p.prompt.includes("--slots-dir '/slots'") && p.prompt.includes('--fix') && p.prompt.includes("--log '/d/leftovers.md'")), lp.map((p) => p.prompt).join(' | '));
  ok('leftovers: a cheap agent like the git post-check', lp.every((p) => p.opts.agentType === 'general-purpose' && p.opts.model === 'haiku'));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0],
    left: [{ ok: true, found: ['container c1'], removed: ['container c1'], remaining: [] }] });
  ok('leftovers removed after the tester -> the chain goes on, the result names them', x.r.status === 'done' && x.trace.includes('review') && JSON.stringify(x.r.leftovers || {}).includes('container c1'), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }],
    left: [{ ok: false, found: ['process 7'], removed: [], remaining: ['process 7'] }] });
  ok('leftovers that could not be removed after the tester -> stop, no review', x.r.status === 'stopped' && !x.trace.includes('review') && /process 7/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0], left: [null] });
  ok('leftovers check without a result -> stop (not a silent ok)', x.r.status === 'stopped' && /leftovers[^"]*no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D0],
    left: [{ ok: true, found: [], removed: [], remaining: [] }, { ok: false, found: ['slot heavy.1.lock'], removed: [], remaining: ['slot heavy.1.lock'] }] });
  ok('leftovers remaining at the end of the task -> stopped with them', x.r.status === 'stopped' && /heavy\.1\.lock/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [{ ok: false, problems: ['no brief'], blockingQuestions: [] }] });
  ok('stopped at the preconditions -> no leftovers check (nothing started)', !x.prompts.some((p) => p.role === 'left'), x.full);

  // Security reviewer (t.security): after the reviewer, with its own post-check; done only if both are done.
  const TS = Object.assign({}, T, { security: true });
  const D = { verdict: 'done', docsOnly: false, summary: '' };
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, TS);
  ok('security: review>sec, both post-checks -> done', x.r.status === 'done' && x.full === 'pre>prog>test>diff:x:tester>left:x:tester>review>diff:x:reviewer>sec>diff:x:reviewer>left:x:end', x.full);
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
    && types.sec === 'codis-agents:security-reviewer' && types.pre === 'general-purpose' && types.diff === 'general-purpose', JSON.stringify(types));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, T, { agentTypePrefix: '' });
  ok('agentTypePrefix "" -> every role general-purpose', x.prompts.every((p) => p.opts.agentType === 'general-purpose'));

  // Config and task defaults.
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, { key: 'k', title: 'K', wt: 'k-wt', branch: 'b', accept: 'a' });
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
  ok('every role prompt: the owner\'s stack images are never removed, nor other images or the build cache', x.prompts.filter((p) => !['diff', 'left'].includes(p.role)).every((p) => /[Nn]ever remove[^.]*owner's stack[^.]*other images[^.]*build cache/.test(p.prompt)));
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
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: Array(3).fill({ verdict: 'green', summary: '' }), analyst: [AN, AN],
    review: [{ verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'rejected', docsOnly: false, summary: '' }, { verdict: 'done', docsOnly: false, summary: '' }] },
    Object.assign({}, T, { analystFirst: true }));
  const roles = new Set(x.prompts.filter((p) => !['diff', 'left'].includes(p.role)).map((p) => p.role));
  const xs = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D], sec: [D] }, TS);
  const secLack = xs.prompts.filter((p) => p.role === 'sec').flatMap((p) => ruleList.filter((r) => !p.prompt.includes(r[1])).map((r) => p.label + ':' + r[0]));
  ok('the security reviewer prompt carries every rule', xs.prompts.some((p) => p.role === 'sec') && !secLack.length, secLack.join(','));
  const lacking = x.prompts.filter((p) => !['diff', 'left'].includes(p.role)).flatMap((p) => ruleList.filter((r) => !p.prompt.includes(r[1])).map((r) => p.label + ':' + r[0]));
  ok('the prompt of every role (pre, analyst, prog, test, review) carries every rule', roles.size === 5 && !lacking.length, [...roles].join(',') + ' ' + lacking.join(','));

  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
