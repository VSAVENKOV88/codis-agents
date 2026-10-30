#!/usr/bin/env node
'use strict';
// The train asks for its priority in the slot queue (p-runq-b1, cells B1 and B13 of p-runq/analyst.md; coordinator's
// decision 2 of 2026-10-30: the full run of the train and the attribution of a red train both): scripts/train.js calls
// guards-all.sh with --priority. The fixture is a throwaway project and a COPY of the scripts in which guards-all.sh is
// a stub that records its arguments (the queue itself is tests/slots-priority.test.sh).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

if (!has('zsh')) { skip('scripts/train.js (runs guards-all.sh, a zsh script)', 'zsh not found'); done(); }

const ROOT = path.join(__dirname, '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'train-prio-')));
const main = path.join(T, 'main'), wts = path.join(T, 'wts'), shared = path.join(T, 'shared'), S = path.join(T, 'scripts');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const rev = (ref) => git(main, 'rev-parse', '--verify', '-q', ref).stdout.trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

for (const d of [main, wts, shared]) fs.mkdirSync(d, { recursive: true });
fs.cpSync(path.join(ROOT, 'scripts'), S, { recursive: true });
// the stub: one line of arguments per call; the attribution call (--guards) is green, the full run red with one new
// red that the rerun repeats (so the train attributes it)
const calls = path.join(T, 'calls.txt');
put(path.join(S, 'guards-all.sh'), `#!/bin/zsh
print -r -- "$*" >> '${calls}'
wt=\${@[-1]}; name=\${wt:t}
if [[ " $* " == *' --guards '* ]]; then
  print -r -- "=== 1 passed in 0.1s ===" > '${shared}'/guards-$name.select.txt; exit 0
fi
print -r -- "FAILED t/x.js - boom
=== 1 failed in 0.1s ===
==== rerun of new reds one by one (guardRerun) ====
new red, red again alone: t/x.js (exit 1)" > '${shared}'/guards-$name.txt
print -r -- "FAILED t/x.js - boom"; exit 1
`);
fs.chmodSync(path.join(S, 'guards-all.sh'), 0o755);
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: main, worktreeRoot: wts, sharedDir: shared,
  guardCommand: 'cd {wt} && true', guardSubsetCommand: 'cd {wt} && true {onlyArgs}',
  guardRerun: { command: 'cd {wt} && true {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* in [0-9.]+s ===$' },
  worktreeSetup: { scan: [], skip: [], link: [] },
  slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, CODIS_TRAIN_POLL: '0.3' });
for (const k of ['SLOTS_DIR', 'SLOT_LEGACY_LOCK', 'SLOT_JOURNAL', 'SLOT_LABEL', 'SLOT_KIND', 'SLOT_RETRY_RC', 'SLOT_PRIORITY', 'CLAUDE_PROJECT_DIR']) delete env[k];
const tr = (...a) => spawnSync(process.execPath, [path.join(S, 'train.js'), ...a], { cwd: T, encoding: 'utf8', env, timeout: 120000 });

git(main, 'init', '-q', '-b', 'main');
put(path.join(main, 'base.txt'), 'base\n');
git(main, 'add', 'base.txt'); git(main, 'commit', '-q', '-m', 'base');
git(main, 'branch', 'arc');
git(main, 'branch', 'a', 'arc');
const tmpWt = path.join(T, 'mk-a');
git(main, 'worktree', 'add', '-q', tmpWt, 'a');
put(path.join(tmpWt, 'f-a.txt'), 'a\n');
git(tmpWt, 'add', 'f-a.txt'); git(tmpWt, 'commit', '-q', '-m', 'a');
git(main, 'worktree', 'remove', '--force', tmpWt);
const dir = path.join(T, 'tasks', 'a'); fs.mkdirSync(dir, { recursive: true });
let r = tr('enqueue', '--task', 'a', '--branch', 'a', '--head', rev('a'), '--base', 'arc', '--dir', dir);
ok('(setup) enqueue -> exit 0', r.status === 0, r.stdout + r.stderr);
r = tr('run');
const lines = read(calls).trim().split('\n').filter(Boolean);
const full = lines.filter((l) => !/(^| )--guards /.test(l));
const attr = lines.filter((l) => /(^| )--guards /.test(l));
ok('(setup) the train ran its full guard run', full.length === 1, `${lines.join(' | ')}\n${r.stdout}${r.stderr}`);
ok('B1 the full run of the train asks for the priority: guards-all.sh --priority', full.length === 1 && full[0].split(' ').includes('--priority'), lines.join(' | '));
ok('B13 the attribution of a red train (guards-all.sh --guards) asks for it too', attr.length >= 1 && attr.every((l) => l.split(' ').includes('--priority')),
  `${lines.join(' | ')}\n${r.stdout}${r.stderr}`);

fs.rmSync(T, { recursive: true, force: true });
done();
