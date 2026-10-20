#!/usr/bin/env node
'use strict';
// The default branch comes from git, not from a literal: config key defaultBranch, else what refs/remotes/origin/HEAD
// points to (git clone sets it; only the remote "origin" is read). protectedBranches without the key = [defaultBranch].
// Not derivable -> config.js check still passes, json says why; the hooks (guard-bash.js, pre-push) refuse every branch
// push (fail closed) and wt-setup.sh without a base exits 78 creating nothing. A repository whose default is master.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const sha = (d, ref) => git(d, 'rev-parse', ref).stdout.trim();
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const cli = (args, e = {}) => spawnSync('node', [path.join(ROOT, 'scripts', 'config.js'), ...args], { cwd: dir, encoding: 'utf8', env: Object.assign({}, env, e) });
const json = (f) => { const r = cli(['json', f]); try { return JSON.parse(r.stdout); } catch { return { status: r.status, err: r.stderr }; } };
const bash = (command, cwd, cfg) => decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}));
const prePush = (cwd, rref, cfg) => spawnSync(path.join(ROOT, 'scripts', 'git-hooks', 'pre-push'), ['origin', 'url'],
  { cwd, input: `refs/heads/x ${'1'.repeat(40)} ${rref} ${'0'.repeat(40)}\n`, encoding: 'utf8', env: Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}) });

