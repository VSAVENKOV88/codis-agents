#!/usr/bin/env node
'use strict';
// p-train-only, the tester's cells (round 1), beyond tests/train-only.test.js O1-O7:
//   U1 innerSelect false without guardSubsetCommand is inert (the programmer's full run, no train);
//   U1b innerSelect true without guardSubsetCommand: no selection text in role prompts;
//   U2 the analyst's round after the second red train has no selection, the tester runs;
//   U3 arc-red / coordinator / queue environment of a ride: no fix round, no short tester;
//   U4 a conflict fixed in the product without mergeOnlyFiles -> the short tester round;
//   U5 the short tester round's own commit is carried to the second review and the ride;
//   U6 the fix-round prompt after a red train names the short tester round, no selection;
//   U7 innerSelect true: the selection after every programmer round, no short tester.
// Round after review 1 (beyond O8/O9):
//   V1 after the analyst of a red short tester round (inside the ride loop) a red short tester round of the next ride
//      stops the task ("tester red after analyst"), no second analyst, rides train-1, train-2 only;
//   V2 that analyst not ready (questions) -> stopped, no further ride;
//   V3 the ride after that analyst carries the review summary and the head of the analyst's round;
//   V4 light mode: a seam or a conflict fixed in the product -> no tester either, the light fix prompt;
//   V5 after the analyst of the second red train a short tester red twice -> "still red after a fix round", one analyst.
// usage: node tests/train-only-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json',
  guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const OFF = Object.assign({}, CFG, { innerSelect: false });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' }), P3 = Object.assign({}, PROG, { head: 'P3' }), P4 = Object.assign({}, PROG, { head: 'P4' });
const GUARD2 = Object.assign({}, PROG, { head: 'P2', changedFiles: ['g/x-run.js'] });
const DOCS2 = Object.assign({}, PROG, { head: 'P2', changedFiles: ['README.md', 'docs/a.md'] });
const MIX2 = Object.assign({}, PROG, { head: 'P2', changedFiles: ['g/x-run.js', 'src/b.js'] });
const NONE2 = Object.assign({}, PROG, { head: 'P2', changedFiles: [] });
const GREEN = { verdict: 'green', summary: '' };
const GREEN2 = { verdict: 'green', summary: '', head: 'P2' }; // a short tester round with no commit of its own
const RED = { verdict: 'red', summary: 'cell 3 red' };
const ENVT = { verdict: 'environment', summary: 'e', environment: 'swap' };
const D = { verdict: 'done', docsOnly: false, summary: 'fine' };
const AN = { ready: true, cells: 3, subsystems: 1, split: [], questions: [], summary: 'matrix' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const ride = (rc) => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail: '' });

async function run(script, task = T, config = OFF) {
  const trace = [], full = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run', 'merge'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'merge') return q.merge && q.merge.length ? q.merge.shift() : { mergeOnly: false };
    if (role === 'run') {
      if (/:train-/.test(opts.label)) {
        if (!q.train || !q.train.length) throw new Error('extra train step after ' + full.join('>'));
        return q.train.shift();
      }
      return OKR;
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
      agent, pipeline, null, () => {}, () => {}, { owner: 'o', config, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts };
}
const pOf = (x, role, i = 0) => (x.prompts.filter((p) => p.role === role)[i] || { prompt: '' }).prompt;
const selects = (x) => x.prompts.filter((p) => p.role === 'run' && /:select-/.test(p.label));
const HEAD = 'pre>prog>test>post:x:tester>review>diff:x:reviewer';
const G = (train, more = {}) => Object.assign({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], train }, more);

