#!/usr/bin/env node
'use strict';
// scripts/agents-md.js: AGENTS.md for Codex generated from the project's CLAUDE.md with its @imports expanded, and the
// check that it is not behind its sources. Synthetic projects only (English text, temporary directories).
//   G   generation of the root AGENTS.md: the text of CLAUDE.md byte for byte, then one section per import in the order
//       Claude Code reads them (depth first, each file once, four hops), import grammar as measured on Claude Code
//       2.1.318 (code spans, fences, indented code, HTML comments, escaped spaces, ~ and absolute paths)
//   G8  a missing import inside the repository - exit 1 "broken import"; outside it - exit 69 "not on this machine"
//   K   the marker line (owner, generator version, source, sha256 of the body); hand edit, stale, foreign, damaged
//   D   the connection key agentsMd: missing file when connected, not used, generated file without connection
//   E   write --enable: connects only in a consistent state; a foreign AGENTS.md blocks it
//   S   not in this part: a tracked nested CLAUDE.md and a root AGENTS.override.md are an explicit red
//   F5  an exception is never green; F6 check writes nothing
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'agents-md.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-'));
process.on('exit', () => { try { chmodAll(TMP); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
function chmodAll(d) {
  try { fs.chmodSync(d, 0o755); } catch { /* gone */ }
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) chmodAll(p); else { try { fs.chmodSync(p, 0o644); } catch { /* a link */ } }
  }
}

let n = 0;
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
// A git project: files {relative path: content}, tracked = which of them go into the index (default: all).
function project(files, opts = {}) {
  const dir = path.join(TMP, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '.');
  const cfg = { repoDir: '.', worktreeRoot: '/tmp/wt', sharedDir: '/tmp/shared' };
  if (opts.connected !== false) cfg.agentsMd = opts.agentsMd === undefined ? true : opts.agentsMd;
  if (opts.config !== false) files = Object.assign({ '.claude/codis-agents.json': JSON.stringify(cfg, null, 2) + '\n' }, files);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const tracked = opts.tracked || Object.keys(files);
  if (tracked.length) git(dir, 'add', '--', ...tracked);
  return dir;
}
function home(files) {
  const h = path.join(TMP, `h${++n}`);
  for (const [f, c] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(h, f)), { recursive: true });
    fs.writeFileSync(path.join(h, f), c);
  }
  fs.mkdirSync(h, { recursive: true });
  return h;
}
const H0 = home({});
function run(dir, args, h) {
  const env = Object.assign({}, process.env, { HOME: h || H0 });
  delete env.CODIS_AGENTS_CONFIG; delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--root', dir], { encoding: 'utf8', env });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}
const write = (dir, extra = [], h) => run(dir, ['write', ...extra], h);
const check = (dir, h) => run(dir, ['check'], h);
const agents = (dir, f = 'AGENTS.md') => { try { return fs.readFileSync(path.join(dir, f)); } catch { return null; } };
const MARK = /^<!-- codis-agents agents-md v(\d+); source: (\S+); sha256: ([0-9a-f]{64}); (.*) -->$/;
// {marker, fields, body (Buffer)} of a generated file.
function split(buf) {
  if (!buf) return null;
  const i = buf.indexOf(0x0a);
  if (i < 0) return null;
  const first = buf.slice(0, i).toString('utf8');
  const m = MARK.exec(first);
  return { first, m, body: buf.slice(i + 1) };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sect = (h, c) => `\nContents of ${h}:\n\n${c}`;
// Fixture text writes a line-leading @ as \x40 so that "\n" + "@name.md" never reads as an e-mail address to
// tests/hygiene.test.js.

// ---- G1, K1: no imports ----
{
  const src = '# Project rules\n\nRun the tests before a commit.\n';
  const d = project({ 'CLAUDE.md': src });
  const r = write(d);
  const s = split(agents(d));
  ok('G1. write exits 0 and names the file and its bytes', r.status === 0 && /wrote AGENTS\.md/.test(r.out) && /\d+ bytes/.test(r.out), r.out);
  ok('G1. AGENTS.md = the marker line + CLAUDE.md byte for byte', s && s.body.equals(Buffer.from(src)), s && s.body.toString());
  ok('K1. the marker: owner codis-agents agents-md, version, source CLAUDE.md, sha256 of the body, the hint', s && s.m
    && +s.m[1] >= 1 && s.m[2] === 'CLAUDE.md' && s.m[3] === sha(s.body) && /edit CLAUDE\.md/.test(s.m[4]) && /agents-md\.js write/.test(s.m[4]), s && s.first);
  const c = check(d);
  ok('G1. check after write is green', c.status === 0 && /^ok AGENTS\.md/m.test(c.out), c.out);
  // G11: a second write without changes does not rewrite the file.
  const mtime = () => { try { return fs.statSync(path.join(d, 'AGENTS.md')).mtimeMs; } catch { return null; } };
  const before = mtime();
  const t = Date.now(); while (Date.now() - t < 20) { /* let the clock move */ }
  const r2 = write(d);
  ok('G11. a second write with no change leaves the file (same mtime), exit 0', r2.status === 0 && /unchanged AGENTS\.md/.test(r2.out)
    && before !== null && mtime() === before, r2.out);
  // G14 (closed by the analysis check G6): write works in a main checkout, no flag needed - this project is one.
  ok('G14. write runs in a main working copy without any flag', r.status === 0);
}

// ---- G2, G3, G4, G5, G7, G9: the import grammar, depth, order, each file once ----
{
  const files = {
    'CLAUDE.md': [
      'ROOT TEXT',
      '@rules/a.md',
      'see @rules/d.md here',
      '\t@rules/tab.md',
      'Inline `@rules/b.md` code span and `` @rules/w.md `` double.',
      'mail x@rules/c.md please',
      'Parens (@rules/r.md) and link [x](@rules/lnk.md).',
      '<!-- @rules/s.md -->',
      '<!--',
      '@rules/t.md',
      '-->after @rules/k.md',
      'Text <!-- @rules/s2.md --> more',
      'Escaped @Design\\ Docs/x.md here',
      'Cycle @rules/cyc1.md',
      'Twice @rules/dbl.md and @rules/dbl.md',
      '```',
      '@rules/f.md',
      '```',
      '~~~',
      '@rules/f2.md',
      '~~~',
      '# @rules/hd.md',
      '    @rules/ind.md',
      '',
      'Last line @rules/n1.md',
      '```',
      '@rules/unclosed.md',
    ].join('\n') + '\n',
    'rules/a.md': 'A TEXT\n\x40g.md\n',
    'rules/g.md': 'G TEXT\n\x40h.md\n',
    'rules/h.md': 'H TEXT\n\x40i.md\n',
    'rules/i.md': 'I TEXT\n\x40j.md\n',
    'rules/j.md': 'J TEXT\n',
    'rules/d.md': 'D TEXT\n',
    'rules/tab.md': 'TAB TEXT\n',
    'rules/k.md': 'K TEXT\n',
    'Design Docs/x.md': 'SPACE TEXT\n',
    'rules/cyc1.md': 'CYC1\n\x40cyc2.md\n',
    'rules/cyc2.md': 'CYC2\n\x40cyc1.md\n',
    'rules/dbl.md': 'DBL\n',
    'rules/n1.md': 'N1\n\x40dbl.md\n',
    'rules/hd.md': 'HD\n',
  };
  for (const x of ['b', 'w', 'c', 'r', 'lnk', 's', 't', 's2', 'f', 'f2', 'ind', 'unclosed']) files[`rules/${x}.md`] = `NOT ${x}\n`;
  const d = project(files);
  const r = write(d);
  const s = split(agents(d));
  const want = files['CLAUDE.md']
    + sect('rules/a.md', files['rules/a.md']) + sect('rules/g.md', files['rules/g.md']) + sect('rules/h.md', files['rules/h.md'])
    + sect('rules/i.md', files['rules/i.md']) + sect('rules/d.md', files['rules/d.md']) + sect('rules/tab.md', files['rules/tab.md'])
    + sect('rules/k.md', files['rules/k.md'])
    + sect('Design Docs/x.md', files['Design Docs/x.md']) + sect('rules/cyc1.md', files['rules/cyc1.md'])
    + sect('rules/cyc2.md', files['rules/cyc2.md']) + sect('rules/dbl.md', files['rules/dbl.md']) + sect('rules/hd.md', files['rules/hd.md'])
    + sect('rules/n1.md', files['rules/n1.md']);
  ok('G2-G9. write exits 0', r.status === 0, r.out);
  ok('G2/G3/G7/G9. sections in Claude Code\'s order: depth first, each file once, a cycle stops', s && s.body.toString() === want,
    s && JSON.stringify(s.body.toString().split('\n').filter((l) => /^Contents of/.test(l))));
  const body = s ? s.body.toString() : '';
  ok('G4. no section for a code span, a double code span, x@path, (@path), a link, an HTML comment, a fence, ~~~, an indented code block, an unclosed fence',
    !/^(NOT|Contents of rules\/(b|w|c|r|lnk|s|t|s2|f|f2|ind|unclosed)\.md)/m.test(body.slice(files['CLAUDE.md'].length)), body.slice(files['CLAUDE.md'].length));
  ok('G2. the @ lines stay as text in the CLAUDE.md part', body.startsWith(files['CLAUDE.md']));
  ok('G4. an indented line right after a paragraph line continues it: its import is read (measured)', body.includes('Contents of rules/tab.md:'));
  ok('G5. an escaped space is part of the path', body.includes('Contents of Design Docs/x.md:'));
  ok('G7. the fifth hop is not expanded and the output names it', !body.includes('J TEXT') && /not expanded/.test(r.out) && /@j\.md/.test(r.out), r.out);
  ok('G8 (analysis check). two sections never share a header: the path is from the repository root', body.includes('Contents of rules/g.md:'));
}

// ---- G6: ~ imports are written as ~/..., the bytes do not depend on the home ----
{
  const files = { 'CLAUDE.md': 'R\n\x40~/kit/rules.md\n' };
  const h1 = home({ 'kit/rules.md': 'KIT RULES\n\x40more.md\n', 'kit/more.md': 'MORE\n' });
  const h2 = home({ 'kit/rules.md': 'KIT RULES\n\x40more.md\n', 'kit/more.md': 'MORE\n' });
  const d1 = project(files), d2 = project(files);
  const r1 = write(d1, [], h1), r2 = write(d2, [], h2);
  const a1 = agents(d1), a2 = agents(d2);
  ok('G6. ~ import expanded, nested relative import too', r1.status === 0 && a1 && split(a1).body.toString() === files['CLAUDE.md']
    + sect('~/kit/rules.md', 'KIT RULES\n\x40more.md\n') + sect('~/kit/more.md', 'MORE\n'), (a1 || '').toString() + r1.out);
  ok('G6. the same sources under another home give the same bytes', r2.status === 0 && a1 && a2 && a1.equals(a2));
  ok('G6. no home path in the file', a1 && !a1.toString().includes(h1));
  ok('G6. check is green under the home it was written with', check(d1, h1).status === 0);
}

// ---- G8: a missing import - inside the repository 1, outside 69; nothing is written ----
{
  const d = project({ 'CLAUDE.md': 'R\n\nsee @rules/missing.md here\n' });
  const r = write(d);
  ok('G8. missing import inside the repository: exit 1 "broken import" with file:line, nothing written',
    r.status === 1 && /broken import @rules\/missing\.md \(CLAUDE\.md:3\)/.test(r.out) && !agents(d), r.status + ' ' + r.out);
  const d2 = project({ 'CLAUDE.md': 'R\n\x40~/kit/none.md\n' });
  const r2 = write(d2);
  ok('G8. missing import outside the repository: exit 69 "not on this machine", nothing written',
    r2.status === 69 && /cannot expand @~\/kit\/none\.md \(CLAUDE\.md:2\): not on this machine/.test(r2.out) && !agents(d2), r2.status + ' ' + r2.out);
  const d3 = project({ 'CLAUDE.md': 'R\n\x40rules/a.md\n', 'rules/a.md': 'A\n\n\x40nothere.md\n' });
  const r3 = write(d3);
  ok('G8. a missing import in an imported file names that file and line', r3.status === 1 && /broken import @nothere\.md \(rules\/a\.md:3\)/.test(r3.out), r3.out);
  // Claude Code reads every whitespace-led @token outside code as an import (measured): a word, trailing punctuation
  // and quotes are attempts that find no file - a broken import here, with the hint to put it in backticks.
  for (const [what, line, tok] of [['a word', 'Ask @word for help.', 'word'], ['a trailing dot', 'End @rules/p.md.', 'rules/p.md.'],
    ['quotes', 'Q @"rules/e.md" here', '"rules/e.md"']]) {
    const dx = project({ 'CLAUDE.md': `R\n${line}\n`, 'rules/p.md': 'P\n', 'rules/e.md': 'E\n' });
    const rx = write(dx);
    ok(`G5. ${what} after @ is an import attempt Claude makes: broken import, the hint names backticks`, rx.status === 1
      && rx.out.includes(`broken import @${tok} (CLAUDE.md:2)`) && /backticks/.test(rx.out) && !agents(dx), rx.out);
  }
  const d4 = project({ 'CLAUDE.md': 'R\n\x40rules\n', 'rules/a.md': 'A\n' });
  const r4 = write(d4);
  ok('G5. an import of a directory: exit 1 "not a regular file", nothing written', r4.status === 1 && /@rules \(CLAUDE\.md:2\): not a regular file/.test(r4.out) && !agents(d4), r4.out);
  const ext = path.join(TMP, 'outside-abs.md');
  fs.writeFileSync(ext, 'ABS\n');
  const d5 = project({ 'CLAUDE.md': `R\n\x40${ext}\n` });
  const r5 = write(d5);
  ok('G6. an absolute import outside the repository and the home is expanded, header = the absolute path',
    r5.status === 0 && split(agents(d5)).body.toString() === `R\n\x40${ext}\n` + sect(ext, 'ABS\n'), r5.out);
}

// ---- G10: bytes as they are; not UTF-8 refused ----
{
  const crlf = '﻿R\r\nLine @rules/a.md\r\nno newline at the end';
  const d = project({ 'CLAUDE.md': crlf, 'rules/a.md': 'A\r\n' });
  const r = write(d);
  const s = split(agents(d));
  ok('G10. BOM, CRLF and no final newline: copied byte for byte, the section starts on its own line',
    r.status === 0 && s && s.body.equals(Buffer.from(crlf + '\n' + sect('rules/a.md', 'A\r\n'))), s && JSON.stringify(s.body.toString()));
  ok('G10. check is green on it', check(d).status === 0);
  const d2 = project({ 'CLAUDE.md': Buffer.from([0x52, 0x0a, 0xff, 0xfe, 0x0a]) });
  const r2 = write(d2);
  ok('G10. a source that is not UTF-8: exit 1 with its path, nothing written', r2.status === 1 && /CLAUDE\.md: not UTF-8/.test(r2.out) && !agents(d2), r2.out);
  const d3 = project({ 'CLAUDE.md': 'R\n\x40rules/a.md\n', 'rules/a.md': Buffer.from([0xc3, 0x28]) });
  const r3 = write(d3);
  ok('G10. an imported file that is not UTF-8: exit 1 with its path', r3.status === 1 && /rules\/a\.md: not UTF-8/.test(r3.out), r3.out);
}

// ---- G12: a failed write keeps the old file ----
{
  const d = project({ 'CLAUDE.md': 'R\n' });
  write(d);
  const old = agents(d);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'R2\n');
  fs.chmodSync(d, 0o555);
  const r = write(d);
  fs.chmodSync(d, 0o755);
  ok('G12. write into a read-only directory fails (non-zero, the error named) and the old AGENTS.md is intact',
    r.status !== 0 && /EACCES|permission/i.test(r.out) && agents(d).equals(old) && !fs.readdirSync(d).some((f) => /AGENTS\.md\./.test(f)), r.status + ' ' + r.out);
}

// ---- G13: no CLAUDE.md, untracked, tracked but deleted ----
{
  const d = project({ 'README.md': 'x\n' });
  ok('G13. connected, no CLAUDE.md: write and check exit 1 "no CLAUDE.md"', [write(d), check(d)].every((r) => r.status === 1 && /no CLAUDE\.md in /.test(r.out)));
  const d2 = project({ 'CLAUDE.md': 'R\n' }, { tracked: ['.claude/codis-agents.json'] });
  ok('G13. CLAUDE.md not tracked by git: exit 1', [write(d2), check(d2)].every((r) => r.status === 1 && /CLAUDE\.md is not tracked by git/.test(r.out)));
  const d3 = project({ 'CLAUDE.md': 'R\n' });
  fs.unlinkSync(path.join(d3, 'CLAUDE.md'));
  ok('G13. tracked CLAUDE.md deleted in the worktree: exit 1', [write(d3), check(d3)].every((r) => r.status === 1 && /tracked CLAUDE\.md is missing in the worktree/.test(r.out)));
}

// ---- K2, K3, K4: hand edit, the edit moved back into CLAUDE.md, stale ----
{
  const d = project({ 'CLAUDE.md': 'R\nline two\n' });
  write(d);
  const f = path.join(d, 'AGENTS.md');
  const gen = agents(d) || Buffer.alloc(0);
  fs.writeFileSync(f, Buffer.concat([gen, Buffer.from('an edit by hand\n')]));
  const c = check(d);
  ok('K2. body edited by hand: check exit 1 "edited by hand", the hint names CLAUDE.md and --discard-edits',
    c.status === 1 && /AGENTS\.md was edited by hand/.test(c.out) && /move the edit into CLAUDE\.md/.test(c.out) && /--discard-edits/.test(c.out) && !/stale/.test(c.out), c.out);
  const edited = agents(d);
  const w = write(d);
  ok('K2. write does not overwrite an edited file without --discard-edits (exit 1, file unchanged)', w.status === 1 && /edited by hand/.test(w.out) && agents(d).equals(edited), w.out);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'R\nline two\nan edit by hand\n');
  const w2 = write(d, ['--discard-edits']);
  const c2 = check(d);
  ok('K3. the edit moved into CLAUDE.md, write --discard-edits: check green, the file has the edit',
    w2.status === 0 && c2.status === 0 && split(agents(d)).body.toString() === 'R\nline two\nan edit by hand\n', w2.out + c2.out);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'R\nline two changed\nan edit by hand\n');
  const c3 = check(d);
  ok('K4. CLAUDE.md changed, AGENTS.md not: check exit 1 "stale" (not "edited by hand"), the command named',
    c3.status === 1 && /AGENTS\.md is stale/.test(c3.out) && /agents-md\.js write/.test(c3.out) && !/edited by hand/.test(c3.out), c3.out);
  const w3 = write(d);
  ok('K4. a plain write regenerates a stale file of its own', w3.status === 0 && check(d).status === 0, w3.out);
  // An imported file changed (a plugin update): stale too.
  const d2 = project({ 'CLAUDE.md': 'R\n\x40rules/a.md\n', 'rules/a.md': 'A\n' });
  write(d2);
  fs.writeFileSync(path.join(d2, 'rules/a.md'), 'A2\n');
  const c4 = check(d2);
  ok('K4. an imported file changed: check exit 1 "stale"', c4.status === 1 && /AGENTS\.md is stale/.test(c4.out), c4.out);
}

