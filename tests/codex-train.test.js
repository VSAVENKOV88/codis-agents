#!/usr/bin/env node
'use strict';
// Branches whose roles ran on codex ride the selection and the train like the branches of Claude roles, and every
// trusted guard run of the chain takes the project config of the chain, never the one a branch commits
// (p-codex-A2b-2h-2, cells H17-H27 and H29 of the analysis p-codex-A2b-2h).
//   R1-R10 workflows/role-chain.js: no task field, host or runtime stops the selection wait step or the ride; a task
//          field requiresIsolation from an older tasks file is an ordinary extra key the chain does not read (H17-H21).
//   P1-P6  the command of the selection wait step, of the tester's selection in its prompt and of the ride carries
//          CODIS_AGENTS_CONFIG=<the chain's config> under both runtimes; with no configPath it has no prefix at all,
//          never CODIS_AGENTS_CONFIG='' (H25, H25b, H25c, H26).
//   S1-S2  the selection command of the wait step, run by /bin/sh in the task's worktree (as wait-step.js runs it) with
//          the real guards-all.sh, on a branch that commits its own .claude/codis-agents.json: the arc's selection
//          command runs, the branch's never (H25, H25b).
//   C1-C4  scripts/chain-run.js: no requiresIsolationOf; runScript on the claude and the codex host passes the tasks
//          as given; parseTasks takes the field like any extra key (H22).
//   T1-T7  scripts/train.js enqueue and ride: --requires-isolation anywhere in argv is an unknown option (64) before
//          the queue and before any result, the guard command never called; usage without it; a ride whose branch
//          commits its own project config runs the train's guard command (H23, H27); the queue entry of a passenger and
//          train.js status carry no isolation (H24).
//   G1     guards-all.sh: the line of a run through the heavy channel names no wait for A2b-2 (H29).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CR = require('../scripts/chain-run.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-train-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'English', testerWritable: ['-run\\.js$'] };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'true {wt}' });
const CP = '/cfg/arc dir/codis-agents.json';
const PFX = `CODIS_AGENTS_CONFIG='${CP}' `;
const HP = 'a'.repeat(40);
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: HP, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: HP, summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: 'rv' };
const OLD = /A2b|requires isolation/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One chain: the fake agent answers by the kind of the label; with exec every service step goes through it (the
// conductor runtime), without exec through agent() (the Workflow runtime). runs: the wait steps (run:...) that were
// asked, with the shell command each one starts (cmds, by step); prompts: the prompts of the roles, by role.
async function chain(task, cfg, withExec) {
  const trace = [], runs = [], cmds = {}, prompts = {};
  const q = { pre: [PRE], prog: [PROG], test: [GREEN], review: [DONE] };
  const answer = (opts, prompt, argv) => {
    const role = opts.label.split(':')[0];
    if (role === 'run') {
      runs.push(opts.label);
      const step = opts.label.replace(/#retry$/, '').split(':').pop();
      if (argv && argv.includes('--')) cmds[step] = argv[argv.indexOf('--') + 1];
      else { const m = /Run once: [^\n]* -- ('(?:[^']|'\\'')*')\n/.exec(prompt || ''); cmds[step] = m ? m[1].slice(1, -1).replace(/'\\''/g, "'") : `(no command in ${prompt})`; }
    }
    if (prompt) (prompts[role] = prompts[role] || []).push(prompt);
    trace.push(['diff', 'post', 'left', 'run', 'sha', 'env'].includes(role) ? opts.label.replace(/#retry$/, '') : role);
    if (q[role] && q[role].length) return q[role].shift();
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/l', tail: '' };
    if (role === 'sha') return HP;
    throw new Error(`extra call ${role} after ${trace.join('>')}`);
  };
  const agent = async (prompt, opts) => answer(opts, prompt);
  const exec = async (step) => (step.agent ? answer(step.agent.opts, step.agent.prompt, step.argv) : { ok: true, problems: [], notes: [] });
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'exec', 'checkpoint', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] }, withExec ? exec : undefined, withExec ? () => {} : undefined);
  return { r: res[0], trace: trace.join('>'), runs, cmds, prompts };
}
const ran = (x, step) => x.runs.some((l) => new RegExp(`:${step}(#retry)?$`).test(l));
const clean = (r) => !!r && r.status === 'done' && !Object.prototype.hasOwnProperty.call(r, 'isolation') && !OLD.test(JSON.stringify(r));

async function roleChain() {
  let x = await chain(Object.assign({}, T), ONE, true);
  ok('R1 conductor, a task with no field (codex host): the selection wait step and the train run, done, no isolation in the result',
    clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true }), ONE, true);
  ok('R2 conductor, requiresIsolation true from an older tasks file: not read - the selection and the train run, done',
    clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: 'no' }), ONE, true);
  ok('R3 conductor, a requiresIsolation that is not boolean: not read either', clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: false }), ONE, true);
  ok('R4 conductor, requiresIsolation false: the selection and the train as before, done', clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T), Object.assign({}, ONE, { innerSelect: false }), true);
  ok('R5 conductor, innerSelect false: no selection, tester and review, then the ride, done',
    clean(x.r) && !ran(x, 'select-1') && ran(x, 'train-1') && /test.*review/.test(x.trace) && x.r.review === 'rv', `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { resumeAt: 'train', head: HP, resumeSince: HP }), ONE, true);
  ok('R6 conductor, resumeAt train (a task stopped before for isolation is relaunched): the ride runs, done', clean(x.r) && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T), ONE, false);
  ok('R7 Workflow runtime (Claude roles), no field: the selection and the train as before, done',
    clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T, { requiresIsolation: true }), ONE, false);
  ok('R8 Workflow runtime with requiresIsolation true: not read - the selection and the train run, done',
    clean(x.r) && ran(x, 'select-1') && ran(x, 'train-1'), `${x.trace} ${JSON.stringify(x.r)}`);

  x = await chain(Object.assign({}, T), CFG, true);
  ok('R9 without guardSubsetCommand the conductor runs no selection and no train: done as before', clean(x.r) && x.runs.length === 0, `${x.trace} ${JSON.stringify(x.r)}`);

  ok('R10 workflows/role-chain.js names no isolation stop and no requiresIsolation', !/requiresIsolation|isolationStop|needsIsolation|ISOLATION_WHY|A2b isolation/.test(SRC));
}

// The config of the trusted runs: the chain's own (configPath) in every command a step or a role starts.
async function configPinned() {
  const sel = (x) => x.cmds['select-1'] || '', ride = (x) => x.cmds['train-1'] || '';
  const testerSel = (x) => (x.prompts.test || []).join('\n');
  const withCp = Object.assign({}, ONE, { configPath: CP });
  for (const [rt, ex] of [['conductor (codex roles)', true], ['Workflow runtime (Claude roles)', false]]) {
    const x = await chain(Object.assign({}, T), withCp, ex);
    ok(`P1 ${rt}: the selection wait step starts with CODIS_AGENTS_CONFIG=<the chain's config> /p/scripts/guards-all.sh --select`,
      sel(x).startsWith(`${PFX}/p/scripts/guards-all.sh --select 'arc' 'w'`), sel(x));
    ok(`P2 ${rt}: the ride keeps its CODIS_AGENTS_CONFIG=<the chain's config>`, ride(x).startsWith(`${PFX}node /p/scripts/train.js ride`), ride(x));
    ok(`P3 ${rt}: the tester's own selection in its prompt carries the same prefix, at its programmer's HEAD`,
      testerSel(x).includes(`${PFX}/p/scripts/guards-all.sh --select '${HP}' 'w'`), testerSel(x).slice(0, 400));
    const bare = Object.entries(x.prompts).filter(([role]) => ['pre', 'prog', 'test', 'review'].includes(role)).map(([, ps]) => ps).flat().map((p) => p.replace(new RegExp(esc(PFX) + esc('/p/scripts/guards-all.sh --select'), 'g'), ''))
      .filter((p) => /\/p\/scripts\/guards-all\.sh --select/.test(p));
    ok(`P4 ${rt}: no guards-all.sh --select in any role prompt without the prefix`, bare.length === 0 && Object.keys(x.prompts).includes('test'),
      bare.map((p) => (p.match(/.{0,120}\/p\/scripts\/guards-all\.sh --select.{0,40}/) || [''])[0]).join(' | '));
  }
  for (const [what, cp] of [['configPath absent', undefined], ['configPath null', null], ["configPath ''", ''], ['configPath of blanks', '  ']]) {
    const c = Object.assign({}, ONE); if (cp !== undefined) c.configPath = cp;
    const x = await chain(Object.assign({}, T), c, true);
    ok(`P5 ${what}: the selection and the ride without a prefix, never CODIS_AGENTS_CONFIG=''`,
      sel(x).startsWith('/p/scripts/guards-all.sh --select') && ride(x).startsWith('node /p/scripts/train.js ride') && !/CODIS_AGENTS_CONFIG/.test(sel(x) + ride(x) + testerSel(x)),
      `${sel(x)} | ${ride(x)}`);
  }
  const x = await chain(Object.assign({}, T), Object.assign({}, ONE, { configPath: "/cfg/it's.json" }), true);
  ok('P6 a quote in configPath is quoted for the shell', sel(x).startsWith("CODIS_AGENTS_CONFIG='/cfg/it'\\''s.json' /p/scripts/guards-all.sh"), sel(x));
}

