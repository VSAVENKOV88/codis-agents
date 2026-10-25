#!/usr/bin/env node
'use strict';
// The corpus of a project on the remote runner of this machine: one way only, from the main checkout here (repoDir) to
// a donor directory on the runner, and from the donor a copy per run. Nothing ever comes back.
// The corpus is the git-ignored data under worktreeSetup.scan, as scripts/wt-setup.sh copies it into a worktree, minus
// what never leaves this machine or is installed on the runner anew:
//   - .env* named by git as an ignored entry (where a project keeps its secrets) - left out by this rule; a .env* found
//     inside ignored data is not expected there and stops the sync before any transfer (exit 65, the files named): the
//     check runs on the ready file list itself, not only on the rule that builds it;
//   - sessions/ at any depth (users' sessions), node_modules, dist and .deps (installed on the runner), the "skip" and
//     "link" globs of worktreeSetup, and every symbolic link (neither the link nor what it points to: the walk never
//     follows one, and rsync gets only regular files, without -L).
// The main checkout is only read: git status runs with --no-optional-locks (no index refresh is written) and files are
// opened for reading; the manifest goes to <sharedDir>/corpus-manifest.json.
// The runner comes from the machine file (scripts/config.js, key remote {host, user, key, knownHosts, root}). ssh and
// the rsync transport always use only that key and only that known_hosts file, with strict host key checking and no
// ssh config file; a host key that does not match is never accepted. Without the key nothing is contacted (exit 78).
// usage: corpus-sync.js manifest         the manifest of the source, written to sharedDir (no runner needed)
//        corpus-sync.js sync             manifest -> checks -> rsync of the delta into <root>/corpus, deletions inside
//                                        the donor only; "corpus up to date <id>" when the donor already has it
//        corpus-sync.js status           the donor's state, its recorded manifest and its own scan (JSON)
//        corpus-sync.js copy <name>      a run's own copy of the donor at <root>/wt/<name> (time and size printed)
//        corpus-sync.js wipe-list        what a wipe would remove, with sizes, and the token of that list
//        corpus-sync.js wipe --confirm <token>   removes exactly that list (the owner's "yes" to it comes first)
// Exit: 0 done; 64 usage; 65 refused (a .env* or sessions/ in the file list, a wipe token of another list);
// 69 environment (repoDir unreachable, no corpus in it, the runner unreachable, rsync cut off, donor incomplete, low
// disk) - the first line of such a message is "environment: <reason>"; 78 no or broken machine key remote.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./config');
const { sha256File, manifestId, byPath } = require('./corpus-remote');

class Stop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const env = (msg) => new Stop(69, `environment: ${msg}`);
const say = (s) => process.stdout.write(s + '\n');

// A glob of worktreeSetup as wt-setup.sh matches it ([[ $p == ${~g} ]] in zsh): * and ? cross "/", [..] a class.
function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') s += '.*';
    else if (ch === '?') s += '.';
    else if (ch === '[') { const j = g.indexOf(']', i + 1); if (j > i) { s += '[' + g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } else s += '\\['; }
    else s += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + s + '$');
}
const SECRET = /^\.env/i;
const DEPS = new Set(['node_modules', 'dist', '.deps']);
// Why a path never goes to the runner, or null. top: the path is an entry git named itself (git status --ignored).
function excludedWhy(rel, isDir, globs, top) {
  const parts = rel.split('/'), base = parts[parts.length - 1];
  if (parts.includes('sessions')) return 'sessions';
  if (parts.some((p) => DEPS.has(p))) return 'dependencies';
  if (globs.skip.some((re) => re.test(rel))) return 'skip';
  if (globs.link.some((re) => re.test(rel))) return 'link';
  if (top && SECRET.test(base)) return 'secret';
  return null;
}

function loadConfig() {
  const file = C.find();
  if (!file) throw new Stop(78, 'corpus-sync.js: no project config found (set CODIS_AGENTS_CONFIG)');
  const r = C.load(file);
  if (r.errors.length) throw new Stop(78, r.errors.map((e) => 'codis-agents config: ' + e).join('\n'));
  if (!r.config.worktreeSetup.scan.length) throw new Stop(78, 'corpus-sync.js: worktreeSetup.scan is empty - the project has no corpus to describe');
  return r.config;
}
function loadRemote() {
  const m = C.loadMachine();
  if (m.errors.length) throw new Stop(78, m.errors.map((e) => 'codis-agents machine file: ' + e).join('\n'));
  if (!m.values.remote) throw new Stop(78, `corpus-sync.js: no key remote in the machine file ${m.path} - no runner to sync to; nothing done`);
  return m.values.remote;
}

