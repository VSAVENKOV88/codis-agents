'use strict';
// p-codex-D2b-1b tester cells of `analysis-check.js run`, run by tests/analysis-check.test.js as a child with its own
// tally (so the README count of test files stays). Cells beyond tests/analysis-check-run-cases.js: a checker that a
// signal ends by itself (its exit is 128+signal, not a code it chose), a repeated argument and a value that is not a run
// number or a sha256 (64 before anything is read or written), a version folder, runs/ or runs/<n>.answers that is a
// file and not a folder (65), and a relative --shared resolved against the working directory (the argv of the marker,
// written with the absolute path, still equals the template). A fake `codex` first in PATH; no model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'analysis-check.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codis-acrt-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// The fake codex reads its stdin to the end, logs its argv, writes the answer of a fixture to -o, then exits with a
// code or ends itself with a signal (FAKE_CODEX_SIGNAL).
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'codex'), `#!${process.execPath}
'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: a }) + '\\n');
  const ans = process.env.FAKE_CODEX_ANSWER;
  if (ans && fs.existsSync(ans)) fs.writeFileSync(a[a.indexOf('-o') + 1], fs.readFileSync(ans));
  if (process.env.FAKE_CODEX_SIGNAL) process.kill(process.pid, process.env.FAKE_CODEX_SIGNAL);
  else process.exit(+(process.env.FAKE_CODEX_EXIT || 0));
});
process.stdin.resume();
`, { mode: 0o755 });

let seq = 0;
function fresh() {
  const S = path.join(TMP, 's' + (++seq));
  fs.mkdirSync(path.join(S, 'feat'), { recursive: true });
  const A = path.join(S, 'feat', 'analyst.md');
  fs.writeFileSync(A, `# Analysis tester ${seq}\n`);
  const WT = path.join(TMP, 'wt' + seq);
  fs.mkdirSync(WT);
  const c = { S, A, WT, sha: sha(fs.readFileSync(A)), log: path.join(TMP, `log${seq}.jsonl`), ans: path.join(TMP, `ans${seq}.json`) };
  c.dir = path.join(S, 'analysis-checks', c.sha);
  c.runs = path.join(c.dir, 'runs');
  return c;
}
const report = (s) => `# Analysis check\nAnalysis: /abs/analyst.md\nAnalysis-sha256: ${s}\nTasks: t1\nVerdict: ready\nSignificant gaps: 0\n\n## Gaps\nnone\n`;
const answer = (s) => JSON.stringify({ analysisSha256: s, tasks: ['t1'], verdict: 'ready', significantGaps: 0, report: report(s) });
const baseEnv = () => { const e = Object.assign({}, process.env); delete e.CODEX_SANDBOX; delete e.CODIS_AGENTS_CONFIG; return e; };
const envOf = (c, over) => Object.assign(baseEnv(), { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CODEX_LOG: c.log, FAKE_CODEX_ANSWER: c.ans }, over || {});
const script = (args, env, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: env || baseEnv(), cwd, timeout: 30000 });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, out, all: (r.stdout || '') + (r.stderr || '') };
};
const prep = (c) => script(['prepare', '--shared', c.S, '--analysis', c.A, '--task', 't1', '--worktree', c.WT, '--model', 'm1']);
const RUN = (c) => ['run', '--shared', c.S, '--analysis', c.A, '--sha', c.sha, '--run', '1'];
const calls = (c) => (fs.existsSync(c.log) ? fs.readFileSync(c.log, 'utf8').split('\n').filter(Boolean).length : 0);
const f = (c, n, s) => path.join(c.runs, `${n}.${s}`);
const runOf = (o, n) => ((o && o.runs) || []).find((r) => r.run === n) || null;
const listDir = (d) => { const out = []; const walk = (x) => { let es = []; try { es = fs.readdirSync(x).sort(); } catch { return; } for (const e of es) { const p = path.join(x, e); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out.push(path.relative(d, p) + ':' + sha(fs.readFileSync(p))); } }; walk(d); return out.join(','); };

ok('the script exists', fs.existsSync(SCRIPT));
if (!fs.existsSync(SCRIPT)) done();

