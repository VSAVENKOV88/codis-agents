#!/usr/bin/env node
'use strict';
// p-codex-train-guard: a branch whose roles ran on codex requires isolation, and until A2b isolates its checks neither
// the selection wait step nor the integration train runs its code with the rights of this machine or of the runner.
//   R1-R9  workflows/role-chain.js: the task field requiresIsolation (set by the conductor, never by a tasks file);
//          under the conductor (exec) a task without the field requires isolation; a task that requires it stops with
//          status coordinator at the first selection wait step or at the ride, before the step runs (no run step at all);
//          requiresIsolation false and the Workflow runtime without the field run the selection and the train as before.
//   C1-C4  scripts/chain-run.js: requiresIsolationOf(host) (codex -> true, claude -> false, anything else -> true) and
//          runScript on the claude and on the codex host, which sets it on every task over whatever args carried;
//          parseTasks refuses the field from a tasks file.
//   T1-T5  scripts/train.js enqueue and ride --requires-isolation: exit 65 before the queue, nothing queued, the fake
//          guard command never called; without the flag the same branch rides as before (green, the guard called).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CR = require('../scripts/chain-run.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-refusal-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'English', testerWritable: ['-run\\.js$'] };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'true {wt}' });
const HP = 'a'.repeat(40);
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: HP, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: HP, summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: 'rv' };
const WHY = /train and selection for codex role branches wait for A2b isolation/;

// One chain: the fake agent answers by the kind of the label; with exec every service step goes through it (the
// conductor runtime), without exec through agent() (the Workflow runtime). runs: the wait steps (run:...) that were asked.
async function chain(task, cfg, withExec) {
  const trace = [], runs = [];
  const q = { pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] };
  const answer = (opts) => {
    const role = opts.label.split(':')[0];
    if (role === 'run') runs.push(opts.label);
    trace.push(['diff', 'post', 'left', 'run', 'sha', 'env'].includes(role) ? opts.label.replace(/#retry$/, '') : role);
    if (q[role] && q[role].length) return q[role].shift();
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/l', tail: '' };
    if (role === 'sha') return HP;
    throw new Error(`extra call ${role} after ${trace.join('>')}`);
  };
  const agent = async (prompt, opts) => answer(opts);
  const exec = async (step) => (step.agent ? answer(step.agent.opts) : { ok: true, problems: [], notes: [] });
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'exec', 'checkpoint', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] }, withExec ? exec : undefined, withExec ? () => {} : undefined);
  return { r: res[0], trace: trace.join('>'), runs };
}

