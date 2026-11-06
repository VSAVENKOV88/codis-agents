#!/usr/bin/env node
'use strict';
// The checks of a commit inside the role's sandbox (p-codex A2a-2a): when the repository has hooks of a check
// (pre-commit, prepare-commit-msg, commit-msg), scripts/commit-service.js runs them under the real `codex sandbox`
// with the rights of the role, asynchronously in a process group of their own, in an environment built from a white
// list, and commits exactly the snapshot they passed on. Real git repositories in a temporary folder, the real codex
// sandbox without a model, a throwaway home per check. Cells of the analysis p-codex-A2 section 7: MA-01..11 and
// MA-04b (the check process), EV-01..14 and EV-08b (its environment), CK2-01, -02, -03a, -05a, -06, -10, -11 (the
// check and its changes), G7-01..04 (tracked changes outside the request). Every hook writes a mark
// (<task folder>/marks/<hook>-<n>.json: CODEX_SANDBOX, the names of its variables, cwd, GIT_INDEX_FILE, its node), and
// every canary of a write is outside /tmp, the TMPDIR of the check and its roots. Skipped without macOS, codex or git.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'scripts', 'commit-req.js');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the checks of a commit under codex sandbox', 'needs macOS, codex and git');
  done();
}
const sh = (c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout.trim();
const CODEX = sh('command -v codex');
const GIT = sh('command -v git');
const { openCommitService } = require(path.join(ROOT, 'scripts', 'commit-service.js'));
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-chk-')));
const kids = new Set();
process.on('exit', () => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(BASE, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const newId = () => crypto.randomBytes(16).toString('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const exe = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); };
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// helpers the hooks call (outside every root: read-only for the check)
const BIN = path.join(BASE, 'bin');
fs.mkdirSync(BIN);
const MARK = path.join(BIN, 'mark.js'), TRY = path.join(BIN, 'try.js'), NET = path.join(BIN, 'net.js');
fs.writeFileSync(MARK, `const fs=require('fs'),path=require('path');
const [tdir,hook,shpid,...args]=process.argv.slice(2);
const dir=path.join(tdir,'marks');fs.mkdirSync(dir,{recursive:true});
let n=1;while(fs.existsSync(path.join(dir,hook+'-'+n+'.json')))n++;
const e=process.env;
fs.writeFileSync(path.join(dir,hook+'-'+n+'.json'),JSON.stringify({sandbox:e.CODEX_SANDBOX||null,netOff:e.CODEX_SANDBOX_NETWORK_DISABLED||null,
names:Object.keys(e).sort(),env:{HOME:e.HOME,CODEX_HOME:e.CODEX_HOME,TMPDIR:e.TMPDIR,PATH:e.PATH,npm_config_cache:e.npm_config_cache,GIT_INDEX_FILE:e.GIT_INDEX_FILE,GIT_DIR:e.GIT_DIR,GIT_CONFIG_PARAMETERS:e.GIT_CONFIG_PARAMETERS},
cwd:process.cwd(),node:process.execPath,args,shpid:+shpid}));
`);
fs.writeFileSync(TRY, `const fs=require('fs');const [out,...files]=process.argv.slice(2);const r={};
for(const f of files){try{if(f.endsWith('/')){fs.mkdirSync(f);}else fs.writeFileSync(f,'written by the check\\n',{flag:'a'});r[f]='ok';}catch(e){r[f]=e.code;}}
fs.writeFileSync(out,JSON.stringify(r));
`);
fs.writeFileSync(NET, `const fs=require('fs'),net=require('net');const [out,port]=process.argv.slice(2);
const s=net.connect(+port,'127.0.0.1');s.on('connect',()=>{fs.writeFileSync(out,'connected');s.destroy();});s.on('error',(e)=>fs.writeFileSync(out,String(e.code)));
`);
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));

let fixN = 0;
// A repository with a linked worktree on branch "task" (o.main: the worktree is the main checkout, .git a folder), a
// hooks folder outside the worktree named by core.hooksPath (o.hooks: {name: body}), the task folder, the adapter's
// state folder, the role's TMPDIR, a user home, and canaries outside every root.
function fixture(o) {
  const x = o || {};
  const d = path.join(x.under || BASE, `f${++fixN}`);
  const f = { d, repo: path.join(d, 'repo'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'),
    home: path.join(d, 'home'), xdg: path.join(d, 'xdg'), hooks: path.join(d, 'hooks'), canary: path.join(d, 'canary') };
  for (const k of ['repo', 'tdir', 'rtmp', 'home', 'xdg', 'canary']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = Role Owner\n\temail = owner@example.com\n' + (x.global || ''));
  git(f.repo, ['init', '-q', '-b', 'main']);
  for (const n of ['a.txt', 'b.txt', 'gen.txt', 'l.txt', 'm.txt', 'r1.txt', 'sub/c.txt']) {
    fs.mkdirSync(path.dirname(path.join(f.repo, n)), { recursive: true });
    fs.writeFileSync(path.join(f.repo, n), `${n}\n`);
  }
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', 'base']);
  if (x.main) { git(f.repo, ['checkout', '-q', '-b', 'task']); f.wt = f.repo; } else {
    f.wt = path.join(d, 'wt');
    git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  }
  f.gitDir = git(f.wt, ['rev-parse', '--absolute-git-dir']).out;
  const hdr = (name) => `#!/bin/sh\nnode '${MARK}' '${f.tdir}' '${name}' "$$" "$@" || exit 99\nT='${f.tdir}'\n`;
  f.hook = (name, body, dir) => exe(path.join(dir || f.hooks, name), hdr(name) + (body || '') + '\nexit 0\n');
  if (x.hooks) {
    for (const [n, b] of Object.entries(x.hooks)) f.hook(n, b);
    if (x.hooksPath !== false) git(f.repo, ['config', 'core.hooksPath', f.hooks]);
  }
  f.userEnv = { PATH: process.env.PATH, HOME: f.home, XDG_CONFIG_HOME: f.xdg, TMPDIR: f.rtmp };
  f.h0 = git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.tip = () => git(f.wt, ['rev-parse', 'refs/heads/task']).out;
  f.mark = (hook, n) => readJson(path.join(f.tdir, 'marks', `${hook}-${n || 1}.json`));
  f.marks = () => { try { return fs.readdirSync(path.join(f.tdir, 'marks')); } catch { return []; } };
  return f;
}
let callN = 0;
function service(f, extra) {
  const launches = [];
  const e = extra || {};
  const inject = Object.assign({}, e.inject || {});
  const userLaunch = inject.checkLaunch;
  inject.checkLaunch = (spec) => { launches.push(spec.kind); return userLaunch ? userLaunch(spec) : spec; };
  const callDir = path.join(f.tdir, `c${++callN}`);
  fs.mkdirSync(callDir, { recursive: true });
  const s = openCommitService(Object.assign({ task: 'K', callId: `call-${callN}`, wt: f.wt, branch: 'task', box: path.join(callDir, 'commit'),
    stateDir: f.state, git: GIT, codex: CODEX, network: false, tdir: f.tdir, userEnv: f.userEnv, killGraceMs: 1500, log: () => {} }, e, { inject }));
  s.launches = launches;
  return s;
}
function put(box, body) {
  const id = body.id || newId();
  const tmp = path.join(box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(box, `${id}.json`));
  return id;
}
const ask = (s, paths, message) => put(s.box, { paths, message: message || 'msg' });
const readAnswer = (s, id) => readJson(path.join(s.answers, `${id}.json`));
async function answer(s, id, ms) {
  const end = Date.now() + (ms || 20000);
  for (;;) { const a = readAnswer(s, id); if (a || Date.now() > end) return a; await sleep(25); }
}
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);
const kindsOf = (a) => ((a && a.changed) || []).map((c) => `${c.kind}${c.status ? ' ' + c.status : ''} ${c.path || ''}`.trim()).sort();
// the variables a check may see: the white list of the adapter and what codex sandbox adds itself (E-A4)
const ALLOWED = new Set(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'GIT_INDEX_FILE', 'npm_config_cache', 'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'PWD', 'SHLVL', 'OLDPWD', '_', '__CF_USER_TEXT_ENCODING',
  // what git hook run sets for its hook: the repository and the -c of the adapter (core.hooksPath)
  'GIT_DIR', 'GIT_EXEC_PATH', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS']);
const underAny = (p, roots) => roots.some((r) => p === r || p.startsWith(r + path.sep));

(async () => {
  // ---- the canaries of this test are outside every root of a check and outside tmp (else the test is misconfigured)
  {
    const f = fixture();
    ok('the canaries of the test lie outside /tmp, the TMPDIR of the check and its roots', !underAny(f.canary, ['/tmp', '/private/tmp', f.rtmp, f.wt, f.tdir]));
  }

  // ---- CK2-01: no hooks of a check -> the A2a-1 path, codex never launched, an unnamed change stays
  {
    const f = fixture();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'named\n');
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'unnamed\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('CK2-01 no hooks of a check -> committed, codex not launched, the unnamed change stays in the worktree',
      a && a.status === 'committed' && s.launches.length === 0 && fs.readFileSync(path.join(f.wt, 'b.txt'), 'utf8') === 'unnamed\n'
      && git(f.wt, ['show', 'task:b.txt']).out === 'b.txt', J({ a, launches: s.launches }));
    await s.close();
  }

  // ---- 2a boundary (coordinator G2, run 3): a conversion of the repository is refused before any hook
  for (const [name, setup, re] of [
    ['a tracked .gitattributes with a filter', (f) => { fs.writeFileSync(path.join(f.wt, '.gitattributes'), '*.txt filter=x\n'); git(f.wt, ['add', '.gitattributes']); git(f.wt, ['commit', '-q', '-m', 'attrs']); }, /filter=x/],
    ['core.autocrlf true in the user\'s config', (f) => fs.appendFileSync(path.join(f.home, '.gitconfig'), '[core]\n\tautocrlf = true\n'), /core\.autocrlf true/],
    ['core.eol in the repository config', (f) => git(f.repo, ['config', 'core.eol', 'crlf']), /core\.eol crlf/],
  ]) {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    setup(f);
    f.h0 = f.tip();
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok(`2a: ${name} -> refused "conversion not supported until A2a-2b" before any hook`, a && a.status === 'refused' && /conversion not supported until A2a-2b/.test(a.why)
      && re.test(a.why) && f.marks().length === 0 && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- CK2-02, EV-01, EV-02, EV-03, EV-10: pre-commit rc 0 in the sandbox, the environment by the white list
  {
    const f = fixture({ hooks: { 'pre-commit': 'npm config get cache > "$T/npmcache.txt" 2>/dev/null\necho w > "$npm_config_cache/written" ; echo $? > "$T/npmwrite.rc"\nnpm view --offline --fetch-retries=0 left-pad version > /dev/null 2>&1; echo $? > "$T/npmview.rc"' } });
    const nodeOpts = path.join(f.canary, 'node-options.js'), nodeHit = path.join(f.canary, 'node-options.hit');
    fs.writeFileSync(nodeOpts, `require('fs').writeFileSync(${JSON.stringify(nodeHit)}, 'ran');\n`);
    const personal = path.join(os.homedir(), '.codex');
    const st0 = (() => { try { return fs.statSync(personal).mtimeMs; } catch { return null; } })();
    Object.assign(f.userEnv, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', OPENAI_API_KEY: 'sk-canary', CODEX_API_KEY: 'ck-canary', MY_API_TOKEN: 't', CLAUDE_CODE_MESSAGING_TOKEN: 'm',
      SSH_AUTH_SOCK: path.join(f.canary, 'agent.sock'), NODE_OPTIONS: `--require ${nodeOpts}`, GIT_DIR: path.join(f.canary, 'gitdir'),
      npm_config_cache: path.join(f.canary, 'npm') });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'checked\n');
    const a = await answer(s, ask(s, ['a.txt'], 'checked commit'));
    const m = f.mark('pre-commit');
    const c0 = a && a.checks && a.checks[0];
    ok('CK2-02 pre-commit rc 0 -> committed; checks[0] = {hook pre-commit, pass 1, rc 0}, its log is a file',
      a && a.status === 'committed' && c0 && c0.hook === 'pre-commit' && c0.pass === 1 && c0.rc === 0 && fs.existsSync(c0.log), J(a));
    ok('CK2-02 the hook ran inside the sandbox: its mark has CODEX_SANDBOX=seatbelt and cwd = the worktree', m && m.sandbox === 'seatbelt' && fs.realpathSync(m.cwd) === fs.realpathSync(f.wt), J(m));
    ok('the record of the launch names codex sandbox, the profile and the home of the check', c0 && c0.launch && c0.launch.codex === CODEX && /extends/.test(c0.launch.profile || '')
      && c0.launch.network === false && c0.launch.home, J(c0 && c0.launch));
    const extra = m ? m.names.filter((n) => !ALLOWED.has(n)) : ['no mark'];
    ok('EV-01 the check sees only the white list and what codex adds (no keys, tokens, SSH_AUTH_SOCK, NODE_OPTIONS, GIT_DIR)', extra.length === 0, extra.join(','));
    ok('EV-01 NODE_OPTIONS of the adapter never ran in the check', !fs.existsSync(nodeHit));
    ok('EV-01 GIT_DIR in the hook is the one git hook run gives (not the adapter\'s), GIT_CONFIG_PARAMETERS only names core.hooksPath',
      m && m.env.GIT_DIR !== f.userEnv.GIT_DIR && /^'core\.hookspath'='[^']*'$/i.test(m.env.GIT_CONFIG_PARAMETERS || ''), J(m && m.env));
    ok('EV-02 the hook finds the node of the adapter although the PATH of the adapter has none', m && m.node === process.execPath, m && m.node);
    ok('EV-03 the home of the check is new, outside the roots and tmp, and removed after the pass', m && m.env.HOME === m.env.CODEX_HOME && !underAny(m.env.HOME, [f.wt, f.tdir, '/tmp', '/private/tmp', f.rtmp])
      && !fs.existsSync(m.env.HOME), J(m && m.env));
    const st1 = (() => { try { return fs.statSync(personal).mtimeMs; } catch { return null; } })();
    ok('EV-03 ~/.codex is not used (stat only)', st0 === st1);
    const cache = path.join(path.dirname(s.box), 'npm-cache');
    ok('EV-10 npm_config_cache = the cache of the call, written by the check; ~/.npm and the adapter\'s value are not used', m && m.env.npm_config_cache === cache
      && rd(path.join(f.tdir, 'npmcache.txt')).trim() === cache && rd(path.join(f.tdir, 'npmwrite.rc')).trim() === '0', J(m && m.env));
    ok('EV-10 the cache gives no network: npm view fails for the programmer', rd(path.join(f.tdir, 'npmview.rc')).trim() !== '0');
    ok('CK2-02 the commit holds the checked bytes and the message', git(f.wt, ['show', 'task:a.txt']).out === 'checked' && git(f.wt, ['log', '-1', '--format=%s', 'task']).out === 'checked commit');
    ok('the answer names the environment of the check (reads, write roots, untracked inputs not in the commit)', a && a.environment && a.environment.untracked === 'not part of the commit'
      && /whole disk/.test(a.environment.reads || '') && Array.isArray(a.environment.writeRoots), J(a && a.environment));
    await s.close();
  }

  // ---- MA-09, MA-10, MA-11: a failing hook, a hook killed by a signal, a hook with 50 MB of output
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo boom-on-stderr >&2\nexit 3' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('MA-09 pre-commit rc 3 -> refused "pre-commit failed (rc 3)", the tail of its output and its log, the mark exists, the tip stays',
      a && a.status === 'refused' && /pre-commit failed \(rc 3\)/.test(a.why) && a.checks && /boom-on-stderr/.test(a.checks[0].tail) && fs.existsSync(a.checks[0].log)
      && f.mark('pre-commit') && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'kill -9 $$' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('MA-10 a hook killed by a signal -> refused with the exit code as codex gives it (rc 137)', a && a.status === 'refused' && /pre-commit failed \(rc 137\)/.test(a.why), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': 'head -c 52428800 /dev/zero | tr "\\000" "x"\necho LAST-LINE\nexit 1' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    if (global.gc) global.gc();
    const rss0 = process.memoryUsage().rss;
    const a = await answer(s, ask(s, ['a.txt']), 60000);
    const grow = process.memoryUsage().rss - rss0;
    const c0 = a && a.checks && a.checks[0];
    ok('MA-11 50 MB of output: in the log file, the answer carries a tail of at most 4000 characters, the adapter does not grow by the output',
      c0 && c0.tail.length <= 4000 && /LAST-LINE/.test(c0.tail) && fs.statSync(c0.log).size >= 52428800 && grow < 30 * 1024 * 1024, J({ tail: c0 && c0.tail.length, grow }));
    await s.close();
  }

  // ---- CK2-03a, CK2-05a, CK2-11: a check that changes the snapshot or the message file
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo generated >> gen.txt' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'gen.txt'), 'role\n');
    const a = await answer(s, ask(s, ['gen.txt']));
    ok('CK2-03a pre-commit rewrote the named gen.txt -> refused "the check changed the snapshot", changed [gen.txt], the tip stays, gen.txt as the hook left it',
      a && a.status === 'refused' && /the check changed the snapshot/.test(a.why) && kindsOf(a).some((k) => / gen\.txt$/.test(k)) && f.tip() === f.h0
      && fs.readFileSync(path.join(f.wt, 'gen.txt'), 'utf8') === 'role\ngenerated\n', J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'prepare-commit-msg': 'printf "[pfx] " | cat - "$1" > "$1.n" && cat "$1.n" > "$1" && rm "$1.n"' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt'], 'the message'));
    const m = f.mark('prepare-commit-msg');
    ok('CK2-05a prepare-commit-msg got the message file and "message"', m && m.args.length === 2 && m.args[1] === 'message' && /COMMIT_EDITMSG$/.test(m.args[0]), J(m && m.args));
    ok('CK2-05a prepare-commit-msg changed the message -> refused "the check changed the snapshot", changed [message], the tip stays',
      a && a.status === 'refused' && /the check changed the snapshot/.test(a.why) && kindsOf(a).includes('message') && f.tip() === f.h0, J(a));
    await s.close();
  }
  for (const [name, body, re] of [
    ['CK2-11 commit-msg rc 1 -> refused with its output', 'echo bad-message >&2\nexit 1', /commit-msg failed \(rc 1\)/],
    ['CK2-11 commit-msg replaced the message file by a link to a canary -> refused "a symbolic link", the canary is not read', 'rm "$1"; ln -s "$CANARY" "$1"', /symbolic link/],
    ['CK2-11 commit-msg replaced the message file by a FIFO -> refused "not a regular file" without hanging', 'rm "$1"; mkfifo "$1"', /not a regular file/],
  ]) {
    const f = fixture({ hooks: {} });
    const secret = path.join(f.canary, 'secret.txt');
    fs.writeFileSync(secret, 'canary-secret\n');
    f.hook('commit-msg', `CANARY='${secret}'\n${body}`);
    git(f.repo, ['config', 'core.hooksPath', f.hooks]);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok(name, a && a.status === 'refused' && re.test(a.why) && !/canary-secret/.test(JSON.stringify(a)) && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- CK2-06, CK2-10: the check changed an unnamed tracked file; a new request that names it
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo hooked > b.txt' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'role\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const realIx = git(f.wt, ['diff-index', '--cached', '--quiet', 'task']).rc;
    ok('CK2-06 the check changed the unnamed tracked b.txt -> refused "changed outside the request during the check" with b.txt; nothing added or rolled back',
      a && a.status === 'refused' && /changed outside the request during the check \(by the check or the role\)/.test(a.why) && kindsOf(a).includes('modified b.txt')
      && fs.readFileSync(path.join(f.wt, 'b.txt'), 'utf8') === 'hooked\n' && f.tip() === f.h0 && realIx === 0, J(a));
    const b = await answer(s, ask(s, ['a.txt', 'b.txt']));
    ok('CK2-10 a new request that names b.txt -> committed with both changes', b && b.status === 'committed' && git(f.wt, ['show', 'task:b.txt']).out === 'hooked'
      && git(f.wt, ['show', 'task:a.txt']).out === 'role', J(b));
    await s.close();
  }

  // ---- G7-01..G7-04: tracked changes outside the request
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'named\n');
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'role, unnamed\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-01 an unnamed tracked change before the request -> refused "tracked changes outside the request" before any hook (no mark, no checks), b.txt untouched',
      a && a.status === 'refused' && /tracked changes outside the request/.test(a.why) && kindsOf(a).includes('modified b.txt') && f.marks().length === 0
      && !(a.checks && a.checks.length) && fs.readFileSync(path.join(f.wt, 'b.txt'), 'utf8') === 'role, unnamed\n', J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'outside\n');
    fs.rmSync(path.join(f.wt, 'b.txt'));
    fs.rmSync(path.join(f.wt, 'l.txt'));
    fs.symlinkSync('a.txt', path.join(f.wt, 'l.txt'));
    fs.chmodSync(path.join(f.wt, 'm.txt'), 0o755);
    fs.writeFileSync(path.join(f.wt, 'e.txt'), 'e\n');
    git(f.wt, ['add', 'e.txt']);
    git(f.wt, ['mv', 'r1.txt', 'r2.txt']);
    fs.writeFileSync(path.join(f.wt, 'sub', 'c.txt'), 'named\n');
    const s = service(f);
    const a = await answer(s, ask(s, ['sub/c.txt']));
    const want = ['deleted b.txt', 'deleted r1.txt', 'mode m.txt', 'modified a.txt', 'staged A e.txt', 'staged A r2.txt', 'staged D r1.txt', 'typechange l.txt'];
    ok('G7-02 one refusal with the full list: modified, deleted, typechange, mode, staged additions and both sides of a rename in the index',
      a && a.status === 'refused' && /tracked changes outside the request/.test(a.why) && want.every((k) => kindsOf(a).includes(k)) && f.marks().length === 0, J({ got: kindsOf(a), why: a && a.why }));
    ok('G7-02 nothing rolled back or hidden: the index and the worktree as the role left them', git(f.wt, ['diff', '--cached', '--no-renames', '--name-only']).out.split('\n').sort().join() === 'e.txt,r1.txt,r2.txt'
      && fs.lstatSync(path.join(f.wt, 'l.txt')).isSymbolicLink());
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { inject: { afterChecks: () => fs.writeFileSync(path.join(f.wt, 'b.txt'), 'after the hook\n') } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'named\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-03 an unnamed tracked change after the hook, before the final compare -> refused with b.txt', a && a.status === 'refused' && kindsOf(a).includes('modified b.txt') && f.tip() === f.h0, J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { inject: { afterFinalCompare: () => fs.writeFileSync(path.join(f.wt, 'b.txt'), 'late\n') } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'named\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('G7-03 a change after the final compare -> committed with the tree of the check; the change stays in the worktree only',
      a && a.status === 'committed' && git(f.wt, ['show', 'task:b.txt']).out === 'b.txt' && fs.readFileSync(path.join(f.wt, 'b.txt'), 'utf8') === 'late\n', J(a));
    await s.close();
  }
  for (const [name, act, re] of [
    ['G7-04 the tip moved by another process during the check -> refused "HEAD changed during the operation (recorded H0)"', (f) => {
      fs.writeFileSync(path.join(f.repo, 'x.txt'), 'x');
      const blob = git(f.wt, ['hash-object', '-w', path.join(f.repo, 'x.txt')]).out;
      const c = git(f.wt, ['commit-tree', `${f.h0}^{tree}`, '-p', f.h0, '-m', 'other']).out;
      git(f.wt, ['update-ref', 'refs/heads/task', c, f.h0]);
      f.moved = c; return blob;
    }, (f) => new RegExp(`HEAD changed during the operation \\(recorded ${f.h0}\\)`)],
    ['G7-04 HEAD of the worktree switched to another branch -> refused "HEAD of the worktree is not"', (f) => { git(f.wt, ['branch', 'other']); git(f.wt, ['symbolic-ref', 'HEAD', 'refs/heads/other']); },
      () => /HEAD of the worktree is not/],
    ['G7-04 the real index changed during the check -> refused "the index of the worktree differs from HEAD" with the list', (f) => { fs.writeFileSync(path.join(f.wt, 'z.txt'), 'z\n'); git(f.wt, ['add', 'z.txt']); },
      () => /the index of the worktree differs from HEAD/],
  ]) {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { inject: { afterChecks: () => act(f) } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'named\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const tipOk = f.moved ? f.tip() === f.moved : f.tip() === f.h0;
    ok(name, a && a.status === 'refused' && re(f).test(a.why) && tipOk && !(/real index/.test(name) && !kindsOf(a).includes("staged A z.txt")), J(a));
    await s.close();
  }

  // ---- EV-04, EV-09: the network of the check is the network of the role; <wt>/.codex/config.toml is not read
  {
    let hits = 0;
    const srv = net.createServer((c) => { hits++; c.destroy(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    for (const [role, network] of [['prog', false], ['test', true]]) {
      const f = fixture({ hooks: { 'pre-commit': `node '${NET}' "$T/net.txt" ${port}\nnode '${TRY}' "$T/try.json" '${path.join(f0canary(), 'x')}'` } });
      fs.mkdirSync(path.join(f.wt, '.codex'));
      fs.writeFileSync(path.join(f.wt, '.codex', 'config.toml'), `[permissions.workspace.network]\nenabled = true\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [${JSON.stringify(f.canary)}]\n`);
      const before = hits;
      const s = service(f, { network });
      fs.writeFileSync(path.join(f.wt, 'a.txt'), `${role}\n`);
      const a = await answer(s, ask(s, ['a.txt']));
      const got = (() => { try { return rd(path.join(f.tdir, 'net.txt')); } catch { return 'no file'; } })();
      if (role === 'prog') {
        ok('EV-09/EV-04 programmer: the hook cannot connect to the listener although <wt>/.codex/config.toml opens the network', a && a.status === 'committed' && got !== 'connected' && hits === before, J({ a, got }));
      } else {
        ok('EV-09 tester: the hook connects to the listener', a && a.status === 'committed' && got === 'connected' && hits > before, J({ a, got }));
      }
      await s.close();
    }
    srv.close();
  }
  function f0canary() { const d = path.join(BASE, 'canary-net'); fs.mkdirSync(d, { recursive: true }); return d; }

  // ---- EV-06: codex missing or of another version
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { codex: path.join(f.canary, 'no-codex') });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-06 no codex -> refused "no safe check path: codex not found", no hook ran', a && a.status === 'refused' && /no safe check path: codex not found/.test(a.why) && f.marks().length === 0, J(a));
    await s.close();
    const fake = path.join(f.canary, 'codex-old');
    exe(fake, '#!/bin/sh\necho "codex-cli 0.165.0"\n');
    const s2 = service(f, { codex: fake });
    const b = await answer(s2, ask(s2, ['a.txt']));
    ok('EV-06 codex 0.165.0 -> refused "codex 0.165.0 is not among the verified versions (0.166.0)", no hook ran',
      b && b.status === 'refused' && /no safe check path: codex 0\.165\.0 is not among the verified versions \(0\.166\.0\)/.test(b.why) && f.marks().length === 0, J(b));
    await s2.close();
  }

  // ---- EV-07: the probe of the sandbox
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'one\n');
    const a = await answer(s, ask(s, ['a.txt']));
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'two\n');
    const b = await answer(s, ask(s, ['a.txt']));
    ok('EV-07 (a) the probe passes once per call; two checks', a && a.status === 'committed' && b && b.status === 'committed' && s.launches.filter((k) => k === 'probe').length === 1, J({ a, b, l: s.launches }));
    await s.close();
  }
  for (const [name, inj, re] of [
    ['EV-07 (b) a launch without the sandbox -> refused "the sandbox probe failed", no hook ran', { checkLaunch: (sp) => (sp.kind === 'probe' ? Object.assign({}, sp, { bin: sp.inner[0], args: sp.inner.slice(1) }) : sp) }, /no safe check path: the sandbox probe failed/],
    ['EV-07 (c) a profile with the canary among its roots -> refused "write outside the roots"', { profile: (p, f) => { p.roots.push(f.state); } }, /the sandbox probe failed: write outside the roots/],
    ['EV-07 (d) the network of the role is off but the listener answers -> refused "network"', { profile: (p) => { p.network = true; } }, /the sandbox probe failed: network/],
  ]) {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const i = Object.assign({}, inj);
    if (i.profile) { const fn = i.profile; i.profile = (p) => fn(p, f); }
    const s = service(f, { inject: i });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const canaryLeft = (() => { try { return fs.readdirSync(path.join(f.state, 'K', 'calls')).some((c) => fs.existsSync(path.join(f.state, 'K', 'calls', c, 'probe', 'canary'))); } catch { return false; } })();
    ok(name, a && a.status === 'refused' && re.test(a.why) && f.marks().length === 0 && !canaryLeft && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- EV-08, EV-08b: what the hook may not write
  // the worktree under /private/tmp, a write root of the :workspace profile itself: there only the read rule of the
  // profile keeps .git and .codex from the check (measured: without it the hook writes .git/config); the canaries and
  // the adapter's state stay outside tmp
  const TMP_BASE = fs.realpathSync(fs.mkdtempSync('/private/tmp/commit-chk-'));
  process.on('exit', () => fs.rmSync(TMP_BASE, { recursive: true, force: true }));
  for (const main of [false, true]) {
    const f = fixture({ main, hooks: {}, under: TMP_BASE });
    f.canary = path.join(BASE, `canary-ev08-${fixN}`);
    f.state = path.join(BASE, `state-ev08-${fixN}`);
    fs.mkdirSync(f.canary, { recursive: true });
    const ssh = path.join(f.canary, 'ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(ssh));
    fs.writeFileSync(ssh, 'key\n');
    const dotGit = path.join(f.wt, '.git');
    const targets = [path.join(f.canary, 'outside.txt'), ssh, '"$HOME/x"', '"$GIT_INDEX_FILE"', `'${path.join(f.state, 'K', 'calls')}/x'`];
    const gitTargets = main ? [path.join(dotGit, 'config'), path.join(dotGit, 'hooks', 'pre-commit'), path.join(f.wt, '.codex') + '/'] : [dotGit, path.join(f.wt, '.codex') + '/'];
    f.hook('pre-commit', `node '${TRY}' "$T/try.json" ${targets.map((t) => (t.startsWith('"') || t.startsWith("'") ? t : `'${t}'`)).join(' ')} ${gitTargets.map((t) => `'${t}'`).join(' ')}`);
    git(f.repo, ['config', 'core.hooksPath', f.hooks]);
    const cfg0 = main ? fs.readFileSync(path.join(dotGit, 'config'), 'utf8') : fs.readFileSync(dotGit, 'utf8');
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const r = readJson(path.join(f.tdir, 'try.json')) || {};
    const vals = Object.entries(r);
    ok(`EV-08${main ? 'b' : ''} every write outside the roots is EPERM (canary, ~/.ssh-like, HOME of the check, the private index, the adapter's folder${main ? ', .git/config, .git/hooks, .codex' : ', the .git file, .codex'})`,
      a && a.status === 'committed' && vals.length === targets.length + gitTargets.length && vals.every(([, v]) => v === 'EPERM'), J({ r, a }));
    ok(`EV-08${main ? 'b' : ''} the .git of the worktree is unchanged and ssh canary intact`, (main ? fs.readFileSync(path.join(dotGit, 'config'), 'utf8') : fs.readFileSync(dotGit, 'utf8')) === cfg0
      && fs.readFileSync(ssh, 'utf8') === 'key\n');
    await s.close();
  }

  // ---- EV-11: the hook cannot change the private index; a changed tree is refused
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo zz > zz.txt\ngit add zz.txt 2> "$T/add.err"; echo $? > "$T/add.rc"\ngit update-index --cacheinfo 100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,b.txt; echo $? > "$T/ui.rc"' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const err = (() => { try { return rd(path.join(f.tdir, 'add.err')); } catch { return ''; } })();
    ok('EV-11 git add and update-index inside the hook fail on index.lock (Operation not permitted); the commit goes on with the tree of the request',
      a && a.status === 'committed' && /Operation not permitted/.test(err) && git(f.wt, ['show', 'task:b.txt']).out === 'b.txt' && git(f.wt, ['ls-tree', 'task', 'zz.txt']).out === '', J({ a, err }));
    await s.close();
  }
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    const s = service(f, { inject: { afterChecks: (x) => { spawnSync(GIT, ['update-index', '--cacheinfo', '100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,b.txt'], { cwd: f.wt, env: Object.assign({}, SETUP_ENV, { GIT_INDEX_FILE: x.privIndex }) }); } } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-11 the tree of the private index changed (injection) -> refused "index changes are an adapter operation"', a && a.status === 'refused' && /index changes are an adapter operation/.test(a.why) && f.tip() === f.h0, J(a));
    await s.close();
  }

  // ---- EV-12, EV-13: the hooks folder git would choose
  {
    const f = fixture({ hooks: {}, global: '' });
    const g = path.join(f.d, 'global-hooks');
    exe(path.join(g, 'pre-commit'), `#!/bin/sh\necho global > '${path.join(f.tdir, 'global-ran')}'\n`);
    fs.appendFileSync(path.join(f.home, '.gitconfig'), `[core]\n\thooksPath = ${g}\n`);
    f.hook('pre-commit', '');
    git(f.repo, ['config', 'core.hooksPath', f.hooks]);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-12 core.hooksPath global and local: only the hooks of the last value run', a && a.status === 'committed' && f.mark('pre-commit') && !fs.existsSync(path.join(f.tdir, 'global-ran')), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: {} });
    const outside = path.join(f.canary, 'role-hook.txt');
    f.hook('pre-commit', `node '${TRY}' "$T/try.json" '${outside}'`, path.join(f.wt, 'my-hooks'));
    git(f.repo, ['add', '-A']);
    git(f.repo, ['config', 'core.hooksPath', 'my-hooks']);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    const m = f.mark('pre-commit');
    ok('EV-12/EV-13 a relative core.hooksPath inside the worktree (a hook the role wrote) runs from the worktree root, only in the sandbox',
      a && a.status === 'committed' && m && m.sandbox === 'seatbelt' && (readJson(path.join(f.tdir, 'try.json')) || {})[outside] === 'EPERM' && !fs.existsSync(outside), J({ a, m }));
    await s.close();
  }
  {
    const f = fixture({ hooks: {} });
    f.hook('pre-commit', '', path.join(f.home, 'hk'));
    git(f.repo, ['config', 'core.hooksPath', '~/hk']);
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-12 core.hooksPath ~/hk -> the HOME of the user', a && a.status === 'committed' && f.mark('pre-commit'), J(a));
    await s.close();
  }
  {
    const f = fixture({ hooks: {}, hooksPath: false });
    const common = git(f.wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
    f.hook('pre-commit', '', path.join(common, 'hooks'));
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-12 no core.hooksPath -> <common git dir>/hooks', a && a.status === 'committed' && f.mark('pre-commit') && s.launches.includes('hook'), J(a));
    await s.close();
    const empty = path.join(f.d, 'empty-hooks');
    fs.mkdirSync(empty);
    git(f.repo, ['config', 'core.hooksPath', empty]);
    const s2 = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'y\n');
    const b = await answer(s2, ask(s2, ['a.txt']));
    ok('EV-12 core.hooksPath without hooks while <common>/hooks has one -> no check (git would run none)', b && b.status === 'committed' && s2.launches.length === 0 && f.marks().length === 1, J(b));
    await s2.close();
  }

  // ---- EV-14: ps inside the check fails, the hook decides
  {
    const f = fixture({ hooks: { 'pre-commit': 'ps > /dev/null 2>&1; echo $? > "$T/ps.rc"' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const a = await answer(s, ask(s, ['a.txt']));
    ok('EV-14 ps fails inside the check; the hook decides (rc 0 -> committed)', a && a.status === 'committed' && rd(path.join(f.tdir, 'ps.rc')).trim() !== '0', J(a));
    await s.close();
  }

  // ---- EV-15: heavy.sh inside a check cannot take a slot (the slot folder is not a write root of the check): it fails
  // at once with code 77, and the hook's failure refuses the request with its output. Two slot folders: the default
  // one under the new empty home of the check (cannot be created), and an existing one outside the roots (its locks
  // cannot be opened for writing in the sandbox although their mode allows it).
  {
    const slots = path.join(BASE, 'ev15-slots');
    fs.mkdirSync(path.join(slots, 'queue'), { recursive: true });
    for (const n of ['admit.lock', 'queue.lock']) fs.writeFileSync(path.join(slots, n), '');
    const heavy = path.join(ROOT, 'scripts', 'heavy.sh');
    for (const [label, pre] of [['the default slot folder in the home of the check', ''], ['an existing slot folder outside the roots', `SLOTS_DIR='${slots}' `]]) {
      const f = fixture({ hooks: { 'pre-commit': `${pre}'${heavy}' touch "$T/ev15.ran"; rc=$?; echo "heavy rc=$rc"; exit $rc` } });
      const s = service(f);
      fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
      const t0 = Date.now();
      const a = await answer(s, ask(s, ['a.txt']), 60000);
      const secs = (Date.now() - t0) / 1000;
      const c0 = a && a.checks && a.checks[0];
      const log = c0 ? rd(c0.log) : '';
      ok(`EV-15 heavy.sh in a hook (${label}): refused with the hook's failure (rc 77) within 60 s, not left waiting until the call ends`,
        a && a.status === 'refused' && /pre-commit failed \(rc 77\)/.test(a.why || '') && c0 && c0.rc === 77, J({ secs, a }));
      ok(`EV-15 (${label}): the output of the check names the refusal of the slot, the command never ran, the branch did not move`,
        /heavy rc=77/.test(log) && /slot_run: refused/.test(log) && !fs.existsSync(path.join(f.tdir, 'ev15.ran')) && f.tip() === f.h0, log.slice(-600));
      await s.close();
    }
    ok('EV-15 the existing slot folder outside the roots got no ticket and no new file', fs.readdirSync(path.join(slots, 'queue')).length === 0
      && fs.readdirSync(slots).sort().join(',') === 'admit.lock,queue,queue.lock', fs.readdirSync(slots).join(','));
  }

  // ---- the npm cache of a check adds no write root: a role that swaps its call folder for a link to a folder D
  // outside its roots while a request waits gets that request refused (no safe check path), and nothing is written
  // into D (security review S-1)
  {
    const D = path.join(BASE, 's1-victim');
    fs.mkdirSync(D, { recursive: true });
    const f = fixture({ hooks: { 'pre-commit': `if [ -f "$T/hold" ]; then i=0; while [ ! -f "$T/go" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done; rm -f "$T/hold"; else mkdir -p '${D}/npm-cache'; echo pwned > '${D}/npm-cache/pwn'; echo "$npm_config_cache" > "$T/cache2.txt"; fi` } });
    fs.writeFileSync(path.join(f.tdir, 'hold'), '');
    const s = service(f, { pollMs: 200 });
    const callDir = path.dirname(s.box);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'one\n');
    const id1 = ask(s, ['a.txt']);
    const t0 = Date.now();
    while (!f.mark('pre-commit') && Date.now() - t0 < 15000) await sleep(50);
    fs.writeFileSync(path.join(f.wt, 'b.txt'), 'two\n');
    const id2 = ask(s, ['a.txt', 'b.txt']);
    await sleep(1500);
    fs.renameSync(callDir, callDir + '.orig');
    fs.symlinkSync(D, callDir);
    fs.writeFileSync(path.join(f.tdir, 'go'), '');
    const a1 = await answer(s, id1, 30000);
    const a2 = await answer(s, id2, 30000);
    const roots = (a1 && a1.checks && a1.checks[0] && a1.checks[0].launch.writeRoots) || [];
    ok('the npm cache inside the task folder adds no write root of its own (the roots: the worktree, the task folder, the message folder)',
      a1 && a1.status === 'committed' && roots.length === 3 && roots[0] === fs.realpathSync(f.wt) && roots[1] === fs.realpathSync(f.tdir), J({ a1, roots }));
    ok('S-1 the call folder swapped for a link outside the roots while a request waits: that request is refused, no safe check path (the npm cache)',
      a2 && a2.status === 'refused' && /no safe check path/.test(a2.why || '') && /npm cache/.test(a2.why || ''), J(a2));
    ok('S-1 nothing was written into the folder behind the link, and the hook of the second request never ran',
      !fs.existsSync(path.join(D, 'npm-cache', 'pwn')) && !fs.existsSync(path.join(f.tdir, 'cache2.txt')) && f.marks().length === 1, J({ marks: f.marks(), d: fs.readdirSync(D) }));
    await s.close();
    fs.unlinkSync(callDir);
  }

  // ---- MA-01, MA-02: one request at a time, the loop of the adapter alive during a check
  {
    const f = fixture({ hooks: { 'pre-commit': 'if [ -f "$T/hold" ]; then i=0; while [ ! -f "$T/go" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -f "$T/go" ] && echo go > "$T/held" || echo timeout > "$T/held"; rm -f "$T/hold"; fi' } });
    fs.writeFileSync(path.join(f.tdir, 'hold'), '');
    const s = service(f, { pollMs: 200 });
    const ids = [];
    for (const n of ['n1.txt', 'n2.txt', 'n3.txt']) { fs.writeFileSync(path.join(f.wt, n), `${n}\n`); ids.push(ask(s, [n])); await sleep(30); }
    const t0 = Date.now();
    while (!f.mark('pre-commit') && Date.now() - t0 < 10000) await sleep(50);
    await sleep(1500);
    const during = { marks: f.marks().length, answers: ids.map((i) => !!readAnswer(s, i)) };
    fs.writeFileSync(path.join(f.tdir, 'go'), '');
    const as = [];
    for (const i of ids) as.push(await answer(s, i, 30000));
    const held = (() => { try { return rd(path.join(f.tdir, 'held')).trim(); } catch { return 'none'; } })();
    ok('MA-01 during a check the adapter\'s loop lives: the test released the hook (not its own time limit)', held === 'go', held);
    ok('MA-02 while the first check runs, scans start no second one (one mark, no answers)', during.marks === 1 && during.answers.every((x) => !x), J(during));
    ok('MA-01/MA-02 three requests committed one at a time in the order of birth, each on the previous',
      as.every((a) => a && a.status === 'committed') && git(f.wt, ['rev-parse', `${as[1] && as[1].sha}^`]).out === (as[0] && as[0].sha)
      && git(f.wt, ['rev-parse', `${as[2] && as[2].sha}^`]).out === (as[1] && as[1].sha) && f.tip() === (as[2] && as[2].sha), J(as));
    await s.close();
  }

  // ---- MA-06: the background of a hook does not hold the check
  {
    const f = fixture({ hooks: { 'pre-commit': 'sleep 300 &\necho $! > "$T/bg1"\nnohup sleep 300 > /dev/null 2>&1 &\necho $! > "$T/bg2"' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const t0 = Date.now();
    const a = await answer(s, ask(s, ['a.txt']));
    const ms = Date.now() - t0;
    await sleep(200);
    const pids = ['bg1', 'bg2'].map((n) => +rd(path.join(f.tdir, n)).trim());
    const hookMs = a && a.checks && a.checks[0] ? a.checks[0].ms : null;
    ok('MA-06 the check ends by the exit of its leader (the hook < 5 s, not its 300 s background) and both background processes are gone',
      a && a.status === 'committed' && hookMs !== null && hookMs < 5000 && pids.every((p) => p > 0 && !alive(p)), J({ ms, hookMs, pids, a }));
    await s.close();
  }

  // ---- MA-03: the call ends while a hook runs -> SIGTERM to its group, the request cancelled
  {
    const f = fixture({ hooks: { 'pre-commit': 'echo $$ > "$T/pid"\ntrap \'echo TERM > "$T/term"; exit 143\' TERM\nwhile :; do sleep 0.2; done' } });
    const s = service(f);
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const id = ask(s, ['a.txt']);
    const t0 = Date.now();
    while (!fs.existsSync(path.join(f.tdir, 'pid')) && Date.now() - t0 < 15000) await sleep(50);
    const pid = +rd(path.join(f.tdir, 'pid'));
    const sum = await s.close();
    const a = readAnswer(s, id);
    const journal = (() => { try { return fs.readFileSync(path.join(f.state, 'K', 'commits.jsonl'), 'utf8'); } catch { return ''; } })();
    ok('MA-03 close() during a hook -> the hook got SIGTERM, its group is gone, the request cancelled, no intent in the journal, the tip stays',
      a && a.status === 'cancelled' && fs.existsSync(path.join(f.tdir, 'term')) && !alive(pid) && sum.cancelled.includes(id) && !/"intent"/.test(journal) && f.tip() === f.h0, J({ a, sum }));
  }

  // ---- MA-08: close() during the step of the intent -> the commit is carried through
  {
    const f = fixture({ hooks: { 'pre-commit': '' } });
    let closing = null;
    const s = service(f, { inject: { beforeUpdateRef: () => { closing = s.close(); } } });
    fs.writeFileSync(path.join(f.wt, 'a.txt'), 'x\n');
    const id = ask(s, ['a.txt']);
    const t0 = Date.now();
    while (!closing && Date.now() - t0 < 20000) await sleep(25);
    const sum = closing ? await closing : null;
    const a = readAnswer(s, id);
    ok('MA-08 close() at the step of the intent, after a check -> committed', a && a.status === 'committed' && f.mark('pre-commit') && sum && sum.commits.length === 1 && f.tip() === a.sha, J({ a, sum }));
  }

  // ---- role-exec gives the checks the network of the role: off for the programmer, on for the tester
  {
    const { createAgent } = require(path.join(ROOT, 'scripts', 'role-exec.js'));
    for (const [kind, want] of [['prog', false], ['test', true]]) {
      const f = fixture({ hooks: { 'pre-commit': '' } });
      let seen = null;
      const agent = createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {}, codex: { home: path.join(f.d, 'chome'), catalog: CATALOG, bin: CODEX },
        env: Object.assign({}, process.env, f.userEnv), tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT },
        launch: async (plan) => {
          fs.writeFileSync(path.join(f.wt, 'a.txt'), `${kind}\n`);
          const id = put(plan.commit.box, { paths: ['a.txt'], message: kind });
          const end = Date.now() + 30000;
          while (!seen && Date.now() < end) { seen = readJson(path.join(plan.commit.answers, `${id}.json`)); await sleep(50); }
          return { rc: 0, output: JSON.stringify({ status: 'ready' }) };
        } });
      await agent('x', { label: `${kind}:K#1`, schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }, agentType: 'general-purpose' });
      const c0 = seen && seen.checks && seen.checks[0];
      ok(`role-exec: the checks of a ${kind} call get network ${want} and the task folder and npm cache of the call among their roots`,
        seen && seen.status === 'committed' && seen.environment.network === want && c0 && c0.launch.network === want
        && c0.launch.writeRoots.includes(fs.realpathSync(f.tdir)), J(seen));
    }
  }

  // ---- MA-04, MA-04b, MA-05, MA-07: the adapter as a process (createAgent with a launcher on spawnRole)
  const DRIVER = path.join(BIN, 'driver.js'), ROLE = path.join(BIN, 'role.js');
  fs.writeFileSync(ROLE, `const fs=require('fs'),path=require('path');const {spawn}=require('child_process');
fs.writeFileSync(path.join(process.argv[2],'a.txt'),'from the role\\n');
spawn(process.execPath,[${JSON.stringify(CLIENT)},'-m','m','--','a.txt'],{stdio:'ignore'});
setInterval(()=>{},1000);
`);
  fs.writeFileSync(DRIVER, `const a=JSON.parse(process.argv[2]);const {createAgent,spawnRole}=require(${JSON.stringify(path.join(ROOT, 'scripts', 'role-exec.js'))});
const agent=createAgent({host:'codex',callsDir:a.callsDir,pluginRoot:${JSON.stringify(ROOT)},log:()=>{},codex:{home:a.chome,catalog:a.catalog,bin:a.codex},
 env:a.env,tasks:{K:{dir:a.tdir,wt:a.wt,branch:'task'}},commit:{stateDir:a.state,git:a.git},ceilingMs:a.ceilingMs,killGraceMs:a.grace,
 launch:(plan)=>spawnRole(Object.assign({},plan,{bin:process.execPath,argv:[a.role,a.wt]}),{ceilingMs:a.ceilingMs,graceMs:a.grace})});
agent('x',{label:'prog:K#1',schema:{type:'object',properties:{status:{type:'string'}},required:['status']},agentType:'general-purpose'}).then(()=>process.stdout.write('done\\n'));
`);
  const drive = (f, x) => {
    const chome = path.join(f.d, 'chome');
    fs.mkdirSync(chome, { recursive: true });
    const arg = { callsDir: path.join(f.d, 'calls'), chome, catalog: CATALOG, codex: CODEX, env: Object.assign({}, process.env, f.userEnv), tdir: f.tdir, wt: f.wt,
      state: f.state, git: GIT, ceilingMs: x.ceilingMs || 120000, grace: x.grace || 1500, role: ROLE };
    const c = spawn(process.execPath, [DRIVER, JSON.stringify(arg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    kids.add(c.pid);
    const p = new Promise((r) => c.on('exit', (rc, sig) => r({ rc, sig })));
    return { c, p };
  };
  const record = (f) => { try { return JSON.parse(rd(path.join(f.tdir, 'calls.jsonl')).trim().split('\n').pop()); } catch { return null; } };
  const waitFile = async (p, ms) => { const t0 = Date.now(); while (!fs.existsSync(p) && Date.now() - t0 < ms) await sleep(50); return fs.existsSync(p); };
  const stubborn = 'echo $$ > "$T/pid"\ntrap \'echo TERM >> "$T/term"\' TERM\nwhile :; do sleep 0.2; done';
  for (const second of [false, true]) {
    const f = fixture({ hooks: { 'pre-commit': stubborn } });
    const d = drive(f, {});
    const got = await waitFile(path.join(f.tdir, 'pid'), 30000);
    const pid = got ? +rd(path.join(f.tdir, 'pid')) : 0;
    d.c.kill('SIGTERM');
    if (second) { await sleep(300); d.c.kill('SIGTERM'); }
    const ex = await Promise.race([d.p, sleep(30000).then(() => null)]);
    const rec = record(f);
    ok(`MA-04${second ? 'b a second SIGTERM during the cancel' : ' SIGTERM to the adapter during a hook'} -> outcome signalled, the check removed (its group gone), the request cancelled, the record written`,
      got && ex && rec && rec.outcome === 'signalled' && rec.commit && rec.commit.cancelled.length === 1 && !alive(pid) && f.tip() === f.h0, J({ ex, rec: rec && { o: rec.outcome, c: rec.commit }, pid }));
  }
  {
    const f = fixture({ hooks: { 'pre-commit': stubborn } });
    const t0 = Date.now();
    const d = drive(f, { ceilingMs: 4000, grace: 1500 });
    const got = await waitFile(path.join(f.tdir, 'pid'), 30000);
    const pid = got ? +rd(path.join(f.tdir, 'pid')) : 0;
    const ex = await Promise.race([d.p, sleep(40000).then(() => null)]);
    const rec = record(f);
    const secs = (Date.now() - t0) / 1000;
    ok('MA-05 the ceiling of the call during a hook -> outcome ceiling, the check removed, the request cancelled, within the ceiling plus twice the grace (and the start)',
      ex && rec && rec.outcome === 'ceiling' && rec.commit && rec.commit.cancelled.length === 1 && !alive(pid) && secs < 4 + 3 + 6, J({ secs, rec: rec && { o: rec.outcome, c: rec.commit } }));
  }
  {
    const daemon = 'node -e "const c=require(\'child_process\').spawn(\'/bin/sleep\',[\'300\'],{detached:true,stdio:\'ignore\'});require(\'fs\').writeFileSync(process.argv[1],String(c.pid));c.unref()" "$T/daemon.pid"\n' + stubborn;
    const f = fixture({ hooks: { 'pre-commit': daemon } });
    const d = drive(f, {});
    const got = await waitFile(path.join(f.tdir, 'pid'), 30000) && await waitFile(path.join(f.tdir, 'daemon.pid'), 5000);
    const dpid = got ? +rd(path.join(f.tdir, 'daemon.pid')) : 0;
    const before = dpid > 0 && alive(dpid);
    d.c.kill('SIGKILL');
    await d.p;
    const lc = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-leftovers-check.js'), '--wt', f.wt, '--fix'], { encoding: 'utf8' });
    await sleep(300);
    ok('MA-07 a setsid daemon of a hook and SIGKILL of the adapter: the leftovers check finds it by its cwd in the worktree and removes it',
      before && !alive(dpid), J({ before, dpid, out: lc.stdout.slice(0, 800) }));
  }
  // ---- the tester's cells (the order and set of the hooks, the message after stripspace, LANG/LC_ALL, nothing to
  // commit, mode and recreation of a named path, close with a queued request, non-executable hooks):
  // tests/commit-checks-tester-cases.js, a child with its own tally, so README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'commit-checks-tester-cases.js')], { encoding: 'utf8', timeout: 300000 });
    process.stdout.write((tc.stdout || '').replace(/\n+$/, '').replace(/^/gm, '  | ') + '\n');
    ok('the tester cells of the checks (tests/commit-checks-tester-cases.js) pass', tc.status === 0, `exit ${tc.status} ${tc.signal || ''} ${(tc.stderr || '').slice(-500)}`);
  }
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
