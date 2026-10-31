#!/usr/bin/env node
'use strict';
// p-noghost-c: the smoke check of a project config, `config.js smoke <worktree> <guard> [<guard of the part here>]`
// (cells D1-D7 of the p-noghost matrix; coordinator's decision 8 of 2026-10-31: the rule for the coordinator is a line in
// rules/multi-agent.md and skills/coordinator without a role marker) and the quiet mark of slots-linux-edges.test.sh.
// Case 2026-10-30: a guardSubsetCommand edited with {jobs} ran 0 of 10 guards in the part here and exited 0; nothing ran
// the edited config through its paths before two trains went green. The smoke runs one guard on every path that narrows
// a command to named guards (the selection here, the runner's selection, the part here) and is red when a path accounted
// for 0 of it; the full commands (no {onlyArgs}) get the static check of config.js only.
//   here: D1 (the main working copy), D2 (selection here), D4 (part here), D5 (a path with 0), D6 (an extra
//     placeholder), D7 (full commands not run), D3 without a runner ("none"), usage;
//   with a fake remote runner: D3 (the runner's selection ok, 0 of it red even when guards-all.sh is green because the
//     runner skipped it by a flag and the part here ran it), no remoteRun.subsetCommand -> "none".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 1200));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const TALLY = '^TOTAL: (\\d+) total$';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+)  \\(', tallyPattern: TALLY };
const LOCALP = '^skipped \\(needs-font\\): \\d+ — (.+)$';

const fakeBin = (bin) => {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
};
const cleanEnv = () => {
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
};

