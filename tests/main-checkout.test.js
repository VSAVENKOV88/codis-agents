#!/usr/bin/env node
'use strict';
// scripts/main-checkout.js: a directory is the MAIN working copy when git rev-parse gives the same --git-dir and
// --git-common-dir (a linked worktree has its own git-dir under <common>/worktrees/<name>). guards-all.sh and the
// preconditions (env-check.js --worktree) refuse a main working copy with 78: its ignored data (a measurement corpus)
// is the only original, worktrees hold clones (wt-setup.sh); a guard run there once wiped it. --main-checkout passes.
// Matrix of the brief: main -> refused, linked worktree -> passes, main with --main-checkout -> passes; also a
// subdirectory of the main checkout (refused) and a directory outside git (passes: nothing to protect from git's view).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'main-checkout-')));
const main = path.join(dir, 'main'), linked = path.join(dir, 'wts', 'linked'), plain = path.join(dir, 'plain');
const g = (...a) => spawnSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const cli = (script, a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...a], { encoding: 'utf8' });
try {
  fs.mkdirSync(path.join(main, 'sub'), { recursive: true }); fs.mkdirSync(plain);
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(main, 'sub', 'a.txt'), '1');
  g('add', 'sub/a.txt'); g('commit', '-qm', 'base');
  const w = g('worktree', 'add', '-q', '-b', 'b-linked', linked);
  ok('fixture: a repository with a linked worktree', w.status === 0 && fs.existsSync(path.join(linked, 'sub', 'a.txt')), w.stderr);

  const { mainCheckout } = require('../scripts/main-checkout');
  let r = mainCheckout(main);
  ok('main working copy -> main: true, the root named', r.main === true && r.root === main, JSON.stringify(r));
  r = mainCheckout(path.join(main, 'sub'));
  ok('a subdirectory of the main working copy -> main: true (same git-dir)', r.main === true && r.root === main, JSON.stringify(r));
  r = mainCheckout(linked);
  ok('linked worktree -> main: false', r.main === false, JSON.stringify(r));
  r = mainCheckout(plain);
  ok('a directory outside git -> main: false (not a working copy at all)', r.main === false, JSON.stringify(r));

  let x = cli('main-checkout.js', [main]);
  ok('CLI: main working copy -> exit 78, the reason, the path, wt-setup.sh and --main-checkout named',
    x.status === 78 && x.stderr.includes(main) && /main working copy/.test(x.stderr) && /wt-setup\.sh/.test(x.stderr) && /--main-checkout/.test(x.stderr), `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', [linked]);
  ok('CLI: linked worktree -> exit 0, silent', x.status === 0 && !x.stderr && !x.stdout, `${x.status} ${x.stdout}${x.stderr}`);
  x = cli('main-checkout.js', ['--main-checkout', main]);
  ok('CLI: main working copy with --main-checkout -> exit 0', x.status === 0, `${x.status} ${x.stderr}`);
  x = cli('main-checkout.js', []);
  ok('CLI: no directory -> usage, exit 64', x.status === 64, String(x.status));

  // The preconditions: env-check.js --worktree <dir> adds the refusal to its problems (the floors pass at 0).
  const env = (a) => { const y = cli('env-check.js', ['--path', dir, '--min-disk-gb', '0', '--min-swap-gb', '0', ...a]); let j = null; try { j = JSON.parse(y.stdout); } catch { /* below */ } return { y, j }; };
  let e = env(['--worktree', main]);
  ok('env-check --worktree <main> -> exit 1, the problem names the main working copy and wt-setup.sh',
    e.y.status === 1 && e.j && e.j.problems.some((p) => p.includes(main) && /main working copy/.test(p) && /wt-setup\.sh/.test(p)), e.y.stdout + e.y.stderr);
  e = env(['--worktree', linked]);
  ok('env-check --worktree <linked> -> ok', e.y.status === 0 && e.j && e.j.ok, e.y.stdout + e.y.stderr);
  e = env(['--worktree', main, '--main-checkout']);
  ok('env-check --worktree <main> --main-checkout -> ok', e.y.status === 0 && e.j && e.j.ok, e.y.stdout + e.y.stderr);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The docs name the refusal and its flag (README scripts table and the rule in Machine and environment).
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
ok('README: guards-all.sh row names the main working copy refusal and --main-checkout', /\| `scripts\/guards-all\.sh` \|[^\n]*main working copy[^\n]*--main-checkout/.test(read('README.md')));
ok('README: scripts table names main-checkout.js', /\| `scripts\/main-checkout\.js` \|/.test(read('README.md')));
const machine = read('rules/multi-agent.md').split('## Machine and environment')[1].split('\n## ')[0];
ok('rules, Machine and environment: the main working copy refusal and --main-checkout', /main working copy[^\n]*--main-checkout/.test(machine));
done();
