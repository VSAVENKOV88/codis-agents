'use strict';
// Tester cells of p-codex-fullrun-a2, run as a child by tests/heavy-full-by-workflow.test.js (its own tally, so README
// keeps counting test files). The programmer's guard joins adapterCfg and createAgent by hand and runs the chain with a
// fake exec; these cells run the REAL conductor on the codex host (scripts/chain-run.js start --host codex, the fake
// codex CLI of tests/fixtures/chain-run, which calls no model), the real commit and heavy channels of the adapter, the
// real wait-step.js, guards-all.sh (hermetic slots: a lock folder, a fake machine and a config of its own) and
// guards-result.js copy-check. A wrapper in front of the fake codex makes each prog and test call ask the heavy channel
// what a model would: `heavy-req.js --kind full` and an argv with guards-all.sh, before its answer. Along the use cases:
//   TA1 UC-6 main + UC-1/UC-2 (A0 link, A1, A3', F26d, F26e): a project without guardSubsetCommand and without
//       conductorFullRun - the full run of prog and test is refused before the queue, not the environment, naming the
//       workflow's run; the task goes on: the conductor runs the suite once on the programmer's HEAD, tester and review,
//       done; the heavy journal holds no queued full run; the stdin of prog and test (body + prompt + host section)
//       carries the phrases of agents/*.md and offers no --kind full;
//   TA1s (after review 1, R1): under the mark the role also asks --kind select --base main (the project has no
//       guardSubsetCommand, so guards-all.sh --select would end 78 = environment): refused before the queue, not the
//       environment, naming no guard kind; the stdin of prog and test offers no --kind select and no "local selection";
//       the argv refusal hints no --kind select; without the mark (TA2) the host section still offers --kind select;
//   TA2 UC-8 (A2'): conductorFullRun false - no mark: the full run of the role is queued as before (heavy.jsonl queued,
//       kind full) and the argv with guards-all.sh gets the earlier "environment: ... --kind full"; no full run step;
//   TR  R-full end to end: the conductor stopped (chain-run.js stop) while its full run step runs; resolve --as retry on
//       that step gives resumeAt tester at the programmer's HEAD (not a programmer round); the next start runs the full
//       run step first (guards-all.sh reuses the green run of that HEAD), then tester and review: done, the programmer
//       called once over both runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const CLIENT = path.join(ROOT, 'scripts', 'heavy-req.js');
const GA = path.join(ROOT, 'scripts', 'guards-all.sh');
const FAKE_JS = path.join(__dirname, 'fixtures', 'chain-run', 'codex-fake.js');
if (process.platform !== 'darwin' || !has('zsh') || !has('git')) { skip('the codex conductor with the heavy channel', 'needs macOS (the box is read with O_NOFOLLOW_ANY), zsh and git'); done(); return; }

const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
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

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fbw-real-')));
const groups = new Set();
process.on('exit', () => { for (const p of groups) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } });
const SHARED = path.join(T, 's'), WTR = path.join(T, 'r'), REPO = path.join(T, 'repo'), CALLS = path.join(T, 'calls.log'), RTMP = path.join(T, 'rtmp'), HOME = path.join(T, 'home');
for (const d of [RTMP, HOME, REPO]) fs.mkdirSync(d, { recursive: true });
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } };

// the fake machine (tests/slots-hermetic.test.js) and the codex wrapper in front of PATH
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
// a prog or test call (the adapter gave it the heavy box) asks for a full run and for guards-all.sh in an argv, as a
// model that read the old rules would; each answer goes to $FAKE_CLI_DIR/heavy-<call>.jsonl; then the fake codex answers
sh('codex', `if [[ $1 == exec && -n $CODIS_HEAVY_BOX ]]; then
  out=$FAKE_CLI_DIR/heavy-\${CODIS_HEAVY_BOX:h:t}.jsonl
  node ${CLIENT} --kind full --max 20 </dev/null >> $out 2>/dev/null
  node ${CLIENT} --max 20 -- zsh ${GA} $PWD </dev/null >> $out 2>/dev/null
  [[ -e $FAKE_CLI_DIR/ask-select ]] && node ${CLIENT} --kind select --base main --max 20 </dev/null >> $out 2>/dev/null
fi
exec node ${FAKE_JS} "$@"`);

