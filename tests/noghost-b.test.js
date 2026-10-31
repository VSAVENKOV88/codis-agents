#!/usr/bin/env node
'use strict';
// p-noghost-b: "selected N - accounted for N" (cells B1-B14 of the p-noghost matrix, coordinator's decisions 1-3 of
// 2026-10-31) and the review finding of p-noghost-a (the runner checks the template of the subset command, never the
// command filled with the guard names).
// Case 2026-10-30: the part here ran "--concurrency {jobs}" literally, the project's runner took NaN workers, ran 0 of 10
// guards and exited 0 - two green trains without the Mac part. A run that was given guards by --only (a selection, the
// attribution of a train, the part here, the runner's selection) now compares the count of its tally line (group 1 of
// guardRerun.tallyPattern: the selected guards the run accounted for - ran, or skipped by a flag) with the selected
// guards minus those its log names as skipped (remoteRun.localPattern): fewer, or no tally line, is the environment (69).
//   unit: config.js (B13), guards-result.js countCheck (B4, B5, B8, B9, B10) and the single rerun (B14);
//   guards-all.sh here: --guards (B6), --select (B4, B5), nothing selected (B11), a full run (B12), the check before the
//     rerun of new reds;
//   guards-all.sh with a fake remote runner: the runner's selection (B7), the part here (B1, B2, B3), a guard name with
//     braces (review a).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 900));

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/config');
const G = require('../scripts/guards-result');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const TALLY = '^TOTAL: (\\d+) total$';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+)  \\(', tallyPattern: TALLY };
const LOCALP = '^skipped \\(needs-font\\): \\d+ — (.+)$';
// F3 (coordinator's decision 2026-10-31, variant Б): the single rerun is counted only with uncountedIsRed, not by the group
const RERUN_ONE = Object.assign({}, RERUN, { uncountedIsRed: true });

function partConfig() {
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'x {wt}' };
  const errs = (o) => C.resolve(Object.assign({}, base, o)).errors.join('; ');
  let e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}' });
  ok('B13. guardSubsetCommand without guardRerun -> a config error naming guardRerun.tallyPattern', /guardRerun\.tallyPattern: required/.test(e), e);
  e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}', guardRerun: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: ' }) });
  ok('B13. guardSubsetCommand with a tallyPattern without a capture group -> a config error (the count)', /guardRerun\.tallyPattern: .*capture group/.test(e), e);
  e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}', guardRerun: Object.assign({}, RERUN, { tallyPattern: '' }) });
  ok('B13. guardSubsetCommand with an empty tallyPattern -> a config error', /guardRerun\.tallyPattern: required/.test(e), e);
  e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}', guardRerun: RERUN });
  ok('B13. guardSubsetCommand with a tallyPattern with a count group -> no error', e === '', e);
  // F4 (review a, round 1): a bad regexp is named once, as a bad regular expression, not also as a missing capture group
  e = errs({ guardSubsetCommand: 'x {wt} {onlyArgs}', guardRerun: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: (\\d+' }) });
  ok('F4. a bad tallyPattern with guardSubsetCommand -> one error (bad regular expression), no capture-group error', /guardRerun\.tallyPattern: bad regular expression/.test(e) && !/capture group/.test(e), e);
  e = errs({ remoteRun: { command: 'y {wt}', deps: [], localPattern: LOCALP, localCommand: 'z {wt} {onlyArgs}' }, guardRerun: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: ' }) });
  ok('B13. remoteRun.localPattern with a tallyPattern without a count group -> a config error', /guardRerun\.tallyPattern: .*capture group/.test(e), e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: ' }) });
  ok('B12/B13. no selection key: a tallyPattern without a group stays valid (a full run is not counted)', e === '', e);
  // F3 (coordinator's decision 2026-10-31, variant Б): uncountedIsRed is its own key, a boolean that needs the count
  e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: true, tallyPattern: '^TOTAL: ' }) });
  ok('F3. uncountedIsRed true with a tallyPattern without a count group -> a config error naming the key', /guardRerun\.uncountedIsRed: .*capture group/.test(e), e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: true, tallyPattern: '' }) });
  ok('F3. uncountedIsRed true without tallyPattern -> a config error naming the key', /guardRerun\.uncountedIsRed: /.test(e), e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: 'yes' }) });
  ok('F3. uncountedIsRed is a boolean (expected boolean)', /guardRerun\.uncountedIsRed: expected boolean/.test(e), e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { uncountedIsRed: true }) });
  ok('F3. uncountedIsRed true with a count group and no selection key -> no error', e === '', e);
  e = errs({ guardRerun: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: ' }) });
  ok('F3. no uncountedIsRed and no selection key -> the key is not required (default false)', e === '', e);
  const rr = C.resolve(Object.assign({}, base, { guardRerun: RERUN })).config.guardRerun;
  ok('F3. the resolved guardRerun has uncountedIsRed false when the key is absent (the default is off)', rr.uncountedIsRed === false, JSON.stringify(rr));
  const schema = JSON.parse(read(path.join(ROOT, 'schemas', 'codis-agents.schema.json')));
  ok('docs: the schema of guardRerun.tallyPattern names the count group', /capture group/.test(schema.properties.guardRerun.properties.tallyPattern.description), schema.properties.guardRerun.properties.tallyPattern.description);
  const uir = schema.properties.guardRerun.properties.uncountedIsRed || {};
  ok('F3. docs: the schema has uncountedIsRed, a boolean that names the single rerun and the 69', uir.type === 'boolean' && /single rerun/.test(uir.description || '') && /69/.test(uir.description || ''), JSON.stringify(uir));
  const readme = read(path.join(ROOT, 'README.md'));
  const row = (k) => (readme.split('\n').find((l) => l.startsWith(`| \`${k}\``)) || '');
  ok('docs: README guardRerun names the count invariant (selected -> accounted for, else 69)', /accounted for/.test(row('guardRerun')) && /69/.test(row('guardRerun')), row('guardRerun'));
  ok('F3. docs: README guardRerun names uncountedIsRed (the single rerun is counted only with it)', /uncountedIsRed/.test(row('guardRerun')), row('guardRerun'));
  const rules = read(path.join(ROOT, 'rules', 'multi-agent.md'));
  ok('docs: the rules name the count of a selection as an environment red', /accounted for fewer/.test(rules), '');
  ok('F3. docs: the rules name uncountedIsRed as the switch of the single rerun count', /uncountedIsRed/.test(rules), '');
  const rc = read(path.join(ROOT, 'workflows', 'role-chain.js'));
  ok('ENV_RC[69] names a run that did not account for its selected guards', /69: '[^'\n]*did not account for its selected guards/.test(rc), (rc.match(/ {2}69: '[^\n]*/) || [''])[0]);
}

function partCount() {
  const cfg = RERUN;
  const S3 = ['a', 'b', 'c'];
  let r = G.countCheck({ text: 'X a  (1s)\nTOTAL: 3 total\n', cfg, selected: S3 });
  ok('B4. 3 selected, "3 total" -> ok', r && r.ok === true, JSON.stringify(r));
  r = G.countCheck({ text: 'TOTAL: 1 total\n', cfg, selected: S3 });
  ok('B5. 1 of 3 -> not ok, "environment: the run accounted for 1 of 3 selected guards: a, b, c"', r && r.ok === false
    && /^environment: the run accounted for 1 of 3 selected guards: a, b, c/m.test(r.text), JSON.stringify(r));
  const S66 = Array.from({ length: 66 }, (_, i) => `g${i}`);
  const skippedLine = 'skipped (needs-font): 2 — g0, g1\n';
  const at = (n) => G.countCheck({ text: `${skippedLine}TOTAL: ${n} total\n`, cfg, selected: S66, localPattern: LOCALP });
  ok('B8. 66 selected, 2 of them skipped by the flag: 66 -> ok, 64 -> ok, 63 -> not ok', at(66).ok && at(64).ok && !at(63).ok, JSON.stringify([at(66), at(64), at(63)].map((x) => x.ok)));
  ok('B8. ... the message names the skipped ones', /2 skipped by a flag/.test(at(63).text), at(63).text);
  r = G.countCheck({ text: 'X a  (1s)\n', cfg, selected: S3 });
  ok('B9. no tally line -> not ok, "no total line"', r && r.ok === false && /no total line/.test(r.text) && /^environment: /m.test(r.text), JSON.stringify(r));
  r = G.countCheck({ text: 'TOTAL: 5 total\n', cfg, selected: S3 });
  ok('B10. more than selected (one --only matched several) -> ok', r && r.ok === true, JSON.stringify(r));
  r = G.countCheck({ text: 'TOTAL: 2 total\nTOTAL: 0 total\n', cfg, selected: ['a'] });
  ok('the last tally line decides', r && r.ok === false, JSON.stringify(r));
  r = G.countCheck({ text: 'TOTAL: 0 total\n', cfg, selected: ['a', 'b'], label: 'the part here' });
  ok('B1 (text). the label names the part here', /^environment: the part here accounted for 0 of 2 selected guards: a, b/m.test(r.text), r.text);
  r = G.countCheck({ text: 'TOTAL: 0 total\n', cfg: Object.assign({}, cfg, { tallyPattern: '^TOTAL: ' }), selected: ['a'] });
  ok('a tallyPattern without a count group -> not ok (never a silent pass)', r && r.ok === false && /capture group/.test(r.text), JSON.stringify(r));
}

function partRerunOne(TMP) {
  // B14: the single rerun (guardRerun.command) that ran 0 of 1 is not "green alone"
  const w = path.join(TMP, 'r14');
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, 'one.sh'), `#!/bin/sh\ncat "${TMP}/one.out"\nexit 0\n`, { mode: 0o755 });
  const log = path.join(TMP, 'guards-r14.txt');
  const run = (out) => {
    fs.writeFileSync(path.join(TMP, 'one.out'), out);
    fs.writeFileSync(log, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 1 total\n');
    return G.rerun({ wt: w, log, rc: 1, cfg: RERUN_ONE, baseline: '', quarantine: '', readOnly: false, selected: null });
  };
  let r = run('TOTAL: 0 total\n');
  ok('B14. the single rerun exits 0 with "0 total" -> not flaky, exit 69, the log says why', r.rc === 69 && !r.flaky.length
    && /environment: the single rerun of g\/a-run\.js accounted for 0 of 1/.test(read(log)), `${r.rc} ${JSON.stringify(r.flaky)} ${read(log)}`);
  r = run('no tally at all\n');
  ok('B14. the single rerun exits 0 without a tally line -> not flaky, exit 69', r.rc === 69 && !r.flaky.length, `${r.rc} ${read(log)}`);
  r = run('TOTAL: 1 total\n');
  ok('B14. the single rerun exits 0 with "1 total" -> flaky, exit 0', r.rc === 0 && r.flaky.includes('g/a-run.js'), `${r.rc} ${read(log)}`);
  r = G.rerun({ wt: w, log: (fs.writeFileSync(log, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 1 total\n'), fs.writeFileSync(path.join(TMP, 'one.out'), 'TOTAL: 0 total\n'), log), rc: 1,
    cfg: Object.assign({}, RERUN, { tallyPattern: '^TOTAL: (?:\\d+) total$' }), baseline: '', quarantine: '', readOnly: false, selected: null });
  ok('B14. a tallyPattern without a count group (no selection key) -> the single rerun is not counted (as before)', r.rc === 0 && r.flaky.includes('g/a-run.js'), `${r.rc} ${read(log)}`);
  // F1 (review a, round 1): a real repeated red A and a single rerun of B that accounts for 0 of 1 -> the code of the red
  // (1), not the environment (69): B is not counted, A is still a regression in the log
  const w2 = path.join(TMP, 'r14b');
  fs.mkdirSync(w2, { recursive: true });
  fs.writeFileSync(path.join(w2, 'one.sh'), `#!/bin/sh\nif [ "$1" = "g/a-run.js" ]; then exit 1; fi\ncat "${TMP}/one.out"\nexit 0\n`, { mode: 0o755 });
  const log2 = path.join(TMP, 'guards-r14b.txt');
  fs.writeFileSync(path.join(TMP, 'one.out'), 'TOTAL: 0 total\n');
  fs.writeFileSync(log2, 'X g/a-run.js  (1.0s, code 1)\nX g/b-run.js  (1.0s, code 1)\nTOTAL: 2 total\n');
  r = G.rerun({ wt: w2, log: log2, rc: 1, cfg: RERUN_ONE, baseline: '', quarantine: '', readOnly: false, selected: null });
  ok('F1. a repeated red A and a single rerun B that accounts for 0 of 1 -> exit 1 (the red), not 69; A repeated, B not counted',
    r.rc === 1 && r.repeated.map((x) => x.name).join() === 'g/a-run.js' && r.uncounted.join() === 'g/b-run.js' && !r.flaky.length, `${r.rc} ${JSON.stringify(r)} ${read(log2)}`);
  // F3: the group of tallyPattern alone does not count the single rerun: no uncountedIsRed -> "0 total" is green alone (flaky), as before B14
  fs.writeFileSync(path.join(TMP, 'one.out'), 'TOTAL: 0 total\n');
  fs.writeFileSync(log, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 1 total\n');
  r = G.rerun({ wt: w, log, rc: 1, cfg: RERUN, baseline: '', quarantine: '', readOnly: false, selected: null });
  ok('F3. a tallyPattern with a count group and no uncountedIsRed: a single rerun with "0 total" is flaky (exit 0), not counted',
    r.rc === 0 && r.flaky.includes('g/a-run.js') && !r.uncounted.length, `${r.rc} ${JSON.stringify(r)} ${read(log)}`);
  r = G.rerun({ wt: w, log, rc: 1, cfg: RERUN_ONE, baseline: '', quarantine: '', readOnly: false, selected: null });
  ok('F3. the same with uncountedIsRed true: "0 total" -> exit 69, not flaky', r.rc === 69 && !r.flaky.length && r.uncounted.includes('g/a-run.js'),
    `${r.rc} ${JSON.stringify(r)} ${read(log)}`);
}

// F2 (review a, round 1): the host reads the log of a selection (guards-<name>.select.txt) when the run has no full log
function partFetch(TMP) {
  const H = require('../scripts/guards-remote-host');
  const root = path.join(TMP, 'host');
  const dir = path.join(root, 'runs', 'sx');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id: 'R1' }));
  fs.writeFileSync(path.join(dir, 'rc'), JSON.stringify({ rc: 0 }));
  fs.writeFileSync(path.join(dir, 'guards-sx.select.txt'), 'SELECTED LOG\nTOTAL: 1 total\n');
  fs.writeFileSync(path.join(dir, 'out.txt'), 'workers: 2\n');
  const f = H.OPS.fetch(H.layout({ root }), { name: 'sx', id: 'R1' });
  ok('F2. the host fetch of a selection reads guards-<name>.select.txt (no full log): the log, no rerun log, the workers',
    f.log === 'SELECTED LOG\nTOTAL: 1 total\n' && f.rerun === null && f.rc === 0 && f.workers === 2, JSON.stringify(f));
  fs.writeFileSync(path.join(dir, 'guards-sx.txt'), 'FULL LOG\n');
  const g = H.OPS.fetch(H.layout({ root }), { name: 'sx', id: 'R1' });
  ok('F2. a full log, when there is one, is read and the selection log is not', g.log === 'FULL LOG\n', JSON.stringify(g));
}

const fakeBin = (bin) => {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
};
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
const cleanEnv = () => {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
};

function partLocal(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), w = path.join(wts, 'pw');
  for (const d of [bin, shared, w]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), s); if (mode) fs.chmodSync(path.join(w, f), mode); };
  put('full.sh', `#!/bin/sh\necho "run $*" >> "${TMP}/full.count"\ncat "${TMP}/sub.log"\nexit $(cat "${TMP}/sub.rc")\n`, 0o755);
  put('sub.sh', `#!/bin/sh\necho "$*" >> "${TMP}/sub.count"\ncat "${TMP}/sub.log"\nexit $(cat "${TMP}/sub.rc")\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$1" >> "${TMP}/one.count"\necho "TOTAL: 1 total"\nexit 0\n`, 0o755);
  for (const g of ['a', 'b', 'c']) put(`g/${g}-run.js`, `// ${g}\n`);
  gitC(w, 'init', '-q', '-b', 'base'); gitC(w, 'add', '.'); gitC(w, 'commit', '-q', '-m', 'base');
  gitC(w, 'checkout', '-q', '-b', 'task');
  for (const g of ['a', 'b', 'c']) put(`g/${g}-run.js`, `// ${g} changed\n`);
  gitC(w, 'add', 'g'); gitC(w, 'commit', '-q', '-m', 'change');
  const f = path.join(TMP, 'cfg.json');
  fs.writeFileSync(f, JSON.stringify({ repoDir: path.join(TMP, 'main'), worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh',
    guardSubsetCommand: 'cd {wt} && ./sub.sh {onlyArgs}', guardRerun: RERUN, protectedBranches: ['base'], slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }));
  cleanEnv();
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', '--force', ...a], { encoding: 'utf8', env, timeout: 120000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const count = (n) => (read(path.join(TMP, n)) || '').split('\n').filter(Boolean);
  const set = (rc, log) => {
    fs.writeFileSync(path.join(TMP, 'sub.log'), log); fs.writeFileSync(path.join(TMP, 'sub.rc'), String(rc));
    for (const c of ['sub.count', 'one.count', 'full.count']) fs.rmSync(path.join(TMP, c), { force: true });
  };
  const SEL = path.join(shared, 'guards-pw.select.txt'), FULL = path.join(shared, 'guards-pw.txt');
  const meta = (l) => { try { return JSON.parse(read(l + '.meta.json')); } catch { return {}; } };
  const names = path.join(TMP, 'names.json');

  // B6: --guards (the attribution of a train), 0 of 1
  fs.writeFileSync(names, JSON.stringify(['g/a-run.js']));
  set(0, 'TOTAL: 0 total\n');
  let x = ga('--guards', names, 'pw');
  ok('B6. --guards, the runner exits 0 with "0 total" for 1 named guard -> exit 69', x.status === 69 && count('sub.count').length === 1, `${x.status} ${x.all.slice(-600)}`);
  ok('B6. ... the log names the count and the guard, the meta keeps 69 (never reused)', /^environment: the run accounted for 0 of 1 selected guards: g\/a-run\.js/m.test(read(SEL) || '') && meta(SEL).rc === 69, `${read(SEL)} ${JSON.stringify(meta(SEL))}`);
  set(0, 'TOTAL: 1 total\n');
  x = ga('--guards', names, 'pw');
  ok('B6. --guards, "1 total" -> exit 0, no environment line', x.status === 0 && !/environment:/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  // B5 / B4: --select of the diff (3 guards)
  set(0, 'TOTAL: 1 total\n');
  x = ga('--select', 'base', 'pw');
  ok('B5. --select of 3 guards, "1 total" -> exit 69, the three named', x.status === 69 && /accounted for 1 of 3 selected guards: g\/a-run\.js, g\/b-run\.js, g\/c-run\.js/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  set(0, 'TOTAL: 3 total\n');
  x = ga('--select', 'base', 'pw');
  ok('B4. --select of 3 guards, "3 total" -> exit 0', x.status === 0, `${x.status} ${read(SEL)}`);
  // the check comes before the rerun of new reds, and a green rerun does not cover it
  set(1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 0 total\n');
  x = ga('--select', 'base', 'pw');
  ok('B5 x rerun. a red selection that accounted for 0 of 3 -> exit 69, no single rerun', x.status === 69 && !count('one.count').length, `${x.status} one=${count('one.count').length} ${read(SEL)}`);
  // B9: no tally line
  set(0, 'nothing here\n');
  x = ga('--select', 'base', 'pw');
  ok('B9. a selection log without its tally line -> exit 69 "no total line"', x.status === 69 && /no total line/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  // B11: nothing selected
  fs.writeFileSync(names, '[]');
  set(0, 'TOTAL: 0 total\n');
  x = ga('--guards', names, 'pw');
  ok('B11. an empty list -> "nothing selected", exit 0, nothing runs', x.status === 0 && /nothing selected/.test(read(SEL) || '') && !count('sub.count').length, `${x.status} ${read(SEL)}`);
  // B12: a full run is not counted
  set(0, 'TOTAL: 0 total\n');
  x = ga('pw');
  ok('B12. a full run with "0 total" -> exit 0 (only --only runs are counted)', x.status === 0 && count('full.count').length === 1 && !/environment:/.test(read(FULL) || ''), `${x.status} ${read(FULL)}`);
}

function partRemote(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), main = path.join(TMP, 'main');
  const S = path.join(TMP, 'server'), sshLog = path.join(TMP, 'ssh.log');
  for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(a) + '\\n');
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env, cwd: ${JSON.stringify(S)} });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
  put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/full.count"\ncat "${TMP}/full.log"\nexit $(cat "${TMP}/full.rc")\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$PWD $1" >> "${TMP}/one.count"\ngrep -qxF -- "$1" "${TMP}/red.txt" && exit 1\necho "TOTAL: 1 total"\nexit 0\n`, 0o755);
  put('local.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/local.count"\ncat "${TMP}/local.log"\nexit 0\n`, 0o755);
  put('srv/a-run.js', '// a\n'); put('srv/c-run.js', '// c\n'); put('srv/b{jobs}-run.js', '// b\n');
  gitC(main, 'init', '-q', '-b', 'trunk'); gitC(main, 'add', '.'); gitC(main, 'commit', '-q', '-m', 'project');
  gitC(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  const xw = path.join(wts, 'xw');
  gitC(main, 'worktree', 'add', '-q', '-b', 'task', xw);
  for (const g of ['a-run.js', 'c-run.js', 'b{jobs}-run.js']) fs.writeFileSync(path.join(xw, 'srv', g), `// ${g} changed\n`);
  gitC(xw, 'add', 'srv'); gitC(xw, 'commit', '-q', '-m', 'change');
  fs.writeFileSync(path.join(TMP, 'key'), 'not a key\n'); fs.writeFileSync(path.join(TMP, 'kh'), 'example.org ssh-ed25519 AAAA\n');
  const remote = { host: 'example.org', user: 'runner', key: path.join(TMP, 'key'), knownHosts: path.join(TMP, 'kh'), root: '~/codis-runs', plugin: ROOT };
  const mfile = path.join(TMP, 'machine.json');
  fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(TMP, 'slots') }, remote }));
  fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
  fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
  const cfgFile = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}', guardRerun: RERUN,
    guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', protectedBranches: ['trunk'],
    remoteRun: { command: 'cd {wt} && ./full.sh {jobs}', localPattern: LOCALP, subsetCommand: 'cd {wt} && ./full.sh {onlyArgs} --jobs {jobs}' } }));
  cleanEnv();
  const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
    SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV });
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--force', ...a], { encoding: 'utf8', env, timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const count = (n) => (read(path.join(TMP, n)) || '').split('\n').filter(Boolean);
  const set = (rc, log, local, red) => {
    fs.writeFileSync(path.join(TMP, 'full.log'), log); fs.writeFileSync(path.join(TMP, 'full.rc'), String(rc)); fs.writeFileSync(path.join(TMP, 'local.log'), local || '');
    fs.writeFileSync(path.join(TMP, 'red.txt'), (red || []).map((n) => n + '\n').join(''));
    for (const c of ['full.count', 'one.count', 'local.count']) fs.rmSync(path.join(TMP, c), { force: true });
    fs.rmSync(sshLog, { force: true });
  };
  const SEL = path.join(shared, 'guards-xw.select.txt'), FULLL = path.join(shared, 'guards-xw.txt');
  const meta = (l) => { try { return JSON.parse(read(l + '.meta.json')); } catch { return {}; } };
  const SKIP2 = 'skipped (needs-font): 2 — srv/c-run.js, srv/d-run.js\n';

  // B1: a full run on the runner, the part here (2 guards) runs 0 of them and exits 0
  set(0, `${SKIP2}TOTAL: 5 total\n`, 'TOTAL: 0 total\n');
  let x = ga('xw');
  ok('B1. the part here accounted for 0 of 2, the runner 0 -> exit 69', x.status === 69 && count('local.count').length === 1, `${x.status} ${x.all.slice(-900)}`);
  ok('B1. ... the log says "environment: the part here accounted for 0 of 2 selected guards: srv/c-run.js, srv/d-run.js", the meta keeps 69',
    /^environment: the part here accounted for 0 of 2 selected guards: srv\/c-run\.js, srv\/d-run\.js/m.test(read(FULLL) || '') && meta(FULLL).rc === 69, `${(read(FULLL) || '').slice(-700)} ${JSON.stringify(meta(FULLL))}`);
  // B2: 2 of 2 -> the runner's code
  set(0, `${SKIP2}TOTAL: 5 total\n`, 'TOTAL: 2 total\n');
  x = ga('xw');
  ok('B2. the part here accounted for 2 of 2 -> exit 0, no environment line', x.status === 0 && !/environment:/.test(read(FULLL) || ''), `${x.status} ${(read(FULLL) || '').slice(-700)}`);
  // B3: the runner red (repeated alone) and the part here 0 of 2 -> 69, not 1
  set(1, `X srv/a-run.js  (1.0s, code 1)\n${SKIP2}TOTAL: 5 total\n`, 'TOTAL: 0 total\n', ['srv/a-run.js']);
  x = ga('xw');
  ok('B3. the runner exits 1 and the part here accounted for 0 of 2 -> exit 69 (a run without the part here is no verdict)', x.status === 69, `${x.status} ${(read(FULLL) || '').slice(-900)}`);

  // B7 + review a: the selection on the runner (3 guards, one skipped there by the flag), one named with braces
  set(0, 'skipped (needs-font): 1 — srv/c-run.js\nTOTAL: 0 total\n', 'TOTAL: 1 total\n');
  x = ga('--select', 'trunk', 'xw');
  const fc = count('full.count')[0] || '';
  ok('review a. the runner runs the guard named with braces as it is ({jobs} inside a name is never filled in)', /--only srv\/b\{jobs\}-run\.js/.test(fc) && /--jobs [0-9]+/.test(fc), fc);
  ok('B7. the runner\'s selection accounted for 0 of 3 (1 skipped by a flag) -> exit 69, the code comes back', x.status === 69 && /accounted for 0 of 3 selected guards/.test(read(SEL) || ''), `${x.status} ${(read(SEL) || '').slice(-900)} ${x.all.slice(-600)}`);
  const rcfg = (() => { try { return JSON.parse(read(path.join(S, 'codis-runs', 'runs', 'xw-select', 'codis-agents.json'))); } catch { return {}; } })();
  ok('review a. the runner gets the template of the subset command ({onlyArgs} unfilled), never the command filled with names', rcfg.guardSubsetCommand === 'cd {wt} && ./full.sh {onlyArgs} --jobs {jobs}'
    && !/--only/.test(JSON.stringify(rcfg)), JSON.stringify(rcfg));
  set(0, 'skipped (needs-font): 1 — srv/c-run.js\nTOTAL: 2 total\n', 'TOTAL: 1 total\n');
  x = ga('--select', 'trunk', 'xw');
  ok('B7. the runner\'s selection accounted for 2 of 3 with 1 skipped by a flag, the part here 1 of 1 -> exit 0', x.status === 0, `${x.status} ${(read(SEL) || '').slice(-900)} ${x.all.slice(-600)}`);
}

// each part on its own: an exception in one never hides the cells of the others
const part = (name, f) => { try { f(); } catch (e) { ok(`${name}: no exception`, false, e && e.stack); } };
part('config', partConfig);
part('count', partCount);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-b-')));
try {
  part('single rerun', () => partRerunOne(TMP));
  part('fetch of a selection log', () => partFetch(TMP));
  if (!(has('zsh') && has('git'))) skip('guards-all.sh end to end', 'zsh or git not found');
  else {
    fs.mkdirSync(path.join(TMP, 'l')); fs.mkdirSync(path.join(TMP, 'r'));
    part('guards-all.sh here', () => partLocal(path.join(TMP, 'l')));
    if (!has('perl')) skip('the remote runner', 'perl not found'); else part('remote runner', () => partRemote(path.join(TMP, 'r')));
  }
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
done();
