#!/usr/bin/env node
'use strict';
// scripts/main-checkout.js is closed on a git failure and blind to git's discovery environment (review 1 of p-main-wt):
// - GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES (set by git hooks, or by an agent's shell) do not
//   get the main working copy past the refusal: git is run with the GIT_* variables cleared;
// - git rev-parse failing inside a tree that has .git above it (git >= 2.35.2 refuses a repository of another owner,
//   "detected dubious ownership", e.g. root in a container on a bind mount) is a refusal, 78 with git's error, not a
//   pass; outside any .git the failure still passes (nothing to protect);
// - a git without --path-format (before 2.31: rev-parse echoes an unknown option as an argument) still tells the main
//   copy from a linked worktree.
// Each case through the CLI (78/0) and through the preconditions (env-check.js --worktree).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-checkout-git-env-')));
const main = path.join(dir, 'main'), linked = path.join(dir, 'wts', 'linked'), plain = path.join(dir, 'plain');
const bin = (name) => path.join(dir, 'bin-' + name);
const g = (...a) => spawnSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const cli = (script, a, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...a],
  { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
const envCheck = (wt, e) => {
  const y = cli('env-check.js', ['--path', dir, '--min-disk-gb', '0', '--min-swap-gb', '0', '--worktree', wt], e);
  let j = null; try { j = JSON.parse(y.stdout); } catch { /* below */ }
  return { y, j, refused: y.status === 1 && !!j && j.ok === false && j.problems.some((p) => p.includes(wt)) };
};
// A fake git first in PATH: `fail` exits 128 like a dubious-ownership refusal; `old` drops --path-format and echoes it
// as rev-parse before 2.31 did, then runs the real git.
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const fake = (name, body) => {
  fs.mkdirSync(bin(name)); const f = path.join(bin(name), 'git');
  fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n'); fs.chmodSync(f, 0o755);
  return { PATH: bin(name) + path.delimiter + process.env.PATH };
};
try {
  fs.mkdirSync(path.join(main, 'sub'), { recursive: true }); fs.mkdirSync(plain);
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(main, 'sub', 'a.txt'), '1');
  g('add', 'sub/a.txt'); g('commit', '-qm', 'base');
  const w = g('worktree', 'add', '-q', '-b', 'b-linked', linked);
  const wtGitDir = path.join(main, '.git', 'worktrees', 'linked');
  ok('fixture: a repository with a linked worktree', w.status === 0 && fs.existsSync(wtGitDir) && !!realGit, w.stderr);

  const cases = [
    ['GIT_DIR=<the linked worktree\'s gitdir>', main, { GIT_DIR: wtGitDir }],
    ['GIT_DIR=<a path that does not exist>', main, { GIT_DIR: path.join(dir, 'nonexistent') }],
    ['GIT_DIR + GIT_WORK_TREE of the linked worktree', main, { GIT_DIR: wtGitDir, GIT_WORK_TREE: linked }],
    ['GIT_COMMON_DIR=<the linked worktree\'s gitdir>', main, { GIT_COMMON_DIR: wtGitDir }],
    ['GIT_CEILING_DIRECTORIES=<main> on main/sub', path.join(main, 'sub'), { GIT_CEILING_DIRECTORIES: main }],
  ];
  for (const [name, d, e] of cases) {
    const x = cli('main-checkout.js', [d], e);
    ok(`main-checkout.js: ${name} -> still 78`, x.status === 78 && /main working copy/.test(x.stderr), `${x.status} ${x.stderr}`);
    const c = envCheck(d, e);
    ok(`env-check --worktree: ${name} -> still refused`, c.refused, c.y.stdout + c.y.stderr);
  }
  let x = cli('main-checkout.js', [linked], { GIT_DIR: path.join(main, '.git') });
  ok('main-checkout.js: GIT_DIR=<main .git> on the linked worktree -> 0 (git sees the worktree itself)', x.status === 0, `${x.status} ${x.stderr}`);

  const fail = fake('fail', 'echo "fatal: detected dubious ownership in repository at \'$PWD\'" >&2; exit 128');
  x = cli('main-checkout.js', [main], fail);
  ok('main-checkout.js: git rev-parse fails inside a .git tree -> 78 with git\'s error, not a pass',
    x.status === 78 && /dubious ownership/.test(x.stderr) && /--main-checkout/.test(x.stderr), `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [linked], fail);
  ok('main-checkout.js: git fails in a linked worktree (.git file) -> 78 too: cannot tell, closed', x.status === 78, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [path.join(main, 'sub')], fail);
  ok('main-checkout.js: git fails in a subdirectory of the main copy (.git above) -> 78', x.status === 78, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [plain], fail);
  ok('main-checkout.js: git fails outside any .git -> 0 (not a working copy)', x.status === 0, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', ['--main-checkout', main], fail);
  ok('main-checkout.js: git fails but --main-checkout given -> 0', x.status === 0, `${x.status} ${x.stderr}`);
  let c = envCheck(main, fail);
  ok('env-check --worktree: git fails inside a .git tree -> refused with git\'s error',
    c.refused && c.j.problems.some((p) => /dubious ownership/.test(p)), c.y.stdout + c.y.stderr);
  c = envCheck(plain, fail);
  ok('env-check --worktree: git fails outside any .git -> ok', c.y.status === 0 && c.j && c.j.ok, c.y.stdout + c.y.stderr);
  const nogit = { PATH: bin('none') }; fs.mkdirSync(bin('none'));
  x = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'main-checkout.js'), main], { encoding: 'utf8', env: Object.assign({}, process.env, nogit) });
  ok('main-checkout.js: no git in PATH inside a .git tree -> 78', x.status === 78, `${x.status} ${x.stderr}`);

  const old = fake('old', `case " $* " in *" --path-format=absolute "*) echo --path-format=absolute ;; esac
for a in "$@"; do shift; [ "$a" = --path-format=absolute ] || set -- "$@" "$a"; done
exec '${realGit}' "$@"`);
  x = cli('main-checkout.js', [main], old);
  ok('main-checkout.js: git without --path-format, main copy -> 78', x.status === 78 && /main working copy/.test(x.stderr), `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [path.join(main, 'sub')], old);
  ok('main-checkout.js: git without --path-format, subdirectory of the main copy -> 78', x.status === 78, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [linked], old);
  ok('main-checkout.js: git without --path-format, linked worktree -> 0', x.status === 0, `${x.status} ${x.stderr}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
