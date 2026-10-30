'use strict';
// tests:quiet - measures overlap and wall time of fixture runs, which other test files running at the same time skew
// tests/run.js runs the test files in parallel (CODIS_GUARD_JOBS workers), then the files marked quiet one at a time.
// A fixture directory of its own (run.js --dir): two long files, one red, one marked quiet ("// tests:quiet - <reason>"
// at the start of a line), one that only mentions the marker inside a line. Every fixture file appends its start and
// end times to a log, so overlap and order are read from the log, not guessed from the wall clock.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const RUN = path.join(__dirname, 'run.js');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'run-par-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } });
const LOG = path.join(T, 'times.log');

const body = (name, ms, code, head = '') => `${head}'use strict';
const fs = require('fs');
const log = (w) => fs.appendFileSync(process.env.FIX_LOG, ${JSON.stringify(name)} + ' ' + w + ' ' + Date.now() + '\\n');
log('start');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
log('end');
console.log(${JSON.stringify(code ? 'something failed' : '1 passed, 0 failed')});
process.exit(${code});
`;
const write = (dir, f, s) => fs.writeFileSync(path.join(dir, f), s);

function fixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'a-long.test.js', body('a-long', 1500, 0));
  write(dir, 'b-long.test.js', body('b-long', 1500, 0));
  write(dir, 'c-red.test.js', body('c-red', 200, 1));
  write(dir, 'd-quiet.test.js', body('d-quiet', 300, 0, '#!/usr/bin/env node\n// tests:quiet - reads timing, red under load\n'));
  write(dir, 'e-mention.test.js', body('e-mention', 100, 0, "const note = 'a line with // tests:quiet inside is not a marker';\n"));
}

function readLog() {
  const t = {};
  for (const l of (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter(Boolean)) {
    const [n, w, ts] = l.split(' ');
    (t[n] = t[n] || {})[w] = +ts;
  }
  return t;
}

function run(dir, jobs, extra = []) {
  fs.rmSync(LOG, { force: true });
  const env = { ...process.env, FIX_LOG: LOG };
  if (jobs == null) delete env.CODIS_GUARD_JOBS; else env.CODIS_GUARD_JOBS = String(jobs);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RUN, '--dir', dir, ...extra], { encoding: 'utf8', env });
  return { ...r, ms: Date.now() - t0, t: readLog(), out: (r.stdout || '') + (r.stderr || '') };
}

const D = path.join(T, 'fx');
fixture(D);

// 1. Four workers: the parallel phase overlaps, the quiet file runs alone after it, the red one is named, exit != 0.
{
  const r = run(D, 4);
  const t = r.t;
  const all = ['a-long', 'b-long', 'c-red', 'd-quiet', 'e-mention'];
  ok('1.1 every fixture file ran', all.every((n) => t[n] && t[n].start && t[n].end), r.out);
  const par = ['a-long', 'b-long', 'c-red', 'e-mention'];
  ok('1.2 the two long files overlap (parallel phase)', t['a-long'] && t['b-long'] && t['b-long'].start < t['a-long'].end && t['a-long'].start < t['b-long'].end, JSON.stringify(t));
  ok('1.3 the whole run takes less than the sum of the files (1.5+1.5+0.2+0.3+0.1 s)', r.ms < 3300, `${r.ms} ms`);
  const lastEnd = Math.max(...par.filter((n) => t[n]).map((n) => t[n].end));
  ok('1.4 the quiet file starts after every parallel file ended', t['d-quiet'] && t['d-quiet'].start >= lastEnd, JSON.stringify(t));
  ok('1.5 a file that mentions the marker inside a line is not quiet (it runs in the parallel phase)', t['e-mention'] && t['d-quiet'] && t['e-mention'].end <= t['d-quiet'].start, JSON.stringify(t));
  ok('1.6 exit code != 0 when a file is red', r.status !== 0 && r.status !== null, `status ${r.status}`);
  ok('1.7 the red file is shown with its output', /FAIL c-red\.test\.js \([\d.]+ s, exit 1\)\n[\s\S]*something failed/.test(r.out), r.out);
  ok('1.8 the tally counts the files and names the red one', /4 of 5 test files passed/.test(r.out) && /failed: c-red\.test\.js/.test(r.out), r.out);
  const order = [...r.out.matchAll(/^(?:pass|FAIL) (\S+)/gm)].map((m) => m[1]);
  ok('1.9 the report order is stable: the parallel files sorted, then the quiet ones sorted',
    JSON.stringify(order) === JSON.stringify(['a-long.test.js', 'b-long.test.js', 'c-red.test.js', 'e-mention.test.js', 'd-quiet.test.js']), JSON.stringify(order));
  ok('1.10 the phases are announced with the worker count', /4 workers/.test(r.out) && /quiet/.test(r.out), r.out);
}

