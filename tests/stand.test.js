#!/usr/bin/env node
'use strict';
// The shared stand of a project and its ticket (scripts/stand.sh), on fake project commands - no Docker: the stand's
// "up" is a file, reset/deploy append to a log. Cells B1-B11 of the dev-stand analysis:
//  B1 a free ticket is given at once, the holder is a live background process, status names pid, worktree and time;
//  B2/B3 waiters queue by ticket and say "position N in queue" at least every SLOT_SAY; the next one gets it on release;
//  B4 release by the holder: the project's reset runs while the ticket is still held, then it is free; a journal line;
//  B5 kill -9 of the holder frees the ticket; the ticket of a dead waiter does not block the queue;
//  B6 role-leftovers-check finds the holder (cwd in the worktree) and the ticket it holds, --fix frees it;
//  B7 deploy/reset/release from another worktree are refused ("the ticket is held by <wt>");
//  B8 the next holder after a dead one gets a reset before the ticket; B9 a stand that is not up: take refuses;
//  B10 the stand takes no memory slot, deploy runs in a medium slot; stand tickets are not "the other queue" of slots;
//  B11 an invalid config: stand and slot commands refuse with its text, and nothing falls back to ~/.cache.
// Plus: release --force, a failing reset at issue, image-diff, and the class stand in the slot-journal summary.
// cwd: the project's commands (up, status, down, reset, deploy) run in stand.cwd when it is set (owner 2026-10-21),
// in repoDir without it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const S = path.join(ROOT, 'scripts');
const CASES = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'force', 'reset fails', 'image-diff', 'cwd', 'journal'];
if (!has('zsh')) { for (const c of CASES) skip(c, 'zsh not found'); done(); }

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stand-test-')));
const SL = path.join(T, 'slots'), LOG = path.join(T, 'log'), J = path.join(SL, 'journal.tsv');
const wt = (n) => { const d = path.join(T, 'wts', n); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const [A, B, C, D, E] = ['wa', 'wb', 'wc', 'wd', 'we'].map(wt);
fs.mkdirSync(path.join(T, 'main'), { recursive: true });
fs.mkdirSync(path.join(T, 'home'), { recursive: true });
// The reset logs whether the ticket is held while it runs (it must be: nobody else may take a stand being reset).
const held = `zsh -c 'zmodload zsh/system; zsystem flock -t 0 -f f ${SL}/stand.lock 2>/dev/null && print -r -- free || print -r -- held'`;
const STAND = {
  project: 'stand-test', ports: [39999],
  up: `touch ${T}/up`, down: `rm -f ${T}/up`, status: `test -e ${T}/up && print -r -- "stand {project} up"`,
  deploy: `print -r -- deploy $(basename {wt}) {project} >> ${LOG}`,   // values come shell-quoted: never inside "..."
  reset: `[[ ! -e ${T}/reset-fail ]] || exit 3; print -r -- "reset $(${held})" >> ${LOG}`,
  imageFiles: ['server/Dockerfile*', 'docker-compose*.yml'], memLimitMB: 3072,
};
const cfgOf = (stand, extra = {}) => Object.assign({ repoDir: path.join(T, 'main'), worktreeRoot: path.join(T, 'wts'), sharedDir: path.join(T, 'shared'), slots: { lockDir: SL } }, stand ? { stand } : {}, extra);
const CFG = path.join(T, 'cfg.json');
fs.writeFileSync(CFG, JSON.stringify(cfgOf(STAND)));
// Fake machine for the medium slot of deploy (free 20 %, plenty of swap): the slot must not wait on the real box
// (Linux has no sysctl vm.swapusage - "swap: capacity 0 MB").
const BIN = path.join(T, 'bin');
fs.mkdirSync(BIN);
const fake = (f, body) => { fs.writeFileSync(path.join(BIN, f), '#!/bin/zsh\n' + body + '\n'); fs.chmodSync(path.join(BIN, f), 0o755); };
fake('sysctl', '[[ $1 == -n && $2 == vm.swapusage ]] || exec /usr/sbin/sysctl "$@"\nprint -r -- "total = 30000,00M  used = 1000,00M  free = 20000,00M  (encrypted)"');
fake('memory_pressure', 'print -r -- "System-wide memory free percentage: 20%"');
fake('vm_stat', 'print -r -- "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\nprint -r -- "Swapouts:                                   0."');
fake('df', 'print -r -- "Filesystem 1M-blocks Used Available Capacity Mounted"\nprint -r -- "/dev/disk3s6 100000 0 0 0% /System/Volumes/VM"');
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: CFG, HOME: path.join(T, 'home'), PATH: BIN + path.delimiter + process.env.PATH, SLOT_OS: 'darwin', SLOT_POLL: '0.2', SLOT_SAY: '1', SLOT_THIRD_WINDOW: '1', SLOT_HIST_GAP: '2' });
// run inside an outer slot, the outer slots.zsh has exported its own lock, journal and counts; thresholds set outside
// (SLOT_SWAP_MIN_MB=0 on Linux) are dropped too
for (const k of ['SLOTS_DIR', 'SLOT_JOURNAL', 'SLOT_LEGACY_LOCK', 'CLAUDE_PROJECT_DIR', 'GUARDS_EXCLUSIVE_LOCK', 'SLOT_MEDIUM_N', 'SLOT_HEAVY_N', 'SLOT_TOTAL_MAX', 'GUARDS_JOBS_ALONE', 'GUARDS_JOBS_SHARED', 'SLOT_EXCL_TOOLS', 'GUARDS_EXCL_GLOB', 'GUARDS_EXCL_MARKER', 'SLOT_PATH',
  'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_SWAP_MIN_MB', 'SLOT_THIRD_FREE_PCT', 'SLOT_THIRD_SWAP_GROW_MB', 'SLOT_PROC']) delete env[k];

