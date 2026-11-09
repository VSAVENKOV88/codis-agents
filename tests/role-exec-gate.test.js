#!/usr/bin/env node
'use strict';
// The launch gate of the role adapter (p-codex-B1-b1, cells E11, E12, E13): the process of a role starts as /bin/sh that
// waits for one line "go" on stdin and then execs the host CLI, so the pid, the process group and the start time are
// the CLI's own; cfg.onLaunch registers them (synchronously, before go), and the CLI runs only after that. A registration
// that fails closes stdin: the gate exits, the CLI never starts. No model is called.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const { createAgent, hostSection } = require('../scripts/role-exec.js');

const ROOT = path.join(__dirname, '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'), 'utf8'));
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'role-exec-gate-')));
process.on('exit', () => { fs.rmSync(W, { recursive: true, force: true }); });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

// The fake CLI: ran.json in its cwd (pid, group, start time, sha256 and size of stdin), then the answer of its host.
const FAKE = path.join(W, 'fake-cli.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs'), crypto = require('crypto'), { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const b = Buffer.concat(chunks);
  const ps = (f) => spawnSync('ps', ['-o', f + '=', '-p', String(process.pid)], { encoding: 'utf8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).stdout.trim();
  fs.writeFileSync('ran.json', JSON.stringify({ pid: process.pid, pgid: +ps('pgid'), lstart: ps('lstart'), sha: crypto.createHash('sha256').update(b).digest('hex'), size: b.length }));
  const o = argv.indexOf('-o');
  if (o >= 0) {
    fs.writeFileSync(argv[o + 1], JSON.stringify({ verdict: 'done' }));
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage: {} }) + '\\n');
  } else process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { verdict: 'done' } }) + '\\n');
});
`);
fs.chmodSync(FAKE, 0o755);
const NOEXEC = path.join(W, 'noexec');
fs.writeFileSync(NOEXEC, '#!/bin/sh\nexit 0\n');
fs.chmodSync(NOEXEC, 0o644);

let n = 0;
const task = () => { const key = `T${++n}`; const dir = path.join(W, key); fs.mkdirSync(dir); return { key, dir, wt: dir }; };
const records = (t) => fs.readFileSync(path.join(t.dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ranOf = (t) => { try { return JSON.parse(fs.readFileSync(path.join(t.dir, 'ran.json'), 'utf8')); } catch { return null; } };
const home = path.join(W, 'chome');
fs.mkdirSync(home);
const mk = (host, t, extra) => createAgent(Object.assign({ host, tasks: { [t.key]: { dir: t.dir, wt: t.wt } }, pluginRoot: ROOT, callsDir: path.join(W, 'calls'), log: () => {},
  env: process.env, codex: { bin: FAKE, home, catalog: CATALOG }, claude: { bin: FAKE } }, extra || {}));
const call = (ag, t, prompt, stepId) => ag(prompt, { label: `review:${t.key}#1`, schema: SCHEMA, agentType: 'general-purpose', stepId });

