#!/usr/bin/env node
'use strict';
// The kill hook of the tests of signals (tests/fixtures/chain-run/kill-hook.js) itself, before any test relies on it
// (p-codex-B1-b2b-2, G24 of the check): a line `=<P>` of KILL_ALLOW_FILE lets through kill(P) only; kill(-P), pid 1, 0
// and -1, a pid not listed and a group not listed are swallowed; a line `<G>` lets through the group -G; signal 0 to a
// pid above 1 is real; every call is in KILL_LOG with its time `at`. What the hook passes on reaches a sentinel loaded
// before it, which records the call and forwards only signal 0 and signals to the test's own `sleep` processes: a broken
// hook makes this test red without any signal reaching pid 1, 0, -1 or a group of the user.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kill-hook-t-')));
const SENT = path.join(W, 'sentinel.js'), REAL = path.join(W, 'real.log'), KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow');
const sleeps = [];
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// A killed `sleep` stays a zombie until this process reaps it (the waits here are synchronous): alive = not Z.
const alive = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && !!r.stdout.trim() && !/^Z/.test(r.stdout.trim()); };
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// The sentinel stands for kill(2): it records what the hook passed on and forwards only what is safe.
fs.writeFileSync(SENT, `'use strict';
const fs = require('fs');
const real = process.kill.bind(process);
const own = String(process.env.SENT_PIDS || '').split(',').filter(Boolean).map(Number);
process.kill = function (pid, sig) {
  fs.appendFileSync(${JSON.stringify(REAL)}, JSON.stringify({ pid, sig: sig === undefined ? 'SIGTERM' : sig }) + '\\n');
  if (sig === 0 && Number.isInteger(pid) && pid > 1) return real(pid, 0);
  if (Number.isInteger(pid) && (own.includes(pid) || own.includes(-pid))) return real(pid, sig);
  return true;
};
`);
const sleep = () => { const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); sleeps.push(c.pid); return c.pid; };
// One child under sentinel + hook that makes the calls of the list, in order.
function calls(list, allow) {
  fs.writeFileSync(ALLOW, allow);
  for (const f of [REAL, KLOG]) try { fs.unlinkSync(f); } catch { /* none */ }
  const src = `for (const [p, s] of ${JSON.stringify(list)}) { try { process.kill(p, s); } catch (e) { console.log('threw', p, s, e.code); } }`;
  return spawnSync(process.execPath, ['-r', SENT, '-r', HOOK, '-e', src], { encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, { NODE_OPTIONS: '', KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW, SENT_PIDS: sleeps.join(',') }) });
}

try {
  const P = sleep(), G = sleep(), Q = sleep();
  sleepMs(200);
  let p = calls([[-P, 'SIGTERM'], [1, 'SIGTERM'], [0, 'SIGTERM'], [-1, 'SIGTERM'], [Q, 'SIGTERM'], [-Q, 'SIGTERM'], [1, 'SIGKILL'], [-1, 'SIGKILL']], `=${P}\n`);
  let real = lines(REAL);
  ok('K1 with only =P: kill(-P), pid 1, 0, -1, an unlisted pid and an unlisted group never reach kill(2)', p.status === 0 && real.length === 0, JSON.stringify(real) + p.stdout + p.stderr);
  ok('K1 ... and the processes live', alive(P) && alive(Q) && alive(G));
  const kl = lines(KLOG);
  ok('K2 every call is in KILL_LOG with pid, sig, by and its time at', kl.length === 8 && kl.every((l) => typeof l.at === 'number' && l.at > 0 && l.by > 1 && 'pid' in l && 'sig' in l), JSON.stringify(kl));
  p = calls([[P, 0], [1, 0], [0, 0], [-1, 0]], '');
  real = lines(REAL);
  ok('K3 signal 0 to a pid above 1 is real, to 1, 0 and -1 it is answered by the hook', real.length === 1 && real[0].pid === P && real[0].sig === 0
    && /threw 1 0 EPERM/.test(p.stdout) && /threw 0 0 ESRCH/.test(p.stdout) && /threw -1 0 ESRCH/.test(p.stdout), JSON.stringify(real) + p.stdout);
  p = calls([[-G, 'SIGTERM']], `${G}\n=1\n=0\n1\n`);
  real = lines(REAL);
  ok('K4 a line <G> lets the group -G through; lines =1, =0 and 1 let nothing through', real.length === 1 && real[0].pid === -G, JSON.stringify(real));
  sleepMs(300);
  ok('K4 ... the group of G got the signal', !alive(G));
  p = calls([[-P, 'SIGTERM'], [P, 'SIGTERM']], `=${P}\n`);
  real = lines(REAL);
  ok('K5 =P: kill(P) is the one call passed on, kill(-P) before it is not', real.length === 1 && real[0].pid === P && real[0].sig === 'SIGTERM', JSON.stringify(real));
  sleepMs(300);
  ok('K5 ... P got it', !alive(P) && alive(Q));
} finally {
  for (const s of sleeps) { try { process.kill(s, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
}
done();
