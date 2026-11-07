#!/usr/bin/env node
'use strict';
// The journal of a task and its snapshot (scripts/chain-journal.js), p-codex-B1-b1, cells S1, S12a, S12b, S13, S14 and the
// place of the state (owner 2026-11-07): events are written with fsync before they may have an effect, the snapshot only
// after its line; a torn tail is shown and never counted, the next line goes to a new segment and the torn file stays as
// it was; damage inside is a refusal; a service file is opened with no link followed and without blocking, its type read
// from the open file; a swapped folder or parent is refused; one writer per run folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ok, done } = require('./lib');
const CJ = require('../scripts/chain-journal.js');

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-journal-t-')));
process.on('exit', () => { fs.rmSync(W, { recursive: true, force: true }); });
let nRun = 0;
const runDir = () => { const d = path.join(W, `run${++nRun}`); fs.mkdirSync(d); return d; };
const threw = (f) => { try { f(); return null; } catch (e) { return e; } };
const mkfifo = (f) => spawnSync('mkfifo', [f]).status === 0;
const segOf = (d, key, n = 0) => path.join(d, 'journal', key, `seg-${String(n).padStart(3, '0')}.jsonl`);
const stateOf = (d, key) => path.join(d, 'journal', key, 'run-state.json');
const linesOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const intent = (n, extra) => Object.assign({ type: 'intent', stepId: `R:${n}`, n, label: `prog:k#${n}`, kind: 'agent', effect: 'never', gated: true }, extra || {});
const result = (n, extra) => Object.assign({ type: 'result', stepId: `R:${n}`, outcome: 'ok' }, extra || {});

// ---- S1: the fields of the owner's answer 12, the order, the snapshot after its line
{
  const d = runDir();
  const order = [];
  const io = { writeSync: (...a) => { order.push('write'); return fs.writeSync(...a); }, fsyncSync: (fd) => { order.push('fsync'); return fs.fsyncSync(fd); } };
  const j = CJ.openJournal(d, 'R', 'k', { io });
  j.append(intent(1, { counts: { testerReds: 0 }, head: 'h0', gitHead: 'g0' }));
  ok('S1 the line is written and fsynced before the append returns', order[0] === 'write' && order[1] === 'fsync', order.join(','));
  j.append({ type: 'launch', stepId: 'R:1', pid: 11, pgid: 11, lstart: 'L', callDir: '/c', gated: true });
  j.append(result(1, { value: { verdict: 'x' } }));
  j.append({ type: 'settled', stepIds: ['R:1'], counts: { testerReds: 1 }, head: 'h1' });
  const ls = linesOf(segOf(d, 'k'));
  ok('S1 G25 every line: format version, runId, consecutive seq, task, time, type; a stepId on the step lines',
    ls.length === 4 && ls.every((l, i) => l.v === CJ.VERSION && l.runId === 'R' && l.seq === i + 1 && l.key === 'k' && !!Date.parse(l.at)) && ls.slice(0, 3).every((l) => l.stepId === 'R:1'), JSON.stringify(ls[0]));
  const snap = JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8'));
  ok('S1 G25 the snapshot names the last event applied and the fold of the journal', snap.v === CJ.VERSION && snap.runId === 'R' && snap.seq === 4 && Object.keys(snap.open).length === 0
    && snap.counts.testerReds === 1 && snap.head === 'h1' && snap.last.stepId === 'R:1' && snap.unsettled.length === 0, JSON.stringify(snap));
  j.append(intent(2, { label: 'prog:k#1' }));
  const open = JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8')).open;
  ok('S1 G25 the same label twice gets its own stepId: an open step is found by stepId', open['R:2'] && open['R:2'].label === 'prog:k#1' && !open['R:1']);
  const rd = CJ.readJournal(d, 'k');
  ok('S13 the snapshot equals the journal: current', rd.snapshot === 'current' && rd.seq === 5 && !rd.error && !rd.torn.length, JSON.stringify(rd));
}

// ---- S14: an fsync or a write that fails is an error of the append; the seq follows what the file holds
{
  const d = runDir();
  let failFsync = false, failWrite = false;
  const io = { writeSync: (...a) => { if (failWrite) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(...a); },
    fsyncSync: (fd) => { if (failFsync) throw new Error('EIO'); return fs.fsyncSync(fd); } };
  const j = CJ.openJournal(d, 'R', 'k', { io });
  j.append(intent(1));
  failWrite = true;
  const e1 = threw(() => j.append(result(1)));
  failWrite = false;
  ok('S14 a failed write throws, nothing is counted', !!e1 && CJ.readJournal(d, 'k').seq === 1, String(e1));
  failFsync = true;
  const e2 = threw(() => j.append(result(1)));
  failFsync = false;
  ok('S14 a failed fsync throws; the whole line is in the file, so it counts', !!e2 && CJ.readJournal(d, 'k').seq === 2, String(e2));
  j.append({ type: 'settled', stepIds: ['R:1'] });
  ok('S14 the next line continues the seq of what the file holds, in the same segment', linesOf(segOf(d, 'k')).map((l) => l.seq).join() === '1,2,3' && !fs.existsSync(segOf(d, 'k', 1)));
}
{
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  fs.rmSync(stateOf(d, 'k'));
  fs.mkdirSync(stateOf(d, 'k'));
  const e = threw(() => j.append(result(1)));
  ok('S14 a snapshot that cannot be written is an error of the append', !!e, String(e));
  const r = CJ.readJournal(d, 'k');
  ok('S13 the journal stays the truth: the line is there, the snapshot behind it is rebuilt', r.seq === 2 && r.state && !r.state.open['R:1'] && r.snapshot === 'rebuilt', JSON.stringify(r));
}

