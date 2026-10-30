#!/usr/bin/env node
'use strict';
// p-noghost-e1: a commit or a reset of the arc branch under a train is refused by the session hook (cells A1-A10, B1-B7,
// C5, C8, C9, D1, D3, D4 of the analysis p-noghost-e). Case 2026-10-30: a commit of the coordinator in the arc's worktree
// (ab9ae807, 16:11) moved the arc under the green train K3a (15:56-16:12) -> arc-moved, 16 minutes lost.
//   A   the state of the lock: <sharedDir>/train/lock/owner.json of a live holder that names the arc (base) refuses a
//       command that moves the arc; no lock, a dead holder, no base, another base, a broken owner file, a halt without
//       a lock, a project without train/ - allowed. A10: train.js writes base into owner.json before the run, and
//       `train.js status` names the arc; the hook, run during a real train, refuses a commit in the arc's worktree.
//   B   the commands in the arc's worktree that move its current branch (git-commit(1), git-merge(1), git-pull(1),
//       git-rebase(1), git-cherry-pick(1), git-revert(1), git-am(1), git-reset(1) with a commit, checkout -B / switch -C
//       of the arc); the ones that do not move it are allowed; an unfinished rebase of the arc (head-name) counts.
//   C5  git -C <arc worktree> from elsewhere; C8 a commit on a task branch is allowed; C9 train.js itself is not git.
//   D   README, the coordinator's rule and skill, hooks.json and the hook's header name the refusal.
// Plus the review of p-noghost-d: train.js takes a full sha of 64 hex digits too (role-chain.js FULL_SHA), and the
// scope of the second review after a docs rejection names the resolved head (st.head), not the role's raw one.
// usage: node tests/noghost-e1.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));
const { decide } = require('../scripts/hooks/guard-bash');

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-e1-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const wArc = path.join(wts, 'w-arc'), wT1 = path.join(wts, 'w-t1');
const TD = path.join(shared, 'train'), LOCK = path.join(TD, 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
const src = (f) => read(path.join(ROOT, f)) || '';

// the hook's environment: no config named by the session, the project found from the directory (config.js find)
const henv = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const bash = (command, cwd = wArc) => decide({ tool_name: 'Bash', tool_input: { command }, cwd }, henv);
const refused = (r) => typeof r === 'string' && /train/.test(r);
const lock = (owner) => {
  fs.rmSync(LOCK, { recursive: true, force: true });
  if (owner === undefined) return;
  fs.mkdirSync(LOCK, { recursive: true });
  if (owner !== null) put(path.join(LOCK, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
};
const deadPid = () => { const r = spawnSync('true'); return r.pid; };
const LIVE = { pid: process.pid, host: os.hostname(), since: new Date().toISOString(), train: '20261030-155647439-1174', base: 'arc', wt: path.join(wts, 'train-20261030-155647439-1174') };

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
// memory probes of the slots, as in train.test.js: a calm machine
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// The guard command of the train (A10): while the train runs, it keeps the lock owner, the status and the hook's answer
// to a commit in the arc's worktree.
const hookIn = path.join(T, 'hook-in.json');
fs.writeFileSync(hookIn, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m fix' }, cwd: wArc }));
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
cp '${path.join(LOCK, 'owner.json')}' "$T/owner-at-run.json"
'${process.execPath}' '${TRAIN}' status > "$T/status-at-run.txt" 2>&1
'${process.execPath}' '${HOOK}' < "$T/hook-in.json" > "$T/hook-at-run.txt" 2>&1
echo "=== 9 passed in 0.1s ==="
exit 0
`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const cfgFile = path.join(main, '.claude', 'codis-agents.json');
put(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'], protectedTagPattern: '^v[0-9]',
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `cd {wt} && ${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });

// the workflow harness of tests/noghost-d.test.js, for the scope of the second review
const SRC = src('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json',
  guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const FM = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const FULL = '3fb1d6dd' + '0123456789abcdef0123456789abcdef';
const FULL2 = 'c0ffee00' + 'fedcba9876543210fedcba9876543210';
const unq = (s) => s.split("'\\''").join("'");
async function run(script, task, resolve) {
  const prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'sha') { const m = /rev-parse --verify -q '([^']*)\^\{commit\}'/.exec(unq(prompt)); const v = m && resolve[m[1]]; return v ? { sha: v } : { sha: '' }; }
    if (role === 'run') return /:train-/.test(opts.label) ? q.train.shift() : { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role);
    return q[role].shift();
  };
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], prompts };
}

