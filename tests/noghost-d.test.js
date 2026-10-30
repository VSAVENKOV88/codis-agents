#!/usr/bin/env node
'use strict';
// p-noghost-d: the integration train gets a full sha (cells F1-F5 of the analysis p-noghost, coordinator's decision 4 of
// 2026-10-31). Case 2026-10-30: the workflow passed the head of the review "3fb1d6dd" to train.js ride, train.js exited
// 64 with its usage line, and the task stopped as the environment.
//   F1  a full head (40 hex digits) - as before: no extra step, the train gets it as it is.
//   F2  an abbreviated head (gitrevisions(7): a leading hex substring of the object name, at least 4 digits) - the
//       workflow resolves it right after the role's answer with `git -C <wt> rev-parse --verify -q '<h>^{commit}'`
//       (one cheap service step), so the post-checks, the selection, the result path and the ride all get the full sha.
//   F3  a head that does not resolve (unknown, ambiguous, empty, not hex) - kept as the role gave it (never replaced by
//       an empty string), and train.js refuses it with "head is not a full sha: <value>", exit 64.
//   F4  train.js enqueue / ride / await called directly with a short head - the same refusal, nothing queued.
//   F5  resultOf(t, head) and the comparison st.selAt === st.head, and "the fix round committed nothing", use the full sha.
// usage: node tests/noghost-d.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { done } = lib;
const ok = (n, c, d) => lib.ok(n, c, d === undefined ? d : String(d).slice(0, 600));

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const SRC = read('workflows/role-chain.js').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json',
  guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const L = Object.assign({}, T, { mode: 'light' });
const FULL = '3fb1d6dd' + '0123456789abcdef0123456789abcdef';
const FULL2 = 'c0ffee00' + 'fedcba9876543210fedcba9876543210';
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const prog = (head) => ({ status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head, mutations: 'm', fullRun: 'r', questions: [], summary: 's' });
const D = { verdict: 'done', docsOnly: false, summary: 'fine' };
const REJD = { verdict: 'rejected', docsOnly: true, summary: 'docs' };
const OKR = { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
const ride = (rc) => ({ done: true, rc, seconds: 5, log: '/d/wait-train.log', tail: '' });
const unq = (s) => s.split("'\\''").join("'");

// resolve: {abbrev: full | null} - what `git rev-parse` would print; a missing key or null - it fails (no sha).
// lie: an answer the service agent gives regardless of the command (a wrong sha), to see it is not taken.
async function run(script, task, resolve = {}, lie) {
  const trace = [], full = [], prompts = [];
  const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    prompts.push({ role, label: opts.label, prompt, opts });
    full.push(['diff', 'left', 'post', 'run', 'sha'].includes(role) ? opts.label : role);
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'sha') {
      if (lie) return { sha: lie };
      const m = /rev-parse --verify -q '([^']*)\^\{commit\}'/.exec(unq(prompt));
      const v = m && resolve[m[1]];
      return v ? { sha: v } : { sha: '', error: `fatal: Needed a single revision (${m ? m[1] : 'no command'})` };
    }
    if (role === 'run') {
      if (/:train-/.test(opts.label)) {
        if (!q.train || !q.train.length) throw new Error('extra train step after ' + full.join('>'));
        return q.train.shift();
      }
      return OKR;
    }
    trace.push(role);
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role + ' after ' + trace.join('>'));
    return q[role].shift();
  };
  const pipeline = async (items, fn) => Promise.all(items.map((it) => fn(it)));
  let res;
  try {
    res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, pipeline, null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [task] });
  } catch (e) { res = [{ status: 'crashed', why: e.message }]; }
  return { r: res[0], trace: trace.join('>'), full: full.join('>'), prompts };
}
const steps = (x, re) => x.prompts.filter((p) => re.test(p.label));
const rideHead = (x, i = 0) => { const m = /--head '([^']*)'/.exec(unq((steps(x, /^run:x:train-/)[i] || { prompt: '' }).prompt)); return m ? m[1] : null; };

