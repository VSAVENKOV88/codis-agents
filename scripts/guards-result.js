#!/usr/bin/env node
'use strict';
// What guards-all.sh does after a full guard run and before the next one.
//
// 1. Rerun of new reds one by one (project config `guardRerun`). A full run under load turns some guards red that are
//    green alone (6 of 17 full runs once ended red that way, each costing a programmer round or a stopped task). After
//    a red full run, in the same slot, every new red named in the log runs once more alone:
//      red again   -> "new red": a regression, the runner's exit code stays;
//      green alone -> "flaky": red under load only, not a regression; listed for the project backlog.
//    Only flaky -> exit 0. The names come from the log by `newRedPattern` (capture group 1, per line); the reruns happen
//    only when the log reached its tally (`tallyPattern`, when set) and names no more than `maxReruns` guards, so a run
//    cut off before its tally (an environment red) or a mass red keeps the runner's code untouched.
//    Known reds (project config `guardBaseline`, owner decision U-20): a JSON file {"<guard name>": "<reason>"} in the
//    project's repository, its path relative to the worktree (it changes in the same commit as the fix, so the reuse
//    below never keeps an old answer). The names of the log found there are subtracted before maxReruns is counted and
//    never rerun; only known reds -> exit 0 and "N known red". A known name that is not red in a finished run is named
//    ("known red not red now: X — remove it from the baseline"), the code is not changed for it. A baseline that is
//    missing or broken is an error line and the runner's code stands: never "all known" in silence.
//    Quarantine (p-train, UC-5): a guard red in the full run and green alone is written into the project's quarantine
//    file <sharedDir>/guards-quarantine.json, the same flat format: {"<guard>": "flaky: <log> <sha7>, green alone,
//    <date>"} ("quarantined: G (<file>)" in the summary). It lives outside the worktree on purpose: the tracked tree
//    stays clean, so the reuse, the remote runner and the tester's post-check are untouched. Every run subtracts
//    guardBaseline and the quarantine (a name in both: the reason of guardBaseline); the quarantine is written under a
//    lock (<file>.lock, a stale one is broken) through a temporary file and a rename, never rewritten when it is broken
//    (an error line, as for a broken baseline). A write that fails is an error line; the exit code does not change for
//    it. Entries whose reason starts with "flaky:" are never named as "not red now" (they are green most of the time).
//    The quarantine is on only with guardBaseline (otherwise "quarantine off: no guardBaseline ..." when a guard was
//    flaky). Its file belongs to this machine: a run on the remote runner (scripts/guards-remote.js) sends it with the
//    run, the runner subtracts it read-only (guards-all.sh --quarantine-read-only) and this machine writes the flaky
//    guards of the log that comes back (flakyInLog, writeFlaky); --no-quarantine neither reads nor writes it. The
//    coordinator moves entries into guardBaseline and commits it (quarantine-take) or drops them after a fix
//    (quarantine-drop). The hash of the quarantine file at the end of the run is kept in the meta: reuse refuses when
//    the file changed since.
// 2. Reuse. The log has a record next to it (<log>.meta.json): HEAD and whether the tracked tree was clean at the
//    start and at the end, the guard command template, the final exit code. A full run on the same HEAD with a clean
//    tracked tree, the same command and a final exit code 0 is not repeated (guards-all.sh prints "reused, HEAD <sha>"
//    and the saved summary; --force runs anyway). Untracked files do not count: guard runs and probes leave them.
//    The record names the environment of the run (env: "remote:<host>" for a run on the remote runner,
//    scripts/guards-remote.js; a record without it is a run on this machine, "local"): a result is reused only in the
//    environment it came from - a green run here says nothing of the runner and the other way round.
//
// usage: guards-result.js rerun <wt> <log> <runner rc> <guardRerun JSON> [<guardBaseline> [<quarantine file> [ro]]]
//          (ro: the quarantine is subtracted, never written - the remote runner, guards-all.sh --quarantine-read-only); select: the same on a selection, guards-all.sh --select
//          -> summary on stdout, appended to the log; exit = final code
//        guards-result.js meta-start <wt> <log> <command template> [<env>]
//        guards-result.js meta-end <wt> <log> <final rc> [<quarantine file>]
//        guards-result.js reuse <wt> <log> <command template> [<env> [<quarantine file>]]
//                                                                         -> exit 0 and the message when reusable,
//                                                                            exit 1 and the reason otherwise
//        guards-result.js quarantine-take <wt> <guardBaseline> <quarantine file> [<guard>...]
//          -> the entries (all, or the named ones) move into guardBaseline of the worktree, which the caller commits
//        guards-result.js quarantine-drop <quarantine file> <guard>...   -> the named entries leave the quarantine
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const subst = (cmd, wt, name) => cmd.replace(/\{wt\}/g, () => q(wt)).replace(/\{name\}/g, () => q(name));

