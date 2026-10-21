#!/usr/bin/env node
'use strict';
// Tester p-sec, round 1: on a case-insensitive file system (APFS on the owner's Mac, the default) the loose ref
// refs/remotes/origin/head is the same file as refs/remotes/origin/HEAD, so
// `git symbolic-ref refs/remotes/origin/head refs/remotes/origin/<b>` moves the default branch the hooks protect
// (measured with git 2.50 on macOS: origin/HEAD -> origin/<b>, exit 0). The session hook must refuse every case
// spelling of the HEAD component (and of refs/remotes/) - refusing it on a case-sensitive system too is closed, not open.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, skip, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-case-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const bash = (command, cwd, cfg) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg })); } catch (e) { return 'CRASH ' + e.message; } };

try {
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, repo], { encoding: 'utf8' });
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/b-t1');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: repo, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));

  for (const c of ['git symbolic-ref refs/remotes/origin/head refs/remotes/origin/b-t1', 'git symbolic-ref refs/remotes/origin/Head refs/remotes/origin/b-t1',
    'git symbolic-ref -d refs/remotes/origin/head', 'git symbolic-ref refs/Remotes/origin/HEAD refs/remotes/origin/b-t1']) {
    const w = bash(c, repo, cfg) || '';
    ok(`"${c}" refused with the reason`, /refused/.test(w) && /owner/.test(w), w);
  }
  ok('reading refs/remotes/origin/head stays allowed', bash('git symbolic-ref --short refs/remotes/origin/head', repo, cfg) === null);

  // Why it matters: on a case-insensitive file system the lower-case write moves the real origin/HEAD.
  const probe = path.join(dir, 'CaseProbe');
  fs.writeFileSync(probe, '');
  if (fs.existsSync(path.join(dir, 'caseprobe'))) {
    git(repo, 'symbolic-ref', 'refs/remotes/origin/head', 'refs/remotes/origin/b-t1');
    const now = git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim();
    ok('case-insensitive fs: git symbolic-ref refs/remotes/origin/head moves origin/HEAD (the hole is real here)', now === 'refs/remotes/origin/b-t1', now);
  } else skip('case-insensitive fs: lower-case write moves origin/HEAD', 'case-sensitive file system');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
