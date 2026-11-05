#!/usr/bin/env node
'use strict';
// p-codex-D1a tester: the cells of the use cases p-codex-D1 (UC-3 alternative flows and errors) on the Codex input that
// tests/hooks-codex.test.js does not cover. The input is the measured one of X-D (tool_name "Bash", tool_input
// {"command"}, an absolute top-level cwd, permission_mode "bypassPermissions", no CLAUDE_PROJECT_DIR in the hook's
// environment, the hook process in the session's directory).
//   T1  UC-3 1a: the other forms of a push the hook refuses (--all, --mirror, --follow-tags, refs/tags/, a refspec onto
//       main), also after a literal cd in the line
//   T2  UC-3 1b: the other moves of the arc under a live train (update-ref, branch -f / -D, reset to another commit,
//       merge, git -C <arc worktree>, cd <arc worktree> && commit from a cwd outside)
//   T3  UC-3 1b + inherited environment: a Codex role started from another project's session inherits its
//       CODIS_AGENTS_CONFIG; the train of the project the command works in still refuses (C11 on the Codex input)
//   T4  the live acceptance shape (brief, "After the analysis check"): a repository made with --separate-git-dir, the
//       config {"repoDir": "."} with relative sharedDir, a live lock on the current branch -> git commit refused,
//       git add -A refused, git add <path> allowed; the real hook process (hooks/hooks.json line) gives the deny JSON
//   T5  UC-3 3a: a repository without .claude/codis-agents.json up from the input's cwd -> silent on every command
//   T6  UC-3 3d / 4: the real process with an input the hook cannot judge (empty stdin, a JSON array, null, a non-string
//       command) exits 0 with an empty stdout, inside the timeout of hooks/hooks.json
// usage: node tests/hooks-codex-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { ok, done } = lib;
const { decide } = require('../scripts/hooks/guard-bash');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-codex-tester-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), outside = path.join(T, 'outside');
const wArc = path.join(wts, 'w-arc');
const home = path.join(T, 'home'), data = path.join(home, 'plugins', 'data', 'codis-agents-codis-agents');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const short = (r) => String(r).slice(0, 300);
const cenv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH,
  CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, CODEX_HOME: home };
const codexIn = (command, cwd) => ({ session_id: 's', turn_id: 't', transcript_path: path.join(home, 'sessions', 'r.jsonl'), cwd,
  hook_event_name: 'PreToolUse', model: 'gpt-6-luna', permission_mode: 'bypassPermissions', tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 'exec-1' });
const hook = (command, cwd, e = cenv) => { try { return decide(codexIn(command, cwd), e); } catch (x) { return 'CRASH ' + x.message; } };
const stage = (r) => typeof r === 'string' && /stage files by path/.test(r);
const pushRefused = (r) => typeof r === 'string' && /is refused/.test(r) && !/train/.test(r) && !/^CRASH/.test(r);
const trainRefused = (r) => typeof r === 'string' && /holds the train lock/.test(r);
const lockAt = (dir, base) => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (base) put(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: '20261105-170000000-4343', base }));
};
const hj = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const entry = (hj.hooks.PreToolUse || []).find((h) => h.matcher === 'Bash');
const line = entry ? entry.hooks[0].command : 'false';
const timeoutMs = entry ? entry.hooks[0].timeout * 1000 : 0;
const run = (input, cwd) => { const t0 = Date.now(); const r = spawnSync('sh', ['-c', line], { cwd, env: cenv, input, encoding: 'utf8' }); r.ms = Date.now() - t0; return r; };

