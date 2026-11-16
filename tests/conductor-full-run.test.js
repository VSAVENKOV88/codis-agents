#!/usr/bin/env node
'use strict';
// The full guard run as a wait step of the conductor (p-codex-fullrun-a1, mechanism M1 of its analysis, cells F1'-F26b):
// without guardSubsetCommand, under the conductor (exec) and with conductorFullRun not false, the workflow itself runs
// guards-all.sh <gdir> on every new programmer HEAD (and on the HEAD of a green tester's own commits) as a wait step,
// checks the copy of its log (scripts/guards-result.js copy-check) and hands it to the next role; no role runs the full
// suite. The chain runs through scripts/chain-run.js runScript with a fake launcher (the roles) and a fake exec (the
// service steps), so no process, slot or model is used. The copy check itself is tested on real files at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CRM = require('../scripts/chain-run.js');

const ROOT = path.join(__dirname, '..');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cond-full-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

const SD = path.join(W, 'steps', 'x');
const P1 = '1'.repeat(40), P2 = '2'.repeat(40), P3 = '3'.repeat(40), T1 = '7'.repeat(40), B = 'b'.repeat(40);
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const prog = (head, extra) => Object.assign({ status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head, mutations: 'm', fullRun: 'the workflow runs it', questions: [], summary: 's' }, extra || {});
const GREEN = (head) => ({ verdict: 'green', head, summary: 'acc ok' });
const RED = (head) => ({ verdict: 'red', head, summary: 'a red cell' });
const DONE = { verdict: 'done', docsOnly: false, summary: 'ok' };
const AN = { ready: true, cells: 3, subsystems: 1, split: [], questions: [], summary: 'a', mechanismSection: true };
const BASE_CFG = { sharedDir: path.join(W, 's'), worktreeRoot: path.join(W, 'r'), scriptsDir: '/p/scripts', configPath: '/c/codis-agents.json',
  testerWritable: ['-run\\.js$'], protectedBranches: ['main'], guardRerun: { command: 'true {wt} {name}', newRedPattern: '^FAIL (\\S+) \\(', tallyPattern: '^\\d+ of (\\d+) test files passed' } };
const BASE_T = { key: 'x', title: 'X', wt: '/w', gdir: '/w', branch: 'b', accept: 'acc', kind: 'tail', noAnalysis: 'a test task', dir: path.join(W, 'd'), stepDir: SD };

