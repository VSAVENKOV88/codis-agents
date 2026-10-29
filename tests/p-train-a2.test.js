#!/usr/bin/env node
'use strict';
// p-train-a2: the selection of guards of the task's diff instead of the full guard run in the task (cells S1-S19 of
// the feature's matrix, part A2; coordinator's decisions 3 and 6: remoteRun.subsetCommand, and with guardSubsetCommand
// the task's base is required and is not a protected branch).
//   Part A - workflows/role-chain.js with fake agents: after every programmer round with a new HEAD the workflow runs
//     the selection step (guards-all.sh --select <base>) as a wait step, never the full run; its log goes to the next
//     role; red -> a programmer round with the log; the environment codes stop the task; the role texts and the rule.
//   Part B - scripts/guards-all.sh --select on a temporary project (zsh, git): its own log, the subset command with one
//     --only per selected guard, rerun of new reds alone, known reds subtracted, the quarantine read only, an empty
//     selection runs nothing, an unknown base is exit 65, reuse never crosses the full run and the selection.
//   Part C - the remote runner (a fake ssh, as in tests/quarantine-remote.test.js): the selection goes to the runner only
//     with remoteRun.subsetCommand, the part by localPattern runs here, an unreachable runner is 69 with no run here;
//     without the key the selection stays in a heavy slot here.
// usage: node tests/p-train-a2.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
// details are cut: a failing prompt check would print the whole prompt
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 400));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'); } catch { return null; } };
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}', guardAlways: ['semgrep-diff'] });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: 'P2' });
const DOCS2 = Object.assign({}, PROG, { head: 'P2', changedFiles: ['README.md'] });
const GREEN = { verdict: 'green', summary: '' };
const RED = { verdict: 'red', summary: 'r' };
const D = { verdict: 'done', docsOnly: false, summary: '' };
const REJ = { verdict: 'rejected', docsOnly: false, summary: 'rej' };
const DOCS_REJ = { verdict: 'rejected', docsOnly: true, summary: 'docs' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const REDR = { done: true, rc: 1, seconds: 1, log: '/d/wait-select-1.log', tail: 'FAILED g/b-run.js' };

async function run(script, task = T, config = ONE) {
  const trace = [], full = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return q.run && q.run.length ? q.run.shift() : OKR;
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, pipeline, null, () => {}, () => {}, { owner: 'o', config, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts };
}
const pOf = (x, role, i = 0) => (x.prompts.filter((p) => p.role === role)[i] || { prompt: '' }).prompt;
const runsOf = (x) => x.prompts.filter((p) => p.role === 'run');
const G1 = () => ({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });

async function partA() {
  // S1: the selection step after the programmer, never the full run
  let x = await run(G1());
  ok('S1. one run: pre > prog > the selection step > tester > review, done',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  const rp0 = runsOf(x)[0] || { prompt: '' };
  // the command is quoted once more for wait-step.js (sq): unquote '\'' for the checks
  const rp = Object.assign({}, rp0, { prompt: rp0.prompt.split("'\\''").join("'") });
  ok('S1. the step runs guards-all.sh --select <base> on the worktree through wait-step.js and copies the selection log',
    rp.prompt.includes("/p/scripts/guards-all.sh --select 'arc' 'w'") && rp.prompt.includes("'/s/guards-w.select.txt'") && rp.prompt.includes("'/d/wait-select-1.guards.txt'")
      && rp.prompt.includes("node /p/scripts/wait-step.js start --id '/d/wait-select-1'"), rp.prompt);
  ok('S1. no step of the task is a full run: no guards-all.sh without --select, no full-N label', x.prompts.every((p) => !/^run:x:full/.test(p.label))
    && runsOf(x).every((p) => !/guards-all\.sh '/.test(p.prompt)), x.full);
  ok('S1. the step\'s phase is the selection, not "Full run"', rp.opts && rp.opts.phase === 'Selection', rp.opts && rp.opts.phase);
  // S2: the tester gets the log of the selection
  const tp = pOf(x, 'test');
  ok('S2. the tester gets the selection log (its own file), not the log of a full run',
    tp.includes('/d/wait-select-1.guards.txt') && tp.includes('/d/wait-select-1.log') && !tp.includes('guards-w.txt') && /no full guard run in the task/i.test(tp), tp);
  ok('S2. the tester runs its selection after its own commits through guards-all.sh --select in the background',
    tp.includes("/p/scripts/guards-all.sh --select 'arc' 'w'") && /run_in_background/.test(tp), tp);
  // S3: red -> programmer with the log -> selection again on the new HEAD; at most MAX rounds
  x = await run({ pre: [PRE], prog: [PROG, P2], run: [REDR, OKR], test: [GREEN], review: [D] });
  ok('S3. a red selection -> a programmer round with its log -> the selection on the new HEAD -> tester',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>prog>run:x:select-1f>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  ok('S3. the fix round names the selection log and its copy, and says there is no full run to run',
    /selection/.test(pOf(x, 'prog', 1)) && pOf(x, 'prog', 1).includes('/d/wait-select-1.guards.txt') && /exited 1/.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));
  x = await run({ pre: [PRE], prog: [PROG, P2, Object.assign({}, PROG, { head: 'P3' })], run: [REDR, REDR, REDR] });
  ok('S3. the selection still red after two fix rounds -> stopped for the coordinator, no tester',
    x.r.status === 'stopped' && x.trace === 'pre>prog>prog>prog' && /selection/.test(x.r.why), JSON.stringify(x.r));
  // S4: explained without a commit
  x = await run({ pre: [PRE], prog: [PROG, PROG], run: [REDR], test: [GREEN], review: [D] });
  ok('S4. a red selection explained without a commit -> no second selection, the tester gets the red log',
    x.r.status === 'done' && runsOf(x).length === 1 && /exit 1/.test(pOf(x, 'test')), x.full);
  // S7: an empty selection (guards-all.sh --select prints "nothing selected", exit 0) -> tester
  x = await run(Object.assign(G1(), { run: [Object.assign({}, OKR, { tail: 'nothing selected: no guard is changed, imports or names a changed file' })] }));
  ok('S7. an empty selection (exit 0) goes on to the tester, who is told what an empty selection means',
    x.r.status === 'done' && /nothing selected/.test(pOf(x, 'test')), pOf(x, 'test'));
  // S8: a round that changed only docs still gets a selection on its new HEAD
  x = await run({ pre: [PRE], prog: [PROG, DOCS2], test: [GREEN], review: [DOCS_REJ, D] });
  ok('S8. a docs-only fix with a new commit -> the selection runs on its HEAD (guardAlways is in it)',
    x.r.status === 'done' && runsOf(x).length === 2 && runsOf(x)[1].label === 'run:x:select-r', x.full);
  // S10, S11, S13: the environment
  for (const [rc, re] of [[124, /deadline/], [77, /slot/], [78, /refused/], [72, /refused/], [73, /mktemp/], [65, /git|selection could not be computed/], [69, /runner/]]) {
    x = await run({ pre: [PRE], prog: [PROG], run: [{ done: true, rc, seconds: 3, log: '/d/wait-select-1.log', tail: '' }] });
    ok(`S10/S11/S13. selection exit ${rc} -> stopped with environment, no programmer round, no tester`,
      x.r.status === 'stopped' && x.trace === 'pre>prog' && !!x.r.environment && re.test(x.r.why) && x.r.why.includes('/d/wait-select-1.log'), JSON.stringify(x.r));
  }
  // S16: no guardSubsetCommand - the old path
  x = await run(G1(), Object.assign({}, T, { base: undefined }), CFG);
  ok('S16. without guardSubsetCommand: no step, the programmer runs the full run itself, base not required',
    x.r.status === 'done' && !runsOf(x).length && /full run \/p\/scripts\/guards-all\.sh w in the background/.test(pOf(x, 'prog')), x.full);
  // S17: light mode
  x = await run({ pre: [PRE], prog: [PROG], review: [D] }, Object.assign({}, T, { mode: 'light' }));
  ok('S17. light: programmer-checker > the selection step > review', x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>left:x:end', x.full);
  // S18: fix rounds after a red tester and after a rejection
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED, GREEN], review: [D] });
  ok('S18. a red tester -> programmer with a new HEAD -> the selection on it -> tester',
    x.r.status === 'done' && x.full.includes('post:x:tester>prog>run:x:select-2>test'), x.full);
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] });
  ok('S18. a rejection for code -> programmer with a new HEAD -> the selection -> tester -> second review',
    x.r.status === 'done' && x.full.includes('diff:x:reviewer>prog>run:x:select-r>test'), x.full);
  // ❓6: base required with guardSubsetCommand, not a protected branch
  x = await run(G1(), Object.assign({}, T, { base: undefined }));
  ok('Q6. with guardSubsetCommand a task without base stops in the preconditions before any agent',
    x.r.status === 'stopped' && x.r.why === 'preconditions' && x.trace === '' && /base/.test((x.r.problems || []).join(' ')), JSON.stringify(x.r));
  x = await run(G1(), Object.assign({}, T, { base: ' main ' }));
  ok('Q6. ... a base that is a protected branch stops there too', x.r.status === 'stopped' && x.trace === '' && /protected/.test((x.r.problems || []).join(' ')), JSON.stringify(x.r));
  // S19: role texts and the rule
  x = await run(G1());
  const pp = pOf(x, 'prog');
  ok('S19. the onerun rule in every prompt: no full guard run in the task, the workflow runs the selection',
    /no full guard run in the task/i.test(pp) && /guards-all\.sh --select 'arc' 'w'/.test(pp) && !/once after the programmer's last commit/.test(pp), pp);
  ok('S19. the programmer\'s Order line: no selection and no full run of its own, the workflow runs the selection',
    /the workflow runs the selection/.test(pp) && !/it includes the selected guards/.test(pp), pp);
  const rules = read('rules/multi-agent.md');
  const line = rules.split('\n').find((l) => /<!-- role:onerun -->/.test(l)) || '';
  ok('S19. multi-agent.md: the onerun line says there is no full guard run in a task, names --select and Replaces',
    /[Nn]o full guard run in the task/.test(line) && /--select/.test(line) && /Replaces:/.test(line), line);
  ok('S19. the agents and the README speak of the selection step', /--select/.test(read('README.md')) && /selection/.test(read('agents/programmer.md')) && /selection/.test(read('agents/tester.md')));
}

