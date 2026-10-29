#!/usr/bin/env node
'use strict';
// scripts/train.js for the chain after the review (p-train-c3, cells W2-W4, W11, W14 of the analysis p-train-ac, and the
// coordinator's decisions for c3):
//   ride      enqueue + await in one call, the exit code is the verdict (the workflow reads no files: the wait step returns
//             the exit code): green 0, green-unmerged 10, red 11, seam 12, conflict 13, arc-red 14, coordinator 15, the
//             queue halted (the environment) 75, the queue unavailable 74, refused before the queue 65. A seam waits for
//             the result of its partner first, so its fix round starts on an arc head that holds the partner.
//   enqueue   refuses a base that is a protected branch (protectedBranches) or not a branch of the repository - before the
//             queue (65); a result already there for the task and head: printed, nothing queued; the same head queued:
//             kept; another head of the task: replaced (a relaunch attaches, W14).
//   halt      a stop "for the coordinator" (R5 several pairs, R8, more than three passengers, one passenger green alone,
//             a red train not attributed) carries the verdict coordinator; await prints it, not environment.
//   reapDead  removes the attribution refs refs/runs/train/<id>-<label> of a dead train, not only its worktree.
//   lock      the holder is alive while any process of its process group lives (an orphaned guard run whose dispatcher
//             and zsh are gone still holds it); a group that is the waiter's own is no evidence.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-ride-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train'), LOCK = path.join(TD, 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const wait = (ms) => new Promise((z) => setTimeout(z, ms));

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
echo "$PWD" >> "$T/calls.txt"
[ -f "$T/sleep" ] && sleep "$(cat "$T/sleep")"
echo "=== 9 passed in 0.1s ==="
exit 0
`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `cd {wt} && ${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 120000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f)));
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const setResult = (task, head, o) => put(path.join(TD, 'result', `${task}-${head}.json`), JSON.stringify(Object.assign({ task, head, branch: task, base: 'arc' }, o)));
const runRefs = () => git(main, 'for-each-ref', '--format=%(refname)', 'refs/runs/train').stdout.trim().split('\n').filter(Boolean);
const taskDir = (t) => { const d = path.join(T, 'tasks', t); fs.mkdirSync(d, { recursive: true }); return d; };
const args = (task, branch, head, base = 'arc') => ['--task', task, '--branch', branch, '--head', head, '--base', base, '--dir', taskDir(task)];
const branch = (name, file) => {
  git(main, 'branch', '-f', name, 'arc');
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  put(path.join(tmpWt, file), name + '\n');
  git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `${name}: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const pgidOf = (pid) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');

  // ---- W4: a protected base is refused before the queue ----
  const a = branch('a', 'f-a.txt');
  let r = tr('enqueue', ...args('a', 'a', a, 'main'));
  ok('W4 enqueue --base <protected branch> -> exit 65, nothing queued, the reason names the protected branch', r.status === 65 && !queue().length && /protected/.test(r.stderr), `${r.status} ${r.stderr}`);
  r = tr('ride', ...args('a', 'a', a, 'main'));
  ok('W4 ride --base <protected branch> -> exit 65, nothing queued', r.status === 65 && !queue().length, `${r.status} ${r.stderr}`);
  // ---- W3: a base that is not a branch of the repository (a commit, a missing branch) ----
  r = tr('enqueue', ...args('a', 'a', a, rev('arc')));
  ok('W3 enqueue --base <a commit sha> -> exit 65, not a branch, nothing queued', r.status === 65 && !queue().length && /not a branch/.test(r.stderr), `${r.status} ${r.stderr}`);
  r = tr('enqueue', ...args('a', 'a', a, 'no-such-arc'));
  ok('W3 enqueue --base <a missing branch> -> exit 65, nothing queued', r.status === 65 && !queue().length, `${r.status} ${r.stderr}`);

  // ---- W14: the guards of enqueue: a result already there; the same head queued; another head replaces ----
  setResult('d', a, { verdict: 'green', merged: a });
  r = tr('enqueue', ...args('d', 'a', a));
  ok('W14 enqueue with a result for the task and head already there -> decided, prints it, nothing queued',
    r.status === 0 && last(r) && last(r).decided === true && last(r).result.verdict === 'green' && !queue().length, r.stdout + r.stderr);
  r = tr('enqueue', ...args('e', 'a', a));
  const f1 = last(r) && last(r).queued;
  r = tr('enqueue', ...args('e', 'a', a));
  ok('W14 the same task and head again -> the existing entry, still one', r.status === 0 && last(r).existing === true && last(r).queued === f1 && queue().length === 1, r.stdout);
  const b = branch('b', 'f-b.txt');
  r = tr('enqueue', ...args('e', 'b', b));
  ok('W14 another head of the same task -> replaces the entry (one, with the new head)', r.status === 0 && queue().length === 1 && queue()[0].head === b, JSON.stringify(queue()));
  fs.rmSync(path.join(TD, 'queue'), { recursive: true, force: true });

  // ---- ride: the exit code is the verdict ----
  for (const [v, rc] of [['green', 0], ['green-unmerged', 10], ['red', 11], ['conflict', 13]]) {
    setResult(`v-${v}`, a, { verdict: v });
    r = tr('ride', ...args(`v-${v}`, 'a', a));
    ok(`ride: a result ${v} -> exit ${rc}, the result JSON on the last line`, r.status === rc && last(r) && last(r).verdict === v, `${r.status} ${r.stdout}${r.stderr}`);
  }
  // seam: waits for the partner's result first, then exit 12 with it
  setResult('s1', b, { verdict: 'green', merged: b });
  setResult('s2', a, { verdict: 'seam', partner: 's1', partnerBranch: 'b', partnerHead: b });
  r = tr('ride', ...args('s2', 'a', a));
  ok('W10 ride: seam -> exit 12, the partner\'s result attached (its verdict)', r.status === 12 && last(r) && last(r).verdict === 'seam' && last(r).partnerResult && last(r).partnerResult.verdict === 'green', `${r.status} ${r.stdout}${r.stderr}`);
  setResult('s3', a, { verdict: 'seam', partner: 'gone', partnerBranch: 'gone' });
  r = tr('ride', ...args('s3', 'a', a));
  ok('W10 ride: seam without a partner head -> exit 12 at once', r.status === 12, `${r.status} ${r.stdout}${r.stderr}`);
  // a real green train through ride
  r = tr('ride', ...args('g', 'a', a));
  ok('W5 ride: a ready branch, no train in transit -> the train leaves, green, exit 0, the arc moved', r.status === 0 && last(r) && last(r).verdict === 'green' && rev('arc') === last(r).merged, `${r.status} ${r.stdout}${r.stderr}`);
  ok('ride: the green result names the merged commit', result('g', a) && result('g', a).merged === rev('arc'));

  // ---- the halt: environment 75, arc-red 14, coordinator 15; the entry stays ----
  const c = branch('c', 'f-c.txt');
  for (const [h, rc] of [[{ reason: 'environment: guards-all.sh exit 69' }, 75], [{ reason: 'arc-red: g', verdict: 'arc-red' }, 14], [{ reason: 'the coordinator decides', verdict: 'coordinator' }, 15]]) {
    put(path.join(TD, 'halt'), JSON.stringify(h));
    r = tr('ride', ...args('c', 'c', c));
    ok(`W11 ride under a halt ${h.verdict || '(no verdict)'} -> exit ${rc}, the entry stays`, r.status === rc && queue().some((e) => e.task === 'c' && e.head === c), `${r.status} ${r.stdout}${r.stderr}`);
  }
  r = tr('await', '--task', 'c', '--head', c);
  ok('W11 await under the halt of the coordinator prints the verdict coordinator, not environment', r.status === 0 && last(r) && last(r).verdict === 'coordinator', r.stdout);
  fs.rmSync(path.join(TD, 'halt'));
  fs.rmSync(path.join(TD, 'queue'), { recursive: true, force: true });

  // ---- W2: the queue unavailable -> 74, the head named ----
  const sh2 = path.join(T, 'shared2'), cfg2 = path.join(T, 'cfg2.json');
  put(path.join(sh2, 'train'), 'a file where the train directory should be');
  fs.writeFileSync(cfg2, JSON.stringify(Object.assign(readJ(cfgFile), { sharedDir: sh2 })));
  const r2 = spawnSync(process.execPath, [TRAIN, 'ride', ...args('q', 'c', c)], { cwd: T, encoding: 'utf8', env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg2 }), timeout: 60000 });
  ok('W2 ride with the queue unavailable -> exit 74, the reason names the queue and the head', r2.status === 74 && /queue/.test(r2.stderr) && r2.stderr.includes(c), `${r2.status} ${r2.stderr}`);
  const r3 = spawnSync(process.execPath, [TRAIN, 'enqueue', ...args('q', 'c', c)], { cwd: T, encoding: 'utf8', env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg2 }), timeout: 60000 });
  ok('W2 enqueue with the queue unavailable -> exit 74', r3.status === 74, `${r3.status} ${r3.stderr}`);

  // ---- reapDead removes the attribution refs of a dead train ----
  git(main, 'update-ref', 'refs/runs/train/deadid-p1', 'arc');
  git(main, 'update-ref', 'refs/runs/train/deadid-p1p2', 'arc');
  git(main, 'update-ref', 'refs/runs/train/otherid-p1', 'arc');
  const dp = deadPid();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: dp, child: dp, train: 'deadid', wt: path.join(wts, 'train-deadid-p1'), since: new Date().toISOString() }));
  r = tr('run');
  const refs = runRefs();
  ok('reapDead: the attribution refs of the dead train are removed', !refs.includes('refs/runs/train/deadid-p1') && !refs.includes('refs/runs/train/deadid-p1p2'), refs.join());
  ok('reapDead: the refs of another train are kept', refs.includes('refs/runs/train/otherid-p1'), refs.join());

  // ---- the lock holder alive by its process group ----
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const sg = pgidOf(sleeper.pid);
  const d = branch('dd', 'f-dd.txt');
  tr('enqueue', ...args('dd', 'dd', d));
  const dp2 = deadPid();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: dp2, child: dp2, pgid: sg, train: 'orphan', since: new Date().toISOString() }));
  r = tr('run');
  ok('lock: pid and child gone, a process of the holder\'s group alive -> busy, nothing leaves', last(r) && last(r).busy === true && !result('dd', d), r.stdout + r.stderr);
  sleeper.kill('SIGKILL');
  for (let i = 0; i < 50 && alive(sleeper.pid); i++) await wait(100);
  r = tr('run');
  ok('lock: the group gone too -> the lock is broken, dd rides', last(r) && last(r).departed === true && result('dd', d) && result('dd', d).verdict === 'green', r.stdout + r.stderr);
  // a group that is the waiter's own (both started by this test) is no evidence of the holder
  const e2 = branch('ee', 'f-ee.txt');
  tr('enqueue', ...args('ee', 'ee', e2));
  const dp3 = deadPid();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: dp3, child: dp3, pgid: pgidOf(process.pid), train: 'same', since: new Date().toISOString() }));
  r = tr('run');
  ok('lock: the holder\'s group is the waiter\'s own -> not counted, the lock is broken, ee rides', last(r) && last(r).departed === true && result('ee', e2), r.stdout + r.stderr);
  // a real dispatcher writes its group into owner.json
  const f2 = branch('ff', 'f-ff.txt');
  tr('enqueue', ...args('ff', 'ff', f2));
  fs.writeFileSync(path.join(T, 'sleep'), '3');
  fs.rmSync(path.join(T, 'calls.txt'), { force: true });
  const ch = spawn(process.execPath, [TRAIN, 'run'], { cwd: T, env, stdio: 'ignore' });
  const closed = new Promise((z) => ch.on('close', z));
  for (let i = 0; i < 150 && !fs.existsSync(path.join(T, 'calls.txt')); i++) await wait(100);
  const own = readJ(path.join(LOCK, 'owner.json')) || {};
  await closed;
  fs.rmSync(path.join(T, 'sleep'), { force: true });
  ok('lock: the dispatcher names its process group in owner.json', Number.isInteger(own.pgid) && own.pgid > 1 && own.pgid === pgidOf(process.pid), JSON.stringify(own));
}

main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
});
