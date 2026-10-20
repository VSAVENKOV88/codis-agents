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

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--signed']);

// -> null (allowed) or a refusal reason.
function judge(words, ctx) {
  let i = 0, allow = ctx.env.ALLOW_PROTECTED_PUSH === '1';
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { if (words[i] === 'ALLOW_PROTECTED_PUSH=1') allow = true; i++; }
  if (words[i] === 'env') { i++; while (i < words.length && /=/.test(words[i])) { if (words[i] === 'ALLOW_PROTECTED_PUSH=1') allow = true; i++; } }
  if (!(words[i] === 'git' || /\/git$/.test(words[i] || ''))) return null;
  i++;
  let dir = ctx.cwd;
  while (i < words.length && words[i].startsWith('-')) {
    const o = words[i];
    if (GIT_GLOBAL_WITH_VALUE.has(o)) { if (o === '-C') dir = path.resolve(dir, words[i + 1] || ''); i += 2; } else i++;
  }
  const sub = words[i], args = words.slice(i + 1);
  if (sub !== 'add' && sub !== 'push') return null;
  const cfg = ctx.cfgFor(dir);
  if (!cfg) return null;
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
    if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) force = true;
    if (a === '--delete' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) del = true;
    if (a === '--all' || a === '--mirror') return `\`git push ${a}\` is refused: it pushes protected refs too. Push your branch by name.`;
    if (a === '--tags' || a === '--follow-tags') return `\`git push ${a}\` is refused: tags matching ${cfg.protectedTagPattern} may deploy to production. Push a tag only on the owner's explicit word, with ALLOW_PROTECTED_PUSH=1.`;
    if (PUSH_WITH_VALUE.has(a)) { k++; continue; }
    if (a === '--') continue;
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const g = (...x) => spawnSync('git', ['-C', dir, ...x], { encoding: 'utf8' });
  const current = () => g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const refspecs = pos.slice(1);
  // [source, destination, forced]; a source '' deletes the destination.
  const specs = refspecs.length ? refspecs.map((r) => {
    const s = r.replace(/^\+/, ''), c = s.indexOf(':');
    return [del ? '' : (c >= 0 ? s.slice(0, c) : s), c >= 0 ? s.slice(c + 1) : s, force || r.startsWith('+')];
  }) : [['HEAD', current(), force]];
  let st;   // the standing push of the pushing repository, looked up once on demand
  const pending = [];
  for (let [src, d, forced] of specs) {
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
      // The destination is a tag push only when the source is that tag (no source given, a delete, or a source that
      // resolves to refs/tags/): git push origin HEAD:build-1 creates refs/heads/build-1 on the remote even when a
      // local tag build-1 exists, so it stays a branch push.
      const srcRef = !src ? 'refs/tags/' + d
        : (g('rev-parse', '--symbolic-full-name', src).stdout || '').trim();
      knownTag = isTag && srcRef.startsWith('refs/tags/');
    }
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
  const cfgFor = (dir) => {
    if (!cache.has(dir)) {
      let file = null;
      try { file = find(dir, env); } catch { /* no config */ }
      // The branches come from the repository that pushes (dir), not from the session's project.
      cache.set(dir, file ? load(file, { branchDir: dir }).config : null);
    }
    return cache.get(dir);
  };
  for (const words of parse(input.tool_input.command)) {
    const why = judge(words, { cwd, env, cfgFor });
    if (why) return why;
  }
  return null;
}

module.exports = { parse, decide };

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
