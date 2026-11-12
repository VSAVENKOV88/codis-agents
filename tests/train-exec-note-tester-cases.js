'use strict';
// Tester cell of A2b-1a, run as a child of tests/slots-exec.test.sh (TL-note, A'24) for scripts/train.js itself: a real train runs its guards-all.sh with
// SLOT_EXEC_NOTE=<lock>/exec, so the process group of the slot's command (the guard run) is noted in the train lock
// while it runs, and the command does not inherit SLOT_EXEC_NOTE. tests/slots-exec.test.sh A'24 sets the variable by
// hand; this test checks that train.js passes it.
//   N1 while the guard runs, <sharedDir>/train/lock/exec names the guard's process group;
//   N2 the guard's environment has no SLOT_EXEC_NOTE;
//   N3 the train ends green and releases its lock;
//   N4 a red train: before its attribution run <lock>/exec keeps only the groups still alive (a live one stays).
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

let LIVE = 0;
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

  // N4: a red train runs guards-all.sh again for its attribution. Its full run left in <lock>/exec its own group (dead
  // by then), a dead pgid and a live group of another process; before the attribution run the dead ones are gone and
  // the live one stays, so a pgid of an earlier run that the system gives to an unrelated group later cannot hold the
  // lock of a dead dispatcher.
  // the live group is not a child of this process (sh leaves it to init): a killed child left unreaped here would be a
  // zombie, and a group of zombies answers EPERM on macOS, i.e. alive
  LIVE = Number(spawnSync('sh', ['-c', 'perl -e "setpgrp(0, 0) or die; sleep 120" </dev/null >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
  sh(path.join(T, 'guard2.sh'), `#!/bin/sh
T='${T}'
SUBSET=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --subset) SUBSET=1;; --only) ONLY="$ONLY $2"; shift;; esac; shift; done
if [ "$SUBSET" = 0 ] && [ -z "$ONLY" ]; then
  ps -o pgid= -p $$ | tr -d ' ' > "$T/full-pgid.txt"
  printf '99999999\\n${LIVE}\\n' >> '${path.join(LOCK, 'exec')}'
fi
if [ "$SUBSET" = 1 ] && [ ! -e "$T/attr-noted.txt" ]; then
  ps -o pgid= -p $$ | tr -d ' ' > "$T/attr-pgid.txt"
  cat '${path.join(LOCK, 'exec')}' > "$T/attr-noted.txt" 2>/dev/null
fi
if [ "$SUBSET" = 1 ] && [ ! -f f-q.txt ]; then echo "PASSED g1"; echo "=== 0 failed, 1 passed, 1 total in 0.1s ==="; exit 0; fi
echo "FAILED g1 - red"
echo "=== 1 failed, 0 passed, 1 total in 0.1s ==="
exit 1
`);
  const G2 = path.join(T, 'guard2.sh');
  const cfg2 = path.join(T, 'cfg2.json');
  fs.writeFileSync(cfg2, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), {
    guardCommand: `cd {wt} && ${G2}`,
    guardSubsetCommand: `cd {wt} && ${G2} --subset {onlyArgs}`,
    guardRerun: { command: `cd {wt} && ${G2} --only {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .*?(\\d+) total in [0-9.]+s ===$' } })));
  env.CODIS_AGENTS_CONFIG = cfg2;
  git(main, 'branch', '-f', 'q', 'arc');
  const mq = path.join(T, 'mq');
  git(main, 'worktree', 'add', '-q', mq, 'q');
  put(path.join(mq, 'f-q.txt'), 'q\n'); git(mq, 'add', 'f-q.txt'); git(mq, 'commit', '-q', '-m', 'q');
  git(main, 'worktree', 'remove', '--force', mq);
  tr('enqueue', '--task', 'q', '--branch', 'q', '--head', rev('q'), '--base', 'arc');
  const r2 = tr('run'); const o2 = last(r2.stdout);
  const full = (read(path.join(T, 'full-pgid.txt')) || '').trim(), apg = (read(path.join(T, 'attr-pgid.txt')) || '').trim();
  const an = (read(path.join(T, 'attr-noted.txt')) || '').split('\n').filter(Boolean);
  const why = `full run group '${full}', attribution group '${apg}', live ${LIVE}, noted at the attribution '${an.join(',')}'; ${JSON.stringify(o2)} ${r2.stderr.slice(-600)}`;
  ok('N4 (setup) the red train ran its attribution in a group of its own', /^\d+$/.test(full) && /^\d+$/.test(apg) && full !== apg && an.length > 0, why);
  ok('N4 before the attribution run <lock>/exec keeps the live group and drops the dead ones (the dead pgid, the full run)', an.includes(String(LIVE)) && an.includes(apg) && !an.includes('99999999') && !an.includes(full), why);
  // the dispatcher dead: the lock lives while the kept group lives and is dead after it
  const L2 = path.join(T, 'lock-copy');
  put(path.join(L2, 'exec'), an.filter((g) => g !== apg).join('\n') + '\n');
  const TL = require(path.join(ROOT, 'scripts', 'train-lock.js'));
  const deadOwner = { pid: 99999997, child: 99999996, pgid: 99999995 };
  const before = TL.holderAlive(deadOwner, L2);
  try { process.kill(-LIVE, 'SIGKILL'); } catch { /* gone */ }
  let after = true;
  for (let i = 0; i < 50 && (after = TL.holderAlive(deadOwner, L2)); i++) spawnSync('sleep', ['0.1']);
  ok('N4 the lock of a dead dispatcher lives while the kept group lives, and is dead after it', before === true && after === false, `before ${before}, after ${after}; ${why}`);
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  if (LIVE > 1) { try { process.kill(-LIVE, "SIGKILL"); } catch { /* gone */ } }
  try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
  fs.rmSync(T, { recursive: true, force: true });
  done();
}
