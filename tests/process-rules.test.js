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
// - every chain task carries exactly one of analystFirst, analysis (a reused report, named per task), noAnalysis (a
//   written reason; for a defect skipping the diagnosis needs one); a feature gets its own analysis, the arc
//   specification goes into `spec`;
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
  [[RULES, README], 'the hooks let through a standing push declared by a committed standingPush', /committed `standingPush`/],
  [[RULES, COORD], 'still checked for secrets and personal paths, noreply author', /secrets and personal paths[^.]*noreply/],
  // Analysis marker: a reused analysis is named per task; skipping a diagnosis for a defect needs a written reason.
  [[RULES, CHAIN, README], 'every task carries exactly one of analystFirst, analysis, noAnalysis', /exactly one of `analystFirst`, `analysis`, `noAnalysis`/],
  [[RULES], 'a reused analysis is named per task', /reused analysis is named per task/],
  [[RULES], 'skipping a diagnosis for a defect needs a written reason', /[Ss]kipping a diagnosis for a defect needs a written reason/],
  // A feature gets its own analysis: the arc specification goes into `spec`, not into `analysis` (owner 2026-10-19).
  [[RULES, CHAIN, README], 'the arc specification is not the task\'s analysis: it goes into `spec`', /arc specification[^.]*(goes into|into the separate field) `spec`/],
  [[RULES], 'a feature gets its own analysis', /[Aa] feature gets its own analysis; the arc specification does not replace it/],
  [[RULES, CHAIN], '"the arc specification covers it" is not a noAnalysis reason', /"[Tt]he arc specification covers\s+it" is not/],
  // A red from the environment goes to the coordinator; the preconditions check disk and swap (owner 2026-10-19).
  [[RULES, README], 'a red from the environment is its own tester verdict that stops for the coordinator', /verdict,? `environment`[^.]*(stops the task|the task stops)/],
  [[RULES, README], 'the preconditions check free disk and swap from the config', /`preconditions`[^.]*(10 GB|minFreeDiskGB)|(disk and swap|swap headroom)[^.]*`preconditions`/],
  // A docs-only rejection: programmer -> second review of the diff, without the tester (owner 2026-10-19).
  [[RULES, README], 'a docs-only fix outside docs and guards is confirmed by the second review (fixBehaviourUnchanged)', /second review[^.]*changes no behaviour[^.]*`fixBehaviourUnchanged`/],
  [[RULES, README], 'only an unconfirmed fix gets a tester round', /only an unconfirmed fix gets a tester round/],
  // Cost per feature: parts summed by an explicit `feature`, flagged above featureIELimit (owner 2026-10-19).
  [[RULES, CHAIN, README], 'chain-cost sums the parts of a feature and flags it above featureIELimit', /`featureIELimit`[^\n]{0,200}3 x `medianTaskIE`|sums[^.]*`feature`[^.]*`featureIELimit`/],
  [[RULES], 'the feature is named explicitly, never guessed from a key prefix', /named\s+explicitly, never guessed from a common key prefix/],
  // New reds rerun alone; flaky goes to the backlog, not to the programmer; reuse on the same HEAD (owner 2026-10-20).
  [[RULES, README], 'a new red is first rerun alone (guardRerun)', /(new reds? (is first )?rerun alone|new reds rerun alone)[^\n]*`guardRerun`/i],
  [[RULES], 'a flaky guard is not sent to the programmer as a regression but goes into the project backlog', /flaky[^.]*not a regression and not sent to the programmer[^.]*project backlog/],
  [[RULES, README], 'a full run on the same HEAD with a clean tracked tree is reused, --force runs anyway', /same HEAD with a clean tracked tree[^\n]*reused, HEAD <sha>[^\n]*`--force`/],
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

ok('rules: the rerun line is marked role:rerun', /flaky[^\n]*<!-- role:rerun -->/.test(rules));
ok('RULE_LIST rerun: guards-all reruns alone, flaky to the report for the backlog', /\['rerun', [^\n]*guards-all\.sh reruns each one alone[^\n]*Flaky guards[^\n]*backlog/.test(wf));
// Docker cleanup (owner 2026-10-14, after old test stacks filled the disk): the role:docker line reaches every role.
const dockerLine = (rules.match(/[^\n]*<!-- role:docker -->/) || [''])[0];
ok('rules: role:docker - a tester removes its stack with its images and volumes', /docker compose -p <stack> down -v --rmi all/.test(dockerLine), dockerLine);
ok('rules: role:docker - the owner\'s stack images never, other images and the build cache not by roles', /owner's stack[^.]*never[^.]*/.test(dockerLine) && /other images[^.]*build cache/.test(dockerLine), dockerLine);
ok('README: failures table - test stacks left behind filled the disk', /\| [^|\n]*filled the disk[^|\n]*\| [^|\n]*down -v --rmi all[^|\n]*\|/.test(fs.readFileSync(path.join(ROOT, README), 'utf8')));
// README: environment notes.
const rd = read(README);
ok('README: wt-setup.sh with zsh, not bash', /wt-setup\.sh[^.]*zsh[^.]*not (with )?`?bash/.test(rd));
ok('README: a plugin installed mid-session needs a session restart', /installed (in the middle of a |mid-)session[^.]*restart/.test(rd));
ok('README: Workflow scriptPath only from the working directory or the scratchpad', /scriptPath[^.]*working directory[^.]*scratchpad/.test(rd));
done();
