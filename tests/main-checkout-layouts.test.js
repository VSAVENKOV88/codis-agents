#!/usr/bin/env node
'use strict';
// Tester guard p-main-wt, round 2: repository layouts where "has a .git file" or "has a .git directory" would give the
// wrong answer, and git-dir == git-common-dir (scripts/main-checkout.js, git-worktree(1) "DETAILS") gives the right one:
// - a main copy made with `git init --separate-git-dir` has a .git FILE, like a linked worktree - still the main copy, 78;
// - the .git directory of the main copy itself - git fails there (not a work tree), the tree has .git above: 78;
// - a linked worktree whose gitdir was removed (stale .git file) - git fails, cannot tell: 78, never a pass;
// - a submodule checkout (.git file into <super>/.git/modules/<name>, its own git-dir == common-dir) - 78;
// - a git without --path-format on a subdirectory of a linked worktree - 0 (the programmer's guard has the root only).
// Through the CLI (78/0) and the preconditions (env-check.js --worktree).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-checkout-layouts-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], { encoding: 'utf8' });
const cli = (d, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'main-checkout.js'), d],
  { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
const envCheck = (d) => {
  const y = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'env-check.js'), '--path', dir, '--min-disk-gb', '0', '--min-swap-gb', '0', '--worktree', d], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(y.stdout); } catch { /* below */ }
  return { y, refused: y.status === 1 && !!j && j.ok === false && j.problems.some((p) => p.includes(d)) };
};
const repo = (d) => { fs.mkdirSync(d, { recursive: true }); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', 'a.txt'); return git(d, 'commit', '-qm', 'base'); };
try {
  // separate git dir: <dir>/sep is the work tree, its .git is a file "gitdir: <dir>/sep.git"
  const sep = path.join(dir, 'sep');
  fs.mkdirSync(sep);
  let r = git(sep, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(dir, 'sep.git'));
  ok('fixture: --separate-git-dir gives a .git file', r.status === 0 && fs.statSync(path.join(sep, '.git')).isFile(), r.stderr);
  let x = cli(sep);
  ok('main copy with --separate-git-dir (.git is a file) -> 78', x.status === 78 && /main working copy/.test(x.stderr), `${x.status} ${x.stderr}`);
  let c = envCheck(sep);
  ok('env-check --worktree: main copy with --separate-git-dir -> refused', c.refused, c.y.stdout + c.y.stderr);

  const main = path.join(dir, 'main');
  r = repo(main);
  const linked = path.join(dir, 'wts', 'linked'), stale = path.join(dir, 'wts', 'stale');
  const w1 = git(main, 'worktree', 'add', '-q', '-b', 'b-linked', linked);
  const w2 = git(main, 'worktree', 'add', '-q', '-b', 'b-stale', stale);
  fs.mkdirSync(path.join(linked, 'deep'));
  ok('fixture: a repository with two linked worktrees', r.status === 0 && w1.status === 0 && w2.status === 0, r.stderr + w1.stderr + w2.stderr);

  x = cli(path.join(main, '.git'));
  ok('the .git directory of the main copy -> 78 (git fails there, .git above)', x.status === 78, `${x.status} ${x.stderr}`);

  fs.rmSync(path.join(main, '.git', 'worktrees', 'stale'), { recursive: true, force: true });
  x = cli(stale);
  ok('a linked worktree with a stale .git file (its gitdir removed) -> 78, closed', x.status === 78, `${x.status} ${x.stderr}`);
  c = envCheck(stale);
  ok('env-check --worktree: a stale linked worktree -> refused', c.refused, c.y.stdout + c.y.stderr);

  x = cli(linked);
  ok('control: the intact linked worktree -> 0', x.status === 0, `${x.status} ${x.stderr}`);

  // submodule: <dir>/super with submodule "mod" cloned from main
  const sup = path.join(dir, 'super');
  repo(sup);
  r = git(sup, 'submodule', 'add', '-q', main, 'mod');
  const mod = path.join(sup, 'mod');
  ok('fixture: a submodule with a .git file', r.status === 0 && fs.statSync(path.join(mod, '.git')).isFile(), r.stderr);
  x = cli(mod);
  ok('a submodule checkout (git-dir == common-dir under .git/modules) -> 78', x.status === 78 && /main working copy/.test(x.stderr), `${x.status} ${x.stderr}`);

  // a git without --path-format (before 2.31 it echoes the unknown option), on a subdirectory of a linked worktree
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(dir, 'bin-old'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in *" --path-format=absolute "*) echo --path-format=absolute ;; esac
for a in "$@"; do shift; [ "$a" = --path-format=absolute ] || set -- "$@" "$a"; done
exec '${realGit}' "$@"
`); fs.chmodSync(path.join(bin, 'git'), 0o755);
  const old = { PATH: bin + path.delimiter + process.env.PATH };
  x = cli(path.join(linked, 'deep'), old);
  ok('git without --path-format, subdirectory of a linked worktree -> 0', x.status === 0, `${x.status} ${x.stderr}`);
  x = cli(sep, old);
  ok('git without --path-format, main copy with --separate-git-dir -> 78', x.status === 78, `${x.status} ${x.stderr}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
