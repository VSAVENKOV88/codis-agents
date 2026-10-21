#!/usr/bin/env node
'use strict';
// Environment check of the preconditions (rules/multi-agent.md, "Order and shortcuts"): free disk on the volumes the
// task writes to, and swap headroom. A full disk and no room for swap once turned testers red for reasons that were not
// in the code (a full run cut off, no heavy slot); the programmers that followed changed nothing.
// Thresholds come from the project config, `preconditions.minFreeDiskGB` and `preconditions.minSwapGB` (defaults 10 and
// 4: one image build or a full guard run writes several GB of logs, builds and layers; 4 GB of swap is the ceiling of
// four slots of ~1 GB each, the same floor the slot scripts keep before admitting any slot).
// Swap headroom: on macOS swap grows in files under /System/Volumes/VM, so it is the free part of vm.swapusage plus the
// free space of that volume; on Linux SwapFree from /proc/meminfo. Where it cannot be measured the result says so in
// notes and does not fail on it.
// Main working copy (scripts/main-checkout.js): with --worktree <dir> the task worktree must not be the main working copy
// of its repository - its ignored data is the only original; --main-checkout lets it pass.
// usage: env-check.js --path <dir> [--path <dir>...] [--worktree <dir> [--main-checkout]] [--min-disk-gb N] [--min-swap-gb N]
//   prints JSON {ok, problems, disk: [{path, freeGB}], swapGB, notes}; exit 0 when ok, 1 when not, 64 on bad usage.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { mainCheckout, refusal } = require('./main-checkout');

const GB = 1024 ** 3;
const DEFAULTS = { minFreeDiskGB: 10, minSwapGB: 4 };

function freeBytes(p) {
  const s = fs.statfsSync(p);
  return s.bavail * s.bsize;
}

const MB = (v) => Number(String(v).replace(',', '.').replace(/M$/, '')) * 1024 * 1024;
// Swap headroom in bytes, or null when this system has no known way to measure it.
function swapBytes(platform = process.platform) {
  if (platform === 'darwin') {
    const r = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const m = r.status === 0 && /free = ([\d.,]+M)/.exec(r.stdout);
    if (!m) return null;
    let vm = 0;
    try { vm = freeBytes('/System/Volumes/VM'); } catch { /* no separate VM volume */ }
    return MB(m[1]) + vm;
  }
  if (platform === 'linux') {
    try {
      const m = /^SwapFree:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      return m ? Number(m[1]) * 1024 : null;
    } catch { return null; }
  }
  return null;
}

// Pure decision over measurements: disk = [{path, bytes}], swap = bytes or null.
function judge({ disk, swap }, limits) {
  const lim = Object.assign({}, DEFAULTS, limits || {});
  const problems = [], notes = [];
  const r1 = (b) => Math.round((b / GB) * 10) / 10;
  for (const d of disk) {
    if (d.error) problems.push(`disk ${d.path}: ${d.error}`);
    else if (d.bytes < lim.minFreeDiskGB * GB) problems.push(`disk ${d.path}: ${r1(d.bytes)} GB free, below ${lim.minFreeDiskGB} GB (preconditions.minFreeDiskGB)`);
  }
  if (swap === null) notes.push('swap headroom could not be measured on this system - not checked');
  else if (swap < lim.minSwapGB * GB) problems.push(`swap: ${r1(swap)} GB of headroom, below ${lim.minSwapGB} GB (preconditions.minSwapGB)`);
  return {
    ok: !problems.length, problems,
    disk: disk.map((d) => (d.error ? { path: d.path, error: d.error } : { path: d.path, freeGB: r1(d.bytes) })),
    swapGB: swap === null ? null : r1(swap), notes,
  };
}

function measure(paths) {
  return {
    disk: paths.map((p) => { try { return { path: p, bytes: freeBytes(p) }; } catch (e) { return { path: p, error: e.code || e.message }; } }),
    swap: swapBytes(),
  };
}

module.exports = { judge, measure, swapBytes, DEFAULTS };

if (require.main === module) {
  const a = process.argv.slice(2);
  const paths = [], limits = {};
  let worktree = null, force = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--path') paths.push(a[++i]);
    else if (a[i] === '--worktree') worktree = a[++i];
    else if (a[i] === '--main-checkout') force = true;
    else if (a[i] === '--min-disk-gb') limits.minFreeDiskGB = Number(a[++i]);
    else if (a[i] === '--min-swap-gb') limits.minSwapGB = Number(a[++i]);
    else { console.error(`env-check.js: unknown argument ${a[i]}`); process.exit(64); }
  }
  if (!paths.length || paths.some((p) => !p) || worktree === undefined || worktree === '' || Object.values(limits).some((v) => !Number.isFinite(v) || v < 0)) {
    console.error('usage: env-check.js --path <dir> [--path <dir>...] [--worktree <dir> [--main-checkout]] [--min-disk-gb N] [--min-swap-gb N]');
    process.exit(64);
  }
  const r = judge(measure(paths), limits);
  if (worktree && !force) {
    const m = mainCheckout(worktree);
    if (m.main) { r.problems.push(`worktree ${refusal(worktree, m)}`); r.ok = false; }
  }
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
