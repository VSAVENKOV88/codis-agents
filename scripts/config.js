#!/usr/bin/env node
'use strict';
// Project configuration for codis-agents: `.claude/codis-agents.json` in the consumer project.
// Everything project-specific (paths, guard command, branch names, report language) lives there; the plugin code
// itself carries no project names or personal paths.
//
// Lookup order: $CODIS_AGENTS_CONFIG; $CLAUDE_PROJECT_DIR/.claude/codis-agents.json; the nearest
// .claude/codis-agents.json from the working directory upwards; the main worktree of the current git repository
// (so linked worktrees find the config even when it is not committed).
//
// usage: config.js path                 -> absolute path of the config in use (exit 1 when none)
//        config.js check [file]         -> validation errors, exit 1 when any
//        config.js json [file]          -> resolved config as JSON (defaults applied, ~ expanded, plugin paths added)
//        config.js shell [file]         -> zsh lines `: ${VAR:=value}` for the slot scripts (environment wins)
//        config.js get <key.path> [file]
//        config.js default-branch [file] -> the default branch (exit 0); when it cannot be derived, the reason with the
//                                         fix on stdout and exit 78 (scripts/wt-setup.sh prints it)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FILE = path.join('.claude', 'codis-agents.json');
const PLUGIN_ROOT = path.resolve(__dirname, '..');

// key -> [type, default]. Types: string, number, boolean, string[], object (validated below).
const SPEC = {
  repoDir: ['path', undefined],
  worktreeRoot: ['path', undefined],
  sharedDir: ['path', undefined],
  guardCommand: ['string', ''],
  guardCommandLegacy: ['string', ''],
  guardAdaptiveProbe: ['object', null],
  guardRerun: ['object', null],
  // Known reds of the project (owner decision U-20): a JSON file {"<guard name>": "<reason>"} in the project's
  // repository, this path relative to the worktree; scripts/guards-result.js subtracts them after the full run. Needs
  // guardRerun (the names come from the log by its newRedPattern).
  guardBaseline: ['string', ''],
  // Guards that share a machine resource run one at a time under the exclusive lock (scripts/slots.zsh): a guard file
  // whose name matches one of glob and that has a line `<marker> guards:exclusive — <reason>`. Without the key the
  // default below (resolve()); with it both members are required and replace the default.
  guardExclusive: ['object', null],
  // One full run per task (scripts/guards-select.js): what a guard file is, which guards always run, the subset command.
  guardFiles: ['string[]', ['*-run.js', '*-run.mjs', '*-run.cjs']],
  guardAlways: ['string[]', []],
  guardSubsetCommand: ['string', ''],
  worktreeSetup: ['object', null],
  slots: ['object', null],
  reportLanguage: ['string', 'English'],
  // The default branch: this key, else what refs/remotes/origin/HEAD of the repository points to (branches() below).
  defaultBranch: ['string', ''],
  // Without the key: [defaultBranch]; null when that is unknown - the hooks then refuse every branch push.
  protectedBranches: ['string[]', null],
  protectedTagPattern: ['string', '^v'],
  ownerStackReadOnly: ['string', ''],
  medianTaskIE: ['number', 5e6],
  featureIELimit: ['number', null],
  // The paths the tester may change: the project's own guards and fixtures. No default - the plugin cannot know them;
  // without the key the role chain refuses to start (workflows/role-chain.js).
  testerWritable: ['string[]', null],
  roleNotes: ['object', null],
  threatModel: ['string', ''],
  gitHooks: ['object', null],
  standingPush: ['object', null],
  preconditions: ['object', null],
  stand: ['object', null],
  $schema: ['string', ''],
};
const REQUIRED = ['repoDir', 'worktreeRoot', 'sharedDir'];
const SLOT_SPEC = {
  medium: ['number', 2], heavy: ['number', 2], total: ['number', 4], lockDir: ['path', '~/.cache/codis-agents/slots'],
  legacyLock: ['path', ''], jobsAlone: ['number', 6], jobsShared: ['number', 3],
};
const WT_SPEC = { scan: ['string[]', []], skip: ['string[]', []], link: ['string[]', []] };
// Rerun of new reds one by one after a full run (scripts/guards-result.js explains why): command ({wt}, {name}),
// newRedPattern (per log line, group 1 = name), tallyPattern (the log reached its tally), maxReruns.
const RERUN_SPEC = { command: ['string', undefined], newRedPattern: ['string', undefined], tallyPattern: ['string', ''], maxReruns: ['number', 10] };
const EXCL_SPEC = { glob: ['string[]', undefined], marker: ['string', undefined] };
const EXCL_DEFAULT = { glob: ['*-run.js', '*-run.mjs'], marker: '//' };
const PROBE_SPEC = { file: ['string', undefined], contains: ['string', undefined] };
const HOOKS_SPEC = { blockICloudCopies: ['boolean', false], preCommit: ['string[]', []] };
const STANDING_SPEC = { branches: ['string[]', []], check: ['string', ''] };
// Environment floors of the preconditions (scripts/env-check.js documents why these defaults).
const PRE_SPEC = { minFreeDiskGB: ['number', 10], minSwapGB: ['number', 4] };
// The project's shared stand (scripts/stand.sh): one Docker stack that tasks take in turn by ticket instead of building
// their own. The plugin only calls these commands (zsh, in repoDir); what they do is the project's. Placeholders:
// {project}, {port} (first of ports), {ports}, {repo}, and {wt} (deploy only: the worktree whose committed HEAD goes in).
// status exits 0 only while the stand is up. imageFiles: globs of files that define the stand's image (a task whose
// commits touch one builds its own stack); a glob without "/" matches the file name at any depth, * and ? stay
// within one path segment, ** crosses them. memLimitMB: the stand's memory ceiling, for reference and status.
const STAND_SPEC = {
  project: ['string', undefined], ports: ['number[]', []], up: ['string', undefined], deploy: ['string', undefined],
  reset: ['string', undefined], status: ['string', undefined], down: ['string', undefined], imageFiles: ['string[]', []],
  memLimitMB: ['number', null],
};
const STAND_REQUIRED = ['project', 'up', 'deploy', 'reset', 'status', 'down'];
const ROLES = ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer'];

