#!/usr/bin/env node
'use strict';
// Which project config a call of scripts/stand.sh uses: the one found once when the call starts (config.js find from
// the directory it is called in, or $CODIS_AGENTS_CONFIG), for every command of that call. take changes into the
// worktree of the holder; a worktree branch with its own .claude/codis-agents.json (another stand section) must not
// change the project in the middle of the call. Two configs on fake commands that log {project}:
//  C1 take --wt <wt> from the root (A): the first status, the status after the queue and the reset at issue run with
//     A - with the ticket free and with a wait behind another holder; deploy and status from the root too;
//  C2 take from the worktree itself: everything with B, nothing with A;
//  C3 $CODIS_AGENTS_CONFIG set (absolute, and relative to the calling directory): it is used, cd does not change it;
//  C4 take, deploy and status print the path of the config they use ("project config <path>").
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const CASES = ['C1', 'C2', 'C3', 'C4'];
if (!has('zsh')) { for (const c of CASES) skip(c, 'zsh not found'); done(); }

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stand-config-')));
const SL = path.join(T, 'slots'), LOG = path.join(T, 'log');
const PROOT = path.join(T, 'root'), WB = path.join(T, 'wts', 'wb'), WX = path.join(T, 'wts', 'wx');
for (const d of [path.join(PROOT, '.claude'), path.join(WB, '.claude'), path.join(WB, '.git'), path.join(WX, '.git'), path.join(T, 'home')]) fs.mkdirSync(d, { recursive: true });
const standOf = (project) => ({
  project, ports: [39997],
  up: `touch ${T}/up`, down: `rm -f ${T}/up`,
  status: `print -r -- status {project} >> ${LOG}; test -e ${T}/up`,   // values come shell-quoted: never inside "..."
  reset: `print -r -- reset {project} >> ${LOG}`,
  deploy: `print -r -- deploy {project} $(basename {wt}) >> ${LOG}`,
  imageFiles: ['Dockerfile'], memLimitMB: 1024,
});
// The same slot directory in all three: one ticket and one queue, only the stand section differs.
const cfgOf = (project) => JSON.stringify({ repoDir: PROOT, worktreeRoot: path.join(T, 'wts'), sharedDir: path.join(T, 'shared'), slots: { lockDir: SL }, stand: standOf(project) });
const CFG_A = path.join(PROOT, '.claude', 'codis-agents.json'), CFG_B = path.join(WB, '.claude', 'codis-agents.json'), CFG_C = path.join(T, 'c.json');
fs.writeFileSync(CFG_A, cfgOf('proj-a'));
fs.writeFileSync(CFG_B, cfgOf('proj-b'));
fs.writeFileSync(CFG_C, cfgOf('proj-c'));

