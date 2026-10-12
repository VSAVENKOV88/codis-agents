#!/usr/bin/env node
'use strict';
// scripts/role-diff-check.js - the post-check of roles in role-chain: the tester may change only guards and their
// data, the reviewer nothing; the way of writing does not matter (commits and the working tree are checked); since
// not an ancestor of HEAD -> not ok.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { check } = require('../scripts/role-diff-check');
const { ok, done } = require('./lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-diff-'));
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const commit = (files, msg) => { for (const [f, s] of Object.entries(files)) write(f, s); git('add', ...Object.keys(files)); git('commit', '-qm', msg); return git('rev-parse', 'HEAD'); };

try {
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.hooksPath', '/dev/null');
  const base = commit({ 'src/a.ts': '1', 'services/x-run.js': '1' }, 'base');

  let r = check({ wt: dir, since: base, role: 'tester' });
  ok('no changes - ok', r.ok && r.offending.length === 0, JSON.stringify(r));

  const g = commit({ 'services/y-run.js': '1', 'src/z-run.mjs': '1', 'services/fixtures/f.json': '{}' }, 'guards');
  r = check({ wt: dir, since: base, role: 'tester' });
  ok('tester: guards and fixtures - ok', r.ok, JSON.stringify(r));

  r = check({ wt: dir, since: base, role: 'reviewer' });
  ok('reviewer: any commit - not ok', !r.ok && r.offending.length === 3, JSON.stringify(r));

  r = check({ wt: dir, since: base, role: 'tester', allow: ['\\.test\\.js$'] });
  ok('tester with a project allow-list: default guard names no longer allowed', !r.ok && r.offending.length === 3, JSON.stringify(r));

  commit({ 'src/a.ts': '2' }, 'product');
  r = check({ wt: dir, since: g, role: 'tester' });
  ok('tester committed a product file - not ok', !r.ok && r.offending.join() === 'src/a.ts', JSON.stringify(r));
  const h = git('rev-parse', 'HEAD');

  write('src/b.ts', '0'); git('add', 'src/b.ts'); git('commit', '-qm', 'b'); const h2 = git('rev-parse', 'HEAD');
  write('src/b.ts', 'changed without a commit (sed -i, python -c - all the same)');
  r = check({ wt: dir, since: h2, role: 'tester' });
  ok('uncommitted change of a tracked file - not ok', !r.ok && r.offending.join() === 'src/b.ts', JSON.stringify(r));
  git('checkout', '--', 'src/b.ts');

  write('scratch.log', 'guard run noise');
  r = check({ wt: dir, since: h2, role: 'reviewer' });
  ok('untracked noise - in untracked, verdict ok', r.ok && r.untracked.includes('scratch.log'), JSON.stringify(r));

  git('checkout', '-q', '-b', 'other', base); commit({ 'services/q-run.js': '1' }, 'other');
  r = check({ wt: dir, since: h, role: 'tester' });
  ok('since not an ancestor of HEAD - not ok', !r.ok && /not an ancestor/.test(r.error || ''), JSON.stringify(r));

  r = check({ wt: dir, since: base, role: 'programmer' });
  ok('unknown role - not ok', !r.ok, JSON.stringify(r));

  commit({ 'src/w-run.mjs': '1' }, 'mjs guard');
  const cli = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'role-diff-check.js'), '--wt', dir, '--since', base, '--role', 'tester', '--allow', '-run\\.js$'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(cli.stdout); } catch { /* checked below */ }
  ok('CLI: JSON on stdout, --allow honoured, exit 1 when not ok', cli.status === 1 && j && j.offending.join() === 'src/w-run.mjs', cli.stdout + cli.stderr);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
