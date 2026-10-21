#!/usr/bin/env node
'use strict';
// Tester guard U2b-3: edges of known reds (guardBaseline), testerWritable without a default and chain-cost on wrong
// paths that tests/known-red.test.js, tests/tester-writable.test.js and tests/chain-cost-paths.test.js do not reach:
// - F2 a new red whose name is an Object.prototype member (constructor, toString, hasOwnProperty, __proto__) is not
//   "known" because of the prototype of the baseline object: it reruns and its code stands;
// - F2 an empty baseline {} subtracts nothing (the rerun goes as without a baseline);
// - F5 config: a "~/" path is an error, an empty guardBaseline without guardRerun is not;
// - F5/F2 end to end through guards-all.sh: a broken baseline file -> the error line and the runner's code, nothing
//   reruns; one known + one new red again alone -> the runner's code, only the new one reruns; no guardBaseline key
//   -> the reruns as before (the config prints an empty string, not "null");
// - E2 testerWritable that is not a list (a string) stops the chain before any agent; the rerun rule names the
//   baseline only when the key is set; E4 through the CLI the role chain calls (--allow);
// - H3 a directory with transcripts but no *.meta.json -> 66; H4 a .meta.json that is JSON null, or every record
//   broken -> notes, exit 0, no stack trace.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const zsh = has('zsh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'known-red-edges-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const log = (names, tally = true) => names.map((n) => `FAILED ${n} - AssertionError`).join('\n') + '\n' + (tally ? `=== ${names.length} failed, 7 passed in 1.2s ===\n` : '');
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' };
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };

