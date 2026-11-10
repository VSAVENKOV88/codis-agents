#!/usr/bin/env node
'use strict';
// The run of a task found by its key, and a plain argv for the conductor on Codex (p-codex-D2b-2, cells B1-B6 and
// C1-C7 of the analysis of p-codex-D2b, plus the refusal of a slot inside the codex sandbox).
// Inside the codex sandbox ps does not answer (it is refused there), so a conductor started by a command that did not
// match the execpolicy rule of the coordinator home (a `node -e` wrapper, `sh -c`, `env`, a node flag, another path to
// node, a relative path) cannot name itself in the lock of a task. The fact decides, never the variable: start refuses
// when ps gives no start time of its own process, before any run folder (exit 69, the environment), and names
// CODEX_SANDBOX only when that variable is set. ps is found by PATH, so a fake ps first in PATH plays the sandbox.
//   B1-B5 the role-chain skill (On Codex): the brief <sharedDir>/<key>/BRIEF.md, sharedDir from config.js json, the
//         last run: line, earlier lines history, a line for every start that printed its JSON, the lock while the run
//         lives, status <key> when there is no line;
//   B6    chain-run.js status <key>: exit 64 listing the runs whose request names that key (newest first) and the brief;
//   C1    the skills list the forms that do not match a rule; C2 after a refusal naming the sandbox: execpolicy check,
//         then a plain argv, never a wrapper;
//   C3    start with no answer of ps: exit 69 before the run folder, naming ps -o lstart, CODEX_SANDBOX and the plain argv;
//   C4    start with ps: exit 0, as before;
//   C5    the conductor that cannot read its own start time: the block names CODEX_SANDBOX and the plain argv;
//   C6    status with no answer of ps: running (exit 3) with a field why naming ps and CODEX_SANDBOX;
//   C7    ps refused or missing without CODEX_SANDBOX: the same refusal without naming it;
//   S     a slot directory the process cannot write, with CODEX_SANDBOX set: the refusal (exit 77, one line) says the
//         role sandbox does not include the slot directory and heavy steps on codex wait for A2b.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const CR = path.join(ROOT, 'scripts', 'chain-run.js');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const flat = (s) => s.replace(/\s+/g, ' ');
const J = (x) => String(JSON.stringify(x)).slice(0, 1500);

