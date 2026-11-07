'use strict';
// The tester's cells of a folder the walk cannot look into (p-codex A2a-2b, F3 of the security review, owner answer 2),
// run as a child of tests/commit-recheck.test.js with its own tally: every right of such a folder, the change of its
// type in both directions, under ignore rules, in the second pass of the re-check, tracked and named paths inside it,
// its neighbours (rename pairs, the empty folder, the file of the whole lists, odd names), and no false refusal of a
// folder the check only reads. Real git repositories in a temporary folder, the real codex sandbox without a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the tester cells of folders without rights', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-nr-t-')));
process.on('exit', () => {
  spawnSync('/bin/chmod', ['-R', 'u+rwx', BASE]);
  fs.rmSync(BASE, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV, maxBuffer: 64 << 20 });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const J = (x) => String(JSON.stringify(x, (k, v) => (k === 'checks' ? undefined : v))).slice(0, 1500);

let fixN = 0;
function fixture(hookBody) {
  const d = path.join(BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'),
    home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), hooks: path.join(d, 'hooks') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'xdg']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n');
  git(f.repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(f.repo, '.gitignore'), 'build/\n*.log\n');
  for (const n of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  git(f.repo, ['add', '.gitignore', 'a.txt', 'b.txt']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  f.wt = path.join(d, 'wt');
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  f.w = (n) => path.join(f.wt, n);
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.h0 = f.tip();
  if (hookBody !== null && hookBody !== undefined) {
    fs.mkdirSync(f.hooks);
    fs.writeFileSync(path.join(f.hooks, 'pre-commit'), `#!/bin/sh\n${hookBody}\nexit 0\n`);
    fs.chmodSync(path.join(f.hooks, 'pre-commit'), 0o755);
    git(f.repo, ['config', 'core.hooksPath', f.hooks]);
  }
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg, TMPDIR: f.rtmp };
  return f;
}
let callN = 0;
function service(f, extra) {
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  return openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'),
    stateDir: f.state, git: GIT, codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {} }, extra || {}));
}
function ask(s, paths, message) {
  const id = newId();
  const tmp = path.join(s.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, paths, message: message || 'msg' }));
  fs.renameSync(tmp, path.join(s.box, `${id}.json`));
  return id;
}
async function answer(s, id, ms) {
  const end = Date.now() + (ms || 60000);
  for (;;) { const a = readJson(path.join(s.answers, `${id}.json`)); if (a || Date.now() > end) return a; await sleep(25); }
}
const pathsOf = (a) => ((a && a.changed) || []).map((c) => c.path);
const write = (f, n, body) => { fs.mkdirSync(path.dirname(f.w(n)), { recursive: true }); fs.writeFileSync(f.w(n), body); };


const kinds = (a) => ((a && a.changed) || []).map((c) => `${c.kind} ${c.path}`);
const refusedWith = (a, f, ...want) => !!a && a.status === 'refused' && want.every((k) => kinds(a).includes(k)) && !/internal error/.test(a.why || '') && f.tip() === f.h0;
const track = (f, n, body) => { write(f, n, body); git(f.wt, ['add', n]); git(f.wt, ['commit', '-q', '-m', `add ${n}`]); f.h0 = f.tip(); };
// one request with a file of its own beside what the cell prepared
async function one(f, prep, extra) {
  if (prep) prep();
  const s = service(f, extra);
  write(f, 'n.txt', 'n\n');
  const a = await answer(s, ask(s, ['n.txt']));
  await s.close();
  return a;
}
const shut = (f, n, mode, files) => {
  fs.mkdirSync(f.w(n), { recursive: true });
  for (const x of files || []) fs.writeFileSync(f.w(`${n}/${x}`), 'o\n');
  fs.chmodSync(f.w(n), mode);
};

