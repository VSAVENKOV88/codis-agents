#!/usr/bin/env node
'use strict';
// Known reds of the project (config guardBaseline, owner decision U-20): a JSON file in the project's repository,
// {"<guard name>": "<reason>"}, its path relative to the worktree; it needs guardRerun (the names come from the log by
// newRedPattern). guards-result.js rerun subtracts the known names before counting maxReruns and never reruns them:
// - F1 a red run whose reds are all known -> exit 0, "N known red";
// - F2 one known + one new that is red again alone -> the runner's code, the known one not rerun;
// - F3 more reds than maxReruns, but no more new ones than that -> the reruns go on;
// - F4 no tally (a cut-off run), all names known -> the runner's code stands;
// - F5 guardBaseline without guardRerun -> config error; the file missing or broken -> an error line, the code stands
//   (never "all known" in silence);
// - F6 a known name not red in the log -> "known red not red now: X — remove it from the baseline", code unchanged;
// - F7 a run of known reds only (exit 0) is reused on the same HEAD.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const zsh = has('zsh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'known-red-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

// A pytest-like log: one line per failed test, then the tally.
const log = (names, tally = true) => names.map((n) => `FAILED ${n} - AssertionError`).join('\n') + '\n' + (tally ? `=== ${names.length} failed, 7 passed in 1.2s ===\n` : '');
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' };
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };

