#!/usr/bin/env node
'use strict';
// Tester guard p-main-wt: edges of the main working copy refusal in the preconditions (env-check.js --worktree) and the
// CLI of scripts/main-checkout.js that tests/main-checkout.test.js leaves out - a subdirectory and a symlink of the main
// copy are refused in the preconditions too; --main-checkout without --worktree changes nothing; bad usage is 64, never
// a silent pass; an environment variable is no override; a linked worktree's subdirectory passes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-checkout-edges-')));
const main = path.join(dir, 'main'), linked = path.join(dir, 'wts', 'linked'), link = path.join(dir, 'main link');
const g = (...a) => spawnSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const cli = (script, a, env) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...a],
  { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
const env = (a, e) => { const y = cli('env-check.js', ['--path', dir, '--min-disk-gb', '0', '--min-swap-gb', '0', ...a], e); let j = null; try { j = JSON.parse(y.stdout); } catch { /* below */ } return { y, j }; };
const refused = (e) => e.y.status === 1 && e.j && e.j.ok === false && e.j.problems.some((p) => /main working copy/.test(p) && /wt-setup\.sh/.test(p));
try {
  fs.mkdirSync(path.join(main, 'sub'), { recursive: true });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(main, 'sub', 'a.txt'), '1');
  g('add', 'sub/a.txt'); g('commit', '-qm', 'base');
  const w = g('worktree', 'add', '-q', '-b', 'b-linked', linked);
  fs.symlinkSync(main, link);
  ok('fixture: a repository with a linked worktree and a symlink to the main copy', w.status === 0 && fs.existsSync(path.join(link, 'sub', 'a.txt')), w.stderr);

  let e = env(['--worktree', path.join(main, 'sub')]);
  ok('env-check --worktree <subdirectory of main> -> refused', refused(e), e.y.stdout + e.y.stderr);
  e = env(['--worktree', link]);
  ok('env-check --worktree <symlink to main, name with a space> -> refused', refused(e), e.y.stdout + e.y.stderr);
  e = env(['--worktree', path.join(linked, 'sub')]);
  ok('env-check --worktree <subdirectory of a linked worktree> -> ok', e.y.status === 0 && e.j && e.j.ok, e.y.stdout + e.y.stderr);
  e = env(['--worktree', main], { MAIN_CHECKOUT: '1', CODIS_MAIN_CHECKOUT: '1' });
  ok('env-check: environment variables do not override the refusal', refused(e), e.y.stdout + e.y.stderr);
  e = env(['--main-checkout', '--worktree', main]);
  ok('env-check: --main-checkout before --worktree also passes', e.y.status === 0 && e.j && e.j.ok, e.y.stdout + e.y.stderr);
  e = env(['--main-checkout']);
  ok('env-check: --main-checkout without --worktree -> ok, nothing else changes', e.y.status === 0 && e.j && e.j.ok && e.j.problems.length === 0, e.y.stdout + e.y.stderr);
  e = env(['--worktree']);
  ok('env-check: --worktree without a directory -> usage, exit 64', e.y.status === 64, String(e.y.status) + e.y.stderr);
  e = env(['--worktree', '']);
  ok('env-check: --worktree with an empty directory -> usage, exit 64', e.y.status === 64, String(e.y.status) + e.y.stderr);

  let x = cli('main-checkout.js', [link]);
  ok('main-checkout.js: a symlink to main -> 78', x.status === 78 && /main working copy/.test(x.stderr), `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [path.join(linked, 'sub')]);
  ok('main-checkout.js: a subdirectory of a linked worktree -> 0', x.status === 0, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [main], { MAIN_CHECKOUT: '1', CODIS_MAIN_CHECKOUT: '1' });
  ok('main-checkout.js: environment variables do not override -> 78', x.status === 78, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [main, '--main-checkout']);
  ok('main-checkout.js: the flag after the directory -> 0', x.status === 0, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', ['--main-checkout']);
  ok('main-checkout.js: the flag alone -> usage 64, not a pass', x.status === 64, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [main, linked]);
  ok('main-checkout.js: two directories -> usage 64', x.status === 64, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', ['--force', main]);
  ok('main-checkout.js: an unknown option -> usage 64, not a pass', x.status === 64, `${x.status} ${x.stderr}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
