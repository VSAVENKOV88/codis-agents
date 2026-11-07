#!/usr/bin/env node
'use strict';
// AGENTS.md for Codex, generated from the project's CLAUDE.md files. Codex reads AGENTS.md as project instructions and
// does not expand Claude Code's @imports, so each generated file carries the text of its CLAUDE.md and of the files it
// imports.
//
// usage: agents-md.js write [--root <dir>] [--config <file>] [--discard-edits] [--enable]
//        agents-md.js check [--root <dir>] [--config <file>]
//   --root     a directory of the project's git worktree (default: the working directory); its top level is used
//   --config   the project config; default: the lookup of scripts/config.js from the root, without $CLAUDE_PROJECT_DIR
//
// The connection: "agentsMd": true in the project config (.claude/codis-agents.json). Connected, every expected
// AGENTS.md must exist and be fresh; not connected, check says "not used", unless a generated AGENTS.md is anywhere git
// lists (tracked or untracked): it would go stale silently. write --enable connects: it writes every file and then
// sets the key, and changes nothing when anything stops the generation.
//
// The files: one AGENTS.md next to each CLAUDE.md that git tracks (the index: a CLAUDE.md added and not committed
// counts). A tracked CLAUDE.md under .claude/ is refused (Codex does not read .claude/). An untracked CLAUDE.md is
// named and skipped; one that git ignores is not seen. Each file is one marker line, then the body. The marker names
// the owner (codis-agents agents-md), the generator version, the source (its CLAUDE.md as a path from the repository
// root, with %, whitespace, ; and > percent-encoded) and the sha256 of the body; the body is the CLAUDE.md byte for
// byte, then one section per imported file, "Contents of <path>:", a blank line and the file byte for byte. <path> is
// relative to the repository root inside it, ~/... inside the home, absolute elsewhere: the bytes do not depend on the
// machine's home directory. check compares the body with the generator's output: the version in the marker alone
// never makes it red; a file of this script whose source is another directory (moved with it) is stale.
//
// Nested files: Codex reads the AGENTS.md of every directory from the root down to its working directory, so a nested
// AGENTS.md leaves out every file the AGENTS.md of its parent directories already carry - the way Claude Code started
// in that directory reads the root CLAUDE.md with its imports, then the nested one, each file once (measured, oracle
// O-sub). A change in a parent's imports can therefore make a nested file stale.
//
// Imports, as Claude Code 2.1.318 reads them (measured with a fake model provider, no model; oracles of D3-1a and
// O-list): an @token that starts a line or follows whitespace, up to the next unescaped whitespace (a backslash-escaped
// space belongs to it); not inside a code span, a fenced block (``` or ~~~, unclosed: to the end of its container), an
// indented code block or an HTML comment. Block quotes and list items are containers as in CommonMark: a list item's
// content starts after its marker and the spaces that follow it (one space, when five or more follow), a later line
// belongs to the item when it is indented at least that far, is blank or continues a paragraph lazily, and indented
// code and fences count their indent from the content of the innermost open container. The path is relative to the
// importing file, ~/ is the home, an absolute path stays. Depth first, each file at most once (a cycle stops), at most
// four hops from its CLAUDE.md. Claude Code drops an import whose file is missing without a word; here that is an
// error: inside the repository exit 1 ("broken import"), outside it 69 (the file is not on this machine - an
// environment, not the project). An import of a directory is exit 1. An import of a file this script generates, or of
// an AGENTS.override.md, is exit 1: the generated file would grow with every write.
//
// Codex reads AGENTS.override.md in place of the AGENTS.md of its directory, even when it is empty: one next to a
// generated file is red (looked up on disk, so one git ignores counts); one in a directory on the way to a generated
// file is named. An AGENTS.md of this script with no tracked CLAUDE.md beside it is removed by write; edited by hand,
// it is kept and red (--discard-edits does not remove it); a foreign one there is kept and named.
//
// The budget: Codex silently cuts the AGENTS.md files it reads from the root down to its working directory at one
// limit for the whole chain (measured on codex 0.166.0). The limit is the top-level project_doc_max_bytes of the root
// .codex/config.toml, 32768 without one; it counts only while the project is trusted in the Codex home, which is not
// looked at, and neither is anything else of the home: a limit there loses to the project's, a personal AGENTS.md is
// outside the sum. The file is read by a strict scan of its structure, never by a pattern on the text: the key in a
// table, in a comment or inside a string does nothing in Codex, and is named. A value that is not a positive TOML
// integer, a duplicate, a dotted key or table of that name, or a file the scan cannot read is exit 1 with its line;
// Codex itself stops with rc 1 on most of these. 0 is red too: Codex then reads no project instructions. The nearest
// config to the working directory wins, so one limit holds only with no nested config setting the key: one that does
// is red. project_doc_fallback_filenames in a project config is red: the files it names spend the same budget and are
// not counted here.
//
// A chain is the directories on the way from the root to a generated file. In each one Codex takes AGENTS.override.md,
// else AGENTS.md: a generated file by the bytes write would write, any other by its bytes on disk through a link (a
// directory or a dangling link is not read; a file of whitespace spends nothing), a file of this script with no
// tracked CLAUDE.md beside it is outside the sum, since write removes it. A file git ignores counts on the way and is
// not seen off it (a dependency's own file). A file git lists off every way is outside every sum and named with what
// Codex would read in its directory.
//
// write builds every file in memory first and changes nothing while anything is in the way (a foreign file, a hand
// edit, a broken import, an override, a config it cannot use), naming each. A chain over the limit alone does not stop
// it on a connected project: the text is right and the limit is what must change, so it writes the files and exits 1.
// write --enable over the limit writes nothing and sets no key: connecting ends with a green check or not at all.
//
// Exit: 0 green or not used; 1 problems; 69 an import not on this machine; 64 usage; 70 an unexpected error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('./config');

