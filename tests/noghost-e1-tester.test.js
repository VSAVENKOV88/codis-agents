#!/usr/bin/env node
'use strict';
// p-noghost-e1, tester's cells (round 1): what tests/noghost-e1.test.js does not hold of the refusal of the session hook
// to move the arc branch under a live train (cells A, B, C5 of the analysis p-noghost-e, part e1).
//   G   git's global options before the subcommand (-c, --no-pager, a git path) do not hide a commit
//   W   the directory: a subdirectory of the arc's worktree; the arc checked out in the main worktree (repoDir itself)
//   R   git reset: '-' (the previous branch, @{-1}) and a commit followed by '--' with no paths move the branch;
//       --pathspec-from-file is a reset of paths
//   S   the sequencer forms that go on and commit (rebase --skip, am --continue, revert --continue), commit --fixup,
//       merge --no-ff, pull --rebase; an unfinished rebase of the apply backend (rebase-apply/head-name)
//   F   checkout -B / switch -C of the arc from another worktree (B5 "from anywhere"); switch --force <arc> is
//       --discard-changes (git-switch(1): "-f, --force An alias for --discard-changes"), an exact option of its own and
//       not an abbreviation of --force-create, and it does not move the branch (measured with git 2.50)
//   V   an option value is not an option: git commit -m --dry-run commits (measured with git 2.50: "[free 6bb4c2d]
//       --dry-run"), git merge -m --abort <branch> merges
//   P   ALLOW_PROTECTED_PUSH=1 does not lift the refusal (coordinator's decision 2 for p-noghost-e), in the line, through
//       env, or in the hook's environment
//   L   the liveness of scripts/train-lock.js in the hook: a holder alive only by its process group refuses; a group
//       that is the reader's own is no evidence; arcHolder of no sharedDir is null; train.js status of a lock without
//       base prints no "for arc"
// usage: node tests/noghost-e1-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 400));
const { decide } = require('../scripts/hooks/guard-bash');
const TL = require('../scripts/train-lock');

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-e1t-')));
const main = path.join(T, 'main'), wArc = path.join(T, 'w-arc'), wB = path.join(T, 'w-b'), shared = path.join(T, 'shared');
const LOCK = path.join(shared, 'train', 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const cfgFile = path.join(main, '.claude', 'codis-agents.json');
const henv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const hook = (command, cwd = wArc, env = henv) => decide({ tool_name: 'Bash', tool_input: { command }, cwd }, env);
const refused = (r) => typeof r === 'string' && /train/.test(r) && /\barc\b/.test(r);
const no = (c, d = wArc, env) => { const r = hook(c, d, env); ok(`refused under the train [${path.basename(d)}]: ${c}`, refused(r), r); };
const yes = (c, d = wArc, env) => { const r = hook(c, d, env); ok(`allowed under the train [${path.basename(d)}]: ${c}`, r === null, r); };
const owner = (o) => { fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK, { recursive: true }); put(path.join(LOCK, 'owner.json'), JSON.stringify(o)); };
const deadPid = () => spawnSync('true').pid;
const LIVE = { pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: '20261031-000000000-1', base: 'arc' };

fs.mkdirSync(main, { recursive: true });
git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
put(path.join(main, '.gitignore'), '.claude/\n');
put(path.join(main, 'a.txt'), 'a\n');
git(main, 'add', '.gitignore', 'a.txt'); git(main, 'commit', '-q', '-m', 'base');
git(main, 'branch', 'arc'); git(main, 'branch', 'free');
git(main, 'worktree', 'add', '-q', wArc, 'arc');
git(main, 'worktree', 'add', '-q', '--detach', wB);
fs.mkdirSync(path.join(wArc, 'sub'));
put(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: T, sharedDir: shared, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]' }));
owner(LIVE);

// ---- G: global options before the subcommand ----
no('git -c user.name=x commit -m x');
no('git --no-pager commit -m x');
no('/usr/bin/git commit -m x');
no('git -c core.hooksPath=/dev/null merge free');

// ---- W: the directory ----
no('git commit -m x', path.join(wArc, 'sub'));
no('git -C sub reset --hard main');
git(wArc, 'checkout', '-q', '--detach');
git(main, 'checkout', '-q', 'arc');
no('git commit -m x', main);
yes('git commit -m x', wArc);   // the old worktree of the arc, now detached: not the arc
git(main, 'checkout', '-q', 'main');
git(wArc, 'checkout', '-q', 'arc');
ok('W. fixture: the arc is back in its worktree', git(wArc, 'symbolic-ref', '-q', 'HEAD').stdout.trim() === 'refs/heads/arc');

