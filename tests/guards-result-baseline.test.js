#!/usr/bin/env node
'use strict';
// guardBaseline is read without following links (p-codex-A2b-2h-1, cell H15; scripts/guards-result.js readBaseline):
// the file of known reds lives in the worktree a branch wrote, so a link there (to a file outside the worktree, to valid
// JSON outside, to a directory), a path through a directory link, something that is not a regular file, or a path out
// of the worktree is refused with "not a regular file inside the worktree" - never read; a regular file that is not JSON
// is "not readable as JSON" without its bytes (JSON.parse quotes the start of its input in its message). On a refusal
// the rerun keeps its behaviour ("nothing is subtracted and nothing reruns"), and quarantine-take changes neither the
// baseline (the target of a link stays byte for byte) nor the quarantine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const G = require('../scripts/guards-result');

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-baseline-')));
const wt = path.join(T, 'wt'), out = path.join(T, 'outside');
fs.mkdirSync(wt); fs.mkdirSync(out);
const CANARY = 'CANARY-ssh-rsa AAAAB3NzaC1yc2E-secret';
fs.writeFileSync(path.join(out, 'canary.txt'), CANARY + '\n');
fs.writeFileSync(path.join(out, 'good.json'), '{"g":"r"}\n');
fs.mkdirSync(path.join(out, 'dir'));
fs.writeFileSync(path.join(out, 'dir', 'known.json'), '{"g":"r"}\n');
const NOT = 'not a regular file inside the worktree';
const err = (rel) => (G.readBaseline(wt, rel) || {}).error || '';

