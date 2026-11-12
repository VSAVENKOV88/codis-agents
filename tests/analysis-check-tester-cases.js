'use strict';
// p-codex-D2b-1 tester cells of scripts/analysis-check.js, run by tests/analysis-check.test.js as a child with its own
// tally (so the README count of test files stays). Cells beyond the programmer's test: malformed arguments, an analysis
// that cannot be read, a legacy last.json that is not a verdict, a report run inside a fenced block, one appended run is
// one verdict (not two), two verdicts from two sources, a real race of several prepare and of two --append, the shell
// quoting of the printed command, and an answer rewritten after it was collected under the rule of two verdicts (A23 x A6), and an answer rewritten after collect by one that is not a verdict or that names another key (A23); the journal of
// answers (M2.2): a real race of observers, collect --sha as an observer, foreign files in runs/<n>.answers, and seeded
// sequences over several runs checked for the multiset of shown verdicts and for the journal and the report.
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
    const sh = spawnSync('/bin/sh', ['-c', `for a in ${(p.out && p.out.command || '').replace(/^node /, '')}; do printf '%s\\n' "$a"; done`], { encoding: 'utf8' });
    const got = ['node', ...sh.stdout.split('\n').slice(0, -1)];
    const want = ['node', SCRIPT, 'run', '--shared', c.S, '--analysis', c.A, '--sha', c.sha, '--run', '1'];
    ok('A1 the command line parses back into the exact argv of analysis-check.js run (quoting)', p.code === 0 && JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
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

  // ---- M2.2 the journal of answers (tester round 3) ----
  const journalFiles = (c, n) => { const d = path.join(c.S, 'analysis-checks', c.sha, 'runs', `${n}.answers`); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

  // E1: a real race of observers (no listing injected): one entry, every observer shows the verdict, prepare refuses.
  for (let i = 0; i < 4; i++) {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    const rs = await Promise.all(Array.from({ length: 6 }, (_, j) => runAsync(j % 2 ? ['collect', '--shared', c.S, '--analysis', c.A] : prepArgs(c))));
    const entries = journalFiles(c, 1).filter((f) => /\.json$/.test(f));
    const shown = rs.filter((r, j) => (j % 2 ? r.code === 0 : r.code === 3) && keyOf(r.out, 't1') && keyOf(r.out, 't1').verdicts.length === 1
      && keyOf(r.out, 't1').verdicts[0].verdict === 'changes-needed');
    ok(`E1 race ${i + 1}: six observers at once (3 prepare, 3 collect) - one journal entry, each shows the changes-needed once, every prepare refuses`,
      entries.length === 1 && shown.length === 6, `entries ${entries.join(',')}; ${rs.map((r) => `${r.code}:${JSON.stringify(keyOf(r.out, 't1'))}`).join(' | ').slice(0, 600)}`);
  }

  // E4: collect --sha (without --run) is an observer: it records the answer it saw.
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    const s1 = run(['collect', '--shared', c.S, '--analysis', c.A, '--sha', c.sha]);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const k = keyOf(collect(c).out, 't1');
    ok('E4 collect --sha saw the changes-needed, then a rewrite by ready: both verdicts of t1', s1.code === 0 && !!k && k.twoVerdicts === true
      && k.verdicts.map((v) => v.verdict).join(',') === 'changes-needed,ready', JSON.stringify(k));
  }

  // E5: an unknown file and a marker without its entry in runs/<n>.answers/: named, and a new answer is a new entry
  // with no marker (it is appended, not taken as appended already).
  {
    const c = fresh();
    const p = prep(c);
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'changes-needed', 1));
    collect(c);
    const d = path.join(c.S, 'analysis-checks', c.sha, 'runs', '1.answers');
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(d, '2.appended'), JSON.stringify({ reportRun: 1, textSha256: 'f'.repeat(64) }));
    writeAnswer(oFile(p), answer(c.sha, ['t1'], 'ready', 0));
    const col = collect(c);
    const r1 = col.out && (col.out.runs || []).find((r) => r.run === 1);
    ok('E5 an unknown file in runs/1.answers is named, the run stays a result with both answers', /unknown file: .*notes\.txt/.test(col.all)
      && !!r1 && r1.state === 'result' && (r1.answers || []).length === 2, JSON.stringify(r1));
    const ap = collect(c, ['--run', '1', '--append']);
    const rep = fs.existsSync(c.report) ? fs.readFileSync(c.report, 'utf8') : '';
    ok('E5 a marker without its entry does not mark the next answer: --append writes both answers', ap.code === 0
      && (rep.match(/^# Analysis check$/mg) || []).length === 2 && /Verdict: ready/.test(rep) && /Verdict: changes-needed/.test(rep), JSON.stringify(ap.out && ap.out.notes));
  }

  // E2/E3: seeded random sequences over several runs (prepare --again, --abandon, late answers, collect --sha, the
  // observer changes on every step). In process, through main(). Invariants after every step:
  //  - for each key, the count of every (run, verdict, significantGaps) a command showed never decreases (a multiset:
  //    one of two equal changes-needed lost is a loss);
  //  - prepare for a key with a shown verdict refuses (3) without --again;
  //  - the journal holds no two entries with one sha256; every marker's text is exactly one run of the report, and no
  //    run of this version is in the report twice.
  {
    const AC = require(SCRIPT);
    const mainOf = (args) => { const r = AC.main(args); return { code: r.code, out: r.out || {} }; };
    let seed = 20261111;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const fails = [];
    let steps = 0;
    for (let sq = 0; sq < 150 && fails.length < 8; sq++) {
      const c = fresh();
      const base = ['--shared', c.S, '--analysis', c.A];
      const runsDir = path.join(c.S, 'analysis-checks', c.sha, 'runs');
      const pool = [answer(c.sha, ['t1'], 'changes-needed', 1), answer(c.sha, ['t1'], 'changes-needed', 2), answer(c.sha, ['t1'], 'ready', 0),
        answer(c.sha, ['t2'], 'changes-needed', 3), answer(c.sha, ['t1', 't2'], 'ready', 0)];
      const bads = ['garbage', '', JSON.stringify(answer('0'.repeat(64), ['t1'], 'ready', 0))];
      const prepOf = (t, extra) => mainOf(['prepare', ...base, '--task', t, '--worktree', TMP, '--model', 'm1', ...(extra || [])]);
      let cur = 1;
      prepOf('t1');
      const ever = {};
      const log = [];
      const observe = (o, what) => {
        if (!o.out || !o.out.keys) return; // a prepare that made a run prints the run, not the keys
        const now = {};
        for (const [t, x] of Object.entries((o.out && o.out.keys) || {})) {
          now[t] = {};
          for (const v of x.verdicts) { const id = `${(/^run (\d+)/.exec(v.from) || [])[1] || v.from}|${v.verdict}${v.significantGaps}`; now[t][id] = (now[t][id] || 0) + 1; }
        }
        for (const [t, m] of Object.entries(ever)) for (const [id, cnt] of Object.entries(m)) {
          const got = (now[t] && now[t][id]) || 0;
          if (got < cnt) fails.push(`seq ${sq} [${log.join(' ')}] after ${what}: ${t} shows ${got} of ${id}, earlier ${cnt}`);
        }
        for (const [t, m] of Object.entries(now)) { ever[t] = ever[t] || {}; for (const [id, cnt] of Object.entries(m)) ever[t][id] = Math.max(ever[t][id] || 0, cnt); }
        // the oracle on disk: every entry of every journal is shown for each key of its answer, as many times as it is there
        const want = {};
        for (const f of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((x) => /^\d+\.answers$/.test(x)) : []) {
          for (const x of fs.readdirSync(path.join(runsDir, f)).filter((y) => /^\d+\.json$/.test(y))) {
            const a = JSON.parse(fs.readFileSync(path.join(runsDir, f, x), 'utf8')).answer;
            for (const t of a.tasks) { const id = `${parseInt(f, 10)}|${a.verdict}${a.significantGaps}`; want[t] = want[t] || {}; want[t][id] = (want[t][id] || 0) + 1; }
          }
        }
        for (const [t, m] of Object.entries(want)) for (const [id, cnt] of Object.entries(m)) {
          const got = (now[t] && now[t][id]) || 0;
          if (got !== cnt) fails.push(`seq ${sq} [${log.join(' ')}] after ${what}: ${t} shows ${got} of ${id}, the journal holds ${cnt}`);
        }
      };
      const observer = () => {
        const w = rnd(5);
        const [what, o] = w === 0 ? ['collect', mainOf(['collect', ...base])]
          : w === 1 ? ['collect --sha', mainOf(['collect', ...base, '--sha', c.sha])]
            : w === 2 ? ['append', mainOf(['collect', ...base, '--run', String(cur), '--append'])]
              : w === 3 ? ['prepare t1', prepOf('t1')]
                : ['prepare t2', prepOf('t2')];
        if (what.startsWith('prepare') && o.code === 0) cur = o.out.run;
        log.push(what); observe(o, what);
      };
      for (let st = 0; st < 10; st++) {
        steps++;
        const file = path.join(runsDir, `${cur}.json`);
        const e = rnd(9);
        if (e <= 2) { const a = Object.assign({}, pool[rnd(pool.length)]); a.report += `\nAn answer of run ${cur}.\n`; writeAnswer(file, a); log.push(`w${cur}:${a.tasks.join('+')}/${a.verdict}${a.significantGaps}`); }
        else if (e === 3) { fs.writeFileSync(file, bads[rnd(bads.length)]); log.push(`bad${cur}`); }
        else if (e === 4) { if (fs.existsSync(file)) fs.unlinkSync(file); log.push(`rm${cur}`); }
        else if (e === 5) { const x = rnd(2); const o = mainOf(['collect', ...base, '--run', String(cur), '--exit', String(x)]); log.push(`exit${cur}=${x}`); observe(o, 'exit'); }
        else if (e === 6) { const o = prepOf(rnd(2) ? 't1' : 't2', ['--again', 'r']); if (o.code === 0) cur = o.out.run; log.push(`again:${o.code === 0 ? `run ${cur}` : `exit ${o.code}`}`); observe(o, 'again'); }
        else if (e === 7) { const o = prepOf('t1', ['--abandon', String(cur), '--reason', 'r']); log.push(`abandon${cur}:${o.code}`); observe(o, 'abandon'); }
        else log.push('-');
        observer();
        // prepare for every key with a shown verdict refuses without --again
        for (const [t, m] of Object.entries(ever)) {
          if (!Object.keys(m).length) continue;
          const pr = prepOf(t);
          if (pr.code !== 3) { fails.push(`seq ${sq} [${log.join(' ')}]: prepare --task ${t} exit ${pr.code} although ${Object.keys(m).join(',')} was shown`); if (pr.code === 0) cur = pr.out.run; }
          observe(pr, `prepare ${t} (gate)`);
        }
        // the journal and the report
        const rep = fs.existsSync(c.report) ? AC.reportRuns(fs.readFileSync(c.report, 'utf8')) : [];
        const texts = rep.map((x) => x.textSha256);
        if (new Set(texts).size !== texts.length) fails.push(`seq ${sq} [${log.join(' ')}]: a run is in the report twice`);
        for (const f of fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((x) => /\.answers$/.test(x)) : []) {
          const d = path.join(runsDir, f);
          const hashes = fs.readdirSync(d).filter((x) => /^\d+\.json$/.test(x)).map((x) => JSON.parse(fs.readFileSync(path.join(d, x), 'utf8')).sha256);
          if (new Set(hashes).size !== hashes.length) fails.push(`seq ${sq} [${log.join(' ')}]: ${f} holds one answer twice`);
          for (const m of fs.readdirSync(d).filter((x) => /\.appended$/.test(x))) {
            const t = JSON.parse(fs.readFileSync(path.join(d, m), 'utf8')).textSha256;
            if (texts.filter((x) => x === t).length !== 1) fails.push(`seq ${sq} [${log.join(' ')}]: ${f}/${m} is not exactly one run of the report`);
          }
        }
      }
      fs.rmSync(c.S, { recursive: true, force: true });
    }
    ok(`E2/E3 seeded sequences (150 x 10 steps, several runs, the observer changes): no shown verdict is lost (multiset), prepare refuses, the journal and the report hold each answer once (${steps} steps)`,
      fails.length === 0, fails.slice(0, 4).join('\n'));
  }

  done();
})();
