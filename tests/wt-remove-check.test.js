#!/usr/bin/env node
'use strict';
// Before a worktree or a data directory is removed, the owner sees what goes with it and says "yes" to that list:
// ignored data inside with sizes, the path named in the project's code, and symbolic links from outside that lead into
// it. `git status --porcelain` alone shows none of these. scripts/wt-remove-check.js prints the list and removes nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ');
const RULES = 'rules/multi-agent.md', COORD = 'skills/coordinator/SKILL.md', README = 'README.md';

// The rule, where the coordinator and the reader find it.
for (const f of [RULES, COORD, README]) {
  ok(`${f}: names scripts/wt-remove-check.js`, /wt-remove-check\.js/.test(read(f)));
}
for (const f of [RULES, COORD]) {
  ok(`${f}: before removing a worktree or a data directory, the owner says "yes" to the list`,
    /[Bb]efore removing a worktree or a data directory[^.]*"yes"/.test(read(f)));
  ok(`${f}: ignored data with sizes`, /ignored data[^.]*sizes/.test(read(f)));
  ok(`${f}: symbolic links that lead into the path`, /symbolic links[^.]*lead into/.test(read(f)));
}
ok(`${RULES}: git status --ignored and du named`, /git status --ignored --porcelain[^.]*du/.test(read(RULES)));
ok(`${RULES}: find -type l and readlink named`, /find -type l[^.]*readlink/.test(read(RULES)));
ok(`${RULES}: why - git status --porcelain alone does not show ignored files`, /does not show ignored files/.test(read(RULES)));
ok(`${README}: failures table row`, /\| [^|]*only copy[^|]*\| [^|]*wt-remove-check\.js/.test(read(README)));

// The script on a temporary repository.
const SCRIPT = path.join(ROOT, 'scripts', 'wt-remove-check.js');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-')));
const main = path.join(dir, 'main'), wt = path.join(dir, 'wts', 't1');
const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
try {
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main'); g(main, 'config', 'user.email', 't@t'); g(main, 'config', 'user.name', 't');
  put(path.join(main, '.gitignore'), 'store/\n*.log\n'); put(path.join(main, 'src.js'), '1');
  g(main, 'add', '.gitignore', 'src.js'); g(main, 'commit', '-qm', 'base');
  fs.mkdirSync(path.join(dir, 'wts'));
  g(main, 'worktree', 'add', '-q', '-b', 'b-t1', wt);
  // Ignored data in the worktree: the only copy of a corpus.
  put(path.join(wt, 'store', 'corpus.bin'), Buffer.alloc(300 * 1024, 1));
  put(path.join(wt, 'run.log'), 'x');
  // The main checkout's code names the worktree path as a fallback (tracked), and a link outside leads into it.
  put(path.join(main, 'guard.js'), `const FALLBACK = '${wt}/store';\n`); g(main, 'add', 'guard.js'); g(main, 'commit', '-qm', 'guard');
  put(path.join(dir, 'other', 'keep.txt'), 'k');
  fs.symlinkSync(path.join(wt, 'store'), path.join(dir, 'other', 'store-link'));
  fs.symlinkSync('../wts/t1/run.log', path.join(dir, 'other', 'rel-link'));
  fs.symlinkSync(path.join(main, 'src.js'), path.join(dir, 'other', 'unrelated-link'));
  // A link inside the worktree goes with it and is not a reference from outside.
  fs.symlinkSync(path.join(wt, 'store'), path.join(wt, 'inner-link'));

  const clean = g(wt, 'status', '--porcelain').stdout;
  ok('precondition: git status --porcelain of the worktree shows nothing of the corpus', !/store/.test(clean), clean);

  const before = fs.readdirSync(wt).sort().join(',');
  const r = run(wt, '--search', dir);
  const out = r.stdout;
  ok('the script exits 0', r.status === 0, r.stdout + r.stderr);
  ok('ignored directory listed', /store\//.test(out), out);
  ok('ignored file listed', /run\.log/.test(out), out);
  ok('ignored directory shown with its size (KB)', /\b3\d\d KB\b[^\n]*store\/|store\/[^\n]*\b3\d\d KB\b/.test(out), out);
  ok('code reference listed: file and the line naming the path', /guard\.js:1/.test(out), out);
  ok('absolute link from outside listed with its target', out.includes(path.join(dir, 'other', 'store-link')) && out.includes(path.join(wt, 'store')), out);
  ok('relative link from outside listed', out.includes(path.join(dir, 'other', 'rel-link')), out);
  ok('a link that does not lead into the path is not listed', !out.includes('unrelated-link'), out);
  const links = out.slice(out.indexOf('\n3. '));
  ok('a link inside the path goes with it: not among the links from outside', links.length > 4 && !links.includes('inner-link'), out);
  ok('nothing removed', fs.existsSync(path.join(wt, 'store', 'corpus.bin')) && fs.readdirSync(wt).sort().join(',') === before);

  // A data directory outside any git repository: everything in it is listed with sizes.
  const data = path.join(dir, 'loose');
  put(path.join(data, 'a.bin'), Buffer.alloc(20 * 1024, 1));
  const r2 = run(data, '--search', dir);
  ok('a path outside git: its contents listed with sizes', r2.status === 0 && /not in a git repository/.test(r2.stdout) && /\b2\d KB\b[^\n]*a\.bin/.test(r2.stdout), r2.stdout + r2.stderr);

  const r3 = run(path.join(dir, 'missing'));
  ok('a missing path is an error, exit 2', r3.status === 2, r3.stdout + r3.stderr);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
