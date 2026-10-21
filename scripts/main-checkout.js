#!/usr/bin/env node
'use strict';
// Is a directory the MAIN working copy of its repository? git rev-parse gives the same --git-dir and --git-common-dir
// there; a linked worktree (git worktree add, scripts/wt-setup.sh) has its own git-dir under <common>/worktrees/<name>
// (git-worktree(1), "DETAILS"). A subdirectory of the main working copy counts as the main one (same git-dir); a
// directory outside git is not a working copy at all and passes. A git error inside a tree with .git above it is a
// refusal, never a pass, and git's own environment variables (GIT_DIR...) are ignored.
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

// git's discovery follows GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES and more (git(1),
// "ENVIRONMENT VARIABLES"); git hooks set GIT_DIR. Every GIT_* is dropped, so that only the directory decides and no
// environment variable can turn the main working copy into a "worktree".
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const revParse = (cwd, args) => spawnSync('git', ['-C', cwd, 'rev-parse', ...args], { encoding: 'utf8', env: gitEnv() });
const lines = (r) => (r.stdout || '').split('\n').filter(Boolean);
const gitError = (r) => ((r.error && r.error.message) || (r.stderr || '').trim() || `git rev-parse exit ${r.status}`).split('\n')[0];

// The nearest .git (a directory in the main copy, a file in a linked worktree) at dir or above it, or null.
function dotGitAbove(dir) {
  for (let d = real(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return path.join(d, '.git');
    if (path.dirname(d) === d) return null;
  }
}

// {main, root, gitDir, commonDir}; main: false without git data when dir is not inside a git working copy.
// A git failure inside a tree with .git above it (git >= 2.35.2 refuses a repository of another owner, "dubious
// ownership"; git missing) cannot tell the main copy from a worktree and is a refusal: {main: true, error, dotGit}.
// --path-format (git 2.31) is not used: rev-parse runs from the top level, where git prints the git dirs relative to
// it or absolute (git-rev-parse(1)), and older git echoes an unknown option instead of failing.
function mainCheckout(dir) {
  const failed = (r) => {
    const dotGit = dotGitAbove(dir);
    return dotGit ? { main: true, error: gitError(r), dotGit, root: path.dirname(dotGit) } : { main: false, reason: 'not a git working copy' };
  };
  const top = revParse(dir, ['--show-toplevel']);
  if (top.status !== 0 || lines(top).length !== 1) return failed(top);
  const root = lines(top)[0];
  const r = revParse(root, ['--git-dir', '--git-common-dir']);
  const out = lines(r);
  if (r.status !== 0 || out.length !== 2 || out.some((l) => l.startsWith('-'))) return failed(r);
  const [gitDir, commonDir] = out.map((l) => real(path.resolve(root, l)));
  return { main: gitDir === commonDir, root: path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir, gitDir, commonDir };
}

function refusal(dir, r) {
  if (r.error) {
    return `${dir} is inside a git tree (${r.dotGit}), but git rev-parse failed there: ${r.error} - the main working copy `
      + 'cannot be told from a linked worktree, so it is refused; fix git there (a repository of another owner: '
      + 'git config --global --add safe.directory <path>), or pass --main-checkout for a project that has no worktrees';
  }
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