// The conductor's wiring: runScript passes the tasks as given, with a plugin root whose role-chain.js only echoes the
// field of each task. A run on the codex host needs its commit state folder (<sharedDir>/runs/.commit) out of every
// role's reach, which /tmp and TMPDIR are not, so its sharedDir is a temporary folder inside the plugin checkout,
// removed at exit.
async function conductor() {
  ok('C1 chain-run.js exports no requiresIsolationOf', !Object.prototype.hasOwnProperty.call(CR, 'requiresIsolationOf'));
  const plug = path.join(W, 'plug');
  fs.mkdirSync(path.join(plug, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(plug, 'workflows', 'role-chain.js'),
    'return args.tasks.map((t) => ({ task: t.key, status: "done", seen: Object.prototype.hasOwnProperty.call(t, "requiresIsolation") ? t.requiresIsolation : "absent" }))\n');
  const config = { sharedDir: path.join(W, 's'), worktreeRoot: path.join(W, 'r'), scriptsDir: '/p/scripts' };
  const tasks = [{ key: 'x', title: 'X', wt: 'w', branch: 'b', accept: 'a', kind: 'tail', noAnalysis: 'n' }];
  const run = (extra) => CR.runScript({ host: 'claude', pluginRoot: plug, args: { owner: 'o', config, tasks: tasks.map((t) => Object.assign({}, t, extra)) },
    callsDir: path.join(W, 'calls'), note: () => {}, log: () => {} });
  let x = await run();
  ok('C2 runScript on the claude host: the task gets no requiresIsolation', !x.threw && x.results[0] && x.results[0].seen === 'absent', JSON.stringify(x));
  const st = fs.mkdtempSync(path.join(ROOT, '.codex-train-state-'));
  process.on('exit', () => { try { fs.rmSync(st, { recursive: true, force: true }); } catch { /* best effort */ } });
  const codex = (extra) => CR.runScript({ host: 'codex', pluginRoot: plug, adapter: { codexHome: path.join(W, 'codex-home') },
    args: { owner: 'o', config: Object.assign({}, config, { sharedDir: st }), tasks: tasks.map((t) => Object.assign({}, t, extra)) },
    callsDir: path.join(W, 'calls-codex'), note: () => {}, log: () => {} });
  x = await codex();
  ok('C3 runScript on the codex host: the task gets no requiresIsolation', !x.threw && x.results[0] && x.results[0].seen === 'absent', JSON.stringify(x));
  x = await codex({ requiresIsolation: false });
  ok('C3 runScript on the codex host: a field in the args is passed as given, not replaced', !x.threw && x.results[0] && x.results[0].seen === false, JSON.stringify(x));
  fs.rmSync(st, { recursive: true, force: true });
  const pt = CR.parseTasks(JSON.stringify([Object.assign({}, tasks[0], { requiresIsolation: false })]));
  ok('C4 parseTasks: requiresIsolation in a tasks file is an ordinary extra key, not refused', !pt.error, JSON.stringify(pt));
}

// The fake machine and the environment of every slot script this test starts: every knob of slots.zsh is dropped, the
// machine readings come from bin/ (tests/slots-hermetic.test.js).
function machine(D) {
  const bin = path.join(D, 'bin');
  const sh = (name, body) => exe(path.join(bin, name), `#!/bin/zsh\n${body}\n`);
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
  const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
  for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_GUARDS_EXEC']) delete env[k];
  for (const k of Object.keys(env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k) && !['SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_TRAIN_POLL'].includes(k)) delete env[k];
  return env;
}
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
function put(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); }
function exe(f, s) { put(f, s); fs.chmodSync(f, 0o755); }

