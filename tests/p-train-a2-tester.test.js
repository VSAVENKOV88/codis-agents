#!/usr/bin/env node
'use strict';
// p-train-a2, tester round 1: cells of the selection step the programmer's tests/p-train-a2.test.js does not cover.
//   E1 (S5 x a known red outside the selection) - guards-all.sh --select runs only the guards of the diff, so a known red
//      (guardBaseline) that is not selected did not run: the log must not call it "known red not red now ... remove it
//      from the baseline" (that line tells a role to drop a real known red). A known red that is selected and green is
//      still named stale.
//   E2 (S1 x a guard name with a quote, a space and $(...)) - {onlyArgs} carries the name as one literal argument; no
//      command of the name runs.
// Round 2 (after the fix of E1: the list of the selected guards, guards-select.js --names-out):
//   N1 - both sources of known reds (guardBaseline, the quarantine): stale only within the selection, nothing written;
//   N2 - guards-result.js rerun with a damaged names file: not 0, said, never "not red now";
//   N3 - guards-remote.js --selected without --subset or with a damaged list: 64 before any config or ssh;
//   N4 - guards-all.sh --select leaves no temporary file (the names file) after green, red, empty and 65 runs.
//   E3 (S17 x a rejection) - light mode: a rejection for code and one for docs only, each with a new HEAD, get the
//      selection on that HEAD before the second review.
// usage: node tests/p-train-a2-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8'); } catch { return null; } };

// ---- E3: role-chain with fake agents (as tests/p-train-a2.test.js)
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ONE = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md', guardSubsetCommand: 'npm run guards -- {onlyArgs}', guardAlways: ['semgrep-diff'] };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', noAnalysis: 'one-line fix', base: 'arc', mode: 'light' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
async function run(script, task = T, config = ONE) {
  const full = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return OKR;
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + full.join('>'));
    return q[role].shift();
  };
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], full: full.join('>') };
}
async function partE3() {
  const REJ = { verdict: 'rejected', docsOnly: false, summary: 'rej' }, DREJ = { verdict: 'rejected', docsOnly: true, summary: 'docs' }, D = { verdict: 'done', docsOnly: false, summary: '' };
  let x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2' })], review: [REJ, D] });
  ok('E3. light, rejection for code with a new HEAD -> the selection on it -> the second review',
    x.r.status === 'done' && x.full === 'pre>prog>run:x:select-1>review>diff:x:reviewer>prog>run:x:select-r>review>diff:x:reviewer>left:x:end', x.full);
  x = await run({ pre: [PRE], prog: [PROG, Object.assign({}, PROG, { head: 'P2', changedFiles: ['README.md'] })], review: [DREJ, D] });
  ok('E3. light, rejection for docs only with a new HEAD -> the selection on it too (guardAlways) -> the second review',
    x.r.status === 'done' && x.full.includes('prog>run:x:select-r>review'), x.full);
  x = await run({ pre: [PRE], prog: [PROG, PROG], review: [REJ, D] });
  ok('E3. light, rejection answered without a commit (same HEAD) -> no second selection',
    x.r.status === 'done' && (x.full.match(/run:x:select/g) || []).length === 1, x.full);
}

// ---- E1, E2: guards-all.sh --select on a temporary project (as part B of tests/p-train-a2.test.js)
const fakeBin = (bin) => {
  const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
  sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
  sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
  sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
};
// Every knob of slots.zsh by name (slots-hermetic checks the list), then anything else of the same families.
const cleanEnv = () => {
  for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
    'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];
  for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
};
const gitC = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

