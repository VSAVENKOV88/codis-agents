#!/usr/bin/env node
'use strict';
// Guard runs of a codex role through the heavy channel (p-codex-A2b-1c1, cells C1-1...C1-28, mechanism M-B + B-1): the
// role asks `heavy-req.js --kind full` or `--kind select --base <ref>`; the adapter (scripts/heavy-service.js) checks the
// request, starts `guards-all.sh --local ... <worktree>` outside the sandbox in a detached gate (no holder, no slot of
// its own) with CODIS_GUARDS_EXEC naming the executor spec; guards-all.sh takes its own heavy slot, and every command of
// the project (the runner in each mode, a single rerun) goes through scripts/heavy-exec.js into the executor. Here the
// executor is a fake codex (it records its calls and runs the command with CODEX_SANDBOX=fake): the plumbing, the
// queue, the stop and the recovery; the real sandbox is tests/heavy-guards-sandbox.test.js. A fixture project
// (tests/fixtures/heavy-guards/project.js) on a slot directory of the test, a fake machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

if (process.platform !== 'darwin') { skip('guard runs through the heavy channel', 'needs macOS (the box is read with O_NOFOLLOW_ANY)'); done(); }
const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const HS = require(path.join(S, 'heavy-service.js'));
const RX = require(path.join(S, 'role-exec.js'));
const CLIENT = path.join(S, 'heavy-req.js');
const HX = path.join(S, 'heavy-exec.js');
const GA = path.join(S, 'guards-all.sh');
const DRIVER = path.join(__dirname, 'fixtures', 'heavy-channel', 'adapter.js');
const { makeProject } = require('./fixtures/heavy-guards/project.js');

