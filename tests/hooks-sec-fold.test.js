#!/usr/bin/env node
'use strict';
// Tester p-sec, round 2: APFS (the macOS default, case-insensitive) folds case by Unicode, not only ASCII: the long s
// U+017F folds to s, so the loose ref refs/remoteſ/origin/HEAD is the same file as refs/remotes/origin/HEAD.
// Measured with git 2.50 on macOS 26.5: `git symbolic-ref refs/remoteſ/origin/HEAD refs/remotes/origin/feature` exit 0
// and origin/HEAD -> origin/feature; `-d refs/remoteſ/origin/HEAD` deletes origin/HEAD (test-fold-experiment.log).
// The round-2 fix compares with /.../i, which in JavaScript without the u flag does not fold U+017F to s.
// The session hook must refuse every spelling that the file system folds to refs/remotes/<remote>/HEAD.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, skip, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-fold-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const bash = (command, cwd, cfg) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg })); } catch (e) { return 'CRASH ' + e.message; } };
const LS = 'ſ'; // LATIN SMALL LETTER LONG S

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

  const name = `refs/remote${LS}/origin/HEAD`;
  for (const c of [`git symbolic-ref ${name} refs/remotes/origin/b-t1`, `git symbolic-ref -d ${name}`,
    `git symbolic-ref -m why ${name} refs/remotes/origin/b-t1`, `git symbolic-ref refs/remote${LS}/origin/hEaD refs/remotes/origin/b-t1`]) {
    const w = bash(c, repo, cfg) || '';
    ok(`"${c}" refused with the reason`, /refused/.test(w) && /owner/.test(w), w);
  }
  // Already closed in round 2 - stays closed.
  ok('"git symbolic-ref refs/remotes/origin/hEaD <ref>" refused', /refused/.test(bash('git symbolic-ref refs/remotes/origin/hEaD refs/remotes/origin/b-t1', repo, cfg) || ''));
  ok(`reading ${name} stays allowed`, bash(`git symbolic-ref --short ${name}`, repo, cfg) === null);

  // Why it matters: where the file system folds U+017F to s, the write moves the real origin/HEAD.
  fs.writeFileSync(path.join(dir, `fold${LS}probe`), '');
  if (fs.existsSync(path.join(dir, 'foldsprobe'))) {
    const r = git(repo, 'symbolic-ref', name, 'refs/remotes/origin/b-t1');
    const now = git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim();
    ok(`folding fs: git symbolic-ref ${name} moves origin/HEAD (the hole is real here)`, r.status === 0 && now === 'refs/remotes/origin/b-t1', `${r.status} ${r.stderr} ${now}`);
  } else skip('folding fs: long-s write moves origin/HEAD', 'file system does not fold U+017F to s');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
