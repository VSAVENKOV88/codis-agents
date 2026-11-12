'use strict';
// The runner's sweep of run copies (scripts/guards-remote-host.js, preflight; cells R1-R30 of the p-runner-cleanup
// analysis): every remote run passes preflight, and after the version check and before the runner's env-check it
// removes the run copies under <root>/wt that nobody needs - all but the 3 newest finished runs (by runs/<name>/rc at,
// else run.json startedAt; never by the directory's mtime), never a live run (pid and its start time), orphans without
// runs/<name>/run.json always. A removal never follows a link and never touches the donor, deps, repo.git (but its
// worktree records), runs/ or anything else under the root. The Mac prints one line of it (guards-remote.js sweepLine).
// A fake runner: a temporary root, a fake plugin whose env-check.js records what wt/ held when it ran; no ssh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const H = require('../scripts/guards-remote-host');
const CR = require('../scripts/corpus-remote');
const GR = require('../scripts/guards-remote');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-')));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const until = (f, s) => { const t = Date.now() + s * 1000; while (Date.now() < t) { if (f()) return true; sleep(0.1); } return f(); };
const VERSION = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
const kids = [];

// Every entry under dir, not following links: path, type, mode, size, content hash, link target.
function snap(dir, skipRel) {
  const out = [];
  if (!fs.existsSync(dir)) return 'missing';
  (function w(rel) {
    for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (skipRel && skipRel(r)) continue;
      const p = path.join(dir, r), st = fs.lstatSync(p);
      out.push([r, st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f', st.mode & 0o7777, st.isFile() ? st.size : 0,
        st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '', st.isSymbolicLink() ? fs.readlinkSync(p) : '']);
      if (st.isDirectory()) w(r);
    }
  })('');
  return JSON.stringify(out);
}
const chmodTree = (dir) => spawnSync('chmod', ['-R', 'u+w', dir]);
const nouchg = (dir) => { if (process.platform === 'darwin') spawnSync('chflags', ['-R', 'nouchg', dir]); };

// A fake plugin of this version: env-check.js answers ok and records the names in <root>/wt when it ran.
const plugin = path.join(T, 'plugin');
fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'codis-agents', version: VERSION }));
fs.writeFileSync(path.join(plugin, 'scripts', 'env-check.js'), `const fs = require('fs'), path = require('path');
const root = process.argv[process.argv.indexOf('--path') + 1];
let seen = null; try { seen = fs.readdirSync(path.join(root, 'wt')).sort(); } catch { /* none */ }
process.stdout.write(JSON.stringify({ ok: true, problems: [], seen }));\n`);

const src = path.join(T, 'src');
fs.mkdirSync(src);
git('-C', src, 'init', '-q'); fs.writeFileSync(path.join(src, 'f.txt'), 'f\n'); git('-C', src, 'add', 'f.txt'); git('-C', src, 'commit', '-q', '-m', 'f');
const SHA = git('-C', src, 'rev-parse', 'HEAD').stdout.trim();

