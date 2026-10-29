#!/usr/bin/env node
'use strict';
// p-train-c3 tester: cells of the tester's own inventory that the programmer's train-ride / train-chain tests leave open.
//   H1-H3  ride of a seam passenger whose partner's await ends on a halt: the halt's own verdict is the exit code
//          (arc-red 14, coordinator 15; a halt without a verdict - the environment - 75). Coordinator's decision for c3:
//          a stop "for the coordinator" is given by await and the chain as a stop for the coordinator, not as environment.
//   H6     (round 2) a partner's halt with a verdict that is not a stop (a stale 'red') is still 75 for the seam passenger.
//   H7     (round 2) the seam passenger's last line keeps verdict seam and the partner's halt with its reason.
//   H4     a result already there for the task and head wins over a halt (ride returns the result's verdict).
//   H5     a branch or base that looks like an option (-x) is refused as usage (64), nothing queued.
//   A1-A2  only one analyst per run: when the analyst of the second review rejection or of the second red tester round
//          already ran, the second red train does not start another one (rule "Only one analyst runs inside a run").
// None of these depart a train (no guards-all.sh run): the partner waits on a halt, the result is already there.
// usage: node tests/train-c3-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-c3-tester-')));
const main = path.join(T, 'main'), shared = path.join(T, 'shared'), TD = path.join(shared, 'train');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref) => git(main, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const cfgFile = path.join(T, 'cfg.json');
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_TRAIN_POLL: '0.2' });
const tr = (...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env, timeout: 60000 });
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };
const queue = () => ls(path.join(TD, 'queue')).filter((f) => f.endsWith('.json')).map((f) => readJ(path.join(TD, 'queue', f)));
const setResult = (task, head, o) => put(path.join(TD, 'result', `${task}-${head}.json`), JSON.stringify(Object.assign({ task, head, branch: task, base: 'arc' }, o)));
const args = (task, branch, head, base = 'arc') => ['--task', task, '--branch', branch, '--head', head, '--base', base, '--dir', path.join(T, 'tasks', task)];

function trainCells() {
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: path.join(T, 'wts'), sharedDir: shared, protectedBranches: ['main'],
    guardCommand: 'cd {wt} && true', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
  git(main, 'init', '-q', '-b', 'main');
  put(path.join(main, 'base.txt'), 'base\n');
  git(main, 'add', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'branch', 'arc'); git(main, 'branch', 'pa'); git(main, 'branch', 'sb');
  const h = rev('arc');
  // the partner p1 is queued (it rides the next train); the seam passenger s has its result already
  for (const [halt, rc, name] of [[{ reason: 'arc-red: g', verdict: 'arc-red' }, 14, 'arc-red'], [{ reason: 'the coordinator decides', verdict: 'coordinator' }, 15, 'coordinator'], [{ reason: 'environment: guards-all.sh exit 69' }, 75, 'environment (no verdict)']]) {
    fs.rmSync(TD, { recursive: true, force: true });
    let r = tr('enqueue', ...args('p1', 'pa', h));
    setResult('s', h, { verdict: 'seam', partner: 'p1', partnerBranch: 'pa', partnerHead: h, guards: ['g'] });
    put(path.join(TD, 'halt'), JSON.stringify(halt));
    r = tr('ride', ...args('s', 'sb', h));
    ok(`H${rc === 14 ? 1 : rc === 15 ? 2 : 3}. ride of a seam passenger whose partner's train halts with ${name} -> exit ${rc}`,
      r.status === rc && queue().some((e) => e.task === 'p1'), `${r.status} ${r.stdout}${r.stderr}`);
    // H7 (tester round 2): the last line names the seam and carries the partner's halt with its reason, so the
    // coordinator sees why the passenger stopped (the chain reads the code, the coordinator reads this line)
    const l = last(r);
    ok(`H7. the seam passenger's last line keeps verdict seam and the partner's halt (${name}) with its reason`,
      l && l.verdict === 'seam' && l.partner === 'p1' && l.partnerResult && l.partnerResult.halted === true && l.partnerResult.reason === halt.reason && (l.partnerResult.verdict || 'environment') === (halt.verdict || 'environment'), `${r.stdout}`);
  }
  // H6 (tester round 2): a halt whose verdict is not a stop for the coordinator (here a stale 'red') is the
  // environment for the seam passenger too (75), never the red code 11 of a fix round on a result that does not exist
  fs.rmSync(TD, { recursive: true, force: true });
  tr('enqueue', ...args('p1', 'pa', h));
  setResult('s', h, { verdict: 'seam', partner: 'p1', partnerBranch: 'pa', partnerHead: h, guards: ['g'] });
  put(path.join(TD, 'halt'), JSON.stringify({ reason: 'a stale halt', verdict: 'red' }));
  {
    const r6 = tr('ride', ...args('s', 'sb', h));
    ok('H6. ride of a seam passenger whose partner halts with a non-stop verdict (red) -> exit 75, not 11', r6.status === 75, `${r6.status} ${r6.stdout}${r6.stderr}`);
  }
  // H4: a result already there wins over a halt
  fs.rmSync(TD, { recursive: true, force: true });
  setResult('r', h, { verdict: 'red', guards: ['g'] });
  put(path.join(TD, 'halt'), JSON.stringify({ reason: 'environment: exit 69' }));
  let r = tr('ride', ...args('r', 'sb', h));
  ok('H4. ride: the result of the task and head already there wins over a halt -> its verdict (red 11)', r.status === 11 && last(r) && last(r).verdict === 'red', `${r.status} ${r.stdout}${r.stderr}`);
  r = tr('await', '--task', 'r', '--head', h);
  ok('H4. await: the result already there wins over a halt -> the result, not the halt', r.status === 0 && last(r) && last(r).verdict === 'red' && !last(r).halted, `${r.status} ${r.stdout}${r.stderr}`);
  // H5: option-like names are usage, nothing queued
  fs.rmSync(TD, { recursive: true, force: true });
  r = tr('ride', ...args('o', '-x', h));
  ok('H5. ride --branch -x -> exit 64, nothing queued', r.status === 64 && !queue().length, `${r.status} ${r.stderr}`);
  r = tr('ride', ...args('o', 'sb', h, '--all'));
  ok('H5. ride --base --all -> exit 64, nothing queued', r.status === 64 && !queue().length, `${r.status} ${r.stderr}`);
}

