#!/usr/bin/env node
'use strict';
// The guards a programmer runs instead of the full suite (rules/multi-agent.md, "One full guard run per task"): the full
// run is done once per task by the workflow after the programmer's last commit; the programmer runs only this selection.
// A guard is selected when
//   - it is itself changed (new, edited, untracked);
//   - it imports a changed file (a relative require/import whose target, with or without an extension or /index, is a
//     changed file);
//   - it names a changed file: the file's path from the repository root, or its name without the extension as a whole
//     word (not a part of a longer identifier);
//   - its path contains an entry of the config key guardAlways (scanners of the diff: secrets, semgrep).
// Why both imports and names: on the full runs of 2026-10-10..20 selection by imports alone caught 1 of 6 product
// regressions, imports plus names of the changed files caught all of them.
// Changed files: committed since the merge-base of HEAD with --base, plus uncommitted and untracked ones (the new guard
// of the programmer is often not committed yet). Guard files: tracked and untracked (not ignored) files matching the
// config key guardFiles (globs as in scripts/stand.js: no "/" -> the file name at any depth; default *-run.js|mjs|cjs).
//
// usage: guards-select.js --wt <worktree> [--base <ref>] [--config <file>] [--json | --command]
//   --base     the branch or commit the task started from (default: the first of protectedBranches)
//   (none)     one selected guard per line, paths from the repository root
//   --json     {base, mergeBase, changed, guards: [{path, why: [...]}], command}
//   --command  the project's guardSubsetCommand with {wt} and {onlyArgs} (one --only <guard> per guard) filled in;
//              exit 3 when nothing is selected (an empty --only list would run every guard), 78 without the key
// Exit codes: 0 ok, 2 git failed (unknown base, not a repository), 3 nothing selected (--command), 64 usage,
// 78 no or invalid project config.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { matches } = require('./stand');

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const die = (code, m) => { process.stderr.write(`guards-select: ${m}\n`); process.exit(code); };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const wt = opt('--wt');
if (!wt) die(64, 'usage: guards-select.js --wt <worktree> [--base <ref>] [--config <file>] [--json | --command]');
const file = opt('--config') ? path.resolve(opt('--config')) : cfg.find(wt);
if (!file) die(78, 'no project config (.claude/codis-agents.json) found');
const { config, errors } = cfg.load(file);
if (errors.length) die(78, `the project config ${file} does not validate:\n` + errors.map((e) => 'codis-agents config: ' + e).join('\n'));

const git = (...args) => {
  const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) die(2, `git ${args.join(' ')}: ${(r.stderr || '').trim() || 'failed'}`);
  return r.stdout;
};
const lines = (s) => s.split('\n').filter(Boolean);
const top = git('rev-parse', '--show-toplevel').trim();
const base = opt('--base') || config.protectedBranches[0];
const mergeBase = git('merge-base', 'HEAD', base).trim();
const changed = [...new Set(lines(git('diff', '--name-only', '--no-renames', mergeBase))
  .concat(lines(git('ls-files', '--others', '--exclude-standard'))))].sort();
const changedSet = new Set(changed);
const files = lines(git('ls-files', '--cached', '--others', '--exclude-standard'));
const guards = [...new Set(files)].filter((f) => matches(config.guardFiles, f) && fs.existsSync(path.join(top, f))).sort();

// Relative import targets of a guard, as repository paths without resolving the extension.
const IMPORT = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;
const EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
const importsOf = (g, text) => {
  const out = new Set();
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!/^\.\.?\//.test(spec)) continue;
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(g), spec));
    for (const e of EXT) { out.add(p + e); if (e) out.add(`${p}/index${e}`); }
  }
  return out;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRe = new Map(changed.map((f) => {
  const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
  return [f, stem ? new RegExp(`(^|[^A-Za-z0-9_$])${esc(stem)}($|[^A-Za-z0-9_$])`) : null];
}));

const picked = [];
for (const g of guards) {
  const why = [];
  if (changedSet.has(g)) why.push('changed');
  for (const s of config.guardAlways) if (g.includes(s)) why.push(`always ${s}`);
  let text = '';
  try { text = fs.readFileSync(path.join(top, g), 'utf8'); } catch { /* unreadable: only path rules apply */ }
  const imp = importsOf(g, text);
  for (const f of changed) {
    if (f === g) continue;
    if (imp.has(f)) why.push(`imports ${f}`);
    else if (text.includes(f) || (nameRe.get(f) && nameRe.get(f).test(text))) why.push(`mentions ${f}`);
  }
  if (why.length) picked.push({ path: g, why });
}

const command = () => {
  if (!config.guardSubsetCommand) return '';
  const only = picked.map((p) => `--only ${q(p.path)}`).join(' ');
  return config.guardSubsetCommand.replace(/\{wt\}/g, q(wt)).replace(/\{onlyArgs\}/g, only);
};
if (a.includes('--json')) {
  process.stdout.write(JSON.stringify({ base, mergeBase, changed, guards: picked, command: picked.length ? command() : '' }, null, 1) + '\n');
} else if (a.includes('--command')) {
  if (!config.guardSubsetCommand) die(78, `no guardSubsetCommand in the project config ${file}: run the full guard run instead`);
  if (!picked.length) die(3, 'no guard selected: run your new guards directly');
  process.stdout.write(command() + '\n');
} else {
  for (const p of picked) process.stdout.write(p.path + '\n');
}
