#!/usr/bin/env node
'use strict';
// chain-cost.js over the call journal of the role adapter (p-codex-C): `--journal <task dir | calls.jsonl>` reads the
// one line per call that scripts/role-exec.js appends to <task dir>/calls.jsonl, next to the Workflow transcripts.
// IE = fresh + 1.25 x cacheWrite + 0.1 x cachedInput + 5 x output; codex: fresh = input - cachedInput - cacheWrite (its
// input_tokens holds the cache read and the cache write), the coefficients by the model's price table; claude: fresh =
// input. Real usage numbers of experiment X0 (codex E1, E2, E3; claude E1c) and of the strict-schema check G6 (twelve
// calls by API key, cache writes not zero); no model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'chain-cost.js');
let CC = {};
try { CC = require(CLI); } catch (e) { ok('scripts/chain-cost.js loads', false, e.message); }
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-journal-')));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', cwd: tmp, env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: path.join(tmp, 'none.json') }) });
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
const fn = (name) => typeof CC[name] === 'function';

// The records as role-exec.js writes them (p-codex-A analysis 5.2): usage = the raw numbers of the host.
const E1 = { input: 1743826, cachedInput: 1614720, cacheWrite: 0, output: 10667, reasoning: 2750 };
const E2 = { input: 1434737, cachedInput: 1314816, cacheWrite: 0, output: 8141, reasoning: 1100 };
const E3 = { input: 629235, cachedInput: 553216, cacheWrite: 0, output: 5308, reasoning: 729 };
const E1C = { input: 64, cachedInput: 2853902, cacheWrite: 118904, output: 19126 };
const G6 = [[13221, 13218, 23, 0], [13384, 13381, 47, 0], [13257, 13254, 32, 0], [13543, 13540, 59, 14], [13309, 13306, 142, 107],
  [13201, 13198, 23, 0], [13259, 13256, 83, 44], [13185, 13182, 17, 0], [13224, 13221, 28, 0], [13290, 13287, 52, 0],
  [13237, 13234, 41, 0], [13213, 13210, 28, 0]].map(([input, cacheWrite, output, reasoning]) => ({ input, cachedInput: 0, cacheWrite, output, reasoning }));
let seq = 0;
const rec = (o) => Object.assign({
  ts: '2026-11-05T10:00:00.000Z', host: 'codex', cliVersion: '0.166.0', label: 'review:ai-gate-a#1', task: 'ai-gate-a', role: 'reviewer',
  phase: 'Review', model: 'gpt-6-astra', effort: 'high', outcome: 'ok', usage: null, costUSD: null, notes: [], sessionId: null,
  callDir: `/w/calls/c${++seq}`,
}, o);
const journal = (dir, recs, tail = '') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'calls.jsonl'), recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n' + tail);
  return dir;
};

