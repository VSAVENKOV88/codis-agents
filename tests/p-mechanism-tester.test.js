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
//   (round after review 1: the section "Mechanism" of the pass reaches later rounds, mechLine)
//   T10. a pass in a later round (round 2 after a red tester): the rounds before it do not name the section, the round
//        of the pass itself (2m) and the tester after it name it with round 2 (not round 1);
//   T11. the programmer of round T (after the analyst of the second red tester round) and of round A (after the analyst
//        of the second rejection) name the section of a pass made in round 1;
//   T12. light mode: a pass in round r (after a rejection) - the round rm names round r; round 1 did not;
//   T13. the reviewer after a pass reads analyst.md, where the section lives (the consumer reached by its own reading).
//   (round after the second-rejection analyst: st.mechSection, the author of the section)
//   T14. a pass after a later analyst replaced the mechanism (second rejection, second red tester round): the pass prompt
//        names the current author and says its section replaces it; the rounds after the pass name the pass;
//   T15. the first programmer round after a later analyst that answered "mechanism" (A1, T1, the train round) names the
//        section and its author in its prompt (mechLine), not only the rework;
//   T16. a pass in round 1, then the second red tester round / second red train answers "mechanism": the later rounds
//        name the replacement, not the pass (C7 for the other two sources);
//   T17. light mode: the second red train answers "mechanism" -> the programmer-checker rounds after it (t-n and the
//        round after a seam) name the section and the analyst of the second red train;
//   T18. an answer "cells" after a pass keeps the pass as the author for the second red tester round and the train.
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

  // ---- round after review 1: mechLine ----
  const SECT = /section "Mechanism" of \/d\/analyst\.md/;
  const secRound = (s, r) => new RegExp('section "Mechanism" of /d/analyst\\.md[^\\n]*status mechanism of round ' + r + ';').test(s);
  // T10
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], test: [RED('r1'), GREEN], review: [D] });
  ok('T10. pass in round 2: flow prog>test>prog>analyst>prog>test>review', x.r.status === 'done' && x.trace === 'pre>prog>test>prog>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('T10. round 1, tester 1 and the round that stopped (2) do not name the section',
    !SECT.test(pOf(x, 'prog', 0)) && !SECT.test(pOf(x, 'test', 0)) && !SECT.test(pOf(x, 'prog', 1)), pOf(x, 'test', 0).slice(0, 300));
  ok('T10. round 2m names the section with round 2', ofRole(x, 'prog')[2].label === 'prog:x#2m' && secRound(pOf(x, 'prog', 2), '2'), pOf(x, 'prog', 2).slice(0, 600));
  ok('T10. the tester after the pass names it with round 2, not round 1', secRound(pOf(x, 'test', 1), '2') && !secRound(pOf(x, 'test', 1), '1'), pOf(x, 'test', 1).slice(0, 600));
  // T11
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  ok('T11. round T after the second-red analyst names the section of the pass of round 1',
    x.r.status === 'done' && ofRole(x, 'prog')[3].label === 'prog:x#T1' && secRound(pOf(x, 'prog', 3), '1') && secRound(pOf(x, 'test', 2), '1'), x.trace + ' ' + ofRole(x, 'prog').map((p) => p.label).join(','));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  const pa = ofRole(x, 'prog').find((p) => /#A1$/.test(p.label));
  ok('T11. round A after the second-rejection analyst names the section of the pass of round 1',
    x.r.status === 'done' && !!pa && secRound(pa.prompt, '1'), x.trace + ' ' + ofRole(x, 'prog').map((p) => p.label).join(','));
  // T12
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], review: [REJ, D] }, Object.assign({}, T, { mode: 'light' }));
  ok('T12. light mode: pass in round r - round 1 does not name it, round rm names round r',
    x.r.status === 'done' && !SECT.test(pOf(x, 'prog', 0)) && ofRole(x, 'prog')[2].label === 'prog:x#rm' && secRound(pOf(x, 'prog', 2), 'r'), x.trace + ' ' + ofRole(x, 'prog').map((p) => p.label).join(','));
  // T13
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  ok('T13. the reviewer after a pass reads analyst.md (the section "Mechanism" is in it)',
    x.r.status === 'done' && /Read BRIEF\.md, analyst\.md/.test(pOf(x, 'review')), pOf(x, 'review').slice(0, 300));
  // ---- round after the second-rejection analyst: the author of the section (st.mechSection) ----
  const AM = Object.assign({}, AN, { mechanismOrCells: 'mechanism' }), AC = Object.assign({}, AN, { mechanismOrCells: 'cells' });
  const P4 = Object.assign({}, PROG, { head: 'P4' });
  const byLate = (s, who) => new RegExp('section "Mechanism" of /d/analyst\\.md[^\\n]*written last by the analyst of the second ' + who).test(s);
  const byPass = (s, r) => new RegExp('section "Mechanism" of /d/analyst\\.md[^\\n]*written last by the analyst\'s pass after the status mechanism of round ' + r + ';').test(s);
  const labels = (x) => ofRole(x, 'prog').map((p) => p.label).join(',');
  // T14
  x = await run({ pre: [PRE], prog: [PROG, P2, MECH, P3], analyst: [AM, AN], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  let ps = reasonOf(pOf(x, 'analyst', 1));
  ok('T14. W3 "mechanism" -> pass in A1: the pass names the current author (second review rejection) and replaces it',
    x.r.status === 'done' && /The mechanism now: section "Mechanism" of \/d\/analyst\.md \(written last by the analyst of the second review rejection/.test(ps) && /your section replaces it and names it/.test(ps), ps);
  ok('T14. ... the tester after the pass names the pass of round A1, not the rejection analyst',
    byPass(pOf(x, 'test', 2), 'A1') && !byLate(pOf(x, 'test', 2), 'review rejection'), pOf(x, 'test', 2).slice(0, 600));
  x = await run({ pre: [PRE], prog: [PROG, P2, MECH, P3], analyst: [AM, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  ps = reasonOf(pOf(x, 'analyst', 1));
  ok('T14. W4 "mechanism" -> pass in T1: the pass names the second-red analyst and replaces it; tester T1 names the pass of T1',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>analyst>prog>analyst>prog>test>review'
      && /written last by the analyst of the second red tester round/.test(ps) && /your section replaces it and names it/.test(ps) && byPass(pOf(x, 'test', 2), 'T1'), x.trace + ' ' + ps);
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  ok('T14. control: a pass with no earlier author does not say "replaces it"', !/replaces it/.test(reasonOf(pOf(x, 'analyst'))) && !/The mechanism now/.test(reasonOf(pOf(x, 'analyst'))), reasonOf(pOf(x, 'analyst')));
  // T15
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AM], review: [REJ, REJ, D] });
  ok('T15. round A1 after W3 "mechanism" names the section and the rejection analyst', /#A1$/.test(ofRole(x, 'prog')[2].label) && byLate(pOf(x, 'prog', 2), 'review rejection'), labels(x) + ' ' + pOf(x, 'prog', 2).slice(0, 600));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED('r1'), RED('r2'), GREEN], analyst: [AM], review: [D] });
  ok('T15. round T1 after W4 "mechanism" names the section and the second-red analyst', /#T1$/.test(ofRole(x, 'prog')[2].label) && byLate(pOf(x, 'prog', 2), 'red tester round'), labels(x) + ' ' + pOf(x, 'prog', 2).slice(0, 600));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN], review: [D, D, D], analyst: [AM], train: [ride(11), ride(11), ride(0)] }, TB, ONE);
  ok('T15. the train round after W5 "mechanism" names the section and the red-train analyst', x.r.status === 'done' && byLate(pOf(x, 'prog', 2), 'red train'), x.full + ' ' + pOf(x, 'prog', 2).slice(0, 600));
  // T16
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3, P4], analyst: [AN, AM], test: [RED('r1'), RED('r2'), GREEN, GREEN], review: [REJ, D] });
  ok('T16. pass in 1 -> W4 "mechanism": tester T1 and round Tr name the replacement, not the pass',
    x.r.status === 'done' && byLate(pOf(x, 'test', 2), 'red tester round') && !byPass(pOf(x, 'test', 2), '1') && byLate(pOf(x, 'prog', 4), 'red tester round') && !byPass(pOf(x, 'prog', 4), '1'), x.trace + ' ' + labels(x));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3, P4], analyst: [AN, AM], test: [GREEN], review: [D, D, D, D], train: [ride(11), ride(11), ride(12), ride(0)] }, TB, ONE);
  ok('T16. pass in 1 -> W5 "mechanism": the round after the seam names the replacement, not the pass',
    x.r.status === 'done' && byLate(pOf(x, 'prog', 4), 'red train') && !byPass(pOf(x, 'prog', 4), '1'), x.full + ' ' + labels(x));
  // T17
  const TL = Object.assign({}, TB, { mode: 'light' });
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], review: [D, D, D, D], analyst: [AM], train: [ride(11), ride(11), ride(12), ride(0)] }, TL, ONE);
  ok('T17. light mode: W5 "mechanism" -> the programmer-checker rounds after it (t-n, after a seam) name the red-train analyst',
    x.r.status === 'done' && /PROGRAMMER-CHECKER/.test(pOf(x, 'prog', 2)) && byLate(pOf(x, 'prog', 2), 'red train') && byLate(pOf(x, 'prog', 3), 'red train') && !byLate(pOf(x, 'prog', 1), 'red train'), x.full + ' ' + labels(x));
  // T18
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AC], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  ok('T18. pass in 1 -> W4 "cells": tester T1 still names the pass of round 1', x.r.status === 'done' && byPass(pOf(x, 'test', 2), '1') && !/written last by the analyst of the second/.test(pOf(x, 'test', 2)), pOf(x, 'test', 2).slice(0, 600));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AC], test: [GREEN], review: [D, D, D], train: [ride(11), ride(11), ride(0)] }, TB, ONE);
  ok('T18. pass in 1 -> W5 "cells": the train round after it still names the pass of round 1', x.r.status === 'done' && byPass(pOf(x, 'prog', 3), '1') && !/written last by the analyst of the second/.test(pOf(x, 'prog', 3)), x.full + ' ' + labels(x));
  done();
})();
