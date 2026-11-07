#!/usr/bin/env node
'use strict';
// P3 and P4 of the conductor (scripts/chain-run.js, p-codex-B1-a and B1-c): the whole tests/role-chain.test.js runs
// twice - with its fake agent() as the Workflow runtime does (P4: no global exec, every check green), and through the
// conductor (CODIS_CHAIN_RUNTIME=conductor: runScript with the role adapter createAgent and a launcher answering from
// the same script, and a fake exec answering each service step as the fake agent answers its Workflow form, P3'). Both
// runs must give the same checks with the same verdicts, except the checks named in DIFFERS below, each with the reason
// the conductor changes the outcome lawfully.
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const FILE = path.join(__dirname, 'role-chain.test.js');
// A check -> why the adapter answers it differently from the fake runtime.
const DIFFERS = {
  'leftovers check without a result -> stop (not a silent ok)': 'the fake post-check answers {diff, left: null}, which POST_SCHEMA refuses (left is a '
    + 'required object): exec checks every answer of a step against its schema (p-codex-B1-c, G16) and gives the step its noJson object with the schema '
    + 'error, so the task stops as "the tester changed what the role may not: the output does not pass the schema of the step" instead of "returned no result"',
  'post-check without a result -> stop (not a silent ok)': 'the same for {diff: null, left}: diff is a required object of POST_SCHEMA, exec answers the '
    + 'noJson object of the step with the schema error, and the task stops on it - still stopped before the review, with another text',
  'B1-b2a under the Workflow a field stepDir is ignored: the wait step and the selection copy stay in the task folder': 'a cell of the Workflow '
    + 'alone: with exec (the conductor runtime) the field stepDir is the steps folder of the run, so the wait step lives there and starts with --once '
    + '(p-codex-B1-b2a); the conductor itself gives stepDir and parseTasks refuses it from a tasks file (tests/chain-run-reconcile.test.js X2)',
};

const runIn = (env) => {
  const p = spawnSync(process.execPath, [FILE], { encoding: 'utf8', env: Object.assign({}, process.env, env), timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const checks = new Map();
  for (const l of (p.stdout || '').split('\n')) {
    const m = /^ {2}(ok|FAIL) {1,3}(.*?)(?: - .*)?$/.exec(l);
    if (m) checks.set(m[2], m[1]);
  }
  return { rc: p.status, checks, out: (p.stdout || '') + (p.stderr || '') };
};

const plain = runIn({ CODIS_CHAIN_RUNTIME: '' });
const cond = runIn({ CODIS_CHAIN_RUNTIME: 'conductor' });
const failsOf = (r) => [...r.checks].filter(([, v]) => v === 'FAIL').map(([k]) => k);

ok('P4 role-chain.test.js under the fake Workflow runtime: every check green', plain.rc === 0 && plain.checks.size > 200 && !failsOf(plain).length,
  `rc ${plain.rc}, ${plain.checks.size} checks, failed: ${failsOf(plain).join(' | ')}`);
ok('P3 the conductor run says it went through the role adapter', [...cond.checks.keys()].some((k) => /^conductor runtime: every agent call went through the role adapter/.test(k)
  && cond.checks.get(k) === 'ok'), cond.out.split('\n').filter((l) => /conductor runtime/.test(l)).join(' | ') || cond.out.slice(-2000));
ok('P3\' E1 the conductor run sent every service step through exec (p-codex-B1-c), none through the adapter', [...cond.checks.keys()].some((k) => /^conductor runtime E1: every service step went through exec/.test(k)
  && cond.checks.get(k) === 'ok'), cond.out.split('\n').filter((l) => /conductor runtime/.test(l)).join(' | '));
const missing = [...plain.checks.keys()].filter((k) => !cond.checks.has(k));
ok('P3 the conductor run has every check of the fake runtime', !missing.length, missing.slice(0, 10).join(' | '));
const differ = [...plain.checks.keys()].filter((k) => cond.checks.has(k) && cond.checks.get(k) !== plain.checks.get(k));
const unexplained = differ.filter((k) => !Object.prototype.hasOwnProperty.call(DIFFERS, k));
ok('P3 every check of role-chain.test.js gives the same verdict through the conductor (or is named in DIFFERS with its reason)', !unexplained.length,
  unexplained.slice(0, 10).join(' | ') + '\n' + cond.out.split('\n').filter((l) => /^ {2}FAIL/.test(l)).slice(0, 10).join('\n'));
const stale = Object.keys(DIFFERS).filter((k) => !differ.includes(k));
ok('P3 DIFFERS names only checks that do differ', !stale.length, stale.join(' | '));
done();
