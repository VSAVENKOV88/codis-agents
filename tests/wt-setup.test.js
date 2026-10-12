#!/usr/bin/env node
'use strict';
// scripts/wt-setup.sh: creates <worktreeRoot>/<name> on a new branch; ignored data under worktreeSetup.scan is cloned
// (a real copy - writes in the worktree must not reach the main checkout), "link" globs are symlinked, "skip" globs
// are left out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setup-')));
const main = path.join(dir, 'main');
const g = (...a) => spawnSync('git', ['-C', main, ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); };
try {
  fs.mkdirSync(main);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  put('.gitignore', 'node_modules\ndata/\n.DS_Store\nout.log\n'); put('app/src.js', '1');
  g('add', '.gitignore', 'app/src.js'); g('commit', '-qm', 'base');
  put('app/node_modules/m.js', 'mod'); put('app/data/corpus.json', '{"a":1}'); put('app/.DS_Store', 'x'); put('app/out.log', 'log'); put('other/data/x', 'not scanned');
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: main, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir,
    worktreeSetup: { scan: ['app'], skip: ['*.DS_Store'], link: ['*/node_modules'] } }));
  const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'wt-setup.sh'), 't1', 'b-t1'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfg }) });
  const wt = path.join(dir, 'wts', 't1');
  ok('worktree created and reported', r.status === 0 && r.stdout.includes('ready ' + wt), r.stdout + r.stderr);
  ok('on the new branch', spawnSync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim() === 'b-t1');
  const nm = path.join(wt, 'app', 'node_modules');
  ok('"link" glob -> symlink to the main checkout', fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink() && fs.readlinkSync(nm) === path.join(main, 'app', 'node_modules'));
  const data = path.join(wt, 'app', 'data');
  ok('other ignored data -> a real copy, not a link', fs.existsSync(data) && !fs.lstatSync(data).isSymbolicLink() && fs.readFileSync(path.join(data, 'corpus.json'), 'utf8') === '{"a":1}');
  fs.writeFileSync(path.join(data, 'corpus.json'), 'changed in the worktree');
  ok('a write in the worktree copy does not reach the main checkout', fs.readFileSync(path.join(main, 'app', 'data', 'corpus.json'), 'utf8') === '{"a":1}');
  ok('ignored file copied too', fs.readFileSync(path.join(wt, 'app', 'out.log'), 'utf8') === 'log');
  ok('"skip" glob -> not copied', !fs.existsSync(path.join(wt, 'app', '.DS_Store')));
  ok('directories outside "scan" -> not copied', !fs.existsSync(path.join(wt, 'other')));
} finally {
  spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', path.join(dir, 'wts', 't1')]);
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