// ---- K5, K6: foreign or damaged AGENTS.md ----
{
  const foreign = '# Our own agent rules\n';
  const d = project({ 'CLAUDE.md': 'R\n', 'AGENTS.md': foreign });
  for (const extra of [[], ['--discard-edits']]) {
    const w = write(d, extra);
    ok(`K5. foreign AGENTS.md: write${extra.map((x) => ' ' + x).join('')} exits 1 with a conflict, the file is kept`,
      w.status === 1 && /conflict: AGENTS\.md is not generated by codis-agents/.test(w.out) && /keep it, move its rules into CLAUDE\.md or remove it/.test(w.out)
      && agents(d).toString() === foreign, w.out);
  }
  const c = check(d);
  ok('K5. foreign AGENTS.md: check exit 1 with the same conflict, never a silent pass', c.status === 1 && /conflict: AGENTS\.md is not generated/.test(c.out), c.out);
  const d2 = project({ 'CLAUDE.md': 'R\n' });
  write(d2);
  const g = (agents(d2) || '').toString();
  fs.writeFileSync(path.join(d2, 'AGENTS.md'), g.replace('agents-md v', 'agents-md version '));
  const damaged = agents(d2);
  const w2 = write(d2), c2 = check(d2);
  ok('K6. a damaged marker line is a foreign file: write and check exit 1 conflict, the file is kept',
    w2.status === 1 && c2.status === 1 && /conflict/.test(w2.out) && /conflict/.test(c2.out) && agents(d2).equals(damaged), w2.out + c2.out);
}

