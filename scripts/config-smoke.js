'use strict';
// config.js smoke <worktree> <guard> [<guard of the part here>] [--main-checkout] (p-noghost, item 3 of the brief): the
// project config run through every path that narrows a guard command to named guards, one guard each, so an edit of
// the config that leaves a path running nothing is red before any task or train uses it. Case 2026-10-30: the
// coordinator added {jobs} and {limitFile} to guardSubsetCommand; the part here of a remote run (remoteRun.localCommand,
// by default guardSubsetCommand) does not fill them, the project's runner took zero workers, ran 0 of 10 guards and
// exited 0 - two trains went green without the Mac part, and nothing had run the edited config before.
//   1. The main working copy is refused with 78 before anything runs (scripts/main-checkout.js, as guards-all.sh;
//      --main-checkout for a project without worktrees, passed on to guards-all.sh).
//   2. The config is loaded as config.js check loads it: any error (an extra or unknown placeholder of a command,
//      scripts/config.js FILLS) is red before any path runs.
//   3. The paths, one after another, each with the one guard:
//      selection here - guardSubsetCommand, by guards-all.sh --local --force --guards (the same fill as --select);
//      runner         - remoteRun.subsetCommand, by guards-all.sh --force --guards on the remote runner (committed HEAD
//                       only); "none" without remote in the machine file, remoteRun or remoteRun.subsetCommand;
//      part here      - remoteRun.localCommand (by default guardSubsetCommand) with remoteRun.localPattern, by the same
//                       function the part here of a remote run uses (scripts/guards-remote.js partHere), its log
//                       <sharedDir>/guards-<name>.smoke-local.txt; "none" without remoteRun.localPattern.
//      A path is ok when it exits 0 and its tally (group 1 of guardRerun.tallyPattern; for the runner, of the runner's
//      own log before the section of the part here) counts at least its one guard. Stricter than the count of a run
//      (scripts/guards-result.js countCheck): a guard the path skipped by a flag (a remoteRun.localPattern line) is red
//      here too - the smoke needs the path to run a guard, so pick one that path runs, and a green one.
//   4. The full commands (guardCommand, remoteRun.command; no {onlyArgs}) are not narrowed to one guard: they get the
//      static check of 2. only.
// The selection paths write the selection log of the worktree (<sharedDir>/guards-<name>.select.txt), as any --guards
// run does: run the smoke in a worktree whose selection log is not needed. The paths take heavy slots (guards-all.sh,
// heavy.sh): an agent runs the smoke in the background and waits in slices.
// Exit: 0 - no path red (a path "none" is not red); 1 - a config error or a red path (named in the summary); 64 usage;
// 66 no such worktree; 78 the main working copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./config');
const G = require('./guards-result');
const R = require('./guards-remote');
const { mainCheckout, refusal } = require('./main-checkout');

const USAGE = 'usage: config.js smoke <worktree> <guard> [<guard of the part here>] [--main-checkout]';
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The name guards-all.sh gives the logs of a worktree: its base name under worktreeRoot, else the base name and the
// cksum of its resolved path (guards-all.sh, NAME).
function logName(c, wt) {
  const w = real(wt), name = path.basename(w);
  if (c.worktreeRoot && path.dirname(w) === real(c.worktreeRoot)) return name;
  const r = spawnSync('cksum', { input: w, encoding: 'utf8' });
  return `${name}-${(r.stdout || '').trim().split(/\s+/)[0]}`;
}

// ok / RED of one path: its exit code and the count of its one guard in its log text.
function judge(c, label, rc, text, guard, log) {
  const n = G.countCheck({ text, cfg: c.guardRerun || {}, selected: [guard], localPattern: '', label });
  const counted = n.total === undefined ? 'cannot be counted (guardRerun.tallyPattern has no count group)'
    : n.total === null ? `no tally line (guardRerun.tallyPattern) for ${guard}` : `accounted for ${n.total} of 1 (${guard})`;
  const red = !n.ok || rc !== 0;
  const why = !n.ok ? ' - the path ran no guard: check the placeholders of its command and that it runs this guard (not skipped by a flag)'
    : rc !== 0 ? ' - pick a guard that is green on this path' : '';
  return { red, line: `${red ? 'RED ' : 'ok  '} ${label}: ${counted}, exit ${rc}${why}${log ? ` - log ${log}` : ''}` };
}