const GENV = Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'S', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'S', GIT_COMMITTER_EMAIL: 's@s' });
const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null'].concat(a), { cwd, encoding: 'utf8', env: GENV });
git(REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
// the project's "suite": a slow marker outside the worktree holds it (TR), a call line per run
fs.writeFileSync(path.join(REPO, 'guards.js'), `const fs = require('fs');
const [calls, hold, name] = process.argv.slice(2);
fs.appendFileSync(calls, require('path').basename(process.cwd()) + ' ' + (name || 'all') + '\\n');
const t0 = Date.now();
while (fs.existsSync(hold + '-' + require('path').basename(process.cwd())) && Date.now() - t0 < 60000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
console.log('ok a.test.js');
console.log('1 of 1 test files passed');
`);
git(REPO, 'add', 'a.js', 'guards.js');
git(REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git(REPO, 'rev-parse', 'HEAD').stdout.trim();
const HOLD = path.join(T, 'hold');
const wtOf = (name) => { const w = path.join(WTR, name); git(REPO, 'worktree', 'add', '-q', '-b', `b-${name}`, w, SHA0); return w; };
const head = (w) => git(w, 'rev-parse', 'HEAD').stdout.trim();
const runs = (name) => text(CALLS).split('\n').filter((l) => l.startsWith(`${name} `));

const cfgFile = (name, extra) => {
  const f = path.join(T, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR,
    guardCommand: `cd {wt} && node guards.js ${CALLS} ${HOLD}`, testerWritable: ['-run\\.js$'],
    guardRerun: { command: `cd {wt} && node guards.js ${CALLS} ${HOLD} {name}`, newRedPattern: '^FAIL (\\S+) \\(', tallyPattern: '^\\d+ of (\\d+) test files passed' },
    commitAuthor: { name: 'codis-agents', email: 'agents@example.com' },
    slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }, extra || {})));
  return f;
};
const CFG = cfgFile('cfg');
const OWNER = path.join(T, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test task');
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['c.js'], commits: ['$C0'], head: '$C0', mutations: 'm', fullRun: 'the workflow runs it', questions: [], summary: 's' };
const GREEN = { verdict: 'green', head: '$HEAD', summary: 'acc ok' };
const DONE = { verdict: 'done', docsOnly: false, summary: '' };
const ANSWERS = { default: { [K_PRE]: PRE }, [K_PRE]: [PRE], [K_PROG]: [{ $commits: [{ path: 'c.js', content: '2\n', message: 'the fix' }], then: PROG }], [K_TEST]: [GREEN], [K_REVIEW]: [DONE] };