// ---- R: git reset ----
no('git reset -');
no('git reset main --');
no('git reset --merge main');
yes('git reset --pathspec-from-file=paths.txt main');
yes('git reset -q -- a.txt');

// ---- S: forms that go on and commit ----
for (const c of ['git rebase --skip', 'git am --continue', 'git revert --continue', 'git cherry-pick --skip', 'git commit --fixup HEAD',
  'git merge --no-ff free', 'git pull --rebase', 'git commit -C HEAD --reset-author']) no(c);
for (const c of ['git rebase --edit-todo', 'git rebase --show-current-patch', 'git am --quit', 'git merge --quit', 'git stash pop', 'git checkout arc',
  'git switch --discard-changes arc']) yes(c);

// ---- F: checkout -B / switch -C ----
no('git checkout -B arc main', wB);
no('git switch -C arc main', wB);
no('git switch --force-create arc main', wB);
no('git switch --force-c arc main', wB);   // an abbreviation of --force-create
yes('git switch --force arc');   // --force is --discard-changes: an exact option, not --force-create
yes('git switch -f arc');
yes('git checkout -f arc');

// ---- V: an option value is not an option ----
no('git commit -m --dry-run');
no('git merge -m --abort free');
no('git commit --message --dry-run');   // the long form of the same value option (round 2)
no('git merge --message --abort free');

// ---- P: ALLOW_PROTECTED_PUSH=1 does not lift the refusal ----
no('ALLOW_PROTECTED_PUSH=1 git commit -m x');
no('env ALLOW_PROTECTED_PUSH=1 git reset --hard main');
no('git commit -m x', wArc, Object.assign({}, henv, { ALLOW_PROTECTED_PUSH: '1' }));

// ---- S: an unfinished rebase of the apply backend (rebase-apply/head-name, HEAD detached) ----
git(wB, 'checkout', '-q', '-b', 'side', 'main');
put(path.join(wB, 'a.txt'), 'side\n'); git(wB, 'commit', '-q', '-am', 'side');
put(path.join(wArc, 'a.txt'), 'arc\n'); git(wArc, 'commit', '-q', '-am', 'arc change');
const rb = git(wArc, 'rebase', '--apply', 'side');
const gp = git(wArc, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-apply/head-name').stdout.trim();
ok('S. fixture: a rebase --apply of arc stopped on a conflict, HEAD detached, rebase-apply/head-name = refs/heads/arc',
  rb.status !== 0 && git(wArc, 'symbolic-ref', '-q', 'HEAD').status !== 0 && (fs.existsSync(gp) ? fs.readFileSync(gp, 'utf8').trim() : '') === 'refs/heads/arc', rb.stdout + rb.stderr);
no('git rebase --continue');
no('git commit -m resolved');
yes('git rebase --abort');
git(wArc, 'rebase', '--abort');

// ---- L: liveness through scripts/train-lock.js ----
const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });   // its own process group, pgid = its pid
owner(Object.assign({}, LIVE, { pid: deadPid(), pgid: sleeper.pid }));
no('git commit -m x');   // alive only by the group (an orphaned guard worker of a killed dispatcher)
const own = TL.pgidOf(process.pid);
owner(Object.assign({}, LIVE, { pid: deadPid(), pgid: own }));
ok('L. fixture: the reader\'s own process group is known', own > 1, own);
yes('git commit -m x');   // the reader's own group is no evidence
try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
ok('L. arcHolder of no sharedDir -> null (not a throw)', TL.arcHolder(undefined) === null && TL.arcHolder('') === null);
const noBase = Object.assign({}, LIVE); delete noBase.base;
owner(noBase);
const st = spawnSync(process.execPath, [TRAIN, 'status'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile }) });
ok('L. train.js status of a lock without base (an older dispatcher): "lock: train <id> by pid", no "for arc"',
  st.stdout.includes(`lock: train ${LIVE.train} by pid ${LIVE.pid}`) && !/for arc/.test(st.stdout), st.stdout + st.stderr);

fs.rmSync(T, { recursive: true, force: true });
done();
