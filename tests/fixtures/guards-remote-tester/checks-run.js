#!/usr/bin/env node
'use strict';
// Tester guard of remote-runs-b2a (a fixture: the tester may write only guards and fixtures; a tests/*.test.js wrapper is
// to run it as part of the suite): guards-all.sh with the machine key remote, end to end through a fake ssh that runs the
// remote command with sh in a temporary "server" home (git's own receive-pack included), as tests/guards-remote.test.js
// does. The cells here are the ones that test does not hold, most of them on the attack surface (what crosses from the
// runner back to this machine, and what the commit or the donor may carry onto the runner):
//   T-1 the guards the runner names for this machine (remoteRun.localPattern over the runner's log) never reach a shell
//       here as code: a name with $( ), backticks, ; or a quote is one literal --only argument, nothing is executed.
//   T-2 a dependency file that the commit holds as a symbolic link (to a file outside the worktree) is refused
//       (environment, 69) before anything is copied into the dependency cache: the target's content never lands there.
//   T-3 a worktree name the runner cannot take (a space) is refused here with 78 before any ssh.
//   T-4 a .env* in another case (.ENV.local) inside the donor copy is refused before any guard runs (69); a .env* the
//       commit itself tracks is not refused.
//   T-5 --local with the remote key runs here: no ssh, a local meta (no env).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('../../lib');

const ROOT = path.join(__dirname, '..', '..', '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-remote-tester-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs'), sshLog = path.join(T, 'ssh.log');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lines = (f) => (read(f) || '').split('\n').filter(Boolean);

function walkFiles(top) {
  const out = [];
  (function w(d) {
    let ns = [];
    try { ns = fs.readdirSync(d); } catch { return; }
    for (const n of ns) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      if (st.isDirectory()) w(p); else out.push(p);
    }
  })(top);
  return out;
}

