#!/usr/bin/env node
'use strict';
// scripts/detect.js, cases of review 1 of task U4a that the fixture repositories and the edges do not reach:
// - pytest configuration in the precedence of pytest 9 (_pytest/config/findpaths.py, locate_config): pytest.toml,
//   .pytest.toml, pytest.ini, .pytest.ini, pyproject.toml with a [tool.pytest] table or [tool.pytest.ini_options],
//   tox.ini with [pytest], setup.cfg with [tool:pytest];
// - a file that only configures pytest (pytest.ini and its siblings) makes a python stack without pyproject or setup.*;
// - short names that git makes ambiguous (a local branch "origin/main", a tag named like the current branch) still give
//   the default branch, the current branch and the tag name;
// - rust (Cargo.toml) and go.work stacks, the npm workspaces.packages form, the note for a package.json that is not JSON;
// - no git in PATH: isRepo null with its own note, exit 0;
// - a venv without bin/python: python null;
// - tagShapes.example is the last tag of its shape in byte order (v1.9.0 after v1.10.0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-cases-')));
const env = gitEnv(base);
const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const put = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const repo = (name, files) => {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  return dir;
};
const commit = (dir) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'case'); };
const run = (dir, extraEnv) => {
  const r = spawnSync(process.execPath, [DETECT, '--root', dir], { encoding: 'utf8', env: Object.assign({}, env, extraEnv || {}) });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* checked by the callers */ }
  return { code: r.status, out: r.stdout, err: r.stderr, j };
};
const stack = (r, dir, kind) => r.j && r.j.repo.stacks && r.j.repo.stacks.find((s) => s.dir === dir && s.kind === kind);
const cfgOf = (r, dir) => { const s = stack(r, dir, 'python'); return s ? s.runnerHint.pytestConfig : undefined; };
const show = (r) => r.j ? JSON.stringify(r.j.repo.stacks) : `exit ${r.code} ${r.err}`;

