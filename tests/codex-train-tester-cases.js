'use strict';
// Tester cells of p-codex-A2b-2h-2 (a child of tests/codex-train.test.js with its own tally, so README keeps counting
// test files). The commands the chain hands out are executed for real, as their executors run them, on a branch that
// commits its own .claude/codis-agents.json whose commands print BRANCH-CONFIG:
//   TS1  the tester's own selection, taken from the tester's prompt (its programmer's HEAD filled in), run by /bin/sh in
//        the task's worktree after a commit of the tester: the chain's guardSubsetCommand runs, the branch's never (H26);
//   TS2  the selection wait step with a configPath that holds a blank and a single quote: the quoted prefix reaches
//        guards-all.sh and config.js intact (H25 with a path a shell would split);
//   TS3  the ride command, run as wait-step.js runs it (/bin/sh -c with the task's worktree as cwd, where the config
//        lookup would find the branch's file): the train runs the chain's guardCommand, green, the arc moved (H27 through
//        the chain's own command);
//   TS4  a task relaunched at the train that still carries the fields of an old isolation stop (status coordinator,
//        isolation 'A2b', requiresIsolation true) rides under the conductor and ends done (D-h3, H20).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-train-tc-')));
process.on('exit', () => { try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ } });

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const DONE = { verdict: 'done', docsOnly: false, summary: 'rv' };
const unq = (s) => s.slice(1, -1).replace(/'\\''/g, "'");

// One chain with a fake agent (as tests/codex-train.test.js): head is the programmer's HEAD every role reports.
async function chain(task, cfg, withExec, head) {
  const runs = [], cmds = {}, prompts = {};
  const q = { pre: [PRE], prog: [{ status: 'ready', changedFiles: ['a-run.js'], commits: ['c'], head, mutations: 'm', fullRun: 'r', questions: [], summary: 's' }],
    test: [{ verdict: 'green', head, summary: '' }], review: [DONE] };
  const answer = (opts, prompt, argv) => {
    const role = opts.label.split(':')[0];
    if (role === 'run') {
      runs.push(opts.label);
      const step = opts.label.replace(/#retry$/, '').split(':').pop();
      if (argv && argv.includes('--')) cmds[step] = argv[argv.indexOf('--') + 1];
      else { const m = /Run once: [^\n]* -- ('(?:[^']|'\\'')*')\n/.exec(prompt || ''); cmds[step] = m ? unq(m[1]) : ''; }
    }
    if (prompt) (prompts[role] = prompts[role] || []).push(prompt);
    if (q[role] && q[role].length) return q[role].shift();
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/l', tail: '' };
    if (role === 'sha') return head;
    throw new Error(`extra call ${role}`);
  };
  const agent = async (prompt, opts) => answer(opts, prompt);
  const exec = async (step) => (step.agent ? answer(step.agent.opts, step.agent.prompt, step.argv) : { ok: true, problems: [], notes: [] });
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', 'exec', 'checkpoint', SRC)(
    agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] }, withExec ? exec : undefined, withExec ? () => {} : undefined);
  return { r: res[0], runs, cmds, prompts };
}

