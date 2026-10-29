#!/usr/bin/env node
'use strict';
// Tester of p-train-c2 (round 1): cells of the red train's attribution the programmer's train-attribution.test.js does
// not hold. S1 a guard name from the log with shell metacharacters reaches {onlyArgs} literally, never as code; L1 no
// attribution ref refs/runs/train/<id>-<label> is left; R1 the red task's folder gets a copy of the train's log too;
// R3 arc-red wins over a red on a passenger in the same attribution; R7 the attribution cannot run on the bare arc head,
// and on a pair of three (each: the environment, nobody gets a verdict, all stay); R4 await of the later passenger of a
// seam prints its seam with the partner.
// ---- the harness below is the one of train-attribution.test.js, with one change: the environment of a selection run
// is the shell condition in $T/envcond (true in the tree -> exit 69 after a complete log), so it can hold on a pair only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js attribution (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-attr-t-')));
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
// the fake machine of the slots, in front of PATH: a calm machine
const tool = (name, body) => sh(path.join(bin, name), body);
tool('sysctl', '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
tool('memory_pressure', '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
tool('vm_stat', '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
tool('df', '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// The project's guard runner: every guard of $T/rules, or only the --only ones; one line per call into calls.txt
// ("<pwd> <head> <subset 0|1> <only...>"); $T/envcond true in the tree makes a selection run exit 69 (the runner unreachable)
// after a complete log with its tally and its reds, so only the exit code tells the environment.
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
SUBSET=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --subset) SUBSET=1;; --only) ONLY="$ONLY $2"; shift;; esac; shift; done
export SUBSET
echo "$PWD $(git rev-parse HEAD) $SUBSET$ONLY" >> "$T/calls.txt"
ENV=0; if [ "$SUBSET" = 1 ] && [ -f "$T/envcond" ] && sh -c "$(cat "$T/envcond")"; then echo "environment: the runner is unreachable"; ENV=1; fi
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

  const envc = (c) => { if (c) fs.writeFileSync(path.join(T, 'envcond'), c); else fs.rmSync(path.join(T, 'envcond'), { force: true }); };
  const labelRefs = () => git(main, 'for-each-ref', '--format=%(refname)', 'refs/runs/train/').stdout.split('\n').filter((s) => /^refs\/runs\/train\/.+-(arc|p\d+(p\d+)?)$/.test(s));
  const pwned = () => spawnSync('find', [T, '-name', 'PWNED*'], { encoding: 'utf8' }).stdout.trim();

  // ---- S1: a guard name with shell metacharacters (it comes from a guard's output) reaches {onlyArgs} literally ----
  const evil = 'g;:>PWNED;$(:>PWNED2)`:>PWNED3`';
  rules({ [evil]: '[ -f red-e.txt ]' });
  let arc = rev('arc');
  const e1 = branch('e1', ['red-e.txt']), e2 = branch('e2', ['f-e2.txt']);
  enq('e1'); enq('e2');
  clearCalls();
  let r = tr('run'), o = last(r);
  const re = result('e1', e1);
  ok('S1 the guard with metacharacters is attributed: e1 -> red naming it literally', re && re.verdict === 'red' && (re.guards || []).join() === evil, `${r.stdout}${r.stderr} ${JSON.stringify(re)}`);
  ok('S1 the selection runs got the literal name as one --only argument', subsetCalls().length === 3 && subsetCalls().every((c) => c.only.join(' ') === evil), JSON.stringify(subsetCalls()));
  ok('S1 nothing of the name ran as shell code (no PWNED* file anywhere)', pwned() === '', pwned());

  // ---- L1: no attribution ref is left behind; R1: the train's log is copied into the red task's folder too ----
  ok('L1 no ref refs/runs/train/<id>-<label> is left after the attribution', labelRefs().length === 0, labelRefs().join(' '));
  ok('R1 the red task\'s folder holds a copy of the train\'s log', re && re.log && (read(re.log) || '').length > 0 && read(path.join(T, 'tasks', 'e1', `train-${path.basename(re.log)}`)) === read(re.log), re && re.log + ' ' + ls(path.join(T, 'tasks', 'e1')).join());
  r = tr('run'); o = last(r);
  ok('S1 the next train takes e2 -> green', o && o.verdict === 'green' && (o.passengers || []).join() === 'e2', r.stdout + r.stderr);

  // ---- R3 mixed: one guard of R red on the bare arc, another red on a passenger -> arc-red, nobody gets a verdict ----
  rules({ 'g-arc': '[ -f arc-bad.txt ]', 'g-px': '[ -f red-px.txt ]' });
  const m1 = branch('m1', ['red-px.txt']), m2 = branch('m2', ['f-m2.txt']);
  arc = arcCommit('arc-bad.txt');
  enq('m1'); enq('m2');
  r = tr('run'); o = last(r);
  let h = haltJ();
  ok('R3 arc-red wins: verdict arc-red naming g-arc, halted', o && o.verdict === 'arc-red' && h && h.verdict === 'arc-red' && /arc-red: g-arc/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  ok('R3 the passenger red alone (m1) gets no verdict while the arc is red; both stay', !result('m1', m1) && !result('m2', m2) && queued() === 'm1,m2', queued());
  clean();
  { // the coordinator fixes the arc: arc-bad.txt removed
    const tmpWt = path.join(T, 'mk-fix'); git(main, 'worktree', 'add', '-q', tmpWt, 'arc'); git(tmpWt, 'rm', '-q', 'arc-bad.txt'); git(tmpWt, 'commit', '-q', '-m', 'arc: fixed'); git(main, 'worktree', 'remove', '--force', tmpWt);
  }

  // ---- R7 on the bare arc head: the attribution cannot run there -> the environment, nobody gets a verdict ----
  rules({ 'g-7a': '[ -f red-7a.txt ]' });
  const a7 = branch('a7', ['red-7a.txt']), b7 = branch('b7', ['f-b7.txt']);
  arc = rev('arc');
  envc(`[ "$(git rev-parse HEAD)" = "${arc}" ]`);
  enq('a7'); enq('b7');
  r = tr('run'); o = last(r);
  envc(null);
  h = haltJ();
  ok('R7 cannot on the bare arc -> environment, halted, the reason names the bare arc head', o && o.verdict === 'environment' && h && /^environment: /.test(h.reason || '') && /bare arc head/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  ok('R7 cannot on the bare arc -> a7 (red alone) gets no verdict, both stay', !result('a7', a7) && !result('b7', b7) && queued() === 'a7,b7', queued());
  ok('R7 cannot on the bare arc -> no attribution worktree, no label ref left', !ls(wts).some((n) => n.startsWith('train-')) && labelRefs().length === 0, ls(wts).join() + ' ' + labelRefs().join(' '));
  clean();

  // ---- R7 on a pair: a seam of three, the attribution cannot run on one pair -> the environment, no seam named ----
  rules({ 'g-7p': '[ -f s7a.txt ] && [ -f s7b.txt ] && [ -f s7c.txt ]' });
  const p1 = branch('p1', ['s7a.txt']), p2 = branch('p2', ['s7b.txt']), p3 = branch('p3', ['s7c.txt']);
  envc('[ -f s7a.txt ] && [ -f s7b.txt ] && [ ! -f s7c.txt ]');
  enq('p1'); enq('p2'); enq('p3');
  r = tr('run'); o = last(r);
  envc(null);
  h = haltJ();
  ok('R7 cannot on the pair p1 + p2 -> environment, halted, the reason names that pair', o && o.verdict === 'environment' && h && /^environment: /.test(h.reason || '') && /arc \+ p1 \+ p2/.test(h.reason || ''), `${r.stdout}${r.stderr} ${JSON.stringify(h)}`);
  ok('R7 cannot on a pair -> no seam verdict, all three stay', [p1, p2, p3].every((hd, i) => !result(`p${i + 1}`, hd)) && queued() === 'p1,p2,p3', queued());
  clean();

  // ---- R4: await of the later passenger of a seam prints its seam with the partner ----
  rules({ 'g-4': '[ -f s4a.txt ] && [ -f s4b.txt ]' });
  const z1 = branch('z1', ['s4a.txt']), z2 = branch('z2', ['s4b.txt']);
  enq('z1'); enq('z2');
  tr('run');
  r = tr('await', '--task', 'z2', '--head', z2); o = last(r);
  ok('R4 await of the later passenger -> seam with partner z1', r.status === 0 && o && o.verdict === 'seam' && o.partner === 'z1', r.stdout + r.stderr);
  ok('R4 the earlier stays in the queue', queued() === 'z1', queued());
  ok('no train worktree and no attribution ref left at the end', !ls(wts).some((n) => n.startsWith('train-')) && labelRefs().length === 0, ls(wts).join() + ' ' + labelRefs().join(' '));
}

main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
});
