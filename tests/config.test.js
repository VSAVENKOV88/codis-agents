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
ok('preconditions defaults: 10 GB of disk, 4 GB of swap', (() => { const x = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' }).config.preconditions; return x.minFreeDiskGB === 10 && x.minSwapGB === 4; })());
bad0({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', preconditions: { minFreeDiskGB: -1 } }, /preconditions\.minFreeDiskGB: expected a number >= 0/, 'negative disk floor - error');
bad0({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', preconditions: { minSwap: 1 } }, /preconditions\.minSwap: unknown key/, 'unknown preconditions key - error');
ok('schema roleNotes keys = roles', same(Object.keys(schema.properties.roleNotes.properties), C.ROLES));
ok('schema required = config.js required', same(schema.required, ['repoDir', 'worktreeRoot', 'sharedDir']));

r = C.resolve({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s' });
ok('minimal config: defaults', r.errors.length === 0 && r.config.slots.medium === 2 && r.config.slots.heavy === 2 && r.config.slots.total === 4
  && r.config.reportLanguage === 'English' && r.config.protectedBranches.join() === 'main', r.errors.join('; '));
const bad = (raw, re, name) => { const x = C.resolve(raw); ok(name, x.errors.some((e) => re.test(e)), x.errors.join('; ')); };
bad({ worktreeRoot: '/w', sharedDir: '/s' }, /repoDir: required/, 'missing repoDir - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slotz: {} }, /slotz: unknown key/, 'unknown key (typo) - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slots: { heavy: '2' } }, /slots.heavy: expected number/, 'wrong type - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', slots: { heavy: 0 } }, /slots.heavy: expected a positive integer/, 'zero slots - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'npm test' }, /guardCommand: must contain \{wt\}/, 'guard command without {wt} - error');
bad({ repoDir: '/r', worktreeRoot: '/w', sharedDir: '/s', guardCommand: 'cd {wt} && npm test' }, /must contain \{jobs\}/, 'guard command without {jobs} - error');
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
  { cwd, encoding: 'utf8', env: Object.assign({ HOME: os.homedir(), PATH: process.env.PATH }, env) });
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
    const z = spawnSync('zsh', ['-c', sh + '\nprint -r -- "$SLOTS_DIR|$CODIS_SHARED_DIR|$SLOT_HEAVY_N|${+SLOT_LEGACY_LOCK}"'], { encoding: 'utf8', env: { HOME: os.homedir(), PATH: process.env.PATH } });
    ok('shell output: quoted values, ~ expanded, empty values defined', z.stdout.trim() === `${os.homedir()}/x|${path.join(dir, "it's shared")}|2|1`, z.stdout + z.stderr);
    const z2 = spawnSync('zsh', ['-c', sh + '\nprint -r -- $SLOTS_DIR'], { encoding: 'utf8', env: { HOME: os.homedir(), PATH: process.env.PATH, SLOTS_DIR: '/env' } });
    ok('shell output: the environment wins over the config', z2.stdout.trim() === '/env', z2.stdout);
  }
  ok('check: exit 0 on the example', cli(['check', path.join(ROOT, 'examples', 'codis-agents.example.json')], dir).status === 0);
  const j = JSON.parse(cli(['json'], sub).stdout);
  ok('json: plugin paths added for the workflow', j.scriptsDir === path.join(ROOT, 'scripts') && j.pluginRoot === ROOT && j.configPath, JSON.stringify(j).slice(0, 200));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
