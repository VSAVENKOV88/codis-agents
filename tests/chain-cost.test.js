#!/usr/bin/env node
'use strict';
// scripts/chain-cost.js: IE by the formula, a repeated usage under one id is not doubled, output by characters,
// agents grouped by the task key of the label (role:key#n, diff:key:role); the report flags tasks above 2 x median.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cost, report } = require('../scripts/chain-cost');
const { ok, done } = require('./lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-'));
const msg = (id, u, text) => JSON.stringify({ message: { id, role: 'assistant', usage: u, content: text ? [{ type: 'text', text }] : [] } });
const agentFile = (name, label, lines) => {
  fs.writeFileSync(path.join(dir, name + '.meta.json'), JSON.stringify({ description: label }));
  fs.writeFileSync(path.join(dir, name + '.jsonl'), lines.join('\n'));
};
try {
  const u = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
  agentFile('a1', 'prog:q2#1', [msg('m1', u, 'x'.repeat(32)), msg('m1', u, '')]);   // m1 repeated - usage counted once
  agentFile('a2', 'test:q2#1', [msg('m2', u, '')]);
  agentFile('a3', 'diff:q2:tester', [msg('m3', u, '')]);
  agentFile('a4', 'prog:st3#1', [msg('m4', { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '')]);
  const t = cost(dir);
  const one = 100 + 1.25 * 1000 + 0.1 * 10000;               // 2350
  ok('per task: q2 and st3', Object.keys(t).sort().join() === 'q2,st3', Object.keys(t).join());
  ok('IE of q2 = 3 calls + output of 32 characters', Math.abs(t.q2.ie - (3 * one + 5 * 32 / 3.2)) < 1e-6, String(t.q2.ie));
  ok('label diff:key:role goes to task key', t.q2.agents === 3 && t.q2.byRole.diff === one, JSON.stringify(t.q2.byRole));
  ok('max context = input + write + read', t.q2.maxCtx === 11100, String(t.q2.maxCtx));
  const lines = report(t, 3000);
  ok('report flags a task above 2 x median, not the others', /^q2: .*WARNING/.test(lines[0]) && !/WARNING/.test(lines[1]), lines.join(' | '));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
done();
