#!/usr/bin/env node
'use strict';
// Detect: the facts of a repository that onboarding needs, read without questions and without writing anything.
// This is the repository part (`repo`); the machine part (memory, swap, tools) is added separately.
// usage: detect.js [--root <dir>]   (default: the current directory; inside a repository its top level is read)
//   prints JSON on stdout and exits 0 - also for "not a git repository" or "docker not found": those are facts, the
//   onboarding decides what they mean; 64 on bad usage, 66 when the directory does not exist, 70 on an internal error
//   (one line on stderr).
//
// Output: { root: <absolute path>, repo: {git, ci, stacks, venvs, compose, ignored, existing, notes} }
//   git      {isRepo, commits, head, defaultBranch, branches: {main, master}, tagShapes: [{shape, count, example}],
//             remote: [{name, url}], hooksPath}; outside a repository isRepo is false and the rest null.
//            defaultBranch is what origin/HEAD points to (set by git clone); without it null and a note - no guess,
//            no network call. A tag shape is the tag with every run of digits replaced by N (v1.2.0 -> vN.N.N), with
//            the count and the last tag of that shape in byte order (not the newest: v1.9.0 sorts after v1.10.0).
//            Branch and tag names are full ref names with their refs/... prefix cut, never git's short names (those
//            turn into heads/main or tags/main when another ref has the same name). A password in a remote URL is replaced by *** (the output goes
//            into onboarding notes and reports).
//   ci       [{file}] - GitHub Actions workflow files, .github/workflows/*.yml|yaml (the path GitHub documents).
//            Which command of them runs the tests is not read here: onboarding asks.
//   stacks   [{dir, kind, manifests, locks, runnerHint, workspaces}] per directory and kind, from the manifest names
//            the ecosystems document: node package.json (locks package-lock.json, npm-shrinkwrap.json, yarn.lock,
//            pnpm-lock.yaml; runnerHint {test: scripts.test verbatim}; workspaces: the npm "workspaces" field);
//            python pyproject.toml, setup.py, setup.cfg, Pipfile and the files that only configure pytest: pytest.toml,
//            .pytest.toml, pytest.ini, .pytest.ini (locks poetry.lock, uv.lock, pdm.lock, Pipfile.lock;
//            runnerHint {pytestConfig}: the file pytest takes its configuration from in that directory, in the
//            precedence of pytest 9 (_pytest/config/findpaths.py, locate_config): pytest.toml, .pytest.toml,
//            pytest.ini, .pytest.ini (each even empty), pyproject.toml with a non-empty [tool.pytest] table or a
//            [tool.pytest.ini_options] table, tox.ini with [pytest], setup.cfg with [tool:pytest]; the pyproject tables
//            are found by their header lines - a pytest table written only as dotted keys under [tool] is not read.
//            A pyproject.toml without them gives null: pytest reads no options from it); go go.mod, go.work (lock go.sum; runnerHint {testFiles}: *_test.go files
//            of that module, without the directories the go tool ignores: testdata and names starting with . or _);
//            rust Cargo.toml (lock Cargo.lock; runnerHint null). Facts only: no decision whether tests exist.
//   venvs    [{dir, python}] - ignored directories with pyvenv.cfg at their top (PEP 405), python = <dir>/bin/python.
//   compose  [{dir, files, name, services}] per directory holding compose files (compose.yaml, compose.yml,
//            docker-compose.yaml, docker-compose.yml and their .override files). services come from
//            `docker compose config --format json` run in that directory (its own file lookup and override merge;
//            no daemon needed), sorted by name: {name, image, build: {context, dockerfile} | null, ports:
//            [{target, published, protocol, host_ip?}], healthcheck: <test> | null}. COMPOSE_* variables of the
//            environment are dropped for that call (they would select other files, project or profiles). Without the
//            docker CLI, or when compose refuses the file, services is null and a note says why.
//   ignored  [{path, bytes}] - ignored files and directories as git status shows them (a directory that is ignored
//            whole is one entry), bytes = the sum of the sizes of its regular files.
//   existing {codisConfig, standScripts, claudeMdImport} - what an earlier onboarding left: .claude/codis-agents.json,
//            scripts/stand/*, and a CLAUDE.md line that starts with @ and ends with /rules/multi-agent.md.
//   notes    [string] - what could not be read and why.
// Paths are relative to the repository and arrays sorted by byte order, so the same repository gives the same bytes
// on macOS and Linux. git runs with GIT_OPTIONAL_LOCKS=0 (git status would otherwise refresh .git/index) and every
// child with LC_ALL=C; only exit codes and machine output are parsed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const USAGE = 'usage: detect.js [--root <dir>]';
const NO_ORIGIN_HEAD = 'origin/HEAD not set - default branch unknown (no network call is made to find it)';
const NOT_GIT = 'not a git repository - git facts, stacks, CI, compose, ignored data and existing setup are read only in a git repository';

