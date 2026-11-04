#!/usr/bin/env node
'use strict';
// scripts/chain-cost.js: IE by the formula, a repeated usage under one id is not doubled, output by characters,
// agents grouped by the task key of the label (role:key#n, diff:key:role); the report flags tasks above 2 x median;
// parts of one feature (explicit task field `feature` in the run record) are summed across runs and flagged above the limit.
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

// Per feature: parts with the same explicit `feature` (from the run record <session>/workflows/<run>.json) are summed
// across runs and flagged above featureIELimit (default 3 x median); the per-part flag stays; no guessing by key prefix.
const ses = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-ses-'));
try {
  const u1 = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };   // 1000 IE per call
  const runDir = (id, tasks, agents, rawArgs) => {
    const d = path.join(ses, 'subagents', 'workflows', id);
    fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(ses, 'workflows'), { recursive: true });
    if (tasks) fs.writeFileSync(path.join(ses, 'workflows', id + '.json'), JSON.stringify({ runId: id, args: rawArgs ? JSON.stringify({ tasks }) : { tasks } }));
    for (const [name, label, calls] of agents) {
      fs.writeFileSync(path.join(d, name + '.meta.json'), JSON.stringify({ description: label }));
      fs.writeFileSync(path.join(d, name + '.jsonl'), Array.from({ length: calls }, (_, i) => msg(name + i, u1, '')).join('\n'));
    }
    return d;
  };
  const r1 = runDir('wf_1', [{ key: 'q3a', feature: 'q3' }, { key: 'q3b', feature: 'q3' }, { key: 'x1' }],
    [['b1', 'prog:q3a#1', 4], ['b2', 'prog:q3b#1', 3], ['b3', 'prog:x1#1', 2]]);
  const r2 = runDir('wf_2', [{ key: 'q3c', feature: 'q3' }, { key: 'q3d' }], [['c1', 'test:q3c#1', 5], ['c2', 'prog:q3d#1', 1]], true);
  const r3 = runDir('wf_3', null, [['d1', 'prog:q3e#1', 1]]);
  const { costAll, report: rep } = require('../scripts/chain-cost');
  const all = costAll([r1, r2, r3]);
  ok('features from the run records (args as object or JSON string)', JSON.stringify(all.features) === JSON.stringify({ q3a: 'q3', q3b: 'q3', q3c: 'q3' }), JSON.stringify(all.features));
  ok('a run without a record is named in notes', all.notes.length === 1 && all.notes[0].includes('wf_3'), all.notes.join(' | '));
  const L = rep(all.tasks, 2000, { features: all.features });
  const fl = L.find((l) => l.startsWith('feature q3:')) || '';
  ok('feature q3 sums its parts across runs (4 + 3 + 5 calls = 12k IE)', /^feature q3: 0\.0M IE over 3 part\(s\) q3a, q3b, q3c/.test(fl) && Math.abs(require('../scripts/chain-cost').byFeature(all.tasks, all.features).q3.ie - 12000) < 1e-6, fl);
  ok('no grouping by key prefix: q3d and q3e (no feature) are not in q3', !/q3d|q3e/.test(fl), fl);
  ok('a task without feature gets no feature line', !L.some((l) => /^feature (x1|q3d|q3e):/.test(l)), L.join(' | '));
  ok('feature above the default limit 3 x median (6000) is flagged', /WARNING: feature above/.test(fl), fl);
  ok('per-part flag stays: q3c (5000 > 2 x 2000) flagged, q3a (4000 = 2 x median) not', /^q3c: .*WARNING: above 2 x median/.test(L.find((l) => l.startsWith('q3c:'))) && !/WARNING/.test(L.find((l) => l.startsWith('q3a:'))), L.join(' | '));
  const L2 = rep(all.tasks, 2000, { features: all.features, featureLimit: 20000 });
  ok('featureLimit from the config wins: 12000 under 20000 -> no feature flag', !/WARNING/.test(L2.find((l) => l.startsWith('feature q3:'))), L2.join(' | '));
  const r4 = runDir('wf_4', [{ key: 'q3', }], [['e1', 'prog:q3#1', 2]]);
  const all2 = costAll([r1, r4]);
  ok('a task whose key is the feature name counts in that feature', /^feature q3: .* 3 part\(s\) q3, q3a, q3b/.test(rep(all2.tasks, 2000, { features: all2.features }).find((l) => l.startsWith('feature q3:')) || ''));
  const cli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'chain-cost.js'), r1, r2, '--median', '2000', '--feature-limit', '11000'], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: path.join(ses, 'none.json') }) });
  ok('CLI: several directories, --median and --feature-limit', cli.status === 0 && /feature q3: .*WARNING: feature above 0\.0M/.test(cli.stdout) && /^q3c: .*WARNING/m.test(cli.stdout), cli.stdout + cli.stderr);
} finally {
  fs.rmSync(ses, { recursive: true, force: true });
}

