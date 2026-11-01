#!/usr/bin/env node
'use strict';
// p-train-only: no selection inside the task, the train is its first and only run of all guards (project key
// innerSelect: false; the default true keeps the selection after every programmer round, as before).
//   O1 innerSelect false: no selection step after any programmer round, no selection of the tester; the programmer and
//      the tester run only their new or changed guards and mutations; the train is the first full run.
//   O2 a red train fixed in the product (a file outside docs and testerWritable) -> programmer -> a short tester round
//      (the acceptance of the cells the fix touches, its own guards) -> the second review of the diff -> the train again.
//   O3 a red train fixed only in guards or docs -> programmer -> the second review -> the train again, no tester.
//   O4 a red short tester round -> a programmer round with test.md -> the tester again; the red tester rounds count
//      with the task's others (the second -> the analyst).
//   O5 the count "second red train -> analyst" counts only red (the task's own finding): not seam, conflict, arc-red,
//      coordinator or the environment.
//   O6 a conflict round that is only the merge of the arc with docs resolved (mergeOnlyFiles) -> no tester.
//   O7 innerSelect true or absent: the selection steps as before; the key is checked by scripts/config.js.
// usage: node tests/train-only.test.js
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
  // ---- O1: no selection inside the task ----
  let x = await run(G([ride(0)]));
  ok('O1. innerSelect false: pre > prog > tester > review > the train > done, no selection step',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>left:x:end` && !selects(x).length, x.full);
  const pp = pOf(x, 'prog'), tp = pOf(x, 'test');
  ok('O1. the programmer is told: no selection, no full run - only its new or changed guards and mutations; the train is the first full run',
    /no selection/i.test(pp) && /train/.test(pp) && /first/.test(pp) && !/the workflow runs the selection/.test(pp), pp);
  ok('O1. the tester runs no selection of its own (no guards-all.sh --select), only its guards and mutations; the train is the first full run',
    !/guards-all\.sh --select/.test(tp) && /train/.test(tp) && /first/.test(tp) && !/The workflow ran the selection/.test(tp), tp);
  ok('O1. the onerun rule in every role prompt says the train is the first run of all guards (innerSelect false)',
    [pp, tp, pOf(x, 'review')].every((p) => /innerSelect/.test(p) && /no selection/i.test(p)), pOf(x, 'review'));
  x = await run(G([ride(0)], { prog: [PROG, P2], test: [RED, GREEN] }));
  ok('O1. a red tester round and its fix: no selection after the fix round either',
    x.r.status === 'done' && !selects(x).length && x.trace === 'pre>prog>test>prog>test>review', x.full);
  x = await run({ pre: [PRE], prog: [PROG], review: [D], train: [ride(0)] }, Object.assign({}, T, { mode: 'light' }));
  ok('O1. light mode: programmer-checker > review > the train, no selection',
    x.r.status === 'done' && x.full === 'pre>prog>review>diff:x:reviewer>run:x:train-1>left:x:end', x.full);

  // ---- O2: a red train fixed in the product -> a short tester round -> review -> train ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN2], review: [D, D] }));
  ok('O2. red train, product fix -> programmer -> tester -> review of the diff -> the train again -> done',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>prog>test>post:x:tester>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  const st2 = pOf(x, 'test', 1);
  ok('O2. the short tester round: the acceptance of the cells the fix touches (its diff) and its own guards, the train result named',
    /train/.test(st2) && /\bT\.\.P2\b/.test(st2) && st2.includes('/s/train/result/x-T.json') && /cells/.test(st2), st2);
  ok('O2. the second review reads the diff of the fix (T..P2) after the tester', /T\.\.P2/.test(pOf(x, 'review', 1)), pOf(x, 'review', 1));
  ok('O2. the next ride carries the head after the tester round', (x.prompts.filter((p) => /:train-2/.test(p.label))[0] || { prompt: '' }).prompt.includes("--head '\\''P2'\\''"), (x.prompts.filter((p) => /:train-2/.test(p.label))[0] || { prompt: '' }).prompt);
  x = await run(G([ride(11), ride(0)], { prog: [PROG, MIX2], test: [GREEN, GREEN], review: [D, D] }));
  ok('O2. a fix touching a guard and a product file -> tester', /prog>test>post:x:tester>review/.test(x.full.split('train-1')[1] || ''), x.full);
  x = await run(G([ride(11), ride(0)], { prog: [PROG, NONE2], test: [GREEN, GREEN], review: [D, D] }));
  ok('O2. a new commit with no changed files reported -> tester (unknown is not docs)', /prog>test>post:x:tester>review/.test(x.full.split('train-1')[1] || ''), x.full);
  x = await run(G([ride(12), ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN], review: [D, D] }));
  ok('O2. a seam fixed in the product -> tester as well', x.r.status === 'done' && /prog>test>post:x:tester>review/.test(x.full.split('train-1')[1] || ''), x.full);
  x = await run(G([ride(11)], { prog: [PROG, P2], test: [GREEN, ENVT], review: [D] }));
  ok('O2. the short tester round red from the environment -> stopped with environment, no review, no ride',
    x.r.status === 'stopped' && !!x.r.environment && x.prompts.filter((p) => /:train-/.test(p.label)).length === 1, `${x.full} ${JSON.stringify(x.r)}`);

  // ---- O3: a red train fixed only in guards or docs -> no tester ----
  for (const [name, p2] of [['guards', GUARD2], ['docs', DOCS2]]) {
    x = await run(G([ride(11), ride(0)], { prog: [PROG, p2], review: [D, D] }));
    ok(`O3. red train, ${name}-only fix -> programmer -> review -> the train again, no tester`,
      x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>prog>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  }

  // ---- O4: a red short tester round -> programmer with test.md -> tester again; the count ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2, P3], test: [GREEN, RED, GREEN], review: [D, D] }));
  ok('O4. the short tester round red -> programmer with test.md -> tester green -> review -> train',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>test>prog>test>review' && /test\.md/.test(pOf(x, 'prog', 2)), `${x.trace} | ${x.full}`);
  x = await run(G([ride(11)], { prog: [PROG, P2, P3, P4], test: [RED, GREEN, RED, RED], review: [D], analyst: [AN] }));
  ok('O4. a red tester round after a train is the second red of the task -> the analyst in the same run',
    /tester>prog>test>review>prog>test>analyst/.test(x.trace.replace(/^pre>prog>/, '')) || /analyst/.test(x.trace), `${x.trace} ${JSON.stringify(x.r)}`);

  // ---- O5: only red trains count ----
  x = await run(G([ride(12), ride(11), ride(0)], { prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], review: [D, D, D] }));
  ok('O5. a seam, then a red: one red train only - no analyst', x.r.status === 'done' && !/analyst/.test(x.trace), x.trace);
  x = await run(G([ride(11), ride(11), ride(0)], { prog: [PROG, P2, P3], test: [GREEN, GREEN, GREEN], review: [D, D, D], analyst: [AN] }));
  ok('O5. two red trains -> the analyst', x.r.status === 'done' && /analyst/.test(x.trace), x.trace);

  // ---- O6: a conflict round that is only the merge with docs -> no tester ----
  const MO = Object.assign({}, OFF, { mergeOnlyFiles: ['*.md'] });
  x = await run(G([ride(13), ride(0)], { prog: [PROG, P2], review: [D, D], merge: [{ mergeOnly: true, reason: 'docs', files: ['a.md'] }] }), T, MO);
  ok('O6. a conflict resolved only in docs (merge-only) -> no tester, review, train', x.r.status === 'done' && /prog>merge:x:t1>review/.test(x.full) && !/train-1>prog>(merge:x:t1>)?test/.test(x.full), x.full);
  x = await run(G([ride(13), ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN], review: [D, D], merge: [{ mergeOnly: false, reason: 'code' }] }), T, MO);
  ok('O6. a conflict resolved in code -> tester', x.r.status === 'done' && /prog>merge:x:t1>test/.test(x.full), x.full);

  // ---- O7: the default keeps the selection; the key in config.js, the schema, the rule, the README ----
  x = await run(G([ride(0)]), T, CFG);
  ok('O7. innerSelect absent: the selection step after the programmer, as before', x.full.startsWith('pre>prog>run:x:select-1>test'), x.full);
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2], review: [D, D] }), T, Object.assign({}, CFG, { innerSelect: true }));
  ok('O7. innerSelect true: a red train -> programmer -> selection -> review -> train (no tester), as before',
    x.r.status === 'done' && /run:x:train-1>prog>run:x:select-t1>review/.test(x.full), x.full);
  const C = require(path.join(ROOT, 'scripts', 'config.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'train-only-'));
  const cfgOf = (extra) => { const f = path.join(tmp, `c${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: tmp, worktreeRoot: tmp, sharedDir: tmp, testerWritable: ['-run\\.js$'],
    guardRerun: { command: 'cd {wt} && x {name}', newRedPattern: '^FAILED (\\S+)', tallyPattern: '^=== (\\d+) total ===$' } }, extra))); return f; };
  const chk = (f) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', f], { encoding: 'utf8' });
  let c = chk(cfgOf({ guardSubsetCommand: 'cd {wt} && x {onlyArgs}', innerSelect: false }));
  ok('O7. config check: innerSelect false is accepted', c.status === 0, c.stdout + c.stderr);
  c = chk(cfgOf({ guardSubsetCommand: 'cd {wt} && x {onlyArgs}', innerSelect: 'no' }));
  ok('O7. config check: innerSelect not a boolean is an error', c.status !== 0 && /innerSelect/.test(c.stdout + c.stderr), c.stdout + c.stderr);
  ok('O7. the spec of the key: boolean, default true', C.SPEC ? JSON.stringify(C.SPEC.innerSelect) === '["boolean",true]' : /innerSelect: \['boolean', true\]/.test(read('scripts/config.js')));
  const schema = JSON.parse(read('schemas/codis-agents.schema.json'));
  ok('O7. the schema has innerSelect: boolean, default true', schema.properties.innerSelect && schema.properties.innerSelect.type === 'boolean' && schema.properties.innerSelect.default === true, JSON.stringify(schema.properties.innerSelect));
  const rules = read('rules/multi-agent.md');
  const onerun = rules.split('\n').filter((l) => /<!-- role:onerun -->/.test(l)).join('\n');
  ok('O7. rules: the onerun line names innerSelect and replaces the selection inside the task (Replaces:)',
    /innerSelect/.test(onerun) && /Replaces:/.test(onerun) && /short tester round/.test(onerun), onerun.slice(0, 300));
  ok('O7. README: the key innerSelect in the config table and Changes in 0.4.15', /\| `innerSelect` \|/.test(read('README.md')) && /Changes in 0\.4\.15/.test(read('README.md')));
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})();
