#!/usr/bin/env node
'use strict';
// The heavy channel of a codex role when the workflow runs the full guard run (p-codex-fullrun-a2, cells A0, A1, A2',
// A3', F26e, F26d, D1 of the analysis and the Closure of its third check): the conductor marks cfg.heavy.fullByWorkflow
// exactly when workflows/role-chain.js runs the full run as its own wait step (FULL: no guardSubsetCommand after trim,
// conductorFullRun not false); under the mark the adapter refuses `heavy-req.js --kind full` and an argv with
// guards-all.sh before the queue, without "environment:" (that prefix would stop the task) and without pointing to
// --kind full, and the host section of prog and test does not offer --kind full. Without the mark nothing changes.
// No slot, no guards-all.sh and no model run here: the refusals come before the queue; the chain runs with a fake
// launcher and a fake exec (scripts/chain-run.js runScript).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const CR = require(path.join(S, 'chain-run.js'));
const RX = require(path.join(S, 'role-exec.js'));
const HS = require(path.join(S, 'heavy-service.js'));
const CLIENT = path.join(S, 'heavy-req.js');

for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-fbw-')));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } });
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const id32 = () => crypto.randomBytes(16).toString('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// The phrases the role sees under the mark (the refusal of the adapter and the host section).
const WF = /the workflow runs the full guard run on your HEAD/;

// ---- A0: the mark of the conductor, by the same rule as FULL of role-chain.js
const CFGP = '/p/.claude/codis-agents.json';
const base = { sharedDir: path.join(T, 's'), worktreeRoot: T, configPath: CFGP };
const TABLE = [
  ['no guardSubsetCommand, conductorFullRun absent', {}, true],
  ['conductorFullRun true', { conductorFullRun: true }, true],
  ['conductorFullRun false', { conductorFullRun: false }, false],
  ['guardSubsetCommand set', { guardSubsetCommand: 'true {wt}' }, false],
  ['guardSubsetCommand blank (trimmed empty)', { guardSubsetCommand: '   ' }, true],
  ['guardSubsetCommand set and conductorFullRun true', { guardSubsetCommand: 'x {wt}', conductorFullRun: true }, false],
];
const hvOf = (extra, host) => CR.adapterCfg(host || 'codex', { config: Object.assign({}, base, extra), tasks: [] }, { codexHome: path.join(T, 'ch') }, path.join(T, 'calls'), () => {}).heavy;
for (const [name, extra, want] of TABLE) {
  const hv = hvOf(extra);
  ok(`A0 adapterCfg codex, ${name}: cfg.heavy.fullByWorkflow ${want}`, !!hv && (want ? hv.fullByWorkflow === true : !hv.fullByWorkflow), J(hv));
}
ok('A0 adapterCfg claude: no cfg.heavy at all', hvOf({}, 'claude') === undefined);

// A0 parity: for every row the workflow runs a full run step exactly when the conductor marks the adapter.
async function fullStepRuns(extra) {
  const seen = [];
  const P1 = '1'.repeat(40);
  const answers = { pre: { ok: true, problems: [], blockingQuestions: [] },
    prog: { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: P1, mutations: 'm', fullRun: 'x', questions: [], summary: 's' } };
  const config = Object.assign({ sharedDir: path.join(T, 'ps'), worktreeRoot: T, scriptsDir: '/p/scripts', configPath: CFGP, testerWritable: ['-run\\.js$'], protectedBranches: ['main'] }, extra);
  const task = { key: 'x', title: 'X', wt: '/w', gdir: '/w', branch: 'b', base: 'arc', accept: 'acc', kind: 'tail', noAnalysis: 'a test task', dir: path.join(T, 'pd'), stepDir: path.join(T, 'pst') };
  const x = await CR.runScript({ host: 'claude', pluginRoot: ROOT, args: { owner: 'o', config, tasks: [task] },
    launch: async (plan) => { const a = answers[plan.label.split(':')[0]]; return a ? { output: a } : { outcome: 'crashed', error: 'no answer' }; },
    exec: async (step) => {
      seen.push(step.label);
      if (step.kind === 'env') return { value: { ok: true, problems: [], notes: [] } };
      return { value: null };
    }, note: () => {}, log: () => {} });
  if (x.threw) throw x.threw;
  return seen.some((l) => /^run:x:full-/.test(l));
}

(async () => {
  for (const [name, extra] of TABLE) {
    const step = await fullStepRuns(extra);
    const mark = !!(hvOf(extra) || {}).fullByWorkflow;
    ok(`A0 parity, ${name}: the workflow's full run step (${step}) and the adapter's mark (${mark}) agree`, step === mark);
  }

  // ---- F26e: the host section under the mark
  {
    const t = { dir: '/x/task' };
    for (const kind of ['prog', 'test']) {
      const on = RX.hostSection(kind, t, { heavy: true, fullByWorkflow: true });
      const off = RX.hostSection(kind, t, { heavy: true });
      ok(`F26e ${kind} under the mark: no --kind full, says the workflow runs the full guard run, keeps --kind select and heavy-req.js -- <argv>`,
        !/--kind full/.test(on) && WF.test(on) && /heavy-req\.js --kind select --base <ref>/.test(on) && /heavy-req\.js[^\n]*-- <argv>/.test(on) && /local selection/.test(on) && !/local full run/.test(on), on.slice(-400));
      ok(`F26e ${kind} without the mark: as before (--kind full offered)`, /heavy-req\.js --kind full/.test(off) && !WF.test(off), off.slice(-400));
    }
    ok('F26e review: no heavy line under the mark either', !/heavy-req/.test(RX.hostSection('review', t, { heavy: true, fullByWorkflow: true })));
  }

  // ---- F26d: the bodies of the roles (on codex they go into stdin before the prompt)
  {
    const pg = read(path.join(ROOT, 'agents', 'programmer.md')), ts = read(path.join(ROOT, 'agents', 'tester.md'));
    ok('F26d programmer.md: when the workflow prompt says the workflow runs the full guard run, the programmer runs none',
      /When the workflow prompt says the workflow runs the full guard run on your HEAD, run no full run of your own/.test(pg));
    ok('F26d tester.md: when the workflow prompt says the workflow ran the full guard run, the tester runs none',
      /When the workflow prompt says the workflow ran the full guard run on the HEAD you test, run no full run at all/.test(ts));
    ok('F26d tester.md: "run the full suite only after your own commits" is no longer unconditional',
      !/Do not repeat the programmer's full guard run: reuse its log, run new and touched guards and mutations; run the full\s+suite only after your own commits\./.test(ts));
  }

  // ---- D1: the rule onerun, the README, the coordinator's skill
  {
    const rules = read(path.join(ROOT, 'rules', 'multi-agent.md'));
    const line = rules.split('\n').find((l) => /<!-- role:onerun -->/.test(l)) || '';
    ok('D1 rule onerun: without the key under the conductor the workflow runs the full run (conductorFullRun), no longer only "the programmer runs the full run itself"',
      /conductorFullRun/.test(line) && /the workflow runs the full guard run/.test(line) && !/Without the key the programmer runs the full run itself and the tester reuses its log\./.test(line), line.slice(-600));
    const readme = read(path.join(ROOT, 'README.md'));
    ok('D1 README: the guard run of a codex role names the refusal of --kind full under the workflow\'s full run', /fullByWorkflow/.test(readme) && /refuses `--kind full`/.test(readme));
    const sk = read(path.join(ROOT, 'skills', 'coordinator', 'SKILL.md'));
    ok('D1 coordinator skill: a full run by hand pins the task\'s config (CODIS_AGENTS_CONFIG=<the task\'s config> guards-all.sh <wt>)', /CODIS_AGENTS_CONFIG=<the task's config> [^\n]*guards-all\.sh <wt>/.test(sk));
  }

  if (process.platform !== 'darwin') { skip('A1, A2\', A3\' through the adapter', 'needs macOS (the box is read with O_NOFOLLOW_ANY)'); done(); }

  // A worktree with a tracked change: a guard run that passed the mark would be refused "commit first" by the adapter's
  // check of the worktree, so the reason of a refusal tells which check came first.
  const wt = path.join(T, 'wt');
  fs.mkdirSync(wt);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', wt].concat(a), { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(wt, 'a.js'), '1\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(wt, 'a.js'), '2\n');
  let caseN = 0;
  const req = (env, args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: wt, env: Object.assign({}, process.env, env) });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('exit', () => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(j || { out }); });
  });

  // ---- A0 link, A1, A2', A3': adapterCfg -> createAgent -> the service and the host section of the call
  async function call(extra) {
    const c = path.join(T, `c${++caseN}`);
    const tdir = path.join(c, 'task'), state = path.join(c, 'state'), home = path.join(c, 'home'), rtmp = path.join(c, 'rtmp');
    for (const d of [tdir, state, home, rtmp]) fs.mkdirSync(d, { recursive: true });
    const heavy = hvOf(extra);
    const got = { plan: null, full: null, ga: null, sel: null, journal: [] };
    const agent = RX.createAgent({ host: 'codex', callsDir: path.join(c, 'calls'), pluginRoot: ROOT, log: () => {}, env: Object.assign({}, process.env, { TMPDIR: rtmp }),
      codex: { home, catalog: { models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: ['low'] }] } },
      tasks: { K: { dir: tdir, wt, branch: 'main' } }, commit: { stateDir: state }, heavy: Object.assign({}, heavy, { inject: { probe: async () => ({}) } }),
      launch: async (plan) => {
        got.plan = plan;
        const env = { CODIS_HEAVY_BOX: plan.env.CODIS_HEAVY_BOX, CODIS_HEAVY_ANSWERS: plan.env.CODIS_HEAVY_ANSWERS };
        got.full = await req(env, ['--kind', 'full', '--max', '20']);
        got.ga = await req(env, ['--max', '20', '--', 'zsh', '/anywhere/scripts/guards-all.sh', wt]);
        got.sel = await req(env, ['--kind', 'select', '--base', 'main', '--max', '20']);
        return { outcome: 'crashed', error: 'a test launcher' };
      } });
    await agent('task', { label: 'prog:K', schema: { type: 'object', properties: { a: { type: 'string' } } }, agentType: 'general-purpose' });
    got.journal = read(path.join(state, 'K', 'heavy.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return got;
  }
  const evsOf = (g, a) => g.journal.filter((e) => a && e.id === a.id).map((e) => e.ev);

  {
    const g = await call({});
    ok('A0 link: the conductor\'s mark reaches the host section of prog: no --kind full, the workflow runs the full run',
      !!g.plan && !/--kind full/.test(g.plan.stdin) && WF.test(g.plan.stdin), g.plan && g.plan.stdin.slice(-400));
    ok('A1 --kind full under the mark: refused before the queue (no queued, before the check of the worktree)',
      !!g.full && g.full.state === 'refused' && !evsOf(g, g.full).includes('queued') && evsOf(g, g.full).includes('refused') && !/commit first/.test(g.full.why || ''), J(g.full));
    ok('A1 the refusal is not the environment and names the next step: the workflow runs the full guard run, run your new and touched guards',
      !!g.full && !/^environment:/.test(g.full.why || '') && WF.test(g.full.why || '') && /new and touched guards/.test(g.full.why || '') && !/--kind full/.test(g.full.why || ''), J(g.full));
    ok('A3\' argv with guards-all.sh under the mark: refused, not the environment, no hint to --kind full, the workflow runs the full guard run',
      !!g.ga && g.ga.state === 'refused' && !/^environment:/.test(g.ga.why || '') && !/--kind full/.test(g.ga.why || '') && WF.test(g.ga.why || '') && !evsOf(g, g.ga).includes('queued'), J(g.ga));
    ok('A3 --kind select under the mark: as before (reaches the check of the worktree: commit first)', !!g.sel && g.sel.state === 'refused' && /commit first/.test(g.sel.why || ''), J(g.sel));
  }
  {
    const g = await call({ conductorFullRun: false });
    ok('A2\' conductorFullRun false: no mark, --kind full takes the earlier path (reaches the check of the worktree: commit first)',
      !!g.full && g.full.state === 'refused' && /commit first/.test(g.full.why || ''), J(g.full));
    ok('A2\' conductorFullRun false: the host section offers --kind full as before', !!g.plan && /heavy-req\.js --kind full/.test(g.plan.stdin), g.plan && g.plan.stdin.slice(-400));
    ok('A2\'/A3 argv with guards-all.sh without the mark: the earlier refusal (environment: ... --kind full)',
      !!g.ga && g.ga.state === 'refused' && /^environment: guards-all\.sh runs through the channel: heavy-req\.js --kind select --base <ref> \| --kind full/.test(g.ga.why || ''), J(g.ga));
  }
  {
    const g = await call({ guardSubsetCommand: 'true {wt}' });
    ok('A2\' guardSubsetCommand: no mark, --kind full takes the earlier path', !!g.full && g.full.state === 'refused' && /commit first/.test(g.full.why || ''), J(g.full));
  }

  // ---- createAgent: the mark is a boolean
  {
    const c = path.join(T, 'v');
    for (const x of ['task', 'state', 'home', 'rtmp']) fs.mkdirSync(path.join(c, x), { recursive: true });
    const refusal = (heavy) => { try { RX.createAgent({ host: 'codex', callsDir: path.join(c, 'calls'), pluginRoot: ROOT, log: () => {}, env: Object.assign({}, process.env, { TMPDIR: path.join(c, 'rtmp') }),
      codex: { home: path.join(c, 'home') }, tasks: { K: { dir: path.join(c, 'task'), wt } }, commit: { stateDir: path.join(c, 'state') }, heavy }); return null; } catch (e) { return e.message; } };
    ok('createAgent: heavy.fullByWorkflow other than a boolean is refused', /heavy\.fullByWorkflow/.test(refusal({ config: CFGP, fullByWorkflow: 'yes' }) || ''), refusal({ config: CFGP, fullByWorkflow: 'yes' }));
    ok('createAgent: heavy.fullByWorkflow true is taken', refusal({ config: CFGP, fullByWorkflow: true }) === null, refusal({ config: CFGP, fullByWorkflow: true }));
  }

  // ---- the service alone: the option fullByWorkflow
  {
    const c = path.join(T, 'svc');
    const d = { tdir: path.join(c, 'task'), state: path.join(c, 'state'), box: path.join(c, 'task', 'calls', 'prog-1', 'heavy') };
    for (const x of [d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
    const svc = HS.openHeavyService({ task: 'K', callId: 'prog-1', role: 'prog', wt, tdir: d.tdir, box: d.box, stateDir: d.state, fullByWorkflow: true, pollMs: 200, inject: { probe: async () => ({}) } });
    const id = id32();
    const tmp = path.join(d.box, `.${id}.tmp`);
    fs.writeFileSync(tmp, J({ id, kind: 'full' }));
    fs.renameSync(tmp, path.join(d.box, `${id}.json`));
    const a = await until(() => { try { const v = JSON.parse(fs.readFileSync(path.join(d.state, 'K', 'heavy-calls', 'prog-1', `${id}.json`), 'utf8')); return v.state === 'refused' ? v : null; } catch { return null; } });
    ok('A1 openHeavyService({fullByWorkflow: true}): a request {kind: full} is refused with the workflow\'s text', !!a && WF.test(a.why || '') && !/^environment:/.test(a.why || ''), J(a));
    await svc.close();
  }
  done();
})().catch((e) => { console.log('  FAIL threw - ' + ((e && e.stack) || e)); process.exit(1); });
