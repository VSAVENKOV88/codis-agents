#!/usr/bin/env node
'use strict';
// scripts/detect.js, the repository part (task U4a): every fixture repository of tests/fixtures/repos/ (built by
// tests/detect-fixtures.js) gives exactly its <name>.expected.json as `repo`, on macOS and on Linux; the contract:
// exit 64 on bad usage and 66 on a missing directory with one line on stderr, nothing written anywhere (the files and
// mtimes of the repository and its .git are the same before and after), the same output under another locale and on a
// second run, and no absolute path except `root` and no password of a remote URL in the output.
// Fixtures with a compose file need the docker CLI with its compose plugin (no daemon: `compose config` does not talk
// to it); without them those fixtures are skipped, shown in the tally.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');
const { names, build, gitEnv, expected } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-')));
const env = gitEnv(base);
const run = (args, opts = {}) => spawnSync(process.execPath, [DETECT, ...args],
  { encoding: 'utf8', cwd: opts.cwd || base, env: Object.assign({}, env, opts.env || {}) });
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const COMPOSE_NOTE = /^(compose config failed in [^:]+): .*$/;
const normal = (repo) => repo && Object.assign({}, repo, { notes: (repo.notes || []).map((n) => n.replace(COMPOSE_NOTE, '$1: <message>')) });
const composeCli = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', env }).status === 0;

// Every file and directory under `dir` (the .git directory included) with its size and mtime.
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const f = path.join(d, e), s = fs.lstatSync(f);
      out.push(`${path.relative(dir, f)} ${s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out.join('\n');
}

const outputs = [];
try {
  const all = names();
  ok('twelve fixture repositories, each with its expectation', all.length === 12
    && all.every((n) => fs.existsSync(path.join(__dirname, 'fixtures', 'repos', n + '.expected.json'))), all.join(' '));
  for (const n of all) {
    const dir = build(n, base);
    const usesCompose = JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'repos', n + '.json'), 'utf8')).files))
      .match(/(^|\/|")(docker-)?compose\.ya?ml"/);
    const before = snapshot(dir);
    const r = run(['--root', dir]);
    const j = parse(r.stdout);
    outputs.push([n, r.stdout, j && j.root]);
    ok(`${n}: exit 0, JSON on stdout, root is the repository`, r.status === 0 && j && j.root === dir, `exit ${r.status} ${r.stderr}`);
    if (usesCompose && !composeCli) { skip(`${n}: repo equals ${n}.expected.json`, 'docker compose not found'); continue; }
    const got = JSON.stringify(normal(j && j.repo), null, 2), want = JSON.stringify(expected(n), null, 2);
    ok(`${n}: repo equals ${n}.expected.json`, got === want, `\n--- got\n${got}\n--- want\n${want}`);
    if (n === 'node' || n === 'compose-single') {
      ok(`${n}: read only - files, sizes and mtimes (the .git directory included) unchanged`, snapshot(dir) === before);
      const st = (e) => spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', env: Object.assign({}, env, { GIT_OPTIONAL_LOCKS: '0' }) }).stdout;
      ok(`${n}: read only - git status after equals the fixture as built`, st() === '', st());
    }
    if (n === 'compose-error') {
      ok('compose-error: the failed file keeps the error of compose in its note, the next directory is still read',
        j && j.repo.notes.some((x) => /^compose config failed in a: .*DETECT_FIXTURE_REQUIRED/.test(x)), j && JSON.stringify(j.repo.notes));
    }
    if (n === 'compose-single') {
      // COMPOSE_* variables of the caller would select other files, project or profiles; the repository is read as it is.
      const other = run(['--root', dir], { env: { COMPOSE_PROJECT_NAME: 'elsewhere', COMPOSE_FILE: 'missing.yml', COMPOSE_PROFILES: 'x' } });
      ok('compose-single: COMPOSE_* variables of the environment do not change the output', other.stdout === r.stdout, other.stdout + other.stderr);
    }
    if (n === 'node' || n === 'no-commits' || n === 'not-git') {
      const again = run(['--root', dir]);
      ok(`${n}: a second run gives the same bytes`, again.stdout === r.stdout);
      const ru = run(['--root', dir], { env: { LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', LC_MESSAGES: 'ru_RU.UTF-8' } });
      ok(`${n}: another locale gives the same bytes`, ru.stdout === r.stdout, ru.stdout + ru.stderr);
    }
  }

  // No absolute path except root, no password of a remote URL.
  const leaks = [];
  for (const [n, text, root] of outputs) {
    const rest = text.split('\n').filter((l) => !/^ {2}"root": /.test(l)).join('\n');
    if (root && rest.includes(root)) leaks.push(`${n}: root`);
    if (rest.includes(base) || rest.includes(os.tmpdir())) leaks.push(`${n}: temp path`);
    if (/"\/(Users|home|tmp|private|var)\//.test(rest)) leaks.push(`${n}: absolute path`);
    if (rest.includes('secret')) leaks.push(`${n}: password`);
  }
  ok('no absolute path except root and no URL password in any output', outputs.length === 12 && !leaks.length, leaks.join(', '));

  // Usage and missing paths: one line on stderr, nothing on stdout.
  const one = (r, code) => r.status === code && r.stdout === '' && r.stderr.trim().split('\n').length === 1;
  let r = run(['--root', path.join(base, 'no-such-dir')]);
  ok('--root that does not exist -> 66, one line', one(r, 66) && /no-such-dir/.test(r.stderr), `exit ${r.status} ${r.stderr}`);
  r = run(['--root', path.join(base, 'node', 'package.json')]);
  ok('--root that is a file -> 66, one line', one(r, 66), `exit ${r.status} ${r.stderr}`);
  r = run(['--root']);
  ok('--root without a value -> 64 usage, one line', one(r, 64) && /usage/.test(r.stderr), `exit ${r.status} ${r.stderr}`);
  r = run(['--root', path.join(base, 'node'), 'extra']);
  ok('an extra argument -> 64 usage, one line', one(r, 64) && /usage/.test(r.stderr), `exit ${r.status} ${r.stderr}`);
  r = run(['--bogus']);
  ok('an unknown option -> 64 usage, one line', one(r, 64), `exit ${r.status} ${r.stderr}`);

  // Without --root the current directory is read; inside a subdirectory the repository is its top level.
  const viaRoot = outputs.find(([n]) => n === 'node')[1];
  r = run([], { cwd: path.join(base, 'node') });
  ok('no arguments -> the current directory', r.status === 0 && r.stdout === viaRoot, r.stderr);
  r = run([], { cwd: path.join(base, 'node', 'test') });
  ok('from a subdirectory -> the top level of its repository', r.status === 0 && r.stdout === viaRoot, r.stderr);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