// ---- S12a: a torn tail
{
  const d = runDir();
  let cut = false;
  const io = { writeSync: (fd, s) => { if (cut) { fs.writeSync(fd, String(s).slice(0, 20)); const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return fs.writeSync(fd, s); }, fsyncSync: fs.fsyncSync };
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  const jw = CJ.openJournal(d, 'R', 'other', { io });
  jw.append(intent(1));
  cut = true;
  const e = threw(() => jw.append(result(1)));
  cut = false;
  const before = fs.readFileSync(segOf(d, 'other'));
  ok('S12a a write cut in the middle throws', !!e, String(e));
  jw.append(result(1));
  ok('S12a after a tail of its own the writer goes on in a new segment; the torn file is not appended to', fs.existsSync(segOf(d, 'other', 1)) && fs.readFileSync(segOf(d, 'other')).equals(before));
  const r = CJ.readJournal(d, 'other');
  ok('S12a the journal reads: two complete lines, the tail shown, nothing refused', !r.error && r.seq === 2 && r.torn.length === 1 && r.torn[0].file === segOf(d, 'other') && r.torn[0].bytes === 20 && !r.state.open['R:1'], JSON.stringify(r));
}
{
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  const whole = JSON.stringify({ v: CJ.VERSION, runId: 'R', seq: 2, at: new Date().toISOString(), key: 'k', type: 'result', stepId: 'R:1', outcome: 'ok' });
  fs.appendFileSync(segOf(d, 'k'), whole);
  const r = CJ.readJournal(d, 'k');
  ok('S12a a tail without its newline is not a record, also when its JSON is whole: the result is not written, the step stays open',
    !r.error && r.seq === 1 && r.state.open['R:1'] && r.torn.length === 1 && r.torn[0].text.includes('"result"'), JSON.stringify(r));
  ok('S12a the snapshot ahead check does not take the torn line for an event', r.snapshot === 'current', r.snapshot);
  const bytes = fs.readFileSync(segOf(d, 'k'));
  const j2 = CJ.openJournal(d, 'R', 'k');
  j2.append(result(1));
  ok('S12a a writer opened over a torn tail starts a new segment and continues the seq; the file keeps its tail for the diagnosis',
    fs.readFileSync(segOf(d, 'k')).equals(bytes) && linesOf(segOf(d, 'k', 1))[0].seq === 2);
  const r2 = CJ.readJournal(d, 'k');
  ok('S12a segments read in order; the tail of an earlier segment stays a diagnosis, not damage', !r2.error && r2.seq === 2 && !r2.state.open['R:1'] && r2.torn.length === 1 && r2.segments === 2, JSON.stringify(r2));
  const j3 = CJ.openJournal(d, 'R', 'k');
  j3.append({ type: 'settled', stepIds: ['R:1'] });
  ok('a writer opened over a clean end continues its segment', linesOf(segOf(d, 'k', 1)).length === 2 && !fs.existsSync(segOf(d, 'k', 2)));
}

// ---- S12b: damage inside is a refusal, for the reader and for a writer
const damaged = (name, edit, re) => {
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  j.append({ type: 'launch', stepId: 'R:1', pid: 1, gated: true });
  j.append(result(1));
  const ls = fs.readFileSync(segOf(d, 'k'), 'utf8').split('\n');
  fs.writeFileSync(segOf(d, 'k'), edit(ls).join('\n'));
  const r = CJ.readJournal(d, 'k');
  ok(`S12b ${name}: refused`, !!r.error && re.test(r.error) && !r.state, JSON.stringify(r));
  ok(`S12b ${name}: no writer opens over it`, !!threw(() => CJ.openJournal(d, 'R', 'k')));
};
const patch = (l, o) => JSON.stringify(Object.assign(JSON.parse(l), o));
damaged('a line that does not parse, not the last', (l) => { l[1] = '{broken'; return l; }, /corrupt.*seg-000\.jsonl:2/);
damaged('a gap in the seq', (l) => l.filter((_, i) => i !== 1), /seq/);
damaged('another runId', (l) => { l[1] = patch(l[1], { runId: 'X' }); return l; }, /runId/);
damaged('another format version', (l) => { l[0] = patch(l[0], { v: 99 }); return l; }, /version/);
damaged('an event type the journal does not know (a resolve from nowhere)', (l) => { l[1] = patch(l[1], { type: 'resolve' }); return l; }, /type/);
damaged('a launch of a step with no intent', (l) => { l[1] = patch(l[1], { stepId: 'R:9' }); return l; }, /step/);
damaged('another task', (l) => { l[1] = patch(l[1], { key: 'z' }); return l; }, /task/);
// One intent and one launch per step: a repeat would erase the pid of the first, and a step with a launch would read as
// one that never started. Written directly, so these lines stand for a file edited from outside.
const repeated = (name, build, re) => {
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  build(j);
  const f = segOf(d, 'k');
  const ls = linesOf(f);
  fs.appendFileSync(f, `${JSON.stringify(Object.assign({}, ls.find((l) => l.type === name), { seq: ls.length + 1 }))}\n`);
  const r = CJ.readJournal(d, 'k');
  return { ok: !!r.error && re.test(r.error) && !r.state, show: JSON.stringify(r), writer: !!threw(() => CJ.openJournal(d, 'R', 'k')) };
};
for (const [title, name, build, re] of [
  ['a second intent of an open step', 'intent', (j) => { j.append(intent(1)); j.append({ type: 'launch', stepId: 'R:1', pid: 1 }); }, /corrupt.*intent.*R:1/],
  ['a second launch of an open step', 'launch', (j) => { j.append(intent(1)); j.append({ type: 'launch', stepId: 'R:1', pid: 1 }); }, /corrupt.*launch.*R:1/],
  ['an intent of a step that already ended', 'intent', (j) => { j.append(intent(1)); j.append(result(1)); }, /corrupt.*intent.*R:1/],
  ['a second result of a step', 'result', (j) => { j.append(intent(1)); j.append(result(1)); }, /corrupt.*result.*R:1/],
]) {
  const x = repeated(name, build, re);
  ok(`S12b ${title}: refused by the reader`, x.ok, x.show);
  ok(`S12b ${title}: no writer opens over it`, x.writer);
}
// The writer holds the same rule, and checks before the disk: the line that cannot follow never damages the journal.
{
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  j.append({ type: 'launch', stepId: 'R:1', pid: 1 });
  const before = fs.readFileSync(segOf(d, 'k'), 'utf8');
  ok('S12b a writer asked for a second intent throws and writes nothing', !!threw(() => j.append(intent(1))) && fs.readFileSync(segOf(d, 'k'), 'utf8') === before && j.seq === 2);
  ok('S12b a writer asked for a second launch throws and writes nothing', !!threw(() => j.append({ type: 'launch', stepId: 'R:1', pid: 2 })) && fs.readFileSync(segOf(d, 'k'), 'utf8') === before && j.state.open['R:1'].launch.pid === 1);
  ok('S12b a writer asked for a launch of no step throws and writes nothing', !!threw(() => j.append({ type: 'launch', stepId: 'R:9', pid: 2 })) && fs.readFileSync(segOf(d, 'k'), 'utf8') === before);
  j.append(result(1));
  ok('S12b ... the journal goes on after the refused lines', !CJ.readJournal(d, 'k').error && j.seq === 3);
  ok('S12b a writer asked to announce a step that ended throws', !!threw(() => j.append(intent(1))));
  const j2 = CJ.openJournal(d, 'R', 'k');
  ok('S12b ... also a writer opened later, which knows the step only from the journal', !!threw(() => j2.append(intent(1))) && j2.seq === 3);
  const keys = Object.keys(JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8')));
  ok('S12b what the fold remembers of ended steps stays out of the snapshot', !keys.includes('seen'), keys.join());
}

// ---- S13: journal and snapshot
{
  const build = () => { const d = runDir(); const j = CJ.openJournal(d, 'R', 'k'); j.append(intent(1)); j.append(result(1)); return d; };
  let d = build();
  const old = fs.readFileSync(stateOf(d, 'k'));
  CJ.openJournal(d, 'R', 'k').append({ type: 'settled', stepIds: ['R:1'] });
  fs.writeFileSync(stateOf(d, 'k'), old);
  let before = fs.readFileSync(stateOf(d, 'k'));
  let r = CJ.readJournal(d, 'k');
  ok('S13 a snapshot older than the journal: rebuilt from the journal', r.snapshot === 'rebuilt' && r.seq === 3 && r.state.unsettled.length === 0 && !r.error, JSON.stringify(r));
  ok('S13 a reader writes nothing (one writer per run)', fs.readFileSync(stateOf(d, 'k')).equals(before));
  d = build();
  fs.rmSync(stateOf(d, 'k'));
  r = CJ.readJournal(d, 'k');
  ok('S13 no snapshot: rebuilt', r.snapshot === 'rebuilt' && r.seq === 2 && !r.error && !fs.existsSync(stateOf(d, 'k')), JSON.stringify(r));
  d = build();
  fs.writeFileSync(stateOf(d, 'k'), '{broken');
  r = CJ.readJournal(d, 'k');
  ok('S13 a snapshot that does not parse: rebuilt', r.snapshot === 'rebuilt' && !r.error, JSON.stringify(r));
  d = build();
  const s = JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8'));
  fs.writeFileSync(stateOf(d, 'k'), JSON.stringify(Object.assign(s, { seq: 9 })));
  r = CJ.readJournal(d, 'k');
  ok('S13 a snapshot ahead of the journal (the journal is shorter): refused', /run-state.*ahead/.test(r.error || '') && !r.state, JSON.stringify(r));
  d = build();
  fs.rmSync(segOf(d, 'k'));
  r = CJ.readJournal(d, 'k');
  ok('S13 a snapshot without a journal: refused', /run-state.*no journal/.test(r.error || '') && !r.state, JSON.stringify(r));
  d = build();
  fs.rmSync(path.join(d, 'journal'), { recursive: true });
  r = CJ.readJournal(d, 'k');
  ok('S20 neither journal nor snapshot: none, no error', r.none === true && !r.error && r.state === null, JSON.stringify(r));
  d = build();
  const s2 = JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8'));
  s2.ended = { status: 'done' };
  fs.writeFileSync(stateOf(d, 'k'), JSON.stringify(s2));
  r = CJ.readJournal(d, 'k');
  ok('S13 the truth is the journal: a snapshot that names the same seq but another state is not believed', r.state.ended === null && r.snapshot === 'differs', JSON.stringify(r));
}

// ---- the place of the state: links, FIFOs, swapped folders (owner 2026-11-07)
{
  const outside = path.join(W, 'outside.txt');
  const fresh = () => { fs.writeFileSync(outside, 'keep\n'); const d = runDir(); const j = CJ.openJournal(d, 'R', 'k'); j.append(intent(1)); return { d, j }; };
  let { d, j } = fresh();
  fs.rmSync(segOf(d, 'k')); fs.symlinkSync(outside, segOf(d, 'k'));
  ok('a link in place of the segment: the append refuses, the target is untouched', !!threw(() => j.append(result(1))) && fs.readFileSync(outside, 'utf8') === 'keep\n');
  ok('a link in place of the segment: the reader refuses and does not read through it', !!CJ.readJournal(d, 'k').error);
  ({ d, j } = fresh());
  fs.rmSync(segOf(d, 'k')); fs.linkSync(outside, segOf(d, 'k'));
  ok('a hard link in place of the segment: refused (the type and the link count come from the open file)', !!threw(() => j.append(result(1))) && fs.readFileSync(outside, 'utf8') === 'keep\n');
  ({ d, j } = fresh());
  const sameSize = path.join(W, `same-size-${nRun}`);
  fs.copyFileSync(segOf(d, 'k'), sameSize);
  const copyBytes = fs.readFileSync(sameSize);
  fs.rmSync(segOf(d, 'k')); fs.linkSync(sameSize, segOf(d, 'k'));
  ok('a hard link of the same size in place of the segment: the link count refuses it, nothing written through', !!threw(() => j.append(result(1))) && fs.readFileSync(sameSize).equals(copyBytes));
  ok('... and the reader refuses it', !!CJ.readJournal(d, 'k').error);
  ({ d, j } = fresh());
  fs.rmSync(segOf(d, 'k'));
  if (mkfifo(segOf(d, 'k'))) {
    ok('a FIFO in place of the segment: the append refuses without blocking', !!threw(() => j.append(result(1))));
    ok('a FIFO in place of the segment: the reader refuses without blocking', !!CJ.readJournal(d, 'k').error);
    ({ d, j } = fresh());
    fs.rmSync(stateOf(d, 'k'));
    mkfifo(stateOf(d, 'k'));
    const r = CJ.readJournal(d, 'k');
    ok('a FIFO in place of the snapshot: the reader does not block and rebuilds from the journal', r.snapshot === 'rebuilt' && !r.error, JSON.stringify(r));
    const f = path.join(W, `plain-fifo-${nRun}`);
    mkfifo(f);
    ok('readText refuses a FIFO without blocking; readJsonSafe gives null', !!threw(() => CJ.readText(f)) && CJ.readJsonSafe(f) === null);
  }
  ({ d, j } = fresh());
  fs.rmSync(stateOf(d, 'k')); fs.symlinkSync(outside, stateOf(d, 'k'));
  j.append(result(1));
  ok('a link in place of the snapshot: replaced by the rename, never written through', fs.readFileSync(outside, 'utf8') === 'keep\n' && !fs.lstatSync(stateOf(d, 'k')).isSymbolicLink());
  const f2 = path.join(W, 'link-to-outside');
  fs.symlinkSync(outside, f2);
  ok('readText and readJsonSafe do not follow a link', !!threw(() => CJ.readText(f2)) && CJ.readJsonSafe(f2) === null);
  ({ d, j } = fresh());
  const jd = path.join(d, 'journal', 'k');
  fs.renameSync(jd, `${jd}.moved`);
  fs.mkdirSync(jd);
  ok('the folder of the journal replaced by another folder: the append refuses', /replaced/.test(String(threw(() => j.append(result(1))))));
  ok('... and nothing is written to the new folder', fs.readdirSync(jd).length === 0);
  ({ d, j } = fresh());
  fs.renameSync(path.join(d, 'journal', 'k'), path.join(d, 'journal', 'k.moved'));
  fs.symlinkSync(path.join(d, 'journal', 'k.moved'), path.join(d, 'journal', 'k'));
  ok('the folder of the journal replaced by a link: the append refuses', /replaced/.test(String(threw(() => j.append(result(1))))));
  ({ d, j } = fresh());
  fs.renameSync(path.join(d, 'journal'), path.join(d, 'journal.moved'));
  fs.symlinkSync(path.join(d, 'journal.moved'), path.join(d, 'journal'));
  ok('a parent of the journal folder replaced by a link: the append refuses', /replaced/.test(String(threw(() => j.append(result(1))))));
  ({ d, j } = fresh());
  fs.renameSync(d, `${d}.moved`);
  fs.mkdirSync(d);
  ok('the run folder itself renamed: the append refuses and creates nothing', !!threw(() => j.append(result(1))) && fs.readdirSync(d).length === 0);
  const d2 = runDir();
  fs.mkdirSync(path.join(d2, 'real'));
  fs.symlinkSync(path.join(d2, 'real'), path.join(d2, 'journal'));
  ok('a journal parent that already is a link: no writer opens', !!threw(() => CJ.openJournal(d2, 'R', 'k')) && fs.readdirSync(path.join(d2, 'real')).length === 0);
  for (const bad of ['../x', 'a/b', '.', '..', '', '.hidden']) ok(`the key ${JSON.stringify(bad)} is no path of the journal`, !!threw(() => CJ.openJournal(runDir(), 'R', bad)));
}

// ---- one writer per run folder (owner, answer 12)
{
  const d = runDir();
  const me = { pid: process.pid, lstart: 'L', runId: 'R' };
  ok('the first writer takes the folder', CJ.takeWriter(d, me).ok === true);
  const again = CJ.takeWriter(d, { pid: 2, lstart: 'M', runId: 'R' });
  ok('a second writer is refused and named', !again.ok && again.held && again.held.pid === process.pid, JSON.stringify(again));
  const d2 = runDir();
  if (mkfifo(path.join(d2, 'writer.lock'))) ok('a FIFO in place of the writer lock: refused without blocking', !CJ.takeWriter(d2, me).ok);
  const d3 = runDir();
  fs.symlinkSync(path.join(W, 'nowhere'), path.join(d3, 'writer.lock'));
  ok('a dangling link in place of the writer lock: refused, nothing created behind it', !CJ.takeWriter(d3, me).ok && !fs.existsSync(path.join(W, 'nowhere')));
}

// ---- S13 for a writer: the same answers as for the reader; a refusal leaves the snapshot for the diagnosis
{
  const build = () => { const d = runDir(); const j = CJ.openJournal(d, 'R', 'k'); j.append(intent(1)); j.append(result(1)); return d; };
  const snapOf = (d) => JSON.parse(fs.readFileSync(stateOf(d, 'k'), 'utf8'));
  let d = build();
  fs.writeFileSync(stateOf(d, 'k'), JSON.stringify(Object.assign(snapOf(d), { seq: 1 })));
  let j = null;
  ok('S13 a writer over a snapshot older than the journal opens', !threw(() => { j = CJ.openJournal(d, 'R', 'k'); }));
  ok('S13 ... and brings it up to date', j && snapOf(d).seq === 2 && CJ.readJournal(d, 'k').snapshot === 'current', JSON.stringify(snapOf(d)));
  d = build();
  fs.writeFileSync(stateOf(d, 'k'), '{not json');
  ok('S13 a writer over a snapshot that does not parse opens and rebuilds it', !threw(() => CJ.openJournal(d, 'R', 'k')) && snapOf(d).seq === 2);
  d = build();
  fs.unlinkSync(stateOf(d, 'k'));
  ok('S13 a writer with no snapshot opens and writes it', !threw(() => CJ.openJournal(d, 'R', 'k')) && snapOf(d).seq === 2);
  d = build();
  const ahead = JSON.stringify(Object.assign(snapOf(d), { seq: 9 }));
  fs.writeFileSync(stateOf(d, 'k'), ahead);
  const e1 = threw(() => CJ.openJournal(d, 'R', 'k'));
  ok('S13 a writer over a snapshot ahead of the journal: refused with the reader\'s text, the snapshot untouched', e1 && /run-state.*ahead/.test(e1.message) && fs.readFileSync(stateOf(d, 'k'), 'utf8') === ahead, String(e1));
  const d2 = runDir();
  fs.mkdirSync(path.join(d2, 'journal', 'k'), { recursive: true });
  fs.writeFileSync(stateOf(d2, 'k'), '{"seq":3}');
  const e2 = threw(() => CJ.openJournal(d2, 'R', 'k'));
  ok('S13 a writer over a snapshot with no journal: refused, the snapshot untouched', e2 && /run-state.*no journal/.test(e2.message) && fs.readFileSync(stateOf(d2, 'k'), 'utf8') === '{"seq":3}', String(e2));
  ok('S13 a new journal with no snapshot and no segment opens', !threw(() => CJ.openJournal(runDir(), 'R', 'k')));
}

// ---- a reader beside a live writer: the writer puts the line, then the snapshot. A reader takes the snapshot first and
// folds after it, so a healthy journal never reads as a snapshot ahead (the invariant in chain-journal.js). The act runs
// at the first call of fs[method] on the target: the same interleaving as a reader that lost the processor there.
const atFirst = (method, target, act, fn) => {
  const orig = fs[method];
  let fired = false;
  fs[method] = (p, ...a) => {
    if (!fired && String(p) === target) { fired = true; fs[method] = orig; act(); }
    return orig(p, ...a);
  };
  try { return { out: fn(), fired }; } finally { fs[method] = orig; }
};
const launch = (n) => ({ type: 'launch', stepId: `R:${n}`, pid: 1, pgid: 1, lstart: 'x', gated: true });
{
  // R3: the line and its snapshot come after the reader took the snapshot, at the moment it opens the segment.
  const d = runDir();
  const w = CJ.openJournal(d, 'R', 'k');
  w.append(intent(1));
  const { out: r, fired } = atFirst('openSync', segOf(d, 'k'), () => w.append(launch(1)), () => CJ.readJournal(d, 'k'));
  ok('R3 a line written after the reader took the snapshot: no error, the line is seen, the snapshot read lags', fired && !r.error && r.seq === 2 && r.state.open['R:1'].launch.pid === 1 && r.snapshot === 'rebuilt', JSON.stringify(r));
}
{
  // R4: the same over a torn tail: the new line lies in the next segment.
  const d = runDir();
  let cut = false;
  const io = { writeSync: (fd, s) => { if (cut) { fs.writeSync(fd, String(s).slice(0, 20)); throw new Error('ENOSPC'); } return fs.writeSync(fd, s); }, fsyncSync: fs.fsyncSync };
  const w = CJ.openJournal(d, 'R', 'k', { io });
  w.append(intent(1));
  cut = true;
  threw(() => w.append(launch(1)));
  cut = false;
  const { out: r, fired } = atFirst('readdirSync', path.join(d, 'journal', 'k'), () => w.append(launch(1)), () => CJ.readJournal(d, 'k'));
  ok('R4 a line in a new segment after a torn tail, the snapshot read before it: no error, the tail named, the seq right', fired && !r.error && r.seq === 2 && r.segments === 2 && r.torn.length === 1 && r.torn[0].file === segOf(d, 'k') && r.snapshot === 'rebuilt', JSON.stringify(r));
}
{
  // R5: the segment exists, its line is not written yet: the reader runs inside the writer's write.
  const d = runDir();
  let seen = null;
  const io = { writeSync: (...a) => { if (!seen) seen = CJ.readJournal(d, 'k'); return fs.writeSync(...a); }, fsyncSync: fs.fsyncSync };
  CJ.openJournal(d, 'R', 'k', { io }).append(intent(1));
  ok('R5 the first segment is created, its line not yet: no error, seq 0, nothing torn, no false damage', seen && !seen.error && !seen.none && seen.seq === 0 && seen.torn.length === 0 && seen.snapshot === 'rebuilt', JSON.stringify(seen));
  const d2 = runDir();
  let cut = false, inWrite = false;
  seen = null;
  const io2 = { writeSync: (fd, s) => {
    if (cut) { fs.writeSync(fd, String(s).slice(0, 20)); throw new Error('ENOSPC'); }
    if (inWrite && !seen) seen = CJ.readJournal(d2, 'k');
    return fs.writeSync(fd, s);
  }, fsyncSync: fs.fsyncSync };
  const w2 = CJ.openJournal(d2, 'R', 'k', { io: io2 });
  w2.append(intent(1));
  cut = true;
  threw(() => w2.append(launch(1)));
  cut = false;
  inWrite = true;
  w2.append(launch(1));
  ok('R5 the next segment is created after a torn tail, its line not yet: no error, the seq as before, the tail named', seen && !seen.error && seen.seq === 1 && seen.segments === 2 && seen.torn.length === 1 && seen.snapshot === 'current', JSON.stringify(seen));
  const d3 = runDir();
  fs.mkdirSync(path.join(d3, 'journal', 'k'), { recursive: true });
  fs.writeFileSync(segOf(d3, 'k'), '');
  const w3 = CJ.openJournal(d3, 'R', 'k');
  w3.append(intent(1));
  ok('R5 a writer opened over an empty segment continues it', linesOf(segOf(d3, 'k')).length === 1 && !fs.existsSync(segOf(d3, 'k', 1)) && !CJ.readJournal(d3, 'k').error);
}
{
  // R6: a part of a line, cut inside a character, and then the rest of it.
  const d = runDir();
  const w = CJ.openJournal(d, 'R', 'k');
  w.append(intent(1));
  const line = Buffer.from(`${JSON.stringify({ v: CJ.VERSION, runId: 'R', seq: 2, at: new Date().toISOString(), key: 'k', type: 'result', stepId: 'R:1', outcome: 'ok', value: '\u044f\u044f\u044f' })}\n`);
  const cutAt = line.indexOf(Buffer.from('\u044f')) + 1;
  fs.appendFileSync(segOf(d, 'k'), line.subarray(0, cutAt));
  let r = CJ.readJournal(d, 'k');
  ok('R6 a part of a line of a live writer: in torn, not counted, no error', !r.error && r.seq === 1 && r.state.open['R:1'] && r.torn.length === 1 && r.torn[0].bytes === cutAt, JSON.stringify(r));
  fs.appendFileSync(segOf(d, 'k'), line.subarray(cutAt));
  r = CJ.readJournal(d, 'k');
  ok('R6 ... the same line read again once it is whole: counted, nothing torn', !r.error && r.seq === 2 && !r.state.open['R:1'] && r.torn.length === 0, JSON.stringify(r));
}

{
  // R8: a writer that opens goes the reader's order: the snapshot first, the fold after it.
  const d = runDir();
  const w = CJ.openJournal(d, 'R', 'k');
  w.append(intent(1));
  let opened = null;
  const { fired } = atFirst('openSync', stateOf(d, 'k'), () => w.append(launch(1)), () => { opened = threw(() => CJ.openJournal(d, 'R', 'k')); });
  ok('R8 a line written while a writer opens, after it took the snapshot: no false "ahead"', fired && !opened, String(opened));
  const d2 = runDir();
  fs.mkdirSync(path.join(d2, 'journal', 'k'), { recursive: true });
  fs.writeFileSync(stateOf(d2, 'k'), '{not json');
  const r2 = CJ.readJournal(d2, 'k');
  ok('R7 something that does not parse at the name of the snapshot, no journal: refused all the same', /run-state.*no journal/.test(r2.error || ''), JSON.stringify(r2));
  ok('R8 ... and no writer opens over it', /run-state.*no journal/.test(String(threw(() => CJ.openJournal(d2, 'R', 'k')))));
}

// ---- the writer lock: read with no check of the link count (a lock has two names between link and unlink), and a lock
// gone between EEXIST and the read means the next link (the invariant in chain-journal.js)
{
  const me = { pid: process.pid, lstart: 'L', runId: 'R' };
  const d = runDir();
  const lock = path.join(d, 'writer.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 4242, lstart: 'M', runId: 'other' }));
  fs.linkSync(lock, `${lock}.9.new`);
  const two = CJ.takeWriter(d, me);
  ok('L9 a writer lock with two names: refused, its pid named', two.ok === false && two.held.pid === 4242, JSON.stringify(two));
  const d2 = runDir();
  const lock2 = path.join(d2, 'writer.lock');
  fs.writeFileSync(lock2, JSON.stringify({ pid: 4242 }));
  const { out: gone, fired } = atFirst('openSync', lock2, () => fs.unlinkSync(lock2), () => CJ.takeWriter(d2, me));
  ok('L9 a writer lock gone between EEXIST and the read: the writer takes it', fired && gone.ok === true && CJ.readJsonSafe(lock2).pid === process.pid, JSON.stringify(gone));
  const d3 = runDir();
  fs.writeFileSync(path.join(d3, 'writer.lock'), 'not json');
  const junk = CJ.takeWriter(d3, me);
  ok('L9 garbage in place of the writer lock: refused, nothing named', junk.ok === false && junk.held.pid === undefined, JSON.stringify(junk));
}
// ---- readLock: exactly one of three answers
{
  const d = runDir();
  const f = path.join(d, 'x.lock');
  ok('readLock: no file', CJ.readLock(f).gone === true);
  fs.writeFileSync(f, '{"pid":5}');
  ok('readLock: its data', CJ.readLock(f).data.pid === 5);
  fs.linkSync(f, `${f}.2`);
  ok('readLock: two names are no obstacle', CJ.readLock(f).data.pid === 5);
  ok('... while readJsonSafe keeps refusing them', CJ.readJsonSafe(f) === null);
  const t = path.join(d, 'target.json');
  fs.writeFileSync(t, '{"pid":6}');
  const ln = path.join(d, 'ln.lock');
  fs.symlinkSync(t, ln);
  ok('readLock: a link is unreadable, not followed', !!CJ.readLock(ln).unreadable && !CJ.readLock(ln).data);
  fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'dangling.lock'));
  ok('readLock: a dangling link is unreadable, not "no file"', !!CJ.readLock(path.join(d, 'dangling.lock')).unreadable);
  fs.mkdirSync(path.join(d, 'dir.lock'));
  ok('readLock: a folder is unreadable by its type, from the open file', /not a regular file/.test(CJ.readLock(path.join(d, 'dir.lock')).unreadable || ''));
  if (mkfifo(path.join(d, 'fifo.lock'))) ok('readLock: a FIFO is unreadable by its type, without blocking', /not a regular file/.test(CJ.readLock(path.join(d, 'fifo.lock')).unreadable || ''));
  for (const junk of ['not json', '5', 'null', '[]', '']) {
    const g = path.join(d, 'junk.lock');
    fs.writeFileSync(g, junk);
    ok(`readLock: ${JSON.stringify(junk)} is unreadable`, !!CJ.readLock(g).unreadable && !CJ.readLock(g).data);
  }
}

// ---- D2: segments go by their number, past seg-999
{
  const d = runDir();
  const dir = path.join(d, 'journal', 'k');
  fs.mkdirSync(dir, { recursive: true });
  const row = (seq, f) => `${JSON.stringify(Object.assign({ v: CJ.VERSION, runId: 'R', seq, at: new Date().toISOString(), key: 'k' }, f))}\n`;
  fs.writeFileSync(path.join(dir, 'seg-999.jsonl'), row(1, intent(1)));
  fs.writeFileSync(path.join(dir, 'seg-1000.jsonl'), row(2, result(1)));
  const r = CJ.readJournal(d, 'k');
  ok('D2 seg-1000 is read after seg-999', !r.error && r.seq === 2 && r.segments === 2 && !r.state.open['R:1'], JSON.stringify(r));
  const w = CJ.openJournal(d, 'R', 'k');
  w.append({ type: 'settled', stepIds: ['R:1'] });
  ok('D2 a writer continues seg-1000, the last by number', fs.readFileSync(path.join(dir, 'seg-1000.jsonl'), 'utf8').split('\n').filter(Boolean).length === 2 && fs.readFileSync(path.join(dir, 'seg-999.jsonl'), 'utf8').split('\n').filter(Boolean).length === 1, fs.readdirSync(dir).join());
  ok('D2 ... and the journal reads on', CJ.readJournal(d, 'k').seq === 3);
}

// ---- D3: an event of a step with no intent
{
  const row = (l, seq, f) => { l.splice(l.length - 1, 0, JSON.stringify(Object.assign({ v: CJ.VERSION, runId: 'R', seq, at: new Date().toISOString(), key: 'k' }, f))); return l; };
  damaged('a settled of a step with no intent', (l) => row(l, 4, { type: 'settled', stepIds: ['R:9'] }), /corrupt.*settled.*R:9/);
  damaged('a settled without a list of steps', (l) => row(l, 4, { type: 'settled', stepIds: 'R:1' }), /corrupt.*settled/);
  damaged('an intent with no stepId', (l) => row(l, 4, { type: 'intent', n: 4, label: 'x' }), /corrupt.*intent.*stepId/);
  const d = runDir();
  const j = CJ.openJournal(d, 'R', 'k');
  j.append(intent(1));
  j.append(result(1));
  const before = fs.readFileSync(segOf(d, 'k'), 'utf8');
  ok('D3 a writer asked for a settled of a step with no intent throws and writes nothing', !!threw(() => j.append({ type: 'settled', stepIds: ['R:9'] })) && fs.readFileSync(segOf(d, 'k'), 'utf8') === before && j.seq === 2);
  ok('D3 a writer asked for an intent with no stepId throws and writes nothing', !!threw(() => j.append({ type: 'intent', n: 2, label: 'x' })) && fs.readFileSync(segOf(d, 'k'), 'utf8') === before && j.seq === 2);
  j.append({ type: 'settled', stepIds: ['R:1'] });
  ok('D3 a settled of a step that has its intent goes on', j.seq === 3 && !CJ.readJournal(d, 'k').error);
}

// ---- writeAtomic: a stray link or FIFO in place of the file or its temporary file
{
  const d = runDir();
  const t = path.join(W, 'atomic-target.txt');
  fs.writeFileSync(t, 'keep\n');
  fs.symlinkSync(t, path.join(d, 'x.json'));
  CJ.writeAtomic(path.join(d, 'x.json'), { a: 1 });
  ok('writeAtomic replaces a link, never writes through it', fs.readFileSync(t, 'utf8') === 'keep\n' && CJ.readJsonSafe(path.join(d, 'x.json')).a === 1);
  const line = path.join(d, 'log.txt');
  fs.symlinkSync(t, line);
  ok('appendLine refuses a link', !!threw(() => CJ.appendLine(line, 'x\n')) && fs.readFileSync(t, 'utf8') === 'keep\n');
}
done();