// {names, tally}: the new reds named in the log (unique, in order) and whether the log reached its tally.
function newReds(log, cfg) {
  const re = new RegExp(cfg.newRedPattern, 'gm');
  const names = [];
  for (const m of log.matchAll(re)) { const n = (m[1] || '').trim(); if (n && !names.includes(n)) names.push(n); }
  const tally = !cfg.tallyPattern || new RegExp(cfg.tallyPattern, 'm').test(log);
  return { names, tally };
}

const rerunLog = (log) => (log.endsWith('.txt') ? log.slice(0, -4) : log) + '.rerun.txt';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
// A flat known-red file (absolute path) -> {known: {name: reason}, hash} (hash: sha256 of the bytes read) or {error, code}.
function readKnown(file) {
  let raw, o;
  try { raw = fs.readFileSync(file); } catch (e) { return { error: e.code === 'ENOENT' ? 'no such file' : `not readable (${e.message})`, code: e.code }; }
  try { o = JSON.parse(raw.toString('utf8')); } catch (e) { return { error: `not readable as JSON (${e.message})` }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'expected a JSON object {"<guard name>": "<reason>"}' };
  const bad = Object.keys(o).filter((k) => typeof o[k] !== 'string');
  if (bad.length) return { error: `the reason of ${bad.join(', ')} is not a string (expected {"<guard name>": "<reason>"})` };
  return { known: o, hash: sha256(raw) };
}
// The known reds of the baseline file (path relative to wt): {known: {name: reason}} or {error}.
function readBaseline(wt, rel) {
  const r = readKnown(path.resolve(wt, rel));
  if (r.code === 'ENOENT') return { error: 'no such file in the worktree' };
  return r.error ? { error: r.error } : { known: r.known };
}

const QUARANTINE = 'guards-quarantine.json';
const quarantineFile = (sharedDir) => path.join(sharedDir, QUARANTINE);
const FLAKY = /^flaky:/;
// Copies own entries without the "__proto__" setter (JSON.parse makes "__proto__" an own key; Object.assign would set
// the prototype instead): a guard may be named so.
const merge = (...objs) => { const o = {}; for (const s of objs) for (const k of Object.keys(s)) Object.defineProperty(o, k, { value: s[k], enumerable: true, writable: true, configurable: true }); return o; };

