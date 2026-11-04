'use strict';
// The lock of the train dispatcher as its readers see it: scripts/train.js (the dispatcher) and the session hook
// scripts/hooks/guard-bash.js (a commit or a reset of the arc branch under a live train is refused). One module, so
// both use one rule of "alive" (train.js cannot be required: it runs its main() on load).
//   <sharedDir>/train/lock/owner.json   {pid, child, pgid, train, base, wt, since, by?}: base is the arc branch the train
//   moves (by: 'watch' when the coordinator's train.js watch took the lock); the dispatcher writes it as soon as it has chosen the arc, before it reads the arc head.
// A holder whose pid, child and process group (any process of it, unless it is the reader's own group) are all gone is
// dead. The guard run of a dispatcher is not detached, so it stays in the dispatcher's group: when the dispatcher and
// its zsh are killed, an orphaned guard worker still holds the lock. A group that is the reader's own is no evidence: a
// waiter started from the same shell job (a test, one terminal) shares it with the dead holder, and it would never let go.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const lockDir = (sharedDir) => path.join(sharedDir, 'train', 'lock');
const ownerFile = (lock) => path.join(lock, 'owner.json');
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The process group of a pid (ps -o pgid=; node has no getpgid), or 0.
const pgidOf = (pid) => { const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }); const n = Number((r.stdout || '').trim()); return Number.isInteger(n) && n > 1 ? n : 0; };
// The reader's own group, asked once and only when needed (the hook runs on every Bash call).
let own;
const ownPgid = () => (own === undefined ? (own = pgidOf(process.pid)) : own);
const groupAlive = (g) => { if (!Number.isInteger(g) || g <= 1 || g === ownPgid()) return false; try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const holderAlive = (o) => !!o && (alive(o.pid) || alive(o.child) || groupAlive(o.pgid));

// The live holder of the train lock under sharedDir that names its arc ({..., base}), or null: no lock, no owner file
// or a broken one, no base yet (the arc head is read after base is written, so a move before it does not hurt the
// train), or a dead holder.
function arcHolder(sharedDir) {
  if (typeof sharedDir !== 'string' || !sharedDir) return null;
  const o = readJ(ownerFile(lockDir(sharedDir)));
  return o && typeof o.base === 'string' && o.base && holderAlive(o) ? o : null;
}

module.exports = { lockDir, ownerFile, alive, pgidOf, ownPgid, groupAlive, holderAlive, arcHolder };
