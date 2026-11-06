#!/usr/bin/env node
'use strict';
// The tester's cells of the checks of a commit (p-codex A2a-2a), run as a child of tests/commit-checks.test.js with
// its own tally: the order and the set of the hooks of a check (post-commit is not a check), the message the hooks
// judge is the message committed (git stripspace, as git commit -F), LANG and LC_ALL of the check by their pattern,
// a request with nothing to commit launches no check, a check that changes the mode of a named path or recreates a
// deleted one changes the snapshot, close() with a request queued behind a running check, and hooks that are not
// executable. Real git repositories in a temporary folder, the real codex sandbox without a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the tester cells of the checks of a commit', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-chk-t-')));
process.on('exit', () => { fs.rmSync(BASE, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args, input) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV, input });
  return { rc: p.status, out: (p.stdout || '').trim(), raw: p.stdout || '', err: (p.stderr || '').trim() };
};
const exe = (p, body, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, mode === undefined ? 0o755 : mode); };
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);

// a hook writes <tdir>/marks/<hook>.json: sandbox marker, HOME, LANG, LC_ALL, its arguments, the message it saw, a
// sequence number (the order of the hooks)
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN);
const MARK = path.join(BIN, 'mark.js');
fs.writeFileSync(MARK, `const fs=require('fs'),path=require('path');
const [tdir,hook,...args]=process.argv.slice(2);
const dir=path.join(tdir,'marks');fs.mkdirSync(dir,{recursive:true});
const seq=fs.readdirSync(dir).length+1;const e=process.env;
let msg=null;if(args[0]){try{msg=fs.readFileSync(args[0],'utf8');}catch(x){msg='ERR '+x.code;}}
fs.writeFileSync(path.join(dir,hook+'.json'),JSON.stringify({seq,sandbox:e.CODEX_SANDBOX||null,home:e.HOME,lang:e.LANG,lcAll:e.LC_ALL,args,msg}));
`);

let fixN = 0;
function fixture(hooks, hookMode) {
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'),
    home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), hooks: path.join(d, 'hooks') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'xdg']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  for (const n of ['a.txt', 'b.txt', 'gone.txt']) fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  f.wt = path.join(d, 'wt');
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  for (const [n, body] of Object.entries(hooks || {})) {
    exe(path.join(f.hooks, n), `#!/bin/sh\nnode '${MARK}' '${f.tdir}' '${n}' "$@" || exit 99\nT='${f.tdir}'\n${body || ''}\nexit 0\n`, (hookMode || {})[n]);
  }
  git(f.repo, ['config', 'core.hooksPath', f.hooks]);
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg, TMPDIR: f.rtmp, LANG: 'en_US.UTF-8' };
  f.h0 = git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.mark = (h) => readJson(path.join(f.tdir, 'marks', `${h}.json`));
  return f;
}
let callN = 0;
function service(f, extra) {
  const launches = [];
  const e = extra || {};
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  const s = openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'),
    stateDir: f.state, git: GIT, codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {} }, e,
  { inject: { checkLaunch: (spec) => { launches.push(spec.kind); return spec; } } }));
  s.launches = launches;
  return s;
}
function ask(s, paths, message) {
  const id = newId();
  const tmp = path.join(s.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, paths, message: message === undefined ? 'msg' : message }));
  fs.renameSync(tmp, path.join(s.box, `${id}.json`));
  return id;
}
const readAnswer = (s, id) => readJson(path.join(s.answers, `${id}.json`));
async function answer(s, id, ms) {
  const end = Date.now() + (ms || 30000);
  for (;;) { const a = readAnswer(s, id); if (a || Date.now() > end) return a; await sleep(25); }
}

