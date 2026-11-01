#!/usr/bin/env node
'use strict';
// Task p-mechanism, the tester's cells (what tests/p-mechanism.test.js leaves open):
//   T1. the analyst of the second rejection answers mechanismOrCells: "mechanism" reaches the programmer of round A as a
//       rework of the mechanism, "cells" does not;
//   T2. the mechanism pass that proposes a split, or returns no result, stops the task (no second programmer, no crash);
//   T3. the programmer round after the pass keeps the fix part of a fix round ("Fix round <n>m (not the first)" with the
//       findings report), and its schema and label are the programmer's;
//   T4. after the pass the programmer returns environment / blocked -> stopped as such, no tester;
//   T5. the head of a mechanism round is never taken: an abbreviated head is not resolved (no sha step), no selection on it;
//   T6. mechanism in a fix round after a red train -> analyst pass -> that round again -> selection -> review -> train;
//       a mechanism earlier in the run makes the one in the train round a stop for the coordinator;
//   T7. after the analyst of the second red tester round (st.analyst set) a mechanism still gets its one pass;
//   T8. light mode: a second mechanism after the pass stops the task for the coordinator, no review;
//   T9. the mechanism pass's analyst prompt also carries the section "Mechanism" and does not ask "mechanism or cells?".
// usage: node tests/p-mechanism-tester.test.js
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
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix' };
const TB = Object.assign({}, T, { base: 'arc' });
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' }), P3 = Object.assign({}, PROG, { head: 'P3' });
const MECH = { status: 'mechanism', changedFiles: [], commits: [], head: 'B', mutations: '', fullRun: '', questions: [], summary: 'needs a height probe with a 1500 ms timer the analysis does not name' };
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
      if (q.sel && q.sel.length) return q.sel.shift();
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
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts, logs };
}
const ofRole = (x, role) => x.prompts.filter((p) => p.role === role);
const pOf = (x, role, i = 0) => (ofRole(x, role)[i] || { prompt: '' }).prompt;
const reasonOf = (p) => (p.split('\n').find((l) => l.startsWith('Reason: ')) || '').slice('Reason: '.length);
const ruleList = async (cfg) => new AsyncFunction('args', SRC.slice(0, SRC.indexOf('const PRE_SCHEMA')) + '\nreturn RULE_LIST(TASKS[0])')({ owner: 'o', config: cfg, tasks: [T] });
const schemaOf = (name) => new AsyncFunction('args', SRC.slice(0, SRC.indexOf('// Post-check of a role by git')) + `\nreturn ${name}`)({ owner: 'o', config: CFG, tasks: [T] });


const MOC = /^First answer "mechanism or cells\?"/;
const SEL_RED = { done: true, rc: 1, seconds: 1, log: '/d/wait.log', tail: '1 new red' };

