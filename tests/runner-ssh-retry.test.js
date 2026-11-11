#!/usr/bin/env node
'use strict';
// A lost ssh connection to the remote runner (p-runner-ssh-retry, cells R1-R20 of its analysis): every ssh call of
// guards-remote.js (preflight, has, the git push, start, poll, fetch) is tried again after a pause when ssh itself
// failed (exit 255, ssh(1) EXIT STATUS), up to 3 attempts; a host key mismatch, an answer of the runner, a missing ssh
// and an ssh killed by a signal here are not retried. Every operation of the runner is safe to repeat: an attempt that
// ran before the connection was lost is found by the next one (has after a failed push; start attaches to the run).
// No network: ssh is a fake on PATH that runs the remote command with sh in a temporary "server" home and follows a
// plan of failures (FAKE_PLAN): on an operation (read from the script on stdin) or on the N-th node call (read before
// stdin - an EPIPE needs the input unread), "pre" - exit 255 before running it, "post" - run it, then exit 255, "bg" -
// start it in the background and exit 255 at once, "hostkey", "answer69", "kill" (status null here).
// guards-remote.js runs directly (no guards-all.sh here); the runner's half and its guards-all.sh are this checkout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-retry-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs');
const calls = path.join(T, 'calls.log'), plan = path.join(T, 'plan.json'), state = plan + '.state';
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const until = (f, s) => { const t = Date.now() + s * 1000; while (Date.now() < t) { if (f()) return true; sleep(0.1); } return f(); };
const RESET = 'Connection reset by 203.0.113.1 port 22';

