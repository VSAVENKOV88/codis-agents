'use strict';
// The runner's half of scripts/corpus-sync.js. corpus-sync.js sends this file over ssh to `node -` with one call
// appended (the operation and its input as a JSON literal), so the ssh command line is always the same two words and
// no path or name ever passes through the runner's shell; on the runner it also runs as
//   node corpus-remote.js <op> '<json input>'
// Layout under root (the machine key remote.root; ~/ is the runner's home):
//   corpus/               the donor: the project's corpus at the paths of a worktree; never a worktree, no run in it
//   corpus.state          {state: "incomplete" | "complete", id, at}: written "incomplete" before any change of the
//                         donor and "complete" only after the donor's own scan matched - an rsync cut off, a killed
//                         sync or a lost connection leave it "incomplete", and a run's copy is refused then
//   corpus.manifest.json  the manifest of what the donor holds (its scan), written with "complete"
//   wt/<name>/            the copy of a run: a real copy (cp --reflink=auto, a plain copy on ext4), never a link -
//                         guards write into their corpus (orphan cleanup, freeze), the donor must not change
// Output: messages on stderr, the result as the last stdout line `CORPUS-RESULT <json>`. Exit 0 done; 64 bad input;
// 65 refused (the wipe token does not match the list); 69 environment (no or incomplete donor, low disk, a link where
// a directory must be).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const GB = 1024 ** 3;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const env = (msg) => new Stop(69, `environment: ${msg}`);

function sha256File(file) {
  const h = crypto.createHash('sha256'), buf = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(file, 'r');
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
// The id of a manifest: its paths, sizes and hashes (mtime is shown, not compared: a copy may carry another mtime).
const manifestId = (files) => crypto.createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.size, f.sha256]))).digest('hex').slice(0, 16);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function roots(input) {
  const r = String(input.root || '');
  const base = r.startsWith('~/') ? path.join(os.homedir(), r.slice(2)) : r;
  if (!path.isAbsolute(base) || r.split('/').includes('..') || path.resolve(base) === path.resolve(os.homedir()) || path.resolve(base) === '/') throw new Stop(64, `bad root ${JSON.stringify(r)}`);
  return { root: base, donor: path.join(base, 'corpus'), state: path.join(base, 'corpus.state'), manifest: path.join(base, 'corpus.manifest.json'), wt: path.join(base, 'wt') };
}
// A directory the scripts write into must be a directory, never a link to somewhere else.
function notLink(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink() || !st.isDirectory()) throw env(`${p} is not a directory (a link or a file) - refused`);
}
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJSON(f, v) { const t = `${f}.tmp-${process.pid}`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); }

