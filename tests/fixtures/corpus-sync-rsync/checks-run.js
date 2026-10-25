#!/usr/bin/env node
'use strict';
// Tester guard of remote-runs-c (a fixture: the tester may write only guards and fixtures; tests/corpus-sync-rsync.test.js
// is to run it as part of the suite): scripts/corpus-sync.js with the REAL rsync of this machine (openrsync on a Mac, rsync on
// Linux) at both ends. Only ssh is a fake: it drops its options and the destination and runs the remote command with sh
// in a temporary "server" home, so rsync speaks its own protocol to `rsync --server` and corpus-remote.js runs under
// `node -` as on the runner. tests/corpus-sync.test.js fakes rsync itself (it copies every listed file), so rsync's own
// behaviour - its quick check by size and mtime, its handling of odd names and links - is checked only here.
// Cells: T-1 content changed with the same size and mtime (C-4: the donor equals the manifest after a sync);
// T-2 names with a space, a newline, a leading dash, non-ASCII (C-4: they arrive and are deleted);
// T-4 a link to a directory outside the corpus (C-7: neither the link nor its target arrives);
// T-5 copy <name> over an existing copy (C-10: the copy equals the donor, no file of an older donor stays);
// T-6/T-7/T-8 the removal of the earlier copy never reaches outside wt/<name> (a link inside it, wt/<name> a link, another copy).
// T-9 rsync's filters no wider than gate (look-alikes of sessions and .env arrive, the donor completes); T-10 every name this
// disk opens as sessions/ (measured by inode) is left out, refused by gate and never reaches the donor (C-6).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('../../lib');

const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'corpus-sync.js');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-rsync-')));
const main = path.join(dir, 'main'), shared = path.join(dir, 'shared'), server = path.join(dir, 'server'), fake = path.join(dir, 'fakebin');
const donor = path.join(server, 'codis-runs', 'corpus');
const g = (...a) => spawnSync('git', ['-C', main, ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function files(top) {
  const out = [];
  if (!fs.existsSync(top)) return out;
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p); else out.push(path.relative(top, p));
    }
  })(top);
  return out.sort();
}

if (!has('rsync')) { skip('real rsync', 'rsync not found'); done(); }
try {
  fs.mkdirSync(fake); fs.mkdirSync(shared); fs.mkdirSync(server);
  // ssh: options and destination dropped, the rest runs with sh in the server home (stdin passed through).
  fs.writeFileSync(path.join(fake, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -F|-i|-o|-p|-l|-E|-b|-c|-J) shift 2;; -*) shift;; *) break;; esac; done
