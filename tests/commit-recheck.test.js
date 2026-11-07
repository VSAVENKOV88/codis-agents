#!/usr/bin/env node
'use strict';
// The re-check, the untracked files, the paths of a request and the limits of the walk (p-codex A2a-2b), on real git
// repositories in a temporary folder and the real codex sandbox without a model. Cells of the analysis p-codex-A2
// section 7 and of its check, run 4: CK2-03, -03b..e, -04, -05, -05b, -07, -07b, -07c, -08, -08b, -09, -12, -12b..e,
// -13, -13b, -13c, EV-16, G7-02b, PA2-01..06, -03b, -04b. Marks of a hook lie in the task folder, not in the worktree:
// a mark in the worktree would itself be a change of an untracked file. Skipped without macOS, codex or git.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'scripts', 'commit-req.js');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the re-check and the walk of a commit under codex sandbox', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-re-')));
const kids = new Set();
process.on('exit', () => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
  // rm, not fs.rmSync: one cell leaves a tree deeper than PATH_MAX
  spawnSync('/bin/chmod', ['-R', 'u+rwx', BASE]);
  spawnSync('/bin/rm', ['-rf', BASE]);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args, input) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV, input, maxBuffer: 64 << 20 });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const exe = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); };
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN);

let fixN = 0;
function fixture(o) {
  const x = o || {};
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'),
    home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), hooks: path.join(d, 'hooks'), canary: path.join(d, 'canary') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'xdg', 'canary']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n' + (x.global || ''));
  git(f.repo, ['init', '-q', '-b', 'main']);
  for (const n of ['a.txt', 'b.txt', 'gen.txt', 'r1.txt', 'sub/c.txt']) {
    fs.mkdirSync(path.dirname(path.join(f.repo, n)), { recursive: true });
    fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  }
  for (const [n, body] of Object.entries(x.files || {})) {
    fs.mkdirSync(path.dirname(path.join(f.repo, n)), { recursive: true });
    fs.writeFileSync(path.join(f.repo, n), body);
  }
  git(f.repo, ['add', 'a.txt', 'b.txt', 'gen.txt', 'r1.txt', 'sub/c.txt'].concat(Object.keys(x.files || {})));
  if (x.force) git(f.repo, ['add', '-f'].concat(x.force));
  git(f.repo, ['commit', '-q', '-m', 'base']);
  f.wt = path.join(d, 'wt');
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.w = (n) => path.join(f.wt, n);
  f.hook = (name, body) => exe(path.join(f.hooks, name), `#!/bin/sh\nT='${f.tdir}'\nmkdir -p "$T/marks"; touch "$T/marks/${name}-$$"\n${body || ''}\nexit 0\n`);
  if (x.hooks) {
    for (const [n, b] of Object.entries(x.hooks)) f.hook(n, b);
    git(f.repo, ['config', 'core.hooksPath', f.hooks]);
  }
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg, TMPDIR: f.rtmp };
  f.h0 = git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.marks = (n) => { try { return fs.readdirSync(path.join(f.tdir, 'marks')).filter((m) => !n || m.startsWith(`${n}-`)); } catch { return []; } };
  return f;
}
let callN = 0;
function service(f, extra) {
  const launches = [], walks = [];
  const e = extra || {};
  const inject = Object.assign({}, e.inject || {});
  const userLaunch = inject.checkLaunch, userWalk = inject.walkLaunch;
  inject.checkLaunch = (spec) => { launches.push(spec.kind); return userLaunch ? userLaunch(spec) : spec; };
  inject.walkLaunch = (spec) => { walks.push(spec.kind); return userWalk ? userWalk(spec) : spec; };
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  const s = openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'),
    stateDir: f.state, git: GIT, codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {} }, e, { inject }));
  s.launches = launches;
  s.walks = walks;
  return s;
}
function put(box, body) {
  const id = newId();
  const tmp = path.join(box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(box, `${id}.json`));
  return id;
}
const ask = (s, paths, message) => put(s.box, { paths, message: message || 'msg' });
async function answer(s, id, ms) {
  const end = Date.now() + (ms || 30000);
  for (;;) { const a = readJson(path.join(s.answers, `${id}.json`)); if (a || Date.now() > end) return a; await sleep(25); }
}
const waitFile = async (p, ms) => { const t0 = Date.now(); while (!fs.existsSync(p) && Date.now() - t0 < (ms || 30000)) await sleep(25); return fs.existsSync(p); };
const kindsOf = (a) => ((a && a.changed) || []).map((c) => `${c.kind}${c.from ? ` ${c.from} ->` : ''}${c.path ? ` ${c.path}` : ''}`).sort();
const has1 = (a, ...want) => want.every((k) => kindsOf(a).includes(k));
const show = (f, spec) => git(f.wt, ['show', spec]).out;
// a preload for the walk process: a blocked file call, a replaced folder, its pid in a file
const preload = (name, body) => { const p = path.join(BIN, name); fs.writeFileSync(p, `const fs=require('fs');\n${body}\n`); return p; };
const withPreload = (p, env) => (spec) => Object.assign({}, spec, { args: ['--require', p].concat(spec.args), env: Object.assign({}, spec.env, env || {}) });