// The quarantine file (a relative path is taken from the cwd, once): {known, hash} - {} and hash "none" when it does
// not exist yet - or {error}. hash is that of the bytes read (the same as quarantineHash of that content).
function readQuarantine(file) {
  const r = readKnown(path.resolve(file));
  if (r.code === 'ENOENT') return { known: {}, hash: 'none' };
  return r.error ? { error: r.error } : r;
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Runs fn under <file>.lock (a directory: mkdir is atomic). A lock older than STALE is left by a dead writer and broken
// under a second lock <file>.lock.break, which rechecks the age first: a writer that saw the stale lock never removes a
// fresh lock another writer took after breaking it (a break lock older than STALE is itself left by a dead breaker).
// Throws "the lock <file>.lock was not taken in <ms> ms" when it cannot be taken in time.
function withLock(file, fn) {
  const lock = `${file}.lock`, brk = `${lock}.break`, wait = Number(process.env.CODIS_QUARANTINE_LOCK_MS) || 10000, STALE = 60000;
  const stale = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs > STALE; } catch { return false; } };
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (stale(lock)) {
        let held = false;
        try { fs.mkdirSync(brk); held = true; } catch (b) { if (b.code !== 'EEXIST') throw b; if (stale(brk)) try { fs.rmdirSync(brk); } catch { /* gone */ } }
        if (held) {
          try { if (stale(lock)) fs.rmdirSync(lock); } catch { /* gone already */ } finally { try { fs.rmdirSync(brk); } catch { /* gone */ } }
          continue;
        }
      }
      if (Date.now() - t0 >= wait) throw new Error(`the lock ${lock} was not taken in ${wait} ms`);
      sleepMs(50);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* gone already */ } }
}
const writeJson = (file, o) => {
  const t = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(t, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(t, file); } finally { fs.rmSync(t, { force: true }); }
};
// Adds the entries the file does not have yet; an existing entry keeps its reason. -> {add: [names written], before,
// after}: the hash of the file under the lock before and after the write. Throws on a broken file (never rewritten) or
// a failed write.
function addQuarantineAt(file, entries) {
  file = path.resolve(file);
  return withLock(file, () => {
    const q = readQuarantine(file);
    if (q.error) throw new Error(`the file is broken: ${q.error}`);
    const add = Object.keys(entries).filter((n) => !Object.hasOwn(q.known, n));
    if (add.length) writeJson(file, merge(q.known, merge(...add.map((n) => ({ [n]: entries[n] })))));
    return { add, before: q.hash, after: add.length ? quarantineHash(file) : q.hash };
  });
}
// -> [names written]
const addQuarantine = (file, entries) => addQuarantineAt(file, entries).add;
// Removes the named entries -> {dropped, missing}.
function dropQuarantine(file, names) {
  file = path.resolve(file);
  return withLock(file, () => {
    const q = readQuarantine(file);
    if (q.error) throw new Error(`the quarantine ${file} is broken: ${q.error}`);
    const dropped = names.filter((n) => Object.hasOwn(q.known, n)), missing = names.filter((n) => !Object.hasOwn(q.known, n));
    for (const n of dropped) delete q.known[n];
    if (dropped.length) writeJson(file, q.known);
    return { dropped, missing };
  });
}
// Moves entries (all, or the named ones) from the quarantine into guardBaseline of the worktree (an entry already there
// keeps the reason of guardBaseline) and drops them from the quarantine -> {moved, missing}. Nothing changes when
// either file is broken.
function takeQuarantine(wt, baseline, file, names) {
  file = path.resolve(file);
  return withLock(file, () => {
    const q = readQuarantine(file);
    if (q.error) throw new Error(`the quarantine ${file} is broken: ${q.error}`);
    const bf = path.resolve(wt, baseline);
    const b = fs.existsSync(bf) ? readBaseline(wt, baseline) : { known: {} };
    if (b.error) throw new Error(`guardBaseline ${baseline} is broken: ${b.error}`);
    const want = names && names.length ? names : Object.keys(q.known);
    const moved = want.filter((n) => Object.hasOwn(q.known, n)), missing = want.filter((n) => !Object.hasOwn(q.known, n));
    if (!moved.length) return { moved, missing };
    writeJson(bf, merge(b.known, ...moved.filter((n) => !Object.hasOwn(b.known, n)).map((n) => ({ [n]: q.known[n] }))));
    for (const n of moved) delete q.known[n];
    writeJson(file, q.known);
    return { moved, missing };
  });
}
const quarantineHash = (file) => { try { return sha256(fs.readFileSync(path.resolve(file))); } catch { return 'none'; } };

