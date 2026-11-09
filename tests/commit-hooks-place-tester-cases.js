'use strict';
// The tester's cells of the hooks folder against the tip at the start of the call (p-codex A2a-3b, mechanism M1-B):
// the second pass (the gate before it, no false refusal), a second request of the call after its first commit, a path of
// the request in another case, the walk of the folder (a nested ignored file, an empty folder, a new link to a folder,
// a hook replaced by a link), the location changed by the global config, P0 that could not be computed, the limit of
// the walk. tests/commit-checks.test.js runs this file as a child with its own tally. Real git repositories in a
// temporary folder, the real codex sandbox without a model; every hook writes a mark into <task folder>/marks.
// Skipped without macOS, codex or git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the tester\'s cells of the hooks folder against the tip', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-hpt-')));
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
const HP = 'scripts/git-hooks';

let fixN = 0;
// A repository with a linked worktree on branch "task". The base commit tracks scripts/git-hooks (pre-commit that writes
// a mark, then o.body; notes.txt; o.extra: more files of the folder) and a .gitignore with *.local. o.hooksPath: the
// value of core.hooksPath (git config --worktree), null for none.
function fixture(o) {
  const x = o || {};
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'), home: path.join(d, 'home') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home']) fs.mkdirSync(f[k], { recursive: true });
  f.gitconfig = path.join(f.home, '.gitconfig');
  fs.writeFileSync(f.gitconfig, '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  f.marksDir = path.join(f.tdir, 'marks');
  f.hookText = (name, body) => `#!/bin/sh\nmkdir -p '${f.marksDir}' && echo ran >> '${path.join(f.marksDir, name)}' || exit 99\n${body || ''}\nexit 0\n`;
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(f.repo, '.gitignore'), '*.local\n');
  exe(path.join(f.repo, HP, 'pre-commit'), f.hookText('pre-commit', x.body));
  fs.writeFileSync(path.join(f.repo, HP, 'notes.txt'), 'notes\n');
  for (const [p, t] of Object.entries(x.extra || {})) { fs.mkdirSync(path.dirname(path.join(f.repo, HP, p)), { recursive: true }); fs.writeFileSync(path.join(f.repo, HP, p), t); }
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  f.wt = path.join(d, 'wt');
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.setHooksPath = (v) => {
    git(f.repo, ['config', 'extensions.worktreeConfig', 'true']);
    return git(f.wt, ['config', '--worktree', 'core.hooksPath', v]);
  };
  if (x.hooksPath !== null) f.setHooksPath(x.hooksPath || HP);
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, TMPDIR: f.rtmp };
  f.h0 = git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.marks = () => { try { return fs.readdirSync(f.marksDir).sort(); } catch { return []; } };
  f.ran = (name) => { try { return fs.readFileSync(path.join(f.marksDir, name), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  f.hp = path.join(f.wt, HP);
  return f;
}
let callN = 0;
const service = (f, inject, extra) => {
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  return openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'), stateDir: f.state, git: GIT,
    codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {}, inject: inject || {} }, extra || {}));
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
  const s = service(f, x.inject, x.service);
  if (x.before) x.before(f);
  fs.writeFileSync(path.join(f.wt, 'a.txt'), `change ${fixN}\n`);
  const a = await answer(s, put(s, ['a.txt'].concat(x.paths || [])));
  await s.close();
  return { a, marks: f.marks(), moved: f.tip() !== f.h0 };
};
const rp = (p) => fs.realpathSync(p);
const refused = (r) => r.a && r.a.status === 'refused' && !r.moved;
const differs = (f, kind, p) => (r) => refused(r) && r.a.why.includes(`the hooks folder ${path.join(rp(f.wt), HP)} differs from ${f.h0}:`) && r.a.why.includes(`${kind} ${p}`) && r.a.why.includes(OWNER);
const moved = (r) => refused(r) && /^the hooks location changed during the call \(/.test(r.a.why);
// a hook of pass 1 that upper-cases a.txt: pass 1 changes the snapshot, pass 2 changes nothing
const UPPER = 'tr a-z A-Z < a.txt > a.tmp && mv a.tmp a.txt';

(async () => {
  // ---- T1: a second pass with a tracked hooks folder equal to the tip: the gates before and after pass 2 do not refuse
  {
    const f = fixture({ body: UPPER });
    const r = await request(f);
    ok('T1 a hook that changes the request in pass 1 (H2 with a recheck): committed after two passes, the hook ran twice',
      r.a && r.a.status === 'committed' && r.moved && f.ran('pre-commit') === 2 && r.a.checks && r.a.checks.length === 2, J(r));
  }
  // ---- T2: a write into the hooks folder after the gate after pass 1, before pass 2 (the snapshot of pass 2)
  {
    const f = fixture({ body: UPPER });
    let n = 0;
    const r = await request(f, { inject: { afterSnapshot: () => { if (++n === 2) fs.writeFileSync(path.join(f.hp, 'late2.local'), 'x\n'); } } });
    ok('T2 a file written into the hooks folder after pass 1 and its gate, before pass 2: refused "added <path>" before the hooks of pass 2 (the hook ran once)',
      n === 2 && differs(f, 'added', `${HP}/late2.local`)(r) && f.ran('pre-commit') === 1, J({ r, n }));
  }
  // ---- T3: a second request of the call after its first commit: the folder is still compared with the tip at the start
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'one\n');
    const a1 = await answer(s, put(s, ['a.txt']));
    const t1 = f.tip();
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'two\n');
    const a2 = await answer(s, put(s, ['a.txt']));
    await s.close();
    ok('T3 two requests in one call: both committed, the hook ran for each, no false refusal after the branch moved',
      a1 && a1.status === 'committed' && a2 && a2.status === 'committed' && t1 !== f.h0 && f.tip() !== t1 && f.ran('pre-commit') === 2, J({ a1, a2 }));
  }
  // ---- T4: the request names a hook of the folder in another case (the disk ignores case)
  {
    const f = fixture();
    const r = await request(f, { paths: ['SCRIPTS/Git-Hooks/notes.txt'] });
    ok('T4 the request names an unchanged file of the folder in another case: refused "the request names ... in the hooks folder" with the owner\'s text, no hook ran',
      refused(r) && r.a.why.includes('the request names "SCRIPTS/Git-Hooks/notes.txt" in the hooks folder') && r.a.why.includes(OWNER) && !r.marks.length, J(r));
  }
  // ---- T5: an ignored file deep in a new subfolder of the folder
  {
    const f = fixture();
    const r = await request(f, { before: () => { fs.mkdirSync(path.join(f.hp, 'sub', 'deep'), { recursive: true }); fs.writeFileSync(path.join(f.hp, 'sub', 'deep', 'x.local'), 'x\n'); } });
    ok('T5 an ignored file in a new nested subfolder: refused "added <deep path>", no hook ran', differs(f, 'added', `${HP}/sub/deep/x.local`)(r) && !r.marks.length, J(r));
  }
  // ---- T6: an empty new subfolder holds no non-folder entry: no refusal
  {
    const f = fixture();
    const r = await request(f, { before: () => fs.mkdirSync(path.join(f.hp, 'empty'), { recursive: true }) });
    ok('T6 an empty new subfolder in the folder: committed, the hook ran (the compare is of non-folder entries)',
      r.a && r.a.status === 'committed' && r.marks.join() === 'pre-commit', J(r));
  }
  // ---- T7: a new link in the folder to a folder outside: an entry, not followed
  {
    const f = fixture();
    const out = path.join(f.d, 'outside');
    exe(path.join(out, 'pre-commit'), f.hookText('outside', ''));
    const r = await request(f, { before: () => fs.symlinkSync(out, path.join(f.hp, 'more')) });
    ok('T7 a new link in the folder to a folder outside: refused "added <link>" (not followed), no hook ran',
      differs(f, 'added', `${HP}/more`)(r) && !r.a.why.includes(`${HP}/more/`) && !r.marks.length, J(r));
  }
  // ---- T8: a tracked hook replaced by a link to a file with the same bytes and mode
  {
    const f = fixture();
    const same = path.join(f.d, 'same-pre-commit');
    const r = await request(f, { before: () => {
      fs.copyFileSync(path.join(f.hp, 'pre-commit'), same); fs.chmodSync(same, 0o755);
      fs.unlinkSync(path.join(f.hp, 'pre-commit')); fs.symlinkSync(same, path.join(f.hp, 'pre-commit'));
    } });
    ok('T8 a tracked hook replaced by a link to a file with its bytes: refused "modified <path>", no hook ran',
      differs(f, 'modified', `${HP}/pre-commit`)(r) && !r.marks.length, J(r));
  }
  // ---- T9: H8 through the global config of the role's HOME
  {
    const f = fixture({ hooksPath: null });
    const two = path.join(f.d, 'hooks-two');
    exe(path.join(two, 'pre-commit'), f.hookText('two', ''));
    exe(path.join(f.repo, '.git', 'hooks', 'pre-commit'), f.hookText('common', ''));
    const r = await request(f, { before: () => fs.appendFileSync(f.gitconfig, `[core]\n\thooksPath = ${two}\n`) });
    ok('T9 P0 = <common dir>/hooks, the global config of the role\'s HOME sets core.hooksPath during the call: refused "the hooks location changed", no hook ran',
      moved(r) && r.a.why.includes(path.join(f.repo, '.git', 'hooks')) && r.a.why.includes(two) && !r.marks.length, J(r));
  }
  // ---- T10: P0 could not be computed at the start: every request refuses, also after the cause is gone
  {
    const f = fixture();
    git(f.repo, ['config', 'hook.extra.command', 'true']);
    const r = await request(f, { before: () => git(f.repo, ['config', '--unset', 'hook.extra.command']) });
    ok('T10 a hook.* key at the start of the call, removed during it: refused "no safe check path: hooks named in the git config", no hook ran',
      refused(r) && r.a.why.startsWith('no safe check path: hooks named in the git config') && !r.marks.length, J(r));
  }
  // ---- T11: the walk of the folder stops at walkMaxEntries
  {
    const extra = {};
    for (let i = 0; i < 8; i++) extra[`f${i}.txt`] = `${i}\n`;
    const f = fixture({ extra });
    const r = await request(f, { service: { walkMaxEntries: 5 } });
    ok('T11 a hooks folder with more entries than walkMaxEntries: refused "the hooks folder ... has more than 5 entries", no hook ran',
      refused(r) && r.a.why === `no safe check path: the hooks folder ${rp(f.hp)} has more than 5 entries` && !r.marks.length, J(r));
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
