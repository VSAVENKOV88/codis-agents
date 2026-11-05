#!/usr/bin/env node
'use strict';
// Tester guards of p-codex-C (chain-cost.js --journal), the cells the programmer's guard leaves open:
// T1 a task of transcripts and journal with a codex model without prices: "IE incomplete" stays on the merged line, and
//    its max context is the transcripts' one (not n/a);
// T2 features of a journal key: two different `feature` values in the journal alone - a note, in no feature; the same
//    feature in the run record and the journal - counted in it, no note;
// T3 a codex model named like a property of Object.prototype (toString, constructor, __proto__) has no prices;
// T4 usage without input or output is refused, a missing cache field is 0, a claude record with cache above input is
//    counted (claude input excludes the cache);
// T5 the same non-empty callDir twice in one journal is counted once, with a note;
// T6 a journal with CRLF line ends is read like one with LF;
// T7 a claude record written by createAgent({launch}) of role-exec.js with the raw result.usage of X0 E1c -> 529 714.2;
// T8 calls without usage in two journals of one task are summed in one note per task.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CC = require(path.join(ROOT, 'scripts', 'chain-cost.js'));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-journal-tester-')));
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;

const E1 = { input: 1743826, cachedInput: 1614720, cacheWrite: 0, output: 10667, reasoning: 2750 };
const E3 = { input: 629235, cachedInput: 553216, cacheWrite: 0, output: 5308, reasoning: 729 };
const E1C = { input: 64, cachedInput: 2853902, cacheWrite: 118904, output: 19126 };
let seq = 0;
const rec = (o) => Object.assign({ host: 'codex', label: 'review:t#1', task: 't', role: 'reviewer', model: 'gpt-6-astra', outcome: 'ok', usage: null, callDir: `/w/calls/t${++seq}` }, o);
const journal = (name, recs, eol = '\n') => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'calls.jsonl'), recs.map((r) => JSON.stringify(r)).join(eol) + eol);
  return d;
};
// a Workflow run dir <ses>/subagents/workflows/<id> with its run record
const runDir = (id, tasks, agents) => {
  const ses = path.join(tmp, 'ses-' + id);
  const d = path.join(ses, 'subagents', 'workflows', id);
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(ses, 'workflows'), { recursive: true });
  if (tasks) fs.writeFileSync(path.join(ses, 'workflows', id + '.json'), JSON.stringify({ runId: id, args: { tasks } }));
  for (const [name, label, inp] of agents) {
    fs.writeFileSync(path.join(d, name + '.meta.json'), JSON.stringify({ description: label }));
    fs.writeFileSync(path.join(d, name + '.jsonl'), JSON.stringify({ message: { id: name, role: 'assistant', usage: { input_tokens: inp, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } }) + '\n');
  }
  return d;
};