function partB(TMP) {
  const bin = path.join(TMP, 'bin'), wts = path.join(TMP, 'wts'), sh2 = path.join(TMP, 'shared'), w = path.join(wts, 'pw');
  for (const d of [bin, sh2, w]) fs.mkdirSync(d, { recursive: true });
  fakeBin(bin);
  const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), s); if (mode) fs.chmodSync(path.join(w, f), mode); };
  // sub.sh: every argument on its own line; prints the prepared log and exits with the prepared code
  put('sub.sh', `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${TMP}/sub.args"\ncat "${TMP}/sub.log"\nexit $(cat "${TMP}/sub.rc")\n`, 0o755);
  put('full.sh', '#!/bin/sh\necho "=== full ==="\nexit 0\n', 0o755);
  put('one.sh', `#!/bin/sh\ngrep -qxF -- "$1" "${TMP}/red.txt" && exit 1\nexit 0\n`, 0o755);
  put('lib.js', 'module.exports = 1;\n');
  put('g/b-run.js', "require('../lib');\n");
  put('g/c-run.js', '// another area\n');
  put('known.json', '{}\n');
  gitC(w, 'init', '-q', '-b', 'base'); gitC(w, 'add', '.'); gitC(w, 'commit', '-q', '-m', 'base');
  gitC(w, 'checkout', '-q', '-b', 'task'); put('lib.js', 'module.exports = 2;\n'); gitC(w, 'add', 'lib.js'); gitC(w, 'commit', '-q', '-m', 'change lib');
  const f = path.join(TMP, 'cfg.json');
  fs.writeFileSync(f, JSON.stringify({ repoDir: path.join(TMP, 'main'), worktreeRoot: wts, sharedDir: sh2, guardCommand: 'cd {wt} && ./full.sh', guardSubsetCommand: 'cd {wt} && ./sub.sh {onlyArgs}',
    guardRerun: { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* ===$' },
    guardBaseline: 'known.json', guardAlways: [], protectedBranches: ['base'], slots: { lockDir: path.join(TMP, 'slots'), legacyLock: path.join(TMP, 'guards.lock') } }));
  cleanEnv();
  // N4: the temporary files of guards-all.sh (the names file of a selection among them) go into a TMPDIR of its own
  const TD = path.join(TMP, 'tmp'); fs.mkdirSync(TD);
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', TMPDIR: TD });
  const leftTmp = () => fs.readdirSync(TD).filter((n) => /^guards/.test(n));
  const ga = (...a) => { const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', ...a], { encoding: 'utf8', env, timeout: 120000 }); r.all = (r.stdout || '') + (r.stderr || ''); return r; };
  const SEL = path.join(sh2, 'guards-pw.select.txt');
  const set = (rc, reds) => {
    fs.writeFileSync(path.join(TMP, 'sub.log'), reds.map((n) => `FAILED ${n} - code 1`).join('\n') + `\n=== ${reds.length} failed ===\n`);
    fs.writeFileSync(path.join(TMP, 'sub.rc'), String(rc)); fs.writeFileSync(path.join(TMP, 'red.txt'), '');
    fs.rmSync(path.join(TMP, 'sub.args'), { force: true });
  };
  // the baseline is read from the committed tree (the run tests HEAD): commit each version
  const known = (o) => { put('known.json', JSON.stringify(o) + '\n'); gitC(w, 'add', 'known.json'); gitC(w, 'commit', '-q', '-m', 'known'); };
  const args = () => (read(path.join(TMP, 'sub.args')) || '').split('\n').filter(Boolean);

  // E1: a known red outside the selection, the selection green
  known({ 'g/c-run.js': 'known: red for a reason of its own' });
  set(0, []);
  let x = ga('--force', '--select', 'base', 'pw');
  ok('E1. setup: the selection ran g/b-run.js only, exit 0', x.status === 0 && args().includes('g/b-run.js') && !args().includes('g/c-run.js'), `${x.status} [${args()}] ${x.all}`);
  ok('E1. a known red that is not in the selection is not called "not red now" (it did not run)',
    !/not red now: g\/c-run\.js/.test(read(SEL) || ''), read(SEL));
  // E1: the same on a red selection whose only red is known
  known({ 'g/b-run.js': 'known: selected and red', 'g/c-run.js': 'known: red for a reason of its own' });
  set(1, ['g/b-run.js']);
  x = ga('--force', '--select', 'base', 'pw');
  ok('E1. setup: only the selected known red -> exit 0, "1 known red"', x.status === 0 && /1 known red/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);
  ok('E1. ... and the known red outside the selection is not named stale there either',
    !/not red now: g\/c-run\.js/.test(read(SEL) || ''), read(SEL));
  // E1 control: a known red that is selected and green is still named stale
  set(0, []);
  x = ga('--force', '--select', 'base', 'pw');
  ok('E1. a selected known red that ran green is still "not red now" (the stale entry is found within the selection)',
    x.status === 0 && /not red now: g\/b-run\.js/.test(read(SEL) || ''), `${x.status} ${read(SEL)}`);

  // E2: a guard file name with a quote, spaces and $(...)
  const odd = "g/it's $(touch PWNED) x-run.js";
  known({});
  put(odd, "require('../lib');\n"); gitC(w, 'add', '--', odd); gitC(w, 'commit', '-q', '-m', 'odd guard');
  set(0, []);
  x = ga('--force', '--select', 'base', 'pw');
  ok('E2. the odd guard name reaches the subset command as one literal argument after --only',
    x.status === 0 && args().indexOf(odd) > 0 && args()[args().indexOf(odd) - 1] === '--only', `${x.status} [${args().join('|')}] ${x.all}`);
  ok('E2. no command from the name ran', !fs.existsSync(path.join(w, 'PWNED')) && !fs.existsSync(path.join(TMP, 'PWNED')) && !fs.existsSync(path.join(w, 'g', 'PWNED')));

  // N4 (round 2): the names file of a selection (guards-select.js --names-out) does not outlive the run
  ok('N4. after green selections no temporary file of guards-all.sh is left (the names file included)', leftTmp().length === 0, `[${leftTmp()}]`);
  set(1, ['g/b-run.js']); fs.writeFileSync(path.join(TMP, 'red.txt'), 'g/b-run.js\n');
  x = ga('--force', '--select', 'base', 'pw');
  ok('N4. setup: a red selection (red again alone) -> exit 1', x.status === 1, `${x.status} ${read(SEL)}`);
  ok('N4. ... and no temporary file is left after it', leftTmp().length === 0, `[${leftTmp()}]`);
  x = ga('--force', '--select', 'HEAD', 'pw');
  ok('N4. setup: base = HEAD -> nothing selected, exit 0', x.status === 0 && /nothing selected/.test(read(SEL) || ''), `${x.status} ${x.all}`);
  ok('N4. ... and no temporary file is left after it', leftTmp().length === 0, `[${leftTmp()}]`);
  x = ga('--force', '--select', 'no-such-ref', 'pw');
  ok('N4. setup: an unknown base -> 65', x.status === 65, `${x.status} ${x.all}`);
  ok('N4. ... and no temporary file is left after it', leftTmp().length === 0, `[${leftTmp()}]`);
}

// ---- N1-N3 (round 2): the list of the selected guards, its source and its damage
function partN(TMP) {
  const G = require('../scripts/guards-result.js');
  const wt = path.join(TMP, 'nw'); fs.mkdirSync(wt, { recursive: true });
  const cfg = { command: 'true {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* ===$' };
  const log = path.join(TMP, 'n.txt'), qf = path.join(TMP, 'q.json');
  fs.writeFileSync(path.join(wt, 'known.json'), JSON.stringify({ 'b/base-sel-run.js': 'known: selected', 'b/base-out-run.js': 'known: outside' }) + '\n');
  fs.writeFileSync(qf, JSON.stringify({ 'q/q-sel-run.js': 'red: a quarantined one, selected', 'q/q-out-run.js': 'red: a quarantined one, outside' }) + '\n');
  const green = () => fs.writeFileSync(log, '=== 0 failed ===\n');
  // N1: both sources, a green selection of one entry of each
  green();
  let r = G.rerun({ wt, log, rc: 0, cfg, baseline: 'known.json', quarantine: qf, readOnly: 'select', selected: ['b/base-sel-run.js', 'q/q-sel-run.js'] });
  ok('N1. a selected baseline entry that ran green -> "not red now ... remove it from the baseline"', /known red not red now: b\/base-sel-run\.js — remove it from the baseline/.test(r.text), r.text);
  ok('N1. a selected quarantine entry that ran green -> "not red now ... remove it from the quarantine"', /known red not red now: q\/q-sel-run\.js — remove it from the quarantine/.test(r.text), r.text);
  ok('N1. entries of either source outside the selection are not named', !/base-out-run|q-out-run/.test(r.text), r.text);
  ok('N1. a selection writes nothing into the quarantine', JSON.parse(fs.readFileSync(qf, 'utf8'))['q/q-out-run.js'] === 'red: a quarantined one, outside' && Object.keys(JSON.parse(fs.readFileSync(qf, 'utf8'))).length === 2);
  green();
  r = G.rerun({ wt, log, rc: 0, cfg, baseline: 'known.json', quarantine: qf, readOnly: 'select', selected: [] });
  ok('N1. an empty list of the selected -> no entry is named', !/not red now/.test(r.text), r.text);
  // N2: the command line of guards-result.js rerun with a damaged names file
  const cli = (sf, rc = '0') => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'rerun', wt, log, rc, JSON.stringify(cfg), 'known.json', qf, 'select', sf], { encoding: 'utf8' });
  for (const [what, body] of [['not JSON', '{oops'], ['not an array', '{"a": 1}'], ['not names', '[1, 2]'], ['missing', null]]) {
    const sf = path.join(TMP, `sel-${what.replace(/\W/g, '')}.json`);
    if (body !== null) fs.writeFileSync(sf, body);
    green();
    const c = cli(sf);
    const lg = fs.readFileSync(log, 'utf8');
    ok(`N2. rerun with a names file ${what} on a green run -> not 0, says so, no "not red now"`, c.status !== 0 && /selected guards file/.test(c.stderr) && !/not red now/.test(lg + c.stdout), `${c.status} ${c.stderr} ${lg}`);
  }
  const good = path.join(TMP, 'sel-good.json'); fs.writeFileSync(good, JSON.stringify(['b/base-sel-run.js']));
  green();
  let c = cli(good);
  ok('N2. control: a good names file -> exit 0, only the selected one named', c.status === 0 && /not red now: b\/base-sel-run\.js/.test(c.stdout) && !/q-sel-run|base-out-run|q-out-run/.test(c.stdout), `${c.status} ${c.stdout} ${c.stderr}`);
  // N3: guards-remote.js refuses a list without a selection command, and a damaged list, before any config or ssh
  const rem = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-remote.js'), 'run', wt, log, 'n', '', ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: path.join(TMP, 'no-such-config.json') }) });
  c = rem('--selected', good);
  ok('N3. guards-remote.js --selected without --subset -> 64', c.status === 64 && /--selected goes with --subset/.test(c.stderr), `${c.status} ${c.stderr}`);
  c = rem('--subset', 'cmd', '--selected', path.join(TMP, 'sel-notnames.json'));
  ok('N3. guards-remote.js --selected with a list that is not names -> 64', c.status === 64 && /not a JSON array of names/.test(c.stderr), `${c.status} ${c.stderr}`);
  c = rem('--subset', 'cmd', '--selected', path.join(TMP, 'sel-missing.json'));
  ok('N3. guards-remote.js --selected with a missing file -> 64', c.status === 64 && /selected guards file/.test(c.stderr), `${c.status} ${c.stderr}`);
}

(async () => {
  await partE3();
  if (!(has('zsh') && has('git'))) { skip('E1, E2. guards-all.sh --select end to end', 'zsh or git not found'); return done(); }
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p-train-a2-tester-')));
  try { partB(TMP); partN(TMP); } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  done();
})().catch((e) => { console.error(e); process.exit(1); });
