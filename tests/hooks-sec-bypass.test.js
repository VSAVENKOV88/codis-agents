#!/usr/bin/env node
'use strict';
// p-sec round 4 (review and security review of round 3): plain git spellings that got past the session hook.
// (a) --git-dir / --work-tree and the GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR variables name the repository git
//     works on; the hook took the config only from -C and the cwd, so `git -C <dir without config>
//     --git-dir=<project>/.git remote set-head origin feat` moved the project's origin/HEAD (git 2.50).
// (b) `git update-ref` writes refs/remotes/<remote>/HEAD too: `printf 'symref-update refs/remotes/origin/HEAD
//     refs/remotes/origin/feat\n' | git update-ref --stdin` moved origin/HEAD, and after it pre-push protected the
//     wrong branch ("93aeb02..a5de3df HEAD -> main"); `update-ref --no-deref [-d] refs/remotes/origin/HEAD` too.
// (c) git accepts any unique prefix of a long option (gitcli(7), parse-options): `git symbolic-ref --del <name>`
//     deletes origin/HEAD, `git push origin --del master` deletes a bare name, `git push --ta` pushes the tags,
//     `git push --force-w` forces a standing push; the hook compared only the full spelling (measured with git 2.50).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-bypass-')));
const env = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
// extra: the environment of the hook; cfg: CODIS_AGENTS_CONFIG (omitted - the config is found from the directories only)
const bash = (command, cwd, cfg, extra = {}) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}, extra)); } catch (e) { return 'CRASH ' + e.message; } };
const refused = (w) => typeof w === 'string' && /refused/.test(w) && !/^CRASH/.test(w);

