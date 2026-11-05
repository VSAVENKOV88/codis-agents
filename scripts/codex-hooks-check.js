#!/usr/bin/env node
'use strict';
// Read-only check that Codex CLI will run this plugin's hook in a given Codex home.
//
// Codex runs a plugin hook only after the user trusts it in /hooks, and resets that trust whenever any file of the
// installed plugin changes, an update included; until then the hook is skipped and commands run unjudged. This script
// asks Codex itself: it starts `codex app-server` with CODEX_HOME = the realpath of --codex-home (never the parent's),
// sends `initialize` (its result must name that same home as `codexHome`), `initialized`, then
// `hooks/list {cwds: [--cwd]}` over stdio JSON-RPC (one JSON object per line), matches the answers by `id` and skips
// notifications. The hooks of this plugin are the entries whose `pluginId` before `@` is the `name` of
// `.claude-plugin/plugin.json`. It writes nothing itself; the app-server keeps its own state files in that home.
//
// Exit codes:
//   0  every hook of this plugin is `trustStatus: trusted` and `enabled: true`, and the answer has no errors
//   1  not so: no hook of the plugin, a hook untrusted, modified, managed or disabled, or errors in the answer
//   2  refused before any start: no --codex-home, it is the personal ~/.codex (the same directory
//      by device and inode: a link, a case variant, a firmlink), bad arguments
//   3  not checked: codex cannot start, exits before the answer, no answer in --timeout-ms, an answer that is not JSON,
//      a JSON-RPC error, a result off the schema of Codex 0.166.0, or another codexHome. The app-server protocol is
//      marked experimental, so anything unexpected is a failure, never a pass.
// The app-server is stopped when the check ends (SIGTERM to its process group, SIGKILL after KILL_GRACE_MS).
//
// usage: codex-hooks-check.js --codex-home <dir> [--cwd <project dir>] [--codex <bin>] [--timeout-ms <n>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Owner 2026-11-05, answer 5: wait 30 s for the app-server, then "not checked" (measured answers 0.2-0.4 s).
const DEFAULT_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 3000;
const USAGE = 'usage: codex-hooks-check.js --codex-home <dir> [--cwd <project dir>] [--codex <bin>] [--timeout-ms <n, default 30000>]';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
// One directory, by identity: the same device and inode when both exist. A realpath string is not enough on macOS:
// it keeps the letter case given (APFS ignores case by default, so ~/.CODEX is ~/.codex) and does not resolve the
// /System/Volumes/Data firmlink. Without both stats only the realpath strings are compared.
const sameDir = (a, b) => {
  let sa, sb;
  try { sa = fs.statSync(a); sb = fs.statSync(b); } catch { return real(a) === real(b); }
  return sa.dev === sb.dev && sa.ino === sb.ino;
};
const isPersonalCodex = (home) => sameDir(home, path.join(os.homedir(), '.codex'));
const pluginName = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).name;

function parseArgs(argv) {
  const a = { timeoutMs: DEFAULT_TIMEOUT_MS, codex: 'codex' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--codex-home' || k === '--cwd' || k === '--codex' || k === '--timeout-ms') {
      if (v == null || v === '') return { error: `${k} needs a value` };
      i++;
      if (k === '--codex-home') a.home = v;
      else if (k === '--cwd') a.cwd = v;
      else if (k === '--codex') a.codex = v;
      else if (/^[1-9]\d*$/.test(v)) a.timeoutMs = +v;
      else return { error: `--timeout-ms must be a positive integer, got ${JSON.stringify(v)}` };
    } else if (k === '-h' || k === '--help') return { help: true };
    else return { error: `unknown argument ${JSON.stringify(k)}` };
  }
  if (!a.home) return { error: '--codex-home is required: the Codex home whose hooks are checked (CODEX_HOME of the sessions)' };
  return a;
}

