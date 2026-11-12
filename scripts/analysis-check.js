#!/usr/bin/env node
'use strict';
// The runs of the analysis check on Codex: every launch of the checker is a run of its own, and no result is removed
// or overwritten by this script. The coordinator runs `prepare` and `collect` in its sandbox (they write only under
// <sharedDir>/analysis-checks/ and, with --append, the report next to the analysis). `run` is the only command that
// starts the checker: the fourth execpolicy rule of the coordinator home lets `node <plugin>/scripts/analysis-check.js
// run` out of the sandbox (the checker needs the network), and no rule lets a direct `codex exec` out.
//
// usage:
//   analysis-check.js prepare --shared <sharedDir> --analysis <path> --task <key> [--task <key>...] --worktree <path>
//       --model <codex model> [--brief <p>] [--use-cases <p>] [--spec <p>] [--again <reason>]
//       [--abandon <n> --reason <text>]
//   analysis-check.js run --shared <sharedDir> --analysis <path> --sha <sha256> --run <n>
//   analysis-check.js collect --shared <sharedDir> --analysis <path> [--sha <sha256>] [--task <key>...]
//       [--run <n> [--exit <N>] [--append]]
//
// Layout of one version of the analysis (its sha256), <sharedDir>/analysis-checks/<sha>/:
//   analysis-<sha>.md   the copy the checker reads (the folder is a version folder because it holds this file)
//   task-<n>.md         the task of run n
//   runs/<n>.prepared   the run's marker {run, tasks, analysis, again?, argv}, created with O_EXCL
//   runs/<n>.running    {pid, lstart, at} of the `run` that started the checker, created with O_EXCL
//   runs/<n>.json       the answer, written by `codex exec -o`
//   runs/<n>.exit       the exit code of `codex exec`: recorded by `run`, or by `collect --exit` for a run without
//                       runs/<n>.running
//   runs/<n>.died       {pid, lstart, at}: a later `run` found the process of runs/<n>.running gone without an exit
//   runs/<n>.abandoned  {reason}: a run that was never started, ended by `prepare --abandon`
//   runs/<n>.answers/<k>.json      the journal of the run: {sha256, at, answer}, one entry per distinct valid answer
//                                  any command saw in runs/<n>.json (sha256 of its bytes), k in the order they were seen
//   runs/<n>.answers/<k>.appended  {reportRun, textSha256, ...} once --append wrote answer k to the report
// The earlier layout <sharedDir>/analysis-checks/<key>/<sha>/ (last.json and other files) is only read.
//
// To see is to record: every command reads every run of the version first, and a valid runs/<n>.json (schema,
// analysisSha256 = sha, verdict agrees with significantGaps, the header lines of report agree with the fields) that is
// not in the journal yet is recorded there before anything is printed - unless an exit other than 0 is recorded for the
// run. No command removes or rewrites an entry, so a second `codex exec` of the run that rewrites the file after a
// command saw it adds an answer and hides none; only an answer rewritten before any command saw it is lost.
//
// The state of run n, first match wins:
//   the journal has entries -> result: each entry is a verdict for the keys of its own `tasks`; the file now is only
//     named (the answer it is now, not a verdict, gone; a later exit other than 0; "late, after abandon"; "late,
//     after died"; "exit not recorded")
//   runs/<n>.json and an exit other than 0 recorded -> not-run: exit N
//   runs/<n>.json not valid -> not-run: <reason>
//   no runs/<n>.json and .abandoned -> not-run: abandoned (<reason>)
//   no runs/<n>.json and .died -> not-run: died (pid P, started L)
//   no runs/<n>.json and .exit -> not-run: exit N, no runs/<n>.json
//   otherwise -> prepared (pending); with .running the run is named with the pid that started it
// A result counts for key t only when t is in the `tasks` of the answer (rule "Waves": the check of a task is a run whose
// Tasks line names its key). `prepare` makes a run only when no requested key has a result (in runs/, in the earlier
// layout, or as a run of <name of the analysis>.check.md with this Analysis-sha256 and the key in Tasks) - unless
// --again - and the version has no pending run of any key: one pending run per version.
//
// `run --run n` outside the sandbox: ps must answer (inside the sandbox it is refused: exit 69 before anything is
// read or written); the version folder, runs/, runs/<n>.answers and runs/<n>.json must not be symbolic links (run
// writes through them outside the sandbox: 65); then it reads every run as any command does and starts the checker
// only for a pending run without runs/<n>.running. The argv it starts is the template of this copy of the plugin with
// the worktree and the model of the marker (both checked); the marker's argv must equal it (65 otherwise: the marker is
// written in the sandbox, so its argv is never run as it stands). runs/<n>.running is claimed with O_EXCL, so at most
// one checker is started per run. A second `run` of a run with runs/<n>.running is refused (3): while the process of the
// marker lives (its pid and start time, as ps names them) it says so; when it is gone and the run has no exit and no
// answer, it records runs/<n>.died first. A marker that cannot be read yet is never taken for a dead run. The checker
// gets stdin /dev/null (`codex exec` with a prompt reads a stdin that is not a terminal to its end before it starts)
// and the stderr of `run` for its output; INT, TERM and HUP to `run` are passed to it. Its exit (127 when it cannot be
// started, 128+signal when a signal ended it) is recorded before the run is read, as `collect --exit` does: an answer
// of a failed checker is never recorded. Liveness can be told only outside the sandbox, so `prepare` and `collect` show
// a run with runs/<n>.running as pending, and `prepare --abandon` refuses it (the next `run` tells).
//
// Exit: 0 done (for `run`: the checker was started and its exit recorded, the output names it); 3 refused by the state
// of the runs (the output names it); 64 usage; 65 the data (an analysis that cannot be read, a copy whose sha256 differs
// from its name, a version folder that does not exist for --sha, a marker whose argv is not the template, a symbolic
// link); 69 `run` where ps does not answer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const SCHEMA = path.join(PLUGIN, 'schemas', 'analysis-check.schema.json');
const CHECKER = path.join(PLUGIN, 'agents', 'analysis-checker.md');
const HEX = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9._-]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The path this script was started by, as written (the rule matches the literal path, not its realpath).
const SELF = require.main === module ? path.resolve(process.argv[1]) : __filename;
const SUFFIXES = ['prepared', 'running', 'json', 'exit', 'died', 'abandoned', 'answers'];

