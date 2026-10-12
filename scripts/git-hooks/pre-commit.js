#!/usr/bin/env node
'use strict';
// Checks before a commit, driven by the project config (.claude/codis-agents.json, key "gitHooks"):
//  1. gitHooks.blockICloudCopies: no iCloud conflict copies ("name 2.ext", a space and a digit 2-9 before the
//     extension or at the end of a file or directory name) in the index;
//  2. gitHooks.preCommit: extra shell commands run in the repository root; a non-zero exit refuses the commit
//     (for example a check that a committed bundle matches its sources, or a secrets scanner).
// Install once for all worktrees: git config core.hooksPath <plugin>/scripts/git-hooks
const { spawnSync } = require('child_process');
const path = require('path');
const { loadOrDefaults } = require(path.join(__dirname, '..', 'config.js'));

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const top = git(['rev-parse', '--show-toplevel']).stdout.trim() || process.cwd();
const cfg = loadOrDefaults(top, process.env);
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).stdout.split('\0').filter(Boolean);
let failed = false;
const fail = (m) => { failed = true; console.error('pre-commit: ' + m); };

if (cfg.gitHooks.blockICloudCopies) {
  const icloud = staged.filter((p) => p.split('/').some((seg) => / [2-9](\.[^./]+)?$/.test(seg)));
  if (icloud.length) fail('iCloud conflict copies are staged (never commit them): ' + icloud.join(', '));
}
for (const cmd of cfg.gitHooks.preCommit) {
  const r = spawnSync('sh', ['-c', cmd], { cwd: top, stdio: 'inherit' });
  if (r.status !== 0) fail(`check failed (exit ${r.status}): ${cmd}`);
}
process.exit(failed ? 1 : 0);
