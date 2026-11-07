#!/usr/bin/env node
'use strict';
// A long deterministic step (a full guard run, a stack build and start) run by the workflow between role agents, so an
// expensive role agent does not wait for it by waking up every 270 s (rules/multi-agent.md, "Waiting, context and
// cost"). A cheap service agent runs `start` once and then `wait` again and again; each `wait` blocks at most --max
// seconds (<= 270, under the prompt cache lifetime and far under the 10-minute silence limit), so its few wake-ups cost
// almost nothing. The role that comes next gets the log as a file.
// usage:
//   wait-step.js start --id <prefix> [--cwd <dir>] [--reuse] [--once] -- <shell command>
//     Starts the command detached (its own process group) with sh -c; output -> <prefix>.log, exit code -> <prefix>.rc,
//     pid, its start time (`LC_ALL=C ps -o lstart=`, lstart) and the time in seconds -> <prefix>.json. A run of the same
//     prefix that is still alive is attached to, never doubled: alive means its pid is a process that started at the
//     lstart of the meta (a meta without lstart: the pid exists). A finished run is archived (<prefix>.prev.*) and started
//     anew, unless --reuse: then its result is kept (the repeat of a service agent that ran the step but returned nothing
//     must not run a 40-minute step twice). --once (the conductor's steps folder of a run, where an id names one step):
//     a start without --reuse refuses with exit 64 when any file of the id exists, so a step name is never used twice.
//   wait-step.js wait --id <prefix> [--max <s>] [--deadline <s>]
//     Blocks until the run ends or --max seconds pass (default 270, at most 270). Prints JSON
//     {done, rc, seconds, log, tail, alive, pid, error?}: done=false while it runs, and then alive=true - the process is
//     there, in a slot queue or running: liveness is data, not a guess from the tail (a queue or a 75 repeat may print
//     nothing new for an hour; a cheap waiter once took an unchanged tail for a stall and gave up). A run older than --deadline seconds (default
//     14400) is killed with its process group and ends with rc 124 and an error - only when the meta's pid is above 1 and
//     the process with that pid started at the meta's lstart; otherwise no signal is sent and it ends with rc null and an
//     error (a pid 1 would make kill(-1) signal every process of the user; a reused pid is another process). A meta whose
//     pid is not an integer above 1 ends at once with rc null and an error. A run that vanished without an exit code ends
//     with rc null and an error. Exit code 0 always when JSON was printed (the JSON carries the verdict).
//   wait-step.js watch --log <file> --until <regex> [--pid-file <file>] [--max <s>]
//     For a command a role started itself with Bash run_in_background, whose pid it does not own (a stand `take` that
//     holds the ticket and never ends). Blocks until the log matches --until or --max seconds pass (<= 270), and prints
//     JSON {matched, alive, max, log, tail}: matched=true the moment the line is in the log (not when the process ends),
//     so the role stops waiting on the ticket, not on the end of `take`. With --pid-file (the command writes its pid
//     there) a process that dies before the line ends the wait with matched:false, alive:false. No --deadline, no kill.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
const USAGE = 'usage: wait-step.js start --id <prefix> [--cwd <dir>] [--reuse] [--once] -- <cmd> | wait --id <prefix> [--max <s>] [--deadline <s>] | watch --log <file> --until <regex> [--pid-file <file>] [--max <s>]';
if (!['start', 'wait', 'watch'].includes(mode)) fail(USAGE);
if (mode !== 'watch' && !id) fail(USAGE);
const F = { log: `${id}.log`, rc: `${id}.rc`, meta: `${id}.json` };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const meta = () => { try { return JSON.parse(read(F.meta)); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const rcOf = () => { const s = read(F.rc); if (s === null) return undefined; const n = parseInt(s.trim(), 10); return Number.isFinite(n) ? n : null; };
const tail = (n) => (read(F.log) || '').split('\n').filter((l, i, a) => i < a.length - 1 || l).slice(-n).join('\n');
const now = () => Math.floor(Date.now() / 1000);
// A pid this script may ever pass to kill(2) as -pid: an integer above 1 (0, -1 and 1 name groups of other processes).
const validPid = (pid) => Number.isInteger(pid) && pid > 1;
const normL = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ') : null);
function lstartOf(pid) {
  if (!validPid(pid)) return null;
  const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) });
  return p.status === 0 ? normL(String(p.stdout)) : null;
}
// The run of the meta: its pid with the start time the meta recorded. Without a recorded lstart nothing confirms it.
const ownRun = (m) => !!m && validPid(m.pid) && !!normL(m.lstart) && lstartOf(m.pid) === normL(m.lstart);
// Alive for attach and wait: the pid exists and, when the meta recorded a start time and ps answers, started then.
const running = (m) => {
  if (!m || !validPid(m.pid) || !alive(m.pid)) return false;
  if (!normL(m.lstart)) return true;
  const l = lstartOf(m.pid);
  return l === null || l === normL(m.lstart);
};

