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
// 2. Reuse. The log has a record next to it (<log>.meta.json): HEAD and whether the tracked tree was clean at the
//    start and at the end, the guard command template, the final exit code. A full run on the same HEAD with a clean
//    tracked tree, the same command and a final exit code 0 is not repeated (guards-all.sh prints "reused, HEAD <sha>"
//    and the saved summary; --force runs anyway). Untracked files do not count: guard runs and probes leave them.
//
// usage: guards-result.js rerun <wt> <log> <runner rc> <guardRerun JSON> [<guardBaseline>]
//          -> summary on stdout, appended to the log; exit = final code
//        guards-result.js meta-start <wt> <log> <command template>
//        guards-result.js meta-end <wt> <log> <final rc>
//        guards-result.js reuse <wt> <log> <command template>             -> exit 0 and the message when reusable,
//                                                                            exit 1 and the reason otherwise
const fs = require('fs');
const path = require('path');
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

// {rc, repeated: [{name, rc}], flaky: [names], known: [names], text}. text is appended to the log (empty for a green
// run without a baseline).
function rerun({ wt, log, rc, cfg, baseline }) {
  const res = { rc, repeated: [], flaky: [], known: [], text: '' };
  const head = '==== rerun of new reds one by one (guardRerun) ====\n';
  const finish = (text) => { res.text = text; fs.appendFileSync(log, '\n' + text); return res; };
  let bl = null;
  if (baseline) {
    bl = readBaseline(wt, baseline);
    if (bl.error) return finish(`${head}guardBaseline ${baseline}: ${bl.error}: nothing is subtracted and nothing reruns, the runner's exit code ${rc} stands\n`);
  }
  const known = bl ? bl.known : {};
  const p = newReds(fs.readFileSync(log, 'utf8'), cfg);
  // a known name not red in a finished run: the fix landed, the entry is stale
  const stale = p.tally ? Object.keys(known).filter((n) => !p.names.includes(n)) : [];
  const staleText = stale.map((n) => `known red not red now: ${n} — remove it from the baseline ${baseline}\n`).join('');
  if (rc === 0) return staleText ? finish(head + staleText) : res;
  const max = cfg.maxReruns || 10;
  res.known = p.names.filter((n) => Object.hasOwn(known, n));
  const fresh = p.names.filter((n) => !Object.hasOwn(known, n));
  const knownText = res.known.map((n) => `known red (guardBaseline ${baseline}): ${n} — ${known[n]}\n`).join('') + staleText;
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
    text = head + knownText
      + res.repeated.map((x) => `new red, red again alone: ${x.name} (exit ${x.rc})\n`).join('')
      + res.flaky.map((n) => `flaky, red under load, green alone: ${n}\n`).join('')
      + `rerun: ${fresh.length} new reds -> ${res.repeated.length} repeated, ${res.flaky.length} flaky${res.known.length ? `; ${res.known.length} known red` : ''}; exit ${res.rc}\n`
      + (res.flaky.length ? `flaky guards (not a regression; put them into the project backlog): ${res.flaky.join(', ')}\n` : '')
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
function metaStart(wt, log, command) {
  const g = gitState(wt);
  fs.writeFileSync(metaFile(log), JSON.stringify({ v: 1, head: g.head, cleanStart: g.clean, command, startedAt: new Date().toISOString() }, null, 1) + '\n');
}
function metaEnd(wt, log, rc) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(metaFile(log), 'utf8')); } catch { /* no start record: stays unusable */ }
  const g = gitState(wt);
  Object.assign(m, { headEnd: g.head, cleanEnd: g.clean, rc: Number(rc), finishedAt: new Date().toISOString() });
  fs.writeFileSync(metaFile(log), JSON.stringify(m, null, 1) + '\n');
}
// {reuse, reason, head?, text?}
function reusable(wt, log, command) {
  const no = (reason) => ({ reuse: false, reason });
  let m;
  try { m = JSON.parse(fs.readFileSync(metaFile(log), 'utf8')); } catch { return no('no record of an earlier run'); }
  if (!fs.existsSync(log)) return no('the log of the earlier run is gone');
  if (m.rc === undefined) return no('the earlier run did not finish');
  if (!m.head) return no('the worktree is not a git worktree');
  if (m.rc !== 0) return no(`the earlier run ended with exit ${m.rc}`);
  if (m.command !== command) return no('the guard command changed');
  if (!m.cleanStart || !m.cleanEnd || m.headEnd !== m.head) return no('the tracked tree was not clean or HEAD moved during the earlier run');
  const g = gitState(wt);
  if (g.head !== m.head) return no(`HEAD moved: ${String(m.head).slice(0, 10)} -> ${String(g.head).slice(0, 10)}`);
  if (!g.clean) return no('tracked files changed since the earlier run');
  const short = m.head.slice(0, 7);
  return { reuse: true, reason: '', head: m.head,
    text: `reused, HEAD ${short}: the full run of ${m.finishedAt} on this HEAD with a clean tracked tree ended with exit 0 (log ${log}); --force runs again` };
}

module.exports = { newReds, rerun, readBaseline, subst, metaStart, metaEnd, reusable, rerunLog };

if (require.main === module) {
  const [cmd, wt, log, x, y, z] = process.argv.slice(2);
  if (cmd === 'rerun') {
    const r = rerun({ wt, log, rc: Number(x), cfg: JSON.parse(y), baseline: z || '' });
    if (r.text) process.stdout.write('\n' + r.text);
    process.exit(r.rc > 255 ? 1 : r.rc);
  } else if (cmd === 'meta-start') metaStart(wt, log, x);
  else if (cmd === 'meta-end') metaEnd(wt, log, x);
  else if (cmd === 'reuse') {
    const r = reusable(wt, log, x);
    console.log(r.reuse ? r.text : `full run: ${r.reason}`);
    process.exit(r.reuse ? 0 : 1);
  } else { console.error('usage: guards-result.js rerun|meta-start|meta-end|reuse <wt> <log> ...'); process.exit(64); }
}