const procs = [];
function take(dir, args = [], e = {}) {
  const p = spawn('zsh', [path.join(S, 'stand.sh'), 'take', ...args], { cwd: dir, env: Object.assign({}, env, e) });
  p.out = ''; p.exited = null;
  p.stdout.on('data', (d) => { p.out += d; }); p.stderr.on('data', (d) => { p.out += d; });
  p.on('exit', (c, s) => { p.exited = { c, s }; });
  procs.push(p);
  return p;
}
const st = (args, cwd, e = {}) => spawnSync('zsh', [path.join(S, 'stand.sh'), ...args], { cwd, env: Object.assign({}, env, e), encoding: 'utf8', timeout: 60000 });
const outOf = (r) => (r.stdout || '') + (r.stderr || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f, ms = 15000) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (f()) return true; return f(); }
const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const journal = () => (fs.existsSync(J) ? fs.readFileSync(J, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : []);
const standLines = () => journal().filter((f) => f[4] === 'stand');
const taken = (p) => /ticket taken by /.test(p.out);
const tickets = () => (fs.existsSync(path.join(SL, 'queue')) ? fs.readdirSync(path.join(SL, 'queue')).filter((f) => /^\d+$/.test(f)).map((f) => fs.readFileSync(path.join(SL, 'queue', f), 'utf8').trim()) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  try {
    // B9: the stand is not up -> take refuses and holds nothing.
    let r = st(['take'], A);
    ok('B9 stand not up: take refuses (exit 69) with the reason', r.status === 69 && /stand-test is not up/.test(outOf(r)), `${r.status} ${outOf(r)}`);
    ok('B9 ... and holds nothing: no holder file, no ticket in the queue', !fs.existsSync(path.join(SL, 'stand.lock.who')) && !tickets().some((t) => t.startsWith('stand ')), tickets().join('|'));
    r = st(['up'], A);
    ok('up runs the project command', r.status === 0 && fs.existsSync(path.join(T, 'up')), outOf(r));
    r = st(['status'], B);
    ok('status: stand up, ticket free', r.status === 0 && /stand-test: up/.test(outOf(r)) && /ticket: free/.test(outOf(r)), outOf(r));

    // B1: a free ticket at once; reset before it is given (B8/D2); status names pid, worktree, time.
    const pa = take(A);
    ok('B1 a free ticket is given at once', await waitFor(() => taken(pa), 10000), pa.out);
    ok('B1 ... after a reset run while it was already held (reset at issue)', log().join() === 'reset held', log().join('|'));
    ok('B1 the holder is a live process', pa.exited === null && alive(pa.pid));
    r = st(['status'], B);
    ok('B1 status: held by the worktree, pid and since when', new RegExp(`ticket: held by ${A} \\(pid ${pa.pid}\\) since \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d, \\d+ s`).test(outOf(r)), outOf(r));
    r = st(['take'], A);
    ok('take again from the holder\'s worktree: says so, exit 0, no second holder', r.status === 0 && /already holds/.test(outOf(r)), outOf(r));

    // B2/B3: two waiters queue by ticket.
    // The earlier waiter polls slowly, the later one fast: only the queue makes the earlier one win.
    const pb = take(B, [], { SLOT_POLL: '1.5' }); await sleep(700); const pc = take(C, [], { SLOT_POLL: '0.05' });
    ok('B2 the second waits and tells its place: "position 1 in queue"', await waitFor(() => /waiting for the stand ticket stand-test, position 1 in queue \(\d+ s\): held by /.test(pb.out)), pb.out);
    ok('B3 the third: "position 2 in queue"', await waitFor(() => /waiting for the stand ticket stand-test, position 2 in queue/.test(pc.out)), pc.out);
    await sleep(2300);
    ok('B2 the waiting line repeats at least every SLOT_SAY (1 s here)', (pb.out.match(/waiting for the stand ticket/g) || []).length >= 2, pb.out);
    ok('B2 while A holds nobody else gets it', !taken(pb) && !taken(pc));
    r = st(['status'], A);
    ok('status lists the queue in order', new RegExp(`2 waiting: 1\\. ${B} .*\\n.*2\\. ${C}`).test(outOf(r)), outOf(r));

    // B7: a foreign worktree may not deploy, reset or release.
    const before = log().length;
    for (const [args, name] of [[['deploy', B], 'deploy'], [['reset'], 'reset'], [['release'], 'release']]) {
      r = st(args, B);
      ok(`B7 ${name} from another worktree is refused: "the ticket is held by <wt>"`, r.status === 77 && outOf(r).includes(`the ticket is held by ${A}`), `${r.status} ${outOf(r)}`);
    }
    r = st(['deploy', B], A);
    ok('B7 deploy of another worktree, called from the holder\'s, is refused', r.status === 77 && outOf(r).includes(`the ticket is held by ${A}`), outOf(r));
    r = st(['release', '--wt', B], A);
    ok('B7 release --wt <another worktree> is refused', r.status === 77, outOf(r));
    ok('B7 ... and the stand was not touched', log().length === before, log().join('|'));

    // B10: deploy of the holder runs in a medium slot.
    r = st(['deploy'], A);
    ok('deploy by the holder runs the project command with its worktree', r.status === 0 && log().slice(-1)[0] === `deploy ${path.basename(A)} stand-test`, outOf(r) + log().join('|'));
    ok('B10 deploy went through a medium slot (journal line class medium)', journal().some((f) => f[4] === 'medium' && /stand deploy/.test(f[10])), journal().map((f) => f.join(' ')).join('\n'));
    ok('B10 the held stand takes no memory slot (no medium/heavy lock is busy)', (() => {
      const z = spawnSync('zsh', ['-c', `source ${S}/slots.zsh; for f in $SLOTS_DIR/(medium|heavy).*.lock(N); do _slot_busy $f && print busy $f; done; true`], { env, encoding: 'utf8' });
      return z.status === 0 && !/busy/.test(z.stdout);
    })());

    // B4: release by the holder - reset while held, then free; the next waiter gets it.
    const relAt = Date.now() / 1000;
    r = st(['release'], A);
    ok('B4 release by the holder: exit 0', r.status === 0 && /released/.test(outOf(r)), outOf(r));
    ok('B4 the project\'s reset ran while the ticket was still held', log().slice(-1)[0] === 'reset held', log().join('|'));
    ok('B4 the holder has exited when release returns', await waitFor(() => pa.exited !== null, 3000), String(pa.exited));
    ok('B2 the first waiter gets the ticket after the release', await waitFor(() => taken(pb)), pb.out);
    ok('B3 ... the third still waits, now first in the queue', !taken(pc) && await waitFor(() => /position 1 in queue/.test(pc.out.split('ticket taken').pop())), pc.out);
    const la = standLines().find((f) => f[9] === A);
    ok('B4 journal v1 line for A: class stand, kind release, rc 0, its worktree, request <= acquire <= release', la && la[0] === 'v1' && la[6] === 'release' && la[8] === '0' && +la[1] <= +la[2] && +la[2] <= +la[3] && +la[3] >= relAt - 1 && la[7] === String(pa.pid), la && la.join(' '));

    // B5 + B8: kill -9 of the holder frees the ticket; the next one gets a reset first.
    const resetsBefore = log().filter((l) => l.startsWith('reset')).length;
    process.kill(pb.pid, 'SIGKILL');
    ok('B5 kill -9 of the holder: the next waiter gets the ticket', await waitFor(() => taken(pc)), pc.out);
    ok('B8 ... after a reset (nothing of the dead holder is left)', log().filter((l) => l.startsWith('reset')).length === resetsBefore + 1, log().join('|'));
    const lb = standLines().find((f) => f[9] === B);
    ok('B5 the dead holder gets a journal line (kind dead, its pid and worktree)', lb && lb[6] === 'dead' && lb[7] === String(pb.pid), lb && lb.join(' '));

    // B5: a dead waiter does not block the queue.
    const pd = take(D);
    await waitFor(() => /position 1 in queue/.test(pd.out));
    process.kill(pd.pid, 'SIGKILL');
    await sleep(300);
    // Started from outside its worktree with a relative --wt: only the holder's cwd ties it to the worktree.
    const pe = take(T, ['--wt', path.relative(T, E)]);
    ok('B5 a waiter after a dead one is first in the queue', await waitFor(() => /position 1 in queue/.test(pe.out)), pe.out);
    ok('B5 ... the dead waiter\'s ticket is gone', !tickets().some((t) => t.split(' ')[1] === String(pd.pid)), tickets().join('|'));
    r = st(['release'], C);
    ok('release by C', r.status === 0, outOf(r));
    ok('B5 E gets the ticket past the dead waiter', await waitFor(() => taken(pe)), pe.out);

    // B6: the leftovers post-check finds the holder by its worktree and frees the ticket.
    const lc = spawnSync('node', [path.join(S, 'role-leftovers-check.js'), '--wt', E, '--slots-dir', SL, '--fix'], { encoding: 'utf8', env });
    let res = {}; try { res = JSON.parse(lc.stdout); } catch { /* shown below */ }
    ok('B6 role-leftovers-check finds the holder process (cwd in the worktree)', (res.found || []).some((x) => x.startsWith(`process ${pe.pid} (cwd ${E}`)), lc.stdout + lc.stderr);
    ok('B6 ... and the stand ticket it holds', (res.found || []).some((x) => x === `slot stand.lock held by pid ${pe.pid} (stand)`), lc.stdout);
    ok('B6 --fix removes them: nothing remains', res.ok === true && await waitFor(() => pe.exited !== null, 5000), lc.stdout);
    r = st(['status'], A);
    ok('B6 the ticket is free afterwards', /ticket: free/.test(outOf(r)), outOf(r));
    ok('B6 the stopped holder wrote its journal line (kind term, rc 143)', (() => { const l = standLines().find((f) => f[9] === E); return l && l[6] === 'term' && l[8] === '143'; })(), standLines().map((f) => f.join(' ')).join('\n'));

    // release --force from another worktree (the coordinator), written to the journal.
    const pf = take(A);
    await waitFor(() => taken(pf));
    r = st(['release', '--force'], B);
    ok('release --force from another worktree frees the ticket', r.status === 0 && await waitFor(() => pf.exited !== null, 3000), outOf(r));
    ok('release --force: journal kind force', standLines().some((f) => f[9] === A && f[6] === 'force' && f[7] === String(pf.pid)), standLines().map((f) => f.join(' ')).join('\n'));
    ok('release --force: the reset ran too', log().slice(-1)[0] === 'reset held', log().join('|'));
    r = st(['release'], B);
    ok('release of a free ticket: says it is free, exit 0', r.status === 0 && /ticket is free/.test(outOf(r)), outOf(r));

    // A reset that fails at issue: the ticket is not given and stays free.
    fs.writeFileSync(path.join(T, 'reset-fail'), '');
    r = st(['take'], A);
    ok('reset fails at issue: take exits non-zero with the reason', r.status === 3 && /reset failed/.test(outOf(r)), `${r.status} ${outOf(r)}`);
    ok('... the ticket stays free', /ticket: free/.test(outOf(st(['status'], A))));
    ok('... journal kind refused with the reset\'s code', standLines().some((f) => f[6] === 'refused' && f[8] === '3'));
    fs.unlinkSync(path.join(T, 'reset-fail'));

    // B10: a stand ticket is never "the first of the other queue" for the memory slots.
    const S2 = path.join(T, 'slots2');
    const qw = (first) => spawnSync('zsh', ['-c', `source ${S}/slots.zsh; mkdir -p $SLOTS_DIR/queue; print -r -- "${first} 1 x single" > $SLOTS_DIR/queue/0000000001; print -r -- "heavy 2 x single" > $SLOTS_DIR/queue/0000000002; _slot_q_where $SLOTS_DIR/queue/0000000002 heavy; print -r -- "[$SLOT_QPOS|$SLOT_QOTHER]"`], { env: Object.assign({}, env, { SLOTS_DIR: S2 }), encoding: 'utf8' }).stdout.trim();
    ok('B10 a stand ticket ahead is not the other queue of a heavy waiter', qw('stand') === '[1|]', qw('stand'));
    ok('B10 ... a medium ticket ahead still is', /^\[1\|.+0000000001 medium single\]$/.test(qw('medium')), qw('medium'));

    // B11: an invalid config refuses with its text; nothing falls back to ~/.cache.
    const BAD = path.join(T, 'bad.json');
    fs.writeFileSync(BAD, JSON.stringify(cfgOf(Object.assign({}, STAND, { bogus: 1 }))));
    r = st(['status'], A, { CODIS_AGENTS_CONFIG: BAD });
    ok('B11 stand.sh with an invalid stand section: exit 78 with the config error', r.status === 78 && /stand\.bogus: unknown key/.test(outOf(r)), `${r.status} ${outOf(r)}`);
    for (const s of ['medium.sh', 'heavy.sh']) {
      const m = spawnSync('zsh', [path.join(S, s), 'touch', path.join(T, 'ran-' + s)], { cwd: A, env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: BAD }), encoding: 'utf8' });
      ok(`B11 ${s} with an invalid config refuses with the error (exit 78), the command does not run`, m.status === 78 && /stand\.bogus: unknown key/.test(m.stderr) && !fs.existsSync(path.join(T, 'ran-' + s)), `${m.status} ${m.stdout}${m.stderr}`);
    }
    ok('B11 nothing fell back to ~/.cache/codis-agents', !fs.existsSync(path.join(T, 'home', '.cache', 'codis-agents')));
    const m2 = spawnSync('zsh', [path.join(S, 'medium.sh'), 'true'], { cwd: A, env: Object.assign({}, env, { CODIS_AGENTS_CONFIG: path.join(T, 'missing.json') }), encoding: 'utf8' });
    ok('B11 a config path that does not exist refuses too (not a silent default)', m2.status === 78 && !fs.existsSync(path.join(T, 'home', '.cache', 'codis-agents')), `${m2.status} ${m2.stderr}`);
    const NOST = path.join(T, 'nostand.json');
    fs.writeFileSync(NOST, JSON.stringify(cfgOf(null)));
    r = st(['take'], A, { CODIS_AGENTS_CONFIG: NOST });
    ok('no stand section: take refuses (exit 78) and says so', r.status === 78 && /no stand section/.test(outOf(r)), outOf(r));

    // image-diff: the task's commits touch files of the stand's image -> its own stack.
    const G = path.join(T, 'wts', 'git');
    const git = (...a) => spawnSync('git', ['-C', G, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    fs.mkdirSync(path.join(G, 'server'), { recursive: true });
    git('init', '-q'); fs.writeFileSync(path.join(G, 'server', 'app.js'), '1'); fs.writeFileSync(path.join(G, 'server', 'Dockerfile'), 'FROM x');
    git('add', 'server/app.js', 'server/Dockerfile'); git('commit', '-qm', 'base'); git('tag', 'base');
    fs.writeFileSync(path.join(G, 'server', 'app.js'), '2'); git('add', 'server/app.js'); git('commit', '-qm', 'code');
    r = st(['image-diff', '--base', 'base'], G);
    ok('image-diff: code only -> exit 0, the stand fits', r.status === 0 && /no image files changed/.test(outOf(r)), outOf(r));
    fs.mkdirSync(path.join(G, 'deploy'), { recursive: true }); fs.writeFileSync(path.join(G, 'deploy', 'docker-compose.test.yml'), 'x');
    fs.writeFileSync(path.join(G, 'server', 'Dockerfile'), 'FROM y');
    git('add', 'deploy/docker-compose.test.yml', 'server/Dockerfile'); git('commit', '-qm', 'image');
    r = st(['image-diff', '--base', 'base'], G);
    ok('image-diff: Dockerfile and a compose file at any depth -> exit 1, both named', r.status === 1 && /server\/Dockerfile/.test(outOf(r)) && /deploy\/docker-compose\.test\.yml/.test(outOf(r)) && !/app\.js/.test(outOf(r)), outOf(r));
    fs.writeFileSync(path.join(G, 'server', 'dirty'), 'x');
    r = st(['image-diff', '--base', 'nope'], G);
    ok('image-diff: an unknown base -> exit 2 with the reason', r.status === 2, outOf(r));

    // cwd: with stand.cwd every command of the project runs in that directory; without it in repoDir (as before).
    const CWD = path.join(T, 'stand cwd'), CLOG = path.join(T, 'cwdlog');
    fs.mkdirSync(CWD);
    const at = (n) => `print -r -- "${n} $PWD" >> ${CLOG}`;
    const CS = Object.assign({}, STAND, {
      up: at('up') + `; touch ${T}/up`, status: at('status') + `; test -e ${T}/up`, down: at('down'),
      reset: at('reset'), deploy: at('deploy') + '; : {wt}',
    });
    const cwdLog = () => (fs.existsSync(CLOG) ? fs.readFileSync(CLOG, 'utf8').trim().split('\n').filter(Boolean) : []);
    const CWDCFG = path.join(T, 'cwd.json'), NOCWD = path.join(T, 'nocwd.json');
    fs.writeFileSync(CWDCFG, JSON.stringify(cfgOf(Object.assign({}, CS, { cwd: CWD }))));
    fs.writeFileSync(NOCWD, JSON.stringify(cfgOf(CS)));
    const ce = { CODIS_AGENTS_CONFIG: CWDCFG };
    for (const c of ['up', 'status', 'down']) st([c], A, ce);
    const pg = take(A, [], ce);
    ok('cwd: take with stand.cwd set gets the ticket', await waitFor(() => taken(pg)), pg.out);
    r = st(['deploy'], A, ce);
    ok('cwd: deploy by the holder exits 0', r.status === 0, outOf(r));
    r = st(['release'], A, ce);
    ok('cwd: release exits 0', r.status === 0 && await waitFor(() => pg.exited !== null, 3000), outOf(r));
    const ran = (lines, dir) => lines.length > 0 && lines.every((l) => l.endsWith(' ' + dir)) && ['up', 'status', 'down', 'reset', 'deploy'].every((n) => lines.some((l) => l.startsWith(n + ' ')));
    ok('cwd: up, status, down, reset (at issue and at release) and deploy all ran in stand.cwd', ran(cwdLog(), CWD) && cwdLog().filter((l) => l.startsWith('reset ')).length === 2, cwdLog().join('|'));
    fs.rmSync(CLOG, { force: true });
    for (const c of ['up', 'status', 'down']) st([c], A, { CODIS_AGENTS_CONFIG: NOCWD });
    const main = path.join(T, 'main');
    ok('cwd: without stand.cwd up, status and down run in repoDir', cwdLog().join('|') === ['up', 'status', 'down'].map((n) => `${n} ${main}`).join('|'), cwdLog().join('|'));
    const BADCWD = path.join(T, 'badcwd.json');
    fs.writeFileSync(BADCWD, JSON.stringify(cfgOf(Object.assign({}, CS, { cwd: path.join(T, 'missing-dir') }))));
    r = st(['status'], A, { CODIS_AGENTS_CONFIG: BADCWD });
    ok('cwd: a stand.cwd that does not exist - stand.sh refuses (exit 78) naming it', r.status === 78 && /stand\.cwd: /.test(outOf(r)) && outOf(r).includes('missing-dir'), `${r.status} ${outOf(r)}`);
    st(['up'], A);

    // The slot-journal summary shows the class stand (queue wait and hold).
    const sj = spawnSync('node', [path.join(S, 'slot-journal.js'), '--journal', J], { encoding: 'utf8' });
    ok('slot-journal: the summary has a row for the class stand', /^stand\s+\d+/m.test(sj.stdout), sj.stdout + sj.stderr);
  } catch (e) {
    ok('crashed: ' + e.stack, false);
  } finally {
    for (const p of procs) if (p.exited === null) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(200);
    fs.rmSync(T, { recursive: true, force: true });
  }
  done();
})();
