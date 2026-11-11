'use strict';
// p-codex-D2b-1 tester cells of scripts/analysis-check.js, run by tests/analysis-check.test.js as a child with its own
// tally (so the README count of test files stays). Cells beyond the programmer's test: malformed arguments, an analysis
// that cannot be read, a legacy last.json that is not a verdict, a report run inside a fenced block, one appended run is
// one verdict (not two), two verdicts from two sources, a real race of several prepare and of two --append, the shell
// quoting of the printed command, and an answer rewritten after it was collected under the rule of two verdicts (A23 x A6), and an answer rewritten after collect by one that is not a verdict or that names another key (A23).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'analysis-check.js');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-act-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const parse = (r) => { let out = null; try { out = JSON.parse(r.stdout); } catch { /* not JSON */ } return { code: r.status, out, all: (r.stdout || '') + (r.stderr || '') }; };
const run = (args) => parse(spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }));
const runAsync = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [SCRIPT, ...args]);
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => res(parse({ status, stdout, stderr })));
});
let seq = 0;
function fresh(name) {
  const S = path.join(TMP, name || 's' + (++seq));
  fs.mkdirSync(path.join(S, 'feat'), { recursive: true });
  const A = path.join(S, 'feat', 'analyst.md');
  fs.writeFileSync(A, `# Analysis ${++seq}\n`);
  return { S, A, sha: sha(fs.readFileSync(A)), report: path.join(S, 'feat', 'analyst.check.md') };
}
const prepArgs = (c, keys, extra) => ['prepare', '--shared', c.S, '--analysis', c.A, ...(keys || ['t1']).flatMap((k) => ['--task', k]), '--worktree', TMP, '--model', 'm1', ...(extra || [])];
const prep = (c, keys, extra) => run(prepArgs(c, keys, extra));
const collect = (c, extra) => run(['collect', '--shared', c.S, '--analysis', c.A, ...(extra || [])]);
const reportText = (s, tasks, verdict, gaps) => `# Analysis check\nAnalysis: /abs/analyst.md\nAnalysis-sha256: ${s}\nTasks: ${tasks.join(', ')}\n`
  + `Verdict: ${verdict}\nSignificant gaps: ${gaps}\n\n## Gaps\nnone\n`;
const answer = (s, tasks, verdict, gaps) => ({ analysisSha256: s, tasks, verdict, significantGaps: gaps, report: reportText(s, tasks, verdict, gaps) });
const oFile = (p) => { const a = p.out && p.out.argv; return a ? a[a.indexOf('-o') + 1] : null; };
const writeAnswer = (file, obj) => { if (file) fs.writeFileSync(file, JSON.stringify(obj)); };
const keyOf = (o, t) => (o && o.keys && o.keys[t]) || null;