(async () => {
  // ---- F1: a full head - no service step, the train gets it as it is ----
  let x = await run({ pre: [PRE], prog: [prog(FULL)], review: [D], train: [ride(0)] }, L);
  ok('F1. light, full head from the programmer -> no sha step, ride --head <full>, result path by it',
    x.r.status === 'done' && !steps(x, /^sha:/).length && rideHead(x) === FULL && x.r.train && x.r.train.result === `/s/train/result/x-${FULL}.json`, `${x.full} ${JSON.stringify(x.r)}`);

  // ---- F2: an abbreviated head of the programmer (light) is resolved before the selection and the ride ----
  x = await run({ pre: [PRE], prog: [prog('3fb1d6dd')], review: [D], train: [ride(0)] }, L, { '3fb1d6dd': FULL });
  const sp = unq((steps(x, /^sha:/)[0] || { prompt: '' }).prompt);
  ok('F2. light, short head "3fb1d6dd" -> one sha step right after the programmer, before its selection',
    x.r.status === 'done' && /^pre>prog>sha:x:[^>]*>run:x:select-1>/.test(x.full), x.full);
  ok('F2. the sha step runs git -C <wt> rev-parse --verify -q \'<h>^{commit}\'', sp.includes("git -C '/w' rev-parse --verify -q '3fb1d6dd^{commit}'"), sp);
  ok('F2. the sha step is a cheap service step (haiku, low effort)', (steps(x, /^sha:/)[0] || {}).opts && steps(x, /^sha:/)[0].opts.model === 'haiku' && steps(x, /^sha:/)[0].opts.effort === 'low',
    JSON.stringify((steps(x, /^sha:/)[0] || {}).opts));
  ok('F2. ride gets the full sha, and the result path is by the full sha',
    rideHead(x) === FULL && x.r.train && x.r.train.result === `/s/train/result/x-${FULL}.json`, `${rideHead(x)} ${JSON.stringify(x.r.train)}`);
  ok('F2. the reviewer post-check starts from the full sha', unq((steps(x, /^diff:x:reviewer/)[0] || { prompt: '' }).prompt).includes(`--since ${FULL}`),
    (steps(x, /^diff:x:reviewer/)[0] || { prompt: '' }).prompt);
  // uppercase hex is an abbreviation too (git takes hex digits in either case); the train takes lowercase only
  x = await run({ pre: [PRE], prog: [prog('3FB1D6DD')], review: [D], train: [ride(0)] }, L, { '3FB1D6DD': FULL });
  ok('F2. uppercase "3FB1D6DD" -> resolved, ride gets the lowercase full sha', rideHead(x) === FULL, `${rideHead(x)} ${x.full}`);

  // ---- F2 (full mode): the tester's short head is resolved too (st.head after the tester) ----
  const TST = { verdict: 'green', summary: '', head: 'c0ffee00' };
  x = await run({ pre: [PRE], prog: [prog(FULL)], test: [TST], review: [D], train: [ride(0)] }, T, { c0ffee00: FULL2 });
  ok('F2. full mode, the tester\'s short head "c0ffee00" -> resolved after its post-check, ride gets the full sha',
    x.r.status === 'done' && steps(x, /^sha:/).length === 1 && rideHead(x) === FULL2, `${x.full} ${rideHead(x)}`);
  ok('F2. the tester\'s post-check still starts from the programmer\'s head', unq((steps(x, /^post:x:tester/)[0] || { prompt: '' }).prompt).includes(`--since ${FULL}`),
    (steps(x, /^post:x:tester/)[0] || { prompt: '' }).prompt);

  // ---- F3: a head that does not resolve is kept as given, never emptied; train.js refuses it ----
  x = await run({ pre: [PRE], prog: [prog('3fb1d6dd')], review: [D], train: [ride(64)] }, L, {});
  ok('F3. unresolved short head -> the sha step is repeated once (retry), then the role\'s value is kept: ride --head 3fb1d6dd',
    steps(x, /^sha:/).length === 2 && /#retry$/.test(steps(x, /^sha:/)[1].label) && rideHead(x) === '3fb1d6dd', `${x.full} ${rideHead(x)}`);
  ok('F3. ... and the train\'s exit 64 stops the task naming the head (not as the environment)',
    x.r.status === 'stopped' && /exit 64/.test(x.r.why || '') && (x.r.why || '').includes('3fb1d6dd') && !x.r.environment, JSON.stringify(x.r));
  // a service agent that answers with a sha that is not of this abbreviation is not believed
  x = await run({ pre: [PRE], prog: [prog('3fb1d6dd')], review: [D], train: [ride(64)] }, L, {}, FULL2);
  ok('F3. a sha step answering a sha that does not start with the abbreviation -> not taken, the role\'s value kept',
    rideHead(x) === '3fb1d6dd', `${x.full} ${rideHead(x)}`);
  x = await run({ pre: [PRE], prog: [prog('3fb1d6dd')], review: [D], train: [ride(64)] }, L, {}, 'not-a-sha');
  ok('F3. a sha step answering garbage -> not taken', rideHead(x) === '3fb1d6dd', `${x.full} ${rideHead(x)}`);
  // not hex at all (a ref name, a word) or too short to be an abbreviation: no sha step, kept for train.js to refuse
  for (const h of ['HEAD', 'abc', '']) {
    x = await run({ pre: [PRE], prog: [prog(h)], review: [D], train: [ride(64)] }, L, { HEAD: FULL, abc: FULL });
    ok(`F3. head ${JSON.stringify(h)} is not an abbreviated object name -> no sha step, ride gets it unchanged`,
      !steps(x, /^sha:/).length && rideHead(x) === h, `${x.full} ${rideHead(x)}`);
  }

  // ---- F5: selAt and "committed nothing" compare full shas ----
  // light: review 1 rejects for docs, the programmer round commits nothing and reports the same commit abbreviated:
  // the selection on that commit is done - not repeated
  x = await run({ pre: [PRE], prog: [prog(FULL), prog('3fb1d6dd')], review: [REJD, D], train: [ride(0)] }, L, { '3fb1d6dd': FULL });
  ok('F5. the same commit reported short after a docs rejection -> the selection on it is not repeated (selAt === full head)',
    x.r.status === 'done' && steps(x, /^run:x:select-/).length === 1 && rideHead(x) === FULL, x.full);
  // train fix round: the programmer reports the same commit short -> "committed nothing", stopped for the coordinator
  x = await run({ pre: [PRE], prog: [prog(FULL), prog('3fb1d6dd')], review: [D], train: [ride(11)] }, L, { '3fb1d6dd': FULL });
  ok('F5. a train fix round reporting the same commit short -> "committed nothing", stopped, no selection, no second ride',
    x.r.status === 'stopped' && /committed nothing/.test(x.r.why || '') && steps(x, /^run:x:train-/).length === 1 && !steps(x, /^run:x:select-t1/).length,
    `${x.full} ${JSON.stringify(x.r)}`);

  // ---- F3/F4: train.js itself refuses a head that is not a full sha, with that text, nothing queued ----
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noghost-d-')));
  const repo = path.join(W, 'repo'), shared = path.join(W, 'shared');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(shared, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  spawnSync('git', ['-C', repo, 'branch', 'arc']);
  const cfg = path.join(W, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: repo, worktreeRoot: path.join(W, 'wts'), sharedDir: shared, protectedBranches: ['main'],
    guardCommand: 'cd {wt} && true', guardRerun: { command: 'cd {wt} && true {name}', newRedPattern: '^FAILED (\\S+) ', tallyPattern: '^=== .* ===$' },
    worktreeSetup: { scan: [], skip: [], link: [] }, slots: { lockDir: path.join(W, 'slots') } }));
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfg, CODIS_TRAIN_POLL: '0.2' });
  const tr = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'train.js'), ...a], { cwd: W, encoding: 'utf8', env, timeout: 60000 });
  const queued = () => { try { return fs.readdirSync(path.join(shared, 'train', 'queue')).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  for (const cmd of ['enqueue', 'ride']) {
    for (const [h, shown] of [['3fb1d6dd', '3fb1d6dd'], ['', "''"], ['XYZ', 'XYZ']]) {
      const r = tr(cmd, '--task', 't', '--branch', 'b', '--head', h, '--base', 'arc');
      ok(`F4. train.js ${cmd} --head ${JSON.stringify(h)} -> exit 64 "head is not a full sha: ${shown}", nothing queued`,
        r.status === 64 && r.stderr.includes(`head is not a full sha: ${shown}`) && !queued(), `${r.status} ${r.stderr}`);
    }
    const r = tr(cmd, '--task', 't', '--branch', 'b', '--base', 'arc');
    ok(`F4. train.js ${cmd} without --head -> exit 64 "head is not a full sha: (none)"`, r.status === 64 && r.stderr.includes('head is not a full sha: (none)'), `${r.status} ${r.stderr}`);
  }
  const ra = tr('await', '--task', 't', '--head', '3fb1d6dd');
  ok('F4. train.js await --head 3fb1d6dd -> exit 64 "head is not a full sha: 3fb1d6dd"', ra.status === 64 && ra.stderr.includes('head is not a full sha: 3fb1d6dd'), `${ra.status} ${ra.stderr}`);
  const rt = tr('enqueue', '--task', 'bad task', '--branch', 'b', '--head', FULL, '--base', 'arc');
  ok('F4. a full head with another bad argument -> exit 64 with the usage, not the sha text', rt.status === 64 && !/head is not a full sha/.test(rt.stderr) && /usage/.test(rt.stderr), `${rt.status} ${rt.stderr}`);
  fs.rmSync(W, { recursive: true, force: true });
  done();
})();
