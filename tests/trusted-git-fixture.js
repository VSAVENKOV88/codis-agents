'use strict';
// Fixtures of trusted git (scripts/trusted-git.js) for the tests that check a trusted process runs no hook and no
// fsmonitor of the repository it reads:
//   F-h - a repository whose hooks (post-index-change, reference-transaction, post-checkout, post-merge, pre-push,
//         pre-auto-gc, pre-commit, post-commit, post-rewrite) each append a line to a log outside the repository:
//         relative core.hooksPath (.husky/_ committed in the tree, as husky does) or an absolute one (a directory
//         outside the repository, as the .githooks of a project);
//   F-g - core.fsmonitor set to a command that creates a marker file (in the repository config, or in config.worktree
//         of one worktree with extensions.worktreeConfig): git status, ls-files and diff against the index start it.
// The tests' own git calls (quiet) carry the same -c flags, so that the log and the marker count only the process
// under test.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = ['post-index-change', 'reference-transaction', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'pre-commit', 'post-commit', 'post-rewrite'];
const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.email=t@example.com', '-c', 'user.name=t'];
// git without hooks and fsmonitor (the test's own calls) -> spawnSync result
const quiet = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...QUIET, ...a], { encoding: 'utf8' });
// git as a user would call it: hooks and fsmonitor of the repository on
const plain = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const put = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); if (mode) fs.chmodSync(f, mode); };

// Writes the hooks into dir; each appends "<hook> <cwd>" to log.
function writeHooks(dir, log) {
  for (const h of HOOKS) put(path.join(dir, h), `#!/bin/sh\necho "${h} $PWD" >> '${log}'\nexit 0\n`, 0o755);
}
// The lines of the hook log (cleared by clear()).
const hookLines = (log) => read(log).split('\n').filter(Boolean);
// The fsmonitor command that creates marker and answers "no data" (git then scans as without it).
const fsmonitorCmd = (marker) => `touch '${marker}'; false`;
// F-g on a repository or worktree: core.fsmonitor in its config (worktree: config.worktree of that worktree).
function setFsmonitor(dir, marker, worktree) {
  if (worktree) {
    quiet(dir, 'config', 'extensions.worktreeConfig', 'true');
    return quiet(dir, 'config', '--worktree', 'core.fsmonitor', fsmonitorCmd(marker));
  }
  return quiet(dir, 'config', 'core.fsmonitor', fsmonitorCmd(marker));
}
const unsetFsmonitor = (dir) => quiet(dir, 'config', '--unset', 'core.fsmonitor');

// F-h: a new repository at dir on branch main with one commit (a.txt and, for kind "relative", the hooks under
// .husky/_ committed in the tree). kind: "relative" (core.hooksPath=.husky/_) or "absolute" (core.hooksPath = absDir,
// outside the repository). -> {dir, log}
function makeFh(dir, log, kind, absDir) {
  fs.mkdirSync(dir, { recursive: true });
  quiet(dir, 'init', '-q', '-b', 'main');
  put(path.join(dir, 'a.txt'), 'a\n');
  const files = ['a.txt'];
  if (kind === 'absolute') writeHooks(absDir, log);
  else { writeHooks(path.join(dir, '.husky', '_'), log); files.push('.husky'); }
  quiet(dir, 'add', ...files);
  quiet(dir, 'commit', '-q', '-m', 'base');
  quiet(dir, 'config', 'core.hooksPath', kind === 'absolute' ? absDir : '.husky/_');
  return { dir, log };
}
const clear = (...files) => { for (const f of files) fs.rmSync(f, { force: true }); };

module.exports = { HOOKS, QUIET, quiet, plain, read, put, writeHooks, hookLines, fsmonitorCmd, setFsmonitor, unsetFsmonitor, makeFh, clear };
