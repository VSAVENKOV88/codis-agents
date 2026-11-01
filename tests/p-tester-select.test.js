#!/usr/bin/env node
'use strict';
// p-tester-select: the tester's selection covers only its own diff. With guardSubsetCommand the workflow runs the
// selection of the task's guards (guards-all.sh --select <base>) after every programmer round; the tester changes only
// guards and their fixtures (testerWritable, the git post-check), and the product code under that selection is the
// same, so after its own commits the tester runs the selection of its diff from the programmer's HEAD
// (guards-all.sh --select <programmer HEAD>): its new or changed guards, the guards that import or name a file it
// changed (a fixture of a product guard outside its diff), the project's guardAlways. No commit of the tester - no
// selection of its own: the workflow's log is the evidence. Measured (diagnosis of 2026-11-01): the repeated selection
// of the tester took a median of 17.9 min of a task's path and the runner from 58 % to 85 % of its capacity.
//   Part A - workflows/role-chain.js with fake agents: the tester's prompt names the programmer's HEAD of its round,
//     never the task's base, for its own selection; a tester round after a programmer fix names the new HEAD; without
//     guardSubsetCommand and in the light mode nothing changes.
//   Part B - scripts/guards-select.js with --base <programmer HEAD> on a temporary repository: the cells of the sources
//     (a fixture imported or named by a product guard outside the tester's diff, a new tester guard, guardAlways; the
//     product guards of the programmer's diff are not selected again).
//   Part C - the rule role:onerun, the README and agents/tester.md say the same.
// usage: node tests/p-tester-select.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const ONE = Object.assign({}, CFG, { guardSubsetCommand: 'npm run guards -- {onlyArgs}', guardAlways: ['semgrep-diff'] });
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PH = 'a'.repeat(40), P2H = 'b'.repeat(40), TH = 'c'.repeat(40);
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: PH, mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const P2 = Object.assign({}, PROG, { head: P2H });
const GREEN = { verdict: 'green', summary: '', head: TH };
const RED = { verdict: 'red', summary: 'r', head: TH };
const D = { verdict: 'done', docsOnly: false, summary: '' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const REDR = { done: true, rc: 1, seconds: 1, log: '/d/wait-select-1.log', tail: 'FAILED g/b-run.js' };

async function run(script, task = T, config = ONE) {
  const trace = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt });
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') return q.run && q.run.length ? q.run.shift() : OKR;
    if (role === 'sha') return { sha: '' };
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    return q[role].shift();
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, pipeline, null, () => {}, () => {}, { owner: 'o', config, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), prompts };
}
const prompts = (x, role) => x.prompts.filter((p) => p.role === role).map((p) => p.prompt);
// the tester's own instructions on guards: step 4 of its prompt (the rules before it describe the workflow's selection)
const step4 = (p) => (p.match(/\n4\. [^\n]*/) || [''])[0];

