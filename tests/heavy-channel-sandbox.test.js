#!/usr/bin/env node
'use strict';
// The heavy channel under the real codex sandbox (p-codex A2b-1b, cells B'1, B'12, B'13, B'15): scripts/heavy-service.js
// runs the command as `codex sandbox -P <profile of the executor> -- zsh <class>.sh <argv>` with no model call and a
// throwaway CODEX_HOME. The profile: write to the worktree and the task folder, its own TMPDIR inside the task folder,
// /tmp and the system TMPDIR read only, .git and .codex read only, the network only loopback (owner 2026-11-11 "a").
// The probe of the first run of a call checks it; a codex outside the list of the channel refuses with "no safe
// executor". Skipped without macOS or codex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (process.platform !== 'darwin' || !has('codex')) { skip('the heavy channel under codex sandbox', 'needs macOS and codex'); done(); }
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const CLIENT = path.join(S, 'heavy-req.js');

// Every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list), then the rest of the same families.
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-sbx-')));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');

let caseN = 0;
function setup() {
  const c = path.join(T, `c${++caseN}`);
  const d = { slots: path.join(c, 'slots'), wt: path.join(c, 'wt'), tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.slots, d.wt, d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.box = path.join(d.tdir, 'calls', 'prog-1', 'heavy');
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: d.slots, SLOT_JOURNAL: path.join(d.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' });
  return d;
}
const open = (d, x) => HS.openHeavyService(Object.assign({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state,
  kinds: { tsc: 'medium' }, userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200 }, x || {}));
const answers = (d) => path.join(d.state, 'K', 'heavy-calls', 'prog-1');
// heavy-req.js runs as a child of this test (no await between spawn and its end would block the service's loop)
const req = (d, args) => new Promise((resolve) => {
  const p = require('child_process').spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answers(d) }) });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(Object.assign({ rcClient: rc }, j || {})); });
});
const tailOf = (a) => (a && a.log && fs.existsSync(a.log) ? fs.readFileSync(a.log, 'utf8') : '');

