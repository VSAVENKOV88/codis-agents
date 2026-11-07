#!/usr/bin/env node
'use strict';
// The commit channel under the real codex sandbox (p-codex A2a-1 acceptance, G7): createAgent of scripts/role-exec.js
// with a launcher that runs a role script under `codex sandbox` (no model is called; a throwaway CODEX_HOME), the
// write roots of the role being its worktree and its task folder, as the profile of a programmer. The role script asks
// for commits with scripts/commit-req.js and attacks the channel from inside the sandbox: a request that is a symlink
// to a file outside, a FIFO request, a request naming an answer path, the same id with other content, the box swapped
// for a symlink and back, a write into the adapter's answers, a direct git commit. Two repositories: a clone of this
// plugin, and a copy whose config is hostile (hooks of every kind, fsmonitor, a clean filter, signing with
// gpg.program, include.path, a promisor remote with ext::) - nothing of it may run outside the sandbox (its hooks of a
// check run inside codex sandbox, part A2a-2a), and a control file outside the worktree stays as it was. Skipped without macOS or codex.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'scripts', 'commit-req.js');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');
if (process.platform !== 'darwin' || !has('codex') || !has('git')) {
  skip('the commit channel under codex sandbox', 'needs macOS, codex and git');
  done();
}
const { createAgent } = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const CODEX = spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit-sbx-')));
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SETUP_ENV = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Setup',
  GIT_COMMITTER_EMAIL: 's@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (cwd, args) => {
  const p = spawnSync(GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'].concat(args), { cwd, encoding: 'utf8', env: SETUP_ENV });
  return { rc: p.status, out: (p.stdout || '').trim(), err: (p.stderr || '').trim() };
};
const exe = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); fs.chmodSync(p, 0o755); };

// the role script: runs inside the sandbox, prints one JSON line with what each step saw
const ROLE = path.join(BASE, 'role.js');
fs.writeFileSync(ROLE, `'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const box = process.env.CODIS_COMMIT_BOX, answers = process.env.CODIS_COMMIT_ANSWERS;
const plan = JSON.parse(process.argv[2]);
const req = (args) => { const p = spawnSync(process.execPath, [${JSON.stringify(CLIENT)}].concat(args), { encoding: 'utf8' }); let j = null; try { j = JSON.parse(p.stdout.trim().split('\\n').pop()); } catch {} return { rc: p.status, j }; };
const wait = (id) => req(['wait', '--id', id, '--max', '20']);
const newId = () => crypto.randomBytes(16).toString('hex');
const put = (id, body) => { fs.writeFileSync(path.join(box, '.' + id + '.tmp'), body); fs.renameSync(path.join(box, '.' + id + '.tmp'), path.join(box, id + '.json')); };
const out = { home: process.env.CODEX_HOME };
fs.writeFileSync(path.join(plan.wt, plan.file), 'changed in the sandbox ' + plan.tag + '\\n');
out.first = req(['-m', 'commit from the sandbox', '--', plan.file]);
// a request that is a symlink to the control file outside the worktree
const il = newId(); fs.symlinkSync(plan.control, path.join(box, il + '.json')); out.symlink = wait(il);
// a FIFO request
const ip = newId(); spawnSync('mkfifo', [path.join(box, ip + '.json')]); out.fifo = wait(ip);
// a request that names an answer path of its own
const ia = newId(); put(ia, JSON.stringify({ id: ia, paths: [plan.file], message: 'm', answer: plan.decoy })); out.answerPath = wait(ia);
// the same id again with other content
put(out.first.j.id, JSON.stringify({ id: out.first.j.id, paths: [plan.file], message: 'other content' })); out.reuse = wait(out.first.j.id);
// the box swapped for a symlink to a decoy folder that holds a valid request, then back
const real = box + '.real'; fs.mkdirSync(plan.decoyDir); fs.renameSync(box, real); fs.symlinkSync(plan.decoyDir, box);
const idc = newId(); fs.writeFileSync(path.join(plan.decoyDir, idc + '.json'), JSON.stringify({ id: idc, paths: [plan.file], message: 'decoy' }));
spawnSync('/bin/sleep', ['2.5']);
out.decoy = fs.existsSync(path.join(answers, idc + '.json')) ? JSON.parse(fs.readFileSync(path.join(answers, idc + '.json'), 'utf8')) : null;
fs.unlinkSync(box); fs.renameSync(real, box);
// a write into the adapter's answers and a direct commit
try { fs.writeFileSync(path.join(answers, newId() + '.json'), '{}'); out.answersWrite = 'written'; } catch (e) { out.answersWrite = e.code; }
const gc = spawnSync('git', ['-C', plan.wt, 'commit', '-q', '--allow-empty', '-m', 'direct'], { encoding: 'utf8' }); out.directCommit = gc.status;
fs.writeFileSync(path.join(plan.wt, plan.file2), 'second ' + plan.tag + '\\n');
out.second = req(['-m', 'second commit', '--', plan.file2]);
process.stdout.write(JSON.stringify(out) + '\\n');
`);

