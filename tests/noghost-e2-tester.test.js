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

fs.rmSync(T, { recursive: true, force: true });
done();