// ---- K7, K8: the version in the marker ----
{
  const d = project({ 'CLAUDE.md': 'R\n' });
  write(d);
  const s = split(agents(d)) || { first: '', m: [null, '1', '', '', ''], body: Buffer.alloc(0) };
  const v = s.m[1];
  fs.writeFileSync(path.join(d, 'AGENTS.md'), s.first.replace(`agents-md v${v};`, 'agents-md v0;') + '\n' + s.body.toString());
  const c = check(d);
  ok('K7. a file of another generator version with the body the current one writes: green', c.status === 0, c.out);
  const w = write(d);
  ok('K7. write then rewrites the marker to the current version', w.status === 0 && split(agents(d)).m[1] === v, w.out);
  const old = 'R\nold output\n';
  fs.writeFileSync(path.join(d, 'AGENTS.md'), `<!-- codis-agents agents-md v0; source: CLAUDE.md; sha256: ${sha(Buffer.from(old))}; ${s.m[4]} -->\n${old}`);
  const c2 = check(d);
  ok('K8. a file of another version whose body differs: exit 1 "generated by agents-md v0"', c2.status === 1 && /generated by agents-md v0/.test(c2.out), c2.out);
  const w2 = write(d);
  ok('K8. write regenerates it without a flag', w2.status === 0 && check(d).status === 0, w2.out);
}

