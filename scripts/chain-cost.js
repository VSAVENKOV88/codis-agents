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
// usage: chain-cost.js <workflow transcript directory>... [--median 5e6] [--feature-limit 15e6]
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

// Agent labels: role:key#n, diff:key:role - the task key is the second field.
function cost(dir) {
  const tasks = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.meta.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const label = meta.description || '';
    const key = (label.split(':')[1] || '?').split('#')[0];
    const role = label.split(':')[0];
    const jf = path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
    if (!fs.existsSync(jf)) continue;
    const a = ieOfAgent(fs.readFileSync(jf, 'utf8'));
    const t = tasks[key] || (tasks[key] = { ie: 0, agents: 0, maxCtx: 0, byRole: {} });
    t.ie += a.ie; t.agents++; t.maxCtx = Math.max(t.maxCtx, a.maxCtx);
    t.byRole[role] = (t.byRole[role] || 0) + a.ie;
  }
  return tasks;
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

// Several runs: tasks summed per key, features merged; notes name the runs without a record.
function costAll(dirs) {
  const tasks = {}, features = {}, notes = [];
  for (const dir of dirs) {
    for (const [k, t] of Object.entries(cost(dir))) {
      const s = tasks[k] || (tasks[k] = { ie: 0, agents: 0, maxCtx: 0, byRole: {} });
      s.ie += t.ie; s.agents += t.agents; s.maxCtx = Math.max(s.maxCtx, t.maxCtx);
      for (const [r, v] of Object.entries(t.byRole)) s.byRole[r] = (s.byRole[r] || 0) + v;
    }
    const f = featuresOf(dir);
    if (f) Object.assign(features, f);
    else notes.push(`no run record ${runRecordOf(dir)} - the parts of ${dir} are not grouped by feature`);
  }
  return { tasks, features, notes };
}

// {feature: {ie, parts}} for every feature that has at least one declared part.
function byFeature(tasks, features) {
  const declared = new Set(Object.values(features));
  const out = {};
  for (const [k, t] of Object.entries(tasks)) {
    const f = features[k] || k;
    if (!declared.has(f)) continue;
    const s = out[f] || (out[f] = { ie: 0, parts: [] });
    s.ie += t.ie; s.parts.push(k);
  }
  return out;
}

const M = (x) => (x / 1e6).toFixed(1) + 'M';
function report(tasks, median, opts = {}) {
  const lines = Object.entries(tasks).sort().map(([k, t]) => {
    const roles = Object.entries(t.byRole).map(([r, v]) => `${r} ${M(v)}`).join(', ');
    const flag = t.ie > 2 * median ? `  WARNING: above 2 x median (${M(2 * median)}) - split the next similar task` : '';
    return `${k}: ${M(t.ie)} IE, ${t.agents} agents, max context ${Math.round(t.maxCtx / 1000)}k (${roles})${flag}`;
  });
  const limit = Number.isFinite(opts.featureLimit) && opts.featureLimit > 0 ? opts.featureLimit : 3 * median;
  for (const [f, s] of Object.entries(byFeature(tasks, opts.features || {})).sort()) {
    const flag = s.ie > limit ? `  WARNING: feature above ${M(limit)} - split the next similar feature differently or narrow it` : '';
    lines.push(`feature ${f}: ${M(s.ie)} IE over ${s.parts.length} part(s) ${s.parts.sort().join(', ')}${flag}`);
  }
  return lines;
}

module.exports = { cost, costAll, featuresOf, byFeature, ieOfAgent, report, runRecordOf };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (name) => { const i = a.indexOf(name); return i >= 0 ? Number(a[i + 1]) : NaN; };
  const dirs = a.filter((x, i) => !x.startsWith('--') && !['--median', '--feature-limit'].includes(a[i - 1]));
  let median = opt('--median'), featureLimit = opt('--feature-limit');
  let cfg = null;
  try { const { find, load } = require('./config'); const f = find(); cfg = f ? load(f).config : null; } catch { /* no config */ }
  if (!Number.isFinite(median)) median = cfg && Number.isFinite(cfg.medianTaskIE) ? cfg.medianTaskIE : 5e6;
  if (!Number.isFinite(featureLimit)) featureLimit = cfg && Number.isFinite(cfg.featureIELimit) ? cfg.featureIELimit : 3 * median;
  if (!dirs.length) { console.error('usage: chain-cost.js <transcript directory>... [--median N] [--feature-limit N]'); process.exit(64); }
  const { tasks, features, notes } = costAll(dirs);
  for (const l of report(tasks, median, { features, featureLimit })) console.log(l);
  for (const n of notes) console.log('note: ' + n);
}