(async () => {
  try {
    // ---- T1: merged task keeps "IE incomplete" and the transcripts' max context
    const w = runDir('wf_t1', [{ key: 'm' }], [['m1', 'prog:m#1', 300000]]);
    const j1 = journal('T1', [rec({ task: 'm', label: 'review:m#1', model: 'gpt-6.1-sol', usage: E1 }), rec({ task: 'm', label: 'review:m#2', usage: E3 })]);
    const b1 = CC.costAll([w], [j1]);
    const l1 = CC.report(b1.tasks, 5e6, { features: b1.features }).find((l) => l.startsWith('m: ')) || '';
    ok('T1 transcripts + journal with an unpriced codex model: the merged line says "IE incomplete"', /, IE incomplete \(/.test(l1), l1);
    ok('T1 the merged line keeps the transcripts\' max context 300k and names workflow and codex', /max context 300k, IE incomplete \(prog 0\.3M, review 0\.2M\) \[workflow 0\.3M, codex 0\.2M\]$/.test(l1), l1);
    ok('T1 the merged IE is transcripts + the priced call only, agents 1 + 2', near(b1.tasks.m.ie, 300000 + 157880.6) && b1.tasks.m.agents === 3, JSON.stringify(b1.tasks.m));

    // ---- T2: features of a journal key
    const j2 = journal('T2', [rec({ task: 'k2', label: 'review:k2#1', feature: 'FA', usage: E3 }), rec({ task: 'k2', label: 'review:k2#2', feature: 'FB', usage: E3 }),
      rec({ task: 'p2', label: 'review:p2#1', feature: 'FA', usage: E3 })]);
    const b2 = CC.costAll([], [j2]);
    const L2 = CC.report(b2.tasks, 5e6, { features: b2.features });
    ok('T2 two different features of one key in the journal alone: a note names both', b2.notes.some((n) => n.includes('k2') && n.includes('FA') && n.includes('FB')), b2.notes.join(' | '));
    ok('T2 that key is in no feature; the other part of FA still is', b2.features.k2 === null && L2.some((l) => l.startsWith('feature FA: ') && /over 1 part\(s\) p2$/.test(l)) && !L2.some((l) => l.startsWith('feature FB: ')), L2.join(' | '));
    const w2 = runDir('wf_t2', [{ key: 's2', feature: 'FS' }, { key: 'o2', feature: 'FS' }], [['o1', 'prog:o2#1', 1000]]);
    const j2b = journal('T2b', [rec({ task: 's2', label: 'review:s2#1', feature: 'FS', usage: E3 })]);
    const b2b = CC.costAll([w2], [j2b]);
    const L2b = CC.report(b2b.tasks, 5e6, { features: b2b.features });
    ok('T2 the same feature in the run record and the journal: no note, the key counts in it', !b2b.notes.some((n) => /features/.test(n)) && b2b.features.s2 === 'FS' && L2b.some((l) => l.startsWith('feature FS: ') && /part\(s\) o2, s2$/.test(l)), b2b.notes.join(' | ') + ' || ' + L2b.join(' | '));

    // ---- T3: model names of Object.prototype are no prices
    for (const m of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      let r; try { r = CC.ieOfCall(rec({ model: m, usage: E3 })); } catch (e) { r = { threw: e.message }; }
      ok(`T3 codex model "${m}" has no prices (unpriced, no IE, no throw)`, r && r.unpriced === m && r.ie === undefined, JSON.stringify(r));
    }
    ok('T3 the price table is frozen', Object.isFrozen(CC.CODEX_PRICES) && Object.isFrozen(CC.CODEX_PRICES['gpt-6-astra']));

    // ---- T4: required and optional usage fields
    const noIn = Object.assign({}, E3); delete noIn.input;
    const noOut = Object.assign({}, E3); delete noOut.output;
    ok('T4 usage without input is refused', !!CC.ieOfCall(rec({ usage: noIn })).bad, JSON.stringify(CC.ieOfCall(rec({ usage: noIn }))));
    ok('T4 usage without output is refused', !!CC.ieOfCall(rec({ usage: noOut })).bad, JSON.stringify(CC.ieOfCall(rec({ usage: noOut }))));
    ok('T4 usage.input NaN or Infinity is refused', !!CC.ieOfCall(rec({ usage: Object.assign({}, E3, { input: NaN }) })).bad && !!CC.ieOfCall(rec({ usage: Object.assign({}, E3, { output: Infinity }) })).bad);
    ok('T4 a missing or null cache field is 0 (codex: fresh = input)', near(CC.ieOfCall(rec({ usage: { input: 1000, output: 10, cachedInput: null } })).ie, 1050), JSON.stringify(CC.ieOfCall(rec({ usage: { input: 1000, output: 10, cachedInput: null } }))));
    ok('T4 claude: cache above input is normal and counted (E1c 529 714.2), not refused', near(CC.ieOfCall(rec({ host: 'claude', model: null, usage: E1C })).ie, 529714.2));
    ok('T4 claude: any model, also none, uses the claude coefficients', near(CC.ieOfCall(rec({ host: 'claude', model: 'gpt-6-astra', usage: E1C })).ie, 529714.2) && near(CC.ieOfCall(rec({ host: 'claude', usage: E1C, model: undefined })).ie, 529714.2));
    ok('T4 usage that is an array or a string is refused', !!CC.ieOfCall(rec({ usage: [1, 2] })).bad && !!CC.ieOfCall(rec({ usage: 'x' })).bad);

    // ---- T5: one callDir twice in one journal
    const n5 = [];
    const r5 = CC.journalCost([journal('T5', [rec({ task: 'k5', usage: E3, callDir: '/w/c/same' }), rec({ task: 'k5', usage: E1, callDir: '/w/c/same' })])], n5);
    ok('T5 the same callDir twice in one journal: counted once (the first), a note with line 2', r5.tasks.k5 && r5.tasks.k5.agents === 1 && near(r5.tasks.k5.ie, 157880.6) && n5.some((n) => /calls\.jsonl:2: the call \/w\/c\/same is already counted/.test(n)), JSON.stringify(r5.tasks) + ' ' + n5.join(' | '));

    // ---- T6: CRLF
    const n6 = [];
    const r6 = CC.journalCost([journal('T6', [rec({ task: 'k6', usage: E1 }), rec({ task: 'k6', usage: E3 })], '\r\n')], n6);
    ok('T6 CRLF line ends: both records counted, no note', r6.tasks.k6 && r6.tasks.k6.agents === 2 && near(r6.tasks.k6.ie, 343913 + 157880.6) && n6.length === 0, JSON.stringify(r6.tasks) + ' ' + n6.join(' | '));

    // ---- T8: calls without usage of one task across two journals: one note
    const n8 = [];
    CC.journalCost([journal('T8a', [rec({ task: 'k8', outcome: 'killed' })]), journal('T8b', [rec({ task: 'k8', outcome: 'ceiling' }), rec({ task: 'k8', host: 'claude', outcome: 'signalled' })])], n8);
    const l8 = n8.filter((n) => /^task k8: /.test(n));
    ok('T8 calls without usage of one task in two journals: one note, 3 calls by outcome', l8.length === 1 && /3 calls without usage \(killed 1, ceiling 1, signalled 1\) - IE is a lower bound/.test(l8[0]), n8.join(' | '));

    // ---- T7: a claude record of createAgent({launch}) with the raw result.usage of X0 E1c
    const RX = require(path.join(ROOT, 'scripts', 'role-exec.js'));
    const tdir = path.join(tmp, 't7');
    const raw = { input_tokens: 64, cache_creation_input_tokens: 118904, cache_read_input_tokens: 2853902, output_tokens: 19126 };
    const ag = RX.createAgent({ host: 'claude', tasks: { t7: { wt: tmp, dir: tdir } }, pluginRoot: ROOT, callsDir: path.join(tmp, 't7-calls'), log: () => {},
      launch: async () => ({ rc: 0, output: { verdict: 'done' }, usage: { input: raw.input_tokens, cachedInput: raw.cache_read_input_tokens, cacheWrite: raw.cache_creation_input_tokens, output: raw.output_tokens }, costUSD: 1.9047884 }) });
    const v = await ag('Review.\n', { label: 'review:t7#1', phase: 'Review', agentType: 'general-purpose', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } });
    const r7 = CC.journalCost([tdir]);
    const l7 = CC.report(r7.tasks, 5e6)[0];
    ok('T7 claude record of createAgent({launch}), raw E1c: 529 714.2 IE, costUSD not used', v && v.verdict === 'done' && r7.tasks.t7 && near(r7.tasks.t7.ie, 529714.2) && l7 === 't7: 0.5M IE, 1 agents, max context n/a (review 0.5M) [claude 0.5M]', JSON.stringify(r7.tasks) + ' ' + l7);
  } catch (e) {
    ok('the test ran to its end', false, e.stack);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  done();
})();
