#!/usr/bin/env node
'use strict';
// Cost of a role chain per task: after a role-chain run the coordinator computes the IE of each task from the agent
// transcripts and compares it with twice the median of accepted tasks (project config "medianTaskIE").
// A warning after the fact, not a stop: inside a workflow script the token counter is shared by the whole run and
// cannot be split per task.
// IE (input equivalent) = input + 1.25 x cache_write + 0.1 x cache_read + 5 x output; output is estimated from the
// length of text and tool arguments (characters / 3.2), because output_tokens in transcripts is partial.
// Per feature: a feature split into parts (task field `feature`, passed in the workflow args) is summed over its parts,
// across all the runs given, and flagged above the feature limit (config "featureIELimit", default 3 x medianTaskIE):
// a part can stay under its own flag while the feature costs 20-30M. The feature of a part is read only from the run
// record the workflow keeps next to the transcripts (<session>/workflows/<run id>.json, args.tasks[].feature), never
// guessed from the key; a task without `feature` is its own feature, and a task whose key is a feature name counts in
// that feature.
// Calls of the role adapter (scripts/role-exec.js, host codex or claude) leave no transcript; the adapter appends one
// line per call to <task dir>/calls.jsonl, and `--journal <task dir | calls.jsonl>` reads those lines next to the
// transcripts (see ieOfCall and journalCost).
// usage: chain-cost.js [<workflow transcript directory>...] [--journal <task dir | calls.jsonl>]... [--median 5e6]
//          [--feature-limit 15e6]
// A wrong path - no directory, a file, a directory without agent transcripts (*.meta.json); for --journal no path, a
// folder without calls.jsonl, an empty journal, no value - is one line on stderr and exit 66 (EX_NOINPUT), before any
// report: an empty directory is almost always a wrong path (coordinator decision U2b v.6). A broken .meta.json is a note
// and is skipped; the rest is counted.
const fs = require('fs');
const path = require('path');

const ieOfAgent = (jsonl) => {
  const seen = new Set();
  let ie = 0, maxCtx = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (!m || m.role !== 'assistant' || !m.usage) continue;
    const id = m.id || o.uuid;
    const u = m.usage;
    if (!seen.has(id)) {
      seen.add(id);
      const inp = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
      ie += inp + 1.25 * cw + 0.1 * cr;
      maxCtx = Math.max(maxCtx, inp + cw + cr);
    }
    // a response is streamed in parts under one id - each line carries its own content block
    for (const c of m.content || []) {
      const chars = c.type === 'text' ? (c.text || '').length : c.type === 'tool_use' ? JSON.stringify(c.input || {}).length : 0;
      ie += 5 * chars / 3.2;
    }
  }
  return { ie, maxCtx };
};

