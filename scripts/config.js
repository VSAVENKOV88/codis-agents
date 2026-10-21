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
//        config.js shell [file]         -> zsh lines `: ${VAR:=value}` for the slot scripts (environment wins); with no
//                                         project config, the machine lines alone
//        config.js get <key.path> [file]
//        config.js default-branch [file] -> the default branch (exit 0); when it cannot be derived, the reason with the
//                                         fix on stdout and exit 78 (scripts/wt-setup.sh prints it)
//
// The machine file (owner 2026-10-21, U2a): settings of the machine shared by every project on it - slot counts and
// their lock directory, the swap and disk floors, the limit of chains with acceptance in Docker, the coordinator's
// context signpost. Path: $CODIS_AGENTS_MACHINE (tests), else ${XDG_CONFIG_HOME:-~/.config}/codis-agents/machine.json
// (a relative XDG_CONFIG_HOME is ignored, as the XDG Base Directory specification says). No file: the built-in
// defaults, with a note. A project config may still carry the older machine keys (slots.*, preconditions.*): equal
// to the machine file - a warning, different - an error (two queues, two ceilings); with no machine file the project's
// values apply, with a warning to run config.js migrate. The newer machine keys are never read from a project.
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
// cwd (owner 2026-10-21): the directory the commands run in, absolute or ~ and existing; empty - repoDir, as before.
const STAND_SPEC = {
  project: ['string', undefined], ports: ['number[]', []], up: ['string', undefined], deploy: ['string', undefined],
  reset: ['string', undefined], status: ['string', undefined], down: ['string', undefined], imageFiles: ['string[]', []],
  memLimitMB: ['number', null], cwd: ['path', ''],
};
const STAND_REQUIRED = ['project', 'up', 'deploy', 'reset', 'status', 'down'];
const ROLES = ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer'];

// The machine file. Defaults measured on a 16 GB Mac of the project the process was first built for (slots.zsh and
// scripts/env-check.js explain each number); swapMinMB is in MB for both the slot scripts and env-check (4000: a
// 4 GiB swap file shows a little under 4096 MB). extraHeavy left out: null - the slot scripts decide by OS (U2a-2).
const MACHINE_VERSION = 1;
const MACHINE_DEFAULTS_NOTE = 'defaults measured on a 16 GB Mac of the source project';
const MACHINE_SPEC = {
  configVersion: ['number', undefined], source: ['string', ''], swapMinMB: ['number', 4000], minFreeDiskGB: ['number', 10],
  maxDockerChains: ['number', 2], coordinatorContextK: ['number', 700], slots: ['object', null], $schema: ['string', ''],
};
const MACHINE_SLOT_SPEC = Object.assign({}, SLOT_SPEC, { extraHeavy: ['any', null] });
const EXTRA_SPEC = { freePct: ['number', 50], swapGrowMB: ['number', 256], windowS: ['number', 300] };
// Machine keys a project config may still carry (until config.js migrate): project key -> machine key, and the
// conversion of the project's value into the machine's unit.
const MOVED = [
  ...['medium', 'heavy', 'total', 'lockDir', 'legacyLock', 'jobsAlone', 'jobsShared'].map((k) => [`slots.${k}`, `slots.${k}`, (v) => v]),
  ['preconditions.minFreeDiskGB', 'minFreeDiskGB', (v) => v],
  ['preconditions.minSwapGB', 'swapMinMB', (v) => v * 1024],
];
// Machine keys that never come from a project (decision Q4): no branch ever had them there.
const MACHINE_ONLY_TOP = ['swapMinMB', 'maxDockerChains', 'coordinatorContextK'];

const expand = (p) => (typeof p === 'string' && p ? p.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$\{HOME\}|\$HOME\b/g, os.homedir()) : p);

