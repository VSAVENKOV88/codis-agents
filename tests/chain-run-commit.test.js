#!/usr/bin/env node
'use strict';
// The conductor connects the commit channel (p-codex A2a-3c): on codex the adapter config of a run carries
// cfg.commit = {stateDir: <sharedDir>/runs/.commit, runId, author?} and the task table the branch of each task, so prog
// and test commit through scripts/commit-req.js under the conductor. The conductor runs as a process (chain-run.js start)
// with the fake codex of tests/fixtures/chain-run/bin (no model is called); every task has a worktree on its branch.
// Cells (p-codex-A2a-3/analyst.md, part c, and the coordinator's cells of the brief of A2a-3c):
//   C1 one commit journal per project, <sharedDir>/runs/.commit/<key>/commits.jsonl, kept between runs;
//   C1a every event of the journal carries the runId of its run, older lines without one are read;
//   C1b <sharedDir>/runs/.commit inside a write root of a role refuses; the reconciliation leaves it alone; README names
//       it for any future cleanup of old runs;
//   C1c the author: commitAuthor of the project config, else user.name/user.email of git; neither - the task stops
//       before any role;
//   C1d an undetermined (or damaged) journal of the task stops it before any role until resolve --commits;
//   C2 the branch of a task reaches the adapter; without it prog is refused "has no branch";
//   C3 stateRootProblem takes the write roots from scripts/role-roots.js, no list of its own;
//   C4 prog runs, commits through commit-req.js, then test and review run (chain-run.test.js A13 too);
//   C5 README: the channel is connected, the path of stateDir for status/resolve --commits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const CRM = require(CR);
const RE = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const schemaOf = (name) => {
  const m = new RegExp(`const ${name} = \\{`).exec(SRC);
  let i = m.index + m[0].length - 1, d = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(SRC.slice(m.index, i + 1).replace(/^const /, 'var ') + ';', ctx);
  return JSON.parse(JSON.stringify(ctx[name]));
};
const keyOf = (s) => 'gp:' + Object.keys(s.properties).sort().join(',');
const PROG_S = schemaOf('PROG_SCHEMA'), TEST_S = schemaOf('TEST_SCHEMA'), REVIEW_S = schemaOf('REVIEW_SCHEMA');
const K_PRE = 'gp:blockingQuestions,ok,problems', K_PROG = keyOf(PROG_S), K_TEST = keyOf(TEST_S), K_REVIEW = keyOf(REVIEW_S);

// ---- C5: the README, no process needed
ok('C5 README: no "no conductor uses it yet" and no "not connected to the conductor yet"', !/no conductor uses it yet/.test(README) && !/not connected to the conductor yet/.test(README));
ok('C5 README: the conductor gives the channel <sharedDir>/runs/.commit, the path for status --commits and resolve --commits',
  /chain-run\.js\s+status\s+--commits\s+<sharedDir>\/runs\/\.commit\s+--task\s+<key>/.test(README) && /chain-run\.js\s+resolve\s+--commits\s+<sharedDir>\/runs\/\.commit/.test(README));