const VERSION = 1;
const MAX_HOPS = 4;
const SOURCE = 'CLAUDE.md';
const TARGET = 'AGENTS.md';
const OVERRIDE = 'AGENTS.override.md';
const CODEX_CONFIG = '.codex/config.toml';
const LIMIT_KEY = 'project_doc_max_bytes';
const FALLBACK_KEY = 'project_doc_fallback_filenames';
const DEFAULT_LIMIT = 32768;
const MARK = /^<!-- codis-agents agents-md v(\d+); source: (\S+); sha256: ([0-9a-f]{64}); (.*) -->$/;
const hint = (src) => `generated file: edit ${src}, then run scripts/agents-md.js write of codis-agents`;

class Fail extends Error {
  constructor(code, lines) { super([].concat(lines).join('\n')); this.code = code; this.lines = [].concat(lines); }
}

function usage() {
  console.error('usage: agents-md.js write [--root <dir>] [--config <file>] [--discard-edits] [--enable]\n'
    + '       agents-md.js check [--root <dir>] [--config <file>]');
  process.exit(64);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'write' && cmd !== 'check') usage();
  const o = { cmd, root: process.cwd(), config: null, discard: false, enable: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root' && rest[i + 1]) o.root = path.resolve(rest[++i]);
    else if (a === '--config' && rest[i + 1]) o.config = path.resolve(rest[++i]);
    else if (a === '--discard-edits' && cmd === 'write') o.discard = true;
    else if (a === '--enable' && cmd === 'write') o.enable = true;
    else usage();
  }
  return o;
}

function gitTop(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
// git ls-files of the root: the index, or (others) the untracked files git does not ignore.
function lsFiles(root, others) {
  const args = ['-C', root, 'ls-files', '-z'].concat(others ? ['--others', '--exclude-standard'] : []);
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}
// Every AGENTS.md git ignores, at any depth (ignored folders too): Codex reads a file whatever git thinks of it, so a
// generated one is looked for here as well as in the lists above.
function lsIgnored(root, name) {
  const args = ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', `:(glob)**/${name}`];
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files --ignored in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

// {file, on}: the project config and its agentsMd. A value that is not a boolean is an error.
function connection(root, explicit) {
  let file = explicit;
  if (!file) {
    const env = Object.assign({}, process.env); delete env.CLAUDE_PROJECT_DIR;
    file = config.find(root, env);
  }
  if (!file) return { file: null, on: false };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Fail(1, `${file}: ${e.message}`); }
  const v = raw && typeof raw === 'object' ? raw.agentsMd : undefined;
  if (v !== undefined && typeof v !== 'boolean') throw new Fail(1, `${file}: agentsMd: expected boolean, not ${JSON.stringify(v)}`);
  return { file, on: v === true, raw };
}

// The leading whitespace of s, which starts at column col, in columns (a tab moves to the next multiple of four).
function lead(s, col = 0) {
  let c = col;
  for (const ch of s) { if (ch === ' ') c++; else if (ch === '\t') c += 4 - (c % 4); else break; }
  return c - col;
}
// s (starting at column col) without n columns of its leading whitespace: {text, col}; a tab the cut splits leaves its
// remaining columns as spaces.
function cut(s, col, n) {
  let c = col, i = 0;
  while (i < s.length && c - col < n) {
    if (s[i] === ' ') { c++; i++; continue; }
    if (s[i] !== '\t') break;
    const w = 4 - (c % 4);
    if (c - col + w > n) return { text: ' '.repeat(c - col + w - n) + s.slice(i + 1), col: col + n };
    c += w; i++;
  }
  return { text: s.slice(i), col: c };
}
const blank = (s) => /^[ \t]*$/.test(s);
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const BREAK = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
// A block quote marker opening s: {text, col} after the > and one following space, or null.
function quoteMarker(s, col) {
  if (lead(s, col) > 3 || s.trimStart()[0] !== '>') return null;
  const at = s.indexOf('>');
  const c = col + lead(s, col) + 1;
  const t = s.slice(at + 1);
  return t[0] === ' ' ? { text: t.slice(1), col: c + 1 } : t[0] === '\t' ? cut(t, c, 1) : { text: t, col: c };
}
// A list item marker opening s (at most three columns in): {marker, after: index past it, cols: columns up to its end}.
function listMarker(s, col) {
  const n = lead(s, col);
  if (n > 3) return null;
  const t = s.trimStart();
  const m = /^([-+*]|\d{1,9}[.)])(?=[ \t]|$)/.exec(t);
  if (!m || BREAK.test(t)) return null;
  return { marker: m[1], after: s.length - t.length + m[1].length, cols: n + m[1].length };
}
// A line that starts a block of its own, so it cannot continue a paragraph lazily.
function blockStart(s, col) {
  if (lead(s, col) > 3) return false;
  const t = s.trimStart();
  if (t[0] === '>' || /^#{1,6}([ \t]|$)/.test(t) || FENCE.test(t) || BREAK.test(t)) return true;
  const m = listMarker(s, col);
  return !!m && !blank(s.slice(m.after)) && /^([-+*]|1[.)])$/.test(m.marker);
}

