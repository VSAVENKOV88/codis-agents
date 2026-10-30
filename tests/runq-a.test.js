#!/usr/bin/env node
'use strict';
// Selections with a worker budget (p-runq part a, cells A5 remote, A6, A7 and the living docs of the p-runq matrix).
// The cause of selections going one at a time on the runner was a project config whose guardSubsetCommand and
// remoteRun.subsetCommand had no {jobs}: such a selection is counted as the whole budget (README guardCommand), so it
// waits for every other heavy job. The plugin keeps that behaviour and says so:
//   A6. config.js check: guardCommand (remoteRun.command) with {jobs} and the subset command without it - a note naming
//       the key, never an error (an error refuses every slot of the project: slots.zsh);
//   A5. the remote selection prints the same note, naming remoteRun.subsetCommand;
//   A7. a remote selection with {jobs}/{limitFile}: the header and the meta carry the workers of "workers at start: N"
//       of the runner (its jobsAlone, 14 on a runner like the measured one);
//   docs: README (guardSubsetCommand, remoteRun.subsetCommand), rules/multi-agent.md (the onerun line) and the example
//       config give the subset commands {jobs} and {limitFile}.
// The queue cells (two selections at once, a selection next to a full run, sums of workers) are tests/slots-select.test.sh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'); } catch { return null; } };
const C = require('../scripts/config');
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const cleanEnv = () => { for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k]; };

