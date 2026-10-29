#!/usr/bin/env node
'use strict';
// Task p-review (P3 + P2 of the plugin audit):
//   P3. With security: true the reviewer and the security reviewer run together (Promise.all) and one git post-check of
//       the reviewers runs after both, from the same HEAD; the verdicts are merged as before (a rejection by either ->
//       rejected); a change of the worktree by either stops the task; no result from either stops it.
//   P2. After the tester the git post-check and the leftovers post-check are one service agent: one command
//       (scripts/role-post-check.js), one JSON {ok, diff, left} with the fields of both scripts. checkTwice, the removed
//       list of the first attempt and the messages of diffFail / leftFail stay: a diff violation still stops the task,
//       leftovers are still removed and written into leftovers.md, the service agents per tester round go from 2 to 1.
//       The end of the task has one check only (leftovers), so it stays as it was.
//   S.  scripts/role-post-check.js runs both scripts and prints their JSON together (a real git repository).
//   R.  The rule: a marked line role:postcheck in rules/multi-agent.md, a RULE_LIST entry, README.
// usage: node tests/p-review.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, threatModel: 'ACCESS.md' };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'n' };
const TS = Object.assign({}, T, { security: true });
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
const GREEN = { verdict: 'green', summary: '' };
const D = { verdict: 'done', docsOnly: false, summary: 'ok' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'missing case' };
const DOK = { ok: true, offending: [] }, LOK = { ok: true, found: [], removed: [], remaining: [] };
const POST = (diff, left) => ({ ok: !!(diff && diff.ok && left && left.ok), diff, left });

// The reviewers wait for each other: a reviewer's answer comes only once both have started (or after 300 ms, so a
// sequential chain still finishes and the order shows it). events: start:<role> / end:<role>.
async function run(script, task = T) {
  const full = [], prompts = [], events = [], logs = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const started = new Set();
  let waiters = [];
  const both = () => new Promise((res) => {
    waiters.push(res);
    if (started.has('review') && started.has('sec')) { waiters.forEach((w) => w()); waiters = []; } else setTimeout(res, 300);
  });
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run'].includes(role) ? opts.label : role);
    if (role === 'diff') return q.diff && q.diff.length ? q.diff.shift() : DOK;
    if (role === 'left') return q.left && q.left.length ? q.left.shift() : LOK;
    if (role === 'post') return q.post && q.post.length ? q.post.shift() : POST(DOK, LOK);
    if (role === 'run') return { done: true, rc: 0, seconds: 1, log: '/d/wait.log', tail: 'ok' };
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role);
    const v = q[role].shift();
    if (role === 'review' || role === 'sec') {
      events.push('start:' + role); started.add(role);
      if (task.security) await both();
      events.push('end:' + role);
      started.delete(role);
    }
    return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
    agent, pipeline, null, (m) => logs.push(m), () => {}, { owner: 'o', config: CFG, tasks: [task] });
  return { r: res[0], full: full.join('>'), prompts, events, logs };
}
const of = (x, role) => x.prompts.filter((p) => p.role === role);