class Exit extends Error { constructor(code, msg, out) { super(msg); this.code = code; this.out = out; } }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => fs.existsSync(f);

// Writes a file only when it does not exist yet (O_EXCL): true when this call created it, false when it was there.
function claim(file, data) {
  try {
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data) + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
// Claims the number n of a run: the marker runs/<n>.prepared. Two sessions that compute the same n race here, and the
// loser gets false.
const claimRun = (runsDir, n, data) => claim(path.join(runsDir, `${n}.prepared`), Object.assign({ run: n }, data));

// ---- the answer of the checker ----

// The machine lines of one run of a report: the lines from `# Analysis check` up to the first section heading.
function headerOf(text) {
  const lines = text.split('\n');
  const h = {};
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l) || /^# Analysis check\s*$/.test(l)) break;
    const m = /^(Analysis|Analysis-sha256|Tasks|Verdict|Significant gaps|Saved-by):[ \t]*(.*?)\s*$/.exec(l);
    if (m && !(m[1] in h)) h[m[1]] = { value: m[2], line: i };
  }
  return h;
}
// The keys of a Tasks line `<key>[, <key>...]`, or null for a line not in that format (no key is guessed from it).
function taskKeys(value) {
  if (value == null) return null;
  const parts = value.split(',').map((s) => s.trim());
  return parts.length && parts.every((p) => KEY.test(p)) ? parts : null;
}
// The identity of the text of one run of a report: its lines from `# Analysis check` up to the section Closure, which the
// coordinator writes into the run after it was appended (agents/analysis-checker.md, "The section Closure is written by
// the coordinator"), without trailing whitespace.
function runTextSha(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^# Analysis check\s*$/.test(l));
  const rest = lines.slice(Math.max(start, 0));
  const end = rest.findIndex((l) => /^## Closure\s*$/.test(l));
  return sha256((end < 0 ? rest : rest.slice(0, end)).join('\n').replace(/\s+$/, ''));
}
// Splits a report into its runs: each starts at a line `# Analysis check` outside a fenced block.
function reportRuns(text) {
  const lines = text.split('\n');
  const starts = [];
  let fence = false;
  lines.forEach((l, i) => { if (/^\s*```/.test(l)) fence = !fence; else if (!fence && /^# Analysis check\s*$/.test(l)) starts.push(i); });
  return starts.map((s, k) => {
    const body = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length).join('\n');
    const h = headerOf(body);
    const v = (name) => (h[name] ? h[name].value : null);
    return { ordinal: k + 1, sha: v('Analysis-sha256'), tasksLine: v('Tasks'), tasks: taskKeys(v('Tasks')), verdict: v('Verdict'),
      significantGaps: v('Significant gaps'), savedBy: v('Saved-by'), textSha256: runTextSha(body) };
  });
}
// Why an answer is not a verdict for version sha, or null when it is one.
function invalid(a, sha) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'not a JSON object';
  const want = ['analysisSha256', 'tasks', 'verdict', 'significantGaps', 'report'];
  for (const k of want) if (!(k in a)) return `the schema: no field ${k}`;
  for (const k of Object.keys(a)) if (!want.includes(k)) return `the schema: an unknown field ${k}`;
  if (typeof a.analysisSha256 !== 'string') return 'the schema: analysisSha256 is not a string';
  if (!Array.isArray(a.tasks) || !a.tasks.every((t) => typeof t === 'string')) return 'the schema: tasks is not an array of strings';
  if (!['ready', 'changes-needed'].includes(a.verdict)) return 'the schema: verdict is not ready or changes-needed';
  if (!Number.isInteger(a.significantGaps)) return 'the schema: significantGaps is not an integer';
  if (typeof a.report !== 'string') return 'the schema: report is not a string';
  if (a.analysisSha256 !== sha) return `analysisSha256 ${a.analysisSha256} differs from the sha256 of the copy`;
  if (a.verdict === 'ready' && a.significantGaps !== 0) return `ready with significantGaps ${a.significantGaps}`;
  if (a.verdict === 'changes-needed' && a.significantGaps < 1) return `changes-needed with significantGaps ${a.significantGaps}`;
  // The report goes into <name of the analysis>.check.md, which the gate of the wave reads, so its machine lines must
  // say what the checked fields say.
  const runs = reportRuns(a.report);
  if (runs.length !== 1 || !/^\s*# Analysis check\s*$/m.test(a.report.split('\n').find((l) => l.trim()) || '')) {
    return `report header disagrees with the answer (the report must be one run starting with "# Analysis check", it has ${runs.length})`;
  }
  const r = runs[0];
  if (r.verdict !== a.verdict) return 'report header disagrees with the answer (verdict)';
  if (r.significantGaps !== String(a.significantGaps)) return 'report header disagrees with the answer (significantGaps)';
  if (!r.tasks || [...new Set(r.tasks)].sort().join(',') !== [...new Set(a.tasks)].sort().join(',')) return 'report header disagrees with the answer (tasks)';
  if (r.sha != null && r.sha !== sha) return 'report header disagrees with the answer (analysisSha256)';
  return null;
}
const summary = (a) => ({ verdict: a.verdict, significantGaps: a.significantGaps, tasks: a.tasks });

// ---- the folders ----

const checksDir = (shared) => path.join(shared, 'analysis-checks');
const versionDir = (shared, sha) => path.join(checksDir(shared), sha);
const reportPath = (analysis) => path.join(path.dirname(analysis), path.basename(analysis).replace(/\.md$/, '') + '.check.md');
const isVersionDir = (d, name) => exists(path.join(d, `analysis-${name}.md`));

// A copy whose sha256 differs from its name is a changed fixed version: refuse with its path.
function checkCopy(dir, sha) {
  const copy = path.join(dir, `analysis-${sha}.md`);
  if (exists(copy)) {
    const got = sha256(fs.readFileSync(copy));
    if (got !== sha) throw new Exit(65, `the copy ${copy} changed: its sha256 is ${got}, not ${sha}`);
  }
}

// The numbers of the runs of a version, from the names in runs/; other names are unknown files.
function runNumbers(runsDir) {
  const nums = new Set(), unknown = [];
  let names = [];
  try { names = fs.readdirSync(runsDir); } catch { /* no runs yet */ }
  for (const f of names) {
    const m = /^(\d+)\.([a-z]+)$/.exec(f);
    if (m && SUFFIXES.includes(m[2])) nums.add(+m[1]); else unknown.push(f);
  }
  return { nums: [...nums].sort((a, b) => a - b), unknown };
}

const answersDir = (dir, n) => path.join(dir, 'runs', `${n}.answers`);
const runFile = (dir, n, suffix) => path.join(dir, 'runs', `${n}.${suffix}`);
// The argv of the checker of run n: the template of this copy of the plugin, with the worktree and the model.
const checkerArgv = (dir, n, worktree, model) => ['codex', 'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
  '--output-schema', SCHEMA, '-o', runFile(dir, n, 'json'), '-C', worktree, '-m', model, `Read ${path.join(dir, `task-${n}.md`)} and do what it says.`];

// The journal of run n: its readable entries in order, the numbers of entries that cannot be read (being written by
// another command, or damaged), the append markers and unknown files.
function journal(dir, sha, n) {
  const d = answersDir(dir, n);
  let names = [];
  try { names = fs.readdirSync(d); } catch { /* nothing seen yet */ }
  const entries = [], unreadable = [], unknown = [], marks = new Map();
  let top = 0;
  for (const f of names) {
    const m = /^(\d+)\.(json|appended)$/.exec(f);
    if (!m) { unknown.push(path.join(d, f)); continue; }
    const k = +m[1];
    top = Math.max(top, k);
    const v = readJson(path.join(d, f));
    if (m[2] === 'appended') marks.set(k, v || {});
    else if (v && typeof v.sha256 === 'string' && HEX.test(v.sha256) && !invalid(v.answer, sha)) entries.push({ k, sha256: v.sha256, answer: v.answer });
    else unreadable.push(k);
  }
  entries.sort((a, b) => a.k - b.k);
  for (const e of entries) e.mark = marks.get(e.k) || null;
  return { entries, unreadable, unknown, top };
}

// Records a valid answer of run n in its journal unless an entry with its sha256 is there. The entry k is created with
// O_EXCL: an observer that loses the race reads the winner's entry and stops when it holds the same answer, or tries
// k+1. While an entry cannot be read (another command is writing it) nothing is recorded: that command records it.
function record(dir, sha, n, hash, answer) {
  fs.mkdirSync(answersDir(dir, n), { recursive: true });
  for (;;) {
    const j = journal(dir, sha, n);
    if (j.unreadable.length || j.entries.some((e) => e.sha256 === hash)) return;
    if (claim(path.join(answersDir(dir, n), `${j.top + 1}.json`), { sha256: hash, at: new Date().toISOString(), answer })) return;
  }
}

function stateOf(dir, sha, n) {
  const f = (s) => path.join(dir, 'runs', `${n}.${s}`);
  const mark = readJson(f('prepared'));
  const exitRaw = exists(f('exit')) ? fs.readFileSync(f('exit'), 'utf8').trim() : null;
  const exit = exitRaw == null ? null : (/^-?\d+$/.test(exitRaw) ? +exitRaw : exitRaw);
  const failed = exit != null && exit !== 0;
  const abandoned = exists(f('abandoned')) ? (readJson(f('abandoned')) || {}) : null;
  const died = exists(f('died')) ? (readJson(f('died')) || {}) : null;
  const running = exists(f('running')) ? (readJson(f('running')) || {}) : null;
  const r = { run: n, prepared: !!mark, asked: mark && mark.tasks ? mark.tasks : null, again: mark && mark.again ? mark.again : null, exit, notes: [] };
  if (!mark) r.notes.push('without prepare: no runs/' + n + '.prepared');
  // the file now: a valid answer (its hash), not a verdict (why), or gone
  let now = null;
  if (exists(f('json'))) {
    const buf = fs.readFileSync(f('json'));
    let a = null, why = null;
    try { a = JSON.parse(buf.toString('utf8')); } catch (e) { why = 'runs/' + n + '.json is not JSON: ' + e.message; }
    if (!why) why = invalid(a, sha);
    now = why ? { why } : { hash: sha256(buf), answer: a };
  }
  if (now && now.hash && !failed) record(dir, sha, n, now.hash, now.answer);
  const j = journal(dir, sha, n);
  r._unknown = j.unknown;
  for (const k of j.unreadable) r.notes.push(`runs/${n}.answers/${k}.json cannot be read (another command is writing it, or it is damaged): nothing new is recorded for run ${n} while it is so`);
  // A valid file this call could not record (an entry being written) is still shown as an answer of the run.
  const entries = j.entries.slice();
  if (now && now.hash && !failed && !entries.some((e) => e.sha256 === now.hash)) entries.push({ k: null, sha256: now.hash, answer: now.answer, mark: null });
  if (!entries.length) {
    if (now && failed) return Object.assign(r, { state: 'not-run', reason: `exit ${exit}` });
    if (now) return Object.assign(r, { state: 'not-run', reason: now.why });
    if (abandoned) return Object.assign(r, { state: 'not-run', reason: `abandoned (${abandoned.reason || ''})` });
    if (died) return Object.assign(r, { state: 'not-run', reason: `died (pid ${died.pid}, started ${died.lstart})` });
    if (exit != null) return Object.assign(r, { state: 'not-run', reason: `exit ${exit}, no runs/${n}.json` });
    if (running) {
      r.running = { pid: running.pid == null ? null : running.pid, lstart: running.lstart == null ? null : running.lstart };
      r.notes.push(`started by analysis-check.js run as pid ${running.pid} since ${running.lstart}; whether it lives cannot be told here: `
        + `run that command again (it is refused while the run lives and records the run as died when it is gone)`);
    }
    return Object.assign(r, { state: 'prepared' });
  }
  const m = entries.length;
  const last = entries[m - 1];
  Object.assign(r, { state: 'result' }, summary(last.answer));
  r.answers = entries.map((e) => Object.assign({ answer: e.k }, summary(e.answer), { appended: !!e.mark }));
  r.appended = entries.every((e) => !!e.mark);
  r._entries = entries;
  if (abandoned) r.notes.push('late, after abandon');
  if (died) r.notes.push('late, after died');
  if (exit == null) r.notes.push('exit not recorded');
  if (failed) r.notes.push(`exit ${exit} recorded after answer ${j.entries.length ? j.entries[j.entries.length - 1].k : 1} was recorded: the recorded answers stay verdicts; name the exit to the owner`);
  if (m > 1) r.notes.push(`${m} answers: a second codex exec of run ${n} rewrote runs/${n}.json after a command saw it - each answer is a verdict for its keys; name every one to the owner`);
  if (!now) r.notes.push(`runs/${n}.json is gone - the recorded answers stay verdicts`);
  else if (now.why) r.notes.push(`runs/${n}.json changed after it was collected - a second codex exec of run ${n}: now not a verdict (${now.why}); the recorded answers stay verdicts`);
  else {
    const at = entries.find((e) => e.sha256 === now.hash);
    if (!at) r.notes.push(`runs/${n}.json changed after it was collected and is not recorded (exit ${exit} recorded): name it to the owner`);
    else if (m > 1) r.notes.push(`runs/${n}.json is now answer ${at.k == null ? m : at.k} of ${m}`);
    if (at && at.k == null) r.notes.push(`runs/${n}.json is not recorded yet - an entry of the journal is being written`);
  }
  if (r.asked) {
    for (const e of entries) {
      const missing = r.asked.filter((t) => !e.answer.tasks.includes(t));
      if (missing.length) r.notes.push(`${m > 1 ? `answer ${e.k == null ? m : e.k}: ` : ''}asked for ${r.asked.join(', ')}; the checker named ${e.answer.tasks.join(', ') || 'none'}: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not checked`);
    }
  }
  return r;
}

// Everything known about version sha of the analysis: its runs, the earlier layout, the runs of the report.
function survey(shared, analysis, sha) {
  const dir = versionDir(shared, sha);
  checkCopy(dir, sha);
  const { nums, unknown } = runNumbers(path.join(dir, 'runs'));
  const runs = nums.map((n) => stateOf(dir, sha, n));
  const legacy = [], unknownFiles = unknown.map((f) => path.join(dir, 'runs', f)).concat(...runs.map((r) => r._unknown)), otherVersions = [];
  const root = checksDir(shared);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  const absA = path.resolve(analysis);
  for (const name of entries) {
    const d = path.join(root, name);
    if (isVersionDir(d, name)) {
      if (name === sha) continue;
      // another version of the same analysis: a marker of it names this analysis
      const rn = runNumbers(path.join(d, 'runs')).nums;
      if (rn.some((n) => { const m = readJson(path.join(d, 'runs', `${n}.prepared`)); return m && m.analysis === absA; })) {
        otherVersions.push({ sha: name, where: d });
      }
      continue;
    }
    // The earlier layout: <key>/<sha>/ with last.json; the other files are named, never removed.
    const ld = path.join(d, sha);
    let files = [];
    try { files = fs.readdirSync(ld); } catch { /* no such version under this key */ }
    for (const f of files) {
      const p = path.join(ld, f);
      if (f === 'last.json') {
        const a = readJson(p);
        const why = a ? invalid(a, sha) : 'last.json is not JSON';
        legacy.push(why ? { key: name, file: p, state: 'not-run', reason: why } : Object.assign({ key: name, file: p, state: 'result' }, summary(a)));
      } else if (f !== `analysis-${sha}.md` && f !== 'task.md') unknownFiles.push(p);
    }
  }
  const report = reportPath(analysis);
  const rep = exists(report) ? reportRuns(fs.readFileSync(report, 'utf8')) : [];
  // The report runs this folder wrote: their text is the text an append marker names (not their ordinal: another writer
  // may append between the count and the write). Their verdicts come from the journal.
  const texts = new Set(runs.flatMap((r) => (r._entries || []).map((e) => e.mark && e.mark.textSha256)).filter(Boolean));
  const mine = rep.filter((x) => x.sha === sha);
  for (const x of mine) x.here = texts.has(x.textSha256);
  for (const x of rep) if (x.sha && x.sha !== sha) otherVersions.push({ sha: x.sha, reportRun: x.ordinal, verdict: x.verdict, tasks: x.tasksLine });
  const notInFormat = mine.filter((x) => !x.tasks).map((x) => ({ reportRun: x.ordinal, line: `Tasks: ${x.tasksLine == null ? '' : x.tasksLine}` }));
  return { dir, report, runs, legacy, unknownFiles, otherVersions, reportRunsOfVersion: mine, notInFormat };
}

// The verdicts that count for key t: every answer in the journals of runs/, legacy results, and runs of the report not
// appended from here.
function verdictsFor(s, t) {
  const v = [];
  for (const r of s.runs) {
    if (r.state !== 'result') continue;
    const many = r._entries.length > 1;
    r._entries.forEach((e, i) => {
      if (e.answer.tasks.includes(t)) v.push({ from: `run ${r.run}${many ? ` answer ${e.k == null ? i + 1 : e.k}` : ''}`, verdict: e.answer.verdict, significantGaps: e.answer.significantGaps, appended: !!e.mark });
    });
  }
  for (const l of s.legacy) if (l.state === 'result' && l.tasks.includes(t)) v.push({ from: `legacy ${l.file}`, verdict: l.verdict, significantGaps: l.significantGaps });
  for (const x of s.reportRunsOfVersion) {
    if (x.tasks && x.tasks.includes(t) && !x.here) {
      v.push({ from: `report run ${x.ordinal} of ${s.report}`, verdict: x.verdict, significantGaps: x.significantGaps, savedBy: x.savedBy ? 'yes' : 'no' });
    }
  }
  return v;
}

const TWO = 'two verdicts of one version: name both to the owner; a changes-needed needs its Closure lines, and a later ready of the same version does not cancel it';
const PENDING = (n, cmd) => `run ${n} has no result yet. Poll the command that started it, ${cmd}: running it again is refused while the run lives (exit 3) `
  + `and records the run as died when it is gone. Only for a run that was never started: prepare --abandon ${n} --reason <why>`;
const runCommand = (shared, analysis, sha, n) => ['node', SELF, 'run', '--shared', shared, '--analysis', analysis, '--sha', sha, '--run', String(n)].map(quote).join(' ');
const strip = (r) => { const o = Object.assign({}, r); delete o._entries; delete o._unknown; return o; };

function view(s, keys) {
  const allKeys = new Set(keys || []);
  for (const r of s.runs) if (r.state === 'result') r._entries.forEach((e) => e.answer.tasks.forEach((t) => allKeys.add(t)));
  for (const l of s.legacy) if (l.state === 'result') l.tasks.forEach((t) => allKeys.add(t));
  for (const x of s.reportRunsOfVersion) (x.tasks || []).forEach((t) => allKeys.add(t));
  const k = {};
  for (const t of allKeys) {
    const v = verdictsFor(s, t);
    k[t] = { verdicts: v, twoVerdicts: v.length > 1 };
  }
  const notes = [];
  for (const [t, x] of Object.entries(k)) if (x.twoVerdicts) notes.push(`${t}: ${TWO}`);
  for (const r of s.runs) for (const n of r.notes) notes.push(`run ${r.run}: ${n}`);
  for (const f of s.unknownFiles) notes.push(`unknown file: ${f}`);
  for (const x of s.notInFormat) notes.push(`report run ${x.reportRun}: Tasks line not in the format <key>[, <key>...]: ${x.line}`);
  for (const o of s.otherVersions) notes.push(`another version - not a check of this one: ${o.sha}${o.reportRun ? ` (report run ${o.reportRun})` : ''}`);
  return {
    dir: s.dir, report: s.report, runs: s.runs.map(strip), legacy: s.legacy, unknownFiles: s.unknownFiles, otherVersions: s.otherVersions,
    keys: k, reportRuns: s.reportRunsOfVersion.length, appendedHere: s.reportRunsOfVersion.filter((x) => x.here).length, notes,
  };
}

// ---- the task of a run ----

function taskText(o) {
  const body = fs.readFileSync(CHECKER, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const line = (name, v) => (v ? `- ${name}: ${v}\n` : '');
  return `${body}\n\n## Your task\n\n`
    + `- the analysis (a fixed copy): ${o.copy}\n- its original: ${o.analysis}\n- its sha256: ${o.sha}\n`
    + line('the brief', o.brief) + line('the use cases', o.useCases) + line('the specification', o.spec)
    + `- the worktree: ${o.worktree}\n- the task keys: ${o.tasks.join(', ')}\n\n`
    + 'This sandbox is read-only: write nothing and run no experiment that writes; a premise that needs one is '
    + '`unverifiable (read-only sandbox)`. Return your run of the report in the field report and the sha256 of the copy '
    + 'in analysisSha256; name in tasks only the keys you checked.\n';
}
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);

// ---- the commands ----

function parse(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd, task: [], given: [] };
  const one = ['--shared', '--analysis', '--worktree', '--model', '--brief', '--use-cases', '--spec', '--again', '--abandon', '--reason', '--sha', '--run', '--exit'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--task') { if (rest[i + 1] == null) throw new Exit(64, '--task needs a value'); o.task.push(rest[++i]); }
    else if (a === '--append') o.append = true;
    else if (one.includes(a)) { if (rest[i + 1] == null) throw new Exit(64, `${a} needs a value`); o[a.slice(2)] = rest[++i]; }
    else throw new Exit(64, `unknown argument ${a}`);
    o.given.push(a);
  }
  return o;
}
const RUN_USAGE = 'analysis-check.js run --shared <dir> --analysis <path> --sha <sha256> --run <n>';
const USAGE = 'usage: analysis-check.js prepare --shared <dir> --analysis <path> --task <key>... --worktree <path> --model <model> '
  + '[--brief <p>] [--use-cases <p>] [--spec <p>] [--again <reason>] [--abandon <n> --reason <text>]\n'
  + `       ${RUN_USAGE}\n`
  + '       analysis-check.js collect --shared <dir> --analysis <path> [--sha <sha256>] [--task <key>...] [--run <n> [--exit <N>] [--append]]';

function readAnalysis(p) {
  try { return fs.readFileSync(p); } catch (e) { throw new Exit(65, `cannot read the analysis ${p}: ${e.code || e.message}`); }
}

function prepare(o) {
  if (!o.shared || !o.analysis || !o.task.length || !o.worktree || !o.model) throw new Exit(64, USAGE);
  if (o.task.some((t) => !KEY.test(t))) throw new Exit(64, `a task key is [A-Za-z0-9._-]+: ${o.task.join(', ')}`);
  if (o.abandon != null && (!/^\d+$/.test(o.abandon) || !o.reason)) throw new Exit(64, '--abandon <n> needs a run number and --reason <text>');
  if (o.again === '') throw new Exit(64, '--again needs a reason');
  if (!MODEL.test(o.model)) throw new Exit(64, `--model is [A-Za-z0-9][A-Za-z0-9._-]*: ${o.model}`);
  const shared = path.resolve(o.shared);
  const analysis = path.resolve(o.analysis);
  const buf = readAnalysis(analysis);
  const sha = sha256(buf);
  const dir = versionDir(shared, sha);
  const runsDir = path.join(dir, 'runs');
  const cmdOf = (n) => runCommand(shared, analysis, sha, n);
  let s = survey(shared, analysis, sha);
  const notes = [];
  if (o.abandon != null) {
    const n = +o.abandon;
    const r = s.runs.find((x) => x.run === n);
    if (!r) throw new Exit(3, `no run ${n} in ${dir}`, view(s, o.task));
    if (r.state === 'result') throw new Exit(3, `run ${n} has a result (${r.verdict}): it is not abandoned`, view(s, o.task));
    if (r.state !== 'prepared') throw new Exit(3, `run ${n} is not pending (${r.state}: ${r.reason})`, view(s, o.task));
    if (r.running) {
      throw new Exit(3, `run ${n} was started by analysis-check.js run (pid ${r.running.pid} since ${r.running.lstart}): run ${cmdOf(n)} - it is refused `
        + 'while the run lives and records the run as died when it is gone; --abandon is only for a run that was never started', view(s, o.task));
    }
    if (!claim(path.join(runsDir, `${n}.abandoned`), { reason: o.reason, at: new Date().toISOString() })) {
      throw new Exit(3, `run ${n} was abandoned already`, view(s, o.task));
    }
    notes.push(`run ${n} abandoned: ${o.reason}`);
    s = survey(shared, analysis, sha);
  }
  const pending = s.runs.filter((r) => r.state === 'prepared');
  if (pending.length) throw new Exit(3, PENDING(pending[0].run, cmdOf(pending[0].run)), view(s, o.task));
  const found = {};
  for (const t of o.task) { const v = verdictsFor(s, t); if (v.length) found[t] = v; }
  if (Object.keys(found).length && !o.again) {
    const lines = Object.entries(found).map(([t, v]) => `${t}: ${v.map((x) => `${x.from} ${x.verdict} (${x.significantGaps} significant gaps${x.appended != null ? `, appended ${x.appended}` : ''}${x.savedBy ? `, Saved-by ${x.savedBy}` : ''})`).join('; ')}`);
    throw new Exit(3, `this version is checked already - show the result, run nothing (a new run only with --again <reason>):\n  ${lines.join('\n  ')}`, view(s, o.task));
  }
  // Results for other keys of this version are named for reference only.
  for (const r of s.runs) {
    if (r.state !== 'result') continue;
    for (const e of r._entries) { const other = e.answer.tasks.filter((t) => !o.task.includes(t)); if (other.length) notes.push(`checked for ${other.join(', ')} (run ${r.run}, ${e.answer.verdict}): not a check of ${o.task.join(', ')}`); }
  }
  fs.mkdirSync(runsDir, { recursive: true });
  const copy = path.join(dir, `analysis-${sha}.md`);
  claim(copy, buf.toString('utf8'));
  checkCopy(dir, sha);
  const n = (s.runs.length ? Math.max(...s.runs.map((r) => r.run)) : 0) + 1;
  const task = path.join(dir, `task-${n}.md`);
  const argv = checkerArgv(dir, n, path.resolve(o.worktree), o.model);
  const mark = { tasks: o.task, analysis, at: new Date().toISOString(), argv };
  if (o.again) mark.again = o.again;
  if (!claimRun(runsDir, n, mark)) throw new Exit(3, PENDING(n, cmdOf(n)), view(survey(shared, analysis, sha), o.task));
  fs.writeFileSync(task, taskText({ copy, analysis, sha, brief: o.brief, useCases: o['use-cases'], spec: o.spec, worktree: path.resolve(o.worktree), tasks: o.task }));
  const v = view(survey(shared, analysis, sha), o.task);
  return {
    code: 0,
    out: { run: n, sha, dir, tasks: o.task, argv, command: cmdOf(n),
      next: 'Run the command once: it starts the checker and waits for it. When the shell tool answers "still running", poll that same command. '
        + 'Running it again is refused while the run lives (exit 3) and records the run as died when it is gone. '
        + `Then collect --run ${n} --append unless the snapshot after voids the check.`,
      notes: notes.concat(v.notes), otherVersions: v.otherVersions },
  };
}

function collect(o) {
  if (!o.shared || !o.analysis || (o.exit != null && o.run == null) || (o.append && o.run == null)) throw new Exit(64, USAGE);
  if (o.run != null && !/^\d+$/.test(o.run)) throw new Exit(64, '--run needs a run number');
  if (o.exit != null && !/^-?\d+$/.test(o.exit)) throw new Exit(64, '--exit needs an integer');
  if (o.sha != null && !HEX.test(o.sha)) throw new Exit(64, '--sha needs a sha256 (64 hex digits)');
  const analysis = path.resolve(o.analysis);
  const sha = o.sha || sha256(readAnalysis(analysis));
  if (o.sha && !exists(versionDir(o.shared, sha))) throw new Exit(65, `no check folder ${versionDir(o.shared, sha)}`);
  const dir = versionDir(o.shared, sha);
  const notes = [];
  if (o.run != null) {
    // The exit is recorded before any command of this call reads the run: an answer of a failed codex exec is never
    // recorded in the journal.
    const n = +o.run;
    checkCopy(dir, sha);
    if (!runNumbers(path.join(dir, 'runs')).nums.includes(n)) { const s0 = survey(o.shared, analysis, sha); throw new Exit(3, `no run ${n} in ${s0.dir}`, view(s0, o.task)); }
    if (o.exit != null && exists(runFile(dir, n, 'running'))) {
      throw new Exit(3, `the exit of run ${n} is recorded by analysis-check.js run, which started its checker (runs/${n}.running): collect --run ${n} without --exit`,
        view(survey(o.shared, analysis, sha), o.task));
    }
    if (o.exit != null && !claim(path.join(dir, 'runs', `${n}.exit`), `${+o.exit}\n`)) {
      const was = fs.readFileSync(path.join(dir, 'runs', `${n}.exit`), 'utf8').trim();
      if (was !== String(+o.exit)) throw new Exit(3, `the exit of run ${n} is recorded already as ${was}, not ${+o.exit}`, view(survey(o.shared, analysis, sha), o.task));
    }
  }
  let s = survey(o.shared, analysis, sha);
  if (o.append) {
    const n = +o.run;
    const r = s.runs.find((x) => x.run === n);
    if (r.state !== 'result') throw new Exit(3, `run ${n} is ${r.state}${r.reason ? ': ' + r.reason : ''} - nothing is appended`, view(s, o.task));
    // Every recorded answer without its marker, in the order they were seen. The marker first, then the write: a
    // second --append (or a second session) finds the marker and writes nothing.
    for (const e of r._entries) {
      if (e.k == null) { notes.push(`run ${n}: runs/${n}.json is not recorded yet - not appended; collect --append again`); continue; }
      if (e.mark) { notes.push(`run ${n}: answer ${e.k} is already appended to ${s.report}`); continue; }
      const text = withHeader(e.answer.report, sha);
      const before = exists(s.report) ? fs.readFileSync(s.report, 'utf8') : '';
      const ordinal = reportRuns(before).length + 1;
      if (!claim(path.join(answersDir(s.dir, n), `${e.k}.appended`), Object.assign({ sha256: e.sha256, reportRun: ordinal, textSha256: runTextSha(text) }, summary(e.answer)))) {
        notes.push(`run ${n}: answer ${e.k} is already appended to ${s.report}`);
      } else {
        fs.appendFileSync(s.report, (before && !before.endsWith('\n') ? '\n' : '') + (before ? '\n' : '') + text);
        notes.push(`run ${n}: answer ${e.k} appended to ${s.report} as report run ${ordinal}`);
      }
    }
    s = survey(o.shared, analysis, sha);
  }
  const v = view(s, o.task);
  v.sha = sha;
  v.notes = notes.concat(v.notes);
  return { code: 0, out: v };
}

// ---- run: the only start of the checker ----

// Why the version folder, runs/, runs/<n>.answers or runs/<n>.json is a symbolic link, or null. run writes through
// these paths outside the sandbox (the journal, the -o of the checker), and the sandbox of the coordinator can make them.
function linkProblem(dir, n) {
  const paths = [[dir, 'dir'], [path.join(dir, 'runs'), 'dir'], [answersDir(dir, n), 'dir'], [runFile(dir, n, 'json'), 'file']];
  for (const [p, kind] of paths) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) return `${p} is a symbolic link`;
    if (kind === 'dir' && !st.isDirectory()) return `${p} is not a folder`;
  }
  return null;
}

