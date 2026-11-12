#!/usr/bin/env node
'use strict';
// Guard runs of a codex role through the heavy channel under the real codex sandbox (p-codex-A2b-1c1, cells C1-1, C1-6,
// C1-8, C1-9, C1-11, C1-12; p-codex-A2b-1c2a C2a-8: a guard with a declared need is skipped): guards-all.sh runs outside the sandbox in its own heavy slot, and every command of the
// project - the runner in each mode of guardCommand, the selection, a single rerun - runs as `codex sandbox -P
// codis-heavy` through scripts/heavy-exec.js, in the group of the slot's command. No model call; a throwaway CODEX_HOME
// per run. Skipped without macOS or codex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (process.platform !== 'darwin' || !has('codex')) { skip('guard runs through the heavy channel under codex sandbox', 'needs macOS and codex'); done(); }
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const { makeProject } = require('./fixtures/heavy-guards/project.js');

// Every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list), then the rest of the same families.
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-grs-')));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
let caseN = 0;
function setup(po) {
  const c = path.join(T, `c${++caseN}`);
  fs.mkdirSync(c);
  const P = makeProject(c, po);
  const d = { root: c, P, wt: P.wt, slots: P.slots, tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.box = path.join(d.tdir, 'calls', 'prog-1', 'heavy');
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: P.slots, SLOT_JOURNAL: path.join(P.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' });
  d.svc = HS.openHeavyService({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state, config: P.cfg,
    userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200 });
  return d;
}
const answers = (d) => path.join(d.state, 'K', 'heavy-calls', 'prog-1');
const req = (d, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answers(d) }) });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(Object.assign({ rcClient: rc }, j || {})); });
});
// a request, polled to its final state (each wait of the client is at most its --max)
const run = async (d, args) => {
  let a = await req(d, args.concat(['--max', '200']));
  while (a.rcClient === 3 && a.id) a = await req(d, ['wait', '--id', a.id, '--max', '200']);
  return a;
};

(async () => {
  // ---- C1-1, C1-6, C1-9, C1-11, C1-12: fixed {jobs}; an exclusive guard; guards-all.sh nested in the executor; a slow guard
  {
    const d = setup({ guards: {
      'a.g': 'exit 0',
      'flaky.g': '[[ -n $FIX_SINGLE ]]',
      'excl.g': 'print -r -- "LOCKRC=$(/usr/bin/lockf -k -t 10 "$GUARDS_EXCLUSIVE_LOCK" true; print $?)"',
      'nested.g': `zsh ${JSON.stringify(path.join(S, 'guards-all.sh'))} "$PWD" >/dev/null 2>&1; print -r -- "NESTED-RC=$?"`,
      'slow.g': 'print SLOW-STARTED; sleep 3',
    } });
    fs.rmSync(path.join(d.slots, 'exclusive.lock'), { force: true });
    const OUT = path.join(d.P.shared, 'guards-wt.txt');
    const p = run(d, ['--kind', 'full']);
    const jobs = await until(() => /SLOW-STARTED/.test(read(OUT)) && fs.readdirSync(d.slots).find((f) => /^heavy\.\d+\.lock\.jobs$/.test(f)), 120000);
    ok('C1-12 during the run the neighbours see its worker budget (<slot>.jobs written outside the sandbox)', !!jobs, JSON.stringify(fs.readdirSync(d.slots)));
    const a = await p;
    const log = read(OUT);
    const m = /RUNNER sb=(\S+) pg=(\d+) mark=(\S+) exec=(\S+)/.exec(log);
    ok('C1-1 --kind full under codex sandbox: done rc 0, the runner in seatbelt, its group under the exec marker of the held slot, no CODIS_GUARDS_EXEC inside',
      a.state === 'done' && a.rc === 0 && !!m && m[1] === 'seatbelt' && m[3] === 'yes' && m[4] === 'none', JSON.stringify(a) + log.slice(0, 1500));
    ok('C1-11 an exclusive guard: lockf on the lock file the wrapper created outside the sandbox, rc 0', /LOCKRC=0/.test(log) && fs.existsSync(path.join(d.slots, 'exclusive.lock')), log.slice(0, 1500));
    ok('C1-6 guards-all.sh nested in the executor: 64 at once (not an endless 75)', /NESTED-RC=64/.test(log), log.slice(0, 1500));
    const rr = read(path.join(d.P.shared, 'guards-wt.rerun.txt'));
    ok('C1-9 the single rerun ran under codex sandbox too (RUNNER sb=seatbelt in the .rerun.txt), the guard flaky', /RUNNER sb=seatbelt/.test(rr) && /flaky, red under load, green alone: guards\/flaky\.g/.test(log), rr.slice(0, 800) + log.slice(-800));
    // ---- C1-2 under the sandbox: a selection of the changed guard
    d.P.commit({ 'guards/a.g': 'exit 0 # changed\n' });
    const s = await run(d, ['--kind', 'select', '--base', 'main']);
    const sel = read(path.join(d.P.shared, 'guards-wt.select.txt'));
    ok('C1-2 --kind select --base main under codex sandbox: the changed guard only, in seatbelt, rc 0', s.state === 'done' && s.rc === 0 && /RUNNER sb=seatbelt/.test(sel) && /accounted 1, failed 0/.test(sel), JSON.stringify(s) + sel.slice(0, 600));
    await d.svc.close();
  }
  // ---- C1-8, C1-12: adaptive ({limitFile} read, its .active refused by the sandbox and swallowed) and whole
  for (const mode of ['adaptive', 'whole']) {
    const d = setup({ mode });
    const a = await run(d, ['--kind', 'full']);
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok(`C1-8 ${mode} under codex sandbox: the runner in seatbelt, rc 0${mode === 'adaptive' ? '; {limitFile} read, <limitFile>.active refused' : ''}`,
      a.state === 'done' && a.rc === 0 && /RUNNER sb=seatbelt/.test(log) && (mode !== 'adaptive' || (/^LIMIT=\d/m.test(log) && /^ACTIVE=refused/m.test(log))), JSON.stringify(a) + log.slice(0, 800));
    await d.svc.close();
  }
  // ---- C2a-8 under the sandbox: guardNeeds, fixed {jobs} with {skipArgs} - the marked guard is passed as --skip and never
  // runs; the others run in seatbelt; the answer: rc 79, verdict incomplete, notRun with its need and reason
  {
    const d = setup({ needs: { marker: '#' }, guards: { 'a.g': 'exit 0', 'b.g': '# guards:needs browser — no browser in the sandbox\nprint -r -- B-RAN\n' } });
    const a = await run(d, ['--kind', 'full']);
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok('C2a-8 --kind full under codex sandbox with a marked guard: --skip passed, it did not run, the others in seatbelt; rc 79, verdict incomplete, notRun guards/b.g (needs browser)',
      a.state === 'done' && a.rc === 79 && a.verdict === 'incomplete' && Array.isArray(a.notRun) && a.notRun.map((x) => x.guard).join() === 'guards/b.g' && a.notRun[0].needs[0] === 'browser'
      && /^SKIPPED guards\/b\.g$/m.test(log) && !/B-RAN/.test(log) && /RUNNER sb=seatbelt/.test(log) && /^incomplete: 1 guard not run in the sandbox of a codex role: guards\/b\.g \(needs browser: no browser in the sandbox\)$/m.test(log),
      JSON.stringify(a) + log.slice(0, 1500));
    await d.svc.close();
  }
  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
