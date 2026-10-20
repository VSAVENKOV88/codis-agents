#!/usr/bin/env node
'use strict';
// scripts/detect.js, programmer's cases of the INI section header (task U4a, after the tester's red on "[pytest] # c").
// pytest 9 reads tox.ini and setup.cfg with iniconfig (IniConfig(path), iniconfig/_parse.py _parseline). The expected
// pytestConfig of every directory is what pytest 9.1.1 itself picks there (_pytest.config.findpaths.locate_config,
// run on the same bytes):
// - "[ pytest ]": the name is not stripped -> no pytest section;
// - "  [pytest]" under a value: a line not starting with '[' is a continuation -> no pytest section;
// - a UTF-8 BOM before "[pytest]" is dropped -> tox.ini;
// - lines split as Python splitlines: CR alone and form feed end a line -> tox.ini;
// - "[pytest-x]", "[testenv:pytest]", "[metadata] # tool:pytest", "[tool:pytest]]" are other sections -> null.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-ini-header-')));
const env = gitEnv(base);
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const cases = {
  'tox-space': ['tox.ini', '[tox]\nenvlist = py\n\n[ pytest ]\naddopts = -q\n', null],
  'tox-indent': ['tox.ini', '[tox]\nenvlist = py\n  [pytest]\n', null],
  'tox-bom': ['tox.ini', '﻿[pytest]\naddopts = -q\n', 'tox.ini'],
  'tox-cr': ['tox.ini', '[tox]\renvlist = py\r\r[pytest]\raddopts = -q\r', 'tox.ini'],
  'tox-ff': ['tox.ini', '[tox]\f[pytest]\n', 'tox.ini'],
  'tox-near': ['tox.ini', '[pytest-x]\na = 1\n[testenv:pytest]\nb = 2\n', null],
  'cfg-comment': ['setup.cfg', '[metadata] # tool:pytest\nname = a\n', null],
  'cfg-tail': ['setup.cfg', '[metadata]\nname = a\n[tool:pytest]]\n', null],
};

try {
  const dir = path.join(base, 'ini');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const files = [];
  for (const [d, [name, text]] of Object.entries(cases)) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'setup.py'), 'pass\n');
    fs.writeFileSync(path.join(dir, d, name), text);
    files.push(`${d}/setup.py`, `${d}/${name}`);
  }
  git(dir, 'add', '--', ...files);
  git(dir, 'commit', '-q', '-m', 'case');
  const r = spawnSync(process.execPath, [DETECT, '--root', dir], { encoding: 'utf8', env });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
  ok('exit 0 and JSON', r.status === 0 && j, `exit ${r.status} ${r.stderr}`);
  for (const [d, [, , want]] of Object.entries(cases)) {
    const s = j && j.repo.stacks.find((x) => x.dir === d && x.kind === 'python');
    const got = s ? s.runnerHint.pytestConfig : undefined;
    ok(`pytestConfig of ${d} is ${want} (as pytest 9 picks)`, got === want, `got ${got}`);
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
