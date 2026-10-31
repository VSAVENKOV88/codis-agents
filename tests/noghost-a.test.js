#!/usr/bin/env node
'use strict';
// Every place that fills a guard command knows its own placeholders (p-noghost part a, cells A1-A15, C1-C3 of the
// p-noghost matrix). The case of 2026-10-30: guardSubsetCommand got {jobs} and {limitFile}, the part here
// (remoteRun.localPattern, localCommand by default guardSubsetCommand) fills only {wt} and {onlyArgs}, the project's
// runner got "--concurrency {jobs}" literally, ran 0 of 10 guards and exited 0 - two green trains without that part.
// A token is {identifier} not right after $ (zsh ${VAR} is a parameter; {a,b} and {1..3} are brace expansions). The
// template is checked, never the filled string (a worktree path or a guard name may hold braces):
//   config.js (load, so check, slots.zsh and every script): a placeholder the place does not fill -> an error naming
//     the key (and its default) and the placeholder; an unknown token -> "unknown placeholder";
//   guards-remote.js run() with a config object: the part here refuses 78 before the runner is contacted;
//   guards-select.js --command fills only {wt} and {onlyArgs}: {jobs}/{limitFile} -> 78 naming guards-all.sh --select;
//   guards-all.sh (full, --guards): 78 with the key and the placeholder, the command never runs.
// C1-C3: the whole-budget note also for a full command with only {limitFile}; the schema's guardSubsetCommand without
// the stale "one full run after the programmer's last commit"; the guards-all.sh comment of the note without a repeat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { skip, has, done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 700));

const ROOT = path.join(__dirname, '..');
const C = require('../scripts/config');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-a-')));
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

const FULL = 'cd {wt}/srv && npm run guards -- --all --concurrency {jobs} --concurrency-file {limitFile}';
const SUBJ = 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs} --concurrency-file {limitFile}';
// the count of a selection (p-noghost-b): guardSubsetCommand needs guardRerun.tallyPattern with a group
const base = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: FULL, guardRerun: { command: 'cd {wt} && run --only {name}', newRedPattern: '^X (\\S+) ', tallyPattern: '^TOTAL: (\\d+) total$' } };
const res = (o) => C.resolve(Object.assign({}, base, o));
const errs = (o) => res(o).errors.join('; ');
const RR = { command: FULL + ' --no-font', deps: [], localPattern: '^skipped \\(needs-font\\): \\d+ - (.+)$' };

