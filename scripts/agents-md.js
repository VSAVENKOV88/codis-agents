#!/usr/bin/env node
'use strict';
// AGENTS.md for Codex, generated from the project's CLAUDE.md. Codex reads AGENTS.md as project instructions and does
// not expand Claude Code's @imports, so the generated file carries the text of CLAUDE.md and of every file it imports.
//
// usage: agents-md.js write [--root <dir>] [--config <file>] [--discard-edits] [--enable]
//        agents-md.js check [--root <dir>] [--config <file>]
//   --root     a directory of the project's git worktree (default: the working directory); its top level is used
//   --config   the project config; default: the lookup of scripts/config.js from the root, without $CLAUDE_PROJECT_DIR
//
// The connection: "agentsMd": true in the project config (.claude/codis-agents.json). Connected, the root AGENTS.md must
// exist and be fresh; not connected, check says "not used", unless a generated AGENTS.md is there (it would go stale
// silently). write --enable connects: it writes AGENTS.md and then sets the key, and refuses both when anything stops
// the generation (a foreign AGENTS.md, a broken import), so connecting ends in a consistent state or changes nothing.
//
// The file: one marker line, then the body. The marker names the owner (codis-agents agents-md), the generator version,
// the source (CLAUDE.md) and the sha256 of the body; the body is CLAUDE.md byte for byte, then one section per imported
// file, "Contents of <path>:", a blank line and the file byte for byte. <path> is relative to the repository root
// inside it, ~/... inside the home, absolute elsewhere: the bytes do not depend on the machine's home directory.
// check compares the body with the generator's output: the version in the marker alone never makes it red.
//
// Imports, as Claude Code 2.1.318 reads them (measured with a fake model provider, no model): an @token that starts a
// line or follows whitespace, up to the next unescaped whitespace (a backslash-escaped space belongs to it); not inside
// a code span, a fenced block (``` or ~~~, unclosed: to the end of the file), an indented code block or an HTML
// comment. The path is relative to the importing file, ~/ is the home, an absolute path stays. Depth first, each file
// at most once (a cycle stops), at most four hops from CLAUDE.md. Claude Code drops an import whose file is missing
// without a word; here that is an error: inside the repository exit 1 ("broken import"), outside it 69 (the file is
// not on this machine - an environment, not the project). An import of a directory is exit 1.
//
// Not in this version: a tracked nested CLAUDE.md and a root AGENTS.override.md are an explicit red (Codex would read
// the override instead of AGENTS.md), never a silent green.
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
const MARK = /^<!-- codis-agents agents-md v(\d+); source: (\S+); sha256: ([0-9a-f]{64}); (.*) -->$/;
const HINT = `generated file: edit ${SOURCE}, then run scripts/agents-md.js write of codis-agents`;

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
function trackedFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files in ${root}: ${(r.stderr || '').trim()}`);
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

// Leading whitespace in columns (a tab moves to the next multiple of four), as Markdown counts an indented code block.
function indentCols(line) {
  let c = 0;
  for (const ch of line) { if (ch === ' ') c++; else if (ch === '\t') c += 4 - (c % 4); else break; }
  return c;
}

// The @tokens Claude Code reads as imports: [{token, line}] (token as written, line from 1).
function importTokens(text) {
  const out = [];
  let fence = null; // {ch, len} of the open fenced block
  let inComment = false;
  let prev = 'blank'; // the previous line: blank, para (paragraph text) or other (heading, fence, code, comment)
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) { fence = null; prev = 'other'; }
      return;
    }
    if (!inComment) {
      if (/^[ \t]*$/.test(line)) { prev = 'blank'; return; }
      const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; return; }
      // An indented line continues a paragraph; it is code only after a blank line or a block that is not a paragraph.
      if (indentCols(line) >= 4 && prev !== 'para') { prev = 'other'; return; }
    }
    // The visible text: code spans and HTML comments become a space (they end a token and are never scanned).
    let vis = '';
    for (let j = 0; j < line.length;) {
      if (inComment) {
        const e = line.indexOf('-->', j);
        if (e < 0) { j = line.length; break; }
        inComment = false; j = e + 3; vis += ' ';
        continue;
      }
      if (line.startsWith('<!--', j)) { inComment = true; j += 4; vis += ' '; continue; }
      if (line[j] === '\\' && line[j + 1] === '`') { vis += '\\`'; j += 2; continue; }
      if (line[j] === '`') {
        let n = 0; while (line[j + n] === '`') n++;
        let k = j + n, close = -1;
        while (k < line.length) {
          const s = line.indexOf('`', k);
          if (s < 0) break;
          let m = 0; while (line[s + m] === '`') m++;
          if (m === n) { close = s; break; }
          k = s + m;
        }
        if (close >= 0) { vis += ' '; j = close + n; } else { vis += line.slice(j, j + n); j += n; }
        continue;
      }
      vis += line[j++];
    }
    for (const m of vis.matchAll(/(^|\s)@((?:[^\s\\]|\\ )+)/g)) out.push({ token: m[2], line: i + 1 });
    prev = /^\s*$/.test(vis) ? 'other' : /^ {0,3}#{1,6}(\s|$)/.test(line) ? 'other' : 'para';
  });
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(buf, label) {
  try { return decoder.decode(buf); } catch { throw new Fail(1, `${label}: not UTF-8`); }
}
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// The body of AGENTS.md for <root>/CLAUDE.md: {body (Buffer), files (imported count), notes}.
function generate(root, home) {
  const rootFile = path.join(root, SOURCE);
  const label = (abs) => (inside(root, abs) ? path.relative(root, abs).split(path.sep).join('/')
    : home && inside(home, abs) ? '~/' + path.relative(home, abs).split(path.sep).join('/') : abs);
  const parts = [];
  let last = 0x0a;
  const push = (b) => { if (b.length) { parts.push(b); last = b[b.length - 1]; } };
  const top = fs.readFileSync(rootFile);
  push(top);
  const seen = new Set([rootFile]);
  const notes = [];
  let files = 0;
  const walk = (file, name, text, depth) => {
    for (const { token, line } of importTokens(text)) {
      const p = token.replace(/\\ /g, ' ');
      const abs = p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(path.dirname(file), p);
      if (seen.has(abs)) continue;
      const where = `${name}:${line}`;
      if (depth >= MAX_HOPS) { notes.push(`not expanded: @${token} (${where}) is deeper than ${MAX_HOPS} hops from ${SOURCE}, as in Claude Code`); continue; }
      let st;
      try { st = fs.statSync(abs); } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Fail(1, `cannot read @${token} (${where}): ${e.message}`);
        if (inside(root, abs)) {
          throw new Fail(1, `broken import @${token} (${where}): no file ${label(abs)}; Claude Code reads every @word after a space outside code as an import - fix the path, or put the text in backticks if it is not an import`);
        }
        throw new Fail(69, `cannot expand @${token} (${where}): not on this machine (${abs})`);
      }
      if (!st.isFile()) throw new Fail(1, `cannot import @${token} (${where}): not a regular file (${label(abs)})`);
      seen.add(abs);
      const hdr = label(abs);
      const buf = fs.readFileSync(abs);
      const t = decode(buf, hdr);
      push(Buffer.from(`${last === 0x0a ? '' : '\n'}\nContents of ${hdr}:\n\n`));
      push(buf);
      files++;
      walk(abs, hdr, t, depth + 1);
    }
  };
  walk(rootFile, SOURCE, decode(top, SOURCE), 0);
  return { body: Buffer.concat(parts), files, notes };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileOf = (body) => Buffer.concat([Buffer.from(`<!-- codis-agents agents-md v${VERSION}; source: ${SOURCE}; sha256: ${sha(body)}; ${HINT} -->\n`), body]);