try {
  // --- config ---
  const res = (extra) => C.resolve(Object.assign({}, base, extra));
  let r = res({ guardRerun: RERUN, guardBaseline: 'tests/known-red.json' });
  ok('config: guardBaseline with guardRerun resolves to the relative path', !r.errors.length && r.config.guardBaseline === 'tests/known-red.json', r.errors.join('; '));
  ok('config: no guardBaseline -> empty (nothing known)', res({ guardRerun: RERUN }).config.guardBaseline === '');
  ok('F5 config: guardBaseline without guardRerun -> error', /guardBaseline: needs guardRerun/.test(res({ guardBaseline: 'k.json' }).errors.join('; ')), res({ guardBaseline: 'k.json' }).errors.join('; '));
  ok('config: guardBaseline is relative to the worktree - an absolute path is an error',
    /guardBaseline: a path relative to the worktree/.test(res({ guardRerun: RERUN, guardBaseline: '/abs/k.json' }).errors.join('; ')), res({ guardRerun: RERUN, guardBaseline: '/abs/k.json' }).errors.join('; '));
  ok('config: guardBaseline must be a string', /guardBaseline: expected string/.test(res({ guardRerun: RERUN, guardBaseline: { a: 1 } }).errors.join('; ')));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents.schema.json'), 'utf8'));
  ok('schema: guardBaseline is described', schema.properties.guardBaseline && schema.properties.guardBaseline.type === 'string');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('README: the config table explains guardBaseline', /\| `guardBaseline` \|[^\n]*guardRerun[^\n]*known red/.test(readme));
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  ok('rules: the rerun rule names the known reds of guardBaseline', /guardBaseline/.test(rules));

  // --- rerun with a baseline ---
  const cfg = C.resolve(Object.assign({}, base, { guardRerun: RERUN })).config.guardRerun;
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\necho "$1" >> "${tmp}/calls.txt"\ngrep -qxF -- "$1" "${tmp}/red.txt" && exit 1\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  const logf = path.join(tmp, 'guards-wt.txt');
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const known = (obj) => fs.writeFileSync(path.join(wt, 'known.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const reset = (names, red, tally) => { fs.writeFileSync(logf, log(names, tally)); fs.rmSync(path.join(tmp, 'calls.txt'), { force: true });
    fs.writeFileSync(path.join(tmp, 'red.txt'), red.map((x) => x + '\n').join('')); };
  const R = (rc, c = cfg) => G.rerun({ wt, log: logf, rc, cfg: c, baseline: 'known.json' });

  known({ 'tests/test_a.py::t1': 'BACKLOG #12', 'tests/test_b.py::t2': 'BACKLOG #13' });
  reset(['tests/test_a.py::t1', 'tests/test_b.py::t2'], ['tests/test_a.py::t1', 'tests/test_b.py::t2']);
  r = R(1);
  ok('F1 all reds known -> exit 0, "2 known red", nothing reruns', r.rc === 0 && /\b2 known red\b/.test(r.text) && !calls().length, JSON.stringify(r));
  ok('F1 each known red is named with its reason', /known red[^\n]*tests\/test_a\.py::t1[^\n]*BACKLOG #12/.test(r.text) && /tests\/test_b\.py::t2[^\n]*BACKLOG #13/.test(r.text), r.text);
  ok('F1 the summary is appended to the log', fs.readFileSync(logf, 'utf8').includes('2 known red'), fs.readFileSync(logf, 'utf8').slice(-300));

  if (!zsh) {
    for (const n of ['F2', 'F3', 'F6 (with reruns)']) skip(n, 'zsh not found');
  } else {
    reset(['tests/test_a.py::t1', 'tests/test_n.py::new'], ['tests/test_n.py::new', 'tests/test_a.py::t1']);
    r = R(1);
    ok('F2 known + new red again alone -> the runner code, only the new one reruns', r.rc === 1 && JSON.stringify(calls()) === '["tests/test_n.py::new"]'
      && r.repeated.length === 1 && r.repeated[0].name === 'tests/test_n.py::new', `${JSON.stringify(r)} calls ${calls()}`);
    ok('F2 the summary counts the known one', /\b1 known red\b/.test(r.text) && /new red, red again alone: tests\/test_n\.py::new/.test(r.text), r.text);
    reset(['tests/test_a.py::t1', 'tests/test_n.py::new'], []);
    r = R(1);
    ok('F2 known + new that is green alone -> exit 0 (flaky)', r.rc === 0 && r.flaky.join() === 'tests/test_n.py::new' && /\b1 known red\b/.test(r.text), JSON.stringify(r));
    reset(['tests/test_a.py::t1', 'tests/test_b.py::t2', 'tests/test_n.py::new'], ['tests/test_n.py::new']);
    r = R(1, Object.assign({}, cfg, { maxReruns: 1 }));
    ok('F3 3 reds > maxReruns 1, 1 new <= 1 -> the rerun goes on', r.rc === 1 && JSON.stringify(calls()) === '["tests/test_n.py::new"]' && !/more than maxReruns/.test(r.text), `${r.text} calls ${calls()}`);
    reset(['tests/test_a.py::t1', 'tests/test_n.py::new'], []);
    r = R(1);
    ok('F6 a known name not red in the log -> named, the code from the reruns unchanged', r.rc === 0 && /known red not red now: tests\/test_b\.py::t2 — remove it from the baseline/.test(r.text), r.text);
  }
  known({ 'tests/test_a.py::t1': 'x' });
  reset(['tests/test_a.py::t1', 'tests/test_n.py::new', 'tests/test_m.py::m'], [], true);
  r = R(1, Object.assign({}, cfg, { maxReruns: 1 }));
  ok('F3 2 new reds > maxReruns 1 after the known one -> nothing reruns, the code stands', r.rc === 1 && !calls().length && /2 new reds, more than maxReruns 1/.test(r.text), r.text);

  known({ 'tests/test_a.py::t1': 'x', 'tests/test_b.py::t2': 'y' });
  reset(['tests/test_a.py::t1', 'tests/test_b.py::t2'], [], false);
  r = R(1);
  ok('F4 no tally, all names known -> the runner code stands, nothing reruns', r.rc === 1 && !calls().length && /no tally/.test(r.text), r.text);

  reset(['tests/test_a.py::t1'], []);
  fs.rmSync(path.join(wt, 'known.json'));
  r = R(1);
  ok('F5 the baseline file is missing -> an error line, the runner code stands, nothing reruns', r.rc === 1 && !calls().length && /guardBaseline known\.json: [^\n]*the runner's exit code 1 stands/.test(r.text), r.text);
  for (const [name, body] of [['not JSON', '{"a": '], ['an array', '["tests/test_a.py::t1"]'], ['a reason that is not a string', '{"tests/test_a.py::t1": 1}']]) {
    known(body); reset(['tests/test_a.py::t1'], []);
    r = R(1);
    ok(`F5 the baseline file is ${name} -> an error line, the runner code stands`, r.rc === 1 && !calls().length && /guardBaseline known\.json: /.test(r.text) && !/\d+ known red/.test(r.text), r.text);
  }
  known({ 'tests/test_b.py::t2': 'y' });
  reset(['x'], []);
  fs.writeFileSync(logf, 'all green\n=== 9 passed in 1.0s ===\n');
  r = R(0);
  ok('F6 a green run with a known red in the baseline -> named, exit 0', r.rc === 0 && /known red not red now: tests\/test_b\.py::t2 — remove it from the baseline/.test(r.text), r.text);
  r = G.rerun({ wt, log: logf, rc: 0, cfg });
  ok('no baseline configured: a green run -> no text, as before', r.rc === 0 && r.text === '', r.text);

  known({ 'tests/test_a.py::t1': 'x' });
  reset(['tests/test_a.py::t1'], []);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'rerun', wt, logf, '1', JSON.stringify(cfg), 'known.json'], { encoding: 'utf8' });
  ok('rerun cli: the baseline as the 6th argument -> exit 0, "1 known red"', cli.status === 0 && /\b1 known red\b/.test(cli.stdout), cli.status + cli.stdout + cli.stderr);

  // --- guards-all.sh end to end: F1 and F7 ---
  if (!zsh) {
    skip('guards-all.sh with guardBaseline', 'zsh not found');
  } else {
    const T = path.join(tmp, 'e2e');
    const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), w = path.join(wts, 'pw');
    for (const d of [bin, shared, w]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    fs.writeFileSync(path.join(T, 'full.log'), log(['tests/test_a.py::t1', 'tests/test_b.py::t2']));
    fs.writeFileSync(path.join(w, 'full.sh'), `#!/bin/sh\necho run >> "${T}/full.count"\ncat "${T}/full.log"\nexit 1\n`);
    fs.writeFileSync(path.join(w, 'one.sh'), `#!/bin/sh\necho "$1" >> "${T}/one.count"\nexit 1\n`);
    for (const f of ['full.sh', 'one.sh']) fs.chmodSync(path.join(w, f), 0o755);
    fs.mkdirSync(path.join(w, 'tests'));
    fs.writeFileSync(path.join(w, 'tests', 'known-red.json'), JSON.stringify({ 'tests/test_a.py::t1': 'BACKLOG #1', 'tests/test_b.py::t2': 'BACKLOG #2' }));
    git(w, 'init', '-q'); git(w, 'add', 'full.sh', 'one.sh', 'tests/known-red.json'); git(w, 'commit', '-q', '-m', 'w');
    const f = path.join(T, 'cfg.json');
    fs.writeFileSync(f, JSON.stringify({ repoDir: path.join(T, 'main'), worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh',
      guardRerun: RERUN, guardBaseline: 'tests/known-red.json', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
    const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env[k];
    const count = (n) => { try { return fs.readFileSync(path.join(T, n), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const ga = (...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 120000 });
    let x = ga('pw');
    ok('F1 guards-all: a red run of known reds only -> exit 0, "2 known red", nothing reruns', x.status === 0 && /\b2 known red\b/.test(x.stdout) && count('one.count') === 0 && count('full.count') === 1,
      `${x.status} ${count('one.count')} ${x.stdout}${x.stderr}`);
    const h = git(w, 'rev-parse', '--short', 'HEAD').stdout.trim();
    x = ga('pw');
    ok('F7 guards-all: the same HEAD after known reds only -> "reused", no new run', x.status === 0 && x.stdout.includes(`reused, HEAD ${h}`) && count('full.count') === 1, `${x.status} ${x.stdout}`);
    fs.writeFileSync(path.join(w, 'tests', 'known-red.json'), JSON.stringify({ 'tests/test_a.py::t1': 'BACKLOG #1' }));
    git(w, 'commit', '-q', '-am', 'fixed b');
    x = ga('pw');
    ok('guards-all: a baseline without the red one -> the runner code (the new red repeats alone)', x.status === 1 && count('full.count') === 2 && count('one.count') === 1 && /\b1 known red\b/.test(x.stdout), `${x.status} ${x.stdout}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
