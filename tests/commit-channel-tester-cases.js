'use strict';
// Tester cells of the commit channel (p-codex A2a-1), run by tests/commit-channel.test.js as a child (its own tally and
// exit code); the cells the programmer's guards do not hold:
// - the owner's answer to G2: "a swap of the request file and of its parent folder during the read" - a child process
//   swaps a request (and the box folder, and a named file of the worktree, and its parent folder) between a regular
//   file or folder and a symbolic link to a secret outside, while the service reads; nothing of the secret is ever
//   read, committed or answered, and no request behind a link is committed. "FIFO, sockets, devices and folders are
//   refused without hanging": a request that is a Unix socket.
// - the owner's answer to question 6: the first scan at once (an answer exists when openCommitService returns), one
//   queue in the order of publication (not the order of names), polling alone commits when the subscription never
//   fires (missed events), the default interval of the backup poll is 1000 ms, a subscription that breaks while
//   running ('error') is named in the notes and polling goes on, and the subscription alone is a signal enough.
// - S-1 of the security review: the record of a call (<task dir>/calls.jsonl) swapped for a link by a process the role
//   left running, while the adapter writes; a folder in place of the record; the value of a call whose record is refused.
// Real git repositories in a temporary folder; no model is called. macOS only (O_NOFOLLOW_ANY).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('git')) {
  skip('the commit channel (tester)', 'needs macOS (O_NOFOLLOW_ANY) and git');
  done();
}
const svcMod = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const { openCommitService, readNoFollow } = svcMod;
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-tst-')));
// a short folder for Unix sockets (a socket path is at most 104 bytes on macOS)
const SHORT = fs.realpathSync(fs.mkdtempSync('/tmp/cct-'));
const kids = [];
process.on('exit', () => {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.rmSync(SHORT, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const newId = () => crypto.randomBytes(16).toString('hex');
const SECRET = 'SECRET-' + crypto.randomBytes(8).toString('hex');
const SETUP_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 'setup@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 'setup@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
});
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args),
    { cwd, encoding: 'utf8', env: SETUP_ENV, maxBuffer: 64 << 20 });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const tip = (wt) => git(wt, ['rev-parse', 'refs/heads/task']).out;
// every object of the repository, reachable or not (hash-object -w writes before a commit), decompressed
const allObjects = (wt) => git(wt, ['cat-file', '--batch-all-objects', '--batch']).out;

let fixN = 0;
function fixture() {
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), wt: path.join(d, 'wt'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'),
    home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), control: path.join(d, 'control.txt'), out: path.join(d, 'outside') };
  for (const k of ['repo', 'tdir', 'home', 'xdg', 'out']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  fs.writeFileSync(f.control, SECRET + '\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b\n');
  fs.mkdirSync(path.join(f.repo, 'sub'));
  fs.writeFileSync(path.join(f.repo, 'sub', 'c.txt'), 'c\n');
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg };
  f.controlSha = () => sha256(fs.readFileSync(f.control));
  f.control0 = f.controlSha();
  return f;
}
let callN = 0;
const service = (f, extra) => openCommitService(Object.assign({ task: 'K', callId: `call-${++callN}`, wt: f.wt, branch: 'task',
  box: path.join(f.tdir, `box-${callN}`), stateDir: f.state, git: GIT, userEnv: f.userEnv, log: () => {} }, extra || {}));