const byteSort = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortBy = (arr, key) => arr.sort((a, b) => byteSort(key(a), key(b)));

function childEnv(extra) {
  const env = Object.assign({}, process.env, { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, extra || {});
  delete env.LANGUAGE;
  return env;
}

function sh(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env: env || childEnv(), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { code: r.error ? null : r.status, out: r.stdout || '', err: r.stderr || '', missing: !!(r.error && r.error.code === 'ENOENT') };
}

const exists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// The size of the regular files under p (not following symbolic links).
function bytesOf(p) {
  let s;
  try { s = fs.lstatSync(p); } catch { return 0; }
  if (s.isFile()) return s.size;
  if (!s.isDirectory()) return 0;
  let sum = 0;
  let entries = [];
  try { entries = fs.readdirSync(p); } catch { return 0; }
  for (const e of entries) sum += bytesOf(path.join(p, e));
  return sum;
}

function readGit(root, notes) {
  const git = (...a) => sh('git', a, root);
  const r = {};
  const count = git('rev-list', '--count', 'HEAD');
  r.isRepo = true;
  r.commits = count.code === 0 ? Number(count.out.trim()) : 0;
  if (!r.commits) notes.push('no commits yet');
  const strip = (out, prefix) => { const t = out.trim(); return t.startsWith(prefix) ? t.slice(prefix.length) : null; };
  const head = git('symbolic-ref', '-q', 'HEAD');
  r.head = head.code === 0 ? strip(head.out, 'refs/heads/') : null;
  if (r.head === null) notes.push('HEAD is detached - no current branch');
  const oh = git('symbolic-ref', '-q', 'refs/remotes/origin/HEAD');
  r.defaultBranch = oh.code === 0 ? strip(oh.out, 'refs/remotes/origin/') : null;
  if (r.defaultBranch === null) notes.push(NO_ORIGIN_HEAD);
  const branch = (b) => git('show-ref', '--verify', '--quiet', 'refs/heads/' + b).code === 0
    || git('show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + b).code === 0;
  r.branches = { main: branch('main'), master: branch('master') };
  const tags = git('for-each-ref', '--format=%(refname)', 'refs/tags').out.split('\n').filter(Boolean)
    .map((t) => t.slice('refs/tags/'.length)).sort(byteSort);
  const shapes = new Map();
  for (const t of tags) {
    const shape = t.replace(/[0-9]+/g, 'N');
    const s = shapes.get(shape) || { shape, count: 0, example: null };
    s.count++; s.example = t;
    shapes.set(shape, s);
  }
  r.tagShapes = sortBy([...shapes.values()], (s) => s.shape);
  const remotes = git('config', '-z', '--get-regexp', '^remote\\..*\\.url$').out.split('\0').filter(Boolean).map((e) => {
    const nl = e.indexOf('\n');
    const key = e.slice(0, nl), url = e.slice(nl + 1);
    return { name: key.slice('remote.'.length, -'.url'.length), url: url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@:]*):[^/@]*@/, '$1:***@') };
  });
  r.remote = sortBy(remotes, (x) => x.name);
  const hp = git('config', '--get', 'core.hooksPath');
  r.hooksPath = hp.code === 0 ? hp.out.trim() : null;
  return r;
}

const NODE_LOCKS = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const KINDS = [
  { kind: 'go', manifests: ['go.mod', 'go.work'], locks: ['go.sum'] },
  { kind: 'node', manifests: ['package.json'], locks: NODE_LOCKS },
  { kind: 'python', manifests: ['.pytest.ini', '.pytest.toml', 'Pipfile', 'pyproject.toml', 'pytest.ini', 'pytest.toml', 'setup.cfg', 'setup.py'], locks: ['Pipfile.lock', 'pdm.lock', 'poetry.lock', 'uv.lock'] },
  { kind: 'rust', manifests: ['Cargo.toml'], locks: ['Cargo.lock'] },
];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml',
  'compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];

// pytest reads tox.ini and setup.cfg with iniconfig (IniConfig(path): no inline comment or section whitespace
// stripping), whose _parseline takes a line as a section header when its first character is '[': it cuts the line at
// '#' and then at ';', strips trailing whitespace and needs ']' at the end; the name is what lies between, unstripped.
// Lines are split as Python's str.splitlines, after an optional UTF-8 BOM.
function hasSection(text, name) {
  if (text === null) return false;
  return text.replace(/^\uFEFF/, '').split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/).some((raw) => {
    let l = raw.trimEnd();
    if (l[0] !== '[') return false;
    for (const c of '#;') l = l.split(c)[0].trimEnd();
    return l.endsWith(']') && l.slice(1, -1) === name;
  });
}

