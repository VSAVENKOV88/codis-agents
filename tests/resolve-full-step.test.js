#!/usr/bin/env node
'use strict';
// resolve over a step of the workflow's full guard run (p-codex-fullrun-a2, cell R-full, gap G24 of the third check):
// workflows/role-chain.js labels it run:<key>:full-<tag> (after a programmer round: the tags of a selection step),
// run:<key>:full-tester-<round> (on the HEAD of a green tester's commits), run:<key>:full-entry (the entry of the
// review) and their copy checks <label>-copy. A stop on such a step continues with the step again, not with a new
// programmer round: retry -> the entry whose way in runs the full run first (tester for full-<n>, review for
// full-tester and full-entry, review in a light run); a recorded rc gives the verdict (0 green, an exit code of the
// environment or a signal - environment, else red); a red full run on the tester's HEAD counts as a red tester round.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');
const R = require('../scripts/chain-resolve.js');

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-full-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });
const REPO = path.join(W, 'repo');
fs.mkdirSync(REPO);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', REPO].concat(a), { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('add', 'a.js');
git('commit', '-q', '-m', 'base');
const H = git('rev-parse', 'HEAD').stdout.trim();
const J = JSON.stringify;
const C = { testerReds: 0, trainReds: 0, rejections: 0 };
const step = (label, counts) => ({ label, stepKind: 'run', n: 1, gitHead: H, counts: counts || C });
const nx = (s, as, verdict, light, recorded) => R.nextOf({ step: s, as, verdict, form: { light: !!light, oneRun: false }, wt: REPO, recorded: recorded || { has: false } });

// ---- labels and the context
for (const [label, role, cx] of [
  ['run:k:full-1', 'full', 'main'], ['run:k:full-A2f', 'full', 'main'], ['run:k:full-1m', 'full', 'main'],
  ['run:k:full-tester-1', 'full-tester', 'main'], ['run:k:full-tester-T2', 'full-tester', 'main'], ['run:k:full-entry', 'full-entry', 'main'],
  ['run:k:full-r', 'full', 'after-review'], ['run:k:full-tester-after-review', 'full-tester', 'after-review'], ['run:k:full-t1-2', 'full', 'after-train'],
]) {
  const info = R.labelInfo(label);
  ok(`labelInfo ${label}: role ${role}, context ${cx}`, info.role === role && R.contextOf(info) === cx, J([info, R.contextOf(info)]));
}
const cp = R.labelInfo('run:k:full-1-copy');
ok('labelInfo run:k:full-1-copy: the copy check of full-1', cp.role === 'full' && cp.tag === '1' && cp.copy === true, J(cp));
ok('labelInfo run:k:full-tester-1-copy#retry: the copy check of full-tester-1', R.labelInfo('run:k:full-tester-1-copy#retry').role === 'full-tester' && R.labelInfo('run:k:full-tester-1-copy#retry').copy === true);

// ---- retry: the step again, never the programmer
let v = nx(step('run:k:full-1'), 'retry');
ok('retry full-1 -> tester at H (the entry of the tester runs the full run first)', v.next && v.next.resumeAt === 'tester' && v.next.head === H, J(v));
v = nx(step('run:k:full-1-copy'), 'retry');
ok('retry full-1-copy -> tester at H', v.next && v.next.resumeAt === 'tester' && v.next.head === H, J(v));
v = nx(step('run:k:full-tester-1'), 'retry');
ok('retry full-tester-1 -> review at H (the entry of the review runs the full run first)', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-entry'), 'retry');
ok('retry full-entry -> review at H', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-1'), 'retry', undefined, true);
ok('light: retry full-1 -> review at H (the light entry of the review runs the full run first)', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-entry'), 'retry', undefined, true);
ok('light: retry full-entry -> review at H', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-r'), 'retry');
ok('retry full-r (after the review): from the beginning, as a selection step there', v.next && v.next.resumeAt === null, J(v));

// ---- ran: the verdict
v = nx(step('run:k:full-1'), 'ran', 'green');
ok('ran full-1 green -> tester at H', v.next && v.next.resumeAt === 'tester' && v.next.head === H, J(v));
v = nx(step('run:k:full-1'), 'ran', 'environment');
ok('ran full-1 environment -> tester at H (the run again)', v.next && v.next.resumeAt === 'tester' && v.next.head === H, J(v));
v = nx(step('run:k:full-1'), 'ran', 'red');
ok('ran full-1 red -> a programmer round (from the beginning)', v.next && v.next.resumeAt === null, J(v));
v = nx(step('run:k:full-tester-1'), 'ran', 'green');
ok('ran full-tester-1 green -> review at H', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-tester-1'), 'ran', 'red');
ok('ran full-tester-1 red -> a red tester round (testerReds + 1), from the beginning', v.next && v.next.resumeAt === null && v.next.counts.testerReds === 1, J(v));
v = nx(step('run:k:full-tester-1', { testerReds: 1, trainReds: 0, rejections: 0 }), 'ran', 'red');
ok('ran full-tester-1 red as the second red tester round -> refused at the threshold of the analyst', !!v.error && /analyst/.test(v.error), J(v));
v = nx(step('run:k:full-entry'), 'ran', 'green');
ok('ran full-entry green -> review at H', v.next && v.next.resumeAt === 'review' && v.next.head === H, J(v));
v = nx(step('run:k:full-1'), 'ran', 'done');
ok('ran full-1 with a verdict of another step: refused', !!v.error && /green, red, environment/.test(v.error), J(v));
v = nx(step('run:k:full-1-copy'), 'ran');
ok('ran on a copy check: only retry or abort', !!v.error && /only retry or abort/.test(v.error), J(v));
v = nx(step('run:k:full-1'), 'ran', 'red', false, { has: true, verdict: 'green' });
ok('ran full-1 red against a recorded green: refused', !!v.error && /records the verdict green/.test(v.error), J(v));

// ---- the recorded verdict from the rc of the step
const rd = path.join(W, 'runs', 'R1');
fs.mkdirSync(rd, { recursive: true });
const jn = CJ.openJournal(rd, 'R1', 'k');
const rcs = [[1, 0, 'green'], [2, 1, 'red'], [3, 124, 'environment'], [4, 77, 'environment'], [5, 143, 'environment'], [6, 3, 'red']];
for (const [n, rc] of rcs) {
  jn.append({ type: 'intent', stepId: `R1:${n}`, n, kind: 'exec', stepKind: 'run', label: `run:k:full-${n}`, effect: 'reuse', gated: false, gitHead: H, counts: C, head: '' });
  jn.append({ type: 'result', stepId: `R1:${n}`, outcome: 'ok', value: { done: true, rc, log: 'l' } });
}
for (const [n, rc, want] of rcs) {
  const r = R.recordedOf(rd, 'k', n);
  ok(`recordedOf full step rc ${rc}: ${want}`, r.has && r.verdict === want, J(r));
}
done();
