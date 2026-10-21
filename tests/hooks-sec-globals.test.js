#!/usr/bin/env node
'use strict';
// p-sec F7 (owner 2026-10-21, answer 30): the global options of git before the subcommand. The session hook skipped
// options by a hand-written list: an option it did not list as taking a value made the value the "subcommand"
// (`git --attr-source HEAD remote set-head origin feat`, `git --shallow-file x symbolic-ref ...`: the hook saw HEAD
// or x and let it through, git moved origin/HEAD - measured with git 2.50), and an option git does not know at all
// shifted the subcommand the same way. Now the hook holds a table of git's global options measured against git
// (2.50 on macOS, the git of the Ubuntu 24.04 container), and in a project with a config it refuses a git command with
// a global option the table does not hold: it cannot tell which word is the subcommand, and git fails on an unknown
// option anyway, so nothing allowed is lost. --exec-path takes no separate value: bare, it prints the path and exits,
// like --html-path, --man-path, --info-path and --list-cmds=<group>; -v/--version and -h/--help make the rest of the
// line the arguments of git version / git help. git runs nothing after these, so the hook judges nothing after them.
// Part 1 checks the table against the git this machine runs, so the Linux run measures the container's git too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hook = require('../scripts/hooks/guard-bash');
const { ok, done } = require('./lib');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-sec-globals-')));
const env = { HOME: os.homedir(), PATH: process.env.PATH };
const git = (d, ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
const ident = (d) => { git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'core.hooksPath', '/dev/null'); };
const cfgFile = (name, c) => { const f = path.join(dir, name + '.json'); fs.writeFileSync(f, JSON.stringify(Object.assign({ worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }, c))); return f; };
const bash = (command, cwd, cfg, extra = {}) => { try { return hook.decide({ tool_name: 'Bash', tool_input: { command }, cwd }, Object.assign({}, env, cfg ? { CODIS_AGENTS_CONFIG: cfg } : {}, extra)); } catch (e) { return 'CRASH ' + e.message; } };
const refused = (w) => typeof w === 'string' && /refused/.test(w) && !/^CRASH/.test(w);

