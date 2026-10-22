#!/usr/bin/env node
'use strict';
// Every test that runs the slot scripts is hermetic against the machine and the environment it runs in:
//  1. it neutralises every knob scripts/slots.zsh takes from the environment (unset/delete or its own value), so a
//     value set outside (SLOT_SWAP_MIN_MB=0 on Linux, an outer heavy.sh that exported its lock and counts) does not
//     change what the test checks;
//  2. it puts a fake machine in front of PATH (sysctl, memory_pressure, vm_stat, df), so the slot it waits for does not
//     depend on the memory and swap of the real box (Linux has no sysctl vm.swapusage: "swap: capacity 0 MB");
//  3. it pins the source of the readings, SLOT_OS (darwin: the fake tools above; linux: a fake /proc in SLOT_PROC under
//     its temporary directory). slots.zsh picks the source from $OSTYPE by default, so a test that leaves SLOT_OS alone
//     reads the real /proc of a Linux box behind its fake macOS tools.
// Why: with the "lockf not found" skips gone the slot tests run on Linux, and three of them read the box instead of
// their own fixture (stand deploy waited on real swap; slots-check case 4 took the swap threshold from outside).
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SLOTS = fs.readFileSync(path.join(ROOT, 'scripts', 'slots.zsh'), 'utf8');
// Knobs: names slots.zsh defaults (": ${X:=...}", "[[ -v X ]] || X=") or reads with a fallback ("${X:-...}", "${X:+...}").
const knobs = new Set();
for (const re of [/^: \$\{([A-Z][A-Z0-9_]*):=/gm, /\[\[ -v ([A-Z][A-Z0-9_]*) \]\] \|\|/g, /\$\{([A-Z][A-Z0-9_]*):[-+]/g]) {
  for (const m of SLOTS.matchAll(re)) if (/^(SLOTS?|GUARDS)_/.test(m[1])) knobs.add(m[1]);
}
ok('knobs found in slots.zsh (swap threshold, extra-slot thresholds, counts, locks)', ['SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_MEDIUM_N', 'GUARDS_EXCLUSIVE_LOCK', 'SLOTS_DIR', 'SLOT_OS', 'SLOT_PROC'].every((k) => knobs.has(k)), [...knobs].join(' '));

// The tests that run heavy.sh / medium.sh / guards-all.sh / stand.sh or source slots.zsh.
const SLOT_TESTS = ['slots-check.test.sh', 'slots-linux.test.sh', 'slots-linux-edges.test.sh', 'slots-fifo.test.sh', 'slots-journal.test.sh', 'slots-locks.test.sh', 'stand.test.js', 'stand-config.test.js', 'stand-cwd-edges.test.js', 'guards-result.test.js', 'known-red.test.js', 'known-red-edges.test.js', 'fixtures/slots-u1a/checks.zsh', 'runner-neutral.test.sh', 'runner-neutral-edges.test.sh', 'runner-neutral-globs.test.sh'];
const runsSlots = /\$H\/(heavy|medium|guards-all|stand)\.sh|source[^\n]*slots\.zsh|['"](heavy|medium|guards-all|stand)\.sh['"]/;
const others = fs.readdirSync(__dirname).filter((f) => /\.test\.(js|sh)$/.test(f) && f !== path.basename(__filename) && !SLOT_TESTS.includes(f))
  .filter((f) => runsSlots.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
ok('every test that runs the slot scripts is in the list', others.length === 0, others.join(' '));

const neutral = (src, k) => new RegExp(`^\\s*unset\\b[^\\n]*\\b${k}\\b`, 'm').test(src)             // zsh: unset ... K
  || new RegExp(`^\\s*(export\\s+)?(\\w+=\\S*\\s+)*${k}=`, 'm').test(src)                        // zsh: [export] ... K=v
  || new RegExp(`['"]${k}['"]`).test(src) || new RegExp(`\\b${k}\\s*:`).test(src);                // js: delete list / env key
for (const f of SLOT_TESTS) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) { ok(`${f}: exists`, false); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const loose = [...knobs].filter((k) => !neutral(src, k));
  ok(`${f}: neutralises every environment knob of slots.zsh`, loose.length === 0, 'not set or unset: ' + loose.join(' '));
  const tools = ['sysctl', 'memory_pressure', 'vm_stat', 'df'].filter((t) => !new RegExp(`\\$T/bin/${t}\\b|\\(\\s*'${t}'\\s*,`).test(src));
  ok(`${f}: fake machine (sysctl, memory_pressure, vm_stat, df) in front of PATH`, tools.length === 0 && /export PATH=\$T\/bin:\$PATH|\bPATH: *\w+ *\+ *path\.delimiter *\+ *process\.env\.PATH/.test(src), 'missing: ' + tools.join(' '));
  const os = src.match(/(?:^\s*export\s+(?:\w+=\S*\s+)*SLOT_OS=|\bSLOT_OS:\s*['"])(\w+)/m);
  ok(`${f}: pins the source of the readings (SLOT_OS darwin or linux)`, !!os && ['darwin', 'linux'].includes(os[1]), os ? 'SLOT_OS=' + os[1] : 'SLOT_OS not set');
  if (os && os[1] === 'linux') ok(`${f}: SLOT_OS=linux reads a fake /proc under its temporary directory`, /^\s*export\s+(?:\w+=\S*\s+)*SLOT_PROC=\$T\//m.test(src));
}
done();
