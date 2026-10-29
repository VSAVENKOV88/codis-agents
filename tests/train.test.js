#!/usr/bin/env node
'use strict';
// The train dispatcher (p-train-c1, cells D1-D20 of the analysis p-train-ac): a queue of ready branches in
// <sharedDir>/train/queue, one train at a time under a mkdir lock, a temporary merge commit "arc head + passengers"
// (merge-tree / commit-tree, refs/runs/train/<id>), one full guard run (guards-all.sh as it is) in a detached temporary
// worktree with a cloned corpus, results in <sharedDir>/train/result; green -> the arc branch moves to the train commit
// (compare-and-swap, or merge --ff-only in the worktree where it is checked out); the environment halts the queue.
// The fixture is a throwaway project: a repository with an arc branch and task branches, a fake guard command.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
// memory probes of the slots, as in known-red.test.js: a calm machine
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// The guard command of the fixture: records where and on what it ran, then the exit code of $T/rc (0 by default).
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
h=$(git rev-parse HEAD)
s=$(git symbolic-ref -q HEAD || echo detached)
if [ -L data/corpus.txt ]; then c=link; elif [ -f data/corpus.txt ]; then c=file; else c=none; fi
echo "$PWD $h $s $c" >> "$T/calls.txt"
[ -f "$T/sleep" ] && sleep "$(cat "$T/sleep")"
[ -f "$T/move.sh" ] && { sh "$T/move.sh"; rm -f "$T/move.sh"; }
[ -f "$T/flaky" ] && { echo "FAILED t/flaky.js - x"; echo "=== 1 failed, 8 passed in 0.1s ==="; exit 1; }
rc=$(cat "$T/rc" 2>/dev/null || echo 0)
[ "$rc" = 0 ] && echo "=== 9 passed in 0.1s ==="
exit "$rc"
`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const calls = () => (read(path.join(T, 'calls.txt')) || '').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
const clearCalls = () => fs.rmSync(path.join(T, 'calls.txt'), { force: true });
const setRc = (n) => fs.writeFileSync(path.join(T, 'rc'), String(n));
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f)));
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const trains = () => ls(path.join(TD, 'trains')).filter((f) => f.endsWith('.json'));
const runRefs = () => git(main, 'for-each-ref', '--format=%(refname)', 'refs/runs/train').stdout.trim().split('\n').filter(Boolean);
const heads = () => git(main, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').stdout;
const taskDir = (t) => { const d = path.join(T, 'tasks', t); fs.mkdirSync(d, { recursive: true }); return d; };
const enq = (task, branch, head = rev(branch), base = 'arc') => tr('enqueue', '--task', task, '--branch', branch, '--head', head, '--base', base, '--dir', taskDir(task));
// a task branch from the arc head with one file of its own
const branch = (name, file, text, from = 'arc') => {
  git(main, 'branch', '-f', name, from);
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  put(path.join(tmpWt, file), text);
  git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `${name}: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
