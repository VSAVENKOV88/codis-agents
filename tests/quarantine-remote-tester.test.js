#!/usr/bin/env node
'use strict';
// p-train-b2, tester: cells of the quarantine through the remote runner that tests/quarantine-remote.test.js does not
// hold. R1 --no-quarantine on a remote run: nothing sent, nothing written, no hash in the meta. R2 a relative sharedDir
// (the plugin's own config has ".."): the quarantine is read, sent and written from the same file. R3 a start that
// attaches to a run of the same name and SHA begun with another quarantine: the meta must not keep the hash of a
// quarantine that run never subtracted (D5: a dropped entry is never reused). R5 a guard written here by another run
// while the remote run was going: the earlier entry stays, and the meta does not take the hash of a file it did not
// read. R6 no quarantine file and nothing flaky: the file appearing later refuses the reuse.
// No network: ssh is a fake on PATH that runs the remote command with sh in a temporary "server" home (the fixture of
// tests/quarantine-remote.test.js; the full run can be made slow to catch it running).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-remote-tester-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs'), sshLog = path.join(T, 'ssh.log');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lines = (f) => (read(path.join(T, f)) || '').split('\n').filter(Boolean);
const QF = path.join(shared, 'guards-quarantine.json');
const RQ = path.join(R, 'runs', 'xw', 'guards-quarantine.json');
const q = () => { try { return JSON.parse(read(QF)); } catch { return null; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const LOG = (extra) => ['Guards to run: 4', ...(extra || []), '', '---- NEW RED ----', 'X srv/a-run.js  (1.0s, code 1)', 'X srv/b-run.js  (2.0s, code 1)', '',
  'TOTAL: 2 green, 2 NEW red, 0 known red'].join('\n') + '\n';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^[XT] (\\S+(?: \\S+)*?)  \\(', tallyPattern: '^TOTAL: ' };

const kids = [];
try {
  if (!has('zsh') || !has('perl')) skip('quarantine through the remote runner (tester)', 'zsh or perl not found');
  else {
    for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(a) + '\\n');
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env, cwd: ${JSON.stringify(S)} });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
    const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
    // full.sh: counted first, then (when T/full.sleep holds seconds) slow, so a run can be caught while it goes
    put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/full.count"\n[ -s "${T}/full.sleep" ] && sleep $(cat "${T}/full.sleep")\ncat "${T}/full.log"\nexit $(cat "${T}/full.rc")\n`, 0o755);
    put('one.sh', `#!/bin/sh\necho "$PWD $1" >> "${T}/one.count"\ngrep -qxF -- "$1" "${T}/red.txt" && exit 1\nexit 0\n`, 0o755);
    put('local.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/local.count"\n[ -s "${T}/local.log" ] && cat "${T}/local.log"\nexit $(cat "${T}/local.rc")\n`, 0o755);
    put('known.json', '{}\n');
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'xw'));
    const xw = path.join(wts, 'xw');
    fs.writeFileSync(path.join(T, 'key'), 'not a key\n'); fs.writeFileSync(path.join(T, 'kh'), 'example.org ssh-ed25519 AAAA\n');
    const remote = { host: 'example.org', user: 'runner', key: path.join(T, 'key'), knownHosts: path.join(T, 'kh'), root: '~/codis-runs', plugin: ROOT };
    const mfile = path.join(T, 'machine.json');
    fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(T, 'slots') }, remote }));
    fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
    const cfgFile = path.join(T, 'cfg.json');
    const setCfg = (sharedDir) => fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: sharedDir || shared, guardCommand: 'cd {wt} && ./full.sh {jobs}', guardRerun: RERUN,
      guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', protectedBranches: ['trunk'], guardBaseline: 'known.json',
      remoteRun: { command: 'cd {wt} && ./full.sh {jobs}', localPattern: '^skipped \\(needs-font\\): \\d+ — (.+)$' } }));
    const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    // Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];
    for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
    const env = (extra) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
      SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV }, extra || {});
    const GA = path.join(ROOT, 'scripts', 'guards-all.sh');
    const ga = (opts, ...a) => { const r = spawnSync('zsh', [GA, ...a], { encoding: 'utf8', env: env(opts.env), cwd: opts.cwd || T, timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
    const set = (rc, red, extra) => {
      fs.writeFileSync(path.join(T, 'full.log'), LOG(extra)); fs.writeFileSync(path.join(T, 'full.rc'), String(rc));
      fs.writeFileSync(path.join(T, 'local.rc'), '0'); fs.writeFileSync(path.join(T, 'local.log'), ''); fs.writeFileSync(path.join(T, 'full.sleep'), '');
      fs.writeFileSync(path.join(T, 'red.txt'), red.map((x) => x + '\n').join(''));
      for (const c of ['full.count', 'one.count', 'local.count']) fs.rmSync(path.join(T, c), { force: true });
      fs.rmSync(sshLog, { force: true });
    };
    const out = () => read(path.join(shared, 'guards-xw.txt')) || '';
    const meta = () => JSON.parse(read(path.join(shared, 'guards-xw.txt.meta.json')) || '{}');
    const sentQ = () => read(path.join(R, 'runs', 'xw', 'job.json'));
    const until = (cond, ms) => { const t = Date.now() + ms; while (Date.now() < t) { if (cond()) return true; sleepMs(100); } return cond(); };
    setCfg();

    // R1: --no-quarantine on a remote run - the quarantine is neither sent nor written, the meta has no hash.
    fs.writeFileSync(QF, '{"srv/a-run.js": "flaky: earlier"}\n'); set(1, []);
    let x = ga({}, '--force', '--no-quarantine', 'xw');
    const job1 = JSON.parse(sentQ() || '{}');
    ok('R1: --no-quarantine remote - exit 0 (both flaky), the file here unchanged', x.status === 0 && read(QF) === '{"srv/a-run.js": "flaky: earlier"}\n', `${x.status} ${read(QF)}\n${x.all.slice(-600)}`);
    ok('R1: --no-quarantine remote - no quarantine in the job, none in the run directory, the runner reruns both', job1.quarantine === undefined && !fs.existsSync(RQ) && lines('one.count').length === 2, `${JSON.stringify(job1.quarantine)} ${fs.existsSync(RQ)} ${lines('one.count')}`);
    ok('R1: --no-quarantine remote - no "quarantined:" line, the runner says the quarantine is off', !/^quarantined: /m.test(out()) && /quarantine off on this run/.test(out()), out().slice(-600));
    ok('R1: --no-quarantine remote - the meta has no quarantine hash', meta().quarantine === undefined && meta().env === 'remote:example.org', JSON.stringify(meta()));

    // R6: no quarantine file and nothing flaky - the meta keeps "none"; the file appearing refuses the reuse.
    fs.rmSync(QF, { force: true }); fs.writeFileSync(path.join(T, 'red.txt'), ''); set(0, []);
    fs.writeFileSync(path.join(T, 'full.log'), 'Guards to run: 2\n\nTOTAL: 2 green, 0 NEW red, 0 known red\n');
    x = ga({}, '--force', 'xw');
    ok('R6: no quarantine file, green - exit 0, no file created here, the run got {}', x.status === 0 && !fs.existsSync(QF) && JSON.stringify(JSON.parse(read(RQ) || 'null')) === '{}', `${x.status} ${fs.existsSync(QF)} ${read(RQ)}`);
    ok('R6: the meta keeps the hash "none" of the missing file', meta().quarantine === 'none', JSON.stringify(meta()));
    x = ga({}, 'xw');
    ok('R6: same HEAD, still no file - reused', x.status === 0 && /reused, HEAD /.test(x.stdout), x.all.slice(-400));
    fs.writeFileSync(QF, '{"srv/z-run.js": "flaky: other run"}\n');
    fs.rmSync(path.join(T, 'full.count'), { force: true });
    x = ga({}, 'xw');
    ok('R6: the quarantine file appeared - not reused, the runner runs again', !/reused, HEAD /.test(x.stdout) && lines('full.count').length === 1, x.all.slice(-400));

    // R2: a relative sharedDir (taken from the cwd of the call, as the plugin's ".."): read, sent and written alike.
    setCfg('shared'); fs.writeFileSync(QF, '{"srv/a-run.js": "flaky: earlier"}\n'); set(1, []);
    x = ga({ cwd: T }, '--force', 'xw');
    let Q = q() || {};
    ok('R2: relative sharedDir - exit 0, a subtracted on the runner (sent), only b rerun and written here', x.status === 0 && lines('one.count').length === 1 && /b-run/.test(lines('one.count')[0] || '')
      && Q['srv/a-run.js'] === 'flaky: earlier' && /^flaky: guards-xw\.txt /.test(Q['srv/b-run.js'] || ''), `${x.status} ${lines('one.count')} ${JSON.stringify(Q)}\n${x.all.slice(-800)}`);
    ok('R2: relative sharedDir - no "no such file", the meta keeps the hash of the file after the write', !/no such file/.test(x.all) && meta().quarantine === G.quarantineHash(QF), JSON.stringify(meta()));
    setCfg();

    // R5: another run writes b here while this remote run goes; b comes back flaky - the earlier entry stays, and the
    // meta does not take the hash of a file this run did not read (the next call runs again rather than reuse).
    fs.writeFileSync(QF, '{}\n'); set(1, []); fs.writeFileSync(path.join(T, 'full.sleep'), '3');
    {
      const p = spawn('zsh', [GA, '--force', 'xw'], { env: env(), cwd: T, stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(p);
      let pout = ''; p.stdout.on('data', (b) => { pout += b; }); p.stderr.on('data', (b) => { pout += b; });
      const started = until(() => lines('full.count').length > 0, 60000);
      G.addQuarantine(QF, { 'srv/b-run.js': 'flaky: another run' });
      // the meta-start of this run has no rc; metaEnd writes it last
      const ended = until(() => meta().rc !== undefined && meta().startedAt && lines('full.count').length > 0, 120000);
      Q = q() || {};
      ok('R5: the remote run finished', started && ended, `${started} ${ended} ${JSON.stringify(meta())}`);
      ok('R5: the entry another run wrote meanwhile stays as written; a is written by this run', Q['srv/b-run.js'] === 'flaky: another run' && /^flaky: guards-xw\.txt /.test(Q['srv/a-run.js'] || ''), JSON.stringify(Q));
      ok('R5: the meta does not hold the hash of the file this run did not read', meta().quarantine !== G.quarantineHash(QF), JSON.stringify(meta()));
    }

    // R3: a run begun with quarantine Q1 (a, b subtracted - both are red alone) is left while it goes (the waiting side
    // killed: a wait step at its deadline); the coordinator drops a and b; the next call attaches to that run (same
    // name, same SHA) and gets its green. That green stood on Q1: the meta must not record the hash of Q2, or the
    // following call reuses a green the current quarantine would never give.
    fs.writeFileSync(QF, '{"srv/a-run.js": "flaky: earlier", "srv/b-run.js": "flaky: earlier"}\n');
    set(1, ['srv/a-run.js', 'srv/b-run.js']); fs.writeFileSync(path.join(T, 'full.sleep'), '4');
    {
      const p = spawn('zsh', [GA, '--force', 'xw'], { env: env(), cwd: T, stdio: 'ignore', detached: true });
      kids.push(p);
      const started = until(() => lines('full.count').length > 0, 60000);
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ }
      ok('R3: the first run started on the runner with Q1 and its waiting side was killed', started);
      G.dropQuarantine(QF, ['srv/a-run.js', 'srv/b-run.js']);
      x = ga({}, '--force', 'xw');
      ok('R3: the next call attaches to the running run (no second run)', /attached to the run /.test(x.all) && lines('full.count').length === 1, `${lines('full.count')}\n${x.all.slice(-800)}`);
      const m = meta();
      ok('R3: the meta of the attached run does not hold the hash of the quarantine it never subtracted (Q2)', !(m.rc === 0 && m.quarantine === G.quarantineHash(QF)), `${x.status} ${JSON.stringify(m)}`);
      fs.writeFileSync(path.join(T, 'full.sleep'), '');
      x = ga({}, 'xw');
      ok('R3: the following call with Q2 is not reused on that green (a fresh run: a and b red alone -> exit 1)', !/reused, HEAD /.test(x.stdout) && x.status === 1, `${x.status}\n${x.all.slice(-600)}`);
    }
  }
} finally {
  for (const p of kids) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } try { p.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(T, { recursive: true, force: true });
}
done();
