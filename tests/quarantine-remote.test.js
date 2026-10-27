#!/usr/bin/env node
'use strict';
// p-train-b2: the quarantine of flaky guards through the remote runner (matrix cells E2, E3, E4 x D5, E5 and the errors
// of the brief). The runner runs its own guards-all.sh, so a quarantine entry written there would be lost: this machine
// writes the entries itself from the flaky lines of the log that comes back (E2); the quarantine of this machine goes
// with the run, and the runner subtracts it read-only (E3); the meta of the remote run keeps the hash of the quarantine
// (E4 x D5: a changed quarantine is never reused). A broken quarantine here, a network failure or a refused transfer is
// an environment red (69), never a silent skip; no log - nothing written (E5).
// No network: ssh is a fake on PATH that runs the remote command with sh in a temporary "server" home; the "server"
// plugin is this checkout (the same fixture as tests/guards-remote.test.js, without corpus and dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-remote-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs'), sshLog = path.join(T, 'ssh.log');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lines = (f) => (read(path.join(T, f)) || '').split('\n').filter(Boolean);
const QF = path.join(shared, 'guards-quarantine.json');
const RQ = path.join(R, 'runs', 'xw', 'guards-quarantine.json');
const q = () => { try { return JSON.parse(read(QF)); } catch { return null; } };