// The @tokens Claude Code reads as imports: [{token, line}] (token as written, line from 1).
function importTokens(text) {
  const out = [];
  const stack = []; // open containers, outermost first: {kind: 'quote'} or {kind: 'item', offset, content}
  let fence = null; // {ch, len, depth} of the open fenced block; depth = the number of containers around it
  let inComment = false;
  let prev = 'blank'; // the previous line in the innermost container: blank, para (paragraph text) or other
  text.split('\n').forEach((raw, i) => {
    let t = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let col = 0;
    if (!inComment) {
      // The open containers this line continues.
      let matched = 0;
      for (const c of stack) {
        if (c.kind === 'quote') {
          const q = quoteMarker(t, col);
          if (!q) break;
          ({ text: t, col } = q);
        } else if (blank(t)) {
          if (!c.content) break; // an item that opened empty ends at a blank line
        } else {
          if (lead(t, col) < c.offset) break;
          ({ text: t, col } = cut(t, col, c.offset));
        }
        matched++;
      }
      if (fence) {
        if (matched >= fence.depth) {
          const f = lead(t, col) <= 3 ? FENCE.exec(t.trimStart()) : null;
          if (f && f[1][0] === fence.ch && f[1].length >= fence.len && blank(f[2])) { fence = null; prev = 'other'; }
          return;
        }
        fence = null; // its container ended, and the fence with it
      }
      const lazy = matched < stack.length && prev === 'para' && !blank(t) && !blockStart(t, col);
      if (!lazy) {
        if (matched < stack.length) { stack.length = matched; prev = 'blank'; }
        // The containers this line opens.
        for (;;) {
          const q = quoteMarker(t, col);
          if (q) { ({ text: t, col } = q); stack.push({ kind: 'quote' }); prev = 'blank'; continue; }
          const m = listMarker(t, col);
          if (!m) break;
          const rest = t.slice(m.after);
          if (prev === 'para' && (blank(rest) || !/^([-+*]|1[.)])$/.test(m.marker))) break; // cannot interrupt a paragraph
          const mcol = col + m.cols;
          const sp = lead(rest, mcol);
          let offset, next;
          if (blank(rest)) { offset = m.cols + 1; next = { text: '', col: mcol }; }
          else if (sp >= 5) { offset = m.cols + 1; next = cut(rest, mcol, 1); }
          else { offset = m.cols + sp; next = cut(rest, mcol, sp); }
          stack.push({ kind: 'item', offset, content: false });
          ({ text: t, col } = next); prev = 'blank';
        }
        if (blank(t)) { prev = 'blank'; return; }
        const inner = stack[stack.length - 1];
        if (inner && inner.kind === 'item') inner.content = true;
        if (lead(t, col) <= 3) {
          const f = FENCE.exec(t.trimStart());
          if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length, depth: stack.length }; prev = 'other'; return; }
        }
        // An indented line continues a paragraph; it is code only after a blank line or a block that is not a paragraph.
        if (lead(t, col) >= 4 && prev !== 'para') { prev = 'other'; return; }
      }
    }
    // The visible text: code spans and HTML comments become a space (they end a token and are never scanned).
    let vis = '';
    for (let j = 0; j < t.length;) {
      if (inComment) {
        const e = t.indexOf('-->', j);
        if (e < 0) { j = t.length; break; }
        inComment = false; j = e + 3; vis += ' ';
        continue;
      }
      if (t.startsWith('<!--', j)) { inComment = true; j += 4; vis += ' '; continue; }
      if (t[j] === '\\' && t[j + 1] === '`') { vis += '\\`'; j += 2; continue; }
      if (t[j] === '`') {
        let n = 0; while (t[j + n] === '`') n++;
        let k = j + n, close = -1;
        while (k < t.length) {
          const s = t.indexOf('`', k);
          if (s < 0) break;
          let m = 0; while (t[s + m] === '`') m++;
          if (m === n) { close = s; break; }
          k = s + m;
        }
        if (close >= 0) { vis += ' '; j = close + n; } else { vis += t.slice(j, j + n); j += n; }
        continue;
      }
      vis += t[j++];
    }
    for (const m of vis.matchAll(/(^|\s)@((?:[^\s\\]|\\ )+)/g)) out.push({ token: m[2], line: i + 1 });
    prev = /^\s*$/.test(vis) ? 'other' : /^ {0,3}#{1,6}(\s|$)/.test(t) ? 'other' : 'para';
  });
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(buf, label) {
  try { return decoder.decode(buf); } catch { throw new Fail(1, `${label}: not UTF-8`); }
}
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
// The path of f in the directory d, from the repository root ('.' is the root).
const rel = (d, f) => (d === '.' ? f : `${d}/${f}`);
const enc = (p) => p.replace(/[%\s;>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
const dec = (p) => { try { return decodeURIComponent(p); } catch { return null; } };

// The body of <root>/<last of chain>/AGENTS.md: {body (Buffer), files (imported count), notes}. chain: the directories
// with a tracked CLAUDE.md from the root down to that one, parents first; what the parents carry is not repeated.
// refused: the absolute paths of the generated files, which no import may name (nor any AGENTS.override.md).
function generate(root, home, chain, refused) {
  const label = (abs) => (inside(root, abs) ? path.relative(root, abs).split(path.sep).join('/')
    : home && inside(home, abs) ? '~/' + path.relative(home, abs).split(path.sep).join('/') : abs);
  const generated = (where, abs) => new Fail(1, `${where} imports a generated ${label(abs)}: Codex reads it from its own directory, and the import would grow it with every write; remove the import`);
  const seen = new Set();
  let parts, last, notes, files, own;
  const push = (b) => { if (own && b.length) { parts.push(b); last = b[b.length - 1]; } };
  const walk = (file, name, text, depth) => {
    for (const { token, line } of importTokens(text)) {
      const p = token.replace(/\\ /g, ' ');
      const abs = p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(path.dirname(file), p);
      if (seen.has(abs)) continue;
      const where = `${name}:${line}`;
      if (depth >= MAX_HOPS) { if (own) notes.push(`not expanded: @${token} (${where}) is deeper than ${MAX_HOPS} hops from ${SOURCE}, as in Claude Code`); continue; }
      if (refused.has(abs)) throw generated(where, abs);
      if (path.basename(abs).toLowerCase() === OVERRIDE.toLowerCase()) {
        throw new Fail(1, `${where} imports ${label(abs)}: Codex reads it in place of an AGENTS.md, and the import would grow the generated file with every write; remove the import`);
      }
      let st;
      try { st = fs.statSync(abs); } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Fail(1, `cannot read @${token} (${where}): ${e.message}`);
        if (inside(root, abs)) {
          throw new Fail(1, `broken import @${token} (${where}): no file ${label(abs)}; Claude Code reads every @word after a space outside code as an import - fix the path, or put the text in backticks if it is not an import`);
        }
        throw new Fail(69, `cannot expand @${token} (${where}): not on this machine (${abs})`);
      }
      if (!st.isFile()) throw new Fail(1, `cannot import @${token} (${where}): not a regular file (${label(abs)})`);
      // Another spelling of a generated file (a link, another case on a case-insensitive disk) is that file.
      if (refused.has(fs.realpathSync.native(abs))) throw generated(where, abs);
      seen.add(abs);
      const hdr = label(abs);
      const buf = fs.readFileSync(abs);
      const t = decode(buf, hdr);
      push(Buffer.from(`${last === 0x0a ? '' : '\n'}\nContents of ${hdr}:\n\n`));
      push(buf);
      if (own) files++;
      walk(abs, hdr, t, depth + 1);
    }
  };
  chain.forEach((d, k) => {
    own = k === chain.length - 1;
    parts = []; last = 0x0a; notes = []; files = 0;
    const file = path.join(root, d, SOURCE);
    const top = fs.readFileSync(file);
    push(top);
    seen.add(file);
    walk(file, rel(d, SOURCE), decode(top, rel(d, SOURCE)), 0);
  });
  return { body: Buffer.concat(parts), files, notes };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileOf = (src, body) => Buffer.concat([Buffer.from(`<!-- codis-agents agents-md v${VERSION}; source: ${enc(src)}; sha256: ${sha(body)}; ${hint(enc(src))} -->\n`), body]);

// An AGENTS.md on disk: {state: missing | foreign | edited | ours, version, source (decoded), body, buf}.
function existing(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { state: 'missing' }; throw e; }
  if (!st.isFile()) return { state: 'foreign' };
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  const m = nl < 0 ? null : MARK.exec(buf.slice(0, nl).toString('utf8'));
  const source = m && dec(m[2]);
  if (!m || !source || path.posix.basename(source) !== SOURCE) return { state: 'foreign', buf };
  const body = buf.slice(nl + 1);
  return { state: sha(body) === m[3] ? 'ours' : 'edited', version: +m[1], source, body, buf };
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* not created */ } throw e; }
}

