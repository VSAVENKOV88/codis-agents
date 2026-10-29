#!/usr/bin/env node
'use strict';
// p-train-c3: the chain after the review and the rules (cells W1-W15 of the analysis p-train-ac). With
// guardSubsetCommand a task whose review is done rides the integration train: the workflow runs one wait step,
// `train.js ride` (enqueue {task, branch, head after the review, base, dir} + await), whose exit code is the verdict:
//   0 green (merged) -> done; 10 green-unmerged -> done, the merge waits for the coordinator;
//   11 red, 12 seam, 13 conflict -> a programmer round with the train's result (its logs, files, partner) -> the selection
//     on the new HEAD -> the second review of the diff -> the train again; the second red of the task -> the analyst in the
//     same run (like the second red tester round), then one round; a red after it stops the task;
//   14 arc-red, 15 coordinator -> stopped for the coordinator (not the environment);
//   74 the queue unavailable, 75 the environment (the queue halted), 124 the deadline of the step -> stopped with
//     environment, the entry stays (a relaunch attaches to it);
//   65 refused before the queue (a protected base, not a branch).
// Without guardSubsetCommand there is no train: done after the review, as before. The light mode rides as well.
// usage: node tests/train-chain.test.js
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}' });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' }), P3 = Object.assign({}, PROG, { head: 'P3' }), P4 = Object.assign({}, PROG, { head: 'P4' });
const SAME = Object.assign({}, PROG, { head: 'T', changedFiles: [] });
const GREEN = { verdict: 'green', summary: '' };
const D = { verdict: 'done', docsOnly: false, summary: 'fine' };
const REJ = { verdict: 'rejected', docsOnly: false, summary: 'rej' };
const AN = { ready: true, cells: 3, subsystems: 1, split: [], questions: [], summary: 'matrix' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const ride = (rc, tail = '') => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail });

async function run(script, task = T, config = ONE) {
  const trace = [], full = [], prompts = [];
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
const trainSteps = (x) => x.prompts.filter((p) => /^run:x:train-/.test(p.label));
const unq = (s) => s.split("'\\''").join("'");
const HEAD = 'pre>prog>run:x:select-1>test>post:x:tester>review>diff:x:reviewer';
const G = (train, more = {}) => Object.assign({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], train }, more);

