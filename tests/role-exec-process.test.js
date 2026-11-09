#!/usr/bin/env node
'use strict';
// scripts/role-exec.js, part A1b of the role adapter (p-codex-A): the process of a role. Without cfg.launch the adapter
// starts the host CLI itself (cfg.codex.bin / cfg.claude.bin), here a fake CLI: a Node script that reads its scenario
// from fake.json in its cwd (the task folder), saves its argv, env and stdin, prints a stream of JSONL events, writes the
// -o file, sleeps, spawns children, ignores SIGTERM or kills itself, and exits with a code. No model is called.
// Cells: success and parsing (A1-13 codex, A1-14 claude, A1-22 notes, A1-23 big prompt and stream), outcomes (A1-15
// schema-refused, A1-16 rate-limited, A1-17 auth, A1-18 crashed, A1-19 killed, A1-20 ceiling, A1-21 no-result),
// signals and parallel calls (A1-24, A1-25 and a unique call folder), the record (A1-26), login and sandbox (A1-27,
// A1-28, the personal ~/.codex refused), descendants outside the group (A1-35), the isolation of claude -p (A1-37),
// env-check with an unmeasured swap (A1-34). A1-33 (the slot scripts inside the codex sandbox) is a live check of the
// tester: this file does not run the slot scripts (tests/slots-hermetic.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'role-exec.js');
const FIX = path.join(__dirname, 'fixtures', 'role-exec');
const { createAgent, check, realish, overlap, hostSection } = require(SCRIPT);
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-models.json'), 'utf8'));