// Fake macOS machine with free memory and plenty of swap, so the medium slot of deploy never waits on the real box.
const BIN = path.join(T, 'bin');
fs.mkdirSync(BIN);
const fake = (f, body) => { fs.writeFileSync(path.join(BIN, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(BIN, f), 0o755); };
fake('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
fake('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
fake('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
fake('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
const env = Object.assign({}, process.env, { HOME: path.join(T, 'home'), PATH: BIN + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
// No config named from outside: the lookup from the calling directory is what is tested (an outer slot's variables go too).
for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_JOURNAL', 'SLOT_LEGACY_LOCK', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env[k];

const procs = [];
function take(dir, args = [], e = {}) {
  const p = spawn('zsh', [path.join(S, 'stand.sh'), 'take', ...args], { cwd: dir, env: Object.assign({}, env, e) });
  p.out = ''; p.exited = null;
  p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.on('exit', (c, s) => { p.exited = { c, s }; });
  procs.push(p);
  return p;
}
const st = (args, cwd, e = {}) => spawnSync('zsh', [path.join(S, 'stand.sh'), ...args], { cwd, env: Object.assign({}, env, e), encoding: 'utf8', timeout: 60000 });
const outOf = (r) => (r.stdout || '') + (r.stderr || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (f()) return true; return f(); }
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const clear = () => fs.rmSync(LOG, { force: true });
const taken = (p) => /ticket taken by /.test(p.out);
const ended = (p) => waitFor(() => p.exited !== null, 5000);
// Every logged command ran with this project, and the expected ones are there.
const allWith = (proj, need) => log().length > 0 && log().every((l) => l.endsWith(' ' + proj) || l.startsWith('deploy ' + proj + ' '))
  && Object.entries(need).every(([c, n]) => log().filter((l) => l.startsWith(c + ' ')).length >= n);
const named = (out, f) => out.includes(`project config ${f}`);

(async () => {
  try {
    let r = st(['up'], PROOT);
    ok('up from the root runs the command of A', r.status === 0 && fs.existsSync(path.join(T, 'up')), outOf(r));

    // C1, the ticket free: take --wt <wt> from the root.
    clear();
    let p = take(PROOT, ['--wt', WB]);
    ok('C1 take --wt <wt> from the root, ticket free: taken', await waitFor(() => taken(p)), p.out);
    ok('C1 ... the first status, the status after the queue and the reset at issue all ran with A', allWith('proj-a', { status: 2, reset: 1 }), log().join('|'));
    ok('C1 ... the take names the project A, never B', /stand proj-a: ticket taken by /.test(p.out) && !/proj-b/.test(p.out), p.out);
    ok('C4 take prints the path of the config it uses (the root\'s)', named(p.out, CFG_A), p.out);
    clear();
    r = st(['deploy', WB], PROOT);
    ok('C1 deploy from the root: the deploy of A for the worktree', r.status === 0 && log().join('|') === 'deploy proj-a wb', outOf(r) + log().join('|'));
    ok('C4 deploy prints the path of the config it uses', named(outOf(r), CFG_A), outOf(r));
    r = st(['status'], PROOT);
    ok('C4 status prints the path of the config it uses', r.status === 0 && named(outOf(r), CFG_A) && /stand proj-a: up/.test(outOf(r)), outOf(r));
    r = st(['release', '--wt', WB], PROOT);
    ok('C1 release --wt <wt> from the root', r.status === 0 && await ended(p), outOf(r));

    // C1 with a wait: another holder has the ticket; the waiter called from the root queues, then gets it.
    const h = take(WX, [], { CODIS_AGENTS_CONFIG: CFG_A });
    ok('C1 another holder takes the ticket', await waitFor(() => taken(h)), h.out);
    clear();
    p = take(PROOT, ['--wt', WB]);
    ok('C1 the waiter from the root queues behind it', await waitFor(() => /waiting for the stand ticket proj-a, position 1 in queue/.test(p.out)), p.out);
    r = st(['release'], WX, { CODIS_AGENTS_CONFIG: CFG_A });
    ok('C1 the holder releases', r.status === 0 && await ended(h), outOf(r));
    ok('C1 the waiter gets the ticket after the wait', await waitFor(() => taken(p)), p.out);
    ok('C1 ... every command of the waiting take (first status, status after the queue, reset at issue) ran with A', allWith('proj-a', { status: 2, reset: 2 }), log().join('|'));
    ok('C1 ... its output names A only, no refusal', /stand proj-a: ticket taken by /.test(p.out) && !/proj-b|refused/.test(p.out), p.out);
    r = st(['release', '--wt', WB], PROOT);
    ok('C1 release after the wait', r.status === 0 && await ended(p), outOf(r));

    // C2: take from the worktree itself - its own config B for every command.
    clear();
    p = take(WB);
    ok('C2 take from the worktree: taken', await waitFor(() => taken(p)), p.out);
    ok('C2 ... every command ran with B', allWith('proj-b', { status: 2, reset: 1 }), log().join('|'));
    ok('C2 ... the output names B and its config', /stand proj-b: ticket taken by /.test(p.out) && !/proj-a/.test(p.out) && named(p.out, CFG_B), p.out);
    clear();
    r = st(['release'], WB);
    ok('C2 release from the worktree: the reset of B', r.status === 0 && await ended(p) && log().join('|') === 'reset proj-b', outOf(r) + log().join('|'));

    // C3: $CODIS_AGENTS_CONFIG wins over both, absolute and relative to the calling directory.
    for (const [v, from, n] of [[CFG_C, PROOT, 'absolute, take from the root'], [CFG_C, WB, 'absolute, take from the worktree'], [path.relative(T, CFG_C), T, 'relative to the calling directory']]) {
      clear();
      p = take(from, ['--wt', WB], { CODIS_AGENTS_CONFIG: v });
      ok(`C3 CODIS_AGENTS_CONFIG ${n}: taken`, await waitFor(() => taken(p)), p.out);
      ok(`C3 ... every command ran with C`, allWith('proj-c', { status: 2, reset: 1 }), log().join('|'));
      ok(`C3 ... the output names C and the absolute path of its config`, /stand proj-c: ticket taken by /.test(p.out) && named(p.out, CFG_C), p.out);
      r = st(['release', '--wt', WB], from, { CODIS_AGENTS_CONFIG: v });
      ok(`C3 ... release`, r.status === 0 && await ended(p), outOf(r));
    }
  } catch (e) {
    ok('crashed: ' + e.stack, false);
  } finally {
    for (const p of procs) if (p.exited === null) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(200);
    fs.rmSync(T, { recursive: true, force: true });
  }
  done();
})();
