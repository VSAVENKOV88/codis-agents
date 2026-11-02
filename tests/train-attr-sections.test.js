#!/usr/bin/env node
'use strict';
// p-train-attr: a red train is attributed by the repeated new reds of every rerun section of its log, not only the last.
// A full run on the remote runner (scripts/guards-remote.js) leaves two rerun sections in one log: the runner's
// ("new red, red again alone: X") and, after "==== on this machine: ...", the one of the part here (only "flaky ... Y").
// guards-result.js repeatedInLog / flakyInLog read only the last section, so train.js saw no repeated red and stopped
// the train for the coordinator (train 20261102-133002999-28977) instead of giving the passenger its red.
//   S1 repeatedInLog of a two-section log -> [X] (the runner's), once, though the shape repeats it;
//   S2 flakyInLog -> the flaky guards of both sections (the runner's Z and the part here's Y);
//   S3 a guard's own output (before the first header, and between the sections after a "==== " line) never counts;
//   S4 a train with one passenger and such a log -> verdict red for the passenger (not coordinator), and the
//      attribution, whose selection log has two sections too, finds X red on "arc + x" (not "could not run").
// train.js runs guards-all.sh of its own scripts directory, so S4 runs a copy of the plugin's scripts with a fake
// guards-all.sh that writes the logs of that shape (a real remote runner is not needed to read a log).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-attr-sec-')));
const HEAD = '==== rerun of new reds one by one (guardRerun) ====';
const TALLY = (f, p) => `=== ${f} failed, ${p} passed, ${f + p} total in 0.1s ===`;

// The log of a full run on the remote runner with its part here, the shape of guards-remote.js (names are made up).
const twoSections = (red, flakyRunner, flakyHere) => [
  'ran on runner 192.0.2.1, HEAD 0000000000000000000000000000000000000000, workers 4 (run t@0-1, plugin 0.4.18)',
  'Guards to run: 3',
  `new red, red again alone: g-before (exit 1)`, // a guard's own output before the first header
  `FAILED ${red} - red`,
  `FAILED ${flakyRunner} - red`,
  'PASSED g-ok',
  TALLY(2, 1),
  '',
  HEAD,
  `new red, red again alone: ${red} (exit 1)`,
  `flaky, red under load, green alone: ${flakyRunner}`,
  'rerun: 2 new reds -> 1 repeated, 1 flaky; exit 1',
  `flaky guards (not a regression; put them into the project backlog): ${flakyRunner}`,
  'quarantine read-only on this run (the remote runner): the machine that started the run writes it',
  'single runs: /srv/runs/t/guards-t.rerun.txt',
  '',
  `==== on this machine: guards the runner does not run (remoteRun.localPattern): ${flakyHere} ====`,
  'new red, red again alone: g-between (exit 1)', // the part here's guard output, between the sections
  'flaky, red under load, green alone: g-between-flaky',
  `FAILED ${flakyHere} - red`,
  TALLY(1, 0),
  '',
  HEAD,
  `flaky, red under load, green alone: ${flakyHere}`,
  'rerun: 1 new reds -> 0 repeated, 1 flaky; exit 0',
  `flaky guards (not a regression; put them into the project backlog): ${flakyHere}`,
  'single runs: /srv/runs/t/guards-t.local.rerun.txt',
  '',
  "part here: exit 0; the run's exit 1 (the worse of the runner's 1 and this part's 0)",
].join('\n') + '\n';

// ---- S1-S3: the parsers ----
const L = twoSections('g-x', 'g-z', 'g-y');
ok('S1 repeatedInLog of a two-section log names the runner\'s repeated red', JSON.stringify(G.repeatedInLog(L)) === '["g-x"]', JSON.stringify(G.repeatedInLog(L)));
ok('S1 the same section twice (a log quoted in a log) -> the name once', JSON.stringify(G.repeatedInLog(L + L)) === '["g-x"]', JSON.stringify(G.repeatedInLog(L + L)));
const F = G.flakyInLog(L);
ok('S2 flakyInLog names the flaky guards of both sections', F.includes('g-z') && F.includes('g-y') && F.length === 2, JSON.stringify(F));
ok('S3 a guard\'s output before the first header and between the sections never counts',
  !G.repeatedInLog(L).some((n) => /before|between/.test(n)) && !F.some((n) => /before|between/.test(n)), JSON.stringify([G.repeatedInLog(L), F]));
ok('S3 no header -> nothing', !G.repeatedInLog('new red, red again alone: g (exit 1)\n').length && !G.flakyInLog('flaky, red under load, green alone: g\n').length);
ok('S3 a section ends at the next "==== " line even without an empty line before it',
  JSON.stringify(G.repeatedInLog(`${HEAD}\nnew red, red again alone: a (exit 1)\n==== on this machine: b ====\nnew red, red again alone: b (exit 1)\n`)) === '["a"]');
ok('S3 a one-section log as before', JSON.stringify(G.repeatedInLog(`x\n\n${HEAD}\nnew red, red again alone: a (exit 1)\nnew red, red again alone: b (exit 2)\nflaky, red under load, green alone: c\n`)) === '["a","b"]');

