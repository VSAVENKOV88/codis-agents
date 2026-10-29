#!/usr/bin/env node
'use strict';
// The red train: attribution and the seam (p-train-c2, cells R1-R8 of the analysis p-train-ac, UC-8 and UC-9).
// A train red after the rerun of new reds names its repeated new reds R; each guard of R runs again, in the selection
// mode of guards-all.sh (--guards: guardSubsetCommand with {onlyArgs} = the guards of R), on the bare arc head and on
// "arc head + X" for every passenger X:
//   R1 g red on "arc + X" only -> X red (the train's log and the attribution log); the others stay in the queue and
//      ride the next train by the departure rule;
//   R2 g red on several X -> each red;
//   R3 g red on the bare arc head -> arc-red: g, the train does not count, the passengers stay, the queue halts;
//   R4 a seam of two (g green on each alone) -> the earlier by arrival rides the next train, the later -> seam with it;
//   R5 a seam of three -> g on the pairs (at most 3 runs), the pair named, the one outside rides; inside, as R4;
//   R6 a seam only of the three -> the earliest rides, the other two -> seam with it;
//   R7 the attribution could not run g on X (the environment) -> X stays in the queue without a verdict, a line for
//      the coordinator (the halt); the others by their results;
//   R8 g on the pairs now red, now green (flaky on a pair) -> the coordinator, no automatic decision.
// Coordinator's decision (c2): the log of the train's full run without its tally -> the environment, not a red train.
// The fixture is a throwaway project: guards are lines "name|shell condition" of $T/rules, red when the condition holds
// in the worktree; $SUBSET is 1 in the selection mode, so a guard can be red under the suite and green alone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js attribution (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-attr-')));
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
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// The project's guard runner: every guard of $T/rules, or only the --only ones; one line per call into calls.txt
// ("<pwd> <head> <subset 0|1> <only...>"); env-*.txt in the tree makes a selection run exit 69 (the runner unreachable)
// after a complete log with its tally and its reds, so only the exit code tells the environment.
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
SUBSET=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --subset) SUBSET=1;; --only) ONLY="$ONLY $2"; shift;; esac; shift; done
export SUBSET
echo "$PWD $(git rev-parse HEAD) $SUBSET$ONLY" >> "$T/calls.txt"
ENV=0; if [ "$SUBSET" = 1 ] && ls env-*.txt >/dev/null 2>&1; then echo "environment: the runner is unreachable"; ENV=1; fi
failed=0; passed=0
while IFS='|' read -r name cond; do
  [ -n "$name" ] || continue
  if [ -n "$ONLY" ]; then case "$ONLY " in *" $name "*) ;; *) continue;; esac; fi
  if sh -c "$cond"; then echo "FAILED $name - red"; failed=$((failed+1)); else echo "PASSED $name"; passed=$((passed+1)); fi