async function partA() {
  // A1: the tester's own selection is from the programmer's HEAD, not from the task's base
  let x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });
  let s = step4(prompts(x, 'test')[0] || '');
  ok('A1. the tester runs the selection of its own diff: guards-all.sh --select <the programmer\'s HEAD> on its worktree',
    x.r.status === 'done' && s.includes(`/p/scripts/guards-all.sh --select '${PH}' 'w'`), s);
  ok('A1. not the selection of the whole task from its base again', !s.includes("--select 'arc'") && !/the same selection|the selection again/.test(s), s);
  ok('A1. in the background (run_in_background)', /run_in_background/.test(s), s);
  // A2: no commit of the tester - no selection of its own; the workflow's log is the evidence
  ok('A2. no commit of the tester -> no selection of its own, it reuses the log of the workflow',
    /no commit[^.]*no selection of your own/i.test(s) && /reuse its log/.test(s), s);
  // A3: what the tester's selection holds - its guards, the guards importing or naming a file it changed, guardAlways
  ok('A3. the tester is told what its selection holds: its guards, guards that import or name a file it changed (a fixture), guardAlways',
    /guards that import or name a file you changed/.test(s) && /fixture/.test(s) && /guardAlways/.test(s), s);
  // A4: a tester round after a programmer fix (red tester -> programmer P2): the second tester names P2
  x = await run({ pre: [PRE], prog: [PROG, P2], test: [RED, GREEN], review: [D] });
  const t2 = prompts(x, 'test');
  ok('A4. red tester -> programmer with a new HEAD -> the second tester selects from that HEAD',
    x.r.status === 'done' && t2.length === 2 && step4(t2[0]).includes(`--select '${PH}' 'w'`) && step4(t2[1]).includes(`--select '${P2H}' 'w'`) && !step4(t2[1]).includes(`--select '${PH}'`),
    t2.map(step4).join(' || '));
  // A5: a red selection of the workflow -> programmer fix P2 -> the tester selects from P2
  x = await run({ pre: [PRE], prog: [PROG, P2], run: [REDR, OKR], test: [GREEN], review: [D] });
  s = step4(prompts(x, 'test')[0] || '');
  ok('A5. after a programmer round of a red selection the tester selects from the programmer\'s new HEAD',
    x.r.status === 'done' && s.includes(`--select '${P2H}' 'w'`), s);
  // A6: the workflow's own selection still runs from the task's base (not touched)
  const step = x.prompts.find((p) => p.role === 'run' && /select-1/.test(p.label));
  ok('A6. the workflow\'s selection step still runs guards-all.sh --select <base>',
    !!step && step.prompt.split("'\\''").join("'").includes("/p/scripts/guards-all.sh --select 'arc' 'w'"), step && step.prompt);
  // A7: the rule in every role prompt (RULE_LIST onerun) speaks of the tester's own diff, not "the same selection"
  const tp = prompts(x, 'test')[0] || '';
  ok('A7. the onerun rule in the prompt: the tester runs the selection of its own diff from the programmer\'s HEAD',
    /The tester, after its own commits, runs the selection of its own diff/.test(tp) && !/and the same selection/.test(tp), tp.slice(tp.indexOf('No full guard run'), tp.indexOf('No full guard run') + 900));
  // A8: without guardSubsetCommand nothing changes: the tester reuses the programmer's full run
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, T, CFG);
  s = step4(prompts(x, 'test')[0] || '');
  ok('A8. without guardSubsetCommand: the tester step is unchanged (reuse the programmer\'s full run, no --select)',
    /Do not repeat the programmer's full run/.test(s) && !/--select/.test(s), s);
  // A9: the light mode has no tester: no tester prompt, the programmer-checker is not told of a tester selection
  x = await run({ pre: [PRE], prog: [PROG], review: [D] }, Object.assign({}, T, { mode: 'light' }));
  const lp = prompts(x, 'prog')[0] || '';
  ok('A9. light mode: no tester round; the programmer-checker runs no selection of its own',
    x.r.status === 'done' && prompts(x, 'test').length === 0 && !/--select '[0-9a-f]{40}'/.test(lp), x.trace);
  // A10 (review 1): over the WHOLE prompt of every role, not only step 4 - the selection of the task from its base
  // (guards-all.sh --select <base>) is named only as the workflow's run, never as a command for the role (the rule
  // role:slots once named it as "the selection of guards" for every role, next to step 4 of the tester).
  const P3 = Object.assign({}, PROG, { head: 'd'.repeat(40) }), P4 = Object.assign({}, PROG, { head: 'e'.repeat(40) });
  x = await run({ pre: [PRE], prog: [PROG, P2, P3, P4], test: [RED, GREEN, GREEN], review: [{ verdict: 'rejected', docsOnly: false, summary: 'r' }, D], run: [REDR, OKR, OKR, OKR, OKR, OKR] });
  const BASE_SEL = "guards-all.sh --select 'arc'";
  const bad = [];
  for (const p of x.prompts.filter((q) => ['prog', 'test', 'review'].includes(q.role))) {
    for (let i = p.prompt.indexOf(BASE_SEL); i >= 0; i = p.prompt.indexOf(BASE_SEL, i + 1)) {
      const before = p.prompt.slice(Math.max(0, i - 160), i);
      if (!/the workflow (runs|ran)/.test(before)) bad.push(`${p.label}: ...${p.prompt.slice(Math.max(0, i - 160), i + 60)}`);
    }
  }
  const roles = new Set(x.prompts.map((q) => q.role));
  ok('A10. whole prompts of programmer, tester and reviewer: the base selection appears only as the workflow\'s run',
    roles.has('prog') && roles.has('test') && roles.has('review') && bad.length === 0, bad.join('\n') || x.trace);
  const slotsLine = (p) => (p.match(/Heavy work goes through memory slots:[^\n]*?rejoins the queue at the end\)\./) || [''])[0];
  const tsl = slotsLine(prompts(x, 'test')[0] || '');
  ok('A10. the slots rule in the tester prompt names no selection from the base and no other selection than step 4',
    tsl !== '' && !tsl.includes("--select 'arc'") && !/--select '[0-9a-f]{40}'/.test(tsl), tsl);
}