// G4 (p-tester-drop): a "waiting drop" - the agent ended a turn with text ("end_turn") instead of a tool call and the
// harness forced the final output ("[structured-output-enforce]") while a background job it had started was still alive
// (no <status>completed|failed|killed since). Deterministic, no threshold; it marks the green/ready/environment
// verdicts whose own checks (a stand ticket, an acceptance, a full run) were cut off mid-wait.
const g4 = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-g4-'));
try {
  const { waitDropsOfAgent, cost: costG4, report: repG4 } = require('../scripts/chain-cost');
  const asst = (stop, text) => JSON.stringify({ message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [] } });
  const asstTool = (name, input) => JSON.stringify({ message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
  const result = (text) => JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const enforce = () => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.' } });
  const notif = (status, summary, id) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });

  // A1b-like: a stand take in the background that never finishes, then "Waiting." (end_turn) and the enforce -> one drop.
  const a1b = [asstTool('Bash', { command: 'stand.sh take --wt /wt', run_in_background: true }),
    result('Command running in background with ID: bxxx'),
    asst('end_turn', 'Waiting.'), enforce()];
  // round-6-like: the background job completes, then the role calls StructuredOutput (tool_use, no end_turn) -> no drop.
  const r6 = [asstTool('Bash', { command: 'heavy.sh accept.sh', run_in_background: true }),
    result('Command running in background with ID: byyy'),
    notif('completed', 'Background command "accept" completed (exit code 0)', 'byyy'),
    asstTool('StructuredOutput', { status: 'green' })];
  // a plain end-of-role by text with no live background job -> not a drop.
  const plain = [asst('end_turn', 'Done.'), enforce()];
  fs.writeFileSync(path.join(g4, 't1.meta.json'), JSON.stringify({ description: 'test:drop#1' }));
  fs.writeFileSync(path.join(g4, 't1.jsonl'), a1b.join('\n'));
  fs.writeFileSync(path.join(g4, 't2.meta.json'), JSON.stringify({ description: 'test:nodrop#5' }));
  fs.writeFileSync(path.join(g4, 't2.jsonl'), r6.join('\n'));
  fs.writeFileSync(path.join(g4, 't3.meta.json'), JSON.stringify({ description: 'prog:plain#1' }));
  fs.writeFileSync(path.join(g4, 't3.jsonl'), plain.join('\n'));

  ok('G4. waitDropsOfAgent: an end_turn+enforce with a live background job is a drop', waitDropsOfAgent(a1b.join('\n')) === 1, String(waitDropsOfAgent(a1b.join('\n'))));
  ok('G4. waitDropsOfAgent: a completed background job before a tool-call verdict is no drop', waitDropsOfAgent(r6.join('\n')) === 0, String(waitDropsOfAgent(r6.join('\n'))));
  ok('G4. waitDropsOfAgent: a plain text end with no background job is no drop', waitDropsOfAgent(plain.join('\n')) === 0, String(waitDropsOfAgent(plain.join('\n'))));
  const tg = costG4(g4);
  ok('G4. cost sums waiting drops per task', tg.drop.waitDrops === 1 && tg.nodrop.waitDrops === 0 && tg.plain.waitDrops === 0, JSON.stringify({ drop: tg.drop.waitDrops, nodrop: tg.nodrop.waitDrops, plain: tg.plain.waitDrops }));
  const lg = repG4(tg, 1e6);
  ok('G4. report flags a task with waiting drops', /^drop: .*1 waiting drop.*WARNING: a verdict with a cut-off wait/.test(lg.find((l) => l.startsWith('drop:'))) && !/waiting drop/.test(lg.find((l) => l.startsWith('plain:'))), lg.join(' | '));
} finally {
  fs.rmSync(g4, { recursive: true, force: true });
}

