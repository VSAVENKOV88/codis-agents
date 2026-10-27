#!/usr/bin/env node
'use strict';
// p-train-b2, round after the analyst (cells K of analyst.md): the meta of a remote run describes the quarantine the
// run subtracted, not the one of the call. A start that attaches to a run of the same name and SHA gets the quarantine
// that run was begun with (the host's answer); the meta keeps the hash of the file here only when the call has the
// same entries, has no key when the call is --no-quarantine and the run subtracted nothing, and otherwise a mark that
// equals no hash (never reused). A runner that does not say which quarantine it was begun with counts as another.
// No network: ssh is a fake on PATH that runs the remote command with sh in a temporary "server" home (the fixture of
// tests/quarantine-remote-tester.test.js); FAKE_ATTACH_NO_Q makes it drop the quarantine of an attach answer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-attach-')));
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
let x;
try {
  if (!has('zsh') || !has('perl')) skip('attach x quarantine through the remote runner', 'zsh or perl not found');
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
const strip = !!process.env.FAKE_ATTACH_NO_Q;
const r = spawnSync('sh', ['-c', cmd], { stdio: ['inherit', strip ? 'pipe' : 'inherit', 'inherit'], env, cwd: ${JSON.stringify(S)}, encoding: 'utf8', maxBuffer: 1 << 29 });
if (strip) process.stdout.write(r.stdout.split('\\n').map((l) => {
  if (!l.startsWith('REMOTE-RESULT ')) return l;
  const o = JSON.parse(l.slice(14)); if (o && o.attached) delete o.quarantine; return 'REMOTE-RESULT ' + JSON.stringify(o);
}).join('\\n'));
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

    const RM = require('../scripts/guards-remote');
    const MARK = (m) => typeof m.quarantine === 'string' && m.quarantine !== G.quarantineHash(QF) && m.quarantine !== 'none' && !/^[0-9a-f]{16,}$/.test(m.quarantine);
    const Q1 = '{"srv/a-run.js": "flaky: earlier", "srv/b-run.js": "flaky: earlier"}\n';
    const GREEN = 'Guards to run: 2\n\nTOTAL: 2 green, 0 NEW red, 0 known red\n';
    // the first start: its waiting side is killed while the run goes (a wait step at its deadline)
    const first = (args, sleep, doneToo) => {
      fs.writeFileSync(path.join(T, 'full.sleep'), String(sleep));
      const p = spawn('zsh', [GA, '--force', ...args, 'xw'], { env: env(), cwd: T, stdio: 'ignore', detached: true });
      kids.push(p);
      const started = until(() => lines('full.count').length > 0, 60000);
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ }
      const ended = doneToo ? until(() => fs.existsSync(path.join(R, 'runs', 'xw', 'rc')), 60000) : true;
      fs.writeFileSync(path.join(T, 'full.sleep'), '');
      return started && ended;
    };
    const count = () => lines('full.count').length;

    // Unit: what an attach answer means for the meta (K1-K14).
    const A = (q, extra) => Object.assign({ attached: true, state: 'running', quarantine: q }, extra || {});
    const f = RM.attachedOther;
    ok('K unit: attachedOther is exported', typeof f === 'function');
    if (typeof f === 'function') {
      const q1 = { a: 'x', b: 'y' };
      ok('K15/K16: a new start (not an attach) is never another quarantine', f({ attached: false }, '', undefined) === false && f({ attached: false }, 'qf', q1) === false);
      ok('K4/K5: the same entries, key order aside - not another', f(A(q1), 'qf', { b: 'y', a: 'x' }) === false);
      ok('K1/K6/K7: a subset, a superset, another reason - another', f(A(q1), 'qf', { a: 'x' }) === true && f(A(q1), 'qf', { a: 'x', b: 'y', c: 'z' }) === true && f(A(q1), 'qf', { a: 'x', b: 'z' }) === true);
      ok('K8/K9: --no-quarantine, the run subtracted entries - another', f(A(q1), '', undefined) === true && f(A(q1, { state: 'done' }), '', undefined) === true);
      ok('K11/K12: --no-quarantine, the run was begun with {} or none - not another (it subtracted nothing)', f(A({}), '', undefined) === false && f(A(null), '', undefined) === false);
      ok('K13: a run begun with none, a call with a quarantine (even {}) - another', f(A(null), 'qf', {}) === true && f(A(null), 'qf', q1) === true);
      ok('K14: an attach answer without the field - another, with a file and with --no-quarantine', f({ attached: true, state: 'running' }, 'qf', q1) === true && f({ attached: true, state: 'running' }, '', undefined) === true);
      ok('K14: an answer that is not an object of entries - another for --no-quarantine', f(A('x'), '', undefined) === true && f(A([]), '', undefined) === true);
    }

    // K9: Q1 / --no-quarantine / done and not fetched.
    fs.writeFileSync(QF, Q1); set(1, ['srv/a-run.js', 'srv/b-run.js']);
    {
      const st = first([], 2, true);
      x = ga({}, '--force', '--no-quarantine', 'xw');
      const m = meta();
      ok('K9: --no-quarantine attaches to the done run begun with Q1 - its exit, the "another quarantine" line', st && /attached to the run .*\(done\)/.test(x.all) && x.status === 0 && /another quarantine/.test(x.all) && count() === 1, `${st} ${x.status}\n${x.all.slice(-800)}`);
      ok('K9: nothing written here, the meta holds the mark (the key is there)', read(QF) === Q1 && MARK(m), JSON.stringify(m));
      G.dropQuarantine(QF, ['srv/a-run.js', 'srv/b-run.js']);
      x = ga({}, 'xw');
      ok('K9: after the drop the next call is not reused (a, b red alone -> exit 1)', !/reused, HEAD /.test(x.stdout) && x.status === 1, `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-600)}`);
    }

    // K10: Q1 / --no-quarantine / running, with a part here (remoteRun.localPattern).
    fs.writeFileSync(QF, Q1); set(1, ['srv/a-run.js', 'srv/b-run.js'], ['skipped (needs-font): 1 — srv/f-run.js']);
    {
      const st = first([], 4, false);
      x = ga({}, '--force', '--no-quarantine', 'xw');
      const m = meta();
      ok('K10: attached, the part here ran, exit 0', st && /attached to the run /.test(x.all) && lines('local.count').length === 1 && x.status === 0, `${x.status} ${lines('local.count')}\n${x.all.slice(-800)}`);
      ok('K10: the meta holds the mark', MARK(m), JSON.stringify(m));
      G.dropQuarantine(QF, ['srv/a-run.js', 'srv/b-run.js']);
      x = ga({}, 'xw');
      ok('K10: after the drop the next call is not reused (exit 1)', !/reused, HEAD /.test(x.stdout) && x.status === 1, `${x.status}\n${x.all.slice(-600)}`);
    }

    // K14: a runner whose attach answer has no quarantine field, the call --no-quarantine (and with the file).
    for (const args of [['--no-quarantine'], []]) {
      const k = args.length ? '--no-quarantine' : 'with the file';
      fs.writeFileSync(QF, Q1); set(1, ['srv/a-run.js', 'srv/b-run.js']);
      const st = first([], 4, false);
      x = ga({ env: { FAKE_ATTACH_NO_Q: '1' } }, '--force', ...args, 'xw');
      const m = meta();
      ok(`K14 (${k}): attached to a run of a runner that does not say its quarantine - exit 0, the meta holds the mark`, st && /attached to the run /.test(x.all) && x.status === 0 && MARK(m), `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-800)}`);
      fs.writeFileSync(path.join(T, 'full.count'), '');
      x = ga({}, 'xw');
      ok(`K14 (${k}): the next call is not reused (the runner runs again)`, !/reused, HEAD /.test(x.stdout) && count() === 1, `${count()}\n${x.all.slice(-600)}`);
    }

    // K11: a run begun with {} (no file) / --no-quarantine - it subtracted nothing: no key, the next call is reused.
    fs.rmSync(QF, { force: true }); set(0, []); fs.writeFileSync(path.join(T, 'full.log'), GREEN);
    {
      const st = first([], 4, false);
      x = ga({}, '--force', '--no-quarantine', 'xw');
      const m = meta();
      ok('K11: attached, exit 0, no "another quarantine" line, the meta has no quarantine key', st && /attached to the run /.test(x.all) && x.status === 0 && !/another quarantine/.test(x.all) && !('quarantine' in m), `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-800)}`);
      fs.writeFileSync(path.join(T, 'full.count'), '');
      x = ga({}, 'xw');
      ok('K11: the next call on the same HEAD is reused', x.status === 0 && /reused, HEAD /.test(x.stdout) && count() === 0, x.all.slice(-400));
    }

    // K13: a run begun with --no-quarantine / a call with Q1: the mark; the flaky of the run are written here.
    fs.writeFileSync(QF, '{"srv/z-run.js": "flaky: other"}\n'); set(1, []);
    {
      const st = first(['--no-quarantine'], 4, false);
      x = ga({}, '--force', 'xw');
      const m = meta(), Qk = q() || {};
      ok('K13: attached, exit 0, the "another quarantine" line, a and b written here', st && /attached to the run /.test(x.all) && x.status === 0 && /another quarantine/.test(x.all)
        && /^flaky: guards-xw\.txt /.test(Qk['srv/a-run.js'] || '') && /^flaky: guards-xw\.txt /.test(Qk['srv/b-run.js'] || ''), `${x.status} ${JSON.stringify(Qk)}\n${x.all.slice(-800)}`);
      ok('K13: the meta holds the mark, not the hash of the file after the write', MARK(m), JSON.stringify(m));
      fs.writeFileSync(path.join(T, 'full.count'), '');
      x = ga({}, 'xw');
      ok('K13: the next call is not reused (the runner runs again)', !/reused, HEAD /.test(x.stdout) && count() === 1, `${count()}\n${x.all.slice(-600)}`);
    }

    // K2: Q1 / a subset (an entry dropped) / done and not fetched.
    fs.writeFileSync(QF, Q1); set(1, ['srv/a-run.js', 'srv/b-run.js']);
    {
      const st = first([], 2, true);
      G.dropQuarantine(QF, ['srv/a-run.js']);
      x = ga({}, '--force', 'xw');
      const m = meta();
      ok('K2: attached to the done run, exit 0, "another quarantine", the meta holds the mark', st && /attached to the run .*\(done\)/.test(x.all) && x.status === 0 && /another quarantine/.test(x.all) && MARK(m), `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-800)}`);
      x = ga({}, 'xw');
      ok('K2: the next call is not reused (a red alone -> exit 1)', !/reused, HEAD /.test(x.stdout) && x.status === 1, `${x.status}\n${x.all.slice(-600)}`);
    }

    // K4: Q1 / the same file, the same bytes / running: the hash, the next call reused with no ssh at all.
    fs.writeFileSync(QF, Q1); set(1, ['srv/a-run.js', 'srv/b-run.js']);
    {
      const st = first([], 4, false);
      x = ga({}, '--force', 'xw');
      const m = meta();
      ok('K4: attached, exit 0, no "another quarantine" line, the meta keeps the hash of the file here', st && /attached to the run /.test(x.all) && x.status === 0 && !/another quarantine/.test(x.all) && m.quarantine === G.quarantineHash(QF), `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-800)}`);
      fs.rmSync(sshLog, { force: true });
      x = ga({}, 'xw');
      ok('K4: the next call is reused, ssh not called', x.status === 0 && /reused, HEAD /.test(x.stdout) && lines('ssh.log').length === 0, `${lines('ssh.log').length}\n${x.all.slice(-400)}`);
    }

    // K6: Q1 / a superset (another run wrote c meanwhile) / running: the mark, not reused.
    fs.writeFileSync(QF, '{"srv/a-run.js": "flaky: earlier"}\n'); set(1, ['srv/a-run.js']);
    {
      const st = first([], 4, false);
      G.addQuarantine(QF, { 'srv/c-run.js': 'flaky: another run' });
      x = ga({}, '--force', 'xw');
      const m = meta();
      ok('K6: attached, "another quarantine", the meta holds the mark', st && /attached to the run /.test(x.all) && /another quarantine/.test(x.all) && MARK(m), `${x.status} ${JSON.stringify(m)}\n${x.all.slice(-800)}`);
      fs.writeFileSync(path.join(T, 'full.count'), '');
      x = ga({}, 'xw');
      ok('K6: the next call is not reused (the runner runs again)', !/reused, HEAD /.test(x.stdout) && count() === 1, `${count()}\n${x.all.slice(-600)}`);
    }

    // T1: the living texts name the --no-quarantine attach.
    const readme = read(path.join(ROOT, 'README.md')) || '', head = read(path.join(ROOT, 'scripts', 'guards-remote.js')) || '';
    ok('T1 README: the guardBaseline row says an attach of a call without the quarantine to a run begun with one is never reused', /--no-quarantine[^|]*attach|attach[^|]*--no-quarantine/.test(readme.split('\n').find((l) => l.startsWith('| `guardBaseline`')) || ''));
    ok('T1 guards-remote.js header (7) names the --no-quarantine attach', /^\/\/ .*--no-quarantine/m.test(head.split('// usage:')[0].split('//   7.')[1] || ''));
  }
} finally {
  for (const p of kids) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } try { p.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(T, { recursive: true, force: true });
}
done();
