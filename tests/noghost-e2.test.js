#!/usr/bin/env node
'use strict';
// p-noghost-e2: the commands that name the arc and the bounds of directory, repository and config for the refusal of the
// session hook to move the arc under a live train (cells C1-C4, C6, C7, C10-C13, D2 of the analysis p-noghost-e, and the
// findings 1-3 of the review of p-noghost-e1). Measured with git 2.50 (the analysis, E4, and this task):
//   C1  git update-ref refs/heads/<arc> (any case: a loose ref on a case-insensitive disk is one file), -d, and
//       update-ref HEAD in the arc's worktree (it dereferences HEAD), from any directory of the repository
//   C2  git branch -f / -m / -M / -c / -C / -d / -D (and their long forms) with the arc among the names; branch -m <new>
//       in the arc's worktree renames the arc; the arc checked out or not
//   C3  git push <this repository: ., a path, file://, a remote whose URL is it> X:<arc> (heads/<arc>, refs/heads/<arc>,
//       --delete, :<arc>) and git fetch / pull <any> X:<arc> (a glob destination that covers the arc too, --stdin)
//   C4  checkout -B / switch -C / worktree add -B <arc>, rebase <upstream> <arc> (and --root <arc>) from another directory
//   C6  cd <a literal path> / pushd / popd in the line move the directory the hook judges (relative, ~, no argument,
//       CDPATH, a subshell, a pipeline, a background job, a redirection); cd with an expansion is open (owner's
//       decision 1: no refusal)
//   C7  --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE naming the project's repository: closed - judged as if the
//       current branch were the arc
//   C10 another repository with a branch of the same name - allowed
//   C11 the session names another project (CODIS_AGENTS_CONFIG, CLAUDE_PROJECT_DIR): the config found from the
//       directory of the command decides as well
//   C12 ALLOW_PROTECTED_PUSH=1 lifts none of these
//   C13 checkout --ignore-other-worktrees <arc> && git commit - open, named in README "Known gaps" (D2)
//   F1  a relative repoDir / sharedDir is relative to the project root (the parent of .claude/), as config.js reads it
//   F2  git reset HEAD / @ (any mode) does not move the branch - allowed
// usage: node tests/noghost-e2.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 500));
const { decide } = require('../scripts/hooks/guard-bash');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-e2-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared');
const wArc = path.join(wts, 'w-arc'), wT1 = path.join(wts, 'w-t1');
const LOCK = path.join(shared, 'train', 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const lockAt = (dir, owner) => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (owner) { fs.mkdirSync(dir, { recursive: true }); put(path.join(dir, 'owner.json'), JSON.stringify(owner)); }
};
const LIVE = { pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: '20261031-101010101-4242', base: 'arc' };
const LIVE2 = Object.assign({}, LIVE, { base: 'arc2' });   // an arc checked out nowhere

// the hook's environment: no config named by the session, the project found from the directory (config.js find)
const henv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const hook = (command, cwd, e = henv) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, e); } catch (x) { return 'CRASH ' + x.message; } };
const refused = (r) => typeof r === 'string' && /train/.test(r) && !/^CRASH/.test(r);
const no = (c, d = wT1, e = henv, tag = '') => ok(`refused under the train${tag}: ${c} (in ${path.relative(T, d) || '.'})`, refused(hook(c, d, e)), hook(c, d, e));
const yes = (c, d = wT1, e = henv, tag = '') => ok(`allowed under the train${tag}: ${c} (in ${path.relative(T, d) || '.'})`, hook(c, d, e) === null, hook(c, d, e));

