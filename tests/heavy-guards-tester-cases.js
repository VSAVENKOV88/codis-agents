'use strict';
// The tester cells of the guard runs of a codex role through the heavy channel (p-codex-A2b-1c1), a child of
// tests/heavy-guards.test.js with its own tally:
//   TG1 C1-9: a new red that is red alone too goes through the executor in its rerun: rc of the runner, "new red", never
//       flaky; a red run is not reused;
//   TG2 C1-10: guards-all.sh with CODIS_GUARDS_EXEC naming a spec that is gone: 69 "environment: heavy-exec", meta 69,
//       not reused by the next run; heavy-exec.js with a relative bin: 69;
//   TG3 C1-19: the end of the call (close) and a signal of the adapter during a run: stopped with that reason, the group
//       and every process of the run gone;
//   TG4 C1-19 (U22): a cancel during the single rerun (a rerun that ignores TERM): stopped, the slot journal line of the
//       run written with rc 143, no process left;
//   TG5 C1-21: kill -9 of the adapter, the group ends by itself: the next call closes the run as done with its rc and
//       removes the executor spec and the run's TMPDIR; after resolve --heavy stop the TMPDIR is removed too;
//   TG6 C1-23: a CODIS_GUARDS_EXEC inherited by the adapter never reaches a single run of 1b, and a guard run uses the
//       spec of the adapter, not the inherited one;
//   TG7 C1-17: a selection with a flaky guard: the quarantine is not written, the flaky guard is named;
//   TG8 the client: --kind select without --base, --base with --kind full or with an argv, an argv with a guard-run kind:
//       usage error 2, no request in the box.
// Like the parent: the fixture project of tests/fixtures/heavy-guards/project.js, real slots.zsh on a slot directory of
// the test, the pauses at 2 s, a fake machine and the fake codex of the parent (CODEX_SANDBOX=fake).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

if (process.platform !== 'darwin') { skip('tester cells of the guard runs through the heavy channel', 'needs macOS (the box is read with O_NOFOLLOW_ANY)'); done(); }
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const HX = path.join(S, 'heavy-exec.js');
const GA = path.join(S, 'guards-all.sh');
const DRIVER = path.join(__dirname, 'fixtures', 'heavy-channel', 'adapter.js');
const { makeProject } = require('./fixtures/heavy-guards/project.js');

