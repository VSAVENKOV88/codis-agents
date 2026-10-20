#!/usr/bin/env node
'use strict';
// A machine without zsh (a Linux box or CI image): the tests that need zsh are skipped with "skipped: zsh not found"
// and the run stays green - never a silent pass: the skip shows in the line of every such file and in the final tally.
// The check runs tests/run.js with a PATH where every directory holding zsh is replaced by a copy of symlinks without it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const ZSH_TESTS = ['config.test.js', 'guards-result.test.js', 'wt-setup.test.js', 'slots-check.test.sh', 'slots-fifo.test.sh', 'slots-journal.test.sh'];
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-zsh-')));
const isExe = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
try {
  let n = 0;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => {
    if (!isExe(path.join(d, 'zsh'))) return d;
    const shadow = path.join(tmp, 'bin' + n++);
    fs.mkdirSync(shadow);
    for (const e of fs.readdirSync(d)) if (e !== 'zsh') fs.symlinkSync(path.join(d, e), path.join(shadow, e));
    return shadow;
  });
  const PATH = dirs.join(path.delimiter);
  ok('the shadow PATH has no zsh', !dirs.some((d) => isExe(path.join(d, 'zsh'))), PATH);
  ok('the shadow PATH still has git', dirs.some((d) => isExe(path.join(d, 'git'))));

  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.js'), ...ZSH_TESTS],
    { encoding: 'utf8', env: Object.assign({}, process.env, { PATH }), timeout: 120000 });
  const out = r.stdout + r.stderr;
  ok('run.js without zsh exits 0', r.status === 0, out);
  for (const f of ZSH_TESTS) {
    const line = out.split('\n').find((l) => l.includes(' ' + f + ' ')) || '';
    ok(`${f}: not failed, skip shown in its line`, /^(pass|skip) /.test(line) && /skipped: zsh not found/.test(line), line || out);
  }
  const tail = out.trim().split('\n').pop();
  ok('the final tally names the skips', /skipped: zsh not found/.test(tail), tail);

  // With zsh present nothing is skipped (the skip is by fact, not by operating system).
  if (spawnSync('zsh', ['-c', 'true']).status === 0) {
    const w = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run.js'), 'config.test.js'], { encoding: 'utf8' });
    ok('with zsh in PATH config.test.js runs every check', w.status === 0 && !/skipped/.test(w.stdout), w.stdout);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
