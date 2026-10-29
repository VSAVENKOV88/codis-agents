#!/usr/bin/env node
'use strict';
// The train dispatcher, the tester's cells of review round 1's fix (p-train-c1, tester round 2), beyond
// train-lock-race.test.js:
//   G1 lock.break without its owner file (a breaker died between mkdir and its pid): younger than 60 s it is kept (busy,
//      the dead lock stays); older it is removed, and the next run breaks the dead lock and departs;
//   G2 a lock.dead-* whose train worktree cannot be removed (a directory there that is not a registered worktree) stays
//      for the next train, the train itself still departs green, nothing else is touched;
//   G3 a lock.dead-* whose wt is not a train worktree (outside worktreeRoot) is dropped without removing that worktree;
//   G4 two lock.dead-* left by breakers that died after the rename: the next holder reaps both (both worktrees removed);
//   G5 the slow removal of a dead train's worktree with competing dispatchers: while it runs, every other `run` is busy,
//      the worktree is removed once, exactly one train departs and no two guard runs overlap (D4).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js dead-lock reaping (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-reap-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train'), LOCK = path.join(TD, 'lock'), BRK = path.join(TD, 'lock.break');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const SLOW = path.join(T, 'slow-on'), RM = path.join(T, 'rm-seen.txt'), RUNS = path.join(T, 'guard-runs.txt');

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// git as the dispatcher sees it: a removal of a dead train's worktree is noted; with slow-on it takes 4 s (a cloned corpus)
sh(path.join(bin, 'git'), `#!/bin/sh
case "$*" in *"worktree remove"*train-dead*)
  echo "$$ $*" >> '${RM}'
  [ -e '${SLOW}' ] && { touch '${T}/rm-started'; sleep 4; };;
esac
exec '${realGit}' "$@"
`);
// a guard run: notes its start and end, so overlapping trains are seen
sh(path.join(T, 'guard.sh'), `#!/bin/sh\necho "start $$" >> '${RUNS}'\nsleep 1\necho "end $$" >> '${RUNS}'\necho "=== 9 passed in 0.1s ==="\nexit 0\n`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `cd {wt} && ${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.2', CODIS_AGENTS_CONFIG: cfgFile });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR', 'NODE_OPTIONS']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });
const trAsync = (...a) => new Promise((res) => {
  const p = spawn(process.execPath, [TRAIN, ...a], { cwd: T, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => res({ status, stdout: out, stderr: err }));
});
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const enq = (task, br) => tr('enqueue', '--task', task, '--branch', br, '--head', rev(br), '--base', 'arc');
const branch = (name, file, text) => {
  git(main, 'branch', '-f', name, 'arc');
  const tmpWt = path.join(T, 'mk-' + name);
  git(main, 'worktree', 'add', '-q', tmpWt, name);
  put(path.join(tmpWt, file), text);
  git(tmpWt, 'add', file); git(tmpWt, 'commit', '-q', '-m', `${name}: ${file}`);
  git(main, 'worktree', 'remove', '--force', tmpWt);
  return rev(name);
};
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); };
const past = (f) => { const t = new Date(Date.now() - 120000); fs.utimesSync(f, t, t); };
const deadLock = (extra = {}) => {
  const dp = deadPid();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify(Object.assign({ pid: dp, child: dp, train: 'dead', since: new Date().toISOString() }, extra)));
  return dp;
};
const lockLeft = () => ls(TD).filter((n) => n === 'lock' || n.startsWith('lock.'));
const wtList = () => git(main, 'worktree', 'list').stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  put(path.join(main, 'data', 'corpus.txt'), 'the corpus');

  // ---- G1: lock.break without its owner file ----
  const g1 = branch('g1', 'f-g1.txt', 'g1\n');
  enq('g1', 'g1');
  deadLock();
  fs.mkdirSync(BRK);
  let r = tr('run'), o = last(r);
  ok('G1 a young lock.break without its owner file is kept: busy, the dead lock and lock.break stay, g1 waits',
    o && o.departed === false && o.busy && fs.existsSync(BRK) && fs.existsSync(LOCK) && !result('g1', g1), `${r.stdout}${r.stderr} ${lockLeft()}`);
  past(BRK);
  r = tr('run'); o = last(r);
  if (o && o.busy) { r = tr('run'); o = last(r); }
  ok('G1 an old lock.break without its owner file is removed, the dead lock broken, g1 rides green',
    o && o.departed && o.verdict === 'green' && result('g1', g1) && lockLeft().length === 0, `${r.stdout}${r.stderr} ${lockLeft()}`);

  // ---- G2: the dead train's worktree cannot be removed -> its lock.dead-* stays, the train departs ----
  const g2 = branch('g2', 'f-g2.txt', 'g2\n');
  enq('g2', 'g2');
  const ghost = path.join(wts, 'train-dead-ghost');
  put(path.join(ghost, 'keep.txt'), 'not a worktree');
  deadLock({ wt: ghost });
  r = tr('run'); o = last(r);
  const dead2 = lockLeft().filter((n) => n.startsWith('lock.dead-'));
  ok('G2 a dead train\'s worktree that cannot be removed: g2 still rides green', o && o.departed && o.verdict === 'green' && result('g2', g2), r.stdout + r.stderr);
  ok('G2 its lock.dead-* stays for the next train (with its owner file), the directory there is untouched, stderr names it',
    dead2.length === 1 && readJ(path.join(TD, dead2[0], 'owner.json')) && readJ(path.join(TD, dead2[0], 'owner.json')).wt === ghost
      && read(path.join(ghost, 'keep.txt')) === 'not a worktree' && /the dead train's worktree stays/.test(r.stderr) && !fs.existsSync(LOCK),
    `${lockLeft()} | ${r.stderr}`);
  fs.rmSync(ghost, { recursive: true, force: true });
  for (const n of dead2) fs.rmSync(path.join(TD, n), { recursive: true, force: true });

  // ---- G3: a lock.dead-* whose wt is not a train worktree ----
  const g3 = branch('g3', 'f-g3.txt', 'g3\n');
  enq('g3', 'g3');
  const foreign = path.join(T, 'elsewhere', 'train-dead-foreign');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  git(main, 'worktree', 'add', '-q', '--detach', foreign, 'arc');
  deadLock({ wt: foreign });
  r = tr('run'); o = last(r);
  ok('G3 a dead lock naming a worktree outside worktreeRoot: g3 rides green, that worktree is not removed, no lock.* left',
    o && o.departed && o.verdict === 'green' && result('g3', g3) && fs.existsSync(path.join(foreign, 'base.txt')) && wtList().includes(foreign) && lockLeft().length === 0,
    `${r.stdout}${r.stderr} ${lockLeft()} | ${wtList()}`);
  git(main, 'worktree', 'remove', '--force', foreign);

  // ---- G4: two lock.dead-* left by breakers that died after the rename ----
  const g4 = branch('g4', 'f-g4.txt', 'g4\n');
  enq('g4', 'g4');
  const dA = path.join(wts, 'train-dead-a'), dB = path.join(wts, 'train-dead-b');
  for (const [d, n] of [[dA, 'lock.dead-1-1'], [dB, 'lock.dead-2-2']]) {
    git(main, 'worktree', 'add', '-q', '--detach', d, 'arc');
    put(path.join(TD, n, 'owner.json'), JSON.stringify({ pid: deadPid(), child: deadPid(), train: n, wt: d }));
  }
  fs.mkdirSync(BRK); fs.writeFileSync(path.join(BRK, 'owner.json'), JSON.stringify({ pid: deadPid() }));
  r = tr('run'); o = last(r);
  ok('G4 no lock, two lock.dead-* of dead breakers: g4 rides green, both dead worktrees removed, both lock.dead-* gone',
    o && o.departed && o.verdict === 'green' && result('g4', g4) && !fs.existsSync(dA) && !fs.existsSync(dB)
      && !wtList().includes('train-dead-') && !lockLeft().some((n) => n.startsWith('lock.dead-')),
    `${r.stdout}${r.stderr} ${lockLeft()} | ${wtList()}`);
  fs.rmSync(BRK, { recursive: true, force: true });

  // ---- G5: a slow removal of the dead train's worktree with competing dispatchers ----
  fs.rmSync(RM, { force: true }); fs.rmSync(RUNS, { force: true });
  const g5 = branch('g5', 'f-g5.txt', 'g5\n');
  enq('g5', 'g5');
  const dS = path.join(wts, 'train-dead-slow');
  git(main, 'worktree', 'add', '-q', '--detach', dS, 'arc');
  deadLock({ wt: dS });
  fs.writeFileSync(SLOW, '');
  const trainsBefore = ls(path.join(TD, 'trains')).length;
  const first = trAsync('run');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(T, 'rm-started')); i++) await sleep(100);
  const started = fs.existsSync(path.join(T, 'rm-started'));
  // during the 4 s removal: competitors one after another, then two at once
  const during = [];
  for (let i = 0; i < 3; i++) { during.push(await trAsync('run')); await sleep(300); }
  during.push(...await Promise.all([trAsync('run'), trAsync('run')]));
  const r1 = await first;
  const o1 = last(r1);
  const os_ = during.map(last);
  fs.rmSync(SLOW, { force: true });
  const rmLines = (read(RM) || '').trim().split('\n').filter(Boolean);
  const runs = (read(RUNS) || '').trim().split('\n').filter(Boolean);
  let depth = 0, maxDepth = 0;
  for (const l of runs) { depth += l.startsWith('start') ? 1 : -1; maxDepth = Math.max(maxDepth, depth); }
  ok('G5 the slow removal started (the git wrapper saw it)', started, rmLines.join(' | '));
  ok('G5 every run during the slow removal is busy (none departs, none breaks the reaper\'s lock)',
    started && os_.every((x) => x && x.departed === false && x.busy), during.map((x) => x.stdout.trim() + x.stderr.trim()).join(' || '));
  ok('G5 the first dispatcher departs g5 green after the removal', o1 && o1.departed && o1.verdict === 'green' && result('g5', g5), r1.stdout + r1.stderr);
  ok('G5 the dead worktree removed exactly once, gone afterwards', rmLines.length === 1 && !fs.existsSync(dS) && !wtList().includes('train-dead-slow'), rmLines.join(' | ') + ' | ' + wtList());
  ok('G5 exactly one train departed and no two guard runs overlapped (D4)', ls(path.join(TD, 'trains')).length - trainsBefore === 1 && maxDepth === 1 && runs.length === 2,
    `trains +${ls(path.join(TD, 'trains')).length - trainsBefore}, runs ${runs.join(',')}`);
  ok('G5 nothing of the dead lock is left', lockLeft().length === 0, lockLeft().join());
}

let finished = false;
process.on('beforeExit', () => { if (!finished) { finished = true; ok('the test ran to its end', false, 'the event loop emptied before the tally'); done(); } });
main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  finished = true;
  done();
});