try {
  if (!has('zsh') || !has('perl')) {
    skip('guards-remote tester cells', 'zsh or perl not found');
  } else {
    for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    // The memory probes of the slots (macOS names), so the heavy slot here never waits on the real machine.
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
    // full.sh - the runner's guard command: prints full.log, exits 0; local.sh - the subset command here: one line per
    // argument into local.args (so the arguments it got are seen exactly), exit 0.
    put('full.sh', `#!/bin/sh\necho "$PWD" >> "${T}/full.count"\ncat "${T}/full.log"\nexit 0\n`, 0o755);
    put('local.sh', `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${T}/local.args"; done\necho "local: $#"\nexit 0\n`, 0o755);
    put('pkg/package.json', '{"name":"pkg"}\n'); put('pkg/package-lock.json', '{"lockfileVersion":3}\n');
    put('.env.example', 'TRACKED=1\n');
    put('.gitignore', 'pkg/data/\npkg/node_modules\n');
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
    // A second commit on its own branch: the lock file is a symbolic link to a file outside the worktree (T-2).
    fs.writeFileSync(path.join(T, 'outside-secret.txt'), 'OUTSIDE-SECRET-CONTENT\n');
    git(main, 'checkout', '-q', '-b', 'linked');
    fs.rmSync(path.join(main, 'pkg', 'package-lock.json'));
    fs.symlinkSync(path.join(T, 'outside-secret.txt'), path.join(main, 'pkg', 'package-lock.json'));
    git(main, 'add', 'pkg/package-lock.json'); git(main, 'commit', '-q', '-m', 'lock file as a link');
    git(main, 'checkout', '-q', 'trunk');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'aw'), 'trunk');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'lw'), 'linked');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'sp ace'), 'trunk');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'ew'), 'trunk');
    const aw = path.join(wts, 'aw');

    fs.writeFileSync(path.join(T, 'key'), 'not a key\n'); fs.writeFileSync(path.join(T, 'kh'), 'example.org ssh-ed25519 AAAA\n');
    const remote = { host: 'example.org', user: 'runner', key: path.join(T, 'key'), knownHosts: path.join(T, 'kh'), root: '~/codis-runs', plugin: ROOT };
    const mfile = path.join(T, 'machine.json');
    fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(T, 'slots') }, remote }));
    fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
    const cfgFile = path.join(T, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}',
      guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', worktreeSetup: { scan: ['pkg'] }, protectedBranches: ['trunk'],
      remoteRun: { command: 'cd {wt} && ./full.sh {jobs} --no-font',
        deps: [{ files: ['pkg/package.json', 'pkg/package-lock.json'], install: 'mkdir -p node_modules && echo ok > node_modules/marker', link: { 'pkg/node_modules': 'node_modules' } }],
        localPattern: '^skipped \\(needs-font\\): \\d+ — (.+)$' } }));
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_WORKTREE_ROOT', 'CODIS_SHARED_DIR', 'CODIS_REPO_DIR']) delete process.env[k];
    const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
      SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV });
    const ga = (...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 180000 });
    const reset = (log) => { fs.writeFileSync(path.join(T, 'full.log'), log); for (const f of ['full.count', 'local.args', 'pwned', 'pwned2', 'pwned3']) fs.rmSync(path.join(T, f), { force: true }); fs.rmSync(sshLog, { force: true }); };
    const out = (n) => read(path.join(shared, `guards-${n}.txt`)) || '';
    const meta = (n) => { try { return JSON.parse(read(path.join(shared, `guards-${n}.txt.meta.json`))); } catch { return {}; } };
    // The donor: a complete corpus on the runner, as corpus-sync.js leaves it.
    const cr = (op, input) => JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'corpus-remote.js'), op, JSON.stringify(Object.assign({ root: R }, input || {}))], { encoding: 'utf8' }).stdout.trim().split('\n').pop().slice('CORPUS-RESULT '.length));
    const donorWith = (extra) => {
      cr('begin', { id: 'x' });
      fs.rmSync(path.join(R, 'corpus'), { recursive: true, force: true });
      fs.mkdirSync(path.join(R, 'corpus', 'pkg', 'data'), { recursive: true });
      fs.writeFileSync(path.join(R, 'corpus', 'pkg', 'data', 'big.json'), '{"corpus":1}\n');
      for (const [f, s] of Object.entries(extra || {})) { fs.mkdirSync(path.dirname(path.join(R, 'corpus', f)), { recursive: true }); fs.writeFileSync(path.join(R, 'corpus', f), s); }
      cr('finish', { expectId: cr('scan').id });
    };
    donorWith();

    // ---- T-1: names from the runner's log never run as code here ----
    const evil = [
      'srv/font-run.js',
      `srv/a$(touch ${T}/pwned).js`,
      `srv/b\`touch ${T}/pwned2\`.js`,
      `srv/c'; touch ${T}/pwned3; echo '.js`,
    ];
    reset(['Guards to run: 2', '', 'TOTAL: 2 green, 0 NEW red', `skipped (needs-font): ${evil.length} — ${evil.join(', ')}`].join('\n') + '\n');
    let x = ga('--force', 'aw');
    const args = lines(path.join(T, 'local.args'));
    ok('T-1: the run ends 0 with the part here', x.status === 0, `${x.status} ${x.stdout}${x.stderr}`);
    ok('T-1: no name from the runner log was executed here ($( ), backticks, quote and ;)', !['pwned', 'pwned2', 'pwned3'].some((f) => fs.existsSync(path.join(T, f))),
      ['pwned', 'pwned2', 'pwned3'].filter((f) => fs.existsSync(path.join(T, f))).join(' '));
    ok('T-1: each name reached the subset command as one literal --only argument', evil.every((n) => args.some((a, i) => a === n && args[i - 1] === '--only')), JSON.stringify(args));

    // ---- T-2: a lock file held as a link in the commit is refused before the cache gets anything ----
    reset('TOTAL: 0 green\n');
    x = ga('--force', 'lw');
    const leaked = walkFiles(path.join(R, 'deps')).filter((f) => (read(f) || '').includes('OUTSIDE-SECRET-CONTENT'));
    ok('T-2: a dependency file that is a link in the commit - exit 69, the log starts with "environment:" and names it',
      x.status === 69 && /^environment: /.test(out('lw')) && out('lw').includes('pkg/package-lock.json'), `${x.status}\n${out('lw')}\n${x.stdout}${x.stderr}`);
    ok('T-2: the link target never reached the dependency cache', leaked.length === 0, leaked.join(' '));
    ok('T-2: no guard ran', !fs.existsSync(path.join(T, 'full.count')));

    // ---- T-3: a worktree name the runner cannot take - 78 here, no ssh ----
    reset('TOTAL: 0 green\n');
    x = ga('--force', 'sp ace');
    ok('T-3: a worktree name with a space - exit 78 before any ssh, the name named', x.status === 78 && !fs.existsSync(sshLog) && (x.stdout + x.stderr).includes('sp ace'), `${x.status} ssh:${fs.existsSync(sshLog)} ${x.stdout}${x.stderr}`);

    // ---- T-4: .env* in another case inside the donor copy - refused before any guard; a tracked .env* is not ----
    ok('T-4: the main flow above kept the tracked .env.example (not refused)', meta('aw').rc === 0 && /^ran on runner /.test(out('aw')), JSON.stringify(meta('aw')));
    donorWith({ 'pkg/data/.ENV.local': 'SECRET=1\n' });
    reset('TOTAL: 1 green\n');
    x = ga('--force', 'ew');
    ok('T-4: .ENV.local in the donor copy - exit 69, refused before any guard, the file named',
      x.status === 69 && /^environment: /.test(out('ew')) && out('ew').includes('.ENV.local') && !fs.existsSync(path.join(T, 'full.count')), `${x.status}\n${out('ew')}`);
    donorWith();

    // ---- T-5: --local keeps the run here even with the remote key ----
    reset('TOTAL: 1 green\n');
    x = ga('--force', '--local', 'aw');
    ok('T-5: --local with the remote key - exit 0, the guard command ran here, no ssh', x.status === 0 && lines(path.join(T, 'full.count'))[0] === aw && !fs.existsSync(sshLog), `${x.status} ssh:${fs.existsSync(sshLog)} ${x.stdout}${x.stderr}`);
    ok('T-5: the meta of that run is local (no env) and the log has no runner header', meta('aw').env === undefined && !/^ran on runner/.test(out('aw')), JSON.stringify(meta('aw')));
  }
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  // The runner's detached jobs are done by now (every run above was waited for); the slots there are plain files.
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
}
done();
