#!/usr/bin/env node
'use strict';
// p-codex-D1a: the session hook scripts/hooks/guard-bash.js judges the PreToolUse input of Codex CLI 0.166.0 as it
// judges the input of Claude Code (cells H1-H9 and D-1 of the analysis p-codex-D1). The Codex input is the measured one
// (experiment X-D): the model's shell is `exec_command`, the hook gets tool_name "Bash" and tool_input {"command":
// "<string>"} with no other key; the tool's workdir comes as the top-level cwd, already absolute, while the hook
// process's own working directory is the session's directory; permission_mode is "bypassPermissions" under
// `-s workspace-write`; the hook's environment has CLAUDE_PLUGIN_ROOT, PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, PLUGIN_DATA,
// CODEX_HOME and no CLAUDE_PROJECT_DIR.
//   H1  git add -A / --all / . / :/ refused, git add <path> allowed
//   H2  a push to a protected branch or of a protected tag refused, to a task branch allowed, ALLOW_PROTECTED_PUSH=1 allowed
//   H3  a commit in the arc's worktree under a live train lock refused, without the lock allowed
//   H4  Claude Code is unchanged: hooks/hooks.json and .claude-plugin/marketplace.json byte for byte as at the base 8c291fe
//   H5  the Codex environment: the project config is found from the input's cwd; CODIS_AGENTS_CONFIG still names it
//   H6  the real process, started by the command line of hooks/hooks.json through sh -c: the deny JSON, exit 0
//   H7  the input's cwd is judged, not the hook process's working directory
//   H8  the raw inputs of X-D, field for field
//   H9  apply_patch and MCP tools: the hook stays silent
//   D-1 README "Known gaps" names what the hook does not see under Codex
// usage: node tests/hooks-codex.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { ok, skip, done } = lib;
const { decide } = require('../scripts/hooks/guard-bash');

const ROOT = path.join(__dirname, '..');
const BASE = '8c291fe';
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-codex-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), outside = path.join(T, 'outside');
const wArc = path.join(wts, 'w-arc');
const home = path.join(T, 'home'), data = path.join(home, 'plugins', 'data', 'codis-agents-codis-agents');
const LOCK = path.join(shared, 'train', 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const short = (r) => String(r).slice(0, 300);

// The environment Codex gives the hook process (X-D item 6), with no CLAUDE_PROJECT_DIR and no CODIS_AGENTS_CONFIG.
const cenv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH,
  CLAUDE_PLUGIN_ROOT: ROOT, PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, CODEX_HOME: home,
  CODEX_MANAGED_BY_NPM: '1' };
// The PreToolUse input of Codex in the measured form (X-D "raw inputs": every field, in its order).
const codexIn = (command, cwd) => ({ session_id: '019a0000-0000-7000-8000-000000000001', turn_id: '019a0000-0000-7000-8000-000000000002',
  transcript_path: path.join(home, 'sessions', '2026', '11', '05', 'rollout-2026-11-05T16-44-00-019a0000.jsonl'), cwd,
  hook_event_name: 'PreToolUse', model: 'gpt-6-luna', permission_mode: 'bypassPermissions', tool_name: 'Bash',
  tool_input: { command }, tool_use_id: 'exec-019a0000-0000-7000-8000-000000000003' });
const bash = (command, cwd = main, e = cenv) => decide(codexIn(command, cwd), e);
const stage = (r) => typeof r === 'string' && /stage files by path/.test(r);
const pushRefused = (r) => typeof r === 'string' && /^`git push`? .*is refused/.test(r);
const trainRefused = (r) => typeof r === 'string' && /holds the train lock/.test(r);
const lock = (on) => {
  fs.rmSync(LOCK, { recursive: true, force: true });
  if (on) put(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString(),
    train: '20261105-164400000-4242', base: 'arc', wt: path.join(wts, 'train-20261105-164400000-4242') }));
};

