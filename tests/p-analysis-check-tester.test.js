#!/usr/bin/env node
'use strict';
// p-analysis-check-a (0.4.18), tester: cells of the analysis checker that tests/p-analysis-check.test.js does not reach.
//   T2. The agent and the coordinator's snapshot agree: the coordinator voids a check when the task or feature folder
//       differs by anything but analysis-check.md (skills/coordinator, "Check the analysis" step 3; brief item 3,
//       Closure G3), so the agent must not put its experiments next to its report (the folder of the analysis is the
//       task or the feature folder) - only outside the worktree and outside those folders (the session's scratchpad).
//   T3. Rule Waves: a task without the check, or changes-needed without a Closure line per significant gap, does not go
//       into the wave; RULE_LIST of the workflow gains no entry for the checker (no role marker).
//   T4. Coordinator skill: a fable roleModel runs the checker on opus (not only the word "fable"); the only difference of
//       the folders is analysis-check.md; Saved-by under the header; Analysis-sha256 filled by the coordinator.
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
ok('T2. agent: experiments never in the folder of the analysis / next to the report (the coordinator voids a check whose task or feature folder differs by more than analysis-check.md)',
  !!exp && !/(scratch[^.]*next to (your|the) report|next to (your|the) report[^.]*scratch|folder of the analysis[^.]*experiment)/i.test(exp), exp);
const co = flat('skills/coordinator/SKILL.md');
const coStep = (raw('skills/coordinator/SKILL.md').match(/## Check the analysis\n([\s\S]*?)\n## /) || ['', ''])[1].replace(/\s+/g, ' ');
ok('T2. coordinator: the only difference of the folders is analysis-check.md', /only difference[^.]*`analysis-check\.md`/.test(coStep), coStep.slice(0, 300));

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

done();
