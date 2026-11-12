'use strict';
// A fixture project for the guard runs of a codex role through the heavy channel (tests/heavy-guards*.test.js): a git
// repository with a linked worktree (guards-all.sh refuses the main working copy with 78), a runner script with three
// modes of guardCommand (fixed {jobs}, adaptive {limitFile}, whole without {jobs}), guardSubsetCommand with {onlyArgs},
// guardRerun with one guard red in a run and green alone, a guardBaseline file, its own slot directory and shared folder.
// The runner prints one line "RUNNER sb=<CODEX_SANDBOX> pg=<its group> mark=<yes: the exec marker of its group exists
// on the held slot> exec=<CODIS_GUARDS_EXEC or none>" and the tally "accounted N, failed F".
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = `#!/bin/zsh
# fixture runner: runner.sh <jobs> <limitFile|-> [--only <guard>]... | runner.sh one <guard>
pg=$(perl -e 'print getpgrp')
h=\${CODIS_SLOT_HELD#* }
mark=no; [[ -n $CODIS_SLOT_HELD && -e $h.exec.$pg ]] && mark=yes
print -r -- "RUNNER sb=\${CODEX_SANDBOX:-none} pg=$pg mark=$mark exec=\${CODIS_GUARDS_EXEC:-none} held=\${CODIS_SLOT_HELD:-none}"
typeset -a list
if [[ $1 == one ]]; then export FIX_SINGLE=1; list=($2)
else
  jobs=$1 lim=$2; shift 2
  print -r -- "JOBS=$jobs"
  if [[ $lim != - ]]; then
    print -r -- "LIMIT=$(cat $lim 2>/dev/null)"
    if { print 1 > $lim.active } 2>/dev/null; then print -r -- ACTIVE=written; else print -r -- ACTIVE=refused; fi
  fi
  while (( $# )); do [[ $1 == --only ]] && list+=($2); shift 2; done
  (( $#list )) || list=(guards/*.g(N))
fi
n=0 f=0
for g in $list; do n=$((n+1)); zsh $g || { print -r -- "FAIL $g"; f=$((f+1)); }; done
print -r -- "accounted $n, failed $f"
(( f == 0 ))
`;

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// root: an empty folder. o.mode: fixed | adaptive | whole; o.guards: {name: body} (zsh; default a.g green and
// flaky.g red in a run, green alone); o.config: more keys of the project config. -> {repo, wt, shared, slots, cfg,
// head, base, commit(files)}
function makeProject(root, o) {
  const x = o || {};
  const repo = path.join(root, 'repo'), wts = path.join(root, 'wts'), wt = path.join(wts, 'wt'), shared = path.join(root, 'shared'), slots = path.join(root, 'slots');
  for (const d of [repo, wts, shared, slots]) fs.mkdirSync(d, { recursive: true });
  const guards = x.guards || { 'a.g': 'exit 0', 'flaky.g': '[[ -n $FIX_SINGLE ]]' };
  fs.mkdirSync(path.join(repo, 'guards'));
  for (const [n, b] of Object.entries(guards)) fs.writeFileSync(path.join(repo, 'guards', n), b + '\n');
  fs.writeFileSync(path.join(repo, 'runner.sh'), RUNNER);
  fs.writeFileSync(path.join(repo, 'baseline.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'README'), 'fixture\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
  const cmd = { fixed: 'cd {wt} && zsh runner.sh {jobs} -', adaptive: 'cd {wt} && zsh runner.sh {jobs} {limitFile}', whole: 'cd {wt} && zsh runner.sh 0 -' }[x.mode || 'fixed'];
  const config = Object.assign({ repoDir: repo, worktreeRoot: wts, sharedDir: shared, slots: { lockDir: slots }, guardFiles: ['*.g'], guardCommand: cmd,
    guardSubsetCommand: 'cd {wt} && zsh runner.sh {jobs} - {onlyArgs}',
    guardRerun: { command: 'cd {wt} && zsh runner.sh one {name}', newRedPattern: '^FAIL (\\S+)', tallyPattern: '^accounted (\\d+)', maxReruns: 5 },
    guardBaseline: 'baseline.json' }, x.config || {});
  const cfgDir = path.join(root, 'cfg');
  fs.mkdirSync(cfgDir);
  const cfg = path.join(cfgDir, 'codis-agents.json');
  fs.writeFileSync(cfg, JSON.stringify(config, null, 1));
  const commit = (files) => {
    for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), b); }
    git(wt, 'add', ...Object.keys(files));
    git(wt, 'commit', '-q', '-m', 'change');
    return git(wt, 'rev-parse', 'HEAD');
  };
  return { repo, wt, wts, shared, slots, cfg, config, base, head: () => git(wt, 'rev-parse', 'HEAD'), commit, git: (...a) => git(wt, ...a) };
}

module.exports = { makeProject, RUNNER };
