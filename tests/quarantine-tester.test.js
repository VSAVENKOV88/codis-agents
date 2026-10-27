#!/usr/bin/env node
'use strict';
// Quarantine of flaky guards (p-train-b1, UC-5), the tester's cells beyond tests/quarantine.test.js:
// T1 a new flaky guard next to a quarantined known one - only the new one written, the old reason kept;
// T2 a quarantine entry that is not "flaky:" and not red - named "not red now" with the quarantine as its source;
// T3 a quarantine path that is a directory - an error line, nothing reruns, the code stands;
// T4 the lock is released after a write and after a refused (broken) file;
// T5-T7 quarantine-take: guardBaseline missing (created), its directory missing (refused, quarantine kept), a baseline
//   in another format {note, checked, known} (refused, both kept);
// T8 reuse and the quarantine hash: a file that appears or disappears after the run is never reused, an unchanged one is;
// T9 usage errors of quarantine-take / quarantine-drop -> 64;
// T10 two flaky guards in one run -> both written, one "quarantined:" line naming both;
// T11 without guardBaseline a broken quarantine is not even read (quarantine off).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-t-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const log = (names) => names.map((n) => `FAILED ${n} - AssertionError`).join('\n') + `\n=== ${names.length} failed, 3 passed in 0.5s ===\n`;
const cfg = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$', maxReruns: 10 };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), ...a], { encoding: 'utf8' });