// The selection wait step for real: the command the chain gives wait-step.js, run as wait-step.js runs it (/bin/sh -c in
// the task's worktree), on a branch that commits its own project config whose guardSubsetCommand prints BRANCH-CONFIG.
async function selectionReal() {
  const D = path.join(W, 'sel');
  const main = path.join(D, 'main'), wts = path.join(D, 'wts'), shared = path.join(D, 'shared');
  for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
  const env = machine(D);
  const arcCfg = path.join(D, 'arc-config', 'codis-agents.json');
  const base = { repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
    guardCommand: 'cd {wt} && echo ARC-FULL', worktreeSetup: { scan: ['data'], skip: [], link: [] },
    guardRerun: { command: 'cd {wt} && true {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== ([0-9]+) passed in [0-9.]+s ===$' },
    slots: { lockDir: path.join(D, 'slots'), legacyLock: path.join(D, 'guards.lock') } };
  put(arcCfg, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: 'cd {wt} && echo ARC-CONFIG {onlyArgs} && echo "=== 1 passed in 0.1s ==="' })));
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  const wt = path.join(wts, 'cx');
  git(main, 'worktree', 'add', '-q', '-b', 'cx', wt, 'arc');
  put(path.join(wt, '.claude', 'codis-agents.json'), JSON.stringify(Object.assign({}, base, { guardSubsetCommand: 'echo BRANCH-CONFIG {onlyArgs}; exit 1' })));
  put(path.join(wt, 'a-run.js'), 'process.exit(0)\n');
  git(wt, 'add', '.claude/codis-agents.json', 'a-run.js'); git(wt, 'commit', '-q', '-m', 'branch config');
  const cfg = Object.assign({}, base, { scriptsDir: path.join(ROOT, 'scripts'), configPath: arcCfg, guardSubsetCommand: 'x {wt} {onlyArgs}', reportLanguage: 'English', testerWritable: ['-run\\.js$'] });
  for (const [who, ex] of [['codex task (conductor)', true], ['Claude task (Workflow runtime)', false]]) {
    const x = await chain(Object.assign({}, T, { wt, gdir: undefined, dir: path.join(D, 'task') }), cfg, ex);
    const cmd = x.cmds['select-1'] || '';
    const log = path.join(shared, 'guards-cx.select.txt');
    fs.rmSync(log, { force: true });
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: wt, env, encoding: 'utf8', timeout: 120000 });
    const text = (() => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } })();
    ok(`S1 ${who}: the selection runs the arc's guardSubsetCommand (exit 0, ARC-CONFIG with the changed guard in its log)`,
      r.status === 0 && /ARC-CONFIG .*a-run\.js/.test(text), `exit ${r.status} cmd ${cmd}\n${r.stdout}${r.stderr}\nlog: ${text}`);
    ok(`S2 ${who}: the branch's own config never runs (no BRANCH-CONFIG in the log or the output)`, !/BRANCH-CONFIG/.test(text + r.stdout + r.stderr), `${text}${r.stdout}${r.stderr}`);
  }
}