// A "waiting drop" (p-tester-drop, 2026-11-04): the agent ended a turn with text ("end_turn") instead of a tool call
// and the harness then forced the final output ("[structured-output-enforce]") while a background job it had started
// was still alive - no <status>completed|failed|killed for one since. Deterministic, no threshold: it marks the green,
// ready or environment verdicts whose own checks (a stand ticket, an acceptance, a full run) were cut off mid-wait and
// that otherwise leave no signal for the coordinator.
// Live jobs are tracked BY ID, never by a balance of counts (round 2, test.md R2-1/R2-2): a transcript line is one
// JSON object, so a pattern on the raw line matches the harness and project instructions of every agent's first lines
// (a deferred tool list "...Monitor\nNotebookEdit...", rule text "A-Monitor (copy) ... a full run started"), and one
// task notification is stored several times in one line (attachment prompt/text/display, the api-request blob).
// - A start is read from a tool_result whose text BEGINS with the harness echo "Command running in background with ID:
//   X" (a run_in_background Bash) or "Monitor started (task X" (the A1b mechanism), or whose LAST paragraph is the echo
//   "Command did not complete within its Ns timeout and was moved to the background (ID: X). Output is being written
//   to: .../tasks/X.output. ..." (optionally followed by one "Session cwd remains ..." line): a foreground command - the
//   blocking-loop wait itself - that overran its timeout keeps running, is notified by its own id and is killed at the
//   final response, as the echo says (session 39161f33: 360 such echoes, 322 notified by their id, 16 after partial
//   stdout). A result that quotes these words anywhere else (a file read, a cat of a report) is no start.
// - A job ends with a notification "<task-id>X</task-id> ... <status>completed|failed|killed</status>" on any line
//   that is not the assistant's own (repeats remove the same id, an id never started removes nothing), or with a
//   TaskStop result that begins '{"message":"Successfully stopped task: X' or '<tool_use_error>Task X is not running'
//   (150 stops in the session, none followed by a notification).
// - A drop: an assistant turn ended with text ("end_turn"), the next line with a message is the enforce, and a started
//   job is alive. Only lines with a message mark or clear the turn boundary: an attachment line (a prompt_snapshot, a
//   notification) between the end_turn and the enforce does not hide the drop, while a notification there still ends
//   its job. Lines of type "api-request-blob" are a copy of the request the harness sent (old tool results, a user
//   message), not events: they are not read at all.
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');
const MOVED = /(?:^|\n)Command did not complete within its \d+s timeout and was moved to the background \(ID: ([\w-]+)\)\. Output is being written to: [^\n]*\/tasks\/\1\.output\.[^\n]*(?:\nSession cwd remains [^\n]*)?\s*$/;
function waitDropsOfAgent(jsonl) {
  let drops = 0, prevEndTurn = false;
  const live = new Set();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'api-request-blob') continue;
    const m = o.message;
    if (m) {
      if (prevEndTurn && /structured-output-enforce/.test(line) && live.size > 0) drops++;
      prevEndTurn = m.role === 'assistant' && m.stop_reason === 'end_turn';
      if (m.role === 'assistant') continue;
    }
    if (m && m.role === 'user' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c || c.type !== 'tool_result') continue;
        const t = textOf(c.content).trimStart();
        const s = /^Command running in background with ID: ([\w-]+)/.exec(t) || /^Monitor started \(task ([\w-]+)/.exec(t) || MOVED.exec(t);
        if (s) live.add(s[1]);
        const e = /^\{"message":"Successfully stopped task: ([\w-]+)/.exec(t) || /^<tool_use_error>Task ([\w-]+) is not running/.exec(t);
        if (e) live.delete(e[1]);
      }
    }
    if (live.size) {
      for (const n of line.matchAll(/<task-id>([\w-]+)<\/task-id>((?:(?!<\/task-notification>)[\s\S])*?)<status>\s*(?:completed|failed|killed)\s*<\/status>/gi)) live.delete(n[1]);
    }
  }
  return drops;
}

function badDir(dir) {
  let st;
  try { st = fs.statSync(dir); } catch (e) { return e.code === 'ENOENT' ? `chain-cost: no directory ${dir}` : `chain-cost: ${dir}: ${e.message}`; }
  if (!st.isDirectory()) return `chain-cost: ${dir} is not a directory (pass a workflow transcript directory)`;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return `chain-cost: ${dir}: ${e.message}`; }
  return names.some((x) => x.endsWith('.meta.json')) ? '' : `chain-cost: no agent transcripts (*.meta.json) in ${dir}`;
}

// Agent labels: role:key#n, diff:key:role - the task key is the second field. notes (optional array) gets one line per
// agent record that cannot be read; that record is skipped.
function cost(dir, notes = []) {
  const tasks = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.meta.json'))) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) {
      notes.push(`unreadable agent record ${path.join(dir, f)} (${e.message}) - skipped`); continue;
    }
    const label = (meta && meta.description) || '';
    const key = (label.split(':')[1] || '?').split('#')[0];
    const role = label.split(':')[0];
    const jf = path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
    if (!fs.existsSync(jf)) continue;
    const raw = fs.readFileSync(jf, 'utf8');
    const a = ieOfAgent(raw);
    const t = tasks[key] || (tasks[key] = { ie: 0, agents: 0, maxCtx: 0, waitDrops: 0, byRole: {} });
    t.ie += a.ie; t.agents++; t.maxCtx = Math.max(t.maxCtx, a.maxCtx);
    t.waitDrops += waitDropsOfAgent(raw);
    t.byRole[role] = (t.byRole[role] || 0) + a.ie;
  }
  return tasks;
}