// A runner root: repo.git with the commit, a complete donor, a dependency cache, slots, a manual clone, runs/ and wt/.
function fixture(name) {
  const root = path.join(T, name);
  fs.mkdirSync(root, { recursive: true });
  const R = H.layout({ root });
  git('clone', '--bare', '-q', src, R.repo);
  git('--git-dir', R.repo, 'update-ref', `refs/runs/keep/${SHA}`, SHA);
  CR.OPS.begin(R, { id: 'x' });
  fs.mkdirSync(path.join(R.donor, 'pkg', 'data'), { recursive: true }); fs.writeFileSync(path.join(R.donor, 'pkg', 'data', 'big.json'), '{"corpus":1}\n');
  CR.OPS.finish(R, { expectId: CR.OPS.scan(R).id });
  fs.mkdirSync(path.join(R.deps, 'h1', 'node_modules', 'x'), { recursive: true }); fs.writeFileSync(path.join(R.deps, 'h1', 'node_modules', 'x', 'i.js'), 'x\n');
  fs.writeFileSync(path.join(R.deps, 'h1.ok'), '{"v":1}\n'); fs.writeFileSync(path.join(R.deps, 'h1.lock'), '');
  fs.mkdirSync(path.join(root, 'slots')); fs.writeFileSync(path.join(root, 'slots', 'journal.tsv'), 'j\n');
  fs.mkdirSync(path.join(root, 'manual-clone')); fs.writeFileSync(path.join(root, 'manual-clone', 'm.txt'), 'm\n');
  fs.mkdirSync(R.runs, { recursive: true }); fs.mkdirSync(R.wt, { recursive: true });
  return R;
}
const iso = (min) => new Date(Date.UTC(2026, 10, 9, 10, min)).toISOString();
// A run of name: runs/<name>/run.json (and rc when at is given), runs/<name>.lock, wt/<name> (a git worktree or a dir).
function addRun(R, name, o) {
  const dir = path.join(R.runs, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}.lock`, '');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id: `${name}@x-1`, name, sha: SHA, pid: o.pid, pstart: o.pstart, startedAt: iso(o.started) }));
  if (o.rc !== undefined) fs.writeFileSync(path.join(dir, 'rc'), JSON.stringify({ rc: 0, at: iso(o.rc) }));
  fs.writeFileSync(path.join(dir, `guards-${name}.txt`), `log of ${name}\n`);
  fs.writeFileSync(path.join(dir, 'out.txt'), 'workers: 2\n');
  const wt = path.join(R.wt, name);
  if (o.worktree) { const a = git('--git-dir', R.repo, 'worktree', 'add', '-q', '--detach', wt, SHA); if (a.status !== 0) throw new Error(a.stderr); } else { fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'w.txt'), name); }
  return wt;
}
const worktrees = (R) => git('--git-dir', R.repo, 'worktree', 'list', '--porcelain').stdout;
const pf = (R, extra) => H.OPS.preflight(R, Object.assign({ plugin, version: VERSION }, extra || {}));
const wtNames = (R) => { try { return fs.readdirSync(R.wt).sort(); } catch { return null; } };

try {
  if (!has('perl')) { skip('the sweep', 'perl not found (the locks of the runner need it)'); throw null; }
  // a dead pid: a child that has exited; a live one: a sleeping child (its start time is what ps prints)
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' }); kids.push(sleeper);
  until(() => H.pstart(sleeper.pid) !== null, 5);
  const livePid = sleeper.pid, livePstart = H.pstart(livePid);

  // ---- the main scene: 8 finished runs, a live one, orphans, a foreign name ----
  const R = fixture('main');
  const canary = path.join(T, 'canary'); fs.mkdirSync(canary); fs.writeFileSync(path.join(canary, 'c.txt'), 'canary\n');
  addRun(R, 'live', { started: 0, pid: livePid, pstart: livePstart, worktree: true });                    // R7: oldest, alive
  addRun(R, 'half', { started: 1, pid: deadPid, pstart: 'x' });                                           // R24, R11: no rc, dead
  fs.rmSync(path.join(R.wt, 'half', 'w.txt'));
  addRun(R, 'r8', { started: 2, pid: livePid, pstart: 'Thu Jan  1 00:00:00 1970' });                     // R8: pid reused
  const tWt = addRun(R, 't', { started: 3, rc: 10, pid: deadPid, pstart: 'x', worktree: true });          // R1: oldest finished by rc
  addRun(R, 't-select', { started: 4, rc: 11, pid: deadPid, pstart: 'x', worktree: true });               // R4, R9
  const lockedWt = addRun(R, 'train-1-lbl-select', { started: 5, rc: 12, pid: deadPid, pstart: 'x', worktree: true }); // R5, R20
  addRun(R, 'train-2', { started: 6, rc: 13, pid: deadPid, pstart: 'x', worktree: true });
  addRun(R, 'train-3', { started: 7, rc: 14, pid: deadPid, pstart: 'x', worktree: true });
  addRun(R, 'zw-12345', { started: 20, pid: deadPid, pstart: 'x' });                                      // R6, R11: newest by startedAt
  // R15-R17 inside t: a link into the dependency cache, a link out of the root, a read-only directory
  fs.symlinkSync(path.join(R.deps, 'h1', 'node_modules'), path.join(tWt, 'node_modules'), 'dir');
  fs.symlinkSync(canary, path.join(tWt, 'out'), 'dir');
  fs.symlinkSync(R.donor, path.join(tWt, 'donor-link'), 'dir');
  fs.mkdirSync(path.join(tWt, 'ro', 'deep'), { recursive: true }); fs.writeFileSync(path.join(tWt, 'ro', 'deep', 'f'), 'f');
  fs.chmodSync(path.join(tWt, 'ro', 'deep'), 0o555); fs.chmodSync(path.join(tWt, 'ro'), 0o555);
  // R2: the mtimes say the opposite of rc at (cp -a of the donor carries the donor's mtime onto a copy)
  ['t', 't-select', 'train-1-lbl-select', 'train-2', 'train-3'].forEach((n, i) => fs.utimesSync(path.join(R.wt, n), new Date(2026, 9, 25 - i), new Date(2026, 9, 25 - i)));
  // R10: an orphan copy (corpus-sync copy, an old version) and R14: an orphan that is a link to a directory
  fs.mkdirSync(path.join(R.wt, 'copy1', 'pkg'), { recursive: true }); fs.writeFileSync(path.join(R.wt, 'copy1', 'pkg', 'x'), 'x');
  fs.symlinkSync(canary, path.join(R.wt, 'linkE'), 'dir');
  // H14 (p-codex-A2b-2h-1, F-g): an orphan copy whose .git a guard rewrote into a gitdir of its own with core.fsmonitor
  // and core.hooksPath, and a link out of the root: removed without git (its .git is no worktree file), nothing of its
  // config runs, the link is not followed
  const fgc = path.join(R.wt, 'fgc'), fgMark = path.join(T, 'fgc.FSMON');
  fs.mkdirSync(fgc); git('init', '-q', fgc);
  git('-C', fgc, 'config', 'core.fsmonitor', `touch '${fgMark}'; false`); git('-C', fgc, 'config', 'core.hooksPath', path.join(T, 'fgc-hooks'));
  fs.mkdirSync(path.join(T, 'fgc-hooks'));
  for (const h of ['post-checkout', 'reference-transaction', 'post-index-change']) fs.writeFileSync(path.join(T, 'fgc-hooks', h), `#!/bin/sh\ntouch '${fgMark}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fgc, 'f.txt'), 'f'); fs.symlinkSync(canary, path.join(fgc, 'out'), 'dir');
  // R13: a name a run never has
  fs.mkdirSync(path.join(R.wt, '.tmp x')); fs.writeFileSync(path.join(R.wt, '.tmp x', 'keep'), 'k');
  // R20: train-1-lbl-select is a locked git worktree (a git worktree add still running)
  git('--git-dir', R.repo, 'worktree', 'lock', '--reason', 'initializing', lockedWt);
  // R9: a start of t-select holds runs/t-select.lock
  const heldF = path.join(T, 'held');
  const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'corpus-remote.js'))}).withLock(${JSON.stringify(path.join(R.runs, 't-select.lock'))}, { timeoutS: 10 }, () => { require('fs').writeFileSync(${JSON.stringify(heldF)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); })`], { stdio: 'ignore' });
  kids.push(holder);
  until(() => fs.existsSync(heldF), 10);
  // R18 (macOS: chflags uchg, settable by the owner): a copy with a file nobody may remove
  const uchg = process.platform === 'darwin' && has('chflags');
  if (uchg) {
    fs.mkdirSync(path.join(R.wt, 'stuck')); fs.writeFileSync(path.join(R.wt, 'stuck', 'pinned'), 'p');
    spawnSync('chflags', ['uchg', path.join(R.wt, 'stuck', 'pinned')]);
  }
  const runsBefore = new Set(fs.readdirSync(R.runs));
  const keepRoot = (r) => r === 'wt' || r === 'wt.sweep.lock' || r.startsWith('wt/') || r === 'repo.git/worktrees' || r.startsWith('repo.git/worktrees/') || r === 'runs' || r.startsWith('runs/');
  const before = { root: snap(R.root, keepRoot), runs: snap(R.runs), canary: snap(canary) };
  const wl = CR.OPS['wipe-list'](R);
  const t0 = Date.now();
  const out = pf(R);
  const took = Date.now() - t0;
  const s = out.sweep || {};
  const left = wtNames(R);
  ok('preflight answers with the version and the sweep result', out.version === VERSION && !!out.sweep && Array.isArray(s.removed), JSON.stringify(out));
  ok('R1, R2: the 3 newest finished runs stay (by rc at, else startedAt), not by the directory mtime', ['train-2', 'train-3', 'zw-12345'].every((n) => left.includes(n))
    && JSON.stringify((s.kept || []).slice().sort()) === JSON.stringify(['train-2', 'train-3', 'zw-12345']), `${left} ${JSON.stringify(s)}`);
  ok('R1, R4, R11, R24, R8: older finished runs are removed (t, half, r8), a reused pid with another start time is dead', ['t', 'half', 'r8'].every((n) => !left.includes(n) && s.removed.includes(n)), `${left} ${JSON.stringify(s)}`);
  ok('R1: git worktree list no longer names a removed run', !worktrees(R).includes(path.join(R.wt, 't') + '\n') && worktrees(R).includes(path.join(R.wt, 'train-2')), worktrees(R));
  ok('R7: a live run older than all is kept and not counted in the 3', left.includes('live') && (s.live || []).includes('live') && !(s.kept || []).includes('live'), JSON.stringify(s));
  ok('R10: an orphan without runs/<name>/run.json is removed and not counted', !left.includes('copy1') && s.removed.includes('copy1'), JSON.stringify(s));
  ok('H14: an orphan copy with a .git directory of its own (core.fsmonitor, core.hooksPath) - removed, nothing of its config ran, its link not followed',
    !left.includes('fgc') && s.removed.includes('fgc') && !fs.existsSync(fgMark) && snap(canary) === before.canary, JSON.stringify(s));
  ok('R14: an orphan that is a link - the link removed, its target intact', !left.includes('linkE') && snap(canary) === before.canary, JSON.stringify(s));
  ok('R15, R16: links inside a removed copy are not followed (deps, donor, a directory outside stay byte for byte)', snap(canary) === before.canary && fs.existsSync(path.join(R.deps, 'h1', 'node_modules', 'x', 'i.js')));
  ok('R17: a read-only directory inside a copy is removed too', !fs.existsSync(tWt));
  ok('R13: a name a run never has is left alone and named', left.includes('.tmp x') && (s.skipped || []).some((x) => x.name === '.tmp x'), JSON.stringify(s));
  ok('R9: a run whose runs/<name>.lock is held (a start) is skipped and named, without waiting for the lock', left.includes('t-select') && (s.skipped || []).some((x) => x.name === 't-select' && /lock/.test(x.why)) && took < 8000, `${took} ms ${JSON.stringify(s)}`);
  ok('R20: a locked git worktree is skipped and named, not removed over git', left.includes('train-1-lbl-select') && fs.existsSync(path.join(lockedWt, 'f.txt')) && (s.skipped || []).some((x) => x.name === 'train-1-lbl-select' && /locked/.test(x.why)), JSON.stringify(s));
  if (uchg) {
    ok('R18: a copy that cannot be removed is named under notRemoved; the sweep and preflight go on', (s.notRemoved || []).some((x) => x.name === 'stuck') && out.envCheck && out.envCheck.ok && !left.includes('copy1'), JSON.stringify(s));
    nouchg(R.wt);
  } else skip('R18: a file that cannot be removed', 'chflags uchg is macOS only');
  ok('R19, R30: donor, corpus state and manifest, deps, repo.git (but its worktree records), refs/runs, slots, a manual clone - unchanged', snap(R.root, keepRoot) === before.root
    && git('--git-dir', R.repo, 'rev-parse', `refs/runs/keep/${SHA}`).stdout.trim() === SHA);
  const runsNew = fs.readdirSync(R.runs).filter((n) => !runsBefore.has(n));
  ok('R19: runs/ keeps every log and record; new there only empty <orphan>.lock markers', snap(R.runs, (r) => !runsBefore.has(r.split('/')[0])) === before.runs
    && runsNew.every((n) => /\.lock$/.test(n) && fs.statSync(path.join(R.runs, n)).size === 0), runsNew.join(', '));
  ok('R22, R23: the sweep runs before the runner\'s env-check (it saw wt/ already swept)', out.envCheck && Array.isArray(out.envCheck.seen) && !out.envCheck.seen.includes('t') && out.envCheck.seen.includes('train-2'), JSON.stringify(out.envCheck));
  ok('the sweep counts the bytes it freed', typeof s.bytes === 'number' && s.bytes > 0, JSON.stringify(s));
  const f = H.OPS.fetch(R, { name: 't', id: 't@x-1' });
  ok('R12: a removed copy - fetch still gives the run\'s log from runs/', f.rc === 0 && f.log === 'log of t\n', JSON.stringify(f));
  let werr = null;
  try { CR.OPS.wipe(R, { token: wl.token }); } catch (e) { werr = e; }
  ok('R25: a wipe with the token of the list before the sweep is refused (65), the donor stays', werr && werr.code === 65 && fs.existsSync(path.join(R.donor, 'pkg', 'data', 'big.json')), werr && werr.message);
  holder.kill();

  // R28: the Mac prints one line of the sweep; an old runner (no field) - no line
  const line = typeof GR.sweepLine === 'function' ? GR.sweepLine(s) : null;
  ok('R28: the line names what was swept, the bytes, kept, live, skipped and not removed', typeof line === 'string' && /^runner: swept \d+ run copies \([\d.]+ GB\)/.test(line)
    && line.includes('train-2') && line.includes('live') && line.includes('t-select') && /lock/.test(line), line);
  ok('R28: an old runner without the field - no line', typeof GR.sweepLine === 'function' && GR.sweepLine(undefined) === null);

  // R21: two sweeps at once - the second skips while wt.sweep.lock is held, nothing removed by it
  const R2 = fixture('busy');
  addRun(R2, 'a', { started: 1, rc: 1, pid: deadPid, pstart: 'x' }); fs.mkdirSync(path.join(R2.wt, 'orph'));
  const held2 = path.join(T, 'held2');
  const h2 = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'corpus-remote.js'))}).withLock(${JSON.stringify(path.join(R2.root, 'wt.sweep.lock'))}, { timeoutS: 10 }, () => { require('fs').writeFileSync(${JSON.stringify(held2)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); })`], { stdio: 'ignore' });
  kids.push(h2);
  until(() => fs.existsSync(held2), 10);
  const o2 = pf(R2);
  ok('R21: another sweep holds wt.sweep.lock - this one skips, removes nothing, preflight goes on', o2.sweep && o2.sweep.busy === true && wtNames(R2).includes('orph') && o2.envCheck && o2.envCheck.ok, JSON.stringify(o2));
  ok('R21: the line says the sweep was skipped', typeof GR.sweepLine === 'function' && /another sweep/.test(GR.sweepLine(o2.sweep) || ''), typeof GR.sweepLine === 'function' ? GR.sweepLine(o2.sweep) : '');
  h2.kill();
  // R26: another version on the runner - no sweep at all
  const o3 = pf(R2, { version: '0.0.1' });
  ok('R26: the runner\'s plugin is another version - preflight answers the version only, nothing removed', !o3.sweep && !o3.envCheck && wtNames(R2).includes('orph'), JSON.stringify(o3));
  // R27: no wt/ - nothing to do; wt/ a link - refused, its target untouched
  const R3 = fixture('nowt'); fs.rmSync(R3.wt, { recursive: true });
  const o4 = pf(R3);
  ok('R27: no wt/ - the sweep removes nothing and preflight goes on', o4.sweep && o4.sweep.removed.length === 0 && o4.envCheck && o4.envCheck.ok && !fs.existsSync(R3.wt), JSON.stringify(o4));
  const elsewhere = path.join(T, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'x'), { recursive: true }); fs.writeFileSync(path.join(elsewhere, 'x', 'k'), 'k');
  fs.symlinkSync(elsewhere, R3.wt, 'dir');
  let lerr = null;
  try { pf(R3); } catch (e) { lerr = e; }
  ok('R27: wt/ is a link - refused (69), its target untouched', lerr && lerr.code === 69 && /not a directory/.test(lerr.message) && read(path.join(elsewhere, 'x', 'k')) === 'k', lerr && lerr.message);
  // N+1 -> N with nothing else: 4 finished runs, the next preflight leaves 3
  const R4 = fixture('four');
  ['a', 'b', 'c', 'd'].forEach((n, i) => addRun(R4, n, { started: i, rc: i + 1, pid: deadPid, pstart: 'x', worktree: true }));
  const o5 = pf(R4);
  ok('brief: N+1 finished runs -> N stay (a removed)', JSON.stringify(wtNames(R4)) === JSON.stringify(['b', 'c', 'd']) && JSON.stringify(o5.sweep.removed) === JSON.stringify(['a']), JSON.stringify(o5.sweep));
  const o6 = pf(R4);
  ok('a second sweep with nothing to remove - nothing removed', o6.sweep.removed.length === 0 && JSON.stringify(wtNames(R4)) === JSON.stringify(['b', 'c', 'd']), JSON.stringify(o6.sweep));

  // The README and the layout comment say it (same commit as the behaviour).
  const readme = read(path.join(ROOT, 'README.md')), host = read(path.join(ROOT, 'scripts', 'guards-remote-host.js'));
  ok('README: guards-remote-host.js names the sweep of run copies (3 newest finished kept, live never)', /\| `scripts\/guards-remote-host\.js` \|[^\n]*sweep[^\n]*3[^\n]*live/.test(readme));
  ok('host: the layout comment no longer says only "the next run of that name replaces it"', !/the next run of that name replaces it\n/.test(host) && /sweep/.test(host.split('\nconst fs')[0]));

  // ---- the tester cells: tests/runner-cleanup-tester-cases.js, a child with its own tally, so README keeps counting test files
  const tc = spawnSync(process.execPath, [path.join(__dirname, 'runner-cleanup-tester-cases.js')], { encoding: 'utf8', timeout: 120000 });
  ok('the tester cells of the sweep (tests/runner-cleanup-tester-cases.js) pass', tc.status === 0, `${tc.status} ${tc.signal || ''}\n${(tc.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n')}${(tc.stderr || '').slice(-800)}`);
} catch (e) {
  if (e !== null) ok('no exception', false, e && e.stack);
}
for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
try { nouchg(T); chmodTree(T); } catch { /* best effort */ }
fs.rmSync(T, { recursive: true, force: true });
done();
