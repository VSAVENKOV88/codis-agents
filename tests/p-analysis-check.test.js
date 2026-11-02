#!/usr/bin/env node
'use strict';
// p-analysis-check-a (0.4.18): the analysis checker - a read-only agent the coordinator runs on an analysis before a
// wave starts; it writes only its own report <name of the analysis>.check.md next to the analysis (or returns the full
// text when the environment refuses the write, and the coordinator saves it with "Saved-by: coordinator").
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
//   B3. the check runs after the worktree exists (it reads its code and snapshots its HEAD and status): the Worktree
//       step comes before the step that sends a task to "Check the analysis"; a leftover process is looked for by the
//       worktree path and by the scratchpad of the checker's session (its experiments run there).
//   C1. One report per analysis, named after it (review R2, the coordinator's answer 2026-11-02): analyst.md ->
//       analyst.check.md, diagnosis.md -> diagnosis.check.md, so two analyses in one folder get two reports and no
//       fixed name analysis-check.md is overwritten. A repeated check (another part of a feature whose analysis serves
//       several parts, "run again") appends a new run with its own header and its own Closure; the earlier runs stay
//       as they are, and the coordinator's snapshot allows only that file to differ, its earlier content unchanged.
//       Agent, rule Waves, coordinator skill and README name the new report; the reports of wave 2 named
//       analysis-check.md are history (named only as such, in the skill).
//   The version 0.4.18 is pinned once, in p-testerred-route.test.js; this test does not pin it.
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
ok('A1. writes only its own report <name of the analysis>.check.md next to the analysis', /only[^.]*`<name of the analysis>\.check\.md`[^.]*next to the analysis/.test(agf), '');
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
ok('B1. the step names the report <name of the analysis>.check.md and its verdicts', /`<name of the analysis>\.check\.md`/.test(stepf) && /changes-needed/.test(stepf), stepf);
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
const coRaw = raw('skills/coordinator/SKILL.md');
const stepOf = (re) => { const m = coRaw.match(re); return m ? m.index : -1; };
const wtStep = stepOf(/^\d+\. \*\*Worktree\.\*\*/m);
const checkRef = stepOf(/^\d+\. \*\*[^*]+\*\*[^\n]*(?:\n {3}[^\n]*)*?"Check the analysis"/m);
ok('B3. coordinator: the analysis is checked after the Worktree step (the checker reads its code and snapshots it)',
  wtStep >= 0 && checkRef >= wtStep, `worktree step at ${wtStep}, reference at ${checkRef}`);
ok('B3. coordinator: a leftover process is looked for by the worktree path and by the scratchpad', /`ps`[^.]*worktree[^.]*scratchpad/.test(co), '');

// ---- B4: README ----
const rd = raw('README.md'), rdf = flat('README.md');
const inside = (rd.match(/^\| `agents\/\*\.md` \|.*$/m) || [''])[0];
ok('B4. README What is inside: agents row names analysis-checker', /`analysis-checker`/.test(inside), inside);
ok('B4. README What is inside: the analysis checker is checked by the coordinator, not by the git post-check of the chain',
  /analysis-checker[^|]*coordinator/.test(inside), inside);
ok('B4. README: the step "the analysis is checked before the start"', /analysis is checked before the start/.test(rdf), '');

// ---- C1: one report per analysis, named after it; a repeated check appends a run ----
const OLD = /analysis-check\.md/;
ok('C1. agent: the report is named after the analysis (analyst.md -> analyst.check.md, diagnosis.md -> diagnosis.check.md)',
  /`analyst\.check\.md`/.test(agf) && /`diagnosis\.check\.md`/.test(agf), '');
ok('C1. agent: no fixed report name analysis-check.md', !OLD.test(ag), (agf.match(/.{80}analysis-check\.md.{40}/) || [''])[0]);
ok('C1. agent: a repeated check of the same analysis appends a new run with its own header and Closure',
  /repeated check[^.]*appends a new run[^.]*own header[^.]*own (section )?Closure/.test(agf), '');
ok('C1. agent: the earlier runs of the report are never changed', /earlier runs[^.]*(never changed|unchanged|stay as they are)/.test(agf), '');
ok('C1. agent: a run starts with its own "# Analysis check" heading', /every run starts with `# Analysis check`/i.test(agf), '');
ok('C1. agent: the fallback returns the text of this run only, appended by the coordinator', /text of this run[^.]*append/.test(agf), '');
ok('C1. Waves: a repeated check appends a run, the earlier runs stay', /repeated check[^.]*appends[^.]*earlier runs/.test(stepf), stepf);
ok('C1. Waves: no fixed name analysis-check.md', !OLD.test(step), stepf);
ok('C1. Roles: the checker writes <name of the analysis>.check.md, not analysis-check.md',
  /`<name of the analysis>\.check\.md`/.test((RULES.match(/\*\*Analysis checker\.\*\*[\s\S]*?\n(?=- \*\*|\n)/) || [''])[0]) && !OLD.test((RULES.match(/\*\*Analysis checker\.\*\*[\s\S]*?\n(?=- \*\*|\n)/) || [''])[0]), '');