// ---- T1: a checker that a signal ends by itself: its exit is 128+signal ----
for (const [sig, code] of [['SIGKILL', 137], ['SIGTERM', 143]]) {
  const c = fresh();
  prep(c);
  fs.writeFileSync(c.ans, answer(c.sha));
  const r = script(RUN(c), envOf(c, { FAKE_CODEX_SIGNAL: sig }));
  const exit = fs.existsSync(f(c, 1, 'exit')) ? fs.readFileSync(f(c, 1, 'exit'), 'utf8').trim() : null;
  ok(`T1 the checker ended by ${sig} of its own: run exits 0, runs/1.exit ${code}, the output names exit ${code}`, r.code === 0 && exit === String(code) && r.out && r.out.exit === code,
    `${r.code} exit=${exit} ${r.all.slice(0, 300)}`);
  ok(`T1 (${sig}) its answer is not recorded (an exit other than 0 before the run is read): not-run "exit ${code}", empty journal`,
    runOf(r.out, 1) && runOf(r.out, 1).state === 'not-run' && new RegExp(`exit ${code}`).test(runOf(r.out, 1).reason || '') && !fs.existsSync(path.join(c.runs, '1.answers', '1.json')),
    JSON.stringify(runOf(r.out, 1)));
}

// ---- T2: a repeated argument and values that are not a run number or a sha256: 64, nothing read or written ----
{
  const c = fresh();
  prep(c);
  fs.writeFileSync(c.ans, answer(c.sha));
  const before = listDir(c.dir);
  const bad = [
    ['--run twice (same value)', [...RUN(c), '--run', '1']],
    ['--run twice (another value)', [...RUN(c), '--run', '2']],
    ['--sha twice', [...RUN(c), '--sha', c.sha]],
    ['--shared twice', [...RUN(c), '--shared', c.S]],
    ['--run abc', RUN(c).slice(0, -1).concat(['abc'])],
    ['--run -1', RUN(c).slice(0, -1).concat(['-1'])],
    ['--run 1.5', RUN(c).slice(0, -1).concat(['1.5'])],
    ['--sha of 63 hex digits', ['run', '--shared', c.S, '--analysis', c.A, '--sha', c.sha.slice(1), '--run', '1']],
    ['--sha in upper case', ['run', '--shared', c.S, '--analysis', c.A, '--sha', c.sha.toUpperCase(), '--run', '1']],
    ['--sha with a path', ['run', '--shared', c.S, '--analysis', c.A, '--sha', `../${c.sha}`, '--run', '1']],
  ];
  for (const [name, args] of bad) {
    const r = script(args, envOf(c));
    ok(`T2 run with ${name}: exit 64`, r.code === 64, `${r.code} ${r.all.slice(0, 200)}`);
  }
  ok('T2 nothing written and no codex exec after those refusals', listDir(c.dir) === before && !fs.existsSync(f(c, 1, 'running')) && calls(c) === 0);
}

// ---- T3: a version folder, runs/ or runs/<n>.answers that is a file, not a folder: 65 before anything is written ----
{
  const cases = [
    ['runs/', (c) => { const keep = path.join(TMP, `runs-${seq}`); fs.renameSync(c.runs, keep); fs.writeFileSync(c.runs, 'x'); }],
    ['runs/1.answers', (c) => { fs.writeFileSync(path.join(c.runs, '1.answers'), 'x'); fs.writeFileSync(f(c, 1, 'json'), answer(c.sha)); }],
    ['the version folder', (c) => { const keep = path.join(TMP, `ver-${seq}`); fs.renameSync(c.dir, keep); fs.writeFileSync(c.dir, 'x'); }],
  ];
  for (const [name, set] of cases) {
    const c = fresh();
    prep(c);
    set(c);
    const r = script(RUN(c), envOf(c));
    ok(`T3 ${name} is a file: exit 65 "is not a folder", no codex exec`, r.code === 65 && /is not a folder/.test(r.all) && calls(c) === 0, `${r.code} ${r.all.slice(0, 300)}`);
  }
}

// ---- T4: a relative --shared is resolved against the working directory: the run starts with the template ----
{
  const c = fresh();
  prep(c);
  fs.writeFileSync(c.ans, answer(c.sha));
  const r = script(['run', '--shared', path.basename(c.S), '--analysis', path.relative(TMP, c.A), '--sha', c.sha, '--run', '1'], envOf(c), TMP);
  ok('T4 run with a relative --shared and --analysis (cwd their parent): exit 0, one codex exec, a result', r.code === 0 && calls(c) === 1 && runOf(r.out, 1) && runOf(r.out, 1).state === 'result',
    `${r.code} calls=${calls(c)} ${r.all.slice(0, 400)}`);
  const argv = fs.existsSync(c.log) ? JSON.parse(fs.readFileSync(c.log, 'utf8').split('\n')[0]).argv : [];
  ok('T4 the -o of the checker is the absolute runs/1.json', argv[argv.indexOf('-o') + 1] === f(c, 1, 'json'), JSON.stringify(argv));
}

done();
