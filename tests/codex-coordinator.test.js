#!/usr/bin/env node
'use strict';
// p-codex-D2 (light): the coordinator on Codex. The three skills, the process rules and the README carry one text for
// both hosts (mechanism M-A): an instruction that names a tool only Claude Code has stands under a heading "On Claude
// Code", the same step for Codex under a heading "On Codex" next to it, and a Codex block names no Claude Code tool
// except as a negation ("no Monitor on this host"). On Codex the coordinator's session runs in workspace-write with
// execpolicy rules that let exactly these commands out of the sandbox: node <plugin>/scripts/chain-run.js,
// node <plugin>/scripts/train.js, git and codex exec --sandbox read-only (owner 2026-11-09, answers (a) and G3), so
// every such command of a Codex block is a plain argv with the literal plugin path - a variable, nohup, a redirection,
// a pipe or & would not match the rule. The wait is a slice of 25 s (measured 2026-11-09: the shell tool of Codex
// returns "still running" after about 30 s), for the coordinator and for a role (the host section of role-exec.js).
// Cells (analyst.md, pass 2, and the brief's "cells after E2 and (a)"): L1, L2, L7*, L8, L9, L10, L12*, L13, L14', L15,
// L17*, L18*, L22* (a)-(g), W1-W4, C1-C4, K1-K5, R1.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const flat = (s) => s.replace(/\s+/g, ' ');
const SKILLS = ['brief', 'coordinator', 'role-chain'];
const skill = Object.fromEntries(SKILLS.map((s) => [s, read(`skills/${s}/SKILL.md`)]));

// The lines of a markdown file, each with the host of its innermost heading "On Claude Code" / "On Codex" (null outside
// both); the frontmatter is skipped and a line inside a fenced block is no heading.
function blocks(text) {
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++; }
  const stack = [], out = [], heads = [];
  let fence = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6}) (.*)$/.exec(l);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const host = /^On Claude Code\b/.test(h[2]) ? 'claude' : /^On Codex\b/.test(h[2]) ? 'codex' : null;
      const parent = stack.length ? stack[stack.length - 1].id : -1;
      heads.push({ id: heads.length, level, text: h[2], host, parent, line: i });
      stack.push({ level, id: heads.length - 1 });
    }
    const hostOf = [...stack].reverse().map((s) => heads[s.id].host).find(Boolean) || null;
    out.push({ n: i + 1, text: l, host: hostOf, head: stack.length ? stack[stack.length - 1].id : -1 });
  }
  return { lines: out, heads };
}
const hostText = (text, host) => blocks(text).lines.filter((l) => l.host === host).map((l) => l.text).join('\n');
// The text of the first heading that matches re (with its sub-headings).
function section(text, re) {
  const b = blocks(text);
  const h = b.heads.find((x) => re.test(x.text));
  if (!h) return '';
  const end = b.heads.find((x) => x.line > h.line && x.level <= h.level);
  return text.split('\n').slice(h.line, end ? end.line : undefined).join('\n');
}

