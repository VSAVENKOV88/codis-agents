#!/usr/bin/env node
'use strict';
// Claude Code PreToolUse hook on Bash (hooks/hooks.json). Refuses:
//  * `git add -A` / `--all` / `.` / `:/` - stage files by path (cloud-synced folders spawn conflict copies, and a
//    blanket add sweeps in scratch files of other agents);
//  * `git push` to a protected branch, of a protected tag, or `--all` / `--mirror` / `--tags` / `--follow-tags`
//    (project config "protectedBranches", "protectedTagPattern"; without protectedBranches the default branch of the
//    repository that pushes - config.js; when that is unknown, every branch push: closed, not open) unless ALLOW_PROTECTED_PUSH=1 is set, inline or in
//    the environment, on the owner's explicit word, or - for a branch only - when the pushing repository itself declares a
//    standing push in its committed config (scripts/standing-push.js: HEAD only, no force or delete, check green).
//    While the branches are unknown a bare destination after a colon is a branch push even when the source is a tag:
//    git matches the name against the remote's refs (a local tag master + git push origin master:master updates the
//    remote branch master), so only <tag> without a colon or <src>:refs/tags/<name> is a tag push;
//  * `git remote set-head` (any form) and a write or delete of `git symbolic-ref refs/remotes/<remote>/HEAD`: the
//    default branch the hooks protect is where the local refs/remotes/origin/HEAD points (config.js), so moving or
//    dropping it is the owner's call too (ALLOW_PROTECTED_PUSH=1 on the owner's explicit word); so is `git update-ref`
//    on refs/remotes/<remote>/HEAD, and `git update-ref --stdin` (its refs come from input the hook cannot see);
//  * a git command the hook judges that names its repository with --git-dir / --work-tree or GIT_DIR / GIT_WORK_TREE /
//    GIT_COMMON_DIR (inline, through env, assigned anywhere in the same command line, or in the hook's environment):
//    the config is looked up from those paths too, and a push is refused (the hook reads the branches through -C).
//  * a git command with a global option before the subcommand that the hook's measured table (GIT_GLOBAL) does not hold:
//    the hook cannot tell which word is the subcommand, and git fails on an option it does not know anyway.
//  * a commit or a reset of the arc branch under a train (p-noghost-e1): while a live dispatcher holds the train lock and
//    its <sharedDir>/train/lock/owner.json names the arc (base; scripts/train-lock.js, the same liveness as train.js),
//    a git command in a directory of the project's repository (the cwd, or -C) whose current branch - or the branch of
//    an unfinished rebase there (head-name) - is that arc and that moves it: commit (not --dry-run), merge, pull,
//    rebase, cherry-pick, revert, am (not --abort / --quit / ...), reset with a commit (not a reset of paths), and
//    checkout -B / switch -C naming the arc from anywhere. The train would end arc-moved (no verdict, the passengers ride
//    again): wait for it (train.js status), or let the change ride as a passenger. ALLOW_PROTECTED_PUSH=1 does not lift
//    it (coordinator's decision 2 for p-noghost-e); a dead holder is no train. The dispatcher itself moves the arc
//    from inside node (spawnSync), so the hook never sees it, and `node train.js ...` is not git.
//    From any directory of the project's repository (p-noghost-e2), the commands that name the arc:
//    update-ref refs/heads/<arc> (or HEAD in the arc's worktree), branch -f/-m/-M/-c/-C/-d/-D with the arc among the names (or -m
//    <new> in its worktree), push into this repository (., a path, file://, a remote whose URL is it) with the arc as a
//    destination, fetch / pull with the arc as a destination (a glob that covers it, --stdin), worktree add -B <arc>,
//    rebase <upstream> <arc>; with --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE on the project's repository the
//    current branch is taken to be the arc (closed). The directory follows a literal cd / pushd / popd in the line
//    (decision 1 for p-noghost-e; cd with an expansion is not followed and not judged: README "Known gaps"). The
//    project is the config the session names and the config found from the directory, either; a relative repoDir or
//    sharedDir is relative to the project root, as config.js reads it. git reset HEAD (any mode) moves nothing.
// git takes any unique prefix of a long option (gitcli(7)): --del is --delete. A word that is a prefix of a long option
// the hook judges counts as that option; an ambiguous prefix makes git fail, so judging it so is safe.
// Active only in projects that have .claude/codis-agents.json: the plugin is opt-in per project.
// The git pre-push hook (scripts/git-hooks/pre-push) is the last line; this hook explains the refusal to the agent
// before anything runs.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { find, load } = require(path.join(__dirname, '..', 'config.js'));
const standingPush = require(path.join(__dirname, '..', 'standing-push.js'));
const trainLock = require(path.join(__dirname, '..', 'train-lock.js'));
const TRAIN_JS = path.join(__dirname, '..', 'train.js');