(async () => {
  // ---- W1: review done -> enqueue and wait for the train by a wait step ----
  let x = await run(G([ride(0)]));
  ok('W1. review done -> one train wait step after the reviewer post-check, then done',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>left:x:end`, x.full);
  const tp = unq((trainSteps(x)[0] || { prompt: '' }).prompt);
  ok('W1. the step runs train.js ride with the task, branch, the head after the review, base and folder, through wait-step.js',
    tp.includes("/p/scripts/train.js ride --task 'x' --branch 'b' --head 'T' --base 'arc' --dir '/d'") && tp.includes("node /p/scripts/wait-step.js start --id '/d/wait-train-1'"), tp);
  ok('W1. the step names the project config (CODIS_AGENTS_CONFIG), so the dispatcher finds the project from any directory',
    tp.includes("CODIS_AGENTS_CONFIG='/proj/.claude/codis-agents.json'"), tp);
  ok('W1. the train step is a cheap wait step of its own phase "Train"', trainSteps(x)[0] && trainSteps(x)[0].opts.phase === 'Train' && trainSteps(x)[0].opts.model === 'haiku', JSON.stringify(trainSteps(x)[0] && trainSteps(x)[0].opts));
  ok('W1. meta has the phase Train', /title: 'Train'/.test(SRC));

  // ---- W5: green -> done with the train's result ----
  ok('W5. green -> done; the result names the verdict green and the result file of the dispatcher',
    x.r.status === 'done' && x.r.train && x.r.train.verdict === 'green' && x.r.train.result === '/s/train/result/x-T.json' && x.r.train.log === '/d/wait-train.log', JSON.stringify(x.r));

  // ---- W6: green-unmerged -> done, the merge waits for the coordinator ----
  x = await run(G([ride(10)]));
  ok('W6. green-unmerged -> done with the note: the merge waits for the coordinator',
    x.r.status === 'done' && x.r.train && x.r.train.verdict === 'green-unmerged' && /merge waits for the coordinator/.test(x.r.train.note || ''), JSON.stringify(x.r));

  // ---- W7: red -> programmer with the train's result -> selection -> second review of the diff -> the train again ----
  x = await run(G([ride(11), ride(0)], { prog: [PROG, P2], review: [D, D] }));
  ok('W7. red -> programmer -> the selection on its HEAD -> review of the diff -> the train again -> done',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>prog>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  const fp = pOf(x, 'prog', 1);
  ok('W7. the fix round names the train\'s result file and its logs, red on the branch', fp.includes('/s/train/result/x-T.json') && /red/.test(fp) && /train/.test(fp) && /attribution/.test(fp), fp);
  ok('W7. the fix round is a fix round (reads the findings and the diff)', /Fix round/.test(fp) && fp.includes('/s/train/result/x-T.json'), fp);
  const rp = pOf(x, 'review', 1);
  ok('W7. the second review reads only the diff of the train fix (T..P2)', /T\.\.P2/.test(rp), rp);
  ok('W7. the second ride carries the new head', unq((trainSteps(x)[1] || { prompt: '' }).prompt).includes("--head 'P2'") && (trainSteps(x)[1] || {}).label === 'run:x:train-2', (trainSteps(x)[1] || {}).label);
  // explained without a commit (UC-8 2d): the coordinator decides, no new ride
  x = await run(G([ride(11)], { prog: [PROG, SAME] }));
  ok('W7. red explained without a commit -> stopped for the coordinator, no selection, no second ride',
    x.r.status === 'stopped' && trainSteps(x).length === 1 && !/select-t1/.test(x.full) && /coordinator/.test(x.r.why || '') && !x.r.environment, `${x.full} ${JSON.stringify(x.r)}`);
  // the review of the fix rejects -> stopped
  x = await run(G([ride(11)], { prog: [PROG, P2], review: [D, REJ] }));
  ok('W7. the review of the train fix rejects -> stopped for the coordinator, no second ride',
    x.r.status === 'stopped' && trainSteps(x).length === 1 && /review/.test(x.r.why || ''), `${x.full} ${JSON.stringify(x.r)}`);

  // ---- W8: the second red of the task -> the analyst, then one round; red after it -> stopped ----
  x = await run(G([ride(11), ride(11), ride(0)], { prog: [PROG, P2, P3], review: [D, D, D], analyst: [AN] }));
  ok('W8. second red -> the analyst in the same run -> programmer -> selection -> review -> train -> done',
    x.r.status === 'done' && x.trace === 'pre>prog>test>review>prog>review>analyst>prog>review' && trainSteps(x).length === 3, `${x.trace} | ${x.full}`);
  ok('W8. the analyst gets the train\'s results as inputs', /train/.test(pOf(x, 'analyst')) && pOf(x, 'analyst').includes('/s/train/result/x-P2.json'), pOf(x, 'analyst'));
  ok('W8. the round after the analyst follows its matrix', /analyst\.md/.test(pOf(x, 'prog', 2)), pOf(x, 'prog', 2));
  x = await run(G([ride(11), ride(11), ride(11)], { prog: [PROG, P2, P3], review: [D, D, D], analyst: [AN] }));
  ok('W8. a red train after that analyst -> stopped (train red after analyst)', x.r.status === 'stopped' && /train red after (the )?analyst/.test(x.r.why || '') && trainSteps(x).length === 3, `${x.full} ${JSON.stringify(x.r)}`);
  x = await run(G([ride(11), ride(11)], { prog: [PROG, P2], review: [D, D], analyst: [Object.assign({}, AN, { ready: false })] }));
  ok('W8. the analyst not ready -> stopped', x.r.status === 'stopped' && /analyst/.test(x.r.why || ''), JSON.stringify(x.r));
  // conflict and seam do not count as red trains
  x = await run(G([ride(13), ride(11), ride(0)], { prog: [PROG, P2, P3], review: [D, D, D] }));
  ok('W8. a conflict, then a red: one red only - no analyst', x.r.status === 'done' && !/analyst/.test(x.trace), x.trace);

  // ---- W9: conflict -> merge the arc head into the branch ----
  x = await run(G([ride(13), ride(0)], { prog: [PROG, P2], review: [D, D] }));
  ok('W9. conflict -> programmer -> selection -> review -> train -> done',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:train-1>prog>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  ok('W9. the round says: merge the head of the arc branch into the branch, resolve the files named in the result',
    /merge the head of the arc branch arc/.test(pOf(x, 'prog', 1)) && /conflict/.test(pOf(x, 'prog', 1)) && pOf(x, 'prog', 1).includes('/s/train/result/x-T.json'), pOf(x, 'prog', 1));

  // ---- W10: seam with Y -> a round "seam with Y" on the new arc head ----
  x = await run(G([ride(12), ride(0)], { prog: [PROG, P2], review: [D, D] }));
  ok('W10. seam -> programmer -> selection -> review -> train -> done', x.r.status === 'done' && trainSteps(x).length === 2 && /select-t1/.test(x.full), x.full);
  ok('W10. the round: the seam with the partner named in the result, on the arc head that already holds it',
    /seam/.test(pOf(x, 'prog', 1)) && /partner/.test(pOf(x, 'prog', 1)) && /merge the head of the arc branch arc/.test(pOf(x, 'prog', 1)) && pOf(x, 'prog', 1).includes('/s/train/result/x-T.json'), pOf(x, 'prog', 1));

  // ---- W11: environment / arc-red / coordinator ----
  for (const [rc, re, env] of [[75, /environment/, true], [74, /queue/, true], [124, /deadline/, true], [14, /arc-red/, false], [15, /coordinator/, false]]) {
    x = await run(G([ride(rc)]));
    ok(`W11. train exit ${rc} -> stopped${env ? ' with environment' : ' for the coordinator, not the environment'}`,
      x.r.status === 'stopped' && re.test(x.r.why || '') && !!x.r.environment === env && trainSteps(x).length === 1 && x.r.train && x.r.train.rc === rc, JSON.stringify(x.r));
  }
  x = await run(G([ride(74)]));
  ok('W2. the queue unavailable -> the stop names the branch and the head the review accepted', /branch b\b/.test(x.r.why || '') && /head T\b/.test(x.r.why || '') && /queue/.test(x.r.why || ''), x.r.why);
  x = await run(G([ride(65)]));
  ok('W4. refused before the queue (exit 65) -> stopped, no programmer round', x.r.status === 'stopped' && /refused/.test(x.r.why || '') && x.trace === 'pre>prog>test>review', JSON.stringify(x.r));
  x = await run(G([ride(66)]));
  ok('train exit 66 (no entry, no result) -> stopped for the coordinator', x.r.status === 'stopped' && trainSteps(x).length === 1, JSON.stringify(x.r));
  x = await run(G([{ done: false, rc: null, log: '/d/wait-train-1.log', error: 'no JSON' }, { done: false, rc: null, log: '/d/wait-train-1.log', error: 'no JSON' }]));
  ok('the train step could not run (no exit code, twice) -> stopped', x.r.status === 'stopped' && /wait step train-1/.test(x.r.why || ''), JSON.stringify(x.r));

  // ---- W14: the deadline -> the entry stays; the relaunch attaches (the same command; ride is idempotent) ----
  x = await run(G([ride(124)]));
  ok('W14. the deadline of the train step -> environment, the queue entry stays, a relaunch attaches to it',
    x.r.status === 'stopped' && !!x.r.environment && /entry stays/.test(x.r.why || '') && /relaunch/.test(x.r.why || ''), x.r.why);

  // ---- W12: the light mode rides too ----
  const L = Object.assign({}, T, { mode: 'light' });
  x = await run({ pre: [PRE], prog: [PROG], review: [D], train: [ride(0)] }, L);
  ok('W12. light: programmer-checker > selection > review > the train > done',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>run:x:train-1>left:x:end' && unq(trainSteps(x)[0].prompt).includes("--head 'P'"), x.full);
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [D, D], train: [ride(11), ride(0)] }, L);
  ok('W12. light, red train -> the programmer-checker -> selection -> review -> train -> done',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>run:x:train-1>prog>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end'
      && /PROGRAMMER-CHECKER/.test(pOf(x, 'prog', 1)), x.full);
  x = await run({ pre: [PRE], prog: [PROG, P2], review: [REJ, D], train: [ride(0)] }, L);
  ok('W12. light, a rejection then done -> the train on the fixed head', x.r.status === 'done' && trainSteps(x).length === 1 && unq(trainSteps(x)[0].prompt).includes("--head 'P2'"), x.full);
  // after the full mode's rejection loop and after the analyst of a second rejection, done rides as well
  x = await run(G([ride(0)], { prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] }));
  ok('W1. done after a rejection and its fix -> the train on the fixed head', x.r.status === 'done' && trainSteps(x).length === 1 && unq(trainSteps(x)[0].prompt).includes("--head 'T'"), x.full);

  // ---- W13: no guardSubsetCommand -> no train ----
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, Object.assign({}, T, { base: undefined }), CFG);
  ok('W13. without guardSubsetCommand: done after the review, no train step', x.r.status === 'done' && !trainSteps(x).length && !x.r.train, x.full);

  // ---- cap: a train that keeps sending the task back stops ----
  x = await run(G([ride(13), ride(13), ride(13), ride(13)], { prog: [PROG, P2, P3, P4], review: [D, D, D, D] }));
  ok('a fourth ride that is still not green -> stopped for the coordinator', x.r.status === 'stopped' && trainSteps(x).length === 4 && /train/.test(x.r.why || ''), `${x.full} ${JSON.stringify(x.r)}`);

  // ---- W3, W4: base with guardSubsetCommand ----
  x = await run(G([]), Object.assign({}, T, { base: 'b70a6dc0123456789abcdef0123456789abcdef0'.slice(0, 40) }));
  ok('W3. a base that is a full commit sha -> stopped in the preconditions before any agent', x.r.status === 'stopped' && x.r.why === 'preconditions' && x.trace === '' && /branch/.test((x.r.problems || []).join(' ')), JSON.stringify(x.r));
  x = await run(G([]), Object.assign({}, T, { base: undefined }));
  ok('W3. no base -> stopped in the preconditions', x.r.status === 'stopped' && x.trace === '', JSON.stringify(x.r));
  x = await run(G([]), Object.assign({}, T, { base: 'main' }));
  ok('W4. a protected base -> stopped in the preconditions', x.r.status === 'stopped' && x.trace === '' && /protected/.test((x.r.problems || []).join(' ')), JSON.stringify(x.r));
  x = await run(G([ride(0)]));
  ok('W3. the precondition agent checks that base is a branch of the repository (refs/heads/<base>)', /refs\/heads\/arc/.test(pOf(x, 'pre')), pOf(x, 'pre'));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, Object.assign({}, T, { base: undefined }), CFG);
  ok('W3. without guardSubsetCommand the precondition agent does not check base', !/refs\/heads\//.test(pOf(x, 'pre')), pOf(x, 'pre'));

  // ---- W15: the rules, the skills, the README ----
  const rules = read('rules/multi-agent.md');
  const seam = rules.split('\n').find((l) => /^- \*\*The train is the seam check/.test(l)) || '';
  ok('W15. multi-agent.md: "The train is the seam check" with Replaces: "Check the seam of parallel branches"',
    /Replaces: "Check the seam of parallel branches/.test(seam) && /guardSubsetCommand/.test(seam), seam);
  ok('W15. multi-agent.md: the chain after the review rides the train (train.js ride), its verdicts and the second red -> analyst',
    /train\.js ride/.test(rules) && /green-unmerged/.test(rules) && /second red train/.test(rules), '');
  ok('W15. the role-chain skill describes the train step', /train\.js ride/.test(read('skills/role-chain/SKILL.md')) && /Train/.test(read('skills/role-chain/SKILL.md')));
  ok('W15. the coordinator skill: the train merges, the coordinator lifts a halt (train.js resume) and merges green-unmerged',
    /train\.js resume/.test(read('skills/coordinator/SKILL.md')) && /green-unmerged/.test(read('skills/coordinator/SKILL.md')));
  ok('W15. README: train.js ride and the verdict codes', /`ride`/.test(read('README.md')) && /green-unmerged/.test(read('README.md')) && /coordinator/.test(read('README.md')));
  done();
})();
