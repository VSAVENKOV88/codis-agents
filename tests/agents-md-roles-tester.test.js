#!/usr/bin/env node
'use strict';
// The tester's cells around p-codex-D3-3 (project rules for roles on Codex, the freshness of AGENTS.md in the chain)
// that tests/agents-md-roles.test.js does not hold. Synthetic projects and homes only; no model and no real Codex.
//   TH1  skills of the run home that is a file, or a link to a folder: red ("not a folder"), a link is never followed
//   TH2  skills/.system whose marker is a folder, not a file: red
//   TH3  two skills of a person: each named on its own line
//   TH4  an empty skills/ folder, and entries outside the named channels (rules/, prompts/, config.toml): no home line
//   TH5  skills/ that cannot be listed: a red line "cannot be read", the check still answers JSON
//   TH6  on a case-insensitive disk agents.md is the same file Codex opens as AGENTS.md: red
//   TU1  check --base: the update route is the last line, also for a foreign and a hand-edited AGENTS.md (no
//        write --root <dir> anywhere), and the hand-edited line keeps --discard-edits
//   TU2  check --base when only an import outside the repository is missing (exit 69): no route (the route cannot help)
//   TU3  check --base with an AGENTS.override.md and a missing outside import together: exit 1 with the route
//   TP1  the preconditions prompt: a blank base gives no --base; a base with a space or a quote is shell-quoted
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const RX = path.join(ROOT, 'scripts', 'role-exec.js');
const AM = path.join(ROOT, 'scripts', 'agents-md.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-roles-tester-'));
const restore = [];
process.on('exit', () => {
  for (const p of restore) { try { fs.chmodSync(p, 0o755); } catch { /* best effort */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
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

(async () => {
  // ---------------------------------------------------------------- TH: the run home
  const BIN = path.join(TMP, 'bin'); fs.mkdirSync(BIN);
  const fakeJs = path.join(BIN, 'fake-codex.js');
  fs.writeFileSync(fakeJs, `const fs = require('fs'); const a = process.argv.slice(2).join(' ');
if (a === '--version') { console.log('codex-cli 0.166.0'); process.exit(0); }
if (a === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (a === 'debug models') { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'role-exec', 'codex-models.json'))}, 'utf8')); process.exit(0); }
console.error('unexpected ' + a); process.exit(9);\n`);
  const codexBin = path.join(BIN, 'codex');
  fs.writeFileSync(codexBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`); fs.chmodSync(codexBin, 0o755);
  const home = (files) => { const h = path.join(TMP, `home${++n}`); fs.mkdirSync(h, { recursive: true }); put(h, files || {}); return h; };
  const check = (h) => {
    const p = spawnSync(process.execPath, [RX, 'check', '--host', 'codex', '--bin', codexBin, '--home', h], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(p.stdout); } catch { /* none */ }
    return { rc: p.status, j, probs: (j && j.problems) || [], out: p.stdout + p.stderr };
  };
  const homeLine = (p) => /the run home .* (has |cannot be read)/.test(p);
  const SYS = { 'skills/.system/.codex-system-skills.marker': '', 'skills/.system/a-skill/SKILL.md': '---\nname: a\n---\n' };
  const BASE = { 'auth.json': '{}', 'auth.lock': '', 'log/': '', 'tmp/': '' };

  // sanity: the prepared home with the system skills is green, so every red below comes from the cell itself
  let c = check(home(Object.assign({}, BASE, SYS)));
  ok('TH0. a prepared home with skills/.system and its marker: green, no home line', c.rc === 0 && c.j && c.j.ok === true && !c.probs.some(homeLine), c.out);

  let h = home(Object.assign({}, BASE, { skills: 'a file named skills\n' }));
  c = check(h);
  ok('TH1. skills of the run home that is a file: red, "skills that is not a folder"', c.rc === 1 && c.probs.some((p) => p.includes(h) && /has skills that is not a folder/.test(p)), c.out);

  const target = home(SYS); // a folder that holds only the system skills, reached through a link
  h = home(BASE); fs.symlinkSync(path.join(target, 'skills'), path.join(h, 'skills'));
  c = check(h);
  ok('TH1. skills of the run home that is a link to a folder: red (lstat, the link is not followed)', c.rc === 1 && c.probs.some((p) => /has skills that is not a folder/.test(p)), c.out);

  h = home(Object.assign({}, BASE, { 'skills/.system/.codex-system-skills.marker/': '', 'skills/.system/a-skill/SKILL.md': 'x' }));
  c = check(h);
  ok('TH2. skills/.system whose marker is a folder: red with .codex-system-skills.marker', c.rc === 1 && c.probs.some((p) => p.includes('skills/.system without .codex-system-skills.marker')), c.out);

  h = home(Object.assign({}, BASE, SYS, { 'skills/beta/SKILL.md': 'b', 'skills/alpha/SKILL.md': 'a' }));
  c = check(h);
  const sk = c.probs.filter((p) => /has skills\//.test(p));
  ok('TH3. two skills of a person: two lines, each named, .system not named', c.rc === 1 && sk.length === 2 && sk.some((p) => p.includes('skills/alpha')) && sk.some((p) => p.includes('skills/beta'))
    && !sk.some((p) => p.includes('skills/.system')), c.out);

  h = home(Object.assign({}, BASE, { 'skills/': '', 'rules/default.rules': 'x', 'prompts/p.md': 'x', 'config.toml': 'developer_instructions = "x"\n', 'memories/': '' }));
  c = check(h);
  ok('TH4. an empty skills/ and entries outside the named channels (rules/, prompts/, config.toml): green, no home line', c.rc === 0 && c.j && c.j.ok === true && !c.probs.some(homeLine), c.out);

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    h = home(Object.assign({}, BASE, SYS));
    const sd = path.join(h, 'skills'); fs.chmodSync(sd, 0o000); restore.push(sd);
    c = check(h);
    fs.chmodSync(sd, 0o755);
    ok('TH5. skills/ that cannot be listed: JSON answer, ok false, a line "cannot be read for its instruction files"', c.rc === 1 && c.j && c.j.ok === false
      && c.probs.some((p) => p.includes(h) && /cannot be read for its instruction files/.test(p)), c.out);
  } else ok('TH5. skipped: running as root, a folder without rights is still readable', true);

  const probe = home({ 'case-probe': '' });
  if (fs.existsSync(path.join(probe, 'CASE-PROBE'))) {
    h = home(Object.assign({}, BASE, { 'agents.md': '# rules of a person\n' }));
    c = check(h);
    ok('TH6. case-insensitive disk: agents.md is AGENTS.md for Codex too: red', c.rc === 1 && c.probs.some((p) => /has AGENTS\.md/.test(p)), c.out);
  } else ok('TH6. skipped: the disk is case-sensitive', true);

  // ---------------------------------------------------------------- TU: check --base, the route
  const H0 = path.join(TMP, 'userhome'); fs.mkdirSync(H0);
  const am = (args) => {
    const e = Object.assign({}, process.env, { HOME: H0 }); delete e.CODIS_AGENTS_CONFIG; delete e.CLAUDE_PROJECT_DIR;
    const r = spawnSync(process.execPath, [AM, ...args], { encoding: 'utf8', env: e });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const project = (files) => {
    const d = path.join(TMP, `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '.');
    put(d, Object.assign({ '.claude/codis-agents.json': JSON.stringify({ repoDir: '.', worktreeRoot: '/tmp/wt', sharedDir: '/tmp/shared', agentsMd: true }) + '\n' }, files));
    git(d, 'add', '--', ...Object.keys(files), '.claude/codis-agents.json');
    return d;
  };
  const lines = (o) => o.split('\n').filter(Boolean);
  const isRoute = (l, b) => l.replace(/^agents-md: /, '').startsWith(`update route from ${b}:`) && l.includes(`merge ${b} into the task branch`);
  const noWriteRootDir = (o) => !/write --root \//.test(o);

  let d = project({ 'CLAUDE.md': '# Rules\n' });
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# a file of a person\n');
  let r = am(['check', '--root', d, '--base', 'arc-y']);
  let L = lines(r.out);
  ok('TU1. foreign AGENTS.md, --base: exit 1, the conflict line points to the route, the route is the last line, no write --root <dir>',
    r.rc === 1 && L.some((l) => /is not generated by codis-agents/.test(l) && /update it by the route below/.test(l)) && isRoute(L[L.length - 1], 'arc-y') && noWriteRootDir(r.out), r.out);

  d = project({ 'CLAUDE.md': '# Rules\n\nRun the tests.\n' });
  am(['write', '--root', d]);
  const agentsFile = path.join(d, 'AGENTS.md');
  fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8').replace('Run the tests.', 'Run every test.'));
  r = am(['check', '--root', d, '--base', 'arc-y']);
  L = lines(r.out);
  ok('TU1. hand-edited AGENTS.md, --base: exit 1, "update it by the route below (write --discard-edits)", the route last, no write --root <dir>',
    r.rc === 1 && L.some((l) => /was edited by hand/.test(l) && l.includes('update it by the route below (write --discard-edits)')) && isRoute(L[L.length - 1], 'arc-y') && noWriteRootDir(r.out), r.out);
  r = am(['check', '--root', d]);
  ok('TU1. hand-edited AGENTS.md without --base: the text as before (run ... write --root <root> --discard-edits), no route',
    r.rc === 1 && /run node \S+agents-md\.js write --root \/\S+ --discard-edits/.test(r.out) && !/update route from/.test(r.out), r.out);

  d = project({ 'CLAUDE.md': '# Rules\n\nSee @~/kit/none.md for more.\n' });
  r = am(['check', '--root', d, '--base', 'arc-y']);
  ok('TU2. only an import outside the repository is missing (exit 69), --base: no route line',
    r.rc === 69 && /not on this machine/.test(r.out) && !/update route from/.test(r.out) && !/update it by the route below/.test(r.out), r.rc + ' ' + r.out);

  d = project({ 'CLAUDE.md': '# Rules\n\nSee @~/kit/none.md too.\n' });
  fs.writeFileSync(path.join(d, 'AGENTS.override.md'), '');
  r = am(['check', '--root', d, '--base', 'arc-y']);
  L = lines(r.out);
  ok('TU3. a missing outside import and a project problem together, --base: exit 1, the route is the last line',
    r.rc === 1 && /not on this machine/.test(r.out) && isRoute(L[L.length - 1], 'arc-y'), r.rc + ' ' + r.out);

  // ---------------------------------------------------------------- TP: the preconditions prompt
  const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'role-chain.js'), 'utf8').replace(/^export const meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const CFG0 = { sharedDir: '/s', worktreeRoot: '/r', scriptsDir: '/p/scripts', reportLanguage: 'Russian', ownerStackReadOnly: 'own', slots: { lockDir: '/slots' },
    protectedBranches: ['main'], testerWritable: ['-run\\.js$'], roleNotes: {} };
  const T = { key: 'x', title: 'X', dir: '/d', wt: '/w', branch: 'b', gdir: 'w', accept: 'acc', kind: 'tail', noAnalysis: 'n' };
  async function prePrompt(task) {
    let got = null;
    const agent = async (prompt, opts) => {
      if (opts.label.startsWith('pre:')) { got = prompt; return { ok: false, problems: ['stop here'], blockingQuestions: [] }; }
      return null;
    };
    try {
      await new AsyncFunction('agent', 'pipeline', 'parallel', 'log', 'phase', 'args', SRC)(
        agent, async (items, fn) => Promise.all(items.map((it) => fn(it))), null, () => {}, () => {}, { owner: 'o', config: CFG0, tasks: [task] });
    } catch { /* the prompt is what is checked */ }
    return got || '';
  }
  let p = await prePrompt(Object.assign({}, T, { base: '   ' }));
  ok('TP1. pre with a blank base: the check has no --base', p.includes("node /p/scripts/agents-md.js check --root '/w';") && !/agents-md\.js check[^;]*--base/.test(p), p.slice(-900));
  p = await prePrompt(Object.assign({}, T, { base: " arc it's " }));
  ok('TP1. pre with a base holding a space and a quote: trimmed and shell-quoted after --base', p.includes(`agents-md.js check --root '/w' --base 'arc it'\\''s';`), p.slice(-900));

  done();
})().catch((e) => { ok('no exception in the test', false, e.stack); done(); });
