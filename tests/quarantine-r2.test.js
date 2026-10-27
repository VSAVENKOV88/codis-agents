#!/usr/bin/env node
'use strict';
// Quarantine, review 1 of p-train-b1:
//  R1 a relative quarantine path (a relative sharedDir, as in a project config with "sharedDir": "..") is the same file
//     for reading, writing and the rerun: no "no such file in the worktree" for a file that exists.
//  R2 the meta keeps the hash of the quarantine the run read: a quarantine-drop during the single reruns, after the run
//     subtracted the dropped guard, makes the next run on the same HEAD a full run, not "reused" (D5). A run that only
//     added its own flaky guards to an unchanged file stays reusable.
//  R3 breaking a stale lock is not racy: a writer that saw a stale lock never removes a fresh lock another writer took
//     meanwhile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const GR = path.join(ROOT, 'scripts', 'guards-result.js');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-r2-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' };

try {
  const cfg = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardRerun: RERUN }).config.guardRerun;
  // layout: <tmp>/proj/wt (the worktree, cwd of the calls) and <tmp>/proj/q.json -> relative '../q.json'
  const proj = path.join(tmp, 'proj'), wt = path.join(proj, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  git(wt, 'init', '-q');
  // one.sh: green alone; for the name in drop.txt it first drops DROP from the quarantine (another session during the
  // single reruns)
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\nif [ -f "${tmp}/drop.txt" ]; then "${process.execPath}" "${GR}" quarantine-drop "${path.join(proj, 'q.json')}" "$(cat "${tmp}/drop.txt")" >/dev/null 2>&1; rm -f "${tmp}/drop.txt"; fi\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  fs.writeFileSync(path.join(wt, 'known.json'), '{}\n');
  git(wt, 'add', 'one.sh', 'known.json'); git(wt, 'commit', '-q', '-m', 'w');
  const abs = path.join(proj, 'q.json'), rel = '../q.json';
  const logf = path.join(proj, 'guards-wt.txt');
  const node = (args) => spawnSync(process.execPath, [GR, ...args], { cwd: wt, encoding: 'utf8' });

  // --- R1: a relative path, cwd = the worktree ---
  fs.writeFileSync(abs, JSON.stringify({ 't/q.py::q': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01' }));
  let x = spawnSync(process.execPath, ['-e', `const G=require(${JSON.stringify(GR)});process.stdout.write(JSON.stringify(G.readQuarantine(${JSON.stringify(rel)})))`], { cwd: wt, encoding: 'utf8' });
  const rq = (() => { try { return JSON.parse(x.stdout); } catch { return {}; } })();
  ok('R1 readQuarantine("../q.json") from the worktree reads the existing file', rq.known && rq.known['t/q.py::q'] && !rq.error, `${x.stdout}${x.stderr}`);
  x = spawnSync(process.execPath, ['-e', `const G=require(${JSON.stringify(GR)});G.addQuarantine(${JSON.stringify(rel)},{"t/n.py::n":"flaky: r"})`], { cwd: wt, encoding: 'utf8' });
  const q1 = readJ(abs);
  ok('R1 addQuarantine("../q.json") writes into that file, keeping its entry', x.status === 0 && q1 && q1['t/n.py::n'] === 'flaky: r' && q1['t/q.py::q'], `${x.status} ${x.stderr} ${JSON.stringify(q1)}`);
  x = node(['quarantine-drop', rel, 't/n.py::n']);
  ok('R1 quarantine-drop with a relative path', x.status === 0 && !Object.hasOwn(readJ(abs) || {}, 't/n.py::n'), `${x.status} ${x.stdout}${x.stderr}`);
  if (!has('zsh')) skip('R1 rerun / R2 with reruns', 'zsh not found');
  else {
    // the rerun with a relative quarantine: the quarantined guard is subtracted, a new flaky one is written
    fs.writeFileSync(logf, 'FAILED t/q.py::q - E\nFAILED t/f.py::f - E\n=== 2 failed, 7 passed in 1.2s ===\n');
    x = node(['rerun', wt, logf, '1', JSON.stringify(cfg), 'known.json', rel]);
    const q2 = readJ(abs) || {};
    ok('R1 rerun with "../q.json": the quarantined guard subtracted, the flaky one written, exit 0',
      x.status === 0 && /known red \(quarantine [^\n]*\): t\/q\.py::q/.test(x.stdout) && /^flaky: /.test(q2['t/f.py::f'] || '') && !/nothing is subtracted/.test(x.stdout),
      `${x.status} ${x.stdout}${x.stderr} ${JSON.stringify(q2)}`);
    ok('R1 nothing lands next to the worktree under the doubled path', !fs.existsSync(path.join(tmp, 'q.json')));

    // --- R2: the hash the run read ---
    const cmd = 'full';
    const cycle = (logText, drop) => {
      fs.writeFileSync(logf, logText);
      if (drop) fs.writeFileSync(path.join(tmp, 'drop.txt'), drop); else fs.rmSync(path.join(tmp, 'drop.txt'), { force: true });
      G.metaStart(wt, logf, cmd);
      const r = node(['rerun', wt, logf, '1', JSON.stringify(cfg), 'known.json', abs]);
      node(['meta-end', wt, logf, String(r.status), abs]);
      return r;
    };
    // R2a: G in the quarantine, red; N new, green alone; during N's single run G is dropped
    fs.writeFileSync(abs, JSON.stringify({ 't/g.py::g': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01' }));
    let r = cycle('FAILED t/g.py::g - E\nFAILED t/n.py::n - E\n=== 2 failed, 7 passed in 1.2s ===\n', 't/g.py::g');
    const q3 = readJ(abs) || {};
    ok('R2 setup: the run subtracted G, wrote N, ended green; G dropped meanwhile', r.status === 0 && !Object.hasOwn(q3, 't/g.py::g') && Object.hasOwn(q3, 't/n.py::n'), `${r.status} ${r.stdout} ${JSON.stringify(q3)}`);
    let u = G.reusable(wt, logf, cmd, 'local', abs);
    ok('R2 G dropped during the reruns -> the next run is a full run, not reused', !u.reuse && /quarantine/.test(u.reason), JSON.stringify(u));
    // R2b: the same without the drop -> the run that wrote its own flaky guard stays reusable
    fs.writeFileSync(abs, JSON.stringify({ 't/g.py::g': 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01' }));
    r = cycle('FAILED t/g.py::g - E\nFAILED t/n.py::n - E\n=== 2 failed, 7 passed in 1.2s ===\n', '');
    u = G.reusable(wt, logf, cmd, 'local', abs);
    ok('R2 nothing changed meanwhile -> the run that wrote its own flaky guard is reused', r.status === 0 && u.reuse, `${r.status} ${JSON.stringify(u)}`);
    // R2c: a run that only read the quarantine (no write), the file unchanged -> reused
    r = cycle('FAILED t/g.py::g - E\n=== 1 failed, 7 passed in 1.2s ===\n', '');
    u = G.reusable(wt, logf, cmd, 'local', abs);
    ok('R2 a run that only read the quarantine, the file unchanged -> reused', r.status === 0 && u.reuse, `${r.status} ${r.stdout} ${JSON.stringify(u)}`);
  }

  // --- R3: a stale lock seen by two writers ---
  const lf = path.join(proj, 'l.json'), lock = `${lf}.lock`;
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  const realStat = fs.statSync;
  let first = true;
  // between this writer's stat (stale) and its break, another writer breaks the stale lock and takes a fresh one
  fs.statSync = function (p, ...a) {
    const s = realStat.call(fs, p, ...a);
    if (first && p === lock) { first = false; fs.rmdirSync(lock); fs.mkdirSync(lock); }
    return s;
  };
  process.env.CODIS_QUARANTINE_LOCK_MS = '300';
  let err = '';
  try { G.addQuarantine(lf, { 't/l.py::l': 'flaky: l' }); } catch (e) { err = e.message; }
  fs.statSync = realStat;
  delete process.env.CODIS_QUARANTINE_LOCK_MS;
  ok('R3 the fresh lock of the other writer is not removed', fs.existsSync(lock), err);
  ok('R3 the writer did not enter while the other holds the lock (waits, then "was not taken")', !fs.existsSync(lf) && /was not taken/.test(err), `${err} ${fs.existsSync(lf)}`);
  fs.rmSync(lock, { recursive: true, force: true });
  // a stale lock alone is still broken
  fs.mkdirSync(lock); fs.utimesSync(lock, old, old);
  err = '';
  try { G.addQuarantine(lf, { 't/l.py::l': 'flaky: l' }); } catch (e) { err = e.message; }
  ok('R3 a stale lock alone is broken and the entry written', !err && (readJ(lf) || {})['t/l.py::l'] === 'flaky: l' && !fs.existsSync(lock), err);
} catch (e) { ok('no exception', false, e.stack); }
fs.rmSync(tmp, { recursive: true, force: true });
done();
