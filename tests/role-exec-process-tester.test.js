#!/usr/bin/env node
'use strict';
// Tester guards of part A1b of the role adapter (scripts/role-exec.js, the process of a role), for the inputs of the
// process the programmer's guard (role-exec-process.test.js) does not feed:
// T1 the CLI exits without reading its stdin (a prompt larger than the pipe buffer): EPIPE on stdin is no crash of the
//    adapter - the outcome comes from the exit (crashed with rc), one record, the next call works;
// T2 a multibyte UTF-8 character cut between two chunks of stdout: the result event is decoded whole (StringDecoder);
// T3 claude result errors by api_error_status: 403 -> auth, 500 -> crashed, 400 -> crashed (no schema-refused on claude);
// T4 spawn EACCES (the bin is not executable) -> crashed, one record, no throw;
// T5 a process outside the group keeps stdout open after the leader exits: the call still ends (bounded by the
//    ceiling), its outcome is that of the exit, the note says stdout stayed open, the adapter does not kill that process.
// No model is called: the CLI is a fake Node script in a temporary folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const { createAgent } = require(path.join(ROOT, 'scripts', 'role-exec.js'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'), 'utf8'));
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'role-exec-tester-'));
const kids = [];
process.on('exit', () => {
  for (const p of kids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const FAKE = path.join(TMP, 'fake.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const here = (f) => path.join(process.cwd(), f);
const sc = JSON.parse(fs.readFileSync(here('fake.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (b) => new Promise((r) => process.stdout.write(b, r));
(async () => {
  if (sc.mode === 'nostdin') {
    // never reads stdin: the writer gets EPIPE once the pipe buffer is full and the reader is gone
    process.stderr.write('early exit before reading the prompt\\n', () => process.exit(2));
    return;
  }
  if (sc.mode === 'chunks') {
    for (const c of sc.chunks) { await out(Buffer.from(c, 'base64')); await sleep(40); }
    process.exit(0);
  }
  if (sc.mode === 'holdout') {
    // a process of its own session that inherits the stdout of the CLI
    const c = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
    c.unref();
    fs.writeFileSync(here('holdout.pid'), String(c.pid));
    for (const l of sc.lines) await out(JSON.stringify(l) + '\\n');
    process.exit(0);
  }
  for (const l of sc.lines || []) await out(JSON.stringify(l) + '\\n');
  process.exit(sc.exit || 0);
})();
`);
fs.chmodSync(FAKE, 0o755);
const NOEXEC = path.join(TMP, 'noexec.js');
fs.writeFileSync(NOEXEC, '#!/usr/bin/env node\nprocess.exit(0);\n');
fs.chmodSync(NOEXEC, 0o644);

const HOME = path.join(TMP, 'chome');
fs.mkdirSync(HOME);
let n = 0;
const task = (sc) => {
  const key = `U${++n}`;
  const dir = path.join(TMP, key), wt = path.join(TMP, `${key}-wt`);
  fs.mkdirSync(dir); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify(sc));
  return { key, dir, wt };
};
const logs = [];
const mk = (host, t, extra = {}) => createAgent(Object.assign({
  host, tasks: { [t.key]: { dir: t.dir, wt: t.wt } }, pluginRoot: ROOT, callsDir: path.join(TMP, 'calls'),
  log: (m) => logs.push(m), env: Object.assign({}, process.env),
  codex: { bin: extra.bin || FAKE, home: HOME, catalog: CATALOG },
  claude: { bin: extra.bin || FAKE },
}, extra.cfg || {}));
const records = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const opts = (t) => ({ schema: REVIEW, model: 'opus', effort: 'high', label: `review:${t.key}#1`, phase: 'P', agentType: 'codis-agents:reviewer' });
// a call that must end: a deadline turns a hang into a red check instead of a stuck test
const call = async (host, sc, extra = {}, prompt = 'Review.\n', limitMs = 20000) => {
  const t = task(sc);
  let threw = null;
  const p = mk(host, t, extra)(prompt, opts(t)).catch((e) => { threw = e; return 'threw'; });
  const res = await Promise.race([p, new Promise((r) => setTimeout(() => r('hang'), limitMs))]);
  const rs = records(t.dir);
  return { t, res, threw, rec: rs.slice(-1)[0] || {}, n: rs.length };
};
// multibyte text built from code points (the repository holds no Cyrillic): 2-byte Cyrillic, 3-byte CJK, a 4-byte emoji
const CYR = String.fromCodePoint(0x41e, 0x442, 0x447, 0x451, 0x442);
const ANSWER = { verdict: 'done', docsOnly: false, summary: `${CYR}: review ${String.fromCodePoint(0x4e2d, 0x6587)} ${String.fromCodePoint(0x1f680)}.` };
const RESULT = (extra = {}) => Object.assign({ type: 'result', subtype: 'success', is_error: false, structured_output: ANSWER,
  usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
  total_cost_usd: 0.5, session_id: 's-1' }, extra);
const INIT = { type: 'system', subtype: 'init', session_id: 's-1', tools: ['Bash', 'Read'], claude_code_version: '2.1.318' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  // ---- T1 EPIPE: a prompt far larger than a pipe buffer, the CLI exits at once without reading it
  const big = CYR + ' ' + 'x'.repeat(400 * 1024) + '\n';
  for (const host of ['codex', 'claude']) {
    const H = host === 'codex' ? 'X' : 'C';
    const x = await call(host, { mode: 'nostdin' }, {}, big);
    ok(`T1 ${H} the CLI exits without reading a 400 KB prompt: the call resolves null, no throw, no hang`, x.res === null && !x.threw, `${x.res === 'hang' ? 'hang' : ''} ${x.threw && x.threw.message}`);
    ok(`T1 ${H} the outcome is crashed with rc 2 and the stderr tail, one record`, x.n === 1 && x.rec.outcome === 'crashed' && x.rec.rc === 2 && /early exit before reading/.test(x.rec.error || ''), JSON.stringify(x.rec).slice(0, 400));
    const y = await call(host, host === 'codex' ? { lines: [] } : { lines: [INIT, RESULT()] });
    ok(`T1 ${H} the next call of the same process works after the EPIPE`, (host === 'codex' ? y.rec.outcome === 'no-result' : y.rec.outcome === 'ok') && y.n === 1, JSON.stringify(y.rec).slice(0, 300));
  }

  // ---- T2 a multibyte character cut between two chunks of stdout (claude: the answer is in the stream)
  {
    const line = Buffer.from(JSON.stringify(INIT) + '\n' + JSON.stringify(RESULT()) + '\n', 'utf8');
    // cut inside every multibyte character of the answer: chunk boundaries one byte after each lead byte
    const cuts = [];
    for (let i = 0; i < line.length; i++) if (line[i] >= 0xc0) cuts.push(i + 1);
    const chunks = [];
    let prev = 0;
    for (const c of cuts) { chunks.push(line.subarray(prev, c).toString('base64')); prev = c; }
    chunks.push(line.subarray(prev).toString('base64'));
    const x = await call('claude', { mode: 'chunks', chunks });
    ok('T2 C chunks cut inside multibyte characters: ok', x.rec.outcome === 'ok', JSON.stringify(x.rec).slice(0, 300));
    ok('T2 C the answer keeps every multibyte character (no U+FFFD)', x.res && x.res.summary === ANSWER.summary, x.res && x.res.summary);
    ok('T2 C the stream is saved byte for byte in events.jsonl', (() => {
      const d = fs.readdirSync(path.join(x.t.dir, 'calls'))[0];
      return fs.readFileSync(path.join(x.t.dir, 'calls', d, 'events.jsonl')).equals(line);
    })());
  }

  // ---- T3 claude result errors by api_error_status
  for (const [st, want] of [[403, 'auth'], [500, 'crashed'], [400, 'crashed'], [529, 'crashed']]) {
    const x = await call('claude', { lines: [INIT, RESULT({ subtype: 'success', is_error: true, structured_output: undefined, api_error_status: st, result: 'API Error' })], exit: 1 });
    ok(`T3 C api_error_status ${st} -> ${want}, null, one record`, x.res === null && x.rec.outcome === want && x.n === 1, JSON.stringify(x.rec).slice(0, 300));
  }
  {
    const x = await call('claude', { lines: [INIT, RESULT({ subtype: 'error_max_turns', is_error: true, structured_output: undefined })], exit: 1 });
    ok('T3 C subtype error_max_turns without a status -> crashed', x.res === null && x.rec.outcome === 'crashed', JSON.stringify(x.rec).slice(0, 300));
  }

  // ---- T4 spawn EACCES
  for (const host of ['codex', 'claude']) {
    const x = await call(host, { lines: [] }, { bin: NOEXEC });
    ok(`T4 ${host === 'codex' ? 'X' : 'C'} a bin without the execute bit -> crashed, the error names the spawn, one record, no throw`,
      x.res === null && !x.threw && x.n === 1 && x.rec.outcome === 'crashed' && /spawn .*EACCES/.test(x.rec.error || ''), JSON.stringify(x.rec).slice(0, 300));
  }

  // ---- T5 stdout held open by a process of another session after the leader exits
  {
    const t0 = Date.now();
    const x = await call('claude', { mode: 'holdout', lines: [INIT, RESULT()] }, { cfg: { ceilingMs: 2500, killGraceMs: 300 } }, 'Review.\n', 15000);
    const secs = (Date.now() - t0) / 1000;
    let hp = 0; try { hp = +fs.readFileSync(path.join(x.t.dir, 'holdout.pid'), 'utf8'); } catch { /* none */ }
    if (hp) kids.push(hp);
    ok('T5 C stdout held open after the exit: the call ends (bounded by the ceiling), not a hang', x.res !== 'hang' && secs < 12, `${secs}s ${x.res}`);
    ok('T5 C the outcome is that of the exit (ok, the answer), one record', x.rec.outcome === 'ok' && x.res && x.res.verdict === 'done' && x.n === 1, JSON.stringify(x.rec).slice(0, 300));
    ok('T5 C the note says stdout stayed open after the exit', (x.rec.notes || []).some((s) => /stdout stayed open/.test(s)), JSON.stringify(x.rec.notes));
    ok('T5 C the process of the other session is not killed by the adapter', hp > 0 && alive(hp), String(hp));
  }

  // every non-ok outcome above went to log()
  ok('the non-ok outcomes are in log()', logs.some((l) => /crashed/.test(l)) && logs.some((l) => /auth/.test(l)), logs.slice(0, 3).join(' | '));
  done();
})();