function partB() {
  const S = path.join(ROOT, 'scripts', 'guards-select.js');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-select-')));
  const repo = path.join(tmp, 'repo');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (f, c) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); };
  const cfgFile = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: repo, worktreeRoot: tmp, sharedDir: path.join(tmp, 's'), guardAlways: ['semgrep-diff'],
    guardRerun: { command: 'cd {wt} && run --only {name}', newRedPattern: '^X (\\S+) ', tallyPattern: '^TOTAL: (\\d+) total$' } }));
  const sel = (base) => {
    const r = spawnSync(process.execPath, [S, '--wt', repo, '--config', cfgFile, '--base', base, '--json'], { encoding: 'utf8' });
    try { return JSON.parse(r.stdout).guards.map((g) => g.path).sort(); } catch { return [`exit ${r.status}: ${r.stderr}`]; }
  };
  try {
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'noreply@example.com'); git('config', 'user.name', 't');
    put('src/model.js', 'module.exports = 1;\n');
    put('src/model-run.js', "require('./model');\n");
    put('tests/fixtures/cards.json', '[]\n');
    put('tests/cards-run.js', "require('./fixtures/cards.json');\n");
    put('tests/layout-run.js', "// reads the fixture by its name only\nconst f = fixture('layout');\n");
    put('tests/fixtures/layout.txt', 'a\n');
    put('tests/other-run.js', "console.log('other');\n");
    put('tests/semgrep-diff-run.js', '// scans the diff\n');
    git('add', '.'); git('commit', '-qm', 'arc');
    git('checkout', '-qb', 'task');
    // the programmer: product code and its guard
    put('src/model.js', 'module.exports = 2;\n');
    put('src/model-run.js', "require('./model'); // edited\n");
    git('add', 'src/model.js', 'src/model-run.js'); git('commit', '-qm', 'programmer');
    const progHead = git('rev-parse', 'HEAD').trim();
    // the tester: a fixture of a product guard outside its diff, a fixture named by another, its own new guard
    put('tests/fixtures/cards.json', '[1]\n');
    put('tests/fixtures/layout.txt', 'b\n');
    put('tests/model-tester-run.js', "require('../src/model');\n");
    git('add', 'tests/fixtures/cards.json', 'tests/fixtures/layout.txt', 'tests/model-tester-run.js'); git('commit', '-qm', 'tester');
    const fromProg = sel(progHead);
    ok('B1. from the programmer\'s HEAD: the guard importing a fixture the tester changed is selected (outside its diff)', fromProg.includes('tests/cards-run.js'), fromProg.join());
    ok('B2. from the programmer\'s HEAD: the guard naming a fixture the tester changed (by its name without the extension) is selected', fromProg.includes('tests/layout-run.js'), fromProg.join());
    ok('B3. from the programmer\'s HEAD: the tester\'s new guard and guardAlways are selected', fromProg.includes('tests/model-tester-run.js') && fromProg.includes('tests/semgrep-diff-run.js'), fromProg.join());
    ok('B4. from the programmer\'s HEAD: the programmer\'s product guard (already green in the workflow\'s selection) and unrelated guards are not selected',
      !fromProg.includes('src/model-run.js') && !fromProg.includes('tests/other-run.js'), fromProg.join());
    const fromBase = sel('main');
    ok('B5. for comparison, from the task\'s base the programmer\'s product guard is selected again', fromBase.includes('src/model-run.js'), fromBase.join());
    // no commit of the tester: its diff is empty, only guardAlways would run - the tester runs no selection of its own
    git('checkout', '-q', progHead);
    const none = sel(progHead);
    ok('B6. on the programmer\'s HEAD itself only guardAlways is selected (the tester without commits has nothing of its own to run)',
      none.join() === 'tests/semgrep-diff-run.js', none.join());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function partC() {
  const rules = read('rules/multi-agent.md');
  const line = (rules.match(/[^\n]*<!-- role:onerun -->/) || [''])[0];
  ok('C1. rules role:onerun: after its own commits the tester runs the selection of its own diff from the programmer\'s HEAD',
    /after its own commits, the selection of its own diff from the programmer's HEAD/.test(line) && !/after its own commits, the same selection/.test(line), line.slice(-900));
  ok('C1. rules role:onerun: no commit of the tester - no selection of its own', /no commit of the tester - no selection of its own/.test(line), line.slice(-900));
  const readme = read('README.md');
  ok('C2. README: the tester\'s selection is of its own diff (`guards-all.sh --select <programmer HEAD>`), not the same selection',
    (readme.match(/`guards-all\.sh --select <the programmer's HEAD>`/g) || []).length >= 2 && !/and the same selection\b/.test(readme) && !/the tester runs the same selection after its own commits/.test(readme));
  const tester = read('agents/tester.md');
  ok('C3. agents/tester.md: after your commits the selection of your own diff from the programmer\'s HEAD',
    /`guards-all\.sh --select <the programmer's HEAD>`/.test(tester) && !/the selection again, `guards-all\.sh --select <base>`/.test(tester), tester);
  ok('C4. the measurement is named in the rule: 17.9 min of the median, the runner 85 % -> 58 %', /17\.9 min[^\n]*85 %[^\n]*58 %/.test(rules));
}

(async () => {
  await partA();
  partB();
  partC();
  done();
})();
