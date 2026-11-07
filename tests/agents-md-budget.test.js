#!/usr/bin/env node
'use strict';
// scripts/agents-md.js: the budget of Codex's project_doc_max_bytes. Codex reads the AGENTS.md files from the root down
// to its working directory and silently cuts them at one limit for the whole chain, so check and write add the chain of
// every generated file. Synthetic projects only. Every expectation below rests on codex-cli 0.166.0 prompt-input runs
// in a throwaway CODEX_HOME.
//   B1 B2  green, with the numbers named (a green exit alone proves nothing: it was green before the budget)
//   B3     a chain over the limit: red with its path, sum and limit; write on a connected project writes and exits 1
//   B4 B11 the pair around the limit, marker line and import headers counted
//   B5     no key: the default 32768, with the way out named
//   B6 B13 the forms of the key in .codex/config.toml, read by a strict scan of the top level
//   B7     foreign files and overrides in the sum; an override replaces the AGENTS.md of its directory
//   B8 B9  the personal home counts for nothing, in a pair with a sum it would change
//   B10    neighbouring chains are separate
//   B12    a nested .codex/config.toml with the key is red
//   B14    project_doc_fallback_filenames in a project config is red
//   B15    write --enable over the limit writes nothing and sets no key
//   B16    a file outside every way to a generated file is named, never counted, never silent
//   B17    an ignored file: counted on the way, unseen off it
//   B18    plan bytes for generated files, disk bytes for the others, own orphans outside the sum
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'agents-md.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-budget-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const KEY = 'project_doc_max_bytes';
const FB = 'project_doc_fallback_filenames';
const CFG = '.codex/config.toml';
const L131 = `${KEY} = 131072\n`;
let n = 0;
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const fill = (len, end = '') => (len <= end.length + 1 ? 'x'.repeat(len) : 'x'.repeat(len - end.length - 1) + end + '\n');
function put(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof c === 'object' && c.link) fs.symlinkSync(c.link, p);
    else if (typeof c === 'object' && c.dir) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, c);
  }
}
// A git project, connected unless opts.connected is false; every file is tracked except opts.untracked.
function project(files, opts = {}) {
  const dir = path.join(TMP, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '.');
  const cfg = { repoDir: '.', worktreeRoot: '/tmp/wt', sharedDir: '/tmp/shared' };
  if (opts.connected !== false) cfg.agentsMd = true;
  put(dir, Object.assign({ '.claude/codis-agents.json': JSON.stringify(cfg, null, 2) + '\n' }, files));
  const skip = new Set(opts.untracked || []);
  const names = ['.claude/codis-agents.json', ...Object.keys(files)].filter((f) => !skip.has(f) && !(files[f] && (files[f].dir)));
  git(dir, 'add', '-f', '--', ...names);
  return dir;
}
const H0 = path.join(TMP, 'home0');
fs.mkdirSync(H0);
function run(dir, args, h) {
  const env = Object.assign({}, process.env, { HOME: h || H0, CODEX_HOME: path.join(h || H0, '.codex') });
  delete env.CODIS_AGENTS_CONFIG; delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--root', dir], { encoding: 'utf8', env });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}
const write = (dir, extra = [], h) => run(dir, ['write', ...extra], h);
const check = (dir, h) => run(dir, ['check'], h);
const size = (dir, f) => fs.statSync(path.join(dir, f)).size;
const has = (dir, f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } };
const redLines = (r) => r.stderr.split('\n').filter((l) => /^agents-md: chain /.test(l));
const show = (r) => `exit ${r.status}: ${r.out.slice(0, 600)}`;
// The marker line of a generated file, in bytes: its sha256 has a fixed length, the rest follows its source.
const markerBytes = (src) => Buffer.byteLength(`<!-- codis-agents agents-md v1; source: ${src}; sha256: ${'0'.repeat(64)}; generated file: edit ${src}, then run scripts/agents-md.js write of codis-agents -->\n`);

