#!/usr/bin/env node
'use strict';
// p-analysis-check-a (0.4.18), tester: cells of the analysis checker that tests/p-analysis-check.test.js does not reach.
//   T2. The agent and the coordinator's snapshot agree: the coordinator voids a check when the task or feature folder
//       differs by anything but the report <name of the analysis>.check.md (skills/coordinator, "Check the analysis" step 3; brief item 3,
//       Closure G3), so the agent must not put its experiments next to its report (the folder of the analysis is the
//       task or the feature folder) - only outside the worktree and outside those folders (the session's scratchpad).
//   T3. Rule Waves: a task without the check, or changes-needed without a Closure line per significant gap, does not go
//       into the wave; RULE_LIST of the workflow gains no entry for the checker (no role marker).
//   T4. Coordinator skill: a fable roleModel runs the checker on opus (not only the word "fable"); the only difference of
//       the folders is the report <name of the analysis>.check.md; Saved-by under the header; Analysis-sha256 filled by the coordinator.
//   T5. Part b did not leak in: no scripts/analysis-check.js, no analysisCheck key or analysis-checker role in
//       config.js, the schema, the workflow or the role-chain skill.
//   (English of the agent: tests/hygiene.test.js, no Cyrillic in any file.)
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const raw = (f) => (exists(f) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');
const flat = (f) => raw(f).replace(/\s+/g, ' ');

// ---- T2: where the agent's experiments go vs what the coordinator snapshots ----
const agf = flat('agents/analysis-checker.md');
const exp = (agf.match(/Experiments[^]*?(?=## What you check)/) || [''])[0];
ok('T2. agent: experiments named, outside the worktree', /outside the worktree/.test(exp), exp);
ok('T2. agent: experiments never in the folder of the analysis / next to the report (the coordinator voids a check whose task or feature folder differs by more than its report)',
  !!exp && !/(scratch[^.]*next to (your|the) report|next to (your|the) report[^.]*scratch|folder of the analysis[^.]*experiment)/i.test(exp), exp);
// Round 2 (after f3a83a4): the positive claim - the scratchpad is the only place, and the task and feature folders are
// named as outside (the negative check above does not see "the scratchpad or the task folder").
ok('T2. agent: experiments in the session\'s scratchpad only',
  /session's scratchpad only/.test(exp) && !/scratchpad (only )?or /.test(exp), exp);
ok('T2. agent: experiments outside the task and feature folders',
  /outside the task and feature folders/.test(exp), exp);
const co = flat('skills/coordinator/SKILL.md');
const coStep = (raw('skills/coordinator/SKILL.md').match(/## Check the analysis\n([\s\S]*?)\n## /) || ['', ''])[1].replace(/\s+/g, ' ');
ok('T2. coordinator: the only difference of the folders is the report <name of the analysis>.check.md', /only difference[^.]*`<name of the analysis>\.check\.md`/.test(coStep), coStep.slice(0, 300));

// ---- T3: rule Waves ----
const RULES = raw('rules/multi-agent.md');
const waves = (RULES.match(/\n## Waves[^\n]*\n([\s\S]*?)\n## /) || ['', ''])[1];
const step = (waves.split(/\n- /).find((b) => /analysis-checker/.test(b)) || '').replace(/\s+/g, ' ');
ok('T3. Waves: a task without the check does not go into the wave', /check is missing[^.]*does not go into the wave/.test(step), step);
ok('T3. Waves: changes-needed without a Closure line for every significant gap does not go into the wave',
  /`changes-needed` without a Closure line for every significant gap[^.]*does not go into the wave/.test(step), step);
const wf = raw('workflows/role-chain.js');
const rl = (wf.match(/const RULE_LIST = [\s\S]*?\n\]\n/) || [''])[0];
ok('T3. workflow RULE_LIST: no entry for the analysis checker', !!rl && !/analysis-check/i.test(rl), rl.slice(0, 120));

// ---- T4: coordinator skill ----
ok('T4. coordinator: a fable roleModel runs the checker on opus', /`fable`[^.]*runs the checker on `opus`/.test(coStep), coStep.slice(0, 300));
ok('T4. coordinator: fallback saves with Saved-by: coordinator under the header', /`Saved-by: coordinator` under the header/.test(coStep), '');
ok('T4. coordinator: fills Analysis-sha256 with shasum -a 256 when the agent could not', /`Analysis-sha256` \(`shasum -a 256 <analysis>`\) when the agent could not/.test(coStep), '');
ok('T4. coordinator: the task goes into the wave only when every significant gap has its Closure line', /only when every significant gap has its line/.test(coStep), '');
ok('T4. coordinator: step 3 of the list links the check', /"Check the analysis"/.test(co), '');

// ---- T5: part b is not in this task ----
ok('T5. no scripts/analysis-check.js (part b)', !exists('scripts/analysis-check.js'));
for (const f of ['scripts/config.js', 'workflows/role-chain.js', 'skills/role-chain/SKILL.md', 'schemas/codis-agents.schema.json']) {
  ok(`T5. ${f}: no analysisCheck key and no analysis-checker role (part b)`, !/analysisCheck|analysis-checker/.test(raw(f)), f);
}

// ---- Round 3 (after de7eb0b, review R2): one report per analysis, a repeated check appends a run ----
//   T6. The prefix check of step 3 is run as written, with its placeholders filled, on files of a temporary folder:
//       an appended run must pass (exit 0), a changed or truncated earlier run must fail. On macOS /usr/bin/cmp -n
//       answers 1 ("EOF on <shorter>") whenever the files differ in size, so `cmp -n <size> <copy> <report>` voids
//       every legitimate repeated check on the coordinator's Mac.
//   T7. Step 1 keeps the copy of the earlier report outside the snapshotted folders (a copy inside them is itself a
//       difference) with its size; Closure is written into the run being closed (the last one), in the skill and Waves.
const os = require('os');
const { spawnSync } = require('child_process');
const s3 = (coStep.match(/\*\*Snapshot after\.\*\*([^]*?)(?=\d\. \*\*Fallback)/) || ['', ''])[1];
const snip = (s3.match(/`([^`]*<[^>]*report[^>]*>[^`]*)`/i) || ['', ''])[1];
ok('T6. coordinator step 3 names a command for the prefix check of the earlier report', !!snip, s3.slice(0, 400));
if (snip) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-prefix-'));
  const before = '# Analysis check\nTasks: a\n\n## Closure\nG1: closed in the brief (layer 2)\n\nNext step: start\n';
  const run2 = '# Analysis check\nTasks: b\n\n## Closure\n<left empty by the checker>\n\nNext step: ...\n';
  const copy = path.join(tmp, 'copy-before.md');
  fs.writeFileSync(copy, before);
  const runCase = (after) => {
    const rep = path.join(tmp, 'analyst.check.md');
    fs.writeFileSync(rep, after);
    let unknown = null;
    const cmd = snip.replace(/<([^>]+)>/g, (m, name) => {
      if (/size/i.test(name)) return String(Buffer.byteLength(before));
      if (/report/i.test(name)) return JSON.stringify(rep);
      if (/copy|before/i.test(name)) return JSON.stringify(copy);
      unknown = m; return m;
    });
    if (unknown) return { status: -1, out: 'unknown placeholder ' + unknown + ' in ' + snip };
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: cmd + ' -> ' + r.status + ' ' + (r.stderr || '').trim() };
  };
  const a = runCase(before + run2);
  ok('T6. prefix check as written: an appended run passes (exit 0)', a.status === 0, a.out);
  const b = runCase(before.replace('closed in the brief', 'open') + run2);
  ok('T6. prefix check as written: a changed earlier run fails', b.status !== 0 && b.status !== -1, b.out);
  const c = runCase('# Analysis check\n');
  ok('T6. prefix check as written: a truncated report fails', c.status !== 0 && c.status !== -1, c.out);
  const d = runCase(before);
  ok('T6. prefix check as written: an unchanged report passes the prefix part (exit 0)', d.status === 0, d.out);
  fs.rmSync(tmp, { recursive: true, force: true });
}
const s1 = (coStep.match(/\*\*Snapshot before\.\*\*([^]*?)(?=\d\. \*\*Run)/) || ['', ''])[1];
ok('T7. coordinator step 1: a copy of the existing report and its size, outside the snapshotted folders',
  /exists, a copy of it and its size, outside those folders/.test(s1), s1);
ok('T7. coordinator step 5: Closure of this run, the last one of the report', /Closure of this run \(the last one of the report\)/.test(coStep), '');
ok('T7. Waves: the Closure line goes into the section Closure of that run', /section Closure of that run/.test(step), step);

// ---- Round 4 (after 3e18864, analyst cells M1-M12): steps 1 and 3 composed as the coordinator runs them ----
//   T8. The size command of step 1 is taken from the skill as written and its raw output (BSD wc pads it with spaces)
//       goes into step 3 through $(...), quoted and unquoted; the size must be in bytes, so a multibyte earlier run
//       that was appended passes and one changed in place fails. An empty earlier report is a prefix of anything.
const szCmd = (s1.match(/`([^`]*<copy before>[^`]*)`/) || ['', ''])[1];
ok('T8. coordinator step 1 names the size command of the copy', !!szCmd, s1);
if (snip && szCmd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-prefix-t8-'));
  const copy = path.join(tmp, 'copy-before.md');
  const rep = path.join(tmp, 'analyst.check.md');
  const runRaw = (before, after, quoted) => {
    fs.writeFileSync(copy, before);
    fs.writeFileSync(rep, after);
    const size = szCmd.replace(/<copy before>/g, JSON.stringify(copy));
    const sub = quoted ? '"$(' + size + ')"' : '$(' + size + ')';
    const cmd = snip.replace(/<size before>/g, sub).replace(/<report>/g, JSON.stringify(rep)).replace(/<copy before>/g, JSON.stringify(copy));
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: cmd + ' -> ' + r.status + ' ' + (r.stderr || '').trim() };
  };
  const mb = '# Analysis check\nTasks: a\n\n## Closure\nG1: \u0437\u0430\u043a\u0440\u044b\u0442\u043e \u0432 \u0431\u0440\u0438\u0444\u0435\n';
  const more = '# Analysis check\nTasks: b\n\n## Closure\n';
  for (const q of [false, true]) {
    const tag = q ? 'quoted' : 'unquoted';
    const a = runRaw(mb, mb + more, q);
    ok(`T8. raw size of step 1 (${tag}): a multibyte earlier run, appended, passes`, a.status === 0, a.out);
    const b = runRaw(mb, mb.replace('\u0431\u0440\u0438\u0444\u0435', '\u0430\u043d\u0430\u043b\u0438\u0437\u0435') + more, q);
    ok(`T8. raw size of step 1 (${tag}): a multibyte earlier run changed in place fails`, b.status !== 0, b.out);
  }
  const e = runRaw('', more, true);
  ok('T8. an empty earlier report is a prefix of the report after (exit 0)', e.status === 0, e.out);
  fs.rmSync(tmp, { recursive: true, force: true });
}

done();
