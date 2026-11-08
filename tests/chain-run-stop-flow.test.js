#!/usr/bin/env node
'use strict';
// tests:quiet - real conductors of chain-run.js with fake roles, detached wait steps and a 30 s kill pause
// The stop of a conductor run (p-codex-B1-b2b-2, UC-6; analysis p-codex-B1-b2b §10.1 M-A, §11.1, §11.3, §11.5): real
// conductors of a copy of the plugin tree (`chain-run.js run`, started as `start` starts it: detached, with IPC, the
// starter disconnects on ready), fake claude roles, a stub selection, a stub train, a pausing post-check and wait-step
// start; every process under tests/fixtures/chain-run/kill-hook.js (a signal reaches only the conductor's pid of a line
// =<pid> and the groups of the fake roles), and tests/fixtures/chain-run/signal-at.js, which makes the conductor signal
// itself at a named moment. The invariant checked everywhere: after the log line "stopping <SIG>" no "started" line in
// log.txt and no intent in any journal; the conductor exits with the code results.json holds.
//   A   (S1, S1b, S2, S8, S13, S15, S21-S23) a role, two selections and two rides open; stop with a ps that doubles
//       spaces; the restarts: the role again; a live selection refuses the start and resolve; resumeAt without a
//       decision refuses; ran green -> tester, no programmer, no selection; ran red -> the programmer; a train ran
//       green -> the task is over; ran red -> trainReds 1 and the programmer;
//   B   (S8, S19) review and security review that ignore SIGTERM: SIGKILL not before graceMs, a second SIGTERM ignored;
//   C   (S6) a signal when run.json is written; D (S7) stop during the host check; E (S12, S20) a signal at the intent
//       of a post-check, a second one while it runs; F (S16) a signal at the red result of the tester; G (S17) at the
//       record of the last task / at results.json; H (S18) SIGINT, SIGHUP; I (S24) results.json cannot be written;
//   J   (S14) stop while wait-step start runs;
//   K-N two roles of a task at once (review and security review, analysis p-codex-B1-b2b-2 C5-C9): K the review
//       ignores SIGTERM, the security review ends, a SIGINT and a second SIGTERM in the pause; L both end on SIGTERM;
//       M the review answered (or failed) before the stop; N a second task at its selection ends at once while the
//       first waits for its security review. The conductor exits only after every role of a task has ended.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const HOOK = path.join(__dirname, 'fixtures', 'chain-run', 'kill-hook.js');
const SIGAT = path.join(__dirname, 'fixtures', 'chain-run', 'signal-at.js');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-stopf-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RUNS = path.join(SHARED, 'runs');
const KLOG = path.join(W, 'kill.log'), ALLOW = path.join(W, 'allow');
fs.writeFileSync(ALLOW, '');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = cond(); if (v) return v; await wait(100); } return cond(); }
const alive = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && !!r.stdout.trim() && !/^Z/.test(r.stdout.trim()); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const klog = () => text(KLOG).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pids = new Set();
const EXIT_MS = +(process.env.STOPF_EXIT_MS || 240000);

// ---- the repository, the plugin copy and its stubs
fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
git('-C', REPO, 'branch', 'arc');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const PLUG = path.join(W, 'plugin');
for (const d of ['scripts', 'workflows', 'agents', 'rules', 'schemas', 'skills', 'hooks', '.claude-plugin']) {
  if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(PLUG, d), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(PLUG, 'package.json'));
const S = path.join(PLUG, 'scripts');
const CRP = path.join(S, 'chain-run.js');
const F = (n) => path.join(W, n);
const waitFor = (file) => `for (let i = 0; i < 3000 && !require('fs').existsSync(${JSON.stringify(file)}); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);`;
// The selection: per worktree (its cwd) it waits for go-sel-<wt> and exits with rc-sel-<wt> (default 0). The stub
// takes the place of the guard-run script in the copy, so no slot script runs here (not a test of
// tests/slots-hermetic.test.js, whose pattern looks for the quoted name).
const SELECTION = `guards-all.sh`;
fs.writeFileSync(path.join(S, SELECTION), `#!/bin/sh\nn=$(basename "$PWD")\necho "stub selection $* pid $$"\ni=0\nwhile [ ! -f "${W}/go-sel-$n" ] && [ $i -lt 3000 ]; do sleep 0.1; i=$((i+1)); done\necho "TOTAL: 0 new red, 1 total"\nexit $(cat "${W}/rc-sel-$n" 2>/dev/null || echo 0)\n`, { mode: 0o755 });
// The train: an entry of its queue per task, then it waits for go-train-<task> and exits with rc-train-<task>.
fs.writeFileSync(path.join(S, 'train.js'), `'use strict';\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nconst task = a[a.indexOf('--task') + 1];\n`
  + `fs.mkdirSync(${JSON.stringify(F('queue'))}, { recursive: true });\nfs.writeFileSync(${JSON.stringify(F('queue'))} + '/' + task + '.json', JSON.stringify({ task, pid: process.pid }));\n`
  + `fs.writeFileSync(${JSON.stringify(W)} + '/train-started-' + task, String(process.pid));\nconst go = ${JSON.stringify(W)} + '/go-train-' + task;\n`
  + `for (let i = 0; i < 3000 && !fs.existsSync(go); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);\n`
  + `let rc = 0; try { rc = +fs.readFileSync(${JSON.stringify(W)} + '/rc-train-' + task, 'utf8'); } catch {}\nconsole.log('stub train ' + task + ' rc ' + rc);\nprocess.exit(rc);\n`);
