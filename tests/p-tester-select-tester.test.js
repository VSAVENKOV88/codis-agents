#!/usr/bin/env node
'use strict';
// p-tester-select, the tester's cells (round 1): what tests/p-tester-select.test.js does not cover.
//   TA - workflows/role-chain.js with fake agents:
//     TA1 a tester round after a review rejection (a fix with behaviour) selects from the fix's HEAD, never from the
//         HEAD of the programmer's first round or of the first tester;
//     TA2 the second tester after a red tester never selects from the first tester's own HEAD (st.head after the
//         tester), only from the programmer's new HEAD.
//   TE - scripts/guards-all.sh --select <a full sha> end to end (the real script, a fake subset command): the base the
//     tester's prompt now gives is a commit, not a branch; the subset command gets exactly the tester's guard, the
//     product guard importing the fixture it changed, the guard naming a fixture it changed, and guardAlways - not the
//     programmer's product guard; the same worktree from the task's base still selects the product guard; the
//     programmer's HEAD itself selects only guardAlways.
// usage: node tests/p-tester-select-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done, skip, has } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 800));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// --- TA: the workflow with fake agents ---
const SRC = (read(path.join(ROOT, 'workflows', 'role-chain.js')) || '').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md', guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PH = '1'.repeat(40), P2H = '2'.repeat(40), TH = '3'.repeat(40);
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: PH, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: P2H, changedFiles: ['src/b.js'] });
const GREEN = { verdict: 'green', summary: '', head: TH }, RED = { verdict: 'red', summary: 'r', head: TH };
const D = { verdict: 'done', docsOnly: false, summary: '' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'a missing case' };

async function run(script) {
  const trace = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'green' };
    if (role === 'sha') return { sha: '' };
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    return q[role].shift();
  };
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [T] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), tests: prompts.filter((p) => p.role === 'test').map((p) => p.prompt) };
}
const step4 = (p) => (p.match(/\n4\. [^\n]*/) || [''])[0];
const selOf = (p) => { const m = step4(p).match(/guards-all\.sh --select '([^']*)' 'w'/); return m ? m[1] : null; };

async function partTA() {
  // TA1: review 1 rejects -> a fix with behaviour (P2) -> a tester round -> review 2
  let x = await run({ pre: [PRE], prog: [PROG, P2], test: [GREEN, GREEN], review: [REJ, D] });
  ok('TA1. review rejection -> fix P2 -> the tester round after it selects from P2 (the first tester from P)',
    x.r.status === 'done' && x.tests.length === 2 && selOf(x.tests[0]) === PH && selOf(x.tests[1]) === P2H,
    `${x.r.status} ${x.trace} :: ${x.tests.map(selOf).join(' | ')}`);
  ok('TA1. ... never from the first tester\'s own HEAD nor from the task\'s base', x.tests.every((p) => !step4(p).includes(TH) && !step4(p).includes("--select 'arc'")), x.tests.map(step4).join(' || '));
  // TA2: a red tester (its own commit TH) -> programmer P2 on top of it -> the second tester selects from P2, not TH
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED, GREEN], review: [D] });
  ok('TA2. red tester with its own HEAD -> programmer P2 -> the second tester selects from P2, not from the tester\'s HEAD',
    x.r.status === 'done' && x.tests.length === 2 && selOf(x.tests[1]) === P2H && !step4(x.tests[1]).includes(TH), x.tests.map(step4).join(' || '));
}

// --- TE: guards-all.sh --select <full sha> end to end ---
function fakeBin(bin) {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
}
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
function cleanEnv() {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_SAY']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
  delete process.env.CLAUDE_PROJECT_DIR;
}

