#!/usr/bin/env node
'use strict';
// scripts/role-leftovers-check.js - post-check of what a task left running: Docker containers, images, volumes and
// networks of the task's stack (by the label com.docker.compose.project, never by program names), processes whose
// cwd or argv lies inside the task worktree or its temp dirs, memory slots whose .who names one of those processes.
// --fix removes only these; the owner's stack is refused; other stacks and processes stay. Docker is a fake CLI on PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'role-leftovers-check.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');

// The rule: the tester's teardown is checked by the post-check.
const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
ok('rules: leftovers are checked by a post-check after the tester and at the end of the task',
  /role-leftovers-check\.js[^\n]*after the tester and at the end of the task/.test(read('rules/multi-agent.md')));
ok('rules: the role:docker line names the post-check', /role-leftovers-check\.js[^\n]*<!-- role:docker -->/.test(rules));
ok('README: scripts table names role-leftovers-check.js', /\| `scripts\/role-leftovers-check\.js` \|/.test(read('README.md')));

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-')));
const wt = path.join(dir, 'wt'), tmp = path.join(dir, 'task-tmp'), other = path.join(dir, 'other'), bin = path.join(dir, 'bin');
const slots = path.join(dir, 'slots'), state = path.join(dir, 'docker.json'), calls = path.join(dir, 'docker.calls');
for (const d of [wt, tmp, other, bin, slots]) fs.mkdirSync(d);
// Fake docker CLI: ps/images/volume ls/network ls with --filter label=k=v, and rm -f, rmi -f, volume rm, network rm.
fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('fs');
const S = ${JSON.stringify(state)}, C = ${JSON.stringify(calls)};
const a = process.argv.slice(2); fs.appendFileSync(C, a.join(' ') + '\\n');
const st = JSON.parse(fs.readFileSync(S, 'utf8'));
const kind = a[0] === 'ps' ? 'containers' : a[0] === 'images' ? 'images' : a[0] === 'rm' ? 'containers' : a[0] === 'rmi' ? 'images'
  : a[0] === 'volume' ? 'volumes' : a[0] === 'network' ? 'networks' : null;
