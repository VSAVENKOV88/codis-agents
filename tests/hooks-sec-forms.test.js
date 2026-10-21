#!/usr/bin/env node
'use strict';
// Tester p-sec, round 1: spellings of the two closed holes (tests/hooks-sec.test.js) that the programmer's guard does
// not name, and the working-branch pushes that must stay allowed.
// (1) While the branches are unknown a tag pushed to a bare destination after a colon is refused, whatever the source
//     spelling (tags/<t>, <t>^{}, <t>~0, refs/tags/<t>), the force spelling or the git path; a no-colon or refs/tags/
//     tag push stays allowed.
// (2) git remote set-head / git symbolic-ref refs/remotes/<r>/HEAD (write, delete) in option spellings of
//     git-symbolic-ref(1): -qd, -mwhy, -qm why, --message=why, --message why, -- <name> <ref>.
// (3) With the branches known, pushes of working branches are allowed exactly as before p-sec.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-forms-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const bash = (command, cwd, cfg, extra = {}) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}, extra)); } catch (e) { return 'CRASH ' + e.message; } };
const gitPath = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout || '').trim() || '/usr/bin/git';

try {
  const seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'master'); ident(seed); commit(seed, 'a.txt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(seed, 'push', '-q', origin, 'master', 'master:refs/heads/build-1');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'trunk'); ident(repo); commit(repo, 'r.txt');
  git(repo, 'branch', 'b-t1');
  git(repo, 'tag', 'master'); git(repo, 'tag', '-a', '-m', 'annotated', 'build-1'); git(repo, 'tag', 'v1.0');
  git(repo, 'remote', 'add', 'origin', origin);
  ok('setup: no origin/HEAD, tag master, annotated tag build-1, no local branch master',
    git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0 && git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/master').status !== 0
    && git(repo, 'cat-file', '-t', 'build-1').stdout.trim() === 'tag');
  const unk = cfgFile('unk', { repoDir: repo });
  const known = cfgFile('known', { repoDir: repo, defaultBranch: 'trunk' });
  const unknownRe = /protected branches unknown/;

  console.log('1. Unknown branches: a tag to a bare destination in other spellings');
  for (const c of ['git push origin tags/master:master', "git push origin 'master^{}:master'", 'git push origin master~0:master',
    'git push origin build-1:master', 'git push origin refs/tags/build-1:build-1', 'git push origin +tags/build-1:build-1',
    'git push --force-with-lease origin master:master', 'git push --force origin master:master', 'git push -u origin master:master',
    `${gitPath} push origin master:master`, 'env ALLOW_PROTECTED_PUSH=0 git push origin master:master', 'ALLOW_PROTECTED_PUSH= git push origin master:master',
    'git push origin master:refs/tags/master master:master', 'git push --repo origin origin master:master',
    'git -c remote.origin.push=refs/tags/master:master push origin', 'true && git push origin master:master', '(git push origin master:master)']) {
    const w = bash(c, repo, unk) || '';
    ok(`unknown: "${c}" refused with the reason`, unknownRe.test(w), w);
  }
  ok('unknown: the reason names the tag spelling to use instead', /refs\/tags\/master/.test(bash('git push origin master:master', repo, unk) || ''), String(bash('git push origin master:master', repo, unk)));
  for (const c of ['git push origin refs/tags/master:refs/tags/master', 'git push origin tags/master:refs/tags/master', 'git push origin +master:refs/tags/master',
    'git push origin build-1', 'git push -f origin build-1'])
    ok(`unknown: tag push "${c}" allowed`, bash(c, repo, unk) === null, String(bash(c, repo, unk)));

  console.log('2. Option spellings of git symbolic-ref refs/remotes/<r>/HEAD and git remote set-head');
  for (const cfg of [unk, known]) {
    const label = cfg === unk ? 'unknown' : 'known trunk';
    for (const c of ['git symbolic-ref -qd refs/remotes/origin/HEAD', 'git symbolic-ref -dq refs/remotes/origin/HEAD',
      'git symbolic-ref -mwhy refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git symbolic-ref -qm why refs/remotes/origin/HEAD refs/remotes/origin/b-t1',
      'git symbolic-ref --message=why refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git symbolic-ref --message why refs/remotes/origin/HEAD refs/remotes/origin/b-t1',
      'git symbolic-ref -- refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git symbolic-ref --delete -- refs/remotes/origin/HEAD',
      'git symbolic-ref --no-recurse refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git symbolic-ref refs/remotes/origin/HEAD b-t1',
      `${gitPath} remote set-head origin -a`, 'git --no-pager remote set-head origin -a', 'git -C . remote set-head origin -a',
      'ALLOW_PROTECTED_PUSH=0 git remote set-head origin -a', 'env FOO=1 git remote set-head origin -a', '(git remote set-head origin -a)',
      'git remote set-head origin -a || true', 'git remote -v -v set-head origin b-t1']) {
      const w = bash(c, repo, cfg) || '';
      ok(`${label}: "${c}" refused with the reason`, /refused/.test(w) && /HEAD/.test(w) && /owner/.test(w), w);
    }
    for (const c of ['git symbolic-ref -q refs/remotes/origin/HEAD', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git symbolic-ref -q --short HEAD',
      'git remote show origin', 'git remote set-url origin /x', 'git remote set-branches origin b-t1', 'git remote rm up'])
      ok(`${label}: "${c}" allowed`, bash(c, repo, cfg) === null, String(bash(c, repo, cfg)));
  }

  console.log('3. Known branches: working-branch pushes stay allowed');
  git(repo, 'checkout', '-q', 'b-t1');
  for (const c of ['git push origin b-t1', 'git push -u origin b-t1', 'git push origin HEAD', 'git push origin HEAD:b-t1', 'git push',
    'git push origin b-t1:refs/heads/b-t1', 'git push --force-with-lease origin b-t1', 'git push origin +b-t1', 'git push origin b-t1:b-new',
    'git push origin --delete b-old', 'git push origin :b-old', 'git push origin master:refs/tags/master', 'git push origin master',
    'git push origin b-t1 master:refs/tags/master', 'git status && git push origin b-t1'])
    ok(`known trunk: "${c}" allowed`, bash(c, repo, known) === null, String(bash(c, repo, known)));
  for (const c of ['git push origin trunk', 'git push origin HEAD:trunk', 'git push origin b-t1:refs/heads/trunk', 'git push origin --delete trunk', 'git push origin v1.0'])
    ok(`known trunk: "${c}" refused`, /refused/.test(bash(c, repo, known) || ''), String(bash(c, repo, known)));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
