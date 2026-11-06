#!/usr/bin/env node
'use strict';
// The commit channel of the role adapter (p-codex A2a-1): a role asks the adapter to commit named paths, the adapter
// commits them outside the role's sandbox with every hook, filter, fsmonitor and signing off and git under its own
// control. scripts/commit-service.js (the adapter's side), scripts/commit-req.js (the client a role runs), and
// scripts/role-exec.js (cfg.commit, tasks[k].branch). Real git repositories in a temporary folder; no model is called.
// Cells: CH-01..20 (the channel and the life of a request), OC-01..13 (the outside commit), PA-01, -02, -05, -06, -11
// (paths of a request), the owner's answer to G2 (the role folder is an untrusted source: read only, no symlink in any
// component, regular files of a bounded size, answers in the adapter's folder, an id bound to the journal) and to
// question 6 (fs.watch as a signal plus a rescan every second, the first scan at once, temporary files ignored).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SERVICE = path.join(ROOT, 'scripts', 'commit-service.js');
const CLIENT = path.join(ROOT, 'scripts', 'commit-req.js');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');

if (process.platform !== 'darwin' || !has('git')) {
  skip('the commit channel', 'needs macOS (O_NOFOLLOW_ANY) and git');
  done();
}
const GIT = (() => {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d, 'git');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
})();
const GIT_VERSION = (/(\d+\.\d+\.\d+)/.exec(spawnSync(GIT, ['--version'], { encoding: 'utf8' }).stdout) || [])[1];

let svcMod = null, roleExec = null;
try { svcMod = require(SERVICE); } catch (e) { ok('scripts/commit-service.js loads', false, e.message); }
try { roleExec = require(path.join(ROOT, 'scripts', 'role-exec.js')); } catch (e) { ok('scripts/role-exec.js loads', false, e.message); }
ok('scripts/commit-req.js exists', fs.existsSync(CLIENT));
if (!svcMod || !svcMod.openCommitService || !fs.existsSync(CLIENT)) done();
const { openCommitService } = svcMod;

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-ch-')));
const kids = [];
process.on('exit', () => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(BASE, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const newId = () => crypto.randomBytes(16).toString('hex');
const SETUP_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 'setup@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 'setup@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
});
// The test's own git: never a hook, fsmonitor or filter of a hostile fixture.
const git = (cwd, args, extra) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args),
    Object.assign({ cwd, encoding: 'utf8', env: SETUP_ENV }, extra || {}));
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const tip = (wt) => git(wt, ['rev-parse', 'refs/heads/task']).out;
const countCommits = (wt) => +git(wt, ['rev-list', '--count', 'refs/heads/task']).out;

