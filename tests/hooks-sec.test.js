#!/usr/bin/env node
'use strict';
// Two holes of the push protection found by the security review of u2b-1 (owner 2026-10-21: close both, fail closed).
// (1) While the protected branches are unknown, a refspec with a colon and a bare destination name lets git match that
//     name against the refs of the remote: with a local tag master and no local branch master,
//     `git push origin master:master` updates refs/heads/master on the remote (measured with git 2.50:
//     "7b2107e..a07f5f0  master -> master"). The source being a tag does not make it a tag push, so it is refused like
//     the delete of a bare name. Without a colon git takes the full name of the source (refs/tags/master): a tag push.
// (2) The default branch the hooks protect is where refs/remotes/origin/HEAD points, a local ref: `git remote set-head`
//     (any form) and a write or delete of `git symbolic-ref refs/remotes/<remote>/HEAD` move or drop it without the
//     owner's word, so the session hook refuses them (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
// A throw in the hook is not a refusal: Claude Code runs the command after a hook that exits 1 (fail open).
const bash = (command, cwd, cfg, extra = {}) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}, extra)); } catch (e) { return 'CRASH ' + e.message; } };
const hookProc = (command, cwd, cfg) => spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')], { cwd, encoding: 'utf8',
  input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg }) });
const unknownRe = /protected branches unknown/;
const setHeadRe = /refused/;