async function roleChain() {
  let x = await chain(Object.assign({}, T, { requiresIsolation: true }), ONE, true);
  ok('R1 conductor, requiresIsolation true: stopped at the selection with status coordinator, the reason names A2b',
    x.r.status === 'coordinator' && WHY.test(x.r.why) && /select/.test(x.r.why), JSON.stringify(x.r));
  ok('R1 nothing executed: no selection wait step, no train step', x.runs.length === 0 && /prog/.test(x.trace), `${x.trace}`);
  ok('R1 the result names the isolation it waits for and the head', x.r.isolation === 'A2b' && x.r.head === HP, JSON.stringify(x.r));

  x = await chain(Object.assign({}, T), ONE, true);
  ok('R2 conductor, no requiresIsolation (no data): isolation - stopped with status coordinator, no wait step',
    x.r.status === 'coordinator' && WHY.test(x.r.why) && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: 'no' }), ONE, true);
  ok('R3 conductor, a requiresIsolation that is not false: isolation', x.r.status === 'coordinator' && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: false }), ONE, true);
  ok('R4 conductor, requiresIsolation false (claude roles): the selection and the train run as before, done',
    x.r.status === 'done' && x.runs.some((l) => /select-1/.test(l)) && x.runs.some((l) => /train-1/.test(l)), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true }), Object.assign({}, ONE, { innerSelect: false }), true);
  ok('R5 conductor, isolation, innerSelect false: tester and review run, the ride is refused before its step',
    x.r.status === 'coordinator' && WHY.test(x.r.why) && /train/.test(x.r.why) && /test.*review/.test(x.trace) && x.runs.length === 0 && x.r.review === 'rv' && x.r.head === HP,
    `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true, resumeAt: 'train', head: HP, resumeSince: HP }), ONE, true);
  ok('R6 conductor, isolation, resumeAt train: refused, no ride', x.r.status === 'coordinator' && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T), ONE, false);
  ok('R7 Workflow runtime (claude roles), no field: the selection and the train as before, done',
    x.r.status === 'done' && x.runs.some((l) => /select-1/.test(l)) && x.runs.some((l) => /train-1/.test(l)), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true }), ONE, false);
  ok('R8 Workflow runtime with requiresIsolation true: refused as well', x.r.status === 'coordinator' && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true }), CFG, true);
  ok('R9 without guardSubsetCommand the conductor runs no selection and no train: done as before',
    x.r.status === 'done' && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);
}

// The conductor's wiring: requiresIsolationOf (the host of the run -> the field) and runScript, which applies it to
// every task, with a plugin root whose role-chain.js only echoes the field of each task. A run on the codex host needs
// its commit state folder (<sharedDir>/runs/.commit) out of every role's reach, which /tmp and TMPDIR are not, so its
// sharedDir is a temporary folder inside the plugin checkout, removed at exit.
async function conductor() {
  const fn = typeof CR.requiresIsolationOf === 'function' ? CR.requiresIsolationOf : () => 'missing';
  ok('C1 the host codex requires isolation; claude does not; any other or no host does (no data - isolation)',
    fn('codex') === true && fn('claude') === false && fn(undefined) === true && fn('other') === true, `${fn('codex')} ${fn('claude')} ${fn(undefined)} ${fn('other')}`);
  const plug = path.join(W, 'plug');
  fs.mkdirSync(path.join(plug, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(plug, 'workflows', 'role-chain.js'),
    'return args.tasks.map((t) => ({ task: t.key, status: "done", seen: Object.prototype.hasOwnProperty.call(t, "requiresIsolation") ? t.requiresIsolation : "absent" }))\n');
  const config = { sharedDir: path.join(W, 's'), worktreeRoot: path.join(W, 'r'), scriptsDir: '/p/scripts' };
  const tasks = [{ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'a', kind: 'tail', noAnalysis: 'n' }];
  const run = (extra) => CR.runScript({ host: 'claude', pluginRoot: plug, args: { owner: 'o', config, tasks: tasks.map((t) => Object.assign({}, t, extra)) },
    callsDir: path.join(W, 'calls'), note: () => {}, log: () => {} });
  let x = await run();
  ok('C2 runScript on the claude host: every task gets requiresIsolation false', !x.threw && x.results[0] && x.results[0].seen === false, JSON.stringify(x));
  x = await run({ requiresIsolation: true });
  ok('C2 runScript: a requiresIsolation in the args is replaced by the one of the host of the run', !x.threw && x.results[0] && x.results[0].seen === false, JSON.stringify(x));
  const st = fs.mkdtempSync(path.join(ROOT, '.isolation-state-'));
  process.on('exit', () => { try { fs.rmSync(st, { recursive: true, force: true }); } catch { /* best effort */ } });
  const codex = (extra) => CR.runScript({ host: 'codex', pluginRoot: plug, adapter: { codexHome: path.join(W, 'codex-home') },
    args: { owner: 'o', config: Object.assign({}, config, { sharedDir: st }), tasks: tasks.map((t) => Object.assign({}, t, extra)) },
    callsDir: path.join(W, 'calls-codex'), note: () => {}, log: () => {} });
  x = await codex();
  ok('C4 runScript on the codex host: every task gets requiresIsolation true', !x.threw && x.results[0] && x.results[0].seen === true, JSON.stringify(x));
  x = await codex({ requiresIsolation: false });
  ok('C4 runScript on the codex host: a requiresIsolation false in the args is replaced by true', !x.threw && x.results[0] && x.results[0].seen === true, JSON.stringify(x));
  fs.rmSync(st, { recursive: true, force: true });
  const pt = CR.parseTasks(JSON.stringify([Object.assign({}, tasks[0], { requiresIsolation: false })]));
  ok('C3 parseTasks: a tasks file cannot set requiresIsolation (the conductor sets it from the host of its run)', !!pt.error && /requiresIsolation/.test(pt.error), JSON.stringify(pt));
}

function train() {
  if (!has('zsh')) { skip('T1-T5 scripts/train.js (runs guards-all.sh, a zsh script)', 'zsh not found'); return; }
  const TRAIN = path.join(ROOT, 'scripts', 'train.js');
  const D = path.join(W, 'train');
  const main = path.join(D, 'main'), wts = path.join(D, 'wts'), shared = path.join(D, 'shared'), bin = path.join(D, 'bin');
  for (const d of [main, wts, shared, bin]) fs.mkdirSync(d, { recursive: true });
  const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  const sh = (f, body) => { put(f, body); fs.chmodSync(f, 0o755); };
  const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  const rev = (ref) => git(main, 'rev-parse', '--verify', '-q', ref).stdout.trim();
  sh(path.join(bin, 'sysctl'), '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
  sh(path.join(bin, 'memory_pressure'), '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
  sh(path.join(bin, 'vm_stat'), '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
  sh(path.join(bin, 'df'), '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
  const CALLS = path.join(D, 'calls.txt');
  sh(path.join(D, 'guard.sh'), `#!/bin/sh\necho "$PWD" >> '${CALLS}'\necho "=== 9 passed in 0.1s ==="\nexit 0\n`);
  sh(path.join(D, 'one.sh'), '#!/bin/sh\nexit 0\n');
  const cfgFile = path.join(D, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
    guardCommand: `cd {wt} && ${path.join(D, 'guard.sh')}`,
    guardRerun: { command: `cd {wt} && ${path.join(D, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
    guardBaseline: 'known.json', worktreeSetup: { scan: ['data'], skip: [], link: [] },
    slots: { lockDir: path.join(D, 'slots'), legacyLock: path.join(D, 'guards.lock') } }));
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
    SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CLAUDE_PROJECT_DIR']) delete env[k];
  const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: D, encoding: 'utf8', env, timeout: 120000 });
  const queue = () => { try { return fs.readdirSync(path.join(shared, 'train', 'queue')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  const calls = () => { try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  git(main, 'branch', 'cx', 'arc');
  const mk = path.join(D, 'mk');
  git(main, 'worktree', 'add', '-q', mk, 'cx');
  put(path.join(mk, 'f.txt'), 'cx\n');
  git(mk, 'add', 'f.txt'); git(mk, 'commit', '-q', '-m', 'cx');
  git(main, 'worktree', 'remove', '--force', mk);
  const head = rev('cx'), arc0 = rev('arc');
  const dir = path.join(D, 'task'); fs.mkdirSync(dir, { recursive: true });
  const args = ['--task', 'cx', '--branch', 'cx', '--head', head, '--base', 'arc', '--dir', dir];

  let r = tr('enqueue', ...args, '--requires-isolation');
  ok('T1 enqueue --requires-isolation: exit 65 before the queue, the reason names A2b, nothing queued',
    r.status === 65 && WHY.test(r.stderr) && !queue().length, `${r.status} ${r.stdout}${r.stderr}`);
  r = tr('ride', '--requires-isolation', ...args);
  ok('T2 ride --requires-isolation (the flag first): exit 65, nothing queued, the guard command never called, the arc not moved',
    r.status === 65 && WHY.test(r.stderr) && !queue().length && calls() === 0 && rev('arc') === arc0, `${r.status} calls ${calls()} ${r.stdout}${r.stderr}`);
  put(path.join(shared, 'train', 'result', `cx-${head}.json`), JSON.stringify({ task: 'cx', head, branch: 'cx', base: 'arc', verdict: 'green' }));
  r = tr('ride', ...args, '--requires-isolation');
  ok('T3 ride --requires-isolation with a result already there: still exit 65 (the refusal comes before the result)', r.status === 65, `${r.status} ${r.stdout}${r.stderr}`);
  fs.rmSync(path.join(shared, 'train', 'result'), { recursive: true, force: true });
  r = tr('enqueue', ...args, '--requires-isolation', 'yes');
  ok('T4 --requires-isolation takes no value: a value after it is refused (64), nothing queued', r.status === 64 && !queue().length, `${r.status} ${r.stderr}`);
  r = tr('ride', ...args);
  ok('T5 the same branch without the flag (claude roles): the train as before - green, the guard command called, the arc moved',
    r.status === 0 && calls() >= 1 && rev('arc') !== arc0, `${r.status} calls ${calls()} ${r.stdout}${r.stderr}`);
}

(async () => {
  await roleChain();
  await conductor();
  train();
  done();
})().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack)); process.exit(1); });
