'use strict';
// The tester cells of the runner's sweep of run copies (p-runner-cleanup), beyond tests/runner-cleanup.test.js, which
// runs this file as a child with its own tally, so README keeps counting test files:
//   TC1  a start of E finishes between the scan and runs/E.lock (run.json of another id): E is skipped, its copy stays;
//   TC2  an orphan gets its run.json during the sweep (a start of that name): skipped, its copy stays;
//   TC3  runs/ is a link: the sweep stops with an error and removes nothing, preflight still answers, the line says so;
//   TC4  the bundle the Mac sends (guards-remote.js BUNDLE, run with `node -` as ssh runs it): the same sweep;
//   TC5  a wt/ entry that is a plain file is removed; a *.lock entry is left alone and named;
//   TC6  a copy whose git worktree record is gone (git worktree remove fails, not locked) is removed by rmSync;
//   TC7  the number kept is the owner's 3 (2026-11-10), and the line names it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const H = require('../scripts/guards-remote-host');
const CR = require('../scripts/corpus-remote');
const GR = require('../scripts/guards-remote');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-tc-')));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const until = (f, s) => { const t = Date.now() + s * 1000; while (Date.now() < t) { if (f()) return true; sleep(0.1); } return f(); };
const VERSION = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
const kids = [];

const plugin = path.join(T, 'plugin');
fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'codis-agents', version: VERSION }));
fs.writeFileSync(path.join(plugin, 'scripts', 'env-check.js'), 'process.stdout.write(JSON.stringify({ ok: true, problems: [] }));\n');
const src = path.join(T, 'src');
fs.mkdirSync(src);
git('-C', src, 'init', '-q'); fs.writeFileSync(path.join(src, 'f.txt'), 'f\n'); git('-C', src, 'add', 'f.txt'); git('-C', src, 'commit', '-q', '-m', 'f');
const SHA = git('-C', src, 'rev-parse', 'HEAD').stdout.trim();

function fixture(name) {
  const root = path.join(T, name);
  fs.mkdirSync(root, { recursive: true });
  const R = H.layout({ root });
  git('clone', '--bare', '-q', src, R.repo);
  fs.mkdirSync(path.join(R.donor, 'pkg'), { recursive: true }); fs.writeFileSync(path.join(R.donor, 'pkg', 'd.json'), '{}\n');
  fs.mkdirSync(path.join(R.deps, 'h1'), { recursive: true }); fs.writeFileSync(path.join(R.deps, 'h1.ok'), '{}\n');
  fs.mkdirSync(R.runs, { recursive: true }); fs.mkdirSync(R.wt, { recursive: true });
  return R;
}
const iso = (min) => new Date(Date.UTC(2026, 10, 9, 10, min)).toISOString();
function addRun(R, name, o) {
  const dir = path.join(R.runs, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id: `${name}@x-1`, name, sha: SHA, pid: o.pid, pstart: o.pstart, startedAt: iso(o.started) }));
  if (o.rc !== undefined) fs.writeFileSync(path.join(dir, 'rc'), JSON.stringify({ rc: 0, at: iso(o.rc) }));
  const wt = path.join(R.wt, name);
  if (o.worktree) { const a = git('--git-dir', R.repo, 'worktree', 'add', '-q', '--detach', wt, SHA); if (a.status !== 0) throw new Error(a.stderr); } else { fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'w.txt'), name); }
  return wt;
}
const pf = (R) => H.OPS.preflight(R, { plugin, version: VERSION });
const wtNames = (R) => { try { return fs.readdirSync(R.wt).sort(); } catch { return null; } };
const four = (R, dead) => ['a', 'b', 'c', 'd'].forEach((n, i) => addRun(R, n, { started: i, rc: i + 1, pid: dead, pstart: 'x', worktree: true }));
// fs.openSync is the one fs of every module: hook(file) runs once when the sweep opens a lock whose path ends with tail.
function onOpen(tail, hook) {
  const orig = fs.openSync;
  let fired = false;
  fs.openSync = function (file, ...rest) {
    if (!fired && String(file).endsWith(tail)) { fired = true; hook(); }
    return orig.call(this, file, ...rest);
  };
  return () => { fs.openSync = orig; return fired; };
}

