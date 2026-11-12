#!/usr/bin/env node
'use strict';
// The tester cells of the declared needs of guards (p-codex-A2b-1c2a), a child of tests/heavy-guards-needs.test.js with
// its own tally:
//   TN1 a guard path with a blank and a single quote: --skip of a full run and --only of a selection reach the runner as
//       one argument each (zsh quoting through sub()), the marked one never runs, exit 79, the exact name in the meta;
//   TN2 two marker lines in one file: their needs together (each once), their reasons joined by "; ";
//   TN3 a selection against its base: a need removed in the diff is not flagged, a need replaced is;
//   TN4 a selection that names a file deleted in the diff: no error of the list, the file is not excluded;
//   TN5 not a marker: the en dash, a hyphen, the marker after code on the line, a marker of the other kind;
//   TN6 under the channel without the key guardNeeds: the marked guard runs, exit 0, no incomplete in the log or meta;
//   TN7 verdictOf: an own meta with rc 79 and no incomplete, an own exec whose meta.rc is not the run's rc: environment;
//   TN9 a selection under the channel whose selected file cannot be read: 69, the runner never starts, the meta 69.
// Like the parent: the fixture project of tests/fixtures/heavy-guards/project.js, real slots.zsh on a slot directory of
// the test, a fake machine and a fake codex (CODEX_SANDBOX=fake).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

