#!/usr/bin/env node
'use strict';
// Task p-mechanism (diagnosis mechanism-gap, 2026-11-01): no role could say "the mechanism is wrong". In cvm-wheel-b a
// programmer invented a probe with a timer in round 1 and noted its flicker as one question among 36; the second analyst
// wrote more cells of the same mechanism; the reviewer judged the timer against the brief, not the mechanism.
//   M1. the analyst prompt (and agents/analyst.md): for a task with a new channel, protocol, timing or state a section
//       "Mechanism" before the matrix - 2-3 mechanisms with their cost, the invariant, the visible limits, a
//       recommendation; a choice seen on the screen or resting on time is "❓ owner" (layer 3), judged by sense;
//   M2. the programmer's status mechanism (schema, prompt, agents/programmer.md) -> one analyst pass inside the run ->
//       the programmer again; a second mechanism -> stopped for the coordinator; the pass with questions or not ready
//       stops; it runs in any round (a fix round, the light mode) and no selection runs on a mechanism round;
//   M3. the analyst of the second red tester round, of the second rejection and of the second red train first answers
//       "mechanism or cells?" and may replace the mechanism; its answer mechanismOrCells reaches the next programmer;
//   M4. the reviewer (prompt and agents/reviewer.md) writes one line: a simpler mechanism without timings, or "no";
//   M6. (review 1) the pass is recorded in the run: every later programmer, programmer-checker and tester prompt names
//       the section "Mechanism" of analyst.md and the round of the pass;
//   M7. (analyst after review 2) the section's author is recorded in the run (st.mechSection): the pass or a later
//       analyst (second rejection, second red tester round, second red train) that answered "mechanism"; every later
//       round and the later analysts name it; the later analyst keeps the earlier sections of analyst.md on "cells" and
//       names the replaced section on "mechanism"; the pass keeps the other sections; the route of status mechanism
//       stays (st.mechanism counts the pass only);
//   M5. the rule: a line marked role:mechanism in rules/multi-agent.md (the exception from layer 2 and its Why), a
//       RULE_LIST entry carried by every role prompt, the coordinator skill's layer 2, README (section, Changes in 0.4.16);
//       a pass of an earlier run reaches a relaunch as prior.mechanism (0.4.17, p-testerred-route).
// usage: node tests/p-mechanism.test.js
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

// What the mechanism section of an analyst prompt or agents/analyst.md must say.
const mechSection = (s) => /section "Mechanism"/.test(s) && /new channel[^.]*protocol, timing or state/.test(s) && /2-3 mechanisms/.test(s)
  && /cost/.test(s) && /invariant/.test(s) && /visible limits/.test(s) && /recommendation/.test(s)
  && /seen on the screen or rests? on time/.test(s) && /❓ owner/.test(s) && /layer 3/.test(s) && /not (by )?the coordinator's layer 2/.test(s)
  && /by (its )?sense/.test(s);
const MOC = /^First answer "mechanism or cells\?"/;

