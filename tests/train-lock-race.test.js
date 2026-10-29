#!/usr/bin/env node
'use strict';
// The train dispatcher, races of review round 1 (p-train-c1):
//   R1 await: another dispatcher writes this entry's result and removes the entry between the waiter's read of the
//      result and its read of the queue -> the waiter prints that result (exit 0), never "no queue entry" (66);
//   R2 a dead holder's lock: its train worktree is removed only under the breaker's own lock (owner.json names the live
//      breaker, lock.break is gone), so a slow removal never leaves a window where a third process breaks the lock again;
//      no lock.dead-* left afterwards, the passenger rides green;
//   R3 lock.break names its pid: a live breaker's lock.break is not removed however old it is (the lock stays, busy);
//      a dead breaker's lock.break is removed, and the next run breaks the dead lock and departs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js lock races (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-race-')));
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

for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
// git as the dispatcher sees it: a removal of the dead train's worktree notes the lock's owner and lock.break at that moment
sh(path.join(bin, 'git'), `#!/bin/sh
case "$*" in *"worktree remove"*train-dead*)
  { printf 'owner='; cat '${LOCK}/owner.json' 2>/dev/null | tr -d '\\n'; printf '\\n'; [ -e '${BRK}' ] && echo 'break=yes' || echo 'break=no'; } >> '${T}/rm-seen.txt';;
esac
exec '${realGit}' "$@"
`);
sh(path.join(T, 'guard.sh'), '#!/bin/sh\necho "=== 9 passed in 0.1s ==="\nexit 0\n');
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
const tr = (extra, ...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env: Object.assign({}, env, extra), timeout: 180000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const result = (task, head) => readJ(path.join(TD, 'result', `${task}-${head}.json`));
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json'));
const enq = (task, br) => tr({}, 'enqueue', '--task', task, '--branch', br, '--head', rev(br), '--base', 'arc');
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

function main_() {
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  put(path.join(main, 'data', 'corpus.txt'), 'the corpus');

  // ---- R1: the result arrives between the waiter's two reads ----
  const a = branch('a', 'f-a.txt', 'a\n');
  enq('a', 'a');
  const entry = path.join(TD, 'queue', queue()[0]);
  const resF = path.join(TD, 'result', `a-${a}.json`);
  const hook = path.join(T, 'hook.js');
  // the first miss of this entry's result file: "another dispatcher" finishes the entry exactly as finish() does
  fs.writeFileSync(hook, `'use strict';
const fs = require('fs');
const orig = fs.readFileSync; let fired = false;
fs.readFileSync = function (f, ...rest) {
  try { return orig.call(fs, f, ...rest); } catch (e) {
    if (!fired && String(f) === ${JSON.stringify(resF)}) {
      fired = true;
      fs.mkdirSync(require("path").dirname(${JSON.stringify(resF)}), { recursive: true });
      fs.writeFileSync(${JSON.stringify(resF)}, JSON.stringify({ verdict: 'green', task: 'a', head: ${JSON.stringify(a)}, train: 'other' }));
      fs.rmSync(${JSON.stringify(entry)}, { force: true });
    }
    throw e;
  }
};
`);
  let r = tr({ NODE_OPTIONS: `--require ${hook}` }, 'await', '--task', 'a', '--head', a);
  let o = last(r);
  ok('R1 the result written and the entry removed between the waiter\'s reads -> await prints that result, exit 0 (not 66)',
    r.status === 0 && o && o.verdict === 'green' && o.train === 'other', `exit ${r.status} ${r.stdout}${r.stderr}`);

  // ---- R2: the dead train's worktree is removed under the breaker's own lock ----
  const b = branch('b', 'f-b.txt', 'b\n');
  enq('b', 'b');
  const deadWt = path.join(wts, 'train-dead');
  git(main, 'worktree', 'add', '-q', '--detach', deadWt, 'arc');
  const dp = deadPid();
  fs.mkdirSync(LOCK, { recursive: true });
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: dp, child: dp, train: 'dead', wt: deadWt, since: new Date().toISOString() }));
  r = tr({}, 'run'); o = last(r);
  const seen = (read(path.join(T, 'rm-seen.txt')) || '').trim().split('\n');
  const own = (() => { try { return JSON.parse(seen[0].slice(6)); } catch { return null; } })();
  ok('R2 the dead lock is broken and b rides green', o && o.departed && o.verdict === 'green' && result('b', b), r.stdout + r.stderr);
  ok('R2 the dead train\'s worktree is removed', !fs.existsSync(deadWt) && !git(main, 'worktree', 'list').stdout.includes('train-dead'), git(main, 'worktree', 'list').stdout);
  ok('R2 while it was removed the lock was the breaker\'s own (a live pid, not the dead holder) and lock.break was gone',
    own && own.pid !== dp && Number.isInteger(own.pid) && seen[1] === 'break=no', seen.join(' | '));
  ok('R2 nothing of the dead lock is left (no lock, lock.break or lock.dead-*)', !ls(TD).some((n) => n === 'lock' || n.startsWith('lock.')), ls(TD).join());

  // ---- R3: lock.break names its pid ----
  const c = branch('c', 'f-c.txt', 'c\n');
  enq('c', 'c');
  const dp2 = deadPid();
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: dp2, child: dp2, train: 'dead2', since: new Date().toISOString() }));
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.mkdirSync(BRK);
  fs.writeFileSync(path.join(BRK, 'owner.json'), JSON.stringify({ pid: holder.pid, since: new Date().toISOString() }));
  past(BRK); past(path.join(BRK, 'owner.json'));
  r = tr({}, 'run'); o = last(r);
  ok('R3 a live breaker\'s lock.break older than 60 s is kept: busy, the lock stays, c waits',
    o && o.departed === false && o.busy && fs.existsSync(BRK) && fs.existsSync(LOCK) && !result('c', c), `${r.stdout}${r.stderr} ${ls(TD).join()}`);
  holder.kill('SIGKILL');
  spawnSync('sh', ['-c', `while kill -0 ${holder.pid} 2>/dev/null; do sleep 0.1; done`], { timeout: 10000 });
  fs.writeFileSync(path.join(BRK, 'owner.json'), JSON.stringify({ pid: dp2, since: new Date().toISOString() }));
  r = tr({}, 'run'); o = last(r);
  if (o && o.busy) { r = tr({}, 'run'); o = last(r); }
  ok('R3 a dead breaker\'s lock.break is removed, the dead lock broken, c rides green',
    o && o.departed && o.verdict === 'green' && result('c', c) && !ls(TD).some((n) => n === 'lock' || n.startsWith('lock.')), `${r.stdout}${r.stderr} ${ls(TD).join()}`);
}

try { main_(); } catch (e) { ok('no exception', false, e && e.stack); }
try { spawnSync('git', ['-C', main, 'worktree', 'prune']); } catch { /* best effort */ }
fs.rmSync(T, { recursive: true, force: true });
done();
