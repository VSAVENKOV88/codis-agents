'use strict';
// The tester cells of p-codex-A2a-3c (the conductor connects the commit channel), a child of
// tests/chain-run-commit.test.js with its own tally, so README keeps counting test files. Cells beyond the programmer's:
//   TC1 C1d main flow of a restart: an undetermined step stops the task; status --commits gives the basis; resolve
//       --commits decides; the next start runs prog, test and review, and the journal keeps the lines of resolve (no
//       runId, C1a G13) while the new lines carry the runId of the new run;
//   TC2 C1c a git identity with only user.name or only user.email is no author: the task stops before any role;
//   TC3 C1c the check of the author is the codex host's: a claude run without commitAuthor and without an identity runs;
//   TC4 C1c authorProblem: GIT_AUTHOR_* of the conductor's environment is no author (the adapter does not read it), the
//       local identity of the worktree's repository is one (the adapter reads it);
//   TC5 C1c config.js refuses a commitAuthor that is not {name, email} of non-empty strings without <, > or a line break;
//   TC6 C1a a runId that is not a plain name is refused by the adapter and by the commit service; without a runId the
//       adapter config of a run carries none.
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
const CS = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const CONF = require(path.join(ROOT, 'scripts', 'config.js'));
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
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
const AUTHOR_MISSING = 'the commit channel needs an author: set commitAuthor in the project config or user.name/user.email in git';

// ---- TC5: config.js, no process needed
{
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
  const errs = (a) => CONF.resolve(Object.assign({}, base, { commitAuthor: a })).errors.filter((e) => /commitAuthor/.test(e));
  ok('TC5 a valid commitAuthor resolves without errors and is kept', (() => { const r = CONF.resolve(Object.assign({}, base, { commitAuthor: { name: 'codis-agents', email: 'a@example.com' } })); return !r.errors.length && r.config.commitAuthor.name === 'codis-agents' && r.config.commitAuthor.email === 'a@example.com'; })());
  ok('TC5 commitAuthor left out: null in the resolved config', CONF.resolve(base).config.commitAuthor === null);
  for (const [name, a] of [['without email', { name: 'x' }], ['without name', { email: 'a@example.com' }], ['a blank name', { name: '  ', email: 'a@example.com' }],
    ['an email with <', { name: 'x', email: '<a@example.com>' }], ['a name with a line break', { name: 'x\ny', email: 'a@example.com' }],
    ['a string', 'x <a@example.com>'], ['an unknown key', { name: 'x', email: 'a@example.com', date: 'now' }], ['a number for the name', { name: 1, email: 'a@example.com' }]]) {
    ok(`TC5 commitAuthor ${name}: an error naming commitAuthor`, errs(a).length > 0, J(CONF.resolve(Object.assign({}, base, { commitAuthor: a })).errors));
  }
}

// ---- TC6: runId of the adapter and of the commit service
{
  const sd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-tc6-')));
  const st = path.join(sd, 'state'), wt = path.join(sd, 'wt'), td = path.join(sd, 'td');
  for (const d of [st, wt, td]) fs.mkdirSync(d);
  const cfg = (runId) => ({ host: 'codex', tasks: { k: { dir: td, wt, branch: 'b' } }, pluginRoot: ROOT, callsDir: path.join(sd, 'calls'), log: () => {}, codex: { home: path.join(sd, 'home') }, commit: Object.assign({ stateDir: st }, runId === undefined ? {} : { runId }) });
  for (const bad of ['a/b', '../x', '', 'a b', 5]) {
    let err = null;
    try { RE.createAgent(cfg(bad)); } catch (e) { err = e.message; }
    ok(`TC6 the adapter refuses commit.runId ${JSON.stringify(bad)}`, /commit\.runId/.test(String(err)), String(err));
    let err2 = null;
    try { CS.openCommitService({ task: 'k', callId: 'c1', wt, branch: 'b', box: path.join(sd, 'box'), stateDir: st, runId: bad }); } catch (e) { err2 = e.message; }
    ok(`TC6 the commit service refuses runId ${JSON.stringify(bad)}`, /runId/.test(String(err2)), String(err2));
  }
  const plain = CRM.adapterCfg('codex', { config: { sharedDir: sd, worktreeRoot: sd }, tasks: [] }, { codexHome: path.join(sd, 'home') }, path.join(sd, 'calls'), () => {});
  ok('TC6 adapterCfg without a runId: cfg.commit has no runId key', plain.commit && !('runId' in plain.commit), J(plain.commit));
  ok('TC6 adapterCfg without commitAuthor: cfg.commit has no author key (the adapter reads git)', plain.commit && !('author' in plain.commit), J(plain.commit));
  fs.rmSync(sd, { recursive: true, force: true });
}