// B1 B2: green, numbers named.
{
  const d = project({ 'CLAUDE.md': fill(78000), [CFG]: L131 });
  const w = write(d);
  const total = markerBytes('CLAUDE.md') + 78000;
  ok('B1. write: the root AGENTS.md fits: exit 0, its size on disk is what the line names', w.status === 0 && size(d, 'AGENTS.md') === total, show(w));
  ok('B1. write names the chain: chain .: <bytes>/131072', w.stdout.includes(`chain .: ${total}/131072 bytes (AGENTS.md)`), show(w));
  const c = check(d);
  ok('B1. check names the chain and exits 0', c.status === 0 && c.stdout.includes(`chain .: ${total}/131072 bytes (AGENTS.md)`), show(c));
  ok('B1. check names where the limit comes from and that it needs the trust of the project', c.stdout.includes(`limit 131072 bytes from ${CFG}`) && /trusted/.test(c.stdout), show(c));
}
{
  const d = project({ 'CLAUDE.md': fill(78000), 'sub/CLAUDE.md': fill(30000), [CFG]: L131 });
  const w = write(d);
  const sum = size(d, 'AGENTS.md') + size(d, 'sub/AGENTS.md');
  ok('B2. root 78 KB + sub 30 KB: green; the chain of sub is named with both files and their sum', w.status === 0 && sum > 108000
    && w.stdout.includes(`chain sub: ${sum}/131072 bytes (AGENTS.md, sub/AGENTS.md)`), show(w));
  ok('B2. check names it too', check(d).stdout.includes(`chain sub: ${sum}/131072 bytes (AGENTS.md, sub/AGENTS.md)`));
}

// B3: over the limit.
{
  const d = project({ 'CLAUDE.md': fill(78000), 'sub/CLAUDE.md': fill(60000), [CFG]: L131 });
  const c0 = check(d);
  ok('B3. check before any write names the chain over the limit by the plan', c0.status === 1 && redLines(c0).length === 1, show(c0));
  const w = write(d);
  const sum = size(d, 'AGENTS.md') + size(d, 'sub/AGENTS.md');
  ok('B3. c5: write on a connected project writes both files, sum over the limit', has(d, 'AGENTS.md') && has(d, 'sub/AGENTS.md') && sum > 131072, show(w));
  ok('B3. c5: and exits 1', w.status === 1, show(w));
  ok('B3. G-16: it does not say nothing was written', !/nothing written/.test(w.out), show(w));
  ok('B3. the line names the chain, the sum and the limit, and that Codex truncates silently', w.stderr.includes(`chain sub: ${sum} bytes > 131072 (Codex truncates silently)`), show(w));
  ok('B3. the line names the files and their bytes', w.stderr.includes(`AGENTS.md ${size(d, 'AGENTS.md')}, sub/AGENTS.md ${size(d, 'sub/AGENTS.md')}`), show(w));
  ok('B3. G-17: the way out: shorten the text or raise the key in the config, by its path', /shorten/.test(w.stderr) && w.stderr.includes(path.join(d, CFG)) && w.stderr.includes(KEY), show(w));
  ok('B3. the root chain alone is not red', !/chain \.:/.test(w.stderr), show(w));
  const c = check(d);
  ok('B3. check after it: the same red, not stale', c.status === 1 && c.stderr.includes(`chain sub: ${sum} bytes > 131072`) && !/stale/.test(c.out), show(c));
  const w2 = write(d);
  ok('B3. write again: nothing changes in the files, still exit 1, and it says unchanged', w2.status === 1 && /unchanged AGENTS\.md/.test(w2.stdout), show(w2));
  fs.writeFileSync(path.join(d, 'sub/CLAUDE.md'), fill(30000));
  const w3 = write(d);
  ok('B3. the text shortened: write exits 0, check green', w3.status === 0 && check(d).status === 0, show(w3));
}
{
  const d = project({ 'CLAUDE.md': fill(50), 'sub/CLAUDE.md': fill(40000) });
  put(d, { 'gone/CLAUDE.md': 'x\n' }); git(d, 'add', '--', 'gone/CLAUDE.md');
  const w0 = write(d);
  git(d, 'rm', '-q', '--cached', '--', 'gone/CLAUDE.md'); fs.unlinkSync(path.join(d, 'gone/CLAUDE.md'));
  const w = write(d);
  ok('B3. c5: an orphan of its own is removed as in a green write', w0.status === 1 && w.status === 1 && !has(d, 'gone/AGENTS.md') && /removed gone\/AGENTS\.md/.test(w.stdout), show(w));
}
{
  const d = project({ 'CLAUDE.md': fill(40000), 'b/CLAUDE.md': 'x\n', 'b/AGENTS.md': 'foreign\n', [CFG]: `${KEY} = 100\n` });
  const w = write(d);
  ok('B3. anything else in the way: nothing is written, every problem named', w.status === 1 && !has(d, 'AGENTS.md') && /conflict: b\/AGENTS\.md/.test(w.stderr) && redLines(w).length >= 1 && /nothing written/.test(w.stderr), show(w));
}