const expand = (p) => (typeof p === 'string' && p ? p.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$\{HOME\}|\$HOME\b/g, os.homedir()) : p);

function typeOk(type, v) {
  if (type === 'string' || type === 'path') return typeof v === 'string';
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (type === 'number[]') return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (type === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return false;
}

// Applies one spec level: unknown keys and wrong types are errors; defaults fill the gaps.
function level(spec, src, where, errors) {
  const out = {};
  for (const k of Object.keys(src || {})) if (!(k in spec)) errors.push(`${where}${k}: unknown key`);
  for (const [k, [type, def]] of Object.entries(spec)) {
    const v = src ? src[k] : undefined;
    if (v === undefined) { out[k] = type === 'path' ? expand(def) : def; continue; }
    if (!typeOk(type, v)) { errors.push(`${where}${k}: expected ${type}`); out[k] = def; continue; }
    out[k] = type === 'path' ? expand(v) : v;
  }
  return out;
}

// The globs zsh cannot compile as patterns, as slots.zsh uses them (${~g} under extendedglob): there "bad pattern"
// aborts heavy.sh with exit 1 - a false red - so check refuses them. Each glob in its own subshell (the error ends only
// that one). No zsh on the machine: nothing to refuse here, slots.zsh cannot run there either.
function badZshPatterns(globs) {
  const r = spawnSync('zsh', ['-f', '-c', 'setopt extendedglob; for g in "$@"; do ( [[ x == ${~g} ]]; print -r -- ok ) 2>/dev/null || print -r -- bad; done', 'zsh', ...globs], { encoding: 'utf8' });
  if (r.error) return [];
  const verdicts = r.stdout.split('\n');
  return globs.filter((g, i) => verdicts[i] !== 'ok');
}

function resolve(raw) {
  const errors = [];
  if (!typeOk('object', raw)) return { config: null, errors: ['config: expected a JSON object'] };
  const c = level(SPEC, raw, '', errors);
  for (const k of REQUIRED) if (!c[k]) errors.push(`${k}: required`);
  c.slots = level(SLOT_SPEC, c.slots, 'slots.', errors);
  for (const k of ['medium', 'heavy', 'total', 'jobsAlone', 'jobsShared']) {
    if (!(Number.isInteger(c.slots[k]) && c.slots[k] >= 1)) errors.push(`slots.${k}: expected a positive integer`);
  }
  c.worktreeSetup = level(WT_SPEC, c.worktreeSetup, 'worktreeSetup.', errors);
  c.gitHooks = level(HOOKS_SPEC, c.gitHooks, 'gitHooks.', errors);
  c.preconditions = level(PRE_SPEC, c.preconditions, 'preconditions.', errors);
  if (c.featureIELimit !== null && !(c.featureIELimit > 0)) errors.push('featureIELimit: expected a positive number (or leave it out for 3 x medianTaskIE)');
  for (const k of Object.keys(PRE_SPEC)) if (!(c.preconditions[k] >= 0)) errors.push(`preconditions.${k}: expected a number >= 0`);
  if (c.guardAdaptiveProbe) {
    c.guardAdaptiveProbe = level(PROBE_SPEC, c.guardAdaptiveProbe, 'guardAdaptiveProbe.', errors);
    if (!c.guardAdaptiveProbe.file || !c.guardAdaptiveProbe.contains) errors.push('guardAdaptiveProbe: file and contains are required');
    if (!c.guardCommandLegacy) errors.push('guardAdaptiveProbe: needs guardCommandLegacy (the command for worktrees where the probe fails)');
  }
  if (c.guardRerun) {
    const g = c.guardRerun = level(RERUN_SPEC, c.guardRerun, 'guardRerun.', errors);
    if (!g.command) errors.push('guardRerun.command: required');
    else for (const k of ['wt', 'name']) if (!g.command.includes(`{${k}}`)) errors.push(`guardRerun.command: must contain {${k}}`);
    if (!g.newRedPattern) errors.push('guardRerun.newRedPattern: required');
    else {
      try { if (new RegExp(g.newRedPattern + '|').exec('').length < 2) errors.push('guardRerun.newRedPattern: needs a capture group (the guard name)'); }
      catch (e) { errors.push('guardRerun.newRedPattern: bad regular expression'); }
    }
    if (g.tallyPattern) { try { new RegExp(g.tallyPattern); } catch (e) { errors.push('guardRerun.tallyPattern: bad regular expression'); } }
    if (!(Number.isInteger(g.maxReruns) && g.maxReruns >= 1)) errors.push('guardRerun.maxReruns: expected a positive integer');
  }
  if (c.guardBaseline) {
    if (!c.guardRerun) errors.push('guardBaseline: needs guardRerun (the names of the reds come from the log by guardRerun.newRedPattern)');
    if (path.isAbsolute(c.guardBaseline) || /^~/.test(c.guardBaseline)) errors.push(`guardBaseline: a path relative to the worktree (the file is committed with the project), not ${c.guardBaseline}`);
  }
  if (c.guardExclusive) {
    const x = c.guardExclusive = level(EXCL_SPEC, c.guardExclusive, 'guardExclusive.', errors);
    if (x.glob === undefined) errors.push('guardExclusive.glob: required');
    else if (!x.glob.length) errors.push('guardExclusive.glob: expected at least one glob');
    // matched against the file name of a command argument (slots.zsh): a path segment can never match
    else if (x.glob.some((g) => !g || /[/\n]/.test(g))) {
      for (const g of x.glob) if (!g || /[/\n]/.test(g)) errors.push(`guardExclusive.glob: a glob of the file name, without "/": ${JSON.stringify(g)}`);
    } else for (const g of badZshPatterns(x.glob)) errors.push(`guardExclusive.glob: not a valid zsh pattern (slots.zsh matches it with extendedglob): ${JSON.stringify(g)}`);
    if (x.marker === undefined) errors.push('guardExclusive.marker: required');
    else if (!x.marker || /\s/.test(x.marker)) errors.push(`guardExclusive.marker: the line-comment marker, not empty and without blanks: ${JSON.stringify(x.marker)}`);
  } else c.guardExclusive = { glob: [...EXCL_DEFAULT.glob], marker: EXCL_DEFAULT.marker };
  if (c.standingPush) {
    c.standingPush = level(STANDING_SPEC, c.standingPush, 'standingPush.', errors);
    if (!c.standingPush.branches.length || !c.standingPush.check.trim()) errors.push('standingPush: branches and check are required');
  }
  if (c.stand) {
    c.stand = level(STAND_SPEC, c.stand, 'stand.', errors);
    const s = c.stand;
    for (const k of STAND_REQUIRED) if (!(typeof s[k] === 'string' && s[k].trim())) errors.push(`stand.${k}: required`);
    // Docker Compose project names: lowercase letters, digits, dashes and underscores, starting with a letter or digit.
    if (s.project && !/^[a-z0-9][a-z0-9_-]*$/.test(s.project)) errors.push(`stand.project: not a compose project name (lowercase letters, digits, - and _): ${s.project}`);
    if (s.project && s.project === c.ownerStackReadOnly) errors.push(`stand.project: ${s.project} is the owner's stack (ownerStackReadOnly); the stand is reset and redeployed by roles`);
    if (s.deploy && !s.deploy.includes('{wt}')) errors.push('stand.deploy: must contain {wt} (the worktree to deploy)');
    if (!s.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) errors.push('stand.ports: expected port numbers 1-65535');
    if (s.memLimitMB !== null && !(s.memLimitMB > 0)) errors.push('stand.memLimitMB: expected a positive number (or leave it out)');
  }
  const notes = c.roleNotes || {};
  for (const [k, v] of Object.entries(notes)) {
    if (!ROLES.includes(k)) errors.push(`roleNotes.${k}: unknown role (one of ${ROLES.join(', ')})`);
    else if (typeof v !== 'string') errors.push(`roleNotes.${k}: expected string`);
  }
  c.roleNotes = notes;
  for (const [k, list] of [['testerWritable', c.testerWritable || []]]) {
    for (const re of list) { try { new RegExp(re); } catch (e) { errors.push(`${k}: bad regular expression ${re}`); } }
  }
  try { new RegExp(c.protectedTagPattern); } catch (e) { errors.push('protectedTagPattern: bad regular expression'); }
  for (const k of ['guardCommand', 'guardCommandLegacy']) {
    if (c[k] && !c[k].includes('{wt}')) errors.push(`${k}: must contain {wt} (the worktree directory)`);
    // {jobs} is optional: a runner that sets its own workers is counted as the whole budget (scripts/guards-all.sh).
  }
  if (c.guardSubsetCommand && !c.guardSubsetCommand.includes('{onlyArgs}')) errors.push('guardSubsetCommand: must contain {onlyArgs} (one --only <guard> per selected guard)');
  if (!c.guardFiles.length) errors.push('guardFiles: expected at least one glob');
  if (c.guardCommandLegacy && c.guardCommandLegacy.includes('{limitFile}')) errors.push('guardCommandLegacy: must not contain {limitFile} (legacy runners take a fixed worker count)');
  return { config: c, errors };
}

// The default branch of a git repository is where refs/remotes/origin/HEAD points: git clone sets it, git remote
// set-head origin --auto sets it again (git-clone(1), git-remote(1)). Only the remote "origin" is read - the name git
// clone gives; a project with another remote sets defaultBranch. No list of usual names: not derivable stays unknown.
function originHead(dir) {
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  const s = r.status === 0 ? r.stdout.trim() : '';
  return s.startsWith('origin/') && s.length > 7 ? s.slice(7) : null;
}

// Fills defaultBranch, protectedBranches and defaultBranchUnknown (the reason with the fix, '' when known) of a
// resolved config from its explicit keys, else from the git repository dir.
function branches(c, dir) {
  const def = c.defaultBranch || (dir ? originHead(dir) : null);
  const why = def ? '' : `the default branch is unknown: no defaultBranch in the config and refs/remotes/origin/HEAD is not set in ${dir || '(no repository)'} - set defaultBranch (or protectedBranches) in the config, or let the owner run git remote set-head origin --auto (the session hook refuses it to agents)`;
  const prot = c.protectedBranches || (def ? [def] : null);
  return Object.assign(c, { defaultBranch: def || null, protectedBranches: prot, defaultBranchUnknown: why });
}

// The repository the branches are derived from: opts.branchDir (the hooks pass the repository that pushes), else
// repoDir - a relative repoDir is relative to the project root, the parent of .claude/.
function branchDirOf(c, file, opts) {
  if (opts && opts.branchDir) return opts.branchDir;
  if (!c.repoDir) return null;
  const base = path.basename(path.dirname(file)) === '.claude' ? path.dirname(path.dirname(file)) : process.cwd();
  return path.resolve(base, c.repoDir);
}

function gitMainRoot(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

function find(cwd = process.cwd(), env = process.env) {
  if (env.CODIS_AGENTS_CONFIG) return path.resolve(env.CODIS_AGENTS_CONFIG);
  if (env.CLAUDE_PROJECT_DIR) {
    const f = path.join(env.CLAUDE_PROJECT_DIR, FILE);
    if (fs.existsSync(f)) return f;
  }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const f = path.join(d, FILE);
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) break;
  }
  const main = gitMainRoot(cwd);
  if (main && fs.existsSync(path.join(main, FILE))) return path.join(main, FILE);
  return null;
}