try {
  // origin.git: a bare repository whose HEAD is master; repo: its clone (origin/HEAD -> origin/master), with a local
  // branch main one commit ahead (a literal main would show), release and develop; norem: no remote at all.
  const seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), norem = path.join(dir, 'norem');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'master'); ident(seed); commit(seed, 'a.txt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(seed, 'push', '-q', origin, 'master');
  spawnSync('git', ['clone', '-q', origin, repo]); ident(repo);
  for (const b of ['main', 'release', 'develop', 'b-t1']) { git(repo, 'checkout', '-q', '-b', b, 'master'); commit(repo, b + '.txt'); }
  git(repo, 'checkout', '-q', 'master');
  fs.mkdirSync(norem); git(norem, 'init', '-q', '-b', 'master'); ident(norem); commit(norem, 'a.txt'); git(norem, 'branch', 'b-t1');
  ok('setup: the clone has origin/HEAD -> origin/master', git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim() === 'origin/master');

  console.log('B. defaultBranch and protectedBranches');
  const plain = cfgFile('plain', { repoDir: repo });
  let j = json(plain);
  ok('B1 no keys, origin/HEAD -> master: json defaultBranch master, protectedBranches [master]',
    j.defaultBranch === 'master' && JSON.stringify(j.protectedBranches) === '["master"]', JSON.stringify(j));
  j = json(cfgFile('explicit', { repoDir: repo, protectedBranches: ['main'] }));
  ok('B2 explicit protectedBranches [main] -> as in the config', JSON.stringify(j.protectedBranches) === '["main"]', JSON.stringify(j));
  const develop = cfgFile('develop', { repoDir: repo, defaultBranch: 'develop' });
  j = json(develop);
  ok('B3 defaultBranch develop, no protectedBranches -> [develop]', j.defaultBranch === 'develop' && JSON.stringify(j.protectedBranches) === '["develop"]', JSON.stringify(j));
  const unknown = cfgFile('unknown', { repoDir: norem });
  const chk = cli(['check', unknown]);
  ok('B4 no keys, no origin/HEAD: config.js check still passes', chk.status === 0, chk.stdout + chk.stderr);
  ok('B4 check names the problem in a note', /origin\/HEAD/.test(chk.stderr) && /defaultBranch/.test(chk.stderr), chk.stderr);
  j = json(unknown);
  ok('B4 json: defaultBranch and protectedBranches null, the reason given', j.defaultBranch === null && j.protectedBranches === null
    && /origin\/HEAD/.test(j.defaultBranchUnknown || '') && /set-head origin --auto/.test(j.defaultBranchUnknown || ''), JSON.stringify(j));
  ok('B4 json: a known default has no reason', json(plain).defaultBranchUnknown === '', JSON.stringify(json(plain)));

  let why = bash('git push origin master', repo, plain);
  ok('B5 master repository, no keys: hook refuses git push origin master', /master is protected/.test(why || ''), String(why));
  ok('B5 master repository, no keys: hook allows git push origin b-t1', bash('git push origin b-t1', repo, plain) === null, String(bash('git push origin b-t1', repo, plain)));
  ok('B5 the derived list does not protect main', bash('git push origin main', repo, plain) === null, String(bash('git push origin main', repo, plain)));
  ok('B5 bare git push on master refused', (git(repo, 'checkout', '-q', 'master'), /master is protected/.test(bash('git push', repo, plain) || '')));
  why = bash('git push origin b-t1', norem, unknown);
  ok('B6 no keys, no origin/HEAD: hook refuses a push of any branch, with the fix', /protected branches unknown/.test(why || '')
    && /defaultBranch/.test(why || '') && /git remote set-head origin --auto/.test(why || ''), String(why));
  ok('B6 ALLOW_PROTECTED_PUSH=1 still lets it through', bash('ALLOW_PROTECTED_PUSH=1 git push origin b-t1', norem, unknown) === null);
  ok('B6 the session config of another repository does not open the push: branches come from the pushing repository',
    /protected branches unknown/.test(bash(`git -C ${norem} push origin b-t1`, repo, plain) || ''), String(bash(`git -C ${norem} push origin b-t1`, repo, plain)));

  let p = prePush(repo, 'refs/heads/master', plain);
  ok('B7 pre-push, master repository, no keys: master blocked', p.status === 1 && /push to master is blocked/.test(p.stderr), p.stderr);
  ok('B7 pre-push: b-t1 allowed', prePush(repo, 'refs/heads/b-t1', plain).status === 0, prePush(repo, 'refs/heads/b-t1', plain).stderr);
  p = prePush(repo, 'refs/heads/master');
  ok('B7 pre-push without a config: master of the clone blocked', p.status === 1 && /master/.test(p.stderr), p.stderr);
  ok('B7 pre-push without a config: b-t1 allowed', prePush(repo, 'refs/heads/b-t1').status === 0);
  p = prePush(norem, 'refs/heads/b-t1');
  ok('B6/B7 pre-push, no config, no origin/HEAD: any branch blocked with the reason', p.status === 1 && /protected branches unknown/.test(p.stderr), p.stderr);
  p = prePush(norem, 'refs/heads/b-t1', unknown);
  ok('B6/B7 pre-push, config without keys, no origin/HEAD: any branch blocked', p.status === 1 && /protected branches unknown/.test(p.stderr), p.stderr);

  for (const f of ['scripts/config.js', 'scripts/hooks/guard-bash.js', 'scripts/git-hooks/pre-push', 'scripts/wt-setup.sh', 'workflows/role-chain.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`no literal main as a branch in ${f}`, !/['"]main['"]|:-main\b|base=main/.test(src), (src.match(/.{0,40}(['"]main['"]|:-main\b|base=main).{0,20}/) || [''])[0]);
  }

  console.log('C. wt-setup.sh base');
  if (!has('zsh')) skip('C1-C5 wt-setup.sh (a zsh script)', 'zsh not found');
  else {
    const wt = (name, branch, base, cfg) => spawnSync('zsh', [path.join(ROOT, 'scripts', 'wt-setup.sh'), name, branch, ...(base ? [base] : [])],
      { encoding: 'utf8', env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: cfg }) });
    const W = (n) => path.join(dir, 'wts', n);
    let r = wt('t1', 'b-w1', null, plain);
    ok('C1 origin/HEAD -> master, no base argument: worktree from master', r.status === 0 && r.stdout.includes('ready ' + W('t1'))
      && fs.existsSync(W('t1')) && sha(W('t1'), 'HEAD') === sha(repo, 'master'), r.stdout + r.stderr);
    r = wt('t2', 'b-w2', 'release', plain);
    ok('C2 third argument release: worktree from release', r.status === 0 && sha(W('t2'), 'HEAD') === sha(repo, 'release'), r.stdout + r.stderr);
    r = wt('t3', 'b-w3', null, develop);
    ok('C3 defaultBranch develop in the config: worktree from develop', r.status === 0 && sha(W('t3'), 'HEAD') === sha(repo, 'develop'), r.stdout + r.stderr);
    r = wt('t4', 'b-w4', null, unknown);
    ok('C4 no base, not derivable: exit 78', r.status === 78, `exit ${r.status} ${r.stdout}${r.stderr}`);
    ok('C4 one line: what, why, what to do', r.stderr.trim().split('\n').length === 1 && /no worktree created/.test(r.stderr)
      && /origin\/HEAD/.test(r.stderr) && /third argument/.test(r.stderr), r.stderr);
    ok('C4 nothing created: no worktree, no branch', !fs.existsSync(W('t4')) && git(norem, 'show-ref', '--verify', '--quiet', 'refs/heads/b-w4').status !== 0);
    // C5: a repository whose origin/HEAD is main (a consumer project) still gets main: the clone of a bare repository with HEAD main.
    const o2 = path.join(dir, 'o2.git'), r2 = path.join(dir, 'r2');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', o2]); git(seed, 'push', '-q', o2, 'master:main');
    spawnSync('git', ['clone', '-q', o2, r2]); ident(r2); git(r2, 'checkout', '-q', '-b', 'master'); commit(r2, 'm.txt'); git(r2, 'checkout', '-q', 'main');
    r = wt('t5', 'b-w5', null, cfgFile('mainrepo', { repoDir: r2 }));
    ok('C5 origin/HEAD -> main: worktree from main, as before', r.status === 0 && sha(W('t5'), 'HEAD') === sha(r2, 'main'), r.stdout + r.stderr);
    for (const [n, m] of [['t1', repo], ['t2', repo], ['t3', repo], ['t5', r2]]) git(m, 'worktree', 'remove', '--force', W(n));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
