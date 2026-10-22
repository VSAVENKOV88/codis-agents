#!/usr/bin/env node
'use strict';
// scripts/config.js: the example validates; the JSON schema and the code know the same keys; required keys, types,
// unknown keys and guard command placeholders are checked; ~ is expanded; lookup order; shell output for the slots.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../scripts/config');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'codis-agents.example.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents.schema.json'), 'utf8'));

const bad0 = (raw, re, name) => { const x = C.resolve(raw); ok(name, x.errors.some((e) => re.test(e)), x.errors.join('; ')); };
let r = C.resolve(example);
ok('example config validates', r.errors.length === 0, r.errors.join('; '));
ok('~ expanded in paths', r.config.repoDir === path.join(os.homedir(), 'dev/my-app') && r.config.slots.lockDir.startsWith(os.homedir()), r.config.repoDir);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
ok('schema top-level keys = config.js keys', same(Object.keys(schema.properties), Object.keys(C.SPEC)), Object.keys(schema.properties).join());
ok('schema slots keys = config.js', same(Object.keys(schema.properties.slots.properties), Object.keys(C.SLOT_SPEC)));
ok('schema worktreeSetup keys = config.js', same(Object.keys(schema.properties.worktreeSetup.properties), Object.keys(C.WT_SPEC)));
ok('schema gitHooks keys = config.js', same(Object.keys(schema.properties.gitHooks.properties), Object.keys(C.HOOKS_SPEC)));
ok('schema standingPush keys = config.js', schema.properties.standingPush && same(Object.keys(schema.properties.standingPush.properties), Object.keys(C.STANDING_SPEC || {})));
ok('schema standingPush says it is only for the process-rules repository', schema.properties.standingPush && /only for the repository of process rules/.test(schema.properties.standingPush.description));
ok('schema preconditions keys = config.js', schema.properties.preconditions && same(Object.keys(schema.properties.preconditions.properties), Object.keys(C.PRE_SPEC || {})));
ok('preconditions defaults (no machine file): 10 GB of disk, swapMinMB 4000', (() => { const x = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' }).config.preconditions; return x.minFreeDiskGB === 10 && x.swapMinMB === 4000; })());
bad0({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', featureIELimit: 0 }, /featureIELimit: expected a positive number/, 'featureIELimit 0 - error');
ok('featureIELimit defaults to null (3 x medianTaskIE in chain-cost)', C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' }).config.featureIELimit === null);
// roleModel / roleModels (owner 2026-10-22): the model of the role agents, an alias the Workflow agent() accepts.
const base0 = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
r = C.resolve(Object.assign({}, base0, { roleModel: 'opus', roleModels: { reviewer: 'sonnet', wait: 'haiku', preconditions: 'haiku', 'security-reviewer': 'fable' } }));
ok('roleModel "opus" and roleModels per role validate and pass through', r.errors.length === 0 && r.config.roleModel === 'opus' && r.config.roleModels.reviewer === 'sonnet' && r.config.roleModels.wait === 'haiku', r.errors.join('; '));
r = C.resolve(base0);
ok('no roleModel: empty (no model passed), roleModels empty', r.errors.length === 0 && r.config.roleModel === '' && JSON.stringify(r.config.roleModels) === '{}', JSON.stringify([r.config.roleModel, r.config.roleModels]));
bad0(Object.assign({}, base0, { roleModel: 'gpt-5' }), /roleModel: .*one of sonnet, opus, haiku, fable/, 'roleModel not an alias - error');
bad0(Object.assign({}, base0, { roleModel: 'Opus' }), /roleModel: /, 'roleModel with another case - error');
bad0(Object.assign({}, base0, { roleModel: 5 }), /roleModel: expected string/, 'roleModel not a string - error');
bad0(Object.assign({}, base0, { roleModels: { reviewer: 'claude-opus' } }), /roleModels\.reviewer: .*one of sonnet, opus, haiku, fable/, 'roleModels value not an alias - error');
bad0(Object.assign({}, base0, { roleModels: { coordinator: 'fable' } }), /roleModels\.coordinator: unknown role/, 'roleModels unknown role - error');
bad0(Object.assign({}, base0, { roleModels: 'opus' }), /roleModels: expected object/, 'roleModels not an object - error');
ok('schema roleModel enum = config.js aliases', schema.properties.roleModel && same(schema.properties.roleModel.enum || [], C.MODEL_ALIASES || []));
ok('schema roleModels keys = config.js roles', schema.properties.roleModels && same(Object.keys(schema.properties.roleModels.properties), C.MODEL_ROLES || [])
  && Object.values(schema.properties.roleModels.properties).every((p) => same(p.enum || [], C.MODEL_ALIASES || [])));
bad0({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', preconditions: { minFreeDiskGB: -1 } }, /preconditions\.minFreeDiskGB: expected a number >= 0/, 'negative disk floor - error');
bad0({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', preconditions: { minSwap: 1 } }, /preconditions\.minSwap: unknown key/, 'unknown preconditions key - error');
// The shared stand of a project (scripts/stand.sh): a section of command templates the plugin only calls.
ok('schema stand keys = config.js', schema.properties.stand && same(Object.keys(schema.properties.stand.properties), Object.keys(C.STAND_SPEC || {})));
ok('schema stand required = config.js', schema.properties.stand && same(schema.properties.stand.required || [], C.STAND_REQUIRED || []));
const STAND = { project: 'p-dev', ports: [3101], up: 'up {project}', deploy: 'deploy {project} {wt}', reset: 'reset {project}', status: 'status {project}', down: 'down {project}', imageFiles: ['Dockerfile*'], memLimitMB: 3072 };
const withStand = (s) => ({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', stand: s });
r = C.resolve(withStand(STAND));
ok('stand section validates', r.errors.length === 0 && r.config.stand.project === 'p-dev' && r.config.stand.ports.join() === '3101', r.errors.join('; '));
ok('no stand section -> stand is null', C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' }).config.stand === null);
bad0(withStand(Object.assign({}, STAND, { bogus: 1 })), /stand\.bogus: unknown key/, 'unknown stand key - error');
bad0(withStand(Object.assign({}, STAND, { deploy: 'deploy {project}' })), /stand\.deploy: must contain \{wt\}/, 'stand deploy without {wt} - error');
bad0(withStand(Object.assign({}, STAND, { status: undefined })), /stand\.status: required/, 'stand without status - error');
bad0(withStand(Object.assign({}, STAND, { project: undefined })), /stand\.project: required/, 'stand without project - error');
bad0(withStand(Object.assign({}, STAND, { project: 'Bad Name' })), /stand\.project: /, 'stand project not a compose project name - error');
bad0(withStand(Object.assign({}, STAND, { ports: [0] })), /stand\.ports: /, 'stand port 0 - error');
bad0(withStand(Object.assign({}, STAND, { memLimitMB: -1 })), /stand\.memLimitMB: /, 'negative stand memory limit - error');
// The stand may not be the owner's own stack: roles reset and redeploy it.
bad0(Object.assign(withStand(STAND), { ownerStackReadOnly: 'p-dev' }), /stand\.project: .*owner's stack/, 'stand project = the owner\'s stack - error');
// stand.cwd (owner 2026-10-21): the directory the stand's commands run in; absolute or ~, it must exist; without the
// key it stays empty and stand.sh runs them in repoDir.
ok('stand.cwd defaults to empty (stand.sh then uses repoDir)', C.resolve(withStand(STAND)).config.stand.cwd === '');
{
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.codis-cwd-test-')));
  try {
    r = C.resolve(withStand(Object.assign({}, STAND, { cwd: home })));
    ok('stand.cwd: an existing absolute directory validates', r.errors.length === 0 && r.config.stand.cwd === home, r.errors.join('; '));
    const tilde = '~/' + path.relative(os.homedir(), home);
    r = C.resolve(withStand(Object.assign({}, STAND, { cwd: tilde })));
    ok('stand.cwd: ~ is expanded', r.errors.length === 0 && r.config.stand.cwd === home, r.errors.join('; ') + ' ' + (r.config.stand && r.config.stand.cwd));
    bad0(withStand(Object.assign({}, STAND, { cwd: path.join(home, 'missing') })), /stand\.cwd: .*missing does not exist/, 'stand.cwd that does not exist - error naming it');
    fs.writeFileSync(path.join(home, 'file'), '');
    bad0(withStand(Object.assign({}, STAND, { cwd: path.join(home, 'file') })), /stand\.cwd: .*not a directory/, 'stand.cwd that is a file - error');
    bad0(withStand(Object.assign({}, STAND, { cwd: 'relative/dir' })), /stand\.cwd: .*absolute/, 'stand.cwd relative - error (absolute or ~)');
    bad0(withStand(Object.assign({}, STAND, { cwd: 3 })), /stand\.cwd: expected path/, 'stand.cwd not a string - error');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
// A project's real config shape (all its sections, plus stand) passes check from the command line (B11).
const fixture = path.join(ROOT, 'tests', 'fixtures', 'project-with-stand.json');
const chk = spawnSync('node', [path.join(ROOT, 'scripts', 'config.js'), 'check', fixture], { encoding: 'utf8' });
ok('a project config with a stand section passes config.js check', chk.status === 0, chk.stdout + chk.stderr);
ok('the example config has a stand section', !!example.stand && C.resolve(example).config.stand.project === example.stand.project);
ok('schema roleNotes keys = roles', same(Object.keys(schema.properties.roleNotes.properties), C.ROLES));
ok('schema required = config.js required', same(schema.required, ['repoDir', 'worktreeRoot', 'sharedDir']));

r = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' });
ok('minimal config: defaults', r.errors.length === 0 && r.config.slots.medium === 2 && r.config.slots.heavy === 2 && r.config.slots.total === 4
  && r.config.reportLanguage === 'English' && r.config.protectedBranches === null && r.config.defaultBranch === '', r.errors.join('; '));
const bad = (raw, re, name) => { const x = C.resolve(raw); ok(name, x.errors.some((e) => re.test(e)), x.errors.join('; ')); };
bad({ worktreeRoot: '/w', sharedDir: '/s' }, /repoDir: required/, 'missing repoDir - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slotz: {} }, /slotz: unknown key/, 'unknown key (typo) - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slots: { heavy: '2' } }, /slots.heavy: expected number/, 'wrong type - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slots: { heavy: 0 } }, /slots.heavy: expected a positive integer/, 'zero slots - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'npm test' }, /guardCommand: must contain \{wt\}/, 'guard command without {wt} - error');
// {jobs} is optional (U2b-2, A1-A3): a runner that sets its own workers is counted as the whole budget by guards-all.sh.
const B = { repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' };
const good = (raw, name) => { const x = C.resolve(raw); ok(name, x.errors.length === 0, x.errors.join('; ')); return x.config; };
good(Object.assign({}, B, { guardCommand: 'cd {wt} && pytest -q -rf' }), 'A1. guardCommand with {wt} and without {jobs} - ok');
bad(Object.assign({}, B, { guardCommand: 'pytest -q' }), /guardCommand: must contain \{wt\}/, 'A2. guardCommand without {wt} - still an error');
good(Object.assign({}, B, { guardCommand: 'cd {wt} && run --limit-file {limitFile}', guardCommandLegacy: 'cd {wt} && pytest -q' }), 'A3. guardCommandLegacy without {jobs} - ok');
// guardExclusive {glob, marker} (D1, D6): without the key the current default; with it both are required.
let gx = good(Object.assign({}, B), 'D1. no guardExclusive - ok');
ok('D1. ... default: *-run.js and *-run.mjs with the marker //', gx.guardExclusive && gx.guardExclusive.glob.join() === '*-run.js,*-run.mjs' && gx.guardExclusive.marker === '//', JSON.stringify(gx.guardExclusive));
gx = good(Object.assign({}, B, { guardExclusive: { glob: ['test_*.py', '*_test.py'], marker: '#' } }), 'D2. guardExclusive {glob: [test_*.py, *_test.py], marker: #} - ok');
ok('D2. ... kept as given', !!(gx && gx.guardExclusive) && gx.guardExclusive.glob.join() === 'test_*.py,*_test.py' && gx.guardExclusive.marker === '#', JSON.stringify(gx.guardExclusive));
// slots.zsh matches ${a:t} == ${~g} under extendedglob: a glob zsh cannot compile aborted heavy.sh with exit 1
// ("bad pattern"), a false red instead of a config refusal (review 1 of U2b-2). The check needs zsh; without it
// nothing is refused (slots.zsh cannot run there either).
const ZSH_GLOB = [
  [{ glob: ['test_[.py'], marker: '#' }, /guardExclusive\.glob: not a valid zsh pattern.*test_\[\.py/, 'glob with an unclosed ['],
  [{ glob: ['test_*.py', 'test_(.py'], marker: '#' }, /guardExclusive\.glob: not a valid zsh pattern.*test_\(\.py/, 'second glob with an unclosed ('],
  [{ glob: ['#'], marker: '#' }, /guardExclusive\.glob: not a valid zsh pattern/, 'glob # (extendedglob: a repetition of nothing)'],
];
if (!has('zsh')) {
  for (const [, , n] of ZSH_GLOB) skip(`D6. guardExclusive ${n} - error`, 'zsh not found');
  skip('D6. [test_[.py, test_*.py, x(]: exactly the two bad globs are named', 'zsh not found');
  good(Object.assign({}, B, { guardExclusive: { glob: ['test_[.py'], marker: '#' } }), 'D6. without zsh a glob is not compiled here - ok (slots.zsh cannot run either)');
} else {
  for (const [v, re, n] of ZSH_GLOB) bad(Object.assign({}, B, { guardExclusive: v }), re, `D6. guardExclusive ${n} - error`);
  { // survivor M4 of U2b-2 review 1: one zsh call for all globs - a bad one must not take the good ones after it down
    const x = C.resolve(Object.assign({}, B, { guardExclusive: { glob: ['test_[.py', 'test_*.py', 'x('], marker: '#' } }));
    const named = x.errors.filter((e) => /not a valid zsh pattern/.test(e));
    ok('D6. [test_[.py, test_*.py, x(]: exactly the two bad globs are named, not test_*.py after the first', named.length === 2 && !named.some((e) => e.includes('test_*.py')) && named.some((e) => e.includes('"x("')), named.join('; '));
  }
  good(Object.assign({}, B, { guardExclusive: { glob: ['*-run.js', '(a|b)_test.py', '^x*', 'test_[ab].py'], marker: '//' } }), 'D2. zsh patterns that compile ((a|b), ^, [ab]) - ok');
}
for (const [v, re, n] of [
  [{ glob: 'test_*.py', marker: '#' }, /guardExclusive\.glob: expected string\[\]/, 'glob not a list'],
  [{ glob: [], marker: '#' }, /guardExclusive\.glob: /, 'empty glob list'],
  [{ glob: [''], marker: '#' }, /guardExclusive\.glob: /, 'empty glob'],
  [{ glob: ['tests/test_*.py'], marker: '#' }, /guardExclusive\.glob: .*file name/, 'glob with a slash (it matches the file name)'],
  [{ glob: ['test_*.py'], marker: '' }, /guardExclusive\.marker: /, 'empty marker'],
  [{ glob: ['test_*.py'], marker: ' # ' }, /guardExclusive\.marker: /, 'marker with blanks'],
  [{ glob: ['test_*.py'] }, /guardExclusive\.marker: required/, 'marker missing'],
  [{ marker: '#' }, /guardExclusive\.glob: required/, 'glob missing'],
  [{ glob: ['test_*.py'], marker: 1 }, /guardExclusive\.marker: expected string/, 'marker not a string'],
  [{ glob: ['test_*.py'], marker: '#', reason: 'x' }, /guardExclusive\.reason: unknown key/, 'unknown key'],
  ['#', /guardExclusive: expected object/, 'not an object'],
]) bad(Object.assign({}, B, { guardExclusive: v }), re, `D6. guardExclusive ${n} - error`);
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardAdaptiveProbe: { file: 'a', contains: 'b' } }, /needs guardCommandLegacy/, 'probe without a legacy command - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', roleNotes: { coder: 'x' } }, /roleNotes.coder: unknown role/, 'notes for an unknown role - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', standingPush: { branches: ['main'] } }, /standingPush: branches and check are required/, 'standingPush without a check - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', standingPush: { branches: [], check: 'true' } }, /standingPush: branches and check are required/, 'standingPush with no branches - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', standingPush: { branches: ['main'], check: 'true', tags: true } }, /standingPush.tags: unknown key/, 'standingPush never takes tags - error');
// The plugin repository itself declares the standing permission, gated by its hygiene test.
const own = C.resolve(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'codis-agents.json'), 'utf8')));
ok('own .claude/codis-agents.json validates', own.errors.length === 0, own.errors.join('; '));
ok('own config: standing push to main only, gated by tests/hygiene.test.js', own.config.standingPush && own.config.standingPush.branches.join() === 'main'
  && own.config.standingPush.check === 'node tests/hygiene.test.js', JSON.stringify(own.config.standingPush));
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', testerWritable: ['('] }, /bad regular expression/, 'bad regular expression - error');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
const cli = (args, cwd, env = {}) => spawnSync('node', [path.join(ROOT, 'scripts', 'config.js'), ...args],
  { cwd, encoding: 'utf8', env: Object.assign({ HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH }, env) });
try {
  const proj = path.join(dir, 'proj'), sub = path.join(proj, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'));
  fs.writeFileSync(path.join(proj, '.claude', 'codis-agents.json'), JSON.stringify({ repoDir: proj, worktreeRoot: dir, sharedDir: path.join(dir, "it's shared"), slots: { lockDir: '~/x' } }));
  ok('lookup: nearest .claude/codis-agents.json upwards', cli(['path'], sub).stdout.trim() === fs.realpathSync(path.join(proj, '.claude', 'codis-agents.json')) || cli(['path'], sub).stdout.trim() === path.join(proj, '.claude', 'codis-agents.json'), cli(['path'], sub).stdout);
  const other = path.join(dir, 'other.json'); fs.writeFileSync(other, JSON.stringify({ repoDir: '/o', worktreeRoot: '/o', sharedDir: '/o' }));
  ok('lookup: CODIS_AGENTS_CONFIG wins', cli(['get', 'repoDir'], sub, { CODIS_AGENTS_CONFIG: other }).stdout.trim() === '/o');
  ok('lookup: CLAUDE_PROJECT_DIR before the working directory', cli(['get', 'repoDir'], dir, { CLAUDE_PROJECT_DIR: proj }).stdout.trim() === proj);
  // a linked worktree without the (uncommitted) config finds the one of the main checkout
  spawnSync('git', ['init', '-q', proj]); spawnSync('git', ['-C', proj, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const wt = path.join(dir, 'wt'); spawnSync('git', ['-C', proj, 'worktree', 'add', '-q', wt]);
  ok('lookup: linked worktree -> config of the main checkout', cli(['get', 'repoDir'], wt).stdout.trim() === proj, cli(['get', 'repoDir'], wt).stderr);
  ok('no config anywhere -> exit 1 with a message', (() => { const x = cli(['path'], os.tmpdir()); return x.status === 1 && /no \.claude\/codis-agents\.json/.test(x.stderr); })());
  const sh = cli(['shell'], sub).stdout;
  if (!has('zsh')) {
    skip('shell output: quoted values, ~ expanded, empty values defined', 'zsh not found');
    skip('shell output: the environment wins over the config', 'zsh not found');
  } else {
    const z = spawnSync('zsh', ['-c', sh + '\nprint -r -- "$SLOTS_DIR|$CODIS_SHARED_DIR|$SLOT_HEAVY_N|${+SLOT_LEGACY_LOCK}"'], { encoding: 'utf8', env: { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH } });
    ok('shell output: quoted values, ~ expanded, empty values defined', z.stdout.trim() === `${os.homedir()}/x|${path.join(dir, "it's shared")}|2|1`, z.stdout + z.stderr);
    const z2 = spawnSync('zsh', ['-c', sh + '\nprint -r -- $SLOTS_DIR'], { encoding: 'utf8', env: { HOME: os.homedir(), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH, SLOTS_DIR: '/env' } });
    ok('shell output: the environment wins over the config', z2.stdout.trim() === '/env', z2.stdout);
  }
  ok('check: exit 0 on the example', cli(['check', path.join(ROOT, 'examples', 'codis-agents.example.json')], dir).status === 0);
  const j = JSON.parse(cli(['json'], sub).stdout);
  ok('json: plugin paths added for the workflow', j.scriptsDir === path.join(ROOT, 'scripts') && j.pluginRoot === ROOT && j.configPath, JSON.stringify(j).slice(0, 200));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
