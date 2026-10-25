#!/usr/bin/env node
'use strict';
// The post-check after the tester in one command (plugin audit P2): the git post-check (role-diff-check.js) and the
// leftovers post-check (role-leftovers-check.js) run one after the other in this process, so the role chain needs one
// service agent per tester round instead of two. The workflow runtime has no way to run a command without an agent, so
// the agent stays; it pays its system prompt once instead of twice.
// usage: role-post-check.js --wt <dir> --since <sha> --role tester|reviewer [--allow <regex>]...
//                           [--tmp <dir>]... [--stack <project>] [--owner-stack <project>] [--slots-dir <dir>] [--fix] [--log <file>]
//   -> JSON {ok, diff, left}: diff - the JSON of role-diff-check.js, left - the JSON of role-leftovers-check.js;
//      ok when diff.ok and left.ok; exit 0 when ok, 1 otherwise. The leftovers check runs even when the diff check
//      fails, so what the task left is removed and logged either way.
const diff = require('./role-diff-check');
const left = require('./role-leftovers-check');

function check(o) {
  let d, l;
  try { d = diff.check({ wt: o.wt, since: o.since, role: o.role, allow: o.allow || [] }); } catch (e) { d = { ok: false, offending: [], error: e.message }; }
  try {
    l = left.check({ wt: o.wt, tmp: o.tmp || [], stack: o.stack, ownerStack: o.ownerStack, slotsDir: o.slotsDir, fix: !!o.fix, log: o.log });
  } catch (e) { l = { ok: false, error: e.message, found: [], removed: [], remaining: [e.message], skipped: [] }; }
  return { ok: !!(d && d.ok && l && l.ok), diff: d, left: l };
}

module.exports = { check };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const many = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  const r = check({ wt: arg('--wt'), since: arg('--since'), role: arg('--role'), allow: many('--allow'), tmp: many('--tmp'), stack: arg('--stack'),
    ownerStack: arg('--owner-stack'), slotsDir: arg('--slots-dir'), fix: a.includes('--fix'), log: arg('--log') });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
