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
  worktreeSetup: ['object', null],
  slots: ['object', null],
  reportLanguage: ['string', 'English'],
  protectedBranches: ['string[]', ['main']],
  protectedTagPattern: ['string', '^v'],
  ownerStackReadOnly: ['string', ''],
  medianTaskIE: ['number', 5e6],
  featureIELimit: ['number', null],
  testerWritable: ['string[]', ['-run\\.(js|mjs|cjs)$', '(^|/)(__)?fixtures(__)?/']],
  roleNotes: ['object', null],
  threatModel: ['string', ''],
  gitHooks: ['object', null],
  standingPush: ['object', null],
  preconditions: ['object', null],
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
const PROBE_SPEC = { file: ['string', undefined], contains: ['string', undefined] };
const HOOKS_SPEC = { blockICloudCopies: ['boolean', false], preCommit: ['string[]', []] };
const STANDING_SPEC = { branches: ['string[]', []], check: ['string', ''] };
// Environment floors of the preconditions (scripts/env-check.js documents why these defaults).
const PRE_SPEC = { minFreeDiskGB: ['number', 10], minSwapGB: ['number', 4] };
const ROLES = ['analyst', 'programmer', 'tester', 'reviewer', 'security-reviewer'];

const expand = (p) => (typeof p === 'string' && p ? p.replace(/^~(?=$|\/)/, os.homedir()).replace(/\$\{HOME\}|\$HOME\b/g, os.homedir()) : p);

function typeOk(type, v) {
  if (type === 'string' || type === 'path') return typeof v === 'string';
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
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
  if (c.standingPush) {
    c.standingPush = level(STANDING_SPEC, c.standingPush, 'standingPush.', errors);
    if (!c.standingPush.branches.length || !c.standingPush.check.trim()) errors.push('standingPush: branches and check are required');
  }
  const notes = c.roleNotes || {};
  for (const [k, v] of Object.entries(notes)) {
    if (!ROLES.includes(k)) errors.push(`roleNotes.${k}: unknown role (one of ${ROLES.join(', ')})`);
    else if (typeof v !== 'string') errors.push(`roleNotes.${k}: expected string`);
  }
  c.roleNotes = notes;
  for (const [k, list] of [['testerWritable', c.testerWritable]]) {
    for (const re of list) { try { new RegExp(re); } catch (e) { errors.push(`${k}: bad regular expression ${re}`); } }
  }
  try { new RegExp(c.protectedTagPattern); } catch (e) { errors.push('protectedTagPattern: bad regular expression'); }
  for (const k of ['guardCommand', 'guardCommandLegacy']) {
    if (c[k] && !c[k].includes('{wt}')) errors.push(`${k}: must contain {wt} (the worktree directory)`);
    if (c[k] && !c[k].includes('{jobs}')) errors.push(`${k}: must contain {jobs} (the worker count chosen by the slot budget)`);
  }
  if (c.guardCommandLegacy && c.guardCommandLegacy.includes('{limitFile}')) errors.push('guardCommandLegacy: must not contain {limitFile} (legacy runners take a fixed worker count)');
  return { config: c, errors };
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

function load(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { config: null, errors: [`${file}: ${e.message}`] }; }
  const r = resolve(raw);
  if (r.config) Object.assign(r.config, { configPath: path.resolve(file), pluginRoot: PLUGIN_ROOT, scriptsDir: path.join(PLUGIN_ROOT, 'scripts') });
  return r;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function shellLines(c) {
  const v = {
    SLOTS_DIR: c.slots.lockDir, SLOT_LEGACY_LOCK: c.slots.legacyLock, SLOT_MEDIUM_N: c.slots.medium, SLOT_HEAVY_N: c.slots.heavy,
    SLOT_TOTAL_MAX: c.slots.total, GUARDS_JOBS_ALONE: c.slots.jobsAlone, GUARDS_JOBS_SHARED: c.slots.jobsShared,
    CODIS_REPO_DIR: c.repoDir, CODIS_WORKTREE_ROOT: c.worktreeRoot, CODIS_SHARED_DIR: c.sharedDir,
  };
  // An empty value still has to win over the built-in default, hence `=` for empties instead of `:=`.
  return Object.entries(v).map(([k, x]) => (x === '' ? `[[ -v ${k} ]] || ${k}=''` : `: \${${k}:=${q(x)}}`)).join('\n');
}

module.exports = { find, load, resolve, shellLines, SPEC, SLOT_SPEC, RERUN_SPEC, WT_SPEC, PROBE_SPEC, HOOKS_SPEC, STANDING_SPEC, PRE_SPEC, ROLES, expand };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fileArg = cmd === 'get' ? rest[1] : rest[0];
  const file = fileArg ? path.resolve(fileArg) : find();
  if (!file) { console.error(`codis-agents: no ${FILE} found (set CODIS_AGENTS_CONFIG or create it in the project root)`); process.exit(1); }
  if (cmd === 'path') { console.log(file); process.exit(0); }
  const { config, errors } = load(file);
  if (cmd === 'check') {
    for (const e of errors) console.error('codis-agents config: ' + e);
    if (!errors.length) console.log(`ok ${file}`);
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length) { for (const e of errors) console.error('codis-agents config: ' + e); process.exit(1); }
  if (cmd === 'json') console.log(JSON.stringify(config, null, 2));
  else if (cmd === 'shell') console.log(shellLines(config));
  else if (cmd === 'get') {
    const v = rest[0].split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
    if (v === undefined) process.exit(1);
    console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
  } else { console.error('usage: config.js path|check|json|shell|get <key>'); process.exit(64); }
}

// For hooks: the project config when there is one (even with validation errors, defaults fill the gaps), else the
// defaults alone. Never throws.
module.exports.loadOrDefaults = function loadOrDefaults(cwd, env) {
  let f = null;
  try { f = find(cwd, env); } catch { /* not a git repo */ }
  if (f) { const r = load(f); if (r.config) return r.config; }
  const errors = [];
  return Object.assign(level(SPEC, {}, '', errors), {
    slots: level(SLOT_SPEC, {}, '', errors), worktreeSetup: level(WT_SPEC, {}, '', errors),
    gitHooks: level(HOOKS_SPEC, {}, '', errors), preconditions: level(PRE_SPEC, {}, '', errors), roleNotes: {}, configPath: null,
  });
};