// B4 B11: the pair around the limit.
{
  const L = 1000;
  const m = markerBytes('CLAUDE.md'), ms = markerBytes('sub/CLAUDE.md');
  const pair = (delta) => project({ 'CLAUDE.md': fill(400), 'sub/CLAUDE.md': fill(L - m - 400 - ms + delta), [CFG]: `${KEY} = ${L}\n` });
  const a = pair(0), b = pair(1);
  const wa = write(a), wb = write(b);
  ok('B4. sum exactly L: green', wa.status === 0 && check(a).status === 0 && size(a, 'AGENTS.md') + size(a, 'sub/AGENTS.md') === L, show(wa));
  ok('B4. sum L+1: red', wb.status === 1 && wb.stderr.includes(`chain sub: ${L + 1} bytes > ${L}`), show(wb));
  ok('B11. the marker lines count: the same bodies without them would fit', 400 + (L - m - 400 - ms + 1) < L, '');
  const imp = 'imported text\n';
  const header = Buffer.byteLength(`\nContents of a.md:\n\n`);
  const body = 'see\n\x40a.md\n';
  const with0 = project({ 'CLAUDE.md': body, 'a.md': imp, [CFG]: `${KEY} = ${m + body.length + header + imp.length}\n` });
  const with1 = project({ 'CLAUDE.md': body, 'a.md': imp, [CFG]: `${KEY} = ${m + body.length + header + imp.length - 1}\n` });
  ok('B11. the import and its section header count: L = the file: green', write(with0).status === 0, show(check(with0)));
  ok('B11. L one byte less: red', write(with1).status === 1, show(check(with1)));
}