// pyproject.toml configures pytest with [tool.pytest.ini_options] (even empty) or a [tool.pytest] table that is not
// empty: a key under its own header, or any subtable [tool.pytest.<x>] / [[tool.pytest.<x>]]. A TOML header may hold
// spaces around the dots and a trailing comment.
function pyprojectPytest(text) {
  if (text === null) return false;
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l) continue;
    const h = /^\[\[?([^\]]*)\]\]?$/.exec(l);
    if (h) {
      const name = h[1].replace(/[ \t]/g, '');
      if (name.startsWith('tool.pytest.')) return true;
      inTable = name === 'tool.pytest';
      continue;
    }
    if (inTable) return true;
  }
  return false;
}

function pytestConfig(root, dir) {
  const f = (n) => path.join(root, dir, n);
  for (const n of ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini']) if (isFile(f(n))) return n;
  if (pyprojectPytest(readText(f('pyproject.toml')))) return 'pyproject.toml';
  if (hasSection(readText(f('tox.ini')), 'pytest')) return 'tox.ini';
  if (hasSection(readText(f('setup.cfg')), 'tool:pytest')) return 'setup.cfg';
  return null;
}

function readStacks(root, files, notes) {
  const byDir = new Map();
  for (const f of files) {
    const dir = path.posix.dirname(f), base = path.posix.basename(f);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(base);
  }
  const stacks = [];
  for (const [dir, names] of byDir) {
    for (const k of KINDS) {
      const manifests = k.manifests.filter((m) => names.has(m));
      if (!manifests.length) continue;
      const s = { dir, kind: k.kind, manifests, locks: k.locks.filter((m) => names.has(m)), runnerHint: null, workspaces: null };
      if (k.kind === 'node') {
        const rel = path.posix.join(dir, 'package.json');
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { notes.push(`${rel} is not valid JSON - its scripts are not read`); }
        if (pkg && typeof pkg === 'object') {
          const t = pkg.scripts && typeof pkg.scripts.test === 'string' ? pkg.scripts.test : null;
          s.runnerHint = { test: t };
          const w = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : null;
          s.workspaces = w ? w.filter((x) => typeof x === 'string') : null;
        }
      } else if (k.kind === 'python') {
        s.runnerHint = { pytestConfig: pytestConfig(root, dir) };
      } else if (k.kind === 'go') {
        s.runnerHint = { testFiles: 0 };
      }
      stacks.push(s);
    }
  }
  // *_test.go files belong to the deepest go module above them; the go tool skips testdata and names starting . or _.
  const goDirs = stacks.filter((s) => s.kind === 'go');
  for (const f of files) {
    if (!f.endsWith('_test.go')) continue;
    const owner = goDirs.filter((s) => s.dir === '.' || f.startsWith(s.dir + '/'))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!owner) continue;
    const inside = owner.dir === '.' ? f : f.slice(owner.dir.length + 1);
    if (inside.split('/').some((p) => p === 'testdata' || p.startsWith('.') || p.startsWith('_'))) continue;
    owner.runnerHint.testFiles++;
  }
  return stacks.sort((a, b) => byteSort(a.dir, b.dir) || byteSort(a.kind, b.kind));
}

