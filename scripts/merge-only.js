#!/usr/bin/env node
'use strict';
// Is a programmer round only the merge of the arc, with conflicts resolved in docs alone? (p-merge-docs, diagnosis (b):
// after a train conflict the round merges the arc head into the branch; when it touched only docs by hand, the workflow
// skips the selection on the new HEAD - the train runs the full suite over the same tree anyway.)
//
// usage: merge-only.js <before> <head> --base <arc> [--wt <dir>] [--files <glob>]...
//   before  the head of the branch before the round (the head the train rode)
//   head    the head after the round
//   --base  the arc branch the train merges into
//   --files the project's mergeOnlyFiles globs; none - never merge only (the key is off, the behaviour as before)
// prints JSON {mergeOnly, reason, files[, error]}; exit 0 merge only, 1 not, 2 an error (bad arguments, git).
//
// The round is merge only when all hold:
//   - head is a merge of two parents: the first is before (so the round is this one commit, nothing after it), the
//     second an ancestor of the arc;
//   - the files where head differs from the automatic merge of its parents (git merge-tree --write-tree: the
//     conflicted files keep their markers there, so every hand resolution and every hand edit differs) all match the
//     globs. Code the arc brought without a conflict equals the automatic merge and is not counted: it is the arc's.
// A glob without "/" matches the file name at any depth; with "/" the path from the repository root; * and ? stay
// within one path segment, ** crosses segments (the same rule as stand.imageFiles).
const path = require('path');
const { spawnSync } = require('child_process');
const { matches } = require('./stand');

function parse(argv) {
  const a = { pos: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--base' || k === '--wt' || k === '--files') {
      const v = argv[++i];
      if (v === undefined) return { error: `${k} needs a value` };
      if (k === '--files') a.files.push(v); else a[k.slice(2)] = v;
    } else if (k.startsWith('--')) return { error: `unknown option ${k}` };
    else a.pos.push(k);
  }
  if (a.pos.length !== 2) return { error: 'expected <before> <head>' };
  if (!a.base) return { error: '--base <arc> is required' };
  return a;
}

function check(a) {
  const wt = path.resolve(a.wt || process.cwd());
  const git = (...args) => {
    const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { rc: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const sha = (ref) => {
    const r = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
    if (r.rc !== 0 || !r.out) throw new Error(`not a commit: ${ref}`);
    return r.out;
  };
  const [before, head] = [sha(a.pos[0]), sha(a.pos[1])];
  const base = sha(a.base);
  const no = (reason, files = []) => ({ mergeOnly: false, reason, files });
  if (!a.files.length) return no('mergeOnlyFiles is not set: the selection is never skipped');
  const parents = git('rev-list', '--parents', '-n', '1', head);
  if (parents.rc !== 0) throw new Error(`git rev-list --parents: ${parents.err}`);
  const ps = parents.out.split(/\s+/).slice(1);
  if (ps.length !== 2) return no(ps.length < 2 ? 'the commit of the round is not a merge' : 'the commit of the round merges more than two parents');
  if (ps[0] !== before) return no(`the first parent of the merge is ${ps[0]}, not the head before the round ${before}`);
  const anc = git('merge-base', '--is-ancestor', ps[1], base);
  if (anc.rc === 1) return no(`the merged commit ${ps[1]} is not an ancestor of the arc ${a.base}`);
  if (anc.rc !== 0) throw new Error(`git merge-base: ${anc.err}`);
  // The automatic merge of the parents; exit 1 means conflicts, the tree still comes first (markers in the files).
  const mt = git('merge-tree', '--write-tree', '--no-messages', ...ps);
  if (mt.rc !== 0 && mt.rc !== 1) throw new Error(`git merge-tree: ${mt.err}`);
  const auto = mt.out.split('\n')[0];
  if (!/^[0-9a-f]{40,64}$/.test(auto)) throw new Error(`git merge-tree gave no tree: ${mt.out.slice(0, 200)}`);
  const d = git('diff', '--name-only', '--no-renames', '-z', auto, `${head}^{tree}`);
  if (d.rc !== 0) throw new Error(`git diff: ${d.err}`);
  const files = d.out.split('\0').filter(Boolean);
  const outside = files.filter((f) => !matches(a.files, f));
  if (outside.length) return no(`resolved or edited by hand outside mergeOnlyFiles: ${outside.join(', ')}`, files);
  return { mergeOnly: true, reason: `one merge of the arc ${a.base}; resolved by hand: ${files.join(', ') || 'nothing'}`, files };
}

if (require.main === module) {
  const a = parse(process.argv.slice(2));
  let r, rc;
  if (a.error) { r = { mergeOnly: false, reason: a.error, files: [], error: a.error }; rc = 2; }
  else {
    try { r = check(a); rc = r.mergeOnly ? 0 : 1; }
    catch (e) { r = { mergeOnly: false, reason: e.message, files: [], error: e.message }; rc = 2; }
  }
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(rc);
}

module.exports = { parse, check };
