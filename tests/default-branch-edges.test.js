#!/usr/bin/env node
'use strict';
// Edges of the default branch from git (u2b-1, tester): only the remote "origin" is read (a clone with -o upstream is
// unknown, not guessed); a nested name keeps its slashes; while unknown the hook refuses every form of a branch push
// (bare git push, HEAD:refs/heads/x, --delete) but not an existing unprotected tag; an explicit defaultBranch protects
// a repository without a remote; a linked worktree reads origin/HEAD of its repository; a relative repoDir "." is the
// project root; a real `git push` through core.hooksPath is refused for the default branch and let through for others.
// Round 2: tags in every form while unknown, the hook process exits 0 with deny on a tag, and a branch push named like
// an existing tag (HEAD:build-1 creates refs/heads/build-1) is still a branch push. Round 3: a delete of a bare name
// that is a local tag may delete a remote branch of that name - refused while unknown; tag sources stay tag pushes.
// Round 4: other delete spellings (+:x, -fd, refs/heads/, no local ref, mixed), --delete refs/tags/ as a tag delete,
// the known-branch delete unchanged, and the real pre-push on the delete. Round 5: the matching push ":" / "+:" while
// unknown (its destination is empty) is a branch push and refused.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { decide } = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-edges-')));
const env = { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const commit = (d, f) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', f); git(d, 'commit', '-qm', f); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const cli = (args, cwd = dir, e = {}) => spawnSync('node', [path.join(ROOT, 'scripts', 'config.js'), ...args], { cwd, encoding: 'utf8', env: Object.assign({}, env, e) });
const json = (f) => { const r = cli(['json', f]); try { return JSON.parse(r.stdout); } catch { return { status: r.status, err: r.stderr }; } };
// A throw in the hook is not a refusal: Claude Code runs the command after a hook that exits 1 (fail open).
const bash = (command, cwd, cfg) => { try { return decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {})); } catch (e) { return 'CRASH ' + e.message; } };
const unknownRe = /protected branches unknown/;

