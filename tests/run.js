#!/usr/bin/env node
'use strict';
// Runs every test: tests/*.test.js with node, tests/*.test.sh with zsh; each is judged by its exit code.
// Two phases: first every file not marked quiet, in parallel with a limit of workers; then the quiet files, one at a
// time with nothing else running. A file is quiet when one of its lines starts with "// tests:quiet - <reason>" (a .js
// file) or "# tests:quiet - <reason>" (a .sh file): tests of slots, locks, queues and time that turn red under load.
// Workers: CODIS_GUARD_JOBS (a positive integer; the plugin's own guardCommand passes {jobs} in it), else the smaller
// of the CPU count and slots.jobsAlone of the machine file (scripts/config.js#loadMachine, its default without a file).
// The report keeps a stable order: the parallel files sorted by name, then the quiet ones sorted, each line printed as
// soon as the files before it are done.
// Without zsh in PATH (a Linux box, a CI image) the *.test.sh files are skipped and the *.test.js files skip their zsh
// checks; every skip is shown in the file's line and in the final tally, never silently.
// usage: node tests/run.js [--dir <test dir>] [substring...]   (filter by file name; --dir is for the runner's own test)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// The machine file is read before ./lib, which points XDG_CONFIG_HOME at an empty directory for every test.
const machineJobs = (() => {
  try { return require('../scripts/config').loadMachine(process.env).values.slots.jobsAlone; } catch { return 6; }
})();
const { has } = require('./lib');

const argv = process.argv.slice(2);
let dir = __dirname;
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') dir = path.resolve(argv[++i] || '.');
  else filters.push(argv[i]);
}
const J = process.env.CODIS_GUARD_JOBS;
if (J != null && J !== '' && !/^[1-9]\d*$/.test(J)) {
  console.error(`tests/run.js: CODIS_GUARD_JOBS must be a positive integer, got ${JSON.stringify(J)}`);
  process.exit(2);
}
const jobs = J ? +J : Math.max(1, Math.min(os.cpus().length || 1, machineJobs || 1));

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`tests/run.js: --dir ${JSON.stringify(dir)} is not a directory`);
  process.exit(2);
}
const files = fs.readdirSync(dir).filter((f) => /\.test\.(js|sh)$/.test(f))
  .filter((f) => !filters.length || filters.some((s) => f.includes(s))).sort();
const isQuiet = (f) => (f.endsWith('.sh') ? /^# tests:quiet(\s|$)/m : /^\/\/ tests:quiet(\s|$)/m)
  .test(fs.readFileSync(path.join(dir, f), 'utf8'));
const quiet = files.filter(isQuiet), loud = files.filter((f) => !quiet.includes(f));
const reportOrder = [...loud, ...quiet];
const failed = [], skipped = [], partial = [];
const zsh = has('zsh');
const live = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    for (const c of live) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
    process.exit(128 + os.constants.signals[sig]);
  });
}

// One file -> a promise of its report line(s); records the verdict in failed / skipped / partial.
function runFile(f) {
  if (f.endsWith('.sh') && !zsh) { skipped.push(f); return Promise.resolve(`skip ${f} (0.0 s) - skipped: zsh not found`); }
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '', done = false;
    const c = spawn(f.endsWith('.sh') ? 'zsh' : process.execPath, [path.join(dir, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(c);
    c.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    c.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    const finish = (status, extra = '') => {
      if (done) return;
      done = true;
      live.delete(c);
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      const last = (out.trim().split('\n').pop() || '').trim();
      if (status === 0 && /skipped: /.test(last)) partial.push(f);
      if (status === 0) resolve(`pass ${f} (${s} s) - ${last}`);
      else { failed.push(f); resolve(`FAIL ${f} (${s} s, exit ${status})\n${out}${err}${extra}`); }
    };
    c.on('error', (e) => finish(null, `\n${e.message}\n`));
    c.on('close', (code, sig) => finish(code === null ? `signal ${sig}` : code));
  });
}

// Runs the files with at most n at a time and prints their lines in the files' order as they become ready.
async function phase(list, n) {
  const lines = [];
  let next = 0, printed = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      lines[i] = await runFile(list[i]);
      while (printed < list.length && lines[printed] !== undefined) console.log(lines[printed++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
}

(async () => {
  const t0 = Date.now();
  console.log(`parallel phase: ${loud.length} files, ${jobs} workers`);
  await phase(loud, jobs);
  if (quiet.length) {
    console.log(`quiet phase: ${quiet.length} files, one at a time (${quiet.join(', ')})`);
    await phase(quiet, 1);
  }
  const byReport = (l) => reportOrder.filter((f) => l.includes(f));
  console.log(`\n${files.length - failed.length - skipped.length} of ${files.length} test files passed`
    + (skipped.length ? `; ${skipped.length} skipped: zsh not found (${byReport(skipped).join(', ')})` : '')
    + (partial.length ? `; some checks skipped in ${byReport(partial).join(', ')}${zsh ? '' : ' (skipped: zsh not found)'}` : '')
    + (failed.length ? '; failed: ' + byReport(failed).join(', ') : '')
    + `; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failed.length ? 1 : 0);
})();
