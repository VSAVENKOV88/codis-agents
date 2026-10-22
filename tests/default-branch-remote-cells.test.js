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

    console.log('C7. the pushed URL is also the name of a configured remote whose uploadpack points ls-remote elsewhere');
    // ls-remote with a URL that names a configured remote takes that remote's settings; remote.<name>.uploadpack is
    // fetch-only (a push runs receivepack), and --get-url still prints the same URL (experiment, git 2.50).
    fs.symlinkSync(real, path.join(clone, 'realrepo'));
    fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), 'realrepo\n');
    git(clone, 'remote', 'set-url', 'origin', 'realrepo');
    git(clone, 'config', 'remote.realrepo.url', 'realrepo');
    git(clone, 'config', 'remote.realrepo.uploadpack', `git-upload-pack '${fake}' #`);
    ok('C7 setup: get-url unchanged, ls-remote answers fake.git (feat)',
      git(clone, 'ls-remote', '--get-url', '--', 'realrepo').stdout.trim() === 'realrepo'
      && /^ref: refs\/heads\/feat\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', '--', 'realrepo', 'HEAD').stdout));
    commit(clone, 'c7.txt');
    let t7 = rev(real, 'refs/heads/trunk');
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C7 the push goes to real.git: refused, real trunk unchanged', p.status !== 0 && rev(real, 'refs/heads/trunk') === t7, (p.stderr || '').trim().split('\n').join(' | '));
    git(clone, 'config', '--remove-section', 'remote.realrepo');
    git(clone, 'remote', 'set-url', 'origin', real);

    console.log('C8. the pushed URL (a path to real.git) is also the name of another remote whose url is fake.git');
    fs.symlinkSync(real, path.join(clone, 'evil'));
    fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), 'evil\n');
    git(clone, 'remote', 'add', 'evil', fake);
    git(clone, 'remote', 'set-url', 'origin', 'evil');
    ok('C8 setup: ls-remote of the pushed URL answers fake.git (feat)', /^ref: refs\/heads\/feat\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', '--', 'evil', 'HEAD').stdout));
    commit(clone, 'c8.txt');
    t7 = rev(real, 'refs/heads/trunk');
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C8 refused, real trunk unchanged', p.status !== 0 && rev(real, 'refs/heads/trunk') === t7, p.stderr);
    git(clone, 'remote', 'set-url', 'origin', real);
    git(clone, 'remote', 'remove', 'evil');

    console.log('C9. the rewrite given on the push command line (git -c), not in the config file');
    p = spawnSync('git', ['-C', clone, '-c', `url.${fake}.insteadOf=${real}`, '-c', `url.${real}.pushInsteadOf=${real}`, 'push', 'origin', 'HEAD:trunk'], { encoding: 'utf8', env: withCfg(plain) });
    ok('C9 refused with the rewrite named, real trunk unchanged', p.status !== 0 && /rewrites/.test(p.stderr) && rev(real, 'refs/heads/trunk') === t7, p.stderr);

    console.log('C10. a rewrite that a push and a fetch both follow (url.<real>.insteadOf = short name): no false refusal');
    git(clone, 'config', `url.${real}.insteadOf`, 'short:');
    git(clone, 'remote', 'set-url', 'origin', 'short:');
    p = push(clone, plain, '-q', 'origin', 'HEAD:b-c10');
    ok('C10 a working branch goes through to real.git', p.status === 0 && rev(real, 'refs/heads/b-c10') !== '', p.stderr);
    commit(clone, 'c10.txt');   // something new for trunk, whatever the cells above did
    t7 = rev(real, 'refs/heads/trunk');
    p = push(clone, plain, 'origin', 'HEAD:trunk');
    ok('C10 trunk refused as the default branch (not as an unknown one)', p.status !== 0 && blocked('trunk').test(p.stderr) && !/unknown/.test(p.stderr) && rev(real, 'refs/heads/trunk') === t7, p.stderr);
    git(clone, 'remote', 'set-url', 'origin', real);
    git(clone, 'config', '--unset', `url.${real}.insteadOf`);

    // Round 3: the pushed URL (rr, a link to real.git) names a remote outside the git config keys, or through scopes
    // other than the local file and git -c. Each cell pushes a new commit to trunk; the push must be refused and real
    // trunk must stay where it was.
    const viaRepo = (label, run, extra) => {
      commit(clone, label.replace(/\W/g, '') + '.txt');
      const t = rev(real, 'refs/heads/trunk');
      const q = run();
      ok(`${label}: refused, real trunk unchanged`, q.status !== 0 && blocked('trunk').test(q.stderr) && rev(real, 'refs/heads/trunk') === t && (!extra || extra.test(q.stderr)), (q.stderr || '').trim().split('\n').join(' | '));
    };
    fs.symlinkSync(real, path.join(clone, 'rr'));
    fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), 'rr\n');
    git(clone, 'remote', 'set-url', 'origin', 'rr');
    const upFake = `git-upload-pack '${fake}' #`;
    const answersFeat = (r) => /^ref: refs\/heads\/feat\tHEAD$/m.test(r.stdout);

    console.log('C12. a legacy remote file .git/remotes/<URL> or .git/branches/<URL> (no git config key) points the query at fake.git');
    for (const [kind, body] of [['remotes', `URL: ${fake}\n`], ['branches', `${fake}\n`]]) {
      const f = path.join(clone, '.git', kind, 'rr');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
      ok(`C12 setup (${kind}): ls-remote of the pushed URL answers fake.git (feat)`, answersFeat(git(clone, 'ls-remote', '--symref', '--', 'rr', 'HEAD')));
      viaRepo(`C12 .git/${kind}/rr`, () => push(clone, plain, 'origin', 'HEAD:trunk'), /unknown/);
      fs.rmSync(f);
    }

    console.log('C13. remote.<URL>.uploadpack from include.path, from GIT_CONFIG_COUNT on the push, and as -c with an upper-case section');
    const inc = path.join(dir, 'inc.cfg');
    fs.writeFileSync(inc, `[remote "rr"]\n\tuploadpack = "${upFake}"\n`);
    git(clone, 'config', 'include.path', inc);
    ok('C13 setup (include.path): ls-remote answers fake.git (feat)', answersFeat(git(clone, 'ls-remote', '--symref', '--', 'rr', 'HEAD')));
    viaRepo('C13 include.path', () => push(clone, plain, 'origin', 'HEAD:trunk'), /remote\.rr\.uploadpack/);
    git(clone, 'config', '--unset', 'include.path');
    const countEnv = Object.assign(withCfg(plain), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.rr.uploadpack', GIT_CONFIG_VALUE_0: upFake });
    ok('C13 setup (GIT_CONFIG_COUNT): ls-remote answers fake.git (feat)', answersFeat(spawnSync('git', ['-C', clone, 'ls-remote', '--symref', '--', 'rr', 'HEAD'], { encoding: 'utf8', env: countEnv })));
    viaRepo('C13 GIT_CONFIG_COUNT on the push', () => spawnSync('git', ['-C', clone, 'push', 'origin', 'HEAD:trunk'], { encoding: 'utf8', env: countEnv }), /remote\.rr\.uploadpack/);
    viaRepo('C13 git -c REMOTE.rr.UPLOADPACK', () => spawnSync('git', ['-C', clone, '-c', `REMOTE.rr.UPLOADPACK=${upFake}`, 'push', 'origin', 'HEAD:trunk'], { encoding: 'utf8', env: withCfg(plain) }), /remote\.rr\.uploadpack/);
    git(clone, 'remote', 'set-url', 'origin', real);
    p = push(clone, plain, '-q', 'origin', 'HEAD:b-c13');
    ok('C13 back to the plain URL: a working branch goes through', p.status === 0 && rev(real, 'refs/heads/b-c13') !== '', p.stderr);

    // C16 (tester round 4): a remote whose url is empty - git falls back to the remote name as the URL (experiment,
    // git 2.50: `git push o` with remote.o.url "" pushes to the path "o" and passes the hook "o" as the URL), so the
    // pushed URL is the name of a configured remote by construction; with remote.<name>.uploadpack at fake.git the
    // query would answer feat. A real push to trunk must be refused with the remote-name reason on every git version
    // (the name check runs before --get-url, which git 2.43 may answer differently for such a remote).
    console.log('C16. a remote with an empty url (git pushes to its name as a path) and uploadpack at fake.git');
    fs.symlinkSync(real, path.join(clone, 'ee'));
    fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), 'ee\n');
    git(clone, 'config', 'remote.ee.url', '');
    git(clone, 'config', 'remote.ee.uploadpack', upFake);
    ok('C16 setup: ls-remote of the name answers fake.git (feat)', answersFeat(git(clone, 'ls-remote', '--symref', '--', 'ee', 'HEAD')));
    viaRepo('C16 git push ee HEAD:trunk', () => push(clone, plain, 'ee', 'HEAD:trunk'), /remote\.ee\.(url|uploadpack)/);
    git(clone, 'config', '--remove-section', 'remote.ee');

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
