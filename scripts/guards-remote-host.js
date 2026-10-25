'use strict';
// The runner's half of scripts/guards-remote.js: the full guard run of a worktree on the remote runner (machine key
// remote, project key remoteRun). guards-remote.js sends this file, with scripts/corpus-remote.js bundled ahead of it,
// over ssh to `node -` and appends one call (the operation and its input as a JSON literal): the ssh command line is
// always the same two words, and no path, name or command of the project passes through the runner's shell. The job of
// a run is the same bundle saved into the run's directory and started in a session of its own (detached: setsid), so a
// lost connection, a sleeping Mac or a killed role never stops it; the Mac polls it and fetches its result.
// Layout under root (remote.root; ~/ is the runner's home), next to the donor of corpus-remote.js:
//   repo.git/              a bare repository; each run's commit arrives by git push at refs/runs/<name>/<sha> (never a
//                          branch or a tag, so nothing is ever forced)
//   wt/<name>/             the run's git worktree (git worktree add --detach <sha>) with its own copy of the donor and
//                          links into the dependency cache; the next run of that name replaces it
//   deps/<hash>/           a dependency cache directory (remoteRun.deps): the dependency files, then what their install
//                          command made; <hash> = sha256 of the base names and contents of the files, the command, the
//                          node major version, platform and arch; <hash>.ok is written after the install succeeded,
//                          <hash>.lock serialises two runs that need the same new hash
//   runs/<name>/           the current run of that name: run.json (id, sha, pid of the job and its start time), out.txt
//                          (what the job prints: its phases, the slot queue, the workers), job.json (its input),
//                          codis-agents.json (the project config of the run on the runner: its paths, the project's guard
//                          command, rerun and baseline keys), host.js (the job), guards-<name>.txt and .meta.json (the
//                          runner's log), rc (the final code, written last), fetched (the Mac took the result);
//                          runs/<name>.lock serialises two starts of one name
// A start of the same name and SHA while that run lives - or ended and was not fetched yet - attaches to it (a second
// wait step, a new agent after a killed one); a start of another SHA stops the earlier run of that name first (its
// worktree is about to be replaced; its HEAD is no longer the task's).
// Output: messages on stderr, the result as the last stdout line `REMOTE-RESULT <json>`. Exit 0 done; 64 bad input; 69
// environment (the first line of its message is "environment: <reason>").
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
/* global __codisCorpus */
const CR = typeof __codisCorpus !== 'undefined' ? __codisCorpus : require('./corpus-remote');
const { Stop, notLink, readJSON, writeJSON, withLock, sha256File } = CR;

const env = (msg) => new Stop(69, `environment: ${msg}`);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const home = (p) => (String(p).startsWith('~/') ? path.join(os.homedir(), String(p).slice(2)) : String(p));
const tail = (s, n) => String(s || '').trim().split('\n').slice(-n).join('\n');

function layout(input) {
  const R = CR.roots(input);
  return Object.assign(R, { repo: path.join(R.root, 'repo.git'), deps: path.join(R.root, 'deps'), runs: path.join(R.root, 'runs') });
}
function checkName(name) {
  if (!NAME.test(name) || name.includes('..') || name.endsWith('.lock')) throw new Stop(64, `bad run name ${JSON.stringify(name)}`);
  return name;
}
function checkSha(sha) {
  if (!SHA.test(String(sha))) throw new Stop(64, `bad commit ${JSON.stringify(sha)}`);
  return String(sha);
}
const git = (args, opts) => spawnSync('git', args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28 }, opts || {}));

