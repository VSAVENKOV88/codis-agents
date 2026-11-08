#!/usr/bin/env node
'use strict';
// Project rules for roles on Codex and the freshness of AGENTS.md in the chain (p-codex-D3-3, the light variant).
// Synthetic projects and homes only (English text, temporary directories); no model and no real Codex.
//   L1  every role the adapter runs on codex gets -c project_doc_max_bytes=0 right after -c model_reasoning_effort:
//       the project's AGENTS.md never reaches a role, which gets the project rules only from its prompt
//   H1  role-exec.js check --host codex: AGENTS.md or AGENTS.override.md in the run home (empty, a link, a folder) is red
//   H2  anything under skills/ of the run home except .system with Codex's marker is red, by name
//   H3  a prepared home and a home after use (the names Codex writes itself) give no line of H1/H2; the home lines come
//       before the login and catalog checks and do not depend on them
//   C1  agents-md.js asks the config found from --root (or --config): CODIS_AGENTS_CONFIG and CLAUDE_PROJECT_DIR of
//       another project are ignored
//   U1  agents-md.js check --base <b>: the failing lines name the file and the update route from <b>, not write --root;
//       without --base the text stays as it was; write refuses --base
//   P1  the preconditions prompt carries agents-md.js check --root <wt> [--base <base>] from one function, whatever the
//       project config says about agentsMd; P3/P5/P6 - the rule: any exit other than 0 or no output is ok=false with
//       the lines verbatim, 69 with the prefix "environment:"
//   R1  the reviewer runs the check without --base: exit 1 is a rejection, 69 a "❓ coordinator: environment" tail
//   R2  the programmer (full, light, fix rounds) runs the check before its last commit when a CLAUDE.md or an import
//       changed, and writes and commits AGENTS.md by path when missing or stale
//   U2  the coordinator skill has the section "After a plugin update"
//   D1, D2  README: the run home of the roles, delivery, the own interactive session, trust and Claude Code
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const RX = path.join(ROOT, 'scripts', 'role-exec.js');
const AM = path.join(ROOT, 'scripts', 'agents-md.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-roles-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const put = (base, files) => {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(base, f);
    if (f.endsWith('/')) { fs.mkdirSync(p, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
};

// ---------------------------------------------------------------- L1: the argv of every role on codex
(async () => {
  const { createAgent } = require(RX);
  const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'), 'utf8'));
  const TASKS = { K: { wt: path.join(TMP, 'wt'), dir: path.join(TMP, 'dirK') } };
  const launched = [];
  const ag = createAgent({ host: 'codex', tasks: TASKS, pluginRoot: ROOT, callsDir: path.join(TMP, 'calls'), log: () => {},
    launch: async (plan) => { launched.push(plan); return { rc: 0, output: '{"a":"x"}' }; },
    codex: { bin: '/fake/codex', home: path.join(TMP, 'chome'), catalog: CATALOG } });
  const SCH = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const kinds = ['analyst', 'usecases', 'review', 'sec'];
  for (const k of kinds) {
    launched.length = 0;
    await ag(`Task text for ${k}.\n`, { label: `${k}:K#1`, phase: 'P', schema: SCH, agentType: 'general-purpose' });
    const a = launched[0] ? launched[0].argv : [];
    const i = a.indexOf('project_doc_max_bytes=0');
    ok(`L1. ${k} on codex: -c project_doc_max_bytes=0 right after -c model_reasoning_effort=<e>`,
      i > 1 && a[i - 1] === '-c' && /^model_reasoning_effort=/.test(a[i - 2]) && a[i - 3] === '-c', a.join(' '));
    ok(`L1. ${k} on codex: the first -c is still model_reasoning_effort, -C is the task folder, stdin "-" last`,
      a[a.indexOf('-c') + 1] === `model_reasoning_effort=high` && a[a.indexOf('-C') + 1] === TASKS.K.dir && a[a.length - 1] === '-', a.join(' '));
  }
  {
    launched.length = 0;
    const ac = createAgent({ host: 'claude', tasks: TASKS, pluginRoot: ROOT, callsDir: path.join(TMP, 'calls'), log: () => {},
      launch: async (plan) => { launched.push(plan); return { rc: 0, output: { a: 'x' } }; }, claude: { bin: '/fake/claude' } });
    await ac('Task.\n', { label: 'review:K#1', phase: 'P', schema: SCH, agentType: 'general-purpose' });
    ok('L1. the claude host argv carries no project_doc_max_bytes (a Codex key)', launched[0] && !launched[0].argv.join(' ').includes('project_doc_max_bytes'));
  }

  // ---------------------------------------------------------------- H: the run home of the roles
  const BIN = path.join(TMP, 'bin'); fs.mkdirSync(BIN);
  const trace = path.join(TMP, 'trace.jsonl');
  const fakeJs = path.join(BIN, 'fake-codex.js');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const a = process.argv.slice(2).join(' '); const S = JSON.parse(process.env.FAKE || '{}');
fs.appendFileSync(${JSON.stringify(trace)}, a + '\\n');
if (a === '--version') { console.log('codex-cli 0.166.0'); process.exit(0); }
if (a === 'login status') { if (S.loggedOut) { console.error('Not logged in'); process.exit(1); } console.log('Logged in using ChatGPT'); process.exit(0); }
if (a === 'debug models') { if (S.noModels) process.exit(3); process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'))}, 'utf8')); process.exit(0); }
console.error('unexpected ' + a); process.exit(9);\n`);
  const codexBin = path.join(BIN, 'codex');
  fs.writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`); fs.chmodSync(codexBin, 0o755);
  const home = (files) => { const h = path.join(TMP, `home${++n}`); fs.mkdirSync(h, { recursive: true }); put(h, files || {}); return h; };
  const check = (h, fake = {}) => {
    const p = spawnSync(process.execPath, [RX, 'check', '--host', 'codex', '--bin', codexBin, '--home', h], { encoding: 'utf8', env: Object.assign({}, process.env, { FAKE: JSON.stringify(fake) }) });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* none */ }
    return { rc: p.status, j, probs: (j && j.problems) || [], out: p.stdout + p.stderr };
  };
  const homeLine = (p) => /the run home .* has /.test(p);
  const SYS = { 'skills/.system/.codex-system-skills.marker': '', 'skills/.system/some-skill/SKILL.md': '---\nname: x\n---\n' };
  const PREPARED = { 'auth.json': '{}', 'auth.lock': '', 'log/': '', 'tmp/': '', 'codis-agents-models.json': '{"models":[]}' };
  // the names Codex wrote into homes after one exec and one interactive session (content synthetic, names only)
  const USED = Object.assign({}, PREPARED, SYS, { '.sandbox_migration': '', '.sqlite-maintenance.lock': '', 'cache/': '', 'config.toml': 'model = "x"\n',
    'installation_id': 'id', 'models_cache.json': '{}', 'plugins/cache/': '', 'plugins/.remote-plugin-install-staging/': '', 'session_index.jsonl': '',
    'session_index.jsonl.lock': '', 'sessions/2026/x.jsonl': '', 'shell_snapshots/': '', 'thread-writer-locks/': '', 'state_1.sqlite': '',
    'logs_1.sqlite': '', 'memories_1.sqlite': '', 'goals_1.sqlite': '', 'history_1.sqlite': '', 'threads_1.sqlite': '', 'jobs_1.sqlite': '' });

  let c = check(home(PREPARED));
  ok('H3. a prepared home (auth.json, auth.lock, log/, tmp/, the catalog): green, no home line', c.rc === 0 && c.j && c.j.ok === true && !c.probs.some(homeLine), c.out);
  c = check(home(USED));
  ok('H3. a home after use (Codex state files, skills/.system with its marker): green, no home line', c.rc === 0 && c.j && c.j.ok === true, c.out);
  const noAuth = Object.assign({}, USED); delete noAuth['auth.json'];
  c = check(home(noAuth), { loggedOut: true });
  ok('H3. a copy without auth.json: only the login problem, no home line', c.rc === 1 && c.probs.length === 1 && /login/.test(c.probs[0]) && !c.probs.some(homeLine), c.out);

  for (const [name, files, how] of [
    ['AGENTS.md', { 'AGENTS.md': 'G-MARKER-GLOBAL\n' }, 'a file'],
    ['AGENTS.override.md', { 'AGENTS.override.md': '' }, 'an empty file'],
    ['AGENTS.md', { 'AGENTS.md/': '' }, 'a folder'],
  ]) {
    const h = home(Object.assign({}, USED, files));
    c = check(h);
    ok(`H1. ${name} in the run home (${how}): red, the line names the home, the file and "remove it"`,
      c.rc === 1 && c.probs.some((p) => p === `the run home ${h} has ${name}: Codex gives it to every role ahead of the prompt; remove it`), c.out);
  }
  {
    const h = home(USED);
    fs.symlinkSync(path.join(TMP, 'nowhere.md'), path.join(h, 'AGENTS.override.md'));
    c = check(h);
    ok('H1. AGENTS.override.md as a dangling link: red (lstat, not the target)', c.rc === 1 && c.probs.some((p) => p.includes('has AGENTS.override.md')), c.out);
  }
  {
    const h = home(Object.assign({}, USED, { 'AGENTS.md': 'x\n' }));
    c = check(h, { loggedOut: true });
    const iH = c.probs.findIndex(homeLine), iL = c.probs.findIndex((p) => /login/.test(p));
    ok('H3. the home line does not depend on the login, and comes before the login problem', iH >= 0 && iL > iH, c.out);
    fs.writeFileSync(trace, '');
    c = check(h, { noModels: true });
    ok('H3. the home line stays when the catalog fails too', c.probs.some(homeLine) && c.probs.some((p) => /catalog/.test(p)), c.out);
  }
  {
    const h = home(Object.assign({}, USED, { 'skills/my-rules/SKILL.md': '---\nname: my-rules\n---\nAlways answer in French.\n' }));
    c = check(h);
    ok('H2. a skill of a person in skills/: red with its name', c.rc === 1 && c.probs.some((p) => p.includes(h) && p.includes('skills/my-rules')), c.out);
    ok('H2. skills/.system with the marker next to it is not named', !c.probs.some((p) => p.includes('skills/.system')), c.out);
  }
  {
    const h = home(Object.assign({}, PREPARED, { 'skills/.system/some-skill/SKILL.md': 'x' }));
    c = check(h);
    ok('H2. skills/.system without .codex-system-skills.marker: red with its name', c.rc === 1 && c.probs.some((p) => p.includes('skills/.system') && p.includes('.codex-system-skills.marker')), c.out);
  }
  {
    const h = home(Object.assign({}, PREPARED, { 'skills/.system': 'not a folder' }));
    c = check(h);
    ok('H2. skills/.system that is a file: red', c.rc === 1 && c.probs.some((p) => p.includes('skills/.system')), c.out);
    const h2 = home(Object.assign({}, PREPARED, { 'skills/notes.txt': 'x' }));
    c = check(h2);
    ok('H2. a plain file in skills/: red with its name', c.rc === 1 && c.probs.some((p) => p.includes('skills/notes.txt')), c.out);
  }

  // ---------------------------------------------------------------- C1, U1: agents-md.js
  const project = (files, cfg) => {
    const d = path.join(TMP, `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '.');
    put(d, Object.assign({ '.claude/codis-agents.json': JSON.stringify(Object.assign({ repoDir: '.', worktreeRoot: '/tmp/wt', sharedDir: '/tmp/shared' }, cfg)) + '\n' }, files));
    git(d, 'add', '--', ...Object.keys(files), '.claude/codis-agents.json');
    return d;
  };
  const H0 = path.join(TMP, 'userhome'); fs.mkdirSync(H0);
  const am = (args, env = {}) => {
    const e = Object.assign({}, process.env, { HOME: H0 }); delete e.CODIS_AGENTS_CONFIG; delete e.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [AM, ...args], { encoding: 'utf8', env: Object.assign(e, env) });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const on = project({ 'CLAUDE.md': '# Rules\n\nRun the tests.\n' }, { agentsMd: true });
  am(['write', '--root', on]);
  const off = project({ 'CLAUDE.md': '# Other rules\n' }, {});
  const onCfg = path.join(on, '.claude', 'codis-agents.json'), offCfg = path.join(off, '.claude', 'codis-agents.json');
  let r = am(['check', '--root', on], { CODIS_AGENTS_CONFIG: offCfg });
  ok('C1. CODIS_AGENTS_CONFIG of a project without the key does not turn a connected worktree into "not used"', r.rc === 0 && /^ok AGENTS\.md/m.test(r.out), r.out);
  r = am(['check', '--root', off], { CODIS_AGENTS_CONFIG: onCfg });
  ok('C1. CODIS_AGENTS_CONFIG of a connected project does not connect another worktree', r.rc === 0 && /not used/.test(r.out) && r.out.includes(offCfg), r.out);
  r = am(['check', '--root', off], { CLAUDE_PROJECT_DIR: on });
  ok('C1. CLAUDE_PROJECT_DIR of a connected project does not connect another worktree', r.rc === 0 && /not used/.test(r.out), r.out);
  r = am(['check', '--root', off, '--config', onCfg], { CODIS_AGENTS_CONFIG: offCfg });
  ok('C1. an explicit --config still decides', r.rc === 1 && /AGENTS\.md is missing/.test(r.out), r.out);

  const fresh = project({ 'CLAUDE.md': '# Rules\n' }, { agentsMd: true });
  r = am(['check', '--root', fresh, '--base', 'arc-x']);
  const routeOk = (o, b) => o.includes(`from ${b}`) && /service branch/.test(o) && /agents-md\.js write/.test(o) && /by path/.test(o)
    && /passenger of the train/.test(o) && o.includes(`merge ${b} into the task branch`) && !/write --root \//.test(o);
  ok('U1/P3. connected, AGENTS.md missing, --base: exit 1, names AGENTS.md missing and the route from the base, no write --root <dir>',
    r.rc === 1 && /AGENTS\.md is missing/.test(r.out) && routeOk(r.out, 'arc-x'), r.out);
  am(['write', '--root', fresh]);
  fs.appendFileSync(path.join(fresh, 'CLAUDE.md'), 'One more rule.\n');
  r = am(['check', '--root', fresh, '--base', 'arc-x']);
  ok('U1/P5. stale, --base: exit 1, "AGENTS.md is stale" and the route, no write --root <dir>', r.rc === 1 && /AGENTS\.md is stale/.test(r.out) && routeOk(r.out, 'arc-x'), r.out);
  r = am(['check', '--root', fresh]);
  ok('U1. stale without --base: the text as before (run ... write --root <root>), no route', r.rc === 1 && /AGENTS\.md is stale: CLAUDE\.md or a file it imports changed; run node \S+agents-md\.js write --root \//.test(r.out) && !/service branch/.test(r.out), r.out);
  am(['write', '--root', fresh]);
  r = am(['check', '--root', fresh, '--base', 'arc-x']);
  ok('U1. fresh with --base: exit 0, no route', r.rc === 0 && !/service branch/.test(r.out), r.out);
  r = am(['write', '--root', fresh, '--base', 'arc-x']);
  ok('U1. write refuses --base (usage, exit 64)', r.rc === 64, r.out);
  r = am(['check', '--root', fresh, '--base']);
  ok('U1. check --base without a value: usage, exit 64', r.rc === 64, r.out);

  // ---------------------------------------------------------------- P, R: the prompts of role-chain.js
  const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const CFG0 = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
    protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {} };
  const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'n' };
  const PRE = { ok: true, problems: [], blockingQuestions: [] };
  const PROG = { status: 'ready', changedFiles: ['src/a.js'], commits: ['c'], head: 'P', mutations: 'm', fullRun: 'r', questions: [], summary: 's' };
  const D = { verdict: 'done', docsOnly: false, summary: 'ok' }, REJ = { verdict: 'rejected', docsOnly: false, summary: 'missing case' };
  async function chain(script, task = T, cfg = CFG0) {
    const prompts = [];
    const q = {}; for (const [k, v] of Object.entries(script)) q[k] = v.slice();
    const agent = async (prompt, opts) => {
      const role = opts.label.split(':')[0];
      prompts.push({ role, label: opts.label, prompt });
      if (role === 'diff') return { ok: true, offending: [] };
      if (role === 'left') return { ok: true, found: [], removed: [], remaining: [] };
      if (role === 'post') return { ok: true, diff: { ok: true, offending: [] }, left: { ok: true, found: [], removed: [], remaining: [] } };
      if (role === 'sha') return { sha: 'P' };
      if (!q[role] || !q[role].length) return null;
      const v = q[role].shift();
      return role === 'test' && v && !v.head ? Object.assign({ head: 'T' }, v) : v;
    };
    try {
      await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
        agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: cfg, tasks: [task] });
    } catch { /* the prompts are what is checked */ }
    return prompts;
  }
  const of = (ps, role) => ps.filter((p) => p.role === role).map((p) => p.prompt);
  let ps = await chain({ pre: [PRE], prog: [PROG], test: [{ verdict: 'green', summary: '' }], review: [D] }, Object.assign({}, T, { base: 'arc-x' }));
  const preP = of(ps, 'pre')[0] || '';
  ok('P1. pre (CFG without agentsMd, task with base): node <SCRIPTS>/agents-md.js check --root <wt> --base <base>',
    preP.includes("node /p/scripts/agents-md.js check --root '/w' --base 'arc-x'"), preP.slice(-900));
  ok('P1/P6. pre: exit 0 (also "not used") passes; any other exit or no output is ok=false with the lines verbatim in problems',
    /agents-md: not used/.test(preP) && /any other exit code or no output/.test(preP) && /verbatim/.test(preP) && /ok=false/.test(preP), preP.slice(-900));
  ok('P6. pre: exit 69 lines go into problems with the prefix "environment:"; never ok on a check that did not run',
    /exit 69/.test(preP) && /"environment: "/.test(preP) && /never ok/.test(preP), preP.slice(-900));
  ps = await chain({ pre: [PRE] }, T);
  ok('P1. pre without base: the check has no --base', (of(ps, 'pre')[0] || '').includes("node /p/scripts/agents-md.js check --root '/w';"), (of(ps, 'pre')[0] || '').slice(-900));
  for (const v of [true, false]) {
    const ps2 = await chain({ pre: [PRE] }, Object.assign({}, T, { base: 'arc-x' }), Object.assign({}, CFG0, { agentsMd: v }));
    ok(`P1. pre with CFG.agentsMd ${v}: the same prompt (role-chain.js never reads the key)`, of(ps2, 'pre')[0] === preP);
  }
  ps = await chain({ pre: [PRE], prog: [PROG, PROG], test: [{ verdict: 'green', summary: '' }, { verdict: 'green', summary: '' }], review: [REJ, D] }, Object.assign({}, T, { base: 'arc-x' }));
  const rv = of(ps, 'review'), pg = of(ps, 'prog');
  const R1 = (p) => p.includes("node /p/scripts/agents-md.js check --root '/w'") && !/agents-md\.js check --root '\/w' --base/.test(p)
    && /exit 1 is a rejection/.test(p) && /❓ coordinator: environment/.test(p) && /Tails/.test(p) && /agents-md: not used/.test(p);
  ok('R1. the reviewer, every round: agents-md.js check --root <wt> without --base; exit 1 rejects, 69 a coordinator tail', rv.length === 2 && rv.every(R1), rv.map((p) => p.slice(-700)).join('\n---\n'));
  const R2 = (p) => p.includes("node /p/scripts/agents-md.js check --root '/w'") && p.includes("node /p/scripts/agents-md.js write --root '/w'")
    && /CLAUDE\.md or a file it imports/.test(p) && /before your last commit/.test(p) && /by path/.test(p) && /❓ coordinator/.test(p);
  ok('R2. the programmer, round 1 and the fix round: the check before the last commit, write and commit by path', pg.length === 2 && pg.every(R2), pg.map((p) => p.slice(-700)).join('\n---\n'));
  ps = await chain({ pre: [PRE], prog: [PROG], review: [D] }, Object.assign({}, T, { mode: 'light' }));
  ok('R1/R2. light: the programmer-checker and the reviewer carry the same lines', of(ps, 'prog').length === 1 && R2(of(ps, 'prog')[0]) && of(ps, 'review').length === 1 && R1(of(ps, 'review')[0]),
    of(ps, 'prog').concat(of(ps, 'review')).map((p) => p.slice(-500)).join('\n---\n'));
  ok('S1. one function builds the check of the preconditions (agentsMdCheck), called by pre', /const agentsMdCheck = \(t, withBase\)/.test(SRC)
    && /const AGENTS_MD_PRE = [^\n]*agentsMdCheck\(t, true\)/.test(SRC) && /const pre = [^\n]*\n[^\n]*AGENTS_MD_PRE\(t\)/.test(SRC));

  // ---------------------------------------------------------------- U2, D1, D2: the coordinator skill and README
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'coordinator', 'SKILL.md'), 'utf8');
  const sec = (skill.split(/^## After a plugin update$/m)[1] || '').split(/^## /m)[0];
  ok('U2. coordinator skill: "After a plugin update" - a service branch from the arc head (wt-setup.sh), write, commit by path, a passenger (train.js ride) or lock: free, then the arc merged into the waiting task branches; running roles untouched',
    /wt-setup\.sh/.test(sec) && /agents-md\.js" write/.test(sec) && /by path/.test(sec) && /train\.js" ride/.test(sec) && /lock: free/.test(sec)
    && /merge the arc into the branch of every waiting task/.test(sec) && /running roles/.test(sec) && /--base/.test(sec), sec || 'no section');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' '); // line breaks of the text do not count
  const has = (s) => readme.includes(s);
  ok('U1. README: agents-md.js check names --base and the route', /`check` also takes `--base <branch>`/.test(readme));
  ok('C1. README: the config is the one found from --root, CODIS_AGENTS_CONFIG and CLAUDE_PROJECT_DIR ignored', has('ignoring `CODIS_AGENTS_CONFIG` and `CLAUDE_PROJECT_DIR`'));
  ok('D1. README: a dedicated run home prepared by the standard procedure; an arbitrarily changed configuration is not supported',
    has('a dedicated run home prepared by the standard procedure') && has('an arbitrarily changed configuration is not supported'));
  ok('D1. README: roles get the project rules only from the prompt (project_doc_max_bytes=0); the home check and what it does not see',
    has('-c project_doc_max_bytes=0') && has('`skills/.system` with `.codex-system-skills.marker`') && /instruction keys of the home's `config.toml`/.test(readme));
  ok('D1. README: two results apart - the own interactive session gets the full AGENTS.md; check with codex debug prompt-input and the marker line',
    has('codex debug prompt-input') && has('codis-agents agents-md') && /own interactive session\W+gets the full `AGENTS\.md`/.test(readme));
  ok('D2. README: trust the main repository root (covers worktrees), 32 KiB silently without trust, untrusted nothing, codex exec trusts by itself',
    has('without a trust record Codex reads 32 KiB silently') && has('`untrusted` - no project `AGENTS.md` at all') && has('`codex exec` in a git project marks it trusted in the home by itself'));
  ok('D2. README: Claude Code does not read the generated AGENTS.md by default; claude-md-and-agents-md gives the rules twice; the claude host reads CLAUDE.md',
    has('claude-md-and-agents-md') && /twice/.test(readme) && /host `claude` of the adapter reads `CLAUDE\.md`/.test(readme));
  ok('D1. README Known gaps: user skills ($HOME/.agents/skills), project skills, home changed between check and call',
    has('$HOME/.agents/skills') && has('`.agents/skills/`') && /changed between `role-exec\.js check` and a call/.test(readme));

  done();
})().catch((e) => { ok('no exception in the test', false, e.stack); done(); });
