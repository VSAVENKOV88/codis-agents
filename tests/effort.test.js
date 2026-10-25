#!/usr/bin/env node
'use strict';
// The reviewer and the security reviewer run at the effort of the session: neither their agent definitions
// (agents/*.md frontmatter) nor the workflow's agent options set "effort". The reviewer is the one role that looks for
// what is false; a lowered effort there turns into empty verdicts (rules/multi-agent.md, "Reviewer").
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const ROLES = ['reviewer', 'security-reviewer'];
for (const r of ROLES) {
  const md = fs.readFileSync(path.join(ROOT, 'agents', r + '.md'), 'utf8');
  const fm = (md.match(/^---\n([\s\S]*?)\n---/) || [])[1];
  ok(`agents/${r}.md has a frontmatter`, fm !== undefined);
  ok(`agents/${r}.md frontmatter sets no effort`, fm !== undefined && !/^\s*effort\s*:/m.test(fm), fm);
}

// The workflow: run it with a fake agent() through one review round (plain and security) and record the options.
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', protectedBranches: ['main'], testerWritable: ['-run\\.js$'] };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', security: true, noAnalysis: 'n' };
const ANSWER = {
  pre: { ok: true, problems: [], blockingQuestions: [] },
  prog: { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' },
  test: { verdict: 'green', head: 'T', summary: '' },
  review: { verdict: 'done', docsOnly: false, summary: '' },
  sec: { verdict: 'done', docsOnly: false, summary: '' },
  diff: { ok: true, offending: [] },
  left: { ok: true, found: [], removed: [], remaining: [] },
  post: { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } },
};
(async () => {
  const calls = [];
  const agent = async (prompt, opts) => { const role = opts.label.split(':')[0]; calls.push({ role, opts }); return ANSWER[role]; };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  await new AsyncFunction('args', 'agent', 'pipeline', 'log', 'phase', SRC)({ owner: 'o', config: CFG, tasks: [T] }, agent, pipeline, () => {}, () => {});
  for (const role of ['review', 'sec']) {
    const mine = calls.filter((c) => c.role === role);
    ok(`workflow calls the ${role} agent`, mine.length > 0, calls.map((c) => c.role).join(','));
    ok(`workflow sets no effort for ${role}`, mine.length > 0 && mine.every((c) => !('effort' in c.opts)), JSON.stringify(mine.map((c) => c.opts)));
  }
  // The source as well: no effort next to the reviewer agent types (a branch the run above did not take).
  const defs = SRC.split(/\nconst /).filter((d) => /^(review|secReview) = /.test(d));
  ok('workflow source: review and secReview defined', defs.length === 2);
  ok('workflow source: no effort in review or secReview', defs.every((d) => !/\beffort\b/.test(d)), defs.join('\n---\n'));
  done();
})().catch((e) => { console.log('  FAIL ' + e.stack); process.exit(1); });
