#!/usr/bin/env node
'use strict';
// Tester cells of a failed write (p-codex A2a-2b): the real full disk reaches the result line itself, not only the answer
// (a result line longer than the free part of the last block of the journal), a disk full before the request, every kind
// of status with an answer that fails, a queue behind a failed answer, a repeated id with other content
// while the journal cannot take the line. Skipped without macOS, git or hdiutil.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('git') || !has('hdiutil')) {
  skip('tester cells of a failed write', 'needs macOS, git and hdiutil');
  done();
}
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-aft-')));
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
  for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  git(f.repo, ['add', 'a.txt', 'b.txt', 'c.txt']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.h0 = f.tip();
  f.write = (n, body) => fs.writeFileSync(path.join(f.wt, n), body);
  f.journal = () => { try { return fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8'); } catch { return ''; } };
  f.events = (id, ev) => f.journal().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { ev: 'TORN', l }; } }).filter((e) => (!id || e.id === id) && (!ev || e.ev === ev));
  // names long enough that a result line takes more than one block of the disk
  f.many = (n) => {
    const names = [];
    for (let i = 0; i < n; i++) { const name = `long-name-${String(i).padStart(4, '0')}-${'x'.repeat(120)}.txt`; f.write(name, `${i}\n`); names.push(name); }
    return names;
  };
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
function disk(name, size) {
  const m = path.join(BASE, name);
  fs.mkdirSync(m);
  const image = path.join(BASE, `${name}.dmg`);
  const c = spawnSync('hdiutil', ['create', '-quiet', '-size', size || '16m', '-fs', 'HFS+', '-volname', name, image], { encoding: 'utf8' });
  if (c.status !== 0) throw new Error(`hdiutil create: ${c.stderr}`);
  const a = spawnSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', m, image], { encoding: 'utf8' });
  if (a.status !== 0) throw new Error(`hdiutil attach: ${a.stderr}`);
  mounted.add(m);
  const filler = path.join(m, 'filler');
  return {
    state: path.join(m, 'state'),
    fill() {
      const fd = fs.openSync(filler, 'a');
      for (const sz of [1 << 16, 512]) {
        const b = Buffer.alloc(sz);
        try { for (;;) fs.writeSync(fd, b); } catch (e) { if (e.code !== 'ENOSPC') throw e; }
      }
      fs.closeSync(fd);
    },
    free() { fs.rmSync(filler, { force: true }); },
    close() { detach(m); },
  };
}

