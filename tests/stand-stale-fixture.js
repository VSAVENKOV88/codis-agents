'use strict';
// Real git and zsh, isolated project commands and slot directories; never a live stand.
require('./lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const S = path.resolve(__dirname, '../scripts');
module.exports = function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stand-stale-')));
  const repo = path.join(root, 'repo'), slots = path.join(root, 'slots'), cfg = path.join(root, 'config.json');
  const bin = path.join(root, 'bin'), calls = path.join(root, 'calls'), baseFile = path.join(root, 'base');
  for (const d of [repo, slots, bin]) fs.mkdirSync(d);
  const put = (f, v) => fs.writeFileSync(f, v);
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (cwd, file, contents) => { put(path.join(cwd, file), contents); git(cwd, 'add', '--', file); git(cwd, 'commit', '-qm', file); return git(cwd, 'rev-parse', 'HEAD'); };
  const base = commit(repo, 'Dockerfile', 'FROM base\n');
  git(repo, 'branch', 'arc');
  const target = commit(repo, 'Dockerfile', 'FROM next\n');
  const task = commit(repo, 'app.js', 'task\n');
  const worktree = (name, ref) => { const dir = path.join(root, name); git(repo, 'worktree', 'add', '-q', '--detach', dir, ref); return dir; };
  const wt = worktree('task', task);
  const config = { repoDir: repo, worktreeRoot: path.join(root, 'wts'), sharedDir: path.join(root, 'shared'),
    guardCommand: 'cd {wt} && true', slots: { lockDir: slots, legacyLock: path.join(root, 'legacy') },
    stand: { project: 'test-stand', cwd: repo, ports: [], status: `test ! -e ${root}/down`,
      reset: `echo reset >> ${calls}`, deploy: `echo deploy {wt} >> ${calls}; test ! -e ${root}/deploy-fail`,
      up: `echo up >> ${calls}`, down: `echo down >> ${calls}`, imageFiles: ['Dockerfile'] } };
  const save = () => put(cfg, JSON.stringify(config)); save(); put(baseFile, base + '\n');
  const fake = (f, body) => { put(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
  fake('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint "total = 30000.00M used = 1000.00M free = 20000.00M (encrypted)"');
  fake('memory_pressure', 'print "System-wide memory free percentage: 20%"');
  fake('vm_stat', 'print "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint "Swapouts: 0."');
  fake('df', 'print "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint "/dev/disk 100000 0 0 0% /System/Volumes/VM"');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_SLOT_|CLAUDE_PROJECT_DIR$)/.test(k)) delete env[k];
  Object.assign(env, { CODIS_AGENTS_CONFIG: cfg, PATH: bin + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.1', SLOT_SAY: '1', CODIS_TRAIN_POLL: '0.1' });
  const procs = [];
  const run = (exe, args, cwd = wt) => {
    const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
    return { ...r, text: (r.stdout || '') + (r.stderr || '') };
  };
  const start = (exe, args, cwd = wt) => {
    const p = spawn(exe, args, { cwd, env }); p.text = ''; p.ended = false;
    p.stdout.on('data', d => { p.text += d; }); p.stderr.on('data', d => { p.text += d; });
    p.on('exit', rc => { p.ended = true; p.rc = rc; }); procs.push(p); return p;
  };
  const wait = async (fn) => { const until = Date.now() + 15000; while (!fn() && Date.now() < until) await new Promise(r => setTimeout(r, 50)); assert(fn(), 'timed out waiting for fixture condition'); };
  const stop = async p => { if (!p.ended) p.kill('SIGTERM'); await wait(() => p.ended); };
  return { root, repo, wt, slots, cfg, calls, baseFile, base, target, task, config, save, put, git, commit, worktree, env, run, start, wait, stop,
    log: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    st: (...args) => run('zsh', [path.join(S, 'stand.sh'), ...args]),
    tr: (...args) => run(process.execPath, [path.join(S, 'train.js'), ...args]),
    take: (dir = wt) => start('zsh', [path.join(S, 'stand.sh'), 'take', '--wt', dir]),
    watch: (...args) => start(process.execPath, [path.join(S, 'train.js'), 'watch', '--poll', '0.1', ...args]),
    probe: () => { config.stand.imageBase = `test "$PWD" = ${repo} || exit 9; cat ${baseFile}`; save(); },
    cleanup: async () => { for (const p of procs) await stop(p); fs.rmSync(root, { recursive: true, force: true }); }, S };
};