try {
  const wt = path.join(tmp, 'wt'); fs.mkdirSync(wt);
  git(wt, 'init', '-q');
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\necho "$1" >> "${tmp}/calls.txt"\ngrep -qxF -- "$1" "${tmp}/red.txt" && exit 1\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  fs.writeFileSync(path.join(wt, 'known.json'), '{}\n');
  git(wt, 'add', 'one.sh', 'known.json'); git(wt, 'commit', '-q', '-m', 'w');
  const shared = path.join(tmp, 'shared'); fs.mkdirSync(shared);
  const qf = path.join(shared, 'guards-quarantine.json');
  const logf = path.join(shared, 'guards-wt.txt');
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const reset = (names, red) => { fs.writeFileSync(logf, log(names)); fs.rmSync(path.join(tmp, 'calls.txt'), { force: true });
    fs.writeFileSync(path.join(tmp, 'red.txt'), red.map((x) => x + '\n').join('')); };
  const quar = (o) => (o === null ? fs.rmSync(qf, { recursive: true, force: true }) : fs.writeFileSync(qf, typeof o === 'string' ? o : JSON.stringify(o)));
  const R = (rc, o = {}) => G.rerun(Object.assign({ wt, log: logf, rc, cfg, baseline: 'known.json', quarantine: qf }, o));
  const zsh = has('sh');

  if (!zsh) skip('rerun cells', 'sh not found');
  else {
    // T1
    quar({ 't/old.py::o': 'flaky: guards-x.txt 1111111, green alone, 2026-10-01' });
    reset(['t/old.py::o', 't/new.py::n'], ['t/old.py::o']);
    let r = R(1);
    let q = readJ(qf);
    ok('T1 a new flaky next to a quarantined one -> exit 0, only the new one rerun', r.rc === 0 && JSON.stringify(calls()) === '["t/new.py::n"]', `${r.text} ${calls()}`);
    ok('T1 the old entry keeps its reason, the new one is added', q && q['t/old.py::o'] === 'flaky: guards-x.txt 1111111, green alone, 2026-10-01' && /^flaky: guards-wt\.txt [0-9a-f]{7}, green alone, \d{4}-\d{2}-\d{2}$/.test(q['t/new.py::n'] || ''), JSON.stringify(q));
    ok('T1 "quarantined:" names only the new one; the old one is a known red of the quarantine', /quarantined: t\/new\.py::n \(/.test(r.text) && !/quarantined: [^\n]*t\/old\.py::o/.test(r.text) && /known red \(quarantine [^\n]*\): t\/old\.py::o/.test(r.text), r.text);
    // another run wrote the same name meanwhile (between this run's read and its write): the first reason stays
    const added = G.addQuarantine(qf, { 't/old.py::o': 'flaky: later', 't/n2.py::n': 'flaky: n2' });
    q = readJ(qf);
    ok('T1 addQuarantine of a name already there keeps its reason and returns only the new names', added.join() === 't/n2.py::n' && q['t/old.py::o'] === 'flaky: guards-x.txt 1111111, green alone, 2026-10-01', `${added} ${JSON.stringify(q)}`);

    // T2
    quar({ 't/manual.py::m': 'BACKLOG #9' });
    reset(['t/z.py::z'], ['t/z.py::z']);
    r = R(1);
    ok('T2 a non-"flaky:" quarantine entry not red -> "not red now ... remove it from the quarantine <file>"', /known red not red now: t\/manual\.py::m — remove it from the quarantine [^\n]*guards-quarantine\.json/.test(r.text), r.text);

    // T3
    quar(null); fs.mkdirSync(qf);
    reset(['t/d.py::d'], []);
    r = R(1);
    ok('T3 the quarantine path is a directory -> an error line naming it, nothing reruns, the code stands', r.rc === 1 && !calls().length && /quarantine [^\n]*guards-quarantine\.json: /.test(r.text), r.text);
    quar(null);

    // T10
    quar({});
    reset(['t/a.py::a', 't/b.py::b'], []);
    r = R(1);
    q = readJ(qf);
    ok('T10 two flaky guards in one run -> both written with the same reason', q && Object.keys(q).sort().join() === 't/a.py::a,t/b.py::b' && q['t/a.py::a'] === q['t/b.py::b'], JSON.stringify(q));
    ok('T10 one "quarantined:" line naming both', /quarantined: t\/a\.py::a, t\/b\.py::b \(/.test(r.text), r.text);

    // T11
    quar('{"broken": ');
    reset(['t/c.py::c'], []);
    r = R(1, { baseline: '' });
    ok('T11 no guardBaseline: a broken quarantine is not read - the flaky guard reruns, exit 0, no error about it', r.rc === 0 && JSON.stringify(calls()) === '["t/c.py::c"]' && !/quarantine [^\n]*guards-quarantine\.json: /.test(r.text) && /quarantine off: no guardBaseline/.test(r.text), r.text);
    ok('T11 the broken file is left as it was', fs.readFileSync(qf, 'utf8') === '{"broken": ');
  }

  // T4
  quar('{"broken": ');
  try { G.addQuarantine(qf, { x: 'flaky: x' }); } catch { /* expected */ }
  ok('T4 the lock is released after a refused (broken) file', !fs.existsSync(qf + '.lock'));
  quar({});
  G.addQuarantine(qf, { x: 'flaky: x' });
  ok('T4 the lock is released after a write; no temporary file left', !fs.existsSync(qf + '.lock') && fs.readdirSync(shared).filter((f) => f.startsWith('guards-quarantine')).join() === 'guards-quarantine.json');

  // T5
  fs.rmSync(path.join(wt, 'known.json'));
  quar({ 't/e.py::e': 'flaky: e' });
  let x = cli('quarantine-take', wt, 'known.json', qf);
  ok('T5 quarantine-take with no guardBaseline file -> created with the entry, the quarantine emptied, exit 0', x.status === 0 && (readJ(path.join(wt, 'known.json')) || {})['t/e.py::e'] === 'flaky: e' && JSON.stringify(readJ(qf)) === '{}', x.status + x.stdout + x.stderr);
  ok('T5 the created guardBaseline passes readBaseline', !G.readBaseline(wt, 'known.json').error);

  // T6
  quar({ 't/f.py::f': 'flaky: f' });
  x = cli('quarantine-take', wt, 'no/such/dir/known.json', qf);
  ok('T6 quarantine-take into a directory that does not exist -> exit != 0, the quarantine kept', x.status !== 0 && (readJ(qf) || {})['t/f.py::f'] === 'flaky: f' && !fs.existsSync(qf + '.lock'), x.status + x.stdout + x.stderr);

  // T7
  const other = JSON.stringify({ note: 'n', checked: '2026-10-01', known: { 'a-run.js': 'BACKLOG' } });
  fs.writeFileSync(path.join(wt, 'known.json'), other);
  x = cli('quarantine-take', wt, 'known.json', qf);
  ok('T7 quarantine-take onto a baseline {note, checked, known} -> refused, both files unchanged', x.status !== 0 && fs.readFileSync(path.join(wt, 'known.json'), 'utf8') === other && (readJ(qf) || {})['t/f.py::f'] === 'flaky: f', x.status + x.stdout + x.stderr);
  git(wt, 'checkout', '-q', 'known.json');

  // T8
  const rl = path.join(shared, 'guards-reuse.txt');
  fs.writeFileSync(rl, 'tally\n');
  quar(null);
  G.metaStart(wt, rl, 'CMD'); G.metaEnd(wt, rl, 0, { quarantine: G.quarantineHash(qf) });
  ok('T8 no quarantine file at the end of the run and still none -> reused', G.reusable(wt, rl, 'CMD', 'local', qf).reuse);
  quar({ 'g': 'flaky: g' });
  let u = G.reusable(wt, rl, 'CMD', 'local', qf);
  ok('T8 a quarantine file that appeared after the run -> not reused', !u.reuse && /quarantine/.test(u.reason), u.reason);
  G.metaStart(wt, rl, 'CMD'); G.metaEnd(wt, rl, 0, { quarantine: G.quarantineHash(qf) });
  ok('T8 the same quarantine -> reused', G.reusable(wt, rl, 'CMD', 'local', qf).reuse);
  quar(null);
  u = G.reusable(wt, rl, 'CMD', 'local', qf);
  ok('T8 the quarantine file removed after the run -> not reused', !u.reuse && /quarantine/.test(u.reason), u.reason);
  quar({ 'g': 'flaky: g', 'h': 'flaky: h' });
  ok('T8 an entry added by another run -> not reused', !G.reusable(wt, rl, 'CMD', 'local', qf).reuse);

  // T9
  ok('T9 quarantine-take without its arguments -> 64', cli('quarantine-take', wt).status === 64);
  ok('T9 quarantine-drop without a guard -> 64', cli('quarantine-drop', qf).status === 64);
} catch (e) {
  ok('no exception', false, e.stack);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