function repo(name, hostile) {
  const d = path.join(BASE, name);
  const f = { d, wt: path.join(d, 'wt'), tdir: path.join(d, 'tdir'), state: path.join(d, 'state'), rtmp: path.join(d, 'rtmp'), home: path.join(d, 'home'),
    chome: path.join(d, 'chome'), marks: path.join(d, 'marks.log'), control: path.join(d, 'control.txt'), decoy: path.join(d, 'decoy.json'), decoyDir: path.join(d, 'tdir', 'decoydir') };
  for (const k of ['tdir', 'rtmp', 'home', 'chome']) fs.mkdirSync(f[k], { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gitconfig'), '[user]\n\tname = codis-agents\n\temail = noreply@example.com\n');
  fs.writeFileSync(f.control, 'control\n');
  f.repo = path.join(d, 'repo');
  git(d, ['clone', '-q', '--no-hardlinks', ROOT, f.repo]);
  git(f.repo, ['worktree', 'add', '-q', '-b', 'task', f.wt]);
  if (hostile) {
    const H = path.join(d, 'hostile');
    const mark = (n) => `#!/bin/sh\necho ${n} >> '${f.marks}'\nexit 0\n`;
    for (const h of hostile.checkHooks ? ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'reference-transaction', 'post-index-change', 'post-commit']
      : ['reference-transaction', 'post-index-change', 'post-commit', 'post-rewrite', 'pre-auto-gc']) exe(path.join(H, 'hooks', h), mark(h));
    exe(path.join(H, 'fsmon'), mark('fsmonitor'));
    exe(path.join(H, 'clean'), `#!/bin/sh\necho filter >> '${f.marks}'\ncat\n`);
    exe(path.join(H, 'gpg'), mark('gpg'));
    exe(path.join(H, 'ext.sh'), mark('ext'));
    fs.writeFileSync(path.join(H, 'inc.cfg'), `[core]\n\tfsmonitor = ${path.join(H, 'fsmon')}\n`);
    fs.writeFileSync(path.join(f.wt, '.gitattributes'), '* filter=x\n');
    for (const [k, v] of [['core.hooksPath', path.join(H, 'hooks')], ['core.fsmonitor', path.join(H, 'fsmon')], ['filter.x.clean', path.join(H, 'clean')],
      ['commit.gpgSign', 'true'], ['gpg.program', path.join(H, 'gpg')], ['include.path', path.join(H, 'inc.cfg')], ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'evil'], ['remote.evil.url', `ext::${path.join(H, 'ext.sh')} %S`], ['remote.evil.promisor', 'true'], ['protocol.ext.allow', 'always']]) git(f.repo, ['config', k, v]);
  }
  f.control0 = sha256(fs.readFileSync(f.control));
  return f;
}