let fixN = 0;
// A repository with a linked worktree on branch "task", the task folder, the adapter's state folder (outside the role's
// roots and tmp), the role's TMPDIR, a home with the user's identity, and a control file outside the worktree.
function fixture(opts) {
  const o = opts || {};
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), wt: path.join(d, 'wt'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'),
    rtmp: path.join(d, 'rtmp'), home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), marks: path.join(d, 'marks.log'),
    control: path.join(d, 'control.txt') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'xdg']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n' + (o.global || ''));
  fs.writeFileSync(f.control, 'control ' + d + '\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(f.repo, 'b.txt'), 'b\n');
  fs.mkdirSync(path.join(f.repo, 'sub'));
  fs.writeFileSync(path.join(f.repo, 'sub', 'c.txt'), 'c\n');
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.gitDir = git(f.wt, ['rev-parse', '--absolute-git-dir']).out;
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg, TMPDIR: f.rtmp };
  f.controlSha = () => sha256(fs.readFileSync(f.control));
  f.control0 = f.controlSha();
  return f;
}
let callN = 0;
function service(f, extra) {
  return openCommitService(Object.assign({ task: 'K', callId: `call-${++callN}`, wt: f.wt, branch: 'task',
    box: path.join(f.tdir, `box-${callN}`), stateDir: f.state, git: GIT, userEnv: f.userEnv, log: () => {} }, extra || {}));
}
// A request written the way the client writes it: a temporary file, then a rename.
function put(box, body, id) {
  const i = id || (body && body.id) || newId();
  const tmp = path.join(box, `.${i}.tmp`);
  fs.writeFileSync(tmp, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  fs.renameSync(tmp, path.join(box, `${i}.json`));
  return i;
}
const req = (paths, message, id) => ({ id: id || newId(), paths, message: message || 'msg' });
const readAnswer = (svc, id) => { try { return JSON.parse(fs.readFileSync(path.join(svc.answers, `${id}.json`), 'utf8')); } catch { return null; } };
async function answer(svc, id, ms) {
  const end = Date.now() + (ms || 5000);
  for (;;) { const a = readAnswer(svc, id); if (a || Date.now() > end) return a; await sleep(25); }
}
const journal = (f) => {
  try { return fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
function client(svc, args, env) {
  return new Promise((resolve) => {
    const e = Object.assign({}, process.env, env === undefined ? { CODIS_COMMIT_BOX: svc.box, CODIS_COMMIT_ANSWERS: svc.answers } : env);
    const c = spawn(process.execPath, [CLIENT].concat(args), { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(c.pid);
    let out = '', err = '';
    c.stdout.on('data', (x) => { out += x; });
    c.stderr.on('data', (x) => { err += x; });
    c.on('close', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* not JSON */ } resolve({ rc, out, err, j }); });
  });
}
const hostileMarks = (f) => (fs.existsSync(f.marks) ? fs.readFileSync(f.marks, 'utf8') : '');
const exe = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); };
const markScript = (f, name) => `#!/bin/sh\necho ${name} >> '${f.marks}'\ncat >/dev/null 2>&1 &\nexit 0\n`;

(async () => {
  ok(`git ${GIT_VERSION} is among the verified versions of the service`, svcMod.VERIFIED_GIT_VERSIONS && svcMod.VERIFIED_GIT_VERSIONS.includes(GIT_VERSION),
    JSON.stringify(svcMod.VERIFIED_GIT_VERSIONS));

  // ---- CH-01, CH-02, CH-19, CH-20 through the real client
  {
    const f = fixture();
    const s = service(f);
    ok('the box is created in the role folder, the answers in the adapter folder', fs.statSync(s.box).isDirectory()
      && s.answers.startsWith(f.state + path.sep) && !s.answers.startsWith(f.tdir) && !s.answers.startsWith(f.wt));
    const t0 = tip(f.wt);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'a red guard\n');
    const r1 = await client(s, ['-m', 'red guard', '--', 'a.txt']);
    const t1 = tip(f.wt);
    ok('CH-01 a request -> committed, a sha of 40 hex = the branch tip, exit 0', r1.rc === 0 && r1.j && r1.j.status === 'committed'
      && /^[0-9a-f]{40}$/.test(r1.j.sha) && r1.j.sha === t1 && t1 !== t0, JSON.stringify(r1));
    ok('CH-01 the commit holds the bytes, the message, the parent and the identity of the user\'s config (G8)',
      git(f.wt, ['show', '-s', '--format=%P|%an <%ae>|%cn <%ce>|%s', t1]).out === `${t0}|Role Owner <owner@example.com>|Role Owner <owner@example.com>|red guard`
      && git(f.wt, ['cat-file', '-p', `${t1}:a.txt`]).out === 'a red guard', git(f.wt, ['show', '-s', '--format=%P|%an <%ae>|%cn <%ce>|%s', t1]).out);
    const j1 = journal(f);
    ok('CH-01 the journal: version 1, numbered events, an intent before the result, the sha in both',
      j1.length >= 3 && j1.every((e, i) => e.v === 1 && e.n === i + 1) && j1.some((e) => e.ev === 'intent' && e.id === r1.j.id)
      && j1.some((e) => e.ev === 'intent-commit' && e.sha === t1 && e.old === t0)
      && j1.findIndex((e) => e.ev === 'intent') < j1.findIndex((e) => e.ev === 'result' && e.status === 'committed' && e.sha === t1), JSON.stringify(j1));
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'b fix\n');
    const r2 = await client(s, ['-m', 'fix', '--', 'b.txt']);
    ok('CH-02 a second request: its parent is the first commit', r2.j && r2.j.status === 'committed'
      && git(f.wt, ['rev-parse', `${r2.j.sha}^`]).out === t1 && tip(f.wt) === r2.j.sha, JSON.stringify(r2.j));
    const r3 = await client(s, ['-m', 'nothing', '--', 'a.txt', 'b.txt']);
    ok('CH-19 unchanged paths -> nothing, no sha, the tip stays, exit 0', r3.rc === 0 && r3.j && r3.j.status === 'nothing' && !r3.j.sha && tip(f.wt) === r2.j.sha, JSON.stringify(r3));
    fs.unlinkSync(path.join(f.wt, 'b.txt'));
    fs.renameSync(path.join(f.wt, 'sub', 'c.txt'), path.join(f.wt, 'sub', 'd.txt'));
    const r4 = await client(s, ['-m', 'delete and rename', '--', 'b.txt', 'sub/c.txt', 'sub/d.txt']);
    const ls = git(f.wt, ['ls-tree', '-r', '--name-only', tip(f.wt)]).out.split('\n');
    ok('CH-20 a deleted tracked file and a rename (both paths) -> the commit deletes b.txt and sub/c.txt and adds sub/d.txt',
      r4.j && r4.j.status === 'committed' && !ls.includes('b.txt') && !ls.includes('sub/c.txt') && ls.includes('sub/d.txt'), JSON.stringify({ r4: r4.j, ls }));
    ok('OC-10 after the commits the real index equals HEAD and git status shows nothing staged',
      git(f.wt, ['diff-index', '--cached', '--quiet', 'HEAD']).rc === 0 && git(f.wt, ['status', '--porcelain']).out === '', git(f.wt, ['status', '--porcelain']).out);
    const fx = fs.openSync(path.join(f.wt, 'x.sh'), 'w'); fs.writeSync(fx, '#!/bin/sh\n'); fs.closeSync(fx); fs.chmodSync(path.join(f.wt, 'x.sh'), 0o755);
    const r5 = await client(s, ['-m', 'exec bit', '--', 'x.sh']);
    ok('a new executable file -> mode 100755', r5.j && r5.j.status === 'committed' && /^100755 /.test(git(f.wt, ['ls-tree', tip(f.wt), 'x.sh']).out), git(f.wt, ['ls-tree', tip(f.wt), 'x.sh']).out);
    const sum = s.close();
    ok('the summary of the call names the commits', sum && Array.isArray(sum.commits) && sum.commits.length === 4
      && sum.commits[0].sha === t1 && sum.commits[0].paths.join() === 'a.txt', JSON.stringify(sum));
    ok('the box keeps every request: the adapter renamed, removed and wrote nothing in the role folder',
      fs.readdirSync(s.box).filter((n) => /\.json$/.test(n)).length === 5 && fs.readdirSync(s.box).every((n) => /^[0-9a-f]{32}\.json$/.test(n)), fs.readdirSync(s.box).join());
    ok('the control file outside the worktree is unchanged', f.controlSha() === f.control0);
  }

  // ---- CH-09 two clients at once; CH-08 a repeated id; temporary files and invalid names
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'b2\n');
    const [x, y] = await Promise.all([client(s, ['-m', 'x', '--', 'a.txt']), client(s, ['-m', 'y', '--', 'b.txt'])]);
    const shas = [x.j && x.j.sha, y.j && y.j.sha];
    const parents = shas.map((h) => h && git(f.wt, ['rev-parse', `${h}^`]).out);
    ok('CH-09 two clients at once -> two commits one after the other (the parent of one is the other)',
      x.j && y.j && x.j.status === 'committed' && y.j.status === 'committed' && (parents[0] === shas[1] || parents[1] === shas[0])
      && countCommits(f.wt) === 3, JSON.stringify({ x: x.j, y: y.j, parents }));
    const n0 = countCommits(f.wt);
    await sleep(2500);
    ok('CH-08 the requests stay in the box and are read again by the rescans: no second commit', countCommits(f.wt) === n0);
    // the same id copied into the box of a new call (a repeat after a crash): the earlier answer, no commit
    s.close();
    const s2 = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'a3\n');
    put(s2.box, fs.readFileSync(path.join(s.box, `${x.j.id}.json`)), x.j.id);
    const a = await answer(s2, x.j.id);
    ok('CH-08 a request id already in the journal, in a new call -> its earlier result, no second commit',
      a && a.status === 'committed' && a.sha === x.j.sha && countCommits(f.wt) === n0, JSON.stringify(a));
    // the same id with other content -> refused, the commit is not repeated
    const id = x.j.id;
    put(s2.box, req(['a.txt'], 'other content', id), id);
    await sleep(1500);
    const evs = journal(f).filter((e) => e.id === id);
    ok('the same id with other content -> refused in the journal, no commit, the earlier answer unchanged',
      countCommits(f.wt) === n0 && evs.some((e) => e.ev === 'refused-reuse') && readAnswer(s2, id).sha === x.j.sha, JSON.stringify(evs));
    // temporary files and other names are ignored: no answer file of their name, no commit
    fs.writeFileSync(path.join(s2.box, `.${newId()}.tmp`), JSON.stringify(req(['a.txt'])));
    const tid = newId();
    fs.writeFileSync(path.join(s2.box, `${tid}.json.tmp`), JSON.stringify(req(['a.txt'], 'm', tid)));
    fs.writeFileSync(path.join(s2.box, 'abc.json'), JSON.stringify(req(['a.txt'], 'm', 'abc')));
    fs.writeFileSync(path.join(s2.box, `${newId().toUpperCase()}.json`), JSON.stringify(req(['a.txt'])));
    await sleep(1500);
    ok('CH-10b temporary files and names off ^[0-9a-f]{32}\\.json$ are not requests: no commit, no answer of their name',
      countCommits(f.wt) === n0 && !fs.existsSync(path.join(s2.answers, 'abc.json')) && !fs.existsSync(path.join(s2.answers, `${tid}.json`))
      && fs.readdirSync(s2.answers).filter((n) => !n.startsWith('.')).length === 1, fs.readdirSync(s2.answers).join());
    s2.close();
  }

  // ---- CH-10, CH-12, PA-01, -02, -05, -06, -11: refusals with a reason, no object, no ref
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'changed\n');
    const n0 = countCommits(f.wt);
    const secret = 'xoxb-SECRET-' + crypto.randomBytes(8).toString('hex');
    const cases = [
      ['CH-10 not JSON', secret + ' not json'],
      ['CH-10 JSON that is not an object', '[1,2]'],
      ['CH-10 no message', (i) => ({ id: i, paths: ['a.txt'] })],
      ['CH-10 empty message', (i) => ({ id: i, paths: ['a.txt'], message: '' })],
      ['CH-10 paths not an array', (i) => ({ id: i, paths: 'a.txt', message: 'm' })],
      ['CH-10 an extra field (author)', (i) => ({ id: i, paths: ['a.txt'], message: 'm', author: 'X <x@y>' })],
      ['CH-12 an answer path in the request', (i) => ({ id: i, paths: ['a.txt'], message: 'm', answer: path.join(f.d, 'out.json') })],
      ['CH-10 the id differs from the file name', () => ({ id: newId(), paths: ['a.txt'], message: 'm' })],
      ['PA-01 an absolute path', (i) => req([path.join(f.wt, 'a.txt')], 'm', i), /absolute path/],
      ['PA-01 ../ outside the worktree', (i) => req(['../control.txt'], 'm', i), /"\.\." component/],
      ['PA-01 a ".." component inside', (i) => req(['sub/../a.txt'], 'm', i), /"\.\." component/],
      ['PA-02 .git in any case (.GIT/config)', (i) => req(['.GIT/config'], 'm', i), /\.git component/],
      ['PA-02 the .git pointer file itself (.Git)', (i) => req(['.Git'], 'm', i), /\.git component/],
      ['PA-02 a .git component deeper (sub/.git/x)', (i) => req(['sub/.git/x'], 'm', i), /\.git component/],
      ['PA-06 a directory', (i) => req(['sub'], 'm', i)],
      ['PA-11 a leading "-"', (i) => req(['-a.txt'], 'm', i), /start with "-"/],
      ['PA-11 a NUL in a path', (i) => req(['a.txt\u0000b'], 'm', i)],
      ['PA-11 a newline in a path', (i) => req(['a\n.txt'], 'm', i)],
      ['PA-11 a duplicate path', (i) => req(['a.txt', 'a.txt'], 'm', i)],
      ['PA-11 a duplicate path by case (APFS)', (i) => req(['a.txt', 'A.txt'], 'm', i), /duplicate/],
      ['PA-11 an empty list', (i) => req([], 'm', i)],
      ['PA-11 an empty path', (i) => req([''], 'm', i)],
      ['a missing path that is not tracked', (i) => req(['nope.txt'], 'm', i)],
    ];
    for (const [name, body, whyRe] of cases) {
      const id = newId();
      put(s.box, typeof body === 'function' ? JSON.stringify(body(id)) : body, id);
      const a = await answer(s, id);
      ok(`${name} -> refused with a reason, no commit`, a && a.status === 'refused' && typeof a.why === 'string' && a.why.length > 0
        && !a.why.includes('xoxb') && countCommits(f.wt) === n0 && (!whyRe || whyRe.test(a.why)), JSON.stringify(a));
    }
    ok('CH-12 no file appeared at the answer path a request named', !fs.existsSync(path.join(f.d, 'out.json')));
    const big = newId();
    put(s.box, JSON.stringify(req(['a.txt'], 'x'.repeat(svcMod.MAX_REQUEST_BYTES + 10), big)), big);
    const ab = await answer(s, big);
    ok('a request above the size limit -> refused', ab && ab.status === 'refused' && /size/.test(ab.why), JSON.stringify(ab));
    // PA-05 a parent component is a symlink out of the worktree: refused, the target is never read into git
    fs.mkdirSync(path.join(f.d, 'outside'));
    fs.writeFileSync(path.join(f.d, 'outside', 'id_rsa'), secret + '\n');
    fs.symlinkSync(path.join(f.d, 'outside'), path.join(f.wt, 'lnk'));
    const pid5 = put(s.box, req(['lnk/id_rsa']));
    const a5 = await answer(s, pid5);
    const blob = git(f.wt, ['hash-object', '--stdin'], { input: secret + '\n' }).out;
    ok('PA-05 a symlink in a parent component -> refused; the bytes of its target never became a git object',
      a5 && a5.status === 'refused' && /symbolic link/.test(a5.why) && git(f.wt, ['cat-file', '-e', blob]).rc !== 0 && countCommits(f.wt) === n0, JSON.stringify(a5));
    fs.symlinkSync(path.join(f.d, 'outside', 'id_rsa'), path.join(f.wt, 'key'));
    const pid4 = put(s.box, req(['key']));
    const a4 = await answer(s, pid4);
    ok('a path that is itself a symlink -> refused in A2a-1 (a link entry is part A2a-2); the target is not read',
      a4 && a4.status === 'refused' && /symbolic link/.test(a4.why) && git(f.wt, ['cat-file', '-e', blob]).rc !== 0, JSON.stringify(a4));
    spawnSync('mkfifo', [path.join(f.wt, 'pipe')]);
    const pf = put(s.box, req(['pipe']));
    const t = Date.now();
    const af = await answer(s, pf);
    ok('a named path that is a FIFO -> refused without hanging', af && af.status === 'refused' && Date.now() - t < 4000, JSON.stringify(af));
    s.close();
    ok('the control file outside the worktree is unchanged (refusals)', f.controlSha() === f.control0);
  }

  // ---- CH-11: the request file and its folder are untrusted: no symlink in any component, regular files only
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'changed\n');
    const n0 = countCommits(f.wt);
    const secret = 'xoxb-' + crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(path.join(f.d, 'secret.json'), JSON.stringify({ id: 'x', paths: ['a.txt'], message: secret }));
    const il = newId();
    fs.symlinkSync(path.join(f.d, 'secret.json'), path.join(s.box, `${il}.json`));
    const al = await answer(s, il);
    ok('CH-11 the request file is a symlink -> refused, the target is not read (nothing of it in the answer)',
      al && al.status === 'refused' && /symbolic link/.test(al.why) && !JSON.stringify(al).includes(secret) && countCommits(f.wt) === n0, JSON.stringify(al));
    const ip = newId();
    spawnSync('mkfifo', [path.join(s.box, `${ip}.json`)]);
    const t = Date.now();
    const ap = await answer(s, ip);
    ok('CH-11 the request file is a FIFO -> refused without hanging', ap && ap.status === 'refused' && /regular file/.test(ap.why) && Date.now() - t < 4000, JSON.stringify(ap));
    const idir = newId();
    fs.mkdirSync(path.join(s.box, `${idir}.json`));
    const ad = await answer(s, idir);
    ok('CH-11 the request is a directory -> refused', ad && ad.status === 'refused', JSON.stringify(ad));
    // the box itself replaced by a symlink to a decoy folder that holds a valid request
    const decoy = path.join(f.d, 'decoy');
    fs.mkdirSync(decoy);
    const idc = newId();
    fs.writeFileSync(path.join(decoy, `${idc}.json`), JSON.stringify(req(['a.txt'], 'from the decoy', idc)));
    const decoySum = () => fs.readdirSync(decoy).map((n) => n + ':' + sha256(fs.readFileSync(path.join(decoy, n)))).join();
    const d0 = decoySum();
    fs.renameSync(s.box, s.box + '.moved');
    fs.symlinkSync(decoy, s.box);
    await sleep(1500);
    const adc = readAnswer(s, idc);
    ok('CH-11 the box replaced by a symlink: no request of the decoy folder is committed, the decoy is unchanged',
      countCommits(f.wt) === n0 && (!adc || adc.status === 'refused') && decoySum() === d0, JSON.stringify(adc));
    // a parent folder of the box replaced by a symlink (the call folder moved, a link in its place)
    fs.unlinkSync(s.box);
    fs.renameSync(s.box + '.moved', s.box);
    const parent = path.dirname(s.box);
    const box2 = path.join(f.d, 'tdir-real');
    fs.renameSync(parent, box2);
    fs.symlinkSync(box2, parent);
    const ipar = newId();
    put(path.join(box2, path.basename(s.box)), req(['a.txt'], 'via a linked parent', ipar), ipar);
    await sleep(1500);
    const apar = readAnswer(s, ipar);
    ok('CH-11 a parent folder of the box replaced by a symlink: the request behind it is not committed',
      countCommits(f.wt) === n0 && (!apar || apar.status === 'refused'), JSON.stringify(apar));
    const sum = s.close();
    ok('CH-11 the summary of the call names the refusals', sum.refused.length >= 3, JSON.stringify(sum.refused));
    ok('the control file outside the worktree is unchanged (CH-11)', f.controlSha() === f.control0);
  }

  // ---- CH-17, CH-18, OC-08, OC-11, DP-04: preconditions of a request
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'moved?\n');
    // the branch moved outside the adapter before the request
    fs.writeFileSync(path.join(f.repo, 'z.txt'), 'z\n');
    git(f.wt, ['commit', '-q', '--allow-empty', '-m', 'outside']);
    const t1 = tip(f.wt);
    const r = await client(s, ['-m', 'm', '--', 'a.txt']);
    ok('CH-17 the branch moved outside the adapter -> refused "branch moved" before any intent, the tip stays', r.j && r.j.status === 'refused'
      && /branch moved/.test(r.j.why) && tip(f.wt) === t1 && r.rc === 1 && !journal(f).some((e) => e.ev === 'intent' && e.id === r.j.id), JSON.stringify(r.j));
    s.close();
    const s2 = service(f);
    fs.writeFileSync(path.join(f.gitDir, 'index.lock'), '');
    const r2 = await client(s2, ['-m', 'm', '--', 'a.txt']);
    ok('CH-18 index.lock in the git dir of the worktree -> refused naming index.lock, no commit', r2.j && r2.j.status === 'refused'
      && /index\.lock/.test(r2.j.why) && tip(f.wt) === t1, JSON.stringify(r2.j));
    fs.unlinkSync(path.join(f.gitDir, 'index.lock'));
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'staged by hand\n');
    git(f.wt, ['add', 'b.txt']);
    const r3 = await client(s2, ['-m', 'm', '--', 'a.txt']);
    ok('DP-04 the real index differs from HEAD (staged outside the adapter) -> refused', r3.j && r3.j.status === 'refused'
      && /index/.test(r3.j.why) && tip(f.wt) === t1, JSON.stringify(r3.j));
    git(f.wt, ['reset', '-q']);
    // OC-08: the gitdir pointer of the worktree changed
    const dotgit = path.join(f.wt, '.git');
    const ptr = fs.readFileSync(dotgit, 'utf8');
    const other = fixture();
    fs.writeFileSync(dotgit, `gitdir: ${other.gitDir}\n`);
    const r4 = await client(s2, ['-m', 'm', '--', 'a.txt']);
    ok('OC-08 the .git pointer of the worktree now names another git dir -> refused, neither branch moved',
      r4.j && r4.j.status === 'refused' && /git dir/.test(r4.j.why) && tip(f.repo) === t1 && tip(other.wt) === git(other.repo, ['rev-parse', 'task']).out
      && countCommits(other.wt) === 1, JSON.stringify(r4.j));
    fs.writeFileSync(dotgit, ptr);
    s2.close();
    // OC-11: HEAD detached / on another branch
    git(f.wt, ['checkout', '-q', '--detach']);
    const s3 = service(f);
    const r5 = await client(s3, ['-m', 'm', '--', 'a.txt']);
    ok('OC-11 HEAD of the worktree detached -> refused', r5.j && r5.j.status === 'refused' && /HEAD/.test(r5.j.why) && tip(f.wt) === t1, JSON.stringify(r5.j));
    s3.close();
    git(f.wt, ['checkout', '-q', '-b', 'other']);
    const s4 = service(f);
    const r6 = await client(s4, ['-m', 'm', '--', 'a.txt']);
    ok('OC-11 HEAD of the worktree on another branch -> refused', r6.j && r6.j.status === 'refused' && /HEAD/.test(r6.j.why)
      && git(f.wt, ['rev-parse', 'other']).out === t1, JSON.stringify(r6.j));
    s4.close();
  }

  // ---- CH-17 with a fault injected between commit-tree and update-ref; OC-09 the checked snapshot is what is committed
  {
    const f = fixture();
    let moved = null;
    const s = service(f, { inject: { beforeUpdateRef: () => {
      git(f.wt, ['commit', '-q', '--allow-empty', '-m', 'raced']);
      moved = tip(f.wt);
    } } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'race\n');
    const r = await client(s, ['-m', 'm', '--', 'a.txt']);
    ok('CH-17 the branch moves between commit-tree and update-ref -> refused, the tip is the outside commit',
      r.j && r.j.status === 'refused' && moved && tip(f.wt) === moved && /branch moved/.test(r.j.why), JSON.stringify(r.j));
    ok('CH-17 the journal ends the request refused (no undetermined)', journal(f).some((e) => e.ev === 'result' && e.id === r.j.id && e.status === 'refused'));
    s.close();
    const f2 = fixture();
    const s2 = service(f2, { inject: { afterSnapshot: () => fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'edited after the snapshot\n') } });
    fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'snapshot\n');
    const r2 = await client(s2, ['-m', 'm', '--', 'a.txt']);
    ok('OC-09 the file changes after the snapshot -> the commit holds the snapshot bytes; the real index too, the worktree keeps the edit',
      r2.j && r2.j.status === 'committed' && git(f2.wt, ['cat-file', '-p', `${r2.j.sha}:a.txt`]).out === 'snapshot'
      && git(f2.wt, ['diff-index', '--cached', '--quiet', 'HEAD']).rc === 0 && git(f2.wt, ['status', '--porcelain']).out === 'M a.txt', JSON.stringify({ r: r2.j, st: git(f2.wt, ['status', '--porcelain']).out }));
    s2.close();
    // OC-10: the sync of the real index fails -> committed + indexSync failed; the next request is refused
    const f3 = fixture();
    const s3 = service(f3, { inject: { beforeIndexSync: () => fs.writeFileSync(path.join(f3.gitDir, 'index.lock'), '') } });
    fs.writeFileSync(path.join(f3.wt, 'a.txt'), 'sync\n');
    const r3 = await client(s3, ['-m', 'm', '--', 'a.txt']);
    ok('OC-10 the index sync fails -> committed with indexSync failed', r3.j && r3.j.status === 'committed' && r3.j.indexSync === 'failed', JSON.stringify(r3.j));
    fs.unlinkSync(path.join(f3.gitDir, 'index.lock'));
    fs.writeFileSync(path.join(f3.wt, 'b.txt'), 'next\n');
    const r4 = await client(s3, ['-m', 'm', '--', 'b.txt']);
    ok('OC-10 after a failed sync the next request is refused until the index equals HEAD', r4.j && r4.j.status === 'refused' && /index/.test(r4.j.why), JSON.stringify(r4.j));
    s3.close();
  }

  // ---- OC-01..05: a hostile repository config; nothing of it runs
  {
    const f = fixture();
    const H = path.join(f.wt, 'hostile');
    for (const h of ['reference-transaction', 'post-index-change', 'post-commit', 'post-rewrite', 'pre-auto-gc', 'post-checkout', 'post-merge']) exe(path.join(H, 'hooks', h), markScript(f, h));
    exe(path.join(H, 'fsmon'), markScript(f, 'fsmonitor'));
    exe(path.join(H, 'clean'), `#!/bin/sh\necho filter >> '${f.marks}'\necho FILTERED\n`);
    exe(path.join(H, 'gpg'), markScript(f, 'gpg'));
    exe(path.join(H, 'ssh'), markScript(f, 'ssh'));
    fs.mkdirSync(path.join(H, 'inc-hooks'));
    exe(path.join(H, 'inc-hooks', 'reference-transaction'), markScript(f, 'include-reference-transaction'));
    fs.writeFileSync(path.join(H, 'inc.cfg'), `[core]\n\thooksPath = ${path.join(H, 'inc-hooks')}\n\tfsmonitor = ${path.join(H, 'fsmon')}\n`);
    fs.writeFileSync(path.join(f.wt, '.gitattributes'), '* filter=x\n');
    // attributes git reads without a worktree: info/attributes of the common git dir and core.attributesFile
    fs.writeFileSync(path.join(f.repo, '.git', 'info', 'attributes'), '* filter=x\n');
    fs.writeFileSync(path.join(H, 'attrs'), '* filter=x\n');
    const cfg = (k, v) => git(f.repo, ['config', k, v]);
    cfg('core.attributesFile', path.join(H, 'attrs'));
    cfg('core.hooksPath', path.join(H, 'hooks'));
    cfg('core.fsmonitor', path.join(H, 'fsmon'));
    cfg('filter.x.clean', path.join(H, 'clean'));
    cfg('filter.x.required', 'true');
    cfg('commit.gpgSign', 'true');
    cfg('gpg.program', path.join(H, 'gpg'));
    cfg('core.sshCommand', path.join(H, 'ssh'));
    cfg('gc.auto', '1');
    git(f.repo, ['config', '--add', 'include.path', path.join(H, 'inc.cfg')]);
    // the wrapper records the argv and the environment of every git command of the service
    const wlog = path.join(f.d, 'gitw.log');
    const wrapper = path.join(f.d, 'gitw');
    exe(wrapper, `#!/bin/sh\n{ printf 'ARGV'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; env | sed 's/^/ENV /'; } >> '${wlog}'\nexec '${GIT}' "$@"\n`);
    // OC-07: the parent's environment carries git variables; GIT_TRACE is a source that -c does not override
    const trace = path.join(f.d, 'trace.txt');
    Object.assign(f.userEnv, { GIT_TRACE: trace, GIT_DIR: f.repo + '/.git', GIT_INDEX_FILE: path.join(f.d, 'other-index'),
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${path.join(H, 'fsmon')}'`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: path.join(H, 'ssh'), GIT_EXEC_PATH: path.join(H, 'exec'), GIT_EXTERNAL_DIFF: path.join(H, 'ssh') });
    const s = service(f, { git: wrapper });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'raw bytes\n');
    const r = await client(s, ['-m', 'hostile', '--', 'a.txt']);
    ok('OC-01..05 a hostile config: the commit goes through', r.j && r.j.status === 'committed', JSON.stringify(r.j));
    ok('OC-01 no hook ran (reference-transaction, post-index-change, post-commit and the others)', !/hook|reference|index-change|post-/.test(hostileMarks(f)), hostileMarks(f));
    ok('OC-02 the fsmonitor did not run', !/fsmonitor/.test(hostileMarks(f)), hostileMarks(f));
    ok('OC-03 the clean filter did not run; the blob holds the bytes of the file', !/filter/.test(hostileMarks(f))
      && r.j && git(f.wt, ['cat-file', '-p', `${r.j.sha}:a.txt`]).out === 'raw bytes', hostileMarks(f));
    ok('OC-04 the signing program did not run; the commit has no signature', !/gpg/.test(hostileMarks(f))
      && r.j && !/gpgsig/.test(git(f.wt, ['cat-file', '-p', r.j.sha]).out), hostileMarks(f));
    ok('OC-05 the include.path of the repo set nothing that ran', !/include/.test(hostileMarks(f)), hostileMarks(f));
    ok('OC-01..05 nothing of the hostile config ran at all (marks empty)', hostileMarks(f) === '', hostileMarks(f));
    const wl = fs.existsSync(wlog) ? fs.readFileSync(wlog, 'utf8') : '';
    // one record per git command: its ARGV line and the ENV lines after it; "git config" reads the user's config to
    // find hooks and the identity (it runs nothing), "git --version" checks the binary - every other one is the commit
    const cmds = [];
    for (const l of wl.split('\n')) { if (l.startsWith('ARGV')) cmds.push({ argv: l, env: [] }); else if (l.startsWith('ENV ') && cmds.length) cmds[cmds.length - 1].env.push(l); }
    const ofCommit = cmds.filter((c) => !/\[--version\]/.test(c.argv) && !/\[config\]/.test(c.argv));
    const argvs = ofCommit.map((c) => c.argv);
    const commitTree = argvs.find((l) => / \[commit-tree\]/.test(l)) || '';
    ok('OC-04 commit-tree runs with --no-gpg-sign and -c commit.gpgSign=false', /\[--no-gpg-sign\]/.test(commitTree) && /\[commit\.gpgSign=false\]/.test(commitTree), commitTree);
    ok('OC-01 every git command of the service carries -c core.hooksPath=<an empty folder of the adapter> and core.fsmonitor=false',
      argvs.length > 8 && argvs.every((l) => /\[core\.hooksPath=[^\]]+\]/.test(l) && /\[core\.fsmonitor=false\]/.test(l)),
      argvs.filter((l) => !/\[core\.hooksPath=/.test(l) || !/\[core\.fsmonitor=false\]/.test(l)).join('\n'));
    ok('the reads of the user\'s config are "git config" with core.fsmonitor=false', cmds.filter((c) => /\[config\]/.test(c.argv)).every((c) => /\[core\.fsmonitor=false\]/.test(c.argv)));
    const hp = /\[core\.hooksPath=([^\]]+)\]/.exec(commitTree);
    ok('OC-01 the hooks folder of the adapter is empty and outside the worktree, the task folder and tmp of the role',
      hp && fs.readdirSync(hp[1]).length === 0 && hp[1].startsWith(f.state), hp && hp[1]);
    ok('OC-07 GIT_TRACE of the parent did not reach git (no trace file)', !fs.existsSync(trace));
    const envOfCommit = [].concat(...ofCommit.map((c) => c.env));
    ok('OC-07 no inherited GIT_* variable reaches the git of the commit (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT, GIT_EXEC_PATH, GIT_EXTERNAL_DIFF, GIT_TRACE)',
      !envOfCommit.some((l) => /^ENV (GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_0|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_TRACE)=/.test(l))
      && ofCommit.every((c) => ['ENV GIT_CONFIG_NOSYSTEM=1', 'ENV GIT_CONFIG_GLOBAL=/dev/null', 'ENV GIT_NO_LAZY_FETCH=1'].every((x) => c.env.includes(x))), envOfCommit.filter((l) => /GIT_/.test(l)).slice(0, 20).join('\n'));
    ok('OC-07 the GIT_DIR and GIT_INDEX_FILE of the parent were not used: the real repo moved only refs/heads/task',
      tip(f.wt) === r.j.sha && !fs.existsSync(path.join(f.d, 'other-index')));
    s.close();
    ok('the control file outside the worktree is unchanged (hostile config)', f.controlSha() === f.control0);
  }

  // ---- OC-06: the user's global config with helpers is not read by the commit; the identity comes from it (G8)
  {
    const f = fixture({ global: '' });
    const H = path.join(f.d, 'ghost');
    exe(path.join(H, 'fsmon'), markScript(f, 'global-fsmonitor'));
    exe(path.join(H, 'hooks', 'reference-transaction'), markScript(f, 'global-reference-transaction'));
    fs.appendFileSync(path.join(f.home, '.gitconfig'), `[core]\n\tfsmonitor = ${path.join(H, 'fsmon')}\n[include]\n\tpath = ${path.join(H, 'inc')}\n`);
    fs.writeFileSync(path.join(H, 'inc'), `[core]\n\thooksPath = ${path.join(H, 'hooks')}\n`);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'global\n');
    const r = await client(s, ['-m', 'global', '--', 'a.txt']);
    ok('OC-06 the user\'s global fsmonitor and hooks (non-check hooks) did not run; the author is the user\'s',
      r.j && r.j.status === 'committed' && hostileMarks(f) === '' && git(f.wt, ['show', '-s', '--format=%an <%ae>', r.j.sha]).out === 'Role Owner <owner@example.com>',
      JSON.stringify({ r: r.j, marks: hostileMarks(f) }));
    s.close();
    const f2 = fixture();
    fs.writeFileSync(path.join(f2.home, '.gitconfig'), '');
    const s2 = service(f2);
    fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'no identity\n');
    const r2 = await client(s2, ['-m', 'm', '--', 'a.txt']);
    ok('G8 no user.name/user.email in the user\'s config -> refused "no identity"', r2.j && r2.j.status === 'refused' && /identity/.test(r2.j.why), JSON.stringify(r2.j));
    s2.close();
    const s3 = service(f2, { author: { name: 'codis-agents', email: 'noreply@example.com' } });
    const r3 = await client(s3, ['-m', 'm', '--', 'a.txt']);
    ok('G8 commit.author of the config names the identity', r3.j && r3.j.status === 'committed'
      && git(f2.wt, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', r3.j.sha]).out === 'codis-agents <noreply@example.com>|codis-agents <noreply@example.com>', JSON.stringify(r3.j));
    s3.close();
  }

  // ---- OC-12: hooks of a check in the repository -> refused "no safe check path" (checks inside the sandbox: A2a-2)
  {
    const variants = [
      ['OC-12 a pre-commit in the default hooks folder', (f) => exe(path.join(f.repo, '.git', 'hooks', 'pre-commit'), markScript(f, 'pre-commit'))],
      ['OC-12 a commit-msg in the default hooks folder', (f) => exe(path.join(f.repo, '.git', 'hooks', 'commit-msg'), markScript(f, 'commit-msg'))],
      ['OC-12 a prepare-commit-msg in a local core.hooksPath', (f) => { exe(path.join(f.d, 'hk', 'prepare-commit-msg'), markScript(f, 'pcm')); git(f.repo, ['config', 'core.hooksPath', path.join(f.d, 'hk')]); }],
      ['OC-12a a relative core.hooksPath (from the worktree root)', (f) => { exe(path.join(f.wt, '.githooks', 'pre-commit'), markScript(f, 'rel')); git(f.repo, ['config', 'core.hooksPath', '.githooks']); }],
      ['OC-12b a core.hooksPath in the user\'s global config', (f) => { exe(path.join(f.d, 'gh', 'pre-commit'), markScript(f, 'g')); fs.appendFileSync(path.join(f.home, '.gitconfig'), `[core]\n\thooksPath = ${path.join(f.d, 'gh')}\n`); }],
      ['OC-12c a core.hooksPath in config.worktree', (f) => {
        exe(path.join(f.d, 'wh', 'pre-commit'), markScript(f, 'w'));
        git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
        git(f.wt, ['config', '--worktree', 'core.hooksPath', path.join(f.d, 'wh')]);
      }],
      ['OC-12d a core.hooksPath through include.path', (f) => {
        exe(path.join(f.d, 'ih', 'commit-msg'), markScript(f, 'i'));
        fs.writeFileSync(path.join(f.d, 'inc.cfg'), `[core]\n\thooksPath = ${path.join(f.d, 'ih')}\n`);
        git(f.repo, ['config', 'include.path', path.join(f.d, 'inc.cfg')]);
      }],
      ['OC-12f a hook named in the config (hook.<name>.command)', (f) => git(f.repo, ['config', 'hook.lint.command', path.join(f.d, 'x')])],
    ];
    for (const [name, setup] of variants) {
      const f = fixture();
      setup(f);
      const s = service(f);
      fs.writeFileSync(path.join(f.wt, 'a.txt'), 'hooked\n');
      const t0 = tip(f.wt);
      const r = await client(s, ['-m', 'm', '--', 'a.txt']);
      ok(`${name} -> refused "no safe check path", no commit, no hook ran`, r.j && r.j.status === 'refused' && /no safe check path/.test(r.j.why)
        && tip(f.wt) === t0 && hostileMarks(f) === '', JSON.stringify(r.j));
      s.close();
    }
    const f = fixture();
    fs.writeFileSync(path.join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(f.repo, '.git', 'hooks', 'pre-commit'), 0o644);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'not executable hook\n');
    const r = await client(s, ['-m', 'm', '--', 'a.txt']);
    ok('OC-12e a hook file that is not executable (git skips it) -> committed', r.j && r.j.status === 'committed', JSON.stringify(r.j));
    s.close();
  }

  // ---- OC-13 (G1): a partial clone whose promisor remote is an ext:: command; a missing object is never fetched
  {
    const f = fixture();
    const H = path.join(f.d, 'ext.sh');
    exe(H, markScript(f, 'ext-transport'));
    // a blob of HEAD that the request does not name is missing: write-tree of the private index needs it
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'b big\n');
    git(f.wt, ['commit', '-q', '-am', 'b big']);
    const bBlob = git(f.wt, ['rev-parse', 'HEAD:b.txt']).out;
    fs.unlinkSync(path.join(f.repo, '.git', 'objects', bBlob.slice(0, 2), bBlob.slice(2)));
    git(f.repo, ['config', 'core.repositoryformatversion', '1']);
    git(f.repo, ['config', 'extensions.partialClone', 'evil']);
    git(f.repo, ['config', 'remote.evil.url', `ext::${H} %S`]);
    git(f.repo, ['config', 'remote.evil.promisor', 'true']);
    git(f.repo, ['config', 'protocol.ext.allow', 'always']);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'partial\n');
    const r = await client(s, ['-m', 'm', '--', 'a.txt']);
    ok('OC-13 a promisor remote with ext:: and a missing object: the transport never ran, the request is refused with the text of git', hostileMarks(f) === '' && r.j && r.j.status === 'refused',
      JSON.stringify({ r: r.j, marks: hostileMarks(f) }));
    s.close();
  }

  // ---- CH-15 the end of a call: queued requests -> cancelled; CH-14 pending and wait
  {
    const f = fixture();
    const s = service(f, { pollMs: 60 * 60 * 1000, watch: () => { throw Object.assign(new Error('no watch here'), { code: 'ENOSYS' }); } });
    ok('the owner\'s answer 6: fs.watch unavailable -> the service says so in its notes and keeps polling', s.notes().some((n) => /fs\.watch/.test(n) && /poll/.test(n)), JSON.stringify(s.notes()));
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'queued\n');
    const q1 = put(s.box, req(['a.txt'], 'q1'));
    const q2 = put(s.box, req(['a.txt'], 'q2'));
    const t0 = tip(f.wt);
    const sum = s.close();
    ok('CH-15 requests still queued at the end of the call -> cancelled, no commit, the summary and the journal name them',
      tip(f.wt) === t0 && readAnswer(s, q1).status === 'cancelled' && readAnswer(s, q2).status === 'cancelled'
      && sum.cancelled.includes(q1) && sum.cancelled.includes(q2)
      && journal(f).filter((e) => e.ev === 'result' && e.status === 'cancelled').length === 2, JSON.stringify(sum));
    const f2 = fixture();
    const s2 = service(f2, { inject: { beforeUpdateRef: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); } } });
    fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'slow\n');
    const p = client(s2, ['--max', '1', '-m', 'slow', '--', 'a.txt']);
    const r = await p;
    ok('CH-14 the answer later than --max -> the client prints pending with the id, exit 3', r.rc === 3 && r.j && r.j.status === 'pending' && /^[0-9a-f]{32}$/.test(r.j.id), JSON.stringify(r));
    const w = await client(s2, ['wait', '--id', r.j.id, '--max', '20']);
    ok('CH-14 wait --id then gets the answer', w.rc === 0 && w.j && w.j.status === 'committed' && w.j.sha === tip(f2.wt), JSON.stringify(w));
    const m = await client(s2, ['wait', '--id', r.j.id, '--max', '300']);
    ok('CH-14 --max above 270 is refused (270 s is the ceiling of one wait)', m.rc === 2, JSON.stringify(m));
    s2.close();
    const c = await client(s2, ['-m', 'm', '--', 'a.txt'], {});
    ok('CH-06 the client without the channel of the adapter -> "channel closed for this role", exit 4', c.rc === 4 && /channel closed/.test(c.err + c.out), JSON.stringify(c));
  }

  // ---- CH-16 the adapter killed between the steps; the journal recovers or blocks
  {
    const RUNNER = path.join(BASE, 'runner.js');
    fs.writeFileSync(RUNNER, `'use strict';
const { openCommitService } = require(${JSON.stringify(SERVICE)});
const a = JSON.parse(process.argv[2]);
const at = a.killAt;
const die = () => process.kill(process.pid, 'SIGKILL');
const inject = {}; if (at) inject[at] = die;
openCommitService(Object.assign(a.opts, { inject, log: () => {} }));
setTimeout(() => process.exit(9), 20000);
`);
    const kill = (f, killAt, callId, prep) => {
      const box = path.join(f.tdir, `box-${callId}`);
      fs.mkdirSync(box);
      const id = prep(box);
      const p = spawnSync(process.execPath, [RUNNER, JSON.stringify({ killAt, opts: { task: 'K', callId, wt: f.wt, branch: 'task', box, stateDir: f.state, git: GIT, userEnv: f.userEnv, existingBox: true } })], { encoding: 'utf8', timeout: 30000 });
      return { id, signal: p.signal, out: p.stdout + p.stderr };
    };
    // killed after commit-tree, before update-ref: the tip is the old one -> refused "interrupted", no commit later
    const f = fixture();
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'killed before update-ref\n');
    const t0 = tip(f.wt);
    const k1 = kill(f, 'beforeUpdateRef', 'k1', (box) => put(box, req(['a.txt'], 'k1')));
    ok('CH-16 the adapter died by SIGKILL between commit-tree and update-ref', k1.signal === 'SIGKILL' && tip(f.wt) === t0, JSON.stringify(k1));
    const s = service(f);
    const ev = journal(f).filter((e) => e.id === k1.id);
    ok('CH-16 the next service of the task: the tip is the old one -> refused "interrupted" in the journal, no commit',
      ev.some((e) => e.ev === 'result' && e.status === 'refused' && /interrupted/.test(e.why)) && tip(f.wt) === t0, JSON.stringify(ev));
    put(s.box, fs.readFileSync(path.join(f.tdir, 'box-k1', `${k1.id}.json`)), k1.id);
    const a1 = await answer(s, k1.id);
    ok('CH-16 the same request again -> its recorded result, never a second attempt', a1 && a1.status === 'refused' && tip(f.wt) === t0, JSON.stringify(a1));
    s.close();
    // killed after update-ref, before the result: the tip is the intended commit -> committed, no second commit
    const f2 = fixture();
    fs.writeFileSync(path.join(f2.wt, 'a.txt'), 'killed after update-ref\n');
    const k2 = kill(f2, 'afterUpdateRef', 'k2', (box) => put(box, req(['a.txt'], 'k2')));
    const t2 = tip(f2.wt);
    const n2 = countCommits(f2.wt);
    const s2 = service(f2);
    const ev2 = journal(f2).filter((e) => e.id === k2.id);
    ok('CH-16 killed after update-ref: the tip is the intended sha -> committed on recovery',
      k2.signal === 'SIGKILL' && ev2.some((e) => e.ev === 'result' && e.status === 'committed' && e.sha === t2 && e.recovered === true), JSON.stringify(ev2));
    put(s2.box, fs.readFileSync(path.join(f2.tdir, 'box-k2', `${k2.id}.json`)), k2.id);
    const a2 = await answer(s2, k2.id);
    ok('CH-16 the repeated request after the crash -> committed with that sha, no second commit', a2 && a2.status === 'committed' && a2.sha === t2 && countCommits(f2.wt) === n2, JSON.stringify(a2));
    fs.writeFileSync(path.join(f2.wt, 'b.txt'), 'after recovery\n');
    const r2 = await client(s2, ['-m', 'next', '--', 'b.txt']);
    ok('CH-16 after the recovery the next request commits on top of the recovered sha', r2.j && r2.j.status === 'committed'
      && git(f2.wt, ['rev-parse', `${r2.j.sha}^`]).out === t2, JSON.stringify(r2.j));
    s2.close();
    // killed after update-ref, then the branch moved elsewhere: undetermined, every request refused until resolve
    const f3 = fixture();
    fs.writeFileSync(path.join(f3.wt, 'a.txt'), 'undetermined\n');
    const k3 = kill(f3, 'afterUpdateRef', 'k3', (box) => put(box, req(['a.txt'], 'k3')));
    git(f3.wt, ['commit', '-q', '--allow-empty', '-m', 'elsewhere']);
    const s3 = service(f3);
    fs.writeFileSync(path.join(f3.wt, 'b.txt'), 'blocked\n');
    const t3 = tip(f3.wt);
    const r3 = await client(s3, ['-m', 'm', '--', 'b.txt']);
    ok('CH-16d the tip is neither the intended sha nor its parent -> undetermined in the journal; requests refused until the coordinator resolves it',
      journal(f3).some((e) => e.ev === 'undetermined' && e.id === k3.id) && r3.j && r3.j.status === 'refused' && /undetermined/.test(r3.j.why) && tip(f3.wt) === t3, JSON.stringify(r3.j));
    s3.close();
    // a torn last line: shown in the diagnostics, not taken as a result; a damaged line inside: recovery refused
    const f4 = fixture();
    fs.writeFileSync(path.join(f4.wt, 'a.txt'), 'torn\n');
    const s4a = service(f4);
    const r4a = await client(s4a, ['-m', 'm', '--', 'a.txt']);
    s4a.close();
    const jf = path.join(f4.state, 'K', 'commits.jsonl');
    const lines = fs.readFileSync(jf, 'utf8');
    fs.appendFileSync(jf, '{"v":1,"n":99,"ev":"result","id":"' + 'f'.repeat(32) + '","status":"comm');
    const s4 = service(f4);
    ok('CH-16b a torn last line of the journal -> named in the notes, not taken as a result, the journal stays readable',
      s4.notes().some((n) => /torn/.test(n)) && !journal(f4).some((e) => e.id === 'f'.repeat(32)) && fs.readFileSync(jf, 'utf8').startsWith(lines), JSON.stringify(s4.notes()));
    fs.writeFileSync(path.join(f4.wt, 'b.txt'), 'after torn\n');
    const r4 = await client(s4, ['-m', 'm', '--', 'b.txt']);
    ok('CH-16b after a torn tail the next request commits', r4.j && r4.j.status === 'committed' && git(f4.wt, ['rev-parse', `${r4.j.sha}^`]).out === r4a.j.sha, JSON.stringify(r4.j));
    s4.close();
    const all = fs.readFileSync(jf, 'utf8').split('\n');
    all.splice(1, 0, '{broken');
    fs.writeFileSync(jf, all.join('\n'));
    const s5 = service(f4);
    fs.writeFileSync(path.join(f4.wt, 'a.txt'), 'after damage\n');
    const t5 = tip(f4.wt);
    const r5 = await client(s5, ['-m', 'm', '--', 'a.txt']);
    ok('CH-16c a damaged line inside the journal -> every request refused naming the journal, no commit',
      r5.j && r5.j.status === 'refused' && /journal/.test(r5.j.why) && tip(f4.wt) === t5, JSON.stringify(r5.j));
    s5.close();
    // one writer: a second live service of the same task refuses its requests
    const f6 = fixture();
    const s6 = service(f6);
    const s7 = service(f6);
    fs.writeFileSync(path.join(f6.wt, 'a.txt'), 'two writers\n');
    const r7 = await client(s7, ['-m', 'm', '--', 'a.txt']);
    ok('one writer of the journal: a second live service of the task refuses (another adapter writes it)', r7.j && r7.j.status === 'refused' && /another adapter/.test(r7.j.why), JSON.stringify(r7.j));
    s7.close();
    const r6 = await client(s6, ['-m', 'm', '--', 'a.txt']);
    ok('one writer: the first service still commits', r6.j && r6.j.status === 'committed', JSON.stringify(r6.j));
    s6.close();
  }

  // ---- role-exec.js: cfg.commit, tasks[k].branch, the channel only for prog and test (CH-01, CH-03, CH-05, CH-06, CH-07)
  if (roleExec) {
    const { createAgent } = roleExec;
    const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));
    const f = fixture();
    const chome = path.join(f.d, 'chome');
    fs.mkdirSync(chome);
    const SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
    const seen = [];
    let script = null;
    const launch = async (plan) => {
      seen.push(plan);
      const out = script ? await script(plan) : null;
      return { rc: 0, output: JSON.stringify({ status: 'ready' }), notes: [], extra: out };
    };
    const base = { host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, launch, log: () => {},
      codex: { home: chome, catalog: CATALOG }, env: Object.assign({}, f.userEnv, { CODIS_COMMIT_BOX: '/inherited', CODIS_COMMIT_ANSWERS: '/inherited' }),
      tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT } };
    const mk = (over) => { try { return createAgent(Object.assign({}, base, over)); } catch (e) { return e; } };
    for (const [name, sd] of [['the task folder', path.join(f.tdir, 'st')], ['the worktree', path.join(f.wt, 'st')], ['/private/tmp', '/private/tmp/codis-st'],
      ['the TMPDIR of the role', path.join(f.rtmp, 'st')], ['a relative path', 'state']]) {
      const e = mk({ commit: { stateDir: sd, git: GIT } });
      ok(`commit.stateDir under ${name} -> createAgent refused`, e instanceof Error && /stateDir/.test(e.message), String(e && e.message));
    }
    const ec = mk({ host: 'claude', codex: undefined });
    ok('cfg.commit on the claude host -> createAgent refused (the claude host gets the channel in part A2c)', ec instanceof Error && /A2c/.test(ec.message), String(ec && ec.message));
    const agent = mk({});
    ok('createAgent with cfg.commit and a launcher', typeof agent === 'function', String(agent && agent.message));
    script = async (plan) => {
      fs.writeFileSync(path.join(f.wt, 'a.txt'), 'via the adapter\n');
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [CLIENT, '-m', 'red guard', '--', 'a.txt'], { cwd: plan.t.wt, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '';
        c.stdout.on('data', (x) => { o += x; });
        c.on('close', (rc) => resolve({ rc, o }));
      });
    };
    const t0 = tip(f.wt);
    const v = await agent('prompt', { label: 'prog:K#1', schema: SCHEMA, agentType: 'general-purpose' });
    const p1 = seen[seen.length - 1];
    const recs = fs.readFileSync(path.join(f.tdir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = recs[recs.length - 1];
    ok('CH-01 prog on codex with a launcher: the call is ok and the client got committed through the adapter',
      v && v.status === 'ready' && tip(f.wt) !== t0 && rec.commit && rec.commit.commits.length === 1 && rec.commit.commits[0].sha === tip(f.wt), JSON.stringify(rec.commit));
    ok('CH-01 the box is in the call folder, the answers in the state folder; the env of the role names both',
      p1.commit && p1.commit.box.startsWith(p1.callDir) && p1.env.CODIS_COMMIT_BOX === p1.commit.box && p1.env.CODIS_COMMIT_ANSWERS === p1.commit.answers
      && p1.commit.answers.startsWith(fs.realpathSync(f.state)), JSON.stringify(p1.commit));
    // CH-05 a commit outside between calls; CH-03 test commits on top of the HEAD at the start of its call
    git(f.wt, ['commit', '-q', '--allow-empty', '-m', 'between calls']);
    const tb = tip(f.wt);
    script = async (plan) => {
      fs.writeFileSync(path.join(f.wt, 'b.txt'), 'tester guard\n');
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [CLIENT, '-m', 'tester guard', '--', 'b.txt'], { env: plan.env, stdio: 'ignore' });
        c.on('close', resolve);
      });
    };
    await agent('prompt', { label: 'test:K#1', schema: SCHEMA, agentType: 'general-purpose' });
    ok('CH-03, CH-05 test after an outside commit: its commit sits on the HEAD at the start of the call',
      git(f.wt, ['rev-parse', 'HEAD^']).out === tb && tip(f.wt) !== tb, git(f.wt, ['log', '--oneline', '-3']).out);
    // CH-06 other kinds: no box, no CODIS_COMMIT_* (an inherited one dropped), the client says the channel is closed
    let closed = null;
    script = async (plan) => new Promise((resolve) => {
      const c = spawn(process.execPath, [CLIENT, '-m', 'm', '--', 'a.txt'], { env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', (x) => { o += x; }); c.stderr.on('data', (x) => { o += x; });
      c.on('close', (rc) => { closed = { rc, o }; resolve(); });
    });
    const tr = tip(f.wt);
    await agent('prompt', { label: 'review:K#1', schema: SCHEMA, agentType: 'general-purpose' });
    const pr = seen[seen.length - 1];
    ok('CH-06 review: no box, no CODIS_COMMIT_* in its env (the inherited ones dropped), the client exits 4 "channel closed"',
      !pr.commit && pr.env.CODIS_COMMIT_BOX === undefined && pr.env.CODIS_COMMIT_ANSWERS === undefined && closed && closed.rc === 4
      && /channel closed/.test(closed.o) && tip(f.wt) === tr && !fs.existsSync(path.join(pr.callDir, 'commit')), JSON.stringify(closed));
    // CH-07 a request left in the box of an earlier call is not processed by a new call
    const oldBox = p1.commit.box;
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'stale request\n');
    const stale = put(oldBox, req(['a.txt'], 'stale'));
    script = async () => sleep(1500);
    await agent('prompt', { label: 'prog:K#2', schema: SCHEMA, agentType: 'general-purpose' });
    ok('CH-07 a request in the box of an earlier call -> not processed by the next call (no answer, no commit)',
      tip(f.wt) === tr && !fs.existsSync(path.join(seen[seen.length - 1].commit.answers, `${stale}.json`)));
    // without a branch: prog refused before any launch
    const nob = mk({ tasks: { K: { dir: f.tdir, wt: f.wt } } });
    const n0 = seen.length;
    const vb = await nob('prompt', { label: 'prog:K#3', schema: SCHEMA, agentType: 'general-purpose' });
    const lb = fs.readFileSync(path.join(f.tdir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    ok('a task without branch -> prog with the commit channel refused before the launch, the record names the branch', vb === null && seen.length === n0
      && lb.outcome === 'refused' && /has no branch/.test(lb.error), JSON.stringify(lb));
    // the real CLI is still refused for prog/test on codex (the sandbox profile of code writes: part A2a-3)
    const real = createAgent(Object.assign({}, base, { launch: undefined }));
    const vr = await real('prompt', { label: 'prog:K#4', schema: SCHEMA, agentType: 'general-purpose' });
    const lr = fs.readFileSync(path.join(f.tdir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    ok('without a launcher prog on codex is still refused (A2)', vr === null && lr.outcome === 'refused' && /A2/.test(lr.error), JSON.stringify(lr));
    // The record of the call (<task dir>/calls.jsonl) sits in a folder the role writes (owner's answer to G2): a link,
    // a FIFO or a hard link the role leaves there is never written through, and the adapter does not hang on it.
    const recFile = path.join(f.tdir, 'calls.jsonl');
    const victim = path.join(f.d, 'victim.rc');
    fs.writeFileSync(victim, 'export A=1\n');
    const victim0 = sha256(fs.readFileSync(victim));
    const logs = [];
    const lagent = mk({ log: (m) => logs.push(String(m)) });
    script = async (plan) => {
      fs.rmSync(recFile, { force: true });
      fs.symlinkSync(victim, recFile);
      fs.writeFileSync(path.join(plan.t.wt, 'x.txt'), 'x\n');
      return new Promise((resolve) => {
        const c = spawn(process.execPath, [CLIENT, '-m', 'm', '--', 'x$(touch PWNED)'], { cwd: plan.t.wt, env: plan.env, stdio: 'ignore' });
        c.on('close', resolve);
      });
    };
    await lagent('prompt', { label: 'prog:K#5', schema: SCHEMA, agentType: 'general-purpose' });
    ok('S-1 calls.jsonl replaced by the role with a link to a file outside its roots -> the file is not written, the link stays, the log says so',
      sha256(fs.readFileSync(victim)) === victim0 && fs.lstatSync(recFile).isSymbolicLink() && logs.some((m) => /record of the call/.test(m)),
      `${fs.readFileSync(victim, 'utf8').slice(0, 200)} | ${logs.join(' | ')}`);
    script = async () => { fs.rmSync(recFile, { force: true }); fs.symlinkSync(path.join(f.d, 'dangling.rc'), recFile); };
    await lagent('prompt', { label: 'review:K#5', schema: SCHEMA, agentType: 'general-purpose' });
    ok('S-1 calls.jsonl replaced with a dangling link -> no file is created at its target', !fs.existsSync(path.join(f.d, 'dangling.rc')));
    script = async () => { fs.rmSync(recFile, { force: true }); fs.linkSync(victim, recFile); };
    await lagent('prompt', { label: 'review:K#6', schema: SCHEMA, agentType: 'general-purpose' });
    ok('S-1 calls.jsonl replaced with a hard link to a file outside the roots -> not written', sha256(fs.readFileSync(victim)) === victim0);
    // a FIFO with a reader: the old append wrote into it; a regular file only
    const fifoOut = path.join(f.d, 'fifo-out.txt');
    let reader = null;
    script = async () => {
      fs.rmSync(recFile, { force: true });
      spawnSync('mkfifo', [recFile]);
      reader = spawn('/bin/sh', ['-c', 'cat "$0" > "$1"', recFile, fifoOut], { stdio: 'ignore' });
      kids.push(reader.pid);
      await sleep(300);
    };
    await lagent('prompt', { label: 'review:K#7', schema: SCHEMA, agentType: 'general-purpose' });
    await sleep(300);
    try { reader.kill('SIGKILL'); } catch { /* gone */ }
    ok('S-1 calls.jsonl replaced with a FIFO that has a reader -> nothing is written into it',
      !fs.existsSync(fifoOut) || fs.readFileSync(fifoOut, 'utf8') === '', fs.existsSync(fifoOut) ? fs.readFileSync(fifoOut, 'utf8').slice(0, 200) : '');
    // a FIFO without a reader: a blocking open would hang the whole adapter, so this runs in a child with a deadline
    fs.rmSync(recFile, { force: true });
    spawnSync('mkfifo', [recFile]);
    const childCode = `const { createAgent } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'role-exec.js'))});
const a = createAgent({ host: 'codex', callsDir: ${JSON.stringify(path.join(f.d, 'calls'))}, pluginRoot: ${JSON.stringify(ROOT)},
  launch: async () => ({ rc: 0, output: JSON.stringify({ status: 'ready' }), notes: [] }), log: (m) => console.log(m),
  codex: { home: ${JSON.stringify(chome)}, catalog: ${JSON.stringify(CATALOG)} }, env: ${JSON.stringify(f.userEnv)},
  tasks: { K: { dir: ${JSON.stringify(f.tdir)}, wt: ${JSON.stringify(f.wt)}, branch: 'task' } } });
a('prompt', { label: 'review:K#8', schema: ${JSON.stringify(SCHEMA)}, agentType: 'general-purpose' }).then((v) => console.log('returned', JSON.stringify(v)));`;
    const fc = spawnSync(process.execPath, ['-e', childCode], { encoding: 'utf8', timeout: 20000 });
    ok('S-1 calls.jsonl replaced with a FIFO without a reader -> the adapter does not hang (the call returns, the log names the record)',
      fc.status === 0 && /returned/.test(fc.stdout) && /record of the call/.test(fc.stdout), `exit ${fc.status} ${fc.signal || ''} ${(fc.stdout || '').slice(-300)} ${(fc.stderr || '').slice(-300)}`);
    fs.rmSync(recFile, { force: true });
    ok('the control file outside the worktree is unchanged (role-exec)', f.controlSha() === f.control0);
  }
  // ---- the tester's cells (swaps during the read, a socket request, the first scan, the queue order, the poll and the
  // subscription): tests/commit-channel-tester-cases.js, a child with its own tally, so README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'commit-channel-tester-cases.js')], { encoding: 'utf8', timeout: 240000 });
    process.stdout.write((tc.stdout || '').replace(/\n+$/, '').replace(/^/gm, '  | ') + '\n');
    ok('the tester cells of the channel (tests/commit-channel-tester-cases.js) pass', tc.status === 0,
      `exit ${tc.status} ${tc.signal || ''} ${(tc.stderr || '').slice(-500)}`);
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