// Splits a command line into simple commands (on && || ; | & and newlines) and words, honouring quotes. parseSeq also
// keeps the operators before each command ('&&', '||', '|', '|&', ';', '&', '\n', '(', ')', and 'R' for the & of a
// redirection such as 2>&1 or &>/dev/null, which does not end the command for the shell) and those after the last one
// (seq.tail): the hook follows cd / pushd / popd with them (judgeDirs).
function parseSeq(line) {
  const cmds = [];
  let words = [], w = null, i = 0, ops = [];
  const end = () => { if (w !== null) { words.push(w); w = null; } };
  const cut = (op) => { end(); if (words.length) { cmds.push({ words, ops }); ops = []; } words = []; ops.push(op); };
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") { const j = line.indexOf("'", i + 1); w = (w || '') + line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j + 1; continue; }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && j + 1 < line.length) j++; s += line[j]; j++; }
      w = (w || '') + s; i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < line.length) { w = (w || '') + line[i + 1]; i += 2; continue; }
    if (/[;&|\n()]/.test(ch)) {
      let op = ch;
      if ((ch === '&' || ch === '|') && line[i + 1] === ch) op = ch + ch;
      else if (ch === '|' && line[i + 1] === '&') op = '|&';
      else if (ch === '&' && (line[i + 1] === '>' || (w !== null && /[<>]$/.test(w)))) op = 'R';
      cut(op); i += op.length === 2 ? 2 : 1; continue;
    }
    if (/\s/.test(ch)) { end(); i++; continue; }
    w = (w || '') + ch; i++;
  }
  end();
  if (words.length) { cmds.push({ words, ops }); ops = []; }
  cmds.tail = ops;
  return cmds;
}
const parse = (line) => parseSeq(line).map((c) => c.words);

// The global options of git before the subcommand, measured with `git <option> version` and `git <option> <value>
// version` (git 2.50 on macOS; tests/hooks-sec-globals.test.js checks the table against the git it runs on, the
// Ubuntu 24.04 container's too). git(1) does not list them all (--shallow-file, --attr-source are missing from its
// usage line). value: the next word is the value; eq: the attached --opt=<value> form is accepted; flag: no value;
// exit / exitEq: git prints something (or runs git version / git help with the rest as arguments) and runs nothing
// after it - bare --exec-path is one of these, it takes no separate value. Global options take no abbreviation
// (--git-d= is an unknown option). Any other word starting with - before the subcommand is unknown to the hook: in a
// project with a config it is refused, since the hook cannot tell which word is the subcommand and git fails on an
// option it does not know anyway.
const GIT_GLOBAL = {
  value: new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--shallow-file']),
  eq: new Set(['--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source', '--exec-path']),
  flag: new Set(['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks',
    '--no-advice', '--literal-pathspecs', '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']),
  exit: new Set(['-v', '--version', '-h', '--help', '--exec-path', '--html-path', '--man-path', '--info-path']),
  exitEq: new Set(['--list-cmds']),
};
const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--signed']);

// git accepts a unique prefix of a long option, with or without =<value> (gitcli(7); measured with git 2.50:
// `git symbolic-ref --del`, `git push --de`, `git update-ref --no-d`). Git's own global options (--git-dir) do not.
const longOpt = (a, name) => { if (!a.startsWith('--')) return false; const n = a.slice(2).split('=')[0]; return n.length > 0 && name.startsWith(n); };
const REMOTE_HEAD = /^refs\/remotes\/.+\/HEAD$/iu;
// The variables that name the repository git works on (git(1) ENVIRONMENT VARIABLES).
const GIT_REPO_VAR = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/;

const HEAD_WHY = 'refs/remotes/origin/HEAD names the default branch the hooks protect when the config does not; moving or dropping it is the owner\'s call (ALLOW_PROTECTED_PUSH=1 only on the owner\'s explicit word)';

// git remote [-v | --verbose] set-head ... (git-remote(1)) - every form: --auto, --delete and a branch name all rewrite
// the ref; git symbolic-ref [-m <reason>] <name> <ref> or -d|--delete <name> (git-symbolic-ref(1)) with
// <name> = refs/remotes/<remote>/HEAD. Reading it (one name, no delete) stays allowed. The name is compared without
// regard to case: on a case-insensitive file system (APFS, the macOS default) the loose ref refs/remotes/origin/head is
// the same file as refs/remotes/origin/HEAD (measured with git 2.50). APFS folds case by Unicode, so the comparison
// does too (flag u): refs/remote\u017f/origin/HEAD (long s) is the same file and git writes through it; without u a
// JavaScript /i regex does not fold U+017F to s (or U+212A Kelvin to k). Git subcommand names are case-sensitive
// (`git Remote` fails: cannot handle Remote as a builtin), so only the ref name needs it.
function judgeRemoteHead(sub, args) {
  if (sub === 'update-ref') {
    // git update-ref [-m <reason>] [--no-deref] (-d <ref> [<old>] | <ref> <new> [<old>] | --stdin [-z]) (git-update-ref(1)):
    // with --no-deref it rewrites the symbolic ref itself, and --stdin takes symref-update/-delete commands from input.
    const stdin = args.find((a) => longOpt(a, 'stdin'));
    if (stdin) return `\`git update-ref ${stdin}\` is refused: it takes the refs to change from its input, which the hook cannot judge, and it can move refs/remotes/origin/HEAD - ${HEAD_WHY}.`;
    const name = args.find((a) => REMOTE_HEAD.test(a));
    return name ? `\`git update-ref ${name}\` is refused: ${HEAD_WHY}.` : null;
  }
  if (sub === 'remote') {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k++;
    return args[k] === 'set-head' ? `\`git remote set-head\` is refused: ${HEAD_WHY}.` : null;
  }
  let del = false, dashes = false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dashes || !a.startsWith('-') || a === '-') { pos.push(a); continue; }
    if (a === '--') { dashes = true; continue; }
    if (longOpt(a, 'delete')) { del = true; continue; }
    if (a.startsWith('--')) { if (a === '--message') k++; continue; }
    // A cluster of short options (-qd, -qm why, -mwhy): d deletes, m takes the rest or the next word as its value.
    const m = a.indexOf('m');
    const flags = m < 0 ? a.slice(1) : a.slice(1, m);
    if (flags.includes('d')) del = true;
    if (m === a.length - 1) k++;
  }
  if (REMOTE_HEAD.test(pos[0] || '') && (del || pos.length >= 2)) return `\`git symbolic-ref ${pos[0]}\` (write or delete) is refused: ${HEAD_WHY}.`;
  return null;
}

