#!/usr/bin/env node
'use strict';
// p-tester-select, the tester's cells of the round after review 1 (the slots rule): what A10 of
// tests/p-tester-select.test.js does not cover. A10 checks the whole prompts of the programmer, the tester and the
// reviewer; the rule list is shared by every role, so here the remaining places of the same text:
//   PS1 the analyst (after the second red tester round) and the security reviewer (security work): over their whole
//       prompts the selection from the base (guards-all.sh --select <base>) is named only as the workflow's run, and
//       their slots rule names no selection from the base;
//   PS2 the light mode: the programmer-checker and the reviewer - the same;
//   PS3 the workflow's own selection step (the wait step) still runs guards-all.sh --select <base> <gdir> after every
//       programmer round, including the round after the analyst (the slots edit did not move it);
//   PS4 without guardSubsetCommand the slots rule still names the full guard run and no selection.
// usage: node tests/p-tester-select-prompts.test.js
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 800));

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}' });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };
const H = (c) => c.repeat(40);
const PROG = (c) => ({ status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: H(c), mutations: 'm', fullRun: 'r', questions: [], summary: 's' });
const GREEN = { verdict: 'green', summary: '', head: H('9') }, RED = { verdict: 'red', summary: 'r', head: H('9') };
const D = { verdict: 'done', docsOnly: false, summary: '' };

async function run(script, task = T, config = ONE) {
  const trace = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'green' };
    if (role === 'sha') return { sha: '' };
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    return q[role].shift();
  };
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), prompts };
}

const BASE_SEL = "guards-all.sh --select 'arc'";
// every place where a role prompt names the selection from the base must describe it as the workflow's run
const strayBase = (ps) => {
  const bad = [];
  for (const p of ps) {
    for (let i = p.prompt.indexOf(BASE_SEL); i >= 0; i = p.prompt.indexOf(BASE_SEL, i + 1)) {
      if (!/the workflow (runs|ran)/.test(p.prompt.slice(Math.max(0, i - 160), i))) bad.push(`${p.label}: ...${p.prompt.slice(Math.max(0, i - 160), i + 60)}`);
    }
  }
  return bad;
};
const slotsLine = (p) => (p.match(/Heavy work goes through memory slots:[^\n]*/) || [''])[0];
const cleanSlots = (p) => { const s = slotsLine(p); return s !== '' && !s.includes('--select \'arc\'') && !/--select '[0-9a-f]{40}'/.test(s); };
const ROLES = ['analyst', 'prog', 'test', 'review', 'sec'];

(async () => {
  // PS1: security work, two red tester rounds -> analyst -> programmer -> tester -> reviewer + security reviewer
  let x = await run({ pre: [PRE], prog: [PROG('1'), PROG('2'), PROG('3')], test: [RED, RED, GREEN], analyst: [AN], review: [D], sec: [D] },
    Object.assign({}, T, { security: true }));
  const roles = new Set(x.prompts.map((p) => p.role));
  ok('PS1. the run reaches the analyst and the security reviewer', x.r.status === 'done' && roles.has('analyst') && roles.has('sec'), `${x.r.status} ${x.trace}`);
  let bad = strayBase(x.prompts.filter((p) => ROLES.includes(p.role)));
  ok('PS1. whole prompts of the analyst and the security reviewer (and all others): the base selection only as the workflow\'s run', bad.length === 0, bad.join('\n'));
  const an = x.prompts.find((p) => p.role === 'analyst'), sec = x.prompts.find((p) => p.role === 'sec');
  ok('PS1. the slots rule of the analyst and of the security reviewer names no selection from the base',
    !!an && !!sec && cleanSlots(an.prompt) && cleanSlots(sec.prompt), `${an && slotsLine(an.prompt)} || ${sec && slotsLine(sec.prompt)}`);
  // PS3: the workflow's selection step after every programmer round (3 rounds, the third after the analyst) runs from base
  const steps = x.prompts.filter((p) => p.role === 'run').map((p) => p.prompt.split("'\\''").join("'"));
  ok('PS3. the workflow\'s selection runs guards-all.sh --select <base> after each of the 3 programmer rounds (also after the analyst)',
    steps.filter((s) => s.includes("/p/scripts/guards-all.sh --select 'arc' 'w'")).length >= 3, steps.length + ' run steps');
  // PS2: light mode
  x = await run({ pre: [PRE], prog: [PROG('1')], review: [D] }, Object.assign({}, T, { mode: 'light' }));
  const lp = x.prompts.filter((p) => p.role === 'prog' || p.role === 'review');
  bad = strayBase(lp);
  ok('PS2. light mode: programmer-checker and reviewer prompts name the base selection only as the workflow\'s run, slots clean',
    x.r.status === 'done' && lp.length === 2 && bad.length === 0 && lp.every((p) => cleanSlots(p.prompt)), `${x.r.status} ${x.trace} ${bad.join('\n')}`);
  // PS4: without guardSubsetCommand the slots rule is the old one: the full guard run, no selection
  x = await run({ pre: [PRE], prog: [PROG('1')], test: [GREEN], review: [D] }, T, CFG);
  const ts = slotsLine((x.prompts.find((p) => p.role === 'test') || { prompt: '' }).prompt);
  ok('PS4. without guardSubsetCommand: slots names the full guard run /p/scripts/guards-all.sh w and no --select',
    ts.includes('full guard run /p/scripts/guards-all.sh w') && !ts.includes('--select'), ts);
  done();
})();
