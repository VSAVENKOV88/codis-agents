'use strict';
// The tester's cells of the re-check and the walk of a commit (p-codex A2a-2b), run as a child of
// tests/commit-recheck.test.js with its own tally: names of files that git check-ignore would read as pathspec magic
// (a file is classed by its own name, as git status does, so a hook cannot hide a write under a name; answer 2, G2),
// the path lists of an answer stay within the first 200 entries whatever field holds them, the notes of one answer
// sharing them, and the whole lists stay in a file of the adapter (G11), that file and the memory of the adapter stay
// bounded when deleted files and copies multiply (G1, G8), the sum of the budget on names whose JSON is longer than their
// characters, what pairs with what, the gate of the file over all its lists and in bytes, a status that a failed answer does not change (I3), tracked names and rename pairs of such names, the rules of the ignore
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
  // ---- every file is classed as git status classes it, whatever its name says to another git command. The same file
  // can be spelled NFD on the disk and NFC by git status (core.precomposeunicode), so the lists are compared in NFC.
  const NASTY = ['*', '?', '[a]', 'x*.log', 'y[a].log', 'back\\slash', 'new\nline', ' lead', 'trail ', '#c', '!n', '"q"', "'s'", '-dash', '--stdin', ':/x', ':!z', ':^z',
    ':(top)a', ':(glob)g', ':(exclude)e', ':(icase)i', ':(attr:x)y', ':(literal)l', ':(top)build/x', 'd/:(top)y', 'build/:(top)z', ':(top)d2/w', 'é-nfd.txt', '..foo', '...',
    'tab\tname', ':(top)x.log', 'a:b', 'ctl\x01x', 'build2/up.txt'];
  const statusOf = (f) => {
    const p = spawnSync(GIT, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=traditional'], { cwd: f.wt, encoding: 'utf8', env: SETUP_ENV });
    const of = (tag) => p.stdout.split('\0').filter((e) => e.startsWith(`${tag} `)).map((e) => e.slice(3).normalize('NFC')).filter((e) => e !== 'n.txt').sort();
    return { untracked: of('??'), ignored: of('!!') };
  };
  const same = (a, b) => JSON.stringify(a.map((x) => x.normalize('NFC')).sort()) === JSON.stringify(b);
  const ignoreRules = (f) => { // BUILD2/ in another case: the rules read with the core.ignorecase of the repository
    write(f, '.gitignore', 'build/\n*.log\nBUILD2/\n');
    git(f.wt, ['add', '.gitignore']);
    git(f.wt, ['commit', '-q', '-m', 'rules']);
    f.h0 = f.tip();
  };
  {
    const f = fixture('true');
    ignoreRules(f);
    for (const n of NASTY) write(f, n, 'input\n');
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const st = statusOf(f);
    ok('T13 names of every kind before a check: untrackedInputs is what git status calls untracked, and nothing it ignores',
      a && a.status === 'committed' && a.untrackedInputsCount === st.untracked.length && same(a.untrackedInputs || [], st.untracked) && st.ignored.some((x) => x.includes(':(top)')), J({ a, st }));
    await s.close();
  }
  {
    const gen = path.join(BASE, 'gen-nasty.js');
    fs.writeFileSync(gen, `const fs=require('fs'),path=require('path');for(const n of ${JSON.stringify(NASTY)}){fs.mkdirSync(path.dirname(n),{recursive:true});fs.writeFileSync(n,'h\\n');}`);
    const f = fixture(`"${process.execPath}" "${gen}"`);
    ignoreRules(f);
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const st = statusOf(f);
    ok('T14 a hook wrote names of every kind: each one git status calls untracked is in changed, each one it ignores in ignoredChanged, no commit',
      a && a.status === 'refused' && f.tip() === f.h0 && same(pathsOf(a), st.untracked) && same(a.ignoredChanged || [], st.ignored), J({ a, st }));
    await s.close();
  }
  {
    const names = [':(top)a.txt', ':(exclude)z', ':', ':!z', ':(glob)*', '*', '[a]', 'dir/:(top)x', ':(top)dir/y'];
    const f = fixture('true');
    for (const n of names) write(f, n, `v0 ${n}\n`);
    git(f.wt, ['add', '--'].concat(names.map((n) => `:(literal)${n}`)));
    git(f.wt, ['commit', '-q', '-m', 'names']);
    const count = () => git(f.wt, ['ls-tree', '-r', '--name-only', 'task']).out.split('\n').length;
    const before = count();
    const s = service(f);
    for (const n of names) {
      write(f, n, `v1 ${n}\n`);
      write(f, 'n.txt', `${n}\n`);
      const tip = f.tip();
      const a = await answer(s, ask(s, ['n.txt']));
      ok(`T15 tracked ${n}, changed and not named -> refused with its path`, a && a.status === 'refused' && pathsOf(a).includes(n) && f.tip() === tip, J(a));
      const b = await answer(s, ask(s, [n]));
      ok(`T15 tracked ${n} named -> committed under that name alone`, b && b.status === 'committed' && git(f.wt, ['cat-file', '-p', `task:${n}`]).out === `v1 ${n}` && count() === before, J(b));
      fs.rmSync(f.w('n.txt'));
    }
    await s.close();
  }
  {
    const f = fixture('true');
    write(f, ':(top)r1', 'the bytes of the pair\n');
    git(f.wt, ['add', '--', ':(literal):(top)r1']);
    git(f.wt, ['commit', '-q', '-m', 'r']);
    fs.renameSync(f.w(':(top)r1'), f.w(':(glob)r2'));
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    ok('T16 a rename between such names -> refused, the pair named', a && a.status === 'refused' && (a.changed || []).some((c) => c.kind === 'renamed' && c.from === ':(top)r1' && c.path === ':(glob)r2'), J(a));
    await s.close();
  }
  {
    const f = fixture('true');
    for (let i = 0; i < 260; i++) write(f, `t/f${i}.txt`, `b${i}\n`);
    git(f.wt, ['add', 't']);
    git(f.wt, ['commit', '-q', '-m', 't']);
    for (let i = 0; i < 260; i++) {
      for (let k = 0; k < 3; k++) write(f, `build/c${i}-${k}.txt`, `b${i}\n`);
      fs.rmSync(f.w(`t/f${i}.txt`));
    }
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const id = ask(s, ['n.txt']);
    const a = await answer(s, id, 120000);
    const text = fs.readFileSync(path.join(s.answers, `${id}.json`), 'utf8');
    const whole = a && a.changesFile ? readJson(a.changesFile) : null;
    const copies = (t) => (t.match(/build\/c\d+-\d/g) || []).length;
    const journal = fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8');
    ok('T17 260 deleted files with 3 ignored copies each: 200 entries, 200 paths in their notes, the whole of both in the file, no internal field, none in the journal',
      a && a.changed.length === 200 && a.changedCount === 260 && copies(text) === 200 && whole.changed.length === 260 && copies(JSON.stringify(whole.changed)) === 780
        && !text.includes('ignoredCopies') && !JSON.stringify(whole).includes('ignoredCopies') && copies(journal) === 0, J({ count: a && a.changedCount, shown: copies(text), file: a && a.changesFile, journal: copies(journal) }));
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
  // ---- every deleted file pairs with every copy (G8), so the lists grow as a product of what the walk's limits bound
  // one by one; what the adapter holds and writes for one request stays bounded (G1: the volume of accumulated results;
  // the default walk limit on results is 64 MiB). 8000 x 8000 ignored copies ended the adapter with an out of memory.
  const product = async (tag, D, C, dir) => {
    const f = fixture('true');
    const long = 'L'.repeat(150);
    fs.mkdirSync(f.w('t'));
    for (let i = 0; i < D; i++) fs.writeFileSync(f.w(`t/f${i}.txt`), 'same\n');
    git(f.wt, ['add', 't']);
    git(f.wt, ['commit', '-q', '-m', 't']);
    fs.mkdirSync(f.w(`${dir}/${long}`), { recursive: true });
    for (let i = 0; i < C; i++) fs.writeFileSync(f.w(`${dir}/${long}/c${i}.txt`), 'same\n');
    fs.rmSync(f.w('t'), { recursive: true });
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const tip = f.tip();
    const peak0 = process.resourceUsage().maxRSS;
    const a = await answer(s, ask(s, ['n.txt']), 120000);
    const peak = process.resourceUsage().maxRSS - peak0;
    const bytes = a && a.changesFile ? fs.statSync(a.changesFile).size : 0;
    ok(`T18 ${tag}: ${D} deleted x ${C} copies -> refused for its reason, no internal error, the file of the lists within 64 MiB`,
      a && a.status === 'refused' && f.tip() === tip && !/internal error/.test(a.why || '') && bytes <= 64 * 1024 * 1024, J({ why: a && (a.why || '').slice(0, 200), bytes }));
    ok(`LP-01..04 ${tag}: ${D} x ${C}: the refusal names both counts and the limit, no list, before the hooks, the peak of the adapter grows by less than 300 MB`,
      a && (a.why || '').startsWith(`no safe check path: the rename pairs of ${D} deleted files and ${C} files`) && (a.why || '').includes(`above the ${64 * 1024 * 1024} of results`) && a.changed === undefined && a.checks === undefined && peak < 300 * 1024, J({ why: a && (a.why || '').slice(0, 200), peakKiB: peak }));
    fs.rmSync(f.w('n.txt'));
    git(f.wt, ['checkout', '-q', 'task', '--', 't']);
    fs.rmSync(f.w(dir), { recursive: true });
    write(f, 'after.txt', 'after\n');
    const b = await answer(s, ask(s, ['after.txt']));
    ok(`T18 ${tag}: the adapter goes on: the next request is committed`, b && b.status === 'committed', J(b));
    await s.close();
  };
  await product('ignored copies', 1500, 1500, 'build');
  await product('copies', 1500, 1500, 'plain');
  await product('ignored copies, a string longer than node holds', 3000, 3000, 'build');
  await product('ignored copies, what ended the adapter with an out of memory', 8000, 8000, 'build');
  // ---- the budget of the rename pairs and the gate of the file, on names whose JSON is longer than their characters
  // (G1, G8, I1, I2): the sum the adapter refuses by is not below what it would build, and it pairs only what is equal
  const commitFiles = (f, names, body) => {
    for (const n of names) write(f, n, body);
    git(f.wt, ['add', '--'].concat(names.map((n) => `./${n}`)));
    git(f.wt, ['commit', '-q', '-m', 'tracked']);
    for (const n of names) fs.rmSync(f.w(n));
    write(f, 'n.txt', 'n\n');
  };
  const budgetOf = (a) => { const m = /take (\d+) bytes, above the (\d+) of results/.exec((a && a.why) || ''); return m ? +m[1] : null; };
  const entryBytes = (list) => (list || []).reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
  const STRANGE = (i) => `q"b\\s\tтекст\u0001-${'x'.repeat(30)}-${i}.txt`;
  for (const [tag, dir] of [['pairs', 'plain'], ['notes of ignored copies', 'build']]) {
    const build = () => {
      const f = fixture('true');
      commitFiles(f, Array.from({ length: 12 }, (_, i) => `t/${STRANGE(i)}`), 'same\n');
      for (let i = 0; i < 12; i++) write(f, `${dir}/${STRANGE(100 + i)}`, 'same\n');
      return f;
    };
    let N = null;
    {
      const f = build();
      const s = service(f, { walkMaxResultBytes: 6000 });
      N = budgetOf(await answer(s, ask(s, ['n.txt'])));
      await s.close();
    }
    {
      const f = build();
      const s = service(f, { walkMaxResultBytes: N });
      const a = await answer(s, ask(s, ['n.txt']));
      const real = entryBytes(a && a.changed);
      ok(`T19 ${tag}, names with quotes, a tab, a control character and Cyrillic: with the sum the refusal names as the limit they are listed, and what is listed is not above that sum`,
        N && a && a.status === 'refused' && a.changedCount === (dir === 'plain' ? 144 : 12) && real <= N, J({ N, real, why: a && (a.why || '').slice(0, 200) }));
      await s.close();
    }
    {
      const f = build();
      const s = service(f, { walkMaxResultBytes: N - 1 });
      const a = await answer(s, ask(s, ['n.txt']));
      ok(`T19 ${tag}: one byte below that sum -> refused by the budget, no list`, a && a.status === 'refused' && budgetOf(a) === N && a.changed === undefined, J({ N, why: a && (a.why || '').slice(0, 200) }));
      await s.close();
    }
  }
  {
    // the pairs are of equal content only: two blobs of one size, a mode that differs, a group with plain and ignored copies
    const f = fixture('true');
    for (const n of ['a/1', 'a/2']) write(f, n, 'aaaa\n');
    for (const n of ['b/1', 'b/2']) write(f, n, 'bbbb\n');
    write(f, 'e/run', 'cccc\n');
    fs.chmodSync(f.w('e/run'), 0o755);
    git(f.wt, ['add', 'a', 'b', 'e']);
    git(f.wt, ['commit', '-q', '-m', 'blobs']);
    fs.rmSync(f.w('a'), { recursive: true });
    fs.rmSync(f.w('b'), { recursive: true });
    fs.rmSync(f.w('e'), { recursive: true });
    for (const n of ['ca1', 'ca2']) write(f, n, 'aaaa\n');
    write(f, 'build/ca3', 'aaaa\n');
    for (const n of ['cb1', 'cb2', 'cb3']) write(f, n, 'bbbb\n');
    write(f, 'ce', 'cccc\n');
    write(f, 'n.txt', 'n\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['n.txt']));
    const got = ((a && a.changed) || []).map((c) => `${c.kind} ${c.from || ''}>${c.path}${c.note ? ' note' : ''}`).sort();
    const want = [];
    for (const d of ['a/1', 'a/2']) for (const c of ['ca1', 'ca2']) want.push(`renamed ${d}>${c}`);
    for (const d of ['b/1', 'b/2']) for (const c of ['cb1', 'cb2', 'cb3']) want.push(`renamed ${d}>${c}`);
    want.push('renamed e/run>ce');
    want.sort();
    ok('T20 every deleted file with every copy of its own content: two blobs of one size do not mix, a plain copy outranks an ignored one, the x bit is no part of the group', a && a.status === 'refused' && J(got) === J(want), J({ got, want }));
    await s.close();
  }
  {
    // a sum over the whole lists: each list and each walk within the limit, together above it
    const long = 'L'.repeat(150);
    const build = () => {
      const f = fixture(`mkdir -p build; i=0; while [ $i -lt 300 ]; do : > build/${long}$i; echo v1 > t/${long}$i; i=$((i+1)); done`);
      const names = Array.from({ length: 300 }, (_, i) => `t/${long}${i}`);
      for (const n of names) write(f, n, 'v0\n');
      git(f.wt, ['add', 't']);
      git(f.wt, ['commit', '-q', '-m', 't']);
      write(f, 'n.txt', 'n\n');
      return f;
    };
    {
      const f = build();
      const s = service(f, { walkMaxResultBytes: 95000 });
      const id = ask(s, ['n.txt']);
      const a = await answer(s, id);
      ok('T21 two lists each within the limit, together above it -> the same refusal, no file: the gate is of all the lists of the file',
        a && a.status === 'refused' && /^changed outside the request/.test(a.why) && a.changedCount === 300 && a.ignoredChangedCount === 300 && a.changesFile === undefined && /take above 95000/.test(a.changesFileError || '') && !fs.existsSync(path.join(s.answers, `${id}.changes.json`)), J(a && { why: a.why, c: a.changedCount, i: a.ignoredChangedCount, e: a.changesFileError, file: a.changesFile }));
      await s.close();
    }
    {
      const f = build();
      const s = service(f, { walkMaxResultBytes: 300000 });
      const a = await answer(s, ask(s, ['n.txt']));
      const whole = a && a.changesFile ? readJson(a.changesFile) : null;
      const left = fs.readdirSync(s.answers).filter((n) => n.endsWith('.tmp'));
      ok('T21 the same lists within the limit: the file holds both whole, no error, no temporary file left beside it',
        whole && whole.changed.length === 300 && whole.ignoredChanged.length === 300 && a.changesFileError === undefined && left.length === 0, J({ left, e: a && a.changesFileError, file: a && a.changesFile }));
      await s.close();
    }
  }
  {
    // the gate counts bytes, a limit between the characters and the bytes of the list; each walk within it
    const seg = 'я'.repeat(100);
    const deep = (x) => `build/${seg}/${seg}${x}/${seg.slice(5)}`;
    const f = fixture(`rm -rf build/*; mkdir -p '${deep('b')}'; i=0; while [ $i -lt 101 ]; do : > '${deep('b')}'/$i; i=$((i+1)); done`);
    for (let i = 0; i < 101; i++) write(f, `${deep('a')}/${i}`, '');
    write(f, 'n.txt', 'n\n');
    const s = service(f, { walkMaxResultBytes: 90000 });
    const id = ask(s, ['n.txt']);
    const a = await answer(s, id);
    ok('T22 Cyrillic names: the list is below the limit in characters and above it in bytes -> no file, changesFileError, committed',
      a && a.status === 'committed' && a.ignoredChangedCount === 202 && a.changesFile === undefined && /take above 90000/.test(a.changesFileError || ''), J(a && { st: a.status, why: (a.why || '').slice(0, 200), n: a.ignoredChangedCount, e: a.changesFileError, file: a.changesFile }));
    await s.close();
  }
  {
    // the journal holds counts and short texts whatever the lists take
    const f = fixture('true');
    commitFiles(f, Array.from({ length: 40 }, (_, i) => `t/f${i}`), 'same\n');
    for (let i = 0; i < 40; i++) write(f, `build/c${i}`, 'same\n');
    const s = service(f, { walkMaxResultBytes: 8000 });
    const id = ask(s, ['n.txt']);
    const a = await answer(s, id);
    const lines = fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8').split('\n').filter((l) => l.includes(id) && l.includes('"result"'));
    ok('T23 a refusal by the budget: one result in the journal, a short line without a path of a copy', a && budgetOf(a) && lines.length === 1 && lines[0].length < 1000 && !lines[0].includes('build/c'), J({ lines: lines.map((l) => l.slice(0, 400)), why: a && a.why }));
    await s.close();
  }
  // ---- the answer cannot be written (a full disk stops the temporary file of the answer as it stops the file of the
  // lists): the status stays what the step decided, in the journal and in the answer once it can be written
  for (const [tag, hook, want] of [['committed', 'true', 'committed'], ['refused', 'echo x >> a.txt', 'refused']]) {
    const f = fixture(hook);
    const s = service(f);
    write(f, 'n.txt', 'n\n');
    const id = newId();
    fs.mkdirSync(path.join(s.answers, `${id}.json`));
    const tmp = path.join(s.box, `.${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ id, paths: ['n.txt'], message: 'msg' }));
    fs.renameSync(tmp, path.join(s.box, `${id}.json`));
    const results = () => fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.id === id && e.ev === 'result');
    const end = Date.now() + 15000;
    while (!results().length && Date.now() < end) await sleep(50);
    await sleep(1500);
    const res = results();
    const why0 = res.length ? res[0].why : null;
    fs.rmSync(path.join(s.answers, `${id}.json`), { recursive: true });
    const a = await answer(s, id, 10000);
    const moved = f.tip() !== f.h0;
    ok(`T24 ${tag}: the answer of a request cannot be written: one result in the journal, ${want}; the answer written later says the same${want === 'committed' ? ', with the sha of the moved branch' : ''}`,
      res.length === 1 && res[0].status === want && a && a.status === want && a.why === why0 && moved === (want === 'committed') && !/internal error/.test((a && a.why) || ''), J({ moved, res: res.map((e) => [e.status, (e.why || '').slice(0, 140)]), a: a && { status: a.status, sha: a.sha, why: (a.why || '').slice(0, 140) } }));
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