// ---- D1, D2, D3: the connection ----
{
  const d = project({ 'CLAUDE.md': 'R\n' });
  const w0 = write(d);
  try { fs.unlinkSync(path.join(d, 'AGENTS.md')); } catch { /* not written */ }
  const c = check(d);
  ok('D1. connected and AGENTS.md deleted: check exit 1 "missing" (never "not used")', w0.status === 0 && c.status === 1 && /AGENTS\.md is missing/.test(c.out) && !/not used/.test(c.out), c.out);
  const d2 = project({ 'CLAUDE.md': 'R\n' }, { connected: false });
  const c2 = check(d2);
  ok('D2. not connected, no AGENTS.md: exit 0 "not used"', c2.status === 0 && /not used/.test(c2.out), c2.out);
  const d2b = project({ 'CLAUDE.md': 'R\n' }, { config: false });
  const c2b = check(d2b);
  ok('D2. no project config at all: exit 0 "not used"', c2b.status === 0 && /not used/.test(c2b.out), c2b.out);
  const d2c = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: false });
  ok('D2. agentsMd false: exit 0 "not used"', check(d2c).status === 0);
  const d2d = project({ 'README.md': 'x\n' }, { connected: false });
  ok('F4. not connected and no CLAUDE.md at all: exit 0 "not used"', check(d2d).status === 0);
  // D3: a generated file in a project that is not connected.
  const d3 = project({ 'CLAUDE.md': 'R\n' });
  write(d3);
  const cfg = path.join(d3, '.claude/codis-agents.json');
  const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); delete j.agentsMd; fs.writeFileSync(cfg, JSON.stringify(j));
  const c3 = check(d3);
  ok('D3. not connected but a generated AGENTS.md: exit 1 "generated AGENTS.md without connection"', c3.status === 1 && /generated AGENTS\.md without connection/.test(c3.out), c3.out);
  const d4 = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: 'yes' });
  const c4 = check(d4);
  ok('D. agentsMd that is not a boolean: exit 1 naming the key', c4.status === 1 && /agentsMd: expected boolean/.test(c4.out), c4.out);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', path.join(d, '.claude/codis-agents.json')], { encoding: 'utf8', env: Object.assign({}, process.env, { CODIS_AGENTS_MACHINE: '' }) });
  ok('D. config.js check accepts "agentsMd": true', !/agentsMd/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'config.js'), 'check', path.join(d4, '.claude/codis-agents.json')], { encoding: 'utf8' });
  ok('D. config.js check refuses "agentsMd": "yes"', r2.status === 1 && /agentsMd: expected boolean/.test(r2.stderr), r2.stderr);
}

