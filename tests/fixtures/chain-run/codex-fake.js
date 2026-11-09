'use strict';
// The fake codex CLI behind tests/fixtures/chain-run/bin/codex. It calls no model.
//   --version, login status, debug models: what `role-exec.js check --host codex` asks.
//   app-server: the stdio JSON-RPC of Codex 0.166.0 that scripts/codex-hooks-check.js speaks (initialize, hooks/list).
//     The scenario is $CODEX_HOME/fake-hooks.json {trust: "trusted"|"untrusted"|..., enabled?: bool, mode?: "exit",
//     delayMs?: n} (no file: no hook of the plugin in that home). Each hooks/list appends {ev: "hooks", home, cwd, pid, ms}
//     to $FAKE_CLI_DIR/trace.jsonl and the stop of the server {ev: "hooks-end", home, cwd, pid, ms}, so a test sees the
//     home, the cwd and the order of the checks.
//   exec: reads the prompt from stdin and the strict schema of --output-schema; the answer comes from
//     $FAKE_CLI_DIR/answers.json by the key "gp:" + the sorted property names of the schema (the n-th call of a key takes
//     the n-th answer, then answers.default[key]); it writes the answer to the -o file and prints thread.started and
//     turn.completed. {"$exit": n} exits n without a result. Trace lines {ev: "start", key, pid, cwd, ms, argv, prompt}
//     and {ev: "end", key, pid, ms}. {"$commits": [{path, content, message?}], "then": answer}: each file is written in
//     the cwd and committed through scripts/commit-req.js (the commit channel the adapter gives prog and test), traced
//     {ev: "commit", key, cwd, rc, out}; then the answer. In any answer the string "$C<n>" becomes the sha of the n-th
//     commit and "$HEAD" the HEAD of the cwd at the start of the call.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CLIENT = path.join(__dirname, '..', '..', '..', 'scripts', 'commit-req.js');

const argv = process.argv.slice(2);
const dir = process.env.FAKE_CLI_DIR;
const trace = (o) => { if (dir) fs.appendFileSync(path.join(dir, 'trace.jsonl'), JSON.stringify(Object.assign({ pid: process.pid, ms: Date.now() }, o)) + '\n'); };
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function appServer() {
  const home = process.env.CODEX_HOME || '';
  let sc = null;
  try { sc = JSON.parse(fs.readFileSync(path.join(home, 'fake-hooks.json'), 'utf8')); } catch { /* no hook of ours */ }
  let cwdSeen = null;
  process.on('SIGTERM', () => { trace({ ev: 'hooks-end', home, cwd: cwdSeen }); process.exit(0); });
  if (sc && sc.mode === 'exit') { trace({ ev: 'hooks', home, cwd: null }); process.stderr.write('fake codex: app-server refused\n'); process.exit(1); }
  setInterval(() => {}, 1000);
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake/0.166.0', codexHome: home, platformFamily: 'unix', platformOs: 'macos' } });
      else if (m.method === 'hooks/list') {
        cwdSeen = (m.params && m.params.cwds && m.params.cwds[0]) || null;
        trace({ ev: 'hooks', home, cwd: cwdSeen });
        if (sc && sc.delayMs) sleepMs(sc.delayMs);
        const hooks = sc ? [{ key: 'codis-agents@codis-agents:hooks/hooks.json:pre_tool_use:0:0', eventName: 'preToolUse', handlerType: 'command', matcher: 'Bash',
          timeoutSec: 10, sourcePath: '/x/hooks/hooks.json', source: 'plugin', pluginId: 'codis-agents@codis-agents', displayOrder: 0,
          enabled: sc.enabled !== false, isManaged: false, currentHash: 'sha256:a', trustStatus: sc.trust || 'trusted' }] : [];
        out({ id: m.id, result: { data: [{ cwd: cwdSeen || '/', hooks, warnings: [], errors: [] }] } });
      }
    }
  });
}

function execRole() {
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  let schema = {};
  try { schema = JSON.parse(fs.readFileSync(flag('--output-schema'), 'utf8')); } catch { /* an empty key */ }
  const key = 'gp:' + Object.keys(schema.properties || {}).sort().join(',');
  const take = () => {
    const lock = path.join(dir, 'answers.lock');
    for (;;) { try { fs.mkdirSync(lock); break; } catch { sleepMs(5); } }
    try {
      const answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'));
      const sf = path.join(dir, 'answers.state.json');
      let st = {};
      try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* the first call */ }
      const n = st[key] || 0;
      st[key] = n + 1;
      fs.writeFileSync(sf, JSON.stringify(st));
      const list = answers[key] || [];
      return n < list.length ? list[n] : own(answers.default || {}, key) ? answers.default[key] : undefined;
    } finally { fs.rmdirSync(lock); }
  };
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { prompt += d; });
  process.stdin.on('end', () => {
    trace({ ev: 'start', key, cwd: process.cwd(), argv, prompt });
    let a = dir ? take() : undefined;
    const startHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const shas = [];
    if (a && a.$commits) {
      for (const c of a.$commits) {
        fs.writeFileSync(path.join(process.cwd(), c.path), c.content);
        const r = spawnSync(process.execPath, [CLIENT, '-m', c.message || 'm', '--', c.path], { env: process.env, encoding: 'utf8' });
        let j = {};
        try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { /* no answer */ }
        trace({ ev: 'commit', key, cwd: process.cwd(), rc: r.status, out: String(r.stdout || '') + String(r.stderr || '') });
        shas.push(j.sha || null);
      }
      a = a.then;
    }
    const sub = (x) => {
      if (Array.isArray(x)) return x.map(sub);
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
      const m = typeof x === 'string' ? /^\$(?:C(\d+)|(HEAD))$/.exec(x) : null;
      return m ? (m[2] ? startHead : shas[+m[1]]) : x;
    };
    a = sub(a);
    out({ type: 'thread.started', thread_id: `fake-${process.pid}` });
    if (a === undefined || (a && a.$exit !== undefined)) { trace({ ev: 'end', key }); process.exit(a === undefined ? 3 : a.$exit); }
    fs.writeFileSync(flag('-o'), JSON.stringify(a));
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    trace({ ev: 'end', key });
    process.exit(0);
  });
}

if (argv[0] === '--version') out('codex-cli 0.166.0');
else if (argv[0] === 'login') out('Logged in using ChatGPT');
else if (argv[0] === 'debug') out({ models: [{ slug: 'gpt-6-astra', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] });
else if (argv[0] === 'app-server') appServer();
else if (argv[0] === 'exec') execRole();
else { process.stderr.write(`fake codex: unknown command ${argv[0]}\n`); process.exit(2); }