// ---- L22 (a)-(c): the tokens of Claude Code tools ----
const TOKENS = [/Workflow\(/, /run_in_background/, /Monitor/, /resumeFromRunId/, /agentTypePrefix/, /agent `codis-agents:analysis-checker`/];
// A negation in the same sentence before the token ("this host has no Monitor"): allowed outside a Claude block.
const negated = (l, idx) => /\b(no|not|never|without|nor)\b[^.]*$/.test(l.slice(0, idx));
for (const s of SKILLS) {
  const b = blocks(skill[s]);
  const bad = [];
  for (const l of b.lines) {
    if (l.host === 'claude') continue;
    for (const re of TOKENS) {
      const m = re.exec(l.text);
      if (m && !negated(l.text, m.index)) bad.push(`${l.n} (${l.host || 'common'}): ${m[0]}`);
    }
  }
  ok(`L22 (a)(c) skills/${s}: every Claude Code tool stands in an "On Claude Code" block (a Codex block names one only as a negation)`, !bad.length, bad.join('; '));
  // (b) every Claude Code block has a Codex block right after it, at the same level under the same parent
  const unpaired = b.heads.filter((h) => h.host === 'claude').filter((h) => {
    const next = b.heads.find((x) => x.line > h.line && x.level <= h.level);
    return !next || next.level !== h.level || next.parent !== h.parent || next.host !== 'codex';
  }).map((h) => `${h.line + 1}: ${h.text}`);
  ok(`L22 (b) skills/${s}: every "On Claude Code" block has an "On Codex" block next to it`, !unpaired.length, unpaired.join('; '));
}
ok('L22 (b) role-chain and coordinator have Claude Code blocks at all (the start, the train watch, the checker)',
  blocks(skill['role-chain']).heads.some((h) => h.host === 'claude') && blocks(skill.coordinator).heads.filter((h) => h.host === 'claude').length >= 2);

// ---- L1: the plugin root; L15: the description ----
for (const s of SKILLS) {
  const body = skill[s];
  const head = body.split('\n').slice(0, 16).join('\n');
  ok(`L1 skills/${s}: the root line - CLAUDE_PLUGIN_ROOT, else the folder two levels above this SKILL.md, written literally on Codex`,
    !/\$\{CLAUDE_PLUGIN_ROOT\}/.test(body) || (/\$\{CLAUDE_PLUGIN_ROOT\}/.test(head) && /two levels above this `SKILL\.md`/.test(head) && /literally/.test(head)), head);
  const desc = (body.match(/^description: (.*)$/m) || ['', ''])[1];
  ok(`L15 skills/${s}: the description starts "For the coordinator session; a role of the chain never runs it."`,
    desc.startsWith('For the coordinator session; a role of the chain never runs it. '), desc.slice(0, 120));
}

// ---- the role-chain skill: L2, W1-W4, L6, L8, L18*, C4 ----
const rc = skill['role-chain'];
const rcCodex = flat(hostText(rc, 'codex')), rcClaude = flat(hostText(rc, 'claude'));
ok('L2 role-chain, Codex: chain-run.js start --host codex --tasks --owner --codex-home <run home>, its answer and exits 0/64/65/70',
  /`node <plugin>\/scripts\/chain-run\.js start --host codex --tasks <[^>]+> --owner <[^>]+> --codex-home <run home>/.test(rcCodex)
  && /\{runId, runDir, pid, tasks\}/.test(rcCodex) && /\b0\b[^.]*\b64\b[^.]*\b65\b[^.]*\b70\b/.test(rcCodex), rcCodex.slice(0, 600));
ok('L2 role-chain, Claude Code: the Workflow call stays', /Workflow\(\{ name: "codis-agents:role-chain"/.test(hostText(rc, 'claude')));
ok('W1 role-chain, Codex: repeat status <runId> --wait 25 while it exits 3, the slice measured 2026-11-09 on codex 0.167.0',
  /`node <plugin>\/scripts\/chain-run\.js status <runId> --wait 25`/.test(rcCodex) && /exits 3/.test(rcCodex) && /measured 2026-11-09[^.]*0\.167\.0/.test(rcCodex), rcCodex.slice(0, 400));
ok('L22 (d) role-chain, Codex: no --wait 270 and no run_in_background', !/--wait 270/.test(rcCodex) && !/run_in_background/.test(rcCodex));
ok('W2 role-chain, Codex: "still running", a cut or an early slice is not the end of the run; only 0 or 4 end the wait; the turn does not end while the run lives',
  /still running/.test(rcCodex) && /not the end/.test(rcCodex) && /only exit 0[^.]*4/.test(rcCodex) && /[Dd]o not end (your|the) turn/.test(rcCodex), rcCodex);
ok('W3 role-chain, Codex: Esc and closing Codex cancel only the wait; a run stops only with chain-run.js stop',
  /Esc/.test(rcCodex) && /cancel only the wait/.test(rcCodex) && /chain-run\.js stop <runId>/.test(rcCodex));
ok('W4 role-chain, Codex: the line "run: <runId> <runDir> pid <pid> host codex <date>" into the brief before the first slice; a new session finds the run by it or by .locks/<key>.lock',
  /run: <runId> <runDir> pid <pid> host codex <date>/.test(rcCodex) && /before the first (slice|wait)/.test(rcCodex) && /\.locks\/<key>\.lock/.test(rcCodex)
  && /\b64\b[^.]*never start/.test(rcCodex), rcCodex);
ok('L6 role-chain, Codex: the results go by the common section "After the run"', /"After the run"/.test(rcCodex));
ok('L8 role-chain: cost of a conductor run by --journal <task folder>; the transcripts are the Workflow\'s', /chain-cost\.js[^`]*--journal <task folder>/.test(rcCodex)
  && /transcripts/.test(rcClaude), rcCodex.slice(-600));