try {
  // origin holds branches master and build-1; the local repository is on trunk, has no branch master, and holds the
  // tags master, main, build-1 and v1.0 - no origin/HEAD, so with no defaultBranch the branches are unknown.
  const seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'master'); ident(seed); commit(seed, 'a.txt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(seed, 'push', '-q', origin, 'master', 'master:refs/heads/build-1');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'trunk'); ident(repo); commit(repo, 'r.txt');
  git(repo, 'branch', 'b-t1');
  for (const t of ['master', 'main', 'build-1', 'v1.0']) git(repo, 'tag', t);
  git(repo, 'remote', 'add', 'origin', origin);
  ok('setup: no origin/HEAD, no local branch master, local tag master',
    git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0 && git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/master').status !== 0
    && git(repo, 'show-ref', '--verify', '--quiet', 'refs/tags/master').status === 0);
  const unk = cfgFile('unk', { repoDir: repo });
  const known = cfgFile('known', { repoDir: repo, defaultBranch: 'trunk' });

  console.log('1. A tag to a bare destination name while the branches are unknown');
  for (const c of ['git push origin master:master', 'git push origin +master:master', 'git push -f origin master:master',
    'git push origin refs/tags/master:master', 'git push origin +refs/tags/main:main', "git push origin 'master:master'",
    'git push origin build-1:build-1', 'git push origin v1.0:build-1', 'git push origin build-1 master:master',
    'git -c push.default=simple push origin master:master', 'git push --no-verify origin master:master', 'git push origin -- master:master']) {
    const w = bash(c, repo, unk) || '';
    ok(`unknown: "${c}" refused with the reason`, unknownRe.test(w), w);
  }
  ok('unknown: git -C <repo> push origin master:master from outside refused', unknownRe.test(bash(`git -C ${repo} push origin master:master`, dir, unk) || ''), String(bash(`git -C ${repo} push origin master:master`, dir, unk)));
  // Without a colon git pushes the source under its full name refs/tags/<name>; an explicit refs/tags/ destination is a tag.
  for (const c of ['git push origin build-1', 'git push origin master', 'git push origin master:refs/tags/master',
    'git push origin build-1:refs/tags/build-1', 'git push origin refs/tags/build-1']) {
    ok(`unknown: tag push "${c}" allowed`, bash(c, repo, unk) === null, String(bash(c, repo, unk)));
  }
  ok('unknown: a protected tag to a refs/tags/ destination still refused as a tag', /tag v1.0 is refused/.test(bash('git push origin v1.0:refs/tags/v1.0', repo, unk) || ''), String(bash('git push origin v1.0:refs/tags/v1.0', repo, unk)));
  ok('unknown: ALLOW_PROTECTED_PUSH=1 git push origin master:master goes through (the owner\'s word)', bash('ALLOW_PROTECTED_PUSH=1 git push origin master:master', repo, unk) === null, String(bash('ALLOW_PROTECTED_PUSH=1 git push origin master:master', repo, unk)));
  {
    const hp = hookProc('git push origin master:master', repo, unk);
    ok('unknown: the hook process on master:master exits 0 with deny', hp.status === 0 && /"permissionDecision":"deny"/.test(hp.stdout) && unknownRe.test(hp.stdout), `${hp.status} ${hp.stdout} ${hp.stderr}`);
  }
  // With the branches known the bare destination is judged as before: an unprotected name goes through.
  for (const c of ['git push origin master:master', 'git push origin build-1:build-1', 'git push origin b-t1', 'git push origin b-t1:b-t2', 'git push origin HEAD:b-t3'])
    ok(`known trunk: "${c}" allowed (unchanged)`, bash(c, repo, known) === null, String(bash(c, repo, known)));
  for (const c of ['git push origin b-t1:trunk', 'git push origin master:trunk', 'git push origin trunk'])
    ok(`known trunk: "${c}" refused as protected`, /trunk is protected/.test(bash(c, repo, known) || ''), String(bash(c, repo, known)));

  console.log('1b. The real git push through pre-push (second layer)');
  git(repo, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  const before = git(origin, 'rev-parse', 'refs/heads/master').stdout.trim();
  ok('setup: the local tag master differs from origin master', git(repo, 'rev-parse', 'refs/tags/master^{commit}').stdout.trim() !== before);
  let p = spawnSync('git', ['-C', repo, 'push', 'origin', 'master:master'], { encoding: 'utf8', env });
  ok('no origin/HEAD: real git push origin master:master refused by pre-push, origin master unchanged', p.status !== 0 && unknownRe.test(p.stderr)
    && git(origin, 'rev-parse', 'refs/heads/master').stdout.trim() === before, p.stderr);
  p = spawnSync('git', ['-C', repo, 'push', '-q', 'origin', 'build-1'], { encoding: 'utf8', env });
  ok('no origin/HEAD: real git push origin build-1 (no colon) creates the remote tag', p.status === 0 && git(origin, 'show-ref', '--verify', '--quiet', 'refs/tags/build-1').status === 0, p.stderr);
  git(repo, 'config', 'core.hooksPath', '/dev/null');

  console.log('2. git remote set-head and symbolic-ref refs/remotes/<remote>/HEAD');
  for (const cfg of [unk, known]) {
    const label = cfg === unk ? 'unknown' : 'known trunk';
    for (const c of ['git remote set-head origin -a', 'git remote set-head origin --auto', 'git remote set-head origin -d',
      'git remote set-head origin --delete', 'git remote set-head origin b-t1', 'git remote set-head upstream master',
      'git -c core.x=1 remote set-head origin b-t1', 'git remote -v set-head origin b-t1', 'git remote --verbose set-head origin -a',
      'cd /tmp && git remote set-head origin b-t1', 'git status; git remote set-head origin b-t1',
      'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git symbolic-ref -m why refs/remotes/origin/HEAD refs/remotes/origin/b-t1',
      'git symbolic-ref -d refs/remotes/origin/HEAD', 'git symbolic-ref --delete refs/remotes/origin/HEAD', 'git symbolic-ref -q -d refs/remotes/origin/HEAD',
      'git symbolic-ref refs/remotes/up/stream/HEAD refs/remotes/up/stream/x']) {
      const w = bash(c, repo, cfg) || '';
      ok(`${label}: "${c}" refused with the reason`, setHeadRe.test(w) && /HEAD/.test(w) && /owner/.test(w), w);
    }
    ok(`${label}: git -C <repo> remote set-head origin b-t1 from outside refused`, setHeadRe.test(bash(`git -C ${repo} remote set-head origin b-t1`, dir, cfg) || ''), String(bash(`git -C ${repo} remote set-head origin b-t1`, dir, cfg)));
    for (const c of ['git remote', 'git remote -v', 'git remote show origin', 'git remote get-url origin', 'git remote add up /x', 'git remote prune origin',
      'git symbolic-ref refs/remotes/origin/HEAD', 'git symbolic-ref --short -q refs/remotes/origin/HEAD', 'git symbolic-ref HEAD',
      'git symbolic-ref HEAD refs/heads/b-t1', 'echo "git remote set-head origin x"', 'git log --grep set-head'])
      ok(`${label}: "${c}" allowed`, bash(c, repo, cfg) === null, String(bash(c, repo, cfg)));
    ok(`${label}: ALLOW_PROTECTED_PUSH=1 git remote set-head origin --auto goes through (the owner's word)`, bash('ALLOW_PROTECTED_PUSH=1 git remote set-head origin --auto', repo, cfg) === null, String(bash('ALLOW_PROTECTED_PUSH=1 git remote set-head origin --auto', repo, cfg)));
    ok(`${label}: ALLOW_PROTECTED_PUSH=1 in the environment lets set-head through`, bash('git remote set-head origin -a', repo, cfg, { ALLOW_PROTECTED_PUSH: '1' }) === null);
  }
  {
    const hp = hookProc('git remote set-head origin b-t1', repo, known);
    ok('the hook process on git remote set-head exits 0 with deny', hp.status === 0 && /"permissionDecision":"deny"/.test(hp.stdout) && /set-head/.test(hp.stdout), `${hp.status} ${hp.stdout} ${hp.stderr}`);
  }
  {
    // No project config: the plugin is opt-in per project, the hook stays silent.
    const bare = path.join(dir, 'bare'); fs.mkdirSync(bare); git(bare, 'init', '-q');
    ok('no project config: git remote set-head origin -a allowed (hook inactive)', bash('git remote set-head origin -a', bare) === null, String(bash('git remote set-head origin -a', bare)));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