// The existing AGENTS.md: {state: missing | foreign | edited | ours, version, body, buf}.
function existing(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { state: 'missing' }; throw e; }
  if (!st.isFile()) return { state: 'foreign' };
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(0x0a);
  const m = nl < 0 ? null : MARK.exec(buf.slice(0, nl).toString('utf8'));
  if (!m || m[2] !== SOURCE) return { state: 'foreign', buf };
  const body = buf.slice(nl + 1);
  if (sha(body) !== m[3]) return { state: 'edited', version: +m[1], body, buf };
  return { state: 'ours', version: +m[1], body, buf };
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

function main(o) {
  const root = gitTop(o.root) || o.root;
  const isGit = gitTop(o.root) !== null;
  const home = os.homedir();
  const target = path.join(root, TARGET);
  const conn = connection(root, o.config);
  const cmd = `node ${__filename} write --root ${root}`;
  const out = (l) => console.log(l);

  if (!conn.on && !(o.cmd === 'write' && o.enable)) {
    if (o.cmd === 'write') {
      throw new Fail(1, `not connected: no "agentsMd": true in ${conn.file || `a project config (${path.join('.claude', 'codis-agents.json')})`}; run write --enable to generate ${TARGET} and connect it`);
    }
    let gen = false;
    try { gen = existing(target).state !== 'missing' && existing(target).state !== 'foreign'; } catch { gen = false; }
    if (gen) throw new Fail(1, `generated ${TARGET} without connection: set "agentsMd": true in ${conn.file || 'the project config (.claude/codis-agents.json)'} (or run write --enable), or remove ${TARGET}`);
    out(`agents-md: not used (no "agentsMd": true in ${conn.file || 'a project config'})`);
    return 0;
  }
  if (o.enable && !conn.file) throw new Fail(1, `--enable: no project config found from ${root} (.claude/codis-agents.json): create it first; nothing written`);
  const blocked = o.enable && !conn.on ? ' (--enable blocked: the project stays not connected, nothing written)' : '';

  // The preconditions of a generation: a git worktree with a tracked CLAUDE.md at its root, nothing outside this version.
  const problems = [];
  if (!isGit) throw new Fail(1, `not a git repository: ${o.root}${blocked}`);
  const tracked = trackedFiles(root);
  for (const f of tracked) {
    if (f !== SOURCE && path.posix.basename(f) === SOURCE) problems.push(`not supported until D3-2: ${f} (a tracked nested ${SOURCE}; only the root one is mirrored)`);
  }
  let hasOverride = false;
  try { fs.lstatSync(path.join(root, OVERRIDE)); hasOverride = true; } catch { /* none */ }
  if (hasOverride) problems.push(`not supported until D3-2: ${OVERRIDE} at the root replaces the generated ${TARGET} for Codex, even when empty; remove it`);
  const isTracked = tracked.includes(SOURCE);
  const exists = fs.existsSync(path.join(root, SOURCE));
  if (!isTracked && !exists) problems.push(`no ${SOURCE} in ${root}`);
  else if (!isTracked) problems.push(`${SOURCE} is not tracked by git: add it, or remove "agentsMd" from the config`);
  else if (!exists) problems.push(`tracked ${SOURCE} is missing in the worktree`);
  if (problems.length) throw new Fail(1, problems.map((p) => p + blocked));

  let g;
  try { g = generate(root, home); } catch (e) { if (e instanceof Fail && blocked) throw new Fail(e.code, e.lines.map((l) => l + blocked)); throw e; }
  const summary = `${fileOf(g.body).length} bytes from ${SOURCE} and ${g.files} imported file${g.files === 1 ? '' : 's'}`;
  const cur = existing(target);
  const conflict = `conflict: ${TARGET} is not generated by codis-agents (no marker line, or a damaged one); keep it, move its rules into ${SOURCE} or remove it, then run ${cmd}`;
  const edited = `${TARGET} was edited by hand: move the edit into ${SOURCE} and run ${cmd} --discard-edits`;

  if (o.cmd === 'check') {
    if (cur.state === 'missing') throw new Fail(1, `${TARGET} is missing ("agentsMd": true in ${conn.file}): run ${cmd}`);
    if (cur.state === 'foreign') throw new Fail(1, conflict);
    if (cur.state === 'edited') throw new Fail(1, edited);
    if (!cur.body.equals(g.body)) {
      if (cur.version !== VERSION) throw new Fail(1, `${TARGET} was generated by agents-md v${cur.version} and differs from what v${VERSION} writes: run ${cmd}`);
      throw new Fail(1, `${TARGET} is stale: ${SOURCE} or a file it imports changed; run ${cmd}`);
    }
    out(`ok ${TARGET}: ${summary}`);
    for (const n of g.notes) out(`note: ${n}`);
    return 0;
  }

  if (cur.state === 'foreign') throw new Fail(1, conflict + blocked);
  if (cur.state === 'edited' && !o.discard) throw new Fail(1, edited + blocked);
  let cfgText = null;
  if (o.enable && !conn.on) {
    cfgText = enabledConfig(conn.file, conn.raw);
    if (cfgText === null) throw new Fail(1, `--enable: cannot add "agentsMd": true to ${conn.file} safely: add it by hand, then run ${cmd}; nothing written`);
  }
  const data = fileOf(g.body);
  if (cur.buf && cur.buf.equals(data)) out(`unchanged ${TARGET}: ${summary}`);
  else { writeAtomic(target, data); out(`wrote ${TARGET}: ${summary}`); }
  if (cfgText !== null) { writeAtomic(conn.file, cfgText); out(`connected: "agentsMd": true in ${conn.file}`); }
  for (const n of g.notes) out(`note: ${n}`);
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