ok('L18* role-chain, Claude Code: roles on Codex from a Claude Code session use the conductor and wait in blocking Bash slices of status --wait 270',
  /--host codex/.test(rcClaude) && /--wait 270/.test(rcClaude), rcClaude);
ok('L18* role-chain, Claude Code: before a Workflow start, resolve --list --task <k> (no live conductor run of the task); a move carries prior and priorReason',
  /resolve --list --task <k>/.test(rcClaude) && /priorReason/.test(rcClaude), rcClaude);
ok('L18* role-chain, Codex: roles on Claude Code from a Codex session with --host claude', /--host claude/.test(rcCodex));
ok('C4 role-chain, Codex: --codex-home is the run home, never the $CODEX_HOME of the session', /run home[^.]*never[^.]*\$CODEX_HOME/.test(rcCodex), rcCodex);
ok('L9 role-chain: resumeFromRunId and agentTypePrefix are Workflow only (Claude Code blocks)', /resumeFromRunId/.test(rcClaude) && /agentTypePrefix/.test(rcClaude));

// ---- the coordinator skill: C1-C3, G2-G4 rules, L7*, L10, L17*, K1-K5 ----
const co = skill.coordinator;
const coCodex = flat(hostText(co, 'codex')), coClaude = flat(hostText(co, 'claude'));
const homes = section(co, /^On Codex: homes/);
ok('C1 coordinator: a section "On Codex: homes, sandbox and rules"', !!homes);
const homesF = flat(homes);
ok('C1 coordinator: the coordinator\'s own CODEX_HOME, apart from the personal ~/.codex and the run home', /CODEX_HOME=<coordinator home>/.test(homesF) && /run home/.test(homesF));
ok('C1/G2 coordinator: config.toml of the coordinator home - workspace-write, on-request, writable_roots = [<sharedDir>, <worktreeRoot>], the main repository trusted',
  /sandbox_mode = "workspace-write"/.test(homes) && /approval_policy = "on-request"/.test(homes)
  && /writable_roots = \["<sharedDir>", "<worktreeRoot>"\]/.test(homes) && /trust_level = "trusted"/.test(homes), homes.slice(0, 800));
ok('C1/G6 coordinator: codex login, /hooks and the trust are the owner\'s steps; codex-hooks-check.js for both homes',
  /owner[^.]*codex login/.test(homesF) && /\/hooks/.test(homesF) && /codex-hooks-check\.js --codex-home/.test(homesF), homesF.slice(0, 900));
// G3/G4: the rules file
const RULE_RE = /^prefix_rule\(pattern=(\[[^\]]*\]), decision="allow"\)$/;
const rules = homes.split('\n').filter((l) => RULE_RE.test(l)).map((l) => JSON.parse(RULE_RE.exec(l)[1]));
const want = [['node', '<plugin>/scripts/chain-run.js'], ['node', '<plugin>/scripts/train.js'], ['git'], ['codex', 'exec', '--sandbox', 'read-only']];
ok('C2/G3 coordinator: exactly four rules - chain-run.js, train.js, git, codex exec --sandbox read-only', JSON.stringify(rules) === JSON.stringify(want), JSON.stringify(rules));
ok('C2/G3 coordinator: the rules go into $CODEX_HOME/rules/codis-agents.rules of the coordinator home; no rule for wait-step.js',
  /\$CODEX_HOME\/rules\/codis-agents\.rules/.test(homesF) && /no rule for `wait-step\.js`/.test(homesF), homesF.slice(0, 600));