// Every regular file of the donor with size, mtime and hash; links and other types are not followed (none should be).
function scanDonor(R) {
  notLink(R.root); notLink(R.donor);
  const files = [];
  if (!fs.existsSync(R.donor)) return { files, id: manifestId(files), bytes: 0 };
  (function walk(rel) {
    for (const n of fs.readdirSync(path.join(R.donor, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n, p = path.join(R.donor, r), st = fs.lstatSync(p);
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.push({ path: r, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256File(p) });
    }
  })('');
  files.sort(byPath);
  return { files, id: manifestId(files), bytes: files.reduce((s, f) => s + f.size, 0) };
}

function sizeOf(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let s = 0;
  for (const n of fs.readdirSync(p)) s += sizeOf(path.join(p, n));
  return s;
}
// What a wipe removes: the donor, its state and manifest, and every run copy under wt/ - nothing else under root.
function wipeList(R) {
  const list = [];
  for (const p of [R.donor, R.state, R.manifest]) if (fs.existsSync(p) || isLink(p)) list.push({ path: p, bytes: sizeOf(p) });
  if (fs.existsSync(R.wt)) { notLink(R.wt); for (const n of fs.readdirSync(R.wt).sort()) list.push({ path: path.join(R.wt, n), bytes: sizeOf(path.join(R.wt, n)) }); }
  const token = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16);
  return { list, token };
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

// The free-disk floor of the runner: minFreeDiskGB of its own machine file, else the plugin default (10).
function minFreeGB() {
  const x = process.env.XDG_CONFIG_HOME;
  const f = process.env.CODIS_AGENTS_MACHINE || path.join(x && path.isAbsolute(x) ? x : path.join(os.homedir(), '.config'), 'codis-agents', 'machine.json');
  const m = readJSON(f);
  return m && typeof m.minFreeDiskGB === 'number' && m.minFreeDiskGB >= 0 ? m.minFreeDiskGB : 10;
}

const OPS = {
  state(R) { return { state: readJSON(R.state) }; },
  scan(R) { return scanDonor(R); },
  begin(R, input) {
    notLink(R.root); fs.mkdirSync(R.root, { recursive: true }); notLink(R.donor); fs.mkdirSync(R.donor, { recursive: true });
    writeJSON(R.state, { state: 'incomplete', target: String(input.id || ''), at: new Date().toISOString() });
    return { state: 'incomplete' };
  },
  // Removes files of the donor that the source no longer has: each path relative, inside the donor, never through a
  // link; then the directories left empty.
  delete(R, input) {
    notLink(R.donor);
    const paths = Array.isArray(input.paths) ? input.paths : [];
    for (const p of paths) {
      if (typeof p !== 'string' || !p || p.includes('\0') || path.isAbsolute(p) || p.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Stop(64, `bad path to delete ${JSON.stringify(p)}`);
    }
    let removed = 0;
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) if (isLink(path.join(R.donor, ...parts.slice(0, i)))) throw env(`a link inside the donor at ${parts.slice(0, i).join('/')} - refused`);
      const f = path.join(R.donor, ...parts);
      let st = null;
      try { st = fs.lstatSync(f); } catch { continue; }
      if (st.isDirectory()) continue;
      fs.unlinkSync(f); removed++;
      for (let d = path.dirname(f); d !== R.donor && d.startsWith(R.donor + path.sep); d = path.dirname(d)) {
        try { fs.rmdirSync(d); } catch { break; }
      }
    }
    return { removed };
  },
  // The donor's own scan decides: equal to the expected manifest (or accept: the source moved during the sync, the
  // donor is described as it is) - manifest and "complete"; otherwise it stays "incomplete".
  finish(R, input) {
    const s = scanDonor(R);
    if (!input.accept && s.id !== input.expectId) throw env(`the donor (manifest ${s.id}) does not match the source (manifest ${input.expectId}) after the sync - donor marked incomplete`);
    writeJSON(R.manifest, { version: 1, id: s.id, files: s.files, at: new Date().toISOString() });
    writeJSON(R.state, { state: 'complete', id: s.id, at: new Date().toISOString() });
    return { id: s.id, files: s.files.length, bytes: s.bytes };
  },
  status(R) {
    const st = readJSON(R.state), s = scanDonor(R);
    return { state: st ? st.state : null, id: st ? st.id || null : null, scanId: s.id, files: s.files.length, bytes: s.bytes, matches: !!st && st.state === 'complete' && st.id === s.id };
  },
  // A run's own copy of the donor at wt/<name>, at the worktree paths.
  copy(R, input) {
    const name = String(input.name || '');
    if (!NAME.test(name)) throw new Stop(64, `bad run name ${JSON.stringify(name)}`);
    const st = readJSON(R.state), mf = readJSON(R.manifest);
    if (!st || st.state !== 'complete' || !mf || mf.id !== st.id) throw env(`the donor is ${st ? st.state || 'unknown' : 'missing'} (${R.donor}) - run corpus-sync.js sync first; no copy made`);
    notLink(R.root); notLink(R.donor); notLink(R.wt);
    const bytes = mf.files.reduce((s, f) => s + f.size, 0);
    fs.mkdirSync(R.wt, { recursive: true });
    const sfs = fs.statfsSync(R.wt), free = sfs.bavail * sfs.bsize, floor = minFreeGB();
    const r1 = (b) => Math.round((b / GB) * 10) / 10;
    if (free < bytes + floor * GB) throw env(`not enough disk for the copy: ${r1(free)} GB free on ${R.wt}, the copy needs ${r1(bytes)} GB plus the floor of ${floor} GB (minFreeDiskGB) - no copy made`);
    const target = path.join(R.wt, name);
    notLink(target); fs.mkdirSync(target, { recursive: true });
    const t0 = process.hrtime.bigint();
    // A reflink where the file system has one, a plain copy otherwise (GNU cp); without GNU cp, a plain cp -pR.
    let r = spawnSync('cp', ['-a', '--reflink=auto', `${R.donor}/.`, `${target}/`], { encoding: 'utf8' });
    if (r.status !== 0) r = spawnSync('cp', ['-pR', `${R.donor}/.`, `${target}/`], { encoding: 'utf8' });
    if (r.status !== 0) throw env(`cp failed: ${(r.stderr || '').trim().split('\n').pop()}`);
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    return { target, files: mf.files.length, bytes, seconds: Math.round(seconds * 100) / 100, id: mf.id };
  },
  'wipe-list'(R) { return wipeList(R); },
  wipe(R, input) {
    const w = wipeList(R);
    if (input.token !== w.token) throw new Stop(65, `refused: the list changed since wipe-list (token ${w.token}, given ${input.token}) - run wipe-list again and check it`);
    for (const e of w.list) fs.rmSync(e.path, { recursive: true, force: true });
    return { removed: w.list };
  },
};

function cli(op, input) {
  let res, code = 0;
  try {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Stop(64, `unknown operation ${JSON.stringify(op)}`);
    res = OPS[op](roots(input || {}), input || {});
  } catch (e) {
    code = e instanceof Stop ? e.code : 69;
    process.stderr.write(`${e instanceof Stop ? e.message : 'environment: ' + (e && e.message || e)}\n`);
    res = { error: e && e.message };
  }
  process.stdout.write(`CORPUS-RESULT ${JSON.stringify(res)}\n`);
  process.exitCode = code;
}

module.exports = { cli, sha256File, manifestId, byPath, OPS };

if (require.main === module && process.argv[2]) {
  let input;
  try { input = JSON.parse(process.argv[3] || '{}'); } catch { console.error('usage: corpus-remote.js <op> <json input>'); process.exit(64); }
  cli(process.argv[2], input);
}
