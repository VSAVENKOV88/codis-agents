'use strict';
// Trusted git: every git process a trusted process of the plugin starts (the conductor, the train, guards-all.sh and its
// helpers, the runner's job, the service steps of a chain, the coordinator's tools) runs through this module, so that
// no hook and no fsmonitor of the repository or worktree it reads is executed - wherever that config lies (a committed
// husky-like relative core.hooksPath, an absolute one, a config.worktree a branch wrote, a foreign gitdir behind a
// rewritten .git file). The values come from the command line (`-c`), which git ranks above every config file
// (git-config(1), "-c"), and git passes them on to its own child processes (GIT_CONFIG_PARAMETERS).
//   -c core.hooksPath=/dev/null  no hook can be found: post-checkout, post-merge, post-index-change,
//                                reference-transaction, pre-push, pre-auto-gc ... of the main checkout too;
//   -c core.fsmonitor=false      status, ls-files and diff against the index never start the fsmonitor command;
//   --no-optional-locks          a read never rewrites the index (git(1): GIT_OPTIONAL_LOCKS=0), it takes no lock
//                                another git of the same worktree would wait for.
// Nothing else changes: the user's global config (the identity of the train's commits, url.insteadOf, safe.directory)
// and the environment stay as the caller passes them; the caller picks the git binary (the heavy channel passes the
// git of the user's PATH) and the environment (main-checkout.js drops GIT_*). Other executable config (filters,
// diff.textconv, core.sshCommand) is not covered (README, Known gaps).
// tests/trusted-git-census.test.js fails on a git call of scripts/ or workflows/ that does not go through here and is
// not one of its named exceptions.
// usage (zsh): TRUSTED_GIT=(${(f)"$(node trusted-git.js flags)"}); git "${TRUSTED_GIT[@]}" -C <dir> <command> ...
const { spawnSync } = require('child_process');

const FLAGS = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-optional-locks']);
const argv = (args) => FLAGS.concat(args);
// spawnSync of git with FLAGS ahead of args; opts as for spawnSync plus `git` (the binary, default "git" from PATH).
// Returns the result of spawnSync unchanged.
function run(args, opts) {
  const o = Object.assign({}, opts);
  const bin = o.git || 'git';
  delete o.git;
  return spawnSync(bin, argv(args), o);
}
// As run, throwing like execFileSync when git fails (exit code not 0 or not started): the error carries status and
// stderr. -> stdout.
function out(args, opts) {
  const r = run(args, opts);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`git ${args.join(' ')}: exit ${r.status === null ? r.signal : r.status}: ${String(r.stderr || '').trim()}`);
    e.status = r.status; e.stderr = r.stderr; e.stdout = r.stdout;
    throw e;
  }
  return r.stdout;
}

module.exports = { FLAGS, argv, run, out };

if (require.main === module) {
  if (process.argv[2] === 'flags' && process.argv.length === 3) { process.stdout.write(FLAGS.join('\n') + '\n'); process.exit(0); }
  console.error('usage: trusted-git.js flags   (one flag per line, for zsh: git "${TRUSTED_GIT[@]}" ...)');
  process.exit(64);
}