async function main() {
  // --- config ---
  const errs = (extra) => C.resolve(Object.assign({}, base, extra)).errors.join('; ');
  ok('F5 config: guardBaseline "~/k.json" -> error (relative to the worktree)', /guardBaseline: a path relative to the worktree/.test(errs({ guardRerun: RERUN, guardBaseline: '~/k.json' })), errs({ guardRerun: RERUN, guardBaseline: '~/k.json' }));
  ok('F5 config: an empty guardBaseline without guardRerun -> no error', errs({ guardBaseline: '' }) === '', errs({ guardBaseline: '' }));

  // --- rerun: prototype names and an empty baseline ---
  const cfg = C.resolve(Object.assign({}, base, { guardRerun: RERUN })).config.guardRerun;
  const wt = path.join(tmp, 'wt'); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\necho "$1" >> "${tmp}/calls.txt"\nexit 1\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  const logf = path.join(tmp, 'guards-wt.txt');
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const known = (obj) => fs.writeFileSync(path.join(wt, 'known.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const R = (names, rc = 1) => { fs.writeFileSync(logf, log(names)); fs.rmSync(path.join(tmp, 'calls.txt'), { force: true });
    return G.rerun({ wt, log: logf, rc, cfg, baseline: 'known.json' }); };
  if (!zsh) skip('F2 prototype names and an empty baseline', 'zsh not found');
  else {
    known({ 'tests/test_a.py::t1': 'BACKLOG #1' });
    for (const n of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const r = R(['tests/test_a.py::t1', n]);
      ok(`F2 a new red named ${n} is not known through the prototype -> it reruns, the runner code stands`,
        r.rc === 1 && JSON.stringify(calls()) === JSON.stringify([n]) && /\b1 known red\b/.test(r.text) && !/no new reds/.test(r.text), `${r.text} calls ${calls()}`);
    }
    known({});
    const r = R(['tests/test_a.py::t1']);
    ok('F2 an empty baseline {} subtracts nothing -> the red reruns, the runner code stands', r.rc === 1 && JSON.stringify(calls()) === '["tests/test_a.py::t1"]' && !/known red/.test(r.text), `${r.text} calls ${calls()}`);
  }

  // --- guards-all.sh end to end ---
  if (!zsh) skip('guards-all.sh with a broken baseline / known + new / no key', 'zsh not found');
  else {
    const T = path.join(tmp, 'e2e');
    const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), w = path.join(wts, 'pw');
    for (const d of [bin, shared, w]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    fs.writeFileSync(path.join(T, 'full.log'), log(['tests/test_a.py::t1', 'tests/test_n.py::new']));
    fs.writeFileSync(path.join(w, 'full.sh'), `#!/bin/sh\necho run >> "${T}/full.count"\ncat "${T}/full.log"\nexit 1\n`);
    fs.writeFileSync(path.join(w, 'one.sh'), `#!/bin/sh\necho "$1" >> "${T}/one.count"\nexit 1\n`);
    for (const f of ['full.sh', 'one.sh']) fs.chmodSync(path.join(w, f), 0o755);
    fs.mkdirSync(path.join(w, 'tests'));
    fs.writeFileSync(path.join(w, 'tests', 'known-red.json'), '{"tests/test_a.py::t1": ');
    git(w, 'init', '-q'); git(w, 'add', 'full.sh', 'one.sh', 'tests/known-red.json'); git(w, 'commit', '-q', '-m', 'w');
    const f = path.join(T, 'cfg.json');
    const writeCfg = (extra) => fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: path.join(T, 'main'), worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh',
      guardRerun: RERUN, slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }, extra)));
    const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env[k];
    const count = (n) => { try { return fs.readFileSync(path.join(T, n), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const ga = (...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env, timeout: 120000 });

    writeCfg({ guardBaseline: 'tests/known-red.json' });
    let x = ga('pw');
    ok('F5 guards-all: a broken baseline file -> the error line, the runner code 1, nothing reruns',
      x.status === 1 && /guardBaseline tests\/known-red\.json: not readable as JSON[^\n]*the runner's exit code 1 stands/.test(x.stdout) && count('one.count') === 0 && !/known red\b/.test(x.stdout.replace(/guardBaseline[^\n]*/g, '')),
      `${x.status} ${count('one.count')} ${x.stdout}${x.stderr}`);

    fs.writeFileSync(path.join(w, 'tests', 'known-red.json'), JSON.stringify({ 'tests/test_a.py::t1': 'BACKLOG #1' }));
    git(w, 'commit', '-q', '-am', 'baseline');
    fs.rmSync(path.join(T, 'one.count'), { force: true });
    x = ga('pw');
    ok('F2 guards-all: one known + one new red again alone -> the runner code 1, only the new one reruns, "1 known red"',
      x.status === 1 && count('one.count') === 1 && fs.readFileSync(path.join(T, 'one.count'), 'utf8').trim() === 'tests/test_n.py::new' && /\b1 known red\b/.test(x.stdout) && /new red, red again alone: tests\/test_n\.py::new/.test(x.stdout),
      `${x.status} ${x.stdout}${x.stderr}`);

    writeCfg({});
    fs.rmSync(path.join(T, 'one.count'), { force: true });
    x = ga('pw', '--force');
    ok('guards-all without guardBaseline: both reds rerun as before, no baseline line', x.status === 1 && count('one.count') === 2 && !/guardBaseline|known red/.test(x.stdout), `${x.status} ${count('one.count')} ${x.stdout}${x.stderr}`);
    const got = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'get', 'guardBaseline'], { encoding: 'utf8', env });
    ok('config get guardBaseline without the key -> an empty line (not "null")', got.status === 0 && got.stdout.trim() === '', JSON.stringify(got.stdout));
  }

  // --- role-chain: testerWritable not a list; the rerun rule ---
  const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', protectedBranches: ['main'], slots: { lockDir: '/slots' } };
  const TK = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', accept: 'acc', noAnalysis: 'one-line fix' };
  const run = async (cfgx) => {
    const calls = [], prompts = [];
    const agent = async (prompt, opts) => { calls.push(opts.label); prompts.push(prompt); return opts.label.startsWith('pre:') ? { ok: false, problems: ['stop here'], blockingQuestions: [] } : null; };
    const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
    const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: cfgx, tasks: [TK] });
    return { r: res[0], calls, prompts };
  };
  // the role chain gets the config resolved by config.js (skills/role-chain), which refuses a testerWritable that is
  // not a list before the workflow starts
  ok('E2 testerWritable as a string (not a list) -> config error "expected string[]"', /testerWritable: expected string\[\]/.test(errs({ testerWritable: '-run\\.js$' })), errs({ testerWritable: '-run\\.js$' }));
  let y = await run(Object.assign({}, CFG, { testerWritable: ['-run\\.js$'], guardBaseline: 'tests/known-red.json' }));
  ok('rerun rule: with guardBaseline the role prompt names the file and "known red"', y.calls[0] === 'pre:x' && /Known reds listed in tests\/known-red\.json \(config guardBaseline\)/.test(y.prompts[0]), y.prompts[0] && y.prompts[0].slice(0, 200));
  y = await run(Object.assign({}, CFG, { testerWritable: ['-run\\.js$'] }));
  ok('rerun rule: without guardBaseline the prompt says nothing about known reds', y.calls[0] === 'pre:x' && !/guardBaseline|Known reds/.test(y.prompts[0]));

  // --- role-diff-check CLI with --allow (as the role chain calls it) ---
  const rd = path.join(tmp, 'rd'); fs.mkdirSync(rd);
  git(rd, 'init', '-q'); fs.writeFileSync(path.join(rd, 'app.py'), 'x = 1\n'); git(rd, 'add', 'app.py'); git(rd, 'commit', '-q', '-m', 'b');
  const since = git(rd, 'rev-parse', 'HEAD').stdout.trim();
  fs.mkdirSync(path.join(rd, 'tests')); fs.writeFileSync(path.join(rd, 'tests', 'test_x.py'), 'def test_x(): pass\n');
  git(rd, 'add', 'tests/test_x.py'); git(rd, 'commit', '-q', '-m', 't');
  const cli = (...extra) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-diff-check.js'), '--wt', rd, '--since', since, '--role', 'tester', ...extra], { encoding: 'utf8' });
  let c = cli('--allow', '(^|/)tests/test_[^/]*\\.py$');
  let j = null; try { j = JSON.parse(c.stdout); } catch { /* */ }
  ok('E4 CLI --allow pytest list: tests/test_x.py -> ok, exit 0', c.status === 0 && j && j.ok === true, c.stdout + c.stderr);
  fs.writeFileSync(path.join(rd, 'app.py'), 'x = 2\n');
  c = cli('--allow', '(^|/)tests/test_[^/]*\\.py$');
  j = null; try { j = JSON.parse(c.stdout); } catch { /* */ }
  ok('E4 CLI --allow pytest list: a changed app.py -> offending, exit 1', c.status === 1 && j && JSON.stringify(j.offending) === '["app.py"]', c.stdout + c.stderr);

  // --- chain-cost ---
  const CC = path.join(ROOT, 'scripts', 'chain-cost.js');
  const cc = (...a) => spawnSync(process.execPath, [CC, ...a, '--median', '1e6'], { encoding: 'utf8', cwd: tmp, env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: path.join(tmp, 'none.json') }) });
  const noTrace = (x) => !/\n\s+at /.test(x.stderr + x.stdout);
  const onlyJsonl = path.join(tmp, 'only-jsonl'); fs.mkdirSync(onlyJsonl); fs.writeFileSync(path.join(onlyJsonl, 'a.jsonl'), '{}\n');
  let x = cc(onlyJsonl);
  ok('H3 transcripts without *.meta.json -> exit 66, one line', x.status === 66 && x.stderr.trim().split('\n').length === 1 && x.stderr.includes(`no agent transcripts (*.meta.json) in ${onlyJsonl}`) && x.stdout.trim() === '' && noTrace(x), `${x.status} ${x.stdout}${x.stderr}`);
  const nul = path.join(tmp, 'null-meta'); fs.mkdirSync(nul);
  fs.writeFileSync(path.join(nul, 'a.meta.json'), 'null'); fs.writeFileSync(path.join(nul, 'a.jsonl'), '');
  fs.writeFileSync(path.join(nul, 'b.meta.json'), JSON.stringify({ description: 'prog:t1#1' }));
  fs.writeFileSync(path.join(nul, 'b.jsonl'), JSON.stringify({ message: { id: 'm', role: 'assistant', usage: { input_tokens: 1000 }, content: [] } }));
  x = cc(nul);
  ok('H4 a .meta.json that is JSON null -> no stack trace, the rest counted, exit 0', x.status === 0 && /^t1: /m.test(x.stdout) && noTrace(x), `${x.status} ${x.stdout}${x.stderr}`);
  const broken = path.join(tmp, 'all-broken'); fs.mkdirSync(broken);
  for (const n of ['a', 'b']) { fs.writeFileSync(path.join(broken, `${n}.meta.json`), '{'); fs.writeFileSync(path.join(broken, `${n}.jsonl`), ''); }
  x = cc(broken);
  ok('H4 every .meta.json broken -> two notes, no stack trace, exit 0', x.status === 0 && (x.stdout.match(/^note: unreadable agent record/gm) || []).length === 2 && noTrace(x), `${x.status} ${x.stdout}${x.stderr}`);
}

main().catch((e) => { ok('no exception', false, e.stack); }).finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); done(); });
