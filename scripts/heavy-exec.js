#!/usr/bin/env node
'use strict';
// The one entry of the executor for a guard run of a codex role (scripts/heavy-service.js, kinds select and full):
// guards-all.sh and guards-result.js call it for every command of the project - the runner in each mode, a single
// rerun - while CODIS_GUARDS_EXEC names the executor spec of the run. It runs outside the sandbox, inside the command
// of the run's own heavy slot (slot_run of guards-all.sh), and starts `codex sandbox` as its child, so the executor
// stays in the slot's command group, under its exec marker and under the stop of the slot's holder.
//
// The spec (<stateDir>/<task>/heavy-runs/<id>/exec.json, written by the adapter, outside the role's roots): {bin, args,
// env, label?} - the codex binary, the arguments of `codex sandbox` up to the profile (the profile of the role's
// rights, built by the adapter), the environment of the executor (its white list) and the label of the run for the
// slot journal. The wrapper adds only what the slot gives: CODIS_SLOT_HELD="heavy $SLOT_PATH" (a nested heavy.sh of
// the project runs in the held slot), SLOTS_DIR (the slot's folder) and GUARDS_EXCLUSIVE_LOCK (exported by slots.zsh;
// the file is created here when missing, never truncated, since the sandbox may only read it). Nothing else of its own
// environment reaches the executor. Then: `<bin> <args> -C <cwd> -- <argv>`, and its exit code (128 + n for a signal).
// No spec, an unreadable or invalid one, no SLOT_PATH, a codex that is not there, a lock file that cannot be created:
// the command never runs, "environment: heavy-exec: ..." on stderr and exit 69.
//
// usage: heavy-exec.js <spec.json> -- <argv...>   (64 without a command)
//        heavy-exec.js label <spec.json>          -> the label of the run, or nothing
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const env69 = (m) => { process.stderr.write(`environment: heavy-exec: ${m}\n`); process.exit(69); };
const a = process.argv.slice(2);
function readSpec(file) {
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { env69(`the executor spec ${file} cannot be read (${e.code || e.message})`); }
  const strs = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');
  if (!s || typeof s !== 'object' || typeof s.bin !== 'string' || !path.isAbsolute(s.bin) || !strs(s.args) || !s.env || typeof s.env !== 'object'
    || Object.values(s.env).some((v) => typeof v !== 'string')) env69(`the executor spec ${file} is not {bin, args, env}`);
  return s;
}
if (a[0] === 'label') {
  if (!a[1]) { process.stderr.write('usage: heavy-exec.js label <spec.json>\n'); process.exit(64); }
  const s = readSpec(a[1]);
  if (typeof s.label === 'string') process.stdout.write(s.label.replace(/[\t\n\r]/g, ' ') + '\n');
  process.exit(0);
}
const sep = a.indexOf('--');
if (sep !== 1 || a.length < 3) { process.stderr.write('usage: heavy-exec.js <spec.json> -- <argv...>\n'); process.exit(64); }
const spec = readSpec(a[0]);
const argv = a.slice(2);
const slot = process.env.SLOT_PATH;
if (!slot || !path.isAbsolute(slot)) env69('no SLOT_PATH: the executor runs only inside the command of a held heavy slot');
try { fs.accessSync(spec.bin, fs.constants.X_OK); if (!fs.statSync(spec.bin).isFile()) throw new Error('not a file'); } catch (e) { env69(`codex ${spec.bin} cannot be run (${e.code || e.message})`); }
const lock = process.env.GUARDS_EXCLUSIVE_LOCK || path.join(path.dirname(slot), 'exclusive.lock');
try { fs.closeSync(fs.openSync(lock, 'a', 0o644)); } catch (e) { env69(`the exclusive lock file ${lock} cannot be created (${e.code || e.message})`); }
const env = Object.assign({}, spec.env, { SLOTS_DIR: path.dirname(slot), CODIS_SLOT_HELD: `heavy ${slot}`, GUARDS_EXCLUSIVE_LOCK: lock });
let c;
try { c = spawn(spec.bin, spec.args.concat(['-C', process.cwd(), '--'], argv), { env, stdio: 'inherit' }); } catch (e) { env69(`codex sandbox could not be started (${e.code || e.message})`); }
// a signal sent to this process alone reaches the executor too (a stop of the group reaches both anyway)
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { c.kill(sig); } catch { /* gone */ } });
c.on('error', (e) => env69(`codex sandbox could not be started (${e.code || e.message})`));
c.on('exit', (code, sig) => process.exit(code === null ? 128 + (require('os').constants.signals[sig] || 0) : code));