// The argv of the checker for run n: the template with the worktree and the model of the marker, both checked, and the
// marker's argv equal to it. The marker is written in the sandbox, so its argv is never run as it stands.
function checkedArgv(dir, n) {
  const bad = (what) => new Exit(65, `the marker runs/${n}.prepared does not hold the argv of this plugin: ${what}; `
    + `prepare --abandon ${n} --reason <why>, then prepare`);
  const mark = readJson(runFile(dir, n, 'prepared'));
  const a = mark && mark.argv;
  if (!Array.isArray(a) || !a.every((x) => typeof x === 'string')) throw bad('no argv of strings');
  const at = (flag) => (a.indexOf(flag) > 0 ? a[a.indexOf(flag) + 1] : undefined);
  const w = at('-C'), m = at('-m');
  let isDir = false;
  try { isDir = typeof w === 'string' && fs.statSync(w).isDirectory(); } catch { /* not there */ }
  if (typeof w !== 'string' || !path.isAbsolute(w) || w.startsWith('-') || !isDir) throw bad(`the worktree -C ${JSON.stringify(w)} is not the absolute path of a folder`);
  if (typeof m !== 'string' || !MODEL.test(m)) throw bad(`the model -m ${JSON.stringify(m)} is not [A-Za-z0-9][A-Za-z0-9._-]*`);
  const want = checkerArgv(dir, n, w, m);
  if (JSON.stringify(a) !== JSON.stringify(want)) {
    const i = want.findIndex((x, k) => a[k] !== x);
    throw bad(`it differs from the template at argument ${i < 0 ? want.length : i} (${JSON.stringify(a[i < 0 ? want.length : i])}, the template has ${JSON.stringify(i < 0 ? null : want[i])})`);
  }
  return want;
}

