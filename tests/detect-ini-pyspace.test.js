#!/usr/bin/env node
'use strict';
// scripts/detect.js, tester's guard of the INI section header (task U4a, round 4): the WHOLE set of characters that
// iniconfig strips from the end of a header line. pytest 9.1.1 reads tox.ini and setup.cfg with iniconfig, whose
// _parseline strips a line with Python's str.rstrip() (str.isspace) before and after cutting it at '#' and ';'.
// The 29 code points below are every chr(c).isspace() of Python 3.13 over all of Unicode (none lie outside the BMP);
// the five negatives are not whitespace in Python (U+FEFF, U+180E are or were whitespace in JavaScript; U+200B, U+2060
// are zero-width; U+0000). Expectations are what pytest 9.1.1 itself picks (_pytest.config.findpaths.locate_config on
// the same bytes, _shared/u-u4a/test-r4-pytest-exp.log): "[pytest]<ws>" and "[pytest]<ws># c" -> tox.ini for every
// whitespace, null for every negative. The round-3 guard (detect-ini-space) pins only tab, U+001F, NBSP, EM SPACE and
// U+FEFF, so dropping any other member of the set went unnoticed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-ini-pyspace-')));
const env = gitEnv(base);
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const PY_SPACE = [0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
const NOT_PY_SPACE = [0xfeff, 0x180e, 0x200b, 0x2060, 0x0];
const hex = (cp) => cp.toString(16).padStart(4, '0');

const cases = {};
for (const [cps, want] of [[PY_SPACE, 'tox.ini'], [NOT_PY_SPACE, null]]) {
  for (const cp of cps) {
    for (const [pos, tail] of [['tail', ''], ['comment', '# c']]) {
      cases[`${pos}-${hex(cp)}`] = ['[tox]\nenvlist = py\n[pytest]' + String.fromCodePoint(cp) + tail + '\naddopts = -q\n', want];
    }
  }
}

try {
  const dir = path.join(base, 'ini');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const files = [];
  for (const [d, [text]] of Object.entries(cases)) {
    fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, d, 'setup.py'), 'pass\n');
    fs.writeFileSync(path.join(dir, d, 'tox.ini'), text);
    files.push(`${d}/setup.py`, `${d}/tox.ini`);
  }
  git(dir, 'add', '--', ...files);
  git(dir, 'commit', '-q', '-m', 'case');
  const r = spawnSync(process.execPath, [DETECT, '--root', dir], { encoding: 'utf8', env, maxBuffer: 64 << 20 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
  ok('exit 0 and JSON', r.status === 0 && j, `exit ${r.status} ${r.stderr}`);
  for (const [d, [, want]] of Object.entries(cases)) {
    const s = j && j.repo.stacks.find((x) => x.dir === d && x.kind === 'python');
    const got = s ? s.runnerHint.pytestConfig : undefined;
    ok(`pytestConfig of ${d} is ${want} (as pytest 9.1.1 picks)`, got === want, `got ${got}`);
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
