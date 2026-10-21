#!/usr/bin/env node
'use strict';
// Tester, p-q1: edges of stand.cwd (owner 2026-10-21) that tests/stand.test.js and tests/config.test.js leave open.
//  E1 without stand.cwd the reset (at issue and at release) and the deploy also run in repoDir, not only up/status/down;
//  E2 a stand.cwd written with ~ is expanded by stand.sh too (HOME of the run), every command runs there;
//  E3 {repo} stays repoDir while stand.cwd is set: cwd changes the directory only, not the placeholder;
//  E4 the holder of the ticket still has its worktree as cwd with stand.cwd set (the leftovers post-check finds it);
//  E5 the command line `config.js check <file>`: an existing stand.cwd - exit 0; missing, a file, relative - exit 1
//     naming stand.cwd.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stand-cwd-edges-')));
const SL = path.join(T, 'slots'), CLOG = path.join(T, 'cwdlog');
const MAIN = path.join(T, 'main'), HOME = path.join(T, 'home'), HC = path.join(HOME, 'stand dir');
const W = path.join(T, 'wts', 'wa');
for (const d of [MAIN, HC, path.join(W, '.git')]) fs.mkdirSync(d, { recursive: true });

// E5 (no zsh needed): the command line check.
const chk = (stand) => {
  const f = path.join(T, `chk-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ repoDir: MAIN, worktreeRoot: path.join(T, 'wts'), sharedDir: path.join(T, 'shared'), stand }));
  return spawnSync('node', [path.join(S, 'config.js'), 'check', f], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME }) });
};
const BASE = { project: 'cwd-edges', ports: [39998], up: 'true', deploy: ': {wt}', reset: 'true', status: 'true', down: 'true' };
let r = chk(Object.assign({}, BASE, { cwd: HC }));
ok('E5 config.js check: an existing absolute stand.cwd - exit 0', r.status === 0, r.stdout + r.stderr);
r = chk(Object.assign({}, BASE, { cwd: '~/stand dir' }));
ok('E5 config.js check: stand.cwd "~/stand dir" (exists under HOME) - exit 0', r.status === 0, r.stdout + r.stderr);
for (const [v, re, n] of [[path.join(T, 'nope'), /stand\.cwd: .*nope does not exist/, 'missing'], [path.join(T, 'f'), /stand\.cwd: .* is not a directory/, 'a file'],
  ['stand dir', /stand\.cwd: an absolute path/, 'relative'], ['~/nope', /stand\.cwd: .*nope does not exist/, '~ to a missing directory']]) {
  fs.writeFileSync(path.join(T, 'f'), '');
  r = chk(Object.assign({}, BASE, { cwd: v }));
  ok(`E5 config.js check: stand.cwd ${n} - exit 1 naming stand.cwd`, r.status === 1 && re.test(r.stdout + r.stderr), `${r.status} ${r.stdout}${r.stderr}`);
}

const CASES = ['E1', 'E2', 'E3', 'E4'];
if (!has('zsh')) { for (const c of CASES) skip(c, 'zsh not found'); fs.rmSync(T, { recursive: true, force: true }); done(); }

const at = (n) => `print -r -- "${n} $PWD" >> ${CLOG}`;
const STAND = {
  project: 'cwd-edges', ports: [39998],
  up: at('up') + `; touch ${T}/up`, status: at('status') + `; test -e ${T}/up`, down: at('down'),
  reset: at('reset'), deploy: at('deploy') + `; print -r -- repo {repo} >> ${CLOG}; : {wt}`,
};
const cfgFile = (extra) => {
  const f = path.join(T, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ repoDir: MAIN, worktreeRoot: path.join(T, 'wts'), sharedDir: path.join(T, 'shared'), slots: { lockDir: SL }, stand: Object.assign({}, STAND, extra) }));
  return f;
};
// Fake macOS machine with free memory and plenty of swap, so the medium slot of deploy never waits on the real box.
const BIN = path.join(T, 'bin');
fs.mkdirSync(BIN);
const fake = (f, body) => { fs.writeFileSync(path.join(BIN, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(BIN, f), 0o755); };
fake('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
fake('memory_pressure', 'print -r -- "System-wide memory free percentage: 60%"');
fake('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
fake('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
const env = Object.assign({}, process.env, { HOME, PATH: BIN + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
// Run inside an outer slot, the outer slots.zsh has exported its lock, journal and counts; thresholds set outside are
// dropped too (the list slots-hermetic.test.js checks), and the config paths of an outer project.
for (const k of ['SLOTS_DIR', 'SLOT_JOURNAL', 'SLOT_LEGACY_LOCK', 'CLAUDE_PROJECT_DIR', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env[k];
for (const k of Object.keys(env)) if (/^CODIS_/.test(k)) delete env[k];

const st = (args, e) => spawnSync('zsh', [path.join(S, 'stand.sh'), ...args], { cwd: W, env: Object.assign({}, env, e), encoding: 'utf8', timeout: 60000 });
const outOf = (x) => (x.stdout || '') + (x.stderr || '');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function waitFor(f, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (f()) return true; return f(); }
const lines = () => (fs.existsSync(CLOG) ? fs.readFileSync(CLOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const cwdOf = (pid) => {
  if (process.platform === 'linux') { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  const x = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const m = (x.stdout || '').match(/^n(.*)$/m);
  return m ? m[1] : null;
};
const procs = [];
// One full cycle: up, status, take (reset at issue), deploy, release (reset), down; returns the cwd log and the holder's cwd.
async function cycle(cfg) {
  fs.rmSync(CLOG, { force: true }); fs.rmSync(path.join(T, 'up'), { force: true });
  const e = { CODIS_AGENTS_CONFIG: cfg };
  const res = { up: st(['up'], e), status: st(['status'], e) };
  const p = spawn('zsh', [path.join(S, 'stand.sh'), 'take'], { cwd: W, env: Object.assign({}, env, e) });
  procs.push(p); p.out = ''; p.exited = null;
  p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.on('exit', (c) => { p.exited = c; });
  res.taken = await waitFor(() => /ticket taken by /.test(p.out));
  res.holderCwd = res.taken ? cwdOf(p.pid) : null;
  res.deploy = st(['deploy'], e);
  res.release = st(['release'], e);
  res.exited = await waitFor(() => p.exited !== null, 5000);
  res.down = st(['down'], e);
  res.log = lines();
  res.out = p.out;
  return res;
}
const allIn = (log, dir) => {
  const cmd = log.filter((l) => !l.startsWith('repo '));
  return ['up', 'status', 'deploy', 'down'].every((n) => cmd.some((l) => l.startsWith(n + ' '))) && cmd.filter((l) => l.startsWith('reset ')).length === 2
    && cmd.every((l) => l.slice(l.indexOf(' ') + 1) === dir);
};

(async () => {
  try {
    // E1: no stand.cwd - every command, reset and deploy included, runs in repoDir.
    let c = await cycle(cfgFile({}));
    ok('E1 without stand.cwd: the cycle ran (take, deploy, release exit 0)', c.taken && c.deploy.status === 0 && c.release.status === 0 && c.exited, `${c.out} | ${outOf(c.deploy)} | ${outOf(c.release)}`);
    ok('E1 ... up, status, reset at issue and at release, deploy and down all ran in repoDir', allIn(c.log, MAIN), c.log.join('|'));

    // E2 + E3 + E4: stand.cwd "~/stand dir" under the HOME of the run.
    c = await cycle(cfgFile({ cwd: '~/stand dir' }));
    ok('E2 stand.cwd "~/stand dir": the cycle ran', c.taken && c.deploy.status === 0 && c.release.status === 0 && c.exited, `${c.out} | ${outOf(c.deploy)} | ${outOf(c.release)}`);
    ok('E2 ... every command ran in the expanded directory $HOME/stand dir', allIn(c.log, HC), c.log.join('|'));
    ok('E3 ... {repo} in the deploy command is still repoDir, not stand.cwd', c.log.includes(`repo ${MAIN}`), c.log.join('|'));
    ok('E4 ... the holder\'s cwd is its worktree, not stand.cwd', c.holderCwd !== null && fs.realpathSync(c.holderCwd) === W, String(c.holderCwd));
  } catch (e) {
    ok('no exception', false, e.stack);
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(T, { recursive: true, force: true });
    done();
  }
})();
