#!/usr/bin/env node
'use strict';
// guards-all.sh with the machine key `remote` (part B2a of the remote-runs matrix, cells B2a-1..B2a-23): the full run of
// a worktree goes to the remote runner - the committed HEAD is pushed over ssh into <root>/repo.git
// (refs/runs/<name>/<sha>), the runner prepares <root>/wt/<name> (worktree, dependency cache by lock-file hash, its own
// copy of the donor corpus, the project's prepare commands), runs its own guards-all.sh detached from ssh, reruns new
// reds there, and this machine fetches the log, writes it with a header and a meta record (env remote:<host>), runs the
// guards the runner does not run (remoteRun.localPattern) in a heavy slot here and exits with the worse code.
// No network: ssh is a fake on PATH that runs the remote command with sh in a temporary "server" home (git's own
// receive-pack included); the "server" plugin is this checkout. B2a-19 (worker counts measured on the real runner) and
// the comparison with a run on this machine are the tester's acceptance in the real environment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/config');
const G = require('../scripts/guards-result');
const zsh = has('zsh') && has('perl');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-remote-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs'), sshLog = path.join(T, 'ssh.log');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const count = (f) => (read(path.join(T, f)) || '').split('\n').filter(Boolean).length;
const sshCalls = () => (read(sshLog) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const until = (f, s) => { const t = Date.now() + s * 1000; while (Date.now() < t) { if (f()) return true; sleep(0.1); } return f(); };

// A runner log: progress, a section of new reds, the tally, and the line of guards the runner skipped (needs-font).
const LOG = (skipped) => [
  'Guards to run: 4',
  '',
  '---- NEW RED ----',
  'X srv/a-run.js  (1.0s, code 1)',
  'X srv/b-run.js  (2.0s, code 1)',
  '',
  'TOTAL: 2 green, 2 NEW red, 0 known red',
  ...(skipped ? ['skipped (needs-font): 1 — srv/font-run.js'] : []),
].join('\n') + '\n';
let asyncDone = false;
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^[XT] (\\S+(?: \\S+)*?)  \\(', tallyPattern: '^TOTAL: ' };

try {
  // ---- schema and config (no zsh needed) ----
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'cd {wt} && run' };
  const machine = (remote) => {
    const f = path.join(T, 'm-check.json');
    fs.writeFileSync(f, JSON.stringify({ configVersion: 1, remote }));
    return C.loadMachine({ CODIS_AGENTS_MACHINE: f });
  };
  const good = { host: 'example.org', user: 'runner', key: '/k', knownHosts: '/kh', root: '~/codis-runs' };
  ok('config: a remote without plugin resolves, plugin defaults to the plugin directory of the runner',
    machine(good).errors.length === 0 && machine(good).values.remote.plugin === '~/.claude/plugins/marketplaces/codis-agents', machine(good).errors.join('; '));
  const without = (k) => { const r = Object.assign({}, good); delete r[k]; return r; };
  ok('B2a-2: remote without host or knownHosts - an error naming the key', /remote\.host: required/.test(machine(without('host')).errors.join('; '))
    && /remote\.knownHosts: required/.test(machine(without('knownHosts')).errors.join('; ')));
  ok('B2a-2: remote.host of a wrong type - an error naming the key', /remote\.host: expected string/.test(machine(Object.assign({}, good, { host: 22 })).errors.join('; ')));
  ok('remote.host with ":" is refused (scp-like git and rsync addresses split at the colon)', /remote\.host:/.test(machine(Object.assign({}, good, { host: 'a:b' })).errors.join('; ')));
  ok('remote.plugin: absolute or ~/, shell-safe characters only', /remote\.plugin:/.test(machine(Object.assign({}, good, { plugin: 'rel/dir' })).errors.join('; '))
    && /remote\.plugin:/.test(machine(Object.assign({}, good, { plugin: '/a b' })).errors.join('; ')) && !machine(Object.assign({}, good, { plugin: '/opt/codis-agents' })).errors.length);
  const rr = (x) => C.resolve(Object.assign({}, base, { remoteRun: x }), { machine: machine(good) });
  ok('config: remoteRun resolves with defaults (command = guardCommand, empty deps and prepare)', (() => { const r = rr({});
    return !r.errors.length && r.config.remoteRun.command === base.guardCommand && r.config.remoteRun.deps.length === 0 && r.config.remoteRun.prepare.length === 0; })(), rr({}).errors.join('; '));
  ok('config: the resolved config carries the machine remote (null without it)', rr({}).config.remote && rr({}).config.remote.host === 'example.org'
    && C.resolve(base, { machine: machine(undefined) }).config.remote === null);
  ok('config: remoteRun.deps entries need files, install and link, relative paths without ..', /remoteRun\.deps\[0\]\.install: required/.test(rr({ deps: [{ files: ['a/package.json'], link: { 'a/node_modules': 'node_modules' } }] }).errors.join('; '))
    && /remoteRun\.deps\[0\]\.files/.test(rr({ deps: [{ files: ['../x'], install: 'npm ci', link: { 'a/node_modules': 'node_modules' } }] }).errors.join('; '))
    && /remoteRun\.deps\[0\]\.link/.test(rr({ deps: [{ files: ['a/p.json'], install: 'npm ci', link: { '/abs': 'node_modules' } }] }).errors.join('; '))
    && /remoteRun\.deps\[0\]\.files/.test(rr({ deps: [{ files: ['a/p.json', 'b/p.json'], install: 'npm ci', link: { 'a/n': '' } }] }).errors.join('; ')), rr({ deps: [{}] }).errors.join('; '));
  ok('config: remoteRun.localPattern needs a capture group, localCommand needs {wt} and {onlyArgs}', /remoteRun\.localPattern/.test(rr({ localPattern: '^x' }).errors.join('; '))
    && /remoteRun\.localCommand/.test(rr({ localPattern: '^(x)', localCommand: 'cd {wt} && run' }).errors.join('; ')) && /remoteRun\.localPattern: needs remoteRun\.localCommand or guardSubsetCommand/.test(rr({ localPattern: '^(x)' }).errors.join('; ')));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents.schema.json'), 'utf8'));
  const mschema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents-machine.schema.json'), 'utf8'));
  ok('schema: remoteRun keys = config.js', schema.properties.remoteRun && JSON.stringify(Object.keys(schema.properties.remoteRun.properties).sort()) === JSON.stringify(Object.keys(C.REMOTE_RUN_SPEC || {}).sort()));
  ok('schema: machine remote keys = config.js, host without ":"', JSON.stringify(Object.keys(mschema.properties.remote.properties).sort()) === JSON.stringify(Object.keys(C.REMOTE_SPEC).sort())
    && !new RegExp(mschema.properties.remote.properties.host.pattern).test('a:b'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('README: the config table explains remoteRun, guards-all.sh names the remote run', /\| `remoteRun` \|[^\n]*deps[^\n]*localPattern/.test(readme) && /guards-all\.sh[^\n]*remote/.test(readme));
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  ok('rules: the remote full run is described (committed HEAD only, environment exit 69)', /remote runner[^\n]*full/i.test(rules) && /69/.test(rules));

  // ---- reuse across environments (B2a-3, B2a-4), no ssh at all ----
  const rrepo = path.join(T, 'rrepo');
  fs.mkdirSync(rrepo); git(rrepo, 'init', '-q'); fs.writeFileSync(path.join(rrepo, 'f'), 'x'); git(rrepo, 'add', 'f'); git(rrepo, 'commit', '-q', '-m', 'f');
  const rlog = path.join(T, 'guards-rrepo.txt');
  fs.writeFileSync(rlog, 'TOTAL\n');
  G.metaStart(rrepo, rlog, 'CMD'); G.metaEnd(rrepo, rlog, 0);
  ok('B2a-4: a meta without env is a local run: reused locally', G.reusable(rrepo, rlog, 'CMD').reuse && G.reusable(rrepo, rlog, 'CMD', 'local').reuse);
  let u = G.reusable(rrepo, rlog, 'CMD', 'remote:example.org');
  ok('B2a-4: a local meta, remote now - not reused, "environment changed (local -> remote:<host>)"', !u.reuse && /environment changed \(local -> remote:example\.org\)/.test(u.reason), u.reason);
  G.metaStart(rrepo, rlog, 'CMD', 'remote:example.org'); G.metaEnd(rrepo, rlog, 0);
  ok('B2a-3: a remote meta, the same runner - reused', G.reusable(rrepo, rlog, 'CMD', 'remote:example.org').reuse);
  u = G.reusable(rrepo, rlog, 'CMD');
  ok('B2a-4: a remote meta, local now - not reused', !u.reuse && /environment changed \(remote:example\.org -> local\)/.test(u.reason), u.reason);
  ok('B2a-4: another runner - not reused', !G.reusable(rrepo, rlog, 'CMD', 'remote:other.test').reuse);
  ok('meta: the env is recorded', JSON.parse(read(rlog + '.meta.json')).env === 'remote:example.org');

  // ---- the donor lock (corpus-remote.js withLock; B2a-14 tail of C) ----
  const CR = require('../scripts/corpus-remote');
  if (!has('perl')) skip('withLock', 'perl not found');
  else {
    const lf = path.join(T, 'x.lock');
    const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'corpus-remote.js'))}).withLock(${JSON.stringify(lf)}, { timeoutS: 10 }, () => { require('fs').writeFileSync(${JSON.stringify(lf + '.held')}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); })`], { stdio: 'ignore' });
    until(() => fs.existsSync(lf + '.held'), 10);
    let err = null;
    try { CR.withLock(lf, { timeoutS: 0.3 }, () => {}); } catch (e) { err = e; }
    ok('withLock: a held lock - waits, then refuses after its timeout with an environment message', err && err.code === 69 && /environment: .*lock/.test(err.message), err && err.message);
    let ran = false;
    CR.withLock(lf, { timeoutS: 10 }, () => { ran = true; });
    ok('withLock: the holder ends - the lock is given', ran);
    holder.kill();
  }

  if (!zsh) {
    skip('guards-all.sh remote end to end', 'zsh or perl not found');
  } else {
    // ---- the fixture ----
    for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    // ssh: logs its arguments; the command after the destination runs with sh in the server home (its working
    // directory too, as sshd starts a session there), stdin passed through, the environment only PATH, HOME and
    // FAKE_SERVER_ENV (JSON) - nothing of this machine leaks. FAKE_SSH_FAIL=1 - the host does not answer.
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
    // The project: a runner that logs its arguments and the worktree it runs in, prints full.log and exits full.rc
    // (after full.sleep seconds); one.sh - a single rerun (red when listed in red.txt); local.sh - the subset runner
    // of this machine.
    const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
    put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/full.count"\n[ -s "${T}/full.sleep" ] && sleep "$(cat "${T}/full.sleep")"\ncat "${T}/full.log"\nexit $(cat "${T}/full.rc")\n`, 0o755);
    put('one.sh', `#!/bin/sh\necho "$PWD $1" >> "${T}/one.count"\ngrep -qxF -- "$1" "${T}/red.txt" && exit 1\nexit 0\n`, 0o755);
    put('local.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/local.count"\necho "local runner: $*"\nexit $(cat "${T}/local.rc")\n`, 0o755);
    put('pkg/package.json', '{"name":"pkg"}\n'); put('pkg/package-lock.json', '{"lockfileVersion":3}\n');
    put('tool/package.json', '{"name":"tool"}\n'); put('tool/package-lock.json', '{"lockfileVersion":3,"t":1}\n');
    put('.gitignore', 'pkg/data/\npkg/node_modules\npkg/.deps\n');
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
    for (const n of ['xw', 'yw']) git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, n));
    const xw = path.join(wts, 'xw'), yw = path.join(wts, 'yw');
    const head = (w) => git(w, 'rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(T, 'key'), 'not a key\n'); fs.writeFileSync(path.join(T, 'kh'), 'example.org ssh-ed25519 AAAA\n');
    const remote = { host: 'example.org', user: 'runner', key: path.join(T, 'key'), knownHosts: path.join(T, 'kh'), root: '~/codis-runs', plugin: ROOT };
    const mfile = path.join(T, 'machine.json');
    const setMachine = (r) => fs.writeFileSync(mfile, JSON.stringify(Object.assign({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(T, 'slots') } }, r === undefined ? {} : { remote: r })));
    // The runner's own machine file: its slots, no remote (a runner never forwards a run).
    fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
    const install = (n) => `mkdir -p node_modules && echo ok > node_modules/marker && echo "${n} $PWD" >> "${T}/install.count"`;
    const remoteRun = (x) => Object.assign({
      command: 'cd {wt} && ./full.sh {jobs} --no-font',
      deps: [
        { files: ['pkg/package.json', 'pkg/package-lock.json'], install: install('pkg'), link: { 'pkg/node_modules': 'node_modules' } },
        { files: ['tool/package.json', 'tool/package-lock.json'], install: install('tool'), link: { 'pkg/.deps': '' } },
      ],
      prepare: [`echo "$PWD" >> "${T}/prepare.count"`],
      localPattern: '^skipped \\(needs-font\\): \\d+ — (.+)$',
    }, x || {});
    const cfgFile = path.join(T, 'cfg.json');
    const setCfg = (x, drop) => { const c = { repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}', guardRerun: RERUN,
      guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', worktreeSetup: { scan: ['pkg'] }, protectedBranches: ['trunk'], remoteRun: remoteRun(x) };
      if (drop) delete c.remoteRun; fs.writeFileSync(cfgFile, JSON.stringify(c)); };
    const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_WORKTREE_ROOT', 'CODIS_SHARED_DIR', 'CODIS_REPO_DIR']) delete process.env[k];
    const env = (extra) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
      SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV }, extra || {});
    const ga = (...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env: env(), timeout: 180000 });
    const gaBg = (...a) => spawn('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { env: env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (p) => new Promise((res) => { let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', (code) => res({ status: code, out: o })); });
    const set = (rc, red, skipped, sleepS) => {
      fs.writeFileSync(path.join(T, 'full.log'), LOG(skipped)); fs.writeFileSync(path.join(T, 'full.rc'), String(rc)); fs.writeFileSync(path.join(T, 'local.rc'), '0');
      fs.writeFileSync(path.join(T, 'red.txt'), red.map((x) => x + '\n').join('')); fs.writeFileSync(path.join(T, 'full.sleep'), sleepS ? String(sleepS) : '');
      for (const c of ['full.count', 'one.count', 'local.count', 'prepare.count']) fs.rmSync(path.join(T, c), { force: true });
      fs.rmSync(sshLog, { force: true }); fs.rmSync(path.join(T, 'slots', 'journal.tsv'), { force: true });
    };
    const journal = () => (read(path.join(T, 'slots', 'journal.tsv')) || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
    const out = (n) => read(path.join(shared, `guards-${n}.txt`)) || '';
    const meta = (n) => JSON.parse(read(path.join(shared, `guards-${n}.txt.meta.json`)) || '{}');
    // The donor: a complete corpus on the runner (corpus-remote.js, as corpus-sync.js leaves it).
    const cr = (op, input) => JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'corpus-remote.js'), op, JSON.stringify(Object.assign({ root: R }, input || {}))], { encoding: 'utf8' }).stdout.trim().split('\n').pop().slice('CORPUS-RESULT '.length));
    cr('begin', { id: 'x' });
    fs.mkdirSync(path.join(R, 'corpus', 'pkg', 'data'), { recursive: true }); fs.writeFileSync(path.join(R, 'corpus', 'pkg', 'data', 'big.json'), '{"corpus":1}\n');
    cr('finish', { expectId: cr('scan').id });
    const donorId = cr('status').scanId;
    // B2a-14 (C tail): a copy reads the donor only under corpus.lock - a holder of the lock (a sync's begin) delays it.
    const held = path.join(T, 'corpus-held');
    const lockHolder = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'corpus-remote.js'))}).withLock(${JSON.stringify(path.join(R, 'corpus.lock'))}, { timeoutS: 10 }, () => { require('fs').writeFileSync(${JSON.stringify(held)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); })`], { stdio: 'ignore' });
    until(() => fs.existsSync(held), 10);
    const tc = Date.now(); const cp = cr('copy', { name: 'locktest' }); const waited = Date.now() - tc;
    ok('B2a-14: the donor copy waits for corpus.lock held by another job, then copies', waited >= 1000 && cp.files === 1, `${waited} ms ${JSON.stringify(cp)}`);
    lockHolder.kill(); fs.rmSync(path.join(R, 'wt', 'locktest'), { recursive: true, force: true });

    // B2a-1: no key remote - the run stays here as before, ssh is never called.
    setMachine(); setCfg(); set(0, [], false);
    let x = ga('--force', 'xw');
    ok('B2a-1: no remote key - a local run in the worktree here, exit 0, no ssh', x.status === 0 && count('full.count') === 1 && read(path.join(T, 'full.count')).startsWith(xw + ' ') && !fs.existsSync(sshLog), `${x.status} ${x.stdout}${x.stderr}`);
    ok('B2a-1: the local meta has no env (unchanged format) and no runner header', meta('xw').env === undefined && !/^ran on runner/.test(out('xw')));

    // B2a-2: a broken remote key - 78 before any ssh, the key named.
    setMachine(Object.assign({}, remote, { host: undefined })); set(0, [], false);
    x = ga('--force', 'xw');
    ok('B2a-2: remote without host - exit 78 before ssh, the key named', x.status === 78 && /remote\.host/.test(x.stdout + x.stderr) && !fs.existsSync(sshLog), `${x.status} ${x.stdout}${x.stderr}`);
    const chk = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', cfgFile], { encoding: 'utf8', env: env() });
    ok('B2a-2: config.js check names the key', chk.status === 1 && /remote\.host: required/.test(chk.stderr), chk.stderr);

    // Remote key, project without remoteRun: the run stays here, and says so.
    setMachine(remote); setCfg({}, true); set(0, [], false);
    x = ga('--force', 'xw');
    ok('remote key, no remoteRun in the project - a local run with a note, no ssh', x.status === 0 && count('full.count') === 1 && /no remoteRun/.test(x.stdout + x.stderr) && !fs.existsSync(sshLog), `${x.status} ${x.stdout}${x.stderr}`);

    // B2a-5: a dirty tracked tree - refused, no ssh.
    setCfg(); set(0, [], false);
    fs.appendFileSync(path.join(xw, 'one.sh'), '# edit\n');
    x = ga('--force', 'xw');
    ok('B2a-5: tracked changes - exit 78 "tracked changes not committed - remote run tests HEAD only", no ssh', x.status === 78 && /tracked changes not committed .* remote run tests HEAD only/.test(x.stdout + x.stderr) && !fs.existsSync(sshLog), `${x.status} ${x.stdout}${x.stderr}`);
    git(xw, 'checkout', '-q', 'one.sh');

    // B2a-7: another plugin version on the runner - refused with both versions, no push, no run.
    const p2 = path.join(T, 'plugin2'); fs.mkdirSync(p2); fs.writeFileSync(path.join(p2, 'package.json'), '{"name":"codis-agents","version":"0.0.1"}\n');
    setMachine(Object.assign({}, remote, { plugin: p2 })); set(0, [], false);
    const mine = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
    x = ga('--force', 'xw');
    ok('B2a-7: plugin 0.0.1 on the runner - exit 69, both versions named, the log starts with "environment:"', x.status === 69 && (x.stdout + x.stderr).includes('0.0.1') && (x.stdout + x.stderr).includes(mine) && /^environment: /.test(out('xw')), `${x.status} ${x.stdout}${x.stderr}\n${out('xw')}`);
    ok('B2a-7: no push and no run on the runner', !sshCalls().some((a) => a.join(' ').includes('git-receive-pack')) && !fs.existsSync(path.join(R, 'runs')) && count('full.count') === 0);
    ok('B2a-7: the meta remembers the environment exit 69 (never reused)', meta('xw').rc === 69 && meta('xw').env === 'remote:example.org');

    // The main flow: B2a-6, 8, 10-17, 21, 22.
    setMachine(remote); set(1, ['srv/a-run.js'], false);
    const sha = head(xw);
    x = ga('xw');
    const all = x.stdout + x.stderr;
    ok('main flow: the runner ran, exit = the runner\'s final code after its reruns (1: one repeated)', x.status === 1 && count('full.count') === 1, `${x.status} ${all}`);
    const fc = read(path.join(T, 'full.count')) || '';
    ok('B2a-16: the runner ran in <root>/wt/<name>, the remote command (--no-font) with the runner\'s worker count', fc.startsWith(path.join(R, 'wt', 'xw') + ' ') && /--no-font/.test(fc), fc);
    const calls = sshCalls();
    ok('B2a-6: every ssh call: -F none, only the key, StrictHostKeyChecking=yes, the pinned known_hosts, IdentitiesOnly, ConnectTimeout, BatchMode',
      calls.length > 0 && calls.every((a) => { const s = a.join(' '); return a.includes('-F') && a[a.indexOf('-F') + 1] === 'none' && a.includes(remote.key) && s.includes('StrictHostKeyChecking=yes')
        && s.includes(`UserKnownHostsFile=${remote.knownHosts}`) && s.includes('IdentitiesOnly=yes') && /ConnectTimeout=\d+/.test(s) && s.includes('BatchMode=yes') && !/accept-new|StrictHostKeyChecking=no/.test(s); }), JSON.stringify(calls));
    ok('B2a-6: every ssh call goes to runner@example.org', calls.every((a) => a.includes('runner@example.org')));
    ok('B2a-8: the HEAD went by git push over that ssh (receive-pack), into refs/runs/<name>/<sha> of <root>/repo.git, with the plugin\'s pre-push hook on',
      calls.some((a) => a.join(' ').includes('git-receive-pack')) && spawnSync('git', ['--git-dir', path.join(R, 'repo.git'), 'rev-parse', `refs/runs/xw/${sha}`], { encoding: 'utf8' }).stdout.trim() === sha);
    ok('B2a-8: no branch or tag was created in the runner\'s repository', spawnSync('git', ['--git-dir', path.join(R, 'repo.git'), 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'], { encoding: 'utf8' }).stdout.trim() === '');
    const swt = path.join(R, 'wt', 'xw');
    ok('B2a-10: <root>/wt/xw is a linked worktree of repo.git on that SHA', head(swt) === sha && fs.realpathSync(path.resolve(swt, git(swt, 'rev-parse', '--git-common-dir').stdout.trim())) === fs.realpathSync(path.join(R, 'repo.git')));
    const inst = (read(path.join(T, 'install.count')) || '').split('\n').filter(Boolean);
    ok('B2a-11: a new lock-file hash - each dependency installed once, in the runner\'s cache <root>/deps', inst.length === 2 && inst.every((l) => l.split(' ')[1].startsWith(path.join(R, 'deps') + '/')), inst.join(' | '));
    const nm = path.join(swt, 'pkg', 'node_modules'), deps = path.join(swt, 'pkg', '.deps');
    ok('B2a-11: node_modules and .deps are links into the cache', fs.lstatSync(nm).isSymbolicLink() && fs.existsSync(path.join(nm, 'marker')) && fs.lstatSync(deps).isSymbolicLink() && fs.existsSync(path.join(deps, 'package-lock.json')) && fs.existsSync(path.join(deps, 'node_modules', 'marker')));
    ok('B2a-12: each link leads to its target in one step (readlink = realpath, no intermediate link)', fs.readlinkSync(nm) === fs.realpathSync(nm) && fs.readlinkSync(deps) === fs.realpathSync(deps), `${fs.readlinkSync(nm)} ${fs.realpathSync(nm)}`);
    ok('B2a-13: the project\'s prepare commands ran in the runner\'s worktree', (read(path.join(T, 'prepare.count')) || '').trim() === swt);
    ok('B2a-14: the worktree got its own copy of the donor at the worktree paths, not a link', read(path.join(swt, 'pkg', 'data', 'big.json')) === '{"corpus":1}\n' && !fs.lstatSync(path.join(swt, 'pkg', 'data')).isSymbolicLink());
    ok('B2a-14: the donor is unchanged by the run', cr('status').scanId === donorId);
    const envs = spawnSync('find', [swt, '-name', '.env*'], { encoding: 'utf8' }).stdout.trim();
    ok('B2a-15: no .env* in the runner\'s worktree', envs === '', envs);
    const one = (read(path.join(T, 'one.count')) || '').split('\n').filter(Boolean);
    ok('B2a-17: the new reds reran one by one on the runner (in its worktree)', one.length === 2 && one.every((l) => l.startsWith(swt + ' ')), one.join(' | '));
    const log = out('xw');
    ok('B2a-17: the log has the rerun lines of the runner', /new red, red again alone: srv\/a-run\.js/.test(log) && /flaky, red under load, green alone: srv\/b-run\.js/.test(log), log);
    const workers = /^workers(?: at start)?: (\d+)/m.exec(read(path.join(R, 'runs', 'xw', 'out.txt')) || '');
    ok('B2a-22: the log starts "ran on runner example.org, HEAD <sha>, workers N" (N of the runner)', workers && log.split('\n')[0].startsWith(`ran on runner example.org, HEAD ${sha}, workers ${workers[1]}`), log.split('\n')[0]);
    ok('B2a-22: the log keeps the runner\'s tally', /^TOTAL: 2 green/m.test(log));
    const m1 = meta('xw');
    ok('B2a-22: meta v1 with env remote:example.org, head = HEAD here, rc = the final code', m1.v === 1 && m1.env === 'remote:example.org' && m1.head === sha && m1.headEnd === sha && m1.cleanStart && m1.cleanEnd && m1.rc === 1, JSON.stringify(m1));
    ok('B2a-16: the run directory on the runner holds its rc, out and log', fs.existsSync(path.join(R, 'runs', 'xw', 'rc')) && fs.existsSync(path.join(R, 'runs', 'xw', 'out.txt')) && fs.existsSync(path.join(R, 'runs', 'xw', 'guards-xw.txt')));
    const jr = journal();
    ok('B2a-21: one journal line of class remote here, and no heavy slot taken here', jr.filter((l) => l[4] === 'remote').length === 1 && jr.filter((l) => l[4] === 'heavy').length === 0, JSON.stringify(jr));
    ok('B2a-21: the remote journal line carries the exit code and the worktree', (() => { const l = jr.find((r) => r[4] === 'remote'); return l && l[8] === '1' && l[9] === xw; })(), JSON.stringify(jr));
    ok('B2a-21: waiting lines name the remote run', /waiting for remote run xw@/.test(all), all);

    // B2a-9: the SHA is on the runner - no transfer; B2a-11: the same hash - no install.
    set(0, [], false);
    x = ga('--force', 'xw');
    ok('B2a-9: SHA already on the runner - no git push this time', x.status === 0 && !sshCalls().some((a) => a.join(' ').includes('git-receive-pack')) && count('full.count') === 1, `${x.status} ${x.stdout}${x.stderr}`);
    ok('B2a-11: the same lock-file hash - taken from the cache, nothing installed', (read(path.join(T, 'install.count')) || '').split('\n').filter(Boolean).length === 2);

    // B2a-3: reused without ssh.
    fs.rmSync(sshLog, { force: true });
    x = ga('xw');
    ok('B2a-3: same HEAD, clean, remote meta, exit 0 - "reused, HEAD <sha>", no ssh', x.status === 0 && x.stdout.includes(`reused, HEAD ${sha.slice(0, 7)}`) && !fs.existsSync(sshLog), `${x.status} ${x.stdout}`);
    // B2a-4: the machine goes local - not reused.
    setMachine(); set(0, [], false);
    x = ga('xw');
    ok('B2a-4: remote meta, no remote now - a local run (environment changed)', x.status === 0 && count('full.count') === 1 && read(path.join(T, 'full.count')).startsWith(xw + ' '), `${x.status} ${x.stdout}`);
    setMachine(remote);

    // B2a-23: guards the runner skipped run here in a heavy slot; the final code is the worse one.
    set(0, [], true);
    fs.writeFileSync(path.join(T, 'local.rc'), '1');
    x = ga('--force', 'xw');
    const lc = read(path.join(T, 'local.count')) || '';
    ok('B2a-23: the skipped guards ran here, in this worktree, by the subset command with --only', lc.startsWith(xw + ' ') && /--only srv\/font-run\.js/.test(lc), lc);
    ok('B2a-23: runner 0, local 1 - exit 1, a separate section in the same log', x.status === 1 && /==== on this machine: /.test(out('xw')) && /local runner: --only srv\/font-run\.js/.test(out('xw')), `${x.status} ${out('xw')}`);
    ok('B2a-23: the local section took one heavy slot here (after the remote run)', journal().filter((l) => l[4] === 'heavy').length === 1);
    ok('B2a-23: meta rc = the worse code', meta('xw').rc === 1);

    // B2a-18 and B2a-21: two tasks at once - both reach the end in their own worktrees and run directories.
    set(0, [], false, 1);
    const a = collect(gaBg('--force', 'xw')), b = collect(gaBg('--force', 'yw'));
    asyncDone = true;
    Promise.all([a, b]).then(([ra, rb]) => {
      ok('B2a-18: two tasks at once - both exit 0', ra.status === 0 && rb.status === 0, `${ra.status} ${rb.status}\n${ra.out}\n${rb.out}`);
      ok('B2a-18: each in its own runner worktree', ['xw', 'yw'].every((n) => (read(path.join(T, 'full.count')) || '').includes(path.join(R, 'wt', n) + ' ')) && out('yw').startsWith('ran on runner example.org'));
      const sj = (read(path.join(S, 'slots', 'journal.tsv')) || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
      ok('B2a-18: on the runner both took a heavy slot of its own queue', sj.filter((l) => l[4] === 'heavy' && l[6] === 'full').length >= 2, JSON.stringify(sj.map((l) => l.slice(4, 9))));

      // B2a-20: the run of the same name and SHA is alive - a new start attaches to it, no second run.
      set(0, [], false, 3);
      const first = gaBg('--force', 'xw');
      const firstDone = collect(first);
      const started = until(() => (read(path.join(T, 'full.count')) || '').length > 0, 30);
      try { process.kill(-first.pid, 'SIGKILL'); } catch { /* gone */ }
      return firstDone.then(() => {
        const y = ga('--force', 'xw');
        ok('B2a-20: the run alive on the runner - attached, one run only, its result fetched', started && y.status === 0 && /attached to the run xw@/.test(y.stdout + y.stderr) && count('full.count') === 1, `${started} ${y.status} ${count('full.count')} ${y.stdout}${y.stderr}`);

        // Environment: dependencies that fail to install, a .env* in the runner's worktree, a run that vanished.
        setCfg({ deps: [{ files: ['pkg/package.json'], install: 'echo npm failed >&2; exit 3', link: { 'pkg/node_modules': 'node_modules' } }] }); set(0, [], false);
        let z = ga('--force', 'xw');
        ok('environment: dependencies fail - exit 69, the log starts with "environment:", no guard ran', z.status === 69 && /^environment: .*(dependenc|install)/.test(out('xw')) && /npm failed/.test(out('xw')) && count('full.count') === 0, `${z.status} ${out('xw')}`);
        setCfg({ prepare: ['touch pkg/.env.local'] }); set(0, [], false);
        z = ga('--force', 'xw');
        ok('B2a-15: a .env* appears in the runner\'s worktree - exit 69 before any guard, the file named', z.status === 69 && /^environment: .*\.env/.test(out('xw')) && /pkg\/\.env\.local/.test(out('xw')) && count('full.count') === 0, `${z.status} ${out('xw')}`);
        setCfg(); set(0, [], false, 5);
        const v = gaBg('--force', 'xw');
        const vDone = collect(v);
        until(() => (read(path.join(T, 'full.count')) || '').length > 0, 30);
        const run = JSON.parse(read(path.join(R, 'runs', 'xw', 'run.json')) || '{}');
        try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ }
        return vDone.then((rv) => {
          ok('run vanished on the runner - exit 69, the log starts with "environment: ... vanished"', rv.status === 69 && /^environment: .*vanished/.test(out('xw')), `${rv.status} ${rv.out}\n${out('xw')}`);
          // B2a-22: a worktree outside worktreeRoot logs as guards-<basename>-<cksum>.txt, on the runner too.
          const zw = path.join(T, 'elsewhere', 'zw');
          git(main, 'worktree', 'add', '-q', '--detach', zw);
          set(0, [], false);
          const zr = ga('--force', zw);
          const zl = fs.readdirSync(shared).filter((f) => /^guards-zw-\d+\.txt$/.test(f));
          ok('B2a-22: a worktree outside worktreeRoot - guards-zw-<cksum>.txt with the runner header', zr.status === 0 && zl.length === 1 && read(path.join(shared, zl[0])).startsWith('ran on runner example.org'), `${zr.status} ${zl} ${zr.stdout}${zr.stderr}`);
        });
      });
    }).catch((e) => { ok('end to end without an exception', false, e && e.stack); }).finally(() => { cleanup(); done(); });
  }
} catch (e) {
  ok('no exception', false, e && e.stack);
}
function cleanup() {
  // runner processes left by a failed check: every run.json pid group
  try { for (const n of fs.readdirSync(path.join(R, 'runs'))) { const r = JSON.parse(read(path.join(R, 'runs', n, 'run.json')) || '{}'); if (r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* gone */ } } } } catch { /* none */ }
  fs.rmSync(T, { recursive: true, force: true });
}
if (!asyncDone) { cleanup(); done(); }