ok('C1b README: a cleanup of old runs must keep <sharedDir>/runs/.commit', /cleanup\s+of\s+old\s+runs[^.]*keeps?\s+`?<sharedDir>\/runs\/\.commit/.test(README));
ok('C1c README and schema: commitAuthor', /\| `commitAuthor` \|/.test(README)
  && !!(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents.schema.json'), 'utf8')).properties.commitAuthor));

if (process.platform !== 'darwin' || !has('git')) {
  skip('the commit channel under the conductor', 'needs macOS (the box is read with O_NOFOLLOW_ANY) and git');
  done();
}

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-commit-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo');
const RTMP = path.join(W, 'rtmp');
const NOID = path.join(W, 'home-noid'), IDH = path.join(W, 'home-id');
for (const d of [RTMP, NOID, IDH, REPO]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(IDH, '.gitconfig'), '[user]\n\tname = Home Person\n\temail = home@example.com\n');
const AUTHOR = { name: 'codis-agents', email: 'agents@example.com' };
const cfgFile = (name, extra) => {
  const f = path.join(W, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] }, extra || {})));
  return f;
};
const CFG = cfgFile('cfg-author', { commitAuthor: AUTHOR });
const CFG_NOAUTHOR = cfgFile('cfg-noauthor');
const OWNER = path.join(W, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test tasks');
const GENV = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@s' });
const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null'].concat(a), { cwd, encoding: 'utf8', env: GENV });
git(REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git(REPO, 'add', 'a.js');
git(REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git(REPO, 'rev-parse', 'HEAD').stdout.trim();
const task = (key) => {
  const wt = path.join(WTR, `w-${key}`);
  if (!fs.existsSync(wt)) git(REPO, 'worktree', 'add', '-q', '-b', `b-${key}`, wt, SHA0);
  return { key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' };
};
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['c.js'], commits: ['$C0'], head: '$C0', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: '$HEAD', summary: '' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const CHAIN = { [K_PRE]: [PRE], [K_PROG]: [{ $commits: [{ path: 'c.js', content: '2\n', message: 'the fix' }], then: PROG }], [K_TEST]: [GREEN], [K_REVIEW]: [DONE] };

let nFake = 0;
const fake = (answers) => { const d = path.join(W, `fake${++nFake}`); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(answers)); return d; };
const traceOf = (d) => { try { return fs.readFileSync(path.join(d, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const groups = new Set();
let nT = 0;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const cr = (args, env) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 180000 });
const envOf = (fd, home) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd, TMPDIR: RTMP, HOME: home || NOID, GIT_CONFIG_NOSYSTEM: '1' });
// start on codex with a trusted hook in a fresh run home; then the end of the run (status --wait).
function codexRun(key, answers, o) {
  const x = o || {};
  const fd = fake(answers);
  const home = path.join(W, `codex-home-${key}-${++nT}`);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
  const tf = path.join(W, `tasks-${nT}.json`);
  fs.writeFileSync(tf, JSON.stringify(x.tasks || [task(key)]));
  const env = envOf(fd, x.home);
  const p = cr(['start', '--host', 'codex', '--codex-home', home, '--tasks', tf, '--owner', OWNER, '--config', x.cfg || CFG], env);
  let j = null;
  try { j = JSON.parse(p.stdout); groups.add(j.pid); } catch { /* below */ }
  let st = null;
  if (j) { const s = cr(['status', j.runDir, '--config', x.cfg || CFG, '--wait', '170'], env); try { st = JSON.parse(s.stdout); } catch { /* below */ } }
  const ev = traceOf(fd);
  const calls = (() => { try { return fs.readFileSync(path.join(SHARED, key, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  return { p, j, st, r: st && st.results && st.results[0], ev, execs: ev.filter((e) => e.ev === 'start'), commits: ev.filter((e) => e.ev === 'commit'), calls, out: p.stdout + p.stderr };
}
const JDIR = path.join(SHARED, 'runs', '.commit');
const journalOf = (key) => { try { return fs.readFileSync(path.join(JDIR, key, 'commits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } };
const tipOf = (key) => git(path.join(WTR, `w-${key}`), 'rev-parse', `refs/heads/b-${key}`).stdout.trim();

(async () => {
try {
  // ---- C2, C1, C1a, C1c units: the adapter config of the conductor
  {
    const args = { config: { sharedDir: SHARED, worktreeRoot: WTR, commitAuthor: AUTHOR }, tasks: [task('u1'), Object.assign(task('u2'), { branch: undefined })] };
    const tt = CRM.taskTable(args);
    ok('C2 taskTable carries the branch of a task', tt.u1.branch === 'b-u1' && tt.u2.branch === undefined, J(tt));
    const home = path.join(W, 'unit-home');
    fs.mkdirSync(home);
    const cx = CRM.adapterCfg('codex', args, { codexHome: home }, path.join(SHARED, 'runs', 'R1'), () => {}, 'R1');
    ok('C1 codex: cfg.commit.stateDir is <sharedDir>/runs/.commit, one folder for every run of the project', cx.commit && cx.commit.stateDir === path.join(SHARED, 'runs', '.commit'), J(cx.commit));
    ok('C1a codex: cfg.commit.runId is the runId of the run', cx.commit && cx.commit.runId === 'R1', J(cx.commit));
    ok('C1c codex: cfg.commit.author is commitAuthor of the config', cx.commit && cx.commit.author && cx.commit.author.name === AUTHOR.name && cx.commit.author.email === AUTHOR.email, J(cx.commit));
    const cc = CRM.adapterCfg('claude', args, {}, path.join(SHARED, 'runs', 'R1'), () => {}, 'R1');
    ok('C1 claude: no commit channel in the adapter config', cc.commit === undefined, J(Object.keys(cc)));
    // C2: a codex task without a branch - prog refused before any hook check or launch
    const recs = [];
    let launched = 0;
    const ag = RE.createAgent(Object.assign({}, cx, { env: Object.assign({}, process.env, { TMPDIR: RTMP }), launch: async () => { launched++; return { output: '{}', rc: 0 }; }, beforeLaunch: async () => { launched++; return null; }, onRecord: (r) => recs.push(r) }));
    const v = await ag('p', { label: 'prog:u2#1', schema: PROG_S, agentType: 'general-purpose' });
    ok('C2 a codex task without a branch: prog refused "has no branch", nothing launched', v === null && !launched && recs[0] && recs[0].outcome === 'refused' && /has no branch/.test(recs[0].error || ''), J(recs));
  }

  // ---- C3: the roots of stateRootProblem come from scripts/role-roots.js (a root added there is seen here)
  {
    const extra = path.join(W, 'extra-root');
    fs.mkdirSync(extra);
    const probe = `const RR = require(${JSON.stringify(path.join(ROOT, 'scripts', 'role-roots.js'))});
const orig = RR.roleRoots;
RR.roleRoots = (o) => { const r = orig(o); r.reach = r.reach.concat([${JSON.stringify(extra)}]); r.check = r.check.concat([${JSON.stringify(extra)}]); return r; };
const CR = require(${JSON.stringify(CR)});
const args = { config: { sharedDir: ${JSON.stringify(path.join(extra, 'shared'))}, worktreeRoot: ${JSON.stringify(WTR)} }, tasks: [{ key: 'x', wt: 'w-u1', dir: ${JSON.stringify(path.join(W, 'td-c3'))} }] };
process.stdout.write(JSON.stringify({ codex: CR.stateRootProblem(args, 'codex', {}), claude: CR.stateRootProblem(args, 'claude', {}) }));`;
    const pr = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
    let v = {};
    try { v = JSON.parse(pr.stdout); } catch { /* below */ }
    ok('C3 a root added in role-roots.js refuses a sharedDir under it in stateRootProblem (codex and claude)', /overlaps/.test(String(v.codex)) && /overlaps/.test(String(v.claude)), pr.stdout + pr.stderr);
    const plain = CRM.stateRootProblem({ config: { sharedDir: path.join(extra, 'shared'), worktreeRoot: WTR }, tasks: [{ key: 'x', wt: 'w-u1', dir: path.join(W, 'td-c3') }] }, 'codex', {});
    ok('C3 the same sharedDir without that root passes', plain === null, String(plain));
  }

  // ---- C1b: <sharedDir>/runs/.commit through a link into a write root of a role
  {
    const sh = path.join(W, 's-link');
    fs.mkdirSync(path.join(sh, 'runs'), { recursive: true });
    const t = task('lk');
    const tdir = path.join(W, 'td-lk');
    fs.mkdirSync(tdir);
    fs.symlinkSync(tdir, path.join(sh, 'runs', '.commit'));
    const args = { config: { sharedDir: sh, worktreeRoot: WTR }, tasks: [Object.assign({}, t, { dir: tdir })] };
    const why = CRM.stateRootProblem(args, 'codex', {});
    ok('C1b stateRootProblem: <sharedDir>/runs/.commit linked into the task folder is refused, naming .commit', /\.commit/.test(String(why)) && /overlaps/.test(String(why)), String(why));
    const why2 = CRM.stateRootProblem(args, 'claude', {});
    ok('C1b the same on claude (the task folder is a write root there too)', /\.commit/.test(String(why2)), String(why2));
    const cfgL = cfgFile('cfg-link', { sharedDir: sh, commitAuthor: AUTHOR });
    const tf = path.join(W, 'tasks-link.json');
    fs.writeFileSync(tf, JSON.stringify([Object.assign({}, t, { dir: tdir })]));
    const home = path.join(W, 'codex-home-link');
    fs.mkdirSync(home);
    const p = cr(['start', '--host', 'codex', '--codex-home', home, '--tasks', tf, '--owner', OWNER, '--config', cfgL], envOf(fake({})));
    const runs = fs.readdirSync(path.join(sh, 'runs')).filter((n) => !n.startsWith('.'));
    ok('C1b start: exit 64 before the run folder', p.status === 64 && /\.commit|commit\.stateDir/.test(p.stderr) && !runs.length, `${p.status} ${p.stderr}`);
  }

  // ---- C4, C1, C1a, C1c: prog commits through the channel under the conductor, then test and review; an older journal
  // line without runId stays and is read
  {
    fs.mkdirSync(path.join(JDIR, 'g1'), { recursive: true });
    const old = { v: 1, n: 1, ts: '2026-11-01T00:00:00.000Z', call: 'resolve', ev: 'result', id: 'f'.repeat(32), hash: 'h', status: 'refused', resolved: true, why: 'resolved by the coordinator: old' };
    fs.writeFileSync(path.join(JDIR, 'g1', 'commits.jsonl'), JSON.stringify(old) + '\n');
    const c = codexRun('g1', CHAIN);
    const keys = c.execs.map((e) => e.key);
    ok('C4 the chain on codex: pre, prog, test, review ran; the task is done', c.r && c.r.status === 'done' && keys.join('>') === [K_PRE, K_PROG, K_TEST, K_REVIEW].join('>'), J(c.r) + ' ' + keys.join('>') + ' ' + c.out);
    ok('C4 prog committed through commit-req.js: committed, the sha is the tip of b-g1', c.commits.length === 1 && c.commits[0].rc === 0 && /"status":"committed"/.test(c.commits[0].out) && c.commits[0].out.includes(tipOf('g1')) && tipOf('g1') !== SHA0, J(c.commits));
    ok('C4 every role call of the task ended ok in calls.jsonl', c.calls.length === 4 && c.calls.every((x) => x.outcome === 'ok'), J(c.calls.map((x) => [x.label, x.outcome, x.error])));
    const au = git(path.join(WTR, 'w-g1'), 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'refs/heads/b-g1').stdout.trim();
    ok('C1c the commit carries commitAuthor of the config as author and committer', au === `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>`, au);
    const jl = journalOf('g1') || [];
    ok('C1 the journal of the task is <sharedDir>/runs/.commit/g1/commits.jsonl, continued from the earlier line', jl.length > 2 && J(jl[0]) === J(old) && jl.some((e) => e.ev === 'result' && e.status === 'committed' && e.sha === tipOf('g1')), J(jl));
    ok('C1a every new event carries the runId of the run', jl.length > 1 && !!c.j && jl.slice(1).every((e) => e.runId === c.j.runId), J(jl.slice(1).map((e) => [e.ev, e.runId])));
    ok('C1 nothing of the channel in the run folder', !!c.j && !fs.existsSync(path.join(c.j.runDir, '.commit')) && !fs.existsSync(path.join(c.j.runDir, 'g1')), J(c.j && fs.readdirSync(c.j.runDir)));

    // C1b: a second run of the same task - the reconciliation leaves .commit as it is, and the new run appends to it
    const before = fs.readFileSync(path.join(JDIR, 'g1', 'commits.jsonl'), 'utf8');
    const c2 = codexRun('g1', { [K_PRE]: [PRE], [K_PROG]: [{ $commits: [{ path: 'c.js', content: '3\n' }], then: PROG }], [K_TEST]: [GREEN], [K_REVIEW]: [DONE] }, { tasks: [task('g1')] });
    const after = fs.readFileSync(path.join(JDIR, 'g1', 'commits.jsonl'), 'utf8');
    ok('C1b C1 a second run: done, and its journal lines follow the first run\'s, which stay as they were', c2.r && c2.r.status === 'done' && after.startsWith(before) && after.length > before.length
      && (journalOf('g1') || []).slice(before.split('\n').length - 1).every((e) => !!c2.j && e.runId === c2.j.runId), J(c2.r) + c2.out);
  }

  // ---- C1c: no commitAuthor and no identity in git: the task stops before any role, with the reason
  {
    const c = codexRun('n1', CHAIN, { cfg: CFG_NOAUTHOR, home: NOID });
    const why = 'the commit channel needs an author: set commitAuthor in the project config or user.name/user.email in git';
    ok('C1c no author: start names the reason for the task, no codex call, no hook check', c.j && String(c.j.tasks && c.j.tasks.n1).includes(why) && !c.execs.length && !c.ev.some((e) => e.ev === 'hooks'), J(c.j) + c.out);
    ok('C1c no author: the result is stopped with that reason', c.r && c.r.status === 'stopped' && String(c.r.why).includes(why), J(c.r));
    const c2 = codexRun('n2', CHAIN, { cfg: CFG_NOAUTHOR, home: IDH });
    const au = git(path.join(WTR, 'w-n2'), 'log', '-1', '--format=%an <%ae>', 'refs/heads/b-n2').stdout.trim();
    ok('C1c no commitAuthor, user.name/user.email in git: the chain runs and the commit carries that identity', c2.r && c2.r.status === 'done' && au === 'Home Person <home@example.com>', J(c2.r) + ' ' + au + c2.out);
  }

  // ---- C1d, C1: an undetermined step of an earlier run blocks the task before any role, until resolve --commits
  {
    const t = task('d1');
    const tip = tipOf('d1');
    const dj = path.join(JDIR, 'd1');
    fs.mkdirSync(dj, { recursive: true });
    const id = 'a'.repeat(32);
    const lines = [
      { v: 1, n: 1, ts: 'T', call: 'c1', ev: 'intent', id, hash: 'h', paths: ['c.js'], parent: tip, tree: 't', ref: 'refs/heads/b-d1', entries: [] },
      { v: 1, n: 2, ts: 'T', call: 'c1', ev: 'intent-commit', id, sha: 'b'.repeat(40), old: 'c'.repeat(40) },
      { v: 1, n: 3, ts: 'T', call: 'c1', ev: 'undetermined', id, sha: 'b'.repeat(40), old: 'c'.repeat(40), tip },
    ];
    fs.writeFileSync(path.join(dj, 'commits.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const before = fs.readFileSync(path.join(dj, 'commits.jsonl'), 'utf8');
    const c = codexRun('d1', CHAIN, { tasks: [t] });
    const why = String(c.j && c.j.tasks && c.j.tasks.d1);
    ok('C1d undetermined: start names the journal, the request and resolve --commits; no codex call, no hook check',
      why.includes(path.join(dj, 'commits.jsonl')) && why.includes(id) && /resolve --commits/.test(why) && !c.execs.length && !c.ev.some((e) => e.ev === 'hooks'), why + c.out);
    ok('C1d the result is stopped with that reason, the journal is not changed', c.r && c.r.status === 'stopped' && /resolve --commits/.test(String(c.r.why)) && fs.readFileSync(path.join(dj, 'commits.jsonl'), 'utf8') === before, J(c.r));
    // a damaged journal: the adapter would refuse every request, so the task stops too
    const t2 = task('d2');
    fs.mkdirSync(path.join(JDIR, 'd2'), { recursive: true });
    fs.writeFileSync(path.join(JDIR, 'd2', 'commits.jsonl'), '{"v":1,"n":5}\n');
    const c2 = codexRun('d2', CHAIN, { tasks: [t2] });
    const why2 = String(c2.j && c2.j.tasks && c2.j.tasks.d2);
    ok('C1d a damaged journal: the task stops before any role, naming the file', /damaged/.test(why2) && why2.includes(path.join(JDIR, 'd2', 'commits.jsonl')) && !c2.execs.length, why2 + c2.out);
  }

  // ---- the tester cells: tests/chain-run-commit-tester-cases.js, a child with its own tally, so README keeps counting
  // test files (the restart after resolve --commits, a half git identity, the claude host, config and runId refusals)
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'chain-run-commit-tester-cases.js')], { encoding: 'utf8', timeout: 280000 });
    ok('the tester cells of the commit channel under the conductor (tests/chain-run-commit-tester-cases.js) pass', tc.status === 0, `${tc.status} ${tc.signal || ''}\n${String(tc.stdout).split('\n').filter((l) => /FAIL/.test(l)).join('\n').slice(0, 3000)}${String(tc.stderr).slice(-800)}`);
  }
} catch (e) { ok(`no exception: ${e.stack}`, false); } finally {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(W, { recursive: true, force: true });
  done();
}
})();