// Talks to one app-server; resolves {ok, data} or {ok: false, reason} (never rejects).
function listHooks({ codex, home, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { CODEX_HOME: home });
    let child;
    try { child = spawn(codex, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); } catch (e) { resolve({ ok: false, reason: `cannot start ${codex}: ${e.message}` }); return; }
    let finished = false, stderr = '', buf = '', step = 'initialize';
    const timer = setTimeout(() => finish({ ok: false, reason: `no answer to ${step} in ${timeoutMs} ms` }), timeoutMs);
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    let exited = false;
    child.on('exit', () => { exited = true; });
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (exited || child.pid == null) { resolve(result); return; }
      try { child.stdin.end(); } catch { /* closed */ }
      kill('SIGTERM');
      const hard = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      child.on('close', () => { clearTimeout(hard); resolve(result); });
    }
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* the exit handler reports it */ } };
    child.on('error', (e) => finish({ ok: false, reason: `cannot start ${codex}: ${e.code || e.message}` }));
    child.stdin.on('error', () => { /* the exit handler reports it */ });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('close', (code, sig) => {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      finish({ ok: false, reason: `codex app-server exited (${sig || code}) before the answer to ${step}${tail ? ': ' + tail : ''}` });
    });
    const onMessage = (m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return finish({ ok: false, reason: `an answer that is not a JSON-RPC message: ${JSON.stringify(m).slice(0, 200)}` });
      // Notifications (no id) and answers to other ids are not ours.
      if (!('id' in m)) return undefined;
      const want = step === 'initialize' ? 1 : 2;
      if (m.id !== want) return undefined;
      if (m.error) return finish({ ok: false, reason: `JSON-RPC error on ${step}: ${m.error.message || JSON.stringify(m.error)}` });
      const res = m.result;
      if (step === 'initialize') {
        if (!res || typeof res.codexHome !== 'string') return finish({ ok: false, reason: 'initialize: the result has no codexHome' });
        if (!sameDir(res.codexHome, home)) return finish({ ok: false, reason: `initialize: codexHome ${res.codexHome} is not ${home}` });
        step = 'hooks/list';
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
        return undefined;
      }
      if (!res || !Array.isArray(res.data)) return finish({ ok: false, reason: 'hooks/list: the result has no data array' });
      return finish({ ok: true, data: res.data });
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while (!finished && (i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { finish({ ok: false, reason: `an answer that is not JSON: ${line.slice(0, 200)}` }); return; }
        onMessage(m);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codis-agents-hooks-check', version: '1' } } });
  });
}

// The verdict on the hooks/list data: {code, lines}.
function judge(data, name, home) {
  const lines = [];
  const own = [];
  const errors = [];
  for (const e of data) {
    if (!e || !Array.isArray(e.hooks) || !Array.isArray(e.errors)) return { code: 3, lines: ['not checked: hooks/list: an entry without hooks or errors arrays'] };
    for (const er of e.errors) errors.push(`${er && er.path}: ${er && er.message}`);
    for (const h of e.hooks) {
      if (!h || typeof h.pluginId !== 'string' || h.pluginId.split('@')[0] !== name) continue;
      if (typeof h.trustStatus !== 'string' || typeof h.enabled !== 'boolean' || typeof h.key !== 'string') {
        return { code: 3, lines: [`not checked: hooks/list: a hook of ${name} without key, trustStatus or enabled`] };
      }
      own.push(h);
    }
  }
  let bad = false;
  for (const er of errors) { bad = true; lines.push(`error: ${er}`); }
  if (!own.length) {
    bad = true;
    lines.push(`no hook of plugin ${name} in CODEX_HOME=${home}: install it (codex plugin add ${name}@<marketplace>) and enable it`);
  }
  for (const h of own) {
    let what;
    if (h.trustStatus === 'untrusted') what = `not trusted: run /hooks in CODEX_HOME=${home} and trust it`;
    else if (h.trustStatus === 'modified') what = `changed since trusted: review it again in /hooks in CODEX_HOME=${home}`;
    else if (h.trustStatus !== 'trusted') what = `trust status ${h.trustStatus}: only trusted counts`;
    else if (h.enabled !== true) what = `hook disabled: enable it in /hooks in CODEX_HOME=${home}`;
    else what = 'trusted';
    if (what !== 'trusted') bad = true;
    lines.push(`${h.key}: ${what}`);
  }
  return { code: bad ? 1 : 0, lines };
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.help) { console.log(USAGE); return 0; }
  if (a.error) { console.error(`codex-hooks-check: ${a.error}\n${USAGE}`); return 2; }
  if (isPersonalCodex(a.home)) {
    console.error(`codex-hooks-check: --codex-home ${a.home} is the personal ~/.codex: the app-server writes into its home, so check a separate home (the CODEX_HOME of the sessions)`);
    return 2;
  }
  const home = real(a.home);
  const cwd = path.resolve(a.cwd || process.cwd());
  let name;
  try { name = pluginName(); } catch (e) { console.error(`codex-hooks-check: not checked: cannot read .claude-plugin/plugin.json: ${e.message}`); return 3; }
  const r = await listHooks({ codex: a.codex, home, cwd, timeoutMs: a.timeoutMs });
  if (!r.ok) { console.log(`codex-hooks-check: not checked: ${r.reason}`); return 3; }
  const v = judge(r.data, name, home);
  for (const l of v.lines) console.log(`codex-hooks-check: ${l}`);
  console.log(`codex-hooks-check: ${v.code === 0 ? 'ok, the hook of ' + name + ' runs' : 'the hook of ' + name + ' does not run (exit ' + v.code + ')'} in CODEX_HOME=${home}`);
  return v.code;
}

module.exports = { DEFAULT_TIMEOUT_MS, judge, parseArgs };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
