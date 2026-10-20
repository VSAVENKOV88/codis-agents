#!/usr/bin/env node
'use strict';
// scripts/slot-journal.js: the summary of the slot journal. Parsing of v1 lines (bad lines counted, never fatal), queue
// wait = acquire - request and hold = release - acquire, totals and medians per class and per worktree, the time
// window, records that never got a slot, full runs back in the queue with 75, and the command line (text and --json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const J = require('../scripts/slot-journal');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'slot-journal.js');
const T0 = 1800000000;
const line = (req, acq, rel, cls, slot, kind, rc, wt, cmd) =>
  ['v1', (T0 + req).toFixed(3), acq === null ? '-' : (T0 + acq).toFixed(3), (T0 + rel).toFixed(3), cls, slot, kind, 4242, rc, wt, cmd].join('\t');
const LINES = [
  line(0, 10, 70, 'heavy', 1, 'single', 0, '/w/a', 'node x-run.js'),        // wait 10, hold 60
  line(5, 35, 65, 'heavy', 2, 'single', 1, '/w/b', 'npm run build'),        // wait 30, hold 30
  line(6, 6, 26, 'medium', 1, 'single', 0, '/w/a', 'tsc -p .'),             // wait 0, hold 20
  line(7, null, 47, 'medium', '-', 'single', 143, '/w/b', 'tsc'),           // killed in the queue: wait 40
  line(100, 160, 161, 'heavy', 1, 'full', 75, '/w/a', 'guards-all a'),      // no budget: wait 60, hold 1
  line(161, 200, 500, 'heavy', 1, 'full', 0, '/w/a', 'guards-all a'),       // wait 39, hold 300
  line(20, 25, 45, 'exclusive', '-', 'single', 0, '/w/a', 'node x-run.js'), // wait 5, hold 20
  'garbage line',
  'v2\tsomething\telse',
  ['v1', 'x', '-', 'y', 'heavy', 1, 'single', 1, 0, '/w', 'c'].join('\t'),
];

const { records, bad } = J.parse(LINES.join('\n') + '\n');
ok('parse: 7 records, 3 bad lines counted', records.length === 7 && bad === 3, `${records.length} ${bad}`);
const r0 = records[0];
ok('parse: fields of a record', r0.class === 'heavy' && r0.slot === '1' && r0.kind === 'single' && r0.rc === 0 && r0.worktree === '/w/a' && r0.command === 'node x-run.js', JSON.stringify(r0));
ok('parse: wait = acquire - request, hold = release - acquire', Math.abs(r0.wait - 10) < 1e-6 && Math.abs(r0.hold - 60) < 1e-6, `${r0.wait} ${r0.hold}`);
const k = records[3];
ok('parse: no acquire - wait up to release, no hold', k.acquire === null && Math.abs(k.wait - 40) < 1e-6 && k.hold === null, JSON.stringify(k));
ok('parse: a command with a tab inside is kept whole', J.parseLine(line(0, 1, 2, 'heavy', 1, 'single', 0, '/w', 'a') + '\tb').command === 'a\tb');

ok('median: odd, even, empty', J.median([3, 1, 2]) === 2 && J.median([4, 1, 2, 3]) === 2.5 && J.median([]) === null);

const s = J.summarize(records);
const cls = Object.fromEntries(s.byClass), wt = Object.fromEntries(s.byWorktree);
const near = (a, b) => Math.abs(a - b) < 1e-6;
ok('summary: all - n 7, queue 184 s, hold 431 s', s.all.n === 7 && near(s.all.waitTotal, 184) && near(s.all.holdTotal, 431), JSON.stringify(s.all));
ok('summary: queue share = queue / (queue + hold)', near(s.all.queueShare, 184 / 615));
ok('summary: heavy - n 4, queue total 139, median 34.5; hold total 391, median 45', cls.heavy.n === 4 && near(cls.heavy.waitTotal, 139)
  && near(cls.heavy.waitMedian, 34.5) && near(cls.heavy.holdTotal, 391) && near(cls.heavy.holdMedian, 45), JSON.stringify(cls.heavy));
ok('summary: medium - one never got a slot; hold median over held records only', cls.medium.n === 2 && cls.medium.notAcquired === 1
  && near(cls.medium.waitTotal, 40) && near(cls.medium.holdMedian, 20), JSON.stringify(cls.medium));