// Fixture shapes (round 2): every real task notification carries <task-id> and every Monitor result begins
// "Monitor started (task X" (session 39161f33: 19193 notifications, 2447 Monitor results, none otherwise), so the
// fixtures use the same shapes - the counter tracks live jobs by that id.
// W5 (p-tester-drop, tester): cells of the G4 counter the programmer's G4 block does not cover.
// W5.1 is the fix's own point - the correct waiting pattern (round 6: a blocking Bash loop over a live background job,
// the harness "moved to the background" notice, never an end_turn) must NOT be counted, or the counter would warn on
// every task. W5.2 covers the real mcp5p-A1b mechanism (a Monitor armed, then "Waiting." text), which the G4 fixtures
// (run_in_background Bash) do not exercise. W5.3 covers more than one drop in one agent.
{
  const { waitDropsOfAgent } = require('../scripts/chain-cost');
  const asst = (stop, text) => JSON.stringify({ message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [] } });
  const asstTool = (name, input) => JSON.stringify({ message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
  const result = (text) => JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const enforce = () => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request.' } });

  // W5.1: a role starts a heavy job in the background and then waits with a blocking Bash loop - the loop's command is
  // "moved to the background" on each 270 s timeout, but the role always answers with a tool call (never end_turn), so
  // no turn of text alone is forced and the counter must report zero.
  const good = [
    asstTool('Bash', { command: 'heavy.sh guards-all.sh wt', run_in_background: true }),
    result('Command running in background with ID: bzzz'),
    asstTool('Bash', { command: 'until grep -q DONE log; do sleep 3; done', timeout: 270000 }),
    result('Command did not complete within its 270s timeout and was moved to the background'),
    asstTool('Bash', { command: 'until grep -q DONE log; do sleep 3; done', timeout: 270000 }),
    result('DONE rc 0'),
    asstTool('StructuredOutput', { verdict: 'green' }),
  ].join('\n');
  ok('W5.1. the correct blocking-loop wait (no end_turn) over a live background job is not a drop', waitDropsOfAgent(good) === 0, String(waitDropsOfAgent(good)));

  // W5.2: the real A1b mechanism - a Monitor is armed (its result line reports it started), then the role ends the turn
  // with "Waiting." and the harness forces the output. One drop.
  const monDrop = [
    asstTool('Monitor', { command: 'until-loop' }),
    result('Monitor started (task m1, expires in 4m 30s unless the source ends first). Keep working - do not poll or sleep.'),
    asst('end_turn', 'Waiting.'),
    enforce(),
  ].join('\n');
  ok('W5.2. a Monitor armed then an end_turn+enforce is a drop (the A1b mechanism)', waitDropsOfAgent(monDrop) === 1, String(waitDropsOfAgent(monDrop)));

  // W5.3: two separate end_turn+enforce turns over live background jobs in one agent -> two drops.
  const twice = [
    asstTool('Bash', { command: 'stand.sh take', run_in_background: true }),
    result('Command running in background with ID: b1'),
    asst('end_turn', 'Waiting for the ticket.'),
    enforce(),
    asstTool('Bash', { command: 'heavy.sh accept', run_in_background: true }),
    result('Command running in background with ID: b2'),
    asst('end_turn', 'Waiting for the acceptance.'),
    enforce(),
  ].join('\n');
  ok('W5.3. two end_turn+enforce turns with live background jobs count as two drops', waitDropsOfAgent(twice) === 2, String(waitDropsOfAgent(twice)));
}

// F1 (p-tester-drop, round r, review.md): the two cells the G4/W5 blocks leave uncovered - the false positives of the
// counter on real data. A background start must be counted once (from the assistant tool_use run_in_background, or a
// Monitor armed), never from the "running in background with ID" echo (that double-counts) nor the wait-loop "moved to
// the background" notice (the correct 270 s wait, which is the mechanism this task introduces). Without that, a task
// that started AND completed a background job with its notification, and a run: step whose blocking loop ran to the end,
// both get a false drop and light the per-task WARNING on nearly every task.
{
  const { waitDropsOfAgent } = require('../scripts/chain-cost');
  const asst = (stop, text) => JSON.stringify({ message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [] } });
  const asstTool = (name, input) => JSON.stringify({ message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
  const result = (text) => JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const enforce = () => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request.' } });
  const notif = (status, summary, id) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });

  // F1.a: a background job started AND completed with its notification, THEN the role ends the turn with text and the
  // harness forces the output. The completion was notified, so by G4 ("no <status>completed since") this is NOT a drop.
  // (The G4 r6 fixture ends with a tool call, not end_turn+enforce, so this path is not exercised there.)
  const doneThenText = [
    asstTool('Bash', { command: 'heavy.sh guards-all.sh wt', run_in_background: true }),
    result('Command running in background with ID: bddd'),
    notif('completed', 'Background command "guards-all" completed (exit code 0)', 'bddd'),
    asst('end_turn', 'Full run green, 137/138.'),
    enforce(),
  ].join('\n');
  ok('F1.a. a background job completed with its notification then a text verdict is not a drop', waitDropsOfAgent(doneThenText) === 0, String(waitDropsOfAgent(doneThenText)));

  // F1.b: a run: step (wait-step.js wait) whose foreground blocking loop was "moved to the background" on each 270 s
  // timeout and then ran to the end, finishing with a text summary. No background job was left alive -> not a drop.
  const runStep = [
    asstTool('Bash', { command: 'until grep -q DONE sel.log; do sleep 3; done', timeout: 270000 }),
    result('Command did not complete within its 270s timeout and was moved to the background'),
    asstTool('Bash', { command: 'until grep -q DONE sel.log; do sleep 3; done', timeout: 270000 }),
    result('DONE selection 10/0'),
    asst('end_turn', 'Selection green, 10/0.'),
    enforce(),
  ].join('\n');
  ok('F1.b. a finished run: step (blocking loop, no live background job) is not a drop', waitDropsOfAgent(runStep) === 0, String(waitDropsOfAgent(runStep)));
}