// The refusal of a run with runs/<n>.running: the run lives, is being started, or is gone - then runs/<n>.died is
// recorded first. Called only for a pending run (no answer, no exit), outside the sandbox (ps answered for this process).
function runningRefusal(dir, n, cmd, out, CR) {
  const m = readJson(runFile(dir, n, 'running'));
  if (!m || !Number.isInteger(m.pid) || typeof m.lstart !== 'string') {
    return new Exit(3, `run ${n} is being started (runs/${n}.running cannot be read yet): run ${cmd} again later to see; it never starts a second checker`, out);
  }
  const now = CR.lstartOf(m.pid);
  if (now && CR.normL(now) === CR.normL(m.lstart)) {
    return new Exit(3, `run ${n} is running as pid ${m.pid} since ${m.lstart}: poll the command that started it; when it runs in another turn or session, `
      + `run ${cmd} again later to see - it never starts a second checker`, out);
  }
  claim(runFile(dir, n, 'died'), { pid: m.pid, lstart: m.lstart, at: new Date().toISOString() });
  return new Exit(3, `run ${n} died (pid ${m.pid}, started ${m.lstart}, is gone) with no exit and no answer: runs/${n}.died recorded; `
    + 'prepare again (a new run, no --abandon)', out);
}

// Records the exit of the checker of run n unless one is recorded already (that one is kept); a note when they differ.
function recordExit(dir, n, code) {
  const file = runFile(dir, n, 'exit');
  if (claim(file, `${code}\n`)) return null;
  let was = '?';
  try { was = fs.readFileSync(file, 'utf8').trim(); } catch { /* named as ? */ }
  return was === String(code) ? null : `run ${n}: the exit recorded already is kept: recorded ${was}, codex exec ended with ${code}`;
}