// The post-check and wait-step: wrappers that pause before the real script while a pause file exists.
for (const [name, pause, cond] of [['role-post-check', 'post', 'true'], ['wait-step', 'ws', "process.argv[2] === 'start'"]]) {
  fs.renameSync(path.join(S, `${name}.js`), path.join(S, `${name}.real.js`));
  fs.writeFileSync(path.join(S, `${name}.js`), `'use strict';\nconst fs = require('fs');\nconst path = require('path');\nconst { spawnSync } = require('child_process');\n`
    + `if (require.main === module) {\n  fs.appendFileSync(${JSON.stringify(F(`${pause}-calls.log`))}, process.argv.slice(2).join(' ') + '\\n');\n`
    + `  if (${cond} && fs.existsSync(${JSON.stringify(F(`${pause}-pause`))})) { fs.writeFileSync(${JSON.stringify(F(`${pause}-paused`))}, String(process.pid)); ${waitFor(F(`${pause}-go`))} }\n`
    + `  const p = spawnSync(process.execPath, [path.join(__dirname, '${name}.real.js')].concat(process.argv.slice(2)), { stdio: 'inherit' });\n  process.exit(p.status === null ? 1 : p.status);\n`
    + `} else module.exports = require('./${name}.real.js');\n`);
}
const base = { repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'] };
const CFG = F('cfg-plain.json'), CFG_SEL = F('cfg-sel.json');
fs.writeFileSync(CFG, JSON.stringify(base));
fs.writeFileSync(CFG_SEL, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: 'true {wt} {onlyArgs} {jobs} {limitFile}',
  guardRerun: { command: 'true {wt} {name}', newRedPattern: '^FAIL (\\S+) ', tallyPattern: '^TOTAL: .* (\\d+) total$' } })));
const configOf = (file) => JSON.parse(spawnSync(process.execPath, [path.join(S, 'config.js'), 'json', file], { encoding: 'utf8' }).stdout);

