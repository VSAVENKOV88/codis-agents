#!/usr/bin/env node
'use strict';
// p-sec F7, tester: cells next to hooks-sec-globals. (1) every refused spelling with global options before the
// subcommand is first run by the real git, which must move refs/remotes/origin/HEAD (the cell is reachable), then judged
// by the session hook, which must refuse it: several value options in a row, a value option whose value is the word of
// a terminal option (git --namespace --version remote set-head: git takes --version as the namespace and runs set-head,
// so the hook must not stop at it), an empty --exec-path=, a working directory inside .git and --bare. (2) A terminal
// option after other options leaves origin/HEAD and is allowed. (3) README "Known gaps" names every form left open
// (owner 2026-10-21, answers 30-34): the shell grammar (F1-F6, F8), env with options (F9), exec, eval, $G, aliases and
// functions of the profile, git branch -dr origin/HEAD, a push with an expansion. (4) The shell's prefixes before git
// (p-noghost-e2): refused by the hook and not listed as open; the forms still open are allowed and listed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hook = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-globals-cells-')));
const env = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const decide = (command, cwd) => { try { return hook.decide({ tool_name: 'Bash', tool_input: { command }, cwd }, env); } catch (e) { return 'CRASH ' + e.message; } };
const refused = (w) => typeof w === 'string' && /refused/.test(w) && !/^CRASH/.test(w);

