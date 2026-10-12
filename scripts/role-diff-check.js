#!/usr/bin/env node
'use strict';
// Post-check of a role by git: the tester does not change product code, the reviewer only reads.
// A hook on Edit/Write cannot see `python -c`, `node -e`, a heredoc or `git checkout`, so this looks at the result in
// the worktree, not at the way it was written.
// usage: role-diff-check.js --wt <dir> --since <sha> --role tester|reviewer [--allow <regex>]...
//   -> JSON {ok, role, since, head, offending, untracked, error?}
// offending - paths committed after <since> or changed in tracked files that the role may not touch. untracked -
// untracked files (noise of guard runs), not part of the verdict.
// --allow: regular expressions of paths the tester may change (project config "testerWritable"); without it, guards
// named *-run.{js,mjs,cjs} and fixture directories.
const { execFileSync } = require('child_process');

const TESTER_DEFAULT = ['-run\\.(js|mjs|cjs)$', '(^|/)(__)?fixtures(__)?/'];

const allowFor = (role, allow) => {
  if (role === 'reviewer') return () => false;
  if (role === 'tester') {
    const res = (allow && allow.length ? allow : TESTER_DEFAULT).map((r) => new RegExp(r));
    return (f) => res.some((re) => re.test(f));
  }
  return null;
};

function check({ wt, since, role, allow }) {
  const ok = allowFor(role, allow);
  if (!ok) return { ok: false, role, error: `unknown role ${role}` };
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let head;
  try {
    head = git('rev-parse', 'HEAD').trim();
    git('merge-base', '--is-ancestor', since, 'HEAD');
  } catch (e) {
    // since is not an ancestor of HEAD (history rewritten, another branch): cannot be checked, so not ok
    return { ok: false, role, since, head, error: `${since} is not an ancestor of HEAD in ${wt}` };
  }
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const changed = new Set([
    ...lines(git('diff', '--name-only', `${since}..HEAD`)),
    ...lines(git('diff', '--name-only', 'HEAD')),
  ]);
  const offending = [...changed].filter((f) => !ok(f)).sort();
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
  return { ok: offending.length === 0, role, since, head, offending, untracked };
}

module.exports = { check, TESTER_DEFAULT };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const allow = a.flatMap((x, i) => (x === '--allow' ? [a[i + 1]] : []));
  let r;
  try { r = check({ wt: arg('--wt'), since: arg('--since'), role: arg('--role'), allow }); } catch (e) { r = { ok: false, error: e.message }; }
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