// ---- the texts
const rc = read('skills/role-chain/SKILL.md');
const onCodex = (/### On Codex, or roles on another host[\s\S]*?(?=\n### |\n## |$)/.exec(rc) || [''])[0];
const step = (n) => flat((new RegExp(`\\n${n}\\. [\\s\\S]*?(?=\\n${n + 1}\\. |$)`).exec(onCodex) || [''])[0]);
const s2 = step(2), s3 = step(3), s5 = step(5);
ok('B1 role-chain step 5: the brief of a key is <sharedDir>/<key>/BRIEF.md, sharedDir from config.js json',
  /`<sharedDir>\/<key>\/BRIEF\.md`/.test(s5) && /`node <plugin>\/scripts\/config\.js json`/.test(s5), s5);
ok('B1 role-chain step 5: no search of folders by a similar name', /never[^.]*similar name/.test(s5), s5);
ok('B2 role-chain step 5: the last run: line; the earlier lines are history, never a new start for them',
  /last `run:` line/.test(s5) && /earlier `run:` lines are history/.test(s5), s5);
ok('B3 role-chain step 3: the run: line for every start that printed its JSON, even a run that ended at once',
  /every start that printed its JSON line/.test(s3) && /ended at once/.test(s3), s3);
ok('B4 role-chain step 5: while the run lives its lock <sharedDir>/runs/.locks/<key>.lock names the runId', /`<sharedDir>\/runs\/\.locks\/<key>\.lock`/.test(s5), s5);
ok('B5 role-chain step 5: without a run: line, chain-run.js status <key> lists the runs of the task',
  /[Ww]ithout a `run:` line[^.]*`node <plugin>\/scripts\/chain-run\.js status <key>`/.test(s5), s5);
const FORMS = [/`node -e`/, /`sh -c`/, /`env`/, /node flag/, /other path to node/, /relative/];
ok('C1 role-chain step 2: the forms that do not match the rule (node -e, sh -c, env, a node flag, another node, a relative path)',
  FORMS.every((r) => r.test(s2)), s2);
ok('C3 role-chain step 2: exit 69 when ps does not answer, naming CODEX_SANDBOX', /69[^.;]*ps[^.;]*`CODEX_SANDBOX`/.test(s2), s2);
const co = read('skills/coordinator/SKILL.md');
const homes = flat((/On Codex: homes, sandbox and rules[\s\S]*?(?=\n## )/.exec(co) || [''])[0]);
ok('C1 coordinator (homes): the forms that do not match a rule', FORMS.every((r) => r.test(homes)), homes.slice(0, 2500));
ok('C2 coordinator (homes): after a refusal that names the sandbox, codex execpolicy check, then the plain argv; never a wrapper',
  /names the sandbox[^.]*`codex execpolicy check --rules <rules file> -- <command>`[^.]*plain argv[^.]*never wrap/.test(homes), homes.slice(0, 2500));
const readme = read('README.md');
const runChain = flat((/^## Run a chain\s*$[\s\S]*?(?=^## )/m.exec(readme) || [''])[0]);
ok('C3 README Run a chain: start exits 69 when ps does not answer (CODEX_SANDBOX), the forms of C1', /69[^.]*`CODEX_SANDBOX`/.test(runChain) && /`node -e`/.test(runChain), runChain.slice(0, 300));

// ---- the processes
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-run-sandbox-')));
const SHARED = path.join(W, 's'), WTR = path.join(W, 'r'), RUNS = path.join(SHARED, 'runs');
fs.mkdirSync(WTR, { recursive: true });
const CFG = path.join(W, 'cfg.json');
fs.writeFileSync(CFG, JSON.stringify({ repoDir: path.join(W, 'repo'), sharedDir: SHARED, worktreeRoot: WTR, guardCommand: 'true {wt}' }));
const TASKS = path.join(W, 'tasks.json');
fs.writeFileSync(TASKS, JSON.stringify([{ key: 'k1', title: 'K1', wt: 'w-k1', branch: 'b-k1', accept: 'acc', kind: 'tail', noAnalysis: 'a test task' }]));
// A fake ps that refuses (as inside the sandbox) and a PATH with no ps at all (a container without procps).
const NOPS = path.join(W, 'nops'), NODEONLY = path.join(W, 'nodeonly');
fs.mkdirSync(NOPS); fs.mkdirSync(NODEONLY);
fs.writeFileSync(path.join(NOPS, 'ps'), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
fs.symlinkSync(process.execPath, path.join(NODEONLY, 'node'));
const baseEnv = () => { const e = Object.assign({}, process.env); delete e.CODEX_SANDBOX; delete e.CODIS_AGENTS_CONFIG; return e; };
const envWith = (pathDir, sandbox) => Object.assign(baseEnv(), { PATH: pathDir === NODEONLY ? NODEONLY : `${pathDir}${path.delimiter}${process.env.PATH}` }, sandbox ? { CODEX_SANDBOX: sandbox } : {});
const cr = (args, env, timeout) => spawnSync(process.execPath, [CR].concat(args), { encoding: 'utf8', env: env || baseEnv(), timeout: timeout || 120000 });
const entries = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
const START = ['start', '--host', 'claude', '--bin', '/usr/bin/false', '--tasks', TASKS, '--config', CFG];

try {
  // C3, C7: no answer of ps - refused before any run folder, request.json or lock
  for (const [name, dir, sandbox] of [['C3 refusing ps, CODEX_SANDBOX=seatbelt', NOPS, 'seatbelt'], ['C7 refusing ps, no CODEX_SANDBOX', NOPS, null], ['C7 no ps in PATH, no CODEX_SANDBOX', NODEONLY, null]]) {
    const before = entries(RUNS);
    const p = cr(START, envWith(dir, sandbox));
    const after = entries(RUNS);
    ok(`${name}: start exits 69`, p.status === 69, `${p.status} ${p.stdout}${p.stderr}`);
    ok(`${name}: no run folder, no request.json, no lock`, JSON.stringify(before) === JSON.stringify(after) && !entries(path.join(RUNS, '.locks')).length, `${J(before)} -> ${J(after)}`);
    ok(`${name}: stderr names ps -o lstart and the plain argv node <plugin>/scripts/chain-run.js start`, /ps -o lstart/.test(p.stderr) && p.stderr.includes(`node ${CR} start`), p.stderr);
    ok(`${name}: CODEX_SANDBOX named only when set`, sandbox ? p.stderr.includes(`CODEX_SANDBOX=${sandbox}`) : !/CODEX_SANDBOX/.test(p.stderr), p.stderr);
  }

  // C4: ps answers - the start as before (the role binary is /usr/bin/false: no model is called)
  const p4 = cr(START, baseEnv());
  let j4 = null; try { j4 = JSON.parse(p4.stdout); } catch { /* below */ }
  ok('C4 ps answers: start exits 0 with {runId, runDir, pid}', p4.status === 0 && !!j4 && !!j4.runDir, `${p4.status} ${p4.stdout}${p4.stderr}`);
  if (j4) {
    const st = cr(['status', j4.runDir, '--wait', '100'], baseEnv(), 130000);
    ok('C4 ... the run ends (status exits 0 or 4)', st.status === 0 || st.status === 4, `${st.status} ${st.stdout.slice(0, 400)}`);
  }

  // C5: the conductor itself cannot read its own start time: the block names the sandbox and the plain argv
  if (j4) {
    const req = JSON.parse(fs.readFileSync(path.join(j4.runDir, 'request.json'), 'utf8'));
    const id5 = '20991231T000000Z-c5c5c5';
    const d5 = path.join(RUNS, id5);
    fs.mkdirSync(d5);
    fs.writeFileSync(path.join(d5, 'request.json'), JSON.stringify(Object.assign({}, req, { runId: id5 })));
    const p5 = spawnSync(process.execPath, [CR, 'run', d5], { encoding: 'utf8', env: envWith(NOPS, 'seatbelt'), timeout: 120000 });
    let log = ''; try { log = fs.readFileSync(path.join(d5, 'log.txt'), 'utf8'); } catch { /* none */ }
    const line = log.split('\n').find((l) => /stopped before any role/.test(l)) || '';
    ok('C5 the conductor without its start time: the task stops before any role naming ps -o lstart, CODEX_SANDBOX=seatbelt and the plain argv',
      /ps -o lstart/.test(line) && /CODEX_SANDBOX=seatbelt/.test(line) && /plain argv/.test(line), `${p5.status} ${log.slice(-1200)} ${p5.stderr.slice(-400)}`);
  }

  // C6: status of a live conductor while ps does not answer
  {
    const id6 = '20991231T000000Z-c6c6c6';
    const d6 = path.join(RUNS, id6);
    fs.mkdirSync(d6);
    fs.writeFileSync(path.join(d6, 'request.json'), JSON.stringify({ runId: id6, host: 'codex', args: { tasks: [] } }));
    fs.writeFileSync(path.join(d6, 'run.json'), JSON.stringify({ runId: id6, pid: process.pid, lstart: 'Mon Nov  9 10:00:00 2026' }));
    for (const sandbox of ['seatbelt', null]) {
      const p = cr(['status', d6], envWith(NOPS, sandbox));
      let j = null; try { j = JSON.parse(p.stdout); } catch { /* below */ }
      ok(`C6 status, ps refused${sandbox ? ', CODEX_SANDBOX set' : ''}: running (exit 3), as before`, p.status === 3 && j && j.state === 'running', `${p.status} ${p.stdout}${p.stderr}`);
      ok(`C6 ... a field why names "ps does not answer"${sandbox ? ' and CODEX_SANDBOX=seatbelt' : ', no CODEX_SANDBOX'}`,
        !!j && typeof j.why === 'string' && /ps does not answer/.test(j.why) && (sandbox ? j.why.includes('CODEX_SANDBOX=seatbelt') : !/CODEX_SANDBOX/.test(j.why)), J(j));
    }
    const p = cr(['status', d6], baseEnv());
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* below */ }
    ok('C6 status with ps answering: no field why (a running or dead conductor told by its start time)', !!j && j.why === undefined, J(j));
    fs.rmSync(d6, { recursive: true, force: true });
  }

  // B6: status <key>
  {
    const mk = (id, keys) => { const d = path.join(RUNS, id); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'request.json'), JSON.stringify({ runId: id, host: 'codex', args: { tasks: keys.map((key) => ({ key })) } })); };
    mk('20990101T000000Z-aaaaaa', ['kx']);
    mk('20990102T000000Z-bbbbbb', ['ky', 'kx']);
    mk('20990103T000000Z-cccccc', ['kz']);
    const p = cr(['status', 'kx', '--config', CFG]);
    const m = /runs of task kx[^:]*: ([^\n;]*)/.exec(p.stderr);
    ok('B6 status <key>: exit 64', p.status === 64, `${p.status} ${p.stderr}`);
    ok('B6 status <key>: lists the runs whose request names the key, newest first, and no other', !!m && m[1].split(/,\s*/).join(',') === '20990102T000000Z-bbbbbb,20990101T000000Z-aaaaaa', p.stderr);
    ok('B6 status <key>: names the brief <sharedDir>/<key>/BRIEF.md and its run: line', p.stderr.includes(path.join(SHARED, 'kx', 'BRIEF.md')) && /run:/.test(p.stderr), p.stderr);
    const q = cr(['status', 'nokey', '--config', CFG]);
    ok('B6 status of a name that is neither a run nor a task key: exit 64 with the list of all runs, as before',
      q.status === 64 && /no run nokey in /.test(q.stderr) && /runs: [^\n]*20990103T000000Z-cccccc/.test(q.stderr) && !/runs of task/.test(q.stderr), q.stderr);
  }
} finally {
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- S: the refusal of a slot inside the codex sandbox
if (!has('zsh')) skip('S the refusal of a slot inside the codex sandbox', 'zsh not found');
else {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slot-sandbox-')));
  try {
    const ro = path.join(T, 'ro');
    fs.mkdirSync(ro, { mode: 0o555 });
    fs.chmodSync(ro, 0o555);
    fs.writeFileSync(path.join(T, 'file'), '');
    const env = (dir, sandbox) => {
      const e = baseEnv();
      for (const k of Object.keys(e)) if (/^(SLOT_|GUARDS_)/.test(k)) delete e[k];
      return Object.assign(e, { SLOTS_DIR: dir, SLOT_LEGACY_LOCK: '', SLOT_MEDIUM_N: '1' }, sandbox ? { CODEX_SANDBOX: sandbox } : {});
    };
    let writable = false;
    try { fs.accessSync(ro, fs.constants.W_OK); writable = true; } catch { /* the usual case */ }
    const cases = [['a read-only slot directory', ro], ['a slot directory under a regular file', path.join(T, 'file', 'slots')]];
    for (const [what, dir] of cases) {
      if (dir === ro && writable) { skip(`S ${what}`, 'this user writes a read-only folder (root)'); continue; }
      for (const sandbox of ['seatbelt', null]) {
        const p = spawnSync(path.join(ROOT, 'scripts', 'medium.sh'), ['touch', path.join(T, 'ran')], { encoding: 'utf8', env: env(dir, sandbox), timeout: 30000 });
        const lines = p.stderr.split('\n').filter(Boolean);
        ok(`S ${what}${sandbox ? ', CODEX_SANDBOX set' : ''}: exit 77, one line, the command did not run`, p.status === 77 && lines.length === 1 && !fs.existsSync(path.join(T, 'ran')), `${p.status} ${p.stderr}`);
        ok(`S ${what}${sandbox ? ', CODEX_SANDBOX set: the line says the role sandbox does not include the slot directory and heavy steps wait for A2b' : ': no word of the role sandbox'}`,
          sandbox ? /CODEX_SANDBOX=seatbelt/.test(p.stderr) && /the role sandbox does not include the slot directory/.test(p.stderr) && /heavy steps on codex wait for A2b/.test(p.stderr)
            : !/CODEX_SANDBOX|role sandbox/.test(p.stderr), p.stderr);
      }
    }
  } finally {
    try { fs.chmodSync(path.join(T, 'ro'), 0o755); } catch { /* none */ }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
done();
