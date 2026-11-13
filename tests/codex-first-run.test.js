#!/usr/bin/env node
'use strict';
// p-codex-setup: the newcomer's path on Codex. The coordinator skill has a "First run on Codex" step inside "On Codex:
// homes, sandbox and rules": at the start of a coordinator session the model checks its Codex home (not the personal
// ~/.codex, the rules file with the literal path of the installed copy, the sandbox keys and the trusted project in
// config.toml), fills in the values itself (config.js get, the installed copy), shows the owner the finished texts and
// one Terminal command (a copy of config.toml, then the writes) and never writes into the home itself. The README walks
// the newcomer through the two homes, the start folder, the hook trust asked at the first start, the verified Codex
// versions and the manual filling of config.toml and the rules file.
// The Terminal command of the skill is run here for real in a temporary home, and its rules are checked with
// codex execpolicy check when codex is in PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, skip, has, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const flat = (s) => s.replace(/\s+/g, ' ');
// The text from the heading line that matches re up to the next heading of the same or a higher level (fences skipped).
function section(text, re) {
  const lines = text.split('\n');
  let fence = false, start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    const h = !fence && /^(#{1,6}) (.*)$/.exec(lines[i]);
    if (!h) continue;
    if (start < 0) { if (re.test(h[2])) { start = i; level = h[1].length; } } else if (h[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? '' : lines.slice(start).join('\n');
}

const co = read('skills/coordinator/SKILL.md');
const homes = section(co, /^On Codex: homes/);
const fr = section(homes, /^First run on Codex/);
const frF = flat(fr);
ok('S1 coordinator: a step "First run on Codex" inside "On Codex: homes, sandbox and rules"', !!fr && /^### First run on Codex/m.test(homes), homes.slice(0, 200));
ok('S2 the check runs at the start of a coordinator session on Codex, before any task', /start of (every|each|a) coordinator session/.test(frF) && /before any task/.test(frF), frF.slice(0, 400));
ok('S3 the personal ~/.codex (or $CODEX_HOME empty) is refused with the reason and a separate home ~/.codex-codis-coord offered; nothing is set up there',
  /`\$CODEX_HOME`[^.]*(empty|not set)/.test(frF) && /refuse/.test(frF) && /~\/\.codex-codis-coord/.test(frF) && /every session of (that|a|the) home/.test(frF), frF.slice(0, 900));
ok('S4 the values come from the project config: config.js get repoDir, worktreeRoot, sharedDir (absolute, ~ expanded)',
  ['repoDir', 'worktreeRoot', 'sharedDir'].every((k) => fr.includes(`node <plugin>/scripts/config.js get ${k}`)) && /absolute/.test(frF), frF.slice(0, 900));
ok('S5 the plugin path is the installed copy (two levels above this SKILL.md, under $CODEX_HOME/plugins/cache/); a working clone is named',
  /two levels above this `SKILL\.md`/.test(frF) && /`\$CODEX_HOME\/plugins\/cache\/`/.test(frF) && /working clone/.test(frF), frF.slice(0, 900));
ok('S6 what is checked: the four rules with the literal path (codex execpolicy check --rules), the sandbox keys, writable_roots, the trusted repoDir',
  /codex execpolicy check --rules/.test(frF) && /sandbox_mode/.test(frF) && /approval_policy/.test(frF) && /writable_roots/.test(frF) && /trust_level/.test(frF), frF.slice(0, 900));
ok('S7 the owner gets the finished texts and one Terminal command; a copy config.toml.codis-agents-<date-time>.bak first; the session never writes into the home',
  /one (command|block) for (the )?Terminal/.test(frF) && /config\.toml\.codis-agents-/.test(fr) && /never writes into the home|writes nothing into the home/.test(frF), frF.slice(0, 900));
ok('S8 it waits for the owner, then a new session (config and rules are read at the start)', /waits for the owner/.test(frF) && /new session/.test(frF), frF);
ok('S9 an existing config.toml is merged: the other keys kept, ours changed in place, no key or table twice', /no key or table (appears )?twice|never a second copy of a key/.test(frF) && /kept/.test(frF), frF);
ok('S10 after a plugin update the same check for the rules file (the path holds the version)', /plugin update/.test(frF) && /version/.test(frF), frF);
ok('S11 a Codex version outside VERIFIED_CODEX_VERSIONS is a warning, not a refusal; do not update before it is verified',
  /codex --version/.test(frF) && /VERIFIED_CODEX_VERSIONS/.test(frF) && /warning/.test(frF), frF);
ok('S12 the hook trust is the owner\'s: /hooks (Trust: Trusted, [x]) or codex-hooks-check.js in the Terminal, never from the session',
  /\/hooks/.test(frF) && /Trust: Trusted/.test(frF) && /codex-hooks-check\.js/.test(frF), frF);
ok('S13 model and effort lines only when the owner names them', /model[^.]*only when the owner names/.test(frF), frF);

// ---- the Terminal command of the skill, run for real in a temporary home ----
const sh = (fr.match(/```sh\n([\s\S]*?)```/) || ['', ''])[1];
ok('S14 the Terminal command is one sh block that starts H=\'<coordinator home>\' and runs no codex', /^H='<coordinator home>'$/m.test(sh) && !/^\s*codex\b/m.test(sh), sh);
const RULE_RE = /^prefix_rule\(pattern=(\[[^\]]*\]), decision="allow"\)$/;
const rulesTpl = homes.split('\n').filter((l) => RULE_RE.test(l)).join('\n');
const tomlTpl = ((homes.match(/```toml\n([\s\S]*?)```/) || ['', ''])[1]).split('\n').filter((l) => !/<model>|model_reasoning_effort/.test(l)).join('\n').replace(/^\n+/, '');
if (!sh) skip('S15 the Terminal command in a temporary home', 'no sh block in the step');
else {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'codis-first-run-'));
  const H = path.join(T, 'coord home');
  const fill = (s) => s.split('<sharedDir>').join(path.join(T, 'shared')).split('<worktreeRoot>').join(path.join(T, 'wt'))
    .split('<main repository root>').join(path.join(T, 'repo')).split('<plugin>').join(ROOT);
  const toml = fill(tomlTpl), rules = fill(rulesTpl) + '\n';
  const script = sh.replace("H='<coordinator home>'", `H='${H}'`)
    .replace(/^<the full new config\.toml>$/m, toml.replace(/\n$/, '')).replace(/^<the four rules[^\n]*>$/m, rules.replace(/\n$/, ''));
  fs.mkdirSync(H);
  fs.writeFileSync(path.join(H, 'config.toml'), 'model = "old"\n');
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  const baks = fs.readdirSync(H).filter((f) => /^config\.toml\.codis-agents-\d{8}-\d{6}\.bak$/.test(f));
  ok('S15 the command exits 0 in a temporary home', r.status === 0, `${r.status} ${r.stderr}`);
  ok('S15 the old config.toml is kept as config.toml.codis-agents-<date-time>.bak', baks.length === 1 && fs.readFileSync(path.join(H, baks[0]), 'utf8') === 'model = "old"\n', fs.readdirSync(H).join(','));
  ok('S15 config.toml holds the new text', (() => { try { return fs.readFileSync(path.join(H, 'config.toml'), 'utf8') === toml.replace(/\n*$/, '\n'); } catch { return false; } })());
  const rf = path.join(H, 'rules', 'codis-agents.rules');
  ok('S15 rules/codis-agents.rules holds the four rules with the literal path', (() => { try { return fs.readFileSync(rf, 'utf8') === rules; } catch { return false; } })());
  ok('S15 nothing written outside the home', fs.readdirSync(T).join(',') === 'coord home', fs.readdirSync(T).join(','));
  if (!has('codex')) skip('S16 codex execpolicy check of the written rules', 'no codex in PATH');
  else {
    fs.mkdirSync(path.join(T, 'ep'));
    const ep = spawnSync('codex', ['execpolicy', 'check', '--rules', rf, '--', 'node', `${ROOT}/scripts/chain-run.js`, 'status', 'x'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { CODEX_HOME: path.join(T, 'ep') }) });
    let j = null;
    try { j = JSON.parse(ep.stdout); } catch { /* not JSON */ }
    ok('S16 codex execpolicy check of the written rules: chain-run.js status -> allow', !!j && j.decision === 'allow', `${ep.status} ${ep.stdout} ${ep.stderr}`.slice(0, 300));
  }
  fs.rmSync(T, { recursive: true, force: true });
}