// W6 (p-tester-drop, tester round 2): the G4 counter on the shape of real transcripts, which the synthetic G4/W5/F1
// fixtures do not have. A transcript line is one JSON object, so the newlines of a long text are the two characters
// "\n" and a pattern like /Monitor[^\n]*started/ runs over the whole line. The first lines of every agent carry the
// harness and project instructions (a deferred tool list "...Monitor\nNotebookEdit...", rule text "...A-Monitor (copy)
// ... a full run started"), and one task notification is queued with its text repeated in one attachment line.
// W6.1 (run:addr-K1a:full-2, session 39161f33): a run: step that only called wait-step.js wait in the foreground,
// got done:true and ended with a text summary -> no background job at all, not a drop.
// W6.2 (test:addr-A1a-2#1, the hidden green of diagnosis section 3): a job started and completed (its notification
// repeated three times in one line), then a second job and a Monitor armed, then "Waiting on monitor ..." text and the
// enforce -> one drop: the Monitor and the second job are alive.
{
  const { waitDropsOfAgent } = require('../scripts/chain-cost');
  const asst = (stop, text) => JSON.stringify({ message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [] } });
  const asstTool = (name, input) => JSON.stringify({ message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
  const result = (text) => JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const enforce = () => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request.' } });
  const harness = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n- The DS corpus A-Monitor (copy) is read-only.\n- No full guard run in the main working copy.\n  Why: a full run started with the main working copy wiped the corpus.\n</system-reminder>' }] } }),
    JSON.stringify({ type: 'system', message: { role: 'system', content: [{ type: 'text', text: 'The following deferred tools are now available:\nCronCreate\nMonitor\nNotebookEdit\nTaskStop\n- role-chain: Started by the role-chain skill' }] } }),
  ];
  const notif3 = (id) => {
    const one = `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Background command completed (exit code 0)</summary>\n</task-notification>`;
    return JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: one, text: `note\n\n${one}`, display: `note\n\n${one}` } });
  };

  const runStep = [
    ...harness,
    asstTool('Bash', { command: 'node wait-step.js start --id full-2' }),
    result('{"started":true,"pid":9407}'),
    asstTool('Bash', { command: 'node wait-step.js wait --id full-2 --max 270' }),
    result('{"done":false,"rc":null,"seconds":273}'),
    asstTool('Bash', { command: 'node wait-step.js wait --id full-2 --max 270' }),
    result('{"done":true,"rc":1,"seconds":905}'),
    asst('end_turn', 'The full guard run is finished: done, with rc 1.'),
    enforce(),
  ].join('\n');
  ok('W6.1. instruction text in the first lines (Monitor ... started) is no background start: a finished run: step is not a drop', waitDropsOfAgent(runStep) === 0, String(waitDropsOfAgent(runStep)));

  // No harness lines here: their phantom starts (W6.1) would hide the over-counted completions this cell isolates.
  const hiddenGreen = [
    asstTool('Bash', { command: 'heavy.sh guards-all.sh --select base', run_in_background: true }),
    result('Command running in background with ID: b6q. Output is being written to: b6q.output.'),
    notif3('b6q'),
    asstTool('Bash', { command: 'heavy.sh dom-forms', run_in_background: true }),
    result('Command running in background with ID: bpz. Output is being written to: bpz.output.'),
    asstTool('Monitor', { command: 'until grep -q ^rc= sel.out; do sleep 5; done', timeout_ms: 270000 }),
    result('Monitor started (task bdo, expires in 4m 30s unless the source ends first). Keep working - do not poll or sleep.'),
    asst('end_turn', 'Waiting on monitor bdo for the selection to finish.'),
    enforce(),
  ].join('\n');
  ok('W6.2. a notification repeated in one line closes one job, not three: a live Monitor and job at the text end is a drop', waitDropsOfAgent(hiddenGreen) === 1, String(waitDropsOfAgent(hiddenGreen)));
}