(async () => {
  // ---- U1: innerSelect false without guardSubsetCommand is inert: the programmer's own full run, no train ----
  const NOSUB = Object.assign({}, OFF); delete NOSUB.guardSubsetCommand;
  let x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, T, NOSUB);
  const pp = pOf(x, 'prog');
  ok('U1. innerSelect false without guardSubsetCommand: no selection, no train, the programmer runs the full run as before',
    x.r.status === 'done' && !selects(x).length && !x.prompts.some((p) => /:train-/.test(p.label)) && /full run \/p\/scripts\/guards-all\.sh w/.test(pp) && !/guards-all\.sh --select/.test(pp) && !/innerSelect false/.test(pp), `${x.full} | ${pp.slice(0, 300)}`);

  // U1b: innerSelect true (the default) without guardSubsetCommand: the selection texts never reach a role (INNER needs ONE_RUN)
  const NOSUB_T = Object.assign({}, NOSUB, { innerSelect: true });
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, T, NOSUB_T);
  ok('U1b. innerSelect true without guardSubsetCommand: no selection step and no selection in any role prompt',
    x.r.status === 'done' && !selects(x).length && x.prompts.filter((p) => ['prog', 'test', 'review'].includes(p.role)).every((p) => !/guards-all\.sh --select/.test(p.prompt)), x.full);

  // ---- U2: the analyst after the second red train - its round has no selection either, and the tester runs ----
  x = await run(G([ride(11), ride(11), ride(0)], { prog: [PROG, P2, P3, P4], test: [GREEN, GREEN, GREEN, GREEN], review: [D, D, D, D], analyst: [AN] }));
  ok('U2. two red trains -> the analyst -> its round: programmer > tester > review > train, no selection anywhere',
    x.r.status === 'done' && /analyst>prog>test>review/.test(x.trace) && !selects(x).length, `${x.trace} | ${x.full}`);

  // ---- U3: arc-red, coordinator and the environment of the queue: no fix round, no short tester ----
  for (const [rc, name, want] of [[14, 'arc-red', 'stopped'], [15, 'coordinator', 'stopped'], [74, 'queue unavailable', 'stopped']]) {
    x = await run(G([ride(rc)]));
    ok(`U3. innerSelect false, train ${name} (${rc}) -> ${want}, no programmer round, no short tester`,
      x.r.status === want && x.trace === 'pre>prog>test>review', `${x.trace} ${JSON.stringify(x.r).slice(0, 200)}`);
  }

  // ---- U4: a conflict (13) fixed in the product without mergeOnlyFiles -> the short tester round ----
  x = await run(G([ride(13), ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN], review: [D, D] }));
  ok('U4. a conflict fixed in the product (no mergeOnlyFiles) -> programmer > tester > review > train', x.r.status === 'done'
    && /train-1>prog>test>post:x:tester>review>diff:x:reviewer>run:x:train-2/.test(x.full) && !selects(x).length, x.full);

  // ---- U5: the short tester round commits its own guard: the second review and the ride carry the tester's head ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2], test: [GREEN, Object.assign({}, GREEN, { head: 'T2' })], review: [D, D] }));
  const rv2 = pOf(x, 'review', 1), ride2 = (x.prompts.filter((p) => /:train-2/.test(p.label))[0] || { prompt: '' }).prompt;
  ok('U5. the tester\'s guard commit after the train: the second review reads T..T2, the ride carries T2', /T\.\.T2/.test(rv2) && ride2.includes("--head '\\''T2'\\''"), `${rv2.slice(-300)} | ${ride2.slice(-300)}`);

  // ---- U6: the fix round prompt after a red train names no selection (innerSelect false) ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN], review: [D, D] }));
  const fp = pOf(x, 'prog', 1);
  ok('U6. the fix round after a red train: no selection by the workflow, a short tester round named', !/the workflow runs the selection on your new HEAD/.test(fp) && /short tester round/.test(fp), fp.slice(-600));

  // ---- U7: innerSelect true keeps the selection in the fix round after a red tester and in the train fix ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2, P3], test: [RED, GREEN], review: [D, D] }), T, Object.assign({}, CFG, { innerSelect: true }));
  ok('U7. innerSelect true: selection after every programmer round (1, the tester fix, the train fix), no short tester',
    x.r.status === 'done' && selects(x).length === 3 && x.trace === 'pre>prog>test>prog>test>review>prog>review', `${x.trace} | ${x.full}`);
  // ---- V1-V5: round after review 1 ----
  const RIDES = (x) => x.prompts.filter((p) => p.role === 'run' && /:train-/.test(p.label)).map((p) => p.label);
  const nOf = (x, role) => x.prompts.filter((p) => p.role === role).length;
  const P5 = Object.assign({}, PROG, { head: 'P5' });
  x = await run(G([ride(11), ride(11)], { prog: [PROG, P2, P3, P4, P5], test: [RED, GREEN, RED, GREEN, RED], review: [D, D], analyst: [AN] }));
  ok('V1. after the analyst of a red short tester round: the next ride red, short tester red -> stopped (tester red after analyst), one analyst, two rides',
    x.r.status === 'stopped' && /tester red after analyst/.test(x.r.why || '') && nOf(x, 'analyst') === 1 && JSON.stringify(RIDES(x)) === '["run:x:train-1","run:x:train-2"]',
    `${JSON.stringify(RIDES(x))} ${x.full} ${JSON.stringify(x.r)}`);
  const NR = Object.assign({}, AN, { ready: false, questions: ['q?'] });
  x = await run(G([ride(11)], { prog: [PROG, P2, P3], test: [RED, GREEN, RED], review: [D], analyst: [NR] }));
  ok('V2. that analyst needs an answer -> stopped, no further ride, no T round',
    x.r.status === 'stopped' && /analyst after the second red tester round/.test(x.r.why || '') && RIDES(x).length === 1 && nOf(x, 'prog') === 3,
    `${JSON.stringify(RIDES(x))} ${x.full} ${JSON.stringify(x.r)}`);
  const DT = Object.assign({}, D, { summary: 'T-round review' });
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2, P3, P4], test: [RED, GREEN, RED, Object.assign({}, GREEN, { head: 'TT' })], review: [D, DT], analyst: [AN] }));
  const r2 = (x.prompts.filter((p) => /:train-2/.test(p.label))[0] || { prompt: '' }).prompt;
  ok('V3. the ride after that analyst carries the review of its T round and the head after its tester',
    x.r.status === 'done' && x.r.review === 'T-round review' && r2.includes("--head '\\''TT'\\''") && nOf(x, 'review') === 2,
    `${x.full} ${JSON.stringify(x.r)} ${r2.slice(-200)}`);
  const L = Object.assign({}, T, { mode: 'light' });
  for (const rc of [12, 13]) {
    x = await run({ pre: [PRE], prog: [PROG, P2], review: [D, D], train: [ride(rc), ride(0)] }, L);
    const lp = pOf(x, 'prog', 1);
    ok(`V4. light mode, ${rc === 12 ? 'seam' : 'conflict'} fixed in the product -> programmer-checker -> review -> train, no tester; the light fix prompt`,
      x.r.status === 'done' && x.full === 'pre>prog>review>diff:x:reviewer>run:x:train-1>prog>review>diff:x:reviewer>run:x:train-2>left:x:end'
      && /no tester round in the light mode/i.test(lp) && !/gets a short tester round, then the second review/.test(lp), `${x.full} | ${lp.slice(-400)}`);
  }
  x = await run(G([ride(11), ride(11)], { prog: [PROG, P2, P3, P4], test: [GREEN, GREEN, RED, RED], review: [D, D], analyst: [AN] }));
  ok('V5. after the analyst of the second red train: short tester red, fix, red again -> still red after a fix round, one analyst',
    x.r.status === 'stopped' && /still red after a fix round/.test(x.r.why || '') && nOf(x, 'analyst') === 1 && RIDES(x).length === 2,
    `${JSON.stringify(RIDES(x))} ${x.full} ${JSON.stringify(x.r)}`);
  done();
})();