// Every knob of slots.zsh by name (tests/slots-hermetic.test.js checks the list), then the rest of the same families.
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'SLOT_KILL_GRACE', 'SLOT_EMPTY_WAIT', 'SLOT_EXEC_NOTE', 'GUARDS_EXCLUSIVE_HELD', 'CODIS_SLOT_HELD', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC', 'SLOT_OS', 'SLOT_POLL', 'SLOT_SAY', 'SLOT_THIRD_WINDOW', 'SLOT_HIST_GAP', 'CODIS_AGENTS_CONFIG']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(SLOT_|SLOTS_|GUARDS_|CODIS_)/.test(k)) delete process.env[k];

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-gr-')));
const kids = new Set();
process.on('exit', () => { for (const p of kids) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(T, { recursive: true, force: true }); });
const bin = path.join(T, 'bin');
fs.mkdirSync(bin);
const sh = (f, body) => { fs.writeFileSync(path.join(bin, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(bin, f), 0o755); };
sh('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
sh('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
sh('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
sh('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
// The fake codex: `codex sandbox <flags> -C <dir> -- <argv>` -> records "<pid> <argv>" in its log, runs argv in dir with
// CODEX_SANDBOX=fake (the real one is seatbelt) and the environment it was given.
const CODEX_LOG = path.join(T, 'codex-calls.txt');
sh('codex', `[[ $1 == --version ]] && { print -r -- "codex-cli 0.167.0"; exit 0 }\nwhile (( $# )) && [[ $1 != -- ]]; do [[ $1 == -C ]] && { cd -- $2 || exit 1; shift }; shift; done\nshift\nprint -r -- "$$ $*" >> ${JSON.stringify(CODEX_LOG)}\nexport CODEX_SANDBOX=fake\nexec "$@"`);
const codexCalls = () => { try { return fs.readFileSync(CODEX_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 30000) => { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const id32 = () => crypto.randomBytes(16).toString('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
let caseN = 0;

// One case: a fixture project, a task folder, a state folder, the box; SLOT_HEAVY_N=1.
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
const svcOpts = (d) => ({ task: 'K', callId: 'prog-1', role: 'prog', wt: d.wt, tdir: d.tdir, box: d.box, stateDir: d.state, config: d.P.cfg,
  codex: path.join(bin, 'codex'), userEnv: d.env, killGraceMs: 2000, emptyWaitMs: 2000, pollMs: 200 });
const open = (d, x) => HS.openHeavyService(Object.assign(svcOpts(d), { inject: { probe: async () => ({}) } }, x || {}));
const answersOf = (d) => path.join(d.state, 'K', 'heavy-calls', 'prog-1');
const answer = (d, id) => { try { return JSON.parse(fs.readFileSync(path.join(answersOf(d), `${id}.json`), 'utf8')); } catch { return null; } };
const FINAL = ['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused'];
const final = (d, id, ms) => until(() => { const a = answer(d, id); return a && FINAL.includes(a.state) ? a : null; }, ms);
const put = (d, id, body) => {
  fs.mkdirSync(d.box, { recursive: true });
  const tmp = path.join(d.box, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ id }, body)));
  fs.renameSync(tmp, path.join(d.box, `${id}.json`));
};
const journal = (d) => read(path.join(d.state, 'K', 'heavy.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const evs = (d, id) => journal(d).filter((e) => e.id === id).map((e) => e.ev);
const slotLines = (d) => read(path.join(d.slots, 'journal.tsv')).split('\n').filter(Boolean).map((l) => l.split('\t'));
// heavy-req.js as a child process: the service runs in this process, so nothing here may block its loop
const req = (d, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLIENT].concat(args), { cwd: d.wt, env: Object.assign({}, process.env, { CODIS_HEAVY_BOX: d.box, CODIS_HEAVY_ANSWERS: answersOf(d) }) });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.on('exit', (rc) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* below */ } resolve(Object.assign({ rcClient: rc }, j || {})); });
});
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// processes whose command line names the case's folder (ps outside any sandbox)
const procsOf = (dir) => String(spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout).split('\n').filter((l) => l.includes(dir) && !l.includes(' ps -axo'));
// guards-all.sh run directly (a role of Claude, or a run with a spec of the test)
const gaRun = (d, args, envx, timeout) => spawnSync('zsh', [GA].concat(args), { cwd: d.wt, encoding: 'utf8', timeout: timeout || 120000,
  env: Object.assign({}, d.env, { CODIS_AGENTS_CONFIG: d.P.cfg }, envx || {}) });
// an executor spec as the adapter writes it (fake codex): {bin, args, env}
const specFile = (d, envx) => {
  const f = path.join(d.root, 'exec.json');
  fs.writeFileSync(f, JSON.stringify({ bin: path.join(bin, 'codex'), args: ['sandbox', '-P', 'codis-heavy'],
    env: Object.assign({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: d.root, TMPDIR: d.tdir }, envx || {}) }));
  return f;
};

(async () => {
  // ---- C1-1, C1-9, C1-17, C1-23, C1-25, C1-26: a full run of the role, fixed {jobs}
  {
    const d = setup();
    const svc = open(d);
    const before = codexCalls().length;
    const a = await req(d, ['--kind', 'full', '--max', '120']);
    const shared = d.P.shared, OUT = path.join(shared, 'guards-wt.txt'), log = read(OUT);
    const id = a.id;
    const j = journal(d).filter((e) => e.id === id);
    const q = j.find((e) => e.ev === 'queued') || {}, run = j.find((e) => e.ev === 'running') || {};
    ok('C1-1 --kind full: done, rc 0 (the flaky guard green alone), journal queued -> running -> group-empty -> done',
      a.state === 'done' && a.rc === 0 && JSON.stringify(evs(d, id)) === JSON.stringify(['queued', 'running', 'group-empty', 'done']), JSON.stringify(a) + JSON.stringify(evs(d, id)));
    ok('C1-1 the gate runs guards-all.sh --local --quarantine-read-only <worktree> (argv of the adapter, kind full), no holder and no slot in the journal',
      q.kind === 'full' && JSON.stringify(q.argv) === JSON.stringify(['zsh', GA, '--local', '--quarantine-read-only', fs.realpathSync(d.wt)]) && Number.isInteger(run.pgid) && run.slot === undefined && !j.some((e) => e.ev === 'holding' || e.ev === 'acquired'),
      JSON.stringify(j));
    const runner = /RUNNER sb=(\S+) pg=(\d+) mark=(\S+) exec=(\S+) held=heavy (\S+)/.exec(log);
    ok('C1-1/C1-8 the runner ran in the executor (CODEX_SANDBOX of the fake codex), in the held heavy slot, its group under the exec marker of the slot',
      !!runner && runner[1] === 'fake' && runner[3] === 'yes' && /\/heavy\.\d+\.lock$/.test(runner[5]), log.slice(0, 600));
    ok('C1-23 CODIS_GUARDS_EXEC never reaches the executor', !!runner && runner[4] === 'none', log.slice(0, 600));
    const sl = slotLines(d).filter((l) => l[6] === 'full');
    ok('C1-1 one slot journal line of the run: heavy, kind full, label "guards-all wt codex K prog <id>"', sl.length === 1 && sl[0][4] === 'heavy' && sl[0][10] === `guards-all wt codex K prog ${id}`, JSON.stringify(slotLines(d)));
    const rr = read(path.join(shared, 'guards-wt.rerun.txt'));
    ok('C1-9 the single rerun of the new red went through the executor too (RUNNER sb=fake in the .rerun.txt), flaky', /RUNNER sb=fake/.test(rr) && /flaky, red under load, green alone: guards\/flaky\.g/.test(log), rr + log.slice(-800));
    ok('C1-9 the fake codex was called twice: the run and the rerun', codexCalls().length - before === 2, JSON.stringify(codexCalls()));
    ok('C1-17 the quarantine is not written; the log says why for a codex role', !fs.existsSync(path.join(shared, 'guards-quarantine.json')) && /quarantine read-only on a codex role's run/.test(log), log.slice(-800));
    ok('C1-18 the log names a local full run of a codex role (owner decision 2)', /^local full run: a codex role's run through the heavy channel/m.test(log), log.slice(-800));
    ok('C1-25 the answer: rc, log of the gate, guardsLog = the shared log, where = local full run, tail', a.guardsLog === OUT && a.where === 'local full run' && typeof a.log === 'string' && /guards log: /.test(read(a.log)) && typeof a.tail === 'string' && a.tail.length > 0, JSON.stringify(a));
    const meta = JSON.parse(read(`${OUT}.meta.json`) || '{}');
    ok('G40 the meta names the environment sandbox:codex', meta.env === 'sandbox:codex' && meta.rc === 0, JSON.stringify(meta));
    const rdir = path.join(d.state, 'K', 'heavy-runs', id);
    ok('C1-26 at the end: exec.json and the run\'s TMPDIR are removed, out.log stays', !fs.existsSync(path.join(rdir, 'exec.json')) && fs.existsSync(path.join(rdir, 'out.log')) && !fs.existsSync(path.join(d.tdir, 'heavy-tmp', 'prog-1', id)),
      JSON.stringify(fs.readdirSync(rdir)));
    // ---- C1-14, G40: the same HEAD, clean tree, same command, rc 0 -> reused without a slot and without codex
    const nLines = slotLines(d).length, nCalls = codexCalls().length;
    const b = await req(d, ['--kind', 'full', '--max', '60']);
    ok('C1-14 a second full run on the same HEAD: done rc 0, "reused", no slot line, no codex call', b.state === 'done' && b.rc === 0 && /reused, HEAD/.test(b.tail || '') && slotLines(d).length === nLines && codexCalls().length === nCalls,
      JSON.stringify(b) + JSON.stringify(slotLines(d).slice(nLines)));
    // a run of the host (no variable) on the same HEAD does not reuse the role's run; the role reuses the host's
    const h = gaRun(d, [d.wt]);
    ok('G40 the host does not reuse a run of the sandbox (environment changed) and runs itself', h.status === 0 && !/reused, HEAD/.test(h.stdout) && /RUNNER sb=none/.test(read(OUT)), h.stdout.slice(-600) + h.stderr.slice(-400));
    const nCalls2 = codexCalls().length;
    const c2 = await req(d, ['--kind', 'full', '--max', '60']);
    ok('G40 the role reuses the host\'s green run on the same HEAD', c2.state === 'done' && c2.rc === 0 && /reused, HEAD/.test(c2.tail || '') && codexCalls().length === nCalls2, JSON.stringify(c2));
    // ---- C1-24: the conductor's view
    const st = HS.status(d.state, 'K');
    const sr = st.runs.find((r) => r.id === id) || {};
    ok('C1-24 status --heavy: kind full, state done, pgid, log, no slot', sr.kind === 'full' && sr.state === 'done' && Number.isInteger(sr.pgid) && !!sr.log && sr.slot === undefined, JSON.stringify(sr));
    await svc.close();
  }

  // ---- C1-2, C1-15, C1-16: the selection
  {
    const d = setup();
    const svc = open(d);
    const n0 = slotLines(d).length, c0 = codexCalls().length;
    const e = await req(d, ['--kind', 'select', '--base', 'main', '--max', '60']);
    ok('C1-15 nothing selected: done rc 0, "nothing selected", no slot line, no codex', e.state === 'done' && e.rc === 0 && /nothing selected/.test(e.tail || '') && slotLines(d).length === n0 && codexCalls().length === c0, JSON.stringify(e));
    d.P.commit({ 'guards/a.g': 'exit 0 # changed\n' });
    const s = await req(d, ['--kind', 'select', '--base', 'main', '--max', '120']);
    const SEL = path.join(d.P.shared, 'guards-wt.select.txt');
    const sq = journal(d).find((x) => x.id === s.id && x.ev === 'queued') || {};
    ok('C1-2 --base main (a branch name): guards-all.sh --local --select main <worktree>, the changed guard only, through the executor', s.state === 'done' && s.rc === 0 && sq.base === 'main'
      && JSON.stringify(sq.argv) === JSON.stringify(['zsh', GA, '--local', '--select', 'main', fs.realpathSync(d.wt)]) && /RUNNER sb=fake/.test(read(SEL)) && /accounted 1, failed 0/.test(read(SEL)) && s.where === 'local selection' && s.guardsLog === SEL,
      JSON.stringify(s) + JSON.stringify(sq) + read(SEL).slice(0, 400));
    const s2 = await req(d, ['--kind', 'select', '--base', d.P.base, '--max', '120']);
    ok('C1-2 --base <full sha>: runs (reused or run, rc 0)', s2.state === 'done' && s2.rc === 0, JSON.stringify(s2));
    for (const [b, why] of [['--x', /needs base, a branch name or a commit/], ['-uweird', /needs base, a branch name or a commit/], ['a b', /needs base, a branch name or a commit/], ['nope-no-such', /unknown base/]]) {
      const id = id32();
      put(d, id, { kind: 'select', base: b, cwd: d.wt });
      const a = await final(d, id, 20000);
      ok(`C1-2 --base ${JSON.stringify(b)}: refused before the queue (${why})`, !!a && a.state === 'refused' && why.test(a.why || '') && !evs(d, id).includes('queued'), JSON.stringify(a));
    }
    // a base that is not an ancestor of HEAD: the selection runs from the merge-base (as for a role of Claude, G35)
    spawnSync('git', ['-C', d.P.repo, 'checkout', '-q', '-b', 'other', 'main']);
    fs.writeFileSync(path.join(d.P.repo, 'README'), 'other\n');
    spawnSync('git', ['-C', d.P.repo, 'commit', '-qam', 'other'], { env: Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });
    const s3 = await req(d, ['--kind', 'select', '--base', 'other', '--max', '120']);
    ok('C1-2 a base that is not an ancestor of HEAD: runs from the merge-base (the changed guard), rc 0', s3.state === 'done' && s3.rc === 0, JSON.stringify(s3) + read(SEL).slice(-300));
    await svc.close();
  }
  {
    // C1-16: the selection accounted for fewer guards than selected -> 69 environment
    const d = setup({ config: { guardSubsetCommand: 'cd {wt} && zsh runner.sh {jobs} -; print "accounted 0, failed 0" # {onlyArgs}' } });
    // the runner runs every guard, then a later tally line of 0 decides the count
    const svc = open(d);
    d.P.commit({ 'guards/a.g': 'exit 0 # changed\n' });
    const s = await req(d, ['--kind', 'select', '--base', 'main', '--max', '120']);
    ok('C1-16 a selection that accounted for 0 of 1: rc 69 "environment: ... accounted for 0 of 1", meta 69', s.state === 'done' && s.rc === 69 && /accounted for 0 of 1 selected guards/.test(read(path.join(d.P.shared, 'guards-wt.select.txt')))
      && JSON.parse(read(path.join(d.P.shared, 'guards-wt.select.txt.meta.json')) || '{}').rc === 69, JSON.stringify(s));
    await svc.close();
  }

  // ---- C1-3, C1-4, C1-5: refusals before the queue
  {
    const d = setup();
    const svc = open(d);
    const cases = [
      [{ kind: 'full', argv: ['true'] }, /argv/],
      [{ kind: 'select', argv: ['true'], base: 'main' }, /argv/],
      [{ kind: 'select' }, /base/],
      [{ kind: 'full', base: 'main' }, /base/],
      [{ argv: ['true'], base: 'main' }, /base/],
      [{ kind: 'tsc' }, /argv/],
      [{ kind: 'full', extra: 1 }, /fields other than/],
    ];
    for (const [body, why] of cases) {
      const id = id32();
      put(d, id, Object.assign({ cwd: d.wt }, body));
      const a = await final(d, id, 20000);
      ok(`C1-3 ${JSON.stringify(body)}: refused (${why})`, !!a && a.state === 'refused' && why.test(a.why || '') && !evs(d, id).includes('queued'), JSON.stringify(a));
    }
    const g = id32();
    put(d, g, { argv: ['zsh', '/anywhere/scripts/guards-all.sh', d.wt], cwd: d.wt });
    const ga = await final(d, g, 20000);
    ok('C1-5 argv with guards-all.sh: refused with the hint of the guard-run kinds', !!ga && ga.state === 'refused' && /environment: guards-all\.sh runs through the channel: heavy-req\.js --kind select --base <ref> \| --kind full/.test(ga.why || '') && !/A2b-1c/.test(ga.why || ''), JSON.stringify(ga));
    fs.appendFileSync(path.join(d.wt, 'README'), 'dirty\n');
    const dirty = await req(d, ['--kind', 'full', '--max', '20']);
    ok('C1-4 tracked changes: refused "commit first" before the queue', dirty.state === 'refused' && /commit first/.test(dirty.why || '') && !evs(d, dirty.id).includes('queued'), JSON.stringify(dirty));
    await svc.close();
  }

  // ---- C1-7: the run's config, not the worktree's
  {
    const d = setup();
    fs.mkdirSync(path.join(d.wt, '.claude'));
    fs.writeFileSync(path.join(d.wt, '.claude', 'codis-agents.json'), JSON.stringify(Object.assign({}, d.P.config, { guardCommand: 'cd {wt} && print "WRONG CONFIG" && exit 3' })));
    d.P.commit({ '.claude/codis-agents.json': read(path.join(d.wt, '.claude', 'codis-agents.json')) });
    const svc = open(d);
    const a = await req(d, ['--kind', 'full', '--max', '120']);
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok('C1-7 the command comes from the run\'s config (CODIS_AGENTS_CONFIG), not from the worktree\'s', a.state === 'done' && a.rc === 0 && /RUNNER sb=fake/.test(log) && !/WRONG CONFIG/.test(log), JSON.stringify(a) + log.slice(0, 300));
    await svc.close();
  }

  // ---- C1-19: a stubborn runner (TERM ignored) x cancel by the role
  {
    const d = setup({ guards: { 'a.g': 'exit 0', 'stub.g': `trap '' TERM; print STUB-STARTED; while :; do sleep 0.2; done` } });
    const svc = open(d);
    const a = await req(d, ['--kind', 'full', '--max', '1']);
    const OUT = path.join(d.P.shared, 'guards-wt.txt');
    const started = await until(() => /STUB-STARTED/.test(read(OUT)), 60000);
    const t0 = Date.now();
    const c = await req(d, ['cancel', '--id', a.id, '--max', '60']);
    const g = (journal(d).find((e) => e.id === a.id && e.ev === 'running') || {}).pgid;
    const last = slotLines(d).filter((l) => l[6] === 'full').pop() || [];
    ok('C1-19 a cancel during the run: stopped after the group is gone; the slot journal line of the run is written (rc 143)', !!started && c.state === 'stopped' && /cancelled by the role/.test(c.why || '') && Number.isInteger(g) && !groupAlive(g) && last[8] === '143',
      JSON.stringify(c) + JSON.stringify(last));
    const left = await until(() => procsOf(d.root).length === 0, 10000);
    ok('C1-19 no process of the run is left (the runner killed by the holder after its grace)', !!left, procsOf(d.root).join('\n'));
    ok('C1-19 the stop waited for the holder (TERM, its grace and KILL) and no longer than the service\'s pause', Date.now() - t0 < 30000, `${Date.now() - t0} ms`);
    await svc.close();
  }

  // ---- C1-13, C1-20: the budget held by a neighbouring full run; a second request; a cancel while waiting
  {
    const d = setup(undefined, { SLOT_HEAVY_N: '2' });
    // the neighbour: a heavy job whose slot carries a full run's budget of 6 (as slot_guard_plan writes it)
    const nb = spawn('zsh', [path.join(S, 'heavy.sh'), 'sleep', '60'], { cwd: d.root, env: d.env, detached: true, stdio: 'ignore' });
    kids.add(nb.pid);
    const held = await until(() => fs.readdirSync(d.slots).find((f) => /^heavy\.\d+\.lock$/.test(f) && fs.existsSync(path.join(d.slots, `${f}.who`))), 20000);
    if (held) fs.writeFileSync(path.join(d.slots, `${held}.jobs`), 'fixed 6\n');
    const svc = open(d);
    const a = await req(d, ['--kind', 'full', '--max', '1']);
    const w = await until(() => { const x = answer(d, a.id); return x && /^waiting for (workers|slot)/.test(x.why || '') ? x : null; }, 30000);
    ok('C1-13 the budget is held by a neighbour: the run waits outside the slot, state running, why = the waiting line of its log', !!w && w.state === 'running', JSON.stringify(answer(d, a.id)));
    const b = await req(d, ['--kind', 'full', '--max', '2']);
    ok('C1-20 a second request during the run waits behind it (one run at a time), no second guards-all.sh', b.state === 'queued' && new RegExp(`behind run ${a.id}`).test(b.why || '') && procsOf(d.wt).filter((l) => /guards-all\.sh/.test(l)).length <= 2,
      JSON.stringify(b) + procsOf(d.wt).join('\n'));
    const c = await req(d, ['cancel', '--id', a.id, '--max', '60']);
    ok('C1-20 a cancel while it waits: stopped', c.state === 'stopped', JSON.stringify(c));
    const cb = await req(d, ['cancel', '--id', b.id, '--max', '60']);
    ok('C1-20 the second, cancelled before or after its start, is final; no process of either run is left', FINAL.includes(cb.state) && !!(await until(() => procsOf(d.wt).length === 0, 10000)), JSON.stringify(cb) + procsOf(d.wt).join('\n'));
    try { process.kill(-nb.pid, 'SIGTERM'); } catch { /* gone */ }
    await svc.close();
  }

  // ---- C1-21: kill -9 of the adapter during a run; resolve stop; the next adapter removes exec.json
  {
    const d = setup({ guards: { 'stub.g': `print STUB-STARTED; sleep 60` } });
    const drv = spawn(process.execPath, [DRIVER, JSON.stringify(Object.assign(svcOpts(d), { executorArgv: ['true'] }))], { env: d.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(drv.pid);
    await until(() => fs.existsSync(path.join(d.state, 'K', 'heavy.lock')), 20000);
    const id = id32();
    put(d, id, { kind: 'full', cwd: d.wt });
    const OUT = path.join(d.P.shared, 'guards-wt.txt');
    await until(() => /STUB-STARTED/.test(read(OUT)), 60000);
    process.kill(drv.pid, 'SIGKILL');
    await sleep(500);
    const st = HS.status(d.state, 'K').runs.find((r) => r.id === id) || {};
    ok('C1-21 kill -9 of the adapter: the run is "running without adapter", its group lives', st.state === 'running without adapter' && groupAlive(st.pgid), JSON.stringify(st));
    ok('C1-21 the exec.json of the run is still there while the group lives', fs.existsSync(path.join(d.state, 'K', 'heavy-runs', id, 'exec.json')));
    const r = await HS.resolveStop(d.state, 'K', id, { graceMs: 6000, waitMs: 2000 });
    ok('C1-21 resolve --heavy stop: TERM to the group, stopped, the group gone, no process left', r.ok && r.state === 'stopped' && !groupAlive(st.pgid) && !!(await until(() => procsOf(d.root).length === 0, 10000)), JSON.stringify(r) + procsOf(d.root).join('\n'));
    const svc = open(d);
    await sleep(300);
    ok('C1-21 the next adapter removes the exec.json of a final run', !fs.existsSync(path.join(d.state, 'K', 'heavy-runs', id, 'exec.json')));
    await svc.close();
  }

  // ---- C1-21, C1-19: resolve stop with its default pauses (no graceMs/waitMs): a guard run gets TERM and both pauses
  // of its holder (KILL_GRACE_MS + EMPTY_WAIT_MS, 60 s) before KILL, so the holder's own KILL of the runner and its slot
  // journal line (rc 143) come first; any other kind gets KILL_GRACE_MS. A virtual clock (setTimeout and Date.now of
  // this process, only during the call) measures the pause without waiting it; the stubborn group is real.
  for (const [kind, want] of [['full', HS.KILL_GRACE_MS + HS.EMPTY_WAIT_MS], ['select', HS.KILL_GRACE_MS + HS.EMPTY_WAIT_MS], ['heavy', HS.KILL_GRACE_MS]]) {
    const state = fs.mkdtempSync(path.join(T, 'grace-'));
    const g = spawn('zsh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    kids.add(g.pid);
    const lst = await until(() => { const p = spawnSync('ps', ['-o', 'lstart=', '-p', String(g.pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }); return String(p.stdout).trim() || null; }, 10000);
    const id = id32();
    fs.mkdirSync(path.join(state, 'K'), { recursive: true });
    fs.writeFileSync(path.join(state, 'K', 'heavy.jsonl'), JSON.stringify({ v: 1, n: 1, ev: 'running', id, kind, pgid: g.pid, lstart: lst }) + '\n');
    await sleep(300);
    const real = { st: global.setTimeout, now: Date.now, kill: process.kill };
    const t0 = Date.now();
    let vt = t0;
    const sig = [];
    global.setTimeout = (fn, ms) => { vt += Math.max(0, Number(ms) || 0); return real.st(fn, Math.min(Number(ms) || 0, 5)); };
    Date.now = () => vt;
    process.kill = function (pid, s) { if (pid === -g.pid && s && s !== 0) sig.push([s, vt - t0]); return real.kill.apply(process, arguments); };
    let r;
    try { r = await HS.resolveStop(state, 'K', id); } finally { global.setTimeout = real.st; Date.now = real.now; process.kill = real.kill; }
    const kill = sig.find((x) => x[0] === 'SIGKILL');
    ok(`C1-21 resolve stop of a ${kind} run with the default pauses: TERM at once, KILL after ${want / 1000} s, stopped`,
      !!r && r.ok && r.state === 'stopped' && !!sig[0] && sig[0][0] === 'SIGTERM' && sig[0][1] < 1000 && !!kill && kill[1] >= want && kill[1] < want + 1000,
      JSON.stringify(r) + ' ' + JSON.stringify(sig));
    try { process.kill(-g.pid, 'SIGKILL'); } catch { /* gone */ }
  }

  // ---- C1-6: guards-all.sh inside a held slot (CODIS_SLOT_HELD) refuses 64 at once, never the endless 75
  {
    const d = setup();
    const t0 = Date.now();
    const r = gaRun(d, [d.wt], { CODIS_SLOT_HELD: `heavy ${path.join(d.slots, 'heavy.1.lock')}` }, 20000);
    ok('C1-6 guards-all.sh with CODIS_SLOT_HELD: 64 at once with the reason', r.status === 64 && /inside a held slot/.test(r.stderr) && Date.now() - t0 < 15000, `${r.status} ${r.signal} ${r.stderr.slice(-300)}`);
  }

  // ---- C1-8 (adaptive, whole), C1-18: guards-all.sh with a spec of the test; the machine file names a remote runner
  for (const mode of ['adaptive', 'whole']) {
    const d = setup({ mode, config: { remoteRun: { command: 'cd {wt} && print REMOTE' } } });
    const machine = path.join(d.root, 'machine.json');
    fs.writeFileSync(machine, JSON.stringify({ slots: { lockDir: d.slots }, remote: { host: 'runner.invalid', user: 'u', key: '/k', knownHosts: '/kh', root: '/r' } }));
    const r = gaRun(d, [d.wt], { CODIS_GUARDS_EXEC: specFile(d), CODIS_AGENTS_MACHINE: machine });
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok(`C1-8 ${mode}: the runner goes through heavy-exec.js (CODEX_SANDBOX=fake)${mode === 'adaptive' ? ', {limitFile} readable' : ''}`, r.status === 0 && /RUNNER sb=fake/.test(log) && (mode !== 'adaptive' || /^LIMIT=\d/m.test(log)), r.stdout.slice(-500) + r.stderr.slice(-300) + log.slice(0, 300));
    ok(`C1-18 ${mode}: with CODIS_GUARDS_EXEC and a remote runner in the machine file the run stays local, the log says so`, !/REMOTE/.test(log) && /^local full run: /m.test(log) && /guards log: /.test(r.stdout), r.stdout.slice(-400));
  }
  {
    // without the variable guards-all.sh is as before: no wrapper, no "local full run" line, no "guards log:" line (C1-28)
    const d = setup();
    const r = gaRun(d, [d.wt]);
    const log = read(path.join(d.P.shared, 'guards-wt.txt'));
    ok('C1-28 guards-all.sh without CODIS_GUARDS_EXEC: the runner outside any executor, no channel lines', r.status === 0 && /RUNNER sb=none/.test(log) && !/local full run/.test(log) && !/guards log: /.test(r.stdout) && !JSON.parse(read(path.join(d.P.shared, 'guards-wt.txt.meta.json'))).env,
      r.stdout.slice(-400) + r.stderr.slice(-300));
  }

  // ---- C1-10, C1-11: heavy-exec.js itself
  {
    const d = setup();
    const slot = path.join(d.slots, 'heavy.1.lock');
    const hx = (args, envx) => spawnSync(process.execPath, [HX].concat(args), { cwd: d.wt, encoding: 'utf8', timeout: 30000, env: Object.assign({}, d.env, envx || {}) });
    const lock = path.join(d.slots, 'excl-new.lock');
    const good = specFile(d);
    const r1 = hx([good, '--', 'zsh', '-c', 'print -r -- "IN sb=$CODEX_SANDBOX held=$CODIS_SLOT_HELD dir=$SLOTS_DIR lock=$GUARDS_EXCLUSIVE_LOCK x=${XLEAK:-none}"'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: lock, XLEAK: 'leak' });
    ok('C1-11 heavy-exec.js: CODIS_SLOT_HELD, SLOTS_DIR, GUARDS_EXCLUSIVE_LOCK from the slot; nothing else of its own environment; the lock file created',
      r1.status === 0 && r1.stdout.includes(`IN sb=fake held=heavy ${slot} dir=${d.slots} lock=${lock} x=none`) && fs.existsSync(lock), r1.stdout + r1.stderr);
    fs.writeFileSync(lock, 'keep');
    hx([good, '--', 'true'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: lock });
    ok('C1-11 an existing lock file is never truncated', read(lock) === 'keep');
    const bad = [
      ['a missing spec', [path.join(d.root, 'nope.json'), '--', 'true'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: lock }],
      ['a spec that is not JSON', [(() => { const f = path.join(d.root, 'bad.json'); fs.writeFileSync(f, '{'); return f; })(), '--', 'true'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: lock }],
      ['no SLOT_PATH', [good, '--', 'true'], { GUARDS_EXCLUSIVE_LOCK: lock }],
      ['codex not found', [(() => { const f = path.join(d.root, 'nocodex.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(JSON.parse(read(good)), { bin: path.join(d.root, 'no-codex') }))); return f; })(), '--', 'true'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: lock }],
      ['a lock file that cannot be created', [good, '--', 'true'], { SLOT_PATH: slot, GUARDS_EXCLUSIVE_LOCK: path.join(d.root, 'no-dir', 'x.lock') }],
    ];
    for (const [name, args, envx] of bad) {
      const c = codexCalls().length;
      const r = hx(args, envx);
      ok(`C1-10 heavy-exec.js with ${name}: 69 "environment: ...", the command never runs`, r.status === 69 && /^environment: /m.test(r.stderr) && codexCalls().length === c, `${r.status} ${r.stderr}`);
    }
    // the single rerun with a spec gone: the environment, never flaky and never a repeated red
    const GR = require(path.join(S, 'guards-result.js'));
    const logf = path.join(d.root, 'run.txt');
    fs.writeFileSync(logf, 'FAIL guards/flaky.g\naccounted 2, failed 1\n');
    const save = process.env.CODIS_GUARDS_EXEC, saveSp = process.env.SLOT_PATH;
    process.env.CODIS_GUARDS_EXEC = path.join(d.root, 'gone.json'); process.env.SLOT_PATH = slot;
    let res;
    try { res = GR.rerun({ wt: d.wt, log: logf, rc: 1, cfg: d.P.config.guardRerun, baseline: '', quarantine: '', readOnly: true }); } finally {
      if (save === undefined) delete process.env.CODIS_GUARDS_EXEC; else process.env.CODIS_GUARDS_EXEC = save;
      if (saveSp === undefined) delete process.env.SLOT_PATH; else process.env.SLOT_PATH = saveSp;
    }
    ok('C1-10 a single rerun whose executor cannot start: 69, the environment, neither flaky nor a new red', res.rc === 69 && !res.flaky.length && !res.repeated.length && /environment: /.test(res.text), JSON.stringify(res));
  }

  // ---- C1-22: the host section
  {
    const t = { dir: '/x/task' };
    const on = RX.hostSection('prog', t, { heavy: true }), te = RX.hostSection('test', t, { heavy: true }), rv = RX.hostSection('review', t, { heavy: true });
    ok('C1-22 prog/test: --kind full and --kind select --base <ref> replace guards-all.sh, rc, guardsLog, where; no "guard runs come with A2b-1c"',
      [on, te].every((s) => /heavy-req\.js --kind full/.test(s) && /heavy-req\.js --kind select --base <ref>/.test(s) && /guards-all\.sh/.test(s) && /guardsLog/.test(s) && /where/.test(s) && !/come with A2b-1c/.test(s)), on);
    ok('C1-22 review: no heavy line', !/heavy-req/.test(rv), rv);
  }

  // ---- C1-27: the kinds of the guard runs are reserved
  {
    const C = require(path.join(S, 'config.js'));
    const dir = path.join(T, 'kcfg');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const f = path.join(dir, '.claude', 'codis-agents.json');
    for (const k of ['select', 'full']) {
      fs.writeFileSync(f, JSON.stringify({ repoDir: dir, worktreeRoot: dir, sharedDir: dir, slots: { kinds: { [k]: 'heavy' } } }));
      const r = C.load(f);
      ok(`C1-27 slots.kinds.${k}: an error (a reserved kind of the heavy channel)`, r.errors.some((e) => new RegExp(`slots\\.kinds\\.${k}: .*reserved`).test(e)), JSON.stringify(r.errors));
    }
  }

  // ---- the tester cells: tests/heavy-guards-tester-cases.js (TG1-TG8: a new red alone, a gone spec in guards-all.sh,
  // the end of the call and a signal, a cancel during the rerun, recovery after kill -9, an inherited variable, a flaky
  // selection, the client's refusals), a child with its own tally, so README keeps counting test files
  {
    const tc = spawnSync(process.execPath, [path.join(__dirname, 'heavy-guards-tester-cases.js')], { encoding: 'utf8', timeout: 280000 });
    ok('the tester cells of the guard runs (tests/heavy-guards-tester-cases.js) pass', tc.status === 0, `exit ${tc.status} ${tc.signal || ''}\n${String(tc.stdout).split('\n').filter((l) => /FAIL/.test(l)).join('\n').slice(0, 3000)}${String(tc.stderr).slice(-800)}`);
  }
  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