function partConfig() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'runq-a-cfg-'));
  try {
    const FULL = 'cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}';
    const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: FULL };
    const check = (o) => {
      const f = path.join(T, 'cfg.json');
      fs.writeFileSync(f, JSON.stringify(Object.assign({}, base, o)));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', f], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f }) });
      r.all = (r.stdout || '') + (r.stderr || '');
      return r;
    };
    let r = check({ guardSubsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs}' });
    ok('A6. guardCommand with {jobs}, guardSubsetCommand without: config check passes (exit 0) with a note naming the key',
      r.status === 0 && /note: guardSubsetCommand has no \{jobs\}/.test(r.stderr) && /whole worker budget/.test(r.stderr) && /\{limitFile\}/.test(r.stderr), r.all);
    ok('A6. ... the note is not an error (resolve gives no error for it)', !C.resolve(Object.assign({}, base, { guardSubsetCommand: 'x {wt} {onlyArgs}' })).errors.length);
    r = check({ guardSubsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}' });
    ok('A6. guardSubsetCommand with {jobs}: no note', r.status === 0 && !/has no \{jobs\}/.test(r.all), r.all);
    r = check({ guardCommand: 'cd {wt} && pytest -q', guardSubsetCommand: 'cd {wt} && pytest -q {onlyArgs}' });
    ok('A6. guardCommand without {jobs} either (a runner that sets its own workers): no note', r.status === 0 && !/has no \{jobs\}/.test(r.all), r.all);
    r = check({ guardSubsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}',
      remoteRun: { command: FULL + ' --no-font', subsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --no-font' } });
    ok('A6. remoteRun.command with {jobs}, remoteRun.subsetCommand without: a note naming remoteRun.subsetCommand, exit 0',
      r.status === 0 && /note: remoteRun\.subsetCommand has no \{jobs\}/.test(r.stderr) && !/note: guardSubsetCommand has no/.test(r.stderr), r.all);
    r = check({ guardSubsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}',
      remoteRun: { subsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile} --no-font' } });
    ok('A6. both subset commands with {jobs}: no note', r.status === 0 && !/has no \{jobs\}/.test(r.all), r.all);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
}

function partDocs() {
  const readme = read('README.md'), rules = read('rules/multi-agent.md');
  const rowOf = (s, k) => (s.split('\n').find((l) => l.startsWith('| `' + k + '` |')) || '');
  const sub = rowOf(readme, 'guardSubsetCommand');
  ok('docs: README guardSubsetCommand names {jobs} and {limitFile} and what happens without them (the whole budget, one at a time)',
    /\{jobs\}/.test(sub) && /\{limitFile\}/.test(sub) && /whole budget/.test(sub), sub);
  const rr = rowOf(readme, 'remoteRun');
  ok('docs: README remoteRun.subsetCommand names {jobs} and {limitFile}', /`subsetCommand`[^\n]*\{jobs\}[^\n]*\{limitFile\}/.test(rr), rr.slice(rr.indexOf('subsetCommand')));
  const line = rules.split('\n').find((l) => l.includes('<!-- role:onerun -->')) || '';
  ok('docs: the onerun rule says the subset command keeps {jobs} and {limitFile} of guardCommand', /\{jobs\}/.test(line) && /\{limitFile\}/.test(line), line.slice(0, 300));
  const ex = JSON.parse(read('examples/codis-agents.example.json'));
  const w = (s) => typeof s === 'string' && s.includes('{jobs}') && s.includes('{limitFile}') && s.includes('{onlyArgs}');
  ok('docs: the example config has guardSubsetCommand and remoteRun.subsetCommand with {jobs}, {limitFile} and {onlyArgs}',
    w(ex.guardSubsetCommand) && ex.remoteRun && w(ex.remoteRun.subsetCommand), JSON.stringify([ex.guardSubsetCommand, ex.remoteRun && ex.remoteRun.subsetCommand]));
  const er = C.resolve(ex);
  ok('docs: the example config resolves without errors and without the {jobs} note', er.errors.length === 0 && !er.warnings.some((x) => /has no \{jobs\}/.test(x)), er.errors.concat(er.warnings).join('; '));
}

// The remote selection (cells A5 remote, A7): the fixture of tests/p-train-a2.test.js part C - ssh is a fake that runs
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
  put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/full.count"\necho "Guards to run: 1"\necho "TOTAL: 0 NEW red"\nexit 0\n`, 0o755);
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
    guardSubsetCommand: 'cd {wt} && ./full.sh {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}', protectedBranches: ['trunk'],
    remoteRun: { command: 'cd {wt} && ./full.sh --concurrency {jobs} --concurrency-file {limitFile}', subsetCommand: subset } }));
  cleanEnv();
  const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
    SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV });
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const SEL = path.join(shared, 'guards-xw.select.txt');
  const meta = () => { try { return JSON.parse(read(SEL + '.meta.json')); } catch { return null; } };

  setCfg('cd {wt} && ./full.sh {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}');
  let x = ga('--force', '--select', 'trunk', 'xw');
  const fc = (read(path.join(TMP, 'full.count')) || '').trim();
  ok('A7. a remote selection with {jobs}/{limitFile} ran on the runner with its budget: --concurrency 14 --concurrency-file',
    x.status === 0 && fs.existsSync(sshLog) && /--only srv\/a-run\.js --concurrency 14 --concurrency-file \S+heavy\.\d\.lock\.limit/.test(fc), `${x.status} [${fc}] ${x.all.slice(-1200)}`);
  ok('A7. the selection log starts "ran on runner example.org, HEAD <sha>, workers 14"', /^ran on runner example\.org, HEAD \S+, workers 14 /.test(read(SEL) || ''), (read(SEL) || '').slice(0, 200));
  ok('A7. the meta of the selection records the runner\'s workers 14', (meta() || {}).runner && meta().runner.workers === 14, read(SEL + '.meta.json'));
  ok('A5. remote selection with {jobs}: no note about a missing {jobs}', !/has no \{jobs\}/.test(x.all), x.all.slice(-600));
  setCfg('cd {wt} && ./full.sh {onlyArgs}');
  fs.rmSync(path.join(TMP, 'full.count'), { force: true });
  x = ga('--force', '--select', 'trunk', 'xw');
  ok('A5. remote selection without {jobs}: the note names remoteRun.subsetCommand, the run still goes (whole budget, 14)',
    x.status === 0 && /note: remoteRun\.subsetCommand has no \{jobs\}/.test(x.all) && /workers 14 /.test(read(SEL) || ''), `${x.status} ${x.all.slice(-1200)}`);
}

partConfig();
partDocs();
if (!(has('zsh') && has('git') && has('perl'))) skip('A5, A7. the selection on the remote runner', 'zsh, git or perl not found');
else {
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runq-a-')));
  try { partRemote(TMP); } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
}
done();