(async () => {
  // ---- T1: the three hooks of a check in the order of git, each in the sandbox and in a home of its own; post-commit
  // is not a check and never runs; checks[] in that order
  {
    const f = fixture({ 'commit-msg': '', 'post-commit': 'echo ran > "$T/post-commit-ran"', 'prepare-commit-msg': '', 'pre-commit': '' });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const m = ['pre-commit', 'prepare-commit-msg', 'commit-msg'].map((h) => f.mark(h));
    ok('T1 three hooks of a check: committed, checks[] = pre-commit, prepare-commit-msg, commit-msg, each rc 0',
      a && a.status === 'committed' && Array.isArray(a.checks) && a.checks.map((c) => `${c.hook}:${c.rc}`).join() === 'pre-commit:0,prepare-commit-msg:0,commit-msg:0', J(a));
    ok('T1 the hooks ran in that order, each with CODEX_SANDBOX=seatbelt and a home of its own',
      m.every(Boolean) && m.map((x) => x.seq).join() === '1,2,3' && m.every((x) => x.sandbox === 'seatbelt') && new Set(m.map((x) => x.home)).size === 3, J(m));
    ok('T1 post-commit is not a check: it never ran (neither in nor outside the sandbox)', !fs.existsSync(path.join(f.tdir, 'post-commit-ran')) && !f.mark('post-commit'));
    ok('T1 commit-msg got the message file only', m[2] && m[2].args.length === 1 && /COMMIT_EDITMSG$/.test(m[2].args[0]), J(m[2]));
    await s.close();
  }

  // ---- T2: the message the hooks judge is the message committed: git stripspace before the hooks (c2, as git
  // commit -F), and the commit carries exactly it
  {
    const raw = '\n\n  title line   \n\n\n\nbody line\t\n\n\n';
    const want = git(BASE, ['stripspace'], raw).raw;
    const f = fixture({ 'commit-msg': '' });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'y\n');
    const a = await answer(s, ask(s, ['a.txt'], raw));
    const m = f.mark('commit-msg');
    const body = a && a.sha ? git(f.wt, ['cat-file', 'commit', a.sha]).raw.split('\n\n').slice(1).join('\n\n') : null;
    ok('T2 commit-msg sees the message after git stripspace', m && m.msg === want && want === '  title line\n\nbody line\n', J({ msg: m && m.msg, want }));
    ok('T2 the commit carries the message the hook saw', a && a.status === 'committed' && body === want, J({ a, body }));
    await s.close();
  }

  // ---- T3: LANG and LC_ALL of the check: a value of the pattern [A-Za-z0-9_.@-]+ passes, anything else is C
  for (const [name, env, lang, lcAll] of [
    ['T3 LANG en_US.UTF-8 and no LC_ALL -> both en_US.UTF-8', { LANG: 'en_US.UTF-8' }, 'en_US.UTF-8', 'en_US.UTF-8'],
    ['T3 LANG with a space and a ; -> C; a valid LC_ALL passes', { LANG: 'en_US.UTF-8; touch x', LC_ALL: 'de_DE.UTF-8' }, 'C', 'de_DE.UTF-8'],
    ['T3 LC_ALL with a $( ) -> C', { LANG: 'C.UTF-8', LC_ALL: '$(id)' }, 'C.UTF-8', 'C'],
  ]) {
    const f = fixture({ 'pre-commit': '' });
    delete f.userEnv.LANG;
    Object.assign(f.userEnv, env);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'z\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const m = f.mark('pre-commit');
    ok(name, a && a.status === 'committed' && m && m.lang === lang && m.lcAll === lcAll, J({ a: a && a.status, m: m && { lang: m.lang, lcAll: m.lcAll } }));
    await s.close();
  }

  // ---- T4: a request with nothing to commit while hooks exist -> nothing, codex never launched
  {
    const f = fixture({ 'pre-commit': '' });
    const s = service(f);
    const a = await answer(s, ask(s, ['a.txt']));
    ok('T4 nothing to commit with hooks of a check -> nothing, no launch of codex, no mark', a && a.status === 'nothing' && s.launches.length === 0 && !f.mark('pre-commit'),
      J({ a, l: s.launches }));
    await s.close();
  }

  // ---- T5: the check sets the x bit of a named path -> the snapshot changed (mode)
  {
    const f = fixture({ 'pre-commit': 'chmod +x a.txt' });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'w\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('T5 pre-commit set the x bit of the named a.txt -> refused "the check changed the snapshot" with mode a.txt, the tip stays',
      a && a.status === 'refused' && /the check changed the snapshot/.test(a.why) && (a.changed || []).some((c) => c.path === 'a.txt' && c.kind === 'mode') && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- T6: a request that deletes a tracked path, with hooks: committed as a deletion; a check that recreates it
  // changes the snapshot
  {
    const f = fixture({ 'pre-commit': '' });
    const s = service(f);
    fs.rmSync(path.join(f.wt, 'gone.txt'));
    const a = await answer(s, ask(s, ['gone.txt']));
    ok('T6 a deletion named in the request, with a check -> committed without gone.txt',
      a && a.status === 'committed' && f.mark('pre-commit') && git(f.wt, ['cat-file', '-e', 'task:gone.txt']).rc !== 0 && f.tip() === a.sha, J(a));
    await s.close();
  }
  {
    const f = fixture({ 'pre-commit': 'echo back > gone.txt' });
    const s = service(f);
    fs.rmSync(path.join(f.wt, 'gone.txt'));
    const a = await answer(s, ask(s, ['gone.txt']));
    ok('T6 the check recreated the deleted gone.txt -> refused "the check changed the snapshot" with gone.txt, the tip stays, gone.txt as the hook left it',
      a && a.status === 'refused' && /the check changed the snapshot/.test(a.why) && (a.changed || []).some((c) => c.path === 'gone.txt') && f.tip() === f.h0
      && rd(path.join(f.wt, 'gone.txt')) === 'back\n', J(a));
    await s.close();
  }

  // ---- T7: close() while a hook runs and a second request waits -> both cancelled, the second hook never started
  {
    const f = fixture({ 'pre-commit': 'n=$(ls "$T" | grep -c "^run-")\necho $$ > "$T/run-$n"\ntrap \'exit 143\' TERM\nwhile :; do sleep 0.2; done' });
    const s = service(f, { pollMs: 200 });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), '1\n');
    const id1 = ask(s, ['a.txt']);
    const t0 = Date.now();
    while (!fs.existsSync(path.join(f.tdir, 'run-0')) && Date.now() - t0 < 20000) await sleep(50);
    const id2 = ask(s, ['a.txt'], 'second');
    await sleep(800);
    const pid = +rd(path.join(f.tdir, 'run-0'));
    const sum = await s.close();
    const a1 = readAnswer(s, id1), a2 = readAnswer(s, id2);
    const runs = fs.readdirSync(f.tdir).filter((n) => n.startsWith('run-'));
    ok('T7 close() with a running hook and a queued request -> both cancelled, one hook only, its process gone, the tip stays',
      a1 && a1.status === 'cancelled' && a2 && a2.status === 'cancelled' && runs.length === 1 && pid > 0 && !alive(pid) && sum.cancelled.length === 2 && f.tip() === f.h0,
      J({ a1, a2, runs, sum: sum && sum.cancelled }));
  }

  // ---- T8: hooks that are not executable are skipped as git skips them
  {
    const f = fixture({ 'pre-commit': '', 'commit-msg': '' }, { 'pre-commit': 0o644 });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'q\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('T8 a non-executable pre-commit next to an executable commit-msg -> only commit-msg runs', a && a.status === 'committed' && !f.mark('pre-commit') && f.mark('commit-msg')
      && (a.checks || []).map((c) => c.hook).join() === 'commit-msg', J(a));
    await s.close();
  }
  {
    const f = fixture({ 'pre-commit': 'echo hooked > b.txt' }, { 'pre-commit': 0o644 });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'q\n');
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'unnamed\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('T8 only a non-executable hook -> no check: the A2a-1 path, codex never launched, the unnamed change does not refuse',
      a && a.status === 'committed' && s.launches.length === 0 && !f.mark('pre-commit') && !a.checks, J({ a, l: s.launches }));
    await s.close();
  }
  done();
})().catch((e) => { ok('the tester cases ran to the end', false, e && e.stack); done(); });
