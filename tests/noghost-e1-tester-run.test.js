#!/usr/bin/env node
'use strict';
// p-noghost-e1, tester of this run (round 1): what the two guard files of e1 do not hold yet. My inventory of the matrix
// of p-noghost-e (A1-A10, B1-B7, C5, C8, C9, D1, D3, D4) and of the surfaces it touches was compared with
// tests/noghost-e1.test.js and tests/noghost-e1-tester.test.js; the cells below are the gaps and the real surfaces:
//   H   the hook as Claude Code runs it: a child process, the tool call as JSON on stdin, the deny answer on stdout
//       (and an empty answer, exit 0, when the lock does not refuse)
//   R   git reset with a revision that has a parent (HEAD~1, --soft / --mixed): the commit form moves the branch, the
//       paths form and --patch do not (the fixture has two commits, so HEAD~1 resolves)
//   X   a dry run chained with a commit (commit --dry-run && commit), a dry run through -C from another worktree, a dry
//       run with --amend, a combined short cluster that ends in a dry run (-am x --dry-run)
//   Q   the quit / abort forms that stop an operation and move nothing (merge --quit, rebase --quit, revert --quit)
//   N   a base that is not a branch name (empty, not a string) does not refuse: no base, no arc (A4 family)
//   O   the order in scripts/train.js departure(): the lock names the arc (base) before the arc head is read; a move
//       between the two is what the hook exists for (source order, the one thing the behaviour tests cannot see)
// usage: node tests/noghost-e1-tester-run.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 400));
const { decide } = require('../scripts/hooks/guard-bash');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-e1-run-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared');
const wArc = path.join(wts, 'w-arc'), wT1 = path.join(wts, 'w-t1');
const LOCK = path.join(shared, 'train', 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };

// the hook's environment: the project is found from the directory (config.js find), no session config
const henv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const bash = (command, cwd = wArc, env = henv) => decide({ tool_name: 'Bash', tool_input: { command }, cwd }, env);
const refused = (r) => typeof r === 'string' && /train/.test(r);
// the live holder is this process (its pid is alive for the whole test); base names the arc
const liveOwner = (extra) => Object.assign({ pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: 'T-RUN-1', base: 'arc', wt: path.join(wts, 'train-T-RUN-1') }, extra);
const lock = (owner) => {
  fs.rmSync(LOCK, { recursive: true, force: true });
  if (owner === undefined) return;
  fs.mkdirSync(LOCK, { recursive: true });
  if (owner !== null) put(path.join(LOCK, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
};

// fixture: two commits on main, so HEAD~1 resolves; arc at the second, t1 with its own commit on the first
for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
git(main, 'init', '-q', '-b', 'main');
put(path.join(main, '.gitignore'), '.claude/\n');
put(path.join(main, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]', guardCommand: 'true' }));
put(path.join(main, 'f.txt'), 'one\n'); git(main, 'add', '.gitignore', 'f.txt'); git(main, 'commit', '-q', '-m', 'one');
put(path.join(main, 'f.txt'), 'two\n'); git(main, 'commit', '-q', '-am', 'two');
git(main, 'branch', 'arc');
git(main, 'branch', 't1', 'HEAD~1');
git(main, 'worktree', 'add', '-q', wArc, 'arc');
git(main, 'worktree', 'add', '-q', wT1, 't1');
put(path.join(wT1, 'g.txt'), 'g\n'); git(wT1, 'add', 'g.txt'); git(wT1, 'commit', '-q', '-m', 't1 commit');
put(path.join(wArc, 'sub', 'x.txt'), 'x\n');

(async () => {
  // ---- H: the hook as Claude Code runs it (a child process, JSON on stdin) ----
  const call = (cmd, cwd, extraEnv) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd }), cwd, encoding: 'utf8',
    env: Object.assign({}, henv, extraEnv || {}),
  });
  lock(liveOwner());
  const h1 = call('git commit -m x', wArc);
  let ans = null; try { ans = JSON.parse(h1.stdout); } catch { /* checked below */ }
  const reason = ans && ans.hookSpecificOutput && ans.hookSpecificOutput.permissionDecisionReason || '';
  ok('H1. the hook process, live holder with base = arc: exit 0 and a deny answer for git commit in the arc worktree',
    h1.status === 0 && ans && ans.hookSpecificOutput && ans.hookSpecificOutput.permissionDecision === 'deny', `${h1.status} ${h1.stdout} ${h1.stderr}`);
  ok('H1. ... the reason names the arc, the train id and "train.js status" (the wait)',
    /\barc\b/.test(reason) && /T-RUN-1/.test(reason) && /train\.js"? status/.test(reason), reason);
  const h2 = call('git commit -m x', wT1);
  ok('H2. the hook process, the same live lock, commit in another worktree (t1): exit 0, empty answer',
    h2.status === 0 && h2.stdout.trim() === '', `${h2.status} ${h2.stdout}`);
  lock(liveOwner({ base: 'other' }));
  const h3 = call('git commit -m x', wArc);
  ok('H3. the hook process, lock with base = another branch: exit 0, empty answer', h3.status === 0 && h3.stdout.trim() === '', `${h3.status} ${h3.stdout}`);
  lock(liveOwner({ pid: 999999 }));
  const h4 = call('git commit -m x', wArc);
  ok('H4. the hook process, a dead holder (pid 999999 gone): exit 0, empty answer', h4.status === 0 && h4.stdout.trim() === '', `${h4.status} ${h4.stdout}`);
  lock(undefined);
  const h5 = call('git commit -m x', wArc);
  ok('H5. the hook process, no lock: exit 0, empty answer', h5.status === 0 && h5.stdout.trim() === '', `${h5.status} ${h5.stdout}`);

  // ---- from here on the lock is the live owner with base = arc ----
  lock(liveOwner());
  const no = (c, d = wArc, e) => ok(`refused under the train: ${c}${d === wArc ? '' : ` [${path.basename(d)}]`}`, refused(bash(c, d, e)), bash(c, d, e));
  const yes = (c, d = wArc, e) => ok(`allowed under the train: ${c}${d === wArc ? '' : ` [${path.basename(d)}]`}`, bash(c, d, e) === null, bash(c, d, e));

  // ---- R: git reset to a revision with a parent ----
  no('git reset HEAD~1');
  no('git reset --soft HEAD~1');
  no('git reset --mixed HEAD~1');
  yes('git reset HEAD~1 -- f.txt');
  yes('git reset -p HEAD~1');

  // ---- X: a dry run and a commit ----
  no('git commit --dry-run -m x && git commit -m y');   // the second command commits
  no('git commit -m y && git commit --dry-run -m x');   // the first one commits
  yes('git commit --dry-run -m x && git status');
  yes('git commit -am x --dry-run');
  yes('git commit --amend --dry-run');
  yes('git commit --dry-run -m x', path.join(wArc, 'sub'));
  yes(`git -C ${wArc} commit --dry-run -m x`, wT1);
  no(`git -C ${wArc} commit -am x --message=y`, wT1);

  // ---- Q: the quit / abort forms move nothing ----
  yes('git merge --quit');
  yes('git rebase --quit');
  yes('git revert --quit');
  yes('git cherry-pick --quit');
  yes('git am --quit');

  // ---- X/B: the commit from the subdirectory of the arc worktree is the arc's commit ----
  no('git commit -m x', path.join(wArc, 'sub'));

  // ---- N: a base that names no branch refuses nothing ----
  lock(liveOwner({ base: '' }));
  ok('N. a live holder with base "" -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(liveOwner({ base: 7 }));
  ok('N. a live holder with a base that is not a string -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(undefined);

  // ---- O: train.js writes base before it reads the arc head (source order of departure) ----
  const TS = src('scripts/train.js');
  const dep = TS.slice(TS.indexOf('async function departure(P)'));
  const body = dep.slice(0, dep.indexOf('\n}\n'));
  const iSet = body.indexOf('setOwner(P, { train: id, base })');
  const iHead = body.indexOf('rev(P, `refs/heads/${base}`)');
  ok('O. departure(): setOwner(P, { train: id, base }) comes before the arc head is read (rev(P, `refs/heads/${base}`))',
    iSet > 0 && iHead > iSet, `set at ${iSet}, head at ${iHead}`);

  fs.rmSync(T, { recursive: true, force: true });
  done();
})();