// ---- a commit or a reset of the arc branch under a train ----
// Subcommands that move the current branch of their directory (measured with git 2.50 in the analysis p-noghost-e, E4;
// git-<cmd>(1)) and the options with which they do not: those only stop, show or edit the operation in progress.
const MOVES = {
  commit: ['dry-run'],
  merge: ['abort', 'quit'],
  pull: [],
  rebase: ['abort', 'quit', 'edit-todo', 'show-current-patch'],
  'cherry-pick': ['abort', 'quit'],
  revert: ['abort', 'quit'],
  am: ['abort', 'quit', 'show-current-patch'],
};
const ARC_SUBS = new Set([...Object.keys(MOVES), 'reset', 'checkout', 'switch']);
// The subcommands that can move a branch they name, from any directory of the repository (p-noghost-e2; E4 of the
// analysis p-noghost-e): update-ref refs/heads/<arc>, branch -f/-m/-M/-c/-C/-d/-D, push into this repository, fetch
// into the arc, worktree add -B <arc>.
const TRAIN_SUBS = new Set([...ARC_SUBS, 'update-ref', 'branch', 'push', 'fetch', 'worktree']);
// The options of those subcommands that take a value (git-<cmd>(1): <arg> in the synopsis). The value is the next word
// (-m --dry-run is a message, not an option) or the rest of its short word (-mtext); --name=<arg> takes nothing more.
const FETCH_VALUES = ['depth', 'deepen', 'shallow-since', 'shallow-exclude', 'jobs', 'negotiation-tip', 'server-option', 'upload-pack', 'refmap', 'filter', 'submodule-prefix', 'recurse-submodules-default'];
const VALUE_OPTS = {
  commit: { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'cleanup', 'template', 'trailer', 'pathspec-from-file'] },
  merge: { short: 'mFsX', long: ['message', 'file', 'into-name', 'strategy', 'strategy-option', 'cleanup'] },
  rebase: { short: 'sXx', long: ['strategy', 'strategy-option', 'exec', 'onto'] },
  'cherry-pick': { short: 'mX', long: ['mainline', 'strategy', 'strategy-option', 'cleanup'] },
  revert: { short: 'mX', long: ['mainline', 'strategy', 'strategy-option', 'cleanup'] },
  am: { short: '', long: ['directory', 'exclude', 'include', 'patch-format', 'whitespace'] },
  pull: { short: 'sXjo', long: ['strategy', 'strategy-option', ...FETCH_VALUES] },
  fetch: { short: 'jo', long: FETCH_VALUES },
  push: { short: 'o', long: ['push-option', 'repo', 'receive-pack', 'exec'] },
  branch: { short: 'u', long: ['set-upstream-to', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format'] },
  'update-ref': { short: 'm', long: [] },
};
// The long options of a subcommand as the words that name them (options before --; the words after -- are paths or
// revisions), the letters of its short options, the values of its value options ([word, value]) and its positional
// words. A value word is neither.
function scanOpts(sub, args) {
  const v = VALUE_OPTS[sub] || { short: '', long: [] };
  const longs = [], pos = [], vals = [];
  let shorts = '';
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { pos.push(...args.slice(k + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { pos.push(a); continue; }
    if (a.startsWith('--')) {
      longs.push(a);
      if (v.long.some((n) => longOpt(a, n))) {
        if (a.includes('=')) vals.push([a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]);
        else { vals.push([a, args[k + 1] || '']); k++; }
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      shorts += a[j];
      if (!v.short.includes(a[j])) continue;
      if (j === a.length - 1) { vals.push(['-' + a[j], args[k + 1] || '']); k++; } else vals.push(['-' + a[j], a.slice(j + 1)]);
      break;
    }
  }
  return { longs, pos, vals, shorts };
}

// git reset moves the branch only in its commit form, git reset [<mode>] [<commit>] (git-reset(1)); with paths (after
// --, more than one word, --pathspec-from-file) or --patch it changes the index only, and without a commit, or with HEAD
// itself (HEAD, @: the commit the branch is on), it stays. isCommit tells whether git resolves the word as a commit.
function resetMoves(args, isCommit) {
  const pos = [];
  let dashes = false, paths = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (dashes) { paths = true; continue; }
    if (a === '--') { dashes = true; continue; }
    if (a === '-' || !a.startsWith('-')) { pos.push(a); continue; }
    if (longOpt(a, 'pathspec-from-file')) { paths = true; if (!a.includes('=')) k++; continue; }
    if (longOpt(a, 'patch') || (!a.startsWith('--') && a.slice(1).includes('p'))) paths = true;
  }
  if (paths || pos.length !== 1 || pos[0] === 'HEAD' || pos[0] === '@') return false;
  // '-' is the previous branch (@{-1}); any other word moves the branch when git resolves it as a commit
  return pos[0] === '-' || isCommit(pos[0]);
}

// The branch checkout -B <name> (git-checkout(1)), switch -C / --force-create <name> (git-switch(1)) or worktree add -B
// <name> (git-worktree(1)) resets, or null.
function forceCreated(sub, args) {
  const letter = sub === 'switch' ? 'C' : 'B';
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') break;
    // --force is an exact option of its own (an alias of --discard-changes), not an abbreviation of --force-create
    if (sub === 'switch' && a.startsWith('--') && a.split('=')[0] !== '--force' && longOpt(a, 'force-create')) return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[k + 1] || '');
    if (a.startsWith('-') && !a.startsWith('--')) {
      const i = a.indexOf(letter);
      if (i > 0) return a.slice(i + 1) || args[k + 1] || '';
    }
  }
  return null;
}

// The nearest directory that exists (a cd into a directory the line creates first is judged by its parent).
const existing = (d) => { let x = d; while (x && !fs.existsSync(x)) { const u = path.dirname(x); if (u === x) break; x = u; } return x; };
const gitOut = (dir, ...a) => { const r = spawnSync('git', ['-C', existing(dir), ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
// The common git directory of the repository at d (a worktree, a subdirectory, a git directory), or ''.
const common = (d) => {
  let c = gitOut(d, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!c) { const r = spawnSync('git', ['--git-dir=' + d, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }); c = r.status === 0 ? r.stdout.trim() : ''; }
  return c ? real(c) : '';
};
// The branch the command moves when it moves "the current branch" of dir: HEAD's branch, or, with HEAD detached by an
// unfinished rebase, the branch that rebase finishes on (rebase-merge/head-name or rebase-apply/head-name; E5).
function currentBranch(dir) {
  const h = gitOut(dir, 'symbolic-ref', '-q', 'HEAD');
  if (h) return h;
  for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const p = gitOut(dir, 'rev-parse', '--path-format=absolute', '--git-path', f);
    let t = ''; try { t = p ? fs.readFileSync(p, 'utf8').trim() : ''; } catch { /* no rebase */ }
    if (t) return t;
  }
  return '';
}

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does the destination d of a refspec (push, fetch) name the arc: arc, heads/<arc>, refs/heads/<arc> (git qualifies a
// bare or heads/ destination as a branch: measured with git 2.50), or a glob that covers refs/heads/<arc>? Without
// regard to case, folded as APFS folds it (flag u, as REMOTE_HEAD): a loose ref refs/heads/ARC is the file of the arc.
function dstIsArc(d, base) {
  if (!d) return false;
  if (d.includes('*')) {
    const full = d.startsWith('refs/') ? d : 'refs/heads/' + d.replace(/^heads\//, '');
    return new RegExp('^' + full.split('*').map(esc).join('[^]*') + '$', 'iu').test('refs/heads/' + base);
  }
  return new RegExp('^(?:refs/)?(?:heads/)?' + esc(base) + '$', 'iu').test(d);
}
// The destination of a refspec ([+]<src>:<dst>), or '' (no colon: no ref of this repository; ^<negative>: none).
const specDst = (spec) => { const s = spec.replace(/^\+/, ''); const c = s.indexOf(':'); return s.startsWith('^') || c < 0 ? '' : s.slice(c + 1); };

// The common git directory a push or fetch repository word names when it is a local repository (., a path, file://,
// or a configured remote whose push URL is one), or ''. A URL with a scheme or host:path is another machine.
function localRepo(word, dir, home) {
  let url = word;
  if (!url) return '';
  if (/^[^./~][^/:]*$/.test(url)) { const r = spawnSync('git', ['-C', existing(dir), 'remote', 'get-url', '--push', '--', url], { encoding: 'utf8' }); if (r.status === 0) url = r.stdout.trim(); }
  if (/^file:\/\//i.test(url)) url = decodeURIComponent(url.slice(7));
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+:/.test(url)) return '';
  return common(path.resolve(dir, url.replace(/^~(?=\/|$)/, home)));
}

// Does `git <sub> <args>`, run in dir, move refs/heads/<base> of the repository whose common git directory is proj?
// assume: the repository is named by --git-dir / --work-tree / GIT_DIR / GIT_WORK_TREE (repoPaths): its current branch
// is taken to be the arc (closed, as a push with them is refused).
function movesArc(sub, args, dir, repoPaths, base, proj, home) {
  const isArc = (n) => typeof n === 'string' && new RegExp('^' + esc(base) + '$', 'iu').test(n);
  const assume = repoPaths.length > 0;
  if (sub === 'push') {
    // the repository that receives is the one named, not dir's: a push into this repository moves its branches
    const s = scanOpts('push', args);
    const del = s.longs.some((a) => longOpt(a, 'delete')) || s.shorts.includes('d');
    const targets = [];
    const repo = s.vals.find(([n]) => longOpt(n, 'repo'));
    if (repo) targets.push([repo[1], s.pos]);
    if (s.pos.length) targets.push([s.pos[0], s.pos.slice(1)]);
    return targets.some(([r, specs]) => localRepo(r, dir, home) === proj &&
      // no refspec: push.default and the upstream decide what moves (git push . from a branch whose upstream is the arc)
      (!specs.length || specs.some((x) => (del ? dstIsArc(x.replace(/^\+/, ''), base) : dstIsArc(specDst(x), base)))));
  }
  if (!(assume ? [dir, ...repoPaths] : [dir]).some((p) => common(p) === proj)) return false;
  const cur = () => assume || currentBranch(dir) === `refs/heads/${base}`;
  if (sub === 'checkout' || sub === 'switch') return isArc(forceCreated(sub, args));
  if (sub === 'worktree') return args[0] === 'add' && isArc(forceCreated(sub, args.slice(1)));
  if (sub === 'reset') return resetMoves(args, (c) => assume || spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', `${c}^{commit}`], { encoding: 'utf8' }).status === 0) && cur();
  const s = scanOpts(sub, args);
  const L = (n) => s.longs.some((a) => longOpt(a, n));
  if (sub === 'update-ref') {
    // git update-ref [-m <reason>] [--no-deref] (-d <ref> [<old>] | <ref> <new> [<old>] | --stdin [-z]) (git-update-ref(1)):
    // a ref name is taken as written (update-ref heads/<arc> or <arc> writes another file: measured), HEAD is
    // dereferenced to the current branch unless --no-deref, and --stdin takes its refs from input the hook cannot see
    if (L('stdin')) return true;
    return new RegExp('^refs/heads/' + esc(base) + '$', 'iu').test(s.pos[0] || '') || (s.pos[0] === 'HEAD' && !L('no-deref') && cur());
  }
  if (sub === 'branch') {
    // git branch -f/--force, -m/-M/--move, -c/-C/--copy, -d/-D/--delete (git-branch(1)) with the arc among the names
    // (closed: whether git itself would refuse it does not matter); -m / -M <new> alone renames the current branch
    const move = /[mM]/.test(s.shorts) || L('move');
    if (!(move || /[cCdDf]/.test(s.shorts) || L('copy') || L('delete') || L('force'))) return false;
    return s.pos.some(isArc) || (move && s.pos.length === 1 && cur());
  }
  // a fetch (or the fetch of a pull) writes the destinations of its refspecs; --stdin reads more of them from input
  const refmap = s.vals.filter(([n]) => longOpt(n, 'refmap')).map(([, x]) => x);
  if (sub === 'fetch') {
    if (L('stdin')) return true;
    const specs = L('multiple') || L('all') ? [] : s.pos.slice(1);
    return [...specs, ...refmap].some((x) => dstIsArc(specDst(x), base));
  }
  if (sub === 'pull' && [...s.pos.slice(1), ...refmap].some((x) => dstIsArc(specDst(x), base))) return true;
  // git rebase [<upstream> [<branch>]] / --root [<branch>] checks <branch> out first and rebases it
  if (sub === 'rebase' && isArc(L('root') ? s.pos[0] : s.pos[1])) return true;
  const stays = s.longs.some((a) => MOVES[sub].some((n) => longOpt(a, n)));
  return !stays && cur();
}

// The project root of a config: the parent of .claude/, else the config's own directory. A relative repoDir or
// sharedDir is relative to it, as config.js reads repoDir (branchDirOf).
const projectRoot = (cfg) => { const d = path.dirname(cfg.configPath || ''); return path.basename(d) === '.claude' ? path.dirname(d) : d; };

// -> null or the refusal of a git command that would move the arc of a live train of a project: of the config the
// session names and of the config found from each directory the command reaches (they differ when the session belongs
// to another project), in the repository of that config (train.js: git -C repoDir); another repository with a branch
// of the same name is not its arc.
function judgeTrain(sub, args, dir, repoPaths, ctx) {
  const places = [dir, ...repoPaths];
  if (sub === 'push') {
    const s = scanOpts('push', args), repo = s.vals.find(([n]) => longOpt(n, 'repo'));
    for (const r of [repo && repo[1], s.pos[0]]) { const c = r ? localRepo(r, dir, ctx.env.HOME || '') : ''; if (c) places.push(c); }
  }
  for (const cfg of ctx.trainCfgs(places)) {
    const root = projectRoot(cfg);
    const o = trainLock.arcHolder(cfg.sharedDir ? path.resolve(root, cfg.sharedDir) : '');
    if (!o || !cfg.repoDir) continue;
    const proj = common(path.resolve(root, cfg.repoDir));
    if (!proj || !movesArc(sub, args, dir, repoPaths, o.base, proj, ctx.env.HOME || '')) continue;
    return `\`git ${sub}\` is refused: train ${o.train || '?'} (pid ${o.pid}) holds the train lock and moves the arc branch ${o.base} when it is green; moving ${o.base} now ends the train arc-moved (no verdict, its passengers ride again). Wait for the train: node "${TRAIN_JS}" status (until "lock: free"). Or let the change ride as a passenger: commit it on a service branch from the head of ${o.base} and run node "${TRAIN_JS}" ride --task <svc> --branch <svc> --head <full sha> --base ${o.base} in the background.`;
  }
  return null;
}

// -> null (allowed) or a refusal reason.
function judge(words, ctx) {
  let i = 0, allow = ctx.env.ALLOW_PROTECTED_PUSH === '1';
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { if (words[i] === 'ALLOW_PROTECTED_PUSH=1') allow = true; i++; }
  if (words[i] === 'env') { i++; while (i < words.length && /=/.test(words[i])) { if (words[i] === 'ALLOW_PROTECTED_PUSH=1') allow = true; i++; } }
  if (!(words[i] === 'git' || /\/git$/.test(words[i] || ''))) return null;
  // Paths that name the repository instead of -C: assignments before git (also through env), the line's own, the hook's.
  const repoPaths = [...ctx.repoVars, ...words.slice(0, i).filter((w) => GIT_REPO_VAR.test(w)).map((w) => w.slice(w.indexOf('=') + 1))];
  i++;
  let dir = ctx.cwd, unknown = null;
  while (i < words.length && words[i].startsWith('-')) {
    const o = words[i], eq = o.indexOf('='), name = eq > 0 ? o.slice(0, eq) : o;
    if (eq > 0 ? GIT_GLOBAL.exitEq.has(name) : GIT_GLOBAL.exit.has(o)) return null;   // git runs nothing after it
    if (eq < 0 && GIT_GLOBAL.value.has(o)) {
      if (o === '--git-dir' || o === '--work-tree') repoPaths.push(words[i + 1] || '');
      if (o === '-C') dir = path.resolve(dir, words[i + 1] || '');
      i += 2;
    } else if (eq > 0 && GIT_GLOBAL.eq.has(name)) {
      if (name === '--git-dir' || name === '--work-tree') repoPaths.push(o.slice(eq + 1));
      i++;
    } else if (eq < 0 && GIT_GLOBAL.flag.has(o)) i++;
    else { unknown = o; break; }
  }
  const sub = words[i], args = words.slice(i + 1);
  if (!unknown && sub !== 'add' && sub !== 'remote' && sub !== 'symbolic-ref' && !TRAIN_SUBS.has(sub)) return null;
  // Under a live train, before anything else: ALLOW_PROTECTED_PUSH=1 does not lift it (coordinator's decision 2 for
  // p-noghost-e); a directory the hook cannot follow (cd with an expansion, owner's decision 1) is not judged here.
  if (!unknown && TRAIN_SUBS.has(sub) && !ctx.trainOff) {
    const home = ctx.env.HOME || '';
    const why = judgeTrain(sub, args, dir, repoPaths.map((p) => path.resolve(dir, p.replace(/^~(?=\/|$)/, home))), ctx);
    if (why) return why;
  }
  let cfg = ctx.cfgFor(dir);
  if (repoPaths.length) {
    // The repository git works on is not dir: take the config from any of the places the command can reach.
    const home = ctx.env.HOME || '';
    for (const p of repoPaths) if (!cfg) cfg = ctx.cfgFor(path.resolve(dir, p.replace(/^~(?=\/|$)/, home))) || ctx.cfgFor(ctx.cwd);
    if (cfg && sub === 'push' && !allow) return `\`git push\` with --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR is refused: the hook judges the branches of the repository it reads through -C; run git -C <worktree> push instead (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
  }
  if (!cfg) return null;
  if (unknown) return allow ? null : `\`git ${unknown}\` before the subcommand is refused: the hook does not know this global option of git, so it cannot tell which word is the subcommand (git fails on an option it does not know; write the git command without it, or ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
  if (sub === 'remote' || sub === 'symbolic-ref' || sub === 'update-ref') return allow ? null : judgeRemoteHead(sub, args);
  if (ARC_SUBS.has(sub) || sub === 'branch' || sub === 'fetch' || sub === 'worktree') return null;
  if (sub === 'add') {
    const blanket = args.find((a) => a === '-A' || a === '--all' || a === '--no-ignore-removal' || a === '.' || a === './' || a === ':/' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a));
    if (blanket) return `\`git add ${blanket}\` is refused: stage files by path (git add <path>...), never everything at once.`;
    return null;
  }
  if (sub !== 'push' || allow) return null;
  const tagRe = new RegExp(cfg.protectedTagPattern);
  const pos = [];
  let force = false, del = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (longOpt(a, 'force') || longOpt(a, 'force-with-lease') || longOpt(a, 'force-if-includes') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) force = true;
    if (longOpt(a, 'delete') || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) del = true;
    if (longOpt(a, 'all') || longOpt(a, 'mirror')) return `\`git push ${a}\` is refused: it pushes protected refs too. Push your branch by name.`;
    if (longOpt(a, 'tags') || longOpt(a, 'follow-tags')) return `\`git push ${a}\` is refused: tags matching ${cfg.protectedTagPattern} may deploy to production. Push a tag only on the owner's explicit word, with ALLOW_PROTECTED_PUSH=1.`;
    if (PUSH_WITH_VALUE.has(a)) { k++; continue; }
    if (a === '--') continue;
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const g = (...x) => spawnSync('git', ['-C', dir, ...x], { encoding: 'utf8' });
  const current = () => g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const refspecs = pos.slice(1);
  // [source, destination, forced, colon]; a source '' deletes the destination.
  const specs = refspecs.length ? refspecs.map((r) => {
    const s = r.replace(/^\+/, ''), c = s.indexOf(':');
    return [del ? '' : (c >= 0 ? s.slice(0, c) : s), c >= 0 ? s.slice(c + 1) : s, force || r.startsWith('+'), c >= 0];
  }) : [['HEAD', current(), force, false]];
  let st;   // the standing push of the pushing repository, looked up once on demand
  const pending = [];
  for (let [src, d, forced, colon] of specs) {
    if (d === 'HEAD' || d === '@') d = current();
    let tag = null, branch = null, knownTag = false;
    if (d.startsWith('refs/tags/')) tag = d.slice(10);
    else if (d.startsWith('refs/heads/')) branch = d.slice(11);
    else {
      // A bare name: a branch, or a tag when such a tag exists or no branch of that name does (git would push the
      // tag, or fail - refusing early is safe).
      branch = d;
      const isTag = g('show-ref', '--verify', '--quiet', 'refs/tags/' + d).status === 0;
      const isBranch = g('show-ref', '--verify', '--quiet', 'refs/heads/' + d).status === 0;
      if (isTag || !isBranch) tag = d;
      // The destination is a tag push only when the source resolves to refs/tags/ (git push origin build-1 takes
      // the name as its own source): git push origin HEAD:build-1 creates refs/heads/build-1 on the remote even
      // when a local tag build-1 exists, so it stays a branch push. A delete of a bare name is never a known tag:
      // git deletes whatever the remote holds under that name (git push origin --delete build-1 removes a remote
      // branch build-1 although a local tag build-1 exists), so only an explicit :refs/tags/<name> deletes a tag.
      const srcRef = src ? (g('rev-parse', '--symbolic-full-name', src).stdout || '').trim() : '';
      knownTag = isTag && srcRef.startsWith('refs/tags/');
      // After a colon the bare name is not the source's own: git matches it against the remote's refs first, so
      // <tag>:master updates a remote branch master (measured with git 2.50: "7b2107e..a07f5f0  master -> master").
      // Only without a colon does git push the source under its full name refs/tags/<name>.
      if (knownTag && colon && !cfg.protectedBranches) return `\`git push\` of ${src}:${d} is refused: git matches the bare name ${d} against the remote's refs and may update a branch ${d} there; protected branches unknown - ${cfg.defaultBranchUnknown}. Push a tag as ${src}:refs/tags/${d} (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
    }
    // The refspec ":" (or "+:") is a matching push: its destination is empty, yet git pushes every branch present on
    // both sides under the same name, the default branch too. While the branches are unknown it is a branch push.
    if (d === '' && !cfg.protectedBranches) return `\`git push\` of the matching refspec ":" is refused: it pushes every matching branch and protected branches unknown - ${cfg.defaultBranchUnknown} (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
    if (branch && !knownTag && !cfg.protectedBranches) return `\`git push\` of ${branch} is refused: protected branches unknown - ${cfg.defaultBranchUnknown} (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
    // Unknown branches refuse every branch push above; a known tag gets past it and is judged as a tag below, so here
    // no branch counts as protected (a crash would exit 1, which Claude Code treats as non-blocking: fail open).
    const protectedBranches = cfg.protectedBranches || [];
    if (branch && protectedBranches.includes(branch) && tag === null) {
      if (st === undefined) st = standingPush.standing(dir);
      if (st && st.branches.includes(branch)) {
        if (forced || !src) return `\`git push\` to ${branch} is refused: a standing push never forces or deletes (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
        if (standingPush.sha(st, src) !== st.head) return `\`git push\` to ${branch} is refused: a standing push sends only the checked-out HEAD, and ${src} is not HEAD.`;
        pending.push(branch);
        continue;
      }
    }
    if (branch && protectedBranches.includes(branch)) return `\`git push\` to ${branch} is refused: ${branch} is protected. Work on a branch; pushing or merging into ${branch} is the owner's call (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
    if (tag !== null && tagRe.test(tag)) return `\`git push\` of tag ${tag} is refused: it may deploy to production (ALLOW_PROTECTED_PUSH=1 only on the owner's explicit word).`;
  }
  return pending.length ? standingPush.verify(st) : null;
}

// ---- the directory of each command: cd / pushd / popd in the line (owner's decision 1 for p-noghost-e) ----
// Claude Code gives the hook the cwd before the line runs; a literal cd, pushd or popd in it moves the directory the
// commands after it run in. The hook follows them: a state is {dir, old (cd -), stack (pushd), unknown}; a cd with an
// expansion ($, backquote, a glob, ~user, pushd +N, popd past the line's own pushd) makes the directory unknown, and
// the refusal under a train is then not judged (open, README "Known gaps"; the other refusals keep the last known
// directory, as before). Where the shells differ, every directory one of them can be in is judged: bash runs the last
// element of a pipeline in a subshell, zsh in the shell; a cd that fails (no such directory) leaves the directory.
const CD_PREFIX = new Set(['{', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', 'time', 'builtin', 'command', 'nocorrect', 'noglob']);
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// The directory a literal cd / pushd argument names from st, or null when the hook cannot tell (an expansion).
function cdTarget(arg, st, env) {
  if (/[$`*?[{]/.test(arg) || (arg.startsWith('~') && !/^~(\/|$)/.test(arg))) return null;
  if (arg.startsWith('~')) return env.HOME ? path.join(env.HOME, arg.slice(1)) : null;
  if (path.isAbsolute(arg)) return path.resolve(arg);
  // CDPATH (bash, zsh): a name that does not start with / . or .. is looked up there first
  if (env.CDPATH && !/^\.\.?(\/|$)/.test(arg)) {
    for (const e of env.CDPATH.split(':')) { const c = path.resolve(st.dir, e || '.', arg); if (isDir(c)) return c; }
  }
  return path.resolve(st.dir, arg);
}
// The states after a cd / pushd / popd command (words without its prefix), or null when it is none of them.
function cdStates(words, st, env) {
  let i = 0;
  while (i < words.length && (CD_PREFIX.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  const cmd = words[i];
  if (cmd !== 'cd' && cmd !== 'pushd' && cmd !== 'popd' && cmd !== 'chdir') return null;
  const args = [];
  for (let k = i + 1; k < words.length; k++) {
    const a = words[k];
    if (/^\d*(>>?|<|>&|<&|&>>?|>\|)$/.test(a)) { k++; continue; }   // a redirection and its target word
    if (/^\d*[<>]/.test(a) || /^&>/.test(a)) continue;
    args.push(a);
  }
  const unknown = Object.assign({}, st, { unknown: true });
  let k = 0;
  while (k < args.length && /^-[LPe@]+$/.test(args[k])) k++;
  if (args[k] === '--') k++;
  const rest = args.slice(k);
  const go = (to, extra) => {
    if (to === null) return [unknown];
    if (!isDir(to)) return [st];
    return [Object.assign({}, st, { dir: to, old: st.dir, unknown: false }, extra || {})];
  };
  if (cmd === 'popd') {
    if (rest.length || !st.stack.length) return [unknown];
    return go(st.stack[st.stack.length - 1], { stack: st.stack.slice(0, -1) });
  }
  if (rest.length > 1 || (rest.length && /^[+-]\d+$|^-n$/.test(rest[0]))) return [unknown];
  if (cmd === 'pushd') {
    if (!rest.length || st.unknown) return [unknown];
    return go(cdTarget(rest[0], st, env), { stack: st.stack.concat([st.dir]) });
  }
  if (!rest.length) return go(env.HOME || null);
  if (rest[0] === '-') return st.old ? go(st.old) : [unknown];
  if (st.unknown && !path.isAbsolute(rest[0]) && !rest[0].startsWith('~')) return [unknown];
  return go(cdTarget(rest[0], st, env));
}

// -> [[words, states]...]: each simple command with the directories it can run in.
function judgeDirs(seq, cwd, env) {
  let states = [{ dir: cwd, old: null, stack: [], unknown: false }];
  const parens = [];
  const out = [];
  const opsAfter = (k) => {
    // the operators that end the command k for the shell: a redirection (R) does not end it
    let m = k + 1;
    while (m < seq.length && seq[m].ops.every((o) => o === 'R')) m++;
    return m < seq.length ? seq[m].ops : seq.tail;
  };
  const key = (s) => `${s.unknown ? '?' : ''}${s.dir}|${s.old}|${s.stack.join(':')}`;
  const uniq = (list) => { const m = new Map(); for (const s of list) m.set(key(s), s); return [...m.values()]; };
  for (let k = 0; k < seq.length; k++) {
    const { words, ops } = seq[k];
    for (const o of ops) {
      if (o === '(') parens.push(states);
      else if (o === ')' && parens.length) states = parens.pop();
    }
    out.push([words, states]);
    const after = opsAfter(k);
    const piped = ops.some((o) => o === '|' || o === '|&');
    if (after.some((o) => o === '|' || o === '|&' || o === '&')) continue;   // a pipeline element before the last, a background job: a subshell
    const next = [];
    let isCd = false;
    for (const st of states) {
      const n = cdStates(words, st, env);
      if (!n) { next.push(st); continue; }
      isCd = true;
      next.push(...n);
      if (piped) next.push(st);   // the last element of a pipeline: zsh runs it in the shell, bash in a subshell
    }
    if (isCd) states = uniq(next);
  }
  return out;
}

function decide(input, env = process.env) {
  if (!input || input.tool_name !== 'Bash' || !input.tool_input || typeof input.tool_input.command !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  const cache = new Map(), dirCache = new Map();
  // GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR assigned anywhere in the line (export GIT_DIR=...; git ...) or set in the
  // hook's environment reach every git command after it.
  const seq = parseSeq(input.tool_input.command);
  const all = seq.map((c) => c.words);
  const repoVars = [].concat(...all).filter((w) => GIT_REPO_VAR.test(w)).map((w) => w.slice(w.indexOf('=') + 1))
    .concat(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].filter((k) => env[k]).map((k) => env[k]));
  const loadAt = (c, dir, e) => {
    if (!c.has(dir)) {
      let file = null;
      try { file = find(dir, e); } catch { /* no config */ }
      // The branches come from the repository that pushes (dir), not from the session's project.
      c.set(dir, file ? load(file, { branchDir: dir }).config : null);
    }
    return c.get(dir);
  };
  const cfgFor = (dir) => loadAt(cache, dir, env);
  // The config found from the directory alone (config.js find without the session's CODIS_AGENTS_CONFIG and
  // CLAUDE_PROJECT_DIR): a session of another project still meets the train of the project it works in (C11).
  const dirCfgFor = (dir) => loadAt(dirCache, dir, {});
  const trainCfgs = (places) => {
    const m = new Map();
    for (const p of places) for (const c of [cfgFor(p), dirCfgFor(p)]) if (c && !m.has(c.configPath)) m.set(c.configPath, c);
    return [...m.values()];
  };
  for (const [words, states] of judgeDirs(seq, cwd, env)) {
    for (const st of states) {
      const why = judge(words, { cwd: st.dir, trainOff: st.unknown, env, cfgFor, trainCfgs, repoVars });
      if (why) return why;
    }
  }
  return null;
}

module.exports = { parse, parseSeq, decide, GIT_GLOBAL };

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input = null;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const why = decide(input);
    if (why) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'codis-agents: ' + why } }));
    }
    process.exit(0);
  });
}
