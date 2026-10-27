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
//    flaky) and off on the remote runner (guards-all.sh --no-quarantine): its file belongs to this machine. The
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
// usage: guards-result.js rerun <wt> <log> <runner rc> <guardRerun JSON> [<guardBaseline> [<quarantine file>]]
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

// The known reds of the baseline file (path relative to wt): {known: {name: reason}} or {error}.
function readBaseline(wt, rel) {
  let o;
  try { o = JSON.parse(fs.readFileSync(path.resolve(wt, rel), 'utf8')); } catch (e) {
    return { error: e.code === 'ENOENT' ? 'no such file in the worktree' : `not readable as JSON (${e.message})` };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'expected a JSON object {"<guard name>": "<reason>"}' };
  const bad = Object.keys(o).filter((k) => typeof o[k] !== 'string');
  if (bad.length) return { error: `the reason of ${bad.join(', ')} is not a string (expected {"<guard name>": "<reason>"})` };
  return { known: o };
}

const QUARANTINE = 'guards-quarantine.json';
const quarantineFile = (sharedDir) => path.join(sharedDir, QUARANTINE);
const FLAKY = /^flaky:/;
// Copies own entries without the "__proto__" setter (JSON.parse makes "__proto__" an own key; Object.assign would set
// the prototype instead): a guard may be named so.
const merge = (...objs) => { const o = {}; for (const s of objs) for (const k of Object.keys(s)) Object.defineProperty(o, k, { value: s[k], enumerable: true, writable: true, configurable: true }); return o; };

// The quarantine file (absolute path): {known} - {} when it does not exist yet - or {error}.
function readQuarantine(file) {
  if (!fs.existsSync(file)) return { known: {} };
  return readBaseline(path.dirname(file), file);
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Runs fn under <file>.lock (a directory: mkdir is atomic). A lock older than STALE is left by a dead writer and broken.
// Throws "the lock <file>.lock was not taken in <ms> ms" when it cannot be taken in time.
function withLock(file, fn) {
  const lock = `${file}.lock`, wait = Number(process.env.CODIS_QUARANTINE_LOCK_MS) || 10000, STALE = 60000;
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE) { fs.rmdirSync(lock); continue; } } catch { continue; }
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
// Adds the entries the file does not have yet; an existing entry keeps its reason. -> [names written]. Throws on a
// broken file (never rewritten) or a failed write.
function addQuarantine(file, entries) {
  return withLock(file, () => {
    const q = readQuarantine(file);
    if (q.error) throw new Error(`the file is broken: ${q.error}`);
    const add = Object.keys(entries).filter((n) => !Object.hasOwn(q.known, n));
    if (add.length) writeJson(file, merge(q.known, merge(...add.map((n) => ({ [n]: entries[n] })))));
    return add;
  });
}
// Removes the named entries -> {dropped, missing}.
function dropQuarantine(file, names) {
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
const quarantineHash = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'none'; } };

// {rc, repeated: [{name, rc}], flaky: [names], known: [names], quarantined: [names], text}. text is appended to the log
// (empty for a green run without a baseline). quarantine: the absolute path of the quarantine file, '' when it is off.
function rerun({ wt, log, rc, cfg, baseline, quarantine }) {
  const res = { rc, repeated: [], flaky: [], known: [], quarantined: [], text: '' };
  const head = '==== rerun of new reds one by one (guardRerun) ====\n';
  const finish = (text) => { res.text = text; fs.appendFileSync(log, '\n' + text); return res; };
  let bl = null, ql = { known: {} };
  if (baseline) {
    bl = readBaseline(wt, baseline);
    if (bl.error) return finish(`${head}guardBaseline ${baseline}: ${bl.error}: nothing is subtracted and nothing reruns, the runner's exit code ${rc} stands\n`);
    if (quarantine) {
      ql = readQuarantine(quarantine);
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
      else {
        const h = spawnSync('git', ['-C', wt, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' });
        const sha = h.status === 0 ? h.stdout.trim() : 'no-HEAD', day = new Date().toISOString().slice(0, 10);
        const why = `flaky: ${path.basename(log)} ${sha}, green alone, ${day}`;
        try {
          addQuarantine(quarantine, Object.fromEntries(res.flaky.map((n) => [n, why])));
          res.quarantined = res.flaky.slice();
          qText = `quarantined: ${res.quarantined.join(', ')} (${quarantine}) — the coordinator commits them into ${baseline} (guards-result.js quarantine-take)\n`;
        } catch (e) { qText = `quarantine not written: ${e.message}\n`; }
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
  Object.assign(m, extra || {}, { headEnd: g.head, cleanEnd: g.clean, rc: Number(rc), finishedAt: new Date().toISOString() });
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
  quarantineFile, readQuarantine, addQuarantine, dropQuarantine, takeQuarantine, quarantineHash };

if (require.main === module) {
  const [cmd, wt, log, x, y, z, u] = process.argv.slice(2);
  if (cmd === 'rerun') {
    const r = rerun({ wt, log, rc: Number(x), cfg: JSON.parse(y), baseline: z || '', quarantine: u || '' });
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
