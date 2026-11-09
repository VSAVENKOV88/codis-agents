#!/usr/bin/env node
'use strict';
// prog and test on the codex host (p-codex A2a-3a): the role adapter runs them on the real codex CLI with the commit
// channel. Here the CLI is a fake (a Node script named in codex.bin, started by spawnRole through the launch gate): it
// saves its argv, cwd, environment and stdin, asks the adapter for commits through scripts/commit-req.js, can move the
// branch behind the adapter, and writes the answer with the shas it got. No model is called.
// Cells of the analysis (p-codex-A2a-3/analyst.md, part a, and the coordinator's cells S9, R6, R3a):
//   S1/S2 argv and cwd of prog/test (workspace root = the worktree, the task folder a writable root, the network by the
//   kind), S3 the other kinds as before, S4 one function of the role's write places, S5 the npm cache of the call,
//   S6 prog/test on codex without cfg.commit, S7 CODEX_REFUSED, S8 the cwd the launch hook sees, S9 a hooks folder in
//   the role's write places, R1-R6 and R3a the answer against the adapter's commits, T1-T4 the host section of the
//   prompt, T5 the rule "Waiting".
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
const WAIT_STEP = path.join(ROOT, 'scripts', 'wait-step.js');
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
const PROG = schemaOf('PROG_SCHEMA'), TEST = schemaOf('TEST_SCHEMA'), REVIEW = schemaOf('REVIEW_SCHEMA');
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);

// ---- T5 and S7 need no git
{
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  const line = rules.split('\n').find((l) => /<!-- role:pauses -->/.test(l)) || '';
  ok('T5 rules "Waiting": 270 s is the longest single wait, not a required interval', /longest single wait, not a required interval/.test(line), line.slice(0, 200));
  ok('T5 rules "Waiting": a tool that returns earlier does not end the role (both hosts)', /returns earlier[^.]*does not end the role/.test(line), line.slice(0, 200));
}
ok('S7 CODEX_REFUSED: prog and test run on codex', RE.CODEX_REFUSED('prog', false) === '' && RE.CODEX_REFUSED('test', false) === '' && RE.CODEX_REFUSED('prog', true) === '',
  J([RE.CODEX_REFUSED('prog', false), RE.CODEX_REFUSED('test', false)]));
ok('S7 CODEX_REFUSED: pre without the flag and the service kinds keep their refusals',
  /preconditions run on the coordinator's host/.test(RE.CODEX_REFUSED('pre', false)) && RE.CODEX_REFUSED('pre', true) === ''
  && /service step "sha" on codex/.test(RE.CODEX_REFUSED('sha', false)) && RE.CODEX_REFUSED('review', false) === '' && RE.CODEX_REFUSED('analyst', false) === '');

