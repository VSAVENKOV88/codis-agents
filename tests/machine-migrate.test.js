#!/usr/bin/env node
'use strict';
// config.js migrate (ENV-6d, cell P-1): the older machine keys of a project config (slots.*, preconditions.*) move into
// the machine file. Without --write it only prints what the machine file would become and what to remove from the
// project config; with --write it writes the machine file (creating it and its directory). It never edits the project
// config, and it refuses - writing nothing - where config.js check sees two values of a machine setting. Every case
// runs on a temporary machine file named by CODIS_AGENTS_MACHINE; the real machine file is never read or written.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'scripts', 'config.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codis-migrate-')));
let n = 0;
const write = (obj) => { const f = path.join(T, `p${n++}.json`); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n'); return f; };
const BASE = { repoDir: T, worktreeRoot: T, sharedDir: T, defaultBranch: 'main' };
const proj = (extra) => write(Object.assign({}, BASE, extra || {}));
const mfile = (name) => path.join(T, 'm', String(n++), name || 'machine.json');
const putM = (obj) => { const f = mfile(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n'); return f; };
// m null: no CODIS_AGENTS_MACHINE, and the empty XDG_CONFIG_HOME lib.js gives this process - no machine file at all.
const cfg = (args, m) => spawnSync(process.execPath, [CONFIG, ...args], { encoding: 'utf8', cwd: T, env: Object.assign({}, process.env, m ? { CODIS_AGENTS_MACHINE: m } : {}) });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const all = (r) => `exit ${r.status}\n${r.stdout}${r.stderr}`;
const OLD = { slots: { heavy: 1, total: 3, lockDir: '~/.cache/test-slots' }, preconditions: { minFreeDiskGB: 3, minSwapGB: 4 } };

try {
  // ---- no machine file: print, then write
  {
    const p = proj(OLD), before = read(p), m = mfile();
    let r = cfg(['migrate', p], m);
    let shown = null;
    try { shown = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)); } catch { /* checked below */ }
    ok('P-1a. no machine file, migrate without --write: exit 0, the machine file it would write on stdout (values in the machine units, ~ kept)',
      r.status === 0 && !!shown && shown.configVersion === 1 && shown.slots.heavy === 1 && shown.slots.total === 3 && shown.slots.lockDir === '~/.cache/test-slots'
      && shown.minFreeDiskGB === 3 && shown.swapMinMB === 4096 && !('preconditions' in shown) && !('medium' in shown.slots), all(r));
    ok('P-1a. ... writes nothing and names --write', !fs.existsSync(m) && !fs.existsSync(path.dirname(m)) && /--write/.test(r.stdout + r.stderr), all(r));
    ok('P-1a. ... names every key to remove from the project config', ['slots.heavy', 'slots.total', 'slots.lockDir', 'preconditions.minFreeDiskGB', 'preconditions.minSwapGB'].every((k) => (r.stdout + r.stderr).includes(k)), all(r));
    ok('P-1a. ... the project config is not changed', read(p) === before);
    r = cfg(['migrate', p, '--write'], m);
    const w = JSON.parse(read(m) || 'null');
    ok('P-1b. --write: exit 0, the machine file (and its directory) created with the moved values',
      r.status === 0 && !!w && w.configVersion === 1 && w.slots.heavy === 1 && w.slots.total === 3 && w.slots.lockDir === '~/.cache/test-slots' && w.minFreeDiskGB === 3 && w.swapMinMB === 4096
      && typeof w.source === 'string' && w.source.length > 0, all(r) + '\n' + read(m));
    ok('P-1b. ... the project config is not changed, the output says what to remove from it', read(p) === before && /remove/.test(r.stdout + r.stderr) && (r.stdout + r.stderr).includes('slots.heavy'), all(r));
    const c = cfg(['check', p], m);
    ok('P-1b. ... afterwards check: exit 0, a "same value" warning per key, no two values and no warning to migrate',
      c.status === 0 && (c.stderr.match(/sets the same value/g) || []).length === 5 && !/two values/.test(c.stderr) && !/config\.js migrate/.test(c.stderr), all(c));
    const again = read(m);
    r = cfg(['migrate', p, '--write'], m);
    ok('P-1c. migrate again (the machine file sets the same values): exit 0, the machine file unchanged, still names the keys to remove',
      r.status === 0 && read(m) === again && (r.stdout + r.stderr).includes('slots.lockDir'), all(r));
  }
  // ---- an existing machine file: its other keys stay, keys it lacks are added when they equal the default
  {
    const m = putM({ configVersion: 1, source: 'measured on a test box', maxDockerChains: 3, slots: { heavy: 1 } });
    const p = proj({ slots: { heavy: 1, jobsAlone: 6 } }), before = read(p);
    const r = cfg(['migrate', p, '--write'], m);
    const w = JSON.parse(read(m) || 'null');
    ok('P-1d. an existing machine file: its own keys and source stay, a key it lacks (equal to the default) is added',
      r.status === 0 && !!w && w.source === 'measured on a test box' && w.maxDockerChains === 3 && w.slots.heavy === 1 && w.slots.jobsAlone === 6 && read(p) === before, all(r) + '\n' + read(m));
    ok('P-1d. ... check afterwards: exit 0', cfg(['check', p], m).status === 0);
  }
  // ---- refusals: two values, nothing written
  {
    const m = putM({ configVersion: 1, slots: { heavy: 1, lockDir: '/tmp/a-slots' } }), bm = read(m);
    const p = proj({ slots: { heavy: 2, lockDir: '/tmp/b-slots', total: 3 } }), bp = read(p);
    for (const args of [['migrate', p], ['migrate', p, '--write']]) {
      const r = cfg(args, m);
      ok(`P-1e. two values (the machine file sets heavy 1, the project 2) - ${args.slice(2).join(' ') || 'print'}: exit 1, both keys named, nothing written`,
        r.status === 1 && /two values/.test(r.stderr) && /slots\.heavy/.test(r.stderr) && /slots\.lockDir/.test(r.stderr) && read(m) === bm && read(p) === bp && !r.stdout.includes('{'), all(r));
    }
    // A key the machine file lacks reads as its default there: a project value that differs is two values as well
    // (config.js check says so), not a silent change of every other project's value on this machine.
    const m2 = putM({ configVersion: 1, slots: { heavy: 1 } }), bm2 = read(m2);
    const r = cfg(['migrate', proj({ slots: { jobsAlone: 4 } }), '--write'], m2);
    ok('P-1e. a key the machine file lacks, the project differs from its default (jobsAlone 4 against 6): exit 1, two values, nothing written',
      r.status === 1 && /two values/.test(r.stderr) && /slots\.jobsAlone/.test(r.stderr) && read(m2) === bm2, all(r));
    const m3 = putM({ configVersion: 1, swapMinMB: 4000 }), bm3 = read(m3);
    const r3 = cfg(['migrate', proj({ preconditions: { minSwapGB: 4 } }), '--write'], m3);
    ok('P-1e. preconditions.minSwapGB 4 (4096 MB) against swapMinMB 4000: exit 1, two values, nothing written',
      r3.status === 1 && /two values/.test(r3.stderr) && /minSwapGB/.test(r3.stderr) && read(m3) === bm3, all(r3));
  }
  // ---- refusals: what cannot be written into a machine file
  {
    const m = mfile();
    let r = cfg(['migrate', proj({ slots: { lockDir: 'rel/slots' } }), '--write'], m);
    ok('P-1f. a relative slots.lockDir (a machine file takes absolute or ~): exit 1, nothing written', r.status === 1 && /slots\.lockDir/.test(r.stderr) && !fs.existsSync(m), all(r));
    r = cfg(['migrate', proj({ preconditions: { minSwapGB: 3.9 } }), '--write'], m);
    ok('P-1f. preconditions.minSwapGB 3.9 (not a whole number of MB): exit 1, nothing written', r.status === 1 && /minSwapGB/.test(r.stderr) && !fs.existsSync(m), all(r));
    r = cfg(['migrate', proj({ slots: { heavy: 'two' } }), '--write'], m);
    ok('P-1f. a wrong type (slots.heavy "two"): exit 1, nothing written', r.status === 1 && /slots\.heavy/.test(r.stderr) && !fs.existsSync(m), all(r));
    const bad = putM('{ not json'), bb = read(bad);
    r = cfg(['migrate', proj(OLD), '--write'], bad);
    ok('P-1f. a broken machine file: exit 1, it is not overwritten', r.status === 1 && read(bad) === bb, all(r));
    r = cfg(['migrate', write('{ not json'), '--write'], m);
    ok('P-1f. a broken project config: exit 1, nothing written', r.status === 1 && !fs.existsSync(m), all(r));
  }
  // ---- nothing to move
  {
    const m = mfile();
    const r = cfg(['migrate', proj(), '--write'], m);
    ok('P-1g. no machine keys in the project config: exit 0, says so, writes nothing', r.status === 0 && /no machine settings/.test(r.stdout + r.stderr) && !fs.existsSync(m), all(r));
  }
  // ---- the command is named where it is used
  {
    const r = cfg(['no-such-command', proj()], null);
    ok('P-1h. the usage line names migrate', r.status === 64 && /migrate/.test(r.stderr), all(r));
    const c = cfg(['check', proj(OLD)], null);
    ok('P-1h. the warning of check (no machine file) names migrate and --write', c.status === 0 && /config\.js migrate/.test(c.stderr) && /--write/.test(c.stderr), all(c));
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    ok('P-1h. README explains config.js migrate: --write, the project config is not changed, two values refused',
      /config\.js migrate[^\n]*--write/.test(readme) && /migrate[^\n]*never (edits|changes) the project config/.test(readme) && /migrate[^\n]*two values/.test(readme));
  }
} catch (e) {
  ok('no exception', false, e && e.stack);
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}
done();
