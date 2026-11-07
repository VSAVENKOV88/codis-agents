#!/usr/bin/env node
'use strict';
// scripts/wait-step.js signals a run only when the meta's (pid, start time) is that run (p-codex-B1-b2a, cells X3, X6,
// X7): a meta naming pid 1, 0, a negative, fractional or string pid, or a live pid that started at another time, gets no
// kill of a group at the deadline and ends done with rc null and an error; a real run past its deadline is still killed
// with its group (rc 124). start does not attach to a meta whose pid is another process, and with --once (the conductor's
// steps folder) a second start of one id refuses unless --reuse. Every wait-step process runs under
// tests/fixtures/chain-run/kill-hook.js (brief G1): a signal is only logged, and only the test's own `sleep` group may
// get a real one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const WS = path.join(__dirname, '..', 'scripts', 'wait-step.js');
const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wait-step-id-')));
const KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow.txt');
fs.writeFileSync(ALLOW, '');
const env = Object.assign({}, process.env, { NODE_OPTIONS: `-r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW });
const ws = (...a) => spawnSync(process.execPath, [WS].concat(a), { encoding: 'utf8', env, timeout: 30000 });
const json = (p) => { try { return JSON.parse(p.stdout); } catch { return null; } };
const kills = () => { try { return fs.readFileSync(KLOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const signals = () => kills().filter((k) => k.sig !== 0 && k.sig !== '0');
const lstartOf = (pid) => { const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return p.status === 0 ? p.stdout.trim() : null; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = (c, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = c(); if (v) return v; sleepMs(50); } return c(); };
const own = [];
process.on('exit', () => { for (const p of own) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- X3: a meta whose pid is not a process of a run, past its deadline
for (const [name, pid] of [['pid 1', 1], ['pid 0', 0], ['a negative pid', -7], ['a fractional pid', 1.5], ['a string pid', '123']]) {
  const id = path.join(W, `x3-${String(name).replace(/\W+/g, '-')}`);
  fs.writeFileSync(`${id}.json`, JSON.stringify({ pid, started: 1, cmd: 'x', cwd: W }));
  fs.writeFileSync(KLOG, '');
  const r = json(ws('wait', '--id', id, '--max', '2', '--deadline', '1'));
  ok(`X3 ${name}, started long ago: wait kills no group and ends done, rc null, with an error`, !!r && r.done === true && r.rc === null && !!r.error && !signals().length,
    JSON.stringify(r) + ' ' + JSON.stringify(kills()));
  ok(`X3 ${name}: no .rc is written for it`, !fs.existsSync(`${id}.rc`));
}

// ---- X6: a live pid that started at another time (a pid reused by another process)
{
  const victim = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  own.push(victim.pid);
  until(() => lstartOf(victim.pid));
  const id = path.join(W, 'x6');
  fs.writeFileSync(`${id}.json`, JSON.stringify({ pid: victim.pid, lstart: 'Thu Jan  1 00:00:00 1970', started: 1, cmd: 'x', cwd: W }));
  fs.writeFileSync(KLOG, '');
  const r = json(ws('wait', '--id', id, '--max', '2', '--deadline', '1'));
  ok('X6 the pid of the meta now belongs to another process: no signal, done with rc null and an error, the process lives',
    !!r && r.done === true && r.rc === null && /not .*this run|not confirmed/.test(r.error || '') && !signals().length && alive(victim.pid), JSON.stringify(r) + ' ' + JSON.stringify(kills()));
  fs.writeFileSync(`${id}.json`, JSON.stringify({ pid: victim.pid, started: 1, cmd: 'x', cwd: W }));
  fs.writeFileSync(KLOG, '');
  const r2 = json(ws('wait', '--id', id, '--max', '2', '--deadline', '1'));
  ok('X6 a meta without a start time: its run cannot be confirmed, no signal', !!r2 && r2.done === true && r2.rc === null && !signals().length && alive(victim.pid), JSON.stringify(r2) + ' ' + JSON.stringify(kills()));
  const id2 = path.join(W, 'x6-attach');
  fs.writeFileSync(`${id2}.json`, JSON.stringify({ pid: victim.pid, lstart: 'Thu Jan  1 00:00:00 1970', started: 1, cmd: 'x', cwd: W }));
  const mark = path.join(W, 'x6-ran');
  const s = json(ws('start', '--id', id2, '--cwd', W, '--', `touch ${mark}`));
  ok('X6 start does not attach to a meta whose pid is another process: the command runs', !!s && s.started === true && s.pid !== victim.pid && until(() => fs.existsSync(mark)), JSON.stringify(s));
  try { process.kill(-victim.pid, 'SIGKILL'); } catch { /* gone */ }
}

// ---- X3: a real run past its deadline is killed with its group, as before
{
  const id = path.join(W, 'real');
  const s = json(ws('start', '--id', id, '--cwd', W, '--', 'sleep 60'));
  own.push(s && s.pid);
  const meta = JSON.parse(fs.readFileSync(`${id}.json`, 'utf8'));
  ok('X6 start writes the start time of the run into its meta', typeof meta.lstart === 'string' && meta.lstart.replace(/\s+/g, ' ') === String(lstartOf(s.pid)).replace(/\s+/g, ' '), JSON.stringify(meta));
  fs.writeFileSync(ALLOW, String(s.pid));
  fs.writeFileSync(KLOG, '');
  sleepMs(1200);
  const r = json(ws('wait', '--id', id, '--max', '5', '--deadline', '1'));
  ok('X3 the meta is the run: past its deadline its group is killed, rc 124', !!r && r.done === true && r.rc === 124 && signals().some((k) => k.pid === -s.pid) && until(() => !alive(s.pid), 5000),
    JSON.stringify(r) + ' ' + JSON.stringify(kills()));
  fs.writeFileSync(ALLOW, '');
}

// ---- X7: one start per id in the steps folder of a run (--once); --reuse keeps the result of the same step
{
  const id = path.join(W, 'once');
  const m1 = path.join(W, 'once-1'), m2 = path.join(W, 'once-2');
  const a = json(ws('start', '--id', id, '--cwd', W, '--once', '--', `touch ${m1}`));
  ok('X7 the first start of an id with --once runs', !!a && a.started === true && until(() => fs.existsSync(`${id}.rc`)), JSON.stringify(a));
  const b = ws('start', '--id', id, '--cwd', W, '--once', '--', `touch ${m2}`);
  sleepMs(300);
  ok('X7 a second start of the same id with --once refuses (exit 64, no JSON) and runs nothing', b.status === 64 && !json(b) && /once/.test(b.stderr) && !fs.existsSync(m2), `${b.status} ${b.stdout} ${b.stderr}`);
  const c = json(ws('start', '--id', id, '--cwd', W, '--once', '--reuse', '--', `touch ${m2}`));
  sleepMs(300);
  ok('X7 ... with --reuse the retry of that step keeps its result', !!c && c.reused === true && c.rc === 0 && !fs.existsSync(m2), JSON.stringify(c));
  const d = json(ws('start', '--id', id, '--cwd', W, '--', `touch ${m2}`));
  ok('X7 without --once (the Workflow) a finished run is archived and started anew, as before', !!d && d.started === true && until(() => fs.existsSync(m2)) && fs.existsSync(`${id}.prev.json`), JSON.stringify(d));
}
done();