const zshOk = has('zsh') && has('git');
const fakeBin = (bin) => {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
};
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families; the
// children get a fake machine (fakeBin) and SLOT_OS darwin.
const cleanEnv = () => {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
};
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* ===$' };
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

function partB(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), sh2 = path.join(TMP, 'shared'), w = path.join(wts, 'pw');
  for (const d of [bin, sh2, w]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), s); if (mode) fs.chmodSync(path.join(w, f), mode); };
  put('full.sh', `#!/bin/sh\necho "run $*" >> "${TMP}/full.count"\necho "=== full ==="\nexit 0\n`, 0o755);
  put('sub.sh', `#!/bin/sh\necho "$*" >> "${TMP}/sub.count"\ncat "${TMP}/sub.log"\nexit $(cat "${TMP}/sub.rc")\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$1" >> "${TMP}/one.count"\ngrep -qxF -- "$1" "${TMP}/red.txt" && exit 1\nexit 0\n`, 0o755);
  put('known.json', '{"g/b-run.js": "known: a test entry"}\n');
  put('lib.js', 'module.exports = 1;\n');
  put('g/b-run.js', "require('../lib');\n");
  put('g/c-run.js', '// unrelated\n');
  put('g/always-run.js', '// scanner\n');
  gitC(w, 'init', '-q', '-b', 'base'); gitC(w, 'add', '.'); gitC(w, 'commit', '-q', '-m', 'base');
  gitC(w, 'checkout', '-q', '-b', 'task'); put('lib.js', 'module.exports = 2;\n'); gitC(w, 'add', 'lib.js'); gitC(w, 'commit', '-q', '-m', 'change lib');
  const f = path.join(TMP, 'cfg.json');
  const conf = { repoDir: path.join(TMP, 'main'), worktreeRoot: wts, sharedDir: sh2, guardCommand: 'cd {wt} && ./full.sh', guardSubsetCommand: 'cd {wt} && ./sub.sh {onlyArgs}',
    guardRerun: RERUN, guardBaseline: 'known.json', guardAlways: ['always'], protectedBranches: ['base'], slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } };
  const setCfg = (o) => fs.writeFileSync(f, JSON.stringify(Object.assign({}, conf, o || {})));
  setCfg();
  cleanEnv();
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', ...a], { encoding: 'utf8', env, timeout: 120000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const count = (n) => (read(path.join(TMP, n)) || '').split('\n').filter(Boolean);
  const set = (rc, reds, redAlone) => {
    fs.writeFileSync(path.join(TMP, 'sub.log'), reds.map((n) => `FAILED ${n} - code 1`).join('\n') + `\n=== ${reds.length} failed ===\n`);
    fs.writeFileSync(path.join(TMP, 'sub.rc'), String(rc)); fs.writeFileSync(path.join(TMP, 'red.txt'), (redAlone || []).map((n) => n + '\n').join(''));
    for (const c of ['sub.count', 'one.count', 'full.count']) fs.rmSync(path.join(TMP, c), { force: true });
  };
  const SEL = path.join(sh2, 'guards-pw.select.txt'), FULL = path.join(sh2, 'guards-pw.txt'), QF = path.join(sh2, 'guards-quarantine.json');

  // S1/S2/S9: green selection
  set(0, []);
  let x = ga('--select', 'base', 'pw');
  const args = count('sub.count')[0] || '';
  ok('B-S1. guards-all --select: the subset command ran once with one --only per selected guard, exit 0', x.status === 0 && count('sub.count').length === 1
    && args.includes('--only g/b-run.js') && args.includes('--only g/always-run.js') && !args.includes('c-run') && !count('full.count').length, `${x.status} [${args}] ${x.all}`);
  ok('B-S2. the selection has its own log guards-<name>.select.txt; the full run log is not written', fs.existsSync(SEL) && !fs.existsSync(FULL), x.all);
  // S15: reuse within the selection, never across the full run
  x = ga('--select', 'base', 'pw');
  ok('B-S15. the same HEAD, clean tree, same selection -> reused, the subset command not run again', x.status === 0 && /reused, HEAD/.test(x.stdout) && count('sub.count').length === 1, x.all);
  x = ga('pw');
  ok('B-S15. a full run on the same HEAD is not taken from the selection: it runs', x.status === 0 && count('full.count').length === 1 && fs.existsSync(FULL), `${x.status} ${count('full.count').length} ${x.all}`);
  x = ga('--select', 'base', 'pw');
  ok('B-S15. ... and the selection is still reused after it (its own meta)', x.status === 0 && /reused, HEAD/.test(x.stdout) && count('sub.count').length === 1, x.all);
  // S5: known reds subtracted before the rerun
  set(1, ['g/b-run.js'], ['g/b-run.js']);
  x = ga('--force', '--select', 'base', 'pw');
  ok('B-S5. only a known red -> exit 0, "1 known red", no rerun', x.status === 0 && /1 known red/.test(read(SEL) || '') && !count('one.count').length, `${x.status} ${read(SEL)}`);
  // S6: flaky in the selection -> exit 0, not written into the quarantine
  fs.rmSync(QF, { force: true });
  set(1, ['g/always-run.js'], []);
  x = ga('--force', '--select', 'base', 'pw');
  ok('B-S6. a new red green alone -> exit 0, named flaky, the quarantine is not written', x.status === 0 && /flaky[^\n]*g\/always-run\.js/.test(read(SEL) || '') && !fs.existsSync(QF), `${x.status} ${read(SEL)} ${read(QF)}`);
  ok('B-S6. the log says the quarantine is read only on a selection', /read-only on a selection/.test(read(SEL) || ''), read(SEL));
  // S3 (script side): a new red red alone -> the runner's code stands
  set(1, ['g/always-run.js'], ['g/always-run.js']);
  x = ga('--force', '--select', 'base', 'pw');
  ok('B-S3. a new red red alone -> exit 1', x.status === 1 && count('one.count').length === 1, `${x.status} ${read(SEL)}`);
  // S11: unknown base -> 65, nothing run
  set(0, []);
  x = ga('--force', '--select', 'no-such-ref', 'pw');
  ok('B-S11. an unknown base -> exit 65, the subset command not run, the log says why', x.status === 65 && !count('sub.count').length && /selection could not be computed/.test(read(SEL) || ''), `${x.status} ${x.all}`);
  // S7: empty selection (no guardAlways, base = HEAD)
  setCfg({ guardAlways: [] });
  x = ga('--force', '--select', 'HEAD', 'pw');
  ok('B-S7. an empty selection -> exit 0, "nothing selected" in the log, the subset command not run', x.status === 0 && !count('sub.count').length && /nothing selected/.test(read(SEL) || ''), `${x.status} ${x.all}`);
  // --select without guardSubsetCommand -> 78
  setCfg({ guardSubsetCommand: undefined });
  x = ga('--force', '--select', 'base', 'pw');
  ok('B. --select without guardSubsetCommand -> exit 78', x.status === 78 && !count('sub.count').length, `${x.status} ${x.all}`);
  setCfg();
}