try {
  // proj: a project with its config in .claude/ (found from the directory), a clone of origin with origin/HEAD -> trunk.
  const origin = path.join(dir, 'origin.git'), proj = path.join(dir, 'proj'), other = path.join(dir, 'other'), nocfg = path.join(dir, 'nocfg');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, proj], { encoding: 'utf8' });
  ident(proj);
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(proj, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/b-t1');
  git(proj, 'fetch', '-q', 'origin');
  git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: proj, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));
  // other: a repository with no config anywhere above it; nocfg: a plain directory outside any repository.
  fs.mkdirSync(other); git(other, 'init', '-q', '-b', 'main');
  fs.mkdirSync(nocfg);
  ok('setup: nocfg is outside any repository and config', bash('git remote set-head origin -a', nocfg) === null);
  ok('setup: the project refuses set-head from its own directory', refused(bash('git remote set-head origin -a', proj)));

  console.log('a. --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR name the repository');
  const G = path.join(proj, '.git');
  for (const c of [
    `git -C ${nocfg} --git-dir=${G} remote set-head origin b-t1`,
    `git -C ${nocfg} --git-dir ${G} remote set-head origin -a`,
    `git -C ${nocfg} --git-dir ${G} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1`,
    `git --git-dir=${G} symbolic-ref -d refs/remotes/origin/HEAD`,
    `git -C ${nocfg} --work-tree=${proj} remote set-head origin b-t1`,
    `GIT_DIR=${G} git -C ${nocfg} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1`,
    `GIT_WORK_TREE=${proj} GIT_DIR=${G} git remote set-head origin b-t1`,
    `env GIT_DIR=${G} git remote set-head origin -a`,
    `GIT_COMMON_DIR=${G} git -C ${nocfg} update-ref --no-deref refs/remotes/origin/HEAD HEAD`,
    `export GIT_DIR=${G}; git -C ${nocfg} remote set-head origin b-t1`,
    `export GIT_DIR=${G} && git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1`,
    `GIT_DIR=${G}; export GIT_DIR; git remote set-head origin b-t1`,
    `git -C ${nocfg} --git-dir=${G} add -A`,
  ]) {
    const w = bash(c, nocfg);
    ok(`refused: ${c.replace(dir, '<tmp>').replace(dir, '<tmp>')}`, refused(w), String(w));
  }
  // The hook of the session's own environment (a git hook that runs Claude Code) counts too.
  ok('refused: GIT_DIR=<project> in the hook environment', refused(bash(`git -C ${nocfg} remote set-head origin b-t1`, nocfg, null, { GIT_DIR: G })));
  // A push into another repository than the one the hook can read is refused: the hook judges the branches of dir.
  const pw = bash(`git -C ${nocfg} --git-dir=${G} push origin HEAD:b-t1`, nocfg);
  ok('refused: push with --git-dir of the project (the hook cannot read its branches from -C)', refused(pw) && /-C/.test(pw), String(pw));
  const pe = bash(`GIT_DIR=${G} git push origin HEAD:b-t1`, proj);
  ok('refused: push with GIT_DIR from the project directory', refused(pe), String(pe));
  // Allowed: no config anywhere, reads, subcommands the hook does not judge.
  for (const c of [
    `git -C ${nocfg} --git-dir=${path.join(other, '.git')} remote set-head origin b-t1`,
    `GIT_DIR=${path.join(other, '.git')} git -C ${nocfg} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1`,
    `git -C ${nocfg} --git-dir=${G} symbolic-ref refs/remotes/origin/HEAD`,
    `git -C ${nocfg} --git-dir=${G} log -1`,
    `GIT_DIR=${G} git status`,
    `git -C ${nocfg} --git-dir=${G} add a.txt`,
  ]) {
    const w = bash(c, nocfg);
    ok(`allowed: ${c.replace(dir, '<tmp>').replace(dir, '<tmp>')}`, w === null, String(w));
  }

  console.log('b. git update-ref on refs/remotes/<remote>/HEAD, and --stdin');
  for (const c of [
    'git update-ref --stdin', 'git update-ref --stdin -z', 'git update-ref -z --stdin', 'git update-ref --std',
    'printf "symref-update refs/remotes/origin/HEAD refs/remotes/origin/b-t1\\n" | git update-ref --stdin',
    'git update-ref --no-deref refs/remotes/origin/HEAD HEAD', 'git update-ref refs/remotes/origin/HEAD HEAD',
    'git update-ref -d refs/remotes/origin/HEAD', 'git update-ref --no-deref -d refs/remotes/origin/HEAD',
    'git update-ref -d --no-deref refs/remotes/origin/head', 'git update-ref -m why refs/remotes/origin/HEAD HEAD',
    'git update-ref -mwhy refs/remotes/origin/HEAD HEAD', 'git update-ref --no-d refs/remoteſ/origin/HEAD HEAD',
    'git update-ref refs/remotes/up/HEAD HEAD', 'git update-ref -- refs/remotes/origin/HEAD HEAD',
  ]) {
    const w = bash(c, proj);
    ok(`refused: ${c}`, refused(w) && /owner/.test(w), String(w));
  }
  for (const c of ['git update-ref refs/heads/b-x HEAD', 'git update-ref -d refs/heads/b-x', 'git update-ref refs/remotes/origin/b-t1 HEAD',
    'git update-ref -m why refs/heads/b-x HEAD']) {
    const w = bash(c, proj);
    ok(`allowed: ${c}`, w === null, String(w));
  }
  ok('allowed with ALLOW_PROTECTED_PUSH=1: git update-ref --stdin', bash('ALLOW_PROTECTED_PUSH=1 git update-ref --stdin', proj) === null);

  console.log('c. abbreviated long options');
  for (const c of ['git symbolic-ref --del refs/remotes/origin/HEAD', 'git symbolic-ref --dele refs/remotes/origin/HEAD',
    'git symbolic-ref --d refs/remotes/origin/HEAD', 'git symbolic-ref --short --del refs/remotes/origin/HEAD',
    'git symbolic-ref -q --delet refs/remotes/origin/HEAD', 'git symbolic-ref --delete -q refs/remotes/origin/HEAD']) {
    const w = bash(c, proj);
    ok(`refused: ${c}`, refused(w), String(w));
  }
  for (const c of ['git symbolic-ref --sh refs/remotes/origin/HEAD', 'git symbolic-ref --short refs/remotes/origin/HEAD', 'git symbolic-ref -q refs/remotes/origin/HEAD']) {
    const w = bash(c, proj);
    ok(`allowed (read): ${c}`, w === null, String(w));
  }
  // push: unknown branches (no origin/HEAD, no defaultBranch), a local tag master and no local branch master.
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'trunk'); ident(repo); git(repo, 'commit', '-q', '--allow-empty', '-m', 'r');
  git(repo, 'tag', 'master'); git(repo, 'branch', 'b-t1'); git(repo, 'remote', 'add', 'origin', origin);
  const unk = path.join(dir, 'unk.json');
  fs.writeFileSync(unk, JSON.stringify({ repoDir: repo, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));
  for (const c of ['git push origin --del master', 'git push origin --dele master', 'git push origin --delet master', 'git push --de origin master']) {
    const w = bash(c, repo, unk);
    ok(`unknown branches - refused: ${c}`, refused(w) && /unknown/.test(w), String(w));
  }
  // With known branches (main protected, the repository on trunk) the plain push of b-t1 is allowed, so only the option refuses.
  const kn = path.join(dir, 'known.json');
  fs.writeFileSync(kn, JSON.stringify({ repoDir: repo, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir, protectedBranches: ['main'] }));
  ok('known branches - git push origin b-t1 allowed (fixture)', bash('git push origin b-t1', repo, kn) === null);
  for (const c of ['git push --mir origin', 'git push --mi origin', 'git push --al origin', 'git push --ta origin b-t1', 'git push --tag origin b-t1', 'git push --fol origin b-t1', 'git push --follow origin b-t1']) {
    const w = bash(c, repo, kn);
    ok(`refused: ${c}`, refused(w), String(w));
  }
  ok('unknown branches - a tag without a colon still allowed: git push origin master', bash('git push origin master', repo, unk) === null);
  // A standing push never forces: an abbreviation of --force-with-lease / --force-if-includes forces too.
  const sp = path.join(dir, 'sp');
  fs.mkdirSync(path.join(sp, '.claude'), { recursive: true }); git(sp, 'init', '-q', '-b', 'main'); ident(sp);
  fs.writeFileSync(path.join(sp, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: sp, worktreeRoot: dir, sharedDir: dir, protectedBranches: ['main'], standingPush: { branches: ['main'], check: 'true' } }));
  git(sp, 'add', '.claude/codis-agents.json'); git(sp, 'commit', '-qm', 'cfg');
  ok('standing push: git push origin main allowed (fixture)', bash('git push origin main', sp) === null, String(bash('git push origin main', sp)));
  for (const c of ['git push --force-w origin main', 'git push --force-with origin main', 'git push --force-i origin main', 'git push --force-if-includes origin main']) {
    const w = bash(c, sp);
    ok(`standing push - forced refused: ${c}`, refused(w) && /force/.test(w), String(w));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
