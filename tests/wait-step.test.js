#!/usr/bin/env node
'use strict';
// scripts/wait-step.js: a long command runs detached; `wait` blocks at most --max seconds and reports JSON; a repeated
// `start` attaches to a live run and never doubles it; --reuse keeps a finished result; a new `start` archives the old
// run; a vanished process and a passed deadline end with an error instead of waiting forever.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const S = path.join(__dirname, '..', 'scripts', 'wait-step.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-step-'));
const ws = (...a) => { const r = spawnSync(process.execPath, [S, ...a], { encoding: 'utf8' }); try { return Object.assign(JSON.parse(r.stdout), { _code: r.status }); } catch { return { _code: r.status, _err: r.stderr }; } };
const id = (n) => path.join(tmp, n);
try {
  let r = ws('start', '--id', id('a'), '--cwd', tmp, '--', 'pwd; echo one; sleep 2; echo two; exit 3');
  ok('start: started, detached, pid recorded', r.started === true && r.pid > 0 && fs.existsSync(id('a') + '.json'), JSON.stringify(r));
  r = ws('wait', '--id', id('a'), '--max', '0');
  ok('wait --max 0 while it runs: done=false', r.done === false && r.rc === null, JSON.stringify(r));
  const again = ws('start', '--id', id('a'), '--', 'echo second');
  ok('start again while it runs: attached, not doubled', again.attached === true && again.started === false, JSON.stringify(again));
  r = ws('wait', '--id', id('a'), '--max', '20');
  ok('wait: done with the command\'s exit code and the tail of its log', r.done === true && r.rc === 3 && /one\ntwo/.test(r.tail) && !/second/.test(r.tail), JSON.stringify(r));
  ok('the command ran in --cwd', r.tail.split('\n')[0] === fs.realpathSync(tmp) || r.tail.split('\n')[0] === tmp, r.tail);
  r = ws('start', '--id', id('a'), '--reuse', '--', 'echo third');
  ok('start --reuse on a finished run: its result is kept', r.reused === true && r.rc === 3, JSON.stringify(r));
  r = ws('start', '--id', id('a'), '--', 'echo fourth');
  ok('start on a finished run: archived and started anew', r.started === true && fs.existsSync(id('a') + '.prev.log'), JSON.stringify(r));
  r = ws('wait', '--id', id('a'), '--max', '20');
  ok('the new run has its own result', r.done === true && r.rc === 0 && r.tail === 'fourth', JSON.stringify(r));

  r = ws('wait', '--id', id('none'));
  ok('wait without start: done with an error, not an endless wait', r.done === true && r.rc === null && /start was not run/.test(r.error), JSON.stringify(r));

  ws('start', '--id', id('k'), '--', 'sleep 30');
  const m = JSON.parse(fs.readFileSync(id('k') + '.json', 'utf8'));
  process.kill(-m.pid, 'SIGKILL');
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) { try { process.kill(m.pid, 0); } catch { break; } }
  r = ws('wait', '--id', id('k'), '--max', '5');
  ok('a killed run: done, rc null, an error', r.done === true && r.rc === null && /without an exit code/.test(r.error || ''), JSON.stringify(r));

  ws('start', '--id', id('d'), '--', 'sleep 30');
  const md = JSON.parse(fs.readFileSync(id('d') + '.json', 'utf8'));
  fs.writeFileSync(id('d') + '.json', JSON.stringify(Object.assign(md, { started: md.started - 100 })));
  r = ws('wait', '--id', id('d'), '--max', '5', '--deadline', '50');
  ok('a run past its deadline: killed, rc 124, an error', r.done === true && r.rc === 124 && /deadline/.test(r.error || ''), JSON.stringify(r));
  let gone = false; const t1 = Date.now();
  while (Date.now() - t1 < 3000) { try { process.kill(md.pid, 0); } catch { gone = true; break; } }
  ok('the deadline kills the process group', gone);

  r = ws('start', '--id', id('x'));
  ok('start without a command: usage error', r._code === 64);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
done();
