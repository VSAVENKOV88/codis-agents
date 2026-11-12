#!/usr/bin/env node
'use strict';
// Tester cells of p-noghost-b ("selected N - accounted for N"), next to tests/noghost-b.test.js. Its cells are the
// matrix of p-noghost/analyst.md, the programmer's round checks the unit and the local/remote paths; these add:
//   T1 (B14 end to end): a full run (no --only), a new red whose single rerun exits 0 with "TOTAL: 0 total" -> guards-all.sh
//      exit 69 with the environment line of the single rerun; with "TOTAL: 1 total" -> exit 0 (flaky, not a regression);
//   T2 (B8 end to end, the part of localPattern in guards-all.sh --select): a guard skipped by a flag is subtracted from
//      the selection (2 of 3 with 1 skipped -> ok, 1 of 3 -> 69 naming the skipped one); a skipped name that is not
//      selected subtracts nothing (3 of 3 selected with a non-selected skipped -> ok, 2 -> 69); more than selected -> ok (B10);
//   T3 (meta of a counted 69): the next --select of the same HEAD, clean tree, without --force runs again - never "reused";
//   T4 (no NaN pass): a count group that captures no digits is a red, not a silent pass;
//   T5 (count CLI): a selection file that is not a JSON array -> exit 69 with the environment line, not 0.
//   F3 (owner's variant B, 2026-10-31; tester round 2): uncountedIsRed is the only switch of the single rerun's count:
//      F3c config (a bad tallyPattern named once; explicit false needs no group), F3u unit (explicit false: 0 of 1 flaky;
//      true: no tally line -> 69; true: 1 of 1 flaky), F3e end to end (no key: the group alone, 0 of 1 -> flaky; true:
//      no tally line -> 69 with the environment line in the rerun log).
// Hermetic: every slots.zsh knob is neutralised and a fake machine stands in front of PATH (tests/slots-hermetic.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 900));

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const TALLY = '^TOTAL: (\\d+) total$';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+)  \\(', tallyPattern: TALLY, uncountedIsRed: true };
const LOCALP = '^skipped \\(needs-font\\): \\d+ — (.+)$';

function fakeBin(bin) {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
}
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
function cleanEnv() {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
}

// A worktree of the plugin's shape: base and task branches, guards g/a, g/b, g/c changed on the task branch.
// Fixture scripts: sub.sh (the selection, prints sub.log, exits sub.rc), full.sh (the full run), one.sh (the single rerun
// prints "TOTAL: <one.n> total", exit 0).
function fixture(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), w = path.join(wts, 'pt');
  for (const d of [bin, shared, w]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), s); if (mode) fs.chmodSync(path.join(w, f), mode); };
  put('full.sh', `#!/bin/sh\necho "run $*" >> "${TMP}/full.count"\ncat "${TMP}/full.log"\nexit $(cat "${TMP}/full.rc")\n`, 0o755);
  put('sub.sh', `#!/bin/sh\necho "$*" >> "${TMP}/sub.count"\ncat "${TMP}/sub.log"\nexit $(cat "${TMP}/sub.rc")\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$1" >> "${TMP}/one.count"\necho "TOTAL: $(cat "${TMP}/one.n") total"\nexit 0\n`, 0o755);
  for (const g of ['a', 'b', 'c']) put(`g/${g}-run.js`, `// ${g}\n`);
  gitC(w, 'init', '-q', '-b', 'base'); gitC(w, 'add', '.'); gitC(w, 'commit', '-q', '-m', 'base');
  gitC(w, 'checkout', '-q', '-b', 'task');
  for (const g of ['a', 'b', 'c']) put(`g/${g}-run.js`, `// ${g} changed\n`);
  gitC(w, 'add', 'g'); gitC(w, 'commit', '-q', '-m', 'change');
  const cfgFile = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: path.join(TMP, 'main'), worktreeRoot: wts, sharedDir: shared,
    guardCommand: 'cd {wt} && ./full.sh {jobs}', guardSubsetCommand: 'cd {wt} && ./sub.sh {onlyArgs}', guardRerun: RERUN, protectedBranches: ['base'],
    slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }));
  cleanEnv();
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const ga = (force, ...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', ...(force ? ['--force'] : []), ...a], { encoding: 'utf8', env, timeout: 150000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const count = (n) => (read(path.join(TMP, n)) || '').split('\n').filter(Boolean);
  const set = (f, v) => { fs.writeFileSync(path.join(TMP, f), String(v)); };
  const clear = () => { for (const c of ['sub.count', 'one.count', 'full.count']) fs.rmSync(path.join(TMP, c), { force: true }); };
  return { w, shared, ga, count, set, clear, cfgFile };
}

