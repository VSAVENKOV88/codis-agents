#!/usr/bin/env node
'use strict';
// Tester cells, run as a child by tests/conductor-full-run-restart.test.js (its own tally, so README keeps counting
// test files): the conductor's full run step against the REAL guard-run script (p-codex-fullrun-a1, tester): a real
// conductor (scripts/chain-run.js start), real scripts/wait-step.js, the real scripts/guards-all.sh of this plugin (hermetic slots:
// a lock folder, a fake machine and a config of its own) and the real guards-result.js copy-check; only the roles are
// fake (tests/fixtures/conductor-full-run/claude, which can commit in the worktree as a real role does). The project
// has no guardSubsetCommand, so after every new programmer HEAD the conductor runs the full run itself. Its "suite" is
// guards.js in the worktree, steered by files committed there. Checked along the use cases of p-codex-fullrun:
// - UC-1/UC-2 (F1', F2', F17): one real run after the programmer, the copy of guards-all.sh's own log and record in the
//   steps folder of the run, the tester and the reviewer get the copy and HEAD; UC-5 (F4, F21'): a new start on the
//   same HEAD reuses the green run, the suite does not run again;
// - UC-3 (F9, F14r): a real red (red again alone in guards-all.sh's rerun) -> a fix round with the copy -> the fix is
//   committed -> a run on the new HEAD, green -> tester, review, done;
// - UC-2.2a (F15): a green tester that committed -> a real run on the tester's HEAD, whose copy the reviewer gets;
// - UC-4.1a (F13'): a run that exits 0 without its tally line, and a suite killed by a signal -> environment, never
//   green, no tester;
// - UC-1 error 3 (F7): tracked changes in the worktree during the run -> stopped for the coordinator, not the
//   environment, no tester;
// - UC-8 (F25'): conductorFullRun false -> no step, the programmer is told to run the full run itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cond-full-real-')));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } });
const SHARED = path.join(T, 's'), WTR = path.join(T, 'r'), REPO = path.join(T, 'repo'), CALLS = path.join(T, 'calls.log');
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });

if (!has('zsh')) { skip('the conductor runs the real guards-all.sh', 'zsh not found'); done(); return; }

// the fake machine in front of PATH (tests/slots-hermetic.test.js) and the fake role CLI
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'conductor-full-run', 'claude'), path.join(bin, 'claude'));
fs.chmodSync(path.join(bin, 'claude'), 0o755);
const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_SAY', 'CODIS_GUARDS_EXEC']) delete env[k];

