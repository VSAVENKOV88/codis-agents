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
const { spawn, spawnSync } = require('child_process');
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
  ok('A12 --append: the marker runs/1.answers/1.appended of answer 1', fs.existsSync(path.join(dir, 'runs', '1.answers', '1.appended')));
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
  // A23: the same codex exec again after run 3 was collected rewrites runs/3.json: both answers are in its journal
  collect(c, ['--run', '3', '--exit', '0']);
  writeAnswer(oFile(p5), answer(c.sha, ['t1'], 'changes-needed', 2));
  const c5 = collect(c);
  const r3 = runOf(c5.out, 3);
  ok('A23 runs/3.json rewritten after it was collected: run 3 has two answers, both shown, "now answer 2 of 2"', !!r3 && Array.isArray(r3.answers)
    && r3.answers.map((x) => `${x.verdict}${x.significantGaps}`).join(',') === 'ready0,changes-needed2' && /now answer 2 of 2/.test(JSON.stringify(r3)), JSON.stringify(r3));
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

// ---- A23 x A6: an answer rewritten after it was collected is a second verdict of the version; both are appended ----
let raceA23 = Promise.resolve();
{
  const verdictsInReport = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').match(/^Verdict: .*$/mg) || [] : []);
  // (b) collected changes-needed, rewritten to ready, then one --append: both answers go into the report, oldest first
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const ap = collect(c, ['--run', '1', '--append']);
    ok('A23xA6 (b) --append of a rewritten run appends the collected answer and the later one, oldest first', ap.code === 0
      && JSON.stringify(verdictsInReport(c.report)) === JSON.stringify(['Verdict: changes-needed', 'Verdict: ready'])
      && (fs.readFileSync(c.report, 'utf8').match(/^Saved-by: coordinator$/mg) || []).length === 2, JSON.stringify(verdictsInReport(c.report)) + ap.all.slice(0, 400));
    const k = ap.out && ap.out.keys && ap.out.keys.t1;
    ok('A23xA6 (b) t1 has exactly two verdicts (the report runs written from here are not counted again)', !!k && k.twoVerdicts === true
      && k.verdicts.length === 2 && k.verdicts.map((x) => x.verdict).sort().join(',') === 'changes-needed,ready', JSON.stringify(k));
    const ap2 = collect(c, ['--run', '1', '--append']);
    ok('A23xA6 (b) a second --append writes nothing', ap2.code === 0 && verdictsInReport(c.report).length === 2, JSON.stringify(verdictsInReport(c.report)));
  }
  // (a) changes-needed appended before the rewrite: a later --append adds the ready
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    collect(c, ['--run', '1', '--append']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const ap = collect(c, ['--run', '1', '--append']);
    ok('A23xA6 (a) --append after a rewrite of an appended answer appends the later answer', ap.code === 0
      && JSON.stringify(verdictsInReport(c.report)) === JSON.stringify(['Verdict: changes-needed', 'Verdict: ready']), JSON.stringify(verdictsInReport(c.report)) + ap.all.slice(0, 400));
    const k = ap.out && ap.out.keys && ap.out.keys.t1;
    ok('A23xA6 (a) t1 has exactly two verdicts and the strict note', !!k && k.twoVerdicts === true && k.verdicts.length === 2
      && /t1: two verdicts of one version/.test(ap.all), JSON.stringify(k));
    const again = prep(c);
    ok('A23xA6 (a) prepare refuses and names the changes-needed', again.code === 3 && /changes-needed/.test((again.out && again.out.refused) || ''), again.all.slice(0, 400));
  }
  // a third codex exec after both answers were appended: the appended later answer stays a verdict, the new one is named
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    collect(c, ['--run', '1', '--append']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 2));
    const col = collect(c);
    const k = col.out && col.out.keys && col.out.keys.t1;
    ok('A23xA6 a third answer of the run: all three are verdicts of t1, the run names its three answers', !!k && k.verdicts.length === 3
      && k.verdicts.map((x) => `${x.verdict}${x.significantGaps}`).sort().join(',') === 'changes-needed1,changes-needed2,ready0'
      && /3 answers/.test(col.all), JSON.stringify(k));
    collect(c, ['--run', '1', '--append']);
    ok('B13 the third answer is appended by the next --append; the two appended before are not written again',
      JSON.stringify(verdictsInReport(c.report)) === JSON.stringify(['Verdict: changes-needed', 'Verdict: ready', 'Verdict: changes-needed']), JSON.stringify(verdictsInReport(c.report)));
  }
  // a race of four --append on a rewritten run still writes each answer once
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const kids = [1, 2, 3, 4].map(() => spawn(process.execPath, [SCRIPT, 'collect', '--shared', c.S, '--analysis', c.A, '--run', '1', '--append'], { stdio: 'ignore' }));
    raceA23 = Promise.all(kids.map((k) => new Promise((res) => k.on('close', res)))).then(() => {
      const v = verdictsInReport(c.report).sort();
      ok('A23xA6 a race of four --append on a rewritten run writes each answer once', JSON.stringify(v) === JSON.stringify(['Verdict: changes-needed', 'Verdict: ready']), JSON.stringify(v));
    });
  }
}

