#!/usr/bin/env node
'use strict';
// Quarantine of flaky guards (p-train-b1, UC-5; cells of the analysis A1-A9, B1-B6, C1-C6, D1-D5, E1, E2 (runner side),
// E4-E6, F1, F2, G1). A guard red in a full run and green alone is written into the project's quarantine file
// (<sharedDir>/guards-quarantine.json, the flat format of guardBaseline: {"<guard>": "flaky: <log> <sha7>, green alone,
// <date>"}), outside the worktree: the tracked tree stays clean (reuse, the runner, the tester's post-check). Every run
// subtracts guardBaseline and the quarantine; the coordinator moves entries into guardBaseline (quarantine-take) or
// drops them (quarantine-drop). Without guardBaseline the quarantine is off, said in one line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const zsh = has('zsh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const log = (names, tally = true) => names.map((n) => `FAILED ${n} - AssertionError`).join('\n') + '\n' + (tally ? `=== ${names.length} failed, 7 passed in 1.2s ===\n` : '');
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' };
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
const today = () => new Date().toISOString().slice(0, 10);
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function main() {
  const cfg = C.resolve(Object.assign({}, base, { guardRerun: RERUN })).config.guardRerun;
  const wt = path.join(tmp, 'wt'); fs.mkdirSync(wt);
  git(wt, 'init', '-q');
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\necho "$1" >> "${tmp}/calls.txt"\ngrep -qxF -- "$1" "${tmp}/red.txt" && exit 1\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  fs.writeFileSync(path.join(wt, 'known.json'), '{}');
  git(wt, 'add', 'one.sh', 'known.json'); git(wt, 'commit', '-q', '-m', 'w');
  const sha7 = git(wt, 'rev-parse', '--short=7', 'HEAD').stdout.trim();
  const shared = path.join(tmp, 'shared'); fs.mkdirSync(shared);
  const qf = path.join(shared, 'guards-quarantine.json');
  const logf = path.join(shared, 'guards-wt.txt');
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const known = (obj) => fs.writeFileSync(path.join(wt, 'known.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const quar = (obj) => (obj === null ? fs.rmSync(qf, { force: true }) : fs.writeFileSync(qf, typeof obj === 'string' ? obj : JSON.stringify(obj)));
  const reset = (names, red, tally) => { fs.writeFileSync(logf, log(names, tally)); fs.rmSync(path.join(tmp, 'calls.txt'), { force: true });
    fs.writeFileSync(path.join(tmp, 'red.txt'), red.map((x) => x + '\n').join('')); };
  const R = (rc, o = {}) => G.rerun(Object.assign({ wt, log: logf, rc, cfg, baseline: 'known.json', quarantine: qf }, o));

  ok('quarantineFile: <sharedDir>/guards-quarantine.json', typeof G.quarantineFile === 'function' && G.quarantineFile('/s') === path.join('/s', 'guards-quarantine.json'));

  if (!zsh) skip('A/B/C/D cells with reruns', 'zsh not found');
  else {
    // A1 + B6: no quarantine file yet, a new red green alone -> written, exit 0, "quarantined:" named with the file
    known({}); quar(null);
    reset(['t/a.py::f'], []);
    let r = R(1);
    let q = readJ(qf);
    ok('A1/B6 a flaky guard -> written into the quarantine file (created), exit 0', r.rc === 0 && q && Object.keys(q).join() === 't/a.py::f', `${JSON.stringify(q)} ${r.text}`);
    ok('A1/C1 the reason: "flaky: <log> <sha7>, green alone, <date>"', q && q['t/a.py::f'] === `flaky: guards-wt.txt ${sha7}, green alone, ${today()}`, q && q['t/a.py::f']);
    ok('C1 the written file passes readBaseline (flat {name: string})', !G.readBaseline(shared, 'guards-quarantine.json').error);
    ok('A1/F1 "quarantined: G (<file>)" and who commits it into guardBaseline', /quarantined: t\/a\.py::f \([^\n]*guards-quarantine\.json\)[^\n]*coordinator[^\n]*known\.json/.test(r.text), r.text);
    ok('A1 the summary goes into the log too', /quarantined: t\/a\.py::f/.test(fs.readFileSync(logf, 'utf8')));

    // A5 + C2: next run, G red again -> known from the quarantine, not rerun, reason unchanged, no "not red now"
    const before = fs.readFileSync(qf, 'utf8');
    reset(['t/a.py::f'], ['t/a.py::f']);
    r = R(1);
    ok('A5 red again, in the quarantine -> known, nothing reruns, exit 0', r.rc === 0 && !calls().length && /\b1 known red\b/.test(r.text), `${r.text} calls ${calls()}`);
    ok('A5/F1 the known line names the quarantine as its source', /known red \(quarantine [^\n]*guards-quarantine\.json\): t\/a\.py::f — flaky: /.test(r.text), r.text);
    ok('A5 the quarantine file is not rewritten', fs.readFileSync(qf, 'utf8') === before);
    reset(['t/z.py::z'], ['t/z.py::z']);
    r = R(1);
    ok('C2 a quarantined guard not red in a finished run -> no "not red now" line', !/not red now/.test(r.text) && r.rc === 1, r.text);
    reset(['t/z.py::z'], []);
    fs.writeFileSync(logf, 'all green\n=== 9 passed in 1.0s ===\n');
    r = R(0);
    ok('C2 a green run with a quarantined guard -> no text about it, nothing written', !/not red now/.test(r.text) && fs.readFileSync(qf, 'utf8') === before, r.text);

    // C2 for a committed "flaky:" entry, C3 for an ordinary one
    known({ 't/k.py::k': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01', 't/o.py::o': 'BACKLOG #1' });
    r = R(0);
    ok('C2 a "flaky:" entry of guardBaseline not red -> not named', !/not red now: t\/k\.py::k/.test(r.text), r.text);
    ok('C3 an ordinary entry not red -> "known red not red now ... remove it" stays', /known red not red now: t\/o\.py::o — remove it/.test(r.text), r.text);
    // C4: a committed "flaky:" entry red again -> subtracted, exit 0
    reset(['t/k.py::k'], ['t/k.py::k']);
    r = R(1);
    ok('C4 a "flaky:" entry of guardBaseline red again -> known, not rerun, exit 0', r.rc === 0 && !calls().length && /known red \(guardBaseline known\.json\): t\/k\.py::k/.test(r.text), r.text);

    // A2: red again alone -> not written
    known({}); quar({});
    reset(['t/b.py::g'], ['t/b.py::g']);
    r = R(1);
    ok('A2 red again alone -> a new red, not written, the runner code', r.rc === 1 && JSON.stringify(readJ(qf)) === '{}' && /new red, red again alone: t\/b\.py::g/.test(r.text), r.text);
    // A3: one flaky, one repeated -> only the flaky one written, red code
    reset(['t/b.py::g', 't/c.py::h'], ['t/b.py::g']);
    r = R(1);
    ok('A3 flaky + repeated -> only the flaky one written, the runner code', r.rc === 1 && Object.keys(readJ(qf) || {}).join() === 't/c.py::h', `${JSON.stringify(readJ(qf))} ${r.text}`);
    // A4: already in guardBaseline -> subtracted, not written
    known({ 't/d.py::d': 'BACKLOG #2' }); quar({});
    reset(['t/d.py::d'], []);
    r = R(1);
    ok('A4 red, in guardBaseline -> known, not rerun, not written', r.rc === 0 && !calls().length && JSON.stringify(readJ(qf)) === '{}', r.text);
    // same name in both: the reason of the tree wins
    quar({ 't/d.py::d': 'flaky: q' });
    r = R(1);
    ok('A4 a name in both files -> the reason of guardBaseline', /known red \(guardBaseline known\.json\): t\/d\.py::d — BACKLOG #2/.test(r.text), r.text);
    // A6: no tally
    known({}); quar({});
    reset(['t/e.py::e'], [], false);
    r = R(1);
    ok('A6 no tally -> nothing reruns, not written', r.rc === 1 && !calls().length && JSON.stringify(readJ(qf)) === '{}', r.text);
    // A7: more new reds than maxReruns after subtraction
    quar({ 't/q.py::q': 'flaky: x' });
    reset(['t/q.py::q', 't/e.py::e', 't/f.py::f'], []);
    r = R(1, { cfg: Object.assign({}, cfg, { maxReruns: 1 }) });
    ok('A7 2 new reds > maxReruns 1 after the quarantined one -> nothing reruns, not written', r.rc === 1 && !calls().length && Object.keys(readJ(qf)).join() === 't/q.py::q' && /2 new reds, more than maxReruns 1/.test(r.text), r.text);
    // A8: green run -> nothing written
    quar(null);
    fs.writeFileSync(logf, 'all green\n=== 9 passed in 1.0s ===\n');
    r = R(0);
    ok('A8 a green run -> no quarantine file written', r.rc === 0 && !fs.existsSync(qf), r.text);
    // A9: a guard marked guards:exclusive is quarantined like any other (no names, no markers)
    fs.writeFileSync(path.join(wt, 'x-run.js'), '// guards:exclusive — a fixed port\n');
    reset(['x-run.js'], []);
    r = R(1);
    ok('A9 an exclusive guard flaky -> written like any other', r.rc === 0 && Object.keys(readJ(qf) || {}).join() === 'x-run.js', r.text);
    // a guard named after an Object.prototype member: an own key, written and then known
    reset(['__proto__'], []);
    r = R(1);
    ok('A1 a flaky guard named __proto__ -> an own key of the quarantine', Object.keys(readJ(qf) || {}).join() === 'x-run.js,__proto__', fs.readFileSync(qf, 'utf8'));
    reset(['__proto__'], ['__proto__']);
    r = R(1);
    ok('A5 the quarantined __proto__ red again -> known, nothing reruns', r.rc === 0 && !calls().length, r.text);

    // B1: no guardBaseline -> quarantine off: one line, the file neither read nor written
    quar({ 't/q.py::q': 'flaky: x' });
    reset(['t/q.py::q'], []);
    r = R(1, { baseline: '' });
    ok('B1 no guardBaseline: the quarantine is not read (the quarantined one reruns), flaky -> exit 0', r.rc === 0 && JSON.stringify(calls()) === '["t/q.py::q"]', `${r.text} ${calls()}`);
    ok('B1 "quarantine off: no guardBaseline in the project config", nothing written', /quarantine off: no guardBaseline in the project config/.test(r.text) && Object.keys(readJ(qf)).join() === 't/q.py::q', r.text);
    reset(['t/r.py::r'], []);
    r = R(1, { quarantine: '' });
    ok('E2 quarantine path empty (the runner, --no-quarantine) -> "quarantine off" line, nothing written', r.rc === 0 && /quarantine off/.test(r.text) && !readJ(qf)['t/r.py::r'], r.text);
    // B3/B4: broken guardBaseline -> as before, the quarantine not written
    quar({});
    known('{"a": ');
    reset(['t/s.py::s'], []);
    r = R(1);
    ok('B4 broken guardBaseline -> the error line, nothing reruns, not written', r.rc === 1 && !calls().length && JSON.stringify(readJ(qf)) === '{}' && /guardBaseline known\.json: /.test(r.text), r.text);
    fs.rmSync(path.join(wt, 'known.json'));
    r = R(1);
    ok('B3 guardBaseline missing -> the error line, not written', r.rc === 1 && !calls().length && JSON.stringify(readJ(qf)) === '{}', r.text);
    known({});
    // B5: broken quarantine file -> an error line with its path, nothing subtracted/rerun, not rewritten, code stands
    for (const [name, body] of [['not JSON', '{"a": '], ['an array', '["x"]'], ['a reason that is not a string', '{"t/s.py::s": 1}']]) {
      quar(body);
      reset(['t/s.py::s'], []);
      r = R(1);
      ok(`B5 the quarantine file is ${name} -> an error line naming it, nothing reruns, the code stands, not rewritten`,
        r.rc === 1 && !calls().length && /quarantine [^\n]*guards-quarantine\.json: /.test(r.text) && !/\d+ known red/.test(r.text) && fs.readFileSync(qf, 'utf8') === body, r.text);
    }

    // B5 on the write path itself (the file broken between the read and the write): addQuarantine throws, no rewrite
    quar('{"x": ');
    let thrown = '';
    try { G.addQuarantine(qf, { 't/s.py::s': 'flaky: s' }); } catch (e) { thrown = e.message; }
    ok('B5 addQuarantine on a broken file -> throws "broken", the file is not rewritten', /broken/.test(thrown) && fs.readFileSync(qf, 'utf8') === '{"x": ', thrown);

    // C6 + quarantine-drop / quarantine-take (Q2)
    known({}); quar({ 't/u.py::u': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01', 't/v.py::v': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-02' });
    reset(['t/u.py::u'], ['t/u.py::u']);
    r = R(1);
    ok('C6 removed from guardBaseline but still in the quarantine -> still subtracted', r.rc === 0 && !calls().length, r.text);
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), ...a], { encoding: 'utf8' });
    let x = cli('quarantine-drop', qf, 't/u.py::u');
    ok('quarantine-drop: removes the named entry, keeps the others, exit 0', x.status === 0 && Object.keys(readJ(qf) || {}).join() === 't/v.py::v', x.status + x.stdout + x.stderr);
    r = R(1);
    ok('C5/C6 after the drop the red one reruns as a new red', r.rc === 1 && JSON.stringify(calls()) === '["t/u.py::u"]', r.text);
    x = cli('quarantine-drop', qf, 't/nope');
    ok('quarantine-drop: a name not in the file -> exit 1, named, the file unchanged', x.status === 1 && /t\/nope/.test(x.stdout + x.stderr) && Object.keys(readJ(qf)).join() === 't/v.py::v', x.status + x.stdout + x.stderr);
    known({ 't/o.py::o': 'BACKLOG #1' });
    quar({ 't/v.py::v': 'flaky: v', 't/w.py::w': 'flaky: w', 't/o.py::o': 'flaky: o' });
    x = cli('quarantine-take', wt, 'known.json', qf);
    const kb = readJ(path.join(wt, 'known.json'));
    ok('quarantine-take: the entries move into guardBaseline of the worktree, its own entries kept', x.status === 0 && kb && kb['t/v.py::v'] === 'flaky: v' && kb['t/w.py::w'] === 'flaky: w' && kb['t/o.py::o'] === 'BACKLOG #1', `${x.status} ${x.stdout}${x.stderr} ${JSON.stringify(kb)}`);
    ok('quarantine-take: the moved entries leave the quarantine', JSON.stringify(readJ(qf)) === '{}', JSON.stringify(readJ(qf)));
    ok('quarantine-take: says what to commit', /t\/v\.py::v[^\n]*t\/w\.py::w|t\/w\.py::w[^\n]*t\/v\.py::v/.test(x.stdout) && /commit/.test(x.stdout), x.stdout);
    quar({ 't/y.py::y': 'flaky: y', 't/n.py::n': 'flaky: n' });
    x = cli('quarantine-take', wt, 'known.json', qf, 't/y.py::y');
    ok('quarantine-take with names: only those move', x.status === 0 && readJ(path.join(wt, 'known.json'))['t/y.py::y'] && Object.keys(readJ(qf)).join() === 't/n.py::n', x.stdout + x.stderr);
    known('{"a": ');
    x = cli('quarantine-take', wt, 'known.json', qf);
    ok('quarantine-take: a broken guardBaseline -> exit 1, neither file changed', x.status !== 0 && fs.readFileSync(path.join(wt, 'known.json'), 'utf8') === '{"a": ' && Object.keys(readJ(qf)).join() === 't/n.py::n', x.stdout + x.stderr);
    quar('{"x": ');
    known({});
    x = cli('quarantine-take', wt, 'known.json', qf);
    ok('quarantine-take: a broken quarantine -> exit 1, neither file changed', x.status !== 0 && fs.readFileSync(qf, 'utf8') === '{"x": ' && JSON.stringify(readJ(path.join(wt, 'known.json'))) === '{}', x.stdout + x.stderr);

    // D3: the write fails (lock not taken in time; a directory that cannot be written) -> an error line, code unchanged
    known({}); quar({});
    fs.mkdirSync(qf + '.lock');
    process.env.CODIS_QUARANTINE_LOCK_MS = '300';
    reset(['t/l.py::l'], []);
    r = R(1);
    delete process.env.CODIS_QUARANTINE_LOCK_MS;
    fs.rmSync(qf + '.lock', { recursive: true, force: true });
    ok('D3 the lock is not taken in time -> "quarantine not written: ..." with the reason, exit 0 stays (flaky)', r.rc === 0 && /quarantine not written: [^\n]*lock/.test(r.text) && JSON.stringify(readJ(qf)) === '{}', r.text);
    const ro = path.join(tmp, 'ro'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o555);
    reset(['t/l.py::l'], []);
    r = R(1, { quarantine: path.join(ro, 'guards-quarantine.json') });
    fs.chmodSync(ro, 0o755);
    ok('D3 a directory that cannot be written -> "quarantine not written: ...", the code from the reruns stands', r.rc === 0 && /quarantine not written: /.test(r.text) && !fs.existsSync(path.join(ro, 'guards-quarantine.json')), r.text);
    // stale lock (its owner died long ago) is broken
    fs.mkdirSync(qf + '.lock');
    const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(qf + '.lock', old, old);
    reset(['t/m.py::m'], []);
    r = R(1);
    ok('D3 a stale lock (an hour old) is broken -> written', Object.keys(readJ(qf) || {}).join() === 't/m.py::m' && !fs.existsSync(qf + '.lock'), r.text);

    // D2: concurrent writers -> every entry in the file
    quar(null);
    const N = 32;
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
      const p = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'guards-result.js'))}).addQuarantine(${JSON.stringify(qf)}, {"g${i}": "flaky: p${i}"})`], { stdio: 'ignore' });
      p.on('exit', res);
    })));
    q = readJ(qf);
    ok(`D2 ${N} writers at once -> all ${N} entries, the file valid`, q && Object.keys(q).length === N, JSON.stringify(q));
    ok('D2 no temporary or lock files left', fs.readdirSync(shared).filter((f) => f.startsWith('guards-quarantine')).join() === 'guards-quarantine.json', fs.readdirSync(shared).join());
  }

  // --- texts: F2, E2, E4, E6 ---
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const rules = read('rules/multi-agent.md'), readme = read('README.md'), wf = read('workflows/role-chain.js');
  ok('F2 rules: the rerun rule names the quarantine, who moves it into guardBaseline, the flaky one in a selection only in the report',
    /<sharedDir>\/guards-quarantine\.json|guards-quarantine\.json/.test(rules.split('\n').find((l) => /role:rerun/.test(l)) || '') && /quarantine-take/.test(rules));
  ok('F2 README: guardBaseline row names the quarantine', /\| `guardBaseline` \|[^\n]*quarantine/.test(readme));
  ok('F2 README: guards-all.sh row names --no-quarantine', /guards-all\.sh[^\n]*--no-quarantine/.test(readme));
  ok('F2 RULE_LIST rerun names the quarantine', /\['rerun', [^\n]*quarantine/.test(wf));
  ok('F2 the head of guards-result.js describes the quarantine', /quarantine-take/.test(read('scripts/guards-result.js').split('\nconst ')[0]));
  ok('F2 the head of guards-all.sh describes the quarantine', /guards-quarantine\.json/.test(read('scripts/guards-all.sh').split('\nH=')[0]));
  ok('E2 the runner calls its guards-all.sh with --no-quarantine', /'--no-quarantine'/.test(read('scripts/guards-remote-host.js')));
  ok('E4 the local part of a remote run passes the quarantine file to rerun', /G\.rerun\(\{[^\n]*quarantine: /.test(read('scripts/guards-remote.js')));

  // --- guards-all.sh end to end: G1, D1, D5, E1 ---
  if (!zsh) { skip('G1 guards-all.sh with a flaky guard', 'zsh not found'); return; }
  const T = path.join(tmp, 'e2e');
  const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), sh2 = path.join(T, 'shared'), w = path.join(wts, 'pw');
  for (const d of [bin, sh2, w]) fs.mkdirSync(d, { recursive: true });
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
  fs.writeFileSync(path.join(T, 'full.log'), log(['tests/test_f.py::flaky']));
  fs.writeFileSync(path.join(w, 'full.sh'), `#!/bin/sh\necho run >> "${T}/full.count"\ncat "${T}/full.log"\nexit 1\n`);
  fs.writeFileSync(path.join(w, 'one.sh'), `#!/bin/sh\necho "$1" >> "${T}/one.count"\nexit 0\n`);
  for (const f of ['full.sh', 'one.sh']) fs.chmodSync(path.join(w, f), 0o755);
  fs.mkdirSync(path.join(w, 'tests'));
  fs.writeFileSync(path.join(w, 'tests', 'known-red.json'), '{}\n');
  git(w, 'init', '-q'); git(w, 'add', 'full.sh', 'one.sh', 'tests/known-red.json'); git(w, 'commit', '-q', '-m', 'w');
  const f = path.join(T, 'cfg.json');
  const conf = { repoDir: path.join(T, 'main'), worktreeRoot: wts, sharedDir: sh2, guardCommand: 'cd {wt} && ./full.sh',
    guardRerun: RERUN, guardBaseline: 'tests/known-red.json', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } };
  fs.writeFileSync(f, JSON.stringify(conf));
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_QUARANTINE_LOCK_MS']) delete env[k];
  const count = (n) => { try { return fs.readFileSync(path.join(T, n), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const ga = (...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', ...a], { encoding: 'utf8', env, timeout: 120000 });
  const gq = path.join(sh2, 'guards-quarantine.json');
  const h = git(w, 'rev-parse', '--short=7', 'HEAD').stdout.trim();
  let x = ga('pw');
  let q = readJ(gq);
  ok('G1 guards-all: a flaky guard -> exit 0, written into <sharedDir>/guards-quarantine.json', x.status === 0 && q && q['tests/test_f.py::flaky'] === `flaky: guards-pw.txt ${h}, green alone, ${today()}` && count('one.count') === 1,
    `${x.status} ${JSON.stringify(q)} ${x.stdout}${x.stderr}`);
  ok('G1/F1 guards-all prints "quarantined: ..."', /quarantined: tests\/test_f\.py::flaky/.test(x.stdout), x.stdout);
  ok('D1 the tracked tree stays clean, meta cleanEnd true', git(w, 'status', '--porcelain', '--untracked-files=no').stdout.trim() === '' && (readJ(path.join(sh2, 'guards-pw.txt.meta.json')) || {}).cleanEnd === true);
  x = ga('--force', 'pw');
  ok('G1 the next run (--force) -> known red from the quarantine, no rerun, exit 0', x.status === 0 && count('full.count') === 2 && count('one.count') === 1 && /known red \(quarantine [^\n]*\): tests\/test_f\.py::flaky/.test(x.stdout),
    `${x.status} ${count('one.count')} ${x.stdout}${x.stderr}`);
  x = ga('pw');
  ok('D5 the same HEAD, the quarantine unchanged -> reused', x.status === 0 && x.stdout.includes(`reused, HEAD ${h}`) && count('full.count') === 2, x.stdout);
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'quarantine-drop', gq, 'tests/test_f.py::flaky'], { encoding: 'utf8' });
  x = ga('pw');
  ok('D5 the quarantine changed since the green run -> not reused, a full run', count('full.count') === 3 && !x.stdout.includes('reused, HEAD'), `${count('full.count')} ${x.stdout}`);
  // D4: the same project file is read by another worktree's run
  const w2 = path.join(wts, 'pw2'); fs.mkdirSync(w2);
  for (const ff of ['full.sh', 'one.sh']) { fs.copyFileSync(path.join(w, ff), path.join(w2, ff)); fs.chmodSync(path.join(w2, ff), 0o755); }
  fs.mkdirSync(path.join(w2, 'tests')); fs.writeFileSync(path.join(w2, 'tests', 'known-red.json'), '{}\n');
  git(w2, 'init', '-q'); git(w2, 'add', 'full.sh', 'one.sh', 'tests/known-red.json'); git(w2, 'commit', '-q', '-m', 'w2');
  const oneBefore = count('one.count');
  x = ga('pw2');
  ok('D4 a flaky guard written by one worktree is known in another worktree of the project', x.status === 0 && count('one.count') === oneBefore && /known red \(quarantine /.test(x.stdout), `${x.stdout}${x.stderr}`);
  // E2 runner side: --no-quarantine neither reads nor writes
  fs.rmSync(gq, { force: true });
  x = ga('--force', '--no-quarantine', 'pw');
  ok('E2 guards-all --no-quarantine: flaky -> exit 0, nothing written, "quarantine off"', x.status === 0 && !fs.existsSync(gq) && /quarantine off/.test(x.stdout), `${x.status} ${x.stdout}${x.stderr}`);
  // B1 end to end: no guardBaseline key
  fs.writeFileSync(f, JSON.stringify(Object.assign({}, conf, { guardBaseline: undefined })));
  x = ga('--force', 'pw');
  ok('B1 guards-all without guardBaseline: flaky -> exit 0, nothing written, "quarantine off: no guardBaseline"', x.status === 0 && !fs.existsSync(gq) && /quarantine off: no guardBaseline in the project config/.test(x.stdout), `${x.status} ${x.stdout}${x.stderr}`);
}

main().catch((e) => ok('no exception', false, e.stack)).finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); done(); });
