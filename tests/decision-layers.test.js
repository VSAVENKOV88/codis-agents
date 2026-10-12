#!/usr/bin/env node
'use strict';
// The coordinator's three decision layers are stated the same way in the rules, the coordinator skill and the README:
// (1) follows from an accepted principle -> decided, "decided by principle N"; (2) reversible and local -> decided,
// marked as a candidate the owner can overturn; (3) what the owner judges by the screen, anything new or irreversible,
// two principles in conflict -> to the owner as one list with a recommendation each. The old rule "ask the owner
// instead of deciding" must not survive anywhere next to it. Roles still never answer owner questions themselves.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const DOCS = ['rules/multi-agent.md', 'skills/coordinator/SKILL.md', 'README.md'];
const MUST = [
  ['layer 1 marker', /decided by principle N/],
  ['layer 2: reversible and local', /reversible and local/],
  ['layer 2: what is never local', /not a storage format, an address, sharing, data deletion or security/],
  ['layer 2 marker', /coordinator's decision, not from the model - candidate/],
  ['layer 2: the owner can overturn it', /owner can overturn it/],
  ['layer 3: judged by the screen', /judges? by (looking at )?the screen/],
  ['layer 3: two principles in conflict', /two principles in conflict/],
  ['layer 3: one list, a recommendation each', /one list/],
  ['roles do not answer owner questions', /(never answers? (an )?owner questions?|does not answer it itself|never answers it itself)/],
];
const MUST_NOT = [/instead of deciding/, /Never answer a question for the owner/];
for (const f of DOCS) {
  const s = read(f);
  for (const [name, re] of MUST) ok(`${f}: ${name}`, re.test(s));
  for (const re of MUST_NOT) ok(`${f}: no "${re.source}"`, !re.test(s));
}
// The role rule itself stays: a role writes the question for the coordinator and does not decide it.
const wf = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
ok('RULE_LIST decisions: roles do not decide', /\['decisions', [^\n]*do not decide it yourself/.test(wf));
done();
