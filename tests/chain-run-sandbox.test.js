#!/usr/bin/env node
'use strict';
// The run of a task found by its key, and a plain argv for the conductor on Codex (p-codex-D2b-2, cells B1-B6 and
// C1-C7 of the analysis of p-codex-D2b).
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
// The refusal of a slot inside the codex sandbox is case 13 of tests/slots-locks.test.sh (a hermetic slot test).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

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

  // ---- tester cells (p-codex-D2b-2, test.md): the codex host, an empty answer of ps, the order of the refusals, the
  // brief of a task with its own dir, damaged requests among the runs, an exact key, stop <key>, why of another cause.
  {
    const S2 = path.join(W, 's2'), R2 = path.join(S2, 'runs');
    const CFG2 = path.join(W, 'cfg2.json');
    fs.writeFileSync(CFG2, JSON.stringify({ repoDir: path.join(W, 'repo'), sharedDir: S2, worktreeRoot: WTR, guardCommand: 'true {wt}' }));
    const START2 = ['start', '--host', 'claude', '--bin', '/usr/bin/false', '--tasks', TASKS, '--config', CFG2];
    const BIN = path.join(__dirname, 'fixtures', 'chain-run', 'bin');

    // T1 C3 on the real host of the finding: start --host codex inside the sandbox refuses with 69 before any run folder
    const home = path.join(W, 'codex-home-t1');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'fake-hooks.json'), JSON.stringify({ trust: 'trusted' }));
    // the roles' TMPDIR apart from the state folder (a TMPDIR above sharedDir is refused earlier, exit 64)
    const RTMP = path.join(W, 'rtmp');
    fs.mkdirSync(RTMP);
    const t1 = cr(['start', '--host', 'codex', '--codex-home', home, '--tasks', TASKS, '--config', CFG2],
      Object.assign(baseEnv(), { PATH: `${NOPS}${path.delimiter}${BIN}${path.delimiter}${process.env.PATH}`, CODEX_SANDBOX: 'seatbelt', TMPDIR: RTMP }));
    ok('T1 C3 --host codex, ps refused, CODEX_SANDBOX=seatbelt: exit 69 naming CODEX_SANDBOX and the plain argv, no run folder',
      t1.status === 69 && t1.stderr.includes('CODEX_SANDBOX=seatbelt') && t1.stderr.includes(`node ${CR} start`) && !entries(R2).length, `${t1.status} ${t1.stdout}${t1.stderr} ${J(entries(R2))}`);

    // T2 C3: ps that exits 0 and prints nothing is no answer either
    const EMPTYPS = path.join(W, 'emptyps');
    fs.mkdirSync(EMPTYPS);
    fs.writeFileSync(path.join(EMPTYPS, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const t2 = cr(START2, envWith(EMPTYPS, null));
    ok('T2 C3 ps exits 0 with no start time: exit 69, no run folder, no CODEX_SANDBOX', t2.status === 69 && !entries(R2).length && !/CODEX_SANDBOX/.test(t2.stderr), `${t2.status} ${t2.stderr}`);

    // T3 the arguments are judged first: a usage error inside the sandbox stays 64, a config error 65
    const t3 = cr(['start', '--host', 'claude', '--tasks', path.join(W, 'none.json'), '--config', CFG2], envWith(NOPS, 'seatbelt'));
    ok('T3 start with a missing tasks file inside the sandbox: exit 64 (the arguments), not 69', t3.status === 64 && !/ps does not answer/.test(t3.stderr), `${t3.status} ${t3.stderr}`);
    const t3b = cr(['start', '--host', 'claude', '--tasks', TASKS, '--config', path.join(W, 'nocfg.json')], envWith(NOPS, 'seatbelt'));
    ok('T3 start with a missing config inside the sandbox: exit 65, not 69', t3b.status === 65, `${t3b.status} ${t3b.stderr}`);

    // B6 runs of the tester: a task with its own dir, a request with its own sharedDir, damaged requests, a near key
    const mk = (id, req) => { const d = path.join(R2, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'request.json'), typeof req === 'string' ? req : JSON.stringify(req)); };
    const OWN = path.join(W, 'own-dir');
    const OTHER = path.join(W, 'other-shared');
    mk('20990201T000000Z-111111', { runId: 'x', host: 'codex', args: { config: { sharedDir: OTHER, worktreeRoot: WTR }, tasks: [{ key: 'kd' }] } });
    mk('20990202T000000Z-222222', '{not json');
    mk('20990203T000000Z-333333', { runId: 'y', host: 'codex' });
    mk('20990204T000000Z-444444', { runId: 'z', host: 'codex', args: { tasks: [null, 'kd', { key: 'kd2' }] } });
    mk('20990205T000000Z-555555', { runId: 'w', host: 'codex', args: { config: { sharedDir: OTHER, worktreeRoot: WTR }, tasks: [{ key: 'kd', dir: OWN }] } });
    const b1 = cr(['status', 'kd', '--config', CFG2]);
    const m1 = /runs of task kd[^:]*: ([^\n;]*)/.exec(b1.stderr);
    ok('T4 B6 damaged requests among the runs: status <key> still exits 64 with the runs of the key only, newest first',
      b1.status === 64 && !!m1 && m1[1].split(/,\s*/).join(',') === '20990205T000000Z-555555,20990201T000000Z-111111', `${b1.status} ${b1.stderr}`);
    ok('T5 B6 the newest run names the task dir: the brief is <dir>/BRIEF.md', b1.stderr.includes(path.join(OWN, 'BRIEF.md')), b1.stderr);
    fs.rmSync(path.join(R2, '20990205T000000Z-555555'), { recursive: true, force: true });
    const b2 = cr(['status', 'kd', '--config', CFG2]);
    ok('T5 B6 a request with its own config and no dir: the brief is <sharedDir of that run>/<key>/BRIEF.md', b2.status === 64 && b2.stderr.includes(path.join(OTHER, 'kd', 'BRIEF.md')), b2.stderr);
    const b3 = cr(['status', 'k', '--config', CFG2]);
    ok('T6 B6 a key that only begins the keys of runs (k vs kd, kd2): no runs of task, the list of all runs as before', b3.status === 64 && !/runs of task/.test(b3.stderr) && /runs: /.test(b3.stderr), b3.stderr);
    const b4 = cr(['stop', 'kd', '--config', CFG2]);
    ok('T7 B6 stop <key>: exit 64 listing the runs of the key, no signal sent', b4.status === 64 && /runs of task kd/.test(b4.stderr), `${b4.status} ${b4.stderr}`);

    // T8 C6: a conductor unknown for another cause (pid lives, no start time recorded) - why names that cause, never the sandbox
    const id8 = '20990301T000000Z-888888';
    mk(id8, { runId: id8, host: 'codex', args: { tasks: [] } });
    fs.writeFileSync(path.join(R2, id8, 'run.json'), JSON.stringify({ runId: id8, pid: process.pid }));
    const t8 = cr(['status', path.join(R2, id8)], Object.assign(baseEnv(), { CODEX_SANDBOX: 'seatbelt' }));
    let j8 = null; try { j8 = JSON.parse(t8.stdout); } catch { /* below */ }
    ok('T8 C6 unknown for want of a recorded start time with CODEX_SANDBOX set: running (3), why names the start time, not the sandbox',
      t8.status === 3 && !!j8 && /no start time was recorded/.test(j8.why || '') && !/CODEX_SANDBOX/.test(j8.why || ''), `${t8.status} ${J(j8)}`);

    // T9 C1: bash -lc is named next to sh -c in both skills (X1 of the analysis)
    ok('T9 C1 bash -lc named in role-chain step 2 and coordinator homes', /`bash -lc`/.test(s2) && /`bash -lc`/.test(homes), '');
  }
} finally {
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* best effort */ }
}

done();