const cwd0 = process.cwd();
try {
  for (const d of [main, wts, shared, outside, data]) fs.mkdirSync(d, { recursive: true });
  git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
  put(path.join(main, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
    protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
  put(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', 'a.txt', '.claude/codis-agents.json'); git(main, 'commit', '-qm', 'a');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'a2');   // the arc has a parent commit: reset HEAD~1 names one
  git(main, 'branch', 'arc'); git(main, 'branch', 'side'); git(main, 'checkout', '-q', '-b', 'feature');
  git(main, 'worktree', 'add', '-q', wArc, 'arc');
  fs.mkdirSync(path.join(main, 'sub'), { recursive: true });
  process.chdir(outside);   // the hook process runs in the session's directory (X-D item 4)

  console.log('T1. UC-3 1a: the other forms of a protected push on the Codex input');
  for (const c of ['git push --all origin', 'git push --mirror', 'git push origin main --follow-tags', 'git push origin refs/tags/v2',
    'git push origin HEAD:main', 'git push origin feature:refs/heads/main', 'cd sub && git push origin main', `git -C ${main} push origin main`])
    ok(`T1 refused: ${c}`, pushRefused(hook(c, main)), short(hook(c, main)));
  ok('T1 refused from a cwd outside: cd <repo> && git push origin main', pushRefused(hook(`cd ${main} && git push origin main`, outside)),
    short(hook(`cd ${main} && git push origin main`, outside)));
  ok('T1 allowed: git push origin feature:feature', hook('git push origin feature:feature', main) === null, short(hook('git push origin feature:feature', main)));

  console.log('T2. UC-3 1b: the other moves of the arc under a live train');
  lockAt(path.join(shared, 'train', 'lock'), 'arc');
  for (const [c, d] of [['git update-ref refs/heads/arc HEAD', main], ['git branch -f arc HEAD', main], ['git branch -D arc', main],
    ['git reset --hard HEAD~1', wArc], ['git merge side', wArc], [`git -C ${wArc} commit -m x`, outside],
    [`cd ${wArc} && git commit -m x`, outside], ['git commit -m x', path.join(wArc)]])
    ok(`T2 refused: ${c} (cwd ${path.relative(T, d)})`, trainRefused(hook(c, d)), short(hook(c, d)));
  for (const [c, d] of [['git reset --hard HEAD', wArc], ['git branch -f side HEAD', main], ['git commit -m x', main]])
    ok(`T2 allowed: ${c} (cwd ${path.relative(T, d)})`, hook(c, d) === null, short(hook(c, d)));

  console.log('T3. inherited CODIS_AGENTS_CONFIG of another project: the train of the project of the cwd still refuses');
  const pB = path.join(T, 'projB');
  fs.mkdirSync(pB); git(pB, 'init', '-q', '-b', 'main');
  const cfgB = path.join(pB, '.claude', 'codis-agents.json');
  put(cfgB, JSON.stringify({ repoDir: pB, worktreeRoot: path.join(T, 'wtsB'), sharedDir: path.join(T, 'sharedB'), protectedBranches: ['main'] }));
  const inh = Object.assign({}, cenv, { CODIS_AGENTS_CONFIG: cfgB, CLAUDE_CODE_SESSION_ID: 'x', CLAUDECODE: '1' });
  ok('T3 refused: git commit -m x in the arc worktree, CODIS_AGENTS_CONFIG = project B', trainRefused(hook('git commit -m x', wArc, inh)),
    short(hook('git commit -m x', wArc, inh)));
  ok('T3 refused: git branch -f arc HEAD in the main repository, CODIS_AGENTS_CONFIG = project B', trainRefused(hook('git branch -f arc HEAD', main, inh)),
    short(hook('git branch -f arc HEAD', main, inh)));
  ok('T3 allowed: git commit -m x in project B (no train there)', hook('git commit -m x', pB, inh) === null, short(hook('git commit -m x', pB, inh)));
  lockAt(path.join(shared, 'train', 'lock'), null);

  console.log('T4. the live acceptance shape: --separate-git-dir, repoDir ".", relative sharedDir');
  const acc = path.join(T, 'acc'), proj = path.join(acc, 'proj'), gdir = path.join(acc, 'git');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'arc', `--separate-git-dir=${gdir}`, proj], { encoding: 'utf8' });
  git(proj, 'config', 'core.hooksPath', '/dev/null');
  put(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: '.', worktreeRoot: '..', sharedDir: '../shared', protectedBranches: ['main'] }));
  put(path.join(proj, 'r.txt'), 'r\n');
  git(proj, 'add', 'r.txt', '.claude/codis-agents.json'); git(proj, 'commit', '-qm', 'r');
  put(path.join(proj, 'n.txt'), 'n\n');
  ok('T4 fixture: .git of the project is a file (separate git dir)', fs.statSync(path.join(proj, '.git')).isFile());
  ok('T4 refused: git add -A', stage(hook('git add -A', proj)), short(hook('git add -A', proj)));
  ok('T4 allowed: git add n.txt', hook('git add n.txt', proj) === null, short(hook('git add n.txt', proj)));
  ok('T4 allowed without a lock: git commit -m x', hook('git commit -m x', proj) === null, short(hook('git commit -m x', proj)));
  lockAt(path.join(acc, 'shared', 'train', 'lock'), 'arc');
  ok('T4 refused under the live lock on the current branch: git commit -m x', trainRefused(hook('git commit -m x', proj)), short(hook('git commit -m x', proj)));
  const rp = run(JSON.stringify(codexIn('git commit -m x', proj)), outside);
  let o = null; try { o = JSON.parse(rp.stdout); } catch { /* checked below */ }
  ok('T4 the real process: deny JSON naming the train lock, exit 0', rp.status === 0 && o && o.hookSpecificOutput.permissionDecision === 'deny' &&
    /^codis-agents: `git commit` is refused: .*holds the train lock/.test(o.hookSpecificOutput.permissionDecisionReason), short(rp.stdout + rp.stderr));
  lockAt(path.join(acc, 'shared', 'train', 'lock'), 'main');
  ok('T4 a live lock on another branch: git commit -m x allowed', hook('git commit -m x', proj) === null, short(hook('git commit -m x', proj)));
  // A dead holder (no such pid) is no train.
  fs.writeFileSync(path.join(acc, 'shared', 'train', 'lock', 'owner.json'), JSON.stringify({ pid: 2147483646, host: os.hostname(), since: new Date().toISOString(), train: 'x', base: 'arc' }));
  ok('T4 a dead holder of the lock on the branch: git commit -m x allowed', hook('git commit -m x', proj) === null, short(hook('git commit -m x', proj)));

  console.log('T5. UC-3 3a: no project config up from the cwd -> silent');
  const bare = path.join(T, 'plain');
  fs.mkdirSync(bare); git(bare, 'init', '-q', '-b', 'main');
  for (const c of ['git add -A', 'git push origin main', 'git push --tags', 'git commit -m x'])
    ok(`T5 allowed (no config): ${c}`, hook(c, bare) === null, short(hook(c, bare)));

  console.log('T6. UC-3 3d / 4: input the hook cannot judge -> exit 0, empty stdout, inside the timeout');
  ok('T6 hooks/hooks.json names a timeout', timeoutMs > 0, String(timeoutMs));
  const odd = { 'empty stdin': '', 'a JSON array': '[1,2]', 'null': 'null', 'a number': '42',
    'a non-string command': JSON.stringify(Object.assign(codexIn('x', main), { tool_input: { command: ['git', 'add', '-A'] } })),
    'no tool_input': JSON.stringify({ tool_name: 'Bash', cwd: main }) };
  for (const [n, s] of Object.entries(odd)) {
    const r = run(s, outside);
    ok(`T6 ${n}: exit 0, empty stdout, ${r.ms} ms < ${timeoutMs} ms`, r.status === 0 && r.stdout === '' && r.ms < timeoutMs, short(r.stdout + r.stderr));
  }
} finally {
  process.chdir(cwd0);
  fs.rmSync(T, { recursive: true, force: true });
}
done();
