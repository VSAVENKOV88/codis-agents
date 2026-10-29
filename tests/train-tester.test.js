#!/usr/bin/env node
'use strict';
// The train dispatcher, tester's cells beyond tests/train.test.js (p-train-c1, round 1 of the tester):
//   I1 entries of another arc branch wait for the next train; that train moves their arc;
//   I2 the train's worktree cannot be made (wt-setup.sh fails) -> the environment: halt, the passenger stays;
//   I3 the environment codes 64/66/72/73 of guards-all.sh halt the queue like 69/124/77/78;
//   I4 a real dispatcher killed by SIGKILL in the middle of its run: the lock holds while its guard run lives, then it is
//      broken, the dead train's worktree removed, the passenger rides the next train (no result from the dead one);
//   I5 a lock without its owner file: younger than 60 s - busy, older - broken;
//   I6 await with no entry and no result -> 66, also for the old head of a task that was enqueued again;
//   I7 enqueue of a new head of a queued task replaces its entry;
//   I8 an unreadable queue file does not stop the others;
//   I9 the arc checked out in the main working copy itself -> merge --ff-only there, the copy stays clean;
//   I10 a passenger whose head is already in the arc (a relaunch after a dead dispatcher) -> green, the arc tree unchanged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js tester cells (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-tester-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
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
echo "$PWD $(git rev-parse HEAD)" >> "$T/calls.txt"
[ -f "$T/sleep" ] && sleep "$(cat "$T/sleep")"
rc=$(cat "$T/rc" 2>/dev/null || echo 0)
[ "$rc" = 0 ] && echo "=== 9 passed in 0.1s ==="
exit "$rc"
`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const config = (file, over) => fs.writeFileSync(file, JSON.stringify(Object.assign({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `cd {wt} && ${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }, over)));
const cfgFile = path.join(T, 'cfg.json');
config(cfgFile, {});
const baseEnv = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete baseEnv[k];
const env = Object.assign({}, baseEnv, { CODIS_AGENTS_CONFIG: cfgFile });
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const calls = () => (read(path.join(T, 'calls.txt')) || '').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
const clearCalls = () => fs.rmSync(path.join(T, 'calls.txt'), { force: true });
const setRc = (n) => fs.writeFileSync(path.join(T, 'rc'), String(n));
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f))).filter(Boolean);
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const enq = (task, branch, head = rev(branch), base = 'arc') => tr('enqueue', '--task', task, '--branch', branch, '--head', head, '--base', base);
const branch = (name, file, text, from = 'arc') => {
  git(main, 'branch', '-f', name, from);
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  put(path.join(tmpWt, file), text);
  git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `${name}: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
const trainWts = () => ls(wts).filter((n) => n.startsWith('train-'));

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc'); git(main, 'branch', 'arc2');
  put(path.join(main, 'data', 'corpus.txt'), 'the corpus');
  setRc(0);

  // ---- I1: entries of another arc branch wait; the next train takes them onto their own arc ----
  const a = branch('a', 'f-a.txt', 'a\n'); const b2 = branch('b2', 'f-b2.txt', 'b2\n', 'arc2'); const c = branch('c', 'f-c.txt', 'c\n');
  enq('a', 'a'); enq('b2', 'b2', b2, 'arc2'); enq('c', 'c');
  const arc2a = rev('arc2');
  let r = tr('run'); let o = last(r);
  ok('I1 the first train takes only the entries of the first arrival\'s arc (a, c), b2 of arc2 waits',
    o && o.verdict === 'green' && JSON.stringify(o.passengers) === '["a","c"]' && result('a', a) && result('c', c) && !result('b2', b2)
    && queue().length === 1 && queue()[0].task === 'b2' && rev('arc2') === arc2a && rev('arc') === o.sha, r.stdout + r.stderr);
  r = tr('run'); o = last(r);
  ok('I1 the next train takes b2 onto arc2 and moves arc2, not arc', o && o.verdict === 'green' && rev(`${o.sha}^1`) === arc2a && rev('arc2') === o.sha
    && result('b2', b2) && result('b2', b2).verdict === 'green' && git(main, 'cat-file', '-e', `${o.sha}:f-a.txt`).status !== 0, r.stdout + r.stderr);

  // ---- I3: environment codes 64, 66, 72, 73 of guards-all.sh ----
  const m = branch('m', 'f-m.txt', 'm\n');
  enq('m', 'm');
  for (const code of [64, 66, 72, 73]) {
    setRc(code); clearCalls();
    const arcB = rev('arc');
    r = tr('run'); o = last(r);
    const hf = read(path.join(TD, 'halt'));
    ok(`I3 exit ${code} -> environment, no result, m stays, arc unchanged, halt with the code`,
      o && o.verdict === 'environment' && calls().length === 1 && !result('m', m) && queue().length === 1 && rev('arc') === arcB && hf && hf.includes(`exit ${code}`), `${r.stdout}${r.stderr} ${hf}`);
    tr('resume');
  }
  setRc(0);
  // a red that is not the environment (exit 1) is not reported as environment
  setRc(1);
  r = tr('run'); o = last(r);
  ok('I3 exit 1 is a red train, not the environment (no merge, m stays)', o && o.verdict === 'red' && !result('m', m) && queue().length === 1, r.stdout + r.stderr);
  tr('resume'); setRc(0);
  r = tr('run'); o = last(r);
  ok('I3 after resume m rides green', o && o.verdict === 'green' && result('m', m), r.stdout + r.stderr);

  // ---- I6 + I7: await without an entry; enqueue of a new head replaces the entry ----
  r = tr('await', '--task', 'nobody', '--head', 'f'.repeat(40));
  ok('I6 await with no entry and no result -> exit 66', r.status === 66, r.stdout + r.stderr);
  const g1 = branch('g', 'f-g.txt', 'g\n');
  enq('g', 'g');
  const g2 = branch('g', 'f-g2.txt', 'g2\n', 'g');
  r = enq('g', 'g');
  ok('I7 enqueue of a new head of a queued task -> one entry, the new head', r.status === 0 && queue().length === 1 && queue()[0].head === g2, JSON.stringify(queue()));
  r = tr('await', '--task', 'g', '--head', g1);
  ok('I6 await of the replaced head -> exit 66', r.status === 66, r.stdout + r.stderr);
  // ---- I8: an unreadable queue file does not stop the others ----
  put(path.join(TD, 'queue', '0000000000001-bad.json'), '{ not json');
  r = tr('await', '--task', 'g', '--head', g2); o = last(r);
  ok('I8 an unreadable queue file next to g -> g rides green (await dispatches)', r.status === 0 && o && o.verdict === 'green' && result('g', g2) && rev('arc^2') === g2, r.stdout + r.stderr);
  fs.rmSync(path.join(TD, 'queue', '0000000000001-bad.json'), { force: true });

  // ---- I10: a passenger whose head is already in the arc -> green, the arc tree unchanged ----
  const treeBefore = rev('arc^{tree}');
  enq('again', 'g', g2);
  r = tr('run'); o = last(r);
  ok('I10 a head already in the arc -> green, the arc tree unchanged', o && o.verdict === 'green' && result('again', g2) && rev('arc^{tree}') === treeBefore, r.stdout + r.stderr);

  // ---- I5: a lock without its owner file ----
  const p = branch('p', 'f-p.txt', 'p\n');
  enq('p', 'p');
  const LOCK = path.join(TD, 'lock');
  fs.mkdirSync(LOCK);
  r = tr('run'); o = last(r);
  ok('I5 a fresh lock without its owner file -> busy, nothing leaves', o && o.departed === false && o.busy && !result('p', p) && fs.existsSync(LOCK), r.stdout + r.stderr);
  const past = new Date(Date.now() - 120000);
  fs.utimesSync(LOCK, past, past);
  r = tr('run'); o = last(r);
  ok('I5 a lock without its owner file older than 60 s -> broken, p rides green', o && o.departed && o.verdict === 'green' && result('p', p) && !fs.existsSync(LOCK), r.stdout + r.stderr);

  // ---- I4: a real dispatcher killed by SIGKILL mid-run ----
  const w = branch('w', 'f-w.txt', 'w\n');
  enq('w', 'w');
  fs.writeFileSync(path.join(T, 'sleep'), '6');
  clearCalls();
  const ch = spawn(process.execPath, [TRAIN, 'run'], { cwd: T, env, stdio: 'ignore' });
  const closed = new Promise((z) => ch.on('close', z));   // attached at once: a run that ends early still resolves
  for (let i = 0; i < 150 && !fs.existsSync(path.join(T, 'calls.txt')); i++) await wait(100);
  const own = readJ(path.join(LOCK, 'owner.json')) || {};
  const deadWt = own.wt;
  ch.kill('SIGKILL');
  await closed;
  const childAlive = own.child && alive(own.child);
  r = tr('run'); o = last(r);
  ok('I4 the dispatcher killed, its guard run still alive -> the lock holds (busy), no result', childAlive && o && o.busy && !result('w', w), `${childAlive} ${r.stdout}${r.stderr}`);
  for (let i = 0; i < 300 && own.child && alive(own.child); i++) await wait(100);
  fs.rmSync(path.join(T, 'sleep'), { force: true });
  clearCalls();
  r = tr('run'); o = last(r);
  ok('I4 its guard run gone -> the lock is broken, w rides the next train green', o && o.departed && o.verdict === 'green' && result('w', w) && o.train !== own.train, r.stdout + r.stderr);
  ok('I4 the dead train\'s worktree is removed, no train worktree left', deadWt && !fs.existsSync(deadWt) && !trainWts().length
    && !git(main, 'worktree', 'list', '--porcelain').stdout.includes(path.join(wts, 'train-')), `${deadWt} exists=${deadWt && fs.existsSync(deadWt)} wts=${trainWts().join()}`);
  ok('I4 the killed train wrote no result and no record of a verdict', !fs.existsSync(path.join(TD, 'trains', `${own.train}.json`)) || !(readJ(path.join(TD, 'trains', `${own.train}.json`)) || {}).verdict);

  // ---- I9: the arc checked out in the main working copy itself -> ff-only there ----
  const z = branch('z', 'f-z.txt', 'z\n');
  git(main, 'checkout', '-q', 'arc');
  enq('z', 'z');
  r = tr('run'); o = last(r);
  ok('I9 arc checked out in the main working copy -> green, that copy is at the train commit and clean (no staged deletions)',
    o && o.verdict === 'green' && rev('HEAD') === o.sha && rev('arc') === o.sha && git(main, 'status', '--porcelain', '--untracked-files=no').stdout === ''
    && fs.existsSync(path.join(main, 'f-z.txt')), `${r.stdout}${r.stderr} ${git(main, 'status', '--porcelain').stdout}`);
  git(main, 'checkout', '-q', 'main');

  // ---- I2: the worktree of the train cannot be made -> the environment ----
  const sh2 = path.join(T, 'shared2'), cfg2 = path.join(T, 'cfg2.json');
  const notDir = path.join(T, 'not-a-dir');
  fs.writeFileSync(notDir, 'a file where the worktree root should be');
  config(cfg2, { sharedDir: sh2, worktreeRoot: notDir });
  const env2 = Object.assign({}, baseEnv, { CODIS_AGENTS_CONFIG: cfg2 });
  const tr2 = (...a2) => spawnSync(process.execPath, [TRAIN, ...a2], { cwd: T, encoding: 'utf8', env: env2, timeout: 180000 });
  const q = branch('q', 'f-q.txt', 'q\n');
  tr2('enqueue', '--task', 'q', '--branch', 'q', '--head', q, '--base', 'arc');
  clearCalls();
  const arcQ = rev('arc');
  r = tr2('run'); o = last(r);
  const h2 = read(path.join(sh2, 'train', 'halt'));
  ok('I2 wt-setup.sh fails -> environment: no guard run, no result, q stays, arc unchanged, halt names the worktree',
    o && o.verdict === 'environment' && !calls().length && !readJ(path.join(sh2, 'train', 'result', `q-${q}.json`))
    && ls(path.join(sh2, 'train', 'queue')).length === 1 && rev('arc') === arcQ && h2 && /worktree/.test(h2), `${r.stdout}${r.stderr} ${h2}`);
  ok('I2 the lock is released after the environment', !fs.existsSync(path.join(sh2, 'train', 'lock')));
}

// a promise that never settles would end node with exit 0 before the tally: count it as a failure
let finished = false;
process.on('beforeExit', () => { if (!finished) { finished = true; ok('the test ran to its end', false, 'the event loop emptied early'); cleanup(); } });
const cleanup = () => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
};
main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => { finished = true; cleanup(); });