(async () => {
  // ---- the type of the entry changes, in both directions
  {
    const f = fixture('chmod 755 build/hid; rm -rf build/hid; echo evil > build/hid');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T33 a folder without rights under an ignored one replaced by a file -> a change of the folder is never an ignored one: refused with the path', refusedWith(a, f, 'modified build/hid'), J(a));
  }
  {
    const f = fixture('chmod 755 hid; rm -rf hid; echo evil > hid');
    const a = await one(f, () => shut(f, 'hid', 0, ['old']));
    ok('T33b the same outside ignore rules -> refused, modified', refusedWith(a, f, 'modified hid'), J(a));
  }
  {
    const f = fixture('chmod 755 build/hid; rm -rf build/hid; ln -s /etc build/hid');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T33c the same folder replaced by a link -> refused, modified, not one of the ignored changes', refusedWith(a, f, 'modified build/hid') && !(a.ignoredChanged || []).includes('build/hid'), J(a));
  }
  {
    const f = fixture('if grep -q fixed n.txt; then chmod 755 build/hid; rm -rf build/hid; echo evil > build/hid; else echo fixed >> n.txt; fi');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T33d the second pass of the re-check replaces it by a file -> refused, modified', refusedWith(a, f, 'modified build/hid'), J(a));
  }
  {
    const f = fixture('chmod 755 build/hid; rm -rf build/hid; mv b.txt build/hid');
    const a = await one(f, () => shut(f, 'build/hid', 0));
    ok('T33e a tracked file moved to its place -> both named, no internal error', refusedWith(a, f, 'deleted b.txt', 'modified build/hid'), J(a));
  }
  {
    const f = fixture('chmod 700 build/hid; echo evil > build/hid/new; chmod 000 build/hid');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T33f opened and closed again by the hook under an ignored folder -> refused, modified', refusedWith(a, f, 'modified build/hid'), J(a));
  }
  {
    const f = fixture('chmod 755 build/hid; echo evil > build/hid/new');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T33g its rights given back under an ignored folder -> refused, deleted the entry; the files now seen are ignored ones', refusedWith(a, f, 'deleted build/hid') && !kinds(a).some((k) => k.includes('build/hid/')), J(a));
  }
  {
    const f = fixture('rm build/l; echo new > build/l; echo more >> build/u.dat');
    const a = await one(f, () => { write(f, 'build/u.dat', 'u\n'); fs.symlinkSync('/etc', f.w('build/l')); });
    const seen = (a && a.ignoredChanged) || [];
    ok('T33h no false refusal: an ignored link replaced by a file and a rewritten ignored file stay ignored changes', a && a.status === 'committed' && seen.includes('build/l') && seen.includes('build/u.dat'), J(a));
  }
  {
    const f = fixture('rm u.dat; mkdir u.dat; echo evil > u.dat/evil; chmod 000 u.dat');
    const a = await one(f, () => write(f, 'u.dat', 'u\n'));
    ok('T34 an untracked file replaced by a folder without rights -> refused, modified', refusedWith(a, f, 'modified u.dat'), J(a));
  }
  {
    const f = fixture('rm build/u.dat; mkdir build/u.dat; echo evil > build/u.dat/evil; chmod 000 build/u.dat');
    const a = await one(f, () => write(f, 'build/u.dat', 'u\n'));
    ok('T34b an ignored file replaced by a folder without rights -> refused, not one of the ignored changes', refusedWith(a, f, 'modified build/u.dat'), J(a));
  }
  {
    const f = fixture('chmod 755 hid; rm -rf hid; ln -s /etc hid');
    const a = await one(f, () => shut(f, 'hid', 0));
    ok('T35 a folder without rights replaced by a link -> refused, modified', refusedWith(a, f, 'modified hid'), J(a));
  }
  {
    const f = fixture('chmod 755 hid; rm -rf hid');
    const a = await one(f, () => shut(f, 'hid', 0, ['old']));
    ok('T36 a folder without rights removed -> refused, deleted', refusedWith(a, f, 'deleted hid'), J(a));
  }
  {
    const f = fixture('chmod 755 build/hid; rm -rf build/hid');
    const a = await one(f, () => shut(f, 'build/hid', 0, ['old']));
    ok('T36b the same under an ignored folder -> refused, deleted', refusedWith(a, f, 'deleted build/hid'), J(a));
  }
  // ---- its neighbours
  {
    const f = fixture('rm b.txt; mkdir hid; chmod 000 hid');
    const a = await one(f);
    ok('T37 a deleted tracked file and a new folder without rights -> no pair, no internal error: both named', refusedWith(a, f, 'deleted b.txt', 'created hid') && !(a.changed.find((c) => c.path === 'b.txt') || {}).renamed, J(a));
  }
  {
    const f = fixture('if grep -q fixed n.txt; then mkdir hid; chmod 000 hid; else echo fixed >> n.txt; fi');
    const a = await one(f);
    ok('T38 the second pass of the re-check takes the rights away -> refused with the path', refusedWith(a, f, 'created hid'), J(a));
  }
  {
    const f = fixture('if grep -q fixed n.txt; then :; else echo fixed >> n.txt; fi');
    const a = await one(f, () => shut(f, 'hid', 0, ['old']));
    ok('T38b a folder without rights the re-check leaves alone -> committed after the second pass', a && a.status === 'committed' && a.rechecked === true, J(a));
  }
  {
    const f = fixture('[ -d hid ] || { mkdir hid; chmod 000 hid; }');
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    const first = refusedWith(a, f, 'created hid');
    const b = await answer(s, ask(s, ['n.txt']));
    await s.close();
    ok('T39 the next request of a call takes the folder as it found it -> refused once, then committed with a note', first && b && b.status === 'committed' && (b.walkNotes || []).some((n) => n.startsWith('hid:')), J({ b }));
  }
  {
    const f = fixture('for i in $(seq 1 250); do mkdir h$i; chmod 000 h$i; done');
    const a = await one(f);
    const whole = a && a.changesFile ? readJson(a.changesFile) : null;
    ok('T40 250 folders without rights -> the answer holds 200, the count and the file hold them all', a && a.status === 'refused' && a.changed.length === 200 && a.changedCount === 250 && whole && whole.changed.length === 250, J(a && { s: a.status, l: a.changed.length, n: a.changedCount, c: a.changesFile }));
  }
  // ---- tracked and named paths inside it
  {
    const f = fixture('chmod 000 sub');
    track(f, 'sub/t.txt', 't\n');
    const a = await one(f);
    ok('T41 a hook takes the rights from a folder of tracked files -> refused with a path, no internal error', !!a && a.status === 'refused' && /sub/.test(J(a.changed)) && !/internal error/.test(a.why || '') && f.tip() === f.h0, J(a));
  }
  {
    const f = fixture('true');
    track(f, 'sub/t.txt', 't\n');
    const a = await one(f, () => fs.chmodSync(f.w('sub'), 0));
    ok('T41b such a folder before the check -> refused with a path, no internal error', !!a && a.status === 'refused' && /sub/.test(J(a.changed) + (a.why || '')) && !/internal error/.test(a.why || '') && f.tip() === f.h0, J(a));
  }
  for (const mode of ['000', '400']) {
    const f = fixture(`chmod ${mode} dir`);
    write(f, 'dir/x.txt', 'x\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['dir/x.txt']));
    await s.close();
    ok(`T42 a hook takes the rights from the folder of a named path (${mode}) -> refused, no internal error, the tip stays`, !!a && a.status === 'refused' && !/internal error/.test(a.why || '') && f.tip() === f.h0, J(a));
  }
  for (const mode of [0, 0o400]) {
    const f = fixture('true');
    write(f, 'dir/x.txt', 'x\n');
    fs.chmodSync(f.w('dir'), mode);
    const s = service(f);
    const a = await answer(s, ask(s, ['dir/x.txt']));
    await s.close();
    ok(`T42b a named path in a folder without rights before the check (${mode.toString(8)}) -> refused, no internal error, the tip stays`, !!a && a.status === 'refused' && !/internal error/.test(a.why || '') && f.tip() === f.h0, J(a));
  }
  // ---- every right
  for (const mode of ['100', '300', '311']) {
    const f = fixture('echo evil > hid/new');
    const a = await one(f, () => shut(f, 'hid', parseInt(mode, 8), ['old']));
    if (mode === '100') ok('T43 a folder with a search right only: no write possible -> the hook fails to write, committed with a note', a && a.status === 'committed' && (a.walkNotes || []).some((n) => n.startsWith('hid:')), J(a));
    else ok(`T43 a new file through the rights of the folder (${mode}) -> its mtime moves: refused, modified`, refusedWith(a, f, 'modified hid'), J(a));
  }
  {
    const f = fixture('echo evil >> hid/old');
    const a = await one(f, () => shut(f, 'hid', 0o311, ['old']));
    ok('T43b the gap README names: a write into a file through a search right the folder had -> committed with the note', a && a.status === 'committed' && (a.walkNotes || []).some((n) => n.startsWith('hid:')), J(a));
  }
  for (const mode of ['500', '700']) {
    const f = fixture(`mkdir hid; echo evil > hid/evil; chmod ${mode} hid`);
    const a = await one(f);
    ok(`T44 a folder the walk can read (${mode}) -> its file is the change, no entry of the folder`, refusedWith(a, f, 'created hid/evil') && !kinds(a).includes('created hid'), J(a));
  }
  {
    const f = fixture('mkdir -p a/b/hid; echo evil > a/b/hid/evil; chmod 000 a/b/hid');
    const a = await one(f);
    ok('T45 a nested folder -> its whole path', refusedWith(a, f, 'created a/b/hid'), J(a));
  }
  {
    const f = fixture('chmod 700 a; chmod 000 a/b; chmod 400 a');
    const a = await one(f, () => { shut(f, 'a/b', 0o755, ['old']); fs.chmodSync(f.w('a'), 0o400); });
    ok('T45b a change under a 400 folder is seen on that folder', refusedWith(a, f, 'modified a'), J(a));
  }
  // ---- odd names
  {
    const f = fixture('mkdir sub; mkdir sub/.gitignore; chmod 000 sub/.gitignore');
    const a = await one(f);
    ok('T46 a folder named .gitignore without rights: its rules cannot be read -> refused, the walk names the path, no internal error', !!a && a.status === 'refused' && /no safe check path: sub\/\.gitignore: EACCES/.test(a.why) && f.tip() === f.h0, J(a));
  }
  for (const name of [':(top)build/hid', 'a b\ttab', "q'uo\"te", '\u043f\u0430\u043f\u043a\u0430']) {
    const f = fixture(`mkdir -p '${name.replace(/'/g, "'\\''")}'; chmod 000 '${name.replace(/'/g, "'\\''")}'`);
    const a = await one(f);
    ok(`T47 a folder without rights named ${JSON.stringify(name)} -> refused with the path as it is`, refusedWith(a, f, `created ${name}`), J(a));
  }
  // ---- the empty folder (G3): nothing unseen means no change
  {
    const f = fixture('mkdir hid');
    const a = await one(f);
    ok('T48 a new empty folder with rights -> no change', a && a.status === 'committed', J(a));
  }
  {
    const f = fixture('mkdir hid; chmod 000 hid');
    const a = await one(f);
    ok('T48b a new empty folder without a listing -> its contents are unknown: refused with the path', refusedWith(a, f, 'created hid'), J(a));
  }
  {
    const f = fixture('mkdir hid; chmod 400 hid');
    const a = await one(f);
    ok('T48c a new empty 400 folder: its listing is whole and empty -> no change', a && a.status === 'committed', J(a));
  }
  // ---- no false refusal: reading and repeating touch nothing of the key
  {
    const f = fixture('ls hid > /dev/null 2>&1; stat hid > /dev/null; true');
    const a = await one(f, () => shut(f, 'hid', 0o400, ['old']));
    ok('T49 a hook that only lists a 400 folder -> atime is not in the key: committed', a && a.status === 'committed', J(a));
  }
  {
    const f = fixture('chmod 000 hid');
    const a = await one(f, () => shut(f, 'hid', 0));
    ok('T49b a chmod to the same rights moves nothing of the key -> committed', a && a.status === 'committed', J(a));
  }
  // ---- the root of the worktree
  {
    const f = fixture('chmod 000 .');
    const a = await one(f);
    fs.chmodSync(f.wt, 0o755);
    ok('T50 a hook takes the rights from the worktree itself -> refused, no internal error, the tip stays', !!a && a.status === 'refused' && !/internal error/.test(a.why || '') && f.tip() === f.h0, J(a));
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