if (process.platform !== 'darwin' || !has('git')) {
  skip('prog/test on codex with the commit channel', 'needs macOS (the box is read with O_NOFOLLOW_ANY) and git');
  done();
}
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-roles-')));
process.on('exit', () => { fs.rmSync(BASE, { recursive: true, force: true }); });
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fake codex: argv, cwd, env and stdin into FAKE_DUMP; the commits of the scenario through the client; the
// shell line of the scenario; the answer with $C<n> (the sha of the n-th commit), $START (HEAD at the start, in its cwd),
// a ":<k>" tail shortens it; then thread.started, turn.completed and exit 0 (or sc.rc without a turn).
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
  if (sc.sh) spawnSync('/bin/sh', ['-c', sc.sh], { stdio: 'ignore', env: process.env });
  const sub = (x) => {
    if (Array.isArray(x)) return x.map(sub);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = sub(x[k]); return o; }
    const m = typeof x === 'string' ? /^\\$(C(\\d+)|START)(?::(\\d+))?$/.exec(x) : null;
    if (!m) return x;
    const v = m[1] === 'START' ? start : shas[+m[2]];
    return m[3] && v ? v.slice(0, +m[3]) : v;
  };
  if (sc.rc) process.exit(sc.rc);
  const o = argv[argv.indexOf('-o') + 1];
  fs.writeFileSync(o, JSON.stringify(sub(sc.answer)));
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
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  if (x.main) { git(f.repo, ['checkout', '-q', '-b', 'task']); f.wt = f.repo; } else {
    f.wt = path.join(d, 'wt');
    git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  }
  f.env = { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp, FAKE_SC: f.sc, FAKE_DUMP: f.dump, CLIENT,
    npm_config_cache: '/inherited/npm', NPM_CONFIG_CACHE: '/inherited/NPM' };
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  return f;
}
const recsOf = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function agentOf(f, over) {
  const seen = { plans: [] };
  const cfg = Object.assign({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {},
    codex: { home: f.chome, bin: FAKE, catalog: CATALOG }, env: f.env,
    tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT },
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
const REVIEW_OK = { verdict: 'done', docsOnly: false, fixBehaviourUnchanged: null, summary: 's' };

(async () => {
  const rp = (p) => fs.realpathSync(p);

  // ---- S1, S5, T1-T3, R1: prog through spawnRole (no cfg.launch), one commit, a short head
  {
    const f = fixture();
    const ag = agentOf(f);
    const t0 = f.tip();
    const x = await call(f, ag, 'prog:K#1', PROG, { commits: [{ path: 'a.txt', content: 'red guard\n', message: 'red guard' }], answer: PROG_OK('$C0:8', ['$C0']) });
    const d = x.dump || { argv: [], env: {}, stdin: '', cwd: '/' };
    const c = cOf(d.argv);
    ok('S1 prog on codex with cfg.commit and the real CLI: not refused, the role ran and committed', x.rec && x.rec.outcome === 'ok' && !!x.dump && f.tip() !== t0, J(x.rec));
    ok('S1 argv: -c project_doc_max_bytes=0 right after the effort, then -s workspace-write', d.argv.indexOf('project_doc_max_bytes=0') === d.argv.indexOf('model_reasoning_effort=high') + 2
      && after(d.argv, '-s') === 'workspace-write' && d.argv.indexOf('-s') > d.argv.indexOf('project_doc_max_bytes=0'), J(d.argv));
    ok('S1 argv: the task folder is the one writable root, network off, -C the worktree (real paths)',
      c.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([rp(f.tdir)])}`) && c.includes('sandbox_workspace_write.network_access=false')
      && after(d.argv, '-C') === rp(f.wt) && d.argv.indexOf('-C') > d.argv.indexOf('-s'), J(d.argv));
    ok('S1 argv: --skip-git-repo-check and stdin last; no --disable unified_exec, no --add-dir', d.argv.slice(-2).join(' ') === '--skip-git-repo-check -'
      && !d.argv.includes('--disable') && !d.argv.includes('unified_exec') && !d.argv.includes('--add-dir'), J(d.argv));
    ok('S1 cwd of the process = the real path of the worktree', d.cwd && rp(d.cwd) === rp(f.wt), d.cwd);
    ok('S8 the launch hook sees cwd = the worktree for prog', ag.seen.plans[0] && ag.seen.plans[0].cwd === rp(f.wt), J(ag.seen.plans[0]));
    const cache = x.rec && x.rec.callDir ? path.join(x.rec.callDir, 'npm-cache') : 'none';
    const npmKeys = Object.keys(d.env).filter((k) => k.toLowerCase() === 'npm_config_cache');
    ok('S5 the role gets npm_config_cache = <call folder>/npm-cache; the inherited npm_config_cache and NPM_CONFIG_CACHE do not reach it',
      npmKeys.length === 1 && d.env.npm_config_cache === cache, J(npmKeys.map((k) => [k, d.env[k]])));
    ok('R1 a short head (8) of the adapter\'s last commit and commits = the summary: ok, the value is unchanged', x.v && x.v.head === f.tip().slice(0, 8)
      && J(x.v.commits) === J([f.tip()]), J(x.v));
    ok('R1 the record carries startTip (the tip at the start of the call) and the commit', x.rec && x.rec.commit && x.rec.commit.startTip === t0
      && x.rec.commit.commits.length === 1 && x.rec.commit.commits[0].sha === f.tip(), J(x.rec && x.rec.commit));
    const s = d.stdin;
    const heads = s.split('\n').filter((l) => /^## On this host \(codex\)/.test(l)).length;
    const sect = s.slice(s.indexOf('## On this host (codex)'));
    ok('T4 the host section ends the prompt of prog exactly once, after the prompt', heads === 1 && s.indexOf('Do the task.') < s.indexOf('## On this host (codex)') && s.trimEnd().endsWith(sect.trimEnd()), s.slice(-300));
    ok('T1 the section names the commit client of the adapter and refuses git add/commit', sect.includes(`node ${CLIENT}`) && /git add/.test(sect) && /git commit/.test(sect), sect);
    ok('T1 the section: the red guard committed before the fix, the fix committed before the mutations, restore by git show HEAD:<path> > <path>',
      /red guard/.test(sect) && /mutation/.test(sect) && sect.includes('git show HEAD:<path> > <path>'), sect);
    ok('T1 the section: head is the last sha the adapter gave; commits only the shas of this call', /head/.test(sect) && /only the shas[^.]*this call/.test(sect), sect);
    ok('T2 the section: wait-step.js start then wait --max 25 (the shell tool of codex returns "still running" after about 30 s, D2 G7), 25 s the longest single wait, an early return is not the end, a turn without a tool call ends the role',
      sect.includes(`node ${WAIT_STEP} start`) && /--max 25\b/.test(sect) && !sect.includes('--max 270') && /longest single wait/.test(sect) && /returns earlier[^.]*not the end/.test(sect)
      && /without a tool call ends your role/.test(sect) && /run_in_background/.test(sect) && /Monitor/.test(sect), sect);
    ok('T3 the section: 77/72/78 of heavy.sh, medium.sh, guards-all.sh -> environment (A2b); an acceptance the sandbox cannot run -> environment, never green; a merge of the arc -> blocked',
      /heavy\.sh/.test(sect) && /medium\.sh/.test(sect) && /guards-all\.sh/.test(sect) && /77/.test(sect) && /72/.test(sect) && /78/.test(sect) && /A2b/.test(sect)
      && /never green/.test(sect) && /blocked/.test(sect) && /merge/.test(sect), sect);
    ok('T1-T3 the prompt saved in the call folder is the stdin of the CLI', x.rec && x.rec.callDir && fs.readFileSync(path.join(x.rec.callDir, 'prompt.txt'), 'utf8') === s);

    // R3a: the same task, a second call that names the commit of the first one in commits; R1 without commits: head = start
    const first = f.tip();
    let y = await call(f, ag, 'prog:K#2', PROG, { answer: PROG_OK('$START', [first]) });
    ok('R3a commits names a commit of an earlier call (an ancestor of the start tip): ok with a note', y.rec && y.rec.outcome === 'ok' && y.v
      && (y.rec.notes || []).some((n) => n.includes(first) && /earlier call/.test(n)), J(y.rec));
    ok('R1 no commit in the call, head = the tip at the start: ok', y.v && y.v.head === first);
    // R2: head is the old tip after a commit; a head shorter than 7; a foreign sha
    y = await call(f, ag, 'prog:K#3', PROG, { commits: [{ path: 'b.txt', content: 'fix\n' }], answer: PROG_OK('$START', ['$C0']) });
    ok('R2 head = the tip at the start although the adapter committed: invalid-result "is not the adapter\'s last commit", agent() null',
      y.v === null && y.rec.outcome === 'invalid-result' && /head \S+ is not the adapter's last commit/.test(y.rec.error) && y.rec.commit.commits.length === 1, J(y.rec));
    y = await call(f, ag, 'prog:K#4', PROG, { answer: PROG_OK('$START:6', []) });
    ok('R2 a head of 6 hex digits: invalid-result', y.v === null && y.rec.outcome === 'invalid-result' && /head/.test(y.rec.error), J(y.rec));
    y = await call(f, ag, 'prog:K#5', PROG, { answer: PROG_OK('0123456789abcdef0123456789abcdef01234567', []) });
    ok('R2 a foreign full sha as head: invalid-result', y.v === null && y.rec.outcome === 'invalid-result', J(y.rec));
    // R3: a sha in commits the branch does not know; the branch moved behind the adapter before the end of the call
    y = await call(f, ag, 'prog:K#6', PROG, { commits: [{ path: 'a.txt', content: 'two\n' }], answer: PROG_OK('$C0', ['$C0', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']) });
    ok('R3 commits names a sha the adapter did not commit and that is no ancestor of the start: invalid-result with that sha, the value not replaced',
      y.v === null && y.rec.outcome === 'invalid-result' && /deadbeef/.test(y.rec.error), J(y.rec));
    y = await call(f, ag, 'prog:K#7', PROG, { commits: [{ path: 'b.txt', content: 'three\n' }],
      sh: `'${GIT}' -c core.hooksPath=/dev/null -C '${f.wt}' commit -q --allow-empty -m outside`, answer: PROG_OK('$C0', ['$C0']) });
    ok('R3 the branch moved behind the adapter before the end of the call: invalid-result naming the tip at the end',
      y.v === null && y.rec.outcome === 'invalid-result' && y.rec.error.includes(f.tip()) && /moved/.test(y.rec.error), J(y.rec));
    // R5: the role crashed after a commit: the outcome stays, no compare, the summary is kept
    const t5 = f.tip();
    y = await call(f, ag, 'prog:K#8', PROG, { commits: [{ path: 'a.txt', content: 'four\n' }], rc: 3 });
    ok('R5 an outcome other than ok (crashed): as before, no compare, the record keeps the commit summary',
      y.v === null && y.rec.outcome === 'crashed' && y.rec.commit && y.rec.commit.commits.length === 1 && y.rec.commit.startTip === t5 && !/adapter's last commit/.test(y.rec.error), J(y.rec));
  }

  // ---- S2, R4: test - the network on, head checked, no commits field
  {
    const f = fixture();
    const ag = agentOf(f);
    let x = await call(f, ag, 'test:K#1', TEST, { commits: [{ path: 'b.txt', content: 'tester guard\n' }], answer: TEST_OK('$C0') });
    const d = x.dump || { argv: [], stdin: '', cwd: '/', env: {} };
    ok('S2 test: the same argv with network_access=true, -C the worktree', cOf(d.argv).includes('sandbox_workspace_write.network_access=true')
      && cOf(d.argv).includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([rp(f.tdir)])}`) && after(d.argv, '-C') === rp(f.wt) && rp(d.cwd) === rp(f.wt), J(d.argv));
    ok('R4 test with the adapter\'s last commit as head: ok', x.rec && x.rec.outcome === 'ok' && x.v && x.v.head === f.tip(), J(x.rec));
    const sect = d.stdin.slice(d.stdin.indexOf('## On this host (codex)'));
    ok('T1 the tester\'s section names the commit client too', sect.includes(`node ${CLIENT}`), sect.slice(0, 300));
    x = await call(f, ag, 'test:K#2', TEST, { commits: [{ path: 'b.txt', content: 'second\n' }], answer: TEST_OK('$START') });
    ok('R4 test with the old tip as head after a commit: invalid-result', x.v === null && x.rec.outcome === 'invalid-result', J(x.rec));
    // S3, T2, T4: review keeps the argv of 0.4.36, gets the section without the commit client
    x = await call(f, ag, 'review:K#1', REVIEW, { answer: REVIEW_OK });
    const r = x.dump || { argv: [], stdin: '', cwd: '/', env: {} };
    ok('S3 review: -C the task folder, no worktree in argv, cwd the task folder, no writable roots and no network key',
      after(r.argv, '-C') === f.tdir && !r.argv.join(' ').includes(f.wt) && rp(r.cwd) === rp(f.tdir) && !r.argv.some((a) => /sandbox_workspace_write/.test(a)), J(r.argv));
    ok('S8 the launch hook sees cwd = the task folder for review', ag.seen.plans[ag.seen.plans.length - 1].cwd === f.tdir, J(ag.seen.plans[ag.seen.plans.length - 1]));
    const rs = r.stdin.slice(r.stdin.indexOf('## On this host (codex)'));
    ok('T2/T4 review gets the host section once, with wait-step.js and without the commit client', r.stdin.split('## On this host (codex)').length === 2
      && rs.includes(`node ${WAIT_STEP} start`) && !rs.includes(CLIENT) && !/commit-req/.test(rs), rs.slice(0, 400));
    ok('S5 review: no npm_config_cache of the call (only prog/test)', !Object.keys(r.env || {}).some((k) => k.toLowerCase() === 'npm_config_cache' && /npm-cache$/.test(r.env[k])), J(r.env && r.env.npm_config_cache));
  }

  // ---- R6: the commit service is broken (the journal held by a live adapter; an undetermined step): the adapter
  // takes the start tip itself
  {
    const f = fixture();
    fs.mkdirSync(path.join(f.state, 'K'), { recursive: true });
    fs.writeFileSync(path.join(f.state, 'K', 'journal.lock'), JSON.stringify({ pid: process.pid, token: 'x', call: 'other' }) + '\n');
    const ag = agentOf(f);
    const t0 = f.tip();
    let x = await call(f, ag, 'prog:K#1', PROG, { answer: PROG_OK('$START', []) });
    ok('R6 journal held by another adapter: startTip from the adapter\'s own rev-parse, head = it, commits [] -> ok',
      x.rec && x.rec.outcome === 'ok' && x.rec.commit && x.rec.commit.startTip === t0 && x.v && x.v.head === t0, J(x.rec));
    x = await call(f, ag, 'prog:K#2', PROG, { answer: PROG_OK('0123456', []) });
    ok('R6 journal held: a head that is not the start tip -> invalid-result', x.v === null && x.rec.outcome === 'invalid-result', J(x.rec));
    fs.rmSync(path.join(f.state, 'K', 'journal.lock'));
    const und = { v: CS.JOURNAL_VERSION, n: 1, ts: new Date().toISOString(), call: 'old', ev: 'undetermined', id: crypto.randomBytes(16).toString('hex'),
      sha: 'a'.repeat(40), old: 'b'.repeat(40), tip: 'c'.repeat(40) };
    fs.writeFileSync(path.join(f.state, 'K', 'commits.jsonl'), JSON.stringify(und) + '\n');
    x = await call(f, ag, 'prog:K#3', PROG, { answer: PROG_OK('$START', []) });
    ok('R6 an undetermined step: startTip by the adapter, ok', x.rec && x.rec.outcome === 'ok' && x.rec.commit.startTip === t0, J(x.rec));
    // the start tip cannot be read (the worktree is no repository): commits [] -> ok with a note, commits [x] -> invalid
    const g = { d: path.join(BASE, 'nogit'), tdir: path.join(BASE, 'nogit', 'tdir'), wt: path.join(BASE, 'nogit', 'wt') };
    for (const k of ['tdir', 'wt']) fs.mkdirSync(g[k], { recursive: true });
    const fg = Object.assign({}, f, g, { sc: path.join(g.d, 'sc.json'), dump: path.join(g.d, 'dump.json') });
    fg.env = Object.assign({}, f.env, { FAKE_SC: fg.sc, FAKE_DUMP: fg.dump });
    const ag2 = agentOf(fg, { tasks: { K: { dir: g.tdir, wt: g.wt, branch: 'task' } }, env: fg.env, commit: { stateDir: path.join(g.d, 'state'), git: GIT } });
    x = await call(fg, ag2, 'prog:K#1', PROG, { answer: PROG_OK('0000000', []) });
    ok('R6 start tip unknown, commits []: ok with the note "start tip unknown"', x.rec && x.rec.outcome === 'ok' && (x.rec.notes || []).some((n) => /start tip unknown/.test(n)), J(x.rec));
    x = await call(fg, ag2, 'prog:K#2', PROG, { answer: PROG_OK('0000000', ['abcdef1']) });
    ok('R6 start tip unknown, commits named: invalid-result with that reason', x.v === null && x.rec.outcome === 'invalid-result' && /start tip unknown/.test(x.rec.error), J(x.rec));
  }

  // ---- S6, S8 with cfg.launch, S1 on the plan of a launcher
  {
    const f = fixture();
    const plans = [];
    let gate = 0;
    const mk = (over) => RE.createAgent(Object.assign({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {},
      codex: { home: f.chome, catalog: CATALOG }, env: f.env, tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } },
      beforeLaunch: async () => { gate++; return null; }, launch: async (p) => { plans.push(p); return { rc: 0, output: JSON.stringify(PROG_OK(null, [])) }; } }, over || {}));
    const ag = mk();
    for (const [label, who] of [['prog:K#1', 'programmer'], ['test:K#1', 'tester']]) {
      const v = await ag('p', { label, schema: label.startsWith('prog') ? PROG : TEST, agentType: 'general-purpose' });
      const rec = recsOf(f.tdir).pop();
      ok(`S6 ${label} on codex without cfg.commit: refused "the ${who} on codex needs the commit channel (cfg.commit)", no hook check, no launch`,
        v === null && rec.outcome === 'refused' && rec.error === `the ${who} on codex needs the commit channel (cfg.commit)` && gate === 0 && !plans.length, J(rec));
    }
    const ag2 = mk({ commit: { stateDir: f.state, git: GIT } });
    await ag2('p', { label: 'prog:K#2', schema: PROG, agentType: 'general-purpose' });
    const p = plans[0] || { argv: [] };
    ok('S1 the plan of a launcher has the same argv and cwd: -C the worktree, the task folder writable, network off',
      after(p.argv, '-C') === rp(f.wt) && p.cwd === rp(f.wt) && cOf(p.argv).includes('sandbox_workspace_write.network_access=false')
      && cOf(p.argv).includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([rp(f.tdir)])}`), J(p.argv));
    // T4: the claude host - stdin is exactly the prompt
    const cl = RE.createAgent({ host: 'claude', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, tasks: { K: { dir: f.tdir, wt: f.wt } },
      launch: async (q) => { plans.push(q); return { rc: 0, output: REVIEW_OK }; } });
    for (const label of ['prog:K#9', 'review:K#9']) {
      await cl('Exactly this.', { label, schema: label.startsWith('prog') ? PROG : REVIEW, agentType: 'general-purpose' });
      ok(`T4 claude ${label}: stdin is the prompt as it was, no host section`, plans[plans.length - 1].stdin === 'Exactly this.', J(plans[plans.length - 1].stdin));
    }
  }

  // ---- S4: one function of the role's write places for the state folder
  {
    const f = fixture();
    const base = { host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: f.chome, catalog: CATALOG }, env: f.env,
      tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } } };
    const tryMk = (sd) => { try { RE.createAgent(Object.assign({}, base, { commit: { stateDir: sd, git: GIT } })); return null; } catch (e) { return e.message; } };
    for (const [name, sd] of [['/tmp', '/tmp/codis-roles-st'], ['the TMPDIR of the role', path.join(f.rtmp, 'st')], ['the worktree', path.join(f.wt, 'st')], ['the task folder', path.join(f.tdir, 'st')]]) {
      const e = tryMk(sd);
      ok(`S4 commit.stateDir under ${name}: createAgent refused with the root`, !!e && /stateDir/.test(e) && /a folder a role writes/.test(e), String(e));
    }
    ok('S4 commit.stateDir outside every place of the role: accepted', tryMk(f.state) === null, String(tryMk(f.state)));
  }

  // ---- S9: a hooks folder in the role's write places refuses every request before any hook
  {
    const newId = () => crypto.randomBytes(16).toString('hex');
    const svcOf = (f) => {
      const callDir = path.join(f.tdir, `c${crypto.randomBytes(3).toString('hex')}`);
      fs.mkdirSync(callDir, { recursive: true });
      return CS.openCommitService({ task: 'K', callId: path.basename(callDir), wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'), stateDir: f.state, git: GIT,
        codex: '/nonexistent/codex', network: false, tdir: f.tdir, userEnv: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp }, log: () => {} });
    };
    const ask = async (f, setup) => {
      setup(f);
      const s = svcOf(f);
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
    const hook = (dir, mark) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'pre-commit'), `#!/bin/sh\necho ran > '${mark}'\n`); fs.chmodSync(path.join(dir, 'pre-commit'), 0o755); };
    let f = fixture();
    const mark = path.join(f.d, 'hook-ran');
    let a = await ask(f, (q) => { hook(path.join(q.wt, '.githooks'), mark); git(q.wt, ['config', 'core.hooksPath', '.githooks']); });
    ok('S9 a relative core.hooksPath inside the worktree with a hook: refused with the owner\'s text and the folder, the hook never ran',
      a && a.status === 'refused' && a.why.includes(OWNER) && a.why.includes(path.join(rp(f.wt), '.githooks')) && !fs.existsSync(mark), J(a));
    f = fixture();
    a = await ask(f, (q) => { fs.mkdirSync(path.join(q.wt, '.githooks')); git(q.wt, ['config', 'core.hooksPath', '.githooks']); });
    ok('S9 the same folder without any hook (a removed hook): refused all the same', a && a.status === 'refused' && a.why.includes(OWNER), J(a));
    f = fixture();
    a = await ask(f, (q) => { fs.mkdirSync(path.join(q.rtmp, 'hk')); git(q.wt, ['config', 'core.hooksPath', path.join(q.rtmp, 'hk')]); });
    ok('S9 a hooks folder under the role\'s TMPDIR: refused', a && a.status === 'refused' && a.why.includes(OWNER), J(a));
    f = fixture();
    a = await ask(f, (q) => { fs.mkdirSync(path.join(q.tdir, 'hk')); git(q.wt, ['config', 'core.hooksPath', path.join(q.tdir, 'hk')]); });
    ok('S9 a hooks folder under the task folder: refused', a && a.status === 'refused' && a.why.includes(OWNER), J(a));
    f = fixture();
    a = await ask(f, (q) => { fs.mkdirSync(path.join(q.d, 'outside-hooks')); git(q.wt, ['config', 'core.hooksPath', path.join(q.d, 'outside-hooks')]); });
    ok('S9 a hooks folder outside the role\'s places (no hook): committed as in 0.4.36', a && a.status === 'committed', J(a));
    f = fixture();
    a = await ask(f, () => {});
    ok('S9 a linked worktree with <common dir>/hooks outside it: committed as in 0.4.36', a && a.status === 'committed', J(a));
    f = fixture({ main: true });
    a = await ask(f, () => {});
    ok('S9 the main checkout as the worktree: <wt>/.git/hooks is no write place of the role, committed as in 0.4.36', a && a.status === 'committed', J(a));
  }

  // the tester cells (links to the worktree and the task folder, the reading kinds, the npm cache by any case and in a
  // launcher's plan, a stateDir holding a root, S9 corners, head of 7 digits, no answer): a child with its own tally, so
  // README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'role-exec-codex-roles-tester-cases.js')], { encoding: 'utf8', timeout: 240000 });
    ok('the tester cells of prog/test on codex (tests/role-exec-codex-roles-tester-cases.js) pass', tc.status === 0, `exit ${tc.status} ${tc.signal || ''} ${(tc.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n').slice(-1500)} ${(tc.stderr || '').slice(-500)}`);
  }
  done();
})().catch((e) => { ok('the test ran to its end', false, e && e.stack); done(); });
