#!/usr/bin/env node
'use strict';
// p-verdict-orphan-a, the tester's cells (not in the programmer's table): synthetic train folders, status and ack only,
// no train runs.
//   O1 status only reads: the train folder (files, contents, mtimes) is the same after it, and a folder without
//      waiters/ gets none (the acceptance runs status on the real ~/figma-wt/_shared/train)
//   O2 a broken waiter file or a broken result next to a real orphan: status exits 0 and still names the orphan
//   O3 a task whose name is a prefix of another (a, a-b): waiter files and results are not mixed up; the later head of
//      a-b does not supersede a
//   O4 ack without --task, with a short head -> 64; a second ack -> 0 "already taken", claimedAt unchanged
//   O5 ack of one head takes only it: the other head of the same task stays without an addressee
//   O8 the start of a waiter from etime in every form of ps ([[dd-]hh:]mm:ss): a live waiter whose procStart matches
//      a start days or hours ago is alive (no orphan); an hour off - dead (orphan)
// usage: node tests/p-verdict-orphan-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-orphan-tester-')));
const shared = path.join(T, 'shared'), bin = path.join(T, 'bin');
const TD = path.join(shared, 'train'), WD = path.join(TD, 'waiters');
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
fs.mkdirSync(path.join(T, 'main'), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: path.join(T, 'main'), worktreeRoot: path.join(T, 'wts'), sharedDir: shared,
  guardCommand: 'cd {wt} && true', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, LANG: 'ru_RU.UTF-8' });