// ---- the README ----
const readme = read('README.md');
const nr = section(readme, /^First steps on Codex/);
const nrF = flat(nr);
ok('R1 README: "First steps on Codex" inside "Codex CLI"', !!nr && section(readme, /^Codex CLI$/).includes(nr.split('\n')[0]));
ok('R2 two homes by name: ~/.codex-codis-coord (the coordinator) and ~/.codex-codis (the roles)', /~\/\.codex-codis-coord/.test(nr) && /~\/\.codex-codis`/.test(nr));
ok('R3 the personal ~/.codex is not the coordinator home: sandbox_mode and approval_policy apply to every session of a home',
  /`~\/\.codex`[^.]*not[^.]*coordinator/.test(nrF) && /sandbox_mode[^.]*approval_policy[^.]*every session/.test(nrF), nrF.slice(0, 900));
const verified = JSON.parse((read('scripts/commit-service.js').match(/VERIFIED_CODEX_VERSIONS = Object\.freeze\((\[[^\]]*\])/) || ['', '[]'])[1].replace(/'/g, '"'));
ok('R4 do not update Codex before a version is verified; the verified list equals VERIFIED_CODEX_VERSIONS',
  /[Dd]o not (update|upgrade) Codex/.test(nrF) && verified.length > 0 && verified.every((v) => nr.includes(v)), String(verified));
ok('R5 the hook trust is asked at the first start ("Trust all and continue"); /hooks shows "Unnamed hook", Trust: Trusted, [x]; space or Enter there turn the hook off',
  /Trust all and continue/.test(nrF) && /Unnamed hook/.test(nrF) && /Trust: Trusted/.test(nrF) && /\[x\]/.test(nrF) && /[Ss]pace[^.]*Enter[^.]*off/.test(nrF), nrF.slice(0, 1200));
ok('R6 codex-hooks-check.js on the personal ~/.codex exits 2 by design', /codex-hooks-check\.js[^.]*`~\/\.codex`[^.]*2|2[^.]*`~\/\.codex`[^.]*by design/.test(nrF) && /by design/.test(nrF), nrF);
ok('R7 the start folder: the worktree of the arc with .claude/codis-agents.json, CODEX_HOME=~/.codex-codis-coord codex',
  /worktree of the arc/.test(nrF) && /\.claude\/codis-agents\.json/.test(nrF) && /CODEX_HOME=~\/\.codex-codis-coord codex/.test(nr), nrF);
ok('R8 the coordinator skill offers config.toml and the rules at the first start', /First run on Codex/.test(nrF) && /offers/.test(nrF), nrF);
ok('R9 by hand: every value has its source - config.js get, "Installed plugin root" or find chain-run.js',
  ['sharedDir', 'worktreeRoot', 'repoDir'].every((k) => nr.includes(`config.js get ${k}`)) && /Installed plugin root/.test(nrF) && /find "\$CODEX_HOME" -name chain-run\.js/.test(nr), nrF);
ok('R10 by hand: absolute paths, every key once in TOML, a copy before the edit, the rules rewritten after every update',
  /absolute/.test(nrF) && /once/.test(nrF) && /copy/.test(nrF) && /after every (plugin )?update/.test(nrF), nrF);
ok('R11 the run home passes role-exec.js check', /role-exec\.js check --host codex --home ~\/\.codex-codis/.test(nr), nrF);
done();