// The config text with "agentsMd": true, its other bytes kept; null when the edit cannot be made safely.
function enabledConfig(file, raw) {
  const txt = fs.readFileSync(file, 'utf8');
  let next;
  if (raw.agentsMd === false) {
    const re = /("agentsMd"\s*:\s*)false/g;
    if ((txt.match(re) || []).length !== 1) return null;
    next = txt.replace(re, '$1true');
  } else {
    const open = /^\s*\{/.exec(txt);
    if (!open) return null;
    const indent = (/\{[ \t]*\r?\n([ \t]*)"/.exec(txt) || [null, '  '])[1];
    const empty = Object.keys(raw).length === 0;
    next = txt.slice(0, open[0].length) + `\n${indent}"agentsMd": true${empty ? '\n' : ','}` + txt.slice(open[0].length);
  }
  let parsed;
  try { parsed = JSON.parse(next); } catch { return null; }
  const keys = new Set([...Object.keys(raw), 'agentsMd']);
  if (parsed.agentsMd !== true || Object.keys(parsed).length !== keys.size) return null;
  for (const k of keys) if (k !== 'agentsMd' && JSON.stringify(parsed[k]) !== JSON.stringify(raw[k])) return null;
  return next;
}

const TOML_NAMED_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

// The statements of a TOML text: [{kind: 'table', path, line} | {kind: 'key', path, line, raw, top}]; raw is the value
// as written, top says it is before the first table header. It reads the structure the top level depends on (strings,
// arrays, inline tables, comments, the escapes of one-line strings), not the types of scalars; a key comes back decoded.
// Throws {tomlLine, message} where the structure breaks.
function tomlStatements(text) {
  const out = [];
  let i = 0, line = 1, top = true;
  const bad = (why) => { const e = new Error(why); e.tomlLine = line; throw e; };
  const ws = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const comment = () => { if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++; };
  const blanks = () => {
    for (;;) {
      ws(); comment();
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      if (text[i] !== '\n') return;
      i++; line++;
    }
  };
  const endOfLine = () => {
    ws(); comment();
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    if (i < text.length && text[i] !== '\n') bad('expected the end of the line');
  };
  // The escapes of a TOML basic string, the set codex-cli 0.166.0 accepts (measured): a key spelled with them is the same
  // key for Codex, and any other escape, or a code that is no Unicode scalar value, makes it refuse the file.
  const basicString = (raw) => raw.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([btnfre"\\])|)/g, (seq, x, u, U, named) => {
    if (named) return TOML_NAMED_ESCAPES[named];
    const code = parseInt(x || u || U, 16);
    if (Number.isNaN(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) bad('a string has an escape TOML does not define');
    return String.fromCodePoint(code);
  });
  const oneLine = (q) => {
    let j = i + 1;
    for (;; j++) {
      if (j >= text.length || text[j] === '\n') bad('unterminated string');
      if (q === '"' && text[j] === '\\') { j++; continue; }
      if (text[j] === q) break;
    }
    const raw = text.slice(i + 1, j);
    i = j + 1;
    return q === '"' ? basicString(raw) : raw;
  };
  const bare = /[A-Za-z0-9_-]+/y;
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (text[i] === '"' || text[i] === "'") parts.push(oneLine(text[i]));
      else {
        bare.lastIndex = i;
        const m = bare.exec(text);
        if (!m) bad('expected a key');
        parts.push(m[0]); i += m[0].length;
      }
      ws();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  const string = () => {
    const q = text[i];
    const fence = q + q + q;
    if (!text.startsWith(fence, i)) { oneLine(q); return; }
    i += 3;
    for (;;) {
      if (i >= text.length) bad('unterminated string');
      if (q === '"' && text[i] === '\\') { if (text[i + 1] === '\n') line++; i += 2; continue; }
      if (text[i] === '\n') { line++; i++; continue; }
      if (text.startsWith(fence, i)) { i += 3; while (text[i] === q) i++; return; }
      i++;
    }
  };
  const list = (close, item) => {
    i++;
    for (;;) {
      blanks();
      if (i >= text.length) bad(`expected ${close}`);
      if (text[i] === close) { i++; return; }
      item();
      blanks();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === close) { i++; return; }
      bad(`expected , or ${close}`);
    }
  };
  const value = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '"' || c === "'") string();
    else if (c === '[') list(']', value);
    else if (c === '{') list('}', () => { key(); ws(); if (text[i] !== '=') bad('expected ='); i++; value(); });
    else {
      while (i < text.length && !'\n\r#,]}'.includes(text[i])) i++;
      if (!text.slice(start, i).trim()) bad('expected a value');
    }
    return text.slice(start, i).trim();
  };
  for (;;) {
    blanks();
    if (i >= text.length) return out;
    const at = line;
    if (text[i] === '[') {
      const close = text[i + 1] === '[' ? ']]' : ']';
      i += close.length;
      const p = key();
      ws();
      if (!text.startsWith(close, i)) bad(`expected ${close}`);
      i += close.length;
      endOfLine();
      out.push({ kind: 'table', path: p, line: at });
      top = false;
      continue;
    }
    const p = key();
    ws();
    if (text[i] !== '=') bad('expected key = value');
    i++;
    const raw = value();
    endOfLine();
    out.push({ kind: 'key', path: p, line: at, raw, top });
  }
}

// A whole number that is not negative, in a form TOML and Codex both read (measured), or null.
function tomlPositive(raw) {
  if (!/^(\+?(0|[1-9](_?[0-9])*)|0x[0-9a-fA-F](_?[0-9a-fA-F])*|0o[0-7](_?[0-7])*|0b[01](_?[01])*)$/.test(raw)) return null;
  const v = Number(raw.replace(/_/g, '').replace(/^\+/, ''));
  return Number.isSafeInteger(v) ? v : null;
}

// What a Codex config says about the budget: null when there is no such file; else {limit, line, unusable, problems,
// mention}. limit: the value of a readable top-level key; unusable: no limit can be told from the file; mention: the
// line of the key where Codex ignores it.
function codexConfig(root, rel_) {
  const file = path.join(root, rel_);
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    return { limit: null, unusable: true, mention: null, problems: [`${rel_}: cannot read: ${e.message}`] };
  }
  const r = { limit: null, line: null, unusable: false, problems: [], mention: null };
  const refuse = (l) => { r.unusable = true; r.problems.push(l); };
  let text;
  try { text = decode(buf, rel_); } catch (e) { refuse(e.lines[0]); return r; }
  let list;
  try { list = tomlStatements(text); } catch (e) {
    if (e.tomlLine === undefined) throw e;
    refuse(`${rel_}:${e.tomlLine}: ${e.message}: Codex refuses a file it cannot parse; fix it`);
    return r;
  }
  let seen = false;
  for (const s of list) {
    const isTop = s.kind === 'table' || s.top;
    const head = s.path[0];
    if (isTop && head === FALLBACK_KEY && !(s.kind === 'key' && s.path.length === 1 && /^\[\s*\]$/.test(s.raw))) {
      r.problems.push(`${rel_}:${s.line} sets ${FALLBACK_KEY}: the files it names spend the same budget and are not counted here; remove the key`);
    }
    if (!isTop || head !== LIMIT_KEY) continue;
    const at = `${rel_}:${s.line}: ${LIMIT_KEY}`;
    if (s.kind === 'table' || s.path.length > 1) { refuse(`${at} is not a value here; write it as a top-level ${LIMIT_KEY} = <bytes>`); seen = true; continue; }
    if (seen) { refuse(`${at} is set twice`); continue; }
    seen = true;
    const v = tomlPositive(s.raw);
    if (v === 0) refuse(`${at} = 0: Codex reads no project instructions at all; set a limit or remove the key`);
    else if (v === null) refuse(`${at} = ${s.raw.split('\n')[0]} cannot be read: expected a positive whole number`);
    else { r.limit = v; r.line = s.line; }
  }
  if (!seen) {
    const at = text.indexOf(LIMIT_KEY);
    if (at >= 0) r.mention = text.slice(0, at).split('\n').length;
  }
  return r;
}