// REVIEW_SCHEMA from the source of role-chain.js (the schema of the acceptance calls)
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8');
const schemaOf = (name) => {
  const m = new RegExp(`const ${name} = \\{`).exec(SRC);
  let i = m.index + m[0].length - 1, d = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') d++; else if (SRC[i] === '}' && !--d) break; }
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(SRC.slice(m.index, i + 1).replace(/^const /, 'var ') + ';', ctx);
  return JSON.parse(JSON.stringify(ctx[name]));
};
const REVIEW = schemaOf('REVIEW_SCHEMA');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'role-exec-proc-'));
const leftovers = [];
process.on('exit', () => {
  for (const p of leftovers) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- the fake CLI
const FAKE = path.join(TMP, 'fake-cli.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const here = (f) => path.join(process.cwd(), f);
const sc = JSON.parse(fs.readFileSync(here('fake.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(here('runs.txt'), process.pid + '\\n');
if (sc.ignoreTerm) process.on('SIGTERM', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s) => new Promise((r) => process.stdout.write(s, r));
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', async () => {
  fs.writeFileSync(here('stdin-' + process.pid + '.txt'), Buffer.concat(chunks));
  // children first: the dump file tells a waiting test that the fake and its children are all up
  for (const k of [].concat(sc.child || [])) {
    const c = spawn('sleep', ['300'], { detached: k === 'session', stdio: 'ignore' });
    c.unref();
    fs.writeFileSync(here('child-' + k + '.pid'), String(c.pid));
  }
  fs.writeFileSync(here('dump-' + process.pid + '.json'), JSON.stringify({ argv, cwd: process.cwd(), env: process.env, pid: process.pid }));
  if (sc.delayMs) await sleep(sc.delayMs);
  for (const l of sc.lines || []) {
    const s = typeof l === 'string' ? l : JSON.stringify(l);
    if (sc.split) { const h = Math.floor(s.length / 2); await out(s.slice(0, h)); await sleep(20); await out(s.slice(h) + '\\n'); }
    else await out(s + '\\n');
  }
  for (let i = 0; i < (sc.pad || 0); i++) await out(JSON.stringify({ type: 'item.completed', item: { id: 'p' + i, type: 'agent_message', text: 'y'.repeat(1000) } }) + '\\n');
  for (const l of sc.tail || []) await out((typeof l === 'string' ? l : JSON.stringify(l)) + '\\n');
  if (sc.stderr) await new Promise((r) => process.stderr.write(sc.stderr, r));
  const oi = argv.indexOf('-o');
  if (sc.writeO !== undefined && oi >= 0) fs.writeFileSync(argv[oi + 1], sc.writeO);
  if (sc.selfSignal) process.kill(process.pid, sc.selfSignal);
  if (sc.sleepMs) await sleep(sc.sleepMs);
  process.exit(sc.exit || 0);
});
`);
fs.chmodSync(FAKE, 0o755);

const PR = ROOT;
const HOME = path.join(TMP, 'chome');
fs.mkdirSync(HOME);
let nTask = 0;
// A task folder with its scenario: {key, dir, wt}
const task = (sc) => {
  const key = `T${++nTask}`;
  const dir = path.join(TMP, key), wt = path.join(TMP, `${key}-wt`);
  fs.mkdirSync(dir); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(sc));
  return { key, dir, wt };
};
const logs = [];
const mk = (host, tasks, extra = {}) => createAgent(Object.assign({
  host, tasks: Object.fromEntries(tasks.map((t) => [t.key, { dir: t.dir, wt: t.wt }])), pluginRoot: PR, callsDir: path.join(TMP, 'calls'),
  log: (m) => logs.push(m), env: Object.assign({}, process.env, extra.env || {}),
  codex: Object.assign({ bin: FAKE, home: HOME, catalog: CATALOG }, extra.codex || {}),
  claude: Object.assign({ bin: FAKE }, extra.claude || {}),
}, extra.cfg || {}));
const records = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const files = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)); } catch { return []; } };
const dumpOf = (t) => { const f = files(t.dir, /^dump-\d+\.json$/)[0]; return f ? JSON.parse(fs.readFileSync(path.join(t.dir, f), 'utf8')) : null; };
const stdinOf = (t) => { const f = files(t.dir, /^stdin-\d+\.txt$/)[0]; return f ? fs.readFileSync(path.join(t.dir, f)) : null; };
const runsOf = (t) => { try { return fs.readFileSync(path.join(t.dir, 'runs.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A killed orphan stays a zombie until launchd/init reaps it: wait up to 5 s for it to vanish.
const gone = async (pid) => { if (!(pid > 0)) return false; for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };
const pidFile = (t, k) => { try { return +fs.readFileSync(path.join(t.dir, `child-${k}.pid`), 'utf8'); } catch { return 0; } };
const opts = (label) => ({ schema: REVIEW, model: 'opus', effort: 'high', label, phase: 'P', agentType: 'codis-agents:reviewer' });
const callX = async (sc, extra) => { const t = task(sc); const res = await mk('codex', [t], extra)(`Review task ${t.key}.\n`, opts(`review:${t.key}#1`)); return { t, res, rec: records(t.dir).slice(-1)[0] || {}, n: records(t.dir).length }; };
const callC = async (sc, extra) => { const t = task(sc); const res = await mk('claude', [t], extra)(`Review task ${t.key}.\n`, opts(`review:${t.key}#1`)); return { t, res, rec: records(t.dir).slice(-1)[0] || {}, n: records(t.dir).length }; };
const J = JSON.stringify;

// ---- streams: the shapes of experiment X0 (codex exec 0.166.0 --json, claude -p 2.1.318 stream-json); texts are English
// and paths are placeholders here, the numbers are the measured ones (X0 E1, G6 PRE, X0 E1c).
const E1_USAGE = { input_tokens: 1743826, cached_input_tokens: 1614720, cache_write_input_tokens: 0, output_tokens: 10667, reasoning_output_tokens: 2750 };
const PRE_USAGE = { input_tokens: 13221, cached_input_tokens: 0, cache_write_input_tokens: 13218, output_tokens: 23, reasoning_output_tokens: 0 };
const ANSWER = { verdict: 'rejected', docsOnly: false, fixBehaviourUnchanged: null, summary: 'Report: task/review.md.' };
const xOk = (usages = [E1_USAGE]) => [
  { type: 'thread.started', thread_id: '01a1aae2-9e8b-7b61-b3e2-ad206ab6237b' }, { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'git log -1', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: J(ANSWER) } },
  ...usages.map((u) => ({ type: 'turn.completed', usage: u })),
];
const apiErr = (status, code, type = 'invalid_request_error') => J({ type: 'error', error: { message: `status ${status} message`, type, param: null, code }, status });
const xFail = (status, code) => [{ type: 'thread.started', thread_id: 't-fail' }, { type: 'turn.started' },
  { type: 'error', message: apiErr(status, code) }, { type: 'turn.failed', error: { message: apiErr(status, code) } }];
const E1C_USAGE = { input_tokens: 64, cache_creation_input_tokens: 118904, cache_read_input_tokens: 2853902, output_tokens: 19126,
  output_tokens_details: { thinking_tokens: 8157 }, service_tier: 'standard' };
const E1C_MODEL_USAGE = { 'claude-opus-5-5': { inputTokens: 64, outputTokens: 19126, cacheReadInputTokens: 2853902, cacheCreationInputTokens: 118904, costUSD: 1.9047884 } };
const CINIT = { type: 'system', subtype: 'init', cwd: '/tmp/task', session_id: '484070f3-2606-48f1-9158-d436e7d5b026',
  tools: ['Task', 'Bash', 'Read', 'CronCreate', 'mcp__docs__read'], mcp_servers: [], model: 'claude-opus-5-5', permissionMode: 'auto',
  claude_code_version: '2.1.318', agents: ['codis-agents:reviewer', 'general-purpose'],
  plugins: [{ name: 'codis-agents', path: '/plugins/cache/codis-agents/0.4.23', source: 'codis-agents@codis-agents', version: '0.4.23' }] };
const CRATE = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.18 } };
const cResult = (extra) => Object.assign({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, session_id: CINIT.session_id,
  total_cost_usd: 1.9047884, usage: E1C_USAGE, modelUsage: E1C_MODEL_USAGE, permission_denials: [], num_turns: 34,
  structured_output: { verdict: 'rejected', docsOnly: false, summary: 'Rejected.' }, credential_expires_at: '2026-11-30T12:30:57.932Z' }, extra || {});
const cOk = (extra) => [CINIT, { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }, CRATE, cResult(extra)];

const FIELDS = ['ts', 'host', 'cliVersion', 'label', 'task', 'role', 'phase', 'model', 'effort', 'startedAt', 'endedAt', 'seconds', 'pid',
  'outcome', 'rc', 'signal', 'error', 'usage', 'costUSD', 'notes', 'sessionId', 'credentialExpiresAt'];
const OUTCOMES = [];
const seen = (name, x) => { OUTCOMES.push([name, x]); return x; };

(async () => {
  let x;

  // ---- A1-13 codex success: the object is unstrict(last.json), usage the sum of turn.completed, raw numbers (seam with C)
  x = seen('A1-13', await callX({ lines: xOk(), writeO: J(ANSWER) }));
  ok('A1-13 X success: ok, the object of the original schema (no fixBehaviourUnchanged: null)', x.res && x.res.verdict === 'rejected' && !('fixBehaviourUnchanged' in x.res) && x.rec.outcome === 'ok', J({ res: x.res, rec: x.rec }));
  ok('A1-13 X usage = the turn.completed of X0 E1 in raw numbers (input, cachedInput, cacheWrite, output, reasoning)',
    J(x.rec.usage) === J({ input: 1743826, cachedInput: 1614720, cacheWrite: 0, output: 10667, reasoning: 2750 }), J(x.rec.usage));
  ok('A1-13 X sessionId = thread_id, costUSD null, rc 0, pid of the process', x.rec.sessionId === '01a1aae2-9e8b-7b61-b3e2-ad206ab6237b' && x.rec.costUSD === null && x.rec.rc === 0 && Number.isInteger(x.rec.pid) && x.rec.pid > 0, J(x.rec));
  ok('A1-13 X notes name the number of turn.completed events', (x.rec.notes || []).some((n) => /turn\.completed[^0-9]*1\b/.test(n)), J(x.rec.notes));
  ok('A1-13 X the call folder keeps events.jsonl (the whole stream) and stderr.log', x.rec.callDir && fs.readFileSync(path.join(x.rec.callDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length === xOk().length
    && fs.existsSync(path.join(x.rec.callDir, 'stderr.log')), x.rec.callDir);
  x = await callX({ lines: xOk([E1_USAGE, PRE_USAGE]), writeO: J(ANSWER) });
  ok('A1-13 X two turn.completed: usage is their sum (E1 + G6 PRE), notes say 2',
    J(x.rec.usage) === J({ input: 1743826 + 13221, cachedInput: 1614720, cacheWrite: 13218, output: 10667 + 23, reasoning: 2750 }) && x.rec.notes.some((n) => /turn\.completed[^0-9]*2\b/.test(n)), J(x.rec));

  // ---- A1-14 claude success
  x = seen('A1-14', await callC({ lines: cOk() }));
  ok('A1-14 C success: ok, the object = structured_output', x.res && x.res.verdict === 'rejected' && x.res.summary === 'Rejected.' && x.rec.outcome === 'ok', J({ res: x.res, rec: x.rec }));
  ok('A1-14 C usage from result.usage (cache_read -> cachedInput, cache_creation -> cacheWrite, thinking -> reasoning), costUSD total_cost_usd',
    J(x.rec.usage) === J({ input: 64, cachedInput: 2853902, cacheWrite: 118904, output: 19126, reasoning: 8157 }) && x.rec.costUSD === 1.9047884, J(x.rec));
  ok('A1-14 C sessionId, cliVersion from init, credentialExpiresAt from result', x.rec.sessionId === CINIT.session_id && x.rec.cliVersion === '2.1.318'
    && x.rec.credentialExpiresAt === '2026-11-30T12:30:57.932Z', J(x.rec));
  ok('A1-14 C (G8 of check C) notes compare result.usage with modelUsage', x.rec.notes.some((n) => /modelUsage/.test(n) && /match/.test(n)), J(x.rec.notes));
  x = await callC({ lines: cOk({ modelUsage: Object.assign({}, E1C_MODEL_USAGE, { 'claude-haiku-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } }) }) });
  ok('A1-14 C a subagent model in modelUsage: the note says modelUsage differs from result.usage, the call stays ok',
    x.rec.outcome === 'ok' && x.rec.notes.some((n) => /modelUsage/.test(n) && /differ/.test(n)), J(x.rec.notes));
  // A1-07 live data and A1-37: the init event names the codis-agents plugin; tools a Workflow agent lacks are named
  x = await callC({ lines: cOk() });
  ok('A1-07 C notes name the codis-agents plugin of the init event (path and version)', x.rec.notes.some((n) => /codis-agents/.test(n) && /0\.4\.23/.test(n)), J(x.rec.notes));
  ok('A1-37 C notes name the init tools that should be off (Task, CronCreate, mcp__*)', x.rec.notes.some((n) => /Task/.test(n) && /CronCreate/.test(n) && /mcp__docs__read/.test(n)), J(x.rec.notes));

  // ---- A1-37 isolation of claude -p and A1-28 the sandbox of codex: argv and cwd of the real process
  x = await callC({ lines: cOk() });
  let d = dumpOf(x.t);
  const after = (argv, f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
  ok('A1-37 C cwd = the task folder, not the worktree', d && fs.realpathSync(d.cwd) === fs.realpathSync(x.t.dir), d && d.cwd);
  ok('A1-37 C argv: --strict-mcp-config, --disallowedTools with Task and the schedule/notification tools of init', d && d.argv.includes('--strict-mcp-config')
    && /(^|,)Task(,|$)/.test(after(d.argv, '--disallowedTools') || '') && ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification'].every((t) => (after(d.argv, '--disallowedTools') || '').split(',').includes(t)), d && J(d.argv));
  ok('A1-37 C argv keeps --agent codis-agents:reviewer, the original schema, --plugin-dir and -p stream-json', d && after(d.argv, '--agent') === 'codis-agents:reviewer'
    && after(d.argv, '--json-schema') === J(REVIEW) && after(d.argv, '--plugin-dir') === PR && d.argv[0] === '-p', d && J(d.argv));
  ok('A1-37 C stdin = exactly the prompt (the body comes by --agent)', String(stdinOf(x.t)) === `Review task ${x.t.key}.\n`);
  x = await callX({ lines: xOk(), writeO: J(ANSWER) });
  d = dumpOf(x.t);
  ok('A1-28 X review: -s workspace-write -C <task dir> --skip-git-repo-check, no --add-dir, cwd = the task folder', d && after(d.argv, '-s') === 'workspace-write'
    && after(d.argv, '-C') === x.t.dir && d.argv.includes('--skip-git-repo-check') && !d.argv.includes('--add-dir') && !d.argv.join(' ').includes(x.t.wt)
    && fs.realpathSync(d.cwd) === fs.realpathSync(x.t.dir), d && J(d.argv));
  ok('A1-28 X the -o file and the schema file are inside the call folder', d && after(d.argv, '-o') === path.join(x.rec.callDir, 'last.json') && after(d.argv, '--output-schema') === path.join(x.rec.callDir, 'schema.json'));

  // ---- A1-15 schema-refused (the 400 of X0 try1-loose), no repeat
  x = seen('A1-15', await callX({ lines: xFail(400, 'invalid_json_schema'), exit: 1 }));
  ok('A1-15 X 400 invalid_json_schema -> schema-refused, null, usage null, one run', x.res === null && x.rec.outcome === 'schema-refused' && x.rec.usage === null && runsOf(x.t) === 1, J(x.rec));
  x = await callX({ lines: xFail(400, 'other_code'), exit: 1 });
  ok('A1-15 X a 400 with another code -> crashed (by fields, not by words)', x.res === null && x.rec.outcome === 'crashed', J(x.rec));

  // ---- A1-16 rate-limited, no repeat, no wait
  x = seen('A1-16 X', await callX({ lines: xFail(429, 'rate_limit_exceeded'), exit: 1 }));
  ok('A1-16 X 429 -> rate-limited, null, one run', x.res === null && x.rec.outcome === 'rate-limited' && runsOf(x.t) === 1, J(x.rec));
  x = await callX({ lines: [{ type: 'thread.started', thread_id: 't' }, { type: 'error', message: apiErr(429, 'usage_limit_reached') }], exit: 1 });
  ok('A1-16 X an error event with 429 and exit 1 without turn.failed -> rate-limited', x.res === null && x.rec.outcome === 'rate-limited', J(x.rec));
  x = seen('A1-16 C', await callC({ lines: [CINIT, cResult({ subtype: 'error_during_execution', is_error: true, api_error_status: 429, structured_output: undefined })], exit: 1 }));
  ok('A1-16 C api_error_status 429 -> rate-limited, null, one run', x.res === null && x.rec.outcome === 'rate-limited' && runsOf(x.t) === 1, J(x.rec));
  // UC-2 Errors 5: a rate_limit_event whose status is not "allowed", then an error -> rate-limited, by the field.
  const cRl = (status) => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour' } });
  const cErr = cResult({ subtype: 'error_during_execution', is_error: true, api_error_status: null, structured_output: undefined });
  x = seen('A1-16 C rejected', await callC({ lines: [CINIT, cRl('rejected'), cErr], exit: 1 }));
  ok('A1-16 C rate_limit_event rejected, then a result error without api_error_status -> rate-limited, null, one run',
    x.res === null && x.rec.outcome === 'rate-limited' && runsOf(x.t) === 1 && x.rec.notes.some((n) => /rate_limit_event rejected/.test(n)), J(x.rec));
  x = await callC({ lines: [CINIT, cRl('allowed_warning'), cErr], exit: 1 });
  ok('A1-16 C rate_limit_event allowed_warning (not "allowed"), then a result error -> rate-limited', x.res === null && x.rec.outcome === 'rate-limited', J(x.rec));
  x = await callC({ lines: [CINIT, cRl('rejected')], stderr: 'claude: stopped\n', exit: 1 });
  ok('A1-16 C rate_limit_event rejected, then exit 1 without a result -> rate-limited', x.res === null && x.rec.outcome === 'rate-limited', J(x.rec));
  x = await callC({ lines: [CINIT, cRl('allowed'), cErr], exit: 1 });
  ok('A1-16 C rate_limit_event allowed, then the same result error -> crashed', x.res === null && x.rec.outcome === 'crashed', J(x.rec));
  x = await callC({ lines: [CINIT, cRl('rejected'), ...cOk().slice(1)] });
  ok('A1-16 C rate_limit_event rejected, then a success -> ok (no error, no outcome from the event)', x.rec.outcome === 'ok', J(x.rec));
  // Codex 0.166.0: the error events of exec --json carry only a message (no codex_error_info), and the plan limit is
  // plain text; it is not classified by words, so it ends as crashed with the message (README, Known gaps).
  x = await callX({ lines: [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }], exit: 1 });
  ok('A1-16 X the plain-text plan limit -> crashed with the message (a known gap, not matched by words)', x.res === null && x.rec.outcome === 'crashed' && /usage limit/.test(x.rec.error), J(x.rec));

  // ---- A1-17 auth: by status 401/403 only (G12); the reason names the login command of this home
  x = seen('A1-17 X', await callX({ lines: xFail(401, 'invalid_api_key'), exit: 1 }));
  ok('A1-17 X 401 -> auth, the reason names CODEX_HOME=<run home> codex login', x.res === null && x.rec.outcome === 'auth' && x.rec.error.includes(`CODEX_HOME=${HOME} codex login`), J(x.rec));
  x = await callX({ lines: xFail(403, 'forbidden'), exit: 1 });
  ok('A1-17 X 403 -> auth', x.rec.outcome === 'auth', J(x.rec));
  x = await callX({ lines: [{ type: 'turn.failed', error: { message: 'not JSON: please log in' } }], exit: 1 });
  ok('A1-17 X an error without a JSON status -> crashed, not auth (G12)', x.rec.outcome === 'crashed', J(x.rec));
  x = seen('A1-17 C', await callC({ lines: [CINIT, cResult({ subtype: 'error_during_execution', is_error: true, api_error_status: 401, structured_output: undefined })], exit: 1 }));
  ok('A1-17 C api_error_status 401 -> auth', x.res === null && x.rec.outcome === 'auth', J(x.rec));

  // ---- A1-18 crashed: no binary (the exec of the launch gate fails: 126 or 127 with the text of the shell); exit != 0 without a terminal event, with the tail of stderr
  x = seen('A1-18 X enoent', await callX({}, { codex: { bin: path.join(TMP, 'no-such-codex') } }));
  ok('A1-18 X no binary under the gate -> crashed, null, one record', x.res === null && x.rec.outcome === 'crashed' && (x.rec.rc === 126 || x.rec.rc === 127) && /no-such-codex/.test(x.rec.error) && x.n === 1, J(x.rec));
  x = seen('A1-18 X rc', await callX({ lines: [{ type: 'thread.started', thread_id: 't' }], stderr: 'line one\nfatal: the tail of stderr\n', exit: 2 }));
  ok('A1-18 X exit 2 without turn.failed -> crashed, rc 2, the tail of stderr in the error', x.rec.outcome === 'crashed' && x.rec.rc === 2 && /the tail of stderr/.test(x.rec.error), J(x.rec));
  x = seen('A1-18 C enoent', await callC({}, { claude: { bin: path.join(TMP, 'no-such-claude') } }));
  ok('A1-18 C no binary under the gate -> crashed', x.res === null && x.rec.outcome === 'crashed' && (x.rec.rc === 126 || x.rec.rc === 127) && /no-such-claude/.test(x.rec.error), J(x.rec));
  x = await callC({ lines: [CINIT], stderr: 'claude: the tail of stderr\n', exit: 3 });
  ok('A1-18 C exit 3 without a result -> crashed with the tail of stderr', x.rec.outcome === 'crashed' && x.rec.rc === 3 && /the tail of stderr/.test(x.rec.error), J(x.rec));

  // ---- A1-19 killed from outside in the middle of the stream
  x = seen('A1-19 X', await callX({ lines: xOk().slice(0, 3), selfSignal: 'SIGKILL' }));
  ok('A1-19 X SIGKILL in the middle of the stream -> killed, signal SIGKILL, usage null', x.res === null && x.rec.outcome === 'killed' && x.rec.signal === 'SIGKILL' && x.rec.usage === null, J(x.rec));
  x = seen('A1-19 C', await callC({ lines: [CINIT, CRATE], selfSignal: 'SIGKILL' }));
  ok('A1-19 C SIGKILL -> killed, usage null', x.res === null && x.rec.outcome === 'killed' && x.rec.signal === 'SIGKILL' && x.rec.usage === null, J(x.rec));

  // ---- A1-20 the ceiling: SIGTERM to the group, the pause, SIGKILL; a child in the group dies too; silence is no outcome
  let t0 = Date.now();
  x = seen('A1-20 X', await callX({ lines: xOk().slice(0, 2), child: 'group', ignoreTerm: true, sleepMs: 60000 }, { cfg: { ceilingMs: 800, killGraceMs: 300 } }));
  ok('A1-20 X past the ceiling (SIGTERM ignored) -> ceiling, null, ends well before the sleep', x.res === null && x.rec.outcome === 'ceiling' && Date.now() - t0 < 30000, J(x.rec));
  ok('A1-20 X the child in the group of the role is dead after the call', pidFile(x.t, 'group') > 0 && await gone(pidFile(x.t, 'group')), String(pidFile(x.t, 'group')));
  x = await callC({ lines: [CINIT], sleepMs: 60000 }, { cfg: { ceilingMs: 800, killGraceMs: 300 } });
  ok('A1-20 C past the ceiling -> ceiling', x.res === null && x.rec.outcome === 'ceiling', J(x.rec));
  x = await callX({ delayMs: 1500, lines: xOk(), writeO: J(ANSWER) }, { cfg: { killGraceMs: 300 } });
  ok('A1-20 X a silent process under the default ceiling is waited for (no silence timer) -> ok', x.rec.outcome === 'ok', J(x.rec));
  ok('A1-20 the default ceiling is 3 h by the monotonic clock: no silence timer in the source', /3 \* 60 \* 60 \* 1000/.test(fs.readFileSync(SCRIPT, 'utf8')));

  // ---- A1-21 no-result
  x = seen('A1-21 X', await callX({ lines: xOk() }));
  ok('A1-21 X rc 0, turn.completed, no -o file -> no-result; the last agent_message is not used', x.res === null && x.rec.outcome === 'no-result', J(x.rec));
  x = await callX({ lines: xOk(), writeO: '' });
  ok('A1-21 X empty -o file -> no-result', x.rec.outcome === 'no-result', J(x.rec));
  x = await callX({ lines: xOk(), writeO: '{"verdict":' });
  ok('A1-21 X -o file not JSON -> no-result', x.rec.outcome === 'no-result', J(x.rec));
  x = await callX({ lines: xOk().slice(0, 4), writeO: J(ANSWER) });
  ok('A1-21 X rc 0 without turn.completed -> no-result', x.res === null && x.rec.outcome === 'no-result', J(x.rec));
  x = seen('A1-21 C', await callC({ lines: [CINIT, cResult({ structured_output: undefined })] }));
  ok('A1-21 C success without structured_output -> no-result', x.res === null && x.rec.outcome === 'no-result', J(x.rec));
  x = await callC({ lines: [CINIT] });
  ok('A1-21 C rc 0 without a result event -> no-result', x.res === null && x.rec.outcome === 'no-result', J(x.rec));
  x = await callX({ lines: xOk(), writeO: J({ verdict: 'maybe', docsOnly: false, summary: 's' }) });
  ok('A1-06 X an answer outside the schema -> invalid-result', x.res === null && x.rec.outcome === 'invalid-result', J(x.rec));

  // ---- A1-22 notes, outcome ok
  x = seen('A1-22 X', await callX({ lines: [xOk()[0], { type: 'error', message: 'Reconnecting... 1/5' }, ...xOk().slice(1)], writeO: J(ANSWER) }));
  ok('A1-22 X an error event followed by turn.completed -> ok, the error in notes', x.rec.outcome === 'ok' && x.rec.notes.some((n) => /Reconnecting/.test(n)), J(x.rec));
  x = seen('A1-22 C', await callC({ lines: cOk({ permission_denials: [{ tool_name: 'Write', tool_use_id: 'u1' }] }) }));
  ok('A1-22 C rate_limit_event allowed and permission_denials -> ok, both in notes', x.rec.outcome === 'ok' && x.rec.notes.some((n) => /rate_limit_event/.test(n) && /allowed/.test(n))
    && x.rec.notes.some((n) => /permission_denials/.test(n) && /Write/.test(n)), J(x.rec.notes));

  // ---- A1-23 a 60 KB prompt with ` $ ' and Cyrillic by stdin; a 0.7 MB stream; a line cut between chunks; a broken line
  const cyr = String.fromCharCode(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442);
  const big = ('Line with `backticks`, $HOME and $(date), \'single\' "double" \\ ' + cyr + '\n').repeat(900);
  const tb = task({ lines: xOk().slice(0, 3), pad: 700, tail: ['{"type":"item.completed","item":', ...xOk().slice(3)], split: true, writeO: J(ANSWER) });
  const rb = await mk('codex', [tb])(big, opts(`review:${tb.key}#1`));
  const recb = records(tb.dir).slice(-1)[0] || {};
  const want = Buffer.from(fs.readFileSync(path.join(ROOT, 'agents', 'reviewer.md'), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim() + '\n\n' + big + '\n\n' + hostSection('review', tb));
  ok('A1-23 X the 60 KB prompt reaches the CLI byte for byte through stdin', Buffer.byteLength(big) > 60000 && stdinOf(tb) && stdinOf(tb).equals(want), String(stdinOf(tb) && stdinOf(tb).length));
  ok('A1-23 X a 0.7 MB stream with lines cut between chunks and a broken line -> ok, the broken line is a note', rb && recb.outcome === 'ok'
    && fs.statSync(path.join(recb.callDir, 'events.jsonl')).size > 700000 && recb.notes.some((n) => /not JSON|unparsed|broken/i.test(n)), J(recb).slice(0, 600));
  const tc = task({ lines: cOk(), split: true });
  const rc = await mk('claude', [tc])(big, opts(`review:${tc.key}#1`));
  ok('A1-23 C the 60 KB prompt byte for byte, lines cut between chunks -> ok', rc && stdinOf(tc) && stdinOf(tc).equals(Buffer.from(big)) && records(tc.dir).slice(-1)[0].outcome === 'ok');

  // ---- A1-25 two calls at once: own folders and -o files, results not mixed, two whole lines
  const ta = task({ delayMs: 600, lines: xOk(), writeO: J(Object.assign({}, ANSWER, { summary: 'answer A' })) });
  const tb2 = task({ delayMs: 100, lines: xOk(), writeO: J(Object.assign({}, ANSWER, { summary: 'answer B' })) });
  const two = mk('codex', [ta, tb2]);
  const [ra, rb2] = await Promise.all([two('A\n', opts(`review:${ta.key}#1`)), two('B\n', opts(`review:${tb2.key}#1`))]);
  ok('A1-25 X two calls at once: each gets its own answer', ra && rb2 && ra.summary === 'answer A' && rb2.summary === 'answer B', J([ra, rb2]));
  const da = dumpOf(ta), db = dumpOf(tb2);
  ok('A1-25 X own call folders and -o files, one whole line each', da && db && after(da.argv, '-o') !== after(db.argv, '-o') && records(ta.dir).length === 1 && records(tb2.dir).length === 1
    && records(ta.dir)[0].callDir !== records(tb2.dir)[0].callDir);
  // two adapters in one process, the same label in the same second: never one call folder (coordinator's decision, A1a tail)
  const tsame = task({ lines: xOk(), writeO: J(ANSWER) });
  const a1 = mk('codex', [tsame]), a2 = mk('codex', [tsame]);
  const [s1, s2] = await Promise.all([a1('1\n', opts(`review:${tsame.key}#1`)), a2('2\n', opts(`review:${tsame.key}#1`))]);
  const rs = records(tsame.dir);
  ok('A1-25 two adapters, one label, one second: two call folders, each with its own prompt.txt', s1 && s2 && rs.length === 2 && rs[0].callDir !== rs[1].callDir
    && new Set(rs.map((r) => fs.readFileSync(path.join(r.callDir, 'prompt.txt'), 'utf8').split('## On this host (codex)')[0].trimEnd().slice(-1))).size === 2, J(rs.map((r) => r.callDir)));

  // ---- A1-35 descendants outside the group: not killed, not invented, the record says so
  x = await callX({ child: ['group', 'session'], lines: xOk(), writeO: J(ANSWER) });
  const gp = pidFile(x.t, 'group'), sp = pidFile(x.t, 'session');
  if (sp) leftovers.push(sp);
  ok('A1-35 X after the leader exits the child of its group is dead', gp > 0 && await gone(gp), String(gp));
  ok('A1-35 X a child in its own session lives on (the adapter does not kill it)', sp > 0 && alive(sp), String(sp));
  ok('A1-35 X the record says descendants outside the group are not tracked', x.rec.outcome === 'ok' && x.rec.notes.some((n) => /outside the (process )?group are not tracked/.test(n)), J(x.rec.notes));

  // ---- A1-27 login of codex: chatgpt drops the key variables; apiKeyFile 600 / 644 / empty; the key nowhere else
  x = await callX({ lines: xOk(), writeO: J(ANSWER) }, { env: { OPENAI_API_KEY: 'sk-parent-openai', CODEX_API_KEY: 'sk-parent-codex', CODEX_HOME: path.join(TMP, 'parent-home') } });
  d = dumpOf(x.t);
  ok('A1-27 X chatgpt: the child has no OPENAI_API_KEY / CODEX_API_KEY of the parent, CODEX_HOME = the run home', d && !('OPENAI_API_KEY' in d.env) && !('CODEX_API_KEY' in d.env) && d.env.CODEX_HOME === HOME, d && J({ k: d.env.OPENAI_API_KEY, h: d.env.CODEX_HOME }));
  const KEY = 'sk-test-' + 'k3y'.repeat(8);
  const kf = path.join(TMP, 'openai.key');
  fs.writeFileSync(kf, KEY + '\n'); fs.chmodSync(kf, 0o600);
  const logs0 = logs.length;
  x = await callX({ lines: xOk(), writeO: J(ANSWER) }, { codex: { auth: 'apiKeyFile', keyFile: kf } });
  d = dumpOf(x.t);
  ok('A1-27 X apiKeyFile 600: the key in CODEX_API_KEY of the child only', d && d.env.CODEX_API_KEY === KEY && x.rec.outcome === 'ok', d && String(d.env.CODEX_API_KEY));
  const grepKey = (dir) => { const hits = []; const walk = (p) => { for (const f of fs.readdirSync(p)) { const q = path.join(p, f); if (/^(dump-|fake\.json)/.test(f)) continue; if (fs.statSync(q).isDirectory()) walk(q); else if (fs.readFileSync(q, 'utf8').includes(KEY)) hits.push(q); } }; walk(dir); return hits; };
  ok('A1-27 X the key is not in argv, calls.jsonl, the call folder or log()', d && !d.argv.join(' ').includes(KEY) && !grepKey(x.t.dir).length && !logs.slice(logs0).join('\n').includes(KEY), J(grepKey(x.t.dir)));
  fs.chmodSync(kf, 0o644);
  x = await callX({ lines: xOk(), writeO: J(ANSWER) }, { codex: { auth: 'apiKeyFile', keyFile: kf } });
  ok('A1-27 X apiKeyFile 644 -> refused, nothing started', x.res === null && x.rec.outcome === 'refused' && runsOf(x.t) === 0, J(x.rec));
  fs.writeFileSync(kf, ''); fs.chmodSync(kf, 0o600);
  x = await callX({ lines: xOk(), writeO: J(ANSWER) }, { codex: { auth: 'apiKeyFile', keyFile: kf } });
  ok('A1-27 X apiKeyFile empty -> refused, nothing started', x.rec.outcome === 'refused' && runsOf(x.t) === 0, J(x.rec));
  // the personal ~/.codex as the run home is refused (owner decision 6: a separate home for the chains), also by a link
  const fakeHome = path.join(TMP, 'user-home');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  fs.symlinkSync(path.join(fakeHome, '.codex'), path.join(TMP, 'link-to-personal'));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const ca = (home) => { try { mk('codex', [task({})], { codex: { home } }); return ''; } catch (e) { return e.message; } };
  const r1 = ca(path.join(fakeHome, '.codex')), r2 = ca(path.join(TMP, 'link-to-personal')), r3 = ca(HOME);
  process.env.HOME = oldHome;
  ok('the personal ~/.codex as codex.home -> createAgent refuses (directly and through a link); another home passes', /~\/\.codex|personal/.test(r1) && /~\/\.codex|personal/.test(r2) && r3 === '', J([r1, r2, r3]));
  // Another case of a name is the same folder on a case-insensitive disk (the default of macOS).
  if (fs.existsSync(path.join(fakeHome, '.CODEX'))) {
    process.env.HOME = fakeHome;
    const r4 = ca(path.join(fakeHome, '.CODEX'));
    process.env.HOME = oldHome;
    ok('the personal ~/.codex spelled ~/.CODEX -> createAgent refuses', /~\/\.codex|personal/.test(r4), r4);
    const onDisk = path.join(fs.realpathSync(fakeHome), '.codex');
    ok('realish gives the name a folder has on disk, whatever the case asked', realish(path.join(fakeHome, '.CODEX')) === onDisk, realish(path.join(fakeHome, '.CODEX')));
    ok('realish keeps the part that does not exist yet', realish(path.join(fakeHome, '.CODEX', 'not', 'YET')) === path.join(onDisk, 'not', 'YET'));
  }
  ok('overlap: a folder and what lies inside it, in both directions; neighbours do not', overlap('/a/b', '/a/b/c') && overlap('/a/b/c', '/a/b') && overlap('/a/b', '/a/b') && !overlap('/a/b', '/a/bc') && !overlap('/a/bc', '/a/b'));
  ok('overlap: names of folders that do not exist yet compare without case or form of Unicode', overlap('/a/NEW/x', '/a/new') && overlap('/a/new', '/a/NEW/x') && overlap('/a/\u0439/x', '/a/\u0438\u0306'));
  // commit.stateDir: the same overlap as the state of a run. The text names the root: this folder may also lie in /tmp or the
  // TMPDIR, which refuse it on their own; the task folder comes first in the check.
  const caCommit = (dir, stateDir) => { try { mk('codex', [Object.assign(task({}), { dir })], { cfg: { commit: { stateDir } } }); return ''; } catch (e) { return e.message; } };
  const rawDir = path.join(TMP, 'commit-root');
  fs.mkdirSync(rawDir);
  if (fs.existsSync(path.join(TMP, 'COMMIT-ROOT'))) {
    const r5 = caCommit(rawDir, path.join(TMP, 'COMMIT-ROOT', 'state'));
    ok('commit.stateDir inside the task folder by another case of its name -> refused, naming the task folder', r5.includes(`overlaps ${realish(rawDir)}`), r5);
  }
  const r6 = caCommit(path.join(TMP, 'not-yet-root'), path.join(TMP, 'NOT-YET-ROOT', 'state'));
  ok('commit.stateDir inside a task folder that does not exist yet, by another case -> refused, naming the task folder', r6.includes(`overlaps ${realish(path.join(TMP, 'not-yet-root'))}`), r6);
  const ck = spawnSync(process.execPath, [SCRIPT, 'check', '--host', 'codex', '--bin', FAKE, '--home', path.join(fakeHome, '.codex')], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: fakeHome }), cwd: TMP });
  ok('the personal ~/.codex in role-exec.js check -> not ok, the problem names it', ck.status === 1 && /~\/\.codex|personal/.test(ck.stdout), ck.stdout.slice(0, 400));

  // ---- A1-26 one record line per call with every field of 5.2, whatever the outcome; the reason of a non-ok in log()
  const missing = OUTCOMES.flatMap(([name, y]) => (y.n === 1 ? FIELDS.filter((f) => !(f in y.rec)).map((f) => `${name}: ${f}`) : [`${name}: ${y.n} lines`]));
  ok('A1-26 every outcome above wrote exactly one line with every field of 5.2', !missing.length, missing.slice(0, 8).join('; '));
  ok('A1-26 the outcomes covered: ok, schema-refused, rate-limited, auth, crashed, killed, ceiling, no-result',
    ['ok', 'schema-refused', 'rate-limited', 'auth', 'crashed', 'killed', 'ceiling', 'no-result'].every((o) => OUTCOMES.some(([, y]) => y.rec.outcome === o)), OUTCOMES.map(([, y]) => y.rec.outcome).join(','));
  const nonOk = OUTCOMES.filter(([, y]) => y.rec.outcome !== 'ok');
  ok('A1-26 (G8) each non-ok outcome is in log() with its label and outcome', nonOk.every(([, y]) => logs.some((m) => m.includes(y.rec.label) && m.includes(y.rec.outcome))), nonOk.map(([n]) => n).join(','));
  ok('A1-26 seconds (wall) and awakeSeconds (monotonic) are both numbers', OUTCOMES.every(([, y]) => typeof y.rec.seconds === 'number' && typeof y.rec.awakeSeconds === 'number'));

  // ---- A1-24 SIGTERM / SIGINT / SIGHUP to the adapter with two live calls: both groups stopped, two records signalled,
  // both promises null, process.exitCode 128+n, the handlers removed (G9); a later call is not started
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const tA = task({ lines: xOk().slice(0, 2), sleepMs: 60000, child: 'group' }), tB = task({ lines: xOk().slice(0, 2), sleepMs: 60000, ignoreTerm: true });
    const out = path.join(TMP, `sig-${sig}.json`);
    const W = path.join(TMP, `wrap-${sig}.js`);
    fs.writeFileSync(W, `'use strict';
const fs = require('fs'), path = require('path');
const { createAgent } = require(${J(SCRIPT)});
const C = ${J({ tasks: { [tA.key]: { dir: tA.dir, wt: tA.wt }, [tB.key]: { dir: tB.dir, wt: tB.wt } } })};
const agent = createAgent({ host: 'codex', tasks: C.tasks, pluginRoot: ${J(PR)}, callsDir: ${J(path.join(TMP, 'calls'))}, log: () => {},
  codex: { bin: ${J(FAKE)}, home: ${J(HOME)}, catalog: ${J(CATALOG)} }, killGraceMs: 300 });
const o = (k) => ({ schema: ${J(REVIEW)}, model: 'opus', label: 'review:' + k + '#1', agentType: 'codis-agents:reviewer' });
Promise.all([agent('a\\n', o(${J(tA.key)})), agent('b\\n', o(${J(tB.key)}))]).then(async (res) => {
  const later = await agent('c\\n', o(${J(tA.key)}));
  fs.writeFileSync(${J(out)}, JSON.stringify({ res, later, listeners: process.listenerCount(${J(sig)}) }));
});
const dumps = () => [${J(tA.dir)}, ${J(tB.dir)}].filter((d) => fs.readdirSync(d).some((f) => /^dump-/.test(f))).length;
const iv = setInterval(() => { if (dumps() === 2) { clearInterval(iv); process.kill(process.pid, ${J(sig)}); } }, 20);
`);
    t0 = Date.now();
    const w = spawnSync(process.execPath, [W], { encoding: 'utf8', timeout: 60000 });
    let o = null;
    try { o = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* below */ }
    const recs = [...records(tA.dir), ...records(tB.dir)];
    const pids = recs.map((r) => r.pid).filter(Boolean);
    const dead = [];
    for (const p of pids.concat(pidFile(tA, 'group'))) dead.push(await gone(p));
    ok(`A1-24 ${sig} with two live calls: both null, the wrapper exits with ${128 + os.constants.signals[sig]} by itself, well before the fakes' sleep`,
      o && J(o.res) === '[null,null]' && w.status === 128 + os.constants.signals[sig] && Date.now() - t0 < 30000, J({ status: w.status, signal: w.signal, o, err: (w.stderr || '').slice(0, 300) }));
    ok(`A1-24 ${sig}: two records signalled (plus the later call, not started), the fakes and the child of the group are dead`,
      recs.filter((r) => r.outcome === 'signalled').length === 3 && runsOf(tA) === 1 && pids.length === 2 && pidFile(tA, 'group') > 0 && dead.every(Boolean),
      J({ recs: recs.map((r) => [r.outcome, r.pid]), dead }));
    ok(`A1-24 ${sig}: the adapter removed its handlers`, o && o.listeners === 0, o && String(o.listeners));
  }

  // ---- A1-34 env-check: the swap not measured with --min-swap-mb -> not ok; without the flag, a note as before
  const EC = path.join(ROOT, 'scripts', 'env-check.js');
  const { judge } = require(EC);
  let j = judge({ disk: [{ path: '/a', bytes: 50 * 2 ** 30 }], swap: null, swapWhy: 'sysctl: Operation not permitted' }, { swapMinMB: 4000, swapRequired: true });
  ok('A1-34 judge: swap null with a required floor -> ok false, "swap not checked: <reason>"', !j.ok && j.problems.some((p) => p === 'swap not checked: sysctl: Operation not permitted'), J(j));
  j = judge({ disk: [{ path: '/a', bytes: 50 * 2 ** 30 }], swap: null, swapWhy: 'x' }, { swapMinMB: 4000 });
  ok('A1-34 judge: swap null without a required floor -> ok with the note, as before', j.ok && /could not be measured/.test(j.notes.join(' ')), J(j));
  j = judge({ disk: [{ path: '/a', bytes: 50 * 2 ** 30 }], swap: null, swapWhy: 'x' }, { swapMinMB: 0, swapRequired: true });
  ok('A1-34 judge: --min-swap-mb 0 stays "off"', j.ok && /off/.test(j.notes.join(' ')), J(j));
  if (process.platform === 'darwin') {
    const ec = (args) => spawnSync(process.execPath, [EC, '--path', TMP, '--min-disk-gb', '0'].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { PATH: path.join(TMP, 'empty-path') }) });
    let e = ec(['--min-swap-mb', '4000']);
    ok('A1-34 env-check.js with --min-swap-mb and no sysctl -> exit 1, ok false, "swap not checked: ..."', e.status === 1 && /"ok":false/.test(e.stdout) && /swap not checked: /.test(e.stdout), e.stdout + e.stderr);
    e = ec([]);
    ok('A1-34 env-check.js without --min-swap-mb and no sysctl -> exit 0 with the note, as before', e.status === 0 && /could not be measured/.test(e.stdout), e.stdout + e.stderr);
  } else ok('A1-34 env-check.js on this platform: the CLI cells run on darwin only (sysctl)', true);

  done();
})().catch((e) => { ok('the test ran to its end', false, e.stack); done(); });
