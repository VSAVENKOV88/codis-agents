#!/usr/bin/env node
'use strict';
// guards-all.sh <absolute worktree> takes the project config from that worktree (a tail of the p-train-c3 review): before it
// sourced slots.zsh, and config.js found the config from the CURRENT directory, so a run started from another folder
// took a foreign config or refused 78 "no project config". Now:
// - an absolute path to an existing folder whose nearest .claude/codis-agents.json (config.js path --from <dir>) exists
//   -> that config, also over $CLAUDE_PROJECT_DIR and the config of the current directory;
// - an explicit $CODIS_AGENTS_CONFIG still wins;
// - a relative worktree name (resolved from worktreeRoot of the config) behaves as before: the config of the cwd;
// - an absolute path with no config above it -> the lookup from the cwd, as before.
// Also config.js path --from <dir>: the nearest config from <dir> upwards, $CLAUDE_PROJECT_DIR ignored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-all-config-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
try {
  const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), w = path.join(wts, 'pw'), other = path.join(T, 'other'), bare = path.join(T, 'bare'), plainWt = path.join(T, 'plain', 'pq');
  for (const d of [bin, path.join(w, '.claude', 'sub'), path.join(other, '.claude'), bare, plainWt]) fs.mkdirSync(d, { recursive: true });
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
  // config A lives in the worktree itself; config B in another folder (the cwd of the run)
  const cfg = (tag, wroot) => JSON.stringify({ repoDir: path.join(T, 'main'), worktreeRoot: wroot, sharedDir: path.join(T, 'shared-' + tag),
    guardCommand: `cd {wt} && echo ran-with-config-${tag}`, slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } });
  const cfgA = path.join(w, '.claude', 'codis-agents.json'), cfgB = path.join(other, '.claude', 'codis-agents.json');
  fs.writeFileSync(cfgA, cfg('A', wts));
  fs.writeFileSync(cfgB, cfg('B', wts));
  for (const d of [w, plainWt]) { fs.writeFileSync(path.join(d, 'f.txt'), '1'); git(d, 'init', '-q'); git(d, 'add', 'f.txt'); git(d, 'commit', '-q', '-m', 'w'); }

  const env0 = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env0[k];

  // --- config.js path --from <dir> ---
  const cp = (cwd, extra, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'path', ...a], { encoding: 'utf8', cwd, env: Object.assign({}, env0, extra) });
  let p = cp(other, {}, '--from', path.join(w, '.claude', 'sub'));
  ok('config.js path --from <dir in the worktree> (cwd elsewhere) -> the nearest config above <dir>', p.status === 0 && p.stdout.trim() === cfgA, `${p.status} ${p.stdout}${p.stderr}`);
  p = cp(other, { CLAUDE_PROJECT_DIR: other }, '--from', w);
  ok('config.js path --from <dir> ignores $CLAUDE_PROJECT_DIR', p.status === 0 && p.stdout.trim() === cfgA, `${p.status} ${p.stdout}${p.stderr}`);
  p = cp(other, {}, '--from', bare);
  ok('config.js path --from <dir with no config above> -> exit 1, nothing printed', p.status === 1 && !p.stdout.trim(), `${p.status} ${p.stdout}${p.stderr}`);
  p = cp(other, {}, '--from');
  ok('config.js path --from without a directory -> usage, exit 64', p.status === 64, `${p.status} ${p.stderr}`);

  // --- guards-all.sh end to end ---
  if (!has('zsh')) skip('guards-all.sh takes the config of an absolute worktree', 'zsh not found');
  else {
    // the fixture worktrees are plain repositories: --main-checkout on purpose
    const ga = (cwd, extra, ...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', '--force', ...a], { encoding: 'utf8', cwd, env: Object.assign({}, env0, extra), timeout: 120000 });
    const said = (x) => `${x.status} ${x.stdout}${x.stderr}`;
    let x = ga(other, {}, w);
    ok('absolute worktree, cwd with another config -> the worktree\'s config (A), exit 0', x.status === 0 && /ran-with-config-A/.test(x.stdout) && !/config-B/.test(x.stdout)
      && fs.existsSync(path.join(T, 'shared-A', 'guards-pw.txt')), said(x));
    x = ga(bare, {}, w);
    ok('absolute worktree, cwd with no config at all -> the worktree\'s config (A), not 78', x.status === 0 && /ran-with-config-A/.test(x.stdout), said(x));
    x = ga(other, { CLAUDE_PROJECT_DIR: other }, w);
    ok('absolute worktree beats $CLAUDE_PROJECT_DIR -> config A', x.status === 0 && /ran-with-config-A/.test(x.stdout), said(x));
    x = ga(bare, { CODIS_AGENTS_CONFIG: cfgB }, w);
    ok('explicit $CODIS_AGENTS_CONFIG still wins over the worktree\'s config -> config B', x.status === 0 && /ran-with-config-B/.test(x.stdout) && !/config-A/.test(x.stdout), said(x));
    x = ga(other, {}, 'pw');
    ok('relative worktree name -> the config of the cwd, as before (B, its worktreeRoot)', x.status === 0 && /ran-with-config-B/.test(x.stdout) && fs.existsSync(path.join(T, 'shared-B', 'guards-pw.txt')), said(x));
    x = ga(bare, {}, 'pw');
    ok('relative worktree name, cwd with no config -> 78 "no project config", as before', x.status === 78 && /no project config/.test(x.stderr), said(x));
    x = ga(other, {}, plainWt);
    ok('absolute worktree with no config above it -> the lookup from the cwd, as before (B)', x.status === 0 && /ran-with-config-B/.test(x.stdout), said(x));
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

// The docs name the lookup: README's guards-all.sh row.
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
ok('README: guards-all.sh row says the config comes from an absolute worktree (config.js path --from)', /\| `scripts\/guards-all\.sh` \|[^\n]*config\.js path --from/.test(readme));
done();