function smoke(argv, env = process.env) {
  const out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n');
  const mainOk = argv.includes('--main-checkout');
  const pos = argv.filter((a) => a !== '--main-checkout');
  if (pos.length < 2 || pos.length > 3 || pos.some((a) => !a || a.startsWith('--'))) { err(USAGE); return 64; }
  const [wtArg, guard, localGuard = guard] = pos;
  const wt = path.resolve(wtArg);
  if (!fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) { err(`config.js smoke: no worktree ${wt}`); return 66; }
  if (!mainOk) {
    const m = mainCheckout(wt);
    if (m.main) { err(`config.js smoke: ${refusal(wt, m)}`); return 78; }
  }
  // the config of the worktree, as guards-all.sh <absolute worktree> finds it (config.js path --from)
  const fenv = Object.assign({}, env); delete fenv.CLAUDE_PROJECT_DIR;
  const file = C.find(wt, fenv);
  if (!file) { err(`config.js smoke: no project config found from ${wt} (set CODIS_AGENTS_CONFIG)`); return 1; }
  const { config: c, errors } = C.load(file);
  if (errors.length) {
    for (const e of errors) err('codis-agents config: ' + e);
    err(`config.js smoke: RED - the config ${file} has errors (above); no path ran`);
    return 1;
  }
  const childEnv = Object.assign({}, env, { CODIS_AGENTS_CONFIG: file });
  Object.assign(process.env, { CODIS_AGENTS_CONFIG: file });   // partHere's heavy.sh reads the same config
  const name = logName(c, wt), sel = path.join(c.sharedDir, `guards-${name}.select.txt`);
  const results = [];
  const none = (label, why) => results.push({ red: false, line: `none ${label}: ${why}` });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-smoke-'));
  try {
    const names = path.join(tmp, 'names.json');
    fs.writeFileSync(names, JSON.stringify([guard]));
    const ga = (...a) => {
      fs.rmSync(sel, { force: true });
      const r = spawnSync('zsh', [path.join(__dirname, 'guards-all.sh'), '--force', ...(mainOk ? ['--main-checkout'] : []), ...a, '--guards', names, wt],
        { stdio: ['ignore', 'inherit', 'inherit'], env: childEnv });
      return { rc: r.status === null ? 1 : r.status, text: fs.existsSync(sel) ? fs.readFileSync(sel, 'utf8') : '' };
    };
    // 1. the selection here
    let label = 'selection here (guardSubsetCommand)';
    if (!c.guardSubsetCommand) none(label, 'no guardSubsetCommand');
    else {
      out(`== config.js smoke: ${label}, ${guard}`);
      const r = ga('--local');
      results.push(judge(c, label, r.rc, r.text, guard, sel));
    }
    // 2. the runner's selection
    label = 'runner (remoteRun.subsetCommand)';
    if (!c.remote) none(label, 'no remote in the machine file');
    else if (!c.remoteRun) none(label, 'no remoteRun in the project config');
    else if (!c.remoteRun.subsetCommand) none(label, 'no remoteRun.subsetCommand: a selection runs here');
    else {
      out(`== config.js smoke: ${label}, ${guard} on ${c.remote.host}`);
      const r = ga();
      results.push(judge(c, label, r.rc, r.text.split(R.PART_MARK)[0], guard, sel));
    }
    // 3. the part here
    label = 'part here (remoteRun.localCommand)';
    if (!c.remoteRun || !c.remoteRun.localPattern) none(label, 'no remoteRun.localPattern');
    else {
      out(`== config.js smoke: ${label}, ${localGuard}`);
      const local = path.join(c.sharedDir, `guards-${name}.smoke-local.txt`);
      fs.mkdirSync(c.sharedDir, { recursive: true });
      const rc = R.partHere(c.remoteRun, wt, local, [localGuard], `config.js smoke ${name} part here`);
      results.push(judge(c, label, rc, fs.readFileSync(local, 'utf8'), localGuard, local));
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // 4. the full commands
  results.push({ red: false, line: `static full run (guardCommand${c.remoteRun ? ', remoteRun.command' : ''}): not narrowed to one guard (no {onlyArgs}) - the static check of config.js only` });
  const red = results.filter((r) => r.red);
  out(`\nconfig.js smoke ${file}:`);
  for (const r of results) out(r.line);
  out(red.length ? `config.js smoke: RED - ${red.length} path(s) red; fix the config before a task or a train uses it`
    : 'config.js smoke: ok - no path red');
  return red.length ? 1 : 0;
}

module.exports = { smoke, logName, judge, USAGE };