// ---- E: write without the key, write --enable ----
{
  const d = project({ 'CLAUDE.md': 'R\n' }, { connected: false });
  const w = write(d);
  ok('E1. write in a project that is not connected: exit 1 naming --enable, nothing written', w.status === 1 && /not connected/.test(w.out) && /--enable/.test(w.out) && !agents(d), w.out);
  const w2 = write(d, ['--enable']);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.claude/codis-agents.json'), 'utf8'));
  ok('E2. write --enable: AGENTS.md written, "agentsMd": true set, check green', w2.status === 0 && agents(d) && cfg.agentsMd === true && cfg.sharedDir === '/tmp/shared'
    && check(d).status === 0, w2.out);
  const d2 = project({ 'CLAUDE.md': 'R\n', 'AGENTS.md': 'FOREIGN\n' }, { connected: false });
  const before = fs.readFileSync(path.join(d2, '.claude/codis-agents.json'), 'utf8');
  const w3 = write(d2, ['--enable']);
  ok('E3. a foreign AGENTS.md blocks --enable: exit 1 conflict, the key is not set, the file is kept', w3.status === 1 && /conflict/.test(w3.out) && /not connected/.test(w3.out)
    && fs.readFileSync(path.join(d2, '.claude/codis-agents.json'), 'utf8') === before && agents(d2).toString() === 'FOREIGN\n', w3.out);
  const d3 = project({ 'CLAUDE.md': 'R\n\x40rules/none.md\n' }, { connected: false });
  const before3 = fs.readFileSync(path.join(d3, '.claude/codis-agents.json'), 'utf8');
  const w4 = write(d3, ['--enable']);
  ok('E3. a broken import blocks --enable too: the key is not set, nothing written', w4.status === 1 && !agents(d3)
    && fs.readFileSync(path.join(d3, '.claude/codis-agents.json'), 'utf8') === before3, w4.out);
  const d4 = project({ 'CLAUDE.md': 'R\n' }, { config: false });
  const w5 = write(d4, ['--enable']);
  ok('E4. --enable with no project config: exit 1 naming .claude/codis-agents.json, nothing written', w5.status === 1 && /codis-agents\.json/.test(w5.out) && !agents(d4), w5.out);
}