try {
  fs.writeFileSync(path.join(wt, 'known.json'), '{"g":"reason"}\n');
  const r0 = G.readBaseline(wt, 'known.json');
  ok('H15 a regular file inside the worktree is read as before', r0.known && r0.known.g === 'reason' && !r0.error, JSON.stringify(r0));
  fs.mkdirSync(path.join(wt, 'sub')); fs.writeFileSync(path.join(wt, 'sub', 'k.json'), '{"h":"x"}\n');
  ok('H15 a regular file in a real subdirectory is read as before', (G.readBaseline(wt, 'sub/k.json').known || {}).h === 'x');
  ok('H15 a missing file: "no such file in the worktree" (as before)', err('absent.json') === 'no such file in the worktree', err('absent.json'));

  fs.symlinkSync(path.join(out, 'canary.txt'), path.join(wt, 'canary.json'));
  ok('H15 a link to a file outside the worktree (not JSON): refused, its bytes not in the error', err('canary.json') === NOT && !err('canary.json').includes('CANARY'), err('canary.json'));
  fs.symlinkSync(path.join(out, 'good.json'), path.join(wt, 'good.json'));
  ok('H15 a link to valid JSON outside the worktree: refused, not read', err('good.json') === NOT, err('good.json'));
  fs.symlinkSync('known.json', path.join(wt, 'inner.json'));
  ok('H15 a link to a file inside the worktree: refused too (no link is followed)', err('inner.json') === NOT, err('inner.json'));
  fs.symlinkSync(path.join(out, 'dir'), path.join(wt, 'dirlink'), 'dir');
  ok('H15 a link to a directory: refused', err('dirlink') === NOT, err('dirlink'));
  ok('H15 a path through a directory link: refused', err('dirlink/known.json') === NOT, err('dirlink/known.json'));
  fs.mkdirSync(path.join(wt, 'adir'));
  ok('H15 a directory at the path: refused', err('adir') === NOT, err('adir'));
  const fifo = path.join(wt, 'fifo.json');
  // in a child with a deadline: opening a FIFO for reading waits for a writer
  if (spawnSync('mkfifo', [fifo]).status === 0) {
    const c = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'scripts', 'guards-result.js'))}).readBaseline(${JSON.stringify(wt)}, 'fifo.json')))`], { encoding: 'utf8', timeout: 10000 });
    ok('H15 a FIFO at the path: refused without opening it', c.status === 0 && (JSON.parse(c.stdout || '{}').error || '') === NOT, `${c.status} ${c.signal} ${c.stdout}`);
  }
  ok('H15 a path out of the worktree (../): refused', err('../outside/good.json') === NOT, err('../outside/good.json'));
  ok('H15 an absolute path outside the worktree: refused', err(path.join(out, 'good.json')) === NOT, err(path.join(out, 'good.json')));
  fs.writeFileSync(path.join(wt, 'broken.json'), CANARY + '{\n');
  ok('H15 a regular file that is not JSON: "not readable as JSON" without its bytes', err('broken.json') === 'not readable as JSON' && !err('broken.json').includes('CANARY'), err('broken.json'));

  // the rerun: the line in the log, the behaviour on a refusal kept
  const log = path.join(T, 'guards.txt');
  for (const rel of ['canary.json', 'broken.json']) {
    fs.writeFileSync(log, 'FAILED t/a.js - x\n=== 1 failed in 0.1s ===\n');
    const r = G.rerun({ wt, log, rc: 1, cfg: { command: 'true {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' }, baseline: rel, quarantine: '' });
    const text = fs.readFileSync(log, 'utf8');
    ok(`H15 rerun with guardBaseline ${rel}: the runner's code stands, nothing reruns, no byte of the file in the log`, r.rc === 1 && r.repeated.length === 0 && r.flaky.length === 0
      && text.includes(`guardBaseline ${rel}: ${rel === 'broken.json' ? 'not readable as JSON' : NOT}: nothing is subtracted and nothing reruns`) && !text.includes('CANARY'), text);
  }

  // quarantine-take with a baseline that is a link: an error, a non-zero exit, nothing written
  const q = path.join(T, 'guards-quarantine.json');
  fs.writeFileSync(q, '{"t/x.js":"flaky: guards.txt abc1234, green alone, 2026-11-12"}\n');
  const qBefore = fs.readFileSync(q, 'utf8'), gBefore = fs.readFileSync(path.join(out, 'good.json'), 'utf8');
  const tk = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'quarantine-take', wt, 'good.json', q], { encoding: 'utf8' });
  ok('H15 quarantine-take, the baseline a link to valid JSON: "guardBaseline good.json is broken: ... not a regular file inside the worktree", exit not 0',
    tk.status !== 0 && tk.stderr.includes(`guardBaseline good.json is broken: ${NOT}`), tk.stdout + tk.stderr);
  ok('H15 quarantine-take refused: the target of the link and the quarantine are byte for byte the same, the link is still a link',
    fs.readFileSync(path.join(out, 'good.json'), 'utf8') === gBefore && fs.readFileSync(q, 'utf8') === qBefore && fs.lstatSync(path.join(wt, 'good.json')).isSymbolicLink());
  // a dangling link and a missing file behind a directory link: refused too, the link not replaced by a file, nothing
  // written through the directory link
  fs.symlinkSync(path.join(out, 'nowhere.json'), path.join(wt, 'dangling.json'));
  const tk3 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'quarantine-take', wt, 'dangling.json', q], { encoding: 'utf8' });
  const tk4 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'quarantine-take', wt, 'dirlink/new.json', q], { encoding: 'utf8' });
  ok('H15 quarantine-take into a dangling link or through a directory link: refused, nothing written, the quarantine kept',
    tk3.status !== 0 && tk3.stderr.includes(NOT) && fs.lstatSync(path.join(wt, 'dangling.json')).isSymbolicLink() && !fs.existsSync(path.join(out, 'nowhere.json'))
      && tk4.status !== 0 && tk4.stderr.includes(NOT) && !fs.existsSync(path.join(out, 'dir', 'new.json')) && fs.readFileSync(q, 'utf8') === qBefore, tk3.stderr + tk4.stderr);
  const tk2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guards-result.js'), 'quarantine-take', wt, 'known.json', q], { encoding: 'utf8' });
  ok('H15 quarantine-take into a regular baseline works as before', tk2.status === 0 && JSON.parse(fs.readFileSync(path.join(wt, 'known.json'), 'utf8'))['t/x.js'], tk2.stdout + tk2.stderr);
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
