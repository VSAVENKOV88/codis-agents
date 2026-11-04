#!/usr/bin/env node
'use strict';
// p-verdict-orphan-a: a train verdict for a stopped chain is not lost (cells 1-27 of the part a of the diagnosis
// p-verdict-orphan, section "after the check"). A ride or an await of its own entry writes a waiter file
// train/waiters/<task>-<head>-<pid>.json {pid, procStart, state: waiting | claimed | left, at}; it marks it on its exit
// (claimed when it took its own result, else left) and never removes it then. A result R(task, head) is a verdict
// without an addressee when: R is not taken (no claimedAt, no ack); there is at least one waiter file of (task, head);
// none of them is waiting with a live process (pid alive and its start time, now - etime of `LC_ALL=C ps`, within 2 s of
// procStart); R is not superseded (another head of the task with a later enqueuedAt). `status` names such verdicts
// after its halt/lock/queue lines, `resume` names the entries without a live waiter, `ack` takes a verdict by hand,
// `watch` (the coordinator's background wait) dispatches like any waiter and ends on a new verdict without an addressee
// or on a new halt that leaves an entry without a live waiter.
//   T1  S1: halt -> ride 75 -> resume -> a train by another process, red -> status names it; before the train the entry
//       says "no live waiter"                                                                   (cell 1)
//   T2  watch running when the verdict comes -> exit 0 with {orphans: [...]}                    (cell 2)
//   T3  green (merged sha into arc), green-unmerged (the ref to merge), conflict (files)         (cells 3-5)
//   T4  S2 the train of the ride itself falls (69); S4 arc-red 14; S5 coordinator 15            (cells 6, 8, 9)
//   T5  seam: own seam with the partner's halt -> 75, own seam an orphan; no waiter file for the partner (cells 7a, 7b)
//   T6  a waiting ride killed by SIGTERM and SIGKILL -> the file stays waiting, the verdict an orphan (cells 10, 11)
//   T7  a live ride: not an orphan, watch does not end, status "waiter pid N alive"; then R taken (cell 13)
//   T8  74, 65, 64: no waiter file, no section for them; control: an orphan of S1 is named      (cell 15)
//   T9  superseded by a later head; old results without waiter files are no orphans            (cells 16, 17)
//   T10 a ride of the same head takes the orphan; ack takes one; ack without R -> 66            (cells 19, 20)
//   T11 resume names the entries without a live waiter                                         (cell 21)
//   T12 an entry without a waiter and no ride: watch drives the train and ends with its verdict (cell 22)
//   T13 a ride attached to the entry during the train; two rides of one head, one killed       (cells 23, 24)
//   T18 a reused pid (procStart an hour before the live process), LANG=ru_RU.UTF-8 and LANG=C  (cell 12)
//   T19 the order of the claim: a pause between claimedAt and the mark - watch does not end     (cell 14)
//   T20 an entry of an older ride (no waiter file ever) is no orphan; with a left file it is    (cell 18)
//   T21 a new halt: an entry without a live waiter -> watch ends {halt, entriesWithoutWaiter};
//       every entry with a live waiter -> watch does not end, the rides leave with 75          (cells 25, 26)
//   T22 an orphan that was there before watch started does not end it; a new one does          (cell 27)
// tests:quiet - processes, a lock and polling under a timer: red under load
// usage: node tests/p-verdict-orphan.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js waiters (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-orphan-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train'), LOCK = path.join(TD, 'lock'), WD = path.join(TD, 'waiters');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const wait = (ms) => new Promise((z) => setTimeout(z, ms));
const waitFor = async (cond, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (cond()) return true; await wait(100); } return !!cond(); };

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// The project's guard runner (as tests/train-attribution.test.js): guards are lines "name|condition" of $T/rules, red
// when the condition holds in the worktree; $T/env69 makes the full run exit 69 (the environment).
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
SUBSET=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --subset) SUBSET=1;; --only) ONLY="$ONLY $2"; shift;; esac; shift; done
[ "$SUBSET" = 0 ] && [ -f "$T/env69" ] && { echo "environment: the runner is unreachable"; exit 69; }
failed=0; passed=0
while IFS='|' read -r name cond; do
  [ -n "$name" ] || continue
  if [ -n "$ONLY" ]; then case "$ONLY " in *" $name "*) ;; *) continue;; esac; fi
  if sh -c "$cond"; then echo "FAILED $name - red"; failed=$((failed+1)); else echo "PASSED $name"; passed=$((passed+1)); fi