try {
  // R18: the defaults are the owner's answer (2026-11-11, "as recommended"): 3 attempts, pauses 10 s and 30 s; the pause
  // is set by GUARDS_REMOTE_SSH_PAUSE (0 allowed: the tests do not sleep).
  const GR = require('../scripts/guards-remote');
  ok('R18: 3 attempts per ssh call, pauses 10 s then 30 s by default', GR.SSH_ATTEMPTS === 3 && typeof GR.sshPause === 'function'
    && GR.sshPause(1, {}) === 10 && GR.sshPause(2, {}) === 30, `${GR.SSH_ATTEMPTS} ${typeof GR.sshPause === 'function' && [GR.sshPause(1, {}), GR.sshPause(2, {})]}`);
  ok('R18: GUARDS_REMOTE_SSH_PAUSE sets every pause (0 included); a value that is not a number is ignored',
    typeof GR.sshPause === 'function' && GR.sshPause(1, { GUARDS_REMOTE_SSH_PAUSE: '0' }) === 0 && GR.sshPause(2, { GUARDS_REMOTE_SSH_PAUSE: '2.5' }) === 2.5
      && GR.sshPause(2, { GUARDS_REMOTE_SSH_PAUSE: 'x' }) === 30);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('R18: README names the retry of a lost ssh call (3 attempts, GUARDS_REMOTE_SSH_PAUSE)', /GUARDS_REMOTE_SSH_PAUSE/.test(readme) && /3 attempts/.test(readme));

  if (!(has('zsh') && has('perl'))) skip('ssh retry end to end', 'zsh or perl not found');
  else {
    for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    // The fake ssh. The plan: [{op | call, mode, times}]; an entry is used up after `times` matches (default 1). A node
    // call is counted before its stdin is read (entries with `call`: the N-th node call, an array of N allowed).
    fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync, spawn } = require('child_process');
const a = process.argv.slice(2);
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8') || '[]');
let st; try { st = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN + '.state', 'utf8')); } catch { st = { node: 0, used: [] }; }
const isPush = cmd.includes('git-receive-pack');
if (!isPush) st.node++;
const take = (m) => { const k = plan.findIndex((e, j) => (st.used[j] || 0) < (e.times || 1) && m(e)); if (k < 0) return null; st.used[k] = (st.used[k] || 0) + 1; return plan[k]; };
let e = isPush ? null : take((e) => e.call !== undefined && [].concat(e.call).includes(st.node));
let input = null, op = 'push';
if (!e && !isPush) {
  input = fs.readFileSync(0);
  const m = [...input.toString('utf8').matchAll(/module\\.exports\\.cli\\("(\\w+)"/g)].pop();
  op = m ? m[1] : '?';
}
if (!e) e = take((e) => e.op === op);
if (e && e.call !== undefined && !isPush) op = 'call' + st.node;
fs.writeFileSync(process.env.FAKE_PLAN + '.state', JSON.stringify(st));
const mode = e ? e.mode : 'ok';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ op, mode, n: st.node }) + '\\n');
const lost = () => { process.stderr.write(${JSON.stringify(RESET)} + '\\n'); process.exit(255); };
if (mode === 'epipe' || mode === 'pre') lost();
if (mode === 'hostkey') { process.stderr.write('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\\nHost key verification failed.\\n'); process.exit(255); }
if (mode === 'answer69') { process.stdout.write('REMOTE-RESULT {"error":"busy"}\\n'); process.stderr.write('environment: the runner is busy\\n'); process.exit(69); }
if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
if (mode === 'bg') {
  const f = process.env.FAKE_PLAN + '.bg-input'; fs.writeFileSync(f, input);
  spawn('sh', ['-c', cmd + ' < ' + JSON.stringify(f) + ' > /dev/null 2>&1'], { env, cwd: ${JSON.stringify(S)}, detached: true, stdio: 'ignore' }).unref();
  lost();
}
const r = spawnSync('sh', ['-c', cmd], { stdio: [input === null ? 'inherit' : 'pipe', 'inherit', 'inherit'], input: input === null ? undefined : input, env, cwd: ${JSON.stringify(S)} });
if (mode === 'post') lost();
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
    // the project: full.sh logs where it ran and prints a tally of one guard
    const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
    put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/full.count"\necho "Guards to run: 1"\necho "TOTAL: 1 green, 0 NEW red, 0 known red, 1 total"\nexit 0\n`, 0o755);
    put('one.sh', '#!/bin/sh\necho "TOTAL: 1 total"\nexit 0\n', 0o755);
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'xw'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'pw'));
    const xw = path.join(wts, 'xw'), pw = path.join(wts, 'pw');
    const head = (w) => git(w, 'rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(T, 'key'), 'not a key\n'); fs.writeFileSync(path.join(T, 'kh'), 'example.org ssh-ed25519 AAAA\n');
    const remote = { host: 'example.org', user: 'runner', key: path.join(T, 'key'), knownHosts: path.join(T, 'kh'), root: '~/codis-runs', plugin: ROOT };
    const mfile = path.join(T, 'machine.json');
    fs.writeFileSync(mfile, JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(T, 'slots') }, remote }));
    fs.mkdirSync(path.join(S, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.config', 'codis-agents', 'machine.json'), JSON.stringify({ configVersion: 1, swapMinMB: 0, minFreeDiskGB: 0, slots: { lockDir: path.join(S, 'slots'), heavy: 2, medium: 2, total: 4, jobsAlone: 4, jobsShared: 2 } }));
    const cfgFile = path.join(T, 'cfg.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared, guardCommand: 'cd {wt} && ./full.sh {jobs}',
      guardRerun: { command: 'cd {wt} && ./one.sh {name}', newRedPattern: '^[XT] (\\S+(?: \\S+)*?)  \\(', tallyPattern: '^TOTAL: .*?(\\d+) total$' },
      guardSubsetCommand: 'cd {wt} && ./full.sh {onlyArgs}', worktreeSetup: { scan: [] }, protectedBranches: ['trunk'],
      remoteRun: { command: 'cd {wt} && ./full.sh {jobs}', deps: [], prepare: [], subsetCommand: 'cd {wt} && ./full.sh {onlyArgs}' } }));
    for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];
    const SRV_ENV = JSON.stringify({ SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
    const env = (extra) => Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH,
      SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', GUARDS_REMOTE_POLL: '0.3', GUARDS_REMOTE_SSH_PAUSE: '0', FAKE_SERVER_ENV: SRV_ENV, FAKE_PLAN: plan }, extra || {});
    const logOf = (n) => path.join(shared, `guards-${n}.txt`);
    const meta = (n) => JSON.parse(read(logOf(n) + '.meta.json') || '{}');
    const jobs = (n) => (read(path.join(T, 'full.count')) || '').split('\n').filter((l) => l.startsWith(path.join(R, 'wt', n) + ' ')).length;
    const settle = (n) => until(() => fs.existsSync(path.join(R, 'runs', n, 'rc')), 60);
    // one run of guards-remote.js with a plan; -> {status, out, log, calls: [{op, mode}], ops(op)}
    const go = (n, p, o) => {
      fs.writeFileSync(plan, JSON.stringify(p)); fs.rmSync(state, { force: true }); fs.rmSync(calls, { force: true });
      const args = [path.join(ROOT, 'scripts', 'guards-remote.js'), 'run', (o && o.wt) || xw, logOf(n), n, ''].concat((o && o.args) || []);
      const x = spawnSync(process.execPath, args, { encoding: 'utf8', env: env(o && o.env), timeout: 120000 });
      const c = (read(calls) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return { status: x.status, out: (x.stdout || '') + (x.stderr || ''), log: read(logOf(n)) || '', calls: c, ops: (op) => c.filter((k) => k.op === op).length };
    };
    const first = (r) => r.log.split('\n')[0];
    const ranOk = (r, n) => r.status === 0 && /^ran on runner example\.org/.test(r.log) && /^TOTAL: 1 green/m.test(r.log) && meta(n).rc === 0;
    const why = (r) => `${r.status} ${JSON.stringify(r.calls.map((k) => k.op + ':' + k.mode))} ${r.out.slice(-700)} | ${r.log.slice(0, 400)}`;

    // the baseline: no failure - one call per operation, no line of retries
    let r = go('r0', []);
    ok('R0: no failure - the run ends 0, no line of retries', ranOk(r, 'r0') && !/lost connection/.test(r.out + r.log), why(r));

    // R1-R3: preflight and has lost once (before and after running)
    r = go('r1', [{ op: 'preflight', mode: 'pre' }]);
    ok('R1: preflight lost before it ran - tried again, the run ends 0, two preflight calls', ranOk(r, 'r1') && r.ops('preflight') === 2 && jobs('r1') === 1, why(r));
    ok('C2: the log of a run that lived through a lost connection says so, after the sweep line (the third line)',
      /^ssh to example\.org: 1 lost connection retried \(preflight 1\)$/.test(r.log.split('\n')[2] || '') && /^runner: (swept|no sweep)/.test(r.log.split('\n')[1] || ''), r.log.split('\n').slice(0, 4).join(' | '));
    ok('R1: the retry is printed with the reason of ssh and the pause', /ssh to example\.org lost \(preflight, attempt 1 of 3\): Connection reset by 203\.0\.113\.1 port 22 - again in 0 s/.test(r.out), r.out.slice(0, 600));
    r = go('r2', [{ op: 'preflight', mode: 'post' }]);
    ok('R2: preflight lost after it ran (the sweep done) - tried again, the run ends 0', ranOk(r, 'r2') && r.ops('preflight') === 2 && jobs('r2') === 1, why(r));
    r = go('r3', [{ op: 'has', mode: 'pre' }]);
    ok('R3: has lost once - tried again, the run ends 0', ranOk(r, 'r3') && r.ops('has') === 2, why(r));

    // R4-R6: the push of a commit the runner does not have
    const fresh = () => { git(pw, 'commit', '-q', '--allow-empty', '-m', 'c' + Date.now()); return head(pw); };
    const onRunner = (sha) => spawnSync('git', ['--git-dir', path.join(R, 'repo.git'), 'cat-file', '-e', `${sha}^{commit}`]).status === 0;
    let sha = fresh();
    r = go('r4', [{ op: 'push', mode: 'pre' }], { wt: pw });
    ok('R4: the push lost before the ref was written (git 128) - the runner has no commit, the push again, the run ends 0',
      ranOk(r, 'r4') && r.ops('push') === 2 && onRunner(sha) && r.ops('has') === 2, why(r));
    sha = fresh();
    r = go('r5', [{ op: 'push', mode: 'post' }], { wt: pw });
    ok('R5: the push lost after the ref was written (git 1) - has finds the commit, no second push, the run ends 0',
      ranOk(r, 'r5') && r.ops('push') === 1 && onRunner(sha) && r.ops('has') === 2, why(r));
    const hook = path.join(R, 'repo.git', 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "refused-by-hook" >&2\nexit 1\n', { mode: 0o755 });
    sha = fresh();
    r = go('r6', [], { wt: pw });
    fs.rmSync(hook, { force: true });
    ok('R6: the push refused by the runner (git 1, no commit there) - one push, exit 69 "was refused (exit 1)" as before',
      r.status === 69 && r.ops('push') === 1 && first(r).startsWith(`environment: git push of ${sha.slice(0, 12)} to the runner was refused (exit 1): `)
        && /refused-by-hook/.test(r.log) && !/attempts/.test(first(r)), why(r));

    // R7, R8, R19: start lost before it ran, after it ran, while it runs
    r = go('r7', [{ op: 'start', mode: 'pre' }]);
    ok('R7: start lost before it ran - started by the second call, one job on the runner', ranOk(r, 'r7') && r.ops('start') === 2 && jobs('r7') === 1 && /started the run r7@/.test(r.out), why(r));
    r = go('r8', [{ op: 'start', mode: 'post' }]);
    ok('R8: start lost after it ran - the second call attaches to that run, one job, its result', ranOk(r, 'r8') && r.ops('start') === 2 && jobs('r8') === 1
      && /attached to the run r8@\S+ on example\.org \((running|done)\): no second run/.test(r.out), why(r));
    ok('R8: the meta keeps no mark of another quarantine (the run was begun with the same, none)', meta('r8').quarantine === undefined, JSON.stringify(meta('r8')));
    r = go('r19', [{ op: 'start', mode: 'bg' }]);
    ok('R19: start lost while the first start still runs on the runner - one job, the run ends 0', ranOk(r, 'r19') && r.ops('start') === 2 && until(() => jobs('r19') >= 1, 10) && jobs('r19') === 1, why(r));

    // R9: the poll lost twice in a row (the poll's own retry of a runner's answer lives through one only)
    r = go('r9', [{ op: 'poll', mode: 'pre', times: 2 }]);
    ok('R9: the poll lost twice in a row - the run goes on and ends 0', ranOk(r, 'r9') && r.ops('poll') >= 3, why(r));

    // R10: fetch lost before and after it ran
    r = go('r10a', [{ op: 'fetch', mode: 'pre' }]);
    ok('R10: fetch lost before it ran - fetched again, the log written, code of the runner', ranOk(r, 'r10a') && r.ops('fetch') === 2, why(r));
    r = go('r10b', [{ op: 'fetch', mode: 'post' }]);
    ok('R10: fetch lost after it ran (marked fetched) - the same result again', ranOk(r, 'r10b') && r.ops('fetch') === 2, why(r));

    // R16: a selection whose start was lost after it ran - attached, the selection of the first start
    const sel = path.join(T, 'selected.json'); fs.writeFileSync(sel, JSON.stringify(['a-run.js']));
    r = go('r16', [{ op: 'start', mode: 'post' }], { args: ['--subset', 'cd {wt} && ./full.sh --only a-run.js', '--selected', sel] });
    ok('R16: a selection, start lost after it ran - attached, one job, the selection ran (--only a-run.js), exit 0',
      r.status === 0 && r.ops('start') === 2 && jobs('r16') === 1 && /--only a-run\.js/.test(read(path.join(T, 'full.count')) || '') && /attached to the run r16@/.test(r.out), why(r));

    // R11: every attempt lost - exit 69 after 3 calls of that operation
    for (const op of ['preflight', 'has', 'start', 'poll', 'fetch']) {
      r = go('r11' + op, [{ op, mode: 'pre', times: 9 }]);
      ok(`R11: ${op} lost on every attempt - exit 69 after exactly 3 calls of it, the log starts "environment: remote runner unreachable: ${RESET} (${op}, 3 attempts)"`,
        r.status === 69 && r.ops(op) === 3 && first(r) === `environment: remote runner unreachable: ${RESET} (${op}, 3 attempts)` && meta('r11' + op).rc === 69, why(r));
      ok(`R11: ${op} - the retries are in the log of the refusal`, (r.log.match(/lost \(\w+, attempt \d of 3\)/g) || []).length === 2, r.log);
      if (op === 'poll' || op === 'fetch') settle('r11' + op);
    }
    sha = fresh();
    r = go('r11push', [{ op: 'push', mode: 'pre', times: 9 }], { wt: pw });
    ok('R11: the push lost on every attempt - exit 69 after 3 pushes (has between them), "was refused (exit 128, 3 attempts)"',
      r.status === 69 && r.ops('push') === 3 && r.ops('has') === 4 && first(r).startsWith(`environment: git push of ${sha.slice(0, 12)} to the runner was refused (exit 128, 3 attempts): `), why(r));

    // R12, R13, R15, R20: not retried
    r = go('r12', [{ op: 'preflight', mode: 'hostkey', times: 9 }]);
    ok('R12: host key mismatch - one ssh call, exit 69 "host key mismatch ... nothing done"', r.status === 69 && r.calls.length === 1 && /^environment: host key mismatch for example\.org - possible MITM; nothing done/.test(first(r)), why(r));
    r = go('r13', [{ op: 'preflight', mode: 'answer69', times: 9 }]);
    ok('R13: the runner answers 69 - one ssh call, exit 69 with the runner\'s reason', r.status === 69 && r.calls.length === 1 && /the runner is busy/.test(first(r)), why(r));
    r = go('r20', [{ op: 'preflight', mode: 'kill', times: 9 }]);
    ok('R20: ssh killed by a signal here (status null) - one ssh call, exit 69', r.status === 69 && r.calls.length === 1, why(r));
    const nossh = path.join(T, 'nossh'); fs.mkdirSync(nossh);
    fs.symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), path.join(nossh, 'git'));
    r = go('r15', [], { env: { PATH: nossh } });
    ok('R15: no ssh on PATH - exit 69 at once, "remote runner unreachable", no retry line', r.status === 69 && /^environment: remote runner unreachable: .*ENOENT/.test(first(r)) && !/attempt/.test(r.out + r.log), why(r));

    // R14: an EPIPE (ssh gone before it read the script of start, ~90 KB) - the reason of ssh, not "spawnSync ssh EPIPE";
    // and an EPIPE once is retried like any lost connection
    r = go('r14', [{ call: [3, 4, 5], mode: 'epipe', times: 3 }]);
    ok('R14: start lost before ssh read its input (EPIPE) on every attempt - 69 with the line of ssh, not "spawnSync ssh EPIPE"',
      r.status === 69 && first(r) === `environment: remote runner unreachable: ${RESET} (start, 3 attempts)` && !/spawnSync ssh EPIPE/.test(r.out + r.log), why(r));
    r = go('r14b', [{ call: 3, mode: 'epipe' }]);
    ok('R14: an EPIPE of start once - tried again, the run ends 0', ranOk(r, 'r14b') && jobs('r14b') === 1, why(r));
  }
} catch (e) {
  ok('no exception', false, e && e.stack);
}
try {
  for (const n of fs.readdirSync(path.join(R, 'runs'))) { const x = JSON.parse(read(path.join(R, 'runs', n, 'run.json')) || '{}'); if (x.pid) { try { process.kill(-x.pid, 'SIGKILL'); } catch { /* gone */ } } }
} catch { /* none */ }
spawnSync('chmod', ['-R', 'u+w', T]);
fs.rmSync(T, { recursive: true, force: true });
done();