// ---- the manifest of the source (read only)
function manifest(c) {
  const repo = c.repoDir;
  let st = null;
  try { st = fs.statSync(repo); } catch { /* below */ }
  if (!st || !st.isDirectory()) throw env(`repoDir ${repo} is not reachable - no corpus to describe`);
  const g = spawnSync('git', ['--no-optional-locks', '-C', repo, '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--ignored', '--', ...c.worktreeSetup.scan], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (g.status !== 0) throw env(`git status in repoDir ${repo} failed: ${(g.stderr || '').trim().split('\n').pop()}`);
  const globs = { skip: c.worktreeSetup.skip.map(globRe), link: c.worktreeSetup.link.map(globRe) };
  const files = [], excluded = [];
  const add = (rel, top) => {
    const abs = path.join(repo, rel), s = fs.lstatSync(abs);
    if (s.isSymbolicLink()) { excluded.push({ path: rel, why: 'symlink' }); return; }
    const why = excludedWhy(rel, s.isDirectory(), globs, top);
    if (why) { excluded.push({ path: rel, why }); return; }
    if (s.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) add(`${rel}/${n}`, false); return; }
    if (!s.isFile()) { excluded.push({ path: rel, why: 'not a regular file' }); return; }
    files.push({ path: rel, size: s.size, mtimeMs: s.mtimeMs, sha256: sha256File(abs) });
  };
  for (const e of g.stdout.split('\0')) {
    if (!e.startsWith('!! ')) continue;
    const rel = e.slice(3).replace(/\/$/, '');
    if (rel) add(rel, true);
  }
  files.sort(byPath); excluded.sort(byPath);
  const m = { version: 1, id: manifestId(files), repoDir: repo, scan: c.worktreeSetup.scan, at: new Date().toISOString(),
    bytes: files.reduce((s, f) => s + f.size, 0), files, excluded };
  fs.mkdirSync(c.sharedDir, { recursive: true });
  const out = path.join(c.sharedDir, 'corpus-manifest.json'), tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, out);
  m.file = out;
  return m;
}

// The ready file list itself is checked: no .env* and no sessions/ ever leaves this machine.
function gate(m) {
  const bad = m.files.map((f) => f.path).filter((p) => p.split('/').some((s) => SECRET.test(s) || s === 'sessions'));
  if (bad.length) throw new Stop(65, `refused before transfer: ${bad.join(', ')} - a .env* or sessions/ in the file list (secrets and sessions never leave this machine); move it out of the corpus and sync again`);
}