const coStep = (coRaw.match(/## Check the analysis\n([\s\S]*?)\n## /) || ['', ''])[1].replace(/\s+/g, ' ');
ok('C1. coordinator: the report path is <folder of the analysis>/<name of the analysis>.check.md',
  /`<folder of the analysis>\/<name of the analysis>\.check\.md`/.test(coStep), coStep.slice(0, 400));
ok('C1. coordinator: the only difference of the folders is that report, its earlier content unchanged (an exact prefix)',
  /only difference[^.]*`<name of the analysis>\.check\.md`[^.]*earlier content[^.]*prefix/.test(coStep), coStep.slice(0, 600));
// Round 5 (after the analyst of the second red tester round, cells M1-M12): BSD cmp -n answers 1 for files of
// different length, so the prefix is cut with head -c and compared from a pipe; the size before is counted in bytes
// with wc -c (stat differs between BSD and GNU).
ok('C1. coordinator: the earlier content is compared as head -c <size before> <report> | cmp -s - <copy before>',
  /`head -c <size before> <report> \| cmp -s - <copy before>`/.test(coStep) && !/`cmp -n </.test(coStep), coStep.slice(0, 900));
ok('C1. coordinator step 1: the size before is counted in bytes with wc -c, not stat',
  /`wc -c < <copy before>`/.test((coStep.match(/\*\*Snapshot before\.\*\*([^]*?)(?=\d\. \*\*Run)/) || ['', ''])[1]) && !/`stat -/.test(coStep), '');
ok('C1. coordinator: the fallback appends the returned run', /\*\*Fallback\.\*\*[^]*?append it to `<name of the analysis>\.check\.md`[^]*?Saved-by: coordinator/.test(coStep), '');
ok('C1. coordinator: analysis-check.md is named only as the history of wave 2',
  coStep.split(/(?<=\.) /).filter((x) => OLD.test(x)).every((x) => /wave 2/.test(x) && /history/.test(x)), coStep.split(/(?<=\.) /).filter((x) => OLD.test(x)).join(' / '));
ok('C1. README: the report is <name of the analysis>.check.md, no fixed analysis-check.md', /`<name of the analysis>\.check\.md`/.test(rdf) && !OLD.test(rd), (rdf.match(/.{80}analysis-check\.md.{40}/) || [''])[0]);
ok('C1. README: a repeated check appends a run', /repeated check[^.]*appends/.test(rdf), '');

// ---- D1 (round 5): the check of a task is a run whose Tasks line names its key ----
// A shared analysis of a feature: the run for part a does not count for part b (cells of the analyst, question of
// test.md round 3, coordinator's answer 2026-11-02).
ok('D1. Waves: the check of a task is a run whose Tasks line names the key of that task',
  /check of a task is a run whose `Tasks` line names (its|the) key/.test(stepf), stepf);
ok('D1. Waves: a run for another part of the feature does not count for this task',
  /run for another part[^.]*does not count/.test(stepf), stepf);
ok('D1. agent: the Tasks line lists the keys of the tasks checked in this run', /`Tasks` names the task keys the verdict holds for/.test(agf), '');

// ---- D2 (round 5): the prefix check of step 3, run as written, on the cells the tester's T6 does not reach ----
{
  const os2 = require('os');
  const { spawnSync: sp } = require('child_process');
  const s3b = (coStep.match(/\*\*Snapshot after\.\*\*([^]*?)(?=\d\. \*\*Fallback)/) || ['', ''])[1];
  const cmdT = (s3b.match(/`([^`]*<report>[^`]*)`/) || ['', ''])[1];
  ok('D2. step 3 names the prefix command', !!cmdT, s3b.slice(0, 300));
  if (cmdT) {
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'codis-prefix-d2-'));
    const copy = path.join(tmp, 'copy-before.md');
    const rep = path.join(tmp, 'analyst.check.md');
    const sizeBy = (f) => sp('/bin/sh', ['-c', 'wc -c < ' + JSON.stringify(f)], { encoding: 'utf8' }).stdout.trim();
    const run = (before, after) => {
      fs.writeFileSync(copy, before);
      if (after === null) { try { fs.unlinkSync(rep); } catch (e) { /* absent */ } } else fs.writeFileSync(rep, after);
      const cmd = cmdT.replace('<size before>', sizeBy(copy)).replace('<report>', JSON.stringify(rep)).replace('<copy before>', JSON.stringify(copy));
      const r = sp('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
      return { status: r.status, out: cmd + ' -> ' + r.status };
    };
    const mb = '# Analysis check\nTasks: a\n\n## Closure\nG1: \u0437\u0430\u043a\u0440\u044b\u0442\u043e \u2014 \u00e9\n';
    const r1 = run(mb, mb + '# Analysis check\nTasks: b\n');
    ok('D2. M7: multibyte earlier run, size by wc -c, an appended run passes', r1.status === 0, r1.out);
    const r2 = run(mb, mb.replace('\u00e9', 'e\u0301'));
    ok('D2. M7: multibyte earlier run changed in place fails', r2.status !== 0, r2.out);
    const r3 = run(mb, null);
    ok('D2. M6: the report deleted by the agent fails', r3.status !== 0, r3.out);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

done();
