#!/usr/bin/env node
'use strict';
// Task p-fixround (P5 of the plugin audit): a fix round of the programmer (a round after the first: after a red tester,
// a red full run or a rejection) reads only the findings of the round and the task's diff, and mutates only the guards
// new or changed in this round; the first round (and the first round after an analyst) reads and mutates as before.
//   F1. full mode, round 1: no fix-round block;
//   F2. a red tester -> round 2 names test.md, the task's diff from the task's base, the brief and analysis only in the
//       sections the findings cite, mutations only for the guards of git diff <tester HEAD>..HEAD;
//   F3. a review rejection -> round r names review.md and the diff of the round from the HEAD before it;
//   F4. a red selection -> round 1f names the log of the run and the diff of the round from the programmer's HEAD;
//   F5. light mode: round 1 has no block, the round after a rejection has it;
//   F6. the first round after the analyst of the second red tester round is not a fix round;
//   F7. the rule: a marked line role:fixround in rules/multi-agent.md, a RULE_LIST entry, README names it;
//   F8. (review 1) the narrowing does not forbid what a fix needs: the guards the findings name (a rejection "guard G of
//       round 1 has no mutation evidence") and the guards that cover product code changed in the round are mutated too,
//       in the prompt of every fix round (full and light), the rule, RULE_LIST and README.
// usage: node tests/p-fixround.test.js
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}' });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', noAnalysis: 'one-line fix', base: 'B0' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' });
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };
const GREEN = { verdict: 'green', summary: '' }, RED = { verdict: 'red', summary: 'cell 3 red' };
const D = { verdict: 'done', docsOnly: false, summary: '' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'missing case' };

async function run(script, task = T, cfg = CFG) {
  const prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return q.run && q.run.length ? q.run.shift() : { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' };
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role);
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] });
  return { r: res[0], prompts };
}
const progs = (x) => x.prompts.filter((p) => p.role === 'prog');
const FIX = /Fix round [^\n]*not the first/;
const isFix = (p) => FIX.test(p.prompt);
const fixLine = (p) => (p.prompt.split('\n').find((l) => FIX.test(l)) || '');
// The block of a fix round: the findings report, the task's diff from its base, sections only, mutations of this round.
const fixOk = (p, report, before) => {
  const l = fixLine(p);
  return l.includes(report) && /do not reread the whole task/.test(l)
    && l.includes("git -C '/w' diff 'B0'..HEAD") && /BRIEF\.md[^.]*only in the sections the findings cite/.test(l)
    && /of prog\.md only its last round/.test(l)
    && new RegExp(`Mutations[^.]*only for the guards new or changed in (it|this round)[^.]*git -C '/w' diff --name-only '${before}'\\.\\.HEAD`).test(l)
    && /earlier rounds/.test(l);
};

(async () => {
  // F1 + F2: full mode, a red tester.
  let x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED, GREEN], review: [D] });
  let ps = progs(x);
  ok('F1. full mode: round 1 has no fix-round block', ps.length === 2 && !isFix(ps[0]) && !/diff --name-only/.test(ps[0].prompt), ps[0] && fixLine(ps[0]));
  ok('F2. a red tester: round 2 is a fix round - test.md, the task diff from B0, sections only, mutations of git diff T..HEAD',
    isFix(ps[1]) && fixOk(ps[1], '/d/test.md', 'T'), fixLine(ps[1]));

  // F3: a review rejection.
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] });
  ps = progs(x);
  ok('F3. a review rejection: round r is a fix round - review.md, mutations of the round from the HEAD before it (tester T)',
    ps.length === 2 && !isFix(ps[0]) && isFix(ps[1]) && fixOk(ps[1], '/d/review.md', 'T'), fixLine(ps[1]));

  // F4: one-run mode, a red selection (p-train-a2: the selection step replaced the full run in the task).
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D],
    run: [{ done: true, rc: 1, seconds: 1, log: '/d/full.log', tail: '1 new red' }, { done: true, rc: 0, seconds: 1, log: '/d/w2', tail: 'ok' }] }, T, ONE);
  ps = progs(x);
  ok('F4. a red selection: round 1f is a fix round - the run log, mutations of git diff P..HEAD',
    ps.length === 2 && !isFix(ps[0]) && isFix(ps[1]) && fixOk(ps[1], '/d/full.log', 'P') && fixLine(ps[1]).includes('/d/wait-select-1.guards.txt'), fixLine(ps[1]));

  // F5: light mode.
  const L = Object.assign({}, T, { mode: 'light' });
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [REJ, D] }, L, ONE);
  ps = progs(x);
  ok('F5. light mode: round 1 has no block, round r after a rejection has it (review.md, from P)',
    ps.length === 2 && /PROGRAMMER-CHECKER/.test(ps[1].prompt) && !isFix(ps[0]) && isFix(ps[1]) && fixOk(ps[1], '/d/review.md', 'P'), fixLine(ps[1]));

  // F6: after the analyst of the second red tester round, its first round reads the new matrix whole.
  x = await run({ pre: [PRE], prog: [PROG, PROG, PROG], test: [RED, RED, GREEN], analyst: [AN], review: [D] });
  ps = progs(x);
  ok('F6. rounds 1 and T1 (after the analyst) are not fix rounds, round 2 is',
    ps.length === 3 && !isFix(ps[0]) && isFix(ps[1]) && !isFix(ps[2]) && /analyst\.md/.test(ps[2].prompt), ps.map((p) => p.label + '=' + isFix(p)).join(' '));

  // F7: the rule.
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  const line = (rules.match(/[^\n]*<!-- role:fixround -->/) || [''])[0];
  ok('F7. rules/multi-agent.md: a line marked role:fixround - the findings and the diff, sections only, mutations of the round',
    /fix round/i.test(line) && /diff/.test(line) && /sections/.test(line) && /mutat/i.test(line) && /changed in (it|this round)/.test(line), line);
  ok('F7. RULE_LIST has the entry fixround', /\['fixround', /.test(SRC));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('F7. README names the fix-round rule', /fix round/i.test(readme) && /changed in (it|this round)/.test(readme));

  // F8: the guards the findings name and the guards over the code changed in the round are mutated as well.
  const NAMED = /the guards the findings name/, COVER = /the guards that cover (the )?product code changed in (it|this round)/;
  const wide = (t) => NAMED.test(t) && COVER.test(t);
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] });
  ps = progs(x);
  ok('F8. full mode fix round: mutations also for the guards the findings name and the guards over changed product code',
    isFix(ps[1]) && wide(fixLine(ps[1])), fixLine(ps[1]));
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [REJ, D] }, L, ONE);
  ps = progs(x);
  ok('F8. light mode fix round: the same widening', isFix(ps[1]) && wide(fixLine(ps[1])), fixLine(ps[1]));
  ok('F8. rules/multi-agent.md role:fixround names both', wide(line), line);
  const entry = (SRC.match(/\['fixround', [^\n]*/) || [''])[0];
  ok('F8. RULE_LIST fixround names both', wide(entry), entry);
  const rme = (readme.match(/\*\*Fix rounds\*\*[\s\S]*?\n- /) || [''])[0].replace(/\s+/g, ' ');
  ok('F8. README Fix rounds names both', wide(rme), rme);
  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