try {
  if (!has('perl')) { skip('the sweep (tester cells)', 'perl not found (the locks of the runner need it)'); throw null; }
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' }); kids.push(sleeper);
  until(() => H.pstart(sleeper.pid) !== null, 5);

  // TC1: a start of a finished a writes a new run.json between the scan and the lock
  const R1 = fixture('tc1'); four(R1, deadPid);
  let off = onOpen(path.join('runs', 'a.lock'), () => {
    fs.writeFileSync(path.join(R1.runs, 'a', 'run.json'), JSON.stringify({ id: 'a@y-2', name: 'a', sha: SHA, pid: deadPid, pstart: 'x', startedAt: iso(30) }));
  });
  let o = pf(R1);
  const fired1 = off();
  ok('TC1: a start of E between the scan and runs/E.lock (run.json of another id) - E skipped, its copy stays, nothing else removed',
    fired1 && wtNames(R1).includes('a') && fs.existsSync(path.join(R1.wt, 'a', 'f.txt')) && o.sweep.removed.length === 0
      && o.sweep.skipped.some((x) => x.name === 'a' && /started again/.test(x.why)), JSON.stringify(o.sweep));

  // TC2: an orphan gets its run.json during the sweep
  const R2 = fixture('tc2');
  fs.mkdirSync(path.join(R2.wt, 'orph')); fs.writeFileSync(path.join(R2.wt, 'orph', 'x'), 'x');
  off = onOpen(path.join('runs', 'orph.lock'), () => {
    fs.mkdirSync(path.join(R2.runs, 'orph'), { recursive: true });
    fs.writeFileSync(path.join(R2.runs, 'orph', 'run.json'), JSON.stringify({ id: 'orph@y-1', name: 'orph', sha: SHA, pid: sleeper.pid, pstart: H.pstart(sleeper.pid), startedAt: iso(40) }));
  });
  o = pf(R2);
  const fired2 = off();
  ok('TC2: an orphan that got run.json from a start during the sweep - skipped, its copy stays', fired2 && read(path.join(R2.wt, 'orph', 'x')) === 'x'
    && o.sweep.skipped.some((x) => x.name === 'orph') && !o.sweep.removed.includes('orph'), JSON.stringify(o.sweep));

  // TC3: runs/ is a link - the sweep stops, removes nothing, preflight answers with env-check; the line says it stopped
  const R3 = fixture('tc3'); four(R3, deadPid);
  const away = path.join(T, 'runs-away'); fs.renameSync(R3.runs, away); fs.symlinkSync(away, R3.runs, 'dir');
  let threw = null;
  try { o = pf(R3); } catch (e) { threw = e; }
  const line3 = threw ? '' : GR.sweepLine(o.sweep) || '';
  ok('TC3: runs/ a link - nothing removed, the sweep answers its error, preflight still runs env-check',
    !threw && JSON.stringify(wtNames(R3)) === JSON.stringify(['a', 'b', 'c', 'd']) && /not a directory/.test(o.sweep.error || '') && o.envCheck && o.envCheck.ok, threw ? threw.message : JSON.stringify(o));
  ok('TC3: the line says the sweep stopped and why', /the sweep stopped: .*not a directory/.test(line3), line3);
  ok('TC3: the link target (runs of the runner) untouched', fs.existsSync(path.join(away, 'a', 'run.json')) && fs.lstatSync(R3.runs).isSymbolicLink());

  // TC4: the bundle as the runner runs it (node - with the script on stdin, in another directory)
  const R4 = fixture('tc4'); four(R4, deadPid);
  addRun(R4, 'live', { started: 0, pid: sleeper.pid, pstart: H.pstart(sleeper.pid), worktree: true });
  fs.mkdirSync(path.join(R4.wt, 'copy1')); fs.writeFileSync(path.join(R4.wt, 'copy1', 'y'), 'y');
  const script = `${GR.BUNDLE}\n;module.exports.cli("preflight", ${JSON.stringify({ root: R4.root, plugin, version: VERSION })});\n`;
  const b = spawnSync(process.execPath, ['-'], { input: script, encoding: 'utf8', cwd: os.tmpdir() });
  const lineB = (b.stdout || '').split('\n').filter((l) => l.startsWith('REMOTE-RESULT ')).pop();
  let rb = null; try { rb = JSON.parse(lineB.slice('REMOTE-RESULT '.length)); } catch { /* below */ }
  ok('TC4: the bundle sent over ssh sweeps too: the oldest finished and the orphan removed, 3 finished and the live run stay',
    b.status === 0 && rb && rb.sweep && JSON.stringify(rb.sweep.removed.slice().sort()) === JSON.stringify(['a', 'copy1'])
      && JSON.stringify(wtNames(R4)) === JSON.stringify(['b', 'c', 'd', 'live']) && rb.sweep.live.includes('live') && rb.envCheck && rb.envCheck.ok, `${b.status} ${b.stderr} ${lineB}`);
  ok('TC4: git worktree list of the runner no longer names the removed copy, still the live one', (() => {
    const l = git('--git-dir', R4.repo, 'worktree', 'list', '--porcelain').stdout;
    return !l.includes(path.join(R4.wt, 'a') + '\n') && l.includes(path.join(R4.wt, 'live') + '\n');
  })());
  ok('TC4: the donor and the dependency cache of the runner untouched', read(path.join(R4.donor, 'pkg', 'd.json')) === '{}\n' && fs.existsSync(path.join(R4.deps, 'h1')) && read(path.join(R4.deps, 'h1.ok')) === '{}\n');

  // TC5: a plain file in wt/ is an orphan (removed); a *.lock entry is not a run name (left, named)
  const R5 = fixture('tc5');
  fs.writeFileSync(path.join(R5.wt, 'stray'), 's');
  fs.mkdirSync(path.join(R5.wt, 'x.lock')); fs.writeFileSync(path.join(R5.wt, 'x.lock', 'k'), 'k');
  o = pf(R5);
  ok('TC5: a plain file under wt/ removed as an orphan', !fs.existsSync(path.join(R5.wt, 'stray')) && o.sweep.removed.includes('stray'), JSON.stringify(o.sweep));
  ok('TC5: a *.lock entry under wt/ left alone and named', read(path.join(R5.wt, 'x.lock', 'k')) === 'k' && o.sweep.skipped.some((x) => x.name === 'x.lock'), JSON.stringify(o.sweep));

  // TC6: the worktree record of a finished copy is gone (repo.git/worktrees/<n> removed): git refuses, rmSync removes it
  const R6 = fixture('tc6'); four(R6, deadPid);
  const rec = fs.readdirSync(path.join(R6.repo, 'worktrees')).find((n) => read(path.join(R6.repo, 'worktrees', n, 'gitdir')).trim() === path.join(R6.wt, 'a', '.git'));
  fs.rmSync(path.join(R6.repo, 'worktrees', rec), { recursive: true });
  o = pf(R6);
  ok('TC6: a copy whose git worktree record is gone - removed all the same', !fs.existsSync(path.join(R6.wt, 'a')) && o.sweep.removed.includes('a')
    && JSON.stringify(wtNames(R6)) === JSON.stringify(['b', 'c', 'd']), JSON.stringify(o.sweep));

  // TC7: the owner's number (2026-11-10: keep the 3 newest finished)
  ok('TC7: KEEP_RUNS is 3 and the line names it', H.KEEP_RUNS === 3 && /kept the 3 newest finished: b, c, d|kept the 3 newest finished: [bcd], [bcd], [bcd]/.test(GR.sweepLine(o.sweep) || ''), GR.sweepLine(o.sweep));
} catch (e) {
  if (e !== null) ok('no exception', false, e && e.stack);
}
for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
try { spawnSync('chmod', ['-R', 'u+w', T]); fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
done();
