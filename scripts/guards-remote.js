#!/usr/bin/env node
'use strict';
// The full guard run of a worktree on the remote runner of this machine (machine key remote, project key remoteRun):
// guards-all.sh calls it instead of taking a heavy slot here. The runner's half is scripts/guards-remote-host.js.
//   1. Only the committed HEAD runs there: tracked changes are refused (78, "tracked changes not committed - remote run
//      tests HEAD only"), nothing is contacted.
//   2. ssh with only remote.key and only the remote.knownHosts file, StrictHostKeyChecking=yes, no ssh config file,
//      BatchMode, ConnectTimeout (scripts/corpus-sync.js#sshOpts); a host key that does not match is never accepted.
//      The runner's plugin must be this plugin's version, and the runner's own env-check.js must pass.
//   3. The commit goes by git push over that same ssh into <root>/repo.git at refs/runs/<name>/<sha> - not a branch and
//      not a tag, so the pre-push hook lets it through and no push is ever forced; a commit the runner has is not sent.
//   4. The runner prepares <root>/wt/<name> and runs its own guards-all.sh there, detached from ssh; new reds rerun alone
//      on the runner. This machine holds no slot meanwhile: it polls every GUARDS_REMOTE_POLL s (default 10), prints
//      "waiting for remote run <id> on <host> ..." at least every SLOT_SAY s (default 30) and the job's own lines
//      ("runner: ..."), and guards-all.sh writes one journal line of class remote for the whole run.
//   5. The log comes back to <log> (guards-all.sh's <sharedDir>/guards-<name>.txt) with the first line
//      "ran on runner <host>, HEAD <sha>, workers N (run <id>, plugin <version>)", the single reruns to
//      <log base>.rerun.txt, and the meta record with env "remote:<host>" (scripts/guards-result.js: a result is reused
//      only in the environment it came from).
//   6. Guards the runner does not run (remoteRun.localPattern over its log, e.g. those needing a font only this machine
//      has) run here after it, in a heavy slot, by remoteRun.localCommand; they go into the same log as a section of
//      their own (new reds there rerun alone too, known reds subtracted) and the exit code is the worse of the two:
//      the runner's when it is not 0, else this part's.
// Exit: the run's final code; 78 configuration (no remote or remoteRun, tracked changes, a worktree name the runner
// cannot take); 69 environment - the runner unreachable, a host key mismatch, another plugin version there, its
// env-check, a push refused, dependencies or prepare failing, the run vanished: the log then starts with
// "environment: <reason>" and the meta keeps 69, so it is never reused.
// usage: guards-remote.js run <worktree> <log> <name>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./config');
const G = require('./guards-result');
const { sshOpts, sshE } = require('./corpus-sync');
const { Stop } = require('./corpus-remote');