ok('summary: exclusive is its own class', cls.exclusive.n === 1 && near(cls.exclusive.waitTotal, 5));
ok('summary: per worktree', wt['/w/a'].n === 5 && wt['/w/b'].n === 2 && near(wt['/w/b'].waitTotal, 70), JSON.stringify(wt));
ok('summary: full runs back in the queue with 75 are shown apart', s.noBudget.n === 1 && near(s.noBudget.holdTotal, 1));
ok('summary: window from the first request to the last release', near(s.window.from, T0) && near(s.window.to, T0 + 500));
const w = J.summarize(records, { since: T0 + 50 });
ok('window: --since filters by request time', w.all.n === 2 && w.byClass.every(([c]) => c === 'heavy'), JSON.stringify(w.all));
ok('window: --until too', J.summarize(records, { until: T0 + 6 }).all.n === 3);
ok('window: empty window says so', /no records/.test(J.format(J.summarize(records, { since: T0 + 9999 }), 'j')));

ok('parseTime: 2h ago, epoch, ISO', near(J.parseTime('2h', T0), T0 - 7200) && J.parseTime(String(T0)) === T0 && J.parseTime('2027-01-15T08:00:00Z') === 1800000000);
let threw = false; try { J.parseTime('yesterday-ish'); } catch { threw = true; }
ok('parseTime: a bad time is an error', threw);

const text = J.format(s, 'journal.tsv');
ok('text: tables by class and by worktree, with totals, medians and share', /^class +n +queue total +queue median +hold total +hold median +queue share$/m.test(text)
  && /^heavy +4 +2m19s +34\.5s +6m31s +45\.0s +26%$/m.test(text) && /^worktree /m.test(text) && /^all +7 /m.test(text) && /no worker budget/.test(text), text);

// command line
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-journal-'));
try {
  const f = path.join(tmp, 'journal.tsv');
  fs.writeFileSync(f, LINES.join('\n') + '\n');
  let r = spawnSync(process.execPath, [SCRIPT, '--journal', f, '--json'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* checked below */ }
  ok('cli: --json', r.status === 0 && j && j.all.n === 7 && j.badLines === 3, r.stdout + r.stderr);
  r = spawnSync(process.execPath, [SCRIPT, '--journal', f, '--since', String(T0 + 50)], { encoding: 'utf8' });
  ok('cli: text with --since, bad lines reported', r.status === 0 && /2 holds/.test(r.stdout) && /3 line\(s\) not understood/.test(r.stdout), r.stdout + r.stderr);
  r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: Object.assign({}, process.env, { SLOT_JOURNAL: f }) });
  ok('cli: journal from $SLOT_JOURNAL', r.status === 0 && /7 holds/.test(r.stdout), r.stdout + r.stderr);
  r = spawnSync(process.execPath, [SCRIPT, '--journal', path.join(tmp, 'none.tsv')], { encoding: 'utf8' });
  ok('cli: missing journal - exit 66 with a message', r.status === 66 && /cannot read/.test(r.stderr), r.stderr);
  r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  ok('cli: unknown option - usage, exit 64', r.status === 64 && /usage/.test(r.stderr));
  const cfg = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ repoDir: tmp, worktreeRoot: tmp, sharedDir: tmp, slots: { lockDir: tmp } }));
  const env = Object.assign({}, process.env, { CODIS_AGENTS_CONFIG: cfg }); delete env.SLOT_JOURNAL;
  r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
  ok('cli: default journal - <slots.lockDir>/journal.tsv of the project config', r.status === 0 && r.stdout.startsWith(f + ':'), r.stdout + r.stderr);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// U2b-2 (tester): a full run without {jobs} (queue kind "whole") that went back to the queue with 75 had no worker
// budget either; a single heavy job that exited 75 did not.
{
  const ws = J.summarize(J.parse([
    line(0, 10, 12, 'heavy', 1, 'whole', 75, '/w/p', 'guards-all p'),
    line(12, 40, 90, 'heavy', 1, 'whole', 0, '/w/p', 'guards-all p'),
    line(0, 1, 3, 'heavy', 2, 'single', 75, '/w/p', 'node x-run.js'),
  ].join('\n') + '\n').records);
  ok('summary: a run without {jobs} (kind whole) back in the queue with 75 counts as no worker budget, a single 75 does not',
    ws.noBudget.n === 1 && near(ws.noBudget.holdTotal, 2), JSON.stringify(ws.noBudget));
}

done();
