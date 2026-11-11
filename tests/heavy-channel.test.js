#!/usr/bin/env node
'use strict';
// The heavy channel of the role adapter (p-codex A2b-1b, cells B'1-B'30 of the analysis, pass 3): a role on codex asks
// the adapter (scripts/heavy-service.js) to run a heavy command; the adapter queues a holder (scripts/slot-hold.sh) in
// the slot queue, starts a detached gate whose group G it names in the exec marker <slot>.exec.<G> before "go", runs the
// command as `zsh <class>.sh <argv>` with CODIS_SLOT_HELD, and gives the slot back only after G is gone. Here the
// executor runs without codex sandbox (inject.executor), on a slot directory of the test, with the pauses at 2 s; the
// real sandbox is tests/heavy-channel-sandbox.test.js. Real slot-hold.sh, heavy.sh and medium.sh, a fake machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const RX = require(path.join(S, 'role-exec.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const CHAIN = path.join(S, 'chain-run.js');
const DRIVER = path.join(__dirname, 'fixtures', 'heavy-channel', 'adapter.js');

// Every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list), then the rest of the same families.
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-ch-')));
const kids = new Set();
process.on('exit', () => { for (const p of kids) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(T, { recursive: true, force: true }); });
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const id32 = () => crypto.randomBytes(16).toString('hex');
let caseN = 0;