function partC(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), main = path.join(TMP, 'main');
  const S = path.join(TMP, 'server'), sshLog = path.join(TMP, 'ssh.log');
  for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(a) + '\\n');
if (process.env.FAKE_SSH_FAIL) { process.stderr.write('ssh: connect to host example.org port 22: Connection refused\\n'); process.exit(255); }
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env, cwd: ${JSON.stringify(S)} });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
  put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/full.count"\ncat "${TMP}/full.log"\nexit $(cat "${TMP}/full.rc")\n`, 0o755);
  put('one.sh', `#!/bin/sh\necho "$PWD $1" >> "${TMP}/one.count"\ngrep -qxF -- "$1" "${TMP}/red.txt" && exit 1\nexit 0\n`, 0o755);
  put('local.sh', `#!/bin/sh\necho "$PWD $*" >> "${TMP}/local.count"\nexit 0\n`, 0o755);
  put('known.json', '{}\n');
  put('srv/a-run.js', '// a\n'); put('srv/c-run.js', '// c\n');
  gitC(main, 'init', '-q', '-b', 'trunk'); gitC(main, 'add', '.'); gitC(main, 'commit', '-q', '-m', 'project');
  gitC(main, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  const xw = path.join(wts, 'xw');
  gitC(main, 'worktree', 'add', '-q', '-b', 'task', xw);
  fs.writeFileSync(path.join(xw, 'srv', 'a-run.js'), '// a changed\n'); fs.writeFileSync(path.join(xw, 'srv', 'c-run.js'), '// c changed\n');
  gitC(xw, 'add', 'srv/a-run.js', 'srv/c-run.js'); gitC(xw, 'commit', '-q', '-m', 'change');
  fs.writeFileSync(path.join(TMP, 'key'), 'not a key\n'); fs.writeFileSync(path.join(TMP, 'kh'), 'example.org ssh-ed25519 AAAA\n');
  const remote = { host: 'example.org', user: 'runner', key: path.join(TMP, 'key'), knownHosts: path.join(TMP, 'kh'), root: '~/codis-runs', plugin: ROOT };
  const mfile = path.join(TMP, 'machine.json');
  fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(TMP, 'slots') }, remote }));
  fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
  fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
  const cfgFile = path.join(TMP, 'cfg.json');
  const RR = { newRedPattern: '^[XT] (\\S+)  \\(', tallyPattern: '^TOTAL: ', command: 'cd {wt} && ./one.sh {name}' };
  const setCfg = (subset) => fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}', guardRerun: RR,
    guardSubsetCommand: 'cd {wt} && ./local.sh {onlyArgs}', protectedBranches: ['trunk'], guardBaseline: 'known.json',
    remoteRun: Object.assign({ command: 'cd {wt} && ./full.sh {jobs}', localPattern: '^skipped \\(needs-font\\): \\d+ — (.+)$' }, subset ? { subsetCommand: 'cd {wt} && ./full.sh {onlyArgs}' } : {}) }));
  cleanEnv();
  const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const env = (extra) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2',
    SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', GUARDS_REMOTE_POLL: '0.3', FAKE_SERVER_ENV: SRV_ENV }, extra || {});
  const ga = (extra, ...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env: env(extra), timeout: 180000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const count = (n) => (read(path.join(TMP, n)) || '').split('\n').filter(Boolean);
  const set = (rc, log, red) => {
    fs.writeFileSync(path.join(TMP, 'full.log'), log); fs.writeFileSync(path.join(TMP, 'full.rc'), String(rc));
    fs.writeFileSync(path.join(TMP, 'red.txt'), (red || []).map((n) => n + '\n').join(''));
    for (const c of ['full.count', 'one.count', 'local.count']) fs.rmSync(path.join(TMP, c), { force: true });
    fs.rmSync(sshLog, { force: true });
  };
  const SEL = path.join(shared, 'guards-xw.select.txt'), QF = path.join(shared, 'guards-quarantine.json');
  const LOGC = ['Guards to run: 1', 'skipped (needs-font): 1 — srv/c-run.js', '---- NEW RED ----', 'X srv/a-run.js  (1.0s, code 1)', 'TOTAL: 1 NEW red'].join('\n') + '\n';

  // S12: with remoteRun.subsetCommand the selection runs on the runner; localPattern part here; flaky not written
  setCfg(true); fs.rmSync(QF, { force: true });
  set(1, LOGC, []);
  let x = ga({}, '--select', 'trunk', 'xw');
  const fc = count('full.count')[0] || '';
  ok('C-S12. the selection runs on the runner: its subset command with one --only per selected guard', fs.existsSync(sshLog) && /--only srv\/a-run\.js/.test(fc) && /--only srv\/c-run\.js/.test(fc) && /codis-runs/.test(fc), `${fc} ${x.all.slice(-1500)}`);
  ok('C-S12. its log is the selection log and starts "ran on runner"', /^ran on runner example\.org, HEAD /.test(read(SEL) || ''), (read(SEL) || '').slice(0, 300));
  ok('C-S12. the guards the runner does not run (localPattern) run here by localCommand', /--only srv\/c-run\.js/.test(count('local.count')[0] || ''), count('local.count').join('|'));
  ok('C-S6. flaky on the runner\'s selection -> exit 0, nothing written into the quarantine of this machine', x.status === 0 && !(read(QF) || '').includes('srv/a-run.js'), `${x.status} ${read(QF)} ${(read(SEL) || '').slice(-600)}`);
  ok('C-S15. the remote selection meta: env remote, a command of its own (not the full one)', (() => { try { const m = JSON.parse(read(SEL + '.meta.json')); return m.env === 'remote:example.org' && /--only/.test(m.command); } catch { return false; } })(), read(SEL + '.meta.json'));
  // S13: unreachable runner -> 69, no run here
  set(0, LOGC, []);
  x = ga({ FAKE_SSH_FAIL: '1' }, '--force', '--select', 'trunk', 'xw');
  ok('C-S13. an unreachable runner -> exit 69, "environment:" first in the log, nothing runs here', x.status === 69 && /^environment: /.test(read(SEL) || '') && !count('local.count').length && !count('full.count').length, `${x.status} ${x.all.slice(-600)}`);
  // S14: remote in the machine file, no remoteRun.subsetCommand -> the selection runs here in a heavy slot, with a note
  setCfg(false);
  set(0, LOGC, []);
  x = ga({}, '--force', '--select', 'trunk', 'xw');
  ok('C-S14. without remoteRun.subsetCommand: no ssh, the selection runs here (guardSubsetCommand) with a note', x.status === 0 && !fs.existsSync(sshLog)
    && /--only srv\/a-run\.js/.test(count('local.count')[0] || '') && /no remoteRun\.subsetCommand/.test(x.all), `${x.status} ${x.all.slice(-600)}`);
}