// Starts the checker in the foreground (the process group of run) and waits for it: stdin /dev/null, its output to
// the stderr of run (stdout carries only the JSON of run), INT/TERM/HUP passed to it. Resolves {code, error?}: its
// exit code, 128+signal, or 127 when it cannot be started.
function startChecker(argv, env) {
  return new Promise((resolve) => {
    const fwd = {};
    let ended = false;
    const end = (r) => {
      if (ended) return;
      ended = true;
      for (const [sig, h] of Object.entries(fwd)) process.removeListener(sig, h);
      resolve(r);
    };
    let child;
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 2, 2], env }); } catch (e) { end({ code: 127, error: `${argv[0]} could not be started: ${e.code || e.message}` }); return; }
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { fwd[sig] = () => { try { child.kill(sig); } catch { /* gone */ } }; process.on(sig, fwd[sig]); }
    child.on('error', (e) => end({ code: 127, error: `${argv[0]} could not be started: ${e.code || e.message}` }));
    child.on('exit', (code, signal) => end({ code: code != null ? code : 128 + (os.constants.signals[signal] || 0) }));
  });
}

async function run(o, env) {
  const mine = ['--shared', '--analysis', '--sha', '--run'];
  const other = o.given.find((a) => !mine.includes(a));
  if (other || mine.some((a) => o[a.slice(2)] == null) || new Set(o.given).size !== o.given.length) {
    throw new Exit(64, `usage: ${RUN_USAGE}${other ? ` (run takes no ${other})` : ''}`);
  }
  if (!/^\d+$/.test(o.run)) throw new Exit(64, '--run needs a run number');
  if (!HEX.test(o.sha)) throw new Exit(64, '--sha needs a sha256 (64 hex digits)');
  const shared = path.resolve(o.shared), analysis = path.resolve(o.analysis), sha = o.sha, n = +o.run;
  const cmd = runCommand(shared, analysis, sha, n);
  const CR = require('./chain-run.js');
  const self = CR.lstartOf(process.pid);
  if (!self) {
    throw new Exit(69, `refused - ps does not answer (ps -o lstart= -p ${process.pid} gave no start time)${CR.psCause(env)}: whether a run lives cannot be told, `
      + `so no checker is started; start it as a plain argv, ${cmd}, with no node -e, sh -c, env, node flag, other path to node or relative path, `
      + 'so the execpolicy rule of the coordinator home lets it out of the sandbox');
  }
  const dir = versionDir(shared, sha);
  const link = linkProblem(dir, n);
  if (link) throw new Exit(65, `${link}: run writes there outside the sandbox, so nothing is started`);
  if (!exists(dir)) throw new Exit(65, `no check folder ${dir}`);
  checkCopy(dir, sha);
  if (!runNumbers(path.join(dir, 'runs')).nums.includes(n)) { const s0 = survey(shared, analysis, sha); throw new Exit(3, `no run ${n} in ${dir}`, view(s0, [])); }
  const s = survey(shared, analysis, sha);
  const out = view(s, []);
  const r = s.runs.find((x) => x.run === n);
  if (!r.prepared) throw new Exit(3, `run ${n} was not prepared (no runs/${n}.prepared): nothing is started`, out);
  if (r.state === 'result') throw new Exit(3, `run ${n} has a result (${r.verdict}): nothing is started`, out);
  if (r.state !== 'prepared') throw new Exit(3, `run ${n} is not pending (${r.state}: ${r.reason}): nothing is started`, out);
  if (exists(runFile(dir, n, 'running'))) throw runningRefusal(dir, n, cmd, out, CR);
  const argv = checkedArgv(dir, n);
  if (!claim(runFile(dir, n, 'running'), { pid: process.pid, lstart: self, at: new Date().toISOString() })) throw runningRefusal(dir, n, cmd, out, CR);
  const res = await startChecker(argv, env);
  const late = recordExit(dir, n, res.code);
  const v = view(survey(shared, analysis, sha), []);
  v.sha = sha;
  v.run = n;
  v.exit = res.code;
  v.notes = [res.error, late].filter(Boolean).concat(v.notes);
  v.next = `collect --run ${n} --append unless the snapshot after voids the check (codex exec ended with ${res.code})`;
  return { code: 0, out: v };
}