(async () => {
  let x;
  // --- P3: the reviewers in parallel, one post-check after both ---
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], sec: [D] }, TS);
  const firstEnd = x.events.findIndex((e) => e.startsWith('end:'));
  ok('P3-1. security: the reviewer and the security reviewer both start before either finishes',
    firstEnd === 2 && x.events.slice(0, 2).sort().join() === 'start:review,start:sec', x.events.join(' '));
  ok('P3-2. security: one reviewer post-check after both, from the tester HEAD; done',
    x.r.status === 'done' && /review>sec>diff:x:reviewer>left:x:end$/.test(x.full) && of(x, 'diff').length === 1 && / --since T --role reviewer/.test(of(x, 'diff')[0].prompt), x.full);
  ok('P3-2. the merged verdict names both summaries', x.r.status === 'done', JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [GREEN, GREEN], review: [REJ, D], sec: [D, D] }, TS);
  ok('P3-3. the reviewer rejects while the security reviewer is done -> rejected: a fix round, the tester, a second review of both',
    x.r.status === 'done' && of(x, 'prog').length === 2 && of(x, 'review').length === 2 && of(x, 'sec').length === 2, x.full);
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [GREEN, GREEN], review: [D, D], sec: [REJ, D] }, TS);
  ok('P3-3. the security reviewer rejects while the reviewer is done -> rejected: a fix round', x.r.status === 'done' && of(x, 'prog').length === 2, x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], sec: [D], diff: [{ ok: false, offending: ['src/z.ts'] }, { ok: false, offending: ['src/z.ts'] }] }, TS);
  ok('P3-4. a worktree change by either reviewer -> stopped with the file, names both reviewers',
    x.r.status === 'stopped' && /src\/z\.ts/.test(x.r.why) && /reviewer or the security reviewer/.test(x.r.why) && of(x, 'diff').length === 2, JSON.stringify(x.r) + ' ' + x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], sec: [null] }, TS);
  ok('P3-5. no result from the security reviewer -> stopped', x.r.status === 'stopped' && /security reviewer returned no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [null], sec: [D] }, TS);
  ok('P3-5. no result from the reviewer -> stopped', x.r.status === 'stopped' && /^the reviewer returned no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] });
  ok('P3-6. without security: review, its post-check, as before', x.r.status === 'done' && /review>diff:x:reviewer>left:x:end$/.test(x.full) && !of(x, 'sec').length, x.full);
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], diff: [{ ok: false, offending: ['src/q.ts'] }, { ok: false, offending: ['src/q.ts'] }] });
  ok('P3-6. without security: a reviewer change stops with "the reviewer changed"', x.r.status === 'stopped' && /^the reviewer changed[^,]*src\/q\.ts/.test(x.r.why), JSON.stringify(x.r));

  // --- P2: one service agent after the tester ---
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D] }, Object.assign({}, T, { stack: 'k-test' }));
  ok('P2-1. one service agent per tester round: post:x:tester, no diff:x:tester or left:x:tester',
    x.full === 'pre>prog>test>post:x:tester>review>diff:x:reviewer>left:x:end', x.full);
  const pp = of(x, 'post')[0] || { prompt: '', opts: { schema: { properties: {} } } };
  ok('P2-2. the combined command: role-post-check.js with the diff arguments (since, role, allow) and the leftovers ones (stack, owner stack, slots, --fix, log)',
    pp.prompt.includes('node /p/scripts/role-post-check.js --wt /w --since P --role tester') && pp.prompt.includes("--allow '-run\\.js$'")
      && pp.prompt.includes("--stack 'k-test'") && pp.prompt.includes("--owner-stack 'own'") && pp.prompt.includes("--slots-dir '/slots'")
      && pp.prompt.includes('--fix') && pp.prompt.includes("--log '/d/leftovers.md'"), pp.prompt);
  ok('P2-2. the leftovers context stays in the prompt (what --fix touches, the owner stack never)', /--fix touches only Docker resources labelled with this task's own compose project/.test(pp.prompt) && /never touched/.test(pp.prompt), pp.prompt);
  const sp = pp.opts.schema.properties;
  ok('P2-2. one schema with the fields of both: diff (ok, offending) and left (ok, found, removed, remaining)',
    sp.diff && sp.left && ['ok', 'offending'].every((k) => sp.diff.properties[k]) && ['ok', 'found', 'removed', 'remaining'].every((k) => sp.left.properties[k])
      && (pp.opts.schema.required || []).includes('diff') && (pp.opts.schema.required || []).includes('left'), JSON.stringify(pp.opts.schema));
  ok('P2-2. a cheap general-purpose agent, phase Tester', pp.opts.model === 'haiku' && pp.opts.agentType === 'general-purpose' && pp.opts.phase === 'Tester', JSON.stringify(pp.opts));
  const BAD = POST({ ok: false, offending: ['src/a.ts'] }, { ok: true, found: ['container c9'], removed: ['container c9'], remaining: [] });
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], post: [BAD, BAD] });
  ok('P2-3. a diff violation after the tester still stops the task, no review, the message of diffFail',
    x.r.status === 'stopped' && !of(x, 'review').length && /^the tester changed what the role may not: src\/a\.ts/.test(x.r.why), JSON.stringify(x.r));
  ok('P2-3. what the same check removed is still named in the result', JSON.stringify(x.r.leftovers || []).includes('tester: container c9'), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D], post: [POST(DOK, { ok: true, found: ['container c1'], removed: ['container c1'], remaining: [] })] });
  ok('P2-4. leftovers removed after the tester -> the chain goes on, the result names them', x.r.status === 'done' && JSON.stringify(x.r.leftovers || []).includes('tester: container c1'), JSON.stringify(x.r));
  const REM = POST(DOK, { ok: false, found: ['process 7'], removed: [], remaining: ['process 7'] });
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], post: [REM, REM] });
  ok('P2-5. leftovers that remain after the repeat -> stopped with the message of leftFail, no review',
    x.r.status === 'stopped' && !of(x, 'review').length && /^leftovers the chain could not remove \(tester\): process 7/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], review: [D],
    post: [POST({ ok: false, offending: [], error: 'not run' }, { ok: true, found: ['container c2'], removed: ['container c2'], remaining: [] }), POST(DOK, LOK)] });
  const rt = x.prompts.filter((p) => /#retry$/.test(p.label));
  ok('P2-6. a failed first attempt -> one repeat post:x:tester#retry, same command, default model, done',
    x.r.status === 'done' && x.full === 'pre>prog>test>post:x:tester>post:x:tester#retry>review>diff:x:reviewer>left:x:end'
      && rt.length === 1 && rt[0].opts.model === undefined && rt[0].prompt === of(x, 'post')[0].prompt, x.full);
  ok('P2-6. the removed list of the first attempt is kept', JSON.stringify(x.r.leftovers || []).includes('tester: container c2'), JSON.stringify(x.r));
  ok('P2-6. the repeat is logged', x.logs.some((m) => /X: .*post-check.*repeat/i.test(m)), x.logs.join(' | '));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], post: [null, null] });
  ok('P2-7. no result twice -> stopped "the tester post-check returned no result"', x.r.status === 'stopped' && /the tester post-check returned no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG], test: [GREEN], post: [{ ok: false, diff: DOK }, { ok: false, diff: DOK }] });
  ok('P2-7. diff ok, no leftovers part -> stopped "the leftovers post-check (tester) returned no result"', x.r.status === 'stopped' && /leftovers post-check \(tester\) returned no result/.test(x.r.why), JSON.stringify(x.r));
  x = await run({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'red', summary: '' }, GREEN], review: [D] });
  ok('P2-8. every tester round has one service agent', (x.full.match(/post:x:tester/g) || []).length === 2 && !/diff:x:tester|left:x:tester/.test(x.full), x.full);

  // --- S: the script ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p-review-'));
  const wt = path.join(tmp, 'wt'); fs.mkdirSync(wt);
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(wt, 'a.js'), '1\n'); git('add', 'a.js'); git('commit', '-qm', 'a');
  const since = git('rev-parse', 'HEAD').trim();
  const logf = path.join(tmp, 'leftovers.md');
  const post = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-post-check.js'), '--wt', wt, '--since', since, '--role', 'tester', '--allow', '-run\\.js$',
    '--slots-dir', path.join(tmp, 'slots'), '--fix', '--log', logf], { encoding: 'utf8' });
  let s = post(), j = null;
  try { j = JSON.parse(s.stdout); } catch { /* checked below */ }
  ok('S1. clean worktree -> exit 0, {ok:true, diff.ok, left.ok}', s.status === 0 && j && j.ok === true && j.diff && j.diff.ok === true && j.left && j.left.ok === true, s.stdout + s.stderr);
  fs.writeFileSync(path.join(wt, 'a.js'), '2\n');
  fs.rmSync(logf, { force: true });
  s = post(); j = null;
  try { j = JSON.parse(s.stdout); } catch { /* checked below */ }
  ok('S2. product file changed by the tester -> exit 1, diff.ok false with the path, left still ran',
    s.status === 1 && j && j.ok === false && j.diff.ok === false && (j.diff.offending || []).includes('a.js') && j.left && j.left.ok === true && Array.isArray(j.left.removed), s.stdout + s.stderr);
  ok('S3. the leftovers check really ran after the failed diff check: its own fields (wt, skipped) and leftovers.md written by this run',
    !!(j && j.left && j.left.wt && Array.isArray(j.left.skipped)) && fs.existsSync(logf), logf + ' ' + s.stdout);
  s = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'role-post-check.js'), '--wt', wt, '--since', since, '--role', 'tester'], { encoding: 'utf8' });
  j = null; try { j = JSON.parse(s.stdout); } catch { /* checked below */ }
  ok('S4. the diff script\'s own refusal (no --allow) comes through as diff.ok false with its error', s.status === 1 && j && j.diff.ok === false && /no testerWritable/.test(j.diff.error || ''), s.stdout + s.stderr);
  fs.rmSync(tmp, { recursive: true, force: true });

  // --- R: the rule ---
  const rules = fs.readFileSync(path.join(ROOT, 'rules', 'multi-agent.md'), 'utf8');
  const line = rules.split('\n').find((l) => /<!-- role:postcheck -->/.test(l)) || '';
  ok('R1. rules/multi-agent.md: a marked line role:postcheck - the reviewers together, one post-check after both; one post-check agent after the tester',
    /security reviewer[^.]*(at the same time|together)/.test(line) && /one git post-check after both/.test(line) && /role-post-check\.js/.test(line), line);
  const ruleList = await new AsyncFunction('args', SRC.slice(0, SRC.indexOf('const PRE_SCHEMA')) + '\nreturn RULE_LIST(TASKS[0])')({ owner: 'o', config: CFG, tasks: [T] });
  ok('R2. RULE_LIST carries postcheck', ruleList.some((r) => r[0] === 'postcheck'), ruleList.map((r) => r[0]).join());
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  ok('R3. README: role-post-check.js and the reviewers in parallel', /role-post-check\.js/.test(readme) && /security reviewer[^.]*(at the same time|together|in parallel)/.test(readme), '');
  done();
})().catch((e) => { console.log('  FAIL crashed: ' + e.stack); process.exit(1); });
