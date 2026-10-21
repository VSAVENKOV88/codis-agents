#!/usr/bin/env node
'use strict';
// p-head2: pre-push takes the default branch from the remote it pushes to (git ls-remote --symref -- <url> HEAD,
// git-ls-remote(1)), or from defaultBranch / protectedBranches of the config - never from the local
// refs/remotes/origin/HEAD, which any wrapper the session hook does not see can move (experiment, git 2.50: after a
// local `git remote set-head origin feat`, ls-remote --symref of the remote still answers `ref: refs/heads/trunk`).
// The remote unreachable (or without a HEAD it names) and no key in the config: every branch push is refused with the
// reason (fail closed). Owner 2026-10-21 (question 31): "without the network - refusal".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, 'scripts', 'git-hooks');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-remote-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH, LC_ALL: 'C' };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8', env });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const withCfg = (cfg) => Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {});
// The hook run directly, as git runs it: argv remote name and URL, stdin "<lref> <lsha> <rref> <rsha>".
const prePush = (cwd, url, rref, cfg) => spawnSync(path.join(HOOKS, 'pre-push'), ['origin', url],
  { cwd, input: `refs/heads/x ${'1'.repeat(40)} ${rref} ${'0'.repeat(40)}\n`, encoding: 'utf8', env: withCfg(cfg) });
const push = (cwd, cfg, ...a) => spawnSync('git', ['-C', cwd, 'push', ...a], { encoding: 'utf8', env: withCfg(cfg) });
const remoteHas = (o, ref) => git(o, 'show-ref', '--verify', '--quiet', ref).status === 0;
const blocked = (b) => new RegExp(`push to ${b} is blocked`);
const unknownRe = /protected branches unknown/;

