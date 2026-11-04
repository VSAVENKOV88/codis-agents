#!/usr/bin/env node
'use strict';
// p-verdict-orphan-a, cell 29 (T17): the rule of the train, the coordinator skill (step 6, Route) and the README row of
// scripts/train.js name the verdict without an addressee, `train.js watch` (the coordinator's background wait, with its
// limit: the session is not ended while `train.js status` shows a live lock of watch), `train.js ack`, and the move to the
// new version together with the runner's plugin; none of them names a task field `ride` (that is part b).
// usage: node tests/p-verdict-orphan-docs.test.js
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const rules = read('rules/multi-agent.md');
const train = rules.split('\n').find((l) => /^- \*\*The train is the seam check/.test(l)) || '';
const coord = read('skills/coordinator/SKILL.md');
const route = (coord.split('\n').join(' ').match(/6\. \*\*Route\.\*\*.*?(?=7\. \*\*Questions)/) || [''])[0];
const readme = read('README.md');
const row = readme.split('\n').find((l) => l.startsWith('| `scripts/train.js` |')) || '';
const chainSkill = read('skills/role-chain/SKILL.md').replace(/\s+/g, ' ');

for (const [name, text] of [['rules/multi-agent.md, the train rule', train], ['skills/coordinator/SKILL.md, 6. Route', route], ['README.md, the row of scripts/train.js', row]]) {
  ok(`T17 ${name}: names the verdict without an addressee`, /without an addressee/.test(text), text.slice(0, 300));
  ok(`T17 ${name}: names train.js watch and train.js ack`, /train\.js watch/.test(text) && /train\.js ack/.test(text), '');
  ok(`T17 ${name}: no task field ride (part b)`, !/`ride: ?\{/.test(text) && !/field `ride`/.test(text), '');
}
ok('T17 the train rule and the coordinator skill: the session is not ended while train.js status shows a live lock of watch',
  [train, route].every((t) => /not end[^.]*session[^.]*live lock[^.]*watch|session[^.]*not[^.]*ended[^.]*live lock[^.]*watch/.test(t)), route.slice(0, 400));
ok('T17 the train rule and the coordinator skill: the move to the new version goes with the plugin of the remote runner',
  [train, route].every((t) => /runner/.test(t) && /version/.test(t) && /waiter/.test(t)), '');
ok('T17 the train rule: why (cvy-text-reader-1, red 15:17, relaunch 15:41)', /cvy-text-reader-1/.test(train) && /15:17/.test(train) && /15:41/.test(train), '');
ok('T17 the role-chain skill: the stops 74/75/124 name where the verdict goes (status, watch), not "attaches" alone',
  /without an addressee/.test(chainSkill) && /train\.js watch/.test(chainSkill), '');
done();