// T2: the selection's count with remoteRun.localPattern (the skipped guards of a flag, subtracted from the selection)
function partSkipped(TMP) {
  const f = fixture(TMP);
  // localPattern and localCommand: the part here of a remote run; no remote is configured, so the run is local
  const cfg = JSON.parse(read(f.cfgFile));
  cfg.remoteRun = { localPattern: LOCALP };
  fs.writeFileSync(f.cfgFile, JSON.stringify(cfg));
  const SEL = path.join(f.shared, 'guards-pt.select.txt');
  const run = (log, rc) => { f.clear(); f.set('sub.log', log); f.set('sub.rc', rc); return f.ga(true, '--select', 'base', 'pt'); };
  let x = run('skipped (needs-font): 1 — g/c-run.js\nTOTAL: 2 total\n', 0);
  ok('B8 e2e. 3 selected, 1 skipped by a flag (named in the selected set), "2 total" -> exit 0, no environment line', x.status === 0 && !/environment:/.test(read(SEL) || ''), `${x.status} ${read(SEL)} ${x.all.slice(-500)}`);
  x = run('skipped (needs-font): 1 — g/c-run.js\nTOTAL: 1 total\n', 0);
  ok('B5 e2e. the same with "1 total" -> exit 69, names the three guards and the one skipped by a flag',
    x.status === 69 && /accounted for 1 of 3 selected guards: g\/a-run\.js, g\/b-run\.js, g\/c-run\.js \(1 skipped by a flag: g\/c-run\.js\)/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  x = run('skipped (needs-font): 1 — g/z-run.js\nTOTAL: 3 total\n', 0);
  ok('B8 e2e. a skipped name that is not selected subtracts nothing: 3 of 3 -> exit 0', x.status === 0, `${x.status} ${read(SEL)}`);
  x = run('skipped (needs-font): 1 — g/z-run.js\nTOTAL: 2 total\n', 0);
  ok('B8 e2e. ... and 2 of 3 with the not selected one skipped -> exit 69 with no skipped listed', x.status === 69
    && /accounted for 2 of 3 selected guards: g\/a-run\.js, g\/b-run\.js, g\/c-run\.js - its exit/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  x = run('TOTAL: 5 total\n', 0);
  ok('B10 e2e. one --only matched several: 5 of 3 selected -> exit 0', x.status === 0, `${x.status} ${read(SEL)}`);
}

// F3 (owner's variant B, 2026-10-31), tester round 2: uncountedIsRed is the only switch of the single rerun's count.
// F3c (config, no zsh needed): a bad tallyPattern with uncountedIsRed true is named once; explicit false needs no group.
function partF3Config() {
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'x {wt}' };
  const errs = (o) => C.resolve(Object.assign({}, base, o)).errors.join('; ');
  let e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: true, tallyPattern: '^TOTAL: (\\d+' }) });
  ok('F3c. uncountedIsRed true with a bad tallyPattern -> "bad regular expression" once, no uncountedIsRed error', /guardRerun\.tallyPattern: bad regular expression/.test(e) && !/uncountedIsRed/.test(e), e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: false, tallyPattern: '^TOTAL: ' }) });
  ok('F3c. explicit uncountedIsRed false with a tallyPattern without a group -> no error', e === '', e);
  e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}', guardRerun: Object.assign({}, RERUN, { uncountedIsRed: false }) });
  ok('F3c. explicit uncountedIsRed false with guardSubsetCommand and the group -> no uncountedIsRed error', e === '', e);
}

