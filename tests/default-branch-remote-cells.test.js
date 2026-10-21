#!/usr/bin/env node
'use strict';
// p-head2, tester cells next to default-branch-remote.test.js: every form of moving the local refs/remotes/origin/HEAD
// the brief names (git remote set-head, git update-ref --no-deref with a plain value) followed by a real git push to the
// remote's default branch; push forms that are not "origin <branch>" (deletion, several refs at once, another remote
// name, a bare URL, pushurl other than url); protectedBranches [] with the remote unreachable; the timeout of the
// remote query; and a fetch-only URL rewrite (url.<x>.insteadOf) in the local git config: the push goes to the real
// remote (pushInsteadOf wins for a push, git-config(1)), so the remote's answer must come from that same URL, not from
// the one ls-remote rewrites it to (experiment, git 2.50: ls-remote --symref follows insteadOf to another repository).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, 'scripts', 'git-hooks');
const { remoteHead } = require(path.join(ROOT, 'scripts', 'config.js'));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-remote-cells-')));
const env = { HOME: dir, PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env });
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const withCfg = (cfg) => Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {});
const push = (cwd, cfg, ...a) => spawnSync('git', ['-C', cwd, 'push', ...a], { encoding: 'utf8', env: withCfg(cfg) });
const prePush = (cwd, url, rref, cfg) => spawnSync(path.join(HOOKS, 'pre-push'), ['origin', url],
  { cwd, input: `refs/heads/x ${'1'.repeat(40)} ${rref} ${'0'.repeat(40)}\n`, encoding: 'utf8', env: withCfg(cfg) });
const rev = (d, ref) => git(d, 'rev-parse', '--verify', '--quiet', ref).stdout.trim();
const blocked = (b) => new RegExp(`push to ${b} is blocked`);

let server;
(async () => {
  try {
    fs.writeFileSync(path.join(dir, '.gitconfig'), '[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = trunk\n');
    // real.git: HEAD -> trunk; fake.git: HEAD -> feat (what a redirect would answer instead).
    const real = path.join(dir, 'real.git'), fake = path.join(dir, 'fake.git'), clone = path.join(dir, 'clone');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', real], { env });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'feat', fake], { env });
    spawnSync('git', ['clone', '-q', real, clone], { env });
    commit(clone, 'a.txt');
    git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/feat');
    git(clone, 'push', '-q', fake, 'HEAD:refs/heads/feat');
    git(clone, 'fetch', '-q', 'origin');
    git(clone, 'config', 'core.hooksPath', HOOKS);
    const plain = cfgFile('plain', { repoDir: clone });
    const trunk0 = rev(real, 'refs/heads/trunk');
    const trunkSame = () => rev(real, 'refs/heads/trunk') === trunk0;
    ok('setup: the remote names trunk, fake.git names feat',
      /^ref: refs\/heads\/trunk\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', real, 'HEAD').stdout)
      && /^ref: refs\/heads\/feat\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', fake, 'HEAD').stdout));

    console.log('C1. git remote set-head origin feat, then a real push to trunk');
    let r = git(clone, 'remote', 'set-head', 'origin', 'feat');
    ok('C1 setup: set-head moved origin/HEAD to origin/feat', r.status === 0 && git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim() === 'origin/feat', r.stderr);
    commit(clone, 'b.txt');
    let p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C1 refused by pre-push, remote trunk unchanged', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    p = push(clone, null, 'origin', 'HEAD:trunk');
    ok('C1 without any config: refused, remote trunk unchanged', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);

    console.log('C2. git update-ref --no-deref origin/HEAD to a plain value (no symref), then a real push');
    git(clone, 'update-ref', '--no-deref', 'refs/remotes/origin/HEAD', rev(clone, 'refs/remotes/origin/feat'));
    ok('C2 setup: origin/HEAD is no symref now', git(clone, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').status !== 0 && rev(clone, 'refs/remotes/origin/HEAD') !== '');
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C2 refused by pre-push, remote trunk unchanged', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    p = push(clone, plain, '-q', 'origin', 'HEAD:b-c2');
    ok('C2 a working branch goes through (the remote names trunk)', p.status === 0 && rev(real, 'refs/heads/b-c2') !== '', p.stderr);
    git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');

    console.log('C3. other push forms to the default branch');
    p = push(clone, plain, 'origin', ':trunk');
    ok('C3 deletion of trunk refused, trunk still there', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    p = push(clone, plain, 'origin', 'HEAD:b-c3', 'HEAD:trunk');
    ok('C3 several refs, trunk among them: refused, nothing updated', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame() && rev(real, 'refs/heads/b-c3') === '', p.stderr);
    git(clone, 'remote', 'add', 'up', real);
    p = push(clone, plain, 'up', 'HEAD:trunk');
    ok('C3 another remote name (up) at the same repository: refused', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    p = push(clone, plain, real, 'HEAD:trunk');
    ok('C3 a bare URL in place of a remote name: refused', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    git(clone, 'remote', 'set-url', 'origin', fake);
    git(clone, 'remote', 'set-url', '--push', 'origin', real);
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C3 url -> fake.git (HEAD feat), pushurl -> real.git: the push URL is asked, refused', p.status !== 0 && blocked('trunk').test(p.stderr) && trunkSame(), p.stderr);
    git(clone, 'remote', 'set-url', 'origin', real);
    git(clone, 'config', '--unset', 'remote.origin.pushurl');

    console.log('C4. a fetch-only URL rewrite in the local git config points ls-remote at another repository');
    git(clone, 'config', `url.${fake}.insteadOf`, real);
    git(clone, 'config', `url.${real}.pushInsteadOf`, real);
    ok('C4 setup: ls-remote of the real URL now answers fake.git (feat)', /^ref: refs\/heads\/feat\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', real, 'HEAD').stdout));
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C4 the push still goes to real.git: refused there, real trunk unchanged', p.status !== 0 && trunkSame(), (p.stderr || '').trim().split('\n').join(' | '));
    git(clone, 'config', '--unset', `url.${fake}.insteadOf`);
    git(clone, 'config', '--unset', `url.${real}.pushInsteadOf`);
    commit(clone, 'c4.txt');   // something new to push even if the push above went through
    const trunk4 = rev(real, 'refs/heads/trunk');
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C4 rewrite removed: refused as before', p.status !== 0 && blocked('trunk').test(p.stderr) && rev(real, 'refs/heads/trunk') === trunk4, p.stderr);

    console.log('C5. protectedBranches [] with the remote unreachable');
    const none = cfgFile('none', { repoDir: clone, protectedBranches: [] });
    p = prePush(clone, path.join(dir, 'gone.git'), 'refs/heads/trunk', none);
    ok('C5 nothing protected by the config: trunk allowed without the remote', p.status === 0 && !/unknown/.test(p.stderr), p.stderr);

    console.log('C6. a remote that accepts the connection and never answers: the query times out');
    server = net.createServer(() => {});   // the kernel completes the handshake; nothing is ever sent
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const t0 = Date.now();
    const h = remoteHead(`git://127.0.0.1:${server.address().port}/x.git`, clone, 1500);
    const ms = Date.now() - t0;
    ok('C6 no branch, a reason, and within the timeout (not the git default)', !h.branch && /failed/.test(h.why || '') && ms < 10000, JSON.stringify(h) + ' ' + ms + ' ms');
  } finally {
    if (server) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  done();
})();