try {
  // proj: a clone of origin with origin/HEAD -> trunk, branch b-t1 on both sides; its config in .claude/.
  const origin = path.join(dir, 'origin.git'), proj = path.join(dir, 'proj'), nocfg = path.join(dir, 'nocfg');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin]);
  spawnSync('git', ['clone', '-q', origin, proj], { encoding: 'utf8' });
  ident(proj);
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(proj, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/b-t1');
  git(proj, 'fetch', '-q', 'origin');
  git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  git(proj, 'branch', 'b-t1', 'origin/b-t1');
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: proj, worktreeRoot: path.join(dir, 'wts'), sharedDir: dir }));
  fs.mkdirSync(nocfg);
  // unk: a repository without origin/HEAD and with a local tag master: the branches are unknown.
  const unkRepo = path.join(dir, 'unk');
  fs.mkdirSync(unkRepo); git(unkRepo, 'init', '-q', '-b', 'trunk'); ident(unkRepo);
  git(unkRepo, 'commit', '-q', '--allow-empty', '-m', 'u'); git(unkRepo, 'tag', 'master'); git(unkRepo, 'remote', 'add', 'origin', origin);
  const unk = cfgFile('unk', { repoDir: unkRepo });

  console.log('1. The table of global options matches the git of this machine');
  const T = hook.GIT_GLOBAL;
  ok('the hook exports its table of global options', T && ['value', 'eq', 'flag', 'exit', 'exitEq'].every((k) => T[k] instanceof Set), String(T && Object.keys(T)));
  if (T && T.value instanceof Set) {
    const ver = spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim();
    console.log('  (' + ver + ')');
    // -> { rc, out } of git <args> in proj, with no pager.
    const run = (...a) => { const r = spawnSync('git', a, { cwd: proj, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_PAGER: 'cat', PAGER: 'cat' }) }); return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
    const isVersion = (r) => r.rc === 0 && /^git version/m.test(r.out);
    const unknown = (r) => r.rc === 129 && /unknown option/.test(r.out);
    const GOOD = { '-C': '.', '-c': 'a.b=c', '--config-env': 'a.b=HOME', '--git-dir': '.git', '--work-tree': '.', '--namespace': 'x',
      '--attr-source': 'HEAD', '--shallow-file': 'x', '--exec-path': run('--exec-path').out.trim(), '--list-cmds': 'main' };
    // Options that print something and exit instead of running a command (git(1)).
    const EXITS = new Set(['--exec-path', '--html-path', '--man-path', '--info-path', '--list-cmds']);
    for (const o of T.value) {
      ok(`value: ${o} takes the next word (git ${o} version does not run version)`, !isVersion(run(o, 'version')) || unknown(run(o, 'version')), run(o, 'version').out.slice(0, 120));
      const r = run(o, GOOD[o] || 'x', 'version');
      ok(`value: git ${o} ${GOOD[o] || 'x'} version runs version (or this git does not know ${o})`, isVersion(r) || unknown(r), r.out.slice(0, 120));
    }
    for (const o of T.eq) {
      const r = run(`${o}=${GOOD[o] || 'x'}`, 'version');
      ok(`eq: git ${o}=<value> version is accepted`, isVersion(r) || (EXITS.has(o) && r.rc === 0) || unknown(r), r.out.slice(0, 120));
    }
    for (const o of T.flag) {
      const r = run(o, 'version');
      ok(`flag: git ${o} version runs version`, isVersion(r) || unknown(r), r.out.slice(0, 120));
    }
    // A terminal option: git runs nothing after it - origin/HEAD stays where it was.
    const head = () => git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim();
    for (const o of [...T.exit, ...[...T.exitEq].map((x) => `${x}=${GOOD[x] || 'x'}`)]) {
      const r = spawnSync('git', [o, 'remote', 'set-head', 'origin', 'b-t1'], { cwd: proj, encoding: 'utf8', input: '',
        env: Object.assign({}, process.env, { GIT_PAGER: 'cat', PAGER: 'cat', MANPAGER: 'cat' }) });
      ok(`exit: git ${o} remote set-head origin b-t1 leaves origin/HEAD`, head() === 'refs/remotes/origin/trunk', `${r.status} ${head()}`);
      if (head() !== 'refs/remotes/origin/trunk') git(proj, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    }
    // The attached =<value> form is accepted only where the table says so: -C=. -c=a.b=c --shallow-file=x --bare=x fail.
    for (const o of [...T.value, ...T.flag].filter((x) => !T.eq.has(x))) {
      const r = run(`${o}=${GOOD[o] || 'x'}`, 'version');
      ok(`no eq: git ${o}=<value> is an unknown option`, unknown(r), r.out.slice(0, 120));
    }
    ok('git itself refuses an option it does not know (--no-such-option)', unknown(run('--no-such-option', 'version')));
    ok('the classes are disjoint', [...T.value].every((o) => !T.flag.has(o) && !T.exit.has(o)) && [...T.flag].every((o) => !T.exit.has(o)));
  }

  console.log('2. A git command the hook judges, after each value option, is judged (project with a config)');
  const judged = [
    ['remote set-head', 'remote set-head origin b-t1'],
    ['symbolic-ref', 'symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1'],
    ['update-ref', 'update-ref --no-deref refs/remotes/origin/HEAD HEAD'],
    ['add -A', 'add -A'],
  ];
  const before = [
    '--attr-source HEAD', '--attr-source=HEAD', '--shallow-file x', '--namespace x', '--namespace=x', '--config-env a.b=HOME',
    '--config-env=a.b=HOME', '-c a.b=c', '--exec-path=/usr/bin', '--no-pager', '-P', '-p', '--bare',
    '--no-optional-locks', '--literal-pathspecs', '--no-advice', '--icase-pathspecs', '--no-replace-objects',
  ];
  for (const b of before) for (const [name, c] of judged) {
    const w = bash(`git ${b} ${c}`, proj);
    ok(`refused: git ${b} ${name}`, refused(w), String(w));
  }
  // The push of a tag to a bare name while the branches are unknown (S4), after a value option.
  for (const b of ['--attr-source HEAD', '--shallow-file x', '--namespace x', '-c a.b=c']) {
    const w = bash(`git ${b} push origin master:master`, unkRepo, unk);
    ok(`refused (branches unknown): git ${b} push origin master:master`, /protected branches unknown/.test(w || ''), String(w));
  }

  console.log('3. An option the table does not hold, before the subcommand, is refused in a project with a config');
  const unknownOpts = [
    'git --new-option v remote set-head origin b-t1', 'git --new-option remote set-head origin b-t1',
    'git --shallow-file=x remote set-head origin b-t1', 'git -C. remote set-head origin b-t1', 'git -pP remote set-head origin b-t1',
    'git --super-prefix x/ symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/b-t1', 'git --list-cmds remote set-head origin b-t1',
    'git -- remote set-head origin b-t1', 'git - remote set-head origin b-t1', 'git --git-d=.git remote set-head origin b-t1',
    'git --new-option v status', 'git --new-option v push origin b-t1', 'git -C . --new-option x log',
  ];
  for (const c of unknownOpts) {
    const w = bash(c, proj);
    ok(`refused: ${c}`, refused(w), String(w));
  }
  const why = bash('git --new-option v status', proj) || '';
  ok('the reason names the option and says why', /--new-option/.test(why) && /global option/.test(why), why);
  ok('refused from outside through -C: git -C <proj> --new-option v status', refused(bash(`git -C ${proj} --new-option v status`, nocfg)));
  ok('allowed without a config: git --new-option v remote set-head origin b-t1', bash('git --new-option v remote set-head origin b-t1', nocfg) === null);
  ok('allowed on the owner\'s word: ALLOW_PROTECTED_PUSH=1 git --new-option v status', bash('ALLOW_PROTECTED_PUSH=1 git --new-option v status', proj) === null);

  console.log('4. What was allowed stays allowed');
  for (const c of [
    'git --no-pager log -1', 'git -P log', 'git --attr-source HEAD log -1', 'git --attr-source=HEAD status', 'git -c a.b=c status',
    'git --shallow-file x log -1', 'git --namespace x status', 'git --config-env a.b=HOME status', 'git --exec-path', 'git --exec-path=/usr/bin status',
    'git --version', 'git -v', 'git --help', 'git -h push', 'git --exec-path remote set-head origin b-t1',
    'git --version remote set-head origin b-t1', 'git --help symbolic-ref -d refs/remotes/origin/HEAD', 'git -c a.b=c -v push origin trunk',
    'git --list-cmds=main remote set-head origin b-t1', 'git --html-path', 'git --list-cmds=main', 'git --literal-pathspecs add a.txt',
    'git --no-pager push origin b-t1', 'git -c a.b=c push origin b-t1', 'git --attr-source HEAD push origin HEAD:b-t1',
    'git --no-optional-locks symbolic-ref refs/remotes/origin/HEAD', 'git --bare remote -v', 'git --no-advice --no-lazy-fetch fetch origin',
    `git -C ${proj} --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-replace-objects status`,
    'git --git-dir=.git --work-tree=. status', `git --git-dir ${path.join(proj, '.git')} log -1`,
  ]) {
    const w = bash(c, proj);
    ok(`allowed: ${c.split(dir).join('<tmp>')}`, w === null, String(w));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
