'use strict';
// scripts/train.js: a train whose guards-all.sh is killed by a signal mid-run is the environment, not a red train
// (cell D19 of p-train-ac, UC-7 Err 1; tester round 2, finding F1). guards-all.sh is run as it is: its slot trap
// (scripts/slots.zsh, INT/TERM/HUP) ends it with 143, which the dispatcher must read as "by a signal" just like an exit
// with no code. Cells:
//   S1 SIGTERM to the train's guards-all.sh while its guard runs -> verdict environment, the halt names exit 143 and
//      its signal (SIGTERM),
//      trains/<id>.json says environment, no result, the passenger stays in the queue, the arc is not moved;
//   S2 the same with SIGHUP after `resume`;
//   S3 after `resume` the passenger rides the next train green.
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
[ -f "$T/sleep" ] && sleep "$(cat "$T/sleep")"
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

// one train whose guards-all.sh gets `sig` while its guard sleeps; returns the dispatcher's last JSON line
async function killed(sig) {
  fs.rmSync(path.join(T, 'calls.txt'), { force: true });
  fs.writeFileSync(path.join(T, 'sleep'), '20');
  const ch = spawn(process.execPath, [TRAIN, 'run'], { cwd: T, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let s = '';
  ch.stdout.on('data', (x) => { s += x; }); ch.stderr.on('data', (x) => { s += x; });
  const closed = new Promise((z) => ch.on('close', z));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(T, 'calls.txt')); i++) await wait(100);
  const own = readJ(path.join(LOCK, 'owner.json')) || {};
  const sent = !!own.child && alive(own.child);
  if (sent) process.kill(own.child, sig);
  await closed;
  fs.rmSync(path.join(T, 'sleep'), { force: true });
  return { o: last(s), s, own, sent };
}

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

  for (const [cell, sig] of [['S1', 'SIGTERM'], ['S2', 'SIGHUP']]) {
    if (cell === 'S2') tr('resume');
    const { o, s, own, sent } = await killed(sig);
    const rec = readJ(path.join(TD, 'trains', `${own.train}.json`)) || {};
    const halt = readJ(path.join(TD, 'halt')) || {};
    ok(`${cell} ${sig} reached the train's guards-all.sh mid-run`, sent, JSON.stringify(own));
    ok(`${cell} ${sig} to guards-all.sh -> verdict environment, halted, not a red train`,
      o && o.verdict === 'environment' && o.halted === true && SIG.test(o.reason || ''), s);
    ok(`${cell} the train record says environment`, rec.verdict === 'environment', JSON.stringify(rec));
    ok(`${cell} the halt is the environment's and names the signal`, /^environment: /.test(halt.reason || '') && SIG.test(halt.reason || ''), JSON.stringify(halt));
    ok(`${cell} no result, the passenger stays in the queue, the arc is not moved, the lock is released`,
      !fs.existsSync(path.join(TD, 'result', `p-${p}.json`)) && queue().length === 1 && rev('arc') === arc0 && !fs.existsSync(LOCK),
      `${queue().join()} ${rev('arc')} lock=${fs.existsSync(LOCK)}`);
  }

  tr('resume');
  const r = tr('run'); const o = last(r.stdout);
  ok('S3 after resume the passenger rides the next train green', o && o.verdict === 'green' && rev('arc') === o.sha
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