// The project: a main checkout and a task worktree xw with fake runners that record their arguments.
function project(TMP, put0) {
  const main = path.join(TMP, 'main'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared');
  for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
  // each runner prints the log of its own file and exits with the code of its own file
  for (const r of ['full', 'sub', 'local']) put(`${r}.sh`, `#!/bin/sh\necho "$*" >> "${TMP}/${r}.count"\ncat "${TMP}/${r}.log"\nexit $(cat "${TMP}/${r}.rc" 2>/dev/null || echo 0)\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$1" >> "${TMP}/one.count"\necho "TOTAL: 1 total"\nexit $(cat "${TMP}/one.rc" 2>/dev/null || echo 0)\n`, 0o755);
  put('g/a-run.js', '// a\n'); put('g/b-run.js', '// b\n');
  if (put0) put0(put);
  gitC(main, 'init', '-q', '-b', 'trunk'); gitC(main, 'add', '.'); gitC(main, 'commit', '-q', '-m', 'project');
  const xw = path.join(wts, 'xw');
  gitC(main, 'worktree', 'add', '-q', '-b', 'task', xw);
  const set = (o) => {
    for (const r of ['full', 'sub', 'local']) {
      fs.writeFileSync(path.join(TMP, `${r}.log`), (o[r] && o[r][1]) || 'TOTAL: 1 total\n');
      fs.writeFileSync(path.join(TMP, `${r}.rc`), String((o[r] && o[r][0]) || 0));
      fs.rmSync(path.join(TMP, `${r}.count`), { force: true });
    }
    fs.writeFileSync(path.join(TMP, 'one.rc'), String(o.one || 0));   // the single rerun of a new red: red alone with 1
    fs.rmSync(path.join(TMP, 'one.count'), { force: true });
  };
  const count = (n) => (read(path.join(TMP, `${n}.count`)) || '').split('\n').filter(Boolean);
  return { main, wts, shared, xw, set, count };
}

function partLocal(TMP) {
  const bin = path.join(TMP, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fakeBin(bin);
  const P = project(TMP);
  const cfgOf = (o) => Object.assign({ repoDir: P.main, worktreeRoot: P.wts, sharedDir: P.shared, guardCommand: 'cd {wt} && ./full.sh --jobs {jobs}',
    guardSubsetCommand: 'cd {wt} && ./sub.sh --jobs {jobs} {onlyArgs}', guardRerun: RERUN, protectedBranches: ['trunk'],
    remoteRun: { command: 'cd {wt} && ./full.sh --jobs {jobs}', localPattern: LOCALP, localCommand: 'cd {wt} && ./local.sh {onlyArgs}' },
    slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }, o);
  const f = path.join(TMP, 'cfg.json');
  const write = (o) => fs.writeFileSync(f, JSON.stringify(cfgOf(o)));
  cleanEnv();
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const smoke = (...a) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'smoke', ...a], { encoding: 'utf8', env, timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };

  // usage
  write({});
  let x = smoke(P.xw);
  ok('usage. smoke without a guard -> exit 64, nothing runs', x.status === 64 && /usage: config\.js smoke/.test(x.all) && !P.count('sub').length, `${x.status} ${x.all}`);

  // D1: the main working copy
  P.set({});
  x = smoke(P.main, 'g/a-run.js');
  ok('D1. smoke on the main working copy -> exit 78 naming it, no path runs', x.status === 78 && /main working copy/.test(x.all)
    && !P.count('sub').length && !P.count('local').length && !P.count('full').length, `${x.status} ${x.all}`);

  // D6: an extra placeholder - the config error, before any path
  write({ guardSubsetCommand: 'cd {wt} && ./sub.sh --jobs {jobs} --name {name} {onlyArgs}' });
  P.set({});
  x = smoke(P.xw, 'g/a-run.js');
  ok('D6. a guardSubsetCommand with {name} -> red (exit 1) naming the key and {name}, no path runs', x.status === 1 && /guardSubsetCommand: \{name\} is not filled in here/.test(x.all)
    && !P.count('sub').length && !P.count('local').length, `${x.status} ${x.all}`);
  ok('D6. ... the config error is red before any path: "no path ran", no "== config.js smoke:" line and no path summary', /the config .* has errors \(above\); no path ran/.test(x.all)
    && !/^== config\.js smoke:/m.test(x.all) && !/^(ok|RED|none) +(selection here|runner|part here)/m.test(x.all), x.all);
  write({ remoteRun: { command: 'cd {wt} && ./full.sh --jobs {jobs}', localPattern: LOCALP } });   // localCommand by default = guardSubsetCommand with {jobs}: the case of 2026-10-30
  x = smoke(P.xw, 'g/a-run.js');
  ok('D6. the case of 2026-10-30: localCommand by default guardSubsetCommand with {jobs} -> red naming remoteRun.localCommand and {jobs}', x.status === 1
    && /remoteRun\.localCommand \(default guardSubsetCommand\): \{jobs\} is not filled in here/.test(x.all) && !P.count('sub').length
    && /no path ran/.test(x.all) && !/^== config\.js smoke:/m.test(x.all), `${x.status} ${x.all}`);

  // D2 + D4 + D7 + D3 (no runner): every path accounts for its one guard
  write({});
  P.set({ sub: [0, 'TOTAL: 1 total\n'], local: [0, 'TOTAL: 1 total\n'] });
  x = smoke(P.xw, 'g/a-run.js', 'g/b-run.js');
  const sub = P.count('sub'), loc = P.count('local');
  ok('D2/D4. both paths here account for 1 -> exit 0', x.status === 0, `${x.status} ${x.all}`);
  ok('D2. the selection here ran guardSubsetCommand once with the one guard and {jobs} filled', sub.length === 1 && /^--jobs [0-9]+ --only '?g\/a-run\.js'?$/.test(sub[0]), sub.join(' | '));
  ok('D2. ... a line "ok selection here (guardSubsetCommand)" with the count', /^ok +selection here \(guardSubsetCommand\): accounted for 1 of 1/m.test(x.all), x.all);
  ok('D4. the part here ran remoteRun.localCommand once with the guard of the part here', loc.length === 1 && /^--only '?g\/b-run\.js'?$/.test(loc[0]), loc.join(' | '));
  ok('D4. ... a line "ok part here (remoteRun.localCommand)" with the count', /^ok +part here \(remoteRun\.localCommand\): accounted for 1 of 1/m.test(x.all), x.all);
  ok('D3. no remote runner in the machine file -> a line "none runner", not a failure', /^none +runner/m.test(x.all), x.all);
  ok('D7. the full commands never run; a line names them as checked statically only', !P.count('full').length && /^static +full run \(guardCommand, remoteRun\.command\)/m.test(x.all), x.all);
  ok('D7. ... no single rerun ran', !P.count('one').length, P.count('one').join(' | '));

  // D5: a path that accounted for 0
  P.set({ sub: [0, 'TOTAL: 0 total\n'], local: [0, 'TOTAL: 1 total\n'] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D5. the selection here accounted for 0 of 1 (exit 0 of the runner) -> exit 1, a line "RED selection here"', x.status === 1 && /^RED +selection here \(guardSubsetCommand\)/m.test(x.all)
    && /^ok +part here/m.test(x.all), `${x.status} ${x.all}`);
  ok('D4. the guard of the part here defaults to the guard', /^--only '?g\/a-run\.js'?$/.test(P.count('local')[0] || ''), P.count('local').join(' | '));
  P.set({ sub: [0, 'TOTAL: 1 total\n'], local: [0, 'TOTAL: 0 total\n'] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D5. the part here accounted for 0 of 1 -> exit 1, a line "RED part here"', x.status === 1 && /^RED +part here \(remoteRun\.localCommand\)/m.test(x.all) && /^ok +selection here/m.test(x.all), `${x.status} ${x.all}`);
  P.set({ sub: [0, 'TOTAL: 1 total\n'], local: [0, `skipped (needs-font): 1 — g/a-run.js\nTOTAL: 0 total\n`] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D5. the part here skipped its one guard by a flag (0 run) -> still red: the smoke needs the guard run', x.status === 1 && /^RED +part here/m.test(x.all), `${x.status} ${x.all}`);
  P.set({ sub: [0, 'no tally here\n'] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D5. a selection here without a tally line -> red', x.status === 1 && /^RED +selection here/m.test(x.all), `${x.status} ${x.all}`);
  P.set({ sub: [1, 'X g/a-run.js  (1.0s, code 1)\nTOTAL: 1 total\n'], one: 1 });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D5. the one guard red on the selection here -> red with its exit code (pick a green guard)', x.status === 1 && /^RED +selection here .*exit 1/m.test(x.all), `${x.status} ${x.all}`);

  // no narrowing path at all: the static check only, exit 0
  write({ guardSubsetCommand: '', remoteRun: undefined });
  P.set({});
  x = smoke(P.xw, 'g/a-run.js');
  ok('D7. no guardSubsetCommand and no remoteRun.localPattern -> exit 0, "none" for every path, nothing runs', x.status === 0 && /^none +selection here/m.test(x.all) && /^none +part here/m.test(x.all)
    && !P.count('sub').length && !P.count('full').length, `${x.status} ${x.all}`);
}

function partRemote(TMP) {
  const bin = path.join(TMP, 'bin'), S = path.join(TMP, 'server');
  for (const d of [bin, S]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env, cwd: ${JSON.stringify(S)} });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
  const P = project(TMP);
  gitC(P.main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  fs.writeFileSync(path.join(TMP, 'key'), 'not a key\n'); fs.writeFileSync(path.join(TMP, 'kh'), 'example.org ssh-ed25519 AAAA\n');
  const remote = { host: 'example.org', user: 'runner', key: path.join(TMP, 'key'), knownHosts: path.join(TMP, 'kh'), root: '~/codis-runs', plugin: ROOT };
  const mfile = path.join(TMP, 'machine.json');
  fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(TMP, 'slots') }, remote }));
  fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
  fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
  const f = path.join(TMP, 'cfg.json');
  const write = (rr) => fs.writeFileSync(f, JSON.stringify({ repoDir: P.main, worktreeRoot: P.wts, sharedDir: P.shared, guardCommand: 'cd {wt} && ./full.sh --jobs {jobs}', guardRerun: RERUN,
    guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', protectedBranches: ['trunk'],
    remoteRun: Object.assign({ command: 'cd {wt} && ./full.sh --jobs {jobs}', localPattern: LOCALP }, rr) }));
  cleanEnv();
  const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
    SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV });
  const smoke = (...a) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'smoke', ...a], { encoding: 'utf8', env, timeout: 240000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };

  // D3: the runner's selection (remoteRun.subsetCommand runs full.sh there)
  write({ subsetCommand: 'cd {wt} && ./full.sh {onlyArgs} --jobs {jobs}' });
  P.set({ full: [0, 'TOTAL: 1 total\n'], local: [0, 'TOTAL: 1 total\n'] });
  let x = smoke(P.xw, 'g/a-run.js');
  const fc = P.count('full');
  ok('D3. the runner\'s selection ran the one guard there with {jobs} filled -> "ok runner", exit 0', x.status === 0 && fc.length === 1 && /--only '?g\/a-run\.js'? --jobs [0-9]+/.test(fc[0])
    && /^ok +runner \(remoteRun\.subsetCommand\): accounted for 1 of 1/m.test(x.all), `${x.status} ${fc.join(' | ')} ${x.all}`);
  ok('D3. ... the selection here and the part here ran too', /^ok +selection here/m.test(x.all) && /^ok +part here/m.test(x.all), x.all);
  // the runner skips the guard by its flag; the part here of that run runs it: guards-all.sh is green, the smoke is not
  P.set({ full: [0, 'skipped (needs-font): 1 — g/a-run.js\nTOTAL: 0 total\n'], local: [0, 'TOTAL: 1 total\n'] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D3/D5. the runner accounted for 0 of its one guard (skipped there by a flag) -> "RED runner", exit 1', x.status === 1 && /^RED +runner \(remoteRun\.subsetCommand\)/m.test(x.all), `${x.status} ${x.all}`);
  // no remoteRun.subsetCommand: the selection runs here, the runner path is "none"
  write({});
  P.set({ local: [0, 'TOTAL: 1 total\n'] });
  x = smoke(P.xw, 'g/a-run.js');
  ok('D3. a runner without remoteRun.subsetCommand -> "none runner" naming the key, exit 0', x.status === 0 && /^none +runner .*remoteRun\.subsetCommand/m.test(x.all) && !P.count('full').length, `${x.status} ${x.all}`);
}

function partDocs() {
  const rules = read(path.join(ROOT, 'rules', 'multi-agent.md')) || '';
  const line = rules.split('\n').find((l) => /config\.js smoke/.test(l)) || '';
  ok('decision 8. rules/multi-agent.md: a line on config.js smoke for the coordinator (a project config edit only after a green smoke)', /config\.js smoke/.test(line) && /green smoke/.test(rules), line);
  ok('decision 8. ... without a role marker (the coordinator is not a workflow role)', !/<!-- role:/.test(line), line);
  const skill = read(path.join(ROOT, 'skills', 'coordinator', 'SKILL.md')) || '';
  ok('decision 8. skills/coordinator names config.js smoke', /config\.js smoke/.test(skill), '');
  const readme = read(path.join(ROOT, 'README.md')) || '';
  ok('README documents config.js smoke', /config\.js smoke/.test(readme), '');
  const usage = read(path.join(ROOT, 'scripts', 'config.js')) || '';
  ok('config.js usage names smoke', /config\.js smoke <worktree> <guard>/.test(usage), '');
  const sh = read(path.join(ROOT, 'tests', 'slots-linux-edges.test.sh')) || '';
  ok('review e1. slots-linux-edges.test.sh is quiet (runs alone in the quiet phase of tests/run.js)', /^# tests:quiet - \S/m.test(sh), sh.slice(0, 300));
}

const part = (name, fn) => { try { fn(); } catch (e) { ok(`${name}: no exception`, false, e && e.stack); } };
part('docs', partDocs);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-c-')));
try {
  if (!(has('zsh') && has('git'))) skip('config.js smoke end to end', 'zsh or git not found');
  else {
    fs.mkdirSync(path.join(TMP, 'l')); fs.mkdirSync(path.join(TMP, 'r'));
    part('smoke here', () => partLocal(path.join(TMP, 'l')));
    if (!has('perl')) skip('the remote runner', 'perl not found'); else part('smoke with a runner', () => partRemote(path.join(TMP, 'r')));
  }
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
done();
