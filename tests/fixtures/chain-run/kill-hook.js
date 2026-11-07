'use strict';
// Loaded with `node -r` (NODE_OPTIONS) into every process a test of signals runs: no real signal leaves the process
// except signal 0 to a pid or a group other than 1, 0 and -1, and a signal to the group whose leader the test wrote into
// KILL_ALLOW_FILE (its own `sleep`). Every call is appended to KILL_LOG as {pid, sig, by}. A meta naming pid 1, 0 or a
// negative pid therefore never reaches kill(2): kill(-1) would signal every process of the user.
const fs = require('fs');
const real = process.kill.bind(process);
process.kill = function kill(pid, sig) {
  const s = sig === undefined ? 'SIGTERM' : sig;
  try { if (process.env.KILL_LOG) fs.appendFileSync(process.env.KILL_LOG, JSON.stringify({ pid, sig: s, by: process.pid }) + '\n'); } catch { /* the log is the test's */ }
  if (s === 0 || s === '0') {
    if (Number.isInteger(pid) && (pid > 1 || pid < -1)) return real(pid, 0);
    const e = new Error(`kill ${pid === 1 ? 'EPERM' : 'ESRCH'} (kill-hook)`);
    e.code = pid === 1 ? 'EPERM' : 'ESRCH';
    throw e;
  }
  let allow = [];
  try { allow = fs.readFileSync(process.env.KILL_ALLOW_FILE, 'utf8').split(/\s+/).filter(Boolean).map(Number); } catch { /* none */ }
  if (Number.isInteger(pid) && pid < -1 && allow.includes(-pid)) return real(pid, s);
  return true;
};
