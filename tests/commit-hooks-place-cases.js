#!/usr/bin/env node
'use strict';
// The hooks folder of a check against the tip at the start of the call (p-codex A2a-3b, mechanism M1-B, owner
// 2026-11-09 "hooks: B"): scripts/commit-service.js records the hooks location P0 when the service opens; every request
// and every pass of the hooks compares the location with P0 (H8), and when P0 lies in the role's write places
// (scripts/role-roots.js) the folder must be tracked in the tip (H5), equal to it file by file in both directions
// (H3a, H3b, H7, H9) and not named by the request (H4). Outside those places only the location is compared (H1, H6).
// tests/commit-checks.test.js runs this file as a child with its own tally, so README keeps counting test files. Real
// git repositories in a temporary folder, the real codex sandbox without a model; every hook writes a mark into
// <task folder>/marks, so "no hook ran" is an empty marks folder. Skipped without macOS, codex or git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the hooks folder of a check against the tip', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-hp-')));
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const exe = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const OWNER = 'Changing the hooks of the check through the commit adapter is not supported; it needs a separate task of the coordinator.';
const S9 = /lies in the role's write places/;
const HP = 'scripts/git-hooks';

let fixN = 0;
// A repository with a linked worktree on branch "task" (o.main: the worktree is the main checkout). The base commit
// tracks the hooks folder scripts/git-hooks (pre-commit that writes a mark, then o.body; notes.txt) and a .gitignore
// with *.local. o.tracked: no tracked hooks folder. o.hooksPath: the value of core.hooksPath, set with
// git config --worktree (extensions.worktreeConfig) in a linked worktree, in the repository config otherwise; null for none.
function fixture(o) {
  const x = o || {};
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'), home: path.join(d, 'home') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  f.marksDir = path.join(f.tdir, 'marks');
  f.hookText = (name, body) => `#!/bin/sh\nmkdir -p '${f.marksDir}' && echo ran >> '${path.join(f.marksDir, name)}' || exit 99\n${body || ''}\nexit 0\n`;
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(f.repo, '.gitignore'), '*.local\n');
  if (x.tracked !== false) {
    exe(path.join(f.repo, HP, 'pre-commit'), f.hookText('pre-commit', x.body));
    fs.writeFileSync(path.join(f.repo, HP, 'notes.txt'), 'notes\n');
    if (x.other) exe(path.join(f.repo, 'scripts', 'other-hooks', 'pre-commit'), f.hookText('other', ''));
  }
  for (const [p, t] of Object.entries(x.links || {})) { fs.mkdirSync(path.dirname(path.join(f.repo, p)), { recursive: true }); fs.symlinkSync(t, path.join(f.repo, p)); }
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  if (x.main) { git(f.repo, ['checkout', '-q', '-b', 'task']); f.wt = f.repo; } else {
    f.wt = path.join(d, 'wt');
    git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  }
  f.setHooksPath = (v) => {
    if (x.main) return git(f.repo, ['config', 'core.hooksPath', v]);
    git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
    return git(f.wt, ['config', '--worktree', 'core.hooksPath', v]);
  };
  if (x.hooksPath !== null) f.setHooksPath(x.hooksPath || HP);
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp };
  f.h0 = git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.marks = () => { try { return fs.readdirSync(f.marksDir).sort(); } catch { return []; } };
  f.hp = path.join(f.wt, HP);
  return f;
}
let callN = 0;
const service = (f) => {
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  return openCommitService({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'), stateDir: f.state, git: GIT,
    codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {} });
};
const put = (s, paths) => {
  const id = newId();
  fs.writeFileSync(path.join(s.box, `.${id}.tmp`), JSON.stringify({ id, paths, message: 'msg' }));
  fs.renameSync(path.join(s.box, `.${id}.tmp`), path.join(s.box, `${id}.json`));
  return id;
};
const answer = async (s, id) => {
  const end = Date.now() + 60000;
  for (;;) {
    try { return JSON.parse(fs.readFileSync(path.join(s.answers, `${id}.json`), 'utf8')); } catch { /* not yet */ }
    if (Date.now() > end) return null;
    await sleep(25);
  }
};
// one request for a.txt (plus o.paths) after o.before(f) ran on the open service; {a, marks, moved}
const request = async (f, o) => {
  const x = o || {};
  const s = service(f);
  if (x.before) x.before(f);
  fs.writeFileSync(path.join(f.wt, 'a.txt'), `change ${fixN}\n`);
  const a = await answer(s, put(s, ['a.txt'].concat(x.paths || [])));
  await s.close();
  return { a, marks: f.marks(), moved: f.tip() !== f.h0 };
};
const rp = (p) => fs.realpathSync(p);
const refusedM1 = (r) => r.a && r.a.status === 'refused' && !r.moved && !S9.test(r.a.why);
const differs = (f, kind, p) => (r) => refusedM1(r) && r.a.why.includes(`the hooks folder ${path.join(rp(f.wt), HP)} differs from ${f.h0}:`) && r.a.why.includes(`${kind} ${p}`) && r.a.why.includes(OWNER);
const untracked = (f, dir) => (r) => refusedM1(r) && r.a.why.includes(`no safe check path: the hooks folder ${dir} is not tracked in ${f.h0} inside the role's write roots; ${OWNER}`);
const moved = (r) => r.a && r.a.status === 'refused' && !r.moved && /^the hooks location changed during the call \(/.test(r.a.why);

(async () => {
  // ---- H1: P0 outside the role's places - hooks run as in 0.4.36, the folder is not compared with the tip
  {
    const f = fixture({ tracked: false, hooksPath: null });
    const out = path.join(f.d, 'outside-hooks');
    exe(path.join(out, 'pre-commit'), f.hookText('outside', ''));
    fs.writeFileSync(path.join(out, 'extra.txt'), 'not in any tip\n');
    f.setHooksPath(out);
    const r = await request(f);
    ok('H1 an absolute core.hooksPath outside the role\'s places with an untracked extra file: committed, its hook ran (no compare with the tip)',
      r.a && r.a.status === 'committed' && r.marks.join() === 'outside', J(r));
  }
  {
    const f = fixture({ tracked: false, hooksPath: null });
    exe(path.join(f.repo, '.git', 'hooks', 'pre-commit'), f.hookText('common', ''));
    const r = await request(f);
    ok('H1 a linked worktree with <common dir>/hooks: committed, its hook ran', r.a && r.a.status === 'committed' && r.marks.join() === 'common', J(r));
  }

  // ---- H2: a tracked hooks folder inside the worktree, equal to the tip
  {
    const f = fixture();
    const r = await request(f);
    ok('H2 core.hooksPath=scripts/git-hooks (git config --worktree), tracked, equal to the tip: committed, the hook ran',
      r.a && r.a.status === 'committed' && r.moved && r.marks.join() === 'pre-commit' && r.a.checks && r.a.checks.length === 1, J(r));
  }

  // ---- H3a: a tracked hook changed before the request
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.appendFileSync(path.join(f.hp, 'pre-commit'), 'echo edited\n') });
    ok('H3a a tracked hook edited before the request: refused "differs from <tip>: modified <path>" with the owner\'s text, no hook ran',
      differs(f, 'modified', `${HP}/pre-commit`)(r) && !r.marks.length, J(r));
  }
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.chmodSync(path.join(f.hp, 'notes.txt'), 0o755) });
    ok('H3a a tracked file of the folder with a new mode: refused as modified, no hook ran', differs(f, 'modified', `${HP}/notes.txt`)(r) && !r.marks.length, J(r));
  }

  // ---- H3b: a new untracked or ignored file in the folder
  {
    const f = fixture();
    const r = await request(f, { before: () => exe(path.join(f.hp, 'commit-msg'), f.hookText('commit-msg', '')) });
    ok('H3b a new executable commit-msg in the folder: refused "added <path>", no hook ran', differs(f, 'added', `${HP}/commit-msg`)(r) && !r.marks.length, J(r));
  }
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.writeFileSync(path.join(f.hp, 'cache.local'), 'ignored\n') });
    ok('H3b an ignored file in the folder: refused "added <path>", no hook ran', differs(f, 'added', `${HP}/cache.local`)(r) && !r.marks.length, J(r));
  }

  // ---- H4: the request names a path in the folder
  {
    const f = fixture();
    const r = await request(f, { paths: [`${HP}/pre-commit`], before: () => fs.appendFileSync(path.join(f.hp, 'pre-commit'), 'echo edited\n') });
    ok('H4 the request names an edited hook: refused "the request names <path> in the hooks folder" with the owner\'s text, no hook ran',
      refusedM1(r) && r.a.why.includes(`the request names "${HP}/pre-commit" in the hooks folder ${rp(f.hp)}. ${OWNER}`) && !r.marks.length, J(r));
  }
  {
    const f = fixture();
    const r = await request(f, { paths: [`${HP}/NEW-hook`], before: () => fs.writeFileSync(path.join(f.hp, 'NEW-hook'), 'x\n') });
    ok('H4 the request names a new file in the folder: refused with the owner\'s text, no hook ran',
      refusedM1(r) && r.a.why.includes(`the request names "${HP}/NEW-hook"`) && r.a.why.includes(OWNER) && !r.marks.length, J(r));
  }

  // ---- H5: a hooks folder in the role's places that the tip does not track
  {
    const f = fixture({ tracked: false, hooksPath: '.husky/_' });
    exe(path.join(f.wt, '.husky', '_', 'pre-commit'), f.hookText('husky', ''));
    const r = await request(f);
    ok('H5 husky\'s untracked .husky/_ in the worktree: refused "no safe check path: ... is not tracked in <tip> inside the role\'s write roots" with the owner\'s text, no hook ran',
      untracked(f, path.join(rp(f.wt), '.husky', '_'))(r) && !r.marks.length, J(r));
  }
  for (const [name, dirOf] of [['the task folder', (f) => path.join(f.tdir, 'hk')], ['the role\'s TMPDIR', (f) => path.join(f.rtmp, 'hk')]]) {
    const f = fixture({ hooksPath: null });
    const dir = dirOf(f);
    exe(path.join(dir, 'pre-commit'), f.hookText('placed', ''));
    f.setHooksPath(dir);
    const r = await request(f);
    ok(`H5 a hooks folder under ${name}: refused as not tracked, no hook ran`, untracked(f, rp(dir))(r) && !r.marks.length, J(r));
  }
  {
    const tmpHooks = fs.realpathSync(fs.mkdtempSync('/tmp/codis-hp-'));
    try {
      const f = fixture({ tracked: false, hooksPath: 'hk', links: { hk: tmpHooks } });
      exe(path.join(tmpHooks, 'pre-commit'), f.hookText('tmp', ''));
      const r = await request(f);
      ok('H5 a tracked link in the worktree whose real path lies under /tmp: refused as not tracked by its real path, no hook ran',
        untracked(f, tmpHooks)(r) && !r.marks.length, J(r));
    } finally { fs.rmSync(tmpHooks, { recursive: true, force: true }); }
  }

  // ---- H6: <wt>/.git and <wt>/.codex are no write places of the role
  {
    const f = fixture({ main: true, tracked: false, hooksPath: null });
    exe(path.join(f.wt, '.git', 'hooks', 'pre-commit'), f.hookText('dotgit', ''));
    const r = await request(f);
    ok('H6 the main checkout with <wt>/.git/hooks (untracked): committed, its hook ran', r.a && r.a.status === 'committed' && r.marks.join() === 'dotgit', J(r));
  }
  {
    const f = fixture({ tracked: false, hooksPath: '.codex/hooks' });
    exe(path.join(f.wt, '.codex', 'hooks', 'pre-commit'), f.hookText('dotcodex', ''));
    const r = await request(f);
    ok('H6 <wt>/.codex/hooks (untracked): committed, its hook ran', r.a && r.a.status === 'committed' && r.marks.join() === 'dotcodex', J(r));
  }

  // ---- H7: a file of the tip deleted in the worktree, also when no executable hook is left
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.rmSync(path.join(f.hp, 'pre-commit')) });
    ok('H7 the only hook deleted: refused "deleted <path>" (not committed without a check)', differs(f, 'deleted', `${HP}/pre-commit`)(r) && !r.marks.length, J(r));
  }
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.rmSync(f.hp, { recursive: true }) });
    ok('H7 the whole hooks folder deleted: refused with both deleted paths', differs(f, 'deleted', `${HP}/pre-commit`)(r) && r.a.why.includes(`deleted ${HP}/notes.txt`) && !r.marks.length, J(r));
  }

  // ---- H8: the hooks location at a request or after a pass differs from the one at the start of the call
  {
    const f = fixture({ tracked: false, hooksPath: null });
    const one = path.join(f.d, 'hooks-one'), two = path.join(f.d, 'hooks-two');
    exe(path.join(one, 'pre-commit'), f.hookText('one', ''));
    exe(path.join(two, 'pre-commit'), f.hookText('two', ''));
    f.setHooksPath(one);
    const r = await request(f, { before: () => f.setHooksPath(two) });
    ok('H8 P0 outside the role\'s places, switched to another folder outside during the call: refused "the hooks location changed during the call (P0 -> P)", no hook ran',
      moved(r) && r.a.why.includes(one) && r.a.why.includes(two) && !r.marks.length, J(r));
  }
  {
    const f = fixture({ tracked: false, hooksPath: null });
    const inc = path.join(f.wt, 'inc.cfg');
    exe(path.join(f.wt, 'role-hooks', 'pre-commit'), f.hookText('role', ''));
    const r = await request(f, { before: () => { fs.writeFileSync(inc, '[core]\n\thooksPath = role-hooks\n'); git(f.repo, ['config', 'include.path', inc]); } });
    ok('H8 P0 = <common dir>/hooks, an include.path in the worktree points core.hooksPath at a folder of the role: refused before any hook, not by the S9 text',
      moved(r) && !S9.test(r.a.why) && r.a.why.includes(path.join(f.repo, '.git', 'hooks')) && !r.marks.length, J(r));
  }
  {
    const f = fixture({ other: true });
    const r = await request(f, { before: () => f.setHooksPath('scripts/other-hooks') });
    ok('H8 P0 a tracked folder in the worktree, switched to another tracked folder (config.worktree): refused before any hook',
      moved(r) && r.a.why.includes(rp(f.hp)) && r.a.why.includes('other-hooks') && !r.marks.length, J(r));
  }
  {
    // the hook of pass 1 rewrites the include file under the worktree that names the hooks folder
    const f = fixture({ other: true, hooksPath: null, body: `printf '[core]\\n\\thooksPath = scripts/other-hooks\\n' > inc.cfg` });
    const inc = path.join(f.wt, 'inc.cfg');
    fs.writeFileSync(inc, `[core]\n\thooksPath = ${HP}\n`);
    git(f.repo, ['config', 'include.path', inc]);
    const r = await request(f);
    ok('H8 after pass 1 the hooks location changed (the hook rewrote the include file): refused with the location text, not as a change outside the request, the hook ran once',
      moved(r) && r.a.why.includes('other-hooks') && r.marks.join() === 'pre-commit', J(r));
  }

  // ---- H9: pass 1 changed the hooks folder
  for (const [name, body, kind, p] of [
    ['an ignored file', `echo x > ${HP}/out.local`, 'added', `${HP}/out.local`],
    ['an untracked file', `echo x > ${HP}/new-hook`, 'added', `${HP}/new-hook`],
    ['a tracked file', `echo more >> ${HP}/notes.txt`, 'modified', `${HP}/notes.txt`],
    ['a deletion', `rm ${HP}/notes.txt`, 'deleted', `${HP}/notes.txt`],
  ]) {
    const f = fixture({ body });
    const r = await request(f);
    ok(`H9 pass 1 wrote ${name} into the hooks folder: refused "${kind} <path>" before a second pass and the commit, the hook ran once`,
      differs(f, kind, p)(r) && r.marks.join() === 'pre-commit' && fs.readFileSync(path.join(f.marksDir, 'pre-commit'), 'utf8') === 'ran\n', J(r));
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
