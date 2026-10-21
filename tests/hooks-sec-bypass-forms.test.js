#!/usr/bin/env node
'use strict';
// p-sec, tester round 4: spellings next to hooks-sec-bypass that it does not name.
// (a) the repository named by a relative --git-dir (resolved against -C), --git-dir after ~ (HOME), --work-tree <path>
//     with a space, and GIT_WORK_TREE / GIT_COMMON_DIR in the hook's own environment - the config is found, the write of
//     refs/remotes/origin/HEAD is refused; git really writes the project's origin/HEAD through a relative --git-dir.
// (b) git update-ref --batch-updates --stdin (git 2.50) and --create-reflog <origin/HEAD> - refused.
// (c) long options of git push that are NOT prefixes of --delete/--all/--mirror/--tags/--follow-tags/--force*: with the
//     branches known, a working-branch push with them stays allowed (behaviour of the base, before unique prefixes).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-bypass-forms-')));
const env = { HOME: dir, PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const bash = (command, cwd, cfg, extra = {}) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}, extra)); } catch (e) { return 'CRASH ' + e.message; } };
const refused = (w) => typeof w === 'string' && /refused/.test(w) && !/^CRASH/.test(w);
const short = (c) => c.split(dir).join('<tmp>');

try {
  const origin = path.join(dir, 'origin.git'), proj = path.join(dir, 'proj'), nocfg = path.join(dir, 'nocfg');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, proj], { encoding: 'utf8' });
  ident(proj);
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(proj, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/b-t1');
  git(proj, 'fetch', '-q', 'origin');
  git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: proj, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));
  fs.mkdirSync(nocfg);
  ok('setup: nocfg has no config', bash('git remote set-head origin -a', nocfg) === null);

  console.log('a. the repository named by a relative --git-dir, ~, --work-tree <path>, the hook environment');
  const G = path.join(proj, '.git');
  for (const c of [
    `git -C ${dir} --git-dir=proj/.git remote set-head origin b-t1`,
    `git -C ${dir} --git-dir proj/.git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1`,
    'git --git-dir=~/proj/.git remote set-head origin b-t1',
    `git -C ${nocfg} --work-tree ${proj} remote set-head origin b-t1`,
    `git -C ${nocfg} --git-dir=${G} -c x.y=1 update-ref --no-deref -d refs/remotes/origin/HEAD`,
  ]) {
    const w = bash(c, nocfg);
    ok(`refused: ${short(c)}`, refused(w), String(w));
  }
  for (const [k, v] of [['GIT_WORK_TREE', proj], ['GIT_COMMON_DIR', G]]) {
    const w = bash(`git -C ${nocfg} remote set-head origin b-t1`, nocfg, null, { [k]: v });
    ok(`refused: ${k}=<project> in the hook environment`, refused(w), String(w));
  }
  // The cell is real: git writes the project's origin/HEAD through a relative --git-dir resolved against -C.
  const r = spawnSync('git', ['-C', dir, '--git-dir=proj/.git', 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/b-t1'], { cwd: nocfg, encoding: 'utf8' });
  const now = git(proj, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim();
  ok('git itself: a relative --git-dir after -C moves the project origin/HEAD (the refused cell is reachable)', r.status === 0 && now === 'origin/b-t1', `rc ${r.status} ${r.stderr} now ${now}`);
  git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

  console.log('b. git update-ref, other option spellings');
  for (const c of ['git update-ref --batch-updates --stdin', 'git update-ref --create-reflog refs/remotes/origin/HEAD HEAD',
    'git update-ref --stdin --batch-updates -z', 'git -C . update-ref --no-deref refs/remotes/origin/HEAD HEAD']) {
    const w = bash(c, proj);
    ok(`refused: ${c}`, refused(w), String(w));
  }
  ok('allowed: git update-ref refs/remotes/origin/HEADX HEAD (not a HEAD of a remote)', bash('git update-ref refs/remotes/origin/HEADX HEAD', proj) === null);

  console.log('c. working-branch pushes with long options that are no prefix of a refused one (branches known)');
  const kn = path.join(dir, 'known.json');
  fs.writeFileSync(kn, JSON.stringify({ repoDir: proj, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir, protectedBranches: ['main'] }));
  for (const c of ['git push origin b-t1', 'git push --set-upstream origin b-t1', 'git push --set-up origin b-t1', 'git push --dry-run origin b-t1',
    'git push --dry origin b-t1', 'git push --verbose origin b-t1', 'git push --quiet origin b-t1', 'git push --atomic origin b-t1',
    'git push --porcelain --progress origin b-t1', 'git push --thin origin b-t1', 'git push --no-thin origin b-t1',
    'git push --no-force-with-lease origin b-t1', 'git push --recurse-submodules=check origin b-t1', 'git push --repo=origin b-t1',
    'git push --push-option=ci.skip origin b-t1', 'git push --signed=if-asked origin b-t1', 'git push -u origin HEAD:b-new']) {
    const w = bash(c, proj, kn);
    ok(`allowed: ${c}`, w === null, String(w));
  }
  for (const c of ['git push --dry-run origin main', 'git push --set-upstream origin HEAD:main', 'git push --atomic origin b-t1 main']) {
    const w = bash(c, proj, kn);
    ok(`refused (protected): ${c}`, refused(w), String(w));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