// ---- S: outside this part - explicit red, never a silent green ----
{
  const d = project({ 'CLAUDE.md': 'R\n', 'sub/CLAUDE.md': 'S\n' });
  const w = write(d), c = check(d);
  ok('S1. a tracked nested CLAUDE.md: write and check exit 1 "not supported until D3-2" with its path, nothing written',
    [w, c].every((r) => r.status === 1 && /not supported until D3-2: sub\/CLAUDE\.md/.test(r.out)) && !agents(d) && !agents(d, 'sub/AGENTS.md'), w.out + c.out);
  const d1 = project({ 'CLAUDE.md': 'R\n', 'sub/CLAUDE.md': 'S\n' }, { tracked: ['.claude/codis-agents.json', 'CLAUDE.md'] });
  ok('S1. an untracked nested CLAUDE.md does not stop the root', write(d1).status === 0 && check(d1).status === 0);
  for (const content of ['OVERRIDE\n', '', '  \n']) {
    const d2 = project({ 'CLAUDE.md': 'R\n' });
    write(d2);
    fs.writeFileSync(path.join(d2, 'AGENTS.override.md'), content);
    const c2 = check(d2), w2 = write(d2);
    ok(`S2. a root AGENTS.override.md (${JSON.stringify(content)}): check and write exit 1 "not supported until D3-2" naming it`,
      [c2, w2].every((r) => r.status === 1 && /not supported until D3-2: AGENTS\.override\.md/.test(r.out)), c2.out + w2.out);
  }
}

