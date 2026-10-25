#!/usr/bin/env node
'use strict';
// scripts/corpus-sync.js: the corpus of a project (its git-ignored data under worktreeSetup.scan) goes one way, from the
// main checkout of this machine to a donor directory <root>/corpus on the remote runner of the machine file (key
// remote), and each remote run gets its own copy of the donor. No network here: ssh and rsync are fakes on PATH - the
// fake ssh runs the remote command with sh in a temporary "server" home, the fake rsync copies the listed files there.
// Cells C-1..C-17 of the corpus part of the remote-runs matrix (C-16, corpus guards green on the server, is the
// tester's acceptance in the real environment).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'corpus-sync.js');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-sync-')));
const main = path.join(dir, 'main'), shared = path.join(dir, 'shared'), server = path.join(dir, 'server');
const fake = path.join(dir, 'fakebin'), sshLog = path.join(dir, 'ssh.log'), rsyncLog = path.join(dir, 'rsync.log');
const donor = path.join(server, 'codis-runs', 'corpus');
const g = (...a) => spawnSync('git', ['-C', main, ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lines = (f) => (read(f) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const reset = () => { for (const f of [sshLog, rsyncLog]) fs.rmSync(f, { force: true }); };
// Every file under a tree with its mtime and size (symlinks as links): what "unchanged" means for the main checkout.
function snapshot(top) {
  const out = {};
  if (!fs.existsSync(top)) return 'missing';
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      out[path.relative(top, p)] = st.isSymbolicLink() ? 'link:' + fs.readlinkSync(p) : `${st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(p);
    }
  })(top);
  return JSON.stringify(out);
}
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

fs.mkdirSync(fake); fs.mkdirSync(shared); fs.mkdirSync(server);
// ssh: logs its arguments; FAKE_SSH_FAIL=1 - the host does not answer; otherwise the command after the destination
// runs with sh in the server home, stdin passed through, and nothing of this machine's environment but PATH.
fs.writeFileSync(path.join(fake, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.SSH_LOG, JSON.stringify(a) + '\\n');
if (process.env.FAKE_SSH_FAIL) { process.stderr.write('ssh: connect to host example.org port 22: Connection refused\\n'); process.exit(255); }
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.FAKE_SERVER_HOME } });
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
// rsync: logs its arguments and the file list; copies every listed regular file (a listed symlink is skipped, as rsync
// without -l/-L does) from the source to the destination path in the server home. FAKE_RSYNC_DIE_AFTER=n - n files,
// then exit 20 (killed); FAKE_RSYNC_LIE=1 - exit 0 without copying anything; FAKE_RSYNC_TOUCH=<file> - appends to that source file after the copy (the source changed).
fs.writeFileSync(path.join(fake, 'rsync'), `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
let list = null, from0 = false; const pos = [];
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-e') { i++; continue; }
  if (a[i].startsWith('--files-from=')) list = a[i].slice(13);
  else if (a[i] === '--from0') from0 = true;
  else if (!a[i].startsWith('-')) pos.push(a[i]);
}
const names = list ? fs.readFileSync(list, 'utf8').split(from0 ? '\\0' : '\\n').filter(Boolean) : [];
fs.appendFileSync(process.env.RSYNC_LOG, JSON.stringify({ args: a, list: names }) + '\\n');
const [src, dst] = pos;
const m = /^[^@:]+@[^:]+:(.*)$/.exec(dst);
const to = path.resolve(process.env.FAKE_SERVER_HOME, m[1]);
if (process.env.FAKE_RSYNC_LIE) process.exit(0);
let n = 0; const die = process.env.FAKE_RSYNC_DIE_AFTER;
for (const p of names) {
  if (die !== undefined && n >= Number(die)) { process.stderr.write('rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20)\\n'); process.exit(20); }
  const s = path.join(src, p), st = fs.lstatSync(s);
  if (st.isSymbolicLink()) { process.stderr.write('skipping non-regular file "' + p + '"\\n'); continue; }
  fs.mkdirSync(path.dirname(path.join(to, p)), { recursive: true });
  fs.copyFileSync(s, path.join(to, p)); fs.utimesSync(path.join(to, p), st.atime, st.mtime); n++;
}
if (process.env.FAKE_RSYNC_TOUCH) fs.appendFileSync(process.env.FAKE_RSYNC_TOUCH, 'x');
`, { mode: 0o755 });

const key = path.join(dir, 'id_runner'), kh = path.join(dir, 'known_hosts_runner');
fs.writeFileSync(key, 'not a key'); fs.writeFileSync(kh, 'example.org ssh-ed25519 AAAA');
const machine = path.join(dir, 'machine.json');
const remote = { host: 'example.org', user: 'runner', key, knownHosts: kh, root: '~/codis-runs' };
fs.writeFileSync(machine, JSON.stringify({ configVersion: 1, remote }));
const noRemote = path.join(dir, 'machine-none.json');
fs.writeFileSync(noRemote, JSON.stringify({ configVersion: 1 }));
const cfgOf = (repo) => {
  const f = path.join(dir, `cfg-${crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8)}.json`);
  fs.writeFileSync(f, JSON.stringify({ repoDir: repo, worktreeRoot: path.join(dir, 'wts'), sharedDir: shared,
    worktreeSetup: { scan: ['app', 'plug'], skip: ['*.DS_Store'], link: ['*/node_modules', '*/dist'] } }));
  return f;
};
const cfg = cfgOf(main);
const run = (args, extra = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, {
  CODIS_AGENTS_CONFIG: cfg, CODIS_AGENTS_MACHINE: machine, PATH: fake + path.delimiter + process.env.PATH,
  FAKE_SERVER_HOME: server, SSH_LOG: sshLog, RSYNC_LOG: rsyncLog }, extra) });
const out = (r) => r.stdout + r.stderr;
// sessions/ in any case: rsync's filters have no case-insensitive match, so every letter is a class.
const SESS = '[sS][eE][sS][sS][iI][oO][nN][sS]';
const status = () => { const r = run(['status']); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { raw: out(r) }; } };

try {
  // ---- the main checkout: tracked sources, ignored data, secrets, sessions, symlinks, dependencies
  fs.mkdirSync(main);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  put('.gitignore', '.env*\nnode_modules\ndist\n.deps\ndata/\nsessions/\n.DS_Store\nout.log\n'); put('app/src.js', '1'); put('plug/src.ts', '2');
  g('add', '.gitignore', 'app/src.js', 'plug/src.ts'); g('commit', '-qm', 'base');
  put('app/data/a.json', '{"a":1}'); put('app/data/sub/b.bin', 'bbbb'); put('app/out.log', 'log'); put('plug/data/p.json', 'p');
  put('app/.env', 'SECRET=1'); put('plug/.env.local', 'SECRET=2'); put('app/node_modules/m.js', 'mod'); put('app/dist/x.js', 'dist');
  put('app/sessions/s1/state.json', 'session'); put('app/data/sessions/s2.json', 'deep session'); put('app/.DS_Store', 'x'); put('app/data/.DS_Store', 'x');
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the corpus');
  fs.symlinkSync(outside, path.join(main, 'app', '.deps'));
  fs.symlinkSync(outside, path.join(main, 'app', 'data', 'linked'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(main, 'app', 'data', 'file-link'));
  put('other/data/z.json', 'not scanned');
  const corpus = ['app/data/a.json', 'app/data/sub/b.bin', 'app/out.log', 'plug/data/p.json'];

  // ---- no key remote: nothing changes - no ssh, no rsync, a refusal that names the key
  reset();
  let r = run(['sync'], { CODIS_AGENTS_MACHINE: noRemote });
  ok('no remote key: sync refused with 78, naming the key', r.status === 78 && /remote/.test(r.stderr), out(r));
  ok('no remote key: no ssh and no rsync', !fs.existsSync(sshLog) && !fs.existsSync(rsyncLog));

  // ---- C-1, C-2: the manifest; the main checkout is only read
  // git status of the test itself may refresh the index: it runs before the snapshot, and after the snapshot below.
  const gitBefore = g('status', '--porcelain', '--ignored').stdout, before = snapshot(main);
  r = run(['manifest']);
  const mf = JSON.parse(read(path.join(shared, 'corpus-manifest.json')) || '{}');
  const paths = (mf.files || []).map((f) => f.path).sort();
  ok('C-1 manifest written to the shared directory, reported with its id', r.status === 0 && /^[0-9a-f]{16}$/.test(mf.id || '') && r.stdout.includes(mf.id), out(r));
  ok('C-1 manifest: exactly the ignored data under scan', JSON.stringify(paths) === JSON.stringify(corpus), paths.join(' '));
  const a = (mf.files || []).find((f) => f.path === 'app/data/a.json') || {};
  ok('C-1 manifest entry: size, mtime and sha256', a.size === 7 && a.mtimeMs === fs.statSync(path.join(main, 'app/data/a.json')).mtimeMs
    && a.sha256 === crypto.createHash('sha256').update('{"a":1}').digest('hex'), JSON.stringify(a));
  const why = Object.fromEntries((mf.excluded || []).map((e) => [e.path, e.why]));
  ok('C-1 excluded and named: .env*, sessions, node_modules, dist, .deps, skip globs, symlinks',
    why['app/.env'] && why['plug/.env.local'] && why['app/sessions'] && why['app/data/sessions'] && why['app/node_modules'] && why['app/dist']
    && why['app/.deps'] && why['app/.DS_Store'] && why['app/data/linked'] && why['app/data/file-link'], JSON.stringify(why));
  reset();
  r = run(['sync']);
  ok('C-4 first sync: done, reported with the manifest id', r.status === 0 && r.stdout.includes('corpus synced ' + mf.id), out(r));
  ok('C-2 sync and manifest leave the main checkout as it was (files, mtimes, git status)', snapshot(main) === before && g('status', '--porcelain', '--ignored').stdout === gitBefore);
  ok('C-4 donor = the manifest', JSON.stringify(files(donor)) === JSON.stringify(corpus), files(donor).join(' '));
  ok('C-4 donor content and mtime (to the second, as rsync -t keeps it) as in the source', read(path.join(donor, 'app/data/a.json')) === '{"a":1}'
    && Math.floor(fs.statSync(path.join(donor, 'app/data/a.json')).mtimeMs / 1000) === Math.floor(fs.statSync(path.join(main, 'app/data/a.json')).mtimeMs / 1000));
  const rs = lines(rsyncLog), ss = lines(sshLog);
  ok('C-4 one rsync with the manifest as its file list', rs.length === 1 && JSON.stringify([...rs[0].list].sort()) === JSON.stringify(corpus), JSON.stringify(rs.map((x) => x.list)));
  const pinned = (args) => args.includes('-F') && args[args.indexOf('-F') + 1] === 'none' && args.includes('-i') && args[args.indexOf('-i') + 1] === key
    && ['StrictHostKeyChecking=yes', `UserKnownHostsFile=${kh}`, 'IdentitiesOnly=yes', 'BatchMode=yes'].every((o) => args.some((x, i) => x === o && args[i - 1] === '-o'))
    && !args.join(' ').includes('accept-new') && args.includes('runner@example.org');
  ok('ssh: the pinned key and known_hosts, strict host key checking, no config file', ss.length > 0 && ss.every(pinned), JSON.stringify(ss[0]));
  const e = rs[0] ? rs[0].args[rs[0].args.indexOf('-e') + 1] || '' : '';
  ok('rsync: the same pinned ssh in -e', /^ssh /.test(e) && e.includes('-F none') && e.includes(`-i '${key}'`) && e.includes('StrictHostKeyChecking=yes')
    && e.includes(`UserKnownHostsFile='${kh}'`) && e.includes('IdentitiesOnly=yes') && !e.includes('accept-new'), e);
  ok('C-7 rsync: links not followed, secrets and sessions excluded at rsync level too', rs[0] && !rs[0].args.some((x) => /^(-L|--copy-links|--copy-unsafe-links|-a|--archive|-r|--recursive|--delete.*)$/.test(x) || /^-[a-zA-Z]*L/.test(x))
    && ['.[eE][nN][vV]*', `/${SESS}/**`, `**/${SESS}/**`].every((x) => rs[0].args.includes('--exclude=' + x)), rs[0] && rs[0].args.join(' '));
  ok('C-6 no sessions/ at any depth on the server', !files(path.join(server)).some((f) => f.split('/').includes('sessions')));
  ok('C-5 no .env* on the server', !files(path.join(server)).some((f) => /^\.env/i.test(path.basename(f))));
  ok('C-7 neither the symlinks nor what they point to on the server', !files(server).some((f) => /linked|file-link|\.deps|secret\.txt/.test(f)));
  let st = status();
  ok('donor state complete with the manifest id; its scan matches', st.state === 'complete' && st.id === mf.id && st.scanId === mf.id && st.matches === true, JSON.stringify(st));

  // ---- C-3: the same manifest - no transfer
  reset();
  r = run(['sync']);
  ok('C-3 second sync: "corpus up to date <id>", no rsync', r.status === 0 && r.stdout.includes('corpus up to date ' + mf.id) && !fs.existsSync(rsyncLog), out(r));

  // ---- C-4, C-15: a change - a delta; a file gone from the source is deleted inside the donor only
  fs.mkdirSync(path.join(server, 'codis-runs', 'keep'), { recursive: true });
  fs.writeFileSync(path.join(server, 'codis-runs', 'keep', 'k.txt'), 'k'); fs.writeFileSync(path.join(server, 'home.txt'), 'h');
  put('app/data/a.json', '{"a":2}'); put('app/data/new.json', 'n'); fs.rmSync(path.join(main, 'app/data/sub/b.bin'));
  reset();
  r = run(['sync']);
  const rs2 = lines(rsyncLog);
  ok('C-4 delta: only the changed and new files go', r.status === 0 && rs2.length === 1 && JSON.stringify([...rs2[0].list].sort()) === JSON.stringify(['app/data/a.json', 'app/data/new.json']), out(r) + JSON.stringify(rs2.map((x) => x.list)));
  ok('C-4 a file gone from the source is gone from the donor', !fs.existsSync(path.join(donor, 'app/data/sub/b.bin')) && read(path.join(donor, 'app/data/a.json')) === '{"a":2}' && read(path.join(donor, 'app/data/new.json')) === 'n');
  ok('C-4 deletion stays inside the donor', read(path.join(server, 'codis-runs', 'keep', 'k.txt')) === 'k' && read(path.join(server, 'home.txt')) === 'h');
  const mf2 = JSON.parse(read(path.join(shared, 'corpus-manifest.json')));
  st = status();
  ok('C-15 the next run sees the new manifest', st.state === 'complete' && st.id === mf2.id && mf2.id !== mf.id && st.matches === true, JSON.stringify(st));

  // ---- C-5: a .env* in the ready file list - refused before any transfer, the file named
  const donorBefore = snapshot(donor);
  put('app/data/sub/.env.local', 'SECRET=3');
  reset();
  r = run(['sync']);
  ok('C-5 .env* inside the data: refused with 65 before transfer, the file named', r.status === 65 && /refused before transfer/.test(r.stderr) && r.stderr.includes('app/data/sub/.env.local'), out(r));
  ok('C-5 refused: no ssh, no rsync, the donor unchanged', !fs.existsSync(sshLog) && !fs.existsSync(rsyncLog) && snapshot(donor) === donorBefore);
  fs.rmSync(path.join(main, 'app/data/sub/.env.local'));
  put('app/data/.ENV', 'SECRET=4');
  reset();
  r = run(['sync']);
  ok('C-5 the check ignores case (.ENV)', r.status === 65 && r.stderr.includes('app/data/.ENV') && !fs.existsSync(rsyncLog), out(r));
  fs.rmSync(path.join(main, 'app/data/.ENV'));

  // ---- C-6 in another case: on a case-insensitive disk (APFS of a Mac) Sessions/, SESSIONS/ and \u017Fessions/ (long s,
  // U+017F, folds to s) open the same directory as sessions/ - each is a sessions/ folder and never leaves this machine.
  // Distinct parents: on such a disk two of these names in one directory would be one directory.
  const odd = ['plug/SESSIONS/s3/.preview-secret', 'plug/data/Sessions/s4/state.json', 'app/data/sub/\u017Fessions/s5/state.json'];
  for (const f of odd) put(f, 'session in another case');
  put('.gitignore', '.env*\nnode_modules\ndist\n.deps\ndata/\nsessions/\nSESSIONS/\n.DS_Store\nout.log\n');
  r = run(['manifest']);
  const mo = JSON.parse(read(path.join(shared, 'corpus-manifest.json')) || '{}');
  const whyO = Object.fromEntries((mo.excluded || []).map((e) => [e.path, e.why]));
  ok('C-6 Sessions/, SESSIONS/ (top-level entry of git) and \u017Fessions/ left out of the manifest as sessions',
    r.status === 0 && !(mo.files || []).some((f) => /essions/i.test(f.path)) && whyO['plug/SESSIONS'] === 'sessions'
    && whyO['plug/data/Sessions'] === 'sessions' && whyO['app/data/sub/\u017Fessions'] === 'sessions', out(r) + JSON.stringify(whyO));
  reset();
  r = run(['sync']);
  ok('C-6 none of them reaches the server', r.status === 0 && !files(server).some((f) => /essions/i.test(f)), out(r) + files(server).join(' '));
  for (const f of ['plug/SESSIONS', 'plug/data/Sessions', 'app/data/sub/\u017Fessions']) fs.rmSync(path.join(main, f), { recursive: true });
  put('.gitignore', '.env*\nnode_modules\ndist\n.deps\ndata/\nsessions/\n.DS_Store\nout.log\n');
  const CS = require(SCRIPT);
  const globs0 = { skip: [], link: [] };
  ok('C-6 excludedWhy folds case: Sessions, SESSIONS, \u017Fessions at the top and nested',
    ['Sessions', 'SESSIONS', '\u017Fessions', 'react-render-server/Sessions', 'a/b/SeSsIoNs', 'a/\u017Fessions'].every((p) => CS.excludedWhy(p, true, globs0, false) === 'sessions')
    && CS.excludedWhy('a/sessionsX', true, globs0, false) === null && CS.excludedWhy('a/my-sessions', true, globs0, false) === null);
  const gated = (p) => { try { CS.gate({ files: [{ path: p }] }); return false; } catch (e) { return e.code === 65; } };
  ok('C-6 gate refuses a sessions/ folder in any case before transfer (top level and nested)',
    ['Sessions/a/.preview-secret', 'react-render-server/Sessions/a/.preview-secret', 'x/builds.nosync/SESSIONS/abc/state.json', 'x/\u017Fessions/a.json'].every(gated)
    && !gated('x/sessionsX/a.json') && !gated('x/data/a.json'));
  // The second fence behind gate(): the filters handed to rsync, run by the real rsync of this machine on a local list.
  const rsyncBin = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
  if (rsyncBin.status === 0) {
    const ls = path.join(dir, 'fence-src'), ld = path.join(dir, 'fence-dst'), lf = path.join(dir, 'fence-list');
    const fl = ['ok.txt', 'Sessions/a/s.json', 'x/SESSIONS/b.json', 'x/y/sessions/c.json', 'sessions/d.json', 'x/.ENV', 'x/.env.local'];
    // sessions/ at the top and Sessions/ at the top are one folder on a case-insensitive disk: the top one sits in its own source.
    const src2 = path.join(ls, 'top');
    for (const f of fl) {
      const base = f === 'sessions/d.json' ? src2 : path.join(ls, 'main');
      fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true }); fs.writeFileSync(path.join(base, f), f);
    }
    const fence = (from, list) => {
      fs.rmSync(ld, { recursive: true, force: true }); fs.mkdirSync(ld);
      fs.writeFileSync(lf, list.map((p) => p + '\0').join(''));
      const x = spawnSync('rsync', [`--files-from=${lf}`, '--from0', '--times', ...(CS.RSYNC_FILTERS || []), from + '/', ld + '/'], { encoding: 'utf8' });
      return { status: x.status, got: files(ld) };
    };
    const f1 = fence(path.join(ls, 'main'), fl.filter((f) => f !== 'sessions/d.json')), f2 = fence(src2, ['sessions/d.json']);
    ok('C-6, C-5 the rsync filters drop sessions/ in any case (top and nested) and .env* in any case; the rest goes',
      JSON.stringify(f1.got) === JSON.stringify(['ok.txt']) && f2.got.length === 0, JSON.stringify([f1, f2]));
  }

  // ---- C-8: an empty source never empties a full donor; C-9: repoDir unreachable
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(path.join(empty, 'app'), { recursive: true });
  spawnSync('git', ['-C', empty, 'init', '-q']);
  reset();
  r = run(['sync'], { CODIS_AGENTS_CONFIG: cfgOf(empty) });
  ok('C-8 empty source: refused as environment (69), donor kept', r.status === 69 && /^environment: /m.test(r.stderr) && /no corpus/.test(r.stderr) && snapshot(donor) === donorBefore, out(r));
  ok('C-8 empty source: no rsync, nothing deleted', !fs.existsSync(rsyncLog) && files(donor).length === 4);
  reset();
  r = run(['sync'], { CODIS_AGENTS_CONFIG: cfgOf(path.join(dir, 'gone')) });
  ok('C-9 repoDir unreachable: environment (69), no ssh', r.status === 69 && /^environment: /m.test(r.stderr) && /repoDir/.test(r.stderr) && !fs.existsSync(sshLog), out(r));
  reset();
  put('app/data/c.json', 'c');
  r = run(['sync'], { FAKE_SSH_FAIL: '1' });
  ok('the runner does not answer: environment (69) with the ssh error, no rsync', r.status === 69 && /remote runner unreachable/.test(r.stderr) && /Connection refused/.test(r.stderr) && !fs.existsSync(rsyncLog), out(r));

  // ---- C-13: an interrupted rsync marks the donor incomplete; a run's copy is refused until a full sync
  reset();
  r = run(['sync'], { FAKE_RSYNC_DIE_AFTER: '0' });
  st = status();
  ok('C-13 rsync cut off: environment (69), "rsync failed", "donor marked incomplete"', r.status === 69 && /rsync failed \(exit 20\)/.test(r.stderr) && /donor marked incomplete/.test(r.stderr), out(r));
  ok('C-13 the donor state is incomplete', st.state === 'incomplete', JSON.stringify(st));
  reset();
  r = run(['sync'], { FAKE_RSYNC_LIE: '1' });
  ok('C-13 rsync says done but the donor scan differs: environment (69), donor stays incomplete', r.status === 69 && /does not match/.test(r.stderr) && status().state === 'incomplete', out(r));
  r = run(['copy', 't0']);
  ok('C-13 copy for a run refused while incomplete (69), nothing copied', r.status === 69 && /incomplete/.test(r.stderr) && !fs.existsSync(path.join(server, 'codis-runs', 'wt', 't0')), out(r));
  reset();
  r = run(['sync']);
  st = status();
  ok('C-13 the next full sync completes the donor', r.status === 0 && st.state === 'complete' && st.matches === true && read(path.join(donor, 'app/data/c.json')) === 'c', out(r) + JSON.stringify(st));

  // ---- C-12: the source changes during the sync - one retry, then the donor gets the manifest of what it holds
  reset();
  put('app/data/c.json', 'c2');
  r = run(['sync'], { FAKE_RSYNC_TOUCH: path.join(main, 'app/data/c.json') });
  st = status();
  ok('C-12 source changed during sync: one retry (two rsync), said in the log', r.status === 0 && lines(rsyncLog).length === 2 && /source changed during sync/.test(out(r)), out(r));
  ok('C-12 donor complete with the manifest of what it holds', st.state === 'complete' && st.matches === true && st.id === st.scanId, JSON.stringify(st));
  reset();
  r = run(['sync']);
  ok('C-12 next sync brings the last change', r.status === 0 && read(path.join(donor, 'app/data/c.json')) === read(path.join(main, 'app/data/c.json')), out(r));

  // ---- C-10, C-11: a run's own copy; writes in it never reach the donor
  const wt = path.join(server, 'codis-runs', 'wt', 't1');
  r = run(['copy', 't1']);
  ok('C-10 copy: the donor at the worktree paths, a real copy, time and size reported', r.status === 0 && JSON.stringify(files(wt)) === JSON.stringify(files(donor))
    && !fs.lstatSync(path.join(wt, 'app', 'data')).isSymbolicLink() && /copied corpus to \S+: \d+ files, \d+ bytes in [\d.]+ s/.test(r.stdout), out(r));
  const stBefore = status();
  fs.mkdirSync(path.join(wt, 'app/data'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'app/data/a.json'), 'written by a guard'); fs.rmSync(path.join(wt, 'app/data/new.json'), { force: true }); fs.writeFileSync(path.join(wt, 'app/data/orphan'), 'o');
  st = status();
  ok('C-11 writes in the copy leave the donor and its manifest as they were', st.matches === true && st.scanId === stBefore.scanId && read(path.join(donor, 'app/data/a.json')) === '{"a":2}', JSON.stringify(st));
  reset();
  r = run(['copy', '../x']);
  ok('copy: a name with a path in it is refused (64) before ssh', r.status === 64 && !fs.existsSync(path.join(server, 'codis-runs', 'x')) && !fs.existsSync(sshLog), out(r));

  // ---- C-14: not enough disk for the copy - environment before copying, with the numbers
  fs.mkdirSync(path.join(server, '.config', 'codis-agents'), { recursive: true });
  fs.writeFileSync(path.join(server, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, minFreeDiskGB: 1e9 }));
  r = run(['copy', 't2']);
  ok('C-14 low disk: environment (69) before copying, numbers in the text', r.status === 69 && /not enough disk/.test(r.stderr) && /\d+(\.\d+)? GB free/.test(r.stderr)
    && /1000000000 GB/.test(r.stderr) && !fs.existsSync(path.join(server, 'codis-runs', 'wt', 't2')), out(r));
  fs.rmSync(path.join(server, '.config'), { recursive: true });

  // ---- C-17: wiping by the list only, check and removal in two commands
  r = run(['wipe-list']);
  const token = (/^token ([0-9a-f]{16})$/m.exec(r.stdout) || [])[1];
  ok('C-17 wipe-list: names the donor and the run copies with sizes and a token, removes nothing', r.status === 0 && token && r.stdout.includes('codis-runs/corpus')
    && r.stdout.includes('codis-runs/wt/t1') && /\d+ bytes/.test(r.stdout) && fs.existsSync(donor) && fs.existsSync(wt), out(r));
  r = run(['wipe']);
  ok('C-17 wipe without the token: refused (64), nothing removed', r.status === 64 && fs.existsSync(donor), out(r));
  r = run(['wipe', '--confirm', '0000000000000000']);
  ok('C-17 wipe with another list\'s token: refused (65), nothing removed', r.status === 65 && fs.existsSync(donor) && fs.existsSync(wt), out(r));
  r = run(['wipe', '--confirm', token]);
  ok('C-17 wipe with the token: donor, its state and the run copies removed', r.status === 0 && !fs.existsSync(donor) && !fs.existsSync(wt)
    && fs.existsSync(path.join(server, 'codis-runs')) && !fs.readdirSync(path.join(server, 'codis-runs')).some((n) => n.startsWith('corpus')), out(r));
  ok('C-17 wipe leaves everything else of the server', read(path.join(server, 'codis-runs', 'keep', 'k.txt')) === 'k' && read(path.join(server, 'home.txt')) === 'h');

  // ---- the key remote in the machine file is validated
  const C = require(path.join(ROOT, 'scripts', 'config.js'));
  const mfile = path.join(dir, 'm.json');
  const check = (rem) => { fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, remote: rem })); return C.loadMachine({ CODIS_AGENTS_MACHINE: mfile, HOME: dir }).errors.join('; '); };
  ok('remote: a whole key validates', check(remote) === '', check(remote));
  ok('remote: host required', /remote\.host: required/.test(check(Object.assign({}, remote, { host: undefined }))));
  ok('remote: knownHosts required', /remote\.knownHosts: required/.test(check(Object.assign({}, remote, { knownHosts: undefined }))));
  ok('remote: wrong type named', /remote\.user: expected string/.test(check(Object.assign({}, remote, { user: 7 }))));
  ok('remote: a host that looks like an option is refused', /remote\.host/.test(check(Object.assign({}, remote, { host: '-oProxyCommand=x' }))));
  ok('remote: key and knownHosts absolute or ~', /remote\.key/.test(check(Object.assign({}, remote, { key: 'id_rsa' }))));
  ok('remote: root is not the home or / itself', /remote\.root/.test(check(Object.assign({}, remote, { root: '~' }))) && /remote\.root/.test(check(Object.assign({}, remote, { root: '/' })))
    && /remote\.root/.test(check(Object.assign({}, remote, { root: '~/a/../..' }))));
  // S-2: every field that reaches the runner's shell or ssh's option parsing is refused on its own condition.
  ok('remote: root of shell characters refused (; space $( ) `)', ['/a;b', '~/a b', '~/$(id)', '~/a`id`', '/a|b', "/a'b"].every((v) => /remote\.root/.test(check(Object.assign({}, remote, { root: v })))));
  // -v and -q are of the user's own characters: only the "not starting with -" condition refuses them.
  ok('remote: a user that looks like an option is refused', ['-oProxyCommand=x', '-v', '-q.x'].every((v) => /remote\.user/.test(check(Object.assign({}, remote, { user: v })))));
  ok('remote: a quote in key or knownHosts is refused', /remote\.key/.test(check(Object.assign({}, remote, { key: "/a'b" })))
    && /remote\.knownHosts/.test(check(Object.assign({}, remote, { knownHosts: "~/k'h" }))));
  // S-3: ~ only as a leading ~/ (rsync's destination would read ~root as another user's home).
  ok('remote: ~ inside root is refused', ['~/~root/x', '/a/~b', '~root/x', '~/a~'].every((v) => /remote\.root/.test(check(Object.assign({}, remote, { root: v })))));
  ok('remote: plain roots still accepted', ['~/codis-runs', '/srv/codis-runs', '~/a.b/c_d-e'].every((v) => check(Object.assign({}, remote, { root: v })) === ''));
  ok('remote: unknown key named', /remote\.port: unknown key/.test(check(Object.assign({}, remote, { port: 22 }))));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