try {
  const origin = path.join(dir, 'origin.git'), proj = path.join(dir, 'proj');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, proj], { encoding: 'utf8' });
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.hooksPath', '/dev/null']]) git(proj, 'config', k, v);
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(proj, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/feat');
  git(proj, 'fetch', '-q', 'origin');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: proj, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));
  const head = () => git(proj, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').stdout.trim();
  const reset = () => git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const TRUNK = 'refs/remotes/origin/trunk';
  // Runs the line's words with the real git (no shell: the words are written without quotes) -> origin/HEAD after it.
  const real = (c, cwd) => {
    reset();
    const w = c.split(' ');
    spawnSync(w[0], w.slice(1), { cwd, encoding: 'utf8', input: '', env: Object.assign({}, process.env, { GIT_PAGER: 'cat', PAGER: 'cat', MANPAGER: 'cat' }) });
    const h = head();
    reset();
    return h;
  };
  const dotgit = path.join(proj, '.git');

  console.log('1. Spellings git runs and the hook must refuse (git moves origin/HEAD, the hook refuses)');
  for (const [c, cwd] of [
    ['git --attr-source HEAD --shallow-file x -c a.b=c --namespace n remote set-head origin feat', proj],
    ['git -c a.b=c --config-env a.c=HOME --attr-source=HEAD symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat', proj],
    ['git --namespace --version remote set-head origin feat', proj],
    ['git --namespace --help remote set-head origin feat', proj],
    ['git --attr-source --exec-path remote set-head origin feat', proj],
    ['git -c a.b=c --namespace --list-cmds=main remote set-head origin feat', proj],
    ['git --exec-path= remote set-head origin feat', proj],
    ['git --exec-path=/nonexistent --shallow-file x remote set-head origin feat', proj],
    ['git --work-tree . --attr-source HEAD remote set-head origin feat', proj],
    ['git remote set-head origin feat', dotgit],
    ['git --bare remote set-head origin feat', dotgit],
    ['git -C .git --bare --attr-source HEAD remote set-head origin feat', proj],
  ]) {
    const where = cwd === dotgit ? ' (in .git)' : '';
    const h = real(c, cwd);
    ok(`git moves origin/HEAD: ${c}${where}`, h === 'refs/remotes/origin/feat', h);
    const w = decide(c, cwd);
    ok(`refused: ${c}${where}`, refused(w), String(w));
  }

  console.log('2. A terminal option after other options: git runs nothing, the hook allows it');
  for (const c of [
    'git -c a.b=c --version remote set-head origin feat',
    'git --attr-source HEAD -h remote set-head origin feat',
    'git --namespace x --exec-path remote set-head origin feat',
    'git --no-pager --list-cmds=main remote set-head origin feat',
  ]) {
    const h = real(c, proj);
    ok(`git leaves origin/HEAD: ${c}`, h === TRUNK, h);
    ok(`allowed: ${c}`, decide(c, proj) === null, String(decide(c, proj)));
  }

  console.log('3. README "Known gaps" names every form left open (owner 2026-10-21, answers 30-34)');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const m = readme.match(/\n## Known gaps\n([\s\S]*?)(\n## |$)/);
  const gaps = m ? m[1].replace(/\s+/g, ' ') : '';
  ok('README has a section Known gaps', gaps.length > 0);
  for (const [cell, re] of [
    ['F2 zsh repeat 1 git', /repeat 1 git/], ['F2 {git', /\{git/], ['command -p git', /`command -p git`/],
    ['the shell prefixes judged for every rule of the hook (p-noghost-e2)', /prefixes of a command[^.]*are judged by every rule/],
    ['F3 a redirection before or between the words', /redirection/], ['F3 2>/dev/null git', /2>\/dev\/null git/], ['F3 &>', /&>\/dev\/null/],
    ['F4 a line continuation', /line continuation/],
    ['F5 $\'...\' with escapes', /\$'\\x73et-head'/], ['F5 $"..."', /\$"\.\.\."/],
    ['F6 backquotes', /backquotes/],
    ['F8 an expansion in the subcommand or its arguments', /expansion in the subcommand/], ['F8 $(...)', /\$\(printf set-head\)/],
    ['F9 env -i', /env -i/], ['F9 env -u', /env -u/],
    ['exec', /`exec`/], ['eval', /`eval`/], ['$G in the place of the command', /\$G/],
    ['aliases and functions of the profile', /aliases and functions of the user's shell profile/],
    ['git branch -dr origin/HEAD', /git branch -dr origin\/HEAD/],
    ['a push with an expansion stays allowed', /git push origin "\$BRANCH"/],
    ['the second layer: task p-head2', /p-head2/], ['the shell grammar: task p-shell', /p-shell/],
    ['the table of global options, fail closed', /GIT_GLOBAL/],
  ]) ok(`Known gaps names ${cell}`, re.test(gaps));

  // p-noghost-e2 (coordinator's decision A, 2026-10-31): the shell's prefixes of a command (CD_PREFIX of guard-bash.js:
  // reserved words, command, builtin, noglob, nocorrect, time [-p]) are taken off before git for every rule, so these
  // forms are refused and the lists of open forms (the wrappers and the lexer paragraphs) must not name them; the
  // forms the hook still does not see as git (zsh repeat 1 git, {git ...}, command -p git) are allowed and named.
  console.log('4. Shell prefixes before git: refused and not listed as open; the forms left open: allowed and listed');
  const span = (from, to) => { const a = gaps.indexOf(from); const b = a < 0 ? -1 : gaps.indexOf(to, a); return a < 0 || b < 0 ? '' : gaps.slice(a, b); };
  const open = span('The session hook reads the command line as written', 'pass it.') + ' ' + span('splits a line by its own small lexer', 'To be closed');
  ok('README: the paragraphs of open wrappers and of the lexer are found', open.trim().length > 0 && /bash -c/.test(open) && /redirection/.test(open));
  const sh = 'remote set-head origin feat';
  for (const [form, cmd] of [
    ['`command git push`', `command git ${sh}`], ['`builtin`', `builtin git ${sh}`],
    ['`{ git ...; }`', `{ git ${sh}; }`], ['`! git`', `! git ${sh}`], ['`time [-p] git`', `time -p git ${sh}`], ['time git', `time git ${sh}`],
    ['`if ...; then git`', `if true; then git ${sh}; fi`], ['then git', `if false; then :; elif true; then git ${sh}; fi`],
    ['`do git`', `while false; do git ${sh}; done`], ['do git', `for i in 1; do git ${sh}; done`],
    ['`noglob git`', `noglob git ${sh}`], ['`nocorrect git`', `nocorrect git ${sh}`], ['reserved word', `X=1 time env git ${sh}`],
  ]) {
    const w = decide(cmd, proj);
    ok(`refused: ${cmd}`, refused(w), String(w));
    ok(`README does not list ${form} as open`, !open.includes(form));
  }
  for (const [form, cmd] of [['`repeat 1 git`', `repeat 1 git ${sh}`], ['`{git ...}`', `{git ${sh}}`], ['`command -p git`', `command -p git ${sh}`]]) {
    ok(`allowed (open): ${cmd}`, decide(cmd, proj) === null, String(decide(cmd, proj)));
    ok(`README lists ${form} as open`, open.includes(form));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
