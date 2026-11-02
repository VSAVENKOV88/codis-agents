#!/usr/bin/env node
'use strict';
// p-analysis-check-a (0.4.18): the analysis checker - a read-only agent the coordinator runs on an analysis before a
// wave starts; it writes only its own report analysis-check.md next to the analysis (or returns the full text when the
// environment refuses the write, and the coordinator saves it with "Saved-by: coordinator").
//   A1. agents/analysis-checker.md: frontmatter like the reviewer's (name, description "not for direct use",
//       disallowedTools: NotebookEdit; no effort, model or tools); what it checks (premises against code with file:line,
//       missing sources and consumers, guards red without the fix, acceptance on the owner's real data, the basis of the
//       coordinator's decisions); the report format (header lines, sections, Closure written by the coordinator); the
//       fallback; experiments without background processes; "❓ coordinator:" questions are not answered by the agent.
//   B1. rules/multi-agent.md, section Waves: the preparation step "the analysis is checked before the start" - product
//       and plugin tasks, none for noAnalysis, findings closed in the brief (Closure) or sent into the preparation
//       questions; the line carries no role:* marker (the coordinator runs the checker, not the workflow).
//   B3. skills/coordinator: the step - codis-agents:analysis-checker, model roleModel and never above opus, a snapshot
//       before and after (git HEAD and status of the worktree, shasum of the task and feature folders,
//       role-diff-check.js --role reviewer), the fallback "Saved-by: coordinator", Closure.
//   B4. README: the agent in "What is inside" (its post-check is the coordinator's, not the chain's) and the step.
//   B5. version 0.4.18 (pinned once, in p-testerred-route.test.js).
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const raw = (f) => (exists(f) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');
const flat = (f) => raw(f).replace(/\s+/g, ' ');

// ---- A1: the agent ----
const AG = 'agents/analysis-checker.md';
const ag = raw(AG), agf = flat(AG);
ok('A1. agents/analysis-checker.md exists', exists(AG));
const fm = (ag.match(/^---\n([\s\S]*?)\n---/) || [])[1];
ok('A1. frontmatter: name analysis-checker', fm !== undefined && /^name: analysis-checker$/m.test(fm), fm);
ok('A1. frontmatter: description, not for direct use', fm !== undefined && /^description: .*not for direct use/m.test(fm), fm);
ok('A1. frontmatter: disallowedTools NotebookEdit, like the reviewer', fm !== undefined && /^disallowedTools: NotebookEdit$/m.test(fm), fm);
ok('A1. frontmatter: no effort, model or tools', fm !== undefined && !/^\s*(effort|model|tools)\s*:/m.test(fm), fm);
ok('A1. writes only its own report analysis-check.md next to the analysis', /only[^.]*`analysis-check\.md`[^.]*next to the analysis/.test(agf), '');
ok('A1. checks premises against the code with file:line', /premise[^.]*file:line/i.test(agf), '');
ok('A1. checks missing sources and consumers', /sources and consumers/.test(agf), '');
ok('A1. checks whether guards go red without the fix', /red without the fix/.test(agf), '');
ok('A1. checks the acceptance on the owner\'s real data', /acceptance[^.]*owner's real data/i.test(agf), '');
ok('A1. checks the basis of the coordinator\'s decisions', /coordinator's decisions/.test(agf), '');
ok('A1. experiments on copies outside the worktree, no background processes left', /outside the worktree/.test(agf) && /background process/.test(agf), '');
ok('A1. questions go into the report as "❓ coordinator:", never answered by the agent', /❓ coordinator:/.test(agf), '');
const HEADER = ['# Analysis check', 'Analysis: ', 'Analysis-sha256: ', 'Tasks: ', 'Verdict: ready | changes-needed', 'Significant gaps: '];
ok('A1. report format: the header lines', HEADER.every((h) => ag.includes('\n' + h)), HEADER.filter((h) => !ag.includes('\n' + h)).join(' | '));
ok('A1. Analysis-sha256 is shasum -a 256 of the analysis', /Analysis-sha256[^.]*shasum -a 256/.test(agf), '');
const SECTIONS = ['## Premises', '## Missing sources and consumers', '## Guards: red without the fix?', '## Acceptance on the owner\'s real data', '## Coordinator\'s decisions', '## Gaps', '## Closure'];
ok('A1. report format: the sections in order', (() => { let at = -1; return SECTIONS.every((s) => { const i = ag.indexOf('\n' + s + '\n', at + 1); if (i < 0) return false; at = i; return true; }); })(), SECTIONS.filter((s) => !ag.includes('\n' + s + '\n')).join(' | '));
ok('A1. gaps are numbered G-n with significant yes/no', /\| G1 \|/.test(ag) && /significant/.test(agf), '');
ok('A1. Closure is written by the coordinator; Closure-sha256 optional', /Closure[^.]*written by the coordinator/.test(agf) && /Closure-sha256[^.]*optional/.test(agf), '');
ok('A1. fallback: a refused write -> the full text returned, saved by the coordinator with "Saved-by: coordinator"', /refuse[^.]*return[^.]*full text/.test(agf) && /Saved-by: coordinator/.test(agf), '');

// ---- B1: the rule ----
const RULES = raw('rules/multi-agent.md');
const waves = (RULES.match(/\n## Waves[^\n]*\n([\s\S]*?)\n## /) || ['', ''])[1];
const step = waves.split(/\n- /).find((b) => /analysis-checker/.test(b)) || '';
const stepf = step.replace(/\s+/g, ' ');
ok('B1. Waves: a preparation step with the analysis checker', !!step, waves.slice(0, 200));
ok('B1. the analysis is checked before the start', /[Tt]he analysis is checked before the start/.test(stepf), stepf);
ok('B1. product and plugin tasks alike', /product/.test(stepf) && /plugin/.test(stepf), stepf);
ok('B1. noAnalysis: no check', /`noAnalysis`[^.]*no check/.test(stepf), stepf);
ok('B1. findings closed in the brief (Closure) or sent into the preparation questions', /Closure/.test(stepf) && /questions of the preparation/.test(stepf), stepf);
ok('B1. the step names analysis-check.md and its verdicts', /analysis-check\.md/.test(stepf) && /changes-needed/.test(stepf), stepf);
ok('B1. the step carries no role:* marker (the coordinator runs it, not the workflow)', !!step && !/<!-- role:/.test(step), step);
ok('B1. Roles: the analysis checker is named among the roles', /\*\*Analysis checker\.\*\*/.test(RULES), '');

// ---- B3: the coordinator skill ----
const co = flat('skills/coordinator/SKILL.md');
ok('B3. coordinator: runs codis-agents:analysis-checker', /codis-agents:analysis-checker/.test(co), '');
ok('B3. coordinator: model roleModel, never above opus (not fable)', /roleModel[^.]*never above `?opus`?/.test(co) && /fable/i.test(co), '');
ok('B3. coordinator: snapshot before and after - HEAD and status of the worktree, shasum of the task and feature folders',
  /HEAD/.test(co) && /git status/.test(co) && /shasum[^.]*task[^.]*feature/.test(co), '');
ok('B3. coordinator: role-diff-check.js --role reviewer after the checker', /role-diff-check\.js[^.]*--role reviewer/.test(co), '');
ok('B3. coordinator: fallback "Saved-by: coordinator"', /Saved-by: coordinator/.test(co), '');
ok('B3. coordinator: writes Closure', /Closure/.test(co), '');

// ---- B4: README ----
const rd = raw('README.md'), rdf = flat('README.md');
const inside = (rd.match(/^\| `agents\/\*\.md` \|.*$/m) || [''])[0];
ok('B4. README What is inside: agents row names analysis-checker', /`analysis-checker`/.test(inside), inside);
ok('B4. README What is inside: the analysis checker is checked by the coordinator, not by the git post-check of the chain',
  /analysis-checker[^|]*coordinator/.test(inside), inside);
ok('B4. README: the step "the analysis is checked before the start"', /analysis is checked before the start/.test(rdf), '');

// ---- B5: version ----
const pinned = raw('tests/p-testerred-route.test.js');
ok('B5. version 0.4.18 in package.json and plugin.json', /"version": "0\.4\.18"/.test(raw('package.json')) && /"version": "0\.4\.18"/.test(raw('.claude-plugin/plugin.json')), '');
ok('B5. one pin of the version, moved to 0.4.18', /"version": "0\\\.4\\\.18"/.test(pinned) && !/"version": "0\\\.4\\\.17"/.test(pinned), '');
done();
