#!/usr/bin/env node
'use strict';
// Tester of p-runner-share: the train's priority travels to the remote runner for BOTH runs of a train - its full run
// and its attribution (scripts/train.js: guards-all.sh --priority --guards <names>, the selection mode). The
// programmer's guards-remote.test.js holds the full run only. Here guards-all.sh is run with a machine file that names
// a runner and a project with remoteRun; a fake `node` in front of PATH records the argv guards-all.sh gives
// guards-remote.js (every other node call goes to the real node), so no ssh is needed:
//   R1 --priority --guards <names>: guards-remote.js gets --subset <the runner's subsetCommand> --selected <names> and
//      --priority (the attribution of a red train is first on the runner too);
//   R2 --guards <names> without --priority: the same, and no --priority;
//   R3 --priority, a full run: --priority, no --subset;
//   R4 guards-remote.js main(): --priority anywhere among the options does not eat --selected or --subset (the job is
//      built from them), checked by a run() stub through the module's argv parsing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('guards-all.sh with a remote runner (a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-share-remote-t-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
try {
  for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
  git(main, 'init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(main, 'a-run.js'), 'process.exit(0)\n');
  git(main, 'add', 'a-run.js'); git(main, 'commit', '-q', '-m', 'init');
  const xw = path.join(wts, 'xw');
  git(main, 'worktree', 'add', '-q', '-b', 'xw', xw);

  const argvFile = path.join(T, 'remote.argv');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/zsh
if [[ \${1:t} == guards-remote.js ]]; then print -rl -- "$@" > ${JSON.stringify(argvFile)}; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`);
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  // the fake machine of the slots (slots-hermetic): guards-all.sh sources slots.zsh before it goes remote
  const tool = (n, body) => { fs.writeFileSync(path.join(bin, n), body); fs.chmodSync(path.join(bin, n), 0o755); };
  tool('sysctl', '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
  tool('memory_pressure', '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
  tool('vm_stat', '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
  tool('df', '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');

  const mfile = path.join(T, 'machine.json');
  fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, remote: { host: 'example.org', user: 'runner', key: '/k', knownHosts: '/kh', root: '~/codis-runs' } }));
  const cfgFile = path.join(T, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}',
    guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs} {jobs} {limitFile}', protectedBranches: ['trunk'],
    guardRerun: { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+) ', tallyPattern: '^TOTAL: .*?(\\d+) total$' },
    remoteRun: { command: 'cd {wt} && ./full.sh {jobs}', subsetCommand: 'cd {wt} && ./sub.sh {onlyArgs} {jobs} {limitFile}', deps: [] } }));
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT',
    'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'SLOT_TOTAL_MAX', 'SLOT_PROC', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED',
    'GUARDS_EXCLUSIVE_LOCK', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_MARKER', 'GUARDS_EXCL_GLOB', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC',
    'SLOT_PRIORITY', 'SLOT_PATH', 'CODIS_WORKTREE_ROOT', 'CODIS_SHARED_DIR', 'CODIS_REPO_DIR']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH,
    SLOTS_DIR: path.join(T, 'slots'), SLOT_LEGACY_LOCK: path.join(T, 'guards.lock'), SLOT_OS: 'darwin' });
  const names = path.join(T, 'names.json');
  fs.writeFileSync(names, JSON.stringify(['a-run.js']));
  const ga = (...a) => {
    fs.rmSync(argvFile, { force: true });
    const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 60000 });
    const argv = (read(argvFile) || '').split('\n').filter((x) => x !== '');
    return { r, argv, all: `${r.status} ${r.stdout}${r.stderr} | argv: ${JSON.stringify(argv)}` };
  };
  const after = (argv, opt) => { const i = argv.indexOf(opt); return i >= 0 ? argv[i + 1] : undefined; };

  let x = ga('--force', '--priority', '--guards', names, 'xw');
  ok('R1 the attribution of a train (--priority --guards) goes to the runner: guards-remote.js is called', x.argv[0] && x.argv[1] === 'run', x.all);
  ok('R1 ... with --subset (the runner\'s subsetCommand) and --selected <the names file>',
    /\.\/sub\.sh/.test(after(x.argv, '--subset') || '') && after(x.argv, '--selected') === names, x.all);
  ok('R1 ... and with --priority', x.argv.includes('--priority'), x.all);

  x = ga('--force', '--guards', names, 'xw');
  ok('R2 a selection without --priority: --subset and --selected, no --priority',
    /\.\/sub\.sh/.test(after(x.argv, '--subset') || '') && after(x.argv, '--selected') === names && !x.argv.includes('--priority'), x.all);

  x = ga('--force', '--priority', 'xw');
  ok('R3 the full run of a train: --priority, no --subset', x.argv.includes('--priority') && !x.argv.includes('--subset'), x.all);

  // R4: main() of guards-remote.js parses the argv guards-all.sh gives it; run() is stubbed through the module cache
  const probe = path.join(T, 'probe.js');
  fs.writeFileSync(probe, `
const path = require('path');
const gr = path.join(${JSON.stringify(path.join(ROOT, 'scripts'))}, 'guards-remote.js');
const Module = require('module');
const src = require('fs').readFileSync(gr, 'utf8');
// the module's main() calls run(l.config, ...): replace run in its scope by a recorder, keep everything else
const m = new Module(gr, module); m.filename = gr; m.paths = Module._nodeModulePaths(path.dirname(gr));
m._compile(src.replace(/\\nfunction run\\(c, wt, log, name, qfile, opts\\) \\{/, '\\nfunction run(c, wt, log, name, qfile, opts) { console.log(JSON.stringify({ wt, log, name, qfile, subset: opts.subset, selected: opts.selected, priority: opts.priority })); return 0;') + '\\nmodule.exports.__main = main;\\n', gr);
process.exitCode = m.exports.__main(process.argv.slice(2));
`);
  const parse = (...a) => {
    const r = spawnSync(process.execPath, [probe, ...a], { encoding: 'utf8', env: Object.assign({}, env, { PATH: process.env.PATH }) });
    let j = null; try { j = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch {}
    return { j, all: `${r.status} ${r.stdout}${r.stderr}` };
  };
  let p = parse('run', xw, path.join(T, 'log.txt'), 'xw-select', '', '--subset', 'cd x && ./sub.sh a-run.js', '--selected', names, '--priority');
  ok('R4 guards-remote.js: "--subset C --selected F --priority" (the order guards-all.sh gives) - subset, selected and priority all kept',
    p.j && p.j.subset === 'cd x && ./sub.sh a-run.js' && JSON.stringify(p.j.selected) === '["a-run.js"]' && p.j.priority === true && p.j.name === 'xw-select', p.all);
  p = parse('run', xw, path.join(T, 'log.txt'), 'xw', '', '--priority');
  ok('R4 ... a full run "--priority": priority, no subset, positional arguments intact', p.j && p.j.priority === true && !p.j.subset && p.j.wt === xw && p.j.name === 'xw', p.all);
  p = parse('run', xw, path.join(T, 'log.txt'), 'xw-select', '', '--subset', 'cd x && ./sub.sh a-run.js', '--selected', names);
  ok('R4 ... without --priority: priority false', p.j && p.j.priority === false && JSON.stringify(p.j.selected) === '["a-run.js"]', p.all);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
