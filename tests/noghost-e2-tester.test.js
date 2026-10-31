#!/usr/bin/env node
'use strict';
// p-noghost-e2, tester's cells (round 1): what tests/noghost-e2.test.js does not hold of the refusal of the session hook
// to move the arc under a live train (cells C1-C4, C6, C7, C10, C11 of the analysis p-noghost-e, part e2).
//   P   C3: a push from another repository into this one with a bare name (no colon) - git-push(1): "If :<dst> is
//       omitted, the same ref as <src> will be updated" - moves the arc there (measured with git 2.50: a clone on arc2
//       ran git push <project> arc2 and the project's arc2 moved, fast-forward or with -f); also refs/heads/<arc>,
//       +<arc>, -f, and through a remote of the other repository whose URL is the project (a path, a relative path,
//       file://, /var for /private/var). Inside the project's repository git push . <arc> pushes the arc onto itself
//       and stays allowed.
//   P2  C3 (round 2): the sender named by -C or a literal cd, --repo, --delete / :<arc>, letter case; the project's own
//       worktree as the sender pushes onto itself (allowed); a sender on another branch: HEAD / @ is that branch
//   B   C2: git branch -f <arc> with one name (resets it to HEAD), branch -C <arc> with one name (copies the current
//       branch over it), an option after the names (branch <arc> main -f: git's options parser takes it), -- before
//       the name; branch -c <new> in the arc's worktree copies and moves nothing; -dr / --remotes delete
//       remote-tracking refs, not the arc
//   W   C4: worktree add <path> -B <arc> (an option after the path)
//   C   C6: cd into a subdirectory of the arc's worktree, a trailing slash, a symlink to it, `cd <arc> || exit 1;`,
//       a newline instead of ;, -C after cd, git -C <arc> -C sub
//   G   C7: GIT_DIR on the project's repository with update-ref / branch / fetch into the arc from outside it
//   R   F2: reset @~1 / HEAD^ / ORIG_HEAD move the arc; reset --keep HEAD, reset HEAD -- <path> do not
// usage: node tests/noghost-e2-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 400));
const { decide } = require('../scripts/hooks/guard-bash');

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-e2t-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared');
const wArc = path.join(wts, 'w-arc'), wT1 = path.join(wts, 'w-t1'), other = path.join(T, 'other');
const LOCK = path.join(shared, 'train', 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const lockOn = (base) => {
  fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK, { recursive: true });
  put(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: '20261031-202020202-4343', base }));
};
const henv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const hook = (command, cwd) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, henv); } catch (x) { return 'CRASH ' + x.message; } };
const rel = (s) => s.split(T).join('$T');
const no = (c, d) => { const r = hook(c, d); ok(`refused under the train: ${rel(c)} (in ${path.relative(T, d)})`, typeof r === 'string' && /holds the train lock/.test(r), r); };
const yes = (c, d) => { const r = hook(c, d); ok(`allowed under the train: ${rel(c)} (in ${path.relative(T, d)})`, r === null, r); };

