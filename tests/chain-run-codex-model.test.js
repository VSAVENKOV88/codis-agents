#!/usr/bin/env node
'use strict';
// The model and effort of the roles of a conductor run on codex (p-codex-v167, cells M1-M6 of its brief):
// chain-run.js start --host codex --codex-model <slug> --codex-effort <level> gives the adapter cfg.codex.models (every
// model alias of the config and "default" -> slug) and cfg.codex.effort (level). The conductor runs as a process with the
// fake codex of tests/fixtures/chain-run/bin (its catalog: gpt-6-astra low/high, gpt-6-luna low/medium); no model is called.
//   M1 with the flags every role call runs with that slug and effort: argv -m / model_reasoning_effort, calls.jsonl;
//   M2 a slug outside the catalog or an effort the model does not support stops the task before any role (the host check);
//   M3 without the flags the defaults of the adapter: gpt-6-astra, effort high (pre keeps the low effort it names);
//   M4 --host claude with either flag: usage, exit 64, no run folder;
//   M5 run.json records the model and effort of the roles, status shows them;
//   M6 the README, the role-chain skill (On Codex) and the usage of chain-run.js name both flags.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const CRM = require(CR);
const { MODEL_ALIASES } = require(path.join(ROOT, 'scripts', 'config.js'));
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 'role-chain', 'SKILL.md'), 'utf8');
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
const K_PRE = 'gp:blockingQuestions,ok,problems', K_PROG = keyOf(schemaOf('PROG_SCHEMA')), K_TEST = keyOf(schemaOf('TEST_SCHEMA')), K_REVIEW = keyOf(schemaOf('REVIEW_SCHEMA'));