// a commit on the arc branch outside any train (the coordinator), without a worktree
const arcCommit = (msg) => {
  const tree = rev('arc^{tree}');
  const c = git(main, 'commit-tree', tree, '-p', 'arc', '-m', msg).stdout.trim();
  git(main, 'update-ref', 'refs/heads/arc', c);
  return c;
};

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  put(path.join(main, 'data', 'corpus.txt'), 'the corpus');

  ok('usage: no command -> exit 64', tr().status === 64);

  // ---- D1 + D12-D15: one ready branch, no train in transit -> it leaves at once, green, the arc moves (CAS) ----
  const a = branch('a', 'f-a.txt', 'a\n');
  const arc0 = rev('arc');
  let r = enq('a', 'a');
  ok('enqueue -> exit 0, one queue entry {task, branch, head, base, dir, enqueuedAt}', r.status === 0 && queue().length === 1
    && ['task', 'branch', 'head', 'base', 'dir', 'enqueuedAt'].every((k) => k in (queue()[0] || {})) && queue()[0].head === a, r.stdout + r.stderr);
  r = enq('a', 'a');
  ok('enqueue of the same task and head again -> still one entry (a relaunch attaches)', r.status === 0 && queue().length === 1, JSON.stringify(queue()));
  ok('enqueue refuses a head that is not a full sha', enq('a', 'a', 'abc').status === 64);
  r = tr('run');
  let o = last(r);
  const id1 = o && o.train;
  const c1 = calls();
  const res1 = result('a', a);
  ok('D1 one ready branch -> the train leaves at once with it, green', r.status === 0 && o && o.departed === true && res1 && res1.verdict === 'green', r.stdout + r.stderr);
  ok('D1 the train commit = arc head + a (parents arc, a)', o && rev(`${o.sha}^1`) === arc0 && rev(`${o.sha}^2`) === a, o && o.sha);
  ok('D12 the guards ran once, on the train commit, detached, in a temporary worktree under worktreeRoot',
    c1.length === 1 && c1[0][1] === (o && o.sha) && c1[0][2] === 'detached' && path.dirname(c1[0][0]) === wts && path.basename(c1[0][0]).startsWith('train-'), JSON.stringify(c1));
  ok('D12 the corpus in that worktree is a clone (a file), not a link', c1.length === 1 && c1[0][3] === 'file', JSON.stringify(c1));
  ok('D13 after the run the temporary worktree is removed (directory and registration)', c1.length === 1 && !fs.existsSync(c1[0][0])
    && !git(main, 'worktree', 'list', '--porcelain').stdout.includes(c1[0][0]), c1.length && c1[0][0]);
  ok('D6 the train commit has its ref refs/runs/train/<id>, not a branch or a tag', id1 && rev(`refs/runs/train/${id1}`) === (o && o.sha), runRefs().join());
  ok('D15 green, arc not checked out -> refs/heads/arc = the train commit', o && rev('arc') === o.sha && res1 && res1.merged === o.sha, rev('arc'));
  ok('D14 the result names the train, its commit and a log', res1 && res1.train === id1 && res1.sha === (o && o.sha) && res1.log && fs.existsSync(res1.log), JSON.stringify(res1));
  const log1 = res1 && read(res1.log) || '';
  ok('D14 the log header: the arc head and each passenger with its head', log1.includes(`arc arc ${arc0}`) && log1.includes(`passenger a a ${a}`), log1.slice(0, 600));
  ok('D14 the log carries the guard run (its tally)', /=== 9 passed in 0\.1s ===/.test(log1), log1.slice(0, 1500));
  ok('D14 a copy of the log in the task folder', id1 && read(path.join(T, 'tasks', 'a', `train-${id1}.txt`)) === log1);
  ok('D1 the passenger left the queue; the lock is released', queue().length === 0 && !fs.existsSync(path.join(TD, 'lock')), JSON.stringify(queue()));

  // ---- D3: the train is back, the queue is empty -> nothing leaves, the lock is released ----
  clearCalls();
  r = tr('run'); o = last(r);
  ok('D3 empty queue -> nothing leaves, no guard run, lock released', r.status === 0 && o && o.departed === false && !calls().length && !fs.existsSync(path.join(TD, 'lock')), r.stdout + r.stderr);

  // ---- D6: two passengers without conflict -> a chain in the order of arrival; task branches untouched ----
  const b = branch('b', 'f-b.txt', 'b\n'); const c = branch('c', 'f-c.txt', 'c\n');
  const arc1 = rev('arc');
  enq('b', 'b'); enq('c', 'c');
  const before = heads();
  clearCalls();
  // a red run that is not the environment: the train must not merge, so the branches are compared untouched
  setRc(1);
  r = tr('run'); o = last(r);
  setRc(0);
  ok('D6 two passengers -> one train commit M2: M2^1 = M1 = arc + b, M2^2 = c', o && rev(`${o.sha}^2`) === c && rev(`${o.sha}^1^1`) === arc1 && rev(`${o.sha}^1^2`) === b, o && o.sha);
  ok('D6 the tree of the train holds both', o && git(main, 'cat-file', '-e', `${o.sha}:f-b.txt`).status === 0 && git(main, 'cat-file', '-e', `${o.sha}:f-c.txt`).status === 0);
  ok('D6 a train that is not green moves no branch (task branches and arc untouched)', heads() === before, heads());
  ok('D6 a red train is not merged: the passengers stay in the queue (attribution is c2)', queue().length === 2 && !result('b', b), JSON.stringify(queue()));
  fs.rmSync(path.join(TD, 'halt'), { force: true });
  r = tr('resume');
  r = tr('run'); o = last(r);
  ok('D6 the next train with both -> green, arc = the train commit', o && result('b', b) && result('b', b).verdict === 'green' && result('c', c).verdict === 'green' && rev('arc') === o.sha, r.stdout + r.stderr);

  // ---- D7: a passenger conflicting with an earlier one is excluded with its files; the others ride ----
  const d = branch('d', 'shared.txt', 'd\n'); const x = branch('x', 'shared.txt', 'x\n'); const e = branch('e', 'f-e.txt', 'e\n');
  enq('d', 'd'); enq('x', 'x'); enq('e', 'e');
  clearCalls();
  r = tr('run'); o = last(r);
  const rx = result('x', x);
  ok('D7 x conflicts -> result conflict with the file list', rx && rx.verdict === 'conflict' && Array.isArray(rx.files) && rx.files.includes('shared.txt'), JSON.stringify(rx));
  ok('D7 the others ride: d and e green, the train commit holds both, not x', result('d', d) && result('d', d).verdict === 'green' && result('e', e) && result('e', e).verdict === 'green'
    && o && git(main, 'show', `${o.sha}:shared.txt`).stdout === 'd\n' && git(main, 'cat-file', '-e', `${o.sha}:f-e.txt`).status === 0, r.stdout + r.stderr);
  ok('D7 x left the queue with its verdict', queue().length === 0, JSON.stringify(queue()));

  // ---- D8: after the exclusions nothing is left -> the train does not leave ----
  r = enq('x', 'x');
  ok('enqueue of a task and head that already has a result -> no entry, the result is printed', r.status === 0 && queue().length === 0 && /conflict/.test(r.stdout), r.stdout + r.stderr);
  const x2 = branch('x', 'f-x2.txt', 'x2\n', 'x');   // x, one commit more, still conflicts with the arc (d is merged)
  enq('x', 'x');
  clearCalls();
  const refsBefore = runRefs().length;
  r = tr('run'); o = last(r);
  ok('D8 the only passenger conflicts -> conflict, no train: no guard run, no new refs/runs/train', result('x', x2) && result('x', x2).verdict === 'conflict' && o && o.departed === false
    && !calls().length && runRefs().length === refsBefore, r.stdout + r.stderr);

  // ---- D9: the arc head moved before the departure -> the new head is taken ----
  const f = branch('f', 'f-f.txt', 'f\n');
  enq('f', 'f');
  const moved = arcCommit('coordinator commit');
  r = tr('run'); o = last(r);
  ok('D9 the arc moved before the departure -> the train is built on the new head', o && rev(`${o.sha}^1`) === moved && result('f', f) && result('f', f).verdict === 'green', r.stdout + r.stderr);

  // ---- D10: the queue head differs from the branch head -> the queue head rides, the difference is logged ----
  const g1 = branch('g', 'f-g.txt', 'g\n');
  enq('g', 'g');
  const g2 = branch('g', 'f-g2.txt', 'g2\n', 'g');
  r = tr('run'); o = last(r);
  const rg = result('g', g1);
  ok('D10 the reviewed head from the queue rides, not the newer branch head', o && rev(`${o.sha}^2`) === g1 && rg && rg.verdict === 'green' && git(main, 'cat-file', '-e', `${o.sha}:f-g2.txt`).status !== 0, r.stdout + r.stderr);
  ok('D10 the difference is in the log', rg && new RegExp(`passenger g g ${g1}.*branch head ${g2}`).test(read(rg.log) || ''), rg && (read(rg.log) || '').slice(0, 800));

  // ---- D18: the arc head moved during the run -> no merge, the passengers ride the next train on the new head ----
  const h = branch('h', 'f-h.txt', 'h\n');
  enq('h', 'h');
  fs.writeFileSync(path.join(T, 'move.sh'), `cd '${main}' && c=$(git -c user.email=t@example.com -c user.name=t commit-tree $(git rev-parse 'arc^{tree}') -p arc -m during) && git update-ref refs/heads/arc "$c" && echo "$c" > '${T}/moved.txt'\n`);
  r = tr('run'); o = last(r);
  const during = (read(path.join(T, 'moved.txt')) || '').trim();
  ok('D18 the arc moved during the run -> not merged, no result, h stays in the queue', during && rev('arc') === during && !result('h', h) && queue().length === 1 && o && o.verdict === 'arc-moved', r.stdout + r.stderr);
  r = tr('run'); o = last(r);
  ok('D18 the next train takes h on the new head -> green', o && rev(`${o.sha}^1`) === during && result('h', h) && result('h', h).verdict === 'green' && rev('arc') === o.sha, r.stdout + r.stderr);

  // ---- D11: a git error (a head that is no object) -> no train, the passenger stays, the reason to the coordinator ----
  const bogus = 'deadbeef'.repeat(5);
  enq('k', 'a', bogus);
  clearCalls();
  r = tr('run'); o = last(r);
  const halt = read(path.join(TD, 'halt'));
  ok('D11 git error -> the train is not built, no guard run, the passenger stays in the queue without a result',
    o && o.departed === false && !calls().length && queue().some((q) => q.task === 'k') && !result('k', bogus), r.stdout + r.stderr);
  ok('D11 the reason ("git: ...") is kept for the coordinator in the halt file', halt && /git/.test(halt), halt);
  r = tr('status');
  ok('status names the halt and the queue', r.status === 0 && /halt/.test(r.stdout) && /\bk\b/.test(r.stdout), r.stdout);
  fs.rmSync(path.join(TD, 'queue', ls(path.join(TD, 'queue')).find((q) => q.endsWith('-k.json'))));
  r = tr('resume');
  ok('resume (the coordinator) removes the halt', r.status === 0 && !fs.existsSync(path.join(TD, 'halt')), r.stdout + r.stderr);

  // ---- D19: the environment (69/124/77/78) -> the train does not count, the passengers stay, the queue halts ----
  const m = branch('m', 'f-m.txt', 'm\n');
  enq('m', 'm');
  for (const code of [69, 124, 77, 78]) {
    setRc(code); clearCalls();
    const arcB = rev('arc');
    r = tr('run'); o = last(r);
    const hf = read(path.join(TD, 'halt'));
    ok(`D19 exit ${code} -> environment: not counted, no result, m stays, arc unchanged, the queue halted with the reason`,
      o && o.verdict === 'environment' && !result('m', m) && queue().length === 1 && rev('arc') === arcB && hf && hf.includes(String(code)), `${r.stdout}${r.stderr} ${hf}`);
    setRc(0); clearCalls();
    r = tr('run'); o = last(r);
    ok(`D19 exit ${code}: while halted no train leaves`, o && o.departed === false && o.halted && !calls().length, r.stdout + r.stderr);
    r = tr('await', '--task', 'm', '--head', m);
    o = last(r);
    ok(`D19 exit ${code}: await of a passenger under the halt -> environment with the reason, the entry stays`, r.status === 0 && o && o.verdict === 'environment' && o.halted && queue().length === 1, r.stdout + r.stderr);
    tr('resume');
  }
  setRc(0);
  r = tr('await', '--task', 'm', '--head', m); o = last(r);
  ok('await after resume -> the waiting step dispatches the train itself and prints its result', r.status === 0 && o && o.verdict === 'green' && result('m', m), r.stdout + r.stderr);

  // ---- D20: a guard flaky in the train's full run -> written into the quarantine (part B, as any full run) ----
  const n = branch('n', 'f-n.txt', 'n\n');
  enq('n', 'n');
  fs.writeFileSync(path.join(T, 'flaky'), '1');
  r = tr('run'); o = last(r);
  fs.rmSync(path.join(T, 'flaky'));
  const qf = readJ(path.join(shared, 'guards-quarantine.json'));
  ok('D20 flaky in the train run -> green (red under load only) and the guard is in the quarantine', result('n', n) && result('n', n).verdict === 'green' && qf && /^flaky: /.test(qf['t/flaky.js'] || ''), `${r.stdout}${r.stderr} ${JSON.stringify(qf)}`);

  // ---- D4 + D2: two claimants at once -> exactly one train in transit; a late branch rides the next train with all ready ----
  const p = branch('p', 'f-p.txt', 'p\n');
  enq('p', 'p');
  fs.writeFileSync(path.join(T, 'sleep'), '3');
  clearCalls();
  const nT = trains().length;
  const spawnRun = () => new Promise((res) => { const ch = spawn(process.execPath, [TRAIN, 'run'], { cwd: T, env }); let s = ''; ch.stdout.on('data', (x) => { s += x; }); ch.on('close', (code) => res({ code, out: s })); });
  const p1 = spawnRun(), p2 = spawnRun();
  const [r1, r2] = await Promise.all([p1, p2]);
  ok('D4 two dispatchers at once -> exactly one train, one guard run', trains().length === nT + 1 && calls().length === 1, `${trains().length - nT} ${JSON.stringify(calls())} ${r1.out} ${r2.out}`);
  ok('D4 the other one says the train is in transit', [r1, r2].some((x) => /in transit|busy/.test(x.out)), r1.out + r2.out);
  // D2: while a train is in transit, branches arrive -> they wait; then they leave together
  const q1 = branch('q', 'f-q.txt', 'q\n'); const s1 = branch('s', 'f-s.txt', 's\n'); const u1 = branch('u', 'f-u.txt', 'u\n');
  enq('q', 'q');
  clearCalls();
  const moving = spawnRun();
  for (let i = 0; i < 100 && !fs.existsSync(path.join(T, 'calls.txt')); i++) await new Promise((z) => setTimeout(z, 100));
  enq('s', 's'); enq('u', 'u');
  r = tr('run'); o = last(r);
  ok('D2 a train in transit -> the late branches wait (nothing leaves)', o && o.departed === false && o.busy === true, r.stdout + r.stderr);
  await moving;
  fs.rmSync(path.join(T, 'sleep'));
  r = tr('run'); o = last(r);
  ok('D2 the train is back -> the next one leaves with all ready (s and u together)', o && o.passengers && o.passengers.length === 2 && result('s', s1) && result('u', u1) && result('q', q1)
    && rev(`${o.sha}^2`) === u1 && rev(`${o.sha}^1^2`) === s1, r.stdout + r.stderr);

  // ---- D5: the lock holder died mid-train -> the lock is freed by its dead pid, its worktree removed, the passengers ride ----
  const w = branch('w', 'f-w.txt', 'w\n');
  enq('w', 'w');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  const leftWt = path.join(wts, 'train-dead');
  git(main, 'worktree', 'add', '-q', '--detach', leftWt, 'arc');
  fs.mkdirSync(path.join(TD, 'lock'));
  fs.writeFileSync(path.join(TD, 'lock', 'owner.json'), JSON.stringify({ pid: Number(dead), train: 'dead', wt: leftWt, since: new Date().toISOString() }));
  r = tr('run'); o = last(r);
  ok('D5 a dead holder -> its lock is broken, the passenger rides (no verdict was lost)', o && o.departed === true && result('w', w) && result('w', w).verdict === 'green', r.stdout + r.stderr);
  ok('D5 the dead train\'s worktree is removed', !fs.existsSync(leftWt) && !git(main, 'worktree', 'list', '--porcelain').stdout.includes(leftWt));
  // a live holder keeps it
  const y = branch('y', 'f-y.txt', 'y\n');
  enq('y', 'y');
  fs.mkdirSync(path.join(TD, 'lock'));
  fs.writeFileSync(path.join(TD, 'lock', 'owner.json'), JSON.stringify({ pid: process.pid, train: 'live', since: new Date().toISOString() }));
  r = tr('run'); o = last(r);
  ok('D5 a live holder keeps the lock: nothing leaves, y waits', o && o.departed === false && o.busy && !result('y', y) && fs.existsSync(path.join(TD, 'lock', 'owner.json')), r.stdout + r.stderr);
  fs.rmSync(path.join(TD, 'lock'), { recursive: true });
  r = tr('run');
  ok('D5 the holder gone -> y rides', result('y', y) && result('y', y).verdict === 'green', r.stdout + r.stderr);

  // ---- D16: green, the arc branch checked out in a worktree -> merge --ff-only there, never a bare update-ref ----
  const arcWt = path.join(T, 'arc-wt');
  git(main, 'worktree', 'add', '-q', arcWt, 'arc');
  const z = branch('z', 'f-z.txt', 'z\n');
  enq('z', 'z');
  r = tr('run'); o = last(r);
  ok('D16 green, arc checked out in a worktree -> that worktree is at the train commit, clean (no staged deletions)', o && result('z', z) && result('z', z).verdict === 'green'
    && rev('HEAD', arcWt) === o.sha && git(arcWt, 'status', '--porcelain', '--untracked-files=no').stdout === '' && fs.existsSync(path.join(arcWt, 'f-z.txt')), `${r.stdout}${r.stderr} ${git(arcWt, 'status', '--porcelain').stdout}`);

  // ---- D17: an untracked file on a path of the train -> ff-only refuses, the arc does not move -> green-unmerged ----
  const v = branch('v', 'f-v.txt', 'v\n');
  enq('v', 'v');
  put(path.join(arcWt, 'f-v.txt'), 'in the way\n');
  const arcV = rev('arc');
  r = tr('run'); o = last(r);
  const rv = result('v', v);
  ok('D17 ff-only refused -> green-unmerged, the arc branch not moved, the reason for the coordinator', rv && rv.verdict === 'green-unmerged' && rev('arc') === arcV && rv.reason && rv.sha === (o && o.sha), `${r.stdout}${r.stderr} ${JSON.stringify(rv)}`);
  ok('D17 green-unmerged leaves the queue (the coordinator merges refs/runs/train/<id>)', !queue().some((q) => q.task === 'v') && rev(`refs/runs/train/${rv && rv.train}`) === (o && o.sha));
  fs.rmSync(path.join(arcWt, 'f-v.txt'));
  // tracked changes in the arc worktree -> green-unmerged without a merge attempt (coordinator 1)
  const v2 = branch('v2', 'f-v2.txt', 'v2\n');
  enq('v2', 'v2');
  put(path.join(arcWt, 'base.txt'), 'edited by the coordinator\n');
  const arcV2 = rev('arc');
  r = tr('run');
  const rv2 = result('v2', v2);
  ok('D17 tracked changes in the arc worktree -> green-unmerged, the edit kept, arc not moved', rv2 && rv2.verdict === 'green-unmerged' && rev('arc') === arcV2 && read(path.join(arcWt, 'base.txt')) === 'edited by the coordinator\n', `${r.stdout}${r.stderr} ${JSON.stringify(rv2)}`);

  ok('no train worktree is left behind', !ls(wts).some((n2) => n2.startsWith('train-')), ls(wts).join());
}

main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
});