for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-grt-')));
const kids = new Set();
process.on('exit', () => { for (const p of kids) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(T, { recursive: true, force: true }); });
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
const CODEX_LOG = path.join(T, 'codex-calls.txt');
sh('codex', `[[ $1 == --version ]] && { print -r -- "codex-cli 0.167.0"; exit 0 }\nwhile (( $# )) && [[ $1 != -- ]]; do [[ $1 == -C ]] && { cd -- $2 || exit 1; shift }; shift; done\nshift\nprint -r -- "$$ $*" >> ${JSON.stringify(CODEX_LOG)}\nexport CODEX_SANDBOX=fake\nexec "$@"`);
const codexCalls = () => { try { return fs.readFileSync(CODEX_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const id32 = () => crypto.randomBytes(16).toString('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
let caseN = 0;
function setup(po, extra) {
  const c = path.join(T, `c${++caseN}`);
  fs.mkdirSync(c);
  const P = makeProject(c, po);
  const d = { root: c, P, wt: P.wt, slots: P.slots, tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.box = path.join(d.tdir, 'calls', 'prog-1', 'heavy');
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: P.slots, SLOT_JOURNAL: path.join(P.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' }, extra || {});
  return d;
}
const svcOpts = (d, call) => ({ task: 'K', callId: call || 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: path.join(d.tdir, 'calls', call || 'prog-1', 'heavy'), stateDir: d.state, config: d.P.cfg,
  codex: path.join(bin, 'codex'), userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200 });
const open = (d, x, call) => { fs.mkdirSync(path.join(d.tdir, 'calls', call || 'prog-1', 'heavy'), { recursive: true }); return HS.openHeavyService(Object.assign(svcOpts(d, call), { inject: { probe: async () => ({}) } }, x || {})); };
const answersOf = (d) => path.join(d.state, 'K', 'heavy-calls', 'prog-1');
const answer = (d, id) => { try { return JSON.parse(fs.readFileSync(path.join(answersOf(d), `${id}.json`), 'utf8')); } catch { return null; } };
const FINAL = ['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused'];
const put = (d, id, body) => {
  fs.mkdirSync(d.box, { recursive: true });
  const tmp = path.join(d.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(d.box, `${id}.json`));
};
const journal = (d) => read(path.join(d.state, 'K', 'heavy.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const slotLines = (d) => read(path.join(d.slots, 'journal.tsv')).split('\n').filter(Boolean).map((l) => l.split('\t'));
const req = (d, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answersOf(d) }) });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(Object.assign({ rcClient: rc }, j || {})); });
});
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const procsOf = (dir) => String(spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout).split('\n').filter((l) => l.includes(dir) && !l.includes(' ps -axo'));
const gaRun = (d, args, envx) => spawnSync('zsh', [GA].concat(args), { cwd: d.wt, encoding: 'utf8', timeout: 120000, env: Object.assign({}, d.env, { CODIS_AGENTS_CONFIG: d.P.cfg }, envx || {}) });
const pgidOf = (d, id) => (journal(d).find((e) => e.id === id && e.ev === 'running') || {}).pgid;

(async () => {
  // ---- TG1 C1-9: a new red, red alone too
  {
    const d = setup({ guards: { 'a.g': 'exit 0', 'red.g': 'exit 3' } });
    const svc = open(d);
    const c0 = codexCalls().length;
    const a = await req(d, ['--kind', 'full', '--max', '120']);
    const OUT = path.join(d.P.shared, 'guards-wt.txt'), log = read(OUT), rr = read(path.join(d.P.shared, 'guards-wt.rerun.txt'));
    ok('TG1 C1-9 a new red that is red alone: done with the runner\'s rc 1, "new red, red again alone", never flaky', a.state === 'done' && a.rc === 1 && /new red, red again alone: guards\/red\.g/.test(log) && !/flaky, red under load/.test(log),
      JSON.stringify(a) + log.slice(-700));
    ok('TG1 C1-9 its rerun ran in the executor (RUNNER sb=fake in the .rerun.txt), two codex calls', /RUNNER sb=fake/.test(rr) && codexCalls().length - c0 === 2, rr.slice(0, 400) + JSON.stringify(codexCalls().slice(c0)));
    ok('TG1 the meta of the red run: rc 1, sandbox:codex', (() => { const m = JSON.parse(read(`${OUT}.meta.json`) || '{}'); return m.rc === 1 && m.env === 'sandbox:codex'; })(), read(`${OUT}.meta.json`));
    const c1 = codexCalls().length;
    const b = await req(d, ['--kind', 'full', '--max', '120']);
    ok('TG1 a red run is not reused: the next full run runs again (codex called)', b.state === 'done' && b.rc === 1 && !/reused, HEAD/.test(b.tail || '') && codexCalls().length > c1, JSON.stringify(b));
    await svc.close();
  }

  // ---- TG2 C1-10: guards-all.sh with a spec that is gone; heavy-exec.js with a relative bin
  {
    const d = setup();
    const gone = path.join(d.root, 'gone-exec.json');
    const c0 = codexCalls().length;
    const r = gaRun(d, [d.wt], { CODIS_GUARDS_EXEC: gone });
    const OUT = path.join(d.P.shared, 'guards-wt.txt'), log = read(OUT), meta = JSON.parse(read(`${OUT}.meta.json`) || '{}');
    ok('TG2 C1-10 guards-all.sh with a gone spec: 69, "environment: heavy-exec" in the log, meta 69, the runner never ran', r.status === 69 && /environment: heavy-exec: /.test(log) && meta.rc === 69 && !/RUNNER /.test(log) && codexCalls().length === c0,
      `${r.status} ${r.stdout.slice(-400)} ${r.stderr.slice(-300)} ${log.slice(0, 400)} ${JSON.stringify(meta)}`);
    const r2 = gaRun(d, [d.wt], { CODIS_GUARDS_EXEC: gone });
    ok('TG2 C1-10 the run with exit 69 is not reused by the next one', r2.status === 69 && !/reused, HEAD/.test(r2.stdout), r2.stdout.slice(-400));
    const rel = path.join(d.root, 'rel.json');
    fs.writeFileSync(rel, JSON.stringify({ bin: 'codex', args: ['sandbox'], env: { PATH: '/usr/bin:/bin' } }));
    const h = spawnSync(process.execPath, [HX, rel, '--', 'true'], { cwd: d.wt, encoding: 'utf8', timeout: 30000, env: Object.assign({}, d.env, { SLOT_PATH: path.join(d.slots, 'heavy.1.lock'), GUARDS_EXCLUSIVE_LOCK: path.join(d.slots, 'x.lock') }) });
    ok('TG2 C1-10 heavy-exec.js with a relative bin: 69 "environment: heavy-exec", nothing runs', h.status === 69 && /^environment: heavy-exec: .*not \{bin, args, env\}/m.test(h.stderr) && codexCalls().length === c0, `${h.status} ${h.stderr}`);
  }

  // ---- TG3 C1-19: the end of the call and a signal of the adapter during a run
  for (const [how, why] of [['close', /the call ended/], ['signal', /the adapter got a signal/]]) {
    const d = setup({ guards: { 'stub.g': 'print STUB-STARTED; sleep 60' } });
    const svc = open(d);
    const a = await req(d, ['--kind', 'full', '--max', '1']);
    const OUT = path.join(d.P.shared, 'guards-wt.txt');
    const started = await until(() => /STUB-STARTED/.test(read(OUT)), 60000);
    const g = pgidOf(d, a.id);
    let res = null;
    if (how === 'close') res = await svc.close();
    else { svc.cancel('signalled'); await until(() => { const x = answer(d, a.id); return x && FINAL.includes(x.state); }, 30000); }
    const fin = answer(d, a.id) || {};
    ok(`TG3 C1-19 ${how} during a run: stopped (${why}), the group gone`, !!started && fin.state === 'stopped' && why.test(fin.why || '') && Number.isInteger(g) && !groupAlive(g) && (!res || res.runs.every((x) => x.state === 'stopped')),
      JSON.stringify(fin) + JSON.stringify(res));
    ok(`TG3 C1-19 ${how}: no process of the run left, the slot released`, !!(await until(() => procsOf(d.root).length === 0, 15000)) && !fs.readdirSync(d.slots).some((f) => /\.exec\.\d+$/.test(f)),
      procsOf(d.root).join('\n') + fs.readdirSync(d.slots).join(' '));
    if (how !== 'close') await svc.close();
  }

  // ---- TG4 C1-19/U22: a cancel during the single rerun, the rerun ignores TERM
  {
    const mark = path.join(T, 'rerun-started');
    const d = setup({ guards: { 'a.g': 'exit 0', 'slow.g': `[[ -n $FIX_SINGLE ]] || exit 1\ntrap '' TERM\ntouch ${JSON.stringify(mark)}\nwhile :; do sleep 0.2; done` } });
    const svc = open(d);
    const a = await req(d, ['--kind', 'full', '--max', '1']);
    const started = await until(() => fs.existsSync(mark), 60000);
    const g = pgidOf(d, a.id);
    const t0 = Date.now();
    const c = await req(d, ['cancel', '--id', a.id, '--max', '60']);
    const last = slotLines(d).filter((l) => l[6] === 'full').pop() || [];
    ok('TG4 a cancel during the single rerun: stopped (cancelled by the role), the group gone, the slot journal line rc 143', !!started && c.state === 'stopped' && /cancelled by the role/.test(c.why || '') && Number.isInteger(g) && !groupAlive(g) && last[8] === '143',
      JSON.stringify(c) + JSON.stringify(last));
    ok('TG4 no process of the run left after the stop (the stubborn rerun killed), within the pause of the service', !!(await until(() => procsOf(d.root).length === 0, 10000)) && Date.now() - t0 < 30000, `${Date.now() - t0} ms ` + procsOf(d.root).join('\n'));
    await svc.close();
  }

  // ---- TG5 C1-21: kill -9 of the adapter; (a) the group ends by itself, (b) resolve stop; the next call cleans up
  for (const end of ['alone', 'resolve']) {
    const d = setup({ guards: { 'stub.g': end === 'alone' ? 'print STUB-STARTED; sleep 3' : 'print STUB-STARTED; sleep 60' } });
    const drv = spawn(process.execPath, [DRIVER, JSON.stringify(Object.assign(svcOpts(d), { executorArgv: ['true'] }))], { env: d.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(drv.pid);
    await until(() => fs.existsSync(path.join(d.state, 'K', 'heavy.lock')), 20000);
    const id = id32();
    put(d, id, { kind: 'full', cwd: d.wt });
    const OUT = path.join(d.P.shared, 'guards-wt.txt');
    const started = await until(() => /STUB-STARTED/.test(read(OUT)), 60000);
    process.kill(drv.pid, 'SIGKILL');
    await sleep(300);
    const g = pgidOf(d, id);
    const tmp = path.join(d.tdir, 'heavy-tmp', 'prog-1', id), spec = path.join(d.state, 'K', 'heavy-runs', id, 'exec.json');
    const wasThere = fs.existsSync(tmp) && fs.existsSync(spec);
    if (end === 'alone') await until(() => !groupAlive(g), 60000);
    else await HS.resolveStop(d.state, 'K', id, { graceMs: 6000, waitMs: 2000 });
    const svc = open(d, undefined, 'prog-2');
    await sleep(300);
    const st = HS.status(d.state, 'K').runs.find((r) => r.id === id) || {};
    ok(`TG5 C1-21 kill -9 of the adapter, the group ${end === 'alone' ? 'ended by itself: the next call closes the run as done rc 0' : 'stopped by resolve: stopped'}`, !!started && wasThere && !groupAlive(g)
      && (end === 'alone' ? st.state === 'done' && st.rc === 0 : st.state === 'stopped'), JSON.stringify(st));
    ok(`TG5 C1-21/C1-26 (${end}): the next call removes the executor spec and the run's TMPDIR`, !fs.existsSync(spec) && !fs.existsSync(tmp), `spec ${fs.existsSync(spec)} tmp ${fs.existsSync(tmp)}`);
    ok(`TG5 (${end}): no process of the run left`, !!(await until(() => procsOf(d.root).length === 0, 10000)), procsOf(d.root).join('\n'));
    await svc.close();
  }

  // ---- TG6 C1-23: CODIS_GUARDS_EXEC inherited by the adapter
  {
    // no slots.lockDir in the project config: the nested heavy.sh of a single run reads the machine file of HOME inside
    // the executor (its white list has no XDG_CONFIG_HOME), and two lockDir values would refuse 78
    const d = setup({ config: { slots: {} } }, { CODIS_GUARDS_EXEC: '/nonexistent/inherited-exec.json' });
    const svc = open(d);
    const one = await req(d, ['--max', '60', '--', 'zsh', '-c', 'print -r -- "ONE exec=${CODIS_GUARDS_EXEC:-none}"']);
    ok('TG6 C1-23 a single run of 1b never sees an inherited CODIS_GUARDS_EXEC', one.state === 'done' && one.rc === 0 && /ONE exec=none/.test(read(one.log)), JSON.stringify(one) + read(one.log).slice(0, 300));
    const a = await req(d, ['--kind', 'full', '--max', '120']);
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok('TG6 C1-23 a guard run uses the adapter\'s spec, not the inherited one: the runner ran in the executor', a.state === 'done' && a.rc === 0 && /RUNNER sb=fake/.test(log) && !/inherited-exec/.test(read(a.log)), JSON.stringify(a) + log.slice(0, 300));
    await svc.close();
  }

  // ---- TG7 C1-17: a selection with a flaky guard
  {
    const d = setup();
    const svc = open(d);
    d.P.commit({ 'guards/flaky.g': '[[ -n $FIX_SINGLE ]] # changed\n' });
    const s = await req(d, ['--kind', 'select', '--base', 'main', '--max', '120']);
    const SEL = read(path.join(d.P.shared, 'guards-wt.select.txt'));
    ok('TG7 C1-17 a selection with a flaky guard: done rc 0, the flaky guard named, the quarantine not written', s.state === 'done' && s.rc === 0 && /flaky, red under load, green alone: guards\/flaky\.g/.test(SEL) && /quarantine read-only/.test(SEL)
      && !fs.existsSync(path.join(d.P.shared, 'guards-quarantine.json')), JSON.stringify(s) + SEL.slice(-800));
    await svc.close();
  }

  // ---- TG8 the client's own refusals
  {
    const d = setup();
    fs.mkdirSync(d.box, { recursive: true });
    for (const args of [['--kind', 'select'], ['--kind', 'full', '--base', 'main'], ['--base', 'main', '--', 'true'], ['--kind', 'full', '--', 'true'], ['--kind', 'select', '--base', 'main', '--', 'true']]) {
      const r = spawnSync(process.execPath, [CLIENT].concat(args), { cwd: d.wt, encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answersOf(d) }) });
      ok(`TG8 heavy-req.js ${args.join(' ')}: usage error 2, no request written`, r.status === 2 && /^heavy-req: /m.test(r.stderr) && fs.readdirSync(d.box).length === 0, `${r.status} ${r.stderr} ${fs.readdirSync(d.box).join(' ')}`);
    }
  }
  done();
})().catch((e) => { ok('the tester cells ran to their end', false, e.stack); done(); });