// {rc, repeated: [{name, rc}], flaky: [names], known: [names], quarantined: [names], text, quarantineHash?}. text is
// appended to the log (empty for a green run without a baseline). quarantine: the path of the quarantine file, '' when
// it is off. quarantineHash: the hash of the quarantine this run subtracted (read at its start; after its own write the
// hash of the written file, but only when nobody changed the file between the read and the write), for the meta.
// readOnly: the quarantine is read and subtracted, never written (the remote runner: the machine that started the run
// writes the flaky guards of the log it gets back, scripts/guards-remote.js); 'select' - a selection of a task's guards
// (guards-all.sh --select): nothing is written anywhere, the flaky guards go into the role's report.
function rerun({ wt, log, rc, cfg, baseline, quarantine, readOnly }) {
  const res = { rc, repeated: [], flaky: [], known: [], quarantined: [], text: '' };
  const head = '==== rerun of new reds one by one (guardRerun) ====\n';
  const finish = (text) => { res.text = text; fs.appendFileSync(log, '\n' + text); return res; };
  let bl = null, ql = { known: {} };
  if (baseline) {
    bl = readBaseline(wt, baseline);
    if (bl.error) return finish(`${head}guardBaseline ${baseline}: ${bl.error}: nothing is subtracted and nothing reruns, the runner's exit code ${rc} stands\n`);
    if (quarantine) {
      ql = readQuarantine(quarantine);
      if (!ql.error) res.quarantineHash = ql.hash;
      if (ql.error) return finish(`${head}quarantine ${quarantine}: ${ql.error}: nothing is subtracted and nothing reruns, the runner's exit code ${rc} stands\n`);
    }
  }
  const tree = bl ? bl.known : {};
  const known = merge(ql.known, tree);
  const source = (n) => (Object.hasOwn(tree, n) ? `guardBaseline ${baseline}` : `quarantine ${quarantine}`);
  const p = newReds(fs.readFileSync(log, 'utf8'), cfg);
  // a known name not red in a finished run: the fix landed, the entry is stale (a flaky one is green most of the time)
  const stale = p.tally ? Object.keys(known).filter((n) => !p.names.includes(n) && !FLAKY.test(known[n])) : [];
  const staleText = stale.map((n) => `known red not red now: ${n} — remove it from the ${Object.hasOwn(tree, n) ? `baseline ${baseline}` : `quarantine ${quarantine}`}\n`).join('');
  if (rc === 0) return staleText ? finish(head + staleText) : res;
  const max = cfg.maxReruns || 10;
  res.known = p.names.filter((n) => Object.hasOwn(known, n));
  const fresh = p.names.filter((n) => !Object.hasOwn(known, n));
  const knownText = res.known.map((n) => `known red (${source(n)}): ${n} — ${known[n]}\n`).join('') + staleText;
  let text;
  if (!p.tally) text = `${head}no tally in the log (the run was cut off before it): nothing reruns, the runner's exit code ${rc} stands\n`;
  else if (!p.names.length) text = `${head}no new reds found in the log by newRedPattern: nothing reruns, the runner's exit code ${rc} stands\n`;
  else if (!fresh.length) {
    res.rc = 0;
    text = `${head}${knownText}${res.known.length} known red, no new reds: nothing reruns, exit 0\n`;
  } else if (fresh.length > max) text = `${head}${knownText}${fresh.length} new reds, more than maxReruns ${max}: nothing reruns (not flakiness), the runner's exit code ${rc} stands\n`;
  else {
    const details = rerunLog(log);
    fs.writeFileSync(details, '');
    for (const name of fresh) {
      const cmd = subst(cfg.command, wt, name);
      fs.appendFileSync(details, `==== ${name}: ${cmd}\n`);
      const r = spawnSync('zsh', ['-c', cmd], { cwd: wt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const code = r.status === null ? `signal ${r.signal}` : r.status;
      fs.appendFileSync(details, `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message + '\n' : ''}==== exit ${code}\n\n`);
      if (r.status === 0) res.flaky.push(name); else res.repeated.push({ name, rc: code });
    }
    if (!res.repeated.length) res.rc = 0;
    let qText = '';
    if (res.flaky.length) {
      if (!baseline) qText = 'quarantine off: no guardBaseline in the project config\n';
      else if (!quarantine) qText = 'quarantine off on this run (--no-quarantine): nothing written\n';
      else if (readOnly === 'select') qText = 'quarantine read-only on a selection (guards-all.sh --select): nothing written; name the flaky guards under "Flaky guards" in the role\'s report\n';
      else if (readOnly) qText = 'quarantine read-only on this run (the remote runner): the machine that started the run writes it\n';
      else {
        const w = writeFlaky({ wt, log, names: res.flaky, quarantine, baseline, readHash: ql.hash });
        if (w.hash !== undefined) res.quarantineHash = w.hash;
        res.quarantined = w.quarantined;
        qText = w.text;
      }
    }
    text = head + knownText
      + res.repeated.map((x) => `new red, red again alone: ${x.name} (exit ${x.rc})\n`).join('')
      + res.flaky.map((n) => `flaky, red under load, green alone: ${n}\n`).join('')
      + `rerun: ${fresh.length} new reds -> ${res.repeated.length} repeated, ${res.flaky.length} flaky${res.known.length ? `; ${res.known.length} known red` : ''}; exit ${res.rc}\n`
      + (res.flaky.length ? `flaky guards (not a regression; put them into the project backlog): ${res.flaky.join(', ')}\n` : '')
      + qText
      + `single runs: ${details}\n`;
  }
  return finish(text);
}

// The reason of a quarantine entry written by the run of <log> in <wt>: "flaky: <log name> <sha7>, green alone, <date>".
function flakyReason(wt, log) {
  const h = spawnSync('git', ['-C', wt, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' });
  const sha = h.status === 0 ? h.stdout.trim() : 'no-HEAD', day = new Date().toISOString().slice(0, 10);
  return `flaky: ${path.basename(log)} ${sha}, green alone, ${day}`;
}
// Writes the flaky guards into the quarantine -> {quarantined, text, hash?}: text is the summary line ("quarantined: ..."
// or "quarantine not written: ..."); hash is that of the written file, only when nobody changed the file since the run
// read it (readHash), for the meta.
function writeFlaky({ wt, log, names, quarantine, baseline, readHash }) {
  try {
    const w = addQuarantineAt(quarantine, Object.fromEntries(names.map((n) => [n, flakyReason(wt, log)])));
    return { quarantined: names.slice(), hash: w.before === readHash ? w.after : undefined,
      text: `quarantined: ${names.join(', ')} (${quarantine}) — the coordinator commits them into ${baseline} (guards-result.js quarantine-take)\n` };
  } catch (e) { return { quarantined: [], text: `quarantine not written: ${e.message}\n` }; }
}
// The guards a rerun found flaky, from the last rerun section of a log (a guard's own output before it never counts).
function flakyInLog(text) {
  const head = '==== rerun of new reds one by one (guardRerun) ====\n', i = String(text).lastIndexOf(head);
  if (i < 0) return [];
  const names = [];
  for (const m of String(text).slice(i + head.length).matchAll(/^flaky, red under load, green alone: (.+)$/gm)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

const metaFile = (log) => `${log}.meta.json`;
function gitState(wt) {
  const h = spawnSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (h.status !== 0) return { head: null, clean: false };
  const s = spawnSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return { head: h.stdout.trim(), clean: s.status === 0 && s.stdout.trim() === '' };
}
// env: left out for a run on this machine (the record stays as it always was), "remote:<host>" for the runner.
function metaStart(wt, log, command, env) {
  const g = gitState(wt);
  fs.writeFileSync(metaFile(log), JSON.stringify(Object.assign({ v: 1, head: g.head, cleanStart: g.clean, command, startedAt: new Date().toISOString() }, env && env !== 'local' ? { env } : {}), null, 1) + '\n');
}
function metaEnd(wt, log, rc, extra) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(metaFile(log), 'utf8')); } catch { /* no start record: stays unusable */ }
  const g = gitState(wt);
  // a quarantine hash the rerun recorded (the file it read) is kept over the one of the end of the run
  Object.assign(m, extra || {}, m.quarantine !== undefined ? { quarantine: m.quarantine } : {}, { headEnd: g.head, cleanEnd: g.clean, rc: Number(rc), finishedAt: new Date().toISOString() });
  fs.writeFileSync(metaFile(log), JSON.stringify(m, null, 1) + '\n');
}
// {reuse, reason, head?, text?}
function reusable(wt, log, command, env = 'local', quarantine = '') {
  const no = (reason) => ({ reuse: false, reason });
  let m;
  try { m = JSON.parse(fs.readFileSync(metaFile(log), 'utf8')); } catch { return no('no record of an earlier run'); }
  if (!fs.existsSync(log)) return no('the log of the earlier run is gone');
  const was = m.env || 'local';
  if (was !== (env || 'local')) return no(`environment changed (${was} -> ${env || 'local'})`);
  if (m.rc === undefined) return no('the earlier run did not finish');
  if (!m.head) return no('the worktree is not a git worktree');
  if (m.rc !== 0) return no(`the earlier run ended with exit ${m.rc}`);
  if (m.command !== command) return no('the guard command changed');
  if (!m.cleanStart || !m.cleanEnd || m.headEnd !== m.head) return no('the tracked tree was not clean or HEAD moved during the earlier run');
  const g = gitState(wt);
  if (g.head !== m.head) return no(`HEAD moved: ${String(m.head).slice(0, 10)} -> ${String(g.head).slice(0, 10)}`);
  if (!g.clean) return no('tracked files changed since the earlier run');
  if (quarantine && m.quarantine !== undefined && m.quarantine !== quarantineHash(quarantine)) return no('the quarantine file changed since the earlier run');
  const short = m.head.slice(0, 7);
  return { reuse: true, reason: '', head: m.head,
    text: `reused, HEAD ${short}: the full run of ${m.finishedAt} on this HEAD with a clean tracked tree ended with exit 0 (log ${log}); --force runs again` };
}

module.exports = { newReds, rerun, readBaseline, subst, metaStart, metaEnd, reusable, rerunLog,
  quarantineFile, readQuarantine, addQuarantine, dropQuarantine, takeQuarantine, quarantineHash, writeFlaky, flakyInLog };

if (require.main === module) {
  const [cmd, wt, log, x, y, z, u, v] = process.argv.slice(2);
  if (cmd === 'rerun') {
    const r = rerun({ wt, log, rc: Number(x), cfg: JSON.parse(y), baseline: z || '', quarantine: u || '', readOnly: v === 'select' ? 'select' : v === 'ro' });
    if (r.quarantineHash !== undefined) {
      try { const m = JSON.parse(fs.readFileSync(metaFile(log), 'utf8')); m.quarantine = r.quarantineHash; fs.writeFileSync(metaFile(log), JSON.stringify(m, null, 1) + '\n'); } catch { /* no start record: the run stays unusable */ }
    }
    if (r.text) process.stdout.write('\n' + r.text);
    process.exit(r.rc > 255 ? 1 : r.rc);
  } else if (cmd === 'meta-start') metaStart(wt, log, x, y);
  else if (cmd === 'meta-end') metaEnd(wt, log, x, y ? { quarantine: quarantineHash(y) } : undefined);
  else if (cmd === 'reuse') {
    const r = reusable(wt, log, x, y || 'local', z || '');
    console.log(r.reuse ? r.text : `full run: ${r.reason}`);
    process.exit(r.reuse ? 0 : 1);
  } else if (cmd === 'quarantine-take' || cmd === 'quarantine-drop') {
    // quarantine-take <wt> <guardBaseline> <file> [<guard>...]; quarantine-drop <file> <guard>...
    const a = process.argv.slice(3);
    try {
      if (cmd === 'quarantine-take') {
        const [w, b, f, ...names] = a;
        if (!w || !b || !f) { console.error('usage: guards-result.js quarantine-take <wt> <guardBaseline> <quarantine file> [<guard>...]'); process.exit(64); }
        const r = takeQuarantine(w, b, f, names);
        if (r.moved.length) console.log(`moved into ${b}: ${r.moved.join(', ')} - commit ${b} in the worktree`);
        else console.log('nothing to move');
        if (r.missing.length) console.log(`not in the quarantine: ${r.missing.join(', ')}`);
        process.exit(r.missing.length ? 1 : 0);
      }
      const [f, ...names] = a;
      if (!f || !names.length) { console.error('usage: guards-result.js quarantine-drop <quarantine file> <guard>...'); process.exit(64); }
      const r = dropQuarantine(f, names);
      if (r.dropped.length) console.log(`dropped from the quarantine: ${r.dropped.join(', ')}`);
      if (r.missing.length) console.log(`not in the quarantine: ${r.missing.join(', ')}`);
      process.exit(r.missing.length ? 1 : 0);
    } catch (e) { console.error(`${cmd}: ${e.message}`); process.exit(1); }
  } else { console.error('usage: guards-result.js rerun|meta-start|meta-end|reuse|quarantine-take|quarantine-drop ...'); process.exit(64); }
}