let nT = 0;
const env0 = (fd) => {
  const e = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, FAKE_CLI_DIR: fd, TMPDIR: RTMP, HOME, GIT_CONFIG_NOSYSTEM: '1', SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  for (const k of Object.keys(e)) if (/^(SLOT_LEGACY_LOCK|SLOTS_DIR|SLOT_JOURNAL|SLOT_LABEL|SLOT_KIND|SLOT_PRIORITY|SLOT_PATH|GUARDS_|CODIS_|CLAUDE_PROJECT_DIR)/.test(k)) delete e[k];
  return e;
};
const cr = (args, e, ms) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: e, timeout: ms || 60000 });
const fakeDir = () => { const d = path.join(T, `fake${++nT}`); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'answers.json'), JSON.stringify(ANSWERS)); return d; };
// start a codex run of one task (a trusted hook in a fresh codex home); returns {j, e, fd}
function start(key, w, cfg, fd, extraTask) {
  const home = path.join(T, `codex-home-${++nT}`);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
  const tf = path.join(T, `tasks-${nT}.json`);
  fs.writeFileSync(tf, JSON.stringify([Object.assign({ key, title: key.toUpperCase(), wt: path.basename(w), branch: `b-${path.basename(w)}`, accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }, extraTask || {})]));
  const e = env0(fd);
  const p = cr(['start', '--host', 'codex', '--codex-home', home, '--tasks', tf, '--owner', OWNER, '--config', cfg], e);
  let j = null;
  try { j = JSON.parse(p.stdout); groups.add(j.pid); } catch { /* below */ }
  return { j, e, fd, out: p.stdout + p.stderr };
}
const endOf = (s, cfg) => {
  if (!s.j || !s.j.runDir) return { r: null, why: s.out };
  const st = cr(['status', s.j.runDir, '--config', cfg, '--wait', '170'], s.e, 200000);
  let sj = null;
  try { sj = JSON.parse(st.stdout); } catch { /* below */ }
  return { r: sj && (sj.results || [])[0], runDir: s.j.runDir, log: text(path.join(s.j.runDir, 'log.txt')) };
};
const trace = (fd) => text(path.join(fd, 'trace.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const starts = (fd, key) => trace(fd).filter((c) => c.ev === 'start' && c.key === key);
const heavyAnswers = (fd) => fs.readdirSync(fd).filter((f) => /^heavy-.*\.jsonl$/.test(f)).map((f) => ({ call: f.slice(6, -6),
  answers: text(path.join(fd, f)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) }));
const journal = (key) => text(path.join(SHARED, 'runs', '.commit', key, 'heavy.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const why = (x) => J(x.r) + '\n' + (x.log || x.why || '').slice(-2500);
const WF = /the workflow runs the full guard run on your HEAD/;

(async () => {
  // ---- TA1: the mark on (no guardSubsetCommand, conductorFullRun absent)
  {
    const w = wtOf('w-on');
    const fd = fakeDir();
    fs.writeFileSync(path.join(fd, 'ask-select'), '');
    const x = endOf(start('on', w, CFG, fd), CFG);
    const H = head(w);
    const ha = heavyAnswers(fd);
    const calls = ha.map((c) => c.call).sort();
    const full = ha.map((c) => c.answers[0]).filter(Boolean), argvGa = ha.map((c) => c.answers[1]).filter(Boolean);
    const sel = ha.map((c) => c.answers[2]).filter(Boolean);
    ok('TA1 the task is done: prog -> the conductor\'s own full run on the programmer\'s HEAD (the suite once) -> tester -> review',
      !!x.r && x.r.status === 'done' && runs('w-on').length === 1 && new RegExp(`exit 0 on ${H}`).test(String(x.r.full || '')), why(x) + text(CALLS));
    ok('TA1 the wrapper asked the heavy channel in a prog and in a test call', calls.some((c) => /^prog/.test(c)) && calls.some((c) => /^test/.test(c)), J(calls));
    ok('TA1/A1 every --kind full of prog and test: refused before the queue, not the environment, naming the workflow\'s full run and the next step, no hint to --kind full',
      full.length >= 2 && full.every((a) => a.state === 'refused' && !/^environment:/.test(a.why || '') && WF.test(a.why || '') && /new and touched guards/.test(a.why || '') && !/--kind full/.test(a.why || '')), J(full));
    ok('TA1/A3\' every argv with guards-all.sh: refused, not the environment, no hint to --kind full',
      argvGa.length >= 2 && argvGa.every((a) => a.state === 'refused' && !/^environment:/.test(a.why || '') && !/--kind full/.test(a.why || '') && WF.test(a.why || '')), J(argvGa));
    const jr = journal('on');
    ok('TA1 the heavy journal: the refusals are recorded (refused), no request was queued, no slot was held',
      jr.filter((e) => e.ev === 'refused').length >= 6 && !jr.some((e) => e.ev === 'queued') && !jr.some((e) => e.ev === 'holding'), J(jr));
    const pg = (starts(fd, K_PROG)[0] || {}).prompt || '', ts = (starts(fd, K_TEST)[0] || {}).prompt || '';
    ok('TA1/F26e+F26d the stdin of prog: the body\'s phrase, the workflow\'s full run in the host section, no --kind full',
      /When the workflow prompt says the workflow runs the full guard run on your HEAD, run no full run of your own/.test(pg) && WF.test(pg) && !/--kind full/.test(pg), pg.slice(-600));
    ok('TA1/F26e+F26d the stdin of test: the body\'s phrase, the workflow\'s full run in the host section, no --kind full',
      /When the workflow prompt says the workflow ran the full guard run on the HEAD you test, run no full run at all/.test(ts) && WF.test(ts) && !/--kind full/.test(ts), ts.slice(-600));
    ok('TA1s/R1 every --kind select of prog and test under the mark: refused before the queue, not the environment, naming the workflow\'s run and no guard kind',
      sel.length >= 2 && sel.length === ha.length && sel.every((a) => a.state === 'refused' && !/^environment:/.test(a.why || '') && WF.test(a.why || '') && !/--kind/.test(a.why || '')), J(sel));
    ok('TA1s/R1 the argv refusal under the mark hints no --kind select', argvGa.every((a) => !/--kind select/.test(a.why || '')), J(argvGa));
    ok('TA1s/R1 the stdin of prog and test under the mark offers no --kind select and no local selection',
      !/--kind select|local selection/.test(pg) && !/--kind select|local selection/.test(ts), pg.slice(-600) + ts.slice(-600));
  }

  // ---- TA2: conductorFullRun false - no mark, the earlier path of the channel
  {
    const w = wtOf('w-off');
    const fd = fakeDir();
    const cfg = cfgFile('cfg-off', { conductorFullRun: false });
    const x = endOf(start('off', w, cfg, fd), cfg);
    const ha = heavyAnswers(fd);
    const full = ha.map((c) => c.answers[0]).filter(Boolean), argvGa = ha.map((c) => c.answers[1]).filter(Boolean);
    const jr = journal('off');
    ok('TA2 conductorFullRun false: the task ends with no full run step of the conductor (the suite never ran)', !!x.r && runs('w-off').length === 0 && !fs.existsSync(path.join(x.runDir || T, 'steps', 'off', 'wait-full-1.guards.txt')), why(x));
    ok('TA2/A2\' --kind full of the role is queued as before (heavy.jsonl queued, kind full), not refused by the mark',
      jr.some((e) => e.ev === 'queued' && e.kind === 'full') && !full.some((a) => WF.test(a.why || '')), J(jr) + J(full));
    ok('TA2/A3 argv with guards-all.sh without the mark: the earlier "environment: ... | --kind full"',
      argvGa.length >= 1 && argvGa.every((a) => a.state === 'refused' && /^environment: guards-all\.sh runs through the channel: .*--kind full/.test(a.why || '')), J(argvGa));
    ok('TA2 the stdin of prog offers --kind full (host section as before)', /heavy-req\.js --kind full/.test((starts(fd, K_PROG)[0] || {}).prompt || ''));
    ok('TA2/R1 without the mark the stdin of prog still offers --kind select --base <ref>', /heavy-req\.js --kind select --base <ref>/.test((starts(fd, K_PROG)[0] || {}).prompt || ''));
  }

  // ---- TR: a stop during the full run step -> resolve retry -> the step again, not the programmer
  {
    const w = wtOf('w-res');
    const fd = fakeDir();
    fs.writeFileSync(`${HOLD}-w-res`, '1');
    const s = start('res', w, CFG, fd);
    const runDir = s.j && s.j.runDir;
    const jfile = runDir ? path.join(runDir, 'journal', 'res') : '';
    const inFull = await until(() => runs('w-res').length >= 1, 120000);
    const H = head(w);
    const stop = runDir ? cr(['stop', runDir, '--config', CFG], s.e) : { status: null, stdout: '', stderr: 'no run' };
    const end1 = endOf(s, CFG);
    fs.rmSync(`${HOLD}-w-res`, { force: true });
    // the wait step lives on after the stop (the conductor does not kill it): let it finish
    const finished = await until(() => { const m = (() => { try { return JSON.parse(text(path.join(SHARED, 'guards-w-res.txt.meta.json'))); } catch { return null; } })(); return m && m.rc === 0 && m.head === H ? m : null; }, 90000);
    ok('TR setup: the conductor was stopped while its full run step ran on the programmer\'s HEAD; the step itself finished green',
      !!inFull && stop.status === 0 && !!end1.r && end1.r.status !== 'done' && !!finished, `${stop.status} ${stop.stdout} ${stop.stderr} ${why(end1)} ${J(finished)}`);
    const lst = cr(['resolve', '--list', '--task', 'res', '--config', CFG], s.e);
    let L = null;
    try { L = JSON.parse(lst.stdout); } catch { /* below */ }
    const st = runDir ? (() => { try { return JSON.parse(cr(['status', runDir, '--config', CFG], s.e).stdout); } catch { return null; } })() : null;
    const basis = st && st.tasks && st.tasks.res && st.tasks.res.basis;
    // the open step: the last intent with label run:res:full-*
    const seg = fs.existsSync(jfile) ? fs.readdirSync(jfile).filter((f) => /^seg-/.test(f)).sort().map((f) => text(path.join(jfile, f))).join('') : '';
    const intents = seg.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).filter((e) => e.type === 'intent' && /^run:res:full-1(#retry)?$/.test(e.label || ''));
    const n = intents.length ? intents[intents.length - 1].n : null;
    const r = n ? cr(['resolve', runDir, '--task', 'res', '--as', 'retry', '--step', String(n), '--basis', String(basis), '--note', 'the full run step was stopped'], s.e) : { status: null, stderr: 'no full step intent', stdout: '' };
    const dec = n ? (() => { try { return JSON.parse(text(path.join(runDir, 'resolved', 'res', `${n}.json`))); } catch { return null; } })() : null;
    ok('TR resolve --as retry on the stopped step run:res:full-1: resumeAt tester at the programmer\'s HEAD, not a programmer round',
      r.status === 0 && !!dec && dec.next && dec.next.resumeAt === 'tester' && dec.next.head === H, `${r.status} ${r.stderr} ${J(dec)} ${J(L)} basis ${basis} n ${n}`);
    const s2 = start('res', w, CFG, fd, dec && dec.next ? { resumeAt: dec.next.resumeAt, head: dec.next.head } : {});
    const x2 = endOf(s2, CFG);
    ok('TR the next start: the full run step first (guards-all.sh reuses the green run of that HEAD, the suite does not run again), then tester and review: done',
      !!x2.r && x2.r.status === 'done' && runs('w-res').length === 1 && new RegExp(`exit 0 on ${H}`).test(String(x2.r.full || '')) && fs.existsSync(path.join(x2.runDir, 'steps', 'res', 'wait-full-1.guards.txt')), why(x2) + text(CALLS) + s2.out);
    ok('TR the programmer was called once over both runs (the retry did not start a programmer round)', starts(fd, K_PROG).length === 1 && starts(fd, K_TEST).length === 1, J(trace(fd).filter((c) => c.ev === 'start').map((c) => c.key)));
  }
  done();
})().catch((e) => { console.log('  FAIL threw - ' + ((e && e.stack) || e)); process.exit(1); });