const env = (msg) => new Stop(69, `environment: ${msg}`);
const say = (s) => process.stdout.write(s + '\n');
const sleepS = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// What the runner sends is shown in terminals and read by roles: control characters (terminal escapes, BEL, CR) are
// dropped, tab and newline stay. deep() does it for every string of a result.
const clean = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const deep = (v) => (typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(deep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
const tail = (s, n) => String(s || '').trim().split('\n').slice(-n).join('\n');
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
// corpus-remote.js wrapped as a module ahead of the runner's half: one script on stdin, no file of this plugin needed
// on the runner beyond its guards-all.sh, slots and env-check of the same version.
const strip = (s) => s.replace(/^#![^\n]*\n/, '');
const BUNDLE = `'use strict';\nconst __codisCorpus = (function () { const module = { exports: {} }; const exports = module.exports;\n${strip(fs.readFileSync(path.join(__dirname, 'corpus-remote.js'), 'utf8'))}\nreturn module.exports; })();\n`
  + strip(fs.readFileSync(path.join(__dirname, 'guards-remote-host.js'), 'utf8'));

function remoteOp(r, op, input) {
  const script = `${BUNDLE}\n;module.exports.cli(${JSON.stringify(op)}, ${JSON.stringify(Object.assign({ root: r.root }, input || {}))});\n`;
  const p = spawnSync('ssh', [...sshOpts(r), `${r.user}@${r.host}`, 'node -'], { input: script, encoding: 'utf8', maxBuffer: 1 << 29 });
  p.stderr = clean(p.stderr || '');
  const line = (p.stdout || '').split('\n').filter((l) => l.startsWith('REMOTE-RESULT ')).pop();
  if (p.error) throw env(`remote runner unreachable: ${p.error.message}`);
  if (!line) {
    const err = (p.stderr || '').trim().split('\n').filter(Boolean).pop() || `ssh exit ${p.status}`;
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(p.stderr || '')) throw env(`host key mismatch for ${r.host} - possible MITM; nothing done (${err})`);
    throw env(`remote runner unreachable: ${err}`);
  }
  if (p.status !== 0) throw new Stop(p.status === 64 ? 64 : 69, (p.stderr || '').trim() || `environment: remote ${op} failed (exit ${p.status})`);
  return deep(JSON.parse(line.slice('REMOTE-RESULT '.length)));
}

function gitState(wt) {
  const h = spawnSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (h.status !== 0) return { head: null, clean: false };
  const s = spawnSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return { head: h.stdout.trim(), clean: s.status === 0 && s.stdout.trim() === '' };
}

// The project config of the run on the runner: the guard keys of this project; its paths are set there.
function runnerConfig(c) {
  const x = c.remoteRun;
  const o = { guardCommand: x.command, protectedBranches: [], reportLanguage: c.reportLanguage, guardExclusive: c.guardExclusive };
  if (x.commandLegacy) { o.guardCommandLegacy = x.commandLegacy; if (c.guardAdaptiveProbe) o.guardAdaptiveProbe = c.guardAdaptiveProbe; }
  if (c.guardRerun) o.guardRerun = c.guardRerun;
  if (c.guardBaseline) o.guardBaseline = c.guardBaseline;
  return o;
}

function run(c, wt, log, name) {
  const r = c.remote, x = c.remoteRun, envId = `remote:${r.host}`;
  const g = gitState(wt);
  if (!g.head) throw new Stop(78, `guards-remote: ${wt} is not a git worktree with a commit - nothing to run remotely`);
  if (!g.clean) throw new Stop(78, `guards-remote: tracked changes not committed - remote run tests HEAD only (${wt}); commit them, or set the machine key remote aside to run here`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || name.endsWith('.lock')) throw new Stop(78, `guards-remote: the worktree name ${JSON.stringify(name)} cannot name a run on the runner (letters, digits, . _ -; no .., not ending in .lock)`);
  const sha = g.head;
  G.metaStart(wt, log, x.command, envId);
  let id = null;
  const said = [];
  const fail = (e) => {
    const msg = e.message.replace(/^environment: /, '');
    process.stderr.write(`environment: ${msg}\n`);
    fs.writeFileSync(log, `environment: ${msg}\nran on runner ${r.host}, HEAD ${sha}${id ? ` (run ${id})` : ''}, no result\n${said.length ? '\n' + said.join('\n') + '\n' : ''}`);
    G.metaEnd(wt, log, 69, { runner: { host: r.host, id } });
    return 69;
  };
  try {
    const pf = remoteOp(r, 'preflight', { plugin: r.plugin, version: VERSION });
    if (pf.version !== VERSION) throw env(`the plugin on the runner is version ${pf.version} (${pf.plugin}${pf.commit ? ` at ${pf.commit.slice(0, 7)}` : ''}), this machine's is ${VERSION} - update the runner's plugin to the same version; no run`);
    if (!pf.envCheck || !pf.envCheck.ok) throw env(`the runner's env-check failed: ${JSON.stringify(pf.envCheck)}`);
    say(`remote runner ${r.host}: plugin ${pf.version}, node ${pf.node}, ${pf.cpus} CPUs; env-check ok`);
    const h = remoteOp(r, 'has', { sha });
    if (!h.has) {
      const url = `${r.user}@${r.host}:${(r.root.startsWith('~/') ? r.root.slice(2) : r.root).replace(/\/+$/, '')}/repo.git`;
      const ref = `refs/runs/${name}/${sha}`;
      say(`push ${sha.slice(0, 12)} -> ${r.host} ${ref}`);
      const p = spawnSync('git', ['-C', wt, 'push', '--no-follow-tags', '--', url, `${sha}:${ref}`],
        { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_SSH_COMMAND: sshE(r), GIT_SSH_VARIANT: 'ssh' }), maxBuffer: 1 << 26 });
      if (p.status !== 0) throw env(`git push of ${sha.slice(0, 12)} to the runner was refused (exit ${p.status}): ${tail(p.stderr, 5)}`);
    } else say(`commit ${sha.slice(0, 12)} already on ${r.host} - nothing sent`);
    const job = { plugin: r.plugin, corpus: c.worktreeSetup.scan.length > 0, deps: x.deps, prepare: x.prepare, config: runnerConfig(c) };
    const st = remoteOp(r, 'start', { name, sha, bundle: BUNDLE, job });
    id = st.id;
    say(st.attached ? `attached to the run ${id} on ${r.host} (${st.state}): no second run` : `started the run ${id} on ${r.host}${st.stopped ? ` (stopped the earlier run ${st.stopped} of ${name})` : ''}`);
    const POLL = Number(process.env.GUARDS_REMOTE_POLL) > 0 ? Number(process.env.GUARDS_REMOTE_POLL) : 10;
    const SAY = Number(process.env.SLOT_SAY) > 0 ? Number(process.env.SLOT_SAY) : 30;
    const t0 = Date.now();
    let offset = 0, lastSay = 0, where = 'starting', failed = 0, buf = '';
    for (;;) {
      let p;
      try { p = remoteOp(r, 'poll', { name, id, offset }); failed = 0; } catch (e) {
        // one more try after a pause, then the connection counts as lost
        if (!(e instanceof Stop) || e.code !== 69 || ++failed > 1) throw e;
        say(`runner ${r.host} did not answer the poll (${e.message.replace(/^environment: /, '')}) - one more try in ${POLL} s`);
        sleepS(POLL); continue;
      }
      offset = p.offset === undefined ? offset : p.offset;
      if (p.text) {
        buf += p.text;
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) {
          say(`runner: ${l}`); said.push(l); if (said.length > 60) said.shift();
          const pos = /position (\d+) in queue/.exec(l), ph = /^phase: (.*?) \(\d+ s\)$/.exec(l);
          if (pos) where = `position ${pos[1]} in the runner's slot queue`;
          else if (ph) where = ph[1];
          else if (/^workers/.test(l)) where = l;
        }
      }
      if (p.state === 'done') break;
      if (p.state === 'gone') throw env(`the run ${id} was replaced on the runner by ${p.other || 'nothing'} (another start of ${name})`);
      if (p.state === 'vanished') throw env(`the run ${id} vanished on the runner: no process and no exit code (a reboot, an OOM kill or a kill) - start it again`);
      if (Date.now() - lastSay >= SAY * 1000) { say(`waiting for remote run ${id} on ${r.host} (${Math.round((Date.now() - t0) / 1000)} s): ${where}`); lastSay = Date.now(); }
      sleepS(POLL);
    }
    const f = remoteOp(r, 'fetch', { name, id });
    let rc = f.rc;
    if (!f.log) {
      const why = (f.out.split('\n').find((l) => l.startsWith('environment: ')) || `environment: the runner wrote no log (exit ${f.rc})`).replace(/^environment: /, '');
      said.length = 0; said.push(...tail(f.out, 60).split('\n'));
      throw env(why);
    }
    fs.writeFileSync(log, `ran on runner ${r.host}, HEAD ${sha}, workers ${f.workers === null ? '?' : f.workers} (run ${id}, plugin ${pf.version})\n${f.log}`);
    if (f.rerun !== null) fs.writeFileSync(G.rerunLog(log), f.rerun);
    say(tail(fs.readFileSync(log, 'utf8'), 40));
    // 6. the guards the runner does not run, here
    const names = [];
    if (x.localPattern) {
      for (const m of f.log.matchAll(new RegExp(x.localPattern, 'gm'))) for (const n of (m[1] || '').split(/,\s*/)) if (n.trim() && !names.includes(n.trim())) names.push(n.trim());
    }
    if (names.length) {
      const base = log.endsWith('.txt') ? log.slice(0, -4) : log, local = `${base}.local.txt`;
      const cmd = x.localCommand.replace(/\{wt\}/g, () => q(wt)).replace(/\{onlyArgs\}/g, () => names.map((n) => `--only ${q(n)}`).join(' '));
      say(`on this machine: ${names.length} guard(s) the runner does not run - ${names.join(', ')}`);
      const fd = fs.openSync(local, 'w');
      let lr;
      try {
        lr = spawnSync('zsh', [path.join(__dirname, 'heavy.sh'), 'zsh', '-c', cmd], { cwd: wt, stdio: ['ignore', fd, fd],
          env: Object.assign({}, process.env, { SLOT_LABEL: `guards-all ${name} part here` }) });
      } finally { fs.closeSync(fd); }
      let lrc = lr.status === null ? 1 : lr.status;
      if (c.guardRerun) lrc = G.rerun({ wt, log: local, rc: lrc, cfg: c.guardRerun, baseline: c.guardBaseline || '' }).rc;
      const final = rc !== 0 ? rc : lrc;
      const section = `\n==== on this machine: guards the runner does not run (remoteRun.localPattern): ${names.join(', ')} ====\n${fs.readFileSync(local, 'utf8')}`
        + `\npart here: exit ${lrc}; the run's exit ${final} (the worse of the runner's ${rc} and this part's ${lrc})\n`;
      fs.appendFileSync(log, section);
      say(tail(section, 25));
      rc = final;
    }
    G.metaEnd(wt, log, rc, { runner: { host: r.host, id, workers: f.workers } });
    return rc;
  } catch (e) {
    if (e instanceof Stop && e.code === 69) return fail(e);
    throw e;
  }
}

function main(argv) {
  const [cmd, wt, log, name] = argv;
  if (cmd !== 'run' || !wt || !log || !name) throw new Stop(64, 'usage: guards-remote.js run <worktree> <log> <name>');
  const file = C.find();
  if (!file) throw new Stop(78, 'guards-remote: no project config found (set CODIS_AGENTS_CONFIG)');
  const l = C.load(file);
  if (l.errors.length) throw new Stop(78, l.errors.map((e) => 'codis-agents config: ' + e).join('\n'));
  if (!l.config.remote) throw new Stop(78, `guards-remote: no key remote in the machine file ${l.config.machine.path} - no runner`);
  if (!l.config.remoteRun) throw new Stop(78, `guards-remote: no remoteRun in the project config ${file} - the runner does not know how to prepare this project`);
  return run(l.config, wt, log, name);
}

module.exports = { run, runnerConfig, BUNDLE, VERSION };

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof Stop)) throw e;
    process.stderr.write(e.message + '\n');
    process.exitCode = e.code;
  }
}