done < "$T/rules"
echo "=== $failed failed, $passed passed, $((failed+passed)) total in 0.1s ==="
[ "$failed" = 0 ]
`);
const G = path.join(T, 'guard.sh');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
  guardCommand: `cd {wt} && ${G}`,
  guardSubsetCommand: `cd {wt} && ${G} --subset {onlyArgs}`,
  guardRerun: { command: `cd {wt} && ${G} --only {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .*?(\\d+) total in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR', 'CODIS_TRAIN_CLAIM_PAUSE', 'LC_ALL']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 300000 });
const trE = (extra, ...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env: Object.assign({}, env, extra), timeout: 300000 });
// a train.js process in the background: {p, out, code (undefined while it runs), closed}
const bg = (a, extra = {}) => {
  const p = spawn(process.execPath, [TRAIN, ...a], { cwd: T, env: Object.assign({}, env, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  const o = { p, out: '', err: '', code: undefined };
  p.stdout.on('data', (x) => { o.out += x; }); p.stderr.on('data', (x) => { o.err += x; });
  o.closed = new Promise((z) => p.on('close', (c, s) => { o.code = c === null ? s : c; z(); }));
  return o;
};
const lastJ = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };
const stop = async (o) => { if (o.code === undefined) { o.p.kill('SIGKILL'); await o.closed; } };
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f))).filter(Boolean);
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const halt = (o) => put(path.join(TD, 'halt'), JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)));
const waiterFiles = (task, head) => ls(WD).filter((f) => f.startsWith(`${task}-${head}-`) && f.endsWith('.json')).map((f) => readJ(path.join(WD, f)));
const putWaiter = (task, head, pid, o) => put(path.join(WD, `${task}-${head}-${pid}.json`), JSON.stringify(Object.assign({ pid, procStart: Date.now(), state: 'left', at: new Date().toISOString() }, o)));
const setResult = (task, head, o) => put(path.join(TD, 'result', `${task}-${head}.json`), JSON.stringify(Object.assign({ task, head, branch: task, base: 'arc', train: 'synthetic' }, o)));
const status = () => tr('status').stdout;
// the section of status after its halt/lock/queue lines: the lines from "verdicts without an addressee"
const orphanSection = (s) => { const i = s.indexOf('verdicts without an addressee'); return i < 0 ? '' : s.slice(i); };
const orphanLine = (s, task, head) => orphanSection(s).split('\n').find((l) => l.includes(` ${task} ${head} `) || l.trim().startsWith(`${task} ${head} `)) || '';
const taskDir = (t) => { const d = path.join(T, 'tasks', t); fs.mkdirSync(d, { recursive: true }); return d; };
const args = (task, head, br = task, base = 'arc') => ['--task', task, '--branch', br, '--head', head, '--base', base, '--dir', taskDir(task)];
const rules = (o) => fs.writeFileSync(path.join(T, 'rules'), Object.entries(Object.assign({ 'g-ok': 'false' }, o)).map(([k, v]) => `${k}|${v}`).join('\n') + '\n');
const branch = (name, files, from = 'arc') => {
  git(main, 'branch', '-f', name, from);
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  for (const f of files) put(path.join(tmpWt, f), `${name}\n`);
  git(tmpWt, 'add', ...files); git(tmpWt, 'commit', '-q', '-m', `${name}: ${files.join(' ')}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
const arcCommit = (file, text) => {
  const tmpWt = path.join(T, 'mk-arc');
  git(main, 'worktree', 'add', '-q', tmpWt, 'arc');
  put(path.join(tmpWt, file), text); git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `arc: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev('arc');
};
// A live holder of the train lock (a sleep of its own group): nobody dispatches until it is released.
const holdLock = () => {
  const s = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: s.pid, since: new Date().toISOString() }));
  return async () => { s.kill('SIGKILL'); await waitFor(() => !alive(s.pid), 10000); };
};
// a ride that stopped with 75 under a halt and left its entry: the case of cvy-text-reader-1
const strand = (task, head) => { halt({ reason: 'environment: guards-all.sh exit 69 on train t0' }); const r = tr('ride', ...args(task, head)); tr('resume'); return r; };
const SHA = (c) => c.repeat(40);

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  rules({});

  // ---- T1, T2: S1 - halt, ride 75, resume, a train by another process, red ----
  rules({ 'g-r1': '[ -f red-r1.txt ]' });
  const r1 = branch('r1', ['f-r1.txt', 'red-r1.txt']);
  halt({ reason: 'environment: guards-all.sh exit 69 on train t0' });
  const w1 = bg(['watch']);
  await wait(500);
  let r = tr('ride', ...args('r1', r1));
  ok('T1 ride under a halt of the environment -> exit 75, the entry stays (as 0.4.21)', r.status === 75 && queue().some((e) => e.task === 'r1'), `${r.status} ${r.stderr}`);
  const wf1 = waiterFiles('r1', r1);
  ok('T1 the ride wrote its waiter file and marked it left on its exit (not removed)', wf1.length === 1 && wf1[0].state === 'left' && Number.isInteger(wf1[0].pid) && typeof wf1[0].procStart === 'number', JSON.stringify(wf1));
  let st = status();
  ok('T1 before the train: the queue line of the entry says "no live waiter"', st.split('\n').some((l) => l.includes(`r1 r1 ${r1}`) && /no live waiter/.test(l)), st);
  ok('T21/T1 the halt that was there when watch started does not end it (the ride reported it with 75)', w1.code === undefined, `${w1.code} ${w1.out}`);
  tr('resume');
  r = tr('run');
  await waitFor(() => result('r1', r1));
  await waitFor(() => w1.code !== undefined, 10000);
  st = status();
  const R1 = result('r1', r1) || {};
  ok('T1 the verdict red came for a ride that is gone', R1.verdict === 'red', JSON.stringify(R1));
  ok('T1 status: "verdicts without an addressee" names r1, its head, red, its train and the result file',
    / r1 /.test(` ${orphanLine(st, 'r1', r1)} `) && /\bred\b/.test(orphanLine(st, 'r1', r1)) && orphanLine(st, 'r1', r1).includes(`train ${R1.train}`)
      && orphanLine(st, 'r1', r1).includes(path.join(TD, 'result', `r1-${r1}.json`)), st);
  ok('T1 the lines halt:, lock:, queue: come first, the new section after them', /^halt: none\nlock: free\nqueue: 0\n/.test(st) && st.indexOf('verdicts without an addressee') > st.indexOf('queue:'), st);
  ok('T1 the result carries the enqueuedAt of its entry', typeof R1.enqueuedAt === 'string' && !isNaN(Date.parse(R1.enqueuedAt)), JSON.stringify(R1));
  await waitFor(() => w1.code !== undefined, 10000);
  const j1 = lastJ(w1.out);
  ok('T2 watch ends 0 with {orphans: [{task, head, verdict, result}]} once the verdict without an addressee comes',
    w1.code === 0 && j1 && Array.isArray(j1.orphans) && j1.orphans.length === 1 && j1.orphans[0].task === 'r1' && j1.orphans[0].head === r1
      && j1.orphans[0].verdict === 'red' && j1.orphans[0].result === path.join(TD, 'result', `r1-${r1}.json`), `${w1.code} ${w1.out} ${w1.err}`);
  await stop(w1);

  // ---- T8: 74, 65, 64 leave no waiter file and no section line; the control orphan r1 is named ----
  rules({});
  const p65 = branch('p65', ['f-p65.txt']);
  r = tr('ride', ...args('p65', p65, 'p65', 'main'));
  ok('T8 ride 65 (a protected base): no waiter file', r.status === 65 && !ls(WD).some((f) => f.startsWith('p65-')), `${r.status} ${ls(WD)}`);
  r = tr('ride', ...args('p64', 'abc123'));
  ok('T8 ride 64 (not a full sha): no waiter file', r.status === 64 && !ls(WD).some((f) => f.startsWith('p64-')), `${r.status} ${ls(WD)}`);
  const sh2 = path.join(T, 'shared2'), cfg2 = path.join(T, 'cfg2.json');
  put(path.join(sh2, 'train'), 'a file where the train directory should be');
  fs.writeFileSync(cfg2, JSON.stringify(Object.assign(readJ(cfgFile), { sharedDir: sh2 })));
  r = trE({ CODIS_AGENTS_CONFIG: cfg2 }, 'ride', ...args('p74', p65, 'p65'));
  ok('T8 ride 74 (the queue unavailable): exit 74', r.status === 74, `${r.status} ${r.stderr}`);
  st = status();
  ok('T8 status names no verdict of 74/65/64; control: the orphan r1 of S1 is named', !/p6[45]|p74/.test(orphanSection(st)) && !!orphanLine(st, 'r1', r1), st);

  // ---- T10: a ride of the same head takes the orphan; ack; ack without a result ----
  r = tr('ride', ...args('r1', r1));
  const R1b = result('r1', r1) || {};
  ok('T10 ride of the same head after the orphan -> its verdict as the exit code (red 11)', r.status === 11, `${r.status} ${r.stdout}`);
  ok('T10 the result is taken (claimedAt) and gone from status; the waiter files of (r1, head) removed',
    typeof R1b.claimedAt === 'string' && !orphanLine(status(), 'r1', r1) && waiterFiles('r1', r1).length === 0, `${JSON.stringify(R1b)} ${ls(WD)}`);
  const ak = branch('ak', ['f-ak.txt']);
  strand('ak', ak); tr('run');
  ok('T10 control: the orphan ak is named before ack', !!orphanLine(status(), 'ak', ak), status());
  r = tr('ack', '--task', 'ak', '--head', ak);
  ok('T10 ack --task --head -> exit 0, the verdict taken and gone from status',
    r.status === 0 && typeof (result('ak', ak) || {}).claimedAt === 'string' && !orphanLine(status(), 'ak', ak) && waiterFiles('ak', ak).length === 0, `${r.status} ${r.stdout}${r.stderr}`);
  r = tr('ack', '--task', 'nope', '--head', SHA('e'));
  ok('T10 ack without a result -> exit 66 with its text', r.status === 66 && /no result/.test(r.stderr), `${r.status} ${r.stderr}`);

  // ---- T3: green (merged into arc) + conflict (files) in one train; green-unmerged (the ref) ----
  const gA = branch('ga', ['f-ga.txt']);
  const cf = branch('cf', ['base.txt']);
  arcCommit('base.txt', 'arc changed it\n');
  strand('ga', gA); strand('cf', cf);
  r = tr('run');
  st = status();
  const RG = result('ga', gA) || {}, RC = result('cf', cf) || {};
  ok('T3 green without an addressee: status names "merged <sha> into arc"', RG.verdict === 'green' && orphanLine(st, 'ga', gA).includes(`merged ${RG.merged} into arc`), `${JSON.stringify(RG)}\n${st}`);
  ok('T3 conflict without an addressee: status names the files', RC.verdict === 'conflict' && /files base\.txt/.test(orphanLine(st, 'cf', cf)), `${JSON.stringify(RC)}\n${st}`);
  const gu = branch('gu', ['f-gu.txt']);
  const wArc = path.join(T, 'w-arc');
  git(main, 'worktree', 'add', '-q', wArc, 'arc');
  put(path.join(wArc, 'base.txt'), 'dirty\n');
  strand('gu', gu); tr('run');
  const RU = result('gu', gu) || {};
  st = status();
  ok('T3 green-unmerged without an addressee: status names the ref to merge', RU.verdict === 'green-unmerged' && orphanLine(st, 'gu', gu).includes(RU.ref) && /refs\/runs\/train\//.test(RU.ref || ''), `${JSON.stringify(RU)}\n${st}`);
  git(main, 'worktree', 'remove', '--force', wArc);
  for (const [t, h] of [['ga', gA], ['cf', cf], ['gu', gu]]) tr('ack', '--task', t, '--head', h);

  // ---- T4: S2 (the ride's own train falls, 69), S4 arc-red 14, S5 coordinator 15 ----
  const s2 = branch('s2', ['f-s2.txt']);
  fs.writeFileSync(path.join(T, 'env69'), '');
  r = tr('ride', ...args('s2', s2));
  ok('T4 S2: the ride drives its train, the run exits 69 -> ride 75, the entry stays', r.status === 75 && queue().some((e) => e.task === 's2'), `${r.status} ${r.stdout}`);
  ok('T4 S2: after the ride left, the entry has no live waiter', status().split('\n').some((l) => l.includes(`s2 s2 ${s2}`) && /no live waiter/.test(l)), status());
  fs.rmSync(path.join(T, 'env69'));
  tr('resume');
  const s4 = branch('s4', ['f-s4.txt']), s5 = branch('s5', ['f-s5.txt']);
  halt({ reason: 'arc-red: g-arc', verdict: 'arc-red' });
  r = tr('ride', ...args('s4', s4));
  ok('T4 S4: ride under arc-red -> 14', r.status === 14, `${r.status}`);
  tr('resume');
  halt({ reason: 'the coordinator decides', verdict: 'coordinator' });
  r = tr('ride', ...args('s5', s5));
  ok('T4 S5: ride under the halt of the coordinator -> 15', r.status === 15, `${r.status}`);
  tr('resume');
  tr('run');
  st = status();
  ok('T4 S2, S4, S5: after resume and a train each verdict is without an addressee',
    !!orphanLine(st, 's2', s2) && !!orphanLine(st, 's4', s4) && !!orphanLine(st, 's5', s5), st);
  for (const [t, h] of [['s2', s2], ['s4', s4], ['s5', s5]]) tr('ack', '--task', t, '--head', h);

  // ---- T5: seam: own seam, the partner's train halted -> 75; own seam an orphan; no waiter file for the partner ----
  const sp = branch('sp', ['f-sp.txt']), sx = branch('sx', ['f-sx.txt']);
  strand('sp', sp);
  ok('T5 the partner sp waits in the queue with its own left file', queue().some((e) => e.task === 'sp') && waiterFiles('sp', sp).length === 1, ls(WD).join());
  setResult('sx', sx, { verdict: 'seam', partner: 'sp', partnerBranch: 'sp', partnerHead: sp, enqueuedAt: new Date().toISOString() });
  halt({ reason: 'environment: guards-all.sh exit 69 on train t5' });
  r = tr('ride', ...args('sx', sx));
  ok('T5 7a: own seam, the partner\'s train halted -> 75 (as 0.4.21)', r.status === 75, `${r.status} ${r.stdout}`);
  ok('T5 7a: own seam is not taken (no claimedAt), own waiter file left', !(result('sx', sx) || {}).claimedAt && waiterFiles('sx', sx).length === 1 && waiterFiles('sx', sx)[0].state === 'left', JSON.stringify(waiterFiles('sx', sx)));
  ok('T5 7b: the wait for the partner wrote no waiter file of the ride for (sp, headP)', waiterFiles('sp', sp).length === 1 && waiterFiles('sp', sp)[0].pid !== (waiterFiles('sx', sx)[0] || {}).pid, ls(WD).join());
  st = status();
  ok('T5 7a: status names own seam without an addressee, with its partner', /seam/.test(orphanLine(st, 'sx', sx)) && /partner sp/.test(orphanLine(st, 'sx', sx)), st);
  tr('resume'); tr('run');
  st = status();
  ok('T5 7b: the partner\'s ride is gone -> its verdict without an addressee too, and not taken by the seam wait', !!orphanLine(st, 'sp', sp) && !(result('sp', sp) || {}).claimedAt, st);
  for (const [t, h] of [['sx', sx], ['sp', sp]]) tr('ack', '--task', t, '--head', h);

  // ---- T6: a waiting ride killed by SIGTERM and by SIGKILL ----
  let release = holdLock();
  const k1 = branch('k1', ['f-k1.txt']), k2 = branch('k2', ['f-k2.txt']);
  const rk1 = bg(['ride', ...args('k1', k1)]), rk2 = bg(['ride', ...args('k2', k2)]);
  await waitFor(() => waiterFiles('k1', k1).length && waiterFiles('k2', k2).length, 15000);
  ok('T6 a waiting ride: its file is waiting, status "waiter pid N alive"', (waiterFiles('k1', k1)[0] || {}).state === 'waiting' && status().split('\n').some((l) => l.includes(`k1 k1 ${k1}`) && l.includes(`waiter pid ${rk1.p.pid} alive`)), `${ls(WD)}\n${status()}`);
  rk1.p.kill('SIGTERM'); rk2.p.kill('SIGKILL');
  await rk1.closed; await rk2.closed;
  ok('T6 killed: the files stay waiting with a dead pid', (waiterFiles('k1', k1)[0] || {}).state === 'waiting' && (waiterFiles('k2', k2)[0] || {}).state === 'waiting', ls(WD).join());
  await release();
  tr('run');
  st = status();
  ok('T6 S6 SIGTERM and S8 SIGKILL: each verdict is without an addressee', !!orphanLine(st, 'k1', k1) && !!orphanLine(st, 'k2', k2), st);
  for (const [t, h] of [['k1', k1], ['k2', k2]]) tr('ack', '--task', t, '--head', h);

  // ---- T7: a live ride is not an orphan; watch does not end on it; control: an orphan of another task ends it ----
  release = holdLock();
  const l1 = branch('l1', ['f-l1.txt']);
  const w7 = bg(['watch']);
  const rl1 = bg(['ride', ...args('l1', l1)]);
  await waitFor(() => waiterFiles('l1', l1).length, 15000);
  await wait(1200);
  ok('T7 a live ride waiting: watch has not ended after 3 polls', w7.code === undefined, `${w7.code} ${w7.out}`);
  ok('T7 status: the entry line says "waiter pid N alive"', status().split('\n').some((l) => l.includes(`l1 l1 ${l1}`) && l.includes(`waiter pid ${rl1.p.pid} alive`)), status());
  // R arrives while the ride lives (a train of another process): not an orphan
  const o7 = SHA('7');
  putWaiter('o7', o7, 999999, { state: 'left' });
  setResult('o7', o7, { verdict: 'red', enqueuedAt: new Date().toISOString() });
  await waitFor(() => w7.code !== undefined, 10000);
  const j7 = lastJ(w7.out);
  ok('T7 control: a verdict without an addressee of another task ends watch, l1 not in it', w7.code === 0 && j7 && j7.orphans && j7.orphans.map((o) => o.task).join() === 'o7', `${w7.code} ${w7.out}`);
  await release();
  await rl1.closed;
  ok('T7 the ride drives its train and takes its verdict: exit 0, claimedAt, its waiter files removed',
    rl1.code === 0 && typeof (result('l1', l1) || {}).claimedAt === 'string' && waiterFiles('l1', l1).length === 0 && !orphanLine(status(), 'l1', l1), `${rl1.code} ${rl1.out} ${ls(WD)}`);
  tr('ack', '--task', 'o7', '--head', o7);

  // ---- T19: the order of the claim: claimedAt first, then the mark - no window for a false orphan ----
  const c19 = branch('c19', ['f-c19.txt']);
  setResult('c19', c19, { verdict: 'green', enqueuedAt: new Date().toISOString() });
  const w19 = bg(['watch']);
  await wait(600);
  const rc19 = bg(['ride', ...args('c19', c19)], { CODIS_TRAIN_CLAIM_PAUSE: '2' });
  await rc19.closed;
  await wait(900);
  ok('T19 ride with a pause between the claim and the mark: exit 0, the result taken', rc19.code === 0 && typeof (result('c19', c19) || {}).claimedAt === 'string', `${rc19.code} ${rc19.out}${rc19.err}`);
  ok('T19 watch did not end in that window (no false verdict without an addressee)', w19.code === undefined, `${w19.code} ${w19.out}`);
  await stop(w19);

  // ---- T9: superseded by a later head; old results without waiter files ----
  const v1 = SHA('1'), v2 = SHA('2');
  const t0 = Date.now();
  putWaiter('sup', v1, 999998, { state: 'left' });
  setResult('sup', v1, { verdict: 'red', enqueuedAt: new Date(t0 - 60000).toISOString() });
  ok('T9 control: without a later head the old verdict is without an addressee', !!orphanLine(status(), 'sup', v1), status());
  setResult('sup', v2, { verdict: 'green', enqueuedAt: new Date(t0).toISOString(), claimedAt: new Date().toISOString() });
  ok('T9 a result of another head with a later enqueuedAt supersedes it: not named', !orphanLine(status(), 'sup', v1), status());
  fs.rmSync(path.join(TD, 'result', `sup-${v2}.json`));
  put(path.join(TD, 'queue', `${String(t0).padStart(13, '0')}-sup.json`), JSON.stringify({ task: 'sup', branch: 'sup', head: v2, base: 'arc', dir: '', enqueuedAt: new Date(t0).toISOString() }));
  ok('T9 an entry of another head with a later enqueuedAt supersedes it too', !orphanLine(status(), 'sup', v1), status());
  fs.rmSync(path.join(TD, 'queue', `${String(t0).padStart(13, '0')}-sup.json`));
  fs.rmSync(path.join(TD, 'result', `sup-${v1}.json`));
  // the real path: enqueue of a new head removes the waiter files of the other heads of the task
  const n1 = branch('n1', ['f-n1.txt']);
  strand('n1', n1);
  const n2 = branch('n1b', ['f-n1b.txt']);
  r = tr('enqueue', ...args('n1', n2, 'n1b'));
  ok('T9 enqueue of a new head removes the waiter files of the old head', r.status === 0 && waiterFiles('n1', n1).length === 0, ls(WD).join());
  fs.rmSync(path.join(TD, 'queue'), { recursive: true, force: true });
  for (const c of 'abcd') setResult('old', SHA(c), { verdict: c === 'a' ? 'red' : 'green' });
  const o9 = SHA('9'); putWaiter('o9', o9, 999997, { state: 'left' }); setResult('o9', o9, { verdict: 'red', enqueuedAt: new Date().toISOString() });
  st = status();
  ok('T9 old results without waiter files (as the 45 real ones) are not named; control: o9 is', !/ old /.test(` ${orphanSection(st)} `) && !!orphanLine(st, 'o9', o9), st);

  // ---- T22: an orphan there before watch started does not end it; a new one does ----
  const w22 = bg(['watch']);
  await wait(1200);
  ok('T22 the orphan o9 that was there at the start does not end watch; status still names it', w22.code === undefined && !!orphanLine(status(), 'o9', o9), `${w22.code} ${w22.out}`);
  const o22 = SHA('3');
  putWaiter('o22', o22, 999996, { state: 'left' }); setResult('o22', o22, { verdict: 'green', enqueuedAt: new Date().toISOString() });
  await waitFor(() => w22.code !== undefined, 10000);
  const j22 = lastJ(w22.out);
  ok('T22 a new orphan ends watch, only the new one in its JSON', w22.code === 0 && j22 && j22.orphans && j22.orphans.map((o) => o.task).join() === 'o22', `${w22.code} ${w22.out}`);
  await stop(w22);
  for (const [t, h] of [['o9', o9], ['o22', o22]]) tr('ack', '--task', t, '--head', h);

  // ---- T18: a reused pid, under LANG=ru_RU.UTF-8 and LANG=C ----
  const sl = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const slStart = Date.now();
  await wait(1200);
  const pr = SHA('5'), pa = SHA('6');
  putWaiter('pr', pr, sl.pid, { state: 'waiting', procStart: slStart - 3600000 });
  setResult('pr', pr, { verdict: 'red', enqueuedAt: new Date().toISOString() });
  putWaiter('pa', pa, sl.pid, { state: 'waiting', procStart: slStart });
  setResult('pa', pa, { verdict: 'red', enqueuedAt: new Date().toISOString() });
  for (const lang of ['ru_RU.UTF-8', 'C']) {
    const s = trE({ LANG: lang, LC_TIME: lang }, 'status').stdout;
    ok(`T18 LANG=${lang}: a live pid whose start is an hour after procStart is not the waiter -> without an addressee`, !!orphanLine(s, 'pr', pr), s);
    ok(`T18 LANG=${lang}: control - the same live pid with its own start time is the waiter -> not named`, !orphanLine(s, 'pa', pa), s);
  }
  sl.kill('SIGKILL');
  for (const [t, h] of [['pr', pr], ['pa', pa]]) tr('ack', '--task', t, '--head', h);

  // ---- T11: resume names the entries without a live waiter ----
  const rs = branch('rs', ['f-rs.txt']);
  halt({ reason: 'environment: guards-all.sh exit 69 on train t11' });
  tr('ride', ...args('rs', rs));
  r = tr('resume');
  ok('T11 resume names the entries without a live waiter and where their verdict goes', /without a live waiter/.test(r.stdout) && r.stdout.includes(`rs ${rs}`) && /train\.js watch/.test(r.stdout), r.stdout);

  // ---- T21: a new halt with an entry without a live waiter ends watch; with live waiters only it does not ----
  release = holdLock();
  const w21 = bg(['watch']);
  await wait(900);
  halt({ reason: 'environment: guards-all.sh exit 69 on train t21' });
  await waitFor(() => w21.code !== undefined, 10000);
  const j21 = lastJ(w21.out);
  ok('T21 cell 25: a new halt, the entry rs has no live waiter -> watch ends {halt, entriesWithoutWaiter}',
    w21.code === 0 && j21 && j21.halt && /t21/.test(j21.halt.reason) && Array.isArray(j21.entriesWithoutWaiter) && j21.entriesWithoutWaiter.some((e) => e.task === 'rs'), `${w21.code} ${w21.out}`);
  await stop(w21);
  tr('resume');
  fs.rmSync(path.join(TD, 'queue'), { recursive: true, force: true });
  const lv = branch('lv', ['f-lv.txt']);
  const rlv = bg(['ride', ...args('lv', lv)]);
  await waitFor(() => waiterFiles('lv', lv).length, 15000);
  const w26 = bg(['watch']);
  await wait(900);
  halt({ reason: 'environment: guards-all.sh exit 69 on train t26' });
  await rlv.closed;
  await wait(1500);
  ok('T21 cell 26: a new halt, every entry had a live waiter -> the ride leaves with 75, watch does not end',
    rlv.code === 75 && w26.code === undefined, `${rlv.code} ${w26.code} ${w26.out}`);
  await stop(w26);
  await release();
  tr('resume');
  fs.rmSync(path.join(TD, 'queue'), { recursive: true, force: true });

  // ---- T12, T20: no ride at all; watch drives the train; an entry of an older ride is no orphan ----
  const ov = branch('ov', ['f-ov.txt']), ov2 = branch('ov2', ['f-ov2.txt']);
  const now = Date.now();
  put(path.join(TD, 'queue', `${String(now).padStart(13, '0')}-ov.json`), JSON.stringify({ task: 'ov', branch: 'ov', head: ov, base: 'arc', dir: '', enqueuedAt: new Date(now).toISOString() }));
  put(path.join(TD, 'queue', `${String(now + 1).padStart(13, '0')}-ov2.json`), JSON.stringify({ task: 'ov2', branch: 'ov2', head: ov2, base: 'arc', dir: '', enqueuedAt: new Date(now + 1).toISOString() }));
  putWaiter('ov2', ov2, 999995, { state: 'left' });
  const w12 = bg(['watch']);
  await waitFor(() => w12.code !== undefined, 30000);
  const j12 = lastJ(w12.out);
  ok('T12 no ride: watch drives the train itself and ends with the verdict', w12.code === 0 && result('ov2', ov2) && j12 && j12.orphans && j12.orphans.some((o) => o.task === 'ov2' && o.verdict === 'green'), `${w12.code} ${w12.out} ${w12.err}`);
  ok('T20 an entry of an older ride (no waiter file) decided by the new dispatcher: not without an addressee; control ov2 is',
    result('ov', ov) && !(j12 && j12.orphans || []).some((o) => o.task === 'ov') && !orphanLine(status(), 'ov', ov) && !!orphanLine(status(), 'ov2', ov2), `${w12.out}\n${status()}`);
  await stop(w12);
  tr('ack', '--task', 'ov2', '--head', ov2);

  // ---- T13: a ride attached to the entry during the train; two rides of one head, one killed ----
  const a13 = branch('a13', ['f-a13.txt']), b13 = branch('b13', ['f-b13.txt']), c24 = branch('c24', ['f-c24.txt']);
  strand('a13', a13); strand('b13', b13);
  release = holdLock();
  const w13 = bg(['watch']);
  const ra13 = bg(['ride', ...args('a13', a13)]);
  const rc24a = bg(['ride', ...args('c24', c24)]);
  await waitFor(() => waiterFiles('a13', a13).some((w) => w.state === 'waiting') && waiterFiles('c24', c24).length, 15000);
  const rc24b = bg(['ride', ...args('c24', c24)]);
  await waitFor(() => waiterFiles('c24', c24).length === 2, 15000);
  rc24a.p.kill('SIGKILL'); await rc24a.closed;
  await release();
  await waitFor(() => w13.code !== undefined, 30000);
  await ra13.closed; await rc24b.closed;
  const j13 = lastJ(w13.out);
  ok('T13 cell 23: the attached ride takes the verdict (exit 0, claimedAt); not without an addressee',
    ra13.code === 0 && typeof (result('a13', a13) || {}).claimedAt === 'string' && !(j13 && j13.orphans || []).some((o) => o.task === 'a13'), `${ra13.code} ${w13.out}`);
  ok('T13 cell 24: two rides of one head, one killed: the live one takes it; not without an addressee',
    rc24b.code === 0 && !(j13 && j13.orphans || []).some((o) => o.task === 'c24') && typeof (result('c24', c24) || {}).claimedAt === 'string', `${rc24b.code} ${w13.out}`);
  ok('T13 control: b13 without an attached ride is the one verdict without an addressee', w13.code === 0 && j13 && j13.orphans && j13.orphans.map((o) => o.task).join() === 'b13', `${w13.code} ${w13.out}`);
  await stop(w13);
}

main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
});