function sandboxLaunch(f, file, file2, tag) {
  return (plan) => new Promise((resolve) => {
    const prof = `permissions.a2r={extends=":workspace",filesystem={${JSON.stringify(f.wt)}="write",${JSON.stringify(f.tdir)}="write"}}`;
    const args = ['sandbox', '-P', 'a2r', '-c', 'default_permissions=a2r', '-c', prof, '-C', f.wt, '--', process.execPath, ROLE,
      JSON.stringify({ wt: f.wt, file, file2, tag, control: f.control, decoy: f.decoy, decoyDir: f.decoyDir })];
    const c = spawn(CODEX, args, { cwd: f.wt, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (x) => { o += x; });
    c.stderr.on('data', (x) => { e += x; });
    const t = setTimeout(() => c.kill('SIGKILL'), 120000);
    c.on('close', (rc) => {
      clearTimeout(t);
      let j = null;
      try { j = JSON.parse(o.trim().split('\n').pop()); } catch { /* below */ }
      f.seen = { rc, j, err: e.slice(-2000), plan };
      resolve({ rc: 0, output: JSON.stringify({ status: 'ready' }) });
    });
  });
}
const SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));
async function runRole(f, file, file2, tag) {
  const agent = createAgent({ host: 'codex', callsDir: path.join(f.d, 'calls'), pluginRoot: ROOT, log: () => {},
    codex: { home: f.chome, catalog: CATALOG }, env: Object.assign({}, process.env, { HOME: f.home, XDG_CONFIG_HOME: path.join(f.d, 'xdg'), TMPDIR: f.rtmp }),
    tasks: { K: { dir: f.tdir, wt: f.wt, branch: 'task' } }, commit: { stateDir: f.state, git: GIT }, launch: sandboxLaunch(f, file, file2, tag) });
  const t0 = git(f.wt, ['rev-parse', 'task']).out;
  await agent('role', { label: 'prog:K#1', schema: SCHEMA, agentType: 'general-purpose' });
  const rec = fs.readFileSync(path.join(f.tdir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  return { t0, rec, s: f.seen };
}

(async () => {
  // ---- the clone of the plugin: commits by request, attacks refused
  const f = repo('plugin', null);
  const { t0, rec, s } = await runRole(f, 'README.md', 'CHANGELOG.md', 'plugin');
  const j = s && s.j;
  ok('the role ran under codex sandbox with the throwaway CODEX_HOME', j && j.home === f.chome, JSON.stringify({ rc: s && s.rc, err: s && s.err }));
  const tip = git(f.wt, ['rev-parse', 'task']).out;
  ok('a request from inside the sandbox -> committed; the sha is the parent of the second commit', j && j.first.rc === 0 && j.first.j.status === 'committed'
    && git(f.wt, ['rev-parse', `${j.first.j.sha}^`]).out === t0, JSON.stringify(j && j.first));
  ok('the second request -> committed on top; the tip = the last sha the adapter recorded', j && j.second.j && j.second.j.status === 'committed'
    && j.second.j.sha === tip && rec.commit && rec.commit.commits.map((c) => c.sha).join() === [j.first.j.sha, j.second.j.sha].join(), JSON.stringify(rec.commit));
  ok('a request that is a symlink to the control file -> refused, nothing of it read', j && j.symlink.j && j.symlink.j.status === 'refused' && /symbolic link/.test(j.symlink.j.why), JSON.stringify(j && j.symlink));
  ok('a FIFO request -> refused without hanging', j && j.fifo.j && j.fifo.j.status === 'refused', JSON.stringify(j && j.fifo));
  ok('a request naming an answer path -> refused; no file at that path', j && j.answerPath.j && j.answerPath.j.status === 'refused' && !fs.existsSync(f.decoy), JSON.stringify(j && j.answerPath));
  ok('the same id with other content -> the first result stands, no new commit', j && j.reuse.j && j.reuse.j.sha === j.first.j.sha, JSON.stringify(j && j.reuse));
  ok('the box swapped for a symlink to a decoy -> the decoy request is not committed', j && (!j.decoy || j.decoy.status === 'refused') && rec.commit.commits.length === 2, JSON.stringify(j && j.decoy));
  ok('the role cannot write into the adapter\'s answers (sandbox)', j && j.answersWrite === 'EPERM', j && j.answersWrite);
  ok('a direct git commit inside the sandbox fails (DP-01)', j && j.directCommit !== 0, j && String(j.directCommit));
  ok('the plugin clone has no hooks of a check: the commits are by the user\'s identity', git(f.wt, ['show', '-s', '--format=%an <%ae>', tip]).out === 'codis-agents <noreply@example.com>');
  ok('the control file outside the worktree is unchanged (plugin clone)', sha256(fs.readFileSync(f.control)) === f.control0);
  ok('the record of the call: outcome ok and the commit summary', rec.outcome === 'ok' && rec.commit.refused.length >= 3, JSON.stringify(rec));

  // ---- the hostile copy without hooks of a check: commits, nothing of the config runs
  const h = repo('hostile', {});
  const r2 = await runRole(h, 'README.md', 'CHANGELOG.md', 'hostile');
  const marks = () => (fs.existsSync(h.marks) ? fs.readFileSync(h.marks, 'utf8') : '');
  ok('hostile config: the requests commit and nothing of the config ran (hooks, fsmonitor, filter, gpg, include, ext::)',
    r2.s.j && r2.s.j.first.j.status === 'committed' && r2.s.j.second.j.status === 'committed' && marks() === '', JSON.stringify({ first: r2.s.j && r2.s.j.first, marks: marks(), err: r2.s.err }));
  ok('hostile config: the control file outside the worktree is unchanged', sha256(fs.readFileSync(h.control)) === h.control0);
  // ---- the hostile copy with hooks of a check: they run inside codex sandbox only (A2a-2a), the rest of the config never
  const k = repo('hooked', { checkHooks: true });
  const r3 = await runRole(k, 'README.md', 'CHANGELOG.md', 'hooked');
  const km = fs.existsSync(k.marks) ? fs.readFileSync(k.marks, 'utf8') : '';
  const hooks = (x) => (x && x.j && x.j.checks ? x.j.checks.map((c) => `${c.hook}:${c.rc}`).join() : '');
  ok('hooks of a check in the repository -> the requests commit after pre-commit, prepare-commit-msg and commit-msg ran in the sandbox; no mark outside the roots',
    r3.s.j && r3.s.j.first.j.status === 'committed' && r3.s.j.second.j.status === 'committed' && hooks(r3.s.j.first) === 'pre-commit:0,prepare-commit-msg:0,commit-msg:0' && km === '',
    JSON.stringify({ first: r3.s.j && r3.s.j.first, km }));
  ok('hooks of a check: the control file outside the worktree is unchanged', sha256(fs.readFileSync(k.control)) === k.control0);
  done();
})().catch((e) => { ok('the test ran to the end', false, e && e.stack); done(); });