for (const k of ['CODIS_TRAIN_CLAIM_PAUSE', 'LC_ALL', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (extra, ...a) => spawnSync(process.execPath, [TRAIN, ...a], { cwd: T, encoding: 'utf8', env: Object.assign({}, env, extra), timeout: 60000 });
const H = (c) => c.repeat(40);
const DEAD = 999999; // no such pid on macOS/Linux by default (pid_max below it)
const putWaiter = (task, head, pid, o) => put(path.join(WD, `${task}-${head}-${pid}.json`), JSON.stringify(Object.assign({ pid, procStart: Date.now(), state: 'left', at: new Date().toISOString() }, o)));
const setResult = (task, head, o) => put(path.join(TD, 'result', `${task}-${head}.json`), JSON.stringify(Object.assign({ task, head, branch: task, base: 'arc', train: 'syn', verdict: 'red' }, o)));
const section = (s) => { const i = s.indexOf('verdicts without an addressee'); return i < 0 ? '' : s.slice(i); };
// a status stdout that is null (status did not exit 0) fails every check, positive or negative
const stat = (extra = {}) => { const r = tr(extra, 'status'); return r.status === 0 ? r.stdout : null; };
const named = (s, task, head) => s != null && section(s).split('\n').some((l) => l.trim().startsWith(`${task} ${head} `));
const unnamed = (s, task, head) => s != null && !named(s, task, head);
// every file under d with its contents and mtime
const snap = (d) => {
  const out = [];
  const walk = (x) => {
    let st; try { st = fs.lstatSync(x); } catch { return; }
    if (st.isDirectory()) { out.push(`D ${path.relative(d, x)} ${st.mtimeMs}`); for (const n of fs.readdirSync(x).sort()) walk(path.join(x, n)); }
    else out.push(`F ${path.relative(d, x)} ${st.mtimeMs} ${crypto.createHash('sha1').update(fs.readFileSync(x)).digest('hex')}`);
  };
  walk(d);
  return out.join('\n');
};

async function main() {
  // ---- O1: status on a folder without waiters/ creates nothing ----
  setResult('old', H('1'), { verdict: 'green', merged: H('2') });
  put(path.join(TD, 'queue', '0000000000001-q1.json'), JSON.stringify({ task: 'q1', branch: 'q1', head: H('3'), base: 'arc', enqueuedAt: new Date().toISOString() }));
  let before = snap(TD);
  let r = tr({}, 'status');
  ok('O1 status without waiters/: exit 0, no orphan section', r.status === 0 && !section(r.stdout), `${r.status} ${r.stdout}${r.stderr}`);
  ok('O1 status without waiters/ creates no file or folder and changes nothing', !fs.existsSync(WD) && snap(TD) === before, `${snap(TD)}\n---\n${before}`);

  // ---- O2: broken files next to a real orphan ----
  setResult('o2', H('a'));
  putWaiter('o2', H('a'), DEAD, {});
  put(path.join(WD, `bw-${H('b')}-${DEAD}.json`), '{ not json');
  setResult('bw', H('b'));
  put(path.join(TD, 'result', `br-${H('c')}.json`), '{ broken');
  putWaiter('br', H('c'), DEAD, {});
  // O1 again: with waiters, results, a queue entry and a halt in place, status changes nothing
  put(path.join(TD, 'halt'), JSON.stringify({ reason: 'environment: test', at: new Date().toISOString() }));
  before = snap(TD);
  await new Promise((z) => setTimeout(z, 20));
  r = tr({}, 'status');
  ok('O2 a broken waiter file and a broken result: status exits 0 and still names the real orphan o2', r.status === 0 && named(r.stdout, 'o2', H('a')), `${r.status} ${r.stdout}${r.stderr}`);
  ok('O2 the result whose only waiter file is broken is not named, the broken result neither', unnamed(r.stdout, 'bw', H('b')) && unnamed(r.stdout, 'br', H('c')), r.stdout);
  ok('O1 status with waiters, results, a queue and a halt changes nothing in the train folder', snap(TD) === before, `${snap(TD)}\n---\n${before}`);
  r = tr({}, 'resume');
  ok('O2 resume with a broken waiter file exits 0', r.status === 0, `${r.status} ${r.stderr}`);

  // ---- O3: a task name that is a prefix of another ----
  const t0 = Date.now();
  setResult('a', H('d'), { enqueuedAt: new Date(t0).toISOString() });
  putWaiter('a', H('d'), DEAD, {});
  setResult('a-b', H('e'), { enqueuedAt: new Date(t0 + 60000).toISOString() });
  putWaiter('a-b', H('e'), DEAD, {});
  setResult('a', H('f'), { enqueuedAt: new Date(t0 - 60000).toISOString() }); // a's own head without waiters: no orphan
  r = tr({}, 'status');
  ok('O3 a and a-b: both orphans named, each with its own head (a later head of a-b does not supersede a)', named(r.stdout, 'a', H('d')) && named(r.stdout, 'a-b', H('e')), r.stdout);
  ok('O3 the waiter file of a-b is not read as one of a (a with head e, a-b with head d are not named)', unnamed(r.stdout, 'a', H('e')) && unnamed(r.stdout, 'a-b', H('d')) && unnamed(r.stdout, 'a', H('f')), r.stdout);
  r = tr({}, 'ack', '--task', 'a', '--head', H('d'));
  const s3 = stat();
  ok('O3 ack of a takes only a: a-b stays named, its waiter file stays', r.status === 0 && unnamed(s3, 'a', H('d')) && named(s3, 'a-b', H('e')) && fs.existsSync(path.join(WD, `a-b-${H('e')}-${DEAD}.json`)), `${r.stdout}${r.stderr}\n${s3}`);

  // ---- O4: ack refusals and a second ack ----
  r = tr({}, 'ack', '--head', H('e'));
  ok('O4 ack without --task -> 64', r.status === 64, `${r.status} ${r.stderr}`);
  r = tr({}, 'ack', '--task', 'a-b', '--head', 'eeee');
  ok('O4 ack with a short head -> 64', r.status === 64, `${r.status} ${r.stderr}`);
  r = tr({}, 'ack', '--task', 'a-b', '--head', H('e'));
  const c1 = (readJ(path.join(TD, 'result', `a-b-${H('e')}.json`)) || {}).claimedAt;
  await new Promise((z) => setTimeout(z, 20));
  const r2 = tr({}, 'ack', '--task', 'a-b', '--head', H('e'));
  const c2 = (readJ(path.join(TD, 'result', `a-b-${H('e')}.json`)) || {}).claimedAt;
  ok('O4 a second ack -> exit 0 "already taken", claimedAt unchanged', r.status === 0 && r2.status === 0 && /already taken/.test(r2.stdout) && c1 && c1 === c2, `${r.stdout} ${r2.stdout} ${c1} ${c2}`);

  // ---- O5: ack of one head takes only it ----
  setResult('two', H('1'));
  putWaiter('two', H('1'), DEAD, {});
  setResult('two', H('2'));
  putWaiter('two', H('2'), DEAD, {});
  let s5 = stat();
  ok('O5 control: both heads of the task are named', named(s5, 'two', H('1')) && named(s5, 'two', H('2')), s5);
  r = tr({}, 'ack', '--task', 'two', '--head', H('1'));
  s5 = stat();
  ok('O5 ack of head 1 takes only head 1: head 2 still named, its waiter file kept, its result not taken',
    r.status === 0 && unnamed(s5, 'two', H('1')) && named(s5, 'two', H('2')) && fs.existsSync(path.join(WD, `two-${H('2')}-${DEAD}.json`)) && !(readJ(path.join(TD, 'result', `two-${H('2')}.json`)) || {}).claimedAt, s5);

  // ---- O8: etime in every form of ps (a fake ps in PATH; the waiter is a live sleep) ----
  const sl = spawn('sleep', ['120'], { stdio: 'ignore' });
  // the fake ps prints the time since a fixed start (whole seconds) in one form, so the clock moving between the write
  // of the waiter file and status does not matter
  const forms = [['mm:ss', 7 * 60 + 9, 'printf "   %02d:%02d\\n" $((e/60)) $((e%60))'],
    ['hh:mm:ss', 2 * 3600 + 3 * 60 + 4, 'printf "   %02d:%02d:%02d\\n" $((e/3600)) $((e%3600/60)) $((e%60))'],
    ['dd-hh:mm:ss', 86400 + 2 * 3600 + 3 * 60 + 4, 'printf "   %d-%02d:%02d:%02d\\n" $((e/86400)) $((e%86400/3600)) $((e%3600/60)) $((e%60))']];
  for (const [name, sec, fmt] of forms) {
    const i = forms.findIndex((f) => f[0] === name), task = `e${i}`;
    const start = Math.floor(Date.now() / 1000) - sec;
    const fbin = path.join(T, `bin-ps${i}`); // no ":" of the form in the folder: it would split PATH
    put(path.join(fbin, 'ps'), `#!/bin/sh\ne=$(( $(date +%s) - ${start} ))\n${fmt}\n`); fs.chmodSync(path.join(fbin, 'ps'), 0o755);
    const pe = { PATH: fbin + path.delimiter + process.env.PATH };
    const et = spawnSync(path.join(fbin, 'ps'), { encoding: 'utf8' }).stdout.trim();
    setResult(task, H('9'));
    putWaiter(task, H('9'), sl.pid, { state: 'waiting', procStart: start * 1000 });
    let s = stat(pe);
    ok(`O8 etime ${name} (${et}): a live waiter whose start matches is alive - not named`, unnamed(s, task, H('9')), s);
    putWaiter(task, H('9'), sl.pid, { state: 'waiting', procStart: (start - 3600) * 1000 });
    s = stat(pe);
    ok(`O8 etime ${name}: the same pid with a start an hour earlier (a reused pid) - named`, named(s, task, H('9')), s);
    fs.rmSync(path.join(WD, `${task}-${H('9')}-${sl.pid}.json`), { force: true });
  }
  sl.kill('SIGKILL');
}

main().catch((e) => ok('no exception', false, e && e.stack)).finally(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } done(); });