function load(file, opts) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { config: null, errors: [`${file}: ${e.message}`] }; }
  const r = resolve(raw);
  if (r.config) {
    Object.assign(r.config, { configPath: path.resolve(file), pluginRoot: PLUGIN_ROOT, scriptsDir: path.join(PLUGIN_ROOT, 'scripts') });
    branches(r.config, branchDirOf(r.config, path.resolve(file), opts));
  }
  return r;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function shellLines(c) {
  const v = {
    SLOTS_DIR: c.slots.lockDir, SLOT_LEGACY_LOCK: c.slots.legacyLock, SLOT_MEDIUM_N: c.slots.medium, SLOT_HEAVY_N: c.slots.heavy,
    SLOT_TOTAL_MAX: c.slots.total, GUARDS_JOBS_ALONE: c.slots.jobsAlone, GUARDS_JOBS_SHARED: c.slots.jobsShared,
    GUARDS_EXCL_GLOB: c.guardExclusive.glob.join('\n'), GUARDS_EXCL_MARKER: c.guardExclusive.marker,
    CODIS_REPO_DIR: c.repoDir, CODIS_WORKTREE_ROOT: c.worktreeRoot, CODIS_SHARED_DIR: c.sharedDir,
  };
  // An empty value still has to win over the built-in default, hence `=` for empties instead of `:=`.
  return Object.entries(v).map(([k, x]) => (x === '' ? `[[ -v ${k} ]] || ${k}=''` : `: \${${k}:=${q(x)}}`)).join('\n');
}

