#!/usr/bin/env node
'use strict';
// The client of the heavy channel: a programmer or tester on codex asks the role adapter (scripts/heavy-service.js) to
// run a heavy command in a memory slot, outside its own sandbox's reach of the slots, or a guard run of its worktree.
//
// usage: node heavy-req.js [--kind <kind>] [--cwd <dir>] [--max <s>] -- <argv...>
//        node heavy-req.js --kind full [--max <s>]                    the full guard run (guards-all.sh, by the adapter)
//        node heavy-req.js --kind select --base <ref> [--max <s>]     the selection of the guards of the diff from <ref>
//        node heavy-req.js wait --id <id> [--max <s>]
//        node heavy-req.js cancel --id <id> [--max <s>]
// The box and the answers come from the environment the adapter gives a prog or test call (CODIS_HEAVY_BOX,
// CODIS_HEAVY_ANSWERS); another role has neither: "channel closed for this role". The request {id, argv, kind?, cwd?}
// is written whole into a temporary file of the box and published by a rename; the id is 32 random hex digits; cwd is
// the current folder unless --cwd names another (it must lie in the worktree); a guard run {id, kind, base?, cwd} has no
// argv: the adapter runs guards-all.sh with the run's project config, and its answer adds base, where ("local full run" |
// "local selection") and guardsLog (the guard log in the shared folder). A cancel is the file <id>.cancel. The
// client then waits for a final state at most --max seconds (default 25, ceiling 270: the longest single wait, not an
// interval) and prints the answer as one JSON line: {id, state, kind, cls, position?, why?, slot?, pgid?, log?, rc?,
// tail?}; state queued | holding | acquired | running | stopping (not final: wait again) or done | stopped |
// cancelled-before-start | undetermined | refused. rc is the code of the command; log its whole output.
// Exit: 0 done, 1 another final state, 2 usage, 3 not final yet, 4 the channel is closed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_WAIT_S = 270;
const DEFAULT_WAIT_S = 25;
const POLL_MS = 500;
const ID_RE = /^[0-9a-f]{32}$/;
const FINAL = ['done', 'stopped', 'cancelled-before-start', 'undetermined', 'refused'];

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function usage(m) {
  process.stderr.write(`heavy-req: ${m}\nusage: heavy-req.js [--kind <kind>] [--cwd <dir>] [--max <s>] -- <argv...>\n       heavy-req.js --kind full | --kind select --base <ref> [--max <s>]\n       heavy-req.js wait|cancel --id <id> [--max <s>]\n`);
  process.exit(2);
}
const argv = process.argv.slice(2);
const mode = argv[0] === 'wait' || argv[0] === 'cancel' ? argv[0] : 'run';
const a = { max: DEFAULT_WAIT_S };
for (let i = mode === 'run' ? 0 : 1; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--') { if (mode !== 'run') usage(`${mode} takes no command`); a.argv = argv.slice(i + 1); break; }
  const v = argv[i + 1];
  if (v === undefined) usage(`${k} needs a value`);
  if (k === '--max') { if (!/^\d+$/.test(v) || +v < 1 || +v > MAX_WAIT_S) usage(`--max must be 1..${MAX_WAIT_S} seconds (the ceiling of one wait)`); a.max = +v; }
  else if (k === '--kind' && mode === 'run') a.kind = v;
  else if (k === '--cwd' && mode === 'run') a.cwd = v;
  else if (k === '--base' && mode === 'run') a.base = v;
  else if (k === '--id' && mode !== 'run') a.id = v;
  else usage(`unknown flag ${k}`);
  i++;
}
if (mode !== 'run' && !ID_RE.test(a.id || '')) usage(`${mode} needs --id <32 hex digits>`);
const guardRun = mode === 'run' && (a.kind === 'full' || a.kind === 'select');
if (guardRun && a.argv) usage(`--kind ${a.kind} takes no command: the adapter runs guards-all.sh`);
if (guardRun && (a.kind === 'select') !== (a.base !== undefined)) usage(a.kind === 'select' ? '--kind select needs --base <ref>' : '--base belongs to --kind select');
if (!guardRun && a.base !== undefined) usage('--base belongs to --kind select');
if (mode === 'run' && !guardRun && !(a.argv && a.argv.length)) usage('name the command after --');

const box = process.env.CODIS_HEAVY_BOX, answers = process.env.CODIS_HEAVY_ANSWERS;
const closed = (why) => { process.stderr.write(`heavy-req: ${why}\n`); out({ state: 'closed', why }); process.exit(4); };
if (!box || !answers) closed('channel closed for this role: the adapter opens the heavy channel only for a programmer or tester call on codex (no CODIS_HEAVY_BOX / CODIS_HEAVY_ANSWERS)');

let id = a.id;
try {
  if (mode === 'run') {
    id = crypto.randomBytes(16).toString('hex');
    const req = guardRun ? { id, cwd: path.resolve(a.cwd || process.cwd()) } : { id, argv: a.argv, cwd: path.resolve(a.cwd || process.cwd()) };
    if (a.kind) req.kind = a.kind;
    if (a.base !== undefined) req.base = a.base;
    const tmp = path.join(box, `.${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(req), { flag: 'wx' });
    fs.renameSync(tmp, path.join(box, `${id}.json`));
  } else if (mode === 'cancel') {
    fs.writeFileSync(path.join(box, `${id}.cancel`), '');
  }
} catch (e) { closed(`the request could not be written into the box ${box}: ${e.code || e.message}`); }

const file = path.join(answers, `${id}.json`);
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const deadline = Date.now() + a.max * 1000;
const tick = () => {
  const r = read();
  if (r && FINAL.includes(r.state)) { out(r); process.exit(r.state === 'done' ? 0 : 1); }
  if (Date.now() >= deadline) {
    out(Object.assign({ id, state: 'pending' }, r || {}, { next: `node ${__filename} wait --id ${id} --max 25` }));
    process.exit(3);
  }
  setTimeout(tick, Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
};
tick();
