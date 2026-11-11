'use strict';
// The tester's cells of p-runner-ssh-retry, next to tests/runner-ssh-retry.test.js (same fake runner):
// TR1-TR5 - the failure comes from the real ssh client: the fake ssh on PATH execs /usr/bin/ssh to a closed port of
//   127.0.0.1 (exit 255 of ssh itself, its own stderr line; the script on stdin left unread, so the EPIPE of a large
//   input is the real one), and the git push goes through that same real ssh (git's own exit code for a lost ssh).
// TN1-TN2 - a lost has inside the check after a failed push; a 255 that printed REMOTE-RESULT on every attempt.
// TP1-TP2 - the pause is really slept: the default 10 s (no GUARDS_REMOTE_SSH_PAUSE), and the variable's value.
// TG1 - guards-all.sh end to end: a run that lived through a lost connection exits 0, its log keeps the tally, and the
//   next call on the same HEAD reuses it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-retry-t-')));
const bin = path.join(T, 'bin'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), main = path.join(T, 'main');
const S = path.join(T, 'server'), R = path.join(S, 'codis-runs');
const calls = path.join(T, 'calls.log'), plan = path.join(T, 'plan.json'), state = plan + '.state';
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const REAL_SSH = '/usr/bin/ssh';
const REFUSED = 'ssh: connect to host 127.0.0.1 port 1: Connection refused';
const RESET = 'Connection reset by 203.0.113.1 port 22';