try {
  // ---- the formula (C-02, C-04, C-05, C-06)
  if (fn('ieOfCall')) {
    const ie = (r) => CC.ieOfCall(r).ie;
    ok('C-02 codex X0 E1: IE 343 913 (fresh 129 106 = input - cached - write, 0.1 x cached, 5 x output)', near(ie(rec({ usage: E1 })), 343913), JSON.stringify(CC.ieOfCall(rec({ usage: E1 }))));
    ok('C-06 codex: reasoning is inside output and is not added (E1 with reasoning 2 750 is still 343 913)', near(ie(rec({ usage: E1 })), 343913) && near(ie(rec({ usage: Object.assign({}, E1, { reasoning: 0 }) })), 343913));
    ok('C-02 codex X0 E2 292 107.6, E3 157 880.6', near(ie(rec({ usage: E2 })), 292107.6) && near(ie(rec({ usage: E3 })), 157880.6));
    ok('C-04 codex G6 PRE: cache write at 1.25, fresh 3 -> 16 640.5', near(ie(rec({ usage: G6[0] })), 16640.5), String(ie(rec({ usage: G6[0] }))));
    ok('C-05 claude X0 E1c: fresh = input (64), output = real tokens 19 126 -> 529 714.2', near(ie(rec({ host: 'claude', model: 'opus', usage: E1C })), 529714.2), String(ie(rec({ host: 'claude', model: 'opus', usage: E1C }))));
  } else ok('ieOfCall is exported', false);

  // ---- one task, three codex calls; G6 twelve calls (C-03, C-04, G1)
  const jA = journal(path.join(tmp, 'A'), [rec({ usage: E1, callDir: '/w/calls/a1' }), rec({ label: 'review:ai-gate-a#2', usage: E2, callDir: '/w/calls/a2' }),
    rec({ label: 'review:ai-gate-a#3', usage: E3, callDir: '/w/calls/a3' })]);
  const g6 = G6.map((u, i) => rec({ label: `review:g6#${i + 1}`, task: 'g6', usage: u }));
  const jG = journal(path.join(tmp, 'G'), g6);
  if (fn('journalCost')) {
    let r = CC.journalCost([jA]);
    ok('C-03 three codex calls of one task: IE 793 901.2, 3 agents, role review', r.tasks['ai-gate-a'] && near(r.tasks['ai-gate-a'].ie, 793901.2) && r.tasks['ai-gate-a'].agents === 3 && near(r.tasks['ai-gate-a'].byRole.review, 793901.2), JSON.stringify(r.tasks));
    r = CC.journalCost([jG]);
    ok('C-04 G6 twelve calls by API key: 202 019.75 IE, 12 agents', r.tasks.g6 && near(r.tasks.g6.ie, 202019.75) && r.tasks.g6.agents === 12, JSON.stringify(r.tasks));
    // G1: a record is merged with another only by a non-empty callDir; records without one are separate calls
    const jN = journal(path.join(tmp, 'N'), G6.map((u, i) => rec({ label: `review:g6#${i + 1}`, task: 'g6', usage: u, callDir: null, sessionId: null })));
    r = CC.journalCost([jN]);
    ok('G1 twelve G6 records without callDir and sessionId: 12 agents, 202 019.75', r.tasks.g6 && r.tasks.g6.agents === 12 && near(r.tasks.g6.ie, 202019.75), JSON.stringify(r.tasks));
    const same = rec({ outcome: 'crashed', usage: null, callDir: null, error: 'the call folder: EACCES' });
    const jC = journal(path.join(tmp, 'C2'), [same, Object.assign({}, same)]);
    r = CC.journalCost([jC]);
    ok('G1 two identical crashed records without a call folder: 2 agents', r.tasks['ai-gate-a'] && r.tasks['ai-gate-a'].agents === 2, JSON.stringify(r.tasks));
    // a copy of a task folder: the same record (same callDir) in two files is counted once, with a note
    const jCopy = journal(path.join(tmp, 'Acopy'), [rec({ usage: E1, callDir: '/w/calls/a1' })]);
    const notes = [];
    r = CC.journalCost([jA, jCopy], notes);
    ok('G1 the same call (same callDir) in two journals: counted once, a note names it', r.tasks['ai-gate-a'].agents === 3 && near(r.tasks['ai-gate-a'].ie, 793901.2) && notes.some((n) => n.includes('/w/calls/a1') && /already counted/.test(n)), JSON.stringify(r.tasks) + ' ' + notes.join(' | '));

    // ---- C-07: one journal named twice (folder and file, symlink, hard link) is read once
    const n7 = [];
    fs.symlinkSync(path.join(jA, 'calls.jsonl'), path.join(tmp, 'link.jsonl'));
    fs.linkSync(path.join(jA, 'calls.jsonl'), path.join(tmp, 'hard.jsonl'));
    r = CC.journalCost([jA, path.join(jA, 'calls.jsonl'), path.join(tmp, 'link.jsonl'), path.join(tmp, 'hard.jsonl')], n7);
    ok('C-07 one journal as folder, file, symlink, hard link: read once', r.tasks['ai-gate-a'].agents === 3 && near(r.tasks['ai-gate-a'].ie, 793901.2), JSON.stringify(r.tasks));
    ok('C-07 a note "given twice" for each repeat', n7.filter((n) => /given twice/.test(n)).length === 3, n7.join(' | '));

    // ---- C-08: call folders calls/<label>-.../events.jsonl are never read
    const ev = path.join(jA, 'calls', 'review_ai-gate-a_1-x');
    fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(path.join(ev, 'events.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 1e5 } }) + '\n');
    fs.writeFileSync(path.join(jA, 'calls', 'calls.jsonl'), JSON.stringify(rec({ usage: E1 })) + '\n');
    r = CC.journalCost([jA]);
    ok('C-08 only <task dir>/calls.jsonl is read, never the call folders', r.tasks['ai-gate-a'].agents === 3 && near(r.tasks['ai-gate-a'].ie, 793901.2), JSON.stringify(r.tasks));

    // ---- C-09 .. C-15: outcomes, refusals, unpriced models, broken records, keys
    const n9 = [];
    const j9 = journal(path.join(tmp, 'K9'), ['killed', 'ceiling', 'signalled', 'crashed'].flatMap((o) => [
      rec({ task: 'k9', label: 'review:k9#1', outcome: o, usage: null }), rec({ task: 'k9', label: 'review:k9#1', host: 'claude', model: null, outcome: o, usage: null })]));
    r = CC.journalCost([j9], n9);
    ok('C-09 launched calls without usage (killed, ceiling, signalled, crashed; both hosts): agents counted, IE 0', r.tasks.k9 && r.tasks.k9.agents === 8 && r.tasks.k9.ie === 0, JSON.stringify(r.tasks));
    ok('C-09 a note: task k9, 8 calls without usage - IE is a lower bound', n9.some((n) => /task k9: 8 calls without usage/.test(n) && /lower bound/.test(n)), n9.join(' | '));
    const j10 = journal(path.join(tmp, 'K10'), [rec({ task: 'k10', outcome: 'invalid-result', usage: E3 }), rec({ task: 'k10', host: 'claude', model: null, outcome: 'no-result', usage: E1C }),
      rec({ task: 'k10', outcome: 'schema-refused', usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 } })]);
    r = CC.journalCost([j10]);
    ok('C-10 usage with an outcome other than ok counts (invalid-result, no-result; zeros give 0)', r.tasks.k10 && r.tasks.k10.agents === 3 && near(r.tasks.k10.ie, 157880.6 + 529714.2), JSON.stringify(r.tasks));
    const n11 = [];
    const ref = (o) => rec(Object.assign({ outcome: 'refused', usage: null, callDir: null, model: null, effort: null, error: 'refused' }, o));
    const j11 = journal(path.join(tmp, 'K11'), [ref({ task: 'only-refused', label: 'prog:only-refused#1' }), ref({ task: 'k11', label: 'pre:k11' }), rec({ task: 'k11', usage: E3 })]);
    r = CC.journalCost([j11], n11);
    ok('C-11 refused calls are no agents and no IE; a task of refusals alone is not created', !r.tasks['only-refused'] && r.tasks.k11 && r.tasks.k11.agents === 1 && near(r.tasks.k11.ie, 157880.6), JSON.stringify(r.tasks));
    ok('C-11 a note counts the refusals of the journal', n11.some((n) => n.includes('2 refused calls') && n.includes(path.join(j11, 'calls.jsonl'))), n11.join(' | '));
    const n12 = [];
    const j12 = journal(path.join(tmp, 'K12'), [rec({ task: 'k12', model: 'gpt-6.1-sol', usage: E1 }), rec({ task: 'k12', usage: E3 })]);
    r = CC.journalCost([j12], n12);
    ok('C-12 a codex model without prices: its call is an agent, its IE is not added', r.tasks.k12 && r.tasks.k12.agents === 2 && near(r.tasks.k12.ie, 157880.6) && r.tasks.k12.incomplete === 1, JSON.stringify(r.tasks));
    ok('C-12 a note names the model', n12.some((n) => n.includes('gpt-6.1-sol') && /no codex prices/.test(n)), n12.join(' | '));
    const n13 = [];
    const j13 = journal(path.join(tmp, 'K13'), [rec({ task: 'k13', host: 'gemini', usage: E3 }), rec({ task: 'k13', usage: Object.assign({}, E3, { output: '5308' }) }),
      rec({ task: 'k13', usage: Object.assign({}, E3, { cachedInput: -1 }) }), rec({ task: 'k13', usage: Object.assign({}, E3, { cacheWrite: 100000 }) }), rec({ task: 'k13', usage: E3 })],
    '{"host":"codex","task":"k13","usage":{"inp');
    r = CC.journalCost([j13], n13);
    const f13 = path.join(j13, 'calls.jsonl');
    ok('C-13 unknown host, a non-number, a negative, codex cached + write > input: skipped, the rest counted', r.tasks.k13 && r.tasks.k13.agents === 1 && near(r.tasks.k13.ie, 157880.6), JSON.stringify(r.tasks));
    ok('C-13 one note per skipped record with <file>:<line>', [1, 2, 3, 4].every((i) => n13.some((n) => n.startsWith(`${f13}:${i}: `))), n13.join(' | '));
    ok('C-14 a truncated last line: a note with its line number', n13.some((n) => n.startsWith(`${f13}:6: `) && /not a JSON record/.test(n)), n13.join(' | '));
    const j15 = journal(path.join(tmp, 'calls-unknown'), [rec({ task: null, label: 'x', usage: E3 }), rec({ task: 'Q', label: 'review:Q#1', usage: E3 })]);
    r = CC.journalCost([j15]);
    ok('C-15 task null -> key "?", task Q of the callsDir journal -> key Q', r.tasks['?'] && r.tasks.Q && r.tasks['?'].agents === 1 && r.tasks.Q.agents === 1, JSON.stringify(Object.keys(r.tasks)));
  } else ok('journalCost is exported', false);

  // ---- both sources: transcripts of a Workflow run and journals (C-16 .. C-19, C-23, C-24)
  const ses = path.join(tmp, 'ses');
  const msg = (id, u, text) => JSON.stringify({ message: { id, role: 'assistant', usage: u, content: text ? [{ type: 'text', text }] : [] } });
  const runDir = (id, tasks, agents) => {
    const d = path.join(ses, 'subagents', 'workflows', id);
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(ses, 'workflows'), { recursive: true });
    if (tasks) fs.writeFileSync(path.join(ses, 'workflows', id + '.json'), JSON.stringify({ runId: id, args: { tasks } }));
    for (const [name, label, inp] of agents) {
      fs.writeFileSync(path.join(d, name + '.meta.json'), JSON.stringify({ description: label }));
      fs.writeFileSync(path.join(d, name + '.jsonl'), msg(name, { input_tokens: inp, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 }, ''));
    }
    return d;
  };
  const w1 = runDir('wf_1', [{ key: 'ai-gate-a' }, { key: 'fb', feature: 'F' }, { key: 'fc', feature: 'F1' }, { key: 'fd', feature: 'G' }],
    [['a1', 'prog:ai-gate-a#1', 4000000], ['a2', 'review:ai-gate-a#1', 200000], ['b1', 'prog:fb#1', 100000], ['c1', 'prog:fc#1', 100], ['d1', 'prog:fd#1', 100]]);
  const jMix = journal(path.join(tmp, 'mix'), [rec({ usage: E1 }), rec({ usage: E2, label: 'review:ai-gate-a#2' }), rec({ host: 'claude', model: 'opus', usage: E1C }),
    rec({ task: 'fa', label: 'review:fa#1', feature: 'F', usage: E3 }), rec({ task: 'fc', label: 'review:fc#1', feature: 'F2', usage: E3 }), rec({ task: 'fd', label: 'review:fd#1', usage: E3 })]);
  if (fn('costAll')) {
    const base = CC.costAll([w1]);
    const both = CC.costAll([w1], [jMix]);
    const a = both.tasks['ai-gate-a'], a0 = base.tasks['ai-gate-a'];
    ok('C-16 one key in transcripts and in the journal: IE and agents add up', a && near(a.ie, a0.ie + 1165734.8) && a.agents === a0.agents + 3, a && `${a.ie} ${a.agents}`);
    ok('C-16 roles merge by the kind of the label', a && near(a.byRole.review, a0.byRole.review + 1165734.8) && near(a.byRole.prog, a0.byRole.prog), a && JSON.stringify(a.byRole));
    ok('C-16 max context stays the transcripts\'', a && a.maxCtx === a0.maxCtx, a && String(a.maxCtx));
    const L = CC.report(both.tasks, 5e6, { features: both.features, featureLimit: 15e6 });
    const lineA = L.find((l) => l.startsWith('ai-gate-a: '));
    ok('C-16 the task line names its sources: [workflow 4.2M, claude 0.5M, codex 0.6M]', lineA && lineA.includes(' (prog 4.0M, review 1.4M) [workflow 4.2M, claude 0.5M, codex 0.6M]'), lineA);
    ok('C-17 feature F: a journal part with feature F and a transcript part of the run record add up', L.includes(`feature F: ${((100000 + 100 + 157880.6) / 1e6).toFixed(1)}M IE over 2 part(s) fa, fb`), L.join(' | '));
    ok('C-17 the journal feature of a key enters the features map', both.features.fa === 'F', JSON.stringify(both.features));
    ok('C-18 no feature in the journal: the run record\'s feature of the key holds (fd in G)', both.features.fd === 'G' && L.some((l) => l.startsWith('feature G: ') && l.includes('part(s) fd')), L.join(' | '));
    ok('C-19 the run record and the journal name different features of one key: a note with both, the key in no feature',
      both.notes.some((n) => n.includes('fc') && n.includes('F1') && n.includes('F2')) && !L.some((l) => /^feature F[12]: /.test(l) && l.includes('fc')), both.notes.join(' | ') + ' || ' + L.join(' | '));
    const bf = CC.byFeature({ F: { ie: 1 }, x: { ie: 2 } }, { F: null, x: 'F' });
    ok('C-19 a key with two features is in no feature, even when its key is a feature name', bf.F && bf.F.parts.join() === 'x' && bf.F.ie === 2, JSON.stringify(bf));
    const onlyJ = CC.costAll([], [jA]);
    const lineJ = CC.report(onlyJ.tasks, 5e6)[0];
    ok('C-23 a task from the journal alone: max context n/a, no waiting drops, its sources', lineJ === 'ai-gate-a: 0.8M IE, 3 agents, max context n/a (review 0.8M) [codex 0.8M]', lineJ);
    const L24 = CC.report(both.tasks, 2.5e6, { features: both.features, featureLimit: 1e5 });
    ok('C-24 the 2 x median flag over the sum of the sources', /^ai-gate-a: .*WARNING: above 2 x median \(5\.0M\)/.test(L24.find((l) => l.startsWith('ai-gate-a: '))), L24.join(' | '));
    ok('C-24 the feature flag over the sum of the sources', L24.some((l) => /^feature F: .*WARNING: feature above 0\.1M/.test(l)), L24.join(' | '));
    const inc = CC.report(CC.journalCost([path.join(tmp, 'K12')]).tasks, 5e6)[0];
    ok('C-12 the task line is marked "IE incomplete"', /^k12: 0\.2M IE, 2 agents, max context n\/a, IE incomplete \(/.test(inc), inc);
    // C-01: no journal - the same output as before
    const t1 = CC.report(base.tasks, 5e6, { features: base.features })[0];
    ok('C-01 transcripts only: the task line keeps its old form, no sources', t1 === 'ai-gate-a: 4.2M IE, 2 agents, max context 4001k (prog 4.0M, review 0.2M)', t1);
    ok('C-01 costAll(dirs, []) is costAll(dirs)', JSON.stringify(CC.costAll([w1], [])) === JSON.stringify(base));
  } else ok('costAll is exported', false);

  // ---- CLI (C-21, C-22) and the acceptance numbers through the command line
  let x = run('--journal', jA, '--journal', jG, '--median', '5e6');
  ok('C-21 --journal alone works, repeatable: exit 0', x.status === 0 && x.stdout.includes('ai-gate-a: 0.8M IE, 3 agents, max context n/a (review 0.8M) [codex 0.8M]') && x.stdout.includes('g6: 0.2M IE, 12 agents, max context n/a (review 0.2M) [codex 0.2M]'), x.status + ' ' + x.stdout + x.stderr);
  x = run('--journal', jA, '--journal', path.join(jA, 'calls.jsonl'), '--median', '5e6');
  ok('C-07 CLI: the same journal as folder and file is read once, a note', x.status === 0 && x.stdout.includes('ai-gate-a: 0.8M IE, 3 agents') && /note: journal .* given twice/.test(x.stdout), x.stdout + x.stderr);
  x = run();
  ok('C-21 no arguments: usage naming --journal, exit 64', x.status === 64 && /usage: .*--journal/.test(x.stderr), x.status + ' ' + x.stderr);
  x = run(w1, '--journal', jMix, '--median', '5e6');
  ok('C-16 CLI: transcripts and a journal together', x.status === 0 && x.stdout.includes('[workflow 4.2M, claude 0.5M, codex 0.6M]'), x.stdout + x.stderr);
  const oneLine = (y) => y.stderr.trim().split('\n').length === 1 && !/\n\s+at /.test(y.stderr) && y.stdout.trim() === '';
  const emptyDir = path.join(tmp, 'no-journal'); fs.mkdirSync(emptyDir);
  const emptyFile = path.join(tmp, 'empty.jsonl'); fs.writeFileSync(emptyFile, '');
  for (const [name, args, re] of [['a missing path', ['--journal', path.join(tmp, 'nope')], /no journal/],
    ['a folder without calls.jsonl', ['--journal', emptyDir], /no calls\.jsonl/], ['an empty file', ['--journal', emptyFile], /empty journal/],
    ['no value', ['--journal'], /--journal needs a path/], ['a flag as its value', ['--journal', '--median', '5e6'], /--journal needs a path/],
    ['a bad journal next to a good transcript dir', [w1, '--journal', emptyFile], /empty journal/]]) {
    x = run(...args);
    ok(`C-22 --journal on ${name}: exit 66, one line on stderr, no report`, x.status === 66 && oneLine(x) && re.test(x.stderr), `${x.status} ${x.stdout}${x.stderr}`);
  }
  x = run(w1, '--journal', jA, '--median', '5e6');
  ok('C-22 the value of --journal is not taken for a transcript directory', x.status === 0, x.status + ' ' + x.stderr);

  // ---- C-25: a record written by createAgent of role-exec.js through cfg.launch with the raw usage of E1
  let RX = null;
  try { RX = require(path.join(ROOT, 'scripts', 'role-exec.js')); } catch { /* reported below */ }
  (async () => {
    if (RX && typeof RX.createAgent === 'function') {
      const tdir = path.join(tmp, 'c25');
      const ag = RX.createAgent({
        host: 'codex', tasks: { c25: { wt: tmp, dir: tdir } }, pluginRoot: ROOT, callsDir: path.join(tmp, 'c25-calls'), log: () => {},
        launch: async () => ({ rc: 0, output: JSON.stringify({ verdict: 'done' }), usage: E1 }),
        codex: { bin: '/fake/codex', home: path.join(tmp, 'c25-home'), catalog: { models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'high' }] }] } },
      });
      const v = await ag('Review.\n', { label: 'review:c25#1', phase: 'Review', agentType: 'general-purpose', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } });
      const y = run('--journal', tdir, '--median', '5e6');
      const r = fn('journalCost') ? CC.journalCost([tdir]) : { tasks: {} };
      ok('C-25 a record of createAgent({launch}) with the raw usage of E1 -> 343 913', v && v.verdict === 'done' && r.tasks.c25 && near(r.tasks.c25.ie, 343913) && y.stdout.startsWith('c25: 0.3M IE, 1 agents, max context n/a (review 0.3M) [codex 0.3M]'),
        JSON.stringify(v) + ' ' + JSON.stringify(r.tasks) + ' ' + y.stdout + y.stderr);
    } else ok('C-25 scripts/role-exec.js createAgent loads', false);

    // ---- C-26 / G5: the living docs name the journal
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const row = read('README.md').split('\n').find((l) => l.startsWith('| `scripts/chain-cost.js` |')) || '';
    ok('C-26 README: the row of chain-cost.js names --journal and calls.jsonl', row.includes('--journal') && row.includes('calls.jsonl'), row);
    ok('C-26 README Known gaps: the 272K surcharge and calls killed before their usage', /272K/.test(read('README.md')) && /without usage/.test(read('README.md')));
    ok('C-26 skills: the coordinator and role-chain name --journal for chain-cost.js', /chain-cost\.js[^\n]*--journal/.test(read('skills/coordinator/SKILL.md')) && /chain-cost\.js[\s\S]{0,400}--journal/.test(read('skills/role-chain/SKILL.md')));
    ok('C-26 CHANGELOG 0.4.28 names --journal', /## 0\.4\.28[\s\S]*?--journal/.test(read('CHANGELOG.md').split('## 0.4.27')[0]));
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
  })();
} catch (e) {
  ok('the test ran to its end', false, e.stack);
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
}
