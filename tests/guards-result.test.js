#!/usr/bin/env node
'use strict';
// scripts/guards-result.js: what guards-all.sh does after a full run and before the next one.
// - Rerun of new reds one by one (config guardRerun): the names come from the log by newRedPattern (group 1), only when
//   the log reached its tally (tallyPattern); each runs alone through guardRerun.command ({wt}, {name}, quoted). Red
//   again -> "new red", the runner's exit code stays; green alone -> "flaky", not a regression; only flaky -> exit 0.
//   No tally, no names, more names than maxReruns, or a green run -> nothing reruns and the runner's code stands.
// - Reuse: a full run is not repeated on the same HEAD with a clean tracked tree when its final exit code was 0 and the
//   guard command is the same; HEAD, cleanliness and the code are kept next to the log (<log>.meta.json).
// - guards-all.sh end to end (zsh): rerun in the slot, exit codes, the summary, reuse and --force.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const G = require('../scripts/guards-result');
const C = require('../scripts/config');
const zsh = has('zsh');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-result-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

// A log shaped like a project runner: progress lines, a section of new reds with their tails, a tally.
const LOG = [
  'Guards to run: 5',
  '  1/5 X a-run.js      1.0s',
  '  2/5 T b-run.js      300.0s',
  '',
  '---- NEW RED ----',
  '',
  'X srv/a-run.js  (1.0s, code 1)',
  '   | X expected 3 got 4',
  '',
  'T srv/b-run.js  (300.0s, code null)',
  '   | X timed out',
  '',
  "X srv/it's-run.js  (2.0s, code 1)",
  '',
  'TOTAL: 2 green, 3 NEW red, 1 known red',
].join('\n') + '\n';
const RERUN = { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^[XT] (\\S+(?: \\S+)*?)  \\(', tallyPattern: '^TOTAL: ' };

try {
  // --- config: guardRerun ---
  const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
  const errs = (gr) => C.resolve(Object.assign({}, base, { guardRerun: gr })).errors.join('; ');
  ok('config: a valid guardRerun resolves, maxReruns defaults to 10', (() => { const r = C.resolve(Object.assign({}, base, { guardRerun: RERUN }));
    return !r.errors.length && r.config.guardRerun.maxReruns === 10 && r.config.guardRerun.command === RERUN.command; })(), errs(RERUN));
  ok('config: no guardRerun -> null (no reruns)', C.resolve(base).config.guardRerun === null);
  ok('config: guardRerun.command needs {wt} and {name}', /guardRerun\.command: must contain \{name\}/.test(errs({ command: 'cd {wt} && x', newRedPattern: '^(x)' }))
    && /guardRerun\.command: must contain \{wt\}/.test(errs({ command: 'x {name}', newRedPattern: '^(x)' })), errs({ command: 'x', newRedPattern: '^(x)' }));
  ok('config: newRedPattern is required, a valid regexp with a capture group', /newRedPattern: required/.test(errs({ command: '{wt} {name}' }))
    && /newRedPattern: bad regular expression/.test(errs({ command: '{wt} {name}', newRedPattern: '(' }))
    && /newRedPattern: needs a capture group/.test(errs({ command: '{wt} {name}', newRedPattern: '^x' })), errs({ command: '{wt} {name}', newRedPattern: '^x' }));
  ok('config: tallyPattern must be a valid regexp, unknown keys refused', /tallyPattern: bad regular expression/.test(errs(Object.assign({}, RERUN, { tallyPattern: '[' })))
    && /guardRerun\.retries: unknown key/.test(errs(Object.assign({}, RERUN, { retries: 2 }))));
  ok('config: maxReruns must be a positive integer', /maxReruns: expected a positive integer/.test(errs(Object.assign({}, RERUN, { maxReruns: 0 }))));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents.schema.json'), 'utf8'));
  ok('schema: guardRerun keys = config.js', schema.properties.guardRerun && JSON.stringify(Object.keys(schema.properties.guardRerun.properties).sort()) === JSON.stringify(Object.keys(C.RERUN_SPEC || {}).sort()));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('README: the config table explains guardRerun', /\| `guardRerun` \|[^\n]*\{name\}[^\n]*newRedPattern[^\n]*flaky/.test(readme));
  ok('README: guards-all.sh reuse and --force', /guards-all\.sh[^\n]*--force/.test(readme) && /reused, HEAD/.test(readme));

  // --- names of new reds from the log ---
  const cfg = C.resolve(Object.assign({}, base, { guardRerun: RERUN })).config.guardRerun;
  let p = G.newReds(LOG, cfg);
  ok('newReds: names by group 1, in order, the tail lines and progress lines ignored', JSON.stringify(p.names) === JSON.stringify(['srv/a-run.js', 'srv/b-run.js', "srv/it's-run.js"]) && p.tally, JSON.stringify(p));
  p = G.newReds(LOG + 'X srv/a-run.js  (1.0s, code 1)\n', cfg);
  ok('newReds: a name twice counts once', p.names.length === 3, JSON.stringify(p));
  p = G.newReds(LOG.replace(/TOTAL: [^\n]*\n/, ''), cfg);
  ok('newReds: no tally line -> tally false', p.tally === false, JSON.stringify(p));
  ok('newReds: without tallyPattern the tally is not required', G.newReds('X a  (\n', Object.assign({}, cfg, { tallyPattern: '' })).tally === true);
  ok('subst: {wt} and {name} are shell-quoted', G.subst('cd {wt} && run {name}', "/a b", "x'y") === "cd '/a b' && run 'x'\\''y'", G.subst('cd {wt} && run {name}', '/a b', "x'y"));

  // --- rerun ---
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  // one.sh <name>: exits 1 when the name is listed in red.txt (red again alone), else 0; logs every call.
  fs.writeFileSync(path.join(wt, 'one.sh'), `#!/bin/sh\necho "$1" >> "${tmp}/calls.txt"\necho "single run of $1"\ngrep -qxF -- "$1" "${tmp}/red.txt" && exit 1\nexit 0\n`);
  fs.chmodSync(path.join(wt, 'one.sh'), 0o755);
  const logf = path.join(tmp, 'guards-wt.txt');
  const calls = () => { try { return fs.readFileSync(path.join(tmp, 'calls.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const reset = (red) => { fs.writeFileSync(logf, LOG); fs.rmSync(path.join(tmp, 'calls.txt'), { force: true }); fs.writeFileSync(path.join(tmp, 'red.txt'), red.map((x) => x + '\n').join('')); };
  if (!zsh) {
    for (const n of ['rerun: one repeats, two flaky', 'rerun: all flaky', 'rerun: no tally', 'rerun: too many', 'rerun: green run', 'rerun cli']) skip(n, 'zsh not found');
  } else {
    reset(['srv/a-run.js']);
    let r = G.rerun({ wt, log: logf, rc: 1, cfg });
    ok('rerun: each new red runs alone, once, in order (quoted name with a quote too)', JSON.stringify(calls()) === JSON.stringify(['srv/a-run.js', 'srv/b-run.js', "srv/it's-run.js"]), calls().join(','));
    ok('rerun: red again -> repeated; green alone -> flaky', JSON.stringify(r.repeated.map((x) => x.name)) === '["srv/a-run.js"]'
      && JSON.stringify(r.flaky) === JSON.stringify(['srv/b-run.js', "srv/it's-run.js"]), JSON.stringify(r));
    ok('rerun: a repeated new red keeps the runner exit code', r.rc === 1, String(r.rc));
    ok('rerun: the summary names both kinds and the backlog', /new red, red again alone: srv\/a-run\.js/.test(r.text) && /flaky, red under load, green alone: srv\/b-run\.js/.test(r.text)
      && /3 new reds -> 1 repeated, 2 flaky/.test(r.text) && /flaky guards[^\n]*project backlog[^\n]*srv\/b-run\.js, srv\/it's-run\.js/.test(r.text), r.text);
    ok('rerun: the summary is appended to the log, single runs go to <log>.rerun.txt', fs.readFileSync(logf, 'utf8').endsWith(r.text.trimEnd() + '\n')
      && /single run of srv\/b-run\.js/.test(fs.readFileSync(logf.replace(/\.txt$/, '.rerun.txt'), 'utf8')), fs.readFileSync(logf, 'utf8').slice(-400));
    reset([]);
    r = G.rerun({ wt, log: logf, rc: 1, cfg });
    ok('rerun: all flaky -> exit 0, nothing repeated', r.rc === 0 && !r.repeated.length && r.flaky.length === 3, JSON.stringify(r));
    reset([]);
    fs.writeFileSync(logf, LOG.replace(/TOTAL: [^\n]*\n/, ''));
    r = G.rerun({ wt, log: logf, rc: 1, cfg });
    ok('rerun: the log has no tally (cut off) -> no reruns, the runner code stands', r.rc === 1 && !calls().length && /no tally/.test(r.text), JSON.stringify(r));
    reset([]);
    r = G.rerun({ wt, log: logf, rc: 1, cfg: Object.assign({}, cfg, { maxReruns: 2 }) });
    ok('rerun: more new reds than maxReruns -> no reruns, the runner code stands', r.rc === 1 && !calls().length && /more than maxReruns 2/.test(r.text), JSON.stringify(r));
    reset([]);
    r = G.rerun({ wt, log: logf, rc: 0, cfg });
    ok('rerun: a green run -> nothing reruns, exit 0, no text', r.rc === 0 && !calls().length && r.text === '', JSON.stringify(r));
    reset([]);
    fs.writeFileSync(logf, 'crashed\nTOTAL: x\n');
    r = G.rerun({ wt, log: logf, rc: 2, cfg });
    ok('rerun: no names found -> the runner code stands', r.rc === 2 && !calls().length && /no new reds found/.test(r.text), JSON.stringify(r));
    reset(['srv/a-run.js']);
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'rerun', wt, logf, '1', JSON.stringify(cfg)], { encoding: 'utf8' });
    ok('rerun cli: prints the summary, exits with the final code', cli.status === 1 && /1 repeated, 2 flaky/.test(cli.stdout), cli.status + cli.stdout + cli.stderr);
  }

  // --- reuse on the same HEAD ---
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'one');
  const rlog = path.join(tmp, 'guards-repo.txt');
  fs.writeFileSync(rlog, 'TOTAL: 5 green\n');
  const CMD = 'cd {wt} && run {jobs}';
  const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  let u = G.reusable(repo, rlog, CMD);
  ok('reuse: no meta -> full run', !u.reuse && /no record/.test(u.reason), JSON.stringify(u));
  G.metaStart(repo, rlog, CMD);
  u = G.reusable(repo, rlog, CMD);
  ok('reuse: a run without its end (interrupted) -> full run', !u.reuse && /did not finish/.test(u.reason), JSON.stringify(u));
  G.metaEnd(repo, rlog, 0);
  const meta = JSON.parse(fs.readFileSync(rlog + '.meta.json', 'utf8'));
  ok('meta next to the log: HEAD, clean tree at start and end, the command, exit code', meta.head === head && meta.cleanStart === true && meta.cleanEnd === true && meta.headEnd === head && meta.command === CMD && meta.rc === 0, JSON.stringify(meta));
  u = G.reusable(repo, rlog, CMD);
  ok('reuse: same HEAD, clean, exit 0, same command -> reused', u.reuse && u.head === head && /reused, HEAD [0-9a-f]{7,}/.test(u.text), JSON.stringify(u));
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  ok('reuse: an untracked file does not count', G.reusable(repo, rlog, CMD).reuse);
  ok('reuse: another guard command -> full run', !G.reusable(repo, rlog, CMD + ' --x').reuse);
  fs.writeFileSync(path.join(repo, 'a.txt'), '2\n');
  u = G.reusable(repo, rlog, CMD);
  ok('reuse: a changed tracked file -> full run', !u.reuse && /tracked/.test(u.reason), JSON.stringify(u));
  git(repo, 'checkout', '-q', 'a.txt');
  G.metaStart(repo, rlog, CMD); G.metaEnd(repo, rlog, 1);
  u = G.reusable(repo, rlog, CMD);
  ok('reuse: the last run ended red (repeated new reds) -> full run', !u.reuse && /exit 1/.test(u.reason), JSON.stringify(u));
  G.metaStart(repo, rlog, CMD); G.metaEnd(repo, rlog, 0);
  fs.writeFileSync(path.join(repo, 'a.txt'), '3\n'); git(repo, 'commit', '-q', '-am', 'two');
  u = G.reusable(repo, rlog, CMD);
  ok('reuse: HEAD moved -> full run', !u.reuse && /HEAD/.test(u.reason), JSON.stringify(u));
  fs.writeFileSync(path.join(repo, 'a.txt'), '4\n');
  G.metaStart(repo, rlog, CMD); git(repo, 'checkout', '-q', 'a.txt'); G.metaEnd(repo, rlog, 0);
  ok('reuse: the tree was dirty when the run started -> never reused', !G.reusable(repo, rlog, CMD).reuse);
  G.metaStart(repo, rlog, CMD); fs.writeFileSync(path.join(repo, 'a.txt'), '5\n'); G.metaEnd(repo, rlog, 0); git(repo, 'checkout', '-q', 'a.txt');
  ok('reuse: the run changed a tracked file -> never reused', !G.reusable(repo, rlog, CMD).reuse);
  const nogit = path.join(tmp, 'nogit'); fs.mkdirSync(nogit);
  G.metaStart(nogit, rlog, CMD); G.metaEnd(nogit, rlog, 0);
  ok('reuse: not a git worktree -> full run', !G.reusable(nogit, rlog, CMD).reuse);
  G.metaStart(repo, rlog, CMD); G.metaEnd(repo, rlog, 0);
  fs.rmSync(rlog);
  ok('reuse: the log itself is gone -> full run', !G.reusable(repo, rlog, CMD).reuse);

  // --- guards-all.sh end to end ---
  if (!zsh) {
    skip('guards-all.sh end to end', 'zsh not found');
  } else {
    const T = path.join(tmp, 'e2e');
    const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), w = path.join(wts, 'xw');
    // xw is a linked worktree of $T/main: guards-all.sh refuses a main working copy (scripts/main-checkout.js).
    const main = path.join(T, 'main');
    for (const d of [bin, shared, wts, main]) fs.mkdirSync(d, { recursive: true });
    // Fake machine for the slot scripts (no extra heavy slot, plenty of swap).
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    // Fake runner: counts its full runs, prints the log of $T/full.log and exits with $T/full.rc.
    fs.writeFileSync(path.join(main, 'full.sh'), `#!/bin/sh\necho run >> "${T}/full.count"\ncat "${T}/full.log"\nexit $(cat "${T}/full.rc")\n`);
    fs.writeFileSync(path.join(main, 'one.sh'), `#!/bin/sh\necho "$1" >> "${T}/one.count"\ngrep -qxF -- "$1" "${T}/red.txt" && exit 1\nexit 0\n`);
    for (const f of ['full.sh', 'one.sh']) fs.chmodSync(path.join(main, f), 0o755);
    git(main, 'init', '-q'); git(main, 'add', 'full.sh', 'one.sh'); git(main, 'commit', '-q', '-m', 'w'); git(main, 'worktree', 'add', '-q', '--detach', w);
    const cfgFile = (extra) => { const f = path.join(T, 'cfg.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ repoDir: path.join(T, 'main'), worktreeRoot: wts, sharedDir: shared,
      guardCommand: 'cd {wt} && ./full.sh {jobs}', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }, extra))); return f; };
    const env = (f) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: f, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    // run inside an outer slot, the outer slots.zsh has exported its own lock, journal and counts
    for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete process.env[k];   // and thresholds set outside (SLOT_SWAP_MIN_MB=0 on Linux)
    const count = (f) => { try { return fs.readFileSync(path.join(T, f), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const ga = (f, ...a) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), ...a], { encoding: 'utf8', env: env(f), timeout: 120000 });
    const set = (rc, red) => { fs.writeFileSync(path.join(T, 'full.log'), LOG); fs.writeFileSync(path.join(T, 'full.rc'), String(rc)); fs.writeFileSync(path.join(T, 'red.txt'), red.map((x) => x + '\n').join(''));
      for (const c of ['full.count', 'one.count']) fs.rmSync(path.join(T, c), { force: true }); };
    const withRerun = cfgFile({ guardRerun: Object.assign({}, RERUN, { command: 'cd {wt} && ./one.sh {name}' }) });

    set(1, ['srv/a-run.js']);
    let x = ga(withRerun, '--force', 'xw');
    ok('guards-all: a repeated new red -> exit 1, both lists in the output', x.status === 1 && /1 repeated, 2 flaky/.test(x.stdout) && /project backlog/.test(x.stdout), `${x.status} ${x.stdout}${x.stderr}`);
    ok('guards-all: the reruns ran one by one after the full run', count('full.count') === 1 && count('one.count') === 3, `${count('full.count')} ${count('one.count')}`);
    ok('guards-all: the log keeps the runner output and the rerun summary', /TOTAL: 2 green/.test(fs.readFileSync(path.join(shared, 'guards-xw.txt'), 'utf8')) && /1 repeated, 2 flaky/.test(fs.readFileSync(path.join(shared, 'guards-xw.txt'), 'utf8')));
    x = ga(withRerun, 'xw');
    ok('guards-all: after a red end no reuse - the full run repeats', count('full.count') === 2 && !/reused, HEAD/.test(x.stdout), x.stdout);
    set(1, []);
    x = ga(withRerun, 'xw');
    ok('guards-all: only flaky -> exit 0', x.status === 0 && /0 repeated, 3 flaky/.test(x.stdout), `${x.status} ${x.stdout}${x.stderr}`);
    const h = git(w, 'rev-parse', '--short', 'HEAD').stdout.trim();
    x = ga(withRerun, 'xw');
    ok('guards-all: same HEAD, clean tree, exit 0 -> "reused, HEAD <sha>", no run, exit 0, the saved summary shown',
      x.status === 0 && x.stdout.includes(`reused, HEAD ${h}`) && count('full.count') === 1 && /0 repeated, 3 flaky/.test(x.stdout), `${x.status} ${count('full.count')} ${x.stdout}`);
    x = ga(withRerun, 'xw', '--force');
    ok('guards-all: --force (after the worktree too) runs again', count('full.count') === 2 && !/reused, HEAD/.test(x.stdout), x.stdout);
    fs.writeFileSync(path.join(w, 'one.sh'), fs.readFileSync(path.join(w, 'one.sh'), 'utf8') + '# edit\n');
    x = ga(withRerun, 'xw');
    ok('guards-all: a tracked change -> full run', count('full.count') === 3, x.stdout);
    git(w, 'checkout', '-q', 'one.sh');
    const plain = cfgFile({});
    set(3, []);
    x = ga(plain, '--force', 'xw');
    ok('guards-all: without guardRerun the runner code stands and nothing reruns', x.status === 3 && !/Error/.test(x.stdout + x.stderr) && count('one.count') === 0 && !/repeated/.test(x.stdout), `${x.status} ${x.stdout}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
