'use strict';
// The places a role on the codex host writes, in one function for every consumer (p-codex A2a-3a, cell S4): the argv of
// prog and test (scripts/role-exec.js), the check of commit.stateDir (role-exec.js createAgent), the write roots of the
// profile of a commit check and the refusal of a hooks folder in the role's reach (scripts/commit-service.js). A root
// added or dropped here changes all of them at once.
const fs = require('fs');
const path = require('path');

// The real path of the longest existing prefix plus the rest: a folder that does not exist yet compares like the real
// one. realpathSync.native, because the JS realpathSync keeps the case it was given: on a case-insensitive disk two
// spellings of one folder would compare as two folders.
const realish = (p) => {
  const abs = path.resolve(p);
  let head = abs, rest = '';
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), rest); } catch { /* go up */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    rest = path.join(path.basename(head), rest);
    head = up;
  }
};
const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
// The part of a path that does not exist yet has no name on disk to compare, and a disk may ignore case and the form of
// Unicode, so both are ignored: on a case-sensitive disk two folders that differ only so count as one, which errs
// towards a refusal, while a missed match would put a folder in a role's reach.
const foldName = (p) => p.normalize('NFC').toLowerCase();
// a lies in b (or is b), compared by folded names
const within = (a, b) => inside(foldName(a), foldName(b));
// Two real paths where one lies in the other.
const overlap = (a, b) => within(a, b) || within(b, a);

// {wt, tdir?, tmpdir?} -> the places of a prog/test role on codex, all real paths:
// - cwd: the workspace root of the legacy workspace-write sandbox (codex -C), the worktree;
// - extra: sandbox_workspace_write.writable_roots, the task folder (reports, the call folder, its npm cache);
// - check: the write roots of the profile of a commit check (the worktree and the task folder; the npm cache adds none);
// - reach: every folder the role can write - those two plus /tmp and the role's TMPDIR, which the codex sandbox opens to
//   every command;
// - readOnly: <wt>/.git and <wt>/.codex, which the sandbox keeps read only under a writable root.
function roleRoots(o) {
  const wt = realish(o.wt);
  const dir = typeof o.tdir === 'string' && o.tdir ? [realish(o.tdir)] : [];
  const tmp = ['/tmp'].concat(typeof o.tmpdir === 'string' && o.tmpdir ? [o.tmpdir] : []).map(realish);
  return { cwd: wt, extra: dir, check: [wt].concat(dir), reach: [wt].concat(dir, tmp), readOnly: [path.join(wt, '.git'), path.join(wt, '.codex')] };
}

// The first place of `reach` that holds p (by its real path), or null; p under a read-only place of the worktree counts
// as outside.
function placeOf(p, r) {
  const x = realish(p);
  if (r.readOnly.some((d) => within(x, d))) return null;
  return r.reach.find((d) => within(x, d)) || null;
}

module.exports = { realish, inside, within, overlap, roleRoots, placeOf };
