#!/usr/bin/env node
'use strict';
// Tester guard U2a-1: edges of the machine file next to tests/machine.test.js - the shape of the source project after migrate
// (the same ~ spellings in project and machine count as equal), config.js shell with no project config on a missing or
// broken machine file, a machine file that is JSON but not an object, a bad configVersion, the command line of
// env-check winning over the machine file in both directions, a broken machine file in env-check. Every case runs on a
// temporary machine file; the real one is never read (lib.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'scripts', 'config.js');
const ENVCHECK = path.join(ROOT, 'scripts', 'env-check.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codis-machine-edges-')));
const EMPTY = path.join(T, 'xdg-empty');
fs.mkdirSync(EMPTY);
let n = 0;
const write = (obj) => { const f = path.join(T, `f${n++}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const BASE = { repoDir: T, worktreeRoot: T, sharedDir: T, defaultBranch: 'main' };
const proj = (extra) => write(Object.assign({}, BASE, extra || {}));
// The slots of every project config of the source project today (analyst F-11), spelled with ~ as there.
const FC_SLOTS = { medium: 2, heavy: 2, total: 4, lockDir: '~/wt-root/_shared/slots', legacyLock: '~/wt-root/_shared/guards.lock', jobsAlone: 6, jobsShared: 3 };
const FC_MACHINE = {
  configVersion: 1, source: 'measured on a 16 GB Mac (test)', swapMinMB: 4000, minFreeDiskGB: 10, maxDockerChains: 2, coordinatorContextK: 700,
  slots: Object.assign({}, FC_SLOTS, { extraHeavy: { freePct: 50, swapGrowMB: 256, windowS: 300 } }),
};
const envOf = (extra, del) => { const e = Object.assign({}, process.env, extra || {}); for (const k of del || []) delete e[k]; return e; };
// cwd = an empty directory outside any git repository, so config.js finds no project config by itself.
const NOPROJ = path.join(T, 'noproj');
fs.mkdirSync(NOPROJ);
const run = (script, args, extra, del) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: NOPROJ, env: envOf(extra, del) });
const cfg = (args, extra, del) => run(CONFIG, args, extra, del);
const withM = (m) => ({ CODIS_AGENTS_MACHINE: m, CODIS_AGENTS_CONFIG: '' });
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const all = (r) => `[${r.status}] ` + r.stdout + r.stderr;
const HOME = os.homedir();

try {
  // ---- the shape of the source project: machine file written by migrate with its values, project config not yet cleaned
  {
    const m = write(FC_MACHINE);
    const p = proj({ slots: FC_SLOTS });
    let r = cfg(['check', p], withM(m));
    const warned = Object.keys(FC_SLOTS).every((k) => new RegExp(`warning: slots\\.${k}: a machine setting`).test(r.stderr));
    ok('source project after migrate: project slots equal to the machine file (both with ~) -> check exit 0, a warning per key, no error',
      r.status === 0 && warned && !/the project sets/.test(r.stderr) && r.stdout.includes('ok '), all(r));
    r = cfg(['json', p], withM(m));
    const j = json(r);
    ok('... json: lockDir and legacyLock expanded from ~, counts of the machine',
      r.status === 0 && !!j && j.slots.lockDir === path.join(HOME, 'wt-root/_shared/slots') && j.slots.legacyLock === path.join(HOME, 'wt-root/_shared/guards.lock')
        && j.slots.heavy === 2 && j.preconditions.swapMinMB === 4000 && j.machine.exists === true, all(r));
    r = cfg(['shell', p], withM(m));
    ok('... shell exit 0 with SLOTS_DIR of the machine', r.status === 0 && r.stdout.includes(`SLOTS_DIR:='${path.join(HOME, 'wt-root/_shared/slots')}'`), all(r));
    // The same directory, ~ in the project and absolute in the machine file: one queue, so equal.
    const m2 = write(Object.assign({}, FC_MACHINE, { slots: Object.assign({}, FC_MACHINE.slots, { lockDir: path.join(HOME, 'wt-root/_shared/slots') }) }));
    r = cfg(['check', p], withM(m2));
    ok('... lockDir ~/x in the project against $HOME/x in the machine file -> equal (warning, exit 0)', r.status === 0 && /warning: slots\.lockDir/.test(r.stderr), all(r));
    // A legacyLock that differs is a second lock: an error naming both.
    const p2 = proj({ slots: Object.assign({}, FC_SLOTS, { legacyLock: '~/elsewhere/guards.lock' }) });
    r = cfg(['check', p2], withM(m));
    ok('... legacyLock that differs -> check exit 1 naming both values and the machine file',
      r.status === 1 && /slots\.legacyLock: the project sets .*elsewhere.*the machine file sets .*wt-root/.test(r.stderr) && r.stderr.includes(m), all(r));
    r = cfg(['shell', p2], withM(m));
    ok('... shell exit 1 (slots.zsh maps it to 78), nothing printed', r.status === 1 && !r.stdout.trim(), all(r));
  }

  // ---- config.js shell without any project config
  {
    let r = cfg(['shell'], withM(path.join(T, 'missing.json')));
    ok('shell with no project, CODIS_AGENTS_MACHINE on a missing file -> exit 78 naming it, nothing on stdout',
      r.status === 78 && r.stderr.includes(path.join(T, 'missing.json')) && !r.stdout.trim(), all(r));
    r = cfg(['shell'], withM(write('{ not json')));
    ok('shell with no project, machine file not JSON -> exit 1, nothing on stdout', r.status === 1 && !r.stdout.trim(), all(r));
    r = cfg(['shell'], { XDG_CONFIG_HOME: EMPTY, CODIS_AGENTS_CONFIG: '' }, ['CODIS_AGENTS_MACHINE']);
    ok('shell with no project and no machine file -> exit 0, the built-in defaults (~/.cache/codis-agents/slots, 2/2/4)',
      r.status === 0 && r.stdout.includes(`SLOTS_DIR:='${path.join(HOME, '.cache/codis-agents/slots')}'`) && r.stdout.includes(`SLOT_HEAVY_N:='2'`) && !/CODIS_REPO_DIR/.test(r.stdout), all(r));
  }

  // ---- machine files that are JSON but not an object, and bad configVersion values
  for (const [text, name] of [['[]', 'an array'], ['null', 'null'], ['3', 'a number'], ['"x"', 'a string']]) {
    const m = write(text);
    const r = cfg(['check', proj()], withM(m));
    ok(`machine file ${name} -> check exit 1 "expected a JSON object" with the path`, r.status === 1 && /expected a JSON object/.test(r.stderr) && r.stderr.includes(m), all(r));
  }
  for (const [v, name] of [[0, '0'], [1.5, '1.5'], ['1', 'a string']]) {
    const m = write(Object.assign({}, FC_MACHINE, { configVersion: v }));
    const r = cfg(['check', proj()], withM(m));
    ok(`configVersion ${name} -> check exit 1 naming configVersion`, r.status === 1 && /configVersion/.test(r.stderr) && r.stderr.includes(m), all(r));
  }
  {
    const r = cfg(['check', proj()], withM(T));
    ok('CODIS_AGENTS_MACHINE on a directory -> check exit 1 naming it, not ok', r.status === 1 && r.stderr.includes(T) && !r.stdout.includes('ok '), all(r));
  }

  // ---- env-check: the command line wins over the machine file, both ways; a broken machine file is a problem
  {
    let m = write(Object.assign({}, FC_MACHINE, { minFreeDiskGB: 0, swapMinMB: 0 }));
    let x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '1000000000'], withM(m));
    ok('env-check: machine minFreeDiskGB 0, command line 1e9 -> the command line wins: exit 1', x.status === 1 && /below 1000000000 GB/.test(x.stdout), all(x));
    m = write(Object.assign({}, FC_MACHINE, { minFreeDiskGB: 1000000000, swapMinMB: 0 }));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0'], withM(m));
    const j = json(x);
    ok('env-check: machine minFreeDiskGB 1e9, command line 0 -> the command line wins: ok, "disk check off"',
      x.status === 0 && !!j && j.ok && j.notes.includes('disk check off (minFreeDiskGB = 0)'), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-mb', '0'], withM(write('{ broken')));
    ok('env-check: a machine file that is not JSON -> exit 1, the problem names the machine file', x.status === 1 && /machine file: .*f\d+\.json/.test(x.stdout), all(x));
    x = run(ENVCHECK, ['--path', T, '--min-disk-gb', '0', '--min-swap-mb', '0'], { XDG_CONFIG_HOME: EMPTY }, ['CODIS_AGENTS_MACHINE']);
    const j2 = json(x);
    ok('env-check: no machine file and both floors 0 -> ok, the notes say both checks are off and that there is no machine file',
      x.status === 0 && !!j2 && j2.notes.includes('swap check off (swapMinMB = 0)') && j2.notes.some((s) => /no machine file/.test(s)), all(x));
  }
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