const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: SHA0, summary: '' };
const RED = { verdict: 'red', head: SHA0, summary: 'a red cell' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const task = (key, extra) => {
  const wt = path.join(WTR, `w-${key}`);
  if (!fs.existsSync(wt)) git('-C', REPO, 'worktree', 'add', '-q', '-b', `b-${key}`, wt, SHA0);
  return Object.assign({ key, title: key.toUpperCase(), wt: `w-${key}`, branch: `b-${key}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extra || {});
};
let nFake = 0;
// answers: {"<role>": [..]} or per task {"<role>@<key>": [..]}; the default answers every role at once.
function fake(answers) {
  const d = F(`fake${++nFake}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(Object.assign({ default: { 'gp:blockingQuestions,ok,problems': PRE, programmer: PROG, tester: GREEN, reviewer: DONE, 'security-reviewer': DONE } }, answers)));
  return d;
}
const trace = (d) => text(path.join(d, 'trace.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const starts = (d, role, key) => trace(d).filter((e) => e.ev === 'start' && e.key === role && (!key || e.cwd === path.join(SHARED, key)));

let nRun = 0;
// One conductor as `start` runs it: the run folder with request.json, `chain-run.js run` detached with IPC, the starter
// disconnects on ready. -> {runId, dir, pid, ready (the tasks of ready), exit: promise of {code, signal}}.
function conduct(tasks, o) {
  const cfgFile = (o && o.cfg) || CFG;
  const runId = `20261108T120000Z-f${String(++nRun).padStart(2, '0')}`;
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ runId, host: 'claude', args: { owner: 'the owner asked for the test tasks', config: configOf(cfgFile), tasks },
    adapter: {}, argv: [], pluginVersion: '0.0.0-test', requestedAt: new Date().toISOString() }));
  const fd = fs.openSync(path.join(dir, 'log.txt'), 'a');
  const env = Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: o.fd, FAKE_CLI_ALLOW_SELF: '1',
    NODE_OPTIONS: `-r ${SIGAT} -r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW }, (o && o.env) || {});
  const child = spawn(process.execPath, [CRP, 'run', dir], { detached: true, stdio: ['ignore', fd, fd, 'ipc'], env });
  fs.closeSync(fd);
  pids.add(child.pid);
  const r = { runId, dir, pid: child.pid, ready: null };
  child.on('message', (m) => { if (m && m.type === 'ready') { r.ready = m.tasks; child.disconnect(); } });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  // A conductor that does not stop (the code before the stop) is waited for at most EXIT_MS.
  r.exit = Promise.race([exited, wait(EXIT_MS).then(() => ({ code: 'still running', signal: null }))]);
  return r;
}
const cli = (args, o) => {
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `-r ${HOOK}`, KILL_LOG: KLOG, KILL_ALLOW_FILE: ALLOW }, (o && o.env) || {});
  const p = spawnSync(process.execPath, [CRP].concat(args), { encoding: 'utf8', env, timeout: 60000 });
  let j = null;
  try { j = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { /* below */ }
  return { code: p.status, j, err: p.stderr, out: p.stdout };
};
const stopRun = (r, o) => { fs.appendFileSync(ALLOW, `=${r.pid}\n`); return cli(['stop', r.dir], o); };
const jlines = (r, key) => {
  const d = path.join(r.dir, 'journal', key);
  let names = [];
  try { names = fs.readdirSync(d).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort(); } catch { /* none */ }
  return names.flatMap((n) => text(path.join(d, n)).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};
const logLines = (r) => text(path.join(r.dir, 'log.txt')).split('\n').filter(Boolean);
// The invariant of stopping: the line "stopping <SIG>" is there, no "started" line after it, no intent after its time.
function invariant(r, keys, sig) {
  const ls = logLines(r);
  const i = ls.findIndex((l) => new RegExp(`^\\S+ stopping ${sig}$`).test(l));
  if (i < 0) return `no line "stopping ${sig}" in log.txt`;
  const after = ls.slice(i + 1).filter((l) => /^\S+ (agent|exec) \S+ started$/.test(l));
  if (after.length) return `started after stopping: ${after.join(' | ')}`;
  const at = ls[i].split(' ')[0];
  for (const k of keys) {
    const late = jlines(r, k).filter((l) => l.type === 'intent' && l.at > at);
    if (late.length) return `${k}: an intent after stopping (${at}): ${late.map((l) => l.label).join(', ')}`;
    const js = jlines(r, k);
    if (js.length && js[js.length - 1].type !== 'end') return `${k}: the last journal line is ${js[js.length - 1].type}, not end`;
  }
  return '';
}
const results = (r) => readJson(path.join(r.dir, 'results.json'));
const byKey = (res) => Object.fromEntries(((res && res.results) || []).map((x) => [x.task, x]));
const lockGone = (keys) => keys.every((k) => !fs.existsSync(path.join(RUNS, '.locks', `${k}.lock`)));
const stepOf = (r, key, re) => jlines(r, key).find((l) => l.type === 'intent' && re.test(l.label));
const touch = (n, v) => fs.writeFileSync(F(n), v === undefined ? '' : String(v));
const PSD = F('ps-double');
fs.mkdirSync(PSD);
fs.writeFileSync(path.join(PSD, 'ps'), '#!/bin/sh\n/bin/ps "$@" | sed \'s/ /  /g\'\n', { mode: 0o755 });

(async () => {
  try {
    // ---- A: a role, two selections, two rides; stop; restarts
    for (const k of ['c', 'd']) touch(`go-sel-w-${k}`);
    touch('rc-train-d', 11);
    let fd = fake({ 'programmer@a': [{ $sleep: 120, then: PROG }, PROG] });
    const tasksA = ['a', 'b', 'e', 'c', 'd'].map((k) => task(k, { base: 'arc' }));
    const A = conduct(tasksA, { cfg: CFG_SEL, fd });
    const metaOf = (r, k) => readJson(path.join(r.dir, 'steps', k, 'wait-select-1.json'));
    const up = await until(() => starts(fd, 'programmer', 'a').length && metaOf(A, 'b') && metaOf(A, 'e') && fs.existsSync(F('train-started-c')) && fs.existsSync(F('train-started-d')), 120000);
    ok('A the run is up: the programmer of a lives, b and e wait on select-1, c and d on train-1', !!up, logLines(A).slice(-15).join('\n'));
    const selB = metaOf(A, 'b') || {}, trC = +text(F('train-started-c'));
    let s = stopRun(A, { env: { PATH: `${PSD}${path.delimiter}${process.env.PATH}` } });
    ok('S1 S1b stop with a ps that doubles spaces: exit 0, {sent: SIGTERM, pid}', s.code === 0 && s.j && s.j.sent === 'SIGTERM' && s.j.pid === A.pid, JSON.stringify(s));
    const termA = klog().filter((l) => l.pid === A.pid && l.sig === 'SIGTERM');
    ok('S1 one SIGTERM line to the pid of the conductor, none to its group', termA.length === 1 && !klog().some((l) => l.pid === -A.pid && l.sig !== 0), JSON.stringify(termA));
    let x = await A.exit;
    ok('S8 the conductor exits 143 by itself (not killed)', x.code === 143 && x.signal === null, JSON.stringify(x));
    let inv = invariant(A, tasksA.map((t) => t.key), 'SIGTERM');
    ok('S8 S13 S15 invariant: nothing started and no intent after "stopping SIGTERM", end is the last line of every journal', !inv, inv);
    let res = results(A), rk = byKey(res);
    ok('S8 results.json: exitCode 143, every task stopped with signal SIGTERM, counts and the why of a signal', res && res.exitCode === 143
      && tasksA.every((t) => rk[t.key] && rk[t.key].status === 'stopped' && rk[t.key].signal === 'SIGTERM' && rk[t.key].counts && /^signalled: SIGTERM/.test(rk[t.key].why)), JSON.stringify(res));
    const progA = jlines(A, 'a').filter((l) => l.type === 'result').pop() || {};
    ok('S8 the role of a: its result signalled, the adapter field names it', progA.outcome === 'signalled' && ((rk.a || {}).adapter || []).some((e) => e.outcome === 'signalled' && e.cause === 'signalled'), JSON.stringify(progA) + JSON.stringify(rk.a));
    const openSel = (k) => { const st = stepOf(A, k, /^run:[^:]+:select-1$/); const ls = jlines(A, k); return st && ls.some((l) => l.type === 'launch' && l.stepId === st.stepId) && !ls.some((l) => l.type === 'result' && l.stepId === st.stepId) && !ls.some((l) => l.type === 'intent' && /#retry/.test(l.label)) ? st : null; };
    ok('S13 select-1 of b and e: intent and launch, no result, no retry; open names it', ['b', 'e'].every((k) => openSel(k) && ((rk[k] || {}).open || []).some((o) => /select-1$/.test(o.label))), JSON.stringify(rk.b));
    const openTr = (k) => { const st = stepOf(A, k, /^run:[^:]+:train-1$/); const ls = jlines(A, k); return st && !ls.some((l) => l.type === 'result' && l.stepId === st.stepId) ? st : null; };
    ok('S15 train-1 of c and d: open without a result, open names it', ['c', 'd'].every((k) => openTr(k) && ((rk[k] || {}).open || []).some((o) => /train-1$/.test(o.label))), JSON.stringify(rk.c));
    ok('S13 S15 the selection of b and the ride of c live on after the exit; the queue entry of c stays', alive(selB.pid) && alive(trC) && fs.existsSync(F('queue/c.json')), `${selB.pid} ${trC}`);
    let st = cli(['status', A.dir]);
    ok('S8 status: finished, exit 0; the locks are gone', st.code === 0 && st.j && st.j.state === 'finished' && lockGone(tasksA.map((t) => t.key)), JSON.stringify(st.j && st.j.state));
    const before = klog().length;
    s = stopRun(A);
    ok('S2 a second stop after results.json: exit 2, finished, no signal', s.code === 2 && s.j && s.j.state === 'finished' && s.j.exitCode === 143
      && !klog().slice(before).some((l) => l.sig !== 0 && l.sig !== '0'), JSON.stringify(s));

    // S21: the task stopped at its role starts again; its role runs once more
    touch('go-sel-w-a'); touch('go-train-a');
    const progsA = starts(fd, 'programmer', 'a').length;
    let R = conduct([task('a', { base: 'arc' })], { cfg: CFG_SEL, fd });
    x = await R.exit;
    ok('S21 restart of the task stopped at its role: held, the programmer called once more, done', R.ready && R.ready.a === 'held' && starts(fd, 'programmer', 'a').length === progsA + 1
      && (byKey(results(R)).a || {}).status === 'done', JSON.stringify(R.ready) + JSON.stringify(results(R)));

    // S22: the selection of b and e
    R = conduct([task('b', { base: 'arc' })], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S22a the start while the selection lives: refused, select-1 alive', R.ready && /select-1/.test(R.ready.b || '') && /alive/.test(R.ready.b || ''), JSON.stringify(R.ready));
    st = cli(['status', A.dir]);
    const basis = (k) => st.j && st.j.tasks && st.j.tasks[k] && st.j.tasks[k].basis;
    const nOf = (k, re) => (stepOf(A, k, re) || {}).n;
    s = cli(['resolve', A.dir, '--task', 'b', '--step', String(nOf('b', /select-1$/)), '--as', 'ran', '--verdict', 'green', '--basis', basis('b'), '--note', 'still running']);
    ok('S22a resolve on the live selection: refused "decide after it ended"', s.code !== 0 && /decide after it ended/.test(s.err), s.err + s.out);
    touch('rc-sel-w-e', 1); touch('go-sel-w-b'); touch('go-sel-w-e');
    await until(() => ['b', 'e'].every((k) => fs.existsSync(path.join(A.dir, 'steps', k, 'wait-select-1.rc'))) && !alive(selB.pid), 60000);
    R = conduct([task('b', { base: 'arc', resumeAt: 'tester', head: SHA0 })], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S22b resumeAt and head without a decision: refused', R.ready && /resumeAt and head come only from a decision of resolve/.test(R.ready.b || ''), JSON.stringify(R.ready));
    st = cli(['status', A.dir]);
    s = cli(['resolve', A.dir, '--task', 'b', '--step', String(nOf('b', /select-1$/)), '--as', 'ran', '--verdict', 'green', '--basis', basis('b'), '--note', 'rc 0']);
    const nb = s.j && s.j.decision && s.j.decision.next;
    ok('S22c resolve ran green: next {resumeAt: tester, head: H_B}', s.code === 0 && nb && nb.resumeAt === 'tester' && nb.head === SHA0, JSON.stringify(s));
    touch('go-train-b');
    const progsB = starts(fd, 'programmer', 'b').length;
    const tb = task('b', Object.assign({ base: 'arc' }, nb ? { resumeAt: nb.resumeAt, head: nb.head } : {}, nb && Object.keys(nb.counts || {}).length ? { prior: nb.counts } : {}));
    R = conduct([tb], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S22c the start by the decision: no programmer, no selection, done', (byKey(results(R)).b || {}).status === 'done' && starts(fd, 'programmer', 'b').length === progsB
      && !jlines(R, 'b').some((l) => l.type === 'intent' && /select-/.test(l.label)), JSON.stringify(results(R)));
    s = cli(['resolve', A.dir, '--task', 'e', '--step', String(nOf('e', /select-1$/)), '--as', 'ran', '--verdict', 'red', '--basis', basis('e'), '--note', 'rc 1']);
    const ne = s.j && s.j.decision && s.j.decision.next;
    touch('go-sel-w-e-2');
    fs.writeFileSync(F('rc-sel-w-e'), '0');
    touch('go-train-e');
    const progsE = starts(fd, 'programmer', 'e').length;
    R = conduct([task('e', Object.assign({ base: 'arc' }, ne && Object.keys(ne.counts || {}).length ? { prior: ne.counts } : {}))], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S22d resolve ran red: the start from the beginning calls the programmer', s.code === 0 && ne && !ne.resumeAt && starts(fd, 'programmer', 'e').length === progsE + 1, JSON.stringify(s) + JSON.stringify(results(R)));

    // S23: the rides of c and d ended
    touch('go-train-c'); touch('go-train-d');
    await until(() => !alive(trC) && !alive(+text(F('train-started-d'))), 60000);
    st = cli(['status', A.dir]);
    s = cli(['resolve', A.dir, '--task', 'c', '--step', String(nOf('c', /train-1$/)), '--as', 'ran', '--verdict', 'green', '--basis', basis('c'), '--note', 'rc 0']);
    ok('S23a resolve ran green on the ride: next done', s.code === 0 && s.j && s.j.decision && s.j.decision.next === 'done', JSON.stringify(s));
    const trains = text(F('queue/c.json'));
    fs.unlinkSync(F('train-started-c'));
    R = conduct([task('c', { base: 'arc' })], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S23a the start after it: refused "the task is over by a decision", no second ride', R.ready && /the task is over by a decision/.test(R.ready.c || '') && !fs.existsSync(F('train-started-c')) && !!trains, JSON.stringify(R.ready));
    st = cli(['status', A.dir]);
    s = cli(['resolve', A.dir, '--task', 'd', '--step', String(nOf('d', /train-1$/)), '--as', 'ran', '--verdict', 'red', '--basis', basis('d'), '--note', 'rc 11']);
    const nd = s.j && s.j.decision && s.j.decision.next;
    ok('S23b resolve ran red on the ride: next from the beginning, trainReds 1', s.code === 0 && nd && !nd.resumeAt && nd.counts && nd.counts.trainReds === 1, JSON.stringify(s));
    fs.writeFileSync(F('rc-train-d'), '0');
    const progsD = starts(fd, 'programmer', 'd').length;
    R = conduct([task('d', Object.assign({ base: 'arc' }, nd ? { prior: nd.counts } : {}))], { cfg: CFG_SEL, fd });
    await R.exit;
    ok('S23b the start with prior = next.counts calls the programmer', R.ready && R.ready.d === 'held' && starts(fd, 'programmer', 'd').length === progsD + 1, JSON.stringify(R.ready) + JSON.stringify(results(R)));

    // ---- B: review and security review ignore SIGTERM; a second SIGTERM in the pause
    fd = fake({ reviewer: [{ $ignoreTerm: true, $sleep: 120, then: DONE }], 'security-reviewer': [{ $ignoreTerm: true, $sleep: 120, then: DONE }] });
    const B = conduct([task('r2', { security: true })], { fd });
    await until(() => starts(fd, 'reviewer').length && starts(fd, 'security-reviewer').length, 120000);
    const groupsB = [starts(fd, 'reviewer')[0], starts(fd, 'security-reviewer')[0]].map((e) => e && e.pid);
    s = stopRun(B);
    await until(() => klog().some((l) => l.pid === -groupsB[0] && l.sig === 'SIGTERM') && klog().some((l) => l.pid === -groupsB[1] && l.sig === 'SIGTERM'), 20000);
    const s2 = stopRun(B);
    x = await B.exit;
    const kb = klog();
    const firstOf = (g, sig) => kb.find((l) => l.pid === -g && l.sig === sig);
    ok('S8 two roles at once: SIGTERM to each group, exit 143', s.code === 0 && x.code === 143 && groupsB.every((g) => g && firstOf(g, 'SIGTERM')), JSON.stringify(x));
    ok('S19 the second SIGTERM does not shorten the pause: the first SIGKILL of each group >= its SIGTERM + 30 s', s2.code === 0
      && groupsB.every((g) => firstOf(g, 'SIGKILL') && firstOf(g, 'SIGKILL').at - firstOf(g, 'SIGTERM').at >= 29900), JSON.stringify(groupsB.map((g) => [firstOf(g, 'SIGTERM'), firstOf(g, 'SIGKILL')])));
    ok('S19 the conductor names the second signal ignored', logLines(B).some((l) => / signal SIGTERM ignored: stopping since SIGTERM$/.test(l)), logLines(B).slice(-12).join('\n'));
    const rb = jlines(B, 'r2').filter((l) => l.type === 'result');
    ok('S8 review and security review: both results signalled; results.json 143', rb.filter((l) => l.outcome === 'signalled').length === 2 && (results(B) || {}).exitCode === 143, JSON.stringify(rb.map((l) => l.outcome)));

    // ---- C: S6 a signal when run.json is written
    fd = fake({});
    // the host check (fake claude --version) leaves VW6.started when it runs; VW6 exists, so it would not wait
    const VW6 = F('version-s6');
    touch('version-s6');
    const C = conduct([task('s6')], { fd, env: { SIGNAL_AT_RENAME: '/run\\.json$', FAKE_CLI_VERSION_WAIT: VW6 } });
    x = await C.exit;
    let rc = byKey(results(C)).s6 || {};
    ok('S6 a signal at run.json: ready was sent, exit 143, the task stopped before any role, no intent, the lock gone', x.code === 143 && C.ready && C.ready.s6 === 'held'
      && rc.status === 'stopped' && /signalled before any role: SIGTERM/.test(rc.why || '') && rc.signal === 'SIGTERM' && JSON.stringify(rc.open) === '[]' && JSON.stringify(rc.untaken) === '[]'
      && !jlines(C, 's6').some((l) => l.type === 'intent') && lockGone(['s6']) && (results(C) || {}).exitCode === 143, JSON.stringify(x) + JSON.stringify(results(C)));
    ok('S6 point (a): the host check did not run', !fs.existsSync(`${VW6}.started`));

    // ---- D: S7 stop during the host check
    const VW = F('version-wait');
    const D = conduct([task('s7')], { fd, env: { FAKE_CLI_VERSION_WAIT: VW } });
    await until(() => fs.existsSync(`${VW}.started`), 60000);
    s = stopRun(D);
    await wait(300);
    touch('version-wait');
    x = await D.exit;
    rc = byKey(results(D)).s7 || {};
    ok('S7 stop during the host check: exit 143, stopped before any role, no intent (no env, no pre)', s.code === 0 && x.code === 143 && /signalled before any role: SIGTERM/.test(rc.why || '')
      && !jlines(D, 's7').some((l) => l.type === 'intent') && !logLines(D).some((l) => / started$/.test(l)), JSON.stringify(x) + JSON.stringify(rc));

    // ---- E: S12, S20 a signal at the intent of the post-check, a second one while it runs
    touch('post-pause');
    const E = conduct([task('s12')], { fd, env: { SIGNAL_AT_WRITE: '"type":"intent".*"label":"post:' } });
    await until(() => fs.existsSync(F('post-paused')), 120000);
    await wait(500);
    process.kill(E.pid, 'SIGTERM');
    await wait(500);
    touch('post-go');
    x = await E.exit;
    fs.unlinkSync(F('post-pause'));
    const je = jlines(E, 's12');
    const post = je.find((l) => l.type === 'intent' && /^post:/.test(l.label)) || {};
    const iRes = je.findIndex((l) => l.type === 'result' && l.stepId === post.stepId);
    ok('S12 the post-check that was running ends with its result; after it the journal has only settled and end; no left check', iRes >= 0 && je.slice(iRes + 1).every((l) => ['settled', 'end'].includes(l.type))
      && !je.some((l) => l.type === 'intent' && /^left:/.test(l.label)), JSON.stringify(je.map((l) => `${l.type}:${l.label || ''}`)));
    ok('S20 a second signal while the post-check runs: not killed, exit 143, results.json written, the signal named ignored', x.code === 143 && (results(E) || {}).exitCode === 143
      && logLines(E).some((l) => / signal SIGTERM ignored: stopping since SIGTERM$/.test(l)), JSON.stringify(x));
    inv = invariant(E, ['s12'], 'SIGTERM');
    ok('S12 invariant', !inv, inv);

    // ---- F: S16 a signal at the red result of the tester
    fd = fake({ tester: [RED] });
    const Fr = conduct([task('s16')], { fd, env: { SIGNAL_AT_WRITE: '"type":"result".*"verdict":"red"' } });
    x = await Fr.exit;
    rc = byKey(results(Fr)).s16 || {};
    ok('S16 a signal at the red tester: exit 143, no second programmer, counts testerReds 1 from the getter, untaken names the tester step', x.code === 143 && starts(fd, 'programmer').length === 1
      && rc.counts && rc.counts.testerReds === 1 && (rc.untaken || []).some((u) => /^test:/.test(u.label)), JSON.stringify(rc));
    inv = invariant(Fr, ['s16'], 'SIGTERM');
    ok('S16 invariant', !inv, inv);

    // ---- G: S17 (a) at the record of the last task, after the chain: done stays done, 143; (b) at results.json: its code
    fd = fake({});
    let G = conduct([task('g17a')], { fd, env: { SIGNAL_AT_RENAME: '/tasks/g17a\\.json$', SIGNAL_AT_N: '2' } });
    x = await G.exit;
    ok('S17a a signal at the record of the ended task: results done, exitCode 143, exit 143', x.code === 143 && (results(G) || {}).exitCode === 143 && (byKey(results(G)).g17a || {}).status === 'done', JSON.stringify(x) + JSON.stringify(results(G)));
    G = conduct([task('g17b')], { fd, env: { SIGNAL_AT_RENAME: '/results\\.json$' } });
    x = await G.exit;
    ok('S17b a signal right after results.json: the exit is its code (0)', x.code === 0 && x.signal === null && (results(G) || {}).exitCode === 0, JSON.stringify(x));

    // ---- H: S18 SIGINT and SIGHUP
    for (const [sig, code] of [['SIGINT', 130], ['SIGHUP', 129]]) {
      fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
      const key = `h${code}`;
      const H = conduct([task(key)], { fd });
      await until(() => starts(fd, 'programmer').length, 120000);
      process.kill(H.pid, sig);
      x = await H.exit;
      rc = byKey(results(H))[key] || {};
      ok(`S18 ${sig}: exit ${code}, results.json the same, the signal in the result`, x.code === code && (results(H) || {}).exitCode === code && rc.signal === sig && rc.status === 'stopped', JSON.stringify(x) + JSON.stringify(rc));
    }

    // ---- I: S24 results.json cannot be written
    fd = fake({ programmer: [{ $sleep: 120, then: PROG }] });
    const I = conduct([task('s24')], { fd, env: { FAIL_RENAME: '/results\\.json$' } });
    await until(() => starts(fd, 'programmer').length, 120000);
    stopRun(I);
    x = await I.exit;
    ok('S24 stopping and results.json cannot be written: exit 143, the log names it', x.code === 143 && !results(I) && logLines(I).some((l) => /results\.json could not be written/.test(l)), JSON.stringify(x));
    fd = fake({});
    const I2 = conduct([task('s24b')], { fd, env: { FAIL_RENAME: '/results\\.json$' } });
    x = await I2.exit;
    ok('S24 without a signal: exit 4, as before', x.code === 4, JSON.stringify(x));

    // ---- J: S14 stop while wait-step start runs
    touch('ws-pause');
    const J = conduct([task('s14', { base: 'arc' })], { cfg: CFG_SEL, fd });
    await until(() => fs.existsSync(F('ws-paused')), 120000);
    s = stopRun(J);
    await wait(500);
    touch('ws-go');
    x = await J.exit;
    fs.unlinkSync(F('ws-pause'));
    const sj = stepOf(J, 's14', /select-1$/) || {};
    const jj = jlines(J, 's14');
    ok('S14 wait-step start ends: its launch is recorded, no wait call, no result; exit 143', x.code === 143 && jj.some((l) => l.type === 'launch' && l.stepId === sj.stepId)
      && !jj.some((l) => l.type === 'result' && l.stepId === sj.stepId) && !text(F('ws-calls.log')).split('\n').some((l) => l.startsWith('wait') && l.includes(path.join(J.dir, 'steps', 's14'))), JSON.stringify(x) + text(F('ws-calls.log')).slice(-600));
    const m14 = readJson(path.join(J.dir, 'steps', 's14', 'wait-select-1.json')) || {};
    touch('go-sel-w-s14');
    await until(() => !m14.pid || !alive(m14.pid), 20000);

    // Two roles of a task at once (review and security review): the conductor exits only after every role of the task
    // has ended. resultLabels: the result lines of a journal with the label of their intent; stopAt: the time of the
    // SIGTERM that stop sent to the conductor.
    const resultLabels = (r, key) => { const ls = jlines(r, key); const lab = Object.fromEntries(ls.filter((l) => l.type === 'intent').map((l) => [l.stepId, l.label])); return ls.filter((l) => l.type === 'result').map((l) => Object.assign({ label: lab[l.stepId] }, l)); };
    const stopAt = (r) => (klog().find((l) => l.pid === r.pid && l.sig === 'SIGTERM') || {}).at;

    // ---- K: C5 + C8 the review ignores SIGTERM, the security review ends on it (the mirror of T6); a SIGINT and a second
    // SIGTERM in the pause of the review
    fd = fake({ reviewer: [{ $ignoreTerm: true, $sleep: 120, then: DONE }], 'security-reviewer': [{ $sleep: 120, then: DONE }] });
    const K = conduct([task('k5', { security: true })], { fd });
    await until(() => starts(fd, 'reviewer').length && starts(fd, 'security-reviewer').length, 120000);
    const revK = (starts(fd, 'reviewer')[0] || {}).pid, secK = (starts(fd, 'security-reviewer')[0] || {}).pid;
    s = stopRun(K);
    await until(() => logLines(K).some((l) => / stopping SIGTERM$/.test(l)), 10000);
    await until(() => resultLabels(K, 'k5').some((l) => /^sec:/.test(l.label)), 10000);
    try { process.kill(K.pid, 'SIGINT'); } catch { /* gone already */ }
    const s2K = stopRun(K);
    x = await K.exit;
    const exitedK = Date.now();
    const killK = klog().find((l) => l.pid === -revK && l.sig === 'SIGKILL');
    ok('C5 the review ignores SIGTERM, the security review ends: SIGKILL to the review group >= the stop + 30 s, before the exit; no role is alive after the exit; exit 143',
      s.code === 0 && x.code === 143 && !!killK && killK.at - stopAt(K) >= 29900 && killK.at <= exitedK && !!revK && !alive(revK) && !!secK && !alive(secK),
      JSON.stringify({ x, revK, killK, stop: stopAt(K) }));
    let rl = resultLabels(K, 'k5');
    ok('C5 both role calls signalled in the journal, the task ends with the result of a signal', rl.filter((l) => /^(review|sec):/.test(l.label) && l.outcome === 'signalled').length === 2
      && (byKey(results(K)).k5 || {}).status === 'stopped' && (byKey(results(K)).k5 || {}).signal === 'SIGTERM', JSON.stringify(rl.map((l) => `${l.label}:${l.outcome}`)) + JSON.stringify(results(K)));
    ok('C8 a SIGINT and a second SIGTERM in the pause: named ignored, the pause not shortened, exit and results.json 143', s2K.code === 0 && (results(K) || {}).exitCode === 143
      && logLines(K).some((l) => / signal SIGINT ignored: stopping since SIGTERM$/.test(l)) && logLines(K).some((l) => / signal SIGTERM ignored: stopping since SIGTERM$/.test(l)), logLines(K).slice(-10).join('\n'));
    inv = invariant(K, ['k5'], 'SIGTERM');
    ok('C5 invariant: end is the last journal line, after both results', !inv, inv);

    // ---- L: C6 both roles end on SIGTERM: no SIGKILL by the pause; end after both results
    fd = fake({ reviewer: [{ $sleep: 120, then: DONE }], 'security-reviewer': [{ $sleep: 120, then: DONE }] });
    const L = conduct([task('l6', { security: true })], { fd });
    await until(() => starts(fd, 'reviewer').length && starts(fd, 'security-reviewer').length, 120000);
    const gL = [starts(fd, 'reviewer')[0], starts(fd, 'security-reviewer')[0]].map((e) => e && e.pid);
    s = stopRun(L);
    x = await L.exit;
    const exitedL = Date.now();
    rl = resultLabels(L, 'l6');
    // the adapter sends SIGKILL to a group after its leader exits; the pause would put it 30 s after the SIGTERM
    const pauseKill = (g) => { const t = klog().find((l) => l.pid === -g && l.sig === 'SIGTERM'), k = klog().find((l) => l.pid === -g && l.sig === 'SIGKILL'); return !t || (k && k.at - t.at >= 29900); };
    ok('C6 both roles end on SIGTERM: exit 143 within 20 s of the stop, no SIGKILL by the pause, both calls signalled, the result of a signal', s.code === 0 && x.code === 143
      && exitedL - stopAt(L) < 20000 && gL.every((g) => g && !pauseKill(g)) && rl.filter((l) => /^(review|sec):/.test(l.label) && l.outcome === 'signalled').length === 2
      && (byKey(results(L)).l6 || {}).signal === 'SIGTERM', JSON.stringify(x) + JSON.stringify(rl.map((l) => `${l.label}:${l.outcome}`)));
    inv = invariant(L, ['l6'], 'SIGTERM');
    ok('C6 invariant: end is the last journal line, after both results', !inv, inv);

    // ---- M: C7 the review answered before the stop, the security review runs: the stop ends the task signalled
    fd = fake({ 'security-reviewer': [{ $sleep: 120, then: DONE }] });
    const M = conduct([task('m7', { security: true })], { fd });
    await until(() => starts(fd, 'security-reviewer').length && resultLabels(M, 'm7').some((l) => /^review:/.test(l.label)), 120000);
    s = stopRun(M);
    x = await M.exit;
    rl = resultLabels(M, 'm7');
    let rm = byKey(results(M)).m7 || {};
    ok('C7 the review ok before the stop, the security review signalled: exit 143, the result of a signal (not done), open and untaken are lists', s.code === 0 && x.code === 143
      && (rl.find((l) => /^review:/.test(l.label)) || {}).outcome === 'ok' && (rl.find((l) => /^sec:/.test(l.label)) || {}).outcome === 'signalled'
      && rm.status === 'stopped' && rm.signal === 'SIGTERM' && Array.isArray(rm.open) && Array.isArray(rm.untaken), JSON.stringify(rl.map((l) => `${l.label}:${l.outcome}`)) + JSON.stringify(rm));
    inv = invariant(M, ['m7'], 'SIGTERM');
    ok('C7 invariant', !inv, inv);
    // C7a: the review gave no answer by its own cause before the stop (no stop yet, so no StopError); the stop of the
    // security review ends the task signalled, and the adapter field names both calls
    fd = fake({ reviewer: [{ $exit: 1 }], 'security-reviewer': [{ $sleep: 120, then: DONE }] });
    const M2 = conduct([task('m7a', { security: true })], { fd });
    await until(() => starts(fd, 'security-reviewer').length && resultLabels(M2, 'm7a').some((l) => /^review:/.test(l.label)), 120000);
    s = stopRun(M2);
    x = await M2.exit;
    rm = byKey(results(M2)).m7a || {};
    ok('C7a the review failed before the stop: the result of a signal, its adapter field names the failed review and the signalled security review', x.code === 143 && rm.status === 'stopped' && rm.signal === 'SIGTERM'
      && (rm.adapter || []).some((e) => /^review:/.test(e.label) && e.outcome !== 'signalled') && (rm.adapter || []).some((e) => /^sec:/.test(e.label) && e.outcome === 'signalled'), JSON.stringify(rm));

    // ---- N: C9 two tasks: n1 at review and security review (the security review ignores SIGTERM), n2 at its selection:
    // n2 ends at once with the result of a signal and its lock is gone while n1 waits for its security review; one
    // results.json after both
    touch('go-sel-w-n1');
    fd = fake({ 'reviewer@n1': [{ $sleep: 120, then: DONE }], 'security-reviewer@n1': [{ $ignoreTerm: true, $sleep: 120, then: DONE }] });
    const N = conduct([task('n1', { base: 'arc', security: true }), task('n2', { base: 'arc' })], { cfg: CFG_SEL, fd });
    const selN2 = () => readJson(path.join(N.dir, 'steps', 'n2', 'wait-select-1.json'));
    await until(() => starts(fd, 'reviewer', 'n1').length && starts(fd, 'security-reviewer', 'n1').length && selN2(), 120000);
    const secN = (starts(fd, 'security-reviewer', 'n1')[0] || {}).pid;
    s = stopRun(N);
    const n2Ended = await until(() => (readJson(path.join(N.dir, 'tasks', 'n2.json')) || {}).state === 'ended' && lockGone(['n2']), 20000);
    const n1Running = (readJson(path.join(N.dir, 'tasks', 'n1.json')) || {}).state === 'running' && alive(N.pid) && !results(N);
    x = await N.exit;
    const exitedN = Date.now();
    const killN = klog().find((l) => l.pid === -secN && l.sig === 'SIGKILL');
    rk = byKey(results(N));
    ok('C9 n2 at its selection ends at once (record ended, lock gone) while n1 waits for its security review', !!n2Ended && n1Running, JSON.stringify({ n2: readJson(path.join(N.dir, 'tasks', 'n2.json')), n1Running }));
    ok('C9 n1: SIGKILL to the security review >= the stop + 30 s, before the exit; it is gone after the exit; exit 143', s.code === 0 && x.code === 143 && !!killN && killN.at - stopAt(N) >= 29900
      && killN.at <= exitedN && !!secN && !alive(secN), JSON.stringify({ x, secN, killN, stop: stopAt(N) }));
    ok('C9 one results.json with both tasks stopped by SIGTERM, n2 open names select-1, exitCode 143', (results(N) || {}).exitCode === 143 && ['n1', 'n2'].every((k) => rk[k] && rk[k].signal === 'SIGTERM')
      && ((rk.n2 || {}).open || []).some((o) => /select-1$/.test(o.label)), JSON.stringify(results(N)));
    inv = invariant(N, ['n1', 'n2'], 'SIGTERM');
    ok('C9 invariant', !inv, inv);
    const mN2 = selN2() || {};
    touch('go-sel-w-n2');
    await until(() => !mN2.pid || !alive(mN2.pid), 20000);
  } catch (e) {
    ok('the test ran to its end', false, e.stack);
  } finally {
    for (const k of ['a', 'b', 'c', 'd', 'e', 's14', 'n1', 'n2']) { touch(`go-sel-w-${k}`); touch(`go-train-${k}`); }
    touch('post-go'); touch('ws-go'); touch('version-wait');
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    for (const l of text(ALLOW).split('\n').filter((x) => /^\d+$/.test(x))) { try { process.kill(-+l, 'SIGKILL'); } catch { /* gone */ } }
    await wait(1500);
    try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  done();
})();