// B5: no key.
{
  const d = project({ 'CLAUDE.md': fill(40000) });
  const c = check(d);
  ok('B5. no config: the limit is 32768', c.status === 1 && c.stderr.includes(`> 32768`), show(c));
  ok('B5. the text names the key, the config and the trust of the project', c.stderr.includes(KEY) && c.stderr.includes(path.join(d, CFG)) && /trusted/.test(c.stderr), show(c));
  const d2 = project({ 'CLAUDE.md': fill(40000), [CFG]: 'model = "x"\n' });
  ok('B5. a config without the key: the same', check(d2).stderr.includes('> 32768'), show(check(d2)));
  const m = markerBytes('CLAUDE.md');
  const at = project({ 'CLAUDE.md': fill(32768 - m) }), over = project({ 'CLAUDE.md': fill(32769 - m) });
  write(at);
  const ca = check(at);
  ok('B5. exactly 32768: green, and the default is named', ca.status === 0 && ca.stdout.includes('chain .: 32768/32768 bytes') && /limit 32768 bytes: Codex's default/.test(ca.stdout), show(ca));
  ok('B5. 32769: red', check(over).stderr.includes('chain .: 32769 bytes > 32768'), show(check(over)));
}

// B6 B13: the forms of the key.
{
  const big = fill(40000);
  const forms = [
    ['131_072', `${KEY} = 131_072\n`, 131072],
    ['0x20000', `${KEY} = 0x20000\n`, 131072],
    ['0o400000', `${KEY} = 0o400000\n`, 131072],
    ['0b form', `${KEY} = 0b100000000000000000\n`, 131072],
    ['+131072', `${KEY} = +131072\n`, 131072],
    ['double quoted key', `"${KEY}" = 131072\n`, 131072],
    ['literal quoted key', `'${KEY}' = 131072\n`, 131072],
    ['escaped quoted key', `"project_doc\\u005fmax_bytes" = 131072\n`, 131072],
    ['comment after the value', `${KEY} = 131072 # the limit\n`, 131072],
    ['before a table', `${KEY} = 131072\n[foo]\na = 1\n`, 131072],
    ['after other keys', `model = "x"\n\n# c\n${KEY} = 131072\n`, 131072],
    ['CRLF', `model = "x"\r\n${KEY} = 131072\r\n`, 131072],
    ['BOM', `﻿${KEY} = 131072\n`, 131072],
    ['after an array with a line that looks like a table', `x = [\n[1,2],\n]\n${KEY} = 131072\n`, 131072],
    ['after a multi-line string with a line that looks like a table', `x = """\n[foo]\n"""\n${KEY} = 131072\n`, 131072],
    ['after a dated value and an inline table', `d = 1979-05-27 07:32:00\nt = { a = 1, b = "]" }\n${KEY} = 131072\n`, 131072],
  ];
  for (const [label, text, want] of forms) {
    const d = project({ 'CLAUDE.md': big, [CFG]: text });
    write(d);
    const c = check(d);
    ok(`B13. read: ${label}`, c.status === 0 && c.stdout.includes(`/${want} bytes`), show(c));
  }
  const ignored = [
    ['inside [foo]', `[foo]\n${KEY} = 131072\n`],
    ['inside a table after top-level keys', `a = 1\n[foo]\n${KEY} = 131072\n`],
    ['inside [profiles.p]', `[profiles.p]\n${KEY} = 131072\n`],
    ['inside [[arr]]', `[[arr]]\n${KEY} = 131072\n`],
    ['commented out', `# ${KEY} = 131072\n`],
    ['inside a multi-line string', `x = """\n${KEY} = 131072\n"""\n`],
    ['as a part of a dotted key', `foo.${KEY} = 131072\n`],
    ['inside an inline table', `foo = { ${KEY} = 131072 }\n`],
  ];
  for (const [label, text] of ignored) {
    const d = project({ 'CLAUDE.md': big, [CFG]: text });
    const c = check(d);
    ok(`B13. not the limit: ${label}: 32768 and red on 40 KB`, c.status === 1 && c.stderr.includes('> 32768'), show(c));
    const s = project({ 'CLAUDE.md': 'small\n', [CFG]: text });
    write(s);
    const cs = check(s);
    ok(`B13. not the limit: ${label}: the output says so`, cs.status === 0 && cs.stdout.includes('chain .:') && cs.stdout.includes(`/32768 bytes`) && new RegExp(`${CFG.replace(/\./g, '\\.')}:\\d+ .*${KEY}.*not.*top-level`).test(cs.stdout), show(cs));
  }
  const refused = [
    ['a string', `${KEY} = "131072"\n`, 1],
    ['a fraction', `${KEY} = 131072.0\n`, 1],
    ['negative', `${KEY} = -1\n`, 1],
    ['an exponent', `${KEY} = 1e6\n`, 1],
    ['a boolean', `${KEY} = true\n`, 1],
    ['0X upper case', `${KEY} = 0X20000\n`, 1],
    ['a leading zero', `${KEY} = 0131072\n`, 1],
    ['an array over lines', `${KEY} = [\n1\n]\n`, 1],
    ['a duplicate', `${KEY} = 131072\n${KEY} = 131072\n`, 2],
    ['a dotted key under it', `${KEY}.a = 1\n`, 1],
    ['a table of that name', `[${KEY}]\na = 1\n`, 1],
    ['the value on the next line', `a = 1\n${KEY} =\n131072\n`, 2],
    ['no value', `${KEY}\n`, 1],
  ];
  for (const [label, text, line] of refused) {
    const d = project({ 'CLAUDE.md': 'small\n', [CFG]: text });
    const c = check(d);
    ok(`B6. refused with its path and line: ${label}`, c.status === 1 && c.stderr.includes(`${CFG}:${line}`), show(c));
    const w = write(d);
    ok(`B6. write refuses too and writes nothing: ${label}`, w.status === 1 && !has(d, 'AGENTS.md') && /nothing written/.test(w.stderr), show(w));
  }
  const zero = project({ 'CLAUDE.md': 'small\n', [CFG]: `${KEY} = 0\n` });
  const cz = check(zero);
  ok('B13. = 0: red, Codex reads no project instructions', cz.status === 1 && /Codex reads no project instructions/.test(cz.stderr) && cz.stderr.includes(`${CFG}:1`), show(cz));
  const broken = project({ 'CLAUDE.md': 'small\n', [CFG]: `${KEY} = 131072\nnot toml\n` });
  const cb = check(broken);
  ok('B6. a file the scan cannot read: red with its line (Codex itself refuses it with rc 1)', cb.status === 1 && cb.stderr.includes(`${CFG}:2`) && /Codex refuses/.test(cb.stderr), show(cb));
  const unterminated = project({ 'CLAUDE.md': 'small\n', [CFG]: `x = """\n${KEY} = 131072\n` });
  ok('B6. an unterminated string: red', check(unterminated).status === 1 && check(unterminated).stderr.includes(CFG), show(check(unterminated)));
  const binary = project({ 'CLAUDE.md': 'small\n', [CFG]: Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x22, 0xff, 0x22, 0x0a]) });
  ok('B6. not UTF-8: red with the path', check(binary).status === 1 && check(binary).stderr.includes(`${CFG}: not UTF-8`), show(check(binary)));
  const folder = project({ 'CLAUDE.md': 'small\n', [CFG]: { dir: 1 } });
  ok('B6. a directory in place of the config: red, not an exception', check(folder).status === 1 && check(folder).stderr.includes(CFG), show(check(folder)));
  const off = project({ 'CLAUDE.md': 'small\n', [CFG]: `${KEY} = "x"\n` }, { connected: false });
  ok('B6. not connected: the config is not read, check says not used', check(off).status === 0 && /not used/.test(check(off).stdout), show(check(off)));
}

