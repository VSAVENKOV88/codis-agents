#!/usr/bin/env node
'use strict';
// Quarantine, tester after review 1 of p-train-b1 (cells beyond quarantine-r2.test.js):
//  U1 quarantine-take with a relative quarantine path from the cwd of the worktree.
//  U3 the hash of the quarantine the run read when the file did not exist yet: the run that created it with its own
//     flaky guard is reused; when another writer created it between the read and the write, the next run is a full run.
//  U5 breaking a stale lock under <file>.lock.break: a stale break lock (a dead breaker) does not block the writer; a
//     fresh break lock (a live breaker) is respected - nothing is removed, the writer waits and gives up; no break lock
//     is left after a break.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const GR = path.join(ROOT, 'scripts', 'guards-result.js');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-tr2-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' };
const F = 'flaky: guards-x.txt abcdef1, green alone, 2026-10-01';

try {
  const cfg = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardRerun: RERUN }).config.guardRerun;
  const proj = path.join(tmp, 'proj'), wt = path.join(proj, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  git(wt, 'init', '-q');
  const abs = path.join(proj, 'q.json'), rel = '../q.json';
  // one.sh: green alone; when other.txt exists it first adds OTHER to the quarantine (another run writing meanwhile)
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\nif [ -f "${tmp}/other.txt" ]; then "${process.execPath}" -e 'require(${JSON.stringify(GR)}).addQuarantine(${JSON.stringify(abs)}, {"t/o.py::o": "flaky: other"})'; rm -f "${tmp}/other.txt"; fi\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  fs.writeFileSync(path.join(wt, 'known.json'), '{}\n');
  git(wt, 'add', 'one.sh', 'known.json'); git(wt, 'commit', '-q', '-m', 'w');
  const node = (args) => spawnSync(process.execPath, [GR, ...args], { cwd: wt, encoding: 'utf8' });

  // --- U1: quarantine-take with a relative path ---
  fs.writeFileSync(abs, JSON.stringify({ 't/q.py::q': F }));
  let x = node(['quarantine-take', wt, 'known.json', rel]);
  ok('U1 quarantine-take "../q.json" from the worktree: moved into guardBaseline, dropped from the quarantine',
    x.status === 0 && (readJ(path.join(wt, 'known.json')) || {})['t/q.py::q'] === F && !Object.hasOwn(readJ(abs) || {}, 't/q.py::q'),
    `${x.status} ${x.stdout}${x.stderr} ${fs.readFileSync(path.join(wt, 'known.json'), 'utf8')} ${fs.existsSync(abs) && fs.readFileSync(abs, 'utf8')}`);
  ok('U1 nothing under the doubled path', !fs.existsSync(path.join(tmp, 'q.json')));
  git(wt, 'checkout', '-q', 'known.json');

  // --- U3: the quarantine did not exist when the run read it ---
  if (!has('zsh')) skip('U3 reruns', 'zsh not found');
  else {
    const logf = path.join(proj, 'guards-wt.txt'), cmd = 'full';
    const cycle = (other) => {
      fs.writeFileSync(logf, 'FAILED t/n.py::n - E\n=== 1 failed, 7 passed in 1.2s ===\n');
      if (other) fs.writeFileSync(path.join(tmp, 'other.txt'), '1'); else fs.rmSync(path.join(tmp, 'other.txt'), { force: true });
      G.metaStart(wt, logf, cmd);
      const r = node(['rerun', wt, logf, '1', JSON.stringify(cfg), 'known.json', abs]);
      node(['meta-end', wt, logf, String(r.status), abs]);
      return r;
    };
    fs.rmSync(abs, { force: true });
    let r = cycle(false);
    let u = G.reusable(wt, logf, cmd, 'local', abs);
    ok('U3 no quarantine at the read, the run wrote its own flaky guard -> the next run is reused',
      r.status === 0 && /^flaky: /.test((readJ(abs) || {})['t/n.py::n'] || '') && u.reuse, `${r.status} ${r.stdout} ${JSON.stringify(u)}`);
    fs.rmSync(abs, { force: true });
    r = cycle(true);
    const q = readJ(abs) || {};
    u = G.reusable(wt, logf, cmd, 'local', abs);
    ok('U3 setup: another writer created the quarantine during the reruns, both entries kept',
      r.status === 0 && q['t/o.py::o'] === 'flaky: other' && /^flaky: /.test(q['t/n.py::n'] || ''), `${r.status} ${r.stdout} ${JSON.stringify(q)}`);
    ok('U3 no quarantine at the read, another writer created it meanwhile -> the next run is a full run, not reused',
      !u.reuse && /quarantine/.test(u.reason), JSON.stringify(u));
  }

  // --- U5: the break lock ---
  const lf = path.join(proj, 'l.json'), lock = `${lf}.lock`, brk = `${lock}.break`;
  const old = new Date(Date.now() - 120000);
  const tryAdd = (ms) => { process.env.CODIS_QUARANTINE_LOCK_MS = String(ms); try { G.addQuarantine(lf, { 't/l.py::l': 'flaky: l' }); return ''; } catch (e) { return e.message; } finally { delete process.env.CODIS_QUARANTINE_LOCK_MS; } };
  // a stale lock and a stale break lock (both writers dead)
  fs.mkdirSync(lock); fs.utimesSync(lock, old, old); fs.mkdirSync(brk); fs.utimesSync(brk, old, old);
  let err = tryAdd(3000);
  ok('U5 a stale lock and a stale break lock (dead breaker): the entry is written', !err && (readJ(lf) || {})['t/l.py::l'] === 'flaky: l', err);
  ok('U5 after it neither the lock nor the break lock is left', !fs.existsSync(lock) && !fs.existsSync(brk), `${fs.existsSync(lock)} ${fs.existsSync(brk)}`);
  fs.rmSync(lf, { force: true });
  // a stale lock and a fresh break lock (a live breaker at work)
  fs.mkdirSync(lock); fs.utimesSync(lock, old, old); fs.mkdirSync(brk);
  err = tryAdd(400);
  ok('U5 a fresh break lock: the writer does not break the lock itself and gives up ("was not taken")', /was not taken/.test(err) && !fs.existsSync(lf), `${err} ${fs.existsSync(lf)}`);
  ok('U5 the fresh break lock and the lock it guards are left alone', fs.existsSync(brk) && fs.existsSync(lock), `${fs.existsSync(lock)} ${fs.existsSync(brk)}`);
  fs.rmSync(brk, { recursive: true, force: true }); fs.rmSync(lock, { recursive: true, force: true });
  // a stale lock alone: broken, and no break lock remains
  fs.mkdirSync(lock); fs.utimesSync(lock, old, old);
  err = tryAdd(3000);
  ok('U5 a stale lock alone: written, no break lock left behind', !err && (readJ(lf) || {})['t/l.py::l'] === 'flaky: l' && !fs.existsSync(brk) && !fs.existsSync(lock), err);
} catch (e) { ok('no exception', false, e.stack); }
fs.rmSync(tmp, { recursive: true, force: true });
done();
