#!/usr/bin/env node
'use strict';
// scripts/guards-select.js: the guards a programmer runs instead of the full suite - the changed guards, the guards that
// import a changed file, the guards that mention a changed file (its path, or its name without the extension), and the
// guards named by guardAlways; guard files are found by the config key guardFiles (default *-run.js|mjs|cjs at any
// depth). Changed = committed since the merge-base with --base, uncommitted and untracked. --command fills the project's
// guardSubsetCommand ({wt}, {onlyArgs} = --only <guard> per guard); nothing selected -> exit 3; no command -> exit 78.
// Why (measurement of 2026-10-20): selection by imports alone caught 1 of 6 product regressions found by full runs,
// imports plus mentions of the changed file's name caught all of them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const S = path.join(__dirname, '..', 'scripts', 'guards-select.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guards-select-')));
const repo = path.join(tmp, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
const cfgFile = path.join(tmp, 'cfg.json');
const writeCfg = (extra) => fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ repoDir: repo, worktreeRoot: tmp, sharedDir: path.join(tmp, 's') }, extra)));
const sel = (...a) => {
  const r = spawnSync(process.execPath, [S, '--wt', repo, '--config', cfgFile, ...a], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split('\n').filter(Boolean) };
};
const json = (...a) => { const r = sel('--json', ...a); try { return Object.assign(JSON.parse(r.out), { _code: r.code }); } catch { return { _code: r.code, _err: r.err + r.out }; } };
const names = (j) => (j.guards || []).map((g) => g.path).sort();
try {
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'noreply@example.com'); git('config', 'user.name', 't');
  put('src/frame/frameModel.js', 'module.exports = 1;\n');
  put('src/util.js', 'module.exports = 2;\n');
  put('src/other.js', 'module.exports = 3;\n');
  put('src/frame/model-import-run.js', "const m = require('./frameModel');\nprocess.exit(m ? 0 : 1);\n");
  put('tests/esm-run.mjs', "import u from '../src/util.js';\nconsole.log(u);\n");
  put('tests/mention-run.js', "// reads src/frame/frameModel.js as text\nconst f = 'frameModel';\n");
  put('tests/path-run.cjs', "const p = 'src/other.js';\n");
  put('tests/unrelated-run.js', "console.log('framemodelish otherwise');\n");
  put('tests/semgrep-diff-run.js', "// scans the diff\n");
  put('tests/helper.js', "module.exports = 'not a guard';\n");
  put('checks/a.check.js', "require('../src/util');\n");
  put('docs/notes.md', 'frameModel\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'task');

  writeCfg({});
  let j = json('--base', 'main');
  ok('no change -> no guard selected', j._code === 0 && names(j).length === 0, JSON.stringify(j));

  put('src/frame/frameModel.js', 'module.exports = 11;\n');
  git('add', 'src/frame/frameModel.js'); git('commit', '-qm', 'change model');
  j = json('--base', 'main');
  ok('a committed change: the guard importing it and the guard naming it are selected',
    names(j).join() === ['src/frame/model-import-run.js', 'tests/mention-run.js'].join(), JSON.stringify(names(j)));
  const why = Object.fromEntries((j.guards || []).map((g) => [g.path, g.why.join('; ')]));
  ok('why: imports for the importing guard, mentions for the naming one',
    /imports src\/frame\/frameModel\.js/.test(why['src/frame/model-import-run.js'] || '') && /mentions src\/frame\/frameModel\.js/.test(why['tests/mention-run.js'] || ''), JSON.stringify(why));
  ok('a name that is only a part of a longer word does not count (framemodelish, other case)', !names(j).includes('tests/unrelated-run.js'));
  ok('the result names the base, the merge-base and the changed files', j.base === 'main' && /^[0-9a-f]{40}$/.test(j.mergeBase || '') && (j.changed || []).join() === 'src/frame/frameModel.js', JSON.stringify(j));

  put('src/util.js', 'module.exports = 22;\n');
  j = json('--base', 'main');
  ok('an uncommitted change counts: the ESM guard importing ../src/util.js is selected', names(j).includes('tests/esm-run.mjs'), JSON.stringify(names(j)));
  ok('a file that is not a guard by guardFiles is never selected (checks/a.check.js, tests/helper.js)', !names(j).some((n) => /a\.check|helper/.test(n)), JSON.stringify(names(j)));
  git('checkout', '-q', '--', 'src/util.js');

  put('src/other.js', 'module.exports = 33;\n');
  j = json('--base', 'main');
  ok('a guard naming the changed file by its path is selected', names(j).includes('tests/path-run.cjs'), JSON.stringify(names(j)));
  git('checkout', '-q', '--', 'src/other.js');

  put('tests/new-run.js', 'process.exit(0);\n');
  j = json('--base', 'main');
  ok('a new untracked guard is selected itself', names(j).includes('tests/new-run.js') && /changed/.test((j.guards.find((g) => g.path === 'tests/new-run.js') || { why: [] }).why.join()), JSON.stringify(j.guards));
  fs.rmSync(path.join(repo, 'tests/new-run.js'));

  writeCfg({ guardAlways: ['semgrep-diff'] });
  j = json('--base', 'main');
  ok('guardAlways: a guard whose path contains the entry is always selected', names(j).includes('tests/semgrep-diff-run.js')
    && /always semgrep-diff/.test((j.guards.find((g) => g.path === 'tests/semgrep-diff-run.js') || { why: [] }).why.join()), JSON.stringify(j.guards));

  writeCfg({ guardFiles: ['checks/*.check.js'] });
  put('src/util.js', 'module.exports = 222;\n');
  j = json('--base', 'main');
  ok('guardFiles: the project glob decides what a guard is', names(j).join() === 'checks/a.check.js', JSON.stringify(names(j)));
  git('checkout', '-q', '--', 'src/util.js');

  writeCfg({});
  let r = sel('--base', 'main');
  ok('plain output: one guard path per line', r.code === 0 && r.lines.join() === ['src/frame/model-import-run.js', 'tests/mention-run.js'].join(), r.out + r.err);
  r = sel('--base', 'main', '--command');
  ok('--command without guardSubsetCommand -> exit 78 and the reason', r.code === 78 && /guardSubsetCommand/.test(r.err), r.out + r.err);

  writeCfg({ guardSubsetCommand: 'cd {wt}/server && npm run guards -- --all {onlyArgs}' });
  r = sel('--base', 'main', '--command');
  ok('--command fills {wt} and {onlyArgs} (one quoted --only per guard)',
    r.code === 0 && r.out.trim() === `cd '${repo}'/server && npm run guards -- --all --only 'src/frame/model-import-run.js' --only 'tests/mention-run.js'`, r.out + r.err);
  git('checkout', '-q', 'main');
  r = sel('--base', 'main', '--command');
  ok('--command with nothing selected -> exit 3, no command (an empty --only list would run everything)', r.code === 3 && r.out.trim() === '', r.out + r.err);
  git('checkout', '-q', 'task');

  r = sel('--base', 'no-such-ref');
  ok('an unknown base -> exit 2 with the reason', r.code === 2 && /no-such-ref/.test(r.err), r.out + r.err);
  writeCfg({ protectedBranches: ['main'] });
  j = json();
  ok('without --base: the merge-base with the first protected branch', j._code === 0 && j.base === 'main' && names(j).length === 2, JSON.stringify(j));
  writeCfg({ guardSubsetCommand: 'npm run guards {wt}' });
  r = sel('--base', 'main');
  ok('a config whose guardSubsetCommand lacks {onlyArgs} does not validate -> exit 78', r.code === 78 && /\{onlyArgs\}/.test(r.err), r.out + r.err);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
done();
