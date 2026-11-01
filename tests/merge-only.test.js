#!/usr/bin/env node
'use strict';
// p-merge-docs (diagnosis (b) of p-select-precise, the owner took the recommendation, 2026-11-01): after a
// train verdict 13 (conflict) the programmer merges the arc head into the branch and resolves the conflict. When that
// round is the merge alone and every file it resolved by hand is docs - the project's mergeOnlyFiles globs - the
// workflow skips the selection on the new HEAD (it would rerun ~21 min of guards for a docs file the train runs anyway)
// and goes to the second review of the diff and the train. A conflict in code or a guard, or a hand edit outside docs
// in the merge commit, keeps the selection; without the key nothing changes.
//   scripts/merge-only.js <before> <head> --base <arc> [--wt <dir>] [--files <glob>]... -> JSON {mergeOnly, reason,
//   files}; exit 0 merge only, 1 not, 2 an error. The check: the first-parent commits of before..head are exactly head,
//   head is a merge whose first parent is before and whose second parent is an ancestor of the arc; the files where head
//   differs from the automatic merge of its parents (git merge-tree --write-tree) all match the globs.
// usage: node tests/merge-only.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-only.js');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-merge-only-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
let nRepo = 0;
function repo() {
  const d = path.join(tmp, `r${++nRepo}`);
  fs.mkdirSync(d);
  const git = (...a) => {
    const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: ENV });
    return { rc: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
  };
  const g = (...a) => { const r = git(...a); if (r.rc !== 0 && !(a[0] === 'merge')) throw new Error(`git ${a.join(' ')}: ${r.err}`); return r.out; };
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  const commit = (files, msg) => { for (const [f, s] of Object.entries(files)) write(f, s); g('add', '--', ...Object.keys(files)); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  g('init', '-q', '-b', 'main');
  commit({ 'docs/a.md': 'one\ntwo\nthree\n', 'src/code.js': 'a\nb\nc\n', 'src/other.js': 'x\n', 'sub/NOTES.md': 'n\n', 'src/arc-only.js': '1\n' }, 'base');
  return { d, g, write, commit };
}
function run(r, args) {
  const x = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: ENV, cwd: r ? r.d : tmp });
  let j = null; try { j = JSON.parse(x.stdout); } catch { /* not JSON */ }
  return { rc: x.status, j, out: x.stdout, err: x.stderr };
}
const FILES = ['--files', '*.md', '--files', 'docs/**'];
// The arc changes docs/a.md, src/code.js and src/arc-only.js; the task branch changes what the case needs; the train
// said conflict; the programmer merges the arc into the branch (git merge), resolves as the case says and commits.
function scene({ taskFiles, resolve = {}, extra = {} }) {
  const r = repo();
  r.g('checkout', '-q', '-b', 'arc');
  r.commit({ 'docs/a.md': 'one\nARC\nthree\n', 'src/code.js': 'a\nARC\nc\n', 'src/arc-only.js': 'arc\n' }, 'arc work');
  r.g('checkout', '-q', '-b', 'task', 'main');
  const before = r.commit(taskFiles, 'task work');
  r.g('merge', '-q', '--no-commit', '--no-ff', 'arc');
  const all = Object.assign({}, resolve, extra);
  for (const [f, s] of Object.entries(all)) r.write(f, s);
  if (Object.keys(all).length) r.g('add', '--', ...Object.keys(all));
  r.g('commit', '-q', '--no-edit');
  return { r, before, head: r.g('rev-parse', 'HEAD') };
}
const DOCS_CONFLICT = { taskFiles: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/other.js': 'task\n' }, resolve: { 'docs/a.md': 'one\nTASK and ARC\nthree\n' } };

(async () => {
  ok('scripts/merge-only.js exists', fs.existsSync(SCRIPT), SCRIPT);

  // ---- M1: a conflict only in docs, resolved by hand -> merge only ----
  let s = scene(DOCS_CONFLICT);
  let x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M1. conflict only in docs/a.md, resolved by hand -> exit 0, mergeOnly true, files [docs/a.md]',
    x.rc === 0 && x.j && x.j.mergeOnly === true && JSON.stringify(x.j.files) === '["docs/a.md"]', `${x.rc} ${x.out} ${x.err}`);
  // the code the arc brought cleanly (src/code.js, src/arc-only.js) is not a hand edit of the merge
  ok('M1. code the arc brought without a conflict is not counted', x.j && !(x.j.files || []).some((f) => /^src\//.test(f)), x.out);
  // --wt instead of the cwd
  x = spawnSync(process.execPath, [SCRIPT, s.before, s.head, '--base', 'arc', '--wt', s.r.d, ...FILES], { encoding: 'utf8', env: ENV, cwd: tmp });
  ok('M1. --wt names the worktree (the cwd is elsewhere)', x.status === 0 && /"mergeOnly":\s*true/.test(x.stdout), `${x.status} ${x.stdout} ${x.stderr}`);
  // a glob without "/" matches the file name at any depth
  s = scene({ taskFiles: { 'sub/NOTES.md': 'task\n' }, extra: { 'sub/NOTES.md': 'task and more\n' } });
  x = run(s.r, [s.before, s.head, '--base', 'arc', '--files', '*.md']);
  ok('M1. a glob without "/" (*.md) matches sub/NOTES.md at any depth', x.rc === 0 && x.j && x.j.mergeOnly === true, x.out);

  // ---- M2: a conflict in code -> not merge only ----
  s = scene({ taskFiles: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/code.js': 'a\nTASK\nc\n' },
    resolve: { 'docs/a.md': 'one\nTASK and ARC\nthree\n', 'src/code.js': 'a\nTASK and ARC\nc\n' } });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M2. conflict in src/code.js too -> exit 1, mergeOnly false, src/code.js named',
    x.rc === 1 && x.j && x.j.mergeOnly === false && (x.j.files || []).includes('src/code.js') && /src\/code\.js/.test(x.j.reason || ''), x.out);

  // ---- M3: a hand edit of code in the merge commit -> not merge only ----
  s = scene(Object.assign({}, DOCS_CONFLICT, { extra: { 'src/other.js': 'task + a hand edit\n' } }));
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M3. docs conflict + a hand edit of src/other.js in the merge -> exit 1, src/other.js named',
    x.rc === 1 && x.j && x.j.mergeOnly === false && (x.j.files || []).includes('src/other.js'), x.out);
  // a hand edit of a file the arc brought cleanly
  s = scene(Object.assign({}, DOCS_CONFLICT, { extra: { 'src/arc-only.js': 'arc + edit\n' } }));
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M3. a hand edit of src/arc-only.js (the arc changed it, no conflict) -> exit 1', x.rc === 1 && x.j && (x.j.files || []).includes('src/arc-only.js'), x.out);
  // a new code file added in the merge commit
  s = scene(Object.assign({}, DOCS_CONFLICT, { extra: { 'src/new.js': 'new\n' } }));
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M3. a new src/new.js added in the merge -> exit 1', x.rc === 1 && x.j && (x.j.files || []).includes('src/new.js'), x.out);

  // ---- M4: without globs (no mergeOnlyFiles) -> not merge only, as before ----
  s = scene(DOCS_CONFLICT);
  x = run(s.r, [s.before, s.head, '--base', 'arc']);
  ok('M4. no --files -> exit 1, mergeOnly false, the reason names mergeOnlyFiles', x.rc === 1 && x.j && x.j.mergeOnly === false && /mergeOnlyFiles is not set/.test(x.j.reason || ''), x.out);
  // a merge with nothing resolved by hand: without the key it is still no (the key is off, not "every file matches")
  s = scene({ taskFiles: { 'src/other.js': 'task\n' } });
  x = run(s.r, [s.before, s.head, '--base', 'arc']);
  ok('M4. a clean merge (nothing by hand) without --files -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('M4. the same clean merge with --files -> exit 0, files []', x.rc === 0 && x.j && x.j.mergeOnly === true && (x.j.files || []).length === 0, x.out);

  // ---- M5: the round is not one merge ----
  s = scene(DOCS_CONFLICT);
  const after = s.r.commit({ 'docs/a.md': 'later\n' }, 'a docs commit after the merge');
  x = run(s.r, [s.before, after, '--base', 'arc', ...FILES]);
  ok('M5. a commit after the merge (two first-parent commits) -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);
  const r5 = repo();
  const b5 = r5.g('rev-parse', 'HEAD');
  const h5 = r5.commit({ 'docs/a.md': 'plain\n' }, 'plain docs commit');
  x = run(r5, [b5, h5, '--base', 'main', ...FILES]);
  ok('M5. a plain commit (not a merge) -> exit 1, the reason says not a merge', x.rc === 1 && x.j && x.j.mergeOnly === false && /merge/.test(x.j.reason || ''), x.out);
  x = run(s.r, [s.head, s.head, '--base', 'arc', ...FILES]);
  ok('M5. no new commit (before = head) -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- M6: the second parent is not the arc ----
  const r6 = repo();
  r6.g('checkout', '-q', '-b', 'arc');
  r6.commit({ 'docs/a.md': 'arc\n' }, 'arc');
  r6.g('checkout', '-q', '-b', 'side', 'main');
  r6.commit({ 'docs/a.md': 'side\n' }, 'side');
  r6.g('checkout', '-q', '-b', 'task', 'main');
  const b6 = r6.commit({ 'docs/b.md': 't\n' }, 'task');
  r6.g('merge', '-q', '--no-edit', '--no-ff', 'side');
  const h6 = r6.g('rev-parse', 'HEAD');
  x = run(r6, [b6, h6, '--base', 'arc', ...FILES]);
  ok('M6. a merge of a branch that is not in the arc -> exit 1, the reason names the arc', x.rc === 1 && x.j && x.j.mergeOnly === false && /arc|ancestor/.test(x.j.reason || ''), x.out);

  // ---- M7: the first parent is not before (the merge sits on another line) ----
  s = scene(DOCS_CONFLICT);
  const main0 = s.r.g('rev-parse', 'main');
  x = run(s.r, [main0, s.head, '--base', 'arc', ...FILES]);
  ok('M7. before is not the first parent of the merge -> exit 1', x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- M8: errors -> exit 2 with JSON ----
  s = scene(DOCS_CONFLICT);
  x = run(s.r, [s.before, s.head, ...FILES]);
  ok('M8. no --base -> exit 2 with an error', x.rc === 2 && x.j && x.j.mergeOnly === false && !!x.j.error, `${x.rc} ${x.out}`);
  x = run(s.r, ['deadbeef', s.head, '--base', 'arc', ...FILES]);
  ok('M8. an unknown before -> exit 2 with an error', x.rc === 2 && x.j && x.j.mergeOnly === false && !!x.j.error, `${x.rc} ${x.out}`);
  x = run(s.r, [s.before, s.head, '--base', 'no-such-arc', ...FILES]);
  ok('M8. an unknown base -> exit 2 with an error', x.rc === 2 && x.j && x.j.mergeOnly === false && !!x.j.error, `${x.rc} ${x.out}`);

  // ---- the config key: mergeOnlyFiles, default [] (off) ----
  const C = require('../scripts/config');
  const base0 = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
  let c = C.resolve(base0);
  ok('C1. mergeOnlyFiles defaults to [] - the selection is never skipped without the key', Array.isArray(c.config.mergeOnlyFiles) && c.config.mergeOnlyFiles.length === 0 && !c.errors.length, JSON.stringify(c.config.mergeOnlyFiles));
  c = C.resolve(Object.assign({}, base0, { mergeOnlyFiles: ['*.md', 'docs/**'] }));
  ok('C1. mergeOnlyFiles is taken as given', !c.errors.length && JSON.stringify(c.config.mergeOnlyFiles) === '["*.md","docs/**"]', c.errors.join('; '));
  c = C.resolve(Object.assign({}, base0, { mergeOnlyFiles: ['*.md', ''] }));
  ok('C1. an empty glob in mergeOnlyFiles is an error', c.errors.some((e) => /mergeOnlyFiles/.test(e)), c.errors.join('; '));
  ok('C1. the schema documents mergeOnlyFiles', /"mergeOnlyFiles"/.test(read('schemas/codis-agents.schema.json')));

  // ---- the workflow: the train fix round after a conflict ----
  const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
    protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json', guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
  const MO = Object.assign({}, CFG, { mergeOnlyFiles: ['*.md', 'docs/**'] });
  const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
  const PRE = { ok: true, problems: [], blockingQuestions: [] };
  const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
  const P2 = Object.assign({}, PROG, { head: 'P2', changedFiles: ['docs/GAPS.md'] }), P3 = Object.assign({}, PROG, { head: 'P3' });
  const D = { verdict: 'done', docsOnly: false, summary: 'fine' };
  const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
  const ride = (rc) => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail: '' });
  const YES = { mergeOnly: true, reason: 'one merge of the arc; resolved by hand: docs/GAPS.md', files: ['docs/GAPS.md'] };
  const NO = { mergeOnly: false, reason: 'resolved by hand outside mergeOnlyFiles: src/a.js', files: ['src/a.js'] };
  async function chain(script, config) {
    const full = [], prompts = [];
    const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
    const agent = async (prompt, opts) => {
      const role = opts.label.split(':')[0];
      prompts.push({ role, label: opts.label, prompt, opts });
      full.push(['diff', 'left', 'post', 'run', 'merge'].includes(role) ? opts.label : role);
      if (role === 'diff') return { ok: true, offending: [] };
      if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
      if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
      if (role === 'run') {
        if (/:train-/.test(opts.label)) {
          if (!q.train || !q.train.length) throw new Error('extra train step after ' + full.join('>'));
          return q.train.shift();
        }
        return OKR;
      }
      if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + full.join('>'));
      const v = q[role].shift();
      return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
    };
    let res;
    try {
      res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
        agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config, tasks: [T] });
    } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
    return { r: res[0], full: full.join('>'), prompts };
  }
  const HEAD = 'pre>prog>run:x:select-1>test>post:x:tester>review>diff:x:reviewer>run:x:train-1>prog';
  const pOf = (x, role, i = 0) => (x.prompts.filter((p) => p.role === role)[i] || { prompt: '' }).prompt;
  const unq = (s) => s.split("'\\''").join("'");
  const G = (train, more) => Object.assign({ pre: [PRE], prog: [PROG, P2], test: [{ verdict: 'green', summary: '' }], review: [D, D], train }, more);

  // W-MO1: conflict, the round is a docs-only merge -> no selection, review, train
  x = await chain(G([ride(13), ride(0)], { merge: [YES] }), MO);
  ok('W-MO1. conflict + mergeOnlyFiles + merge-only.js says yes -> no selection: merge check -> review -> train -> done',
    x.r.status === 'done' && x.full === `${HEAD}>merge:x:t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, `${x.full} ${JSON.stringify(x.r)}`);
  const mp = unq(pOf(x, 'merge'));
  ok('W-MO1. the check runs scripts/merge-only.js with the head before the round, the new head, the arc, the worktree and the globs',
    mp.includes("node /p/scripts/merge-only.js 'T' 'P2' --base 'arc' --wt '/w' --files '*.md' --files 'docs/**'"), mp);
  const mo = x.prompts.find((p) => p.role === 'merge');
  ok('W-MO1. the check is a cheap service step', !!mo && mo.opts.model === 'haiku' && mo.opts.phase === 'Train', JSON.stringify(mo && mo.opts));
  ok('W-MO1. the second review is told the selection was skipped for a docs-only merge and reads the diff of the round',
    /merge-only docs: selection skipped/.test(pOf(x, 'review', 1)) && /T\.\.P2/.test(pOf(x, 'review', 1)), pOf(x, 'review', 1));
  ok('W-MO1. the conflict round tells the programmer that a docs-only merge skips the selection', /mergeOnlyFiles/.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));

  // W-MO2: conflict, a conflict or a hand edit in code -> the selection as now
  x = await chain(G([ride(13), ride(0)], { merge: [NO] }), MO);
  ok('W-MO2. merge-only.js says no -> the selection runs: merge check -> select-t1 -> review -> train',
    x.r.status === 'done' && x.full === `${HEAD}>merge:x:t1>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  ok('W-MO2. the review gets no "selection skipped"', !/selection skipped/.test(pOf(x, 'review', 1)), pOf(x, 'review', 1));

  // W-MO3: without the key -> no check, the selection as now
  x = await chain(G([ride(13), ride(0)]), CFG);
  ok('W-MO3. without mergeOnlyFiles -> no merge check, the selection as before',
    x.r.status === 'done' && x.full === `${HEAD}>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  ok('W-MO3. without the key the conflict round says nothing of mergeOnlyFiles', !/mergeOnlyFiles/.test(pOf(x, 'prog', 1)), pOf(x, 'prog', 1));
  x = await chain(G([ride(13), ride(0)]), Object.assign({}, CFG, { mergeOnlyFiles: [] }));
  ok('W-MO3. mergeOnlyFiles [] -> no merge check', x.r.status === 'done' && !/merge:x/.test(x.full) && /select-t1/.test(x.full), x.full);

  // W-MO4: a red or a seam train -> no check even with the key
  x = await chain(G([ride(11), ride(0)]), MO);
  ok('W-MO4. red train -> no merge check, the selection', x.r.status === 'done' && !/merge:x/.test(x.full) && /select-t1/.test(x.full), x.full);
  x = await chain(G([ride(12), ride(0)]), MO);
  ok('W-MO4. seam -> no merge check, the selection', x.r.status === 'done' && !/merge:x/.test(x.full) && /select-t1/.test(x.full), x.full);

  // W-MO5: the check fails twice (no JSON) -> the selection (never skipped on doubt)
  x = await chain(G([ride(13), ride(0)], { merge: [{ error: 'boom' }, null] }), MO);
  ok('W-MO5. the check fails twice -> repeated once, then the selection runs',
    x.r.status === 'done' && x.full === `${HEAD}>merge:x:t1>merge:x:t1#retry>run:x:select-t1>review>diff:x:reviewer>run:x:train-2>left:x:end`, x.full);
  x = await chain(G([ride(13), ride(0)], { merge: [{ error: 'boom' }, YES] }), MO);
  ok('W-MO5. the first attempt fails, the repeat says yes -> no selection', x.r.status === 'done' && !/select-t1/.test(x.full), x.full);

  // W-MO6: a second conflict after a skipped selection: the next round is checked again on its own head
  x = await chain(G([ride(13), ride(13), ride(0)], { prog: [PROG, P2, P3], review: [D, D, D], merge: [YES, NO] }), MO);
  ok('W-MO6. two conflicts: the first round skips, the second (code) runs its selection',
    x.r.status === 'done' && x.full === `${HEAD}>merge:x:t1>review>diff:x:reviewer>run:x:train-2>prog>merge:x:t2>run:x:select-t2>review>diff:x:reviewer>run:x:train-3>left:x:end`, x.full);
  ok('W-MO6. the second check names P2..P3', unq(pOf(x, 'merge', 1)).includes("merge-only.js 'P2' 'P3'"), pOf(x, 'merge', 1));

  // W-MO7: a skipped selection, then a red train -> the selection on the head of that round
  x = await chain(G([ride(13), ride(11), ride(0)], { prog: [PROG, P2, P3], review: [D, D, D], merge: [YES] }), MO);
  ok('W-MO7. after a skipped selection a red train gets its selection on the new head', x.r.status === 'done' && /run:x:train-2>prog>run:x:select-t2/.test(x.full), x.full);

  // ---- the rules and the README name it (living specs) ----
  const flat = (f) => read(f).replace(/\s+/g, ' ');
  ok('R1. rules/multi-agent.md: the train rule names merge-only.js and mergeOnlyFiles', /merge-only\.js/.test(flat('rules/multi-agent.md')) && /mergeOnlyFiles/.test(flat('rules/multi-agent.md')));
  ok('R1. README names merge-only.js and the key mergeOnlyFiles', /merge-only\.js/.test(flat('README.md')) && /`mergeOnlyFiles`/.test(flat('README.md')));
  done();
})();
