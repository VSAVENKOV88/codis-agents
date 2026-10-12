#!/usr/bin/env node
'use strict';
// Cost of a role chain per task: after a role-chain run the coordinator computes the IE of each task from the agent
// transcripts and compares it with twice the median of accepted tasks (project config "medianTaskIE").
// A warning after the fact, not a stop: inside a workflow script the token counter is shared by the whole run and
// cannot be split per task.
// IE (input equivalent) = input + 1.25 x cache_write + 0.1 x cache_read + 5 x output; output is estimated from the
// length of text and tool arguments (characters / 3.2), because output_tokens in transcripts is partial.
// usage: chain-cost.js <workflow transcript directory> [--median 5e6]
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

function report(tasks, median) {
  const M = (x) => (x / 1e6).toFixed(1) + 'M';
  return Object.entries(tasks).sort().map(([k, t]) => {
    const roles = Object.entries(t.byRole).map(([r, v]) => `${r} ${M(v)}`).join(', ');
    const flag = t.ie > 2 * median ? `  WARNING: above 2 x median (${M(2 * median)}) - split the next similar task` : '';
    return `${k}: ${M(t.ie)} IE, ${t.agents} agents, max context ${Math.round(t.maxCtx / 1000)}k (${roles})${flag}`;
  });
}

module.exports = { cost, ieOfAgent, report };

if (require.main === module) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--median');
  let median = i >= 0 ? Number(a[i + 1]) : NaN;
  if (!Number.isFinite(median)) {
    try { const { find, load } = require('./config'); const f = find(); median = f ? load(f).config.medianTaskIE : NaN; } catch { /* no config */ }
  }
  if (!Number.isFinite(median)) median = 5e6;
  if (!a[0] || a[0].startsWith('--')) { console.error('usage: chain-cost.js <transcript directory> [--median N]'); process.exit(64); }
  for (const l of report(cost(a[0]), median)) console.log(l);
}
