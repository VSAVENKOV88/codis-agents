#!/usr/bin/env node
'use strict';
// A long deterministic step (a full guard run, a stack build and start) run by the workflow between role agents, so an
// expensive role agent does not wait for it by waking up every 270 s (rules/multi-agent.md, "Waiting, context and
// cost"). A cheap service agent runs `start` once and then `wait` again and again; each `wait` blocks at most --max
// seconds (<= 270, under the prompt cache lifetime and far under the 10-minute silence limit), so its few wake-ups cost
// almost nothing. The role that comes next gets the log as a file.
// usage:
//   wait-step.js start --id <prefix> [--cwd <dir>] [--reuse] -- <shell command>
//     Starts the command detached (its own process group) with sh -c; output -> <prefix>.log, exit code -> <prefix>.rc,
//     pid and start time -> <prefix>.json. A run of the same prefix that is still alive is attached to, never doubled.
//     A finished run is archived (<prefix>.prev.*) and started anew, unless --reuse: then its result is kept (the
//     repeat of a service agent that ran the step but returned nothing must not run a 40-minute step twice).
//   wait-step.js wait --id <prefix> [--max <s>] [--deadline <s>]
//     Blocks until the run ends or --max seconds pass (default 270, at most 270). Prints JSON
//     {done, rc, seconds, log, tail, error?}: done=false while it runs. A run older than --deadline seconds (default
//     14400) is killed with its process group and ends with rc 124 and an error. A run that vanished without an exit
//     code ends with rc null and an error. Exit code 0 always when JSON was printed (the JSON carries the verdict).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const mode = argv[0];
const sep = argv.indexOf('--');
const opts = sep >= 0 ? argv.slice(1, sep) : argv.slice(1);
const cmd = sep >= 0 ? argv.slice(sep + 1).join(' ') : '';
const opt = (k, d) => { const i = opts.indexOf(k); return i >= 0 && i + 1 < opts.length ? opts[i + 1] : d; };
const flag = (k) => opts.includes(k);
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const fail = (m) => { process.stderr.write(`wait-step: ${m}\n`); process.exit(64); };

const id = opt('--id');
if (!['start', 'wait'].includes(mode) || !id) fail('usage: wait-step.js start --id <prefix> [--cwd <dir>] [--reuse] -- <cmd> | wait --id <prefix> [--max <s>] [--deadline <s>]');
const F = { log: `${id}.log`, rc: `${id}.rc`, meta: `${id}.json` };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const meta = () => { try { return JSON.parse(read(F.meta)); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const rcOf = () => { const s = read(F.rc); if (s === null) return undefined; const n = parseInt(s.trim(), 10); return Number.isFinite(n) ? n : null; };
const tail = (n) => (read(F.log) || '').split('\n').filter((l, i, a) => i < a.length - 1 || l).slice(-n).join('\n');
const now = () => Math.floor(Date.now() / 1000);

if (mode === 'start') {
  if (!cmd) fail('start: no command after --');
  fs.mkdirSync(path.dirname(path.resolve(id)), { recursive: true });
  const m = meta();
  const rc = rcOf();
  if (m && rc === undefined && alive(m.pid)) { out({ started: false, attached: true, pid: m.pid, log: F.log }); process.exit(0); }
  if (m && rc !== undefined && flag('--reuse')) { out({ started: false, reused: true, rc, log: F.log }); process.exit(0); }
  for (const f of Object.values(F)) { if (fs.existsSync(f)) fs.renameSync(f, f.replace(/(\.\w+)$/, '.prev$1')); }
  // The wrapper writes the exit code through a temporary file, so a reader never sees a half-written .rc.
  const wrap = `( ${cmd} ) > ${q(F.log)} 2>&1; echo $? > ${q(F.rc + '.tmp')}; mv ${q(F.rc + '.tmp')} ${q(F.rc)}`;
  const cwd = opt('--cwd', process.cwd());
  if (!fs.existsSync(cwd)) fail(`start: no directory ${cwd}`);
  const ch = spawn('/bin/sh', ['-c', wrap], { cwd, detached: true, stdio: 'ignore' });
  fs.writeFileSync(F.meta, JSON.stringify({ pid: ch.pid, started: now(), cmd, cwd }) + '\n');
  ch.unref();
  out({ started: true, pid: ch.pid, log: F.log });
  process.exit(0);
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// wait
const max = Math.min(270, Math.max(0, Number(opt('--max', 270)) || 0));
const deadline = Number(opt('--deadline', 14400)) || 14400;
const m = meta();
if (!m) { out({ done: true, rc: null, seconds: 0, log: F.log, tail: '', error: `no run with id ${id} (start was not run)` }); process.exit(0); }
const t0 = Date.now();
const finish = (rc, error) => {
  const o = { done: true, rc, seconds: now() - m.started, log: F.log, tail: tail(25) };
  if (error) o.error = error;
  out(o); process.exit(0);
};
(function tick() {
  const rc = rcOf();
  if (rc !== undefined) return finish(rc, rc === null ? 'the exit code file is unreadable' : '');
  if (!alive(m.pid)) {
    const again = rcOf();          // it may have just finished between the two reads
    return again !== undefined ? finish(again) : finish(null, 'the process ended without an exit code (killed?)');
  }
  if (now() - m.started > deadline) {
    try { process.kill(-m.pid, 'SIGTERM'); } catch { /* already gone */ }
    fs.writeFileSync(F.rc, '124\n');
    return finish(124, `deadline of ${deadline} s passed - the run was killed with its process group`);
  }
  if (Date.now() - t0 >= max * 1000) {
    out({ done: false, rc: null, seconds: now() - m.started, log: F.log, tail: tail(3) });
    process.exit(0);
  }
  setTimeout(tick, Math.min(2000, Math.max(50, max * 1000 - (Date.now() - t0))));
})();