// B7: foreign files and overrides in the sum.
{
  const base = { 'CLAUDE.md': fill(78000), 'a/b/CLAUDE.md': 'leaf\n', [CFG]: L131 };
  const foreign = project({ ...base, 'a/AGENTS.md': fill(60000) });
  const c = check(foreign);
  ok('B7. a foreign AGENTS.md on the way counts: red, named in the chain', c.status === 1 && /chain a\/b: \d+ bytes > 131072/.test(c.stderr) && c.stderr.includes('a/AGENTS.md 60000'), show(c));
  const withOverride = project({ ...base, 'a/AGENTS.md': fill(60000), 'a/AGENTS.override.md': fill(100) });
  write(withOverride);
  const co = check(withOverride);
  ok('B7. an override in that directory replaces it: green, the chain names the override and not the file it replaces', co.status === 0
    && /chain a\/b: \d+\/131072 bytes \(AGENTS\.md, a\/AGENTS\.override\.md, a\/b\/AGENTS\.md\)/.test(co.stdout), show(co));
  const bigOverride = project({ ...base, 'a/AGENTS.md': 'short\n', 'a/AGENTS.override.md': fill(60000) });
  const cbo = check(bigOverride);
  ok('B7. the override counts by its own bytes, however short the file it replaces', cbo.status === 1 && cbo.stderr.includes('a/AGENTS.override.md 60000') && !cbo.stderr.includes('a/AGENTS.md '), show(cbo));
  const empty = project({ ...base, 'a/AGENTS.md': fill(60000), 'a/AGENTS.override.md': '' });
  write(empty);
  ok('B7. an empty override also replaces it (X13)', check(empty).status === 0 && check(empty).stdout.includes('a/AGENTS.override.md'), show(check(empty)));
  const blank = project({ ...base, 'a/AGENTS.override.md': fill(60000).replace(/x/g, ' ') });
  write(blank);
  ok('B7. a file of whitespace spends nothing (Codex drops it whole)', check(blank).status === 0, show(check(blank)));
  const spaced = project({ ...base, 'a/AGENTS.override.md': ' '.repeat(59000) + 'text\n' + ' '.repeat(995) });
  ok('B7. a file with text counts whole', check(spaced).stderr.includes(`a/AGENTS.override.md ${59000 + 5 + 995}`), show(check(spaced)));
  const link = project({ ...base, 'outside.txt': fill(60000), 'a/AGENTS.md': { link: '../outside.txt' } }, { untracked: ['a/AGENTS.md'] });
  const cl = check(link);
  ok('B7. a link counts by the bytes it leads to', cl.status === 1 && cl.stderr.includes('a/AGENTS.md 60000'), show(cl));
  const dirAgents = project({ ...base, 'a/AGENTS.md': { dir: 1 } });
  write(dirAgents);
  ok('B7. a directory named AGENTS.md spends nothing', check(dirAgents).status === 0, show(check(dirAgents)));
  const dirOverride = project({ ...base, 'a/AGENTS.md': fill(60000), 'a/AGENTS.override.md': { dir: 1 } });
  ok('B7. a directory named AGENTS.override.md does not replace the file (measured)', check(dirOverride).stderr.includes('a/AGENTS.md 60000'), show(check(dirOverride)));
  const dangling = project({ ...base, 'a/AGENTS.md': fill(60000), 'a/AGENTS.override.md': { link: 'nowhere' } }, { untracked: ['a/AGENTS.override.md'] });
  ok('B7. nor does a dangling link (measured)', check(dangling).stderr.includes('a/AGENTS.md 60000'), show(check(dangling)));
  const beside = project({ 'CLAUDE.md': fill(40000), 'AGENTS.override.md': fill(40000) });
  const cbs = check(beside);
  ok('B18. an override beside a generated file and a chain over the limit are named together', cbs.status === 1 && /AGENTS\.override\.md at the root replaces/.test(cbs.stderr) && cbs.stderr.includes('chain .:') && cbs.stderr.includes('AGENTS.override.md 40000'), show(cbs));
}

