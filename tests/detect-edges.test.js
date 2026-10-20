#!/usr/bin/env node
'use strict';
// scripts/detect.js, edges the fixture repositories of detect.test.js do not reach (tester, task U4a):
// - a password in a remote URL of any scheme is masked (ssh://, a percent-encoded password), every remote, sorted;
// - a symbolic link loop inside ignored data: the run ends, only regular files are counted, links are not followed;
// - a detached HEAD: head null with its note, exit 0;
// - a repository without commits, with a file name holding a newline: valid JSON, nothing written (.git included);
// - a large output (thousands of ignored directories) reaches a pipe whole;
// - CI is only .github/workflows/*.yml|yaml at the top of the repository (not nested, not in a package, not *.bak).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { gitEnv } = require('./detect-fixtures');

const DETECT = path.join(__dirname, '..', 'scripts', 'detect.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-edges-')));
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
const commit = (dir) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'edge'); };
const run = (dir) => {
  const r = spawnSync(process.execPath, [DETECT, '--root', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* checked by the callers */ }
  return { code: r.status, out: r.stdout, err: r.stderr, j };
};
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const f = path.join(d, e), s = fs.lstatSync(f);
      out.push(`${JSON.stringify(path.relative(dir, f))} ${s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) walk(f);
    }
  };
  walk(dir);
  return out.join('\n');
}

try {
  // Remotes: a password of any URL scheme is masked; a URL without a password is kept as it is.
  let d = repo('remotes', { 'README.md': '# r\n' });
  commit(d);
  git(d, 'remote', 'add', 'origin', 'ssh://bob:pw123@example.com/org/x.git');
  git(d, 'remote', 'add', 'up', 'https://u:p%40ss@example.com/org/x.git');
  git(d, 'remote', 'add', 'plain', 'git@example.com:org/x.git');
  let r = run(d);
  const remote = r.j && r.j.repo.git.remote;
  ok('remotes: exit 0, every remote listed, sorted by name', r.code === 0 && remote
    && JSON.stringify(remote.map((x) => x.name)) === '["origin","plain","up"]', r.out + r.err);
  ok('remotes: an ssh:// password is masked', remote && remote[0].url === 'ssh://bob:***@example.com/org/x.git', JSON.stringify(remote));
  ok('remotes: a percent-encoded password is masked', remote && remote[2].url === 'https://u:***@example.com/org/x.git', JSON.stringify(remote));
  ok('remotes: an scp-like URL without a password is kept', remote && remote[1].url === 'git@example.com:org/x.git', JSON.stringify(remote));
  ok('remotes: no password text anywhere in the output', !/pw123|p%40ss/.test(r.out));

  // Detached HEAD.
  git(d, 'checkout', '-q', '--detach');
  r = run(d);
  ok('detached HEAD: exit 0, head null, branch main still seen', r.code === 0 && r.j && r.j.repo.git.head === null
    && r.j.repo.git.branches.main === true, r.out + r.err);
  ok('detached HEAD: a note says so', r.j && r.j.repo.notes.includes('HEAD is detached - no current branch'), r.j && JSON.stringify(r.j.repo.notes));

  // A symbolic link loop inside ignored data.
  d = repo('loop', { '.gitignore': '/data/\n', 'data/sub/z.bin': 'abc', 'data/y.bin': 'hello' });
  fs.symlinkSync('..', path.join(d, 'data', 'sub', 'up'));
  fs.symlinkSync(path.join(d, 'data', 'y.bin'), path.join(d, 'data', 'link-to-y'));
  commit(d);
  r = run(d);
  ok('symlink loop in ignored data: exit 0, the size counts regular files only (3 + 5 bytes)', r.code === 0 && r.j
    && JSON.stringify(r.j.repo.ignored) === '[{"path":"data/","bytes":8}]', r.out + r.err);

  // No commits, a file name with a newline, read only.
  d = repo('nocommit-nl', { 'package.json': '{"scripts":{"test":"node --test"}}', 'odd dir/new\nline.txt': 'a', '.gitignore': 'cache/\n', 'cache/c.bin': 'abcd' });
  const before = snapshot(d);
  r = run(d);
  ok('no commits, newline in a file name: exit 0, valid JSON', r.code === 0 && r.j !== null, r.out + r.err);
  ok('no commits: commits 0, head main, defaultBranch null', r.j && r.j.repo.git.commits === 0 && r.j.repo.git.head === 'main'
    && r.j.repo.git.defaultBranch === null, r.j && JSON.stringify(r.j.repo.git));
  ok('no commits: the untracked package.json is a stack, the ignored cache has its size', r.j
    && JSON.stringify(r.j.repo.stacks.map((s) => [s.dir, s.kind])) === '[[".","node"]]'
    && JSON.stringify(r.j.repo.ignored) === '[{"path":"cache/","bytes":4}]', r.j && JSON.stringify(r.j.repo));
  ok('no commits: read only - files, sizes and mtimes (the .git directory included) unchanged', snapshot(d) === before);

  // A large output reaches a pipe whole.
  const many = {};
  let ign = '';
  for (let i = 0; i < 3000; i++) { many[`big${i}/f`] = 'x'; ign += `big${i}/\n`; }
  d = repo('large', Object.assign({ '.gitignore': ign, 'README.md': '# l\n' }, many));
  r = run(d);
  ok('large output: exit 0, the whole JSON reaches the pipe (3000 ignored entries)', r.code === 0 && r.j
    && r.j.repo.ignored.length === 3000 && r.out.length > 65536, `exit ${r.code}, ${r.out.length} bytes`);

  // CI: only the top-level .github/workflows/*.yml|yaml of the repository.
  d = repo('ci', {
    '.github/workflows/a.yml': 'on: push\n', '.github/workflows/b.yaml': 'on: push\n', '.github/workflows/c.yml.bak': 'x\n',
    '.github/workflows/nested/d.yml': 'on: push\n', 'packages/p/.github/workflows/e.yml': 'on: push\n',
  });
  commit(d);
  r = run(d);
  ok('ci: only top-level workflow files, sorted', r.code === 0 && r.j
    && JSON.stringify(r.j.repo.ci) === '[{"file":".github/workflows/a.yml"},{"file":".github/workflows/b.yaml"}]', r.j && JSON.stringify(r.j.repo.ci));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
done();