(async () => {
  // ---- CK2-03: the first pass rewrites the named path (generation), the second leaves it
  {
    const f = fixture({ hooks: { 'pre-commit': 'cat a.txt > gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'source\n');
    fs.writeFileSync(f.w('gen.txt'), 'stale\n');
    const a = await answer(s, ask(s, ['a.txt', 'gen.txt']));
    ok('CK2-03 pass 1 rewrote the named gen.txt, pass 2 left it -> committed with the bytes after pass 1, rechecked, changed [gen.txt], two marks',
      a && a.status === 'committed' && a.rechecked === true && kindsOf(a).some((k) => / gen\.txt$/.test(k)) && show(f, 'task:gen.txt') === 'source' && f.marks('pre-commit').length === 2, J(a));
    ok('CK2-03 checks name both passes', a && (a.checks || []).map((c) => c.pass).join() === '1,2', J(a && a.checks));
    await s.close();
  }
  // ---- CK2-03b: pass 1 returned the named path to H0: the new tree is the parent's
  {
    const f = fixture({ hooks: { 'pre-commit': "printf 'gen.txt\\n' > gen.txt" } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const a = await answer(s, ask(s, ['gen.txt']));
    ok('CK2-03b pass 1 returned the named path to its content in H0 -> nothing, no empty commit, no second pass', a && a.status === 'nothing' && f.tip() === f.h0 && f.marks('pre-commit').length === 1, J(a));
    await s.close();
  }
  // ---- CK2-03c: pass 2 fails
  {
    const f = fixture({ hooks: { 'pre-commit': 'if [ -f "$T/p1" ]; then echo pass-two-fails >&2; exit 5; fi\ntouch "$T/p1"\necho one > gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const a = await answer(s, ask(s, ['gen.txt']));
    const last = a && a.checks && a.checks[a.checks.length - 1];
    ok('CK2-03c pass 2 rc 5 -> refused, its check has pass 2 and its output, the file as pass 1 left it, the tip stays',
      a && a.status === 'refused' && /pre-commit failed \(rc 5\)/.test(a.why) && last && last.pass === 2 && /pass-two-fails/.test(last.tail) && rd(f.w('gen.txt')) === 'one\n' && f.tip() === f.h0, J(a));
    await s.close();
  }
  // ---- CK2-03d: the call ends during pass 2
  {
    const f = fixture({ hooks: { 'pre-commit': 'if [ -f "$T/p1" ]; then touch "$T/in2"; while :; do sleep 0.2; done; fi\ntouch "$T/p1"\necho one > gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const id = ask(s, ['gen.txt']);
    const got = await waitFile(path.join(f.tdir, 'in2'));
    const sum = await s.close();
    const a = await answer(s, id, 2000);
    ok('CK2-03d the call ended during pass 2 -> cancelled, no intent, the tip stays', got && a && a.status === 'cancelled' && sum.cancelled.includes(id) && f.tip() === f.h0
      && !/"ev":"intent"/.test(rd(path.join(f.state, 'K', 'commits.jsonl'))), J(a));
  }
  // ---- CK2-03e: pass 1 replaced the named path by a FIFO, by a link
  {
    const f = fixture({ hooks: { 'pre-commit': 'rm gen.txt; mkfifo gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const t0 = Date.now();
    const a = await answer(s, ask(s, ['gen.txt']));
    ok('CK2-03e pass 1 replaced the named path by a FIFO -> refused "not a regular file" without hanging', a && a.status === 'refused' && /not a regular file/.test(a.why) && f.tip() === f.h0 && Date.now() - t0 < 25000, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '[ -L gen.txt ] || { rm gen.txt; ln -s a.txt gen.txt; }' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const a = await answer(s, ask(s, ['gen.txt']));
    ok('CK2-03e pass 1 replaced the named path by a link -> pass 2, committed as a link entry (mode 120000, the text of the link)',
      a && a.status === 'committed' && a.rechecked === true && /^120000 /.test(git(f.wt, ['ls-tree', 'task', 'gen.txt']).out) && show(f, 'task:gen.txt') === 'a.txt', J(a));
    await s.close();
  }

  // ---- CK2-04: not stable
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo tick >> gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'role\n');
    const a = await answer(s, ask(s, ['gen.txt']));
    ok('CK2-04 every pass appends to the named gen.txt -> refused "the check is not stable" with gen.txt, the tip stays, the file as pass 2 left it',
      a && a.status === 'refused' && /the check is not stable/.test(a.why) && kindsOf(a).some((k) => / gen\.txt$/.test(k)) && f.tip() === f.h0 && rd(f.w('gen.txt')) === 'role\ntick\ntick\n'
      && f.marks('pre-commit').length === 2, J(a));
    await s.close();
  }

  // ---- CK2-05, CK2-05b: the message is part of the snapshot, compared after stripspace
  {
    const f = fixture({ hooks: { 'prepare-commit-msg': 'grep -q "^\\[pfx\\]" "$1" || { printf "[pfx] " | cat - "$1" > "$T/m.n" && cat "$T/m.n" > "$1"; }' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt'], 'the message'));
    ok('CK2-05 an idempotent prefix in prepare-commit-msg -> pass 2, the commit has the prefix once', a && a.status === 'committed' && a.rechecked === true && kindsOf(a).includes('message')
      && git(f.wt, ['log', '-1', '--format=%s', 'task']).out === '[pfx] the message', J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'prepare-commit-msg': 'printf "[pfx] " | cat - "$1" > "$T/m.n" && cat "$T/m.n" > "$1"' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt'], 'the message'));
    ok('CK2-05 a prefix added every time -> refused "not stable", changed [message]', a && a.status === 'refused' && /not stable/.test(a.why) && kindsOf(a).includes('message') && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'commit-msg': ': > "$1"' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt'], 'the message'));
    ok('CK2-05b a hook emptied the message -> refused, no commit with an empty message', a && a.status === 'refused' && /empty/.test(a.why) && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'commit-msg': 'printf "\\n\\n" >> "$1"' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt'], 'the message'));
    ok('CK2-05b a hook added only blank lines -> equal after stripspace: committed without a second pass', a && a.status === 'committed' && a.rechecked !== true && f.marks('commit-msg').length === 1
      && git(f.wt, ['log', '-1', '--format=%B', 'task']).out === 'the message', J(a));
    await s.close();
  }

  // ---- CK2-07: untracked changes of the check
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo n > new.txt; echo more >> scratch.txt; rm -f old.tmp' } });
    fs.writeFileSync(f.w('scratch.txt'), 'before\n');
    fs.writeFileSync(f.w('old.tmp'), 'old\n');
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-07 the check created, changed and removed untracked files -> refused with the three paths and their kinds, the files as it left them',
      a && a.status === 'refused' && /changed outside the request during the check \(by the check or the role\)/.test(a.why) && has1(a, 'created new.txt', 'modified scratch.txt', 'deleted old.tmp')
      && rd(f.w('new.txt')) === 'n\n' && !fs.existsSync(f.w('old.tmp')) && f.tip() === f.h0, J(a));
    await s.close();
  }
  // ---- CK2-07b: a hook hides its own changes with a .gitignore
  {
    const f = fixture({ hooks: { 'pre-commit': 'mkdir -p hid; printf "*\\n" > hid/.gitignore; echo e > hid/evil; echo more >> scratch.txt; printf "*\\n" > .gitignore' } });
    fs.writeFileSync(f.w('scratch.txt'), 'before\n');
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-07b a hook that ignores its own changes -> refused: the class is by the ignore rules before the pass, each .gitignore is a change',
      a && a.status === 'refused' && has1(a, 'created hid/.gitignore', 'created hid/evil', 'modified scratch.txt', 'created .gitignore') && !(a.ignoredChanged || []).includes('scratch.txt') && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'printf "x\\n" >> u/.gitignore' }, files: { '.gitignore': 'u/\n' } });
    fs.mkdirSync(f.w('u'));
    fs.writeFileSync(f.w('u/.gitignore'), '# ignored itself\n');
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-07b a changed untracked .gitignore under an ignored folder is itself a change', a && a.status === 'refused' && has1(a, 'modified u/.gitignore'), J(a));
    await s.close();
  }
  // ---- CK2-07c: U holds no folders and no named paths
  {
    const f = fixture({ hooks: { 'pre-commit': 'mkdir -p newdir emptydir; cat a.txt > newdir/.t; mv newdir/.t newdir/gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    fs.mkdirSync(f.w('newdir'));
    fs.writeFileSync(f.w('newdir/gen.txt'), 'stale\n');
    const a = await answer(s, ask(s, ['a.txt', 'newdir/gen.txt']));
    ok('CK2-07c pass 1 rewrote a new named file by a rename and made an empty folder -> a re-check, not a change outside the request; untrackedInputs without the named path',
      a && a.status === 'committed' && a.rechecked === true && show(f, 'task:newdir/gen.txt') === 'x' && !(a.untrackedInputs || []).includes('newdir/gen.txt') && Array.isArray(a.untrackedInputs), J(a));
    await s.close();
  }

  // ---- CK2-08: only ignored files changed
  {
    const f = fixture({ hooks: { 'pre-commit': 'mkdir -p .cache dist; echo 1 >> .cache/x; echo 2 >> dist/y' }, files: { '.gitignore': '.cache/\ndist/\n' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-08 the check changed only ignored files -> committed, ignoredChanged names them', a && a.status === 'committed' && J(a.ignoredChanged) === J(['.cache/x', 'dist/y']) && a.ignoredChangedCount === 2, J(a));
    await s.close();
  }
  // ---- CK2-08b: long lists: first 200, a count, the whole list in a file of the adapter, only counts in the journal
  {
    const gen = path.join(BIN, 'gen50k.js');
    fs.writeFileSync(gen, "const fs=require('fs');fs.mkdirSync('build/p',{recursive:true});for(let i=0;i<50000;i++)fs.writeFileSync('build/p/f'+i,'x');");
    const f = fixture({ hooks: { 'pre-commit': `node '${gen}'` }, files: { '.gitignore': 'build/\n' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const id = ask(s, ['a.txt']);
    const a = await answer(s, id, 90000);
    const full = a && a.changesFile ? readJson(a.changesFile) : null;
    ok('CK2-08b 50 000 ignored files changed -> committed, ignoredChanged the first 200, the count, the whole list in <id>.changes.json of the adapter',
      a && a.status === 'committed' && (a.ignoredChanged || []).length === 200 && a.ignoredChangedCount === 50000 && full && full.ignoredChanged.length === 50000
      && path.basename(a.changesFile) === `${id}.changes.json` && !a.changesFile.startsWith(f.wt) && !a.changesFile.startsWith(f.tdir), J(a && { n: a.ignoredChanged && a.ignoredChanged.length, c: a.ignoredChangedCount, f: a.changesFile }));
    const lines = rd(path.join(f.state, 'K', 'commits.jsonl')).split('\n').filter(Boolean);
    const res = lines.map((l) => JSON.parse(l)).find((e) => e.ev === 'result' && e.id === id);
    ok('CK2-08b the journal holds only the count', res && res.ignoredChangedCount === 50000 && !res.ignoredChanged && Math.max(...lines.map((l) => l.length)) < 200000, J(res && Object.keys(res)));
    await s.close();
  }
  {
    const gen = path.join(BIN, 'gen1k.js');
    fs.writeFileSync(gen, "const fs=require('fs');for(let i=0;i<1000;i++)fs.writeFileSync('n'+i+'.u','x');");
    const f = fixture({ hooks: { 'pre-commit': `node '${gen}'` } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const full = a && a.changesFile ? readJson(a.changesFile) : null;
    ok('CK2-08b a refusal with 1000 changes: changed the first 200, changedCount, the whole list in the file', a && a.status === 'refused' && (a.changed || []).length === 200 && a.changedCount === 1000
      && full && full.changed.length === 1000 && a.why.length < 3000, J(a && { n: a.changed && a.changed.length, c: a.changedCount }));
    await s.close();
  }

  // ---- CK2-09: the role, not the hook, edits during a pass
  {
    const f = fixture({ hooks: { 'pre-commit': 'touch "$T/in"; while [ ! -f "$T/go" ]; do sleep 0.05; done' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'first\n');
    const id = ask(s, ['gen.txt']);
    await waitFile(path.join(f.tdir, 'in'));
    fs.writeFileSync(f.w('gen.txt'), 'edited by the role\n');
    fs.writeFileSync(path.join(f.tdir, 'go'), '');
    const a = await answer(s, id);
    ok('CK2-09 the role edited a named path during a pass -> a re-check, the commit has its bytes', a && a.status === 'committed' && a.rechecked === true && show(f, 'task:gen.txt') === 'edited by the role', J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'touch "$T/in"; while [ ! -f "$T/go" ]; do sleep 0.05; done' } });
    const s = service(f);
    fs.writeFileSync(f.w('gen.txt'), 'first\n');
    const id = ask(s, ['gen.txt']);
    await waitFile(path.join(f.tdir, 'in'));
    fs.writeFileSync(f.w('b.txt'), 'edited by the role\n');
    fs.writeFileSync(path.join(f.tdir, 'go'), '');
    const a = await answer(s, id);
    ok('CK2-09 the role edited an unnamed tracked path during a pass -> refused "(by the check or the role)" with it', a && a.status === 'refused' && /by the check or the role/.test(a.why) && has1(a, 'modified b.txt') && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- CK2-12: a compare through the filter of the repository, inside the sandbox
  const filterScript = (f, extra) => {
    const p = path.join(f.d, 'flt.sh');
    exe(p, `#!/bin/sh\nmkdir -p '${f.tdir}/fm'; echo "\${CODEX_SANDBOX:-none}" > '${f.tdir}/fm/'$$\n${extra || ''}\ntr A-Z a-z\n`);
    return p;
  };
  const filterMarks = (f) => { try { return fs.readdirSync(path.join(f.tdir, 'fm')).map((n) => rd(path.join(f.tdir, 'fm', n)).trim()); } catch { return []; } };
  for (const where of ['local', 'global']) {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitattributes': '*.dat filter=x\n', 'f.dat': 'blob\n', 'g.dat': 'other\n' } });
    const flt = filterScript(f);
    if (where === 'local') git(f.repo, ['config', 'filter.x.clean', flt]);
    else fs.appendFileSync(path.join(f.home, '.gitconfig'), `[filter "x"]\n\tclean = ${flt}\n`);
    const s = service(f);
    fs.writeFileSync(f.w('f.dat'), 'BLOB\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const fm = filterMarks(f);
    ok(`CK2-12 ${where} filter: raw bytes differ, the cleaned ones equal the blob -> not a change, committed; the filter ran only inside the sandbox`,
      a && a.status === 'committed' && fm.length > 0 && fm.every((m) => m === 'seatbelt') && s.launches.includes('hash'), J({ a, fm, l: s.launches }));
    fs.writeFileSync(f.w('g.dat'), 'CHANGED\n');
    fs.writeFileSync(f.w('a.txt'), 'y\n');
    const b = await answer(s, ask(s, ['a.txt']));
    ok(`CK2-12 ${where} filter: the cleaned bytes differ -> refused with g.dat, before the hook`, b && b.status === 'refused' && /tracked changes outside the request/.test(b.why) && has1(b, 'modified g.dat')
      && !kindsOf(b).some((k) => /f\.dat/.test(k)), J(b));
    await s.close();
  }
  // ---- CK2-12b: a named path with a conversion
  for (const [name, attr] of [['text', 'a.txt text\n'], ['eol', 'a.txt eol=lf\n'], ['filter', 'a.txt filter=x\n'], ['ident', 'a.txt ident\n'], ['working-tree-encoding', 'a.txt working-tree-encoding=UTF-16\n']]) {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.writeFileSync(f.w('.gitattributes'), attr);
    git(f.wt, ['add', '.gitattributes']);
    git(f.wt, ['commit', '-q', '-m', 'attributes']);
    f.h0 = f.tip();
    const s = service(f);
    const bytes = `unique-bytes-of-${name}\r\n`;
    fs.writeFileSync(f.w('a.txt'), bytes);
    const a = await answer(s, ask(s, ['a.txt']));
    const blob = git(f.wt, ['hash-object', '--no-filters', '--stdin'], bytes).out;
    ok(`CK2-12b a named path with the attribute ${name} -> refused with its path before the hooks, no raw commit`, a && a.status === 'refused' && /conversion/.test(a.why) && /a\.txt/.test(a.why) && new RegExp(name).test(a.why)
      && f.marks().length === 0 && f.tip() === f.h0, J(a));
    ok(`CK2-12b ${name}: the tip has no raw blob`, git(f.wt, ['ls-tree', 'task', 'a.txt']).out.indexOf(blob) < 0);
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, global: '[core]\n\tautocrlf = true\n' });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\r\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-12b a named path under the global core.autocrlf -> refused with its path', a && a.status === 'refused' && /conversion/.test(a.why) && /core\.autocrlf/.test(a.why) && /a\.txt/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f);
    fs.writeFileSync(f.w('.gitattributes'), 'a.txt filter=x\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['.gitattributes', 'a.txt']));
    ok('CK2-12b a .gitattributes named in the same request counts: a.txt has a conversion by it -> refused', a && a.status === 'refused' && /conversion/.test(a.why) && /a\.txt/.test(a.why), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    git(f.repo, ['config', 'core.eol', 'crlf']);
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-12b core.eol alone converts nothing (git-config: it applies to paths with the text attribute) -> committed', a && a.status === 'committed', J(a));
    await s.close();
  }
  // ---- CK2-12c: a global core.autocrlf reaches the compare inside the sandbox
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, global: '[core]\n\tautocrlf = true\n', files: { '.gitattributes': 'n.bin -text\n', 'n.bin': 'n\n', 'crlf.txt': 'one\ntwo\n' } });
    const s = service(f);
    fs.writeFileSync(f.w('crlf.txt'), 'one\r\ntwo\r\n');
    fs.writeFileSync(f.w('n.bin'), 'named\n');
    const a = await answer(s, ask(s, ['n.bin']));
    ok('CK2-12c global core.autocrlf, an unnamed CRLF file whose blob has LF -> not a change, committed', a && a.status === 'committed' && s.launches.includes('hash'), J({ a, l: s.launches }));
    await s.close();
  }
  // ---- CK2-12d: the sandbox is ready before the first filter runs
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitattributes': '*.dat filter=x\n', 'f.dat': 'blob\n' } });
    git(f.repo, ['config', 'filter.x.clean', filterScript(f)]);
    const stub = path.join(BIN, 'codex165');
    exe(stub, '#!/bin/sh\necho "codex-cli 0.165.0"\n');
    const s = service(f, { codex: stub });
    fs.writeFileSync(f.w('f.dat'), 'BLOB\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-12d codex 0.165.0 and a repository with a filter -> refused "no safe check path", the filter never ran, no launch but --version',
      a && a.status === 'refused' && /no safe check path: codex 0\.165\.0/.test(a.why) && filterMarks(f).length === 0 && s.launches.join() === 'version', J({ a, l: s.launches }));
    await s.close();
  }
  // ---- CK2-12e: the channel of the hash
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitattributes': '*.dat filter=x\n', 'f.dat': 'blob\n' } });
    const id40 = git(f.wt, ['rev-parse', 'task:f.dat']).out;
    git(f.repo, ['config', 'filter.x.clean', filterScript(f, `echo ${id40} >&2`)]);
    const s = service(f);
    fs.writeFileSync(f.w('f.dat'), 'CHANGED\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-12e the id of the blob on the stderr of the filter is not the answer -> refused with f.dat', a && a.status === 'refused' && has1(a, 'modified f.dat'), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitattributes': '*.dat filter=x\n', 'f.dat': 'blob\n' } });
    git(f.repo, ['config', 'filter.x.clean', filterScript(f)]);
    const s = service(f, { inject: { checkLaunch: (spec) => (spec.kind === 'hash' ? Object.assign({}, spec, { bin: '/usr/bin/true', args: [] }) : spec) } });
    fs.writeFileSync(f.w('f.dat'), 'BLOB\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-12e an empty answer of the hash with rc 0 -> refused "no safe check path"', a && a.status === 'refused' && /no safe check path/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitattributes': '*.dat filter=x\n', 'f.dat': 'blob\n' } });
    git(f.repo, ['config', 'filter.x.clean', filterScript(f)]);
    let swapped = false;
    const s = service(f, { inject: { checkLaunch: (spec) => {
      if (spec.kind === 'hash') { fs.rmSync(f.w('f.dat')); spawnSync('mkfifo', [f.w('f.dat')]); swapped = true; }
      return spec;
    } } });
    fs.writeFileSync(f.w('f.dat'), 'BLOB\n');
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const id = ask(s, ['a.txt']);
    const end = Date.now() + 20000;
    while (!swapped && Date.now() < end) await sleep(25);
    await sleep(400);
    const t0 = Date.now();
    await s.close();
    const a = await answer(s, id, 2000);
    ok('CK2-12e the path swapped for a FIFO before the hash: the hanging hash is stopped like a check at the end of the call -> cancelled', swapped && a && a.status === 'cancelled' && Date.now() - t0 < 8000 && f.tip() === f.h0, J(a));
  }

  // ---- CK2-13: FIFO, socket, a loop of links, a folder without rights
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    spawnSync('mkfifo', [f.w('sub/pipe')]);
    const cwd = process.cwd();
    process.chdir(f.w('sub'));
    const srv = net.createServer();
    await new Promise((r) => srv.listen('sock', r));
    process.chdir(cwd);
    fs.symlinkSync('loop', f.w('loop'));
    fs.mkdirSync(f.w('noperm'));
    fs.writeFileSync(f.w('noperm/hidden'), 'h');
    fs.chmodSync(f.w('noperm'), 0);
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    fs.chmodSync(f.w('noperm'), 0o755);
    srv.close();
    ok('CK2-13 a FIFO, a socket, a loop of links: the walk ends, they are listed in untrackedInputs (the walk saw them), committed',
      a && a.status === 'committed' && ['sub/pipe', 'sub/sock', 'loop'].every((p) => (a.untrackedInputs || []).includes(p)), J(a));
    ok('CK2-13 a folder without rights: a note in the answer, its contents are not compared', a && (a.walkNotes || []).some((n) => /noperm/.test(n)) && !(a.untrackedInputs || []).includes('noperm/hidden'), J(a && a.walkNotes));
    await s.close();
  }

  // ---- CK2-13b: the limits of the walk (owner 2026-11-07): the process, any limit refuses
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    for (let i = 0; i < 30; i++) fs.writeFileSync(f.w(`u${i}.txt`), 'u');
    const s = service(f, { walkMaxEntries: 20 });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b above commit.walkMaxEntries before the hooks -> refused "no safe check path", "walked N", "did not finish", the hooks did not run, no partial list',
      a && a.status === 'refused' && /no safe check path/.test(a.why) && /walked \d+/.test(a.why) && /did not finish/.test(a.why) && f.marks().length === 0 && !a.untrackedInputs && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'i=0; while [ $i -lt 40 ]; do echo u > n$i.u; i=$((i+1)); done' } });
    const s = service(f, { walkMaxEntries: 25 });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b above the limit after the hooks -> refused, what the hooks made stays visible, the tip stays', a && a.status === 'refused' && /no safe check path/.test(a.why) && /did not finish/.test(a.why)
      && fs.existsSync(f.w('n39.u')) && f.marks('pre-commit').length === 1 && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.mkdirSync(f.w('ig'));
    fs.writeFileSync(f.w('ig/.gitignore'), `${'#'.repeat(4000)}\n`);
    const s = service(f, { walkMaxIgnoreBytes: 1000 });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b above the total of ignore files -> refused, the hooks did not run', a && a.status === 'refused' && /no safe check path/.test(a.why) && /ignore/.test(a.why) && /did not finish/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    for (let i = 0; i < 30; i++) fs.writeFileSync(f.w(`long-name-of-an-untracked-file-${i}.txt`), 'u');
    const s = service(f, { walkMaxResultBytes: 400 });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b above the volume of results -> refused, the hooks did not run', a && a.status === 'refused' && /no safe check path/.test(a.why) && /results/.test(a.why) && /did not finish/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const pidf = path.join(f.d, 'walker.pid');
    const fifo = path.join(f.d, 'hang');
    spawnSync('mkfifo', [fifo]);
    const p = preload('hang.js', `const o=fs.opendirSync;fs.opendirSync=(...a)=>{fs.writeFileSync(process.env.PIDF,String(process.pid));fs.readFileSync(process.env.HANG);return o(...a);};`);
    const s = service(f, { walkTimeoutMs: 700, inject: { walkLaunch: withPreload(p, { PIDF: pidf, HANG: fifo }) } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const t0 = Date.now();
    const a = await answer(s, ask(s, ['a.txt']));
    const pid = +rd(pidf);
    await sleep(200);
    ok('CK2-13b a file call of the walk hangs -> the timeout removes the process, refused "no safe check path", walked N, did not finish, the hooks did not run',
      a && a.status === 'refused' && /no safe check path/.test(a.why) && /walked \d+/.test(a.why) && /did not finish/.test(a.why) && pid > 0 && !alive(pid) && f.marks().length === 0 && Date.now() - t0 < 15000, J({ a, pid }));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    let n = 0;
    const s = service(f, { inject: { walkLaunch: (spec) => { n++; return Object.assign({}, spec, { args: ['-e', "process.stdout.write('{\"ok\":true,\"files\":[]}\\n');process.exit(7)"] }); } } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b a crash of the walk process (rc 7, even after a whole answer) -> refused, no hooks', n === 1 && a && a.status === 'refused' && /no safe check path/.test(a.why) && /rc 7/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { walkMaxResultBytes: 1000, inject: { walkLaunch: (spec) => Object.assign({}, spec, { args: ['-e', "process.stdout.write('{\"ok\":true,\"visited\":1,\"files\":[],\"pad\":\"'+'x'.repeat(5000000)+'\"}\\n')"] }) } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b the output of the walk above its limit is not read -> refused', a && a.status === 'refused' && /no safe check path/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { inject: { walkLaunch: (spec) => Object.assign({}, spec, { bin: path.join(f.d, 'no-such-node') }) } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b the walk process cannot start -> refused', a && a.status === 'refused' && /no safe check path/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  // a folder replaced by a link during the walk: the walk does not go behind the link
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const outside = path.join(f.canary, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret-name'), 's');
    fs.mkdirSync(f.w('swap'));
    fs.writeFileSync(f.w('swap/own'), 'o');
    const p = preload('swap.js', `const o=fs.opendirSync;fs.opendirSync=(d,...r)=>{if(d===process.env.SWAP){fs.renameSync(d,d+'.real');fs.symlinkSync(process.env.OUT,d);}return o(d,...r);};`);
    const s = service(f, { inject: { walkLaunch: withPreload(p, { SWAP: f.w('swap'), OUT: outside }) } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13b a folder replaced by a link during the walk -> refused, "did not finish", nothing behind the link in the answer, no hooks',
      a && a.status === 'refused' && /no safe check path/.test(a.why) && /replaced/.test(a.why) && /did not finish/.test(a.why) && !/secret-name/.test(JSON.stringify(a)) && f.marks().length === 0, J(a));
    await s.close();
  }
  // the end of the call and SIGTERM of the adapter remove the walk
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const pidf = path.join(f.d, 'walker.pid');
    const p = preload('spin.js', `const o=fs.opendirSync;fs.opendirSync=(...a)=>{fs.writeFileSync(process.env.PIDF,String(process.pid));for(;;);return o(...a);};`);
    const s = service(f, { walkTimeoutMs: 60000, inject: { walkLaunch: withPreload(p, { PIDF: pidf }) } });
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const id = ask(s, ['a.txt']);
    const got = await waitFile(pidf);
    const pid = +rd(pidf);
    const t0 = Date.now();
    const sum = await s.close();
    const a = await answer(s, id, 2000);
    await sleep(200);
    ok('CK2-13b the end of the call during the walk -> the walk process is gone, cancelled, at once', got && a && a.status === 'cancelled' && sum.cancelled.includes(id) && !alive(pid) && Date.now() - t0 < 3000, J({ a, pid }));
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const pidf = path.join(f.d, 'walker.pid');
    const p = preload('spin2.js', `const o=fs.opendirSync;fs.opendirSync=(...a)=>{fs.writeFileSync(process.env.PIDF,String(process.pid));for(;;);return o(...a);};`);
    const role = path.join(BIN, 'role.js');
    fs.writeFileSync(role, `const fs=require('fs'),path=require('path');const {spawn}=require('child_process');
fs.writeFileSync(path.join(process.argv[2],'a.txt'),'from the role\\n');
spawn(process.execPath,[${JSON.stringify(CLIENT)},'-m','m','--','a.txt'],{stdio:'ignore'});
setInterval(()=>{},1000);
`);
    const driver = path.join(BIN, 'driver.js');
    fs.writeFileSync(driver, `const a=JSON.parse(process.argv[2]);const {createAgent,spawnRole}=require(${JSON.stringify(path.join(ROOT, 'scripts', 'role-exec.js'))});
const wl=(spec)=>Object.assign({},spec,{args:['--require',a.preload].concat(spec.args),env:Object.assign({},spec.env,{PIDF:a.pidf})});
const agent=createAgent({host:'codex',callsDir:a.callsDir,pluginRoot:${JSON.stringify(ROOT)},log:()=>{},codex:{home:a.chome,catalog:a.catalog,bin:a.codex},
 env:a.env,tasks:{K:{dir:a.tdir,wt:a.wt,branch:'task'}},commit:{stateDir:a.state,git:a.git,walkTimeoutMs:60000,inject:{walkLaunch:wl}},ceilingMs:120000,killGraceMs:1500,
 launch:(plan)=>spawnRole(Object.assign({},plan,{bin:process.execPath,argv:[a.role,a.wt]}),{ceilingMs:120000,graceMs:1500})});
agent('x',{label:'prog:K#1',schema:{type:'object',properties:{status:{type:'string'}},required:['status']},agentType:'general-purpose'}).then(()=>process.stdout.write('done\\n'));
`);
    const chome = path.join(f.d, 'chome');
    fs.mkdirSync(chome);
    const catalog = readJson(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'));
    const c = spawn(process.execPath, [driver, JSON.stringify({ callsDir: path.join(f.d, 'calls'), chome, catalog, codex: CODEX, env: Object.assign({}, process.env, f.userEnv), tdir: f.tdir, wt: f.wt,
      state: f.state, git: GIT, role, preload: p, pidf })], { stdio: 'ignore' });
    kids.add(c.pid);
    const ended = new Promise((r) => c.on('exit', (rc, sig) => r({ rc, sig })));
    const got = await waitFile(pidf);
    const pid = +rd(pidf);
    c.kill('SIGTERM');
    const ex = await Promise.race([ended, sleep(20000).then(() => null)]);
    await sleep(200);
    let rec = null;
    try { rec = JSON.parse(rd(path.join(f.tdir, 'calls.jsonl')).trim().split('\n').pop()); } catch { /* below */ }
    ok('CK2-13b SIGTERM of the adapter during the walk -> outcome signalled, the walk process is gone, the request cancelled', got && ex && rec && rec.outcome === 'signalled' && rec.commit && rec.commit.cancelled.length === 1 && !alive(pid) && f.tip() === f.h0, J({ ex, pid, o: rec && rec.outcome, c: rec && rec.commit }));
  }

  // ---- CK2-13c: a path deeper than the system's limit
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const cwd = process.cwd();
    process.chdir(f.wt);
    for (let i = 0; i < 8; i++) { fs.mkdirSync('d'.repeat(200)); process.chdir('d'.repeat(200)); }
    fs.writeFileSync('deep.txt', 'deep');
    process.chdir(cwd);
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-13c a path deeper than 1024 bytes -> refused with the path, did not finish, no crash of the request, no hooks',
      a && a.status === 'refused' && /no safe check path/.test(a.why) && /did not finish/.test(a.why) && /dddd/.test(a.why) && !/internal error/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }

  // ---- EV-16: untracked inputs are named, not part of the commit
  {
    const f = fixture({ hooks: { 'pre-commit': 'cat notes.txt node_modules/x sub/ig/.gitignore > /dev/null' }, files: { '.gitignore': 'node_modules/\n' } });
    fs.writeFileSync(f.w('notes.txt'), 'n\n');
    fs.mkdirSync(f.w('node_modules'));
    fs.writeFileSync(f.w('node_modules/x'), 'x\n');
    fs.mkdirSync(f.w('sub/ig'));
    fs.writeFileSync(f.w('sub/ig/.gitignore'), '*\n');
    fs.writeFileSync(f.w('sub/ig/hidden'), 'h\n');
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-16 committed; untrackedInputs names notes.txt and the untracked .gitignore that hides itself, not node_modules/x or what it hides; the commit has no untracked file',
      a && a.status === 'committed' && J(a.untrackedInputs) === J(['notes.txt', 'sub/ig/.gitignore']) && a.untrackedInputsCount === 2 && git(f.wt, ['cat-file', '-e', 'task:notes.txt']).rc !== 0, J(a));
    ok('EV-16 environment: reads and untracked as the analysis names them, the write roots hold the message folder of the last pass', a && a.environment && a.environment.untracked === 'not part of the commit'
      && a.environment.reads === 'the whole disk except profile denials' && a.environment.writeRoots.some((r) => /-1$/.test(r)), J(a && a.environment));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'cat a.txt > gen.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'source\n');
    const a = await answer(s, ask(s, ['a.txt', 'gen.txt']));
    ok('G15 the write roots name the message folder of the pass the commit came from', a && a.status === 'committed' && (a.environment.writeRoots || []).some((r) => /-2$/.test(r)) && !a.environment.writeRoots.some((r) => /-1$/.test(r)), J(a && a.environment));
    await s.close();
  }
  // no hooks: no walk of the worktree
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('M13 without hooks of a check no walk process runs for a tracked path', a && a.status === 'committed' && s.walks.length === 0 && !a.untrackedInputs, J({ a, w: s.walks }));
    await s.close();
  }

  // ---- G7-02b: renames
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.renameSync(f.w('r1.txt'), f.w('r2.txt'));
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-02b a rename before the request -> refused before the hook, renamed r1 -> r2, both sides', a && a.status === 'refused' && /tracked changes outside the request/.test(a.why) && has1(a, 'renamed r1.txt -> r2.txt')
      && !kindsOf(a).includes('deleted r1.txt') && /r1\.txt/.test(a.why) && /r2\.txt/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'mv r1.txt r2.txt' } });
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-02b a rename by the hook -> refused after it, renamed r1 -> r2', a && a.status === 'refused' && /changed outside the request during the check/.test(a.why) && has1(a, 'renamed r1.txt -> r2.txt'), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.renameSync(f.w('r1.txt'), f.w('r2.txt'));
    fs.copyFileSync(f.w('r2.txt'), f.w('r3.txt'));
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-02b two copies of one blob -> both pairs, no first candidate chosen', a && a.status === 'refused' && has1(a, 'renamed r1.txt -> r2.txt', 'renamed r1.txt -> r3.txt'), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { 'empty0': '' } });
    fs.rmSync(f.w('empty0'));
    fs.writeFileSync(f.w('empty1'), '');
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-02b an empty blob has no pair: deleted and the new path among the untracked', a && a.status === 'refused' && has1(a, 'deleted empty0') && !kindsOf(a).some((k) => /renamed/.test(k)) && (a.untrackedInputs || []).includes('empty1'), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' }, files: { '.gitignore': '*.bak\n' } });
    fs.renameSync(f.w('r1.txt'), f.w('r1.bak'));
    const s = service(f);
    fs.writeFileSync(f.w('a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const c = a && (a.changed || []).find((x) => x.path === 'r1.txt');
    ok('G7-02b the target is ignored: deleted with a note naming it', a && a.status === 'refused' && c && c.kind === 'deleted' && /r1\.bak/.test(c.note || ''), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.renameSync(f.w('r1.txt'), f.w('r2.txt'));
    const s = service(f);
    const a = await answer(s, ask(s, ['r2.txt']));
    ok('G7-02b the target is named, r1 is not -> renamed, refused', a && a.status === 'refused' && has1(a, 'renamed r1.txt -> r2.txt'), J(a));
    await s.close();
  }

  // ---- PA2-01..06
  for (const hooks of [false, true]) {
    const tag = hooks ? 'with hooks' : 'without hooks';
    const opts = hooks ? { hooks: { 'pre-commit': '' } } : {};
    {
      const f = fixture(opts);
      spawnSync(GIT, ['init', '-q', f.w('sub3')], { env: SETUP_ENV });
      fs.writeFileSync(f.w('sub3/f'), 'f\n');
      const s = service(f);
      const a = await answer(s, ask(s, ['sub3/f']));
      ok(`PA2-01 ${tag}: a file of a nested repository -> committed as a blob 100644, no gitlink`, a && a.status === 'committed' && /^100644 blob/.test(git(f.wt, ['ls-tree', 'task', 'sub3/f']).out), J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      const secret = path.join(f.canary, 'id_rsa');
      fs.writeFileSync(secret, 'canary-secret\n');
      fs.symlinkSync(secret, f.w('lnk'));
      const s = service(f);
      const a = await answer(s, ask(s, ['lnk']));
      const blob = git(f.wt, ['hash-object', '--stdin'], 'canary-secret\n').out;
      ok(`PA2-02 ${tag}: a path that is a link -> committed 120000, the blob is the text of the link, the target is not an object`, a && a.status === 'committed' && /^120000 /.test(git(f.wt, ['ls-tree', 'task', 'lnk']).out)
        && show(f, 'task:lnk') === secret && git(f.wt, ['cat-file', '-e', blob]).rc !== 0, J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      const c = git(f.wt, ['rev-parse', 'task']).out;
      git(f.wt, ['update-index', '--add', '--cacheinfo', `160000,${c},gl`]);
      git(f.wt, ['commit', '-q', '-m', 'gitlink']);
      fs.mkdirSync(f.w('gl'));
      fs.writeFileSync(f.w('gl/x'), 'x\n');
      const tip = f.tip();
      const s = service(f);
      const a = await answer(s, ask(s, ['gl/x']));
      ok(`PA2-03 ${tag}: a path inside a gitlink of HEAD -> refused "inside the submodule gl", the gitlink stays`, a && a.status === 'refused' && /inside the submodule gl/.test(a.why) && f.tip() === tip && /^160000 /.test(git(f.wt, ['ls-tree', 'task', 'gl']).out), J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      fs.rmSync(f.w('b.txt'));
      fs.mkdirSync(f.w('b.txt'));
      fs.writeFileSync(f.w('b.txt/inner'), 'i\n');
      const s = service(f);
      const a = await answer(s, ask(s, ['b.txt/inner']));
      ok(`PA2-03b ${tag}: a parent of the named path is a tracked file of HEAD -> refused, it is not removed from the tree`, a && a.status === 'refused' && /b\.txt/.test(a.why) && /tracked file/.test(a.why) && f.tip() === f.h0
        && git(f.wt, ['cat-file', '-e', 'task:b.txt']).rc === 0, J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      fs.writeFileSync(f.w('a.txt'), 'edited\n');
      const s = service(f);
      const a = await answer(s, ask(s, ['A.TXT']));
      ok(`PA2-04 ${tag}: another spelling of a tracked file -> refused with the tracked spelling, no second entry`, a && a.status === 'refused' && /"a\.txt"/.test(a.why) && f.tip() === f.h0, J(a));
      fs.writeFileSync(f.w('sub/new'), 'n\n');
      const b = await answer(s, ask(s, ['SUB/new']));
      ok(`PA2-04b ${tag}: a folder of another spelling -> refused with the tracked spelling`, b && b.status === 'refused' && /"sub"/.test(b.why) && f.tip() === f.h0, J(b));
      await s.close();
    }
    {
      const nfc = 'café.txt', nfd = 'café.txt';
      const f = fixture(Object.assign({}, opts, { files: { [nfc]: 'c\n' } }));
      const s = service(f);
      fs.writeFileSync(f.w(nfc), 'edited\n');
      const a = await answer(s, ask(s, [nfd]));
      ok(`PA2-04b ${tag}: NFD of a tracked NFC name -> refused`, a && a.status === 'refused' && a.why.includes(nfc) && f.tip() === f.h0, J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      fs.linkSync(f.w('r1.txt'), f.w('hard.txt'));
      const s = service(f);
      const a = await answer(s, ask(s, ['hard.txt']));
      ok(`PA2-04 ${tag}: a hard link of a tracked file under another name is another path -> committed, no false refusal`, a && a.status === 'committed', J(a));
      await s.close();
    }
    {
      const f = fixture(Object.assign({}, opts, { files: { '.gitignore': '*.log\n', 't.log': 't\n' }, force: ['t.log'] }));
      const s = service(f);
      fs.writeFileSync(f.w('a.log'), 'a\n');
      const a = await answer(s, ask(s, ['a.log']));
      ok(`PA2-05 ${tag}: an untracked ignored path -> refused "ignored"`, a && a.status === 'refused' && /ignored/.test(a.why) && f.tip() === f.h0, J(a));
      fs.writeFileSync(f.w('t.log'), 'edited\n');
      const b = await answer(s, ask(s, ['t.log']));
      ok(`PA2-05 ${tag}: a tracked ignored path -> committed`, b && b.status === 'committed', J(b));
      await s.close();
    }
    {
      const f = fixture(opts);
      fs.mkdirSync(f.w('dd'));
      spawnSync('mkfifo', [f.w('dd/.gitignore')]);
      fs.writeFileSync(f.w('dd/new.txt'), 'n\n');
      const s = service(f);
      const t0 = Date.now();
      const a = await answer(s, ask(s, ['dd/new.txt']));
      ok(`PA2-06 ${tag}: a .gitignore of a parent is a FIFO -> refused "a .gitignore that is not a regular file" without hanging`, a && a.status === 'refused' && /a \.gitignore that is not a regular file/.test(a.why) && Date.now() - t0 < 10000, J(a));
      await s.close();
    }
    {
      const f = fixture(opts);
      fs.writeFileSync(path.join(f.canary, 'ign'), '*\n');
      fs.mkdirSync(f.w('dl'));
      fs.symlinkSync(path.join(f.canary, 'ign'), f.w('dl/.gitignore'));
      fs.writeFileSync(f.w('dl/new.txt'), 'n\n');
      const s = service(f);
      const a = await answer(s, ask(s, ['dl/new.txt']));
      ok(`PA2-06 ${tag}: a .gitignore of a parent is a link -> as absent, committed`, a && a.status === 'committed', J(a));
      await s.close();
    }
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
