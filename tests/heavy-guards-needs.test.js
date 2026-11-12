#!/usr/bin/env node
'use strict';
// Declared needs of guards and the "incomplete" result of a guard run of a codex role (p-codex-A2b-1c2a, cells
// C2a-1...C2a-21, mechanism N-1 with P-1 and V-1): a guard file with a line `<marker> guards:needs <need>[, ...] —
// <reason>` (project key guardNeeds) never runs inside the executor of a codex role (CODIS_GUARDS_EXEC): a full run
// passes it to the runner as --skip (placeholder {skipArgs}), a selection leaves it out of {onlyArgs} and of its count,
// a single rerun never runs it; the run that would be green ends 79 with the line "incomplete: ..." and the meta field
// incomplete; a red stays red. The adapter answers verdict and notRun from the meta of its own run (meta.exec = its
// spec). Here the executor is a fake codex (tests/heavy-guards.test.js); the real sandbox is in
// tests/heavy-guards-sandbox.test.js and tests/heavy-channel-sandbox.test.js. A fixture project
// (tests/fixtures/heavy-guards/project.js) on a slot directory of the test, a fake machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

if (process.platform !== 'darwin') { skip('needs of guards and the incomplete result', 'needs macOS (the box is read with O_NOFOLLOW_ANY)'); done(); }
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

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gn-')));
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
  // ---- C2a-1, C2a-4, C2a-5: the key guardNeeds and the placeholder {skipArgs}
  {
    const dir = path.join(T, 'cfg');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const f = path.join(dir, '.claude', 'codis-agents.json');
    const load = (x) => { fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: dir, worktreeRoot: dir, sharedDir: dir, guardCommand: 'run {wt} {skipArgs}' }, x))); return C.load(f); };
    const none = load({ guardCommand: 'run {wt}' });
    ok('C2a-1 no guardNeeds: no error, the key stays off (null)', !none.errors.length && none.config.guardNeeds === null, JSON.stringify(none.errors));
    for (const [what, v, want] of [['a marker string', { marker: '//' }, ['//']], ['a list of markers', { marker: ['//', '#'] }, ['//', '#']],
      ['glob and marker', { glob: ['*.test.js', 'tests/*.test.sh'], marker: '#' }, ['#']]]) {
      const r = load({ guardNeeds: v });
      ok(`C2a-1 guardNeeds ${what}: no error`, !r.errors.length && JSON.stringify([].concat(r.config.guardNeeds.marker)) === JSON.stringify(want), JSON.stringify(r.errors) + JSON.stringify(r.config && r.config.guardNeeds));
    }
    const dflt = load({ guardNeeds: { marker: '#' }, guardFiles: ['*.g'] });
    ok('C2a-1 guardNeeds without glob: the glob is guardFiles', !dflt.errors.length && JSON.stringify(dflt.config.guardNeeds.glob) === JSON.stringify(['*.g']), JSON.stringify(dflt.config && dflt.config.guardNeeds));
    for (const [what, v, re] of [['an empty marker', { marker: '' }, /guardNeeds\.marker/], ['a marker with a blank', { marker: '# x' }, /guardNeeds\.marker/],
      ['an empty marker list', { marker: [] }, /guardNeeds\.marker/], ['no marker', {}, /guardNeeds\.marker: required/], ['an empty glob list', { glob: [], marker: '#' }, /guardNeeds\.glob/],
      ['an unknown member', { marker: '#', extra: 1 }, /guardNeeds\.extra: unknown key/]]) {
      const r = load({ guardNeeds: v });
      ok(`C2a-1 guardNeeds ${what}: an error naming the member`, r.errors.some((e) => re.test(e)), JSON.stringify(r.errors));
    }
    const noSkip = load({ guardNeeds: { marker: '#' }, guardCommand: 'run {wt}' });
    ok('C2a-4 guardNeeds without {skipArgs} in guardCommand: an error', noSkip.errors.some((e) => /guardNeeds needs \{skipArgs\} in guardCommand/.test(e)), JSON.stringify(noSkip.errors));
    const noSkipL = load({ guardNeeds: { marker: '#' }, guardCommandLegacy: 'run {wt} {jobs}' });
    ok('C2a-4 guardNeeds without {skipArgs} in guardCommandLegacy (when set): an error', noSkipL.errors.some((e) => /guardNeeds needs \{skipArgs\} in guardCommandLegacy/.test(e)), JSON.stringify(noSkipL.errors));
    const both = load({ guardNeeds: { marker: '#' }, guardCommandLegacy: 'run {wt} {jobs} {skipArgs}' });
    ok('C2a-5 {skipArgs} in guardCommand and guardCommandLegacy: no error', !both.errors.length, JSON.stringify(both.errors));
    for (const [k, v] of [['guardSubsetCommand', { guardSubsetCommand: 'run {wt} {onlyArgs} {skipArgs}' }],
      ['guardRerun.command', { guardRerun: { command: 'one {wt} {name} {skipArgs}', newRedPattern: '^F (\\S+)' } }],
      ['remoteRun.subsetCommand', { guardSubsetCommand: 'run {wt} {onlyArgs}', guardRerun: { command: 'one {wt} {name}', newRedPattern: '^F (\\S+)', tallyPattern: '^n (\\d+)' }, remoteRun: { subsetCommand: 'run {wt} {onlyArgs} {skipArgs}' } }]]) {
      const r = load(v);
      ok(`C2a-5 {skipArgs} in ${k}: a placeholder error`, r.errors.some((e) => e.startsWith(k) && /\{skipArgs\}/.test(e)), JSON.stringify(r.errors));
    }
    ok('C2a-5 FILLS: {skipArgs} only for guardCommand and guardCommandLegacy', Object.entries(C.FILLS).every(([k, v]) => v.includes('skipArgs') === (k === 'guardCommand' || k === 'guardCommandLegacy')), JSON.stringify(C.FILLS));
  }

  // ---- C2a-2, C2a-3, C2a-18, C2a-19: the marker and the enumeration (guards-result.js needsOf)
  {
    const d = setup({ guards: { 'a.g': 'exit 0' }, needs: NEEDS, files: { 'guards/j.js': '// guards:needs browser, docker — a page and a container\n' } });
    const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d.wt, f)), { recursive: true }); fs.writeFileSync(path.join(d.wt, f), b); };
    w('guards/sp.g', '   #   guards:needs process-list — ps is refused\n');
    w('guards/nr.g', '# guards:needs browser —\n');
    w('guards/nd.g', '# guards:needs browser no dash\n');
    w('guards/gpu.g', '# guards:needs gpu — a graphics card\n');
    w('guards/di.g', '# guards:needs disk-image — hdiutil\n');
    w('guards/all.g', '# guards:needs browser, file-watcher, process-list, nested-sandbox, docker — every one\n');
    w('guards/out.txt', '# guards:needs browser — not a guard file\n');
    w('.gitignore', 'ig.g\n');
    w('guards/ig.g', '# guards:needs browser — ignored\n');
    const cfg = { glob: ['*.g', '*.js'], marker: ['#', '//'] };
    const r = GR.needsOf({ wt: d.wt, cfg });
    const by = Object.fromEntries((r.list || []).map((x) => [x.guard, x]));
    ok('C2a-2 a .js marker (//) with two needs: parsed, both needs', !!by['guards/j.js'] && JSON.stringify(by['guards/j.js'].needs) === JSON.stringify(['browser', 'docker']) && by['guards/j.js'].reason === 'a page and a container', JSON.stringify(r));
    ok('C2a-2 blanks around the marker: parsed', !!by['guards/sp.g'] && by['guards/sp.g'].needs[0] === 'process-list', JSON.stringify(r));
    ok('C2a-2 without a reason or without the dash: not a marker; a file outside the glob: ignored', !by['guards/nr.g'] && !by['guards/nd.g'] && !by['guards/out.txt'], JSON.stringify(r));
    ok('C2a-3 an unknown need (gpu): excluded, "unknown need gpu: <reason>"', !!by['guards/gpu.g'] && /^unknown need gpu: a graphics card$/.test(GR.needText(by['guards/gpu.g'])), JSON.stringify(by['guards/gpu.g']));
    ok('C2a-3 disk-image and the five measured needs are known: "needs <need>: <reason>"', !!by['guards/di.g'] && GR.needText(by['guards/di.g']) === 'needs disk-image: hdiutil'
      && !!by['guards/all.g'] && GR.needText(by['guards/all.g']) === 'needs browser, file-watcher, process-list, nested-sandbox, docker: every one', JSON.stringify([by['guards/di.g'], by['guards/all.g']]));
    ok('C2a-18 an untracked marked guard is excluded, an ignored one is not', !!by['guards/sp.g'] && !by['guards/ig.g'], JSON.stringify(r));
    const sel = GR.needsOf({ wt: d.wt, cfg, names: ['guards/a.g', 'guards/gpu.g'] });
    ok('C2a-6 a selection reads only the selected guards', !sel.error && JSON.stringify(sel.list.map((x) => x.guard)) === JSON.stringify(['guards/gpu.g']), JSON.stringify(sel));
    fs.chmodSync(path.join(d.wt, 'guards', 'gpu.g'), 0);
    const bad = GR.needsOf({ wt: d.wt, cfg });
    ok('C2a-19 a guard file that cannot be read: an error, nothing listed', !!bad.error && /guards\/gpu\.g/.test(bad.error), JSON.stringify(bad));
    fs.chmodSync(path.join(d.wt, 'guards', 'gpu.g'), 0o644);
    const nogit = GR.needsOf({ wt: path.join(T, 'no-such-dir'), cfg });
    ok('C2a-19 git does not answer (no worktree): an error', !!nogit.error, JSON.stringify(nogit));
  }

  // ---- C2a-8: a full run under the channel in each mode, one marked guard
  for (const mode of ['fixed', 'adaptive', 'whole']) {
    const d = setup({ mode, needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    const before = codexCalls();
    const r = ga(d, [], true);
    const log = read(d.OUT), m = metaOf(d.OUT);
    ok(`C2a-8 ${mode}: the runner gets --skip for the marked guard, which does not run; the others run in the executor`,
      /^SKIPPED guards\/b\.g$/m.test(log) && !/B-RAN/.test(log) && /RUNNER sb=fake/.test(log) && codexCalls() > before, log.slice(0, 1500));
    ok(`C2a-8 ${mode}: exit 79, the line "incomplete: 1 guard not run in the sandbox of a codex role: guards/b.g (needs browser: no browser in the sandbox)"`,
      r.status === 79 && /^incomplete: 1 guard not run in the sandbox of a codex role: guards\/b\.g \(needs browser: no browser in the sandbox\)$/m.test(log) && /^incomplete: /m.test(r.stdout), `exit ${r.status}\n${log.slice(-1500)}\n${r.stderr}`);
    ok(`C2a-8 ${mode}: the meta of the run - exec (the spec), rc 79, incomplete [{guard, needs, reason}]`,
      !!m && m.exec === path.join(d.root, 'exec.json') && m.rc === 79 && JSON.stringify(m.incomplete) === JSON.stringify([{ guard: 'guards/b.g', needs: ['browser'], reason: 'no browser in the sandbox' }]), JSON.stringify(m));
  }

  // ---- C2a-9: a runner that ignores --skip; C2a-11: a red guard and an excluded one
  {
    const d = setup({ needs: NEEDS, noSkip: true, guards: { 'a.g': 'exit 0', 'b.g': B } });
    const r = ga(d, [], true);
    const log = read(d.OUT);
    ok('C2a-9 (b) the runner ignores --skip, the marked guard runs green: still 79 with the list, never 0', r.status === 79 && /B-RAN/.test(log) && /^incomplete: /m.test(log) && guardsOf(metaOf(d.OUT)).join() === 'guards/b.g', `exit ${r.status}\n${log.slice(-1200)}`);
    const d2 = setup({ needs: NEEDS, noSkip: true, guards: { 'a.g': 'exit 0', 'b.g': B + 'exit 1\n' } });
    const r2 = ga(d2, [], true);
    const log2 = read(d2.OUT), m2 = metaOf(d2.OUT);
    ok('C2a-9 (a) the runner ignores --skip, the marked guard runs red: the red of the runner stays (not rerun, not 0, not 79), the list in the log and the meta',
      r2.status !== 0 && r2.status !== 79 && /^incomplete: /m.test(log2) && guardsOf(m2).join() === 'guards/b.g' && m2.rc === r2.status && !/single runs: .*\n[\s\S]*==== guards\/b\.g/.test(read(path.join(d2.P.shared, 'guards-wt.rerun.txt'))), `exit ${r2.status}\n${log2.slice(-1500)}`);
    const d3 = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'r.g': 'exit 1', 'b.g': B } });
    const r3 = ga(d3, [], true);
    const log3 = read(d3.OUT), m3 = metaOf(d3.OUT);
    ok('C2a-11 a red guard plus an excluded one: the code of the red (red again alone), "incomplete: ..." in the log, incomplete in the meta',
      r3.status !== 0 && r3.status !== 79 && /new red, red again alone: guards\/r\.g/.test(log3) && /^incomplete: /m.test(log3) && guardsOf(m3).join() === 'guards/b.g' && m3.rc === r3.status, `exit ${r3.status}\n${log3.slice(-1500)}`);
    ok('C2a-14 verdictOf of that run: red, notRun the list', (() => { const v = GR.verdictOf(r3.status, m3, path.join(d3.root, 'exec.json')); return v.verdict === 'red' && v.notRun.map((x) => x.guard).join() === 'guards/b.g'; })(), JSON.stringify(m3));
  }

  // ---- C2a-12: the rerun of a full run knows the excluded guards (G36)
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'flaky.g': '[[ -n $FIX_SINGLE ]]', 'b.g': B, 'k.g': 'exit 0' } });
    fs.writeFileSync(path.join(d.wt, 'baseline.json'), JSON.stringify({ 'guards/b.g': 'known: a browser', 'guards/k.g': 'known: fixed since' }));
    d.P.git('add', 'baseline.json'); d.P.git('commit', '-q', '-m', 'baseline');
    const r = ga(d, [], true);
    const log = read(d.OUT);
    ok('C2a-12 an excluded known red is never "known red not red now"; a known red that ran green is (control)',
      !/known red not red now: guards\/b\.g/.test(log) && /known red not red now: guards\/k\.g/.test(log), log.slice(-1500));
    ok('C2a-12 the flaky guard reruns green alone, the run ends 79 (not 0)', /flaky, red under load, green alone: guards\/flaky\.g/.test(log) && r.status === 79 && guardsOf(metaOf(d.OUT)).join() === 'guards/b.g', `exit ${r.status}\n${log.slice(-1500)}`);
  }

  // ---- C2a-6, C2a-20: a selection under the channel; a marker new against the base
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'old.g': '# guards:needs browser — a page\n', 'grow.g': '# guards:needs browser — a page\n', 'plain.g': 'exit 0' } });
    d.P.commit({ 'guards/a.g': 'exit 0 # changed\n', 'guards/old.g': '# guards:needs browser — a page\nexit 0 # changed\n', 'guards/grow.g': '# guards:needs browser, docker — a page\n',
      'guards/plain.g': '# guards:needs browser — a page now\n', 'guards/new.g': '# guards:needs docker — a container\n' });
    fs.writeFileSync(path.join(d.wt, 'guards', 'newu.g'), '# guards:needs browser — untracked\n');
    const r = ga(d, ['--select', 'main'], true);
    const log = read(d.SEL), m = metaOf(d.SEL);
    const by = Object.fromEntries(((m && m.incomplete) || []).map((x) => [x.guard, x]));
    ok('C2a-6 the excluded guards are left out of {onlyArgs} and of the count: the runner runs only a.g, 1 of 1 (not 69); exit 79',
      r.status === 79 && /^accounted 1, failed 0$/m.test(log) && !/environment: the run accounted/.test(log) && Object.keys(by).length === 5, `exit ${r.status}\n${log.slice(-1500)}\n${JSON.stringify(m)}`);
    ok('C2a-20 (a) a new file (tracked and untracked), (b) a marker added, (c) a need added: newMarker true and "(marker new in this diff)"',
      ['guards/new.g', 'guards/newu.g', 'guards/plain.g', 'guards/grow.g'].every((g) => by[g] && by[g].newMarker === true && new RegExp(`${g.replace(/[./]/g, '\\$&')} \\([^)]*\\) \\(marker new in this diff\\)`).test(log)), JSON.stringify(by) + log.slice(-1200));
    ok('C2a-20 (d) the same marker on the base: not flagged', !!by['guards/old.g'] && by['guards/old.g'].newMarker === undefined && /guards\/old\.g \(needs browser: a page\)(,|$)/m.test(log), JSON.stringify(by['guards/old.g']));
    const f = ga(d, [], true);
    const mf = metaOf(d.OUT);
    ok('C2a-20 (e) a full run has no base: nothing flagged', f.status === 79 && !!mf && mf.incomplete.every((x) => x.newMarker === undefined) && !/marker new in this diff/.test(read(d.OUT)), JSON.stringify(mf));
    const n = ga(d, ['--select', 'main'], false);
    ok('C2a-20 (f) / C2a-10 without the channel: the selection runs the marked guards, exit 0, no incomplete', n.status === 0 && /^accounted 6, failed 0$/m.test(read(d.SEL)) && !/incomplete/.test(read(d.SEL)) && metaOf(d.SEL).incomplete === undefined, `exit ${n.status}\n${read(d.SEL).slice(-800)}`);
  }

  // ---- C2a-7: every selected guard excluded: no slot, no runner, no codex
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    d.P.commit({ 'guards/b.g': B + '# changed\n' });
    const calls = codexCalls(), lines = slotLines(d).length;
    const r = ga(d, ['--select', 'main'], true);
    const log = read(d.SEL), m = metaOf(d.SEL);
    ok('C2a-7 all selected excluded: exit 79, "incomplete: ..." and not "nothing selected"; no slot journal line, codex never started',
      r.status === 79 && /^incomplete: 1 guard not run/m.test(log) && !/nothing selected/.test(log) && slotLines(d).length === lines && codexCalls() === calls && !/RUNNER/.test(log), `exit ${r.status}\n${log}\n${r.stderr}`);
    ok('C2a-7 the meta of this run: exec, rc 79, incomplete', !!m && m.exec === path.join(d.root, 'exec.json') && m.rc === 79 && guardsOf(m).join() === 'guards/b.g', JSON.stringify(m));
  }

  // ---- C2a-10: without CODIS_GUARDS_EXEC nothing changes (full, --select, --guards)
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    const r = ga(d, [], false);
    const log = read(d.OUT), m = metaOf(d.OUT);
    ok('C2a-10 a full run of a role of Claude: the marked guard runs, exit 0, no "incomplete", no exec and no incomplete in the meta',
      r.status === 0 && /B-RAN/.test(log) && !/SKIPPED/.test(log) && !/incomplete/.test(log) && !!m && m.exec === undefined && m.incomplete === undefined, `exit ${r.status}\n${log.slice(-800)}`);
    const names = path.join(d.root, 'names.json');
    fs.writeFileSync(names, JSON.stringify(['guards/b.g']));
    const g = ga(d, ['--guards', names], false);
    ok('C2a-10 --guards (the attribution of a train): the marked guard runs, exit 0', g.status === 0 && /B-RAN/.test(read(d.SEL)) && !/incomplete/.test(read(d.SEL)), `exit ${g.status}\n${read(d.SEL).slice(-600)}`);
  }

  // ---- C2a-13: an incomplete run is never reused; a green run of this machine is
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    const a1 = gaReuse(d, [], true);
    const a2 = gaReuse(d, [], true);
    ok('C2a-13 (a) the same role again on the same HEAD after 79: no reuse, a run again (79)', a1.status === 79 && a2.status === 79 && !/reused, HEAD/.test(a2.stdout), a2.stdout.slice(-600));
    const b = gaReuse(d, [], false);
    ok('C2a-13 (b) then a role of Claude: no reuse, everything runs, exit 0', b.status === 0 && !/reused, HEAD/.test(b.stdout) && /B-RAN/.test(read(d.OUT)), b.stdout.slice(-600));
    const c = gaReuse(d, [], true);
    ok('C2a-13 (c) the host was green on this HEAD x the role asks a full run: "reused", exit 0', c.status === 0 && /reused, HEAD/.test(c.stdout), c.stdout.slice(-600));
    ok('C2a-13 (c) verdictOf of a reused run: green, no notRun', (() => { const v = GR.verdictOf(0, metaOf(d.OUT), path.join(d.root, 'exec.json')); return v.verdict === 'green' && v.notRun === undefined; })(), JSON.stringify(metaOf(d.OUT)));
  }

  // ---- C2a-19: a guard file that cannot be read under the channel: 69, no runner
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B } });
    fs.chmodSync(path.join(d.wt, 'guards', 'b.g'), 0);
    const calls = codexCalls();
    const r = ga(d, [], true);
    const log = read(d.OUT), m = metaOf(d.OUT);
    fs.chmodSync(path.join(d.wt, 'guards', 'b.g'), 0o644);
    ok('C2a-19 69 "environment: the needs of the guards cannot be read: ...", the runner never starts, the meta of this run rc 69',
      r.status === 69 && /environment: the needs of the guards cannot be read: /.test(log + r.stderr) && codexCalls() === calls && !!m && m.rc === 69 && m.exec === path.join(d.root, 'exec.json'), `exit ${r.status}\n${log}\n${r.stderr}\n${JSON.stringify(m)}`);
    ok('C2a-19 verdictOf: environment', GR.verdictOf(69, m, path.join(d.root, 'exec.json')).verdict === 'environment', JSON.stringify(m));
  }

  // ---- C2a-14: verdictOf (own meta: meta.exec = the spec of this run)
  {
    const spec = '/s/heavy-runs/X/exec.json';
    const inc = [{ guard: 'g', needs: ['browser'], reason: 'r' }];
    const own = (rc, extra) => Object.assign({ exec: spec, rc }, extra || {});
    const cases = [
      ['own 79 with incomplete', 79, own(79, { incomplete: inc }), 'incomplete', true],
      ['own rc 1', 1, own(1), 'red', false],
      ['own rc 1 with incomplete', 1, own(1, { incomplete: inc }), 'red', true],
      ['own 69', 69, own(69, { incomplete: inc }), 'environment', false],
      ['a foreign meta (reuse) rc 0', 0, { rc: 0 }, 'green', false],
      ['no meta, early exit 78', 78, null, 'environment', false],
      ['no meta, 65', 65, null, 'environment', false],
      ['no meta, 73', 73, null, 'environment', false],
      ['a foreign meta with incomplete, this run 78', 78, { exec: '/s/heavy-runs/OLD/exec.json', rc: 79, incomplete: inc }, 'environment', false],
      ['a foreign meta 79, this run 79', 79, { exec: '/s/heavy-runs/OLD/exec.json', rc: 79, incomplete: inc }, 'environment', false],
    ];
    for (const [what, rc, m, want, nr] of cases) {
      const v = GR.verdictOf(rc, m, spec);
      ok(`C2a-14 verdictOf ${what}: ${want}${nr ? ', notRun the list' : ', no notRun'}`, v.verdict === want && (nr ? JSON.stringify(v.notRun) === JSON.stringify(inc) : v.notRun === undefined), JSON.stringify(v));
    }
    ok('C2a-17 the code of incomplete is one constant: guards-result.js INCOMPLETE = 79, and guards-all.sh has no literal 79 in its code',
      GR.INCOMPLETE === 79 && !read(GA).split('\n').filter((l) => !/^\s*#/.test(l)).some((l) => /\b79\b/.test(l)), String(GR.INCOMPLETE));
  }

  // ---- C2a-14, C2a-15, C2a-21: through the adapter (heavy-req.js, fake codex)
  {
    const d = setup({ needs: NEEDS, guards: { 'a.g': 'exit 0', 'b.g': B, 't.g': 'print -r -- "TP=$TMPPREFIX"' } });
    // the executor gets HOME of the user: here one without a machine file, as the slot directory of the case decides
    d.env.HOME = d.root;
    const svc = HS.openHeavyService({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state, config: d.P.cfg,
      codex: path.join(bin, 'codex'), userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200, inject: { probe: async () => ({}) } });
    const answers = path.join(d.state, 'K', 'heavy-calls', 'prog-1');
    const req = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [CLIENT].concat(args, ['--max', '120']), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answers }) });
      let out = '';
      p.stdout.on('data', (b) => { out += b; });
      p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(Object.assign({ rcClient: rc }, j || {})); });
    });
    const a = await req(['--kind', 'full']);
    ok('C2a-14/15 --kind full through the adapter: done, rc 79, verdict incomplete, notRun [guards/b.g with its need and reason], client exit 0',
      a.state === 'done' && a.rc === 79 && a.verdict === 'incomplete' && Array.isArray(a.notRun) && a.notRun.length === 1 && a.notRun[0].guard === 'guards/b.g' && a.notRun[0].needs[0] === 'browser' && a.notRun[0].reason === 'no browser in the sandbox' && a.rcClient === 0,
      JSON.stringify(a));
    const tp = /TP=(\S*)/.exec(read(d.OUT));
    ok('C2a-21 the executor of a guard run has TMPPREFIX=<TMPDIR of the run>/zsh', !!tp && tp[1] === path.join(fs.realpathSync(d.tdir), 'heavy-tmp', 'prog-1', a.id, 'zsh'), tp ? tp[1] : read(d.OUT).slice(0, 600));
    const s = await req(['--', 'zsh', '-c', 'print -r -- "TP=$TMPPREFIX"']);
    const stp = /TP=(\S*)/.exec(read(s.log));
    ok('C2a-15 a single command: no verdict, no notRun', s.state === 'done' && s.rc === 0 && s.verdict === undefined && s.notRun === undefined, JSON.stringify(s));
    ok('C2a-21 the executor of a single command has TMPPREFIX=<TMPDIR of the run>/zsh', !!stp && stp[1] === path.join(fs.realpathSync(d.tdir), 'heavy-tmp', 'prog-1', s.id, 'zsh'), stp ? stp[1] : read(s.log).slice(0, 600));
    await svc.close();
  }

  // ---- C2a-16: the host section
  {
    const t = { dir: '/x/task' };
    const on = RX.hostSection('prog', t, { heavy: true }), te = RX.hostSection('test', t, { heavy: true }), rv = RX.hostSection('review', t, { heavy: true });
    ok('C2a-16 prog/test: verdict (green, red, incomplete, environment) and notRun; incomplete is named under Incomplete, never green, not a red of the product',
      [on, te].every((s) => /verdict/.test(s) && /green/.test(s) && /incomplete/.test(s) && /environment/.test(s) && /notRun/.test(s) && /Incomplete/.test(s) && /never call the run green/.test(s) && /not a red of the product/.test(s)), on);
    ok('C2a-16 a guard without a marker red only from the sandbox: a red of the run, a candidate for a guards:needs marker, not of the product; no answer without verdict is green',
      [on, te].every((s) => /candidate for a `?guards:needs`? marker/.test(s) && /without (a )?verdict/.test(s)), on);
    ok('C2a-16 review: no heavy line', !/heavy-req/.test(rv), rv);
  }

  // ---- C2a-17: living docs
  {
    const readme = read(path.join(ROOT, 'README.md')), schema = JSON.parse(read(path.join(ROOT, 'schemas', 'codis-agents.schema.json'))), head = read(GA).split('\n').filter((l) => /^#/.test(l)).join('\n');
    ok('C2a-17 the schema has guardNeeds (glob, marker: string or list)', !!schema.properties.guardNeeds && !!schema.properties.guardNeeds.properties.marker && !!schema.properties.guardNeeds.properties.glob, JSON.stringify(schema.properties.guardNeeds));
    ok('C2a-17 README: guardNeeds, {skipArgs}, 79 incomplete', /`guardNeeds`/.test(readme) && /\{skipArgs\}/.test(readme) && /79/.test(readme) && /incomplete/.test(readme), '');
    ok('C2a-17 README Known gaps: a full run has no base, a marker new in the task is not flagged', /a full run has no base: a marker new in the task is not flagged/.test(readme), '');
    ok('C2a-17 the header of guards-all.sh: guardNeeds, {skipArgs}, incomplete', /guardNeeds/.test(head) && /\{skipArgs\}/.test(head) && /incomplete/.test(head), head.slice(-1200));
  }
  // ---- the tester cells: tests/heavy-guards-needs-tester-cases.js (TN1-TN9: quoted guard names, several marker lines,
  // a need removed or replaced against the base, a deleted selected file, lines that are not markers, the channel
  // without the key, verdictOf of an own meta without the result, an unreadable selected guard)
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'heavy-guards-needs-tester-cases.js')], { encoding: 'utf8', timeout: 280000 });
    ok('the tester cells of the needs of guards (tests/heavy-guards-needs-tester-cases.js) pass', tc.status === 0, `exit ${tc.status} ${tc.signal || ''}\n${String(tc.stdout).split('\n').filter((l) => /FAIL/.test(l)).join('\n').slice(0, 3000)}${String(tc.stderr).slice(-800)}`);
  }
  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
