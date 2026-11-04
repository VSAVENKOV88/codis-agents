#!/usr/bin/env node
'use strict';
// p-verdict-orphan-a, review 1 fix round, the tester's cells (not in the programmer's T16/T23):
//   R1 the lock line of status from owner.json as it lies (no train runs): by 'watch' with a dead holder ->
//      "by watch pid N (dead)"; owner.json of 0.4.21 (no by) -> the line of 0.4.21 exactly; another value of by -> no
//      "watch"; status changes nothing in the train folder
//   R2 the stop of a train step that could not run / returned no result: ack names the task key and the head after
//      the review (not the branch), the branch and head are named, the stop is not the environment of the product
//      (no train verdict); 78: environment, nothing queued, no ack
// usage: node tests/p-verdict-orphan-r1-tester.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const TRAIN = path.join(ROOT, 'scripts', 'train.js');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-orphan-r1-')));
const shared = path.join(T, 'shared');
const TD = path.join(shared, 'train');
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
fs.mkdirSync(path.join(T, 'main'), { recursive: true });
const cfgFile = path.join(T, 'cfg.json');
fs.writeFileSync(cfgFile, JSON.stringify({ repoDir: path.join(T, 'main'), worktreeRoot: path.join(T, 'wts'), sharedDir: shared,
  guardCommand: 'cd {wt} && true', slots: { lockDir: path.join(T, 'slots'), legacyLock: path.join(T, 'guards.lock') } }));
const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfgFile, LANG: 'ru_RU.UTF-8' });
for (const k of ['LC_ALL', 'CLAUDE_PROJECT_DIR']) delete env[k];
const DEAD = 999999;
const SINCE = '2026-11-04T10:00:00.000Z';
const lockLine = () => {
  const r = spawnSync(process.execPath, [TRAIN, 'status'], { cwd: T, encoding: 'utf8', env, timeout: 60000 });
  return r.status === 0 ? (r.stdout.split('\n').find((l) => l.startsWith('lock:')) || '') : `exit ${r.status} ${r.stderr}`;
};
const owner = (o) => put(path.join(TD, 'lock', 'owner.json'), JSON.stringify(Object.assign({ pid: DEAD, host: os.hostname(), since: SINCE, train: 't1', base: 'arc' }, o)));
const snap = (d) => {
  const out = [];
  const walk = (x) => {
    let st; try { st = fs.lstatSync(x); } catch { return; }
    if (st.isDirectory()) { out.push(`D ${path.relative(d, x)} ${st.mtimeMs}`); for (const n of fs.readdirSync(x).sort()) walk(path.join(x, n)); }
    else out.push(`F ${path.relative(d, x)} ${st.mtimeMs} ${crypto.createHash('sha1').update(fs.readFileSync(x)).digest('hex')}`);
  };
  walk(d);
  return out.join('\n');
};

// ---- the workflow under a fake agent (as tests/train-chain.test.js) ----
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CFG = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
  protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {}, configPath: '/proj/.claude/codis-agents.json',
  guardSubsetCommand: 'npm run guards -- {onlyArgs}' };
const TASK = { key: 'kx', title: 'X', dir: '/d', wt: '/w', branch: 'bz', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'one-line fix', base: 'arc' };
const HEAD = 'a'.repeat(40);
const PRE = { ok: true, problems: [], blockingQuestions: [] };
const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
async function chain(train) {
  const q = { pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '', head: HEAD }], review: [{ verdict: 'done', docsOnly: false, summary: 'fine' }], train: train.slice() };
  const agent = async (prompt, opts) => {
    const role = opts.label.split(':')[0];
    if (role === 'diff') return { ok: true, offending: [] };
    if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
    if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
    if (role === 'run') {
      if (/:train-/.test(opts.label)) { if (!q.train.length) throw new Error('extra train step'); return q.train.shift(); }
      return { done: true, rc: 0, seconds: 1, log: '/d/wait-select-1.log', tail: 'all green' };
    }
    if (!q[role] || !q[role].length) throw new Error('extra call ' + role);
    return q[role].shift();
  };
  try {
    const res = await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
      agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: CFG, tasks: [TASK] });
    return res[0];
  } catch (e) { return { status: 'crashed', why: e.message }; }
}

(async () => {
  // ---- R1 ----
  owner({ by: 'watch' });
  const before = snap(TD);
  let l = lockLine();
  ok('R1 owner.json by watch, holder dead: "by watch pid N (dead)"', l === `lock: train t1 for arc arc by watch pid ${DEAD} (dead) since ${SINCE}`, l);
  ok('R1 status changes nothing in the train folder (a lock owner of watch in place)', snap(TD) === before, snap(TD));
  owner({});
  l = lockLine();
  ok('R1 owner.json of 0.4.21 (no by): the line of 0.4.21 exactly', l === `lock: train t1 for arc arc by pid ${DEAD} (dead) since ${SINCE}`, l);
  owner({ by: 'run' });
  l = lockLine();
  ok('R1 owner.json with another by: no "watch", the line of 0.4.21', l === `lock: train t1 for arc arc by pid ${DEAD} (dead) since ${SINCE}`, l);
  owner({ by: 'watch', pid: process.pid });
  l = lockLine();
  ok('R1 owner.json by watch, holder alive: "by watch pid N (alive)"', l === `lock: train t1 for arc arc by watch pid ${process.pid} (alive) since ${SINCE}`, l);

  // ---- R2 ----
  const noRc = { done: false, rc: null, log: '/d/wait-train-1.log', error: 'no JSON' };
  for (const [name, steps] of [['could not run', [noRc, noRc]], ['returned no result', [null, null]]]) {
    const r = await chain(steps);
    const why = (r && r.why) || '';
    ok(`R2 the train step ${name}: stopped, ack names the task key and the head after the review (not the branch)`,
      r.status === 'stopped' && why.includes(`train.js ack --task kx --head ${HEAD}`) && !/--task bz/.test(why), JSON.stringify(r).slice(0, 800));
    ok(`R2 the train step ${name}: the stop names the branch and head the review accepted, and is not a train verdict`,
      why.includes(`branch bz head ${HEAD}`) && !(r.train && r.train.verdict), JSON.stringify(r).slice(0, 800));
  }
  const r78 = await chain([{ done: true, rc: 78, seconds: 1, log: '/d/wait-train.log', tail: '' }]);
  const w78 = (r78 && r78.why) || '';
  ok('R2 exit 78: environment, nothing queued (branch and head named), no ack and no verdict without an addressee',
    r78.status === 'stopped' && !!r78.environment && /nothing was queued/.test(w78) && w78.includes(`branch bz head ${HEAD} is not queued`) && !/train\.js ack/.test(w78) && !/without an addressee/.test(String(r78.environment)), JSON.stringify(r78).slice(0, 800));
})().catch((e) => ok('no exception', false, e && e.stack)).finally(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } done(); });