try {
  if (!(has('zsh') && has('perl'))) skip('ssh retry, tester cells', 'zsh or perl not found');
  else if (!fs.existsSync(REAL_SSH)) skip('ssh retry, tester cells', 'no /usr/bin/ssh');
  else {
    for (const d of [bin, shared, wts, main, S]) fs.mkdirSync(d, { recursive: true });
    const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
    sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
    sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
    sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
    sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
    // The fake ssh: plan entries [{op | call, mode, times}] as in runner-ssh-retry.test.js; mode "real" runs the real
    // ssh client against a closed port with this process's stdin and stdout (nothing read here first), "pre" / "post"
    // print a reset line and exit 255 before / after running the operation.
    fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs = require('fs'); const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
const withArg = new Set(['-F', '-i', '-o', '-p', '-l', '-E', '-b', '-c', '-D', '-e', '-I', '-J', '-L', '-m', '-O', '-Q', '-R', '-S', '-W', '-w']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += withArg.has(a[i]) ? 2 : 1;
const cmd = a.slice(i + 1).join(' ');
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8') || '[]');
let st; try { st = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN + '.state', 'utf8')); } catch { st = { node: 0, used: [] }; }
const isPush = cmd.includes('git-receive-pack');
if (!isPush) st.node++;
const take = (m) => { const k = plan.findIndex((e, j) => (st.used[j] || 0) < (e.times || 1) && m(e)); if (k < 0) return null; st.used[k] = (st.used[k] || 0) + 1; return plan[k]; };
let e = isPush ? take((e) => e.op === 'push') : take((e) => e.call !== undefined && [].concat(e.call).includes(st.node));
let input = null, op = isPush ? 'push' : 'call' + st.node;
if (!e && !isPush) {
  input = fs.readFileSync(0);
  const m = [...input.toString('utf8').matchAll(/module\\.exports\\.cli\\("(\\w+)"/g)].pop();
  op = m ? m[1] : '?';
  e = take((e) => e.op === op);
}
fs.writeFileSync(process.env.FAKE_PLAN + '.state', JSON.stringify(st));
const mode = e ? e.mode : 'ok';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ op, mode, n: st.node }) + '\\n');
if (mode === 'real') {
  const r = spawnSync(${JSON.stringify(REAL_SSH)}, ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-p', '1', '127.0.0.1', 'true'], { stdio: 'inherit' });
  process.exit(r.status === null ? 254 : r.status);
}
const lost = () => { process.stderr.write(${JSON.stringify(RESET)} + '\\n'); process.exit(255); };
if (mode === 'pre') lost();
const env = Object.assign({ PATH: process.env.PATH, HOME: ${JSON.stringify(S)} }, JSON.parse(process.env.FAKE_SERVER_ENV || '{}'));
const r = spawnSync('sh', ['-c', cmd], { stdio: [input === null ? 'inherit' : 'pipe', 'inherit', 'inherit'], input: input === null ? undefined : input, env, cwd: ${JSON.stringify(S)} });
if (mode === 'post') lost();
process.exit(r.status === null ? 255 : r.status);
`, { mode: 0o755 });
    const put = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(main, f)), { recursive: true }); fs.writeFileSync(path.join(main, f), s); if (mode) fs.chmodSync(path.join(main, f), mode); };
    put('full.sh', `#!/bin/sh\necho "$PWD $*" >> "${T}/full.count"\necho "Guards to run: 1"\necho "TOTAL: 1 green, 0 NEW red, 0 known red, 1 total"\nexit 0\n`, 0o755);
    put('one.sh', '#!/bin/sh\necho "TOTAL: 1 total"\nexit 0\n', 0o755);
    git(main, 'init', '-q', '-b', 'trunk'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'project');
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'xw'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'pw'));
    git(main, 'worktree', 'add', '-q', '--detach', path.join(wts, 'gw'));
    const xw = path.join(wts, 'xw'), pw = path.join(wts, 'pw'), gw = path.join(wts, 'gw');
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
    const env = (extra) => {
      const e = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_AGENTS_MACHINE: mfile, PATH: bin + path.delimiter + process.env.PATH,
        SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', GUARDS_REMOTE_POLL: '0.3', GUARDS_REMOTE_SSH_PAUSE: '0', FAKE_SERVER_ENV: SRV_ENV, FAKE_PLAN: plan }, extra || {});
      for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
      return e;
    };
    const logOf = (n) => path.join(shared, `guards-${n}.txt`);
    const meta = (n) => JSON.parse(read(logOf(n) + '.meta.json') || '{}');
    const jobs = (n) => (read(path.join(T, 'full.count')) || '').split('\n').filter((l) => l.startsWith(path.join(R, 'wt', n) + ' ')).length;
    const callsNow = () => (read(calls) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const result = (x, n, t0) => {
      const c = callsNow();
      return { status: x.status, out: (x.stdout || '') + (x.stderr || ''), log: read(logOf(n)) || '', calls: c, ops: (op) => c.filter((k) => k.op === op).length, s: (Date.now() - t0) / 1000 };
    };
    const go = (n, p, o) => {
      fs.writeFileSync(plan, JSON.stringify(p)); fs.rmSync(state, { force: true }); fs.rmSync(calls, { force: true });
      const args = [path.join(ROOT, 'scripts', 'guards-remote.js'), 'run', (o && o.wt) || xw, logOf(n), n, ''];
      const t0 = Date.now();
      const x = spawnSync(process.execPath, args, { encoding: 'utf8', env: env(o && o.env), timeout: 180000 });
      return result(x, n, t0);
    };
    const first = (r) => r.log.split('\n')[0];
    const ranOk = (r, n) => r.status === 0 && /^ran on runner example\.org/.test(r.log) && /^TOTAL: 1 green/m.test(r.log) && meta(n).rc === 0;
    const why = (r) => `${r.status} ${JSON.stringify(r.calls.map((k) => k.op + ':' + k.mode))} ${r.out.slice(-700)} | ${r.log.slice(0, 400)}`;
    const fresh = () => { git(pw, 'commit', '-q', '--allow-empty', '-m', 'c' + Date.now()); return head(pw); };
    const onRunner = (sha) => spawnSync('git', ['--git-dir', path.join(R, 'repo.git'), 'cat-file', '-e', `${sha}^{commit}`]).status === 0;

    // TR1: preflight (call 1) refused by the real ssh once - the reason of ssh, retried, the run ends 0
    let r = go('tr1', [{ call: 1, mode: 'real' }]);
    ok('TR1: preflight - the real ssh exits 255 once - tried again with the line of ssh, the run ends 0',
      ranOk(r, 'tr1') && r.calls.length >= 5 && r.out.includes(`ssh to example.org lost (preflight, attempt 1 of 3): ${REFUSED} - again in 0 s`), why(r));
    // TR2: start (call 3, its script about 90 KB) refused by the real ssh on every attempt - ssh never reads the script,
    // so this is the real EPIPE of the incidents of 05.11 and 11.11: 69, the line of ssh, never "spawnSync ssh EPIPE"
    r = go('tr2', [{ call: [3, 4, 5], mode: 'real', times: 3 }]);
    ok('TR2: start - the real ssh refused on every attempt (EPIPE on its input) - 69 "remote runner unreachable: <ssh line> (start, 3 attempts)", no EPIPE text',
      r.status === 69 && first(r) === `environment: remote runner unreachable: ${REFUSED} (start, 3 attempts)` && !/EPIPE/.test(r.out + r.log) && meta('tr2').rc === 69
        && r.calls.filter((k) => k.mode === 'real').length === 3, why(r));
    // TR3: start refused by the real ssh once - started by the next attempt, one job
    r = go('tr3', [{ call: 3, mode: 'real' }]);
    ok('TR3: start - the real ssh refused once (EPIPE) - tried again, one job, the run ends 0',
      ranOk(r, 'tr3') && jobs('tr3') === 1 && r.out.includes(`ssh to example.org lost (start, attempt 1 of 3): ${REFUSED}`), why(r));
    // TR4: the git push through the real ssh, refused once - git's own exit code for a lost ssh is retried
    let sha = fresh();
    r = go('tr4', [{ op: 'push', mode: 'real' }], { wt: pw });
    ok('TR4: git push - its real ssh refused once (git 128) - has finds no commit, the push again, the commit on the runner, the run ends 0',
      ranOk(r, 'tr4') && r.ops('push') === 2 && onRunner(sha) && /ssh to example\.org lost \(push, attempt 1 of 3\): .* - again in 0 s/.test(r.out)
        && /^ssh to example\.org: 1 lost connection retried \(push 1\)$/m.test(r.log), why(r));
    // TR5: the push through the real ssh refused on every attempt
    sha = fresh();
    r = go('tr5', [{ op: 'push', mode: 'real', times: 9 }], { wt: pw });
    ok('TR5: git push - its real ssh refused on every attempt - 69 "was refused (exit 128, 3 attempts)", three pushes',
      r.status === 69 && r.ops('push') === 3 && first(r).startsWith(`environment: git push of ${sha.slice(0, 12)} to the runner was refused (exit 128, 3 attempts): `), why(r));

    // TN1: the push lost once and the has that checks it lost once too (node calls: preflight 1, has 2, has 3) - both
    // retried, one count each in the line of retries
    sha = fresh();
    r = go('tn1', [{ op: 'push', mode: 'pre' }, { call: 3, mode: 'pre' }], { wt: pw });
    const tl = (r.log.match(/^ssh to example\.org: (\d+) lost connections retried \((.*)\)$/m) || []);
    ok('TN1: a lost push and a lost has after it - both retried, the commit arrives, the run ends 0, the line counts has 1 and push 1',
      ranOk(r, 'tn1') && onRunner(sha) && r.ops('push') === 2 && tl[1] === '2' && (tl[2] || '').split(', ').sort().join('|') === 'has 1|push 1', why(r));
    // TN2: has answered (REMOTE-RESULT printed), then ssh exit 255 on every attempt - not taken as an answer: 69 after 3
    r = go('tn2', [{ op: 'has', mode: 'post', times: 9 }]);
    ok('TN2: has printed its result but ssh exited 255 on every attempt - 69 "unreachable ... (has, 3 attempts)", three calls',
      r.status === 69 && r.ops('has') === 3 && first(r) === `environment: remote runner unreachable: ${RESET} (has, 3 attempts)`, why(r));

    // TP1: the default pause (no GUARDS_REMOTE_SSH_PAUSE) is slept: 10 s after the first lost attempt
    r = go('tp1', [{ op: 'preflight', mode: 'pre' }], { env: { GUARDS_REMOTE_SSH_PAUSE: null } });
    ok('TP1: no GUARDS_REMOTE_SSH_PAUSE - "again in 10 s" and the run takes at least 10 s, ends 0',
      ranOk(r, 'tp1') && r.out.includes('(preflight, attempt 1 of 3): ' + RESET + ' - again in 10 s') && r.s >= 10, `${r.s} s ${why(r)}`);
    // TP2: the variable's value is slept for each of two pauses
    r = go('tp2', [{ op: 'has', mode: 'pre', times: 2 }], { env: { GUARDS_REMOTE_SSH_PAUSE: '1.5' } });
    ok('TP2: GUARDS_REMOTE_SSH_PAUSE=1.5, two lost attempts - "again in 1.5 s" twice, at least 3 s, ends 0',
      ranOk(r, 'tp2') && (r.out.match(/again in 1\.5 s/g) || []).length === 2 && r.s >= 3, `${r.s} s ${why(r)}`);

    // TG1: through guards-all.sh - one lost preflight, exit 0, the tally in the log; the same HEAD again is reused
    const ga = (n) => {
      fs.rmSync(state, { force: true }); fs.rmSync(calls, { force: true });
      const t0 = Date.now();
      return result(spawnSync('zsh', [path.join(ROOT, 'scripts', 'guards-all.sh'), gw], { encoding: 'utf8', env: env(), timeout: 180000 }), n, t0);
    };
    fs.writeFileSync(plan, JSON.stringify([{ op: 'preflight', mode: 'pre' }]));
    r = ga('gw');
    ok('TG1: guards-all.sh - a lost preflight retried, exit 0, the log has the line of retries and the tally',
      r.status === 0 && /^ran on runner example\.org/.test(r.log) && /^ssh to example\.org: 1 lost connection retried \(preflight 1\)$/m.test(r.log)
        && /^TOTAL: 1 green/m.test(r.log) && meta('gw').rc === 0, why(r));
    fs.writeFileSync(plan, '[]');
    r = ga('gw');
    ok('TG1: guards-all.sh again on the same HEAD - reused, no ssh call', r.status === 0 && /reused, HEAD /.test(r.out) && r.calls.length === 0, why(r));
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
