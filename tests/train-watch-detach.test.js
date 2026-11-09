#!/usr/bin/env node
'use strict';
// `train.js watch --detach` starts the coordinator's background wait as a process of its own session with its output in
// a log, records it in <sharedDir>/train/watches/<pid>.json {pid, procStart, log, at}, prints one JSON line {pid, log}
// and exits 0 at once. The coordinator on Codex runs in a sandbox that cannot see a process outside it (kill -0 and ps
// answer "Operation not permitted"), so train.js status, run under its own rule, tells it what became of the watch.
//   D1 exit 0 at once with {pid, log}; the log lies under <sharedDir>/train/logs/
//   D2 the pid is alive after the starter has exited, in a session and process group of its own (pid = pgid = sid)
//   D3 the pid runs `train.js watch` with the other arguments (--poll) and without --detach; status answers while it runs
//   D5 status names the live detached watch and its log
//   D6 a second --detach while it lives returns that watch ({pid, log, running: true}) and starts no other
//   D4 the watch's output goes to the log: on a new verdict without an addressee it writes {orphans} there and exits
//   D7 status names the ended watch with its event
//   D8 a detached watch killed without an event (SIGKILL) is named "gone without an event"; a new --detach starts a new
//      watch and drops the records of the watches that are no longer alive
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-detach-')));
const main = path.join(T, 'main'), shared = path.join(T, 'shared');
fs.mkdirSync(main, { recursive: true });
fs.mkdirSync(shared, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'main', main]);
spawnSync('git', ['-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: path.join(T, 'wts'), sharedDir: shared, protectedBranches: ['main'],
  guardCommand: 'cd {wt} && true', worktreeSetup: { scan: [], skip: [], link: [] }, slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_TRAIN_POLL: '0.2' });
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 30000 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ps = (pid, f) => (spawnSync('ps', ['-o', `${f}=`, '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).stdout || '').trim();
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
let pid = 0;
try {
  const t0 = Date.now();
  const r = tr('watch', '--detach', '--poll', '0.2');
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* none */ }
  ok('D1 watch --detach exits 0 at once with one JSON line {pid, log}', r.status === 0 && j && Number.isInteger(j.pid) && j.pid > 1 && typeof j.log === 'string' && Date.now() - t0 < 15000,
    `${r.status} ${r.stdout} ${r.stderr}`);
  pid = j && j.pid;
  ok('D1 the log lies under <sharedDir>/train/logs/ and exists', !!j && path.dirname(j.log) === path.join(shared, 'train', 'logs') && fs.existsSync(j.log), j && j.log);
  ok('D2 the watch is alive after the starter has exited', !!pid && alive(pid), String(pid));
  ok('D2 its own session and process group (pgid = pid)', !!pid && ps(pid, 'pgid') === String(pid), `pgid ${pid && ps(pid, 'pgid')}`);
  const args = pid ? ps(pid, 'args') : '';
  ok('D3 the detached process runs train.js watch --poll 0.2 without --detach', /train\.js watch --poll 0\.2$/.test(args) && !/--detach/.test(args), args);
  const st = tr('status');
  ok('D3 status answers while the detached watch runs', st.status === 0 && /^halt: none/m.test(st.stdout), st.stdout);
  const st5 = tr('status');
  ok('D5 status names the live detached watch and its log', new RegExp(`^detached watch pid ${pid} alive, log ${j && j.log}$`, 'm').test(st5.stdout), st5.stdout);
  const r6 = tr('watch', '--detach', '--poll', '0.2');
  let j6 = null;
  try { j6 = JSON.parse(r6.stdout.trim().split('\n').pop()); } catch { /* none */ }
  ok('D6 a second --detach while it lives returns that watch and starts no other', r6.status === 0 && j6 && j6.pid === pid && j6.running === true && j && j6.log === j.log
    && ls(path.join(shared, 'train', 'watches')).length === 1, `${r6.status} ${r6.stdout} ${r6.stderr}`);
  if (j6 && j6.pid && j6.pid !== pid) { try { process.kill(j6.pid, 'SIGKILL'); } catch { /* gone */ } }
  // D4: a verdict without an addressee that comes after the start ends the watch, its JSON in the log
  const res = path.join(shared, 'train', 'result'), wd = path.join(shared, 'train', 'waiters');
  fs.mkdirSync(res, { recursive: true }); fs.mkdirSync(wd, { recursive: true });
  const head = 'a'.repeat(40);
  fs.writeFileSync(path.join(res, `k1-${head}.json`), JSON.stringify({ verdict: 'red', task: 'k1', branch: 'b-k1', head, base: 'arc', train: 't1' }));
  fs.writeFileSync(path.join(wd, `k1-${head}-999999.json`), JSON.stringify({ pid: 999999, procStart: 1, state: 'left', at: new Date().toISOString() }));
  for (let i = 0; i < 100 && alive(pid); i++) sleep(100);
  const log = j ? fs.readFileSync(j.log, 'utf8') : '';
  ok('D4 a new verdict without an addressee ends the detached watch; {orphans} is in its log', !alive(pid) && /"orphans"/.test(log) && /k1/.test(log), `${alive(pid)} ${log}`);
  const st7 = tr('status');
  ok('D7 status names the ended watch with its event', new RegExp(`^detached watch pid ${pid} ended: orphans k1 ${head}, log `, 'm').test(st7.stdout), st7.stdout);
  const r8 = tr('watch', '--detach', '--poll', '0.2');
  let j8 = null;
  try { j8 = JSON.parse(r8.stdout.trim().split('\n').pop()); } catch { /* none */ }
  const pid8 = j8 && j8.pid;
  ok('D8 a new --detach after the end starts a new watch and drops the record of the ended one', r8.status === 0 && !!pid8 && pid8 !== pid && alive(pid8) && !j8.running
    && JSON.stringify(ls(path.join(shared, 'train', 'watches'))) === JSON.stringify([`${pid8}.json`]), `${r8.stdout} ${r8.stderr}`);
  if (pid8) { try { process.kill(pid8, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 50 && pid8 && alive(pid8); i++) sleep(100);
  const st8 = tr('status');
  ok('D8 a watch killed without an event is "gone without an event"', new RegExp(`^detached watch pid ${pid8} gone without an event, log .*: start it again with train\\.js watch --detach$`, 'm').test(st8.stdout), st8.stdout);
} finally {
  if (pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  fs.rmSync(T, { recursive: true, force: true });
}
done();