(async () => {
  for (const [cell, host] of [['E11', 'claude'], ['E12', 'codex']]) {
    const t = task();
    const prompt = '\nthe first line of the prompt is empty, go\n' + 'prompt-é'.repeat(350000);
    // on codex the host section follows the prompt (role-exec.js hostSection)
    const want = crypto.createHash('sha256').update(host === 'codex' ? prompt + '\n\n' + hostSection('review', t) : prompt).digest('hex');
    const seen = [];
    const v = await call(mk(host, t, { onLaunch: (i) => {
      sleepMs(400);
      seen.push(Object.assign({}, i, { ranDuring: ranOf(t) }));
    } }), t, prompt, 'R:7');
    const ran = ranOf(t);
    const i = seen[0] || {};
    ok(`${cell} ${host}: the registration comes once, with pid, group and start time, the call folder and the step`, seen.length === 1 && i.pid > 0 && i.pgid > 0 && typeof i.lstart === 'string' && i.lstart.length > 10
      && i.stepId === 'R:7' && i.label === `review:${t.key}#1` && !!i.callDir && !i.substitute, JSON.stringify(i));
    ok(`${cell} ${host}: the CLI waits for it (400 ms inside onLaunch and it has not run)`, i.ranDuring === null, JSON.stringify(i.ranDuring));
    ok(`${cell} ${host}: pid, group and start time stay through exec; the group is the process`, ran && ran.pid === i.pid && ran.pgid === i.pgid && ran.pgid === ran.pid && ran.lstart === i.lstart, JSON.stringify(ran));
    ok(`${cell} ${host}: a prompt of over 3 MB reaches the CLI whole, byte for byte`, ran && ran.sha === want && ran.size > 3000000, JSON.stringify(ran));
    ok(`${cell} ${host}: the call ends as ok with the object of the schema; the record names the step`, v && v.verdict === 'done' && records(t)[0].outcome === 'ok' && records(t)[0].stepId === 'R:7' && records(t)[0].pid === i.pid, JSON.stringify(records(t)[0]));
  }

  // ---- E13: a registration that fails
  for (const host of ['claude', 'codex']) {
    let t = task();
    let v = await call(mk(host, t, { onLaunch: () => { throw new Error('the journal refused'); } }), t, 'p');
    let r = records(t)[0];
    ok(`E13 ${host}: onLaunch throws -> stdin closed, the CLI never starts, the call ends as not-registered with the cause`, v === null && ranOf(t) === null && r.outcome === 'not-registered' && /the journal refused/.test(r.error) && r.rc === 70, JSON.stringify(r));
  }
  {
    const t = task();
    let called = 0;
    const PATH0 = process.env.PATH;
    const ag = mk('claude', t, { env: Object.assign({}, process.env), onLaunch: () => { called++; } });
    process.env.PATH = path.join(W, 'nothing-here');
    const v = await call(ag, t, 'p');
    process.env.PATH = PATH0;
    const r = records(t)[0];
    ok('E13 ps does not answer: no registration, the CLI never starts, not-registered', v === null && called === 0 && ranOf(t) === null && r.outcome === 'not-registered' && /ps/.test(r.error), JSON.stringify(r));
  }

  // ---- E13: no binary, no execute bit: the exec of the gate fails, the outcome is by the exit code
  {
    let t = task();
    let regs = 0;
    let v = await call(mk('claude', t, { onLaunch: () => { regs++; }, claude: { bin: path.join(W, 'no-such-cli') } }), t, 'p');
    let r = records(t)[0];
    ok('E13 no binary under the gate: crashed, rc 126 or 127, the text of the shell in the error; the gate itself was registered', v === null && regs === 1 && r.outcome === 'crashed' && (r.rc === 126 || r.rc === 127) && /no-such-cli/.test(r.error), JSON.stringify(r));
    t = task();
    v = await call(mk('codex', t, { onLaunch: () => {}, codex: { bin: NOEXEC, home, catalog: CATALOG } }), t, 'p');
    r = records(t)[0];
    ok('E13 no execute bit under the gate: crashed, rc 126', v === null && r.outcome === 'crashed' && r.rc === 126 && /noexec/.test(r.error), JSON.stringify(r));
  }

  // ---- E13: a substitute launcher (cfg.launch): marked, not taken for "not started"
  {
    const t = task();
    const seen = [];
    let launched = 0;
    const v = await call(mk('claude', t, { onLaunch: (i) => seen.push(i), launch: async () => { launched++; return { output: { verdict: 'done' } }; } }), t, 'p', 'R:9');
    ok('E13 a substitute launcher registers as substitute, before it runs, with the step', v && launched === 1 && seen.length === 1 && seen[0].substitute === true && seen[0].stepId === 'R:9' && seen[0].pid === null, JSON.stringify(seen));
    const t2 = task();
    let launched2 = 0;
    const v2 = await call(mk('claude', t2, { onLaunch: () => { throw new Error('no journal'); }, launch: async () => { launched2++; return { output: { verdict: 'done' } }; } }), t2, 'p');
    ok('E13 a substitute launcher whose registration fails is not run', v2 === null && launched2 === 0 && records(t2)[0].outcome === 'not-registered', JSON.stringify(records(t2)[0]));
  }

  // ---- the gate needs no caller: without onLaunch the CLI gets its prompt and its stdin as before
  {
    const t = task();
    const v = await call(mk('claude', t), t, 'plain');
    ok('without onLaunch the gate opens at once', v && v.verdict === 'done' && ranOf(t).size === 5 && records(t)[0].outcome === 'ok', JSON.stringify(records(t)[0]));
    const bad = (() => { try { mk('claude', task(), { onLaunch: 'x' }); return null; } catch (e) { return e; } })();
    ok('onLaunch must be a function', bad && /onLaunch must be a function/.test(bad.message), String(bad));
  }

  // ---- no process stays behind
  const left = spawnSync('pgrep', ['-f', W], { encoding: 'utf8' }).stdout.trim();
  ok('no process of this test is left', !left, left);
  done();
})();