function train() {
  const TRAIN = path.join(ROOT, 'scripts', 'train.js');
  const D = path.join(W, 'train');
  const main = path.join(D, 'main'), wts = path.join(D, 'wts'), shared = path.join(D, 'shared');
  for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
  const env = machine(D);
  const rev = (ref) => git(main, 'rev-parse', '--verify', '-q', ref).stdout.trim();
  const CALLS = path.join(D, 'calls.txt');
  exe(path.join(D, 'guard.sh'), `#!/bin/sh\necho "TRAIN-CONFIG $PWD" >> '${CALLS}'\necho "=== 9 passed in 0.1s ==="\nexit 0\n`);
  exe(path.join(D, 'one.sh'), '#!/bin/sh\nexit 0\n');
  const base = { repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
    guardCommand: `cd {wt} && ${path.join(D, 'guard.sh')}`,
    guardRerun: { command: `cd {wt} && ${path.join(D, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
    guardBaseline: 'known.json', worktreeSetup: { scan: ['data'], skip: [], link: [] },
    slots: { lockDir: path.join(D, 'slots'), legacyLock: path.join(D, 'guards.lock') } };
  // the train's config is found from its cwd (D), not named by CODIS_AGENTS_CONFIG: then only the train itself pins it
  // for the guard run of its worktree, which holds the branch's own config
  put(path.join(D, '.claude', 'codis-agents.json'), JSON.stringify(base));
  const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: D, encoding: 'utf8', env, timeout: 120000 });
  const queue = () => { try { return fs.readdirSync(path.join(shared, 'train', 'queue')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  const calls = () => { try { return fs.readFileSync(CALLS, 'utf8'); } catch { return ''; } };
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
  put(path.join(mk, '.claude', 'codis-agents.json'), JSON.stringify(Object.assign({}, base, { guardCommand: `cd {wt} && echo BRANCH-CONFIG >> '${CALLS}' && exit 1` })));
  git(mk, 'add', 'f.txt', '.claude/codis-agents.json'); git(mk, 'commit', '-q', '-m', 'cx');
  git(main, 'worktree', 'remove', '--force', mk);
  const head = rev('cx'), arc0 = rev('arc');
  const dir = path.join(D, 'task'); fs.mkdirSync(dir, { recursive: true });
  const args = ['--task', 'cx', '--branch', 'cx', '--head', head, '--base', 'arc', '--dir', dir];
  const UNK = /unknown option --requires-isolation/;

  let r = tr('enqueue', ...args, '--requires-isolation');
  ok('T1 enqueue --requires-isolation (last): exit 64 "unknown option", nothing queued, no guard run',
    r.status === 64 && UNK.test(r.stderr) && !OLD.test(r.stderr) && !queue().length && !calls(), `${r.status} ${r.stdout}${r.stderr}`);
  r = tr('ride', '--requires-isolation', ...args);
  ok('T2 ride --requires-isolation (first, where it would eat --task as its value): exit 64 "unknown option", nothing queued, the arc not moved',
    r.status === 64 && UNK.test(r.stderr) && !queue().length && !calls() && rev('arc') === arc0, `${r.status} ${r.stdout}${r.stderr}`);
  r = tr('ride', '--task', 'cx', '--requires-isolation', 'yes', '--branch', 'cx', '--head', head, '--base', 'arc', '--dir', dir);
  ok('T3 ride with --requires-isolation and a value in the middle: exit 64 "unknown option", nothing queued',
    r.status === 64 && UNK.test(r.stderr) && !queue().length && !calls(), `${r.status} ${r.stdout}${r.stderr}`);
  put(path.join(shared, 'train', 'result', `cx-${head}.json`), JSON.stringify({ task: 'cx', head, branch: 'cx', base: 'arc', verdict: 'green' }));
  r = tr('ride', ...args, '--requires-isolation');
  ok('T4 ride --requires-isolation with a result already there: still 64 (refused before the result is read)', r.status === 64 && UNK.test(r.stderr), `${r.status} ${r.stdout}${r.stderr}`);
  fs.rmSync(path.join(shared, 'train', 'result'), { recursive: true, force: true });
  r = tr('help');
  ok('T5 the usage names no --requires-isolation', r.status === 64 && /usage: train\.js enqueue/.test(r.stderr) && !/requires-isolation/.test(r.stderr), r.stderr);
  r = tr('ride', ...args);
  ok('T6 the same branch without the flag: green, the arc moved, the train\'s guard command ran',
    r.status === 0 && /TRAIN-CONFIG/.test(calls()) && rev('arc') !== arc0, `${r.status} ${calls()} ${r.stdout}${r.stderr}`);
  ok('T6 the branch commits its own .claude/codis-agents.json: its guardCommand never ran (the train pins its own config)',
    !/BRANCH-CONFIG/.test(calls()), calls());
  // H24: a passenger is queued as any other - its entry and train.js status carry no isolation
  git(main, 'branch', 'cy', 'arc');
  const hy = rev('cy');
  r = tr('enqueue', '--task', 'cy', '--branch', 'cy', '--head', hy, '--base', 'arc', '--dir', dir);
  const q = queue();
  const entry = q.length ? JSON.parse(fs.readFileSync(path.join(shared, 'train', 'queue', q[0]), 'utf8')) : {};
  ok('T7 the queue entry of a passenger has the fields of every entry, no isolation',
    r.status === 0 && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['base', 'branch', 'dir', 'enqueuedAt', 'head', 'task']), `${r.status} ${r.stderr} ${JSON.stringify(entry)}`);
  r = tr('status');
  ok('T7 train.js status lists the passenger, no isolation in it', r.status === 0 && /cy/.test(r.stdout) && !/isolat|A2b/i.test(r.stdout), `${r.status} ${r.stdout}${r.stderr}`);
}

function heavyLine() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'guards-all.sh'), 'utf8');
  ok('G1 guards-all.sh: the run of a codex role through the heavy channel names its place, not a wait for A2b-2',
    /\$WHERE: a codex role'"'"'s run through the heavy channel/.test(src) && !/A2b-2/.test(src), (src.match(/^.*heavy channel.*$/gm) || []).join('\n'));
}

(async () => {
  await roleChain();
  await configPinned();
  await conductor();
  heavyLine();
  if (!has('zsh')) { skip('S1-S2, T1-T7 (guards-all.sh and train.js run zsh scripts)', 'zsh not found'); done(); }
  await selectionReal();
  train();
  done();
})().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack)); process.exit(1); });
