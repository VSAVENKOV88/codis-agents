#!/usr/bin/env node
'use strict';
// The full run step of the conductor across a stop and a restart (p-codex-fullrun-a1, cells F21' and F23): a real
// conductor (scripts/chain-run.js start, the roles answered by the fake claude CLI of tests/fixtures/chain-run/bin) runs
// a task whose project has no guardSubsetCommand; after the programmer it starts the full run as a wait step. The plugin
// is copied into a temporary folder and its guards-all.sh replaced by a stub that keeps the meta and the reuse of the
// real scripts/guards-result.js (so no slot is taken) and whose "guards" wait for a go file. Checked:
// - F23 chain-run.js stop during the full run: the task is stopped, the run of the guards lives on, the journal keeps the
//   step open (effect reuse, no result);
// - F21' a start of the task while that run lives is refused by the reconciliation, naming the step and its process;
// - F21' after the run ends, a start passes, its own full run step finds the green run of the same HEAD ("reused"), so
//   the guards ran once, and the task goes on to the tester and the review.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cond-full-rs-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), REPO = path.join(W, 'repo'), RUNS = path.join(SHARED, 'runs');
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = (c, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = c(); if (v) return v; sleepMs(100); } return c(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const text = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const pids = new Set();
process.on('exit', () => {
  try { fs.writeFileSync(path.join(W, 'go-full'), ''); } catch { /* gone */ }
  for (const p of pids) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
});

fs.mkdirSync(REPO);
git('-C', REPO, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(REPO, 'a.js'), '1\n');
git('-C', REPO, 'add', 'a.js');
git('-C', REPO, 'commit', '-q', '-m', 'base');
const SHA0 = git('-C', REPO, 'rev-parse', 'HEAD').stdout.trim();
const WT = path.join(WTR, 'w-x');
git('-C', REPO, 'worktree', 'add', '-q', '-b', 'b-x', WT, SHA0);

// The plugin copy with the stub of guards-all.sh (the stub is not a slot script: it reads no slots.zsh)
const PLUG = path.join(W, 'plugin');
for (const d of ['scripts', 'workflows', 'agents', 'rules', 'schemas', 'skills', 'hooks', '.claude-plugin']) {
  if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(PLUG, d), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(PLUG, 'package.json'));
const S = path.join(PLUG, 'scripts');
const CALLS = path.join(W, 'calls.log'), GO = path.join(W, 'go-full'), PIDF = path.join(W, 'full-pid');
fs.writeFileSync(path.join(S, 'guards-all.sh'), `#!/bin/zsh
H=\${0:A:h}
WT=$1; [[ $WT == /* ]] || WT=${WTR}/$WT
OUT=${SHARED}/guards-\${WT:t}.txt
CMD='stub full run'
if node $H/guards-result.js reuse "$WT" "$OUT" "$CMD" > /dev/null 2>&1; then
  node $H/guards-result.js reuse "$WT" "$OUT" "$CMD"; print -r -- "reused" >> ${CALLS}; exit 0
fi
print -r -- "ran $$" >> ${CALLS}
node $H/guards-result.js meta-start "$WT" "$OUT" "$CMD"
print -r -- "running" > "$OUT"
print -r -- $$ > ${PIDF}
while [[ ! -f ${GO} ]]; do sleep 0.1; done
print -r -- "ok a.test.js" > "$OUT"
print -r -- "1 of 1 test files passed" >> "$OUT"
node $H/guards-result.js meta-end "$WT" "$OUT" 0
exit 0
`, { mode: 0o755 });
const CRP = path.join(S, 'chain-run.js');

const CFG = path.join(W, 'codis-agents.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: REPO, sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}', testerWritable: ['-run\\.js$'],
  guardRerun: { command: 'true {wt} {name}', newRedPattern: '^FAIL (\\S+) \\(', tallyPattern: '^\\d+ of (\\d+) test files passed' } }));
const OWNER = path.join(W, 'owner.txt');
fs.writeFileSync(OWNER, 'the owner asked for the test task');
const FD = path.join(W, 'fake');
fs.mkdirSync(FD);
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['a.js'], commits: ['c'], head: SHA0, mutations: 'm', fullRun: 'the workflow runs it', questions: [], summary: 's' };
fs.writeFileSync(path.join(FD, 'answers.json'), JSON.stringify({ default: { 'gp:blockingQuestions,ok,problems': PRE, programmer: PROG,
  tester: { verdict: 'green', head: SHA0, summary: '' }, reviewer: { verdict: 'done', docsOnly: false, summary: '' } } }));
