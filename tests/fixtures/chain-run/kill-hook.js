'use strict';
// Loaded with `node -r` (NODE_OPTIONS) into every process a test of signals runs: no real signal leaves the process
// except signal 0 to a pid or a group other than 1, 0 and -1; a signal to the group whose leader is a line `<pid>` of
// KILL_ALLOW_FILE (a test's own `sleep`, the group of a fake role); a signal to the positive pid of a line `=<pid>` (a
// conductor whose stop a test checks). Every call is appended to KILL_LOG as {pid, sig, by, at} (at: Date.now() ms). A
// meta naming pid 1, 0 or a negative pid therefore never reaches kill(2): kill(-1) would signal every process of the
// user, and `=<pid>` never lets the group -<pid> through. tests/kill-hook.test.js checks this file.
const fs = require('fs');
const real = process.kill.bind(process);
process.kill = function kill(pid, sig) {
  const s = sig === undefined ? 'SIGTERM' : sig;
  try { if (process.env.KILL_LOG) fs.appendFileSync(process.env.KILL_LOG, JSON.stringify({ pid, sig: s, by: process.pid, at: Date.now() }) + '\n'); } catch { /* the log is the test's */ }
  if (s === 0 || s === '0') {
    if (Number.isInteger(pid) && (pid > 1 || pid < -1)) return real(pid, 0);
    const e = new Error(`kill ${pid === 1 ? 'EPERM' : 'ESRCH'} (kill-hook)`);
    e.code = pid === 1 ? 'EPERM' : 'ESRCH';
    throw e;
  }
  let lines = [];
  try { lines = fs.readFileSync(process.env.KILL_ALLOW_FILE, 'utf8').split(/\s+/).filter(Boolean); } catch { /* none */ }
  const groups = lines.filter((l) => /^\d+$/.test(l)).map(Number).filter((n) => n > 1);
  const pids = lines.filter((l) => /^=\d+$/.test(l)).map((l) => +l.slice(1)).filter((n) => n > 1);
  if (Number.isInteger(pid) && pid < -1 && groups.includes(-pid)) return real(pid, s);
  if (Number.isInteger(pid) && pid > 1 && pids.includes(pid)) return real(pid, s);
  return true;
};
