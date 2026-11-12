'use strict';
// p-codex-D2b-1b: `analysis-check.js run`, the only way the coordinator on Codex starts the analysis checker (the fourth
// execpolicy rule of the coordinator home lets out `node <plugin>/scripts/analysis-check.js run`). Run by
// tests/analysis-check.test.js as a child with its own tally (the README count of test files stays). Cells M4-1...M4-7c
// and N1-N17 of p-codex-D2b-1b/analyst.md (mechanism M4 over the journal M2.2), deterministic: a fake `codex` first in
// PATH writes the answer of a fixture to its -o file, logs its argv, reads its stdin to the end before anything else
// (as `codex exec` does with a prompt and a stdin that is not a terminal), waits for a gate file when one is named, and
// exits with the code of the fixture or 128+signal; a fake `ps` that refuses stands for the sandbox. No model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'analysis-check.js');
const PLUGIN = path.join(__dirname, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codis-acr-')));
const kids = new Set();
process.on('exit', () => {
  for (const pid of kids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---- the fakes ----
const BIN = path.join(TMP, 'bin'), NOPS = path.join(TMP, 'nops');
fs.mkdirSync(BIN); fs.mkdirSync(NOPS);
fs.writeFileSync(path.join(BIN, 'codex'), `#!${process.execPath}
'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) process.on(sig, () => process.exit(code));
process.stdout.write('fake codex on stdout\\n');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: a, pid: process.pid, stdin: input.length }) + '\\n');
  const o = a[a.indexOf('-o') + 1];
  const ans = process.env.FAKE_CODEX_ANSWER;
  if (ans && fs.existsSync(ans)) fs.writeFileSync(o, fs.readFileSync(ans));
  const finish = () => process.exit(+(process.env.FAKE_CODEX_EXIT || 0));
  const gate = process.env.FAKE_CODEX_GATE;
  if (!gate) return finish();
  const t = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(t); finish(); } }, 30);
});
process.stdin.resume();
`, { mode: 0o755 });
fs.writeFileSync(path.join(NOPS, 'ps'), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });

// ---- fixtures ----
let seq = 0;
function fresh() {
  const S = path.join(TMP, 's' + (++seq));
  const feat = path.join(S, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  const A = path.join(feat, 'analyst.md');
  fs.writeFileSync(A, `# Analysis ${seq}\n`);
  const WT = path.join(TMP, 'wt' + seq);
  fs.mkdirSync(WT, { recursive: true });
  const c = { S, A, WT, sha: sha(fs.readFileSync(A)), log: path.join(TMP, `log${seq}.jsonl`), gate: path.join(TMP, `gate${seq}`), ans: path.join(TMP, `ans${seq}.json`) };
  c.dir = path.join(S, 'analysis-checks', c.sha);
  c.runs = path.join(c.dir, 'runs');
  return c;
}
const reportText = (s, tasks, verdict, gaps) => `# Analysis check\nAnalysis: /abs/analyst.md\nAnalysis-sha256: ${s}\nTasks: ${tasks.join(', ')}\n`
  + `Verdict: ${verdict}\nSignificant gaps: ${gaps}\n\n## Gaps\nnone\n`;
const answer = (s, tasks, verdict, gaps) => JSON.stringify({ analysisSha256: s, tasks, verdict, significantGaps: gaps, report: reportText(s, tasks, verdict, gaps) });
const parse = (status, stdout, stderr, signal) => { let out = null; try { out = JSON.parse(stdout); } catch { /* not JSON */ } return { code: status, signal, out, stdout: stdout || '', stderr: stderr || '', all: (stdout || '') + (stderr || '') }; };
const baseEnv = () => { const e = Object.assign({}, process.env); delete e.CODEX_SANDBOX; delete e.CODIS_AGENTS_CONFIG; delete e.FAKE_CODEX_EXIT; return e; };
const envOf = (c, over) => Object.assign(baseEnv(), { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CODEX_LOG: c.log, FAKE_CODEX_ANSWER: c.ans }, over || {});
const script = (args, env) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: env || baseEnv(), timeout: 30000 }); return parse(r.status, r.stdout, r.stderr, r.signal); };
const prep = (c, extra) => script(['prepare', '--shared', c.S, '--analysis', c.A, '--task', 't1', '--worktree', c.WT, '--model', 'm1', ...(extra || [])]);
const collect = (c, extra) => script(['collect', '--shared', c.S, '--analysis', c.A, ...(extra || [])]);
const RUN = (c, n) => ['run', '--shared', c.S, '--analysis', c.A, '--sha', c.sha, '--run', String(n || 1)];
const runSync = (c, n, env, extra) => script([...RUN(c, n), ...(extra || [])], env || envOf(c));
const calls = (c) => (fs.existsSync(c.log) ? fs.readFileSync(c.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const runOf = (o, n) => ((o && o.runs) || []).find((r) => r.run === n) || null;
const f = (c, n, s) => path.join(c.runs, `${n}.${s}`);
const readJ = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const listDir = (d) => { const out = []; const walk = (x) => { let es = []; try { es = fs.readdirSync(x).sort(); } catch { return; } for (const e of es) { const p = path.join(x, e); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out.push(path.relative(d, p) + ':' + (st.isSymbolicLink() ? 'link' : sha(fs.readFileSync(p)))); } }; walk(d); return out.join(','); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(30); } return cond(); }
// A process that is gone: its pid, now free, and a start time no process has.
const DEAD_PID = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
const OLD_LSTART = 'Thu Jan  1 00:00:00 1970';

// `run` started in the background with an open stdin that is never closed (the shell tool of codex keeps the stdin of
// a command open): a child that inherits it or gets a pipe of its own waits for input forever, and the deadline turns
// that into a red cell instead of a hung test.
function runAsync(c, env, deadline) {
  const child = spawn(process.execPath, [SCRIPT, ...RUN(c)], { stdio: ['pipe', 'pipe', 'pipe'], env: env || envOf(c) });
  kids.add(child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const x of calls(c)) { try { process.kill(x.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }, deadline || 20000);
  const finished = new Promise((res) => child.on('close', (status, signal) => {
    clearTimeout(timer);
    kids.delete(child.pid);
    res(Object.assign(parse(status, stdout, stderr, signal), { timedOut }));
  }));
  return { child, finished };
}
const started = (c) => waitFor(() => calls(c).length >= 1 && fs.existsSync(f(c, 1, 'running')), 15000);

ok('the script exists', fs.existsSync(SCRIPT));
if (!fs.existsSync(SCRIPT)) done();

(async () => {
  // ---- M4-1, N12, N17: prepare prints the run command; run starts one checker with the fixed argv and records its exit ----
  {
    const c = fresh();
    const p = prep(c);
    ok('N12 prepare: command is `node <this script> run --shared --analysis --sha --run 1` (the plain argv the fourth rule matches)',
      p.code === 0 && p.out && p.out.command === `node ${SCRIPT} run --shared ${c.S} --analysis ${c.A} --sha ${c.sha} --run 1`, p.out && p.out.command);
    ok('N12 prepare: the argv of codex exec stays in the output as reference', p.out && Array.isArray(p.out.argv) && p.out.argv[0] === 'codex' && p.out.argv[1] === 'exec');
    const next = (p.out && p.out.next) || '';
    ok('N12 prepare next: run once, it starts the checker and waits; "still running" - poll that same command; a second run is refused while the run lives and records it as died otherwise; then collect --append; no --exit',
      /once/.test(next) && /starts the checker and waits for it/.test(next) && /still running[^.]*poll that same command/.test(next)
      && /refused while the run lives \(exit 3\)/.test(next) && /died/.test(next) && /collect --run 1 --append/.test(next) && !/--exit/.test(next), next);
    fs.writeFileSync(c.ans, answer(c.sha, ['t1'], 'ready', 0));
    const r = await runAsync(c).finished;
    ok('N17 the checker gets no open stdin (stdin /dev/null): run ends while its own stdin stays open', !r.timedOut, r.all.slice(0, 400));
    ok('M4-1 run: exit 0, stdout is only its JSON (the checker writes to stderr)', r.code === 0 && !!r.out && !/fake codex on stdout/.test(r.stdout) && /fake codex on stdout/.test(r.stderr), r.all.slice(0, 600));
    const cs = calls(c);
    ok('M4-1 exactly one codex exec, with the argv of the template (= the argv prepare printed)', cs.length === 1 && JSON.stringify(['codex', ...cs[0].argv]) === JSON.stringify(p.out && p.out.argv), JSON.stringify(cs));
    const running = readJ(f(c, 1, 'running'));
    ok('M4-1 runs/1.running {pid, lstart} names the run process', !!running && running.pid === r.child.pid && typeof running.lstart === 'string' && running.lstart.length > 0, JSON.stringify(running));
    ok('M4-1 runs/1.exit is 0, recorded by run', fs.existsSync(f(c, 1, 'exit')) && fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() === '0');
    ok('M4-1 the answer is observed: runs/1.answers/1.json, run 1 a result, the output names exit 0',
      fs.existsSync(path.join(c.runs, '1.answers', '1.json')) && runOf(r.out, 1) && runOf(r.out, 1).state === 'result' && r.out.exit === 0, JSON.stringify(r.out && r.out.runs));
    ok('M4-1 run next: collect --run 1 --append unless the snapshot after voids the check', r.out && /collect --run 1 --append/.test(r.out.next || '') && /snapshot after/.test(r.out.next || ''), r.out && r.out.next);
    ok('N9 runs/1.running is not an unknown file', !/unknown file/.test(collect(c).all));
    const again = runSync(c);
    ok('M4-4 run of a run with a result: exit 3 "has a result", no second codex exec', again.code === 3 && /has a result/.test(again.all) && calls(c).length === 1, again.all.slice(0, 300));
  }
  // ---- M4-1b: exit 0 without an answer ----
  {
    const c = fresh();
    prep(c);
    const r = await runAsync(c).finished;
    ok('M4-1b codex exec ended 0 without runs/1.json: not-run "exit 0, no runs/1.json"', r.code === 0 && runOf(r.out, 1) && runOf(r.out, 1).state === 'not-run'
      && /exit 0, no runs\/1\.json/.test(runOf(r.out, 1).reason), r.all.slice(0, 400));
    ok('M4-1b prepare is not blocked: run 2', prep(c).out.run === 2);
  }
  // ---- M4-1c: exit other than 0 with a valid file: the exit is recorded before the answer is observed ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(c.ans, answer(c.sha, ['t1'], 'ready', 0));
    const r = await runAsync(c, envOf(c, { FAKE_CODEX_EXIT: '2' })).finished;
    ok('M4-1c exit 2 with a valid runs/1.json: runs/1.exit 2, nothing in the journal, not-run "exit 2"', r.code === 0 && r.out && r.out.exit === 2
      && fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() === '2' && !fs.existsSync(path.join(c.runs, '1.answers', '1.json'))
      && runOf(r.out, 1).state === 'not-run' && /exit 2/.test(runOf(r.out, 1).reason), r.all.slice(0, 400));
    ok('M4-1c prepare makes run 2', prep(c).out.run === 2);
  }
  // ---- M4-2, M4-3b, N5, N10 (a): a second run while the first lives ----
  {
    const c = fresh();
    prep(c);
    const first = runAsync(c, envOf(c, { FAKE_CODEX_GATE: c.gate }));
    const up = await started(c);
    ok('M4-2 the first run started the checker', up);
    const before = listDir(c.runs);
    const second = runSync(c);
    ok('M4-2 a second run --run 1 while the first lives: exit 3 "is running as pid P since L", it runs elsewhere and is never started twice', second.code === 3
      && new RegExp(`run 1 is running as pid ${first.child.pid} since`).test(second.all) && /another turn or session/.test(second.all) && /never starts a second checker/.test(second.all), second.all.slice(0, 400));
    ok('M4-2 no second codex exec, the files of the run unchanged', calls(c).length === 1 && listDir(c.runs) === before, `${calls(c).length} ${listDir(c.runs)}`);
    const col = collect(c);
    const r1 = runOf(col.out, 1);
    ok('M4-3b collect in the sandbox: pending, the run named with its pid, "whether it lives cannot be told here", no runs/1.died', !!r1 && r1.state === 'prepared'
      && r1.running && r1.running.pid === first.child.pid && /whether it lives cannot be told here/.test(JSON.stringify(r1)) && !fs.existsSync(f(c, 1, 'died')), JSON.stringify(r1));
    const pp = prep(c);
    ok('M4-3b prepare refuses as pending; the refusal names the run command and that running it again is refused while it lives', pp.code === 3
      && pp.all.includes(`node ${SCRIPT} run --shared ${c.S} --analysis ${c.A} --sha ${c.sha} --run 1`) && /refused while the run lives/.test(pp.all) && !/never run it again/.test(pp.all), pp.all.slice(0, 500));
    const ab = prep(c, ['--abandon', '1', '--reason', 'x']);
    ok('N10 (a) --abandon 1 while runs/1.running has no runs/1.died: refused (exit 3), no runs/1.abandoned, no run 2', ab.code === 3 && /analysis-check\.js run/.test(ab.all)
      && !fs.existsSync(f(c, 1, 'abandoned')) && !fs.existsSync(f(c, 2, 'prepared')), ab.all.slice(0, 300));
    const ex = collect(c, ['--run', '1', '--exit', '0']);
    ok('N5 collect --run 1 --exit while runs/1.running exists: refused (exit 3), "recorded by analysis-check.js run", no runs/1.exit', ex.code === 3
      && /recorded by analysis-check\.js run/.test(ex.all) && !fs.existsSync(f(c, 1, 'exit')), ex.all.slice(0, 300));
    fs.writeFileSync(c.gate, '');
    const r = await first.finished;
    ok('M4-2 the first run ends with its own exit recorded (0)', r.code === 0 && !r.timedOut && fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() === '0', r.all.slice(0, 300));
  }
  // ---- M4-2b: a marker being written is never taken for a dead run ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'running'), '');
    const r = runSync(c);
    ok('M4-2b runs/1.running not readable yet: exit 3 "is being started", no runs/1.died, no codex exec', r.code === 3 && /being started/.test(r.all)
      && !fs.existsSync(f(c, 1, 'died')) && calls(c).length === 0, r.all.slice(0, 300));
  }
  // ---- M4-3, N9, N10 (b): a dead run is recorded as died by run, and prepare goes on without --abandon ----
  for (const [name, mk] of [['no such process', () => ({ pid: DEAD_PID, lstart: OLD_LSTART })], ['another process with that pid (a start time of its own)', () => ({ pid: process.pid, lstart: OLD_LSTART })]]) {
    const c = fresh();
    prep(c);
    const m = mk();
    fs.writeFileSync(f(c, 1, 'running'), JSON.stringify(m));
    const r = runSync(c);
    const died = readJ(f(c, 1, 'died'));
    ok(`M4-3 (${name}) run: exit 3 "died", runs/1.died {pid, lstart}, no codex exec`, r.code === 3 && /run 1 died/.test(r.all) && !!died && died.pid === m.pid
      && died.lstart === m.lstart && calls(c).length === 0, r.all.slice(0, 300) + JSON.stringify(died));
    const col = collect(c);
    ok(`M4-3 (${name}) collect: not-run "died (pid ...)"; N9 runs/1.died is no unknown file`, runOf(col.out, 1) && runOf(col.out, 1).state === 'not-run'
      && /died \(pid/.test(runOf(col.out, 1).reason) && !/unknown file/.test(col.all), col.all.slice(0, 400));
    const ab = prep(c, ['--abandon', '1', '--reason', 'x']);
    ok(`N10 (b) (${name}) --abandon of a died run: refused "not pending"`, ab.code === 3 && /not pending/.test(ab.all), ab.all.slice(0, 200));
    const again = runSync(c);
    ok(`M4-4 (${name}) run of a died run: exit 3 "not pending", no codex exec`, again.code === 3 && /not pending/.test(again.all) && calls(c).length === 0, again.all.slice(0, 200));
    const p2 = prep(c);
    ok(`M4-3 (${name}) prepare after died: run 2 without --abandon`, p2.code === 0 && p2.out.run === 2, p2.all.slice(0, 300));
  }
  // ---- M4-3c: a dead run whose checker wrote an answer: the journal comes first ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'running'), JSON.stringify({ pid: DEAD_PID, lstart: OLD_LSTART }));
    fs.writeFileSync(f(c, 1, 'json'), answer(c.sha, ['t1'], 'changes-needed', 1));
    const r = runSync(c);
    ok('M4-3c dead run with an answer: exit 3 "has a result", no runs/1.died, the answer in the journal, no codex exec', r.code === 3 && /has a result/.test(r.all)
      && !fs.existsSync(f(c, 1, 'died')) && fs.existsSync(path.join(c.runs, '1.answers', '1.json')) && calls(c).length === 0, r.all.slice(0, 300));
  }
  // ---- M4-4: run of a run that is not pending ----
  {
    const cases = [
      ['a result whose file is gone', (c) => { fs.writeFileSync(f(c, 1, 'json'), answer(c.sha, ['t1'], 'ready', 0)); collect(c); fs.unlinkSync(f(c, 1, 'json')); }, /has a result/],
      ['not-run: exit 2', (c) => { collect(c, ['--run', '1', '--exit', '2']); }, /not pending \(not-run: exit 2/],
      ['abandoned', (c) => { prep(c, ['--abandon', '1', '--reason', 'gone']); }, /not pending \(not-run: abandoned/],
      ['a file that is not a verdict', (c) => { fs.writeFileSync(f(c, 1, 'json'), 'oops'); }, /not pending \(not-run: runs\/1\.json is not JSON/],
    ];
    for (const [name, set, re] of cases) {
      const c = fresh();
      prep(c);
      set(c);
      const before = listDir(c.runs);
      const r = runSync(c);
      ok(`M4-4 ${name}: run exits 3 (${re.source}), no codex exec, the files of the run unchanged`, r.code === 3 && re.test(r.all) && calls(c).length === 0
        && listDir(c.runs) === before && !fs.existsSync(f(c, 1, 'running')), r.all.slice(0, 300));
    }
  }
  // ---- M4-4b: no such run, a run never prepared, no folder for --sha ----
  {
    const c = fresh();
    prep(c);
    const r9 = runSync(c, 9);
    ok('M4-4b run --run 9: exit 3 "no run 9"', r9.code === 3 && /no run 9/.test(r9.all), r9.all.slice(0, 200));
    fs.writeFileSync(f(c, 7, 'exit'), '0\n');
    const r7 = runSync(c, 7);
    ok('M4-4b a number without runs/<n>.prepared: exit 3 "was not prepared"', r7.code === 3 && /run 7 was not prepared/.test(r7.all) && calls(c).length === 0, r7.all.slice(0, 200));
    const rs = script(['run', '--shared', c.S, '--analysis', c.A, '--sha', 'a'.repeat(64), '--run', '1'], envOf(c));
    ok('M4-4b --sha without its folder: exit 65 "no check folder"', rs.code === 65 && /no check folder/.test(rs.all), rs.all.slice(0, 200));
  }
  // ---- M4-5: run inside the sandbox (ps refused) ----
  for (const sandbox of ['seatbelt', null]) {
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'json'), answer(c.sha, ['t1'], 'ready', 0));
    const env = envOf(c, { PATH: `${NOPS}${path.delimiter}${BIN}${path.delimiter}${process.env.PATH}` });
    if (sandbox) env.CODEX_SANDBOX = sandbox;
    const r = runSync(c, 1, env);
    ok(`M4-5 ps refused${sandbox ? ' (CODEX_SANDBOX set)' : ''}: exit 69 naming ps -o lstart= and the plain argv; ${sandbox ? 'CODEX_SANDBOX named' : 'no CODEX_SANDBOX named'}`, r.code === 69
      && /ps -o lstart=/.test(r.all) && r.all.includes(`node ${SCRIPT} run`) && (sandbox ? /CODEX_SANDBOX=seatbelt/.test(r.all) : !/CODEX_SANDBOX/.test(r.all)), r.all.slice(0, 500));
    ok(`M4-5${sandbox ? '' : ' (no CODEX_SANDBOX)'} nothing written and nothing observed before the refusal: no runs/1.running, no journal, no codex exec`,
      !fs.existsSync(f(c, 1, 'running')) && !fs.existsSync(path.join(c.runs, '1.answers')) && calls(c).length === 0);
  }
  // ---- M4-7a: a signal to run reaches the checker; the exit is recorded ----
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const c = fresh();
    prep(c);
    const first = runAsync(c, envOf(c, { FAKE_CODEX_GATE: c.gate }), 15000);
    await started(c);
    first.child.kill(sig);
    const r = await first.finished;
    ok(`M4-7a ${sig} to run: passed to the checker, run waits for it and records its exit ${code}: not-run "exit ${code}, no runs/1.json"`, !r.timedOut && r.code === 0
      && fs.existsSync(f(c, 1, 'exit')) && fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() === String(code)
      && runOf(r.out, 1) && /exit \d+, no runs\/1\.json/.test(runOf(r.out, 1).reason || ''), `${r.timedOut ? 'timed out ' : ''}${r.code} ${r.all.slice(0, 300)}`);
  }
  // ---- M4-7b: run and the checker killed (the end of the turn): pending until the next run records died ----
  {
    const c = fresh();
    prep(c);
    const first = runAsync(c, envOf(c, { FAKE_CODEX_GATE: c.gate }), 15000);
    await started(c);
    for (const x of calls(c)) { try { process.kill(x.pid, 'SIGKILL'); } catch { /* gone */ } }
    first.child.kill('SIGKILL');
    await first.finished;
    const col = collect(c);
    ok('M4-7b run and the checker killed: no runs/1.exit, run 1 pending with the note', !fs.existsSync(f(c, 1, 'exit')) && runOf(col.out, 1) && runOf(col.out, 1).state === 'prepared'
      && /cannot be told here/.test(JSON.stringify(runOf(col.out, 1))), col.all.slice(0, 300));
    const r = runSync(c);
    ok('M4-7b the next run records died', r.code === 3 && /died/.test(r.all) && fs.existsSync(f(c, 1, 'died')) && calls(c).length === 1, r.all.slice(0, 300));
  }
  // ---- M4-7c: the checker outlived its run and wrote an answer after died ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'running'), JSON.stringify({ pid: DEAD_PID, lstart: OLD_LSTART }));
    runSync(c);
    fs.writeFileSync(f(c, 1, 'json'), answer(c.sha, ['t1'], 'changes-needed', 1));
    const col = collect(c);
    const r1 = runOf(col.out, 1);
    ok('M4-7c an answer after died: a result, "exit not recorded" and "late, after died"', !!r1 && r1.state === 'result' && /exit not recorded/.test(JSON.stringify(r1))
      && /late, after died/.test(JSON.stringify(r1)), JSON.stringify(r1));
  }
  // ---- N1, N2: the argv of the marker is never run; it must equal the template of this plugin ----
  {
    const variants = [
      ['an extra argument', (a) => a.concat(['--dangerously-bypass-approvals-and-sandbox'])],
      ['another -o', (a) => { const b = a.slice(); b[b.indexOf('-o') + 1] = path.join(TMP, 'elsewhere.json'); return b; }],
      ['another binary', (a) => ['sh'].concat(a.slice(1))],
      ['a relative worktree', (a) => { const b = a.slice(); b[b.indexOf('-C') + 1] = 'wt'; return b; }],
      ['a worktree that is no folder', (a) => { const b = a.slice(); b[b.indexOf('-C') + 1] = path.join(TMP, 'no-such-dir'); return b; }],
      ['a worktree that starts with -', (a) => { const b = a.slice(); b[b.indexOf('-C') + 1] = '-c'; return b; }],
      ['a model with a space', (a) => { const b = a.slice(); b[b.indexOf('-m') + 1] = 'm 1'; return b; }],
      ['a model that starts with -', (a) => { const b = a.slice(); b[b.indexOf('-m') + 1] = '-c'; return b; }],
      ['no argv', () => null],
    ];
    for (const [name, change] of variants) {
      const c = fresh();
      prep(c);
      const mark = readJ(f(c, 1, 'prepared'));
      mark.argv = change(mark.argv);
      fs.writeFileSync(f(c, 1, 'prepared'), JSON.stringify(mark));
      const r = runSync(c);
      ok(`N1 the marker holds ${name}: exit 65 "does not hold the argv of this plugin", no runs/1.running, no codex exec`, r.code === 65
        && /does not hold the argv of this plugin/.test(r.all) && !fs.existsSync(f(c, 1, 'running')) && calls(c).length === 0, r.all.slice(0, 300));
    }
    const c = fresh();
    prep(c);
    const mark = readJ(f(c, 1, 'prepared'));
    mark.argv[mark.argv.indexOf('--output-schema') + 1] = '/another/copy/0.4.43/schemas/analysis-check.schema.json';
    fs.writeFileSync(f(c, 1, 'prepared'), JSON.stringify(mark));
    const r = runSync(c);
    ok('N2 a marker of another copy of the plugin: exit 65, "prepare --abandon 1 --reason <why>, then prepare"', r.code === 65 && /prepare --abandon 1 --reason/.test(r.all) && calls(c).length === 0, r.all.slice(0, 300));
    const ab = prep(c, ['--abandon', '1', '--reason', 'another plugin']);
    ok('N2 then --abandon 1 passes (the run is pending, never started)', ab.code === 0 && ab.out.run === 2, ab.all.slice(0, 300));
  }
  // ---- N3: run takes only --shared --analysis --sha --run ----
  {
    const extras = [['--dangerously-bypass-approvals-and-sandbox'], ['-c', 'x'], ['--task', 't1'], ['--append'], ['--exit', '0'], ['--worktree', TMP], ['--model', 'm'], ['--again', 'x'], ['--abandon', '1']];
    const c = fresh();
    prep(c);
    const bad = extras.filter((e) => { const r = runSync(c, 1, null, e); return r.code !== 64; });
    ok('N3 run with any other argument: exit 64', bad.length === 0, JSON.stringify(bad));
    const missing = [['--shared'], ['--analysis'], ['--sha'], ['--run']].filter(([flag]) => {
      const a = RUN(c); const i = a.indexOf(flag); a.splice(i, 2); return script(a, envOf(c)).code !== 64;
    });
    ok('N3 run without one of its four arguments: exit 64', missing.length === 0, JSON.stringify(missing));
    ok('N3 nothing written, no codex exec', !fs.existsSync(f(c, 1, 'running')) && calls(c).length === 0);
  }
  // ---- N4: a symbolic link on the path run writes through is refused before anything is written ----
  {
    const cases = [
      ['the version folder', (c) => { const real = path.join(TMP, `real-${path.basename(c.S)}`); fs.renameSync(c.dir, real); fs.symlinkSync(real, c.dir); return real; }],
      ['runs/', (c) => { const real = path.join(TMP, `realruns-${path.basename(c.S)}`); fs.renameSync(c.runs, real); fs.symlinkSync(real, c.runs); return real; }],
      ['runs/1.answers', (c) => { const out = path.join(TMP, `out-${path.basename(c.S)}`); fs.mkdirSync(out); fs.symlinkSync(out, path.join(c.runs, '1.answers')); fs.writeFileSync(f(c, 1, 'json'), answer(c.sha, ['t1'], 'ready', 0)); return out; }],
      ['runs/1.json (dangling)', (c) => { const out = path.join(TMP, `dangling-${path.basename(c.S)}.json`); fs.symlinkSync(out, f(c, 1, 'json')); return path.dirname(out); }],
      ['runs/1.json (to a file)', (c) => { const out = path.join(TMP, `file-${path.basename(c.S)}.json`); fs.writeFileSync(out, answer(c.sha, ['t1'], 'ready', 0)); fs.symlinkSync(out, f(c, 1, 'json')); return null; }],
    ];
    for (const [name, set] of cases) {
      const c = fresh();
      prep(c);
      const target = set(c);
      const before = target ? listDir(target) : '';
      const r = runSync(c);
      ok(`N4 ${name} is a symbolic link: exit 65, nothing written through it, no codex exec`, r.code === 65 && /symbolic link/.test(r.all) && calls(c).length === 0
        && !fs.existsSync(f(c, 1, 'running')) && (!target || listDir(target) === before), r.all.slice(0, 300));
    }
  }
  // ---- N6: an exit recorded already is never replaced; both codes named ----
  {
    let AC = null;
    try { AC = require(SCRIPT); } catch { /* red above */ }
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'exit'), '5\n');
    const note = AC && typeof AC.recordExit === 'function' ? AC.recordExit(c.dir, 1, 0) : null;
    ok('N6 recordExit on a runs/1.exit recorded already: the file unchanged, the note names both codes', fs.readFileSync(f(c, 1, 'exit'), 'utf8') === '5\n'
      && /recorded 5, codex exec ended with 0/.test(String(note)), String(note));
  }
  // ---- N7: an answer observed before run records the exit; a later exit other than 0 leaves it a verdict ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(c.ans, answer(c.sha, ['t1'], 'changes-needed', 1));
    const first = runAsync(c, envOf(c, { FAKE_CODEX_GATE: c.gate, FAKE_CODEX_EXIT: '2' }));
    await started(c);
    await waitFor(() => fs.existsSync(f(c, 1, 'json')), 5000);
    const col = collect(c);
    ok('N7 collect while the checker runs sees its answer: result', runOf(col.out, 1) && runOf(col.out, 1).state === 'result', col.all.slice(0, 300));
    fs.writeFileSync(c.gate, '');
    const r = await first.finished;
    ok('N7 then exit 2: still a result, "exit 2 recorded after answer 1"', r.code === 0 && runOf(r.out, 1) && runOf(r.out, 1).state === 'result'
      && /exit 2 recorded after answer 1/.test(JSON.stringify(runOf(r.out, 1))), r.all.slice(0, 400));
  }
  // ---- N8: codex cannot be started ----
  {
    const c = fresh();
    prep(c);
    const r = runSync(c, 1, envOf(c, { PATH: '/bin:/usr/bin' }));
    ok('N8 no codex in PATH: exit 0, runs/1.exit 127, not-run "exit 127, no runs/1.json", the error named', r.code === 0 && r.out && r.out.exit === 127
      && fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() === '127' && /exit 127, no runs\/1\.json/.test(runOf(r.out, 1).reason) && /ENOENT/.test(r.all), r.all.slice(0, 400));
    ok('N8 prepare makes run 2', prep(c).out.run === 2);
  }
  // ---- N5 without a live run: runs/1.running of a dead run still refuses collect --exit ----
  {
    const c = fresh();
    prep(c);
    fs.writeFileSync(f(c, 1, 'running'), JSON.stringify({ pid: DEAD_PID, lstart: OLD_LSTART }));
    const ex = collect(c, ['--run', '1', '--exit', '0']);
    ok('N5 collect --exit with runs/1.running of a dead run: refused, no runs/1.exit', ex.code === 3 && !fs.existsSync(f(c, 1, 'exit')), ex.all.slice(0, 200));
  }
  done();
})();
