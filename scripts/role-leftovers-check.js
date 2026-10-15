#!/usr/bin/env node
'use strict';
// Post-check of what a task left running (rules/multi-agent.md, "Docker" and "Machine and environment"): a tester tears
// its own stack down by the rule, and this checks that it did. Run by role-chain after every tester and at the end of
// the task, like role-diff-check.js.
// usage: role-leftovers-check.js --wt <dir> [--tmp <dir>]... [--stack <compose project>] [--owner-stack <project>]
//                                [--slots-dir <dir>] [--fix] [--log <file>]
//   -> JSON {ok, wt, stack, found, removed, remaining, skipped, error?}; exit 0 when nothing remains, 1 otherwise.
// What belongs to the task is decided by data only, never by program names:
//  - Docker: containers, networks, volumes and images carrying the label com.docker.compose.project=<stack>;
//  - processes whose cwd (lsof, or /proc/<pid>/cwd) or argv lies inside --wt or a --tmp dir (a path boundary, so
//    /w-other is not inside /w); this script and its ancestors are never counted;
//  - slots: <slots-dir>/*.who files (written by slots.zsh: "class pid date cmd") whose pid is one of those processes.
// --fix removes exactly these: docker rm -f / network rm / volume rm / rmi -f by id, SIGTERM then SIGKILL to the pids
// (a slot is released when its holder dies). The owner's stack is refused as --stack, and nothing else is touched.
// --log appends what was found and removed to a file (the task folder's leftovers.md).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.docker.compose.project';
const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function processes() {
  // pid, ppid, state, argv of every process; null when ps is not available.
  const r = run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'args=']);
  if (r.status !== 0 || r.error) return null;
  return lines(r.stdout).map((l) => {
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(l);
    return m && { pid: +m[1], ppid: +m[2], stat: m[3], args: m[4] };
  }).filter(Boolean);
}
function cwds() {
  // pid -> cwd. Linux: /proc; elsewhere lsof (its exit code is non-zero when some processes are not readable).
  const out = new Map();
  if (fs.existsSync('/proc/self/cwd')) {
    for (const p of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try { out.set(+p, fs.readlinkSync(`/proc/${p}/cwd`)); } catch { /* gone or not ours */ }
    }
    return out;
  }
  const r = run('lsof', ['-n', '-P', '-w', '-a', '-d', 'cwd', '-F', 'pn']);
  if (r.error) return null;
  let pid = null;
  for (const l of lines(r.stdout)) {
    if (l[0] === 'p') pid = +l.slice(1);
    else if (l[0] === 'n' && pid != null) out.set(pid, l.slice(1));
  }
  return out;
}
const alive = (pid) => { const ps = processes(); return !!(ps && ps.find((p) => p.pid === pid && !p.stat.startsWith('Z'))); };

