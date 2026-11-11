#!/usr/bin/env node
'use strict';
// Tester cells of p-runq part a after the fix of T2 (the whole-budget note only for a selection command with neither
// {jobs} nor {limitFile}): the note follows the command that really runs.
//   T6. config.js check: remoteRun.subsetCommand with {limitFile} but no {jobs} (adaptive on the runner) - no note.
//   T7. a selection on the runner whose remoteRun.subsetCommand has {limitFile} but no {jobs}, while the local
//       guardSubsetCommand has neither: it runs on the runner with --concurrency-file, and no whole-budget note.
//   T8. the same with remoteRun.subsetCommand with {jobs} and {limitFile}: no note (the local key does not run).
//   T9. remoteRun.subsetCommand with neither: the note names remoteRun.subsetCommand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'); } catch { return null; } };
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
const cleanEnv = () => {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
};
const FULLC = 'cd {wt} && ./full.sh --concurrency {jobs} --concurrency-file {limitFile}';
const WHOLE = 'cd {wt} && ./full.sh {onlyArgs}';
const LIMITONLY = 'cd {wt} && ./full.sh {onlyArgs} --concurrency-file {limitFile}';
const BOTH = 'cd {wt} && ./full.sh {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}';

function partConfig() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'runq-a-tester-cfg-'));
  try {
    const f = path.join(T, 'cfg.json');
    fs.writeFileSync(f, JSON.stringify({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: FULLC, guardSubsetCommand: BOTH, guardRerun: { command: 'cd {wt} && ./full.sh --only {name}', newRedPattern: '^X (\\S+) ', tallyPattern: '^TOTAL: .*?(\\d+) total$' },
      remoteRun: { command: FULLC + ' --no-font', subsetCommand: LIMITONLY + ' --no-font' } }));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', f], { encoding: 'utf8' });
    const all = (r.stdout || '') + (r.stderr || '');
    ok('T6. config.js check: remoteRun.subsetCommand with {limitFile} but no {jobs} (adaptive) - no whole-budget note, exit 0',
      r.status === 0 && !/whole worker budget/.test(all) && !/has no \{jobs\}/.test(all), `${r.status} ${all}`);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
}

// The remote selection (cells T7-T9): the fixture of tests/p-train-a2.test.js part C - ssh is a fake that runs
// the command in a temporary "server" home, the "server" plugin is this checkout, its machine file a runner's budget.
function partRemote(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), main = path.join(TMP, 'main');
  const S = path.join(TMP, 'server'), sshLog = path.join(TMP, 'ssh.log');
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
  put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/full.count"\necho "Guards to run: 1"\necho "TOTAL: 0 NEW red, 1 total"\nexit 0\n`, 0o755);
  put('srv/a-run.js', '// a\n');
  gitC(main, 'init', '-q', '-b', 'trunk'); gitC(main, 'add', '.'); gitC(main, 'commit', '-q', '-m', 'project');
  const xw = path.join(wts, 'xw');
  gitC(main, 'worktree', 'add', '-q', '-b', 'task', xw);
  fs.writeFileSync(path.join(xw, 'srv', 'a-run.js'), '// a changed\n');
  gitC(xw, 'add', 'srv/a-run.js'); gitC(xw, 'commit', '-q', '-m', 'change');
  fs.writeFileSync(path.join(TMP, 'key'), 'not a key\n'); fs.writeFileSync(path.join(TMP, 'kh'), 'example.org ssh-ed25519 AAAA\n');
  const remote = { host: 'example.org', user: 'runner', key: path.join(TMP, 'key'), knownHosts: path.join(TMP, 'kh'), root: '~/codis-runs', plugin: ROOT };
  const mfile = path.join(TMP, 'machine.json');
  fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(TMP, 'slots') }, remote }));
  fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
  // the runner's budget as measured on the real one: jobsAlone 14, jobsShared 7
  fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), jobsAlone: 14, jobsShared: 7 } }));
  const cfgFile = path.join(TMP, 'cfg.json');
  const setCfg = (subset) => fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh --concurrency {jobs} --concurrency-file {limitFile}',
    guardSubsetCommand: WHOLE, protectedBranches: ['trunk'], guardRerun: { command: 'cd {wt} && ./full.sh --only {name}', newRedPattern: '^X (\\S+) ', tallyPattern: '^TOTAL: .*?(\\d+) total$' },
    remoteRun: { command: 'cd {wt} && ./full.sh --concurrency {jobs} --concurrency-file {limitFile}', subsetCommand: subset } }));
  cleanEnv();
  const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
    SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', GUARDS_REMOTE_SSH_PAUSE: '0', FAKE_SERVER_ENV: SRV_ENV });
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const SEL = path.join(shared, 'guards-xw.select.txt');
  const run = (subset) => { setCfg(subset); fs.rmSync(path.join(TMP, 'full.count'), { force: true }); fs.rmSync(sshLog, { force: true });
    const x = ga('--force', '--select', 'trunk', 'xw'); x.fc = (read(path.join(TMP, 'full.count')) || '').trim(); return x; };

  let x = run(LIMITONLY);
  ok('T7. remote subsetCommand with {limitFile} only (local guardSubsetCommand with neither): ran on the runner with --concurrency-file',
    x.status === 0 && fs.existsSync(sshLog) && /--only srv\/a-run\.js --concurrency-file \S+heavy\.\d\.lock\.limit/.test(x.fc), `${x.status} [${x.fc}] ${x.all.slice(-1200)}`);
  ok('T7. ... and no whole-budget note (the runner command is adaptive)', !/whole worker budget/.test(x.all) && !/has no \{jobs\}/.test(x.all), x.all.slice(-1200));

  x = run(BOTH);
  ok('T8. remote subsetCommand with {jobs} and {limitFile}, local guardSubsetCommand with neither: no note, ran with --concurrency 14',
    x.status === 0 && /--concurrency 14 --concurrency-file/.test(x.fc) && !/whole worker budget/.test(x.all), `${x.status} [${x.fc}] ${x.all.slice(-1200)}`);

  x = run(WHOLE);
  ok('T9. remote subsetCommand with neither: the note names remoteRun.subsetCommand, not guardSubsetCommand',
    x.status === 0 && /note: remoteRun\.subsetCommand has no \{jobs\}/.test(x.all) && !/note: guardSubsetCommand has no/.test(x.all) && /workers 14 /.test(read(SEL) || ''), `${x.status} ${x.all.slice(-1200)}`);
}

partConfig();
if (!(has('zsh') && has('git') && has('perl'))) skip('T7-T9. the selection on the remote runner', 'zsh, git or perl not found');
else {
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runq-a-tester-')));
  try { partRemote(TMP); } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
}
done();
