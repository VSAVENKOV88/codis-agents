'use strict';
// Tester cell of A2b-1a, run as a child of tests/slots-exec.test.sh (TL-note, A'24) for scripts/train.js itself: a real train runs its guards-all.sh with
// SLOT_EXEC_NOTE=<lock>/exec, so the process group of the slot's command (the guard run) is noted in the train lock
// while it runs, and the command does not inherit SLOT_EXEC_NOTE. tests/slots-exec.test.sh A'24 sets the variable by
// hand; this test checks that train.js passes it.
//   N1 while the guard runs, <sharedDir>/train/lock/exec names the guard's process group;
//   N2 the guard's environment has no SLOT_EXEC_NOTE;
//   N3 the train ends green and releases its lock.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh') || !has('perl')) { skip('scripts/train.js exec note (runs guards-all.sh, a zsh script, and slot-group.pl)', 'zsh or perl not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-exec-note-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train');
const LOCK = path.join(TD, 'lock');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref, cwd = main) => git(cwd, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
const tool = (name, body) => sh(path.join(bin, name), body);
tool('sysctl', '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
tool('memory_pressure', '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
tool('vm_stat', '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
tool('df', '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// the guard notes its own process group, the lock's exec file as it reads it, and SLOT_EXEC_NOTE of its environment
sh(path.join(T, 'guard.sh'), `#!/bin/sh
T='${T}'
ps -o pgid= -p $$ | tr -d ' ' > "$T/pgid.txt"
cat '${path.join(LOCK, 'exec')}' > "$T/noted.txt" 2>/dev/null
echo "\${SLOT_EXEC_NOTE:-none}" > "$T/env.txt"
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
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 180000 });
const last = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };

try {
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
  const p = rev('p');
  tr('enqueue', '--task', 'p', '--branch', 'p', '--head', p, '--base', 'arc');
  const r = tr('run'); const o = last(r.stdout);
  const pg = (read(path.join(T, 'pgid.txt')) || '').trim();
  const noted = (read(path.join(T, 'noted.txt')) || '').split('\n').filter(Boolean);
  ok('N1 while the guard runs, <lock>/exec names its process group', /^\d+$/.test(pg) && noted.includes(pg), `guard pgid '${pg}', noted '${noted.join(',')}'; ${r.stdout}${r.stderr}`);
  ok('N2 the guard does not inherit SLOT_EXEC_NOTE', (read(path.join(T, 'env.txt')) || '').trim() === 'none', read(path.join(T, 'env.txt')));
  ok('N3 the train is green and its lock released', o && o.verdict === 'green' && !fs.existsSync(LOCK), r.stdout + r.stderr);
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
}
