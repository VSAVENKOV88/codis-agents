#!/usr/bin/env node
'use strict';
// Tester of p-testerred-route: cells of the seed (task field prior) that the programmer's test does not reach - a seeded
// analyst of every kind against every consumer (short tester round after a train, second rejection, light-mode train),
// a seeded pass "Mechanism" against a fix round of the programmer, a seeded red against the analyst's own round.
// The harness is the one of tests/p-testerred-route.test.js.
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
//   D1-D4  the rule, the skills, README and the version name the field.
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
  // X1. innerSelect false, seeded analyst tester-red: red train -> fix in the product -> short tester red -> stop (no analyst)
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, RED('short')], review: [D], train: [ride(11)] }, withP({ analyst: 'tester-red' }, TB), ONLY);
  ok('X1. seeded analyst tester-red, short tester after a red train red -> stopped "tester red after analyst", no analyst',
    x.r.status === 'stopped' && x.r.why === 'tester red after analyst' && x.trace === 'pre>prog>test>review>prog>test', J(x));
  // X2/X3. a seeded analyst of another kind: the second rejection for code stops, the analyst is not called again
  for (const a of ['rejection', 'train-red']) {
    x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, REJ] }, withP({ analyst: a }));
    ok(`X2. seeded analyst ${a}, second review rejection for code -> stopped "after the analyst", no analyst`,
      x.r.status === 'stopped' && /^after the analyst: second review rejection/.test(x.r.why) && x.trace === 'pre>prog>test>review>prog>test>review', J(x));
  }
  // X4. seed 1: the first red of the run -> analyst; a red in the analyst's round -> stop (one analyst per task)
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('a'), RED('b')], analyst: [AN] }, withP({ testerReds: 1 }));
  ok('X4. seed 1: red -> analyst -> red -> stopped "tester red after analyst"',
    x.r.status === 'stopped' && x.r.why === 'tester red after analyst' && x.trace === 'pre>prog>test>analyst>prog>test', J(x));
  // X5. a seeded pass Mechanism holds for a fix round of the programmer too, not only the first one
  x = await run({ pre: [PRE], prog: [PROG, MECH], test: [RED()] }, withP({ mechanism: true }));
  ok('X5. seeded pass, status mechanism in the fix round after a red tester -> stopped for the coordinator, earlier run named',
    x.r.status === 'stopped' && /status mechanism again/.test(x.r.why) && /earlier run/.test(x.r.why) && x.trace === 'pre>prog>test>prog', J(x));
  // X6. light mode, seeded analyst train-red: red train -> stop
  x = await run({ pre: [PRE], prog: [PROG], review: [D], train: [ride(11)] }, withP({ analyst: 'train-red' }, TB, { mode: 'light' }), ONE);
  ok('X6. light mode, seeded analyst train-red, red train -> stopped "train red after analyst"',
    x.r.status === 'stopped' && /^train red after analyst/.test(x.r.why) && x.trace === 'pre>prog>review', J(x));
  // X7. light mode, seeded analyst tester-red, trainReds 1: red train -> no second analyst, a fix round
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [D, D], train: [ride(11), ride(0)] }, withP({ analyst: 'tester-red', trainReds: 1 }, TB, { mode: 'light' }), ONE);
  ok('X7. light mode, seeded analyst tester-red and trainReds 1, red train -> fix round, no analyst',
    x.r.status === 'done' && x.trace === 'pre>prog>review>prog>review', J(x));
  // X8. seed testerReds 1 with analyst rejection: the red goes to the programmer (the tester rounds stay as they were)
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED(), GREEN], review: [D] }, withP({ testerReds: 1, analyst: 'rejection' }));
  ok('X8. seed testerReds 1 + analyst rejection: red -> programmer, no analyst', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>review', J(x));
  // X9. seed 1, the tester after the review fix says environment -> stopped for the environment, no analyst
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, { verdict: 'environment', environment: 'disk', summary: '' }], review: [REJ] }, withP({ testerReds: 1 }));
  ok('X9. seed 1, environment after the review fix -> stopped for the environment, no analyst',
    x.r.status === 'stopped' && /environment/.test(x.r.why) && x.trace === 'pre>prog>test>review>prog>test', J(x));
  // X10. a wrong prior stops before the precondition agent even with a valid rest, and names the task's field
  x = await run({}, withP({ testerReds: 1, analyst: 'tester-red', mechanism: true, trainReds: 'x' }));
  ok('X10. one wrong key among valid ones -> preconditions before any agent', refused(x, /prior\.trainReds/), J(x));
  done();
})();