if (process.platform !== 'darwin' || !has('git')) {
  skip('the commit channel under the conductor', 'needs macOS (the box is read with O_NOFOLLOW_ANY) and git');
  done();
}

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-commit-tc-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo');
const RTMP = path.join(W, 'rtmp');
const NOID = path.join(W, 'home-noid'), NAMEONLY = path.join(W, 'home-name'), MAILONLY = path.join(W, 'home-mail');
for (const d of [RTMP, NOID, NAMEONLY, MAILONLY, REPO]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(NAMEONLY, '.gitconfig'), '[user]\n\tname = Only Name\n');
fs.writeFileSync(path.join(MAILONLY, '.gitconfig'), '[user]\n\temail = only@example.com\n');
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
const cr = (args, env) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 180000 });
const envOf = (fd, home) => Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd, TMPDIR: RTMP, HOME: home || NOID, GIT_CONFIG_NOSYSTEM: '1' });
// start on a host (codex: a trusted hook in a fresh run home); then the end of the run (status --wait).
function run(key, answers, o) {
  const x = o || {};
  const host = x.host || 'codex';
  const fd = fake(answers);
  const tf = path.join(W, `tasks-${++nT}.json`);
  fs.writeFileSync(tf, JSON.stringify(x.tasks || [task(key)]));
  const env = Object.assign(envOf(fd, x.home), x.env || {});
  const more = [];
  if (host === 'codex') {
    const home = path.join(W, `codex-home-${key}-${nT}`);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
    more.push('--codex-home', home);
  }
  const p = cr(['start', '--host', host].concat(more, ['--tasks', tf, '--owner', OWNER, '--config', x.cfg || CFG]), env);
  let j = null;
  try { j = JSON.parse(p.stdout); groups.add(j.pid); } catch { /* below */ }
  let st = null;
  if (j) { const s = cr(['status', j.runDir, '--config', x.cfg || CFG, '--wait', '170'], env); try { st = JSON.parse(s.stdout); } catch { /* below */ } }
  const ev = traceOf(fd);
  return { p, j, st, r: st && st.results && st.results[0], ev, execs: ev.filter((e) => e.ev === 'start'), commits: ev.filter((e) => e.ev === 'commit'), out: p.stdout + p.stderr };
}
const JDIR = path.join(SHARED, 'runs', '.commit');
const journalOf = (key) => { try { return fs.readFileSync(path.join(JDIR, key, 'commits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; } };
const tipOf = (key) => git(path.join(WTR, `w-${key}`), 'rev-parse', `refs/heads/b-${key}`).stdout.trim();

try {
  // ---- TC4: authorProblem as a unit (it reads process.env and the git config seen from the worktree)
  {
    const t = task('u4');
    const wt = path.join(WTR, t.wt);
    const probe = (home, extraEnv, localId) => {
      if (localId) { git(wt, 'config', 'user.name', 'Local Person'); git(wt, 'config', 'user.email', 'local@example.com'); }
      const env = Object.assign({}, process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, extraEnv || {});
      delete env.GIT_CONFIG_GLOBAL; delete env.XDG_CONFIG_HOME;
      const code = `const CR = require(${JSON.stringify(CR)}); process.stdout.write(JSON.stringify({ v: CR.authorProblem({}, ${JSON.stringify(wt)}), c: CR.authorProblem({ commitAuthor: { name: 'n', email: 'e@x' } }, ${JSON.stringify(wt)}) }));`;
      const p = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env });
      if (localId) { git(wt, 'config', '--unset', 'user.name'); git(wt, 'config', '--unset', 'user.email'); }
      try { return JSON.parse(p.stdout); } catch { return { err: p.stdout + p.stderr }; }
    };
    const a = probe(NOID, { GIT_AUTHOR_NAME: 'Env Person', GIT_AUTHOR_EMAIL: 'env@example.com', GIT_COMMITTER_NAME: 'Env Person', GIT_COMMITTER_EMAIL: 'env@example.com' });
    ok('TC4 GIT_AUTHOR_*/GIT_COMMITTER_* of the environment, no identity in git: no author (the adapter ignores them)', a.v === AUTHOR_MISSING, J(a));
    ok('TC4 commitAuthor in the config: no refusal whatever git holds', a.c === null, J(a));
    const b = probe(NOID, {}, true);
    ok('TC4 the local identity of the worktree\'s repository is an author (the adapter reads it)', b.v === null, J(b));
    const c = probe(NAMEONLY, {});
    ok('TC4 only user.name in git: no author', c.v === AUTHOR_MISSING, J(c));
    const d = probe(NOID, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cfg Person', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cfg@example.com' });
    ok('TC4 user.name/user.email given by GIT_CONFIG_* (the adapter reads them too): an author', d.v === null, J(d));
  }

  // ---- TC2: a half identity stops the task before any role, under the conductor
  for (const [home, what] of [[NAMEONLY, 'only user.name'], [MAILONLY, 'only user.email']]) {
    const key = home === NAMEONLY ? 'h1' : 'h2';
    const c = run(key, CHAIN, { cfg: CFG_NOAUTHOR, home });
    ok(`TC2 ${what} in git, no commitAuthor: the task stops before any role with the reason`, c.r && c.r.status === 'stopped' && String(c.r.why).includes(AUTHOR_MISSING) && !c.execs.length && tipOf(key) === SHA0, J(c.r) + c.out);
  }

  // ---- TC3: on claude the author is not the conductor's question (the role commits itself)
  {
    const fd = { programmer: [{ status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' }], tester: [{ verdict: 'green', head: SHA0, summary: '' }], reviewer: [{ verdict: 'done', docsOnly: false, summary: '' }], default: { [K_PRE]: PRE } };
    const c = run('cl', fd, { host: 'claude', cfg: CFG_NOAUTHOR, home: NOID });
    ok('TC3 claude, no commitAuthor and no identity in git: the task is not stopped for an author, its roles run', c.r && !String(c.r.why || '').includes(AUTHOR_MISSING) && c.execs.length >= 3, J(c.r) + ' ' + c.execs.length + c.out);
  }

  // ---- TC1: undetermined -> stopped; status --commits; resolve --commits; the next start runs the task
  {
    const t = task('d1');
    const wt = path.join(WTR, t.wt);
    const tip = tipOf('d1');
    const dj = path.join(JDIR, 'd1');
    fs.mkdirSync(dj, { recursive: true });
    const id = 'a'.repeat(32);
    const lines = [
      { v: 1, n: 1, ts: 'T', call: 'c1', ev: 'intent', id, hash: 'h', paths: ['c.js'], parent: tip, tree: 't', ref: 'refs/heads/b-d1', entries: [] },
      { v: 1, n: 2, ts: 'T', call: 'c1', ev: 'intent-commit', id, sha: 'b'.repeat(40), old: tip },
      { v: 1, n: 3, ts: 'T', call: 'c1', ev: 'undetermined', id, sha: 'b'.repeat(40), old: tip, tip },
    ];
    fs.writeFileSync(path.join(dj, 'commits.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const c1 = run('d1', CHAIN, { tasks: [t] });
    ok('TC1 run 1: undetermined stops the task before any role', c1.r && c1.r.status === 'stopped' && /resolve --commits/.test(String(c1.r.why)) && !c1.execs.length, J(c1.r) + c1.out);
    const s = cr(['status', '--commits', JDIR, '--task', 'd1']);
    let sj = null;
    try { sj = JSON.parse(s.stdout); } catch { /* below */ }
    ok('TC1 status --commits <sharedDir>/runs/.commit names the undetermined request and the basis', sj && sj.undetermined.includes(id) && /^\d+:/.test(sj.commitsBasis), s.stdout + s.stderr);
    const rs = cr(['resolve', '--commits', JDIR, '--task', 'd1', '--request', id, '--wt', wt, '--as', 'refused', '--basis', sj && sj.commitsBasis, '--note', 'not on the branch']);
    ok('TC1 resolve --commits --as refused: exit 0', rs.status === 0, `${rs.status} ${rs.stdout}${rs.stderr}`);
    const nBefore = (journalOf('d1') || []).length;
    const c2 = run('d1', CHAIN, { tasks: [t] });
    const jl = journalOf('d1') || [];
    ok('TC1 run 2 after resolve: pre, prog, test, review ran; the task is done; prog committed on b-d1', c2.r && c2.r.status === 'done' && c2.execs.map((e) => e.key).join('>') === [K_PRE, K_PROG, K_TEST, K_REVIEW].join('>') && tipOf('d1') !== tip
      && jl.some((e) => e.ev === 'result' && e.status === 'committed' && e.sha === tipOf('d1')), J(c2.r) + ' ' + c2.out);
    ok('TC1 the lines of resolve stay without runId, the new lines of run 2 carry its runId', nBefore === 5 && jl.slice(3, 5).every((e) => e.call === 'resolve' && !('runId' in e))
      && jl.length > nBefore && !!c2.j && jl.slice(nBefore).every((e) => e.runId === c2.j.runId), J(jl.map((e) => [e.n, e.ev, e.call, e.runId])));
    const s2 = cr(['status', '--commits', JDIR, '--task', 'd1']);
    ok('TC1 status --commits after run 2: nothing undetermined, no damage', (() => { try { const v = JSON.parse(s2.stdout); return v.undetermined.length === 0 && !v.damage; } catch { return false; } })(), s2.stdout + s2.stderr);
  }
} catch (e) { ok(`no exception: ${e.stack}`, false); } finally {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(W, { recursive: true, force: true });
  done();
}