function put(box, body) {
  const tmp = path.join(box, `.${body.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, path.join(box, `${body.id}.json`));
  return body.id;
}
const req = (paths, message) => ({ id: newId(), paths, message: message || 'msg' });
const readAnswer = (svc, id) => { try { return JSON.parse(fs.readFileSync(path.join(svc.answers, `${id}.json`), 'utf8')); } catch { return null; } };
async function answer(svc, id, ms) {
  const end = Date.now() + (ms || 5000);
  for (;;) { const a = readAnswer(svc, id); if (a || Date.now() > end) return a; await sleep(20); }
}
const allAnswers = (svc) => fs.readdirSync(svc.answers).map((n) => fs.readFileSync(path.join(svc.answers, n), 'utf8')).join('\n');
// A silent subscription: never fires (every event missed), closes cleanly.
const silentWatch = () => ({ close() {}, on() {} });

// A child that swaps <target> between the regular thing at <real> and a symbolic link to <decoy>, until it is killed.
// kind "file": <real> is a file; kind "dir": <real> is a folder. Every step is one rename or link, so a reader sees
// the regular one, the link or nothing, never a partial state.
function swapper(kind, target, real, decoy) {
  const code = `
const fs = require('fs');
const [kind, target, real, decoy] = process.argv.slice(1);
const hold = target + '.hold', ln = target + '.ln';
for (;;) {
  try {
    if (kind === 'file') {
      fs.copyFileSync(real, hold); fs.renameSync(hold, target);
      try { fs.unlinkSync(ln); } catch {}
      fs.symlinkSync(decoy, ln); fs.renameSync(ln, target);
    } else {
      fs.renameSync(target, hold);
      fs.symlinkSync(decoy, target);
      fs.unlinkSync(target);
      fs.renameSync(hold, target);
    }
  } catch (e) { if (kind === 'dir') { try { fs.lstatSync(target); } catch { try { fs.renameSync(hold, target); } catch {} } } }
}`;
  const c = spawn(process.execPath, ['-e', code, kind, target, real, decoy], { stdio: 'ignore' });
  kids.push(c);
  return c;
}
const stop = async (c) => {
  if (c.exitCode === null && c.signalCode === null) {
    const gone = new Promise((r) => c.once('exit', r));
    c.kill('SIGKILL');
    await gone;
  }
};

(async () => {
  ok('the owner\'s answer 6: the backup poll interval is 1000 ms by default', svcMod.POLL_MS === 1000, String(svcMod.POLL_MS));

  // ---- G2: the request file swapped for a link to a secret while it is read: readNoFollow never returns the secret
  {
    const d = path.join(BASE, 'race-file');
    fs.mkdirSync(d);
    const good = path.join(BASE, 'race-good.json');
    fs.writeFileSync(good, '{"good":true}');
    const secret = path.join(BASE, 'race-secret.txt');
    fs.writeFileSync(secret, SECRET);
    const target = path.join(d, `${newId()}.json`);
    fs.copyFileSync(good, target);
    const c = swapper('file', target, good, secret);
    await sleep(100);
    let reads = 0, regular = 0, refused = 0, leaked = 0;
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      const r = readNoFollow(target, 64 * 1024);
      reads++;
      if (r.bytes) { regular++; if (r.bytes.includes(SECRET)) leaked++; } else refused++;
      if (reads % 500 === 0) await sleep(0);
    }
    await stop(c);
    ok(`G2 the request file swapped for a link during the reads: the secret never read (${reads} reads, ${regular} regular, ${refused} refused)`,
      leaked === 0 && regular > 0 && refused > 0, `leaked ${leaked}`);
  }

  // ---- G2: the parent folder of the request swapped for a link to a decoy folder while it is read
  {
    const p = path.join(BASE, 'race-dir');
    const name = `${newId()}.json`;
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, name), '{"good":true}');
    const decoy = path.join(BASE, 'race-decoy');
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, name), SECRET);
    const c = swapper('dir', p, p, decoy);
    await sleep(100);
    let reads = 0, regular = 0, refused = 0, leaked = 0;
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      const r = readNoFollow(path.join(p, name), 64 * 1024);
      reads++;
      if (r.bytes) { regular++; if (r.bytes.includes(SECRET)) leaked++; } else refused++;
      if (reads % 500 === 0) await sleep(0);
    }
    await stop(c);
    ok(`G2 the parent folder swapped for a link during the reads: the secret never read (${reads} reads, ${regular} regular, ${refused} refused)`,
      leaked === 0 && regular > 0 && refused > 0, `leaked ${leaked}`);
  }

  // ---- G2 end to end: the box swapped for a link to a decoy box with its own valid request, while the service scans
  {
    const f = fixture();
    const s = service(f, { pollMs: 2, watch: silentWatch });
    fs.writeFileSync(path.join(f.wt, 'evil.txt'), 'evil\n');
    const decoy = path.join(f.out, 'decoybox');
    fs.mkdirSync(decoy);
    const evil = req(['evil.txt'], 'from the decoy');
    put(decoy, evil);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'good\n');
    const goodId = put(s.box, req(['a.txt'], 'good'));
    const c = swapper('dir', s.box, s.box, decoy);
    await sleep(2500);
    await stop(c);
    await sleep(50);
    const sum = s.close();
    const log = git(f.wt, ['log', '--format=%s', '--name-only', 'refs/heads/task']).out;
    ok('G2 the box swapped for a link during the scans: the request behind the link is never committed',
      !/evil\.txt/.test(log) && !/from the decoy/.test(log), log);
    const ga = readAnswer(s, goodId);
    ok('G2 the box swapped: the request of the real box is answered (committed once)', ga && ga.status === 'committed'
      && sum.commits.length === 1, JSON.stringify({ ga, commits: sum.commits }));
    ok('G2 the box swapped: the decoy box is unchanged (the adapter wrote nothing there)',
      JSON.stringify(fs.readdirSync(decoy)) === JSON.stringify([`${evil.id}.json`]), JSON.stringify(fs.readdirSync(decoy)));
    ok('G2 the box swapped: the control file outside the worktree is unchanged', f.controlSha() === f.control0);
  }

  // ---- G2 / G3: a named file of the worktree, and its parent folder, swapped for a link to the secret during the reads
  {
    const f = fixture();
    const s = service(f, { pollMs: 5, watch: silentWatch });
    const secretDir = path.join(f.out, 'secretdir');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'c.txt'), SECRET + '\n');
    const goodA = path.join(f.d, 'good-a.txt');
    fs.writeFileSync(goodA, 'good a\n');
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'good a\n');
    fs.writeFileSync(path.join(f.wt, 'sub', 'c.txt'), 'good c\n');
    const c1 = swapper('file', path.join(f.wt, 'a.txt'), goodA, f.control);
    const c2 = swapper('dir', path.join(f.wt, 'sub'), path.join(f.wt, 'sub'), secretDir);
    await sleep(100);
    const results = [];
    // one request costs some 15 git commands (about 1-2 s on a loaded Mac): a few requests, each reading both paths
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const id = put(s.box, req(['a.txt', 'sub/c.txt'], 'race'));
      const a = await answer(s, id, 8000);
      results.push(a ? a.status : 'none');
    }
    await stop(c1); await stop(c2);
    s.close();
    const objs = allObjects(f.wt);
    const tally = results.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
    ok(`G3 a named file and its parent swapped for links during the reads: no object of the repository holds the secret (${JSON.stringify(tally)})`,
      !objs.includes(SECRET) && results.length >= 3 && !tally.none, JSON.stringify(tally));
    ok('G3 the swapped paths: no answer carries the secret', !allAnswers(s).includes(SECRET));
    ok('G3 the swapped paths: the control file outside the worktree is unchanged', f.controlSha() === f.control0);
  }

  // ---- G2: a request that is a Unix socket -> refused without hanging
  {
    const f = fixture();
    const box = path.join(SHORT, 'b');
    const s = service(f, { box, pollMs: 50, watch: silentWatch });
    const id = newId();
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(path.join(box, `${id}.json`), r));
    const t = Date.now();
    const a = await answer(s, id, 4000);
    srv.close();
    s.close();
    ok('G2 a request that is a Unix socket -> refused, without hanging', a && a.status === 'refused' && Date.now() - t < 4000, JSON.stringify(a));
  }

  // ---- answer 6: the first scan at once; one queue in the order of publication, not of names
  {
    const f = fixture();
    const box = path.join(f.tdir, 'box-first');
    fs.mkdirSync(box, { recursive: true });
    // B is published after A, but its id sorts before A's
    let A = req(['a.txt'], 'first published'), B = req(['b.txt'], 'second published');
    while (!(B.id < A.id)) { A = req(['a.txt'], 'first published'); B = req(['b.txt'], 'second published'); }
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'A\n');
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'B\n');
    put(box, A);
    await sleep(30);
    put(box, B);
    const s = service(f, { box, pollMs: 3600 * 1000, watch: silentWatch });
    const a1 = readAnswer(s, A.id), b1 = readAnswer(s, B.id);
    ok('answer 6: the first scan runs at once (both answers exist when the service opens, no event and no poll yet)',
      a1 && a1.status === 'committed' && b1 && b1.status === 'committed', JSON.stringify({ a1, b1 }));
    ok('answer 6: one queue in the order of publication: the request published first is committed first (its id sorts later)',
      a1 && b1 && git(f.wt, ['rev-parse', `${b1.sha}^`]).out === a1.sha, JSON.stringify({ a1, b1 }));
    s.close();
  }

  // ---- answer 6: missed events - polling alone answers; the default interval without pollMs
  {
    const f = fixture();
    const s = service(f, { pollMs: 60, watch: silentWatch });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'poll\n');
    const id = put(s.box, req(['a.txt']));
    const a = await answer(s, id, 3000);
    ok('answer 6: the subscription never fires (missed events) -> the backup poll commits the request', a && a.status === 'committed', JSON.stringify(a));
    s.close();
    const f2 = fixture();
    const s2 = service(f2, { watch: silentWatch });
    fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'default poll\n');
    const t = Date.now();
    const id2 = put(s2.box, req(['a.txt']));
    const a2 = await answer(s2, id2, 8000);
    const ms = Date.now() - t;
    ok(`answer 6: without pollMs the backup poll runs every second (answered after ${ms} ms, no event)`, a2 && a2.status === 'committed' && ms < 6000, JSON.stringify(a2));
    s2.close();
  }

  // ---- answer 6: the subscription is a signal enough (real fs.watch, the poll an hour away)
  {
    const f = fixture();
    const s = service(f, { pollMs: 3600 * 1000 });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'watch\n');
    const id = put(s.box, req(['a.txt']));
    const a = await answer(s, id, 4000);
    ok('answer 6: fs.watch signals a rescan: the request is committed with the poll an hour away', a && a.status === 'committed', JSON.stringify(a));
    s.close();
  }

  // ---- answer 6: the subscription breaks while running -> named in the notes, polling goes on
  {
    const f = fixture();
    const em = new EventEmitter();
    em.close = () => {};
    const s = service(f, { pollMs: 60, watch: () => em });
    let threw = null;
    try { em.emit('error', Object.assign(new Error('watch broke'), { code: 'EIO' })); } catch (e) { threw = e; }
    ok('answer 6: fs.watch breaks while running -> the service survives and says it keeps polling',
      !threw && s.notes().some((n) => /fs\.watch/.test(n) && /fail/.test(n) && /poll/.test(n)), String(threw) + ' ' + JSON.stringify(s.notes()));
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'after break\n');
    const id = put(s.box, req(['a.txt']));
    const a = await answer(s, id, 3000);
    ok('answer 6: after the subscription broke a new request is still committed by polling', a && a.status === 'committed', JSON.stringify(a));
    s.close();
  }

  // ---- S-1 (security review 1): the record of a call, <task dir>/calls.jsonl, sits in a folder the role writes. Cells
  // the programmer's guard does not hold: a process the role left behind swaps the file during the adapter's writes
  // (a regular file one moment, a link to a file outside the next), a folder in place of the file, the
  // value of the call kept when its record is refused, and the record written again once the place is a regular file.
  {
    const { createAgent } = require(path.join(ROOT, 'scripts', 'role-exec.js'));
    const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'), 'utf8'));
    const f = fixture();
    const chome = path.join(f.d, 'chome');
    fs.mkdirSync(chome);
    const SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
    const logs = [];
    const agent = createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: (m) => logs.push(String(m)),
      launch: async () => ({ rc: 0, output: JSON.stringify({ status: 'ready' }), notes: [] }),
      codex: { home: chome, catalog: CATALOG }, env: f.userEnv, tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } } });
    const recFile = path.join(f.tdir, 'calls.jsonl');
    const victim = path.join(f.out, 'victim.rc');
    fs.writeFileSync(victim, 'export A=1\n');
    const victim0 = sha256(fs.readFileSync(victim));
    let n = 0;
    const call = () => agent('prompt', { label: `review:K#${++n}`, schema: SCHEMA, agentType: 'general-purpose' });
    const lines = () => { try { return fs.readFileSync(recFile, 'utf8').split('\n').filter(Boolean).length; } catch { return -1; } };

    // the record goes to a regular file of the folder, one line per call (chain-cost reads it)
    await call(); await call();
    ok('S-1: a regular calls.jsonl gets one line per call', lines() === 2 && JSON.parse(fs.readFileSync(recFile, 'utf8').split('\n')[1]).label === 'review:K#2', String(lines()));

    // a folder in place of the file: the call returns its value, the record is refused with its reason, no hang
    fs.rmSync(recFile, { force: true });
    fs.mkdirSync(recFile);
    logs.length = 0;
    const vd = await Promise.race([call(), sleep(10000).then(() => 'hung')]);
    ok('S-1: a folder in place of calls.jsonl -> the call returns its value and the log names the record',
      vd && vd.status === 'ready' && logs.some((m) => /record of the call/.test(m)), JSON.stringify(vd) + ' ' + logs.join(' | '));
    fs.rmSync(recFile, { recursive: true, force: true });

    // a link in place of the file: the value of the call is still returned; once the role's link is gone the record is
    // written again to a regular file (a refused record leaves no sticky state)
    fs.symlinkSync(victim, recFile);
    const vl = await call();
    ok('S-1: a link in place of calls.jsonl -> the value of the call is still returned, the file outside is unchanged',
      vl && vl.status === 'ready' && sha256(fs.readFileSync(victim)) === victim0, JSON.stringify(vl));
    fs.unlinkSync(recFile);
    await call();
    ok('S-1: after the link is gone the next record goes to a new regular file', fs.lstatSync(recFile).isFile() && lines() === 1, String(lines()));

    // a process the role left running (it outlives codex sandbox) swaps calls.jsonl between a regular file and a link to
    // the file outside, one rename at a time, while the adapter writes many records: nothing is ever written into the
    // file outside. (A hard link is not swapped in: under codex sandbox link() of a file the role may not write is EPERM,
    // and a file it may write it can change itself; the nlink check holds only for a link that stays.)
    for (const kind of ['symlink']) {
      const code = `
const fs = require('fs');
const [kind, target, victim] = process.argv.slice(1);
const reg = target + '.reg', ln = target + '.ln';
for (;;) {
  try {
    fs.writeFileSync(reg, ''); fs.renameSync(reg, target);
    try { fs.unlinkSync(ln); } catch {}
    if (kind === 'symlink') fs.symlinkSync(victim, ln); else fs.linkSync(victim, ln);
    fs.renameSync(ln, target);
  } catch {}
}`;
      const c = spawn(process.execPath, ['-e', code, kind, recFile, victim], { stdio: 'ignore' });
      kids.push(c);
      await sleep(200);
      logs.length = 0;
      const t0 = Date.now();
      let calls = 0;
      while (Date.now() - t0 < 6000 && calls < 400) { await call(); calls++; }
      await stop(c);
      const refused = logs.filter((m) => /record of the call/.test(m)).length;
      ok(`S-1: calls.jsonl swapped for a link to a file outside while ${calls} records are written -> the file outside is unchanged`,
        sha256(fs.readFileSync(victim)) === victim0, `${refused} records refused; victim: ${fs.readFileSync(victim, 'utf8').slice(0, 200)}`);
      ok(`S-1: the swap really raced the writes (some records refused, some written)`, refused > 0 && refused < calls, `${refused} of ${calls}`);
      for (const p of [recFile, recFile + '.reg', recFile + '.ln']) fs.rmSync(p, { force: true });
    }
    ok('S-1: the control file outside the worktree is unchanged', f.controlSha() === f.control0);
  }

  done();
})().catch((e) => { ok('the tester guard ran to the end', false, e && e.stack); done(); });
