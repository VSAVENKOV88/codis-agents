#!/usr/bin/env node
'use strict';
// Task p-testerred-route (run wf_68338028-44b of cvm-wheel-c, 2026-11-01): the task was relaunched with `start` after a
// red tester round of an earlier run; its first red tester round in the new run was the second red of the task, yet the
// workflow sent it back to the programmer - the counters of a task (st.reds, st.trainReds, st.analyst, st.mechanism)
// lived only inside one run. The fix (mechanism M-A of the analysis): the task field `prior` carries the counts of
// earlier runs, checked before any agent, and seeds those counters.
//   V1-V7  the field prior: absent or {} - as before; a wrong value or key - stopped on preconditions before any agent;
//          testerReds above 0 in the light mode (no tester there) - refused;
//   T1-T12 red tester rounds with a seed (rule role:testerred): the second red of the task counts the earlier runs;
//          a seeded analyst stops the task on a red, and is not called twice (second rejection);
//   N1-N4  the train with a seed: the second red train counts the earlier runs; a seeded analyst stops or is not repeated;
//   M1-M2  the pass "Mechanism" with a seed: a status mechanism after a pass of an earlier run goes to the coordinator;
//   L1     the light mode counts a seeded red train;
//   C1-C10 review 1: every result carries `counts` in the shape of prior (with the seed), and a result passed as the next
//          run's prior gives the route of one run (red, rejection, red train, pass, environment not counted);
//          review rejections of an earlier run (prior.rejections) count toward the second rejection;
//   D1-D6  the rule, the skills, README and the version name the field, the result's counts and the limit per task.
// usage: node tests/p-testerred-route.test.js
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 700));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const flat = (f) => read(f).replace(/\s+/g, ' ');
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}' });
const ONLY = Object.assign({}, ONE, { innerSelect: false });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix' };
const TB = Object.assign({}, T, { base: 'arc' });
const withP = (prior, t = T, extra) => Object.assign({}, t, { prior }, extra || {});
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' }), P3 = Object.assign({}, PROG, { head: 'P3' }), P4 = Object.assign({}, PROG, { head: 'P4' });
const MECH = { status: 'mechanism', changedFiles: [], commits: [], head: 'B', mutations: '', fullRun: '', questions: [], summary: 'needs a probe' };
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };
const GREEN = { verdict: 'green', summary: '' }, RED = (s) => ({ verdict: 'red', summary: s || 'cell red' });
const D = { verdict: 'done', docsOnly: false, summary: '' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'rej' };
const ride = (rc) => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail: '' });

async function run(script, task = T, cfg = CFG) {
  const trace = [], full = [], prompts = [], logs = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') {
      if (/:train-/.test(opts.label)) {
        if (!q.train || !q.train.length) throw new Error('extra train step after ' + full.join('>'));
        return q.train.shift();
      }
      return { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' };
    }
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, pipeline, null, (m) => logs.push(m), () => {}, { owner: 'o', config: cfg, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0] || {}, trace: trace.join('>'), full: full.join('>'), prompts, logs };
}
const pOf = (x, role, i = 0) => ((x.prompts.filter((p) => p.role === role)[i]) || {}).prompt || '';
const J = (x) => `${x.trace} ${JSON.stringify(x.r)}`;
const refused = (x, re) => x.r.status === 'stopped' && x.r.why === 'preconditions' && x.trace === '' && re.test(JSON.stringify(x.r.problems || []));