// The directories from the root down to d.
function waysTo(d) {
  if (d === '.') return ['.'];
  const parts = d.split('/');
  return ['.'].concat(parts.map((_, k) => parts.slice(0, k + 1).join('/')));
}
// The bytes Codex spends on a file on disk; null when it does not read it (none, a directory, a dangling link).
function diskBytes(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const b = fs.readFileSync(file);
  return b.toString('utf8').trim() === '' ? 0 : b.length;
}

const dirOf = (f) => path.posix.dirname(f);
const named = (list, name) => [...new Set(list.filter((f) => path.posix.basename(f) === name))].sort();
const lexists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };

// The budget of every chain: {problems (the configs), over (the chains above the limit), lines and notes (for the
// output)}. Without a limit it can trust, it adds nothing up: the config's own problem is the answer.
function chainBudget({ root, sources, plan, orphans, listed }) {
  const res = { problems: [], over: [], lines: [], notes: [] };
  const conf = codexConfig(root, CODEX_CONFIG);
  const onWay = new Set(sources.flatMap(waysTo));
  const nested = new Set(listed.filter((f) => f.endsWith(`/${CODEX_CONFIG}`)));
  for (const d of onWay) if (d !== '.' && lexists(path.join(root, d, CODEX_CONFIG))) nested.add(rel(d, CODEX_CONFIG));
  if (conf) res.problems.push(...conf.problems);
  for (const f of [...nested].sort()) {
    const c = codexConfig(root, f);
    if (!c) continue;
    res.problems.push(...c.problems);
    if (c.limit !== null) res.problems.push(`${f}:${c.line} sets ${LIMIT_KEY}: only ${CODEX_CONFIG} at the root is supported (Codex takes the config nearest its working directory, so one limit would not hold); move the key there`);
  }
  if (conf && conf.unusable) return res;
  const fromConfig = !!conf && conf.limit !== null;
  const limit = fromConfig ? conf.limit : DEFAULT_LIMIT;
  const trust = 'it counts only while the project is trusted in the Codex home';
  res.lines.push(fromConfig ? `budget: limit ${limit} bytes from ${CODEX_CONFIG} (${trust})`
    : `budget: limit ${limit} bytes: Codex's default (no top-level ${LIMIT_KEY} in ${CODEX_CONFIG})`);
  if (conf && conf.mention !== null && !fromConfig) res.notes.push(`${CODEX_CONFIG}:${conf.mention} names ${LIMIT_KEY}, but not as a top-level key: Codex ignores it there`);
  const way = `shorten the text, or ${fromConfig ? 'raise' : 'set'} a top-level ${LIMIT_KEY} in ${path.join(root, CODEX_CONFIG)} (${trust})`;
  const planned = new Map(plan.map((p) => [p.d, p]));
  const gone = new Set(orphans);
  // What Codex reads in the directory d: {f, n} or null.
  const member = (d) => {
    const over = rel(d, OVERRIDE);
    const oBytes = diskBytes(path.join(root, over));
    if (oBytes !== null) return { f: over, n: oBytes };
    if (planned.has(d)) return { f: rel(d, TARGET), n: planned.get(d).data.length };
    const t = rel(d, TARGET);
    if (gone.has(t)) return null;
    const n = diskBytes(path.join(root, t));
    return n === null ? null : { f: t, n };
  };
  const chain = (d) => {
    const members = waysTo(d).map(member).filter(Boolean);
    return { members, sum: members.reduce((a, m) => a + m.n, 0) };
  };
  for (const p of plan) {
    // A chain whose parent failed to generate has no plan to add up; that failure is the answer.
    if (waysTo(p.d).some((a) => sources.includes(a) && !planned.has(a))) continue;
    const { members, sum } = chain(p.d);
    if (sum > limit) {
      res.over.push(`chain ${p.d}: ${sum} bytes > ${limit} (Codex truncates silently): ${members.map((m) => `${m.f} ${m.n}`).join(', ')}; ${way}`);
    } else {
      res.lines.push(`chain ${p.d}: ${sum}/${limit} bytes (${members.map((m) => m.f).join(', ')})`);
    }
  }
  const off = new Set(listed.filter((f) => path.posix.basename(f) === TARGET || path.posix.basename(f) === OVERRIDE).map(dirOf));
  for (const d of [...off].filter((x) => !onWay.has(x)).sort()) {
    const m = member(d);
    if (!m) continue;
    const { sum } = chain(d);
    res.notes.push(`${m.f} is on no way to a generated ${TARGET}: outside every sum; Codex started in ${d}/ reads ${sum}/${limit} bytes${sum > limit ? ' (over the limit: Codex truncates silently there)' : ''}`);
  }
  return res;
}