function check({ wt, tmp = [], stack, ownerStack, slotsDir, fix, log }) {
  const res = { ok: false, wt, stack: stack || null, found: [], removed: [], remaining: [], skipped: [] };
  if (!wt || !path.isAbsolute(wt) || real(wt) === '/' || !fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) {
    return Object.assign(res, { error: `--wt must be an existing absolute directory other than /: ${wt}` });
  }
  if (stack && ownerStack && stack === ownerStack) {
    return Object.assign(res, { error: `refused: ${stack} is the owner's stack (ownerStackReadOnly); it is never removed` });
  }
  const roots = [...new Set([wt, ...tmp].flatMap((d) => [path.resolve(d), real(d)]))].filter((d) => d !== '/');
  const inside = (p) => roots.some((r) => p === r || p.startsWith(r + '/'));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const argRe = new RegExp(`(^|[\\s='"])(${roots.map(esc).join('|')})(?=$|[/\\s'"])`);

  // Docker resources of the task's stack, by label.
  const docker = [];
  if (stack) {
    const kinds = [['container', ['ps', '-a', '-q'], (id) => ['rm', '-f', id]],
      ['network', ['network', 'ls', '-q'], (id) => ['network', 'rm', id]],
      ['volume', ['volume', 'ls', '-q'], (id) => ['volume', 'rm', id]],
      ['image', ['images', '-q'], (id) => ['rmi', '-f', id]]];
    const list = (a) => { const r = run('docker', [...a, '--filter', `label=${LABEL}=${stack}`]); return r.error || r.status !== 0 ? null : [...new Set(lines(r.stdout))]; };
    let skippedDocker = false;
    for (const [kind, ls, rm] of kinds) {
      const ids = list(ls);
      if (ids == null) { if (!skippedDocker) res.skipped.push(`docker: the CLI is not available or failed - stack ${stack} not checked`); skippedDocker = true; continue; }
      for (const id of ids) docker.push({ kind, id, ls, rm, label: `${kind} ${id} (stack ${stack})` });
    }
  }

  // Processes of the task.
  const self = new Set();
  const ps = processes();
  const cw = ps ? cwds() : null;
  let procs = [];
  if (!ps) res.skipped.push('processes: ps is not available');
  else {
    const byPid = new Map(ps.map((p) => [p.pid, p]));
    for (let p = process.pid; p && !self.has(p); p = (byPid.get(p) || {}).ppid) self.add(p);
    if (!cw) res.skipped.push('process cwd: neither /proc nor lsof is available - argv only');
    procs = ps.filter((p) => !self.has(p.pid) && !p.stat.startsWith('Z')).map((p) => {
      const c = cw && cw.get(p.pid);
      const why = c && inside(c) ? `cwd ${c}` : argRe.test(p.args) ? 'argv' : '';
      return why && { pid: p.pid, why, args: p.args.slice(0, 200) };
    }).filter(Boolean);
  }
  const pidSet = new Set(procs.map((p) => p.pid));

  // Slots held by those processes.
  const slots = [];
  if (slotsDir && fs.existsSync(slotsDir)) {
    for (const f of fs.readdirSync(slotsDir).filter((x) => x.endsWith('.who')).sort()) {
      const w = (fs.readFileSync(path.join(slotsDir, f), 'utf8').split('\n')[0] || '').split(/\s+/);
      const pid = +w[1];
      if (pidSet.has(pid)) slots.push({ pid, label: `slot ${f.replace(/\.who$/, '')} held by pid ${pid} (${w[0]})` });
    }
  } else if (slotsDir) res.skipped.push(`slots: no directory ${slotsDir}`);

  const procLabel = (p) => `process ${p.pid} (${p.why}): ${p.args}`;
  res.found = [...docker.map((d) => d.label), ...procs.map(procLabel), ...slots.map((s) => s.label)];

  if (fix) {
    // Containers first (they hold networks, volumes and images), then the rest; each by its id only.
    for (const d of docker) run('docker', d.rm(d.id));
    for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* already gone */ } }
    for (let i = 0; i < 30 && procs.some((p) => alive(p.pid)); i++) sleep(100);
    for (const p of procs) if (alive(p.pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    for (let i = 0; i < 20 && procs.some((p) => alive(p.pid)); i++) sleep(100);
    const left = new Map();
    for (const [kind, ls] of [...new Map(docker.map((d) => [d.kind, d.ls]))]) {
      const r = run('docker', [...ls, '--filter', `label=${LABEL}=${stack}`]);
      left.set(kind, new Set(r.status === 0 ? lines(r.stdout) : docker.filter((d) => d.kind === kind).map((d) => d.id)));
    }
    for (const d of docker) (left.get(d.kind).has(d.id) ? res.remaining : res.removed).push(d.label);
    for (const p of procs) (alive(p.pid) ? res.remaining : res.removed).push(procLabel(p));
    for (const s of slots) (alive(s.pid) ? res.remaining : res.removed).push(s.label);
  } else res.remaining = res.found.slice();

  res.ok = res.remaining.length === 0;
  if (log && (res.found.length || res.skipped.length)) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const sect = (t, a) => (a.length ? `${t}:\n${a.map((x) => '- ' + x).join('\n')}\n` : '');
    fs.appendFileSync(log, `\n## ${new Date().toISOString()} leftovers of ${wt}${stack ? ' / stack ' + stack : ''}\n`
      + sect('found', res.found) + sect('removed', res.removed) + sect('remaining', res.remaining) + sect('skipped', res.skipped));
  }
  return res;
}

module.exports = { check };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const many = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  let r;
  try {
    r = check({ wt: arg('--wt'), tmp: many('--tmp'), stack: arg('--stack'), ownerStack: arg('--owner-stack'),
      slotsDir: arg('--slots-dir'), fix: a.includes('--fix'), log: arg('--log') });
  } catch (e) { r = { ok: false, error: e.message, found: [], removed: [], remaining: [], skipped: [] }; }
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