// ---- B1-B16: the journal of answers of a run, runs/<n>.answers/<k>.json (mechanism M2.2) ----
// Every valid answer any command saw is recorded once; the verdicts of a run are its journal, not the file now.
{
  const jdir = (c, n) => path.join(c.S, 'analysis-checks', c.sha, 'runs', `${n || 1}.answers`);
  const jlist = (c, n) => (fs.existsSync(jdir(c, n)) ? fs.readdirSync(jdir(c, n)).filter((f) => /^\d+\.json$/.test(f)).sort() : []);
  const vs = (o, t) => ((o && o.keys && o.keys[t || 't1']) || { verdicts: [] }).verdicts.map((x) => `${x.verdict}${x.significantGaps}`).sort().join(',');
  const verdictsInReport = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').match(/^Verdict: .*$/mg) || [] : []);
  const A = (c) => answer(c.sha, ['t1'], 'changes-needed', 1);
  const B = (c) => answer(c.sha, ['t1'], 'changes-needed', 2);
  const C = (c) => answer(c.sha, ['t1'], 'ready', 0);
  // run 1 prepared, answer A written and seen by collect --exit 0
  const seenA = () => { const c = fresh(); const p = prep(c); writeAnswer(oFile(p), A(c)); collect(c, ['--run', '1', '--exit', '0']); return { c, p }; };

  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), A(c));
    const p2 = prep(c);
    ok('B1 prepare sees answer A (no collect before): it refuses with the changes-needed and records A in the journal', p2.code === 3
      && /changes-needed/.test((p2.out && p2.out.refused) || '') && JSON.stringify(jlist(c)) === '["1.json"]', p2.all.slice(0, 300));
    writeAnswer(oFile(p), C(c));
    const col = collect(c);
    ok('B1 then rewritten by B: both verdicts of t1, twoVerdicts', vs(col.out) === 'changes-needed1,ready0' && col.out.keys.t1.twoVerdicts === true, JSON.stringify(col.out && col.out.keys));
  }
  {
    const { c, p } = seenA();
    const entry = (() => { try { return JSON.parse(fs.readFileSync(path.join(jdir(c), '1.json'), 'utf8')); } catch { return {}; } })();
    ok('B2 a journal entry is {sha256, at, answer}: the sha256 of the bytes of runs/1.json and the whole answer', entry.sha256 === sha(fs.readFileSync(oFile(p)))
      && typeof entry.at === 'string' && entry.answer && entry.answer.report === A(c).report, JSON.stringify(entry).slice(0, 300));
    writeAnswer(oFile(p), B(c));
    const c2 = collect(c);
    ok('B2 rewritten by a valid B of the same key: both verdicts, twoVerdicts, "now answer 2 of 2"', vs(c2.out) === 'changes-needed1,changes-needed2'
      && c2.out.keys.t1.twoVerdicts === true && /now answer 2 of 2/.test(c2.all), c2.all.slice(0, 600));
    writeAnswer(oFile(p), C(c));
    const c3 = collect(c);
    ok('B3 rewritten again by C before any --append: three verdicts, the middle one kept', vs(c3.out) === 'changes-needed1,changes-needed2,ready0', JSON.stringify(c3.out && c3.out.keys));
    writeAnswer(oFile(p), A(c));
    const c4 = collect(c);
    ok('B5 rewritten back to A: the journal does not grow, "now answer 1 of 3"', jlist(c).length === 3 && /now answer 1 of 3/.test(c4.all), jlist(c).join(',') + c4.all.slice(0, 300));
  }
  {
    const { c, p } = seenA();
    writeAnswer(oFile(p), A(c));
    collect(c);
    prep(c);
    ok('B4 the same bytes again, seen by collect and prepare: one entry, one verdict', jlist(c).length === 1 && vs(collect(c).out) === 'changes-needed1', jlist(c).join(','));
  }
  const bads = (c) => [
    ['not JSON', 'oops'], ['an empty file', ''], ['another analysisSha256', JSON.stringify(answer('0'.repeat(64), ['t1'], 'ready', 0))],
    ['not the schema', JSON.stringify({ analysisSha256: c.sha, tasks: ['t1'], verdict: 'ready', report: reportText(c.sha, ['t1'], 'ready', 0) })],
    ['a report header that disagrees', JSON.stringify(answer(c.sha, ['t1'], 'ready', 0, { report: reportText(c.sha, ['t1'], 'changes-needed', 1) }))],
  ];
  for (const [name] of bads({ sha: '' })) {
    const { c, p } = seenA();
    fs.writeFileSync(oFile(p), bads(c).find((x) => x[0] === name)[1]);
    const col = collect(c);
    const r = runOf(col.out, 1);
    ok(`B6 A seen, then runs/1.json rewritten by ${name}: run 1 stays a result, t1 keeps the changes-needed, the file named "now not a verdict"`,
      !!r && r.state === 'result' && vs(col.out) === 'changes-needed1' && /now not a verdict/.test(JSON.stringify(r)), JSON.stringify(r));
    const again = prep(c);
    const ab = prep(c, ['t1'], ['--abandon', '1', '--reason', 'x']);
    ok(`B6 (${name}) prepare refuses with the changes-needed; --abandon 1 refused "has a result"`, again.code === 3 && /changes-needed/.test((again.out && again.out.refused) || '')
      && ab.code === 3 && /has a result/.test(ab.all), `${again.code} ${ab.code} ${ab.all.slice(0, 200)}`);
  }
  {
    const { c, p } = seenA();
    collect(c, ['--run', '1', '--append']);
    fs.writeFileSync(oFile(p), 'garbage');
    const col = collect(c);
    ok('B7 A appended, then runs/1.json rewritten by garbage: the report holds A once, t1 has exactly one verdict', verdictsInReport(c.report).length === 1
      && vs(col.out) === 'changes-needed1' && col.out.reportRuns === 1 && col.out.appendedHere === 1, JSON.stringify(col.out && col.out.keys));
    ok('B7 prepare refuses (3)', prep(c).code === 3);
  }
  {
    const { c, p } = seenA();
    writeAnswer(oFile(p), answer(c.sha, ['t2'], 'ready', 0));
    const col = collect(c);
    ok('B8 A for t1 rewritten by an answer for t2: collect without --task shows t1 [changes-needed] and t2 [ready]', vs(col.out, 't1') === 'changes-needed1'
      && vs(col.out, 't2') === 'ready0' && /answer 2: asked for t1; the checker named t2/.test(col.all), JSON.stringify(col.out && col.out.keys) + col.all.slice(0, 400));
    ok('B8 prepare --task t1 and --task t2 both refuse', prep(c, ['t1']).code === 3 && prep(c, ['t2']).code === 3);
  }
  {
    const { c, p } = seenA();
    fs.unlinkSync(oFile(p));
    const col = collect(c);
    const r = runOf(col.out, 1);
    ok('B9 A seen, then runs/1.json removed: run 1 a result (not pending), "is gone"', !!r && r.state === 'result' && /is gone/.test(JSON.stringify(r)) && vs(col.out) === 'changes-needed1', JSON.stringify(r));
    const again = prep(c);
    const ab = prep(c, ['t1'], ['--abandon', '1', '--reason', 'x']);
    ok('B9 prepare refuses by the result, not as pending; --abandon refused', again.code === 3 && !/never run it again/.test((again.out && again.out.refused) || '')
      && ab.code === 3 && /has a result/.test(ab.all), (again.out && again.out.refused) || again.all.slice(0, 200));
  }
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), A(c));
    collect(c);
    const e1 = collect(c, ['--run', '1', '--exit', '1']);
    const r = runOf(e1.out, 1);
    ok('B10 A seen without --exit, then --exit 1: A stays the verdict, the late exit named', e1.code === 0 && !!r && r.state === 'result' && vs(e1.out) === 'changes-needed1'
      && /exit 1 recorded after answer 1/.test(JSON.stringify(r)), JSON.stringify(r));
    ok('B10 prepare refuses (3)', prep(c).code === 3);
    writeAnswer(oFile(p), C(c));
    collect(c);
    ok('B10 after a recorded exit other than 0 no new answer is recorded', jlist(c).length === 1, jlist(c).join(','));
  }
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), A(c));
    collect(c, ['--run', '1', '--exit', '2']);
    ok('B11 exit 2 recorded before any command saw the answer: not-run, nothing in the journal', runOf(collect(c).out, 1).state === 'not-run' && jlist(c).length === 0, jlist(c).join(','));
  }
  {
    const { c, p } = seenA();
    writeAnswer(oFile(p), B(c));
    collect(c);
    const ap = collect(c, ['--run', '1', '--append']);
    ok('B12 --append of a run with two unappended answers: both appended, in the order they were seen, one marker each', ap.code === 0
      && JSON.stringify(verdictsInReport(c.report)) === JSON.stringify(['Verdict: changes-needed', 'Verdict: changes-needed'])
      && /Significant gaps: 1\n[\s\S]*Significant gaps: 2\n/.test(fs.readFileSync(c.report, 'utf8'))
      && fs.existsSync(path.join(jdir(c), '1.appended')) && fs.existsSync(path.join(jdir(c), '2.appended')), ap.all.slice(0, 400));
    const rep = fs.readFileSync(c.report, 'utf8');
    const ap2 = collect(c, ['--run', '1', '--append']);
    ok('B12 a second --append: "already appended", the report unchanged', ap2.code === 0 && /already appended/.test(ap2.all) && fs.readFileSync(c.report, 'utf8') === rep, ap2.all.slice(0, 300));
  }
  for (const [name, spoil] of [['garbage', (f) => fs.writeFileSync(f, 'garbage')], ['removed', (f) => fs.unlinkSync(f)]]) {
    const { c, p } = seenA();
    spoil(oFile(p));
    const ap = collect(c, ['--run', '1', '--append']);
    ok(`B14 A seen, not appended, runs/1.json ${name}: --append writes A (exit 0)`, ap.code === 0 && JSON.stringify(verdictsInReport(c.report)) === '["Verdict: changes-needed"]', ap.all.slice(0, 300));
  }
  {
    // (a) the entry 1.json another observer wrote holds the same answer; (b) it holds another one
    const { c: ca, p: pa } = (() => { const c = fresh(); const p = prep(c); return { c, p }; })();
    writeAnswer(oFile(pa), A(ca));
    fs.mkdirSync(jdir(ca), { recursive: true });
    fs.writeFileSync(path.join(jdir(ca), '1.json'), JSON.stringify({ sha256: sha(fs.readFileSync(oFile(pa))), at: 'x', answer: A(ca) }));
    collect(ca);
    ok('B15 (a) an entry with the same sha256 written by another observer: nothing added', JSON.stringify(jlist(ca)) === '["1.json"]', jlist(ca).join(','));
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), C(c));
    fs.mkdirSync(jdir(c), { recursive: true });
    const other = JSON.stringify({ sha256: sha(JSON.stringify(A(c))), at: 'x', answer: A(c) });
    fs.writeFileSync(path.join(jdir(c), '1.json'), other);
    const col = collect(c);
    ok('B15 (b) an entry with another answer: the new one is answer 2, entry 1 unchanged, both verdicts', JSON.stringify(jlist(c)) === '["1.json","2.json"]'
      && fs.readFileSync(path.join(jdir(c), '1.json'), 'utf8') === other && vs(col.out) === 'changes-needed1,ready0', jlist(c).join(',') + JSON.stringify(col.out && col.out.keys));
  }
  {
    // An entry another command is writing (not readable yet): nothing new is recorded, the answer now is still shown
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), A(c));
    fs.mkdirSync(jdir(c), { recursive: true });
    fs.writeFileSync(path.join(jdir(c), '1.json'), '{"sha256":');
    const col = collect(c);
    ok('B15 (c) an entry that cannot be read: no second entry, the answer now still shown as a verdict, the entry named', JSON.stringify(jlist(c)) === '["1.json"]'
      && vs(col.out) === 'changes-needed1' && /cannot be read/.test(col.all) && prep(c).code === 3, jlist(c).join(',') + col.all.slice(0, 300));
  }
  {
    // B16: the marker of an appended answer names report run 1, but run 1 of the report is a run written elsewhere at
    // the same time; the run written from here is run 2. The foreign run is a verdict; ours is not counted twice.
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), C(c));
    collect(c, ['--run', '1', '--exit', '0']);
    fs.writeFileSync(c.report, reportText(c.sha, ['t1'], 'changes-needed', 1, '| G1 | x | yes | y | 2 |'));
    collect(c, ['--run', '1', '--append']);
    const mk = path.join(jdir(c), '1.appended');
    const m = fs.existsSync(mk) ? JSON.parse(fs.readFileSync(mk, 'utf8')) : {};
    if (fs.existsSync(mk)) fs.writeFileSync(mk, JSON.stringify(Object.assign(m, { reportRun: 1 })));
    const col = collect(c);
    ok('B16 a report run written elsewhere is a verdict although the marker names its ordinal; ours is excluded by its text', vs(col.out) === 'changes-needed1,ready0'
      && col.out.reportRuns === 2 && col.out.appendedHere === 1, JSON.stringify(col.out && col.out.keys) + ` ${col.out && col.out.appendedHere}`);
    // the coordinator writes the section Closure of the appended run: it stays a run written from here
    fs.writeFileSync(c.report, fs.readFileSync(c.report, 'utf8').replace(/<left empty by the checker>\n\nNext step: start\n$/, 'G0 - none, layer 2\n\nNext step: wave\n'));
    const col2 = collect(c);
    ok('B16 the Closure section written into the appended run keeps it a run written from here', col2.out && col2.out.appendedHere === 1 && vs(col2.out) === 'changes-needed1,ready0',
      JSON.stringify(col2.out && col2.out.keys));
  }

  // The invariant of M2.2 over sequences of events: a verdict any command once showed for a key stays in every later
  // output, and prepare for a key with a verdict refuses. Events: valid answers A, B, C of t1, D of t2, the same bytes
  // again, five answers that are not verdicts, the file removed, a late --exit 1. Observers: prepare, collect, --append.
  let AC = null;
  try { AC = require(SCRIPT); } catch { /* red above */ }
  if (AC && AC.main) {
    const mainOf = (args) => { const r = AC.main(args); return { code: r.code, out: r.out || {} }; };
    const shownOf = (out) => { const s = {}; for (const [t, x] of Object.entries((out && out.keys) || {})) s[t] = new Set(x.verdicts.map((v) => `${v.verdict}${v.significantGaps}`)); return s; };
    const EV = ['A', 'B', 'C', 'D', 'same', 'notjson', 'empty', 'othersha', 'schema', 'header', 'delete', 'exit1'];
    const OBS = ['prepare', 'collect', 'append'];
    const fails = {};
    for (const obs of OBS) fails[obs] = [];
    for (const obs of OBS) {
      for (const e2 of EV) {
        for (const e3 of EV) {
          const c = fresh();
          const base = ['--shared', c.S, '--analysis', c.A];
          const p = mainOf(['prepare', ...base, '--task', 't1', '--worktree', c.WT, '--model', 'm1']);
          const file = p.out.argv[p.out.argv.indexOf('-o') + 1];
          const answers = { A: A(c), B: B(c), C: C(c), D: answer(c.sha, ['t2'], 'changes-needed', 3) };
          const event = (ev) => {
            if (answers[ev]) writeAnswer(file, answers[ev]);
            else if (ev === 'same') { if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file)); }
            else if (ev === 'delete') { if (fs.existsSync(file)) fs.unlinkSync(file); }
            else if (ev === 'exit1') mainOf(['collect', ...base, '--run', '1', '--exit', '1']);
            else fs.writeFileSync(file, bads(c).find((x) => x[0] === { notjson: 'not JSON', empty: 'an empty file', othersha: 'another analysisSha256', schema: 'not the schema', header: 'a report header that disagrees' }[ev])[1]);
          };
          const observe = () => (obs === 'prepare' ? mainOf(['prepare', ...base, '--task', 't1', '--worktree', c.WT, '--model', 'm1'])
            : mainOf(['collect', ...base, ...(obs === 'append' ? ['--run', '1', '--append'] : [])]));
          const ever = {};
          for (const ev of ['A', e2, e3]) {
            event(ev);
            const o = observe();
            const now = shownOf(o.out);
            for (const [t, set] of Object.entries(ever)) {
              const lost = [...set].filter((v) => !(now[t] && now[t].has(v)));
              if (lost.length) fails[obs].push(`A,${e2},${e3} after ${ev}: ${t} lost ${lost.join(',')}`);
            }
            for (const [t, set] of Object.entries(now)) { ever[t] = ever[t] || new Set(); set.forEach((v) => ever[t].add(v)); }
            for (const t of Object.keys(ever)) {
              if (!ever[t].size) continue;
              const pr = mainOf(['prepare', ...base, '--task', t, '--worktree', c.WT, '--model', 'm1']);
              if (pr.code !== 3) fails[obs].push(`A,${e2},${e3} after ${ev}: prepare --task ${t} exit ${pr.code}`);
            }
          }
          fs.rmSync(c.S, { recursive: true, force: true });
        }
      }
      ok(`invariant M2.2 (observer ${obs}): over A x ${EV.length} x ${EV.length} event sequences no verdict once shown is lost, and prepare for its key refuses`,
        fails[obs].length === 0, fails[obs].slice(0, 6).join('\n'));
    }
  }
}

// ---- the tester cells: tests/analysis-check-tester-cases.js, a child with its own tally, so README keeps counting test files ----
{
  const tc = spawnSync(process.execPath, [path.join(__dirname, 'analysis-check-tester-cases.js')], { encoding: 'utf8', timeout: 120000 });
  ok('the tester cells of analysis-check.js (tests/analysis-check-tester-cases.js) pass', tc.status === 0,
    `exit ${tc.status} ${tc.signal || ''} ${(tc.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n').slice(-1500)} ${(tc.stderr || '').slice(-500)}`);
}

raceA23.then(() => done());