(async () => {
  // ---- B'15 + B'1: the probe of the call passes; tsc-like work in its own TMPDIR; /tmp and the system TMPDIR refused
  {
    const d = setup();
    const svc = open(d);
    const sysT = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim();
    const probe = `const fs=require('fs'),os=require('os'),path=require('path');const w=(d)=>{try{const f=path.join(d,'hc-'+process.pid);fs.writeFileSync(f,'x');fs.unlinkSync(f);return 'ok'}catch(e){return e.code}};`
      + `console.log('P '+JSON.stringify({own:w(os.tmpdir()),tmp:w('/tmp'),sys:w(${JSON.stringify(sysT)}),slots:w(process.env.SLOTS_DIR),sb:process.env.CODEX_SANDBOX,mk:(()=>{try{fs.mkdtempSync(path.join(os.tmpdir(),'x-'));return 'ok'}catch(e){return e.code}})()}))`;
    const a = await req(d, ['--kind', 'tsc', '--max', '60', '--', 'node', '-e', probe]);
    const m = /P (\{.*\})/.exec(tailOf(a));
    const j = m ? JSON.parse(m[1]) : null;
    ok('B\'15 the first run of the call: the probe passes, the command runs in codex sandbox (CODEX_SANDBOX=seatbelt), done rc 0', a.state === 'done' && a.rc === 0 && j && j.sb === 'seatbelt', JSON.stringify(a) + tailOf(a));
    ok('B\'1/B\'15 its own TMPDIR is writable (mkdtemp too); /tmp, the system TMPDIR and the slot directory are not', !!j && j.own === 'ok' && j.mk === 'ok' && j.tmp !== 'ok' && j.sys !== 'ok' && j.slots !== 'ok', JSON.stringify(j));
    // ---- B'12, B'13: the nested path inside the sandbox
    const H = path.join(S, 'heavy.sh'), M = path.join(S, 'medium.sh'), G = path.join(S, 'slot-group.pl');
    const n1 = await req(d, ['--max', '60', '--', 'zsh', H, 'node', '-e', 'console.log("SP "+process.env.SLOT_PATH)']);
    ok('B\'12 heavy.sh in the executor (a held heavy slot): no second ticket, SLOT_PATH is the held slot', n1.state === 'done' && n1.rc === 0 && /SP \/.*heavy\.\d+\.lock/.test(tailOf(n1)), tailOf(n1));
    const n7 = await req(d, ['--max', '60', '--', 'zsh', M, 'true']);
    ok('B\'12 medium.sh under a held heavy slot: rc 0', n7.state === 'done' && n7.rc === 0, tailOf(n7));
    const g = path.join(d.wt, 'y-run.mjs');
    fs.writeFileSync(g, '// guards:exclusive — a fixed port of the test\nconsole.log("EXCL");\n');
    const n6 = await req(d, ['--max', '60', '--', 'node', 'y-run.mjs']);
    ok('B\'12 a guards:exclusive guard: its lockf on the lock file made by the adapter, rc 0', n6.state === 'done' && n6.rc === 0 && /EXCL/.test(tailOf(n6)), tailOf(n6));
    const n4 = await req(d, ['--kind', 'tsc', '--max', '60', '--', 'zsh', H, 'true']);
    ok('B\'13 a held medium slot, heavy.sh asked: 64 at once, never the queue', n4.state === 'done' && n4.rc === 64, tailOf(n4));
    const n3 = await req(d, ['--max', '60', '--', 'perl', G, 'lead', 'zsh', H, 'true']);
    ok('B\'13 heavy.sh in another process group (no marker of its group): 64', n3.state === 'done' && n3.rc === 64, tailOf(n3));
    const n5 = await req(d, ['--max', '60', '--', 'env', '-u', 'CODIS_SLOT_HELD', 'zsh', H, 'true']);
    ok('B\'13 argv drops CODIS_SLOT_HELD: the queue refuses at once with 77 (the slot directory is not a root)', n5.state === 'done' && n5.rc === 77, tailOf(n5));
    const n2 = await req(d, ['--max', '60', '--', 'env', '-u', 'SLOTS_DIR', 'zsh', H, 'true']);
    ok('B\'13 without SLOTS_DIR: 77 at once (the default slot directory is not a root either)', n2.state === 'done' && n2.rc === 77, tailOf(n2));
    await svc.close();
  }
  // ---- C0-2 (G30): heavy.sh of an exclusive guard asked through the channel - the executor's heavy.sh takes the lock, the
  // inner one runs under it in the held slot without a second lockf (flock(2) LOCK_NB of the guard through perl: 75 held)
  {
    const d = setup();
    const svc = open(d);
    const H = path.join(S, 'heavy.sh');
    fs.writeFileSync(path.join(d.wt, 'z-run.mjs'), '// guards:exclusive — a fixed port of the test\nimport { spawnSync } from "child_process";\n'
      + 'const r = spawnSync("perl", ["-MFcntl=:flock", "-e", "open(my $f, \\"<\\", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 75)", process.env.GUARDS_EXCLUSIVE_LOCK || ""]);\n'
      + 'console.log("ZX held=" + r.status + " sp=" + process.env.SLOT_PATH);\n');
    const n8 = await req(d, ['--max', '30', '--', 'zsh', H, 'node', 'z-run.mjs']);
    ok('C0-2 heavy-req -- heavy.sh node <exclusive guard> under codex sandbox: done rc 0, the guard ran once under the held lock in the held slot, no wait for the lock',
      n8.state === 'done' && n8.rc === 0 && (tailOf(n8).match(/ZX held=75 sp=\/\S*heavy\.\d+\.lock/g) || []).length === 1 && !/waiting for the exclusive lock/.test(tailOf(n8)), JSON.stringify(n8) + tailOf(n8));
    await svc.close();
  }
  // ---- B'10 x B'12 in the sandbox: the run's config lies outside the roots and the worktree has none; the nested heavy.sh
  // reads it (CODIS_AGENTS_CONFIG of the executor) and runs a guard marked by its guardExclusive under the exclusive lock
  {
    const d = setup();
    for (const k of ['SLOTS_DIR', 'SLOT_JOURNAL', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR', 'CODIS_AGENTS_MACHINE']) delete d.env[k];
    const c = path.dirname(d.wt);
    d.env.HOME = path.join(c, 'home');
    fs.mkdirSync(d.env.HOME);
    const runSlots = path.join(c, 'run-slots');
    const cfg = path.join(c, 'run-cfg', 'codis-agents.json');
    fs.mkdirSync(path.dirname(cfg));
    fs.writeFileSync(cfg, JSON.stringify({ repoDir: c, worktreeRoot: c, sharedDir: c, slots: { lockDir: runSlots }, guardExclusive: { glob: ['*.guard.sh'], marker: '#' } }));
    // lockf -t 0 ends 75 (EX_TEMPFAIL) on a lock held by another descriptor, 0 on a free one
    fs.writeFileSync(path.join(d.wt, 'port.guard.sh'), '# guards:exclusive — a fixed port\n/usr/bin/lockf -t 0 "$GUARDS_EXCLUSIVE_LOCK" true; echo LOCKRC=$?\n');
    const svc = open(d, { config: cfg });
    const a = await req(d, ['--max', '60', '--', 'zsh', 'port.guard.sh']);
    ok('B\'12 x B\'10 under codex sandbox: the run\'s config outside the roots, none in the worktree - the guard it marks runs under the exclusive lock of its slot directory',
      a.state === 'done' && a.rc === 0 && /LOCKRC=75\b/.test(tailOf(a)) && path.dirname(a.slot || '') === runSlots, JSON.stringify(a) + tailOf(a));
    await svc.close();
  }
  // ---- B'15: a codex outside the list of the channel: "no safe executor", nothing runs, no slot taken
  {
    const d = setup();
    const svc = open(d, { codexVersions: ['0.0.1'] });
    const a = await req(d, ['--max', '60', '--', 'node', '-e', 'require("fs").writeFileSync("ran.txt","x")']);
    ok('B\'15 codex not in the list of the channel: refused "environment: no safe executor: ...", never ran, no slot line', a.state === 'refused' && /environment: no safe executor: /.test(a.why || '') && !fs.existsSync(path.join(d.wt, 'ran.txt')) && !fs.existsSync(path.join(d.slots, 'journal.tsv')), JSON.stringify(a));
    await svc.close();
  }
  ok('B\'15 the channel lists codex 0.167.0 only (its profile was measured there), not the list of the commit channel', JSON.stringify(HS.HEAVY_CODEX_VERSIONS) === '["0.167.0"]', JSON.stringify(HS.HEAVY_CODEX_VERSIONS));
  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
