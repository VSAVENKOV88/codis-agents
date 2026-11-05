#!/usr/bin/env node
'use strict';
// p-codex-D1b tester: cells of scripts/codex-hooks-check.js that tests/codex-hooks-check.test.js does not name.
//   T6  the personal ~/.codex under another spelling of the same directory: a case variant on a case-insensitive disk
//       (APFS default) and the /System/Volumes/Data firmlink of macOS - refused before any start (UC-2 Errors 3);
//   T5  the stream of the app-server: an answer split across writes, a notification and the answer in one write, an
//       exit 0 without an answer, a last line without a newline; a JSON-RPC error and a result without codexHome on
//       initialize; an unknown trust status;
//   T4  hooks/list with an empty data array;
//   M2  the plugin is the `name` of .claude-plugin/plugin.json next to the script (an installed copy), not a constant;
//   M2  read-only: the check writes nothing into the home (no config.toml, no hooks.state);
//   T6  bad arguments (unknown, --codex-home without a value) -> 2 before any start; --help -> 0 without a start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'codex-hooks-check.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-check-t-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
// A fake `codex app-server`: answers by the protocol of Codex 0.166.0 from fake.json in its $CODEX_HOME; one journal
// line per start into FAKE_CODEX_LOG. It writes nothing into the home.
const FAKE = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME || '';
let sc = {};
try { sc = JSON.parse(fs.readFileSync(path.join(home, 'fake.json'), 'utf8')); } catch { /* none */ }
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ home, pid: process.pid }) + '\\n');
const w = (s) => process.stdout.write(s);
const answer = (id, mode, result) => {
  const line = JSON.stringify({ id, result });
  if (mode === 'split') { w(line.slice(0, 7)); setTimeout(() => w(line.slice(7, 40)), 60); setTimeout(() => w(line.slice(40) + '\\n'), 120); return; }
  if (mode === 'batch') { w(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n' + line + '\\n' + JSON.stringify({ method: 'x/y' }) + '\\n'); return; }
  if (mode === 'error') { w(JSON.stringify({ error: { code: -32601, message: 'init refused by fake' }, id }) + '\\n'); return; }
  if (mode === 'nohome') { w(JSON.stringify({ id, result: { userAgent: 'fake' } }) + '\\n'); return; }
  if (mode === 'exit0') { process.exit(0); }
  if (mode === 'partial') { w(line); setTimeout(() => process.exit(0), 50); return; }
  w(line + '\\n');
};
setInterval(() => {}, 1000);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.method === 'initialize') answer(m.id, sc.init || 'ok', { userAgent: 'fake/0.166.0', codexHome: home });
    else if (m.method === 'hooks/list') answer(m.id, sc.list || 'ok', { data: sc.data || [{ cwd: '/', hooks: sc.hooks || [], warnings: [], errors: [] }] });
  }
});
`;
fs.writeFileSync(path.join(BIN, 'codex'), FAKE, { mode: 0o755 });

const hook = (trustStatus, pluginId, extra) => Object.assign({
  key: `${pluginId || 'codis-agents@codis-agents'}:hooks/hooks.json:pre_tool_use:0:0`, eventName: 'preToolUse',
  handlerType: 'command', matcher: 'Bash', timeoutSec: 10, sourcePath: '/x/hooks/hooks.json', source: 'plugin',
  pluginId: pluginId || 'codis-agents@codis-agents', displayOrder: 0, enabled: true, isManaged: false,
  currentHash: 'sha256:a/sha256:b', trustStatus,
}, extra || {});
let seq = 0;
const mkHome = (name, sc) => { const h = path.join(TMP, name); fs.mkdirSync(h, { recursive: true }); if (sc) fs.writeFileSync(path.join(h, 'fake.json'), JSON.stringify(sc)); return h; };
const run = (args, o) => {
  o = o || {};
  const log = path.join(TMP, `log-${seq++}.jsonl`);
  const env = Object.assign({}, process.env, { PATH: BIN, FAKE_CODEX_LOG: log }, o.env || {});
  delete env.CODEX_HOME;
  const r = spawnSync(process.execPath, [o.script || SCRIPT].concat(args), { env, encoding: 'utf8', timeout: 20000, cwd: TMP });
  let starts = [];
  try { starts = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no start */ }
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), starts };
};
const show = (r) => `exit ${r.status}, starts ${r.starts.length}: ${r.out.trim().slice(0, 300)}`;
const check = (name, sc, args) => run(['--codex-home', mkHome(name, sc), '--timeout-ms', '5000'].concat(args || []));

// ---- T6: another spelling of the personal ~/.codex
const FHOME = path.join(TMP, 'fakehome');
fs.mkdirSync(path.join(FHOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(FHOME, '.codex', 'fake.json'), JSON.stringify({ hooks: [hook('trusted')] }));
const caseInsensitive = fs.existsSync(path.join(FHOME, '.CODEX'));
if (caseInsensitive) {
  const r = run(['--codex-home', path.join(FHOME, '.CODEX')], { env: { HOME: FHOME } });
  ok('T6 the personal ~/.codex spelled ~/.CODEX on a case-insensitive disk -> exit 2 before any start', r.status === 2 && !r.starts.length, show(r));
} else skip('T6 ~/.CODEX', 'the disk is case-sensitive');
const FIRM = path.join('/System/Volumes/Data', FHOME, '.codex');
let firm = false;
try { const a = fs.statSync(FIRM), b = fs.statSync(path.join(FHOME, '.codex')); firm = a.dev === b.dev && a.ino === b.ino; } catch { /* not macOS */ }
if (firm) {
  const r = run(['--codex-home', FIRM], { env: { HOME: FHOME } });
  ok('T6 the personal ~/.codex through the /System/Volumes/Data firmlink -> exit 2 before any start', r.status === 2 && !r.starts.length, show(r));
} else skip('T6 firmlink', 'no /System/Volumes/Data firmlink to the home');
{
  // A directory inside ~/.codex is not ~/.codex: the rule is "equal", and the check runs there.
  const inner = path.join(FHOME, '.codex', 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'fake.json'), JSON.stringify({ hooks: [hook('trusted')] }));
  const r = run(['--codex-home', inner, '--timeout-ms', '5000'], { env: { HOME: FHOME } });
  ok('T6 a directory inside ~/.codex is not refused (equal, not contained)', r.status === 0 && r.starts.length === 1, show(r));
}

// ---- T6: bad arguments before any start
let r = run(['--codex-home', mkHome('arg1', { hooks: [hook('trusted')] }), '--bogus', 'x']);
ok('T6 an unknown argument -> exit 2 before any start', r.status === 2 && !r.starts.length && /unknown argument/.test(r.out), show(r));
r = run(['--cwd', TMP, '--codex-home']);
ok('T6 --codex-home without a value -> exit 2 before any start', r.status === 2 && !r.starts.length, show(r));
r = run(['--codex-home', mkHome('arg2', { hooks: [hook('trusted')] }), '--timeout-ms', '0']);
ok('T6 --timeout-ms 0 -> exit 2 before any start', r.status === 2 && !r.starts.length, show(r));
r = run(['--help']);
ok('--help -> exit 0, usage, no start', r.status === 0 && /usage:/.test(r.out) && !r.starts.length, show(r));

// ---- T5: the stream
r = check('s-split', { list: 'split', hooks: [hook('untrusted')] });
ok('T5 an answer split across three writes is read whole (untrusted -> 1)', r.status === 1 && /not trusted/.test(r.out), show(r));
r = check('s-split-init', { init: 'split', hooks: [hook('trusted')] });
ok('T5 an initialize answer split across writes -> the check goes on (trusted -> 0)', r.status === 0, show(r));
r = check('s-batch', { list: 'batch', hooks: [hook('modified')] });
ok('T5 notifications and the answer in one write -> the answer counts (modified -> 1)', r.status === 1 && /changed since trusted/.test(r.out), show(r));
r = check('s-batch-ok', { init: 'batch', list: 'batch', hooks: [hook('trusted')] });
ok('T5 the same in both answers, trusted -> 0', r.status === 0, show(r));
r = check('s-exit0', { init: 'exit0' });
ok('T5 the app-server exits 0 without an answer -> exit 3 "not checked"', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('s-partial', { list: 'partial', hooks: [hook('trusted')] });
ok('T5 a trusted answer without its newline, then exit -> exit 3, never 0', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('s-initerr', { init: 'error' });
ok('T5 a JSON-RPC error on initialize -> exit 3 with its message', r.status === 3 && /init refused by fake/.test(r.out), show(r));
r = check('s-nohome', { init: 'nohome', hooks: [hook('trusted')] });
ok('T5 initialize without codexHome -> exit 3', r.status === 3 && /codexHome/.test(r.out), show(r));
r = check('s-unknown', { hooks: [hook('pending-review')] });
ok('T5 an unknown trust status -> exit 1, never 0', r.status === 1 && /pending-review/.test(r.out), show(r));

// ---- T4: empty data
r = check('t4-empty', { data: [] });
ok('T4 hooks/list with data [] -> exit 1, no hook of the plugin', r.status === 1 && /no hook of plugin codis-agents/.test(r.out), show(r));

// ---- M2: the plugin name comes from .claude-plugin/plugin.json next to the script
{
  const copy = path.join(TMP, 'copy');
  fs.mkdirSync(path.join(copy, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(copy, '.claude-plugin'));
  fs.copyFileSync(SCRIPT, path.join(copy, 'scripts', 'codex-hooks-check.js'));
  fs.writeFileSync(path.join(copy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'renamed-agents', version: '9.9.9' }));
  const s = path.join(copy, 'scripts', 'codex-hooks-check.js');
  r = run(['--codex-home', mkHome('n1', { hooks: [hook('trusted', 'renamed-agents@m')] })], { script: s });
  ok('M2 a copy named renamed-agents: its trusted hook -> 0', r.status === 0, show(r));
  r = run(['--codex-home', mkHome('n2', { hooks: [hook('trusted', 'codis-agents@codis-agents')] })], { script: s });
  ok('M2 a copy named renamed-agents: only a codis-agents hook -> 1 (not ours)', r.status === 1 && /no hook of plugin renamed-agents/.test(r.out), show(r));
}

// ---- M2: read-only
{
  const h = mkHome('ro', { hooks: [hook('untrusted')] });
  const snap = () => fs.readdirSync(h).sort().map((f) => { const s = fs.statSync(path.join(h, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
  const before = snap();
  r = run(['--codex-home', h, '--timeout-ms', '5000']);
  ok('M2 the check writes nothing into the home (untrusted stays untrusted, no config.toml)', r.status === 1 && snap() === before && !fs.existsSync(path.join(h, 'config.toml')), `${show(r)}; ${before} -> ${snap()}`);
}

done();