// 2. One worker: nothing overlaps (the limit holds); the same report order.
{
  const r = run(D, 1);
  const t = r.t;
  ok('2.1 CODIS_GUARD_JOBS=1: the long files do not overlap', t['a-long'] && t['b-long'] && (t['b-long'].start >= t['a-long'].end || t['a-long'].start >= t['b-long'].end), JSON.stringify(t));
  const order = [...r.out.matchAll(/^(?:pass|FAIL) (\S+)/gm)].map((m) => m[1]);
  ok('2.2 CODIS_GUARD_JOBS=1: the same report order', JSON.stringify(order) === JSON.stringify(['a-long.test.js', 'b-long.test.js', 'c-red.test.js', 'e-mention.test.js', 'd-quiet.test.js']), JSON.stringify(order));
  ok('2.3 CODIS_GUARD_JOBS=1: exit != 0', r.status !== 0, `status ${r.status}`);
}

// 3. Two workers bound the parallel phase: the three short-or-long files never run three at a time.
{
  const r = run(D, 2);
  const t = r.t;
  const par = ['a-long', 'b-long', 'c-red', 'e-mention'].filter((n) => t[n]);
  const marks = par.flatMap((n) => [[t[n].start, 1], [t[n].end, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0;
  for (const [, d] of marks) { cur += d; max = Math.max(max, cur); }
  ok('3.1 CODIS_GUARD_JOBS=2: at most two files at a time, and two do overlap', max === 2, `max ${max}`);
}

// 4. A bad CODIS_GUARD_JOBS is refused, not taken as some number.
for (const v of ['0', '-1', 'x', '1.5']) {
  const r = run(D, v);
  ok(`4. CODIS_GUARD_JOBS=${v}: refused with exit 2 and named`, r.status === 2 && /CODIS_GUARD_JOBS/.test(r.out) && !fs.existsSync(LOG), `status ${r.status}: ${r.out.slice(0, 300)}`);
}

// 5. Without CODIS_GUARD_JOBS the default is min(cpus, jobsAlone of the machine file) and is shown.
{
  const m = path.join(T, 'machine.json');
  fs.writeFileSync(m, JSON.stringify({ configVersion: 1, slots: { jobsAlone: 1, jobsShared: 1 } }));
  fs.rmSync(LOG, { force: true });
  const env = { ...process.env, FIX_LOG: LOG, CODIS_AGENTS_MACHINE: m };
  delete env.CODIS_GUARD_JOBS;
  const r = spawnSync(process.execPath, [RUN, '--dir', D], { encoding: 'utf8', env });
  const out = (r.stdout || '') + (r.stderr || '');
  const t = readLog();
  ok('5.1 no CODIS_GUARD_JOBS, machine jobsAlone 1: one worker', /1 workers?\b/.test(out) && t['a-long'] && t['b-long'] && (t['b-long'].start >= t['a-long'].end || t['a-long'].start >= t['b-long'].end), out.slice(0, 400));
  const n = Math.min(os.cpus().length, 6);
  const r2 = run(D, null);
  ok(`5.2 no CODIS_GUARD_JOBS, no machine file: min(cpus, 6) = ${n} workers`, new RegExp(`\\b${n} workers?\\b`).test(r2.out), r2.out.slice(0, 400));
}

// 6. The file filter still applies, and all green -> exit 0.
{
  const r = run(D, 3, ['long', 'quiet']);
  ok('6.1 filter: only the matching files run', Object.keys(r.t).sort().join() === 'a-long,b-long,d-quiet', JSON.stringify(Object.keys(r.t)));
  ok('6.2 filter, all green: exit 0 and "3 of 3 test files passed"', r.status === 0 && /3 of 3 test files passed/.test(r.out), `status ${r.status}: ${r.out}`);
}

// 7. A quiet *.test.sh is marked with "# tests:quiet - <reason>".
if (has('zsh')) {
  const S = path.join(T, 'sh');
  fs.mkdirSync(S);
  write(S, 'a.test.js', body('a', 800, 0));
  write(S, 'b.test.sh', `#!/bin/zsh\n# tests:quiet - slots and timing\nzmodload zsh/datetime\nprint -r -- "b start $(( EPOCHREALTIME * 1000 ))" >> $FIX_LOG\nprint -r -- "b end $(( EPOCHREALTIME * 1000 ))" >> $FIX_LOG\nprint -r -- '1 passed, 0 failed'\n`);
  write(S, 'c.test.js', body('c', 800, 0));
  const r = run(S, 4);
  const t = r.t;
  ok('7.1 a *.test.sh with "# tests:quiet" runs after the parallel files', t.b && t.a && t.c && t.b.start >= Math.max(t.a.end, t.c.end) - 1, JSON.stringify(t) + r.out);
} else skip('7.1 a quiet *.test.sh', 'zsh not found');

// 8. --dir that is not a directory: refused with exit 2, not a stack trace.
{
  const r = run(path.join(T, 'no-such-dir'), 2);
  ok('8.1 --dir of a missing directory: exit 2 and named', r.status === 2 && /is not a directory/.test(r.out), `status ${r.status}: ${r.out.slice(0, 300)}`);
}

done();
