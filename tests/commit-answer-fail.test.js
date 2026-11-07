#!/usr/bin/env node
'use strict';
// A failed write of an answer or of the result line of the journal (p-codex A2a-2b, cells LF-10, LF-11): a request has one
// result, a failed write changes no status, and the role gets the answer later. LF-10 fills a small real disk image
// (hdiutil) that holds the state folder; LF-11 fails one write of the journal by wrapping fs in this process, since a disk
// that is full for the journal and not for the steps before it cannot be set up reliably. Skipped without macOS, git or
// hdiutil.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('git') || !has('hdiutil')) {
  skip('a failed write of an answer or a result', 'needs macOS, git and hdiutil');
  done();
}
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const CODEX = has('codex') ? spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim() : null;
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-af-')));
const mounted = new Set();
const detach = (m) => { spawnSync('hdiutil', ['detach', '-force', m], { encoding: 'utf8' }); mounted.delete(m); };
process.on('exit', () => {
  for (const m of [...mounted]) detach(m);
  fs.rmSync(BASE, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};

let fixN = 0;
function fixture(state) {
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: state || path.join(d, 'state'), home: path.join(d, 'home'), wt: path.join(d, 'wt') };
  for (const k of ['repo', 'tdir', 'home']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, '.gitignore'), 'build/\n');
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  git(f.repo, ['add', '.gitignore', 'a.txt', 'b.txt', 'c.txt']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.h0 = f.tip();
  f.write = (n, body) => fs.writeFileSync(path.join(f.wt, n), body);
  f.journal = () => { try { return fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8'); } catch { return ''; } };
  f.events = (id, ev) => f.journal().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { ev: 'TORN', l }; } }).filter((e) => (!id || e.id === id) && (!ev || e.ev === ev));
  return f;
}
let callN = 0;
function service(f, extra) {
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  return openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'), stateDir: f.state,
    git: GIT, network: false, tdir: f.tdir, userEnv: { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.tdir }, pollMs: 50, killGraceMs: 500, log: () => {} }, extra || {}));
}
function askAs(s, id, paths, message) {
  const tmp = path.join(s.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, paths, message: message || 'msg' }));
  fs.renameSync(tmp, path.join(s.box, `${id}.json`));
  return id;
}
const ask = (s, paths, message) => askAs(s, newId(), paths, message);
async function answer(s, id, ms) {
  const end = Date.now() + (ms || 20000);
  for (;;) { const a = readJson(path.join(s.answers, `${id}.json`)); if (a || Date.now() > end) return a; await sleep(20); }
}
async function until(cond, ms) {
  const end = Date.now() + (ms || 20000);
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

// a real disk of 16 MB that holds the state folder; fill() takes all its free blocks, free() gives them back
function disk(name) {
  const m = path.join(BASE, name);
  fs.mkdirSync(m);
  const image = path.join(BASE, `${name}.dmg`);
  const c = spawnSync('hdiutil', ['create', '-quiet', '-size', '16m', '-fs', 'HFS+', '-volname', name, image], { encoding: 'utf8' });
  if (c.status !== 0) throw new Error(`hdiutil create: ${c.stderr}`);
  const a = spawnSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', m, image], { encoding: 'utf8' });
  if (a.status !== 0) throw new Error(`hdiutil attach: ${a.stderr}`);
  mounted.add(m);
  const filler = path.join(m, 'filler');
  return {
    state: path.join(m, 'state'),
    fill() {
      const fd = fs.openSync(filler, 'a');
      for (const size of [1 << 16, 512]) {
        const b = Buffer.alloc(size);
        try { for (;;) fs.writeSync(fd, b); } catch (e) { if (e.code !== 'ENOSPC') throw e; }
      }
      fs.closeSync(fd);
    },
    free() { fs.rmSync(filler, { force: true }); },
    close() { detach(m); },
  };
}

// one failure of a write to the journal, by what the line says; the wrap stays until restored
const real = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, ftruncateSync: fs.ftruncateSync };
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
function failResultLine(mode, ev) {
  if (fs.writeSync !== real.writeSync) return;
  const mark = `"ev":"${ev || 'result'}"`;
  let hit = false;
  fs.writeSync = function writeSync(fd, data, ...rest) {
    if (typeof data !== 'string' || !data.includes(mark)) return real.writeSync.call(fs, fd, data, ...rest);
    hit = true;
    if (mode === 'throw') throw enospc();
    if (mode === 'short' || mode === 'short-no-truncate') return real.writeSync.call(fs, fd, data.slice(0, 20));
    return real.writeSync.call(fs, fd, data, ...rest);
  };
  if (mode === 'fsync') fs.fsyncSync = function fsyncSync(fd) { if (hit) throw enospc(); return real.fsyncSync.call(fs, fd); };
  if (mode === 'short-no-truncate') fs.ftruncateSync = function ftruncateSync() { throw enospc(); };
}
let armed = true; // a wrap is taken once per restore, so the commit of a later request does not wrap again
const armOnce = (mode) => () => { if (armed) { armed = false; failResultLine(mode); } };
const restore = () => { Object.assign(fs, real); };