// IE of one call of the role adapter from its record in calls.jsonl (usage: the raw numbers of the host, p-codex-A
// analysis 5.2): IE = fresh + cacheWrite x w + cachedInput x r + output x o.
// - claude: fresh = usage.input (input_tokens of the result excludes the cache), the coefficients of the transcripts
//   (1.25, 0.1, 5) for every model; output is the real output_tokens, thinking included.
// - codex: fresh = input - cachedInput - cacheWrite (input_tokens of turn.completed includes the cache read and the cache
//   write), the coefficients by the model from CODEX_PRICES; reasoning is a part of output_tokens and is not added. A
//   model without prices is not priced by a similar one: {unpriced: model}.
// Returns {ie}, {ie: 0, noUsage: true} (a launched call without usage: killed, ceiling, signalled, crashed),
// {unpriced} or {bad: reason} (unknown host, usage with a field that is not a number >= 0, codex cache above input).
// Prices of gpt-6-astra per 1M tokens (developers.openai.com/api/docs/models/gpt-6-astra, read 2026-11-05): input $10,
// cached input $1, cache writes $12.5, output $50 - relative to the uncached input.
const CODEX_PRICES = Object.freeze({ 'gpt-6-astra': Object.freeze({ cacheWrite: 1.25, cachedInput: 0.1, output: 5 }) });
const CLAUDE_PRICES = Object.freeze({ cacheWrite: 1.25, cachedInput: 0.1, output: 5 });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function ieOfCall(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { bad: 'not a call record' };
  if (rec.host !== 'codex' && rec.host !== 'claude') return { bad: `unknown host ${JSON.stringify(rec.host)}` };
  const u = rec.usage;
  if (u === null || u === undefined) return { ie: 0, noUsage: true };
  if (typeof u !== 'object' || Array.isArray(u)) return { bad: 'usage is not an object' };
  const v = {};
  // input and output are required; a missing cache field is 0
  for (const k of ['input', 'cachedInput', 'cacheWrite', 'output']) {
    const x = (k === 'cachedInput' || k === 'cacheWrite') && (u[k] === undefined || u[k] === null) ? 0 : u[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return { bad: `usage.${k} is ${JSON.stringify(u[k])}, not a number >= 0` };
    v[k] = x;
  }
  let p = CLAUDE_PRICES, fresh = v.input;
  if (rec.host === 'codex') {
    fresh = v.input - v.cachedInput - v.cacheWrite;
    if (fresh < 0) return { bad: `usage.cachedInput + usage.cacheWrite (${v.cachedInput + v.cacheWrite}) is above usage.input (${v.input})` };
    if (typeof rec.model !== 'string' || !own(CODEX_PRICES, rec.model)) return { unpriced: rec.model === undefined ? null : rec.model };
    p = CODEX_PRICES[rec.model];
  }
  return { ie: fresh + p.cacheWrite * v.cacheWrite + p.cachedInput * v.cachedInput + p.output * v.output };
}

// The journal file of a --journal path: <dir>/calls.jsonl for a folder, the path itself otherwise.
function journalFile(p) {
  try { return fs.statSync(p).isDirectory() ? path.join(p, 'calls.jsonl') : p; } catch { return p; }
}
// '' or the one line on stderr for a --journal path that cannot be read.
function badJournal(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return e.code === 'ENOENT' ? `chain-cost: no journal ${p}` : `chain-cost: ${p}: ${e.message}`; }
  const f = st.isDirectory() ? path.join(p, 'calls.jsonl') : p;
  if (f !== p) {
    try { st = fs.statSync(f); } catch (e) { return e.code === 'ENOENT' ? `chain-cost: no calls.jsonl in ${p} (pass a task folder or its calls.jsonl)` : `chain-cost: ${f}: ${e.message}`; }
  }
  if (!st.isFile()) return `chain-cost: ${f} is not a file (pass a task folder or its calls.jsonl)`;
  return st.size ? '' : `chain-cost: empty journal ${f}`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// Tasks from journals of the role adapter, in the shape of cost() plus bySource {claude, codex} and incomplete (calls of
// a codex model without prices). Every call is counted once:
// - a journal named twice (folder and file, a symbolic or a hard link) is read once, by its device and inode;
// - a record with a non-empty callDir already counted from another journal (a copy of a task folder) is skipped; records
//   without callDir (refused, crashed before the call folder) are separate calls and are never merged;
// - only <task dir>/calls.jsonl is read: the call folders calls/<label>-.../events.jsonl hold the same usage.
// A refused call started no process: it is neither an agent nor IE, only counted in a note. The task key is the record's
// `task` ("?" without one), the role the kind of its label, as for transcripts. featureLists: {key: [feature...]} from
// the optional field `feature` of the records.
function journalCost(paths, notes = []) {
  const tasks = {}, featureLists = {}, files = new Map(), calls = new Map(), noUsage = {};
  for (const p of paths) {
    const f = journalFile(p);
    let st, text;
    try { st = fs.statSync(f); text = fs.readFileSync(f, 'utf8'); } catch (e) { notes.push(`journal ${p}: ${e.message} - skipped`); continue; }
    const id = `${st.dev}:${st.ino}`;
    if (files.has(id)) { notes.push(`journal ${f} given twice (as ${files.get(id)}) - read once`); continue; }
    files.set(id, f);
    let refused = 0;
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      const at = `${f}:${i + 1}`;
      let r;
      try { r = JSON.parse(line); } catch { r = undefined; }
      if (!r || typeof r !== 'object' || Array.isArray(r)) { notes.push(`${at}: not a JSON record - skipped`); return; }
      if (r.outcome === 'refused') { refused++; return; }
      const c = ieOfCall(r);
      if (c.bad) { notes.push(`${at}: ${c.bad} - skipped`); return; }
      if (typeof r.callDir === 'string' && r.callDir) {
        if (calls.has(r.callDir)) { notes.push(`${at}: the call ${r.callDir} is already counted from ${calls.get(r.callDir)} - skipped`); return; }
        calls.set(r.callDir, at);
      }
      const key = typeof r.task === 'string' && r.task ? r.task : '?';
      const role = typeof r.label === 'string' ? r.label.split(':')[0] : '';
      const t = tasks[key] || (tasks[key] = { ie: 0, agents: 0, maxCtx: 0, waitDrops: 0, byRole: {}, bySource: {}, incomplete: 0 });
      const ie = c.ie || 0;
      t.ie += ie; t.agents++;
      t.byRole[role] = (t.byRole[role] || 0) + ie;
      t.bySource[r.host] = (t.bySource[r.host] || 0) + ie;
      if (c.noUsage) {
        const n = noUsage[key] || (noUsage[key] = {});
        n[r.outcome] = (n[r.outcome] || 0) + 1;
      }
      if (own(c, 'unpriced')) { t.incomplete++; notes.push(`${at}: model ${JSON.stringify(c.unpriced)} has no codex prices - its call is not counted in IE`); }
      if (typeof r.feature === 'string' && r.feature.trim()) {
        const l = featureLists[key] || (featureLists[key] = []);
        if (!l.includes(r.feature.trim())) l.push(r.feature.trim());
      }
    });
    if (refused) notes.push(`${plural(refused, 'refused call')} in ${f} - no process, not counted`);
  }
  for (const [k, n] of Object.entries(noUsage).sort()) {
    const total = Object.values(n).reduce((a, b) => a + b, 0);
    notes.push(`task ${k}: ${plural(total, 'call')} without usage (${Object.entries(n).map(([o, x]) => `${o} ${x}`).join(', ')}) - IE is a lower bound`);
  }
  return { tasks, featureLists, notes };
}