// The runner's log: two new reds, the tally; extra lines go before the tally (a guard's own output).
const LOG = (extra) => ['Guards to run: 4', ...(extra || []), '', '---- NEW RED ----', 'X srv/a-run.js  (1.0s, code 1)', 'X srv/b-run.js  (2.0s, code 1)', '',
  'TOTAL: 2 green, 2 NEW red, 0 known red'].join('\n') + '\n';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^[XT] (\\S+(?: \\S+)*?)  \\(', tallyPattern: '^TOTAL: ' };

try {
  if (!has('zsh') || !has('perl')) skip('quarantine through the remote runner', 'zsh or perl not found');
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
if (process.env.FAKE_SSH_FAIL) { process.stderr.write('ssh: connect to host example.org port 22: Connection refused\\n'); process.exit(255); }
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env, cwd: ${JSON.stringify(S)} });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
    const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
    put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/full.count"\ncat "${T}/full.log"\nexit $(cat "${T}/full.rc")\n`, 0o755);
    put('one.sh', `#!/bin/sh\necho "$PWD $1" >> "${T}/one.count"\ngrep -qxF -- "$1" "${T}/red.txt" && exit 1\nexit 0\n`, 0o755);
    put('local.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/local.count"\n[ -s "${T}/local.log" ] && cat "${T}/local.log"\nexit $(cat "${T}/local.rc")\n`, 0o755);
    put('known.json', '{}\n');
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'xw'));
    const xw = path.join(wts, 'xw');
    const sha7 = git(xw, 'rev-parse', '--short=7', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(T, 'key'), 'not a key\n'); fs.writeFileSync(path.join(T, 'kh'), 'example.org ssh-ed25519 AAAA\n');
    const remote = { host: 'example.org', user: 'runner', key: path.join(T, 'key'), knownHosts: path.join(T, 'kh'), root: '~/codis-runs', plugin: ROOT };
    const mfile = path.join(T, 'machine.json');
    fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(T, 'slots') }, remote }));
    fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
    const cfgFile = path.join(T, 'cfg.json');
    const setCfg = (baseline) => fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}', guardRerun: RERUN,
      guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', protectedBranches: ['trunk'],
      remoteRun: { command: 'cd {wt} && ./full.sh {jobs}', localPattern: '^skipped \\(needs-font\\): \\d+ — (.+)$' } }, baseline ? { guardBaseline: 'known.json' } : {})));
    const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    // Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];
    for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
    const env = (extra) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
      SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV }, extra || {});
    const ga = (extra, ...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env: env(extra), timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
    const set = (rc, red, extra) => {
      fs.writeFileSync(path.join(T, 'full.log'), LOG(extra)); fs.writeFileSync(path.join(T, 'full.rc'), String(rc));
      fs.writeFileSync(path.join(T, 'local.rc'), '0'); fs.writeFileSync(path.join(T, 'local.log'), '');
      fs.writeFileSync(path.join(T, 'red.txt'), red.map((x) => x + '\n').join(''));
      for (const c of ['full.count', 'one.count', 'local.count']) fs.rmSync(path.join(T, c), { force: true });
      fs.rmSync(sshLog, { force: true });
    };
    const out = () => read(path.join(shared, 'guards-xw.txt')) || '';
    const meta = () => JSON.parse(read(path.join(shared, 'guards-xw.txt.meta.json')) || '{}');
    const WHY = new RegExp(`^flaky: guards-xw\\.txt ${sha7}, green alone, \\d{4}-\\d\\d-\\d\\d$`);
    setCfg(true);

    // E2: both new reds are green alone on the runner -> written here, from the log that came back.
    fs.rmSync(QF, { force: true }); set(1, []);
    let x = ga({}, '--force', 'xw');
    let Q = q() || {};
    ok('E2: flaky on the runner - exit 0, both written into the quarantine of this machine', x.status === 0 && Object.keys(Q).sort().join(',') === 'srv/a-run.js,srv/b-run.js', `${x.status} ${JSON.stringify(Q)}\n${x.all.slice(-800)}`);
    ok('E2: the reason is "flaky: <log> <sha7>, green alone, <date>" (the log here, HEAD of the worktree)', Object.keys(Q).length === 2 && Object.values(Q).every((v) => WHY.test(v)), JSON.stringify(Q));
    ok('E2: the log here says "quarantined: srv/a-run.js, srv/b-run.js (<file>)"', out().includes(`quarantined: srv/a-run.js, srv/b-run.js (${QF})`), out());
    ok('E2: the summary is shown on stdout too', x.stdout.includes('quarantined: srv/a-run.js, srv/b-run.js'), x.stdout);
    ok('E2: one "quarantined:" line only (the runner itself writes nothing)', (out().match(/^quarantined: /gm) || []).length === 1, out());
    ok('E2: the runner ran read-only: its log says so', /quarantine read-only on this run/.test(out()), out());
    ok('E2/E3: the runner got the quarantine of this machine as it was at the start ({}), and did not change it', JSON.stringify(JSON.parse(read(RQ) || 'null')) === '{}', read(RQ));
    const m1 = meta();
    ok('E4 x D5: the remote meta keeps the hash of the quarantine (the file after this machine wrote it)', m1.env === 'remote:example.org' && m1.rc === 0 && m1.quarantine === G.quarantineHash(QF), JSON.stringify(m1));
    ok('D1: the tracked tree stays clean', git(xw, 'status', '--porcelain', '--untracked-files=no').stdout.trim() === '' && m1.cleanEnd === true);

    // D5: the same HEAD, the same quarantine - reused; the quarantine changed - a run again.
    set(1, []);
    x = ga({}, 'xw');
    ok('D5: the same HEAD and quarantine - "reused, HEAD", no run on the runner', x.status === 0 && /reused, HEAD /.test(x.stdout) && lines('full.count').length === 0, `${x.status} ${x.all}`);
    G.dropQuarantine(QF, ['srv/a-run.js']);
    set(1, []);
    x = ga({}, 'xw');
    ok('E4 x D5: an entry dropped from the quarantine - not reused, the runner runs again', x.status === 0 && !/reused, HEAD /.test(x.stdout) && lines('full.count').length === 1, `${x.status} ${x.all}`);

    // E3: the quarantine goes with the run; the runner subtracts it, reruns nothing.
    Q = q() || {};
    const before = read(QF);
    set(1, []);
    x = ga({}, '--force', 'xw');
    ok('E3: both in the quarantine here - the runner subtracts them: exit 0, no single rerun on the runner', x.status === 0 && lines('one.count').length === 0 && Object.keys(Q).length === 2, `${x.status} ${lines('one.count')} ${JSON.stringify(Q)}\n${out().slice(-800)}`);
    ok('E3: the log names both as known from the quarantine', /known red \(quarantine [^)]*\): srv\/a-run\.js — flaky: /.test(out()) && /known red \(quarantine [^)]*\): srv\/b-run\.js — flaky: /.test(out()), out());
    ok('E3: the runner got exactly the quarantine of this machine', JSON.stringify(JSON.parse(read(RQ) || 'null')) === JSON.stringify(Q), read(RQ));
    ok('E3: nothing new written here (the file unchanged)', read(QF) === before);

    // A2 through the runner: one red again alone, one flaky - only the flaky one is written.
    fs.writeFileSync(QF, '{}\n'); set(1, ['srv/a-run.js']);
    x = ga({}, '--force', 'xw');
    Q = q() || {};
    ok('A2 remote: a regression is never written, the flaky one is; the exit code stays red', x.status === 1 && Object.keys(Q).join(',') === 'srv/b-run.js', `${x.status} ${JSON.stringify(Q)}`);

    // A flaky line in a guard's own output (before the rerun section) is not taken.
    fs.writeFileSync(QF, '{}\n'); set(1, ['srv/a-run.js', 'srv/b-run.js'], ['flaky, red under load, green alone: srv/forged-run.js']);
    x = ga({}, '--force', 'xw');
    ok('only the rerun section counts: a "flaky, ..." line printed by a guard is never written', x.status === 1 && JSON.stringify(q()) === '{}', `${x.status} ${read(QF)}`);

    // Errors: a broken quarantine here - environment 69 before the run, the file not rewritten.
    for (const [what, body] of [['not JSON', 'not json\n'], ['not a flat object of strings', '{"srv/a-run.js": 1}\n']]) {
      fs.writeFileSync(QF, body); set(1, []);
      x = ga({}, '--force', 'xw');
      ok(`errors: the quarantine ${what} - exit 69, the log starts "environment: " and names the quarantine`, x.status === 69 && /^environment: .*quarantine/.test(out()), `${x.status} ${out().split('\n')[0]}`);
      ok(`errors: the quarantine ${what} - no run on the runner, the file not rewritten, meta 69`, lines('full.count').length === 0 && read(QF) === body && meta().rc === 69, `${lines('full.count')} ${read(QF)} ${JSON.stringify(meta())}`);
    }

    // E5: the runner unreachable - 69, nothing written.
    fs.writeFileSync(QF, '{}\n'); set(1, []);
    x = ga({ FAKE_SSH_FAIL: '1' }, '--force', 'xw');
    ok('E5: the network fails - exit 69, the quarantine unchanged', x.status === 69 && read(QF) === '{}\n', `${x.status} ${read(QF)}`);

    // D3 here: the write after the run fails (the lock is held) - an error line, the exit code unchanged, the meta keeps the hash read.
    fs.writeFileSync(QF, '{}\n'); set(1, []);
    fs.mkdirSync(QF + '.lock');
    x = ga({ CODIS_QUARANTINE_LOCK_MS: '300' }, '--force', 'xw');
    fs.rmSync(QF + '.lock', { recursive: true, force: true });
    ok('D3 remote: the write fails - "quarantine not written: ..." in the log, exit 0 stands, the file unchanged', x.status === 0 && /^quarantine not written: .*lock/m.test(out()) && read(QF) === '{}\n', `${x.status} ${read(QF)}\n${out().slice(-800)}`);
    ok('D3 remote: the meta keeps the hash of the quarantine the run read', meta().quarantine === G.quarantineHash(QF), JSON.stringify(meta()));

    // E4: a guard the runner does not run is flaky here - written by the part here; the meta has the hash of the end.
    fs.writeFileSync(QF, '{}\n'); set(1, [], ['skipped (needs-font): 1 — srv/font-run.js']);
    fs.writeFileSync(path.join(T, 'local.log'), 'X srv/font-run.js  (1.0s, code 1)\nTOTAL: 0 green, 1 NEW red\n'); fs.writeFileSync(path.join(T, 'local.rc'), '1');
    x = ga({}, '--force', 'xw');
    Q = q() || {};
    ok('E4: the runner\'s two and the part here\'s one - all three written, exit 0', x.status === 0 && Object.keys(Q).sort().join(',') === 'srv/a-run.js,srv/b-run.js,srv/font-run.js', `${x.status} ${JSON.stringify(Q)}\n${out().slice(-800)}`);
    ok('E4 x D5: the meta keeps the hash of the quarantine after both writes', meta().quarantine === G.quarantineHash(QF), JSON.stringify(meta()));

    // B1 remote: no guardBaseline - the quarantine is off: nothing sent, nothing written here.
    setCfg(false); fs.rmSync(QF, { force: true }); set(1, []);
    x = ga({}, '--force', 'xw');
    ok('B1 remote: no guardBaseline - exit 0, no quarantine here, none sent to the runner, "quarantine off" in the log', x.status === 0 && !fs.existsSync(QF) && !fs.existsSync(RQ) && /quarantine off: no guardBaseline/.test(out()), `${x.status} ${fs.existsSync(QF)} ${fs.existsSync(RQ)}\n${out().slice(-800)}`);
    ok('B1 remote: the meta has no quarantine hash', meta().quarantine === undefined, JSON.stringify(meta()));
    setCfg(true);

    // The runner's half: the quarantine sent with a run is checked and written into the run's directory; a refusal is 69.
    const H = require('../scripts/guards-remote-host');
    const hd = path.join(T, 'hostq'); fs.mkdirSync(hd);
    let e1 = null;
    try { H.writeQuarantine(hd, { 'srv/a-run.js': 2 }); } catch (e) { e1 = e; }
    ok('transfer: a quarantine that is not a flat object of strings - refused on the runner, environment 69', e1 && e1.code === 69 && /^environment: .*quarantine/.test(e1.message), e1 && e1.message);
    fs.mkdirSync(path.join(hd, 'guards-quarantine.json'));
    let e2 = null;
    try { H.writeQuarantine(hd, {}); } catch (e) { e2 = e; }
    ok('transfer: the runner cannot write the quarantine - environment 69', e2 && e2.code === 69 && /^environment: .*quarantine/.test(e2.message), e2 && e2.message);
    fs.rmSync(path.join(hd, 'guards-quarantine.json'), { recursive: true });
    try { H.writeQuarantine(hd, { 'srv/a-run.js': 'flaky: x' }); } catch { /* checked below */ }
    ok('transfer: a good quarantine is written as sent', (read(path.join(hd, 'guards-quarantine.json')) || '').replace(/\s/g, '') === '{"srv/a-run.js":"flaky:x"}', read(path.join(hd, 'guards-quarantine.json')));

    // F2: the living texts.
    const readme = read(path.join(ROOT, 'README.md')), rules = read(path.join(ROOT, 'rules', 'multi-agent.md'));
    ok('F2 rules: the rerun rule says the remote runner subtracts the quarantine and this machine writes it', /remote runner[^\n]*quarantine|quarantine[^\n]*remote runner/i.test(rules.split('\n').find((l) => /role:rerun/.test(l)) || ''));
    ok('F2 README: guards-all.sh row names --quarantine-read-only', /guards-all\.sh[^\n]*--quarantine-read-only/.test(readme));
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
