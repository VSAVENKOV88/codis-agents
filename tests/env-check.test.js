#!/usr/bin/env node
'use strict';
// scripts/env-check.js: free disk on every given path and swap headroom against the floors of the config
// (minFreeDiskGB in GB and swapMinMB in MB, of the machine file; defaults 10 and 4000); an unmeasurable swap is a note,
// not a failure; the CLI prints JSON and exits 0 / 1 / 64. The machine file cases are in tests/machine.test.js.
const path = require('path');
const { spawnSync } = require('child_process');
const { judge, DEFAULTS } = require('../scripts/env-check');
const { ok, done } = require('./lib');

const GB = 1024 ** 3;
ok('defaults: 10 GB of disk, 4000 MB of swap', DEFAULTS.minFreeDiskGB === 10 && DEFAULTS.swapMinMB === 4000);
let r = judge({ disk: [{ path: '/a', bytes: 50 * GB }, { path: '/b', bytes: 11 * GB }], swap: 5 * GB });
ok('room everywhere -> ok, no problems', r.ok && !r.problems.length && r.disk[1].freeGB === 11 && r.swapGB === 5, JSON.stringify(r));
r = judge({ disk: [{ path: '/a', bytes: 50 * GB }, { path: '/b', bytes: 2 * GB }], swap: 5 * GB });
ok('one volume below the disk floor -> not ok, the problem names the path and the config key',
  !r.ok && r.problems.length === 1 && /\/b: 2 GB free, below 10 GB \(minFreeDiskGB\)/.test(r.problems[0]), JSON.stringify(r));
r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: 1 * GB });
ok('swap below its floor -> not ok, names swapMinMB', !r.ok && /swap: 1024 MB.*below 4000 MB \(swapMinMB\)/.test(r.problems[0]), JSON.stringify(r));
r = judge({ disk: [{ path: '/a', bytes: 3 * GB }], swap: 1 * GB }, { minFreeDiskGB: 2, swapMinMB: 512 });
ok('floors from the config win over the defaults', r.ok, JSON.stringify(r));
r = judge({ disk: [{ path: '/a', bytes: 50 * GB }], swap: null });
ok('swap not measurable -> ok with a note (not silent)', r.ok && r.swapGB === null && /could not be measured/.test(r.notes[0]), JSON.stringify(r));
r = judge({ disk: [{ path: '/gone', error: 'ENOENT' }], swap: 5 * GB });
ok('a path that cannot be measured -> not ok', !r.ok && /\/gone: ENOENT/.test(r.problems[0]), JSON.stringify(r));

const cli = (a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'env-check.js'), ...a], { encoding: 'utf8' });
let x = cli(['--path', __dirname, '--min-disk-gb', '0', '--min-swap-mb', '0']);
let j = null; try { j = JSON.parse(x.stdout); } catch { /* checked below */ }
ok('CLI: floors 0 -> exit 0 and JSON with the measured disk', x.status === 0 && j && j.ok && j.disk[0].path === __dirname && j.disk[0].freeGB >= 0, x.stdout + x.stderr);
x = cli(['--path', __dirname, '--min-disk-gb', '1e9']);
ok('CLI: an impossible floor -> exit 1 with the problem', x.status === 1 && /\(minFreeDiskGB/.test(x.stdout), x.stdout + x.stderr);
x = cli([]);
ok('CLI: no --path -> usage, exit 64', x.status === 64, String(x.status));
x = cli(['--path', __dirname, '--min-disk-gb', 'x']);
ok('CLI: a non-numeric floor -> usage, exit 64', x.status === 64, String(x.status));
done();