(async () => {
  git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'core.hooksPath', '/dev/null');
  put(path.join(main, '.gitignore'), 'data/\n.claude/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc'); git(main, 'branch', 't1');
  git(main, 'worktree', 'add', '-q', wArc, 'arc');
  git(main, 'worktree', 'add', '-q', wT1, 't1');
  put(path.join(wArc, 'f.txt'), 'f\n');
  const base0 = rev('arc');

  // ---- A: the state of the lock (git commit in the arc's worktree) ----
  ok('A9. a project with no train/ at all -> git commit in the arc worktree allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  fs.mkdirSync(TD, { recursive: true });
  ok('A1. train/ without a lock -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(LIVE);
  const why = bash('git commit -m x');
  ok('A2. a live holder with base = arc -> git commit refused', refused(why), why);
  ok('A2. ... the reason names the arc, the train id, train.js status and the passenger path (train.js ride ... --base arc)',
    refused(why) && /\barc\b/.test(why) && why.includes(LIVE.train) && /train\.js"? status/.test(why) && /train\.js"? ride --task \S+ --branch \S+ --head (<full sha>|\S+) --base arc/.test(why), why);
  lock(Object.assign({}, LIVE, { base: 'other' }));
  ok('A3. a live holder with base = another branch -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  const noBase = Object.assign({}, LIVE); delete noBase.base;
  lock(noBase);
  ok('A4. a live holder without base (before the train chose it, an older dispatcher) -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(Object.assign({}, LIVE, { pid: deadPid() }));
  ok('A5. a dead holder (pid gone, no child, no group) -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(Object.assign({}, LIVE, { pid: deadPid(), child: process.pid }));
  ok('A5. a holder whose pid is gone but whose child lives -> refused (the same liveness as train.js)', refused(bash('git commit -m x')), bash('git commit -m x'));
  lock(null);
  ok('A6. a lock directory without owner.json -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock('{"pid": ');
  ok('A6. a broken owner.json -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  lock(undefined);
  put(path.join(TD, 'halt'), JSON.stringify({ reason: 'arc-red: x', at: new Date().toISOString(), verdict: 'arc-red' }));
  ok('A7. a halt and no lock (arc-red: the coordinator fixes the arc) -> allowed', bash('git commit -m x') === null, bash('git commit -m x'));
  fs.rmSync(path.join(TD, 'halt'), { force: true });
  lock(Object.assign({}, LIVE, { wt: path.join(wts, `train-${LIVE.train}-p1`) }));
  ok('A8. the lock held by the attribution of a red train (wt train-<id>-p1, base kept) -> refused', refused(bash('git commit -m x')), bash('git commit -m x'));

  // ---- B: commands in the arc's worktree under a live train of the arc ----
  lock(LIVE);
  const no = (c, d = wArc) => ok(`refused under the train: ${c}`, refused(bash(c, d)), bash(c, d));
  const yes = (c, d = wArc) => ok(`allowed under the train: ${c}`, bash(c, d) === null, bash(c, d));
  for (const c of ['git commit -m x', 'git commit --amend --no-edit', 'git status && git commit -m x', 'git commit -qam x']) no(c);   // B1
  for (const c of ['git merge t1', 'git merge --ff-only refs/runs/train/20261030-155647439-1174', 'git pull', 'git pull . t1']) no(c);   // B2
  for (const c of ['git rebase main', 'git cherry-pick t1', 'git revert --no-edit HEAD', 'git am p.patch', 'git merge --continue', 'git cherry-pick --continue']) no(c);   // B3
  for (const c of ['git reset --hard main', 'git reset main', 'git reset --soft HEAD', 'git reset -q --keep main']) no(c);   // B4
  for (const c of ['git reset -- f.txt', 'git reset', 'git reset --hard', 'git reset main -- f.txt', 'git reset f.txt', 'git reset -p']) yes(c);   // B4
  for (const c of ['git checkout -B arc main', 'git switch -C arc main', 'git switch --force-create=arc main', 'git checkout -qB arc main']) no(c);   // B5
  for (const c of ['git status', 'git log --oneline', 'git diff', 'git add f.txt', 'git stash', 'git commit --dry-run -m x', 'git merge --abort',
    'git rebase --abort', 'git cherry-pick --abort', 'git am --abort', 'git fetch', 'git checkout -B side main', 'git switch -c side2']) yes(c);   // B6

  // ---- C5, C8, C9 ----
  no(`git -C ${wArc} commit -m x`, wT1);   // C5
  no(`git -C ../w-arc reset --hard main`, wT1);   // C5, relative
  yes('git commit -m x', wT1);   // C8: a task branch in its own worktree
  yes('git merge main', wT1);
  yes(`node ${TRAIN} ride --task svc --branch svc --head ${'a'.repeat(40)} --base arc`);   // C9: the dispatcher is not git
  yes(`node ${TRAIN} status`);
  yes(`node "${TRAIN}" await --task svc --head ${'a'.repeat(40)}`);

  // ---- B7: an unfinished rebase of the arc (HEAD detached, head-name = refs/heads/arc) ----
  git(wT1, 'checkout', '-q', '-b', 'side', 'main');
  put(path.join(wT1, 'base.txt'), 'side\n'); git(wT1, 'commit', '-q', '-am', 'side');
  put(path.join(wArc, 'base.txt'), 'arc\n'); git(wArc, 'commit', '-q', '-am', 'arc change');
  fs.rmSync(path.join(wArc, 'f.txt'), { force: true });
  const rb = git(wArc, 'rebase', 'side');
  const detached = git(wArc, 'symbolic-ref', '-q', 'HEAD').status !== 0;
  ok('B7. fixture: a rebase of arc stopped on a conflict, HEAD detached', rb.status !== 0 && detached, rb.stdout + rb.stderr);
  no('git rebase --continue');
  no('git commit -m resolved');
  yes('git rebase --abort');
  yes('git status');
  git(wArc, 'rebase', '--abort');
  git(wArc, 'reset', '-q', '--hard', base0);
  git(wT1, 'checkout', '-q', 't1');
  ok('B7. fixture: the arc is back at its head', rev('arc') === base0);

  lock(undefined);
  ok('after the train: git commit in the arc worktree allowed again', bash('git commit -m x') === null, bash('git commit -m x'));

  // ---- A10: a real train writes base before the run; status names the arc; the hook refuses during the run ----
  if (!has('zsh')) skip('A10. train.js with guards-all.sh (a zsh script)', 'zsh not found');
  else {
    git(main, 'branch', '-f', 'p1', 'arc');
    const mk = path.join(T, 'mk-p1');
    git(main, 'worktree', 'add', '-q', mk, 'p1');
    put(path.join(mk, 'p1.txt'), 'p1\n'); git(mk, 'add', 'p1.txt'); git(mk, 'commit', '-q', '-m', 'p1');
    git(main, 'worktree', 'remove', '--force', mk);
    const p1 = rev('p1');
    let r = tr('enqueue', '--task', 'p1', '--branch', 'p1', '--head', p1, '--base', 'arc');
    ok('A10. fixture: p1 queued', r.status === 0, r.stdout + r.stderr);
    r = tr('run');
    let res = null; try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* checked below */ }
    ok('A10. fixture: the train ran green and moved the arc (merge --ff-only in its worktree)', res && res.verdict === 'green' && rev('arc') === res.sha, r.stdout + r.stderr);
    const o = readJ(path.join(T, 'owner-at-run.json'));
    ok('A10. owner.json during the run names the arc: base = arc (and the train id)', o && o.base === 'arc' && res && o.train === res.train, JSON.stringify(o));
    const st = read(path.join(T, 'status-at-run.txt')) || '';
    ok('A10. train.js status during the run: "lock: train <id> for arc arc ..."', res && st.includes(`lock: train ${res.train} for arc arc by pid`), st);
    let hk = null; try { hk = JSON.parse(read(path.join(T, 'hook-at-run.txt'))); } catch { /* checked below */ }
    ok('A10. the hook during the real train: git commit in the arc worktree denied',
      hk && hk.hookSpecificOutput && hk.hookSpecificOutput.permissionDecision === 'deny' && /train/.test(hk.hookSpecificOutput.permissionDecisionReason), read(path.join(T, 'hook-at-run.txt')));
    ok('A10. after the train the lock is free: commit allowed', !fs.existsSync(LOCK) && bash('git commit -m x') === null, bash('git commit -m x'));
    const s2 = tr('status');
    ok('A10. train.js status with no train: "lock: free"', /lock: free/.test(s2.stdout), s2.stdout);
  }

  // ---- review d: train.js takes a full sha of 64 hex digits (role-chain.js FULL_SHA, sha256 repositories) ----
  const h64 = 'ab'.repeat(32);
  const r64 = tr('enqueue', '--task', 'sha256', '--branch', 't1', '--head', h64, '--base', 'arc');
  ok('review d. train.js enqueue --head <64 hex> -> queued, not "head is not a full sha"', r64.status === 0 && !/not a full sha/.test(r64.stderr), `${r64.status} ${r64.stderr}`);
  for (const f of fs.readdirSync(path.join(TD, 'queue'))) if (f.includes('sha256')) fs.rmSync(path.join(TD, 'queue', f), { force: true });
  const r63 = tr('enqueue', '--task', 'sha256', '--branch', 't1', '--head', h64.slice(1), '--base', 'arc');
  ok('review d. 63 hex digits -> still "head is not a full sha", exit 64', r63.status === 64 && /not a full sha/.test(r63.stderr), `${r63.status} ${r63.stderr}`);

  // ---- review d: role-chain.js - the second review after a docs rejection names the resolved head ----
  const prog = (head) => ({ status: 'ready', changedFiles: ['README.md'], commits: ['c'], head, mutations: 'm', fullRun: 'r', questions: [], summary: 's' });
  // the full mode (reviewLoop): tester green, review 1 rejects for docs, the fix round reports its head abbreviated
  const x = await run({ pre: [{ ok: true, problems: [], blockingQuestions: [] }], prog: [prog(FULL), prog('c0ffee00')], test: [{ verdict: 'green', summary: '', head: FULL }],
    review: [{ verdict: 'rejected', docsOnly: true, summary: 'docs' }, { verdict: 'done', docsOnly: false, summary: 'fine' }],
    train: [{ done: true, rc: 0, seconds: 5, log: '/d/wait-train.log', tail: '' }] }, FM, { c0ffee00: FULL2 });
  const r2 = (x.prompts.filter((p) => p.role === 'review')[1] || { prompt: '' }).prompt;
  ok('review d. the second review\'s scope is git diff <before>..<the full head>, not the role\'s short head',
    x.r.status === 'done' && r2.includes(`git diff ${FULL}..${FULL2}`), `${x.r.status} ${r2.slice(0, 300)}`);

  // ---- D: docs in the same commit ----
  const readme = src('README.md'), rules = src('rules/multi-agent.md'), skill = src('skills/coordinator/SKILL.md');
  const hj = JSON.parse(src('hooks/hooks.json') || '{}'), head = src('scripts/hooks/guard-bash.js').split('\nconst ')[0];
  ok('D1. README: the hook refuses a commit or a reset of the arc under a train, "wait for the train: train.js status"',
    /under a (live )?train/i.test(readme) && /wait for the train/i.test(readme) && /train\.js status/.test(readme));
  ok('D1. README: a service change rides as a passenger: a service branch from the arc head, train.js ride ... --base <arc>',
    /service branch/i.test(readme) && /train\.js ride --task <svc> --branch <svc> --head <full sha> --base <arc>/.test(readme));
  ok('D1. README: owner.json names base, and status prints the arc', /\{pid, child, pgid, train, base, wt, since\}/.test(readme + src('scripts/train.js')) && /for arc <base>/.test(readme));
  ok('D3. rules/multi-agent.md: the coordinator\'s line - a service change into the arc under a train rides as a passenger or waits for "lock: free"; Why ab9ae807',
    /ab9ae807/.test(rules) && /passenger/.test(rules) && /lock: free/.test(rules));
  ok('D3. the rule line has no role marker', rules.split('\n').filter((l) => /ab9ae807/.test(l)).every((l) => !/<!-- role:/.test(l)));
  ok('D3. skills/coordinator: a service change into the arc under a train - passenger or after "lock: free"', /passenger/.test(skill) && /lock: free/.test(skill));
  ok('D4. hooks.json description names the refusal under a train', /train/.test(hj.description || ''), hj.description);
  ok('D4. guard-bash.js header names the refusal under a train', /train/.test(head) && /owner\.json/.test(head));
  ok('A10/D. train.js header: owner.json names base', /\{pid, child, pgid, train, base, wt, since\}/.test(src('scripts/train.js')));

  fs.rmSync(T, { recursive: true, force: true });
  done();
})();