const cwd0 = process.cwd();
try {
  for (const d of [main, wts, shared, outside, data]) fs.mkdirSync(d, { recursive: true });
  git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
  put(path.join(main, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
    protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
  put(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', 'a.txt', '.claude/codis-agents.json'); git(main, 'commit', '-qm', 'a');
  git(main, 'branch', 'arc'); git(main, 'checkout', '-q', '-b', 'feature');
  git(main, 'worktree', 'add', '-q', wArc, 'arc');
  put(path.join(main, 'b.txt'), 'b\n'); put(path.join(wArc, 'c.txt'), 'c\n');
  // The hook process runs in the session's directory, which is not the repository the command works in (X-D item 4).
  process.chdir(outside);

  console.log('H1. git add of everything, on the Codex input');
  for (const c of ['git add -A', 'git add --all', 'git add .', 'git add :/'])
    ok(`H1 refused: ${c}`, stage(bash(c)), short(bash(c)));
  ok('H1 allowed: git add a.txt', bash('git add a.txt') === null, short(bash('git add a.txt')));

  console.log('H2. pushes to protected branches and tags');
  for (const c of ['git push origin main', 'git push origin v1.2.3', 'git push --tags'])
    ok(`H2 refused: ${c}`, pushRefused(bash(c)), short(bash(c)));
  ok('H2 allowed: git push origin feature', bash('git push origin feature') === null, short(bash('git push origin feature')));
  ok('H2 allowed: ALLOW_PROTECTED_PUSH=1 git push origin main', bash('ALLOW_PROTECTED_PUSH=1 git push origin main') === null,
    short(bash('ALLOW_PROTECTED_PUSH=1 git push origin main')));

  console.log('H3. a commit of the arc under a live train');
  lock(true);
  ok('H3 refused: git commit -m x in the arc worktree, live lock naming arc', trainRefused(bash('git commit -m x', wArc)), short(bash('git commit -m x', wArc)));
  ok('H3 allowed: git commit -m x on the task branch under the same lock', bash('git commit -m x', main) === null, short(bash('git commit -m x', main)));
  lock(false);
  ok('H3 allowed: git commit -m x in the arc worktree, no lock', bash('git commit -m x', wArc) === null, short(bash('git commit -m x', wArc)));

  console.log('H4. Claude Code unchanged: the wiring files as at the base');
  const at = (f) => spawnSync('git', ['-C', ROOT, 'show', `${BASE}:${f}`], { encoding: 'buffer' });
  if (spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${BASE}^{commit}`]).status !== 0) {
    skip('H4 hooks/hooks.json and .claude-plugin/marketplace.json as at the base', `the base ${BASE} is not in this clone`);
  } else {
    for (const f of ['hooks/hooks.json', '.claude-plugin/marketplace.json']) {
      const r = at(f);
      ok(`H4 ${f} byte for byte as at ${BASE}`, r.status === 0 && Buffer.compare(r.stdout, fs.readFileSync(path.join(ROOT, f))) === 0);
    }
  }

  console.log('H5. the Codex environment');
  ok('H5 no CLAUDE_PROJECT_DIR / CODIS_AGENTS_CONFIG in the Codex environment of this test',
    !('CLAUDE_PROJECT_DIR' in cenv) && !('CODIS_AGENTS_CONFIG' in cenv));
  ok('H5 the config is found from the input cwd: git add -A refused', stage(bash('git add -A')), short(bash('git add -A')));
  ok('H5 the same input in a directory with no project config: allowed', bash('git add -A', outside) === null, short(bash('git add -A', outside)));
  // A config named by CODIS_AGENTS_CONFIG (inherited from the parent's environment) protects another branch.
  const other = path.join(T, 'other-config.json');
  put(other, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['stable'] }));
  const oenv = Object.assign({}, cenv, { CODIS_AGENTS_CONFIG: other });
  ok('H5 CODIS_AGENTS_CONFIG names the config: git push origin stable refused', pushRefused(bash('git push origin stable', main, oenv)),
    short(bash('git push origin stable', main, oenv)));
  ok('H5 without it the same push is allowed (the project config protects main only)', bash('git push origin stable') === null,
    short(bash('git push origin stable')));

  console.log('H6. the real hook process, started by the line of hooks/hooks.json');
  const hj = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const pre = (hj.hooks.PreToolUse || []).filter((h) => h.matcher === 'Bash');
  ok('H6 one PreToolUse entry with matcher Bash, one command hook, timeout 10',
    pre.length === 1 && pre[0].hooks.length === 1 && pre[0].hooks[0].type === 'command' && pre[0].hooks[0].timeout === 10, JSON.stringify(pre));
  const line = pre.length ? pre[0].hooks[0].command : 'false';
  const run = (input, cwd) => spawnSync('sh', ['-c', line], { cwd, env: cenv, input, encoding: 'utf8' });
  const deny = run(JSON.stringify(codexIn('git add -A', main)), outside);
  let out = null; try { out = JSON.parse(deny.stdout); } catch { /* checked below */ }
  const h = out && out.hookSpecificOutput;
  ok('H6 refused: exit 0, stdout one JSON {hookSpecificOutput: PreToolUse, deny, "codis-agents: ..."}',
    deny.status === 0 && out && Object.keys(out).join() === 'hookSpecificOutput' && h.hookEventName === 'PreToolUse' &&
    h.permissionDecision === 'deny' && /^codis-agents: `git add -A` is refused: stage files by path/.test(h.permissionDecisionReason || ''),
    short(deny.stdout + deny.stderr));
  const allow = run(JSON.stringify(codexIn('git status', main)), outside);
  ok('H6 allowed: exit 0, empty stdout', allow.status === 0 && allow.stdout === '', short(allow.stdout + allow.stderr));
  const broken = run('{"tool_name":"Bash","tool_input":', outside);
  ok('H6 broken stdin: exit 0, empty stdout', broken.status === 0 && broken.stdout === '', short(broken.stdout + broken.stderr));
  lock(true);
  const trainP = run(JSON.stringify(codexIn('git commit -m x', wArc)), outside);
  let tout = null; try { tout = JSON.parse(trainP.stdout); } catch { /* checked below */ }
  ok('H6 refused by the train lock through the real process', trainP.status === 0 && tout &&
    tout.hookSpecificOutput.permissionDecision === 'deny' && trainRefused(tout.hookSpecificOutput.permissionDecisionReason), short(trainP.stdout + trainP.stderr));
  lock(false);

  console.log('H7. the input cwd is judged, not the hook process directory');
  lock(true);
  ok('H7 process.cwd() is outside any repository', process.cwd() === outside);
  ok('H7 cwd = arc worktree under the lock: git commit -m x refused', trainRefused(bash('git commit -m x', wArc)), short(bash('git commit -m x', wArc)));
  ok('H7 cwd = main repository: git add -A refused', stage(bash('git add -A', main)), short(bash('git add -A', main)));
  ok('H7 cwd = a directory outside the repository: git commit -m x allowed', bash('git commit -m x', outside) === null, short(bash('git commit -m x', outside)));
  // The workdir of the tool, a subdirectory, arrives as the absolute cwd.
  fs.mkdirSync(path.join(wArc, 'sub'), { recursive: true });
  ok('H7 cwd = a subdirectory of the arc worktree: git commit -m x refused', trainRefused(bash('git commit -m x', path.join(wArc, 'sub'))));
  // The session is in the arc worktree, the tool's workdir is the main repository on the task branch.
  process.chdir(wArc);
  ok('H7 process.cwd() = arc worktree, cwd = main repository: git commit -m x allowed', bash('git commit -m x', main) === null, short(bash('git commit -m x', main)));
  process.chdir(outside);
  lock(false);

  console.log('H8. the raw inputs of X-D');
  const S = T, proj = path.join(S, 'proj');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  git(proj, 'init', '-q', '-b', 'main');
  put(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ protectedBranches: ['main'] }));
  const raw = (cwd, command) => `{"session_id":"019a0000","turn_id":"019a0001","transcript_path":"${path.join(home, 'sessions', 'rollout-019a.jsonl')}","cwd":"${cwd}","hook_event_name":"PreToolUse","model":"gpt-6-luna","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":${JSON.stringify(command)}},"tool_use_id":"exec-019a0002"}`;
  const rawCases = [[proj, 'pwd', null], [proj, 'git status', null], [path.join(proj, 'sub'), 'ls', null],
    [path.join(proj, 'sub'), 'git status --', null], [proj, 'cd sub && git log --oneline -1', null], [proj, 'git add -A', 'deny']];
  for (const [cwd, command, want] of rawCases) {
    const input = JSON.parse(raw(cwd, command));
    const r = decide(input, cenv);
    ok(`H8 raw input (cwd ${path.relative(S, cwd)}): ${command} -> ${want || 'allowed'}`, want ? stage(r) : r === null, short(r));
  }
  const rp = run(raw(proj, 'git add -A'), outside);
  ok('H8 raw input of `git add -A` through the real process: deny', /"permissionDecision":"deny"/.test(rp.stdout) && rp.status === 0, short(rp.stdout + rp.stderr));

  console.log('H9. other tools: the hook stays silent');
  const patch = '*** Begin Patch\n*** Add File: run.sh\n+git add -A\n+git push origin main\n*** End Patch\n';
  for (const tool of ['apply_patch', 'mcp__x__y']) {
    const input = Object.assign(codexIn(patch, main), { tool_name: tool });
    ok(`H9 ${tool} with tool_input.command holding "git add -A" -> allowed`, decide(input, cenv) === null, short(decide(input, cenv)));
    const input2 = Object.assign(codexIn('git add -A', main), { tool_name: tool });
    ok(`H9 ${tool} with tool_input.command "git add -A" -> allowed`, decide(input2, cenv) === null, short(decide(input2, cenv)));
  }
  const pp = run(JSON.stringify(Object.assign(codexIn('git add -A', main), { tool_name: 'apply_patch' })), outside);
  ok('H9 apply_patch through the real process: exit 0, empty stdout', pp.status === 0 && pp.stdout === '', short(pp.stdout + pp.stderr));

  console.log('D-1. README "Known gaps" names what the hook does not see under Codex');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const gi = readme.indexOf('\n## Known gaps\n');
  const rest = gi < 0 ? '' : readme.slice(gi + 1);
  const end = rest.slice(3).search(/\n## /);
  const gaps = end < 0 ? rest : rest.slice(0, end + 3);
  const cx = gaps.split('\n- ').filter((b) => /Codex/.test(b)).join('\n- ');
  ok('D-1 a gap names write_stdin into an open terminal (no PreToolUse)', /write_stdin/.test(cx) && /PreToolUse/.test(cx), '');
  ok('D-1 a gap names the user\'s own shell commands (`!`) that the hook does not see', /`!`/.test(cx), '');
  ok('D-1 a gap names the hook as fail-open (no node, the timeout, an exception)', /fail-open/.test(cx) && /node/.test(cx) && /timeout/.test(cx), '');
  ok('D-1 a gap names the trust that Codex resets at every change of the plugin (/hooks)', /\/hooks/.test(cx) && /trust/.test(cx), '');
  ok('D-1 a gap says the role chain does not run on Codex yet', /chain/.test(cx), '');
} finally {
  process.chdir(cwd0);
  fs.rmSync(T, { recursive: true, force: true });
}
done();