// The report of a run with `Saved-by: coordinator` under its header and `Analysis-sha256` filled in when missing.
function withHeader(report, sha) {
  const lines = report.replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((l) => /^# Analysis check\s*$/.test(l));
  const h = headerOf(lines.slice(start).join('\n'));
  const at = (name) => (h[name] ? start + h[name].line : -1);
  const out = lines.slice();
  if (!h['Saved-by']) {
    const last = Math.max(...['Analysis', 'Analysis-sha256', 'Tasks', 'Verdict', 'Significant gaps'].map(at), start);
    out.splice(last + 1, 0, 'Saved-by: coordinator');
  }
  if (!h['Analysis-sha256']) out.splice((at('Analysis') >= 0 ? at('Analysis') : start) + 1, 0, `Analysis-sha256: ${sha}`);
  return out.join('\n') + '\n';
}

const refusal = (e) => {
  if (!(e instanceof Exit)) throw e;
  return { code: e.code, out: Object.assign({ refused: e.message }, e.out || {}), message: e.message };
};
// prepare and collect answer at once; run answers with a promise (it waits for the checker).
function main(argv, env) {
  try {
    const o = parse(argv);
    if (o.cmd === 'prepare') return prepare(o);
    if (o.cmd === 'collect') return collect(o);
    if (o.cmd === 'run') return run(o, env || process.env).catch(refusal);
    throw new Exit(64, USAGE);
  } catch (e) {
    return refusal(e);
  }
}

module.exports = { claim, claimRun, reportRuns, runTextSha, taskKeys, invalid, journal, record, recordExit, stateOf, survey, withHeader, main };

if (require.main === module) {
  Promise.resolve(main(process.argv.slice(2))).then((res) => {
    process.stdout.write(JSON.stringify(res.out, null, 2) + '\n');
    if (res.message) process.stderr.write(res.message + '\n');
    else if (res.out && res.out.next) process.stderr.write(res.out.next + '\n');
    process.exitCode = res.code;
  });
}