function main(o) {
  const top = gitTop(o.root);
  const root = top || o.root;
  const home = os.homedir();
  const conn = connection(root, o.config);
  const cmd = `node ${__filename} write --root ${root}`;
  const out = (l) => console.log(l);

  if (!conn.on && !(o.cmd === 'write' && o.enable)) {
    if (o.cmd === 'write') {
      throw new Fail(1, `not connected: no "agentsMd": true in ${conn.file || `a project config (${path.join('.claude', 'codis-agents.json')})`}; run write --enable to generate ${TARGET} and connect it`);
    }
    const candidates = named((top ? lsFiles(root, false).concat(lsFiles(root, true), lsIgnored(root, TARGET)) : []).concat(TARGET), TARGET);
    const gen = candidates.filter((f) => {
      try { const s = existing(path.join(root, f)).state; return s === 'ours' || s === 'edited'; } catch { return false; }
    });
    if (gen.length) {
      throw new Fail(1, gen.map((f) => `generated ${f} without connection: set "agentsMd": true in ${conn.file || 'the project config (.claude/codis-agents.json)'} (or run write --enable), or remove ${f}`));
    }
    out(`agents-md: not used (no "agentsMd": true in ${conn.file || 'a project config'})`);
    return 0;
  }
  if (o.enable && !conn.file) throw new Fail(1, `--enable: no project config found from ${root} (.claude/codis-agents.json): create it first; nothing written`);
  const blocked = o.enable && !conn.on ? ' (--enable blocked: the project stays not connected, nothing written)' : '';
  const stop = (code, lines) => new Fail(code, lines.map((l) => l + blocked)
    .concat(o.cmd === 'write' && !blocked ? [`nothing written: settle every file above, then run ${cmd}`] : []));

  // The sources: a git worktree with a tracked CLAUDE.md at its root, each in the worktree, no override beside one.
  if (!top) throw new Fail(1, `not a git repository: ${o.root}${blocked}`);
  const tracked = lsFiles(root, false);
  const untracked = lsFiles(root, true);
  const problems = [];
  const notes = [];
  const sources = [];
  for (const f of named(tracked, SOURCE)) {
    if (f.split('/').includes('.claude')) problems.push(`${f} is not mirrored: Codex does not read .claude/; move its rules into a ${SOURCE} outside .claude/, or stop tracking it`);
    else sources.push(dirOf(f));
  }
  for (const f of named(untracked, SOURCE)) notes.push(`${f} not tracked: skipped (an ${TARGET} is generated only next to a ${SOURCE} git tracks)`);
  if (!sources.includes('.')) {
    problems.unshift(fs.existsSync(path.join(root, SOURCE)) ? `${SOURCE} is not tracked by git: add it, or remove "agentsMd" from the config` : `no ${SOURCE} in ${root}`);
  }
  // Parents before children: a nested file is built after the files of the directories above it.
  const depth = (d) => (d === '.' ? 0 : d.split('/').length);
  sources.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const d of sources) {
    if (!fs.existsSync(path.join(root, d, SOURCE))) problems.push(`tracked ${rel(d, SOURCE)} is missing in the worktree`);
  }
  if (problems.length) throw stop(1, problems);
  for (const d of sources) {
    if (lexists(path.join(root, d, OVERRIDE))) {
      problems.push(`${OVERRIDE} at ${d === '.' ? 'the root' : d + '/'} replaces the generated ${rel(d, TARGET)} for Codex, even when empty; remove it`);
    }
  }
  const way = new Set();
  for (const d of sources) {
    for (let a = dirOf(d); d !== '.' && a !== '.'; a = dirOf(a)) if (!sources.includes(a) && lexists(path.join(root, a, OVERRIDE))) way.add(a);
  }
  for (const a of [...way].sort()) notes.push(`${rel(a, OVERRIDE)} is on the way to a generated ${TARGET}: Codex reads it in place of an ${TARGET} of ${a}/`);

  // Every file built in memory, against what is on disk.
  const realRoot = fs.realpathSync.native(root);
  const refused = new Set(sources.flatMap((d) => [path.join(root, d, TARGET), path.join(realRoot, d, TARGET)]));
  const failed = new Map(); // a line of a failed generation -> its exit code (a parent's failure repeats in its children)
  const plan = [];
  for (const d of sources) {
    const chain = sources.filter((a) => a === '.' || a === d || d.startsWith(a + '/'));
    let g;
    try { g = generate(root, home, chain, refused); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      for (const l of e.lines) failed.set(l, e.code);
      continue;
    }
    const src = rel(d, SOURCE), tgt = rel(d, TARGET);
    const cur = existing(path.join(root, d, TARGET));
    const data = fileOf(src, g.body);
    plan.push({ d, tgt, data, cur, notes: g.notes, summary: `${data.length} bytes from ${src} and ${g.files} imported file${g.files === 1 ? '' : 's'}` });
    if (cur.state === 'foreign') problems.push(`conflict: ${tgt} is not generated by codis-agents (no marker line, or a damaged one); keep it, move its rules into ${src} or remove it, then run ${cmd}`);
    else if (cur.state === 'edited' && !(o.cmd === 'write' && o.discard)) problems.push(`${tgt} was edited by hand: move the edit into ${src} and run ${cmd} --discard-edits`);
    else if (o.cmd === 'check') {
      if (cur.state === 'missing') problems.push(`${tgt} is missing ("agentsMd": true in ${conn.file}): run ${cmd}`);
      else if (cur.source !== src) problems.push(`${tgt} is stale (source moved: ${cur.source} -> ${src}): run ${cmd}`);
      else if (!cur.body.equals(g.body)) {
        problems.push(cur.version !== VERSION ? `${tgt} was generated by agents-md v${cur.version} and differs from what v${VERSION} writes: run ${cmd}`
          : `${tgt} is stale: ${src} or a file it imports changed; run ${cmd}`);
      }
    }
  }
  // An AGENTS.md with no tracked CLAUDE.md beside it: own ones go, edited ones stay red, foreign ones are named unless
  // git ignores them (a dependency's own file in an ignored folder is not the project's).
  const orphans = [];
  const ignored = new Set(named(lsIgnored(root, TARGET), TARGET));
  for (const f of named(tracked.concat(untracked, [...ignored]), TARGET)) {
    const d = dirOf(f);
    if (sources.includes(d)) continue;
    const cur = existing(path.join(root, f));
    if (cur.state === 'foreign' && ignored.has(f)) continue;
    const src = rel(d, SOURCE);
    if (cur.state === 'ours') {
      if (o.cmd === 'check') problems.push(`generated ${f} without ${src}: run ${cmd} (it removes the file)`);
      orphans.push(f);
    } else if (cur.state === 'edited') {
      problems.push(`${f} was edited by hand and has no tracked ${src}: move the edit into a ${SOURCE}, then remove ${f} by hand`);
    } else if (cur.state === 'foreign') {
      notes.push(`${f} is not generated by codis-agents and has no tracked ${src}: kept; Codex reads it while it stays`);
    }
  }
  const budget = chainBudget({ root, sources, plan, orphans, listed: tracked.concat(untracked) });
  problems.push(...budget.problems);
  notes.push(...budget.notes);
  const lines = [...failed.keys()].concat(problems);
  const stopsOnOver = o.cmd === 'check' || !!blocked;
  if (lines.length || (budget.over.length && stopsOnOver)) {
    const all = lines.concat(budget.over);
    throw stop(problems.length || budget.over.length || [...failed.values()].some((c) => c !== 69) ? 1 : 69, all);
  }

  if (o.cmd === 'check') {
    for (const p of plan) { out(`ok ${p.tgt}: ${p.summary}`); for (const n of p.notes) out(`note: ${n}`); }
    for (const l of budget.lines) out(l);
    for (const n of notes) out(`note: ${n}`);
    return 0;
  }
  let cfgText = null;
  if (o.enable && !conn.on) {
    cfgText = enabledConfig(conn.file, conn.raw);
    if (cfgText === null) throw new Fail(1, `--enable: cannot add "agentsMd": true to ${conn.file} safely: add it by hand, then run ${cmd}; nothing written`);
  }
  for (const p of plan) {
    if (p.cur.buf && p.cur.buf.equals(p.data)) out(`unchanged ${p.tgt}: ${p.summary}`);
    else { writeAtomic(path.join(root, p.d, TARGET), p.data); out(`wrote ${p.tgt}: ${p.summary}`); }
    for (const n of p.notes) out(`note: ${n}`);
  }
  for (const f of orphans) { fs.unlinkSync(path.join(root, f)); out(`removed ${f} (no tracked ${rel(dirOf(f), SOURCE)})`); }
  if (cfgText !== null) { writeAtomic(conn.file, cfgText); out(`connected: "agentsMd": true in ${conn.file}`); }
  for (const l of budget.lines) out(l);
  for (const n of notes) out(`note: ${n}`);
  if (budget.over.length) throw new Fail(1, budget.over.concat('the files are written and stay red until every chain fits; write again changes nothing'));
  return 0;
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  try {
    process.exit(main(o));
  } catch (e) {
    if (e instanceof Fail) { for (const l of e.lines) console.error(`agents-md: ${l}`); process.exit(e.code); }
    console.error(`agents-md: error: ${e && e.stack ? e.stack : e}`);
    process.exit(70);
  }
}

module.exports = { importTokens, generate, VERSION, MARK };