// The fake machine for every slot script started here (tests/slots-hermetic.test.js): every knob dropped.
function machine(D) {
  const bin = path.join(D, 'bin');
  const sh = (name, body) => exe(path.join(bin, name), `#!/bin/zsh\n${body}\n`);
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
  const keep = ['SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_TRAIN_POLL'];
  const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
  for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_GUARDS_EXEC']) delete env[k];
  for (const k of Object.keys(env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k) && !keep.includes(k)) delete env[k];
  return env;
}
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
function put(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); }
function exe(f, s) { put(f, s); fs.chmodSync(f, 0o755); }
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// A project: main repository (branch main, arc), the task's worktree on branch cx with the branch's own config
// committed; arcCfg is the chain's config, outside the worktree, at the path given.
function project(D, arcCfg) {
  const main = path.join(D, 'main'), wts = path.join(D, 'wts'), shared = path.join(D, 'shared');
  for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
  const CALLS = path.join(D, 'calls.txt');
  exe(path.join(D, 'guard.sh'), `#!/bin/sh\necho "ARC-FULL $PWD" >> '${CALLS}'\necho "=== 9 passed in 0.1s ==="\nexit 0\n`);
  exe(path.join(D, 'one.sh'), '#!/bin/sh\nexit 0\n');
  const base = { repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
    guardCommand: `cd {wt} && ${path.join(D, 'guard.sh')}`, guardBaseline: 'known.json', worktreeSetup: { scan: ['data'], skip: [], link: [] },
    guardRerun: { command: `cd {wt} && ${path.join(D, 'one.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== ([0-9]+) passed in [0-9.]+s ===$' },
    slots: { lockDir: path.join(D, 'slots'), legacyLock: path.join(D, 'guards.lock') } };
  put(arcCfg, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: 'cd {wt} && echo ARC-CONFIG {onlyArgs} && echo "=== 1 passed in 0.1s ==="' })));
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, '.gitignore'), 'data/\n');
  put(path.join(main, 'known.json'), '{}');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', '.gitignore', 'known.json', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc');
  const wt = path.join(wts, 'cx');
  git(main, 'worktree', 'add', '-q', '-b', 'cx', wt, 'arc');
  put(path.join(wt, '.claude', 'codis-agents.json'), JSON.stringify(Object.assign({}, base, {
    guardSubsetCommand: `echo BRANCH-CONFIG {onlyArgs} >> '${CALLS}'; echo BRANCH-CONFIG {onlyArgs}; exit 1`,
    guardCommand: `echo BRANCH-CONFIG >> '${CALLS}'; exit 1` })));
  put(path.join(wt, 'a-run.js'), 'process.exit(0)\n');
  git(wt, 'add', '.claude/codis-agents.json', 'a-run.js'); git(wt, 'commit', '-q', '-m', 'branch config');
  const head = git(wt, 'rev-parse', 'HEAD').stdout.trim();
  const cfg = Object.assign({}, base, { scriptsDir: path.join(ROOT, 'scripts'), configPath: arcCfg, guardSubsetCommand: 'x {wt} {onlyArgs}', reportLanguage: 'English', testerWritable: ['-run\\.js$'] });
  return { main, wt, shared, head, cfg, CALLS, env: machine(D), arc: () => git(main, 'rev-parse', 'arc').stdout.trim() };
}
const task = (p, D, extra) => Object.assign({ key: 'cx', title: 'CX', dir: path.join(D, 'task'), wt: p.wt, branch: 'cx', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' }, extra || {});
const sh = (p, cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: p.wt, env: p.env, encoding: 'utf8', timeout: 150000 });

async function testerSelection() {
  for (const [who, ex] of [['conductor (codex roles)', true], ['Workflow runtime (Claude roles)', false]]) {
    const D = path.join(W, `ts1-${ex ? 'cx' : 'cl'}`);
    const p = project(D, path.join(D, 'arc-config', 'codis-agents.json'));
    const x = await chain(task(p, D), p.cfg, ex, p.head);
    const m = /CODIS_AGENTS_CONFIG=('(?:[^']|'\\'')*') (\S+\/guards-all\.sh) --select ('[0-9a-f]{40}') ('[^']*')/.exec((x.prompts.test || []).join('\n'));
    ok(`TS1 ${who}: the tester's prompt names its selection with the chain's config and its programmer's HEAD`,
      !!m && unq(m[1]) === p.cfg.configPath && unq(m[3]) === p.head, (x.prompts.test || [''])[0].slice(0, 300));
    if (!m) continue;
    // the tester commits a guard of its own, then runs the command of its prompt as given
    put(path.join(p.wt, 't-run.js'), 'process.exit(0)\n');
    git(p.wt, 'add', 't-run.js'); git(p.wt, 'commit', '-q', '-m', 'tester guard');
    const log = path.join(p.shared, 'guards-cx.select.txt');
    const r = sh(p, m[0]);
    const text = read(log);
    ok(`TS1 ${who}: the tester's selection runs the chain's guardSubsetCommand on its own guard (exit 0, ARC-CONFIG ... t-run.js)`,
      r.status === 0 && /ARC-CONFIG .*t-run\.js/.test(text) && !/a-run\.js/.test(text.split('\n').filter((l) => /^ARC-CONFIG/.test(l)).join('\n')),
      `exit ${r.status}\n${r.stdout}${r.stderr}\nlog: ${text}`);
    ok(`TS1 ${who}: the branch's own config never runs`, !/BRANCH-CONFIG/.test(text + r.stdout + r.stderr + read(p.CALLS)), `${text}${read(p.CALLS)}`);
  }
}

