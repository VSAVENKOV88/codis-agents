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
// git takes any unique prefix of a long option (gitcli(7)): --del is --delete. A word that is a prefix of a long option
// the hook judges counts as that option; an ambiguous prefix makes git fail, so judging it so is safe.
// Active only in projects that have .claude/codis-agents.json: the plugin is opt-in per project.
// The git pre-push hook (scripts/git-hooks/pre-push) is the last line; this hook explains the refusal to the agent
// before anything runs.
const path = require('path');
const { spawnSync } = require('child_process');
const { find, load } = require(path.join(__dirname, '..', 'config.js'));
const standingPush = require(path.join(__dirname, '..', 'standing-push.js'));

// Splits a command line into simple commands (on && || ; | & and newlines) and words, honouring quotes.
function parse(line) {
  const cmds = [];
  let words = [], w = null, i = 0;
  const end = () => { if (w !== null) { words.push(w); w = null; } };
  const cut = () => { end(); if (words.length) cmds.push(words); words = []; };
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") { const j = line.indexOf("'", i + 1); w = (w || '') + line.slice(i + 1, j < 0 ? line.length : j); i = j < 0 ? line.length : j + 1; continue; }
    if (ch === '"') {
      let j = i + 1, s = '';
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && j + 1 < line.length) j++; s += line[j]; j++; }
      w = (w || '') + s; i = j + 1; continue;
    }
    if (ch === '\\' && i + 1 < line.length) { w = (w || '') + line[i + 1]; i += 2; continue; }
    if (/[;&|\n()]/.test(ch)) { cut(); i++; continue; }
    if (/\s/.test(ch)) { end(); i++; continue; }
    w = (w || '') + ch; i++;
  }
  cut();
  return cmds;
}

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
  if (!unknown && sub !== 'add' && sub !== 'push' && sub !== 'remote' && sub !== 'symbolic-ref' && sub !== 'update-ref') return null;
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

function decide(input, env = process.env) {
  if (!input || input.tool_name !== 'Bash' || !input.tool_input || typeof input.tool_input.command !== 'string') return null;
  const cwd = input.cwd || process.cwd();
  const cache = new Map();
  // GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR assigned anywhere in the line (export GIT_DIR=...; git ...) or set in the
  // hook's environment reach every git command after it.
  const all = parse(input.tool_input.command);
  const repoVars = [].concat(...all).filter((w) => GIT_REPO_VAR.test(w)).map((w) => w.slice(w.indexOf('=') + 1))
    .concat(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].filter((k) => env[k]).map((k) => env[k]));
  const cfgFor = (dir) => {
    if (!cache.has(dir)) {
      let file = null;
      try { file = find(dir, env); } catch { /* no config */ }
      // The branches come from the repository that pushes (dir), not from the session's project.
      cache.set(dir, file ? load(file, { branchDir: dir }).config : null);
    }
    return cache.get(dir);
  };
  for (const words of all) {
    const why = judge(words, { cwd, env, cfgFor, repoVars });
    if (why) return why;
  }
  return null;
}

module.exports = { parse, decide, GIT_GLOBAL };

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