(async () => {
  const rules = await ruleList(CFG);
  const own = (p) => rules.reduce((s, r) => s.split(r[1]).join(''), p);

  // ---- M1: the analyst's section "Mechanism" ----
  let x = await run({ pre: [PRE], analyst: [AN], prog: [PROG], test: [GREEN], review: [D] }, Object.assign({}, T, { noAnalysis: undefined, analystFirst: true }));
  ok('M1. analystFirst: the chain runs pre>analyst>prog>test>review', x.r.status === 'done' && x.trace === 'pre>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('M1. the analyst prompt (its own part): a section "Mechanism" for a new channel, protocol, timing or state - 2-3 mechanisms with cost, invariant, visible limits, recommendation; screen or time -> "❓ owner", layer 3; judged by sense',
    mechSection(own(pOf(x, 'analyst'))), own(pOf(x, 'analyst')));
  ok('M1. agents/analyst.md: the same section "Mechanism"', mechSection(flat('agents/analyst.md')), flat('agents/analyst.md'));
  ok('M3. agents/analyst.md: after a second red or rejection first "mechanism or cells?", may replace the mechanism; the pass after status mechanism',
    /first answer "mechanism or cells\?"/.test(flat('agents/analyst.md')) && /may replace it/.test(flat('agents/analyst.md')) && /status `mechanism`/.test(flat('agents/analyst.md')), flat('agents/analyst.md'));

  // ---- M2: the programmer's status mechanism ----
  const PS = await schemaOf('PROG_SCHEMA');
  ok('M2. PROG_SCHEMA: status mechanism, described', PS.properties.status.enum.includes('mechanism') && /mechanism - /.test(PS.properties.status.description), JSON.stringify(PS.properties.status));
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  ok('M2. status mechanism -> one analyst pass -> the programmer again -> tester -> review -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  const p1 = own(pOf(x, 'prog'));
  ok('M2. the programmer prompt: status=mechanism when the solution needs a protocol, timer or state the analysis does not name, one line in prog.md, before the code',
    /status=mechanism/.test(p1) && /protocol, (a )?timer[^.]*state[^.]*the analysis (and the brief )?do(es)? not name/.test(p1) && /one line/.test(p1) && /prog\.md/.test(p1), p1);
  const ma = ofRole(x, 'analyst')[0] || { prompt: '', opts: {} };
  ok('M2. the mechanism pass: the analyst label and phase, the programmer\'s line, a section "Mechanism" in analyst.md',
    ma.opts.label === 'analyst:x' && ma.opts.phase === 'Analyst' && /status mechanism/.test(reasonOf(ma.prompt)) && reasonOf(ma.prompt).includes(MECH.summary)
      && /section "Mechanism"/.test(reasonOf(ma.prompt)) && /\/d\/prog\.md/.test(reasonOf(ma.prompt)), reasonOf(ma.prompt));
  const p2 = pOf(x, 'prog', 1);
  ok('M2. the programmer after the pass follows the section "Mechanism" of analyst.md and keeps its task',
    /\/d\/analyst\.md/.test(p2) && /section "Mechanism"/.test(p2) && /Start with red guards/.test(p2), p2);
  ok('M2. logged: status mechanism - analyst', x.logs.some((m) => /status mechanism[^\n]*analyst/.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [MECH, MECH], analyst: [AN] });
  ok('M2. a second mechanism after the pass -> stopped for the coordinator, no tester',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog' && /mechanism/.test(x.r.why) && /coordinator/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH], analyst: [Object.assign({}, AN, { questions: ['❓ owner: the probe flickers - accept?'] })] });
  ok('M2. the pass with a question (layer 3) -> stopped with the question, no second programmer',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst' && JSON.stringify(x.r.questions || []).includes('flickers'), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH], analyst: [Object.assign({}, AN, { ready: false })] });
  ok('M2. the pass not ready -> stopped', x.r.status === 'stopped' && x.trace === 'pre>prog>analyst', x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], test: [RED('r1'), GREEN], review: [D] });
  ok('M2. mechanism in a fix round (after a red tester) -> analyst -> the fix round again',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('M2. the fix round after the pass keeps its findings (test.md)', /\/d\/test\.md/.test(pOf(x, 'prog', 2)) && /section "Mechanism"/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  ok('M2. the mechanism pass does not take the analyst of the second red tester round',
    x.r.status === 'done' && x.trace === 'pre>prog>analyst>prog>test>prog>test>analyst>prog>test>review', x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, PROG, MECH], analyst: [AN], test: [RED('r1')] });
  ok('M2. a second mechanism in a later round -> stopped for the coordinator',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog>test>prog' && /mechanism/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D], train: [ride(0)] }, TB, ONE);
  ok('M2. with guardSubsetCommand no selection runs on the mechanism round, one after the programmer\'s commit',
    x.r.status === 'done' && x.full.startsWith('pre>prog>analyst>prog>run:x:select-') && (x.full.match(/run:x:select-/g) || []).length === 1, x.full);
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2], analyst: [AN], test: [GREEN], review: [D], train: [ride(0)],
    sel: [{ done: true, rc: 1, seconds: 1, log: '/d/wait.log', tail: '1 new red' }] }, TB, ONE);
  ok('M2. mechanism in the round after a red selection -> analyst -> that round again -> the selection on its HEAD',
    x.r.status === 'done' && x.full.startsWith('pre>prog>run:x:select-1>prog>analyst>prog>run:x:select-1f>test'), x.full + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, PROG, MECH], analyst: [AN], test: [GREEN],
    sel: [{ done: true, rc: 1, seconds: 1, log: '/d/wait.log', tail: '1 new red' }] }, TB, ONE);
  ok('M2. a second mechanism in the round after a red selection -> stopped for the coordinator, no tester',
    x.r.status === 'stopped' && x.trace === 'pre>prog>analyst>prog>prog' && /status mechanism again/.test(x.r.why) && /coordinator/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], review: [D] }, Object.assign({}, T, { mode: 'light' }));
  ok('M2. light mode: mechanism -> analyst -> programmer-checker -> review', x.r.status === 'done' && x.trace === 'pre>prog>analyst>prog>review', x.trace + ' ' + JSON.stringify(x.r));
  ok('M2. light mode: the programmer-checker prompt names status=mechanism', /status=mechanism/.test(own(pOf(x, 'prog'))), own(pOf(x, 'prog')));
  ok('M2. agents/programmer.md: status `mechanism` for a protocol, timer or state the analysis does not name',
    /status `?mechanism`?/.test(flat('agents/programmer.md')) && /protocol, (a )?timer[^.]*state[^.]*analysis/.test(flat('agents/programmer.md')), flat('agents/programmer.md'));

  // ---- M3: "mechanism or cells?" first ----
  const AS = await schemaOf('ANALYST_SCHEMA');
  ok('M3. ANALYST_SCHEMA: optional mechanismOrCells (mechanism | cells), not required',
    JSON.stringify((AS.properties.mechanismOrCells || {}).enum) === '["mechanism","cells"]' && !AS.required.includes('mechanismOrCells'), JSON.stringify(AS.properties.mechanismOrCells));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED('r1'), RED('r2'), GREEN], analyst: [Object.assign({}, AN, { mechanismOrCells: 'mechanism' })], review: [D] });
  let rs = reasonOf(pOf(x, 'analyst'));
  ok('M3. the analyst of the second red tester round first answers "mechanism or cells?" and may replace the mechanism',
    MOC.test(rs) && /may replace the mechanism/.test(rs) && /section "Mechanism"/.test(rs) && /matrix of cases/.test(rs) && pOf(x, 'analyst').includes('r2'), rs);
  ok('M3. its answer "mechanism" reaches the programmer: rework by the new section "Mechanism", not only cells',
    /replaced the mechanism/.test(pOf(x, 'prog', 2)) && /section "Mechanism"/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED('r1'), RED('r2'), GREEN], analyst: [Object.assign({}, AN, { mechanismOrCells: 'cells' })], review: [D] });
  ok('M3. answer "cells": the programmer gets the matrix, no rework of the mechanism', !/replaced the mechanism/.test(pOf(x, 'prog', 2)) && /matrix of cases/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AN], review: [REJ, REJ, D] });
  rs = reasonOf(pOf(x, 'analyst'));
  ok('M3. the analyst of the second rejection first answers "mechanism or cells?"', x.trace.includes('analyst') && MOC.test(rs) && /may replace the mechanism/.test(rs), x.trace + ' ' + rs);
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN], review: [D, D, D], analyst: [Object.assign({}, AN, { mechanismOrCells: 'mechanism' })], train: [ride(11), ride(11), ride(0)] }, TB, ONE);
  rs = reasonOf(pOf(x, 'analyst'));
  ok('M3. the analyst of the second red train first answers "mechanism or cells?"', x.r.status === 'done' && MOC.test(rs) && /may replace the mechanism/.test(rs) && /\/s\/train\/result\//.test(rs), x.trace + ' ' + rs);
  ok('M3. after the train analyst\'s "mechanism" the programmer reworks by the new section', /replaced the mechanism/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));

  // ---- M6 (review 1): the section "Mechanism" of the pass reaches every later round ----
  // The pass writes the mechanism into analyst.md; a later round that knows only the old analysis can bring the
  // rejected mechanism back (the cvm-wheel-b class). Later programmer, programmer-checker and tester prompts name it.
  const MREF = /section "Mechanism" of \/d\/analyst\.md[^\n]*round 1\b/;
  const mref = (s) => MREF.test(s);
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2], analyst: [AN], test: [RED('r1'), GREEN], review: [D] });
  ok('M6. after the pass: the tester prompt names the section "Mechanism" of analyst.md (pass in round 1)', x.r.status === 'done' && mref(pOf(x, 'test')), pOf(x, 'test'));
  ok('M6. after the pass: the fix round after a red tester names it', mref(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2], analyst: [AN], test: [GREEN, GREEN], review: [REJ, D] });
  ok('M6. after the pass: the fix round after a rejection names it', x.r.status === 'done' && mref(pOf(x, 'prog', 2)), x.trace + ' ' + pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2], analyst: [AN], test: [GREEN], review: [D], train: [ride(0)],
    sel: [{ done: true, rc: 1, seconds: 1, log: '/d/wait.log', tail: '1 new red' }] }, TB, ONE);
  ok('M6. after the pass: the round after a red selection names it', x.r.status === 'done' && mref(pOf(x, 'prog', 2)), x.full + ' ' + pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2], analyst: [AN], test: [GREEN], review: [D, D], train: [ride(11), ride(0)] }, TB, ONE);
  ok('M6. after the pass: the fix round after a red train names it', x.r.status === 'done' && mref(pOf(x, 'prog', 2)), x.full + ' ' + JSON.stringify(x.r) + ' ' + pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2], analyst: [AN], review: [REJ, D] }, Object.assign({}, T, { mode: 'light' }));
  ok('M6. light mode: the programmer-checker round after a rejection names it', x.r.status === 'done' && mref(pOf(x, 'prog', 2)), x.trace + ' ' + pOf(x, 'prog', 2));
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED('r1'), GREEN], review: [D] });
  ok('M6. without a pass no round names a section "Mechanism" of analyst.md', x.r.status === 'done' && !/section "Mechanism" of \/d\/analyst\.md/.test(pOf(x, 'prog', 1) + pOf(x, 'test') + pOf(x, 'test', 1)), pOf(x, 'prog', 1));

  // ---- M7 (analyst after review 2, cells A1-D2): who wrote the section "Mechanism" last reaches every later role ----
  const AM = Object.assign({}, AN, { mechanismOrCells: 'mechanism' }), AC = Object.assign({}, AN, { mechanismOrCells: 'cells' });
  const P4 = Object.assign({}, PROG, { head: 'P4' }), P5 = Object.assign({}, PROG, { head: 'P5' });
  const SEC = /section "Mechanism" of \/d\/analyst\.md/;
  const byPass = (s, r) => new RegExp('section "Mechanism" of /d/analyst\\.md[^\\n]*written last by the analyst\'s pass after the status mechanism of round ' + r + ';').test(s);
  const byLate = (s, who) => new RegExp('section "Mechanism" of /d/analyst\\.md[^\\n]*written last by the analyst of the second ' + who).test(s);
  const KEEP = (s) => /[Kk]eep the earlier sections of \/d\/analyst\.md, every section "Mechanism" among them/.test(s) && /on "cells" add the matrix to them/.test(s)
    && /on "mechanism" write a new section "Mechanism" that names the one it replaces/.test(s);
  const PASS_KEEP = (s) => /[Kk]eep the other sections of \/d\/analyst\.md/.test(s);
  const SEL_RED = { done: true, rc: 1, seconds: 1, log: '/d/wait.log', tail: '1 new red' }, SEL_GREEN = { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' };
  // A: the later analyst knows of the pass
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 A1. pass in round 1 -> second rejection: the analyst\'s reason first "mechanism or cells?", then names the section of the pass of round 1',
    x.r.status === 'done' && MOC.test(rs) && byPass(rs, '1'), x.trace + ' ' + rs);
  ok('M7 B1. the analyst of the second rejection: keep the earlier sections on cells, a new section naming the replaced one on mechanism', KEEP(rs), rs);
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 A2. pass in round 1 -> second red tester round: the analyst names the section of the pass of round 1', x.r.status === 'done' && MOC.test(rs) && byPass(rs, '1'), x.trace + ' ' + rs);
  ok('M7 B1. the analyst of the second red tester round: the keep rule', KEEP(rs), rs);
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], test: [GREEN], review: [D, D, D], train: [ride(11), ride(11), ride(0)] }, TB, ONE);
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 A3. pass in round 1 -> second red train: the analyst names the section of the pass of round 1', x.r.status === 'done' && MOC.test(rs) && byPass(rs, '1'), x.full + ' ' + rs);
  ok('M7 B1. the analyst of the second red train: the keep rule', KEEP(rs), rs);
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AN], review: [D, D, D], train: [ride(11), ride(11), ride(0)] }, Object.assign({}, TB, { mode: 'light' }), ONE);
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 A4. light mode: pass -> second red train: the analyst names the section of the pass of round 1', x.r.status === 'done' && MOC.test(rs) && byPass(rs, '1'), x.full + ' ' + rs);
  const noPass = [];
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AN], review: [REJ, REJ, D] }); noPass.push(reasonOf(pOf(x, 'analyst')));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [RED('r1'), RED('r2'), GREEN], analyst: [AN], review: [D] }); noPass.push(reasonOf(pOf(x, 'analyst')));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN], review: [D, D, D], analyst: [AN], train: [ride(11), ride(11), ride(0)] }, TB, ONE); noPass.push(reasonOf(pOf(x, 'analyst')));
  ok('M7 A5. without a pass no later analyst names a section of a pass or its author',
    noPass.every((s) => MOC.test(s) && !/status mechanism of round/.test(s) && !/written last by/.test(s)), noPass.join(' || '));
  x = await run({ pre: [PRE], prog: [PROG, MECH, P2, P3], analyst: [AN, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 A6. pass in round 2 -> second red tester round: round 2 is named, not round 1',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>analyst>prog>test>analyst>prog>test>review' && byPass(rs, '2') && !byPass(rs, '1'), x.trace + ' ' + rs);
  // B: the pass keeps the other sections
  x = await run({ pre: [PRE], analyst: [AN, AN], prog: [MECH, PROG], test: [GREEN], review: [D] }, Object.assign({}, T, { noAnalysis: undefined, analystFirst: true }));
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 B2. analystFirst -> pass: the pass keeps the other sections of analyst.md and adds the section "Mechanism"',
    x.r.status === 'done' && x.trace === 'pre>analyst>prog>analyst>prog>test>review' && PASS_KEEP(rs) && /section "Mechanism"/.test(rs), x.trace + ' ' + rs);
  x = await run({ pre: [PRE], prog: [PROG, P2, MECH, P3], analyst: [AC, AN], test: [RED('r1'), RED('r2'), GREEN], review: [D] });
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M7 B3. second red analyst "cells" -> status mechanism in round T1 -> the pass runs (not a stop) and keeps the other sections',
    x.r.status === 'done' && x.trace === 'pre>prog>test>prog>test>analyst>prog>analyst>prog>test>review' && PASS_KEEP(rs) && /status mechanism in round T1/.test(rs), x.trace + ' ' + rs);
  // C: a replacement by a later analyst reaches every later round
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AM], review: [REJ, REJ, D] });
  ok('M7 C1. no pass, the second-rejection analyst answers "mechanism" -> the tester A1 names the section and its author',
    x.r.status === 'done' && byLate(pOf(x, 'test', 2), 'review rejection'), x.trace + ' ' + pOf(x, 'test', 2).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [GREEN, GREEN, RED('a1'), GREEN], analyst: [AM], review: [REJ, REJ, D] });
  ok('M7 C2. ... -> tester A1 red -> the round A2 names the section and its author',
    x.r.status === 'done' && byLate(pOf(x, 'prog', 3), 'review rejection'), x.trace + ' ' + pOf(x, 'prog', 3).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [RED('r1'), RED('r2'), GREEN, GREEN], analyst: [AM], review: [REJ, D] });
  ok('M7 C3. no pass, the second-red analyst answers "mechanism" -> tester T1 and the round Tr after a rejection name it',
    x.r.status === 'done' && byLate(pOf(x, 'test', 2), 'red tester round') && byLate(pOf(x, 'prog', 3), 'red tester round'), x.trace + ' ' + pOf(x, 'prog', 3).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [GREEN], review: [D, D, D, D], analyst: [AM], train: [ride(11), ride(11), ride(12), ride(0)] }, TB, ONE);
  ok('M7 C4. no pass, the second-red-train analyst answers "mechanism" -> the round after a seam names it',
    x.r.status === 'done' && byLate(pOf(x, 'prog', 3), 'red train'), x.full + ' ' + JSON.stringify(x.r) + ' ' + pOf(x, 'prog', 3).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [GREEN, GREEN, GREEN], analyst: [AM], review: [REJ, REJ, D], train: [ride(0)],
    sel: [SEL_GREEN, SEL_GREEN, SEL_RED] }, TB, ONE);
  ok('M7 C5. no pass, the second-rejection analyst answers "mechanism" -> the round after a red selection names it',
    x.r.status === 'done' && byLate(pOf(x, 'prog', 3), 'review rejection'), x.full + ' ' + JSON.stringify(x.r) + ' ' + pOf(x, 'prog', 3).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], analyst: [AC], review: [REJ, REJ, D] });
  ok('M7 C6. no pass, the analyst answers "cells" -> the tester A1 names no section "Mechanism" of analyst.md',
    x.r.status === 'done' && !SEC.test(pOf(x, 'test', 2)) && !/written last by/.test(pOf(x, 'test', 2)), pOf(x, 'test', 2).slice(0, 700));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AM], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  ok('M7 C7. pass in round 1 -> the second-rejection analyst answers "mechanism" -> the tester A1 names the replacement, not the pass',
    x.r.status === 'done' && byLate(pOf(x, 'test', 2), 'review rejection') && !byPass(pOf(x, 'test', 2), '1'), pOf(x, 'test', 2).slice(0, 700));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, P3], analyst: [AN, AC], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  ok('M7 C8. pass in round 1 -> the analyst answers "cells" -> the tester A1 still names the pass of round 1',
    x.r.status === 'done' && byPass(pOf(x, 'test', 2), '1'), pOf(x, 'test', 2).slice(0, 700));
  x = await run({ pre: [PRE], prog: [PROG, P2, MECH, P3], analyst: [AM, AN], test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D] });
  ok('M7 C9. no pass, the analyst replaced the mechanism -> status mechanism in round A1 still gets the pass (the route is unchanged)',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>review>analyst>prog>analyst>prog>test>review' && byPass(pOf(x, 'test', 2), 'A1'), x.trace + ' ' + JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [MECH, PROG, P2, MECH], analyst: [AN, AN], test: [GREEN, GREEN], review: [REJ, REJ] });
  ok('M7 C10. pass in round 1 -> second-rejection analyst -> status mechanism in round A1 -> stopped for the coordinator',
    x.r.status === 'stopped' && /status mechanism again/.test(x.r.why) && /coordinator/.test(x.r.why), x.trace + ' ' + JSON.stringify(x.r));
  // D: the documents
  const an = flat('agents/analyst.md');
  ok('M7 D1. agents/analyst.md: on "cells" keep the earlier sections, every section "Mechanism" among them; on "mechanism" a new section names the one it replaces; the pass keeps the other sections',
    /keep the earlier sections of `analyst\.md`, every section "Mechanism" among them/.test(an) && /names the one it replaces/.test(an) && /pass keeps the other sections/.test(an), an);
  const mline = (read('rules/multi-agent.md').match(/[^\n]*<!-- role:mechanism -->/) || [''])[0];
  const mrule = (rules.find((r) => r[0] === 'mechanism') || ['', ''])[1];
  ok('M7 D2. the rule line and RULE_LIST: an answer "cells" keeps every section "Mechanism"',
    /answer "cells" keeps every section "Mechanism"/.test(mline) && /answer "cells" keeps every section "Mechanism"/.test(mrule), mline + ' || ' + mrule);
  ok('M7 D2. README Changes in 0.4.16: the author of the section and the keep rule', /## Changes in 0\.4\.16[^#]*written last[^#]*keeps every section "Mechanism"/.test(read('README.md').replace(/\s+/g, ' ')), '');

  // ---- M4: the reviewer's line ----
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });
  const rv = own(pOf(x, 'review'));
  ok('M4. the reviewer prompt: one line - a simpler mechanism without timings (timers, thresholds, races), named, or "no"',
    /simpler mechanism without timings/.test(rv) && /or "no"/.test(rv) && /review\.md/.test(rv), rv);
  ok('M4. agents/reviewer.md: the same line', /simpler mechanism without timings/.test(flat('agents/reviewer.md')) && /or "no"/.test(flat('agents/reviewer.md')), flat('agents/reviewer.md'));

  // ---- M5: the rule ----
  const md = read('rules/multi-agent.md');
  const line = (md.match(/[^\n]*<!-- role:mechanism -->/) || [''])[0];
  ok('M5. rules: a line marked role:mechanism - a section "Mechanism", screen or time is not layer 2, status mechanism, "mechanism or cells?", the reviewer\'s line',
    /section "Mechanism"/.test(line) && /layer 2/.test(line) && /`mechanism`/.test(line) && /"mechanism or cells\?"/.test(line) && /simpler mechanism/.test(line), line);
  ok('M5. rules: its Why names cvm-wheel-b and the cost', /Why[^\n]*cvm-wheel-b[^\n]*30M/.test(md.slice(md.indexOf('<!-- role:mechanism -->'))), md.slice(md.indexOf('<!-- role:mechanism -->'), md.indexOf('<!-- role:mechanism -->') + 600));
  ok('M5. rules: layer 2 names the exception (a mechanism seen on the screen or resting on time)', /reversible and local[^\n]*\n?[^\n]*/.test(md) && /not a storage format, an address, sharing, data deletion or security[^)]*mechanism/.test(flat('rules/multi-agent.md')), '');
  const mr = (rules.find((r) => r[0] === 'mechanism') || ['', ''])[1];
  ok('M5. RULE_LIST mechanism: the section, "❓ owner", status mechanism, "mechanism or cells?", the reviewer\'s line',
    /section "Mechanism"/.test(mr) && /❓ owner/.test(mr) && /status mechanism/.test(mr) && /"mechanism or cells\?"/.test(mr) && /simpler mechanism/.test(mr), mr);
  x = await run({ pre: [PRE], prog: [MECH, PROG], analyst: [AN], test: [GREEN], review: [D] });
  const lack = x.prompts.filter((p) => ['pre', 'analyst', 'prog', 'test', 'review'].includes(p.role) && !p.prompt.includes(mr)).map((p) => p.label);
  ok('M5. every role prompt carries the mechanism rule', mr && !lack.length, lack.join(','));
  ok('M5. coordinator skill: layer 2 names the exception', /not a storage format, an address, sharing, data deletion or security[^)]*mechanism/.test(flat('skills/coordinator/SKILL.md')), '');
  const rd = flat('README.md');
  ok('M5. README: Changes in 0.4.16 names the mechanism step', /## Changes in 0\.4\.16[^#]*mechanism/.test(read('README.md')), '');
  ok('M5. README: how the chain decides - status mechanism and "mechanism or cells?"', /status `mechanism`/.test(rd) && /"mechanism or cells\?"/.test(rd), '');
  // ---- M8 (0.4.16, tails of the p-mechanism review) ----
  // 1. the section "Mechanism" of the analystFirst analyst makes it the author (st.mechSection), so the pass names the
  //    section it replaces and every later round names that author; without the section nothing changes (B2).
  const AS8 = await schemaOf('ANALYST_SCHEMA');
  ok('M8 1. ANALYST_SCHEMA: mechanismSection, a boolean', AS8.properties.mechanismSection && AS8.properties.mechanismSection.type === 'boolean', JSON.stringify(AS8.properties.mechanismSection));
  const AF = Object.assign({}, T, { noAnalysis: undefined, analystFirst: true });
  const ANM = Object.assign({}, AN, { mechanismSection: true });
  const FIRST = /written last by the analyst before the first programmer/;
  x = await run({ pre: [PRE], analyst: [ANM], prog: [PROG], test: [GREEN], review: [D] }, AF);
  ok('M8 1. analystFirst asks the analyst to report mechanismSection', /mechanismSection/.test(pOf(x, 'analyst')), pOf(x, 'analyst'));
  ok('M8 1. analystFirst wrote a section "Mechanism" -> the programmer and the tester name it and its author',
    x.r.status === 'done' && FIRST.test(pOf(x, 'prog')) && FIRST.test(pOf(x, 'test')), pOf(x, 'prog'));
  x = await run({ pre: [PRE], analyst: [ANM, AN], prog: [MECH, PROG], test: [GREEN], review: [D] }, AF);
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M8 1. analystFirst with a section -> the pass names the section it replaces (its author) and still keeps the other sections',
    x.r.status === 'done' && x.trace === 'pre>analyst>prog>analyst>prog>test>review' && /your section replaces it and names it/.test(rs) && FIRST.test(rs) && PASS_KEEP(rs), x.trace + ' ' + rs);
  ok('M8 1. ... and the programmer after the pass names the pass, not the analystFirst analyst', byPass(pOf(x, 'prog', 1), '1') && !FIRST.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));
  x = await run({ pre: [PRE], analyst: [ANM, AN], prog: [PROG, P2, P3], test: [RED('r1'), RED('r2'), GREEN], review: [D] }, AF);
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M8 1. analystFirst with a section -> the analyst of the second red tester round names it as the mechanism now', MOC.test(rs) && FIRST.test(rs), rs);
  x = await run({ pre: [PRE], analyst: [AN, AN], prog: [MECH, PROG], test: [GREEN], review: [D] }, AF);
  rs = reasonOf(pOf(x, 'analyst', 1));
  ok('M8 1. analystFirst without a section -> no author before the pass (B2 unchanged)', !FIRST.test(pOf(x, 'prog')) && !/your section replaces it/.test(rs), rs);
  // 2. a pass made in an earlier run reaches the relaunch: since 0.4.17 (p-testerred-route) as the task field prior
  // (prior.mechanism), no longer as text in start, which the workflow does not read - in the coordinator skill, the
  // role-chain skill and the rules.
  const PRIOR = /prior[^.]*mechanism/;
  ok('M8 2. coordinator skill: a relaunch passes a pass "Mechanism" already made in prior', PRIOR.test(flat('skills/coordinator/SKILL.md')), '');
  ok('M8 2. role-chain skill: the same in the field prior', /\| `prior` \|[^\n]*mechanism/.test(read('skills/role-chain/SKILL.md')), '');
  ok('M8 2. rules: the same in the line role:mechanism', /prior(: \{mechanism: true\}|\.mechanism)/.test((read('rules/multi-agent.md').match(/[^\n]*<!-- role:mechanism -->/) || [''])[0]), '');
  done();
})();
