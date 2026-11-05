#!/usr/bin/env node
'use strict';
// scripts/codex-hooks-check.js (p-codex-D1b, mechanism M2): the read-only check that Codex CLI will run the plugin's
// hook. It starts `codex app-server` in the given CODEX_HOME, asks `hooks/list` over stdio JSON-RPC and exits 0 only
// when every hook of this plugin is `trusted` and `enabled`. Here `codex` is a fake app-server (a Node script in a
// PATH of its own) that answers by the protocol of Codex 0.166.0 from the scenario file `fake.json` in its own
// $CODEX_HOME and writes one journal line per start, so the tests see which home the child really got.
//   T1 trusted -> 0;  T2 untrusted, T3 modified, T9 disabled -> 1 with the hint;  T4 no hook of ours / errors -> 1;
//   T5 no codex, exit before the answer, no answer in time, not JSON, a JSON-RPC error, a result off the schema -> 3,
//   and the app-server is gone after the check;  T5b notifications and foreign ids between the answers are skipped;
//   T6 no --codex-home, the personal ~/.codex or a link to it -> 2 before any start;  T6b the child's CODEX_HOME is the
//   realpath of --codex-home, never the parent's, and initialize.result.codexHome must be that home;
//   T7 several hooks of ours: all must be trusted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'codex-hooks-check.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-check-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- the fake `codex app-server`
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME || '';
let sc = {};
try { sc = JSON.parse(fs.readFileSync(path.join(home, 'fake.json'), 'utf8')); } catch { /* an empty home */ }
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2), home, pid: process.pid }) + '\\n');
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\\n');
const noise = () => {
  if (!sc.noise) return;
  out({ method: 'remoteControl/status/changed', params: { status: 'disabled' }, emittedAtMs: 1 });
  out({ id: 99, result: sc.noise === 'trusted' ? { data: [{ cwd: '/', hooks: [], warnings: [], errors: [] }] } : { codexHome: home } });
};
const answer = (id, mode, result) => {
  if (mode === 'exit') { process.stderr.write('fake codex: CODEX_HOME points to nowhere\\n'); process.exit(1); }
  if (mode === 'silent') return;
  noise();
  if (mode === 'notjson') return out('this is not json');
  if (mode === 'error') return out({ error: { code: -32600, message: 'Invalid request: fake' }, id });
  out({ id, result });
};
setInterval(() => {}, 1000);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ msg: m, home }) + '\\n');
    if (m.method === 'initialize') {
      const r = { userAgent: 'fake/0.166.0', codexHome: sc.codexHome || home, platformFamily: 'unix', platformOs: 'macos' };
      answer(m.id, sc.init || 'ok', r);
    } else if (m.method === 'hooks/list') {
      const cwd = (m.params && m.params.cwds && m.params.cwds[0]) || '/';
      const data = sc.data || [{ cwd, hooks: sc.hooks || [], warnings: [], errors: sc.errors || [] }];
      answer(m.id, sc.list || 'ok', sc.list === 'nodata' ? {} : { data });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
fs.writeFileSync(path.join(BIN, 'codex'), FAKE, { mode: 0o755 });
const NOBIN = path.join(TMP, 'nobin');
fs.mkdirSync(NOBIN);

const OURS = 'codis-agents@codis-agents';
let seq = 0;
const hook = (trustStatus, extra) => Object.assign({
  key: `${OURS}:hooks/hooks.json:pre_tool_use:0:${seq++}`, eventName: 'preToolUse', handlerType: 'command', matcher: 'Bash',
  timeoutSec: 10, sourcePath: '/x/hooks/hooks.json', source: 'plugin', pluginId: OURS, displayOrder: 0, enabled: true,
  isManaged: false, currentHash: 'sha256:a/sha256:b', trustStatus,
}, extra || {});
// A home with its scenario; returns its path.
const mkHome = (name, scenario) => {
  const h = path.join(TMP, name);
  fs.mkdirSync(h, { recursive: true });
  if (scenario) fs.writeFileSync(path.join(h, 'fake.json'), JSON.stringify(scenario));
  return h;
};
// Runs the check; returns {status, out, log: [journal records]}.
const run = (args, opts) => {
  const o = opts || {};
  const log = path.join(TMP, `log-${seq++}.jsonl`);
  const env = Object.assign({}, process.env, { PATH: (o.bin || BIN) + path.delimiter + path.dirname(process.execPath), FAKE_CODEX_LOG: log }, o.env || {});
  if (!(o.env && 'CODEX_HOME' in o.env)) delete env.CODEX_HOME;
  const r = spawnSync(process.execPath, [SCRIPT].concat(args), { env, encoding: 'utf8', timeout: 20000, cwd: o.cwd || TMP });
  let recs = [];
  try { recs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no start */ }
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), log: recs };
};
const check = (name, scenario, opts) => { const h = mkHome(name, scenario); return Object.assign(run(['--codex-home', h].concat((opts && opts.args) || []), opts), { home: h }); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pids = (r) => r.log.filter((x) => x.pid).map((x) => x.pid);
const show = (r) => `exit ${r.status}: ${r.out.trim().slice(0, 300)}`;

ok('the script exists', fs.existsSync(SCRIPT), SCRIPT);

// ---- T1 trusted
let r = check('t1', { hooks: [hook('trusted')] });
ok('T1 trusted and enabled -> exit 0 and the line says trusted', r.status === 0 && /trusted/.test(r.out), show(r));
ok('T1 the app-server got initialize, then hooks/list with the --cwd (default: the current directory)', (() => {
  const m = r.log.filter((x) => x.msg).map((x) => x.msg);
  const iInit = m.findIndex((x) => x.method === 'initialize'), iList = m.findIndex((x) => x.method === 'hooks/list');
  return iInit >= 0 && iList > iInit && m.some((x, i) => x.method === 'initialized' && i > iInit && i < iList)
    && JSON.stringify(m[iList].params.cwds) === JSON.stringify([TMP]);
})(), JSON.stringify(r.log));
ok('T1 the app-server process is gone after the check', pids(r).length === 1 && !alive(pids(r)[0]), JSON.stringify(pids(r)));
const proj = path.join(TMP, 'proj');
fs.mkdirSync(proj);
r = check('t1cwd', { hooks: [hook('trusted')] }, { args: ['--cwd', proj] });
ok('T1 --cwd goes into hooks/list cwds', r.status === 0 && r.log.some((x) => x.msg && x.msg.method === 'hooks/list' && x.msg.params.cwds[0] === proj), show(r));

// ---- T2, T3, T9
r = check('t2', { hooks: [hook('untrusted')] });
ok('T2 untrusted -> exit 1, "not trusted: run /hooks in CODEX_HOME=<home>"', r.status === 1 && r.out.includes(`not trusted: run /hooks in CODEX_HOME=${r.home}`), show(r));
r = check('t3', { hooks: [hook('modified')] });
ok('T3 modified -> exit 1, "changed since trusted"', r.status === 1 && /changed since trusted/.test(r.out) && r.out.includes(`CODEX_HOME=${r.home}`), show(r));
r = check('t3m', { hooks: [hook('managed')] });
ok('T3 any other status (managed) -> exit 1, never 0', r.status === 1, show(r));
r = check('t9', { hooks: [hook('trusted', { enabled: false })] });
ok('T9 trusted but enabled:false -> exit 1, "hook disabled: enable it in /hooks in CODEX_HOME=<home>"', r.status === 1 && r.out.includes(`hook disabled: enable it in /hooks in CODEX_HOME=${r.home}`), show(r));

// ---- T4
r = check('t4a', {});
ok('T4 no hooks at all -> exit 1, no hook of the plugin', r.status === 1 && /no hook of plugin codis-agents/.test(r.out), show(r));
r = check('t4b', { hooks: [hook('trusted', { pluginId: 'other@market', key: 'other@market:hooks/hooks.json:pre_tool_use:0:0' }),
  hook('trusted', { pluginId: undefined, source: 'user', key: 'user:pre_tool_use:0:0' }),
  hook('trusted', { pluginId: 'codis-agents-extra@codis-agents', key: 'x:0' })] });
ok('T4 only hooks of other plugins and the user\'s -> exit 1 (theirs are not counted)', r.status === 1 && /no hook of plugin codis-agents/.test(r.out), show(r));
r = check('t4c', { hooks: [hook('trusted'), hook('untrusted', { pluginId: 'other@market', key: 'o:0' })] });
ok('T4 ours trusted, another plugin untrusted -> exit 0', r.status === 0, show(r));
r = check('t4d', { hooks: [hook('trusted')], errors: [{ path: '/x/hooks.json', message: 'bad hook file' }] });
ok('T4 errors in the answer -> exit 1 with the error', r.status === 1 && /bad hook file/.test(r.out), show(r));

// ---- T5
r = check('t5a', { hooks: [hook('trusted')] }, { bin: NOBIN });
ok('T5 no codex in PATH -> exit 3 "not checked"', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('t5b', { init: 'exit' });
ok('T5 the app-server exits before the answer -> exit 3 "not checked" with its stderr', r.status === 3 && /not checked/.test(r.out) && /points to nowhere/.test(r.out), show(r));
r = check('t5c', { list: 'silent', hooks: [hook('trusted')] }, { args: ['--timeout-ms', '400'] });
ok('T5 no answer in --timeout-ms -> exit 3 "not checked: no answer"', r.status === 3 && /not checked/.test(r.out) && /no answer/.test(r.out), show(r));
ok('T5 the silent app-server is killed', pids(r).length === 1 && !alive(pids(r)[0]), JSON.stringify(pids(r)));
r = check('t5d', { init: 'silent' }, { args: ['--timeout-ms', '400'] });
ok('T5 no answer to initialize in time -> exit 3', r.status === 3 && /no answer/.test(r.out), show(r));
r = check('t5e', { list: 'notjson', hooks: [hook('trusted')] });
ok('T5 an answer that is not JSON -> exit 3', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('t5f', { list: 'error', hooks: [hook('trusted')] });
ok('T5 a JSON-RPC error -> exit 3 with its message', r.status === 3 && /Invalid request: fake/.test(r.out), show(r));
r = check('t5g', { list: 'nodata', hooks: [hook('trusted')] });
ok('T5 a result without data -> exit 3', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('t5h', { hooks: [hook(undefined)] });
ok('T5 a hook of ours without trustStatus -> exit 3', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('t5i', { hooks: [hook('trusted', { enabled: undefined })] });
ok('T5 a hook of ours without enabled -> exit 3', r.status === 3 && /not checked/.test(r.out), show(r));
r = check('t5j', { data: [{ cwd: '/', hooks: [hook('trusted')], warnings: [] }] });
ok('T5 an entry without errors -> exit 3', r.status === 3 && /not checked/.test(r.out), show(r));
r = run(['--codex-home', mkHome('t5k', { hooks: [hook('trusted')] }), '--timeout-ms', 'soon']);
ok('T5 a --timeout-ms that is not a positive integer -> exit 2', r.status === 2 && !r.log.length, show(r));
ok('T5 the default answer time is 30000 ms', (() => { try { return require(SCRIPT).DEFAULT_TIMEOUT_MS === 30000; } catch { return false; } })());

// ---- T5b notifications and foreign ids between the answers
r = check('t5b1', { noise: 'trusted', hooks: [hook('untrusted')] });
ok('T5b a notification and a trusted-looking answer with a foreign id before ours -> the answer by id: exit 1 untrusted', r.status === 1 && /not trusted/.test(r.out), show(r));
r = check('t5b2', { noise: 'home', hooks: [hook('trusted')] });
ok('T5b the same noise around a trusted answer -> exit 0', r.status === 0, show(r));

// ---- T6
r = run([]);
ok('T6 no --codex-home -> exit 2 before any start', r.status === 2 && /--codex-home/.test(r.out) && !r.log.length, show(r));
const FHOME = path.join(TMP, 'fakehome');
fs.mkdirSync(path.join(FHOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(FHOME, '.codex', 'fake.json'), JSON.stringify({ hooks: [hook('trusted')] }));
r = run(['--codex-home', path.join(FHOME, '.codex')], { env: { HOME: FHOME } });
ok('T6 --codex-home = the personal ~/.codex -> exit 2 before any start', r.status === 2 && /~\/\.codex/.test(r.out) && !r.log.length, show(r));
fs.symlinkSync(path.join(FHOME, '.codex'), path.join(TMP, 'link-to-codex'));
r = run(['--codex-home', path.join(TMP, 'link-to-codex')], { env: { HOME: FHOME } });
ok('T6 a link to the personal ~/.codex -> exit 2 before any start', r.status === 2 && !r.log.length, show(r));
r = run(['--codex-home', path.join(FHOME, '.codex')], { env: { HOME: FHOME, CODEX_HOME: path.join(FHOME, '.codex') } });
ok('T6 the parent\'s CODEX_HOME does not make ~/.codex allowed', r.status === 2 && !r.log.length, show(r));

// ---- T6b
const OTHER = mkHome('t6b-other', { hooks: [hook('trusted')] });
r = check('t6b-arg', { hooks: [hook('untrusted')] }, { env: { CODEX_HOME: OTHER } });
ok('T6b the parent\'s CODEX_HOME points elsewhere: the child answers from --codex-home (exit 1, untrusted)', r.status === 1 && /not trusted/.test(r.out), show(r));
ok('T6b the child\'s CODEX_HOME is the realpath of --codex-home', r.log.length && r.log.every((x) => x.home === r.home), JSON.stringify(r.log.map((x) => x.home)));
fs.symlinkSync(mkHome('t6b-real', { hooks: [hook('trusted')] }), path.join(TMP, 't6b-link'));
r = run(['--codex-home', path.join(TMP, 't6b-link')]);
ok('T6b a link as --codex-home: the child gets its realpath', r.status === 0 && r.log.length && r.log.every((x) => x.home === path.join(TMP, 't6b-real')), show(r) + ' ' + JSON.stringify(r.log.map((x) => x.home)));
r = check('t6b-mismatch', { codexHome: path.join(TMP, 'elsewhere'), hooks: [hook('trusted')] });
ok('T6b initialize.result.codexHome is not the home -> exit 3, names codexHome', r.status === 3 && /codexHome/.test(r.out), show(r));

// ---- T7
r = check('t7a', { hooks: [hook('trusted'), hook('modified')] });
ok('T7 two hooks of ours, one trusted, one modified -> exit 1', r.status === 1 && /changed since trusted/.test(r.out), show(r));
r = check('t7b', { hooks: [hook('modified'), hook('trusted')] });
ok('T7 the same in the other order -> exit 1', r.status === 1, show(r));
r = check('t7c', { hooks: [hook('trusted'), hook('trusted')] });
ok('T7 two hooks of ours, both trusted -> exit 0', r.status === 0, show(r));
r = check('t7d', { data: [{ cwd: '/a', hooks: [hook('trusted')], warnings: [], errors: [] }, { cwd: '/b', hooks: [hook('untrusted')], warnings: [], errors: [] }] });
ok('T7 hooks of ours in two entries, one untrusted -> exit 1', r.status === 1, show(r));

done();
