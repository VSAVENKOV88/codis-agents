#!/usr/bin/env node
'use strict';
// Tester cells of task p-wait (the waiter of the full run does not give up while the run is alive; 124/77/78/72/73 are
// the environment; heavy.sh only in the background) beyond the programmer's tests:
//   Part A - prompts of workflows/role-chain.js with fake agents (the harness of tests/role-chain.test.js):
//     H2x. every sentence of every role prompt that names heavy.sh says run_in_background - also in the light mode
//          (with and without guardSubsetCommand), with a shared stand, with the analyst and the security reviewer;
//     W5r. the #retry of the waiter (--reuse) carries the same "keep waiting while alive" rule;
//     W5t. the Bash timeout of a wait call is above its --max (a wait is never killed by Bash);
//     W6f. a refused queue (77) on the run after a fix round stops with environment, no third programmer round;
//     K.   a run killed from outside (143, 137) is not in ENV_RC: a programmer round whose prompt names a cut-off run
//          as status environment (the chain's current answer; not a cell of the matrix).
//   Part B - the real scripts (zsh): wait-step.js over heavy.sh and guards-all.sh on a TEMPORARY slot directory and a
//     fake machine, and the JSON they print fed into the chain:
//     Q1. heavy.sh waits behind a busy heavy slot: every wait gives done:false, alive:true, the pid of the run, a tail
//         "waiting for slot heavy"; after the holder ends - done:true rc 0, and the chain goes on to the tester;
//     Q2. an unwritable slot directory: done:true rc 77 -> the chain stops with environment, no programmer round;
//     Q3. guards-all.sh on a worktree whose project config has no guardCommand (round 1f of this task): rc 78 ->
//         environment; the main working copy: rc 78 -> environment;
//     Q4. the deadline while heavy.sh waits in the queue: rc 124, the waiter's process group is gone and its queue
//         ticket removed (the next job is not stuck behind it); the chain stops with environment.
// usage: node tests/p-wait-cells.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}', guardAlways: ['semgrep-diff'] });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', noAnalysis: 'one-line fix' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const AN = { ready: true, cells: 10, subsystems: 1, split: [], questions: [], summary: 'a' };
const GREEN = { verdict: 'green', summary: '' };
const D = { verdict: 'done', docsOnly: false, summary: '' };
const RUN_OK = { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'all green' };