done < "$T/rules"
[ "$SUBSET" = 0 ] && [ -f "$T/notally" ] && { echo "cut off"; exit 1; }
echo "=== $failed failed, $passed passed in 0.1s ==="
[ "$ENV" = 1 ] && exit 69
[ "$failed" = 0 ]
`);
const G = path.join(T, 'guard.sh');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: `cd {wt} && ${G}`,
  guardSubsetCommand: `cd {wt} && ${G} --subset {onlyArgs}`,
  guardRerun: { command: `cd {wt} && ${G} --only {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 300000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const calls = () => (read(path.join(T, 'calls.txt')) || '').trim().split('\n').filter(Boolean).map((l) => { const [pwd, head, subset, ...only] = l.split(' '); return { pwd, head, subset, only }; });
const clearCalls = () => fs.rmSync(path.join(T, 'calls.txt'), { force: true });
const subsetCalls = () => calls().filter((c) => c.subset === '1');
const rules = (o) => fs.writeFileSync(path.join(T, 'rules'), Object.entries(Object.assign({ 'g-ok': 'false' }, o)).map(([k, v]) => `${k}|${v}`).join('\n') + '\n');
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f))).filter(Boolean);
const queued = () => queue().map((e) => e.task).sort().join(',');
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const haltJ = () => readJ(path.join(TD, 'halt'));
const taskDir = (t) => { const d = path.join(T, 'tasks', t); fs.mkdirSync(d, { recursive: true }); return d; };
const enq = (task, br = task) => tr('enqueue', '--task', task, '--branch', br, '--head', rev(br), '--base', 'arc', '--dir', taskDir(task));
const branch = (name, files) => {
  git(main, 'branch', '-f', name, 'arc');
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  for (const f of files) put(path.join(tmpWt, f), `${name}\n`);
  git(tmpWt, 'add', ...files); git(tmpWt, 'commit', '-q', '-m', `${name}: ${files.join(' ')}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
const arcCommit = (file) => {
  const tmpWt = path.join(T, 'mk-arc');
  git(main, 'worktree', 'add', '-q', tmpWt, 'arc');
  put(path.join(tmpWt, file), 'arc\n'); git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `arc: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev('arc');
};
// the tree a selection call ran on: "arc" (the bare arc head), or the passengers merged onto it, e.g. "x" or "a+b"
const treeOf = (c, arcSha, names) => {
  if (c.head === arcSha) return 'arc';
  const ps = [];
  let s = c.head;
  for (let i = 0; i < 5 && s && s !== arcSha; i++) { const p2 = rev(`${s}^2`); ps.unshift(Object.keys(names).find((k) => names[k] === p2) || p2); s = rev(`${s}^1`); }
  return s === arcSha ? ps.join('+') : `?${c.head}`;
};
const clean = () => { for (const e of queue()) fs.rmSync(path.join(TD, 'queue', ls(path.join(TD, 'queue')).find((f) => f.endsWith(`-${e.task}.json`))), { force: true }); tr('resume'); };

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  put(path.join(main, 'data', 'corpus.txt'), 'the corpus');
  rules({});

  // ---- R1: g red on "arc + x" only -> x red, y stays and rides the next train ----
  rules({ 'g-x': '[ -f red-x.txt ]' });
  let arc = rev('arc');
  const x = branch('x', ['f-x.txt', 'red-x.txt']), y = branch('y', ['f-y.txt']);
  enq('x'); enq('y');
  clearCalls();
  let r = tr('run'), o = last(r);
  let rx = result('x', x);
  ok('R1 the red train is attributed: x -> red', rx && rx.verdict === 'red', `${r.stdout}${r.stderr} ${JSON.stringify(rx)}`);
  ok('R1 the red result names the guard, the train log and the attribution log', rx && Array.isArray(rx.guards) && rx.guards.join() === 'g-x'
    && rx.log && fs.existsSync(rx.log) && rx.attribution && fs.existsSync(rx.attribution), JSON.stringify(rx));
  ok('R1 the attribution log names the trees and the guard', rx && /g-x/.test(read(rx.attribution) || '') && (read(rx.attribution) || '').includes(arc), rx && read(rx.attribution));
  ok('R1 a copy of the attribution log in the red task\'s folder', rx && read(path.join(T, 'tasks', 'x', path.basename(rx.attribution))) === read(rx.attribution), rx && rx.attribution);
  let sc = subsetCalls();
  const trees1 = sc.map((c) => treeOf(c, arc, { x, y })).sort().join(',');
  ok('R1 the attribution runs only g-x in the selection mode, on the bare arc, on arc + x and on arc + y', sc.length === 3 && sc.every((c) => c.only.join() === 'g-x') && trees1 === 'arc,x,y', JSON.stringify(sc) + ' ' + trees1);
  ok('R1 y has no verdict and stays in the queue; the queue does not halt', !result('y', y) && queued() === 'y' && !haltJ(), `${queued()} ${JSON.stringify(haltJ())}`);
  ok('R1 the train returns verdict red and names the red passenger', o && o.verdict === 'red' && Array.isArray(o.red) && o.red.join() === 'x', r.stdout);
  ok('R1 no attribution worktree is left behind', !ls(wts).some((n) => n.startsWith('train-')), ls(wts).join());
  ok('R1 the arc branch is not moved by a red train', rev('arc') === arc);
  r = tr('run'); o = last(r);
  ok('R1 the next train takes the rest (y) -> green', o && o.verdict === 'green' && result('y', y) && result('y', y).verdict === 'green' && o.passengers.join() === 'y', r.stdout + r.stderr);
  r = tr('await', '--task', 'x', '--head', x); o = last(r);
  ok('R1 await of the red passenger prints its red result', r.status === 0 && o && o.verdict === 'red', r.stdout + r.stderr);

  // ---- R2: g red on several X -> each red ----
  rules({ 'g-2': '[ -f red-2a.txt ] || [ -f red-2b.txt ]' });
  const a2 = branch('a2', ['f-a2.txt', 'red-2a.txt']), b2 = branch('b2', ['f-b2.txt', 'red-2b.txt']), c2 = branch('c2', ['f-c2.txt']);
  enq('a2'); enq('b2'); enq('c2');
  r = tr('run'); o = last(r);
  ok('R2 g red on a2 and b2 -> both red, c2 stays', result('a2', a2) && result('a2', a2).verdict === 'red' && result('b2', b2) && result('b2', b2).verdict === 'red'
    && !result('c2', c2) && queued() === 'c2' && !haltJ(), `${r.stdout}${r.stderr} ${queued()}`);
  r = tr('run'); o = last(r);
  ok('R2 the next train with c2 -> green', o && o.verdict === 'green' && result('c2', c2) && result('c2', c2).verdict === 'green', r.stdout + r.stderr);

  // ---- R3: g red on the bare arc head -> arc-red, nobody gets a verdict, the queue halts ----
  rules({ 'g-arc': '[ -f arc-bad.txt ]' });
  const a3 = branch('a3', ['f-a3.txt']), b3 = branch('b3', ['f-b3.txt']);
  arc = arcCommit('arc-bad.txt');
  enq('a3'); enq('b3');
  clearCalls();
  r = tr('run'); o = last(r);
  let h = haltJ();
  ok('R3 g red on the bare arc -> arc-red naming g, the train does not count', o && o.verdict === 'arc-red' && h && h.verdict === 'arc-red' && /arc-red: g-arc/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  ok('R3 the passengers stay in the queue without a verdict', !result('a3', a3) && !result('b3', b3) && queued() === 'a3,b3', queued());
  ok('R3 the bare arc head ran g-arc in the selection mode', subsetCalls().some((c) => c.head === arc && c.only.join() === 'g-arc'), JSON.stringify(subsetCalls()));
  r = tr('await', '--task', 'a3', '--head', a3); o = last(r);
  ok('R3 await of a passenger under the halt -> arc-red with the reason, the entry stays', r.status === 0 && o && o.verdict === 'arc-red' && o.halted && queued() === 'a3,b3', r.stdout + r.stderr);
  clearCalls(); r = tr('run'); o = last(r);
  ok('R3 while halted no train leaves', o && o.departed === false && !calls().length, r.stdout);
  rules({}); tr('resume');
  r = tr('run'); o = last(r);
  ok('R3 after the coordinator fixed the arc and resumed -> both ride green', o && o.verdict === 'green' && result('a3', a3) && result('b3', b3), r.stdout + r.stderr);

  // ---- R4: a seam of two -> the earlier rides the next train, the later -> seam naming the earlier ----
  rules({ 'g-s': '[ -f seam-1a.txt ] && [ -f seam-1b.txt ]' });
  arc = rev('arc');
  const s1 = branch('s1', ['seam-1a.txt']), s2 = branch('s2', ['seam-1b.txt']);
  enq('s1'); enq('s2');
  clearCalls();
  r = tr('run'); o = last(r);
  let rs = result('s2', s2);
  ok('R4 the later passenger -> seam with the earlier one named', rs && rs.verdict === 'seam' && rs.partner === 's1' && Array.isArray(rs.guards) && rs.guards.join() === 'g-s', `${r.stdout}${r.stderr} ${JSON.stringify(rs)}`);
  ok('R4 the earlier passenger has no verdict and stays in the queue; no halt', !result('s1', s1) && queued() === 's1' && !haltJ(), `${queued()} ${JSON.stringify(haltJ())}`);
  sc = subsetCalls();
  ok('R4 two passengers: no pair runs (arc, s1, s2 only)', sc.map((c) => treeOf(c, arc, { s1, s2 })).sort().join(',') === 'arc,s1,s2', JSON.stringify(sc));
  ok('R4 a copy of the attribution log in the seam task\'s folder', rs && rs.attribution && read(path.join(T, 'tasks', 's2', path.basename(rs.attribution))) === read(rs.attribution));
  r = tr('run'); o = last(r);
  ok('R4 the earlier rides the next train alone -> green, merged', o && o.verdict === 'green' && o.passengers.join() === 's1' && rev('arc') === o.sha, r.stdout + r.stderr);

  // ---- R5: a seam inside a train of three -> the pairs, the pair named, the one outside rides ----
  rules({ 'g-5': '[ -f seam-5a.txt ] && [ -f seam-5c.txt ]' });
  arc = rev('arc');
  const t1 = branch('t1', ['seam-5a.txt']), t2 = branch('t2', ['f-t2.txt']), t3 = branch('t3', ['seam-5c.txt']);
  enq('t1'); enq('t2'); enq('t3');
  clearCalls();
  r = tr('run'); o = last(r);
  rs = result('t3', t3);
  ok('R5 the pair t1 + t3 named: t3 (the later of the pair) -> seam with t1', rs && rs.verdict === 'seam' && rs.partner === 't1' && Array.isArray(rs.pair) && rs.pair.join() === 't1,t3', `${r.stdout}${r.stderr} ${JSON.stringify(rs)}`);
  ok('R5 t1 and t2 (outside the pair) stay without a verdict; no halt', !result('t1', t1) && !result('t2', t2) && queued() === 't1,t2' && !haltJ(), `${queued()} ${JSON.stringify(haltJ())}`);
  sc = subsetCalls();
  const pairs5 = sc.map((c) => treeOf(c, arc, { t1, t2, t3 })).filter((s) => s.includes('+')).sort();
  ok('R5 g ran on the three pairs, no more', pairs5.join(',') === 't1+t2,t1+t3,t2+t3', JSON.stringify(pairs5));
  r = tr('run'); o = last(r);
  ok('R5 the next train t1 + t2 -> green', o && o.verdict === 'green' && o.passengers.join() === 't1,t2', r.stdout + r.stderr);

  // ---- R6: a seam only of the three -> the earliest rides, the other two -> seam with it ----
  rules({ 'g-6': '[ -f seam-6a.txt ] && [ -f seam-6b.txt ] && [ -f seam-6c.txt ]' });
  const u1 = branch('u1', ['seam-6a.txt']), u2 = branch('u2', ['seam-6b.txt']), u3 = branch('u3', ['seam-6c.txt']);
  enq('u1'); enq('u2'); enq('u3');
  r = tr('run'); o = last(r);
  ok('R6 u2 and u3 -> seam with u1 (the three named), u1 stays; no halt', result('u2', u2) && result('u2', u2).verdict === 'seam' && result('u2', u2).partner === 'u1'
    && result('u3', u3) && result('u3', u3).verdict === 'seam' && result('u3', u3).partner === 'u1' && (result('u3', u3).pair || []).join() === 'u1,u2,u3'
    && !result('u1', u1) && queued() === 'u1' && !haltJ(), `${r.stdout}${r.stderr} ${queued()}`);
  r = tr('run'); o = last(r);
  ok('R6 the earliest rides the next train alone -> green', o && o.verdict === 'green' && o.passengers.join() === 'u1', r.stdout + r.stderr);

  // ---- R7: the attribution cannot run g on x7 (the environment) -> x7 stays, a line for the coordinator; y7 red ----
  rules({ 'g-7': '[ -f red-7x.txt ] || [ -f red-7y.txt ]' });
  const x7 = branch('x7', ['red-7x.txt', 'env-7.txt']), y7 = branch('y7', ['red-7y.txt']);
  enq('x7'); enq('y7');
  r = tr('run'); o = last(r);
  h = haltJ();
  ok('R7 y7 -> red by its own result', result('y7', y7) && result('y7', y7).verdict === 'red', `${r.stdout}${r.stderr}`);
  ok('R7 x7 stays in the queue without a verdict', !result('x7', x7) && queued() === 'x7', queued());
  ok('R7 the coordinator gets the line: the halt names x7 and the environment', h && /^environment: /.test(h.reason || '') && /x7/.test(h.reason || ''), JSON.stringify(h));
  clean();

  // ---- R8: g on the pairs now red, now green (flaky on a pair) -> the coordinator, no automatic decision ----
  rules({ 'g-8': '{ [ -f seam-8a.txt ] && [ -f seam-8b.txt ] && [ -f seam-8c.txt ]; } || { [ "$SUBSET" = 1 ] && [ -f seam-8a.txt ] && [ -f seam-8b.txt ]; }' });
  const v1 = branch('v1', ['seam-8a.txt']), v2 = branch('v2', ['seam-8b.txt']), v3 = branch('v3', ['seam-8c.txt']);
  enq('v1'); enq('v2'); enq('v3');
  r = tr('run'); o = last(r);
  h = haltJ();
  ok('R8 no verdict for anyone, all three stay in the queue', !result('v1', v1) && !result('v2', v2) && !result('v3', v3) && queued() === 'v1,v2,v3', `${r.stdout}${r.stderr} ${queued()}`);
  ok('R8 the queue halts for the coordinator, the reason names the unstable guard on a pair', h && /g-8/.test(h.reason || '') && /pair/.test(h.reason || '') && /coordinator/.test(h.reason || ''), JSON.stringify(h));
  clean();

  // ---- R8 on a passenger: g flaky on a alone (red, then green on its rerun), green on b -> the coordinator, no seam ----
  rules({ 'g-9': '{ [ -f seam-9a.txt ] && [ -f seam-9b.txt ]; } || { [ "$SUBSET" = 1 ] && [ -f seam-9a.txt ] && [ ! -f seam-9b.txt ]; }' });
  const f1 = branch('f1', ['seam-9a.txt']), f2 = branch('f2', ['seam-9b.txt']);
  enq('f1'); enq('f2');
  r = tr('run');
  h = haltJ();
  ok('R8 g flaky on a passenger alone -> no seam verdict, both stay, the coordinator', !result('f1', f1) && !result('f2', f2) && queued() === 'f1,f2'
    && h && /g-9 flaky/.test(h.reason || '') && /coordinator/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  clean();

  // ---- R5: red on several pairs -> no one seam pair: the coordinator ----
  rules({ 'g-10': '{ [ -f s10a.txt ] && [ -f s10b.txt ]; } || { [ -f s10a.txt ] && [ -f s10c.txt ]; }' });
  const k1 = branch('k1', ['s10a.txt']), k2 = branch('k2', ['s10b.txt']), k3 = branch('k3', ['s10c.txt']);
  enq('k1'); enq('k2'); enq('k3');
  r = tr('run');
  h = haltJ();
  ok('R5 g red on two pairs -> no verdict, all stay, the coordinator', !result('k2', k2) && !result('k3', k3) && queued() === 'k1,k2,k3'
    && h && /several pairs/.test(h.reason || '') && /coordinator/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  clean();

  // ---- a seam among four passengers is not searched (UC-9 out of scope) -> the coordinator ----
  rules({ 'g-11': '[ -f s11a.txt ] && [ -f s11b.txt ] && [ -f s11c.txt ] && [ -f s11d.txt ]' });
  const q1 = branch('q1', ['s11a.txt']), q2 = branch('q2', ['s11b.txt']), q3 = branch('q3', ['s11c.txt']), q4 = branch('q4', ['s11d.txt']);
  enq('q1'); enq('q2'); enq('q3'); enq('q4');
  clearCalls();
  r = tr('run');
  h = haltJ();
  ok('four passengers green alone -> no verdict, no pair runs, the coordinator', [q1, q2, q3, q4].every((hd, i) => !result(`q${i + 1}`, hd)) && queued() === 'q1,q2,q3,q4'
    && h && /more than three/.test(h.reason || '') && subsetCalls().length === 5, `${r.stdout}${r.stderr} ${JSON.stringify(h)} ${subsetCalls().length}`);
  clean();

  // ---- one passenger: red in the train, green alone on the same tree -> the coordinator ----
  rules({ 'g-w': '[ "$SUBSET" = 0 ] && [ -f f-w.txt ]' });
  const w = branch('w', ['f-w.txt']);
  enq('w');
  r = tr('run');
  h = haltJ();
  ok('one passenger red in the train and green alone -> no verdict, the coordinator', !result('w', w) && queued() === 'w' && h && /coordinator/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  clean();

  // ---- coordinator's decision: the log of the full run without its tally -> the environment, no attribution ----
  rules({ 'g-n': '[ -f red-n.txt ]' });
  const n1 = branch('n1', ['red-n.txt']);
  enq('n1');
  fs.writeFileSync(path.join(T, 'notally'), '1');
  clearCalls();
  r = tr('run'); o = last(r);
  fs.rmSync(path.join(T, 'notally'));
  h = haltJ();
  ok('no tally in the train\'s log -> environment, halted, n1 stays, no attribution run', o && o.verdict === 'environment' && h && /^environment: /.test(h.reason || '') && /tally/.test(h.reason || '')
    && !result('n1', n1) && queued() === 'n1' && !subsetCalls().length, `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  clean();

  ok('no train worktree is left behind', !ls(wts).some((n) => n.startsWith('train-')), ls(wts).join());

  // ---- guards-all.sh --guards: the selection mode for named guards ----
  const gwt = path.join(wts, 'gsel');
  git(main, 'worktree', 'add', '-q', '--detach', gwt, 'arc');
  const GA = path.join(ROOT, 'scripts', 'guards-all.sh');
  const ga = (...a) => spawnSync('zsh', [GA, ...a], { cwd: T, encoding: 'utf8', env, timeout: 120000 });
  const nf = path.join(T, 'names.json');
  rules({ 'g-a': 'false', 'g-b': 'false' });
  fs.writeFileSync(nf, '["g-b"]'); clearCalls();
  r = ga('--guards', nf, gwt);
  ok('--guards runs guardSubsetCommand with one --only per named guard, its log the selection log', r.status === 0 && calls().length === 1 && calls()[0].subset === '1' && calls()[0].only.join() === 'g-b'
    && /PASSED g-b/.test(read(path.join(shared, 'guards-gsel.select.txt')) || ''), r.stdout + r.stderr + JSON.stringify(calls()));
  fs.writeFileSync(nf, '[]'); clearCalls();
  r = ga('--guards', nf, gwt);
  ok('--guards with an empty list -> nothing selected, exit 0, nothing runs', r.status === 0 && /nothing selected/.test(r.stdout) && !calls().length, r.stdout + r.stderr);
  fs.writeFileSync(nf, '{"g-b": 1}');
  r = ga('--guards', nf, gwt);
  ok('--guards with a file that is not a JSON array of names -> exit 64', r.status === 64, `${r.status} ${r.stderr}`);
  fs.writeFileSync(nf, '["g-b"]');
  r = ga('--guards', nf, '--select', 'arc', gwt);
  ok('--guards and --select together -> exit 64', r.status === 64, `${r.status} ${r.stderr}`);
  git(main, 'worktree', 'remove', '--force', gwt);
}

main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
});
