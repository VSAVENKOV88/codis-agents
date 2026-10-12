#!/usr/bin/env node
'use strict';
// Hooks: the Claude Code PreToolUse hook (scripts/hooks/guard-bash.js, wired in hooks/hooks.json) and the git hooks
// (scripts/git-hooks/pre-push, pre-commit). Everything runs in temporary repositories with a temporary project config.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide, parse } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
const repo = path.join(dir, 'repo');
const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const env = { HOME: os.homedir(), PATH: process.env.PATH };   // no CODIS_AGENTS_CONFIG / CLAUDE_PROJECT_DIR leaking in
const cfg = { repoDir: repo, worktreeRoot: dir, sharedDir: dir, protectedBranches: ['main', 'release'], protectedTagPattern: '^v[0-9]',
  gitHooks: { blockICloudCopies: true, preCommit: [] } };
const writeCfg = (c) => { fs.mkdirSync(path.join(repo, '.claude'), { recursive: true }); fs.writeFileSync(path.join(repo, '.claude', 'codis-agents.json'), JSON.stringify(c)); };
const bash = (command, cwd = repo, e = env) => decide({ tool_name: 'Bash', tool_input: { command }, cwd }, e);

try {
  fs.mkdirSync(repo);
  g('init', '-q', '-b', 'feature'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', 'a.txt'); g('commit', '-qm', 'a'); g('tag', 'v1.0.0'); g('tag', 'nightly');

  console.log('1. PreToolUse hook (guard-bash.js)');
  ok('no project config -> hook inactive (git add -A allowed)', bash('git add -A') === null);
  writeCfg(cfg);
  ok('parser: quotes, &&, ;, pipes', JSON.stringify(parse(`a "b c" 'd;e' && f | g; h`)) === JSON.stringify([['a', 'b c', 'd;e'], ['f'], ['g'], ['h']]), JSON.stringify(parse(`a "b c" 'd;e' && f | g; h`)));
  for (const c of ['git add -A', 'git add --all', 'git add .', 'git add -- .', 'git -C sub add -A', 'cd x && git add -Av && git commit -m y', 'git add :/'])
    ok(`refused: ${c}`, /stage files by path/.test(bash(c) || ''), String(bash(c)));
  for (const c of ['git add src/a.js b.md', 'git add "notes 2.md"', 'echo "git add -A"', 'git commit -m "git add ."', 'git status'])
    ok(`allowed: ${c}`, bash(c) === null, String(bash(c)));
  for (const c of ['git push origin main', 'git push origin HEAD:main', 'git push origin +feature:refs/heads/main', 'git push -u origin release',
    'git push origin v1.2.3', 'git push origin refs/tags/v2', 'git push --tags', 'git push origin --follow-tags', 'git push --all origin', 'git push --mirror'])
    ok(`refused: ${c}`, /refused/.test(bash(c) || ''), String(bash(c)));
  for (const c of ['git push origin feature', 'git push -u origin feature', 'git push origin nightly', 'git push origin feature:feature-2', 'git push --force-with-lease origin feature', 'git push -o ci.skip origin feature'])
    ok(`allowed: ${c}`, bash(c) === null, String(bash(c)));
  ok('bare `git push` on the feature branch - allowed', bash('git push') === null);
  g('checkout', '-q', '-b', 'main');
  ok('bare `git push` on main - refused', /main is protected/.test(bash('git push') || ''), String(bash('git push')));
  ok('`git push origin HEAD` on main - refused', /refused/.test(bash('git push origin HEAD') || ''));
  ok('`git -C <repo> push` resolves the branch of that repo', /refused/.test(bash(`git -C ${repo} push`, dir) || ''));
  g('checkout', '-q', 'feature');
  ok('ALLOW_PROTECTED_PUSH=1 inline - allowed', bash('ALLOW_PROTECTED_PUSH=1 git push origin main') === null);
  ok('ALLOW_PROTECTED_PUSH=1 in the environment - allowed', bash('git push origin main', repo, Object.assign({}, env, { ALLOW_PROTECTED_PUSH: '1' })) === null);
  ok('ALLOW_PROTECTED_PUSH=0 - still refused', /refused/.test(bash('ALLOW_PROTECTED_PUSH=0 git push origin main') || ''));
  ok('other tools are ignored', decide({ tool_name: 'Edit', tool_input: { command: 'git add -A' }, cwd: repo }, env) === null);

  const hook = spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')],
    { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add .' }, cwd: repo }), encoding: 'utf8', env });
  let out = null; try { out = JSON.parse(hook.stdout); } catch { /* checked below */ }
  ok('CLI: deny decision as PreToolUse JSON, exit 0', hook.status === 0 && out && out.hookSpecificOutput.permissionDecision === 'deny' && out.hookSpecificOutput.hookEventName === 'PreToolUse', hook.stdout + hook.stderr);
  const hook2 = spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')],
    { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add a.txt' }, cwd: repo }), encoding: 'utf8', env });
  ok('CLI: allowed command - no output, exit 0', hook2.status === 0 && hook2.stdout === '', hook2.stdout);
  const hj = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const pre = hj.hooks.PreToolUse.find((h) => h.matcher === 'Bash');
  ok('hooks.json wires guard-bash.js on Bash through ${CLAUDE_PLUGIN_ROOT}', pre && pre.hooks[0].command === 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/guard-bash.js"', JSON.stringify(pre));

  console.log('2. git pre-push');
  const push = (lines, e = {}) => spawnSync(path.join(ROOT, 'scripts', 'git-hooks', 'pre-push'), ['origin', 'url'],
    { cwd: repo, input: lines.map((r) => `refs/heads/x ${'1'.repeat(40)} ${r} ${'0'.repeat(40)}`).join('\n') + '\n', encoding: 'utf8', env: Object.assign({}, env, e) });
  ok('push to main - refused', push(['refs/heads/main']).status === 1);
  ok('push to release (configured) - refused', push(['refs/heads/release']).status === 1);
  ok('tag v1.2.3 - refused', push(['refs/tags/v1.2.3']).status === 1);
  ok('tag nightly (does not match the pattern) - allowed', push(['refs/tags/nightly']).status === 0);
  ok('branch b-x - allowed', push(['refs/heads/b-x']).status === 0);
  ok('branch together with main - the whole push refused', push(['refs/heads/b-x', 'refs/heads/main']).status === 1);
  ok('ALLOW_PROTECTED_PUSH=1 - main allowed', push(['refs/heads/main'], { ALLOW_PROTECTED_PUSH: '1' }).status === 0);
  fs.rmSync(path.join(repo, '.claude'), { recursive: true });
  ok('no config - defaults: main refused', push(['refs/heads/main']).status === 1);
  ok('no config - defaults: release allowed', push(['refs/heads/release']).status === 0);

  console.log('3. git pre-commit');
  const commit = () => spawnSync(path.join(ROOT, 'scripts', 'git-hooks', 'pre-commit'), [], { cwd: repo, encoding: 'utf8', env });
  fs.writeFileSync(path.join(repo, 'notes 2.md'), 'x\n'); g('add', 'notes 2.md');
  ok('no config - iCloud copies not checked (option off by default)', commit().status === 0);
  writeCfg(cfg);
  let r = commit();
  ok('iCloud copy "notes 2.md" in the index - refused', r.status === 1 && /iCloud/.test(r.stderr), r.stderr);
  g('rm', '-q', '--cached', 'notes 2.md');
  fs.mkdirSync(path.join(repo, 'dir 3')); fs.writeFileSync(path.join(repo, 'dir 3', 'f.js'), 'x'); g('add', 'dir 3/f.js');
  r = commit(); ok('a directory "dir 3" - refused', r.status === 1, r.stderr);
  g('rm', '-q', '--cached', 'dir 3/f.js');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); g('add', 'b.txt');
  r = commit(); ok('clean index - allowed', r.status === 0, r.stderr);
  writeCfg(Object.assign({}, cfg, { gitHooks: { preCommit: ['test -f b.txt', 'exit 3'] } }));
  r = commit(); ok('preCommit command failing - refused with its command', r.status === 1 && /exit 3/.test(r.stderr), r.stderr);
  writeCfg(Object.assign({}, cfg, { gitHooks: { preCommit: ['test -f b.txt'] } }));
  r = commit(); ok('preCommit command passing (runs in the repository root) - allowed', r.status === 0, r.stderr);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