function readCompose(root, files, notes) {
  const dirs = new Map();
  for (const f of files) {
    if (!COMPOSE_FILES.includes(path.posix.basename(f))) continue;
    const d = path.posix.dirname(f);
    if (!dirs.has(d)) dirs.set(d, []);
    dirs.get(d).push(path.posix.basename(f));
  }
  const out = [];
  let dockerMissing = false;
  for (const dir of [...dirs.keys()].sort(byteSort)) {
    const abs = path.join(root, dir);
    const entry = { dir, files: dirs.get(dir).sort(byteSort), name: null, services: null };
    out.push(entry);
    if (dockerMissing) continue;
    const env = childEnv({ PWD: abs });
    for (const k of Object.keys(env)) if (k.startsWith('COMPOSE_')) delete env[k];
    const r = sh('docker', ['compose', 'config', '--format', 'json'], abs, env);
    if (r.missing) { dockerMissing = true; notes.push('docker not found - compose services not read'); continue; }
    let cfg = null;
    if (r.code === 0) { try { cfg = JSON.parse(r.out); } catch { cfg = null; } }
    if (!cfg) {
      const msg = (r.err.trim().split('\n').filter(Boolean).pop() || `exit ${r.code}`).split(root).join('.');
      notes.push(`compose config failed in ${dir}: ${msg}`);
      continue;
    }
    entry.name = typeof cfg.name === 'string' ? cfg.name : null;
    const rel = (p) => {
      if (typeof p !== 'string' || !path.isAbsolute(p)) return p === undefined ? null : p;
      let real = p;
      try { real = fs.realpathSync(p); } catch { /* keep as given */ }
      return path.relative(root, real).split(path.sep).join('/') || '.';
    };
    entry.services = sortBy(Object.entries(cfg.services || {}).map(([name, s]) => ({
      name,
      image: typeof s.image === 'string' ? s.image : null,
      build: s.build ? { context: rel(s.build.context), dockerfile: s.build.dockerfile === undefined ? null : s.build.dockerfile } : null,
      ports: (s.ports || []).map((p) => {
        const o = { target: p.target === undefined ? null : p.target, published: p.published === undefined ? null : String(p.published), protocol: p.protocol || null };
        if (p.host_ip) o.host_ip = p.host_ip;
        return o;
      }),
      healthcheck: s.healthcheck && s.healthcheck.test !== undefined ? s.healthcheck.test : null,
    })), (s) => s.name);
  }
  return out;
}

function readIgnored(root) {
  const r = sh('git', ['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal', '--ignore-submodules=all'], root);
  const fields = r.out.split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i];
    if (!e) continue;
    if (e[0] === 'R' || e[0] === 'C') { i++; continue; } // a rename or copy carries its source path in the next field
    if (e.startsWith('!! ')) out.push(e.slice(3));
  }
  return out.sort(byteSort).map((p) => ({ path: p, bytes: bytesOf(path.join(root, p)) }));
}

function readExisting(root, files) {
  const claude = readText(path.join(root, 'CLAUDE.md'));
  return {
    codisConfig: isFile(path.join(root, '.claude', 'codis-agents.json')) ? '.claude/codis-agents.json' : null,
    standScripts: files.filter((f) => f.startsWith('scripts/stand/')).sort(byteSort),
    claudeMdImport: claude !== null && claude.split(/\r?\n/).some((l) => { const t = l.trim(); return t.startsWith('@') && t.endsWith('/rules/multi-agent.md'); }),
  };
}

function detect(start) {
  const notes = [];
  const top = sh('git', ['rev-parse', '--show-toplevel'], start);
  if (top.missing) notes.push('git not found - git facts not read');
  const isRepo = top.code === 0;
  const root = isRepo ? fs.realpathSync(top.out.replace(/\n$/, '')) : start;
  if (!isRepo) {
    if (!top.missing) notes.push(NOT_GIT);
    const nul = { isRepo: top.missing ? null : false, commits: null, head: null, defaultBranch: null, branches: null, tagShapes: null, remote: null, hooksPath: null };
    return { root, repo: { git: nul, ci: null, stacks: null, venvs: null, compose: null, ignored: null, existing: null, notes } };
  }
  const files = sh('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).out.split('\0')
    .filter(Boolean).filter((f) => exists(path.join(root, f))).sort(byteSort);
  const repo = { git: readGit(root, notes) };
  repo.ci = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((file) => ({ file }));
  repo.stacks = readStacks(root, files, notes);
  const ignored = readIgnored(root);
  repo.venvs = ignored.filter((x) => x.path.endsWith('/') && isFile(path.join(root, x.path, 'pyvenv.cfg'))).map((x) => {
    const dir = x.path.slice(0, -1);
    return { dir, python: exists(path.join(root, dir, 'bin', 'python')) ? dir + '/bin/python' : null };
  });
  repo.compose = readCompose(root, files, notes);
  repo.ignored = ignored;
  repo.existing = readExisting(root, files);
  repo.notes = notes;
  return { root, repo };
}

function main(argv) {
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length && root === null) root = argv[++i];
    else { process.stderr.write(`detect: bad arguments (${argv.join(' ')}) - ${USAGE}\n`); return 64; }
  }
  const dir = path.resolve(root === null ? process.cwd() : root);
  let st = null;
  try { st = fs.statSync(dir); } catch { /* reported below */ }
  if (!st || !st.isDirectory()) { process.stderr.write(`detect: no such directory: ${dir} - pass an existing directory with --root\n`); return 66; }
  process.stdout.write(JSON.stringify(detect(fs.realpathSync(dir)), null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`detect: internal error - ${String(e && e.message || e).split('\n')[0]} - please report it\n`);
    code = 70;
  }
  process.exitCode = code;
}
module.exports = { detect };