for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
put(path.join(main, '.gitignore'), '.claude/\n');
put(path.join(main, 'base.txt'), 'base\n');
git(main, 'add', '.gitignore', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
git(main, 'branch', 'arc'); git(main, 'branch', 't1'); git(main, 'branch', 'arc2');
git(main, 'worktree', 'add', '-q', wArc, 'arc');
git(main, 'worktree', 'add', '-q', wT1, 't1');
put(path.join(wArc, 'a.txt'), 'a\n'); git(wArc, 'add', 'a.txt'); git(wArc, 'commit', '-q', '-m', 'a');   // the arc has a parent (HEAD~1)
put(path.join(wT1, 't1.txt'), 't1\n'); git(wT1, 'add', 't1.txt'); git(wT1, 'commit', '-q', '-m', 't1');
const cfgFile = path.join(main, '.claude', 'codis-agents.json');
put(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
// another repository on a branch named arc (C10), its own remote to the project (C3: a remote whose URL is the project)
const other = path.join(T, 'other');
fs.mkdirSync(other); git(other, 'init', '-q', '-b', 'arc'); git(other, 'commit', '-q', '--allow-empty', '-m', 'o');
git(main, 'remote', 'add', 'self', main);
git(main, 'remote', 'add', 'up', other);

lockAt(LOCK, LIVE);

console.log('C1. git update-ref of the arc');
for (const c of ['git update-ref refs/heads/arc main', 'git update-ref -d refs/heads/arc', 'git update-ref -m why refs/heads/arc main',
  'git update-ref refs/heads/ARC main', 'git update-ref --create-reflog refs/heads/arc main HEAD', `git -C ${wArc} update-ref refs/heads/arc main`]) no(c);
no('git update-ref HEAD main', wArc);
no('git update-ref -m x HEAD main', wArc);
yes('git update-ref --no-deref HEAD main', wArc);   // detaches HEAD; the arc stays
yes('git update-ref HEAD main');                    // HEAD of w-t1 is t1
for (const c of ['git update-ref refs/heads/t1 main', 'git update-ref refs/heads/arcx main', 'git update-ref heads/arc main', 'git update-ref arc main']) yes(c);   // heads/arc and arc: not the branch (measured)

console.log('C2. git branch with the arc among the names');
for (const c of ['git branch -f arc main', 'git branch -m arc arc9', 'git branch -M t1 arc', 'git branch -C main arc', 'git branch -c arc arc9',
  'git branch -d arc', 'git branch -D arc', 'git branch --delete --force arc', 'git branch -fq arc main', 'git branch --force arc main',
  'git branch -f Arc main', 'git branch --move arc arc9', 'git branch --copy main arc', 'git branch -D t9 arc']) no(c);
no('git branch -m arc9', wArc);    // one name: renames the current branch, the arc
no('git branch -M arc9', wArc);
for (const c of ['git branch', 'git branch -a', 'git branch --list arc', 'git branch -v', 'git branch new1 arc', 'git branch -f t9 main',
  'git branch -m t1 t1b', 'git branch -u up/arc arc', 'git branch --contains arc', 'git branch --merged arc', 'git branch -m t1b']) yes(c);
lockAt(LOCK, LIVE2);
for (const c of ['git branch -f arc2 main', 'git branch -D arc2', 'git branch -m arc2 x']) no(c, wT1, henv, ' (arc2 checked out nowhere)');
lockAt(LOCK, LIVE);

console.log('C3. git push to this repository, git fetch / pull into the arc');
lockAt(LOCK, LIVE2);
for (const c of ['git push . main:arc2', 'git push . main:refs/heads/arc2', 'git push . +main:heads/arc2', `git push ${main} main:arc2`,
  `git push ${wArc} main:arc2`, `git push ${main}/.git main:arc2`, `git push file://${main} main:arc2`, 'git push --delete . arc2', 'git push . :arc2',
  'git push -d . arc2', 'git push self main:arc2', 'git push -f . main:arc2', 'git push --repo=. main:arc2', 'git push ../../main main:arc2',
  'git fetch . main:arc2', `git fetch ${other} arc:arc2`, `git fetch ${other} arc:refs/heads/arc2`, "git fetch . 'refs/heads/*:refs/heads/*'",
  'git fetch . +main:ARC2', 'git fetch up arc:heads/arc2', 'git fetch --stdin .', 'git pull . main:arc2', 'git pull --no-rebase . main:arc2']) no(c);
for (const c of ['git push . main:t9', `git push ${other} main:arc2`, 'git push up main:arc2', 'git push . arc2', 'git fetch . main', 'git fetch up',
  'git fetch up arc:t9', "git fetch . 'refs/heads/m*:refs/heads/m*'", 'git fetch --all', 'git push origin t1', 'git pull . main']) yes(c);
yes(`git -C ${other} push . arc:arc2`);    // . is the other repository
yes(`git -C ${other} fetch ${main} main:arc2`);   // fetch into the other repository
lockAt(LOCK, LIVE);
no('git push . main:arc');   // the arc checked out (git itself refuses; refused all the same)

console.log('C4. checkout -B / switch -C / worktree add -B / rebase <up> <arc> from another directory');
lockAt(LOCK, LIVE2);
for (const c of ['git checkout -B arc2 main', 'git switch -C arc2', `git worktree add -B arc2 ${path.join(T, 'x1')} main`, `git worktree add -fB arc2 ${path.join(T, 'x2')}`,
  'git rebase main arc2', 'git rebase --onto main main arc2', 'git rebase --root arc2', 'git rebase -q main arc2']) no(c);
for (const c of [`git worktree add ${path.join(T, 'x3')} t1`, `git worktree add -b new9 ${path.join(T, 'x4')}`, 'git worktree list', 'git rebase --abort']) yes(c);
lockAt(LOCK, LIVE);
no('git rebase main arc');
yes('git rebase main t1', T);   // not a repository: no config, nothing judged

console.log('C6. cd / pushd / popd with a literal path in the line');
const home = Object.assign({}, henv, { HOME: T });
for (const c of [`cd ${wArc} && git commit -m x`, `cd ${wArc}; git commit -m x`, `pushd ${wArc} && git commit -m x`, `cd -P ${wArc} && git commit -m x`,
  `cd -- ${wArc} && git commit -m x`, `cd "${wArc}" && git commit -m x`, `cd ${wArc} 2>/dev/null && git commit -m x`, `cd ${wArc} &>/dev/null && git commit -m x`,
  `cd ${wArc} > /dev/null && git commit -m x`, `(cd ${wArc}; git commit -m x)`, `cd ${wArc} && git -C . reset --hard main`, `true | cd ${wArc}; git commit -m x`,
  `pushd ${wArc}; pushd ${wT1}; popd; git commit -m x`, `cd ${wArc} && cd ${wT1} && cd - && git commit -m x`, `{ cd ${wArc}; } && git commit -m x`,
  `builtin cd ${wArc} && git commit -m x`, `X=1 cd ${wArc} && git commit -m x`]) no(c, wT1);
no('cd w-arc && git commit -m x', wts);
no('cd ./w-arc && git commit -m x', wts);
no('cd ../w-arc && git commit -m x', wT1);
no('cd ~/wts/w-arc && git commit -m x', T, home);
no('cd && git commit -m x', T, Object.assign({}, henv, { HOME: wArc }));
no('cd w-arc && git commit -m x', T, Object.assign({}, henv, { CDPATH: wts }));
no(`echo | cd ${wT1}; git commit -m x`, wArc);   // bash runs the last element of a pipeline in a subshell, zsh in the shell: both
for (const c of [`cd ${wT1} && git commit -m x`, `cd ${wT1}; git commit -m x`, `pushd ${wT1} && git commit -m x`, `cd ${wT1} && git reset --hard main`]) yes(c, wArc);
for (const c of [`(cd ${wArc} && true); git commit -m x`, `cd ${wArc} | true; git commit -m x`, `cd ${wArc} & git commit -m x`,
  `pushd ${wArc} >/dev/null; popd; git commit -m x`, `pushd ${wT1}; pushd ${wArc}; popd; git commit -m x`, `cd ${wArc} && cd - ; git status`,
  'cd "$WT" && git commit -m x', 'cd $(git rev-parse --show-toplevel) && git commit -m x', 'cd - && git commit -m x', `cd ${wArc} && git status`]) yes(c, wT1);

yes(`cd ${wArc}/no-such-dir; git commit -m x`, wT1);   // the cd fails: the commit runs in w-t1
no(`cd ${wT1}/no-such-dir; git commit -m x`, wArc);   // the cd fails: the commit runs in the arc's worktree
yes('cd "$WT" && git commit -m x', wArc, henv, ' (cd with an expansion: not followed, not judged - decision 1, Known gaps)');

console.log('C7. --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE naming the project\'s repository');
const gd = path.join(main, '.git'), gdArc = path.join(main, '.git', 'worktrees', 'w-arc');
for (const c of [`git --git-dir=${gd} --work-tree=${wArc} commit -m x`, `GIT_DIR=${gdArc} git commit -m x`, `GIT_WORK_TREE=${wArc} GIT_DIR=${gdArc} git commit -m x`,
  `git --git-dir ${gdArc} reset --hard main`, `export GIT_DIR=${gdArc}; git commit -m x`, `env GIT_DIR=${gdArc} git merge main`,
  `git --git-dir=${gd} update-ref HEAD main`, `GIT_DIR=${gd} git branch -D arc`]) no(c, T);
for (const c of [`git --git-dir=${gd} status`, `git --git-dir=${gd} log`, `git --git-dir=${gdArc} commit --dry-run -m x`, `git --git-dir=${gd} update-ref refs/heads/t1 main`,
  `git --git-dir=${path.join(other, '.git')} commit -m x`]) yes(c, T);

console.log('C10. another repository with a branch of the same name');
const sess = Object.assign({}, henv, { CODIS_AGENTS_CONFIG: cfgFile });
for (const c of ['git commit -m x', 'git update-ref refs/heads/arc HEAD', 'git branch -f arc HEAD', 'git reset --hard HEAD~0', 'git push . HEAD:arc']) yes(c, other, sess, ' (other repository)');
yes(`git -C ${other} branch -D arc`, wArc, sess);
yes(`cd ${other} && git commit -m x`, wT1, sess);

console.log('C11. the session names another project: the config found from the directory decides as well');
const pB = path.join(T, 'projB'), sharedB = path.join(T, 'sharedB');
fs.mkdirSync(pB); git(pB, 'init', '-q', '-b', 'main'); git(pB, 'commit', '-q', '--allow-empty', '-m', 'b');
const cfgB = path.join(pB, '.claude', 'codis-agents.json');
put(cfgB, JSON.stringify({ repoDir: pB, worktreeRoot: path.join(T, 'wtsB'), sharedDir: sharedB, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
const sessB = Object.assign({}, henv, { CODIS_AGENTS_CONFIG: cfgB }), projB = Object.assign({}, henv, { CLAUDE_PROJECT_DIR: pB });
no('git commit -m x', wArc, sessB, ' (session CODIS_AGENTS_CONFIG = project B)');
no('git commit -m x', wArc, projB, ' (session CLAUDE_PROJECT_DIR = project B)');
no('git update-ref refs/heads/arc main', wT1, sessB, ' (session = project B)');
no(`cd ${wArc} && git commit -m x`, pB, projB, ' (session = project B, cd into the arc)');
yes('git commit -m x', pB, projB, ' (project B has no train)');

console.log('C12. ALLOW_PROTECTED_PUSH=1 lifts none of them');
lockAt(LOCK, LIVE2);
for (const c of ['ALLOW_PROTECTED_PUSH=1 git branch -D arc2', 'ALLOW_PROTECTED_PUSH=1 git push . main:arc2', 'ALLOW_PROTECTED_PUSH=1 git update-ref refs/heads/arc2 main',
  'ALLOW_PROTECTED_PUSH=1 git fetch . main:arc2', 'env ALLOW_PROTECTED_PUSH=1 git worktree add -B arc2 /tmp/x9']) no(c);
no('git update-ref --stdin', wT1, Object.assign({}, henv, { ALLOW_PROTECTED_PUSH: '1' }), ' (ALLOW in the environment; --stdin names refs the hook cannot see)');
lockAt(LOCK, LIVE);

console.log('F2. git reset HEAD (any mode) does not move the branch');
for (const c of ['git reset HEAD', 'git reset --soft HEAD', 'git reset --hard HEAD', 'git reset -q @', 'git reset --mixed HEAD']) yes(c, wArc);
for (const c of ['git reset HEAD~1', 'git reset --hard main', 'git reset --soft HEAD^']) no(c, wArc);

console.log('F1. a relative repoDir / sharedDir is relative to the project root');
const p3 = path.join(T, 'p3', 'repo');
fs.mkdirSync(p3, { recursive: true }); git(p3, 'init', '-q', '-b', 'arc3'); git(p3, 'commit', '-q', '--allow-empty', '-m', 'p3');
put(path.join(p3, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: '.', worktreeRoot: '../wts3', sharedDir: '../shared3', protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
lockAt(path.join(T, 'p3', 'shared3', 'train', 'lock'), Object.assign({}, LIVE, { base: 'arc3' }));
const cwd0 = process.cwd();
process.chdir(os.tmpdir());   // the hook's own working directory is not the project's
no('git commit -m x', p3, henv, ' (relative repoDir and sharedDir)');
no(`cd ${p3} && git branch -D arc3`, T, henv, ' (relative repoDir and sharedDir)');
process.chdir(cwd0);

console.log('D2. README "Known gaps" names what stays open');
const readme = read(path.join(ROOT, 'README.md'));
const gaps = readme.slice(readme.indexOf('## Known gaps'));
ok('D2. Known gaps: cd with an expansion (cd "$WT", cd -, cd $(...)) is open for the refusal under a train', /under a train/.test(gaps) && /cd "\$WT"/.test(gaps) && /cd \$\(/.test(gaps));
ok('D2. Known gaps: checkout --ignore-other-worktrees <arc> && git commit (judged before anything runs)', /--ignore-other-worktrees/.test(gaps));
ok('D2. Known gaps: commits outside Claude Code are not seen (no git hook); the last line is arc-moved', /outside Claude Code/.test(gaps) && /arc-moved/.test(gaps));
ok('D2. Known gaps: the grammar and wrappers are the same as for a push', /as for a push/.test(gaps));
const hj = read(path.join(ROOT, 'hooks', 'hooks.json')), head = read(path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')).split('\nconst ')[0];
ok('D2. hooks.json and the hook\'s header name the commands that name the arc (update-ref, branch, push/fetch into it) and cd',
  /update-ref/.test(hj) && /branch -D/.test(hj) && /update-ref refs\/heads\/<arc>/.test(head) && /\bcd\b/.test(head) && /pushd/.test(head));

fs.rmSync(T, { recursive: true, force: true });
done();