(async () => {
  // ---- LF-10: a real ENOSPC after the branch moved
  {
    const v = disk('v1');
    const f = fixture(v.state);
    const s = service(f, { inject: { afterUpdateRef: () => v.fill() } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    await until(() => f.events(id, 'result').length > 0);
    await sleep(400);
    const res = f.events(id, 'result');
    const moved = f.tip();
    ok('LF-10 ENOSPC on the answer after the branch moved: one result, committed, with the sha of the branch',
      moved !== f.h0 && res.length === 1 && res[0].status === 'committed' && res[0].sha === moved, J(res.map((e) => [e.status, e.sha, (e.why || '').slice(0, 120)])));
    ok('LF-10 while the disk is full: no answer and no temporary file in the answers, several polls passed', fs.readdirSync(s.answers).length === 0, J(fs.readdirSync(s.answers)));
    v.free();
    const a = await answer(s, id);
    ok('LF-10 space came back: the same call answers committed with the sha', a && a.status === 'committed' && a.sha === moved && !a.why, J(a));
    ok('LF-10 still one result in the journal', f.events(id, 'result').length === 1, J(f.events(id, 'result').map((e) => e.status)));
    const sum = await s.close();
    ok('LF-10 the summary: one commit, no refusal, one note about the answer whatever the number of polls',
      sum.commits.length === 1 && sum.refused.length === 0 && sum.notes.filter((n) => n.includes(id)).length === 1, J({ c: sum.commits.length, r: sum.refused, notes: sum.notes }));
    v.close();
  }
  {
    const v = disk('v2');
    const f = fixture(v.state);
    const s = service(f, { inject: { afterUpdateRef: () => v.fill() } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    await until(() => f.events(id, 'result').length > 0);
    const sum = await s.close();
    const moved = f.tip();
    ok('LF-10 the call ends on the full disk: a commit in the summary, no false refusal', sum.commits.length === 1 && sum.commits[0].sha === moved && sum.refused.length === 0, J(sum));
    v.free();
    const s2 = service(f);
    const a = await answer(s2, askAs(s2, id, ['a.txt']));
    ok('LF-10 a new request with the same id after the space came back: committed with the same sha, no second commit, one result',
      a && a.status === 'committed' && a.sha === moved && f.tip() === moved && f.events(id, 'result').length === 1, J(a));
    await s2.close();
    v.close();
  }
  if (CODEX) {
    // with a hook: the file of the whole lists meets the full disk too
    const v = disk('v3');
    const f = fixture(v.state);
    const hooks = path.join(f.d, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nmkdir -p build; i=0; while [ $i -lt 201 ]; do : > build/w$i.txt; i=$((i+1)); done\nexit 0\n', { mode: 0o755 });
    git(f.repo, ['config', 'core.hooksPath', hooks]);
    const s = service(f, { codex: CODEX, inject: { afterUpdateRef: () => v.fill() } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    await until(() => f.events(id, 'result').length > 0, 60000);
    v.free();
    const a = await answer(s, id);
    const res = f.events(id, 'result');
    ok('LF-10 with a hook and 201 ignored files: committed, the sha, changesFileError with ENOSPC, one result',
      a && a.status === 'committed' && a.sha === f.tip() && /ENOSPC/.test(a.changesFileError || '') && !a.changesFile && a.ignoredChangedCount === 201 && res.length === 1 && res[0].status === 'committed', J({ a: a && { status: a.status, why: a.why, e: a.changesFileError, n: a.ignoredChangedCount }, res: res.map((e) => e.status) }));
    await s.close();
    v.close();
  }
  {
    // a write that fails at the rename, after the temporary file is made
    const f = fixture();
    const s = service(f);
    f.write('a.txt', 'v1\n');
    const id = newId();
    fs.mkdirSync(path.join(s.answers, `${id}.json`));
    askAs(s, id, ['a.txt']);
    await until(() => f.events(id, 'result').length > 0);
    await sleep(300);
    ok('LF-10 a folder at the place of the answer: no temporary file stays', fs.readdirSync(s.answers).join() === `${id}.json`, J(fs.readdirSync(s.answers)));
    fs.rmSync(path.join(s.answers, `${id}.json`), { recursive: true });
    const a = await answer(s, id);
    ok('LF-10 the folder removed: committed with the sha', a && a.status === 'committed' && a.sha === f.tip(), J(a));
    await s.close();
  }
  // ---- LF-11: the write of the result line itself fails
  for (const mode of ['throw', 'short', 'fsync', 'short-no-truncate']) {
    const f = fixture();
    armed = true;
    const s = service(f, { inject: { afterUpdateRef: armOnce(mode) } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id);
    restore();
    const moved = f.tip();
    ok(`LF-11 ${mode}: the result line of a commit cannot be written: the answer still says committed with the sha, no internal error`,
      moved !== f.h0 && a && a.status === 'committed' && a.sha === moved && !a.why, J(a));
    const lines = f.events(id, 'result');
    if (mode !== 'short-no-truncate') {
      ok(`LF-11 ${mode}: no result line stays in the journal, and it ends on a whole line`, lines.length === 0 && f.journal().endsWith('\n'), J({ lines, tail: f.journal().slice(-60) }));
    }
    // the journal lacks a result: a second commit in this call would move the tip past the intent and make it undetermined
    f.write('b.txt', 'v1\n');
    const id2 = ask(s, ['b.txt']);
    const a2 = await answer(s, id2);
    ok(`LF-11 ${mode}: the next request of the call is refused and names the journal, the branch stays`,
      a2 && a2.status === 'refused' && /journal/.test(a2.why || '') && f.tip() === moved && f.events(id2).length === 0, J(a2));
    const sum = await s.close();
    ok(`LF-11 ${mode}: the summary has the commit once`, sum.commits.length === 1 && sum.commits[0].sha === moved && sum.refused.length === 1, J(sum));
    const notes = [];
    const s2 = service(f, { log: (m) => notes.push(m) });
    const again = await answer(s2, askAs(s2, id, ['a.txt']));
    const rec = f.events(id, 'result');
    ok(`LF-11 ${mode}: the next start settles it by intent-commit: one result, committed, recovered, the same id answers the same sha`,
      again && again.status === 'committed' && again.sha === moved && f.tip() === moved && rec.length === 1 && rec[0].status === 'committed' && rec[0].recovered === true, J({ again, rec }));
    ok(`LF-11 ${mode}: nothing undetermined`, f.events(null, 'undetermined').length === 0 && !notes.some((n) => n.includes('undetermined')), J(notes));
    if (mode === 'short-no-truncate') ok(`LF-11 ${mode}: the torn line is cut off and named at the next start`, notes.some((n) => n.includes('torn')) && f.events(null, 'TORN').length === 0, J(notes));
    f.write('c.txt', 'v1\n');
    const a3 = await answer(s2, ask(s2, ['c.txt']));
    ok(`LF-11 ${mode}: the next request of the new call commits`, a3 && a3.status === 'committed' && a3.sha === f.tip() && a3.sha !== moved, J(a3));
    await s2.close();
  }
  {
    // a result of a request without an intent: nothing is left to settle, the next request goes on
    const f = fixture();
    const s = service(f);
    failResultLine('throw');
    const id = ask(s, ['no-such-file.txt']);
    const a = await answer(s, id);
    restore();
    ok('LF-11 a refusal before any intent, its result line cannot be written: the same why in the answer', a && a.status === 'refused' && !/internal error|journal/.test(a.why || ''), J(a));
    f.write('a.txt', 'v1\n');
    const a2 = await answer(s, ask(s, ['a.txt']));
    ok('LF-11 the journal healed: the next request of the same call commits', a2 && a2.status === 'committed' && a2.sha === f.tip(), J(a2));
    await s.close();
  }
  {
    // the recovery at the start of a call cannot write its result
    const f = fixture();
    armed = true;
    const s = service(f, { inject: { afterUpdateRef: armOnce('throw') } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id);
    restore();
    await s.close();
    failResultLine('throw');
    let s2 = null, thrown = null;
    try { s2 = service(f); } catch (e) { thrown = e; }
    ok('LF-11 the recovery cannot write its result: the service still opens', !thrown, String(thrown));
    if (s2) {
      const again = await answer(s2, askAs(s2, id, ['a.txt']));
      ok('LF-11 the recovery cannot write its result: the same id still answers committed with the sha', again && again.status === 'committed' && again.sha === a.sha, J(again));
      f.write('b.txt', 'v1\n');
      const a2 = await answer(s2, ask(s2, ['b.txt']));
      ok('LF-11 the recovery cannot write its result: other requests are refused, the branch stays', a2 && a2.status === 'refused' && /journal/.test(a2.why || '') && f.tip() === a.sha, J(a2));
      await s2.close();
    }
    restore();
    const s3 = service(f);
    const third = await answer(s3, askAs(s3, id, ['a.txt']));
    ok('LF-11 the write works again: the start after that records the result, one line', third && third.sha === a.sha && f.events(id, 'result').length === 1, J(third));
    await s3.close();
  }
  {
    // an intent line torn, its cut failing: the journal must not take another line after it
    const f = fixture();
    const s = service(f);
    failResultLine('short-no-truncate', 'intent');
    f.write('a.txt', 'v1\n');
    const a = await answer(s, ask(s, ['a.txt']));
    restore();
    ok('LF-11 a torn intent line that cannot be cut: refused, the branch stays', a && a.status === 'refused' && f.tip() === f.h0, J(a));
    f.write('b.txt', 'v1\n');
    const a2 = await answer(s, ask(s, ['b.txt']));
    ok('LF-11 a torn line stays: the next request of the call is refused and names the journal, nothing is appended after it', a2 && a2.status === 'refused' && /journal/.test(a2.why || '') && f.tip() === f.h0 && !f.journal().endsWith('\n'), J({ a2, tail: f.journal().slice(-40) }));
    await s.close();
    const notes = [];
    const s2 = service(f, { log: (m) => notes.push(m) });
    const a3 = await answer(s2, ask(s2, ['a.txt']));
    ok('LF-11 the next start cuts the torn line off, names it, and commits', a3 && a3.status === 'committed' && notes.some((n) => n.includes('torn')) && !notes.some((n) => n.includes('damaged')), J({ a3, notes }));
    await s2.close();
  }
  {
    // the tip is neither the intent's sha nor its old value, and the line that says so cannot be written
    const f = fixture();
    armed = true;
    const s = service(f, { inject: { afterUpdateRef: armOnce('throw') } });
    f.write('a.txt', 'v1\n');
    await answer(s, ask(s, ['a.txt']));
    restore();
    await s.close();
    fs.writeFileSync(path.join(f.wt, 'c.txt'), 'outside\n');
    git(f.wt, ['add', 'c.txt']);
    git(f.wt, ['commit', '-q', '-m', 'outside']);
    failResultLine('throw', 'undetermined');
    let s2 = null, thrown = null;
    try { s2 = service(f); } catch (e) { thrown = e; }
    ok('LF-11 the line of an undetermined step cannot be written: the service opens and refuses by that reason', !thrown && s2, String(thrown));
    if (s2) {
      f.write('b.txt', 'v1\n');
      const a = await answer(s2, ask(s2, ['b.txt']));
      ok('LF-11 undetermined without its line: requests are refused, naming it', a && a.status === 'refused' && /undetermined/.test(a.why || ''), J(a));
      await s2.close();
    }
    restore();
    const s3 = service(f);
    await s3.close();
    ok('LF-11 undetermined: the next start writes its line', f.events(null, 'undetermined').length === 1, J(f.events(null, 'undetermined')));
  }
  {
    // a step that throws after the branch moved and before the result
    const f = fixture();
    const s = service(f, { inject: { beforeIndexSync: () => { throw new Error('a step after update-ref'); } } });
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id);
    const res = f.events(id, 'result');
    ok('LF-11 a step throws after the branch moved: committed, one result, the index named as not synced',
      a && a.status === 'committed' && a.sha === f.tip() && a.indexSync === 'failed' && res.length === 1 && res[0].status === 'committed', J({ a, res }));
    await s.close();
  }
  // the tester cells: tests/commit-answer-fail-tester-cases.js, a child with its own tally, so README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'commit-answer-fail-tester-cases.js')], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20 });
    process.stdout.write(tc.stdout || '');
    ok('the tester cells of a failed write (tests/commit-answer-fail-tester-cases.js) pass', tc.status === 0, `exit ${tc.status} ${tc.signal || ''} ${(tc.stderr || '').slice(-500)}`);
  }
  done();
})().catch((e) => { restore(); ok('the test ran to the end', false, e && e.stack); done(); });