// The run record of a transcript directory <session>/subagents/workflows/<run id>: <session>/workflows/<run id>.json.
const runRecordOf = (dir) => path.join(path.resolve(dir), '..', '..', '..', 'workflows', path.basename(path.resolve(dir)) + '.json');

// {key: feature} from the run record's args.tasks; null when there is no readable record.
function featuresOf(dir) {
  const f = runRecordOf(dir);
  let rec;
  try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  let a = rec.args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  const out = {};
  for (const t of (a && a.tasks) || []) {
    if (t && typeof t.key === 'string' && typeof t.feature === 'string' && t.feature.trim()) out[t.key] = t.feature.trim();
  }
  return out;
}

// Several runs: tasks summed per key, features merged; notes name the runs without a record. journals (--journal
// paths): their calls are added to the tasks of the same key, which then carry bySource {workflow, claude, codex}; the
// feature of a journal key comes from the run record or from the records' field `feature`, and a key with two different
// features is in none (features[key] = null) with a note.
function costAll(dirs, journals = []) {
  const tasks = {}, features = {}, notes = [];
  for (const dir of dirs) {
    for (const [k, t] of Object.entries(cost(dir, notes))) {
      const s = tasks[k] || (tasks[k] = { ie: 0, agents: 0, maxCtx: 0, waitDrops: 0, byRole: {} });
      s.ie += t.ie; s.agents += t.agents; s.maxCtx = Math.max(s.maxCtx, t.maxCtx); s.waitDrops += t.waitDrops || 0;
      for (const [r, v] of Object.entries(t.byRole)) s.byRole[r] = (s.byRole[r] || 0) + v;
    }
    const f = featuresOf(dir);
    if (f) Object.assign(features, f);
    else notes.push(`no run record ${runRecordOf(dir)} - the parts of ${dir} are not grouped by feature`);
  }
  if (!journals.length) return { tasks, features, notes };
  const j = journalCost(journals, notes);
  for (const [k, jt] of Object.entries(j.tasks)) {
    const s = tasks[k];
    if (!s) { tasks[k] = jt; continue; }
    s.bySource = Object.assign({ workflow: s.ie }, jt.bySource);
    s.ie += jt.ie; s.agents += jt.agents; s.incomplete = jt.incomplete;
    for (const [r, v] of Object.entries(jt.byRole)) s.byRole[r] = (s.byRole[r] || 0) + v;
  }
  for (const [k, list] of Object.entries(j.featureLists)) {
    const all = [...new Set((own(features, k) ? [features[k]] : []).concat(list))].sort();
    if (all.length > 1) {
      notes.push(`task ${k}: features ${all.join(' and ')} (run record and journal) - the task is counted in no feature`);
      features[k] = null;
    } else features[k] = all[0];
  }
  return { tasks, features, notes };
}