ok('G4 coordinator: the rules name the installed copy of the plugin (the path with its version), not a working clone', /installed copy/.test(homesF) && /<version>/.test(homesF));
ok('C3 coordinator: CODEX_HOME of the coordinator home; ~/.codex only in a sentence that forbids it',
  /CODEX_HOME=<coordinator home>/.test(co) && flat(co).split(/(?<=\.) /).filter((x) => /~\/\.codex\b/.test(x)).every((x) => /\b(never|not)\b/.test(x)),
  flat(co).split(/(?<=\.) /).filter((x) => /~\/\.codex\b/.test(x)).join(' | '));
// G4: every command of a Codex block that a rule should let out is a plain argv that the rule matches
const allCodex = SKILLS.map((s) => hostText(skill[s], 'codex')).join('\n');
const spans = [...allCodex.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).concat(allCodex.split('\n').map((l) => l.trim()))
  .filter((c) => /^(node <plugin>\/scripts\/(chain-run|train)\.js|git |codex exec )/.test(c));
const argv = (c) => (c.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
const matches = (c) => want.some((p) => p.every((t, i) => argv(c)[i] === t));
const special = (c) => /\$|\bnohup\b|[|&;]|\bsetsid\b|^[A-Z_]+=/.test(c.replace(/<[^<>]*>/g, 'X').replace(/"[^"]*"/g, 'X')) || /[<>]/.test(c.replace(/<[^<>]*>/g, 'X'));
ok('G4 the Codex blocks call chain-run.js, train.js and codex exec at all', spans.some((c) => /chain-run\.js start/.test(c)) && spans.some((c) => /train\.js watch --detach/.test(c)) && spans.some((c) => /^codex exec --sandbox read-only/.test(c)), spans.join(' | '));
ok('G4 every such command of a Codex block matches a rule (a plain argv, the literal plugin path)', spans.every(matches), spans.filter((c) => !matches(c)).join(' | '));
ok('G4 no variable, nohup, redirection, pipe or & in those commands', !spans.some(special), spans.filter(special).join(' | '));
// L7*
ok('L7* coordinator, Claude Code: train.js watch in the background with run_in_background', /train\.js[^.]*watch[^.]*run_in_background/.test(coClaude), coClaude.slice(0, 400));
ok('L7* coordinator, Codex: train.js watch --detach (prints {pid, log}); its pid and train.js status on every slice', /train\.js watch --detach/.test(coCodex) && /\{pid, log\}/.test(coCodex)
  && /every slice/.test(coCodex) && /train\.js status/.test(coCodex), coCodex.slice(0, 600));
// L10
ok('L10 coordinator: on Codex the rules come from the project AGENTS.md (agentsMd), else read the file at the plugin root', /AGENTS\.md/.test(co.split('\n').slice(0, 20).join('\n')) && /agentsMd/.test(co.split('\n').slice(0, 20).join('\n')));
// L17*
const upd = flat(section(co, /^After a plugin update/));
ok('L17* coordinator, Codex: between waves, both homes, /hooks and the check again, the rules file rewritten to the new path, codex execpolicy check, a new session',
  /between waves/.test(upd) && /coordinator home/.test(upd) && /run home/.test(upd) && /\/hooks/.test(upd) && /codis-agents\.rules/.test(upd)
  && /codex execpolicy check --rules/.test(upd) && /new session|restart/.test(upd), upd.slice(0, 800));
// K1-K5
const chk = flat(section(co, /^Check the analysis/));
const chkCodex = flat(hostText(section(co, /^Check the analysis/), 'codex'));
ok('K1 coordinator, Codex: codex exec --sandbox read-only --ephemeral --output-schema <plugin>/schemas/analysis-check.schema.json -o ... -C <worktree> in the coordinator home',
  /codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema <plugin>\/schemas\/analysis-check\.schema\.json -o <check folder>\/last\.json -C <worktree> -m <model>/.test(chkCodex)
  && /coordinator home/.test(chkCodex), chkCodex.slice(0, 800));
ok('K1 coordinator, Codex: the checker runs directly under its rule and is waited for in the turn (no wait-step.js)', /still running/.test(chkCodex) && !/wait-step\.js start/.test(chkCodex), chkCodex);
ok('K2 coordinator, Codex: a copy analysis-<sha256>.md outside the worktree and the task and feature folders; the answer carries analysisSha256; the report Analysis-sha256 of the copy',
  /analysis-<sha256>\.md/.test(chkCodex) && /analysisSha256/.test(chkCodex) && /Analysis-sha256/.test(chkCodex) && /outside the worktree/.test(chkCodex), chkCodex);
ok('K3 coordinator, Codex: the coordinator appends the report with Saved-by: coordinator', /Saved-by: coordinator/.test(chkCodex));
ok('K4 coordinator, Codex: the third outcome "analysis check not run: <reason>" - nothing in .check.md, a line in the brief, not a passed check, the task stays out of the wave',
  /analysis check not run: <reason>/.test(chkCodex) && /not a passed check/.test(chkCodex) && /nothing[^.]*\.check\.md/.test(chkCodex) && /wave/.test(chkCodex), chkCodex);
ok('K4 coordinator, Codex: every cause of the third outcome is named (exit, no last.json, schema, sha, verdict against gaps, snapshot)',
  /exit/.test(chkCodex) && /no `last\.json`|no last\.json/.test(chkCodex) && /schema/.test(chkCodex) && /analysisSha256[^.]*differs|differs[^.]*analysisSha256/.test(chkCodex)
  && /significantGaps/.test(chkCodex) && /snapshot/.test(chkCodex), chkCodex);
ok('K5 coordinator, Codex: the task tells the checker its sandbox is read-only - "unverifiable (read-only sandbox)"', /unverifiable \(read-only sandbox\)/.test(chkCodex));
ok('K5 coordinator: the steps snapshot before and after stay common (outside the host blocks)', /\*\*Snapshot before\.\*\*/.test(chk) && /\*\*Snapshot after\.\*\*/.test(chk));
const sch = (() => { try { return JSON.parse(read('schemas/analysis-check.schema.json')); } catch { return null; } })();
const RE = require('../scripts/role-exec');
// codex exec takes the file as it is (--output-schema), so it is in the strict form already: the strict form of its
// source (the same schema without additionalProperties) is the file itself.
const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'additionalProperties' ? undefined : v)));
ok('K3 schemas/analysis-check.schema.json: a strict schema (the strict form of its source is the file itself)', !!sch && !RE.schemaProblems(strip(sch)).length
  && JSON.stringify(RE.strict(strip(sch))) === JSON.stringify(sch), JSON.stringify(sch));