if (process.platform !== 'darwin') { skip('tester cells of the needs of guards', 'needs macOS (the box is read with O_NOFOLLOW_ANY)'); done(); }
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const GR = require(path.join(S, 'guards-result.js'));
const HS = require(path.join(S, 'heavy-service.js'));
const RX = require(path.join(S, 'role-exec.js'));
const C = require(path.join(S, 'config.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const GA = path.join(S, 'guards-all.sh');
const { makeProject } = require('./fixtures/heavy-guards/project.js');

// Every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list), then the rest of the same families.
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gnt-')));
process.on('exit', () => { spawnSync('chmod', ['-R', 'u+rwX', T]); fs.rmSync(T, { recursive: true, force: true }); });
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
// The fake codex: `codex sandbox <flags> -C <dir> -- <argv>` -> records "<pid> <argv>", runs argv in dir with
// CODEX_SANDBOX=fake and the environment it was given.
const CODEX_LOG = path.join(T, 'codex-calls.txt');
sh('codex', `[[ $1 == --version ]] && { print -r -- "codex-cli 0.167.0"; exit 0 }\nwhile (( $# )) && [[ $1 != -- ]]; do [[ $1 == -C ]] && { cd -- $2 || exit 1; shift }; shift; done\nshift\nprint -r -- "$$ $*" >> ${JSON.stringify(CODEX_LOG)}\nexport CODEX_SANDBOX=fake\nexec "$@"`);
const codexCalls = () => { try { return fs.readFileSync(CODEX_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 60000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const metaOf = (f) => { try { return JSON.parse(fs.readFileSync(`${f}.meta.json`, 'utf8')); } catch { return null; } };
let caseN = 0;

const NEEDS = { marker: '#' };
const B = '# guards:needs browser — no browser in the sandbox\nprint -r -- B-RAN\n';
function setup(po) {
  const c = path.join(T, `c${++caseN}`);
  fs.mkdirSync(c);
  const P = makeProject(c, po);
  const d = { root: c, P, wt: P.wt, slots: P.slots, tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.box = path.join(d.tdir, 'calls', 'prog-1', 'heavy');
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: P.slots, SLOT_JOURNAL: path.join(P.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' });
  d.OUT = path.join(P.shared, 'guards-wt.txt');
  d.SEL = path.join(P.shared, 'guards-wt.select.txt');
  return d;
}
// an executor spec as the adapter writes it (fake codex): {bin, args, env}
const specFile = (d) => {
  const f = path.join(d.root, 'exec.json');
  fs.writeFileSync(f, JSON.stringify({ bin: path.join(bin, 'codex'), args: ['sandbox', '-P', 'codis-heavy'],
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: d.root, TMPDIR: d.tdir } }));
  return f;
};
// guards-all.sh as the adapter runs it (exec: with CODIS_GUARDS_EXEC naming a spec of the test) or as a role of Claude
const ga = (d, args, exec) => spawnSync('zsh', [GA, '--force'].concat(args, [d.wt]), { cwd: d.wt, encoding: 'utf8', timeout: 120000,
  env: Object.assign({}, d.env, { CODIS_AGENTS_CONFIG: d.P.cfg }, exec ? { CODIS_GUARDS_EXEC: specFile(d) } : {}) });
const gaReuse = (d, args, exec) => spawnSync('zsh', [GA].concat(args, [d.wt]), { cwd: d.wt, encoding: 'utf8', timeout: 120000,
  env: Object.assign({}, d.env, { CODIS_AGENTS_CONFIG: d.P.cfg }, exec ? { CODIS_GUARDS_EXEC: specFile(d) } : {}) });
const slotLines = (d) => read(path.join(d.slots, 'journal.tsv')).split('\n').filter(Boolean);
const guardsOf = (m) => (m && Array.isArray(m.incomplete) ? m.incomplete.map((x) => x.guard).sort() : null);


(async () => {
  // ---- TN1: a guard path with a blank and a single quote
  {
    const Q = "guards/it's x.g";
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', "it's x.g": '# guards:needs browser — quoted\nprint -r -- Q-RAN\n' } });
    const r = ga(d, [], true);
    const log = read(d.OUT), m = metaOf(d.OUT);
    ok('TN1 full run: the runner gets one --skip with the exact name, the guard never runs, exit 79, the exact name in the meta',
      r.status === 79 && log.split('\n').includes(`SKIPPED ${Q}`) && !/Q-RAN/.test(log) && /^accounted 1, failed 0$/m.test(log) && guardsOf(m).join() === Q, `exit ${r.status}\n${log.slice(-1500)}\n${JSON.stringify(m)}`);
    d.P.commit({ "guards/it's y.g": 'print -r -- Y-RAN\n', [Q]: '# guards:needs browser — quoted\nprint -r -- Q-RAN\n# changed\n' });
    const s = ga(d, ['--select', 'main'], true);
    const sl = read(d.SEL), sm = metaOf(d.SEL);
    ok('TN1 selection: the kept quoted guard runs through --only (one argument), the excluded quoted one does not; 1 of 1, exit 79',
      s.status === 79 && /Y-RAN/.test(sl) && !/Q-RAN/.test(sl) && /^accounted 1, failed 0$/m.test(sl) && !/accounted for/.test(sl) && guardsOf(sm).join() === Q, `exit ${s.status}\n${sl.slice(-1500)}\n${JSON.stringify(sm)}`);
  }

  // ---- TN2, TN4, TN5: the marker lines (guards-result.js needsOf)
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0' } });
    const w = (f, b) => fs.writeFileSync(path.join(d.wt, f), b);
    w('guards/two.g', '# guards:needs browser — a page\nexit 0\n# guards:needs docker, browser — a container\n');
    w('guards/en.g', '# guards:needs browser – an en dash\n');
    w('guards/hy.g', '# guards:needs browser - a hyphen\n');
    w('guards/mid.g', 'exit 0 # guards:needs browser — after code\n');
    w('guards/other.g', '// guards:needs browser — the other marker\n');
    const r = GR.needsOf({ wt: d.wt, cfg: { glob: ['*.g'], marker: '#' } });
    const by = Object.fromEntries((r.list || []).map((x) => [x.guard, x]));
    ok('TN2 two marker lines: needs together, each once; reasons joined by "; "', !!by['guards/two.g'] && JSON.stringify(by['guards/two.g'].needs) === JSON.stringify(['browser', 'docker']) && by['guards/two.g'].reason === 'a page; a container', JSON.stringify(r));
    ok('TN5 not a marker: an en dash, a hyphen, the marker after code, a marker of the other kind', !r.error && ['en', 'hy', 'mid', 'other'].every((n) => !by[`guards/${n}.g`]), JSON.stringify(r));
    const sel = GR.needsOf({ wt: d.wt, cfg: { glob: ['*.g'], marker: '#' }, names: ['guards/gone.g', 'guards/two.g'] });
    ok('TN4 a selected name whose file is gone (deleted in the diff): no error, not excluded', !sel.error && JSON.stringify(sel.list.map((x) => x.guard)) === JSON.stringify(['guards/two.g']), JSON.stringify(sel));
  }

  // ---- TN3: a need removed / replaced against the base of a selection
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'rm.g': '# guards:needs browser, docker — two\n', 'rp.g': '# guards:needs browser — one\n' } });
    d.P.commit({ 'guards/rm.g': '# guards:needs browser — one left\n', 'guards/rp.g': '# guards:needs docker — another\n' });
    const r = GR.needsOf({ wt: d.wt, cfg: { glob: ['*.g'], marker: '#' }, names: ['guards/rm.g', 'guards/rp.g'], base: 'main' });
    const by = Object.fromEntries((r.list || []).map((x) => [x.guard, x]));
    ok('TN3 a need removed in the diff: not flagged; a need replaced: flagged', !r.error && !!by['guards/rm.g'] && by['guards/rm.g'].newMarker === undefined && !!by['guards/rp.g'] && by['guards/rp.g'].newMarker === true, JSON.stringify(r));
  }

  // ---- TN6: under the channel without guardNeeds the marker means nothing
  {
    const d = setup({ guards: { 'a.g': 'exit 0', 'b.g': B } });
    const r = ga(d, [], true);
    const log = read(d.OUT), m = metaOf(d.OUT);
    ok('TN6 no guardNeeds, under the channel: the marked guard runs in the executor, exit 0, no incomplete in the log or the meta; verdict green',
      r.status === 0 && /B-RAN/.test(log) && /RUNNER sb=fake/.test(log) && !/incomplete/.test(log) && !!m && m.incomplete === undefined && m.exec === path.join(d.root, 'exec.json')
      && GR.verdictOf(0, m, m.exec).verdict === 'green', `exit ${r.status}\n${log.slice(-1000)}\n${JSON.stringify(m)}`);
  }

  // ---- TN7: verdictOf, the own meta that does not carry this result
  {
    const spec = '/s/heavy-runs/X/exec.json';
    const a = GR.verdictOf(79, { exec: spec, rc: 79 }, spec);
    const b = GR.verdictOf(1, { exec: spec, rc: 0 }, spec);
    const c = GR.verdictOf(79, { exec: spec, rc: 79, incomplete: [] }, spec);
    ok('TN7 verdictOf: own 79 without incomplete, own exec with another rc, own 79 with an empty list: environment, no notRun',
      [a, b, c].every((v) => v.verdict === 'environment' && v.notRun === undefined), JSON.stringify([a, b, c]));
  }

  // ---- TN9: a selection whose selected guard cannot be read
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    d.P.commit({ 'guards/a.g': 'exit 0 # changed\n', 'guards/b.g': B + '# changed\n' });
    fs.chmodSync(path.join(d.wt, 'guards', 'b.g'), 0);
    const calls = codexCalls(), lines = slotLines(d).length;
    const r = ga(d, ['--select', 'main'], true);
    fs.chmodSync(path.join(d.wt, 'guards', 'b.g'), 0o644);
    const log = read(d.SEL), m = metaOf(d.SEL);
    ok('TN9 selection, a selected guard cannot be read: 69 "environment: the needs of the guards cannot be read", no runner, no slot, the meta of this run 69',
      r.status === 69 && /environment: the needs of the guards cannot be read: .*guards\/b\.g/.test(log + r.stderr) && !/RUNNER/.test(log) && codexCalls() === calls && slotLines(d).length === lines
      && !!m && m.rc === 69 && m.exec === path.join(d.root, 'exec.json'), `exit ${r.status}\n${log}\n${r.stderr}\n${JSON.stringify(m)}`);
  }
  done();
})().catch((e) => { ok('the tester cells ran to their end', false, e.stack); done(); });