if (mode === 'start') {
  if (!cmd) fail('start: no command after --');
  fs.mkdirSync(path.dirname(path.resolve(id)), { recursive: true });
  if (flag('--once') && !flag('--reuse')) {
    const used = Object.values(F).filter((f) => { try { fs.lstatSync(f); return true; } catch { return false; } });
    if (used.length) fail(`start --once: the id ${id} was used already (${used.join(', ')}): one start per step`);
  }
  const m = meta();
  const rc = rcOf();
  if (m && rc === undefined && running(m)) { out({ started: false, attached: true, pid: m.pid, log: F.log }); process.exit(0); }
  if (m && rc !== undefined && flag('--reuse')) { out({ started: false, reused: true, rc, pid: m.pid, log: F.log }); process.exit(0); }
  for (const f of Object.values(F)) { if (fs.existsSync(f)) fs.renameSync(f, f.replace(/(\.\w+)$/, '.prev$1')); }
  // The wrapper writes the exit code through a temporary file, so a reader never sees a half-written .rc.
  const wrap = `( ${cmd} ) > ${q(F.log)} 2>&1; echo $? > ${q(F.rc + '.tmp')}; mv ${q(F.rc + '.tmp')} ${q(F.rc)}`;
  const cwd = opt('--cwd', process.cwd());
  if (!fs.existsSync(cwd)) fail(`start: no directory ${cwd}`);
  const ch = spawn('/bin/sh', ['-c', wrap], { cwd, detached: true, stdio: 'ignore' });
  fs.writeFileSync(F.meta, JSON.stringify({ pid: ch.pid, lstart: lstartOf(ch.pid), started: now(), cmd, cwd }) + '\n');
  ch.unref();
  out({ started: true, pid: ch.pid, log: F.log });
  process.exit(0);
}

function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// watch: follow the log of a command a role started itself with Bash run_in_background (a stand `take` that holds the
// ticket and never ends, a tally line of a full run). The role does not own that process's pid, so watch returns on the
// matched line, not on the process's end: the wait is "the line is here" (`ticket taken by`), not "the process died".
// With --pid-file (the command writes its pid there - `echo $$ > <file>; exec stand.sh take ...`) a process that dies
// before the line ends the wait with matched:false, alive:false, so the role does not loop forever on a dead job.
// No --deadline and no kill: the stand's queue in the hour is normal; --max is clipped to 270 like `wait`.
if (mode === 'watch') {
  const logFile = opt('--log');
  const until = opt('--until');
  if (!logFile || !until) fail(USAGE);
  let re; try { re = new RegExp(until); } catch (e) { fail(`watch: --until is not a valid regex: ${e.message}`); }
  const pidFile = opt('--pid-file');
  const wmax = Math.min(270, Math.max(0, Number(opt('--max', 270)) || 0));
  const pidAlive = () => {
    if (!pidFile) return true;                     // no pid to watch: only the line (and --max) end the wait
    const s = read(pidFile);
    if (s === null || !s.trim()) return true;      // not written yet - treat as still coming up
    const p = parseInt(s.trim(), 10);
    return Number.isFinite(p) ? alive(p) : true;
  };
  const tail3 = () => (read(logFile) || '').split('\n').filter((l, i, a) => i < a.length - 1 || l).slice(-3).join('\n');
  const t0 = Date.now();
  (function tick() {
    const body = read(logFile) || '';
    if (re.test(body)) { out({ matched: true, alive: pidAlive(), max: wmax, log: logFile, tail: tail3() }); return process.exit(0); }
    if (!pidAlive()) { out({ matched: false, alive: false, max: wmax, log: logFile, tail: tail3() }); return process.exit(0); }
    if (Date.now() - t0 >= wmax * 1000) { out({ matched: false, alive: true, max: wmax, log: logFile, tail: tail3() }); return process.exit(0); }
    setTimeout(tick, Math.min(2000, Math.max(50, wmax * 1000 - (Date.now() - t0))));
  })();
}

// wait
if (mode === 'wait') {
  const max = Math.min(270, Math.max(0, Number(opt('--max', 270)) || 0));
  const deadline = Number(opt('--deadline', 14400)) || 14400;
  const m = meta();
  if (!m) { out({ done: true, rc: null, seconds: 0, log: F.log, tail: '', error: `no run with id ${id} (start was not run)` }); process.exit(0); }
  const t0 = Date.now();
  const since = Number.isFinite(m.started) ? m.started : now();
  const finish = (rc, error) => {
    const o = { done: true, rc, seconds: now() - since, log: F.log, tail: tail(25), alive: false };
    if (validPid(m.pid)) o.pid = m.pid;
    if (error) o.error = error;
    out(o); process.exit(0);
  };
  if (!validPid(m.pid)) finish(null, `the meta of ${id} names no process of a run (pid ${JSON.stringify(m.pid)}): nothing to wait for, no signal sent`);
  (function tick() {
    const rc = rcOf();
    if (rc !== undefined) return finish(rc, rc === null ? 'the exit code file is unreadable' : '');
    if (!running(m)) {
      const again = rcOf();          // it may have just finished between the two reads
      if (again !== undefined) return finish(again);
      return finish(null, alive(m.pid) ? `pid ${m.pid} is now another process, not this run (started ${lstartOf(m.pid) || 'unknown'}, the meta recorded ${normL(m.lstart)}): the run ended without an exit code, no signal sent`
        : 'the process ended without an exit code (killed?)');
    }
    if (now() - since > deadline) {
      if (!ownRun(m)) return finish(null, `deadline of ${deadline} s passed, but pid ${m.pid} is not confirmed as this run (its start time is not the ${normL(m.lstart) ? `recorded ${normL(m.lstart)}` : 'one of the meta: none recorded'}): no signal sent`);
      try { process.kill(-m.pid, 'SIGTERM'); } catch { /* already gone */ }
      fs.writeFileSync(F.rc, '124\n');
      return finish(124, `deadline of ${deadline} s passed - the run was killed with its process group`);
    }
    if (Date.now() - t0 >= max * 1000) {
      out({ done: false, rc: null, seconds: now() - since, log: F.log, tail: tail(3), alive: true, pid: m.pid });
      process.exit(0);
    }
    setTimeout(tick, Math.min(2000, Math.max(50, max * 1000 - (Date.now() - t0))));
  })();
}