function partTE(TMP) {
  const gitC = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' }); return (r.stdout || '').trim(); };
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), shared = path.join(TMP, 'shared'), w = path.join(wts, 'tw');
  for (const d of [bin, shared, w]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), s); if (mode) fs.chmodSync(path.join(w, f), mode); };
  // the subset command: records its guards, prints the tally of what it was given
  put('sub.sh', `#!/bin/zsh\nn=0; for a in "$@"; do [[ $a == --only ]] && continue; print -r -- "$a" >> "${TMP}/sub.args"; n=$((n+1)); done\nprint -r -- "TOTAL: $n total"\nexit 0\n`, 0o755);
  put('full.sh', '#!/bin/sh\necho "TOTAL: 0 total"\n', 0o755);
  put('one.sh', '#!/bin/sh\necho "TOTAL: 1 total"\n', 0o755);
  put('src/model.js', 'module.exports = 1;\n');
  put('g/model-run.js', "require('../src/model');\n");
  put('g/cards-run.js', "require('../fx/cards.json');\n");
  put('g/layout-run.js', "// reads the fixture by its name only\nconst f = fixture('layout');\n");
  put('fx/cards.json', '[]\n');
  put('fx/layout.txt', 'a\n');
  put('g/other-run.js', "console.log('other');\n");
  put('g/semgrep-diff-run.js', '// scans the diff\n');
  gitC(w, 'init', '-q', '-b', 'arc'); gitC(w, 'add', '.'); gitC(w, 'commit', '-q', '-m', 'arc');
  gitC(w, 'checkout', '-q', '-b', 'task');
  put('src/model.js', 'module.exports = 2;\n');
  gitC(w, 'add', 'src/model.js'); gitC(w, 'commit', '-q', '-m', 'programmer');
  const prog = gitC(w, 'rev-parse', 'HEAD');
  put('fx/cards.json', '[1]\n');
  put('fx/layout.txt', 'b\n');
  put('g/model-tester-run.js', "// the tester's own guard\n");
  gitC(w, 'add', 'fx/cards.json', 'fx/layout.txt', 'g/model-tester-run.js'); gitC(w, 'commit', '-q', '-m', 'tester');
  const f = path.join(TMP, 'cfg.json');
  fs.writeFileSync(f, JSON.stringify({ repoDir: path.join(TMP, 'main'), worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh',
    guardSubsetCommand: 'cd {wt} && ./sub.sh {onlyArgs}', guardAlways: ['semgrep-diff'], guardFiles: ['*-run.js'],
    guardRerun: { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^X (\\S+)  \\(', tallyPattern: '^TOTAL: (\\d+) total$' },
    protectedBranches: ['arc'], slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }));
  cleanEnv();
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
  const SEL = path.join(shared, 'guards-tw.select.txt');
  const ga = (base) => {
    fs.rmSync(path.join(TMP, 'sub.args'), { force: true });
    const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', '--force', '--select', base, 'tw'], { encoding: 'utf8', env, timeout: 120000 });
    r.all = (r.stdout || '') + (r.stderr || '');
    r.args = (read(path.join(TMP, 'sub.args')) || '').split('\n').filter(Boolean).sort();
    return r;
  };
  const want = ['g/cards-run.js', 'g/layout-run.js', 'g/model-tester-run.js', 'g/semgrep-diff-run.js'];
  let x = ga(prog);
  ok('TE1. guards-all.sh --select <the programmer\'s full sha> -> exit 0, the subset command gets the tester\'s guard, the importer and the namer of its fixtures, guardAlways',
    x.status === 0 && x.args.join() === want.join(), `${x.status} [${x.args.join()}] ${x.all.slice(-800)} ${read(SEL)}`);
  ok('TE1. ... not the programmer\'s product guard nor an unrelated one, and no environment line', !x.args.includes('g/model-run.js') && !x.args.includes('g/other-run.js') && !/environment:/.test(read(SEL) || ''), `[${x.args.join()}] ${read(SEL)}`);
  x = ga('arc');
  ok('TE2. the same worktree from the task\'s base (the workflow\'s selection) still runs the product guard too', x.status === 0 && x.args.includes('g/model-run.js') && want.every((g) => x.args.includes(g)), `${x.status} [${x.args.join()}]`);
  gitC(w, 'checkout', '-q', prog);
  x = ga(prog);
  ok('TE3. on the programmer\'s HEAD itself (no commit of the tester) only guardAlways would run', x.status === 0 && x.args.join() === 'g/semgrep-diff-run.js', `${x.status} [${x.args.join()}] ${read(SEL)}`);
}

(async () => {
  await partTA();
  if (!(has('zsh') && has('git'))) skip('guards-all.sh --select <sha> end to end', 'zsh or git not found');
  else {
    const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tsel-tester-')));
    try { partTE(TMP); } catch (e) { ok('TE crashed', false, e.stack); } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  }
  done();
})();