// ---- F5, F6 ----
{
  const d = project({ 'CLAUDE.md': 'R\n' });
  write(d);
  const lock = (m) => { try { fs.chmodSync(path.join(d, 'AGENTS.md'), m); return true; } catch { return false; } };
  const locked = lock(0o000);
  const c = check(d);
  lock(0o644);
  ok('F5. check that cannot read AGENTS.md is never green: non-zero exit with the error', locked && c.status !== 0 && /EACCES|permission/i.test(c.out), c.status + ' ' + c.out);
  // F6: check writes nothing, in every state.
  const snap = (dir) => {
    const out = [];
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const f = path.join(p, e.name);
        if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); out.push(`${path.relative(dir, f)} ${st.size} ${st.mtimeMs}`); }
      }
    };
    walk(dir);
    return out.sort().join('\n');
  };
  const states = [];
  const g = project({ 'CLAUDE.md': 'R\n' }); write(g); states.push(['green', g]);
  const st = project({ 'CLAUDE.md': 'R\n' }); write(st); fs.writeFileSync(path.join(st, 'CLAUDE.md'), 'R2\n'); states.push(['stale', st]);
  const mi = project({ 'CLAUDE.md': 'R\n' }); states.push(['missing', mi]);
  const fo = project({ 'CLAUDE.md': 'R\n', 'AGENTS.md': 'F\n' }); states.push(['foreign', fo]);
  for (const [name, dir] of states) {
    const a = snap(dir);
    check(dir);
    ok(`F6. check writes nothing (${name})`, snap(dir) === a);
  }
}

// ---- usage ----
{
  const r = spawnSync(process.execPath, [SCRIPT, 'nonsense'], { encoding: 'utf8' });
  ok('usage: an unknown command exits 64', r.status === 64, r.stderr);
}

