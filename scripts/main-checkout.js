#!/usr/bin/env node
'use strict';
// Is a directory the MAIN working copy of its repository? git rev-parse gives the same --git-dir and --git-common-dir
// there; a linked worktree (git worktree add, scripts/wt-setup.sh) has its own git-dir under <common>/worktrees/<name>
// (git-worktree(1), "DETAILS"). A subdirectory of the main working copy counts as the main one (same git-dir); a
// directory outside git is not a working copy at all and passes.
// Why: the ignored data of the main working copy (a measurement corpus, builds) is the only original - task worktrees
// hold clones of it (rules/multi-agent.md, "Worktrees get their own copy of ignored data"). A full guard run started
// on the main working copy once wiped that corpus through a guard of the project. guards-all.sh and the preconditions
// (env-check.js --worktree) therefore refuse it; --main-checkout is the explicit override for a project that has no
// worktrees, a command-line flag on purpose, so that it is never inherited silently like an environment variable.
// usage: main-checkout.js [--main-checkout] <dir>
//   exit 0 - not the main working copy (or --main-checkout given), silent; 78 - the main working copy, the reason on
//   stderr; 64 - bad usage.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// {main, root, gitDir, commonDir}; main: false without git data when dir is not inside a git working copy.
function mainCheckout(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) return { main: false, reason: 'not a git working copy' };
  const [gitDir, commonDir] = r.stdout.trim().split('\n').map(real);
  const main = !!gitDir && gitDir === commonDir;
  return { main, root: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir, gitDir, commonDir };
}

function refusal(dir, r) {
  return `${dir} is the main working copy of ${r.root} (git-dir == git-common-dir): its ignored data is the only original, `
    + 'and a guard run there can wipe it - run in a task worktree with its own copy of that data '
    + '(scripts/wt-setup.sh <name> <branch>), or pass --main-checkout for a project that has no worktrees';
}

module.exports = { mainCheckout, refusal };

if (require.main === module) {
  const a = process.argv.slice(2);
  const force = a.includes('--main-checkout');
  const pos = a.filter((x) => x !== '--main-checkout');
  if (pos.length !== 1 || !pos[0] || pos[0].startsWith('--')) {
    console.error('usage: main-checkout.js [--main-checkout] <dir>');
    process.exit(64);
  }
  if (force) process.exit(0);
  const r = mainCheckout(pos[0]);
  if (r.main) { console.error(`main-checkout: ${refusal(pos[0], r)}`); process.exit(78); }
  process.exit(0);
}
