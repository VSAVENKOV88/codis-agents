#!/usr/bin/env node
'use strict';
// The machine file (U2a-1): settings of the machine, not of a project - slot counts and their lock directory, swap and
// disk floors, the Docker chain limit, the coordinator's context signpost. Path: $CODIS_AGENTS_MACHINE, else
// ${XDG_CONFIG_HOME:-~/.config}/codis-agents/machine.json (a relative XDG_CONFIG_HOME is ignored, XDG Base Directory
// spec). Cells of the analysis: M1-M6 path, V1-V6 validation, P1-P8 merge with the project config, J1 the resolved
// JSON, E2-E7 env-check, H1 the tests never read the real machine file. Every case runs on a temporary machine file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const C = require('../scripts/config');
const { judge, DEFAULTS } = require('../scripts/env-check');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'scripts', 'config.js');
const ENVCHECK = path.join(ROOT, 'scripts', 'env-check.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codis-machine-')));
const EMPTY = path.join(T, 'xdg-empty');
fs.mkdirSync(EMPTY);
let n = 0;
const write = (obj) => { const f = path.join(T, `f${n++}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const BASE = { repoDir: T, worktreeRoot: T, sharedDir: T, defaultBranch: 'main' };
const proj = (extra) => write(Object.assign({}, BASE, extra || {}));
const L = path.join(T, 'machine-slots'), L2 = path.join(T, 'other-slots');
const MFULL = {
  configVersion: 1, source: 'measured on a test box', swapMinMB: 4000, minFreeDiskGB: 10, maxDockerChains: 3, coordinatorContextK: 650,
  slots: { medium: 2, heavy: 1, total: 3, jobsAlone: 6, jobsShared: 3, lockDir: L, legacyLock: '', extraHeavy: { freePct: 50, swapGrowMB: 256, windowS: 300 } },
};
const mach = (over) => write(Object.assign({}, MFULL, over || {}));
const machSlots = (over) => mach({ slots: Object.assign({}, MFULL.slots, over) });
// The environment of a child: the given variables over this process (whose machine file lib.js already made hermetic).
const envOf = (extra, del) => { const e = Object.assign({}, process.env, extra || {}); for (const k of del || []) delete e[k]; return e; };
const run = (script, args, extra, del, cwd) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: cwd || T, env: envOf(extra, del) });
const cfg = (args, extra, del, cwd) => run(CONFIG, args, extra, del, cwd);
const withM = (m) => ({ CODIS_AGENTS_MACHINE: m });
const noM = { XDG_CONFIG_HOME: EMPTY };
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const all = (r) => r.stdout + r.stderr;

try {
  // ---- M: where the machine file is
  const mp = (env) => C.machinePath(env).path;
  ok('M1. CODIS_AGENTS_MACHINE wins over XDG_CONFIG_HOME and HOME', mp({ CODIS_AGENTS_MACHINE: '/t/m.json', XDG_CONFIG_HOME: '/x', HOME: '/h' }) === '/t/m.json');
  ok('M2. XDG_CONFIG_HOME (absolute) -> <it>/codis-agents/machine.json', mp({ XDG_CONFIG_HOME: '/x', HOME: '/h' }) === '/x/codis-agents/machine.json');
  ok('M3. XDG_CONFIG_HOME not set -> $HOME/.config/codis-agents/machine.json', mp({ HOME: '/h' }) === '/h/.config/codis-agents/machine.json');
  ok('M3. XDG_CONFIG_HOME empty -> $HOME/.config/...', mp({ XDG_CONFIG_HOME: '', HOME: '/h' }) === '/h/.config/codis-agents/machine.json');
  ok('M4. XDG_CONFIG_HOME relative -> ignored (XDG spec), $HOME/.config/...', mp({ XDG_CONFIG_HOME: 'rel/dir', HOME: '/h' }) === '/h/.config/codis-agents/machine.json');
  ok('M1. CODIS_AGENTS_MACHINE is explicit, XDG is not', C.machinePath({ CODIS_AGENTS_MACHINE: '/t/m.json' }).explicit === true && C.machinePath({ HOME: '/h' }).explicit === false);
  {
    const m = mach();
    const j = json(cfg(['json', proj()], withM(m)));
    ok('M1. config.js json reads the named file: machine.path, exists, source', !!j && j.machine && j.machine.path === m && j.machine.exists === true && j.machine.source === 'measured on a test box', JSON.stringify(j && j.machine));
    const xdg = path.join(T, 'xdg'); fs.mkdirSync(path.join(xdg, 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'codis-agents', 'machine.json'), JSON.stringify(Object.assign({}, MFULL, { slots: Object.assign({}, MFULL.slots, { heavy: 1, medium: 1 }) })));
    const j2 = json(cfg(['json', proj()], { XDG_CONFIG_HOME: xdg }, ['CODIS_AGENTS_MACHINE']));
    ok('M2. config.js json reads $XDG_CONFIG_HOME/codis-agents/machine.json', !!j2 && j2.slots.medium === 1 && j2.machine.path === path.join(xdg, 'codis-agents', 'machine.json'), JSON.stringify(j2 && j2.machine));
    const home = path.join(T, 'home'); fs.mkdirSync(path.join(home, '.config', 'codis-agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'codis-agents', 'machine.json'), JSON.stringify(Object.assign({}, MFULL, { maxDockerChains: 5 })));
    const j3 = json(cfg(['json', proj()], { HOME: home, XDG_CONFIG_HOME: 'rel/dir' }, ['CODIS_AGENTS_MACHINE']));
    ok('M4. config.js json with a relative XDG_CONFIG_HOME reads $HOME/.config/codis-agents/machine.json', !!j3 && j3.maxDockerChains === 5, all(cfg(['json', proj()], { HOME: home, XDG_CONFIG_HOME: 'rel/dir' }, ['CODIS_AGENTS_MACHINE'])));
  }
  {
    const gone = path.join(T, 'none', 'machine.json');
    let r = cfg(['json', proj()], withM(gone));
    ok('M5. CODIS_AGENTS_MACHINE names a missing file -> json exit 78 naming the path', r.status === 78 && r.stderr.includes(gone) && !r.stdout.trim(), r.status + ' ' + all(r));
    r = cfg(['shell', proj()], withM(gone));
    ok('M5. ... shell exit 78', r.status === 78 && r.stderr.includes(gone), r.status + ' ' + all(r));
    r = cfg(['check', proj()], withM(gone));
    ok('M5. ... check exit 1 naming the path', r.status === 1 && r.stderr.includes(gone), r.status + ' ' + all(r));
  }
  {
    let r = cfg(['check', proj()], noM, ['CODIS_AGENTS_MACHINE']);
    ok('M6. no machine file -> check ok with the note of the defaults and the path',
      r.status === 0 && /no machine file/.test(all(r)) && /defaults measured on a 16 GB Mac of the source project/.test(all(r)) && all(r).includes(path.join(EMPTY, 'codis-agents', 'machine.json')), r.status + ' ' + all(r));
    const j = json(cfg(['json', proj()], noM, ['CODIS_AGENTS_MACHINE']));
    ok('M6. ... json: defaults (slots 2/2/4, 6/3, ~/.cache/codis-agents/slots, swapMinMB 4000, disk 10, chains 2, context 700), machine.exists false',
      !!j && j.slots.medium === 2 && j.slots.heavy === 2 && j.slots.total === 4 && j.slots.jobsAlone === 6 && j.slots.jobsShared === 3
        && j.slots.lockDir === path.join(os.homedir(), '.cache', 'codis-agents', 'slots') && j.preconditions.swapMinMB === 4000 && j.preconditions.minFreeDiskGB === 10
        && j.maxDockerChains === 2 && j.coordinatorContextK === 700 && j.machine.exists === false && j.slots.extraHeavy === null, JSON.stringify(j && [j.slots, j.preconditions, j.machine]));
  }

  // ---- the example and the schema of the machine file know the same keys as config.js
  {
    const ex = path.join(ROOT, 'examples', 'machine.example.json');
    const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'codis-agents-machine.schema.json'), 'utf8'));
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const m = C.loadMachine(withM(ex));
    ok('the machine example validates (Q5 shape, defaults)', m.errors.length === 0 && m.values.swapMinMB === 4000 && m.values.maxDockerChains === 2 && m.values.coordinatorContextK === 700, m.errors.join('; '));
    ok('machine schema top-level keys = config.js MACHINE_SPEC', same(Object.keys(sc.properties), Object.keys(C.MACHINE_SPEC)), Object.keys(sc.properties).join());
    ok('machine schema slots keys = config.js MACHINE_SLOT_SPEC', same(Object.keys(sc.properties.slots.properties), Object.keys(C.MACHINE_SLOT_SPEC)));
    ok('machine schema slots.extraHeavy keys = config.js EXTRA_SPEC', same(Object.keys(sc.properties.slots.properties.extraHeavy.oneOf[1].properties), Object.keys(C.EXTRA_SPEC)));
    const pe = C.resolve(JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'codis-agents.example.json'), 'utf8')), { machine: C.loadMachine(noM) });
    ok('the project example carries no machine keys (no warning to migrate)', pe.errors.length === 0 && !pe.warnings.some((w) => /^warning:/.test(w)), pe.errors.concat(pe.warnings).join('; '));
  }

  // ---- V: validation of the machine file
  {
    const bad = write('{ "slots": ');
    let r = cfg(['check', proj()], withM(bad));
    ok('V1. not JSON -> check exit 1 with the path of the machine file', r.status === 1 && r.stderr.includes(bad), all(r));
    r = cfg(['json', proj()], withM(bad));
    ok('V1. ... json exit 1, nothing printed (no fallback to the defaults)', r.status === 1 && !r.stdout.trim(), r.status + ' ' + all(r));
    r = cfg(['shell', proj()], withM(bad));
    ok('V1. ... shell exit 1, nothing printed', r.status === 1 && !r.stdout.trim(), r.status + ' ' + all(r));
  }
  const merr = (m) => C.loadMachine(withM(m)).errors;
  const vbad = (m, re, name) => { const e = merr(m); ok(name, e.some((x) => re.test(x) && x.includes(m)), e.join('; ')); };
  ok('V0. the full machine file validates (Q5 shape)', merr(mach()).length === 0, merr(mach()).join('; '));
  vbad(mach({ bogus: 1 }), /bogus: unknown key/, 'V2. unknown top-level key -> error with the file and the key');
  vbad(machSlots({ bogus: 1 }), /slots\.bogus: unknown key/, 'V2. unknown slots key -> error with the file and the key');
  for (const [over, re, name] of [
    [{ slots: Object.assign({}, MFULL.slots, { medium: 0 }) }, /slots\.medium: expected a positive integer/, 'slots.medium 0'],
    [{ slots: Object.assign({}, MFULL.slots, { heavy: 1.5 }) }, /slots\.heavy: expected a positive integer/, 'slots.heavy 1.5'],
    [{ slots: Object.assign({}, MFULL.slots, { total: '4' }) }, /slots\.total: expected number/, 'slots.total a string'],
    [{ slots: Object.assign({}, MFULL.slots, { jobsAlone: 0 }) }, /slots\.jobsAlone: expected a positive integer/, 'slots.jobsAlone 0'],
    [{ slots: Object.assign({}, MFULL.slots, { jobsShared: -1 }) }, /slots\.jobsShared: expected a positive integer/, 'slots.jobsShared -1'],
    [{ swapMinMB: -1 }, /swapMinMB: expected an integer >= 0/, 'swapMinMB -1'],
    [{ swapMinMB: 1.5 }, /swapMinMB: expected an integer >= 0/, 'swapMinMB 1.5'],
    [{ minFreeDiskGB: -1 }, /minFreeDiskGB: expected a number >= 0/, 'minFreeDiskGB -1'],
    [{ maxDockerChains: 0 }, /maxDockerChains: expected a positive integer/, 'maxDockerChains 0'],
    [{ coordinatorContextK: 'x' }, /coordinatorContextK: expected number/, 'coordinatorContextK a string'],
    [{ coordinatorContextK: 0.5 }, /coordinatorContextK: expected a positive integer/, 'coordinatorContextK 0.5'],
    [{ source: 3 }, /source: expected string/, 'source a number'],
    [{ slots: 3 }, /slots: expected object/, 'slots not an object'],
  ]) vbad(mach(over), re, `V3. ${name} -> error`);
  ok('V3. swapMinMB 0 and minFreeDiskGB 0 are valid (checks off)', merr(mach({ swapMinMB: 0, minFreeDiskGB: 0 })).length === 0);
  ok('V4. slots.extraHeavy false -> valid, resolved false', merr(machSlots({ extraHeavy: false })).length === 0 && C.loadMachine(withM(machSlots({ extraHeavy: false }))).values.slots.extraHeavy === false);
  {
    const m = C.loadMachine(withM(machSlots({ extraHeavy: { freePct: 40, swapGrowMB: 0, windowS: 60 } })));
    ok('V4. slots.extraHeavy object -> kept as given', m.errors.length === 0 && JSON.stringify(m.values.slots.extraHeavy) === '{"freePct":40,"swapGrowMB":0,"windowS":60}', JSON.stringify(m.values.slots.extraHeavy) + m.errors);
    const s = Object.assign({}, MFULL.slots); delete s.extraHeavy;
    const m2 = C.loadMachine(withM(mach({ slots: s })));
    ok('V4. slots.extraHeavy left out -> null (the slot scripts decide by OS, U2a-2)', m2.errors.length === 0 && m2.values.slots.extraHeavy === null, JSON.stringify(m2.values.slots));
  }
  for (const [v, re, name] of [
    [{ freePct: 101, swapGrowMB: 256, windowS: 300 }, /slots\.extraHeavy\.freePct: expected a number 0-100/, 'freePct 101'],
    [{ freePct: -1, swapGrowMB: 256, windowS: 300 }, /slots\.extraHeavy\.freePct: expected a number 0-100/, 'freePct -1'],
    [{ freePct: 50, swapGrowMB: -1, windowS: 300 }, /slots\.extraHeavy\.swapGrowMB: expected a number >= 0/, 'swapGrowMB -1'],
    [{ freePct: 50, swapGrowMB: 256, windowS: 0 }, /slots\.extraHeavy\.windowS: expected a number > 0/, 'windowS 0'],
    [{ freePct: 50, swapGrowMB: 256, windowS: 300, gap: 1 }, /slots\.extraHeavy\.gap: unknown key/, 'an unknown key'],
    [true, /slots\.extraHeavy: expected false or an object/, 'true'],
    ['on', /slots\.extraHeavy: expected false or an object/, 'a string'],
  ]) vbad(machSlots({ extraHeavy: v }), re, `V4. slots.extraHeavy ${name} -> error`);
  vbad(machSlots({ lockDir: 'rel/slots' }), /slots\.lockDir: an absolute path or one starting with ~/, 'V5. relative slots.lockDir -> error');
  vbad(machSlots({ legacyLock: 'guards.lock' }), /slots\.legacyLock: an absolute path or one starting with ~/, 'V5. relative slots.legacyLock -> error');
  vbad(machSlots({ lockDir: '' }), /slots\.lockDir: an absolute path or one starting with ~/, 'V5. empty slots.lockDir -> error');
  ok('V5. ~ in slots.lockDir is expanded', C.loadMachine(withM(machSlots({ lockDir: '~/s' }))).values.slots.lockDir === path.join(os.homedir(), 's'));
  vbad(mach({ configVersion: 2 }), /configVersion 2 .*update the plugin/, 'V6. configVersion newer than the plugin -> error "update the plugin"');
  vbad(mach({ configVersion: 0 }), /configVersion: expected a positive integer/, 'V6. configVersion 0 -> error');
  {
    const o = Object.assign({}, MFULL); delete o.configVersion;
    const f = write(o);
    const m = C.loadMachine(withM(f));
    ok('V6. no configVersion -> a note, the values are read', m.errors.length === 0 && m.notes.some((x) => /no configVersion/.test(x) && x.includes(f)) && m.values.maxDockerChains === 3, m.errors.concat(m.notes).join('; '));
    const r = cfg(['check', proj()], withM(f));
    ok('V6. ... check exit 0 and prints the note', r.status === 0 && /no configVersion/.test(r.stderr), all(r));
  }

  // ---- P: merge with the project config
  {
    const m = mach();
    const j = json(cfg(['json', proj()], withM(m)));
    ok('P1. a project without machine keys takes the machine values (slots, lockDir, extraHeavy)',
      !!j && j.slots.heavy === 1 && j.slots.total === 3 && j.slots.lockDir === L && JSON.stringify(j.slots.extraHeavy) === JSON.stringify(MFULL.slots.extraHeavy), JSON.stringify(j && j.slots));
    const sh = cfg(['shell', proj()], withM(m));
    ok('P1. ... shell prints the machine slots', sh.status === 0 && sh.stdout.includes(`SLOT_HEAVY_N:='1'`) && sh.stdout.includes(`SLOTS_DIR:='${L}'`) && sh.stdout.includes(`SLOT_TOTAL_MAX:='3'`), all(sh));
  }
  {
    const m = mach(), p = proj({ slots: { lockDir: L, heavy: 1 } });
    let r = cfg(['check', p], withM(m));
    ok('P2. a machine key in the project equal to the machine file -> check exit 0 with a warning "move it to <machine file>"',
      r.status === 0 && /warning: slots\.lockDir: .*move it to/.test(r.stderr) && r.stderr.includes(m) && /warning: slots\.heavy: /.test(r.stderr), r.status + ' ' + all(r));
    r = cfg(['json', p], withM(m));
    ok('P2. ... json works', r.status === 0 && json(r).slots.lockDir === L, all(r));
    r = cfg(['check', proj({ slots: { lockDir: L + '/' } })], withM(m));
    ok('P2. ... the same directory spelled with a trailing slash counts as equal', r.status === 0, all(r));
  }
  {
    const m = mach(), p = proj({ slots: { lockDir: L2 } });
    let r = cfg(['check', p], withM(m));
    ok('P3. a machine key in the project that differs -> check exit 1 naming both values and both files',
      r.status === 1 && /slots\.lockDir: the project sets .*other-slots.*, the machine file sets .*machine-slots/.test(r.stderr) && r.stderr.includes(m) && r.stderr.includes(p), r.status + ' ' + all(r));
    r = cfg(['json', p], withM(m));
    ok('P3. ... json exit 1', r.status === 1 && !r.stdout.trim(), r.status + ' ' + all(r));
    r = cfg(['shell', p], withM(m));
    ok('P3. ... shell exit 1', r.status === 1 && !r.stdout.trim(), r.status + ' ' + all(r));
    r = cfg(['check', proj({ slots: { heavy: 2 } })], withM(m));
    ok('P3. ... a count that differs (slots.heavy 2 against 1) -> exit 1', r.status === 1 && /slots\.heavy: the project sets 2, the machine file sets 1/.test(r.stderr), all(r));
    r = cfg(['check', proj({ preconditions: { minFreeDiskGB: 20 } })], withM(m));
    ok('P3. ... preconditions.minFreeDiskGB that differs from minFreeDiskGB -> exit 1', r.status === 1 && /preconditions\.minFreeDiskGB: the project sets 20, the machine file sets 10/.test(r.stderr), all(r));
  }
  {
    const p = proj({ slots: { heavy: 1, lockDir: L2 }, preconditions: { minFreeDiskGB: 3 } });
    let r = cfg(['check', p], noM, ['CODIS_AGENTS_MACHINE']);
    ok('P4. machine keys in the project and no machine file -> check exit 0, a warning to run config.js migrate',
      r.status === 0 && /no machine file/.test(r.stderr) && /config\.js migrate/.test(r.stderr) && /slots\.heavy/.test(r.stderr) && /slots\.lockDir/.test(r.stderr), r.status + ' ' + all(r));
    const j = json(cfg(['json', p], noM, ['CODIS_AGENTS_MACHINE']));
    ok('P4. ... the project values apply, as before the machine file', !!j && j.slots.heavy === 1 && j.slots.lockDir === L2 && j.preconditions.minFreeDiskGB === 3 && j.slots.medium === 2, JSON.stringify(j && [j.slots, j.preconditions]));
  }
  for (const [extra, key] of [
    [{ swapMinMB: 4000 }, 'swapMinMB'], [{ maxDockerChains: 3 }, 'maxDockerChains'], [{ coordinatorContextK: 650 }, 'coordinatorContextK'],
    [{ slots: { extraHeavy: false } }, 'slots.extraHeavy'],
  ]) {
    const p = proj(extra);
    const a = cfg(['check', p], withM(mach())), b = cfg(['check', p], noM, ['CODIS_AGENTS_MACHINE']);
    const re = new RegExp(`${key.replace('.', '\\.')}: a machine setting.*machine file`);
    ok(`P5. ${key} in the project -> an error always (equal to the machine file, and with no machine file)`,
      a.status === 1 && re.test(a.stderr) && b.status === 1 && re.test(b.stderr) && !/unknown key/.test(a.stderr), a.status + ' ' + all(a) + ' | ' + b.status + ' ' + all(b));
  }
  {
    let r = cfg(['check', proj({ preconditions: { minSwapGB: 4 } })], withM(mach({ swapMinMB: 4096 })));
    ok('P6. preconditions.minSwapGB 4 against swapMinMB 4096 (x 1024) -> equal: check exit 0 with a warning', r.status === 0 && /warning: preconditions\.minSwapGB: .*swapMinMB/.test(r.stderr), r.status + ' ' + all(r));
    r = cfg(['check', proj({ preconditions: { minSwapGB: 4 } })], withM(mach({ swapMinMB: 4000 })));
    ok('P6. preconditions.minSwapGB 4 against swapMinMB 4000 -> differs: exit 1 naming 4096 MB and 4000', r.status === 1 && /preconditions\.minSwapGB: the project sets 4 GB \(4096 MB\), the machine file sets swapMinMB 4000/.test(r.stderr), r.status + ' ' + all(r));
    const j = json(cfg(['json', proj({ preconditions: { minSwapGB: 3 } })], noM, ['CODIS_AGENTS_MACHINE']));
    ok('P6. ... no machine file: the project minSwapGB applies as swapMinMB x 1024', !!j && j.preconditions.swapMinMB === 3072 && !('minSwapGB' in j.preconditions), JSON.stringify(j && j.preconditions));
  }
  {
    const p = proj({ slots: { lockDir: L2 } });
    let c = null, err = null;
    try { c = C.loadOrDefaults(T, { CODIS_AGENTS_CONFIG: p, CODIS_AGENTS_MACHINE: mach(), HOME: T }); } catch (e) { err = e; }
    ok('P7. hooks (loadOrDefaults) with a machine key that differs: no throw, the branches as configured', !err && c && c.protectedBranches.join() === 'main', String(err));
    c = null; err = null;
    try { c = C.loadOrDefaults(T, { CODIS_AGENTS_CONFIG: p, CODIS_AGENTS_MACHINE: write('{x'), HOME: T }); } catch (e) { err = e; }
    ok('P7. ... with a machine file that is not JSON: no throw, the branches as configured', !err && c && c.protectedBranches.join() === 'main', String(err));
    c = null; err = null;
    try { c = C.loadOrDefaults(T, { CODIS_AGENTS_CONFIG: p, CODIS_AGENTS_MACHINE: path.join(T, 'missing.json'), HOME: T }); } catch (e) { err = e; }
    ok('P7. ... with CODIS_AGENTS_MACHINE on a missing file: no throw, the branches as configured', !err && c && c.protectedBranches.join() === 'main', String(err));
  }
  {
    const scratch = path.join(T, 'scratch'); fs.mkdirSync(scratch);
    const r = cfg(['shell'], Object.assign(withM(mach()), { GIT_CEILING_DIRECTORIES: T }), ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR'], scratch);
    ok('P8. config.js shell without a project config prints the machine lines (exit 0), no project keys',
      r.status === 0 && r.stdout.includes(`SLOTS_DIR:='${L}'`) && r.stdout.includes(`SLOT_HEAVY_N:='1'`) && !/CODIS_REPO_DIR|GUARDS_EXCL_GLOB/.test(r.stdout), r.status + ' ' + all(r));
    const r2 = cfg(['json'], Object.assign(withM(mach()), { GIT_CEILING_DIRECTORIES: T }), ['CODIS_AGENTS_CONFIG', 'CLAUDE_PROJECT_DIR'], scratch);
    ok('P8. ... json without a project config still exit 1 (it needs the project)', r2.status === 1, r2.status + ' ' + all(r2));
  }

  // ---- J1: the resolved JSON for the chain
  {
    const j = json(cfg(['json', proj()], withM(mach({ minFreeDiskGB: 7, swapMinMB: 0 }))));
    ok('J1. json: preconditions {minFreeDiskGB, swapMinMB} from the machine, maxDockerChains, coordinatorContextK, machine {path, exists, source}',
      !!j && j.preconditions.minFreeDiskGB === 7 && j.preconditions.swapMinMB === 0 && j.maxDockerChains === 3 && j.coordinatorContextK === 650
        && j.machine.exists === true && typeof j.machine.path === 'string' && j.machine.source === 'measured on a test box', JSON.stringify(j && [j.preconditions, j.maxDockerChains, j.coordinatorContextK, j.machine]));
  }

  // ---- E: env-check against swapMinMB (MB) and minFreeDiskGB
  const GB = 1024 ** 3, MiB = 1024 ** 2;
  ok('E7. default swapMinMB 4000 (the slot scripts use the same number), disk 10', DEFAULTS.swapMinMB === 4000 && DEFAULTS.minFreeDiskGB === 10, JSON.stringify(DEFAULTS));
  let r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 4 * GB });
  ok('E7. Q3: 4 GiB of swap headroom passes the default floor', r.ok, JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 4000 * MiB }, { swapMinMB: 4000 });
  ok('E7. headroom 4000 MB against swapMinMB 4000 -> ok', r.ok, JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 3999 * MiB }, { swapMinMB: 4000 });
  ok('E4/E7. headroom 3999 MB against swapMinMB 4000 -> a problem in MB naming swapMinMB', !r.ok && /swap: 3999 MB of headroom, below 4000 MB \(swapMinMB\)/.test(r.problems[0]), JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 3999 * MiB }, { swapMinMB: 4000, machinePath: '/m/machine.json' });
  ok('E4. ... with a machine file the problem names it', !r.ok && r.problems[0].includes('swapMinMB in /m/machine.json'), JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 0 }, { swapMinMB: 0 });
  ok('E2. swapMinMB 0 -> ok with the note "swap check off (swapMinMB = 0)"', r.ok && r.notes.includes('swap check off (swapMinMB = 0)'), JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 0 }], swap: 8 * GB }, { minFreeDiskGB: 0 });
  ok('E3. minFreeDiskGB 0 -> ok with the note "disk check off (minFreeDiskGB = 0)"', r.ok && r.notes.includes('disk check off (minFreeDiskGB = 0)'), JSON.stringify(r));
  r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: null }, { swapMinMB: 4000 });
  ok('E5. swap not measurable -> a note, not a failure', r.ok && /could not be measured/.test(r.notes.join()), JSON.stringify(r));
  {
    let x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-mb', '0'], noM, ['CODIS_AGENTS_MACHINE']);
    let j = json(x);
    ok('E6. CLI with no machine file -> the note "no machine file: defaults ..."', x.status === 0 && j && j.notes.some((s) => /no machine file/.test(s) && /defaults measured on a 16 GB Mac of the source project/.test(s)), all(x));
    ok('E2. CLI --min-swap-mb 0 -> the swap check is off, said in notes', !!j && j.notes.includes('swap check off (swapMinMB = 0)'), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-mb', '0'], withM(mach()));
    j = json(x);
    ok('E6. CLI with a machine file -> no such note', x.status === 0 && j && !j.notes.some((s) => /no machine file/.test(s)), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-swap-mb', '0'], withM(mach({ minFreeDiskGB: 1e9 })));
    ok('E6. CLI without --min-disk-gb takes minFreeDiskGB of the machine file', x.status === 1 && /below 1000000000 GB \(minFreeDiskGB/.test(x.stdout), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0'], withM(mach({ swapMinMB: 0 })));
    ok('E2. CLI without --min-swap-mb takes swapMinMB 0 of the machine file -> off', x.status === 0 && json(x).notes.includes('swap check off (swapMinMB = 0)'), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-gb', '0'], noM, ['CODIS_AGENTS_MACHINE']);
    ok('E1. CLI --min-swap-gb (older chains) is still read, x 1024', x.status === 0 && json(x).notes.includes('swap check off (swapMinMB = 0)'), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-mb', '0'], withM(path.join(T, 'nope.json')));
    ok('M5. env-check with CODIS_AGENTS_MACHINE on a missing file -> not ok, the problem names it', x.status === 1 && x.stdout.includes(path.join(T, 'nope.json')), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-swap-mb', '-1'], noM);
    ok('E. CLI --min-swap-mb -1 -> usage, exit 64', x.status === 64, String(x.status));
  }

  // ---- H1: no test reads the real machine file
  ok('H1. lib.js points XDG_CONFIG_HOME at an empty temporary directory and drops CODIS_AGENTS_MACHINE',
    !process.env.CODIS_AGENTS_MACHINE && path.isAbsolute(process.env.XDG_CONFIG_HOME || '') && fs.existsSync(process.env.XDG_CONFIG_HOME)
      && fs.readdirSync(process.env.XDG_CONFIG_HOME).length === 0 && !process.env.XDG_CONFIG_HOME.startsWith(path.join(os.homedir(), '.config')), process.env.XDG_CONFIG_HOME);
  {
    const x = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'lib.js'))}); console.log(JSON.stringify([process.env.CODIS_AGENTS_MACHINE || null, require(${JSON.stringify(CONFIG)}).machinePath().path]))`],
      { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_MACHINE: '/real/machine.json', XDG_CONFIG_HOME: '/real/xdg' }) });
    let v = null; try { v = JSON.parse(x.stdout); } catch { /* below */ }
    ok('H1. ... even when the outside sets both: the machine path of a test is in its own temporary directory', !!v && v[0] === null && !v[1].startsWith('/real/') && v[1].endsWith(path.join('codis-agents', 'machine.json')), x.stdout + x.stderr);
  }
  {
    const files = fs.readdirSync(__dirname).filter((f) => /\.test\.js$/.test(f) || f === 'run.js');
    const noLib = files.filter((f) => !/require\('\.\/lib'\)/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    ok('H1. every test (and run.js, which starts the *.test.sh) requires ./lib', noLib.length === 0, noLib.join(' '));
    const own = fs.readdirSync(__dirname).filter((f) => /\.js$/.test(f)).filter((f) => {
      const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
      return /HOME:\s*os\.homedir\(\)/.test(s) && !/XDG_CONFIG_HOME|CODIS_AGENTS_MACHINE/.test(s);
    });
    ok('H1. a test that builds its own environment with the real HOME also sets XDG_CONFIG_HOME or CODIS_AGENTS_MACHINE', own.length === 0, own.join(' '));
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
