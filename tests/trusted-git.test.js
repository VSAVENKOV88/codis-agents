#!/usr/bin/env node
'use strict';
// Trusted git (scripts/trusted-git.js; p-codex-A2b-2h-1, cells H1, H4-H10, H16, H31-H33): a trusted process of the
// plugin runs no hook and no fsmonitor of the repository it reads, wherever they are configured (fixtures F-h and F-g,
// tests/trusted-git-fixture.js).
//   H1  the module itself: reads, update-ref, worktree add, merge --ff-only, push into a local bare repository - the
//       hook log stays empty and the fsmonitor marker absent; the push works (no protocol.allow); the identity is the
//       user's global one (commit-tree of the train).
//   H8  wt-setup.sh; H9, H10, H16 (a) a green train with the arc checked out in a worktree (merge --ff-only there), on a
//       relative (husky-like) and an absolute core.hooksPath, the task branch changing a hook; the author of the
//       train's commit is the owner's global identity.
//   H4, H5, H6, H7, H31, H32, H33  the readers of a worktree on F-g: guards-select.js, role-diff-check.js,
//       guards-result.js meta-start/meta-end, wt-remove-check.js, guards-result.js needs (the enumerator of guardNeeds),
//       agents-md.js check, detect.js (which still reports the repository's own core.hooksPath).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');
const F = require('./trusted-git-fixture');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-git-')));
const node = (script, args, opts) => spawnSync(process.execPath, [path.join(S, script)].concat(args), Object.assign({ encoding: 'utf8' }, opts || {}));
const exists = (f) => fs.existsSync(f);

