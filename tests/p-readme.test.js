#!/usr/bin/env node
'use strict';
// p-readme (0.4.19): README is split into a plain part for a first-time reader and a separate "Technical reference"
// block; the version history moves to CHANGELOG.md (newest first) and README links to it.
//   A. README has one "## Technical reference" heading; the part above it is plain: no config key tables, short, with
//      a quick start, and it links to CHANGELOG.md.
//   B. README holds no "## Changes in" section any more.
//   C. CHANGELOG.md: version headings "## X.Y.Z" strictly newest first, the first one is the version of package.json and
//      plugin.json; every entry moved from README is there under its version (its bold titles).
//   D. Nothing technical is lost: every heading README had before the split is still there (all but "Start here" in the
//      Technical reference block, at their old level, which other tests read),
//      and every top-level key of both config schemas has its table row there.
//   E. Every relative link of README and CHANGELOG resolves: the file exists, a #anchor names a heading of its file.
const fs = require('fs');
const path = require('path');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } };
const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const lines = readme.split('\n');

// ---- A ----
const techIdx = lines.findIndex((l) => /^## Technical reference\s*$/.test(l));
ok('A1. README has exactly one "## Technical reference" heading', techIdx > 0 && lines.filter((l) => /^## Technical reference\s*$/.test(l)).length === 1, String(techIdx));
const top = techIdx > 0 ? lines.slice(0, techIdx) : lines;
const tech = techIdx > 0 ? lines.slice(techIdx).join('\n') : '';
ok('A2. the plain part has no config key table rows (| `key` |)', !top.some((l) => /^\| `/.test(l)), top.filter((l) => /^\| `/.test(l)).slice(0, 3).join(' / '));
ok('A3. the plain part is short (under 200 lines)', top.length < 200, String(top.length));
ok('A4. the plain part has a quick start', top.some((l) => /^## .*Quick start/i.test(l)));
ok('A5. the plain part links to CHANGELOG.md', /\]\(CHANGELOG\.md\)/.test(top.join('\n')));
ok('A6. the plain part says what the owner gets and shows an example', top.some((l) => /^## .*owner/i.test(l)) && top.some((l) => /^## .*example/i.test(l)));

// ---- B ----
ok('B1. README has no "## Changes in" section', !/^## Changes in/m.test(readme));

// ---- C ----
const vers = [...changelog.matchAll(/^## (\d+)\.(\d+)\.(\d+)\b/gm)].map((m) => [+m[1], +m[2], +m[3]]);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
ok('C1. CHANGELOG.md exists with version headings', vers.length >= 6, String(vers.length));
ok('C2. CHANGELOG versions are strictly newest first', vers.every((v, i) => i === 0 || cmp(vers[i - 1], v) > 0), vers.map((v) => v.join('.')).join(' '));
const pkg = JSON.parse(read('package.json') || '{}').version, plug = JSON.parse(read('.claude-plugin/plugin.json') || '{}').version;
ok('C3. the first CHANGELOG version is the version of package.json and plugin.json', vers.length && vers[0].join('.') === pkg && pkg === plug, `${vers[0] && vers[0].join('.')} ${pkg} ${plug}`);
const entry = (v) => { const m = changelog.match(new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm')); return m ? m[0].replace(/\s+/g, ' ') : ''; };
const MOVED = {
  '0.4.18': ['The analysis is checked before the start', 'A red train is attributed by every rerun section of its log'],
  '0.4.17': ['The counters of a task survive a relaunch', 'Waves'],
  '0.4.16': ['A mechanism is challenged before cells', 'The analyst before the first programmer can be the author of the mechanism', 'A pass made in an earlier run is said in `start`'],
  '0.4.15': ['Only the train: no selection inside the task', 'The attribution of a red train runs a guard only where it exists'],
  '0.4.14': ['The tester selects only its own diff', 'A docs-only merge after a train conflict skips the selection', 'The train goes first in the worker budget and on the remote runner'],
};
for (const [v, titles] of Object.entries(MOVED)) {
  const e = entry(v);
  ok(`C4. CHANGELOG ${v} holds its moved entries`, titles.every((t) => e.includes(`**${t}`)), titles.filter((t) => !e.includes(`**${t}`)).join(' | '));
}
ok('C5. CHANGELOG has an entry for the version of package.json', entry(pkg).length > 40, pkg);

// ---- D ----
// "Start here" is plain already and may stand in the plain part; every other heading stays in the block.
ok('D1. README keeps the heading "Start here - no plugin needed"', /^## Start here - no plugin needed\s*$/m.test(readme));
const BEFORE = ['Terms', 'The role chain', 'Decisions live in three layers', 'What counts as evidence',
  'Rules that grew out of failures', "The bottleneck is the owner's attention", 'What is inside', 'Install', 'Configure a project',
  'The machine file', 'Run a chain', 'How the chain decides', 'Memory slots', 'Shared stand', 'Known gaps', 'Tests'];
const techHeads = tech.split('\n').filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#+ /, '').trim());
for (const h of BEFORE) ok(`D1. Technical reference keeps the heading "${h}"`, techHeads.includes(h), techHeads.join(' | '));
for (const [schema, label] of [['schemas/codis-agents.schema.json', 'project'], ['schemas/codis-agents-machine.schema.json', 'machine']]) {
  const keys = Object.keys((JSON.parse(read(schema) || '{}').properties) || {}).filter((k) => k !== '$schema');
  const missing = keys.filter((k) => !new RegExp('^\\| `' + k.replace(/\$/g, '\\$') + '`', 'm').test(tech) && !new RegExp('^\\| [^\\n|]*`' + k + '`[^|]*\\|', 'm').test(tech));
  ok(`D2. every ${label} config key has its table row in Technical reference (${keys.length} keys)`, keys.length > 5 && !missing.length, missing.join(' '));
}

// ---- E ----
const slug = (h) => h.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
const anchors = (text) => {
  const seen = new Map();
  return new Set(text.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => {
    const s = slug(l.replace(/^#+ /, '').replace(/`/g, ''));
    const n = seen.get(s) || 0; seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  }));
};
for (const [file, text] of [['README.md', readme], ['CHANGELOG.md', changelog]]) {
  const bad = [];
  const noCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of noCode.matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1];
    if (/^[a-z]+:/i.test(t)) continue;
    const [p, a] = t.split('#');
    const target = p ? path.join(ROOT, path.dirname(file), p) : path.join(ROOT, file);
    if (!fs.existsSync(target)) { bad.push(t); continue; }
    if (a && /\.md$/.test(target) && !anchors(fs.readFileSync(target, 'utf8')).has(a)) bad.push(t);
  }
  const links = [...noCode.matchAll(/\]\(([^)\s]+)\)/g)].filter((m) => !/^[a-z]+:/i.test(m[1])).length;
  ok(`E1. every relative link of ${file} resolves (${links} links)`, text.length > 0 && !bad.length, bad.join(' '));
}
done();