// F3u (unit, zsh): the single rerun with an explicit false, and with no tally line under true
function partF3Unit(TMP) {
  const w = path.join(TMP, 'f3wt');
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, 'one.sh'), `#!/bin/sh\nif [ -n "$(cat "${TMP}/f3.n")" ]; then echo "TOTAL: $(cat "${TMP}/f3.n") total"; fi\nexit 0\n`, { mode: 0o755 });
  const log = path.join(TMP, 'guards-f3.txt');
  const cfg = (extra) => Object.assign({}, RERUN, { command: 'cd {wt} && ./one.sh {name}' }, extra);
  const run = (n, extra) => { fs.writeFileSync(path.join(TMP, 'f3.n'), n); fs.writeFileSync(log, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 1 total\n'); return G.rerun({ wt: w, log, rc: 1, cfg: cfg(extra), baseline: '', quarantine: '', readOnly: false, selected: null }); };
  let r = run('0', { uncountedIsRed: false });
  ok('F3u. explicit uncountedIsRed false: "0 total" for the single rerun -> exit 0, flaky, not counted', r.rc === 0 && r.flaky.includes('g/a-run.js') && !r.uncounted.length, `${r.rc} ${JSON.stringify(r)}`);
  r = run('', { uncountedIsRed: true });
  ok('F3u. uncountedIsRed true: no tally line from the single rerun -> exit 69, not flaky', r.rc === 69 && !r.flaky.length && r.uncounted.includes('g/a-run.js') && /environment: the single rerun of g\/a-run\.js/.test(r.envText || ''),
    `${r.rc} ${JSON.stringify(r)}`);
  r = run('1', { uncountedIsRed: true });
  ok('F3u. uncountedIsRed true: "1 total" -> exit 0, flaky (the count is 1 of 1)', r.rc === 0 && r.flaky.includes('g/a-run.js'), `${r.rc} ${JSON.stringify(r)}`);
}

// F3e (end to end, guards-all.sh): the key absent or true decides the single rerun's count
function partF3E(TMP) {
  const f = fixture(TMP);
  const FULLLOG = path.join(f.shared, 'guards-pt.txt'), RR = path.join(f.shared, 'guards-pt.rerun.txt');
  const full = (rc, log, one) => { f.clear(); f.set('full.log', log); f.set('full.rc', rc); f.set('one.n', one); };
  const noKey = JSON.parse(read(f.cfgFile));
  delete noKey.guardRerun.uncountedIsRed;
  fs.writeFileSync(f.cfgFile, JSON.stringify(noKey));
  full(1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 3 total\n', 0);
  let x = f.ga(true, 'pt');
  ok('F3e. no uncountedIsRed (the group alone): the single rerun "TOTAL: 0 total" -> exit 0, flaky, no environment line',
    x.status === 0 && /flaky/.test(read(FULLLOG) || '') && !/environment:/.test(read(FULLLOG) || ''), `${x.status} ${(read(FULLLOG) || '').slice(-600)} ${x.all.slice(-300)}`);
  const withKey = JSON.parse(read(f.cfgFile));
  withKey.guardRerun.uncountedIsRed = true;
  fs.writeFileSync(f.cfgFile, JSON.stringify(withKey));
  full(1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 3 total\n', '');
  x = f.ga(true, 'pt');
  ok('F3e. uncountedIsRed true: the single rerun with no tally line -> exit 69 with the environment line, not flaky',
    x.status === 69 && /^environment: the single rerun of g\/a-run\.js has no total line/m.test(read(RR) || '') && /0 flaky, 1 not counted/.test(read(FULLLOG) || ''), `${x.status} ${(read(RR) || '').slice(-600)} ${x.all.slice(-300)}`);
}

// T1: the single rerun of a new red in a full run (B14 end to end) and T3: a counted 69 is never reused
function partRerun(TMP) {
  const f = fixture(TMP);
  const FULLLOG = path.join(f.shared, 'guards-pt.txt'), RR = path.join(f.shared, 'guards-pt.rerun.txt');
  const full = (rc, log, one) => { f.clear(); f.set('full.log', log); f.set('full.rc', rc); f.set('one.n', one); };
  full(1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 3 total\n', 0);
  let x = f.ga(true, 'pt');
  ok('B14 e2e. a full run, the single rerun exits 0 with "TOTAL: 0 total" -> exit 69, not flaky',
    x.status === 69 && /^environment: the single rerun of g\/a-run\.js accounted for 0 of 1 selected guards: g\/a-run\.js/m.test(read(FULLLOG) || ''), `${x.status} ${(read(FULLLOG) || '').slice(-600)} ${x.all.slice(-400)}`);
  ok('B14 e2e. ... the single rerun ran (one.count) and the rerun log says why', f.count('one.count').length === 1 && /environment: the single rerun/.test(read(RR) || ''), read(RR));
  full(1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 3 total\n', 1);
  x = f.ga(true, 'pt');
  ok('B14 e2e. the single rerun exits 0 with "TOTAL: 1 total" -> exit 0, flaky (not a regression)', x.status === 0 && !/environment:/.test(read(FULLLOG) || '') && /flaky/.test(read(FULLLOG) || ''), `${x.status} ${(read(FULLLOG) || '').slice(-600)}`);

  // T3: a selection that ended 69 by its count is not reused: the same HEAD and a clean tree run again
  const SEL = path.join(f.shared, 'guards-pt.select.txt');
  f.clear(); f.set('sub.log', 'TOTAL: 0 total\n'); f.set('sub.rc', 0);
  x = f.ga(false, '--select', 'base', 'pt');
  const first = x.status;
  ok('T3. the first selection accounted for 0 of 3 -> exit 69', first === 69, `${first} ${x.all.slice(-400)}`);
  f.clear(); f.set('sub.log', 'TOTAL: 3 total\n'); f.set('sub.rc', 0);
  x = f.ga(false, '--select', 'base', 'pt');
  ok('T3. the same selection again without --force runs (no "reused"), accounted for 3 of 3 -> exit 0',
    x.status === 0 && !/reused/.test(x.all) && f.count('sub.count').length === 1, `${x.status} sub=${f.count('sub.count').length} ${x.all.slice(-500)}`);
}

// T4 and T5: the library and the CLI refuse what they cannot count (no pass without a count)
function partRefuse(TMP) {
  const cfg = { tallyPattern: '^TOTAL: (\\D+) total$' };
  const r = G.countCheck({ text: 'TOTAL: x total\n', cfg, selected: ['a'] });
  ok('T4. a count group that captures no digits -> not ok (never NaN < need passes)', r.ok === false && /^environment: /m.test(r.text), JSON.stringify(r));
  const sf = path.join(TMP, 'sel.json'), lg = path.join(TMP, 'run.txt');
  fs.writeFileSync(sf, '{"not":"an array"}'); fs.writeFileSync(lg, 'TOTAL: 3 total\n');
  const x = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'count', lg, JSON.stringify(RERUN), sf], { encoding: 'utf8' });
  ok('T5. count with a selection file that is not a JSON array -> exit 69 with the environment line', x.status === 69 && /^environment: the selected guards file/m.test(read(lg) || ''), `${x.status} ${x.stdout} ${x.stderr}`);
}

const part = (name, f) => { try { f(); } catch (e) { ok(`${name}: no exception`, false, e && e.stack); } };
part('no NaN pass and count CLI', () => { const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-bt-r-'))); try { partRefuse(T); } finally { fs.rmSync(T, { recursive: true, force: true }); } });
part('F3 config', partF3Config);
if (!(has('zsh') && has('git'))) skip('guards-all.sh end to end', 'zsh or git not found');
else {
  part('F3 single rerun unit', () => { const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-bt-f3u-'))); try { partF3Unit(T); } finally { fs.rmSync(T, { recursive: true, force: true }); } });
  for (const [name, f] of [['selection with localPattern', partSkipped], ['single rerun and meta', partRerun], ['F3 uncountedIsRed end to end', partF3E]]) {
    const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-bt-'))); // each part its own fixture
    try { part(name, () => f(T)); } finally { fs.rmSync(T, { recursive: true, force: true }); }
  }
}
done();
