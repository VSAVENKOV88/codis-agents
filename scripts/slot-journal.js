#!/usr/bin/env node
'use strict';
// Summary of the slot journal (scripts/slots.zsh writes one line per slot hold): how much of the agents' waiting is the
// queue for a memory slot and how much is the heavy jobs themselves.
//   queue wait = acquire - request, hold = release - acquire; per class (medium, heavy, exclusive) and per worktree:
//   count, total and median of each, and the share of the queue in wait + hold.
// Notes for reading it: a heavy hold of an exclusive guard includes its wait for the exclusive lock (that wait is also
// the "exclusive" class's queue); a full run (kind "full") that left the slot with exit 75 had no worker budget - its
// hold is waiting too, counted in the line "no worker budget". Records with no acquire ("-") never got a slot (killed
// while queueing): their wait counts, they have no hold. The class "stand" is the ticket of the project's shared stand
// (scripts/stand.sh): its hold is the whole time a tester held the stand; kind "dead" - a holder found dead by the next
// one, its release is the time it was found (an upper bound of the hold).
//
// usage: slot-journal.js [--journal <file>] [--since <time>] [--until <time>] [--json]
//   <time>: 30m, 6h, 2d (ago), an ISO date/time, or epoch seconds. Journal: --journal, else $SLOT_JOURNAL, else
//   <slots.lockDir>/journal.tsv of the project config.
const fs = require('fs');
const path = require('path');

const FIELDS = ['v', 'request', 'acquire', 'release', 'class', 'slot', 'kind', 'pid', 'rc', 'worktree', 'command'];

// One journal line -> record, or null when it is not a v1 record.
function parseLine(line) {
  const f = line.replace(/\r$/, '').split('\t');
  if (f.length < FIELDS.length - 1 || f[0] !== 'v1') return null;
  const r = Object.fromEntries(FIELDS.map((k, i) => [k, f[i] === undefined ? '' : f[i]]));
  r.command = f.slice(FIELDS.length - 1).join('\t');
  const num = (s) => (s === '-' || s === '' ? null : Number(s));
  r.request = num(r.request); r.acquire = num(r.acquire); r.release = num(r.release); r.rc = num(r.rc);
  if (!Number.isFinite(r.request) || !Number.isFinite(r.release) || (r.acquire !== null && !Number.isFinite(r.acquire))) return null;
  r.wait = Math.max(0, (r.acquire ?? r.release) - r.request);
  r.hold = r.acquire === null ? null : Math.max(0, r.release - r.acquire);
  return r;
}

function parse(text) {
  const records = []; let bad = 0;
  for (const l of text.split('\n')) { if (!l.trim()) continue; const r = parseLine(l); if (r) records.push(r); else bad++; }
  return { records, bad };
}

// "30m" / "6h" / "2d" (ago), epoch seconds, or a date -> epoch seconds.
function parseTime(s, now = Date.now() / 1000) {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (m) return now - Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
  if (/^\d{9,}(\.\d+)?$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad time: ${s}`);
  return t / 1000;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

function stats(rs) {
  const waits = rs.map((r) => r.wait), holds = rs.filter((r) => r.hold !== null).map((r) => r.hold);
  const w = sum(waits), h = sum(holds);
  return {
    n: rs.length, waitTotal: w, waitMedian: median(waits), holdTotal: h, holdMedian: median(holds),
    queueShare: w + h > 0 ? w / (w + h) : null, notAcquired: rs.filter((r) => r.acquire === null).length,
  };
}

function group(rs, key) {
  const m = new Map();
  for (const r of rs) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => [k, stats(v)]);
}

// A full run that gave the slot back with 75: no worker budget, its hold is waiting as well.
const noBudget = (r) => r.kind === 'full' && r.rc === 75;

function summarize(records, { since = -Infinity, until = Infinity } = {}) {
  const rs = records.filter((r) => r.request >= since && r.request <= until);
  return {
    window: rs.length ? { from: Math.min(...rs.map((r) => r.request)), to: Math.max(...rs.map((r) => r.release)) } : null,
    all: stats(rs), byClass: group(rs, (r) => r.class), byWorktree: group(rs, (r) => r.worktree),
    noBudget: stats(rs.filter(noBudget)),
  };
}

function dur(s) {
  if (s === null || s === undefined) return '-';
  if (s < 60) return `${s.toFixed(1)}s`;
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(x).padStart(2, '0')}s`;
}
const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)}%`);

function table(title, rows) {
  const head = [title, 'n', 'queue total', 'queue median', 'hold total', 'hold median', 'queue share'];
  const body = rows.map(([k, s]) => [k, String(s.n) + (s.notAcquired ? ` (${s.notAcquired} no slot)` : ''), dur(s.waitTotal), dur(s.waitMedian), dur(s.holdTotal), dur(s.holdMedian), pct(s.queueShare)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
  return [line(head), ...body.map(line)].join('\n');
}

function format(s, file) {
  if (!s.window) return `${file}: no records in the window`;
  const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const out = [`${file}: ${s.all.n} holds, ${iso(s.window.from)} .. ${iso(s.window.to)}`, '',
    table('class', [...s.byClass, ['all', s.all]]), '', table('worktree', s.byWorktree)];
  if (s.noBudget.n) out.push('', `no worker budget (full runs back in the queue with 75): ${s.noBudget.n}, held ${dur(s.noBudget.holdTotal)} - waiting, not work`);
  return out.join('\n');
}

function defaultJournal() {
  if (process.env.SLOT_JOURNAL) return process.env.SLOT_JOURNAL;
  try {
    const cfg = require('./config');
    const f = cfg.find();
    const { config } = f ? cfg.load(f) : {};
    if (config) return path.join(config.slots.lockDir, 'journal.tsv');
  } catch { /* no config: fall through */ }
  return path.join(require('os').homedir(), '.cache', 'codis-agents', 'slots', 'journal.tsv');
}

module.exports = { parseLine, parse, parseTime, median, stats, summarize, format, FIELDS };

if (require.main === module) {
  const a = process.argv.slice(2), opt = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') opt.json = true;
    else if (['--journal', '--since', '--until'].includes(a[i]) && a[i + 1] !== undefined) opt[a[i].slice(2)] = a[++i];
    else { console.error('usage: slot-journal.js [--journal <file>] [--since <30m|6h|2d|date|epoch>] [--until <...>] [--json]'); process.exit(64); }
  }
  const file = opt.journal || defaultJournal();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`slot-journal: cannot read ${file}: ${e.message}`); process.exit(66); }
  let since, until;
  try { since = opt.since ? parseTime(opt.since) : undefined; until = opt.until ? parseTime(opt.until) : undefined; }
  catch (e) { console.error(`slot-journal: ${e.message}`); process.exit(64); }
  const { records, bad } = parse(text);
  const s = summarize(records, { since, until });
  if (opt.json) console.log(JSON.stringify({ journal: file, badLines: bad, ...s }, null, 2));
  else console.log(format(s, file) + (bad ? `\n\n${bad} line(s) not understood, skipped` : ''));
}
