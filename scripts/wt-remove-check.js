#!/usr/bin/env node
'use strict';
// Prints what goes with a worktree or a data directory before it is removed; removes nothing.
// usage: wt-remove-check.js <path> [--search <dir>]...
//   1. data inside that git does not track: ignored entries (git status --ignored --porcelain) and untracked or
//      modified ones, each with its size (du -sk). A path outside any git repository: all its entries with sizes.
//   2. the path named in code: git grep -F (tracked and untracked files) for the absolute path and its ~/ form, in every
//      git checkout among the roots.
//   3. symbolic links outside the path that lead into it: find <root> -type l, each resolved with readlink.
// Roots: the parent directory of the path, every worktree of its repository (git worktree list), and each --search dir.
// The roots are printed: a reference outside them is not seen. Exit 0 with the report, 2 on a usage error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const search = [];
let target = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--search') search.push(args[++i]);
  else if (!target) target = args[i];
  else { console.error('unexpected argument: ' + args[i]); process.exit(2); }
}
if (!target || search.some((s) => !s)) { console.error('usage: wt-remove-check.js <path> [--search <dir>]...'); process.exit(2); }
if (!fs.existsSync(target)) { console.error('no such path: ' + target); process.exit(2); }
target = fs.realpathSync(target);

const run = (cmd, a, cwd) => spawnSync(cmd, a, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const git = (cwd, ...a) => run('git', ['-C', cwd, ...a]);
const inside = (p) => p === target || p.startsWith(target + path.sep);
const sizeKB = (p) => { const r = run('du', ['-sk', p]); return r.status === 0 ? parseInt(r.stdout, 10) : null; };
const fmt = (kb) => (kb == null ? '? KB' : kb >= 1024 * 1024 ? (kb / 1024 / 1024).toFixed(1) + ' GB (' + kb + ' KB)'
  : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB (' + kb + ' KB)' : kb + ' KB');
const stat = fs.statSync(target);
const dir = stat.isDirectory() ? target : path.dirname(target);

console.log('path: ' + target);

// 1. Data git does not track.
const top = git(dir, 'rev-parse', '--show-toplevel');
let worktrees = [];
if (top.status !== 0) {
  console.log('\n1. not in a git repository - every entry is listed:');
  const entries = stat.isDirectory() ? fs.readdirSync(target).map((e) => path.join(target, e)) : [target];
  if (!entries.length) console.log('   (empty)');
  for (const e of entries.sort()) console.log(`   ${fmt(sizeKB(e)).padEnd(24)} ${path.relative(dir, e) || path.basename(e)}`);
  console.log(`   total ${fmt(sizeKB(target))}`);
} else {
  const root = fs.realpathSync(top.stdout.trim());
  const st = git(root, 'status', '--ignored', '--porcelain', '-z', '--', path.relative(root, target) || '.');
  const rows = st.stdout.split('\0').filter(Boolean).filter((l) => /^(!!|\?\?|[ MADRCU][ MADRCU]) /.test(l));
  const ign = rows.filter((l) => l.startsWith('!! ')), other = rows.filter((l) => !l.startsWith('!! '));
  console.log(`\n1. repository ${root}`);
  console.log(`   ignored (git status --porcelain does not show these): ${ign.length || 'none'}`);
  for (const l of ign) { const p = l.slice(3); console.log(`   ${fmt(sizeKB(path.join(root, p))).padEnd(24)} ${p}`); }
  console.log(`   untracked or changed: ${other.length || 'none'}`);
  for (const l of other) { const p = l.slice(3); console.log(`   ${l.slice(0, 2)} ${fmt(sizeKB(path.join(root, p))).padEnd(21)} ${p}`); }
  console.log(`   total size of the path ${fmt(sizeKB(target))}`);
  const wl = git(root, 'worktree', 'list', '--porcelain');
  worktrees = wl.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
    .filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p));
}

// Roots for 2 and 3; a root inside the path is the path itself and goes with it.
const roots = [...new Set([path.dirname(target), ...worktrees, ...search.map((s) => fs.realpathSync(s))])]
  .filter((r) => !inside(r));
console.log('\nsearched roots (a reference outside them is not seen):');
for (const r of roots) console.log('   ' + r);

// 2. The path named in code.
const home = os.homedir();
const needles = [target].concat(target.startsWith(home + path.sep) ? ['~' + target.slice(home.length)] : []);
const checkouts = [...new Set(roots.map((r) => git(r, 'rev-parse', '--show-toplevel'))
  .filter((r) => r.status === 0).map((r) => fs.realpathSync(r.stdout.trim())))].filter((r) => !inside(r));
const refs = [];
for (const c of checkouts) {
  const r = git(c, 'grep', '-n', '-I', '-F', '--untracked', ...needles.flatMap((n) => ['-e', n]));
  for (const l of r.stdout.split('\n').filter(Boolean)) refs.push(path.join(c, l));
}
console.log(`\n2. the path named in code (git grep -F ${needles.map((n) => JSON.stringify(n)).join(' ')}): ${refs.length || 'none'}`);
for (const l of refs) console.log('   ' + (l.length > 300 ? l.slice(0, 300) + '...' : l));

// 3. Symbolic links outside the path that lead into it.
const links = [];
for (const r of roots) {
  const f = run('find', [r, '-path', target, '-prune', '-o', '-type', 'l', '-print0']);
  for (const l of f.stdout.split('\0').filter(Boolean)) {
    if (inside(l)) continue;
    let to;
    try { to = fs.readlinkSync(l); } catch { continue; }
    const abs = path.resolve(path.dirname(l), to);
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* broken or not yet resolvable: judge by the written target */ }
    if (inside(abs) || inside(real)) links.push(`${l} -> ${to}`);
  }
}
const uniq = [...new Set(links)];
console.log(`\n3. symbolic links that lead into the path (find -type l, readlink): ${uniq.length || 'none'}`);
for (const l of uniq.slice(0, 200)) console.log('   ' + l);
if (uniq.length > 200) console.log(`   ... and ${uniq.length - 200} more`);
console.log('\nnothing removed; remove only after the owner says "yes" to this list.');