// B8 B9: the personal home.
{
  const h = path.join(TMP, 'home-budget');
  put(h, { '.codex/AGENTS.md': fill(30000), '.codex/config.toml': `${KEY} = 200000\n`, 'AGENTS.md': fill(30000) });
  const d = project({ 'CLAUDE.md': fill(20000) });
  write(d, [], h);
  const c = check(d, h);
  ok('B8. a personal AGENTS.md of 30 KB beside 20 KB of the project under 32768: green, the same sum as with an empty home', c.status === 0 && c.stdout.includes(`chain .: ${20000 + markerBytes('CLAUDE.md')}/32768 bytes`), show(c));
  const big = project({ 'CLAUDE.md': fill(40000) });
  const cb = check(big, h);
  ok('B9. a limit of 200000 in the personal home, none in the project, 40 KB: red at 32768', cb.status === 1 && cb.stderr.includes('> 32768'), show(cb));
  const h2 = path.join(TMP, 'home-budget2');
  put(h2, { '.codex/config.toml': `${KEY} = 100\n` });
  const p = project({ 'CLAUDE.md': fill(40000), [CFG]: L131 });
  write(p, [], h2);
  const cp = check(p, h2);
  ok('B9. a limit of 100 in the personal home, 131072 in the project: the project wins', cp.status === 0 && cp.stdout.includes('/131072 bytes'), show(cp));
}

// B10: neighbouring chains.
{
  const d = project({ 'CLAUDE.md': fill(50000), 'a/CLAUDE.md': fill(50000), 'b/CLAUDE.md': fill(50000), [CFG]: L131 });
  const w = write(d);
  const ca = size(d, 'AGENTS.md') + size(d, 'a/AGENTS.md'), cb = size(d, 'AGENTS.md') + size(d, 'b/AGENTS.md');
  ok('B10. a and b, each under the limit, over it together: green', w.status === 0 && check(d).status === 0, show(w));
  ok('B10. each chain has its own line', w.stdout.includes(`chain a: ${ca}/131072`) && w.stdout.includes(`chain b: ${cb}/131072`), show(w));
}

// B12: a nested config.
{
  const key = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', 'sub/.codex/config.toml': `${KEY} = 25000\n`, [CFG]: L131 });
  const c = check(key);
  ok('B12. sub/.codex/config.toml with the key: red with its path', c.status === 1 && c.stderr.includes('sub/.codex/config.toml:1') && /only .*root/.test(c.stderr), show(c));
  const nokey = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', 'sub/.codex/config.toml': 'model = "x"\n', [CFG]: L131 });
  write(nokey);
  ok('B12. without the key: no effect', check(nokey).status === 0, show(check(nokey)));
  const table = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', 'sub/.codex/config.toml': `[foo]\n${KEY} = 1\n`, [CFG]: L131 });
  write(table);
  ok('B12. the key in a table of it: no effect', check(table).status === 0, show(check(table)));
  const bad = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', 'sub/.codex/config.toml': `${KEY} = "x"\n`, [CFG]: L131 });
  ok('B12. a form the scan does not understand there: red', check(bad).status === 1 && check(bad).stderr.includes('sub/.codex/config.toml:1'), show(check(bad)));
  const gitignored = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', '.gitignore': '.codex/\n', 'sub/.codex/config.toml': `${KEY} = 25000\n` }, { untracked: ['sub/.codex/config.toml'] });
  ok('B12. ignored by git, on the way: still red (Codex reads it)', check(gitignored).status === 1 && check(gitignored).stderr.includes('sub/.codex/config.toml'), show(check(gitignored)));
  const off = project({ 'CLAUDE.md': 'r\n', 'other/.codex/config.toml': `${KEY} = 25000\n`, [CFG]: L131 });
  ok('B12. tracked, off the way: red as well (a session there would read it)', check(off).status === 1 && check(off).stderr.includes('other/.codex/config.toml'), show(check(off)));
  const dep = project({ 'CLAUDE.md': 'r\n', '.gitignore': 'vendor/\n', 'vendor/x/.codex/config.toml': `${KEY} = 25000\n`, [CFG]: L131 }, { untracked: ['vendor/x/.codex/config.toml'] });
  write(dep);
  ok('B12. ignored, off the way: not seen', check(dep).status === 0, show(check(dep)));
}