(async () => {
  let x;
  // ---- V. the field prior, before any agent ----
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [RED(), GREEN], review: [D] });
  ok('V1. no prior: red -> programmer (the behaviour of 0.4.16)', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [RED(), GREEN], review: [D] }, withP({}));
  ok('V2. prior {} - as without it', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review', J(x));
  for (const k of ['testerReds', 'trainReds']) {
    for (const v of [-1, 1.5, '1', null, true]) {
      x = await run({}, withP({ [k]: v }));
      ok(`V3. prior.${k} ${JSON.stringify(v)} -> preconditions, no agent, the field named`, refused(x, new RegExp(`prior\\.${k}`)), J(x));
    }
  }
  for (const v of ['x', '', 'tester', 1, null]) {
    x = await run({}, withP({ analyst: v }));
    ok(`V4. prior.analyst ${JSON.stringify(v)} -> preconditions`, refused(x, /prior\.analyst/), J(x));
  }
  for (const v of ['yes', false, 1, null]) {
    x = await run({}, withP({ mechanism: v }));
    ok(`V5. prior.mechanism ${JSON.stringify(v)} -> preconditions (only true)`, refused(x, /prior\.mechanism/), J(x));
  }
  x = await run({}, withP({ testerRed: 1 }));
  ok('V6. an unknown key of prior -> preconditions, the key named', refused(x, /testerRed\b/), J(x));
  for (const v of [1, 'x', [], null]) {
    x = await run({}, withP(v));
    ok(`V6. prior ${JSON.stringify(v)} (not an object) -> preconditions`, refused(x, /prior/), J(x));
  }
  x = await run({}, withP({ testerReds: 1 }, T, { mode: 'light' }));
  ok('V7. light mode with prior.testerReds 1 -> preconditions (no tester in the light mode)', refused(x, /prior\.testerReds[^"]*light/), J(x));
  x = await run({ pre: [PRE], prog: [PROG], review: [D] }, withP({ testerReds: 0, trainReds: 1 }, T, { mode: 'light' }));
  ok('V7. light mode with prior.testerReds 0 and trainReds 1 -> it starts', x.r.status === 'done' && x.trace === 'pre>prog>review', J(x));

  // ---- T. red tester rounds with a seed ----
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r3'), GREEN], analyst: [AN], review: [D] }, withP({ testerReds: 1 }));
  ok('T1. cvm-wheel-c: relaunch after a red of an earlier run -> the first red of this run -> analyst, then prog -> test -> review',
    x.r.status === 'done' && x.trace === 'pre>prog>test>analyst>prog>test>review', J(x));
  ok('T1. logged "the second red tester round for the product - analyst"', x.logs.some((m) => /the second red tester round for the product - analyst/.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, RED(), GREEN], analyst: [AN], review: [REJ, D] }, withP({ testerReds: 1 }));
  ok('T2. seed 1, red after the review fix -> analyst, not "tester after the review fix - red"',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>analyst>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, RED('short'), GREEN], analyst: [AN], review: [D, D], train: [ride(11), ride(0)] }, withP({ testerReds: 1 }, TB), ONLY);
  ok('T3. innerSelect false, seed 1: red train -> fix -> short tester red -> analyst (redAnalystRound) -> ride again',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>analyst>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [{ verdict: 'environment', environment: 'docker down', summary: '' }] }, withP({ testerReds: 1 }));
  ok('T4. seed 1, tester environment -> stopped for the environment, no analyst',
    x.r.status === 'stopped' && /environment/.test(x.r.why) && x.trace === 'pre>prog>test', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, withP({ testerReds: 1 }));
  ok('T5. seed 1, green -> done without an analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED(), GREEN], analyst: [AN], review: [D] }, withP({ testerReds: 2 }));
  ok('T6. seed 2 without an analyst, first red -> analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>analyst>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED(), RED(), GREEN], analyst: [AN], review: [D] });
  ok('T7. no seed: red, red -> analyst on the second (R1 unchanged)', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>analyst>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [RED('r5')] }, withP({ analyst: 'tester-red' }));
  ok('T8. seeded analyst tester-red, first red -> stopped "tester red after analyst", no analyst, no programmer',
    x.r.status === 'stopped' && x.r.why === 'tester red after analyst' && x.trace === 'pre>prog>test' && x.r.test === 'r5', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, RED('r6')], review: [REJ] }, withP({ analyst: 'tester-red' }));
  ok('T8. seeded analyst tester-red, red after the review fix -> stopped "tester red after analyst" (the reason of the review loop), no analyst',
    x.r.status === 'stopped' && x.r.why === 'tester red after analyst' && x.trace === 'pre>prog>test>review>prog>test', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, withP({ analyst: 'tester-red', testerReds: 3 }));
  ok('T9. seeded analyst and reds, green -> done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED(), RED(), GREEN], review: [D] }, withP({ analyst: 'rejection' }));
  ok('T10. seeded analyst rejection: red, red -> programmer, programmer (the tester rounds as they were), no analyst',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, REJ] }, withP({ analyst: 'tester-red' }));
  ok('T11. seeded analyst, second review rejection for code -> stopped "after the analyst", the analyst is not called again',
    x.r.status === 'stopped' && /after the analyst: second review rejection/.test(x.r.why) && x.trace === 'pre>prog>test>review>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r3'), GREEN], analyst: [AN], review: [D] }, withP({ testerReds: 1, trainReds: 1 }));
  ok('T12. the start log names the seed', x.logs.some((m) => /prior/.test(m) && /testerReds 1/.test(m) && /trainReds 1/.test(m)), x.logs.join(' | '));
  const an12 = pOf(x, 'analyst');
  ok('T12. the analyst of the second red says the reds of earlier runs are counted, and how many', /1 red tester round[^.]*earlier run/.test(an12) && /prior/.test(an12), an12);
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED(), RED(), GREEN], analyst: [AN], review: [D] });
  ok('T12. without a seed the analyst prompt names no earlier runs', !/red tester rounds? of earlier runs of this task/.test(pOf(x, 'analyst')) && !x.logs.some((m) => /prior/.test(m)), pOf(x, 'analyst'));

  // ---- N. the train with a seed (ONE_RUN, the selection inside the task) ----
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D, D], analyst: [AN], train: [ride(11), ride(0)] }, withP({ trainReds: 1 }, TB), ONE);
  ok('N1. seed trainReds 1, the first red train of this run -> analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>review>analyst>prog>review', J(x));
  for (const rc of [12, 13]) {
    x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D, D], train: [ride(rc), ride(0)] }, withP({ trainReds: 1 }, TB), ONE);
    ok(`N2. seed trainReds 1, train exit ${rc} -> a fix round, no analyst`, x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review', J(x));
  }
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], train: [ride(11)] }, withP({ analyst: 'train-red' }, TB), ONE);
  ok('N3. seeded analyst train-red, red train -> stopped "train red after analyst"', x.r.status === 'stopped' && /^train red after analyst/.test(x.r.why) && x.trace === 'pre>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN], review: [D, D, D], train: [ride(11), ride(11), ride(0)] }, withP({ analyst: 'tester-red' }, TB), ONE);
  ok('N4. seeded analyst tester-red, red, red train -> fix rounds, no second analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review>prog>review', J(x));

  // ---- M. the pass "Mechanism" with a seed ----
  x = await run({ pre: [PRE], prog: [MECH] }, withP({ mechanism: true }));
  ok('M1. seeded pass, status mechanism -> stopped for the coordinator, no analyst pass, the earlier run named',
    x.r.status === 'stopped' && /status mechanism again/.test(x.r.why) && /earlier run/.test(x.r.why) && x.trace === 'pre>prog', J(x));
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  ok('M2. no seed, status mechanism -> the analyst pass as in 0.4.16', x.r.status === 'done' && x.trace === 'pre>prog>analyst>prog>test>review', J(x));

  // ---- L. the light mode ----
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [D, D], analyst: [AN], train: [ride(11), ride(0)] }, withP({ trainReds: 1 }, TB, { mode: 'light' }), ONE);
  ok('L1. light mode, seed trainReds 1, red train -> analyst', x.r.status === 'done' && x.trace === 'pre>prog>review>analyst>prog>review', J(x));

  // ---- C. review 1: the result carries counts, and counts passed as the next prior give the route of one run ----
  const ENV = { verdict: 'environment', environment: 'docker down', summary: '' };
  const okPrior = (c, light) => !!c && typeof c === 'object' && Object.keys(c).every((k) => ['testerReds', 'trainReds', 'rejections', 'analyst', 'mechanism'].includes(k));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });
  ok('C1. a done run without prior carries counts {testerReds 0, trainReds 0, rejections 0}, no analyst, no mechanism',
    JSON.stringify(x.r.counts) === JSON.stringify({ testerReds: 0, trainReds: 0, rejections: 0 }), J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r3'), GREEN], analyst: [AN], review: [D] }, withP({ testerReds: 1, trainReds: 1 }));
  ok('C1. the counts include the seed: testerReds 2 (1 seeded + 1), trainReds 1, analyst tester-red',
    x.r.counts && x.r.counts.testerReds === 2 && x.r.counts.trainReds === 1 && x.r.counts.analyst === 'tester-red' && okPrior(x.r.counts), J(x));
  // C2. red, then environment: one red counted, the environment not; the next run with those counts -> analyst on its first red.
  const r1 = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r1'), ENV] });
  ok('C2. run 1: red, environment -> stopped for the environment, counts testerReds 1 (the environment round not counted)',
    r1.r.status === 'stopped' && /environment/.test(r1.r.why) && r1.r.counts && r1.r.counts.testerReds === 1, J(r1));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r2'), GREEN], analyst: [AN], review: [D] }, withP(r1.r.counts));
  ok('C2. run 2 with prior = counts of run 1: the first red -> analyst (as two reds in one run)',
    x.r.status === 'done' && x.trace === 'pre>prog>test>analyst>prog>test>review', J(x));
  // C3. a seeded run that stops on the environment passes its seed on unchanged (not +1).
  const r3 = await run({ pre: [PRE], prog: [PROG], test: [ENV] }, withP({ testerReds: 1 }));
  ok('C3. seeded run stopped on the environment: counts testerReds stays 1', r3.r.counts && r3.r.counts.testerReds === 1, J(r3));
  // C4. rejection 1, then environment after the review fix: counts rejections 1; the next run's first rejection is the second.
  const r4 = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, ENV], review: [REJ] });
  ok('C4. run 1: rejection, environment after the fix -> counts rejections 1', r4.r.status === 'stopped' && r4.r.counts && r4.r.counts.rejections === 1, J(r4));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], analyst: [AN], review: [REJ, D] }, withP(r4.r.counts));
  ok('C4. run 2 with prior = counts of run 1: the first rejection for code is the second of the task -> analyst',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>analyst>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] });
  ok('C4. without the seed the same run: rejection -> a fix round (as before)', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [Object.assign({}, REJ, { docsOnly: true })] }, withP({ rejections: 1 }));
  ok('C4. seed rejections 1, a docs-only rejection -> stopped as a second rejection for docs (no analyst)',
    x.r.status === 'stopped' && /second review rejection/.test(x.r.why) && x.trace === 'pre>prog>test>review', J(x));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [REJ] }, withP({ rejections: 1, analyst: 'rejection' }));
  ok('C4. seed rejections 1 after the analyst of an earlier run: a rejection -> stopped "after the analyst", no second analyst',
    x.r.status === 'stopped' && /^after the analyst: second review rejection/.test(x.r.why) && x.trace === 'pre>prog>test>review', J(x));
  // C5. the analyst of a rejection resets the count of rejections: one more fix round after it, as in one run.
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AN], review: [REJ, REJ, D] });
  ok('C5. rejection, rejection -> analyst -> done: counts rejections 0, analyst rejection',
    x.r.status === 'done' && x.r.counts && x.r.counts.rejections === 0 && x.r.counts.analyst === 'rejection', J(x));
  // C6. the pass "Mechanism": run 1 makes it and stops on the environment; run 2 with its counts sends a status mechanism to the coordinator.
  const r6 = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [ENV] });
  ok('C6. run 1: the pass, then environment -> counts mechanism true', r6.r.counts && r6.r.counts.mechanism === true, J(r6));
  x = await run({ pre: [PRE], prog: [MECH] }, withP(r6.r.counts));
  ok('C6. run 2 with prior = counts of run 1: status mechanism -> the coordinator', x.r.status === 'stopped' && /status mechanism again/.test(x.r.why) && x.trace === 'pre>prog', J(x));
  // C7. a red train, then a rejected fix review: counts trainReds 1; the next run's first red train -> analyst.
  const r7 = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D, REJ], train: [ride(11)] }, TB, ONE);
  ok('C7. run 1: red train, the fix review rejected -> counts trainReds 1', r7.r.status === 'stopped' && r7.r.counts && r7.r.counts.trainReds === 1, J(r7));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D, D], analyst: [AN], train: [ride(11), ride(0)] }, withP(r7.r.counts, TB), ONE);
  ok('C7. run 2 with prior = counts of run 1: the first red train -> analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>review>analyst>prog>review', J(x));
  // C8. refusals: a refusal after a valid prior carries the seed; a refused prior carries no counts.
  x = await run({}, withP({ testerReds: 1 }, T), ONE);
  ok('C8. refused on the base (no base with the selection) -> counts = the seed', refused(x, /base/) && JSON.stringify(x.r.counts) === JSON.stringify({ testerReds: 1, trainReds: 0, rejections: 0 }), J(x));
  x = await run({}, withP({ testerReds: -1 }));
  ok('C8. a refused prior -> no counts in the result', refused(x, /prior/) && x.r.counts === undefined, J(x));
  x = await run({ pre: [{ ok: false, problems: ['p'], blockingQuestions: [] }] }, withP({ trainReds: 2 }));
  ok('C8. stopped on the preconditions agent -> counts = the seed', x.r.status === 'stopped' && x.r.counts && x.r.counts.trainReds === 2, J(x));
  // C9. prior.rejections is checked like the other counts, and the light mode counts it too.
  for (const v of [-1, 1.5, '1', null]) {
    x = await run({}, withP({ rejections: v }));
    ok(`C9. prior.rejections ${JSON.stringify(v)} -> preconditions`, refused(x, /prior\.rejections/), J(x));
  }
  x = await run({ pre: [PRE], prog: [PROG], review: [REJ] }, withP({ rejections: 1 }, T, { mode: 'light' }));
  ok('C9. light mode, seed rejections 1, review 1 rejected -> stopped as the second rejection in the light mode, no fix round',
    x.r.status === 'stopped' && /second review rejection in the light mode/.test(x.r.why) && x.trace === 'pre>prog>review' && x.r.counts && x.r.counts.rejections === 2, J(x));

  // C10. the count of rejections in every place it changes: a second rejection counts 2 (full and light), the analyst of
  // a red tester round and of a red train starts it again (one more fix round after it, as after the rejection analyst).
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, Object.assign({}, REJ, { docsOnly: true })] });
  ok('C10. rejection, second rejection for docs -> stopped, counts rejections 2', x.r.status === 'stopped' && x.r.counts && x.r.counts.rejections === 2, J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [REJ, REJ] }, Object.assign({}, T, { mode: 'light' }));
  ok('C10. light: rejection, rejection -> stopped, counts rejections 2', x.r.status === 'stopped' && x.r.counts && x.r.counts.rejections === 2, J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [GREEN, RED(), GREEN, GREEN], analyst: [AN], review: [REJ, REJ, D] }, withP({ testerReds: 1 }));
  ok('C10. rejection, red after the fix -> analyst tester-red, then a rejection -> a fix round (the count starts again), not a stop',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>analyst>prog>test>review>prog>test>review' && x.r.counts.rejections === 1, J(x));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN], review: [D, D], analyst: [AN], train: [ride(11), ride(0)] }, withP({ trainReds: 1, rejections: 1 }, TB), ONE);
  ok('C10. seed rejections 1, the analyst of the second red train -> counts rejections 0',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>analyst>prog>review' && x.r.counts.rejections === 0, J(x));

  // ---- D. the documents name the field ----
  const rule = (id) => (read('rules/multi-agent.md').match(new RegExp(`[^\\n]*<!-- role:${id} -->`)) || [''])[0];
  ok('D1. rule role:testerred: counted per task across runs, a relaunch passes the counts in prior', /prior/.test(rule('testerred')) && /testerReds/.test(rule('testerred')) && /earlier run/.test(rule('testerred')), rule('testerred'));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });
  ok('D1. RULE_LIST testerred reaches the prompts with the field prior', ['prog', 'test', 'review'].every((r) => /Red tester rounds are counted per task[^\n]*prior/.test(pOf(x, r))), pOf(x, 'prog'));
  ok('D2. rule role:mechanism: a pass of an earlier run is passed as prior.mechanism, not said in start',
    /prior(: \{mechanism: true\}|\.mechanism)/.test(rule('mechanism')) && !/says in `start`/.test(rule('mechanism')), rule('mechanism'));
  ok('D2. RULE_LIST mechanism names prior.mechanism', /prior\.mechanism/.test(pOf(x, 'prog')), pOf(x, 'prog'));
  const rc = flat('skills/role-chain/SKILL.md'), co = flat('skills/coordinator/SKILL.md');
  ok('D3. role-chain skill: a row `prior` with its keys', /\| `prior` \|/.test(rc) && ['testerReds', 'trainReds', 'analyst', 'mechanism'].every((k) => rc.includes(k)) && !/says in `start` when an earlier run/.test(rc), '');
  ok('D3. coordinator skill: a relaunch passes prior from the reports of the earlier run', /`prior`/.test(co) && /testerReds/.test(co) && !/say so in `start`/.test(co), '');
  const cl = read('CHANGELOG.md');
  ok('D4. CHANGELOG: 0.4.17 names prior', /## 0\.4\.17\b[\s\S]*?`prior`[\s\S]*?## 0\.4\.16\b/.test(cl), '');
  ok('D4. version 0.4.25 in package.json and plugin.json (the one pin of the version, moved at each bump)', /"version": "0\.4\.25"/.test(read('package.json')) && /"version": "0\.4\.25"/.test(read('.claude-plugin/plugin.json')), '');
  ok('D5. rule role:testerred and both skills: copy the counts of the run results (counts), the field rejections',
    /`counts`/.test(rule('testerred')) && /rejections/.test(rule('testerred')) && /`counts`/.test(co) && /`counts`/.test(rc), rule('testerred'));
  const prow = (read('skills/role-chain/SKILL.md').match(/^\| `prior` \|.*$/m) || [''])[0];
  ok('D5. role-chain skill: the row `prior` says copy counts of the last result, and names rejections', /`counts`/.test(prow) && /rejections/.test(prow) && /never recount/.test(prow), prow);
  ok('D5. CHANGELOG 0.4.17 names counts and rejections', /## 0\.4\.17\b[\s\S]*?`counts`[\s\S]*?rejections[\s\S]*?## 0\.4\.16\b/.test(cl), '');
  ok('D6. rule role:mechanism and RULE_LIST: the pass is per task, not "inside the run" / "in the run"',
    !/inside the run|in the run\b/.test(rule('mechanism')) && !/pass inside the run|mechanism` in the run|in the run\b/.test((pOf(x, 'prog').match(/Mechanism: for a task[^\n]*/) || [''])[0]), rule('mechanism'));
  ok('D4. meta.whenToUse lists prior?', /prior\?/.test((SRC.match(/whenToUse: '([^\n]*)'/) || ['', ''])[1]), '');
  done();
})();