// {feature: {ie, parts}} for every feature that has at least one declared part; a key whose feature is null (two
// different features) is in none.
function byFeature(tasks, features) {
  const declared = new Set(Object.values(features).filter((f) => typeof f === 'string'));
  const out = {};
  for (const [k, t] of Object.entries(tasks)) {
    if (own(features, k) && features[k] === null) continue;
    const f = features[k] || k;
    if (!declared.has(f)) continue;
    const s = out[f] || (out[f] = { ie: 0, parts: [] });
    s.ie += t.ie; s.parts.push(k);
  }
  return out;
}

const M = (x) => (x / 1e6).toFixed(1) + 'M';
const SOURCES = ['workflow', 'claude', 'codex'];
// A task with calls from a journal names its sources after the roles ("[workflow 4.2M, codex 0.6M]"); without
// transcripts its max context is n/a (usage of a call is the sum of its turns), and calls of a codex model without
// prices mark it "IE incomplete". A task of transcripts alone keeps the line it had before journals.
function report(tasks, median, opts = {}) {
  const lines = Object.entries(tasks).sort().map(([k, t]) => {
    const roles = Object.entries(t.byRole).map(([r, v]) => `${r} ${M(v)}`).join(', ');
    const flag = t.ie > 2 * median ? `  WARNING: above 2 x median (${M(2 * median)}) - split the next similar task` : '';
    const drops = t.waitDrops ? `, ${t.waitDrops} waiting drop${t.waitDrops > 1 ? 's' : ''}` : '';
    const dropFlag = t.waitDrops ? `  WARNING: a verdict with a cut-off wait (a role ended a turn while a background job was alive) - check its own checks ran before the verdict` : '';
    const ctx = t.bySource && !own(t.bySource, 'workflow') ? 'n/a' : `${Math.round(t.maxCtx / 1000)}k`;
    const inc = t.incomplete ? ', IE incomplete' : '';
    const src = t.bySource ? ` [${SOURCES.filter((x) => own(t.bySource, x)).map((x) => `${x} ${M(t.bySource[x])}`).join(', ')}]` : '';
    return `${k}: ${M(t.ie)} IE, ${t.agents} agents, max context ${ctx}${drops}${inc} (${roles})${src}${flag}${dropFlag}`;
  });
  const limit = Number.isFinite(opts.featureLimit) && opts.featureLimit > 0 ? opts.featureLimit : 3 * median;
  for (const [f, s] of Object.entries(byFeature(tasks, opts.features || {})).sort()) {
    const flag = s.ie > limit ? `  WARNING: feature above ${M(limit)} - split the next similar feature differently or narrow it` : '';
    lines.push(`feature ${f}: ${M(s.ie)} IE over ${s.parts.length} part(s) ${s.parts.sort().join(', ')}${flag}`);
  }
  return lines;
}