// B14: fallback names.
{
  const top = project({ 'CLAUDE.md': 'r\n', [CFG]: `${L131}${FB} = ["TEAM.md"]\n` });
  const c = check(top);
  ok('B14. project_doc_fallback_filenames in the root config: red with its line, and why', c.status === 1 && c.stderr.includes(`${CFG}:2`) && c.stderr.includes(FB) && /not counted/.test(c.stderr), show(c));
  ok('B14. write writes nothing', write(top).status === 1 && !has(top, 'AGENTS.md'));
  const table = project({ 'CLAUDE.md': 'r\n', [CFG]: `${L131}[foo]\n${FB} = ["TEAM.md"]\n` });
  write(table);
  ok('B14. inside a table: Codex ignores it (measured), green', check(table).status === 0, show(check(table)));
  const none = project({ 'CLAUDE.md': 'r\n', [CFG]: `${L131}${FB} = []\n` });
  write(none);
  ok('B14. an empty list names no file: green', check(none).status === 0, show(check(none)));
  const nested = project({ 'CLAUDE.md': 'r\n', 'sub/CLAUDE.md': 's\n', 'sub/.codex/config.toml': `${FB} = ["TEAM.md"]\n` });
  ok('B14. in a nested config: red too', check(nested).status === 1 && check(nested).stderr.includes('sub/.codex/config.toml:1'), show(check(nested)));
}

// B15: --enable.
{
  const d = project({ 'CLAUDE.md': fill(40000) }, { connected: false });
  const before = fs.readFileSync(path.join(d, '.claude/codis-agents.json'), 'utf8');
  const w = write(d, ['--enable']);
  ok('B15. --enable over the limit: exit 1, no AGENTS.md', w.status === 1 && !has(d, 'AGENTS.md'), show(w));
  ok('B15. no key set', fs.readFileSync(path.join(d, '.claude/codis-agents.json'), 'utf8') === before, show(w));
  ok('B15. the text names the numbers, the config and that the project stays not connected', w.stderr.includes('> 32768') && w.stderr.includes(path.join(d, CFG)) && /--enable blocked/.test(w.stderr), show(w));
  put(d, { [CFG]: L131 });
  const w2 = write(d, ['--enable']);
  ok('B15. the config first, then --enable: written, connected, check green', w2.status === 0 && has(d, 'AGENTS.md') && /"agentsMd": true/.test(fs.readFileSync(path.join(d, '.claude/codis-agents.json'), 'utf8')) && check(d).status === 0, show(w2));
  const on = project({ 'CLAUDE.md': fill(40000) });
  const w3 = write(on, ['--enable']);
  ok('B15. --enable on a project already connected: c5, the file is written and exit 1', w3.status === 1 && has(on, 'AGENTS.md') && !/nothing written/.test(w3.out), show(w3));
}

// B16: off the way.
{
  const d = project({ 'CLAUDE.md': fill(78000), 'other/AGENTS.override.md': fill(60000), [CFG]: L131 });
  write(d);
  const c = check(d);
  const sum = size(d, 'AGENTS.md') + 60000;
  ok('B16. other/AGENTS.override.md off the way: not in any sum, green', c.status === 0 && !redLines(c).length, show(c));
  ok('B16. named with what Codex would read there, and that it is over the limit', new RegExp(`note: other/AGENTS\\.override\\.md is on no way to a generated AGENTS\\.md.*${sum}/131072.*over the limit`).test(c.stdout), show(c));
  const small = project({ 'CLAUDE.md': 'r\n', 'other/AGENTS.override.md': 'o\n', 'other2/AGENTS.md': 'f\n' }, { untracked: ['other2/AGENTS.md'] });
  write(small);
  const cs = check(small);
  ok('B16. under the limit: named too, tracked and untracked', /note: other\/AGENTS\.override\.md is on no way/.test(cs.stdout) && /note: other2\/AGENTS\.md is on no way/.test(cs.stdout) && !/other\/AGENTS\.override\.md.*over the limit/.test(cs.stdout), show(cs));
  const shadow = project({ 'CLAUDE.md': 'r\n', 'other/AGENTS.md': fill(100), 'other/AGENTS.override.md': 'o\n' });
  write(shadow);
  const csh = check(shadow);
  ok('B16. both in one directory: the override is what Codex reads, and what is named', /note: other\/AGENTS\.override\.md is on no way/.test(csh.stdout) && !/note: other\/AGENTS\.md is on no way/.test(csh.stdout), show(csh));
}