ok('K3 the schema: analysisSha256, tasks[], verdict ready|changes-needed, significantGaps integer, report string',
  !!sch && JSON.stringify(Object.keys(sch.properties || {}).sort()) === JSON.stringify(['analysisSha256', 'report', 'significantGaps', 'tasks', 'verdict'])
  && JSON.stringify(sch.properties.verdict.enum) === JSON.stringify(['ready', 'changes-needed']) && sch.properties.significantGaps.type === 'integer'
  && sch.properties.tasks.type === 'array' && sch.properties.report.type === 'string', JSON.stringify(sch && sch.properties));

// ---- rules/multi-agent.md: L9, L12*, L13 ----
const rules0 = read('rules/multi-agent.md');
const rline = (id) => rules0.split('\n').find((l) => l.includes(`<!-- role:${id} -->`)) || '';
ok('L12* rule pauses: on Codex the coordinator waits with chain-run.js status <runId> --wait, the slice named in the skill', /on Codex the coordinator waits with `chain-run\.js status <runId> --wait`/.test(rline('pauses')), rline('pauses').slice(-500));
ok('L12* rule slots: the same remark for the coordinator', /on Codex the coordinator/.test(rline('slots')), rline('slots').slice(-400));
const wf = read('workflows/role-chain.js');
const rl = (wf.match(/const RULE_LIST = [\s\S]*?\n\]\n/) || [''])[0];
ok('L12* RULE_LIST of the workflow is not changed by the remark (a role keeps its host section)', !!rl && !/chain-run\.js status <runId>/.test(rl));
ok('L13 rules: the roles of the conductor on Codex read no project AGENTS.md (project_doc_max_bytes=0)', /project_doc_max_bytes=0/.test(flat(rules0.split('\n').slice(0, 12).join('\n'))));
ok('L9 rules: resumeFromRunId is the Claude Code Workflow only', /resumeFromRunId[^\n]*Workflow[^\n]*only|Workflow only[^\n]*resumeFromRunId/.test(rules0.split('\n').find((l) => /resumeFromRunId/.test(l)) || ''));