try {
  // --- A: config.js knows the placeholders of every place ---
  let e = errs({ guardSubsetCommand: SUBJ, remoteRun: RR });
  ok('A1. guardSubsetCommand with {jobs}, {limitFile}; remoteRun.localPattern; no localCommand -> an error naming the default and both placeholders',
    /remoteRun\.localCommand \(default guardSubsetCommand\): \{jobs\}, \{limitFile\} are not filled in here \(only \{wt\}, \{onlyArgs\}\)/.test(e), e);
  const cf = path.join(T, 'a1.json');
  fs.writeFileSync(cf, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: SUBJ, remoteRun: RR })));
  let p = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', cf], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cf }) });
  ok('A1. ... config.js check: exit 1 with that text', p.status === 1 && /remoteRun\.localCommand \(default guardSubsetCommand\): \{jobs\}, \{limitFile\} are not filled in here/.test(p.stderr), `${p.status} ${p.stdout}${p.stderr}`);
  e = errs({ guardSubsetCommand: SUBJ, remoteRun: Object.assign({}, RR, { localCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs}' }) });
  ok('A2. an explicit localCommand without {jobs} -> no error', e === '', e);
  e = errs({ guardSubsetCommand: SUBJ, remoteRun: Object.assign({}, RR, { localCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --concurrency {jobs}' }) });
  ok('A3. an explicit localCommand with {jobs} -> an error naming the key and {jobs}', /remoteRun\.localCommand: \{jobs\} is not filled in here \(only \{wt\}, \{onlyArgs\}\)/.test(e) && !/\(default/.test(e), e);
  e = errs({ guardCommand: 'cd {wt} && run --all {onlyArgs}' });
  ok('A4. guardCommand with {onlyArgs} (the full run fills none) -> an error', /guardCommand: \{onlyArgs\} is not filled in here \(only \{wt\}, \{jobs\}, \{limitFile\}\)/.test(e), e);
  e = errs({ guardCommand: 'cd {wt} && run --concurrency {job}' });
  ok('A5. guardCommand with a typo {job} -> "unknown placeholder {job}"', /guardCommand: unknown placeholder \{job\}/.test(e), e);
  e = errs({ guardCommand: 'cd {wt} && echo ${HOME} ${=X} {a,b} {1..3} && run --concurrency {jobs}' });
  ok('A6. ${HOME}, ${=X}, {a,b}, {1..3} are not placeholders -> no error', e === '', e);
  e = errs({ guardCommandLegacy: 'cd {wt} && run --concurrency {jobs}', remoteRun: Object.assign({}, RR, { localCommand: 'x {wt} {onlyArgs}', commandLegacy: 'cd {wt} && run --concurrency {jobs} --concurrency-file {limitFile}' }) });
  ok('A7. remoteRun.commandLegacy with {limitFile} -> an error (as for guardCommandLegacy)', /remoteRun\.commandLegacy: \{limitFile\} is not filled in here \(only \{wt\}, \{jobs\}\)/.test(e), e);
  e = errs({ guardCommandLegacy: 'cd {wt} && run --concurrency {jobs} --concurrency-file {limitFile}' });
  ok('A7. ... guardCommandLegacy with {limitFile} -> still an error', /guardCommandLegacy: \{limitFile\} is not filled in here/.test(e), e);
  e = errs({ guardSubsetCommand: SUBJ, remoteRun: { command: FULL, deps: [], subsetCommand: SUBJ + ' --no-font' } });
  ok('A8. remoteRun.subsetCommand with {wt}, {onlyArgs}, {jobs}, {limitFile} -> ok', e === '', e);
  e = errs({ guardSubsetCommand: SUBJ, remoteRun: { command: FULL, deps: [], subsetCommand: SUBJ + ' --tag {name}' } });
  ok('A8. ... with {name} -> an error', /remoteRun\.subsetCommand: \{name\} is not filled in here/.test(e), e);
  e = errs({ guardRerun: { command: 'cd {wt} && run --only {name} --concurrency {jobs}', newRedPattern: '^FAIL (\\S+)' } });
  ok('A9. guardRerun.command with {jobs} -> an error (the rerun fills {wt} and {name})', /guardRerun\.command: \{jobs\} is not filled in here \(only \{wt\}, \{name\}\)/.test(e), e);
  e = errs({ guardSubsetCommand: SUBJ });
  ok('A10. guardSubsetCommand with {jobs} and {limitFile}, no remote part here -> ok (the selection fills them)', e === '', e);
  const ex = C.resolve(JSON.parse(read('examples/codis-agents.example.json')));
  ok('A. the example config still resolves without errors', ex.errors.length === 0, ex.errors.join('; '));

  // --- A11, A15: guards-remote.js run() with a config object (no load) ---
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\ntouch "$NOGHOST_SSH_MARK"\nexit 255\n');
  fs.chmodSync(path.join(bin, 'ssh'), 0o755);
  const repo = (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f.txt'), '1'); git(d, 'init', '-q', '-b', 'main'); git(d, 'add', 'f.txt'); git(d, 'commit', '-q', '-m', 'one'); return d; };
  const runRemote = (wt, localCommand, tag) => {
    const mark = path.join(T, `ssh-${tag}`);
    const cfg = { remote: { host: 'example.org', user: 'u', key: path.join(T, 'k'), knownHosts: path.join(T, 'kh'), root: '~/r', plugin: '/p' },
      remoteRun: { command: 'cd {wt} && run', deps: [], prepare: [], localPattern: '^skipped: (.+)$', localCommand }, guardRerun: null, guardBaseline: '', worktreeSetup: { scan: [] } };
    const src = `const GR = require(${JSON.stringify(path.join(ROOT, 'scripts', 'guards-remote.js'))});
      try { console.log('RC ' + GR.run(${JSON.stringify(cfg)}, ${JSON.stringify(wt)}, ${JSON.stringify(path.join(T, `log-${tag}.txt`))}, 'n', '')); }
      catch (e) { console.log('STOP ' + e.code + ' ' + e.message); }`;
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, NOGHOST_SSH_MARK: mark }) });
    return { out: (r.stdout || '') + (r.stderr || ''), ssh: fs.existsSync(mark) };
  };
  const w1 = repo(path.join(T, 'wt1'));
  let x = runRemote(w1, 'cd {wt} && run {onlyArgs} --concurrency {jobs}', 'a11');
  ok('A11. run() with localCommand holding {jobs} -> Stop 78 naming {jobs}, before the runner is contacted (no ssh)',
    /^STOP 78 .*remoteRun\.localCommand: \{jobs\} is not filled in here/m.test(x.out) && !x.ssh, `${x.out} ssh=${x.ssh}`);
  const w2 = repo(path.join(T, 'wt-{jobs}'));
  x = runRemote(w2, 'cd {wt} && run {onlyArgs}', 'a15');
  ok('A15. run() in a worktree whose path holds {jobs}, localCommand without it -> no refusal (the template is checked): the runner is contacted',
    !/^STOP 78/m.test(x.out) && x.ssh, `${x.out} ssh=${x.ssh}`);

  // --- A14, A15: guards-select.js --command ---
  const selRepo = (d) => { repo(d); fs.writeFileSync(path.join(d, 'a-run.js'), 'process.exit(0)\n'); git(d, 'add', 'a-run.js'); git(d, 'commit', '-q', '-m', 'two'); return d; };
  const sel = (d, subset) => {
    const f = path.join(T, `sel-${path.basename(d).replace(/\W/g, '_')}.json`);
    fs.writeFileSync(f, JSON.stringify(Object.assign({}, base, { guardSubsetCommand: subset })));
    git(d, 'branch', '-f', 'start', 'HEAD~1');
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-select.js'), '--wt', d, '--base', 'start', '--config', f, '--command'], { encoding: 'utf8' });
  };
  const s1 = selRepo(path.join(T, 'sel1'));
  p = sel(s1, SUBJ);
  ok('A14. guards-select.js --command with {jobs}/{limitFile} in guardSubsetCommand -> 78 naming {jobs} and guards-all.sh --select, nothing printed',
    p.status === 78 && /\{jobs\}/.test(p.stderr) && /guards-all\.sh --select/.test(p.stderr) && !p.stdout.trim(), `${p.status} ${p.stdout}${p.stderr}`);
  const s2 = selRepo(path.join(T, 'sel-{jobs}'));
  p = sel(s2, 'cd {wt}/srv && npm run guards -- --all {onlyArgs}');
  ok('A15. guards-select.js --command in a worktree whose path holds {jobs}, subset command without it -> exit 0, the command with that path',
    p.status === 0 && p.stdout.includes(s2) && /--only 'a-run\.js'/.test(p.stdout), `${p.status} ${p.stdout}${p.stderr}`);

  // --- A1, A12, A13: guards-all.sh refuses 78 and runs nothing ---
  if (!has('zsh')) skip('A1/A12/A13. guards-all.sh refuses 78', 'zsh not found');
  else {
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    const env0 = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    for (const k of ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR', 'SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
      'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env0[k];
    for (const k of Object.keys(env0)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k) && k !== 'SLOT_OS' && k !== 'SLOT_POLL' && k !== 'SLOT_SAY' && k !== 'SLOT_THIRD_WINDOW' && k !== 'SLOT_HIST_GAP') delete env0[k];
    const wts = path.join(T, 'wts');
    const ga = (tag, o, ...a) => {
      const w = repo(path.join(wts, tag));
      fs.mkdirSync(path.join(w, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(w, '.claude', 'codis-agents.json'), JSON.stringify(Object.assign({ repoDir: path.join(T, 'main'), worktreeRoot: wts, sharedDir: path.join(T, 'shared'),
        slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') }, guardCommand: 'cd {wt} && touch ran-full' }, o)));
      const names = path.join(T, `names-${tag}.json`);
      fs.writeFileSync(names, JSON.stringify(['a-run.js']));
      const r = spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), '--main-checkout', '--force', ...a.map((v) => (v === '@names' ? names : v)), w], { encoding: 'utf8', env: env0, timeout: 120000 });
      r.ran = fs.existsSync(path.join(w, 'ran-full')) || fs.existsSync(path.join(w, 'ran-sel'));
      return r;
    };
    let r = ga('a12', { guardSubsetCommand: 'cd {wt} && touch ran-sel && run {onlyArgs} {name}' }, '--guards', '@names');
    ok('A12. guards-all.sh --guards with {name} in guardSubsetCommand -> 78 naming guardSubsetCommand and {name}; nothing runs',
      r.status === 78 && /guardSubsetCommand: \{name\} is not filled in here/.test(r.stderr) && !r.ran, `${r.status} ran=${r.ran} ${r.stdout}${r.stderr}`);
    r = ga('a13', { guardCommand: 'cd {wt} && touch ran-full && run {onlyArgs}' });
    ok('A13. guards-all.sh (full) with {onlyArgs} in guardCommand -> 78 naming guardCommand and {onlyArgs}; nothing runs',
      r.status === 78 && /guardCommand: \{onlyArgs\} is not filled in here/.test(r.stderr) && !r.ran, `${r.status} ran=${r.ran} ${r.stdout}${r.stderr}`);
    r = ga('a1', { guardCommand: 'cd {wt} && touch ran-full --concurrency {jobs}', guardSubsetCommand: 'cd {wt} && touch ran-sel {onlyArgs} --concurrency {jobs}', remoteRun: { deps: [], localPattern: '^skipped: (.+)$' } });
    ok('A1. guards-all.sh with the A1 config -> 78 with the localCommand text; nothing runs',
      r.status === 78 && /remoteRun\.localCommand \(default guardSubsetCommand\): \{jobs\} is not filled in here/.test(r.stderr) && !r.ran, `${r.status} ran=${r.ran} ${r.stdout}${r.stderr}`);
  }

  // --- C: tails of the p-runq-a review ---
  const LIM = 'cd {wt}/srv && npm run guards -- --all --concurrency-file {limitFile}';
  let w = res({ guardCommand: LIM, guardSubsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs}' });
  ok('C1. guardCommand with only {limitFile}, guardSubsetCommand with neither -> the whole-budget note naming guardSubsetCommand, no error',
    !w.errors.length && w.warnings.some((s) => /note: guardSubsetCommand has no \{jobs\} \(and no \{limitFile\}\)/.test(s)), w.errors.concat(w.warnings).join('; '));
  w = res({ guardCommand: LIM, guardSubsetCommand: SUBJ, remoteRun: { command: LIM + ' --no-font', deps: [], subsetCommand: 'cd {wt}/srv && npm run guards -- --all {onlyArgs} --no-font' } });
  ok('C1. ... the same for the pair remoteRun.command / remoteRun.subsetCommand',
    !w.errors.length && w.warnings.some((s) => /note: remoteRun\.subsetCommand has no \{jobs\}/.test(s)) && !w.warnings.some((s) => /note: guardSubsetCommand has no/.test(s)), w.errors.concat(w.warnings).join('; '));
  const schema = JSON.parse(read('schemas/codis-agents.schema.json'));
  const d = schema.properties.guardSubsetCommand.description;
  ok('C2. schema guardSubsetCommand: no stale "one full run ... after the programmer\'s last commit"', !/after the programmer's last commit/.test(d) && !/runs one full run/.test(d), d);
  ok('C2. ... it says what the README says: the selection of the task\'s diff after every programmer round, no full run in the task', /no full guard run in the task/i.test(d) && /selection/.test(d), d);
  const lines = read('scripts/guards-all.sh').split('\n');
  const at = lines.findIndex((l) => /^if \[\[ -n \$SELECT && \$CMD != \*'\{jobs\}'\*/.test(l));
  let i = at - 1; const block = [];
  while (i >= 0 && /^\s*#/.test(lines[i])) block.unshift(lines[i--]);
  const said = block.map((l) => l.replace(/^\s*#\s?/, '')).join(' ');
  ok('C3. guards-all.sh: the comment of the whole-budget note says "on the runner its subsetCommand" once, no repeated line',
    at > 0 && block.length > 0 && (said.match(/on the runner its subsetCommand/g) || []).length === 1 && !/\(the same test as mode=whole above/.test(said), block.join('\n'));

  // --- docs (same commit as the behaviour) ---
  const readme = read('README.md');
  ok('docs: README says a placeholder its place does not fill, or an unknown one, is a config error', /unknown placeholder/.test(readme) && /not filled in/.test(readme));
  ok('docs: schema localCommand says {jobs}/{limitFile} are not filled in there', /not filled in/.test(schema.properties.remoteRun.properties.localCommand.description), schema.properties.remoteRun.properties.localCommand.description);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