function partConfig() {
  const C = require('../scripts/config');
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'x {wt}', guardSubsetCommand: 'x {wt} {onlyArgs}' };
  const errs = (rr) => C.resolve(Object.assign({}, base, { remoteRun: Object.assign({ command: 'y {wt}' }, rr) })).errors;
  ok('Q3. config: remoteRun.subsetCommand with {wt} and {onlyArgs} validates', errs({ subsetCommand: 'y {wt} {onlyArgs}' }).length === 0, errs({ subsetCommand: 'y {wt} {onlyArgs}' }).join('; '));
  ok('Q3. config: remoteRun.subsetCommand without {onlyArgs} is an error', errs({ subsetCommand: 'y {wt}' }).some((e) => /remoteRun\.subsetCommand/.test(e)));
  ok('Q3. config: remoteRun.subsetCommand without {wt} is an error', errs({ subsetCommand: 'y {onlyArgs}' }).some((e) => /remoteRun\.subsetCommand/.test(e)));
  const G = require('../scripts/guards-remote');
  const c = { remoteRun: { command: 'full {wt} {jobs}', commandLegacy: 'legacy {wt}' }, guardAdaptiveProbe: { file: 'f', contains: 'c' } };
  const rc = G.runnerConfig(c, "sub {wt} --only 'a'");
  ok('Q3. runnerConfig with a subset command: the runner runs it, no legacy command or probe', rc.guardCommand === "sub {wt} --only 'a'" && !rc.guardCommandLegacy && !rc.guardAdaptiveProbe, JSON.stringify(rc));
}

(async () => {
  await partA();
  partConfig();
  if (!zshOk) { skip('B, C. guards-all.sh --select end to end', 'zsh or git not found'); return done(); }
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p-train-a2-')));
  try {
    fs.mkdirSync(path.join(TMP, 'b')); fs.mkdirSync(path.join(TMP, 'c'));
    partB(path.join(TMP, 'b'));
    if (!has('perl')) skip('C. the selection on the remote runner', 'perl not found'); else partC(path.join(TMP, 'c'));
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  done();
})().catch((e) => { console.error(e); process.exit(1); });