// The start time of a process as ps prints it (procps on Linux, BSD ps on macOS): with the pid it names one process,
// never a later one that got the same pid.
function pstart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : null;
}
function alive(run) {
  if (!run || !run.pid) return false;
  try { process.kill(run.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return pstart(run.pid) === run.pstart;
}
const sleepS = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
// Stops a job and everything it started: the job leads its own session and process group.
function stopRun(run) {
  const kill = (sig) => { try { process.kill(-run.pid, sig); } catch { /* gone */ } };
  kill('SIGTERM');
  for (let i = 0; i < 150 && alive(run); i++) sleepS(0.2);
  if (alive(run)) { kill('SIGKILL'); for (let i = 0; i < 50 && alive(run); i++) sleepS(0.2); }
}
function pluginDir(p) {
  const d = home(p || '~/.claude/plugins/marketplaces/codis-agents');
  if (!path.isAbsolute(d) || d.split('/').includes('..')) throw new Stop(64, `bad plugin directory ${JSON.stringify(p)}`);
  return d;
}

const OPS = {
  // The plugin's version on the runner and, when it is the caller's, the runner's own environment check.
  preflight(R, input) {
    const dir = pluginDir(input.plugin);
    const pkg = readJSON(path.join(dir, 'package.json'));
    if (!pkg || typeof pkg.version !== 'string') throw env(`no codis-agents plugin at ${dir} on the runner (no package.json with a version)`);
    const commit = git(['-C', dir, 'rev-parse', 'HEAD']);
    const out = { version: pkg.version, commit: commit.status === 0 ? commit.stdout.trim() : null, plugin: dir, node: process.version, cpus: os.cpus().length };
    if (pkg.version !== input.version) return out;
    notLink(R.root); fs.mkdirSync(R.root, { recursive: true });
    const e = spawnSync(process.execPath, [path.join(dir, 'scripts', 'env-check.js'), '--path', R.root], { encoding: 'utf8' });
    try { out.envCheck = JSON.parse(e.stdout); } catch { out.envCheck = { ok: false, problems: [`env-check.js gave no answer (exit ${e.status}): ${tail(e.stderr, 3)}`] }; }
    return out;
  },
  // Is the commit in the runner's repository? The bare repository is made on first use.
  has(R, input) {
    const sha = checkSha(input.sha);
    notLink(R.root); fs.mkdirSync(R.root, { recursive: true }); notLink(R.repo);
    if (!fs.existsSync(path.join(R.repo, 'HEAD'))) {
      const i = git(['init', '--bare', '-q', R.repo]);
      if (i.status !== 0) throw env(`git init --bare ${R.repo} failed: ${tail(i.stderr, 3)}`);
    }
    return { has: git(['--git-dir', R.repo, 'cat-file', '-e', `${sha}^{commit}`]).status === 0, repo: R.repo };
  },
  start(R, input) {
    const name = checkName(String(input.name || '')), sha = checkSha(input.sha);
    if (typeof input.bundle !== 'string' || !input.job || typeof input.job !== 'object') throw new Stop(64, 'start needs the bundle and the job');
    notLink(R.root); fs.mkdirSync(R.runs, { recursive: true }); notLink(R.runs);
    const dir = path.join(R.runs, name);
    return withLock(`${dir}.lock`, { timeoutS: 600 }, () => {
      notLink(dir);
      const run = readJSON(path.join(dir, 'run.json'));
      if (run && run.sha === sha) {
        if (alive(run)) return { id: run.id, attached: true, state: 'running' };
        if (fs.existsSync(path.join(dir, 'rc')) && !fs.existsSync(path.join(dir, 'fetched'))) return { id: run.id, attached: true, state: 'done' };
      }
      let stopped = null;
      if (run && alive(run)) { stopRun(run); stopped = run.id; }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const id = `${name}@${sha.slice(0, 12)}-${Date.now()}`;
      fs.writeFileSync(path.join(dir, 'host.js'), input.bundle);
      writeJSON(path.join(dir, 'job.json'), Object.assign({}, input.job, { root: input.root, name, sha, id }));
      const outFd = fs.openSync(path.join(dir, 'out.txt'), 'a');
      const child = spawn(process.execPath, [path.join(dir, 'host.js'), 'job', path.join(dir, 'job.json')], { cwd: dir, detached: true, stdio: ['ignore', outFd, outFd] });
      fs.closeSync(outFd);
      const pid = child.pid;
      child.unref();
      writeJSON(path.join(dir, 'run.json'), { id, name, sha, pid, pstart: pstart(pid), startedAt: new Date().toISOString() });
      return { id, attached: false, state: 'running', stopped };
    });
  },
  // The state of a run and what its job printed since offset (bytes).
  poll(R, input) {
    const name = checkName(String(input.name || '')), dir = path.join(R.runs, name);
    const run = readJSON(path.join(dir, 'run.json'));
    if (!run || run.id !== input.id) return { state: 'gone', other: run ? run.id : null };
    const outF = path.join(dir, 'out.txt');
    let text = '', offset = Number(input.offset) || 0;
    try {
      const size = fs.statSync(outF).size, from = Math.max(offset, size - (1 << 18));
      if (size > from) {
        const fd = fs.openSync(outF, 'r'), buf = Buffer.alloc(size - from);
        try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
        text = buf.toString('utf8'); offset = size;
      }
    } catch { /* no output yet */ }
    const rc = readJSON(path.join(dir, 'rc'));
    if (rc) return { state: 'done', rc: rc.rc, text, offset };
    return { state: alive(run) ? 'running' : 'vanished', text, offset };
  },
  // The result of a finished run, once: the log, the single reruns, the job's output and the workers it got.
  fetch(R, input) {
    const name = checkName(String(input.name || '')), dir = path.join(R.runs, name);
    const run = readJSON(path.join(dir, 'run.json'));
    if (!run || run.id !== input.id) throw env(`the run ${input.id} is no longer on the runner (${run ? `${run.id} replaced it` : 'no run'})`);
    const rc = readJSON(path.join(dir, 'rc'));
    if (!rc) throw env(`the run ${input.id} has no exit code yet`);
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
    const out = read('out.txt') || '';
    const w = /^workers(?: at start)?: (\d+)/m.exec(out) || /counted as the whole budget (\d+)/.exec(out);
    fs.writeFileSync(path.join(dir, 'fetched'), new Date().toISOString() + '\n');
    return { rc: rc.rc, log: read(`guards-${name}.txt`), rerun: read(`guards-${name}.rerun.txt`), out: out.length > (1 << 18) ? out.slice(-(1 << 18)) : out, workers: w ? Number(w[1]) : null };
  },
  // The job itself (detached, its stdout and stderr are out.txt): worktree, corpus, dependencies, prepare, the check
  // for .env*, then the runner's own guards-all.sh. The exit code goes to rc whatever happens.
  job(R, input) {
    const name = checkName(String(input.name || '')), sha = checkSha(input.sha), dir = path.join(R.runs, name);
    const say = (s) => process.stdout.write(s + '\n');
    let rc;
    try { rc = job(R, input, name, sha, dir, say); } catch (e) {
      rc = e instanceof Stop ? e.code : 69;
      say(e instanceof Stop ? e.message : `environment: ${e && e.stack || e}`);
    }
    writeJSON(path.join(dir, 'rc'), { rc, at: new Date().toISOString() });
    return { rc };
  },
};

function job(R, input, name, sha, dir, say) {
  const plugin = pluginDir(input.plugin), wt = path.join(R.wt, name), t0 = Date.now();
  const cfgFile = path.join(dir, 'codis-agents.json');
  const childEnv = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile });
  const phase = (s) => say(`phase: ${s} (${Math.round((Date.now() - t0) / 1000)} s)`);
  // The project config of the run on the runner: its paths here, the project's guard keys.
  writeJSON(cfgFile, Object.assign({}, input.config || {}, { repoDir: R.repo, worktreeRoot: R.wt, sharedDir: dir }));
  const medium = (cmd, cwd, what) => {
    const r = spawnSync('zsh', [path.join(plugin, 'scripts', 'medium.sh'), 'zsh', '-c', cmd], { cwd, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw env(`${what} failed (exit ${r.status === null ? r.signal : r.status}): ${cmd}`);
  };

  phase(`worktree ${wt} on ${sha}`);
  notLink(R.wt); fs.mkdirSync(R.wt, { recursive: true }); notLink(wt);
  if (fs.existsSync(wt)) git(['--git-dir', R.repo, 'worktree', 'remove', '--force', wt]);
  fs.rmSync(wt, { recursive: true, force: true });
  git(['--git-dir', R.repo, 'worktree', 'prune']);
  // The ref keeps the commit reachable for this name even when its objects came with another name's push.
  const ref = `refs/runs/${name}/${sha}`;
  if (git(['--git-dir', R.repo, 'rev-parse', '--verify', '-q', ref]).status !== 0) {
    const u = git(['--git-dir', R.repo, 'update-ref', ref, sha]);
    if (u.status !== 0) throw env(`git update-ref ${ref} failed: ${tail(u.stderr, 3)}`);
  }
  const a = git(['--git-dir', R.repo, 'worktree', 'add', '--detach', wt, sha]);
  if (a.status !== 0) throw env(`git worktree add ${wt} ${sha} failed: ${tail(a.stderr, 3)}`);

  if (input.corpus) {
    phase('corpus: own copy of the donor');
    const c = CR.OPS.copy(R, { name, into: 'worktree' });
    say(`corpus: ${c.files} files, ${c.bytes} bytes copied in ${c.seconds} s (manifest ${c.id})`);
  }

  for (const d of input.deps || []) {
    const files = d.files.map((f) => {
      const p = path.join(wt, f);
      let st = null;
      try { st = fs.lstatSync(p); } catch { /* below */ }
      if (!st || !st.isFile()) throw env(`the dependency file ${f} is not a regular file in the commit ${sha}`);
      return { base: path.posix.basename(f), path: p, sha256: sha256File(p) };
    });
    const hash = crypto.createHash('sha256').update(JSON.stringify({ node: process.versions.node.split('.')[0], platform: process.platform, arch: process.arch,
      install: d.install, files: files.map((f) => [f.base, f.sha256]) })).digest('hex').slice(0, 16);
    fs.mkdirSync(R.deps, { recursive: true }); notLink(R.deps);
    const cache = path.join(R.deps, hash);
    withLock(`${cache}.lock`, { timeoutS: 3600 }, () => {
      if (fs.existsSync(`${cache}.ok`)) { say(`dependencies ${hash}: from the cache (${d.files.join(', ')})`); return; }
      phase(`dependencies ${hash}: install (${d.files.join(', ')})`);
      notLink(cache); fs.rmSync(cache, { recursive: true, force: true }); fs.mkdirSync(cache);
      for (const f of files) fs.copyFileSync(f.path, path.join(cache, f.base));
      medium(d.install, cache, `dependency install ${hash}`);
      fs.writeFileSync(`${cache}.ok`, new Date().toISOString() + '\n');
    });
    for (const [p, sub] of Object.entries(d.link)) {
      let target;
      try { target = fs.realpathSync(sub ? path.join(cache, sub) : cache); } catch { throw env(`the dependency install ${hash} did not make ${sub || '(its directory)'} for ${p}`); }
      const dst = path.join(wt, p);
      let there = true;
      try { fs.lstatSync(dst); } catch { there = false; }
      if (there) throw env(`${p} is in the commit ${sha}: a dependency link cannot replace it`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // Straight to the real path: a process under Node's --permission does not pass an intermediate link.
      fs.symlinkSync(target, dst, 'dir');
    }
  }

  for (const cmd of input.prepare || []) {
    phase(`prepare: ${cmd}`);
    medium(cmd, wt, 'prepare command');
  }

  // Nothing secret reaches a run: the checkout holds the commit only, the donor no .env*; anything else is refused.
  const tracked = new Set(git(['-C', wt, 'ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const secrets = [];
  (function walk(rel) {
    for (const n of fs.readdirSync(path.join(wt, rel))) {
      const r = rel ? `${rel}/${n}` : n, st = fs.lstatSync(path.join(wt, r));
      if (!rel && n === '.git') continue;
      if (/^\.env/i.test(n) && !tracked.has(r)) secrets.push(r);
      if (st.isDirectory()) walk(r);
    }
  })('');
  if (secrets.length) throw env(`.env* in the run's worktree that the commit does not hold: ${secrets.join(', ')} - refused before any guard`);

  phase('full run: guards-all.sh of the runner');
  const g = spawnSync('zsh', [path.join(plugin, 'scripts', 'guards-all.sh'), '--force', '--local', wt], { cwd: wt, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  return g.status === null ? 69 : g.status;
}

function cli(op, input) {
  let res, code = 0;
  try {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new Stop(64, `unknown operation ${JSON.stringify(op)}`);
    res = OPS[op](layout(input || {}), input || {});
  } catch (e) {
    code = e instanceof Stop ? e.code : 69;
    process.stderr.write(`${e instanceof Stop ? e.message : 'environment: ' + (e && e.message || e)}\n`);
    res = { error: e && e.message };
  }
  process.stdout.write(`REMOTE-RESULT ${JSON.stringify(res)}\n`);
  process.exitCode = code;
}

module.exports = { cli, OPS, layout, alive, pstart };

// The job: node host.js job <job.json>
if (require.main === module && process.argv[2]) {
  let input;
  try { input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); } catch (e) { console.error(`usage: guards-remote-host.js <op> <input JSON file> (${e.message})`); process.exit(64); }
  cli(process.argv[2], input);
}
