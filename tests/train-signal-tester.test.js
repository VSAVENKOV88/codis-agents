'use strict';
// Tester, round 3 of p-train-c1: cells of the "run ended by a signal" fix (D19, UC-7 Err 1, finding F1) beyond
// tests/train-signal.test.js, all with the real guards-all.sh and slots:
//   X1 the guard runner itself (guardCommand's child) is killed by SIGKILL mid-run (the OOM / jetsam case of the rule
//      "a full run cut off before its tally - the environment"): guards-all.sh passes 137 on -> environment naming
//      SIGKILL, halt, no result, the passenger stays, the arc is not moved;
//   X2 SIGINT to the train's guards-all.sh (the slot trap: 143) -> environment, as SIGTERM/SIGHUP;
//   X3 the runner exits 128 (POSIX: only a status above 128 is a signal) -> not a signal; its log has no tally, so the
//      environment by the log (coordinator's decision for p-train-c2: a log without its tally is the environment);
//   X4 the runner exits 200 (128 + 72, no such signal) -> the same: not a signal, the environment by the missing tally;
//   X5 a real red (tally reached, exit 1) stays a red train: not attributed here (no repeated new red in its log), so
//      the halt for the coordinator with the verdict coordinator (p-train-c3), not the environment;
//   X6 after resume, with the runner green, the passenger rides green.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js signal cells (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-signal-')));
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
echo "$PWD" >> "$T/calls.txt"
m=$(cat "$T/mode" 2>/dev/null)
case "$m" in
  sigkill) sleep 1; kill -KILL $$ ;;
  sleep) sleep 20 ;;
  e128) echo "boom before the tally"; exit 128 ;;
  e200) echo "boom before the tally"; exit 200 ;;
  red) echo "=== 1 failed, 8 passed in 0.1s ==="; exit 1 ;;
esac
echo "=== 9 passed in 0.1s ==="
exit 0
`);
sh(path.join(T, 'one.sh'), '#!/bin/sh\nexit 0\n');
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: `cd {wt} && ${path.join(T, 'guard.sh')}`,
  guardRerun: { command: `cd {wt} && ${path.join(T, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  guardBaseline: 'known.json',
  worktreeSetup: { scan: ['data'], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
  SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3', CODIS_AGENTS_CONFIG: cfgFile });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });
const last = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json'));
const LOCK = path.join(TD, 'lock');
// the slot trap exits 143 on INT, TERM and HUP alike, so the reason names 128+15 = SIGTERM (not the temp path's word)
const SIG = /guards-all\.sh exit 143 by a signal \(SIGTERM\)/;


const mode = (m) => { if (m) fs.writeFileSync(path.join(T, 'mode'), m); else fs.rmSync(path.join(T, 'mode'), { force: true }); };

// a train whose guards-all.sh gets `sig` while its guard sleeps
async function killedTop(sig) {
  fs.rmSync(path.join(T, 'calls.txt'), { force: true });
  mode('sleep');
  const ch = spawn(process.execPath, [TRAIN, 'run'], { cwd: T, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let s = '';
  ch.stdout.on('data', (x) => { s += x; }); ch.stderr.on('data', (x) => { s += x; });
  const closed = new Promise((z) => ch.on('close', z));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(T, 'calls.txt')); i++) await wait(100);
  const own = readJ(path.join(LOCK, 'owner.json')) || {};
  const sent = !!own.child && alive(own.child);
  if (sent) process.kill(own.child, sig);
  await closed;
  mode(null);
  return { o: last(s), s, own, sent };
}
const runWith = (m) => { mode(m); const r = tr('run'); mode(null); const o = last(r.stdout) || {};
  return { o, s: r.stdout + r.stderr, own: { train: o.train } }; };

async function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  git(main, 'branch', '-f', 'p', 'arc');
  const mk = path.join(T, 'mk');
  git(main, 'worktree', 'add', '-q', mk, 'p');
  put(path.join(mk, 'f-p.txt'), 'p\n'); git(mk, 'add', 'f-p.txt'); git(mk, 'commit', '-q', '-m', 'p');
  git(main, 'worktree', 'remove', '--force', mk);
  const p = rev('p'), arc0 = rev('arc');
  tr('enqueue', '--task', 'p', '--branch', 'p', '--head', p, '--base', 'arc');

  const stays = (cell) => ok(`${cell} no result, the passenger stays in the queue, the arc is not moved, the lock is released`,
    !fs.existsSync(path.join(TD, 'result', `p-${p}.json`)) && queue().length === 1 && rev('arc') === arc0 && !fs.existsSync(LOCK),
    `${queue().join()} ${rev('arc')} lock=${fs.existsSync(LOCK)}`);
  const cases = [
    ['X1', 'the runner killed by SIGKILL', () => runWith('sigkill'), 'environment', /guards-all\.sh exit 137 by a signal \(SIGKILL\)/],
    ['X2', 'SIGINT to guards-all.sh', () => killedTop('SIGINT'), 'environment', /guards-all\.sh exit 143 by a signal \(SIGTERM\)/],
    ['X3', 'the runner exits 128', () => runWith('e128'), 'environment', /guards-all\.sh exit 128 without the tally/],
    ['X4', 'the runner exits 200', () => runWith('e200'), 'environment', /guards-all\.sh exit 200 without the tally/],
    ['X5', 'a real red with its tally', () => runWith('red'), 'coordinator', /guards-all\.sh exit 1\)/],
  ];
  let first = true;
  for (const [cell, what, go, want, re] of cases) {
    if (!first) tr('resume'); first = false;
    const { o, s, own, sent } = await go();
    if (sent !== undefined) ok(`${cell} the signal reached the train's guards-all.sh mid-run`, sent, JSON.stringify(own));
    const rec = readJ(path.join(TD, 'trains', `${own.train}.json`)) || {};
    const halt = readJ(path.join(TD, 'halt')) || {};
    ok(`${cell} ${what} -> ${want}, halted`, o && o.halted === true && rec.verdict === want && re.test(o.reason || ''), s + ' | rec ' + JSON.stringify(rec));
    ok(`${cell} the halt is ${want === 'environment' ? "the environment's" : "a red train's"}`,
      want === 'environment' ? /^environment: /.test(halt.reason || '') && re.test(halt.reason) : /^red train /.test(halt.reason || ''), JSON.stringify(halt));
    stays(cell);
  }

  tr('resume');
  const r = tr('run'); const o = last(r.stdout);
  ok('X6 after resume the passenger rides the next train green', o && o.verdict === 'green' && rev('arc') === o.sha
    && (readJ(path.join(TD, 'result', `p-${p}.json`)) || {}).verdict === 'green', r.stdout + r.stderr);
}
let finished = false;
process.on('beforeExit', () => { if (!finished) { finished = true; ok('the test ran to its end', false, 'the event loop emptied early'); cleanup(); } });
const cleanup = () => {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
};
main_().catch((e) => ok('no exception', false, e && e.stack)).finally(() => { finished = true; cleanup(); });