const TASKS = path.join(W, 'tasks.json');
fs.writeFileSync(TASKS, JSON.stringify([{ key: 'x', title: 'X', wt: 'w-x', branch: 'b-x', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }]));
const env = Object.assign({}, process.env, { PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_CLI_DIR: FD });
const cr = (args) => spawnSync(process.execPath, [CRP].concat(args), { encoding: 'utf8', env, timeout: 180000 });
const start = () => {
  const p = cr(['start', '--host', 'claude', '--tasks', TASKS, '--owner', OWNER, '--config', CFG]);
  let j = null;
  try { j = JSON.parse(p.stdout); } catch { /* below */ }
  if (j && j.pid) pids.add(j.pid);
  return { p, j };
};
const finished = (j) => { const p = cr(['status', j.runDir, '--config', CFG, '--wait', '150']); try { return JSON.parse(p.stdout); } catch { return null; } };
const resultOf = (s) => (s.j ? ((finished(s.j) || {}).results || [])[0] : null);
const lines = (runDir) => {
  const out = [];
  const walk = (d) => { let ns = []; try { ns = fs.readdirSync(d); } catch { return; } for (const n of ns) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) { if (n !== 'steps' && n !== 'calls') walk(p); } else if (/\.jsonl$/.test(n)) out.push(...text(p).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); } };
  walk(runDir);
  return out;
};

try {
  // ---- run 1: stopped during the full run
  const a = start();
  ok('run 1 started', !!(a.j && a.j.runDir), a.p.stdout + a.p.stderr);
  const fullPid = a.j && +until(() => text(PIDF).trim(), 90000);
  ok('run 1: after the programmer the conductor started the full run (guards-all.sh <worktree>) as a wait step', fullPid > 0 && /^ran /.test(text(CALLS)), text(CALLS) + text(path.join(a.j ? a.j.runDir : W, 'log.txt')).slice(-3000));
  if (fullPid) pids.add(fullPid);
  const s = a.j ? cr(['stop', a.j.runDir]) : null;
  const ra = a.j ? resultOf(a) : null;
  ok('F23 stop during the full run: the task is stopped', !!ra && ra.status === 'stopped', JSON.stringify(ra) + (s ? s.stdout + s.stderr : ''));
  ok('F23 the run of the guards lives on after the stop', !!fullPid && alive(fullPid), String(fullPid));
  const ls = a.j ? lines(a.j.runDir) : [];
  const intent = ls.find((e) => e.type === 'intent' && /:full-1$/.test(e.label || ''));
  ok('F23 the journal keeps the full run step open: an intent with effect reuse, no result', !!intent && intent.effect === 'reuse' && intent.label === 'run:x:full-1'
    && !ls.some((e) => e.type === 'result' && e.stepId === intent.stepId), JSON.stringify(intent));

  // ---- run 2: refused while the run of the guards lives
  const b = start();
  const rb = b.j ? resultOf(b) : null;
  ok('F21\' a start while the full run of the stopped run lives: refused before any role, naming the step and its process',
    !!rb && rb.status === 'stopped' && /full-1/.test(rb.why || '') && /alive/.test(rb.why || ''), JSON.stringify(rb) + b.p.stdout + b.p.stderr);
  ok('F21\' the refused start ran no second guards run', (text(CALLS).match(/^ran /gm) || []).length === 1, text(CALLS));

  // ---- the guards end; run 3 passes and reuses the green run of the same HEAD
  fs.writeFileSync(GO, '');
  until(() => !alive(fullPid), 30000);
  until(() => fs.readdirSync(path.join(a.j.runDir, 'steps', 'x')).some((n) => /^wait-full-1\.rc$/.test(n)) || !alive(fullPid), 10000);
  sleepMs(1500);
  const c = start();
  const rc = c.j ? resultOf(c) : null;
  ok('F21\' after the run ended a start passes, its full run step reuses the green run of the HEAD, and the task is done', !!rc && rc.status === 'done',
    JSON.stringify(rc) + (c.j ? text(path.join(c.j.runDir, 'log.txt')).slice(-3000) : ''));
  ok('F21\' the guards ran once over the three starts: one run, one reuse', (text(CALLS).match(/^ran /gm) || []).length === 1 && /^reused$/m.test(text(CALLS)), text(CALLS));
  ok('F21\' the copy of the reused log lies in the steps folder of the new run', !!c.j && fs.existsSync(path.join(c.j.runDir, 'steps', 'x', 'wait-full-1.guards.txt')));
} catch (e) { ok(`the test threw: ${e && e.stack}`, false); }
done();
