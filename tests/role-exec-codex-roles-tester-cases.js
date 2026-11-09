'use strict';
// The tester's cells around p-codex-A2a-3a (prog and test on codex with the commit channel) that
// tests/role-exec-codex-roles.test.js does not hold; that test runs this file as a child, with its own tally. A fake
// codex CLI only (a Node script in codex.bin); no model and no real Codex.
//   TS1  S1 a worktree and a task folder given through symbolic links: -C, cwd and writable_roots are the real paths
//   TS2  S8 test under the launch hook: cwd = the worktree
//   TS3  S3/T2/T4 analyst, usecases, sec: -C the task folder, no sandbox keys, the host section once, no commit client
//   TS4  S5 an inherited npm cache under a mixed-case name; test gets the cache of the call; the plan of a launcher too
//   TS5  S4 a commit.stateDir that holds the worktree; a stateDir through a link into the task folder
//   TS6  H6 <wt>/.codex as the hooks folder is no write place (committed); H5 /tmp itself; a link in the worktree to a
//        folder under /tmp (refused as not tracked, by the real path); H1 a link in the worktree to a folder outside
//        (committed); H5 a hooks folder in the worktree that does not exist yet (refused: the tip does not track it)
//   TS7  R1 a head of exactly 7 hex digits and commits as 7-digit prefixes: ok; R2 two commits, head = the first: invalid
//   TS8  R5 the CLI ends 0 without an answer: no-result, no compare, the summary kept
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const RE = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const CS = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const CLIENT = path.join(ROOT, 'scripts', 'commit-req.js');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'), 'utf8'));
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
const schemaOf = (name) => {
  const m = new RegExp(`const ${name} = \\{`).exec(SRC);
  let i = m.index + m[0].length - 1, d = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(SRC.slice(m.index, i + 1).replace(/^const /, 'var ') + ';', ctx);
  return JSON.parse(JSON.stringify(ctx[name]));
};
const SCH = { prog: schemaOf('PROG_SCHEMA'), test: schemaOf('TEST_SCHEMA'), review: schemaOf('REVIEW_SCHEMA'), analyst: schemaOf('ANALYST_SCHEMA'),
  usecases: schemaOf('USECASES_SCHEMA'), sec: schemaOf('REVIEW_SCHEMA') };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const HEAD_MARK = '## On this host (codex)';

if (process.platform !== 'darwin' || !has('git')) {
  skip('tester cells of prog/test on codex', 'needs macOS (the box is read with O_NOFOLLOW_ANY) and git');
  done();
}
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-roles-tc-')));
process.on('exit', () => { fs.rmSync(BASE, { recursive: true, force: true }); });
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rp = (p) => fs.realpathSync(p);