// B17: ignored files.
{
  const base = { 'CLAUDE.md': fill(78000), 'a/b/CLAUDE.md': 'leaf\n', [CFG]: L131, '.gitignore': 'a/AGENTS.md\na/AGENTS.override.md\nvendor/\n' };
  const on = project({ ...base, 'a/AGENTS.md': fill(60000) }, { untracked: ['a/AGENTS.md'] });
  const c = check(on);
  ok('B17. ignored, on the way: in the sum (Codex reads it)', c.status === 1 && c.stderr.includes('a/AGENTS.md 60000'), show(c));
  const onOverride = project({ ...base, 'a/AGENTS.override.md': fill(60000) }, { untracked: ['a/AGENTS.override.md'] });
  ok('B17. an ignored override on the way too', check(onOverride).stderr.includes('a/AGENTS.override.md 60000'), show(check(onOverride)));
  const off = project({ ...base, 'vendor/x/AGENTS.md': fill(200000), 'vendor/x/AGENTS.override.md': fill(200000) }, { untracked: ['vendor/x/AGENTS.md', 'vendor/x/AGENTS.override.md'] });
  write(off);
  const co = check(off);
  ok('B17. ignored, off the way: not counted, not named', co.status === 0 && !/vendor/.test(co.out), show(co));
}

// B18: which bytes.
{
  const shrunk = project({ 'CLAUDE.md': fill(40000), [CFG]: L131 });
  write(shrunk);
  fs.writeFileSync(path.join(shrunk, '.codex/config.toml'), `${KEY} = 20000\n`);
  fs.writeFileSync(path.join(shrunk, 'CLAUDE.md'), fill(100));
  const c = check(shrunk);
  ok('B18. a stale file on disk over the limit, its plan under it: only stale', c.status === 1 && /AGENTS\.md is stale/.test(c.stderr) && !redLines(c).length, show(c));
  const grown = project({ 'CLAUDE.md': fill(100), [CFG]: `${KEY} = 20000\n` });
  write(grown);
  fs.writeFileSync(path.join(grown, 'CLAUDE.md'), fill(30000));
  const cg = check(grown);
  ok('B18. a stale file on disk under the limit, its plan over it: stale and over, in one run', cg.status === 1 && /AGENTS\.md is stale/.test(cg.stderr) && cg.stderr.includes(`chain .: ${30000 + markerBytes('CLAUDE.md')} bytes > 20000`), show(cg));
  const orphan = project({ 'CLAUDE.md': fill(78000), 'a/CLAUDE.md': fill(60000), 'a/b/CLAUDE.md': 'leaf\n', [CFG]: `${KEY} = 200000\n` });
  write(orphan);
  git(orphan, 'rm', '-q', '--cached', '--', 'a/CLAUDE.md'); fs.unlinkSync(path.join(orphan, 'a/CLAUDE.md'));
  fs.writeFileSync(path.join(orphan, CFG), L131);
  const co = check(orphan);
  ok('B18. an own orphan on the way, which write removes, is outside the sum', co.status === 1 && /generated a\/AGENTS\.md without a\/CLAUDE\.md/.test(co.stderr) && !redLines(co).length, show(co));
  const wo = write(orphan);
  ok('B18. write removes it and is green', wo.status === 0 && !has(orphan, 'a/AGENTS.md') && check(orphan).status === 0, show(wo));
  const edited = project({ 'CLAUDE.md': fill(78000), 'a/CLAUDE.md': 'mid\n', 'a/b/CLAUDE.md': 'leaf\n', [CFG]: L131 });
  write(edited);
  git(edited, 'rm', '-q', '--cached', '--', 'a/CLAUDE.md'); fs.unlinkSync(path.join(edited, 'a/CLAUDE.md'));
  fs.appendFileSync(path.join(edited, 'a/AGENTS.md'), fill(60000));
  const ce = check(edited);
  ok('B18. an edited orphan stays on disk, so it counts', ce.status === 1 && /a\/AGENTS\.md was edited by hand/.test(ce.stderr) && redLines(ce).length === 1, show(ce));
}

// G-P, G-16: the docs say what the code does.
{
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `scripts/agents-md.js`')) || '';
  ok('G-P. README: the row of agents-md names the budget and the project fallback key as red', row.includes(KEY) && row.includes('.codex/config.toml') && /project_doc_fallback_filenames` in a project config/.test(row), row.slice(-300));
  ok('G-16. README: only the fallback key of the home is left out', /`project_doc_fallback_filenames` in the home are not checked/.test(row), row.slice(-300));
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/codis-agents.schema.json'), 'utf8'));
  const d = schema.properties.agentsMd.description;
  ok('G-16. schema: agentsMd no longer speaks of the root AGENTS.md alone, and names the budget', !/root AGENTS\.md/.test(d) && d.includes(KEY), d);
  const head = fs.readFileSync(SCRIPT, 'utf8').split('const fs =')[0];
  ok('G-16. the header of the script says write writes over the budget', /over the limit/.test(head) && /writes the files and exits 1/.test(head), '');
}

done();