async function run(script, task = T, extra = {}) {
  const trace = [], full = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return q.run && q.run.length ? q.run.shift() : RUN_OK;
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, () => {}, () => {}, Object.assign({ owner: 'o', config: CFG, tasks: [task] }, extra));
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts };
}
const pOf = (x, role, i = 0) => (x.prompts.filter((p) => p.role === role)[i] || { prompt: '' }).prompt;
const runsOf = (x) => x.prompts.filter((p) => p.role === 'run');
// Sentences (or lines) of the role prompts that name heavy.sh without run_in_background.
const heavyBlocking = (ps) => ps.filter((p) => !['diff', 'left', 'post', 'run'].includes(p.role)).flatMap((p) => p.prompt
  .split(/(?<=[.:;])\s+(?=[A-Z0-9(])|\n/).filter((s) => /heavy\.sh/.test(s) && !/run_in_background/.test(s)).map((s) => `${p.label}: ${s}`));

(async () => {
  // ---- Part A ----
  const STAND = { stand: { project: 'p-dev', ports: [3101] } };
  const L = Object.assign({}, T, { mode: 'light' });
  const cases = [
    ['one run + a shared stand', { pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, T, Object.assign({}, ONE, STAND)],
    ['no guardSubsetCommand + a shared stand', { pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, T, Object.assign({}, CFG, STAND)],
    ['light, one run', { pre: [PRE], prog: [PROG], review: [D] }, L, ONE],
    ['light, no guardSubsetCommand', { pre: [PRE], prog: [PROG], review: [D] }, L, CFG],
    ['analyst first + security review, one run', { pre: [PRE], analyst: [AN], prog: [PROG], test: [GREEN], review: [D], sec: [D] },
      Object.assign({}, T, { analystFirst: true, security: true, noAnalysis: undefined }), ONE],
  ];
  for (const [name, script, task, config] of cases) {
    const t = Object.assign({}, task); if (t.noAnalysis === undefined) delete t.noAnalysis;
    let x;
    try { x = await run(script, t, { config }); } catch (e) { ok(`H2x. ${name}: the chain runs`, false, e.message); continue; }
    const roles = [...new Set(x.prompts.map((p) => p.role))].join(',');
    ok(`H2x. ${name}: the chain ran to the end (${roles})`, x.r && x.r.status === 'done', JSON.stringify(x.r) + ' ' + x.full);
    const bad = heavyBlocking(x.prompts);
    ok(`H2x. ${name}: every sentence of every role prompt that names heavy.sh says run_in_background`, !bad.length, bad.join(' | '));
  }

  // W5r: the #retry of the waiter carries the same rule and attaches with --reuse.
  let x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], run: [{ done: false, rc: null, log: '/d/l', error: 'no JSON' }, RUN_OK] }, T, { config: ONE });
  const rr = runsOf(x);
  ok('W5r. a waiter that returned no exit code is repeated once with --reuse', rr.length === 2 && /#retry$/.test(rr[1].label) && /--reuse/.test(rr[1].prompt), rr.map((p) => p.label).join(','));
  ok('W5r. the #retry prompt keeps the rule: an unchanged tail is not a reason to stop, only done:true returns',
    rr[1] && /an unchanged tail[^.]*not a reason to stop/.test(rr[1].prompt) && /[Rr]eturn the schema only once [^.]*"done":true/.test(rr[1].prompt), rr[1] && rr[1].prompt);
  // W5t: the Bash timeout of a wait call is above --max, so Bash never kills a wait.
  const wp = rr[0].prompt;
  const maxS = +(wp.match(/wait-step\.js wait [^\n]*--max (\d+)/) || [])[1];
  const toMs = +(wp.match(/timeout (\d+) ms/) || [])[1];
  ok('W5t. the wait call: --max at most 270 s and a Bash timeout above it (and at most 600000 ms)', maxS > 0 && maxS <= 270 && toMs > maxS * 1000 && toMs <= 600000, `max ${maxS} timeout ${toMs}`);

  // W6f: a refused queue on the run after a fix round.
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], run: [{ done: true, rc: 1, log: '/d/l1', tail: 'red' }, { done: true, rc: 77, log: '/d/l2', tail: '' }] }, T, { config: ONE });
  ok('W6f. exit 77 on the run after a fix round -> stopped with environment, no third programmer round, no tester',
    x.r.status === 'stopped' && x.trace === 'pre>prog>prog' && /environment/.test(x.r.why) && /exit 77/.test(x.r.why) && !!x.r.environment, JSON.stringify(x.r) + ' ' + x.full);

  // K: a run killed from outside is not an ENV_RC code: a programmer round that may answer environment.
  for (const rc of [143, 137]) {
    x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { status: 'environment', summary: 'killed at 40 %' })], run: [{ done: true, rc, log: '/d/l', tail: '' }] }, T, { config: ONE });
    ok(`K. exit ${rc} -> a programmer round with the log, whose prompt names a run cut off before its tally as status environment; its environment stops the task`,
      /exited \d+/.test(pOf(x, 'prog', 1)) && /cut off before its tally[^.]*status=environment/.test(pOf(x, 'prog', 1)) && x.r.status === 'stopped' && x.trace === 'pre>prog>prog' && /environment/.test(x.r.why), JSON.stringify(x.r) + ' ' + x.full);
  }

  // ---- Part B: the real scripts ----
  if (!has('zsh')) { skip('Q1-Q4. real wait-step over heavy.sh and guards-all.sh', 'zsh not found'); return done(); }
  if (!has('git')) { skip('Q1-Q4. real wait-step over heavy.sh and guards-all.sh', 'git not found'); return done(); }
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p-wait-cells-')));
  const bg = [];
  const killTree = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
  try {
    const bin = path.join(TMP, 'bin'); fs.mkdirSync(bin);
    const fake = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/bin/zsh\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
    fake('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    fake('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    fake('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    fake('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    for (const d of ['shared', 'wts', 'tmp', 'slots']) fs.mkdirSync(path.join(TMP, d));
    // a repository and a task worktree of it (guards-all refuses the main working copy)
    const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    const MAIN = path.join(TMP, 'main'); fs.mkdirSync(MAIN);
    git(MAIN, 'init', '-q'); git(MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const WT = path.join(TMP, 'wts', 'wt1'); git(MAIN, 'worktree', 'add', '-q', WT);
    const cfgFile = path.join(TMP, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: MAIN, worktreeRoot: path.join(TMP, 'wts'), sharedDir: path.join(TMP, 'shared') }));
    const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, CODIS_AGENTS_CONFIG: cfgFile, SLOTS_DIR: path.join(TMP, 'slots'),
      SLOT_LEGACY_LOCK: '', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', SLOT_OS: 'darwin', SLOT_HEAVY_N: '1', TMPDIR: path.join(TMP, 'tmp') });
    for (const k of ['GUARDS_EXCLUSIVE_LOCK', 'SLOT_JOURNAL', 'SLOT_MEDIUM_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS',
      'SLOT_PATH', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER']) delete env[k];
    const ws = (...a) => { const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'wait-step.js'), ...a], { env, encoding: 'utf8', timeout: 60000 });
      try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout + r.stderr }; } };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(100); } return false; };
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const chain = (j) => run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], run: [j] }, T, { config: ONE });
    const id = (n) => path.join(TMP, 'shared', `wait-${n}`);
    const logOf = (n) => { try { return fs.readFileSync(id(n) + '.log', 'utf8'); } catch { return ''; } };
    const release = path.join(TMP, 'rel.q1');

    // Q1: the only heavy slot is held; the run waits in the queue
    const holder = spawn(path.join(SCRIPTS, 'heavy.sh'), ['zsh', '-c', `print -r -- held > ${TMP}/held; while [[ ! -e ${release} ]]; do sleep 0.1; done`],
      { env, cwd: WT, detached: true, stdio: 'ignore' }); bg.push(holder.pid);
    ok('Q1. (setup) the holder takes the only heavy slot', await until(() => fs.existsSync(path.join(TMP, 'held'))));
    const s1 = ws('start', '--id', id('q1'), '--cwd', WT, '--', `${path.join(SCRIPTS, 'heavy.sh')} echo q1-done`);
    ok('Q1. (setup) wait-step started the run', s1.started === true && s1.pid > 0, JSON.stringify(s1)); bg.push(s1.pid);
    await until(() => /waiting for slot heavy/.test(logOf('q1')), 15000);
    const waits = [ws('wait', '--id', id('q1'), '--max', '1'), ws('wait', '--id', id('q1'), '--max', '2'), ws('wait', '--id', id('q1'), '--max', '1')];
    ok('Q1. while it waits behind the busy slot: every wait gives done:false, rc null, alive:true and the pid of the run, no error',
      waits.every((w) => w.done === false && w.rc === null && w.alive === true && w.pid === s1.pid && !w.error), JSON.stringify(waits));
    ok('Q1. ... the tail says it waits for a heavy slot (a queue, not a stall), and the run is alive', waits.every((w) => /waiting for slot heavy/.test(w.tail)) && alive(s1.pid), JSON.stringify(waits.map((w) => w.tail)));
    ok('Q1. ... the queued command has not run', !/q1-done/.test(logOf('q1')));
    fs.writeFileSync(release, '');
    const w1 = ws('wait', '--id', id('q1'), '--max', '30');
    ok('Q1. after the holder ends: done:true, rc 0, alive:false, the command ran', w1.done === true && w1.rc === 0 && w1.alive === false && /q1-done/.test(w1.tail), JSON.stringify(w1));
    x = await chain(w1);
    ok('Q1. that JSON in the chain: the tester gets the run, the task is done', x.r.status === 'done' && x.trace === 'pre>prog>test>review', JSON.stringify(x.r));

    // Q2: an unwritable slot directory -> 77
    const bad = path.join(TMP, 'slots-ro'); fs.mkdirSync(bad); fs.chmodSync(bad, 0o555);
    let writable = true; try { fs.accessSync(bad, fs.constants.W_OK); } catch { writable = false; }
    if (writable) skip('Q2. unwritable slot directory', 'this user writes a read-only directory (root)');
    else {
      const env2 = Object.assign({}, env, { SLOTS_DIR: bad });
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'wait-step.js'), 'start', '--id', id('q2'), '--cwd', WT, '--', `${path.join(SCRIPTS, 'heavy.sh')} touch ${TMP}/q2.ran`], { env: env2, encoding: 'utf8' });
      const w2 = ws('wait', '--id', id('q2'), '--max', '30');
      ok('Q2. heavy.sh on an unwritable slot directory through wait-step: done:true, rc 77, the command did not run', w2.done === true && w2.rc === 77 && !fs.existsSync(path.join(TMP, 'q2.ran')), r.stdout + JSON.stringify(w2));
      x = await chain(w2);
      ok('Q2. that JSON in the chain: stopped with environment (exit 77), no programmer round, no tester', x.r.status === 'stopped' && x.trace === 'pre>prog' && /exit 77/.test(x.r.why) && !!x.r.environment, JSON.stringify(x.r));
    }
    fs.chmodSync(bad, 0o755);

    // Q3: guards-all.sh without guardCommand (round 1f of this task) and on the main working copy -> 78
    for (const [n, target, why] of [['q3', WT, /guardCommand is not set/], ['q3m', MAIN, /main working copy|main checkout/i]]) {
      ws('start', '--id', id(n), '--cwd', WT, '--', `${path.join(SCRIPTS, 'guards-all.sh')} ${target}`);
      const w = ws('wait', '--id', id(n), '--max', '60');
      ok(`Q3. guards-all.sh ${n === 'q3' ? 'on a worktree whose project config has no guardCommand' : 'on the main working copy'}: done:true, rc 78, the reason in the log`,
        w.done === true && w.rc === 78 && why.test(logOf(n)), JSON.stringify(w) + ' ' + logOf(n));
      x = await chain(w);
      ok(`Q3. ${n}: that JSON in the chain -> stopped with environment (exit 78), no programmer round`, x.r.status === 'stopped' && x.trace === 'pre>prog' && /exit 78/.test(x.r.why), JSON.stringify(x.r));
    }

    // Q4: the deadline while heavy.sh waits in the queue -> 124, the group is gone, the ticket removed
    const rel4 = path.join(TMP, 'rel.q4');
    const h4 = spawn(path.join(SCRIPTS, 'heavy.sh'), ['zsh', '-c', `print -r -- held > ${TMP}/held4; while [[ ! -e ${rel4} ]]; do sleep 0.1; done`],
      { env, cwd: WT, detached: true, stdio: 'ignore' }); bg.push(h4.pid);
    ok('Q4. (setup) the holder takes the only heavy slot', await until(() => fs.existsSync(path.join(TMP, 'held4'))));
    const s4 = ws('start', '--id', id('q4'), '--cwd', WT, '--', `${path.join(SCRIPTS, 'heavy.sh')} touch ${TMP}/q4.ran`); bg.push(s4.pid);
    const queue = path.join(TMP, 'slots', 'queue');
    const tickets = () => (fs.existsSync(queue) ? fs.readdirSync(queue) : []);
    ok('Q4. (setup) the run waits in the queue with a ticket', await until(() => /waiting for slot heavy/.test(logOf('q4')) && tickets().length > 0), tickets().join(','));
    await sleep(1200);
    const w4 = ws('wait', '--id', id('q4'), '--max', '20', '--deadline', '1');
    ok('Q4. the deadline passes while it waits in the queue: done:true, rc 124, an error naming the deadline', w4.done === true && w4.rc === 124 && /deadline/.test(w4.error || ''), JSON.stringify(w4));
    ok('Q4. ... the run\'s process group is gone and its queue ticket removed', await until(() => !alive(s4.pid) && tickets().length === 0, 10000), `alive ${alive(s4.pid)} tickets ${tickets().join(',')}`);
    fs.writeFileSync(rel4, '');
    ok('Q4. ... its command never ran', !fs.existsSync(path.join(TMP, 'q4.ran')));
    x = await chain(w4);
    ok('Q4. that JSON in the chain: stopped with environment (exit 124), no programmer round', x.r.status === 'stopped' && x.trace === 'pre>prog' && /exit 124/.test(x.r.why), JSON.stringify(x.r));
  } finally {
    try { fs.writeFileSync(path.join(TMP, 'rel.q1'), ''); fs.writeFileSync(path.join(TMP, 'rel.q4'), ''); } catch { /* gone */ }
    await new Promise((res) => setTimeout(res, 500));
    for (const p of bg) killTree(p);
    try { fs.chmodSync(path.join(TMP, 'slots-ro'), 0o755); } catch { /* none */ }
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  done();
})().catch((e) => { ok('the test ran', false, e.stack); done(); });