module.exports = { badDir, badJournal, cost, costAll, featuresOf, byFeature, ieOfAgent, ieOfCall, journalCost, waitDropsOfAgent, report, runRecordOf, CODEX_PRICES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (name) => { const i = a.indexOf(name); return i >= 0 ? Number(a[i + 1]) : NaN; };
  const journals = [];
  let journalErr = '';
  a.forEach((x, i) => {
    if (x !== '--journal') return;
    const v = a[i + 1];
    if (v === undefined || v.startsWith('--')) journalErr = 'chain-cost: --journal needs a path (a task folder or its calls.jsonl)';
    else journals.push(v);
  });
  const dirs = a.filter((x, i) => !x.startsWith('--') && !['--median', '--feature-limit', '--journal'].includes(a[i - 1]));
  let median = opt('--median'), featureLimit = opt('--feature-limit');
  let cfg = null;
  try { const { find, load } = require('./config'); const f = find(); cfg = f ? load(f).config : null; } catch { /* no config */ }
  if (!Number.isFinite(median)) median = cfg && Number.isFinite(cfg.medianTaskIE) ? cfg.medianTaskIE : 5e6;
  if (!Number.isFinite(featureLimit)) featureLimit = cfg && Number.isFinite(cfg.featureIELimit) ? cfg.featureIELimit : 3 * median;
  if (journalErr) { console.error(journalErr); process.exit(66); }
  if (!dirs.length && !journals.length) { console.error('usage: chain-cost.js [<transcript directory>...] [--journal <task dir | calls.jsonl>]... [--median N] [--feature-limit N]'); process.exit(64); }
  const bad = dirs.map(badDir).concat(journals.map(badJournal)).filter(Boolean);
  if (bad.length) { for (const b of bad) console.error(b); process.exit(66); }
  const { tasks, features, notes } = costAll(dirs, journals);
  for (const l of report(tasks, median, { features, featureLimit })) console.log(l);
  for (const n of notes) console.log('note: ' + n);
}