(async () => {
  // ---- T25: a real ENOSPC on the result line itself
  {
    const v = disk('r1');
    const f = fixture(v.state);
    const s = service(f, { inject: { afterUpdateRef: () => v.fill() } });
    const names = f.many(150);
    const id = ask(s, names);
    await until(() => f.tip() !== f.h0, 30000);
    await sleep(600);
    const moved = f.tip();
    const res = f.events(id, 'result');
    ok('T25 the disk is full for the result line: no result in the journal, no false status, the journal ends on a whole line',
      moved !== f.h0 && res.length === 0 && f.journal().endsWith('\n') && f.events(null, 'TORN').length === 0, J({ moved: moved !== f.h0, res: res.map((e) => e.status), tail: f.journal().slice(-40) }));
    ok('T25 the full disk stands in the notes, by its code', s.notes().some((n) => /ENOSPC/.test(n)), J(s.notes()));
    // the cut of the torn line can free what the answer needs, so an answer may come at once; whenever it comes it says the same
    const early = readJson(path.join(s.answers, `${id}.json`));
    ok('T25 an answer written while the disk is full is no other status', !early || (early.status === 'committed' && early.sha === moved), J(early));
    v.free();
    const a = await answer(s, id);
    ok('T25 space came back: the same call answers committed with the sha of the branch', a && a.status === 'committed' && a.sha === moved && !a.why, J(a));
    f.write('b.txt', 'v1\n');
    const a2 = await answer(s, ask(s, ['b.txt']));
    ok('T25 the next request of the call is refused and names the journal, the branch stays', a2 && a2.status === 'refused' && /journal/.test(a2.why || '') && f.tip() === moved, J(a2));
    const sum = await s.close();
    ok('T25 the summary has the commit once and that one refusal', sum.commits.length === 1 && sum.commits[0].sha === moved && sum.refused.length === 1, J({ c: sum.commits, r: sum.refused }));
    const s2 = service(f);
    const again = await answer(s2, askAs(s2, id, names));
    const rec = f.events(id, 'result');
    ok('T25 the next start settles it: one result, recovered, the same id answers the same sha, no second commit',
      again && again.status === 'committed' && again.sha === moved && f.tip() === moved && rec.length === 1 && rec[0].recovered === true && rec[0].sha === moved, J({ again, rec: rec.map((e) => [e.status, e.recovered]) }));
    const a3 = await answer(s2, ask(s2, ['b.txt']));
    ok('T25 the next call commits', a3 && a3.status === 'committed' && f.tip() === a3.sha && a3.sha !== moved, J(a3));
    await s2.close();
    v.close();
  }
  // ---- T26: the disk is full before the request
  {
    const v = disk('r2');
    const f = fixture(v.state);
    const s = service(f);
    v.fill();
    const names = f.many(150);
    const id = ask(s, names);
    await sleep(1500);
    ok('T26 a disk full before the request: the branch stays, no result that says committed', f.tip() === f.h0 && !f.events(id, 'result').some((e) => e.status === 'committed'), J(f.events(id, 'result')));
    v.free();
    const a = await answer(s, id);
    const res = f.events(id, 'result');
    ok('T26 space came back: one refusal reaches the role, at most one result, the branch stays', a && a.status === 'refused' && a.why && res.length <= 1 && f.tip() === f.h0, J({ a, res: res.map((e) => e.status) }));
    const a2 = await answer(s, ask(s, names));
    ok('T26 a new request of the same paths: the call goes on and commits', a2 && a2.status === 'committed' && a2.sha === f.tip(), J(a2));
    await s.close();
    v.close();
  }
  // ---- T27: a queue behind a failed answer
  {
    const v = disk('r3');
    const f = fixture(v.state);
    let filled = false;
    const s = service(f, { inject: { afterUpdateRef: () => { if (!filled) { filled = true; v.fill(); } } } });
    f.write('a.txt', 'v1\n');
    f.write('b.txt', 'v1\n');
    const id1 = ask(s, ['a.txt']);
    await until(() => f.tip() !== f.h0, 20000);
    const id2 = ask(s, ['b.txt']);
    await sleep(800);
    v.free();
    const a1 = await answer(s, id1);
    const a2 = await answer(s, id2);
    const r1 = f.events(id1, 'result'), r2 = f.events(id2, 'result');
    ok('T27 two requests over a full disk: each has one answer and at most one result, the first committed', a1 && a1.status === 'committed' && a2 && r1.length <= 1 && r2.length <= 1, J({ a1, a2, r1: r1.map((e) => e.status), r2: r2.map((e) => e.status) }));
    if (a2 && a2.status === 'committed') ok('T27 the second committed too: the tip is its sha, over the first', f.tip() === a2.sha && git(f.wt, ['rev-parse', `${a2.sha}^`]).out === a1.sha, J({ a1, a2 }));
    else ok('T27 the second refused: the tip is the first', a2 && f.tip() === a1.sha, J({ a1, a2 }));
    const sum = await s.close();
    ok('T27 the summary agrees with the answers', sum.commits.length === (a2 && a2.status === 'committed' ? 2 : 1) && sum.commits[0].sha === a1.sha, J(sum.commits));
    v.close();
  }
  // ---- T28: every status with an answer that fails, by a folder at its place
  {
    const f = fixture();
    const s = service(f);
    const idN = newId();
    fs.mkdirSync(path.join(s.answers, `${idN}.json`));
    askAs(s, idN, ['a.txt']); // nothing changed in it
    await until(() => f.events(idN, 'result').length > 0);
    await sleep(200);
    ok('T28 nothing, the answer fails: one result nothing', f.events(idN, 'result').map((e) => e.status).join() === 'nothing', J(f.events(idN, 'result')));
    fs.rmSync(path.join(s.answers, `${idN}.json`), { recursive: true });
    const a = await answer(s, idN);
    ok('T28 nothing: the late answer says nothing', a && a.status === 'nothing', J(a));
    const idB = newId();
    fs.mkdirSync(path.join(s.answers, `${idB}.json`));
    fs.writeFileSync(path.join(s.box, `${idB}.json`), 'not json');
    await until(() => f.events(idB, 'result').length > 0);
    await sleep(200);
    fs.rmSync(path.join(s.answers, `${idB}.json`), { recursive: true });
    const b = await answer(s, idB);
    ok('T28 a request that is no JSON: one result, the same why in the late answer', f.events(idB, 'result').length === 1 && b && b.status === 'refused' && b.why === f.events(idB, 'result')[0].why && /not JSON/.test(b.why), J(b));
    const sum = await s.close();
    ok('T28 the summary: no second entry for either', sum.nothing.length === 1 && sum.refused.length === 1 && sum.commits.length === 0, J(sum));
  }
  {
    // a request cancelled by the end of the call, its answer fails, the next call with the same id
    const f = fixture();
    const s = service(f);
    const id = newId();
    fs.mkdirSync(path.join(s.answers, `${id}.json`));
    const closing = s.close();
    askAs(s, id, ['a.txt']);
    const sum = await closing;
    const res = f.events(id, 'result');
    if (res.length) ok('T28 cancelled at the end of the call: one result, one entry of the summary', res.length === 1 && res[0].status === 'cancelled' && sum.cancelled.length === 1, J({ res, sum }));
    else ok('T28 the end of the call read no request: no result and no entry', sum.cancelled.length === 0 && sum.refused.length === 0, J(sum));
  }
  // ---- T30: the same id with other content while the journal cannot take the line of the reuse
  {
    const f = fixture();
    const s = service(f);
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id);
    const sum0 = await s.close();
    const s2 = service(f);
    const realWrite = fs.writeSync;
    fs.writeSync = function writeSync(fd, data, ...rest) {
      if (typeof data === 'string' && data.includes('"ev":"refused-reuse"')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWrite.call(fs, fd, data, ...rest);
    };
    let a2 = null;
    try {
      a2 = await answer(s2, askAs(s2, id, ['b.txt'], 'other'));
    } finally { fs.writeSync = realWrite; }
    ok('T30 the line of a reused id cannot be written: the first result stands, the sha of the first answer', a2 && a2.status === 'committed' && a2.sha === a.sha && f.tip() === a.sha, J(a2));
    ok('T30 the journal stays whole, one result', f.events(id, 'result').length === 1 && f.journal().endsWith('\n') && sum0.commits.length === 1, f.journal().slice(-80));
    f.write('b.txt', 'v1\n');
    const a3 = await answer(s2, ask(s2, ['b.txt']));
    ok('T30 the next request of the call commits: a lost line of a reuse does not stop the journal', a3 && a3.status === 'committed', J(a3));
    await s2.close();
  }
  // ---- T31: a refusal before any intent whose result line failed: a later call takes the id as new, as the note says
  {
    const f = fixture();
    const s = service(f);
    const realWrite = fs.writeSync;
    fs.writeSync = function writeSync(fd, data, ...rest) {
      if (typeof data === 'string' && data.includes('"ev":"result"')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWrite.call(fs, fd, data, ...rest);
    };
    const id = ask(s, ['missing.txt']);
    const a = await answer(s, id);
    fs.writeSync = realWrite;
    ok('T31 the refusal before an intent reaches the role, with a note that the line is not in the journal', a && a.status === 'refused' && s.notes().some((n) => n.includes(id) && /not in the journal/.test(n)), J({ a, notes: s.notes() }));
    await s.close();
    f.write('missing.txt', 'now\n');
    const s2 = service(f);
    const again = await answer(s2, askAs(s2, id, ['missing.txt']));
    ok('T31 the same id in a later call is a new request and commits, as the note promised', again && again.status === 'committed' && again.sha === f.tip(), J(again));
    await s2.close();
  }
  // ---- T32: the start of a call on a full disk: no status invented, the reason named by a throw of the open
  {
    const v = disk('r4');
    const f = fixture(v.state);
    const s = service(f);
    f.write('a.txt', 'v1\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id);
    await s.close();
    v.fill();
    let s2 = null, thrown = null;
    try { s2 = service(f); } catch (e) { thrown = e; }
    if (s2) {
      const again = await answer(s2, askAs(s2, id, ['a.txt']), 3000);
      ok('T32 the open on a full disk went on: the id of the journal is not refused and not committed twice', f.tip() === a.sha && (!again || (again.status === 'committed' && again.sha === a.sha)), J(again));
      await s2.close();
    } else ok('T32 the open on a full disk throws with the code, the branch stays (role-exec: crashed, "the commit channel")', /ENOSPC/.test(String(thrown && (thrown.code || thrown.message))) && f.tip() === a.sha, String(thrown));
    v.free();
    const s3 = service(f);
    const third = await answer(s3, askAs(s3, id, ['a.txt']));
    ok('T32 space came back: a new open answers the same sha, one result, and takes the lock', third && third.status === 'committed' && third.sha === a.sha && f.events(id, 'result').length === 1, J(third));
    await s3.close();
    v.close();
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