shift
cd "$FAKE_SERVER_HOME" || exit 255
HOME="$FAKE_SERVER_HOME" exec sh -c "$*"
`, { mode: 0o755 });
  const key = path.join(dir, 'id'), kh = path.join(dir, 'kh');
  fs.writeFileSync(key, 'k'); fs.writeFileSync(kh, 'h');
  const machine = path.join(dir, 'machine.json');
  fs.writeFileSync(machine, JSON.stringify({ configVersion: 1, remote: { host: 'example.org', user: 'runner', key, knownHosts: kh, root: '~/codis-runs' } }));
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: main, worktreeRoot: path.join(dir, 'wts'), sharedDir: shared,
    worktreeSetup: { scan: ['app'], skip: ['*.DS_Store'], link: ['*/node_modules'] } }));
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, {
    CODIS_AGENTS_CONFIG: cfg, CODIS_AGENTS_MACHINE: machine, PATH: fake + path.delimiter + process.env.PATH, FAKE_SERVER_HOME: server }) });
  const out = (r) => r.stdout + r.stderr;
  const status = () => { const r = run(['status']); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { raw: out(r) }; } };

  fs.mkdirSync(main);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  put('.gitignore', 'data/\n.DS_Store\n'); put('app/src.js', '1');
  g('add', '.gitignore', 'app/src.js'); g('commit', '-qm', 'base');
  const odd = ['app/data/with space.json', 'app/data/new\nline.json', 'app/data/-dash.json', 'app/data/\u044e\u043d\u0438\u043a\u043e\u0434.json'];
  put('app/data/a.json', 'aaaa'); put('app/data/sub/b.json', 'b');
  for (const p of odd) put(p, 'odd');
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'id_secret'), 'outside');
  fs.symlinkSync(outside, path.join(main, 'app', 'data', 'ssh-link'));

  let r = run(['sync']);
  ok('first sync with the real rsync: done', r.status === 0 && /corpus synced /.test(r.stdout), out(r));
  ok('T-2 odd names (space, newline, leading dash, non-ASCII) arrive', odd.every((p) => read(path.join(server, 'codis-runs', 'corpus', p.slice(0))) === 'odd'), files(donor).join(' | '));
  ok('T-4 neither the link to a directory outside nor its target arrives', !files(server).some((f) => /ssh-link|id_secret/.test(f)) && !fs.existsSync(path.join(donor, 'app/data/ssh-link')), files(server).join(' | '));
  let st = status();
  ok('donor complete, its scan matches', st.state === 'complete' && st.matches === true, JSON.stringify(st));

  // T-2 deletions of odd names; T-5 a copy over an existing copy of the same name.
  r = run(['copy', 'r1']);
  ok('copy r1: done', r.status === 0, out(r));
  for (const p of odd) fs.rmSync(path.join(main, p));
  fs.rmSync(path.join(main, 'app/data/sub/b.json'));
  r = run(['sync']);
  ok('T-2 odd names gone from the source are deleted in the donor', r.status === 0 && JSON.stringify(files(donor)) === JSON.stringify(['app/data/a.json']), out(r) + files(donor).join(' | '));
  r = run(['copy', 'r1']);
  const wt = path.join(server, 'codis-runs', 'wt', 'r1');
  ok('T-5 copy over an existing copy equals the donor (no file of the older donor stays)', r.status === 0 && JSON.stringify(files(wt)) === JSON.stringify(files(donor)), out(r) + files(wt).join(' | '));
  // Round 2 (the earlier copy is removed before cp): T-6 a link an earlier run left in its copy is removed, its target
  // outside is not; T-7 wt/<name> that is itself a link is refused and its target untouched; T-8 another run's copy stays.
  const victim = path.join(dir, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
  fs.symlinkSync(victim, path.join(wt, 'link-out'));
  fs.writeFileSync(path.join(wt, 'guard-write.json'), 'x');
  r = run(['copy', 'r2']);
  const wt2 = path.join(server, 'codis-runs', 'wt', 'r2');
  fs.writeFileSync(path.join(wt2, 'r2-own.json'), 'r2');
  r = run(['copy', 'r1']);
  ok('T-6 an earlier copy with a link outside: the link and the earlier writes are gone, the copy equals the donor', r.status === 0 && JSON.stringify(files(wt)) === JSON.stringify(files(donor)), out(r) + files(wt).join(' | '));
  ok('T-6 the target of that link outside is not touched', read(path.join(victim, 'keep.txt')) === 'keep', files(victim).join(' | '));
  ok('T-8 copy r1 leaves another run\'s copy r2 as it was', read(path.join(wt2, 'r2-own.json')) === 'r2', files(wt2).join(' | '));
  const wt3 = path.join(server, 'codis-runs', 'wt', 'r3');
  fs.symlinkSync(victim, wt3);
  r = run(['copy', 'r3']);
  ok('T-7 wt/<name> that is a link: refused (69), nothing removed or copied through it', r.status === 69 && /not a directory/.test(r.stderr)
    && JSON.stringify(files(victim)) === JSON.stringify(['keep.txt']) && fs.lstatSync(wt3).isSymbolicLink(), out(r) + files(victim).join(' | '));
  fs.unlinkSync(wt3);
  // T-1: the same size and the same mtime (whole seconds, as rsync compares them), other content.
  const a = path.join(main, 'app/data/a.json'), t = fs.statSync(a).mtime;
  fs.writeFileSync(a, 'AAAA'); fs.utimesSync(a, t, t);
  r = run(['sync']);
  st = status();
  ok('T-1 content changed with the same size and mtime: the sync completes', r.status === 0 && /corpus synced /.test(r.stdout), out(r));
  r = run(['sync']);
  ok('T-1 the next sync does not stay stuck on it', r.status === 0 && status().state === 'complete', out(r));
  ok('T-1 the donor holds the new content and is complete', read(path.join(donor, 'app/data/a.json')) === 'AAAA' && st.state === 'complete' && st.matches === true, read(path.join(donor, 'app/data/a.json')) + ' ' + JSON.stringify(st));

  // Round 3 (sessions/ in any case, rsync filters of letter classes). T-9: the filters are no wider than gate - names
  // that only look like sessions or .env reach the donor through the real rsync and the donor ends complete (a filter
  // that dropped a listed file would leave the donor incomplete on every sync, as D-1 did).
  const near = ['app/data/sessionsX/a.json', 'app/data/my-sessions/b.json', 'app/data/sessions.json', 'app/data/Sess/c.json',
    'app/data/env/d.json', 'app/data/a.env', 'app/data/x.ENV.json', 'app/data/envx.json'];
  for (const p of near) put(p, 'near');
  r = run(['sync']);
  st = status();
  ok('T-9 look-alike names of sessions and .env arrive through the real rsync filters, the donor is complete',
    r.status === 0 && near.every((p) => read(path.join(donor, p)) === 'near') && st.state === 'complete' && st.matches === true,
    out(r) + files(donor).join(' | ') + ' ' + JSON.stringify(st));
  // T-10: every name this disk opens as sessions/ (measured here: lstat of the name gives the inode of a sessions/
  // directory; on a case-insensitive APFS that is Sessions, SESSIONS, long-s forms) is a sessions/ folder for the
  // manifest, for gate() and for the transfer. On a case-sensitive disk only sessions itself opens it.
  const probe = path.join(dir, 'probe'); fs.mkdirSync(path.join(probe, 'sessions'), { recursive: true });
  const ino = fs.lstatSync(path.join(probe, 'sessions')).ino;
  const cands = ['sessions', 'Sessions', 'SESSIONS', 'SeSSioNS', 'ſessions', 'ſeſſions', 'seſsions', 'SESSIONs'];
  const alias = cands.filter((n) => { try { return fs.lstatSync(path.join(probe, n)).ino === ino; } catch { return false; } });
  const CS = require(SCRIPT);
  const gated = (p) => { try { CS.gate({ files: [{ path: p }] }); return false; } catch (e) { return e.code === 65; } };
  ok('T-10 every alias of sessions/ on this disk is a sessions/ folder (excludedWhy, gate)', alias.length >= 1
    && alias.every((n) => CS.excludedWhy('app/data/' + n, true, { skip: [], link: [] }, false) === 'sessions' && gated(`app/data/${n}/s.json`)),
    'aliases here: ' + JSON.stringify(alias));
  // Distinct parents: on a case-insensitive disk two aliases in one directory would be one directory.
  const sess = alias.map((n, i) => `app/data/s${i}/${n}/state.json`);
  for (const p of sess) put(p, 'session');
  r = run(['sync']);
  st = status();
  ok('T-10 none of them reaches the donor through the real rsync, the sync completes',
    r.status === 0 && !files(server).some((f) => f.split('/').some((s) => alias.includes(s))) && st.state === 'complete',
    out(r) + files(server).join(' | '));

} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
