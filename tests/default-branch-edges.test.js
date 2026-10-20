#!/usr/bin/env node
'use strict';
// Edges of the default branch from git (u2b-1, tester): only the remote "origin" is read (a clone with -o upstream is
// unknown, not guessed); a nested name keeps its slashes; while unknown the hook refuses every form of a branch push
// (bare git push, HEAD:refs/heads/x, --delete) but not an existing unprotected tag; an explicit defaultBranch protects
// a repository without a remote; a linked worktree reads origin/HEAD of its repository; a relative repoDir "." is the
// project root; a real `git push` through core.hooksPath is refused for the default branch and let through for others.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-edges-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const cli = (args, cwd = dir, e = {}) => spawnSync('node', [path.join(ROOT, 'scripts', 'config.js'), ...args], { cwd, encoding: 'utf8', env: Object.assign({}, env, e) });
const json = (f) => { const r = cli(['json', f]); try { return JSON.parse(r.stdout); } catch { return { status: r.status, err: r.stderr }; } };
// A throw in the hook is not a refusal: Claude Code runs the command after a hook that exits 1 (fail open).
const bash = (command, cwd, cfg) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {})); } catch (e) { return 'CRASH ' + e.message; } };
const unknownRe = /protected branches unknown/;

try {
  const seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'master'); ident(seed); commit(seed, 'a.txt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(seed, 'push', '-q', origin, 'master');

  console.log('Only origin is read');
  const up = path.join(dir, 'up');
  spawnSync('git', ['clone', '-q', '-o', 'upstream', origin, up]); ident(up); git(up, 'branch', 'b-t1');
  ok('setup: clone -o upstream has refs/remotes/upstream/HEAD and no origin/HEAD',
    git(up, 'symbolic-ref', '-q', 'refs/remotes/upstream/HEAD').status === 0 && git(up, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0);
  const upCfg = cfgFile('up', { repoDir: up });
  let j = json(upCfg);
  ok('remote upstream only: defaultBranch unknown (not guessed from upstream)', j.defaultBranch === null && j.protectedBranches === null, JSON.stringify(j));
  let r = cli(['default-branch', upCfg]);
  ok('remote upstream only: config.js default-branch exits 78 with the fix', r.status === 78 && /defaultBranch/.test(r.stdout), `${r.status} ${r.stdout}`);
  ok('remote upstream only: hook refuses git push upstream b-t1', unknownRe.test(bash('git push upstream b-t1', up, upCfg) || ''));
  const upKey = cfgFile('upkey', { repoDir: up, defaultBranch: 'master' });
  ok('remote upstream + defaultBranch master: master refused, b-t1 allowed',
    /master is protected/.test(bash('git push upstream master', up, upKey) || '') && bash('git push upstream b-t1', up, upKey) === null);

  console.log('A nested default branch name');
  const nested = path.join(dir, 'nested.git'), nc = path.join(dir, 'nc');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'team/trunk', nested]);
  git(seed, 'push', '-q', nested, 'master:team/trunk');
  spawnSync('git', ['clone', '-q', nested, nc]); ident(nc); git(nc, 'branch', 'b-t1');
  j = json(cfgFile('nested', { repoDir: nc }));
  ok('origin/HEAD -> origin/team/trunk: defaultBranch team/trunk', j.defaultBranch === 'team/trunk' && JSON.stringify(j.protectedBranches) === '["team/trunk"]', JSON.stringify(j));

  console.log('Every form of a branch push while unknown');
  const norem = path.join(dir, 'norem');
  fs.mkdirSync(norem); git(norem, 'init', '-q', '-b', 'master'); ident(norem); commit(norem, 'a.txt');
  git(norem, 'branch', 'b-t1'); git(norem, 'tag', 'build-1'); git(norem, 'tag', 'v1.0');
  const unk = cfgFile('unk', { repoDir: norem });
  for (const c of ['git push', 'git push origin', 'git push origin HEAD:refs/heads/x', 'git push origin b-t1:feature',
    'git push origin --delete b-t1', 'git push -u origin b-t1', 'git push origin +b-t1']) {
    ok(`unknown: "${c}" refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  ok('unknown: an existing tag outside protectedTagPattern is not a branch push - allowed', bash('git push origin build-1', norem, unk) === null, String(bash('git push origin build-1', norem, unk)));
  ok('unknown: a protected tag stays refused as a tag (no crash: a crash lets the push through)', /tag v1.0 is refused/.test(bash('git push origin v1.0', norem, unk) || ''), String(bash('git push origin v1.0', norem, unk)));
  const keyed = cfgFile('keyed', { repoDir: norem, defaultBranch: 'master' });
  ok('no remote + defaultBranch master: hook protects master, lets b-t1 through',
    /master is protected/.test(bash('git push origin master', norem, keyed) || '') && bash('git push origin b-t1', norem, keyed) === null);
  r = cli(['check', keyed]);
  ok('no remote + defaultBranch master: check ok without the note', r.status === 0 && !/note:/.test(r.stderr), r.stderr);

  console.log('Linked worktree and a relative repoDir');
  const proj = path.join(dir, 'proj');
  spawnSync('git', ['clone', '-q', origin, proj]); ident(proj); git(proj, 'branch', 'b-t1');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: '.', worktreeRoot: '..', sharedDir: '..' }));
  r = cli(['default-branch'], proj);
  ok('repoDir "." in .claude/codis-agents.json: default branch master from the project root', r.status === 0 && r.stdout.trim() === 'master', `${r.status} ${r.stdout}${r.stderr}`);
  r = cli(['default-branch', path.join(proj, '.claude', 'codis-agents.json')], dir);
  ok('repoDir "." resolved from the project root, not from the cwd (run outside any repository)', r.status === 0 && r.stdout.trim() === 'master', `${r.status} ${r.stdout}${r.stderr}`);
  const lw = path.join(dir, 'lw');
  git(proj, 'worktree', 'add', '-q', '-b', 'b-lw', lw, 'master');
  ok('linked worktree: hook (project config found through the main checkout) refuses git push origin master',
    /master is protected/.test(bash('git push origin master', lw) || ''), String(bash('git push origin master', lw)));
  ok('linked worktree: hook lets git push origin b-lw through', bash('git push origin b-lw', lw) === null, String(bash('git push origin b-lw', lw)));

  console.log('A real git push through core.hooksPath');
  ident(lw); commit(lw, 'lw.txt');   // something new to push, or git skips the hook ("Everything up-to-date")
  git(proj, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  let p = spawnSync('git', ['-C', lw, 'push', 'origin', 'HEAD:master'], { encoding: 'utf8', env });
  ok('git push origin HEAD:master from the linked worktree refused by pre-push', p.status !== 0 && /push to master is blocked/.test(p.stderr), p.stderr);
  p = spawnSync('git', ['-C', lw, 'push', '-q', 'origin', 'b-lw'], { encoding: 'utf8', env });
  ok('git push origin b-lw goes through', p.status === 0 && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/b-lw').status === 0, p.stderr);
  git(norem, 'remote', 'add', 'origin', origin);
  git(norem, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  ok('setup: norem has an origin remote but no origin/HEAD', git(norem, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0);
  p = spawnSync('git', ['-C', norem, 'push', 'origin', 'b-t1'], { encoding: 'utf8', env });
  ok('no origin/HEAD, no config: real git push origin b-t1 refused with the reason', p.status !== 0 && unknownRe.test(p.stderr)
    && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/b-t1').status !== 0, p.stderr);
  git(proj, 'worktree', 'remove', '--force', lw);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