function typeOk(type, v) {
  if (type === 'string' || type === 'path') return typeof v === 'string';
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (type === 'number[]') return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (type === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (type === 'any') return true;
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

// Where the machine file is: {path, explicit} (explicit - named by CODIS_AGENTS_MACHINE, so a missing file is an error).
function machinePath(env = process.env) {
  if (env.CODIS_AGENTS_MACHINE) return { path: path.resolve(expand(env.CODIS_AGENTS_MACHINE)), explicit: true };
  const x = env.XDG_CONFIG_HOME;
  const base = x && path.isAbsolute(x) ? x : path.join(env.HOME || os.homedir(), '.config');
  return { path: path.join(base, 'codis-agents', 'machine.json'), explicit: false };
}

const absOrTilde = (v) => typeof v === 'string' && (path.isAbsolute(v) || /^~(\/|$)/.test(v));
// Reads and validates the machine file. Never throws: {path, explicit, exists, missing (explicit and absent), source,
// errors and notes (each naming the file), values (the defaults where the file is absent or wrong)}.
function loadMachine(env = process.env) {
  const { path: p, explicit } = machinePath(env);
  const m = { path: p, explicit, exists: false, missing: false, source: MACHINE_DEFAULTS_NOTE, errors: [], notes: [], values: null };
  let raw = {};
  try {
    const text = fs.readFileSync(p, 'utf8');
    m.exists = true;
    try { raw = JSON.parse(text); } catch (e) { m.errors.push(`${p}: ${e.message}`); raw = {}; }
  } catch (e) {
    if (explicit) { m.missing = e.code === 'ENOENT' || e.code === 'ENOTDIR'; m.errors.push(`${p}: ${m.missing ? 'no such machine file (named by CODIS_AGENTS_MACHINE)' : e.message}`); }
    else if (e.code === 'ENOENT' || e.code === 'ENOTDIR') m.notes.push(`note: no machine file at ${p}: ${MACHINE_DEFAULTS_NOTE}`);
    else m.errors.push(`${p}: ${e.message}`);
  }
  const errs = [];
  if (m.exists && !m.errors.length && !typeOk('object', raw)) { errs.push('expected a JSON object'); raw = {}; }
  const v = level(MACHINE_SPEC, raw, '', errs);
  // Paths are checked as written: relative to what is unknown for a file shared by every project.
  const rawSlots = typeOk('object', raw.slots) ? raw.slots : {};
  for (const k of ['lockDir', 'legacyLock']) {
    const w = rawSlots[k];
    if (w !== undefined && typeof w === 'string' && !absOrTilde(w) && !(k === 'legacyLock' && w === '')) errs.push(`slots.${k}: an absolute path or one starting with ~, not ${JSON.stringify(w)}`);
  }
  v.slots = level(MACHINE_SLOT_SPEC, v.slots, 'slots.', errs);
  for (const k of ['medium', 'heavy', 'total', 'jobsAlone', 'jobsShared']) {
    if (typeof v.slots[k] === 'number' && !(Number.isInteger(v.slots[k]) && v.slots[k] >= 1)) errs.push(`slots.${k}: expected a positive integer`);
  }
  const x = v.slots.extraHeavy;
  if (x === undefined || x === null) v.slots.extraHeavy = null;
  else if (x === false) v.slots.extraHeavy = false;
  else if (typeOk('object', x)) {
    const e = v.slots.extraHeavy = level(EXTRA_SPEC, x, 'slots.extraHeavy.', errs);
    if (typeof e.freePct === 'number' && !(e.freePct >= 0 && e.freePct <= 100)) errs.push('slots.extraHeavy.freePct: expected a number 0-100');
    if (typeof e.swapGrowMB === 'number' && !(e.swapGrowMB >= 0)) errs.push('slots.extraHeavy.swapGrowMB: expected a number >= 0');
    if (typeof e.windowS === 'number' && !(e.windowS > 0)) errs.push('slots.extraHeavy.windowS: expected a number > 0');
  } else { errs.push('slots.extraHeavy: expected false or an object {freePct, swapGrowMB, windowS}'); v.slots.extraHeavy = null; }
  if (typeof v.swapMinMB === 'number' && !(Number.isInteger(v.swapMinMB) && v.swapMinMB >= 0)) errs.push('swapMinMB: expected an integer >= 0 (MB; 0 switches the swap check off)');
  if (typeof v.minFreeDiskGB === 'number' && !(v.minFreeDiskGB >= 0)) errs.push('minFreeDiskGB: expected a number >= 0 (GB; 0 switches the disk check off)');
  for (const k of ['maxDockerChains', 'coordinatorContextK']) {
    if (typeof v[k] === 'number' && !(Number.isInteger(v[k]) && v[k] >= 1)) errs.push(`${k}: expected a positive integer`);
  }
  if (m.exists && !m.errors.length) {
    if (v.configVersion === undefined) m.notes.push(`note: ${p}: no configVersion - read as version ${MACHINE_VERSION}`);
    else if (!(Number.isInteger(v.configVersion) && v.configVersion >= 1)) errs.push('configVersion: expected a positive integer');
    else if (v.configVersion > MACHINE_VERSION) errs.push(`configVersion ${v.configVersion} is newer than this plugin reads (${MACHINE_VERSION}) - update the plugin`);
  }
  for (const e of errs) m.errors.push(`${p}: ${e}`);
  // A wrong value falls back to its default, so a caller that ignores errors (the hooks) still gets a whole object.
  const D = level(MACHINE_SPEC, {}, '', []); D.slots = level(MACHINE_SLOT_SPEC, {}, '', []); D.slots.extraHeavy = null;
  if (m.errors.length) m.values = D;
  else { m.values = v; if (m.exists && v.source) m.source = v.source; }
  return m;
}

const getPath = (o, k) => k.split('.').reduce((a, x) => (a == null ? undefined : a[x]), o);
const sameValue = (k, a, b) => (/lockDir|legacyLock/.test(k) && a && b ? path.resolve(a) === path.resolve(b) : a === b);
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// opts: machine (a loadMachine() result), env (to load it from; default process.env), file (the project config, for
// the messages). Returns {config, errors, warnings}.
function resolve(raw, opts = {}) {
  const errors = [], warnings = [];
  if (!typeOk('object', raw)) return { config: null, errors: ['config: expected a JSON object'], warnings };
  const m = opts.machine || loadMachine(opts.env || process.env);
  const here = opts.file ? `the project config ${opts.file}` : 'the project config';
  // Machine-only keys in the project: an error always (Q4), named as such rather than "unknown key".
  const proj = Object.assign({}, raw);
  for (const k of MACHINE_ONLY_TOP) if (k in proj) { errors.push(`${k}: a machine setting - set it in the machine file ${m.path}, not in ${here}`); delete proj[k]; }
  if (typeOk('object', proj.slots) && 'extraHeavy' in proj.slots) {
    errors.push(`slots.extraHeavy: a machine setting - set it in the machine file ${m.path}, not in ${here}`);
    proj.slots = Object.assign({}, proj.slots); delete proj.slots.extraHeavy;
  }
  const c = level(SPEC, proj, '', errors);
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
  // The machine values, and the older machine keys the project still sets (validated above, in the project's unit).
  errors.push(...m.errors); warnings.push(...m.notes);
  const mv = m.values;
  const merged = { slots: Object.assign({}, mv.slots), swapMinMB: mv.swapMinMB, minFreeDiskGB: mv.minFreeDiskGB };
  const given = MOVED.filter(([pk]) => getPath(proj, pk) !== undefined);
  if (m.exists && !m.errors.length) {
    for (const [pk, mk, conv] of given) {
      const pv = conv(getPath(c, pk)), want = getPath(mv, mk);
      if (sameValue(mk, pv, want)) warnings.push(`warning: ${pk}: a machine setting - the machine file ${m.path} sets the same value (${mk === pk ? '' : mk + ' '}${show(want)}); remove it from ${here} (move it to the machine file)`);
      else {
        const said = pk === 'preconditions.minSwapGB' ? `${getPath(c, pk)} GB (${pv} MB), the machine file sets swapMinMB ${want}` : `${show(pv)}, the machine file sets ${show(want)}`;
        errors.push(`${pk}: the project sets ${said} - two values of a machine setting (two queues or two ceilings); remove it from ${here} or change the machine file ${m.path}`);
      }
    }
  } else {
    for (const [pk, mk, conv] of given) {
      const pv = conv(getPath(c, pk));
      if (mk.startsWith('slots.')) merged.slots[mk.slice(6)] = pv; else merged[mk] = pv;
    }
    if (given.length && !m.errors.length) warnings.push(`warning: machine settings in ${here} (${given.map(([pk]) => pk).join(', ')}) and no machine file at ${m.path}: the project's values apply - run config.js migrate`);
  }
  c.slots = merged.slots;
  c.preconditions = { minFreeDiskGB: merged.minFreeDiskGB, swapMinMB: merged.swapMinMB };
  c.maxDockerChains = mv.maxDockerChains;
  c.coordinatorContextK = mv.coordinatorContextK;
  c.machine = { path: m.path, exists: m.exists, source: m.source };
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
    if (s.cwd) {
      let st = null;
      try { st = fs.statSync(s.cwd); } catch { /* reported below */ }
      if (!path.isAbsolute(s.cwd)) errors.push(`stand.cwd: an absolute path or one starting with ~, not ${s.cwd}`);
      else if (!st) errors.push(`stand.cwd: the directory ${s.cwd} does not exist`);
      else if (!st.isDirectory()) errors.push(`stand.cwd: ${s.cwd} is not a directory`);
    }
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
  return { config: c, errors, warnings, machineMissing: m.missing };
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

function load(file, opts = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { config: null, errors: [`${file}: ${e.message}`], warnings: [] }; }
  const r = resolve(raw, { env: opts.env, machine: opts.machine, file: path.resolve(file) });
  if (r.config) {
    Object.assign(r.config, { configPath: path.resolve(file), pluginRoot: PLUGIN_ROOT, scriptsDir: path.join(PLUGIN_ROOT, 'scripts') });
    branches(r.config, branchDirOf(r.config, path.resolve(file), opts));
  }
  return r;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The slot lines; c is a resolved project config, or {slots} of the machine alone (config.js shell with no project).
function shellLines(c) {
  const v = {
    SLOTS_DIR: c.slots.lockDir, SLOT_LEGACY_LOCK: c.slots.legacyLock, SLOT_MEDIUM_N: c.slots.medium, SLOT_HEAVY_N: c.slots.heavy,
    SLOT_TOTAL_MAX: c.slots.total, GUARDS_JOBS_ALONE: c.slots.jobsAlone, GUARDS_JOBS_SHARED: c.slots.jobsShared,
  };
  if (c.guardExclusive) Object.assign(v, {
    GUARDS_EXCL_GLOB: c.guardExclusive.glob.join('\n'), GUARDS_EXCL_MARKER: c.guardExclusive.marker,
    CODIS_REPO_DIR: c.repoDir, CODIS_WORKTREE_ROOT: c.worktreeRoot, CODIS_SHARED_DIR: c.sharedDir,
  });
  // An empty value still has to win over the built-in default, hence `=` for empties instead of `:=`.
  return Object.entries(v).map(([k, x]) => (x === '' ? `[[ -v ${k} ]] || ${k}=''` : `: \${${k}:=${q(x)}}`)).join('\n');
}

module.exports = { find, load, resolve, branches, shellLines, machinePath, loadMachine, MACHINE_SPEC, MACHINE_SLOT_SPEC, EXTRA_SPEC, MACHINE_VERSION, SPEC, SLOT_SPEC, RERUN_SPEC, EXCL_SPEC, EXCL_DEFAULT, STAND_SPEC, STAND_REQUIRED, WT_SPEC, PROBE_SPEC, HOOKS_SPEC, STANDING_SPEC, PRE_SPEC, ROLES, expand };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fileArg = cmd === 'get' ? rest[1] : rest[0];
  const file = fileArg ? path.resolve(fileArg) : find();
  if (!file && cmd === 'shell') {
    // A job outside any project (a scratchpad) still queues in the machine's slots.
    const m = loadMachine();
    if (m.errors.length) { for (const e of m.errors) console.error('codis-agents config: ' + e); process.exit(m.missing ? 78 : 1); }
    console.log(shellLines(m.values));
    process.exit(0);
  }
  if (!file) { console.error(`codis-agents: no ${FILE} found (set CODIS_AGENTS_CONFIG or create it in the project root)`); process.exit(1); }
  if (cmd === 'path') { console.log(file); process.exit(0); }
  const { config, errors, warnings, machineMissing } = load(file);
  if (cmd === 'check') {
    for (const e of errors) console.error('codis-agents config: ' + e);
    for (const w of warnings || []) console.error('codis-agents config: ' + w);
    // Not an error: the slots and the rest work; the hooks refuse every branch push and wt-setup.sh needs a base.
    if (config && !config.protectedBranches) console.error(`codis-agents config: note: ${config.defaultBranchUnknown}; until then the hooks refuse every branch push`);
    if (!errors.length) console.log(`ok ${file}`);
    process.exit(errors.length ? 1 : 0);
  }
  // CODIS_AGENTS_MACHINE names a file that is not there: a configuration error of the caller (78), not a bad value.
  if (errors.length) { for (const e of errors) console.error('codis-agents config: ' + e); process.exit(machineMissing ? 78 : 1); }
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
  if (f) { const r = load(f, { branchDir: cwd, env }); if (r.config) return r.config; }
  const errors = [];
  return branches(Object.assign(level(SPEC, {}, '', errors), {
    slots: level(SLOT_SPEC, {}, '', errors), worktreeSetup: level(WT_SPEC, {}, '', errors),
    gitHooks: level(HOOKS_SPEC, {}, '', errors), preconditions: level(PRE_SPEC, {}, '', errors), roleNotes: {}, configPath: null,
  }), cwd);
};