// the repository: its "suite" guards.js reads the files committed next to it
fs.mkdirSync(REPO);
git(REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
fs.writeFileSync(path.join(REPO, 'guards.js'), `const fs = require('fs');
const [calls, name] = process.argv.slice(2);
fs.appendFileSync(calls, require('path').basename(process.cwd()) + ' ' + (name || 'all') + '\\n');
const has = (f) => fs.existsSync(f);
if (has('selfkill')) process.kill(process.pid, 'SIGKILL');
if (has('notally')) { console.log('ok a.test.js'); process.exit(0); }
if (has('dirty')) fs.appendFileSync('a.js', 'changed during the run\\n');
if (has('bad')) { console.log('FAIL a.test.js (1 s, exit 1)'); if (!name) console.log('0 of 1 test files passed'); process.exit(1); }
console.log('ok a.test.js');
console.log('1 of 1 test files passed');
`);
git(REPO, 'add', 'a.js', 'guards.js');
git(REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git(REPO, 'rev-parse', 'HEAD').stdout.trim();
// a worktree per scenario, with the files that steer its suite committed on its branch
const wt = (name, files) => {
  const w = path.join(WTR, name);
  git(REPO, 'worktree', 'add', '-q', '-b', `b-${name}`, w, SHA0);
  for (const f of files) { fs.writeFileSync(path.join(w, f), '1\n'); git(w, 'add', f); }
  if (files.length) git(w, 'commit', '-q', '-m', 'steer');
  return w;
};

const cfgFile = (name, extra) => {
  const f = path.join(T, name);
  fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR,
    guardCommand: `cd {wt} && node guards.js ${CALLS}`, testerWritable: ['-run\\.js$'],
    guardRerun: { command: `cd {wt} && node guards.js ${CALLS} {name}`, newRedPattern: '^FAIL (\\S+) \\(', tallyPattern: '^\\d+ of (\\d+) test files passed' },
    slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }, extra || {})));
  return f;
};
const CFG = cfgFile('codis-agents.json');
const OWNER = path.join(T, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test task');
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = (w, sh0) => Object.assign({ status: 'ready', changedFiles: ['a.js'], commits: ['c'], $headOf: w, mutations: 'm', fullRun: 'the workflow runs it', questions: [], summary: 's' }, sh0 ? { $sh: sh0 } : {});
const GREEN = (w, sh0) => Object.assign({ verdict: 'green', $headOf: w, summary: 'acc ok' }, sh0 ? { $sh: sh0 } : {});
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const commitIn = (w, what) => `cd '${w}' && ${what} && git -c user.name=t -c user.email=t@t commit -q -am x`;

// one task through the real conductor: answers per role key; returns its result, the trace of the roles and the run
function runTask(key, w, answers, cfg) {
  const fd = path.join(T, `fake-${key}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(fd);
  fs.writeFileSync(path.join(fd, 'answers.json'), JSON.stringify(Object.assign({ default: { 'gp:blockingQuestions,ok,problems': PRE, reviewer: DONE } }, answers)));
  const tasks = path.join(fd, 'tasks.json');
  fs.writeFileSync(tasks, JSON.stringify([{ key, title: key, wt: path.basename(w), branch: `b-${path.basename(w)}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }]));
  const e = Object.assign({}, env, { FAKE_CLI_DIR: fd });
  const cr = (args, ms) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'chain-run.js')].concat(args), { encoding: 'utf8', env: e, timeout: ms });
  const s = cr(['start', '--host', 'claude', '--tasks', tasks, '--owner', OWNER, '--config', cfg || CFG], 60000);
  let j = null;
  try { j = JSON.parse(s.stdout); } catch { /* below */ }
  if (!j || !j.runDir) return { r: null, why: s.stdout + s.stderr, trace: [] };
  const st = cr(['status', j.runDir, '--config', cfg || CFG, '--wait', '150'], 170000);
  let sj = null;
  try { sj = JSON.parse(st.stdout); } catch { /* below */ }
  const trace = text(path.join(fd, 'trace.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { r: sj && (sj.results || [])[0], runDir: j.runDir, steps: path.join(j.runDir, 'steps', key), trace, log: text(path.join(j.runDir, 'log.txt')) };
}
const prompt = (x, k, n) => (x.trace.find((c) => c.key === k && c.n === (n || 1)) || {}).prompt || '';
const runs = (name) => text(CALLS).split('\n').filter((l) => l.startsWith(`${name} `));
const meta = (f) => { try { return JSON.parse(text(`${f}.meta.json`)); } catch { return null; } };
const why = (x) => JSON.stringify(x.r) + '\n' + (x.log || x.why || '').slice(-2500);
const head = (w) => git(w, 'rev-parse', 'HEAD').stdout.trim();

// ---- UC-1 main, UC-2 (F1', F2', F17)
let w = wt('w-green', []);
let x = runTask('green', w, { programmer: [PROG(w)], tester: [GREEN(w)] });
let H = head(w);
let copy = path.join(x.steps || T, 'wait-full-1.guards.txt');
ok('UC-1 green: the task is done after one real full run of the worktree (guards-all.sh <worktree>)', !!x.r && x.r.status === 'done' && runs('w-green').length === 1, why(x) + text(CALLS));
ok('UC-1 the copy of guards-all.sh\'s own log lies in the steps folder, with its record: HEAD, a clean tree, exit 0, env local',
  /1 of 1 test files passed/.test(text(copy)) && !!meta(copy) && meta(copy).head === H && meta(copy).headEnd === H && meta(copy).cleanStart === true && meta(copy).cleanEnd === true
  && meta(copy).rc === 0 && (!meta(copy).env || meta(copy).env === 'local'), text(copy) + JSON.stringify(meta(copy)));
ok('UC-2 the tester prompt names the copy and HEAD, and tells it not to run the full suite', prompt(x, 'tester').includes(copy) && prompt(x, 'tester').includes(H)
  && /do NOT run the full suite/.test(prompt(x, 'tester')), prompt(x, 'tester').slice(0, 400));
ok('UC-2 the reviewer prompt names the copy and HEAD, "do not repeat it"', prompt(x, 'reviewer').includes(copy) && prompt(x, 'reviewer').includes(H) && /do not repeat it/.test(prompt(x, 'reviewer')));
ok('UC-1 the programmer prompt: no full run of its own', /no full run of your own/.test(prompt(x, 'programmer')) && !/-> full run .*guards-all\.sh .* in the background/.test(prompt(x, 'programmer')));
ok('UC-1 the done result names the full run of its HEAD', new RegExp(`exit 0 on ${H}`).test(x.r && x.r.full || ''), JSON.stringify(x.r));

// ---- UC-5.4 / UC-1.3a (F4, F21'): a new start of the same task on the same HEAD reuses the green run
x = runTask('green', w, { programmer: [PROG(w)], tester: [GREEN(w)] });
copy = path.join(x.steps || T, 'wait-full-1.guards.txt');
ok('UC-5 a new start on the same HEAD: done, guards-all.sh reused the green run - the suite did not run again', !!x.r && x.r.status === 'done' && runs('w-green').length === 1, why(x) + text(CALLS));
ok('UC-5 the new run has its own checked copy in its steps folder', fs.existsSync(copy) && !!meta(copy) && meta(copy).head === H, copy);

// ---- UC-3 (F9, F14r): a real red, red again alone -> a fix round with the copy -> a commit -> green on the new HEAD
w = wt('w-red', ['bad']);
const H0 = head(w);
x = runTask('red', w, { programmer: [PROG(w), PROG(w, commitIn(w, 'git rm -q bad'))], tester: [GREEN(w)] });
H = head(w);
const copyRed = path.join(x.steps || T, 'wait-full-1.guards.txt');
ok('UC-3 a red run: the conductor ran the suite, guards-all.sh reran the red alone (red again), the step exited 1', runs('w-red').includes('w-red a.test.js')
  && !!meta(copyRed) && meta(copyRed).rc === 1 && meta(copyRed).head === H0, text(CALLS) + JSON.stringify(meta(copyRed)));
ok('UC-3 the fix round gets the copy of the red log, exit 1, and "do not run the full run yourself"', prompt(x, 'programmer', 2).includes(copyRed) && /exited 1/.test(prompt(x, 'programmer', 2))
  && /Do not run the full run yourself/.test(prompt(x, 'programmer', 2)), prompt(x, 'programmer', 2).slice(0, 600));
ok('UC-3 after the fix commit a run on the new HEAD is green, then tester and review: done', !!x.r && x.r.status === 'done' && H !== H0
  && meta(path.join(x.steps, 'wait-full-1f.guards.txt')) && meta(path.join(x.steps, 'wait-full-1f.guards.txt')).head === H && prompt(x, 'tester').includes(path.join(x.steps, 'wait-full-1f.guards.txt')), why(x));
ok('UC-3 the suite ran twice in full (red HEAD, fixed HEAD) plus one rerun alone', runs('w-red').filter((l) => / all$/.test(l)).length === 2, runs('w-red').join(','));

// ---- UC-2.2a (F15): a green tester that committed its guard -> a real run on the tester's HEAD
w = wt('w-tester', []);
x = runTask('tester', w, { programmer: [PROG(w)], tester: [GREEN(w, `cd '${w}' && echo 1 > t-run.js && git add t-run.js && git -c user.name=t -c user.email=t@t commit -q -m guard`)] });
H = head(w);
const copyT = path.join(x.steps || T, 'wait-full-tester-1.guards.txt');
ok('UC-2.2a a green tester with its own commit -> a full run on its HEAD before the review; the reviewer gets that copy', !!x.r && x.r.status === 'done' && runs('w-tester').length === 2
  && !!meta(copyT) && meta(copyT).head === H && prompt(x, 'reviewer').includes(copyT) && prompt(x, 'reviewer').includes(H), why(x) + runs('w-tester').join(','));

// ---- UC-4.1a (F13'): exit 0 without the tally line -> environment, never green
w = wt('w-notally', ['notally']);
x = runTask('notally', w, { programmer: [PROG(w)], tester: [GREEN(w)] });
ok('UC-4.1a a run that exits 0 without its tally line -> stopped as the environment "cut off before its tally", no tester', !!x.r && x.r.status === 'stopped' && !!x.r.environment
  && /cut off before its tally/.test(x.r.why || '') && !x.trace.some((c) => c.key === 'tester'), why(x));

// ---- UC-4.1a (F13'): the suite killed by a signal -> environment, no programmer round
w = wt('w-kill', ['selfkill']);
x = runTask('kill', w, { programmer: [PROG(w)], tester: [GREEN(w)] });
ok('UC-4.1a the suite killed by SIGKILL -> stopped as the environment "cut off before its tally" (signal 9), no fix round, no tester', !!x.r && x.r.status === 'stopped' && !!x.r.environment
  && /cut off before its tally/.test(x.r.why || '') && /signal 9/.test(x.r.why || '') && x.trace.filter((c) => c.key === 'programmer').length === 1 && !x.trace.some((c) => c.key === 'tester'), why(x));

// ---- UC-1 error 3 (F7): tracked changes during the run -> the coordinator, not green, not the environment
w = wt('w-dirty', ['dirty']);
x = runTask('dirty', w, { programmer: [PROG(w)], tester: [GREEN(w)] });
ok('UC-1 err tracked changes during the run -> stopped for the coordinator ("commit first"), not the environment, no tester', !!x.r && x.r.status === 'stopped'
  && !x.r.environment && /commit first/.test(x.r.why || '') && !x.trace.some((c) => c.key === 'tester'), why(x));

// ---- UC-8 (F25'): conductorFullRun false -> the earlier path
w = wt('w-off', []);
x = runTask('off', w, { programmer: [PROG(w)], tester: [GREEN(w)] }, cfgFile('off.json', { conductorFullRun: false }));
ok('UC-8 conductorFullRun false: done with no full run step, the programmer is told to run the full run itself', !!x.r && x.r.status === 'done' && runs('w-off').length === 0
  && /full run .*guards-all\.sh .* in the background/.test(prompt(x, 'programmer')) && !fs.existsSync(path.join(x.steps, 'wait-full-1.guards.txt')), why(x));
done();
