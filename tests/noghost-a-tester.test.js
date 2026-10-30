#!/usr/bin/env node
'use strict';
// Tester cells of p-noghost part a (placeholders by the place that fills them), next to tests/noghost-a.test.js:
//   T1. guards-select.js --only-args with {jobs}/{limitFile} in guardSubsetCommand: exit 0 with the --only list and the
//       names file - guards-all.sh --select stands on this mode, the 78 of --command must not leak into it;
//   T2. guards-select.js --json: exit 0, command "" with {jobs}; the filled command without it;
//   T3. an unknown placeholder (a typo, a wrong case) is an error at every place, not only in guardCommand;
//   T4. guards-remote.js run() with a config object: {limitFile} or a typo in localCommand -> 78 before any ssh;
//   T5. a key left to its default is not reported twice (remoteRun.command = guardCommand);
//   T6. medium.sh and heavy.sh refuse 78 on the case's config too (every slot of the project), the command never runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 700));

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/config');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-at-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

const FULL = 'cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}';
const SUBJ = 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}';
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: FULL };
const errs = (o) => C.resolve(Object.assign({}, base, o)).errors;
const RR = { command: FULL, deps: [], localPattern: '^skipped: (.+)$' };
const repo = (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f.txt'), '1'); git(d, 'init', '-q', '-b', 'main'); git(d, 'add', 'f.txt'); git(d, 'commit', '-q', '-m', 'one'); return d; };

try {
  // --- T1, T2: guards-select.js modes that guards-all.sh --select uses ---
  const s = repo(path.join(T, 'sel'));
  git(s, 'branch', 'start');
  fs.writeFileSync(path.join(s, 'a-run.js'), 'process.exit(0)\n'); git(s, 'add', 'a-run.js'); git(s, 'commit', '-q', '-m', 'two');
  const sel = (subset, ...mode) => {
    const f = path.join(T, 'sel.json');
    fs.writeFileSync(f, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: subset })));
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-select.js'), '--wt', s, '--base', 'start', '--config', f, ...mode], { encoding: 'utf8' });
  };
  const names = path.join(T, 'names.json');
  let p = sel(SUBJ, '--only-args', '--names-out', names);
  let nm = null; try { nm = JSON.parse(fs.readFileSync(names, 'utf8')); } catch { /* checked below */ }
  ok('T1. --only-args with {jobs}/{limitFile} in guardSubsetCommand -> exit 0, the --only list, the names file',
    p.status === 0 && p.stdout.trim() === "--only 'a-run.js'" && JSON.stringify(nm) === '["a-run.js"]', `${p.status} ${p.stdout}${p.stderr} names=${JSON.stringify(nm)}`);
  p = sel(SUBJ, '--json');
  let j = null; try { j = JSON.parse(p.stdout); } catch { /* checked below */ }
  ok('T2. --json with {jobs} in guardSubsetCommand -> exit 0, command "", the guard still selected',
    p.status === 0 && j && j.command === '' && j.guards.length === 1 && j.guards[0].path === 'a-run.js', `${p.status} ${p.stdout}${p.stderr}`);
  p = sel('cd {wt}/srv && npm run guards -- --all {onlyArgs}', '--json');
  j = null; try { j = JSON.parse(p.stdout); } catch { /* checked below */ }
  ok('T2. ... without {jobs}/{limitFile} -> the filled command',
    p.status === 0 && j && j.command === `cd '${s}'/srv && npm run guards -- --all --only 'a-run.js'`, `${p.status} ${p.stdout}${p.stderr}`);
  p = sel('cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency-file {limitFile}', '--command');
  ok('T2. --command with only {limitFile} -> 78 naming {limitFile}, nothing printed',
    p.status === 78 && /\{limitFile\}/.test(p.stderr) && /guards-all\.sh --select/.test(p.stderr) && !p.stdout.trim(), `${p.status} ${p.stdout}${p.stderr}`);

  // --- T3: an unknown placeholder at every place ---
  const has1 = (list, re) => list.some((e) => re.test(e));
  let e = errs({ guardSubsetCommand: SUBJ, remoteRun: Object.assign({}, RR, { localCommand: 'cd {wt} && run {onlyargs}' }) });
  ok('T3. remoteRun.localCommand with {onlyargs} (wrong case) -> unknown placeholder, naming the key', has1(e, /^remoteRun\.localCommand: unknown placeholder \{onlyargs\}/), e.join('; '));
  e = errs({ guardRerun: { command: 'cd {wt} && run --only {nmae}', newRedPattern: '^FAIL (\\S+)' } });
  ok('T3. guardRerun.command with {nmae} -> unknown placeholder', has1(e, /^guardRerun\.command: unknown placeholder \{nmae\}/), e.join('; '));
  e = errs({ guardSubsetCommand: SUBJ, remoteRun: { command: FULL, deps: [], subsetCommand: SUBJ + ' {job}' } });
  ok('T3. remoteRun.subsetCommand with {job} -> unknown placeholder', has1(e, /^remoteRun\.subsetCommand: unknown placeholder \{job\}/), e.join('; '));
  e = errs({ guardCommandLegacy: 'cd {wt} && run --concurrency {jobs} {limitfile}' });
  ok('T3. guardCommandLegacy with {limitfile} -> unknown placeholder', has1(e, /^guardCommandLegacy: unknown placeholder \{limitfile\}/), e.join('; '));
  e = errs({ guardSubsetCommand: 'cd {wt} && run {onlyArgs} {wt_dir}' });
  ok('T3. guardSubsetCommand with {wt_dir} -> unknown placeholder', has1(e, /^guardSubsetCommand: unknown placeholder \{wt_dir\}/), e.join('; '));

  // --- T5: a default is not reported twice ---
  e = errs({ guardCommand: 'cd {wt} && run {onlyArgs}', remoteRun: { deps: [] } });
  ok('T5. guardCommand with {onlyArgs}, remoteRun.command left to it -> one error, under guardCommand only',
    e.filter((x) => /\{onlyArgs\}/.test(x)).length === 1 && has1(e, /^guardCommand: \{onlyArgs\} is not filled in here/), e.join('; '));

  // --- T4: guards-remote.js run() with a config object ---
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\ntouch "$NOGHOST_SSH_MARK"\nexit 255\n');
  fs.chmodSync(path.join(bin, 'ssh'), 0o755);
  const w = repo(path.join(T, 'wt'));
  const runRemote = (localCommand, tag) => {
    const mark = path.join(T, `ssh-${tag}`);
    const cfg = { remote: { host: 'example.org', user: 'u', key: path.join(T, 'k'), knownHosts: path.join(T, 'kh'), root: '~/r', plugin: '/p' },
      remoteRun: { command: 'cd {wt} && run', deps: [], prepare: [], localPattern: '^skipped: (.+)$', localCommand }, guardRerun: null, guardBaseline: '', worktreeSetup: { scan: [] } };
    const src = `const GR = require(${JSON.stringify(path.join(ROOT, 'scripts', 'guards-remote.js'))});
      try { console.log('RC ' + GR.run(${JSON.stringify(cfg)}, ${JSON.stringify(w)}, ${JSON.stringify(path.join(T, `log-${tag}.txt`))}, 'n', '')); }
      catch (e) { console.log('STOP ' + e.code + ' ' + e.message); }`;
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, NOGHOST_SSH_MARK: mark }) });
    return { out: (r.stdout || '') + (r.stderr || ''), ssh: fs.existsSync(mark) };
  };
  let x = runRemote('cd {wt} && run {onlyArgs} --concurrency-file {limitFile}', 'lim');
  ok('T4. run() with {limitFile} in localCommand -> Stop 78 naming it, no ssh', /^STOP 78 .*remoteRun\.localCommand: \{limitFile\} is not filled in here/m.test(x.out) && !x.ssh, `${x.out} ssh=${x.ssh}`);
  x = runRemote('cd {wt} && run {onlyArgs} {job}', 'typo');
  ok('T4. run() with a typo {job} in localCommand -> Stop 78 "unknown placeholder {job}", no ssh', /^STOP 78 .*unknown placeholder \{job\}/m.test(x.out) && !x.ssh, `${x.out} ssh=${x.ssh}`);

  // --- T6: medium.sh and heavy.sh refuse 78 on the config of the case ---
  if (!has('zsh')) skip('T6. medium.sh/heavy.sh refuse 78', 'zsh not found');
  else {
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    const env0 = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(SLOT_|SLOTS_|GUARDS_|CODIS_|CLAUDE_PROJECT_DIR$)/.test(k)) env0[k] = v;
    // the knobs of slots.zsh by name (tests/slots-hermetic.test.js reads this list): none comes from the caller
    for (const k of ['GUARDS_EXCLUSIVE_LOCK', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOTS_DIR', 'SLOT_EXCL_TOOLS', 'SLOT_HEAVY_N',
      'SLOT_HIST_GAP', 'SLOT_JOURNAL', 'SLOT_KIND', 'SLOT_LABEL', 'SLOT_LEGACY_LOCK', 'SLOT_MEDIUM_N', 'SLOT_OS', 'SLOT_POLL', 'SLOT_PROC', 'SLOT_RETRY_RC', 'SLOT_SAY',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_THIRD_WINDOW', 'SLOT_TOTAL_MAX']) delete env0[k];
    const cf = path.join(T, 'case.json');
    fs.writeFileSync(cf, JSON.stringify({ repoDir: path.join(T, 'main'), worktreeRoot: T, sharedDir: path.join(T, 'shared'),
      slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') },
      guardCommand: 'cd {wt} && run --concurrency {jobs} --concurrency-file {limitFile}',
      guardSubsetCommand: 'cd {wt} && run {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}',
      remoteRun: { deps: [], localPattern: '^skipped \\(needs-mac\\): \\d+ - (.+)$' } }));
    Object.assign(env0, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', CODIS_AGENTS_CONFIG: cf });
    for (const tool of ['medium.sh', 'heavy.sh']) {
      const mark = path.join(T, `ran-${tool}`);
      const r = spawnSync('zsh', [path.join(ROOT, 'scripts', tool), 'touch', mark], { cwd: w, encoding: 'utf8', env: env0, timeout: 60000 });
      ok(`T6. ${tool} on the case's config -> 78 naming remoteRun.localCommand (default guardSubsetCommand) and {jobs}, {limitFile}; the command does not run`,
        r.status === 78 && /remoteRun\.localCommand \(default guardSubsetCommand\): \{jobs\}, \{limitFile\} are not filled in here/.test(r.stderr) && !fs.existsSync(mark),
        `${r.status} ran=${fs.existsSync(mark)} ${r.stdout}${r.stderr}`);
    }
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