if (!kind) { console.error('fake docker: unsupported ' + a.join(' ')); process.exit(1); }
const f = a.indexOf('--filter'), lab = f >= 0 ? a[f + 1].replace(/^label=/, '') : null;
if (a[0] === 'ps' || a[0] === 'images' || a[1] === 'ls') {
  const [k, v] = lab.split('=');
  for (const x of st[kind]) if (k === 'com.docker.compose.project' && x.project === v) console.log(x.id);
} else {
  const ids = a.slice(a[0] === 'volume' || a[0] === 'network' ? 2 : 1).filter((x) => !x.startsWith('-'));
  st[kind] = st[kind].filter((x) => !ids.includes(x.id));
  fs.writeFileSync(S, JSON.stringify(st));
}
`, { mode: 0o755 });
const STATE0 = { containers: [{ id: 'c1', project: 'k-test' }, { id: 'c9', project: 'own' }, { id: 'c8', project: 'neighbour' }],
  images: [{ id: 'i1', project: 'k-test' }, { id: 'i9', project: 'own' }], volumes: [{ id: 'v1', project: 'k-test' }, { id: 'v9', project: 'own' }],
  networks: [{ id: 'n1', project: 'k-test' }] };
const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH });
const run = (...a) => { const r = spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* not JSON */ } return { r, j }; };
// A background process started from a directory (cwd), orphaned so that it is not a zombie of this test when killed.
const bg = (cwd, ...cmd) => parseInt(execFileSync('sh', ['-c', 'cd "$1" || exit 1; shift; nohup "$@" >/dev/null 2>&1 </dev/null & echo $!', 'sh', cwd, ...cmd], { encoding: 'utf8' }), 10);
const alive = (pid) => { const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() && !r.stdout.trim().startsWith('Z'); };
const pids = [];
try {
  fs.writeFileSync(state, JSON.stringify(STATE0));
  const pCwd = bg(wt, 'sleep', '300'); pids.push(pCwd);
  const pArg = bg(other, process.execPath, '-e', 'setTimeout(() => {}, 300000)', path.join(wt, 'x.js')); pids.push(pArg);
  const pTmp = bg(tmp, 'sleep', '301'); pids.push(pTmp);
  const pOther = bg(other, 'sleep', '302'); pids.push(pOther);
  const pPrefix = bg(other, process.execPath, '-e', 'setTimeout(() => {}, 300000)', wt + '-neighbour/y.js'); pids.push(pPrefix);
  fs.writeFileSync(path.join(slots, 'heavy.1.lock.who'), `heavy ${pCwd} 2026-10-15 12:00:00 guards-all ${wt}\n`);
  fs.writeFileSync(path.join(slots, 'heavy.2.lock.who'), `heavy ${pOther} 2026-10-15 12:00:00 vite build\n`);
  fs.writeFileSync(path.join(slots, 'medium.1.lock.who'), `medium 999999 2026-10-15 12:00:00 tsc ${wt}\n`);
  const base = ['--wt', wt, '--tmp', tmp, '--stack', 'k-test', '--owner-stack', 'own', '--slots-dir', slots];

  // Report without --fix: everything found, nothing touched.
  let { r, j } = run(...base);
  const found = j ? j.found.join('\n') : '';
  ok('JSON on stdout, exit 1 when leftovers remain', j && r.status === 1 && j.ok === false, r.stdout + r.stderr);
  ok('stack: container, image, volume, network by the compose label', /container c1/.test(found) && /image i1/.test(found) && /volume v1/.test(found) && /network n1/.test(found), found);
  ok('other stacks are not listed (owner, neighbour)', !/c9|i9|v9|c8/.test(found), found);
  ok('process with cwd inside the worktree', new RegExp(`process ${pCwd}\\b`).test(found), found);
  ok('process with the worktree in its argv', new RegExp(`process ${pArg}\\b`).test(found), found);
  ok('process from the task temp dir', new RegExp(`process ${pTmp}\\b`).test(found), found);
  ok('unrelated process not listed', !new RegExp(`process ${pOther}\\b`).test(found), found);
  ok('a path that only shares the prefix of the worktree is not listed', !new RegExp(`process ${pPrefix}\\b`).test(found), found);
  ok('slot held by a task process listed', /slot heavy\.1\.lock/.test(found), found);
  ok('slot of another process and a dead holder not listed', !/heavy\.2\.lock|medium\.1\.lock/.test(found), found);
  ok('without --fix nothing removed', alive(pCwd) && JSON.parse(fs.readFileSync(state, 'utf8')).containers.length === 3 && j && !j.removed.length);

  // --fix: only the task's leftovers go; the log gets the list.
  const log = path.join(dir, 'task', 'leftovers.md');
  ({ r, j } = run(...base, '--fix', '--log', log));
  const st = JSON.parse(fs.readFileSync(state, 'utf8'));
  ok('--fix: ok, removed listed, nothing remaining', j && j.ok === true && r.status === 0 && j.removed.length >= 8 && !j.remaining.length, r.stdout + r.stderr);
  ok('--fix: stack resources gone', !st.containers.some((x) => x.project === 'k-test') && !st.images.some((x) => x.project === 'k-test') && !st.volumes.some((x) => x.project === 'k-test') && !st.networks.length, JSON.stringify(st));
  ok('--fix: owner and neighbour stacks untouched', st.containers.length === 2 && st.images.length === 1 && st.volumes.length === 1);
  ok('--fix: task processes killed', !alive(pCwd) && !alive(pArg) && !alive(pTmp));
  ok('--fix: unrelated processes alive', alive(pOther) && alive(pPrefix));
  ok('--fix: the log names what was removed', fs.existsSync(log) && /container c1/.test(fs.readFileSync(log, 'utf8')));
  ok('docker queried only by the compose project label', fs.readFileSync(calls, 'utf8').split('\n').filter((l) => /^(ps|images|volume ls|network ls)/.test(l)).every((l) => /--filter label=com\.docker\.compose\.project=k-test\b/.test(l)));

  ({ r, j } = run(...base));
  ok('after --fix a second check is clean (exit 0)', j && j.ok && r.status === 0 && !j.found.length, r.stdout);

  // The owner's stack is refused, nothing touched.
  fs.writeFileSync(calls, '');
  ({ r, j } = run('--wt', wt, '--stack', 'own', '--owner-stack', 'own', '--fix'));
  ok('the owner stack as --stack -> refused, exit 1, no docker removal', j && !j.ok && /owner/.test(j.error || '') && !/^(rm|rmi|volume rm|network rm)/m.test(fs.readFileSync(calls, 'utf8')), r.stdout + r.stderr);
  ({ r, j } = run('--wt', '/', '--fix'));
  ok('--wt / -> refused', j && !j.ok && r.status === 1, r.stdout);
  // Without docker on PATH the stack part is skipped, said so in JSON.
  const r2 = spawnSync(process.execPath, [SCRIPT, '--wt', wt, '--stack', 'k-test'], { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: '/nonexistent' }) });
  let j2 = null; try { j2 = JSON.parse(r2.stdout); } catch { /* */ }
  ok('no docker CLI -> skipped with a reason, not a silent ok', j2 && j2.skipped.some((s) => /docker/.test(s)), r2.stdout + r2.stderr);
} finally {
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