try {
  // origin.git: bare, HEAD -> trunk, branches trunk and feat. clone: its clone with local origin/HEAD moved to feat
  // (what a wrapper such as `bash -c 'git remote set-head origin feat'` does past the session hook).
  const origin = path.join(dir, 'origin.git'), clone = path.join(dir, 'clone'), empty = path.join(dir, 'empty.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, clone], { env });
  ident(clone); commit(clone, 'a.txt');
  git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/feat');
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
  ok('setup: local origin/HEAD -> origin/feat', git(clone, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim() === 'origin/feat');
  ok('setup: the remote still names trunk', /^ref: refs\/heads\/trunk\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', origin, 'HEAD').stdout));
  git(clone, 'config', 'core.hooksPath', HOOKS);
  commit(clone, 'b.txt');   // something new to push, or git skips the hook ("Everything up-to-date")
  const plain = cfgFile('plain', { repoDir: clone });
  const trunkBefore = git(origin, 'rev-parse', 'refs/heads/trunk').stdout.trim();

  console.log('R1. local origin/HEAD moved, remote reachable, no keys in the config');
  let p = push(clone, plain, 'origin', 'HEAD:trunk');
  ok('R1 real git push origin HEAD:trunk refused by pre-push (the remote names trunk), remote trunk unchanged',
    p.status !== 0 && blocked('trunk').test(p.stderr) && git(origin, 'rev-parse', 'refs/heads/trunk').stdout.trim() === trunkBefore, p.stderr);
  commit(clone, 'c.txt');   // new again: if the first push got through, the second must still have something to push
  p = push(clone, null, 'origin', 'HEAD:trunk');
  ok('R1 the same without any config (defaults): refused, remote trunk unchanged',
    p.status !== 0 && blocked('trunk').test(p.stderr) && git(origin, 'rev-parse', 'refs/heads/trunk').stdout.trim() === trunkBefore, p.stderr);
  p = push(clone, plain, '-q', 'origin', 'HEAD:feat');
  ok('R2 real git push origin HEAD:feat (a working branch on the remote) goes through', p.status === 0, p.stderr);
  p = push(clone, plain, '-q', 'origin', 'HEAD:b-t1');
  ok('R2 real git push of a new working branch b-t1 goes through', p.status === 0 && remoteHas(origin, 'refs/heads/b-t1'), p.stderr);
  p = prePush(clone, origin, 'refs/heads/trunk', plain);
  ok('R1 pre-push run directly with the URL of the remote: trunk blocked', p.status === 1 && blocked('trunk').test(p.stderr), p.stderr);

  console.log('R3. local origin/HEAD deleted, remote reachable');
  git(clone, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  ok('R3 trunk still blocked: the remote names it', blocked('trunk').test(prePush(clone, origin, 'refs/heads/trunk', plain).stderr));
  p = prePush(clone, origin, 'refs/heads/b-t1', plain);
  ok('R3 b-t1 allowed: the default branch is known from the remote', p.status === 0, p.stderr);
  git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');

  console.log('R4. remote unreachable, no keys in the config: refusal with the reason');
  const gone = path.join(dir, 'gone.git');
  p = prePush(clone, gone, 'refs/heads/b-t1', plain);
  ok('R4 a working branch refused although local origin/HEAD is set', p.status === 1 && unknownRe.test(p.stderr), p.stderr);
  ok('R4 the reason names the remote query and the fix in the config', /ls-remote/.test(p.stderr) && /defaultBranch/.test(p.stderr) && p.stderr.includes(gone), p.stderr);
  ok('R4 the reason says the remote did not answer (not that it named no branch)', /failed/.test(p.stderr) && !/names no branch/.test(p.stderr), p.stderr);
  p = prePush(clone, gone, 'refs/heads/b-t1', null);
  ok('R4 the same without any config', p.status === 1 && unknownRe.test(p.stderr), p.stderr);
  p = prePush(clone, 'https://127.0.0.1:9/x.git', 'refs/heads/b-t1', plain);
  ok('R4 a network URL that does not answer: refused', p.status === 1 && unknownRe.test(p.stderr), p.stderr);
  p = prePush(clone, '--upload-pack=touch ' + path.join(dir, 'pwned'), 'refs/heads/b-t1', plain);
  ok('R4 a URL that looks like an option is not taken as one: refused, nothing run', p.status === 1 && unknownRe.test(p.stderr) && !fs.existsSync(path.join(dir, 'pwned')), p.stderr);

  console.log('R5. remote without a HEAD it names (an empty repository)');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', empty]);
  p = prePush(clone, empty, 'refs/heads/b-t1', plain);
  ok('R5 empty remote, no keys: refused with the reason', p.status === 1 && unknownRe.test(p.stderr), p.stderr);
  ok('R5 the reason says the remote named no branch', /names no branch/.test(p.stderr), p.stderr);

  console.log('R6. the config decides without the network');
  const keyed = cfgFile('keyed', { repoDir: clone, defaultBranch: 'trunk' });
  ok('R6 defaultBranch trunk, remote unreachable: trunk blocked', blocked('trunk').test(prePush(clone, gone, 'refs/heads/trunk', keyed).stderr));
  p = prePush(clone, gone, 'refs/heads/b-t1', keyed);
  ok('R6 defaultBranch trunk, remote unreachable: b-t1 allowed', p.status === 0, p.stderr);
  p = prePush(clone, gone, 'refs/heads/feat', keyed);
  ok('R6 defaultBranch trunk: feat allowed (the local origin/HEAD -> feat is not read)', p.status === 0, p.stderr);
  const prot = cfgFile('prot', { repoDir: clone, protectedBranches: ['release'] });
  ok('R6 protectedBranches [release], remote unreachable: release blocked', blocked('release').test(prePush(clone, gone, 'refs/heads/release', prot).stderr));
  p = prePush(clone, gone, 'refs/heads/trunk', prot);
  ok('R6 protectedBranches [release]: trunk allowed (the config decides, not the remote)', p.status === 0, p.stderr);

  console.log('R7. tags need no branch: no remote query');
  p = prePush(clone, gone, 'refs/tags/v1.0.0', plain);
  ok('R7 protected tag refused with the tag reason', p.status === 1 && /tag refs\/tags\/v1.0.0 is blocked/.test(p.stderr) && !unknownRe.test(p.stderr), p.stderr);
  p = prePush(clone, gone, 'refs/tags/build-1', plain);
  ok('R7 an unprotected tag goes through with the remote unreachable', p.status === 0, p.stderr);
  p = spawnSync(path.join(HOOKS, 'pre-push'), ['origin', gone], { cwd: clone, input: `refs/heads/x ${'1'.repeat(40)} refs/heads/b-t1 ${'0'.repeat(40)}\n`, encoding: 'utf8', env: Object.assign(withCfg(plain), { ALLOW_PROTECTED_PUSH: '1' }) });
  ok('R7 ALLOW_PROTECTED_PUSH=1 still lets it through', p.status === 0, p.stderr);
  console.log('R8. a URL rewrite (url.<base>.insteadOf) would point the query at another repository: refusal');
  // ls-remote is a fetch and follows insteadOf; a push follows pushInsteadOf first, so the hook's answer could come
  // from a repository the push does not go to (tester round 1, C4). git ls-remote --get-url shows the rewrite.
  const other = path.join(dir, 'other.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'feat', other]);
  git(clone, 'push', '-q', '--no-verify', other, 'HEAD:refs/heads/feat');
  ok('R8 setup: other.git names feat', /^ref: refs\/heads\/feat\tHEAD$/m.test(git(clone, 'ls-remote', '--symref', other, 'HEAD').stdout));
  git(clone, 'config', `url.${other}.insteadOf`, origin);
  p = prePush(clone, origin, 'refs/heads/b-t1', plain);
  ok('R8 insteadOf rewrites the push URL for the query: refused', p.status === 1 && unknownRe.test(p.stderr), p.stderr);
  ok('R8 the reason names the rewrite and the address it would go to', /rewrit/.test(p.stderr) && p.stderr.includes(other), p.stderr);
  git(clone, 'config', '--unset', `url.${other}.insteadOf`);
  git(clone, 'config', `url.${other}.insteadOf`, path.join(dir, 'nomatch'));
  p = prePush(clone, origin, 'refs/heads/b-t1', plain);
  ok('R8 an insteadOf that does not match the URL changes nothing: b-t1 allowed', p.status === 0, p.stderr);
  git(clone, 'config', '--unset', `url.${other}.insteadOf`);

  console.log('R9. the reason quotes the first fatal line of ls-remote, not the last line of its advice');
  p = prePush(clone, gone, 'refs/heads/b-t1', plain);
  const { remoteHead } = require(path.join(ROOT, 'scripts', 'config.js'));
  const e = remoteHead('', clone);
  ok('R9 the address check itself failing (empty URL): no branch, its own reason', !e.branch && /--get-url -- {2}failed \(fatal: bad repository/.test(e.why || ''), JSON.stringify(e));
  ok('R9 a missing repository: the reason says it is not a git repository', /does not appear to be a git repository/.test(p.stderr) && !/repository exists\.\)/.test(p.stderr), p.stderr);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
