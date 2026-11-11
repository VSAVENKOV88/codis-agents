#!/usr/bin/env node
'use strict';
// p-codex-D2b-1: scripts/analysis-check.js - the results of the analysis check on Codex are never lost. Every launch of
// the checker is a run of its own, numbered in <sharedDir>/analysis-checks/<sha256>/runs/, prepared by `prepare` (which
// refuses while a result or a pending run exists) and read by `collect` (which shows every run with its state).
// Cells A1-A23 of the analysis (mechanism M2.1), on fixtures in a temporary sharedDir; no codex is started: the answer
// of a run is written by the test into the -o file of the printed command.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'analysis-check.js');
const PLUGIN = ROOT;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-ac-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let seq = 0;
// A fresh sharedDir with a feature folder holding the analysis.
function fresh(text) {
  const S = path.join(TMP, 's' + (++seq));
  const feat = path.join(S, 'feat');
  fs.mkdirSync(feat, { recursive: true });
  const A = path.join(feat, 'analyst.md');
  fs.writeFileSync(A, text || `# Analysis ${seq}\n\nCells A1-A3.\n`);
  const WT = path.join(TMP, 'wt' + seq);
  fs.mkdirSync(WT, { recursive: true });
  return { S, A, WT, feat, sha: sha(fs.readFileSync(A)), report: path.join(feat, 'analyst.check.md') };
}
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
const prep = (c, keys, extra) => run(['prepare', '--shared', c.S, '--analysis', c.A, ...(keys || ['t1']).flatMap((k) => ['--task', k]),
  '--worktree', c.WT, '--model', 'm1', ...(extra || [])]);
const collect = (c, extra) => run(['collect', '--shared', c.S, '--analysis', c.A, ...(extra || [])]);
const reportText = (s, tasks, verdict, gaps, more) => `# Analysis check\nAnalysis: /abs/analyst.md\n${s ? `Analysis-sha256: ${s}\n` : ''}`
  + `Tasks: ${tasks.join(', ')}\nVerdict: ${verdict}\nSignificant gaps: ${gaps}\n\n## Gaps\n${more || 'none'}\n\n## Closure\n<left empty by the checker>\n\nNext step: start\n`;
const answer = (s, tasks, verdict, gaps, over) => Object.assign({ analysisSha256: s, tasks, verdict, significantGaps: gaps,
  report: reportText(s, tasks, verdict, gaps) }, over || {});
// The -o file of the printed command (the answer of codex exec lands there).
const oFile = (p) => { const a = p.out && p.out.argv; return a ? a[a.indexOf('-o') + 1] : null; };
// A missing -o file (a prepare that failed under a mutant) writes nothing: the checks after it fail instead of a crash.
const writeAnswer = (file, obj) => { if (file) fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const runOf = (o, n) => ((o && o.runs) || []).find((r) => r.run === n) || null;
const listDir = (d) => { const out = []; const walk = (x) => { for (const e of fs.readdirSync(x).sort()) { const p = path.join(x, e); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(d, p) + ':' + sha(fs.readFileSync(p))); } }; walk(d); return out; };

ok('the script exists', fs.existsSync(SCRIPT));
if (!fs.existsSync(SCRIPT)) done();

// ---- A21: the run number is claimed with O_EXCL (first: a mutant of claim breaks every flow below) ----
{
  let AC = null;
  try { AC = require(SCRIPT); } catch { /* red before the script */ }
  ok('A21 the script exports claimRun', !!AC && typeof AC.claimRun === 'function');
  if (AC && AC.claimRun) {
    const runs = path.join(TMP, 'claim', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, '1.prepared'), '{"tasks":["other"]}');
    const r1 = AC.claimRun(runs, 1, { tasks: ['t1'] });
    ok('A21 claimRun on a marker that exists: false, the marker unchanged (EEXIST)', r1 === false && fs.readFileSync(path.join(runs, '1.prepared'), 'utf8') === '{"tasks":["other"]}');
    ok('A21 claimRun on a new number: true, the marker written', AC.claimRun(runs, 2, { tasks: ['t1'] }) === true && /t1/.test(fs.readFileSync(path.join(runs, '2.prepared'), 'utf8')));
  }
}

