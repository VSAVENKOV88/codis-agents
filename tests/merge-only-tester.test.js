#!/usr/bin/env node
'use strict';
// p-merge-docs, tester round 1: cells of scripts/merge-only.js the programmer's test does not hold.
// The brief: "a conflict in code or a guard - the selection as now". A conflict is a conflict even when its resolution
// equals what git merge-tree --write-tree puts into its tree for it: a modify/delete conflict (the tree keeps the
// modified file), a binary conflict (the tree keeps the first side), or a text conflict committed with the very markers
// of merge-tree. Such a round must not skip the selection.
//   T1  modify/delete conflict in code, resolved by keeping the branch's file          -> exit 1
//   T2  binary conflict in code, resolved by the branch's side (git checkout --ours)   -> exit 1
//   T3  text conflict in code committed with the markers merge-tree writes              -> exit 1
//   T4  docs path with non-ASCII characters (quotepath), conflict only there           -> exit 0
//   T5  a code file renamed into a docs path in the merge commit                        -> exit 1
//   T6  an octopus merge (three parents)                                                -> exit 1
//   T7  a mode change (chmod +x) of a code file in the merge commit                     -> exit 1
//   T8  modify/delete conflict in docs only, resolved by keeping                        -> exit 0
// Round 2 (the conflicted list of merge-tree --name-only -z joins the diff):
//   T9  directory/file conflict in code (arc adds file src/x, branch adds src/x/a.js)  -> exit 1
//   T10 rename/rename conflict in code (both sides rename src/code.js differently)     -> exit 1
//   T11 docs conflict while the arc renamed src/code.js cleanly and the branch edited it -> exit 0 (no code conflict)
//   T12 two docs conflicts with spaces and a non-ASCII name, nothing in code            -> exit 0, both named once
//   T13 docs conflict resolved by git merge -X ours (no hand edit), code auto-merged    -> exit 0
// usage: node tests/merge-only-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-only.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-merge-only-t-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });
let nRepo = 0;
function repo(base) {
  const d = path.join(tmp, `r${++nRepo}`);
  fs.mkdirSync(d);
  const git = (...a) => {
    const r = spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env: ENV });
    return { rc: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' };
  };
  const g = (...a) => { const r = git(...a); if (r.rc !== 0) throw new Error(`git ${a.join(' ')}: ${r.err}`); return r.out; };
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  const commit = (files, msg, rm = []) => {
    for (const [f, s] of Object.entries(files)) write(f, s);
    if (Object.keys(files).length) g('add', '--', ...Object.keys(files));
    if (rm.length) g('rm', '-q', '--', ...rm);
    g('commit', '-q', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('init', '-q', '-b', 'main');
  commit(base, 'base');
  return { d, g, git, write, commit };
}
function run(r, args) {
  const x = spawnSync(process.execPath, [SCRIPT, ...args, '--wt', r.d], { encoding: 'utf8', env: ENV, cwd: tmp });
  let j = null; try { j = JSON.parse(x.stdout); } catch { /* not JSON */ }
  return { rc: x.status, j, out: `${x.status} ${x.stdout} ${x.stderr}` };
}
const FILES = ['--files', '*.md', '--files', 'docs/**'];
// arc and task diverge from main; the task merges the arc (conflicts allowed), resolve() fixes the working tree and
// stages, then the merge is committed.
function scene(base, arc, task, resolve) {
  const r = repo(base);
  r.g('checkout', '-q', '-b', 'arc');
  r.commit(arc.files || {}, 'arc work', arc.rm || []);
  r.g('checkout', '-q', '-b', 'task', 'main');
  const before = r.commit(task.files || {}, 'task work', task.rm || []);
  r.git('merge', '-q', '--no-commit', '--no-ff', 'arc');
  resolve(r);
  r.g('commit', '-q', '--no-edit');
  return { r, before, head: r.g('rev-parse', 'HEAD') };
}
const docsBoth = (r) => { r.write('docs/a.md', 'one\nTASK and ARC\nthree\n'); r.g('add', '--', 'docs/a.md'); };
const BASE = { 'docs/a.md': 'one\ntwo\nthree\n', 'src/code.js': 'a\nb\nc\n', 'src/gone.js': 'g\n', 'src/img.bin': Buffer.from([0, 1, 2]) };

(async () => {
  // ---- T1: modify/delete conflict in code ----
  let s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n' }, rm: ['src/gone.js'] },
    { files: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/gone.js': 'g\ntask\n' } },
    (r) => { docsBoth(r); r.g('add', '--', 'src/gone.js'); });
  let x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T1. modify/delete conflict in src/gone.js resolved by keeping the file -> exit 1, not merge only (a conflict in code)',
    x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- T2: binary conflict in code ----
  s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n', 'src/img.bin': Buffer.from([0, 9, 9, 1]) } },
    { files: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/img.bin': Buffer.from([0, 7, 7, 2]) } },
    (r) => { docsBoth(r); r.g('checkout', '--ours', '--', 'src/img.bin'); r.g('add', '--', 'src/img.bin'); });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T2. binary conflict in src/img.bin resolved by the branch side -> exit 1, not merge only (a conflict in code)',
    x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- T3: text conflict in code committed with merge-tree's own markers ----
  s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n', 'src/code.js': 'a\nARC\nc\n' } },
    { files: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/code.js': 'a\nTASK\nc\n' } },
    (r) => {
      docsBoth(r);
      const tree = r.git('merge-tree', '--write-tree', '--no-messages', r.g('rev-parse', 'HEAD'), r.g('rev-parse', 'arc')).out.split('\n')[0];
      r.write('src/code.js', r.g('show', `${tree}:src/code.js`) + '\n');
      r.g('add', '--', 'src/code.js');
    });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T3. conflict markers of merge-tree committed in src/code.js -> exit 1, not merge only (a conflict in code)',
    x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- T4: non-ASCII docs path ----
  const NA = 'docs/café-ü.md';
  s = scene(Object.assign({}, BASE, { [NA]: 'p\nq\nr\n' }), { files: { [NA]: 'p\nARC\nr\n' } }, { files: { [NA]: 'p\nTASK\nr\n' } },
    (r) => { r.write(NA, 'p\nTASK ARC\nr\n'); r.g('add', '--', NA); });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T4. conflict only in a docs file with a non-ASCII name -> exit 0, the name unquoted in files',
    x.rc === 0 && x.j && x.j.mergeOnly === true && JSON.stringify(x.j.files) === JSON.stringify([NA]), x.out);

  // ---- T5: a code file renamed into docs in the merge commit ----
  s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n' } }, { files: { 'docs/a.md': 'one\nTASK\nthree\n' } },
    (r) => { docsBoth(r); r.g('mv', 'src/code.js', 'docs/code.md'); });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T5. src/code.js moved to docs/code.md in the merge -> exit 1, src/code.js named',
    x.rc === 1 && x.j && x.j.mergeOnly === false && (x.j.files || []).includes('src/code.js'), x.out);

  // ---- T6: octopus merge ----
  {
    const r = repo(BASE);
    r.g('checkout', '-q', '-b', 'arc');
    r.commit({ 'docs/arc.md': 'arc\n' }, 'arc');
    r.g('checkout', '-q', '-b', 'side', 'main');
    r.commit({ 'docs/side.md': 'side\n' }, 'side');
    r.g('checkout', '-q', '-b', 'task', 'main');
    const before = r.commit({ 'docs/task.md': 'task\n' }, 'task');
    r.g('merge', '-q', '--no-edit', 'arc', 'side');
    const head = r.g('rev-parse', 'HEAD');
    x = run(r, [before, head, '--base', 'arc', ...FILES]);
    ok('T6. an octopus merge (three parents) -> exit 1, the reason names more than two parents',
      x.rc === 1 && x.j && x.j.mergeOnly === false && /more than two/.test(x.j.reason || ''), x.out);
  }

  // ---- T7: mode change of a code file in the merge ----
  s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n' } }, { files: { 'docs/a.md': 'one\nTASK\nthree\n' } },
    (r) => { docsBoth(r); r.g('update-index', '--chmod=+x', 'src/code.js'); });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T7. chmod +x of src/code.js in the merge -> exit 1, src/code.js named',
    x.rc === 1 && x.j && x.j.mergeOnly === false && (x.j.files || []).includes('src/code.js'), x.out);

  // ---- T8: modify/delete conflict in docs only ----
  s = scene(Object.assign({}, BASE, { 'docs/old.md': 'o\n' }), { files: { 'docs/a.md': 'one\nARC\nthree\n' }, rm: ['docs/old.md'] },
    { files: { 'docs/a.md': 'one\nTASK\nthree\n', 'docs/old.md': 'o\ntask\n' } },
    (r) => { docsBoth(r); r.g('add', '--', 'docs/old.md'); });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T8. modify/delete conflict in docs/old.md (docs only), kept -> exit 0, merge only',
    x.rc === 0 && x.j && x.j.mergeOnly === true, x.out);

  // ---- T9: directory/file conflict in code ----
  s = scene(BASE, { files: { 'docs/a.md': 'one\nARC\nthree\n', 'src/x': 'file\n' } },
    { files: { 'docs/a.md': 'one\nTASK\nthree\n', 'src/x/a.js': 'dir\n' } },
    (r) => {
      docsBoth(r);
      // keep both: the branch's directory stays, the arc's file goes to the name git gave it (src/x~arc)
      const st = r.git('status', '--porcelain').out;
      for (const line of st.split('\n')) { const f = line.slice(3); if (f && !/^docs\//.test(f)) r.git('add', '--', f); }
      r.git('add', '-A', '--', 'src');
    });
  x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
  ok('T9. directory/file conflict at src/x (code) -> exit 1, not merge only',
    x.rc === 1 && x.j && x.j.mergeOnly === false && (x.j.files || []).some((f) => /^src\//.test(f)), x.out);

  // ---- T10: rename/rename conflict in code ----
  x = { rc: -1 };
  {
    const r = repo(BASE);
    r.g('checkout', '-q', '-b', 'arc');
    r.write('docs/a.md', 'one\nARC\nthree\n'); r.g('add', '--', 'docs/a.md'); r.g('mv', 'src/code.js', 'src/arc-name.js');
    r.g('commit', '-q', '-m', 'arc');
    r.g('checkout', '-q', '-b', 'task', 'main');
    r.write('docs/a.md', 'one\nTASK\nthree\n'); r.g('add', '--', 'docs/a.md'); r.g('mv', 'src/code.js', 'src/task-name.js');
    r.g('commit', '-q', '-m', 'task');
    const before = r.g('rev-parse', 'HEAD');
    r.git('merge', '-q', '--no-commit', '--no-ff', 'arc');
    docsBoth(r);
    // resolution: keep the branch's name only (what merge-tree's tree may not hold)
    r.git('rm', '-q', '--cached', '--ignore-unmatch', '--', 'src/code.js', 'src/arc-name.js');
    try { fs.rmSync(path.join(r.d, 'src/arc-name.js'), { force: true }); } catch { /* none */ }
    r.g('add', '--', 'src/task-name.js');
    r.g('commit', '-q', '--no-edit');
    x = run(r, [before, r.g('rev-parse', 'HEAD'), '--base', 'arc', ...FILES]);
  }
  ok('T10. rename/rename conflict of src/code.js -> exit 1, not merge only',
    x.rc === 1 && x.j && x.j.mergeOnly === false, x.out);

  // ---- T11: the arc renamed code cleanly, the branch edited it: no code conflict ----
  {
    const r = repo(BASE);
    r.g('checkout', '-q', '-b', 'arc');
    r.write('docs/a.md', 'one\nARC\nthree\n'); r.g('add', '--', 'docs/a.md'); r.g('mv', 'src/code.js', 'src/moved.js');
    r.g('commit', '-q', '-m', 'arc');
    r.g('checkout', '-q', '-b', 'task', 'main');
    const before = r.commit({ 'docs/a.md': 'one\nTASK\nthree\n', 'src/code.js': 'a\nb\nc\nTASK\n' }, 'task');
    r.git('merge', '-q', '--no-commit', '--no-ff', 'arc');
    docsBoth(r);
    r.g('commit', '-q', '--no-edit');
    x = run(r, [before, r.g('rev-parse', 'HEAD'), '--base', 'arc', ...FILES]);
    ok('T11. arc renamed src/code.js, the branch edited it, docs conflict -> exit 0, files [docs/a.md]',
      x.rc === 0 && x.j && x.j.mergeOnly === true && JSON.stringify(x.j.files) === '["docs/a.md"]', x.out);
  }

  // ---- T12: two docs conflicts, names with spaces and non-ASCII ----
  {
    const A = 'docs/with space.md', B = 'docs/na\u00efve r\u00e9sum\u00e9.md';
    s = scene(Object.assign({}, BASE, { [A]: '1\n2\n3\n', [B]: '1\n2\n3\n' }),
      { files: { [A]: '1\nARC\n3\n', [B]: '1\nARC\n3\n', 'src/code.js': 'ARC\nb\nc\n' } },
      { files: { [A]: '1\nTASK\n3\n', [B]: '1\nTASK\n3\n' } },
      (r) => { for (const f of [A, B]) { r.write(f, '1\nTASK ARC\n3\n'); r.g('add', '--', f); } });
    x = run(s.r, [s.before, s.head, '--base', 'arc', ...FILES]);
    ok('T12. two docs conflicts (space, non-ASCII), arc code clean -> exit 0, both named once',
      x.rc === 0 && x.j && x.j.mergeOnly === true && JSON.stringify([...(x.j.files || [])].sort()) === JSON.stringify([A, B].sort()), x.out);
  }

  // ---- T13: docs conflict resolved by -X ours (no hand edit), code auto-merged ----
  {
    const r = repo(BASE);
    r.g('checkout', '-q', '-b', 'arc');
    r.commit({ 'docs/a.md': 'one\nARC\nthree\n', 'src/code.js': 'ARC\nb\nc\n' }, 'arc');
    r.g('checkout', '-q', '-b', 'task', 'main');
    const before = r.commit({ 'docs/a.md': 'one\nTASK\nthree\n', 'src/code.js': 'a\nb\nTASK\n' }, 'task');
    r.g('merge', '-q', '--no-edit', '-X', 'ours', 'arc');
    x = run(r, [before, r.g('rev-parse', 'HEAD'), '--base', 'arc', ...FILES]);
    ok('T13. docs conflict resolved by -X ours, src/code.js merged cleanly -> exit 0, files [docs/a.md]',
      x.rc === 0 && x.j && x.j.mergeOnly === true && JSON.stringify(x.j.files) === '["docs/a.md"]', x.out);
  }

  done();
})().catch((e) => { console.error(e); process.exit(1); });
