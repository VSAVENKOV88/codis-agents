#!/usr/bin/env node
'use strict';
// scripts/detect.js, tester's cases of round 2 of task U4a (after review 1) that detect-cases.test.js does not reach.
// The expected pytestConfig of every directory is what pytest 9.1.1 itself picks there
// (_pytest.config.findpaths.locate_config, run on the same files):
// - setup.cfg with [tool:pytest] is the config; the precedence pairs .pytest.ini > pyproject.toml > tox.ini > setup.cfg;
// - a pyproject.toml with CRLF line ends;
// - an INI section header with a trailing comment: pytest parses tox.ini and setup.cfg with iniconfig, which cuts
//   everything after '#' or ';' on a section line before it looks for ']' (iniconfig/_parse.py, _parseline), so
//   "[pytest] # c" and "[tool:pytest] ; c" are the pytest sections;
// - branch, default branch and tag names holding a slash keep every part (only the refs/... prefix is cut).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-pytest-ini-')));
const env = gitEnv(base);
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const repo = (name, files) => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', 'case');
  return dir;
};
const run = (dir) => {
  const r = spawnSync(process.execPath, [DETECT, '--root', dir], { encoding: 'utf8', env });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
  return { code: r.status, err: r.stderr, j };
};

try {
  const d = repo('pytest', {
    'cfg/setup.py': 'pass\n', 'cfg/setup.cfg': '[metadata]\nname = a\n\n[tool:pytest]\naddopts = -q\n',
    'dotini-vs-pyproject/.pytest.ini': '', 'dotini-vs-pyproject/pyproject.toml': '[tool.pytest.ini_options]\n',
    'pyproject-vs-tox/pyproject.toml': '[tool.pytest.ini_options]\n', 'pyproject-vs-tox/tox.ini': '[pytest]\n',
    'tox-vs-cfg/setup.py': 'pass\n', 'tox-vs-cfg/tox.ini': '[pytest]\n', 'tox-vs-cfg/setup.cfg': '[tool:pytest]\n',
    'crlf/pyproject.toml': '[project]\r\nname = "a"\r\n\r\n[tool.pytest]\r\nminversion = "9.0"\r\n',
    'tox-hash/setup.py': 'pass\n', 'tox-hash/tox.ini': '[tox]\nenvlist = py\n\n[pytest] # pytest options\naddopts = -q\n',
    'tox-semi/setup.py': 'pass\n', 'tox-semi/tox.ini': '[tox]\nenvlist = py\n\n[pytest] ; pytest options\naddopts = -q\n',
    'cfg-hash/setup.py': 'pass\n', 'cfg-hash/setup.cfg': '[metadata]\nname = a\n\n[tool:pytest]  # pytest options\naddopts = -q\n',
  });
  const r = run(d);
  ok('exit 0 and JSON', r.code === 0 && r.j, `exit ${r.code} ${r.err}`);
  const cfg = (dir) => { const s = r.j && r.j.repo.stacks.find((x) => x.dir === dir && x.kind === 'python'); return s ? s.runnerHint.pytestConfig : undefined; };
  const want = {
    cfg: 'setup.cfg', 'dotini-vs-pyproject': '.pytest.ini', 'pyproject-vs-tox': 'pyproject.toml', 'tox-vs-cfg': 'tox.ini',
    crlf: 'pyproject.toml', 'tox-hash': 'tox.ini', 'tox-semi': 'tox.ini', 'cfg-hash': 'setup.cfg',
  };
  for (const [dir, w] of Object.entries(want)) ok(`pytestConfig of ${dir} is ${w} (as pytest 9 picks)`, cfg(dir) === w, `got ${cfg(dir)}`);

  const s = repo('slash', { 'a.txt': 'a\n' });
  git(s, 'checkout', '-q', '-b', 'feature/x-1');
  git(s, 'update-ref', 'refs/remotes/origin/release/2.0', 'HEAD');
  git(s, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/2.0');
  git(s, 'tag', 'rel/1.0');
  const g = run(s).j;
  ok('slash: head keeps feature/x-1', g && g.repo.git.head === 'feature/x-1', g && g.repo.git.head);
  ok('slash: defaultBranch keeps release/2.0', g && g.repo.git.defaultBranch === 'release/2.0', g && g.repo.git.defaultBranch);
  ok('slash: tag rel/1.0 keeps its name', g && JSON.stringify(g.repo.git.tagShapes) === '[{"shape":"rel/N.N","count":1,"example":"rel/1.0"}]',
    g && JSON.stringify(g.repo.git.tagShapes));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
