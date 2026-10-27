'use strict';
// The dependency cache of the remote runner (scripts/guards-remote-host.js, depsCache): cells D-1, D-2, D-6...D-9 of
// the deps analysis. After its install a cache directory is read-only (no write bit on any entry), then <hash>.ok is
// written with the manifest of what the install made; a reuse checks the cache against that manifest (every path, its
// type, size, mode and link target - no list of names), and an incomplete or changed cache is installed again: write
// bits back (u+w), removed, the install, read-only again, a new .ok. A fake host: a temporary root, the install a
// shell command, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const H = require('../scripts/guards-remote-host');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-remote-deps-')));
const deps = path.join(T, 'deps'), src = path.join(T, 'src');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const root = typeof process.getuid === 'function' && process.getuid() === 0;

// every entry under dir (not following links): [relative path, lstat]
function walk(dir) {
  const out = [];
  (function w(rel) {
    for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n, st = fs.lstatSync(path.join(dir, r));
      out.push([r, st]);
      if (st.isDirectory()) w(r);
    }
  })('');
  return out;
}
const chmodTree = (dir) => { for (const [r, st] of [['', fs.lstatSync(dir)], ...walk(dir)]) if (!st.isSymbolicLink()) fs.chmodSync(path.join(dir, r), (st.mode | 0o200) & 0o7777); };
const readOnly = (dir) => { for (const [r, st] of [['', fs.lstatSync(dir)], ...walk(dir)]) if (!st.isSymbolicLink()) fs.chmodSync(path.join(dir, r), st.mode & ~0o222 & 0o7777); };
const writable = (dir) => [['', fs.lstatSync(dir)], ...walk(dir)].filter(([, st]) => !st.isSymbolicLink() && (st.mode & 0o222)).map(([r]) => r || '.');

