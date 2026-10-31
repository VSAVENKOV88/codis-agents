'use strict';
// tests:quiet - measures overlap of fixture runs and waits for a signal to reach children; other files running skew it
// tests/run.js, the tester's cells next to run-parallel.test.js: a red quiet file, two quiet files never at once, a
// child killed by a signal, SIGTERM to the runner stops its children, no zsh in PATH, an empty CODIS_GUARD_JOBS, a
// broken machine file, the marker of the other language and a longer word are not markers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const RUN = path.join(__dirname, 'run.js');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'run-par-t-'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } });
const LOG = path.join(T, 'times.log');

const body = (name, ms, code, head = '', tail = '') => `${head}'use strict';
const fs = require('fs');
const log = (w) => fs.appendFileSync(process.env.FIX_LOG, ${JSON.stringify(name)} + ' ' + w + ' ' + Date.now() + '\\n');
log('start');
${tail}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
log('end');
console.log(${JSON.stringify(code ? 'something failed' : '1 passed, 0 failed')});
process.exit(${code});
`;
const write = (dir, f, s) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
function readLog() {
  const t = {};
  for (const l of (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter(Boolean)) {
    const [n, w, ts] = l.split(' ');
    (t[n] = t[n] || {})[w] = +ts;
  }
  return t;
}
function run(dir, jobs, envExtra = {}) {
  fs.rmSync(LOG, { force: true });
  const env = { ...process.env, FIX_LOG: LOG, ...envExtra };
  if (jobs === undefined) delete env.CODIS_GUARD_JOBS; else env.CODIS_GUARD_JOBS = String(jobs);
  const r = spawnSync(process.execPath, [RUN, '--dir', dir], { encoding: 'utf8', env, timeout: 60000 });
  return { ...r, t: readLog(), out: (r.stdout || '') + (r.stderr || '') };
}
const order = (out) => [...out.matchAll(/^(?:pass|FAIL|skip) (\S+)/gm)].map((m) => m[1]);
const Q = '#!/usr/bin/env node\n// tests:quiet - timing\n';

(async () => {
  // 1. A red quiet file: named in the tally, exit != 0, still reported after the parallel files.
  {
    const D = path.join(T, 'q-red');
    write(D, 'a.test.js', body('a', 100, 0));
    write(D, 'b-quiet-red.test.js', body('bq', 100, 3, Q));
    write(D, 'c.test.js', body('c', 100, 0));
    const r = run(D, 4);
    ok('t1.1 a red quiet file: exit != 0', r.status !== 0 && r.status !== null, `status ${r.status}`);
    ok('t1.2 a red quiet file: shown with its exit code and output', /FAIL b-quiet-red\.test\.js \([\d.]+ s, exit 3\)\n[\s\S]*something failed/.test(r.out), r.out);
    ok('t1.3 a red quiet file: named in the tally', /2 of 3 test files passed/.test(r.out) && /failed: b-quiet-red\.test\.js/.test(r.out), r.out);
    ok('t1.4 a red quiet file: reported after the parallel files', JSON.stringify(order(r.out)) === JSON.stringify(['a.test.js', 'c.test.js', 'b-quiet-red.test.js']), JSON.stringify(order(r.out)));
  }

  // 2. Two quiet files never run at the same time, whatever CODIS_GUARD_JOBS says.
  {
    const D = path.join(T, 'q-two');
    write(D, 'p.test.js', body('p', 200, 0));
    write(D, 'q1.test.js', body('q1', 700, 0, Q));
    write(D, 'q2.test.js', body('q2', 700, 0, Q));
    const r = run(D, 4);
    const t = r.t;
    ok('t2.1 two quiet files with 4 workers: both ran', t.q1 && t.q1.end && t.q2 && t.q2.end, JSON.stringify(t) + r.out);
    ok('t2.2 two quiet files with 4 workers: they do not overlap', t.q1 && t.q2 && (t.q2.start >= t.q1.end || t.q1.start >= t.q2.end), JSON.stringify(t));
    ok('t2.3 both quiet files start after the parallel file ended', t.p && t.q1 && t.q2 && Math.min(t.q1.start, t.q2.start) >= t.p.end, JSON.stringify(t));
  }

  // 3. A child killed by a signal is red (not green, not a crash of the runner) and named.
  {
    const D = path.join(T, 'sig');
    write(D, 'a.test.js', body('a', 50, 0));
    write(D, 'k.test.js', body('k', 50, 0, '', "process.kill(process.pid, 'SIGKILL');"));
    const r = run(D, 2);
    ok('t3.1 a child killed by SIGKILL: exit != 0', r.status !== 0 && r.status !== null, `status ${r.status}: ${r.out}`);
    ok('t3.2 a child killed by SIGKILL: FAIL with the signal', /FAIL k\.test\.js \([\d.]+ s, exit signal SIGKILL\)/.test(r.out), r.out);
    ok('t3.3 a child killed by SIGKILL: named in the tally', /1 of 2 test files passed/.test(r.out) && /failed: k\.test\.js/.test(r.out), r.out);
  }

  // 4. SIGTERM to the runner stops the files it runs (no orphans), and the runner exits 128+15.
  {
    const D = path.join(T, 'term');
    const pids = path.join(T, 'pids');
    for (const n of ['x', 'y']) {
      write(D, `${n}.test.js`, body(n, 20000, 0, '', `fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');`));
    }
    fs.rmSync(LOG, { force: true });
    const env = { ...process.env, FIX_LOG: LOG, CODIS_GUARD_JOBS: '2' };
    const c = spawn(process.execPath, [RUN, '--dir', D], { env, stdio: 'ignore' });
    const exited = new Promise((res) => c.on('exit', (code, sig) => res({ code, sig })));
    const t0 = Date.now();
    const list = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    while (list().length < 2 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
    const kids = list();
    ok('t4.1 both files started under the runner', kids.length === 2, `pids ${kids}`);
    c.kill('SIGTERM');
    const e = await exited;
    ok('t4.2 SIGTERM: the runner exits 143', e.code === 143, JSON.stringify(e));
    const alive = () => kids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    const t1 = Date.now();
    while (alive().length && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
    const left = alive();
    ok('t4.3 SIGTERM: no file of the runner keeps running', left.length === 0, `alive ${left}`);
    for (const p of left) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }

  // 5. No zsh in PATH: *.test.sh files (quiet or not) are skipped, shown and counted; the *.test.js files still run.
  {
    const D = path.join(T, 'nozsh');
    write(D, 'a.test.js', body('a', 50, 0));
    write(D, 'b.test.sh', '#!/bin/zsh\nprint ok\n');
    write(D, 'c.test.sh', '#!/bin/zsh\n# tests:quiet - slots\nprint ok\n');
    const r = run(D, 2, { PATH: path.join(T, 'empty-bin') });
    ok('t5.1 no zsh: exit 0 (skips are not red)', r.status === 0, `status ${r.status}: ${r.out}`);
    ok('t5.2 no zsh: each *.test.sh has its skip line', /^skip b\.test\.sh \(0\.0 s\) - skipped: zsh not found$/m.test(r.out) && /^skip c\.test\.sh \(0\.0 s\) - skipped: zsh not found$/m.test(r.out), r.out);
    ok('t5.3 no zsh: the tally counts and names the skipped files', /1 of 3 test files passed; 2 skipped: zsh not found \(b\.test\.sh, c\.test\.sh\)/.test(r.out), r.out);
    ok('t5.4 no zsh: the *.test.js file ran', r.t.a && r.t.a.end, JSON.stringify(r.t));
  }

  // 6. An empty CODIS_GUARD_JOBS means "not set" (the default), not a refusal.
  {
    const D = path.join(T, 'empty-j');
    write(D, 'a.test.js', body('a', 50, 0));
    const n = Math.min(os.cpus().length, 6);
    const r = run(D, '');
    ok(`t6.1 CODIS_GUARD_JOBS="": runs with the default min(cpus, 6) = ${n} workers`, r.status === 0 && new RegExp(`\\b${n} workers\\b`).test(r.out), `status ${r.status}: ${r.out}`);
  }

  // 7. A broken machine file (not JSON) does not stop the runner.
  {
    const D = path.join(T, 'bad-m');
    write(D, 'a.test.js', body('a', 50, 0));
    const m = path.join(T, 'bad-machine.json');
    fs.writeFileSync(m, '{ not json');
    const r = run(D, undefined, { CODIS_AGENTS_MACHINE: m });
    ok('t7.1 a broken machine file: the run goes on with at least 1 worker, exit 0', r.status === 0 && /\b[1-9]\d* workers\b/.test(r.out) && r.t.a && r.t.a.end, `status ${r.status}: ${r.out}`);
  }

  // 8. The marker belongs to its language and is a whole word: "# tests:quiet" in a .js, "// tests:quiet" in a .sh
  //    and "// tests:quieter" are not markers (the file runs in the parallel phase).
  {
    const D = path.join(T, 'marks');
    write(D, 'a-long.test.js', body('al', 900, 0));
    write(D, 'b-hash.test.js', body('bh', 100, 0, '// a js file\n/*\n# tests:quiet - in a comment block, not a js marker\n*/\n'));
    write(D, 'c-word.test.js', body('cw', 100, 0, '// tests:quieter - another word\n'));
    write(D, 'z-quiet.test.js', body('zq', 100, 0, Q));
    if (has('zsh')) write(D, 'd-slash.test.sh', `#!/bin/zsh\n// tests:quiet - not a shell comment 2>/dev/null\nzmodload zsh/datetime\nprint -r -- "ds start $(( EPOCHREALTIME * 1000 ))" >> $FIX_LOG\nprint -r -- "ds end $(( EPOCHREALTIME * 1000 ))" >> $FIX_LOG\nprint -r -- '1 passed'\n`);
    const r = run(D, 4);
    const t = r.t;
    ok('t8.1 "# tests:quiet" in a .js is not a marker (runs before the quiet file)', t.bh && t.zq && t.bh.end <= t.zq.start, JSON.stringify(t));
    ok('t8.2 "// tests:quieter" is not a marker (runs before the quiet file)', t.cw && t.zq && t.cw.end <= t.zq.start, JSON.stringify(t));
    ok('t8.3 the non-markers run during the long parallel file', t.al && t.bh && t.cw && t.bh.start < t.al.end && t.cw.start < t.al.end, JSON.stringify(t));
    if (has('zsh')) ok('t8.4 "// tests:quiet" in a .sh is not a marker (runs in the parallel phase)', t.ds && t.al && t.ds.start < t.al.end, JSON.stringify(t) + r.out);
    else skip('t8.4 "// tests:quiet" in a .sh', 'zsh not found');
    ok('t8.5 report order: the four parallel files sorted, the quiet one last', order(r.out).pop() === 'z-quiet.test.js', JSON.stringify(order(r.out)));
  }

  done();
})();