// W7 (p-tester-drop, programmer round 2): live jobs are tracked by id, not by a balance of counts.
// W7.1: a foreground command that overran its timeout ("moved to the background") is no start, but its completion
// notice must not cancel a different live job: a Monitor armed after it is still alive at the text end -> one drop.
// W7.2: a tool_result that merely quotes the echo text (a file read) is no start: only a result that begins with the
// echo is one.
{
  const { waitDropsOfAgent } = require('../scripts/chain-cost');
  const asst = (stop, text) => JSON.stringify({ message: { role: 'assistant', stop_reason: stop, content: text ? [{ type: 'text', text }] : [] } });
  const asstTool = (name, input) => JSON.stringify({ message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
  const result = (text) => JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: text }] } });
  const enforce = () => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request.' } });
  const notif = (id) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` } });
  const moved = [
    asstTool('Monitor', { command: 'until grep -q rc= run.out; do sleep 5; done', timeout_ms: 270000 }),
    result('Monitor started (task bmo, expires in 4m 30s unless the source ends first).'),
    asstTool('Bash', { command: 'until grep -q done x.log; do sleep 3; done', timeout: 270000 }),
    result('Command was manually backgrounded by user... moved to the background (ID: bmv). Output is being written to: bmv.output'),
    notif('bmv'),
    asst('end_turn', 'Waiting on monitor bmo.'),
    enforce(),
  ].join('\n');
  ok('W7.1. a completion of a job that was never counted does not hide a live Monitor: one drop', waitDropsOfAgent(moved) === 1, String(waitDropsOfAgent(moved)));
  const quoted = [
    asstTool('Read', { file_path: 'notes.md' }),
    result('line one\nCommand running in background with ID: bq1. Output is being written to: bq1.output\nMonitor started (task bq2, expires)'),
    asst('end_turn', 'Done.'),
    enforce(),
  ].join('\n');
  ok('W7.2. a tool_result that quotes the echo text past its start is no background start: not a drop', waitDropsOfAgent(quoted) === 0, String(waitDropsOfAgent(quoted)));
  // W7.3: the assistant's own text that quotes a notification of a live job does not end that job.
  const selfQuote = [
    asstTool('Monitor', { command: 'until grep -q rc= run.out; do sleep 5; done', timeout_ms: 270000 }),
    result('Monitor started (task bm3, expires in 4m 30s unless the source ends first).'),
    asst('end_turn', 'Waiting for <task-id>bm3</task-id> <status>completed</status>.'),
    enforce(),
  ].join('\n');
  ok('W7.3. the assistant quoting a notification does not end a live job: one drop', waitDropsOfAgent(selfQuote) === 1, String(waitDropsOfAgent(selfQuote)));
  // W7.4: a job that ended "failed" or "killed" is no longer alive: a text verdict after it is not a drop.
  for (const st of ['failed', 'killed']) {
    const ended = [
      asstTool('Bash', { command: 'heavy.sh accept.sh', run_in_background: true }),
      result('Command running in background with ID: bf4. Output is being written to: bf4.output'),
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>bf4</task-id>\n<status>${st}</status>\n</task-notification>` } }),
      asst('end_turn', 'Acceptance red.'),
      enforce(),
    ].join('\n');
    ok(`W7.4. a job that ended ${st} is not alive: a text verdict after it is not a drop`, waitDropsOfAgent(ended) === 0, String(waitDropsOfAgent(ended)));
  }
}
done();