// One case: its own slot directory, worktree, task folder, state folder, box. SLOT_HEAVY_N=1 and SLOT_MEDIUM_N=1, so a
// second job of the class waits behind the first.
function setup(extra) {
  const c = path.join(T, `c${++caseN}`);
  const d = { root: c, slots: path.join(c, 'slots'), wt: path.join(c, 'wt'), tdir: path.join(c, 'task'), state: path.join(c, 'state') };
  for (const x of [d.slots, d.wt, d.tdir, d.state]) fs.mkdirSync(x, { recursive: true });
  d.box = path.join(d.tdir, 'calls', 'prog-1', 'heavy');
  d.env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, SLOTS_DIR: d.slots, SLOT_JOURNAL: path.join(d.slots, 'journal.tsv'),
    SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '0', SLOT_HEAVY_N: '1', SLOT_MEDIUM_N: '1', SLOT_TOTAL_MAX: '4', SLOT_SWAP_MIN_MB: '0',
    SLOT_KILL_GRACE: '2', SLOT_EMPTY_WAIT: '2', GUARDS_JOBS_ALONE: '6', GUARDS_JOBS_SHARED: '3' }, extra || {});
  return d;
}
// The service of one call with the executor outside the sandbox: the inner argv (zsh <class>.sh <argv>) as is.
function open(d, o) {
  const x = o || {};
  return HS.openHeavyService(Object.assign({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state,
    kinds: { tsc: 'medium' }, userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200,
    inject: Object.assign({ probe: async () => ({}), executor: (spec) => Object.assign({}, spec, { bin: spec.inner[0], args: spec.inner.slice(1) }) }, x.inject || {}) },
  x.opts || {}));
}
const answersOf = (d) => path.join(d.state, 'K', 'heavy-calls', 'prog-1');
const answer = (d, id) => { try { return JSON.parse(fs.readFileSync(path.join(answersOf(d), `${id}.json`), 'utf8')); } catch { return null; } };
const FINAL = ['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused'];
const final = (d, id, ms) => until(() => { const a = answer(d, id); return a && FINAL.includes(a.state) ? a : null; }, ms);
const put = (d, id, body) => {
  const tmp = path.join(d.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(d.box, `${id}.json`));
};
const journal = (d) => { try { return fs.readFileSync(path.join(d.state, 'K', 'heavy.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const evs = (d, id) => journal(d).filter((e) => e.id === id).map((e) => e.ev);
const slotLines = (d) => { try { return fs.readFileSync(path.join(d.slots, 'journal.tsv'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')); } catch { return []; } };
const markers = (d) => fs.readdirSync(d.slots).filter((f) => /\.exec(tmp)?\./.test(f));
// heavy-req.js as a child process: the service runs in this process, so nothing here may block its loop
const req = (d, args, envx) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answersOf(d) }, envx || {}) });
  let out = '', err = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { err += b; });
  p.on('exit', (rc) => resolve({ status: rc, stdout: out, stderr: err }));
});
const jsonOut = (p) => { try { return JSON.parse(String(p.stdout).trim().split('\n').pop()); } catch { return null; } };
// A heavy.sh outside the channel on the same slot directory (a real waiter / holder of the queue).
const outside = (d, cmd) => {
  const p = spawn('zsh', [path.join(S, 'heavy.sh'), 'zsh', '-c', cmd], { cwd: d.wt, env: d.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.add(p.pid);
  p.out = '';
  p.stdout.on('data', (b) => { p.out += b; });
  p.stderr.on('data', (b) => { p.out += b; });
  p.done = new Promise((r) => p.on('exit', (rc) => r(rc)));
  return p;
};
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

(async () => {
  // ---- B'1, B'17, B'14: tsc of the kind table -> medium; the hold line with the label; the run files; no marker after
  {
    const d = setup();
    const svc = open(d);
    const p = await req(d, ['--kind', 'tsc', '--max', '20', '--', 'node', '-e', 'console.log("tsc-out " + process.env.CODIS_SLOT_HELD.split(" ")[0])']);
    const a = jsonOut(p);
    ok('B\'1 heavy-req -- argv: exit 0, state done, rc 0, the log and its tail', p.status === 0 && a && a.state === 'done' && a.rc === 0 && /tsc-out medium/.test(a.tail || '') && fs.existsSync(a.log || ''), `${p.status} ${p.stdout} ${p.stderr}`);
    ok('B\'1 the class of kind tsc by slots.kinds is medium', a && a.cls === 'medium' && a.kind === 'tsc', JSON.stringify(a));
    const hold = slotLines(d).find((l) => l[6] === 'hold');
    ok('B\'1 the slot journal has a line of kind hold, class medium, with the label "codex K prog <id>"', !!hold && hold[4] === 'medium' && hold[10] === `codex K prog ${a && a.id}`, JSON.stringify(slotLines(d)));
    ok('B\'17 after the answer: no exec marker left, the slot is free (a heavy.sh of the class gets it at once)', markers(d).length === 0, markers(d).join(' '));
    const e = a ? evs(d, a.id) : [];
    ok('B\'1 the run journal: queued, holding, acquired, running, group-empty, done in that order', e.join(',') === 'queued,holding,acquired,running,group-empty,done', e.join(','));
    const run = a ? journal(d).find((x) => x.id === a.id && x.ev === 'running') : null;
    ok('B\'14 the log, started and rc files lie in the state folder of the adapter (out of the role\'s roots); started and rc written',
      !!run && run.log.startsWith(d.state) && fs.existsSync(run.started) && fs.readFileSync(run.rcFile, 'utf8').trim() === '0', JSON.stringify(run));
    ok('B\'11 the running line names the group G and the slot; G is the pid of the gate', !!run && Number.isInteger(run.pgid) && run.pgid > 1 && /medium\.\d+\.lock$/.test(run.slot), JSON.stringify(run));
    await svc.close();
  }

  // ---- B'2: no kind / a kind not in the table -> heavy; an exclusive guard with kind tsc -> heavy
  {
    const d = setup();
    const svc = open(d);
    const g = path.join(d.wt, 'x-run.mjs');
    fs.writeFileSync(g, '// guards:exclusive — a fixed port of the test\nconsole.log("excl " + (process.env.GUARDS_EXCLUSIVE_LOCK ? "lock" : "none"));\n');
    const a1 = jsonOut(await req(d, ['--max', '20', '--', 'true']));
    const a2 = jsonOut(await req(d, ['--kind', 'vite', '--max', '20', '--', 'true']));
    const a3 = jsonOut(await req(d, ['--kind', 'tsc', '--max', '20', '--', 'node', 'x-run.mjs']));
    ok('B\'2 without a kind: heavy', a1 && a1.cls === 'heavy' && a1.state === 'done', JSON.stringify(a1));
    ok('B\'2 a kind not in slots.kinds: heavy', a2 && a2.cls === 'heavy' && a2.state === 'done', JSON.stringify(a2));
    ok('B\'2/B\'12 a guards:exclusive guard with kind tsc: heavy, run through heavy.sh (exclusive lock taken)', a3 && a3.cls === 'heavy' && a3.state === 'done' && /excl lock/.test(a3.tail || ''), JSON.stringify(a3));
    await svc.close();
  }

  // ---- B'3, B'4, B'5, B'8: ids, malformed requests, the closed channel, out-of-scope argv
  {
    const d = setup();
    const svc = open(d);
    const id = id32();
    put(d, id, { argv: ['node', '-e', 'require("fs").appendFileSync("count.txt", "x")'] });
    const a = await final(d, id);
    put(d, id, { argv: ['node', '-e', 'require("fs").appendFileSync("count.txt", "x")'] });
    await sleep(800);
    ok('B\'3 the same id with the same content: one run only, the answer stays', a && a.state === 'done' && fs.readFileSync(path.join(d.wt, 'count.txt'), 'utf8') === 'x', JSON.stringify(a));
    put(d, id, { argv: ['node', '-e', '1'] });
    await sleep(800);
    ok('B\'3 the same id with other content: refusal named in the journal, the first result stands', journal(d).some((e) => e.id === id && e.ev === 'refused-reuse') && answer(d, id).state === 'done', JSON.stringify(evs(d, id)));
    const before = slotLines(d).length;
    const cases = [];
    const ln = id32(); fs.writeFileSync(path.join(d.root, 'outside.json'), JSON.stringify({ id: ln, argv: ['true'] })); fs.symlinkSync(path.join(d.root, 'outside.json'), path.join(d.box, `${ln}.json`)); cases.push(['a symbolic link', ln]);
    const ff = id32(); spawnSync('mkfifo', [path.join(d.box, `${ff}.json`)]); cases.push(['a FIFO', ff]);
    const big = id32(); put(d, big, { argv: ['true', 'x'.repeat(70 * 1024)] }); cases.push(['above the size limit', big]);
    for (const [k, v] of [['cls', 'medium'], ['log', '/tmp/x'], ['profile', 'x'], ['network', true]]) { const i = id32(); put(d, i, { argv: ['true'], [k]: v }); cases.push([`an extra field ${k}`, i]); }
    const em = id32(); put(d, em, { argv: [] }); cases.push(['an empty argv', em]);
    const cw = id32(); put(d, cw, { argv: ['true'], cwd: d.root }); cases.push(['cwd outside the worktree', cw]);
    const dk = id32(); put(d, dk, { argv: ['docker', 'ps'] }); cases.push(['docker', dk]);
    const st = id32(); put(d, st, { argv: ['zsh', '/x/scripts/stand.sh', 'deploy'] }); cases.push(['stand.sh', st]);
    const ga = id32(); put(d, ga, { argv: ['zsh', '/x/scripts/guards-all.sh', d.wt] }); cases.push(['guards-all.sh', ga]);
    for (const [name, i] of cases) {
      const r = await final(d, i, 5000);
      ok(`B'4/B'8 ${name}: refused with a reason, no holder`, r && r.state === 'refused' && !!r.why, JSON.stringify(r));
    }
    ok('B\'8 docker: "environment: Docker and the stand are outside A2b"', /environment: Docker and the stand are outside A2b/.test((answer(d, dk) || {}).why || ''));
    ok('B\'8 stand.sh: the same refusal', /environment: Docker and the stand are outside A2b/.test((answer(d, st) || {}).why || ''));
    ok('B\'8 guards-all.sh: "guard runs come with A2b-1c"', /guard runs come with A2b-1c/.test((answer(d, ga) || {}).why || ''));
    ok('B\'4 no slot line for the refused requests (no holder started)', slotLines(d).length === before, `${before} -> ${slotLines(d).length}`);
    const p = spawnSync(process.execPath, [CLIENT, '--', 'true'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: '', CODIS_HEAVY_ANSWERS: '' }) });
    ok('B\'5 heavy-req.js without the channel: exit 4, "channel closed for this role"', p.status === 4 && /channel closed for this role/.test(p.stdout + p.stderr), `${p.status} ${p.stdout}`);
    await svc.close();
  }

  // ---- B'6, B'7, B'21: the queue of the adapter, the position from the holder, cancel while queued and while holding
  {
    const d = setup();
    const svc = open(d);
    const blocker = outside(d, 'sleep 3');
    await until(() => slotLines(d).length >= 0 && fs.readdirSync(d.slots).some((f) => /^heavy\.\d+\.lock\.exec\./.test(f)));
    const i1 = id32(), i2 = id32();
    put(d, i1, { argv: ['node', '-e', 'setTimeout(()=>{},300)'] });
    const w = await until(() => { const a = answer(d, i1); return a && a.state === 'holding' && a.position ? a : null; }, 10000);
    ok('B\'6 a request behind a held slot: state holding, the position and the reason from the line "waiting for slot ..."', !!w && w.position === 1 && /waiting|held by|busy|taken/.test(w.why || ''), JSON.stringify(answer(d, i1)));
    ok('B\'6 queued is journaled before holding', evs(d, i1).slice(0, 2).join(',') === 'queued,holding', evs(d, i1).join(','));
    put(d, i2, { argv: ['true'] });
    const q2 = await until(() => { const a = answer(d, i2); return a && a.state === 'queued' ? a : null; }, 5000);
    ok('B\'7 a second request of the call waits in the adapter, behind the first (no second holder)', !!q2 && /behind/.test(q2.why || '') && !evs(d, i2).includes('holding'), JSON.stringify(answer(d, i2)));
    const c = await req(d, ['cancel', '--id', i2, '--max', '10']);
    const a2 = jsonOut(c);
    ok('B\'21 cancel of a queued request: cancelled-before-start, never held', a2 && a2.state === 'cancelled-before-start' && !evs(d, i2).includes('holding'), `${c.status} ${c.stdout}`);
    const c1 = jsonOut(await req(d, ['cancel', '--id', i1, '--max', '10']));
    ok('B\'21 cancel while holding: TERM to the holder, cancelled-before-start, no ticket left in the queue', c1 && c1.state === 'cancelled-before-start' && fs.readdirSync(path.join(d.slots, 'queue')).filter((f) => !/lock/.test(f)).length <= 1, JSON.stringify(c1) + ' ' + fs.readdirSync(path.join(d.slots, 'queue')).join(' '));
    const hl = slotLines(d).find((l) => l[6] === 'hold');
    ok('B\'21 the holder\'s slot line: never acquired, rc 143', !!hl && hl[2] === '-' && hl[8] === '143', JSON.stringify(slotLines(d)));
    await blocker.done;
    await svc.close();
  }

  // ---- B'9, B'10: the environment of the executor; a holder with CODIS_SLOT_HELD in the adapter's environment
  {
    const d = setup({ CODIS_COMMIT_BOX: '/x', OPENAI_API_KEY: 'k', SLOT_LABEL: 'leak' });
    // a CODIS_SLOT_HELD of this very slot directory: inherited by the holder it would take the nested path (64, no queue)
    d.env.CODIS_SLOT_HELD = `heavy ${path.join(d.slots, 'heavy.0.lock')}`;
    const svc = open(d);
    const a = jsonOut(await req(d, ['--max', '20', '--', 'node', '-e', 'console.log("NAMES " + Object.keys(process.env).sort().join(","))']));
    const names = ((a && a.tail) || '').split('NAMES ')[1] || '';
    const list = names.trim().split(',');
    ok('B\'10 the holder queues in SLOTS_DIR of the adapter although its environment has CODIS_SLOT_HELD (a hold line there)', a && a.state === 'done' && slotLines(d).some((l) => l[6] === 'hold'), JSON.stringify(a));
    ok('B\'9 the executor has no CODIS_COMMIT_*, no API key, no box of the heavy channel, no SLOT_LABEL of the adapter', list.length > 3 && !list.some((n) => /^CODIS_COMMIT_|API_KEY$|^CODIS_HEAVY_|^SLOT_LABEL$/.test(n)), names);
    ok('B\'9 the executor has CODIS_SLOT_HELD, SLOTS_DIR, GUARDS_EXCLUSIVE_LOCK, TMPDIR, CODEX_HOME, HOME, PATH', ['CODIS_SLOT_HELD', 'SLOTS_DIR', 'GUARDS_EXCLUSIVE_LOCK', 'TMPDIR', 'CODEX_HOME', 'HOME', 'PATH'].every((n) => list.includes(n)), names);
    const run = journal(d).find((e) => e.ev === 'running');
    const inner = jsonOut(await req(d, ['--max', '20', '--', 'node', CLIENT, '--', 'true']));
    ok('B\'9 heavy-req.js inside the executor: "channel closed for this role" (exit 4)', inner && inner.state === 'done' && inner.rc === 4 && /channel closed/.test(inner.tail || ''), JSON.stringify(inner));
    ok('B\'9 the TMPDIR of the executor is its own, inside the task folder', /TMPDIR/.test(names) && !!run, JSON.stringify(run));
    await svc.close();
  }

  // ---- B'11, B'12, B'24: a real waiter does not get the slot while G lives; nested heavy.sh; kill -9 of the adapter
  {
    const d = setup();
    const drv = spawn(process.execPath, [DRIVER, JSON.stringify({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state,
      kinds: {}, userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200, executorArgv: ['/usr/bin/env'] })], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
    kids.add(drv.pid);
    await until(() => fs.existsSync(d.box));
    const id = id32();
    put(d, id, { argv: ['zsh', path.join(S, 'heavy.sh'), 'node', '-e', 'console.log("SP " + process.env.SLOT_PATH); setTimeout(()=>{}, 4000)'] });
    const run = await until(() => journal(d).find((e) => e.id === id && e.ev === 'running'), 15000);
    const mk = run ? `${run.slot}.exec.${run.pgid}` : '';
    ok('B\'11 the marker <slot>.exec.<G> exists while the command runs, no .exectmp left', !!run && fs.existsSync(mk) && !markers(d).some((f) => /exectmp/.test(f)), markers(d).join(' '));
    const w = outside(d, 'echo got-it');
    await sleep(1200);
    drv.kill('SIGKILL');
    await until(() => !slotLines(d).every((l) => l[6] !== 'hold'), 5000);
    await sleep(1500);
    ok('B\'24 kill -9 of the adapter: the holder left (its hold line closed), the marker still holds the slot, G lives', slotLines(d).some((l) => l[6] === 'hold') && fs.existsSync(mk) && groupAlive(run.pgid), JSON.stringify(slotLines(d)));
    ok('B\'11/B\'24 the waiting heavy.sh does not get the slot while G lives, and says why ("held by the exec marker ...")', !/got-it/.test(w.out) && /held by the exec marker/.test(w.out), w.out);
    const rc = await Promise.race([w.done, sleep(15000).then(() => 'timeout')]);
    ok('B\'24 after G ends the waiter gets the slot and removes the dead marker', rc === 0 && /got-it/.test(w.out) && !fs.existsSync(mk), `${rc} ${w.out}`);
    ok('B\'12 nested heavy.sh in the executor: no second ticket, SLOT_PATH is the held slot', fs.readFileSync(run.log, 'utf8').includes(`SP ${run.slot}`) && slotLines(d).filter((l) => l[6] === 'single' && /node/.test(l[10])).length === 0, fs.readFileSync(run.log, 'utf8'));
  }

  // ---- B'16, B'22, B'23: leftovers after the exit; stop of a running command; undetermined
  {
    const d = setup();
    const svc = open(d);
    const t0 = Date.now();
    const a = jsonOut(await req(d, ['--max', '30', '--', 'zsh', '-c', 'trap "" TERM; (trap "" TERM; sleep 30) & exit 3']));
    ok('B\'16 the command exits 3 and leaves a TERM-ignoring child in G: TERM, the pause, KILL; done rc 3 only after G is gone, marker removed',
      a && a.state === 'done' && a.rc === 3 && Date.now() - t0 >= 2000 && markers(d).length === 0 && evs(d, a.id).includes('group-empty'), JSON.stringify(a));
    const id = id32();
    put(d, id, { argv: ['zsh', '-c', 'sleep 30'] });
    await until(() => (answer(d, id) || {}).state === 'running');
    const c = jsonOut(await req(d, ['cancel', '--id', id, '--max', '20']));
    ok('B\'22 cancel of a running command by the role: stopping, then stopped with the reason, marker gone', c && c.state === 'stopped' && /cancelled by the role/.test(c.why || '') && evs(d, id).includes('stopping') && markers(d).length === 0, JSON.stringify(c));
    const id2 = id32();
    put(d, id2, { argv: ['zsh', '-c', 'sleep 30'] });
    await until(() => (answer(d, id2) || {}).state === 'running');
    await svc.close();
    const a2 = answer(d, id2);
    ok('B\'22 the end of the call (close) stops a running command: stopped "the call ended", the slot given after', a2 && a2.state === 'stopped' && /the call ended/.test(a2.why || '') && markers(d).length === 0, JSON.stringify(a2));
  }
  {
    const d = setup();
    let dead = false;
    const svc = open(d, { inject: { alive: (g) => (dead ? undefined : true) } });
    const id = id32();
    put(d, id, { argv: ['zsh', '-c', 'sleep 30'] });
    await until(() => (answer(d, id) || {}).state === 'running');
    const run = journal(d).find((e) => e.id === id && e.ev === 'running');
    const t0 = Date.now();
    svc.cancel('signalled');
    await sleep(300);
    svc.cancel('signalled');
    const a = await final(d, id, 15000);
    ok('B\'23 a group not gone after KILL and the wait: undetermined, "environment: run undetermined", its marker stays', a && a.state === 'undetermined' && /environment: run undetermined/.test(a.why || '') && fs.existsSync(`${run.slot}.exec.${run.pgid}`), JSON.stringify(a));
    ok('B\'23 a second signal does not shorten the pause (TERM -> 2 s -> KILL -> 2 s)', Date.now() - t0 >= 3800, String(Date.now() - t0));
    ok('B\'23 the holder is released all the same (the marker holds the slot)', slotLines(d).some((l) => l[6] === 'hold'), JSON.stringify(slotLines(d)));
    dead = true;
    await svc.close();
    fs.rmSync(`${run.slot}.exec.${run.pgid}`, { force: true });
  }

  // ---- B'18, B'20: the holder refused before acquired; the exclusive lock file
  {
    const d = setup();
    fs.writeFileSync(path.join(d.slots, 'admit.lock'), '');
    fs.chmodSync(path.join(d.slots, 'admit.lock'), 0o400);
    const svc = open(d);
    const a = jsonOut(await req(d, ['--max', '15', '--', 'true']));
    ok('B\'18 the holder exits 77 before acquired: cancelled-before-start, "environment:" with the holder\'s stderr', a && a.state === 'cancelled-before-start' && /^environment: /.test(a.why || '') && /77/.test(a.why || ''), JSON.stringify(a));
    fs.chmodSync(path.join(d.slots, 'admit.lock'), 0o600);
    await svc.close();
  }
  {
    const d = setup();
    const lock = path.join(d.slots, 'exclusive.lock');
    const svc = open(d);
    const a = jsonOut(await req(d, ['--max', '20', '--', 'true']));
    ok('B\'20 the exclusive lock file is created by the adapter before the run', a && a.state === 'done' && fs.existsSync(lock), JSON.stringify(a));
    fs.writeFileSync(lock, 'keep');
    jsonOut(await req(d, ['--max', '20', '--', 'true']));
    ok('B\'20 an existing lock file is neither truncated nor replaced', fs.readFileSync(lock, 'utf8') === 'keep');
    await svc.close();
    const d2 = setup({ GUARDS_EXCLUSIVE_LOCK: path.join(T, 'no-such-dir', 'x', 'exclusive.lock') });
    fs.writeFileSync(path.join(T, 'no-such-dir'), 'a file, not a folder');
    const svc2 = open(d2);
    const b = jsonOut(await req(d2, ['--max', '20', '--', 'node', '-e', 'require("fs").writeFileSync("ran.txt","x")']));
    ok('B\'20 a lock file that cannot be created: environment, the command never ran', b && b.state === 'cancelled-before-start' && /^environment: /.test(b.why || '') && !fs.existsSync(path.join(d2.wt, 'ran.txt')), JSON.stringify(b));
    await svc2.close();
  }

  // ---- B'25: the holder dies before "go" (requeued, one run) and while running (state unchanged)
  {
    const d = setup();
    let killed = 0;
    const svc = open(d, { inject: { beforeGo: (r) => { if (!killed++) { process.kill(r.holderPid, 'SIGKILL'); spawnSync('sleep', ['0.3']); } } } });
    const a = jsonOut(await req(d, ['--max', '25', '--', 'node', '-e', 'require("fs").appendFileSync("ran.txt","x")']));
    ok('B\'25 the holder dies before go: the gate exits 70, the run is queued again with a new holder, the command runs once',
      a && a.state === 'done' && evs(d, a.id).includes('requeued') && fs.readFileSync(path.join(d.wt, 'ran.txt'), 'utf8') === 'x', JSON.stringify(a) + ' ' + evs(d, a && a.id).join(','));
    const id = id32();
    put(d, id, { argv: ['node', '-e', 'setTimeout(()=>{}, 1500)'] });
    await until(() => (answer(d, id) || {}).state === 'running');
    const hp = journal(d).filter((e) => e.id === id && e.ev === 'holding').pop();
    process.kill(hp.pid, 'SIGKILL');
    const b = await final(d, id);
    ok('B\'25 the holder dies while running: a holder-gone line, the run ends done as before', b && b.state === 'done' && evs(d, id).includes('holder-gone'), JSON.stringify(b) + ' ' + evs(d, id).join(','));
    await svc.close();
  }

  // ---- B'26, B'27, B'28: recovery from the journal, the start check, status and resolve of the conductor
  {
    const d = setup();
    const jdir = path.join(d.state, 'K');
    fs.mkdirSync(jdir, { recursive: true });
    // a group of its own whose parent is gone (as the gate of a dead adapter): launchd reaps it, so no zombie of this
    // test keeps it alive
    const live = { pid: +spawnSync('/bin/sh', ['-c', 'perl -e \'setpgrp(0,0); exec @ARGV\' sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim() };
    kids.add(live.pid);
    await sleep(300);
    const lst = RX.procOf(live.pid).lstart;
    const dead = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
    const rf = (n) => path.join(jdir, 'heavy-runs', n);
    for (const n of ['a', 'b', 'c', 'e']) fs.mkdirSync(rf(n), { recursive: true });
    fs.writeFileSync(path.join(rf('b'), 'started'), ''); fs.writeFileSync(path.join(rf('b'), 'rc'), '5\n');
    fs.writeFileSync(path.join(rf('c'), 'started'), '');
    const ids = { a: id32(), b: id32(), c: id32(), e: id32() };
    let n = 0;
    const line = (o) => JSON.stringify(Object.assign({ v: 1, n: ++n, ts: new Date().toISOString(), call: 'old' }, o));
    const runLine = (k, pg, ls) => line({ ev: 'running', id: ids[k], pgid: pg, lstart: ls, slot: path.join(d.slots, 'heavy.0.lock'), log: path.join(rf(k), 'out.log'), started: path.join(rf(k), 'started'), rcFile: path.join(rf(k), 'rc') });
    const lines = [line({ ev: 'queued', id: ids.a, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }), runLine('a', live.pid, lst),
      line({ ev: 'queued', id: ids.b, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }), runLine('b', +dead, 'x'),
      line({ ev: 'queued', id: ids.c, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }), runLine('c', +dead, 'x'),
      line({ ev: 'queued', id: ids.e, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }), runLine('e', +dead, 'x')];
    const jf = path.join(jdir, 'heavy.jsonl');
    fs.writeFileSync(jf, lines.join('\n') + '\n{"v":1,"n":9,"ev":"tor');
    const prob = HS.journalProblem(jf);
    ok('B\'26 the start check: a run whose group lives with the leader of its record is "running without adapter" (the task waits)', /running without adapter/.test(prob || '') && prob.includes(ids.a), prob);
    const st = spawnSync(process.execPath, [CHAIN, 'status', '--heavy', d.state, '--task', 'K'], { encoding: 'utf8' });
    let sj = null; try { sj = JSON.parse(st.stdout); } catch { /* below */ }
    const byId = (i) => sj && sj.runs.find((r) => r.id === i);
    ok('B\'28 status --heavy from the journal of a dead conductor: one entry per run with state, class, slot, pgid, log', !!sj && sj.runs.length === 4 && byId(ids.a).state === 'running without adapter' && byId(ids.a).pgid === live.pid && !!byId(ids.a).log, st.stdout + st.stderr);
    ok('B\'26 group dead and rc there: done with its rc', byId(ids.b) && byId(ids.b).state === 'done' && byId(ids.b).rc === 5, JSON.stringify(byId(ids.b)));
    ok('B\'26 started, no rc, group dead: stopped, exit code lost', byId(ids.c) && byId(ids.c).state === 'stopped' && /exit code lost/.test(byId(ids.c).why || ''), JSON.stringify(byId(ids.c)));
    ok('B\'26 no started file: cancelled-before-start', byId(ids.e) && byId(ids.e).state === 'cancelled-before-start', JSON.stringify(byId(ids.e)));
    ok('B\'27 the torn last line is cut off and named', /torn/.test(sj && sj.notes ? sj.notes.join(' ') : ''), JSON.stringify(sj && sj.notes));
    const svc = open(d);
    const r = jsonOut(await req(d, ['--max', '10', '--', 'true']));
    ok('B\'26 a new call of the task refuses every request while a run lives without adapter', r && r.state === 'refused' && /running without adapter/.test(r.why || ''), JSON.stringify(r));
    await svc.close();
    const rv = spawnSync(process.execPath, [CHAIN, 'resolve', '--heavy', d.state, '--task', 'K', '--run', ids.a, 'stop'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_HEAVY_KILL_GRACE_MS: '1000', CODIS_HEAVY_EMPTY_WAIT_MS: '1000' }) });
    ok('B\'28 resolve --heavy stop: the leader matches -> the group stopped, stopped by resolve', rv.status === 0 && !groupAlive(live.pid) && HS.readHeavyJournal(jf).runs.get(ids.a).state === 'stopped' && /resolve/.test(HS.readHeavyJournal(jf).runs.get(ids.a).why || ''), rv.stdout + rv.stderr);
    ok('B\'26 after it the start check passes', HS.journalProblem(jf) === null, HS.journalProblem(jf));
    // a run whose leader is gone while its group lives (a member left): resolve refuses to signal
    const g2 = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
    kids.add(g2.pid);
    await sleep(300);
    const ix = id32();
    n = fs.readFileSync(jf, 'utf8').split('\n').filter(Boolean).length;
    fs.appendFileSync(jf, line({ ev: 'queued', id: ix, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }) + '\n' + JSON.stringify({ v: 1, n: ++n, ts: 'x', call: 'old', ev: 'running', id: ix, pgid: g2.pid, lstart: 'Mon Jan  1 00:00:00 2001', slot: '/x/heavy.0.lock', log: '/x', started: '/x', rcFile: '/x' }) + '\n');
    const rv2 = spawnSync(process.execPath, [CHAIN, 'resolve', '--heavy', d.state, '--task', 'K', '--run', ix, 'stop'], { encoding: 'utf8' });
    ok('B\'28 resolve --heavy stop when the leader is gone: refused, "leader gone: the slot stays held by the marker until the group ends"', rv2.status !== 0 && /leader gone: the slot stays held by the marker until the group ends/.test(rv2.stdout + rv2.stderr) && groupAlive(g2.pid), rv2.stdout + rv2.stderr);
    try { process.kill(-g2.pid, 'SIGKILL'); } catch { /* gone */ }
    // damage inside and an undetermined run
    const jf2 = path.join(T, 'damaged.jsonl');
    n = 0;
    fs.writeFileSync(jf2, line({ ev: 'queued', id: ids.a, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }) + '\nnot json\n' + line({ ev: 'done', id: ids.a, rc: 0 }) + '\n');
    ok('B\'27 a damaged line inside: the start check refuses with the path and the line', /damaged at line 2/.test(HS.journalProblem(jf2) || '') && (HS.journalProblem(jf2) || '').includes(jf2), HS.journalProblem(jf2));
    const jf3 = path.join(T, 'undetermined.jsonl');
    n = 0;
    fs.writeFileSync(jf3, line({ ev: 'queued', id: ids.a, hash: 'h', kind: null, cls: 'heavy', argv: ['x'] }) + '\n' + line({ ev: 'undetermined', id: ids.a, why: 'x' }) + '\n');
    ok('B\'27 an undetermined run: the start check refuses and names resolve --heavy', /undetermined/.test(HS.journalProblem(jf3) || '') && /resolve --heavy/.test(HS.journalProblem(jf3) || ''), HS.journalProblem(jf3));
  }

  // ---- B'9/B'30 through createAgent: prog with cfg.heavy gets the box of its own service, never an inherited one
  {
    const d = setup({ CODIS_HEAVY_BOX: '/inherited/box', CODIS_HEAVY_ANSWERS: '/inherited/answers', TMPDIR: path.join(T, 'rtmp') });
    fs.mkdirSync(path.join(T, 'rtmp'), { recursive: true });
    const home = path.join(d.root, 'chome');
    fs.mkdirSync(home);
    const seen = [];
    const mk = (heavy) => RX.createAgent({ host: 'codex', callsDir: path.join(d.root, 'calls'), pluginRoot: ROOT, log: () => {}, env: d.env,
      codex: { home, catalog: { models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: ['high'] }] } },
      tasks: { K: { dir: d.tdir, wt: d.wt, branch: 'task' } }, commit: { stateDir: d.state }, heavy,
      launch: async (plan) => { seen.push(plan); return { outcome: 'crashed', error: 'a test launcher' }; } });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await mk({ kinds: { tsc: 'medium' } })('task', { label: 'prog:K', schema, agentType: 'general-purpose' });
    await mk({ kinds: {} })('task', { label: 'review:K', schema, agentType: 'general-purpose' });
    await mk(undefined)('task', { label: 'prog:K', schema, agentType: 'general-purpose' });
    const [p1, r1, p0] = seen;
    ok('B\'9 createAgent: prog with cfg.heavy gets CODIS_HEAVY_BOX of its call folder and the answers of the adapter, not the inherited ones',
      !!p1 && p1.env.CODIS_HEAVY_BOX === path.join(p1.callDir, 'heavy') && p1.env.CODIS_HEAVY_ANSWERS === path.join(d.state, 'K', 'heavy-calls', path.basename(p1.callDir)), JSON.stringify(p1 && { b: p1.env.CODIS_HEAVY_BOX, a: p1.env.CODIS_HEAVY_ANSWERS }));
    ok('B\'5/B\'30 review: no heavy channel and no inherited box; prog without cfg.heavy: neither', !!r1 && !r1.env.CODIS_HEAVY_BOX && !r1.env.CODIS_HEAVY_ANSWERS && !!p0 && !p0.env.CODIS_HEAVY_BOX && !/heavy-req\.js/.test(p0.stdin),
      JSON.stringify([r1 && r1.env.CODIS_HEAVY_BOX, p0 && p0.env.CODIS_HEAVY_BOX]));
    ok('B\'30 createAgent: the prompt of prog with cfg.heavy ends with the heavy-req.js lines', !!p1 && /heavy-req\.js[^\n]*-- <argv>/.test(p1.stdin));
  }

  // ---- the conductor: slots.kinds reaches the adapter; the start check reads the heavy journal of the task
  {
    const CR = require(CHAIN);
    const shared = path.join(T, 'shared');
    const cfg = CR.adapterCfg('codex', { config: { sharedDir: shared, worktreeRoot: T, slots: { kinds: { tsc: 'medium' } } }, tasks: [] }, { codexHome: path.join(T, 'ch') }, path.join(T, 'calls'), () => {});
    ok('chain-run adapterCfg: codex gets cfg.heavy with the kinds of slots.kinds', !!cfg.heavy && cfg.heavy.kinds.tsc === 'medium', JSON.stringify(cfg.heavy));
    const hk = path.join(CR.commitStateDir({ sharedDir: shared }), 'K');
    fs.mkdirSync(hk, { recursive: true });
    fs.writeFileSync(path.join(hk, 'heavy.jsonl'), JSON.stringify({ v: 1, n: 1, ts: 'x', id: id32(), ev: 'undetermined', why: 'x' }) + '\n');
    ok('chain-run heavyJournalProblem: the heavy journal of the task in the commit state folder, an undetermined run refuses the start', /undetermined/.test(CR.heavyJournalProblem({ sharedDir: shared }, 'K') || ''), CR.heavyJournalProblem({ sharedDir: shared }, 'K'));
  }

  // ---- B'30: the host section; config slots.kinds
  {
    const t = { dir: '/x/task' };
    const on = RX.hostSection('prog', t, { heavy: true }), te = RX.hostSection('test', t, { heavy: true }), rv = RX.hostSection('review', t, { heavy: true });
    ok('B\'30 prog/test with the heavy channel: heavy-req.js -- <argv>, wait --id ... --max 25, cancel --id', [on, te].every((s) => /heavy-req\.js[^\n]*-- <argv>/.test(s) && /heavy-req\.js[^\n]*wait --id <id> --max 25/.test(s) && /heavy-req\.js[^\n]*cancel --id <id>/.test(s)), on);
    ok('B\'30 guard runs (guards-all.sh) refused until A2b-1c; browser and file-watcher guards named as the environment', /guard runs come with A2b-1c/.test(on) && /browser/.test(on) && /file watcher/.test(on) && !/needs the heavy channel \(A2b\)/.test(on), on);
    ok('B\'30 review: no heavy line', !/heavy-req/.test(rv), rv);
    const C = require(path.join(S, 'config.js'));
    const cfgDir = path.join(T, 'cfg');
    fs.mkdirSync(path.join(cfgDir, '.claude'), { recursive: true });
    const write = (kinds) => { const f = path.join(cfgDir, '.claude', 'codis-agents.json'); fs.writeFileSync(f, JSON.stringify({ repoDir: cfgDir, worktreeRoot: cfgDir, sharedDir: cfgDir, slots: { kinds } })); return f; };
    const good = C.load ? C.load(write({ tsc: 'medium', vite: 'heavy' })) : null;
    ok('config slots.kinds: {kind: medium|heavy} passes and is kept', !!good && !good.errors.length && good.config.slots.kinds.tsc === 'medium', JSON.stringify(good && good.errors));
    const bad = C.load(write({ tsc: 'light' }));
    ok('config slots.kinds: a class other than medium or heavy is an error', bad.errors.some((e) => /slots\.kinds\.tsc/.test(e)), JSON.stringify(bad.errors));
    const dflt = C.load(write(undefined));
    ok('config slots.kinds: {} by default (every kind heavy)', !!dflt && JSON.stringify(dflt.config.slots.kinds) === '{}', JSON.stringify(dflt && dflt.config.slots));
  }
  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