// o: {q: answers per role kind (pre, prog, test, review, sec, analyst), run: {<step>: answer}, copy: {<step>: answer},
//     config, task, workflow (no exec: the Workflow runtime with a fake agent)}
async function chain(o) {
  const q = {};
  for (const [k, v] of Object.entries(o.q)) q[k] = v.slice();
  const roles = [], seen = [], logs = [], order = [];
  const answerRole = (label) => {
    const k = label.split(':')[0];
    const list = q[k] || [];
    return list.length ? list.shift() : null;
  };
  const runAns = (s) => {
    const step = s.label.split(':')[2];
    const a = (o.run || {})[step];
    return a === undefined ? { done: true, rc: 0, seconds: 1, log: `${SD}/wait-${step}.log`, tail: '196 of 196 test files passed' } : typeof a === 'function' ? a(s) : a;
  };
  const copyAns = (s) => {
    const step = s.label.split(':')[2].replace(/-copy(#retry)?$/, '');
    const a = (o.copy || {})[step];
    return a === undefined ? { ok: true, cut: false, why: '', flaky: [] } : a;
  };
  const svcAns = (s) => {
    if (s.kind === 'env') return { ok: true, problems: [], notes: [] };
    if (s.kind === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (s.kind === 'diff') return { ok: true, offending: [] };
    if (s.kind === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (s.kind === 'run') return runAns(s);
    if (s.kind === 'copy') return copyAns(s);
    return null;
  };
  const config = Object.assign({}, BASE_CFG, o.config || {});
  const task = Object.assign({}, BASE_T, o.task || {});
  if (o.workflow) {
    // the Workflow runtime: no exec, every step through agent()
    const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
    const AF = Object.getPrototypeOf(async function () {}).constructor;
    const agent = async (prompt, opts) => {
      const k = opts.label.split(':')[0];
      order.push(opts.label);
      if (['diff', 'left', 'post', 'run', 'merge', 'sha'].includes(k)) { seen.push({ kind: k, label: opts.label, prompt }); return svcAns({ kind: k, label: opts.label }); }
      roles.push({ label: opts.label, prompt });
      return answerRole(opts.label);
    };
    const res = await new AF('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(agent, async (it, fn) => Promise.all(it.map((x) => fn(x))), null, (m) => logs.push(m), () => {},
      { owner: 'o', config, tasks: [task] });
    return { r: res[0], roles, seen, logs, order };
  }
  const x = await CRM.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [task] },
    launch: async (plan) => { order.push(plan.label); roles.push({ label: plan.label, prompt: plan.stdin || '' }); const a = answerRole(plan.label); return a ? { output: a } : { outcome: 'crashed', error: 'no answer' }; },
    exec: async (step) => { order.push(step.label); seen.push(step); const v = svcAns(step); return { value: v === undefined ? null : v }; },
    note: () => {}, log: (m) => logs.push(m) });
  if (x.threw) throw x.threw;
  return { r: x.results[0], roles, seen, logs, order };
}
const fulls = (x) => x.seen.filter((s) => s.kind === 'run' && /:full-/.test(s.label) && !/#retry$/.test(s.label));
const stepOf = (s) => s.label.split(':')[2];
const cmdOf = (s) => (s.argv || []).slice((s.argv || []).indexOf('--') + 1).join(' ');
const promptOf = (x, label) => (x.roles.find((r) => r.label === label) || {}).prompt || '';
const labels = (x) => x.order.filter((l) => !/^(env|post|diff|left|sha):/.test(l) && !/-copy(#retry)?$/.test(l)).join(' > ');

(async () => {
  let x;
  // ---- F1' F2' F17 F26a F26b: the main path
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(P1)], review: [DONE] } });
  ok('F1\' one full run step after the programmer, before the tester, then tester and review -> done', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > review:x#1', labels(x) + ' ' + JSON.stringify(x.r));
  const f1 = fulls(x)[0];
  ok('F1\' the step is wait-step.js start --id <stepDir>/wait-full-1 --once with guards-all.sh <gdir>, effect reuse',
    !!f1 && f1.effect === 'reuse' && f1.argv.includes('--once') && f1.argv[f1.argv.indexOf('--id') + 1] === `${SD}/wait-full-1` && /wait-step\.js$/.test(f1.argv[1] || '')
    && /\/p\/scripts\/guards-all\.sh '\/w'/.test(cmdOf(f1)), f1 && JSON.stringify(f1.argv));
  ok('F1\' the command: the chain\'s config pinned, no --select, no CODIS_GUARDS_EXEC', !!f1 && cmdOf(f1).startsWith("CODIS_AGENTS_CONFIG='/c/codis-agents.json' ")
    && !/--select/.test(cmdOf(f1)) && !/CODIS_GUARDS_EXEC/.test(cmdOf(f1)), f1 && cmdOf(f1));
  ok('F1\' the command copies the log and its meta into the steps folder and keeps the exit code of guards-all.sh', !!f1
    && cmdOf(f1).includes(`cp '${BASE_CFG.sharedDir}/guards-w.txt' '${SD}/wait-full-1.guards.txt'`)
    && cmdOf(f1).includes(`cp '${BASE_CFG.sharedDir}/guards-w.txt.meta.json' '${SD}/wait-full-1.guards.txt.meta.json'`) && /; exit \$rc$/.test(cmdOf(f1)), f1 && cmdOf(f1));
  const cc = x.seen.find((s) => s.kind === 'copy');
  ok('F2\' the copy of the log is checked against HEAD and the step\'s exit code (guards-result.js copy-check, with tallyPattern)', !!cc
    && cc.effect === 'none' && cc.argv.join(' ') === `node /p/scripts/guards-result.js copy-check ${SD}/wait-full-1.guards.txt ${P1} 0 ${BASE_CFG.guardRerun.tallyPattern}`, cc && JSON.stringify(cc.argv));
  const tp = promptOf(x, 'test:x#1');
  ok('F2\' F26b the tester prompt names the copy, its HEAD and exit, and tells it not to run the full run', tp.includes(`${SD}/wait-full-1.guards.txt`) && tp.includes(P1)
    && /do NOT run the full suite/.test(tp) && !/a full run only after your own commits/.test(tp), tp.slice(tp.indexOf('4. '), tp.indexOf('4. ') + 700));
  ok('F26b the tester\'s environment cause no longer names the programmer\'s full run', !/your or the programmer's full run/.test(tp));
  const rp = promptOf(x, 'review:x#1');
  ok('F17 the reviewer prompt names the full run log, its HEAD, and "do not repeat it"', rp.includes(`${SD}/wait-full-1.guards.txt`) && rp.includes(P1) && /do not repeat it/.test(rp), rp.slice(0, 300));
  const pp = promptOf(x, 'prog:x#1');
  ok('F26a the programmer prompt: no full run of its own, the workflow runs it on its HEAD', /no full run of your own/.test(pp) && /the workflow runs the full run/.test(pp)
    && !/the programmer runs the full run/.test(pp) && !/-> full run \/p\/scripts\/guards-all\.sh/.test(pp), pp.slice(pp.indexOf('Order:'), pp.indexOf('Order:') + 400));
  ok('F26a the rules onerun and slots of every role say the workflow runs the full run', /One full guard run per HEAD, run by the workflow/.test(pp) && /no full guard run of your own/.test(tp)
    && /One full guard run per HEAD, run by the workflow/.test(rp));
  ok('F2\' the done result names the full run of its HEAD', /exit 0 on 1{40}/.test(x.r.full || ''), JSON.stringify(x.r));

  // ---- F3, F18: red tester -> fix with a new HEAD -> step again; a round with no commit -> not repeated
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [RED(P1), GREEN(P2)], review: [DONE] } });
  ok('F18 red tester -> programmer with a new HEAD -> a full run before the second tester', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > prog:x#2 > run:x:full-2 > test:x#2 > review:x#1', labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P1)], test: [RED(P1), GREEN(P1)], review: [DONE] } });
  ok('F3 a programmer round with no commit on a HEAD whose full run is done: no step, a journal line', fulls(x).length === 1 && x.r.status === 'done'
    && x.logs.some((l) => l.includes(`the full run on ${P1} is done - not repeated`)), labels(x) + ' ' + x.logs.join(' | '));

  // ---- F4 a reused run (exit 0, "reused") counts as a green run
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(P1)], review: [DONE] }, run: { 'full-1': { done: true, rc: 0, log: `${SD}/wait-full-1.log`, tail: 'reused, HEAD 1111111' } } });
  ok('F4 a reused full run (exit 0) goes on to the tester like a green one', x.r.status === 'done' && fulls(x).length === 1, labels(x));

  // ---- F5 a fix for docs only after a rejection gets a full run before the second review
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2, { changedFiles: ['README.md'] })], test: [GREEN(P1)], review: [{ verdict: 'rejected', docsOnly: true, summary: 'readme' }, DONE] } });
  ok('F5 docs-only fix with a new HEAD -> a full run on it before the second review', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > review:x#1 > prog:x#r > run:x:full-r > review:x#2', labels(x));

  // ---- F6 light mode
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], review: [DONE] }, task: { mode: 'light' } });
  ok('F6 light: the full run after the programmer-checker, before the review', x.r.status === 'done' && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > review:x#1', labels(x));

  // ---- F7, F7b: the copy is not of HEAD, or the tree was dirty -> stopped for the coordinator, not green, no round
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, copy: { 'full-1': { ok: false, cut: false, why: 'tracked changes in the worktree during the run: the run does not show HEAD - commit first' } } });
  ok('F7 tracked changes during the run -> stopped for the coordinator with the reason, no tester, not the environment', x.r.status === 'stopped'
    && /commit first/.test(x.r.why) && !x.r.environment && labels(x) === 'pre:x > prog:x#1 > run:x:full-1', JSON.stringify(x.r) + ' ' + labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, copy: { 'full-1': { ok: false, cut: false, why: 'the log is not of HEAD - overwritten by another run' } } });
  ok('F7b a copy not of HEAD -> stopped for the coordinator, no programmer round', x.r.status === 'stopped' && /overwritten/.test(x.r.why)
    && !x.roles.some((r) => r.label !== 'prog:x#1' && /^prog:/.test(r.label)) && /full run log/.test(x.r.why), JSON.stringify(x.r));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, copy: { 'full-1': null } });
  ok('F7b a copy check without an answer (repeated once) -> stopped, never green', x.r.status === 'stopped' && /could not run/.test(x.r.why)
    && x.seen.filter((s) => s.kind === 'copy').length === 2, JSON.stringify(x.r));

  // ---- F8 the step could not run
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, run: { 'full-1': null } });
  ok('F8 a full run step without a result (repeated once with --reuse) -> stopped for the coordinator', x.r.status === 'stopped'
    && /the wait step full-1 (could not run|returned no result)/.test(x.r.why) && x.seen.filter((s) => s.kind === 'run').length === 2
    && x.seen.filter((s) => s.kind === 'run')[1].argv.includes('--reuse'), JSON.stringify(x.r));

  // ---- F9, F10, F11, F14r: red full runs
  const red = (step) => ({ done: true, rc: 1, seconds: 9, log: `${SD}/wait-${step}.log`, tail: 'FAIL a.test.js (1 s, exit 1)\n195 of 196 test files passed' });
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [GREEN(P2)], review: [DONE] }, run: { 'full-1': red('full-1') } });
  const fixP = promptOf(x, 'prog:x#1f');
  ok('F9 F14r a red full run -> a fix round with the copy of its log, then a full run on the new HEAD, then the tester', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > prog:x#1f > run:x:full-1f > test:x#1 > review:x#1'
    && fixP.includes(`${SD}/wait-full-1.guards.txt`) && /exited 1/.test(fixP) && /Do not run the full run yourself/.test(fixP), labels(x) + ' ' + fixP.slice(0, 500));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P1)], test: [GREEN(P1)], review: [DONE] }, run: { 'full-1': red('full-1') } });
  ok('F10 a red explained without a commit -> the tester gets the log of that run, a journal line', x.r.status === 'done' && fulls(x).length === 1
    && x.logs.some((l) => /the red of the full run explained without a commit/.test(l)) && /exit 1/.test(promptOf(x, 'test:x#1')) && promptOf(x, 'test:x#1').includes(`${SD}/wait-full-1.guards.txt`), x.logs.join(' | '));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2), prog(P3)] }, run: { 'full-1': red('full-1'), 'full-1f': red('full-1f'), 'full-1ff': red('full-1ff') } });
  ok('F11 still red after 2 fix rounds -> stopped for the coordinator with the log', x.r.status === 'stopped' && /full guard run is still red after 2 programmer rounds/.test(x.r.why)
    && fulls(x).length === 3 && /wait-full-1ff/.test(x.r.full || ''), JSON.stringify(x.r));

  // ---- F12' environment codes; F13' cut off
  for (const rc of [124, 77, 78, 72, 73, 69]) {
    x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, run: { 'full-1': { done: true, rc, log: `${SD}/wait-full-1.log` } } });
    ok(`F12' exit ${rc} of the full run -> environment, "full run" not "selection", no programmer round, no copy check`, x.r.status === 'stopped' && !!x.r.environment
      && /^full run after programmer 1: red from the environment/.test(x.r.why) && !/selection/.test(x.r.why) && labels(x) === 'pre:x > prog:x#1 > run:x:full-1'
      && !x.seen.some((s) => s.kind === 'copy'), JSON.stringify(x.r));
  }
  for (const rc of [137, 143]) {
    x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, run: { 'full-1': { done: true, rc, log: `${SD}/wait-full-1.log` } } });
    ok(`F13' exit ${rc} (a signal) -> environment "cut off before its tally", no programmer round`, x.r.status === 'stopped' && !!x.r.environment
      && /cut off before its tally/.test(x.r.why) && labels(x) === 'pre:x > prog:x#1 > run:x:full-1', JSON.stringify(x.r));
  }
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)] }, run: { 'full-1': red('full-1') }, copy: { 'full-1': { ok: false, cut: true, why: 'the log has no tally line' } } });
  ok('F13\' a copy without its tally (or no copy) -> environment "cut off", not a red for the programmer', x.r.status === 'stopped' && !!x.r.environment
    && /cut off before its tally/.test(x.r.why) && /no tally line/.test(x.r.why) && labels(x) === 'pre:x > prog:x#1 > run:x:full-1', JSON.stringify(x.r));

  // ---- F14' flaky guards of a green run (rerun alone by guards-all.sh) go into the journal
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(P1)], review: [DONE] }, copy: { 'full-1': { ok: true, cut: false, why: '', flaky: ['slots-priority.test.sh'] } } });
  ok('F14\' green after the rerun of a flaky guard: a journal line names it for the backlog, the chain goes on', x.r.status === 'done'
    && x.logs.some((l) => /flaky/.test(l) && /slots-priority\.test\.sh/.test(l)), x.logs.join(' | '));

  // ---- F15, F15r, F16, G17: the tester's own commits
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(T1)], review: [DONE] } });
  ok('F15 a green tester with its own commits -> a full run on its HEAD before the review; the reviewer gets that log', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > run:x:full-tester-1 > review:x#1'
    && promptOf(x, 'review:x#1').includes(`${SD}/wait-full-tester-1.guards.txt`) && promptOf(x, 'review:x#1').includes(T1), labels(x));
  ok('F15 the copy check of the tester\'s run is against the tester\'s HEAD', x.seen.some((s) => s.kind === 'copy' && s.argv.includes(T1)));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(P1)], review: [DONE] } });
  ok('F16 a green tester with no commit -> no second full run; the reviewer gets the programmer\'s log', fulls(x).length === 1
    && promptOf(x, 'review:x#1').includes(`${SD}/wait-full-1.guards.txt`), labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [GREEN(T1), GREEN(P2)], review: [DONE] }, run: { 'full-tester-1': red('full-tester-1') } });
  ok('F15r a red full run on the tester\'s HEAD -> a red tester round: a programmer round with its log and test.md, a full run, the tester again',
    x.r.status === 'done' && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > run:x:full-tester-1 > prog:x#2 > run:x:full-2 > test:x#2 > review:x#1'
    && x.r.counts.testerReds === 1 && promptOf(x, 'prog:x#2').includes(`${SD}/wait-full-tester-1.guards.txt`) && /test\.md/.test(promptOf(x, 'prog:x#2')), labels(x) + ' ' + JSON.stringify(x.r.counts));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [GREEN(T1), GREEN(P2)], review: [DONE] }, task: { prior: { testerReds: 1 } }, run: { 'full-tester-1': red('full-tester-1') }, });
  ok('F15r a red full run on the tester\'s HEAD counts as the task\'s red tester round: the second -> the analyst', x.r.counts.testerReds === 2
    && x.roles.some((r) => /^analyst:/.test(r.label)), labels(x) + ' ' + JSON.stringify(x.r));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [RED(T1), GREEN(P2)], review: [DONE] } });
  ok('G17 a red tester with its own commits -> no full run on its HEAD; the next full run is on the programmer\'s new HEAD', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > run:x:full-1 > test:x#1 > prog:x#2 > run:x:full-2 > test:x#2 > review:x#1' && x.r.counts.testerReds === 1, labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1), prog(P2)], test: [GREEN(P1), GREEN(T1)], review: [{ verdict: 'rejected', docsOnly: false, summary: 'code' }, DONE] }, run: { 'full-tester-after-review': red('full-tester-after-review') } });
  ok('F15r after a review fix: a red full run on the tester\'s HEAD stops like a red tester there, counted once', x.r.status === 'stopped'
    && /full run on the tester's HEAD/.test(x.r.why) && x.r.counts.testerReds === 1 && !x.order.includes('review:x#2'), labels(x) + ' ' + JSON.stringify(x.r));

  // ---- F19 after the status mechanism
  x = await chain({ q: { pre: [PRE], prog: [prog(P1, { status: 'mechanism' }), prog(P1)], analyst: [AN], test: [GREEN(P1)], review: [DONE] } });
  ok('F19 status mechanism -> analyst -> the programmer again -> the full run on its HEAD', x.r.status === 'done'
    && labels(x) === 'pre:x > prog:x#1 > analyst:x > prog:x#1m > run:x:full-1 > test:x#1 > review:x#1', labels(x));

  // ---- F20' F20b F20c: entries of resolve
  x = await chain({ q: { pre: [PRE], test: [GREEN(B)], review: [DONE] }, task: { resumeAt: 'tester', head: B } });
  ok('F20\' resumeAt tester -> a full run on its HEAD before the tester', x.r.status === 'done' && labels(x) === 'pre:x > run:x:full-1 > test:x#1 > review:x#1'
    && x.seen.some((s) => s.kind === 'copy' && s.argv.includes(B)), labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P2)], test: [GREEN(P2)], review: [DONE] }, task: { resumeAt: 'tester', head: B }, run: { 'full-1': red('full-1') } });
  ok('F20\' resumeAt tester, the full run red -> a programmer round with its log, then a full run again, then the tester', x.r.status === 'done'
    && labels(x) === 'pre:x > run:x:full-1 > prog:x#1f > run:x:full-1f > test:x#1 > review:x#1', labels(x));
  x = await chain({ q: { pre: [PRE], review: [DONE] }, task: { resumeAt: 'review', head: B } });
  ok('F20b resumeAt review -> a full run on its HEAD before the review; the reviewer gets its log', x.r.status === 'done'
    && labels(x) === 'pre:x > run:x:full-entry > review:x#1' && promptOf(x, 'review:x#1').includes(`${SD}/wait-full-entry.guards.txt`), labels(x));
  x = await chain({ q: { pre: [PRE] }, task: { resumeAt: 'review', head: B }, run: { 'full-entry': red('full-entry') } });
  ok('F20b resumeAt review, the full run red -> stopped for the coordinator, no programmer round, no review', x.r.status === 'stopped'
    && /at the entry of the review/.test(x.r.why) && labels(x) === 'pre:x > run:x:full-entry' && !x.r.environment, JSON.stringify(x.r));
  x = await chain({ q: { pre: [PRE] }, task: { resumeAt: 'review', head: B }, run: { 'full-entry': { done: true, rc: 78, log: `${SD}/wait-full-entry.log` } } });
  ok('F20b resumeAt review, the full run refused (78) -> stopped with environment', x.r.status === 'stopped' && !!x.r.environment && labels(x) === 'pre:x > run:x:full-entry', JSON.stringify(x.r));
  x = await chain({ q: { pre: [PRE], review: [DONE] }, task: { resumeAt: 'review', head: B, mode: 'light' } });
  ok('F20c light, resumeAt review -> a full run on its HEAD before the review', x.r.status === 'done' && labels(x) === 'pre:x > run:x:full-entry > review:x#1', labels(x));
  x = await chain({ q: { pre: [PRE] }, task: { resumeAt: 'review', head: B, mode: 'light' }, run: { 'full-entry': red('full-entry') } });
  ok('F20c light, resumeAt review, red -> stopped for the coordinator', x.r.status === 'stopped' && /at the entry of the review/.test(x.r.why), JSON.stringify(x.r));

  // ---- F24 F25': the other paths are unchanged
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(P1)], review: [DONE] }, config: { guardSubsetCommand: 'g {wt} {onlyArgs} {jobs} {limitFile}', innerSelect: false }, task: { base: 'arc' },
    run: { 'train-1': { done: true, rc: 0, log: `${SD}/wait-train-1.log` } } });
  ok('F24 with guardSubsetCommand: no full run step', x.r.status === 'done' && !fulls(x).length && !x.seen.some((s) => s.kind === 'copy'), labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(T1)], review: [DONE] }, config: { conductorFullRun: false } });
  const ppOff = promptOf(x, 'prog:x#1');
  ok('F25\' conductorFullRun false: no full run step, the programmer runs the full run itself (as before)', x.r.status === 'done' && !fulls(x).length
    && /-> full run \/p\/scripts\/guards-all\.sh \/w in the background/.test(ppOff) && /the programmer runs the full run/.test(ppOff), labels(x));
  x = await chain({ q: { pre: [PRE], prog: [prog(P1)], test: [GREEN(T1)], review: [DONE] }, workflow: true, task: { stepDir: undefined } });
  ok('F25\' the Workflow runtime (no exec): no full run step, the programmer runs the full run itself', x.r && x.r.status === 'done' && !x.seen.some((s) => /:full-/.test(s.label))
    && /the programmer runs the full run/.test(promptOf(x, 'prog:x#1')), JSON.stringify(x.r) + ' ' + labels(x));

  // ---- the copy check itself (scripts/guards-result.js copy-check) on real files
  const GR = path.join(ROOT, 'scripts', 'guards-result.js');
  const cdir = path.join(W, 'copies');
  fs.mkdirSync(cdir, { recursive: true });
  let nC = 0;
  const mk = (text, meta) => {
    const f = path.join(cdir, `c${++nC}.guards.txt`);
    if (text !== null) fs.writeFileSync(f, text);
    if (meta !== null) fs.writeFileSync(`${f}.meta.json`, JSON.stringify(meta));
    return f;
  };
  const H = 'a'.repeat(40);
  const META = { v: 1, head: H, cleanStart: true, command: 'c', headEnd: H, cleanEnd: true, rc: 0 };
  const TALLY = '^\\d+ of (\\d+) test files passed';
  const cchk = (f, head, rc, tally) => {
    const p = spawnSync(process.execPath, [GR, 'copy-check', f, head, String(rc)].concat(tally ? [tally] : []), { encoding: 'utf8' });
    let j = null;
    try { j = JSON.parse(p.stdout); } catch { /* below */ }
    return { rc: p.status, j, out: p.stdout + p.stderr };
  };
  const LOG = 'ok a\n196 of 196 test files passed\n';
  let c = cchk(mk(LOG, META), H, 0, TALLY);
  ok('copy-check: a copy of HEAD, clean, the same exit code, with its tally -> ok', c.rc === 0 && c.j && c.j.ok === true && c.j.cut === false, c.out);
  c = cchk(mk(`FAIL slots-priority.test.sh (3 s, exit 1)\n195 of 196 test files passed\nflaky, red under load, green alone: slots-priority.test.sh\n`, META), H, 0, TALLY);
  ok('copy-check: the flaky guards of the log are listed', c.j && c.j.ok === true && JSON.stringify(c.j.flaky) === '["slots-priority.test.sh"]', c.out);
  c = cchk(path.join(cdir, 'none.guards.txt'), H, 0, TALLY);
  ok('copy-check: no copy -> cut', c.j && c.j.ok === false && c.j.cut === true, c.out);
  c = cchk(mk('half a log\n', META), H, 0, TALLY);
  ok('copy-check: no tally line -> cut', c.j && c.j.ok === false && c.j.cut === true && /tally/.test(c.j.why), c.out);
  c = cchk(mk('half a log\n', META), H, 0, '');
  ok('copy-check: without a tallyPattern the tally is not asked', c.j && c.j.ok === true, c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { rc: undefined, headEnd: undefined, cleanEnd: undefined })), H, 0, TALLY);
  ok('copy-check: a record of a run that did not finish -> cut', c.j && c.j.ok === false && c.j.cut === true, c.out);
  c = cchk(mk(LOG, null), H, 0, TALLY);
  ok('copy-check: no record next to the copy -> not ok, not cut (the coordinator)', c.j && c.j.ok === false && c.j.cut === false, c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { head: 'b'.repeat(40), headEnd: 'b'.repeat(40) })), H, 0, TALLY);
  ok('copy-check: a log of another HEAD -> not ok, not cut', c.j && c.j.ok === false && c.j.cut === false && /not of HEAD/.test(c.j.why), c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { headEnd: 'b'.repeat(40) })), H, 0, TALLY);
  ok('copy-check: HEAD moved during the run -> not ok, not cut', c.j && c.j.ok === false && c.j.cut === false, c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { cleanStart: false })), H, 0, TALLY);
  ok('copy-check: tracked changes at the start -> not ok, "commit first"', c.j && c.j.ok === false && c.j.cut === false && /commit first/.test(c.j.why), c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { cleanEnd: false })), H, 0, TALLY);
  ok('copy-check: tracked changes at the end -> not ok', c.j && c.j.ok === false && c.j.cut === false, c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { env: 'sandbox:codex' })), H, 0, TALLY);
  ok('copy-check: a run of the sandbox of a role is never the workflow\'s run -> not ok', c.j && c.j.ok === false && c.j.cut === false && /sandbox:codex/.test(c.j.why), c.out);
  c = cchk(mk(LOG, Object.assign({}, META, { rc: 1 })), H, 0, TALLY);
  ok('copy-check: the record\'s exit code differs from the step\'s -> not ok', c.j && c.j.ok === false && c.j.cut === false, c.out);
  c = cchk(mk(LOG, META), 'not-a-sha', 0, TALLY);
  ok('copy-check: the HEAD argument is compared as given (no match -> not ok)', c.j && c.j.ok === false, c.out);
  c = spawnSync(process.execPath, [GR, 'copy-check'], { encoding: 'utf8' });
  ok('copy-check: missing arguments -> usage, exit 64', c.status === 64, c.stdout + c.stderr);
  done();
})().catch((e) => { console.log(`  FAIL the test threw: ${e && e.stack}`); process.exit(1); });