// ---- L14': the host section of a prog/test on codex covers the tools of the role's body; 25 s slice (G7) ----
const sect = RE.hostSection('prog', { dir: '/x/task' });
const prog = read('agents/programmer.md'), tester = read('agents/tester.md');
ok('L14\' the bodies of programmer and tester name the tools the host section replaces', /run_in_background/.test(prog) && /Monitor/.test(prog) && /git checkout/.test(prog)
  && /run_in_background/.test(tester) && /Monitor/.test(tester));
ok('L14\' the host section of prog names them absent and gives their replacement: no run_in_background, no Monitor, no blocking Bash loop; wait-step.js; git show HEAD:; git checkout refused',
  /no Bash run_in_background, no Monitor and no blocking Bash loop/.test(sect) && /wait-step\.js/.test(sect) && sect.includes('git show HEAD:<path> > <path>')
  && /git checkout and git restore are refused/.test(sect), sect);
ok('L14\'/G7 the host section waits in slices of 25 s (the shell tool of codex returns "still running" after about 30 s)', /--max 25\b/.test(sect) && !/--max 270/.test(sect) && /still running/.test(sect), sect);

// ---- R1: the README ----
const readme = read('README.md');
const sec2 = (h) => { const m = readme.match(new RegExp(`^## ${h}\\s*$[\\s\\S]*?(?=^## )`, 'm')); return m ? m[0] : ''; };
ok('R1 README: the badge says Codex CLI: preview', /Codex%20CLI-preview/.test(readme) && /alt="Codex CLI: preview"/.test(readme) && !/coming%20soon|coming soon/.test(readme));
ok('R1 README: no badge "supported" for Codex yet', !/Codex%20CLI-supported|Codex CLI: supported/.test(readme));
const prev = (() => { const m = readme.match(/^#### Preview on Codex: verified and limits\s*$([\s\S]*?)(?=^#{2,4} )/m); return m ? m[1] : ''; })();
ok('R1 README: "Preview on Codex: verified and limits" - both lists non-empty, "supported" after A2a-3c and a full run on Codex',
  !!prev && /^Verified/m.test(prev) && /^Limits/m.test(prev) && prev.split('\n').filter((l) => /^- /.test(l)).length >= 6 && /supported[^.]*A2a-3c/.test(flat(prev)), prev.slice(0, 600));
ok('R1 README Run a chain: an example of chain-run.js start --host codex', /chain-run\.js start --host codex/.test(sec2('Run a chain')));
ok('R1 README Quick start: a Codex line', /Codex/.test(sec2('Quick start')));
ok('R1 README Known gaps: no "part D2" and no "does not run on Codex yet"', !/part D2/.test(readme) && !/does not run on Codex yet/.test(readme));
const rrules = readme.split('\n').filter((l) => RULE_RE.test(l)).map((l) => JSON.parse(RULE_RE.exec(l)[1]));
ok('R1 README: the same four rules as the coordinator skill', JSON.stringify(rrules) === JSON.stringify(want), JSON.stringify(rrules));
ok('R1 README: the coordinator home config names writable_roots and the rules file', /writable_roots = \["<sharedDir>", "<worktreeRoot>"\]/.test(readme) && /rules\/codis-agents\.rules/.test(readme));
ok('R1 CHANGELOG names the coordinator on Codex', /coordinator on Codex/i.test(read('CHANGELOG.md').split('\n## ').slice(0, 2).join('\n')));
done();