(async () => {
  // ---- malformed arguments: exit 64, nothing written ----
  {
    const c = fresh();
    const cases = [
      ['collect --run ../1', ['collect', '--shared', c.S, '--analysis', c.A, '--run', '../1']],
      ['collect --sha abc', ['collect', '--shared', c.S, '--analysis', c.A, '--sha', 'abc']],
      ['collect --exit x', ['collect', '--shared', c.S, '--analysis', c.A, '--run', '1', '--exit', 'x']],
      ['collect --append without --run', ['collect', '--shared', c.S, '--analysis', c.A, '--append']],
      ['prepare --task ../x', prepArgs(c, ['../x'])],
      ['prepare --again with an empty reason', prepArgs(c, ['t1'], ['--again', ''])],
      ['prepare --abandon 1x', prepArgs(c, ['t1'], ['--abandon', '1x', '--reason', 'r'])],
      ['an unknown argument', prepArgs(c, ['t1'], ['--force'])],
    ];
    for (const [name, args] of cases) {
      const r = run(args);
      ok(`args: ${name} - exit 64`, r.code === 64, r.all.slice(0, 300));
    }
    ok('args: nothing written by the refused calls', !fs.existsSync(path.join(c.S, 'analysis-checks')));
  }

  // ---- an analysis that cannot be read: 65 ----
  {
    const c = fresh();
    const r1 = run(prepArgs({ S: c.S, A: c.A + '.missing' }));
    const r2 = run(['collect', '--shared', c.S, '--analysis', c.A + '.missing']);
    ok('an analysis that cannot be read: prepare and collect exit 65', r1.code === 65 && r2.code === 65, r1.all + r2.all);
    const r3 = run(['collect', '--shared', c.S, '--analysis', c.A, '--sha', 'a'.repeat(64)]);
    ok('collect --sha of a version without a folder: exit 65', r3.code === 65, r3.all);
  }

  // ---- a run number that does not exist: 3 ----
  {
    const c = fresh();
    prep(c);
    ok('collect --run 9 with no run 9: exit 3', collect(c, ['--run', '9']).code === 3);
    ok('prepare --abandon 9 with no run 9: exit 3', prep(c, ['t1'], ['--abandon', '9', '--reason', 'r']).code === 3);
    ok('collect --exit 0 twice with the same value: exit 0 both times', collect(c, ['--run', '1', '--exit', '0']).code === 0 && collect(c, ['--run', '1', '--exit', '0']).code === 0);
  }

  // ---- A7: a legacy last.json that is not a verdict does not block ----
  {
    const c = fresh();
    const leg = path.join(c.S, 'analysis-checks', 'k1', c.sha);
    fs.mkdirSync(leg, { recursive: true });
    fs.writeFileSync(path.join(leg, 'last.json'), JSON.stringify(answer(c.sha, ['k1'], 'ready', 2)));
    const p = prep(c, ['k1']);
    ok('A7 a legacy last.json "ready with 2 gaps": not-run, prepare for k1 not blocked', p.code === 0, p.all.slice(0, 400));
    const col = collect(c);
    const l = col.out && (col.out.legacy || [])[0];
    ok('A7 collect names the legacy file as not-run with its reason', !!l && l.state === 'not-run' && /ready with significantGaps 2/.test(l.reason || ''), JSON.stringify(col.out && col.out.legacy));
  }

  // ---- A19: a run inside a fenced block is not a run of the report ----
  {
    const c = fresh();
    fs.writeFileSync(c.report, 'An example of the format:\n```\n' + reportText(c.sha, ['t1'], 'changes-needed', 1) + '```\n');
    const p = prep(c);
    ok('A19 a "# Analysis check" inside ``` is not a run: prepare not blocked', p.code === 0, p.all.slice(0, 400));
  }

  // ---- A12 x A6: one appended run is one verdict, not two (the report run it wrote is not counted again) ----
  {
    const c = fresh();
    fs.writeFileSync(c.report, reportText('f'.repeat(64), ['t1'], 'ready', 0).trimEnd());
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    collect(c, ['--run', '1', '--exit', '0']);
    collect(c, ['--run', '1', '--append']);
    const rep = fs.readFileSync(c.report, 'utf8');
    ok('A12 append after a report without a final newline: the new run starts on a line of its own', /\n\n# Analysis check\n/.test(rep) && (rep.match(/^# Analysis check$/mg) || []).length === 2, JSON.stringify(rep.slice(0, 300)));
    const k = keyOf(collect(c).out, 't1');
    ok('A12 x A6 one run appended from here: one verdict for t1, twoVerdicts false', !!k && k.verdicts.length === 1 && k.twoVerdicts === false, JSON.stringify(k));
  }

  // ---- A6: two verdicts from two sources (a result in runs/ and a run of the report written elsewhere) ----
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    fs.writeFileSync(c.report, reportText(c.sha, ['t1'], 'changes-needed', 1));
    const col = collect(c);
    const k = keyOf(col.out, 't1');
    ok('A6 a result in runs/ and a report run of the same version: both verdicts, twoVerdicts, the strict note', !!k && k.twoVerdicts === true
      && k.verdicts.map((v) => v.verdict).sort().join(',') === 'changes-needed,ready' && /does not cancel/.test(col.all), JSON.stringify(k));
  }

  // ---- A1/K1: the printed command is the argv after the shell parses it (a sharedDir with a space, $, " and `) ----
  {
    const c = fresh('sp a$b"c`d\\e');
    const p = prep(c);
    const sh = spawnSync('/bin/sh', ['-c', `for a in ${(p.out && p.out.command || '').replace(/^codex /, '')}; do printf '%s\\n' "$a"; done`], { encoding: 'utf8' });
    const got = ['codex', ...sh.stdout.split('\n').slice(0, -1)];
    ok('A1 the command line parses back into the exact argv (quoting)', p.code === 0 && JSON.stringify(got) === JSON.stringify(p.out.argv), JSON.stringify(got));
  }

  // ---- A21: a real race of several prepare of one version: one run, one marker ----
  {
    const c = fresh();
    const rs = await Promise.all(Array.from({ length: 6 }, () => runAsync(prepArgs(c))));
    const runs = path.join(c.S, 'analysis-checks', c.sha, 'runs');
    const marks = fs.existsSync(runs) ? fs.readdirSync(runs).filter((f) => /\.prepared$/.test(f)) : [];
    ok('A21 six prepare at once: exactly one exit 0, the others exit 3', rs.filter((r) => r.code === 0).length === 1 && rs.filter((r) => r.code === 3).length === 5, rs.map((r) => r.code).join(','));
    ok('A21 six prepare at once: exactly one marker', marks.length === 1, marks.join(','));
  }

  // ---- A12: a race of two --append of one run: the report gets it once ----
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    collect(c, ['--run', '1', '--exit', '0']);
    await Promise.all(Array.from({ length: 4 }, () => runAsync(['collect', '--shared', c.S, '--analysis', c.A, '--run', '1', '--append'])));
    const rep = fs.existsSync(c.report) ? fs.readFileSync(c.report, 'utf8') : '';
    ok('A12 four --append at once: one run in the report', (rep.match(/^# Analysis check$/mg) || []).length === 1, rep.slice(0, 300));
  }

  // ---- A23 x A6: an answer rewritten after it was collected is two verdicts of one version ----
  // The earlier changes-needed was collected; a second codex exec of the same run rewrote runs/1.json with ready. The
  // rule of two verdicts (owner 2026-11-10, strict) holds for it like for --again: both verdicts for t1, the strict note,
  // and the refusal of prepare names the changes-needed, not only the later ready.
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const col = collect(c);
    const k = keyOf(col.out, 't1');
    ok('A23 x A6 a rewritten collected answer: t1 has two verdicts (twoVerdicts) and the strict note', !!k && k.twoVerdicts === true
      && /t1: two verdicts of one version/.test(col.all), JSON.stringify(k));
    const again = prep(c);
    ok('A23 x A6 prepare refuses and names the collected changes-needed too, not only the later ready', again.code === 3
      && /changes-needed/.test(again.out && again.out.refused || ''), (again.out && again.out.refused) || again.all.slice(0, 300));
  }

  // ---- A23: a collected answer rewritten by an answer that is not a verdict keeps its verdict ----
  // A second codex exec of run 1 after collect saw changes-needed leaves a file with another hash that is not a result
  // (not JSON, another analysisSha256). The verdict collect saw stays a verdict of t1: it is named, and prepare refuses
  // without --again (otherwise a new run of the version starts and the changes-needed is lost).
  for (const [name, bad] of [['not JSON', 'oops'], ['another analysisSha256', JSON.stringify(answer('0'.repeat(64), ['t1'], 'ready', 0))]]) {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    fs.writeFileSync(oFile(p), bad);
    const col = collect(c);
    const k = keyOf(col.out, 't1');
    ok(`A23 a collected changes-needed rewritten by ${name}: still a verdict of t1, named as changed after it was collected`,
      !!k && k.verdicts.some((v) => v.verdict === 'changes-needed') && /changed after it was collected/.test(col.all), JSON.stringify(col.out && col.out.keys));
    const again = prep(c);
    ok(`A23 a collected changes-needed rewritten by ${name}: prepare refuses (3) and names it`, again.code === 3
      && /changes-needed/.test(again.out && again.out.refused || ''), `exit ${again.code}`);
  }

  // ---- A23 x A12: an appended changes-needed, then the run rewritten by an answer that is not a verdict ----
  // The report holds the run of this version for t1 (written from here); prepare must still refuse without --again.
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    collect(c, ['--run', '1', '--append']);
    fs.writeFileSync(oFile(p), 'garbage');
    const k = keyOf(collect(c).out, 't1');
    ok('A23 x A12 appended then rewritten by garbage: t1 keeps the changes-needed', !!k && k.verdicts.some((v) => v.verdict === 'changes-needed'), JSON.stringify(k));
    const again = prep(c);
    ok('A23 x A12 appended then rewritten by garbage: prepare refuses (3) - the report holds a run of this version for t1', again.code === 3, `exit ${again.code}`);
  }

  // ---- A23: the rewrite names another key: the earlier answer still counts for its own key ----
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t2'], 'ready', 0));
    const k = keyOf(collect(c).out, 't1');
    ok('A23 rewrite for another key: collect shows t1 with the earlier changes-needed in keys', !!k && k.verdicts.some((v) => v.verdict === 'changes-needed'), JSON.stringify(k));
    ok('A23 rewrite for another key: prepare --task t1 refuses (3)', prep(c).code === 3);
  }

  // ---- A23: the same bytes written again are not a second verdict ----
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c, ['--run', '1', '--exit', '0']);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    const col = collect(c);
    const k = keyOf(col.out, 't1');
    ok('A23 the same answer written again: one verdict, no "changed" note', !!k && k.verdicts.length === 1 && !/changed after it was collected/.test(col.all), JSON.stringify(k));
  }

  done();
})();
