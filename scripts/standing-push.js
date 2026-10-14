'use strict';
// Standing push: a repository may declare, in its own committed .claude/codis-agents.json, key "standingPush"
// {branches, check}, that its HEAD may be pushed to those branches without ALLOW_PROTECTED_PUSH=1. Meant only for the
// repository of process rules (the plugin itself), whose owner granted a standing permission to push rule changes.
// Narrow on purpose:
//  * read from HEAD of the repository that pushes (its git root), never from the session's project or the working tree
//    - a config in another repository, or an uncommitted edit, grants nothing;
//  * only the checked-out HEAD, only to a listed branch, no force, no deletion; tags are never covered;
//  * tracked files must be unmodified (so the check sees what is pushed), and `check` (a shell command run in the
//    repository root, e.g. the hygiene test for secrets and personal paths) must exit 0.
// Used by the PreToolUse hook (scripts/hooks/guard-bash.js) and the git pre-push hook.
const { spawnSync } = require('child_process');

const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

// -> { root, branches, check, head } or null when the repository at `dir` declares no standing push.
function standing(dir) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const blob = git(root, 'show', 'HEAD:.claude/codis-agents.json');
  if (blob.status !== 0) return null;
  let sp;
  try { sp = JSON.parse(blob.stdout).standingPush; } catch { return null; }
  if (!sp || typeof sp !== 'object' || !Array.isArray(sp.branches) || !sp.branches.length
    || !sp.branches.every((b) => typeof b === 'string' && b) || typeof sp.check !== 'string' || !sp.check.trim()) return null;
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  return { root, branches: sp.branches, check: sp.check, head };
}

// The commit `src` names in that repository, or null.
function sha(st, src) {
  const r = git(st.root, 'rev-parse', '--verify', '--quiet', src + '^{commit}');
  return r.status === 0 ? r.stdout.trim() : null;
}

// -> null when the push may go, else the reason. Runs the check once.
function verify(st) {
  const dirty = git(st.root, 'status', '--porcelain', '--untracked-files=no');
  if (dirty.status !== 0 || dirty.stdout.trim()) return `standing push refused: uncommitted changes to tracked files in ${st.root} (the check must see what is pushed).`;
  const r = spawnSync('sh', ['-c', st.check], { cwd: st.root, encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0) {
    const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter((l) => /FAIL|rror/.test(l)).slice(0, 5).join('; ');
    return `standing push refused: check \`${st.check}\` failed (exit ${r.status})${tail ? ': ' + tail : ''}.`;
  }
  return null;
}

module.exports = { standing, sha, verify };
