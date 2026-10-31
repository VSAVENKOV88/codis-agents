#!/usr/bin/env node
'use strict';
// Tester guard of p-noghost-c (config.js smoke): the cells tests/noghost-c.test.js does not reach.
//   T1 a worktree outside worktreeRoot: the smoke reads the log under the name guards-all.sh gives it (basename-cksum),
//      else every selection path would be red with "no tally line";
//   T2 worktreeRoot named through a symbolic link, the worktree through the link too: still the same log name;
//   T3 no such worktree -> 66, nothing runs; T4 an unknown flag -> 64, nothing runs;
//   T5 a guard name with braces ({jobs}, {wt}) reaches both paths literally, never filled as a placeholder;
//   T6 an edited copy named by CODIS_AGENTS_CONFIG wins over the worktree's own config (README, rules, skills/coordinator
//      promise it); without it the worktree's own config is used;
//   T7 a part here with its own localCommand and no guardSubsetCommand: "none selection here", "ok part here".
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
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+)  \\(', tallyPattern: '^TOTAL: (\\d+) total$' };
const LOCALP = '^skipped \\(needs-font\\): \\d+ — (.+)$';

function fakeBin(bin) {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
}

function main(TMP) {
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
  const bin = path.join(TMP, 'bin'), mainD = path.join(TMP, 'main'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared');
  for (const d of [bin, mainD, wts, shared]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(mainD, f)), { recursive: true }); fs.writeFileSync(path.join(mainD, f), s); if (mode) fs.chmodSync(path.join(mainD, f), mode); };
  for (const r of ['sub', 'local']) put(`${r}.sh`, `#!/bin/sh\necho "$*" >> "${TMP}/${r}.count"\necho "TOTAL: $(cat "${TMP}/${r}.n" 2>/dev/null || echo 1) total"\n`, 0o755);
  put('one.sh', '#!/bin/sh\necho "TOTAL: 1 total"\n', 0o755);
  const cfgOf = (o) => Object.assign({ repoDir: mainD, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./sub.sh --full --jobs {jobs}',
    guardSubsetCommand: 'cd {wt} && ./sub.sh --jobs {jobs} {onlyArgs}', guardRerun: RERUN, protectedBranches: ['trunk'],
    remoteRun: { command: 'cd {wt} && ./sub.sh --full --jobs {jobs}', localPattern: LOCALP, localCommand: 'cd {wt} && ./local.sh {onlyArgs}' },
    slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }, o);
  // the project's own config, committed: its selection command is marked --from-wt
  put('.claude/codis-agents.json', JSON.stringify(cfgOf({ guardSubsetCommand: 'cd {wt} && ./sub.sh --from-wt --jobs {jobs} {onlyArgs}' })));
  gitC(mainD, 'init', '-q', '-b', 'trunk'); gitC(mainD, 'add', '.'); gitC(mainD, 'commit', '-q', '-m', 'project');
  const xw = path.join(wts, 'xw');
  gitC(mainD, 'worktree', 'add', '-q', '-b', 'task', xw);
  const outside = path.join(TMP, 'elsewhere', 'xw');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  gitC(mainD, 'worktree', 'add', '-q', '-b', 'task2', outside);

  const f = path.join(TMP, 'cfg.json');
  const write = (o) => fs.writeFileSync(f, JSON.stringify(cfgOf(o)));
  const count = (n) => (read(path.join(TMP, `${n}.count`)) || '').split('\n').filter(Boolean);
  const reset = () => { for (const n of ['sub', 'local']) { fs.rmSync(path.join(TMP, `${n}.count`), { force: true }); fs.rmSync(path.join(TMP, `${n}.n`), { force: true }); } };
  const baseEnv = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const smokeE = (env, ...a) => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'smoke', ...a], { encoding: 'utf8', env, timeout: 180000, cwd: TMP }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const withCfg = Object.assign({}, baseEnv, { CODIS_AGENTS_CONFIG: f });
  const smoke = (...a) => smokeE(withCfg, ...a);

  // T3, T4
  write({}); reset();
  let x = smoke(path.join(TMP, 'nope'), 'g/a-run.js');
  ok('T3. no such worktree -> exit 66 naming it, nothing runs', x.status === 66 && /no worktree/.test(x.all) && !count('sub').length && !count('local').length, `${x.status} ${x.all}`);
  x = smoke(xw, 'g/a-run.js', '--bogus');
  ok('T4. an unknown flag -> exit 64 (usage), nothing runs', x.status === 64 && /usage: config\.js smoke/.test(x.all) && !count('sub').length, `${x.status} ${x.all}`);

  // T1: a worktree outside worktreeRoot
  reset();
  x = smoke(outside, 'g/a-run.js');
  ok('T1. a worktree outside worktreeRoot -> both paths ok, exit 0 (the smoke reads the log guards-all.sh wrote)', x.status === 0
    && /^ok +selection here \(guardSubsetCommand\): accounted for 1 of 1/m.test(x.all) && /^ok +part here/m.test(x.all) && count('sub').length === 1, `${x.status} ${x.all}`);
  const logs = fs.readdirSync(shared).filter((n) => /^guards-xw-\d+\.select\.txt$/.test(n));
  ok('T1. ... its selection log is guards-xw-<cksum>.select.txt (the name of guards-all.sh), and the summary names that log', logs.length === 1 && x.all.includes(path.join(shared, logs[0])), `${fs.readdirSync(shared).join(', ')} | ${x.all}`);
  reset(); fs.writeFileSync(path.join(TMP, 'sub.n'), '0');
  x = smoke(outside, 'g/a-run.js');
  ok('T1. ... and 0 there is still red', x.status === 1 && /^RED +selection here .*accounted for 0 of 1/m.test(x.all), `${x.status} ${x.all}`);

  // T2: worktreeRoot through a symbolic link
  const link = path.join(TMP, 'wlink');
  fs.symlinkSync(wts, link);
  write({ worktreeRoot: link }); reset();
  x = smoke(path.join(link, 'xw'), 'g/a-run.js');
  ok('T2. worktreeRoot and the worktree named through a symbolic link -> ok, log guards-xw.select.txt', x.status === 0 && /^ok +selection here/m.test(x.all)
    && x.all.includes(path.join(shared, 'guards-xw.select.txt')), `${x.status} ${x.all}`);

  // T5: braces in a guard name
  write({}); reset();
  x = smoke(xw, 'g/{jobs}-run.js', 'g/{wt}-run.js');
  const s5 = count('sub'), l5 = count('local');
  ok('T5. a guard named with {jobs} reaches the selection here literally', x.status === 0 && s5.length === 1 && /--only '?g\/\{jobs\}-run\.js'?$/.test(s5[0]), `${x.status} ${s5.join(' | ')} ${x.all}`);
  ok('T5. a guard of the part here named with {wt} reaches the part here literally', l5.length === 1 && /^--only '?g\/\{wt\}-run\.js'?$/.test(l5[0]), l5.join(' | '));

  // T6: the edited copy wins; without it the worktree's own config
  write({ guardSubsetCommand: 'cd {wt} && ./sub.sh --from-env --jobs {jobs} {onlyArgs}' }); reset();
  x = smoke(xw, 'g/a-run.js');
  ok('T6. CODIS_AGENTS_CONFIG names an edited copy -> the smoke runs its command and names that file', x.status === 0 && count('sub').length === 1 && /--from-env/.test(count('sub')[0])
    && x.all.includes(`config.js smoke ${f}:`), `${count('sub').join(' | ')} ${x.all}`);
  reset();
  x = smokeE(baseEnv, xw, 'g/a-run.js');
  ok('T6. without CODIS_AGENTS_CONFIG -> the worktree\'s own config (--from-wt), from any cwd', x.status === 0 && count('sub').length === 1 && /--from-wt/.test(count('sub')[0])
    && x.all.includes(path.join(xw, '.claude', 'codis-agents.json')), `${x.status} ${count('sub').join(' | ')} ${x.all}`);
  write({ guardSubsetCommand: 'cd {wt} && ./sub.sh --jobs {jobs} --x {name} {onlyArgs}' }); reset();
  x = smoke(xw, 'g/a-run.js');
  ok('T6. an edited copy with an extra placeholder is red even though the worktree\'s own config is fine', x.status === 1 && /no path ran/.test(x.all) && !count('sub').length, `${x.status} ${x.all}`);

  // T7: a part here without guardSubsetCommand
  write({ guardSubsetCommand: '' }); reset();
  x = smoke(xw, 'g/a-run.js');
  ok('T7. no guardSubsetCommand, own localCommand -> "none selection here", "ok part here", exit 0', x.status === 0 && /^none +selection here/m.test(x.all)
    && /^ok +part here \(remoteRun\.localCommand\): accounted for 1 of 1/m.test(x.all) && !count('sub').length && count('local').length === 1, `${x.status} ${x.all}`);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-c-t-')));
try {
  if (!(has('zsh') && has('git'))) skip('config.js smoke, tester cells', 'zsh or git not found');
  else { try { main(TMP); } catch (e) { ok('no exception', false, e && e.stack); } }
} finally { fs.rmSync(TMP, { recursive: true, force: true }); }
done();
