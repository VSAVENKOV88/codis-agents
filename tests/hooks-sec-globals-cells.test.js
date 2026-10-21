#!/usr/bin/env node
'use strict';
// p-sec F7, tester: cells next to hooks-sec-globals. (1) every refused spelling with global options before the
// subcommand is first run by the real git, which must move refs/remotes/origin/HEAD (the cell is reachable), then judged
// by the session hook, which must refuse it: several value options in a row, a value option whose value is the word of
// a terminal option (git --namespace --version remote set-head: git takes --version as the namespace and runs set-head,
// so the hook must not stop at it), an empty --exec-path=, a working directory inside .git and --bare. (2) A terminal
// option after other options leaves origin/HEAD and is allowed. (3) README "Known gaps" names every form left open
// (owner 2026-10-21, answers 30-34): the shell grammar (F1-F6, F8), env with options (F9), exec, eval, $G, aliases and
// functions of the profile, git branch -dr origin/HEAD, a push with an expansion.
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
    ['F1 a leading reserved word ({, !, time, if/then, do)', /reserved word/],
    ['F1 { git ...; }', /\{ git/], ['F1 ! git', /! git/], ['F1 time', /time \[-p\] git|time git/], ['F1 if ... then', /then git/], ['F1 do', /do git/],
    ['F2 zsh modifiers (repeat, noglob, nocorrect, {git)', /repeat 1 git/], ['F2 noglob', /noglob git/], ['F2 nocorrect', /nocorrect git/], ['F2 {git', /\{git/],
    ['F3 a redirection before or between the words', /redirection/], ['F3 2>/dev/null git', /2>\/dev\/null git/], ['F3 &>', /&>\/dev\/null/],
    ['F4 a line continuation', /line continuation/],
    ['F5 $\'...\' with escapes', /\$'\\x73et-head'/], ['F5 $"..."', /\$"\.\.\."/],
    ['F6 backquotes', /backquotes/],
    ['F8 an expansion in the subcommand or its arguments', /expansion in the subcommand/], ['F8 $(...)', /\$\(printf set-head\)/],
    ['F9 env -i', /env -i/], ['F9 env -u', /env -u/],
    ['exec', /`exec`/], ['eval', /`eval`/], ['builtin', /`builtin`/], ['$G in the place of the command', /\$G/],
    ['aliases and functions of the profile', /aliases and functions of the user's shell profile/],
    ['git branch -dr origin/HEAD', /git branch -dr origin\/HEAD/],
    ['a push with an expansion stays allowed', /git push origin "\$BRANCH"/],
    ['the second layer: task p-head2', /p-head2/], ['the shell grammar: task p-shell', /p-shell/],
    ['the table of global options, fail closed', /GIT_GLOBAL/],
  ]) ok(`Known gaps names ${cell}`, re.test(gaps));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
