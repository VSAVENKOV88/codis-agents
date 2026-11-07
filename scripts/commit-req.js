#!/usr/bin/env node
'use strict';
// The client of the commit channel (p-codex A2a-1): a role (programmer, tester) inside its sandbox asks the role adapter
// to commit named paths and gets the sha or the reason of a refusal. The adapter commits outside the sandbox
// (scripts/commit-service.js); the role never runs git add or git commit itself.
//
// usage: node commit-req.js [--max <s>] (-m <message> | --message-file <file>) -- <path>...
//        node commit-req.js wait --id <id> [--max <s>]
// The box and the answers folder come from the environment the adapter gives a prog or test call (CODIS_COMMIT_BOX,
// CODIS_COMMIT_ANSWERS); another role has neither: "channel closed for this role". The request {id, paths, message}
// is written whole into a temporary file of the box and published by a rename (the adapter ignores temporary files);
// the id is 32 random hex digits. The client then waits for the answer at most --max seconds (default and ceiling 270:
// the longest single wait, not an interval) and prints one JSON line: {id, status: committed | nothing | refused |
// cancelled, sha?, why?, paths?, indexSync?, and with hooks of a check: checks, environment, rechecked, changed,
// untrackedInputs, ignoredChanged, walkNotes - each list its first 200 entries with a <name>Count, changesFile the whole
// lists} or {id, status: "pending"} when no answer came in time - then
// "commit-req.js wait --id <id>" waits again. A pending request stays queued; the adapter answers it in order.
// Exit: 0 committed or nothing, 1 refused or cancelled, 2 usage, 3 pending, 4 the channel is closed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_WAIT_S = 270;
const POLL_MS = 1000;
const ID_RE = /^[0-9a-f]{32}$/;
const EXIT = { committed: 0, nothing: 0, refused: 1, cancelled: 1 };

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function usage(m) {
  process.stderr.write(`commit-req: ${m}\nusage: commit-req.js [--max <s>] (-m <message> | --message-file <file>) -- <path>...\n       commit-req.js wait --id <id> [--max <s>]\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const a = { paths: null, max: MAX_WAIT_S };
const waitMode = argv[0] === 'wait';
for (let i = waitMode ? 1 : 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '--') { if (waitMode) usage('wait takes no paths'); a.paths = argv.slice(i + 1); break; }
  const v = argv[i + 1];
  if (v === undefined) usage(`${k} needs a value`);
  if (k === '--max') { if (!/^\d+$/.test(v) || +v < 1 || +v > MAX_WAIT_S) usage(`--max must be 1..${MAX_WAIT_S} seconds (the ceiling of one wait)`); a.max = +v; }
  else if (k === '-m' || k === '--message') a.message = v;
  else if (k === '--message-file') a.messageFile = v;
  else if (k === '--id' && waitMode) a.id = v;
  else usage(`unknown flag ${k}`);
  i++;
}
if (waitMode && !ID_RE.test(a.id || '')) usage('wait needs --id <32 hex digits>');
if (!waitMode) {
  if (!a.paths) usage('name the paths after --');
  if (a.messageFile !== undefined) {
    try { a.message = fs.readFileSync(a.messageFile, 'utf8'); } catch (e) { usage(`--message-file ${a.messageFile}: ${e.code || e.message}`); }
  }
  if (typeof a.message !== 'string' || !a.message.trim()) usage('a non-empty message is required (-m or --message-file)');
}

const box = process.env.CODIS_COMMIT_BOX, answers = process.env.CODIS_COMMIT_ANSWERS;
if (!box || !answers) {
  const why = 'channel closed for this role: the adapter opens the commit channel only for a programmer or tester call (no CODIS_COMMIT_BOX / CODIS_COMMIT_ANSWERS)';
  process.stderr.write(`commit-req: ${why}\n`);
  out({ status: 'closed', why });
  process.exit(4);
}

let id = a.id;
if (!waitMode) {
  id = crypto.randomBytes(16).toString('hex');
  const tmp = path.join(box, `.${id}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ id, paths: a.paths, message: a.message }), { flag: 'wx' });
    fs.renameSync(tmp, path.join(box, `${id}.json`));
  } catch (e) {
    const why = `the request could not be written into the box ${box}: ${e.code || e.message}`;
    process.stderr.write(`commit-req: ${why}\n`);
    out({ status: 'closed', why });
    process.exit(4);
  }
}

const file = path.join(answers, `${id}.json`);
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const deadline = Date.now() + a.max * 1000;
let watcher = null, timer = null;
const check = () => {
  const r = read();
  if (r) {
    if (watcher) { try { watcher.close(); } catch { /* closed */ } }
    clearTimeout(timer);
    out(r);
    process.exit(Object.prototype.hasOwnProperty.call(EXIT, r.status) ? EXIT[r.status] : 1);
  }
  if (Date.now() >= deadline) {
    if (watcher) { try { watcher.close(); } catch { /* closed */ } }
    out({ id, status: 'pending', why: `no answer within ${a.max} s: run commit-req.js wait --id ${id}` });
    process.exit(3);
  }
  timer = setTimeout(check, Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
};
try { watcher = fs.watch(answers, () => { clearTimeout(timer); setImmediate(check); }); watcher.on('error', () => { watcher = null; }); } catch { watcher = null; }
check();