try {
  // pytest configuration: each directory is one case.
  const d = repo('pytest', {
    'toml-table/pyproject.toml': '[project]\nname = "a"\n\n[tool.pytest]\nminversion = "9.0"\n',
    'toml-subtable/pyproject.toml': '[project]\nname = "a"\n\n[ tool.pytest.markers ]\nslow = "slow tests"\n',
    'ini-options/pyproject.toml': '[project]\nname = "a"\n\n[tool.pytest.ini_options]  # ini mode\n',
    'empty-table/pyproject.toml': '[project]\nname = "a"\n\n[tool.pytest]\n# nothing yet\n\n[tool.other]\nx = 1\n',
    'no-table/pyproject.toml': '[project]\nname = "a"\n',
    'pytest-toml/pytest.toml': '[pytest]\n', 'pytest-toml/pytest.ini': '[pytest]\n',
    'pytest-toml/pyproject.toml': '[tool.pytest.ini_options]\n',
    'dot-pytest-toml/.pytest.toml': '', 'dot-pytest-toml/pytest.ini': '[pytest]\n',
    'tox/setup.py': 'pass\n', 'tox/tox.ini': '[tox]\nenvlist = py\n\n[pytest]\naddopts = -q\n',
    'only-ini/pytest.ini': '[pytest]\n', 'only-ini/requirements.txt': 'pytest\n', 'only-ini/tests/test_a.py': 'def test_a(): pass\n',
    'only-dot-ini/.pytest.ini': '', 'only-toml/pytest.toml': '',
  });
  commit(d);
  let r = run(d);
  ok('pytest: exit 0', r.code === 0 && r.j, `exit ${r.code} ${r.err}`);
  ok('pytest: pyproject.toml with a [tool.pytest] table holding a key is the config', cfgOf(r, 'toml-table') === 'pyproject.toml', show(r));
  ok('pytest: pyproject.toml with a [tool.pytest.*] subtable is the config', cfgOf(r, 'toml-subtable') === 'pyproject.toml', show(r));
  ok('pytest: [tool.pytest.ini_options], even empty and with a comment, is the config', cfgOf(r, 'ini-options') === 'pyproject.toml', show(r));
  ok('pytest: an empty [tool.pytest] table is not (pytest reads no options from it)', cfgOf(r, 'empty-table') === null, show(r));
  ok('pytest: pyproject.toml without a pytest table is not', cfgOf(r, 'no-table') === null, show(r));
  ok('pytest: pytest.toml comes before pytest.ini and pyproject.toml', cfgOf(r, 'pytest-toml') === 'pytest.toml', show(r));
  ok('pytest: .pytest.toml, even empty, comes before pytest.ini', cfgOf(r, 'dot-pytest-toml') === '.pytest.toml', show(r));
  ok('pytest: tox.ini with [pytest]', cfgOf(r, 'tox') === 'tox.ini', show(r));
  const oi = stack(r, 'only-ini', 'python');
  ok('pytest: pytest.ini alone (no pyproject, no setup.*) makes a python stack',
    JSON.stringify(oi) === JSON.stringify({ dir: 'only-ini', kind: 'python', manifests: ['pytest.ini'], locks: [], runnerHint: { pytestConfig: 'pytest.ini' }, workspaces: null }), show(r));
  ok('pytest: .pytest.ini alone makes a python stack', cfgOf(r, 'only-dot-ini') === '.pytest.ini', show(r));
  ok('pytest: pytest.toml alone makes a python stack', cfgOf(r, 'only-toml') === 'pytest.toml', show(r));
  ok('pytest: manifests of a directory keep their byte order', JSON.stringify((stack(r, 'pytest-toml', 'python') || {}).manifests)
    === '["pyproject.toml","pytest.ini","pytest.toml"]', show(r));

  // Ambiguous short names: a local branch "origin/main" next to refs/remotes/origin/main, a tag "main" on branch main.
  const a = repo('ambiguous', { 'README.md': '# a\n' });
  commit(a);
  git(a, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(a, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(a, 'branch', 'origin/main');
  git(a, 'tag', 'main');
  r = run(a);
  ok('ambiguous names: defaultBranch is main, no "origin/HEAD not set" note', r.j && r.j.repo.git.defaultBranch === 'main'
    && !r.j.repo.notes.some((n) => /origin\/HEAD/.test(n)), r.out + r.err);
  ok('ambiguous names: head is main (not heads/main)', r.j && r.j.repo.git.head === 'main', r.j && r.j.repo.git.head);
  ok('ambiguous names: the tag main keeps its name (not tags/main)', r.j
    && JSON.stringify(r.j.repo.git.tagShapes) === '[{"shape":"main","count":1,"example":"main"}]', r.j && JSON.stringify(r.j.repo.git.tagShapes));
  ok('ambiguous names: a branch named origin/... as the current branch keeps its full name', (() => {
    git(a, 'checkout', '-q', 'origin/main');
    const x = run(a);
    git(a, 'checkout', '-q', 'main');
    return x.j && x.j.repo.git.head === 'origin/main';
  })());

  // rust, go.work, workspaces.packages, a package.json that is not JSON.
  const k = repo('kinds', {
    'crate/Cargo.toml': '[package]\nname = "c"\n', 'crate/Cargo.lock': '',
    'gw/go.work': 'go 1.22\n', 'gw/x_test.go': 'package x\n',
    'ws/package.json': JSON.stringify({ workspaces: { packages: ['p/*', 7] }, scripts: { test: 'jest' } }),
    'bad/package.json': '{ not json',
  });
  commit(k);
  r = run(k);
  ok('rust: Cargo.toml and Cargo.lock, runnerHint null', JSON.stringify(stack(r, 'crate', 'rust'))
    === JSON.stringify({ dir: 'crate', kind: 'rust', manifests: ['Cargo.toml'], locks: ['Cargo.lock'], runnerHint: null, workspaces: null }), show(r));
  ok('go.work alone is a go stack with its test files', JSON.stringify(stack(r, 'gw', 'go'))
    === JSON.stringify({ dir: 'gw', kind: 'go', manifests: ['go.work'], locks: [], runnerHint: { testFiles: 1 }, workspaces: null }), show(r));
  ok('node: the workspaces.packages form, strings only', JSON.stringify((stack(r, 'ws', 'node') || {}).workspaces) === '["p/*"]', show(r));
  const bad = stack(r, 'bad', 'node');
  ok('node: a package.json that is not JSON - a stack with runnerHint null and a note', bad && bad.runnerHint === null
    && r.j.repo.notes.includes('bad/package.json is not valid JSON - its scripts are not read'), show(r) + ' ' + (r.j && JSON.stringify(r.j.repo.notes)));

  // A venv without bin/python; tag shapes in byte order.
  const v = repo('venv', { '.gitignore': 'venv/\n', 'venv/pyvenv.cfg': 'home = /usr/bin\n', 'pyproject.toml': '[project]\nname = "v"\n' });
  commit(v);
  git(v, 'tag', 'v1.9.0');
  git(v, 'tag', 'v1.10.0');
  r = run(v);
  ok('venv without bin/python: python null', r.j && JSON.stringify(r.j.repo.venvs) === '[{"dir":"venv","python":null}]', r.j && JSON.stringify(r.j.repo.venvs));
  ok('tagShapes: example is the last tag of the shape in byte order', r.j
    && JSON.stringify(r.j.repo.git.tagShapes) === '[{"shape":"vN.N.N","count":2,"example":"v1.9.0"}]', r.j && JSON.stringify(r.j.repo.git.tagShapes));

  // No git in PATH: only node is reachable.
  const bin = path.join(base, 'bin-node-only');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  r = run(v, { PATH: bin });
  ok('no git in PATH: exit 0, isRepo null, the "git not found" note only', r.code === 0 && r.j && r.j.repo.git.isRepo === null
    && JSON.stringify(r.j.repo.notes) === '["git not found - git facts not read"]', r.out + r.err);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