try {
  const seed = path.join(dir, 'seed'), origin = path.join(dir, 'origin.git');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'master'); ident(seed); commit(seed, 'a.txt');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git(seed, 'push', '-q', origin, 'master');

  console.log('Only origin is read');
  const up = path.join(dir, 'up');
  spawnSync('git', ['clone', '-q', '-o', 'upstream', origin, up]); ident(up); git(up, 'branch', 'b-t1');
  ok('setup: clone -o upstream has refs/remotes/upstream/HEAD and no origin/HEAD',
    git(up, 'symbolic-ref', '-q', 'refs/remotes/upstream/HEAD').status === 0 && git(up, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0);
  const upCfg = cfgFile('up', { repoDir: up });
  let j = json(upCfg);
  ok('remote upstream only: defaultBranch unknown (not guessed from upstream)', j.defaultBranch === null && j.protectedBranches === null, JSON.stringify(j));
  let r = cli(['default-branch', upCfg]);
  ok('remote upstream only: config.js default-branch exits 78 with the fix', r.status === 78 && /defaultBranch/.test(r.stdout), `${r.status} ${r.stdout}`);
  ok('remote upstream only: hook refuses git push upstream b-t1', unknownRe.test(bash('git push upstream b-t1', up, upCfg) || ''));
  const upKey = cfgFile('upkey', { repoDir: up, defaultBranch: 'master' });
  ok('remote upstream + defaultBranch master: master refused, b-t1 allowed',
    /master is protected/.test(bash('git push upstream master', up, upKey) || '') && bash('git push upstream b-t1', up, upKey) === null);

  console.log('A nested default branch name');
  const nested = path.join(dir, 'nested.git'), nc = path.join(dir, 'nc');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'team/trunk', nested]);
  git(seed, 'push', '-q', nested, 'master:team/trunk');
  spawnSync('git', ['clone', '-q', nested, nc]); ident(nc); git(nc, 'branch', 'b-t1');
  j = json(cfgFile('nested', { repoDir: nc }));
  ok('origin/HEAD -> origin/team/trunk: defaultBranch team/trunk', j.defaultBranch === 'team/trunk' && JSON.stringify(j.protectedBranches) === '["team/trunk"]', JSON.stringify(j));

  console.log('Every form of a branch push while unknown');
  const norem = path.join(dir, 'norem');
  fs.mkdirSync(norem); git(norem, 'init', '-q', '-b', 'master'); ident(norem); commit(norem, 'a.txt');
  git(norem, 'branch', 'b-t1'); git(norem, 'tag', 'build-1'); git(norem, 'tag', 'v1.0');
  const unk = cfgFile('unk', { repoDir: norem });
  for (const c of ['git push', 'git push origin', 'git push origin HEAD:refs/heads/x', 'git push origin b-t1:feature',
    'git push origin --delete b-t1', 'git push -u origin b-t1', 'git push origin +b-t1']) {
    ok(`unknown: "${c}" refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  ok('unknown: an existing tag outside protectedTagPattern is not a branch push - allowed', bash('git push origin build-1', norem, unk) === null, String(bash('git push origin build-1', norem, unk)));
  ok('unknown: a protected tag stays refused as a tag (no crash: a crash lets the push through)', /tag v1.0 is refused/.test(bash('git push origin v1.0', norem, unk) || ''), String(bash('git push origin v1.0', norem, unk)));
  // Round 2: tags while unknown in every form, and a branch push whose destination is named like an existing tag.
  ok('unknown: refs/tags/v1.0 refused as a protected tag', /tag v1.0 is refused/.test(bash('git push origin refs/tags/v1.0', norem, unk) || ''), String(bash('git push origin refs/tags/v1.0', norem, unk)));
  ok('unknown: refs/tags/build-1 allowed (a tag, not a branch push)', bash('git push origin refs/tags/build-1', norem, unk) === null, String(bash('git push origin refs/tags/build-1', norem, unk)));
  ok('unknown: a tag and a branch in one push - the branch still refused', unknownRe.test(bash('git push origin build-1 b-t1', norem, unk) || ''), String(bash('git push origin build-1 b-t1', norem, unk)));
  // git creates refs/heads/build-1 on the remote here (src HEAD is a branch; measured with git 2.50: "[new branch] HEAD -> build-1").
  for (const c of ['git push origin HEAD:build-1', 'git push origin b-t1:build-1']) {
    ok(`unknown: "${c}" is a branch push (src is a branch) - refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  // Round 3: a delete has no source, and git deletes whatever the remote holds under the name - a branch build-1 too,
  // though a local tag build-1 exists (measured with git 2.50: "- [deleted] build-1", remote refs/heads/build-1 gone).
  // While the branches are unknown that is a branch push the hook cannot tell from a tag delete: refuse.
  for (const c of ['git push origin --delete build-1', 'git push origin :build-1', 'git push -d origin build-1']) {
    ok(`unknown: "${c}" may delete a remote branch named like the local tag - refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  ok('unknown: a delete of refs/tags/build-1 is a tag delete - allowed', bash('git push origin :refs/tags/build-1', norem, unk) === null, String(bash('git push origin :refs/tags/build-1', norem, unk)));
  // p-sec (owner 2026-10-21): a bare destination after a colon is matched by git against the remote's refs - a remote
  // branch build-1 is updated though the source is a tag (tests/hooks-sec.test.js); while unknown it is refused.
  ok('unknown: src tag v1.0 to the bare dst build-1 may update a remote branch build-1 - refused with the reason', unknownRe.test(bash('git push origin v1.0:build-1', norem, unk) || ''), String(bash('git push origin v1.0:build-1', norem, unk)));
  // Round 4 (tester): every other spelling of a bare-name delete is refused while unknown; only an explicit
  // refs/tags/ delete is a tag delete, and it is judged by protectedTagPattern.
  for (const c of ['git push origin +:build-1', 'git push -fd origin build-1', 'git push origin --delete refs/heads/build-1',
    'git push origin --delete gone', 'git push origin --delete build-1 refs/tags/build-1', 'git push origin :v1.0']) {
    ok(`unknown: "${c}" refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  ok('unknown: --delete refs/tags/build-1 is a tag delete - allowed', bash('git push origin --delete refs/tags/build-1', norem, unk) === null, String(bash('git push origin --delete refs/tags/build-1', norem, unk)));
  ok('unknown: --delete refs/tags/v1.0 refused as a protected tag', /tag v1.0 is refused/.test(bash('git push origin --delete refs/tags/v1.0', norem, unk) || ''), String(bash('git push origin --delete refs/tags/v1.0', norem, unk)));
  // Round 5 (review): the refspec ":" (and "+:") is a "matching" push - git pushes every branch that exists on both
  // sides under the same name, the default branch too (measured with git 2.50: "+ ... main -> main (forced update)").
  // Its destination is empty, so it named no branch and slipped past the unknown check: refused while unknown.
  for (const c of ['git push origin :', 'git push origin +:', 'git push -f origin :', 'git push origin b-t1 :']) {
    ok(`unknown: matching push "${c}" refused with the reason`, unknownRe.test(bash(c, norem, unk) || ''), String(bash(c, norem, unk)));
  }
  // Round 5 (tester): other spellings of the matching refspec while unknown - quoted, with lease, after an allowed tag
  // (build-1 alone goes through, so only ":" can refuse it), through git -C from outside the repository; the reason
  // names the matching push; the owner's word still lets it through.
  for (const c of ["git push origin ':'", 'git push origin "+:"', 'git push --force-with-lease origin +:', 'git push origin build-1 :',
    'git push origin -- :', 'git push --no-verify origin :']) {
    const w = bash(c, norem, unk) || '';
    ok(`unknown: matching push "${c}" refused, the reason names the matching refspec`, unknownRe.test(w) && /matching refspec/.test(w), w);
  }
  ok('unknown: git -C <repo> push origin : from outside any repository refused', unknownRe.test(bash(`git -C ${norem} push origin :`, dir, unk) || ''), String(bash(`git -C ${norem} push origin :`, dir, unk)));
  ok('unknown: ALLOW_PROTECTED_PUSH=1 git push origin : goes through (the owner\'s word)', bash('ALLOW_PROTECTED_PUSH=1 git push origin :', norem, unk) === null, String(bash('ALLOW_PROTECTED_PUSH=1 git push origin :', norem, unk)));
  {
    // With the branches known the matching push is judged as before the task (f5ab484: it names no branch and goes
    // through; pre-push catches it) - the fix touches only the unknown case. An explicit [] protects nothing.
    const kn = cfgFile('kn5', { repoDir: norem, defaultBranch: 'master' }), none = cfgFile('none5', { repoDir: norem, protectedBranches: [] });
    ok('known master: git push origin : judged as before (allowed by the session hook)', bash('git push origin :', norem, kn) === null, String(bash('git push origin :', norem, kn)));
    ok('protectedBranches []: git push origin +: allowed (no branch is protected)', bash('git push origin +:', norem, none) === null, String(bash('git push origin +:', norem, none)));
    const hp = spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')], { cwd: norem, encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin +:' }, cwd: norem }), env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: unk }) });
    ok('unknown: the hook process on "git push origin +:" exits 0 with deny', hp.status === 0 && /"permissionDecision":"deny"/.test(hp.stdout) && /matching/.test(hp.stdout), `${hp.status} ${hp.stdout} ${hp.stderr}`);
  }
  {
    const hp = spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', 'guard-bash.js')], { cwd: norem, encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin v1.0' }, cwd: norem }), env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: unk }) });
    ok('unknown: the hook process on a protected tag exits 0 with deny (exit 1 would be non-blocking)', hp.status === 0 && /"permissionDecision":"deny"/.test(hp.stdout), `${hp.status} ${hp.stdout} ${hp.stderr}`);
  }
  const keyed = cfgFile('keyed', { repoDir: norem, defaultBranch: 'master' });
  ok('no remote + defaultBranch master: hook protects master, lets b-t1 through',
    /master is protected/.test(bash('git push origin master', norem, keyed) || '') && bash('git push origin b-t1', norem, keyed) === null);
  // Round 4 (tester): with the branch known the delete of a bare tag name is judged as before (the fix touches only
  // the unknown case): an unprotected name goes through, the default branch and a protected tag are refused.
  ok('known master: --delete build-1 and :build-1 go through', bash('git push origin --delete build-1', norem, keyed) === null && bash('git push origin :build-1', norem, keyed) === null,
    String(bash('git push origin --delete build-1', norem, keyed)) + ' / ' + String(bash('git push origin :build-1', norem, keyed)));
  ok('known master: --delete master refused as protected', /master is protected/.test(bash('git push origin --delete master', norem, keyed) || ''), String(bash('git push origin --delete master', norem, keyed)));
  ok('known master: --delete v1.0 refused as a protected tag', /tag v1.0 is refused/.test(bash('git push origin --delete v1.0', norem, keyed) || ''), String(bash('git push origin --delete v1.0', norem, keyed)));
  r = cli(['check', keyed]);
  ok('no remote + defaultBranch master: check ok without the note', r.status === 0 && !/note:/.test(r.stderr), r.stderr);

  console.log('Linked worktree and a relative repoDir');
  const proj = path.join(dir, 'proj');
  spawnSync('git', ['clone', '-q', origin, proj]); ident(proj); git(proj, 'branch', 'b-t1');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: '.', worktreeRoot: '..', sharedDir: '..' }));
  r = cli(['default-branch'], proj);
  ok('repoDir "." in .claude/codis-agents.json: default branch master from the project root', r.status === 0 && r.stdout.trim() === 'master', `${r.status} ${r.stdout}${r.stderr}`);
  r = cli(['default-branch', path.join(proj, '.claude', 'codis-agents.json')], dir);
  ok('repoDir "." resolved from the project root, not from the cwd (run outside any repository)', r.status === 0 && r.stdout.trim() === 'master', `${r.status} ${r.stdout}${r.stderr}`);
  const lw = path.join(dir, 'lw');
  git(proj, 'worktree', 'add', '-q', '-b', 'b-lw', lw, 'master');
  ok('linked worktree: hook (project config found through the main checkout) refuses git push origin master',
    /master is protected/.test(bash('git push origin master', lw) || ''), String(bash('git push origin master', lw)));
  ok('linked worktree: hook lets git push origin b-lw through', bash('git push origin b-lw', lw) === null, String(bash('git push origin b-lw', lw)));

  console.log('A real git push through core.hooksPath');
  ident(lw); commit(lw, 'lw.txt');   // something new to push, or git skips the hook ("Everything up-to-date")
  git(proj, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  let p = spawnSync('git', ['-C', lw, 'push', 'origin', 'HEAD:master'], { encoding: 'utf8', env });
  ok('git push origin HEAD:master from the linked worktree refused by pre-push', p.status !== 0 && /push to master is blocked/.test(p.stderr), p.stderr);
  p = spawnSync('git', ['-C', lw, 'push', '-q', 'origin', 'b-lw'], { encoding: 'utf8', env });
  ok('git push origin b-lw goes through', p.status === 0 && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/b-lw').status === 0, p.stderr);
  git(norem, 'remote', 'add', 'origin', origin);
  git(norem, 'config', 'core.hooksPath', path.join(ROOT, 'scripts', 'git-hooks'));
  ok('setup: norem has an origin remote but no origin/HEAD', git(norem, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD').status !== 0);
  p = spawnSync('git', ['-C', norem, 'push', 'origin', 'b-t1'], { encoding: 'utf8', env });
  ok('no origin/HEAD, no config: real git push origin b-t1 refused with the reason', p.status !== 0 && unknownRe.test(p.stderr)
    && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/b-t1').status !== 0, p.stderr);
  p = spawnSync('git', ['-C', norem, 'push', 'origin', 'HEAD:build-1'], { encoding: 'utf8', env });
  ok('no origin/HEAD: real git push origin HEAD:build-1 (a new branch named like a tag) refused by pre-push', p.status !== 0 && unknownRe.test(p.stderr)
    && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/build-1').status !== 0, p.stderr);
  // Round 4 (tester): the second layer on the same delete - origin holds a branch build-1, norem a tag build-1;
  // a real git push origin --delete build-1 is refused by pre-push and the remote branch stays.
  git(seed, 'push', '-q', origin, 'master:refs/heads/build-1');
  p = spawnSync('git', ['-C', norem, 'push', 'origin', '--delete', 'build-1'], { encoding: 'utf8', env });
  ok('no origin/HEAD: real git push origin --delete build-1 refused by pre-push, remote branch build-1 kept', p.status !== 0 && unknownRe.test(p.stderr)
    && git(origin, 'show-ref', '--verify', '--quiet', 'refs/heads/build-1').status === 0, p.stderr);
  // Round 5 (tester): the second layer on the matching push - origin and norem both hold master (unrelated history),
  // so a real git push origin +: would force-update origin's master; pre-push refuses and master stays.
  {
    // seed and norem commit the same a.txt with the same identity: within one second the two commits are identical
    // (seen on Linux: "Everything up-to-date"), so give norem's master its own commit first.
    commit(norem, 'n5.txt');
    const before = git(origin, 'rev-parse', 'refs/heads/master').stdout.trim();
    ok('setup: norem master differs from origin master', git(norem, 'rev-parse', 'master').stdout.trim() !== before);
    p = spawnSync('git', ['-C', norem, 'push', 'origin', '+:'], { encoding: 'utf8', env });
    ok('no origin/HEAD: real git push origin +: refused by pre-push, origin master unchanged', p.status !== 0 && unknownRe.test(p.stderr)
      && git(origin, 'rev-parse', 'refs/heads/master').stdout.trim() === before, p.stderr);
  }
  git(proj, 'worktree', 'remove', '--force', lw);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