(async () => {
  // T1
  let x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D], analyst: [Object.assign({}, AN, { mechanismOrCells: 'mechanism' })] });
  ok('T1. second rejection, analyst "mechanism" -> done after round A', x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('T1. round A programmer reworks by the new section "Mechanism" and rewrites the old guards',
    /replaced the mechanism/.test(pOf(x, 'prog', 2)) && /section "Mechanism" of \/d\/analyst\.md/.test(pOf(x, 'prog', 2)) && /rewrite the guards of the old mechanism/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D], analyst: [Object.assign({}, AN, { mechanismOrCells: 'cells' })] });
  ok('T1. second rejection, analyst "cells" -> no rework of the mechanism', x.r.status === 'done' && !/replaced the mechanism/.test(pOf(x, 'prog', 2)) && /second review rejection/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));

  // T2
  x = await run({ pre: [PRE], prog: [MECH], analyst: [Object.assign({}, AN, { split: ['a', 'b'] })] });
  ok('T2. the mechanism pass proposes a split -> stopped with the split, no second programmer',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst' && JSON.stringify(x.r.split || []).includes('"a"'), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH], analyst: [null] });
  ok('T2. the mechanism pass returns nothing -> stopped, not crashed', x.r.status === 'stopped' && x.trace === 'pre>prog>analyst' && /analyst returned no result/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));

  // T3
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], test: [RED('r1'), GREEN], review: [D] });
  const pm = ofRole(x, 'prog')[2] || { prompt: '', opts: {} };
  ok('T3. the round after the pass keeps the fix part of round 2 (2m, findings /d/test.md)',
    /Fix round 2m \(not the first\)/.test(pm.prompt) && /Read the findings of this round in \/d\/test\.md/.test(pm.prompt), pm.prompt.slice(0, 1500));
  ok('T3. label prog:x#2m, phase Programmer, the programmer schema', pm.opts.label === 'prog:x#2m' && pm.opts.phase === 'Programmer' && pm.opts.schema && pm.opts.schema.properties.status.enum.includes('mechanism'), JSON.stringify(pm.opts.label));
  ok('T3. the report round is 2m', /Report: \/d\/prog\.md \(round 2m\)/.test(pm.prompt), '');

  // T4
  x = await run({ pre: [PRE], prog: [MECH, Object.assign({}, PROG, { status: 'environment', summary: 'swap exhausted' })], analyst: [AN] });
  ok('T4. environment after the pass -> stopped as environment, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog' && /environment/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, Object.assign({}, PROG, { status: 'blocked', questions: ['❓ coordinator: q?'] })], analyst: [AN] });
  ok('T4. blocked after the pass -> stopped with its questions, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog' && JSON.stringify(x.r.questions || []).includes('q?'), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, null], analyst: [AN] });
  ok('T4. no result after the pass -> stopped, not crashed', x.r.status === 'stopped' && /no result/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));

  // T5
  x = await run({ pre: [PRE], prog: [Object.assign({}, MECH, { head: 'abcdef1' }), PROG], analyst: [AN], test: [GREEN], review: [D], train: [ride(0)] }, TB, ONE);
  ok('T5. an abbreviated head of a mechanism round is not resolved and no selection runs on it',
    x.r.status === 'done' && !/sha/.test(x.full) && x.full.startsWith('pre>prog>analyst>prog>run:x:select-1>test') && (x.full.match(/run:x:select-/g) || []).length === 1, x.full + ' ' + JSON.stringify(x.r));

  // T6
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], test: [GREEN], review: [D, D], train: [ride(11), ride(0)] }, TB, ONE);
  ok('T6. mechanism in the fix round after a red train -> analyst -> that round again -> selection -> review -> green train',
    x.r.status === 'done' && />run:x:train-1>prog>analyst>prog>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>/.test(x.full), x.full + ' ' + JSON.stringify(x.r));
  ok('T6. the train round after the pass keeps the train task and its result', /The integration train came back red/.test(pOf(x, 'prog', 2)) && /section "Mechanism"/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2).slice(0, 800));
  x = await run({ pre: [PRE], prog: [MECH, PROG, MECH], analyst: [AN], test: [GREEN], review: [D], train: [ride(11)] }, TB, ONE);
  ok('T6. a second mechanism in the train fix round -> stopped for the coordinator',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog>test>review>prog' && /status mechanism again/.test(x.r.why) && /coordinator/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));

  // T7
  x = await run({ pre: [PRE], prog: [PROG, P2, MECH, P3], analyst: [AN, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  ok('T7. mechanism after the analyst of the second red tester round still gets its pass',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>analyst>prog>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('T7. the second analyst is the mechanism pass', /status mechanism/.test(reasonOf(pOf(x, 'analyst', 1))), reasonOf(pOf(x, 'analyst', 1)));

  // T8
  x = await run({ pre: [PRE], prog: [MECH, MECH], analyst: [AN] }, Object.assign({}, T, { mode: 'light' }));
  ok('T8. light mode: a second mechanism -> stopped for the coordinator, no review',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog' && /coordinator/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));

  // T9
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  const ap = pOf(x, 'analyst');
  ok('T9. the mechanism pass prompt: the section "Mechanism" (2-3 mechanisms, ❓ owner, layer 3) and no "mechanism or cells?" reason',
    /2-3 mechanisms/.test(ap) && /layer 3, not the coordinator's layer 2/.test(ap) && !MOC.test(reasonOf(ap)), reasonOf(ap));
  done();
})();
