#!/usr/bin/env node
'use strict';
// Repository hygiene for a public plugin: every file is in English (no Cyrillic at all), and no personal or project
// data - no home-directory paths, no e-mail addresses, no names of the project the process was first built for.
// Extra forbidden words (for example your own user name) can be passed in CODIS_FORBIDDEN_WORDS, comma-separated.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ok, done } = require('./lib');

const ROOT = path.join(__dirname, '..');
const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));
// Stored rot13-encoded so that this file does not contain the words it forbids.
const words = ['svtzn', 'o-vafgnaprf', 'pbqvf-pi'].map(rot13)
  .concat((process.env.CODIS_FORBIDDEN_WORDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const PATTERNS = [
  ['Cyrillic', new RegExp('[' + [[0x400, 0x52f], [0x2de0, 0x2dff], [0xa640, 0xa69f]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']')],
  ['home path', /\/Users\/[A-Za-z]|\/home\/[a-z]|[A-Z]:\\Users\\/],
  ['e-mail address', /[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['project word', new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')],
];

ok('there are files to check', files.length > 20, String(files.length));
for (const [name, re] of PATTERNS) {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    text.split('\n').forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}`); });
    if (re.test(f)) hits.push(`${f} (file name)`);
  }
  ok(`no ${name} in any file`, !hits.length, hits.slice(0, 10).join(', '));
}
// The detectors themselves must work, or the checks above prove nothing.
ok('detectors fire on samples', PATTERNS[0][1].test(String.fromCharCode(0x43f, 0x440, 0x438)) && PATTERNS[1][1].test('/Us' + 'ers/someone/x')
  && PATTERNS[2][1].test('a.b' + '@' + 'mail.org') && !PATTERNS[2][1].test('x' + '@' + 'example.com') && PATTERNS[3][1].test(rot13('svtzn')));
done();
