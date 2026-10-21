#!/usr/bin/env node
'use strict';
// chain-cost.js on wrong paths (spec E-1, coordinator decision U2b v.6): no directory, a file, a directory without agent
// transcripts (*.meta.json) -> one line on stderr, exit 66, no stack trace; a broken .meta.json -> a note, the file is
// skipped and the rest is counted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');

const CLI = path.join(__dirname, '..', 'scripts', 'chain-cost.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cost-paths-')));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--median', '1e6'], { encoding: 'utf8', cwd: tmp, env: Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: path.join(tmp, 'none.json') }) });
const oneLine = (x) => x.stderr.trim().split('\n').length === 1 && !/\n\s+at /.test(x.stderr) && x.stdout.trim() === '';
try {
  const missing = path.join(tmp, 'no-such-dir');
  let x = run(missing);
  ok('H1 no directory -> exit 66, one line naming it, no stack trace', x.status === 66 && oneLine(x) && x.stderr.includes(missing) && /no directory/.test(x.stderr), `${x.status} ${x.stdout}${x.stderr}`);
  const file = path.join(tmp, 'a-file.jsonl'); fs.writeFileSync(file, '{}\n');
  x = run(file);
  ok('H2 a file -> exit 66, one line, no stack trace', x.status === 66 && oneLine(x) && x.stderr.includes(file) && /not a directory/.test(x.stderr), `${x.status} ${x.stdout}${x.stderr}`);
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  x = run(empty);
  ok('H3 an empty directory -> exit 66, "no agent transcripts (*.meta.json) in <dir>"', x.status === 66 && oneLine(x) && x.stderr.includes(`no agent transcripts (*.meta.json) in ${empty}`), `${x.status} ${x.stdout}${x.stderr}`);
  const good = path.join(tmp, 'good'); fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'a.meta.json'), JSON.stringify({ description: 'prog:t1#1' }));
  fs.writeFileSync(path.join(good, 'a.jsonl'), JSON.stringify({ message: { id: 'm', role: 'assistant', usage: { input_tokens: 1000 }, content: [] } }));
  x = run(good, missing);
  ok('H1 one wrong path among several -> exit 66, nothing reported', x.status === 66 && oneLine(x) && x.stderr.includes(missing), `${x.status} ${x.stdout}${x.stderr}`);
  fs.writeFileSync(path.join(good, 'b.meta.json'), '{"description": ');
  fs.writeFileSync(path.join(good, 'b.jsonl'), '');
  x = run(good);
  ok('H4 a broken .meta.json -> note and skipped, the rest counted, exit 0', x.status === 0 && /^t1: 0\.0M IE, 1 agents/m.test(x.stdout)
    && /^note: [^\n]*b\.meta\.json[^\n]*skipped/m.test(x.stdout) && !/\n\s+at /.test(x.stderr), `${x.status} ${x.stdout}${x.stderr}`);
  const { cost } = require('../scripts/chain-cost');
  const notes = [];
  const t = cost(good, notes);
  ok('H4 cost(dir, notes): the broken file is a note, not an exception', Object.keys(t).join() === 't1' && notes.length === 1 && /b\.meta\.json/.test(notes[0]), JSON.stringify({ t, notes }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
done();
