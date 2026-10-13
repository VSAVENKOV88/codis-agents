#!/usr/bin/env node
'use strict';
// Process rules that grew out of failures, stated where the coordinator and the reader find them:
// - an arc starts with a specification agreed with the owner before its first task; one numbered PRINCIPLES.md with
//   "Replaces:"; a mockup of all states before code for what the owner judges by the screen; living specs change in the
//   same commit as the behaviour (this one reaches every role: marker role:specs and RULE_LIST 'specs');
// - a multi-task workflow run is never resumed with resumeFromRunId: each unfinished task is relaunched alone with start;
// - after merging the second of parallel branches over the same files, the guards of both tasks run, then a full run;
// - at most two chains with acceptance in Docker at once;
// - a project may grant standing permission to push process-rule changes to the plugin repository, still checked for
//   secrets and personal paths and committed as noreply; the product repository's push/merge/tag rule stays;
// - README: wt-setup.sh runs with zsh, never bash; a plugin installed mid-session needs a session restart; a Workflow
//   scriptPath must lie in the working directory or the scratchpad.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const RULES = 'rules/multi-agent.md', COORD = 'skills/coordinator/SKILL.md', README = 'README.md', CHAIN = 'skills/role-chain/SKILL.md';

const CHECKS = [
  // [files, name, regexp]
  [[RULES, COORD, README], 'arc specification before the first task', /specification (of the whole arc |agreed with the owner )?before (the|its) first task/],
  [[RULES, COORD], 'specification holds use cases, a state model, cross-cutting rules', /use cases[^.]*state model[^.]*cross-cutting rules/],
  [[RULES, COORD], 'its open questions go to the owner as one list', /open questions go to the owner as one list/],
  [[RULES, COORD, README], 'one numbered PRINCIPLES.md with "Replaces:"', /PRINCIPLES\.md[^.]*"Replaces:/],
  [[RULES, COORD, README], 'a mockup of all states before code', /mockup of all states before (code|any code)/],
  [[RULES, README], 'living specs change in the same commit as the behaviour', /[Ll]iving specs change in the same commit as the behaviour/],
  [[RULES, CHAIN, README], 'no resumeFromRunId for a multi-task run', /resumeFromRunId/],
  [[RULES, CHAIN], 'relaunch each unfinished task alone with start', /[Rr]elaunch each unfinished task alone, with `start`/],
  [[RULES, COORD, README], 'seam of parallel branches: guards of both tasks, then the full run', /guards of both tasks[^.]*then the full guard run/],
  [[RULES, COORD, README], 'at most two chains with acceptance in Docker at once', /[Aa]t most two chains with acceptance in Docker at once/],
  [[RULES, COORD], 'standing permission to push process-rule changes to the plugin repository', /standing permission to push process-rule changes to the plugin repository/],
  [[RULES, COORD], 'still checked for secrets and personal paths, noreply author', /secrets and personal paths[^.]*noreply/],
];
for (const [files, name, re] of CHECKS) for (const f of files) ok(`${f}: ${name}`, re.test(read(f)));

// The standing permission must not dissolve the product rule: the role:push line stays as it was.
const rules = fs.readFileSync(path.join(ROOT, RULES), 'utf8');
ok('rules: the push/merge/tag rule of the product repository stays (role:push)',
  /Never push, merge into a protected branch, or create or push tags[^\n]*<!-- role:push -->/.test(rules));
ok('rules: the standing permission does not cover the product repository', /does not extend to the product repository/.test(read(RULES)));

// Living specs reach every role: a marked line and a RULE_LIST entry (role-chain.test.js checks marker <-> list <-> prompts).
ok('rules: living specs line is marked role:specs', /[Ll]iving specs change in the same commit[^\n]*<!-- role:specs -->/.test(rules));
const wf = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
ok('RULE_LIST specs: same commit as the behaviour', /\['specs', [^\n]*same commit as the behaviour/.test(wf));

// README: environment notes.
const rd = read(README);
ok('README: wt-setup.sh with zsh, not bash', /wt-setup\.sh[^.]*zsh[^.]*not (with )?`?bash/.test(rd));
ok('README: a plugin installed mid-session needs a session restart', /installed (in the middle of|mid-)session[^.]*restart/.test(rd));
ok('README: Workflow scriptPath only from the working directory or the scratchpad', /scriptPath[^.]*working directory[^.]*scratchpad/.test(rd));
done();