// ---- the runner
const q = (s) => `'${s}'`; // remote.key and remote.knownHosts carry no quote (config.js)
function sshOpts(r) {
  return ['-F', 'none', '-T', '-i', r.key, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${r.knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'UpdateHostKeys=no'];
}
const sshE = (r) => `ssh -F none -T -i ${q(r.key)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${q(r.knownHosts)} -o GlobalKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=20 -o UpdateHostKeys=no`;
const REMOTE_SRC = fs.readFileSync(path.join(__dirname, 'corpus-remote.js'), 'utf8');
// Runs one operation of corpus-remote.js on the runner: the script on stdin, the call with its input as a JSON literal.
function remoteOp(r, op, input = {}) {
  const script = `${REMOTE_SRC}\n;module.exports.cli(${JSON.stringify(op)}, ${JSON.stringify(Object.assign({ root: r.root }, input))});\n`;
  const p = spawnSync('ssh', [...sshOpts(r), `${r.user}@${r.host}`, 'node -'], { input: script, encoding: 'utf8', maxBuffer: 1 << 28 });
  const line = (p.stdout || '').split('\n').filter((l) => l.startsWith('CORPUS-RESULT ')).pop();
  if (p.error) throw env(`remote runner unreachable: ${p.error.message}`);
  if (!line) {
    const err = (p.stderr || '').trim().split('\n').filter(Boolean).pop() || `ssh exit ${p.status}`;
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(p.stderr || '')) throw env(`host key mismatch for ${r.host} - possible MITM; nothing done (${err})`);
    throw env(`remote runner unreachable: ${err}`);
  }
  if (p.status !== 0) throw new Stop(p.status, (p.stderr || '').trim() || `remote ${op} failed (exit ${p.status})`);
  if (p.stderr) process.stderr.write(p.stderr);
  return JSON.parse(line.slice('CORPUS-RESULT '.length));
}
// The destination of rsync on the runner: ~/x is x relative to the login directory (rsync's remote paths).
const rsyncDest = (r) => `${r.user}@${r.host}:${r.root.replace(/^~\//, '').replace(/\/+$/, '')}/corpus/`;
function rsync(r, c, list) {
  const lf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-sync-')), 'files');
  fs.writeFileSync(lf, list.map((p) => p + '\0').join(''));
  try {
    // No -a, -r, -l or -L: exactly the listed regular files, never a link; times and modes kept; secrets and sessions
    // excluded by rsync too (a second fence behind gate()).
    return spawnSync('rsync', ['-e', sshE(r), `--files-from=${lf}`, '--from0', '--times', '--perms', '--exclude=.env*', '--exclude=sessions/', `${c.repoDir}/`, rsyncDest(r)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } finally { fs.rmSync(path.dirname(lf), { recursive: true, force: true }); }
}

function sync(c, r) {
  let m = manifest(c);
  gate(m);
  if (!m.files.length) throw env(`the source has no corpus (repoDir ${c.repoDir}, scan ${c.worktreeSetup.scan.join(', ')}): an empty source never replaces the donor - nothing sent, nothing deleted`);
  const st = remoteOp(r, 'state').state;
  if (st && st.state === 'complete' && st.id === m.id) { say(`corpus up to date ${m.id} (${m.files.length} files, ${m.bytes} bytes)`); return 0; }
  for (let pass = 1; ; pass++) {
    remoteOp(r, 'begin', { id: m.id });
    const have = new Map(remoteOp(r, 'scan').files.map((f) => [f.path, f]));
    const send = m.files.filter((f) => { const h = have.get(f.path); return !h || h.size !== f.size || h.sha256 !== f.sha256; }).map((f) => f.path);
    const keep = new Set(m.files.map((f) => f.path));
    const del = [...have.keys()].filter((p) => !keep.has(p));
    if (send.length) {
      const x = rsync(r, c, send);
      if (x.status !== 0) {
        const tail = ((x.stderr || '') + (x.error ? x.error.message : '')).trim().split('\n').slice(-3).join(' | ');
        throw env(`rsync failed (exit ${x.status === null ? x.signal : x.status}): ${tail} - donor marked incomplete; sync again`);
      }
    }
    if (del.length) remoteOp(r, 'delete', { paths: del });
    say(`pass ${pass}: sent ${send.length}, deleted ${del.length}`);
    const after = manifest(c);
    if (after.id === m.id) {
      const f = remoteOp(r, 'finish', { expectId: m.id });
      say(`corpus synced ${f.id} (${f.files} files, ${f.bytes} bytes)`);
      return 0;
    }
    gate(after);
    if (pass === 1) { say(`source changed during sync (manifest ${m.id} -> ${after.id}) - one more pass`); m = after; continue; }
    const f = remoteOp(r, 'finish', { accept: true });
    say(`source changed during sync again (manifest ${m.id} -> ${after.id}): the donor holds manifest ${f.id} of what it received (${f.files} files); sync again for the latest`);
    return 0;
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const USAGE = 'usage: corpus-sync.js manifest | sync | status | copy <name> | wipe-list | wipe --confirm <token>';
  if (cmd === 'manifest') {
    const m = manifest(loadConfig());
    gate(m);
    say(`manifest ${m.id}: ${m.files.length} files, ${m.bytes} bytes, ${m.excluded.length} left out -> ${m.file}`);
    return 0;
  }
  if (cmd === 'sync') { const c = loadConfig(); return sync(c, loadRemote()); }
  if (cmd === 'status') { say(JSON.stringify(remoteOp(loadRemote(), 'status'))); return 0; }
  if (cmd === 'copy') {
    if (rest.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest[0])) throw new Stop(64, `${USAGE}\n(a run name: letters, digits and . _ -, no path)`);
    const x = remoteOp(loadRemote(), 'copy', { name: rest[0] });
    say(`copied corpus to ${x.target}: ${x.files} files, ${x.bytes} bytes in ${x.seconds} s (manifest ${x.id})`);
    return 0;
  }
  if (cmd === 'wipe-list') {
    const w = remoteOp(loadRemote(), 'wipe-list');
    for (const e of w.list) say(`${e.path}\t${e.bytes} bytes`);
    say(`${w.list.length} entries, ${w.list.reduce((s, e) => s + e.bytes, 0)} bytes; remove them with: corpus-sync.js wipe --confirm ${w.token}`);
    say(`token ${w.token}`);
    return 0;
  }
  if (cmd === 'wipe') {
    if (rest[0] !== '--confirm' || !/^[0-9a-f]{16}$/.test(rest[1] || '')) throw new Stop(64, `${USAGE}\n(wipe-list first: it prints the list and its token)`);
    const w = remoteOp(loadRemote(), 'wipe', { token: rest[1] });
    for (const e of w.removed) say(`removed ${e.path}\t${e.bytes} bytes`);
    return 0;
  }
  throw new Stop(64, USAGE);
}

module.exports = { manifest, gate, globRe, excludedWhy, sshOpts, sshE, rsyncDest };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Stop)) throw e;
    process.stderr.write(e.message + '\n');
    process.exitCode = e.code;
  }
}