// ---- tester: cells next to the programmer's (K5 through a link, E on an existing key, D3 for an edited file, root) ----
{
  const cfgOf = (d) => fs.readFileSync(path.join(d, '.claude/codis-agents.json'), 'utf8');
  // TK5a. AGENTS.md is a symbolic link to a generated file: it is not ours (never followed), check and write refuse it
  // and leave both the link and its target as they are.
  const d = project({ 'CLAUDE.md': 'R\n' });
  write(d);
  fs.renameSync(path.join(d, 'AGENTS.md'), path.join(d, 'gen.md'));
  fs.symlinkSync('gen.md', path.join(d, 'AGENTS.md'));
  const target = fs.readFileSync(path.join(d, 'gen.md'));
  const c = check(d), w = write(d, ['--discard-edits']);
  ok('TK5a. AGENTS.md as a link to a generated file: check and write --discard-edits exit 1 conflict, link and target kept',
    [c, w].every((r) => r.status === 1 && /conflict/.test(r.out)) && fs.lstatSync(path.join(d, 'AGENTS.md')).isSymbolicLink()
      && fs.readlinkSync(path.join(d, 'AGENTS.md')) === 'gen.md' && fs.readFileSync(path.join(d, 'gen.md')).equals(target), c.out + w.out);
  // TK5b. --discard-edits never discards a foreign file.
  const f = project({ 'CLAUDE.md': 'R\n', 'AGENTS.md': 'FOREIGN\n' });
  const wf = write(f, ['--discard-edits']);
  ok('TK5b. write --discard-edits over a foreign AGENTS.md: exit 1 conflict, file kept', wf.status === 1 && /conflict/.test(wf.out)
    && agents(f).toString() === 'FOREIGN\n', wf.out);
  // TE2a. --enable where the config says "agentsMd": false: flips it to true, every other byte of the config kept.
  const e = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: false });
  const before = cfgOf(e);
  const we = write(e, ['--enable']);
  ok('TE2a. write --enable on "agentsMd": false: exit 0, only false -> true changed in the config, check green',
    we.status === 0 && cfgOf(e) === before.replace('"agentsMd": false', '"agentsMd": true') && cfgOf(e) !== before && check(e).status === 0, we.out + cfgOf(e));
  // TE2b. --enable on a one-line config without the key: valid JSON, the other keys as they were.
  const o = project({ 'CLAUDE.md': 'R\n', '.claude/codis-agents.json': '{"repoDir": ".", "sharedDir": "/tmp/shared"}' }, { connected: false });
  const wo = write(o, ['--enable']);
  let parsed = null; try { parsed = JSON.parse(cfgOf(o)); } catch { /* red below */ }
  ok('TE2b. write --enable on a one-line config: valid JSON with agentsMd true and the other keys kept, check green',
    wo.status === 0 && parsed && parsed.agentsMd === true && parsed.repoDir === '.' && parsed.sharedDir === '/tmp/shared' && check(o).status === 0, wo.out + cfgOf(o));
  // TE2c. --enable on a project already connected changes no byte of the config.
  const a = project({ 'CLAUDE.md': 'R\n' });
  const ba = cfgOf(a);
  const wa = write(a, ['--enable']);
  ok('TE2c. write --enable when already connected: exit 0, the config unchanged', wa.status === 0 && cfgOf(a) === ba && check(a).status === 0, wa.out);
  // TE3a. --enable over a generated file edited by hand (not connected yet): refused, the key not set, the edit kept.
  const gen = (() => { const x = project({ 'CLAUDE.md': 'R\n' }); write(x); return agents(x); })();
  const h = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: false });
  fs.writeFileSync(path.join(h, 'AGENTS.md'), Buffer.concat([gen, Buffer.from('an edit\n')]));
  const bh = cfgOf(h);
  const wh = write(h, ['--enable']);
  ok('TE3a. write --enable over an edited generated file: exit 1 "edited by hand", key not set, the edit kept',
    wh.status === 1 && /edited by hand/.test(wh.out) && cfgOf(h) === bh && /an edit\n$/.test(agents(h).toString()), wh.out);
  // TE3b. --enable with a tracked nested CLAUDE.md (outside this part): blocked, the key not set, nothing written.
  const nn = project({ 'CLAUDE.md': 'R\n', 'sub/CLAUDE.md': 'S\n' }, { connected: false });
  const bn = cfgOf(nn);
  const wn = write(nn, ['--enable']);
  ok('TE3b. write --enable with a tracked nested CLAUDE.md: exit 1 "not supported until D3-2", key not set, nothing written',
    wn.status === 1 && /not supported until D3-2/.test(wn.out) && cfgOf(nn) === bn && !agents(nn), wn.out);
  // TD3a. not connected, a generated file edited by hand: still red (it would go stale silently), not "not used".
  const ne = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: false });
  fs.writeFileSync(path.join(ne, 'AGENTS.md'), Buffer.concat([gen, Buffer.from('an edit\n')]));
  const cn = check(ne);
  ok('TD3a. not connected, a generated AGENTS.md edited by hand: check exit 1 "without connection"', cn.status === 1 && /without connection/.test(cn.out), cn.out);
  // TD2a. not connected, a foreign AGENTS.md: "not used", the file kept (the project does not use the generator).
  const nf = project({ 'CLAUDE.md': 'R\n', 'AGENTS.md': 'FOREIGN\n' }, { agentsMd: false });
  const cf = check(nf);
  ok('TD2a. not connected, a foreign AGENTS.md: check exit 0 "not used", file kept', cf.status === 0 && /not used/.test(cf.out) && agents(nf).toString() === 'FOREIGN\n', cf.out);
  // TG-root. --root a subdirectory of the worktree: the top level is used (AGENTS.md next to the root CLAUDE.md).
  const s = project({ 'CLAUDE.md': 'R\n', 'sub/keep.txt': 'k\n' });
  const ws = run(path.join(s, 'sub'), ['write']);
  ok('TG-root. write --root <subdirectory>: AGENTS.md written at the top level only, check from the subdirectory green',
    ws.status === 0 && agents(s) && !agents(s, 'sub/AGENTS.md') && run(path.join(s, 'sub'), ['check']).status === 0, ws.out);
  // TG-self. CLAUDE.md importing itself: no section, the line stays text (Claude Code reads each file once).
  const me = project({ 'CLAUDE.md': 'R\n\x40CLAUDE.md\n\x40./CLAUDE.md\n' });
  const wm = write(me);
  ok('TG-self. CLAUDE.md importing itself: exit 0, body is CLAUDE.md only', wm.status === 0 && split(agents(me)).body.toString() === 'R\n\x40CLAUDE.md\n\x40./CLAUDE.md\n', wm.out);
  // TU. write-only flags on check are a usage error (64) and write nothing.
  const u = project({ 'CLAUDE.md': 'R\n' }, { agentsMd: false });
  const bu = cfgOf(u);
  const u1 = run(u, ['check', '--enable']), u2 = run(u, ['check', '--discard-edits']);
  ok('TU. check --enable and check --discard-edits: exit 64, nothing written', u1.status === 64 && u2.status === 64 && !agents(u) && cfgOf(u) === bu, u1.out + u2.out);
  // TF6. check writes nothing in the states the programmer's F6 does not list.
  const snap = (dir) => {
    const out = [];
    const walk = (p) => {
      for (const e2 of fs.readdirSync(p, { withFileTypes: true })) {
        if (e2.name === '.git') continue;
        const q = path.join(p, e2.name);
        if (e2.isDirectory()) walk(q); else { const st = fs.lstatSync(q); out.push(`${path.relative(dir, q)} ${st.size} ${st.mtimeMs}`); }
      }
    };
    walk(dir);
    return out.sort().join('\n');
  };
  const ed = project({ 'CLAUDE.md': 'R\n' }); write(ed); fs.appendFileSync(path.join(ed, 'AGENTS.md'), 'x\n');
  const ov = project({ 'CLAUDE.md': 'R\n' }); write(ov); fs.writeFileSync(path.join(ov, 'AGENTS.override.md'), 'O\n');
  const br = project({ 'CLAUDE.md': 'R\n\x40rules/none.md\n' });
  const states = [['edited', ed], ['override', ov], ['broken import', br], ['not connected, foreign', nf], ['link', d]];
  for (const [name, dir] of states) {
    const b = snap(dir);
    const r = check(dir);
    ok(`TF6. check writes nothing (${name}), exit non-zero or not used`, snap(dir) === b && (r.status !== 0 || /not used/.test(r.out)), r.out);
  }
}
done();