for (const d of [main, wts, shared, other]) fs.mkdirSync(d, { recursive: true });
git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
put(path.join(main, '.gitignore'), '.claude/\n'); put(path.join(main, 'b.txt'), 'b\n');
git(main, 'add', '.gitignore', 'b.txt'); git(main, 'commit', '-q', '-m', 'base');
git(main, 'branch', 'arc'); git(main, 'branch', 't1'); git(main, 'branch', 'arc2');
git(main, 'worktree', 'add', '-q', wArc, 'arc'); git(main, 'worktree', 'add', '-q', wT1, 't1');
put(path.join(wArc, 'a.txt'), 'a\n'); git(wArc, 'add', 'a.txt'); git(wArc, 'commit', '-q', '-m', 'a');   // HEAD~1 exists
fs.mkdirSync(path.join(wArc, 'sub'));
fs.symlinkSync(wArc, path.join(T, 'link'));
put(path.join(main, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
// another repository (a clone-like neighbour) on a branch arc2, with remotes whose URL is the project
git(other, 'init', '-q', '-b', 'arc2'); git(other, 'config', 'core.hooksPath', '/dev/null'); git(other, 'commit', '-q', '--allow-empty', '-m', 'o');
git(other, 'remote', 'add', 'p', main);
git(other, 'remote', 'add', 'p2', '../main');
git(other, 'remote', 'add', 'pf', 'file://' + main);
const varMain = main.replace(/^\/private(?=\/var\/)/, '');
git(other, 'remote', 'add', 'pv', varMain);

console.log('P. C3: a push from another repository into this one with a bare name moves the arc');
lockOn('arc2');
// the measurement behind the cell, on a copy: a bare-name push from a clone moves the receiving branch
{
  const m = path.join(T, 'meas'), r = path.join(m, 'r'), c = path.join(m, 'c');
  fs.mkdirSync(m); git(m, 'init', '-q', '-b', 'main', r); git(r, 'commit', '-q', '--allow-empty', '-m', '1'); git(r, 'branch', 'arc2');
  git(m, 'clone', '-q', r, c); git(c, 'checkout', '-q', '-b', 'arc2', 'origin/arc2'); git(c, 'commit', '-q', '--allow-empty', '-m', 'ff');
  const before = git(r, 'rev-parse', 'arc2').stdout.trim();
  git(c, 'push', '-q', 'origin', 'arc2');
  ok('measured: git push origin arc2 from a clone moves arc2 of the origin repository', git(r, 'rev-parse', 'arc2').stdout.trim() !== before && git(r, 'rev-parse', 'arc2').stdout.trim() === git(c, 'rev-parse', 'HEAD').stdout.trim());
}
for (const c of ['git push p arc2', 'git push p refs/heads/arc2', `git push ${main} arc2`, 'git push p +arc2', 'git push -f p arc2', 'git push p2 arc2',
  'git push pf arc2', 'git push pv arc2', `git push file://${main} arc2`, 'git push p HEAD']) no(c, other);
for (const c of ['git push p arc2:t9', 'git push p arc2:refs/heads/t9', 'git fetch p', 'git pull p main']) yes(c, other);
yes('git push . arc2', wT1);   // inside the project: the arc onto itself
yes('git push . HEAD', wT1);   // t1 onto itself

console.log('B. C2: branch forms that name the arc once, options after the names');
for (const c of ['git branch -f arc2', 'git branch --force arc2', 'git branch arc2 main -f', 'git branch -D -- arc2', 'git branch -fq arc2']) no(c, wT1);
lockOn('arc');
no('git branch -C arc', wT1);
yes('git branch -c arc9', wArc);   // copies the arc to arc9; the arc stays
for (const c of ['git branch -dr origin/arc', 'git branch --delete --remotes origin/arc', 'git branch --unset-upstream arc', 'git branch --edit-description arc']) yes(c, wT1);

console.log('W. C4: worktree add with -B after the path');
lockOn('arc2');
no(`git worktree add ${path.join(T, 'x5')} -B arc2 main`, wT1);

console.log('C. C6: cd into a subdirectory, a trailing slash, a symlink; || exit; a newline');
lockOn('arc');
for (const c of [`cd ${wArc}/sub && git commit -m x`, `cd ${wArc}/ && git commit -m x`, `cd ${path.join(T, 'link')} && git commit -m x`,
  `cd ${wArc} || exit 1; git commit -m x`, `cd ${wArc}\ngit commit -m x`, `cd ${wArc} && git branch -m zz`, `cd ${wArc} && git update-ref HEAD main`,
  `git -C ${wArc} -C sub commit -m x`, `git -C ${wArc} branch -m zz`]) no(c, wT1);
yes(`cd ${wArc} && git -C ../w-t1 commit -m x`, wT1);

console.log('G. C7: GIT_DIR on the project\'s repository with the commands that name the arc');
lockOn('arc2');
for (const c of [`GIT_DIR=${main}/.git git update-ref refs/heads/arc2 main`, `GIT_DIR=${main}/.git git branch -f arc2 main`,
  `git --git-dir=${main}/.git fetch . main:arc2`]) no(c, T);
yes(`GIT_DIR=${main}/.git git update-ref refs/heads/t1 main`, T);

console.log('R. F2: reset forms');
lockOn('arc');
for (const c of ['git reset @~1', 'git reset HEAD^', 'git reset --hard ORIG_HEAD']) no(c, wArc);
for (const c of ['git reset --keep HEAD', 'git reset HEAD -- b.txt', 'git reset -q HEAD']) yes(c, wArc);

console.log('P2. C3 (round 2): the sending repository named by -C or a literal cd, --repo, a delete, letter case, a branch that is not the arc');
lockOn('arc2');
// the other repository on arc2 sends; the session sits in a worktree of the project (w-t1)
for (const c of [`git -C ${other} push p arc2`, `git -C ${other} push p HEAD`, `cd ${other} && git push p arc2`, `cd ${other} && git push p @`,
  `git -C ${other} push --repo=${main} arc2`, `git -C ${other} push --delete p arc2`, `git -C ${other} push p :arc2`, `git -C ${other} push p ARC2`]) no(c, wT1);
// the project's own worktree named by -C or cd sends a bare name onto itself: nothing moves
for (const c of [`git -C ${wT1} push . arc2`, `cd ${wT1} && git push ${main} arc2`, `git -C ${wArc} push . HEAD`]) yes(c, other);
// a sender on another branch: HEAD / @ is that branch, not the arc
const o2 = path.join(T, 'o2');
git(T, 'init', '-q', '-b', 't9', o2); git(o2, 'config', 'core.hooksPath', '/dev/null'); git(o2, 'commit', '-q', '--allow-empty', '-m', 'o'); git(o2, 'remote', 'add', 'p', main);
for (const c of ['git push p HEAD', 'git push p @', 'git push p t9', 'git push p +HEAD']) yes(c, o2);
no('git push p HEAD arc2', o2);

console.log('R3. review 1 (round 3): git -C ~/<path> in every form, the shell\'s prefixes before git');
lockOn('arc');
const hEnv = (h) => Object.assign({}, henv, { HOME: h });
const hk = (c, d, env) => { try { return decide({ tool_name: 'Bash', tool_input: { command: c }, cwd: d }, env); } catch (x) { return 'CRASH ' + x.message; } };
const noH = (c, d, env) => { const r = hk(c, d, env); ok(`refused under the train: ${rel(c)} (in ${path.relative(T, d) || '.'}, HOME ${rel(env.HOME || '-')})`, typeof r === 'string' && /holds the train lock/.test(r), r); };
const yesH = (c, d, env) => { const r = hk(c, d, env); ok(`allowed under the train: ${rel(c)} (in ${path.relative(T, d) || '.'}, HOME ${rel(env.HOME || '-')})`, r === null, r); };
const hT = hEnv(T);
// -C ~ to the arc's worktree through a slash, a subdirectory, a symlink, . and .., two -C, after a cd, with assignments
for (const c of ['git -C ~/wts/w-arc/ commit -m x', 'git -C ~/wts/w-arc/sub commit -m x', 'git -C ~/link commit -m x',
  'git -C ~/./wts/w-arc commit -m x', 'git -C ~/wts/../wts/w-arc merge t1', 'git -C ~/wts -C w-arc commit -m x',
  'cd /tmp && git -C ~/wts/w-arc commit -m x', 'X=1 git -C ~/wts/w-arc commit -m x', 'env X=1 git -C ~/wts/w-arc commit -m x',
  'time git -C ~/wts/w-arc commit -m x', '{ git -C ~/wts/w-arc merge t1; }']) noH(c, T, hT);
// -C ~ to the project with the other commands that name the arc (C1, C3, C4) and a --git-dir relative to it
for (const c of ['git -C ~/main update-ref refs/heads/arc t1', 'git -C ~/main fetch . t1:arc', 'git -C ~/main worktree add ../x -B arc',
  'git -C ~/main rebase main arc', 'git -C ~/main checkout -B arc', 'git -C ~/wts/w-t1 checkout -B arc',
  'git -C ~ --git-dir=main/.git branch -f arc t1']) noH(c, T, hT);
noH('git -C ~ commit -m x', T, hEnv(wArc));   // a bare ~ is HOME itself
// what -C ~ must not catch: another worktree, a branch that is not the arc, ~user (open: Known gaps), no HOME
for (const c of ['git -C ~/wts/w-t1 commit -m x', 'git -C ~/main branch -f t1 main', 'git -C ~nobody/wts/w-arc commit -m x']) yesH(c, T, hT);
yesH('git -C ~/wts/w-arc commit -m x', T, { PATH: process.env.PATH });   // no HOME: nothing to expand, no crash
// prefixes before git in the arc's worktree: every reserved word and modifier of CD_PREFIX, nested, mixed with assignments
for (const c of ['if false; then :; elif true; then git commit -m x; fi', 'if false; then :; else git commit -m x; fi',
  'until true; do git commit -m x; done', 'for i in 1; do git commit -m x; done', 'builtin git commit -m x', 'command git commit -m x',
  'noglob git commit -m x', 'nocorrect git commit -m x', '{ ! time git commit -m x; }', 'if ! git commit -m x; then :; fi',
  '! X=1 git commit -m x', 'time X=1 git commit -m x', 'time env X=1 git commit -m x', 'time -p git -C ~/wts/w-arc commit -m x']) noH(c, wArc, hT);
for (const c of ['if false; then :; elif true; then git commit -m x; fi', 'command git commit -m x', 'builtin git commit -m x',
  '{ ! time git commit -m x; }', '! git status', 'time git log']) yesH(c, wT1, hT);

console.log('R3b. README Known gaps names as open exactly the prefixes the hook does not judge (living spec)');
{
  // a project without a train: the push rule and the set-head rule go through the same judge
  const pr = path.join(T, 'r3p'); fs.mkdirSync(pr);
  git(pr, 'init', '-q', '-b', 'main'); put(path.join(pr, '.gitignore'), '.claude/\n'); git(pr, 'add', '.gitignore'); git(pr, 'commit', '-q', '-m', 'b'); git(pr, 'branch', 'feat');
  put(path.join(pr, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: pr, worktreeRoot: T, sharedDir: path.join(T, 'r3sh'), protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const gaps = readme.slice(readme.indexOf('## Known gaps')).replace(/\s+/g, ' ');
  // the three places that list forms passing the session hook
  const span = (from, to) => { const a = gaps.indexOf(from); const b = a < 0 ? -1 : gaps.indexOf(to, a); return a < 0 || b < 0 ? '' : gaps.slice(a, b); };
  const wrappers = span('The session hook reads the command line as written', 'pass it.');
  const lexer = span('splits a line by its own small lexer', 'To be closed');
  const train = span('The refusal to move the arc under a train', ');');   // "... wrappers pass it as for a push (<forms>);"
  ok('R3b. README: the three lists of open forms are found', wrappers && lexer && train, [wrappers.length, lexer.length, train.length].join(','));
  const sh = 'git remote set-head origin feat';
  for (const [where, text, form, cmd, cwd] of [
    ['wrappers', wrappers, '`command git push`', 'command git push origin main', pr],
    ['wrappers', wrappers, '`builtin`', 'builtin git push origin main', pr],
    ['lexer', lexer, '`{ git ...; }`', `{ ${sh}; }`, pr],
    ['lexer', lexer, '`! git`', `! ${sh}`, pr],
    ['lexer', lexer, '`time [-p] git`', `time -p ${sh}`, pr],
    ['lexer', lexer, '`if ...; then git`', `if true; then ${sh}; fi`, pr],
    ['lexer', lexer, '`do git`', `while false; do ${sh}; done`, pr],
    ['lexer', lexer, '`noglob git`', `noglob ${sh}`, pr],
    ['lexer', lexer, '`nocorrect git`', `nocorrect ${sh}`, pr],
    ['lexer', lexer, '`repeat 1 git`', `repeat 1 ${sh}`, pr],
    ['lexer', lexer, '`{git ...}`', `{${sh}}`, pr],
    ['train', train, '`command git commit`', 'command git commit -m x', wArc],
  ]) {
    const r = hk(cmd, cwd, hT), refused = typeof r === 'string' && !/^CRASH/.test(r), listed = text.includes(form);
    ok(`R3b. ${where}: ${form} - the hook ${refused ? 'refuses it' : 'allows it'}, so README ${refused ? 'must not list it as open' : 'lists it as open'}`, !/^CRASH/.test(String(r)) && refused !== listed, `refused=${refused} listed=${listed} ${r}`);
  }
}

fs.rmSync(T, { recursive: true, force: true });
done();
