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
//   M5. the rule: a line marked role:mechanism in rules/multi-agent.md (the exception from layer 2 and its Why), a
//       RULE_LIST entry carried by every role prompt, the coordinator skill's layer 2, README (section, Changes in 0.4.15).
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
  ok('M5. README: Changes in 0.4.15 names the mechanism step', /## Changes in 0\.4\.15[^#]*mechanism/.test(read('README.md')), '');
  ok('M5. README: how the chain decides - status mechanism and "mechanism or cells?"', /status `mechanism`/.test(rd) && /"mechanism or cells\?"/.test(rd), '');
  done();
})();