async function awkwardPath() {
  const D = path.join(W, 'ts2');
  const cfgPath = path.join(D, "arc dir", "it's", 'codis-agents.json');
  const p = project(D, cfgPath);
  const x = await chain(task(p, D), p.cfg, true, p.head);
  const cmd = x.cmds['select-1'] || '';
  const r = sh(p, cmd);
  const text = read(path.join(p.shared, 'guards-cx.select.txt'));
  ok('TS2 a configPath with a blank and a quote: the selection wait step runs the chain\'s guardSubsetCommand (exit 0, ARC-CONFIG ... a-run.js)',
    r.status === 0 && /ARC-CONFIG .*a-run\.js/.test(text), `exit ${r.status} cmd ${cmd}\n${r.stdout}${r.stderr}\nlog: ${text}`);
  ok('TS2 the branch\'s own config never runs', !/BRANCH-CONFIG/.test(text + r.stdout + r.stderr + read(p.CALLS)), `${text}${read(p.CALLS)}`);
}

async function rideFromWorktree() {
  const D = path.join(W, 'ts3');
  const p = project(D, path.join(D, 'arc-config', 'codis-agents.json'));
  fs.mkdirSync(path.join(D, 'task'), { recursive: true });
  const arc0 = p.arc();
  const x = await chain(task(p, D), p.cfg, true, p.head);
  const cmd = x.cmds['train-1'] || '';
  const r = sh(p, cmd);
  ok('TS3 the ride command run in the task\'s worktree: green (0), the arc moved to the branch',
    r.status === 0 && p.arc() !== arc0 && git(p.main, 'merge-base', '--is-ancestor', p.head, 'arc').status === 0, `exit ${r.status} cmd ${cmd}\n${r.stdout}${r.stderr}`);
  ok('TS3 the train ran the chain\'s guardCommand, never the branch\'s', /ARC-FULL/.test(read(p.CALLS)) && !/BRANCH-CONFIG/.test(read(p.CALLS)), read(p.CALLS));
}

async function oldStop() {
  const HP = 'a'.repeat(40);
  const cfg = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'English', testerWritable: ['-run\\.js$'], guardSubsetCommand: 'true {wt}', configPath: '/c.json' };
  const t = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'n', base: 'arc',
    resumeAt: 'train', head: HP, resumeSince: HP, status: 'coordinator', isolation: 'A2b', requiresIsolation: true };
  const x = await chain(t, cfg, true, HP);
  ok('TS4 conductor, a task relaunched at the train with the fields of an old isolation stop: the ride runs, done, no isolation in the result',
    x.r && x.r.status === 'done' && x.runs.some((l) => /:train-1$/.test(l)) && !/A2b|isolation/.test(JSON.stringify(x.r)), JSON.stringify(x.r));
}

(async () => {
  await oldStop();
  if (!has('zsh')) { skip('TS1-TS3 (guards-all.sh and train.js run zsh scripts)', 'zsh not found'); done(); }
  await testerSelection();
  await awkwardPath();
  await rideFromWorktree();
  done();
})().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack)); process.exit(1); });