try {
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"p"}\n');
  fs.writeFileSync(path.join(src, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const files = ['package.json', 'package-lock.json'].map((b) => ({ base: b, path: path.join(src, b) }));
  const count = path.join(T, 'install.count'), okSeen = path.join(T, 'ok.seen');
  // The install: a tree with a nested directory, an executable, a link inside the cache (as pkg's node_modules on a
  // Mac); it notes whether <hash>.ok existed while it ran.
  const install = (extra) => `[ -e ../h1.ok ] && echo yes >> "${okSeen}"; mkdir -p nm.real/vite/bin && echo '{"name":"vite"}' > nm.real/vite/package.json && printf '#!/bin/sh\\n' > nm.real/vite/bin/vite && chmod 755 nm.real/vite/bin/vite && ln -s nm.real node_modules && echo "$PWD" >> "${count}"${extra || ''}`;
  const run = (cmd, cwd) => { const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }); if (r.status !== 0) throw new Error(`install failed (exit ${r.status}): ${r.stderr}`); };
  const said = [];
  const call = (cmd) => { said.length = 0; return H.depsCache({ deps, hash: 'h1', files, install: cmd || install(), run, say: (s) => said.push(s), phase: (s) => said.push(s) }); };
  const installs = () => (read(count) || '').split('\n').filter(Boolean).length;
  const cache = path.join(deps, 'h1');

  ok('depsCache is exported by the host', typeof H.depsCache === 'function');
  if (typeof H.depsCache !== 'function') throw new Error('no depsCache');

  // D-7: no cache for the hash - installed once, then read-only, then .ok with its manifest.
  const c1 = call();
  ok('D-7: a new hash - the install ran once, in <deps>/<hash>', c1 === cache && installs() === 1 && fs.realpathSync((read(count) || '').trim()) === cache, read(count));
  ok('D-7: after the install no entry of the cache has a write bit (files, directories, the cache itself)', writable(cache).length === 0, writable(cache).join(', '));
  ok('D-7: the install ran before <hash>.ok existed; .ok is written after', !fs.existsSync(okSeen) && fs.existsSync(`${cache}.ok`));
  const okv = (() => { try { return JSON.parse(read(`${cache}.ok`)); } catch { return null; } })();
  ok('D-7: <hash>.ok carries the manifest of the cache (entries and their digest)', okv && okv.v === 1 && typeof okv.manifest === 'string' && okv.entries === walk(cache).length, read(`${cache}.ok`));
  ok('D-7: the link inside the cache stays a link, the executable stays executable', fs.lstatSync(path.join(cache, 'node_modules')).isSymbolicLink() && (fs.statSync(path.join(cache, 'nm.real/vite/bin/vite')).mode & 0o111) === 0o111);

  // D-9 / D-6: a run's tool cannot write into the read-only cache (vite's .vite-temp in node_modules).
  if (root) skip('D-9: a write into the cache is refused', 'running as root: permissions do not bind');
  else {
    let err = null;
    try { fs.mkdirSync(path.join(cache, 'node_modules', '.vite-temp')); } catch (e) { err = e; }
    ok('D-9: a write into node_modules of the cache (vite\'s .vite-temp) is refused (EACCES)', err && err.code === 'EACCES', err && err.code);
    err = null;
    try { fs.rmSync(path.join(cache, 'nm.real', 'vite', 'package.json')); } catch (e) { err = e; }
    ok('D-9: removing a file of the cache is refused (EACCES)', err && (err.code === 'EACCES' || err.code === 'EPERM'), err && err.code);
  }

  // D-1: the same hash, the cache complete - taken from the cache, nothing installed, nothing changed.
  const before = JSON.stringify(walk(cache).map(([r, st]) => [r, st.mode, st.size, st.mtimeMs]));
  call();
  ok('D-1: the same hash, a complete cache - "from the cache", no install', installs() === 1 && said.some((s) => /from the cache/.test(s)), said.join(' | '));
  ok('D-1: the cache is unchanged by the reuse', JSON.stringify(walk(cache).map(([r, st]) => [r, st.mode, st.size, st.mtimeMs])) === before);

  // D-2 + D-8: .ok is there, the cache lost a file (an npm ci elsewhere emptied it) - not trusted: installed again,
  // the write bits taken back first, read-only again after.
  chmodTree(path.join(cache, 'nm.real', 'vite'));
  fs.rmSync(path.join(cache, 'nm.real', 'vite', 'package.json'));
  readOnly(cache);
  call();
  ok('D-2: .ok there but a file missing - not "from the cache": incomplete, installed again', installs() === 2 && !said.some((s) => /from the cache/.test(s)) && said.some((s) => /incomplete/.test(s)), said.join(' | '));
  ok('D-8: the read-only incomplete cache was replaced (the write bits back, removed, installed) and is complete again', fs.existsSync(path.join(cache, 'nm.real', 'vite', 'package.json')));
  ok('D-8: read-only again after the reinstall, with a new .ok', writable(cache).length === 0 && fs.existsSync(`${cache}.ok`), writable(cache).join(', '));
  call();
  ok('D-8: the reinstalled cache is taken from the cache next time', installs() === 2 && said.some((s) => /from the cache/.test(s)), said.join(' | '));

  // D-2: an entry added (a write that passed: the cache made writable by hand) - the cache differs from its manifest.
  chmodTree(path.join(cache, 'nm.real'));
  fs.mkdirSync(path.join(cache, 'nm.real', '.vite-temp'));
  call();
  ok('D-2: an entry the install did not make (and write bits) - installed again, read-only again', installs() === 3 && !fs.existsSync(path.join(cache, 'nm.real', '.vite-temp')) && writable(cache).length === 0, said.join(' | '));

  // D-2: a file of the same name and another size (a truncated file).
  chmodTree(cache);
  fs.writeFileSync(path.join(cache, 'nm.real', 'vite', 'package.json'), '{}');
  readOnly(cache);
  call();
  ok('D-2: a file of another size - installed again', installs() === 4, said.join(' | '));

  // An .ok of the earlier format (a time stamp, no manifest): completeness cannot be checked - installed again.
  fs.writeFileSync(`${cache}.ok`, new Date().toISOString() + '\n');
  call();
  ok('D-2: an .ok without a manifest (earlier format) - installed again, the new .ok has the manifest', installs() === 5 && /"manifest"/.test(read(`${cache}.ok`) || ''), read(`${cache}.ok`));

  // A failed reinstall: an environment error, no .ok left (the next run installs again, never "from the cache").
  fs.writeFileSync(`${cache}.ok`, 'stale\n');
  let err = null;
  try { call(install('; exit 3')); } catch (e) { err = e; }
  ok('a failed install throws and leaves no <hash>.ok', err && !fs.existsSync(`${cache}.ok`), err && err.message);
  call();
  ok('after a failed install the next call installs again and succeeds', installs() === 7 && fs.existsSync(`${cache}.ok`) && writable(cache).length === 0);

  // The cache path a link: refused (never chmod or remove through a link).
  const elsewhere = path.join(T, 'elsewhere'); fs.mkdirSync(path.join(elsewhere, 'keep'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(deps, 'h2'));
  err = null;
  try { H.depsCache({ deps, hash: 'h2', files, install: install(), run, say: () => {}, phase: () => {} }); } catch (e) { err = e; }
  ok('a cache path that is a link is refused, its target untouched', err && fs.existsSync(path.join(elsewhere, 'keep')), err && err.message);

  // The rule and README say it (same commit as the behaviour).
  const rules = read(path.join(ROOT, 'rules', 'multi-agent.md')), readme = read(path.join(ROOT, 'README.md'));
  ok('rule: the dependency cache of the runner is read-only and checked by its manifest; manual clones never link into it',
    /read-only/.test(rules.split('**With a remote runner')[1].split('\n- **')[0]) && /manifest/.test(rules.split('**With a remote runner')[1].split('\n- **')[0])
      && /never[^.]*link[^.]*node_modules[^.]*cache|never[^.]*cache[^.]*link/i.test(rules.split('**With a remote runner')[1].split('\n- **')[0]));
  ok('README: guards-remote-host.js and remoteRun.deps name the read-only cache and the manifest check',
    /\| `scripts\/guards-remote-host\.js` \|[^\n]*read-only[^\n]*manifest/.test(readme) && /\| `remoteRun` \|[^\n]*read-only/.test(readme));
  void has;
} catch (e) {
  ok('no exception', false, e && e.stack);
}
try { chmodTree(T); } catch { /* best effort */ }
fs.rmSync(T, { recursive: true, force: true });
done();
