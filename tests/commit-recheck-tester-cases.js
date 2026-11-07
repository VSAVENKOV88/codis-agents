'use strict';
// The tester's cells of the re-check and the walk of a commit (p-codex A2a-2b), run as a child of
// tests/commit-recheck.test.js with its own tally: names of files that git check-ignore would read as pathspec magic
// (a file is classed by its own name, as git status does, so a hook cannot hide a write under a name; answer 2, G2),
// the path lists of an answer stay within the first 200 entries whatever field holds them, the notes of one answer
// sharing them, and the whole lists stay in a file of the adapter (G11), the rules of the ignore
// classes (a rule written into a named .gitignore in the same pass, .git/info/exclude), the owner's numbers of the walk
// (200 000 entries, 15 s), the keys of the limits through createAgent. Real git repositories in a temporary folder, the
// real codex sandbox without a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the tester cells of the re-check and the walk', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const { createAgent } = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-re-t-')));
process.on('exit', () => { fs.rmSync(BASE, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(16).toString('hex');
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV, maxBuffer: 64 << 20 });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);

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

(async () => {
  // ---- the name of a file is not a pathspec: git status calls these untracked, not ignored
  const HIDDEN = ':(top)build/evil.txt';
  {
    const f = fixture(`mkdir -p ':(top)build'; echo evil > '${HIDDEN}'`);
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    const st = git(f.wt, ['status', '--porcelain', '--untracked-files=all']).out;
    ok('T1 a hook wrote a file named like pathspec magic that resolves to an ignored path; git status calls it untracked -> refused, the path named',
      st.includes(HIDDEN) && a && a.status === 'refused' && pathsOf(a).includes(HIDDEN) && f.tip() === f.h0, J({ a, st }));
    await s.close();
  }
  {
    const f = fixture('true');
    write(f, HIDDEN, 'input\n');
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T2 such a file before the check is an untracked input', a && a.status === 'committed' && (a.untrackedInputs || []).includes(HIDDEN), J(a));
    await s.close();
  }
  for (const [tag, hook] of [['without hooks', null], ['with hooks', 'true']]) {
    const f = fixture(hook);
    write(f, HIDDEN, 'named\n');
    const s = service(f);
    const a = await answer(s, ask(s, [HIDDEN]));
    ok(`T3 ${tag}: such a file named in a request is not "ignored" -> committed`, a && a.status === 'committed' && git(f.wt, ['show', `task:${HIDDEN}`]).out === 'named', J(a));
    await s.close();
  }
  for (const name of [':(literal)x.txt', ':(glob)y', ':(exclude)z', ':', ':!z', ':^z']) {
    const f = fixture('true');
    write(f, name, 'input\n');
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    ok(`T4 a file named ${name} git status lists is no failure of the walk -> committed, an untracked input`, a && a.status === 'committed' && (a.untrackedInputs || []).includes(name), J(a));
    await s.close();
  }
  {
    const f = fixture("mkdir -p build; echo cache > 'build/:(top)x.txt'");
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T11 a file with such a name that the rules do ignore -> committed, only listed as ignored', a && a.status === 'committed' && (a.ignoredChanged || []).includes('build/:(top)x.txt'), J(a));
    await s.close();
  }
  {
    const f = fixture('true');
    write(f, ':(top)d/.gitignore', 'hidden.txt\n');
    write(f, ':(top)d/hidden.txt', 'h\n');
    write(f, ':(top)d/seen.txt', 's\n');
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const inputs = (a && a.untrackedInputs) || [];
    ok('T12 a .gitignore in a folder with such a name holds for its files: an input by git status, the file it hides is not',
      a && a.status === 'committed' && inputs.includes(':(top)d/seen.txt') && inputs.includes(':(top)d/.gitignore') && !inputs.includes(':(top)d/hidden.txt'), J(a));
    await s.close();
  }
  // ---- G11: the paths of an answer are cut in every field
  {
    const f = fixture('true');
    const blob = fs.readFileSync(f.w('b.txt'));
    for (let i = 0; i < 300; i++) write(f, `build/copy-${i}.txt`, blob);
    fs.rmSync(f.w('b.txt'));
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const id = ask(s, ['n.txt']);
    const a = await answer(s, id);
    const text = fs.readFileSync(path.join(s.answers, `${id}.json`), 'utf8');
    const shown = (text.match(/build\/copy-\d+\.txt/g) || []).length;
    ok('T5 300 ignored copies of a deleted file: the note on deleted holds at most the first 200 paths (G11), the answer stays small',
      a && a.status === 'refused' && pathsOf(a).includes('b.txt') && shown <= 200, J({ why: a && a.why, shown, bytes: text.length }));
    await s.close();
  }
  const copiesIn = (text) => (text.match(/build\/copy-[ab]?\d+\.txt/g) || []).length;
  {
    const f = fixture('true');
    const blob = fs.readFileSync(f.w('b.txt'));
    for (let i = 0; i < 300; i++) write(f, `build/copy-${i}.txt`, blob);
    fs.rmSync(f.w('b.txt'));
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const whole = a && a.changesFile ? readJson(a.changesFile) : null;
    const note = (whole && whole.changed[0].note) || '';
    ok('T5b the note that was cut says how many more and where; the whole list in the file of the adapter names all 300',
      a && /and 100 more/.test(a.changed[0].note) && /changesFile/.test(a.changed[0].note) && copiesIn(note) === 300 && a.changedCount === 1, J({ shown: a && a.changed[0].note.slice(-80), whole: copiesIn(note) }));
    await s.close();
  }
  {
    const f = fixture('true');
    const bytes = { a: fs.readFileSync(f.w('a.txt')), b: fs.readFileSync(f.w('b.txt')) };
    for (const k of ['a', 'b']) {
      for (let i = 0; i < 150; i++) write(f, `build/copy-${k}${i}.txt`, bytes[k]);
      fs.rmSync(f.w(`${k}.txt`));
    }
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const id = ask(s, ['n.txt']);
    const a = await answer(s, id);
    const text = fs.readFileSync(path.join(s.answers, `${id}.json`), 'utf8');
    const whole = a && a.changesFile ? readJson(a.changesFile) : null;
    ok('T5c the notes of two deleted files share the first 200 paths, the file names all 300',
      a && a.changedCount === 2 && copiesIn(text) === 200 && whole && copiesIn(JSON.stringify(whole)) === 300, J({ shown: copiesIn(text), file: a && a.changesFile }));
    await s.close();
  }
  {
    const f = fixture('true');
    const blob = fs.readFileSync(f.w('b.txt'));
    for (let i = 0; i < 200; i++) write(f, `build/copy-${i}.txt`, blob);
    fs.rmSync(f.w('b.txt'));
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T5d exactly 200 copies: the note names all of them, nothing is cut, no file', a && copiesIn(a.changed[0].note) === 200 && a.changesFile === undefined, J({ file: a && a.changesFile }));
    await s.close();
  }
  {
    const f = fixture("rm b.txt; mkdir -p build; i=0; while [ $i -lt 300 ]; do printf 'b.txt\\n' > build/copy-$i.txt; i=$((i+1)); done");
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    const inNotes = copiesIn(JSON.stringify((a && a.changed) || []));
    ok('T5e a hook deleted the file and wrote the copies: the same limit after the check, in the note and in ignoredChanged',
      a && a.status === 'refused' && pathsOf(a).includes('b.txt') && inNotes === 200 && a.ignoredChanged.length === 200 && a.ignoredChangedCount === 300, J({ inNotes, why: a && a.why }));
    await s.close();
  }
  {
    const f = fixture('true');
    const blob = fs.readFileSync(f.w('b.txt'));
    for (let i = 0; i < 300; i++) write(f, `plain/copy-${i}.txt`, blob);
    fs.rmSync(f.w('b.txt'));
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const whole = a && a.changesFile ? readJson(a.changesFile) : null;
    const pairs = whole && whole.changed.filter((c) => c.kind === 'renamed' && c.from === 'b.txt').length;
    ok('T6 300 copies of a deleted file: 200 pairs shown, changedCount 300, the whole list in a file of the adapter outside the roots of the role',
      a && a.status === 'refused' && a.changed.length === 200 && a.changedCount === 300 && pairs === 300 && a.changesFile.startsWith(f.state + path.sep), J({ count: a && a.changedCount, file: a && a.changesFile, pairs }));
    await s.close();
  }
  // ---- the classes
  {
    const f = fixture("printf 'evil.txt\\n' >> .gitignore; echo evil > evil.txt");
    const s = service(f);
    write(f, '.gitignore', 'build/\n*.log\n# named\n');
    const a = await answer(s, ask(s, ['.gitignore']));
    ok('T7 a hook adds a rule to a named .gitignore and writes the file it hides -> refused: the class is by the rules before the pass',
      a && a.status === 'refused' && pathsOf(a).includes('evil.txt'), J(a));
    await s.close();
  }
  {
    const f = fixture('echo cache > excluded.bin');
    const common = git(f.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
    fs.mkdirSync(path.join(common, 'info'), { recursive: true });
    fs.appendFileSync(path.join(common, 'info', 'exclude'), 'excluded.bin\n');
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T8 a file ignored by .git/info/exclude -> only listed in ignoredChanged', a && a.status === 'committed' && (a.ignoredChanged || []).includes('excluded.bin'), J(a));
    await s.close();
  }
  // ---- the owner's numbers of the walk, by what the walk process is given
  {
    const f = fixture('true');
    let job = null;
    const s = service(f, { inject: { walkLaunch: (spec) => { job = readJson(spec.args[spec.args.length - 1]); return spec; } } });
    write(f, 'n.txt', 'n\n');
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T9 the defaults given to the walk: commit.walkMaxEntries 200 000, a walk 15 s (owner 2026-11-07)',
      a && a.status === 'committed' && job && job.limits.entries === 200000 && job.limits.timeoutMs === 15000, J(job && job.limits));
    await s.close();
  }
  // ---- the keys of the limits through createAgent
  for (const k of ['walkMaxEntries', 'walkTimeoutMs', 'walkMaxResultBytes', 'walkMaxIgnoreBytes', 'walkMaxReadBytes']) {
    const f = fixture(null);
    let why = null;
    try {
      createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: path.join(f.d, 'chome') }, env: {}, tasks: {},
        commit: { stateDir: f.state, git: GIT, [k]: -1 }, launch: async () => ({ rc: 0, output: '{}' }) });
    } catch (e) { why = e.message; }
    ok(`T10 commit.${k} that is not a positive number -> refused by createAgent`, why && why.includes(`commit.${k} must be a positive number`), why);
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