// ---- M6: the documents and the usage, no process needed
{
  const both = (t) => /--codex-model <slug>/.test(t) && /--codex-effort <level>/.test(t);
  ok('M6 README names chain-run.js start --codex-model <slug> --codex-effort <level>', both(README));
  const onCodex = (/### On Codex[\s\S]*?(?=\n### |\n## |$)/.exec(SKILL) || [''])[0];
  ok('M6 the role-chain skill (On Codex) names both flags', both(onCodex));
  const u = spawnSync(process.execPath, [CR], { encoding: 'utf8' });
  ok('M6 the usage of chain-run.js names both flags', u.status === 64 && both(u.stderr), u.stderr);
}

if (process.platform !== 'darwin' || !has('git')) {
  skip('the model of the roles under the conductor', 'needs macOS (the commit box is read with O_NOFOLLOW_ANY) and git');
  done();
}

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-model-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RTMP = path.join(W, 'rtmp'), NOID = path.join(W, 'home-noid');
for (const d of [RTMP, NOID, REPO]) fs.mkdirSync(d, { recursive: true });
const CFG = path.join(W, 'cfg.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'],
  commitAuthor: { name: 'codis-agents', email: 'agents@example.com' } }));
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
const PROG = { status: 'ready', changedFiles: ['c.js'], commits: ['$C0'], head: '$C0', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const CHAIN = { [K_PRE]: [{ ok: true, problems: [], blockingQuestions: [] }], [K_PROG]: [{ $commits: [{ path: 'c.js', content: '2\n', message: 'the fix' }], then: PROG }],
  [K_TEST]: [{ verdict: 'green', head: '$HEAD', summary: '' }], [K_REVIEW]: [{ verdict: 'done', docsOnly: false, summary: '' }] };

let n = 0;
const groups = new Set();
const cr = (args, env) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || process.env, timeout: 180000 });
const traceOf = (d) => { try { return fs.readFileSync(path.join(d, 'trace.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const argOf = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const effortOf = (argv) => { const c = argv.find((x) => /^model_reasoning_effort=/.test(x)); return c ? c.split('=')[1] : null; };
// start on codex with a trusted hook in a fresh run home and the given flags; then the end of the run (status --wait).
function codexRun(key, flags, host) {
  const fd = path.join(W, `fake${++n}`);
  fs.mkdirSync(fd);
  fs.writeFileSync(path.join(fd, 'answers.json'), JSON.stringify(CHAIN));
  const home = path.join(W, `codex-home-${n}`);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
  const tf = path.join(W, `tasks-${n}.json`);
  fs.writeFileSync(tf, JSON.stringify([task(key)]));
  const env = Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: fd, TMPDIR: RTMP, HOME: NOID, GIT_CONFIG_NOSYSTEM: '1' });
  const p = cr(['start', '--host', host || 'codex'].concat(host === 'claude' ? [] : ['--codex-home', home], ['--tasks', tf, '--owner', OWNER, '--config', CFG], flags), env);
  let j = null;
  try { j = JSON.parse(p.stdout); groups.add(j.pid); } catch { /* below */ }
  let st = null;
  if (j) { const s = cr(['status', j.runDir, '--config', CFG, '--wait', '170'], env); try { st = JSON.parse(s.stdout); } catch { /* below */ } }
  const runJson = (() => { try { return j && JSON.parse(fs.readFileSync(path.join(j.runDir, 'run.json'), 'utf8')); } catch { return null; } })();
  const execs = traceOf(fd).filter((e) => e.ev === 'start');
  const calls = (() => { try { return fs.readFileSync(path.join(SHARED, key, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  return { p, j, st, r: st && st.results && st.results[0], execs, calls, runJson, out: p.stdout + p.stderr };
}

try {
  // ---- unit: the adapter config of the conductor
  {
    const args = { config: { sharedDir: SHARED, worktreeRoot: WTR }, tasks: [task('u1')] };
    const home = path.join(W, 'unit-home');
    fs.mkdirSync(home);
    const cx = CRM.adapterCfg('codex', args, { codexHome: home, codexModel: 'gpt-6-luna', codexEffort: 'low' }, path.join(SHARED, 'runs', 'R1'), () => {}, 'R1');
    const want = MODEL_ALIASES.concat(['default']).sort();
    ok('M1 adapterCfg: cfg.codex.models maps every model alias of the config and default to the slug',
      cx.codex && cx.codex.models && Object.keys(cx.codex.models).sort().join(',') === want.join(',') && Object.values(cx.codex.models).every((v) => v === 'gpt-6-luna'), J(cx.codex));
    ok('M1 adapterCfg: cfg.codex.effort is the level', cx.codex && cx.codex.effort === 'low', J(cx.codex));
    const cd = CRM.adapterCfg('codex', args, { codexHome: home }, path.join(SHARED, 'runs', 'R1'), () => {}, 'R1');
    ok('M3 adapterCfg without the flags: no models and no effort, the adapter keeps its defaults', cd.codex && cd.codex.models === undefined && cd.codex.effort === undefined, J(cd.codex));
  }

  // ---- M4: --host claude with a codex flag
  for (const flag of [['--codex-model', 'gpt-6-luna'], ['--codex-effort', 'low']]) {
    const before = fs.existsSync(path.join(SHARED, 'runs')) ? fs.readdirSync(path.join(SHARED, 'runs')).length : 0;
    const c = codexRun('c4', flag, 'claude');
    const after = fs.existsSync(path.join(SHARED, 'runs')) ? fs.readdirSync(path.join(SHARED, 'runs')).length : 0;
    ok(`M4 --host claude ${flag[0]}: exit 64 naming the flag, no run folder`, c.p.status === 64 && c.p.stderr.includes(flag[0]) && /only with --host codex/.test(c.p.stderr) && before === after, `${c.p.status} ${c.out}`);
  }

  // ---- M1, M5: the run with --codex-model gpt-6-luna --codex-effort low
  {
    const c = codexRun('m1', ['--codex-model', 'gpt-6-luna', '--codex-effort', 'low']);
    ok('M1 the chain ran to the end: pre, prog, test, review; done', c.r && c.r.status === 'done' && c.execs.map((e) => e.key).join('>') === [K_PRE, K_PROG, K_TEST, K_REVIEW].join('>'), J(c.r) + ' ' + c.out);
    ok('M1 every codex exec ran with -m gpt-6-luna and model_reasoning_effort=low', c.execs.length === 4 && c.execs.every((e) => argOf(e.argv, '-m') === 'gpt-6-luna' && effortOf(e.argv) === 'low'),
      J(c.execs.map((e) => [argOf(e.argv, '-m'), effortOf(e.argv)])));
    ok('M1 calls.jsonl: every call model gpt-6-luna, effort low, ok', c.calls.length === 4 && c.calls.every((x) => x.model === 'gpt-6-luna' && x.effort === 'low' && x.outcome === 'ok'),
      J(c.calls.map((x) => [x.label, x.model, x.effort, x.outcome])));
    ok('M5 run.json records codexModel gpt-6-luna and codexEffort low', c.runJson && c.runJson.codexModel === 'gpt-6-luna' && c.runJson.codexEffort === 'low', J(c.runJson));
    const s = c.j ? cr(['status', c.j.runDir, '--config', CFG]) : null;
    let sj = null;
    try { sj = JSON.parse(s.stdout); } catch { /* below */ }
    ok('M5 status shows codexModel and codexEffort of the run', sj && sj.codexModel === 'gpt-6-luna' && sj.codexEffort === 'low', s && s.stdout);
  }

  // ---- M3, M5: the run without the flags keeps the defaults of the adapter
  {
    const c = codexRun('m3', []);
    ok('M3 without the flags: done', c.r && c.r.status === 'done', J(c.r) + ' ' + c.out);
    ok('M3 without the flags: every exec -m gpt-6-astra; effort high, pre the low it names',
      c.execs.length === 4 && c.execs.every((e) => argOf(e.argv, '-m') === 'gpt-6-astra' && effortOf(e.argv) === (e.key === K_PRE ? 'low' : 'high')),
      J(c.execs.map((e) => [argOf(e.argv, '-m'), effortOf(e.argv)])));
    ok('M5 without the flags run.json records the defaults: gpt-6-astra, high', c.runJson && c.runJson.codexModel === 'gpt-6-astra' && c.runJson.codexEffort === 'high', J(c.runJson));
  }

  // ---- M2: a slug outside the catalog, an effort the model does not support: stopped before any role
  for (const [name, flags, re] of [
    ['a slug outside the catalog', ['--codex-model', 'gpt-9'], /model gpt-9 is not in the codex catalog/],
    ['an effort luna does not support', ['--codex-model', 'gpt-6-luna', '--codex-effort', 'high'], /effort high is not supported by gpt-6-luna/],
    ['an effort the default model does not support', ['--codex-effort', 'ultra'], /effort ultra is not supported by gpt-6-astra/],
  ]) {
    const c = codexRun(`m2${n}`, flags);
    ok(`M2 ${name}: the task stopped by the host check, no role ran`, c.r && c.r.status === 'stopped' && /host check failed/.test(c.r.why || '') && re.test(c.r.why || '') && c.execs.length === 0,
      J(c.r) + ' ' + c.execs.length + ' ' + c.out);
  }
} catch (e) { ok(`no exception: ${e.stack}`, false); } finally {
  for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(W, { recursive: true, force: true });
  done();
}