try {
  const TG = require('../scripts/trusted-git');

  // ---- H1: the module ----
  const cli = node('trusted-git.js', ['flags']);
  ok('H1 flags: one flag per line - -c core.hooksPath=/dev/null -c core.fsmonitor=false --no-optional-locks', cli.status === 0
    && cli.stdout === TG.FLAGS.join('\n') + '\n' && JSON.stringify(TG.FLAGS) === JSON.stringify(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-optional-locks']), cli.stdout + cli.stderr);
  ok('H1 flags: any other argument is usage (64)', node('trusted-git.js', []).status === 64 && node('trusted-git.js', ['flags', 'x']).status === 64);

  for (const kind of ['relative', 'absolute']) {
    const d = path.join(T, `h1-${kind}`), log = path.join(T, `h1-${kind}.log`), mark = path.join(T, `h1-${kind}.FSMON`);
    const repo = path.join(d, 'repo');
    F.makeFh(repo, log, kind, path.join(d, 'hooks'));
    F.setFsmonitor(repo, mark);
    // the fixture works: git as a user calls it runs the hooks and the fsmonitor
    F.plain(repo, 'status', '--porcelain'); F.plain(repo, 'update-ref', 'refs/x/ctl', 'HEAD');
    ok(`H1 ${kind}: the fixture runs hooks and fsmonitor for a plain git (control)`, F.hookLines(log).some((l) => l.startsWith('reference-transaction')) && exists(mark), F.read(log));
    F.clear(log, mark);
    const tg = (...a) => TG.run(['-C', repo, ...a], { encoding: 'utf8' });
    const st = tg('status', '--porcelain');
    const lf = tg('ls-files', '-z', '--cached', '--others', '--exclude-standard');
    const df = tg('diff', '--name-only', 'HEAD');
    const ur = tg('update-ref', 'refs/x/y', 'HEAD');
    const wt = path.join(d, 'wt');
    const wa = tg('worktree', 'add', '-q', '-b', 'side', wt, 'HEAD');
    // a commit on side (the test's own, quiet), then main fast-forwards to it in the main worktree
    F.put(path.join(wt, 'b.txt'), 'b\n'); F.quiet(wt, 'add', 'b.txt'); F.quiet(wt, 'commit', '-q', '-m', 'side');
    F.clear(log, mark);
    const mg = tg('merge', '--ff-only', '-q', 'side');
    const bare = path.join(d, 'bare.git');
    F.quiet(d, 'init', '-q', '--bare', bare);
    const pu = tg('push', '-q', '--no-follow-tags', '--', bare, 'HEAD:refs/runs/x/1');
    const all = [st, lf, df, ur, wa, mg, pu];
    ok(`H1 ${kind}: status, ls-files, diff HEAD, update-ref, worktree add, merge --ff-only, push - all exit 0`, all.every((r) => r.status === 0), all.map((r) => `${r.status} ${r.stderr}`).join(' | '));
    ok(`H1 ${kind}: no hook ran (post-index-change, reference-transaction, post-checkout, post-merge, pre-push)`, F.hookLines(log).length === 0, F.read(log));
    ok(`H1 ${kind}: the fsmonitor command never ran`, !exists(mark));
    ok(`H1 ${kind}: the merge and the push took effect`, exists(path.join(repo, 'b.txt'))
      && F.quiet(bare, 'rev-parse', 'refs/runs/x/1').stdout.trim() === F.quiet(repo, 'rev-parse', 'HEAD').stdout.trim());
    // F-g through config.worktree of a linked worktree (extensions.worktreeConfig)
    F.unsetFsmonitor(repo); F.setFsmonitor(wt, mark, true); F.clear(mark);
    F.plain(wt, 'status', '--porcelain');
    const ctl = exists(mark); F.clear(mark);
    const ws = TG.run(['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' });
    ok(`H1 ${kind}: core.fsmonitor in config.worktree - a plain status runs it, the module's does not`, ctl && ws.status === 0 && !exists(mark));
  }
  // the identity of a commit-tree is the user's global one: the module does not touch GIT_CONFIG_GLOBAL
  const home = path.join(T, 'home');
  F.put(path.join(home, '.gitconfig'), '[user]\n\tname = H1 Owner\n\temail = owner@example.com\n');
  const idRepo = path.join(T, 'id');
  fs.mkdirSync(idRepo); F.quiet(idRepo, 'init', '-q');
  const idEnv = Object.assign({}, process.env, { HOME: home });
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL']) delete idEnv[k];
  const vi = TG.run(['-C', idRepo, 'var', 'GIT_COMMITTER_IDENT'], { encoding: 'utf8', env: idEnv });
  ok('H1 the identity: git var GIT_COMMITTER_IDENT through the module = the global config of HOME', vi.status === 0 && vi.stdout.startsWith('H1 Owner <owner@example.com>'), vi.stdout + vi.stderr);
  ok('H1 run takes the binary from opts.git', TG.run(['--version'], { encoding: 'utf8', git: spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() }).status === 0);

  // ---- the readers of a worktree on F-g (H4, H5, H6, H7, H31, H32, H33) ----
  {
    const fg = path.join(T, 'fg'), wts = path.join(T, 'fg-wts'), w = path.join(wts, 'w'), mark = path.join(T, 'fg.FSMON'), absHooks = path.join(T, 'fg-hooks');
    const log = path.join(T, 'fg.log');
    F.makeFh(fg, log, 'absolute', absHooks);
    F.put(path.join(fg, 'guards', 'a.g'), '# guards:needs browser — fixture\n');
    F.quiet(fg, 'add', 'guards'); F.quiet(fg, 'commit', '-q', '-m', 'guards');
    const base = F.quiet(fg, 'rev-parse', 'HEAD').stdout.trim();
    F.quiet(fg, 'worktree', 'add', '-q', '-b', 'task', w, 'main');
    F.put(path.join(w, 'guards', 'b.g'), '# guards:needs docker — fixture\n'); F.quiet(w, 'add', 'guards/b.g'); F.quiet(w, 'commit', '-q', '-m', 'task');
    const cfg = path.join(T, 'fg-cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ repoDir: fg, worktreeRoot: wts, sharedDir: path.join(T, 'fg-shared'), guardCommand: 'cd {wt} && true', guardFiles: ['guards/*.g'] }));
    F.setFsmonitor(fg, mark);
    F.plain(w, 'status', '--porcelain');
    ok('F-g: a plain git status in the task worktree runs the fsmonitor (control)', exists(mark));
    const none = (label, fn) => { F.clear(mark, log); const r = fn(); ok(`${label}: no fsmonitor, no hook`, !exists(mark) && F.hookLines(log).length === 0, `marker ${exists(mark)} log ${F.read(log)} ${r || ''}`); };

    none('H4 guards-select.js --wt <task> --base main', () => {
      const r = node('guards-select.js', ['--wt', w, '--base', 'main', '--config', cfg, '--json']);
      ok('H4 guards-select.js answers (exit 0 or 3)', r.status === 0 || r.status === 3, r.stdout + r.stderr);
      return r.stderr;
    });
    none('H5 role-diff-check.js (reviewer since the base)', () => {
      const r = require('../scripts/role-diff-check').check({ wt: w, since: base, role: 'reviewer' });
      ok('H5 role-diff-check: the commit of the task is seen (guards/b.g changed)', r && Array.isArray(r.offending) && r.offending.includes('guards/b.g'), JSON.stringify(r));
      return JSON.stringify(r);
    });
    const glog = path.join(T, 'fg-guards.txt');
    none('H6 guards-result.js meta-start and meta-end (gitState)', () => {
      const a = node('guards-result.js', ['meta-start', w, glog, 'CMD']);
      const b = node('guards-result.js', ['meta-end', w, glog, '0']);
      const m = JSON.parse(F.read(`${glog}.meta.json`) || '{}');
      ok('H6 the meta names HEAD and a clean tree', a.status === 0 && b.status === 0 && m.head === F.quiet(w, 'rev-parse', 'HEAD').stdout.trim() && m.cleanStart === true && m.cleanEnd === true, JSON.stringify(m) + a.stderr + b.stderr);
      return a.stderr + b.stderr;
    });
    none('H7 wt-remove-check.js <task worktree>', () => {
      const r = node('wt-remove-check.js', [w]);
      ok('H7 wt-remove-check.js answers (exit 0, the repository named)', r.status === 0 && r.stdout.includes('1. repository'), r.stdout + r.stderr);
      return r.stderr;
    });
    none('H31 guards-result.js needs (the enumerator of guardNeeds, a full run under CODIS_GUARDS_EXEC)', () => {
      const out = path.join(T, 'fg-needs.json');
      const r = node('guards-result.js', ['needs', w, JSON.stringify({ glob: ['guards/*.g'], marker: ['#'] }), out], { env: Object.assign({}, process.env, { CODIS_GUARDS_EXEC: 'fixture' }) });
      const l = JSON.parse(F.read(out) || '[]').map((x) => x.guard);
      ok('H31 the enumerator lists the marked guards of the worktree', r.status === 0 && JSON.stringify(l) === JSON.stringify(['guards/a.g', 'guards/b.g']), r.stdout + r.stderr + JSON.stringify(l));
      return r.stderr;
    });
    none('H31 guards-result.js needs on a selection with a base (merge-base, ls-tree, show)', () => {
      const out = path.join(T, 'fg-needs2.json'), names = path.join(T, 'fg-names.json');
      fs.writeFileSync(names, JSON.stringify(['guards/a.g', 'guards/b.g']));
      const r = node('guards-result.js', ['needs', w, JSON.stringify({ glob: ['guards/*.g'], marker: ['#'] }), out, names, 'main']);
      const l = JSON.parse(F.read(out) || '[]');
      ok('H31 the marker new in this diff is named (b.g), the old one is not (a.g)', r.status === 3 && l.length === 2 && !l[0].newMarker && l[1].newMarker === true, r.stdout + r.stderr + JSON.stringify(l));
      return r.stderr;
    });
    none('H32 agents-md.js check --root <task worktree>', () => {
      const r = node('agents-md.js', ['check', '--root', w], { env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: '', CLAUDE_PROJECT_DIR: '' }) });
      ok('H32 agents-md.js check answers (not used: exit 0)', r.status === 0, r.stdout + r.stderr);
      return r.stderr;
    });
    none('H33 detect.js --root <task worktree>', () => {
      const r = node('detect.js', ['--root', w]);
      let j = null;
      try { j = JSON.parse(r.stdout); } catch { /* below */ }
      ok('H33 detect.js answers with the repository\'s own core.hooksPath (not the /dev/null of the trusted git)', r.status === 0 && j && j.repo.git.hooksPath === absHooks && j.repo.git.isRepo === true, r.stdout.slice(0, 500) + r.stderr);
      ok('H33 detect.js reads the ignored and the listed files', j && Array.isArray(j.repo.ignored), r.stderr);
      return r.stderr;
    });
  }

  // ---- H8, H9, H10, H16 (a): wt-setup.sh, a selection and a green train onto an arc checked out in a worktree ----
  if (!has('zsh') || !has('perl')) skip('H8-H10, H16: wt-setup.sh, guards-all.sh and the train', 'zsh or perl not found');
  else {
    for (const kind of ['relative', 'absolute']) {
      const d = path.join(T, `tr-${kind}`), main = path.join(d, 'main'), wts = path.join(d, 'wts'), shared = path.join(d, 'shared'), bin = path.join(d, 'bin');
      const log = path.join(d, 'hooks.log'), mark = path.join(d, 'FSMON');
      for (const x of [wts, shared, bin]) fs.mkdirSync(x, { recursive: true });
      // the memory probes of the slots: a calm machine
      const fake = (t, body) => F.put(path.join(bin, t), body, 0o755);
      fake('sysctl', '#!/bin/zsh\n[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"\n');
      fake('memory_pressure', '#!/bin/zsh\nprint -r -- "System-wide memory free percentage: 20%"\n');
      fake('vm_stat', '#!/bin/zsh\nprint -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."\n');
      fake('df', '#!/bin/zsh\nprint -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"\n');
      F.put(path.join(d, 'guard.sh'), '#!/bin/sh\necho "=== 3 passed in 0.1s ==="\nexit 0\n', 0o755);
      F.makeFh(main, log, kind, path.join(d, 'abs-hooks'));
      F.put(path.join(main, '.gitignore'), 'data/\n'); F.put(path.join(main, 'data', 'corpus.txt'), 'corpus\n');
      F.quiet(main, 'add', '.gitignore'); F.quiet(main, 'commit', '-q', '-m', 'ignore');
      F.quiet(main, 'branch', 'arc');
      const arcWt = path.join(d, 'arc-wt');
      F.quiet(main, 'worktree', 'add', '-q', arcWt, 'arc');
      F.setFsmonitor(main, mark);
      const cfgFile = path.join(d, 'cfg.json');
      fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, protectedBranches: ['main'],
        guardCommand: `cd {wt} && ${path.join(d, 'guard.sh')}`, guardSubsetCommand: `cd {wt} && ${path.join(d, 'guard.sh')} {onlyArgs}`,
        guardRerun: { command: `cd {wt} && ${path.join(d, 'guard.sh')} {name}`, newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== (\\d+) passed in [0-9.]+s ===$' },
        worktreeSetup: { scan: ['data'], skip: [], link: [] }, slots: { lockDir: path.join(d, 'slots'), legacyLock: path.join(d, 'guards.lock') } }));
      const home = path.join(d, 'home');
      F.put(path.join(home, '.gitconfig'), '[user]\n\tname = H10 Owner\n\temail = owner@example.com\n');
      const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, HOME: home, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin',
        SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2', CODIS_TRAIN_POLL: '0.3' });
      // every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list)
      for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
        'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'CODIS_WORKTREE_ROOT', 'CODIS_SHARED_DIR', 'CODIS_REPO_DIR', 'CLAUDE_PROJECT_DIR', 'CODIS_GUARDS_EXEC',
        'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL']) delete env[k];

      // H8: wt-setup.sh of the task
      F.clear(log, mark);
      const ws = spawnSync('zsh', [path.join(S, 'wt-setup.sh'), 't1', 'b-t1', 'arc'], { encoding: 'utf8', env, cwd: d });
      const tw = path.join(wts, 't1');
      ok(`H8 ${kind}: wt-setup.sh made the worktree and cloned the ignored data`, ws.status === 0 && F.read(path.join(tw, 'data', 'corpus.txt')) === 'corpus\n', ws.stdout + ws.stderr);
      ok(`H8 ${kind}: wt-setup.sh ran no hook (reference-transaction, post-checkout, post-index-change) and no fsmonitor`, F.hookLines(log).length === 0 && !exists(mark), F.read(log) + ` marker ${exists(mark)}`);

      // the task branch changes a hook (the branch's code is not run by the trusted processes)
      const hookFile = kind === 'relative' ? path.join(tw, '.husky', '_', 'post-merge') : path.join(tw, 'hooks-note.txt');
      F.put(hookFile, `#!/bin/sh\necho "post-merge of the branch $PWD" >> '${log}'\n`, 0o755);
      F.quiet(tw, 'add', path.relative(tw, hookFile)); F.quiet(tw, 'commit', '-q', '-m', 'the task changes a hook');
      const head = F.quiet(tw, 'rev-parse', 'HEAD').stdout.trim();

      // the selection of the task (guards-select.js, guards-all.sh)
      F.clear(log, mark);
      const sel = spawnSync('zsh', [path.join(S, 'guards-all.sh'), '--select', 'arc', tw], { encoding: 'utf8', env, cwd: d, timeout: 120000 });
      ok(`H16 ${kind}: guards-all.sh --select arc - exit 0, no hook, no fsmonitor`, sel.status === 0 && F.hookLines(log).length === 0 && !exists(mark), `${sel.status} ${sel.stdout}${sel.stderr} ${F.read(log)} marker ${exists(mark)}`);

      // H9, H10: the train - green, the arc checked out in arcWt moves by merge --ff-only there
      const taskDir = path.join(d, 'task'); fs.mkdirSync(taskDir);
      const arc0 = F.quiet(main, 'rev-parse', 'arc').stdout.trim();
      const tr = (...a) => spawnSync(process.execPath, [path.join(S, 'train.js'), ...a], { cwd: d, encoding: 'utf8', env, timeout: 180000 });
      const en = tr('enqueue', '--task', 't1', '--branch', 'b-t1', '--head', head, '--base', 'arc', '--dir', taskDir);
      F.clear(log, mark);
      const run = tr('run');
      let o = null;
      try { o = JSON.parse(run.stdout.trim().split('\n').pop()); } catch { /* below */ }
      const res = (() => { try { return JSON.parse(fs.readFileSync(path.join(shared, 'train', 'result', `t1-${head}.json`), 'utf8')); } catch { return null; } })();
      ok(`H9 ${kind}: the train is green and the arc moved by merge --ff-only in its worktree`, en.status === 0 && res && res.verdict === 'green' && o && F.quiet(main, 'rev-parse', 'arc').stdout.trim() === o.sha
        && F.quiet(arcWt, 'rev-parse', 'HEAD').stdout.trim() === o.sha && o.sha !== arc0 && exists(hookFile.replace(tw, arcWt)), `${en.stderr} ${run.stdout}${run.stderr} ${JSON.stringify(res)}`);
      ok(`H9, H16 ${kind}: no hook of the repository or of the branch ran (post-merge, post-checkout, reference-transaction, post-index-change), no fsmonitor`,
        F.hookLines(log).length === 0 && !exists(mark), F.read(log) + ` marker ${exists(mark)}`);
      ok(`H10 ${kind}: the author of the train's merge commit is the owner's global identity`, o && F.quiet(main, 'log', '-1', '--format=%an', o.sha).stdout.trim() === 'H10 Owner',
        o && F.quiet(main, 'log', '-1', '--format=%an <%ae>', o.sha).stdout);
    }
  }
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
}
done();