// ---- the chain: one analyst per run (fake agents, as tests/train-chain.test.js) ----
const SRC = fs.readFileSync(path.join(ROOT, 'workflows/role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ONE = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json', guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const TASK = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const P = (h) => ({ status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: h, mutations: 'm', fullRun: 'r', questions: [], summary: 's' });
const GREEN = { verdict: 'green', summary: '' }, RED = { verdict: 'red', summary: 'r' };
const D = { verdict: 'done', docsOnly: false, summary: 'fine' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'rej' };
const AN = { ready: true, cells: 3, subsystems: 1, split: [], questions: [], summary: 'matrix' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const ride = (rc) => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail: '' });
async function run(script) {
  const trace = []; const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return /:train-/.test(opts.label) ? q.train.shift() : OKR;
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    const v = q[role].shift();
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: ONE, tasks: [TASK] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>') };
}
const analysts = (s) => s.split('>').filter((x) => x === 'analyst').length;

(async () => {
  try { trainCells(); } catch (e) { ok('train cells: no exception', false, e && e.stack); }
  const progs = ['P', 'P2', 'P3', 'P4', 'P5', 'P6'].map(P);
  let x = await run({ pre: [PRE], prog: progs, test: [GREEN, GREEN, GREEN], review: [REJ, REJ, D, D, D, D], analyst: [AN, AN], train: [ride(11), ride(11), ride(0)] });
  ok('A1. the analyst of the second review rejection ran -> the second red train starts no second analyst; the rides go on to green',
    x.r.status === 'done' && analysts(x.trace) === 1, `${x.r.status} ${x.r.why || ''} | ${x.trace}`);
  x = await run({ pre: [PRE], prog: progs, test: [RED, RED, GREEN], review: [D, D, D, D], analyst: [AN, AN], train: [ride(11), ride(11), ride(0)] });
  ok('A2. the analyst of the second red tester round ran -> the second red train starts no second analyst',
    x.r.status === 'done' && analysts(x.trace) === 1, `${x.r.status} ${x.r.why || ''} | ${x.trace}`);
  fs.rmSync(T, { recursive: true, force: true });
  done();
})();
