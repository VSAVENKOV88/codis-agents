'use strict';
// The tester cells of resolve (p-codex-B1-b2b), a child of tests/chain-resolve.test.js with its own tally:
// T1 (Q1) the commits journal resolved by `chain-run.js resolve --commits` is opened by the real adapter
//    (scripts/commit-service.js openCommitService): before the decision the open names the undetermined request; after
//    committed (and after refused) no undetermined note and no new undetermined line; a decision killed between its two
//    lines (resolved without result) reads undetermined again at the next open.
// T2 (R3) two resolve processes at once on the same step: exactly one decision file, exactly one exit 0.
// T3 (Z4) the head of a decision that is no longer an ancestor of the worktree's HEAD refuses the start.
// T4 (G14) the context of a step by the label forms workflows/role-chain.js gives: the main path, the round after the
//    review, the round after a train, the retry suffix, an unknown label.
// No model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');
const R = require('../scripts/chain-resolve.js');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-resolve-t-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
const rev = (cwd, r) => git(cwd, 'rev-parse', r).stdout.trim();
const cli = (args) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8' });
const deadPid = () => +spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
const DEAD = { pid: deadPid(), lstart: 'Mon Jan 1 00:00:00 2024' };

(async () => {
  // ---- T1: the real adapter opens the resolved journal
  if (process.platform !== 'darwin') skip('T1 the commits journal opened by the adapter', 'commit-service.js needs macOS');
  else {
    const svc = require('../scripts/commit-service.js');
    const GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const mk = (name) => {
      const d = path.join(W, name), repo = path.join(d, 'repo'), wt = path.join(d, 'wt'), state = path.join(d, 'state'), tdir = path.join(d, 'tdir'), home = path.join(d, 'home');
      for (const x of [repo, state, tdir, home]) fs.mkdirSync(x, { recursive: true });
      fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = T\n\temail = t@example.com\n');
      git(repo, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      git(repo, 'add', 'a.txt');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
      const A = rev(wt, 'HEAD');
      // the intended commit B (child of A), then the branch moved on to C (child of B): the tip is neither B nor A
      fs.writeFileSync(path.join(wt, 'a.txt'), 'b\n');
      git(wt, 'commit', '-q', '-am', 'the intended commit');
      const B = rev(wt, 'HEAD');
      git(wt, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
      const C = rev(wt, 'HEAD');
      const tree = rev(wt, `${B}^{tree}`);
      const J = path.join(state, 'K', 'commits.jsonl');
      fs.mkdirSync(path.dirname(J), { recursive: true });
      const line = (n, e) => JSON.stringify(Object.assign({ v: 1, n, ts: new Date().toISOString(), call: 'c0' }, e)) + '\n';
      fs.writeFileSync(J, line(1, { ev: 'intent', id: 'r1', hash: 'h1', paths: ['a.txt'], parent: A, tree, ref: 'refs/heads/task', entries: [] })
        + line(2, { ev: 'intent-commit', id: 'r1', sha: B, old: A }) + line(3, { ev: 'undetermined', id: 'r1', sha: B, old: A, tip: C }));
      let callN = 0;
      const open = async () => {
        const s = svc.openCommitService({ task: 'K', callId: `call-${++callN}`, wt, branch: 'task', box: path.join(tdir, `box-${callN}`), stateDir: state, git: GIT,
          userEnv: { PATH: process.env.PATH, HOME: home, TMPDIR: tdir }, log: () => {} });
        const notes = s.notes();
        await s.close();
        return notes.join(' | ');
      };
      const lines = () => fs.readFileSync(J, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { d, wt, state, J, A, B, C, open, lines, line };
    };
    const f = mk('q1');
    const n0 = await f.open();
    ok('T1 before the decision the adapter names the undetermined request', /undetermined/.test(n0), n0);
    const undet0 = f.lines().filter((e) => e.ev === 'undetermined').length;
    let st = JSON.parse(cli(['status', '--commits', f.state, '--task', 'K']).stdout || '{}');
    let x = cli(['resolve', '--commits', f.state, '--task', 'K', '--request', 'r1', '--wt', f.wt, '--as', 'committed', '--basis', st.commitsBasis, '--note', 'B is on the branch']);
    ok('T1 resolve --commits committed is written', x.status === 0, x.stderr);
    const n1 = await f.open();
    ok('T1 after committed the adapter opens without an undetermined note', !/undetermined/.test(n1), n1);
    ok('T1 after committed the open writes no new undetermined line and no second result', f.lines().filter((e) => e.ev === 'undetermined').length === undet0
      && f.lines().filter((e) => e.ev === 'result' && e.id === 'r1').length === 1, JSON.stringify(f.lines().slice(-3)));
    // refused: an intended commit that never reached the branch
    const g = mk('q1r');
    git(g.wt, 'reset', '-q', '--hard', g.A);
    git(g.wt, 'commit', '-q', '--allow-empty', '-m', 'other');
    st = JSON.parse(cli(['status', '--commits', g.state, '--task', 'K']).stdout || '{}');
    x = cli(['resolve', '--commits', g.state, '--task', 'K', '--request', 'r1', '--wt', g.wt, '--as', 'refused', '--basis', st.commitsBasis, '--note', 'B never reached the branch']);
    ok('T1 resolve --commits refused is written', x.status === 0, x.stderr);
    const n2 = await g.open();
    ok('T1 after refused the adapter opens without an undetermined note', !/undetermined/.test(n2), n2);
    // killed between the two lines: only the resolved line
    const k = mk('q1k');
    fs.appendFileSync(k.J, k.line(4, { ev: 'resolved', id: 'r1', as: 'committed', note: 'n' }));
    const n3 = await k.open();
    ok('T1 resolved without result (killed between the lines) is undetermined again at the next open', /undetermined/.test(n3)
      && k.lines().filter((e) => e.ev === 'undetermined').length === 2, n3);
  }

  // ---- run folders for T2, T3 (the real journal writer)
  const SHARED = path.join(W, 's'), RUNS = path.join(SHARED, 'runs'), REPO = path.join(W, 'repo');
  fs.mkdirSync(RUNS, { recursive: true });
  const CFG = { repoDir: REPO, sharedDir: SHARED, worktreeRoot: W, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] };
  fs.mkdirSync(REPO);
  git(REPO, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
  git(REPO, 'add', 'a.js');
  git(REPO, 'commit', '-q', '-m', 'base');
  const H = rev(REPO, 'HEAD');
  fs.writeFileSync(path.join(REPO, 'a.js'), '2\n');
  git(REPO, 'commit', '-q', '-am', 'the role');
  const B = rev(REPO, 'HEAD');
  let nRun = 0;
  const mkRun = (key) => {
    const id = `2026${String(++nRun).padStart(4, '0')}-t`;
    const rd = path.join(RUNS, id);
    fs.mkdirSync(path.join(rd, 'tasks'), { recursive: true });
    const t = { key, title: key, wt: REPO, branch: 'main', accept: 'a', kind: 'tail', noAnalysis: 'x' };
    CJ.writeAtomic(path.join(rd, 'request.json'), { runId: id, host: 'claude', args: { owner: '', config: CFG, tasks: [t] }, adapter: {} });
    CJ.writeAtomic(path.join(rd, 'run.json'), { runId: id, pid: DEAD.pid, lstart: DEAD.lstart, host: 'claude', tasks: [key] });
    CJ.writeAtomic(path.join(rd, 'tasks', `${key}.json`), { state: 'running' });
    const j = CJ.openJournal(rd, id, key);
    j.append({ type: 'intent', stepId: `${id}:1`, n: 1, kind: 'agent', stepKind: 'prog', label: `prog:${key}#1`, effect: 'never', gated: true, gitHead: H, counts: { testerReds: 0, trainReds: 0, rejections: 0 }, head: '' });
    j.append({ type: 'launch', stepId: `${id}:1`, gated: true, pid: DEAD.pid, pgid: null, lstart: DEAD.lstart });
    return { id, rd };
  };
  const run = (args) => new Promise((res) => { const c = spawn(process.execPath, [CR].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] }); let e = ''; c.stderr.on('data', (d) => { e += d; }); c.on('close', (rc) => res({ rc, e })); });

  // ---- T2: two resolve at once on one step
  let allOne = true, detail = '';
  for (let i = 0; i < 6; i++) {
    const key = `c${i}`;
    const { rd } = mkRun(key);
    const basis = R.basisOf(rd, key);
    const args = (note) => ['resolve', rd, '--task', key, '--as', 'retry', '--step', '1', '--basis', basis, '--note', note];
    const rs = await Promise.all([run(args('first')), run(args('second'))]);
    const files = fs.existsSync(path.join(rd, 'resolved', key)) ? fs.readdirSync(path.join(rd, 'resolved', key)) : [];
    const wins = rs.filter((r) => r.rc === 0).length;
    if (wins !== 1 || files.length !== 1 || files[0] !== '1.json') { allOne = false; detail += `#${i}: wins ${wins}, files ${files.join(',')}; ${rs.map((r) => r.e.trim()).join(' / ')} `; }
  }
  ok('T2 (R3) two resolve at once on one step: one decision file, one exit 0, the other refused', allOne, detail);

  // ---- T3: the head of a decision is no longer an ancestor of HEAD (Z4)
  {
    const key = 'z4';
    const { rd } = mkRun(key);
    const x = cli(['resolve', rd, '--task', key, '--as', 'ran', '--step', '1', '--head', B, '--basis', R.basisOf(rd, key), '--note', 'B by the role']);
    ok('T3 prog ran --head B is written', x.status === 0, x.stderr);
    const t = { key, resumeAt: 'tester', head: B };
    let sc = R.startCheck(RUNS, key, t, 'own', { wt: REPO });
    ok('T3 the start with the next of the decision goes while B is an ancestor of HEAD', !sc.why, sc.why);
    git(REPO, 'reset', '-q', '--hard', H);
    sc = R.startCheck(RUNS, key, t, 'own', { wt: REPO });
    ok('T3 (Z4) the head of the decision no longer an ancestor of HEAD -> the start is refused', !!sc.why && sc.why.includes(B) && /ancestor/.test(sc.why), JSON.stringify(sc));
    git(REPO, 'reset', '-q', '--hard', B);
  }

  // ---- T4: the context of a label (G14), the forms role-chain.js gives
  const cx = (label) => R.contextOf(R.labelInfo(label));
  const table = [
    ['prog:k#1', 'main'], ['prog:k#T1', 'main'], ['prog:k#A2', 'main'], ['prog:k#1m', 'main'], ['prog:k#1f', 'main'], ['prog:k#1mf', 'main'], ['prog:k#1#retry', 'main'],
    ['test:k#T2', 'main'], ['test:k#A1', 'main'], ['review:k#1', 'main'], ['review:k#A1', 'main'], ['review:k#T1', 'main'], ['sec:k#T1', 'main'],
    ['run:k:select-1', 'main'], ['run:k:select-A2f', 'main'], ['run:k:select-T1m', 'main'], ['run:k:train-1', 'main'],
    ['prog:k#r', 'after-review'], ['prog:k#Ar', 'after-review'], ['prog:k#rm', 'after-review'], ['prog:k#Trf', 'after-review'],
    ['test:k#after-review', 'after-review'], ['test:k#Aafter-review', 'after-review'], ['review:k#2', 'after-review'], ['review:k#A2', 'after-review'],
    ['sec:k#T2', 'after-review'], ['run:k:select-r', 'after-review'], ['run:k:select-Arf', 'after-review'],
    ['prog:k#t1', 'after-train'], ['prog:k#t2-2f', 'after-train'], ['test:k#t1', 'after-train'], ['test:k#t1-2', 'after-train'], ['review:k#t1', 'after-train'],
    ['run:k:select-t1', 'after-train'], ['run:k:select-t1-2f', 'after-train'],
    ['prog:k#zz', 'unknown'], ['review:k#3', 'unknown'], ['test:k#1m', 'unknown'], ['nonsense', 'unknown'],
  ];
  const bad = table.filter(([l, want]) => cx(l) !== want).map(([l, want]) => `${l}: ${cx(l)} (want ${want})`);
  ok('T4 (G14) the context of every label form of role-chain.js', bad.length === 0, bad.join('; '));
  // ran in a round after the review or the train is refused with "only retry or abort"; retry starts from the beginning
  const step = (label) => ({ label, gitHead: H, counts: { rejections: 1 } });
  const v1 = R.nextOf({ step: step('test:k#Aafter-review'), as: 'ran', verdict: 'green', head: B, form: { light: false, oneRun: false }, wt: REPO, recorded: { has: false } });
  ok('T4 test after-review of an analyst round ran -> only retry or abort', !!v1.error && /only retry or abort/.test(v1.error), JSON.stringify(v1));
  const v2 = R.nextOf({ step: step('run:k:select-t1-2f'), as: 'retry', form: { light: false, oneRun: true }, wt: REPO, recorded: { has: false } });
  ok('T4 a selection after a train retry -> from the beginning with the counts', v2.next && v2.next.resumeAt === null && v2.next.counts.rejections === 1, JSON.stringify(v2));

  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  done();
})().catch((e) => { ok('the tester cells ran without an exception', false, e.stack); done(); });