module.exports = { find, load, resolve, branches, shellLines, SPEC, SLOT_SPEC, RERUN_SPEC, EXCL_SPEC, EXCL_DEFAULT, STAND_SPEC, STAND_REQUIRED, WT_SPEC, PROBE_SPEC, HOOKS_SPEC, STANDING_SPEC, PRE_SPEC, ROLES, expand };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fileArg = cmd === 'get' ? rest[1] : rest[0];
  const file = fileArg ? path.resolve(fileArg) : find();
  if (!file) { console.error(`codis-agents: no ${FILE} found (set CODIS_AGENTS_CONFIG or create it in the project root)`); process.exit(1); }
  if (cmd === 'path') { console.log(file); process.exit(0); }
  const { config, errors } = load(file);
  if (cmd === 'check') {
    for (const e of errors) console.error('codis-agents config: ' + e);
    // Not an error: the slots and the rest work; the hooks refuse every branch push and wt-setup.sh needs a base.
    if (config && !config.protectedBranches) console.error(`codis-agents config: note: ${config.defaultBranchUnknown}; until then the hooks refuse every branch push`);
    if (!errors.length) console.log(`ok ${file}`);
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length) { for (const e of errors) console.error('codis-agents config: ' + e); process.exit(1); }
  if (cmd === 'json') console.log(JSON.stringify(config, null, 2));
  else if (cmd === 'shell') console.log(shellLines(config));
  else if (cmd === 'default-branch') {
    console.log(config.defaultBranch || config.defaultBranchUnknown);
    process.exit(config.defaultBranch ? 0 : 78);
  }
  else if (cmd === 'get') {
    const v = rest[0].split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
    if (v === undefined) process.exit(1);
    console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
  } else { console.error('usage: config.js path|check|json|shell|get <key>|default-branch'); process.exit(64); }
}

// For hooks: the project config when there is one (even with validation errors, defaults fill the gaps), else the
// defaults alone; the branches are derived from the repository at cwd (the one the hook runs for). Never throws.
module.exports.loadOrDefaults = function loadOrDefaults(cwd, env) {
  let f = null;
  try { f = find(cwd, env); } catch { /* not a git repo */ }
  if (f) { const r = load(f, { branchDir: cwd }); if (r.config) return r.config; }
  const errors = [];
  return branches(Object.assign(level(SPEC, {}, '', errors), {
    slots: level(SLOT_SPEC, {}, '', errors), worktreeSetup: level(WT_SPEC, {}, '', errors),
    gitHooks: level(HOOKS_SPEC, {}, '', errors), preconditions: level(PRE_SPEC, {}, '', errors), roleNotes: {}, configPath: null,
  }), cwd);
};
