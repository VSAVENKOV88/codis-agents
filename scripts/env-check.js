#!/usr/bin/env node
'use strict';
// Environment check of the preconditions (rules/multi-agent.md, "Order and shortcuts"): free disk on the volumes the
// task writes to, and swap headroom. A full disk and no room for swap once turned testers red for reasons that were not
// in the code (a full run cut off, no heavy slot); the programmers that followed changed nothing.
// Thresholds are settings of the machine (scripts/config.js, the machine file): `minFreeDiskGB` in GB and `swapMinMB`
// in MB (defaults 10 and 4000: one image build or a full guard run writes several GB of logs, builds and layers; 4000 MB
// of swap is the ceiling of four slots of ~1 GB each, the same number the slot scripts keep before admitting any slot -
// a 4 GiB swap passes, decision Q3 of 2026-10-21). The command line (the role chain passes the resolved config) wins
// over the machine file; 0 switches a check off and the notes say so. No machine file: the defaults, with a note.
// Swap headroom: on macOS swap grows in files under /System/Volumes/VM, so it is the free part of vm.swapusage plus the
// free space of that volume; on Linux SwapFree from /proc/meminfo. Where it cannot be measured the result says so in
// notes and does not fail on it.
// Main working copy (scripts/main-checkout.js): with --worktree <dir> the task worktree must not be the main working copy
// of its repository - its ignored data is the only original; --main-checkout lets it pass.
// usage: env-check.js --path <dir> [--path <dir>...] [--worktree <dir> [--main-checkout]] [--min-disk-gb N]
//                     [--min-swap-mb N | --min-swap-gb N (older chains: x 1024)]
//   prints JSON {ok, problems, disk: [{path, freeGB}], swapGB, swapMB, notes}; exit 0 when ok, 1 when not, 64 on bad usage.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { mainCheckout, refusal } = require('./main-checkout');
const { loadMachine, MACHINE_SPEC } = require('./config');

const GB = 1024 ** 3, MiB = 1024 ** 2;
const DEFAULTS = { minFreeDiskGB: MACHINE_SPEC.minFreeDiskGB[1], swapMinMB: MACHINE_SPEC.swapMinMB[1] };

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

// Pure decision over measurements: disk = [{path, bytes}], swap = bytes or null; limits {minFreeDiskGB, swapMinMB,
// machinePath (named in the problems when the floors come from a machine file)}.
function judge({ disk, swap }, limits) {
  const lim = Object.assign({}, DEFAULTS, limits || {});
  const problems = [], notes = [];
  const r1 = (b) => Math.round((b / GB) * 10) / 10;
  const where = (k) => (lim.machinePath ? `${k} in ${lim.machinePath}` : k);
  if (lim.minFreeDiskGB === 0) notes.push('disk check off (minFreeDiskGB = 0)');
  for (const d of disk) {
    if (d.error) problems.push(`disk ${d.path}: ${d.error}`);
    else if (d.bytes < lim.minFreeDiskGB * GB) problems.push(`disk ${d.path}: ${r1(d.bytes)} GB free, below ${lim.minFreeDiskGB} GB (${where('minFreeDiskGB')})`);
  }
  if (lim.swapMinMB === 0) notes.push('swap check off (swapMinMB = 0)');
  else if (swap === null) notes.push('swap headroom could not be measured on this system - not checked');
  else if (swap < lim.swapMinMB * MiB) problems.push(`swap: ${Math.floor(swap / MiB)} MB of headroom, below ${lim.swapMinMB} MB (${where('swapMinMB')})`);
  return {
    ok: !problems.length, problems,
    disk: disk.map((d) => (d.error ? { path: d.path, error: d.error } : { path: d.path, freeGB: r1(d.bytes) })),
    swapGB: swap === null ? null : r1(swap), swapMB: swap === null ? null : Math.floor(swap / MiB), notes,
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
    else if (a[i] === '--min-swap-mb') limits.swapMinMB = Number(a[++i]);
    else if (a[i] === '--min-swap-gb') limits.swapMinMB = Number(a[++i]) * 1024;
    else { console.error(`env-check.js: unknown argument ${a[i]}`); process.exit(64); }
  }
  if (!paths.length || paths.some((p) => !p) || worktree === undefined || worktree === '' || Object.values(limits).some((v) => !Number.isFinite(v) || v < 0)) {
    console.error('usage: env-check.js --path <dir> [--path <dir>...] [--worktree <dir> [--main-checkout]] [--min-disk-gb N] [--min-swap-mb N | --min-swap-gb N]');
    process.exit(64);
  }
  // The machine file gives the floors the command line leaves out; a broken one is a problem (the slots refuse it too).
  const m = loadMachine();
  const r = judge(measure(paths), Object.assign({ minFreeDiskGB: m.values.minFreeDiskGB, swapMinMB: m.values.swapMinMB }, m.exists ? { machinePath: m.path } : {}, limits));
  for (const n of m.notes) r.notes.push(n.replace(/^note: /, ''));
  if (m.errors.length) { r.problems.push(...m.errors.map((e) => `machine file: ${e}`)); r.ok = false; }
  if (worktree && !force) {
    const m = mainCheckout(worktree);
    if (m.main) { r.problems.push(`worktree ${refusal(worktree, m)}`); r.ok = false; }
  }
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