// ---- S4: the train ----
async function trainCase() {
  const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin'), plug = path.join(T, 'plugin');
  const TD = path.join(shared, 'train'), FX = path.join(T, 'fx');
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  const rev = (ref) => git(main, 'rev-parse', '--verify', '-q', ref).stdout.trim();
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
  for (const d of [main, wts, shared, bin, FX]) fs.mkdirSync(d, { recursive: true });
  // the fake machine of the slots: a calm machine
  const tool = (name, body) => sh(path.join(bin, name), body);
  tool('sysctl', '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
  tool('memory_pressure', '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
  tool('vm_stat', '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
  tool('df', '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
  // a copy of the plugin's scripts; its guards-all.sh writes the logs: the full run -> two sections (exit 1); a selection
  // (--guards) on a tree with red-x.txt -> two sections, g-x red again alone in the runner's (exit 1), else green
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(plug, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(plug, 'package.json'));
  put(path.join(FX, 'full.txt'), twoSections('g-x', 'g-z', 'g-y'));
  put(path.join(FX, 'select-red.txt'), twoSections('g-x', 'g-z2', 'g-y2'));
  put(path.join(FX, 'select-green.txt'), `Guards to run: 1\nPASSED g-x\n${TALLY(0, 1)}\n`);
  sh(path.join(plug, 'scripts', 'guards-all.sh'), `#!/bin/zsh
sel=0
while (( $# > 1 )); do [[ $1 == --guards ]] && { sel=1; shift; }; shift; done
wt=$1; name=\${wt:t}
print -r -- "$sel $(git -C $wt rev-parse HEAD)" >> '${T}/calls.txt'
if (( sel )); then
  if [[ -f $wt/red-x.txt ]]; then cp '${FX}/select-red.txt' '${shared}'/guards-$name.select.txt; exit 1; fi
  cp '${FX}/select-green.txt' '${shared}'/guards-$name.select.txt; exit 0
fi
cp '${FX}/full.txt' '${shared}'/guards-$name.txt
print -r -- "fake full run of $name"
exit 1
`);
  const cfgFile = path.join(T, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
    guardCommand: 'cd {wt} && ./guard.sh',
    guardSubsetCommand: 'cd {wt} && ./guard.sh --subset {onlyArgs}',
    guardRerun: { command: 'cd {wt} && ./guard.sh --only {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .*?(\\d+) total in [0-9.]+s ===$' },
    guardBaseline: 'known.json',
    worktreeSetup: { scan: ['data'], skip: [], link: [] },
    slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
    SLOT_POLL: '0.2', SLOT_SAY: '1', CODIS_TRAIN_POLL: '0.3' });
  // the fake guards-all.sh takes no slot; the knobs of slots.zsh are neutralised all the same (tests/slots-hermetic.test.js)
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CLAUDE_PROJECT_DIR']) delete env[k];
  const tr = (...a) => spawnSync(process.execPath, [path.join(plug, 'scripts', 'train.js'), ...a], { cwd: T, encoding: 'utf8', env, timeout: 300000 });

  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  const arc = rev('arc');
  git(main, 'branch', 'x', 'arc');
  const mk = path.join(T, 'mk-x');
  git(main, 'worktree', 'add', '-q', mk, 'x');
  put(path.join(mk, 'red-x.txt'), 'x\n'); git(mk, 'add', 'red-x.txt'); git(mk, 'commit', '-q', '-m', 'x');
  git(main, 'worktree', 'remove', '--force', mk);
  const x = rev('x');
  const dir = path.join(T, 'tasks', 'x'); fs.mkdirSync(dir, { recursive: true });
  let r = tr('enqueue', '--task', 'x', '--branch', 'x', '--head', x, '--base', 'arc', '--dir', dir);
  ok('S4 the passenger is enqueued', r.status === 0, r.stdout + r.stderr);
  r = tr('run');
  let o = null; try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* checked below */ }
  const rx = readJ(path.join(TD, 'result', `x-${x}.json`)), h = readJ(path.join(TD, 'halt'));
  ok('S4 a train of one passenger with a two-section log -> red for the passenger, not the coordinator',
    rx && rx.verdict === 'red' && JSON.stringify(rx.guards) === '["g-x"]' && o && o.verdict === 'red' && !h, `${r.stdout}${r.stderr} ${JSON.stringify(rx)} ${JSON.stringify(h)}`);
  const calls = (read(path.join(T, 'calls.txt')) || '').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  const sel = calls.filter((c) => c[0] === '1');
  ok('S4 the attribution ran its selection on the bare arc head and on arc + x', sel.length === 2 && sel.some((c) => c[1] === arc) && sel.some((c) => c[1] !== arc), JSON.stringify(calls));
  ok('S4 the attribution log names g-x red on arc + x', rx && /g-x/.test(read(rx.attribution) || '') && /x: red/.test(read(rx.attribution) || ''), rx && read(rx.attribution));
  spawnSync('git', ['-C', main, 'worktree', 'prune']);
}

(has('zsh') ? trainCase() : Promise.resolve(skip('S4 the train (runs zsh scripts)', 'zsh not found')))
  .catch((e) => ok('no exception', false, e && e.stack))
  .finally(() => { fs.rmSync(T, { recursive: true, force: true }); done(); });
