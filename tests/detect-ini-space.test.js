#!/usr/bin/env node
'use strict';
// scripts/detect.js, tester's cases of the INI section header (task U4a, round 3): which characters end a line and which
// are stripped from its end. iniconfig (pytest 9.1.1 reads tox.ini and setup.cfg with it) reads the file in text mode
// (CR and CRLF become LF), splits it with str.splitlines and strips each line with str.rstrip(), so the whitespace is
// Python's (str.isspace), not JavaScript's: U+001F is stripped in Python and not by String#trimEnd, U+FEFF the other
// way round. Every expected pytestConfig below is what pytest 9.1.1 itself picks
// (_pytest.config.findpaths.locate_config on the same bytes), not a hand rule:
// - "[pytest]\x1f" and "[pytest]\x1f# c" -> tox.ini (Python strips U+001F);
// - "[pytest]﻿" -> null (U+FEFF is not whitespace in Python; the line is a value continuation);
// - "[pytest]\xa0# c", "[pytest] ", "[pytest]\t;c", "[pytest]#c", "[pytest] ; a # b" -> tox.ini;
// - NEL, LINE/PARAGRAPH SEPARATOR, VT, FS/GS/RS end a line -> tox.ini;
// - "[py#test]", "# [pytest]", ";[pytest]", "[pytest ] # c" -> null; CRLF setup.cfg "[tool:pytest] ; c" -> setup.cfg.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-ini-space-')));
const env = gitEnv(base);
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const T = '[tox]\nenvlist = py\n';
const cases = {
  'us-tail': ['tox.ini', T + '[pytest]\x1f\naddopts = -q\n', 'tox.ini'],
  'us-before-comment': ['tox.ini', T + '[pytest]\x1f# c\naddopts = -q\n', 'tox.ini'],
  'bom-tail': ['tox.ini', T + '[pytest]﻿\naddopts = -q\n', null],
  'nbsp-tail': ['tox.ini', T + '[pytest]\xa0# c\naddopts = -q\n', 'tox.ini'],
  'emsp-tail': ['tox.ini', T + '[pytest] \n', 'tox.ini'],
  'tab-comment': ['tox.ini', T + '[pytest]\t;c\naddopts = -q\n', 'tox.ini'],
  'nocspace': ['tox.ini', T + '[pytest]#c\n', 'tox.ini'],
  'semi-then-hash': ['tox.ini', T + '[pytest] ; a # b\n', 'tox.ini'],
  'nel': ['tox.ini', '[tox]\x85[pytest]\x85addopts = -q\n', 'tox.ini'],
  'ls': ['tox.ini', '[tox] [pytest] addopts = -q\n', 'tox.ini'],
  'vt': ['tox.ini', '[tox]\x0b[pytest]\n', 'tox.ini'],
  'fs': ['tox.ini', '[tox]\x1c[pytest]\x1dx = 1\x1e', 'tox.ini'],
  'hash-in-name': ['tox.ini', T + '[py#test]\n', null],
  'commented-line': ['tox.ini', T + '# [pytest]\n;[pytest]\n', null],
  'name-trail-space': ['tox.ini', T + '[pytest ] # c\n', null],
  'crlf-comment': ['setup.cfg', '[metadata]\r\nname = a\r\n[tool:pytest] ; c\r\naddopts = -q\r\n', 'setup.cfg'],
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
    ok(`pytestConfig of ${d} is ${want} (as pytest 9.1.1 picks)`, got === want, `got ${got}`);
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