// The fake codex: argv, cwd, env and stdin into FAKE_DUMP; the commits of the scenario through the client; the answer
// with $C<n> (the sha of the n-th commit), $START, a ":<k>" tail shortens it; sc.noAnswer: exit 0 without the -o file.
const FAKE = path.join(BASE, 'fake-codex.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_SC, 'utf8'));
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const start = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify({ argv, cwd: process.cwd(), env: process.env, stdin: Buffer.concat(chunks).toString('utf8') }));
  const shas = [];
  for (const c of sc.commits || []) {
    fs.writeFileSync(path.join(process.cwd(), c.path), c.content);
    const r = spawnSync(process.execPath, [process.env.CLIENT, '-m', c.message || 'm', '--', c.path], { env: process.env, encoding: 'utf8' });
    let j = {}; try { j = JSON.parse(String(r.stdout).trim().split('\\n').pop()); } catch {}
    shas.push(j.sha || null);
  }
  const sub = (x) => {
    if (Array.isArray(x)) return x.map(sub);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = sub(x[k]); return o; }
    const m = typeof x === 'string' ? /^\\$(C(\\d+)|START)(?::(\\d+))?$/.exec(x) : null;
    if (!m) return x;
    const v = m[1] === 'START' ? start : shas[+m[2]];
    return m[3] && v ? v.slice(0, +m[3]) : v;
  };
  if (!sc.noAnswer) fs.writeFileSync(argv[argv.indexOf('-o') + 1], JSON.stringify(sub(sc.answer)));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');
});
`);
fs.chmodSync(FAKE, 0o755);

let fixN = 0;
// A repository with a linked worktree on branch "task" (o.main: the main checkout is the worktree), the task folder,
// the adapter's state folder, the role's TMPDIR and a user home with an identity.
function fixture(o) {
  const x = o || {};
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'), home: path.join(d, 'home'),
    chome: path.join(d, 'chome'), sc: path.join(d, 'sc.json'), dump: path.join(d, 'dump.json') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'chome']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  for (const n of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  if (x.files) for (const [n, c] of Object.entries(x.files)) { fs.mkdirSync(path.dirname(path.join(f.repo, n)), { recursive: true }); if (c && c.link) fs.symlinkSync(c.link, path.join(f.repo, n)); else fs.writeFileSync(path.join(f.repo, n), c); }
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  if (x.main) { git(f.repo, ['checkout', '-q', '-b', 'task']); f.wt = f.repo; } else {
    f.wt = path.join(d, 'wt');
    git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  }
  f.env = { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp, FAKE_SC: f.sc, FAKE_DUMP: f.dump, CLIENT, Npm_Config_Cache: '/inherited/mixed' };
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  return f;
}
const recsOf = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function agentOf(f, over) {
  const seen = { plans: [] };
  const cfg = Object.assign({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {},
    codex: { home: f.chome, bin: FAKE, catalog: CATALOG }, env: f.env,
    tasks: { K: { dir: f.tdirArg || f.tdir, wt: f.wtArg || f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT },
    beforeLaunch: async (plan) => { seen.plans.push({ label: plan.label, cwd: plan.cwd, argv: plan.argv.slice() }); return null; } }, over || {});
  const ag = RE.createAgent(cfg);
  ag.seen = seen;
  return ag;
}
async function call(f, ag, label, schema, sc) {
  fs.writeFileSync(f.sc, JSON.stringify(sc || {}));
  fs.rmSync(f.dump, { force: true });
  const n = recsOf(f.tdir).length;
  const v = await ag('Do the task.', { label, schema, agentType: 'general-purpose' });
  const recs = recsOf(f.tdir);
  let dump = null;
  try { dump = JSON.parse(fs.readFileSync(f.dump, 'utf8')); } catch { /* not launched */ }
  return { v, rec: recs.length > n ? recs[recs.length - 1] : null, dump };
}
const after = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
const cOf = (argv) => argv.filter((a, i) => argv[i - 1] === '-c');
const PROG_OK = (head, commits) => ({ status: 'ready', changedFiles: ['a.txt'], commits, head, mutations: 'm', fullRun: 'f', acceptance: null, questions: [], summary: 's' });
const TEST_OK = (head) => ({ verdict: 'green', environment: null, head, summary: 's' });
const NO_DUMP = { argv: [], env: {}, stdin: '', cwd: '/' };

(async () => {
  // ---- TS1, TS4 (prog): the worktree and the task folder through links
  {
    const f = fixture();
    f.wtArg = path.join(f.d, 'wt-link'); fs.symlinkSync(f.wt, f.wtArg);
    f.tdirArg = path.join(f.d, 'tdir-link'); fs.symlinkSync(f.tdir, f.tdirArg);
    const ag = agentOf(f);
    const x = await call(f, ag, 'prog:K#1', SCH.prog, { commits: [{ path: 'a.txt', content: 'g\n' }], answer: PROG_OK('$C0', ['$C0']) });
    const d = x.dump || NO_DUMP;
    ok('TS1 S1 the worktree given by a link: -C and the cwd are its real path', after(d.argv, '-C') === rp(f.wt) && !!d.cwd && rp(d.cwd) === rp(f.wt) && !d.argv.includes(f.wtArg), J(d.argv));
    ok('TS1 S1 the task folder given by a link: writable_roots holds its real path, not the link',
      cOf(d.argv).includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([rp(f.tdir)])}`) && !cOf(d.argv).join(' ').includes(f.tdirArg), J(cOf(d.argv)));
    ok('TS1 S8 the launch hook sees the real path of the worktree', ag.seen.plans[0] && ag.seen.plans[0].cwd === rp(f.wt), J(ag.seen.plans[0]));
    ok('TS1 the call through links is ok and committed', x.rec && x.rec.outcome === 'ok', J(x.rec));
    const npmKeys = Object.keys(d.env).filter((k) => k.toLowerCase() === 'npm_config_cache');
    ok('TS4 S5 an inherited Npm_Config_Cache (mixed case) does not reach prog; only the cache of the call',
      npmKeys.length === 1 && npmKeys[0] === 'npm_config_cache' && x.rec && d.env.npm_config_cache === path.join(x.rec.callDir, 'npm-cache'), J(npmKeys.map((k) => [k, d.env[k]])));
  }

  // ---- TS2, TS4 (test), TS3: test and the reading kinds
  {
    const f = fixture();
    const ag = agentOf(f);
    let x = await call(f, ag, 'test:K#1', SCH.test, { answer: TEST_OK('$START') });
    const d = x.dump || NO_DUMP;
    ok('TS2 S8 test under the launch hook: cwd = the worktree', ag.seen.plans[0] && ag.seen.plans[0].cwd === rp(f.wt), J(ag.seen.plans[0]));
    ok('TS2 R1/R4 test without a commit, head = the start tip: ok', x.rec && x.rec.outcome === 'ok', J(x.rec));
    const npmKeys = Object.keys(d.env).filter((k) => k.toLowerCase() === 'npm_config_cache');
    ok('TS4 S5 test gets npm_config_cache = <call folder>/npm-cache, the mixed-case inherited one dropped',
      npmKeys.length === 1 && x.rec && d.env.npm_config_cache === path.join(x.rec.callDir, 'npm-cache'), J(npmKeys.map((k) => [k, d.env[k]])));
    for (const kind of ['analyst', 'usecases', 'sec']) {
      const ans = kind === 'sec' ? { verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' } : null;
      fs.writeFileSync(f.sc, '{}');
      const plans = [];
      const la = RE.createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: f.chome, catalog: CATALOG }, env: f.env,
        tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT },
        beforeLaunch: async (p) => { plans.push({ cwd: p.cwd }); return null; }, launch: async (p) => { plans.push(p); return { rc: 0, output: JSON.stringify(ans || {}) }; } });
      await la('Read only.', { label: `${kind}:K#1`, schema: SCH[kind], agentType: 'general-purpose' });
      const p = plans.find((q) => q.argv) || { argv: [], stdin: '', env: {} };
      ok(`TS3 S3 ${kind}: -C the task folder, no worktree, no sandbox_workspace_write key, the hook cwd the task folder`,
        after(p.argv, '-C') === f.tdir && !p.argv.join(' ').includes(f.wt) && !p.argv.some((a) => /sandbox_workspace_write/.test(a)) && plans[0].cwd === f.tdir, J(p.argv));
      ok(`TS3 T2/T4 ${kind}: the host section once at the end, without the commit client`,
        p.stdin.split(HEAD_MARK).length === 2 && p.stdin.indexOf('Read only.') < p.stdin.indexOf(HEAD_MARK) && !/commit-req/.test(p.stdin), J(p.stdin.slice(-400)));
      ok(`TS4 S5 ${kind}: no npm cache of the call`, !Object.keys(p.env || {}).some((k) => k.toLowerCase() === 'npm_config_cache' && /npm-cache$/.test(p.env[k])));
    }
    // the plan of a launcher (cfg.launch) for prog carries the npm cache of the call too
    const plans = [];
    const la = RE.createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: f.chome, catalog: CATALOG }, env: f.env,
      tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT },
      launch: async (p) => { plans.push(p); return { rc: 0, output: JSON.stringify(PROG_OK(f.tip(), [])) }; } });
    await la('p', { label: 'prog:K#7', schema: SCH.prog, agentType: 'general-purpose' });
    const pe = (plans[0] && plans[0].env) || {};
    const pk = Object.keys(pe).filter((k) => k.toLowerCase() === 'npm_config_cache');
    ok('TS4 S5 the plan of a launcher: npm_config_cache = <call folder>/npm-cache, the inherited one dropped',
      pk.length === 1 && plans[0] && pe.npm_config_cache === path.join(plans[0].callDir, 'npm-cache'), J(pk.map((k) => [k, pe[k]])));
  }

  // ---- TS5: commit.stateDir holding a root, or through a link into one
  {
    const f = fixture();
    const base = { host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: f.chome, catalog: CATALOG }, env: f.env,
      tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } } };
    const tryMk = (sd) => { try { RE.createAgent(Object.assign({}, base, { commit: { stateDir: sd, git: GIT } })); return null; } catch (e) { return e.message; } };
    let e = tryMk(f.d);
    ok('TS5 S4 a commit.stateDir that holds the worktree and the task folder: refused', !!e && /stateDir/.test(e) && /a folder a role writes/.test(e), String(e));
    const link = path.join(f.d, 'state-link');
    fs.symlinkSync(f.tdir, link);
    e = tryMk(path.join(link, 'st'));
    ok('TS5 S4 a commit.stateDir through a link into the task folder: refused by its real path', !!e && /a folder a role writes/.test(e), String(e));
  }

  // ---- TS6: corners of H1, H5, H6
  {
    const newId = () => crypto.randomBytes(16).toString('hex');
    const ask = async (f, setup) => {
      setup(f);
      const callDir = path.join(f.tdir, `c${crypto.randomBytes(3).toString('hex')}`);
      fs.mkdirSync(callDir, { recursive: true });
      const s = CS.openCommitService({ task: 'K', callId: path.basename(callDir), wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'), stateDir: f.state, git: GIT,
        codex: '/nonexistent/codex', network: false, tdir: f.tdir, userEnv: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp }, log: () => {} });
      fs.writeFileSync(path.join(f.wt, 'a.txt'), `change ${fixN}\n`);
      const id = newId();
      fs.writeFileSync(path.join(s.box, `.${id}.tmp`), JSON.stringify({ id, paths: ['a.txt'], message: 'm' }));
      fs.renameSync(path.join(s.box, `.${id}.tmp`), path.join(s.box, `${id}.json`));
      let a = null;
      for (let i = 0; i < 400 && !a; i++) { try { a = JSON.parse(fs.readFileSync(path.join(s.answers, `${id}.json`), 'utf8')); } catch { await sleep(25); } }
      await s.close();
      return a;
    };
    const OWNER = 'Changing the hooks of the check through the commit adapter is not supported; it needs a separate task of the coordinator.';
    const untracked = (a, dir) => a && a.status === 'refused' && a.why.includes(`no safe check path: the hooks folder ${dir} is not tracked in `)
      && a.why.includes(`inside the role's write roots; ${OWNER}`) && !/lies in the role's write places/.test(a.why);
    let f = fixture();
    let a = await ask(f, (q) => { fs.mkdirSync(path.join(q.wt, '.codex', 'hooks'), { recursive: true }); git(q.wt, ['config', 'core.hooksPath', '.codex/hooks']); });
    ok('TS6 H6 <wt>/.codex/hooks as the hooks folder: no write place of the role, committed as in 0.4.36', a && a.status === 'committed', J(a));
    const tmpHooks = fs.mkdtempSync('/tmp/codis-tc-hooks-');
    try {
      f = fixture();
      a = await ask(f, (q) => { git(q.wt, ['config', 'core.hooksPath', tmpHooks]); });
      ok('TS6 H5 a hooks folder under /tmp itself (not the TMPDIR of the role): refused as not tracked with the owner\'s text', untracked(a, fs.realpathSync(tmpHooks)), J(a));
      f = fixture({ files: { hk: { link: tmpHooks } } });
      a = await ask(f, (q) => { git(q.wt, ['config', 'core.hooksPath', 'hk']); });
      ok('TS6 H5 a tracked link in the worktree whose real path lies under /tmp: refused as not tracked by its real path', untracked(a, fs.realpathSync(tmpHooks)), J(a));
    } finally { fs.rmSync(tmpHooks, { recursive: true, force: true }); }
    const outside = path.join(BASE, 'outside-hooks');
    fs.mkdirSync(outside, { recursive: true });
    f = fixture({ files: { hk: { link: outside } } });
    a = await ask(f, (q) => { git(q.wt, ['config', 'core.hooksPath', 'hk']); });
    ok('TS6 H1 a tracked link in the worktree whose real path lies outside every place: committed (the place is the real path)', a && a.status === 'committed', J(a));
    f = fixture();
    a = await ask(f, (q) => { git(q.wt, ['config', 'core.hooksPath', 'not-yet']); });
    ok('TS6 H5 a hooks folder in the worktree that does not exist yet: refused as not tracked', untracked(a, path.join(fs.realpathSync(f.wt), 'not-yet')) && !fs.existsSync(path.join(f.wt, 'not-yet')), J(a));
  }

  // ---- TS7, TS8: the compare of the answer
  {
    const f = fixture();
    const ag = agentOf(f);
    let x = await call(f, ag, 'prog:K#1', SCH.prog, { commits: [{ path: 'a.txt', content: 'one\n' }, { path: 'b.txt', content: 'two\n' }], answer: PROG_OK('$C1:7', ['$C0:7', '$C1:7']) });
    ok('TS7 R1 head of exactly 7 hex digits and commits as 7-digit prefixes: ok, value unchanged', x.rec && x.rec.outcome === 'ok' && x.v && x.v.head === f.tip().slice(0, 7)
      && x.v.commits.length === 2 && x.v.commits.every((c) => c.length === 7), J(x.rec));
    x = await call(f, ag, 'prog:K#2', SCH.prog, { commits: [{ path: 'a.txt', content: 'three\n' }, { path: 'b.txt', content: 'four\n' }], answer: PROG_OK('$C0', ['$C0', '$C1']) });
    ok('TS7 R2 two commits in the call, head = the first one: invalid-result "is not the adapter\'s last commit"', x.v === null && x.rec && x.rec.outcome === 'invalid-result'
      && /is not the adapter's last commit/.test(x.rec.error) && x.rec.commit.commits.length === 2, J(x.rec));
    const t8 = f.tip();
    x = await call(f, ag, 'prog:K#3', SCH.prog, { commits: [{ path: 'a.txt', content: 'five\n' }], noAnswer: true });
    ok('TS8 R5 the CLI ends 0 without an answer: no-result, no compare, the summary with startTip kept', x.v === null && x.rec && x.rec.outcome === 'no-result'
      && !/adapter's last commit|does not match/.test(x.rec.error || '') && x.rec.commit && x.rec.commit.commits.length === 1 && x.rec.commit.startTip === t8, J(x.rec));
  }
  done();
})().catch((e) => { ok('the tester cases ran to their end', false, e && e.stack); done(); });