// ---- A1, A2, A17, A9, A12, A3, A16, A19 (count): the main flow ----
{
  const c = fresh();
  const featBefore = listDir(c.feat);
  const p1 = prep(c);
  const dir = path.join(c.S, 'analysis-checks', c.sha);
  ok('A1 prepare: exit 0, run 1, the sha of the analysis, the version folder', p1.code === 0 && p1.out && p1.out.run === 1 && p1.out.sha === c.sha && p1.out.dir === dir, p1.all);
  ok('A1 prepare: the copy analysis-<sha>.md equals the analysis', fs.existsSync(path.join(dir, `analysis-${c.sha}.md`)) && sha(fs.readFileSync(path.join(dir, `analysis-${c.sha}.md`))) === c.sha);
  const mark = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'runs', '1.prepared'), 'utf8')); } catch { return null; } })();
  ok('A1 prepare: runs/1.prepared names the keys', !!mark && JSON.stringify(mark.tasks) === '["t1"]', JSON.stringify(mark));
  const task = (() => { try { return fs.readFileSync(path.join(dir, 'task-1.md'), 'utf8'); } catch { return ''; } })();
  ok('A1 prepare: task-1.md carries the checker body without its frontmatter, the copy, the original, the keys and the read-only notice',
    /## Report format/.test(task) && !/^---\nname: analysis-checker/.test(task) && task.includes(`analysis-${c.sha}.md`) && task.includes(c.A)
    && /\bt1\b/.test(task) && /unverifiable \(read-only sandbox\)/.test(task) && /analysisSha256/.test(task), task.slice(-600));
  const want = ['codex', 'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--output-schema', path.join(PLUGIN, 'schemas', 'analysis-check.schema.json'),
    '-o', path.join(dir, 'runs', '1.json'), '-C', c.WT, '-m', 'm1', `Read ${path.join(dir, 'task-1.md')} and do what it says.`];
  ok('A1 prepare: the exact argv of codex exec, -o runs/1.json', p1.out && JSON.stringify(p1.out.argv) === JSON.stringify(want), JSON.stringify(p1.out && p1.out.argv));
  ok('A1 prepare: the command line starts with the plain argv the fourth rule matches', p1.out && typeof p1.out.command === 'string'
    && p1.out.command.startsWith(`codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema ${want[7]} -o ${want[9]} -C ${c.WT} -m m1 `), p1.out && p1.out.command);
  ok('A17 prepare: its output says to run the command once and poll it', /once/.test(p1.all) && /poll/i.test(p1.all), p1.all);

  const p2 = prep(c);
  ok('A2 prepare with run 1 pending: exit 3, no second marker', p2.code === 3 && !fs.existsSync(path.join(dir, 'runs', '2.prepared')), p2.all);
  ok('A2/A17 the refusal: poll the command that runs it, never run it again, a second run overwrites runs/1.json, --abandon only when its turn ended',
    /Poll the command that runs it/.test(p2.all) && /never run it again/.test(p2.all) && /a second run overwrites runs\/1\.json/.test(p2.all)
    && /prepare --abandon 1 --reason/.test(p2.all), p2.all);

  const c0 = collect(c);
  ok('collect: run 1 is prepared (pending)', c0.code === 0 && runOf(c0.out, 1) && runOf(c0.out, 1).state === 'prepared', c0.all);

  writeAnswer(oFile(p1), answer(c.sha, ['t1'], 'ready', 0));
  const c1 = collect(c);
  ok('A9 a result without a recorded exit: result, "exit not recorded"', runOf(c1.out, 1) && runOf(c1.out, 1).state === 'result' && /exit not recorded/.test(JSON.stringify(runOf(c1.out, 1))), c1.all);
  const c2 = collect(c, ['--run', '1', '--exit', '0']);
  ok('A9 collect --run 1 --exit 0: result, exit 0 recorded', c2.code === 0 && runOf(c2.out, 1) && runOf(c2.out, 1).state === 'result' && runOf(c2.out, 1).exit === 0
    && fs.readFileSync(path.join(dir, 'runs', '1.exit'), 'utf8').trim() === '0', c2.all);
  const c2b = collect(c, ['--run', '1', '--exit', '1']);
  ok('A9 an exit recorded already is never replaced by another one', c2b.code === 3 && fs.readFileSync(path.join(dir, 'runs', '1.exit'), 'utf8').trim() === '0', c2b.all);

  const ap = collect(c, ['--run', '1', '--append']);
  const rep = fs.existsSync(c.report) ? fs.readFileSync(c.report, 'utf8') : '';
  ok('A12 --append: the report written to <name of the analysis>.check.md next to the analysis', ap.code === 0 && rep.startsWith('# Analysis check\n') && /## Gaps/.test(rep), ap.all);
  ok('A12 --append: Saved-by: coordinator under the header of the run; no Check-run line', /Significant gaps: 0\nSaved-by: coordinator\n/.test(rep) && !/Check-run/.test(rep), rep.slice(0, 400));
  ok('A12 --append: the marker runs/1.appended', fs.existsSync(path.join(dir, 'runs', '1.appended')));
  const ap2 = collect(c, ['--run', '1', '--append']);
  ok('A12 a second --append: "already appended", the report unchanged', ap2.code === 0 && /already appended/.test(ap2.all) && fs.readFileSync(c.report, 'utf8') === rep, ap2.all);

  const p3 = prep(c);
  ok('A3 prepare with a result for t1: exit 3, the result shown (verdict, gaps, appended), no new run', p3.code === 3 && !fs.existsSync(path.join(dir, 'runs', '2.prepared'))
    && /ready/.test(p3.all) && /appended/.test(p3.all), p3.all);
  const c3 = collect(c);
  ok('A19 collect counts the report runs of this version and those appended from here', c3.out && c3.out.reportRuns === 1 && c3.out.appendedHere === 1, c3.all);

  const featAfter = listDir(c.feat).filter((x) => !x.startsWith('analyst.check.md:'));
  ok('A16 prepare and collect write nothing in the folder of the analysis but its .check.md', JSON.stringify(featAfter) === JSON.stringify(featBefore), JSON.stringify(featAfter));
  // A16: an earlier report stays an exact prefix after another append (run 2 of the same version, --again)
  const p4 = prep(c, ['t1'], ['--again', 'another model']);
  ok('A13 --again with a result: a new run, the reason in its marker', p4.code === 0 && p4.out && p4.out.run === 2
    && /another model/.test(fs.readFileSync(path.join(dir, 'runs', '2.prepared'), 'utf8')), p4.all);
  writeAnswer(oFile(p4), answer(c.sha, ['t1'], 'changes-needed', 1));
  collect(c, ['--run', '2', '--exit', '0']);
  const ap3 = collect(c, ['--run', '2', '--append']);
  const rep2 = fs.readFileSync(c.report, 'utf8');
  ok('A16 a second append keeps the earlier report an exact prefix', ap3.code === 0 && rep2.startsWith(rep) && rep2.length > rep.length
    && (rep2.match(/^# Analysis check$/mg) || []).length === 2, rep2.slice(rep.length - 40, rep.length + 80));
  const c4 = collect(c);
  const k = c4.out && c4.out.keys && c4.out.keys.t1;
  ok('A6 two verdicts of one version for t1: both in the output, twoVerdicts named', !!k && k.twoVerdicts === true
    && runOf(c4.out, 1).verdict === 'ready' && runOf(c4.out, 2).verdict === 'changes-needed', JSON.stringify(c4.out && c4.out.keys));
  ok('A6 the output says a changes-needed needs its Closure lines and a later ready does not cancel it', /does not cancel/.test(c4.all), c4.all.slice(0, 600));
  const p5 = prep(c, ['t1'], ['--again', 'third']);
  writeAnswer(oFile(p5), answer(c.sha, ['t1'], 'ready', 0));
  // A23: the same codex exec again after run 3 was collected rewrites runs/3.json
  collect(c, ['--run', '3', '--exit', '0']);
  writeAnswer(oFile(p5), answer(c.sha, ['t1'], 'changes-needed', 2));
  const c5 = collect(c);
  const r3 = runOf(c5.out, 3);
  ok('A23 runs/3.json changed after it was collected: named, both verdicts shown', !!r3 && /changed after it was collected/.test(JSON.stringify(r3))
    && r3.verdict === 'changes-needed' && r3.collected && r3.collected.verdict === 'ready', JSON.stringify(r3));
}

// ---- A13: --again never passes a pending run ----
{
  const c = fresh();
  prep(c);
  const p = prep(c, ['t1'], ['--again', 'x']);
  ok('A13 --again with run 1 pending: exit 3 as A2', p.code === 3 && /never run it again/.test(p.all), p.all);
}

// ---- A4, A18: abandon, and a late answer of the abandoned run ----
{
  const c = fresh();
  const p1 = prep(c);
  const dir = p1.out.dir;
  const bad = prep(c, ['t1'], ['--abandon', '1']);
  ok('A4 --abandon without --reason is a usage error', bad.code === 64, bad.all);
  const p2 = prep(c, ['t1'], ['--abandon', '1', '--reason', 'its turn ended']);
  ok('A4 --abandon 1 --reason: runs/1.abandoned and run 2 prepared in the same call', p2.code === 0 && p2.out && p2.out.run === 2
    && /its turn ended/.test(fs.readFileSync(path.join(dir, 'runs', '1.abandoned'), 'utf8')), p2.all);
  const c1 = collect(c);
  ok('A4 collect: run 1 not-run: abandoned (reason), run 2 prepared', /abandoned/.test(runOf(c1.out, 1) && runOf(c1.out, 1).reason) && runOf(c1.out, 1).state === 'not-run'
    && runOf(c1.out, 2).state === 'prepared', c1.all);
  writeAnswer(oFile(p1), answer(c.sha, ['t1'], 'changes-needed', 1));
  const c2 = collect(c);
  ok('A18 a valid runs/1.json after --abandon: result, "late, after abandon"', runOf(c2.out, 1).state === 'result' && /late, after abandon/.test(JSON.stringify(runOf(c2.out, 1))), c2.all);
  const ab = prep(c, ['t1'], ['--abandon', '1', '--reason', 'again']);
  ok('A4 --abandon of a run with a result: refused, "has a result"', ab.code === 3 && /has a result/.test(ab.all), ab.all);
  const p3 = prep(c, ['t1'], ['--abandon', '2', '--reason', 'died too']);
  ok('A18 the late result blocks prepare like A3', p3.code === 3 && !fs.existsSync(path.join(dir, 'runs', '3.prepared')) && /changes-needed/.test(p3.all), p3.all);
}

// ---- A5: another version of the analysis ----
{
  const c = fresh();
  const p1 = prep(c);
  writeAnswer(oFile(p1), answer(c.sha, ['t1'], 'ready', 0));
  collect(c, ['--run', '1', '--exit', '0']);
  collect(c, ['--run', '1', '--append']);
  const old = c.sha;
  fs.appendFileSync(c.A, '\nA new cell.\n');
  c.sha = sha(fs.readFileSync(c.A));
  const p2 = prep(c);
  ok('A5 the analysis changed: a new version, run 1 of it', p2.code === 0 && p2.out && p2.out.sha === c.sha && p2.out.run === 1, p2.all);
  ok('A5 the earlier version is listed as another version, not a check of this one', JSON.stringify(p2.out && p2.out.otherVersions || []).includes(old)
    && /another version/.test(p2.all), p2.all);
}

// ---- A7: the earlier layout <key>/<sha>/ (synthetic, the same files as the first probe) ----
{
  const c = fresh();
  const leg = path.join(c.S, 'analysis-checks', 'k1', c.sha);
  fs.mkdirSync(leg, { recursive: true });
  fs.copyFileSync(c.A, path.join(leg, `analysis-${c.sha}.md`));
  fs.writeFileSync(path.join(leg, 'last.json'), JSON.stringify(answer(c.sha, ['k1'], 'ready', 0)));
  fs.writeFileSync(path.join(leg, 'normal-model-low.json'), JSON.stringify(answer(c.sha, ['k1'], 'ready', 0)));
  fs.writeFileSync(path.join(leg, 'broken-run.md'), 'A launch that broke.\n');
  fs.writeFileSync(path.join(leg, 'task.md'), 'The task of the checker.\n');
  const before = listDir(path.join(c.S, 'analysis-checks', 'k1'));
  const p = prep(c, ['k1']);
  ok('A7 a legacy last.json of this sha for k1 blocks prepare like A3', p.code === 3 && /legacy/.test(p.all) && !fs.existsSync(path.join(c.S, 'analysis-checks', c.sha, 'runs', '1.prepared')), p.all);
  const col = collect(c);
  ok('A7 collect: the legacy result and the unknown files named', !!col.out && JSON.stringify(col.out.legacy || []).includes('"k1"')
    && JSON.stringify(col.out).includes('normal-model-low.json') && JSON.stringify(col.out).includes('broken-run.md') && /unknown file/.test(col.all), col.all);
  ok('A7 nothing of the legacy folder removed or changed', JSON.stringify(listDir(path.join(c.S, 'analysis-checks', 'k1'))) === JSON.stringify(before));
  const p2 = prep(c, ['k2']);
  ok('A7 the legacy result of k1 does not count for k2', p2.code === 0 && p2.out && p2.out.run === 1, p2.all);
}

// ---- A8: an answer that is not a verdict ----
{
  const c = fresh();
  const cases = [
    ['not JSON', '{oops', /JSON/],
    ['a missing field', JSON.stringify({ analysisSha256: c.sha, tasks: ['t1'], verdict: 'ready', report: reportText(c.sha, ['t1'], 'ready', 0) }), /significantGaps/],
    ['another sha', answer('0'.repeat(64), ['t1'], 'ready', 0), /analysisSha256/],
    ['ready with gaps', answer(c.sha, ['t1'], 'ready', 1), /ready/],
    ['changes-needed with 0', answer(c.sha, ['t1'], 'changes-needed', 0), /changes-needed/],
  ];
  let n = 0;
  for (const [name, a, re] of cases) {
    const p = prep(c);
    n++;
    ok(`A8 ${name}: prepare is not blocked by the earlier not-run (run ${n})`, p.code === 0 && p.out && p.out.run === n, p.all);
    if (p.code !== 0) break;
    writeAnswer(oFile(p), a);
    const r = runOf(collect(c).out, n);
    ok(`A8 ${name}: not-run with its reason`, !!r && r.state === 'not-run' && re.test(r.reason || ''), JSON.stringify(r));
  }
}

// ---- A9: an exit other than 0 with a valid file ----
{
  const c = fresh();
  const p = prep(c);
  writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
  const r = runOf(collect(c, ['--run', '1', '--exit', '2']).out, 1);
  ok('A9 exit 2 recorded: not-run: exit 2 although the file is valid', !!r && r.state === 'not-run' && /exit 2/.test(r.reason), JSON.stringify(r));
  const p2 = prep(c);
  ok('A9 not-run: exit 2 does not block prepare', p2.code === 0 && p2.out.run === 2, p2.all);
  const c3 = fresh();
  prep(c3);
  const r3 = runOf(collect(c3, ['--run', '1', '--exit', '0']).out, 1);
  ok('A9 exit 0 and no runs/1.json: not-run "no runs/1.json"', !!r3 && r3.state === 'not-run' && /no runs\/1\.json/.test(r3.reason), JSON.stringify(r3));
  const ap = collect(c3, ['--run', '1', '--append']);
  ok('A12 --append of a not-run: refused, no report', ap.code === 3 && !fs.existsSync(c3.report), ap.all);
}

// ---- A10: a result for t1 does not count for t2; one pending run per version ----
{
  const c = fresh();
  const p1 = prep(c, ['t1']);
  const pt2 = prep(c, ['t2']);
  ok('A10 a pending run of t1 refuses prepare for t2 (one pending run per version)', pt2.code === 3 && /never run it again/.test(pt2.all), pt2.all);
  writeAnswer(oFile(p1), answer(c.sha, ['t1'], 'ready', 0));
  const p2 = prep(c, ['t2']);
  ok('A10 a result for t1: prepare for t2 runs 2 in the same version folder, t1 named for reference', p2.code === 0 && p2.out.run === 2 && p2.out.dir === p1.out.dir
    && /checked for t1/.test(p2.all), p2.all);
}

// ---- A11: the copy in the version folder changed ----
{
  const c = fresh();
  const p = prep(c);
  fs.appendFileSync(path.join(p.out.dir, `analysis-${c.sha}.md`), 'tampered\n');
  const a = prep(c);
  const b = collect(c);
  ok('A11 a changed copy: prepare and collect exit 65 with its path', a.code === 65 && b.code === 65 && a.all.includes(`analysis-${c.sha}.md`), a.all + b.all);
}

// ---- A19: runs of the report next to the analysis ----
{
  const c = fresh();
  fs.writeFileSync(c.report, reportText('f'.repeat(64), ['t1'], 'ready', 0) + '\n' + reportText(c.sha, ['t9'], 'ready', 0)
    + '\n' + reportText(c.sha, ['t1 (a note of the coordinator)'], 'ready', 0));
  const p = prep(c);
  ok('A19 a run of another sha, of another key or with a Tasks line not in the format does not block', p.code === 0, p.all);
  ok('A19 a Tasks line not in the format is named, no key guessed', /Tasks line not in the format/.test(p.all), p.all);
  writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
  collect(c, ['--run', '1', '--exit', '0']);
  const c2 = fresh();
  fs.writeFileSync(c2.report, reportText(c2.sha, ['t1', 't2'], 'changes-needed', 1, '| G1 | x | yes | y | 2 |'));
  const p2 = prep(c2, ['t2']);
  ok('A19 a run of the report with this sha and t2 in Tasks blocks prepare --task t2, named with its verdict', p2.code === 3 && /changes-needed/.test(p2.all)
    && /report run 1/.test(p2.all), p2.all);
  const col = collect(c2);
  ok('A19 collect: 1 report run of this version, 0 appended from here', col.out && col.out.reportRuns === 1 && col.out.appendedHere === 0, col.all);
}

// ---- A20: one run for several keys; the keys come from the answer ----
{
  const c = fresh();
  const p = prep(c, ['t1', 't2']);
  const dir = p.out && p.out.dir;
  ok('A20 the marker and task-1.md name both keys', p.code === 0 && /"t1","t2"/.test(fs.readFileSync(path.join(dir, 'runs', '1.prepared'), 'utf8'))
    && /t1, t2/.test(fs.readFileSync(path.join(dir, 'task-1.md'), 'utf8')), p.all);
  writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
  const col = collect(c);
  ok('A20 collect: asked for t1, t2; the checker named t1: t2 is not checked', /asked for t1, t2; the checker named t1: t2 is not checked/.test(col.all), col.all);
  ok('A20 t2 is not blocked', prep(c, ['t2']).code === 0);
  const c2 = fresh();
  const q = prep(c2, ['t1', 't2']);
  writeAnswer(oFile(q), answer(c2.sha, ['t1'], 'ready', 0));
  ok('A20 t1 is blocked', prep(c2, ['t1']).code === 3);
}

// ---- A22: the header of the report disagrees with the answer ----
{
  const c = fresh();
  const p = prep(c);
  writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0, { report: reportText(c.sha, ['t1'], 'changes-needed', 1) }));
  const r = runOf(collect(c).out, 1);
  ok('A22 Verdict line of the report differs: not-run, the field named', !!r && r.state === 'not-run' && /report header disagrees with the answer \(verdict\)/.test(r.reason), JSON.stringify(r));
  const ap = collect(c, ['--run', '1', '--append']);
  ok('A22 not appended', ap.code === 3 && !fs.existsSync(c.report), ap.all);
  const c2 = fresh();
  const p2 = prep(c2);
  writeAnswer(oFile(p2), answer(c2.sha, ['t1'], 'ready', 0, { report: reportText(c2.sha, ['t2'], 'ready', 0) }));
  const r2 = runOf(collect(c2).out, 1);
  ok('A22 Tasks line of the report differs: not-run (tasks)', !!r2 && r2.state === 'not-run' && /\(tasks\)/.test(r2.reason), JSON.stringify(r2));
  const c3 = fresh();
  const p3 = prep(c3);
  writeAnswer(oFile(p3), answer(c3.sha, ['t1'], 'ready', 0, { report: reportText(null, ['t1'], 'ready', 0) }));
  const ap3 = collect(c3, ['--run', '1', '--append']);
  const rep3 = fs.existsSync(c3.report) ? fs.readFileSync(c3.report, 'utf8') : '';
  ok('A12 a report without Analysis-sha256: the line filled in by --append', ap3.code === 0 && rep3.includes(`Analysis-sha256: ${c3.sha}\n`), ap3.all + rep3.slice(0, 300));
}

// ---- M2: a file in runs/ without prepare is shown, not lost ----
{
  const c = fresh();
  const p = prep(c);
  writeAnswer(path.join(p.out.dir, 'runs', '7.json'), answer(c.sha, ['t1'], 'ready', 0));
  const r = runOf(collect(c).out, 7);
  ok('a runs/7.json without a marker: a result shown "without prepare"', !!r && r.state === 'result' && /without prepare/.test(JSON.stringify(r)), JSON.stringify(r));
}

// ---- usage ----
ok('usage: an unknown command exits 64', run(['nope']).code === 64);
ok('usage: prepare without --task exits 64', run(['prepare', '--shared', TMP, '--analysis', path.join(TMP, 'x.md'), '--worktree', TMP, '--model', 'm']).code === 64);

done();
