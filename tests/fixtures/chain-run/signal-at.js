'use strict';
// Loaded with `node -r` before kill-hook.js into the processes of the tests of `chain-run.js stop`; it acts only in the
// conductor (`chain-run.js run <folder>`). At a moment the test names it sends a signal to the conductor's own pid -
// never to another pid or a group - or makes a rename fail:
//   SIGNAL_AT_RENAME=<regex>  after a fs.renameSync whose target matches;
//   SIGNAL_AT_WRITE=<regex>   after a fs.writeSync whose text matches (a journal line, a log line);
//   SIGNAL_AT_N=<n>           the n-th match fires (default 1); SIGNAL_SIG the signal (default SIGTERM);
//   FAIL_RENAME=<regex>       a fs.renameSync whose target matches throws EIO and renames nothing.
// The real process.kill is taken here, before kill-hook.js replaces it, so the signal needs no line in KILL_ALLOW_FILE.
const fs = require('fs');

if (/chain-run\.js$/.test(process.argv[1] || '') && process.argv[2] === 'run') {
  const realKill = process.kill.bind(process);
  const re = (k) => (process.env[k] ? new RegExp(process.env[k]) : null);
  const onRename = re('SIGNAL_AT_RENAME'), onWrite = re('SIGNAL_AT_WRITE'), failRename = re('FAIL_RENAME');
  const want = +(process.env.SIGNAL_AT_N || 1);
  let n = 0;
  const fire = () => { if (++n === want && process.pid > 1) realKill(process.pid, process.env.SIGNAL_SIG || 'SIGTERM'); };
  const rename = fs.renameSync;
  fs.renameSync = function renameSync(a, b) {
    if (failRename && failRename.test(String(b))) { const e = new Error(`EIO: rename to ${b} refused by signal-at.js`); e.code = 'EIO'; throw e; }
    const r = rename.call(fs, a, b);
    if (onRename && onRename.test(String(b))) fire();
    return r;
  };
  const write = fs.writeSync;
  fs.writeSync = function writeSync(fd, data, ...rest) {
    const r = write.call(fs, fd, data, ...rest);
    if (onWrite && onWrite.test(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '')) fire();
    return r;
  };
}
